// WavePulse fetcher: a second, independent source of forecast data for the WavePulse server (free, non-commercial).
// Runs every hour on GitHub Actions. It asks Open-Meteo (open-meteo.com, CC BY 4.0) for the requests listed in
// plan.json and hands the answers to the WavePulse server, in the format the server stores. No dependencies.
//
// Each hour (UTC hour h) does a slice, so the whole list is covered once a day within the free daily limits:
//   - the bundles "fcb:h:*": full forecasts of ~25 beaches, stored as bundles of 12 (one storage write per bundle:
//     the server's free storage allows 1 000 writes a day, 2026-11-23)
//   - while h < number of groups: group h of short forecasts     (1 group)
// One request at a time. On "too many requests" it waits a minute once; on the daily limit it stops until next hour.
//
// Needs the secret INGEST_TOKEN (repository secret). Optional: WAVEPULSE_SERVER, FORCE_HOUR (for a test run).
import { readFileSync } from 'node:fs';

const SERVER = process.env.WAVEPULSE_SERVER || 'https://wavepulse.yoga-app.workers.dev';
const TOKEN = process.env.INGEST_TOKEN;
const plan = JSON.parse(readFileSync(new URL('./plan.json', import.meta.url), 'utf8'));
const h = process.env.FORCE_HOUR !== undefined && process.env.FORCE_HOUR !== '' ? Number(process.env.FORCE_HOUR) : new Date().getUTCHours();
const UA = { 'User-Agent': 'WavePulse fetcher (free, non-commercial beach forecast)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = { requests: 0, locations: 0, stored: 0, failed: 0, limited: '' };

class Stop extends Error {}
async function get(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    stats.requests++;
    stats.locations += (new URL(url).searchParams.get('latitude') || '').split(',').length;
    let r;
    try { r = await fetch(url, { headers: UA }); } catch { await sleep(2000); continue; }
    if (r.ok) { const t = await r.text(); await sleep(700); return t; }
    if (r.status === 429) {
      const reason = (await r.text()).slice(0, 160);
      if (/minute|concurrent/i.test(reason) && attempt === 0) { await sleep(65000); continue; }
      stats.limited = reason;
      throw new Stop(reason);
    }
    await sleep(1000);
    return null;
  }
  return null;
}

async function put(key, body) {
  if (!TOKEN) { console.log(`dry run, not sent: ${key} (${body.length} bytes)`); return; }
  const r = await fetch(`${SERVER}/api/ingest/kv?key=${encodeURIComponent(key)}`, { method: 'PUT', body, headers: { 'X-Ingest-Token': TOKEN, 'Content-Type': 'application/json' } });
  if (r.ok) stats.stored++; else { stats.failed++; console.log(`store failed ${key}: ${r.status}`); }
}

// One beach's full forecast, in the server's format; null when Open-Meteo did not give the essential parts.
async function beach(e) {
  const m = await get(e.marine);
  if (!m) { stats.failed++; return null; }
  const w = (await get(e.weather)) ?? (await get(e.weatherGlobal));
  if (!w) { stats.failed++; return null; }
  const v = (await get(e.waves)) ?? (await get(e.wavesGlobal));
  return `{"at":"${new Date().toISOString()}","marine":${m},"weather":${w},"waves":${v ?? 'null'}}`;
}

// A bundle: one index line ({"idx":[[key, byteOffset, byteLength], ...]}) then the beaches' bodies back to back.
async function bundle(b) {
  const bodies = [];
  for (const e of b.beaches) { const body = await beach(e); if (body) bodies.push([e.key, Buffer.from(body)]); }
  if (!bodies.length) return;
  let off = 0; const idx = bodies.map(([k, buf]) => { const r = [k, off, buf.length]; off += buf.length; return r; });
  await put(b.key, Buffer.concat([Buffer.from(JSON.stringify({ idx }) + String.fromCharCode(10)), ...bodies.map(([, buf]) => buf)]));
}

async function group(g) {
  const answers = [];
  for (const q of g.requests) {
    let a = await get(q.url);
    if (a == null && q.fallback) a = await get(q.fallback);
    if (a == null && !q.optional) { stats.failed++; return; }
    answers.push(a ?? 'null');
  }
  await put(g.key, `{"at":"${new Date().toISOString()}","r":[${answers.join(',')}]}`);
}

// What to renew (2026-11-27): GitHub ran this "hourly" schedule only ~3 times a day, so a fixed slice per hour left
// most bundles never renewed. Now each run asks the server how old each bundle/group is and renews the OLDEST ones
// first (up to MAX_BUNDLES and MAX_GROUPS), whatever hour GitHub runs it. If the server cannot say, the hour's slice.
const MAX_BUNDLES = 24, MAX_GROUPS = 6, FRESH_MS = 20 * 3600 * 1000;
let ages = null;
try {
  const r = await fetch(`${SERVER}/api/admin/ages`, { headers: { 'X-Ingest-Token': TOKEN || '' } });
  if (r.ok) ages = await r.json();
} catch { /* fall back to the hour's slice */ }
const work = [];
let label;
if (ages && process.env.FORCE_HOUR === undefined || ages && process.env.FORCE_HOUR === '') {
  const age = (k) => Date.now() - (ages[k] ?? 0);
  const oldGroups = plan.sg.filter((g) => age(g.key) > FRESH_MS).sort((a, b) => age(b.key) - age(a.key)).slice(0, MAX_GROUPS);
  const oldBundles = plan.bundles.filter((x) => age(x.key) > FRESH_MS).sort((a, b) => age(b.key) - age(a.key)).slice(0, MAX_BUNDLES);
  for (const g of oldGroups) work.push(() => group(g));
  for (const x of oldBundles) work.push(() => bundle(x));
  label = `oldest first: ${oldGroups.length} groups, ${oldBundles.length} bundles, ${oldBundles.reduce((a, x) => a + x.beaches.length, 0)} beaches`;
} else {
  if (h < plan.sg.length) work.push(() => group(plan.sg[h]));
  const mine = plan.bundles.filter((x) => x.key.startsWith(`fcb:${h}:`));
  for (const x of mine) work.push(() => bundle(x));
  label = `hour ${h}: ${h < plan.sg.length ? 1 : 0} group, ${mine.length} bundles, ${mine.reduce((a, x) => a + x.beaches.length, 0)} beaches`;
}
console.log(label);
// Keep the free Supabase project awake (it pauses after 7 days of low activity: supabase.com docs, 2026-11-23):
// once a day (hour 3) one tiny read of a public table. Only if the repository has the two secrets.
if (h === 3 && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  try {
    // Tolerant to how the URL was pasted: trailing slashes or "/rest/v1" are removed; only the origin is used.
    const origin = new URL(process.env.SUPABASE_URL.trim()).origin;
    const r = await fetch(`${origin}/rest/v1/pins?select=id&limit=1`, { headers: { apikey: process.env.SUPABASE_ANON_KEY.trim() } });
    // Shape only (never the value): helps to see a wrong URL without printing it.
    console.log(`supabase keep-alive: ${r.status} (host ends with .supabase.co: ${origin.endsWith('.supabase.co')}, key starts sb_publishable_: ${process.env.SUPABASE_ANON_KEY.trim().startsWith('sb_publishable_')})`);
    if (!r.ok) console.log(`supabase answer: ${(await r.text()).slice(0, 160)}`);
  } catch (e) { console.log(`supabase keep-alive failed: ${e}`); }
}
try {
  for (const job of work) await job();
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  console.log(`stopped: Open-Meteo limit (${stats.limited})`);
}
console.log(JSON.stringify(stats));

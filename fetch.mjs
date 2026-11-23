// WavePulse fetcher: a second, independent source of forecast data for the WavePulse server (free, non-commercial).
// Runs every hour on GitHub Actions. It asks Open-Meteo (open-meteo.com, CC BY 4.0) for the requests listed in
// plan.json and hands the answers to the WavePulse server, in the format the server stores. No dependencies.
//
// Each hour (UTC hour h) does a slice, so the whole list is covered once a day within the free daily limit:
//   - full forecasts of the beaches with index % 24 === h       (~25 beaches)
//   - every 6 h (h % 6 === 0): the main beaches again           (58)
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

async function beach(e) {
  const m = await get(e.marine);
  if (!m) { stats.failed++; return; }
  const w = (await get(e.weather)) ?? (await get(e.weatherGlobal));
  if (!w) { stats.failed++; return; }
  const v = (await get(e.waves)) ?? (await get(e.wavesGlobal));
  await put(e.key, `{"at":"${new Date().toISOString()}","marine":${m},"weather":${w},"waves":${v ?? 'null'}}`);
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

const work = [];
if (h < plan.sg.length) work.push(() => group(plan.sg[h]));
const beaches = plan.fc.filter((e, i) => i % 24 === h || (h % 6 === 0 && e.main));
for (const e of beaches) work.push(() => beach(e));
console.log(`hour ${h}: ${h < plan.sg.length ? 1 : 0} group, ${beaches.length} beaches`);
try {
  for (const job of work) await job();
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  console.log(`stopped: Open-Meteo limit (${stats.limited})`);
}
console.log(JSON.stringify(stats));

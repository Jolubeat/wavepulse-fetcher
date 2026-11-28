"""
World wind and waves for the WavePulse maps (owner, 2026-11-28: "the whole world, like we had"), from NOAA's global
models instead of point requests to Open-Meteo (0 Open-Meteo requests):
  - wind at 10 m: GFS 1.00 degree (NOMADS grib filter "gfs_1p00"), UGRD/VGRD;
  - waves: GFS-Wave global 0.25 degree (grib filter "gfswave"), HTSGW / DIRPW / PERPW, thinned to 1 degree.
NOAA/NWS data are public domain (weather.gov/disclaimer); the app credits "NOAA GFS" and never presents them as its own.
NOMADS asks for a 10 s wait between fetches and for subsets only (nomads.ncep.noaa.gov/info.php?page=gribfilter):
one variable subset per file, 10 s apart, ~20 requests per run, every 6 h.

Output, per forecast hour i (0..8 = +0..+24 h, 3-hourly), gzip JSON PUT to the site's server (same ingest as fetch.mjs):
  wind/<i>: {t, nx, ny, lat0, lon0, d, u, v}  u/v in 0.5 m/s steps as int8, base64, rows north->south, lon 0..359
  wave/<i>: {t, nx, ny, lat0, lon0, d, hs, dir, per}  uint8: hs 0.1 m, dir 2 degrees (from), per 0.1 s; 255 = land/none
  gfs:      {at, cycle, times: [...], wave: bool}   written last, so the phone never sees a half-made set.
Run on GitHub Actions only (never from the owner's work PC). Needs INGEST_TOKEN; WAVEPULSE_SERVER optional.
"""
import base64, datetime as dt, gzip, json, os, sys, time, urllib.request
import numpy as np
import pygrib

SERVER = os.environ.get("WAVEPULSE_SERVER", "https://wavepulse.yoga-app.workers.dev").rstrip("/")
TOKEN = os.environ.get("INGEST_TOKEN", "")
UA = {"User-Agent": "WavePulse map wind (free non-commercial beach forecast; github.com/Jolubeat/wavepulse-fetcher)"}
HOURS = list(range(0, 25, 3))
WAIT = 10  # seconds between NOMADS fetches (their rule)
last = [0.0]


def get(url):
    gap = WAIT - (time.time() - last[0])
    if gap > 0: time.sleep(gap)
    last[0] = time.time()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
            b = r.read()
            return b if b[:4] == b"GRIB" else None
    except Exception as e:
        print("fetch failed", url.split("?")[1][:120], e)
        return None


def wind_url(day, cyc, fh):
    return ("https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl?"
            f"dir=%2Fgfs.{day}%2F{cyc}%2Fatmos&file=gfs.t{cyc}z.pgrb2.1p00.f{fh:03d}"
            "&var_UGRD=on&var_VGRD=on&lev_10_m_above_ground=on")


def wave_url(day, cyc, fh):
    return ("https://nomads.ncep.noaa.gov/cgi-bin/filter_gfswave.pl?"
            f"dir=%2Fgfs.{day}%2F{cyc}%2Fwave%2Fgridded&file=gfswave.t{cyc}z.global.0p25.f{fh:03d}.grib2"
            "&var_HTSGW=on&var_DIRPW=on&var_PERPW=on&lev_surface=on")


def fields(b):
    """{shortName or name: 2D array north->south, lon from 0}, plus the first grid's (lats, lons)."""
    path = "/tmp/x.grib2"
    open(path, "wb").write(b)
    out, grid = {}, None
    for g in pygrib.open(path):
        vals = np.ma.filled(g.values.astype("float32"), np.nan)
        lats, lons = g.latlons()
        if lats[0, 0] < lats[-1, 0]: vals, lats = vals[::-1], lats[::-1]
        out[g.shortName] = vals
        grid = grid or (lats, lons)
    return out, grid


def put(key, obj):
    body = gzip.compress(json.dumps(obj, separators=(",", ":")).encode())
    req = urllib.request.Request(f"{SERVER}/api/ingest/{key}", data=body, method="PUT",
                                 headers={**UA, "X-Ingest-Token": TOKEN, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        print("put", key, len(body), "bytes", r.status)


b64 = lambda a: base64.b64encode(a.tobytes()).decode()


def main():
    if not TOKEN: sys.exit("INGEST_TOKEN missing")
    now = dt.datetime.now(dt.timezone.utc)
    # Newest cycle that is published (about 3.5-5 h after its time): try the last ones, newest first.
    for back in range(4, 30, 6):
        c = now - dt.timedelta(hours=back)
        c = c.replace(hour=c.hour // 6 * 6, minute=0, second=0, microsecond=0)
        day, cyc = c.strftime("%Y%m%d"), c.strftime("%H")
        first = get(wind_url(day, cyc, 0))
        if first: break
    else:
        sys.exit("no GFS cycle available")
    print("cycle", day, cyc)
    times, wave_ok = [], True
    for i, fh in enumerate(HOURS):
        b = first if fh == 0 else get(wind_url(day, cyc, fh))
        if not b: print("wind missing at", fh); break
        f, (lats, lons) = fields(b)
        u, v = f.get("10u"), f.get("10v")
        if u is None or v is None: print("no 10u/10v", list(f)); break
        q = lambda a: np.clip(np.nan_to_num(np.round(a * 2), nan=0), -127, 127).astype("int8")
        t = (c + dt.timedelta(hours=fh)).strftime("%Y-%m-%dT%H:00Z")
        meta = {"t": t, "ny": int(u.shape[0]), "nx": int(u.shape[1]), "lat0": float(lats[0, 0]), "lon0": float(lons[0, 0]),
                "d": float(abs(lats[1, 0] - lats[0, 0]))}
        put(f"wind/{i}", {**meta, "u": b64(q(u)), "v": b64(q(v))})
        if wave_ok:
            wb = get(wave_url(day, cyc, fh))
            wf, wg = fields(wb) if wb else ({}, None)
            hs, di, pe = wf.get("swh"), wf.get("dirpw"), wf.get("perpw")
            if hs is None or di is None or pe is None or wg is None:
                print("waves missing", fh, list(wf)); wave_ok = False
            else:
                step = max(1, round(1.0 / abs(wg[0][1, 0] - wg[0][0, 0])))  # thin to ~1 degree
                hs, di, pe = hs[::step, ::step], di[::step, ::step], pe[::step, ::step]
                wl, wo = wg[0][::step, ::step], wg[1][::step, ::step]
                enc = lambda a, k, top: np.where(np.isnan(a), 255, np.clip(np.round(a * k), 0, top)).astype("uint8")
                put(f"wave/{i}", {"t": t, "ny": int(hs.shape[0]), "nx": int(hs.shape[1]), "lat0": float(wl[0, 0]),
                                  "lon0": float(wo[0, 0]), "d": float(abs(wl[1, 0] - wl[0, 0])),
                                  "hs": b64(enc(hs, 10, 254)), "dir": b64(enc(np.mod(di, 360), 0.5, 179)), "per": b64(enc(pe, 10, 254))})
        times.append(t)
    if not times: sys.exit("nothing made")
    put("gfs", {"at": now.strftime("%Y-%m-%dT%H:%MZ"), "cycle": f"{day}T{cyc}Z", "times": times, "wave": wave_ok})


main()

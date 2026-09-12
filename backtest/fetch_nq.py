#!/usr/bin/env python3
"""Fetch genuine NQ futures intraday from Yahoo with a cookie+crumb session,
and record full provenance alongside every file.

Yahoo now rejects anonymous chart requests with HTTP 429; a cookie from
fc.yahoo.com plus a crumb from /v1/test/getcrumb is required. Without it the
API looks dead when it is merely gated.

Hard limits, measured 2026-09-12 (not assumed - see README):
    1m   ->  ~9 days     5m/15m/30m -> ~71 days     60m -> ~875 days
Requesting an older window with period1/period2 returns HTTP 422, so the
window cannot be paged backwards. Expired contracts are purged: NQU26.CME
still resolves, NQM26.CME and older return 404.
"""
import csv, datetime, http.cookiejar, json, os, sys, time, urllib.error, urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36")


def session():
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.addheaders = [("User-Agent", UA), ("Accept", "text/html,application/json,*/*")]
    try:
        op.open("https://fc.yahoo.com", timeout=30).read(100)
    except Exception:
        pass
    crumb = op.open("https://query2.finance.yahoo.com/v1/test/getcrumb",
                    timeout=30).read().decode().strip()
    return op, crumb


def fetch(op, crumb, symbol, interval, rng):
    url = (f"https://query2.finance.yahoo.com/v8/finance/chart/{symbol}"
           f"?interval={interval}&range={rng}&includePrePost=true&crumb={crumb}")
    for attempt in range(6):
        try:
            j = json.loads(op.open(url, timeout=60).read())
            break
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(15 * (attempt + 1)); continue
            raise
        except Exception:
            time.sleep(8)
    else:
        raise RuntimeError(f"{symbol} {interval}: exhausted retries")
    res = j["chart"]["result"][0]
    ts = res["timestamp"]
    q = res["indicators"]["quote"][0]
    meta = res.get("meta", {})
    rows = []
    for i, t in enumerate(ts):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if None in (o, h, l, c):
            continue                       # halt / null candle
        rows.append((t, o, h, l, c, q["volume"][i] or 0))
    return rows, meta


def write(path, rows):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time", "open", "high", "low", "close", "volume"])
        w.writerows(rows)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "data_nq"
    os.makedirs(out, exist_ok=True)
    op, crumb = session()
    prov = []
    for sym, interval, rng, tag in (("NQ=F", "1m", "8d", "NQ_1m"),
                                    ("NQ=F", "5m", "60d", "NQ_5m"),
                                    ("NQ=F", "15m", "60d", "NQ_15m"),
                                    ("NQ=F", "60m", "730d", "NQ_1h")):
        rows, meta = fetch(op, crumb, sym, interval, rng)
        write(os.path.join(out, f"{tag}.csv"), rows)
        d0 = datetime.datetime.utcfromtimestamp(rows[0][0]).isoformat()
        d1 = datetime.datetime.utcfromtimestamp(rows[-1][0]).isoformat()
        nvol = sum(1 for r in rows if r[5])
        prov.append(dict(file=f"{tag}.csv", source="Yahoo Finance v8 chart API",
                         symbol=sym, requested_range=rng, interval=interval,
                         bars=len(rows), first_utc=d0, last_utc=d1,
                         exchange=meta.get("exchangeName"),
                         instrument=meta.get("instrumentType"),
                         tz=meta.get("exchangeTimezoneName"),
                         gmtoffset=meta.get("gmtoffset"),
                         currency=meta.get("currency"),
                         bars_with_volume=nvol,
                         pct_bars_with_volume=round(100 * nvol / len(rows), 1),
                         fetched_utc=datetime.datetime.utcnow().isoformat(),
                         adjustment="none - raw front-month continuous",
                         roll="Yahoo-internal, undocumented; see README caveat"))
        print(f"  {tag:<8} {len(rows):>6} bars  {d0[:10]} -> {d1[:10]}  "
              f"vol on {100*nvol//len(rows)}%  exch={meta.get('exchangeName')}")
        time.sleep(8)
    with open(os.path.join(out, "PROVENANCE.json"), "w") as f:
        json.dump(prov, f, indent=2)
    print(f"\nprovenance -> {out}/PROVENANCE.json")

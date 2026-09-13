#!/usr/bin/env python3
"""Fetch multi-year 1-minute index data from Dukascopy's free feed.

Yahoo caps 5-minute history at 60 days, which is far too short a window to
tune a 5-minute model on without fitting one market regime. Dukascopy serves
free per-day files of 1-minute candles going back years for its index CFDs,
and USATECHIDXUSD tracks the same Nasdaq-100 underlying as NQ/MNQ.

Caveats, which matter when reading results from this data:
  * These are CFDs on the cash index, not the futures contract: no roll, no
    basis, and a different tick size. Use them to test whether a rule survives
    across regimes, not to quote a futures P&L.
  * "Volume" is broker tick volume, not exchange contract volume. It is only
    used here to weight VWAP.
  * Timestamps are UTC; the session calendar converts to exchange time.

File layout: /datafeed/{INSTRUMENT}/{YYYY}/{MM-1:02d}/{DD:02d}/BID_candles_min_1.bi5
LZMA-compressed, 24-byte records of (int32 second-offset, int32 o, c, l, h,
float32 volume), prices scaled by 1000.
"""
import csv
import datetime
import json
import lzma
import os
import struct
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HEADERS = {"User-Agent": "Mozilla/5.0 (mmt-backtest)"}
SCALE = 1000.0


class Unresolved(Exception):
    """Every retry failed. NOT the same as 'this day has no data' - the caller
    must record it distinctly, because a transport failure silently filed as an
    empty day removes real trading sessions from the sample. The first run of
    this fetcher did exactly that to 422 weekdays (19%), all of which returned
    data on retry."""


def fetch_day(inst, d, attempts=6):
    url = (f"https://datafeed.dukascopy.com/datafeed/{inst}/{d.year}/"
           f"{d.month - 1:02d}/{d.day:02d}/BID_candles_min_1.bi5")
    req = urllib.request.Request(url, headers=HEADERS)
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return []          # genuine absence: holiday or before listing
            if attempt == attempts - 1:
                raise Unresolved(f"{d} HTTP {e.code}")
            time.sleep(2 ** attempt * 0.5)
        except Exception as e:  # noqa: BLE001 - transient transport errors
            if attempt == attempts - 1:
                raise Unresolved(f"{d} {type(e).__name__}")
            time.sleep(2 ** attempt * 0.5)
    if not raw:
        return []
    try:
        data = lzma.LZMADecompressor().decompress(raw)
    except Exception:  # noqa: BLE001 - occasional truncated day file
        return []
    base = int(datetime.datetime(d.year, d.month, d.day,
                                 tzinfo=datetime.timezone.utc).timestamp())
    out = []
    for i in range(len(data) // 24):
        off, o, c, l, h = struct.unpack(">5i", data[i * 24:i * 24 + 20])
        v, = struct.unpack(">f", data[i * 24 + 20:i * 24 + 24])
        if o <= 0 or h <= 0 or l <= 0 or c <= 0:
            continue                      # market closed: flat filler records
        o, c, l, h = o / SCALE, c / SCALE, l / SCALE, h / SCALE
        if h < l or not (l <= o <= h and l <= c <= h):
            continue
        if v <= 0 and h == l:
            continue                      # no trade in this minute
        out.append((base + off, o, h, l, c, float(v)))
    return out


def resample(rows, minutes):
    """Bucket 1-minute bars into `minutes`-minute bars on wall-clock boundaries."""
    step = minutes * 60
    out = []
    cur = None
    key = None
    for t, o, h, l, c, v in rows:
        k = t - (t % step)
        if k != key:
            if cur:
                out.append(cur)
            cur = [k, o, h, l, c, v]
            key = k
        else:
            cur[2] = max(cur[2], h)
            cur[3] = min(cur[3], l)
            cur[4] = c
            cur[5] += v
    if cur:
        out.append(cur)
    return out


def save(path, rows):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time", "open", "high", "low", "close", "volume"])
        w.writerows(rows)


def fetch_range(out_dir, inst, tag, start, end, tfs=(5, 15, 60)):
    """Research-grade fetch over an EXPLICIT date window.

    Differs from main() in three ways that matter for reproducibility:
      * the window is pinned to dates, not to `today` minus N years, so a
        re-run a month from now produces byte-identical files;
      * the 1-minute source is written out alongside the resampled frames,
        because intrabar sequencing is calibrated against it;
      * a PROVENANCE.json records the request, the coverage actually returned,
        and every weekday that came back empty. A gap we cannot see is a gap
        we will silently interpolate over later.
    """
    os.makedirs(out_dir, exist_ok=True)
    d0 = datetime.date.fromisoformat(start)
    d1 = datetime.date.fromisoformat(end)
    days = [d0 + datetime.timedelta(days=i)
            for i in range((d1 - d0).days + 1)
            if (d0 + datetime.timedelta(days=i)).weekday() < 5]
    rows, empty, unresolved = [], [], []

    def one(d):
        try:
            return d, fetch_day(inst, d), None
        except Unresolved as e:
            return d, [], str(e)

    with ThreadPoolExecutor(max_workers=6) as ex:
        for i, (d, chunk, err) in enumerate(ex.map(one, days)):
            if err:
                unresolved.append(d.isoformat())
            elif chunk:
                rows.extend(chunk)
            else:
                empty.append(d.isoformat())
            if i % 200 == 0:
                print(f"  {tag}: {i}/{len(days)} days, {len(rows)} minutes, "
                      f"{len(unresolved)} unresolved", flush=True)
    if unresolved:
        print(f"  WARNING: {len(unresolved)} days never resolved after retries")
    if not rows:
        sys.exit(f"HALT: {inst} returned no data for {start}..{end}.")
    rows.sort(key=lambda r: r[0])
    dedup = []
    for r in rows:
        if not dedup or r[0] > dedup[-1][0]:
            dedup.append(r)

    prov = {"source": "Dukascopy free datafeed",
            "url_template": "https://datafeed.dukascopy.com/datafeed/"
                            "{INSTRUMENT}/{YYYY}/{MM-1:02d}/{DD:02d}/"
                            "BID_candles_min_1.bi5",
            "instrument": inst,
            "instrument_class": "CFD on cash index - NOT the futures contract",
            "price_side": "BID only (no ask; spread is not observable)",
            "volume": "broker volume, not exchange contract volume; used only "
                      "to weight VWAP",
            "requested_start": start, "requested_end": end,
            "weekdays_requested": len(days),
            "weekdays_empty": len(empty),
            "empty_days": empty,
            "weekdays_unresolved": len(unresolved),
            "unresolved_days": unresolved,
            "empty_vs_unresolved": "empty = server returned 404 (holiday or "
                                   "pre-listing); unresolved = transport failed "
                                   "every retry. The two are never merged: a "
                                   "failure filed as an absence deletes real "
                                   "sessions from the sample.",
            "bars_1m": len(dedup),
            "first_utc": datetime.datetime.utcfromtimestamp(
                dedup[0][0]).isoformat(),
            "last_utc": datetime.datetime.utcfromtimestamp(
                dedup[-1][0]).isoformat(),
            "fetched_utc": datetime.datetime.utcnow().isoformat(),
            "adjustment": "none - CFD has no roll and no back-adjustment",
            "files": {}}

    save(os.path.join(out_dir, f"{tag}_1m.csv"), dedup)
    prov["files"][f"{tag}_1m.csv"] = len(dedup)
    print(f"  {tag}_1m.csv: {len(dedup)} bars")
    for m in tfs:
        bars = resample(dedup, m)
        name = f"{tag}_{m}m.csv" if m < 60 else f"{tag}_{m // 60}h.csv"
        save(os.path.join(out_dir, name), bars)
        prov["files"][name] = len(bars)
        print(f"  {name}: {len(bars)} bars")

    with open(os.path.join(out_dir, "PROVENANCE.json"), "w") as f:
        json.dump(prov, f, indent=2)
    print(f"{tag}: {len(dedup)} 1m bars {prov['first_utc'][:10]} .. "
          f"{prov['last_utc'][:10]}; {len(empty)} empty weekdays")
    return prov


def main(out_dir, inst, tag, years, tfs=(5, 15, 60)):
    os.makedirs(out_dir, exist_ok=True)
    end = datetime.date.today()
    start = end - datetime.timedelta(days=int(365.25 * years))
    days = [start + datetime.timedelta(days=i)
            for i in range((end - start).days)
            if (start + datetime.timedelta(days=i)).weekday() < 5]
    rows = []
    with ThreadPoolExecutor(max_workers=12) as ex:
        for i, chunk in enumerate(ex.map(lambda d: fetch_day(inst, d), days)):
            rows.extend(chunk)
            if i % 100 == 0:
                print(f"  {tag}: {i}/{len(days)} days, {len(rows)} minutes",
                      flush=True)
    rows.sort(key=lambda r: r[0])
    dedup = []
    for r in rows:
        if not dedup or r[0] > dedup[-1][0]:
            dedup.append(r)
    print(f"{tag}: {len(dedup)} 1m bars "
          f"{datetime.datetime.utcfromtimestamp(dedup[0][0]):%Y-%m-%d} .. "
          f"{datetime.datetime.utcfromtimestamp(dedup[-1][0]):%Y-%m-%d}")
    for m in tfs:
        bars = resample(dedup, m)
        name = f"{tag}_{m}m.csv" if m < 60 else f"{tag}_{m // 60}h.csv"
        save(os.path.join(out_dir, name), bars)
        print(f"  {name}: {len(bars)} bars")


def repair(out_dir, inst, tag, tfs=(5, 15, 60)):
    """Refetch days a previous run failed to resolve, and merge them in.

    The first run of fetch_range recorded 422 weekdays as empty that were in
    fact transport failures - every sampled one returned data on retry. This
    re-requests every day currently listed as empty or unresolved, keeps the
    ones that really are absent (the server 404s), and rewrites the frames and
    provenance. Days genuinely absent stay absent; nothing is interpolated.
    """
    import json
    prov_path = os.path.join(out_dir, "PROVENANCE.json")
    with open(prov_path) as f:
        prov = json.load(f)
    suspect = [datetime.date.fromisoformat(x)
               for x in prov.get("empty_days", []) + prov.get("unresolved_days", [])]
    if not suspect:
        print("nothing to repair")
        return prov
    print(f"re-requesting {len(suspect)} days recorded as empty/unresolved")

    def one(d):
        try:
            return d, fetch_day(inst, d), None
        except Unresolved as e:
            return d, [], str(e)

    new, still_empty, unresolved = [], [], []
    with ThreadPoolExecutor(max_workers=6) as ex:
        for i, (d, chunk, err) in enumerate(ex.map(one, suspect)):
            if err:
                unresolved.append(d.isoformat())
            elif chunk:
                new.extend(chunk)
            else:
                still_empty.append(d.isoformat())
            if i % 100 == 0:
                print(f"  repair {i}/{len(suspect)}, recovered "
                      f"{len(new)} minutes", flush=True)

    existing = []
    with open(os.path.join(out_dir, f"{tag}_1m.csv")) as f:
        r = csv.reader(f)
        next(r)
        for x in r:
            existing.append((int(x[0]), float(x[1]), float(x[2]),
                             float(x[3]), float(x[4]), float(x[5])))
    merged = sorted(existing + new, key=lambda r: r[0])
    dedup = []
    for r in merged:
        if not dedup or r[0] > dedup[-1][0]:
            dedup.append(r)
    print(f"  {len(existing):,} existing + {len(new):,} recovered "
          f"-> {len(dedup):,} unique 1m bars")
    print(f"  genuinely absent (404): {len(still_empty)}   "
          f"still unresolved: {len(unresolved)}")

    save(os.path.join(out_dir, f"{tag}_1m.csv"), dedup)
    prov["files"] = {f"{tag}_1m.csv": len(dedup)}
    for m in tfs:
        bars = resample(dedup, m)
        name = f"{tag}_{m}m.csv" if m < 60 else f"{tag}_{m // 60}h.csv"
        save(os.path.join(out_dir, name), bars)
        prov["files"][name] = len(bars)
        print(f"  {name}: {len(bars)} bars")
    prov.update(bars_1m=len(dedup),
                empty_days=still_empty, weekdays_empty=len(still_empty),
                unresolved_days=unresolved, weekdays_unresolved=len(unresolved),
                first_utc=datetime.datetime.utcfromtimestamp(dedup[0][0]).isoformat(),
                last_utc=datetime.datetime.utcfromtimestamp(dedup[-1][0]).isoformat(),
                repaired_utc=datetime.datetime.utcnow().isoformat(),
                repair_note=f"{len(suspect)} days re-requested after a "
                            "concurrency-induced silent-failure defect; "
                            f"{len(new):,} minutes recovered")
    with open(prov_path, "w") as f:
        json.dump(prov, f, indent=2)
    return prov


if __name__ == "__main__":
    if sys.argv[1] == "range":       # out_dir inst tag start end
        fetch_range(*sys.argv[2:7])
    elif sys.argv[1] == "repair":    # out_dir inst tag
        repair(*sys.argv[2:5])
    else:
        main(sys.argv[1], sys.argv[2], sys.argv[3],
             float(sys.argv[4]) if len(sys.argv) > 4 else 4.0)

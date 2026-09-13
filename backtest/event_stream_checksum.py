#!/usr/bin/env python3
"""Deterministic checksum of the burn-in event stream.

Exists to prove ONE thing: that documenting the first-qualifying-penetration
state machine did not change what the engine emits. The 19 winsorization
constants were computed from this exact stream, so if the checksum moves, the
constants are invalid and must be recomputed.

Hashes the ordered emission sequence AND every feature value. Computes no
outcome: no return, no MFE, no MAE.
"""
import csv, datetime as dt, hashlib, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, v2_events as V, v2_features as FE

BURN_START, BURN_END = dt.date(2022, 9, 9), dt.date(2023, 8, 31)


def stream_rows(start=BURN_START, end=BURN_END):
    lo, hi = S.span_epoch(start, end)
    bars = FE.load_raw(V.RAW_BASIS, lo, hi)
    vol = []
    with open(V.RAW_BASIS) as f:
        r = csv.reader(f); next(r)
        for x in r:
            ts = int(x[0])
            if lo <= ts < hi:
                vol.append(float(x[5]))
    bars["v"] = vol
    st = FE.build_state(bars)
    vwap, vsig, vnbar = FE.session_vwap(bars, st)
    a15, n15, k15 = FE.htf_aggregates(bars, st, 900)
    a1h, n1h, k1h = FE.htf_aggregates(bars, st, 3600)
    return FE.event_time_features(bars, st, FE.iter_levels(bars, st),
                                  vwap, vsig, vnbar, a15, n15, k15,
                                  a1h, n1h, k1h)


def checksum(rows):
    """Order-sensitive digest. A level that fired twice, a level that stopped
    firing, or any changed feature value all move this."""
    h = hashlib.sha256()
    for r in rows:
        h.update(json.dumps(r, sort_keys=True, default=str).encode())
        h.update(b"\x00")
    return h.hexdigest()


if __name__ == "__main__":
    rows = stream_rows()
    d = checksum(rows)
    lvl = {r.get("level_id") for r in rows if r.get("level_id") is not None}
    print(f"events        {len(rows):,}")
    print(f"trade dates   {len({r['trade_date'] for r in rows})}")
    print(f"unique levels {len(lvl):,}")
    print(f"max events per level_id "
          f"{max([sum(1 for r in rows if r.get('level_id')==x) for x in list(lvl)[:1]] or [0])}"
          if False else "")
    print(f"sha256        {d}")
    if len(sys.argv) > 1 and sys.argv[1] == "--write":
        json.dump({"source_period": f"{BURN_START}..{BURN_END}",
                   "basis": V.RAW_BASIS, "events": len(rows),
                   "unique_level_ids": len(lvl), "sha256": d,
                   "note": "Event-stream identity for the first-qualifying-"
                           "penetration rule. No outcome is computed."},
                  open("research/EVENT_STREAM_CHECKSUM.json", "w"), indent=2)
        print("-> research/EVENT_STREAM_CHECKSUM.json")

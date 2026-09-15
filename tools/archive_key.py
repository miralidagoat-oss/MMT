#!/usr/bin/env python3
"""Bank each day's gamma key so the one experiment that matters becomes possible.

THE PROBLEM THIS SOLVES
QT KEY's levels sit on the option strike grid, and that grid has been measured as
carrying no edge at all -- 25-pt, 100-pt and 250-pt grids all clean-reverse at
25-27%, against a null of 25.9% (tools/find_reversal_zones.py). So every bit of
value the indicator could have must come from the GAMMA WEIGHTING picking which
grid points matter, and that selection has never been tested against anything.

Testing it needs historical gamma levels. No free feed carries historical option
chains, so they cannot be recovered -- they can only be ACCUMULATED. This banks
them. Run it daily and in a couple of months the question is answerable; skip it
and it stays unanswerable forever, which is the only reason this file exists.

    python3 tools/archive_key.py                # bank today
    python3 tools/archive_key.py --status       # how many sessions are banked
    python3 tools/archive_key.py --dry-run      # generate, show, write nothing

RUN IT AFTER THE CASH CLOSE. gamma_key.py drops the still-forming daily bar and
anchors on the last completed session, so running mid-session banks a key stamped
for a session already in progress. That is not wrong, but it is not what you want
to test against either.

Stdlib only. One JSON object per line, append-only, deduped by (session, tag).
"""
import argparse
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gamma_key as G  # noqa: E402

ARCHIVE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "keys", "archive.jsonl")
NEEDED = 60          # sessions before the null test has any power


def load():
    if not os.path.exists(ARCHIVE):
        return []
    out = []
    with open(ARCHIVE) as f:
        for ln in f:
            ln = ln.strip()
            if ln:
                try:
                    out.append(json.loads(ln))
                except json.JSONDecodeError:
                    pass
    return out


def parse_row(row):
    """A 25-field key row -> a record rich enough to replay and to slice."""
    f = row.split(",")
    if len(f) < 25:
        raise ValueError("row has %d fields, need 25" % len(f))
    n = lambda i: float(f[i])                                   # noqa: E731
    return {
        "tag": f[0], "session": f[1],
        "flip": n(2), "net_gex": n(3), "step": n(4),
        "charm": n(5), "vanna": n(6), "call_wall": n(7), "put_wall": n(8),
        "levels": [{"grade": 5 - j, "px": n(9 + j * 3),
                    "gex": n(10 + j * 3), "p_reach": n(11 + j * 3)} for j in range(5)],
        "implied_move": n(24),
    }


def status(recs):
    by = {}
    for r in recs:
        by.setdefault(r["tag"], set()).add(r["session"])
    print("archive: %s" % ARCHIVE)
    if not recs:
        print("  empty -- nothing banked yet")
    for tag in sorted(by):
        s = sorted(by[tag])
        print("  %-3s %3d sessions   %s .. %s" % (tag, len(s), s[0], s[-1]))
    least = min((len(v) for v in by.values()), default=0)
    if least >= NEEDED:
        print("\n  >= %d sessions banked. Run:  python3 tools/test_gamma_levels.py" % NEEDED)
    else:
        print("\n  %d more sessions until the null test has any power (need ~%d)."
              % (NEEDED - least, NEEDED))
        print("  Nothing to conclude before then, and conclusions drawn earlier will be noise.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--max-dte", type=float, default=7.0)
    ap.add_argument("--rate", type=float, default=0.04)
    ap.add_argument("--iv-floor", type=float, default=0.05)
    a = ap.parse_args()

    recs = load()
    if a.status:
        status(recs)
        return

    have = {(r["session"], r["tag"]) for r in recs}
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    added = 0
    for tag in ("ES", "NQ"):
        try:
            row = G.build_row(tag, None, a.max_dte, a.rate, 1.0, a.iv_floor,
                              G.REACH_DEFAULT[tag], verbose=False)
            rec = parse_row(row)
        except Exception as e:                            # noqa: BLE001
            print("  %s FAILED: %s" % (tag, e), file=sys.stderr)
            continue
        key = (rec["session"], rec["tag"])
        if key in have:
            print("  %s %s already banked -- skipped" % rec_key_str(key))
            continue
        rec["generated_utc"] = now
        rec["row"] = row
        if a.dry_run:
            print("  would bank %s %s: %s" % (rec["tag"], rec["session"],
                  ", ".join("%.2f" % l["px"] for l in rec["levels"])))
            continue
        with open(ARCHIVE, "a") as f:
            f.write(json.dumps(rec) + "\n")
        print("  banked %s %s: %s" % (rec["tag"], rec["session"],
              ", ".join("%.2f" % l["px"] for l in rec["levels"])))
        added += 1

    if not a.dry_run:
        print()
        status(load())


def rec_key_str(k):
    return (k[1], k[0])


if __name__ == "__main__":
    main()

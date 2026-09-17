#!/usr/bin/env python3
"""Validate or build a daily key row for indicators/qt_reversal_zones.pine.

The indicator fails silently into "price zones active" for eight different
reasons, and the status line names the class of problem but not the field. This
applies the same rules offline and points at the offending column.

It does not produce levels. Ranks 4 and 5 come from whatever service publishes
your key; this only checks that a row you already have will load, or formats
numbers you already have into a row that will.

  python3 backtest/validate_key.py keys.txt --tag NQ
  python3 backtest/validate_key.py keys.txt --tag NQ --for 20260917
  python3 backtest/validate_key.py --make --tag NQ --date 20260917 \
      --rank5 24010.25 --rank4 23890.50 --published 2026-09-17T06:00-07:00

Field layout (25 or 26 comma-separated columns; only these five are read):
  0  symbol tag, NQ or ES      1  date YYYYMMDD
  9  rank 5 price             12  rank 4 price
  25 publication time, Unix milliseconds (26-column rows only)
Everything else only has to be present so the column count validates.
"""
import argparse
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

CA = ZoneInfo("America/Los_Angeles")
COL_TAG, COL_DATE, COL_RANK5, COL_RANK4, COL_PUB = 0, 1, 9, 12, 25
MIN_PUB_MS = 1_000_000_000_000


def tonumber(s):
    """Pine str.tonumber: na on anything it cannot read as a number."""
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def parse(text, tag):
    """Mirror of the indicator's parse loop. Returns (rows, problems)."""
    rows, problems, seen = {}, [], {}
    cleaned = text.replace("\r", "").replace("\n", ";")
    for lineno, raw in enumerate(cleaned.split(";"), 1):
        if not raw.strip():
            continue
        f = raw.strip().split(",")
        if len(f) not in (25, 26):
            problems.append((lineno, "MALFORMED",
                             f"{len(f)} columns; the indicator accepts 25 or 26"))
            continue
        if f[COL_TAG].strip() != tag:
            problems.append((lineno, "skipped",
                             f"tag {f[COL_TAG].strip()!r} is not {tag!r}; "
                             "the indicator ignores this row silently"))
            continue
        date = f[COL_DATE].strip()
        if len(date) != 8 or not date.isdigit():
            problems.append((lineno, "MALFORMED",
                             f"column 1 {date!r} is not an 8-digit YYYYMMDD"))
            continue
        r5, r4 = tonumber(f[COL_RANK5].strip()), tonumber(f[COL_RANK4].strip())
        if r5 is None or r5 <= 0 or r4 is None or r4 <= 0:
            bad = []
            if r5 is None or r5 <= 0:
                bad.append(f"column 9 (rank 5) = {f[COL_RANK5]!r}")
            if r4 is None or r4 <= 0:
                bad.append(f"column 12 (rank 4) = {f[COL_RANK4]!r}")
            problems.append((lineno, "REJECTED for " + date,
                             "invalid 4/5 level prices: " + "; ".join(bad)))
            continue
        legacy = len(f) == 25
        pub = None
        if not legacy:
            pub = tonumber(f[COL_PUB].strip())
            if pub is None or pub < MIN_PUB_MS:
                hint = ""
                if pub is not None and pub > 0:
                    hint = (f" - looks like seconds; milliseconds would be "
                            f"{int(pub)*1000}")
                problems.append((lineno, "REJECTED for " + date,
                                 f"column 25 {f[COL_PUB]!r} is not a Unix "
                                 f"millisecond timestamp{hint}"))
                continue
        for i, v in ((COL_RANK5, f[COL_RANK5]), (COL_RANK4, f[COL_RANK4]),
                     (COL_PUB, f[COL_PUB] if not legacy else "")):
            if v and v != v.strip():
                problems.append((lineno, "note",
                                 f"column {i} has surrounding whitespace; "
                                 "tolerated, but tidy it"))
        if date in seen:
            problems.append((lineno, "DUPLICATE for " + date,
                             f"also on row {seen[date]}; the indicator refuses "
                             "both and shows 'Duplicate key date'"))
            rows.pop(date, None)
            continue
        seen[date] = lineno
        rows[date] = {"line": lineno, "r5": r5, "r4": r4,
                      "legacy": legacy, "pub": pub}
    return rows, problems


def describe(date, row):
    print(f"\n  {date}  (row {row['line']})")
    print(f"    rank 5 : {row['r5']}")
    print(f"    rank 4 : {row['r4']}")
    if row["legacy"]:
        print("    25-column legacy row: no publication time. The indicator")
        print("    shows it only as a current-chart preview unless you set an")
        print("    authentic '25-column key: known since' time.")
        return
    pub = datetime.fromtimestamp(row["pub"] / 1000, tz=timezone.utc).astimezone(CA)
    print(f"    published: {pub:%Y-%m-%d %H:%M %Z}")
    d = datetime.strptime(date, "%Y%m%d").replace(tzinfo=CA)
    ny_end = d.replace(hour=13, minute=55)
    asia_end = d.replace(hour=19, minute=0)
    for name, start, end in (("New York", d.replace(hour=6), ny_end),
                             ("Asia", d.replace(hour=15), asia_end)):
        if pub >= end:
            print(f"    {name} block: published after the {end:%H:%M} deadline "
                  "- levels never placed")
        elif pub <= start:
            print(f"    {name} block: available from the open")
        else:
            print(f"    {name} block: available from {pub:%H:%M}")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", nargs="?", help="key file; omit with --make")
    ap.add_argument("--tag", default="NQ", choices=["NQ", "ES"],
                    help="NQ covers MNQ and NQ; ES covers MES and ES")
    ap.add_argument("--for", dest="want", metavar="YYYYMMDD",
                    help="check that a specific trading date is covered")
    ap.add_argument("--make", action="store_true", help="build a row instead")
    ap.add_argument("--date", help="--make: YYYYMMDD")
    ap.add_argument("--rank5", type=float, help="--make: rank 5 level price")
    ap.add_argument("--rank4", type=float, help="--make: rank 4 level price")
    ap.add_argument("--published", help="--make: ISO time or Unix ms; omit for "
                                        "a 25-column legacy row")
    a = ap.parse_args()

    if a.make:
        missing = [n for n, v in (("--date", a.date), ("--rank5", a.rank5),
                                  ("--rank4", a.rank4)) if v is None]
        if missing:
            sys.exit(f"--make needs {', '.join(missing)}. These are your "
                     "numbers; this tool does not invent levels.")
        if len(a.date) != 8 or not a.date.isdigit():
            sys.exit("--date must be 8 digits, YYYYMMDD")
        if a.rank5 <= 0 or a.rank4 <= 0:
            sys.exit("rank prices must be greater than zero")
        f = ["-"] * (25 if a.published is None else 26)
        f[COL_TAG], f[COL_DATE] = a.tag, a.date
        # Not %g: it defaults to 6 significant digits and silently drops a
        # quarter point off a 7-digit index price (11111.25 -> 11111.2).
        def fmt(x):
            return f"{x:.4f}".rstrip("0").rstrip(".")
        f[COL_RANK5] = fmt(a.rank5)
        f[COL_RANK4] = fmt(a.rank4)
        if a.published is not None:
            if a.published.isdigit():
                ms = int(a.published)
            else:
                ms = int(datetime.fromisoformat(a.published).timestamp() * 1000)
            if ms < MIN_PUB_MS:
                sys.exit(f"publication time {ms} is not milliseconds")
            f[COL_PUB] = str(ms)
        row = ",".join(f)
        print(row)
        rows, problems = parse(row, a.tag)
        bad = [p for p in problems if p[1] != "note"]
        print("\nself-check:", "row is valid" if rows and not bad else "FAILED")
        for _, kind, msg in problems:
            print(f"  {kind}: {msg}")
        return

    if not a.file:
        ap.error("give a key file, or use --make")
    rows, problems = parse(open(a.file).read(), a.tag)

    print(f"{a.file}: {len(rows)} usable {a.tag} row(s)")
    hard = [p for p in problems if p[1] not in ("note", "skipped")]
    for lineno, kind, msg in problems:
        print(f"  row {lineno}: {kind} - {msg}")
    for date in sorted(rows):
        describe(date, rows[date])

    print("\nThe default price frame is cash: rank prices must be index points")
    print("(NDX for NQ, SPX for ES) and the indicator adds the measured basis.")
    print("Set 'Key price frame' to futures if your key publishes futures prices.")

    if a.want:
        ok = a.want in rows
        verdict = "covered" if ok else (
            "NOT COVERED - the indicator will show no key for this date "
            "and draw price zones only")
        print(f"\n{a.want}: {verdict}")
        sys.exit(0 if ok else 1)
    sys.exit(1 if hard else 0)


if __name__ == "__main__":
    main()

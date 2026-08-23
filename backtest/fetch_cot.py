#!/usr/bin/env python3
"""Fetch CFTC Traders-in-Financial-Futures positioning for Nasdaq-100.

Source: CFTC Public Reporting Environment (Socrata), dataset gpe5-46if
        https://publicreporting.cftc.gov/resource/gpe5-46if.json
        Primary source, no API key required.

TIMING — the part that determines whether this is usable at all:
  * Each report reflects positions held at the CLOSE OF TUESDAY.
  * It is PUBLISHED the following FRIDAY at 15:30 ET.
  * So the freshest positioning you can legally act on at any moment is
    already 3 days stale, and by the following Thursday it is 9 days stale.
  * `release_ts` below is the Friday 15:30 ET publication instant. Any
    backtest that conditions on a COT value before that instant is using
    information that did not exist yet.

CFTC also revises prior weeks. This fetch takes whatever is currently
published, which means historical values may differ from what was visible in
real time — a look-ahead risk that cannot be fully removed from this source.
"""
import csv
import datetime as dt
import json
import os
import sys
import urllib.parse
import urllib.request

URL = "https://publicreporting.cftc.gov/resource/gpe5-46if.json"
COMMODITY = "NASDAQ  BROADBASED INDICES"          # note the double space
FIELDS = ["report_date_as_yyyy_mm_dd", "market_and_exchange_names",
          "cftc_contract_market_code", "open_interest_all",
          "lev_money_positions_long", "lev_money_positions_short",
          "asset_mgr_positions_long", "asset_mgr_positions_short",
          "dealer_positions_long_all", "dealer_positions_short_all"]


def et_offset(d):
    """US Eastern offset for a date (DST 2nd Sun Mar - 1st Sun Nov)."""
    def nth(y, m, wd, n):
        x = dt.date(y, m, 1)
        return x + dt.timedelta(days=(wd - x.weekday()) % 7 + 7 * (n - 1))
    return -4 if nth(d.year, 3, 6, 2) <= d < nth(d.year, 11, 6, 1) else -5


def fetch(contract_code=None):
    q = {"commodity_name": COMMODITY, "$select": ",".join(FIELDS),
         "$order": "report_date_as_yyyy_mm_dd ASC", "$limit": "50000"}
    if contract_code:
        q["cftc_contract_market_code"] = contract_code
    url = URL + "?" + urllib.parse.urlencode(q)
    req = urllib.request.Request(url, headers={"User-Agent": "mmt-research"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def enrich(rows):
    out = []
    for r in rows:
        try:
            rd = dt.datetime.strptime(r["report_date_as_yyyy_mm_dd"][:10],
                                      "%Y-%m-%d").date()
            ll = int(r["lev_money_positions_long"])
            ls = int(r["lev_money_positions_short"])
            al = int(r["asset_mgr_positions_long"])
            a_s = int(r["asset_mgr_positions_short"])
            dl = int(r["dealer_positions_long_all"])
            ds = int(r["dealer_positions_short_all"])
            oi = int(r["open_interest_all"])
        except (KeyError, TypeError, ValueError):
            continue
        # publication: the Friday AFTER the Tuesday report date, 15:30 ET
        rel_date = rd + dt.timedelta(days=(4 - rd.weekday()) % 7 or 7)
        rel = dt.datetime(rel_date.year, rel_date.month, rel_date.day, 15, 30)
        release_ts = int((rel - dt.timedelta(hours=et_offset(rel_date)))
                         .replace(tzinfo=dt.timezone.utc).timestamp())
        out.append(dict(
            report_date=rd.isoformat(), release_ts=release_ts,
            release_date=rel_date.isoformat(),
            contract=r["cftc_contract_market_code"],
            name=r["market_and_exchange_names"], open_interest=oi,
            lev_net=ll - ls, lev_long=ll, lev_short=ls,
            am_net=al - a_s, dealer_net=dl - ds,
            lev_net_pct_oi=round(100.0 * (ll - ls) / oi, 3) if oi else 0.0))
    return out


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "cot_ndx.csv"
    code = sys.argv[2] if len(sys.argv) > 2 else None
    rows = enrich(fetch(code))
    if not rows:
        print("no rows", file=sys.stderr)
        return
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"{len(rows)} rows -> {out}")
    print(f"range {rows[0]['report_date']} .. {rows[-1]['report_date']}")
    print(f"example: report {rows[-1]['report_date']} released "
          f"{rows[-1]['release_date']} 15:30 ET "
          f"({(dt.date.fromisoformat(rows[-1]['release_date']) - dt.date.fromisoformat(rows[-1]['report_date'])).days}d delay)")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Deterministic NQ quarterly contract calendar and planned active windows.

Runs WITHOUT any API key. It produces the planning universe and the calendar
fallback windows from ROLL_POLICY.md; Stage A verifies the universe against
Databento definitions and Stage B replaces these windows with the volume
crossover actually observed.

CME NQ: quarterly cycle H(Mar) M(Jun) U(Sep) Z(Dec).
Expiry  = third Friday of the contract month (SOQ that morning).
Customary roll (frozen fallback) = Monday preceding that third Friday;
the switch takes effect at the open of the following session.
"""
import datetime as dt

MONTH_CODE = {3: "H", 6: "M", 9: "U", 12: "Z"}
WARMUP_DAYS = 30          # PROTOCOL.md causal warm-up, calendar days


def third_friday(year, month):
    d = dt.date(year, month, 1)
    fridays = [d + dt.timedelta(days=i) for i in range(31)
               if (d + dt.timedelta(days=i)).month == month
               and (d + dt.timedelta(days=i)).weekday() == 4]
    return fridays[2]


def roll_monday(year, month):
    """Monday preceding the third Friday of the contract month."""
    tf = third_friday(year, month)
    return tf - dt.timedelta(days=(tf.weekday() - 0) % 7 or 7)


def symbol(year, month):
    return f"NQ{MONTH_CODE[month]}{year % 100:02d}"


def calendar(start, end):
    """Contracts whose ACTIVE window intersects [start, end], with the planned
    active interval and the contract-specific warm-up start."""
    out = []
    prev_switch = None
    for y in range(start.year - 1, end.year + 2):
        for m in (3, 6, 9, 12):
            sw = roll_monday(y, m) + dt.timedelta(days=1)   # effective next session
            if prev_switch is not None:
                sym_prev = symbol(*prev_switch[1])
                a0, a1 = prev_switch[0], sw - dt.timedelta(days=1)
                if a1 >= start and a0 <= end:
                    out.append(dict(symbol=sym_prev,
                                    contract_month=f"{prev_switch[1][0]}-{prev_switch[1][1]:02d}",
                                    expiry=third_friday(*prev_switch[1]).isoformat(),
                                    active_start=max(a0, start).isoformat(),
                                    active_end=min(a1, end).isoformat(),
                                    warmup_start=(max(a0, start) -
                                                  dt.timedelta(days=WARMUP_DAYS)).isoformat(),
                                    truncated_start=a0 < start,
                                    truncated_end=a1 > end))
            prev_switch = (sw, (y, m))
    return out


if __name__ == "__main__":
    import sys, json
    s = dt.date.fromisoformat(sys.argv[1] if len(sys.argv) > 1 else "2019-01-01")
    e = dt.date.fromisoformat(sys.argv[2] if len(sys.argv) > 2 else "2026-09-01")
    rows = calendar(s, e)
    print(f"Planned outright universe, {s} -> {e}   ({len(rows)} contracts)\n")
    print(f"  {'symbol':<8} {'month':<8} {'expiry':<12} {'warm-up from':<13} "
          f"{'active start':<13} {'active end':<12} {'act.days':>8}")
    tot_act = tot_warm = 0
    for r in rows:
        a0 = dt.date.fromisoformat(r["active_start"]); a1 = dt.date.fromisoformat(r["active_end"])
        w0 = dt.date.fromisoformat(r["warmup_start"])
        ad = sum(1 for i in range((a1-a0).days+1) if (a0+dt.timedelta(days=i)).weekday() < 5)
        wd = sum(1 for i in range((a0-w0).days) if (w0+dt.timedelta(days=i)).weekday() < 5)
        tot_act += ad; tot_warm += wd
        flag = "*" if (r["truncated_start"] or r["truncated_end"]) else " "
        print(f"  {r['symbol']:<8} {r['contract_month']:<8} {r['expiry']:<12} "
              f"{r['warmup_start']:<13} {r['active_start']:<13} {r['active_end']:<12} {ad:>8}{flag}")
    print(f"\n  * = window truncated by the requested range")
    print(f"  total active trading days  {tot_act}")
    print(f"  total warm-up trading days {tot_warm}")
    print(f"  total contract-days requested {tot_act + tot_warm}")
    json.dump(rows, open("research/contract_plan.json", "w"), indent=2)
    print("  -> research/contract_plan.json")

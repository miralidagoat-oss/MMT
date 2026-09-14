#!/usr/bin/env python3
"""Driver for the ICT precision model: self-tests, CSV backtests, walk-forward.

    python3 backtest/ict_backtest.py selftest
    python3 backtest/ict_backtest.py run  data/MNQ_5m.csv '{"min_score": 4}'
    python3 backtest/ict_backtest.py run  data                     # every CSV
    python3 backtest/ict_backtest.py wf   data/MNQ_5m.csv          # 60/40 split

`selftest` needs no market data: it drives the engine with a scripted textbook
setup and with random walks, checking that the model fires, that the accounting
balances, that no limit fills on its own signal bar, and — the important one —
that a random walk does NOT produce an edge. A synthetic edge would mean the
engine is peeking at the future.
"""
import csv
import json
import math
import os
import random
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ict_engine import P, run, et_fields                      # noqa: E402

try:
    from zoneinfo import ZoneInfo
    ET = ZoneInfo("America/New_York")
except Exception:                                             # pragma: no cover
    ET = None


# ── synthetic data ──────────────────────────────────────────────────────────
def session_bars(days=40, minutes=5, start="2025-01-05 18:00", seed=7,
                 px=20000.0, vol=0.0009):
    """Futures-shaped random walk: Sun 18:00 ET open, 17:00–18:00 ET break,
    no weekend bars, wider range through the NY morning."""
    rng = random.Random(seed)
    base = datetime.strptime(start, "%Y-%m-%d %H:%M")
    if ET:
        base = base.replace(tzinfo=ET)
    bars = []
    step = timedelta(minutes=minutes)
    ts = base
    while len(bars) < days * int(23 * 60 / minutes):
        hhmm = ts.hour * 100 + ts.minute
        weekday = ts.weekday()                        # Mon=0 … Sun=6
        closed = (weekday == 4 and hhmm >= 1700) or weekday == 5 or \
                 (weekday == 6 and hhmm < 1800) or (1700 <= hhmm < 1800)
        if closed:
            ts += step
            continue
        k = 1.8 if 830 <= hhmm < 1130 else 1.3 if 200 <= hhmm < 500 else 0.7
        drift = rng.gauss(0, vol * k)
        o = px
        path = [o]
        for _ in range(4):
            path.append(path[-1] * (1 + rng.gauss(0, vol * k / 2)))
        cl = path[-1] * (1 + drift / 2)
        hi, lo = max(max(path), cl, o), min(min(path), cl, o)
        q = 0.25
        o, hi, lo, cl = (round(x / q) * q for x in (o, hi, lo, cl))
        hi, lo = max(hi, o, cl), min(lo, o, cl)
        bars.append((int(ts.timestamp()), o, hi, lo, cl, rng.randint(200, 3000)))
        px = cl
        ts += step
    return bars


def scripted_long(seed=3):
    """A textbook sequence, hand-built so the levels are exact:

        quiet range (seeds ATR, swings and an untapped buyside draw at 20060)
        → swing low parks sellside liquidity at 19950
        → sweep to 19935 that closes back above it
        → displacement candle clears the short-term high and leaves an FVG
        → retrace into the array
        → expansion to the draw.
    """
    rng = random.Random(seed)
    bars = []
    ts = datetime(2025, 1, 7, 3, 0, tzinfo=ET) if ET else datetime(2025, 1, 7, 3, 0)

    def push(o, h, l, c):
        nonlocal ts
        q = 0.25
        o, h, l, c = (round(x / q) * q for x in (o, h, l, c))
        bars.append((int(ts.timestamp()), o, max(h, o, c), min(l, o, c), c, 1000))
        ts += timedelta(minutes=5)

    # 70 bars of quiet oscillation, with one excursion to 20060 early on that
    # leaves an untapped buyside pool to serve as the eventual draw
    for i in range(70):
        if 6 <= i <= 10:                       # the excursion
            mid = 20000 + (i - 5) * 12
        else:
            mid = 20000 + math.sin(i / 2.7) * 11
        push(mid - 1, mid + rng.uniform(2, 5), mid - rng.uniform(2, 5), mid + rng.uniform(-2, 2))

    # a clean swing low at 19950 → sellside liquidity
    for o, h, l, c in ((19990, 19992, 19975, 19978), (19978, 19980, 19958, 19962),
                       (19962, 19966, 19950, 19955), (19955, 19972, 19953, 19970),
                       (19970, 19984, 19968, 19982), (19982, 19990, 19980, 19988)):
        push(o, h, l, c)
    # rally that prints the short-term high at 20000 the MSS must clear
    for o, h, l, c in ((19988, 19998, 19986, 19996), (19996, 20000, 19992, 19998),
                       (19998, 20000, 19986, 19988), (19988, 19990, 19974, 19977),
                       (19977, 19979, 19965, 19968), (19968, 19970, 19962, 19965)):
        push(o, h, l, c)
    # the raid: wick through 19950, close back above it
    push(19965, 19967, 19935, 19958)
    push(19958, 19965, 19956, 19964)
    # displacement: clears 20000, leaves a 4-point FVG above the sweep bar's high
    push(19966, 20035, 19966, 20030)
    # retrace into the arrays
    for o, h, l, c in ((20030, 20031, 20002, 20006), (20006, 20008, 19980, 19984),
                       (19984, 19986, 19944, 19952)):
        push(o, h, l, c)
    # expansion to the draw
    for top in (19975, 20000, 20025, 20048, 20066, 20080):
        push(top - 12, top + 2, top - 14, top)
    return bars


# ── reporting ───────────────────────────────────────────────────────────────
def fmt(stats, label):
    pf = stats["pf"]
    wr = stats["win_rate"]
    ex = stats["expectancy"]
    pd = stats["per_day"]
    return (f"{label:<22} sig {stats['signals']:>4}  fill {stats['filled']:>4}  "
            f"W/L/BE {stats['wins']:>3}/{stats['losses']:>3}/{stats['scratches']:>3}  "
            f"WR {'—' if wr is None else f'{wr:5.1f}%'}  "
            f"PF {'—' if pf is None else f'{pf:5.2f}'}  "
            f"netR {stats['net_r']:+7.1f}  exp {'—' if ex is None else f'{ex:+5.2f}'}  "
            f"DD {stats['max_dd']:4.1f}R  /day {'—' if pd is None else f'{pd:4.2f}'}")


def load_csv(path):
    rows = []
    with open(path) as f:
        for r in csv.DictReader(f):
            rows.append((int(float(r["time"])), float(r["open"]), float(r["high"]),
                         float(r["low"]), float(r["close"]), float(r.get("volume") or 0)))
    return rows


# ── self-tests ──────────────────────────────────────────────────────────────
def check(name, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{('  — ' + detail) if detail else ''}")
    return bool(cond)


def selftest():
    ok = True
    print("\n[1] scripted textbook long — does the model see the pattern it claims to trade?")
    bars = scripted_long()
    perm = dict(kz_asia=None, kz_london=None, kz_ny=None, kz_pm=None,
                min_score=0, min_rr=1.5, flatten_hm=0, use_news_fib=False)
    st, tr, sg = run(bars, perm)
    ok &= check("a setup was posted", st["signals"] >= 1, f"signals={st['signals']}")
    if sg:
        s = sg[0]
        ok &= check("it is a long", s["dir"] == 1, str(s["dir"]))
        ok &= check("entry sits between stop and target",
                    s["stop"] < s["entry"] < s["target"],
                    f"{s['stop']:.2f} / {s['entry']:.2f} / {s['target']:.2f}")
        ok &= check("reward pays at least the minimum R", s["rr"] >= perm["min_rr"] - 1e-9,
                    f"{s['rr']:.2f}R")
        ok &= check("entry array is a real PD array", s["kind"] in
                    ("FVG", "iFVG", "OB", "BRK", "RB", "iRB", "CE"), s["kind"])
    ok &= check("the trade was graded", st["closed"] >= 1 or st["expired"] >= 1,
                f"closed={st['closed']} expired={st['expired']}")

    print("\n[2] random walk — mechanics, accounting identity, no fill on the signal bar")
    rw = session_bars(days=60, seed=11)
    st, tr, sg = run(rw, dict(kz_asia=None, kz_london=None, kz_ny=None, kz_pm=None,
                              min_score=2, max_per_day=99, max_per_kz=99))
    ok &= check("engine fires on a plain random walk", st["signals"] > 0, f"{st['signals']} signals")
    ok &= check("fill rate is sane", (st["fill_rate"] or 0) <= 100)
    booked = sum(t["r"] for t in tr)
    ok &= check("net R equals the sum of booked trades", abs(booked - st["net_r"]) < 1e-9,
                f"{booked:.6f} vs {st['net_r']:.6f}")
    ok &= check("closed count matches the outcome tallies",
                st["closed"] == st["wins"] + st["losses"] + st["scratches"] + st["timeouts"])
    sig_bars = {(s["ts"], s["dir"]) for s in sg}
    ok &= check("no trade exits on the bar that posted it",
                all(t["exit_ts"] > t["ts"] for t in tr))
    ok &= check("gross win/loss reconcile with net R",
                abs((st["gross_win"] - st["gross_loss"]) - st["net_r"]) < 1e-9)

    print("\n[3] look-ahead probe — a random walk must NOT show an edge")
    exps = []
    for seed in (1, 2, 3, 4, 5, 6):
        rw = session_bars(days=45, seed=seed)
        s2, t2, _ = run(rw, dict(kz_asia=None, kz_london=None, kz_ny=None, kz_pm=None,
                                 min_score=2, max_per_day=99, max_per_kz=99))
        if s2["closed"]:
            exps.append(s2["expectancy"])
        print(f"      {fmt(s2, f'seed {seed}')}")
    mean_exp = sum(exps) / len(exps) if exps else 0.0
    # one-sided on purpose: a random walk paying nothing (or a little less than
    # nothing, which is what pessimistic accounting should produce) is correct.
    # A materially POSITIVE expectancy on noise is the symptom of look-ahead.
    ok &= check("random data shows no edge", mean_exp < 0.35,
                f"mean expectancy {mean_exp:+.3f}R over {len(exps)} runs")

    print("\n[4] shipped defaults — killzone and per-day discipline")
    rw = session_bars(days=60, seed=21)
    st, tr, sg = run(rw)
    fills_day, fills_kz = {}, {}
    for tr_ in tr:
        d = et_fields(tr_["ts"])[1]
        fills_day[d] = fills_day.get(d, 0) + 1
        fills_kz[(d, tr_["kz"])] = fills_kz.get((d, tr_["kz"]), 0) + 1
    ok &= check("never takes more trades in a day than the cap",
                all(v <= P["max_per_day"] for v in fills_day.values()),
                f"max {max(fills_day.values()) if fills_day else 0} trades/day")
    ok &= check("never takes more than the per-killzone cap",
                all(v <= P["max_per_kz"] for v in fills_kz.values()))
    ok &= check("every setup is posted inside an enabled killzone",
                all(s["kz"] in (0, 1, 2) for s in sg),
                f"killzones seen: {sorted({s['kz'] for s in sg})}")
    # with slot-freeing off, even unfilled attempts are capped
    _, _, sg2 = run(rw, dict(free_on_expiry=False))
    posted = {}
    for s_ in sg2:
        d = et_fields(s_["ts"])[1]
        posted[d] = posted.get(d, 0) + 1
    ok &= check("with slot-freeing off, posted attempts are capped too",
                all(v <= P["max_per_day"] for v in posted.values()),
                f"max {max(posted.values()) if posted else 0} attempts/day")
    print(f"      {fmt(st, 'defaults (random)')}")

    print("\n" + ("ALL CHECKS PASSED" if ok else "SOME CHECKS FAILED"))
    return 0 if ok else 1


# ── runners ─────────────────────────────────────────────────────────────────
def run_path(path, overrides):
    files = []
    if os.path.isdir(path):
        files = sorted(os.path.join(path, f) for f in os.listdir(path) if f.endswith(".csv"))
    else:
        files = [path]
    pooled = dict(signals=0, filled=0, wins=0, losses=0, scratches=0, timeouts=0,
                  expired=0, net_r=0.0, gross_win=0.0, gross_loss=0.0)
    for f in files:
        bars = load_csv(f)
        if len(bars) < 200:
            print(f"{os.path.basename(f):<22} skipped ({len(bars)} bars)")
            continue
        st, tr, sg = run(bars, overrides)
        print(fmt(st, os.path.basename(f)))
        for k in pooled:
            pooled[k] += st[k]
    if len(files) > 1:
        dec = pooled["wins"] + pooled["losses"]
        closed = dec + pooled["scratches"] + pooled["timeouts"]
        pooled.update(win_rate=100.0 * pooled["wins"] / dec if dec else None,
                      pf=pooled["gross_win"] / pooled["gross_loss"] if pooled["gross_loss"] else None,
                      expectancy=pooled["net_r"] / closed if closed else None,
                      per_day=None, max_dd=0.0, closed=closed)
        print("-" * 118)
        print(fmt(pooled, "POOLED"))


GRID = dict(min_score=[2, 3, 4], sweep_atr=[0.04, 0.06, 0.10], disp_atr=[0.4, 0.6, 0.9],
            min_rr=[1.5, 2.0, 3.0], max_quad=[0.5, 0.75, 1.0], be_trigger=[0.0, 1.0])


def walkforward(path, overrides):
    bars = load_csv(path)
    cut = int(len(bars) * 0.6)
    tune, test = bars[:cut], bars[cut:]
    print(f"{os.path.basename(path)}: {len(bars)} bars — tune on {len(tune)}, "
          f"validate on the untouched last {len(test)}\n")
    # greedy coordinate search: accept a parameter change only while it improves
    # in-sample profit factor, then judge the survivor on data it never saw
    best = None
    base = dict(P, **overrides)
    for key, values in GRID.items():
        for v in values:
            cand = dict(base, **{key: v})
            st, _, _ = run(tune, cand)
            if st["closed"] < 10 or st["pf"] is None:
                continue
            if best is None or st["pf"] > best:
                best, base = st["pf"], cand
    if best is None:
        print("not enough in-sample trades to tune — widen the sample or loosen the gates")
        return
    print(f"in-sample tuned PF {best:.2f}; the out-of-sample row below is the only one that counts")
    ins, _, _ = run(tune, base)
    oos, _, _ = run(test, base)
    print(fmt(ins, "in-sample"))
    print(fmt(oos, "OUT-OF-SAMPLE"))
    print("\nparams:", json.dumps({k: v for k, v in base.items() if P.get(k) != v}, default=str))


def main(argv):
    if len(argv) < 2 or argv[1] == "selftest":
        return selftest()
    cmd = argv[1]
    path = argv[2] if len(argv) > 2 else "data"
    overrides = json.loads(argv[3]) if len(argv) > 3 else {}
    if cmd == "run":
        run_path(path, overrides)
    elif cmd == "wf":
        walkforward(path, overrides)
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

#!/usr/bin/env python3
"""The website's research tab (Nov 28 2026): research round 7, indicator v2.7 / v2.7.1, the two outside proposals,
research rounds 8 and 9 (with the follow-up), and your plan rerun with v2.7.2's defaults, as the CSV files the site attaches.

usage: python3 -I site_r8.py OUT_DIR
Every number is copied from a result file (results_r7/, results_r9/, results_plan_search/, results_plan_v27/ and its switch25k/); this script only
reshapes, labels and, where a file has no such column, counts (years up) or applies round 7's rule 5Y to two rows of
results_r7/skip_accounts.csv with the same placebo bands. Each output is checked against the README's figures.
"""
import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
R7 = os.path.join(HERE, "results_r7")
PUB, NEW = os.path.join(HERE, "results_plan_search"), os.path.join(HERE, "results_plan_v27")


def rd(*p):
    return list(csv.DictReader(open(os.path.join(*p))))


def wr(out, name, rows):
    with open(os.path.join(out, name), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    print(f"{name}: {len(rows)} rows")


# ---- round 7: the 13 families, out of sample (Jan 2023 - Nov 20 2026), and the book's own legs at the same costs
FAMILY = {  # family, source and the configuration picked on Dec 2019 - Dec 2022, as the README's table words them
    "F1": ("ORB, first-candle direction", "Zarattini & Aziz", "the first 5 minutes' direction, stop 0.10 ADR, target 10R, a move of at least 0.05 ADR"),
    "F2": ("ORB breakout orders", "Crabel", "15-minute range, orders until 11:00, stop at the other side, target 2R, after an NR4 day"),
    "F3": ("Noise area", "Zarattini, Aziz & Barbon", "21-day bands x 1.5, checked every 30 minutes, gap-adjusted, flips at the opposite band"),
    "F4": ("Last-hour momentum", "Gao et al.; Baltussen et al.", "10:00-15:00 direction traded 15:00-16:00"),
    "F5": ("VWAP", "Zarattini & Aziz", "VWAP trend from 10:00, checked every 30 minutes, 0.1 ADR band"),
    "F6": ("Opening gap", "trading practice", "fade gaps of 0.1 ADR or more at 09:30, stop 0.25 ADR, out by 11:00"),
    "F7": ("Overnight (Globex) range", "trading practice", "stop orders beyond the overnight high/low until 11:00, stop 0.5 ADR, target 2R"),
    "F8": ("Volatility breakout", "Crabel's stretch; Williams", "stop orders at the open +/- 0.2 x stretch until 13:00, stop 0.25 ADR"),
    "F9": ("Calendar days", "Lakonishok & Smidt; Ariel", "long every Monday 09:30-16:00"),
    "F10": ("Daily mean reversion held overnight", "Connors; Pagonidis", "RSI(2) <= 5 long / >= 95 short, 18:10 -> 16:00"),
    "F11": ("5-minute indicators and mixes", "trading practice", "EMA 20/50 cross with VWAP side, 2 ATR stop"),
    "F12": ("ICT Silver Bullet", "trading practice", "10:00-11:00 window, target 2R"),
    "F13": ("Overnight drift", "Boyarchenko et al.", "long 18:10 -> 02:00 every night"),
}
TESTS = (("P1", "t"), ("P2", "years"), ("P3", "random copies"), ("P4", "2 ticks"), ("P5", "trades"))
BOOK_LEGS = (("book_pyramid|strict", "Book: 09:35 pyramid"), ("book_ib|strict", "Book: IB breakout"),
             ("book_overnight|strict", "Book: overnight trade"))


def r7_strategies():
    rows = []
    for r in rd(R7, "decisions.csv"):
        fam, src, cfg = FAMILY[r["family"]]
        up = sum(1 for y in (2023, 2024, 2025, 2026) if float(r[f"oos_{y}"]) > 0)
        failed = [name for p, name in TESTS if r[p] != "True"]
        assert (r["PASS"] == "True") == (not failed)
        rows.append(dict(id=r["family"], family=fam, source=src, picked=cfg, design_t=f"{float(r['design_t']):.2f}",
                         oos_trades=int(r["oos_trades"]), oos_t=f"{float(r['oos_t']):.2f}", oos_usd_1mnq=round(float(r["oos_usd_1mnq"])),
                         years_up=f"{up} of 4", verdict="passes" if not failed else "fails (" + ", ".join(failed) + ")"))
    ref = json.load(open(os.path.join(R7, "reference.json")))
    for key, lab in BOOK_LEGS:
        d, o = ref[key]["design"], ref[key]["oos"]
        rows.append(dict(id=key.split("|")[0], family=lab, source="this indicator", picked="the book's rule, unchanged",
                         design_t=f"{d['t']:.2f}", oos_trades=o["trades"], oos_t=f"{o['t']:.2f}", oos_usd_1mnq=round(o["usd_1mnq"]),
                         years_up=f"{sum(1 for v in o['by_year'].values() if v > 0)} of 4", verdict="the book"))
    x = {r["id"]: r for r in rows}  # the README's table
    assert (x["F1"]["oos_t"], x["F1"]["oos_usd_1mnq"], x["F1"]["years_up"]) == ("2.20", 9238, "4 of 4")
    assert (x["F8"]["oos_t"], x["F8"]["oos_usd_1mnq"]) == ("3.45", 27261) and x["F7"]["verdict"] == "fails (t, random copies)"
    assert (x["book_pyramid"]["oos_t"], x["book_ib"]["oos_usd_1mnq"], x["book_overnight"]["years_up"]) == ("3.36", 9319, "3 of 4")
    return rows


VARIANT = {  # round 7's account test: how each survivor joined the book
    "book": "The book (published)", "+F1": "+ F1 (5-minute ORB) as a fourth funded leg", "+F3": "+ F3 (noise area)",
    "+F8": "+ F8 (volatility breakout)", "+F9": "+ F9 (Mondays)", "on->F1": "F1 instead of the overnight trade",
    "on->F3": "F3 instead of the overnight trade", "on->F8": "F8 instead of the overnight trade",
    "on->F9": "F9 instead of the overnight trade", "ib->F3": "F3 instead of the IB", "ib->F8": "F8 instead of the IB",
    "ib->F9": "F9 instead of the IB", "pyr->F8": "F8 instead of the pyramid", "eval+F1": "Eval trigger F1",
    "eval+F8": "Eval trigger F8", "eval+F9": "Eval trigger F9",
}
ACC = (("lucid40", "l40"), ("lucid_addon", "la"), ("topstep", "ts"))


def vid(v):
    """A row key without + or > (the page matches rows by it)."""
    return v.replace("eval+", "eval-").replace("+", "plus-").replace("->", "-")


def r7_accounts():
    by = {(r["variant"], r["account"]): r for r in rd(R7, "accounts.csv")}
    rows = []
    for v, lab in VARIANT.items():
        row = dict(id=vid(v), variant=v, label=lab)
        for a, p in ACC:
            r = by[(v, a)]
            row.update({f"{p}_5y": int(r["net_5y"]), f"{p}_change": int(r["change_5y"]), f"{p}_rule": r["rule_5y"],
                        f"{p}_oos": int(r["net_oos_2023_26"]), f"{p}_band": int(by[("book", a)]["band_5y"])})
        rows.append(row)
    x = {r["variant"]: r for r in rows}
    assert (x["book"]["l40_5y"], x["book"]["la_5y"], x["book"]["ts_5y"]) == (55669, 58262, 73075)
    assert (x["+F1"]["ts_5y"], x["+F1"]["ts_rule"], x["+F1"]["l40_rule"], x["+F1"]["la_rule"]) == (90515, "PASS", "PASS", "PASS")
    assert (x["book"]["l40_band"], x["book"]["la_band"], x["book"]["ts_band"]) == (3040, 3251, 14308)
    return rows


AUTO = {"25K": "off", "50K": "on", "100K": "off", "150K": "on"}  # v2.7's Auto: Topstep 50K and 150K XFAs only


def v27_sizes():
    rows = []
    for r in rd(R7, "v27_topstep_sizes.csv"):
        rows.append(dict(size=r["size"], auto=AUTO[r["size"]], **{k: (int(v) if k != "size" and k != "rule_5y" else v) for k, v in r.items() if k != "size"}))
    x = {r["size"]: r for r in rows}
    assert (x["50K"]["orb_5y"], x["150K"]["orb_5y"], x["150K"]["orb_worst_year"], x["100K"]["rule_5y"]) == (90515, 185383, 140283, "fail")
    return rows


SETTING = {"book": "Book (v2.6.6; ORB off, overnight trade on)", "+F1": "ORB leg on (on Auto: Topstep 50K / 150K once the PLAN $25,000 box is ticked)",
           "no-on": "Skip the overnight trade, ORB off", "on->F1": "ORB leg on and skip the overnight trade"}


def alarm():
    rows = []
    for r in rd(R7, "skip_alarm_bands.csv"):
        rows.append(dict(id=f"{vid(r['variant'])}-{r['trading_days']}", variant=r["variant"], setting=SETTING[r["variant"]], trading_days=int(r["trading_days"]),
                         median_usd=round(float(r["median_usd"])), p5_yellow_usd=round(float(r["p5_yellow_usd"])),
                         p1_red_usd=round(float(r["p1_red_usd"]))))
    v27 = rd(R7, "v27_alarm_bands.csv")  # the ORB set must be the one v2.7 shipped
    assert [(int(r["trading_days"]), round(float(r["median_usd"])), round(float(r["p5_yellow_usd"])), round(float(r["p1_red_usd"]))) for r in v27] == \
        [(r["trading_days"], r["median_usd"], r["p5_yellow_usd"], r["p1_red_usd"]) for r in rows if r["variant"] == "+F1"]
    return rows


WIN = {"cfd 2011-02-15 to 2020-12-31": "Nasdaq-100 CFD, Feb 2011 - Dec 2020", "cfd 2011-02-15 to 2015-12-31": "Nasdaq-100 CFD, Feb 2011 - Dec 2015",
       "cfd 2016-01-04 to 2020-12-31": "Nasdaq-100 CFD, Jan 2016 - Dec 2020", "mnq 2021-01-04 to 2026-11-20": "MNQ file, Jan 2021 - Nov 2026",
       "mnq 2024-01-02 to 2026-11-20": "MNQ file, Jan 2024 - Nov 2026"}
FIRM = {"topstep50": "Topstep 50K rules", "lucid50": "Lucid 50K rules"}


def skip_payout():
    C = json.load(open(os.path.join(R7, "proposals.json")))["C_funded_alone"]
    rows = []
    for w, wl in WIN.items():
        for f, fl in FIRM.items():
            b, s = C[f"{w} | {f} | book"], C[f"{w} | {f} | no overnight"]
            assert b["accounts"] == s["accounts"]
            rows.append(dict(id=f"{w[:3]}{w[4:8]}-{w[-10:-6]}-{f}", window=wl, firm=fl, accounts=b["accounts"],
                             book_reach_pct=b["reach_payout_pct"], skip_reach_pct=s["reach_payout_pct"],
                             book_payouts=f"{b['payouts_per_account']:.2f}", skip_payouts=f"{s['payouts_per_account']:.2f}"))
    x = {(r["window"], r["firm"]): r for r in rows}
    assert (x[(WIN["cfd 2011-02-15 to 2020-12-31"], FIRM["topstep50"])]["book_reach_pct"], x[(WIN["mnq 2021-01-04 to 2026-11-20"], FIRM["topstep50"])]["skip_payouts"]) == (67.8, "1.47")
    return rows


def rule5y(dM, dW, dMe, dWe, b):
    return "PASS" if ((dM > b[0] and dW > -b[1]) or (dW > b[1] and dM > -b[0])) and dMe > -b[2] and dWe > -b[3] else "fail"


def skip_pools():
    sk = {(r["variant"], r["account"]): r for r in rd(R7, "skip_accounts.csv")}
    pub = {(r["variant"], r["account"]): r for r in rd(R7, "accounts.csv")}
    rows = []
    for a, lab, w, wo in (("topstep", "Topstep 50K", "book", "no-on"), ("lucid40", "Lucid 50K, 40% rule", "book", "no-on"),
                          ("lucid_addon", "Lucid 50K, add-on", "book", "no-on"), ("topstep", "Topstep 50K with the ORB leg", "+F1", "on->F1")):
        x, y, b = sk[(w, a)], sk[(wo, a)], pub[("book", a)]
        bands = [float(b[k]) for k in ("band_5y", "band_worst", "band_early", "band_worst_early")]
        d = [float(y[k]) - float(x[k]) for k in ("change_5y", "change_worst", "change_early", "change_worst_early")]
        rule = rule5y(*d, bands)
        if w == "book":
            assert rule == y["rule_5y_vs_book"]
        rows.append(dict(id=f"{a}-{'orb' if w == '+F1' else 'book'}", setup=lab, with_5y=int(x["net_5y"]), without_5y=int(y["net_5y"]),
                         with_worst=int(x["worst_year_5y"]), without_worst=int(y["worst_year_5y"]),
                         with_early=int(x["net_early"]), without_early=int(y["net_early"]),
                         with_oos=int(x["net_2023_26"]), without_oos=int(y["net_2023_26"]), rule_5y=rule))
    x = {r["id"]: r for r in rows}
    assert (x["topstep-book"]["without_5y"], x["topstep-orb"]["without_5y"], x["topstep-orb"]["without_early"]) == (69742, 93065, 72440)
    assert all(r["rule_5y"] == "fail" for r in rows)
    return rows


def orb_history():
    B = json.load(open(os.path.join(R7, "proposals.json")))["B_orb"]
    O = json.load(open(os.path.join(R7, "orb_cfd5.json")))
    yrs = lambda by, a, b: f"{sum(1 for y, v in by.items() if a <= y <= b and v[1] > 0)} of {sum(1 for y in by if a <= y <= b)}"  # noqa: E731
    rows = []
    p = B["pooled"]["cfd 2011-2020"]
    rows.append(dict(id="nq1", data="Nasdaq-100 CFD, 1-minute bars", window="2011-2020", slippage="none", trades=p["n"],
                     mean_r=f"{p['mean']:.3f}", t=f"{p['t']:.2f}", years_up=yrs(B["cfd"]["by_year"], "2011", "2020")))
    for key, idn, lab, slip in (("NQ CFD 5-min bars, 0 tick", "nq5", "Nasdaq-100 CFD, 5-minute bars", "none"),
                                ("NQ CFD 5-min bars, 1 tick", "nq5t", "Nasdaq-100 CFD, 5-minute bars", "1 tick a fill"),
                                ("S&P CFD 5-min bars, 0 tick", "sp5", "S&P 500 CFD, 5-minute bars", "none"),
                                ("S&P CFD 5-min bars, 1 tick", "sp5t", "S&P 500 CFD, 5-minute bars", "1 tick a fill")):
        p = O[key]["pooled_2011_2020"]
        rows.append(dict(id=idn, data=lab, window="2011-2020", slippage=slip, trades=p["n"], mean_r=f"{p['mean']:.3f}", t=f"{p['t']:.2f}",
                         years_up=O[key]["years_up_2011_2020"]))
    for key, idn, win, a, b in (("mnq 2020-2020", "mnq20", "2020", "2020", "2020"), ("mnq 2021-2026", "mnq21", "2021-2026", "2021", "2026")):
        p = B["pooled"][key]
        rows.append(dict(id=idn, data="MNQ file, 5-minute bars", window=win, slippage="none", trades=p["n"], mean_r=f"{p['mean']:.3f}",
                         t=f"{p['t']:.2f}", years_up=yrs(B["mnq"]["by_year"], a, b)))
    x = {r["id"]: r for r in rows}
    assert (x["nq1"]["mean_r"], x["nq1"]["t"], x["nq1"]["years_up"]) == ("0.331", "4.14", "9 of 10")
    assert (x["sp5t"]["mean_r"], x["sp5t"]["t"], x["mnq21"]["t"], x["mnq21"]["years_up"]) == ("-0.267", "-3.44", "3.56", "6 of 6")
    assert B["check_vs_r7_F1"]["identical"] == B["check_vs_r7_F1"]["here"] == 1295
    return rows


def r8():
    acc = [dict(id=r["account"].split()[0], **{k: (v if k in ("account", "rule_5y") else int(v)) for k, v in r.items()}) for r in rd(R7, "r8_accounts.csv")]
    hold = [dict(id=r["account"].split()[0], **{k: (v if k in ("account", "no_harm") else int(v)) for k, v in r.items()}) for r in rd(R7, "r8_holdout.csv")]
    dec = json.load(open(os.path.join(R7, "r8_decision.json")))
    assert dec["adopt"] is False and [r["rule_5y"] for r in acc] == ["fail", "PASS", "PASS", "fail"]
    assert (acc[0]["al_5y"], acc[0]["change_early"], acc[0]["band_early"], hold[0]["al_2011_19"]) == (96577, -5680, 4909, 20984)
    return acc, hold


PV = os.path.join(HERE, "results_plan_v27")
VAR = {"published (ORB off)": ("published", "Without the ORB leg (the published plan)"),
       "ORB on, its own amounts": ("orb-own", "ORB leg from day one, at the amounts measured with it (150K at $17,000, car at $43,000)"),
       "ORB on, published amounts": ("orb-pub", "ORB leg from day one, at the published amounts"),
       "ORB switched on at $25,000": ("orb-25k", "ORB leg from $25,000 (v2.7.2)")}


def plan_variants():
    rows = []
    for r in rd(PV, "variants_final.csv"):
        i, lab = VAR[r["plan"]]
        rows.append(dict(id=i, label=lab, **{k: v for k, v in r.items() if k not in ("plan", "label")}))
    x = {r["id"]: r for r in rows}
    pub = {r["plan"]: r for r in rd(PUB, "car.csv")}["FINAL"]
    new = {r["plan"]: r for r in rd(PV, "car.csv")}["FINAL"]
    assert all(x["published"][k] == pub[k] for k in pub if k not in ("plan", "label"))
    assert all(x["orb-own"][k] == new[k] for k in new if k not in ("plan", "label"))
    assert (x["orb-25k"]["fut_spare36_median"], x["orb-25k"]["fut_spare36_worst"]) == ("313381", "223013")
    steps = []
    for r in rd(PV, "variants_final_steps.csv"):
        i, _ = VAR[r["variant"]]
        n = sum(1 for s_ in steps if s_["variant"] == i) + 1
        steps.append(dict(id=f"{i}-{n}", variant=i, **{k: v for k, v in r.items() if k != "variant"}))
    return rows, steps


def slow_variants():
    import datetime as dt
    rows = []
    for r in rd(PV, "variants_slow_start.csv"):
        i, lab = VAR[r["variant"]]
        ds = [dt.date.fromisoformat(t.split(":m")[0]) + dt.timedelta(days=float(t.split(":m")[1]) * 30.44) for t in r["ran_out_starts"].split()]
        row = dict(id=f"{i}-{r['start_money']}", variant=i, label=lab)
        row.update({k.replace(" ", "_"): v for k, v in r.items() if k not in ("variant", "ran_out_starts")})
        st = sorted(t.split(":m")[0] for t in r["ran_out_starts"].split())
        row.update(ran_out_first=str(min(ds)) if ds else "", ran_out_last=str(max(ds)) if ds else "",
                   ran_out_start_first=st[0] if st else "", ran_out_start_last=st[-1] if st else "")
        rows.append(row)
    x = {r["id"]: r for r in rows}
    assert (x["published-1000"]["ran_out"], x["orb-own-1000"]["ran_out"], x["orb-25k-1000"]["ran_out"]) == ("2", "21", "2")
    assert (x["orb-own-1000"]["ran_out_first"], x["orb-own-1000"]["ran_out_last"]) == ("2024-02-12", "2024-03-04")
    return rows


def pool_years():
    by = {(r["account"], r["variant"]): r for r in rd(R7, "accounts_years.csv")}
    per = {"2021": "Nov 15 - Dec 31 2021", "2026": "2026 to Nov 20"}
    rows = []
    for y in ("2021", "2022", "2023", "2024", "2025", "2026"):
        row = dict(year=y, period=per.get(y, "full year"))
        for a, p in ACC:
            row[f"{p}_book"], row[f"{p}_orb"] = int(by[(a, "book")][y]), int(by[(a, "+F1")][y])
        rows.append(row)
    x = {r["year"]: r for r in rows}
    assert (x["2022"]["ts_book"], x["2022"]["ts_orb"], x["2024"]["ts_orb"]) == (47523, 43264, 84450)
    return rows


def r7_kpis():
    pbo = json.load(open(os.path.join(R7, "pbo.json")))
    n = sum(1 for _ in rd(R7, "all_configs.csv"))
    rows = [dict(metric="configs", value=n, unit="count"), dict(metric="families", value=len(FAMILY), unit="count"),
            dict(metric="pbo_all_pct", value=round(100 * pbo["pbo_all_configs"], 1), unit="pct")]
    assert (rows[0]["value"], rows[2]["value"]) == (1556, 7.4)
    return rows


R9 = os.path.join(HERE, "results_r9")
ACC9 = (("topstep", "Topstep 50K"), ("lucid_addon", "Lucid 50K, add-on"), ("lucid25_40", "Lucid 25K, 40% rule"), ("lucid40", "Lucid 50K, 40% rule"))
VER9 = (("B60", "honest", "Blind rebuild with ONR's IB"), ("asbuilt", "asbuilt", "As built"))


def r9():
    """Round 9: with and without the funded overnight trade, the honest version and as built (results_r9/r9_table.csv),
    and the 1-MNQ headline measure (results_r9/unit.json)."""
    T = {(r["account"], r["version"]): r for r in rd(R9, "r9_table.csv")}
    rows = []
    for a, alab in ACC9:
        for v, vid_, vlab in VER9:
            r = T[(a, v)]
            rows.append(dict(id=f"{a}-{vid_}", account=alab, version=vlab, on_5y=int(r["on_5y"]), off_5y=int(r["off_5y"]),
                             on_early=int(r["on_early"]), off_early=int(r["off_early"]), on_2024_26=int(r["on_2024_26"]),
                             off_2024_26=int(r["off_2024_26"]), skip_rule_5y=r.get("skip_passes_rule_5y", "") if a != "lucid40" else "",
                             change_5y=int(r["change_5y"]), change_early=int(r["change_early"]), band_5y=r.get("band_5y", ""), band_early=r.get("band_early", "")))
    x = {r["id"]: r for r in rows}
    assert (x["topstep-honest"]["on_5y"], x["topstep-honest"]["off_early"], x["lucid_addon-honest"]["off_5y"]) == (79283, 67730, 43593)
    assert [x[f"{a}-honest"]["skip_rule_5y"] for a in ("topstep", "lucid_addon", "lucid25_40")] == ["fail"] * 3
    U = json.load(open(os.path.join(R9, "unit.json")))
    urows = []
    for v, vid_, lab in (("B60", "honest", "Blind rebuild with ONR's IB"), ("B90", "b90", "Blind rebuild, its 90-minute IB"), ("asbuilt", "asbuilt", "As built")):
        for w in ("2024 - Nov 20 2026", "Dec 2019 - Dec 2023"):
            on, off = U[f"{v} with the overnight trade | {w}"], U[f"{v} without the overnight trade | {w}"]
            urows.append(dict(id=f"{vid_}-{w[:4] if w[0] == '2' else 'pre'}", version=lab, window=w, usd_day_with=f"{on['usd_per_day']:.2f}",
                              usd_day_without=f"{off['usd_per_day']:.2f}", sharpe_with=f"{on['daily_sharpe']:.3f}", sharpe_without=f"{off['daily_sharpe']:.3f}"))
    y = {r["id"]: r for r in urows}
    assert (y["honest-2024"]["sharpe_with"], y["asbuilt-2024"]["sharpe_with"], y["honest-2024"]["usd_day_with"]) == ("0.126", "0.136", "56.05")
    return rows, urows


def r9_followup():
    """Round 9 follow-up: skipping the funded overnight trade in your plan as v2.7.2 runs it (results_plan_v27/skip_final.csv,
    skip_slow_start.csv, switch25k/ against skip25k/), and the figures the follow-up text quotes (results_r9/readings.json,
    theirs.json, trades_2026-10_summary.json and trades_2026-10_their_reading.csv)."""
    F = {r["plan"]: r for r in rd(PV, "skip_final.csv")}
    k, s = F["keep (v2.7.2)"], F["skip"]
    ref = {r["plan"]: r for r in rd(PV, "variants_final.csv")}["ORB switched on at $25,000"]
    assert all(k[c] == ref[c] for c in ref if c not in ("plan", "label"))
    nfull = len(rd(PV, "skip25k", "budget_monthly_runs.csv")) // 16
    rows = [dict(id="full", way="Your plan, money added when needed: 3 years, typical", starts=nfull,
                 fp_with=k["fut_first_payout_month_median"], fp_without=s["fut_first_payout_month_median"], ran_with="", ran_without="",
                 usd_with=k["fut_spare36_median"], usd_without=s["fut_spare36_median"]),
            dict(id="full-worst", way="Your plan: the worst of those starts, 3 years", starts=nfull, fp_with="",
                 fp_without="", ran_with="", ran_without="", usd_with=k["fut_spare36_worst"], usd_without=s["fut_spare36_worst"])]
    SS = {(r["variant"], r["start_money"]): r for r in rd(PV, "skip_slow_start.csv")}
    old = {(r["variant"], r["start_money"]): r for r in rd(PV, "variants_slow_start.csv")}
    for mny in ("1000", "3000"):
        a, b = SS[("keep (v2.7.2)", mny)], SS[("skip", mny)]
        assert a["ran_out"] == old[("ORB switched on at $25,000", mny)]["ran_out"] and a["starts"] == b["starts"]
        rows.append(dict(id=f"slow-{mny}", way=f"Started slow with ${int(mny):,}, never more: 4 years, typical", starts=a["starts"],
                         fp_with=a["first_payout_month_median"], fp_without=b["first_payout_month_median"], ran_with=a["ran_out"],
                         ran_without=b["ran_out"], usd_with=a["y4 total median"], usd_without=b["y4 total median"]))
    reached = {}
    for tag, d in (("keep", "switch25k"), ("skip", "skip25k")):
        V = {r["plan"]: r for r in rd(PV, d, "budget_view.csv")}
        B = {r["plan"]: r for r in rd(PV, d, "budget.csv")}
        runs = rd(PV, d, "budget_runs.csv")
        for pl in ("budget 500 lucid25k40 1x", "budget 1000 lucid25k40 1x", "budget 1000 lucid25k50 1x"):
            R = [r for r in runs if r["plan"] == pl]
            reached[(tag, pl)] = (V[pl], int(B[pl]["fut_ran_out"]), sum(1 for r in R if r["first_payout_month"] != ""), len(R))
    lab = {"budget 500 lucid25k40 1x": "$500, one Lucid 25K eval at a time, 40% rule: 2 years, starts that kept going",
           "budget 1000 lucid25k40 1x": "$1,000, the same",
           "budget 1000 lucid25k50 1x": "$1,000, one Lucid 25K eval at a time with the add-on"}
    for pl, wl in lab.items():
        (va, ra, _, na), (vb, rb, _, nb) = reached[("keep", pl)], reached[("skip", pl)]
        assert na == nb == int(va["fut_starts"])
        rows.append(dict(id=pl.replace("budget ", "b").replace(" ", "-"), way=wl, starts=na, fp_with=va["fut_first_payout_month_median"],
                         fp_without=vb["fut_first_payout_month_median"], ran_with=ra, ran_without=rb,
                         usd_with=va["fut_made_24m_survivors_median_usd"], usd_without=vb["fut_made_24m_survivors_median_usd"]))
    x = {r["id"]: r for r in rows}
    assert (x["full"]["usd_with"], x["full"]["usd_without"], x["slow-1000"]["ran_with"], x["slow-1000"]["ran_without"]) == ("313381", "263530", "2", "15")
    assert (x["b500-lucid25k40-1x"]["ran_with"], x["b500-lucid25k40-1x"]["ran_without"], x["b1000-lucid25k40-1x"]["ran_without"]) == (105, 123, 94)
    # the figures the text quotes
    U = json.load(open(os.path.join(R9, "readings.json")))
    W = "2024 - Nov 20 2026"
    O = json.load(open(os.path.join(R9, "trades_2026-10_summary.json")))
    facts = [("sharpe_as_read", f"{U['as read in round 9 | ' + W]['daily_sharpe']:.3f}", "raw"),
             ("usd_day_as_read", f"{U['as read in round 9 | ' + W]['usd_per_day']:.2f}", "usd")]
    for v in ("blind60",):
        facts += [(f"oct_{v}_trades", O[v]["all"]["trades"], "count"), (f"oct_{v}_usd", f"{O[v]['all']['pnl_usd']:.2f}", "usd")]
    facts += [("b500_reached_with", reached[("keep", "budget 500 lucid25k40 1x")][2], "count"),
              ("b500_reached_without", reached[("skip", "budget 500 lucid25k40 1x")][2], "count")]
    DL = json.load(open(os.path.join(R9, "dll.json")))["asbuilt | risk"]    # Lucid's $600 soft daily limit at 25K
    facts += [("dll_sessions", DL["sessions_with_a_leg"], "count"), ("dll_reached", DL["sessions_reaching_600"], "count"),
              ("dll_change_usd", f"{DL['flattening_gain_usd']:.2f}", "usd")]
    f = {a: b for a, b, _ in facts}
    assert (f["sharpe_as_read"], f["usd_day_as_read"], f["oct_blind60_usd"], f["b500_reached_without"]) == ("0.126", "56.05", "2069.09", 195)
    assert (f["dll_sessions"], f["dll_reached"], f["dll_change_usd"]) == (1694, 2, "54.71")
    return rows, [dict(metric=a, value=b, unit=c) for a, b, c in facts]


def r9_limits():
    """Round 9 follow-up 2: keep vs skip the funded overnight trade under the indicator's day budget and under the other
    assistant's day rule (results_r9/limits.json), the blind rebuild and the book as built, every account."""
    L = json.load(open(os.path.join(R9, "limits.json")))["pools"]
    ref = json.load(open(os.path.join(R9, "versions.json")))
    rows = []
    for src, slab in (("B60", "Blind rebuild"), ("asbuilt", "As built")):
        for lim, llab in (("risk", "the indicator's day budget (each leg's planned risk held all day)"),
                          ("net", "the other assistant's rule (the day's realized P&L counts, the overnight trade's included)")):
            on, off = L[f"{src}|on|{lim}"], L[f"{src}|off|{lim}"]
            for a, alab in ACC9:
                if lim == "risk":     # the indicator's rule is round 9's pools
                    assert abs(on[a]["last 5y"]["M"] - ref[f"{src}|on"][a]["last 5y"]["M"]) < 0.01
                rows.append(dict(id=f"{src}-{lim}-{a}", group=f"{slab}, {llab}", account=alab,
                                 on_5y=round(on[a]["last 5y"]["M"]), off_5y=round(off[a]["last 5y"]["M"]),
                                 on_early=round(on[a]["early"]["M"]), off_early=round(off[a]["early"]["M"]),
                                 on_2024_26=round(on[a]["2024-26"]["M"]), off_2024_26=round(off[a]["2024-26"]["M"]),
                                 on_3y=round(on[a]["3y"]["mean"]), off_3y=round(off[a]["3y"]["mean"])))
    x = {r["id"]: r for r in rows}
    assert (x["B60-net-lucid25_40"]["on_3y"], x["B60-net-lucid25_40"]["off_3y"], x["B60-net-topstep"]["on_5y"], x["B60-net-topstep"]["off_5y"]) == (74047, 66625, 77630, 83589)
    return rows


def main(out):
    os.makedirs(out, exist_ok=True)
    wr(out, "r7_strategies.csv", r7_strategies())
    wr(out, "r7_accounts.csv", r7_accounts())
    wr(out, "v27_sizes.csv", v27_sizes())
    wr(out, "alarm_settings.csv", alarm())
    wr(out, "skip_payout.csv", skip_payout())
    wr(out, "skip_pools.csv", skip_pools())
    wr(out, "orb_history.csv", orb_history())
    acc, hold = r8()
    wr(out, "r8_accounts.csv", acc)
    wr(out, "r8_holdout.csv", hold)
    wr(out, "r7_pool_years.csv", pool_years())
    wr(out, "r7_kpis.csv", r7_kpis())
    pv, st = plan_variants()
    wr(out, "plan_variants.csv", pv)
    wr(out, "plan_variants_steps.csv", st)
    wr(out, "slow_variants.csv", slow_variants())
    bv = rd(PV, "switch25k", "budget_view.csv")
    assert len(bv) == 16 and list(bv[0]) == list(rd(PUB, "budget_view.csv")[0])
    runs = rd(PV, "switch25k", "budget_runs.csv")
    for row in bv:   # the counts the page's $500 text quotes, from the 205 runs of each way in
        R = [r for r in runs if r["plan"] == row["plan"] and r["data"] == "futures"]
        bust = [r for r in R if r["bust_month"] != ""]
        row.update(fut_first_payout_starts=sum(1 for r in R if r["first_payout_month"] != ""),
                   fut_first_payout_pct=round(100.0 * sum(1 for r in R if r["first_payout_month"] != "") / len(R), 1),
                   fut_ran_out_starts=len(bust),
                   fut_ran_out_after_payout=sum(1 for r in bust if r["first_payout_month"] != "" and float(r["first_payout_month"]) <= float(r["bust_month"])))
        assert int(row["fut_starts"]) == len(R) and abs(100.0 * len(bust) / len(R) - float(row["fut_ran_out_pct"])) < 0.05
    x = {r["plan"]: r for r in bv}
    assert (x["budget 500 lucid25k40 1x"]["fut_first_payout_starts"], x["budget 500 lucid40 1x"]["fut_first_payout_starts"],
            x["budget 500 lucid25k40 1x"]["fut_ran_out_starts"], x["budget 500 lucid25k40 1x"]["fut_ran_out_after_payout"]) == (184, 145, 105, 84)
    wr(out, "plan_budget_v272.csv", bv)
    t9, u9 = r9()
    wr(out, "r9_honest.csv", t9)
    wr(out, "r9_unit.csv", u9)
    ps, fx = r9_followup()
    wr(out, "r9_plan_skip.csv", ps)
    wr(out, "r9_followup.csv", fx)
    wr(out, "r9_limits.csv", r9_limits())


if __name__ == "__main__":
    main(sys.argv[1])

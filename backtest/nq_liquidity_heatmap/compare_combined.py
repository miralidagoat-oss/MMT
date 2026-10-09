#!/usr/bin/env python3
"""Check indicators/nq_liquidity_heatmap_terminus.pine against the two standalone
scripts, run by verify_combined.sh in PineTS on the same data:

  both_<tag>  combined, both parts on      hm_<tag>  heatmap alone
  nohm_<tag>  combined, heatmap off        tm_<tag>  TERMINUS alone
  notm_<tag>  combined, TERMINUS off

  compare_combined.py OUT_DIR TAG [TAG ...]     (exit 1 on any mismatch)
"""
import json, sys, math
from collections import Counter
O = sys.argv[1]; tags = sys.argv[2:]
HM_PLOTS = ["Nearest BSL", "Nearest SSL", "Biggest BSL", "Biggest SSL", "Biggest BSL weight",
            "Biggest SSL weight", "Resting BSL pools", "Resting SSL pools"]
TM_PLOTS = ["Terminus high", "Terminus low"]
def load(n): return json.load(open(f"{O}/{n}.json"))
def series(d, k):
    na = lambda v: v is None or (isinstance(v, float) and math.isnan(v))
    return [(x["time"], None if na(x["value"]) else x["value"]) for x in d["plots"][k]]
def draw(d, kind):
    v = d["plots"].get(f"__{kind}__", [])
    items = v[-1]["value"] if v else []
    return Counter(json.dumps({k: x for k, x in it.items() if k != "id"}, sort_keys=True) for it in items if not it.get("_deleted"))
def alerts(d, pred):
    return Counter(json.dumps({k: a.get(k) for k in ("type", "title", "message", "bar_index", "time")}, sort_keys=True) for a in d["alerts"] if pred(a))
is_hm = lambda a: (a.get("title") or "").startswith("NQ liquidity") or (a.get("message") or "").startswith("NQ ETH Liquidity")
is_tm = lambda a: not is_hm(a)
bad = 0
def check(name, ok, detail=""):
    global bad
    print(f"  {'OK  ' if ok else 'FAIL'} {name} {detail}")
    bad += not ok
for t in tags:
    both, nohm, notm, hm, tm = (load(f"{p}_{t}") for p in ("both", "nohm", "notm", "hm", "tm"))
    print(f"== {t}  (bars={len(series(hm, HM_PLOTS[0]))}, hm alerts={sum(alerts(hm, is_hm).values())}, tm alerts={sum(alerts(tm, is_tm).values())})")
    for k in HM_PLOTS:
        check(f"heatmap plot '{k}' both==alone", series(both, k) == series(hm, k))
        check(f"heatmap plot '{k}' TERMINUS-off==alone", series(notm, k) == series(hm, k))
        empty = (0,) if k.startswith("Resting") else (None,)   # pool counts read 0, prices na
        check(f"heatmap plot '{k}' empty when heatmap off", all(v in empty for _, v in series(nohm, k)))
    for k in TM_PLOTS:
        check(f"TERMINUS plot '{k}' both==alone", series(both, k) == series(tm, k))
        check(f"TERMINUS plot '{k}' heatmap-off==alone", series(nohm, k) == series(tm, k))
        check(f"TERMINUS plot '{k}' all na when TERMINUS off", all(v is None for _, v in series(notm, k)))
    check("heatmap alerts both==alone", alerts(both, is_hm) == alerts(hm, is_hm))
    check("heatmap alerts TERMINUS-off==alone", alerts(notm, is_hm) == alerts(hm, is_hm))
    check("no heatmap alerts when heatmap off", not alerts(nohm, is_hm))
    check("TERMINUS alerts both==alone", alerts(both, is_tm) == alerts(tm, is_tm))
    check("TERMINUS alerts heatmap-off==alone", alerts(nohm, is_tm) == alerts(tm, is_tm))
    check("no TERMINUS alerts when TERMINUS off", not alerts(notm, is_tm))
    for kind in ("labels", "boxes"):
        check(f"{kind}: both == heatmap ∪ TERMINUS", draw(both, kind) == draw(hm, kind) + draw(tm, kind),
              f"({sum(draw(both, kind).values())} = {sum(draw(hm, kind).values())} + {sum(draw(tm, kind).values())})")
        check(f"{kind}: heatmap-off == TERMINUS alone", draw(nohm, kind) == draw(tm, kind))
        check(f"{kind}: TERMINUS-off == heatmap alone", draw(notm, kind) == draw(hm, kind))
    check("lines: heatmap-off == TERMINUS alone", draw(nohm, "lines") == draw(tm, "lines"))
    check("lines: TERMINUS-off == heatmap alone", draw(notm, "lines") == draw(hm, "lines"))
    bl, hl, tl = draw(both, "lines"), draw(hm, "lines"), draw(tm, "lines")
    hm_in_both = bl - tl
    check("lines: TERMINUS lines all present in both", not (tl - bl))
    check("lines: heatmap lines in both ⊆ heatmap alone", not (hm_in_both - hl),
          f"(both: {sum(hm_in_both.values())} heatmap + {sum(tl.values())} TERMINUS = {sum(bl.values())} ≤ 480; alone: {sum(hl.values())})")
    check("lines: total ≤ 480", sum(bl.values()) <= 480)
print("ALL MATCH" if not bad else f"{bad} FAILURES"); sys.exit(1 if bad else 0)

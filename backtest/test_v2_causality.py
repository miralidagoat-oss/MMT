#!/usr/bin/env python3
"""V2 causality and availability tests. Run before any V2 outcome exists."""
import datetime as dt, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, v2_events as V

FAILS=[]
def ok(c,m):
    print(("  PASS  " if c else "  FAIL  ")+m)
    if not c: FAILS.append(m)

# ── 1. sweep definition ────────────────────────────────────────────────────
print("1. Sweep definition (one full tick required; equality is NOT a sweep)")
L=20000.00
ok(V.is_sweep(1, L, 20005, L-0.25), "sell-side: low exactly one tick below IS a sweep")
ok(not V.is_sweep(1, L, 20005, L), "sell-side: low EXACTLY equal is NOT a sweep")
ok(not V.is_sweep(1, L, 20005, L-0.24), "sell-side: less than one tick is NOT a sweep")
ok(V.is_sweep(-1, L, L+0.25, 19995), "buy-side: high exactly one tick above IS a sweep")
ok(not V.is_sweep(-1, L, L, 19995), "buy-side: high EXACTLY equal is NOT a sweep")
ok(V.penetration_pts(1, L, 20005, L-1.5)==1.5, "penetration measured level->low")
ok(V.is_gapped(1, L, L-0.5, L-2.0), "a bar entirely below the level is flagged gapped")
ok(not V.is_gapped(1, L, L+1, L-2.0), "a bar straddling the level is not gapped")

# ── 2. episode state machine ───────────────────────────────────────────────
print("\n2. Episode state machine (window from START, no chaining)")
t=V.EpisodeTracker(); T0=1_700_000_000; ATR=10.0
a=t.assign(1,T0,       L, ATR,"lvl1","e1")
b=t.assign(1,T0+50*60, L, ATR,"lvl1","e2")   # 50 min from start -> joins
c=t.assign(1,T0+100*60,L, ATR,"lvl1","e3")   # 100 min from START -> new
ok(a["episode_id"]==b["episode_id"], "event at +50min joins the open episode")
ok(c["episode_id"]!=a["episode_id"],
   "event at +100min starts a NEW episode - 50min from B does not chain it in")
ok(a["n_events"]==2, "the first episode holds exactly 2 events")

t2=V.EpisodeTracker()
x=t2.assign(1,T0,L,ATR,"lvlA","e1")
y=t2.assign(1,T0+60,L+0.5*ATR,ATR,"lvlB","e2")     # exactly 0.5 ATR -> joins
z=t2.assign(1,T0+120,L+0.5*ATR+0.01,ATR,"lvlC","e3")  # beyond -> new
ok(x["episode_id"]==y["episode_id"], "level exactly 0.5 ATR away joins")
ok(z["episode_id"]!=x["episode_id"], "level beyond 0.5 ATR starts a new episode")
ok(y["level_ids"]==["lvlA","lvlB"],
   "nested levels are PRESERVED, not discarded on collapse")

t3=V.EpisodeTracker()
p=t3.assign(1,T0,L,ATR,"l","e1"); q=t3.assign(-1,T0+60,L,ATR,"l","e2")
ok(p["episode_id"]!=q["episode_id"], "opposite direction always opens a new episode")

# frozen ATR: a later volatility change must not alter clustering
t4=V.EpisodeTracker()
m=t4.assign(1,T0,L,ATR,"l","e1")
n=t4.assign(1,T0+60,L+4.9,999.0,"l","e2")   # huge later ATR passed in
ok(m["episode_id"]==n["episode_id"],
   "threshold uses ATR AT EPISODE START, not the value passed later")
t5=V.EpisodeTracker()
u=t5.assign(1,T0,L,ATR,"l","e1")
w=t5.assign(1,T0+60,L+5.1,999.0,"l","e2")
ok(u["episode_id"]!=w["episode_id"],
   "and a level beyond 0.5*start-ATR still splits despite a large later ATR")

# ── 3. THE REQUIRED LEAKAGE TEST ───────────────────────────────────────────
print("\n3. A reclaim occurring AFTER confirmation cannot enter the event row")
CONF = T0 + 300                      # event confirmation = sweep bar close
reclaim_ts = CONF + 900              # reclaim happens 15 minutes LATER
row = {"penetration_atr": 0.41, "close_vs_level_atr": -0.20,
       "same_bar_reclaim": False, "vwap_dist_sigma": -1.37}
ok(V.assert_event_time_row(row), "a clean event-time row is accepted")
leaked = dict(row, reclaim_latency_min=(reclaim_ts-CONF)/60,
              reclaim_magnitude_atr=0.62)
try:
    V.assert_event_time_row(leaked); ok(False,"leaked row should be refused")
except ValueError as e:
    ok("reclaim_latency_min" in str(e) and "reclaim_magnitude_atr" in str(e),
       "a row carrying the future reclaim's latency AND magnitude is REFUSED")
# the NaN-then-backfill mistake the audit warned about
nan_row = dict(row, reclaim_latency_min=float("nan"))
try:
    V.assert_event_time_row(nan_row); ok(False,"NaN placeholder should be refused")
except ValueError:
    ok(True, "a NaN placeholder for a future reclaim is refused at event time "
             "- it cannot be backfilled later because it cannot be present now")
ok(reclaim_ts > CONF, f"the constructed reclaim is genuinely later "
                      f"(+{(reclaim_ts-CONF)//60:.0f} min after confirmation)")

# ── 4. THE REQUIRED 252-DAY HISTORY TEST ───────────────────────────────────
print("\n4. A 252-day feature fails closed on insufficient history")
ok(V.require_history("atr_percentile", 252), "252 days available -> permitted")
for name,have in (("atr_percentile",251),("realized_vol_state",30),
                  ("htf_1h_range_pctile",0)):
    try:
        V.require_history(name, have)
        ok(False, f"{name} with {have} days should have failed")
    except V.InsufficientHistory as e:
        ok("INELIGIBLE" in str(e),
           f"{name} with {have} days -> event INELIGIBLE, never partial history")

# ── 5. level availability is never backdated ───────────────────────────────
print("\n5. Level availability is never backdated to formation")
piv = V.LEVEL_UNIVERSE["pivot"]
ok("NEVER backdated" in piv["availability"],
   "pivot availability is the confirmation bar close, not the formation bar")
ok(all("availability" in v and "formation" in v
       for v in V.LEVEL_UNIVERSE.values()),
   f"all {len(V.LEVEL_UNIVERSE)} level generators declare formation AND availability")
ok(all("expiration" in v and "touch_update" in v and "invalidated" in v
       and "duplicates" in v and "survives_session" in v
       for v in V.LEVEL_UNIVERSE.values()),
   "every generator declares expiration, touch-update, invalidation, "
   "duplicate and session-survival rules")

print()
if FAILS:
    print(f"V2 CAUSALITY TESTS FAILED - {len(FAILS)}")
    for f in FAILS: print(f"  - {f}")
    sys.exit(1)
print("V2 CAUSALITY TESTS PASSED.")

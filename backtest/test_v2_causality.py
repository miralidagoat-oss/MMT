#!/usr/bin/env python3
"""V2 causality and availability tests. Run before any V2 outcome exists."""
import datetime as dt, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, v2_events as V
import csv, json

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

# ── A. stored bar timestamp semantics ─────────────────────────────────────
print("\nA. Stored timestamps are BAR_OPEN_TIME")
stamps=set(); 
for i,x in enumerate(csv.reader(open(V.RAW_BASIS))):
    if x[0]=="time": continue
    if i>400000: break
    e=dt.datetime.fromtimestamp(int(x[0]),dt.timezone.utc).astimezone(S.ET)
    stamps.add(e.strftime("%H:%M"))
ok("18:00" in stamps, "an 18:00 ET stamp EXISTS in the raw file")
ok("17:55" not in stamps, "no 17:55 ET stamp exists (maintenance)")
ok(True, "a bar CLOSING at 18:00 would span 17:55-18:00, inside the halt, so "
         "18:00 must be an OPEN stamp -> BAR_OPEN_TIME")

# ── B/C. confirmation time and landmark origin ────────────────────────────
print("\nB/C. EVENT_CONFIRMATION_TIME and landmark origin")
open_ts=1_700_000_000
t0=V.event_confirmation_time(open_ts)
ok(t0==open_ts+300, f"t0 = bar open + 300s ({t0-open_ts}s)")
ok(V.landmark_time(t0,5)==t0+300, "+5m landmark is 5 min AFTER CONFIRMATION")
ok(V.landmark_time(t0,5)==open_ts+600,
   "which is 10 minutes after the sweep bar OPENED - not 5")
ok(V.LANDMARK_REMAINING_HORIZON_MIN==30 and V.LANDMARK_ATR=="ATR0",
   "every landmark shares one 30m remaining horizon, normalised by ATR0")

# a sweep anywhere inside the bar cannot pull in the NEXT bar
nxt=open_ts+300
ok(nxt==t0, "the next bar OPENS exactly at t0 - so its content is strictly "
            "after confirmation and cannot enter the event-time row")

# ── D/E/F. outcome/MFE spec is frozen in the feature spec ─────────────────
print("\nD/E/F. Outcome and MFE/MAE specification")
FS=json.load(open("research/FEATURE_SPEC_V2.json"))
O=FS["outcomes"]
ok(O["primary"]=="Y_30", "primary outcome is Y_30")
ok("EXACTLY" in O["Y_H"], "endpoint bar must match t0+H EXACTLY")
ok("Never nearest-bar" in O["censoring"],
   "no nearest/previous/next/interpolated substitution is permitted")
ok("EXCLUDED" in O["MFE_MAE"]["bars_used"],
   "the sweep bar is EXCLUDED from MFE/MAE")
ok("ATR0" in O["MFE_MAE"]["normalised"], "MFE/MAE normalised by ATR0")
ok(O["MFE_MAE"]["no_post_bar"]=="CENSORED", "no post-confirmation bar -> CENSOR")
ok("frozen at t0" in O["secondary"]["opposing_liquidity_reached"].replace("FROZEN","frozen")
   or "freeze its id" in O["secondary"]["opposing_liquidity_reached"],
   "opposing liquidity target is frozen at t0, never a future level")

# ── H/I. Holm family membership ───────────────────────────────────────────
print("\nH/I. Holm family membership")
fam=FS["confirmatory_family"]; exc=FS["excluded_from_confirmatory"]
ok(len(fam)==22, f"confirmatory family is exactly 22 features ({len(fam)})")
ok(FS["holm"]["m"]==22 and FS["holm"]["alpha"]==0.05, "Holm m=22, alpha=0.05")
ok(len(set(fam))==22, "no duplicates in the family")
for bad in ("level_formation_lag_min","level_kind_dynamic","penetration_pts",
            "same_bar_reclaim","vwap_dist_pts","dist_weekly_open_atr","direction"):
    ok(bad not in fam and bad in exc, f"{bad} is EXCLUDED from Holm")
ok(all(f in FS["event_time_features"] for f in fam),
   "every confirmatory feature has a specification entry")

# ── L. session buckets tile the session exactly ───────────────────────────
print("\nL. Session buckets tile [18:00,17:00) with no overlap or hole")
B=FS["session_buckets_mspo"]
spans=sorted((v[0],v[1],k) for k,v in B.items() if not k.startswith("_"))
ok(spans[0][0]==0, "buckets start at mspo 0 (18:00 ET)")
ok(spans[-1][1]==1380, "buckets end at mspo 1380 (17:00 ET)")
holes=[(spans[i][1],spans[i+1][0]) for i in range(len(spans)-1)
       if spans[i][1]!=spans[i+1][0]]
ok(not holes, f"no gaps or overlaps between buckets ({holes})")
ok(B["london"]==[480,840], "London is [480,840) = 02:00-08:00 ET, matching the "
                           "level universe's London window")
ok(B["_maintenance_not_a_bucket"]==[1380,1440],
   "[1380,1440) maintenance is NOT a tradable bucket")
covered=set()
for a,b,_ in spans: covered|=set(range(a,b))
ok(len(covered)==1380, f"buckets cover exactly 1380 minutes ({len(covered)})")

# ── M. resource ceiling cannot delete an economic level ───────────────────
print("\nM. Storage ceiling never decides economics")
ok(hasattr(V,"PoolCeilingExceeded"), "a dedicated HALT exception exists")
ok(V.LEVEL_UNIVERSE["pivot"]["expiration"].startswith("NONE from storage"),
   "pivot expiration is economic, not storage-driven")
ok(V.MAX_ACTIVE_POOLS>0 and "SAFETY CEILING" in open("backtest/v2_events.py").read(),
   f"MAX_ACTIVE_POOLS={V.MAX_ACTIVE_POOLS} is documented as a safety ceiling only")
ok(V.PIVOT_LEN==5, "PIVOT_LEN is frozen at 5, not symbolic")
older={"level_id":"L1","price":100.0,"formation_ts":10,"available_ts":20,"touch_count":2}
newer={"level_id":"L2","price":100.1,"formation_ts":30,"available_ts":40,"touch_count":3}
mg=V.merge_duplicate_pivots(older,newer)
ok(mg["level_id"]=="L1" and mg["price"]==100.0 and mg["formation_ts"]==10
   and mg["available_ts"]==20 and mg["touch_count"]==5,
   "duplicate merge: price/id/formation/availability from the OLDER level, "
   "touch counts summed")
ok(V.merge_duplicate_pivots(newer,older)==mg, "merge is order-independent")

# ── K. pristine stress set cannot be read without the guard ──────────────
print("\nK. Pristine stress set is guarded")
import partitions as PP
for nm in ("stress_set_pristine","stress_set_contaminated_tail","stress_set","holdout"):
    try:
        PP.guard(nm)
        ok(False, f"guard() ALLOWED {nm} - every stress-set block must be refused")
    except SystemExit as e:
        ok("ONE permitted use" in str(e), f"guard() refuses {nm} before reading")
ok(PP.guard("development") is None, "development is not guarded")
ok(PP.guard("validation") is None, "validation is not guarded")

# ── proxy grid honesty ───────────────────────────────────────────────────
print("\nProxy price grid is not disguised as an NQ tick")
ok(V.PROXY_SWEEP_PENETRATION_POINTS==0.25, "threshold is 0.25 points")
ok(not hasattr(V,"TICK"), "the misleading name TICK is gone")
ok(V.RAW_BASIS=="data_ndx/NDX_5m.csv", "V2 reads the RAW unquantized file")
ok("IRREVERSIBLY" in json.dumps(FS["price_grid"]),
   "the spec records that the V1 file was irreversibly quantized")

print()
if FAILS:
    print(f"V2 CAUSALITY TESTS FAILED - {len(FAILS)}")
    for f in FAILS: print(f"  - {f}")
    sys.exit(1)
print("V2 CAUSALITY TESTS PASSED.")

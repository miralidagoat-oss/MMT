#!/usr/bin/env python3
"""Contract identity, expiration ordering, CME trade-day sessionisation and the
frozen roll engine. Pure and offline-testable: no network, no API key.

Design rules this module enforces, each of which fixed a real defect:

  * Contract identity is an immutable RESEARCH ID derived from the exchange's
    own expiration - "NQ-2025-12" - never a ticker. Databento warns textual
    symbols can be reused, and numeric instrument_id is not stable over
    arbitrary periods, so both are stored only as POINT-IN-TIME mappings.
  * The universe comes from definition records (asset, instrument_class,
    expiration, activation). A raw_symbol regex is a secondary sanity check
    only - GLBX uses single-digit maturity years (NQZ5), so a two-digit
    pattern matches nothing real.
  * Ordering and succession are by EXPIRATION. Lexical ticker order is not
    chronological: sorted() puts NQZ5 after NQM6.
  * Sessions are CME trade days (18:00 -> 17:00 America/New_York), not UTC
    calendar dates.
"""
import datetime as dt
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
QUARTERLY = (3, 6, 9, 12)          # NQ cycle, used as a VALIDATION rule only


# ── contract identity ──────────────────────────────────────────────────────
def research_id(expiration_utc):
    """Immutable identity from the exchange's expiration. Never a ticker."""
    e = expiration_utc.astimezone(ET)
    return f"NQ-{e.year:04d}-{e.month:02d}"


def build_universe(def_rows, asset="NQ"):
    """definition records -> {research_id: contract}, outright futures only.

    def_rows: dicts with at least asset, instrument_class, expiration,
    activation, raw_symbol, instrument_id, ts_recv (point-in-time of the record).
    """
    out, rejected = {}, {"class": 0, "asset": 0, "no_expiry": 0}
    for r in def_rows:
        if (r.get("asset") or "").strip().upper() != asset:
            rejected["asset"] += 1; continue
        if (r.get("instrument_class") or "").strip().upper() not in ("F", "FUTURE"):
            rejected["class"] += 1; continue
        exp = r.get("expiration")
        if not exp:
            rejected["no_expiry"] += 1; continue
        rid = research_id(exp)
        c = out.setdefault(rid, dict(research_id=rid, expiration=exp,
                                     activation=r.get("activation"),
                                     raw_symbols=[], instrument_ids=[]))
        if exp < c["expiration"]:
            c["expiration"] = exp
        act = r.get("activation")
        if act and (c["activation"] is None or act < c["activation"]):
            c["activation"] = act
        rs, iid, seen = r.get("raw_symbol"), r.get("instrument_id"), r.get("ts_recv")
        if rs and not any(m["raw_symbol"] == rs for m in c["raw_symbols"]):
            c["raw_symbols"].append(dict(raw_symbol=rs, first_seen=seen, last_seen=seen))
        elif rs:
            m = next(m for m in c["raw_symbols"] if m["raw_symbol"] == rs)
            if seen and (m["last_seen"] is None or seen > m["last_seen"]):
                m["last_seen"] = seen
        if iid is not None and not any(m["instrument_id"] == iid for m in c["instrument_ids"]):
            c["instrument_ids"].append(dict(instrument_id=iid, first_seen=seen, last_seen=seen))
        elif iid is not None:
            m = next(m for m in c["instrument_ids"] if m["instrument_id"] == iid)
            if seen and (m["last_seen"] is None or seen > m["last_seen"]):
                m["last_seen"] = seen
    return out, rejected


def ordered(universe):
    """Chronological by EXPIRATION - never by ticker string."""
    return sorted(universe.values(), key=lambda c: c["expiration"])


def successor_map(universe):
    seq = ordered(universe)
    return {c["research_id"]: (seq[i + 1]["research_id"] if i + 1 < len(seq) else None)
            for i, c in enumerate(seq)}


def symbol_at(contract, when):
    """The raw_symbol that identified this contract at a point in time."""
    for m in contract["raw_symbols"]:
        f, l = m.get("first_seen"), m.get("last_seen")
        if (f is None or when >= f) and (l is None or when <= l):
            return m["raw_symbol"]
    return contract["raw_symbols"][0]["raw_symbol"] if contract["raw_symbols"] else None


# ── CME sessionisation ─────────────────────────────────────────────────────
def cme_trade_day(ts_utc):
    """CME trade day: 18:00 ET -> 17:00 ET next day, DST-correct.

    Shifting the ET wall clock forward 6 hours maps 18:00 to midnight, so the
    calendar date of the shifted time IS the trade day."""
    return (ts_utc.astimezone(ET) + dt.timedelta(hours=6)).date()


def session_close_et(trade_day):
    """17:00 ET on the calendar date the trade day ends."""
    return dt.datetime.combine(trade_day, dt.time(17, 0), tzinfo=ET)


def session_open_et(trade_day):
    """18:00 ET the evening before - the trade day's own open."""
    return dt.datetime.combine(trade_day - dt.timedelta(days=1), dt.time(18, 0), tzinfo=ET)


def aggregate_session_volume(hourly_rows):
    """ohlcv-1h -> {(trade_day, research_id): volume}. UTC daily bars cannot be
    used for this: their boundary is not the CME session boundary."""
    agg = {}
    for r in hourly_rows:
        k = (cme_trade_day(r["ts_event"]), r["research_id"])
        agg[k] = agg.get(k, 0.0) + float(r.get("volume") or 0)
    return agg


# ── frozen roll engine ─────────────────────────────────────────────────────
def run_roll(session_volume, universe, research_start, streak_required=2):
    """Frozen policy: deferred volume > front volume on two consecutive
    completed sessions -> switch at the NEXT session open.

    research_start is the first date whose roll state must be trustworthy; the
    caller must supply volume history BEFORE it so the initial front contract
    is established by the same rule rather than an arbitrary guess. This
    roll-history warm-up is separate from the 30-day strategy-feature warm-up.
    """
    succ = successor_map(universe)
    days = sorted({d for d, _ in session_volume})
    events, rows, front, streak, initialised = [], [], None, 0, False
    for d in days:
        live = {rid: v for (dd, rid), v in session_volume.items() if dd == d and v > 0}
        if not live:
            continue
        if front is None:
            # Seed with the highest-volume contract, but only in the pre-start
            # history, and record that the seed happened. By research_start the
            # rule itself has had time to take over.
            front = max(live, key=lambda r: live[r])
            events.append(dict(kind="seed", trade_day=d.isoformat(), new=front,
                               reason="highest session volume in pre-start history"))
        nxt = succ.get(front)
        fv, nv = live.get(front, 0.0), (live.get(nxt, 0.0) if nxt else 0.0)
        streak = streak + 1 if (nxt and nv > fv) else 0
        switch = bool(nxt and streak >= streak_required)
        rows.append(dict(trade_day=d.isoformat(), front=front, front_volume=fv,
                         next=nxt, next_volume=nv, crossover_streak=streak,
                         switch_signalled=switch, active=front, fallback_used=False))
        if switch:
            dec = session_close_et(d)
            eff = session_open_et(d + dt.timedelta(days=1))
            events.append(dict(kind="roll", signal_session=d.isoformat(),
                               decision_timestamp_et=dec.isoformat(),
                               decision_timestamp_utc=dec.astimezone(dt.timezone.utc).isoformat(),
                               effective_timestamp_et=eff.isoformat(),
                               effective_timestamp_utc=eff.astimezone(dt.timezone.utc).isoformat(),
                               old_contract=front, new_contract=nxt,
                               reason=f"deferred volume exceeded front on {streak_required} "
                                      f"consecutive sessions", fallback_used=False))
            front, streak = nxt, 0
        if d >= research_start:
            initialised = True
    return rows, events, initialised


def active_intervals(rows):
    out = []
    for r in rows:
        if not out or out[-1]["research_id"] != r["active"]:
            if out:
                out[-1]["active_end"] = r["trade_day"]
            out.append(dict(research_id=r["active"], active_start=r["trade_day"]))
    if out:
        out[-1]["active_end"] = rows[-1]["trade_day"]
    return out


# ── hard invariants: HALT, never best-effort ───────────────────────────────
def check_invariants(universe, rows, events, intervals, research_start, warmup_days=30):
    f = []
    seq = ordered(universe)
    if not seq:
        return ["universe is empty - discovery failed"]
    for c in seq:
        if not c["raw_symbols"]:
            f.append(f"{c['research_id']}: no raw_symbol mapping")
        e = c["expiration"].astimezone(ET)
        if e.month not in QUARTERLY:
            f.append(f"{c['research_id']}: expiration month {e.month} outside NQ quarterly cycle")
    for a, b in zip(seq, seq[1:]):
        if not b["expiration"] > a["expiration"]:
            f.append(f"expirations not strictly increasing: {a['research_id']} -> {b['research_id']}")
        ea, eb = a["expiration"].astimezone(ET), b["expiration"].astimezone(ET)
        gap = (eb.year - ea.year) * 12 + (eb.month - ea.month)
        if gap != 3:
            f.append(f"successor gap {gap}mo (expected 3): {a['research_id']} -> {b['research_id']}")
    if len({c["research_id"] for c in seq}) != len(seq):
        f.append("duplicate economic contracts in universe")
    seen = set()
    for iv in intervals:
        if iv["research_id"] in seen:
            f.append(f"{iv['research_id']} active in two disjoint intervals")
        seen.add(iv["research_id"])
    for a, b in zip(intervals, intervals[1:]):
        if a["active_end"] > b["active_start"]:
            f.append(f"overlapping active windows {a['research_id']}/{b['research_id']}")
        if dt.date.fromisoformat(b["active_start"]) - dt.date.fromisoformat(a["active_end"]) \
                > dt.timedelta(days=5):
            f.append(f"gap with no active contract between {a['research_id']} and {b['research_id']}")
    for ev in events:
        if ev["kind"] != "roll":
            continue
        if not ev["effective_timestamp_utc"] > ev["decision_timestamp_utc"]:
            f.append(f"roll {ev['old_contract']}->{ev['new_contract']}: effective not after decision")
    for iv in intervals:
        c = universe.get(iv["research_id"])
        if not c:
            f.append(f"active interval references unknown contract {iv['research_id']}"); continue
        a0 = dt.date.fromisoformat(iv["active_start"])
        w0 = a0 - dt.timedelta(days=warmup_days)
        if c.get("activation") and w0 < c["activation"].astimezone(ET).date():
            f.append(f"{iv['research_id']}: warm-up {w0} precedes activation "
                     f"{c['activation'].astimezone(ET).date()}")
        if dt.date.fromisoformat(iv["active_end"]) > c["expiration"].astimezone(ET).date():
            f.append(f"{iv['research_id']}: active window extends past expiration")
    if rows and dt.date.fromisoformat(rows[0]["trade_day"]) >= research_start:
        f.append("no pre-start volume history: initial front contract would be a guess")
    return f

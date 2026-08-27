#!/usr/bin/env python3
"""Backtest harness for indicators/mnq_eth_final_indicator_scaffold.pine.

The scaffold is an ``indicator()``, so TradingView's Strategy Tester cannot
load it and there is no native backtest to run. This harness is a faithful
port of the scaffold's *deterministic* bar-by-bar logic -- the CME week clock,
the session filter, every release gate, the frozen-rule adapter, the bracket
validator, the single-event arbiter and the alert de-duplicator -- so the
signal count can be measured against real MNQ 5m bars instead of asserted.

Two passes are run:

  A. as_shipped     -- every input at its Pine default.
  B. gates_forced   -- every governance gate forced open (operator toggles on,
                       identity constants populated with well-formed values,
                       environment assumed correct). This isolates the frozen
                       rule adapter as an independent cause of zero signals.

Usage: python3 backtest/mnq_scaffold_backtest.py [data/MNQ_5m.csv]
"""
import csv
import sys
from collections import Counter
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

EXCHANGE_TZ = ZoneInfo("America/Chicago")

# Pine dayofweek constants: Sunday == 1 ... Saturday == 7.
SUNDAY, MONDAY, THURSDAY, FRIDAY, SATURDAY = 1, 2, 5, 6, 7

CONTRACT_QUANTITY = 1
POINT_VALUE = 2.0          # MNQ: $2 per index point
MINTICK = 0.25


# ---------------------------------------------------------------------------
# Port of the scaffold's helper functions
# ---------------------------------------------------------------------------

def f_round_to_tick(value):
    if value is None:
        return None
    return round(value / MINTICK) * MINTICK


def f_is_cme_week_clock_open(exchange_day, minute_of_day):
    sunday_open = exchange_day == SUNDAY and minute_of_day >= 17 * 60
    mon_thu_open = (
        MONDAY <= exchange_day <= THURSDAY
        and (minute_of_day < 16 * 60 or minute_of_day >= 17 * 60)
    )
    friday_open = exchange_day == FRIDAY and minute_of_day < 16 * 60
    return sunday_open or mon_thu_open or friday_open


def f_in_session_1700_1600(minute_of_day):
    """Pine time(period, '1700-1600', tz): 17:00 through 16:00 next day.

    Equivalently every minute of the day except the 16:00-17:00 maintenance
    hour. Pine's default session day mask is all seven days.
    """
    return minute_of_day < 16 * 60 or minute_of_day >= 17 * 60


def f_valid_bracket(direction, entry, stop, target):
    complete = entry is not None and stop is not None and target is not None
    if not complete:
        return False
    long_geometry = direction == 1 and stop < entry < target
    short_geometry = direction == -1 and target < entry < stop
    return long_geometry or short_geometry


def f_is_lower_hex_sha256(value):
    return len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def f_is_phase9_contract(name):
    if len(name) != 6:
        return False
    return (
        name[0:3] == "MNQ"
        and name[3] in ("H", "M", "U", "Z")
        and name[4].isdigit()
        and name[5].isdigit()
    )


def f_is_authorization_id(value):
    if not (1 <= len(value) <= 96):
        return False
    if value[0] not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789":
        return False
    return all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-" for c in value)


# ---------------------------------------------------------------------------
# Port of the FROZEN RULE ADAPTER (verbatim: every body is false / na)
# ---------------------------------------------------------------------------

def f_frozen_long_entry_event(bar, history):
    return False


def f_frozen_short_entry_event(bar, history):
    return False


def f_frozen_long_exit_event(bar, history):
    return False


def f_frozen_short_exit_event(bar, history):
    return False


def f_frozen_long_entry_price(bar, history):
    return None


def f_frozen_long_stop_price(bar, history):
    return None


def f_frozen_long_target_price(bar, history):
    return None


def f_frozen_short_entry_price(bar, history):
    return None


def f_frozen_short_stop_price(bar, history):
    return None


def f_frozen_short_target_price(bar, history):
    return None


# ---------------------------------------------------------------------------
# Configuration profiles
# ---------------------------------------------------------------------------

class Profile:
    """One run configuration: the const block plus the input defaults."""

    def __init__(self, name, **kw):
        self.name = name
        # Frozen identity constants, exactly as they appear in the .pine file.
        self.FROZEN_RULE_ID = kw.get("rule_id", "UNASSIGNED")
        self.FROZEN_RULE_SHA256 = kw.get("rule_sha", "UNASSIGNED")
        self.FROZEN_VALIDATION_STATUS = kw.get("status", "UNVALIDATED")
        self.FROZEN_TICKER_ID = kw.get("ticker_id", "UNASSIGNED")
        self.FROZEN_EXECUTION_CONTRACT = kw.get("contract", "UNASSIGNED")
        self.FROZEN_AUTHORIZATION_ID = kw.get("auth_id", "UNASSIGNED")
        self.FROZEN_AUTHORIZATION_SHA256 = kw.get("auth_sha", "UNASSIGNED")
        self.FROZEN_SIGNAL_SESSION = kw.get("frozen_session", "UNASSIGNED")
        self.FROZEN_ALLOW_LONG = True
        self.FROZEN_ALLOW_SHORT = True
        # Operator inputs.
        self.armFrozenSignalDisplay = kw.get("arm", False)
        self.calendarRollManifestConfirmed = kw.get("calendar", False)
        self.enableAlerts = kw.get("alerts", False)
        self.allowLong = True
        self.allowShort = True
        self.configuredSignalSession = kw.get("session", "1700-1600")
        # Chart environment.
        self.standardTickerId = kw.get("chart_ticker", "CME_MINI:MNQ1!")
        self.isFiveMinute = kw.get("five_minute", True)
        self.isStandardChart = True
        self.isFuturesInstrument = True
        self.isMnqTicker = True
        self.isMnqTick = True
        self.isMnqPointValue = True

    # -- gate chain -------------------------------------------------------
    @property
    def isIndividualContractChart(self):
        return "!" not in self.standardTickerId

    @property
    def environmentOk(self):
        return all([
            self.isFiveMinute, self.isStandardChart, self.isFuturesInstrument,
            self.isMnqTicker, self.isIndividualContractChart,
            self.isMnqTick, self.isMnqPointValue,
        ])

    @property
    def ruleIdentityAssigned(self):
        return (
            self.FROZEN_RULE_ID != "UNASSIGNED"
            and f_is_lower_hex_sha256(self.FROZEN_RULE_SHA256)
            and self.FROZEN_VALIDATION_STATUS == "EMPIRICALLY_FROZEN"
            and self.FROZEN_TICKER_ID != "UNASSIGNED"
            and self.FROZEN_SIGNAL_SESSION != "UNASSIGNED"
        )

    @property
    def executionIdentityAssigned(self):
        return (
            f_is_phase9_contract(self.FROZEN_EXECUTION_CONTRACT)
            and f_is_authorization_id(self.FROZEN_AUTHORIZATION_ID)
            and f_is_lower_hex_sha256(self.FROZEN_AUTHORIZATION_SHA256)
        )

    @property
    def runtimeInputsMatchFrozenProfile(self):
        return (
            self.standardTickerId == self.FROZEN_TICKER_ID
            and self.isIndividualContractChart
            and self.configuredSignalSession == self.FROZEN_SIGNAL_SESSION
            and self.allowLong == self.FROZEN_ALLOW_LONG
            and self.allowShort == self.FROZEN_ALLOW_SHORT
        )

    @property
    def releaseGatesOpen(self):
        return all([
            self.ruleIdentityAssigned,
            self.executionIdentityAssigned,
            self.runtimeInputsMatchFrozenProfile,
            self.armFrozenSignalDisplay,
            self.calendarRollManifestConfirmed,
            self.environmentOk,
        ])

    def gate_report(self):
        return [
            ("ruleIdentityAssigned", self.ruleIdentityAssigned),
            ("executionIdentityAssigned", self.executionIdentityAssigned),
            ("runtimeInputsMatchFrozenProfile",
             self.runtimeInputsMatchFrozenProfile),
            ("armFrozenSignalDisplay", self.armFrozenSignalDisplay),
            ("calendarRollManifestConfirmed",
             self.calendarRollManifestConfirmed),
            ("environmentOk", self.environmentOk),
        ]


# ---------------------------------------------------------------------------
# Bar loop
# ---------------------------------------------------------------------------

def load_bars(path):
    bars = []
    with open(path) as fh:
        for row in csv.DictReader(fh):
            bars.append({
                "time": int(row["time"]),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row["volume"]),
            })
    bars.sort(key=lambda b: b["time"])
    return bars


def run(bars, profile):
    stats = Counter()
    events = []
    last_dispatched_signal_id = ""
    history = []

    gates_open = profile.releaseGatesOpen

    for i, bar in enumerate(bars):
        dt = datetime.fromtimestamp(bar["time"], tz=timezone.utc)
        local = dt.astimezone(EXCHANGE_TZ)
        minute_of_day = local.hour * 60 + local.minute
        # Python weekday(): Mon=0..Sun=6 -> Pine dayofweek: Sun=1..Sat=7
        day_of_week = (local.weekday() + 1) % 7 + 1

        stats["bars"] += 1

        week_open = f_is_cme_week_clock_open(day_of_week, minute_of_day)
        in_session = f_in_session_1700_1600(minute_of_day)
        in_allowed = week_open and in_session

        stats["cme_week_clock_open"] += week_open
        stats["in_configured_session"] += in_session
        stats["in_allowed_signal_session"] += in_allowed

        # The last bar of a live chart is unconfirmed; every historical bar is
        # confirmed. Treat the final bar as unconfirmed to mirror a live chart.
        confirmed_close = i < len(bars) - 1
        stats["confirmed_close"] += confirmed_close

        raw_long_entry = f_frozen_long_entry_event(bar, history)
        raw_short_entry = f_frozen_short_entry_event(bar, history)
        raw_long_exit = f_frozen_long_exit_event(bar, history)
        raw_short_exit = f_frozen_short_exit_event(bar, history)

        stats["raw_long_entry"] += raw_long_entry
        stats["raw_short_entry"] += raw_short_entry
        stats["raw_long_exit"] += raw_long_exit
        stats["raw_short_exit"] += raw_short_exit

        long_entry = f_round_to_tick(f_frozen_long_entry_price(bar, history))
        long_stop = f_round_to_tick(f_frozen_long_stop_price(bar, history))
        long_target = f_round_to_tick(f_frozen_long_target_price(bar, history))
        short_entry = f_round_to_tick(f_frozen_short_entry_price(bar, history))
        short_stop = f_round_to_tick(f_frozen_short_stop_price(bar, history))
        short_target = f_round_to_tick(f_frozen_short_target_price(bar, history))

        long_bracket_ok = f_valid_bracket(1, long_entry, long_stop, long_target)
        short_bracket_ok = f_valid_bracket(
            -1, short_entry, short_stop, short_target)
        stats["long_bracket_valid"] += long_bracket_ok
        stats["short_bracket_valid"] += short_bracket_ok

        long_entry_candidate = (
            gates_open and confirmed_close and in_allowed
            and profile.allowLong and raw_long_entry and long_bracket_ok)
        short_entry_candidate = (
            gates_open and confirmed_close and in_allowed
            and profile.allowShort and raw_short_entry and short_bracket_ok)
        long_exit_candidate = gates_open and confirmed_close and raw_long_exit
        short_exit_candidate = gates_open and confirmed_close and raw_short_exit

        candidate_count = sum([
            long_entry_candidate, short_entry_candidate,
            long_exit_candidate, short_exit_candidate,
        ])
        stats["candidate_events"] += candidate_count
        stats["event_conflict_bars"] += candidate_count > 1

        accepted_long_entry = long_entry_candidate and candidate_count == 1
        accepted_short_entry = short_entry_candidate and candidate_count == 1
        accepted_long_exit = long_exit_candidate and candidate_count == 1
        accepted_short_exit = short_exit_candidate and candidate_count == 1

        accepted = sum([accepted_long_entry, accepted_short_entry,
                        accepted_long_exit, accepted_short_exit])
        stats["accepted_events"] += accepted

        if accepted_long_entry or accepted_short_entry:
            command = "ENTRY"
        elif accepted_long_exit or accepted_short_exit:
            command = "EXIT"
        else:
            command = ""

        if accepted_long_entry or accepted_short_exit:
            side = "BUY"
        elif accepted_short_entry or accepted_long_exit:
            side = "SELL"
        else:
            side = ""

        signal_id = ""
        if command:
            signal_id = ":".join([
                profile.FROZEN_RULE_SHA256, profile.FROZEN_EXECUTION_CONTRACT,
                command, str(bar["time"] * 1000), side,
            ])

        dispatch = (
            gates_open and profile.enableAlerts and command != ""
            and signal_id != "" and signal_id != last_dispatched_signal_id)
        if dispatch:
            stats["alerts_dispatched"] += 1
            last_dispatched_signal_id = signal_id
            events.append({
                "time": local.isoformat(), "command": command, "side": side,
                "entry": long_entry if accepted_long_entry else short_entry,
                "stop": long_stop if accepted_long_entry else short_stop,
                "target": (long_target if accepted_long_entry
                           else short_target),
            })

        history.append(bar)

    return stats, events


def pnl_from_events(events):
    """Pair ENTRY/EXIT events into round turns and total the P&L in dollars."""
    trades, open_pos = [], None
    for ev in events:
        if ev["command"] == "ENTRY":
            open_pos = ev
        elif ev["command"] == "EXIT" and open_pos is not None:
            trades.append((open_pos, ev))
            open_pos = None
    gross = 0.0
    for entry, _exit in trades:
        gross += 0.0  # no fill prices exist; adapter returns na
    return trades, gross


def report(bars, profile):
    stats, events = run(bars, profile)
    print(f"--- profile: {profile.name} ---")
    print(f"  releaseGatesOpen : {profile.releaseGatesOpen}")
    for gate, value in profile.gate_report():
        print(f"    {'PASS' if value else 'BLOCK'}  {gate}")
    print(f"  bars processed              : {stats['bars']}")
    print(f"  confirmed closes            : {stats['confirmed_close']}")
    print(f"  CME week clock open         : {stats['cme_week_clock_open']}")
    print(f"  in configured session       : {stats['in_configured_session']}")
    print(f"  in allowed signal session   : "
          f"{stats['in_allowed_signal_session']}")
    print(f"  raw adapter entry events    : "
          f"{stats['raw_long_entry'] + stats['raw_short_entry']}")
    print(f"  raw adapter exit events     : "
          f"{stats['raw_long_exit'] + stats['raw_short_exit']}")
    print(f"  valid brackets built        : "
          f"{stats['long_bracket_valid'] + stats['short_bracket_valid']}")
    print(f"  candidate events            : {stats['candidate_events']}")
    print(f"  event-conflict bars         : {stats['event_conflict_bars']}")
    print(f"  ACCEPTED events             : {stats['accepted_events']}")
    print(f"  alerts dispatched           : {stats['alerts_dispatched']}")
    trades, gross = pnl_from_events(events)
    print(f"  round-turn trades           : {len(trades)}")
    print(f"  gross P&L (USD, 1 contract) : {gross:.2f}")
    print()
    return stats


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "data/MNQ_5m.csv"
    bars = load_bars(path)
    first = datetime.fromtimestamp(bars[0]["time"], tz=timezone.utc)
    last = datetime.fromtimestamp(bars[-1]["time"], tz=timezone.utc)
    print("=" * 74)
    print("MNQ 5m ETH Final Indicator Scaffold - measured signal backtest")
    print("=" * 74)
    print(f"data file : {path}")
    print(f"bars      : {len(bars)}")
    print(f"range     : {first:%Y-%m-%d %H:%M} .. {last:%Y-%m-%d %H:%M} UTC")
    print()

    as_shipped = Profile("A. as_shipped (all Pine defaults)")

    gates_forced = Profile(
        "B. gates_forced (governance satisfied, adapter untouched)",
        rule_id="MNQ_ETH_CANDIDATE_001",
        rule_sha="a" * 64,
        status="EMPIRICALLY_FROZEN",
        ticker_id="CME_MINI:MNQU2026",
        contract="MNQU26",
        auth_id="AUTH.MNQ.2026-08-27",
        auth_sha="b" * 64,
        frozen_session="1700-1600",
        arm=True,
        calendar=True,
        alerts=True,
        chart_ticker="CME_MINI:MNQU2026",
    )

    a = report(bars, as_shipped)
    b = report(bars, gates_forced)

    print("=" * 74)
    print("CONCLUSION")
    print("=" * 74)
    print(f"A. as_shipped   accepted events: {a['accepted_events']}, "
          f"alerts: {a['alerts_dispatched']}")
    print(f"B. gates_forced accepted events: {b['accepted_events']}, "
          f"alerts: {b['alerts_dispatched']}")
    print()
    print("Zero signals in pass B proves the fail-closed gates are NOT the")
    print("binding constraint. Even with every gate satisfied, the frozen")
    print("rule adapter returns false/na on every bar, so there is no rule")
    print("to backtest. The scaffold has no measurable edge, drawdown, win")
    print("rate or expectancy -- those quantities are undefined, not zero.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

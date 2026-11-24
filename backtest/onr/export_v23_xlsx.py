#!/usr/bin/env python3
"""Workbook of the indicator's backtest (ONR Book v2.3, 50% add-on edition, default plan) and the add-on check.

usage: python3 export_v23_xlsx.py OUT_XLSX
Reads results_v23_trades<USER_TAG>/ (export_v23.py: trades, ledger, accounts of one full path), results_live<USER_TAG>/
(live50k.py: the mean of 12 start dates and by-year medians for each plan) and results_nqfut_5y*<USER_TAG>/summary.json
(report50k.py: eval pass rates and first-payout timing). Every total in the workbook is a formula over the Trades and
Ledger sheets; the 12-start figures, which come from other runs, are values with their source next to them.
"""
import csv
import datetime as dt
import json
import os
import sys

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from account import USER_ADDON, USER_EVAL, USER_TAG  # noqa: E402  (the user's prices; runs at them go to <name><USER_TAG>)
import windows as W  # noqa: E402  (the MNQ file's first and last sessions)

T = os.path.join(HERE, f"results_v23_trades{USER_TAG}")
LV = os.path.join(HERE, f"results_live{USER_TAG}")
FONT = "Arial"
F = Font(name=FONT, size=10)
FB = Font(name=FONT, size=10, bold=True)
FT = Font(name=FONT, size=14, bold=True)
FBLUE = Font(name=FONT, size=10, color="0000FF")
FNOTE = Font(name=FONT, size=9, italic=True, color="555555")
HEAD = PatternFill("solid", fgColor="DDE3EA")
INPUT = PatternFill("solid", fgColor="FFFF00")
USD0 = '$#,##0;($#,##0);"-"'
USD2 = '$#,##0.00;($#,##0.00);"-"'
PX = '#,##0.00'
PCT = '0.0%'
DATE = 'yyyy-mm-dd'


def rd(path):
    return list(csv.DictReader(open(path)))


def day(s):
    return dt.datetime.strptime(s, "%Y-%m-%d")


def header(ws, row, names, widths=None):
    for j, n in enumerate(names, 1):
        c = ws.cell(row=row, column=j, value=n)
        c.font, c.fill = FB, HEAD
        c.alignment = Alignment(wrap_text=True, vertical="top")
    if widths:
        for j, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(j)].width = w


def put(ws, ref, value, fmt=None, font=F, fill=None, comment=None):
    if isinstance(fmt, Font):  # put(ws, ref, "Title", FB): a font given in the format's place
        fmt, font = None, fmt
    c = ws[ref]
    c.value = value
    c.font = font
    if fmt:
        c.number_format = fmt
    if fill:
        c.fill = fill
    if comment:
        c.comment = Comment(comment, "backtest")
    return c


def main(out):
    trades, ledger, accts = rd(os.path.join(T, "trades.csv")), rd(os.path.join(T, "ledger.csv")), rd(os.path.join(T, "accounts.csv"))
    l5 = {r["id"]: r for r in rd(os.path.join(LV, "lucid_5y.csv"))}
    l5y = rd(os.path.join(LV, "lucid_5y_years.csv"))
    sa = json.load(open(os.path.join(HERE, f"results_nqfut_5y_addon{USER_TAG}", "summary.json")))
    s4 = json.load(open(os.path.join(HERE, f"results_nqfut_5y{USER_TAG}", "summary.json")))
    assert sa["eval_price"] == s4["eval_price"] == USER_EVAL[50], (sa["eval_price"], s4["eval_price"])
    assert sa.get("eval_consistency") == 0.5 and sa["nq_file"] == s4["nq_file"] == "NQFUT.npz"
    wb = Workbook()

    # ------------------------------------------------------------------ Read me
    ws = wb.active
    ws.title = "Read me"
    ws.column_dimensions["A"].width = 120
    lines = [
        ("ONR Book v2.3 (50% add-on edition): the indicator's backtest, trade by trade", FT),
        ("", F),
        ("The plan the indicator runs by default", FB),
        ("Lucid Flex 50K. Evals with the 50% consistency add-on: one bracket trade a day (18:10 ET overnight trade on a signal night, else the 09:35 opening drive).", F),
        ("Funded accounts: the 18:10 overnight trade, the 09:35 opening-drive pyramid and the 10:30-13:00 IB breakout, sized by NQ's daily range, inside a $1,200 daily risk budget.", F),
        ("5 funded + 5 evals in reserve (Lucid's maximum: 10 accounts per household, at most 5 funded); one new eval bought a session while below 10 accounts.", F),
        ("Payouts: the maximum allowed (50% of profit, up to $2,000) once 5 days of $150+ and $1,000 of profit; each funded account is closed right after its 4th payout,", F),
        ("because a 5th payout moves you to a live account and Lucid then closes every sim account. A funded account is also stopped below a $400 cushion.", F),
        (f"Costs: ${USER_EVAL[50]:.2f} per eval (your discount-code price; the add-on's own price is NOT included), $1.34 commission per MNQ round turn, Lucid keeps 10% of each payout.", F),
        ("", F),
        ("The sheets", FB),
        ("Summary: this history's totals (formulas over Trades and Ledger) next to the average over 12 start dates. The yellow cells are inputs you can change.", F),
        ("Add-on check: the 50% add-on against the standard 40% rule, with a calculator for the add-on's price.", F),
        ("Years, Months: this history by year and month (formulas over Ledger), with the 12-start medians by year.", F),
        ("Ledger: every eval bought, passed or failed, every funded account started and ended, every payout, with a running total.", F),
        ("Accounts: every eval and the funded account it became, with its payouts.", F),
        ("Trades: every trade of every account: entry, exit, reason and P&L after commission (a formula).", F),
        ("", F),
        ("Where the numbers come from", FB),
        (f"Prices: your real MNQ futures file, 5-minute bars, Dec 1 2019 - {W.LAST_MD} {W.LAST[:4]}, as recorded (nothing filled or repaired). The S&P 500 (HistData, then Dukascopy) is only the overnight signal's input.", F),
        ("The file is MNQ's front contract as it traded (not back-adjusted), so every entry and exit price is a price the front contract printed. It changes contract", F),
        ("at each quarterly roll on a session's 18:00 ET open, when the plan holds nothing. Every move, stop, target and P&L in points and dollars is exact.", F),
        ("This history starts on Nov 15 2021 (the first of the 12 start dates the website averages). Different start dates give slightly different histories.", F),
        ("Fills are simulated on 5-minute bars: a stop fills at its price (or at the open on a gap through it), a target needs a tick through, a stop wins a tie.", F),
        ("Made by backtest/onr/export_v23.py (checked to reproduce the simulator's events and P&L exactly) and export_v23_xlsx.py in the MMT repo.", F),
        ("", F),
        ("Caveats", FB),
        ("Simulated on past prices with the indicator's rules; not live-tested. Past results do not guarantee future payouts.", F),
        ("Lucid's risk team decides who goes live and may move a trader for other reasons (for example total payouts); the plan assumes it moves you only at a 5th payout.", F),
        ("Changing the commission input re-prices the Trades sheet only; the payouts in the Ledger were simulated at $1.34.", F),
    ]
    for i, (text, font) in enumerate(lines, 1):
        c = ws.cell(row=i, column=1, value=text)
        c.font = font

    # ------------------------------------------------------------------ Summary (inputs first: other sheets refer to them)
    sm = wb.create_sheet("Summary")
    for col, w in zip("ABCDEF", (46, 16, 16, 16, 16, 60)):
        sm.column_dimensions[col].width = w
    put(sm, "A1", "Summary: the indicator's default plan, 50K, 50% add-on, 5 funded + 5 evals, closed after the 4th payout", FT)
    put(sm, "A3", "Inputs", FB)
    put(sm, "A4", "Eval price ($)")
    put(sm, "B4", USER_EVAL[50], USD2, FBLUE, INPUT, "Your discount-code price for a 50K Flex eval (30% off Lucid's list price, Nov 23 2026). Used for every eval bought in the Ledger.")
    put(sm, "A5", "Your share of each payout")
    put(sm, "B5", 0.90, PCT, FBLUE, INPUT, "Lucid's LucidFlex split: 90% to the trader (help centre, LucidFlex Payouts, Jul 28 2026).")
    put(sm, "A6", "Commission per MNQ round turn ($)")
    put(sm, "B6", 1.34, USD2, FBLUE, INPUT, "All-in cost the backtest used. Changing it re-prices the Trades sheet; the simulated payouts stay as run at $1.34.")
    put(sm, "A7", "Dollars per point per MNQ contract ($)")
    put(sm, "B7", 2.0, USD2, FBLUE, None, "CME Micro E-mini Nasdaq-100 (MNQ): $2 per index point. Contract spec, not an assumption.")
    put(sm, "A8", "Last session in the data")
    put(sm, "B8", dt.datetime.fromisoformat(W.LAST), DATE, FBLUE, None, f"The price data ends with the 16:55 ET bar of {W.LAST_MD} {W.LAST[:4]}.")

    put(sm, "A10", "This history (one start date: Nov 15 2021)", FB)
    put(sm, "B10", "Value", FB)
    put(sm, "F10", "How it is computed", FB)
    rows = [
        ("First session", "=MIN(Ledger!A:A)", DATE, "Earliest date in the Ledger"),
        ("Years covered", "=(B8-B11)/365.25", "0.00", "Calendar days / 365.25"),
        ("Net to you (payouts after Lucid's share, minus every eval bought)", "=SUM(Ledger!G:G)", USD0, "Sum of the Ledger's 'To you' column"),
        ("Net to you a year", "=B13/B12", USD0, "Net / years"),
        ("Payouts", '=COUNTIF(Ledger!E:E,"Payout")', "#,##0", "Count of payouts"),
        ("Payouts, gross ($)", '=SUMIF(Ledger!E:E,"Payout",Ledger!F:F)', USD0, "Before Lucid's 10%"),
        ("Average payout, gross ($)", "=IF(B15=0,0,B16/B15)", USD0, "Gross / count"),
        ("Evals bought", '=COUNTIF(Ledger!E:E,"Eval bought")', "#,##0", ""),
        ("Evals passed", '=COUNTIF(Ledger!E:E,"Eval passed")', "#,##0", ""),
        ("Evals failed", '=COUNTIF(Ledger!E:E,"Eval failed")', "#,##0", "Evals still open at the end are neither"),
        ("Eval pass rate (this history's evals)", "=IF(B19+B20=0,0,B19/(B19+B20))", PCT, "Passed / (passed + failed)"),
        ("Funded accounts started", '=COUNTIF(Ledger!E:E,"Funded account started")', "#,##0", ""),
        ("  closed after their 4th payout", '=COUNTIF(Ledger!E:E,"Closed after its 4th payout")', "#,##0", ""),
        ("  stopped below a $400 cushion", '=COUNTIF(Ledger!E:E,"Stopped: cushion below $400")', "#,##0", ""),
        ("  blown (max loss)", '=COUNTIF(Ledger!E:E,"Blown (max loss)")', "#,##0", ""),
        ("Months with net above $0", '=COUNTIF(Months!C:C,">0")/COUNT(Months!C:C)', PCT, "Share of calendar months (first and last are partial)"),
        ("Best month", "=MAX(Months!C:C)", USD0, ""),
        ("Worst month", "=MIN(Months!C:C)", USD0, ""),
        ("Worst 12 months in a row", "=MIN(Months!H:H)", USD0, "Lowest rolling 12-month net"),
        ("Trades", "=COUNTA(Trades!A:A)-1", "#,##0", "Every account's trades"),
        ("  eval trades", '=COUNTIF(Trades!C:C,"Eval")', "#,##0", ""),
        ("  funded trades", '=COUNTIF(Trades!C:C,"Funded")', "#,##0", ""),
        ("Trades that made money", '=COUNTIF(Trades!K:K,">0")/B30', PCT, "Share of all trades with P&L above $0"),
        ("Sum of all trades' P&L ($)", "=SUM(Trades!K:K)", USD0, "Trading result of every account, after commission (before payouts and fees)"),
    ]
    for i, (lab, f, fmt, how) in enumerate(rows, 11):
        put(sm, f"A{i}", lab)
        put(sm, f"B{i}", f, fmt)
        put(sm, f"F{i}", how, font=FNOTE)

    put(sm, "A37", "Average over 12 start dates (Nov 15 2021 and every 5 sessions after it), last 5 years", FB)
    put(sm, "B37", "This plan", FB)
    put(sm, "C37", "40% rule, same plan", FB)
    put(sm, "D37", "Add-on, 5th payout taken (moved live)", FB)
    put(sm, "E37", "Add-on, accounts cycling (not allowed)", FB)
    put(sm, "F37", "Source", FB)
    for c in "BCDE":
        sm[f"{c}37"].alignment = Alignment(wrap_text=True, vertical="top")
    cols = (("B", "B5-addon-stop4"), ("C", "B5-stop4"), ("D", "B5-addon"), ("E", "B5-addon-cycle"))
    kp = [("Net to you a year", "net_per_year_usd", USD0, 1), ("Worst full year (2022-2025)", "worst_full_year_usd", USD0, 1),
          ("Worst 12 months", "worst_12_months_usd", USD0, 1), ("Deepest drop in the running total", "deepest_drop_usd", USD0, 1),
          ("Longest wait for a payout (months)", "longest_gap_months", "0.0", 1), ("Months with a payout", "months_with_payout_pct", PCT, 100),
          ("Evals bought a year", "evals_per_year", "0.0", 1), ("Most cash out of pocket", "most_cash_out_usd", USD0, 1),
          ("Total over the 5 years", "total_net_5y_usd", USD0, 1)]
    for i, (lab, key, fmt, div) in enumerate(kp, 38):
        put(sm, f"A{i}", lab)
        for c, rid in cols:
            put(sm, f"{c}{i}", float(l5[rid][key]) / div, fmt, FBLUE)
        put(sm, f"F{i}", f"backtest/onr/results_live{USER_TAG}/lucid_5y.csv (live50k.py)", font=FNOTE)

    # ------------------------------------------------------------------ Ledger
    lg = wb.create_sheet("Ledger")
    header(lg, 1, ["Session", "Year", "Month key", "Account", "Event", "Payout, gross ($)", "To you ($)", "Running total ($)"],
           [12, 7, 10, 9, 30, 15, 13, 16])
    for i, r in enumerate(ledger, 2):
        put(lg, f"A{i}", day(r["session"]), DATE)
        put(lg, f"B{i}", f"=YEAR(A{i})", "0")
        put(lg, f"C{i}", f"=YEAR(A{i})*100+MONTH(A{i})", "0")
        put(lg, f"D{i}", r["account"])
        put(lg, f"E{i}", r["event"])
        if r["event"] == "Payout":
            put(lg, f"F{i}", float(r["gross_usd"]), USD2)
        put(lg, f"G{i}", f'=IF(E{i}="Payout",F{i}*Summary!$B$5,IF(E{i}="Eval bought",-Summary!$B$4,0))', USD2)
        put(lg, f"H{i}", f"=G{i}" if i == 2 else f"=H{i - 1}+G{i}", USD0)
    lg.freeze_panes = "A2"
    lg.auto_filter.ref = f"A1:H{len(ledger) + 1}"

    # ------------------------------------------------------------------ Months
    mo = wb.create_sheet("Months")
    header(mo, 1, ["Month", "Month key", "Net to you ($)", "Payouts", "Payouts, gross ($)", "Evals bought", "Running total ($)",
                   "Last 12 months ($)"], [10, 10, 15, 9, 16, 12, 16, 17])
    months, y, m = [], 2021, 11
    while (y, m) <= (2026, 11):
        months.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    for i, (y, m) in enumerate(months, 2):
        put(mo, f"A{i}", f"{y}-{m:02d}")
        put(mo, f"B{i}", y * 100 + m, "0")
        put(mo, f"C{i}", f"=SUMIFS(Ledger!$G:$G,Ledger!$C:$C,B{i})", USD0)
        put(mo, f"D{i}", f'=COUNTIFS(Ledger!$E:$E,"Payout",Ledger!$C:$C,B{i})', "0")
        put(mo, f"E{i}", f'=SUMIFS(Ledger!$F:$F,Ledger!$E:$E,"Payout",Ledger!$C:$C,B{i})', USD0)
        put(mo, f"F{i}", f'=COUNTIFS(Ledger!$E:$E,"Eval bought",Ledger!$C:$C,B{i})', "0")
        put(mo, f"G{i}", f"=C{i}" if i == 2 else f"=G{i - 1}+C{i}", USD0)
        if i >= 13:
            put(mo, f"H{i}", f"=SUM(C{i - 11}:C{i})", USD0)
    n = len(months) + 1
    put(mo, f"A{n + 2}", f"Nov 2021 starts on Nov 15 and Nov 2026 ends on {W.LAST_MD}. 'Last 12 months' is the sum of that month and the 11 before it.", font=FNOTE)
    mo.freeze_panes = "A2"

    # ------------------------------------------------------------------ Years
    yr = wb.create_sheet("Years")
    header(yr, 1, ["Year", "Year key", "Period", "Net to you ($)", "Payouts", "Payouts, gross ($)", "Evals bought", "Evals passed",
                   "Evals failed", "Eval pass rate", "12 starts: this plan ($)", "12 starts: 40% rule ($)",
                   "12 starts: add-on, moved live ($)", "12 starts: add-on, cycling ($)"],
           [8, 9, 16, 15, 9, 16, 12, 12, 12, 12, 18, 18, 20, 18])
    med = {r["year"][:4]: r for r in l5y}
    for i, y in enumerate(range(2021, 2027), 2):
        put(yr, f"A{i}", str(y))
        put(yr, f"B{i}", y, "0")
        put(yr, f"C{i}", "Nov 15 - Dec 31" if y == 2021 else (f"Jan 1 - {W.LAST_MD}" if y == 2026 else "Full year"))
        put(yr, f"D{i}", f"=SUMIFS(Ledger!$G:$G,Ledger!$B:$B,B{i})", USD0)
        put(yr, f"E{i}", f'=COUNTIFS(Ledger!$E:$E,"Payout",Ledger!$B:$B,B{i})', "0")
        put(yr, f"F{i}", f'=SUMIFS(Ledger!$F:$F,Ledger!$E:$E,"Payout",Ledger!$B:$B,B{i})', USD0)
        put(yr, f"G{i}", f'=COUNTIFS(Ledger!$E:$E,"Eval bought",Ledger!$B:$B,B{i})', "0")
        put(yr, f"H{i}", f'=COUNTIFS(Ledger!$E:$E,"Eval passed",Ledger!$B:$B,B{i})', "0")
        put(yr, f"I{i}", f'=COUNTIFS(Ledger!$E:$E,"Eval failed",Ledger!$B:$B,B{i})', "0")
        put(yr, f"J{i}", f'=IF(H{i}+I{i}=0,"",H{i}/(H{i}+I{i}))', PCT)
        for c, key in (("K", "b5_addon_stop4_usd"), ("L", "b5_stop4_usd"), ("M", "b5_addon_live_usd"), ("N", "b5_addon_cycle_usd")):
            put(yr, f"{c}{i}", float(med[str(y)][key]), USD0, FBLUE)
    put(yr, "A8", "Total")
    yr["A8"].font = FB
    for c in "DEFGHI":
        put(yr, f"{c}8", f"=SUM({c}2:{c}7)", USD0 if c in "DF" else "0", FB)
    put(yr, "A10", f"Columns K-N: median of 12 start dates by year (backtest/onr/results_live{USER_TAG}/lucid_5y_years.csv, live50k.py). "
                   "Columns D-J: this history (start Nov 15 2021), formulas over the Ledger.", font=FNOTE)

    # ------------------------------------------------------------------ Accounts
    ac = wb.create_sheet("Accounts")
    header(ac, 1, ["Eval", "Bought", "Eval result", "Result on", "Sessions", "Funded account", "Funded from", "Funded end",
                   "Ended on", "Payouts", "Payouts, gross ($)", "To you from payouts ($)", "Net for this account ($)"],
           [8, 12, 11, 12, 9, 10, 12, 28, 12, 9, 16, 18, 17])
    for i, r in enumerate(accts, 2):
        put(ac, f"A{i}", r["eval"])
        put(ac, f"B{i}", day(r["bought"]), DATE)
        put(ac, f"C{i}", r["eval_result"])
        if r["eval_result_session"]:
            put(ac, f"D{i}", day(r["eval_result_session"]), DATE)
            put(ac, f"E{i}", int(r["eval_sessions"]), "0")
        if r["funded"]:
            put(ac, f"F{i}", r["funded"])
            put(ac, f"G{i}", day(r["funded_start"]), DATE)
            put(ac, f"H{i}", r["funded_end"])
            if r["funded_end_session"]:
                put(ac, f"I{i}", day(r["funded_end_session"]), DATE)
        put(ac, f"J{i}", f'=IF(F{i}="",0,COUNTIFS(Ledger!$D:$D,F{i},Ledger!$E:$E,"Payout"))', "0")
        put(ac, f"K{i}", f'=IF(F{i}="",0,SUMIFS(Ledger!$F:$F,Ledger!$D:$D,F{i},Ledger!$E:$E,"Payout"))', USD0)
        put(ac, f"L{i}", f"=K{i}*Summary!$B$5", USD0)
        put(ac, f"M{i}", f"=L{i}-Summary!$B$4", USD0)
    ac.freeze_panes = "A2"
    ac.auto_filter.ref = f"A1:M{len(accts) + 1}"

    # ------------------------------------------------------------------ Trades
    tr = wb.create_sheet("Trades")
    header(tr, 1, ["Session", "Account", "Phase", "Trade", "Side", "Contracts (per entry)", "Entry", "Add entry (pyramid)",
                   "Exit", "Exit reason", "P&L after commission ($)"], [12, 9, 8, 24, 6, 11, 11, 12, 11, 22, 15])
    for i, r in enumerate(trades, 2):
        put(tr, f"A{i}", day(r["session"]), DATE)
        put(tr, f"B{i}", r["account"])
        put(tr, f"C{i}", r["phase"])
        put(tr, f"D{i}", r["trade"])
        put(tr, f"E{i}", r["side"])
        put(tr, f"F{i}", int(r["contracts_per_entry"]), "0")
        put(tr, f"G{i}", float(r["entry"]), PX)
        if r["add_entry"]:
            put(tr, f"H{i}", float(r["add_entry"]), PX)
        put(tr, f"I{i}", float(r["exit"]), PX)
        put(tr, f"J{i}", r["exit_reason"])
        put(tr, f"K{i}", f'=IF(E{i}="BUY",1,-1)*((I{i}-G{i})+IF(H{i}="",0,I{i}-H{i}))*Summary!$B$7*F{i}'
                         f'-Summary!$B$6*F{i}*IF(H{i}="",1,2)', USD2)
    tr.freeze_panes = "A2"
    tr.auto_filter.ref = f"A1:K{len(trades) + 1}"

    # ------------------------------------------------------------------ Add-on check
    ad = wb.create_sheet("Add-on check", 2)
    for col, w in zip("ABCDE", (52, 16, 16, 16, 64)):
        ad.column_dimensions[col].width = w
    put(ad, "A1", "Is the 50% consistency add-on worth it?", FT)
    put(ad, "A2", f"Same plan both ways (5 funded + 5 evals, each account closed after its 4th payout, evals at ${USER_EVAL[50]:.2f}), last 5 years on real NQ "
                  "futures, average of 12 start dates. The add-on's own price is not included: enter it below.", font=FNOTE)
    header(ad, 4, ["Figure", "50% add-on", "40% rule", "Add-on minus 40%", "Source"])
    comp = [("Net to you a year (before the add-on's price)", float(l5["B5-addon-stop4"]["net_per_year_usd"]), float(l5["B5-stop4"]["net_per_year_usd"]), USD0, "lucid_5y.csv (live50k.py)"),
            ("Worst full year (2022-2025)", float(l5["B5-addon-stop4"]["worst_full_year_usd"]), float(l5["B5-stop4"]["worst_full_year_usd"]), USD0, "lucid_5y.csv"),
            ("Worst 12 months", float(l5["B5-addon-stop4"]["worst_12_months_usd"]), float(l5["B5-stop4"]["worst_12_months_usd"]), USD0, "lucid_5y.csv"),
            ("Deepest drop in the running total", float(l5["B5-addon-stop4"]["deepest_drop_usd"]), float(l5["B5-stop4"]["deepest_drop_usd"]), USD0, "lucid_5y.csv"),
            ("Months with a payout", float(l5["B5-addon-stop4"]["months_with_payout_pct"]) / 100, float(l5["B5-stop4"]["months_with_payout_pct"]) / 100, PCT, "lucid_5y.csv"),
            ("Evals bought a year", float(l5["B5-addon-stop4"]["evals_per_year"]), float(l5["B5-stop4"]["evals_per_year"]), "0.0", "lucid_5y.csv"),
            ("Eval pass rate (an eval started on every session)", sa["eval"]["pass_pct"] / 100, s4["eval"]["pass_pct"] / 100, PCT, f"results_nqfut_5y*{USER_TAG}/summary.json (report50k.py)"),
            ("Sessions to pass, median", float(sa["eval"]["sessions_to_pass"]["median"]), float(s4["eval"]["sessions_to_pass"]["median"]), "0", "summary.json"),
            ("First payout after the first eval, median (days)", float(sa["first_payout"]["median_days"]), float(s4["first_payout"]["median_days"]), "0", "summary.json"),
            ("Net a year if you take 5th payouts and go live instead", float(l5["B5-addon"]["net_per_year_usd"]), float(l5["B5"]["net_per_year_usd"]), USD0, "lucid_5y.csv")]
    for i, (lab, a, b, fmt, src) in enumerate(comp, 5):
        put(ad, f"A{i}", lab)
        put(ad, f"B{i}", a, fmt, FBLUE)
        put(ad, f"C{i}", b, fmt, FBLUE)
        put(ad, f"D{i}", f"=B{i}-C{i}", fmt if fmt != PCT else '+0.0%;-0.0%;0.0%')
        put(ad, f"E{i}", src, font=FNOTE)
    put(ad, "A17", "Your add-on price", FB)
    put(ad, "A18", "Extra cost of the add-on per eval ($)")
    put(ad, "B18", USER_ADDON, USD2, FBLUE, INPUT, f"What the 50% add-on adds to each eval at checkout, after your discount: ${USER_ADDON:.0f} "
                                                   "(your price, Nov 23 2026). Change it if your price changes.")
    put(ad, "A19", "Add-on cost a year ($)")
    put(ad, "B19", "=B18*B10", USD0)
    put(ad, "E19", "Extra cost per eval x evals bought a year with the add-on", font=FNOTE)
    put(ad, "A20", "Net a year with the add-on, after its price ($)")
    put(ad, "B20", "=B5-B19", USD0)
    put(ad, "A21", "Add-on minus 40%, after its price ($ a year)")
    put(ad, "B21", "=B20-C5", USD0)
    put(ad, "A22", "Break-even extra cost per eval ($)")
    put(ad, "B22", "=IF(B10=0,0,D5/B10)", USD2)
    put(ad, "E22", "Above this price the add-on makes less money a year than the 40% rule", font=FNOTE)
    header(ad, 24, ["If the add-on costs this much more per eval", "Add-on minus 40% ($ a year)", "", "", ""])
    for i, p in enumerate((0, 2.5, 5, 10, 15, 20, 25), 25):
        put(ad, f"A{i}", p, USD2, FBLUE)
        put(ad, f"B{i}", f"=$D$5-A{i}*$B$10", USD0)
    put(ad, "A33", "Reading it", FB)
    verdict = [
        "Income: before its price the add-on adds only a few hundred dollars a year, well inside the backtest's noise (trivial rule changes move "
        "the 5-year figures by about $5,000 a year). At the break-even price above it pays for itself; above that it costs you money.",
        "Steadiness: with the add-on more evals pass, the first payout comes about 10 days sooner, and the worst 12 months and worst full year "
        "were better in this backtest. Those gains are the real case for it, though they may be partly noise too.",
        "If you take 5th payouts and go live instead, the add-on made less money, because passing sooner brings the first move live sooner.",
        "If you buy it, set the indicator's 'EVAL: consistency rule you bought' to 50%; without it, set 40% (or use the 40% edition).",
    ]
    for i, t in enumerate(verdict, 34):
        c = put(ad, f"A{i}", t)
        ad.merge_cells(f"A{i}:E{i}")
        c.alignment = Alignment(wrap_text=True, vertical="top")
        ad.row_dimensions[i].height = 30

    wb.move_sheet("Add-on check", offset=0)
    order = ["Read me", "Summary", "Add-on check", "Years", "Months", "Ledger", "Accounts", "Trades"]
    wb._sheets = [wb[n] for n in order]
    for w in wb.worksheets:
        w.sheet_view.showGridLines = w.title not in ("Read me",)
    wb.save(out)
    print("wrote", out, {w.title: w.max_row for w in wb.worksheets})


if __name__ == "__main__":
    main(sys.argv[1])

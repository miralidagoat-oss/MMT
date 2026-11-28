# Round 9 pre-registration: the funded overnight trade judged on a blind rebuild (written Nov 28 2026, before any result below)

## Why

Another assistant (the user's friend's) argues that ONR's settings were chosen with all of history visible, 2024-26
included, so every comparison on ONR as built flatters the parts that were tuned, the funded overnight trade most of
all. It rebuilt the strategy blind ("ONR-B"): every setting re-chosen by a fixed plateau rule on sessions before
2024-01-01. On its engine, skipping the funded overnight trade wins under ONR-B in its prop runs, while as built it
loses at Topstep 50K. It asks us to rerun our pools with its blind settings next to the as-built ones. This round does
that on the MNQ file, with the research's own account classes and rule.

## The versions (funded accounts; evaluations and Combines trade as built in every version)

- **As built:** v2.6.6's three legs. Overnight: S&P stretch score at least 0.7187, stop 0.5 ADR, taken only if its risk
  fits the day's budget. Pyramid: a 0.10 ADR drive, stop 0.35 ADR, add at +0.15, trail 0.25. IB: the 09:30-10:30 range,
  stop orders 10:30-13:00, stop 0.25 ADR, target 0.5 ADR, only the drive's side on drive days.
- **ONR-B (the note's blind settings):**
  - pyramid at a 0.05 ADR drive, stop 0.50 ADR, add at +0.10, trail 0.50;
  - IB of the 09:30-11:00 range, stop orders 11:00-14:00, stop 0.25 ADR, target 0.50 ADR, only the drive's side on
    ONR-B's drive days;
  - overnight cutoff at the 0.80 quantile of the absolute stretch score on sessions before 2024 (0.8985 on our S&P
    input, Feb 2011 - Dec 2023), stop 1.0 ADR, capped so that its risk fits the day's budget (the note's "capped by
    the daily loss limit": the stop is min(1.0 ADR, the budget / (contracts x $2)) points).
- **ONR-B with the honest IB (the note's standard; this one decides):** ONR-B with ONR's IB (09:30-10:30 range, orders
  to 13:00), on ONR-B's drive days.
- Each with and without the funded overnight trade. Contract sizes, the day's budget, payouts and every account rule as
  published.

## Accounts and windows

- **Decision accounts** (5 funded + 5 evaluations):
  - Topstep 50K (Standard payouts, No Activation Fee path);
  - Lucid 50K with the add-on;
  - Lucid 25K with the 40% rule (the slow start's first account).
  - Lucid accounts are closed after their 4th payout.
- **Reported, not decided on:** Lucid 50K with the 40% rule.
- **Windows:** 12 start dates as in round 7.
  - Decision windows: the last 5 years (Nov 15 2021 - Nov 20 2026) and Dec 2019 - Nov 2021.
  - Reported: 2024 - Nov 20 2026.
  - Reported: the note's own design, 25 monthly starts Nov 2021 - Nov 2023, 3 years each, total net.

## Rule

- **Noise bands:** 8 placebo runs of ONR-B with the honest IB, with the overnight trade, per account and window: the
  overnight cutoff at 0.8920 / 0.8950 / 0.9020 / 0.9050 (round 7's placebo spread around ONR's 0.7187) and the size
  reference at 340 / 345 / 355 / 360. The band is the largest placebo move.
- **Decision:** the default "keep the overnight trade in funded accounts" changes to "skip" only if, under ONR-B with the
  honest IB, skipping passes rule 5Y against keeping in all three decision accounts:
  - over the last 5 years it beats keeping by more than the band on net a year or on the worst full year, without the
    other falling by more than its band;
  - and Dec 2019 - Nov 2021 is not worse than its band on either.
- As-built and ONR-B (90-minute IB) results are reported beside it and decide nothing. If the rule passes, the indicator's
  skip switch defaults to on for funded and live accounts; otherwise nothing changes. The result is reported either way.

## Checks before any result

- With the book's legs, the new account class reproduces round 7's account class event for event. As built, with and
  without the overnight trade, it reproduces `results_r7/skip_accounts.csv`:
  - Topstep 50K $73,075 / $69,742 a year;
  - Lucid 50K add-on $58,262 / $53,831.
- Each ONR-B leg at 1 contract equals `engine.pyramid` / `ib_breakout` / `funded_on` with ONR-B's settings, session by
  session.

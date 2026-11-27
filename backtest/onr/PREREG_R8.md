# Round 8 pre-registration: the overnight trade's charge to the day budget (written Nov 27 2026, before any result below)

## The question

A funded account reserves the overnight trade's risk (0.5 ADR x N x $2) in the day budget for the whole session, so it
can crowd out the 09:35 and 10:30 legs. The variant **AL** charges the overnight trade's actual loss instead.
- The trade itself is unchanged: same signal, same 18:10 entry check with its full risk, same stop and 09:30 exit.
- When it closes (its stop overnight, or 09:30), its charge to the day budget becomes its realized loss, commission
  included: max(0, -P&L). A winning or flat trade then charges nothing.
- The later legs get what is left, in the usual order: pyramid, ORB (where it is on), IB.
- Evals and Combines are unchanged.

**Already seen** (`check_actual_loss.py`, Nov 27 2026). Topstep 50K without the ORB leg, MNQ file: last 5 years
$80,022 a year against $73,075, worst full year $61,657 against $47,523, Dec 2019 - Nov 2021 $61,731 against $65,030.
Funded accounts alone reached a payout no more often (NQ CFD 2016-20 58.8% against 59.7%; MNQ 2021-26 51.8% against
53.6%). These results are not part of the decision.

## What is tested

The user's plan accounts, traded as indicator v2.7.1 trades them by default:

| Account | Setup | ORB leg |
|---|---|---|
| A1 | Topstep 50K: 5 XFAs + 5 Combines, Standard payouts, No Activation Fee path | on |
| A2 | Topstep 150K: the same | on |
| A3 | Lucid 50K with the 50% add-on: 5 funded + 5 evals, each closed after its 4th payout | off |
| A4 | Lucid 50K with the 40% rule, otherwise as A3 (reported, not part of the decision) | off |

**Decision data: the MNQ file.**
- Round 7's account harness (`r7_accounts.py`: per-contract legs, the published account rules, $1.00 a round turn,
  12 start dates).
- Rule 5Y as in round 7, against the same setup without AL:
  - over the last 5 years, AL beats it by more than the band on net a year or on the worst full year;
  - without the other measure falling by more than its band;
  - and Dec 2019 - Nov 2021 is not worse than its band on either.
- Noise bands: round 7's placebo bands for that account (`results_r7/accounts.csv`; for 150K,
  `results_r7/v27_topstep_sizes.csv`).

**Holdout: the Nasdaq-100 CFD, Feb 2011 - Dec 2019.** No test of AL has used it.
- A1 and A3 without the ORB leg, which is not built on the CFD's engine path; full years 2012-2019.
- Same 12 start dates.
- Noise bands from 8 placebo runs on the same window: thresholds 0.712 / 0.715 / 0.722 / 0.725 and size references
  340 / 345 / 355 / 360, as in round 7.
- No-harm test: AL's net a year and worst full year are each not worse than the book's by more than their band.

**Decision:** AL becomes the indicator's default only if:
- rule 5Y passes on the MNQ file in A1, A2 and A3;
- the holdout passes in A1 and A3.

Otherwise nothing changes, and the result is reported either way. The 1-tick stress (1 tick of slippage on every
fill) and A4 are reported, not decided on.

## Checks before any result

- With AL off, the round-7 account class and the published account class (CFD holdout) each reproduce their
  published counterpart event for event.
- The book's published figures are reproduced: Topstep 50K $73,075 a year, 150K $136,013, Lucid add-on $58,262,
  Lucid 40% $55,669; with the ORB leg, Topstep 50K $90,515 and 150K $185,383.

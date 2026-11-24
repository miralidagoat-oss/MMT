"""The backtests' windows on the user's MNQ file (prep_mnq.py, Dec 1 2019 - Nov 20 2026): every script that labels a
window reads them here, and check() asserts them against the data it loaded."""
import datetime as dt

import numpy as np

START5 = "2021-11-15"   # the last 5 years (research rule 5Y)
FIRST = "2019-12-20"    # the MNQ file's first tradable session (14 full sessions for the average range)
LAST = "2026-11-20"     # its last session


def md(iso):
    """'2019-12-20' -> 'Dec 20'."""
    d = dt.date.fromisoformat(iso)
    return f"{d:%b} {d.day}"


FIRST_MD, LAST_MD = md(FIRST), md(LAST)          # "Dec 20", "Nov 20"
SINCE = f"from {FIRST_MD} {FIRST[:4]}"             # "from Dec 20 2019"
TO = f"to {LAST_MD}"                               # "to Nov 20"
FULL_YEARS_ALL = [str(y) for y in range(int(FIRST[:4]) + 1, int(LAST[:4]))]    # 2020-2025
FULL_YEARS_5Y = [str(y) for y in range(int(START5[:4]) + 1, int(LAST[:4]))]    # 2022-2025


def full_years_only(full5):
    """research5.FULL5 (period -> the calendar years its worst and losing full years count) on the MNQ file: only the
    years the file covers whole, 2020-2025, ever count (2019 is Dec 20-31 only, 2026 ends Nov 20). Changed in place,
    before research5.run_jobs forks its workers."""
    for lab in full5:
        full5[lab] = [y for y in full5[lab] if FIRST[:4] < y < LAST[:4]]
    return full5


def check(S):
    """The data's first tradable and last sessions are the ones the labels name."""
    ok = [not np.isnan(S.S[d]["adr"]) and not np.isnan(S.S[d]["score"]) for d in S.days]
    first = str(np.datetime64(int(S.days[int(np.argmax(ok))]), "D"))
    last = str(np.datetime64(int(S.days[-1]), "D"))
    assert (first, last) == (FIRST, LAST), (first, last, FIRST, LAST)

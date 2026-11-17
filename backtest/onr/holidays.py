"""US equity holiday / early-close calendar by rule (mirrors f_halfDay in indicators/onr_book.pine).
half_day(date) -> True when CME equity futures stop at ~13:00-13:15 ET that session (federal-holiday half
sessions and NYSE early-close days). Good Friday / Christmas / New Year's Day sessions don't exist at all."""
import datetime as dt


def nth_weekday(y, m, wd, n):
    d = dt.date(y, m, 1)
    d += dt.timedelta(days=(wd - d.weekday()) % 7)
    return d + dt.timedelta(weeks=n - 1)


def last_weekday(y, m, wd):
    d = (dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1))
    return d - dt.timedelta(days=(d.weekday() - wd) % 7)


def observed(d):
    return d - dt.timedelta(days=1) if d.weekday() == 5 else (d + dt.timedelta(days=1) if d.weekday() == 6 else d)


def half_day(d):
    y = d.year
    hol = {nth_weekday(y, 1, 0, 3), nth_weekday(y, 2, 0, 3), last_weekday(y, 5, 0), observed(dt.date(y, 7, 4)),
           nth_weekday(y, 9, 0, 1), nth_weekday(y, 11, 3, 4)}
    if y >= 2022:
        hol.add(observed(dt.date(y, 6, 19)))
    early = {nth_weekday(y, 11, 3, 4) + dt.timedelta(days=1)}
    if dt.date(y, 12, 24).weekday() < 5 and observed(dt.date(y, 12, 25)) != dt.date(y, 12, 24):
        early.add(dt.date(y, 12, 24))
    j3 = dt.date(y, 7, 3)
    if j3.weekday() < 5 and observed(dt.date(y, 7, 4)) != j3:
        early.add(j3)
    return d in hol or d in early

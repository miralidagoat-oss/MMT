#!/usr/bin/env python3
"""Shared Yahoo Finance access: cookie/crumb handshake, daily bars, option chains.

Yahoo's v7 options endpoint returns 401 without a crumb. The crumb is minted
against a cookie you get by touching any Yahoo host first, so every caller has to
do the same two-step dance; it lives here rather than in each script.

Stdlib only, to match the rest of this repo (no numpy/pandas anywhere).
"""
import http.cookiejar
import json
import time
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
HEADERS = {"User-Agent": UA}

_opener = None
_crumb = None


def _session():
    """Build a cookie-bearing opener and mint a crumb. Cached for the process."""
    global _opener, _crumb
    if _opener is not None and _crumb:
        return _opener, _crumb
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    # fc.yahoo.com 404s but sets the A1/A3 cookies the crumb is bound to.
    try:
        op.open(urllib.request.Request("https://fc.yahoo.com", headers=HEADERS), timeout=25).read()
    except Exception:
        pass
    crumb = op.open(
        urllib.request.Request("https://query1.finance.yahoo.com/v1/test/getcrumb", headers=HEADERS),
        timeout=25).read().decode().strip()
    if not crumb or len(crumb) > 32:
        raise RuntimeError("could not mint a Yahoo crumb (got %r)" % crumb[:40])
    _opener, _crumb = op, crumb
    return op, crumb


def _get(url, tries=4):
    op, _ = _session()
    last = None
    for i in range(tries):
        try:
            with op.open(urllib.request.Request(url, headers=HEADERS), timeout=30) as r:
                return json.loads(r.read())
        except Exception as e:            # noqa: BLE001 - retry anything transient
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError("GET failed after %d tries: %s (%s)" % (tries, url, last))


def daily_bars(symbol, start="2000-01-01", end=None):
    """[(epoch_sec, o, h, l, c), ...] ascending, null candles dropped.

    Uses explicit period1/period2 rather than range=max: with range=max Yahoo
    silently downsamples an interval=1d request to monthly, which looks like a
    successful daily fetch and is off by a factor of 20 in sample count.
    """
    import calendar as _cal
    import datetime as _dt

    def _epoch(d):
        return _cal.timegm(_dt.date.fromisoformat(d).timetuple())

    p1 = _epoch(start)
    p2 = int(time.time()) + 86400 if end is None else _epoch(end)
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/"
           + urllib.parse.quote(symbol)
           + "?interval=1d&period1=%d&period2=%d" % (p1, p2))
    res = _get(url)["chart"]["result"][0]
    ts = res["timestamp"]
    q = res["indicators"]["quote"][0]
    out = []
    for i, t in enumerate(ts):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if None in (o, h, l, c):
            continue
        out.append((int(t), float(o), float(h), float(l), float(c)))
    out.sort(key=lambda r: r[0])
    return out


def option_expiries(symbol):
    _, crumb = _session()
    url = ("https://query1.finance.yahoo.com/v7/finance/options/"
           + urllib.parse.quote(symbol) + "?crumb=" + urllib.parse.quote(crumb))
    r = _get(url)["optionChain"]["result"][0]
    spot = r.get("quote", {}).get("regularMarketPrice")
    return [int(e) for e in r.get("expirationDates", [])], (float(spot) if spot else None)


def option_chain(symbol, expiry_epoch):
    """(calls, puts) for one expiry. Each row: strike, openInterest, impliedVolatility."""
    _, crumb = _session()
    url = ("https://query1.finance.yahoo.com/v7/finance/options/"
           + urllib.parse.quote(symbol)
           + "?date=" + str(int(expiry_epoch))
           + "&crumb=" + urllib.parse.quote(crumb))
    r = _get(url)["optionChain"]["result"][0]
    opts = r.get("options") or [{}]
    return opts[0].get("calls", []) or [], opts[0].get("puts", []) or []

#!/usr/bin/env python3
"""V3 CME NQ data pricing — METADATA ONLY. Retrieves ZERO historical records.

Authorized endpoints are enforced at runtime by an exact-match allow-list in
ONE chokepoint (`Guarded.call`). timeseries.get_range, timeseries.get_range_async
and batch.submit_job are unreachable through this module: the guard raises
before any network call, which `test_v3_pricing_guard.py` proves with a network
spy rather than by trusting programmer intention.

API contract, verified against the installed client (databento 0.86.0):

    metadata.get_cost(dataset, start, end, mode, symbols, schema, stype_in, limit) -> float
    metadata.get_record_count(dataset, start, end, symbols, schema, stype_in, limit) -> int
    metadata.get_billable_size(dataset, start, end, symbols, schema, stype_in, limit) -> int

`mode` EXISTS on get_cost in this version (an earlier note in this project said
it was undocumented; that was wrong). It is still NOT sent: it is absent from
get_record_count and get_billable_size, and the three quotes must describe ONE
identical query. The common field set is therefore:

    dataset, start, end, symbols, schema, stype_in

start is INCLUSIVE, end is EXCLUSIVE.
"""
import datetime as dt, json, os, sys

DATASET = "GLBX.MDP3"

ALLOWED_ENDPOINTS = frozenset({
    "metadata.get_cost", "metadata.get_record_count", "metadata.get_billable_size",
    "metadata.get_dataset_range", "metadata.get_dataset_condition",
    "metadata.list_schemas", "metadata.list_datasets", "metadata.list_unit_prices",
})

BLOCKED_NAMESPACES = ("timeseries", "batch", "symbology", "reference")


class EndpointNotAuthorized(RuntimeError):
    """Raised BEFORE any network call for an endpoint this turn cannot use."""


class MetadataShapeError(RuntimeError):
    """The API returned an unexpected type. Fail closed; never coerce."""


class Guarded:
    """The single chokepoint. Nothing reaches the network except through call()."""

    def __init__(self, client):
        self._c = client
        self.sent = []

    def call(self, path, **fields):
        if path not in ALLOWED_ENDPOINTS:
            raise EndpointNotAuthorized(
                f"{path!r} is not authorized this turn; allowed: "
                f"{sorted(ALLOWED_ENDPOINTS)}")
        ns, meth = path.split(".", 1)
        if ns in BLOCKED_NAMESPACES:
            raise EndpointNotAuthorized(f"namespace {ns!r} is blocked")
        self.sent.append({"endpoint": path, "fields": dict(fields)})
        return getattr(getattr(self._c, ns), meth)(**fields)

    def __getattr__(self, name):
        if name in BLOCKED_NAMESPACES:
            raise EndpointNotAuthorized(
                f"direct access to {name!r} is blocked; only metadata pricing "
                "is authorized")
        raise AttributeError(name)


def _num(v, path, kind):
    """Fail closed on an unexpected shape; never coerce an ambiguous value."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise MetadataShapeError(
            f"{path} returned {type(v).__name__} for {kind}, expected a number")
    if v != v or v < 0:
        raise MetadataShapeError(f"{path} returned a non-finite/negative {kind}")
    return v


def quote(g, label, *, symbols, schema, stype_in, start, end, exact_outright,
          notes=""):
    """ONE identical query priced three ways. No field differs between them."""
    q = dict(dataset=DATASET, start=start, end=end, symbols=symbols,
             schema=schema, stype_in=stype_in)
    cost = _num(g.call("metadata.get_cost", **q), "metadata.get_cost", "usd")
    recs = _num(g.call("metadata.get_record_count", **q),
                "metadata.get_record_count", "records")
    size = _num(g.call("metadata.get_billable_size", **q),
                "metadata.get_billable_size", "bytes")
    gb = size / 1e9
    return {"package": label, "market": symbols, "schema": schema,
            "date_range": f"{start} .. {end} (end exclusive)",
            "symbol_scope": f"{symbols} (stype_in={stype_in})",
            "outright_exact": exact_outright,
            "records": int(recs), "billable_bytes": int(size),
            "gb": round(gb, 4), "usd": round(cost, 2),
            "usd_per_gb": round(cost / gb, 2) if gb > 0 else None,
            "request_fields": q, "notes": notes}


FULL = ("2019-01-01", "2026-09-14")
Y5 = ("2021-09-14", "2026-09-14")
Y3 = ("2023-09-14", "2026-09-14")

PARENT_NOTE = ("PARENT UPPER-BOUND / MIXED-INSTRUMENT QUOTE - NQ.FUT parent "
               "symbology can include exchange-traded calendar spreads, so this "
               "is an upper bound, not the expected amount payable. EXACT "
               "OUTRIGHT COST PENDING DEFINITION DISCOVERY.")


def price_all(g):
    rows = []
    # coverage first, via catalog endpoints only
    rng = g.call("metadata.get_dataset_range", dataset=DATASET)
    cond = g.call("metadata.get_dataset_condition", dataset=DATASET,
                  start_date=FULL[0], end_date=FULL[1])
    schemas = g.call("metadata.list_schemas", dataset=DATASET)

    # definition discovery (priced, NOT retrieved)
    rows.append(quote(g, "DEFINITION-DISCOVERY", symbols="NQ.FUT",
                      schema="definition", stype_in="parent",
                      start=FULL[0], end=FULL[1], exact_outright="N/A",
                      notes="prices the discovery query itself; records NOT retrieved"))
    # B0 primary, three history depths
    for lab, (s, e) in (("B0-3y", Y3), ("B0-5y", Y5), ("B0-full", FULL)):
        rows.append(quote(g, lab, symbols="NQ.FUT", schema="ohlcv-1m",
                          stype_in="parent", start=s, end=e,
                          exact_outright="NO", notes=PARENT_NOTE))
    # B1 roll-support alternative
    rows.append(quote(g, "B1-ohlcv-1h-alt", symbols="NQ.FUT", schema="ohlcv-1h",
                      stype_in="parent", start=FULL[0], end=FULL[1],
                      exact_outright="NO",
                      notes="priced only as a cheaper alternative; "+PARENT_NOTE))
    # A tiers
    for lab, sch in (("A1-trades", "trades"), ("A2-mbp-1", "mbp-1"),
                     ("A3-mbo", "mbo")):
        rows.append(quote(g, lab, symbols="NQ.FUT", schema=sch,
                          stype_in="parent", start=FULL[0], end=FULL[1],
                          exact_outright="NO", notes=PARENT_NOTE))
    # C cross-market
    for lab, sym in (("C-NQ-1m", "NQ.FUT"), ("C-ES-1m", "ES.FUT")):
        rows.append(quote(g, lab, symbols=sym, schema="ohlcv-1m",
                          stype_in="parent", start=FULL[0], end=FULL[1],
                          exact_outright="NO", notes=PARENT_NOTE))
    return {"dataset_range": rng, "dataset_condition_sample": cond,
            "schemas_available": schemas, "quotes": rows,
            "billable_fetches": 0, "historical_records_downloaded": 0}


def main():
    key = os.environ.get("DATABENTO_API_KEY", "").strip()
    if not key:
        sys.exit("HALT: DATABENTO_API_KEY is not set in this environment. "
                 "Metadata pricing cannot execute. Nothing was called.")
    import databento as db
    g = Guarded(db.Historical(key))
    out = price_all(g)
    out["endpoints_called"] = sorted({x["endpoint"] for x in g.sent})
    json.dump(out, open("research/V3_PRICING.json", "w"), indent=2, default=str)
    print(json.dumps(out["quotes"], indent=2, default=str))
    print("-> research/V3_PRICING.json")


if __name__ == "__main__":
    main()

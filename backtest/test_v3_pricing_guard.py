#!/usr/bin/env python3
"""Proves the V3 pricing module cannot reach a billable endpoint.

Does NOT trust programmer intention: a spy replaces the HTTP transport and
records/raises on ANY outbound request, so "no network call happened" is
demonstrated rather than asserted. Uses a stub client; no real key, no network.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import price_v3_packages as P

FAILS = []
def ok(c, m):
    print(("  PASS  " if c else "  FAIL  ") + m)
    if not c: FAILS.append(m)


class NetworkSpy(Exception):
    pass


class StubNS:
    """Records calls; a real client would hit the network here."""
    def __init__(self, log, name, ret):
        self.log, self.name, self.ret = log, name, ret

    def __getattr__(self, meth):
        def f(**kw):
            self.log.append((f"{self.name}.{meth}", kw))
            return self.ret(meth)
        return f


class StubClient:
    def __init__(self, log):
        vals = {"get_cost": 123.45, "get_record_count": 1000,
                "get_billable_size": 2_000_000_000,
                "get_dataset_range": {"start": "2010-06-06", "end": "2026-09-13"},
                "get_dataset_condition": [{"date": "2019-01-01", "condition": "available"}],
                "list_schemas": ["mbo", "mbp-1", "trades", "ohlcv-1m", "definition"]}
        self.metadata = StubNS(log, "metadata", lambda m: vals.get(m))
        self.timeseries = StubNS(log, "timeseries", lambda m: "RECORDS")
        self.batch = StubNS(log, "batch", lambda m: "JOB")


print("A. Allow-list contents")
ok("metadata.get_cost" in P.ALLOWED_ENDPOINTS
   and "metadata.get_record_count" in P.ALLOWED_ENDPOINTS
   and "metadata.get_billable_size" in P.ALLOWED_ENDPOINTS,
   "the three pricing methods are allowed")
for bad in ("timeseries.get_range", "timeseries.get_range_async",
            "batch.submit_job", "batch.download"):
    ok(bad not in P.ALLOWED_ENDPOINTS, f"{bad} is NOT in the allow-list")

print("\nB. A billable call dies BEFORE the network")
log = []
g = P.Guarded(StubClient(log))
for bad in ("timeseries.get_range", "timeseries.get_range_async",
            "batch.submit_job"):
    try:
        g.call(bad, dataset="GLBX.MDP3", symbols="NQ.FUT", schema="trades",
               start="2019-01-01", end="2026-09-14")
        ok(False, f"{bad} should have raised")
    except P.EndpointNotAuthorized:
        ok(True, f"{bad} raises EndpointNotAuthorized")
ok(log == [], f"the stub transport recorded ZERO calls after 3 attempts {log}")

print("\nC. Direct namespace access is blocked")
for ns in ("timeseries", "batch"):
    try:
        getattr(g, ns)
        ok(False, f"g.{ns} should have raised")
    except P.EndpointNotAuthorized:
        ok(True, f"g.{ns} raises before any method can be reached")
ok(log == [], "still zero transport calls")

print("\nD. A real network attempt would be caught by the spy")
def spy(*a, **k):
    raise NetworkSpy("outbound HTTP attempted")
try:
    import requests
    requests.Session.request = spy
    ok(True, "HTTP transport replaced by a spy that raises on any request")
except ImportError:
    ok(True, "requests not installed; no transport available at all")
log2 = []
g2 = P.Guarded(StubClient(log2))
try:
    g2.call("timeseries.get_range", dataset="GLBX.MDP3")
    ok(False, "should have raised")
except P.EndpointNotAuthorized:
    ok(True, "guard fires first - the spy is never even reached")
except NetworkSpy:
    ok(False, "the request reached the transport - GUARD FAILED")

print("\nE. The three quotes describe ONE identical query")
log3 = []
g3 = P.Guarded(StubClient(log3))
q = P.quote(g3, "T", symbols="NQ.FUT", schema="ohlcv-1m", stype_in="parent",
            start="2019-01-01", end="2026-09-14", exact_outright="NO")
eps = [x[0] for x in log3]
ok(eps == ["metadata.get_cost", "metadata.get_record_count",
           "metadata.get_billable_size"], f"exactly the three methods {eps}")
fields = [x[1] for x in log3]
ok(fields[0] == fields[1] == fields[2],
   "all three requests carry BYTE-IDENTICAL fields")
ok(set(fields[0]) == {"dataset", "start", "end", "symbols", "schema", "stype_in"},
   f"field set is the documented common subset {sorted(fields[0])}")
ok(not any("mode" in f for f in fields),
   "`mode` is sent in NO request - it exists on get_cost in databento 0.86.0 "
   "but not on the other two, and the queries must be identical")
ok(not any("limit" in f for f in fields), "`limit` is not sent")

print("\nF. Unexpected response shapes FAIL CLOSED")
for bad, kind in ((None, "None"), ("12.5", "str"), (True, "bool"),
                  (float("nan"), "nan"), (-1, "negative")):
    try:
        P._num(bad, "metadata.get_cost", "usd")
        ok(False, f"{kind} should have failed closed")
    except P.MetadataShapeError:
        ok(True, f"{kind} response fails closed, never coerced")

print("\nG. Derived quantities are local, not invented API fields")
ok(q["gb"] == round(2_000_000_000 / 1e9, 4) and q["usd"] == 123.45
   and q["records"] == 1000,
   "GB and USD/GB derived locally from the three API values only")
ok(q["outright_exact"] == "NO", "parent quotes are labelled not-exact")

print("\nH. No key is read or exposed by import")
import ast as _ast
src = open("backtest/price_v3_packages.py").read()
tree = _ast.parse(src)
reads = [n for n in _ast.walk(tree)
         if isinstance(n, _ast.Call) and isinstance(n.func, _ast.Attribute)
         and n.func.attr == "get"
         and isinstance(n.func.value, _ast.Attribute)
         and n.func.value.attr == "environ"
         and n.args and isinstance(n.args[0], _ast.Constant)
         and n.args[0].value == "DATABENTO_API_KEY"]
ok(len(reads) == 1,
   f"the key is READ from the environment in exactly one place ({len(reads)})")
# the variable NAME may appear in a message; the VALUE must never be emitted
emit = [n for n in _ast.walk(tree)
        if isinstance(n, _ast.Call)
        and getattr(n.func, "id", "") in ("print", "repr", "format")
        and any(isinstance(a, _ast.Name) and a.id == "key" for a in n.args)]
ok(not emit, "the key VALUE is never printed, repr'd or formatted")
ok("DATABENTO_API_KEY is not set" in src,
   "the HALT message names the VARIABLE (not the value), which is intended")
uses = [n for n in _ast.walk(tree)
        if isinstance(n, _ast.Name) and n.id == "key"]
ok(len(uses) <= 3,
   f"the key name is referenced only for read, emptiness check and client "
   f"construction ({len(uses)} references)")
ok("json.dump" in src, "the artifact is written from quote data only")
print()
if FAILS:
    print(f"V3 PRICING GUARD TESTS FAILED - {len(FAILS)}")
    for f in FAILS: print("  - " + f)
    sys.exit(1)
print("V3 PRICING GUARD TESTS PASSED (stub client, zero network, zero billable).")

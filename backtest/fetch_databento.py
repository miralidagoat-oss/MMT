#!/usr/bin/env python3
"""Ingest multi-year NQ futures 1-minute OHLCV with contract identity.

Reads the API key from the DATABENTO_API_KEY environment variable. The key is
never accepted as an argument, never logged, and never written to disk.

    export DATABENTO_API_KEY=...        # not echoed into the shell history
    python3 backtest/fetch_databento.py data_nq_deep 2019-01-01 2026-09-01

Why this dataset:
  GLBX.MDP3 is CME Globex MDP 3.0 - the exchange's own feed, so it carries the
  full Globex session including the overnight that this strategy depends on.
  Requesting stype_in=parent with symbol NQ.FUT returns EVERY individual
  contract rather than a stitched continuous series, which is what section 3 of
  the research protocol requires: raw traded prices at their real historical
  levels, never back-adjusted.

Two schemas are pulled:
  ohlcv-1m    ts_event, instrument_id, open, high, low, close, volume
  definition  instrument_id -> raw_symbol, expiration, activation
The definition schema is what turns an opaque instrument_id into NQZ25 plus its
expiry, which the roll engine needs.
"""
import csv, gzip, io, json, os, sys, urllib.error, urllib.request

HOST = "https://hist.databento.com/v0"
DATASET = "GLBX.MDP3"
PARENT = "NQ.FUT"


def key():
    k = os.environ.get("DATABENTO_API_KEY", "").strip()
    if not k:
        sys.exit("DATABENTO_API_KEY is not set.\n"
                 "  export DATABENTO_API_KEY=...   (do not paste it into a prompt)\n"
                 "Then re-run. Nothing else in this repo needs the key.")
    return k


def post(path, fields, k):
    import base64
    body = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(f"{HOST}/{path}", data=body, method="POST")
    tok = base64.b64encode(f"{k}:".encode()).decode()
    req.add_header("Authorization", f"Basic {tok}")
    req.add_header("Accept-Encoding", "gzip")
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            raw = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            return raw
    except urllib.error.HTTPError as e:
        detail = e.read()[:400].decode("utf-8", "replace")
        sys.exit(f"Databento HTTP {e.code} on {path}: {detail}")


def cost(start, end, k):
    """Always price the request before spending anything."""
    for schema in ("ohlcv-1m", "definition"):
        out = post("metadata.get_cost", dict(
            dataset=DATASET, symbols=PARENT, stype_in="parent",
            schema=schema, start=start, end=end, mode="historical-streaming"), k)
        print(f"  {schema:<12} estimated cost: {out.decode().strip()} USD")


def fetch(schema, start, end, k):
    return post("timeseries.get_range", dict(
        dataset=DATASET, symbols=PARENT, stype_in="parent", schema=schema,
        start=start, end=end, encoding="csv", pretty_ts="false"), k)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "data_nq_deep"
    start = sys.argv[2] if len(sys.argv) > 2 else "2019-01-01"
    end = sys.argv[3] if len(sys.argv) > 3 else "2026-09-01"
    k = key()
    os.makedirs(out, exist_ok=True)
    print(f"NQ.FUT {start} -> {end}  (all individual contracts, no adjustment)")
    cost(start, end, k)
    if os.environ.get("DATABENTO_CONFIRM") != "yes":
        sys.exit("\nCost shown above. Re-run with DATABENTO_CONFIRM=yes to download.")
    for schema, name in (("definition", "definitions.csv"), ("ohlcv-1m", "ohlcv_1m.csv")):
        print(f"  downloading {schema} ...", flush=True)
        raw = fetch(schema, start, end, k)
        with open(os.path.join(out, name), "wb") as f:
            f.write(raw)
        print(f"    -> {out}/{name}  ({len(raw)/1e6:.1f} MB)")
    with open(os.path.join(out, "PROVENANCE.json"), "w") as f:
        json.dump(dict(source="Databento Historical API", dataset=DATASET,
                       symbol=PARENT, stype_in="parent",
                       schemas=["ohlcv-1m", "definition"], start=start, end=end,
                       adjustment="none - raw individual contracts",
                       roll="not applied here; see research/ROLL_POLICY.md"), f, indent=2)
    print("\nNext: python3 backtest/build_continuous.py " + out)

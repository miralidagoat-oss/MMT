// Tests for domLevels.js — run with:  node --test tradovate-dom/test/
//
// The Tradovate side is faked at the transport level: a fake WebSocket class
// that speaks Tradovate's frame protocol (o / h / a[...] / c[...], newline
// requests, authorize handshake) and a fake fetch for the REST endpoints, with
// payload shapes taken from Tradovate's official API examples and swagger spec.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const m = require("../domLevels.js");

const T0 = Date.parse("2026-10-16T13:30:00Z");
const iso = ms => new Date(T0 + ms).toISOString();

// ── engine helpers ───────────────────────────────────────────────────────────

// A 10-deep book around best bid `bb` (price), every level `base` contracts,
// with `extra` = { price: size } added on either side.
function book(ms, bb, extra, opts) {
    const tick = 0.25;
    const base = (opts && opts.base) || 20;
    const depth = (opts && opts.depth) || 10;
    const bids = [];
    const offers = [];
    for (let i = 0; i < depth; ++i) {
        const b = Number((bb - i * tick).toFixed(2));
        const a = Number((bb + (i + 1) * tick).toFixed(2));
        bids.push({ price: b, size: base + ((extra && extra[b]) || 0) });
        offers.push({ price: a, size: base + ((extra && extra[a]) || 0) });
    }
    return { contractId: 7, timestamp: iso(ms), bids, offers };
}

function quote(ms, price, total) {
    return {
        contractId: 7,
        timestamp: iso(ms),
        entries: { Trade: { price, size: 1 }, TotalTradeVolume: { size: total } }
    };
}

function engine(settings) {
    const e = new m.LevelEngine(Object.assign({ tick: 0.25 }, settings || {}));
    const events = [];
    e.onEvent(ev => events.push(ev));
    return { e, events, types: () => events.map(ev => ev.type + "@" + ev.priceText) };
}

// Feed the same book every 500ms from `from` to `to` (ms).
function hold(e, from, to, bb, extra) {
    for (let t = from; t <= to; t += 500) {
        e.onDom(book(t, bb, extra));
    }
}

// ── engine ───────────────────────────────────────────────────────────────────

test("engine: a wall becomes a level only after persisting persistSec", () => {
    const { e, types } = engine();
    hold(e, 0, 9000, 21000, { 20998: 200 });
    assert.deepStrictEqual(types(), [], "not before 10s");
    hold(e, 9500, 10500, 21000, { 20998: 200 });
    assert.deepStrictEqual(types(), ["born@20998.00"]);
    const lvl = e.snapshot().levels[0];
    assert.strictEqual(lvl.name, "S1");
    assert.strictEqual(lvl.role, "support");
    assert.strictEqual(lvl.size, 220);
});

test("engine: a flash (wall gone before persistSec) is ignored and counted", () => {
    const { e, types } = engine();
    hold(e, 0, 4000, 21000, { 21001: 300 });
    hold(e, 4500, 20000, 21000, {});
    assert.deepStrictEqual(types(), []);
    assert.strictEqual(e.flashes, 1);
    assert.strictEqual(e.snapshot().levels.length, 0);
});

test("engine: wall cancelled without trades is PULLED and remembered", () => {
    const { e, types, events } = engine();
    hold(e, 0, 12000, 21000, { 21002: 300 });
    hold(e, 12500, 16000, 21000, {});
    assert.deepStrictEqual(types(), ["born@21002.00", "pulled@21002.00"]);
    assert.strictEqual(events[1].filled, 0);
    assert.strictEqual(e.pullHistory.get("ask:84008"), 1);
    // a new wall at the same price carries the history
    hold(e, 16500, 30000, 21000, { 21002: 300 });
    const r = e.snapshot().levels.find(l => l.side === "ask");
    assert.strictEqual(r.pulledHereBefore, 1);
    assert.match(m.levelLabel(r), /pulled here 1x before/);
});

test("engine: wall consumed by trades is FILLED, even if prints lag the book", () => {
    const { e, types, events } = engine();
    let vol = 1000;
    e.onQuote(quote(0, 21000, vol));
    hold(e, 0, 12000, 21000, { 20999: 300 });   // bid wall 4 ticks below
    // price comes down; the book shows the wall gone at 13000 ...
    e.onDom(book(13000, 20999, {}));
    // ... and the 300 lots that traded there arrive 800ms later
    vol += 300;
    e.onQuote(quote(13800, 20999, vol));
    hold(e, 14000, 16000, 20999, {});
    assert.deepStrictEqual(types(), ["born@20999.00", "filled@20999.00"]);
    assert.strictEqual(events[1].filled, 300);
});

test("engine: a small drop above endRatio does not end the level", () => {
    const { e, types } = engine();
    hold(e, 0, 12000, 21000, { 20998: 300 });
    hold(e, 12500, 20000, 21000, { 20998: 150 });   // 170 >= 0.6 × 60 threshold
    assert.deepStrictEqual(types(), ["born@20998.00"]);
});

test("engine: HELD after a test and a bounce, BROKEN when traded through", () => {
    const { e, types } = engine();
    let vol = 1000;
    hold(e, 0, 12000, 21000, { 20999: 300 });
    e.onQuote(quote(12100, 20999.25, vol += 5));     // within 1 tick: touched
    e.onQuote(quote(12200, 21000.25, vol += 5));     // 5 ticks up: held
    assert.deepStrictEqual(types(), ["born@20999.00", "held@20999.00"]);
    assert.strictEqual(e.snapshot().levels[0].holds, 1);
    e.onQuote(quote(12300, 20998.5, vol += 5));      // 2 ticks through: broken
    assert.deepStrictEqual(types().slice(-1), ["broken@20999.00"]);
    assert.strictEqual(e.levels.size, 0);
});

test("engine: resistance mirrors support (held then broken upward)", () => {
    const { e, types } = engine();
    let vol = 1;
    hold(e, 0, 12000, 21000, { 21001: 300 });
    e.onQuote(quote(12100, 21000.75, vol += 1));
    e.onQuote(quote(12200, 20999.75, vol += 1));
    e.onQuote(quote(12300, 21001.5, vol += 1));
    assert.deepStrictEqual(types(), ["born@21001.00", "held@21001.00", "broken@21001.00"]);
});

test("engine: out-of-view level is kept, re-verified, and expires after staleMin", () => {
    const { e, types } = engine({ staleMin: 1 });
    hold(e, 0, 12000, 21000, { 20998: 300 });
    // price rallies 20 ticks: 20998 is below the 10-deep bid window now
    hold(e, 12500, 30000, 21005, {});
    let lvl = e.snapshot().levels[0];
    assert.strictEqual(lvl.visible, false);
    assert.match(m.levelLabel(lvl), /out of view \(last 320/);
    // back in view and still there
    hold(e, 30500, 32000, 21000, { 20998: 300 });
    lvl = e.snapshot().levels[0];
    assert.strictEqual(lvl.visible, true);
    // out of view for more than a minute → expired
    hold(e, 32500, 100000, 21005, {});
    assert.deepStrictEqual(types(), ["born@20998.00", "stale@20998.00"]);
});

test("engine: timing uses message timestamps, not the wall clock (replay-safe)", () => {
    const { e, types } = engine();
    // 21 snapshots delivered instantly but stamped 0.5s apart (like 4x replay)
    hold(e, 0, 10000, 21000, { 20998: 300 });
    assert.deepStrictEqual(types(), ["born@20998.00"]);
    // out-of-order older timestamp never moves time backwards
    e.onDom(book(5000, 21000, { 20998: 300 }));
    assert.strictEqual(e.now, T0 + 10000);
});

test("engine: cumulative volume reset (new session) adds no fills", () => {
    const { e, events } = engine();
    e.onQuote(quote(0, 20999, 50000));
    hold(e, 0, 12000, 21000, { 20999: 300 });
    e.onQuote(quote(12100, 20999, 10));      // total dropped: rebase only
    e.onQuote(quote(12200, 20999, 30));      // +20 traded at the level
    assert.strictEqual(e.levels.get("bid:83996").filled, 20);
    assert.strictEqual(events.length, 1);
});

test("engine: infers the tick from the book and merges duplicate prices", () => {
    const e = new m.LevelEngine();
    e.onDom({ timestamp: iso(0), bids: [{ price: 4500.25, size: 5 }, { price: 4500.25, size: 7 }, { price: 4500, size: 3 }], offers: [{ price: 4500.5, size: 9 }] });
    assert.strictEqual(e.tick, 0.25);
    assert.strictEqual(e.bids.get(e.toTicks(4500.25)), 12);
    assert.strictEqual(e.fmtPrice(e.toTicks(4500.25)), "4500.25");
});

test("engine: corrects a mis-inferred tick when an off-grid price appears", () => {
    const e = new m.LevelEngine();
    e.onDom({ timestamp: iso(0), bids: [{ price: 100, size: 5 }], offers: [{ price: 100.5, size: 5 }] });
    assert.strictEqual(e.tick, 0.5);
    e.onDom({ timestamp: iso(500), bids: [{ price: 100.25, size: 5 }, { price: 100, size: 5 }], offers: [{ price: 100.5, size: 5 }] });
    assert.strictEqual(e.tick, 0.25);
    assert.match(e.warnings[0], /tick size corrected/);
});

test("engine: snapshot numbers levels nearest-first and caps levelsPerSide", () => {
    const { e } = engine({ levelsPerSide: 2 });
    e.onQuote(quote(0, 21000, 1));
    hold(e, 0, 12000, 21000, { 20999.5: 200, 20998.75: 500, 20998: 900, 21001: 400, 21002: 250 });
    const snap = e.snapshot(20);
    const names = snap.levels.map(l => l.name + " " + l.priceText);
    // strongest two bids are 20998.00 (920) and 20998.75 (520); S1 is the nearer
    assert.deepStrictEqual(names, ["S1 20998.75", "S2 20998.00", "R1 21001.00", "R2 21002.00"]);
    const row = snap.ladder.find(r => r.priceText === "20998.75");
    assert.strictEqual(row.level, "S1");
    assert.strictEqual(snap.ladder.find(r => r.last).priceText, "21000.00");
    assert.match(m.levelLabel(snap.levels[0]), /^S1 20998\.75 \| 520 resting \| \d+s$/);
});

test("engine: ABSORBING flag while a level is being hit", () => {
    const { e } = engine();
    let vol = 1;
    e.onQuote(quote(0, 21000, vol));                 // first print sets the volume baseline
    hold(e, 0, 12000, 21000, { 20999: 300 });
    e.onQuote(quote(12100, 20999, vol += 40));
    const lvl = e.snapshot().levels[0];
    assert.strictEqual(lvl.absorbing, true);
    assert.match(m.levelLabel(lvl), /40 filled .*<< ABSORBING$/);
});

test("engine: a level gone during a disconnect is EXPIRED, not called pulled", () => {
    const { e, types } = engine();
    e.onQuote(quote(0, 21000, 1000));
    hold(e, 0, 12000, 21000, { 20998: 300, 20999: 300 });
    e.markGap();
    // after reconnect: 20999 is still there, 20998 is gone; 50k contracts traded in the gap
    e.onQuote(quote(60000, 21000, 51000));
    hold(e, 60000, 63000, 21000, { 20999: 300 });
    assert.deepStrictEqual(types(), ["born@20999.00", "born@20998.00", "stale@20998.00"]);
    assert.strictEqual(e.levels.get("bid:83996").filled, 0, "gap volume is not counted as fills");
    assert.strictEqual(e.pullHistory.size, 0);
    // the surviving level is verified again and behaves normally afterwards
    hold(e, 63500, 64000, 21000, {});
    hold(e, 64500, 67000, 21000, {});
    assert.deepStrictEqual(types().slice(-1), ["pulled@20999.00"]);
});

test("engine: a pulled wall that price then runs through is PULLED, not BROKEN", () => {
    const { e, types } = engine();
    let vol = 1000;
    e.onQuote(quote(0, 21000, vol));
    hold(e, 0, 12000, 21000, { 21001: 300 });
    e.onDom(book(12500, 21000, {}));                    // wall vanishes, nothing traded there
    e.onQuote(quote(12800, 21001.75, vol += 20));       // 300ms later price runs 3 ticks through
    assert.deepStrictEqual(types(), ["born@21001.00", "pulled@21001.00"]);
});

test("engine: a consumed wall that price then runs through is FILLED, not BROKEN", () => {
    const { e, types } = engine();
    let vol = 1000;
    e.onQuote(quote(0, 21000, vol));
    hold(e, 0, 12000, 21000, { 21001: 300 });
    e.onQuote(quote(12100, 21001, vol += 280));         // 280 lots trade at the wall
    e.onDom(book(12500, 21000, {}));                    // and it is gone from the book
    e.onQuote(quote(12800, 21001.75, vol += 20));
    assert.deepStrictEqual(types(), ["born@21001.00", "filled@21001.00"]);
});

test("simulator: real wall holds, thin offer fills, spoof is pulled (8 seeds)", () => {
    [42, 7, 99, 123, 2024, 5, 6, 8].forEach(seed => {
        const sim = new m.Simulator({ tick: 0.25, start: T0, seed });
        const { e, events } = engine();
        for (let i = 0; i < 1400; ++i) {
            const out = sim.step();
            e.onDom(out.dom);
            e.onQuote(out.quote);
        }
        const kinds = new Set(events.map(ev => ev.type + ":" + ev.side));
        ["held:bid", "filled:ask", "pulled:ask"].forEach(k => assert.ok(kinds.has(k), "seed " + seed + ": " + [...kinds].join(",")));
        assert.ok(e.flashes > 10, "flashes filtered: " + e.flashes);
    });
});

// ── fake Tradovate transport ─────────────────────────────────────────────────

function fakeTradovate(opts) {
    opts = opts || {};
    const server = {
        sockets: [],
        frames: [],              // every client frame, all sockets
        heartbeats: 0,
        validTokens: new Set(opts.validTokens || ["md-1"]),
        contractId: 3570918,
        onRequest: opts.onRequest || null
    };
    class FakeWS {
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.listeners = { message: [], close: [], error: [], open: [] };
            server.sockets.push(this);
            setImmediate(() => {
                if (this.readyState !== 0) {
                    return;
                }
                this.readyState = 1;
                this.emit("open", {});
                if (!opts.silent) {
                    this.push("o");
                }
            });
        }
        addEventListener(type, fn) {
            this.listeners[type].push(fn);
        }
        emit(type, ev) {
            this.listeners[type].slice().forEach(fn => fn(ev));
        }
        push(data) {
            if (this.readyState === 1) {
                this.emit("message", { data });
            }
        }
        send(data) {
            if (this.readyState !== 1) {
                throw new Error("send on closed socket");
            }
            server.frames.push({ url: this.url, data });
            if (data === "[]") {
                server.heartbeats++;
                return;
            }
            const [op, id, , body] = data.split("\n");
            const reply = d => setImmediate(() => this.push("a" + JSON.stringify([d])));
            if (op === "authorize") {
                reply(server.validTokens.has(body)
                    ? { s: 200, i: 0 }
                    : { s: 401, i: 0, d: "Access is denied" });
                return;
            }
            const custom = server.onRequest && server.onRequest(op, JSON.parse(body || "null"), this, Number(id));
            if (custom != null) {
                reply(Object.assign({ i: Number(id) }, custom));
                return;
            }
            if (op === "replay/checkreplaysession") {
                reply({ s: 200, i: Number(id), d: { checkStatus: "OK" } });
            }
            else {
                reply({ s: 200, i: Number(id), d: {} });
            }
        }
        close(code, reason) {
            if (this.readyState === 3) {
                return;
            }
            this.readyState = 3;
            setImmediate(() => this.emit("close", { code: code || 1000, reason: reason || "" }));
        }
        // server-initiated drop
        drop(reason) {
            this.readyState = 3;
            this.emit("close", { code: 1006, reason: reason || "" });
        }
    }
    server.WebSocket = FakeWS;
    server.md = (sock, d) => sock.push("a" + JSON.stringify([{ e: "md", d }]));
    return server;
}

function fakeFetch(handlers) {
    const calls = [];
    const fn = async (url, init) => {
        const u = new URL(url);
        const key = (init.method || "GET") + " " + u.pathname.replace(/^\/v1/, "");
        calls.push({ key, url, init, query: Object.fromEntries(u.searchParams), body: init.body ? JSON.parse(init.body) : undefined });
        const h = handlers[key];
        if (!h) {
            return new Response("not found", { status: 404 });
        }
        const out = await h(calls[calls.length - 1], calls);
        if (out instanceof Response) {
            return out;
        }
        return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    fn.calls = calls;
    return fn;
}

const TOKEN = {
    accessToken: "acc-1",
    mdAccessToken: "md-1",
    expirationTime: new Date(Date.now() + 80 * 60000).toISOString(),
    userId: 42,
    name: "trader"
};

function restHandlers(extra) {
    return Object.assign({
        "POST /auth/accesstokenrequest": () => TOKEN,
        "GET /contract/find": c => c.query.name === "MNQZ6" ? { id: 3570918, name: "MNQZ6", contractMaturityId: 51000 } : null,
        "GET /contractMaturity/item": () => ({ id: 51000, productId: 2007, expirationMonth: 202612, isFront: true }),
        "GET /product/item": () => ({ id: 2007, name: "MNQ", tickSize: 0.25, valuePerPoint: 2 }),
        "GET /contract/suggest": () => [{ id: 1, name: "MNQZ6" }, { id: 2, name: "MNQH7" }],
        "GET /auth/renewaccesstoken": () => Object.assign({}, TOKEN, { accessToken: "acc-2" })
    }, extra || {});
}

const until = async (cond, ms, what) => {
    const end = Date.now() + (ms || 3000);
    while (Date.now() < end) {
        if (cond()) {
            return;
        }
        await new Promise(r => setTimeout(r, 5));
    }
    assert.fail("timed out waiting for " + (what || "condition"));
};

// ── socket protocol ──────────────────────────────────────────────────────────

test("socket: authorize handshake and newline request framing", async () => {
    const srv = fakeTradovate();
    const sock = new m.TradovateSocket({ url: m.URLS.md, WebSocketImpl: srv.WebSocket });
    await sock.connect("md-1");
    assert.strictEqual(srv.frames[0].data, "authorize\n0\n\nmd-1");
    await sock.request("md/subscribeDOM", { symbol: "MNQZ6" });
    assert.strictEqual(srv.frames[1].data, "md/subscribeDOM\n1\n\n{\"symbol\":\"MNQZ6\"}");
    sock.close();
});

test("socket: bad token rejects with auth flag and no onClose", async () => {
    const srv = fakeTradovate();
    let closes = 0;
    const sock = new m.TradovateSocket({ url: m.URLS.md, WebSocketImpl: srv.WebSocket, onClose: () => closes++ });
    await assert.rejects(sock.connect("expired"), err => err.auth === true && /Access is denied/.test(err.message));
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(closes, 0);
});

test("socket: error status and errorText responses reject", async () => {
    const srv = fakeTradovate({
        onRequest: op => op === "md/subscribeDOM" ? { s: 404, d: "Unknown symbol" }
            : op === "md/subscribeQuote" ? { s: 200, d: { errorText: "No market data" } } : undefined
    });
    const sock = new m.TradovateSocket({ url: m.URLS.md, WebSocketImpl: srv.WebSocket });
    await sock.connect("md-1");
    await assert.rejects(sock.request("md/subscribeDOM", { symbol: "X" }), /failed \(404\): Unknown symbol/);
    await assert.rejects(sock.request("md/subscribeQuote", { symbol: "X" }), /No market data/);
    sock.close();
});

test("socket: time-penalty ticket is waited out and retried with p-ticket", async () => {
    let first = true;
    const srv = fakeTradovate({
        onRequest: (op, body) => {
            if (op !== "md/subscribeDOM") {
                return undefined;
            }
            if (first) {
                first = false;
                return { s: 200, d: { "p-ticket": "TICKET", "p-time": 2 } };
            }
            assert.strictEqual(body["p-ticket"], "TICKET");
            return { s: 200, d: {} };
        }
    });
    const waits = [];
    const sock = new m.TradovateSocket({ url: m.URLS.md, WebSocketImpl: srv.WebSocket, sleep: async ms => waits.push(ms) });
    await sock.connect("md-1");
    await sock.requestWithPenalty("md/subscribeDOM", { symbol: "MNQZ6" });
    assert.deepStrictEqual(waits, [2000]);
    sock.close();
});

test("socket: sends [] heartbeats and the watchdog closes a silent stream", async () => {
    const srv = fakeTradovate();
    let closed = null;
    const sock = new m.TradovateSocket({
        url: m.URLS.md,
        WebSocketImpl: srv.WebSocket,
        heartbeatMs: 20,
        watchdogMs: 150,
        onClose: info => { closed = info; }
    });
    await sock.connect("md-1");
    await until(() => srv.heartbeats >= 3, 1000, "heartbeats");
    await until(() => closed !== null, 3000, "watchdog close");
});

test("socket: server 'c' frame closes and reports", async () => {
    const srv = fakeTradovate();
    let closed = null;
    const sock = new m.TradovateSocket({ url: m.URLS.md, WebSocketImpl: srv.WebSocket, onClose: info => { closed = info; } });
    await sock.connect("md-1");
    srv.sockets[0].push("c[1000,\"server shutdown\"]");
    await until(() => closed !== null, 1000, "close");
});

test("socket: events are passed on; unreadable frames are ignored", async () => {
    const srv = fakeTradovate();
    const seen = [];
    const sock = new m.TradovateSocket({ url: m.URLS.md, WebSocketImpl: srv.WebSocket, onEvent: ev => seen.push(ev) });
    await sock.connect("md-1");
    srv.sockets[0].push("h");
    srv.sockets[0].push("a[not json");
    srv.md(srv.sockets[0], { doms: [] });
    assert.deepStrictEqual(seen, [{ e: "md", d: { doms: [] } }]);
    sock.close();
});

// ── REST ─────────────────────────────────────────────────────────────────────

const CREDS = { username: "trader", password: "pw", appId: "domLevels", appVersion: "1.0", cid: "1234", secret: "s3cr3t", deviceId: "dev-1" };

test("rest: token request body, p-ticket retry, md token fallback", async () => {
    let n = 0;
    const f = fakeFetch(restHandlers({
        "POST /auth/accesstokenrequest": c => ++n === 1
            ? { "p-ticket": "PT", "p-time": 3 }
            : { accessToken: "acc-9", expirationTime: TOKEN.expirationTime }
    }));
    const waits = [];
    const rest = new m.TradovateRest({ env: "live", fetchImpl: f, sleep: async ms => waits.push(ms) });
    const tok = await rest.requestToken(CREDS);
    assert.strictEqual(f.calls[0].url, "https://live.tradovateapi.com/v1/auth/accesstokenrequest");
    assert.deepStrictEqual(f.calls[0].body, { name: "trader", password: "pw", appId: "domLevels", appVersion: "1.0", deviceId: "dev-1", cid: 1234, sec: "s3cr3t" });
    assert.strictEqual(f.calls[1].body["p-ticket"], "PT");
    assert.deepStrictEqual(waits, [3000]);
    assert.strictEqual(tok.mdAccessToken, "acc-9", "falls back to accessToken");
});

test("rest: captcha and errorText surface as clear errors", async () => {
    const cap = new m.TradovateRest({ env: "demo", fetchImpl: fakeFetch({ "POST /auth/accesstokenrequest": () => ({ "p-ticket": "x", "p-time": 1, "p-captcha": true }) }) });
    await assert.rejects(cap.requestToken(CREDS), /captcha/);
    const bad = new m.TradovateRest({ env: "demo", fetchImpl: fakeFetch({ "POST /auth/accesstokenrequest": () => ({ errorText: "Incorrect username or password" }) }) });
    await assert.rejects(bad.requestToken(CREDS), /Tradovate login failed: Incorrect username or password/);
});

test("rest: contract lookup reads the tick; unknown symbol lists suggestions", async () => {
    const f = fakeFetch(restHandlers());
    const rest = new m.TradovateRest({ env: "demo", fetchImpl: f });
    const c = await rest.resolveContract("MNQZ6", "acc-1");
    assert.deepStrictEqual(c, { id: 3570918, name: "MNQZ6", tickSize: 0.25, product: "MNQ" });
    assert.strictEqual(f.calls[0].init.headers.Authorization, "Bearer acc-1");
    await assert.rejects(rest.resolveContract("MNQZ9", "acc-1"), /Contract "MNQZ9" not found.*MNQZ6, MNQH7/);
    const suggest = f.calls.find(x => x.key === "GET /contract/suggest");
    assert.deepStrictEqual(suggest.query, { t: "MNQ", l: "6" });
});

test("rest: renewal keeps the old market-data token when none is returned", async () => {
    const f = fakeFetch(restHandlers({ "GET /auth/renewaccesstoken": () => ({ accessToken: "acc-2", expirationTime: TOKEN.expirationTime }) }));
    const rest = new m.TradovateRest({ env: "demo", fetchImpl: f });
    const tok = await rest.renewToken({ accessToken: "acc-1", mdAccessToken: "md-1" });
    assert.strictEqual(tok.accessToken, "acc-2");
    assert.strictEqual(tok.mdAccessToken, "md-1");
});

// ── app integration ──────────────────────────────────────────────────────────

function appConfig(extra) {
    return Object.assign({
        env: "demo", symbol: "MNQZ6", web: false, terminal: false, log: "", replay: "", speed: 100,
        simulate: false, engine: { persistSec: 1 }
    }, CREDS, extra || {});
}

function domFor(contractId, ms, bb, extra) {
    return Object.assign(book(ms, bb, extra), { contractId });
}

test("app: logs in, subscribes, filters by contract, builds levels", async () => {
    const srv = fakeTradovate();
    const f = fakeFetch(restHandlers());
    const logs = [];
    const app = new m.DomLevelsApp(appConfig(), { fetchImpl: f, WebSocketImpl: srv.WebSocket, log: x => logs.push(x) });
    await app.start();
    assert.strictEqual(srv.sockets[0].url, "wss://md.tradovateapi.com/v1/websocket");
    const ops = srv.frames.map(fr => fr.data.split("\n")[0]);
    assert.deepStrictEqual(ops, ["authorize", "md/subscribeDOM", "md/subscribeQuote"]);
    assert.strictEqual(JSON.parse(srv.frames[1].data.split("\n")[3]).symbol, "MNQZ6");
    assert.strictEqual(app.engine.tick, 0.25);
    for (let t = 0; t <= 3000; t += 500) {
        srv.md(srv.sockets[0], { doms: [domFor(3570918, t, 21000, { 20998: 400 }), domFor(999, t, 5000, { 4999: 900 })] });
    }
    const snap = app.state().snapshot;
    assert.deepStrictEqual(snap.levels.map(l => l.name + " " + l.priceText), ["S1 20998.00"]);
    assert.strictEqual(app.status.connected, true);
    await app.stop();
    const last = srv.frames.slice(-2).map(fr => fr.data.split("\n")[0]).sort();
    assert.deepStrictEqual(last, ["md/unsubscribeDOM", "md/unsubscribeQuote"]);
});

test("app: reconnects and resubscribes after the server drops the stream", async () => {
    const srv = fakeTradovate();
    const app = new m.DomLevelsApp(appConfig(), { fetchImpl: fakeFetch(restHandlers()), WebSocketImpl: srv.WebSocket, log: () => {}, sleep: async () => {} });
    await app.start();
    srv.md(srv.sockets[0], { quotes: [Object.assign(quote(0, 21000, 5000), { contractId: 3570918 })] });
    assert.strictEqual(app.engine.lastTotalVolume, 5000);
    app.connectedAt = 0;   // treat the first connection as long-lived (no backoff)
    srv.sockets[0].drop("network");
    await until(() => app.status.connected && srv.sockets.length === 2, 3000, "reconnect");
    assert.strictEqual(app.engine.lastTotalVolume, null, "volume rebased after the gap");
    const ops = srv.frames.filter(fr => fr.url && srv.sockets.indexOf(srv.sockets[1]) >= 0).map(fr => fr.data.split("\n")[0]);
    assert.deepStrictEqual(ops.slice(-3), ["authorize", "md/subscribeDOM", "md/subscribeQuote"]);
    await app.stop();
});

test("app: health warning when subscribed without data, cleared when data arrives", async () => {
    const srv = fakeTradovate();
    const app = new m.DomLevelsApp(appConfig(), { fetchImpl: fakeFetch(restHandlers()), WebSocketImpl: srv.WebSocket, log: () => {} });
    await app.start();
    app.streamingSince = Date.now() - 20000;
    app.healthCheck();
    assert.match(app.status.state, /no order book data yet/);
    srv.md(srv.sockets[0], { doms: [domFor(3570918, 0, 21000, {})] });
    app.healthCheck();
    assert.strictEqual(app.status.state, "streaming");
    await app.stop();
});

test("app: expired market-data token triggers a fresh login", async () => {
    const srv = fakeTradovate({ validTokens: ["md-2"] });
    let logins = 0;
    const f = fakeFetch(restHandlers({
        "POST /auth/accesstokenrequest": () => Object.assign({}, TOKEN, { mdAccessToken: "md-" + (++logins) })
    }));
    const app = new m.DomLevelsApp(appConfig(), { fetchImpl: f, WebSocketImpl: srv.WebSocket, log: () => {}, sleep: async () => {} });
    await app.start();
    assert.strictEqual(logins, 2);
    assert.strictEqual(app.status.connected, true);
    await app.stop();
});

test("app: replay checks the session, starts the clock, then subscribes", async () => {
    const srv = fakeTradovate();
    const app = new m.DomLevelsApp(appConfig({ replay: "2026-10-16T13:30:00.000Z", speed: 400 }), {
        fetchImpl: fakeFetch(restHandlers()), WebSocketImpl: srv.WebSocket, log: () => {}
    });
    await app.start();
    assert.strictEqual(srv.sockets[0].url, "wss://replay.tradovateapi.com/v1/websocket");
    const reqs = srv.frames.map(fr => fr.data.split("\n"));
    assert.deepStrictEqual(reqs.map(r => r[0]), ["authorize", "replay/checkreplaysession", "replay/initializeclock", "md/subscribeDOM", "md/subscribeQuote"]);
    assert.deepStrictEqual(JSON.parse(reqs[2][3]), { startTimestamp: "2026-10-16T13:30:00.000Z", speed: 400, initialBalance: 50000 });
    await app.stop();
});

test("app: replay uses Tradovate's adjusted start and stops on Ineligible", async () => {
    const adjusted = fakeTradovate({
        onRequest: op => op === "replay/checkreplaysession" ? { s: 200, d: { checkStatus: "StartTimestampAdjusted", startTimestamp: "2026-10-16T13:31:00.000Z" } } : undefined
    });
    const a = new m.DomLevelsApp(appConfig({ replay: "2026-10-16T13:30:00.000Z" }), { fetchImpl: fakeFetch(restHandlers()), WebSocketImpl: adjusted.WebSocket, log: () => {} });
    await a.start();
    const init = adjusted.frames.map(fr => fr.data.split("\n")).find(r => r[0] === "replay/initializeclock");
    assert.strictEqual(JSON.parse(init[3]).startTimestamp, "2026-10-16T13:31:00.000Z");
    await a.stop();

    const no = fakeTradovate({ onRequest: op => op === "replay/checkreplaysession" ? { s: 200, d: { checkStatus: "Ineligible" } } : undefined });
    const b = new m.DomLevelsApp(appConfig({ replay: "2026-10-16T13:30:00.000Z" }), { fetchImpl: fakeFetch(restHandlers()), WebSocketImpl: no.WebSocket, log: () => {} });
    await assert.rejects(b.start(), /Market Replay is not available/);
    await b.stop();
    await until(() => no.sockets[0].readyState === 3, 1000, "socket closed");
});

test("app: a server-paused replay (clock speed 0) is resumed, at most every 5s", async () => {
    const srv = fakeTradovate();
    const app = new m.DomLevelsApp(appConfig({ replay: "2026-10-16T13:30:00.000Z", speed: 200 }), {
        fetchImpl: fakeFetch(restHandlers()), WebSocketImpl: srv.WebSocket, log: () => {}
    });
    await app.start();
    const sock = srv.sockets[0];
    const clock = d => sock.push("a" + JSON.stringify([{ e: "clock", d }]));
    clock(JSON.stringify({ t: "2026-10-16T13:31:00.000Z", s: 200 }));
    assert.strictEqual(app.status.replayTime, "2026-10-16T13:31:00.000Z");
    clock(JSON.stringify({ t: "2026-10-16T13:32:00.000Z", s: 0 }));
    clock({ t: "2026-10-16T13:32:01.000Z", s: 0 });   // object form, within 5s: no repeat
    await until(() => srv.frames.some(fr => fr.data.startsWith("replay/changespeed")), 1000, "changespeed");
    const resumes = srv.frames.filter(fr => fr.data.startsWith("replay/changespeed"));
    assert.strictEqual(resumes.length, 1);
    assert.deepStrictEqual(JSON.parse(resumes[0].data.split("\n")[3]), { speed: 200 });
    await app.stop();
});

test("app: a failing subscription closes that socket before retrying", async () => {
    let fail = 1;
    const srv = fakeTradovate({ onRequest: op => op === "md/subscribeDOM" && fail-- > 0 ? { s: 403, d: "Not entitled" } : undefined });
    const logs = [];
    const app = new m.DomLevelsApp(appConfig(), { fetchImpl: fakeFetch(restHandlers()), WebSocketImpl: srv.WebSocket, log: x => logs.push(x), sleep: async () => {} });
    await app.start();
    assert.strictEqual(srv.sockets.length, 2);
    assert.strictEqual(srv.sockets[0].readyState, 3);
    assert.ok(logs.some(l => /Not entitled/.test(l)), logs.join("\n"));
    await app.stop();
});

// ── config + CLI ─────────────────────────────────────────────────────────────

test("cli: parses flags and rejects unknown or incomplete ones", () => {
    const a = m.parseArgs(["--symbol", "esz6", "--env=live", "--wall-multiple", "4", "--no-web", "--persist-sec", "20"]);
    assert.deepStrictEqual(a.app, { symbol: "esz6", env: "live", web: false });
    assert.deepStrictEqual(a.engine, { wallMultiple: 4, persistSec: 20 });
    assert.throws(() => m.parseArgs(["--bogus", "1"]), /Unknown option --bogus/);
    assert.throws(() => m.parseArgs(["--symbol"]), /Missing value for --symbol/);
    assert.throws(() => m.parseArgs(["--hold-ticks", "-1"]), /Missing value|non-negative/);
    assert.throws(() => m.parseArgs(["--hold-ticks", "x"]), /non-negative number/);
});

test("config: file < environment < flags, device id persisted, clear errors", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domlevels-"));
    fs.writeFileSync(path.join(dir, "domLevels.config.json"), JSON.stringify({
        username: "fileuser", password: "pw", cid: 1, secret: "s", symbol: "mnqz6", wallMultiple: 5
    }));
    const cfg = m.loadConfig(m.parseArgs(["--persist-sec", "3"]), { TRADOVATE_USERNAME: "envuser" }, dir);
    assert.strictEqual(cfg.username, "envuser");
    assert.strictEqual(cfg.symbol, "MNQZ6");
    assert.deepStrictEqual(cfg.engine, { wallMultiple: 5, persistSec: 3 });
    const id = fs.readFileSync(path.join(dir, ".domLevels-device-id"), "utf8").trim();
    assert.strictEqual(cfg.deviceId, id);
    assert.strictEqual(m.loadConfig(m.parseArgs([]), {}, dir).deviceId, id, "same device id next run");

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "domlevels-"));
    assert.throws(() => m.loadConfig(m.parseArgs([]), {}, empty), /Missing symbol, username, password, cid, secret/);
    assert.doesNotThrow(() => m.loadConfig(m.parseArgs(["--simulate"]), {}, empty));
    const example = fs.mkdtempSync(path.join(os.tmpdir(), "domlevels-"));
    fs.copyFileSync(path.join(__dirname, "..", "domLevels.config.example.json"), path.join(example, "domLevels.config.json"));
    assert.throws(() => m.loadConfig(m.parseArgs([]), {}, example), /Fill in your real username, password, secret, cid/);
    assert.throws(() => m.loadConfig(m.parseArgs(["--simulate", "--speed", "500"]), {}, empty), /--speed/);
    assert.throws(() => m.loadConfig(m.parseArgs(["--simulate", "--replay", "yesterday"]), {}, empty), /ISO date-time/);
    const r = m.loadConfig(m.parseArgs(["--simulate", "--replay", "2026-10-16T09:30:00-04:00"]), {}, empty);
    assert.strictEqual(r.replay, "2026-10-16T13:30:00.000Z");
});

// ── dashboard ────────────────────────────────────────────────────────────────

function get(port, route) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, path: route }, res => {
            let body = "";
            res.on("data", d => {
                body += d;
                if (route === "/events" && body.includes("\n\ndata: ")) {
                    req.destroy();
                    resolve({ status: res.statusCode, type: res.headers["content-type"], body });
                }
            });
            res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body }));
        });
        req.on("error", reject);
    });
}

test("dashboard: serves the page, JSON state and an SSE stream on localhost", async () => {
    const app = new m.DomLevelsApp(Object.assign(appConfig(), { simulate: true }), { log: () => {} });
    const dash = await m.startDashboard(app, 0, () => {});
    try {
        assert.strictEqual(dash.server.address().address, "127.0.0.1");
        const page = await get(dash.port, "/");
        assert.strictEqual(page.status, 200);
        assert.match(page.body, /<title>Resting Order Levels<\/title>/);
        const state = JSON.parse((await get(dash.port, "/state.json")).body);
        assert.strictEqual(state.status.mode, "simulation");
        const sse = await get(dash.port, "/events");
        assert.strictEqual(sse.type, "text/event-stream");
        assert.match(sse.body, /data: \{"status"/);
        assert.strictEqual((await get(dash.port, "/nope")).status, 404);
    }
    finally {
        await dash.close();
    }
});

#!/usr/bin/env node
// Resting Order Levels (DOM) — live support/resistance from Tradovate's order book.
//
// Streams the Depth of Market (md/subscribeDOM) and trades (md/subscribeQuote)
// from Tradovate's market-data API and tracks large resting limit orders:
//
//   wall      size >= wallMultiple × the book's median size on that side
//   level     a wall that stayed in the book for persistSec (flashes are ignored)
//   held      price traded into the level and bounced holdTicks away
//   filled    the level left the book mostly by TRADING (real orders, got hit)
//   pulled    the level left the book WITHOUT trading (cancelled — spoof risk)
//   broken    price traded breakTicks through the level
//
// Bid levels are support, offer levels are resistance. Results are shown in
// the terminal and on a local dashboard at http://127.0.0.1:8787.
//
// Requirements: Node.js 22+ (built-in fetch + WebSocket), a Tradovate account
// with API Access (API key: cid + secret) and market data for the symbol.
//
//   node domLevels.js --symbol MNQZ6                 live order book
//   node domLevels.js --symbol MNQZ6 --replay 2026-10-16T13:30:00Z
//   node domLevels.js --simulate                     demo feed, no login
//   node domLevels.js --help
//
// No dependencies. Credentials come from domLevels.config.json (next to this
// file), TRADOVATE_* environment variables, or flags — see README.md.

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const URLS = {
    demo: "https://demo.tradovateapi.com/v1",
    live: "https://live.tradovateapi.com/v1",
    md: "wss://md.tradovateapi.com/v1/websocket",
    replay: "wss://replay.tradovateapi.com/v1/websocket"
};

const ENGINE_DEFAULTS = {
    wallMultiple: 3,     // wall = size >= this × median visible size on that side
    minSize: 0,          // absolute floor for a wall (contracts)
    persistSec: 10,      // a wall must rest this long to become a level
    endRatio: 0.6,       // a level ends when size < endRatio × wall threshold
    settleSec: 1.5,      // wait for trade prints before calling a drop filled vs pulled
    fillShare: 0.5,      // drop counts as "filled" if trades at the price cover ≥ this share
    touchTicks: 1,       // a trade this close to a level counts as a test
    holdTicks: 4,        // after a test, a move this far away in favor counts as a hold
    breakTicks: 2,       // a trade this far through a level breaks it
    levelsPerSide: 5,
    staleMin: 30,        // forget levels out of the visible book this long
    baselineSec: 60,     // smoothing of the median-size baseline
    absorbSec: 3,        // "ABSORBING" if the level traded within this window
    tick: 0              // tick size; 0 = from the contract (or inferred from the book)
};

const APP_DEFAULTS = {
    env: "demo",
    symbol: "",
    port: 8787,
    web: true,
    terminal: true,
    log: "",
    replay: "",
    speed: 100,
    simulate: false,
    appId: "domLevels",
    appVersion: "1.0"
};

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function decimalsOf(tick) {
    const s = String(tick);
    if (s.indexOf("e-") >= 0) {
        return parseInt(s.split("e-")[1], 10);
    }
    const dot = s.indexOf(".");
    return dot < 0 ? 0 : s.length - dot - 1;
}

function median(values) {
    if (!values.length) {
        return 0;
    }
    const a = values.slice().sort((x, y) => x - y);
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function fmtAge(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) {
        return s + "s";
    }
    const m = Math.floor(s / 60);
    if (m < 60) {
        return m + "m" + String(s % 60).padStart(2, "0") + "s";
    }
    return Math.floor(m / 60) + "h" + String(m % 60).padStart(2, "0") + "m";
}

function fmtClock(ms) {
    return new Date(ms).toLocaleTimeString("en-US", { hour12: false });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isNum(x) {
    return typeof x === "number" && Number.isFinite(x);
}

// ─────────────────────────────────────────────────────────────────────────────
// LevelEngine — pure state machine; all timing comes from message timestamps,
// so Market Replay at any speed behaves like live.
// ─────────────────────────────────────────────────────────────────────────────

class LevelEngine {
    constructor(settings) {
        this.listeners = [];
        this.reset(settings);
    }

    reset(settings) {
        this.s = Object.assign({}, ENGINE_DEFAULTS, settings || {});
        this.setTick(this.s.tick || 0);
        this.now = 0;
        this.bids = new Map();          // ticks -> size (latest snapshot)
        this.asks = new Map();
        this.bestBid = null;            // ticks
        this.bestAsk = null;
        this.minBid = null;
        this.maxAsk = null;
        this.baseline = { bid: 0, ask: 0 };
        this.baselineAt = 0;
        this.candidates = new Map();    // key -> { side, ticks, since, peak }
        this.levels = new Map();        // key -> level
        this.pullHistory = new Map();   // key -> times a level was pulled at this price
        this.flashes = 0;               // walls that vanished before persistSec
        this.lastTotalVolume = null;
        this.lastTradeSig = "";
        this.lastTrade = null;          // { ticks, size, t }
        this.events = [];
        this.domCount = 0;
        this.quoteCount = 0;
        this.warnings = [];
    }

    setTick(tick) {
        this.tick = tick > 0 ? tick : 0;
        this.decimals = this.tick ? decimalsOf(this.tick) : 2;
    }

    onEvent(fn) {
        this.listeners.push(fn);
    }

    toTicks(price) {
        return Math.round(price / this.tick);
    }

    price(ticks) {
        return Number((ticks * this.tick).toFixed(this.decimals));
    }

    fmtPrice(ticks) {
        return this.price(ticks).toFixed(this.decimals);
    }

    time(ts) {
        const parsed = typeof ts === "number" ? ts : Date.parse(ts);
        const t = Number.isFinite(parsed) ? parsed : Date.now();
        if (t > this.now) {
            this.now = t;
        }
        return this.now;
    }

    threshold(side) {
        return Math.max(this.s.minSize, this.s.wallMultiple * this.baseline[side], 1);
    }

    emit(type, level, extra) {
        const ev = Object.assign({
            type,
            t: this.now,
            side: level.side,
            price: this.price(level.ticks),
            priceText: this.fmtPrice(level.ticks),
            size: level.size,
            peak: level.peak,
            filled: Math.round(level.filled),
            holds: level.holds,
            ageMs: this.now - level.born
        }, extra || {});
        this.events.push(ev);
        if (this.events.length > 200) {
            this.events.splice(0, this.events.length - 200);
        }
        this.listeners.forEach(fn => fn(ev));
        return ev;
    }

    // Infer the tick from the smallest gap between quoted prices (the spread
    // between best bid and best offer is one tick in liquid futures).
    inferTick(prices) {
        const u = Array.from(new Set(prices)).sort((a, b) => a - b);
        let gap = Infinity;
        for (let i = 1; i < u.length; ++i) {
            const d = u[i] - u[i - 1];
            if (d > 1e-12 && d < gap) {
                gap = d;
            }
        }
        return Number.isFinite(gap) ? Number(gap.toFixed(10)) : 0;
    }

    onDom(dom) {
        if (!dom) {
            return;
        }
        const t = this.time(dom.timestamp);
        const valid = l => l && isNum(l.price) && isNum(l.size) && l.size > 0;
        const bidsIn = (dom.bids || []).filter(valid);
        const asksIn = (dom.offers || []).filter(valid);
        const allPrices = bidsIn.concat(asksIn).map(l => l.price);
        if (!allPrices.length) {
            return;
        }
        if (!this.tick) {
            const inferred = this.inferTick(allPrices);
            if (!inferred) {
                return;
            }
            this.setTick(inferred);
        }
        else {
            // a price off the tick grid means the tick was mis-inferred: start over finer
            const off = allPrices.find(p => Math.abs(p / this.tick - Math.round(p / this.tick)) > 1e-6);
            if (off !== undefined) {
                const finer = this.inferTick(allPrices.concat([this.price(this.toTicks(off))]));
                if (finer && finer < this.tick) {
                    const note = "tick size corrected from " + this.tick + " to " + finer + "; levels restarted";
                    this.reset(Object.assign({}, this.s, { tick: finer }));
                    this.warnings.push(note);
                    this.time(t);
                }
            }
        }
        this.domCount++;

        this.bids = new Map();
        this.asks = new Map();
        bidsIn.forEach(l => {
            const k = this.toTicks(l.price);
            this.bids.set(k, (this.bids.get(k) || 0) + l.size);
        });
        asksIn.forEach(l => {
            const k = this.toTicks(l.price);
            this.asks.set(k, (this.asks.get(k) || 0) + l.size);
        });
        const bidTicks = Array.from(this.bids.keys());
        const askTicks = Array.from(this.asks.keys());
        this.bestBid = bidTicks.length ? Math.max.apply(null, bidTicks) : null;
        this.minBid = bidTicks.length ? Math.min.apply(null, bidTicks) : null;
        this.bestAsk = askTicks.length ? Math.min.apply(null, askTicks) : null;
        this.maxAsk = askTicks.length ? Math.max.apply(null, askTicks) : null;

        this.updateBaseline(t);
        this.scanWalls("bid", this.bids, t);
        this.scanWalls("ask", this.asks, t);
        this.updateLevels(t);
    }

    updateBaseline(t) {
        const tau = this.s.baselineSec * 1000;
        const dt = this.baselineAt ? Math.max(0, t - this.baselineAt) : 0;
        const alpha = this.baselineAt ? 1 - Math.exp(-dt / tau) : 1;
        [["bid", this.bids], ["ask", this.asks]].forEach(([side, map]) => {
            if (!map.size) {
                return;
            }
            const m = median(Array.from(map.values()));
            this.baseline[side] = this.baseline[side] ? this.baseline[side] + alpha * (m - this.baseline[side]) : m;
        });
        this.baselineAt = t;
    }

    // Candidate walls: must stay >= threshold for persistSec to become levels.
    scanWalls(side, map, t) {
        const thr = this.threshold(side);
        const persist = this.s.persistSec * 1000;
        map.forEach((size, ticks) => {
            const k = side + ":" + ticks;
            if (this.levels.has(k)) {
                return;
            }
            const cand = this.candidates.get(k);
            if (size >= thr) {
                if (!cand) {
                    this.candidates.set(k, { side, ticks, since: t, peak: size });
                }
                else {
                    cand.peak = Math.max(cand.peak, size);
                    if (t - cand.since >= persist) {
                        this.candidates.delete(k);
                        this.confirm(side, ticks, size, cand, t);
                    }
                }
            }
            else if (cand) {
                this.candidates.delete(k);
                this.flashes++;
            }
        });
        // candidates no longer in the book: a flash if the price is still in view
        this.candidates.forEach((cand, k) => {
            if (cand.side !== side || map.has(cand.ticks)) {
                return;
            }
            this.candidates.delete(k);
            if (this.observe(cand.side, cand.ticks).state !== "hidden") {
                this.flashes++;
            }
        });
    }

    confirm(side, ticks, size, cand, t) {
        const level = {
            key: side + ":" + ticks,
            side,
            ticks,
            size,
            peak: Math.max(cand.peak, size),
            born: cand.since,
            confirmedAt: t,
            lastSeen: t,
            visible: true,
            filled: 0,
            lastFillAt: 0,
            holds: 0,
            touched: false,
            pendingSince: 0
        };
        this.levels.set(level.key, level);
        this.emit("born", level);
    }

    // After a reconnect nothing is known about what traded or was cancelled in the
    // gap: rebase volume, drop unconfirmed walls, and don't judge levels that
    // vanished meanwhile as filled or pulled.
    markGap() {
        this.lastTotalVolume = null;
        this.lastTradeSig = "";
        this.candidates.clear();
        this.levels.forEach(level => {
            level.gap = true;
        });
    }

    // What the current snapshot says about a price on one side of the book.
    observe(side, ticks) {
        const map = side === "bid" ? this.bids : this.asks;
        if (map.has(ticks)) {
            return { state: "visible", size: map.get(ticks) };
        }
        if (!map.size) {
            return { state: "hidden" };
        }
        if (side === "bid") {
            return ticks < this.minBid ? { state: "hidden" } : { state: "gone", size: 0 };
        }
        return ticks > this.maxAsk ? { state: "hidden" } : { state: "gone", size: 0 };
    }

    updateLevels(t) {
        const stale = this.s.staleMin * 60000;
        this.levels.forEach(level => {
            const obs = this.observe(level.side, level.ticks);
            if (obs.state === "hidden") {
                level.visible = false;
                if (!level.pendingSince && t - level.lastSeen > stale) {
                    this.end(level, "stale");
                }
                return;
            }
            level.visible = true;
            level.size = obs.size;
            level.lastSeen = t;
            level.peak = Math.max(level.peak, obs.size);
            const floor = this.s.endRatio * this.threshold(level.side);
            if (obs.size >= floor) {
                level.pendingSince = 0;
                level.gap = false;
            }
            else if (!level.pendingSince) {
                level.pendingSince = t;
            }
        });
        this.settle(t);
    }

    // A drop below the end floor is judged after settleSec, so trade prints that
    // arrive slightly after the book update still count as fills.
    settle(t) {
        const wait = this.s.settleSec * 1000;
        this.levels.forEach(level => {
            if (!level.pendingSince || t - level.pendingSince < wait) {
                return;
            }
            this.end(level, this.verdict(level));
        });
    }

    // Why a level that left the book is gone: its size traded (filled), it was
    // cancelled (pulled), or we can't know because the feed was down (stale).
    verdict(level) {
        if (level.gap) {
            return "stale";
        }
        const drop = Math.max(0, level.peak - level.size);
        return level.filled >= this.s.fillShare * drop ? "filled" : "pulled";
    }

    end(level, reason) {
        if (!this.levels.has(level.key)) {
            return;
        }
        this.levels.delete(level.key);
        if (reason === "pulled") {
            this.pullHistory.set(level.key, (this.pullHistory.get(level.key) || 0) + 1);
        }
        this.emit(reason, level, { pulledHereBefore: this.pullHistory.get(level.key) || 0 });
    }

    onQuote(quote) {
        if (!quote) {
            return;
        }
        const t = this.time(quote.timestamp);
        this.quoteCount++;
        const e = quote.entries || {};
        let vol = 0;
        if (e.TotalTradeVolume && isNum(e.TotalTradeVolume.size)) {
            const total = e.TotalTradeVolume.size;
            if (this.lastTotalVolume !== null && total > this.lastTotalVolume) {
                vol = total - this.lastTotalVolume;
            }
            this.lastTotalVolume = total;   // a decrease = new session; just rebase
        }
        else if (e.Trade && isNum(e.Trade.size)) {
            // no cumulative volume on this feed: count each distinct last-trade print
            const sig = e.Trade.price + "/" + e.Trade.size + "/" + quote.timestamp;
            if (sig !== this.lastTradeSig) {
                vol = e.Trade.size;
            }
            this.lastTradeSig = sig;
        }
        if (e.Trade && isNum(e.Trade.price) && this.tick) {
            this.onTrade(this.toTicks(e.Trade.price), vol, t);
        }
        this.settle(t);
    }

    onTrade(ticks, vol, t) {
        this.lastTrade = { ticks, size: vol, t };
        const s = this.s;
        Array.from(this.levels.values()).forEach(level => {
            if (ticks === level.ticks && vol > 0) {
                level.filled += vol;
                level.lastFillAt = t;
            }
            const P = level.ticks;
            // trading through a level that had already left the book says nothing
            // new: judge why it left; "broken" is for size still showing in the book
            const through = reason => this.end(level, level.pendingSince ? this.verdict(level) : reason);
            if (level.side === "bid") {
                if (ticks <= P - s.breakTicks) {
                    through("broken");
                    return;
                }
                if (ticks <= P + s.touchTicks) {
                    level.touched = true;
                }
                else if (level.touched && ticks >= P + s.holdTicks) {
                    level.touched = false;
                    level.holds++;
                    this.emit("held", level);
                }
            }
            else {
                if (ticks >= P + s.breakTicks) {
                    through("broken");
                    return;
                }
                if (ticks >= P - s.touchTicks) {
                    level.touched = true;
                }
                else if (level.touched && ticks <= P - s.holdTicks) {
                    level.touched = false;
                    level.holds++;
                    this.emit("held", level);
                }
            }
        });
    }

    refTicks() {
        if (this.lastTrade) {
            return this.lastTrade.ticks;
        }
        if (this.bestBid !== null && this.bestAsk !== null) {
            return Math.round((this.bestBid + this.bestAsk) / 2);
        }
        return this.bestBid !== null ? this.bestBid : this.bestAsk;
    }

    // Levels to show: strongest levelsPerSide per side, numbered nearest-first.
    shownLevels() {
        const ref = this.refTicks();
        const score = l => (l.visible ? l.size : 0.5 * l.size) * (1 + 0.5 * l.holds);
        const pick = side => Array.from(this.levels.values())
            .filter(l => l.side === side)
            .sort((a, b) => score(b) - score(a))
            .slice(0, this.s.levelsPerSide);
        const supports = pick("bid").sort((a, b) => b.ticks - a.ticks);
        const resistances = pick("ask").sort((a, b) => a.ticks - b.ticks);
        const view = (l, i) => ({
            name: (l.side === "bid" ? "S" : "R") + (i + 1),
            side: l.side,
            role: l.side === "bid" ? "support" : "resistance",
            ticks: l.ticks,
            price: this.price(l.ticks),
            priceText: this.fmtPrice(l.ticks),
            size: l.size,
            peak: l.peak,
            visible: l.visible,
            ageMs: this.now - l.born,
            lastSeenAgoMs: this.now - l.lastSeen,
            holds: l.holds,
            filled: Math.round(l.filled),
            absorbing: l.lastFillAt > 0 && this.now - l.lastFillAt <= this.s.absorbSec * 1000,
            fading: !!l.pendingSince,
            pulledHereBefore: this.pullHistory.get(l.key) || 0,
            distanceTicks: ref === null ? null : l.ticks - ref
        });
        return supports.map(view).concat(resistances.map(view));
    }

    snapshot(ladderRows) {
        const shown = this.shownLevels();
        const ref = this.refTicks();
        const ladder = [];
        if (ref !== null && this.tick) {
            const half = Math.max(5, Math.floor((ladderRows || 40) / 2));
            const byTicks = new Map(shown.map(l => [l.ticks + ":" + l.side, l.name]));
            for (let k = ref + half; k >= ref - half; --k) {
                ladder.push({
                    ticks: k,
                    priceText: this.fmtPrice(k),
                    bid: this.bids.get(k) || 0,
                    ask: this.asks.get(k) || 0,
                    level: byTicks.get(k + ":bid") || byTicks.get(k + ":ask") || "",
                    last: this.lastTrade ? this.lastTrade.ticks === k : false
                });
            }
        }
        return {
            now: this.now,
            tick: this.tick,
            last: this.lastTrade ? this.fmtPrice(this.lastTrade.ticks) : null,
            bestBid: this.bestBid === null ? null : { priceText: this.fmtPrice(this.bestBid), size: this.bids.get(this.bestBid) },
            bestAsk: this.bestAsk === null ? null : { priceText: this.fmtPrice(this.bestAsk), size: this.asks.get(this.bestAsk) },
            threshold: { bid: Math.round(this.threshold("bid")), ask: Math.round(this.threshold("ask")) },
            flashes: this.flashes,
            candidates: this.candidates.size,
            domCount: this.domCount,
            quoteCount: this.quoteCount,
            levels: shown,
            ladder,
            events: this.events.slice(-30).reverse(),
            warnings: this.warnings.slice(-3)
        };
    }
}

function levelLabel(l) {
    const parts = [
        l.name + " " + l.priceText,
        l.visible ? l.size + " resting" : "out of view (last " + l.size + ", " + fmtAge(l.lastSeenAgoMs) + " ago)",
        fmtAge(l.ageMs)
    ];
    if (l.holds) {
        parts.push("held " + l.holds + "x");
    }
    if (l.filled) {
        parts.push(l.filled + " filled");
    }
    if (l.pulledHereBefore) {
        parts.push("pulled here " + l.pulledHereBefore + "x before");
    }
    let text = parts.join(" | ");
    if (l.absorbing) {
        text += "  << ABSORBING";
    }
    else if (l.fading) {
        text += "  << SHRINKING";
    }
    return text;
}

const EVENT_TEXT = {
    born: "NEW",
    held: "HELD",
    filled: "FILLED",
    pulled: "PULLED",
    broken: "BROKEN",
    stale: "EXPIRED"
};

function eventLabel(ev) {
    const who = ev.side === "bid" ? "bid" : "offer";
    let text = fmtClock(ev.t) + "  " + EVENT_TEXT[ev.type].padEnd(7) + " " + who + " " + ev.priceText;
    if (ev.type === "born") {
        text += "  (" + ev.size + " resting)";
    }
    else if (ev.type === "held") {
        text += "  (held " + ev.holds + "x)";
    }
    else {
        text += "  (peak " + ev.peak + ", " + ev.filled + " traded there)";
        if (ev.type === "pulled") {
            text += ev.pulledHereBefore > 1 ? "  spoof risk: pulled here " + ev.pulledHereBefore + "x" : "  cancelled, not traded";
        }
    }
    return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tradovate REST
// ─────────────────────────────────────────────────────────────────────────────

class TradovateRest {
    constructor(opts) {
        this.base = URLS[opts.env === "live" ? "live" : "demo"];
        this.fetch = opts.fetchImpl || globalThis.fetch;
        this.log = opts.log || (() => {});
        this.sleep = opts.sleep || sleep;
    }

    async call(method, route, { query, body, token } = {}) {
        let url = this.base + route;
        if (query) {
            url += "?" + new URLSearchParams(query).toString();
        }
        const headers = { Accept: "application/json" };
        if (body !== undefined) {
            headers["Content-Type"] = "application/json";
        }
        if (token) {
            headers.Authorization = "Bearer " + token;
        }
        const res = await this.fetch(url, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await res.text();
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        }
        catch (err) {
            json = null;
        }
        if (!res.ok) {
            const why = (json && (json.errorText || json.message)) || text || res.statusText;
            const err = new Error(method + " " + route + " failed: HTTP " + res.status + (why ? " — " + why : ""));
            err.status = res.status;
            throw err;
        }
        return json;
    }

    // POST /auth/accesstokenrequest, honoring Tradovate's time-penalty tickets.
    async requestToken(creds) {
        const body = {
            name: creds.username,
            password: creds.password,
            appId: creds.appId,
            appVersion: creds.appVersion,
            deviceId: creds.deviceId,
            cid: /^\d+$/.test(String(creds.cid)) ? Number(creds.cid) : creds.cid,
            sec: creds.secret
        };
        for (let attempt = 0; attempt < 4; ++attempt) {
            const json = await this.call("POST", "/auth/accesstokenrequest", { body }) || {};
            if (json["p-ticket"]) {
                if (json["p-captcha"]) {
                    throw new Error("Tradovate requires a captcha for this login (too many attempts). Log in once through the Tradovate app, wait about an hour, then try again.");
                }
                const wait = Math.max(1, Number(json["p-time"]) || 5);
                this.log("Tradovate asked to retry the login in " + wait + "s (rate limit)...");
                await this.sleep(wait * 1000);
                body["p-ticket"] = json["p-ticket"];
                continue;
            }
            return normalizeToken(json);
        }
        throw new Error("Tradovate kept rate-limiting the login; try again in a few minutes.");
    }

    async renewToken(token) {
        const json = await this.call("GET", "/auth/renewaccesstoken", { token: token.accessToken }) || {};
        const fresh = normalizeToken(json);
        // renewal may not return a new market-data token; keep the old one then
        if (!json.mdAccessToken) {
            fresh.mdAccessToken = token.mdAccessToken;
            fresh.mdFromRenewal = false;
        }
        return fresh;
    }

    async resolveContract(symbol, accessToken) {
        let contract = null;
        try {
            contract = await this.call("GET", "/contract/find", { query: { name: symbol }, token: accessToken });
        }
        catch (err) {
            if (err.status !== 404) {
                throw err;
            }
        }
        if (!contract || !isNum(contract.id)) {
            let hint = "";
            try {
                const root = symbol.replace(/[FGHJKMNQUVXZ]\d{1,2}$/i, "");
                const list = await this.call("GET", "/contract/suggest", { query: { t: root || symbol, l: 6 }, token: accessToken });
                if (Array.isArray(list) && list.length) {
                    hint = " Contracts matching \"" + (root || symbol) + "\": " + list.map(c => c.name).join(", ") + ".";
                }
            }
            catch (err) {
                hint = "";
            }
            throw new Error("Contract \"" + symbol + "\" not found. Use the full contract name, e.g. MNQZ6 or ESZ6." + hint);
        }
        const out = { id: contract.id, name: contract.name, tickSize: 0, product: "" };
        try {
            const maturity = await this.call("GET", "/contractMaturity/item", { query: { id: contract.contractMaturityId }, token: accessToken });
            const product = await this.call("GET", "/product/item", { query: { id: maturity.productId }, token: accessToken });
            out.tickSize = isNum(product.tickSize) ? product.tickSize : 0;
            out.product = product.name || "";
        }
        catch (err) {
            this.log("Could not read the tick size (" + err.message + "); it will be inferred from the book.");
        }
        return out;
    }
}

function normalizeToken(json) {
    if (json.errorText) {
        throw new Error("Tradovate login failed: " + json.errorText);
    }
    if (!json.accessToken) {
        throw new Error("Tradovate login failed: no access token in the response.");
    }
    const exp = Date.parse(json.expirationTime);
    return {
        accessToken: json.accessToken,
        mdAccessToken: json.mdAccessToken || json.accessToken,
        mdFromRenewal: true,
        expiresAt: Number.isFinite(exp) ? exp : Date.now() + 75 * 60000,
        userId: json.userId,
        name: json.name
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tradovate WebSocket protocol
//   frames from server: o (open) | h (heartbeat) | a[...] (JSON array) | c[code,"reason"]
//   requests to server: "endpoint\nid\nquery\nbody"; client heartbeat "[]" every 2.5s
// ─────────────────────────────────────────────────────────────────────────────

class TradovateSocket {
    constructor(opts) {
        this.url = opts.url;
        this.WebSocketImpl = opts.WebSocketImpl || globalThis.WebSocket;
        this.heartbeatMs = opts.heartbeatMs || 2500;
        // the server sends "h" frames every few seconds while we heartbeat back
        this.watchdogMs = opts.watchdogMs || 20000;
        this.requestTimeoutMs = opts.requestTimeoutMs || 15000;
        this.onEvent = opts.onEvent || (() => {});
        this.onClose = opts.onClose || (() => {});
        this.log = opts.log || (() => {});
        this.sleep = opts.sleep || sleep;
        this.ws = null;
        this.nextId = 1;
        this.pending = new Map();
        this.timers = [];
        this.closedByUser = false;
        this.closed = false;
        this.authorized = false;
        this.lastFrameAt = 0;
    }

    connect(token) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const done = (err) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (err) {
                    reject(err);
                }
                else {
                    resolve();
                }
            };
            let ws;
            try {
                ws = new this.WebSocketImpl(this.url);
            }
            catch (err) {
                done(err);
                return;
            }
            this.ws = ws;
            try {
                ws.binaryType = "arraybuffer";
            }
            catch (err) {
                // not supported by this implementation; Tradovate sends text frames anyway
            }
            this.lastFrameAt = Date.now();
            const authTimer = setTimeout(() => {
                done(new Error("Timed out connecting to " + this.url));
                this.close();
            }, this.requestTimeoutMs);

            ws.addEventListener("message", msg => {
                this.lastFrameAt = Date.now();
                let raw;
                try {
                    raw = typeof msg.data === "string" ? msg.data : Buffer.from(msg.data).toString("utf8");
                }
                catch (err) {
                    return;
                }
                this.handleFrame(raw, token, (ok, why) => {
                    clearTimeout(authTimer);
                    if (ok) {
                        this.authorized = true;
                        this.startTimers();
                        done();
                    }
                    else {
                        const err = new Error("Market data authorization failed: " + why);
                        err.auth = true;
                        done(err);
                        this.close();
                    }
                });
            });
            ws.addEventListener("error", ev => {
                const why = ev && (ev.message || (ev.error && ev.error.message));
                this.log("WebSocket error" + (why ? ": " + why : ""));
            });
            ws.addEventListener("close", ev => {
                clearTimeout(authTimer);
                this.teardown();
                const reason = (ev && ev.reason) || "";
                done(new Error("Connection closed before authorization" + (reason ? ": " + reason : "")));
                // a failed connect is reported through the rejected promise instead
                if (!this.closedByUser && this.authorized) {
                    this.onClose({ code: ev && ev.code, reason });
                }
            });
        });
    }

    handleFrame(raw, token, onAuth) {
        const kind = raw.charAt(0);
        if (kind === "o") {
            this.ws.send("authorize\n0\n\n" + token);
            return;
        }
        if (kind === "h") {
            return;
        }
        if (kind === "c") {
            let info = [];
            try {
                info = JSON.parse(raw.slice(1));
            }
            catch (err) {
                info = [];
            }
            this.log("Server closed the stream" + (info[1] ? ": " + info[1] : ""));
            try {
                this.ws.close();
            }
            catch (err) {
                // already closing
            }
            return;
        }
        if (kind !== "a") {
            return;
        }
        let items;
        try {
            items = JSON.parse(raw.slice(1));
        }
        catch (err) {
            this.log("Ignored an unreadable message from Tradovate.");
            return;
        }
        if (!Array.isArray(items)) {
            return;
        }
        items.forEach(item => {
            if (!item || typeof item !== "object") {
                return;
            }
            if (item.i === 0 && item.s !== undefined && onAuth) {
                onAuth(item.s === 200, typeof item.d === "string" ? item.d : JSON.stringify(item.d));
                return;
            }
            if (isNum(item.i) && item.s !== undefined && this.pending.has(item.i)) {
                const p = this.pending.get(item.i);
                this.pending.delete(item.i);
                clearTimeout(p.timer);
                if (item.s === 200 && !(item.d && typeof item.d === "object" && item.d.errorText)) {
                    p.resolve(item.d);
                }
                else if (item.s === 200) {
                    p.reject(new Error(p.url + " failed: " + item.d.errorText));
                }
                else {
                    const why = typeof item.d === "string" ? item.d : JSON.stringify(item.d);
                    p.reject(new Error(p.url + " failed (" + item.s + "): " + why));
                }
                return;
            }
            if (item.e) {
                this.onEvent(item);
            }
        });
    }

    startTimers() {
        this.timers.push(setInterval(() => {
            if (this.ws && this.ws.readyState === 1) {
                this.ws.send("[]");
            }
        }, this.heartbeatMs));
        this.timers.push(setInterval(() => {
            if (Date.now() - this.lastFrameAt > this.watchdogMs) {
                this.log("No data from Tradovate for " + Math.round(this.watchdogMs / 1000) + "s; reconnecting.");
                try {
                    this.ws.close();
                }
                catch (err) {
                    // ignore
                }
            }
        }, Math.min(this.watchdogMs, 5000)));
    }

    teardown() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.timers.forEach(clearInterval);
        this.timers = [];
        this.pending.forEach(p => {
            clearTimeout(p.timer);
            p.reject(new Error("Connection closed"));
        });
        this.pending.clear();
    }

    request(url, body, query) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== 1) {
                reject(new Error(url + " failed: not connected"));
                return;
            }
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(url + " timed out"));
            }, this.requestTimeoutMs);
            this.pending.set(id, { url, resolve, reject, timer });
            this.ws.send(url + "\n" + id + "\n" + (query || "") + "\n" + (body === undefined ? "" : JSON.stringify(body)));
        });
    }

    // Same as request() but waits out a time-penalty ticket once.
    async requestWithPenalty(url, body) {
        const d = await this.request(url, body);
        if (d && d["p-ticket"]) {
            if (d["p-captcha"]) {
                throw new Error(url + " blocked by a captcha requirement; try again in an hour.");
            }
            const wait = Math.max(1, Number(d["p-time"]) || 5);
            this.log(url + ": rate limited, retrying in " + wait + "s");
            await this.sleep(wait * 1000);
            return this.request(url, Object.assign({}, body, { "p-ticket": d["p-ticket"] }));
        }
        return d;
    }

    close() {
        this.closedByUser = true;
        this.teardown();
        if (this.ws) {
            try {
                this.ws.close(1000, "client closing");
            }
            catch (err) {
                // ignore
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulator — a synthetic book for --simulate (and the tests). It plants a real
// wall that holds, a spoof wall that is pulled as price nears, an offer wall that
// gets traded through, and short flashes that the persistence filter ignores.
// ─────────────────────────────────────────────────────────────────────────────

class Simulator {
    constructor(opts) {
        this.tick = (opts && opts.tick) || 0.25;
        this.depth = (opts && opts.depth) || 20;   // deep enough that the demo walls stay in view
        this.seed = (opts && opts.seed) || 42;
        this.t = (opts && opts.start) || Date.now();
        this.stepMs = (opts && opts.stepMs) || 100;
        this.mid = Math.round(21000 / this.tick);   // best bid ticks; best ask = mid + 1
        this.volume = 100000;
        this.base = new Map();
        this.walls = [];
        this.consumed = new Map();
        this.steps = 0;
        this.phase = 0;
        this.drift = 0;
    }

    // mulberry32: integer-exact, so the feed never falls into a short repeat
    rand() {
        this.seed = (this.seed + 0x6d2b79f5) | 0;
        let t = Math.imul(this.seed ^ (this.seed >>> 15), 1 | this.seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    baseSize(ticks) {
        if (!this.base.has(ticks)) {
            this.base.set(ticks, 8 + Math.floor(this.rand() * 30));
        }
        return this.base.get(ticks);
    }

    wallAt(side, ticks) {
        return this.walls.find(w => w.side === side && w.ticks === ticks && w.size > 0);
    }

    // scripted scenario, by step count (stepMs each)
    script() {
        const s = this.steps;
        if (s === 1) {
            this.walls.push({ side: "bid", ticks: this.mid - 6, size: 400, kind: "real", refill: 400 });
            this.walls.push({ side: "ask", ticks: this.mid + 5, size: 260, kind: "thin" });
            this.walls.push({ side: "ask", ticks: this.mid + 9, size: 350, kind: "spoof" });
        }
        if (s % 37 === 0) {
            const side = this.rand() < 0.5 ? "bid" : "ask";
            const off = 3 + Math.floor(this.rand() * 5);
            this.walls.push({ side, ticks: side === "bid" ? this.mid - off : this.mid + 1 + off, size: 300, kind: "flash", ttl: 5 + Math.floor(this.rand() * 10) });
        }
        // drift: down into the real bid wall, back up through the spoof, up through the thin offer
        if (s < 200) {
            this.drift = 0;
        }
        else if (s < 450) {
            this.drift = -1;
        }
        else if (s < 900) {
            this.drift = 1;
        }
        else {
            this.drift = this.rand() < 0.5 ? -1 : 1;
        }
    }

    // queue left at a price after earlier trades consumed part of it
    remaining(ticks) {
        return Math.max(0, this.baseSize(ticks) - (this.consumed.get(ticks) || 0));
    }

    step() {
        this.steps++;
        this.t += this.stepMs;
        this.script();
        this.walls.forEach(w => {
            if (w.kind === "flash" && --w.ttl <= 0) {
                w.size = 0;
            }
            if (w.kind === "spoof" && w.size > 0 && w.ticks - (this.mid + 1) <= 2) {
                w.size = 0; // pulled as price approaches — never traded
            }
        });
        // one market order per step, direction biased by the drift; it eats the
        // queue at the touch, then any wall there; an emptied price lets price tick
        const up = this.drift > 0 ? this.rand() < 0.7 : this.drift < 0 ? this.rand() < 0.3 : this.rand() < 0.5;
        const qty = 2 + Math.floor(this.rand() * 12);
        const side = up ? "ask" : "bid";
        const at = up ? this.mid + 1 : this.mid;
        const w = this.wallAt(side, at);
        const fromQueue = Math.min(qty, this.remaining(at));
        this.consumed.set(at, (this.consumed.get(at) || 0) + fromQueue);
        let fromWall = 0;
        if (w && qty > fromQueue) {
            fromWall = Math.min(qty - fromQueue, w.size);
            w.size -= fromWall;
        }
        const traded = fromQueue + fromWall;
        if (traded > 0) {
            this.volume += traded;
            this.lastTrade = { ticks: at, qty: traded };
        }
        if (w && w.kind === "real" && w.size < 150) {
            w.size = w.refill;   // iceberg-style refill: the buyer keeps defending
            this.mid += 2;       // and the market bounces off it
            this.consumed.clear();
        }
        else if (this.remaining(at) === 0 && !(w && w.size > 0)) {
            this.mid += up ? 1 : -1;
            this.consumed.delete(at);
        }
        this.walls = this.walls.filter(x => x.size > 0 || x.kind === "real");
        return { dom: this.dom(), quote: this.quote() };
    }

    dom() {
        const bids = [];
        const offers = [];
        for (let i = 0; i < this.depth; ++i) {
            const b = this.mid - i;
            const a = this.mid + 1 + i;
            const bw = this.wallAt("bid", b);
            const aw = this.wallAt("ask", a);
            const bs = this.remaining(b) + (bw ? bw.size : 0);
            const as = this.remaining(a) + (aw ? aw.size : 0);
            if (bs > 0) {
                bids.push({ price: Number((b * this.tick).toFixed(4)), size: bs });
            }
            if (as > 0) {
                offers.push({ price: Number((a * this.tick).toFixed(4)), size: as });
            }
        }
        return { contractId: 1, timestamp: new Date(this.t).toISOString(), bids, offers };
    }

    quote() {
        const tr = this.lastTrade || { ticks: this.mid, qty: 0 };
        return {
            contractId: 1,
            timestamp: new Date(this.t).toISOString(),
            entries: {
                Bid: { price: Number((this.mid * this.tick).toFixed(4)), size: this.remaining(this.mid) },
                Offer: { price: Number(((this.mid + 1) * this.tick).toFixed(4)), size: this.remaining(this.mid + 1) },
                Trade: { price: Number((tr.ticks * this.tick).toFixed(4)), size: tr.qty },
                TotalTradeVolume: { size: this.volume }
            }
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminal + web dashboard
// ─────────────────────────────────────────────────────────────────────────────

function renderTerminal(snap, status, color, logLines) {
    const c = (code, s) => color ? "\x1b[" + code + "m" + s + "\x1b[0m" : s;
    const lines = [];
    lines.push(c("1", "Resting Order Levels (DOM)") + "  " + status.symbol + "  " + status.mode + "  " +
        (status.connected ? c("32", "connected") : c("33", status.state || "connecting")) +
        (snap.now ? "  " + fmtClock(snap.now) : ""));
    const tail = () => (logLines || []).forEach(l => lines.push(c("2", l)));
    if (!snap.domCount) {
        lines.push("waiting for order book data...");
        lines.push("");
        tail();
        return lines.join("\n");
    }
    lines.push("last " + (snap.last || "-") +
        "   bid " + (snap.bestBid ? snap.bestBid.priceText + " x" + snap.bestBid.size : "-") +
        "   ask " + (snap.bestAsk ? snap.bestAsk.priceText + " x" + snap.bestAsk.size : "-") +
        "   wall >= " + snap.threshold.bid + " bid / " + snap.threshold.ask + " offer" +
        "   flashes ignored " + snap.flashes);
    const res = snap.levels.filter(l => l.side === "ask").slice().reverse();
    const sup = snap.levels.filter(l => l.side === "bid");
    lines.push("");
    lines.push(c("31;1", "RESISTANCE (resting offers)"));
    lines.push(res.length ? res.map(l => "  " + c("31", levelLabel(l))).join("\n") : "  none yet");
    lines.push(c("32;1", "SUPPORT (resting bids)"));
    lines.push(sup.length ? sup.map(l => "  " + c("32", levelLabel(l))).join("\n") : "  none yet");
    lines.push("");
    lines.push(c("1", "RECENT"));
    const ev = snap.events.filter(e => e.type !== "born").slice(0, 8);
    lines.push(ev.length ? ev.map(e => "  " + eventLabel(e)).join("\n") : "  nothing yet");
    (snap.warnings || []).forEach(w => lines.push(c("33", "note: " + w)));
    lines.push("");
    tail();
    return lines.join("\n");
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Resting Order Levels</title>
<style>
:root { --bg:#0f1216; --panel:#171b21; --line:#262c35; --text:#d8dee6; --dim:#8a94a3;
        --bid:#26a69a; --ask:#ef5350; --warn:#f0b429; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:13px/1.4 ui-monospace, Menlo, Consolas, monospace; }
header { padding:10px 16px; border-bottom:1px solid var(--line); display:flex; gap:16px; flex-wrap:wrap; align-items:baseline; }
header h1 { font-size:15px; margin:0; }
.dim { color:var(--dim); }
.ok { color:var(--bid); } .bad { color:var(--warn); }
main { display:grid; grid-template-columns:minmax(260px, 340px) 1fr; gap:16px; padding:16px; }
@media (max-width: 760px) { main { grid-template-columns:1fr; } }
section { background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:10px 12px; min-width:0; }
h2 { font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--dim); margin:4px 0 8px; }
table { border-collapse:collapse; width:100%; }
.ladder td { padding:1px 6px; text-align:right; white-space:nowrap; }
.ladder td.p { text-align:center; color:var(--dim); }
.ladder td.b { color:var(--bid); } .ladder td.a { color:var(--ask); }
.ladder tr.last td.p { color:var(--text); background:#2a3240; }
.ladder tr.lvl-S td { background:rgba(38,166,154,.14); }
.ladder tr.lvl-R td { background:rgba(239,83,80,.14); }
.ladder td.tag { text-align:left; font-weight:bold; width:3em; }
.bar { display:inline-block; height:9px; vertical-align:middle; border-radius:2px; }
.levels div { padding:3px 0; border-bottom:1px solid var(--line); overflow-wrap:anywhere; }
.levels .S { color:var(--bid); } .levels .R { color:var(--ask); }
.flag { color:var(--warn); font-weight:bold; }
.events div { padding:2px 0; color:var(--dim); overflow-wrap:anywhere; }
.events .pulled { color:var(--warn); } .events .filled, .events .held { color:var(--text); } .events .broken { color:var(--ask); }
</style>
</head>
<body>
<header>
  <h1>Resting Order Levels</h1>
  <span id="sym"></span>
  <span id="conn" class="bad">connecting…</span>
  <span id="quote" class="dim"></span>
  <span id="thr" class="dim"></span>
</header>
<main>
  <section><h2>Order book</h2><table class="ladder"><tbody id="ladder"></tbody></table></section>
  <div>
    <section><h2>Resistance — resting offers</h2><div class="levels" id="res"></div></section>
    <section style="margin-top:16px"><h2>Support — resting bids</h2><div class="levels" id="sup"></div></section>
    <section style="margin-top:16px"><h2>Recent</h2><div class="events" id="events"></div></section>
  </div>
</main>
<script>
"use strict";
const $ = id => document.getElementById(id);
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function age(ms) { const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return s + "s"; const m = Math.floor(s / 60); return m < 60 ? m + "m" + String(s % 60).padStart(2, "0") + "s" : Math.floor(m / 60) + "h" + String(m % 60).padStart(2, "0") + "m"; }
function clock(ms) { return new Date(ms).toLocaleTimeString("en-US", { hour12: false }); }
function label(l) {
  const parts = [l.name + " " + l.priceText, l.visible ? l.size + " resting" : "out of view (last " + l.size + ", " + age(l.lastSeenAgoMs) + " ago)", age(l.ageMs)];
  if (l.holds) parts.push("held " + l.holds + "x");
  if (l.filled) parts.push(l.filled + " filled");
  if (l.pulledHereBefore) parts.push("pulled here " + l.pulledHereBefore + "x before");
  return parts.join(" | ");
}
function renderLevels(target, list) {
  target.replaceChildren();
  if (!list.length) { target.append(el("div", "dim", "none yet")); return; }
  list.forEach(l => {
    const row = el("div", l.name[0], label(l));
    if (l.absorbing) row.append(el("span", "flag", "  << ABSORBING"));
    else if (l.fading) row.append(el("span", "flag", "  << SHRINKING"));
    target.append(row);
  });
}
const NAMES = { born: "NEW", held: "HELD", filled: "FILLED", pulled: "PULLED", broken: "BROKEN", stale: "EXPIRED" };
function render(msg) {
  const st = msg.status, s = msg.snapshot;
  $("sym").textContent = st.symbol + " · " + st.mode;
  $("conn").textContent = st.connected ? "connected" : (st.state || "connecting…");
  $("conn").className = st.connected ? "ok" : "bad";
  if (!s.domCount) { $("quote").textContent = "waiting for order book data…"; return; }
  $("quote").textContent = "last " + (s.last || "-") + "  bid " + (s.bestBid ? s.bestBid.priceText + " x" + s.bestBid.size : "-") + "  ask " + (s.bestAsk ? s.bestAsk.priceText + " x" + s.bestAsk.size : "-");
  $("thr").textContent = "wall ≥ " + s.threshold.bid + " bid / " + s.threshold.ask + " offer · flashes ignored " + s.flashes + (s.now ? " · " + clock(s.now) : "");
  const max = Math.max(1, ...s.ladder.map(r => Math.max(r.bid, r.ask)));
  const body = $("ladder"); body.replaceChildren();
  s.ladder.forEach(r => {
    const tr = el("tr", (r.last ? "last " : "") + (r.level ? "lvl-" + r.level[0] : ""));
    const bid = el("td", "b"); if (r.bid) { const bar = el("span", "bar"); bar.style.width = Math.round(60 * r.bid / max) + "px"; bar.style.background = "var(--bid)"; bid.append(String(r.bid) + " ", bar); }
    const ask = el("td", "a"); if (r.ask) { const bar = el("span", "bar"); bar.style.width = Math.round(60 * r.ask / max) + "px"; bar.style.background = "var(--ask)"; ask.append(bar, " " + String(r.ask)); }
    ask.style.textAlign = "left";
    tr.append(el("td", "tag " + (r.level ? (r.level[0] === "S" ? "b" : "a") : ""), r.level), bid, el("td", "p", r.priceText), ask);
    body.append(tr);
  });
  renderLevels($("res"), s.levels.filter(l => l.side === "ask").slice().reverse());
  renderLevels($("sup"), s.levels.filter(l => l.side === "bid"));
  const ev = $("events"); ev.replaceChildren();
  s.events.filter(e => e.type !== "born").slice(0, 12).forEach(e => {
    let t = clock(e.t) + "  " + NAMES[e.type] + "  " + (e.side === "bid" ? "bid " : "offer ") + e.priceText;
    if (e.type === "held") t += "  (held " + e.holds + "x)";
    else t += "  (peak " + e.peak + ", " + e.filled + " traded there)";
    ev.append(el("div", e.type, t));
  });
  if (!ev.children.length) ev.append(el("div", "dim", "nothing yet"));
}
function connect() {
  const src = new EventSource("events");
  src.onmessage = m => { try { render(JSON.parse(m.data)); } catch (err) { console.error(err); } };
  src.onerror = () => { $("conn").textContent = "dashboard disconnected — retrying"; $("conn").className = "bad"; };
}
connect();
</script>
</body>
</html>
`;

function startDashboard(app, port, log) {
    const clients = new Set();
    const server = http.createServer((req, res) => {
        const url = (req.url || "/").split("?")[0];
        if (url === "/" || url === "/index.html") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
            res.end(DASHBOARD_HTML);
        }
        else if (url === "/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-store",
                Connection: "keep-alive"
            });
            res.write("retry: 2000\n\n");
            res.write("data: " + JSON.stringify(app.state()) + "\n\n");
            clients.add(res);
            req.on("close", () => clients.delete(res));
        }
        else if (url === "/state.json") {
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify(app.state()));
        }
        else {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("not found");
        }
    });
    const timer = setInterval(() => {
        if (!clients.size) {
            return;
        }
        const payload = "data: " + JSON.stringify(app.state()) + "\n\n";
        clients.forEach(res => res.write(payload));
    }, 500);
    return new Promise((resolve, reject) => {
        server.once("error", err => {
            clearInterval(timer);
            reject(err.code === "EADDRINUSE"
                ? new Error("Port " + port + " is already in use; pass --port <another number> or --no-web.")
                : err);
        });
        // localhost only: the dashboard is never exposed to the network
        server.listen(port, "127.0.0.1", () => {
            log("Dashboard: http://127.0.0.1:" + server.address().port);
            resolve({
                server,
                port: server.address().port,
                close: () => new Promise(done => {
                    clearInterval(timer);
                    clients.forEach(res => res.end());
                    server.close(() => done());
                })
            });
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// App: login → market-data socket → subscriptions → engine → UI, with reconnects
// ─────────────────────────────────────────────────────────────────────────────

class DomLevelsApp {
    constructor(config, deps) {
        this.cfg = config;
        this.deps = deps || {};
        this.logLines = [];
        this.ttyView = !!(config.terminal && process.stdout.isTTY && !this.deps.log);
        this.log = msg => {
            this.logLines.push(fmtClock(Date.now()) + "  " + msg);
            if (this.logLines.length > 5) {
                this.logLines.shift();
            }
            if (this.deps.log) {
                this.deps.log(msg);
            }
            else if (!this.ttyView) {
                console.error("[domLevels] " + msg);
            }
        };
        this.engine = new LevelEngine(config.engine);
        this.status = {
            symbol: config.simulate ? "SIM" : config.symbol,
            mode: config.simulate ? "simulation" : config.replay ? "replay " + config.replay : config.env,
            connected: false,
            state: "starting"
        };
        this.contract = null;
        this.token = null;
        this.socket = null;
        this.stopping = false;
        this.timers = [];
        this.attempt = 0;
        this.connectedAt = 0;
        this.streamingSince = 0;
        this.domAtStream = 0;
        this.logStream = null;
        this.engine.onEvent(ev => this.onLevelEvent(ev));
    }

    state() {
        return { status: this.status, snapshot: this.engine.snapshot(40) };
    }

    onLevelEvent(ev) {
        if (this.logStream) {
            this.logStream.write(JSON.stringify(Object.assign({ symbol: this.status.symbol, time: new Date(ev.t).toISOString() }, ev)) + "\n");
        }
        if (this.deps.onLevelEvent) {
            this.deps.onLevelEvent(ev);
        }
    }

    async start() {
        if (this.cfg.log) {
            this.logStream = fs.createWriteStream(this.cfg.log, { flags: "a" });
            this.logStream.on("error", err => {
                this.log("Event log disabled: " + err.message);
                this.logStream = null;
            });
        }
        if (this.cfg.web) {
            this.dashboard = await startDashboard(this, this.cfg.port, this.log);
        }
        this.timers.push(setInterval(() => this.healthCheck(), 1000));
        if (this.ttyView) {
            this.timers.push(setInterval(() => {
                process.stdout.write("\x1b[H\x1b[2J" + renderTerminal(this.engine.snapshot(40), this.status, true, this.logLines) + "\n");
            }, 1000));
        }
        else if (this.cfg.terminal) {
            this.engine.onEvent(ev => {
                if (ev.type !== "born") {
                    console.log(eventLabel(ev));
                }
            });
        }
        if (this.cfg.simulate) {
            this.runSimulation();
            return;
        }
        await this.login();
        await this.connectLoop();
    }

    // Subscribed but no book: usually market closed or no market-data entitlement.
    healthCheck() {
        if (!this.status.connected || !this.streamingSince || this.cfg.simulate) {
            return;
        }
        const quiet = this.engine.domCount === this.domAtStream && Date.now() - this.streamingSince > 15000;
        this.status.state = quiet
            ? "subscribed, but no order book data yet - market closed, or no market data subscription for this symbol?"
            : "streaming";
    }

    runSimulation() {
        const sim = new Simulator({ tick: 0.25 });
        this.engine.setTick(0.25);
        this.status.connected = true;
        this.status.state = "simulating";
        this.timers.push(setInterval(() => {
            const out = sim.step();
            this.engine.onDom(out.dom);
            this.engine.onQuote(out.quote);
        }, sim.stepMs));
    }

    credentials() {
        return {
            username: this.cfg.username,
            password: this.cfg.password,
            appId: this.cfg.appId,
            appVersion: this.cfg.appVersion,
            cid: this.cfg.cid,
            secret: this.cfg.secret,
            deviceId: this.cfg.deviceId
        };
    }

    async login() {
        this.rest = this.rest || new TradovateRest({ env: this.cfg.env, fetchImpl: this.deps.fetchImpl, log: this.log, sleep: this.deps.sleep });
        this.status.state = "logging in";
        this.token = await this.rest.requestToken(this.credentials());
        this.log("Logged in" + (this.token.name ? " as " + this.token.name : "") + ".");
        if (!this.contract) {
            this.contract = await this.rest.resolveContract(this.cfg.symbol, this.token.accessToken);
            if (this.contract.tickSize && !this.cfg.engine.tick) {
                this.engine.setTick(this.contract.tickSize);
            }
            this.status.symbol = this.contract.name;
            this.log("Contract " + this.contract.name + " (id " + this.contract.id + ")" +
                (this.contract.tickSize ? ", tick " + this.contract.tickSize : "") + ".");
        }
        this.scheduleRenewal();
    }

    scheduleRenewal() {
        if (this.renewTimer) {
            clearTimeout(this.renewTimer);
        }
        const wait = Math.max(60000, this.token.expiresAt - Date.now() - 15 * 60000);
        this.renewTimer = setTimeout(() => this.renew(), Math.min(wait, 2147483000));
    }

    async renew() {
        if (this.stopping) {
            return;
        }
        try {
            this.token = await this.rest.renewToken(this.token);
            this.log("Session renewed.");
        }
        catch (err) {
            this.log("Session renewal failed (" + err.message + "); logging in again.");
            try {
                await this.login();
                return;
            }
            catch (err2) {
                this.log("Login failed: " + err2.message + " — will retry in 60s.");
                this.renewTimer = setTimeout(() => this.renew(), 60000);
                return;
            }
        }
        this.scheduleRenewal();
    }

    async connectLoop() {
        while (!this.stopping) {
            try {
                await this.connectOnce();
                return;
            }
            catch (err) {
                if (this.stopping) {
                    return;
                }
                if (err.fatal || this.cfg.replay) {
                    throw err;
                }
                this.attempt++;
                const wait = Math.min(30, Math.pow(2, this.attempt - 1));
                this.status.connected = false;
                this.status.state = "retrying in " + wait + "s";
                this.log(err.message + " — retrying in " + wait + "s.");
                await (this.deps.sleep || sleep)(wait * 1000);
                if (this.stopping) {
                    return;
                }
                if (err.auth || Date.now() > this.token.expiresAt - 5 * 60000) {
                    try {
                        await this.login();
                    }
                    catch (loginErr) {
                        this.log(loginErr.message);
                    }
                }
            }
        }
    }

    async connectOnce() {
        const url = this.cfg.replay ? URLS.replay : URLS.md;
        this.status.state = "connecting";
        const socket = new TradovateSocket({
            url,
            WebSocketImpl: this.deps.WebSocketImpl,
            heartbeatMs: this.deps.heartbeatMs,
            watchdogMs: this.deps.watchdogMs,
            requestTimeoutMs: this.deps.requestTimeoutMs,
            sleep: this.deps.sleep,
            log: this.log,
            onEvent: item => this.onSocketEvent(item, socket),
            onClose: info => this.onSocketClose(info, socket)
        });
        this.socket = socket;
        await socket.connect(this.token.mdAccessToken);
        if (this.everStreamed) {
            this.engine.markGap();
        }
        try {
            await this.subscribe(socket);
        }
        catch (err) {
            socket.close();
            throw err;
        }
        this.everStreamed = true;
        this.connectedAt = Date.now();
        this.streamingSince = Date.now();
        this.domAtStream = this.engine.domCount;
        this.status.connected = true;
        this.status.state = "streaming";
        this.log("Streaming " + this.contract.name + " order book" + (this.cfg.replay ? " (replay)" : "") + ".");
    }

    async subscribe(socket) {
        if (this.cfg.replay) {
            const check = await socket.request("replay/checkreplaysession", { startTimestamp: this.cfg.replay });
            const status = check && check.checkStatus;
            if (status === "Ineligible" || !status) {
                const err = new Error("Market Replay is not available for " + this.cfg.replay + " on this account (checkStatus: " + (status || "none") + ").");
                err.fatal = true;
                throw err;
            }
            let start = this.cfg.replay;
            if (status === "StartTimestampAdjusted" && check.startTimestamp) {
                start = check.startTimestamp;
                this.log("Replay start adjusted by Tradovate to " + start + ".");
            }
            const init = await socket.request("replay/initializeclock", { startTimestamp: start, speed: this.cfg.speed, initialBalance: 50000 });
            if (init && init.errorText) {
                const err = new Error("Replay clock failed: " + init.errorText);
                err.fatal = true;
                throw err;
            }
        }

        await socket.requestWithPenalty("md/subscribeDOM", { symbol: this.contract.name });
        await socket.requestWithPenalty("md/subscribeQuote", { symbol: this.contract.name });
    }

    onSocketEvent(item, socket) {
        if (socket !== this.socket) {
            return;
        }
        if (item.e === "md" && item.d) {
            const mine = x => !this.contract || !isNum(x.contractId) || x.contractId === this.contract.id;
            (item.d.doms || []).filter(mine).forEach(dom => this.engine.onDom(dom));
            (item.d.quotes || []).filter(mine).forEach(q => this.engine.onQuote(q));
        }
        else if (item.e === "clock" && this.cfg.replay) {
            this.onReplayClock(item.d, socket);
        }
        else if (item.e === "shutdown") {
            this.log("Tradovate is restarting the market-data server; reconnecting.");
            socket.ws.close();
        }
    }

    // Replay clock sync: {"t": replay time, "s": speed}, sent as a JSON string.
    // Tradovate pauses idle replay sessions (s = 0); ask it to resume at our speed.
    onReplayClock(d, socket) {
        let clock = d;
        if (typeof d === "string") {
            try {
                clock = JSON.parse(d);
            }
            catch (err) {
                return;
            }
        }
        if (!clock || typeof clock !== "object") {
            return;
        }
        if (clock.t) {
            this.status.replayTime = clock.t;
        }
        if (clock.s === 0 && this.cfg.speed > 0 && Date.now() - (this.lastResumeAt || 0) > 5000) {
            this.lastResumeAt = Date.now();
            this.log("Tradovate paused the replay; resuming at speed " + this.cfg.speed + ".");
            socket.request("replay/changespeed", { speed: this.cfg.speed })
                .catch(err => this.log("Could not resume the replay: " + err.message));
        }
    }

    onSocketClose(info, socket) {
        if (this.stopping || socket !== this.socket) {
            return;
        }
        this.status.connected = false;
        if (this.cfg.replay) {
            this.status.state = "replay ended";
            this.log("Replay connection closed" + (info.reason ? ": " + info.reason : "") + ".");
            return;
        }
        this.streamingSince = 0;
        const flapping = Date.now() - this.connectedAt < 30000;
        this.attempt = flapping ? this.attempt + 1 : 0;
        const wait = flapping ? Math.min(30, Math.pow(2, this.attempt - 1)) : 0;
        this.status.state = "reconnecting";
        this.log("Market data connection lost" + (info.reason ? " (" + info.reason + ")" : "") +
            "; reconnecting" + (wait ? " in " + wait + "s" : "") + ".");
        const t = setTimeout(() => {
            this.connectLoop().catch(err => {
                this.status.state = "stopped: " + err.message;
                this.log(err.message);
            });
        }, wait * 1000);
        this.timers.push(t);
    }

    async stop() {
        this.stopping = true;
        this.timers.forEach(t => {
            clearInterval(t);
            clearTimeout(t);
        });
        this.timers = [];
        if (this.renewTimer) {
            clearTimeout(this.renewTimer);
        }
        if (this.socket && this.socket.ws && this.socket.ws.readyState === 1 && this.contract) {
            await Promise.race([
                Promise.all([
                    this.socket.request("md/unsubscribeDOM", { symbol: this.contract.name }).catch(() => {}),
                    this.socket.request("md/unsubscribeQuote", { symbol: this.contract.name }).catch(() => {})
                ]),
                sleep(1500)
            ]);
        }
        if (this.socket) {
            this.socket.close();
        }
        if (this.dashboard) {
            await this.dashboard.close();
        }
        if (this.logStream) {
            await new Promise(done => this.logStream.end(done));
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Config + CLI
// ─────────────────────────────────────────────────────────────────────────────

const HELP = `Resting Order Levels (DOM) — support/resistance from Tradovate's live order book

Usage:
  node domLevels.js --symbol MNQZ6 [options]
  node domLevels.js --symbol MNQZ6 --replay 2026-10-16T13:30:00Z [--speed 100]
  node domLevels.js --simulate

Connection:
  --symbol <name>       full contract name (MNQZ6, ESZ6, NQZ6, ...)
  --env demo|live       REST environment for login (default demo; market data is the same)
  --config <file>       JSON config (default: domLevels.config.json next to this script)
  --replay <ISO time>   use Tradovate Market Replay from this UTC start time
  --speed <0-400>       replay speed in percent (100 = real time)
  --simulate            synthetic order book, no login (to try the tool)

Output:
  --port <n>            dashboard port (default 8787, 127.0.0.1 only)
  --no-web              no dashboard
  --no-terminal         no terminal view
  --log <file>          append every level event as JSON lines

Level rules (defaults in parentheses):
  --wall-multiple (3)   wall = size >= N × median visible size on that side
  --min-size (0)        minimum wall size in contracts
  --persist-sec (10)    seconds a wall must rest before it counts
  --fill-share (0.5)    share of a drop that must trade for "filled" (else "pulled")
  --touch-ticks (1)  --hold-ticks (4)  --break-ticks (2)
  --levels-per-side (5) --stale-min (30) --tick (auto)

Credentials (config file keys / environment variables):
  username / TRADOVATE_USERNAME     password / TRADOVATE_PASSWORD
  cid / TRADOVATE_CID               secret / TRADOVATE_SECRET
  appId / TRADOVATE_APP_ID          appVersion / TRADOVATE_APP_VERSION
`;

const ENGINE_FLAGS = {
    "wall-multiple": "wallMultiple",
    "min-size": "minSize",
    "persist-sec": "persistSec",
    "end-ratio": "endRatio",
    "settle-sec": "settleSec",
    "fill-share": "fillShare",
    "touch-ticks": "touchTicks",
    "hold-ticks": "holdTicks",
    "break-ticks": "breakTicks",
    "levels-per-side": "levelsPerSide",
    "stale-min": "staleMin",
    "baseline-sec": "baselineSec",
    "absorb-sec": "absorbSec",
    tick: "tick"
};

const APP_FLAGS = {
    symbol: "symbol",
    env: "env",
    config: "config",
    replay: "replay",
    speed: "speed",
    port: "port",
    log: "log",
    username: "username",
    password: "password",
    cid: "cid",
    secret: "secret",
    "app-id": "appId",
    "app-version": "appVersion",
    "device-id": "deviceId"
};

function parseArgs(argv) {
    const out = { app: {}, engine: {}, help: false };
    for (let i = 0; i < argv.length; ++i) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") {
            out.help = true;
            continue;
        }
        if (arg === "--simulate") {
            out.app.simulate = true;
            continue;
        }
        if (arg === "--no-web") {
            out.app.web = false;
            continue;
        }
        if (arg === "--no-terminal") {
            out.app.terminal = false;
            continue;
        }
        if (!arg.startsWith("--")) {
            throw new Error("Unexpected argument: " + arg);
        }
        let name = arg.slice(2);
        let value;
        const eq = name.indexOf("=");
        if (eq >= 0) {
            value = name.slice(eq + 1);
            name = name.slice(0, eq);
        }
        else {
            value = argv[++i];
        }
        if (value === undefined || (value.startsWith("--") && eq < 0)) {
            throw new Error("Missing value for --" + name);
        }
        if (ENGINE_FLAGS[name]) {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 0) {
                throw new Error("--" + name + " needs a non-negative number");
            }
            out.engine[ENGINE_FLAGS[name]] = n;
        }
        else if (APP_FLAGS[name]) {
            out.app[APP_FLAGS[name]] = value;
        }
        else {
            throw new Error("Unknown option --" + name + " (see --help)");
        }
    }
    return out;
}

function deviceIdFor(dir) {
    const file = path.join(dir, ".domLevels-device-id");
    try {
        const saved = fs.readFileSync(file, "utf8").trim();
        if (saved) {
            return saved;
        }
    }
    catch (err) {
        // first run
    }
    const id = crypto.randomUUID();
    try {
        fs.writeFileSync(file, id + "\n", { mode: 0o600 });
    }
    catch (err) {
        // read-only folder: still works, but Tradovate will see a new device each run
    }
    return id;
}

// defaults < config file < TRADOVATE_* env < flags
function loadConfig(args, env, scriptDir) {
    const cfg = Object.assign({}, APP_DEFAULTS);
    const engine = {};
    const file = args.app.config || path.join(scriptDir, "domLevels.config.json");
    if (fs.existsSync(file)) {
        let json;
        try {
            json = JSON.parse(fs.readFileSync(file, "utf8"));
        }
        catch (err) {
            throw new Error("Could not read " + file + ": " + err.message);
        }
        Object.keys(json).forEach(k => {
            if (k in ENGINE_DEFAULTS) {
                engine[k] = Number(json[k]);
            }
            else {
                cfg[k] = json[k];
            }
        });
    }
    else if (args.app.config) {
        throw new Error("Config file not found: " + file);
    }
    const envMap = {
        TRADOVATE_USERNAME: "username",
        TRADOVATE_PASSWORD: "password",
        TRADOVATE_CID: "cid",
        TRADOVATE_SECRET: "secret",
        TRADOVATE_APP_ID: "appId",
        TRADOVATE_APP_VERSION: "appVersion",
        TRADOVATE_ENV: "env",
        TRADOVATE_DEVICE_ID: "deviceId"
    };
    Object.keys(envMap).forEach(k => {
        if (env[k]) {
            cfg[envMap[k]] = env[k];
        }
    });
    Object.assign(cfg, args.app);
    cfg.engine = Object.assign({}, engine, args.engine);
    Object.keys(cfg.engine).forEach(k => {
        if (!Number.isFinite(cfg.engine[k]) || cfg.engine[k] < 0) {
            throw new Error("Setting " + k + " must be a non-negative number");
        }
    });
    cfg.port = Number(cfg.port);
    cfg.speed = Number(cfg.speed);
    cfg.env = String(cfg.env).toLowerCase();
    if (cfg.env !== "demo" && cfg.env !== "live") {
        throw new Error("--env must be demo or live");
    }
    if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) {
        throw new Error("--port must be 0-65535");
    }
    if (!Number.isInteger(cfg.speed) || cfg.speed < 0 || cfg.speed > 400) {
        throw new Error("--speed must be a whole number 0-400 (100 = real time)");
    }
    if (cfg.replay && !Number.isFinite(Date.parse(cfg.replay))) {
        throw new Error("--replay needs an ISO date-time, e.g. 2026-10-16T13:30:00Z");
    }
    if (cfg.replay) {
        cfg.replay = new Date(Date.parse(cfg.replay)).toISOString();
    }
    if (!cfg.simulate) {
        const missing = ["symbol", "username", "password", "cid", "secret"].filter(k => !cfg[k] && cfg[k] !== 0);
        if (missing.length) {
            throw new Error("Missing " + missing.join(", ") + ". Put them in domLevels.config.json (see domLevels.config.example.json) or pass --simulate to try the tool without a login.");
        }
        const placeholders = ["username", "password", "secret"].filter(k => /^your /i.test(String(cfg[k])));
        if (placeholders.length || Number(cfg.cid) === 0) {
            throw new Error("Fill in your real " + placeholders.concat(Number(cfg.cid) === 0 ? ["cid"] : []).join(", ") +
                " in domLevels.config.json (the API key's cid and secret come from Tradovate's API Access settings).");
        }
        cfg.symbol = String(cfg.symbol).trim().toUpperCase();
    }
    // simulation never logs in, so it never needs (or writes) a device id
    cfg.deviceId = cfg.deviceId || (cfg.simulate ? "" : deviceIdFor(scriptDir));
    return cfg;
}

async function main() {
    let args;
    let cfg;
    try {
        args = parseArgs(process.argv.slice(2));
        if (args.help) {
            process.stdout.write(HELP);
            return;
        }
        if (typeof globalThis.WebSocket !== "function" || typeof globalThis.fetch !== "function") {
            throw new Error("Node.js 22 or newer is required (built-in WebSocket). You have " + process.version + ".");
        }
        cfg = loadConfig(args, process.env, __dirname);
    }
    catch (err) {
        console.error("Error: " + err.message);
        process.exitCode = 1;
        return;
    }
    const app = new DomLevelsApp(cfg);
    let stopping = false;
    const shutdown = async () => {
        if (stopping) {
            process.exit(1);
        }
        stopping = true;
        console.error("\nStopping...");
        await app.stop().catch(() => {});
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    try {
        await app.start();
    }
    catch (err) {
        console.error("Error: " + err.message);
        await app.stop().catch(() => {});
        process.exit(1);
    }
}

module.exports = {
    URLS,
    ENGINE_DEFAULTS,
    LevelEngine,
    TradovateRest,
    TradovateSocket,
    Simulator,
    DomLevelsApp,
    startDashboard,
    renderTerminal,
    levelLabel,
    eventLabel,
    parseArgs,
    loadConfig,
    DASHBOARD_HTML
};

if (require.main === module) {
    main();
}

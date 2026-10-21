#!/usr/bin/env node
// Offline harness for liquidityRegimeMeter.js.
//
//   node indicators/tradovate/test/meterHarness.js          (quick: ~10 s)
//   node indicators/tradovate/test/meterHarness.js --full   (more seeds)
//
// Runs the indicator the way Tradovate calls it (map() once per bar, then
// repeatedly on the live bar) on synthetic 1-minute footprint sessions with
// real US-Eastern timestamps and trade dates. Exits non-zero on failure.

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const FULL = process.argv.indexOf("--full") >= 0;

// ── load both indicators with stand-ins for Tradovate's ./tools modules ─────
const toolMocks = {
    "./tools/predef": {
        paramSpecs: {
            number: (def, step, min) => ({ type: "number", def, restrictions: { step: step || 1, min: min || 0 } }),
            period: def => ({ type: "number", def, restrictions: { step: 1, min: 1 } }),
            bool: def => ({ type: "boolean", def }),
            enum: (enumSet, def) => ({ type: "enum", enumSet, def }),
            color: def => ({ type: "color", def })
        },
        plotters: {
            columns: field => ({ type: "columns", field }),
            singleline: field => ({ type: "multiline", fields: [field] })
        },
        styles: { plot: s => ({ color: s }) }
    },
    "./tools/meta": {
        InputType: { BARS: "bars" },
        AreaChoice: { OVERLAY: "overlay", NEW: "new" }
    },
    "./tools/graphics": {
        px: value => ({ value, unit: "px" }),
        du: value => ({ value, unit: "du" }),
        op: (a, o, b) => ({ a, op: o, b })
    }
};

function load(file, expose) {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8") +
        (expose ? "\nmodule.exports.__internals = { " + expose + " };" : "");
    const mod = { exports: {} };
    const req = name => {
        if (!(name in toolMocks)) {
            throw new Error(file + " requires unknown module " + name);
        }
        return toolMocks[name];
    };
    new Function("require", "module", "exports", src)(req, mod, mod.exports);
    return mod.exports;
}

const meter = load("liquidityRegimeMeter.js",
    "outcome, etMinutes, etOffsetHours, segmentOf, etTradeDate, midrank, tercile, tCrit, robustBounds, cellOf, ordinal");
const zonesInd = load("restingOrderLevels.js");
const I = meter.__internals;
const TICK = 0.25;

function calcOf(ind, overrides, chart) {
    const c = new ind.calculator();
    c.props = {};
    Object.keys(ind.params).forEach(k => { c.props[k] = ind.params[k].def; });
    Object.assign(c.props, overrides || {});
    c.contractInfo = { contract: "NQZ6", product: "NQ", tickSize: TICK };
    c.chartDescription = chart || { underlyingType: "MinuteBar", elementSize: 1, elementSizeUnit: "UnderlyingUnits", withHistogram: true };
    c.init();
    return c;
}

// ── deterministic randomness (mulberry32) ───────────────────────────────────
let seed = 1;
function rand() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ── synthetic sessions ──────────────────────────────────────────────────────
// One bar per minute from 18:00 to 16:59 ET (1380 bars), October 2026 (UTC-4),
// one trade date per session. Each bar is a tick-by-tick path; every step is a
// trade of `size` contracts whose aggressor side matches the step's direction
// with probability `couple` (higher = more net flow per tick = lower impact).
// Regimes are drawn per block of `blockMinutes` (default 90). Prices that printed big bid
// absorption become zones; when price comes back down onto one, a regime with
// defend = true makes the walk rally (buyers defend the zone) and defend =
// "break" makes it drop (the zone gives way). Otherwise it is a pure random walk.
function sessionTape(opts) {
    const bars = [];
    const zones = [];
    let t = Math.round(21000 / TICK);
    let rally = 0;
    let rallyUp = true;
    for (let s = 0; s < opts.sessions; ++s) {
        const day0 = Date.UTC(2026, 9, 5 + s, 22, 0);   // 18:00 ET
        const tradeDate = 20261006 + s;
        for (let m = 0; m < 1380; ++m) {
            const reg = opts.regimeOf(s, Math.floor(m / (opts.blockMinutes || 90)));
            const o = t;
            let h = t;
            let l = t;
            const rec = new Map();
            for (let j = 0; j < reg.steps; ++j) {
                let up = rand() < 0.5;
                if (rally > 0) {
                    up = rand() < (rallyUp ? 0.85 : 0.15);
                    rally--;
                }
                const before = t;
                t += up ? 1 : -1;
                h = Math.max(h, t);
                l = Math.min(l, t);
                const aggressorUp = rand() < reg.couple ? up : !up;
                const r = rec.get(t) || { vol: 0, bidVol: 0, askVol: 0 };
                r.vol += reg.size;
                if (aggressorUp) {
                    r.askVol += reg.size;
                }
                else {
                    r.bidVol += reg.size;
                }
                rec.set(t, r);
                // within one tick counts as reaching the zone, as in the indicator's touch rule
                if (reg.defend && rally === 0 && zones.some(p => before > p + 1 && t <= p + 1)) {
                    rally = 60;
                    rallyUp = reg.defend !== "break";
                }
            }
            const profile = Array.from(rec.keys()).sort((a, b) => a - b)
                .map(p => Object.assign({ price: p * TICK }, rec.get(p)));
            if (rand() < 0.03 && t - l >= 3 && profile.length && profile[0].price === l * TICK) {
                profile[0].bidVol += 600;
                profile[0].vol += 600;
                zones.push(l);
                if (zones.length > 40) {
                    zones.shift();
                }
            }
            // a zone that price fell 12 ticks through is not defended any more
            for (let z = zones.length - 1; z >= 0; --z) {
                if (t < zones[z] - 12) {
                    zones.splice(z, 1);
                }
            }
            bars.push({ o: o * TICK, h: h * TICK, l: l * TICK, c: t * TICK, profile, ts: day0 + m * 60000, tradeDate });
        }
    }
    return bars;
}

const blockRegime = (s, b, salt) => {
    let x = Math.imul(s * 97 + b * 13 + salt, 0x9e3779b1) >>> 0;
    x ^= x >>> 15;
    return (Math.imul(x, 0x85ebca6b) >>> 0) % 2;
};

// ── Tradovate-like driver ───────────────────────────────────────────────────
function entity(b, idx, isLast, opts) {
    opts = opts || {};
    const sum = k => b.profile.reduce((a, q) => a + q[k], 0);
    return {
        timestamp: () => new Date(b.ts),
        tradeDate: () => b.tradeDate,
        index: () => idx,
        isLast: () => isLast(),
        value: () => b.c,
        open: () => b.o,
        high: () => b.h,
        low: () => b.l,
        close: () => b.c,
        volume: () => sum("vol"),
        bidVolume: () => opts.noBidAsk ? 0 : sum("bidVol"),
        offerVolume: () => opts.noBidAsk ? 0 : sum("askVol"),
        profile: () => opts.noProfile ? undefined : b.profile
    };
}

function run(ind, bars, overrides, opts) {
    opts = opts || {};
    const calc = calcOf(ind, overrides, opts.chart);
    const ents = [];
    const cursor = { i: 0 };
    const hist = {
        data: ents,
        get: k => ents[k],
        size: () => ents.length,
        prior: () => ents[cursor.i - 1]
    };
    bars.forEach((b, idx) => ents.push(entity(b, idx, () => idx === ents.length - 1, opts)));
    const outputs = [];
    for (let i = 0; i < ents.length; ++i) {
        cursor.i = i;
        outputs.push(calc.map(ents[i], i, hist));
    }
    return { calc, outputs, ents, cursor, hist };
}

const texts = out => (out && out.graphics ? out.graphics.items[0].children.map(c => c.text) : []);

let passed = 0;
function check(name, fn) {
    fn();
    passed++;
    console.log("  ok  " + name);
}

console.log("liquidityRegimeMeter harness" + (FULL ? " (full)" : ""));

// ── unit: building blocks ───────────────────────────────────────────────────

check("outcome codes match the zone test, with the reason", () => {
    const t = { side: "S", price: 100, dist: 2, start: 1 };
    const bar = (h, l) => ({ high: h, low: l });
    const e = 0.0625;
    assert.strictEqual(I.outcome(t, bar(102.5, 99), 1, 60, e), "open", "touch bar's high never counts");
    assert.strictEqual(I.outcome(t, bar(101, 98), 1, 60, e), "through", "touch bar can fail");
    assert.strictEqual(I.outcome(t, bar(102, 99), 2, 60, e), "win");
    assert.strictEqual(I.outcome(t, bar(101, 98), 2, 60, e), "through");
    assert.strictEqual(I.outcome(t, bar(102, 98), 2, 60, e), "both");
    assert.strictEqual(I.outcome(t, bar(101, 99), 61, 60, e), "timeout");
    assert.strictEqual(I.outcome(t, bar(101, 99), 60, 60, e), "open");
    const r = { side: "R", price: 100, dist: 2, start: 1 };
    assert.strictEqual(I.outcome(r, bar(101, 98), 2, 60, e), "win");
    assert.strictEqual(I.outcome(r, bar(102, 99), 2, 60, e), "through");
});

check("US Eastern clock and segments, across both 2026 DST changes", () => {
    const U = (mo, d, h, mi) => Date.UTC(2026, mo, d, h, mi);
    assert.strictEqual(I.etMinutes(U(2, 8, 6, 59)), 1 * 60 + 59, "Mar 8 01:59 EST");
    assert.strictEqual(I.etMinutes(U(2, 8, 7, 0)), 3 * 60, "Mar 8 03:00 EDT");
    assert.strictEqual(I.etMinutes(U(10, 1, 5, 59)), 1 * 60 + 59, "Nov 1 01:59 EDT");
    assert.strictEqual(I.etMinutes(U(10, 1, 6, 0)), 1 * 60, "Nov 1 01:00 EST");
    const oct = (h, m) => I.segmentOf(U(9, 20, h, m));     // EDT: ET = UTC-4
    assert.deepStrictEqual([oct(6, 59), oct(7, 0), oct(13, 29), oct(13, 30), oct(14, 29), oct(14, 30), oct(17, 59), oct(18, 0), oct(19, 59), oct(20, 0)],
        [0, 1, 1, 2, 2, 3, 3, 4, 4, 0]);
    assert.strictEqual(I.segmentOf(U(0, 15, 14, 30)), 2, "January (EST): 14:30 UTC = 09:30 ET");
    assert.strictEqual(I.etTradeDate(U(9, 20, 21, 59)), "2026-10-20", "17:59 ET belongs to that day");
    assert.strictEqual(I.etTradeDate(U(9, 20, 22, 0)), "2026-10-21", "18:00 ET starts the next trade date");
});

check("percentile equals a brute-force mid-rank count (ties half, (rank + ½)/(N + 1))", () => {
    seed = 3;
    for (let trial = 0; trial < 200; ++trial) {
        const arr = [];
        const n = 1 + Math.floor(rand() * 40);
        for (let j = 0; j < n; ++j) {
            arr.push(Math.floor(rand() * 10));
        }
        arr.sort((a, b) => a - b);
        const x = Math.floor(rand() * 12) - 1;
        const less = arr.filter(v => v < x).length;
        const eq = arr.filter(v => v === x).length;
        const v = I.midrank(arr, x);
        assert.ok(Math.abs(v - 100 * (less + eq / 2 + 0.5) / (n + 1)) < 1e-9);
        assert.ok(v > 0 && v < 100, "never exactly 0 or 100");
    }
    assert.deepStrictEqual([I.tercile(33.3), I.tercile(33.34), I.tercile(66.66), I.tercile(66.67)], [0, 1, 1, 2]);
});

check("95% t quantiles: table and expansion match published values", () => {
    [[1, 12.706], [5, 2.571], [10, 2.228], [30, 2.042], [40, 2.021], [60, 2.0], [120, 1.98]].forEach(([df, v]) =>
        assert.ok(Math.abs(I.tCrit(df) - v) < 0.002, "df " + df + ": " + I.tCrit(df)));
    assert.ok(Number.isNaN(I.tCrit(0)));
});

check("robust clipping bounds = median ± 4 × 1.4826 × MAD", () => {
    const vals = [];
    for (let j = 0; j < 21; ++j) {
        vals.push(j);        // median 10, MAD 5
    }
    const b = I.robustBounds(vals);
    assert.ok(Math.abs(b[0] - (10 - 4 * 1.4826 * 5)) < 1e-9 && Math.abs(b[1] - (10 + 4 * 1.4826 * 5)) < 1e-9);
    assert.strictEqual(I.robustBounds([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), null, "zero MAD: no clipping");
});

// ── the impact window ───────────────────────────────────────────────────────

function hand(bars) {
    return bars.map((b, i) => ({ o: b[0], h: b[1], l: b[2], c: b[3], ts: Date.UTC(2026, 9, 20, 14, 0) + i * 60000, tradeDate: 20261020,
        profile: [{ price: b[2], vol: b[4] + b[5], bidVol: b[4], askVol: b[5] }] }));
}

check("impact and R² equal an ordinary least-squares fit of the last 30 bars", () => {
    seed = 11;
    const raw = [];
    let c = 21000;
    for (let j = 0; j < 45; ++j) {
        const r = Math.round((rand() - 0.5) * 12);
        const q = Math.round(r * 20 + (rand() - 0.5) * 120);
        const bid = 200 - Math.round(q / 2);
        const ask = 200 + q - Math.round(q / 2);
        const o = c;
        c = c + r * TICK;
        raw.push([o, Math.max(o, c) + TICK, Math.min(o, c) - TICK, c, bid, ask]);
    }
    const { calc } = run(meter, hand(raw), { impactWindow: 30 });
    const st = calc.stateFor(Date.UTC(2026, 9, 20, 14, 45), 20261020 + "");
    // expected: bars 14..43 — bar 44 is the live bar, which never enters the window
    const pairs = [];
    for (let j = 14; j < 44; ++j) {
        pairs.push([(raw[j][3] - raw[j - 1][3]) / TICK, raw[j][5] - raw[j][4]]);
    }
    const n = pairs.length;
    const mr = pairs.reduce((a, x) => a + x[0], 0) / n;
    const mq = pairs.reduce((a, x) => a + x[1], 0) / n;
    let cov = 0, vq = 0, vr = 0;
    pairs.forEach(([r, q]) => { cov += (r - mr) * (q - mq); vq += (q - mq) ** 2; vr += (r - mr) ** 2; });
    assert.ok(st.full, JSON.stringify(st));
    assert.ok(Math.abs(st.lam - cov / vq) < 1e-12, st.lam + " vs " + cov / vq);
    assert.ok(Math.abs(st.r2 - cov * cov / (vq * vr)) < 1e-12);
    assert.ok(st.r2 > 0.5, "strong flow-price link in this data: " + st.r2);
});

check("the window restarts each session; the first bar after the break is not used", () => {
    const tape = sessionTape({ sessions: 2, regimeOf: () => ({ steps: 30, size: 5, couple: 0.85 }) });
    const { calc, ents, cursor, hist } = run(meter, tape.slice(0, 1380 + 5));
    assert.strictEqual(calc.g, 1, "second session");
    assert.strictEqual(calc.win.r.length, 3, "bars 1381..1383 only (bar 1380 spans the session break)");
    const st = calc.stateFor(tape[1384].ts, String(tape[1384].tradeDate));
    assert.strictEqual(st.status, "building");
    // a live bar from a NEW trade date is 'building' too (its window would start empty)
    const nextDay = Object.assign({}, tape[1384], { tradeDate: 99999999 });
    assert.strictEqual(calc.stateFor(nextDay.ts, String(nextDay.tradeDate)).status, "building");
    assert.ok(ents && cursor && hist);
});

check("warm-up needs the prior sessions, then states appear", () => {
    const tape = sessionTape({ sessions: 5, regimeOf: (s, b) => ({ steps: 30, size: 5, couple: blockRegime(s, b, 1) ? 0.9 : 0.65 }) });
    const { calc, outputs } = run(meter, tape);
    const firstOk = outputs.findIndex(o => o && o.pct !== undefined);
    assert.ok(firstOk >= 3 * 1380, "no state before 3 prior sessions: first at bar " + firstOk);
    const statesSeen = new Set(outputs.slice(3 * 1380).filter(o => o && o.pct !== undefined).map(o => o.style.pct.color));
    assert.strictEqual(statesSeen.size, 3, "DEEP, NORMAL and THIN all occur");
    const last = texts(outputs[outputs.length - 1]);
    assert.ok(/^NOW: (DEEP|NORMAL|THIN) \| impact \d+\.\d\d ticks per 100 net contracts, \d+(st|nd|rd|th) pct vs \w/.test(last[0]), last[0]);
    assert.ok(calc.pools.every(p => p.sessions.length === 4), "4 completed sessions pooled per segment");
});

// ── consistency with Resting Order Levels ───────────────────────────────────

check("the meter's zone tests are exactly the Resting Order Levels zone tests", () => {
    seed = 21;
    const tape = sessionTape({ sessions: 6, regimeOf: (s, b) => ({ steps: 30, size: 5, couple: blockRegime(s, b, 2) ? 0.9 : 0.65 }) });
    const m = run(meter, tape).calc;
    const z = run(zonesInd, tape).calc;
    const zt = z.zoneTotals();
    assert.deepStrictEqual(m.totals.z, zt, "zone tests");
    assert.deepStrictEqual(m.totals.r, z.controlStats, "random-price tests");
    assert.ok(zt.n > 200, "plenty of zone tests: " + zt.n);
    // every decided test is either filed under a state or counted as excluded
    ["z", "r"].forEach(f => {
        const tagged = Object.keys(m.sess).reduce((a, g) => a + m.sess[g][f + "n"].reduce((x, v) => x + v, 0), 0);
        const ex = m.excluded[f];
        assert.strictEqual(tagged + ex.building + ex.warmup + ex.unclear, m.totals[f].n, f);
    });
});

// ── live bar and history ────────────────────────────────────────────────────

check("live ticks change nothing (with or without Tradovate restoring state)", () => {
    seed = 31;
    const tape = sessionTape({ sessions: 4, regimeOf: (s, b) => ({ steps: 30, size: 5, couple: blockRegime(s, b, 3) ? 0.9 : 0.65 }) });
    const live = (restore) => {
        const r = run(meter, tape.slice(0, tape.length - 1));
        const { calc, ents, cursor, hist } = r;
        const idx = ents.length;
        const b = Object.assign({}, tape[tape.length - 1]);
        ents.push(entity(b, idx, () => idx === ents.length - 1));
        cursor.i = idx;
        const snap = JSON.stringify(calc);
        const outs = [];
        for (let k = 0; k < 15; ++k) {
            if (restore) {
                Object.assign(calc, JSON.parse(snap));
            }
            b.c = b.c + (k % 3 - 1) * TICK;
            b.h = Math.max(b.h, b.c);
            b.l = Math.min(b.l, b.c);
            outs.push(JSON.stringify(calc.map(ents[idx], idx, hist)));
        }
        return { state: JSON.stringify(calc, (key, v) => key === "cache" ? undefined : v), outs };
    };
    const a = live(false);
    const b = live(true);
    assert.strictEqual(a.state, b.state, "same state");
    assert.ok(a.outs.every(o => o === a.outs[0]), "the live bar's output never changes tick to tick");
    assert.deepStrictEqual(a.outs, b.outs);
});

check("no lookahead: everything up to bar K is identical when later bars exist", () => {
    seed = 41;
    const tape = sessionTape({ sessions: 5, regimeOf: (s, b) => ({ steps: 30, size: 5, couple: blockRegime(s, b, 4) ? 0.9 : 0.65 }) });
    const K = 4 * 1380 + 300;
    const short = run(meter, tape.slice(0, K));
    const long = run(meter, tape);
    for (let i = 0; i < K - 1; ++i) {
        const a = short.outputs[i] || {};
        const b = long.outputs[i] || {};
        assert.strictEqual(a.pct, b.pct, "pct at bar " + i);
        assert.strictEqual(a.r2, b.r2, "r2 at bar " + i);
    }
    // statistics at K: rebuild the long run's state as of bar K-1 by replaying
    const replay = calcOf(meter);
    const ents = tape.map((b, idx) => entity(b, idx, () => false));
    const cursor = { i: 0 };
    const hist = { get: k => ents[k], size: () => ents.length, prior: () => ents[cursor.i - 1] };
    for (let i = 0; i < K; ++i) {
        cursor.i = i;
        replay.map(ents[i], i, hist);
    }
    const strip = c => JSON.stringify([c.sess, c.totals, c.excluded, c.pools, c.win, c.openTests, c.openControl]);
    assert.strictEqual(strip(replay), strip(short.calc));
});

check("plot outputs: impact percentile only with a state, colored by it; R² once the window is full", () => {
    seed = 51;
    const tape = sessionTape({ sessions: 4, regimeOf: (s, b) => ({ steps: 30, size: 5, couple: blockRegime(s, b, 5) ? 0.9 : 0.65 }) });
    const { outputs, calc } = run(meter, tape, { tintCandles: true });
    const colors = { DEEP: calc.props.deepColor, NORMAL: calc.props.normalColor, THIN: calc.props.thinColor };
    outputs.forEach(o => {
        if (o && o.pct !== undefined) {
            assert.ok(o.pct > 0 && o.pct < 100);
            const want = o.pct < 100 / 3 ? colors.DEEP : o.pct >= 200 / 3 ? colors.THIN : colors.NORMAL;
            assert.strictEqual(o.style.pct.color, want);
            assert.strictEqual(o.candlestick.color, want);
            assert.ok(o.r2 >= 0 && o.r2 <= 100);
        }
    });
    assert.strictEqual(outputs[0].pct, undefined);
    assert.strictEqual(outputs[0].r2, undefined);
});

// ── statistics by hand ──────────────────────────────────────────────────────

check("session jackknife and Mantel-Haenszel gap match a hand computation", () => {
    const c = calcOf(meter, { minSessions: 2, minTests: 1, minStratumN: 1 });
    const cell = (atr, lam, ill) => I.cellOf(atr, lam, ill);
    const day = (cells) => {
        const s = { zw: new Array(27).fill(0), zn: new Array(27).fill(0), rw: new Array(27).fill(0), rn: new Array(27).fill(0) };
        cells.forEach(([a, l, i, w, n]) => { s.zw[cell(a, l, i)] += w; s.zn[cell(a, l, i)] += n; });
        return s;
    };
    // three sessions; volatility tercile 1 only; DEEP (lam 0) vs THIN (lam 2), volume-only tercile 1
    c.sess = {
        0: day([[1, 0, 1, 6, 10], [1, 2, 1, 4, 10]]),
        1: day([[1, 0, 1, 8, 10], [1, 2, 1, 5, 10]]),
        2: day([[1, 0, 1, 7, 10], [1, 2, 1, 3, 10]])
    };
    const z = c.summarize("z");
    assert.strictEqual(z.G, 3);
    // DEEP 21/30 = 0.7, THIN 12/30 = 0.4
    assert.ok(Math.abs(z.states[0].est - 0.7) < 1e-12 && Math.abs(z.states[2].est - 0.4) < 1e-12);
    assert.ok(Math.abs(z.raw.est - 0.3) < 1e-12);
    // one stratum, equal n: MH = raw difference
    assert.ok(Math.abs(z.sl.est - 0.3) < 1e-12);
    // jackknife by hand: leave out each session
    const loo = [[15 / 20 - 8 / 20], [13 / 20 - 7 / 20], [14 / 20 - 9 / 20]].map(x => x[0]);
    const m = loo.reduce((a, x) => a + x, 0) / 3;
    const se = Math.sqrt(2 / 3 * loo.reduce((a, x) => a + (x - m) ** 2, 0));
    assert.ok(Math.abs(z.raw.half - 4.303 * se) < 1e-9, z.raw.half + " vs " + 4.303 * se);
    // odd/even: sessions 0 and 2 vs session 1 — all positive
    assert.strictEqual(z.agree, true);
    // the volume-only split has no low/high terciles here: not available
    assert.strictEqual(z.si.ok, false);
});

check("Mantel-Haenszel weights strata by n_D·n_T/(n_D+n_T)", () => {
    const c = calcOf(meter, { minSessions: 2, minTests: 1, minStratumN: 1 });
    const mk = () => ({ zw: new Array(27).fill(0), zn: new Array(27).fill(0), rw: new Array(27).fill(0), rn: new Array(27).fill(0) });
    const a = mk();
    const b = mk();
    // stratum 0: D 8/10, T 2/10 (d = .6, wt 5); stratum 2: D 3/10, T 3/30 (d = .2, wt 7.5)
    [[a, 0, 0, 4, 5], [a, 0, 2, 1, 5], [a, 2, 0, 2, 5], [a, 2, 2, 2, 15], [b, 0, 0, 4, 5], [b, 0, 2, 1, 5], [b, 2, 0, 1, 5], [b, 2, 2, 1, 15]]
        .forEach(([s, atr, lam, w, n]) => { s.zw[I.cellOf(atr, lam, 1)] += w; s.zn[I.cellOf(atr, lam, 1)] += n; });
    c.sess = { 0: a, 1: b };
    const z = c.summarize("z");
    assert.ok(Math.abs(z.sl.est - (5 * 0.6 + 7.5 * 0.2) / 12.5) < 1e-12, z.sl.est);
});

check("verdict wording follows the evidence", () => {
    const c = calcOf(meter);
    const ci = (est, half) => ({ est, half, lo: est - half, hi: est + half, ok: true });
    const base = { G: 10, raw: ci(0.1, 0.05), sl: ci(0.08, 0.05), diff: ci(0.06, 0.04), agree: true };
    assert.ok(/reverse more in DEEP \(blue\) conditions - still true at equal measured volatility, and the bid\/ask split predicts it better/.test(c.verdict(base)));
    assert.ok(/reverse more in THIN \(orange\)/.test(c.verdict(Object.assign({}, base, { raw: ci(-0.1, 0.05), sl: ci(-0.08, 0.05), diff: ci(-0.06, 0.04) }))));
    assert.ok(/volume-only measure predicts it as well, so it is liquidity in general/.test(c.verdict(Object.assign({}, base, { diff: ci(0.02, 0.04) }))));
    assert.ok(/odd and even sessions disagree/.test(c.verdict(Object.assign({}, base, { agree: false }))));
    assert.ok(/explained by volatility/.test(c.verdict(Object.assign({}, base, { sl: ci(0.02, 0.05) }))));
    assert.ok(/no measurable DEEP\/THIN difference on this chart/.test(c.verdict(Object.assign({}, base, { raw: ci(0.02, 0.05), sl: ci(0.01, 0.05) }))));
    assert.ok(/not enough tests per volatility level/.test(c.verdict(Object.assign({}, base, { sl: { est: NaN, ok: false } }))));
    assert.ok(/collecting - needs 6 sessions/.test(c.verdict(Object.assign({}, base, { G: 3 }))));
});

// ── chart checks ────────────────────────────────────────────────────────────

check("unsupported charts and missing bid/ask volume say so instead of guessing", () => {
    const tape = sessionTape({ sessions: 1, regimeOf: () => ({ steps: 30, size: 5, couple: 0.8 }) }).slice(0, 100);
    const renko = run(meter, tape, {}, { chart: { underlyingType: "Tick", elementSize: 4, elementSizeUnit: "Renko" } });
    assert.ok(/unsupported chart \(Renko bars\)/.test(texts(renko.outputs[99])[0]));
    assert.strictEqual(renko.calc.committed, -1, "nothing computed");
    const tick1 = run(meter, tape, {}, { chart: { underlyingType: "Tick", elementSize: 1, elementSizeUnit: "UnderlyingUnits" } });
    assert.ok(/unsupported chart \(1-tick bars\)/.test(texts(tick1.outputs[99])[0]));
    const noFlow = run(meter, tape, {}, { noBidAsk: true, noProfile: true });
    assert.ok(/NO bid\/ask volume/.test(texts(noFlow.outputs[99])[0]));
});

check("changing a setting marks the results as in-sample", () => {
    const tape = sessionTape({ sessions: 1, regimeOf: () => ({ steps: 30, size: 5, couple: 0.8 }) }).slice(0, 80);
    assert.ok(/default settings$/.test(texts(run(meter, tape).outputs[79]).slice(-1)[0]));
    assert.ok(/treat results as in-sample$/.test(texts(run(meter, tape, { impactWindow: 40 }).outputs[79]).slice(-1)[0]));
});

// ── statistical behaviour ───────────────────────────────────────────────────

const flipRegime = (salt, deep, thin) => (s, b) => (blockRegime(s, b, salt) ? deep : thin);

check("random walk: the DEEP/THIN gap is noise, and the margins cover zero", () => {
    const seeds = FULL ? 40 : 12;
    let covRaw = 0, covSl = 0, covDiff = 0, slOk = 0, claims = 0;
    for (let k = 0; k < seeds; ++k) {
        seed = 1000 + k;
        const tape = sessionTape({ sessions: 11, regimeOf: flipRegime(100 + k,
            { steps: 30, size: 5, couple: 0.9 }, { steps: 30, size: 5, couple: 0.65 }) });
        const { calc } = run(meter, tape);
        const z = calc.stats().z;
        const covers = x => x.ok && x.lo <= 0 && x.hi >= 0;
        covRaw += covers(z.raw) ? 1 : 0;
        if (z.sl.ok) {
            slOk++;
            covSl += covers(z.sl) ? 1 : 0;
        }
        if (z.diff.ok) {
            covDiff += covers(z.diff) ? 1 : 0;
        }
        claims += /reverse more in/.test(calc.verdict(z)) ? 1 : 0;
    }
    console.log("      " + seeds + " random-walk seeds: raw covers 0 in " + covRaw + ", within-volatility in " + covSl + "/" + slOk +
        ", split-adds in " + covDiff + "; verdict claimed an effect " + claims + "x");
    assert.ok(covRaw >= Math.ceil(0.75 * seeds), "raw coverage");
    assert.ok(slOk >= seeds / 2 && covSl >= Math.ceil(0.75 * slOk), "within-volatility coverage");
    assert.ok(claims <= Math.max(1, Math.floor(0.1 * seeds)), "verdict rarely claims an effect on noise");
});

check("volatility control: a gap that comes only from calmer DEEP periods is explained away", () => {
    // Within each volatility tercile DEEP and THIN reverse equally often (calm 80%,
    // middle 50%, volatile 20%), but DEEP tests sit mostly in calm periods and THIN
    // tests mostly in volatile ones — so DEEP looks far better overall.
    const c = calcOf(meter, { minSessions: 6, minTests: 1, minStratumN: 10 });
    const mk = () => ({ zw: new Array(27).fill(0), zn: new Array(27).fill(0), rw: new Array(27).fill(0), rn: new Array(27).fill(0) });
    const put = (s, atr, lam, ill, w, n) => { s.zw[I.cellOf(atr, lam, ill)] += w; s.zn[I.cellOf(atr, lam, ill)] += n; };
    c.sess = {};
    for (let g = 0; g < 8; ++g) {
        const s = mk();
        put(s, 0, 0, 1, 16, 20);  put(s, 0, 2, 1, 4, 5);      // calm: 80% both
        put(s, 1, 0, 1, 5, 10);   put(s, 1, 2, 1, 5, 10);     // middle: 50% both
        put(s, 2, 0, 1, 1, 5);    put(s, 2, 2, 1, 4, 20);     // volatile: 20% both
        c.sess[g] = s;
    }
    const z = c.summarize("z");
    assert.ok(z.raw.est > 0.25, "big raw gap: " + z.raw.est);
    assert.ok(Math.abs(z.sl.est) < 1e-12, "zero at equal volatility: " + z.sl.est);
    assert.ok(/explained by volatility/.test(c.verdict(z)), c.verdict(z));
});

check("planted order-flow effect at equal volatility: detected, and credited to the bid/ask split", () => {
    let found = 0;
    for (let k = 0; k < 3; ++k) {
        seed = 3000 + k;
        // same volatility and volume. Loosely aligned aggression (couple 0.7) moves price
        // about 0.08 ticks per net contract = DEEP; tightly aligned (0.95) about 0.18 = THIN.
        // Zones are defended in DEEP blocks and give way in THIN blocks. Regimes last 4 hours
        // (the 30-bar window needs time to see a change), and a stricter absorption setting
        // keeps the zones to the planted ones, the only prices the regimes act on.
        const tape = sessionTape({ sessions: 16, blockMinutes: 240, regimeOf: flipRegime(300 + k,
            { steps: 30, size: 5, couple: 0.7, defend: true }, { steps: 30, size: 5, couple: 0.95, defend: "break" }) });
        const { calc, outputs } = run(meter, tape, { absorptionMultiple: 10 });
        const z = calc.stats().z;
        const v = calc.verdict(z);
        console.log("      planted seed " + k + ": DEEP " + (100 * z.states[0].est).toFixed(0) + "% THIN " + (100 * z.states[2].est).toFixed(0) +
            "% | same volatility " + (z.sl.ok ? (100 * z.sl.est).toFixed(1) + " ±" + (100 * z.sl.half).toFixed(1) : "n/a") + " | " + v);
        assert.ok(z.states[0].est > z.states[2].est, "DEEP zones reverse more");
        found += /reverse more in DEEP \(blue\) conditions - still true at equal measured volatility, and the bid\/ask split predicts it better/.test(v) ? 1 : 0;
        if (k === 0) {
            const t = texts(outputs[outputs.length - 1]);
            assert.ok(/^Your zones reversed \(\d+\.\d\d in favor before \d+\.\d\d against, within 60 bars\): DEEP \d+% ±\d+ \(n=\d+; random \d+%\)/.test(t[1]), t[1]);
            assert.ok(/^DEEP minus THIN: raw [+-]\d+ ±\d+ \| same volatility/.test(t[2]), t[2]);
            assert.ok(/^Sessions loaded 16 \| zone tests: \d+ state-tagged/.test(t[4]), t[4]);
        }
    }
    assert.ok(found >= 2, "verdict found the planted effect in " + found + "/3 seeds");
});

console.log(passed + " checks passed");

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
    "outcome, etMinutes, etOffsetHours, slotOf, spanText, etTradeDate, midrank, tercile, shownPct, tCrit, wilsonHalf, robustBounds, cellOf, ordinal, wrap, LINE_CHARS");
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

// Text rows as drawn, and the logical lines (wrapped continuation rows joined back).
const rows = out => (out && out.graphics ? out.graphics.items[0].children.map(c => c.text) : []);
const texts = out => rows(out).reduce((a, r) => {
    if (r.startsWith("    ") && a.length) {
        a[a.length - 1] += " " + r.trim();
    }
    else {
        a.push(r);
    }
    return a;
}, []);
const lineWith = (out, re) => texts(out).find(t => re.test(t)) || "";

// Merge consecutive 1-minute bars of one trade date into n-minute bars.
function aggregate(bars, n) {
    const out = [];
    for (let j = 0; j < bars.length; j += n) {
        const g = bars.slice(j, j + n).filter(b => b.tradeDate === bars[j].tradeDate);
        const merged = new Map();
        g.forEach(b => b.profile.forEach(q => {
            const m = merged.get(q.price) || { price: q.price, vol: 0, bidVol: 0, askVol: 0 };
            m.vol += q.vol;
            m.bidVol += q.bidVol;
            m.askVol += q.askVol;
            merged.set(q.price, m);
        }));
        out.push({ o: g[0].o, h: Math.max(...g.map(b => b.h)), l: Math.min(...g.map(b => b.l)), c: g[g.length - 1].c,
            profile: Array.from(merged.values()).sort((a, b) => a.price - b.price), ts: g[0].ts, tradeDate: g[0].tradeDate });
    }
    return out;
}

const minuteChart = n => ({ underlyingType: "MinuteBar", elementSize: n, elementSizeUnit: "UnderlyingUnits", withHistogram: true });
const emptyDay = () => ({ zw: new Array(27).fill(0), zn: new Array(27).fill(0), rw: new Array(27).fill(0), rn: new Array(27).fill(0) });
const put = (s, atr, lam, ill, w, n) => { s.zw[I.cellOf(atr, lam, ill)] += w; s.zn[I.cellOf(atr, lam, ill)] += n; };
const jackHalf = (loo, df) => {
    const m = loo.reduce((a, x) => a + x, 0) / loo.length;
    return I.tCrit(df) * Math.sqrt((loo.length - 1) / loo.length * loo.reduce((a, x) => a + (x - m) ** 2, 0));
};

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

check("US Eastern clock and 5-minute slots, across both 2026 DST changes", () => {
    const U = (mo, d, h, mi) => Date.UTC(2026, mo, d, h, mi);
    assert.strictEqual(I.etMinutes(U(2, 8, 6, 59)), 1 * 60 + 59, "Mar 8 01:59 EST");
    assert.strictEqual(I.etMinutes(U(2, 8, 7, 0)), 3 * 60, "Mar 8 03:00 EDT");
    assert.strictEqual(I.etMinutes(U(10, 1, 5, 59)), 1 * 60 + 59, "Nov 1 01:59 EDT");
    assert.strictEqual(I.etMinutes(U(10, 1, 6, 0)), 1 * 60, "Nov 1 01:00 EST");
    const oct = (h, m) => I.slotOf(U(9, 20, h, m));     // EDT: ET = UTC-4
    assert.deepStrictEqual([oct(13, 30), oct(13, 34), oct(13, 35), oct(4, 0), oct(3, 59)], [114, 114, 115, 0, 287]);
    assert.strictEqual(I.slotOf(U(0, 15, 14, 30)), 114, "January (EST): 14:30 UTC = 09:30 ET");
    assert.strictEqual(I.spanText(114), "09:20-09:45 ET");
    assert.strictEqual(I.spanText(0), "23:50-00:15 ET", "wraps around midnight");
    assert.strictEqual(I.spanText(287), "23:45-00:10 ET");
    assert.strictEqual(I.etTradeDate(U(9, 20, 21, 59)), "2026-10-20", "17:59 ET belongs to that day");
    assert.strictEqual(I.etTradeDate(U(9, 20, 22, 0)), "2026-10-21", "18:00 ET starts the next trade date");
});

check("percentile equals a brute-force mid-rank count; the shown number never contradicts its third", () => {
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
    assert.deepStrictEqual([I.shownPct(0.3, 0), I.shownPct(33.2, 0), I.shownPct(33.4, 1), I.shownPct(66.6, 1), I.shownPct(66.7, 2), I.shownPct(99.8, 2)],
        [1, 33, 34, 66, 67, 99]);
    for (let x = 0.01; x < 100; x += 0.01) {
        const t = I.tercile(x);
        assert.strictEqual(I.tercile(I.shownPct(x, t)), t, "percentile " + x);
    }
});

check("95% t quantiles and the Wilson interval match published values", () => {
    [[1, 12.706], [5, 2.571], [10, 2.228], [30, 2.042], [40, 2.021], [60, 2.0], [120, 1.98]].forEach(([df, v]) =>
        assert.ok(Math.abs(I.tCrit(df) - v) < 0.002, "df " + df + ": " + I.tCrit(df)));
    assert.ok(Number.isNaN(I.tCrit(0)));
    // Wilson 95% interval for 8 of 10 is 0.4902 to 0.9433
    assert.ok(Math.abs(I.wilsonHalf(8, 10) - (0.9433 - 0.4902) / 2) < 0.0005, I.wilsonHalf(8, 10));
});

check("robust clipping bounds = median ± 4 × 1.4826 × MAD", () => {
    const vals = [];
    for (let j = 0; j < 21; ++j) {
        vals.push(j);        // median 10, MAD 5
    }
    const b = I.robustBounds(vals);
    assert.ok(Math.abs(b[0] - (10 - 4 * 1.4826 * 5)) < 1e-9 && Math.abs(b[1] - (10 + 4 * 1.4826 * 5)) < 1e-9);
    assert.strictEqual(I.robustBounds(new Array(20).fill(1)), null, "zero MAD: no clipping");
});

check("text wraps at " + I.LINE_CHARS + " characters, at ' | ' where possible, losing nothing", () => {
    seed = 5;
    for (let trial = 0; trial < 300; ++trial) {
        const words = [];
        const n = 1 + Math.floor(rand() * 60);
        for (let j = 0; j < n; ++j) {
            words.push(rand() < 0.15 ? "|" : "w".repeat(1 + Math.floor(rand() * 14)));
        }
        const text = words.join(" ").replace(/^\| |( \|)+$/g, "").replace(/\| \|/g, "|");
        if (!text || text === "|") {
            continue;
        }
        const w = I.wrap(text);
        assert.ok(w.every(r => r.length <= I.LINE_CHARS), JSON.stringify(w));
        assert.ok(w.slice(1).every(r => r.startsWith("    ")), "continuations are indented");
        assert.strictEqual(w.map((r, j) => (j ? r.trim() : r)).join(" "), text, "nothing lost");
    }
    const line = "DEEP 46% ±12 (n=177, 13 sessions; random 51%) | NORMAL 26% ±10 (n=150, 13 sessions; random 49%) | THIN 5% ±8 (n=55, 13 sessions; random 51%)";
    assert.deepStrictEqual(I.wrap(line), ["DEEP 46% ±12 (n=177, 13 sessions; random 51%) | NORMAL 26% ±10 (n=150, 13 sessions; random 49%) |",
        "    THIN 5% ±8 (n=55, 13 sessions; random 51%)"]);
});

// ── the impact window ───────────────────────────────────────────────────────

function hand(bars, opts) {
    opts = opts || {};
    return bars.map((b, i) => ({ o: b[0], h: b[1], l: b[2], c: b[3], tradeDate: 20261020,
        ts: Date.UTC(2026, 9, 20, 14, 0) + i * 60000 + (opts.gapAt !== undefined && i >= opts.gapAt ? opts.gapMinutes * 60000 : 0),
        profile: [{ price: b[2], vol: b[4] + b[5], bidVol: b[4], askVol: b[5] }] }));
}

// 45 hand-made bars where net flow clearly drives price; `jump` = [bar, ticks]
// moves that bar's close by `ticks` and the next bar's close back.
function flowBars(seedValue, jump) {
    seed = seedValue;
    const raw = [];
    let c = 21000;
    for (let j = 0; j < 45; ++j) {
        let r = Math.round((rand() - 0.5) * 12);
        let q = Math.round(r * 20 + (rand() - 0.5) * 120);
        if (jump && j === jump[0]) {
            r += jump[1];
            q += jump[2];
        }
        if (jump && j === jump[0] + 1) {
            r -= jump[1];
        }
        const bid = 200 - Math.round(q / 2);
        const ask = 200 + q - Math.round(q / 2);
        const o = c;
        c = c + r * TICK;
        raw.push([o, Math.max(o, c) + TICK, Math.min(o, c) - TICK, c, Math.max(0, bid), ask + Math.max(0, -bid)]);
    }
    return raw;
}

// Ordinary least squares of the window bars 14..43 (bar 44 is the live bar), with
// each series clipped at its own median ± 4 × 1.4826 × MAD (upper median, as in the meter).
function expectedFit(raw) {
    let r = [], q = [];
    for (let j = 14; j < 44; ++j) {
        r.push((raw[j][3] - raw[j - 1][3]) / TICK);
        q.push(raw[j][5] - raw[j][4]);
    }
    const clip = v => {
        const s = v.slice().sort((a, b) => a - b);
        const med = s[s.length >> 1];
        const mad = s.map(x => Math.abs(x - med)).sort((a, b) => a - b)[s.length >> 1];
        return mad > 0 ? v.map(x => Math.min(med + 4 * 1.4826 * mad, Math.max(med - 4 * 1.4826 * mad, x))) : v;
    };
    r = clip(r);
    q = clip(q);
    const n = r.length;
    const mr = r.reduce((a, x) => a + x, 0) / n;
    const mq = q.reduce((a, x) => a + x, 0) / n;
    let cov = 0, vq = 0, vr = 0;
    for (let j = 0; j < n; ++j) {
        cov += (r[j] - mr) * (q[j] - mq);
        vq += (q[j] - mq) ** 2;
        vr += (r[j] - mr) ** 2;
    }
    return { lam: cov / vq, r2: cov * cov / (vq * vr) };
}

const stateAt44 = raw => run(meter, hand(raw)).calc.stateFor(Date.UTC(2026, 9, 20, 14, 44), "20261020");

check("impact and R² equal an ordinary least-squares fit of the last 30 closed bars", () => {
    const raw = flowBars(11);
    const st = stateAt44(raw);
    const want = expectedFit(raw);
    assert.ok(st.full, JSON.stringify(st));
    assert.ok(Math.abs(st.lam - want.lam) < 1e-12, st.lam + " vs " + want.lam);
    assert.ok(Math.abs(st.r2 - want.r2) < 1e-12);
    assert.ok(st.r2 > 0.5, "strong flow-price link in this data: " + st.r2);
});

check("outliers are clipped within the window itself; bars before the window never matter", () => {
    const base = stateAt44(flowBars(11));
    // a news spike before the window (bars 5-6): nothing in the window changes
    const early = stateAt44(flowBars(11, [5, 80, 6000]));
    ["lam", "r2", "atr", "ill"].forEach(k => assert.strictEqual(early[k], base[k], k));
    // a spike inside the window (bars 30-31) is clipped at that window's own spread
    const rawIn = flowBars(11, [30, 80, 6000]);
    const inside = stateAt44(rawIn);
    const want = expectedFit(rawIn);
    assert.ok(Math.abs(inside.lam - want.lam) < 1e-12 && Math.abs(inside.r2 - want.r2) < 1e-12);
    assert.ok(Math.abs(inside.lam - base.lam) < 0.5 * base.lam, "the spike does not take over the fit: " + inside.lam + " vs " + base.lam);
});

check("the window restarts each session; the first bar after the break is not used", () => {
    const tape = sessionTape({ sessions: 2, regimeOf: () => ({ steps: 30, size: 5, couple: 0.85 }) });
    const { calc } = run(meter, tape.slice(0, 1380 + 5));
    assert.strictEqual(calc.g, 1, "second session");
    assert.strictEqual(calc.win.r.length, 3, "bars 1381..1383 only (bar 1380 spans the session break)");
    assert.strictEqual(calc.stateFor(tape[1384].ts, String(tape[1384].tradeDate)).status, "building");
    // a live bar from a NEW trade date is 'building' too (its window would start empty)
    assert.strictEqual(calc.stateFor(tape[1384].ts, "99999999").status, "building");
});

check("a long pause inside one trade date (a halt) restarts the window", () => {
    const raw = flowBars(13).concat(flowBars(14)).slice(0, 70);
    const halted = run(meter, hand(raw, { gapAt: 60, gapMinutes: 45 })).calc;
    assert.strictEqual(halted.win.r.length, 8, "bars 61..68 only: bar 60 spans the halt");
    const brief = run(meter, hand(raw, { gapAt: 60, gapMinutes: 20 })).calc;
    assert.strictEqual(brief.win.r.length, 30, "a 20-minute pause on 1-minute bars is not a halt");
    // the live bar after a halt is 'building' even before any bar after it closes
    const ts = Date.UTC(2026, 9, 20, 14, 0) + 68 * 60000;
    assert.strictEqual(brief.stateFor(ts + 20 * 60000, "20261020").status !== "building", true);
    assert.strictEqual(brief.stateFor(ts + 120 * 60000, "20261020").status, "building");
});

check("warm-up needs readings from prior sessions at the same clock time, then states appear", () => {
    const tape = sessionTape({ sessions: 5, regimeOf: (s, b) => ({ steps: 30, size: 5, couple: blockRegime(s, b, 1) ? 0.9 : 0.65 }) });
    const { calc, outputs } = run(meter, tape);
    const firstOk = outputs.findIndex(o => o && o.pct !== undefined);
    assert.ok(firstOk >= 3 * 1380, "no state before 3 prior sessions: first at bar " + firstOk);
    const statesSeen = new Set(outputs.slice(3 * 1380).filter(o => o && o.pct !== undefined).map(o => o.style.pct.color));
    assert.strictEqual(statesSeen.size, 3, "DEEP, NORMAL and THIN all occur");
    const t = texts(outputs[outputs.length - 1]);
    assert.ok(/^NOW: (DEEP - impact in the \d+(st|nd|rd|th) percentile vs \d\d:\d\d-\d\d:\d\d ET in prior sessions|unclear - )/.test(t[0]), t[0]);
    assert.strictEqual(calc.prior.length, 4, "4 completed sessions kept");
    // one reading per 5-minute slot per session: 18:30 to 16:55 ET once the window is full
    calc.prior.forEach(day => assert.strictEqual(Object.keys(day.atr).length, 270));
    // before that: the warm-up line states the real requirement and what exists
    const early = run(meter, tape.slice(0, 2 * 1380 + 600)).outputs;
    assert.ok(/^NOW: warming up - ranking needs 3 prior sessions with readings near \d\d:\d\d-\d\d:\d\d ET \(have 2\) and 9 pooled readings \(have 10\)$/.test(texts(early[early.length - 1])[0]),
        texts(early[early.length - 1])[0]);
});

check("states are reachable on 5-minute bars; bars too big for the window say so", () => {
    seed = 61;
    const tape = sessionTape({ sessions: 7, regimeOf: (s, b) => ({ steps: 30, size: 5, couple: blockRegime(s, b, 6) ? 0.9 : 0.65 }) });
    const five = run(meter, aggregate(tape, 5), {}, { chart: minuteChart(5) }).outputs;
    const seen = {};
    five.forEach(o => { if (o && o.pct !== undefined) { seen[I.tercile(o.pct)] = (seen[I.tercile(o.pct)] || 0) + 1; } });
    assert.ok(seen[0] > 20 && seen[1] > 20 && seen[2] > 20, JSON.stringify(seen));
    const hourly = run(meter, aggregate(tape, 60), {}, { chart: minuteChart(60) }).outputs;
    assert.ok(/it can never fill: 30 bars of 60 minutes is longer than a session/.test(texts(hourly[hourly.length - 1])[0]));
});

check("ranking by clock time: sessions that differ only by hour do not read DEEP by hour", () => {
    // every session: thin overnight, normal pre-market, deep from 09:30 — identical by clock
    seed = 71;
    const byClock = (s, m) => ({ steps: 30, size: 5, couple: m < 540 ? 0.95 : m < 930 ? 0.8 : 0.7 });
    const tape = sessionTape({ sessions: 10, blockMinutes: 1, regimeOf: byClock });
    const { outputs } = run(meter, tape);
    const share = [[0, 540], [540, 930], [930, 1380]].map(([a, b]) => {
        const states = [0, 0, 0];
        for (let s = 4; s < 10; ++s) {
            for (let m = a; m < b; ++m) {
                const o = outputs[s * 1380 + m];
                if (o && o.pct !== undefined) {
                    states[I.tercile(o.pct)]++;
                }
            }
        }
        const n = states[0] + states[1] + states[2];
        return states.map(x => x / n);
    });
    console.log("      DEEP/NORMAL/THIN share overnight, pre-market, RTH: " +
        share.map(x => x.map(v => Math.round(100 * v) + "%").join("/")).join(", "));
    share.forEach(x => x.forEach(v => assert.ok(v > 0.12 && v < 0.6, JSON.stringify(share))));
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
        const { calc, ents, cursor, hist } = run(meter, tape.slice(0, tape.length - 1));
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
        return { state: JSON.stringify(calc, (key, v) => key === "cache" || key === "refCache" ? undefined : v), outs };
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
    const strip = c => JSON.stringify([c.sess, c.totals, c.excluded, c.prior, c.today, c.win, c.openTests, c.openControl]);
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

check("the unclear state names its cause", () => {
    const c = calcOf(meter);
    const ts = Date.UTC(2026, 9, 20, 14, 0);
    const full = {};
    for (let s = 0; s < 288; ++s) {
        full[s] = 1;
    }
    c.prior = [0, 1, 2].map(() => ({ lam: Object.assign({}, full), atr: Object.assign({}, full), ill: Object.assign({}, full) }));
    c.poolVersion = 1;
    c.lastSession = "20261020";
    c.meterTs = ts - 60000;
    const at = (r, q) => {
        c.win = { r, q, rng: r.map(() => 4), vol: r.map(() => 100) };
        return c.stateFor(ts, "20261020");
    };
    const r = [];
    for (let j = 0; j < 30; ++j) {
        r.push(j % 2 ? 3 : -2 + (j % 5));
    }
    const noflow = at(r, r.map(() => 10));
    const negative = at(r, r.map(v => -15 * v));
    // weak flow: search a seed for which the fit has a positive slope and R² under 5%
    let weak = null;
    for (let k = 0; !weak; ++k) {
        seed = 900 + k;
        const st = at(r, r.map(v => Math.round(v + (rand() - 0.5) * 200)));
        weak = st.lam > 0 && st.r2 > 0 && st.r2 < 0.05 ? st : null;
    }
    assert.deepStrictEqual([noflow.status, noflow.unclear, negative.status, negative.unclear, weak.status, weak.unclear],
        ["unclear", "noflow", "unclear", "negative", "unclear", "lowr2"]);
    assert.ok(/^NOW: unclear - net aggressive volume did not vary over the last 30 bars$/.test(c.nowLines(noflow)[0]));
    assert.ok(/^NOW: unclear - price moved against net aggression over the last 30 bars$/.test(c.nowLines(negative)[0]));
    assert.ok(/^NOW: unclear - net flow explains only \d\.\d% of price change \(needs 5\.0%\)$/.test(c.nowLines(weak)[0]), c.nowLines(weak)[0]);
});

// ── statistics by hand ──────────────────────────────────────────────────────

check("session jackknife and Mantel-Haenszel gap match a hand computation", () => {
    const c = calcOf(meter, { minSessions: 2, minTests: 1, minStratumN: 1 });
    // three sessions; volatility third 1 only; DEEP (lam 0) vs THIN (lam 2), volume-only third 1
    c.sess = { 0: emptyDay(), 1: emptyDay(), 2: emptyDay() };
    [[0, 6, 4], [1, 8, 5], [2, 7, 3]].forEach(([g, d, t]) => { put(c.sess[g], 1, 0, 1, d, 10); put(c.sess[g], 1, 2, 1, t, 10); });
    const z = c.summarize("z");
    assert.strictEqual(z.G, 3);
    assert.deepStrictEqual([z.states[0].G, z.states[1].G, z.states[2].G], [3, 0, 3]);
    // DEEP 21/30 = 0.7, THIN 12/30 = 0.4
    assert.ok(Math.abs(z.states[0].est - 0.7) < 1e-12 && Math.abs(z.states[2].est - 0.4) < 1e-12);
    assert.ok(Math.abs(z.raw.est - 0.3) < 1e-12);
    // one stratum, equal n: MH = raw difference
    assert.ok(Math.abs(z.sl.est - 0.3) < 1e-12);
    // jackknife by hand: leave out each session
    const half = jackHalf([15 / 20 - 8 / 20, 13 / 20 - 7 / 20, 14 / 20 - 9 / 20], 2);
    assert.ok(Math.abs(z.raw.half - half) < 1e-9, z.raw.half + " vs " + half);
    // odd/even: sessions 0 and 2 vs session 1 — all positive
    assert.strictEqual(z.agree, true);
    // the volume-only measure has no low/high thirds here: not available
    assert.deepStrictEqual([z.common, z.siC.ok, z.diff.ok], [[], false, false]);
});

check("Mantel-Haenszel weights strata by n_D·n_T/(n_D+n_T)", () => {
    const c = calcOf(meter, { minSessions: 2, minTests: 1, minStratumN: 1 });
    const a = emptyDay();
    const b = emptyDay();
    // stratum 0: D 8/10, T 2/10 (d = .6, wt 5); stratum 2: D 3/10, T 3/30 (d = .2, wt 7.5)
    [[a, 0, 0, 4, 5], [a, 0, 2, 1, 5], [a, 2, 0, 2, 5], [a, 2, 2, 2, 15], [b, 0, 0, 4, 5], [b, 0, 2, 1, 5], [b, 2, 0, 1, 5], [b, 2, 2, 1, 15]]
        .forEach(([s, atr, lam, w, n]) => put(s, atr, lam, 1, w, n));
    c.sess = { 0: a, 1: b };
    const z = c.summarize("z");
    assert.ok(Math.abs(z.sl.est - (5 * 0.6 + 7.5 * 0.2) / 12.5) < 1e-12, z.sl.est);
});

check("a margin counts only the sessions that hold its tests (DEEP in 3 of 20 sessions)", () => {
    const c = calcOf(meter);
    c.sess = {};
    for (let g = 0; g < 20; ++g) {
        c.sess[g] = emptyDay();
        put(c.sess[g], 1, 2, 1, 5, 10);
    }
    [[0, 14], [1, 12], [2, 16]].forEach(([g, w]) => put(c.sess[g], 1, 0, 1, w, 20));
    const z = c.summarize("z");
    const r = c.summarize("r");
    assert.deepStrictEqual([z.G, z.states[0].G, z.states[2].G, z.states[0].n], [20, 3, 20, 60]);
    // leave-one-out over the 3 DEEP sessions with t(2), not t(19) over all 20
    const half = jackHalf([28 / 40, 30 / 40, 26 / 40], 2);
    assert.ok(Math.abs(z.states[0].half - half) < 1e-9, z.states[0].half + " vs " + half);
    assert.ok(/^DEEP collecting \(n=60, 3 of 6 sessions\) \| /.test(c.zoneLines(z, r, 2)[1]), c.zoneLines(z, r, 2)[1]);
    assert.ok(/^DEEP minus THIN: collecting/.test(c.gapLines(z)[0]));
    assert.strictEqual(c.verdict(z, r), "Verdict: collecting - needs 30 tests from 6 sessions in both DEEP and THIN " +
        "(DEEP n=60 in 3 sessions, THIN n=200 in 20 sessions)");
});

check("a margin is never shown as ±0: rates get the binomial floor, differences say 'unstable'", () => {
    const c = calcOf(meter);
    c.sess = {};
    for (let g = 0; g < 8; ++g) {
        c.sess[g] = emptyDay();
        put(c.sess[g], 1, 0, 1, 7, 10);
        put(c.sess[g], 1, 2, 1, 4, 10);
    }
    const z = c.summarize("z");
    assert.ok(Math.abs(z.states[0].half - I.wilsonHalf(56, 80)) < 1e-12, "every session identical: Wilson floor");
    assert.deepStrictEqual([z.raw.ok, z.raw.unstable], [false, true]);
    assert.ok(/^DEEP 70% ±10 \(n=80, 8 sessions\)/.test(c.zoneLines(z, c.summarize("r"), 2)[1]), c.zoneLines(z, c.summarize("r"), 2)[1]);
    assert.ok(/^DEEP minus THIN: raw \+30 \(margin unstable\)/.test(c.gapLines(z)[0]), c.gapLines(z)[0]);
});

check("impact and volume-only gaps are compared on the same volatility thirds", () => {
    // calm: both measures sort tests identically (gap +30 for both); volatile: only
    // the impact state has low and high thirds (gap -30 there). On their common
    // third the two gaps are equal, so the bid/ask split adds exactly nothing.
    const c = calcOf(meter, { minSessions: 2, minTests: 1, minStratumN: 5 });
    c.sess = {};
    for (let g = 0; g < 8; ++g) {
        const s = c.sess[g] = emptyDay();
        const d = g % 2 ? 1 : -1;
        put(s, 0, 0, 0, 7 + d, 10);
        put(s, 0, 2, 2, 4, 10);
        put(s, 2, 0, 1, 2, 10);
        put(s, 2, 2, 1, 5 + d, 10);
    }
    const z = c.summarize("z");
    assert.deepStrictEqual([z.strataL, z.common], [[0, 2], [0]]);
    assert.ok(Math.abs(z.slC.est - z.siC.est) < 1e-12 && Math.abs(z.diff.est) < 1e-12, JSON.stringify([z.slC, z.siC, z.diff]));
    assert.ok(Math.abs(z.sl.est) < 1e-12, "calm +30 and volatile -30 cancel at equal weights");
    assert.ok(/^vs volume-only at equal volatility \(calm\): impact gap \+30 ±\d+, volume-only gap \+30 ±\d+, bid\/ask split adds \+0 \(margin unstable\)$/.test(c.gapLines(z)[1]),
        c.gapLines(z)[1]);
});

check("verdict wording follows the evidence, branch by branch, and never names colors", () => {
    const c = calcOf(meter);
    const ci = (est, half) => ({ est, half, lo: est - half, hi: est + half, ok: true });
    const na = { est: NaN, ok: false, G: 0 };
    const st = (est, n, G, half) => Object.assign({ n, G }, half === undefined ? { est, ok: false } : ci(est, half));
    const Z = o => Object.assign({
        G: 10, n: 300,
        states: [st(0.65, 100, 10, 0.05), st(0.58, 100, 10, 0.05), st(0.5, 100, 10, 0.05)],
        raw: ci(0.15, 0.06), sl: ci(0.12, 0.06), slC: ci(0.12, 0.06), siC: ci(0.03, 0.06), diff: ci(0.09, 0.05),
        strataL: [0, 1, 2], common: [0, 1, 2], agree: true
    }, o);
    const R = { states: [st(0.55, 1000, 10, 0.02), st(0.55, 1000, 10, 0.02), st(0.55, 1000, 10, 0.02)] };
    const cases = [
        [Z({}), /^Verdict: at equal volatility your zones reverse more in DEEP than in THIN; the bid\/ask split predicts it better than a volume-only measure\. Favor zone fades in DEEP$/],
        [Z({ raw: ci(-0.15, 0.06), sl: ci(-0.12, 0.06), diff: ci(-0.09, 0.05), states: [st(0.5, 100, 10, 0.05), st(0.58, 100, 10, 0.05), st(0.65, 100, 10, 0.05)] }),
            /more in THIN than in DEEP; the bid\/ask split predicts it better.*\. Favor zone fades in THIN$/],
        [Z({ states: [st(0.58, 100, 10, 0.05), st(0.55, 100, 10, 0.05), st(0.46, 100, 10, 0.05)] }), /\. But DEEP zones do not clearly beat random prices yet$/],
        [Z({ diff: ci(-0.09, 0.05) }), /; a volume-only measure predicts it better than the bid\/ask split\./],
        [Z({ diff: ci(0.02, 0.05), siC: ci(0.1, 0.05) }), /; a volume-only measure shows a similar gap, so it may be liquidity in general\./],
        [Z({ diff: ci(0.02, 0.05) }), /; cannot tell yet whether the bid\/ask split adds anything beyond volume\./],
        [Z({ diff: na }), /; the volume-only comparison is not available yet\./],
        [Z({ agree: false }), /odd and even sessions disagree - not reliable yet$/],
        [Z({ agree: null }), /too few tests to check odd vs even sessions yet$/],
        [Z({ raw: ci(-0.1, 0.05) }), /more in DEEP than in THIN \(overall DEEP shows the lower rate - volatility masks it\);/],
        [Z({ sl: ci(0.02, 0.05) }), /^Verdict: the DEEP\/THIN gap is explained by volatility/],
        [Z({ sl: ci(0.05, 0.12) }), /same-volatility gap is too uncertain to tell whether that is just volatility$/],
        [Z({ raw: ci(0.02, 0.05), sl: ci(0.01, 0.05) }), /^Verdict: no measurable DEEP\/THIN difference on this chart/],
        [Z({ sl: na }), /overall, but there are too few tests at equal volatility to tell whether that is just volatility$/],
        [Z({ sl: na, raw: ci(0.02, 0.05) }), /^Verdict: no measurable DEEP\/THIN difference so far$/],
        [Z({ states: [st(0.65, 20, 10, 0.05), st(0.58, 100, 10, 0.05), st(0.5, 100, 10, 0.05)] }), /^Verdict: collecting/]
    ];
    cases.forEach(([z, re]) => {
        const v = c.verdict(z, R);
        assert.ok(re.test(v), re + " got: " + v);
        assert.ok(!/blue|orange|grey|gray/i.test(v), v);
    });
    // a state's rate must beat random prices measured in that same state
    const fewRandom = { states: [st(0.55, 10, 3), R.states[1], R.states[2]] };
    assert.ok(/do not clearly beat random prices yet$/.test(c.verdict(Z({}), fewRandom)));
});

check("volatility control: a gap that comes only from calmer DEEP periods is explained away", () => {
    // Within each volatility third DEEP and THIN reverse equally often overall
    // (calm 80%, middle 50%, volatile 20%; sessions vary around that), but DEEP tests
    // sit mostly in calm periods and THIN tests mostly in volatile ones — so DEEP
    // looks far better overall.
    const c = calcOf(meter, { minSessions: 6, minTests: 1, minStratumN: 10 });
    c.sess = {};
    for (let g = 0; g < 8; ++g) {
        const s = c.sess[g] = emptyDay();
        const odd = g % 2 === 1;
        put(s, 0, 0, 1, odd ? 17 : 15, 20);  put(s, 0, 2, 1, 4, 5);
        put(s, 1, 0, 1, odd ? 6 : 4, 10);    put(s, 1, 2, 1, 5, 10);
        put(s, 2, 0, 1, odd ? 2 : 0, 5);     put(s, 2, 2, 1, 4, 20);
    }
    const z = c.summarize("z");
    assert.ok(z.raw.ok && z.raw.est > 0.25 && z.raw.lo > 0.1, "big raw gap: " + JSON.stringify(z.raw));
    assert.ok(z.sl.ok && Math.abs(z.sl.est) < 1e-12, "zero at equal volatility: " + JSON.stringify(z.sl));
    const v = c.verdict(z, c.summarize("r"));
    assert.ok(/^Verdict: the DEEP\/THIN gap is explained by volatility/.test(v), v);
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

check("changing a setting marks the results as in-sample; sessions loaded counts the live bar's session", () => {
    const tape = sessionTape({ sessions: 3, regimeOf: () => ({ steps: 30, size: 5, couple: 0.8 }) });
    const short = tape.slice(0, 80);
    assert.ok(/^Sessions loaded 1 \| default settings \|/.test(lineWith(run(meter, short).outputs[79], /^Sessions loaded/)));
    assert.ok(/\| SETTINGS CHANGED from defaults: results are in-sample \|/.test(lineWith(run(meter, short, { impactWindow: 40 }).outputs[79], /^Sessions loaded/)));
    const plusOne = tape.slice(0, 2 * 1380 + 1);
    assert.ok(/^Sessions loaded 3 \|/.test(lineWith(run(meter, plusOne).outputs[2 * 1380], /^Sessions loaded/)), "the live bar opened session 3");
});

check("text: plain color by default, bold verdict, every row fits", () => {
    seed = 81;
    const tape = sessionTape({ sessions: 5, regimeOf: (s, b) => ({ steps: 30, size: 5, couple: blockRegime(s, b, 8) ? 0.9 : 0.65 }) });
    const { outputs, calc } = run(meter, tape);
    const kids = outputs[outputs.length - 1].graphics.items[0].children;
    assert.strictEqual(calc.props.textColor, "#78838f");
    kids.forEach(k => assert.strictEqual(k.style.fill, "#78838f"));
    assert.ok(kids.some(k => k.text.startsWith("Verdict") && k.style.fontWeight === "bold"));
    assert.ok(kids.filter(k => !k.text.startsWith("Verdict") && !k.text.startsWith("    ")).every(k => !k.style.fontWeight));
    kids.forEach(k => assert.ok(k.text.length <= I.LINE_CHARS, k.text));
    const brief = run(meter, tape, { showDetails: false }).outputs;
    const lines = texts(brief[brief.length - 1]);
    assert.ok(!lines.some(t => /^(DEEP minus THIN|vs volume-only|Sessions loaded|zone tests)/.test(t)), "details hidden");
    assert.ok(lines.some(t => t.startsWith("Verdict")));
});

// ── statistical behaviour ───────────────────────────────────────────────────

const flipRegime = (salt, deep, thin) => (s, b) => (blockRegime(s, b, salt) ? deep : thin);

check("random walk: the DEEP/THIN gap is noise, and the margins cover zero", () => {
    const seeds = FULL ? 40 : 12;
    let covRaw = 0, covSl = 0, covDiff = 0, rawOk = 0, slOk = 0, diffOk = 0, claims = 0, fades = 0;
    for (let k = 0; k < seeds; ++k) {
        seed = 1000 + k;
        const tape = sessionTape({ sessions: 11, regimeOf: flipRegime(100 + k,
            { steps: 30, size: 5, couple: 0.9 }, { steps: 30, size: 5, couple: 0.65 }) });
        const { calc } = run(meter, tape);
        const s = calc.stats();
        const covers = x => x.lo <= 0 && x.hi >= 0;
        [[s.z.raw, () => { rawOk++; covRaw += covers(s.z.raw); }], [s.z.sl, () => { slOk++; covSl += covers(s.z.sl); }],
            [s.z.diff, () => { diffOk++; covDiff += covers(s.z.diff); }]].forEach(([x, f]) => x.ok && f());
        const v = calc.verdict(s.z, s.r);
        claims += /your zones reverse more in/.test(v) ? 1 : 0;
        fades += /Favor zone fades/.test(v) ? 1 : 0;
    }
    console.log("      " + seeds + " random-walk seeds: raw covers 0 in " + covRaw + "/" + rawOk + ", same volatility in " + covSl + "/" + slOk +
        ", split-adds in " + covDiff + "/" + diffOk + "; verdict claimed a DEEP/THIN difference " + claims + "x, said to favor zone fades " + fades + "x");
    assert.ok(rawOk >= seeds / 2 && covRaw >= Math.ceil(0.75 * rawOk), "raw coverage");
    assert.ok(slOk >= seeds / 2 && covSl >= Math.ceil(0.75 * slOk), "same-volatility coverage");
    assert.ok(claims <= Math.max(1, Math.floor(0.1 * seeds)), "verdict rarely claims an effect on noise");
    assert.ok(fades <= Math.max(1, Math.floor(0.05 * seeds)), "verdict rarely recommends fading zones on noise");
});

check("planted order-flow effect at equal volatility: detected, and credited to the bid/ask split", () => {
    let found = 0;
    for (let k = 0; k < 3; ++k) {
        seed = 3000 + k;
        // same volatility and volume. Loosely aligned aggression (couple 0.7) moves price
        // less per net contract = DEEP; tightly aligned (0.95) moves it more = THIN.
        // Zones are defended in DEEP blocks and give way in THIN blocks. Regimes last 4 hours
        // (the 30-bar window needs time to see a change), and a stricter absorption setting
        // keeps the zones to the planted ones, the only prices the regimes act on.
        const tape = sessionTape({ sessions: 16, blockMinutes: 240, regimeOf: flipRegime(300 + k,
            { steps: 30, size: 5, couple: 0.7, defend: true }, { steps: 30, size: 5, couple: 0.95, defend: "break" }) });
        const { calc, outputs } = run(meter, tape, { absorptionMultiple: 10 });
        const s = calc.stats();
        const v = calc.verdict(s.z, s.r);
        console.log("      planted seed " + k + ": DEEP " + (100 * s.z.states[0].est).toFixed(0) + "% THIN " + (100 * s.z.states[2].est).toFixed(0) +
            "% | same volatility " + (s.z.sl.ok ? (100 * s.z.sl.est).toFixed(1) + " ±" + (100 * s.z.sl.half).toFixed(1) : "n/a") + " | " + v);
        assert.ok(s.z.states[0].est > s.z.states[2].est, "DEEP zones reverse more");
        found += /^Verdict: at equal volatility your zones reverse more in DEEP than in THIN; the bid\/ask split predicts it better/.test(v) ? 1 : 0;
        const last = outputs[outputs.length - 1];
        rows(last).forEach(r => assert.ok(r.length <= I.LINE_CHARS, r));
        if (k === 0) {
            const t = texts(last);
            const has = re => assert.ok(t.some(x => re.test(x)), re + "\n" + t.join("\n"));
            has(/^Your zones' reversal rate by state \| reversal = 1\.5x avg bar range in favor before the same against, within 60 bars \| distances used \d+\.\d\d-\d+\.\d\d, now \d+\.\d\d$/);
            has(/^DEEP \d+% ±\d+ \(n=\d+, \d+ sessions; random \d+%\) \| NORMAL .* \| THIN \d+% ±\d+ \(n=\d+, \d+ sessions; random \d+%\)$/);
            has(/^DEEP minus THIN: raw [+-]\d+ ±\d+ \| same volatility \((calm|mid|volatile)(, (mid|volatile))*\) [+-]\d+ ±\d+ \| odd\/even sessions agree: (yes|no|n\/a)$/);
            has(/^vs volume-only at equal volatility \(.*\): impact gap .*, volume-only gap .*, bid\/ask split adds /);
            has(/^Sessions loaded 16 \| SETTINGS CHANGED from defaults: results are in-sample \| bid\/ask volume coverage 100%$/);
            has(/^zone tests: \d+ state-tagged, \d+ excluded \(window building \d+, warm-up \d+, unclear \d+\) \| fails hitting both sides in one bar: DEEP /);
        }
    }
    assert.ok(found >= 2, "verdict found the planted effect in " + found + "/3 seeds");
});

check("planted depth from trade size: zones truly beat random in DEEP, so the verdict says to favor fades there", () => {
    let fades = 0;
    for (let k = 0; k < 3; ++k) {
        seed = 5000 + k;
        // whole sessions are either DEEP (10 contracts per tick; zones defended) or THIN
        // (4 per tick; zones give way), same volatility and aggressor alignment. Impact
        // is cleanly 2.5x higher in THIN. Plain volume differs too, so the verdict must
        // not credit the bid/ask split for this.
        const tape = sessionTape({ sessions: 16, blockMinutes: 1380, regimeOf: flipRegime(500 + k,
            { steps: 30, size: 10, couple: 0.85, defend: true }, { steps: 30, size: 4, couple: 0.85, defend: "break" }) });
        const { calc } = run(meter, tape, { absorptionMultiple: 10 });
        const s = calc.stats();
        const v = calc.verdict(s.z, s.r);
        console.log("      size seed " + k + ": DEEP " + (100 * s.z.states[0].est).toFixed(0) + "% ±" + (100 * s.z.states[0].half).toFixed(0) +
            " vs random " + (100 * s.r.states[0].est).toFixed(0) + "% | " + v);
        assert.ok(!/bid\/ask split predicts it better/.test(v), v);
        fades += /^Verdict: at equal volatility your zones reverse more in DEEP than in THIN; .*\. Favor zone fades in DEEP$/.test(v) ? 1 : 0;
    }
    assert.ok(fades >= 2, "favor zone fades in DEEP in " + fades + "/3 seeds");
});

console.log(passed + " checks passed");

#!/usr/bin/env node
// Offline harness for restingOrderLevels.js — runs the indicator outside
// Tradovate against synthetic footprint bars with planted absorption events,
// mimicking how the app calls map(): once per historical bar, then repeatedly
// on the live bar (once per tick), then once more when a new bar opens.
//
//   node indicators/tradovate/test/harness.js
//
// Exits non-zero on the first failed check.

const fs = require("fs");
const path = require("path");
const assert = require("assert");

// ── minimal stand-ins for Tradovate's in-app ./tools modules ──────────────
const toolMocks = {
    "./tools/predef": {
        paramSpecs: {
            number: (def, step, min) => ({ type: "number", def, restrictions: { step: step || 1, min: min || 0 } }),
            period: def => ({ type: "number", def, restrictions: { step: 1, min: 1 } }),
            bool: def => ({ type: "boolean", def }),
            enum: (enumSet, def) => ({ type: "enum", enumSet, def }),
            color: def => ({ type: "color", def })
        }
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

function loadIndicator() {
    const file = path.join(__dirname, "..", "restingOrderLevels.js");
    const src = fs.readFileSync(file, "utf8");
    const mod = { exports: {} };
    const req = name => {
        if (!(name in toolMocks)) {
            throw new Error("indicator requires unknown module " + name);
        }
        return toolMocks[name];
    };
    new Function("require", "module", "exports", src)(req, mod, mod.exports);
    return mod.exports;
}

const indicator = loadIndicator();
const TICK = 0.25;

function defaults(overrides) {
    const props = {};
    Object.keys(indicator.params).forEach(k => { props[k] = indicator.params[k].def; });
    return Object.assign(props, overrides || {});
}

function makeCalc(overrides) {
    const Calc = indicator.calculator;
    const c = new Calc();
    c.props = defaults(overrides);
    c.contractInfo = { contract: "MNQZ6", product: "MNQ", tickSize: TICK };
    c.init();
    return c;
}

// ── synthetic footprint data ──────────────────────────────────────────────
// mulberry32: integer-exact, so it never degrades into a short cycle
let seed = 7;
function rand() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const onTick = p => Math.round(p / TICK) * TICK;

// Build a bar from OHLC, spreading `perLevel` contracts over each price with
// a random bid/ask split; `extra` plants additional fills at given prices.
function bar(o, h, l, c, perLevel, extra) {
    const profile = [];
    for (let p = l; p <= h + 1e-9; p = onTick(p + TICK)) {
        const vol = Math.round(perLevel * (0.6 + 0.8 * rand()));
        const bidVol = Math.round(vol * (0.3 + 0.4 * rand()));
        profile.push({ price: onTick(p), vol, bidVol, askVol: vol - bidVol });
    }
    (extra || []).forEach(x => {
        const lvl = profile.find(q => Math.abs(q.price - x.price) < 1e-9);
        lvl.bidVol += x.bid || 0;
        lvl.askVol += x.ask || 0;
        lvl.vol += (x.bid || 0) + (x.ask || 0);
    });
    return { o, h, l, c, profile };
}

function randomBar(prevClose) {
    const o = prevClose;
    const c = onTick(o + (Math.round((rand() - 0.5) * 8)) * TICK);
    const h = onTick(Math.max(o, c) + Math.round(rand() * 3) * TICK);
    const l = onTick(Math.min(o, c) - Math.round(rand() * 3) * TICK);
    return bar(o, h, l, c, 40);
}

// Scripted tape: drift, a planted bid absorption at 21000 (support), two
// retests that hold, a planted offer absorption at 21020 (resistance), then a
// bar that closes through support.
function scriptedBars() {
    const bars = [];
    let px0 = 21010;
    for (let i = 0; i < 60; ++i) {
        const b = randomBar(px0);
        // keep the warm-up away from the planted prices
        const shift = b.c > 21015 || b.c < 21005 ? 21010 - b.c : 0;
        if (shift) {
            const s = bar(onTick(b.o + shift), onTick(b.h + shift), onTick(b.l + shift), onTick(b.c + shift), 40);
            bars.push(s);
            px0 = s.c;
        }
        else {
            bars.push(b);
            px0 = b.c;
        }
    }
    const marks = {};
    // 60: sellers slam into 21000, resting bids absorb ~1200 contracts, hammer closes 16 ticks up
    marks.supportBorn = bars.length;
    bars.push(bar(21003, 21005, 21000, 21004, 40, [{ price: 21000, bid: 900 }, { price: 21000.25, bid: 300 }]));
    for (let i = 0; i < 10; ++i) {
        bars.push(bar(21003, 21006, 21002, 21004, 40));
    }
    // two retests that hold (low touches 21000.25, closes above)
    marks.retest1 = bars.length;
    bars.push(bar(21003, 21004, 21000.25, 21002.5, 40, [{ price: 21000.25, bid: 150 }]));
    bars.push(bar(21002.5, 21006, 21002, 21005, 40));
    marks.retest2 = bars.length;
    bars.push(bar(21004, 21005, 21000, 21003, 40));
    for (let i = 0; i < 8; ++i) {
        bars.push(bar(21008, 21012, 21006, 21010, 40));
    }
    // offers absorb ~800 at 21020, bar closes 7 ticks down from it
    marks.resistanceBorn = bars.length;
    bars.push(bar(21016, 21020, 21015, 21018.25, 40, [{ price: 21020, ask: 800 }]));
    for (let i = 0; i < 10; ++i) {
        bars.push(bar(21012, 21015, 21010, 21013, 40));
    }
    // close through support by 8 ticks
    bars.push(bar(21005, 21006, 21001, 21002, 40));
    marks.supportBroken = bars.length;
    bars.push(bar(21002, 21002.5, 20997.5, 20998, 40));
    for (let i = 0; i < 5; ++i) {
        bars.push(bar(20998, 20999, 20996, 20997, 40));
    }
    return { bars, marks };
}

// ── Tradovate-like driver ─────────────────────────────────────────────────
function entity(b, idx, isLast, opts) {
    return {
        timestamp: () => new Date(1700000000000 + idx * 60000),
        tradeDate: () => 20261018,
        index: () => idx,
        isLast: () => isLast(),
        value: () => b.c,
        open: () => b.o,
        high: () => b.h,
        low: () => b.l,
        close: () => b.c,
        volume: () => (opts.noBidAsk && opts.noProfile) ? 500 : b.profile.reduce((s, q) => s + q.vol, 0),
        bidVolume: () => opts.noBidAsk ? 0 : b.profile.reduce((s, q) => s + q.bidVol, 0),
        offerVolume: () => opts.noBidAsk ? 0 : b.profile.reduce((s, q) => s + q.askVol, 0),
        profile: () => opts.noProfile ? undefined : b.profile
    };
}

function series(ents, cursor) {
    return {
        data: ents,
        get: k => ents[k],
        size: () => ents.length,
        first: () => ents[0],
        last: () => ents[ents.length - 1],
        prior: () => ents[cursor.i - 1],
        back: n => ents[cursor.i - n]
    };
}

// Run historical calc over `bars`; returns { calc, outputs }.
function runHistory(bars, overrides, opts) {
    opts = opts || {};
    const calc = makeCalc(overrides);
    const ents = [];
    const cursor = { i: 0 };
    const hist = series(ents, cursor);
    bars.forEach((b, idx) => ents.push(entity(b, idx, () => idx === ents.length - 1, opts)));
    const outputs = [];
    for (let i = 0; i < ents.length; ++i) {
        cursor.i = i;
        outputs.push(calc.map(ents[i], i, hist));
    }
    return { calc, outputs, ents, cursor, hist };
}

function levelsOf(calc, side) {
    return calc.levels.filter(l => l.side === side).map(l => ({ price: l.price, holds: l.holds, filled: l.filled }));
}

function globalContainer(out) {
    const items = (out && out.graphics && out.graphics.items) || [];
    return items.find(it => it.tag === "Container" && it.global);
}

function checkScaleBound(sb) {
    assert.ok(sb && typeof sb === "object", "ScaleBound object");
    if ("op" in sb) {
        checkScaleBound(sb.a);
        checkScaleBound(sb.b);
    }
    else {
        assert.ok(sb.unit === "px" || sb.unit === "du", "unit px|du");
        assert.ok(Number.isFinite(sb.value), "finite ScaleBound value");
    }
}

function checkGraphics(items) {
    items.forEach(it => {
        assert.ok(typeof it.tag === "string" && typeof it.key === "string", "tag + key");
        if (it.tag === "Container") {
            checkGraphics(it.children);
        }
        else if (it.tag === "LineSegments") {
            assert.ok(it.lineStyle && Number.isFinite(it.lineStyle.lineWidth));
            it.lines.forEach(l => {
                checkScaleBound(l.a.x); checkScaleBound(l.a.y);
                checkScaleBound(l.b.x); checkScaleBound(l.b.y);
            });
        }
        else if (it.tag === "Text") {
            assert.ok(typeof it.text === "string" && it.text.length > 0);
            checkScaleBound(it.point.x); checkScaleBound(it.point.y);
        }
        else if (it.tag === "Shapes") {
            it.primitives.forEach(pr => { checkScaleBound(pr.center.x); checkScaleBound(pr.center.y); });
        }
        else {
            assert.fail("unexpected tag " + it.tag);
        }
    });
}

let passed = 0;
function check(name, fn) {
    fn();
    passed++;
    console.log("  ok  " + name);
}

const { bars, marks } = scriptedBars();

console.log("restingOrderLevels harness (" + bars.length + " bars)");

check("support forms at the planted bid absorption and counts holds", () => {
    const upTo = bars.slice(0, marks.retest2 + 2);
    const { calc } = runHistory(upTo);
    const s = levelsOf(calc, "S").find(l => Math.abs(l.price - 21000) <= 0.25);
    assert.ok(s, "support near 21000: " + JSON.stringify(levelsOf(calc, "S")));
    assert.ok(s.holds >= 2, "two held retests, got " + s.holds);
    assert.ok(s.filled >= 1200, "filled includes the absorbed bids, got " + s.filled);
});

check("resistance forms at the planted offer absorption", () => {
    const upTo = bars.slice(0, marks.resistanceBorn + 3);
    const { calc } = runHistory(upTo);
    const r = levelsOf(calc, "R").find(l => Math.abs(l.price - 21020) <= 0.25);
    assert.ok(r, "resistance at 21020: " + JSON.stringify(levelsOf(calc, "R")));
});

check("support is removed after a close through it", () => {
    const { calc } = runHistory(bars);
    const s = levelsOf(calc, "S").find(l => Math.abs(l.price - 21000) <= 0.25);
    assert.ok(!s, "21000 support should be broken");
});

check("fixed tick distances override auto (wide break keeps the level)", () => {
    const { calc } = runHistory(bars, { breakTicks: 40 });
    const s = levelsOf(calc, "S").find(l => Math.abs(l.price - 21000) <= 0.25);
    assert.ok(s, "40-tick break distance survives an 8-tick close-through");
    assert.strictEqual(calc.ticks("breakTicks"), 40);
});

check("auto distances scale with the average bar range", () => {
    const calc = makeCalc();
    calc.baseRange = 5;   // ES-like 1m bars
    const es = ["edgeTicks", "touchTicks", "breakTicks"].map(n => calc.ticks(n));
    calc.baseRange = 20;  // NQ-like 1m bars
    const nq = ["edgeTicks", "touchTicks", "breakTicks"].map(n => calc.ticks(n));
    assert.deepStrictEqual(es, [2, 1, 2]);
    assert.deepStrictEqual(nq, [4, 2, 6]);
});

check("broken support flips to resistance when flipBrokenLevels is on", () => {
    const { calc } = runHistory(bars, { flipBrokenLevels: true });
    const r = calc.levels.find(l => l.side === "R" && l.flipped && Math.abs(l.price - 21000) <= 0.25);
    assert.ok(r, "flipped level at 21000");
    assert.strictEqual(r.holds, 0, "the breaking bar must not count as a hold of the flipped side");
});

check("graphics: global level container only on the last bar, valid shapes", () => {
    const upTo = bars.slice(0, marks.resistanceBorn + 3);
    const { outputs } = runHistory(upTo);
    outputs.slice(0, -1).forEach((o, i) => assert.ok(!globalContainer(o), "no level drawing on historical bar " + i));
    const last = outputs[outputs.length - 1];
    const cont = globalContainer(last);
    assert.ok(cont, "last bar draws levels");
    checkGraphics(last.graphics.items);
    const texts = cont.children.filter(c => c.tag === "Text").map(c => c.text);
    assert.ok(texts.some(t => /^S1 21000\.\d\d \| reversal odds: collecting \(n=\d+\) \| .*bid fills \| held \dx/.test(t)), "S1 label: " + texts.join(" / "));
    assert.ok(texts.some(t => /^R1 21020\.00 \| .* \| .*offer fills/.test(t)), "R1 label: " + texts.join(" / "));
    assert.ok(texts.some(t => t.startsWith("Resting Order Levels: footprint")), "status text");
    assert.ok(texts.some(t => /^Reversal = 1\.5x avg bar range \(now \d+\.\d\d, \d+\.\d\d-\d+\.\d\d in the counted tests\) in favor before the same against, within 60 bars {2}\| {2}zones .* {2}vs {2}random prices \d+% ±\d+ \(n=\d+\)$/.test(t)), "odds status: " + texts.join(" / "));
    outputs.forEach(o => o.graphics && checkGraphics(o.graphics.items));
});

check("absorption dot drawn on the bar where resting orders filled", () => {
    const { outputs } = runHistory(bars.slice(0, marks.supportBorn + 1));
    const dots = outputs[marks.supportBorn].graphics.items.filter(it => it.tag === "Shapes");
    assert.ok(dots.length >= 1, "dot on absorption bar");
    assert.strictEqual(dots[0].primitives[0].center.y.value, 21000);
});

// Live-bar ticking: the app calls map() on the same index once per tick.
// The result must not depend on how many ticks there were, whether or not the
// app restores calculator state between calls.
function liveRun(restore) {
    const hist = bars.slice(0, marks.resistanceBorn + 3);
    const run = runHistory(hist);
    const { calc, ents, cursor } = run;
    const idx = ents.length;
    const liveBar = { o: 21013, h: 21013, l: 21013, c: 21013, profile: [] };
    ents.push(entity(liveBar, idx, () => idx === ents.length - 1, {}));
    cursor.i = idx;
    const snapshot = restore ? JSON.stringify(calc) : null;
    let out;
    for (let t = 0; t < 25; ++t) {
        if (restore) {
            Object.assign(calc, JSON.parse(snapshot));
        }
        const p = onTick(21013 + Math.round((rand() - 0.5) * 6) * TICK);
        liveBar.h = Math.max(liveBar.h, p);
        liveBar.l = Math.min(liveBar.l, p);
        liveBar.c = p;
        liveBar.profile = bar(liveBar.o, liveBar.h, liveBar.l, liveBar.c, 5).profile;
        out = calc.map(ents[idx], idx, run.hist);
    }
    // bar closes, a new one opens
    const nextBar = bar(liveBar.c, liveBar.c + 1, liveBar.c - 1, liveBar.c, 40);
    ents.push(entity(nextBar, idx + 1, () => idx + 1 === ents.length - 1, {}));
    cursor.i = idx + 1;
    if (restore) {
        Object.assign(calc, JSON.parse(snapshot));
        cursor.i = idx;
        calc.map(ents[idx], idx, run.hist);
        cursor.i = idx + 1;
    }
    out = calc.map(ents[idx + 1], idx + 1, run.hist);
    return { calc, out, prevOut: null };
}

check("live ticks are idempotent (no state restore between calls)", () => {
    seed = 99;
    const a = liveRun(false);
    seed = 99;
    const b = liveRun(true);
    assert.strictEqual(a.calc.committed, b.calc.committed);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(a.calc.levels)), JSON.parse(JSON.stringify(b.calc.levels)));
    ["zoneStats", "controlStats", "openTests", "openControl"].forEach(k =>
        assert.deepStrictEqual(JSON.parse(JSON.stringify(a.calc[k])), JSON.parse(JSON.stringify(b.calc[k])), k));
    assert.ok(globalContainer(a.out), "levels drawn on the new last bar");
});

check("bar-level fallback when the chart has no per-price profile", () => {
    const { calc, outputs } = runHistory(bars.slice(0, marks.supportBorn + 3), {}, { noProfile: true });
    const s = calc.levels.find(l => l.side === "S" && Math.abs(l.price - 21000) <= 0.25);
    assert.ok(s && s.estimated, "estimated support at the absorption bar low");
    const cont = globalContainer(outputs[outputs.length - 1]);
    const status = cont.children.find(c => c.key === "status0").text;
    assert.ok(/bar-level estimate/.test(status), status);
    const lbl = cont.children.find(c => c.tag === "Text" && !c.key.startsWith("status")).text;
    assert.ok(/\| ~\d/.test(lbl), "estimated fills marked with ~: " + lbl);
});

check("no bid/ask data: draws nothing and says so", () => {
    const { calc, outputs } = runHistory(bars, {}, { noProfile: true, noBidAsk: true });
    assert.strictEqual(calc.levels.length, 0);
    const status = globalContainer(outputs[outputs.length - 1]).children.find(c => c.key === "status0").text;
    assert.ok(/NO bid\/ask volume/.test(status), status);
});

check("random tape: bounded state, finite output, no throw", () => {
    seed = 1234;
    const tape = [];
    let c = 21000;
    for (let i = 0; i < 3000; ++i) {
        const b = randomBar(c);
        if (rand() < 0.03) {
            const big = Math.round(200 + rand() * 600);
            if (rand() < 0.5 && b.c - b.l >= 2 * TICK) {
                b.profile[0].bidVol += big; b.profile[0].vol += big;
            }
            else if (b.h - b.c >= 2 * TICK) {
                const top = b.profile[b.profile.length - 1];
                top.askVol += big; top.vol += big;
            }
        }
        tape.push(b);
        c = b.c;
    }
    const { calc, outputs } = runHistory(tape);
    assert.ok(calc.levels.length <= 80, "level cap");
    // a random walk has no real defenders, so levels form and get run over
    assert.ok(calc.nextId - 1 >= 10, "levels created on a random tape: " + (calc.nextId - 1));
    calc.levels.forEach(l => {
        assert.ok(Number.isFinite(l.price) && Number.isFinite(l.strength));
        assert.ok(Math.abs(l.price / TICK - Math.round(l.price / TICK)) < 1e-6, "level on tick grid");
    });
    checkGraphics(outputs[outputs.length - 1].graphics.items);
    const shown = globalContainer(outputs[outputs.length - 1]).children.filter(x => x.tag === "LineSegments");
    assert.ok(shown.length <= 2 * calc.props.levelsPerSide, "levelsPerSide respected");
});

// ── reversal statistics ─────────────────────────────────────────────────────
// Zones are placed by hand on bars without profile data and with a huge volume
// baseline (so nothing is auto-detected); distances are fixed: touch 1 tick,
// break 4 ticks, bounce 8 ticks = 2.00 points. Support zone at 100.00, so a
// bounce is a later high >= 102.00 and a fail is a low <= 98.00.
function statCalc(overrides) {
    const c = makeCalc(Object.assign({ bounceTicks: 8, touchTicks: 1, breakTicks: 4, horizonBars: 60 }, overrides));
    c.baseCount = 1000;
    c.baseRange = 10;
    c.baseLevel = 1e12;
    c.baseBar = 1e12;
    c.prevClose = 101;
    return c;
}
function zone(c, side, price) {
    const lvl = { id: c.nextId++, side, price, born: 0, lastTest: 0, filled: 100, strength: 100, holds: 0, tests: 0, flipped: false, estimated: false };
    c.levels.push(lvl);
    return lvl;
}
const ohlc = (o, h, l, cl) => ({ open: o, high: h, low: l, close: cl, volume: 100, bidVol: 50, askVol: 50, profile: null });
function feed(c, list, from) {
    let k = from || 1;
    list.forEach(b => c.commit(b, k++));
    return k;
}
const zs = c => c.zoneStats.map(x => x.w + "/" + x.n).join(" ");
const TOUCH = ohlc(101, 101, 100, 100.5);

check("odds: bounce 2.00 up before 2.00 down = reversal", () => {
    const c = statCalc();
    zone(c, "S", 100);
    feed(c, [TOUCH, ohlc(100.5, 102, 100.5, 101.75)]);
    assert.strictEqual(zs(c), "1/1 0/0 0/0");
});

check("odds: 2.00 through first = no reversal", () => {
    const c = statCalc();
    zone(c, "S", 100);
    feed(c, [TOUCH, ohlc(100.5, 100.5, 98, 98.25)]);
    assert.strictEqual(zs(c), "0/1 0/0 0/0");
});

check("odds: one bar reaching both sides counts as no reversal", () => {
    const c = statCalc();
    zone(c, "S", 100);
    feed(c, [TOUCH, ohlc(100.5, 102, 98, 101)]);
    assert.strictEqual(zs(c), "0/1 0/0 0/0");
});

check("odds: the touch bar's own high is never credited (its order is unknown)", () => {
    const c = statCalc();
    zone(c, "S", 100);
    const k = feed(c, [ohlc(101, 102.5, 100, 101), ohlc(101, 101.5, 100.5, 101)]);
    assert.strictEqual(zs(c), "0/0 0/0 0/0", "still open");
    feed(c, [ohlc(101, 102, 100.75, 101.5)], k);
    assert.strictEqual(zs(c), "1/1 0/0 0/0");
});

check("odds: a touch bar that wicks 2.00 through is a no-reversal at once", () => {
    const c = statCalc();
    zone(c, "S", 100);
    feed(c, [ohlc(101, 101, 98, 98.5)]);
    assert.strictEqual(zs(c), "0/1 0/0 0/0");
    assert.strictEqual(c.levels.length, 0, "the zone itself broke on that close");
});

check("odds: zones broken on the touch bar still count (no survivorship bias)", () => {
    const c = statCalc();
    zone(c, "S", 100);
    const k = feed(c, [ohlc(101, 101, 99, 98.75)]);
    assert.strictEqual(c.levels.length, 0, "closed 5 ticks through: zone removed");
    assert.strictEqual(c.openTests.length, 1, "but its test is still running");
    feed(c, [ohlc(98.75, 102, 98.5, 101.5)], k);
    assert.strictEqual(zs(c), "1/1 0/0 0/0");
});

check("odds: undecided after horizonBars counts as no reversal", () => {
    const c = statCalc({ horizonBars: 5 });
    zone(c, "S", 100);
    const quiet = ohlc(100.5, 101, 100.5, 100.75);
    const k = feed(c, [TOUCH, quiet, quiet, quiet, quiet]);
    assert.strictEqual(zs(c), "0/0 0/0 0/0", "4 bars after the touch: still open");
    feed(c, [quiet], k);
    assert.strictEqual(zs(c), "0/1 0/0 0/0", "5th bar: horizon reached");
});

check("odds: one test per zone at a time, numbered 1st / 2nd / 3rd+", () => {
    const c = statCalc();
    const z = zone(c, "S", 100);
    feed(c, [
        TOUCH,                              // 1: test #1 starts
        ohlc(100.5, 100.8, 100.1, 100.6),   // 2: touches again while #1 is open: no new test
        ohlc(100.6, 102, 100.5, 101.75),    // 3: #1 bounces
        ohlc(101.75, 101.75, 100, 100.4),   // 4: back from above: test #2
        ohlc(100.4, 100.4, 97.75, 99.5),    // 5: #2 fails (zone survives: close 99.50)
        ohlc(99.5, 101, 99.5, 100.8),       // 6: touched from BELOW: not a test
        ohlc(100.8, 101.5, 100.5, 101.2),   // 7: no touch
        ohlc(101.2, 101.2, 100, 100.5),     // 8: test #3
        ohlc(100.5, 102.5, 100.5, 102),     // 9: #3 bounces
        ohlc(102, 102, 100.1, 100.6),       // 10: test #4 (3rd+ bucket)
        ohlc(100.6, 100.6, 97, 97.5)        // 11: #4 fails
    ]);
    assert.strictEqual(zs(c), "1/1 0/1 1/2");
    assert.strictEqual(z.tests, 4);
});

check("odds: resistance mirrors support", () => {
    const c = statCalc();
    c.prevClose = 104;
    zone(c, "R", 105);
    feed(c, [ohlc(104, 105, 104, 104.5), ohlc(104.5, 104.5, 102.75, 103)]);
    assert.strictEqual(zs(c), "1/1 0/0 0/0");
    const d = statCalc();
    d.prevClose = 104;
    zone(d, "R", 105);
    feed(d, [ohlc(104, 105, 104, 104.5), ohlc(104.5, 107, 104.5, 106.5)]);
    assert.strictEqual(zs(d), "0/1 0/0 0/0");
});

// independent check of the Wilson interval: invert the score test numerically
function scoreInterval(w, n) {
    const z = 1.96;
    const p = w / n;
    const inside = q => Math.abs(p - q) <= z * Math.sqrt(q * (1 - q) / n);
    const edge = (a, b) => {          // a inside, b outside
        for (let i = 0; i < 200; ++i) {
            const m = (a + b) / 2;
            if (inside(m)) { a = m; } else { b = m; }
        }
        return a;
    };
    return { lo: w === 0 ? 0 : edge(p, 0), hi: w === n ? 1 : edge(p, 1) };
}

check("odds: label shows the measured rate, 95% margin and sample size", () => {
    const c = statCalc({ minSamples: 20 });
    const z1 = zone(c, "S", 100);
    const z2 = zone(c, "S", 99);
    z2.tests = 1;
    c.zoneStats = [{ w: 15, n: 25 }, { w: 3, n: 5 }, { w: 0, n: 0 }];
    assert.strictEqual(c.oddsText(z1), "60% reversal ±18 (1st test, n=25)", "no random comparison until it has minSamples");
    c.controlStats = { w: 540, n: 1000 };
    assert.strictEqual(c.oddsText(z1), "60% reversal ±18 vs 54% random (1st test, n=25)");
    assert.strictEqual(c.oddsText(z2), "60% reversal ±17 vs 54% random (all tests, n=30)", "2nd-test bucket too small: all tests");
    c.zoneStats = [{ w: 5, n: 9 }, { w: 3, n: 5 }, { w: 0, n: 0 }];
    assert.strictEqual(c.oddsText(z1), "reversal odds: collecting (n=14)");
    c.props.minSamples = 1;
    [[15, 25], [3, 5], [0, 20], [20, 20], [137, 412]].forEach(([w, n]) => {
        c.zoneStats = [{ w, n }, { w: 0, n: 0 }, { w: 0, n: 0 }];
        const o = c.odds(z1);
        const ref = scoreInterval(w, n);
        assert.ok(Math.abs(o.lo - ref.lo) < 1e-6 && Math.abs(o.hi - ref.hi) < 1e-6,
            w + "/" + n + ": " + o.lo + "-" + o.hi + " vs " + ref.lo + "-" + ref.hi);
    });
});

check("odds: control prices are fixed before the bar, tested only when traded to", () => {
    const c = statCalc();   // bounce 8 ticks: control prices 1..8 ticks from the last close
    const started = [];
    const orig = c.startTest.bind(c);
    c.startTest = (t, b, k, isZone) => { if (!isZone) { started.push([t.side, t.price]); } orig(t, b, k, isZone); };
    let prev = 101;
    let k = 1;
    for (let i = 0; i < 400; ++i) {
        const cl = onTick(prev + (Math.round((rand() - 0.5) * 8)) * TICK);
        const b = ohlc(prev, onTick(Math.max(prev, cl) + TICK), onTick(Math.min(prev, cl) - TICK), cl);
        const before = started.length;
        c.commit(b, k++);
        started.slice(before).forEach(([side, price]) => {
            assert.ok(Math.abs(price / TICK - Math.round(price / TICK)) < 1e-6, "on tick grid");
            const ticksAway = Math.round(Math.abs(price - prev) / TICK);
            assert.ok(ticksAway >= 1 && ticksAway <= 8, "1-8 ticks from the last close: " + ticksAway);
            if (side === "S") {
                assert.ok(price < prev && b.low <= price + TICK, "support control below the close, traded to");
            }
            else {
                assert.ok(price > prev && b.high >= price - TICK, "resistance control above the close, traded to");
            }
        });
        prev = cl;
    }
    assert.ok(started.length > 150, "control tests start only when traded to: " + started.length);

    // the price picked for bar k depends only on the last close and k — not on the bar
    const pick = (b) => {
        const d = statCalc();
        const seen = [];
        const o2 = d.startTest.bind(d);
        d.startTest = (t, bb, kk, isZone) => { if (!isZone) { seen.push(t.side + "@" + t.price); } o2(t, bb, kk, isZone); };
        d.commit(b, 77);
        return seen;
    };
    const wide = pick(ohlc(101, 104, 98, 103));
    const other = pick(ohlc(101, 103.75, 98.25, 98.5));
    assert.strictEqual(wide.length, 2);
    assert.deepStrictEqual(wide, other, "same prices whatever the bar did");
});

check("odds: no lookahead — results up to bar K never depend on later bars", () => {
    seed = 4321;
    const tape = martingaleTape(3000);
    const K = 2000;
    const short = runHistory(tape.slice(0, K)).calc;
    // the long run, frozen right after it maps bar K-1 (the last bar of the short run)
    const calc = makeCalc();
    const ents = [];
    const cursor = { i: 0 };
    const hist = series(ents, cursor);
    tape.forEach((b, idx) => ents.push(entity(b, idx, () => idx === ents.length - 1, {})));
    let frozen = null;
    for (let i = 0; i < ents.length; ++i) {
        cursor.i = i;
        calc.map(ents[i], i, hist);
        if (i === K - 1) {
            frozen = JSON.stringify([calc.zoneStats, calc.controlStats, calc.openTests, calc.openControl]);
        }
    }
    assert.strictEqual(frozen, JSON.stringify([short.zoneStats, short.controlStats, short.openTests, short.openControl]));
    assert.ok(short.zoneTotals().n > 20, "the prefix has zone tests: " + short.zoneTotals().n);
});

function rates(calc) {
    const z = calc.zoneTotals();
    const r = calc.controlStats;
    return { z: z.w / z.n, zn: z.n, r: r.w / r.n, rn: r.n };
}

// Bars cut from a tick-by-tick random walk (30 ticks per bar): OHLC and the
// per-price volume come from the actual path, so price has no memory at all.
function martingaleTape(nBars) {
    const out = [];
    let t = Math.round(21000 / TICK);
    for (let i = 0; i < nBars; ++i) {
        const o = t;
        let h = t;
        let l = t;
        const visits = new Map();
        for (let j = 0; j < 30; ++j) {
            t += rand() < 0.5 ? -1 : 1;
            h = Math.max(h, t);
            l = Math.min(l, t);
            visits.set(t, (visits.get(t) || 0) + 1);
        }
        const profile = [];
        for (let q = l; q <= h; ++q) {
            const vol = 5 * (visits.get(q) || 1);
            const bidVol = Math.round(vol * (0.3 + 0.4 * rand()));
            profile.push({ price: q * TICK, vol, bidVol, askVol: vol - bidVol });
        }
        // resting-order absorption printed at 3% of bar lows/highs — with no
        // effect at all on where price goes next
        if (rand() < 0.03) {
            if (rand() < 0.5 && t - l >= 3) {
                profile[0].bidVol += 600; profile[0].vol += 600;
            }
            else if (h - t >= 3) {
                const top = profile[profile.length - 1];
                top.askVol += 600; top.vol += 600;
            }
        }
        out.push({ o: o * TICK, h: h * TICK, l: l * TICK, c: t * TICK, profile });
    }
    return out;
}

check("odds: on a random walk, zones show NO edge over random prices (3 seeds)", () => {
    [2468, 1111, 9001].forEach(sd => {
        seed = sd;
        const s = rates(runHistory(martingaleTape(20000)).calc);
        const se = Math.sqrt(s.z * (1 - s.z) / s.zn + s.r * (1 - s.r) / s.rn);
        console.log("      random walk (seed " + sd + "): zones " + (100 * s.z).toFixed(1) + "% (n=" + s.zn +
            ") vs random prices " + (100 * s.r).toFixed(1) + "% (n=" + s.rn + ")");
        assert.ok(s.zn >= 300, "enough zone tests: " + s.zn);
        assert.ok(s.rn >= 5000, "enough control tests: " + s.rn);
        assert.ok(Math.abs(s.z - s.r) <= 2.58 * se, "difference within 99% noise band: " + (s.z - s.r).toFixed(3) + " vs " + (2.58 * se).toFixed(3));
    });
});

check("odds: when zones really hold, the measured edge shows up", () => {
    seed = 1357;
    const tape = [];
    const zonesAt = [];
    let c0 = 21000;
    let rally = 0;
    for (let i = 0; i < 8000; ++i) {
        let b;
        if (rally > 0) {
            const cl = onTick(c0 + 5 * TICK);
            b = bar(c0, onTick(cl + TICK), c0, cl, 40);
            rally--;
        }
        else {
            b = randomBar(c0);
            const z = zonesAt.find(p => c0 > p && b.l <= p + TICK && b.l >= p - 4 * TICK);
            if (z !== undefined) {
                // buyers defend the zone: the bar holds at it and the market rallies
                b = bar(b.o, Math.max(b.o, onTick(z + 2 * TICK)), z, onTick(z + 2 * TICK), 40);
                rally = 3;
            }
            else if (rand() < 0.03 && b.c - b.l >= 3 * TICK) {
                b.profile[0].bidVol += 600; b.profile[0].vol += 600;
                zonesAt.push(b.l);
            }
        }
        tape.push(b);
        c0 = b.c;
    }
    const s = rates(runHistory(tape).calc);
    console.log("      defended zones: zones " + (100 * s.z).toFixed(1) + "% (n=" + s.zn + ") vs random prices " +
        (100 * s.r).toFixed(1) + "% (n=" + s.rn + ")");
    assert.ok(s.zn >= 100, "enough zone tests: " + s.zn);
    assert.ok(s.z - s.r >= 0.2, "edge detected");
});

console.log(passed + " checks passed");

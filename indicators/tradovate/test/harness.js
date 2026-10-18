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
let seed = 7;
function rand() {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
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
    assert.ok(texts.some(t => /^S1 21000\.\d\d \| .*bids filled \| held \dx/.test(t)), "S1 label: " + texts.join(" / "));
    assert.ok(texts.some(t => /^R1 21020\.00 \| .*offers filled/.test(t)), "R1 label: " + texts.join(" / "));
    assert.ok(texts.some(t => t.startsWith("Resting Order Levels: footprint")), "status text");
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
    assert.ok(globalContainer(a.out), "levels drawn on the new last bar");
});

check("bar-level fallback when the chart has no per-price profile", () => {
    const { calc, outputs } = runHistory(bars.slice(0, marks.supportBorn + 3), {}, { noProfile: true });
    const s = calc.levels.find(l => l.side === "S" && Math.abs(l.price - 21000) <= 0.25);
    assert.ok(s && s.estimated, "estimated support at the absorption bar low");
    const cont = globalContainer(outputs[outputs.length - 1]);
    const status = cont.children.find(c => c.key === "status").text;
    assert.ok(/bar-level estimate/.test(status), status);
    const lbl = cont.children.find(c => c.tag === "Text" && c.key !== "status").text;
    assert.ok(/\| ~\d/.test(lbl), "estimated fills marked with ~: " + lbl);
});

check("no bid/ask data: draws nothing and says so", () => {
    const { calc, outputs } = runHistory(bars, {}, { noProfile: true, noBidAsk: true });
    assert.strictEqual(calc.levels.length, 0);
    const status = globalContainer(outputs[outputs.length - 1]).children.find(c => c.key === "status").text;
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

console.log(passed + " checks passed");

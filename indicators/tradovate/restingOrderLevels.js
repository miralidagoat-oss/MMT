// Resting Order Levels — support/resistance from filled resting limit orders,
// with the measured odds that each zone makes price reverse.
//
// Tradovate custom indicators cannot read the DOM (Level 2 book). What they CAN
// read is the bar's volume profile: for every price, how many contracts traded
// at the bid and how many at the ask. Volume at the bid is aggressive sellers
// filling RESTING BUY limits; volume at the ask is aggressive buyers filling
// RESTING SELL limits. So the footprint is a record of real resting orders that
// actually got filled — unlike displayed DOM size, it cannot be spoofed/pulled.
//
// A level is created where an unusually large amount of resting orders filled
// at the edge of a bar AND price was rejected away from it (the orders held):
//   support    = big bid fills at/near the low,  bar closes back up
//   resistance = big ask fills at/near the high, bar closes back down
// Levels gain strength every time they hold a retest, decay with age, and are
// removed (or flipped) once a bar CLOSES through them.
//
// Reversal odds are MEASURED on this chart, not assumed: every time price
// comes back to a zone, the indicator records whether price then bounced
// `bounce` away from the zone before going `bounce` through it. The label shows
// that hit rate for the zone's next test, with its sample size and 95% margin,
// and the status line compares all zones against random prices tested the
// same way.
//
// Paste into Tradovate: Code Explorer → New → Indicator, save, then add it to a
// chart from Indicators → (tag) "Order Flow". See README for settings.

const predef = require("./tools/predef");
const meta = require("./tools/meta");
const { px, du, op } = require("./tools/graphics");

const SUPPORT = "S";
const RESISTANCE = "R";
const MAX_TRACKED_PER_SIDE = 40;
const FALLBACK_MIN_WICK = 0.4; // bar-level mode: rejection wick ≥ 40% of range
const TEST_BUCKETS = ["1st test", "2nd test", "3rd+ test"];

// Distance settings set to 0 scale to the average bar range, so one default
// works on ES (≈5-tick 1m bars) and NQ (≈20-tick 1m bars) alike:
// ticks = max(floor, round(fraction × average range in ticks)).
const AUTO_DISTANCE = {
    edgeTicks: [0.2, 2],
    rejectionTicks: [0.25, 2],
    touchTicks: [0.1, 1],
    mergeTicks: [0.25, 2],
    breakTicks: [0.3, 2],
    bounceTicks: [1.5, 4]
};

function decimalsOf(tick) {
    const s = String(tick);
    if (s.indexOf("e-") >= 0) {
        return parseInt(s.split("e-")[1], 10);
    }
    const dot = s.indexOf(".");
    return dot < 0 ? 0 : s.length - dot - 1;
}

function fmtVol(v) {
    if (v >= 10000) {
        return Math.round(v / 1000) + "k";
    }
    if (v >= 1000) {
        return (v / 1000).toFixed(1) + "k";
    }
    return String(Math.round(v));
}

// Wilson score interval (95%) for w wins out of n tests.
function wilson(w, n) {
    const z = 1.96;
    const z2 = z * z;
    const p = w / n;
    const denom = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / denom;
    const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denom;
    return { p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

// Deterministic [0, 1) from a bar index, so the random-price control group is
// identical on every reload instead of changing each time.
function unitHash(k, salt) {
    let h = (Math.imul(k + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// One test = price returned to a price level on bar `start`. It is decided by
// whichever comes first on later CLOSED bars: price `dist` away in the level's
// favor (bounce = 1) or `dist` through it (fail = 0). Bar data can't show what
// happened first inside a bar, so: on the touch bar only a fail can count, and a
// bar that reaches both sides counts as a fail. No decision within `horizon`
// bars counts as a fail. Returns -1 while undecided.
function decide(t, bar, k, horizon, eps) {
    const up = t.side === SUPPORT;
    const failed = up ? bar.low <= t.price - t.dist + eps : bar.high >= t.price + t.dist - eps;
    if (failed) {
        return 0;
    }
    if (k > t.start) {
        const bounced = up ? bar.high >= t.price + t.dist - eps : bar.low <= t.price - t.dist + eps;
        if (bounced) {
            return 1;
        }
    }
    return k - t.start >= horizon ? 0 : -1;
}

// Snapshot of one bar as plain data (the profile array is kept by reference).
function readBar(d) {
    const profile = typeof d.profile === "function" ? d.profile() : undefined;
    return {
        open: d.open(),
        high: d.high(),
        low: d.low(),
        close: d.close(),
        volume: d.volume() || 0,
        bidVol: d.bidVolume() || 0,
        askVol: d.offerVolume() || 0,
        profile: profile && profile.length ? profile : null
    };
}

class restingOrderLevels {
    init() {
        this.levels = [];
        this.committed = -1;      // last bar index folded into the level state
        this.baseLevel = 0;       // EMA: one-sided volume per price level
        this.baseBar = 0;         // EMA: one-sided volume per bar (no-profile mode)
        this.baseRange = 0;       // EMA: bar range in ticks (auto distances)
        this.baseCount = 0;
        this.nextId = 1;
        this.profileBars = 0;
        this.barLevelBars = 0;
        // reversal statistics, all from closed bars
        this.openTests = [];      // retests of zones still waiting for an outcome
        this.openControl = [];    // the same test at random prices (control group)
        this.zoneStats = TEST_BUCKETS.map(() => ({ w: 0, n: 0 }));
        this.controlStats = { w: 0, n: 0 };
        this.distUsed = null;     // [smallest, largest] reversal distance among counted zone tests
        this.prevClose = null;
    }

    tick() {
        return (this.contractInfo && this.contractInfo.tickSize) || 0.25;
    }

    // Effective distance in ticks for one of the AUTO_DISTANCE settings.
    ticks(name) {
        const set = this.props[name];
        if (set > 0) {
            return set;
        }
        const auto = AUTO_DISTANCE[name];
        return Math.max(auto[1], Math.round(auto[0] * this.baseRange));
    }

    warmedUp() {
        return this.baseCount >= this.props.baselineBars / 2;
    }

    // Pure: where did unusually large resting orders fill and hold on this bar?
    // Uses only the baseline from bars BEFORE this one, so a huge bar cannot
    // inflate its own threshold.
    detect(bar) {
        const p = this.props;
        const tick = this.tick();
        const eps = tick * 0.25;
        const reject = this.ticks("rejectionTicks") * tick - eps;
        const out = { support: null, resistance: null };
        if (!this.warmedUp() || bar.high - bar.low < tick - eps) {
            return out;
        }

        if (bar.profile) {
            const threshold = Math.max(p.absorptionMultiple * this.baseLevel, p.minContracts, 1);
            const edge = this.ticks("edgeTicks");
            const lowZoneTop = bar.low + (edge - 1) * tick + eps;
            const highZoneBottom = bar.high - (edge - 1) * tick - eps;
            let sPeak = 0, sPrice = 0, sSum = 0;
            let rPeak = 0, rPrice = 0, rSum = 0;
            for (let j = 0; j < bar.profile.length; ++j) {
                const lvl = bar.profile[j];
                if (lvl.price <= lowZoneTop) {
                    sSum += lvl.bidVol;
                    if (lvl.bidVol > sPeak) {
                        sPeak = lvl.bidVol;
                        sPrice = lvl.price;
                    }
                }
                if (lvl.price >= highZoneBottom) {
                    rSum += lvl.askVol;
                    if (lvl.askVol > rPeak) {
                        rPeak = lvl.askVol;
                        rPrice = lvl.price;
                    }
                }
            }
            if (sPeak >= threshold && bar.close - sPrice >= reject) {
                out.support = { price: sPrice, vol: sSum, peak: sPeak, estimated: false };
            }
            if (rPeak >= threshold && rPrice - bar.close >= reject) {
                out.resistance = { price: rPrice, vol: rSum, peak: rPeak, estimated: false };
            }
            return out;
        }

        // No per-price data: whole-bar bid/ask volume plus a rejection wick.
        // Coarser — the fills are assumed to sit at the bar extreme.
        const range = bar.high - bar.low;
        const threshold = Math.max(p.barModeMultiple * this.baseBar, p.minContracts, 1);
        const lowerWick = Math.min(bar.open, bar.close) - bar.low;
        const upperWick = bar.high - Math.max(bar.open, bar.close);
        if (bar.bidVol >= threshold && lowerWick >= FALLBACK_MIN_WICK * range &&
            bar.close - bar.low >= reject) {
            out.support = { price: bar.low, vol: bar.bidVol, peak: bar.bidVol, estimated: true };
        }
        if (bar.askVol >= threshold && upperWick >= FALLBACK_MIN_WICK * range &&
            bar.high - bar.close >= reject) {
            out.resistance = { price: bar.high, vol: bar.askVol, peak: bar.askVol, estimated: true };
        }
        return out;
    }

    // Resting-order fills near `price` on the side that defends the level.
    fillsNear(bar, side, price) {
        if (!bar.profile) {
            return 0;
        }
        const tick = this.tick();
        const band = this.ticks("touchTicks") * tick + tick * 0.25;
        let sum = 0;
        for (let j = 0; j < bar.profile.length; ++j) {
            const lvl = bar.profile[j];
            if (Math.abs(lvl.price - price) <= band) {
                sum += side === SUPPORT ? lvl.bidVol : lvl.askVol;
            }
        }
        return sum;
    }

    // Advance open tests by one closed bar; tally the ones that got decided and
    // note their zones in `decided` (that bar can't also start their next test).
    settleTests(list, bar, k, isZone, decided) {
        const eps = this.tick() * 0.25;
        const horizon = this.props.horizonBars;
        const open = [];
        for (let j = 0; j < list.length; ++j) {
            const t = list[j];
            const result = decide(t, bar, k, horizon, eps);
            if (result < 0) {
                open.push(t);
            }
            else {
                this.tally(t, result, isZone);
                decided[t.id] = true;
            }
        }
        return open;
    }

    tally(t, won, isZone) {
        const s = isZone ? this.zoneStats[t.bucket] : this.controlStats;
        s.n++;
        s.w += won;
        if (isZone) {
            this.distUsed = this.distUsed
                ? [Math.min(this.distUsed[0], t.dist), Math.max(this.distUsed[1], t.dist)]
                : [t.dist, t.dist];
        }
    }

    // Start a test on bar k; it may already fail on that bar (deep wick through).
    startTest(t, bar, k, isZone) {
        const result = decide(t, bar, k, this.props.horizonBars, this.tick() * 0.25);
        if (result < 0) {
            (isZone ? this.openTests : this.openControl).push(t);
        }
        else {
            this.tally(t, result, isZone);
        }
    }

    // Fold one CLOSED bar into the level state and the reversal statistics.
    commit(bar, k) {
        const p = this.props;
        const tick = this.tick();
        const eps = tick * 0.25;
        const breakDist = this.ticks("breakTicks") * tick;
        const touch = this.ticks("touchTicks") * tick + eps;
        const merge = this.ticks("mergeTicks") * tick + eps;
        const bounce = this.ticks("bounceTicks") * tick;
        const decay = p.halfLifeBars > 0 ? Math.pow(0.5, 1 / p.halfLifeBars) : 1;

        if (bar.profile) {
            this.profileBars++;
        }
        else {
            this.barLevelBars++;
        }

        // 0) decide earlier tests with this bar, then remember which zones were
        //    live coming into it (a zone this bar breaks still counts as tested)
        const decided = {};
        this.openTests = this.settleTests(this.openTests, bar, k, true, decided);
        this.openControl = this.settleTests(this.openControl, bar, k, false, {});
        const liveAtOpen = this.levels.map(lvl => ({ id: lvl.id, side: lvl.side, price: lvl.price, tests: lvl.tests || 0 }));

        // levels already updated by this bar (skip them in the retest pass)
        const handled = {};

        // 1) age, then breaks: a CLOSE beyond the level means its orders were consumed
        const survivors = [];
        for (let j = 0; j < this.levels.length; ++j) {
            const lvl = this.levels[j];
            lvl.strength *= decay;
            const broken = lvl.side === SUPPORT
                ? bar.close <= lvl.price - breakDist
                : bar.close >= lvl.price + breakDist;
            if (!broken) {
                survivors.push(lvl);
            }
            else if (p.flipBrokenLevels && !lvl.flipped) {
                lvl.side = lvl.side === SUPPORT ? RESISTANCE : SUPPORT;
                lvl.flipped = true;
                lvl.holds = 0;
                lvl.tests = 0;
                lvl.strength *= 0.5;
                lvl.lastTest = k;
                handled[lvl.id] = true; // the breaking bar is not a retest of the new side
                survivors.push(lvl);
            }
        }
        this.levels = survivors;

        // 2) new absorption: merge into a nearby same-side level or start a new one
        const found = this.detect(bar);
        const candidates = [[SUPPORT, found.support], [RESISTANCE, found.resistance]];
        for (let c = 0; c < candidates.length; ++c) {
            const side = candidates[c][0];
            const cand = candidates[c][1];
            if (!cand) {
                continue;
            }
            let target = null;
            for (let j = 0; j < this.levels.length; ++j) {
                const lvl = this.levels[j];
                if (lvl.side === side && Math.abs(lvl.price - cand.price) <= merge &&
                    (!target || Math.abs(lvl.price - cand.price) < Math.abs(target.price - cand.price))) {
                    target = lvl;
                }
            }
            if (target) {
                // Re-defended: drift toward where the bigger fills are, on tick
                const w = target.filled + cand.vol;
                target.price = Math.round((target.price * target.filled + cand.price * cand.vol) / w / tick) * tick;
                target.filled = w;
                target.strength += cand.vol;
                target.holds++;
                target.lastTest = k;
                target.estimated = target.estimated && cand.estimated;
                handled[target.id] = true;
            }
            else {
                this.levels.push({
                    id: this.nextId++,
                    side,
                    price: cand.price,
                    born: k,
                    lastTest: k,
                    filled: cand.vol,
                    strength: cand.vol,
                    holds: 0,
                    tests: 0,
                    flipped: false,
                    estimated: cand.estimated
                });
                handled[this.nextId - 1] = true;
            }
        }

        // 3) retests that held (traded into the level, closed back on the right side)
        for (let j = 0; j < this.levels.length; ++j) {
            const lvl = this.levels[j];
            if (handled[lvl.id]) {
                continue;
            }
            const held = lvl.side === SUPPORT
                ? bar.low <= lvl.price + touch && bar.close > lvl.price
                : bar.high >= lvl.price - touch && bar.close < lvl.price;
            if (held) {
                const add = this.fillsNear(bar, lvl.side, lvl.price);
                lvl.filled += add;
                lvl.strength += add;
                lvl.holds++;
                lvl.lastTest = k;
            }
        }

        // 4) reversal tests: every zone that was live when this bar opened, that price
        //    came into from the zone's side and that this bar touched starts a test
        //    (one open test per zone at a time; never on the bar that decided its last
        //    one, so a single price move is never counted twice)
        liveAtOpen.forEach(z => {
            const touched = z.side === SUPPORT ? bar.low <= z.price + touch : bar.high >= z.price - touch;
            const approached = this.prevClose !== null &&
                (z.side === SUPPORT ? z.price < this.prevClose - eps : z.price > this.prevClose + eps);
            if (!touched || !approached || decided[z.id] || this.openTests.some(t => t.id === z.id && t.side === z.side)) {
                return;
            }
            const testNo = z.tests + 1;
            const lvl = this.levels.find(l => l.id === z.id);
            if (lvl && lvl.side === z.side) {
                lvl.tests = testNo;    // a level flipped by this bar restarts its count
            }
            this.startTest({
                id: z.id,
                side: z.side,
                price: z.price,
                dist: bounce,
                start: k,
                bucket: Math.min(testNo, TEST_BUCKETS.length) - 1
            }, bar, k, true);
        });

        // 5) control group: two random prices fixed BEFORE this bar opens (up to one
        //    bounce distance below and above the last close). Like a zone, each
        //    starts a test only if this bar trades to it. Picking prices after
        //    seeing the bar would favor bars that already bounced, so don't.
        if (this.warmedUp() && this.prevClose !== null) {
            const steps = Math.max(1, Math.round(bounce / tick));
            const below = this.prevClose - (1 + Math.floor(unitHash(k, 1) * steps)) * tick;
            const above = this.prevClose + (1 + Math.floor(unitHash(k, 2) * steps)) * tick;
            if (bar.low <= below + touch) {
                this.startTest({ id: 0, side: SUPPORT, price: below, dist: bounce, start: k, bucket: 0 }, bar, k, false);
            }
            if (bar.high >= above - touch) {
                this.startTest({ id: 0, side: RESISTANCE, price: above, dist: bounce, start: k, bucket: 0 }, bar, k, false);
            }
        }
        this.prevClose = bar.close;

        // 6) prune idle levels and cap each side, weakest first
        const keep = this.levels.filter(lvl => k - lvl.lastTest <= p.maxIdleBars);
        const capped = [];
        [SUPPORT, RESISTANCE].forEach(side => {
            keep.filter(lvl => lvl.side === side)
                .sort((a, b) => b.strength - a.strength)
                .slice(0, MAX_TRACKED_PER_SIDE)
                .forEach(lvl => capped.push(lvl));
        });
        this.levels = capped;

        // 7) baselines update AFTER detection
        const alpha = 2 / (p.baselineBars + 1);
        const priceLevels = bar.profile
            ? bar.profile.length
            : Math.max(1, Math.round((bar.high - bar.low) / tick) + 1);
        const perLevel = bar.volume / priceLevels / 2;
        const perBar = (bar.bidVol + bar.askVol) / 2;
        const rangeTicks = (bar.high - bar.low) / tick;
        if (this.baseCount === 0) {
            this.baseLevel = perLevel;
            this.baseBar = perBar;
            this.baseRange = rangeTicks;
        }
        else {
            this.baseLevel += alpha * (perLevel - this.baseLevel);
            this.baseBar += alpha * (perBar - this.baseBar);
            this.baseRange += alpha * (rangeTicks - this.baseRange);
        }
        this.baseCount++;
    }

    // Measured bounce odds for this zone's next (or current) test.
    odds(lvl) {
        const open = this.openTests.some(t => t.id === lvl.id && t.side === lvl.side);
        const testNo = Math.max(1, (lvl.tests || 0) + (open ? 0 : 1));
        const b = Math.min(testNo, TEST_BUCKETS.length) - 1;
        const min = this.props.minSamples;
        const bucket = this.zoneStats[b];
        if (bucket.n >= min) {
            return Object.assign(wilson(bucket.w, bucket.n), { n: bucket.n, scope: TEST_BUCKETS[b] });
        }
        const all = this.zoneTotals();
        if (all.n >= min) {
            return Object.assign(wilson(all.w, all.n), { n: all.n, scope: "all tests" });
        }
        return { collecting: true, n: all.n };
    }

    zoneTotals() {
        return this.zoneStats.reduce((a, s) => ({ w: a.w + s.w, n: a.n + s.n }), { w: 0, n: 0 });
    }

    // Which levels to draw, numbered nearest-first (S1 = closest support).
    visibleLevels(live) {
        const n = this.props.levelsPerSide;
        const pick = side => this.levels
            .filter(lvl => lvl.side === side)
            .sort((a, b) => b.strength - a.strength)
            .slice(0, n);
        const supports = pick(SUPPORT).sort((a, b) => b.price - a.price);
        const resistances = pick(RESISTANCE).sort((a, b) => a.price - b.price);
        const tick = this.tick();
        const touch = this.ticks("touchTicks") * tick + tick * 0.25;
        const breakDist = this.ticks("breakTicks") * tick;
        const tag = (lvl, i) => {
            let status = "";
            if (lvl.side === SUPPORT) {
                if (live.close <= lvl.price - breakDist) {
                    status = "BREAKING";
                }
                else if (live.low <= lvl.price + touch) {
                    status = "TESTING";
                }
            }
            else if (live.close >= lvl.price + breakDist) {
                status = "BREAKING";
            }
            else if (live.high >= lvl.price - touch) {
                status = "TESTING";
            }
            return { lvl, name: lvl.side + (i + 1), status };
        };
        return supports.map(tag).concat(resistances.map(tag));
    }

    oddsText(lvl) {
        const o = this.odds(lvl);
        if (o.collecting) {
            return "reversal odds: collecting (n=" + o.n + ")";
        }
        const margin = Math.round(100 * (o.hi - o.lo) / 2);
        const ctrl = this.controlStats;
        // the same measurement at random prices: a zone only matters by how much it beats this
        const vs = ctrl.n >= this.props.minSamples ? " vs " + Math.round(100 * ctrl.w / ctrl.n) + "% random" : "";
        return Math.round(100 * o.p) + "% reversal ±" + margin + vs + " (" + o.scope + ", n=" + o.n + ")";
    }

    label(entry, decimals) {
        const lvl = entry.lvl;
        const parts = [entry.name + " " + lvl.price.toFixed(decimals) + (lvl.flipped ? " (flipped)" : "")];
        if (this.props.showOdds) {
            parts.push(this.oddsText(lvl));
        }
        parts.push((lvl.estimated ? "~" : "") + fmtVol(lvl.filled) + (lvl.side === SUPPORT ? " bid fills" : " offer fills"));
        parts.push(lvl.holds > 0 ? "held " + lvl.holds + "x" : "new");
        if (entry.status) {
            parts.push("<< " + entry.status);
        }
        return parts.join(" | ");
    }

    statusLines(shown, live, decimals) {
        let mode = "footprint (per-price bid/ask fills)";
        if (this.profileBars === 0 && this.barLevelBars > 0) {
            mode = live.bidVol + live.askVol > 0
                ? "bar-level estimate - no per-price data on this chart"
                : "NO bid/ask volume on this chart";
        }
        const nS = shown.filter(e => e.lvl.side === SUPPORT).length;
        const lines = ["Resting Order Levels: " + mode + "  |  " + nS + " S / " + (shown.length - nS) + " R  |  edge " +
            this.ticks("edgeTicks") + "t, touch " + this.ticks("touchTicks") + "t, break " + this.ticks("breakTicks") + "t"];
        if (this.props.showOdds) {
            const rate = s => s.n ? Math.round(100 * s.w / s.n) + "% ±" +
                Math.round(100 * (wilson(s.w, s.n).hi - wilson(s.w, s.n).lo) / 2) + " (n=" + s.n + ")" : "no tests yet";
            const now = (this.ticks("bounceTicks") * this.tick()).toFixed(decimals);
            // in auto mode the distance follows the average bar range, so say which distances the counts used
            const move = this.props.bounceTicks > 0
                ? now + " in favor before " + now + " against"
                : "1.5x avg bar range (now " + now + (this.distUsed ? ", " + this.distUsed[0].toFixed(decimals) + "-" +
                    this.distUsed[1].toFixed(decimals) + " in the counted tests" : "") + ") in favor before the same against";
            lines.push("Reversal = " + move + ", within " + this.props.horizonBars +
                " bars  |  zones " + rate(this.zoneTotals()) + "  vs  random prices " + rate(this.controlStats));
        }
        return lines;
    }

    graphicsFor(live, i, xOff, found) {
        const p = this.props;
        const items = [];

        if (p.showAbsorptionDots) {
            const dots = [];
            if (found.support) {
                dots.push([found.support.price, p.supportColor]);
            }
            if (found.resistance) {
                dots.push([found.resistance.price, p.resistanceColor]);
            }
            dots.forEach((dot, n) => items.push({
                tag: "Shapes",
                key: "absorb" + n,
                primitives: [{
                    tag: "Circle",
                    radius: 3,
                    center: { x: du(i + xOff), y: du(dot[0]) }
                }],
                fillStyle: { color: dot[1] }
            }));
        }

        if (!live.isLast) {
            return items;
        }

        const decimals = decimalsOf(this.tick());
        const shown = this.visibleLevels(live);
        const maxStrength = shown.reduce((m, e) => Math.max(m, e.lvl.strength), 0) || 1;
        const children = [];
        shown.forEach(entry => {
            const lvl = entry.lvl;
            const color = lvl.side === SUPPORT ? p.supportColor : p.resistanceColor;
            const width = entry.status ? 4 : 1 + Math.round(2 * lvl.strength / maxStrength);
            children.push({
                tag: "LineSegments",
                key: "line" + lvl.id,
                lines: [{
                    tag: "Line",
                    a: { x: du(lvl.born + xOff), y: du(lvl.price) },
                    b: { x: du(i + xOff), y: du(lvl.price) },
                    infiniteEnd: true
                }],
                lineStyle: { lineWidth: width, color, lineStyle: lvl.flipped ? 3 : 1 }
            });
            if (p.showLabels) {
                children.push({
                    tag: "Text",
                    key: "label" + lvl.id,
                    point: { x: op(du(i + xOff), "+", px(p.labelOffsetPx)), y: du(lvl.price) },
                    text: this.label(entry, decimals),
                    style: { fontSize: 11, fontWeight: "bold", fill: color },
                    textAlignment: p.labelAlignment
                });
            }
        });

        if (p.showStatus) {
            this.statusLines(shown, live, decimals).forEach((text, n) => children.push({
                tag: "Text",
                key: "status" + n,
                point: { x: px(10), y: px(14 + 16 * n) },
                text,
                style: { fontSize: 11, fill: "#9aa4b2" },
                // follow the user's alignment fix so the corner text stays on-screen
                textAlignment: p.labelAlignment === "leftAbove" ? "leftBelow" : "rightBelow"
            }));
        }

        items.push({ tag: "Container", key: "restingOrderLevels", children, global: true });
        return items;
    }

    map(d, i, history) {
        // Fold every closed bar we have not seen yet. Guarding by index makes
        // repeated calls on the live bar (one per tick) idempotent, and keeps the
        // live bar out of the statistics until it closes.
        for (let k = this.committed + 1; k < i; ++k) {
            const e = k === i - 1 ? history.prior() : history.get(k);
            this.commit(readBar(e), k);
        }
        this.committed = Math.max(this.committed, i - 1);

        const live = readBar(d);
        live.isLast = typeof d.isLast === "function" ? d.isLast() : i === history.size() - 1;
        const xOff = typeof d.index === "function" ? d.index() - i : 0;
        const found = this.detect(live);
        const items = this.graphicsFor(live, i, xOff, found);
        return {
            graphics: items.length ? { items } : undefined
        };
    }
}

module.exports = {
    name: "restingOrderLevels",
    description: "Resting Order Levels (S/R)",
    calculator: restingOrderLevels,
    inputType: meta.InputType.BARS,
    areaChoice: meta.AreaChoice.OVERLAY,
    requirements: {
        volumeProfiles: true
    },
    params: {
        absorptionMultiple: predef.paramSpecs.number(3, 0.5, 0.5),
        minContracts: predef.paramSpecs.number(0, 10, 0),
        // distances in ticks; 0 = auto (scaled to the average bar range)
        edgeTicks: predef.paramSpecs.number(0, 1, 0),
        rejectionTicks: predef.paramSpecs.number(0, 1, 0),
        mergeTicks: predef.paramSpecs.number(0, 1, 0),
        touchTicks: predef.paramSpecs.number(0, 1, 0),
        breakTicks: predef.paramSpecs.number(0, 1, 0),
        flipBrokenLevels: predef.paramSpecs.bool(false),
        halfLifeBars: predef.paramSpecs.number(300, 10, 0),
        maxIdleBars: predef.paramSpecs.number(1000, 50, 10),
        levelsPerSide: predef.paramSpecs.number(5, 1, 1),
        baselineBars: predef.paramSpecs.period(50),
        barModeMultiple: predef.paramSpecs.number(1.8, 0.1, 0.5),
        // reversal odds: bounce distance in ticks (0 = auto, 1.5× average bar range)
        showOdds: predef.paramSpecs.bool(true),
        bounceTicks: predef.paramSpecs.number(0, 1, 0),
        horizonBars: predef.paramSpecs.number(60, 5, 5),
        minSamples: predef.paramSpecs.number(20, 5, 5),
        showLabels: predef.paramSpecs.bool(true),
        showAbsorptionDots: predef.paramSpecs.bool(true),
        showStatus: predef.paramSpecs.bool(true),
        labelAlignment: predef.paramSpecs.enum({
            rightAbove: "Right of last bar",
            leftAbove: "Left of last bar",
            centerAbove: "Centered"
        }, "rightAbove"),
        labelOffsetPx: predef.paramSpecs.number(8, 1, 0),
        supportColor: predef.paramSpecs.color("#26a69a"),
        resistanceColor: predef.paramSpecs.color("#ef5350")
    },
    tags: ["Order Flow"]
};

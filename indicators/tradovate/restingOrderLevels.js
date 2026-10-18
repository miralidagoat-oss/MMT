// Resting Order Levels — support/resistance from filled resting limit orders
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
// Paste into Tradovate: Code Explorer → New → Indicator, save, then add it to a
// chart from Indicators → (tag) "Order Flow". See README for settings.

const predef = require("./tools/predef");
const meta = require("./tools/meta");
const { px, du, op } = require("./tools/graphics");

const SUPPORT = "S";
const RESISTANCE = "R";
const MAX_TRACKED_PER_SIDE = 40;
const FALLBACK_MIN_WICK = 0.4; // bar-level mode: rejection wick ≥ 40% of range

// Distance settings set to 0 scale to the average bar range, so one default
// works on ES (≈5-tick 1m bars) and NQ (≈20-tick 1m bars) alike:
// ticks = max(floor, round(fraction × average range in ticks)).
const AUTO_DISTANCE = {
    edgeTicks: [0.2, 2],
    rejectionTicks: [0.25, 2],
    touchTicks: [0.1, 1],
    mergeTicks: [0.25, 2],
    breakTicks: [0.3, 2]
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

    // Pure: where did unusually large resting orders fill and hold on this bar?
    // Uses only the baseline from bars BEFORE this one, so a huge bar cannot
    // inflate its own threshold.
    detect(bar) {
        const p = this.props;
        const tick = this.tick();
        const eps = tick * 0.25;
        const reject = this.ticks("rejectionTicks") * tick - eps;
        const out = { support: null, resistance: null };
        if (this.baseCount < p.baselineBars / 2 || bar.high - bar.low < tick - eps) {
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

    // Fold one CLOSED bar into the level state.
    commit(bar, k) {
        const p = this.props;
        const tick = this.tick();
        const eps = tick * 0.25;
        const breakDist = this.ticks("breakTicks") * tick;
        const touch = this.ticks("touchTicks") * tick + eps;
        const merge = this.ticks("mergeTicks") * tick + eps;
        const decay = p.halfLifeBars > 0 ? Math.pow(0.5, 1 / p.halfLifeBars) : 1;

        if (bar.profile) {
            this.profileBars++;
        }
        else {
            this.barLevelBars++;
        }

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

        // 4) prune idle levels and cap each side, weakest first
        const keep = this.levels.filter(lvl => k - lvl.lastTest <= p.maxIdleBars);
        const capped = [];
        [SUPPORT, RESISTANCE].forEach(side => {
            keep.filter(lvl => lvl.side === side)
                .sort((a, b) => b.strength - a.strength)
                .slice(0, MAX_TRACKED_PER_SIDE)
                .forEach(lvl => capped.push(lvl));
        });
        this.levels = capped;

        // 5) baselines update AFTER detection
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

    label(entry, decimals) {
        const lvl = entry.lvl;
        const parts = [
            entry.name + " " + lvl.price.toFixed(decimals) + (lvl.flipped ? " (flipped)" : ""),
            (lvl.estimated ? "~" : "") + fmtVol(lvl.filled) + (lvl.side === SUPPORT ? " bids filled" : " offers filled"),
            lvl.holds > 0 ? "held " + lvl.holds + "x" : "new"
        ];
        if (entry.status) {
            parts.push("<< " + entry.status);
        }
        return parts.join(" | ");
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
            let mode = "footprint (per-price bid/ask fills)";
            if (this.profileBars === 0 && this.barLevelBars > 0) {
                mode = live.bidVol + live.askVol > 0
                    ? "bar-level estimate - no per-price data on this chart"
                    : "NO bid/ask volume on this chart";
            }
            const nS = shown.filter(e => e.lvl.side === SUPPORT).length;
            const dists = "edge " + this.ticks("edgeTicks") + "t, touch " + this.ticks("touchTicks") +
                "t, break " + this.ticks("breakTicks") + "t";
            children.push({
                tag: "Text",
                key: "status",
                point: { x: px(10), y: px(14) },
                text: "Resting Order Levels: " + mode + "  |  " + nS + " S / " + (shown.length - nS) + " R  |  " + dists,
                style: { fontSize: 11, fill: "#9aa4b2" },
                // follow the user's alignment fix so the corner text stays on-screen
                textAlignment: p.labelAlignment === "leftAbove" ? "leftBelow" : "rightBelow"
            });
        }

        items.push({ tag: "Container", key: "restingOrderLevels", children, global: true });
        return items;
    }

    map(d, i, history) {
        // Fold every closed bar we have not seen yet. Guarding by index makes
        // repeated calls on the live bar (one per tick) idempotent.
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

// Liquidity Regime Meter — is the market DEEP or THIN right now, and do your
// resting-order zones reverse more often in one state than the other?
// Every number it shows is counted on this chart.
//
// IMPACT. Over the last `impactWindow` closed bars of this session, the meter
// regresses each bar's price change (ticks) on its net aggressive volume
// (volume at the ask minus volume at the bid), after clipping outliers at
// ±4 robust standard deviations of that same window. The slope is how many
// ticks price moved per contract of net aggression (Kyle's lambda), shown per
// 100 contracts; R² is how much of the price change that net flow explains.
// The slope is ranked against readings taken at the same clock time (±10
// minutes, New York time) in prior sessions, because liquidity follows the
// clock (thin overnight, deep after the open):
//   DEEP   = bottom third: aggression is getting absorbed
//   NORMAL = middle third
//   THIN   = top third: aggression moves price further than usual
//
// ODDS. The meter re-detects the zones of Resting Order Levels with identical
// rules and defaults, and runs the identical reversal test every time price
// comes back to one: did price move `bounce` away in the zone's favor before
// `bounce` through it, within `horizonBars`? Each test is filed under the state
// that was in force when price came back, so you see your REAL zones' reversal
// rate per state, with a 95% margin that treats each session as one unit. The
// same test at random prices is shown next to it as the baseline, and the
// DEEP-minus-THIN gap is checked at equal volatility and against a volume-only
// liquidity measure (Amihud) that ignores the bid/ask split. The verdict says
// what predicts zone reversals on this chart — never why.
//
// Paste into Tradovate: Code Explorer → New → Indicator, save, then add it to a
// chart from Indicators → (tag) "Order Flow". It opens in its own panel.

const predef = require("./tools/predef");
const meta = require("./tools/meta");
const { px } = require("./tools/graphics");

const SUPPORT = "S";
const RESISTANCE = "R";
const MAX_TRACKED_PER_SIDE = 40;
const FALLBACK_MIN_WICK = 0.4; // bar-level mode: rejection wick ≥ 40% of range

// Distance settings set to 0 scale to the average bar range (same as Resting
// Order Levels): ticks = max(floor, round(fraction × average range in ticks)).
const AUTO_DISTANCE = {
    edgeTicks: [0.2, 2],
    rejectionTicks: [0.25, 2],
    touchTicks: [0.1, 1],
    mergeTicks: [0.25, 2],
    breakTicks: [0.3, 2],
    bounceTicks: [1.5, 4]
};

const STATES = ["DEEP", "NORMAL", "THIN"];
const VOL_THIRDS = ["calm", "mid", "volatile"];
const SLOT_MINUTES = 5;       // clock slots of 5 minutes, New York time
const SLOTS = 288;
const SLOT_REACH = 2;         // rank against prior sessions' readings within ±2 slots (±10 min)
const MIN_POOLED = 9;         // ...and only once at least 9 such readings exist
const CLIP_MADS = 4;          // clip at median ± 4 robust standard deviations of the window
const LINE_CHARS = 110;       // wrap text lines so they fit a normal chart panel
// two-sided 95% Student t quantiles, df = 1..30
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
    2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];

// Settings that change what is measured; any change from these marks results in-sample.
const DEFAULTS = {
    impactWindow: 30,
    r2Gate: 0.05,
    minPriorSessions: 3,
    poolSessions: 20,
    minSessions: 6,
    minTests: 30,
    minStratumN: 10,
    absorptionMultiple: 3,
    minContracts: 0,
    edgeTicks: 0,
    rejectionTicks: 0,
    mergeTicks: 0,
    touchTicks: 0,
    breakTicks: 0,
    flipBrokenLevels: false,
    halfLifeBars: 300,
    maxIdleBars: 1000,
    baselineBars: 50,
    barModeMultiple: 1.8,
    bounceTicks: 0,
    horizonBars: 60
};

function decimalsOf(tick) {
    const s = String(tick);
    if (s.indexOf("e-") >= 0) {
        return parseInt(s.split("e-")[1], 10);
    }
    const dot = s.indexOf(".");
    return dot < 0 ? 0 : s.length - dot - 1;
}

// Deterministic [0, 1) from a bar index (identical to Resting Order Levels).
function unitHash(k, salt) {
    let h = (Math.imul(k + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// The reversal test of Resting Order Levels, also saying HOW it was decided.
// Price returned to `t.price` on bar `t.start`; on later CLOSED bars, whichever
// comes first: `dist` in the level's favor = "win", `dist` through it = a fail.
// The touch bar can only fail; a bar reaching both sides is a fail ("both");
// nothing within `horizon` bars is a fail ("timeout"). "open" = undecided.
function outcome(t, bar, k, horizon, eps) {
    const up = t.side === SUPPORT;
    const failed = up ? bar.low <= t.price - t.dist + eps : bar.high >= t.price + t.dist - eps;
    const bounced = k > t.start &&
        (up ? bar.high >= t.price + t.dist - eps : bar.low <= t.price - t.dist + eps);
    if (failed) {
        return bounced ? "both" : "through";
    }
    if (bounced) {
        return "win";
    }
    return k - t.start >= horizon ? "timeout" : "open";
}

// US Eastern offset (hours) for a UTC time: DST from the second Sunday of March
// 07:00 UTC to the first Sunday of November 06:00 UTC. Independent of the
// computer's own time zone.
function nthSunday(year, month, n) {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return 1 + (7 - first) % 7 + 7 * (n - 1);
}

function etOffsetHours(ms) {
    const y = new Date(ms).getUTCFullYear();
    const start = Date.UTC(y, 2, nthSunday(y, 2, 2), 7);
    const end = Date.UTC(y, 10, nthSunday(y, 10, 1), 6);
    return ms >= start && ms < end ? -4 : -5;
}

function etMinutes(ms) {
    const et = new Date(ms + etOffsetHours(ms) * 3600000);
    return et.getUTCHours() * 60 + et.getUTCMinutes();
}

// 5-minute clock slot (0-287) in New York time.
function slotOf(ms) {
    return Number.isFinite(ms) ? Math.floor(etMinutes(ms) / SLOT_MINUTES) : 0;
}

function clockText(minutes) {
    const m = ((minutes % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}

// The clock span ranked against for a slot, e.g. "09:20-09:45 ET".
function spanText(slot) {
    return clockText((slot - SLOT_REACH) * SLOT_MINUTES) + "-" +
        clockText((slot + SLOT_REACH + 1) * SLOT_MINUTES) + " ET";
}

// CME trade date when the bar has no tradeDate(): the session rolls at 18:00 ET.
function etTradeDate(ms) {
    const d = new Date(ms + (etOffsetHours(ms) + 6) * 3600000);
    return d.getUTCFullYear() + "-" + (d.getUTCMonth() + 1) + "-" + d.getUTCDate();
}

// Percentile of x within an ascending array: mid-rank with ties counted half,
// on the (rank + ½) / (N + 1) scale so it is never exactly 0 or 100.
function midrank(sorted, x) {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (sorted[m] < x) {
            lo = m + 1;
        }
        else {
            hi = m;
        }
    }
    const less = lo;
    hi = sorted.length;
    while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (sorted[m] <= x) {
            lo = m + 1;
        }
        else {
            hi = m;
        }
    }
    return 100 * (less + 0.5 * (lo - less) + 0.5) / (sorted.length + 1);
}

function tercile(pct) {
    return pct < 100 / 3 ? 0 : pct >= 200 / 3 ? 2 : 1;
}

// Whole-number percentile that never contradicts its third (DEEP ≤ 33, THIN ≥ 67).
function shownPct(pct, third) {
    const lim = [[1, 33], [34, 66], [67, 99]][third];
    return Math.min(lim[1], Math.max(lim[0], Math.round(pct)));
}

// Two-sided 95% t quantile; Cornish-Fisher expansion beyond the table.
function tCrit(df) {
    if (!(df >= 1)) {
        return NaN;
    }
    if (df <= T95.length) {
        return T95[df - 1];
    }
    const z = 1.959964;
    return z + (z * z * z + z) / (4 * df) + (5 * Math.pow(z, 5) + 16 * z * z * z + 3 * z) / (96 * df * df);
}

// Half-width of the Wilson 95% interval for w successes in n.
function wilsonHalf(w, n) {
    const z2 = 1.959964 * 1.959964;
    const p = w / n;
    const denom = 1 + z2 / n;
    return 1.959964 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denom;
}

// Robust bounds of a set of values: median ± CLIP_MADS × 1.4826 × MAD; null = no clipping.
function robustBounds(values) {
    const s = values.slice().sort((a, b) => a - b);
    const med = s[s.length >> 1];
    const dev = s.map(v => Math.abs(v - med)).sort((a, b) => a - b);
    const mad = dev[dev.length >> 1];
    if (!(mad > 0)) {
        return null;
    }
    const w = CLIP_MADS * 1.4826 * mad;
    return [med - w, med + w];
}

function clampTo(x, b) {
    return b ? Math.min(b[1], Math.max(b[0], x)) : x;
}

function zeros(n) {
    const a = [];
    for (let i = 0; i < n; ++i) {
        a.push(0);
    }
    return a;
}

// Tally cell for a test: volatility third × impact state × volume-only third.
function cellOf(atrT, lamT, illT) {
    return atrT * 9 + lamT * 3 + illT;
}

const CELLS = [];
for (let a = 0; a < 3; ++a) {
    for (let l = 0; l < 3; ++l) {
        for (let i = 0; i < 3; ++i) {
            CELLS.push({ a, l, i, c: cellOf(a, l, i) });
        }
    }
}

function ordinal(n) {
    const tens = n % 100;
    const s = tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";
    return n + s;
}

const pct = x => Math.round(100 * x) + "%";
const pts = x => {
    const v = Math.round(100 * x);
    return (v >= 0 ? "+" : "") + (v === 0 ? 0 : v);   // never "-0"
};

// Wrap a line to LINE_CHARS, breaking at " | " where possible (the "|" stays at
// the end of the line) and between words otherwise; continuations are indented.
function wrap(text) {
    if (!text) {
        return [];
    }
    const fit = LINE_CHARS - 2;
    const out = [];
    let line = "";
    const add = (piece, sep) => {
        if (line && (line + sep + piece).length > fit) {
            out.push(sep === " | " ? line + " |" : line);
            line = "    " + piece;
        }
        else {
            line = line ? line + sep + piece : piece;
        }
    };
    text.split(" | ").forEach((part, n) => {
        const sep = n > 0 ? " | " : "";
        if ((line + sep + part).length <= fit || ("    " + part).length <= fit) {
            add(part, " | ");
            return;
        }
        part.split(" ").forEach((word, j) => add(word, j === 0 && n > 0 ? " | " : " "));
    });
    out.push(line);
    return out;
}

function emptyWindow() {
    return { r: [], q: [], rng: [], vol: [] };
}

// Snapshot of one bar as plain data (the profile array is kept by reference).
function readBar(d) {
    const profile = typeof d.profile === "function" ? d.profile() : undefined;
    const ts = typeof d.timestamp === "function" ? +d.timestamp() : NaN;
    const td = typeof d.tradeDate === "function" ? d.tradeDate() : undefined;
    let session;
    if (td !== undefined && td !== null) {
        session = typeof td === "object" ? JSON.stringify(td) : String(td);
    }
    else {
        session = Number.isFinite(ts) ? etTradeDate(ts) : "";
    }
    return {
        open: d.open(),
        high: d.high(),
        low: d.low(),
        close: d.close(),
        volume: d.volume() || 0,
        bidVol: d.bidVolume() || 0,
        askVol: d.offerVolume() || 0,
        profile: profile && profile.length ? profile : null,
        ts,
        session
    };
}

class liquidityRegimeMeter {
    init() {
        // zone engine — identical state to Resting Order Levels
        this.levels = [];
        this.committed = -1;
        this.baseLevel = 0;
        this.baseBar = 0;
        this.baseRange = 0;
        this.baseCount = 0;
        this.nextId = 1;
        this.profileBars = 0;
        this.barLevelBars = 0;
        this.openTests = [];      // zone retests waiting for an outcome
        this.openControl = [];    // the same test at random prices
        this.prevClose = null;
        // meter
        this.g = 0;               // session ordinal
        this.lastSession = null;
        this.meterClose = null;   // previous close, for the window's price change
        this.meterTs = NaN;       // previous closed bar's time, to spot halts
        this.win = emptyWindow();
        this.prior = [];          // completed sessions: first reading per clock slot
        this.today = { lam: {}, atr: {}, ill: {} };
        this.poolVersion = 0;
        this.refCache = null;
        this.sess = {};           // session ordinal → tallies of tagged tests, by cell
        this.totals = { z: { w: 0, n: 0 }, r: { w: 0, n: 0 } };
        this.excluded = {
            z: { building: 0, warmup: 0, unclear: 0 },
            r: { building: 0, warmup: 0, unclear: 0 }
        };
        this.howDecided = STATES.map(() => ({ win: 0, through: 0, both: 0, timeout: 0 }));
        this.distUsed = null;     // [smallest, largest] reversal distance among tagged zone tests
        this.coverage = { aggressor: 0, volume: 0 };
        this.cache = null;
    }

    tick() {
        return (this.contractInfo && this.contractInfo.tickSize) || 0.25;
    }

    // ── zone engine (identical to Resting Order Levels) ─────────────────────

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

    // Advance open tests by one closed bar; file the decided ones.
    settleTests(list, bar, k, fam, decided) {
        const eps = this.tick() * 0.25;
        const horizon = this.props.horizonBars;
        const open = [];
        for (let j = 0; j < list.length; ++j) {
            const t = list[j];
            const result = outcome(t, bar, k, horizon, eps);
            if (result === "open") {
                open.push(t);
            }
            else {
                this.tally(t, result, fam);
                decided[t.id] = true;
            }
        }
        return open;
    }

    // File a decided test under the state tagged when it started; tests that
    // started with no usable state are counted as excluded, never dropped silently.
    tally(t, result, fam) {
        const won = result === "win" ? 1 : 0;
        this.totals[fam].n++;
        this.totals[fam].w += won;
        this.cache = null;
        if (!t.tag) {
            this.excluded[fam][t.why]++;
            return;
        }
        let s = this.sess[t.g];
        if (!s) {
            s = this.sess[t.g] = { zw: zeros(27), zn: zeros(27), rw: zeros(27), rn: zeros(27) };
        }
        const c = cellOf(t.tag[1], t.tag[0], t.tag[2]);
        s[fam + "n"][c]++;
        s[fam + "w"][c] += won;
        if (fam === "z") {
            this.howDecided[t.tag[0]][result]++;
            this.distUsed = this.distUsed
                ? [Math.min(this.distUsed[0], t.dist), Math.max(this.distUsed[1], t.dist)]
                : [t.dist, t.dist];
        }
    }

    startTest(t, bar, k, fam) {
        const result = outcome(t, bar, k, this.props.horizonBars, this.tick() * 0.25);
        if (result === "open") {
            (fam === "z" ? this.openTests : this.openControl).push(t);
        }
        else {
            this.tally(t, result, fam);
        }
    }

    // ── meter ───────────────────────────────────────────────────────────────

    unsupportedChart() {
        const c = this.chartDescription;
        if (!c) {
            return "";
        }
        if (c.underlyingType === "DailyBar") {
            return "daily bars";
        }
        if (["Range", "Renko", "MomentumRange", "PointAndFigure"].indexOf(c.elementSizeUnit) >= 0) {
            return c.elementSizeUnit + " bars";
        }
        if (c.underlyingType === "Tick" && c.elementSizeUnit === "UnderlyingUnits" && c.elementSize < 100) {
            return c.elementSize + "-tick bars";
        }
        return "";
    }

    windowSize() {
        return Math.max(10, Math.round(this.props.impactWindow));
    }

    // A pause longer than this inside one trade date (e.g. a holiday halt)
    // restarts the impact window: the price jump across it is not flow-driven.
    haltLimitMs() {
        const c = this.chartDescription;
        const minutes = c && c.underlyingType === "MinuteBar" ? Math.max(30, 3 * (c.elementSize || 1)) : 60;
        return minutes * 60000;
    }

    // Close the day: its first reading in every clock slot joins the history
    // that later sessions are ranked against; the impact window starts over.
    closeSession() {
        const day = this.today;
        if (Object.keys(day.lam).length || Object.keys(day.atr).length || Object.keys(day.ill).length) {
            this.prior.push(day);
            const cap = Math.max(this.props.poolSessions, this.props.minPriorSessions);
            while (this.prior.length > cap) {
                this.prior.shift();
            }
            this.poolVersion++;
        }
        this.today = { lam: {}, atr: {}, ill: {} };
        this.win = emptyWindow();
        this.g++;
    }

    // Prior sessions' readings within ±SLOT_REACH slots of `slot`, sorted, with
    // how many sessions contributed (cached until the next session closes).
    reference(slot) {
        if (!this.refCache || this.refCache.version !== this.poolVersion) {
            this.refCache = { version: this.poolVersion, slots: {} };
        }
        const hit = this.refCache.slots[slot];
        if (hit) {
            return hit;
        }
        const ref = {};
        ["lam", "atr", "ill"].forEach(m => {
            const values = [];
            let sessions = 0;
            this.prior.forEach(day => {
                let any = false;
                for (let d = -SLOT_REACH; d <= SLOT_REACH; ++d) {
                    const v = day[m][(slot + d + SLOTS) % SLOTS];
                    if (v !== undefined) {
                        values.push(v);
                        any = true;
                    }
                }
                sessions += any ? 1 : 0;
            });
            ref[m] = { sorted: values.sort((a, b) => a - b), sessions };
        });
        this.refCache.slots[slot] = ref;
        return ref;
    }

    // The state in force during a bar, from closed bars of its session only.
    stateFor(ms, session) {
        const W = this.windowSize();
        const w = this.win;
        if (session !== this.lastSession) {
            return { status: "building", n: 0, W };
        }
        if (Number.isFinite(ms) && Number.isFinite(this.meterTs) && ms - this.meterTs > this.haltLimitMs()) {
            return { status: "building", n: 0, W };
        }
        const n = w.r.length;
        if (n < W) {
            return { status: "building", n, W };
        }
        // outliers clipped against this window's own spread, so a quiet or wild
        // earlier period never rescales the current one
        const br = robustBounds(w.r);
        const bq = robustBounds(w.q);
        const r = w.r.map(v => clampTo(v, br));
        const q = w.q.map(v => clampTo(v, bq));
        let mr = 0, mq = 0, sumAbs = 0, sumVol = 0, sumRange = 0;
        for (let j = 0; j < n; ++j) {
            mr += r[j];
            mq += q[j];
            sumAbs += Math.abs(r[j]);
            sumVol += w.vol[j];
            sumRange += w.rng[j];
        }
        mr /= n;
        mq /= n;
        let cov = 0, vq = 0, vr = 0;
        for (let j = 0; j < n; ++j) {
            const dr = r[j] - mr;
            const dq = q[j] - mq;
            cov += dr * dq;
            vq += dq * dq;
            vr += dr * dr;
        }
        cov /= n - 1;
        vq /= n - 1;
        vr /= n - 1;
        const lam = vq > 0 ? cov / vq : 0;
        const r2 = vq > 0 && vr > 0 ? cov * cov / (vq * vr) : 0;
        const slot = slotOf(ms);
        const ref = this.reference(slot);
        const st = {
            full: true,
            n,
            W,
            slot,
            lam,
            r2,
            atr: sumRange / n,
            ill: sumVol > 0 ? sumAbs / sumVol : 0,
            lamValid: vq > 0 && lam > 0 && r2 >= this.props.r2Gate,
            unclear: !(vq > 0) ? "noflow" : !(lam > 0) ? "negative" : "lowr2",
            haveSessions: Math.min(ref.lam.sessions, ref.atr.sessions, ref.ill.sessions),
            havePooled: Math.min(ref.lam.sorted.length, ref.atr.sorted.length, ref.ill.sorted.length)
        };
        const warm = ["lam", "atr", "ill"].every(m =>
            ref[m].sessions >= this.props.minPriorSessions && ref[m].sorted.length >= MIN_POOLED);
        if (!warm) {
            st.status = "warmup";
            return st;
        }
        st.atrPct = midrank(ref.atr.sorted, st.atr);
        st.illPct = midrank(ref.ill.sorted, st.ill);
        st.atrT = tercile(st.atrPct);
        st.illT = tercile(st.illPct);
        if (!st.lamValid) {
            st.status = "unclear";
            return st;
        }
        st.lamPct = midrank(ref.lam.sorted, lam);
        st.lamT = tercile(st.lamPct);
        st.status = "ok";
        return st;
    }

    // Remember a reading: the first one of each clock slot in this session.
    remember(st) {
        const day = this.today;
        if (day.atr[st.slot] === undefined) {
            day.atr[st.slot] = st.atr;
            day.ill[st.slot] = st.ill;
        }
        if (st.lamValid && day.lam[st.slot] === undefined) {
            day.lam[st.slot] = st.lam;
        }
    }

    // Add a closed bar to the impact window (price change within the session only).
    pushWindow(bar, restart) {
        const prev = this.meterClose;
        this.meterClose = bar.close;
        if (restart || prev === null || !(bar.volume > 0)) {
            return;
        }
        const tick = this.tick();
        const w = this.win;
        w.r.push((bar.close - prev) / tick);
        w.q.push(bar.askVol - bar.bidVol);
        w.rng.push((bar.high - bar.low) / tick);
        w.vol.push(bar.volume);
        const W = this.windowSize();
        while (w.r.length > W) {
            w.r.shift();
            w.q.shift();
            w.rng.shift();
            w.vol.shift();
        }
    }

    // Fold one CLOSED bar into the zones, the tests and the meter.
    commit(bar, k) {
        const p = this.props;
        const tick = this.tick();
        const eps = tick * 0.25;
        const breakDist = this.ticks("breakTicks") * tick;
        const touch = this.ticks("touchTicks") * tick + eps;
        const merge = this.ticks("mergeTicks") * tick + eps;
        const bounce = this.ticks("bounceTicks") * tick;
        const decay = p.halfLifeBars > 0 ? Math.pow(0.5, 1 / p.halfLifeBars) : 1;

        // meter: a new trade date closes the previous session; a long pause inside
        // one trade date restarts the window. Then the state in force on this bar.
        const newSession = this.lastSession !== null && bar.session !== this.lastSession;
        if (newSession) {
            this.closeSession();
        }
        this.lastSession = bar.session;
        const halted = !newSession && Number.isFinite(bar.ts) && Number.isFinite(this.meterTs) &&
            bar.ts - this.meterTs > this.haltLimitMs();
        if (halted) {
            this.win = emptyWindow();
        }
        const st = this.stateFor(bar.ts, bar.session);
        const tag = st.status === "ok" ? [st.lamT, st.atrT, st.illT] : null;
        const why = st.status;
        this.coverage.aggressor += bar.bidVol + bar.askVol;
        this.coverage.volume += bar.volume;

        if (bar.profile) {
            this.profileBars++;
        }
        else {
            this.barLevelBars++;
        }

        // 0) decide earlier tests with this bar, then note which zones were live
        const decided = {};
        this.openTests = this.settleTests(this.openTests, bar, k, "z", decided);
        this.openControl = this.settleTests(this.openControl, bar, k, "r", {});
        const liveAtOpen = this.levels.map(lvl => ({ id: lvl.id, side: lvl.side, price: lvl.price, tests: lvl.tests || 0 }));

        const handled = {};

        // 1) age, then breaks
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
                handled[lvl.id] = true;
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

        // 3) retests that held
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

        // 4) zone reversal tests, tagged with the state in force on this bar
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
                lvl.tests = testNo;
            }
            this.startTest({ id: z.id, side: z.side, price: z.price, dist: bounce, start: k, g: this.g, tag, why }, bar, k, "z");
        });

        // 5) baseline: the same test at random prices fixed before this bar opened
        if (this.warmedUp() && this.prevClose !== null) {
            const steps = Math.max(1, Math.round(bounce / tick));
            const below = this.prevClose - (1 + Math.floor(unitHash(k, 1) * steps)) * tick;
            const above = this.prevClose + (1 + Math.floor(unitHash(k, 2) * steps)) * tick;
            if (bar.low <= below + touch) {
                this.startTest({ id: 0, side: SUPPORT, price: below, dist: bounce, start: k, g: this.g, tag, why }, bar, k, "r");
            }
            if (bar.high >= above - touch) {
                this.startTest({ id: 0, side: RESISTANCE, price: above, dist: bounce, start: k, g: this.g, tag, why }, bar, k, "r");
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

        // 8) meter: remember this bar's reading for later sessions, then add the
        //    bar to the impact window for the next bar's state
        if (st.full) {
            this.remember(st);
        }
        this.meterTs = bar.ts;
        this.pushWindow(bar, newSession || halted);
    }

    // ── statistics (session-clustered) ──────────────────────────────────────

    // Everything shown about one family of tests ("z" = your zones, "r" = random prices).
    summarize(fam) {
        const p = this.props;
        const per = Object.keys(this.sess).map(Number).sort((a, b) => a - b)
            .map(g => ({ g, w: this.sess[g][fam + "w"], n: this.sess[g][fam + "n"] }))
            .filter(x => x.n.some(v => v > 0));
        const W = zeros(27);
        const N = zeros(27);
        per.forEach(x => {
            for (let c = 0; c < 27; ++c) {
                W[c] += x.w[c];
                N[c] += x.n[c];
            }
        });
        const sum = (arr, mask) => CELLS.reduce((s, x) => mask(x.a, x.l, x.i) ? s + arr[x.c] : s, 0);
        const rate = (w, n, mask) => {
            const d = sum(n, mask);
            return d > 0 ? sum(w, mask) / d : NaN;
        };
        // Mantel-Haenszel risk difference, low minus high third of `dim`
        // (1 = impact state, 2 = volume-only measure), within volatility thirds
        const third = (dim, val) => (a, l, i) => (dim === 1 ? l : i) === val;
        const mh = (w, n, dim, strata) => {
            let num = 0, den = 0;
            for (let j = 0; j < strata.length; ++j) {
                const a = strata[j];
                const lo = (x, l, i) => x === a && third(dim, 0)(x, l, i);
                const hi = (x, l, i) => x === a && third(dim, 2)(x, l, i);
                const nD = sum(n, lo);
                const nT = sum(n, hi);
                if (!(nD > 0 && nT > 0)) {
                    return NaN;
                }
                const wt = nD * nT / (nD + nT);
                num += wt * (sum(w, lo) / nD - sum(w, hi) / nT);
                den += wt;
            }
            return den > 0 ? num / den : NaN;
        };
        // delete-one-session jackknife over the sessions that hold the tests the
        // statistic reads; each session counts once however many tests it holds
        const est = (stat, mask, proportion) => {
            const inside = per.filter(x => sum(x.n, mask) > 0);
            const G = inside.length;
            const full = stat(W, N);
            const base = { est: full, ok: false, G };
            if (!Number.isFinite(full) || G < 2) {
                return base;
            }
            const th = inside.map(x => stat(W.map((v, c) => v - x.w[c]), N.map((v, c) => v - x.n[c])));
            if (th.some(v => !Number.isFinite(v))) {
                return Object.assign(base, { unstable: true });
            }
            const m = th.reduce((a, v) => a + v, 0) / G;
            const se = Math.sqrt((G - 1) / G * th.reduce((a, v) => a + (v - m) * (v - m), 0));
            let half = tCrit(G - 1) * se;
            if (proportion) {
                // never narrower than the plain binomial interval of the pooled tests
                half = Math.max(half, wilsonHalf(sum(W, mask), sum(N, mask)));
            }
            else if (!(se > 1e-9)) {     // every session agrees to rounding: no measurable spread
                return Object.assign(base, { unstable: true });
            }
            return { est: full, half, lo: full - half, hi: full + half, ok: true, G };
        };
        const strataFor = (dim, n) => [0, 1, 2].filter(a =>
            sum(n, (x, l, i) => x === a && third(dim, 0)(x, l, i)) >= p.minStratumN &&
            sum(n, (x, l, i) => x === a && third(dim, 2)(x, l, i)) >= p.minStratumN);
        const strataL = strataFor(1, N);
        const strataI = strataFor(2, N);
        const common = strataL.filter(a => strataI.indexOf(a) >= 0);
        const all = () => true;
        const ends = dim => (a, l, i) => (dim === 1 ? l : i) !== 1;
        const within = (strata, m) => (a, l, i) => strata.indexOf(a) >= 0 && m(a, l, i);
        const none = { est: NaN, ok: false, G: 0 };
        const out = {
            G: per.length,
            n: sum(N, all),
            states: [0, 1, 2].map(s => Object.assign({ n: sum(N, third(1, s)) },
                est((w, n) => rate(w, n, third(1, s)), third(1, s), true))),
            all: est((w, n) => rate(w, n, all), all, true),
            raw: est((w, n) => rate(w, n, third(1, 0)) - rate(w, n, third(1, 2)), ends(1), false),
            strataL,
            common,
            sl: strataL.length ? est((w, n) => mh(w, n, 1, strataL), within(strataL, ends(1)), false) : none,
            slC: common.length ? est((w, n) => mh(w, n, 1, common), within(common, ends(1)), false) : none,
            siC: common.length ? est((w, n) => mh(w, n, 2, common), within(common, ends(2)), false) : none,
            diff: common.length
                ? est((w, n) => mh(w, n, 1, common) - mh(w, n, 2, common),
                    within(common, (a, l, i) => l !== 1 || i !== 1), false)
                : none
        };
        // the same-volatility gap must point the same way in odd and even sessions;
        // null = cannot be checked (a half has no DEEP and THIN tests in a used third)
        const halfGap = parity => {
            const w = zeros(27);
            const n = zeros(27);
            per.filter(x => x.g % 2 === parity).forEach(x => {
                for (let c = 0; c < 27; ++c) {
                    w[c] += x.w[c];
                    n[c] += x.n[c];
                }
            });
            const strata = strataL.filter(a =>
                sum(n, (x, l, i) => x === a && l === 0) > 0 && sum(n, (x, l, i) => x === a && l === 2) > 0);
            return strata.length ? mh(w, n, 1, strata) : NaN;
        };
        const even = halfGap(0);
        const odd = halfGap(1);
        const sign = Math.sign(out.sl.est);
        out.agree = !out.sl.ok || !Number.isFinite(even) || !Number.isFinite(odd) || sign === 0
            ? null
            : Math.sign(even) === sign && Math.sign(odd) === sign;
        return out;
    }

    stats() {
        if (!this.cache || this.cache.at !== this.committed) {
            this.cache = { at: this.committed, z: this.summarize("z"), r: this.summarize("r") };
        }
        return this.cache;
    }

    // Enough DEEP and THIN tests, from enough sessions, to compare them at all.
    comparable(z) {
        const p = this.props;
        const ok = s => s.n >= p.minTests && s.G >= p.minSessions;
        return ok(z.states[0]) && ok(z.states[2]);
    }

    // ── text ────────────────────────────────────────────────────────────────

    nowLines(st) {
        const p = this.props;
        if (st.status === "building") {
            const c = this.chartDescription;
            const minutes = c && c.underlyingType === "MinuteBar" ? st.W * (c.elementSize || 1) : 0;
            return ["NOW: building this session's " + st.W + "-bar impact window (" + st.n + "/" + st.W + " bars)" +
                (minutes >= 1380 ? " - it can never fill: " + st.W + " bars of " + c.elementSize + " minutes is longer " +
                    "than a session; use 1-5 minute bars or a smaller impactWindow" : "")];
        }
        const details = "impact " + (100 * st.lam).toFixed(2) + " ticks per 100 net contracts | flow explains " +
            (100 * st.r2).toFixed(1) + "% of price change (last " + st.W + " bars)" +
            (st.atrPct !== undefined ? " | volatility " + ordinal(shownPct(st.atrPct, st.atrT)) + " pct" : "");
        let head;
        if (st.status === "warmup") {
            head = "NOW: warming up - ranking needs " + p.minPriorSessions + " prior sessions with readings near " +
                spanText(st.slot) + " (have " + st.haveSessions + ") and " + MIN_POOLED +
                " pooled readings (have " + st.havePooled + ")";
        }
        else if (st.status === "unclear") {
            head = st.unclear === "noflow"
                ? "NOW: unclear - net aggressive volume did not vary over the last " + st.W + " bars"
                : st.unclear === "negative"
                    ? "NOW: unclear - price moved against net aggression over the last " + st.W + " bars"
                    : "NOW: unclear - net flow explains only " + (100 * st.r2).toFixed(1) + "% of price change (needs " +
                      (100 * p.r2Gate).toFixed(1) + "%)";
        }
        else {
            head = "NOW: " + STATES[st.lamT] + " - impact in the " + ordinal(shownPct(st.lamPct, st.lamT)) +
                " percentile vs " + spanText(st.slot) + " in prior sessions";
        }
        return [head, details];
    }

    // The reversal distance, as set; in auto mode also the distances actually used.
    distText(decimals) {
        const p = this.props;
        const tick = this.tick();
        if (p.bounceTicks > 0) {
            const d = (p.bounceTicks * tick).toFixed(decimals);
            return "reversal = " + d + " in favor before " + d + " against, within " + p.horizonBars + " bars";
        }
        const used = this.distUsed
            ? "distances used " + this.distUsed[0].toFixed(decimals) + "-" + this.distUsed[1].toFixed(decimals) + ", "
            : "";
        return "reversal = 1.5x avg bar range in favor before the same against, within " + p.horizonBars + " bars | " +
            used + "now " + (this.ticks("bounceTicks") * tick).toFixed(decimals);
    }

    zoneLines(z, r, decimals) {
        const p = this.props;
        const head = "Your zones' reversal rate by state | " + this.distText(decimals);
        const parts = [0, 1, 2].map(s => {
            const x = z.states[s];
            if (x.n < p.minTests || x.G < p.minSessions) {
                return STATES[s] + " collecting (n=" + x.n + ", " + x.G + " of " + p.minSessions + " sessions)";
            }
            const body = x.ok ? pct(x.est) + " ±" + Math.round(100 * x.half) : pct(x.est) + " (margin unstable)";
            const base = r.states[s].n >= p.minTests ? "; random " + pct(r.states[s].est) : "";
            return STATES[s] + " " + body + " (n=" + x.n + ", " + x.G + " sessions" + base + ")";
        });
        return [head, parts.join(" | ")];
    }

    gapLines(z) {
        const p = this.props;
        if (!this.comparable(z)) {
            return ["DEEP minus THIN: collecting - needs " + p.minTests + " tests from " + p.minSessions +
                " sessions in both DEEP and THIN"];
        }
        const show = (x, label) => {
            if (x.ok) {
                return label + " " + pts(x.est) + " ±" + Math.round(100 * x.half);
            }
            return label + (Number.isFinite(x.est) ? " " + pts(x.est) + " (margin unstable)" : " n/a");
        };
        const thirds = s => s.length ? " (" + s.map(a => VOL_THIRDS[a]).join(", ") + ")" : "";
        const agree = z.agree === null ? "n/a" : z.agree ? "yes" : "no";
        return [
            "DEEP minus THIN: " + show(z.raw, "raw") + " | " + show(z.sl, "same volatility" + thirds(z.strataL)) +
                " | odd/even sessions agree: " + agree,
            "vs volume-only at equal volatility" + thirds(z.common) + ": " + show(z.slC, "impact gap") +
                ", " + show(z.siC, "volume-only gap") + ", " + show(z.diff, "bid/ask split adds")
        ];
    }

    verdict(z, r) {
        const p = this.props;
        const excl = x => x.ok && (x.lo > 0 || x.hi < 0);
        if (!this.comparable(z)) {
            const s = i => STATES[i] + " n=" + z.states[i].n + " in " + z.states[i].G + " sessions";
            return "Verdict: collecting - needs " + p.minTests + " tests from " + p.minSessions +
                " sessions in both DEEP and THIN (" + s(0) + ", " + s(2) + ")";
        }
        const overall = z.raw.est > 0 ? "more" : "less";
        if (!z.sl.ok) {
            return excl(z.raw)
                ? "Verdict: zones reverse " + overall + " in DEEP than THIN overall, but there are too few tests " +
                  "at equal volatility to tell whether that is just volatility"
                : "Verdict: no measurable DEEP/THIN difference so far";
        }
        if (excl(z.sl)) {
            if (z.agree === null) {
                return "Verdict: a DEEP/THIN gap shows at equal volatility, but there are too few tests to check " +
                    "odd vs even sessions yet";
            }
            if (!z.agree) {
                return "Verdict: a DEEP/THIN gap shows at equal volatility, but odd and even sessions disagree - " +
                    "not reliable yet";
            }
            const b = z.sl.est > 0 ? 0 : 2;
            const o = 2 - b;
            let text = "Verdict: at equal volatility your zones reverse more in " + STATES[b] + " than in " + STATES[o];
            if (excl(z.raw) && Math.sign(z.raw.est) !== Math.sign(z.sl.est)) {
                text += " (overall " + STATES[b] + " shows the lower rate - volatility masks it)";
            }
            if (!z.diff.ok) {
                text += "; the volume-only comparison is not available yet";
            }
            else if (excl(z.diff) && Math.sign(z.diff.est) === Math.sign(z.sl.est)) {
                text += "; the bid/ask split predicts it better than a volume-only measure";
            }
            else if (excl(z.diff)) {
                text += "; a volume-only measure predicts it better than the bid/ask split";
            }
            else if (excl(z.siC) && Math.sign(z.siC.est) === Math.sign(z.sl.est)) {
                text += "; a volume-only measure shows a similar gap, so it may be liquidity in general";
            }
            else {
                text += "; cannot tell yet whether the bid/ask split adds anything beyond volume";
            }
            const zs = z.states[b];
            const rs = r.states[b];
            // "beat" = the two 95% intervals do not overlap
            const beats = zs.ok && rs.ok && rs.n >= p.minTests && zs.lo > rs.hi;
            return text + (beats
                ? ". Favor zone fades in " + STATES[b]
                : ". But " + STATES[b] + " zones do not clearly beat random prices yet");
        }
        if (excl(z.raw)) {
            const explained = z.raw.est > 0 ? z.sl.hi < z.raw.est : z.sl.lo > z.raw.est;
            return explained
                ? "Verdict: the DEEP/THIN gap is explained by volatility - at equal volatility the state adds " +
                  "nothing; watch the volatility percentile instead"
                : "Verdict: zones reverse " + overall + " in DEEP than THIN overall, but the same-volatility gap is " +
                  "too uncertain to tell whether that is just volatility";
        }
        return "Verdict: no measurable DEEP/THIN difference on this chart - ignore the state for zone fades";
    }

    diagLines(z, liveSession) {
        const p = this.props;
        const ex = this.excluded.z;
        const share = s => {
            const o = this.howDecided[s];
            const fails = o.through + o.both + o.timeout;
            return fails ? pct(o.both / fails) : "-";
        };
        const cov = this.coverage.volume > 0 ? pct(this.coverage.aggressor / this.coverage.volume) : "-";
        const changed = Object.keys(DEFAULTS).some(k => p[k] !== DEFAULTS[k]);
        const sessions = this.g + 1 + (this.lastSession !== null && liveSession !== this.lastSession ? 1 : 0);
        return [
            "Sessions loaded " + sessions + " | " +
                (changed ? "SETTINGS CHANGED from defaults: results are in-sample" : "default settings") +
                " | bid/ask volume coverage " + cov,
            "zone tests: " + z.n + " state-tagged, " + (ex.building + ex.warmup + ex.unclear) + " excluded (window building " +
                ex.building + ", warm-up " + ex.warmup + ", unclear " + ex.unclear + ") | fails hitting both sides " +
                "in one bar: DEEP " + share(0) + " NORMAL " + share(1) + " THIN " + share(2)
        ];
    }

    textItems(lines) {
        const p = this.props;
        const rows = [];
        lines.forEach(line => wrap(line).forEach(row => rows.push({ row, bold: line.indexOf("Verdict") === 0 })));
        return [{
            tag: "Container",
            key: "liquidityRegimeMeter",
            global: true,
            children: rows.map((x, n) => ({
                tag: "Text",
                key: "line" + n,
                point: { x: px(10), y: px(14 + 15 * n) },
                text: x.row,
                style: x.bold
                    ? { fontSize: 11, fontWeight: "bold", fill: p.textColor }
                    : { fontSize: 11, fill: p.textColor },
                textAlignment: p.textAlignment
            }))
        }];
    }

    map(d, i, history) {
        const p = this.props;
        const isLast = typeof d.isLast === "function" ? d.isLast() : i === history.size() - 1;
        const why = this.unsupportedChart();
        if (why) {
            return isLast && p.showStatus ? { graphics: { items: this.textItems([
                "Liquidity Regime Meter: unsupported chart (" + why + ") - use time bars (1-minute recommended), " +
                "volume bars or 100+ tick bars"
            ]) } } : undefined;
        }

        // Fold every closed bar not yet seen. The live bar never enters the
        // window, the history or the tests until it closes, so nothing repaints.
        for (let k = this.committed + 1; k < i; ++k) {
            const e = k === i - 1 ? history.prior() : history.get(k);
            this.commit(readBar(e), k);
        }
        this.committed = Math.max(this.committed, i - 1);

        const live = readBar(d);
        const st = this.stateFor(live.ts, live.session);
        const out = {};
        if (st.full) {
            out.r2 = 100 * st.r2;
        }
        if (st.status === "ok") {
            const color = [p.deepColor, p.normalColor, p.thinColor][st.lamT];
            out.pct = st.lamPct;
            out.style = { pct: { color } };
            if (p.tintCandles) {
                out.candlestick = { color };
            }
        }
        if (isLast && p.showStatus) {
            const decimals = decimalsOf(this.tick());
            const s = this.stats();
            let lines;
            if (this.coverage.volume > 0 && this.coverage.aggressor === 0) {
                lines = ["Liquidity Regime Meter: NO bid/ask volume on this chart - the impact state cannot be measured"];
            }
            else {
                lines = this.nowLines(st)
                    .concat(this.zoneLines(s.z, s.r, decimals))
                    .concat(p.showDetails ? this.gapLines(s.z) : [])
                    .concat([this.verdict(s.z, s.r)])
                    .concat(p.showDetails ? this.diagLines(s.z, live.session) : []);
            }
            out.graphics = { items: this.textItems(lines) };
        }
        return out;
    }
}

module.exports = {
    name: "liquidityRegimeMeter",
    description: "Liquidity Regime Meter (zone odds by depth)",
    calculator: liquidityRegimeMeter,
    inputType: meta.InputType.BARS,
    areaChoice: meta.AreaChoice.NEW,
    requirements: {
        volumeProfiles: true
    },
    params: {
        // meter
        impactWindow: predef.paramSpecs.number(DEFAULTS.impactWindow, 1, 10),
        r2Gate: predef.paramSpecs.number(DEFAULTS.r2Gate, 0.01, 0),
        minPriorSessions: predef.paramSpecs.number(DEFAULTS.minPriorSessions, 1, 1),
        poolSessions: predef.paramSpecs.number(DEFAULTS.poolSessions, 1, 1),
        minSessions: predef.paramSpecs.number(DEFAULTS.minSessions, 1, 2),
        minTests: predef.paramSpecs.number(DEFAULTS.minTests, 5, 5),
        minStratumN: predef.paramSpecs.number(DEFAULTS.minStratumN, 1, 2),
        tintCandles: predef.paramSpecs.bool(false),
        showStatus: predef.paramSpecs.bool(true),
        showDetails: predef.paramSpecs.bool(true),
        textAlignment: predef.paramSpecs.enum({
            rightBelow: "Right of the corner",
            leftBelow: "Left of the corner"
        }, "rightBelow"),
        textColor: predef.paramSpecs.color("#78838f"),
        deepColor: predef.paramSpecs.color("#42a5f5"),
        normalColor: predef.paramSpecs.color("#78909c"),
        thinColor: predef.paramSpecs.color("#ffa726"),
        // zones — keep equal to your Resting Order Levels settings (defaults match)
        absorptionMultiple: predef.paramSpecs.number(DEFAULTS.absorptionMultiple, 0.5, 0.5),
        minContracts: predef.paramSpecs.number(DEFAULTS.minContracts, 10, 0),
        edgeTicks: predef.paramSpecs.number(DEFAULTS.edgeTicks, 1, 0),
        rejectionTicks: predef.paramSpecs.number(DEFAULTS.rejectionTicks, 1, 0),
        mergeTicks: predef.paramSpecs.number(DEFAULTS.mergeTicks, 1, 0),
        touchTicks: predef.paramSpecs.number(DEFAULTS.touchTicks, 1, 0),
        breakTicks: predef.paramSpecs.number(DEFAULTS.breakTicks, 1, 0),
        flipBrokenLevels: predef.paramSpecs.bool(DEFAULTS.flipBrokenLevels),
        halfLifeBars: predef.paramSpecs.number(DEFAULTS.halfLifeBars, 10, 0),
        maxIdleBars: predef.paramSpecs.number(DEFAULTS.maxIdleBars, 50, 10),
        baselineBars: predef.paramSpecs.period(DEFAULTS.baselineBars),
        barModeMultiple: predef.paramSpecs.number(DEFAULTS.barModeMultiple, 0.1, 0.5),
        bounceTicks: predef.paramSpecs.number(DEFAULTS.bounceTicks, 1, 0),
        horizonBars: predef.paramSpecs.number(DEFAULTS.horizonBars, 5, 5)
    },
    plots: {
        pct: { title: "Impact percentile" },
        r2: { title: "Flow R² %" }
    },
    plotter: [
        predef.plotters.columns("pct"),
        predef.plotters.singleline("r2")
    ],
    schemeStyles: {
        dark: {
            pct: predef.styles.plot("#78909c"),
            r2: predef.styles.plot("#b0bec5")
        },
        light: {
            pct: predef.styles.plot("#78909c"),
            r2: predef.styles.plot("#546e7a")
        }
    },
    tags: ["Order Flow"]
};

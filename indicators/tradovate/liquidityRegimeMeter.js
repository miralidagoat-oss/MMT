// Liquidity Regime Meter — is the market DEEP or THIN right now, and do your
// resting-order zones reverse more often in one state than the other?
// Every number it shows is counted on this chart.
//
// IMPACT. Over the last `impactWindow` closed bars of this session, the meter
// regresses each bar's price change (ticks) on its net aggressive volume
// (volume at the ask minus volume at the bid). The slope is how many ticks
// price moved per contract of net aggression (Kyle's lambda), shown per 100
// contracts; R² is how much of the price change that net flow explains. The
// slope is ranked against the same time of day in prior sessions, because the
// market is naturally thinner overnight than at the open:
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
// DEEP-minus-THIN gap is checked twice: with volatility held equal, and
// against a volume-only liquidity measure (Amihud) that ignores the bid/ask
// split. The verdict line says whether the order-flow state actually matters
// on this chart.
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
const SEGMENTS = ["overnight", "pre-market", "RTH open", "midday", "afternoon"];
const POOL_STRIDE = 5;        // pool every 5th bar's reading (neighbours share 29 of 30 window bars)
const MIN_POOL_VALUES = 10;   // a prior session counts for warm-up with ≥ 10 readings in that segment
const CLIP_EVERY = 20;        // refresh the outlier bounds every 20 valid bars...
const CLIP_LOOKBACK = 200;    // ...from the last 200 raw values
const CLIP_MADS = 4;          // clip at median ± 4 robust standard deviations
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

// Time-of-day segment (ET): 0 overnight 16:00-02:59, 1 pre-market 03:00-09:29,
// 2 RTH open 09:30-10:29, 3 midday 10:30-13:59, 4 afternoon 14:00-15:59.
function segmentOf(ms) {
    if (!Number.isFinite(ms)) {
        return 0;
    }
    const m = etMinutes(ms);
    if (m >= 16 * 60 || m < 3 * 60) {
        return 0;
    }
    if (m < 9 * 60 + 30) {
        return 1;
    }
    if (m < 10 * 60 + 30) {
        return 2;
    }
    return m < 14 * 60 ? 3 : 4;
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

// Robust outlier bounds: median ± CLIP_MADS × 1.4826 × MAD; null = no clipping.
function robustBounds(values) {
    if (values.length < CLIP_EVERY) {
        return null;
    }
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

// Tally cell for a test: volatility tercile × impact state × volume-only tercile.
function cellOf(atrT, lamT, illT) {
    return atrT * 9 + lamT * 3 + illT;
}

function ordinal(p) {
    const n = Math.max(0, Math.min(100, Math.round(p)));
    const tens = n % 100;
    const s = tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";
    return n + s;
}

const pct = x => Math.round(100 * x) + "%";
const pts = x => (x >= 0 ? "+" : "") + Math.round(100 * x);

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
        this.everStreamed = false;
        this.meterClose = null;   // previous close, for the window's price change
        this.win = { r: [], q: [], rng: [], vol: [] };
        this.rawR = [];
        this.rawQ = [];
        this.clipR = null;
        this.clipQ = null;
        this.validBars = 0;
        this.pools = SEGMENTS.map(() => ({ sessions: [], lam: [], atr: [], ill: [] }));
        this.today = SEGMENTS.map(() => ({ lam: [], atr: [], ill: [] }));
        this.sess = {};           // session ordinal → tallies of tagged tests, by cell
        this.totals = { z: { w: 0, n: 0 }, r: { w: 0, n: 0 } };
        this.excluded = {
            z: { building: 0, warmup: 0, unclear: 0 },
            r: { building: 0, warmup: 0, unclear: 0 }
        };
        this.howDecided = STATES.map(() => ({ win: 0, through: 0, both: 0, timeout: 0 }));
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
        }
        this.cache = null;
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

    // Close the day: its time-of-day readings join the pools that later
    // sessions are ranked against; the impact window starts over.
    closeSession() {
        const cap = Math.max(this.props.poolSessions, this.props.minPriorSessions);
        for (let s = 0; s < SEGMENTS.length; ++s) {
            const day = this.today[s];
            if (!day.lam.length && !day.atr.length && !day.ill.length) {
                continue;
            }
            const pool = this.pools[s];
            pool.sessions.push(day);
            while (pool.sessions.length > cap) {
                pool.sessions.shift();
            }
            ["lam", "atr", "ill"].forEach(m => {
                pool[m] = pool.sessions.reduce((a, x) => a.concat(x[m]), []).sort((a, b) => a - b);
            });
        }
        this.today = SEGMENTS.map(() => ({ lam: [], atr: [], ill: [] }));
        this.win = { r: [], q: [], rng: [], vol: [] };
        this.g++;
    }

    // Prior sessions with enough readings in this segment, for the scarcest measure.
    warmSessions(pool) {
        return Math.min.apply(null, ["lam", "atr", "ill"].map(m =>
            pool.sessions.filter(x => x[m].length >= MIN_POOL_VALUES).length));
    }

    // The state in force during a bar, from closed bars of its session only.
    stateFor(ms, session) {
        const W = this.windowSize();
        const w = this.win;
        if (session !== this.lastSession) {
            return { status: "building", n: 0, W };
        }
        const n = w.r.length;
        if (n < W) {
            return { status: "building", n, W };
        }
        let mr = 0, mq = 0, sumAbs = 0, sumVol = 0, sumRange = 0;
        for (let j = 0; j < n; ++j) {
            mr += w.r[j];
            mq += w.q[j];
            sumAbs += Math.abs(w.r[j]);
            sumVol += w.vol[j];
            sumRange += w.rng[j];
        }
        mr /= n;
        mq /= n;
        let cov = 0, vq = 0, vr = 0;
        for (let j = 0; j < n; ++j) {
            const dr = w.r[j] - mr;
            const dq = w.q[j] - mq;
            cov += dr * dq;
            vq += dq * dq;
            vr += dr * dr;
        }
        cov /= n - 1;
        vq /= n - 1;
        vr /= n - 1;
        const lam = vq > 0 ? cov / vq : 0;
        const r2 = vq > 0 && vr > 0 ? cov * cov / (vq * vr) : 0;
        const seg = segmentOf(ms);
        const pool = this.pools[seg];
        const st = {
            full: true,
            n,
            W,
            seg,
            lam,
            r2,
            atr: sumRange / n,
            ill: sumVol > 0 ? sumAbs / sumVol : 0,
            lamValid: vq > 0 && lam > 0 && r2 >= this.props.r2Gate,
            warm: this.warmSessions(pool)
        };
        if (st.warm < this.props.minPriorSessions) {
            st.status = "warmup";
            return st;
        }
        st.atrPct = midrank(pool.atr, st.atr);
        st.illPct = midrank(pool.ill, st.ill);
        st.atrT = tercile(st.atrPct);
        st.illT = tercile(st.illPct);
        if (!st.lamValid) {
            st.status = "unclear";
            return st;
        }
        st.lamPct = midrank(pool.lam, lam);
        st.lamT = tercile(st.lamPct);
        st.status = "ok";
        return st;
    }

    // Add a closed bar to the impact window (price change within the session only).
    pushWindow(bar, newSession) {
        const prev = this.meterClose;
        this.meterClose = bar.close;
        if (newSession || prev === null || !(bar.volume > 0)) {
            return;
        }
        const tick = this.tick();
        const rRaw = (bar.close - prev) / tick;
        const qRaw = bar.askVol - bar.bidVol;
        const w = this.win;
        w.r.push(clampTo(rRaw, this.clipR));
        w.q.push(clampTo(qRaw, this.clipQ));
        w.rng.push((bar.high - bar.low) / tick);
        w.vol.push(bar.volume);
        const W = this.windowSize();
        while (w.r.length > W) {
            w.r.shift();
            w.q.shift();
            w.rng.shift();
            w.vol.shift();
        }
        this.rawR.push(rRaw);
        this.rawQ.push(qRaw);
        if (this.rawR.length > CLIP_LOOKBACK) {
            this.rawR.shift();
            this.rawQ.shift();
        }
        this.validBars++;
        if (this.validBars % CLIP_EVERY === 0) {
            this.clipR = robustBounds(this.rawR);
            this.clipQ = robustBounds(this.rawQ);
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

        // meter: a new trade date closes the previous session first
        const newSession = this.lastSession !== null && bar.session !== this.lastSession;
        if (newSession) {
            this.closeSession();
        }
        this.lastSession = bar.session;
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

        // 8) meter: this bar's reading joins today's time-of-day pool, then the
        //    bar itself joins the impact window for the next bar's state
        if (st.full && k % POOL_STRIDE === 0) {
            const day = this.today[st.seg];
            day.atr.push(st.atr);
            day.ill.push(st.ill);
            if (st.lamValid) {
                day.lam.push(st.lam);
            }
        }
        this.pushWindow(bar, newSession);
    }

    // ── statistics (session-clustered) ──────────────────────────────────────

    // Everything shown about one family of tests ("z" = your zones, "r" = random prices).
    summarize(fam) {
        const p = this.props;
        const per = Object.keys(this.sess).map(Number).sort((a, b) => a - b)
            .map(g => ({ g, w: this.sess[g][fam + "w"], n: this.sess[g][fam + "n"] }))
            .filter(x => x.n.some(v => v > 0));
        const G = per.length;
        const W = zeros(27);
        const N = zeros(27);
        per.forEach(x => {
            for (let c = 0; c < 27; ++c) {
                W[c] += x.w[c];
                N[c] += x.n[c];
            }
        });
        const loo = per.map(x => ({ w: W.map((v, c) => v - x.w[c]), n: N.map((v, c) => v - x.n[c]) }));
        // delete-one-session jackknife: each session counts once however many tests it holds
        const est = stat => {
            const full = stat(W, N);
            if (!Number.isFinite(full) || G < 2) {
                return { est: full, ok: false };
            }
            const th = loo.map(l => stat(l.w, l.n));
            if (th.some(x => !Number.isFinite(x))) {
                return { est: full, ok: false, unstable: true };
            }
            const m = th.reduce((a, x) => a + x, 0) / G;
            const se = Math.sqrt((G - 1) / G * th.reduce((a, x) => a + (x - m) * (x - m), 0));
            const half = tCrit(G - 1) * se;
            return { est: full, half, lo: full - half, hi: full + half, ok: true };
        };
        // sums over cells whose `dim` (0 = volatility, 1 = impact, 2 = volume-only) is `val`
        const pick = (arr, dim, val, atr) => {
            let s = 0;
            for (let a = 0; a < 3; ++a) {
                if (atr !== undefined && a !== atr) {
                    continue;
                }
                for (let l = 0; l < 3; ++l) {
                    for (let i = 0; i < 3; ++i) {
                        if ([a, l, i][dim] === val) {
                            s += arr[cellOf(a, l, i)];
                        }
                    }
                }
            }
            return s;
        };
        const rate = (w, n, dim, val) => {
            const d = pick(n, dim, val);
            return d > 0 ? pick(w, dim, val) / d : NaN;
        };
        // Mantel-Haenszel risk difference low-minus-high tercile of `dim`, within volatility terciles
        const mh = (w, n, dim, strata) => {
            let num = 0, den = 0;
            for (let j = 0; j < strata.length; ++j) {
                const a = strata[j];
                const nD = pick(n, dim, 0, a);
                const nT = pick(n, dim, 2, a);
                if (!(nD > 0 && nT > 0)) {
                    return NaN;
                }
                const wt = nD * nT / (nD + nT);
                num += wt * (pick(w, dim, 0, a) / nD - pick(w, dim, 2, a) / nT);
                den += wt;
            }
            return den > 0 ? num / den : NaN;
        };
        const strata = dim => [0, 1, 2].filter(a =>
            pick(N, dim, 0, a) >= p.minStratumN && pick(N, dim, 2, a) >= p.minStratumN);
        const strataL = strata(1);
        const strataI = strata(2);
        const none = { est: NaN, ok: false };
        const out = {
            G,
            n: N.reduce((a, v) => a + v, 0),
            states: [0, 1, 2].map(s => Object.assign({ n: pick(N, 1, s) }, est((w, n) => rate(w, n, 1, s)))),
            all: est((w, n) => {
                const t = n.reduce((a, v) => a + v, 0);
                return t > 0 ? w.reduce((a, v) => a + v, 0) / t : NaN;
            }),
            raw: est((w, n) => rate(w, n, 1, 0) - rate(w, n, 1, 2)),
            sl: strataL.length ? est((w, n) => mh(w, n, 1, strataL)) : none,
            si: strataI.length ? est((w, n) => mh(w, n, 2, strataI)) : none,
            diff: strataL.length && strataI.length
                ? est((w, n) => mh(w, n, 1, strataL) - mh(w, n, 2, strataI)) : none
        };
        // the within-volatility gap must point the same way in odd and even sessions
        const half = parity => {
            const w = zeros(27);
            const n = zeros(27);
            per.filter(x => x.g % 2 === parity).forEach(x => {
                for (let c = 0; c < 27; ++c) {
                    w[c] += x.w[c];
                    n[c] += x.n[c];
                }
            });
            return strataL.length ? mh(w, n, 1, strataL) : NaN;
        };
        const even = half(0);
        const odd = half(1);
        const sign = Math.sign(out.sl.est);
        out.agree = sign !== 0 && Number.isFinite(even) && Number.isFinite(odd) &&
            Math.sign(even) === sign && Math.sign(odd) === sign;
        return out;
    }

    stats() {
        if (!this.cache || this.cache.at !== this.committed) {
            this.cache = { at: this.committed, z: this.summarize("z"), r: this.summarize("r") };
        }
        return this.cache;
    }

    // ── text ────────────────────────────────────────────────────────────────

    nowLine(st, decimals) {
        const p = this.props;
        const r2 = st.full ? pct(st.r2) : "";
        if (st.status === "building") {
            return "NOW: building this session's " + st.W + "-bar impact window (" + st.n + "/" + st.W + " bars)";
        }
        if (st.status === "warmup") {
            return "NOW: warming up - needs " + p.minPriorSessions + " prior sessions for the " + SEGMENTS[st.seg] +
                " segment (have " + st.warm + ") | impact " + (100 * st.lam).toFixed(2) +
                " ticks per 100 net contracts, flow explains " + r2 + " of price change";
        }
        if (st.status === "unclear") {
            return "NOW: unclear - net flow explains only " + r2 + " of price change over the last " + st.W +
                " bars (needs " + pct(p.r2Gate) + ") | volatility " + ordinal(st.atrPct) + " pct";
        }
        return "NOW: " + STATES[st.lamT] + " | impact " + (100 * st.lam).toFixed(2) + " ticks per 100 net contracts, " +
            ordinal(st.lamPct) + " pct vs " + SEGMENTS[st.seg] + " in prior sessions | flow explains " + r2 +
            " of price change (last " + st.W + " bars) | volatility " + ordinal(st.atrPct) + " pct";
    }

    zoneLine(z, r, decimals) {
        const p = this.props;
        const move = (this.ticks("bounceTicks") * this.tick()).toFixed(decimals);
        const head = "Your zones reversed (" + move + " in favor before " + move + " against, within " +
            p.horizonBars + " bars): ";
        if (z.G < p.minSessions) {
            return head + "collecting - " + z.G + " of " + p.minSessions + " sessions with state-tagged zone tests (" +
                z.n + " tests so far)";
        }
        const parts = [0, 1, 2].map(s => {
            const x = z.states[s];
            if (x.n < p.minTests) {
                return STATES[s] + " collecting (n=" + x.n + ")";
            }
            const body = x.ok ? pct(x.est) + " ±" + Math.round(100 * x.half) : pct(x.est) + " (margin unstable)";
            const base = r.states[s].n >= p.minTests ? "; random " + pct(r.states[s].est) : "";
            return STATES[s] + " " + body + " (n=" + x.n + base + ")";
        });
        const all = z.all.ok ? " | all " + pct(z.all.est) + " ±" + Math.round(100 * z.all.half) : "";
        return head + parts.join(" | ") + all;
    }

    gapLine(z) {
        const p = this.props;
        if (z.G < p.minSessions) {
            return "";
        }
        const show = (x, label) => {
            if (x.ok) {
                return label + " " + pts(x.est) + " ±" + Math.round(100 * x.half);
            }
            return label + (Number.isFinite(x.est) ? " " + pts(x.est) + " (margin unstable)" : " n/a");
        };
        return "DEEP minus THIN: " + show(z.raw, "raw") +
            " | " + show(z.sl, "same volatility") +
            " | " + show(z.si, "volume-only measure, same volatility") +
            " | " + show(z.diff, "bid/ask split adds") +
            " | odd/even sessions agree: " + (z.agree ? "yes" : "no");
    }

    verdict(z) {
        const p = this.props;
        const excl = x => x.ok && (x.lo > 0 || x.hi < 0);
        if (z.G < p.minSessions) {
            return "Verdict: collecting - needs " + p.minSessions + " sessions with state-tagged zone tests (have " + z.G + ")";
        }
        if (!z.sl.ok) {
            return excl(z.raw)
                ? "Verdict: zones reverse " + (z.raw.est > 0 ? "more" : "less") +
                  " in DEEP than THIN, but not enough tests per volatility level yet to tell whether it is just volatility"
                : "Verdict: no measurable DEEP/THIN difference so far";
        }
        if (excl(z.sl) && z.agree) {
            const better = z.sl.est > 0 ? "DEEP (blue)" : "THIN (orange)";
            if (excl(z.diff) && Math.sign(z.diff.est) === Math.sign(z.sl.est)) {
                return "Verdict: your zones reverse more in " + better + " conditions - still true at equal measured " +
                    "volatility, and the bid/ask split predicts it better than a volume-only measure. Favor zone fades in that state";
            }
            return "Verdict: your zones reverse more in " + better + " conditions, even at equal measured volatility - " +
                "but a volume-only measure predicts it as well, so it is liquidity in general, not the bid/ask split";
        }
        if (excl(z.sl)) {
            return "Verdict: a DEEP/THIN gap shows at equal volatility, but odd and even sessions disagree - not reliable yet";
        }
        if (excl(z.raw)) {
            return "Verdict: the DEEP/THIN gap is explained by volatility - at equal volatility the colors add nothing; " +
                "watch the volatility percentile instead";
        }
        return "Verdict: no measurable DEEP/THIN difference on this chart - ignore the colors for zone fades";
    }

    diagLine(z) {
        const p = this.props;
        const ex = this.excluded.z;
        const share = s => {
            const o = this.howDecided[s];
            const fails = o.through + o.both + o.timeout;
            return fails ? pct(o.both / fails) : "-";
        };
        const cov = this.coverage.volume > 0 ? pct(this.coverage.aggressor / this.coverage.volume) : "-";
        const changed = Object.keys(DEFAULTS).some(k => p[k] !== DEFAULTS[k]);
        return "Sessions loaded " + (this.g + 1) + " | zone tests: " + z.n + " state-tagged, excluded " +
            (ex.building + ex.warmup + ex.unclear) + " (window " + ex.building + ", warm-up " + ex.warmup +
            ", unclear " + ex.unclear + ") | fails hitting both sides in one bar: DEEP " + share(0) + " NORMAL " +
            share(1) + " THIN " + share(2) + " | bid/ask volume coverage " + cov + " | " +
            (changed ? "settings changed from defaults: treat results as in-sample" : "default settings");
    }

    textItems(lines) {
        const p = this.props;
        return [{
            tag: "Container",
            key: "liquidityRegimeMeter",
            global: true,
            children: lines.filter(Boolean).map((text, n) => ({
                tag: "Text",
                key: "line" + n,
                point: { x: px(10), y: px(14 + 16 * n) },
                text,
                style: { fontSize: 11, fill: text.indexOf("Verdict") === 0 ? "#e3e8ef" : "#9aa4b2" },
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
                "Liquidity Regime Meter: unsupported chart (" + why + ") - use time bars (1-minute recommended), volume bars or 100+ tick bars"
            ]) } } : undefined;
        }

        // Fold every closed bar not yet seen. The live bar never enters the
        // window, the pools or the tests until it closes, so nothing repaints.
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
                lines = [
                    this.nowLine(st, decimals),
                    this.zoneLine(s.z, s.r, decimals),
                    this.gapLine(s.z),
                    this.verdict(s.z),
                    this.diagLine(s.z)
                ];
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
        textAlignment: predef.paramSpecs.enum({
            rightBelow: "Right of the corner",
            leftBelow: "Left of the corner"
        }, "rightBelow"),
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

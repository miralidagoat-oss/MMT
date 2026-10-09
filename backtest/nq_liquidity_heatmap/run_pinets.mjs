// Run indicators/nq_liquidity_heatmap.pine in PineTS (an open-source Pine
// Script v6 runtime) on local kline fixtures from prep_data.py, and save its
// Data Window series, drawings and alerts as JSON for truth.py.
//
// usage: node run_pinets.mjs <script.pine> <data_dir> <SYMBOL> <chart_tf> <start_idx> <out.json>
//                            [inputs_json] [--tv-timing]
//
// The chart gets bars from start_idx on; every higher timeframe gets its
// full history up to the chart's last bar (as on TradingView, requested
// timeframes reach back before the chart's first bar).
//
// --tv-timing: PineTS 0.11 mis-parses request.security() calls whose
// expression returns an array — it mistakes the array for a named-argument
// object, so gaps/lookahead are dropped and the result arrives with
// lookahead_off timing. This flag runs a patched copy of the PineTS bundle
// that keeps those arguments positional, giving TradingView's lookahead_on
// timing. Test-only; the indicator itself is unchanged.
//
// inputs_json overrides input defaults by regex on the source:
//   {"<regex matching the original text>": "<replacement>"}
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const args = process.argv.slice(2);
const tvTiming = args.includes('--tv-timing');
const [scriptPath, dataDir, symbol, chartTf, startIdxStr, outPath, inputsJson] = args.filter((a) => a !== '--tv-timing');
const startIdx = parseInt(startIdxStr, 10);

const TF_FILE = { '60': '60', '240': '240', D: 'D', '1D': 'D', W: 'W', '1W': 'W', M: 'M', '1M': 'M' };
const load = (tf) => {
  const p = path.join(dataDir, `${symbol}_${TF_FILE[tf] ?? tf}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};
const chartRows = load(chartTf).slice(startIdx);
const chartEnd = chartRows[chartRows.length - 1].openTime;
const kline = (r) => ({ ...r, quoteAssetVolume: 0, numberOfTrades: 0, takerBuyBaseAssetVolume: 0, takerBuyQuoteAssetVolume: 0, ignore: 0 });

const provider = {
  configure() {},
  async getSymbolInfo() {
    const mintick = symbol.startsWith('EUR') ? 0.00001 : 0.01;
    return { ticker: symbol, tickerid: symbol, main_tickerid: symbol, prefix: 'LOCAL', root: symbol, description: symbol,
             type: symbol.startsWith('EUR') ? 'forex' : 'stock', currency: 'USD', basecurrency: '', timezone: 'Etc/UTC',
             session: '24x7', mintick, minmove: 1, pricescale: Math.round(1 / mintick), pointvalue: 1, volumetype: 'base' };
  },
  async getMarketData(tickerId, timeframe) {
    const tf = String(timeframe);
    if (TF_FILE[tf] === TF_FILE[chartTf]) return chartRows.map(kline);
    const rows = load(tf);
    if (!rows) throw new Error(`no fixture for timeframe ${tf}`);
    return rows.filter((r) => r.openTime <= chartEnd).map(kline);
  },
};

async function loadPineTS() {
  const entry = fileURLToPath(import.meta.resolve('pinets'));
  if (!tvTiming) return import(pathToFileURL(entry).href);
  const anchor = 'function Dd(t){return async(...e)=>{const i=[],r=Pd(e,i),n=ne(r,wa,Md),';
  let src = fs.readFileSync(entry, 'utf8');
  if (!src.includes(anchor)) throw new Error('PineTS bundle changed; the --tv-timing patch targets pinets@0.11.0');
  src = 'globalThis.__secArgs=(r)=>{const o={symbol:r[0],timeframe:r[1],expression:r[2]};' +
        'for(let k=3;k<r.length;k++){const z=r[k];' +
        'if(z&&typeof z==="object"&&!Array.isArray(z)&&!("array" in z)&&("lookahead" in z||"gaps" in z||"calc_bars_count" in z))Object.assign(o,z);' +
        'else if(k===3)o.gaps=z;else if(k===4)o.lookahead=z;}return o;};\n' +
        src.replace(anchor, 'function Dd(t){return async(...e)=>{const i=[],r=Pd(e,i),n=(r.length>=3&&r[2] instanceof W)?__secArgs(r):ne(r,wa,Md),');
  const patched = path.join(path.dirname(entry), 'pinets.tv-timing.mjs');
  fs.writeFileSync(patched, src);
  return import(pathToFileURL(patched).href);
}

let source = fs.readFileSync(scriptPath, 'utf8');
for (const [re, rep] of Object.entries(inputsJson ? JSON.parse(inputsJson) : {})) {
  if (!new RegExp(re).test(source)) throw new Error(`input override did not match: ${re}`);
  source = source.replace(new RegExp(re), rep);
}

const { PineTS } = await loadPineTS();
const pine = new PineTS(provider, symbol, chartTf);
pine.setAlertMode('all');
const t0 = Date.now();
const ctx = await pine.run(source);
const plots = {};
for (const [k, v] of Object.entries(ctx.plots || {})) plots[k] = v.data.map((d) => ({ time: d.time, value: d.value }));
fs.writeFileSync(outPath, JSON.stringify({ ms: Date.now() - t0, plots, alerts: ctx.alerts || [] }));

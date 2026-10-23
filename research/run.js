#!/usr/bin/env node
// Strategy tournament harness.
//
//   node research/run.js <candidate.js | baseline:<id> | baselines> [--split dev|holdout] [--market US|IN|both]
//                        [--cost 5] [--borrow 50] [--params '{"k":1}'] [--json]
//
// PROTOCOL
//   dev     : prices truncated at 2020-12-31 in memory; strategies trade calendar years 2013-2020.
//   holdout : full history; strategies trade 2021 through the latest date. Use ONLY for the final verdict.
//   Costs 5 bps per side on traded weight, 50 bps/yr borrow fee on shorts, gross exposure capped at 1x.
//   Score = mean of the US and India Sharpe ratios.
"use strict";
const fs = require("fs");
const path = require("path");

global.window = globalThis;
const ROOT = path.resolve(__dirname, "..");
require(path.join(ROOT, "docs/js/stats.js"));
require(path.join(ROOT, "docs/js/strategies.js"));
const Portfolio = require(path.join(ROOT, "docs/js/portfolio.js"));

const SPLITS = {
  dev: { from: 2013, to: 2020, cutoff: "2020-12-31" },
  holdout: { from: 2021, to: 2100, cutoff: null },
};

let _full = null;
function loadMarkets(split) {
  if (!_full) _full = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/data/market.json"), "utf8"));
  const cut = SPLITS[split].cutoff;
  const out = {};
  for (const [mk, m] of Object.entries(_full.markets)) {
    if (!cut) { out[mk] = m; continue; }
    const n = m.dates.findIndex((d) => d > cut);
    const k = n < 0 ? m.dates.length : n;
    const closes = {};
    for (const [s, a] of Object.entries(m.closes)) closes[s] = a.slice(0, k);
    out[mk] = { dates: m.dates.slice(0, k), closes, groups: m.groups };
  }
  return { markets: out, meta: _full.meta };
}

function resolve(spec) {
  if (spec.startsWith("baseline:")) {
    const id = spec.slice(9);
    const d = Portfolio.BASELINES.find((b) => b.id === id);
    if (!d) throw new Error("unknown baseline " + id + "; have " + Portfolio.BASELINES.map((b) => b.id).join(", "));
    return d;
  }
  const p = path.resolve(spec);
  delete require.cache[p];
  return require(p);
}

function evaluate(def, opts) {
  const { markets, meta } = loadMarkets(opts.split);
  const sp = SPLITS[opts.split];
  const res = { id: def.id, name: def.name, split: opts.split, cost: opts.cost, borrow: opts.borrow, markets: {} };
  const mks = opts.market === "both" ? ["US", "IN"] : [opts.market];
  for (const mk of mks) {
    const t0 = Date.now();
    const r = Portfolio.walkForward(markets[mk], def, {
      from: sp.from, to: sp.to, cost: opts.cost, borrow: opts.borrow, params: opts.params,
      deps: { Stats: globalThis.Stats, Strat: globalThis.Strat, meta },
    });
    res.markets[mk] = { metrics: r.metrics, years: r.years, ms: Date.now() - t0 };
    if (opts.keepSeries) res.markets[mk].series = { dates: r.dates, eq: r.eq };
  }
  const sh = mks.map((m) => res.markets[m].metrics.sharpe);
  res.score = sh.reduce((a, b) => a + b, 0) / sh.length;
  return res;
}

const f = (v, d = 2) => (isFinite(v) ? v.toFixed(d) : "nan");
const p = (v) => (isFinite(v) ? (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%" : "nan");
function printRow(r) {
  const cells = Object.entries(r.markets).map(([m, x]) =>
    `${m}: Sh ${f(x.metrics.sharpe)} CAGR ${p(x.metrics.cagr)} DD ${p(x.metrics.maxDD)} TO ${f(x.metrics.turnoverPerYear, 1)}x gross ${f(x.metrics.avgGross)}`);
  console.log(`${(r.name || r.id).padEnd(28)} score ${f(r.score)} | ${cells.join(" | ")}`);
}

function main() {
  const argv = process.argv.slice(2);
  const opt = { split: "dev", market: "both", cost: 5, borrow: 50, params: {}, json: false };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--split") opt.split = argv[++i];
    else if (a === "--market") opt.market = argv[++i];
    else if (a === "--cost") opt.cost = +argv[++i];
    else if (a === "--borrow") opt.borrow = +argv[++i];
    else if (a === "--params") opt.params = JSON.parse(argv[++i]);
    else if (a === "--json") opt.json = true;
    else pos.push(a);
  }
  if (!SPLITS[opt.split]) throw new Error("split must be dev or holdout");
  const target = pos[0] || "baselines";
  const defs = target === "baselines" ? Portfolio.BASELINES : [resolve(target)];
  const out = defs.map((d) => evaluate(d, opt));
  if (opt.json) console.log(JSON.stringify(out.length === 1 ? out[0] : out, null, 1));
  else {
    console.log(`split=${opt.split} cost=${opt.cost}bps borrow=${opt.borrow}bps/yr`);
    out.forEach(printRow);
    if (out.length === 1) for (const [m, x] of Object.entries(out[0].markets))
      console.log(`  ${m} by year: ` + x.years.map((y) => `${y.year} ${p(y.ret)}`).join("  "));
  }
}

if (require.main === module) main();
module.exports = { evaluate, loadMarkets, SPLITS };

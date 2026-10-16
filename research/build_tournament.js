#!/usr/bin/env node
// Runs every baseline and candidate walk-forward from 2013 to the latest price on both markets and
// writes docs/data/tournament.json for the site (dev = 2013-2020, holdout = 2021 onward).
//   node research/build_tournament.js
"use strict";
const fs = require("fs");
const path = require("path");
global.window = globalThis;
const ROOT = path.resolve(__dirname, "..");
require(path.join(ROOT, "docs/js/stats.js"));
require(path.join(ROOT, "docs/js/strategies.js"));
const Portfolio = require(path.join(ROOT, "docs/js/portfolio.js"));

const SPLIT = "2021-01-01";
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/data/market.json"), "utf8"));
const candDir = path.join(ROOT, "research/candidates");
const candidates = fs.readdirSync(candDir).filter((f) => f.endsWith(".js") && !f.startsWith("_")).sort()
  .map((f) => Object.assign(require(path.join(candDir, f)), { kind: "candidate", file: "research/candidates/" + f }));
let prereg = null;
try { prereg = JSON.parse(fs.readFileSync(path.join(ROOT, "research/preregistration.json"), "utf8")); } catch (e) { /* none yet */ }

const defs = [...candidates, ...Portfolio.BASELINES];
const out = { generated: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC", split: SPLIT, prereg, markets: {}, strategies: [] };

for (const mk of ["US", "IN"]) {
  const M = data.markets[mk];
  out.markets[mk] = { dates: null };
}

const segment = (eq, dates, a, b) => {
  const i0 = dates.findIndex((d) => d >= a), i1 = b ? dates.findIndex((d) => d >= b) : dates.length;
  const s = eq.slice(i0, (i1 < 0 ? dates.length : i1)), ds = dates.slice(i0, (i1 < 0 ? dates.length : i1));
  return Portfolio.metricsOf(s, ds);
};

for (const def of defs) {
  const row = { id: def.id, name: def.name, short: def.short || def.name, description: def.description, kind: def.kind || "candidate", markets: {} };
  for (const mk of ["US", "IN"]) {
    const t0 = Date.now();
    const r = Portfolio.walkForward(data.markets[mk], def, {
      from: 2013, to: 2100, cost: 5, borrow: 50,
      deps: { Stats: globalThis.Stats, Strat: globalThis.Strat, meta: data.meta },
    });
    // weekly points keep the file small; the last point is always kept
    const keep = [];
    for (let i = 0; i < r.dates.length; i += 5) keep.push(i);
    if (keep[keep.length - 1] !== r.dates.length - 1) keep.push(r.dates.length - 1);
    if (!out.markets[mk].dates) out.markets[mk].dates = keep.map((i) => r.dates[i]);
    row.markets[mk] = {
      dev: segment(r.eq, r.dates, "2013-01-01", SPLIT),
      holdout: segment(r.eq, r.dates, SPLIT, null),
      full: r.metrics,
      years: r.years,
      eq: keep.map((i) => +r.eq[i].toFixed(5)),
      gross: keep.map((i) => +r.gross[i].toFixed(3)),
    };
    process.stderr.write(`${def.id} ${mk} ${Date.now() - t0}ms  dev Sh ${row.markets[mk].dev.sharpe.toFixed(2)}  holdout Sh ${row.markets[mk].holdout.sharpe.toFixed(2)}\n`);
  }
  const avg = (k) => (row.markets.US[k].sharpe + row.markets.IN[k].sharpe) / 2;
  row.devScore = avg("dev");
  row.holdoutScore = avg("holdout");
  out.strategies.push(row);
}
fs.writeFileSync(path.join(ROOT, "docs/data/tournament.json"), JSON.stringify(out));
console.log(out.strategies.map((s) => `${s.name.padEnd(30)} dev ${s.devScore.toFixed(2)}  holdout ${s.holdoutScore.toFixed(2)}`).join("\n"));

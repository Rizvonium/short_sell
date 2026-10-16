// Portfolio walk-forward engine shared by the browser and the Node research harness.
// Strategies see the market only through a guarded context: asking for any price after
// "today" throws, so look-ahead bias is caught at run time instead of hoped away.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Portfolio = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function makeCtx(M, deps) {
    const closes = M.closes;
    const ctx = {
      syms: Object.keys(closes),
      groups: M.groups,
      dates: M.dates,
      meta: deps.meta || {},
      Stats: deps.Stats,
      Strat: deps.Strat,
      now: -1,
      memory: {},
      _w: {},
      _eq: 1,
      // price of sym on day i (i <= now), null when missing
      px(sym, i) {
        if (i > ctx.now) throw new Error(`look-ahead: ${sym}@${i} requested on day ${ctx.now}`);
        const a = closes[sym];
        return a && i >= 0 ? a[i] : null;
      },
      // prices of sym for days [from, to], to <= now
      window(sym, from, to) {
        if (to > ctx.now) throw new Error(`look-ahead: ${sym} window to ${to} requested on day ${ctx.now}`);
        return closes[sym].slice(Math.max(0, from), to + 1);
      },
      // last n prices up to and including today
      hist(sym, n) {
        const e = ctx.now + 1;
        return closes[sym].slice(Math.max(0, e - n), e);
      },
      // current (drifted) portfolio weights as a fraction of equity
      current() { return Object.assign({}, ctx._w); },
      // equity so far (starts at 1)
      equity() { return ctx._eq; },
      // first calendar index on/after an ISO date
      idx(d) { const i = M.dates.findIndex((x) => x >= d); return i < 0 ? M.dates.length : i; },
    };
    return ctx;
  }

  function metricsOf(eq, dates, extra) {
    const r = [];
    for (let i = 1; i < eq.length; i++) r.push(eq[i - 1] > 0 ? eq[i] / eq[i - 1] - 1 : 0);
    const n = r.length || 1;
    const m = r.reduce((s, v) => s + v, 0) / n;
    const sd = Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, n - 1));
    let peak = eq[0], mdd = 0;
    for (const v of eq) { if (v > peak) peak = v; mdd = Math.min(mdd, v / peak - 1); }
    const years = n / 252, total = eq[eq.length - 1] / eq[0] - 1;
    const cagr = eq[eq.length - 1] > 0 ? Math.pow(eq[eq.length - 1] / eq[0], 1 / years) - 1 : -1;
    return Object.assign({
      total, cagr,
      vol: sd * Math.sqrt(252),
      sharpe: sd > 0 ? (m / sd) * Math.sqrt(252) : 0,
      maxDD: mdd,
      calmar: mdd < 0 ? cagr / -mdd : 0,
      days: n,
      from: dates[0], to: dates[dates.length - 1],
    }, extra || {});
  }

  // Walk-forward run. def = {create(params) -> {form?(ctx), weights(ctx)}} or a ready strategy object.
  // Each calendar year in [from, to]: form(ctx) is called at the previous close, then weights(ctx)
  // every day. weights returns a {sym: weight} target (fraction of equity, gross capped at maxGross)
  // or null to keep holding (positions drift with prices). Costs are charged on traded weight;
  // shorts pay a borrow fee. Fills at the close of the decision day.
  function walkForward(M, def, o) {
    o = Object.assign({ cost: 5, borrow: 50, maxGross: 1, params: {} }, o);
    const deps = o.deps || { Stats: (typeof window !== "undefined" ? window : globalThis).Stats, Strat: (typeof window !== "undefined" ? window : globalThis).Strat };
    const ctx = makeCtx(M, deps);
    const strat = def.create ? def.create(Object.assign({}, def.defaults || {}, o.params)) : def;
    const dates = M.dates, closes = M.closes;
    let start = ctx.idx(`${o.from}-01-01`);
    let end = ctx.idx(`${o.to + 1}-01-01`) - 1;
    end = Math.min(end, dates.length - 1);
    if (start < 1 || end <= start) throw new Error(`no data for ${o.from}-${o.to}`);
    let eq = 1, w = {}, curYear = null, turnover = 0, grossSum = 0, namesSum = 0, tradeDays = 0;
    const eqs = [], ds = [], gross = [], years = [];
    for (let t = start; t <= end; t++) {
      const y = +dates[t].slice(0, 4);
      if (y !== curYear) {
        curYear = y;
        if (years.length) years[years.length - 1].ret = eq / years[years.length - 1].eq0 - 1;
        years.push({ year: y, eq0: eq });
        ctx.now = t - 1; ctx._w = w; ctx._eq = eq;
        if (strat.form) strat.form(ctx);
      }
      ctx.now = t; ctx._w = w; ctx._eq = eq;
      const target = strat.weights(ctx);
      if (target) {
        const clean = {};
        let g = 0;
        for (const [s, v] of Object.entries(target)) {
          if (!isFinite(v) || Math.abs(v) < 1e-9 || !closes[s] || closes[s][t] == null) continue;
          clean[s] = v; g += Math.abs(v);
        }
        if (g > o.maxGross) for (const s in clean) clean[s] *= o.maxGross / g;
        let to = 0;
        const keys = new Set([...Object.keys(clean), ...Object.keys(w)]);
        for (const s of keys) to += Math.abs((clean[s] || 0) - (w[s] || 0));
        if (to > 1e-7) { eq *= 1 - (to * o.cost) / 1e4; turnover += to; tradeDays++; }
        w = clean;
      }
      eqs.push(eq); ds.push(dates[t]);
      let g = 0, k = 0;
      for (const s in w) { g += Math.abs(w[s]); k++; }
      gross.push(g); grossSum += g; namesSum += k;
      if (t === end) break;
      let rp = 0, borrow = 0;
      const rs = {};
      for (const s in w) {
        const p0 = closes[s][t], p1 = closes[s][t + 1];
        const r = p0 && p1 ? p1 / p0 - 1 : 0;
        rs[s] = r; rp += w[s] * r;
        if (w[s] < 0) borrow += (-w[s] * o.borrow) / 1e4 / 252;
      }
      const growth = 1 + rp - borrow;
      if (growth <= 0) { eq = 0; w = {}; continue; }
      eq *= growth;
      for (const s in w) w[s] = (w[s] * (1 + rs[s])) / growth;
    }
    years[years.length - 1].ret = eq / years[years.length - 1].eq0 - 1;
    const n = eqs.length;
    const m = metricsOf(eqs, ds, {
      turnoverPerYear: (turnover / n) * 252,
      avgGross: grossSum / n,
      avgNames: namesSum / n,
      tradeDays,
    });
    return { eq: eqs, dates: ds, gross, years: years.map((y) => ({ year: y.year, ret: y.ret })), metrics: m };
  }

  // ---------- pair-book adapter: classic pair strategies inside the portfolio engine ----------
  // Each year: rank every same-sector pair over the trailing trainDays (ADF t-stat or Gatev SSD),
  // keep the best N, optionally grid-tune each pair's parameters on that window, then trade them
  // with equal capital. Positions are share-based, so held legs drift like a real account.
  function pairBook(key, opt) {
    opt = Object.assign({ N: 10, trainDays: 756, select: "adf", tune: false, params: {}, cost: 5 }, opt);
    let book = [], dirty = false;
    function form(ctx) {
      const S = ctx.Strat.STRATEGIES[key], T = ctx.now, from = T - opt.trainDays + 1;
      const cands = [];
      if (from >= 0) {
        for (const syms of Object.values(ctx.groups)) {
          for (let i = 0; i < syms.length; i++) for (let j = i + 1; j < syms.length; j++) {
            const a = syms[i], b = syms[j];
            const pa = ctx.window(a, from, T), pb = ctx.window(b, from, T);
            if (pa.some((v) => v == null) || pb.some((v) => v == null)) continue;
            let score;
            if (opt.select === "ssd") {
              let s = 0;
              for (let k = 0; k < pa.length; k++) s += (pa[k] / pa[0] - pb[k] / pb[0]) ** 2;
              score = s;
            } else score = ctx.Stats.cointegration(pa, pb).adf;
            if (isFinite(score)) cands.push({ a, b, score, pa, pb });
          }
        }
      }
      cands.sort((x, y) => x.score - y.score);
      const keep = cands.slice(0, opt.N);
      const old = new Map(book.map((p) => [p.a + "|" + p.b, p]));
      book = keep.map((c) => {
        let params = Object.assign({}, S.defaults, opt.params);
        if (opt.tune && Object.keys(S.grid).length) {
          let best = -Infinity;
          for (const g of ctx.Strat.gridList(S.grid)) {
            const r = ctx.Strat.simulate(c.pa, c.pb, key, g, Math.min(260, c.pa.length - 2), c.pa.length - 1, opt.cost);
            if (r.metrics.sharpe > best) { best = r.metrics.sharpe; params = r.params; }
          }
        }
        const prev = old.get(c.a + "|" + c.b);
        return { a: c.a, b: c.b, from, params, st: prev ? prev.st : 0, sa: prev ? prev.sa : 0, sb: prev ? prev.sb : 0 };
      });
      dirty = true;
    }
    function weights(ctx) {
      const S = ctx.Strat.STRATEGIES[key], t = ctx.now, E = ctx.equity();
      let changed = dirty;
      dirty = false;
      for (const p of book) {
        const pa = ctx.window(p.a, p.from, t), pb = ctx.window(p.b, p.from, t);
        const L = pa.length - 1;
        if (pa[L] == null || pb[L] == null || pa.some((v) => v == null) || pb.some((v) => v == null)) continue;
        const built = S.build(pa, pb, p.params);
        const s = built.st[L];
        if (s !== p.st) {
          const [wa, wb] = s ? built.weights(L) : [0, 0];
          p.sa = (wa / book.length) * E / pa[L];
          p.sb = (wb / book.length) * E / pb[L];
          p.st = s;
          changed = true;
        }
      }
      if (!changed) return null;
      const target = {};
      for (const p of book) {
        if (!p.st) continue;
        target[p.a] = (target[p.a] || 0) + (p.sa * ctx.px(p.a, t)) / E;
        target[p.b] = (target[p.b] || 0) + (p.sb * ctx.px(p.b, t)) / E;
      }
      return target;
    }
    return { form, weights };
  }

  const pairDef = (key, name, extra) => ({
    id: "pair-" + key + (extra && extra.tune ? "-tuned" : ""),
    name, kind: "baseline",
    description: `Top-10 same-sector pairs by ${extra && extra.select === "ssd" ? "minimum price distance" : "cointegration"} over the prior 3 years, traded with the ${name} rule${extra && extra.tune ? ", parameters tuned per pair on the formation window" : ""}.`,
    defaults: {},
    create: (p) => pairBook(key, Object.assign({}, extra || {}, p)),
  });

  const BASELINES = [
    pairDef("zscore", "Z-score pairs"),
    pairDef("zscore", "Z-score pairs (tuned)", { tune: true }),
    pairDef("kalman", "Kalman pairs"),
    pairDef("bollinger", "Bollinger pairs"),
    pairDef("distance", "Gatev distance", { select: "ssd" }),
    pairDef("reversal", "Buy-the-laggard pairs"),
    pairDef("momentum", "Buy-the-leader pairs"),
    {
      id: "long-universe", name: "Long whole universe", kind: "benchmark",
      description: "Equal weight long every stock, rebalanced each January. Not market-neutral; shown for context.",
      defaults: {},
      create() {
        let pending = false;
        return {
          form() { pending = true; },
          weights(ctx) {
            if (!pending) return null;
            pending = false;
            const live = ctx.syms.filter((s) => ctx.px(s, ctx.now) != null);
            const t = {};
            for (const s of live) t[s] = 1 / live.length;
            return t;
          },
        };
      },
    },
  ];

  return { makeCtx, walkForward, metricsOf, pairBook, BASELINES };
});

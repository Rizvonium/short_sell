// Twin divergence: a replication of Chen, Chen, Chen & Li (2019, Management Science),
// "Empirical Investigation of an Equity Pairs Trading Strategy", adapted to a ~50-stock market.
//
// Paper: for each stock, find the 50 stocks whose monthly returns correlated most with it over the
// previous 5 years ("pairs"); the pairs portfolio is their equal-weight return, and beta is the
// stock's regression slope on it over the same 5 years. Each month,
//   RetDiff_i = beta_i * (pairsReturn_i - rf) - (ownReturn_i - rf)   (last month's returns);
// stocks with high RetDiff (they lagged their twins) are bought, low RetDiff are sold short,
// held one month (decile 10 minus decile 1).
//
// Adaptation here (paper design first, then a few cost/risk changes; 14 dev configurations in all):
//   - formation each January on up to 5 years (1260 days) of NON-overlapping weekly returns
//     (monthly returns would give only 60 points for ~50 candidates); twins chosen within the
//     stock's own market, any sector, by raw return correlation (as in the paper);
//   - k = 10 twins per stock (paper: 50 out of thousands; here ~20% of the market);
//   - beta = OLS slope of the stock's weekly return on the equal-weight twin return;
//   - signal: RetDiff = beta * twinReturn - ownReturn over the last WEEK (rf ignored), divided by
//     the stock's formation residual vol vs its twins (so volatile names do not always win the sort);
//     the paper's one-month horizon had ~zero Sharpe in these large caps (params look/step = 21);
//   - long the top quintile, short the bottom quintile, equal weight, rebalanced weekly with a
//     buffer (a held name stays while it ranks in the top/bottom 40%) to cut turnover;
//   - each stock is hedged with beta x its equal-weight twin basket (long laggard / short its twins,
//     short leader / long its twins), legs netted into one book scaled to gross 1: the trade is the
//     stock-vs-twins gap itself (residual reversal) rather than a raw long/short stock sort.
//     hedge: false, standardize: false, look = step = 21, hold = 0.2 is the paper's plain rule.
(function (root) {
  "use strict";

  function create(params) {
    const P = params;
    let model = null; // [{ s, peers, beta }]
    let last = -Infinity;
    const book = [];

    function form(ctx) {
      const T = ctx.now, W = P.week;
      const syms = ctx.syms.slice().sort();
      // sample points T, T-W, T-2W, ... within the formation window
      const pts = [];
      for (let t = T; t - W >= Math.max(0, T - P.formDays); t -= W) pts.push(t);
      const n = pts.length;
      const R = {}, valid = [];
      for (const s of syms) {
        const r = new Float64Array(n).fill(NaN);
        let c = 0;
        for (let k = 0; k < n; k++) {
          const p1 = ctx.px(s, pts[k]), p0 = ctx.px(s, pts[k] - W);
          if (p0 > 0 && p1 > 0) { r[k] = p1 / p0 - 1; c++; }
        }
        if (c >= P.minObs) { R[s] = r; valid.push(s); }
      }
      const m = valid.length;
      const corr = (x, y) => {
        let c = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
        for (let k = 0; k < n; k++) {
          const a = x[k], b = y[k];
          if (a !== a || b !== b) continue;
          c++; sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b;
        }
        if (c < P.minObs) return NaN;
        const vx = sxx - (sx * sx) / c, vy = syy - (sy * sy) / c;
        return vx > 0 && vy > 0 ? (sxy - (sx * sy) / c) / Math.sqrt(vx * vy) : NaN;
      };
      // similarity returns: raw (the paper) or residual to the equal-weight market return
      let S = R;
      const mbeta = {};
      {
        const Sr = {};
        const mk = new Float64Array(n).fill(NaN);
        for (let k = 0; k < n; k++) {
          let a = 0, c = 0;
          for (const s of valid) { const v = R[s][k]; if (v === v) { a += v; c++; } }
          if (c * 2 >= m) mk[k] = a / c;
        }
        for (const s of valid) {
          const r = R[s], xs = [], ys = [];
          for (let k = 0; k < n; k++) if (r[k] === r[k] && mk[k] === mk[k]) { xs.push(mk[k]); ys.push(r[k]); }
          const { alpha, beta } = ctx.Stats.ols(xs, ys);
          const e = new Float64Array(n).fill(NaN);
          for (let k = 0; k < n; k++) if (r[k] === r[k] && mk[k] === mk[k]) e[k] = r[k] - alpha - beta * mk[k];
          Sr[s] = e;
          mbeta[s] = isFinite(beta) ? beta : 1;
        }
        if (P.twinCorr === "resid") S = Sr;
      }
      const C = Array.from({ length: m }, () => new Float64Array(m).fill(NaN));
      for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) C[i][j] = C[j][i] = corr(S[valid[i]], S[valid[j]]);
      const list = [];
      for (let i = 0; i < m; i++) {
        const cand = [];
        for (let j = 0; j < m; j++) if (j !== i && isFinite(C[i][j])) cand.push([C[i][j], valid[j]]);
        cand.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : 1));
        const peers = cand.slice(0, P.k).map((c) => c[1]);
        if (peers.length < Math.min(P.k, 3)) continue;
        // beta of the stock on its equal-weight twin portfolio (formation data only)
        const xs = [], ys = [], own = R[valid[i]];
        for (let k = 0; k < n; k++) {
          if (own[k] !== own[k]) continue;
          let a = 0, c = 0;
          for (const p of peers) { const v = R[p][k]; if (v === v) { a += v; c++; } }
          if (c * 2 < peers.length) continue;
          xs.push(a / c); ys.push(own[k]);
        }
        if (xs.length < P.minObs) continue;
        let beta = ctx.Stats.ols(xs, ys).beta;
        beta = isFinite(beta) ? Math.max(P.betaMin, Math.min(P.betaMax, beta)) : 1;
        // residual sd per formation interval of own - beta * twins (to standardize RetDiff)
        let e1 = 0, e2 = 0;
        for (let k = 0; k < xs.length; k++) { const e = ys[k] - beta * xs[k]; e1 += e; e2 += e * e; }
        const sd = Math.sqrt(Math.max(1e-12, (e2 - (e1 * e1) / xs.length) / (xs.length - 1)));
        list.push({ s: valid[i], peers, beta, sd, mb: mbeta[valid[i]] });
      }
      model = list;
    }

    function tranche(ctx) {
      const t = ctx.now, L = P.look;
      if (!model || t - L < 0) return {};
      const cache = {};
      const ret = (s) => {
        if (s in cache) return cache[s];
        const p0 = ctx.px(s, t - L), p1 = ctx.px(s, t);
        return (cache[s] = p0 > 0 && p1 > 0 ? p1 / p0 - 1 : NaN);
      };
      const sig = [];
      for (const e of model) {
        const own = ret(e.s);
        if (!isFinite(own)) continue;
        let a = 0, c = 0;
        for (const p of e.peers) { const v = ret(p); if (isFinite(v)) { a += v; c++; } }
        if (c * 2 < e.peers.length) continue;
        let d = e.beta * (a / c) - own; // > 0: the stock lagged its twins
        if (P.standardize) d /= e.sd * Math.sqrt(L / P.week);
        sig.push({ s: e.s, d });
      }
      const N = sig.length;
      if (N < 10) return {};
      sig.sort((a, b) => b.d - a.d || (a.s < b.s ? -1 : 1));
      const q = Math.max(1, Math.floor(N * P.frac));
      // buffer rule (cost mitigation, Novy-Marx & Velikov 2016): a held name stays in its leg
      // while it ranks within the top/bottom `hold` fraction; free slots go to the strongest
      // new names. hold = frac is the plain quintile sort.
      const hq = Math.max(q, Math.floor(N * P.hold));
      const prev = book.length ? book[book.length - 1] : {};
      const pick = (ranked) => {
        const out = [], keepSet = new Set();
        for (let i = 0; i < hq; i++) if (prev[ranked[i].s] && (prev[ranked[i].s] > 0) === (ranked === sig)) keepSet.add(ranked[i].s);
        for (const x of ranked.slice(0, hq)) if (keepSet.has(x.s) && out.length < q) out.push(x.s);
        for (const x of ranked) { if (out.length >= q) break; if (!out.includes(x.s)) out.push(x.s); }
        return out;
      };
      let longs = pick(sig), shorts = pick(sig.slice().reverse());
      let rw = null;
      if (P.weighting === "rank") {
        // all names, weight proportional to centred rank of RetDiff (Lo-MacKinlay style contrarian)
        rw = {};
        longs = []; shorts = [];
        sig.forEach((x, i) => {
          const v = (N - 1) / 2 - i;
          if (v > 0) { longs.push(x.s); rw[x.s] = v; } else if (v < 0) { shorts.push(x.s); rw[x.s] = -v; }
        });
      }
      // leg sizes: dollar neutral (0.5 / 0.5), or market-beta neutral (gross 1, sum w * beta = 0)
      let gl = 0.5, gs = 0.5;
      if (P.betaNeutral) {
        const mb = {};
        for (const e of model) mb[e.s] = e.mb;
        const bl = longs.reduce((a, s) => a + mb[s], 0) / longs.length;
        const bs = shorts.reduce((a, s) => a + mb[s], 0) / shorts.length;
        if (bl > 0.2 && bs > 0.2) { gl = bs / (bl + bs); gs = bl / (bl + bs); }
        gl = Math.max(0.35, Math.min(0.65, gl)); gs = 1 - gl; // keep close to dollar neutral
      }
      const w = {};
      const sum = (a) => a.reduce((u, s) => u + (rw ? rw[s] : 1), 0);
      const sl = sum(longs), ss = sum(shorts);
      for (const s of longs) w[s] = (gl * (rw ? rw[s] : 1)) / sl;
      for (const s of shorts) w[s] = (-gs * (rw ? rw[s] : 1)) / ss;
      if (P.hedge) {
        // trade each divergence as a stock-vs-twins pair: offset every stock with beta x its
        // equal-weight twin basket, net the book, rescale to gross 1 (residual reversal)
        const byS = {};
        for (const e of model) byS[e.s] = e;
        const h = {};
        for (const s in w) {
          h[s] = (h[s] || 0) + w[s];
          const e = byS[s], live = e.peers.filter((p) => ctx.px(p, t) > 0);
          for (const p of live) h[p] = (h[p] || 0) - (w[s] * e.beta) / live.length;
        }
        let g = 0;
        for (const s in h) g += Math.abs(h[s]);
        for (const s in h) h[s] = g > 0 ? h[s] / g : 0;
        return h;
      }
      return w;
    }

    function weights(ctx) {
      if (ctx.now - last < P.step) return null;
      last = ctx.now;
      book.push(tranche(ctx));
      while (book.length > P.tranches) book.shift();
      const out = {};
      for (const tr of book) for (const s in tr) out[s] = (out[s] || 0) + tr[s] / book.length;
      return out;
    }

    return { form, weights };
  }

  const def = {
    id: "twin-divergence",
    name: "Twin divergence",
    short: "Twins",
    description:
      "Every stock gets ten 'twins': the stocks that moved most like it over the past five years. Each week, buy the stocks that fell furthest behind their twins and short the ones that ran furthest ahead, hedging each with its twins, betting the gap closes.",
    defaults: {
      k: 10,           // twins per stock
      formDays: 1260,  // 5-year formation window
      week: 5,         // formation return interval (trading days): non-overlapping weekly returns
      minObs: 100,     // min weekly returns for eligibility / correlation / beta
      betaMin: 0, betaMax: 3,
      look: 5,         // RetDiff measured over the last week (paper: month; months did not work here)
      step: 5,         // rebalance weekly
      tranches: 1,     // overlapping holding portfolios (1 = plain, no overlap)
      frac: 0.2,       // long top quintile, short bottom quintile
      hold: 0.4,       // buffer: keep a held name while it stays in the top/bottom `hold` fraction
      twinCorr: "raw", // rank twins by "raw" weekly-return correlation (the paper) or "resid" (market-adjusted)
      weighting: "equal", // "equal" (top/bottom frac) or "rank" (every name, centred-rank weights)
      hedge: true,     // hedge each stock with beta x its twin basket (pair trade) instead of a plain L/S sort
      betaNeutral: false, // size legs so long and short market betas offset (dollar net within +-0.15)
      standardize: true, // divide RetDiff by the stock's formation residual vol vs its twins
    },
    create,
  };
  if (typeof module === "object" && module.exports) module.exports = def;
  else (root.Candidates = root.Candidates || {})[def.id] = def;
})(typeof window !== "undefined" ? window : globalThis);

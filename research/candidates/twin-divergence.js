// Twin divergence. Built on Chen, Chen, Chen & Li (2019, Management Science), "Empirical
// Investigation of an Equity Pairs Trading Strategy": every stock is paired with a portfolio of its
// most correlated stocks (its "twins"), and the signal is how far the stock has fallen behind or run
// ahead of that twin portfolio. Adapted to a ~50-stock universe and to daily data:
//   - twins: the k stocks (same market, any sector) whose market-adjusted daily returns correlate
//     most with the stock's over the past 5 years (formation, refit each January);
//   - twin portfolio: the non-negative least-squares basket of those twins that best replicates
//     the stock's daily returns (a "synthetic twin"); the paper's equal-weight x beta basket is
//     available as basket: "ew";
//   - signal: the stock's cumulative residual return vs its synthetic twin, measured against its
//     own 20-day mean in units of the formation residual volatility; daily residuals are clipped at
//     3 sigma so single-day jumps (likely news) are not mistaken for a divergence that will close;
//   - trade: when the stock lags its twin by more than 2 units, buy it and short the twin basket
//     (the reverse when it runs ahead); close when the spread is back at its 20-day mean.
//     Each trade is a beta-hedged pair; trades net into one book, gross capped at 1.
// mode: "monthly" runs the paper's own rule instead (monthly quintile sort on last month's
// RetDiff = beta * twinReturn - ownReturn, long the laggards, short the leaders).
(function (root) {
  "use strict";

  function create(params) {
    const P = params;
    let model = null; // { list: [{ s, peers, wts, beta, sig }] }
    let lastRebal = -Infinity;
    const book = []; // monthly mode: overlapping tranches
    const pos = {}; // band mode: sym -> { side, peers, wts, beta, sig, sh: { sym: shares } }

    // ---------- formation: twins, twin-portfolio weights, residual volatility (data <= now) ----------
    function form(ctx) {
      const T = ctx.now;
      const from = Math.max(0, T - P.formDays);
      const n = T - from;
      const syms = ctx.syms.slice().sort();
      const R = {}, valid = [];
      for (const s of syms) {
        const w = ctx.window(s, from, T);
        const r = new Float64Array(n).fill(NaN);
        let c = 0;
        for (let k = 1; k < w.length; k++) {
          const a = w[k - 1], b = w[k];
          if (a > 0 && b > 0) { r[k - 1] = b / a - 1; c++; }
        }
        if (c >= P.minObs) { R[s] = r; valid.push(s); }
      }
      const m = valid.length;
      // similarity returns: raw (the paper), or residual to the equal-weight market so that twins
      // share more than the market factor (industry peers, sister companies)
      let S = R;
      if (P.twinCorr === "resid") {
        S = {};
        const mk = new Float64Array(n).fill(NaN);
        for (let k = 0; k < n; k++) {
          let a = 0, c = 0;
          for (const s of valid) { const v = R[s][k]; if (v === v) { a += v; c++; } }
          if (c * 2 >= m) mk[k] = a / c;
        }
        for (const s of valid) {
          const xs = [], ys = [], r = R[s];
          for (let k = 0; k < n; k++) if (r[k] === r[k] && mk[k] === mk[k]) { xs.push(mk[k]); ys.push(r[k]); }
          const { alpha, beta } = ctx.Stats.ols(xs, ys);
          const e = new Float64Array(n).fill(NaN);
          for (let k = 0; k < n; k++) if (r[k] === r[k] && mk[k] === mk[k]) e[k] = r[k] - alpha - beta * mk[k];
          S[s] = e;
        }
      }
      // pairwise-complete Pearson correlations of daily similarity returns
      const C = Array.from({ length: m }, () => new Float64Array(m));
      for (let i = 0; i < m; i++) {
        const x = S[valid[i]];
        for (let j = i + 1; j < m; j++) {
          const y = S[valid[j]];
          let c = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
          for (let k = 0; k < n; k++) {
            const a = x[k], b = y[k];
            if (a !== a || b !== b) continue;
            c++; sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b;
          }
          let rho = NaN;
          if (c >= P.minObs) {
            const vx = sxx - (sx * sx) / c, vy = syy - (sy * sy) / c;
            if (vx > 0 && vy > 0) rho = (sxy - (sx * sy) / c) / Math.sqrt(vx * vy);
          }
          C[i][j] = C[j][i] = rho;
        }
      }
      const list = [];
      for (let i = 0; i < m; i++) {
        const cand = [];
        for (let j = 0; j < m; j++) if (j !== i && isFinite(C[i][j])) cand.push([C[i][j], valid[j]]);
        cand.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : 1));
        const peers = cand.slice(0, P.k).map((c) => c[1]);
        if (peers.length < Math.min(P.k, 3)) continue;
        // regress the stock's raw daily returns on its twins' (days where all are present)
        const x = R[valid[i]];
        const rows = [], ys = [];
        for (let k = 0; k < n; k++) {
          if (x[k] !== x[k]) continue;
          const row = peers.map((p) => R[p][k]);
          if (row.some((v) => v !== v)) continue;
          rows.push(row); ys.push(x[k]);
        }
        if (ys.length < P.minObs) continue;
        const K = peers.length, T2 = ys.length;
        const mx = new Float64Array(K);
        let my = 0;
        for (let r = 0; r < T2; r++) { my += ys[r]; for (let a = 0; a < K; a++) mx[a] += rows[r][a]; }
        my /= T2; for (let a = 0; a < K; a++) mx[a] /= T2;
        const A = Array.from({ length: K }, () => new Float64Array(K)), b = new Float64Array(K);
        for (let r = 0; r < T2; r++) {
          const y = ys[r] - my;
          for (let a = 0; a < K; a++) {
            const xa = rows[r][a] - mx[a];
            b[a] += xa * y;
            for (let c = a; c < K; c++) A[a][c] += xa * (rows[r][c] - mx[c]);
          }
        }
        for (let a = 0; a < K; a++) for (let c = 0; c < a; c++) A[a][c] = A[c][a];
        let wts;
        if (P.basket === "nnls") {
          // non-negative least squares by projected coordinate descent on the normal equations:
          // the long-only twin basket with the smallest residual variance
          wts = new Float64Array(K);
          for (let it = 0; it < 500; it++) {
            let delta = 0;
            for (let a = 0; a < K; a++) {
              let g = b[a];
              for (let c = 0; c < K; c++) if (c !== a) g -= A[a][c] * wts[c];
              const v = Math.max(0, g / A[a][a]);
              delta = Math.max(delta, Math.abs(v - wts[a]));
              wts[a] = v;
            }
            if (delta < 1e-12) break;
          }
        } else {
          // the paper: equal-weight twins, scaled by the stock's OLS beta to that basket
          let sxy = 0, sxx = 0;
          for (let a = 0; a < K; a++) { sxy += b[a] / K; for (let c = 0; c < K; c++) sxx += A[a][c] / (K * K); }
          const beta = Math.max(P.betaMin, Math.min(P.betaMax, sxx > 0 ? sxy / sxx : 1));
          wts = new Float64Array(K).fill(beta / K);
        }
        const used = [], uw = [];
        for (let a = 0; a < K; a++) if (wts[a] > 1e-6) { used.push(peers[a]); uw.push(wts[a]); }
        let tot = uw.reduce((u, v) => u + v, 0);
        if (!used.length || tot <= 0) continue;
        if (tot > P.betaMax) { for (let a = 0; a < uw.length; a++) uw[a] *= P.betaMax / tot; tot = P.betaMax; }
        // residual volatility of the stock against its twin portfolio
        let s1 = 0, s2 = 0;
        for (let r = 0; r < T2; r++) {
          let f = 0;
          for (let a = 0; a < K; a++) { const ia = used.indexOf(peers[a]); if (ia >= 0) f += uw[ia] * rows[r][a]; }
          const e = ys[r] - f;
          s1 += e; s2 += e * e;
        }
        const sig = Math.sqrt(Math.max(1e-12, (s2 - (s1 * s1) / T2) / (T2 - 1)));
        list.push({ s: valid[i], peers: used, wts: uw, beta: tot, sig });
      }
      model = { list };
    }

    // ---------- monthly mode: the paper's cross-sectional sort ----------
    function tranche(ctx) {
      const t = ctx.now, H = P.H;
      if (!model || t - H < 0) return {};
      const ret = (s) => {
        const p0 = ctx.px(s, t - H), p1 = ctx.px(s, t);
        return p0 > 0 && p1 > 0 ? p1 / p0 - 1 : NaN;
      };
      const cache = {};
      const r = (s) => (s in cache ? cache[s] : (cache[s] = ret(s)));
      const sig = [];
      for (const e of model.list) {
        const own = r(e.s);
        if (!isFinite(own)) continue;
        let s = 0, ws = 0;
        e.peers.forEach((p, a) => { const v = r(p); if (isFinite(v)) { s += e.wts[a] * v; ws += e.wts[a]; } });
        if (ws * 2 < e.beta) continue;
        let d = (s * e.beta) / ws - own; // RetDiff > 0: the stock lagged its twins
        if (P.standardize) d /= e.sig * Math.sqrt(H);
        sig.push({ s: e.s, d });
      }
      const N = sig.length;
      if (N < 10) return {};
      sig.sort((a, b) => b.d - a.d || (a.s < b.s ? -1 : 1));
      const w = {};
      const q = Math.max(1, Math.floor(N * P.frac));
      for (let i = 0; i < q; i++) {
        w[sig[i].s] = 0.5 / q;
        w[sig[N - 1 - i].s] = -0.5 / q;
      }
      return w;
    }

    function monthly(ctx) {
      const t = ctx.now;
      if (t - lastRebal < P.step) return null;
      lastRebal = t;
      book.push(tranche(ctx));
      while (book.length > P.tranches) book.shift();
      const out = {};
      for (const tr of book) for (const s in tr) out[s] = (out[s] || 0) + tr[s] / book.length;
      return out;
    }

    // ---------- band mode: daily stock-vs-twin spread, open on a stretch, close on reversion ----------
    // x = cumulative residual return vs the twin portfolio over the last L days (daily residuals
    // clipped at +-winsor sigmas); z = (x_today - mean(x)) / scale. With zNorm "formation" the
    // scale is the formation residual sd times sqrt((L^2 - 1) / (6L)), the typical spread of a
    // random walk's levels around their L-day mean: entries then cluster in turbulent markets,
    // when liquidity-driven divergences are largest and revert most (Nagel 2012), and calm markets,
    // where a 2-sd move of a tiny rolling sd does not pay for the round trip, are mostly skipped.
    // zNorm "rolling" is the classic Bollinger band (rolling L-day sd).
    function zOf(ctx, s, peers, wts, beta, sig, lr) {
      const t = ctx.now, L = P.L, cap = P.winsor > 0 ? P.winsor * sig : Infinity;
      if (t - L < 0) return NaN;
      let x = 0, sx = 0, sxx = 0, n = 0;
      for (let d = t - L + 1; d <= t; d++) {
        const ri = lr(s, d);
        if (ri !== ri) return NaN;
        let a = 0, ws = 0;
        for (let j = 0; j < peers.length; j++) {
          const v = lr(peers[j], d);
          if (v === v) { a += wts[j] * (Math.exp(v) - 1); ws += wts[j]; }
        }
        if (ws * 2 < beta) return NaN;
        const e = Math.exp(ri) - 1 - (a * beta) / ws; // residual return vs the twin portfolio
        x += e > cap ? cap : e < -cap ? -cap : e;
        sx += x; sxx += x * x; n++;
      }
      const m = sx / n, v = sxx / n - m * m;
      if (P.zNorm === "formation") return (x - m) / (sig * Math.sqrt((n * n - 1) / (6 * n)));
      if (!(v > 1e-14)) return NaN;
      return (x - m) / Math.sqrt((v * n) / (n - 1));
    }

    function band(ctx) {
      if (!model) return null;
      const t = ctx.now, E = ctx.equity();
      const cache = new Map();
      const lr = (s, d) => {
        const key = s + "@" + d;
        let v = cache.get(key);
        if (v === undefined) {
          const p0 = ctx.px(s, d - 1), p1 = ctx.px(s, d);
          v = p0 > 0 && p1 > 0 ? Math.log(p1 / p0) : NaN;
          cache.set(key, v);
        }
        return v;
      };
      let changed = false;
      // exits first; each open trade is judged on its own spread (the twins it was opened with)
      for (const s of Object.keys(pos).sort()) {
        const q = pos[s];
        const z = zOf(ctx, s, q.peers, q.wts, q.beta, q.sig, lr);
        if (!isFinite(z)) continue;
        if ((q.side > 0 && z >= -P.exit) || (q.side < 0 && z <= P.exit)) { delete pos[s]; changed = true; }
      }
      // entries, strongest stretch first, while there is room under the gross cap
      const cands = [];
      for (const e of model.list) {
        if (pos[e.s]) continue;
        const z = zOf(ctx, e.s, e.peers, e.wts, e.beta, e.sig, lr);
        if (isFinite(z) && Math.abs(z) > P.entry) cands.push({ e, z });
      }
      cands.sort((a, b) => Math.abs(b.z) - Math.abs(a.z) || (a.e.s < b.e.s ? -1 : 1));
      const u = 1 / (2 * P.slots);
      const target = () => {
        const w = {};
        for (const s in pos) for (const [k, sh] of Object.entries(pos[s].sh)) {
          const p = ctx.px(k, t);
          if (p > 0) w[k] = (w[k] || 0) + (sh * p) / E;
        }
        return w;
      };
      const grossOf = (w) => { let g = 0; for (const k in w) g += Math.abs(w[k]); return g; };
      let w = target();
      for (const { e, z } of cands) {
        const side = z < 0 ? 1 : -1; // z < 0: the stock fell behind its twins -> buy it
        const pi = ctx.px(e.s, t);
        let ws = 0;
        e.peers.forEach((p, a) => { if (ctx.px(p, t) > 0) ws += e.wts[a]; });
        if (!(pi > 0) || ws * 2 < e.beta) continue;
        // stock leg u of equity; twin legs u * beta split by the basket weights (beta-neutral pair)
        const sh = { [e.s]: (side * u * E) / pi };
        e.peers.forEach((p, a) => {
          const pp = ctx.px(p, t);
          if (pp > 0) sh[p] = (sh[p] || 0) - (side * u * e.beta * e.wts[a] * E) / ws / pp;
        });
        const trial = Object.assign({}, w);
        for (const [k, v] of Object.entries(sh)) trial[k] = (trial[k] || 0) + (v * ctx.px(k, t)) / E;
        if (grossOf(trial) > P.maxGross) continue;
        pos[e.s] = { side, peers: e.peers, wts: e.wts, beta: e.beta, sig: e.sig, sh };
        w = trial;
        changed = true;
      }
      // positions are held in shares, so untouched trades drift and cost nothing
      return changed ? target() : null;
    }

    return { form, weights: (ctx) => (P.mode === "band" ? band(ctx) : monthly(ctx)) };
  }

  const def = {
    id: "twin-divergence",
    name: "Twin divergence",
    short: "Twins",
    description:
      "Each stock gets a 'synthetic twin': the basket of its closest look-alike stocks that best tracks it. When a stock falls unusually far behind its twin, buy it and short the twin; when it runs ahead, do the opposite; close once the gap is back to normal.",
    defaults: {
      mode: "band",
      k: 5,              // twin candidates per stock
      twinCorr: "resid", // rank twins by "raw" (the paper) or market-adjusted ("resid") correlation
      basket: "nnls",    // "nnls" replicating basket, or "ew" equal weight x OLS beta (the paper)
      formDays: 1260,    // formation window: 5 years of daily returns (or what is available)
      minObs: 500,       // min daily returns for a stock to be eligible
      betaMin: 0.25, betaMax: 2.5,
      // band mode
      L: 20, entry: 2, exit: 0, // spread vs its 20-day mean: open beyond 2, close at the mean
      winsor: 3,         // clip daily residuals at 3 formation sigmas (jumps = news, not noise)
      zNorm: "formation",
      slots: 15,         // each trade puts 1/(2*slots) of equity in the stock leg
      maxGross: 1,
      // monthly mode (the paper's rule)
      H: 21, step: 21, tranches: 1, standardize: false, frac: 0.2,
    },
    create,
  };
  if (typeof module === "object" && module.exports) module.exports = def;
  else (root.Candidates = root.Candidates || {})[def.id] = def;
})(typeof window !== "undefined" ? window : globalThis);

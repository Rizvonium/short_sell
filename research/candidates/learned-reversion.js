// Learned reversion: a tiny ridge-regression model that predicts how much a same-sector price
// ratio will revert over the next h days, fitted each January on the trailing formation window
// only (every training target ends on or before the formation date). Pairs are entered when the
// predicted reversion clears a multiple of round-trip cost, sized by prediction, and held
// (dollar-neutral, share-based) until the prediction fades. Works in Node and the browser.
(function (root) {
  "use strict";

  const FEATS = ["z20", "z60", "z250", "gap1", "gap5", "gap20", "z60*adfQ", "z60*hlQ", "z60*corr"];
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // ---- rolling helpers on a log-ratio series r and log prices la, lb ----
  function meanSd(r, from, to) {
    let s = 0, ss = 0;
    const n = to - from + 1;
    for (let i = from; i <= to; i++) { s += r[i]; ss += r[i] * r[i]; }
    const m = s / n;
    return { m, sd: Math.sqrt(Math.max(ss / n - m * m, 0) * n / (n - 1)) };
  }
  function diffSd(r, from, to) { // sd of daily changes r[i]-r[i-1], i in (from, to]
    let s = 0, ss = 0, n = 0;
    for (let i = from + 1; i <= to; i++) { const d = r[i] - r[i - 1]; s += d; ss += d * d; n++; }
    const m = s / n;
    return Math.sqrt(Math.max(ss / n - m * m, 0) * n / (n - 1));
  }
  // pair-level quality on the trailing W days ending at k: ADF t, AR(1) half-life, return corr
  function pairStats(Stats, r, la, lb, k, W) {
    const from = k - W + 1;
    const adfT = Stats.adf(r.slice(from, k + 1), 1).t;
    let mx = 0, my = 0, n = W - 1;
    for (let i = from + 1; i <= k; i++) { mx += r[i - 1]; my += r[i] - r[i - 1]; }
    mx /= n; my /= n;
    let sxx = 0, sxy = 0;
    for (let i = from + 1; i <= k; i++) { const dx = r[i - 1] - mx; sxx += dx * dx; sxy += dx * (r[i] - r[i - 1] - my); }
    const b = sxx > 0 ? sxy / sxx : 0;
    const hl = b < 0 ? -Math.log(2) / Math.log(1 + b) : Infinity;
    let ma = 0, mb = 0;
    for (let i = from + 1; i <= k; i++) { ma += la[i] - la[i - 1]; mb += lb[i] - lb[i - 1]; }
    ma /= n; mb /= n;
    let saa = 0, sbb = 0, sab = 0;
    for (let i = from + 1; i <= k; i++) {
      const x = la[i] - la[i - 1] - ma, y = lb[i] - lb[i - 1] - mb;
      saa += x * x; sbb += y * y; sab += x * y;
    }
    const corr = saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
    return { adfT: isFinite(adfT) ? adfT : 0, hl, corr };
  }
  // Feature vector at index k (needs k >= W). Signed so that a high spread gives positive z's;
  // the model target is the *fall* of the spread, so reversion shows up as positive coefficients.
  function features(r, k, st, P) {
    const z = [];
    for (const L of [20, 60, 250]) {
      const { m, sd } = meanSd(r, k - L + 1, k);
      z.push(sd > 0 ? (r[k] - m) / sd : 0);
    }
    const v = diffSd(r, k - P.volWin, k);
    if (!(v > 0)) return null;
    const g = [1, 5, 20].map((j) => (r[k] - r[k - j]) / (v * Math.sqrt(j)));
    const adfQ = clamp(-st.adfT / 3, 0, 2);
    const hlQ = clamp(20 / st.hl, 0, 2);
    const z60 = z[1];
    const x = [z[0], z[1], z[2], g[0], g[1], g[2], z60 * adfQ, z60 * hlQ, z60 * st.corr];
    return { x: x.map((u) => clamp(u, -P.wins, P.wins)), v };
  }

  // Spread at decision index k: log ratio (beta = 1) or log A - beta log B with beta fitted by OLS on
  // the trailing W days ending at k (no data after k), clipped to keep the hedge sensible.
  function spreadAt(la, lb, k, W, P) {
    if (P.hedge !== "beta") return { r: la.map((v, q) => v - lb[q]), beta: 1 };
    let mx = 0, my = 0;
    for (let i = k - W + 1; i <= k; i++) { mx += lb[i]; my += la[i]; }
    mx /= W; my /= W;
    let sxx = 0, sxy = 0;
    for (let i = k - W + 1; i <= k; i++) { const dx = lb[i] - mx; sxx += dx * dx; sxy += dx * (la[i] - my); }
    const beta = clamp(sxx > 0 ? sxy / sxx : 1, P.betaMin, P.betaMax);
    return { r: la.map((v, q) => v - beta * lb[q]), beta };
  }

  // Ridge without intercept (features are odd in the spread sign, so the fit is sign-symmetric).
  // Features are scaled by their RMS; penalty lambda = alpha * n in those units.
  function ridge(X, y, alpha) {
    const n = X.length, k = X[0].length;
    const sc = new Array(k).fill(0);
    for (const row of X) for (let i = 0; i < k; i++) sc[i] += row[i] * row[i];
    for (let i = 0; i < k; i++) sc[i] = Math.sqrt(sc[i] / n) || 1;
    const A = Array.from({ length: k }, () => new Float64Array(k + 1));
    for (let r = 0; r < n; r++) {
      const row = X[r];
      for (let i = 0; i < k; i++) {
        const xi = row[i] / sc[i];
        for (let j = 0; j < k; j++) A[i][j] += xi * row[j] / sc[j];
        A[i][k] += xi * y[r];
      }
    }
    for (let i = 0; i < k; i++) A[i][i] += alpha * n;
    for (let c = 0; c < k; c++) {
      let p = c;
      for (let q = c + 1; q < k; q++) if (Math.abs(A[q][c]) > Math.abs(A[p][c])) p = q;
      [A[c], A[p]] = [A[p], A[c]];
      for (let q = 0; q < k; q++) {
        if (q === c) continue;
        const f = A[q][c] / A[c][c];
        for (let j = c; j <= k; j++) A[q][j] -= f * A[c][j];
      }
    }
    const b = new Array(k);
    for (let i = 0; i < k; i++) b[i] = A[i][k] / A[i][i] / sc[i];
    let sse = 0, sst = 0;
    for (let r = 0; r < n; r++) {
      let f = 0;
      for (let i = 0; i < k; i++) f += X[r][i] * b[i];
      sse += (y[r] - f) ** 2; sst += y[r] * y[r];
    }
    return { b, r2: 1 - sse / sst, n };
  }

  // Time-series validation inside the formation window: fit on samples whose targets end before
  // the last valDays, score on the rest (targets still end <= formation date). Picks the ridge
  // penalty, then calibrates predictions by the validation slope of y on yhat (clipped to [0,1]),
  // so a model that does not generalise trades little or not at all. Final fit uses all samples.
  function fitValidated(X, Y, K, cut, P) {
    if (X.length < 200) return null;
    const tr = [], va = [];
    for (let i = 0; i < X.length; i++) (K[i] + P.h <= cut ? tr : va).push(i);
    if (tr.length < 200 || va.length < 100) return null;
    const Xt = tr.map((i) => X[i]), Yt = tr.map((i) => Y[i]);
    let best = null;
    for (const alpha of P.alphas) {
      const m = ridge(Xt, Yt, alpha);
      let sxy = 0, sxx = 0, sse = 0, sst = 0;
      for (const i of va) {
        let f = 0;
        for (let j = 0; j < X[i].length; j++) f += X[i][j] * m.b[j];
        sxy += f * Y[i]; sxx += f * f; sse += (Y[i] - f) ** 2; sst += Y[i] * Y[i];
      }
      const r2 = 1 - sse / sst, slope = sxx > 0 ? sxy / sxx : 0;
      if (!best || r2 > best.r2) best = { alpha, r2, slope };
    }
    const m = ridge(X, Y, best.alpha);
    return { b: m.b, r2: m.r2, alpha: best.alpha, valR2: best.r2, calib: clamp(best.slope, 0, 1) };
  }

  function create(P) {
    let model = null, tradeSet = [], cache = new Map();
    const pos = new Map(); // key -> {a, b, sa, sb, dir, t0}
    const diag = { years: [] };

    function logs(ctx, sym, from, to) {
      const p = ctx.window(sym, from, to);
      if (p.length !== to - from + 1 || p.some((v) => !(v > 0))) return null;
      return p.map(Math.log);
    }

    function form(ctx) {
      const T = ctx.now, W = P.statWin;
      const from = Math.max(0, T - P.trainDays - W - 20);
      const n = T - from + 1;
      if (n < W + 2 * P.h + 60) { model = null; tradeSet = []; return; }
      const L = {};
      for (const s of ctx.syms) L[s] = logs(ctx, s, from, T);
      const X = [], Y = [], K = [], ranked = [];
      for (const syms of Object.values(ctx.groups)) {
        for (let i = 0; i < syms.length; i++) for (let j = i + 1; j < syms.length; j++) {
          const a = syms[i], b = syms[j], la = L[a], lb = L[b];
          if (!la || !lb) continue;
          const r0 = la.map((v, q) => v - lb[q]);
          // training samples every `step` days; target window [k, k+h] ends <= T (no leakage)
          for (let k = n - 1 - P.h; k >= W + 20; k -= P.step) {
            const gk = from + k, key = a + "|" + b + "|" + gk;
            let row = cache.get(key);
            if (row === undefined) {
              const { r } = spreadAt(la, lb, k, W, P);
              const st = pairStats(ctx.Stats, r, la, lb, k, W);
              const f = features(r, k, st, P);
              row = f ? { x: f.x, v: f.v, corr: st.corr, dy: r[k + P.h] - r[k] } : null;
              cache.set(key, row);
            }
            if (!row || row.corr < P.minCorr) continue; // train on pairs that co-move at sample time
            const y = -row.dy / (row.v * Math.sqrt(P.h)); // k + h <= T: uses data <= T only
            X.push(row.x); Y.push(clamp(y, -P.wins, P.wins)); K.push(k);
          }
          // tradeable pairs: strongest trailing-window ratio cointegration
          const st = pairStats(ctx.Stats, r0, la, lb, n - 1, Math.min(n, P.selWin));
          ranked.push({ a, b, adfT: st.adfT, corr: st.corr });
        }
      }
      model = fitValidated(X, Y, K, n - 1 - P.valDays, P);
      ranked.sort((u, w) => u.adfT - w.adfT);
      tradeSet = ranked.filter((c) => c.corr >= P.minCorr).slice(0, P.nTrade);
      diag.years.push({ date: ctx.dates[T], n: X.length, r2: model && model.r2, alpha: model && model.alpha, valR2: model && model.valR2, calib: model && model.calib,
        coef: model && Object.fromEntries(FEATS.map((f, i) => [f, +model.b[i].toFixed(3)])) });
    }

    function weights(ctx) {
      if (!model) return null;
      const t = ctx.now, W = P.statWin, from = t - W - 25, E = ctx.equity();
      const c = P.cost / 1e4; // per-side cost per unit traded weight
      const L = {};
      const lg = (s) => (s in L ? L[s] : (L[s] = logs(ctx, s, from, t)));
      // score every tradeable pair
      const scored = [];
      for (const p of tradeSet) {
        const la = lg(p.a), lb = lg(p.b);
        if (!la || !lb) continue;
        const k = la.length - 1, { r, beta } = spreadAt(la, lb, k, W, P);
        const st = pairStats(ctx.Stats, r, la, lb, k, W);
        const f = features(r, k, st, P);
        if (!f) continue;
        let yhat = 0;
        for (let i = 0; i < f.x.length; i++) yhat += f.x[i] * model.b[i];
        yhat *= model.calib;
        // expected return per unit gross of a dollar-neutral position over h days
        const er = (Math.abs(yhat) * f.v * Math.sqrt(P.h)) / (1 + beta);
        scored.push({ key: p.a + "|" + p.b, a: p.a, b: p.b, dir: yhat > 0 ? -1 : 1, er, beta });
      }
      const byKey = new Map(scored.map((s) => [s.key, s]));
      let changed = false;
      // exits: prediction faded, flipped, or time stop
      for (const [key, q] of pos) {
        const s = byKey.get(key);
        if (!s || s.dir !== q.dir || s.er < P.exitMult * 2 * c || t - q.t0 > P.maxHold) { pos.delete(key); changed = true; }
      }
      // entries: best predicted reversion above a cost-aware hurdle, while slots remain
      const cand = scored.filter((s) => !pos.has(s.key) && s.er >= P.entryMult * 2 * c).sort((u, w) => w.er - u.er);
      for (const s of cand) {
        if (pos.size >= P.maxPairs) break;
        const g = (Math.min(s.er / (P.entryMult * 2 * c), P.sizeCap) / P.maxPairs) * P.gross;
        const pa = ctx.px(s.a, t), pb = ctx.px(s.b, t);
        pos.set(s.key, { a: s.a, b: s.b, dir: s.dir, t0: t, sa: (s.dir * g / (1 + s.beta)) * E / pa, sb: (-s.dir * g * s.beta / (1 + s.beta)) * E / pb });
        changed = true;
      }
      if (!changed) return null;
      const target = {};
      for (const q of pos.values()) {
        target[q.a] = (target[q.a] || 0) + (q.sa * ctx.px(q.a, t)) / E;
        target[q.b] = (target[q.b] || 0) + (q.sb * ctx.px(q.b, t)) / E;
      }
      return target;
    }
    return { form, weights, diag };
  }

  const def = {
    id: "learned-reversion",
    name: "Learned reversion (ridge)",
    short: "Ridge",
    description: "Each year a small regularized regression learns, from the past three years only, how far a stretched price ratio between two same-sector stocks tends to snap back over the following month. The strategy bets on the pairs where the predicted snap-back comfortably beats trading costs, betting more when the prediction is stronger.",
    defaults: {
      h: 20,            // forecast horizon (days)
      step: 5,          // training sample spacing (days)
      trainDays: 756,   // formation window of training targets (~3y)
      statWin: 252,     // trailing window for ADF / half-life / correlation features
      selWin: 504,      // window for ranking tradeable pairs
      hedge: "ratio",  // "ratio": spread = log A - log B (dollar-neutral); "beta": log A - beta log B (trailing OLS)
      betaMin: 0.5, betaMax: 2,
      volWin: 60,       // spread volatility window for scaling
      alphas: [0.01, 0.1, 1, 10], // ridge penalties (fraction of n, RMS-scaled features), chosen by validation
      valDays: 252,     // last year of the formation window is the validation fold
      wins: 4,          // winsorize features / target
      nTrade: 30,       // tradeable pairs per year
      minCorr: 0.3,     // minimal return correlation for tradeable pairs
      maxPairs: 10,     // max simultaneous pairs
      gross: 1,         // gross budget when all slots are full at base size
      sizeCap: 1.5,     // max size multiple of base slot
      entryMult: 2,     // enter when expected return >= entryMult x round-trip cost
      exitMult: 0.5,    // exit when expected return < exitMult x round-trip cost
      maxHold: 60,      // time stop (days)
      cost: 5,          // bps per side assumed for the hurdle
    },
    create,
  };
  if (typeof module === "object" && module.exports) module.exports = def;
  else (root.Candidates = root.Candidates || {})[def.id] = def;
})(typeof window !== "undefined" ? window : globalThis);

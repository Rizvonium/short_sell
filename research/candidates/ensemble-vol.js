// Ensemble mean-reversion pairs with continuous sizing and inverse-volatility risk budgets.
// Each year (form): pick same-sector pairs = union of the best Engle-Granger ADF pairs over the
// trailing 3 years and the closest Gatev SSD pairs over the trailing year (all data <= ctx.now),
// keeping only pairs whose Engle-Granger spread half-life is at most 126 days.
// Each day: three classic signals on the log spread (ratio Bollinger z, rolling-regression residual z,
// Gatev normalized distance) are clipped and averaged; the average z maps continuously to a position
// in [-1, 1] (dead zone near 0, full size at |z| >= full). Each pair gets a risk budget proportional to
// 1 / (its spread volatility), the budgets sum to 6x equity at full size (book gross capped at 1), and a pair is only re-traded when
// its target moves more than a no-trade band away from what it holds. Legs are dollar-neutral.
// Works in Node (module.exports) and the browser (window.Candidates[id]).
(function (root) {
  "use strict";

  const clip = (v, c) => (v > c ? c : v < -c ? -c : v);

  // Ratio Bollinger z of log(A/B) over the last L days (population sd, as in the library).
  function ratioZ(A, B, t, L) {
    if (t - L + 1 < 0) return NaN;
    let s = 0, ss = 0;
    const r0 = A[t] - B[t];
    for (let i = t - L + 1; i <= t; i++) {
      const r = A[i] - B[i] - r0;
      if (r !== r) return NaN;
      s += r; ss += r * r;
    }
    const m = s / L, v = ss / L - m * m;
    return v > 1e-14 ? -m / Math.sqrt(v) : NaN;
  }
  // Rolling OLS of log A on log B over the last L days; z = today's residual / residual sd.
  function regZ(A, B, t, L) {
    if (t - L + 1 < 0) return NaN;
    const a0 = A[t], b0 = B[t];
    let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (let i = t - L + 1; i <= t; i++) {
      const x = B[i] - b0, y = A[i] - a0;
      if (x !== x || y !== y) return NaN;
      sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
    }
    const cxx = sxx - (sx * sx) / L, cxy = sxy - (sx * sy) / L, cyy = syy - (sy * sy) / L;
    if (cxx <= 1e-12) return NaN;
    const b = cxy / cxx, alpha = (sy - b * sx) / L;
    const sd = Math.sqrt(Math.max(cyy - b * cxy, 1e-14) / (L - 2));
    return -alpha / sd; // residual at t in centred coordinates (x_t = y_t = 0)
  }
  // Sample sd of daily changes of log(A/B) over the last L days.
  function spreadVol(A, B, t, L) {
    if (t - L < 0) return NaN;
    let s = 0, ss = 0;
    for (let i = t - L + 1; i <= t; i++) {
      const d = A[i] - B[i] - A[i - 1] + B[i - 1];
      if (d !== d) return NaN;
      s += d; ss += d * d;
    }
    const m = s / L, v = (ss - L * m * m) / (L - 1);
    return v > 1e-14 ? Math.sqrt(v) : NaN;
  }
  // Gatev formation sd of the normalized price distance over the F days before block start c.
  function gatevSigma(A, B, c, F) {
    const s0 = c - F;
    if (s0 < 0) return NaN;
    let s = 0, ss = 0;
    for (let i = s0; i < c; i++) {
      const d = Math.exp(A[i] - A[s0]) - Math.exp(B[i] - B[s0]);
      if (d !== d) return NaN;
      s += d; ss += d * d;
    }
    const m = s / F, v = (ss - F * m * m) / (F - 1);
    return v > 1e-14 ? Math.sqrt(v) : NaN;
  }

  function create(params) {
    const p = params;
    let LP = null, filled = -1;
    let book = [];     // {a, b, sig, anchor, sa, sb}
    let dirty = false;

    // cache log prices up to today (only via ctx.window, never beyond ctx.now)
    function fill(ctx) {
      const T = ctx.now;
      if (!LP) {
        LP = {};
        for (const s of ctx.syms) LP[s] = new Float64Array(ctx.dates.length).fill(NaN);
      }
      if (T <= filled) return;
      const o = filled + 1;
      for (const s of ctx.syms) {
        const w = ctx.window(s, o, T), arr = LP[s];
        for (let k = 0; k < w.length; k++) { const v = w[k]; arr[o + k] = v != null && v > 0 ? Math.log(v) : NaN; }
      }
      filled = T;
    }

    function form(ctx) {
      fill(ctx);
      const T = ctx.now, F = p.F;
      const cands = [];
      for (const syms of Object.values(ctx.groups)) {
        for (let i = 0; i < syms.length; i++) for (let j = i + 1; j < syms.length; j++) {
          const a = syms[i], b = syms[j], A = LP[a], B = LP[b];
          if (!A || !B) continue;
          // need complete data over the ADF window (trainDays)
          // ADF window: up to trainDays of complete data ending today, at least minDays
          let from = Math.max(0, T - p.trainDays + 1);
          for (let k = T; k >= from; k--) if (A[k] !== A[k] || B[k] !== B[k]) { from = k + 1; break; }
          if (T - from + 1 < p.minDays) continue;
          let ssd = 0;
          const s0 = T - F + 1;
          for (let k = s0; k <= T; k++) { const d = Math.exp(A[k] - A[s0]) - Math.exp(B[k] - B[s0]); ssd += d * d; }
          const co = ctx.Stats.cointegration(ctx.window(a, from, T), ctx.window(b, from, T));
          // a spread that needs longer than maxHL days to halve cannot be harvested by these signals
          if (!(co.halfLife > 0 && co.halfLife <= p.maxHL)) continue;
          cands.push({ a, b, ssd, adf: isFinite(co.adf) ? co.adf : Infinity });
        }
      }
      const pick = new Set();
      cands.slice().sort((x, y) => x.adf - y.adf).slice(0, p.nADF).forEach((c) => pick.add(c.a + "|" + c.b));
      cands.slice().sort((x, y) => x.ssd - y.ssd).slice(0, p.nSSD).forEach((c) => pick.add(c.a + "|" + c.b));
      const old = new Map(book.map((q) => [q.a + "|" + q.b, q]));
      book = cands.filter((c) => pick.has(c.a + "|" + c.b)).map((c) => {
        const prev = old.get(c.a + "|" + c.b);
        return { a: c.a, b: c.b, sig: NaN, anchor: -1, sa: prev ? prev.sa : 0, sb: prev ? prev.sb : 0 };
      });
      // positions in pairs that dropped out are closed (they are simply not in the new book)
      dirty = true;
    }

    // Ensemble target in [-1, 1] (+1 = long A / short B) and inverse spread vol, or null.
    function signal(q, t) {
      const A = LP[q.a], B = LP[q.b];
      if (A[t] !== A[t] || B[t] !== B[t]) return null;
      // Gatev block: renormalize every Tg days, formation sigma from the F days before the block
      if (q.anchor < 0 || t - q.anchor >= p.Tg) { q.anchor = t; q.sig = gatevSigma(A, B, t, p.F); }
      const vol = spreadVol(A, B, t, p.volL);
      if (!(vol > 0)) return null;
      const z1 = ratioZ(A, B, t, p.Lr);
      const z2 = regZ(A, B, t, p.Lg);
      const z3 = q.sig > 0 && q.anchor >= 1 ? (Math.exp(A[t] - A[q.anchor - 1]) - Math.exp(B[t] - B[q.anchor - 1])) / q.sig : NaN;
      let s = 0, n = 0;
      const zs = [z1, z2, z3];
      for (let k = 0; k < 3; k++) if (p.use[k] && zs[k] === zs[k]) { s += clip(zs[k], p.clip); n++; }
      if (!n) return null;
      const zbar = s / n;                       // >0: A rich vs B -> short the spread
      const mag = clip((Math.abs(zbar) - p.dead) / (p.full - p.dead), 1);
      const pos = mag > 0 ? -Math.sign(zbar) * mag : 0;
      return { pos, dir: -Math.sign(zbar), iv: 1 / vol };
    }

    function weights(ctx) {
      fill(ctx);
      const t = ctx.now, E = ctx.equity();
      const sigs = book.map((q) => signal(q, t));
      let ivSum = 0, nLive = 0;
      for (const s of sigs) if (s) { ivSum += s.iv; nLive++; }
      let changed = dirty;
      dirty = false;
      book.forEach((q, k) => {
        const s = sigs[k];
        q.tr = false;
        const pa = ctx.px(q.a, t), pb = ctx.px(q.b, t);
        if (pa == null || pb == null) return;
        if (!s) {
          if (q.sa || q.sb) { q.sa = 0; q.sb = 0; q.tr = true; changed = true; }
          return;
        }
        // risk budget: pair's full gross (both legs) when |pos| = 1
        const bud = p.grossScale * (s.iv / ivSum);
        const hpos = (q.sa * pa) / E / (bud / 2); // held position, in units of the full pair position
        // hysteresis: inside the dead zone a position is kept until the ensemble z crosses zero
        // (the classic "exit at the mean" rule); otherwise trade only outside the no-trade band
        if (p.hyst && s.pos === 0 && hpos * s.dir > 0) return;
        const tgt = s.pos;
        const flat = tgt === 0 && (q.sa || q.sb);
        if (Math.abs(tgt - hpos) > p.band || flat) {
          const x = (tgt * bud) / 2;           // dollars per leg, fraction of equity
          q.sa = (x * E) / pa; q.sb = (-x * E) / pb;
          q.tr = true;
          changed = true;
        }
      });
      if (!changed) return null;
      // stock-level book; pairs traded today are scaled by f
      const agg = (f) => {
        const out = {};
        for (const q of book) {
          if (!q.sa && !q.sb) continue;
          const pa = ctx.px(q.a, t), pb = ctx.px(q.b, t);
          if (pa == null || pb == null) continue;
          const m = q.tr ? f : 1;
          out[q.a] = (out[q.a] || 0) + (m * q.sa * pa) / E;
          out[q.b] = (out[q.b] || 0) + (m * q.sb * pb) / E;
        }
        return out;
      };
      const gross = (o) => { let g = 0; for (const s in o) g += Math.abs(o[s]); return g; };
      let out = agg(1);
      const g = gross(out);
      if (g > 1) {
        if (gross(agg(0)) <= 1) {
          // gross cap: ration capital among today's trades only, so untouched pairs are not churned
          let lo = 0, hi = 1;
          for (let it = 0; it < 30; it++) { const mid = (lo + hi) / 2; if (gross(agg(mid)) > 1) hi = mid; else lo = mid; }
          for (const q of book) if (q.tr) { q.sa *= lo; q.sb *= lo; }
        } else {
          for (const q of book) { q.sa /= g; q.sb /= g; }
        }
        out = agg(1);
      }
      return out;
    }

    return { form, weights };
  }

  const def = {
    id: "ensemble-vol",
    name: "Ensemble vol-parity pairs",
    short: "Ensemble",
    description: "Three classic pairs-trading signals vote on each pair of look-alike stocks, and the average vote sets how much to bet that the pair snaps back together. Calmer pairs get more money so each pair carries similar risk, and positions are only adjusted when the target moves meaningfully.",
    defaults: {
      trainDays: 756, minDays: 504, nADF: 15, maxHL: 126,  // Engle-Granger ADF over 3y (as the cointegration baselines)
      F: 252, nSSD: 15, Tg: 126, // Gatev: 12-month formation, 6-month trading blocks
      Lr: 20,                    // ratio Bollinger lookback (library default)
      Lg: 60,                    // rolling-regression lookback (library default)
      use: [1, 1, 1],            // signals in the ensemble: ratio z, regression z, Gatev distance
      clip: 3,                   // each z clipped at +-3
      dead: 1, full: 2,          // position 0 below |zbar|=1, linear to full size at |zbar|=2
      volL: 63,                  // spread-vol window for inverse-vol budgets
      grossScale: 6,             // sum of pair budgets (full-size gross); book gross capped at 1
      hyst: false,               // true: hold inside the dead zone until the ensemble z crosses zero (tested, worse)
      band: 0.5,                 // no-trade band, in units of the pair's full position
    },
    create,
  };
  if (typeof module === "object" && module.exports) module.exports = def;
  else (root.Candidates = root.Candidates || {})[def.id] = def;
})(typeof window !== "undefined" ? window : globalThis);

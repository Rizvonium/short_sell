// Ensemble mean-reversion pairs with continuous sizing and inverse-volatility risk budgets.
// Each year: pick same-sector pairs (top Gatev SSD over 1y, union top Engle-Granger ADF over up to 3y).
// Each day: three classic rules (ratio Bollinger, rolling-regression z, Gatev distance) vote on every
// pair using a jump-robust spread; the pair's position is the average vote, sized by inverse spread vol,
// levered so the trailing-year average gross is 0.8, and rebalanced only outside a no-trade band.
// Works in Node (module.exports) and the browser (window.Candidates[id]).
(function (root) {
  "use strict";

  const clip = (v, c) => (v > c ? c : v < -c ? -c : v);

  // ---- signal kernels on log-price arrays (A, B); every window ends at t (<= today) ----
  // Ratio Bollinger z: (log(A/B)_t - mean) / sd over the last L days (population sd, as in the baseline).
  function ratioZ(A, B, t, L) {
    if (t - L + 1 < 0) return NaN;
    const r0 = A[t] - B[t];
    let s = 0, ss = 0;
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
    return -alpha / sd; // residual at t (centred coordinates: x_t = y_t = 0)
  }
  // Gatev formation sigma for a trading block starting at c: sd of the normalized price distance
  // over the F days before c, prices normalized to 1 at the start of the formation window.
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
  // Gatev distance inside the block: prices renormalized at c-1, divided by the formation sigma.
  function gatevZ(A, B, t, c, sig) {
    if (!(sig > 0) || c < 1) return NaN;
    return (Math.exp(A[t] - A[c - 1]) - Math.exp(B[t] - B[c - 1])) / sig;
  }
  // Sample sd of x over [t-L+1, t]; NaN if any value is missing.
  function sdOf(x, t, L) {
    if (t - L + 1 < 1) return NaN;
    let s = 0, ss = 0;
    for (let i = t - L + 1; i <= t; i++) {
      const d = x[i];
      if (d !== d) return NaN;
      s += d; ss += d * d;
    }
    const m = s / L, v = (ss - L * m * m) / (L - 1);
    return v > 1e-14 ? Math.sqrt(v) : NaN;
  }
  // Entry/exit state machine (same logic as the library's zStateMachine): +1 long spread, -1 short.
  function hyst(r, v, entry, exit, stop) {
    if (v !== v) return;
    if (r.stopped && Math.abs(v) < entry) r.stopped = false;
    if (r.s === 0) {
      if (!r.stopped) { if (v > entry) r.s = -1; else if (v < -entry) r.s = 1; }
    } else if (r.s === 1) {
      if (v > -exit) r.s = 0;
      else if (stop && v < -stop) { r.s = 0; r.stopped = true; }
    } else {
      if (v < exit) r.s = 0;
      else if (stop && v > stop) { r.s = 0; r.stopped = true; }
    }
  }
  const fresh = () => [{ s: 0, stopped: false }, { s: 0, stopped: false }, { s: 0, stopped: false }];

  function create(params) {
    const p = params;
    const W = p.wts, Wsum = W[0] + W[1] + W[2];
    let LP = null, filled = -1;
    let book = [];       // {a, b, Aq, w, X, at, sig, R, sa, sb}
    let anchor = 0;      // first day of the current Gatev trading block
    let lev = 1, dirty = false, ivRef = NaN;

    function fill(ctx) {
      const T = ctx.now;
      if (!LP) {
        LP = {};
        for (const s of ctx.syms) LP[s] = new Float64Array(ctx.dates.length).fill(NaN);
      }
      if (T <= filled) return;
      for (const s of ctx.syms) {
        const w = ctx.window(s, filled + 1, T), arr = LP[s], o = Math.max(0, filled + 1);
        for (let k = 0; k < w.length; k++) { const v = w[k]; arr[o + k] = v != null && v > 0 ? Math.log(v) : NaN; }
      }
      filled = T;
    }

    // Jump-robust spread. Each day's change in log(A/B) is winsorized at +-J sigmas (sigma from the
    // previous volL winsorized changes); the excess is treated as news, i.e. a permanent level shift,
    // and moved into an adjusted log price Aq = log A - cumulative excess. Signals use (Aq, log B).
    function adjStep(q, i) {
      const A = LP[q.a], B = LP[q.b];
      const d = A[i] - B[i] - A[i - 1] + B[i - 1];
      let w = d;
      if (d === d && p.J > 0) {
        let n = 0, s = 0, ss = 0;
        for (let k = Math.max(1, i - p.volL); k < i; k++) { const v = q.w[k]; if (v === v) { n++; s += v; ss += v * v; } }
        if (n >= 20) {
          const m = s / n, cap = p.J * Math.sqrt(Math.max((ss - n * m * m) / (n - 1), 0));
          w = d > cap ? cap : d < -cap ? -cap : d;
        }
      }
      q.w[i] = w;
      if (d === d) q.X += d - w;
      q.Aq[i] = A[i] - q.X;
    }
    function adjBuild(q, T, N) {
      q.Aq = new Float64Array(N).fill(NaN);
      q.w = new Float64Array(N).fill(NaN);
      q.X = 0;
      const i0 = Math.max(1, T - 800);
      q.Aq[i0 - 1] = LP[q.a][i0 - 1];
      for (let i = i0; i <= T; i++) adjStep(q, i);
      q.at = T;
    }

    // Advance pair q to day t (block anchor c, Gatev sigma q.sig). Returns the ensemble position in
    // [-1, 1] (+1 = long A / short B) and the inverse spread vol, or null when data are missing.
    function step(q, t, c) {
      const A = q.Aq, B = LP[q.b];
      if (A[t] !== A[t] || B[t] !== B[t]) return null;
      const vol = sdOf(q.w, t, p.volL);
      if (!(vol > 0)) return null;
      const z0 = W[0] ? ratioZ(A, B, t, p.Lr) : 0;
      const z1 = W[1] ? regZ(A, B, t, p.Lg) : 0;
      const z2 = W[2] ? gatevZ(A, B, t, c, q.sig) : 0;
      let pos;
      if (p.mode === "rules") {
        hyst(q.R[0], z0, p.entry, 0, 0);            // ratio Bollinger: exit at the moving average
        hyst(q.R[1], z1, p.entry, 0.5, 4);          // regression z: exit 0.5, stop 4 (library defaults)
        hyst(q.R[2], z2, p.entry, 0, 0);            // Gatev: exit when normalized prices cross
        pos = (W[0] * q.R[0].s + W[1] * q.R[1].s + W[2] * q.R[2].s) / Wsum;
      } else {
        if (z0 !== z0 || z1 !== z1 || z2 !== z2) return null;
        const C = p.clip;
        pos = -(W[0] * clip(z0, C) + W[1] * clip(z1, C) + W[2] * clip(z2, C)) / (C * Wsum);
      }
      return { pos, iv: 1 / vol };
    }

    function newBlock(c) {
      anchor = c;
      for (const q of book) {
        q.sig = gatevSigma(q.Aq, LP[q.b], c, p.F);
        q.R[2] = { s: 0, stopped: false };
      }
    }

    function form(ctx) {
      fill(ctx);
      const T = ctx.now, F = p.F;
      // --- pair selection on trailing data only: Gatev SSD (1y) and Engle-Granger ADF (up to 3y) ---
      const cands = [];
      for (const syms of Object.values(ctx.groups)) {
        for (let i = 0; i < syms.length; i++) for (let j = i + 1; j < syms.length; j++) {
          const a = syms[i], b = syms[j], A = LP[a], B = LP[b];
          if (!A || !B) continue;
          let ok = T - F + 1 >= 0, ssd = 0;
          const s0 = T - F + 1;
          for (let k = s0; ok && k <= T; k++) {
            const d = Math.exp(A[k] - A[s0]) - Math.exp(B[k] - B[s0]);
            if (d !== d) ok = false; else ssd += d * d;
          }
          if (!ok) continue;
          let from = Math.max(0, T - p.adfDays + 1);
          for (let k = T; k >= from; k--) if (A[k] !== A[k] || B[k] !== B[k]) { from = k + 1; break; }
          let adf = NaN;
          if (T - from + 1 >= F) adf = ctx.Stats.cointegration(ctx.window(a, from, T), ctx.window(b, from, T)).adf;
          cands.push({ a, b, ssd, adf: isFinite(adf) ? adf : Infinity });
        }
      }
      const pick = new Set();
      cands.slice().sort((x, y) => x.ssd - y.ssd).slice(0, p.nSSD).forEach((c) => pick.add(c.a + "|" + c.b));
      cands.slice().sort((x, y) => x.adf - y.adf).slice(0, p.nADF).forEach((c) => pick.add(c.a + "|" + c.b));
      const old = new Map(book.map((q) => [q.a + "|" + q.b, q]));
      book = cands.filter((c) => pick.has(c.a + "|" + c.b)).map((c) => {
        const prev = old.get(c.a + "|" + c.b);
        const q = { a: c.a, b: c.b, sig: NaN, R: fresh(), sa: prev ? prev.sa : 0, sb: prev ? prev.sb : 0 };
        adjBuild(q, T, ctx.dates.length);
        return q;
      });
      // --- replay the trailing year (plus one block of warm-up) to set rule states and to measure the
      //     book's average unlevered gross; leverage scales that average to grossTarget ---
      const days = [], r0 = Math.max(p.F + 1, T - 251 - p.Tg);
      newBlock(r0);
      let ivSum = 0, ivN = 0;
      for (let t = r0; t <= T; t++) {
        if (t - anchor >= p.Tg) newBlock(t);
        let inv = 0;
        const sg = book.map((q) => { const s = step(q, t, anchor); if (s) inv += s.iv; return s; });
        if (t <= T - 252 || !inv) continue;
        days.push({ sg, inv });
        ivSum += inv; ivN++;
      }
      // absolute scaling: budget = iv / ivRef, ivRef = trailing-year average of the book's summed iv
      ivRef = ivN ? ivSum / ivN : NaN;
      const g = days.map(({ sg, inv }) => {
        const w = {}, norm = p.scale === "abs" ? ivRef : inv;
        book.forEach((q, k) => {
          const s = sg[k];
          if (!s) return;
          const x = 0.5 * s.pos * (s.iv / norm);
          w[q.a] = (w[q.a] || 0) + x;
          w[q.b] = (w[q.b] || 0) - x;
        });
        let gr = 0;
        for (const k in w) gr += Math.abs(w[k]);
        return gr;
      });
      const mg = g.length ? g.reduce((s, v) => s + v, 0) / g.length : NaN;
      lev = mg > 0 ? Math.min(p.levMax, p.grossTarget / mg) : 1;
      // --- a new Gatev trading block starts tomorrow; formation sigma from the F days up to today ---
      newBlock(T + 1);
      dirty = true;
    }

    function weights(ctx) {
      fill(ctx);
      const t = ctx.now, E = ctx.equity();
      for (const q of book) while (q.at < t) adjStep(q, ++q.at);
      if (t - anchor >= p.Tg) newBlock(t);
      let inv = 0;
      const sigs = book.map((q) => { const s = step(q, t, anchor); if (s) inv += s.iv; return s; });
      let changed = dirty;
      dirty = false;
      const px = (s) => ctx.px(s, t);
      book.forEach((q, k) => {
        const s = sigs[k];
        q.tr = false;
        if (!s) return;
        const pa = px(q.a), pb = px(q.b);
        const bud = lev * (s.iv / (p.scale === "abs" && ivRef > 0 ? ivRef : inv));
        // held position in units of this pair's full gross (+1 = long A / short B)
        const hpos = ((q.sa * pa) / E - (q.sb * pb) / E) / bud;
        const gap = s.pos - hpos;
        if (Math.abs(gap) > p.band) {
          // no-trade band: trade to its nearest edge (edge=true) or all the way to the target
          const np = p.edge ? s.pos - Math.sign(gap) * p.band : s.pos;
          const ta = 0.5 * np * bud;
          q.sa = (ta * E) / pa; q.sb = (-ta * E) / pb;
          q.tr = true;
          changed = true;
        }
      });
      if (!changed) return null;
      // stock-level book, with today's traded pairs scaled by f
      const agg = (f) => {
        const out = {};
        for (const q of book) {
          if (!q.sa && !q.sb) continue;
          const pa = px(q.a), pb = px(q.b);
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
          // gross cap: ration capital to today's trades only, so untouched positions are not churned
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
    description: "Three classic pairs-trading rules vote on each pair of look-alike stocks, and the average vote sets how much to bet that the pair snaps back together. Calmer pairs get more money so each carries similar risk, and sudden news-driven jumps are not bet against.",
    defaults: {
      mode: "rules",     // "rules": average of the three entry/exit rules; "linear": average of clipped z
      Lr: 20,            // ratio Bollinger lookback (library default)
      Lg: 60,            // rolling-regression lookback (library default)
      F: 252, Tg: 126,   // Gatev: 12-month formation, 6-month trading blocks
      wts: [1, 1, 1],    // ensemble weights: ratio z, regression z, Gatev distance
      entry: 2,          // rules mode: enter beyond 2 sigma (library default for all three rules)
      clip: 2,           // linear mode: each z clipped at +-2
      volL: 63,          // spread-vol window for inverse-vol budgets and the jump filter
      scale: "rel",      // "abs": budget = 1/vol over a fixed yearly reference (book de-risks when vol rises);
                         // "rel": budgets renormalized daily to a fixed total
      J: 2.5,            // daily spread moves beyond J sigmas are treated as news (not expected to revert)
      nSSD: 20, nADF: 20, adfDays: 756,
      band: 0.2,         // no-trade band half-width, in units of the pair's full position
      edge: false,       // trade to the band edge (true) or to target (false)
      grossTarget: 0.8,  // trailing-year average target gross
      levMax: 5,
    },
    create,
  };
  if (typeof module === "object" && module.exports) module.exports = def;
  else (root.Candidates = root.Candidates || {})[def.id] = def;
})(typeof window !== "undefined" ? window : globalThis);

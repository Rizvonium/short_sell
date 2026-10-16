// OU half-life pairs: Engle-Granger cointegration selection with stability and half-life filters,
// traded as an Ornstein-Uhlenbeck process (Avellaneda & Lee 2010 style s-score), with a time stop
// of a few half-lives, a stop-loss, and a news (jump) filter. Works in Node and the browser.
(function (root) {
  "use strict";
  const LN2 = Math.log(2);

  // y = alpha + beta x
  function ols(x, y) {
    const n = x.length;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { const dx = x[i] - mx; sxx += dx * dx; sxy += dx * (y[i] - my); }
    const beta = sxx > 0 ? sxy / sxx : 0;
    return { alpha: my - beta * mx, beta };
  }

  // Exact discretisation of an OU process on s[from..to]: s_t = c + phi s_{t-1} + e_t.
  // Returns phi, half-life (days), mean c/(1-phi), innovation sd and stationary sd sdE/sqrt(1-phi^2).
  function fitOU(s, from, to) {
    const n = to - from;
    if (n < 20) return null;
    let mx = 0, my = 0;
    for (let i = from + 1; i <= to; i++) { mx += s[i - 1]; my += s[i]; }
    mx /= n; my /= n;
    let sxx = 0, sxy = 0;
    for (let i = from + 1; i <= to; i++) { const dx = s[i - 1] - mx; sxx += dx * dx; sxy += dx * (s[i] - my); }
    if (sxx <= 0) return null;
    const phi = sxy / sxx, c = my - phi * mx;
    let sse = 0;
    for (let i = from + 1; i <= to; i++) { const e = s[i] - c - phi * s[i - 1]; sse += e * e; }
    const sdE = Math.sqrt(sse / (n - 2));
    if (!(phi > 0 && phi < 1)) return { phi, hl: Infinity };
    return { phi, hl: -LN2 / Math.log(phi), mu: c / (1 - phi), sdE, sdEq: sdE / Math.sqrt(1 - phi * phi) };
  }

  const pairKey = (p) => (p.a < p.b ? p.a + "|" + p.b : p.b + "|" + p.a);

  function create(P) {
    let book = [], legacy = [], dirty = false;

    // ---------- formation: pick stable, fast mean-reverting cointegrated pairs ----------
    function select(ctx) {
      const T = ctx.now, F = Math.min(P.formDays, T + 1), from = T - F + 1;
      if (F < P.minForm) return [];
      const L = Math.floor(F / P.nSub);
      const cands = [];
      for (const syms of Object.values(ctx.groups)) {
        for (let i = 0; i < syms.length; i++) for (let j = i + 1; j < syms.length; j++) {
          const pa = ctx.window(syms[i], from, T), pb = ctx.window(syms[j], from, T);
          if (pa.length < F || pa.some((v) => !(v > 0)) || pb.some((v) => !(v > 0))) continue;
          const la = pa.map(Math.log), lb = pb.map(Math.log);
          // Engle-Granger in both directions; keep the stronger ADF statistic
          let best = null;
          for (const [y, x, a, b] of [[la, lb, syms[i], syms[j]], [lb, la, syms[j], syms[i]]]) {
            const { alpha, beta } = ols(x, y);
            const s = y.map((v, k) => v - alpha - beta * x[k]);
            const t = ctx.Stats.adf(s, 1).t;
            if (isFinite(t) && (!best || t < best.t)) best = { a, b, alpha, beta, s, t };
          }
          if (!best || best.t > P.egCrit) continue;                    // cointegrated at 10%
          if (best.beta < P.betaMin || best.beta > P.betaMax) continue; // sensible hedge ratio
          const ou = fitOU(best.s, 0, F - 1);
          if (!ou || !(ou.hl >= P.hlMin && ou.hl <= P.hlMax)) continue; // 3-60 day half-life
          // stability: in every sub-window the same spread must revert with a half-life in range
          // and sit near the full-window equilibrium
          let stable = true;
          for (let k = 0; k < P.nSub && stable; k++) {
            const lo = F - (P.nSub - k) * L, hi = lo + L - 1;
            const so = fitOU(best.s, lo, hi);
            let m = 0;
            for (let q = lo; q <= hi; q++) m += best.s[q];
            m /= L;
            stable = !!so && so.hl <= P.hlMax && Math.abs(m - ou.mu) <= P.subMeanTol * ou.sdEq;
          }
          if (stable) cands.push(Object.assign(best, { ou }));
        }
      }
      cands.sort((x, y) => x.t - y.t);
      const use = {}, keep = [];
      for (const c of cands) {
        if (keep.length >= P.N) break;
        if ((use[c.a] || 0) >= P.maxPerStock || (use[c.b] || 0) >= P.maxPerStock) continue;
        use[c.a] = (use[c.a] || 0) + 1; use[c.b] = (use[c.b] || 0) + 1;
        keep.push({
          a: c.a, b: c.b, alpha: c.alpha, beta: c.beta, mu: c.ou.mu, sd: c.ou.sdEq, hl: c.ou.hl,
          tmax: Math.ceil(P.timeHL * c.ou.hl), pos: 0, sa: 0, sb: 0, t0: -1, blocked: false,
        });
      }
      return keep;
    }

    // New book; open trades of pairs that survive carry over, others run off as legacy positions.
    function reform(ctx) {
      const prev = new Map(book.concat(legacy).map((p) => [pairKey(p), p]));
      const nb = [];
      for (const p of select(ctx)) {
        const k = pairKey(p), o = prev.get(k);
        if (o) {
          if (o.a === p.a) {
            Object.assign(p, { pos: o.pos, sa: o.sa, sb: o.sb, t0: o.t0, blocked: o.blocked });
            prev.delete(k);
          } else if (o.pos) continue; // hedge direction flipped while a trade is open: let it finish first
          else { p.blocked = o.blocked; prev.delete(k); }
        }
        nb.push(p);
      }
      legacy = [...prev.values()].filter((o) => o.pos);
      book = nb;
      dirty = true;
    }

    function form(ctx) { reform(ctx); }

    // OU s-score on the trailing window with the formation hedge ratio, plus long-run z and jump flag
    function signal(ctx, p, t, pa, pb) {
      const out = { z: NaN, zLong: (Math.log(pa) - p.alpha - p.beta * Math.log(pb) - p.mu) / p.sd, jump: false };
      const W = P.muWin, wa = ctx.window(p.a, t - W, t), wb = ctx.window(p.b, t - W, t);
      if (wa.length !== W + 1 || wa.some((x) => !(x > 0)) || wb.some((x) => !(x > 0))) return out;
      const sp = wa.map((x, k) => Math.log(x) - p.beta * Math.log(wb[k]));
      const o = fitOU(sp, 0, W);
      if (!o || !(o.hl <= P.hlMax)) return out; // no tradable mean reversion in the window
      let m = 0;
      for (const q of sp) m += q;
      m /= sp.length;
      out.z = (sp[W] - m) / o.sdEq;
      // news proxy (Engelberg, Gao & Jagannathan 2009): a recent one-day jump in the direction
      // of the divergence is unlikely to revert
      for (let k = W - P.jumpDays + 1; k <= W; k++) {
        const d = sp[k] - sp[k - 1];
        if (Math.abs(d) > P.jumpK * o.sdE && d * out.z > 0) out.jump = true;
      }
      return out;
    }

    function weights(ctx) {
      const t = ctx.now, E = ctx.equity();
      // second formation each year at the first close of July (6-month cycle)
      if (P.midYear && t > 0 && ctx.dates[t].slice(5, 7) === "07" && ctx.dates[t - 1].slice(5, 7) !== "07") reform(ctx);
      const all = book.concat(legacy);
      // never trade on a day a held name has no price (the engine would drop it)
      for (const p of all) if (p.pos && (ctx.px(p.a, t) == null || ctx.px(p.b, t) == null)) return null;
      let changed = dirty;
      dirty = false;
      const sig = new Map();
      for (const p of all) {
        const pa = ctx.px(p.a, t), pb = ctx.px(p.b, t);
        if (pa == null || pb == null) continue;
        const g = signal(ctx, p, t, pa, pb), v = g.z;
        sig.set(p, g);
        if (p.blocked && isFinite(v) && Math.abs(v) <= P.exit) p.blocked = false;
        if (!p.pos) continue;
        let why = null;
        if ((p.pos > 0 && v >= -P.exit) || (p.pos < 0 && v <= P.exit)) why = "target";
        else if ((p.pos > 0 && v <= -P.stop) || (p.pos < 0 && v >= P.stop)) why = "stop";
        else if (t - p.t0 >= p.tmax) why = "time";
        if (why) {
          if (why !== "target") p.blocked = true; // re-arm only after the spread has reverted
          p.pos = 0; p.sa = 0; p.sb = 0; changed = true;
        }
      }
      legacy = legacy.filter((p) => p.pos);
      // gross after exits
      const net = {};
      for (const p of book.concat(legacy)) if (p.pos) {
        net[p.a] = (net[p.a] || 0) + p.sa * ctx.px(p.a, t);
        net[p.b] = (net[p.b] || 0) + p.sb * ctx.px(p.b, t);
      }
      let G = 0;
      for (const s in net) G += Math.abs(net[s]) / E;
      // entries: local and long-run OU deviations agree, no news jump, strongest first
      const want = book.filter((p) => {
        const g = sig.get(p);
        return !p.pos && !p.blocked && g && isFinite(g.z) && g.zLong * g.z > 0 && !g.jump &&
          Math.abs(g.z) >= P.entry && Math.abs(g.z) < P.stop;
      });
      want.sort((x, y) => Math.abs(sig.get(y).z) - Math.abs(sig.get(x).z));
      for (const p of want) {
        const g = Math.min(1 / P.K, 1 - G); // one slot of 1/K gross per pair, never above 1x
        if (g < 0.5 / P.K) break;
        const s = sig.get(p).z > 0 ? -1 : 1;
        const pa = ctx.px(p.a, t), pb = ctx.px(p.b, t);
        const wa = (s * g) / (1 + p.beta), wb = (-s * g * p.beta) / (1 + p.beta);
        p.pos = s; p.sa = (wa * E) / pa; p.sb = (wb * E) / pb; p.t0 = t;
        G += g; changed = true;
      }
      if (!changed) return null;
      const target = {};
      for (const p of book.concat(legacy)) if (p.pos) {
        target[p.a] = (target[p.a] || 0) + (p.sa * ctx.px(p.a, t)) / E;
        target[p.b] = (target[p.b] || 0) + (p.sb * ctx.px(p.b, t)) / E;
      }
      return target;
    }
    return { form, weights };
  }

  const def = {
    id: "ou-halflife",
    name: "OU half-life pairs",
    short: "OU-HL",
    description: "Trades pairs of same-sector stocks whose price gap has reliably snapped back within weeks, " +
      "checked separately in each of the last three years. It bets on the gap closing when it stretches unusually " +
      "wide, and gives up on a trade if it takes much longer than the pair's usual recovery time.",
    defaults: {
      formDays: 756, minForm: 500, nSub: 3, egCrit: -3.04, subMeanTol: 1,
      betaMin: 0.5, betaMax: 2, hlMin: 3, hlMax: 60,
      N: 20, maxPerStock: 3, K: 10, midYear: true,
      muWin: 60, entry: 1.25, exit: 0.5, stop: 4, timeHL: 3, jumpK: 3, jumpDays: 5,
    },
    create,
  };
  if (typeof module === "object" && module.exports) module.exports = def;
  else (root.Candidates = root.Candidates || {})[def.id] = def;
})(typeof window !== "undefined" ? window : globalThis);

// Regime-guard pairs: a cointegration-selected ratio-Bollinger pairs book wrapped in layered defenses
// against broken pairs and bad regimes. Works in Node (module.exports) and the browser.
//
// CORE  Each January, rank every same-sector pair by its Engle-Granger ADF statistic over the trailing
//       3 years (or the 2+ years available) and keep the best N. Trade each pair with the classic
//       ratio Bollinger rule: when log(A/B) is more than 2 rolling 20-day sds from its 20-day mean, buy
//       the cheap leg and short the rich one (equal dollars), exit when the ratio is back at its mean.
//       Each open pair gets a fixed slice of capital (1/K of equity, K = N/2), so the book runs at
//       about half-to-full gross instead of the ~0.4 of an equal 1/N split.
// GUARDS (each switchable, for ablation):
//   stop     the ratio moves a further `stop` entry-day sds against the trade -> exit
//   maxHold  a trade that has not reverted after `maxHold` days is closed (a trending ratio keeps the
//            rolling z near +-1.7 forever, so the plain rule never exits it)
//   cool     a pair stopped / timed out / flagged broken cannot re-enter for `cool` days (ban list)
//   monitor  daily health check of every pair: (a) the Engle-Granger spread from formation sits beyond
//            breakZ sds (the long-run relationship broke), or (b) a Fisher test says the 63-day return
//            correlation has fallen significantly (1%) below the formation-year correlation. A flagged
//            pair is closed and banned until both clear (|z| < clearZ, test below 10%).
//   news     divergences that began with a >3 sd one-day jump in the ratio in the last 5 days are
//            skipped until the ratio is back at its mean (news-driven gaps rarely close:
//            Engelberg, Gao & Jagannathan 2009; Chan 2003)
//   invVol   new positions sized by the book's median spread vol / this pair's current spread vol
//            (clamped 0.5-2x): a pair whose spread has become turbulent gets a smaller bet
//   brake    "vol": scale new positions by (long-run / 21-day) volatility of the strategy's own
//            returns per unit gross, capped at 1; "disp": the same with within-sector cross-sectional
//            return dispersion; "none": off. Floor brakeMin.
(function (root) {
  "use strict";

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const atanh = (r) => { const x = clamp(r, -0.999, 0.999); return 0.5 * Math.log((1 + x) / (1 - x)); };

  // Rolling stats of the log ratio r = A - B over the L days ending at t (population sd, as in the
  // Bollinger baseline). Null if any price is missing.
  function band(A, B, t, L) {
    if (t - L + 1 < 0) return null;
    let s = 0, ss = 0;
    for (let i = t - L + 1; i <= t; i++) {
      const r = A[i] - B[i];
      if (r !== r) return null;
      s += r; ss += r * r;
    }
    const m = s / L, sd = Math.sqrt(Math.max(ss / L - m * m, 1e-14)), r = A[t] - B[t];
    return { r, m, sd, z: (r - m) / sd };
  }

  // Sample sd of the daily changes of r = A - B over the n days ending at e.
  function chgSd(A, B, e, n) {
    if (e - n < 0) return NaN;
    let s = 0, ss = 0;
    for (let i = e - n + 1; i <= e; i++) {
      const d = A[i] - B[i] - A[i - 1] + B[i - 1];
      if (d !== d) return NaN;
      s += d; ss += d * d;
    }
    const m = s / n, v = (ss - n * m * m) / (n - 1);
    return v > 0 ? Math.sqrt(v) : NaN;
  }

  // Correlation of daily log returns over the n days ending at t, each series winsorized at its
  // mean +- 3 sd so that a single earnings jump does not by itself read as a broken relationship.
  function wcorr(A, B, t, n) {
    if (t - n < 0) return NaN;
    const x = new Float64Array(n), y = new Float64Array(n);
    let sx = 0, sy = 0, sxx = 0, syy = 0;
    for (let k = 0; k < n; k++) {
      const i = t - n + 1 + k, u = A[i] - A[i - 1], v = B[i] - B[i - 1];
      if (u !== u || v !== v) return NaN;
      x[k] = u; y[k] = v; sx += u; sy += v; sxx += u * u; syy += v * v;
    }
    const mx = sx / n, my = sy / n;
    const cx = 3 * Math.sqrt(Math.max(sxx / n - mx * mx, 0)), cy = 3 * Math.sqrt(Math.max(syy / n - my * my, 0));
    let a = 0, b = 0, aa = 0, bb = 0, ab = 0;
    for (let k = 0; k < n; k++) {
      const u = clamp(x[k], mx - cx, mx + cx), v = clamp(y[k], my - cy, my + cy);
      a += u; b += v; aa += u * u; bb += v * v; ab += u * v;
    }
    const va = aa - (a * a) / n, vb = bb - (b * b) / n;
    return va > 0 && vb > 0 ? (ab - (a * b) / n) / Math.sqrt(va * vb) : NaN;
  }

  // True when one of the last `days` daily changes of the ratio moved more than k sds (sd from the
  // n days before them) in direction dir, i.e. the divergence started with a news-sized jump.
  function newsJump(A, B, t, days, n, k, dir) {
    const sd = chgSd(A, B, t - days, n);
    if (!(sd > 0)) return false;
    for (let i = t - days + 1; i <= t; i++) {
      const d = A[i] - B[i] - A[i - 1] + B[i - 1];
      if (d * dir > k * sd) return true;
    }
    return false;
  }

  function create(params) {
    const P = params;
    let LP = null, filled = -1, Dc = null, groupsArr = null;
    let book = [], dirty = false, sigRef = NaN;
    let lastE = null, lastG = 0;
    const U = [];   // strategy's own daily returns per unit of gross
    const diag = { target: 0, stop: 0, time: 0, broken: 0, news: 0, entries: 0, skippedGross: 0 };

    // log-price cache, filled incrementally from ctx (never past ctx.now)
    function fill(ctx) {
      const T = ctx.now;
      if (!LP) {
        LP = {};
        for (const s of ctx.syms) LP[s] = new Float64Array(ctx.dates.length).fill(NaN);
        Dc = new Float64Array(ctx.dates.length).fill(NaN);
        groupsArr = Object.values(ctx.groups);
      }
      if (T <= filled) return;
      for (const s of ctx.syms) {
        const w = ctx.window(s, filled + 1, T), arr = LP[s], o = Math.max(0, filled + 1);
        for (let k = 0; k < w.length; k++) { const v = w[k]; arr[o + k] = v != null && v > 0 ? Math.log(v) : NaN; }
      }
      filled = T;
    }

    // within-sector cross-sectional dispersion of daily log returns on day i (mean abs deviation)
    function dispAt(i) {
      if (Dc[i] === Dc[i]) return Dc[i];
      if (i < 1) return NaN;
      let tot = 0, cnt = 0;
      for (const syms of groupsArr) {
        let s = 0, n = 0;
        const rs = [];
        for (const sym of syms) {
          const A = LP[sym];
          if (!A) continue;
          const r = A[i] - A[i - 1];
          if (r === r) { rs.push(r); s += r; n++; }
        }
        if (n < 2) continue;
        const m = s / n;
        for (const r of rs) { tot += Math.abs(r - m); cnt++; }
      }
      return (Dc[i] = cnt ? tot / cnt : NaN);
    }
    function meanDisp(t, n) {
      let s = 0, k = 0;
      for (let i = Math.max(1, t - n + 1); i <= t; i++) { const d = dispAt(i); if (d === d) { s += d; k++; } }
      return k >= n / 2 ? s / k : NaN;
    }

    function brakeNow(t) {
      if (P.brake === "vol") {
        const n = U.length;
        if (n < P.brakeMinObs) return 1;
        let s = 0, l = 0;
        for (let i = n - P.brakeShort; i < n; i++) s += U[i] * U[i];
        const m = Math.min(n, P.brakeLong);
        for (let i = n - m; i < n; i++) l += U[i] * U[i];
        const ss = Math.sqrt(s / P.brakeShort), sl = Math.sqrt(l / m);
        return ss > 0 ? clamp(sl / ss, P.brakeMin, 1) : 1;
      }
      if (P.brake === "disp") {
        const ds = meanDisp(t, P.brakeShort), dl = meanDisp(t, P.brakeLong);
        return ds > 0 && dl > 0 ? clamp(dl / ds, P.brakeMin, 1) : 1;
      }
      return 1;
    }

    // relationship health check (see header): sets q.broken with hysteresis
    function monitor(q, A, B, t) {
      const ze = (A[t] - q.alpha - q.beta * B[t] - q.mu) / q.esd;
      let fz = 0;
      if (q.rho0 === q.rho0) {
        const rho = wcorr(A, B, t, P.corrWin);
        if (rho === rho) fz = (atanh(q.rho0) - atanh(rho)) / Math.sqrt(1 / (P.corrWin - 3) + 1 / (P.corrForm - 3));
      }
      if (!q.broken) { if (Math.abs(ze) > P.breakZ || fz > P.corrZ) q.broken = true; }
      else if (Math.abs(ze) < P.clearZ && fz < P.corrClear) q.broken = false;
    }

    function form(ctx) {
      fill(ctx);
      const T = ctx.now, W = Math.min(P.trainDays, T), from = T - W + 1;
      const cands = [];
      if (W >= P.minTrain) {
        for (const syms of groupsArr) {
          for (let i = 0; i < syms.length; i++) for (let j = i + 1; j < syms.length; j++) {
            const a = syms[i], b = syms[j], A = LP[a], B = LP[b];
            if (!A || !B) continue;
            let ok = true;
            for (let k = from - 1; k <= T; k++) if (A[k] !== A[k] || B[k] !== B[k]) { ok = false; break; }
            if (!ok) continue;
            const c = ctx.Stats.cointegration(ctx.window(a, from, T), ctx.window(b, from, T));
            if (isFinite(c.adf) && c.sd > 0) cands.push({ a, b, c });
          }
        }
      }
      cands.sort((x, y) => x.c.adf - y.c.adf);
      const old = new Map(book.map((q) => [q.a + "|" + q.b, q]));
      book = cands.slice(0, P.N).map(({ a, b, c }) => {
        const prev = old.get(a + "|" + b);
        let mu = 0;
        for (const v of c.spread) mu += v;
        mu /= c.spread.length;
        const q = {
          a, b, alpha: c.alpha, beta: c.beta, mu, esd: c.sd, rho0: wcorr(LP[a], LP[b], T, P.corrForm),
          s: 0, sa: 0, sb: 0, t0: -1, r0: 0, sd0: 0, ban: -1, news: 0, broken: false,
        };
        if (prev) for (const k of ["s", "sa", "sb", "t0", "r0", "sd0", "ban", "news"]) q[k] = prev[k];
        if (P.monitor) monitor(q, LP[a], LP[b], T);
        return q;
      });
      const sv = book.map((q) => chgSd(LP[q.a], LP[q.b], T, P.volWin)).filter((v) => v > 0).sort((x, y) => x - y);
      sigRef = sv.length ? sv[sv.length >> 1] : NaN;
      dirty = true;   // pairs that left the book are closed on the first day
    }

    function grossOf(w) { let g = 0; for (const s in w) g += Math.abs(w[s]); return g; }

    function weights(ctx) {
      fill(ctx);
      const t = ctx.now, E = ctx.equity();
      if (lastE !== null && lastG > 0.05) U.push((E / lastE - 1) / lastG);
      lastE = E;
      const cur = ctx.current();
      // a held name without a price today: hold everything, decide tomorrow
      for (const s in cur) if (ctx.px(s, t) == null) { lastG = grossOf(cur); return null; }
      let changed = dirty;
      dirty = false;
      const cands = [];
      for (const q of book) {
        const A = LP[q.a], B = LP[q.b];
        if (A[t] !== A[t] || B[t] !== B[t]) continue;
        if (P.monitor) monitor(q, A, B, t);
        const bd = band(A, B, t, P.L);
        if (!bd) continue;
        const z = bd.z;
        if (q.s) {
          let why = null;
          if ((q.s > 0 && z > -P.exit) || (q.s < 0 && z < P.exit)) why = "target";
          else if (P.stop > 0 && -q.s * (bd.r - q.r0) > P.stop * q.sd0) why = "stop";
          else if (P.maxHold > 0 && t - q.t0 >= P.maxHold) why = "time";
          else if (P.monitor && q.broken) why = "broken";
          if (why) {
            q.s = 0; q.sa = 0; q.sb = 0; changed = true;
            if (why !== "target" && P.cool > 0) q.ban = t + P.cool;
            diag[why]++;
          }
          continue;
        }
        if (q.news && z * q.news < P.exit) q.news = 0;   // the news-driven gap is over
        if (Math.abs(z) > P.entry && t >= q.ban && !(P.monitor && q.broken) && !q.news) {
          const dir = z > 0 ? 1 : -1;
          if (P.news && newsJump(A, B, t, P.jumpDays, P.volWin, P.jumpK, dir)) { q.news = dir; diag.news++; continue; }
          cands.push({ q, s: -dir, pri: Math.abs(z), bd });
        }
      }
      if (cands.length) {
        cands.sort((x, y) => y.pri - x.pri);
        const brake = brakeNow(t);
        let G = 0;
        const net = {};
        for (const q of book) if (q.s) {
          net[q.a] = (net[q.a] || 0) + q.sa * ctx.px(q.a, t);
          net[q.b] = (net[q.b] || 0) + q.sb * ctx.px(q.b, t);
        }
        for (const s in net) G += Math.abs(net[s]) / E;
        for (const { q, s, bd } of cands) {
          let adj = 1;
          if (P.invVol) {
            const sv = chgSd(LP[q.a], LP[q.b], t, P.volWin);
            adj = sv > 0 && sigRef > 0 ? clamp(sigRef / sv, P.volLo, P.volHi) : 1;
          }
          const want = (brake * adj) / P.K, room = P.maxGross - G;
          if (room < 0.5 * want) { diag.skippedGross++; continue; }
          const g = Math.min(want, room);
          q.sa = ((s * g) / 2) * E / ctx.px(q.a, t);
          q.sb = ((-s * g) / 2) * E / ctx.px(q.b, t);
          q.s = s; q.t0 = t; q.r0 = bd.r; q.sd0 = bd.sd;
          G += g; changed = true; diag.entries++;
        }
      }
      if (!changed) { lastG = grossOf(cur); return null; }
      const target = {};
      for (const q of book) if (q.s) {
        target[q.a] = (target[q.a] || 0) + (q.sa * ctx.px(q.a, t)) / E;
        target[q.b] = (target[q.b] || 0) + (q.sb * ctx.px(q.b, t)) / E;
      }
      lastG = grossOf(target);
      return target;
    }

    return { form, weights, diag };
  }

  const def = {
    id: "regime-guard",
    name: "Regime-guard pairs",
    short: "Guarded",
    description: "Trades look-alike stocks in the same sector that have moved together for years, betting " +
      "that a sudden gap between them closes. Every pair is checked daily: if the gap keeps widening, " +
      "drags on too long, was caused by news, or the two stocks stop moving together, the trade is closed " +
      "and the pair is benched for a while.",
    defaults: {
      N: 20, K: 10, trainDays: 756, minTrain: 504,   // book: top-N ADF pairs, 1/K of equity per open pair
      L: 20, entry: 2, exit: 0,                      // ratio Bollinger (library / textbook defaults)
      stop: 2, maxHold: 40, cool: 20,                // stop-loss (extra entry sds), time stop, cool-down
      monitor: true, breakZ: 3, clearZ: 2, corrWin: 63, corrForm: 252, corrZ: 2.326, corrClear: 1.282,
      news: true, jumpK: 3, jumpDays: 5, volWin: 63,
      invVol: false, volLo: 0.5, volHi: 2,
      brake: "none", brakeMin: 0.25, brakeShort: 21, brakeLong: 504, brakeMinObs: 126,
      maxGross: 1,
    },
    create,
  };
  if (typeof module === "object" && module.exports) module.exports = def;
  else (root.Candidates = root.Candidates || {})[def.id] = def;
})(typeof window !== "undefined" ? window : globalThis);

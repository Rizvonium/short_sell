// Smart laggard: the headline "buy the laggard, short the leader" pair rule, rebuilt to survive costs.
//
// The raw rule (always long whichever twin lagged over the last k days) is always in the market and
// flips sides every few days (~92x/yr turnover); its small reversal edge is eaten by costs. This
// version keeps the same economic bet but only pays for it when the gap is worth trading:
//   - pairs: every same-sector pair whose daily returns correlate at least 0.3 over the prior
//     3 years, ranked by Engle-Granger cointegration (ADF t-stat of the log-price spread), top 30,
//     with each stock in at most 3 pairs so one cluster (e.g. big banks) cannot fill the book.
//     Re-selected every January on data <= now; open trades of dropped pairs run to their own exit.
//   - signal: the "smoothed return gap". The gap of A vs B is s = log A - log B. Its deviation from
//     its own k-day average equals the average of the 1..k-1 day return gaps, i.e. a sum of recent
//     daily gap moves with linearly decaying weights, so it does not echo a single stale reference
//     day the way a point-to-point k-day gap does. Horizons of 1 week, 2 weeks and 1 month (the
//     weekly / monthly reversal horizons of Lehmann 1990 and Jegadeesh 1990) are each scaled to unit
//     variance under a random walk and averaged. The result is divided by the pair's trailing
//     60-day volatility of daily gap moves, so z is "how unusual is this gap for this pair right now".
//     Daily gap moves are clipped at 3 sigma first: a jump that large is usually news, and
//     news-driven divergences tend to persist rather than revert (Chan 2003; Engelberg, Gao &
//     Jagannathan 2009).
//   - trade: open when |z| > 1.5 (buy the laggard, short the leader, equal dollars), close when z is
//     back to 0 -- a no-trade band of 1.5 sigma, many times the round-trip cost. Minimum hold
//     5 days; time stop 40 days, after which the pair must reset (z back to 0) before re-entry.
//   - sizing: leg size = 1/12 of equity x signal strength (|z| / 1.5, capped at 2x) x inverse gap
//     volatility (risk parity across pairs, bounded 0.5x..2x). Positions are held in shares (no
//     daily rebalancing); new trades are added strongest first while the netted book stays under
//     gross 1. Every trade is dollar-neutral, so the book is market-neutral by construction.
(function (root) {
  "use strict";

  function create(params) {
    const P = params;
    // Smoothed gap filter: weight FW[i] on the daily gap move of day t - i.
    // s_t - mean(s_{t-k+1..t}) = sum_{i=0}^{k-2} ((k-1-i)/k) d_{t-i}; each horizon is scaled to unit
    // variance under a random walk, the horizons are averaged and rescaled to unit variance again.
    const H = P.horizons.slice().sort((a, b) => a - b);
    const KMAX = H[H.length - 1];
    const FW = new Float64Array(KMAX - 1);
    for (const k of H) {
      let c = 0;
      for (let i = 0; i <= k - 2; i++) c += ((k - 1 - i) / k) ** 2;
      c = Math.sqrt(c);
      for (let i = 0; i <= k - 2; i++) FW[i] += (k - 1 - i) / k / c / H.length;
    }
    let fn = 0;
    for (const v of FW) fn += v * v;
    fn = Math.sqrt(fn);
    for (let i = 0; i < FW.length; i++) FW[i] /= fn;
    const NEED = Math.max(P.volDays, FW.length); // daily gap moves needed per evaluation

    const pairs = new Map(); // key -> { a, b, rho, adf, sig, live, side, t0, sh, block, sigNow }
    let sigRef = 0.01;
    let dirty = false;
    let lastForm = null;

    // ---------- formation (data <= ctx.now only) ----------
    function form(ctx) {
      const T = ctx.now;
      const from = Math.max(1, T - P.formDays + 1);
      const n = T - from + 1;
      const R = {};
      const syms = new Set();
      for (const g of Object.keys(ctx.groups).sort()) for (const s of ctx.groups[g]) syms.add(s);
      for (const s of syms) {
        const w = ctx.window(s, from - 1, T);
        const r = new Float64Array(n).fill(NaN);
        let c = 0;
        for (let k = 1; k < w.length; k++) {
          const p0 = w[k - 1], p1 = w[k];
          if (p0 > 0 && p1 > 0) { r[k - 1] = Math.log(p1 / p0); c++; }
        }
        if (c >= P.minObs) R[s] = r;
      }
      const cands = [];
      for (const g of Object.keys(ctx.groups).sort()) {
        const list = ctx.groups[g].filter((s) => R[s]).sort();
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j], x = R[a], y = R[b];
          let c = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sd = 0, sdd = 0;
          for (let k = 0; k < n; k++) {
            const u = x[k], v = y[k];
            if (u !== u || v !== v) continue;
            c++; sx += u; sy += v; sxx += u * u; syy += v * v; sxy += u * v;
            sd += u - v; sdd += (u - v) * (u - v);
          }
          if (c < P.minObs) continue;
          const vx = sxx - (sx * sx) / c, vy = syy - (sy * sy) / c;
          if (!(vx > 0 && vy > 0)) continue;
          const rho = (sxy - (sx * sy) / c) / Math.sqrt(vx * vy);
          if (rho < P.minCorr) continue;
          const sig = Math.sqrt(Math.max(1e-12, (sdd - (sd * sd) / c) / (c - 1)));
          // Engle-Granger cointegration of log prices (ADF t-stat; more negative = more stationary)
          const pa = ctx.window(a, from, T), pb = ctx.window(b, from, T);
          if (pa.some((v) => !(v > 0)) || pb.some((v) => !(v > 0))) continue;
          const adf = ctx.Stats.cointegration(pa, pb).adf;
          if (!isFinite(adf)) continue;
          cands.push({ a, b, rho, sig, adf, key: a + "|" + b });
        }
      }
      cands.sort((p, q) => p.adf - q.adf || (p.key < q.key ? -1 : 1));
      const used = {}, keep = [];
      for (const c of cands) {
        if (keep.length >= P.N) break;
        if ((used[c.a] || 0) >= P.maxPerStock || (used[c.b] || 0) >= P.maxPerStock) continue;
        used[c.a] = (used[c.a] || 0) + 1;
        used[c.b] = (used[c.b] || 0) + 1;
        keep.push(c);
      }
      const sigs = keep.map((c) => c.sig).sort((p, q) => p - q);
      if (sigs.length) sigRef = sigs[Math.floor(sigs.length / 2)];
      // refresh the book: open trades of dropped pairs run on to their own exit, no new entries
      const keepKeys = new Set(keep.map((c) => c.key));
      for (const [k, p] of pairs) {
        if (keepKeys.has(k)) continue;
        if (p.side) p.live = false; else pairs.delete(k);
      }
      for (const c of keep) {
        const p = pairs.get(c.key);
        if (p) Object.assign(p, { rho: c.rho, adf: c.adf, sig: c.sig, live: true });
        else pairs.set(c.key, { a: c.a, b: c.b, rho: c.rho, adf: c.adf, sig: c.sig, live: true, side: 0, t0: 0, sh: null, block: 0, sigNow: c.sig });
      }
      lastForm = { date: ctx.dates[T], eligible: cands.length, pairs: keep.map((c) => ({ a: c.a, b: c.b, rho: c.rho, adf: c.adf, sig: c.sig })) };
      dirty = true;
    }

    // smoothed return gap of A vs B at day t in units of its trailing volatility (> 0: A ran ahead)
    function zOf(ctx, p, t) {
      if (t - NEED < 1) return NaN;
      const wa = ctx.window(p.a, t - NEED, t), wb = ctx.window(p.b, t - NEED, t);
      const d = new Float64Array(NEED);
      for (let j = 1; j <= NEED; j++) {
        const a0 = wa[j - 1], a1 = wa[j], b0 = wb[j - 1], b1 = wb[j];
        if (!(a0 > 0 && a1 > 0 && b0 > 0 && b1 > 0)) return NaN;
        d[NEED - j] = Math.log(a1 / a0) - Math.log(b1 / b0); // d[i] = gap move on day t - i
      }
      let s1 = 0, s2 = 0;
      for (let i = 0; i < P.volDays; i++) { s1 += d[i]; s2 += d[i] * d[i]; }
      const sig = Math.sqrt(Math.max(1e-12, (s2 - (s1 * s1) / P.volDays) / (P.volDays - 1)));
      p.sigNow = sig;
      const cap = P.clip > 0 ? P.clip * sig : Infinity;
      let g = 0;
      for (let i = 0; i < FW.length; i++) g += FW[i] * Math.max(-cap, Math.min(cap, d[i]));
      return g / sig;
    }

    function weights(ctx) {
      const t = ctx.now, E = ctx.equity();
      let changed = dirty;
      dirty = false;
      const zs = new Map();
      for (const [k, p] of pairs) zs.set(k, zOf(ctx, p, t));

      // exits (and resets of pairs blocked after a time stop)
      for (const [k, p] of pairs) {
        const z = zs.get(k);
        if (p.block && isFinite(z) && (p.block > 0 ? z >= -P.exit : z <= P.exit)) p.block = 0;
        if (!p.side) continue;
        const held = t - p.t0;
        let out = false;
        if (held >= P.maxHold) { out = true; p.block = p.side; }
        else if (held >= P.minHold && isFinite(z) && (p.side > 0 ? z >= -P.exit : z <= P.exit)) out = true;
        if (out) {
          p.side = 0; p.sh = null; changed = true;
          if (!p.live) pairs.delete(k);
        }
      }

      const book = () => {
        const w = {};
        for (const p of pairs.values()) {
          if (!p.side) continue;
          for (const s in p.sh) {
            const px = ctx.px(s, t);
            if (px > 0) w[s] = (w[s] || 0) + (p.sh[s] * px) / E;
          }
        }
        return w;
      };
      const grossOf = (w) => { let g = 0; for (const s in w) g += Math.abs(w[s]); return g; };

      // entries, strongest stretch first, while the netted book has room under the gross cap
      const cands = [];
      for (const [k, p] of pairs) {
        if (p.side || !p.live || p.block) continue;
        const z = zs.get(k);
        if (isFinite(z) && Math.abs(z) > P.entry) cands.push({ k, p, z });
      }
      if (cands.length) {
        cands.sort((x, y) => Math.abs(y.z) - Math.abs(x.z) || (x.k < y.k ? -1 : 1));
        let w = book(), g = grossOf(w);
        const base = P.maxGross / (2 * P.slots);
        for (const { p, z } of cands) {
          const pa = ctx.px(p.a, t), pb = ctx.px(p.b, t);
          if (!(pa > 0 && pb > 0)) continue;
          const strength = Math.min(P.maxStrength, Math.abs(z) / P.entry);
          const vs = Math.max(P.volScale[0], Math.min(P.volScale[1], sigRef / p.sigNow));
          let u = base * strength * vs;
          const side = z < 0 ? 1 : -1; // z < 0: A lagged B -> buy A, short B
          const trial = (uu) => {
            const tw = Object.assign({}, w);
            tw[p.a] = (tw[p.a] || 0) + side * uu;
            tw[p.b] = (tw[p.b] || 0) - side * uu;
            return tw;
          };
          let tw = trial(u), tg = grossOf(tw);
          if (tg > P.maxGross + 1e-9) {
            // shrink to the remaining room; skip if that leaves less than half a normal trade
            const uu = Math.min(u, (P.maxGross - g) / 2);
            if (uu < 0.5 * base * vs) continue;
            u = uu; tw = trial(u); tg = grossOf(tw);
            if (tg > P.maxGross + 1e-9) continue;
          }
          p.side = side; p.t0 = t;
          p.sh = { [p.a]: (side * u * E) / pa, [p.b]: (-side * u * E) / pb };
          w = tw; g = tg; changed = true;
        }
      }
      return changed ? book() : null;
    }

    // read-only snapshot for the UI / diagnostics
    function inspect() {
      const open = [];
      for (const p of pairs.values()) if (p.side) open.push({ a: p.a, b: p.b, side: p.side, since: p.t0, sh: Object.assign({}, p.sh) });
      return { form: lastForm, open };
    }

    return { form, weights, inspect };
  }

  const def = {
    id: "smart-laggard",
    name: "Smart laggard",
    short: "SmartLag",
    description:
      "Pairs of closely linked stocks from the same sector. When one twin has fallen unusually far behind the other over the past one to four weeks, buy it and short the leader, then close once the gap is back to normal. It only trades unusual gaps, ignores one-day news jumps and holds for one to two weeks, so it pays a fraction of the costs of the always-on laggard rule.",
    defaults: {
      formDays: 756,         // 3-year formation window for pair selection
      minObs: 500,           // min daily returns for a pair to be eligible
      minCorr: 0.3,          // floor on daily-return correlation (same sector + co-movement)
      N: 30,                 // pairs per market, ranked by cointegration (ADF t-stat)
      maxPerStock: 3,        // max pairs per stock
      horizons: [5, 10, 20], // gap vs its 5-, 10- and 20-day averages, standardized and averaged
      volDays: 60,           // trailing window (days) for the gap's daily volatility
      clip: 3,               // clip daily gap moves at 3 sigma before smoothing (jumps = news; 0 = off)
      entry: 1.5, exit: 0,   // open beyond +-1.5, close when back to 0
      minHold: 5, maxHold: 40,
      slots: 6,              // a unit trade puts 1/(2*slots) of equity in each leg
      maxStrength: 2,        // size scales with |z| / entry up to 2x
      volScale: [0.5, 2],    // inverse-volatility scaling bounds
      maxGross: 1,
    },
    create,
  };
  if (typeof module === "object" && module.exports) module.exports = def;
  else (root.Candidates = root.Candidates || {})[def.id] = def;
})(typeof window !== "undefined" ? window : globalThis);

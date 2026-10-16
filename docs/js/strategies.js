// Pair-trading strategies and a share-based backtest engine.
// Every signal at day t uses only prices up to and including t; trades fill at the close of t.
(function (global) {
  "use strict";
  const { ols } = global.Stats;

  // Shared entry/exit state machine on a z-like signal.
  // +1 = long spread (buy A, short B), -1 = short spread.
  function zStateMachine(z, p) {
    const n = z.length, st = new Int8Array(n);
    let s = 0, stopped = false;
    for (let t = 0; t < n; t++) {
      const v = z[t];
      if (!isFinite(v)) { st[t] = s; continue; }
      if (stopped && Math.abs(v) < p.entry) stopped = false;
      if (s === 0 && !stopped) {
        if (v > p.entry) s = -1;
        else if (v < -p.entry) s = 1;
      } else if (s === 1) {
        if (v > -p.exit) s = 0;
        else if (p.stop && v < -p.stop) { s = 0; stopped = true; }
      } else if (s === -1) {
        if (v < p.exit) s = 0;
        else if (p.stop && v > p.stop) { s = 0; stopped = true; }
      }
      st[t] = s;
    }
    return st;
  }

  // Rolling-window OLS of log A on log B with O(1) updates; z = residual / residual sd.
  function rollingZ(pa, pb, L) {
    const n = pa.length, z = new Float64Array(n).fill(NaN), beta = new Float64Array(n).fill(1);
    const y = pa.map(Math.log), x = pb.map(Math.log);
    let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (let t = 0; t < n; t++) {
      sx += x[t]; sy += y[t]; sxx += x[t] * x[t]; sxy += x[t] * y[t]; syy += y[t] * y[t];
      if (t >= L) {
        const o = t - L;
        sx -= x[o]; sy -= y[o]; sxx -= x[o] * x[o]; sxy -= x[o] * y[o]; syy -= y[o] * y[o];
      }
      if (t >= L - 1) {
        const cxx = sxx - (sx * sx) / L, cxy = sxy - (sx * sy) / L, cyy = syy - (sy * sy) / L;
        if (cxx <= 1e-12) continue;
        const b = cxy / cxx, a = (sy - b * sx) / L;
        const sse = Math.max(cyy - b * cxy, 1e-14);
        const sd = Math.sqrt(sse / (L - 2));
        z[t] = (y[t] - a - b * x[t]) / sd;
        beta[t] = b;
      }
    }
    return { z, beta };
  }

  function rollingRatioZ(pa, pb, L) {
    const n = pa.length, z = new Float64Array(n).fill(NaN);
    const r = pa.map((v, i) => Math.log(v / pb[i]));
    let s = 0, ss = 0;
    for (let t = 0; t < n; t++) {
      s += r[t]; ss += r[t] * r[t];
      if (t >= L) { s -= r[t - L]; ss -= r[t - L] * r[t - L]; }
      if (t >= L - 1) {
        const m = s / L, v = Math.max(ss / L - m * m, 1e-14);
        z[t] = (r[t] - m) / Math.sqrt(v);
      }
    }
    return z;
  }

  // Kalman filter for a time-varying hedge ratio (as in E. Chan, "Algorithmic Trading").
  function kalmanZ(pa, pb, delta) {
    const n = pa.length, z = new Float64Array(n).fill(NaN), beta = new Float64Array(n).fill(1);
    const Vw = delta / (1 - delta), Ve = 1e-3;
    let th = [0, 0], P = [[0, 0], [0, 0]], R = null;
    for (let t = 0; t < n; t++) {
      const y = Math.log(pa[t]), x = [Math.log(pb[t]), 1];
      R = R ? [[P[0][0] + Vw, P[0][1]], [P[1][0], P[1][1] + Vw]] : [[0, 0], [0, 0]];
      const yhat = x[0] * th[0] + x[1] * th[1];
      const Rx = [R[0][0] * x[0] + R[0][1] * x[1], R[1][0] * x[0] + R[1][1] * x[1]];
      const Q = x[0] * Rx[0] + x[1] * Rx[1] + Ve;
      const e = y - yhat;
      if (t > 20) { z[t] = e / Math.sqrt(Q); beta[t] = th[0]; }
      const K = [Rx[0] / Q, Rx[1] / Q];
      th = [th[0] + K[0] * e, th[1] + K[1] * e];
      P = [
        [R[0][0] - K[0] * Rx[0], R[0][1] - K[0] * Rx[1]],
        [R[1][0] - K[1] * Rx[0], R[1][1] - K[1] * Rx[1]],
      ];
    }
    return { z, beta };
  }

  const toWeights = (st, beta) => (t) => {
    const s = st[t];
    if (!s) return [0, 0];
    const b = Math.max(0.2, Math.min(5, beta ? beta[t] : 1));
    return [s / (1 + b), (-s * b) / (1 + b)];
  };

  const STRATEGIES = {
    zscore: {
      name: "Z-score reversion",
      short: "Z-score",
      color: "#2563c9",
      desc: "Rolling regression of log A on log B. Buy the laggard and short the leader when the residual stretches past the entry z; exit near the mean.",
      defaults: { L: 60, entry: 2, exit: 0.5, stop: 4 },
      grid: { L: [30, 60, 90, 120], entry: [1.5, 2, 2.5], exit: [0, 0.5], stop: [4] },
      build(pa, pb, p) {
        const { z, beta } = rollingZ(pa, pb, p.L);
        const st = zStateMachine(z, p);
        return { st, z, weights: toWeights(st, beta) };
      },
    },
    kalman: {
      name: "Kalman hedge",
      short: "Kalman",
      color: "#7c3aed",
      desc: "A Kalman filter updates the hedge ratio every day; trades the standardized forecast error.",
      defaults: { delta: 1e-4, entry: 1.5, exit: 0.25, stop: 0 },
      grid: { delta: [1e-5, 1e-4, 1e-3], entry: [1, 1.5, 2], exit: [0, 0.5], stop: [0] },
      build(pa, pb, p) {
        const { z, beta } = kalmanZ(pa, pb, p.delta);
        const st = zStateMachine(z, p);
        return { st, z, weights: toWeights(st, beta) };
      },
    },
    bollinger: {
      name: "Ratio Bollinger",
      short: "Bollinger",
      color: "#0e8a7e",
      desc: "Bollinger bands on the plain price ratio A/B, equal dollars per leg. Exits at the moving average.",
      defaults: { L: 20, entry: 2, exit: 0, stop: 0 },
      grid: { L: [10, 20, 40, 60], entry: [1.5, 2, 2.5], exit: [0], stop: [0] },
      build(pa, pb, p) {
        const z = rollingRatioZ(pa, pb, p.L);
        const st = zStateMachine(z, p);
        return { st, z, weights: toWeights(st, null) };
      },
    },
    distance: {
      name: "Distance (Gatev)",
      short: "Distance",
      color: "#b45309",
      desc: "Gatev, Goetzmann & Rouwenhorst (2006): 12-month formation, 6-month trading. Open when normalized prices drift k formation-sigmas apart, close when they cross.",
      defaults: { F: 252, T: 126, k: 2 },
      grid: { F: [126, 252], T: [63, 126], k: [1.5, 2, 2.5] },
      build(pa, pb, p) {
        const n = pa.length, st = new Int8Array(n), z = new Float64Array(n).fill(NaN);
        for (let c = p.F; c < n; c += p.T) {
          const d = [];
          for (let i = c - p.F; i < c; i++) d.push(pa[i] / pa[c - p.F] - pb[i] / pb[c - p.F]);
          const sd = global.Stats.std(d) || 1e-9;
          let s = 0;
          const end = Math.min(n, c + p.T);
          for (let t = c; t < end; t++) {
            const v = (pa[t] / pa[c - 1] - pb[t] / pb[c - 1]) / sd;
            z[t] = v;
            if (s === 0) { if (v > p.k) s = -1; else if (v < -p.k) s = 1; }
            else if ((s === 1 && v >= 0) || (s === -1 && v <= 0)) s = 0;
            st[t] = t === end - 1 ? 0 : s;
          }
        }
        return { st, z, weights: toWeights(st, null) };
      },
    },
    reversal: {
      name: "Buy the laggard",
      short: "Laggard",
      color: "#15803d",
      desc: "The headline rule: always long whichever twin has fallen behind over the last k days and short the one that ran ahead. Always in the market.",
      defaults: { k: 5 },
      grid: { k: [1, 2, 5, 10, 20] },
      build(pa, pb, p) {
        const n = pa.length, st = new Int8Array(n), z = new Float64Array(n).fill(NaN);
        for (let t = p.k; t < n; t++) {
          const g = Math.log(pa[t] / pa[t - p.k]) - Math.log(pb[t] / pb[t - p.k]);
          z[t] = g * 100;
          st[t] = g < 0 ? 1 : g > 0 ? -1 : st[t - 1];
        }
        return { st, z, weights: toWeights(st, null) };
      },
    },
    momentum: {
      name: "Buy the leader",
      short: "Leader",
      color: "#c2410c",
      desc: "The mirror image: long the twin that ran ahead, short the laggard. If the reversal effect is real, this should bleed.",
      defaults: { k: 5 },
      grid: { k: [1, 2, 5, 10, 20] },
      build(pa, pb, p) {
        const r = STRATEGIES.reversal.build(pa, pb, p);
        const st = r.st.map((v) => -v);
        return { st, z: r.z, weights: toWeights(st, null) };
      },
    },
    hold: {
      name: "Buy & hold both",
      short: "Hold",
      color: "#6b7280",
      desc: "Benchmark: half the money in each stock, never traded.",
      defaults: {},
      grid: {},
      build(pa) {
        const st = new Int8Array(pa.length).fill(2);
        return { st, z: null, weights: () => [0.5, 0.5] };
      },
    },
  };

  // Backtest: trade shares at the close of day t when the target state changes.
  // costBps is charged per side on traded notional.
  function simulate(pa, pb, key, params, start, end, costBps = 5, capital = 100000) {
    const S = STRATEGIES[key];
    const p = Object.assign({}, S.defaults, params || {});
    const built = S.build(pa, pb, p);
    const st = built.st;
    const eq = [], pos = [], trades = [];
    let cash = capital, sa = 0, sb = 0, cur = 0, open = null, costs = 0;
    for (let t = start; t <= end; t++) {
      const E = cash + sa * pa[t] + sb * pb[t];
      const want = t === end ? cur : st[t];
      if (want !== cur || (t === start && want !== 0)) {
        const [wa, wb] = built.weights(t);
        const na = (wa * E) / pa[t], nb = (wb * E) / pb[t];
        const fee = (costBps / 1e4) * (Math.abs(na - sa) * pa[t] + Math.abs(nb - sb) * pb[t]);
        costs += fee;
        cash = E - na * pa[t] - nb * pb[t] - fee;
        sa = na; sb = nb;
        if (open && cur !== 0) trades.push({ side: cur, entry: open.t, exit: t, pnl: E - open.E, ret: E / open.E - 1, days: t - open.t });
        open = want !== 0 ? { t, E: E - fee } : null;
        cur = want;
      }
      eq.push(cash + sa * pa[t] + sb * pb[t]);
      pos.push(cur);
    }
    if (open && cur !== 0 && cur !== 2) {
      const E = eq[eq.length - 1];
      trades.push({ side: cur, entry: open.t, exit: end, pnl: E - open.E, ret: E / open.E - 1, days: end - open.t, open: true });
    }
    const m = global.Stats.metrics(eq, key === "hold" ? null : trades);
    m.exposure = pos.filter((v) => v !== 0).length / pos.length;
    m.costs = costs;
    return { eq, pos, trades, z: built.z, metrics: m, params: p, start, end };
  }

  function gridList(grid) {
    const keys = Object.keys(grid);
    let combos = [{}];
    for (const k of keys) {
      const next = [];
      for (const c of combos) for (const v of grid[k]) next.push(Object.assign({}, c, { [k]: v }));
      combos = next;
    }
    return combos;
  }

  // Fit parameters on the train window (max Sharpe), report out-of-sample on the test window.
  function trainTest(pa, pb, key, trainStart, split, end, costBps) {
    const results = gridList(STRATEGIES[key].grid).map((params) => {
      const r = simulate(pa, pb, key, params, trainStart, split, costBps);
      return { params: r.params, train: r.metrics };
    });
    results.sort((a, b) => b.train.sharpe - a.train.sharpe);
    const best = results[0];
    const trainRun = simulate(pa, pb, key, best.params, trainStart, split, costBps);
    const testRun = simulate(pa, pb, key, best.params, split, end, costBps);
    return { grid: results, best: best.params, trainRun, testRun };
  }

  global.Strat = { STRATEGIES, simulate, trainTest, gridList, rollingZ };
})(window);

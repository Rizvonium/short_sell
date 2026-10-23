// Statistics helpers: OLS, ADF cointegration test, half-life, performance metrics.
(function (global) {
  "use strict";

  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  function std(a, m) {
    if (a.length < 2) return 0;
    m = m === undefined ? mean(a) : m;
    let s = 0;
    for (const v of a) s += (v - m) * (v - m);
    return Math.sqrt(s / (a.length - 1));
  }

  // Solve (X'X) b = X'y for small k by Gaussian elimination. X given as array of rows.
  function lstsq(X, y) {
    const k = X[0].length;
    const A = Array.from({ length: k }, () => new Float64Array(k + 1));
    for (let r = 0; r < X.length; r++) {
      const row = X[r];
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k; j++) A[i][j] += row[i] * row[j];
        A[i][k] += row[i] * y[r];
      }
    }
    for (let c = 0; c < k; c++) {
      let p = c;
      for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]];
      if (Math.abs(A[c][c]) < 1e-14) return null;
      for (let r = 0; r < k; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j];
      }
    }
    const b = new Array(k);
    for (let i = 0; i < k; i++) b[i] = A[i][k] / A[i][i];
    // residual variance + standard errors (needs the inverse diagonal; recompute cheaply)
    let sse = 0;
    for (let r = 0; r < X.length; r++) {
      let f = 0;
      for (let i = 0; i < k; i++) f += X[r][i] * b[i];
      sse += (y[r] - f) ** 2;
    }
    return { b, sse, n: X.length, k };
  }

  // Simple regression y = a + b x
  function ols(x, y) {
    const n = x.length;
    const mx = mean(x), my = mean(y);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) {
      sxy += (x[i] - mx) * (y[i] - my);
      sxx += (x[i] - mx) ** 2;
    }
    const beta = sxx ? sxy / sxx : 0;
    return { alpha: my - beta * mx, beta };
  }

  // Augmented Dickey-Fuller t-stat on gamma in: de_t = c + g e_{t-1} + sum phi_i de_{t-i}
  function adf(e, lags = 1) {
    const n = e.length;
    if (n < lags + 20) return { t: NaN, gamma: NaN };
    const de = [];
    for (let i = 1; i < n; i++) de.push(e[i] - e[i - 1]);
    const X = [], Y = [];
    for (let t = lags; t < de.length; t++) {
      const row = [1, e[t]];
      for (let j = 1; j <= lags; j++) row.push(de[t - j]);
      X.push(row);
      Y.push(de[t]);
    }
    const k = X[0].length;
    const fit = lstsq(X, Y);
    if (!fit) return { t: NaN, gamma: NaN };
    // se of gamma: sigma^2 * [(X'X)^-1]_{11}. Invert X'X via solving with unit vector.
    const XtX = Array.from({ length: k }, () => new Float64Array(k));
    for (const row of X) for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) XtX[i][j] += row[i] * row[j];
    const inv11 = invDiag(XtX, 1);
    const s2 = fit.sse / (fit.n - k);
    const se = Math.sqrt(s2 * inv11);
    return { t: fit.b[1] / se, gamma: fit.b[1] };
  }

  function invDiag(M, idx) {
    const k = M.length;
    const A = M.map((r, i) => {
      const row = Array.from(r);
      row.push(i === idx ? 1 : 0);
      return row;
    });
    for (let c = 0; c < k; c++) {
      let p = c;
      for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]];
      for (let r = 0; r < k; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j];
      }
    }
    return A[idx][k] / A[idx][idx];
  }

  // Engle-Granger critical values for 2 variables with constant (MacKinnon 2010, large sample)
  const EG_CRIT = { p01: -3.9, p05: -3.34, p10: -3.04 };
  function egPValue(t) {
    // rough piecewise interpolation, good enough to rank and label pairs
    if (!isFinite(t)) return 1;
    const pts = [[-5.0, 0.0005], [-4.5, 0.002], [-3.9, 0.01], [-3.34, 0.05], [-3.04, 0.1], [-2.5, 0.27], [-2.0, 0.5], [-1.0, 0.9], [0, 0.99]];
    if (t <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i][0]) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        return y0 + ((t - x0) / (x1 - x0)) * (y1 - y0);
      }
    }
    return 1;
  }

  // Engle-Granger two-step on log prices. Returns hedge ratio, ADF stat, half-life, spread stats.
  function cointegration(pa, pb) {
    const la = pa.map(Math.log), lb = pb.map(Math.log);
    const { alpha, beta } = ols(lb, la);
    const spread = la.map((v, i) => v - alpha - beta * lb[i]);
    const a = adf(spread, 1);
    return {
      alpha, beta,
      adf: a.t,
      p: egPValue(a.t),
      halfLife: halfLife(spread),
      spread,
      sd: std(spread),
    };
  }

  function halfLife(s) {
    const x = [], y = [];
    for (let i = 1; i < s.length; i++) {
      x.push(s[i - 1]);
      y.push(s[i] - s[i - 1]);
    }
    const { beta } = ols(x, y);
    if (beta >= 0) return Infinity;
    return -Math.log(2) / Math.log(1 + beta);
  }

  function returns(p) {
    const r = [];
    for (let i = 1; i < p.length; i++) r.push(p[i] / p[i - 1] - 1);
    return r;
  }

  function corr(x, y) {
    const mx = mean(x), my = mean(y);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < x.length; i++) {
      sxy += (x[i] - mx) * (y[i] - my);
      sxx += (x[i] - mx) ** 2;
      syy += (y[i] - my) ** 2;
    }
    return sxy / Math.sqrt(sxx * syy);
  }

  // Performance metrics from an equity curve (daily, 252 trading days/year)
  function metrics(eq, trades) {
    const n = eq.length;
    if (n < 2) return { total: 0, cagr: 0, vol: 0, sharpe: 0, maxDD: 0, calmar: 0 };
    const r = returns(eq);
    const m = mean(r), s = std(r, m);
    let peak = eq[0], mdd = 0;
    for (const v of eq) {
      if (v > peak) peak = v;
      const dd = v / peak - 1;
      if (dd < mdd) mdd = dd;
    }
    const years = n / 252;
    const total = eq[n - 1] / eq[0] - 1;
    const cagr = eq[n - 1] > 0 ? Math.pow(eq[n - 1] / eq[0], 1 / years) - 1 : -1;
    const out = {
      total,
      cagr,
      vol: s * Math.sqrt(252),
      sharpe: s > 0 ? (m / s) * Math.sqrt(252) : 0,
      maxDD: mdd,
      calmar: mdd < 0 ? cagr / -mdd : 0,
    };
    if (trades) {
      out.trades = trades.length;
      out.winRate = trades.length ? trades.filter((t) => t.pnl > 0).length / trades.length : 0;
      out.avgHold = trades.length ? mean(trades.map((t) => t.days)) : 0;
    }
    return out;
  }

  global.Stats = { mean, std, ols, adf, cointegration, halfLife, returns, corr, metrics, egPValue, EG_CRIT };
})(window);

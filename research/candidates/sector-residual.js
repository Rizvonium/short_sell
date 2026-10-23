// Avellaneda & Lee (2010) style residual statistical arbitrage with sector-peer factors.
// Each stock's daily returns are regressed on the leave-one-out equal-weight returns of its
// sector peers and of the rest of its market over a trailing 60-day window; the cumulative residual is fitted as an OU process
// (AR(1) on the residual index) and turned into an s-score. Positions are opened/closed on
// the s-score bands of the paper (checked every 5 trading days, at most `slots` positions) and
// each stock leg is hedged with beta units of its sector-peer and rest-of-market baskets.
(function (root) {
  "use strict";
  function create(params) {
    const P = params;
    let state = {};     // sym -> +1 long residual, -1 short residual
    let hedge = {};     // sym -> beta frozen at entry
    let peersOf = {};   // sym -> peer list (same sector, same market)
    let eig = [];       // PCA eigenportfolios {sym: weight}

    function form(ctx) {
      peersOf = {};
      for (const syms of Object.values(ctx.groups)) {
        for (const s of syms) peersOf[s] = syms.filter((x) => x !== s);
      }
      eig = P.pca > 0 ? pcaPortfolios(ctx) : [];
    }

    // Avellaneda-Lee eigenportfolios: top-K eigenvectors of the trailing correlation matrix of
    // standardized returns, weights v_i / sigma_i, normalized to unit gross. Fitted at ctx.now.
    function pcaPortfolios(ctx) {
      const L = P.pcaDays, T = ctx.now;
      if (T - L < 0) return [];
      const names = [], Z = [], sd = [];
      for (const s of Object.keys(peersOf)) {
        const r = rets(ctx, s, L);
        if (!r) continue;
        const m = r.reduce((a, b) => a + b, 0) / L;
        const v = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (L - 1));
        if (!(v > 0)) continue;
        names.push(s); sd.push(v); Z.push(r.map((x) => (x - m) / v));
      }
      const N = names.length;
      const C = Array.from({ length: N }, () => new Array(N).fill(0));
      for (let i = 0; i < N; i++) for (let j = i; j < N; j++) {
        let c = 0;
        for (let k = 0; k < L; k++) c += Z[i][k] * Z[j][k];
        C[i][j] = C[j][i] = c / (L - 1);
      }
      const out = [];
      for (let q = 0; q < Math.min(P.pca, N); q++) {
        let v = new Array(N).fill(1 / Math.sqrt(N)), lam = 0;
        if (q > 0) v = v.map((x, i) => (i % (q + 1) === 0 ? 1 : -1) / Math.sqrt(N));
        for (let it = 0; it < 300; it++) {
          const w = new Array(N).fill(0);
          for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) w[i] += C[i][j] * v[j];
          lam = Math.sqrt(w.reduce((a, b) => a + b * b, 0));
          if (!(lam > 0)) break;
          v = w.map((x) => x / lam);
        }
        // deflate
        for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) C[i][j] -= lam * v[i] * v[j];
        const w = {};
        let g = 0;
        names.forEach((s, i) => { w[s] = v[i] / sd[i]; g += Math.abs(w[s]); });
        for (const s in w) w[s] /= g;
        out.push(w);
      }
      return out;
    }

    // log returns over the last W days ending today; null if any price missing
    function rets(ctx, s, W) {
      const p = ctx.window(s, ctx.now - W, ctx.now);
      if (p.length !== W + 1) return null;
      const r = new Array(W);
      for (let k = 0; k < W; k++) {
        if (p[k] == null || p[k + 1] == null || p[k] <= 0) return null;
        r[k] = p[k + 1] / p[k] - 1;
      }
      return r;
    }

    // least squares via normal equations (k is tiny)
    function lstsq(X, y) {
      const k = X[0].length;
      const A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
      for (let r = 0; r < X.length; r++) {
        for (let i = 0; i < k; i++) {
          for (let j = 0; j < k; j++) A[i][j] += X[r][i] * X[r][j];
          A[i][k] += X[r][i] * y[r];
        }
      }
      for (let c = 0; c < k; c++) {
        let p = c;
        for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
        const tmp = A[c]; A[c] = A[p]; A[p] = tmp;
        if (Math.abs(A[c][c]) < 1e-14) return null;
        for (let r = 0; r < k; r++) {
          if (r === c) continue;
          const f = A[r][c] / A[c][c];
          for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j];
        }
      }
      return { b: A.map((row, i) => row[k] / row[i]) };
    }

    function weights(ctx) {
      const W = P.window;
      if (ctx.now - W < 0) return null;
      if (P.every > 1 && ctx.now % P.every !== 0) return null;
      const R = {};
      for (const s of Object.keys(peersOf)) R[s] = rets(ctx, s, W);
      const fits = {};
      const ms = [];
      for (const s of Object.keys(peersOf)) {
        const r = R[s];
        if (!r) continue;
        // factor baskets {sym: weight}: leave-one-out sector peers, optionally the rest of the
        // market (equal weight), or the PCA eigenportfolios
        const baskets = [];
        if (P.pca > 0) {
          for (const e of eig) if (Object.keys(e).every((x) => R[x])) baskets.push(e);
          if (!baskets.length) continue;
        } else {
          const pr = peersOf[s].filter((x) => R[x]);
          if (pr.length < P.minPeers) continue;
          baskets.push(Object.fromEntries(pr.map((x) => [x, 1 / pr.length])));
          if (P.market) {
            const mk = Object.keys(peersOf).filter((x) => x !== s && R[x]);
            baskets.push(Object.fromEntries(mk.map((x) => [x, 1 / mk.length])));
          }
        }
        const F = baskets.map((bk) => {
          const f = new Array(W).fill(0);
          for (const x in bk) for (let k = 0; k < W; k++) f[k] += R[x][k] * bk[x];
          return f;
        });
        const rows = [];
        for (let k = 0; k < W; k++) rows.push([1, ...F.map((f) => f[k])]);
        const fit0 = lstsq(rows, r);
        if (!fit0) continue;
        const coef = fit0.b;
        // cumulative residual X_k
        const X = new Array(W);
        let c = 0;
        for (let k = 0; k < W; k++) { let e = r[k] - coef[0];
          for (let j = 0; j < F.length; j++) e -= coef[j + 1] * F[j][k];
          c += e; X[k] = c; }
        // AR(1): X_{k+1} = a + b X_k + zeta
        const n = W - 1;
        let mx = 0, my = 0;
        for (let k = 0; k < n; k++) { mx += X[k]; my += X[k + 1]; }
        mx /= n; my /= n;
        let sxx = 0, sxy = 0;
        for (let k = 0; k < n; k++) { sxx += (X[k] - mx) ** 2; sxy += (X[k] - mx) * (X[k + 1] - my); }
        if (sxx <= 0) continue;
        const b = sxy / sxx, a = my - b * mx;
        if (!(b > 0 && b < 1)) continue;
        const kappa = -Math.log(b) * 252;
        let ve = 0;
        for (let k = 0; k < n; k++) ve += (X[k + 1] - a - b * X[k]) ** 2;
        ve /= n - 2;
        const seq = Math.sqrt(ve / (1 - b * b));
        if (!(seq > 0)) continue;
        const m = a / (1 - b);
        fits[s] = { betas: coef.slice(1), baskets, m, seq, kappa, X: X[W - 1] };
        ms.push(m);
      }
      // centre equilibrium levels cross-sectionally (Avellaneda & Lee, eq. 15)
      const mbar = ms.length ? ms.reduce((u, v) => u + v, 0) / ms.length : 0;
      let changed = false;
      const entries = [];
      for (const s of Object.keys(peersOf)) {
        const fit = fits[s];
        const cur = state[s] || 0;
        if (!fit) {
          // no valid data: close if the stock no longer trades
          if (cur && ctx.px(s, ctx.now) == null) { delete state[s]; delete hedge[s]; changed = true; }
          continue;
        }
        const sc = (fit.X - (fit.m - mbar)) / fit.seq;
        const ok = fit.kappa > 252 / P.maxTau;
        if (cur === 0) {
          if (ok && sc < -P.sbo) entries.push({ s, d: 1, sc, fit });
          else if (ok && sc > P.sso) entries.push({ s, d: -1, sc, fit });
        } else if ((cur === 1 && sc > -P.sbc) || (cur === -1 && sc < P.ssc)) {
          delete state[s]; delete hedge[s]; changed = true;
        }
      }
      // open new positions, most extreme s-score first, while free slots remain
      entries.sort((x, y) => Math.abs(y.sc) - Math.abs(x.sc) || (x.s < y.s ? -1 : 1));
      let open = Object.keys(state).length;
      for (const e of entries) {
        if (P.capSlots && open >= P.slots) break;
        state[e.s] = e.d; hedge[e.s] = { betas: e.fit.betas, baskets: e.fit.baskets };
        open++; changed = true;
      }
      if (!changed) return null;
      // positions are held in shares (like a real account): untouched positions just drift,
      // only the legs of opened/closed positions are traded
      const E = ctx.equity(), u = P.maxGross / (2 * P.slots), now = ctx.now;
      for (const s of Object.keys(state)) {
        const h = hedge[s];
        if (h.sh) continue;
        const d = state[s], sh = {};
        sh[s] = (d * u * E) / ctx.px(s, now);
        h.baskets.forEach((bk, j) => {
          for (const x in bk) {
            const px = ctx.px(x, now);
            if (px != null) sh[x] = (sh[x] || 0) - (d * h.betas[j] * bk[x] * u * E) / px;
          }
        });
        h.sh = sh;
      }
      const out = {};
      for (const s of Object.keys(state)) {
        for (const [x, q] of Object.entries(hedge[s].sh)) {
          const px = ctx.px(x, now);
          if (px != null) out[x] = (out[x] || 0) + (q * px) / E;
        }
      }
      return out;
    }
    return { form, weights };
  }
  const def = {
    id: "sector-residual",
    name: "Sector residual s-score",
    short: "Residual",
    description: "Each stock is compared with the average of its sector peers; when it drifts unusually far from where its peers say it should be, bet on it snapping back and hedge with the peers.",
    defaults: { window: 60, sbo: 1.25, sso: 1.25, sbc: 0.5, ssc: 0.75, maxTau: 30, minPeers: 2, market: true, every: 5, pca: 0, pcaDays: 252, maxGross: 1, slots: 10, capSlots: true },
    create,
  };
  if (typeof module === "object" && module.exports) module.exports = def;
  else (root.Candidates = root.Candidates || {})[def.id] = def;
})(typeof window !== "undefined" ? window : globalThis);

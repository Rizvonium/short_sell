// UI for Twin Shares Lab: routing, charts, scanner, lab, arena and game.
(function () {
  "use strict";
  const S = Strat.STRATEGIES;
  const KEYS = Object.keys(S);
  const $ = (id) => document.getElementById(id);
  const charts = {};
  let DATA = null, CLASSIC = null;

  // ---------- formatting ----------
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const pct = (v, d = 1) => (v >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%";
  const bigPct = (v) => {
    const p = v * 100;
    return Math.abs(p) >= 1000 ? (p >= 0 ? "+" : "") + Math.round(p).toLocaleString("en-US") + "%" : pct(v);
  };
  const money = (v, c = "$") => (v < 0 ? "-" : "") + c + Math.round(Math.abs(v)).toLocaleString("en-US");
  const cls = (v) => (v >= 0 ? "pos" : "neg");
  const tk = (s) => s.replace(".NS", "");
  const cur = (mkt) => (mkt === "IN" ? "₹" : "$");
  const f2 = (v) => (isFinite(v) ? v.toFixed(2) : "–");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const paramStr = (p) => Object.entries(p).map(([k, v]) => `${k}=${v}`).join(" ") || "–";
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  // ---------- data helpers ----------
  const pairCache = new Map();
  function pair(mkt, a, b) {
    const key = mkt + a + "|" + b;
    if (pairCache.has(key)) return pairCache.get(key);
    const m = DATA.markets[mkt], A = m.closes[a], B = m.closes[b];
    let first = -1, la = null, lb = null;
    const pa = [], pb = [];
    for (let i = 0; i < m.dates.length; i++) {
      if (A[i] != null) la = A[i];
      if (B[i] != null) lb = B[i];
      if (la != null && lb != null) {
        if (first < 0) first = i;
        pa.push(la); pb.push(lb);
      }
    }
    const P = { mkt, a, b, pa, pb, first, dates: m.dates.slice(first) };
    pairCache.set(key, P);
    return P;
  }
  function pairsOf(mkt) {
    const out = [];
    for (const [g, syms] of Object.entries(DATA.markets[mkt].groups))
      for (let i = 0; i < syms.length; i++) for (let j = i + 1; j < syms.length; j++) out.push({ a: syms[i], b: syms[j], group: g });
    return out;
  }
  const idxOnOrAfter = (dates, d) => { const i = dates.findIndex((x) => x >= d); return i < 0 ? dates.length - 1 : i; };
  function fillPairSelect(sel, mkt, extra) {
    const groups = DATA.markets[mkt].groups;
    let html = extra || "";
    for (const g of Object.keys(groups)) {
      const opts = pairsOf(mkt).filter((p) => p.group === g)
        .map((p) => `<option value="${p.a}|${p.b}">${tk(p.a)} / ${tk(p.b)}</option>`).join("");
      if (opts) html += `<optgroup label="${esc(g)}">${opts}</optgroup>`;
    }
    sel.innerHTML = html;
  }

  // ---------- charts ----------
  function downsample(n, max) {
    const step = Math.max(1, Math.ceil(n / max)), idx = [];
    for (let i = 0; i < n; i += step) idx.push(i);
    if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
    return idx;
  }
  function lineChart(id, labels, datasets, opt = {}) {
    if (charts[id]) charts[id].destroy();
    const grid = css("--line"), tick = css("--muted");
    Chart.defaults.font.family = '"JetBrains Mono", ui-monospace, monospace';
    Chart.defaults.font.size = 11;
    charts[id] = new Chart($(id), {
      type: "line",
      data: {
        labels,
        datasets: datasets.map((d) => Object.assign({ borderWidth: 1.6, pointRadius: 0, pointHoverRadius: 3, tension: 0, fill: false }, d)),
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: (c) => c.raw != null && !c.dataset.noTip,
            callbacks: { label: (c) => ` ${c.dataset.label}: ${opt.fmt ? opt.fmt(c.parsed.y) : c.parsed.y.toFixed(2)}` },
          },
        },
        scales: {
          x: { ticks: { color: tick, maxTicksLimit: 7, autoSkip: true, maxRotation: 0 }, grid: { display: false } },
          y: Object.assign(
            { type: opt.log ? "logarithmic" : "linear", ticks: { color: tick, callback: opt.yfmt }, grid: { color: grid } },
            opt.y || {}
          ),
        },
      },
    });
    return charts[id];
  }
  const logTicks = (fmt) => (v) => {
    const l = Math.log10(v);
    return Math.abs(l - Math.round(l)) < 1e-6 ? fmt(v) : "";
  };
  function legend(id, items) {
    $(id).innerHTML = items
      .map((i) => `<span><i style="background:${i.color};${i.dash ? "opacity:.6" : ""}"></i>${esc(i.label)}</span>`).join("");
  }
  function statTiles(id, tiles) {
    $(id).innerHTML = tiles
      .map((t) => `<div class="stat"><div class="k">${esc(t.k)}</div><div class="v ${t.c || ""}">${t.v}</div>${t.s ? `<div class="s">${t.s}</div>` : ""}</div>`).join("");
  }
  const band = (n, v, color) => ({ label: `${v}`, data: new Array(n).fill(v), borderColor: color, borderWidth: 1, borderDash: [4, 4], noTip: true });

  // ---------- STORY: Coke vs Pepsi ----------
  function renderStory() {
    const d = CLASSIC, k = +$("st-k").value, cost = +$("st-cost").value;
    const s0 = Math.max(k, idxOnOrAfter(d.dates, $("st-from").value));
    const end = d.dates.length - 1;
    const run = (key) => Strat.simulate(d.pa, d.pb, key, { k }, s0, end, cost, 1);
    const lag = run("reversal"), lead = run("momentum"), hold = run("hold");
    const years = ((end - s0) / 252).toFixed(0);
    statTiles("st-stats", [
      { k: "Buy the laggard", v: bigPct(lag.metrics.total), c: cls(lag.metrics.total), s: `${pct(lag.metrics.cagr)} a year · Sharpe ${f2(lag.metrics.sharpe)}` },
      { k: "Buy the leader", v: bigPct(lead.metrics.total), c: cls(lead.metrics.total), s: `${pct(lead.metrics.cagr)} a year · max loss ${pct(lead.metrics.maxDD, 0)}` },
      { k: "Hold both", v: bigPct(hold.metrics.total), c: cls(hold.metrics.total), s: "50% PEP + 50% KO, dividends in" },
      { k: "Switches", v: lag.trades.length.toLocaleString("en-US"), s: `leader changes over ${years} years` },
    ]);
    const idx = downsample(end - s0 + 1, 1600);
    const labels = idx.map((i) => d.dates[s0 + i]);
    const pick = (eq) => idx.map((i) => eq[i]);
    const A = css("--good"), B = css("--bad"), G = css("--muted");
    lineChart("st-chart", labels, [
      { label: "Long laggard / short leader", data: pick(lag.eq), borderColor: A },
      { label: "Long leader / short laggard", data: pick(lead.eq), borderColor: B },
      { label: "Hold both", data: pick(hold.eq), borderColor: G, borderDash: [5, 4], borderWidth: 1.2 },
    ], { log: true, fmt: (v) => "$" + (v < 10 ? v.toFixed(3) : Math.round(v).toLocaleString("en-US")), yfmt: logTicks((v) => "$" + (v >= 1 ? v.toLocaleString("en-US") : v)) });
    legend("st-legend", [
      { label: "Long laggard / short leader", color: A },
      { label: "Long leader / short laggard", color: B },
      { label: "Hold both", color: G, dash: true },
    ]);
  }

  // ---------- SCANNER ----------
  const scanCache = new Map();
  let scanSort = { key: "p", dir: 1 }, scanSel = null;
  function scan(mkt, win, L) {
    const key = `${mkt}|${win}|${L}`;
    if (scanCache.has(key)) return scanCache.get(key);
    const rows = [];
    for (const p of pairsOf(mkt)) {
      const P = pair(mkt, p.a, p.b), n = P.pa.length;
      if (n < win + L) continue;
      const sa = P.pa.slice(n - win), sb = P.pb.slice(n - win);
      const c = Stats.cointegration(sa, sb);
      const corr = Stats.corr(Stats.returns(sa), Stats.returns(sb));
      const z = Strat.rollingZ(P.pa.slice(n - win - L), P.pb.slice(n - win - L), L).z;
      const zNow = z[z.length - 1];
      let sig = 0;
      if (c.p <= 0.1 && Math.abs(zNow) >= 2) sig = zNow > 0 ? -1 : 1;
      rows.push(Object.assign({}, p, { corr, adf: c.adf, p: c.p, hl: c.halfLife, beta: c.beta, z: zNow, sig, P }));
    }
    scanCache.set(key, rows);
    return rows;
  }
  function sigText(r) {
    if (r.sig === 1) return `Buy ${tk(r.a)} · Short ${tk(r.b)}`;
    if (r.sig === -1) return `Short ${tk(r.a)} · Buy ${tk(r.b)}`;
    return "";
  }
  function renderScan() {
    const mkt = $("sc-mkt").value, win = +$("sc-win").value, L = +$("sc-L").value;
    let rows = scan(mkt, win, L);
    const coint = rows.filter((r) => r.p <= 0.05).length, sigs = rows.filter((r) => r.sig).length;
    const last = DATA.markets[mkt].dates.at(-1);
    statTiles("sc-stats", [
      { k: "Pairs scanned", v: rows.length, s: `same-sector pairs, ${Object.keys(DATA.markets[mkt].groups).length} sectors` },
      { k: "Cointegrated (5%)", v: coint, s: `${Math.round((100 * coint) / rows.length)}% of pairs in this window` },
      { k: "Live signals", v: sigs, c: sigs ? "pos" : "", s: "p ≤ 0.10 and |z| ≥ 2" },
      { k: "Prices as of", v: last, s: "daily close" },
    ]);
    if ($("sc-only").checked) rows = rows.filter((r) => r.sig);
    const k = scanSort.key, dir = scanSort.dir;
    rows = rows.slice().sort((x, y) => {
      const a = k === "absz" ? Math.abs(x.z) : x[k], b = k === "absz" ? Math.abs(y.z) : y[k];
      return (typeof a === "string" ? a.localeCompare(b) : a - b) * dir;
    });
    const cols = [["a", "Pair", ""], ["group", "Sector", ""], ["corr", "Return corr", "num"], ["adf", "ADF t", "num"], ["p", "p-value", "num"], ["hl", "Half-life (d)", "num"], ["beta", "Hedge β", "num"], ["absz", "Z now", "num"], ["sig", "Signal", ""]];
    const head = `<thead><tr>${cols.map(([key, l, c]) => `<th class="sort ${c}" data-k="${key}">${l}${k === key ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead>`;
    const body = rows.map((r) => {
      const id = r.a + "|" + r.b;
      const pc = r.p <= 0.01 ? "good" : r.p <= 0.05 ? "good" : r.p <= 0.1 ? "warn" : "";
      return `<tr class="click ${scanSel === id ? "sel" : ""}" data-id="${id}">
        <td><b>${tk(r.a)}</b> / <b>${tk(r.b)}</b></td><td class="muted">${esc(r.group)}</td>
        <td class="num">${f2(r.corr)}</td><td class="num">${f2(r.adf)}</td>
        <td class="num"><span class="chip ${pc}">${r.p < 0.001 ? "<0.001" : r.p.toFixed(3)}</span></td>
        <td class="num">${isFinite(r.hl) ? r.hl.toFixed(0) : "∞"}</td><td class="num">${f2(r.beta)}</td>
        <td class="num ${Math.abs(r.z) >= 2 ? (r.z > 0 ? "neg" : "pos") : ""}">${r.z >= 0 ? "+" : ""}${f2(r.z)}</td>
        <td>${r.sig ? `<span class="chip ${r.sig > 0 ? "good" : "bad"}">${sigText(r)}</span>` : '<span class="muted small">–</span>'}</td></tr>`;
    }).join("");
    $("sc-table").innerHTML = head + `<tbody>${body || '<tr><td colspan="9" class="muted">No pair is stretched past ±2 right now. Untick "Only show signals" to see all pairs.</td></tr>'}</tbody>`;
    if (!scanSel || !rows.find((r) => r.a + "|" + r.b === scanSel)) {
      const best = rows.slice().sort((x, y) => (y.sig ? 1 : 0) - (x.sig ? 1 : 0) || x.p - y.p)[0];
      scanSel = best ? best.a + "|" + best.b : null;
      $("sc-table").querySelectorAll("tr[data-id]").forEach((tr) => tr.classList.toggle("sel", tr.dataset.id === scanSel));
    }
    renderScanDetail(mkt, win, L);
  }
  function renderScanDetail(mkt, win, L) {
    const r = scan(mkt, win, L).find((x) => x.a + "|" + x.b === scanSel);
    const box = $("sc-detail");
    if (!r) { box.innerHTML = '<p class="muted">Select a pair in the table.</p>'; return; }
    const P = r.P, n = P.pa.length, c = cur(mkt);
    const lastA = P.pa[n - 1], lastB = P.pb[n - 1];
    const b = Math.max(0.2, Math.min(5, r.beta)), gross = mkt === "IN" ? 1000000 : 10000;
    const legA = gross / (1 + b), legB = (gross * b) / (1 + b);
    const coint = r.p <= 0.05 ? "cointegrated at 5%" : r.p <= 0.1 ? "cointegrated at 10%" : "not cointegrated in this window";
    let idea;
    if (r.sig) {
      const buy = r.sig > 0 ? r.a : r.b, sell = r.sig > 0 ? r.b : r.a;
      const buyAmt = r.sig > 0 ? legA : legB, sellAmt = r.sig > 0 ? legB : legA;
      const buyPx = r.sig > 0 ? lastA : lastB, sellPx = r.sig > 0 ? lastB : lastA;
      idea = `<p><b>Trade idea:</b> buy ${money(buyAmt, c)} of ${tk(buy)} (≈${Math.floor(buyAmt / buyPx)} sh at ${c}${buyPx.toFixed(2)}) and short ${money(sellAmt, c)} of ${tk(sell)} (≈${Math.floor(sellAmt / sellPx)} sh at ${c}${sellPx.toFixed(2)}). Take profit when z returns inside ±0.5; stop out beyond ±4. A half-life of ${isFinite(r.hl) ? r.hl.toFixed(0) : "∞"} days says how long a typical gap takes to close by half.${mkt === "IN" ? " In India, hold the short leg overnight through stock futures or SLB." : ""}</p>`;
    } else {
      idea = `<p class="muted">No trade today: ${Math.abs(r.z) < 2 ? `the spread is ${f2(r.z)} standard deviations from its mean, inside the ±2 entry band` : "the pair fails the cointegration test, so a wide gap may not close"}.</p>`;
    }
    box.innerHTML = `<div class="row"><h3>${tk(r.a)} / ${tk(r.b)}</h3><span class="chip ${r.p <= 0.05 ? "good" : r.p <= 0.1 ? "warn" : ""}">${coint}</span>
      <span class="muted small">${esc(DATA.meta[r.a].name)} vs ${esc(DATA.meta[r.b].name)}</span></div>${idea}
      <div class="legend" id="sc-leg"></div><div class="chart"><canvas id="sc-price"></canvas></div>
      <div class="eyebrow">Spread z-score (${L}-day rolling regression)</div><div class="chart short"><canvas id="sc-z"></canvas></div>`;
    const s = n - win, labels = P.dates.slice(s);
    const ca = css("--leg-a"), cb = css("--leg-b");
    lineChart("sc-price", labels, [
      { label: tk(r.a), data: P.pa.slice(s).map((v) => (100 * v) / P.pa[s]), borderColor: ca },
      { label: tk(r.b), data: P.pb.slice(s).map((v) => (100 * v) / P.pb[s]), borderColor: cb },
    ], { fmt: (v) => v.toFixed(1) });
    legend("sc-leg", [{ label: `${tk(r.a)} (rebased to 100)`, color: ca }, { label: `${tk(r.b)} (rebased to 100)`, color: cb }]);
    const z = Strat.rollingZ(P.pa, P.pb, L).z.slice(s);
    const m = css("--muted");
    lineChart("sc-z", labels, [
      { label: "z", data: Array.from(z), borderColor: css("--accent") },
      band(win, 2, m), band(win, -2, m), band(win, 0, css("--line")),
    ], { y: { suggestedMin: -3, suggestedMax: 3 } });
  }

  // ---------- LAB ----------
  let labRes = null, labSel = "zscore";
  function runLab() {
    const mkt = $("lb-mkt").value, [a, b] = $("lb-pair").value.split("|");
    const P = pair(mkt, a, b), n = P.pa.length, cost = +$("lb-cost").value;
    const from = Math.max(1, idxOnOrAfter(P.dates, $("lb-from").value + "-01-01"));
    const split = from + Math.floor((n - 1 - from) * (+$("lb-split").value / 100));
    const res = {};
    for (const k of KEYS) res[k] = Strat.trainTest(P.pa, P.pb, k, from, split, n - 1, cost);
    labRes = { P, from, split, res, mkt };
    renderLab();
  }
  function renderLab() {
    if (!labRes) return;
    const { P, from, split, res } = labRes;
    const order = KEYS.slice().sort((x, y) => res[y].testRun.metrics.sharpe - res[x].testRun.metrics.sharpe);
    const head = `<thead><tr><th>#</th><th>Strategy</th><th>Tuned params</th><th class="num">Train return</th><th class="num">Train Sharpe</th><th class="num">Test return</th><th class="num">Test Sharpe</th><th class="num">Test max DD</th><th class="num">Trades</th><th class="num">Win rate</th><th class="num">Overfit gap</th></tr></thead>`;
    const body = order.map((k, i) => {
      const tr = res[k].trainRun.metrics, te = res[k].testRun.metrics, gap = tr.sharpe - te.sharpe;
      return `<tr class="click ${k === labSel ? "sel" : ""}" data-k="${k}"><td class="num">${i + 1}</td>
        <td><span style="color:${S[k].color}">■</span> <b>${S[k].name}</b></td><td class="mono small">${paramStr(res[k].best)}</td>
        <td class="num ${cls(tr.total)}">${pct(tr.total)}</td><td class="num">${f2(tr.sharpe)}</td>
        <td class="num ${cls(te.total)}"><b>${pct(te.total)}</b></td><td class="num"><b>${f2(te.sharpe)}</b></td>
        <td class="num neg">${pct(te.maxDD)}</td><td class="num">${te.trades ?? "–"}</td>
        <td class="num">${te.winRate != null ? Math.round(te.winRate * 100) + "%" : "–"}</td>
        <td class="num"><span class="chip ${gap > 1 ? "bad" : gap > 0.4 ? "warn" : "good"}">${gap >= 0 ? "+" : ""}${f2(gap)}</span></td></tr>`;
    }).join("");
    $("lb-table").innerHTML = head + `<tbody>${body}</tbody>`;

    const k = labSel, r = res[k];
    $("lb-sel-title").textContent = `${S[k].name} on ${tk(P.a)} / ${tk(P.b)}: train ${P.dates[from].slice(0, 4)}–${P.dates[split].slice(0, 7)}, test to ${P.dates.at(-1).slice(0, 7)}`;
    const n = P.pa.length, labels = P.dates.slice(from);
    const tr = r.trainRun.eq, te = r.testRun.eq, scale = tr[tr.length - 1] / te[0];
    const hold = Strat.simulate(P.pa, P.pb, "hold", {}, from, n - 1, 0).eq;
    const trainData = labels.map((_, i) => (i <= split - from ? tr[i] / 1e5 : null));
    const testData = labels.map((_, i) => (i >= split - from ? (te[i - (split - from)] * scale) / 1e5 : null));
    const muted = css("--muted");
    lineChart("lb-chart", labels, [
      { label: "Train (in-sample)", data: trainData, borderColor: muted },
      { label: "Test (out-of-sample)", data: testData, borderColor: S[k].color, borderWidth: 2 },
      { label: "Hold both", data: hold.map((v) => v / 1e5), borderColor: muted, borderDash: [4, 4], borderWidth: 1 },
    ], { fmt: (v) => "$" + v.toFixed(2) });
    legend("lb-legend", [{ label: "Train (in-sample)", color: muted }, { label: "Test (out-of-sample)", color: S[k].color }, { label: "Hold both", color: muted, dash: true }]);

    const gh = `<thead><tr><th>Params</th><th class="num">Return</th><th class="num">Sharpe</th><th class="num">Max DD</th><th class="num">Trades</th></tr></thead>`;
    const gb = r.grid.slice(0, 20).map((g, i) => `<tr ${i === 0 ? 'class="sel"' : ""}><td class="mono small">${paramStr(g.params)}${i === 0 ? ' <span class="chip good">chosen</span>' : ""}</td>
      <td class="num ${cls(g.train.total)}">${pct(g.train.total)}</td><td class="num">${f2(g.train.sharpe)}</td><td class="num">${pct(g.train.maxDD)}</td><td class="num">${g.train.trades ?? "–"}</td></tr>`).join("");
    $("lb-grid").innerHTML = gh + `<tbody>${gb}</tbody>`;
  }

  // Walk-forward portfolio: each year, rank pairs on the previous train years, trade top/bottom/all next year.
  function runPortfolio() {
    const mkt = $("pf-mkt").value, ty = +$("pf-train").value, N = +$("pf-n").value, y0 = +$("pf-split").value;
    const dates = DATA.markets[mkt].dates, lastY = +dates.at(-1).slice(0, 4);
    const pairs = pairsOf(mkt).map((p) => Object.assign(p, { P: pair(mkt, p.a, p.b) }));
    const books = { top: [1], bottom: [1], all: [1] }, labels = [], years = [];
    for (let Y = y0; Y <= lastY; Y++) {
      const ts = idxOnOrAfter(dates, `${Y}-01-01`), te = Y === lastY ? dates.length - 1 : idxOnOrAfter(dates, `${Y + 1}-01-01`) - 1;
      const tr = idxOnOrAfter(dates, `${Y - ty}-01-01`);
      if (te <= ts) continue;
      const ranked = [];
      for (const p of pairs) {
        if (p.P.first > tr - 130) continue;
        const o = p.P.first, c = Stats.cointegration(p.P.pa.slice(tr - o, ts - o), p.P.pb.slice(tr - o, ts - o));
        ranked.push({ p, score: c.adf });
      }
      ranked.sort((x, y) => x.score - y.score);
      const legs = { top: ranked.slice(0, N), bottom: ranked.slice(-N), all: ranked };
      const yr = { Y, n: ranked.length };
      for (const [book, list] of Object.entries(legs)) {
        const daily = new Array(te - ts + 1).fill(0);
        for (const { p } of list) {
          const o = p.P.first, eq = Strat.simulate(p.P.pa, p.P.pb, "zscore", {}, ts - o - 1, te - o, 5).eq;
          for (let i = 1; i < eq.length; i++) daily[i - 1] += (eq[i] / eq[i - 1] - 1) / list.length;
        }
        const arr = books[book];
        let prod = 1;
        for (const r of daily) { arr.push(arr[arr.length - 1] * (1 + r)); prod *= 1 + r; }
        yr[book] = prod - 1;
      }
      yr.names = legs.top.map(({ p }) => `${tk(p.a)}/${tk(p.b)}`);
      years.push(yr);
      for (let i = ts; i <= te; i++) labels.push(dates[i]);
    }
    if (!years.length) return;
    labels.unshift(dates[idxOnOrAfter(dates, `${y0}-01-01`) - 1]);
    const m = (k) => Stats.metrics(books[k]);
    const mt = m("top"), mb = m("bottom"), ma = m("all");
    statTiles("pf-stats", [
      { k: `Top ${N} (most cointegrated)`, v: pct(mt.total), c: cls(mt.total), s: `Sharpe ${f2(mt.sharpe)} · max DD ${pct(mt.maxDD, 0)}` },
      { k: `Bottom ${N} (least)`, v: pct(mb.total), c: cls(mb.total), s: `Sharpe ${f2(mb.sharpe)} · max DD ${pct(mb.maxDD, 0)}` },
      { k: "All pairs", v: pct(ma.total), c: cls(ma.total), s: `Sharpe ${f2(ma.sharpe)} · ${years.at(-1).n} pairs` },
      { k: "Years tested", v: `${years[0].Y}–${years.at(-1).Y}`, s: `${ty}y train, re-selected yearly` },
    ]);
    const cT = css("--accent"), cB = css("--leg-b"), cA = css("--muted");
    lineChart("pf-chart", labels, [
      { label: `Top ${N}`, data: books.top, borderColor: cT, borderWidth: 2 },
      { label: `Bottom ${N}`, data: books.bottom, borderColor: cB },
      { label: "All pairs", data: books.all, borderColor: cA, borderDash: [4, 4] },
    ], { fmt: (v) => "$" + v.toFixed(3) });
    legend("pf-legend", [{ label: `Top ${N}`, color: cT }, { label: `Bottom ${N}`, color: cB }, { label: "All pairs", color: cA, dash: true }]);
    $("pf-table").innerHTML = `<thead><tr><th>Test year</th><th class="num">Top ${N}</th><th class="num">Bottom ${N}</th><th class="num">All</th><th>Pairs chosen in training</th></tr></thead><tbody>` +
      years.map((y) => `<tr><td class="mono">${y.Y}${y.Y === years.at(-1).Y ? " (YTD)" : ""}</td><td class="num ${cls(y.top)}">${pct(y.top)}</td><td class="num ${cls(y.bottom)}">${pct(y.bottom)}</td><td class="num ${cls(y.all)}">${pct(y.all)}</td><td class="small muted">${y.names.join(", ")}</td></tr>`).join("") + "</tbody>";
  }

  // ---------- ARENA ----------
  let arena = null, arenaTimer = null;
  function tuneParams(pa, pb, key, s, e) {
    if (!Object.keys(S[key].grid).length) return {};
    let best = null;
    for (const params of Strat.gridList(S[key].grid)) {
      const r = Strat.simulate(pa, pb, key, params, s, e, 5);
      if (!best || r.metrics.sharpe > best.sh) best = { sh: r.metrics.sharpe, params };
    }
    return best.params;
  }
  function setupArena() {
    stopArena();
    const mkt = $("ar-mkt").value, field = $("ar-pair").value, len = +$("ar-len").value, cost = +$("ar-cost").value;
    const dates = DATA.markets[mkt].dates, end = dates.length - 1, start = end - len, tune = Math.max(0, start - 756);
    let books;
    if (field.startsWith("__top")) {
      const N = +field.slice(5);
      const ranked = pairsOf(mkt).map((p) => ({ p, P: pair(mkt, p.a, p.b) })).filter((x) => x.P.first <= tune)
        .map((x) => Object.assign(x, { adf: Stats.cointegration(x.P.pa.slice(tune - x.P.first, start - x.P.first), x.P.pb.slice(tune - x.P.first, start - x.P.first)).adf }))
        .sort((x, y) => x.adf - y.adf).slice(0, N);
      books = KEYS.map((k) => {
        const runs = ranked.map((x) => {
          const o = x.P.first;
          return Strat.simulate(x.P.pa, x.P.pb, k, tuneParams(x.P.pa, x.P.pb, k, tune - o, start - o), start - o, end - o, cost);
        });
        const eq = runs[0].eq.map((_, i) => runs.reduce((s, r) => s + r.eq[i], 0) / runs.length);
        const pos = runs[0].pos.map((_, i) => runs.filter((r) => r.pos[i] !== 0).length);
        const trades = runs.flatMap((r) => r.trades);
        return { k, eq, pos, trades, multi: runs.length, label: `${runs.length} pairs` };
      });
      arena = { mkt, labels: dates.slice(start, end + 1), books, desc: `Top ${N} pairs by cointegration in the 3 years before the race: ${ranked.map((x) => `${tk(x.p.a)}/${tk(x.p.b)}`).join(", ")}` };
    } else {
      const [a, b] = field.split("|"), P = pair(mkt, a, b), o = P.first;
      const s = Math.max(1, start - o), tu = Math.max(0, tune - o);
      books = KEYS.map((k) => {
        const params = tuneParams(P.pa, P.pb, k, tu, s);
        const r = Strat.simulate(P.pa, P.pb, k, params, s, P.pa.length - 1, cost);
        return { k, eq: r.eq, pos: r.pos, trades: r.trades, params, a, b };
      });
      arena = { mkt, labels: P.dates.slice(s), books, desc: `${tk(a)} vs ${tk(b)} · each strategy tuned on ${P.dates[tu].slice(0, 4)}–${P.dates[s].slice(0, 7)}` };
    }
    arena.day = arena.labels.length - 1;
    drawArenaChart();
    updateArena();
  }
  function drawArenaChart() {
    const A = arena;
    lineChart("ar-chart", A.labels, A.books.map((b) => ({
      label: S[b.k].short, data: b.eq.slice(0, A.day + 1), borderColor: S[b.k].color, borderWidth: b.k === "hold" ? 1.2 : 1.8, borderDash: b.k === "hold" ? [4, 4] : undefined,
    })), { fmt: (v) => money(v, cur(A.mkt)), yfmt: (v) => cur(A.mkt) + Math.round(v / 1000) + "k" });
    legend("ar-legend", A.books.map((b) => ({ label: S[b.k].name, color: S[b.k].color, dash: b.k === "hold" })));
  }
  function posChip(b, i) {
    const p = b.pos[i];
    if (b.multi) return p ? `<span class="chip warn">${p}/${b.multi} open</span>` : '<span class="chip">flat</span>';
    if (p === 2) return '<span class="chip">long both</span>';
    if (p === 1) return `<span class="chip good">+${tk(b.a)} −${tk(b.b)}</span>`;
    if (p === -1) return `<span class="chip bad">+${tk(b.b)} −${tk(b.a)}</span>`;
    return '<span class="chip">flat</span>';
  }
  function updateArena() {
    const A = arena, d = A.day, c = cur(A.mkt);
    const rows = A.books.map((b) => {
      const eq = b.eq.slice(0, d + 1), m = Stats.metrics(eq);
      return { b, eq: eq[eq.length - 1], m };
    });
    const ranked = rows.slice().sort((x, y) => y.eq - x.eq);
    const board = $("ar-board");
    if (!board.dataset.built || board.dataset.built !== A.books.map((b) => b.k).join()) {
      board.innerHTML = `<div class="lb-row head"><span>#</span><span>Strategy</span><span class="c">Equity</span><span class="c">Return</span><span class="c">Sharpe</span><span class="c">Max DD</span><span class="c">Position</span></div>` +
        A.books.map((b) => `<div class="lb-row" data-k="${b.k}"></div>`).join("");
      board.dataset.built = A.books.map((b) => b.k).join();
    }
    const first = board.querySelector(".lb-row[data-k]");
    const H = first && first.offsetHeight ? first.offsetHeight + 6 : 50;
    rows.forEach((r, i) => {
      const rank = ranked.indexOf(r), el = board.querySelector(`[data-k="${r.b.k}"]`);
      el.style.transform = `translateY(${(rank - i) * H}px)`;
      el.innerHTML = `<span class="rk">${rank + 1}</span><span class="nm"><i style="background:${S[r.b.k].color}"></i><span>${S[r.b.k].name}</span></span>
        <span class="c">${money(r.eq, c)}</span><span class="c ${cls(r.m.total)}">${pct(r.m.total)}</span><span class="c">${f2(r.m.sharpe)}</span>
        <span class="c neg">${pct(r.m.maxDD)}</span><span class="c">${posChip(r.b, d)}</span>`;
    });
    statTiles("ar-stats", [
      { k: "Race day", v: `${d + 1} / ${A.labels.length}`, s: A.labels[d] },
      { k: "In the lead", v: S[ranked[0].b.k].name, s: `${pct(ranked[0].m.total)} so far` },
      { k: "Field", v: A.books[0].multi ? `${A.books[0].multi} pairs` : "1 pair", s: esc(A.desc) },
    ]);
    const ch = charts["ar-chart"];
    if (ch) {
      ch.data.datasets.forEach((ds, i) => { ds.data = A.books[i].eq.slice(0, d + 1); });
      ch.update("none");
    }
  }
  function stopArena() {
    if (arenaTimer) cancelAnimationFrame(arenaTimer);
    arenaTimer = null;
    $("ar-play").textContent = "Play";
  }
  function playArena() {
    if (!arena) return;
    if (arenaTimer) { stopArena(); return; }
    if (arena.day >= arena.labels.length - 1) arena.day = 0;
    $("ar-play").textContent = "Pause";
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const tick = () => {
      arena.day = Math.min(arena.labels.length - 1, arena.day + (+$("ar-speed").value) * (reduce ? 5 : 1));
      updateArena();
      if (arena.day >= arena.labels.length - 1) { stopArena(); return; }
      arenaTimer = requestAnimationFrame(tick);
    };
    arenaTimer = requestAnimationFrame(tick);
  }

  // ---------- GAME ----------
  let G = null;
  const LOOK = 90, GCOST = 5;
  function newGame() {
    const mkt = $("gm-mkt").value, len = +$("gm-len").value;
    let a, b;
    if ($("gm-pair").value === "__random") {
      const ps = pairsOf(mkt);
      ({ a, b } = ps[Math.floor(Math.random() * ps.length)]);
    } else [a, b] = $("gm-pair").value.split("|");
    const P = pair(mkt, a, b), n = P.pa.length;
    if (n < LOOK + len + 300) { $("gm-result").innerHTML = '<p class="muted">Not enough history for this pair. Pick another.</p>'; return; }
    const start = 300 + Math.floor(Math.random() * (n - len - 301));
    const z = Strat.rollingZ(P.pa, P.pb, 60).z;
    const bot = Strat.simulate(P.pa, P.pb, "zscore", {}, start, start + len, GCOST);
    const hold = Strat.simulate(P.pa, P.pb, "hold", {}, start, start + len, 0);
    G = { mkt, P, start, end: start + len, t: start, cash: 1e5, sa: 0, sb: 0, pos: 0, eq: [1e5], z, bot, hold, trades: 0, done: false, blind: $("gm-blind").checked };
    $("gm-result").innerHTML = "";
    renderGame();
  }
  const gEquity = () => G.cash + G.sa * G.P.pa[G.t] + G.sb * G.P.pb[G.t];
  function gSet(target) {
    if (!G || G.done || target === G.pos) return;
    const E = gEquity(), pa = G.P.pa[G.t], pb = G.P.pb[G.t];
    const na = target ? (0.5 * target * E) / pa : 0, nb = target ? (-0.5 * target * E) / pb : 0;
    const fee = (GCOST / 1e4) * (Math.abs(na - G.sa) * pa + Math.abs(nb - G.sb) * pb);
    G.cash = E - na * pa - nb * pb - fee;
    G.sa = na; G.sb = nb; G.pos = target; G.trades++;
    G.eq[G.eq.length - 1] = gEquity();
    renderGame();
  }
  function gStep(k) {
    if (!G || G.done) return;
    for (let i = 0; i < k && G.t < G.end; i++) { G.t++; G.eq.push(gEquity()); }
    if (G.t >= G.end) finishGame();
    renderGame();
  }
  function finishGame() {
    gSet(0);
    G.done = true;
    const me = G.eq.at(-1) / 1e5 - 1, bot = G.bot.metrics.total, hold = G.hold.metrics.total;
    const P = G.P, c = cur(G.mkt);
    const verdict = me > bot ? "You beat the bot." : me === bot ? "Dead heat with the bot." : "The bot wins this one.";
    $("gm-result").innerHTML = `<div class="reveal"><h3>${verdict}</h3>
      <p>The pair was <b>${tk(P.a)}</b> (${esc(DATA.meta[P.a].name)}) vs <b>${tk(P.b)}</b> (${esc(DATA.meta[P.b].name)}), ${P.dates[G.start]} to ${P.dates[G.end]}.</p>
      <div class="stats" style="margin-top:12px">
        <div class="stat"><div class="k">You</div><div class="v ${cls(me)}">${pct(me)}</div><div class="s">${money(G.eq.at(-1), c)} · ${G.trades} trades</div></div>
        <div class="stat"><div class="k">Z-score bot</div><div class="v ${cls(bot)}">${pct(bot)}</div><div class="s">${G.bot.trades.length} round trips</div></div>
        <div class="stat"><div class="k">Hold both</div><div class="v ${cls(hold)}">${pct(hold)}</div><div class="s">no skill needed</div></div>
      </div></div>`;
    const scores = store.get("tsl-scores", []);
    scores.push({ when: new Date().toISOString().slice(0, 10), pair: `${tk(P.a)}/${tk(P.b)}`, period: `${P.dates[G.start].slice(0, 7)}`, days: G.end - G.start, me, bot });
    scores.sort((x, y) => y.me - y.bot - (x.me - x.bot));
    store.set("tsl-scores", scores.slice(0, 25));
    renderScores();
  }
  function renderScores() {
    const s = store.get("tsl-scores", []);
    $("gm-scores").innerHTML = `<thead><tr><th>#</th><th>Played</th><th>Pair</th><th>Period</th><th class="num">Days</th><th class="num">You</th><th class="num">Bot</th><th class="num">Edge</th></tr></thead><tbody>` +
      (s.length ? s.map((r, i) => `<tr><td class="num">${i + 1}</td><td class="mono small">${r.when}</td><td>${esc(r.pair)}</td><td class="mono small">${r.period}</td><td class="num">${r.days}</td>
        <td class="num ${cls(r.me)}">${pct(r.me)}</td><td class="num ${cls(r.bot)}">${pct(r.bot)}</td><td class="num ${cls(r.me - r.bot)}"><b>${pct(r.me - r.bot)}</b></td></tr>`).join("")
        : '<tr><td colspan="8" class="muted">Finish a game to put a score on this board.</td></tr>') + "</tbody>";
  }
  function renderGame() {
    if (!G) return;
    const P = G.P, t = G.t, s = t - LOOK, c = cur(G.mkt);
    const nameA = G.blind && !G.done ? "Stock A" : tk(P.a), nameB = G.blind && !G.done ? "Stock B" : tk(P.b);
    const day = t - G.start, E = gEquity(), botE = G.bot.eq[day], zNow = G.z[t];
    const posTxt = G.pos === 1 ? `Long ${nameA} / short ${nameB}` : G.pos === -1 ? `Short ${nameA} / long ${nameB}` : "Flat";
    $("gm-hud").innerHTML = [
      ["Day", `${day} / ${G.end - G.start}`],
      ["Your equity", `<span class="${cls(E - 1e5)}">${money(E, c)}</span>`],
      ["Bot equity", `<span class="${cls(botE - 1e5)}">${money(botE, c)}</span>`],
      ["Position", `<span class="${G.pos ? (G.pos > 0 ? "pos" : "neg") : "muted"}" style="font-size:15px">${posTxt}</span>`],
      ["Z-score", $("gm-hint").checked ? `<span class="${Math.abs(zNow) >= 2 ? (zNow > 0 ? "neg" : "pos") : ""}">${zNow >= 0 ? "+" : ""}${f2(zNow)}</span>` : "hidden"],
    ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v" style="font-size:20px">${v}</div></div>`).join("");
    ["gm-long", "gm-short", "gm-flat", "gm-next", "gm-next5", "gm-finish"].forEach((id) => ($(id).disabled = G.done));
    $("gm-long").disabled = G.done || G.pos === 1;
    $("gm-short").disabled = G.done || G.pos === -1;
    $("gm-flat").disabled = G.done || G.pos === 0;
    const labels = [];
    for (let i = s; i <= t; i++) labels.push(G.blind && !G.done ? `d${i - G.start}` : P.dates[i]);
    const ca = css("--leg-a"), cb = css("--leg-b");
    lineChart("gm-price", labels, [
      { label: nameA, data: P.pa.slice(s, t + 1).map((v) => (100 * v) / P.pa[s]), borderColor: ca, borderWidth: 2 },
      { label: nameB, data: P.pb.slice(s, t + 1).map((v) => (100 * v) / P.pb[s]), borderColor: cb, borderWidth: 2 },
    ], { fmt: (v) => v.toFixed(1) });
    legend("gm-legend", [{ label: `${nameA} (rebased)`, color: ca }, { label: `${nameB} (rebased)`, color: cb }, { label: "Buy spread = long A, short B", color: "transparent" }]);
    const m = css("--muted");
    if ($("gm-hint").checked) {
      $("gm-z").parentElement.hidden = false;
      lineChart("gm-z", labels, [
        { label: "z", data: Array.from(G.z.slice(s, t + 1)), borderColor: css("--accent") },
        band(labels.length, 2, m), band(labels.length, -2, m), band(labels.length, 0, css("--line")),
      ], { y: { suggestedMin: -3, suggestedMax: 3 } });
    } else $("gm-z").parentElement.hidden = true;
  }

  // ---------- routing ----------
  const TABS = ["story", "scan", "lab", "arena", "game", "research"];
  const rendered = {};
  function show(tab) {
    if (!TABS.includes(tab)) tab = "story";
    TABS.forEach((t) => { $("tab-" + t).hidden = t !== tab; });
    document.querySelectorAll("nav.tabs a").forEach((a) => a.setAttribute("aria-current", a.getAttribute("href") === "#" + tab ? "page" : "false"));
    if (tab !== "arena") stopArena();
    if (!rendered[tab] || tab === "story") {
      rendered[tab] = true;
      ({ story: renderStory, scan: renderScan, lab: () => { runLab(); runPortfolio(); }, arena: setupArena, game: () => { newGame(); renderScores(); } }[tab] || (() => {}))();
    }
    try { localStorage.setItem("tsl-tab", tab); } catch (e) { /* ignore */ }
  }
  function rerenderAll() {
    for (const t of Object.keys(rendered)) rendered[t] = false;
    show(currentTab());
  }
  const currentTab = () => {
    let saved = null;
    try { saved = localStorage.getItem("tsl-tab"); } catch (e) { /* ignore */ }
    return (location.hash || "").slice(1) || saved || "story";
  };

  // ---------- wiring ----------
  function wire() {
    ["st-k", "st-cost", "st-from"].forEach((id) => $(id).addEventListener("change", renderStory));
    ["sc-mkt", "sc-win", "sc-L", "sc-only"].forEach((id) => $(id).addEventListener("change", () => { scanSel = null; renderScan(); }));
    $("sc-table").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-k]");
      if (th) { const k = th.dataset.k; scanSort = { key: k, dir: scanSort.key === k ? -scanSort.dir : k === "absz" || k === "corr" || k === "sig" ? -1 : 1 }; renderScan(); return; }
      const tr = e.target.closest("tr[data-id]");
      if (tr) { scanSel = tr.dataset.id; $("sc-table").querySelectorAll("tr[data-id]").forEach((x) => x.classList.toggle("sel", x === tr)); renderScanDetail($("sc-mkt").value, +$("sc-win").value, +$("sc-L").value); }
    });
    $("lb-mkt").addEventListener("change", () => { fillPairSelect($("lb-pair"), $("lb-mkt").value); runLab(); });
    $("lb-split").addEventListener("input", () => { $("lb-split-v").textContent = $("lb-split").value + "%"; });
    $("lb-run").addEventListener("click", runLab);
    ["lb-pair", "lb-from", "lb-cost", "lb-split"].forEach((id) => $(id).addEventListener("change", runLab));
    $("lb-table").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-k]"); if (tr) { labSel = tr.dataset.k; renderLab(); } });
    $("pf-run").addEventListener("click", runPortfolio);
    ["pf-mkt", "pf-train", "pf-split", "pf-n"].forEach((id) => $(id).addEventListener("change", runPortfolio));
    $("ar-mkt").addEventListener("change", () => { fillArenaSelect(); setupArena(); });
    ["ar-pair", "ar-len", "ar-cost"].forEach((id) => $(id).addEventListener("change", setupArena));
    $("ar-play").addEventListener("click", playArena);
    $("ar-end").addEventListener("click", () => { if (!arena) return; stopArena(); arena.day = arena.labels.length - 1; updateArena(); });
    $("gm-mkt").addEventListener("change", fillGameSelect);
    $("gm-start").addEventListener("click", newGame);
    $("gm-hint").addEventListener("change", renderGame);
    $("gm-long").addEventListener("click", () => gSet(1));
    $("gm-short").addEventListener("click", () => gSet(-1));
    $("gm-flat").addEventListener("click", () => gSet(0));
    $("gm-next").addEventListener("click", () => gStep(1));
    $("gm-next5").addEventListener("click", () => gStep(5));
    $("gm-finish").addEventListener("click", () => gStep(1e6));
    document.addEventListener("keydown", (e) => {
      if ($("tab-game").hidden || !G || G.done || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k === "b") gSet(1);
      else if (k === "s") gSet(-1);
      else if (k === "f") gSet(0);
      else if (k === "arrowright" || k === " ") { e.preventDefault(); gStep(1); }
    });
    window.addEventListener("hashchange", () => show(currentTab()));
    try {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rerenderAll);
      new MutationObserver(rerenderAll).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    } catch (e) { /* older browsers */ }
  }
  function fillArenaSelect() {
    fillPairSelect($("ar-pair"), $("ar-mkt").value, '<optgroup label="Portfolios"><option value="__top5">Top 5 cointegrated pairs</option><option value="__top10">Top 10 cointegrated pairs</option></optgroup>');
    $("ar-pair").value = $("ar-mkt").value === "US" ? "KO|PEP" : "HDFCBANK.NS|ICICIBANK.NS";
  }
  function fillGameSelect() {
    fillPairSelect($("gm-pair"), $("gm-mkt").value, '<option value="__random">Random pair</option>');
  }

  async function boot() {
    try {
      const [m, c] = await Promise.all([fetch("data/market.json").then((r) => r.json()), fetch("data/classic.json").then((r) => r.json())]);
      DATA = m; CLASSIC = c;
    } catch (e) {
      $("loading").textContent = "Could not load data/market.json. Serve the docs/ folder over HTTP (python -m http.server) instead of opening the file directly.";
      return;
    }
    $("loading").hidden = true;
    const usLast = DATA.markets.US.dates.at(-1), inLast = DATA.markets.IN.dates.at(-1);
    $("stamp").textContent = `US prices to ${usLast} · NSE to ${inLast} · ${Object.keys(DATA.meta).length} stocks`;
    $("foot").textContent = `Data: ${DATA.source}, downloaded ${DATA.generated}. Educational project, not investment advice.`;
    const fy = [1972, 1980, 1990, 2000, 2010, 2020].filter((y) => y <= +CLASSIC.dates.at(-1).slice(0, 4));
    $("st-from").innerHTML = fy.map((y) => `<option value="${y}">${y}</option>`).join("");
    fillPairSelect($("lb-pair"), "US");
    $("lb-pair").value = "KO|PEP";
    const lastY = +usLast.slice(0, 4);
    const pfYears = [];
    for (let y = 2014; y <= lastY; y++) pfYears.push(y);
    $("pf-split").innerHTML = pfYears.map((y) => `<option ${y === 2016 ? "selected" : ""}>${y}</option>`).join("");
    fillArenaSelect();
    fillGameSelect();
    wire();
    show(currentTab());
  }
  boot();
})();

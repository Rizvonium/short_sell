# Strategy research harness

`node research/run.js <file|baseline:id|baselines> [--split dev|holdout] [--market US|IN|both] [--cost 5] [--borrow 50] [--params JSON] [--json]`

## Protocol
- **dev split** (default): prices are truncated at 2020-12-31 *in memory*; strategies trade every calendar year 2013–2020.
- **holdout split**: 2021 → latest. Reserved for the final verdict; do not tune on it.
- Costs: 5 bps per side on traded weight, 50 bps/yr borrow on shorts, gross exposure capped at 1× equity, fills at the decision-day close.
- Score = mean of US and India annualized Sharpe ratios.

## Context API (`ctx`), the only way a strategy sees data
- `ctx.syms` all tickers, `ctx.groups` {sector: [tickers]}, `ctx.dates` calendar, `ctx.now` today's index, `ctx.meta[sym]` name/sector.
- `ctx.px(sym, i)` price on day i (throws if i > now; null if missing). `ctx.window(sym, from, to)` slice, to ≤ now. `ctx.hist(sym, n)` last n prices.
- `ctx.current()` current drifted weights, `ctx.equity()` equity so far (starts at 1), `ctx.idx(isoDate)`.
- `ctx.Stats` (ols, adf, cointegration, halfLife, corr, std, mean, metrics…) and `ctx.Strat` (STRATEGIES, rollingZ, simulate, gridList) helpers.
- Never read data files or globals directly; the guard only protects what goes through `ctx`.

Prices are dividend/split-adjusted closes, forward-filled up to 3 days; nulls mean no trading data. The universe (97 US+NSE large caps grouped by sector) is today's list, so results carry survivorship bias.

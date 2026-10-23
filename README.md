# short_sell — Twin Shares Lab

Statistical arbitrage on "twin" stocks (Coke vs Pepsi, HDFC Bank vs ICICI Bank, TCS vs Infosys and so on), run on real daily prices from the US and Indian (NSE) markets.

The site in `docs/` is static: no build step and no server code.

| Tab | What it does |
|---|---|
| **Coke vs Pepsi** | The headline rule since 1972: long the twin that fell behind, short the one that ran ahead, next to its mirror image. You can change the look-back and the trading cost. |
| **Scanner** | Tests every same-sector pair (92 US, 83 NSE) for cointegration (Engle-Granger/ADF). Lists half-life, hedge ratio and today's z-score. Pairs that are cointegrated and beyond ±2σ come with a sized trade idea. |
| **Train / Test Lab** | Grid-searches each strategy's parameters on a training window, freezes them and reports out-of-sample results plus the overfit gap. Also runs a walk-forward portfolio test: each year it picks the top-N and bottom-N pairs by cointegration in training and trades them the next year. |
| **Tournament** | 8 new strategies (designed by parallel research agents) vs 8 baselines, walk-forward on both markets. Strategies were built on 2013–2020 only, a champion was pre-registered (`research/preregistration.json`), then everyone ran on the 2021→today holdout. |
| **Strategy Arena** | Seven strategies race on the same tape (one pair, or a top-5/10 portfolio). Each is tuned on the 3 years before the race. Includes an animated leaderboard. |
| **Trading Game** | You trade a random, optionally blind, stretch of real history day by day against a z-score bot. Scores are kept in your browser. |
| **Research** | Literature (Gatev et al. 2006, Do & Faff 2010, Jacobs & Weber 2015, Chen et al. 2019, Krauss 2017), why the trade works and fails, and US vs India shorting mechanics. |

Strategies: Z-score reversion (rolling OLS hedge), Kalman-filter hedge, ratio Bollinger, Gatev distance method, buy-the-laggard, buy-the-leader (mirror) and a hold-both benchmark. All signals use data up to day *t* only and fill at that day's close. Costs are charged per side.

## Run locally

```bash
python scripts/fetch_data.py          # refresh docs/data/*.json from Yahoo Finance
cd docs && python -m http.server 8000 # open http://localhost:8000
```

The page loads JSON with `fetch`, so it must be served over HTTP. Opening `index.html` from disk won't work.

## Strategy research

`research/run.js` is the tournament harness (see `research/README.md`): a walk-forward engine (`docs/js/portfolio.js`) whose data context throws on any look-ahead, 5 bps costs, 50 bps/yr borrow, ≤1× gross. Candidates live in `research/candidates/`, each audited for look-ahead and stress-tested before the holdout was run.

Holdout result (2021-01 → 2026-10): the pre-registered champion (OU half-life pairs, dev score 1.27) scored 0.22. It held up in India (Sharpe 1.14) and lost money in the US (−0.69). The best market-neutral strategy out of sample was the plain Gatev distance rule (0.62). New strategies lost 0.98 Sharpe on average from dev to holdout, against 0.29 for the simple baselines.

## Keeping data fresh

`.github/workflows/update-data.yml` re-downloads prices and rebuilds `docs/data/tournament.json` every weekday after the US close, then commits the result. To host the site, enable GitHub Pages with source `main` / `docs`.

Edit `UNIVERSE` in `scripts/fetch_data.py` to add sectors or tickers. Use the `.NS` suffix for NSE.

*Educational project. Backtests ignore borrow fees and market impact. Nothing here is investment advice.*

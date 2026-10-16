#!/usr/bin/env python3
"""Download real daily prices for the US + Indian twin-stock universe.

Source: Yahoo Finance chart API (split/dividend adjusted closes).
Outputs (consumed by the static site in docs/):
  docs/data/market.json   - ~15y of adjusted closes, one calendar per market
  docs/data/classic.json  - KO vs PEP full history (since 1972) for the headline study

Usage:  python scripts/fetch_data.py [--start 2010-01-01]
"""
import argparse
import datetime as dt
import json
import math
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "data"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"

# Sector groups. Every pair inside a group is scanned; the first pairs listed are the "classic twins".
UNIVERSE = {
    "US": {
        "Beverages & Staples": ["KO", "PEP", "KDP", "PG", "CL", "KMB"],
        "Big-box Retail": ["WMT", "TGT", "COST", "HD", "LOW"],
        "Payments": ["V", "MA", "AXP"],
        "Oil Majors": ["XOM", "CVX", "COP", "BP", "SHEL"],
        "Money-center Banks": ["JPM", "BAC", "C", "WFC", "GS", "MS"],
        "Parcel & Rail": ["UPS", "FDX", "UNP", "CSX"],
        "Fast Food": ["MCD", "YUM", "SBUX"],
        "Pharma": ["MRK", "PFE", "JNJ", "ABBV", "BMY"],
        "Telecom": ["T", "VZ", "TMUS"],
        "Machinery": ["CAT", "DE"],
        "Semis": ["AMD", "NVDA", "INTC", "TXN", "QCOM"],
        "Country ETFs": ["EWA", "EWC", "SPY", "QQQ"],
    },
    "IN": {
        "Private Banks": ["HDFCBANK.NS", "ICICIBANK.NS", "AXISBANK.NS", "KOTAKBANK.NS", "INDUSINDBK.NS"],
        "PSU Banks": ["SBIN.NS", "BANKBARODA.NS", "PNB.NS", "CANBK.NS"],
        "IT Services": ["TCS.NS", "INFY.NS", "WIPRO.NS", "HCLTECH.NS", "TECHM.NS"],
        "Autos": ["MARUTI.NS", "M&M.NS", "BAJAJ-AUTO.NS", "HEROMOTOCO.NS", "EICHERMOT.NS", "TVSMOTOR.NS"],
        "Steel & Metals": ["TATASTEEL.NS", "JSWSTEEL.NS", "SAIL.NS", "HINDALCO.NS", "JINDALSTEL.NS"],
        "Cement": ["ULTRACEMCO.NS", "AMBUJACEM.NS", "ACC.NS", "SHREECEM.NS"],
        "Oil Marketing": ["BPCL.NS", "HINDPETRO.NS", "IOC.NS", "ONGC.NS"],
        "FMCG": ["HINDUNILVR.NS", "ITC.NS", "NESTLEIND.NS", "BRITANNIA.NS", "DABUR.NS"],
        "Pharma": ["SUNPHARMA.NS", "DRREDDY.NS", "CIPLA.NS", "LUPIN.NS"],
        "Power": ["NTPC.NS", "POWERGRID.NS", "TATAPOWER.NS"],
        "Paints": ["ASIANPAINT.NS", "BERGEPAINT.NS"],
    },
}


def fetch(symbol, start, session, retries=6):
    p1 = int(dt.datetime.fromisoformat(start).replace(tzinfo=dt.timezone.utc).timestamp())
    p2 = int(time.time()) + 86400
    url = f"https://query2.finance.yahoo.com/v8/finance/chart/{requests.utils.quote(symbol)}"
    params = {"period1": p1, "period2": p2, "interval": "1d", "events": "div,split", "includeAdjustedClose": "true"}
    for attempt in range(retries):
        r = session.get(url, params=params, timeout=30)
        if r.status_code == 429:
            time.sleep(3 * 2 ** attempt)
            continue
        r.raise_for_status()
        res = r.json()["chart"]["result"][0]
        ts = res.get("timestamp") or []
        offset = res["meta"].get("gmtoffset", 0)
        adj = res["indicators"].get("adjclose", [{}])[0].get("adjclose") or res["indicators"]["quote"][0]["close"]
        name = res["meta"].get("longName") or res["meta"].get("shortName") or symbol
        out = {}
        for t, v in zip(ts, adj):
            if v is None or not math.isfinite(v) or v <= 0:
                continue
            out[dt.datetime.fromtimestamp(t + offset, dt.timezone.utc).strftime("%Y-%m-%d")] = v
        return name, res["meta"].get("currency", ""), out
    raise RuntimeError(f"rate limited on {symbol}")


def round_sig(v):
    return float(f"{v:.6g}")


def build_market(series):
    """Align tickers on a shared calendar; forward-fill gaps of <=3 days, else null."""
    dates = sorted(set().union(*[s.keys() for s in series.values()]))
    # keep dates where at least half the tickers traded (drops odd holiday prints)
    need = max(1, len(series) // 2)
    dates = [d for d in dates if sum(d in s for s in series.values()) >= need]
    closes = {}
    for sym, s in series.items():
        arr, last, gap = [], None, 0
        for d in dates:
            if d in s:
                last, gap = s[d], 0
                arr.append(round_sig(last))
            elif last is not None and gap < 3:
                gap += 1
                arr.append(round_sig(last))
            else:
                arr.append(None)
        closes[sym] = arr
    return dates, closes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2010-01-01")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    s = requests.Session()
    s.headers["User-Agent"] = UA

    meta, markets, failed = {}, {}, []
    for mkt, groups in UNIVERSE.items():
        series = {}
        for group, syms in groups.items():
            for sym in syms:
                if sym in series:
                    continue
                try:
                    name, ccy, data = fetch(sym, args.start, s)
                    if len(data) < 500:
                        raise RuntimeError(f"only {len(data)} rows")
                    series[sym] = data
                    meta[sym] = {"name": name, "ccy": ccy, "group": group, "market": mkt}
                    print(f"  {mkt} {sym:<16} {len(data):>5} rows  {name}", file=sys.stderr)
                except Exception as e:  # keep going; a delisted ticker shouldn't kill the refresh
                    failed.append(sym)
                    print(f"  !! {sym}: {e}", file=sys.stderr)
                time.sleep(0.35)
        dates, closes = build_market(series)
        groups_ok = {g: [x for x in syms if x in series] for g, syms in groups.items()}
        markets[mkt] = {"dates": dates, "closes": closes, "groups": groups_ok}

    payload = {
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "source": "Yahoo Finance (adjusted close)",
        "meta": meta,
        "markets": markets,
        "failed": failed,
    }
    (OUT / "market.json").write_text(json.dumps(payload, separators=(",", ":")))

    # Headline study: Coke vs Pepsi over their full shared history.
    _, _, ko = fetch("KO", "1962-01-01", s)
    _, _, pep = fetch("PEP", "1962-01-01", s)
    common = sorted(set(ko) & set(pep))
    classic = {
        "generated": payload["generated"],
        "a": "PEP", "b": "KO",
        "dates": common,
        "pa": [round_sig(pep[d]) for d in common],
        "pb": [round_sig(ko[d]) for d in common],
    }
    (OUT / "classic.json").write_text(json.dumps(classic, separators=(",", ":")))
    print(f"done: {len(meta)} tickers, failed={failed}, classic rows={len(common)} from {common[0]}", file=sys.stderr)


if __name__ == "__main__":
    main()

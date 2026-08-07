#!/usr/bin/env python3
"""Build a defensive, keyless S&P 500 technical market scan.

The broad scan is intentionally separate from Capitol Pulse's deeper
politician-first fundamental analysis. It looks for technical candidates; it
does not predict returns and does not place orders.
"""

from __future__ import annotations

import csv
import io
import json
import math
import os
import re
import statistics
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = ROOT / "public" / "data" / "sp500.json"
UNIVERSE_URL = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv"
PRICE_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
APP_URL = "https://joepxnlx.github.io/capitol-pulse-joep/"
USER_AGENT = "CapitolPulse/3.0 (https://github.com/Joepxnlx/capitol-pulse-joep)"
MIN_UNIVERSE = 450
MAX_UNIVERSE = 550
MIN_RESULTS = 425
REQUEST_TIMEOUT = (10, 35)


class ScanUnavailable(RuntimeError):
    """Raised when a safe non-empty market scan cannot be produced."""


def github_annotation(level: str, message: str) -> None:
    print(f"::{level}::{message}")


def finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def rounded(value: float | None, digits: int = 2) -> float | None:
    return round(value, digits) if value is not None and math.isfinite(value) else None


def load_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def env_truthy(name: str) -> bool:
    return os.getenv(name, "").strip().casefold() in {"1", "true", "yes", "on"}


def request_response(url: str, params: dict[str, Any] | None = None) -> requests.Response:
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            response = requests.get(
                url,
                params=params,
                headers={"User-Agent": USER_AGENT, "Accept": "application/json,text/csv,*/*"},
                timeout=REQUEST_TIMEOUT,
            )
            response.raise_for_status()
            return response
        except requests.RequestException as error:
            last_error = error
            if attempt < 2:
                time.sleep(1.2 * (attempt + 1))
    raise ScanUnavailable(f"databron niet bereikbaar: {last_error}")


def fetch_universe() -> list[dict[str, str]]:
    response = request_response(UNIVERSE_URL)
    rows: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in csv.DictReader(io.StringIO(response.text)):
        symbol = str(item.get("Symbol") or "").strip().upper()
        company = str(item.get("Security") or item.get("Name") or "").strip()
        sector = str(item.get("GICS Sector") or item.get("Sector") or "Onbekend").strip() or "Onbekend"
        if not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,7}", symbol) or symbol in seen or not company:
            continue
        seen.add(symbol)
        rows.append({
            "symbol": symbol,
            "yahooSymbol": symbol.replace(".", "-"),
            "company": company,
            "sector": sector,
        })
    if not MIN_UNIVERSE <= len(rows) <= MAX_UNIVERSE:
        raise ScanUnavailable(f"onverwacht aantal indexnoteringen: {len(rows)}")
    return rows


def request_json(url: str, params: dict[str, Any]) -> dict[str, Any]:
    response = request_response(url, params)
    try:
        payload = response.json()
    except ValueError as error:
        raise ScanUnavailable(f"ongeldig JSON-antwoord: {error}") from error
    if not isinstance(payload, dict):
        raise ScanUnavailable("koersantwoord is geen JSON-object")
    return payload


def fetch_chart(symbol: str) -> dict[str, Any]:
    payload = request_json(
        PRICE_URL.format(symbol=quote(symbol, safe="-^")),
        {"range": "1y", "interval": "1d", "events": "div,splits"},
    )
    result = ((payload.get("chart") or {}).get("result") or [None])[0]
    if not isinstance(result, dict):
        error = (payload.get("chart") or {}).get("error") or {}
        raise ScanUnavailable(str(error.get("description") or f"geen koershistorie voor {symbol}"))
    timestamps = result.get("timestamp") or []
    indicators = result.get("indicators") or {}
    quote_data = (indicators.get("quote") or [{}])[0]
    adjusted_data = (indicators.get("adjclose") or [{}])[0]
    adjusted = adjusted_data.get("adjclose") or quote_data.get("close") or []
    rows: list[dict[str, float]] = []
    for index, timestamp in enumerate(timestamps):
        try:
            close = finite(adjusted[index])
            high = finite((quote_data.get("high") or [])[index])
            low = finite((quote_data.get("low") or [])[index])
            volume = finite((quote_data.get("volume") or [])[index])
        except IndexError:
            continue
        if None in (close, high, low):
            continue
        rows.append({
            "timestamp": float(timestamp),
            "close": float(close),
            "high": float(high),
            "low": float(low),
            "volume": float(volume or 0),
        })
    if len(rows) < 200:
        raise ScanUnavailable(f"slechts {len(rows)} bruikbare koersdagen")
    return {"meta": result.get("meta") or {}, "rows": rows}


def moving_average(values: list[float], period: int) -> float | None:
    return sum(values[-period:]) / period if len(values) >= period else None


def percent_change(current: float | None, previous: float | None) -> float | None:
    if current is None or previous in (None, 0):
        return None
    return (current / previous - 1) * 100


def rsi(values: list[float], period: int = 14) -> float | None:
    if len(values) <= period:
        return None
    changes = [right - left for left, right in zip(values[-period - 1 : -1], values[-period:])]
    gains = sum(max(change, 0) for change in changes) / period
    losses = sum(max(-change, 0) for change in changes) / period
    if losses == 0:
        return 100.0
    relative_strength = gains / losses
    return 100 - (100 / (1 + relative_strength))


def annualized_volatility(values: list[float], period: int = 60) -> float | None:
    sample = values[-(period + 1) :]
    returns = [(right / left) - 1 for left, right in zip(sample[:-1], sample[1:]) if left > 0]
    return statistics.stdev(returns) * math.sqrt(252) * 100 if len(returns) >= 20 else None


def atr(rows: list[dict[str, float]], period: int = 14) -> float | None:
    if len(rows) <= period:
        return None
    ranges = [
        max(
            current["high"] - current["low"],
            abs(current["high"] - previous["close"]),
            abs(current["low"] - previous["close"]),
        )
        for previous, current in zip(rows[-period - 1 : -1], rows[-period:])
    ]
    return sum(ranges) / len(ranges)


def check(key: str, label: str, passed: bool, detail: str, threshold: str) -> dict[str, Any]:
    return {"key": key, "label": label, "passed": bool(passed), "detail": detail, "threshold": threshold}


def analyze_company(company: dict[str, str], benchmark_return: float) -> dict[str, Any]:
    chart = fetch_chart(company["yahooSymbol"])
    rows = chart["rows"]
    meta = chart["meta"]
    closes = [row["close"] for row in rows]
    current = finite(meta.get("regularMarketPrice")) or closes[-1]
    sma50 = moving_average(closes, 50)
    sma200 = moving_average(closes, 200)
    rsi14 = rsi(closes)
    volatility = annualized_volatility(closes)
    atr14 = atr(rows)
    one_year_return = percent_change(current, closes[0])
    high_52 = max(row["high"] for row in rows)
    low_52 = min(row["low"] for row in rows)
    drawdown = percent_change(current, high_52)
    avg_volume20 = sum(row["volume"] for row in rows[-20:]) / min(20, len(rows))
    avg_dollar_volume = avg_volume20 * current
    relative_strength = (one_year_return - benchmark_return) if one_year_return is not None else None
    latest_date = datetime.fromtimestamp(rows[-1]["timestamp"], timezone.utc).date().isoformat()

    checks = [
        check("longTrend", "Lange trend", bool(sma200 and current > sma200), f"Koers ${current:.2f}; SMA200 ${sma200:.2f}.", "Koers boven het 200-daags gemiddelde"),
        check("momentum", "Middellange trend", bool(sma50 and sma200 and sma50 > sma200), f"SMA50 ${sma50:.2f}; SMA200 ${sma200:.2f}.", "SMA50 boven SMA200"),
        check("rsi", "Niet oververhit", bool(rsi14 is not None and 42 <= rsi14 <= 68), f"RSI(14) {rsi14:.1f}.", "RSI tussen 42 en 68"),
        check("relative", "Sterker dan S&P 500", bool(relative_strength is not None and relative_strength > 0), f"Relatieve 1-jaarssterkte {relative_strength:+.1f} procentpunt.", "1-jaarsrendement hoger dan SPY"),
        check("risk", "Beheerst risico", bool(volatility is not None and drawdown is not None and volatility <= 50 and drawdown >= -20), f"Volatiliteit {volatility:.1f}%; onder 52-weeks top {abs(drawdown):.1f}%.", "Volatiliteit ≤ 50% en maximaal 20% onder top"),
        check("liquidity", "Liquiditeit", bool(avg_dollar_volume >= 10_000_000), f"Gemiddelde dagomzet ${avg_dollar_volume / 1_000_000:.1f} mln.", "Gemiddelde 20-daagse dollaromzet ≥ $10 mln"),
    ]
    score = sum(1 for item in checks if item["passed"])
    status = "CANDIDATE" if score == 6 else "WATCH" if score == 5 else "AVOID"
    signal_label = "Technische kandidaat" if status == "CANDIDATE" else "Bijna bevestigd" if status == "WATCH" else "Geen technische koop"
    current_atr = atr14 or current * 0.04
    stop_distance = max(2 * current_atr, current * 0.08)
    stop_loss = max(0.01, current - stop_distance)
    target = current + 2 * (current - stop_loss)
    return {
        "symbol": company["symbol"],
        "quoteSymbol": company["yahooSymbol"],
        "company": meta.get("longName") or meta.get("shortName") or company["company"],
        "sector": company["sector"],
        "currency": meta.get("currency") or "USD",
        "price": rounded(current),
        "priceDate": latest_date,
        "sma50": rounded(sma50),
        "sma200": rounded(sma200),
        "rsi14": rounded(rsi14, 1),
        "atr14": rounded(atr14),
        "annualizedVolatilityPct": rounded(volatility, 1),
        "oneYearReturnPct": rounded(one_year_return, 1),
        "benchmarkReturnPct": rounded(benchmark_return, 1),
        "relativeStrengthPctPoints": rounded(relative_strength, 1),
        "distanceFromHighPct": rounded(drawdown, 1),
        "fiftyTwoWeekHigh": rounded(high_52),
        "fiftyTwoWeekLow": rounded(low_52),
        "averageDollarVolume20": rounded(avg_dollar_volume, 0),
        "score": score,
        "status": status,
        "signalLabel": signal_label,
        "checks": checks,
        "strategy": {
            "active": status == "CANDIDATE",
            "entry": rounded(current) if status == "CANDIDATE" else None,
            "stopLoss": rounded(stop_loss) if status == "CANDIDATE" else None,
            "takeProfit": rounded(target) if status == "CANDIDATE" else None,
            "rewardRiskRatio": 2 if status == "CANDIDATE" else None,
        },
        "marketSourceUrl": f"https://finance.yahoo.com/quote/{quote(company['yahooSymbol'], safe='-')}",
    }


def atomic_write(payload: dict[str, Any]) -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix="sp500-", suffix=".json", dir=OUTPUT_PATH.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as temporary:
            json.dump(payload, temporary, ensure_ascii=False, indent=2)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, OUTPUT_PATH)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def send_ntfy(new_candidates: list[dict[str, Any]]) -> None:
    topic = os.getenv("NTFY_TOPIC", "").strip()
    if not topic or not new_candidates:
        return
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", topic):
        github_annotation("warning", "NTFY_TOPIC heeft een ongeldig formaat; S&P 500-melding overgeslagen.")
        return
    shown = new_candidates[:6]
    lines = [
        f"{stock['symbol']} · {stock['sector']} · koers ${stock['price']:.2f} · 6/6"
        for stock in shown
    ]
    if len(new_candidates) > len(shown):
        lines.append(f"… en nog {len(new_candidates) - len(shown)} nieuwe technische kandidaten")
    try:
        response = requests.post(
            f"https://ntfy.sh/{quote(topic, safe='')}",
            data="\n".join(lines).encode("utf-8"),
            headers={
                "Title": f"Capitol Pulse: {len(new_candidates)} nieuwe S&P 500-kans{'en' if len(new_candidates) != 1 else ''}",
                "Tags": "mag,chart_with_upwards_trend",
                "Click": f"{APP_URL}#markt",
            },
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        print(f"ntfy: {len(new_candidates)} nieuwe S&P 500-kandidaten gemeld.")
    except requests.RequestException as error:
        github_annotation("warning", f"Scan is bewaard, maar ntfy-melding mislukte: {error}")


def main() -> int:
    existing = load_json(OUTPUT_PATH)
    universe = fetch_universe()
    benchmark = fetch_chart("SPY")
    benchmark_closes = [row["close"] for row in benchmark["rows"]]
    benchmark_price = finite(benchmark["meta"].get("regularMarketPrice")) or benchmark_closes[-1]
    benchmark_return = percent_change(benchmark_price, benchmark_closes[0])
    if benchmark_return is None:
        raise ScanUnavailable("SPY-benchmarkrendement kon niet worden berekend")

    worker_count = max(2, min(12, int(os.getenv("SP500_WORKERS", "8"))))
    analyses: list[dict[str, Any]] = []
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = {executor.submit(analyze_company, company, benchmark_return): company for company in universe}
        for completed, future in enumerate(as_completed(futures), start=1):
            company = futures[future]
            try:
                analyses.append(future.result())
            except (ScanUnavailable, KeyError, TypeError, ValueError, statistics.StatisticsError) as error:
                errors.append(f"{company['symbol']}: {error}")
            if completed % 50 == 0:
                print(f"S&P 500-scan: {completed}/{len(universe)} verwerkt.")

    if len(analyses) < MIN_RESULTS or len(analyses) < math.ceil(len(universe) * 0.88):
        raise ScanUnavailable(f"slechts {len(analyses)} van {len(universe)} noteringen bruikbaar; bestaand bestand blijft staan")
    existing_count = len(existing.get("stocks") or [])
    if existing_count and len(analyses) < math.ceil(existing_count * 0.9):
        raise ScanUnavailable("nieuwe scan is onverwacht veel kleiner; bestaand bestand blijft staan")

    analyses.sort(key=lambda stock: (-stock["score"], -(stock.get("relativeStrengthPctPoints") or -999), stock["symbol"]))
    scan_date = max(stock["priceDate"] for stock in analyses)
    if (
        not env_truthy("FORCE_SCAN")
        and (existing.get("metadata") or {}).get("scanDate") == scan_date
        and len(existing.get("stocks") or []) == len(analyses)
    ):
        print(f"S&P 500-scan voor {scan_date} bestaat al; bestand blijft ongewijzigd.")
        return 0

    previous_candidates = {
        stock.get("symbol") for stock in existing.get("stocks") or []
        if isinstance(stock, dict) and stock.get("status") == "CANDIDATE"
    }
    current_candidates = [stock for stock in analyses if stock["status"] == "CANDIDATE"]
    new_candidates = [stock for stock in current_candidates if stock["symbol"] not in previous_candidates]
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    payload = {
        "mode": "sp500-technical-scan",
        "metadata": {
            "updatedAt": now,
            "scanDate": scan_date,
            "modelVersion": "sp500-six-signals-v1",
            "universeSource": UNIVERSE_URL,
            "marketSource": "Yahoo Finance chart endpoint",
            "benchmark": "SPY",
            "benchmarkOneYearReturnPct": rounded(benchmark_return, 1),
            "universeCount": len(universe),
            "stockCount": len(analyses),
            "candidateCount": len(current_candidates),
            "watchCount": sum(1 for stock in analyses if stock["status"] == "WATCH"),
            "errorCount": len(errors),
            "notice": "Brede technische marktscan; geen fundamentele analyse, persoonlijk advies of winstgarantie.",
        },
        "methodology": {
            "candidateRule": "Alle zes technische controles moeten slagen.",
            "watchRule": "Vijf van de zes controles slagen.",
            "signals": ["Lange trend", "Middellange trend", "RSI", "Relatieve sterkte", "Risico", "Liquiditeit"],
            "riskRule": "Voorbeeldstop op minimaal 8% of twee ATR; voorbeeldkoersdoel op twee keer het risico.",
        },
        "stocks": analyses,
        "errors": errors[:75],
    }
    atomic_write(payload)
    print(f"S&P 500-scan bijgewerkt: {len(analyses)} aandelen; {len(current_candidates)} kandidaten; {len(errors)} fouten.")
    if not existing.get("stocks"):
        print("Eerste scan is een baseline; bestaande kandidaten worden niet gemeld.")
    else:
        send_ntfy(new_candidates)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ScanUnavailable, requests.RequestException, ValueError) as error:
        github_annotation("error", f"S&P 500-scan mislukt: {error}")
        raise SystemExit(1) from error

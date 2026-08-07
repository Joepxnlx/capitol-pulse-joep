#!/usr/bin/env python3
"""Build a transparent stock-analysis snapshot for Capitol Pulse.

The model is deliberately rule based. It combines the latest public trade of a
featured politician with five independently visible stock checks. It does not
predict returns and never replaces the existing file with an empty response.
"""

from __future__ import annotations

import json
import math
import os
import re
import statistics
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote

import requests


ROOT = Path(__file__).resolve().parents[1]
TRADES_PATH = ROOT / "public" / "data" / "live.json"
OUTPUT_PATH = ROOT / "public" / "data" / "analysis.json"
PRICE_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
FUNDAMENTALS_URL = "https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/{symbol}"
USER_AGENT = "CapitolPulse/2.0 (https://github.com/Joepxnlx/capitol-pulse-joep)"
FEATURED_POLITICIANS = (
    "Nancy Pelosi",
    "Michael T. McCaul",
    "Rohit Khanna",
    "John Boozman",
    "Thomas H Tuberville",
)
MAX_STOCKS_PER_POLITICIAN = 3
MIN_REFRESH_INTERVAL = timedelta(hours=4)
TERMINAL_SIGNALS = {"TAKE_PROFIT", "STOP"}
FUNDAMENTAL_TYPES = (
    "quarterlyTotalRevenue",
    "quarterlyNetIncome",
    "quarterlyDilutedEPS",
    "quarterlyOperatingCashFlow",
    "quarterlyCapitalExpenditure",
    "quarterlyTotalDebt",
    "quarterlyStockholdersEquity",
)
NON_STOCK_WORDS = (
    " ETF",
    " FUND",
    " PORTF",
    " BOND",
    " NOTE",
    " TREASURY",
    " INDEX",
    " FIXED INC",
    " MUNICIPAL",
)


class AnalysisUnavailable(RuntimeError):
    """Raised when a usable analysis snapshot cannot be produced."""


def github_annotation(level: str, message: str) -> None:
    print(f"::{level}::{message}")


def load_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def rounded(value: float | None, digits: int = 2) -> float | None:
    return round(value, digits) if value is not None and math.isfinite(value) else None


def percent_change(current: float | None, previous: float | None) -> float | None:
    if current is None or previous in (None, 0):
        return None
    return (current - previous) / abs(previous) * 100


def is_purchase(value: Any) -> bool:
    return bool(re.search(r"purchase|buy|aankoop", str(value or ""), re.I))


def is_sale(value: Any) -> bool:
    return bool(re.search(r"sale|sell|verkoop", str(value or ""), re.I))


def is_common_stock_trade(trade: dict[str, Any]) -> bool:
    symbol = str(trade.get("symbol") or "").strip().upper()
    description = f" {str(trade.get('assetDescription') or '').upper()}"
    if not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,5}", symbol):
        return False
    if any(word in description for word in NON_STOCK_WORDS):
        return False
    return is_purchase(trade.get("type")) or is_sale(trade.get("type"))


def midpoint(trade: dict[str, Any]) -> float:
    low = finite(trade.get("amountMin")) or 0
    high = finite(trade.get("amountMax")) or low
    return (low + high) / 2


def select_featured(trades: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    ordered = sorted(
        (trade for trade in trades if isinstance(trade, dict)),
        key=lambda trade: (str(trade.get("disclosureDate") or ""), str(trade.get("transactionDate") or "")),
        reverse=True,
    )
    people: list[dict[str, Any]] = []
    selections: list[dict[str, Any]] = []
    for name in FEATURED_POLITICIANS:
        person_trades = [trade for trade in ordered if trade.get("politician") == name]
        stock_trades = [trade for trade in person_trades if is_common_stock_trade(trade)]
        chosen: list[dict[str, Any]] = []
        seen: set[str] = set()
        for trade in stock_trades:
            symbol = str(trade.get("symbol") or "").upper()
            if symbol in seen:
                continue
            chosen.append(trade)
            seen.add(symbol)
            if len(chosen) >= MAX_STOCKS_PER_POLITICIAN:
                break
        people.append(
            {
                "name": name,
                "tradeCount": len(person_trades),
                "stockTradeCount": len(stock_trades),
                "latestDisclosureDate": person_trades[0].get("disclosureDate") if person_trades else None,
                "tickers": [trade.get("symbol") for trade in chosen],
            }
        )
        selections.extend(chosen)
    return people, selections


def request_json(session: requests.Session, url: str, params: dict[str, Any]) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            response = session.get(url, params=params, timeout=(10, 35))
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError("antwoord is geen JSON-object")
            return payload
        except (requests.RequestException, ValueError) as error:
            last_error = error
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
    raise AnalysisUnavailable(f"databron niet bereikbaar: {last_error}")


def fetch_prices(session: requests.Session, symbol: str) -> dict[str, Any]:
    payload = request_json(
        session,
        PRICE_URL.format(symbol=symbol),
        {"range": "1y", "interval": "1d", "events": "div,splits"},
    )
    result = ((payload.get("chart") or {}).get("result") or [None])[0]
    if not isinstance(result, dict):
        raise AnalysisUnavailable(f"geen koershistorie voor {symbol}")
    timestamps = result.get("timestamp") or []
    quote = (((result.get("indicators") or {}).get("quote") or [{}])[0])
    rows: list[dict[str, float]] = []
    for index, timestamp in enumerate(timestamps):
        try:
            close = finite((quote.get("close") or [])[index])
            high = finite((quote.get("high") or [])[index])
            low = finite((quote.get("low") or [])[index])
        except IndexError:
            continue
        if close is None or high is None or low is None:
            continue
        rows.append({"timestamp": float(timestamp), "close": close, "high": high, "low": low})
    if len(rows) < 200:
        raise AnalysisUnavailable(f"onvoldoende koersdagen voor {symbol}")
    return {"meta": result.get("meta") or {}, "rows": rows}


def fetch_fundamentals(session: requests.Session, symbol: str) -> dict[str, list[tuple[str, float]]]:
    now = datetime.now(timezone.utc)
    payload = request_json(
        session,
        FUNDAMENTALS_URL.format(symbol=symbol),
        {
            "symbol": symbol,
            "type": ",".join(FUNDAMENTAL_TYPES),
            "period1": int((now - timedelta(days=730)).timestamp()),
            "period2": int((now + timedelta(days=7)).timestamp()),
        },
    )
    result: dict[str, list[tuple[str, float]]] = {}
    for item in (payload.get("timeseries") or {}).get("result") or []:
        if not isinstance(item, dict):
            continue
        names = (item.get("meta") or {}).get("type") or []
        name = names[0] if names else None
        if name not in FUNDAMENTAL_TYPES:
            continue
        values: dict[str, float] = {}
        for entry in item.get(name) or []:
            value = finite((entry.get("reportedValue") or {}).get("raw"))
            date = str(entry.get("asOfDate") or "")
            if value is not None and date:
                values[date] = value
        result[name] = sorted(values.items())
    return result


def series_values(series: dict[str, list[tuple[str, float]]], name: str) -> list[float]:
    return [value for _, value in series.get(name, [])]


def ttm(series: dict[str, list[tuple[str, float]]], name: str) -> float | None:
    values = series_values(series, name)
    return sum(values[-4:]) if len(values) >= 4 else None


def latest(series: dict[str, list[tuple[str, float]]], name: str) -> float | None:
    values = series_values(series, name)
    return values[-1] if values else None


def yoy_quarter(series: dict[str, list[tuple[str, float]]], name: str) -> float | None:
    values = series_values(series, name)
    return percent_change(values[-1], values[-5]) if len(values) >= 5 else None


def simple_moving_average(values: list[float], period: int) -> float | None:
    return sum(values[-period:]) / period if len(values) >= period else None


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


def atr(rows: list[dict[str, float]], period: int = 14) -> float | None:
    if len(rows) <= period:
        return None
    ranges: list[float] = []
    for previous, current in zip(rows[-period - 1 : -1], rows[-period:]):
        ranges.append(
            max(
                current["high"] - current["low"],
                abs(current["high"] - previous["close"]),
                abs(current["low"] - previous["close"]),
            )
        )
    return sum(ranges) / len(ranges)


def annualized_volatility(values: list[float], period: int = 60) -> float | None:
    sample = values[-(period + 1) :]
    if len(sample) < 21:
        return None
    returns = [(right / left) - 1 for left, right in zip(sample[:-1], sample[1:]) if left > 0]
    return statistics.stdev(returns) * math.sqrt(252) * 100 if len(returns) >= 20 else None


def factor(key: str, label: str, passed: bool, available: bool, detail: str) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "status": "good" if available and passed else "bad" if available else "unavailable",
        "passed": bool(available and passed),
        "detail": detail,
    }


def pct_text(value: float | None) -> str:
    return "niet beschikbaar" if value is None else f"{value:+.1f}%"


def number_text(value: float | None, suffix: str = "") -> str:
    return "niet beschikbaar" if value is None else f"{value:.1f}{suffix}"


def env_truthy(name: str) -> bool:
    return os.getenv(name, "").strip().casefold() in {"1", "true", "yes", "on"}


def split_filter(value: str) -> set[str]:
    return {item.strip().casefold() for item in re.split(r"[,;\n]", value) if item.strip()}


def default_app_url() -> str:
    repository = os.getenv("GITHUB_REPOSITORY", "")
    if "/" not in repository:
        return ""
    owner, name = repository.split("/", 1)
    return f"https://{owner.casefold()}.github.io/{name}/"


def currency_text(value: Any, currency: str) -> str:
    number = finite(value)
    if number is None:
        return "onbekend"
    prefix = "US$" if currency == "USD" else f"{currency} "
    return f"{prefix}{number:,.2f}"


def matches_watch_filter(stock: dict[str, Any]) -> bool:
    ticker_filters = split_filter(os.getenv("WATCH_TICKERS", ""))
    politician_filters = split_filter(os.getenv("WATCH_POLITICIANS", ""))
    if not ticker_filters and not politician_filters:
        return True
    ticker_match = str(stock.get("symbol") or "").casefold() in ticker_filters
    politician = str(stock.get("politician") or "").casefold()
    politician_match = any(watched in politician for watched in politician_filters)
    return ticker_match or politician_match


def build_analysis(trade: dict[str, Any], prices: dict[str, Any], fundamentals: dict[str, list[tuple[str, float]]]) -> dict[str, Any]:
    symbol = str(trade.get("symbol") or "").upper()
    rows = prices["rows"]
    closes = [row["close"] for row in rows]
    meta = prices["meta"]
    current_price = finite(meta.get("regularMarketPrice")) or closes[-1]
    sma50 = simple_moving_average(closes, 50)
    sma200 = simple_moving_average(closes, 200)
    rsi14 = rsi(closes)
    atr14 = atr(rows)
    volatility = annualized_volatility(closes)

    revenue_ttm = ttm(fundamentals, "quarterlyTotalRevenue")
    net_income_ttm = ttm(fundamentals, "quarterlyNetIncome")
    eps_ttm = ttm(fundamentals, "quarterlyDilutedEPS")
    operating_cash_ttm = ttm(fundamentals, "quarterlyOperatingCashFlow")
    capex_ttm = ttm(fundamentals, "quarterlyCapitalExpenditure")
    revenue_growth = yoy_quarter(fundamentals, "quarterlyTotalRevenue")
    income_growth = yoy_quarter(fundamentals, "quarterlyNetIncome")
    net_margin = (net_income_ttm / revenue_ttm * 100) if revenue_ttm and net_income_ttm is not None else None
    free_cash_flow = (operating_cash_ttm + capex_ttm) if operating_cash_ttm is not None and capex_ttm is not None else None
    fcf_margin = (free_cash_flow / revenue_ttm * 100) if revenue_ttm and free_cash_flow is not None else None
    debt = latest(fundamentals, "quarterlyTotalDebt")
    equity = latest(fundamentals, "quarterlyStockholdersEquity")
    debt_to_equity = (debt / equity) if debt is not None and equity and equity > 0 else None
    pe_ratio = (current_price / eps_ttm) if eps_ttm and eps_ttm > 0 else None

    growth_available = revenue_growth is not None and income_growth is not None
    profitability_available = net_margin is not None
    cash_available = free_cash_flow is not None and fcf_margin is not None
    valuation_available = pe_ratio is not None and debt_to_equity is not None
    trend_available = None not in (sma50, sma200, rsi14, volatility)
    factors = [
        factor(
            "growth",
            "Groei",
            bool(revenue_growth is not None and income_growth is not None and revenue_growth >= 3 and income_growth >= 0),
            growth_available,
            f"Omzet j-o-j {pct_text(revenue_growth)}; nettowinst j-o-j {pct_text(income_growth)}.",
        ),
        factor(
            "profitability",
            "Winstgevendheid",
            bool(net_margin is not None and net_margin >= 8),
            profitability_available,
            f"Nettomarge over de laatste vier kwartalen: {number_text(net_margin, '%')}.",
        ),
        factor(
            "cashflow",
            "Kasstroom",
            bool(free_cash_flow is not None and fcf_margin is not None and free_cash_flow > 0 and fcf_margin >= 5),
            cash_available,
            f"Vrije-kasstroommarge: {number_text(fcf_margin, '%')}.",
        ),
        factor(
            "valuation",
            "Waardering & balans",
            bool(pe_ratio is not None and debt_to_equity is not None and 0 < pe_ratio <= 35 and debt_to_equity <= 3),
            valuation_available,
            f"K/W {number_text(pe_ratio)}; schuld/eigen vermogen {number_text(debt_to_equity)}.",
        ),
        factor(
            "trend",
            "Trend & risico",
            bool(
                sma50 is not None
                and sma200 is not None
                and rsi14 is not None
                and volatility is not None
                and current_price > sma200
                and sma50 > sma200
                and 40 <= rsi14 <= 72
                and volatility <= 55
            ),
            trend_available,
            f"Koers t.o.v. 200-daags {pct_text(percent_change(current_price, sma200))}; RSI {number_text(rsi14)}; volatiliteit {number_text(volatility, '%')}.",
        ),
    ]
    score = sum(1 for item in factors if item["passed"])
    complete = all(item["status"] != "unavailable" for item in factors)
    politician_action = "Purchase" if is_purchase(trade.get("type")) else "Sale"
    if politician_action == "Purchase" and complete and score == 5:
        signal, signal_label = "BUY", "Koopkandidaat"
    elif politician_action == "Sale" and score <= 2:
        signal, signal_label = "REDUCE", "Risicosignaal"
    elif politician_action == "Sale":
        signal, signal_label = "AVOID", "Vermijden"
    elif score >= 4:
        signal, signal_label = "WAIT", "Wachten op bevestiging"
    else:
        signal, signal_label = "AVOID", "Geen koop"

    current_atr = atr14 or current_price * 0.04
    stop_distance = max(2 * current_atr, current_price * 0.08)
    entry_low = max(0.01, current_price - min(0.5 * current_atr, current_price * 0.02))
    entry_high = current_price
    stop_loss = max(0.01, current_price - stop_distance)
    take_profit = current_price + (2 * (current_price - stop_loss))
    strategy_active = signal == "BUY"

    return {
        "id": f"{trade.get('politician')}:{symbol}",
        "politician": trade.get("politician"),
        "symbol": symbol,
        "company": meta.get("longName") or meta.get("shortName") or trade.get("assetDescription") or symbol,
        "currency": meta.get("currency") or "USD",
        "politicianSignal": {
            "tradeId": trade.get("id"),
            "action": politician_action,
            "amount": trade.get("amount"),
            "transactionDate": trade.get("transactionDate"),
            "disclosureDate": trade.get("disclosureDate"),
            "reportingDelayDays": trade.get("reportingDelayDays"),
            "sourceUrl": trade.get("sourceUrl"),
        },
        "market": {
            "price": rounded(current_price),
            "priceDate": datetime.fromtimestamp(rows[-1]["timestamp"], timezone.utc).date().isoformat(),
            "sma50": rounded(sma50),
            "sma200": rounded(sma200),
            "rsi14": rounded(rsi14, 1),
            "atr14": rounded(atr14),
            "annualizedVolatilityPct": rounded(volatility, 1),
            "fiftyTwoWeekHigh": rounded(finite(meta.get("fiftyTwoWeekHigh"))),
            "fiftyTwoWeekLow": rounded(finite(meta.get("fiftyTwoWeekLow"))),
        },
        "fundamentals": {
            "revenueGrowthYoYPct": rounded(revenue_growth, 1),
            "netIncomeGrowthYoYPct": rounded(income_growth, 1),
            "netMarginPct": rounded(net_margin, 1),
            "freeCashFlowMarginPct": rounded(fcf_margin, 1),
            "peRatio": rounded(pe_ratio, 1),
            "debtToEquity": rounded(debt_to_equity, 2),
        },
        "factors": factors,
        "score": score,
        "complete": complete,
        "signal": signal,
        "signalLabel": signal_label,
        "strategy": {
            "active": strategy_active,
            "entryLow": rounded(entry_low) if strategy_active else None,
            "entryHigh": rounded(entry_high) if strategy_active else None,
            "stopLoss": rounded(stop_loss) if strategy_active else None,
            "takeProfit": rounded(take_profit) if strategy_active else None,
            "rewardRiskRatio": 2 if strategy_active else None,
            "startedAt": None,
            "exitReason": None,
            "exitAt": None,
            "exitPrice": None,
            "rule": "Alleen actief bij recente aankoop en 5/5 geslaagde pijlers.",
        },
        "marketSourceUrl": f"https://finance.yahoo.com/quote/{symbol}",
    }


def atomic_write(payload: dict[str, Any]) -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix="analysis-", suffix=".json", dir=OUTPUT_PATH.parent)
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


def analyze_all(selections: Iterable[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
    cache: dict[str, tuple[dict[str, Any], dict[str, list[tuple[str, float]]]]] = {}
    analyses: list[dict[str, Any]] = []
    errors: list[str] = []
    for trade in selections:
        symbol = str(trade.get("symbol") or "").upper()
        try:
            if symbol not in cache:
                cache[symbol] = (fetch_prices(session, symbol), fetch_fundamentals(session, symbol))
                time.sleep(0.15)
            prices, fundamentals = cache[symbol]
            analyses.append(build_analysis(trade, prices, fundamentals))
        except (AnalysisUnavailable, KeyError, TypeError, ValueError) as error:
            errors.append(f"{symbol}: {error}")
    return analyses, errors


def same_disclosure(previous: dict[str, Any], current: dict[str, Any]) -> bool:
    previous_signal = previous.get("politicianSignal") or {}
    current_signal = current.get("politicianSignal") or {}
    previous_trade_id = previous_signal.get("tradeId")
    current_trade_id = current_signal.get("tradeId")
    if previous_trade_id and current_trade_id:
        return previous_trade_id == current_trade_id
    return all(
        previous_signal.get(key) == current_signal.get(key)
        for key in ("action", "transactionDate", "disclosureDate")
    )


def apply_strategy_state(
    analyses: list[dict[str, Any]], existing: dict[str, Any], now: str,
) -> list[dict[str, Any]]:
    previous_by_id = {
        stock.get("id"): stock
        for stock in existing.get("stocks") or []
        if isinstance(stock, dict) and stock.get("id")
    }
    for stock in analyses:
        previous = previous_by_id.get(stock.get("id"))
        strategy = stock.get("strategy") or {}
        if strategy.get("active"):
            strategy["startedAt"] = now
        if not previous or not same_disclosure(previous, stock):
            continue

        previous_strategy = previous.get("strategy") or {}
        previous_signal = previous.get("signal")
        if previous_signal in TERMINAL_SIGNALS:
            stock["signal"] = previous_signal
            stock["signalLabel"] = previous.get("signalLabel")
            stock["strategy"] = dict(previous_strategy)
            continue

        if previous_signal != "BUY" or not previous_strategy.get("active"):
            continue

        preserved = dict(previous_strategy)
        preserved.setdefault("startedAt", now)
        current_price = finite((stock.get("market") or {}).get("price"))
        stop_loss = finite(preserved.get("stopLoss"))
        take_profit = finite(preserved.get("takeProfit"))

        if stock.get("signal") != "BUY":
            stock["signal"] = "EXIT"
            stock["signalLabel"] = "5/5-bevestiging vervallen"
            preserved.update({
                "active": False,
                "exitReason": "model",
                "exitAt": now,
                "exitPrice": rounded(current_price),
            })
        elif current_price is not None and take_profit is not None and current_price >= take_profit:
            stock["signal"] = "TAKE_PROFIT"
            stock["signalLabel"] = "Verkoopdoel geraakt"
            preserved.update({
                "active": False,
                "exitReason": "target",
                "exitAt": now,
                "exitPrice": rounded(current_price),
            })
        elif current_price is not None and stop_loss is not None and current_price <= stop_loss:
            stock["signal"] = "STOP"
            stock["signalLabel"] = "Stop-loss geraakt"
            preserved.update({
                "active": False,
                "exitReason": "stop",
                "exitAt": now,
                "exitPrice": rounded(current_price),
            })
        stock["strategy"] = preserved
    return analyses


def transition_events(existing: dict[str, Any], analyses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if existing.get("mode") != "educational-analysis" or not isinstance(existing.get("stocks"), list):
        return []
    previous_by_id = {
        stock.get("id"): stock
        for stock in existing.get("stocks") or []
        if isinstance(stock, dict) and stock.get("id")
    }
    events: list[dict[str, Any]] = []
    for stock in analyses:
        previous = previous_by_id.get(stock.get("id"))
        comparable_previous = previous if previous and same_disclosure(previous, stock) else None
        previous_signal = comparable_previous.get("signal") if comparable_previous else None
        current_signal = stock.get("signal")
        if current_signal == "BUY" and previous_signal != "BUY":
            events.append({"kind": "buy", "stock": stock})
        elif current_signal in {"TAKE_PROFIT", "STOP", "EXIT"} and previous_signal == "BUY":
            events.append({"kind": "exit", "stock": stock})
    return events


def digest_events(analyses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"kind": "digest", "stock": stock} for stock in analyses if stock.get("signal") == "BUY"]


def send_ntfy_events(events: list[dict[str, Any]], strict: bool = False) -> bool:
    selected = [event for event in events if matches_watch_filter(event["stock"])]
    topic = os.getenv("NTFY_TOPIC", "").strip()
    if not topic:
        if strict:
            github_annotation("error", "Testmelding niet verstuurd: repository-secret NTFY_TOPIC ontbreekt.")
            return False
        if selected:
            print("Nieuwe analysesignalen gevonden, maar NTFY_TOPIC is niet ingesteld.")
        return True
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", topic):
        github_annotation("error" if strict else "warning", "NTFY_TOPIC heeft een ongeldig formaat; analysemelding is overgeslagen.")
        return not strict
    if not selected:
        if strict:
            github_annotation("warning", "Geen actieve 5/5-koopkandidaat gevonden voor de ingestelde watchfilters.")
        return True

    app_url = os.getenv("CAPITOL_PULSE_URL", "").strip() or default_app_url()
    all_sent = True
    for event in selected[:6]:
        stock = event["stock"]
        strategy = stock.get("strategy") or {}
        currency = str(stock.get("currency") or "USD")
        kind = event["kind"]
        if kind in {"buy", "digest"}:
            title = "Capitol Pulse: 5/5 koopkandidaat"
            intro = "Test van huidige kandidaat" if kind == "digest" else "Nieuw analysesignaal"
            body = "\n".join([
                f"{intro}: {stock.get('politician')} · {stock.get('symbol')}",
                f"Instap: {currency_text(strategy.get('entryLow'), currency)} – {currency_text(strategy.get('entryHigh'), currency)}",
                f"Stop-loss: {currency_text(strategy.get('stopLoss'), currency)}",
                f"Verkoopdoel (2R): {currency_text(strategy.get('takeProfit'), currency)}",
                f"Koersdatum: {(stock.get('market') or {}).get('priceDate') or 'onbekend'}",
                "Educatief regelmodel; geen persoonlijk advies of winstgarantie.",
            ])
            tags = "chart_with_upwards_trend,bullseye"
        else:
            reason = stock.get("signalLabel") or "Modelpositie beëindigd"
            title = f"Capitol Pulse: {reason}"
            body = "\n".join([
                f"{stock.get('politician')} · {stock.get('symbol')}",
                f"Laatste koers: {currency_text((stock.get('market') or {}).get('price'), currency)}",
                f"Oorspronkelijke stop: {currency_text(strategy.get('stopLoss'), currency)}",
                f"Oorspronkelijk verkoopdoel: {currency_text(strategy.get('takeProfit'), currency)}",
                "Controleer de actuele koers en je eigen order; uitvoering is niet automatisch.",
            ])
            tags = "warning,chart_with_downwards_trend"
        headers = {"Title": title, "Tags": tags, "Priority": "high"}
        if app_url.startswith("https://"):
            headers["Click"] = f"{app_url.rstrip('/')}/#beslissing"
        try:
            response = requests.post(
                f"https://ntfy.sh/{quote(topic, safe='')}",
                data=body.encode("utf-8"),
                headers=headers,
                timeout=(10, 30),
            )
            response.raise_for_status()
            print(f"ntfy: analysesignaal voor {stock.get('symbol')} verstuurd.")
        except requests.RequestException as error:
            all_sent = False
            github_annotation("error" if strict else "warning", f"Analyse is bijgewerkt, maar ntfy-melding mislukte: {error}")
    return all_sent or not strict


def main() -> int:
    trades_payload = load_json(TRADES_PATH)
    trades = trades_payload.get("trades")
    if not isinstance(trades, list) or not trades:
        github_annotation("error", "Aandelenanalyse afgebroken: live.json bevat geen transacties.")
        return 1

    existing = load_json(OUTPUT_PATH)
    force_analysis = env_truthy("FORCE_ANALYSIS")
    send_digest = env_truthy("SEND_ANALYSIS_DIGEST")
    now_datetime = datetime.now(timezone.utc)
    existing_metadata = existing.get("metadata") or {}
    live_updated_at = str((trades_payload.get("metadata") or {}).get("updatedAt") or "")
    existing_live_updated_at = str(existing_metadata.get("liveUpdatedAt") or "")
    try:
        previous_update = datetime.fromisoformat(str(existing_metadata.get("updatedAt") or "").replace("Z", "+00:00"))
    except ValueError:
        previous_update = None
    recently_updated = bool(
        previous_update
        and previous_update.tzinfo
        and now_datetime - previous_update < MIN_REFRESH_INTERVAL
        and existing_live_updated_at == live_updated_at
    )
    if not force_analysis and recently_updated:
        if send_digest:
            return 0 if send_ntfy_events(digest_events(existing.get("stocks") or []), strict=True) else 1
        print("Aandelenanalyse is minder dan vier uur oud en de transactiedata is gelijk; bestand blijft ongewijzigd.")
        return 0

    people, selections = select_featured(trades)
    if len(selections) < 5:
        github_annotation("error", "Aandelenanalyse afgebroken: te weinig recente aandelen voor de top vijf.")
        return 1
    analyses, errors = analyze_all(selections)
    represented = {item["politician"] for item in analyses}
    existing_count = len(existing.get("stocks") or [])
    if len(analyses) < 5 or len(represented) < 3:
        github_annotation("error", f"Aandelenanalyse afgebroken: slechts {len(analyses)} bruikbare aandelen voor {len(represented)} politici.")
        return 1
    if existing_count and len(analyses) < math.ceil(existing_count * 0.8):
        github_annotation("error", "Aandelenanalyse afgebroken: de nieuwe respons is onverwacht veel kleiner; bestaande analyse blijft behouden.")
        return 1

    now = now_datetime.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    analyses = apply_strategy_state(analyses, existing, now)
    events = digest_events(analyses) if send_digest else transition_events(existing, analyses)
    payload = {
        "mode": "educational-analysis",
        "metadata": {
            "updatedAt": now,
            "modelVersion": "five-pillars-v2-notifications",
            "liveUpdatedAt": live_updated_at,
            "refreshIntervalHours": 4,
            "priceSource": "Yahoo Finance chart endpoint",
            "fundamentalsSource": "Yahoo Finance fundamentals time-series",
            "politicianSource": trades_payload.get("metadata", {}).get("source"),
            "stockCount": len(analyses),
            "errorCount": len(errors),
            "notice": "Regelgestuurde educatieve analyse; geen persoonlijk beleggingsadvies of winstgarantie.",
        },
        "methodology": {
            "selection": "Vijf actieve, herkenbare Congresleden uit de recente openbare dataset; maximaal drie recente gewone aandelen per persoon.",
            "buyRule": "Alleen koopkandidaat na een recente openbare aankoop en wanneer alle vijf pijlers slagen.",
            "pillars": ["Groei", "Winstgevendheid", "Kasstroom", "Waardering & balans", "Trend & risico"],
            "riskRule": "Instap rond de laatst beschikbare koers, stop op minimaal 8% of twee ATR en koersdoel op twee keer het risico.",
        },
        "featuredPoliticians": people,
        "stocks": analyses,
        "errors": errors,
    }
    atomic_write(payload)
    print(f"Aandelenanalyse bijgewerkt: {len(analyses)} aandelen voor {len(represented)} politici; {len(errors)} overgeslagen.")
    if existing.get("mode") != "educational-analysis":
        print("Analysebaseline aangemaakt; bestaande koopkandidaten zijn niet als nieuw gemeld.")
    return 0 if send_ntfy_events(events, strict=send_digest) else 1


if __name__ == "__main__":
    raise SystemExit(main())

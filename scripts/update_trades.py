#!/usr/bin/env python3
"""Werk de Capitol Pulse-dataset bij vanuit openbare congresmeldingen.

De gekozen feed is gratis en sleutelvrij en normaliseert gegevens uit de
officiële House Clerk- en Senate eFD-filings. Een mislukte of lege fetch
vervangt het bestaande bestand nooit.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
import time
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote

import requests


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = REPOSITORY_ROOT / "public" / "data" / "live.json"
SOURCE_URL = os.getenv(
    "CONGRESS_TRADES_SOURCE_URL",
    "https://raw.githubusercontent.com/kadoa-org/congress-trading-monitor/main/public/data/trades.json",
)
SOURCE_ID = "kadoa-congress-trading-monitor"
DEFAULT_MAX_RECORDS = 1500
REQUEST_TIMEOUT = (10, 35)
USER_AGENT = "CapitolPulse/1.0 (+https://github.com/Joepxnlx/capitol-pulse-joep)"


class SourceUnavailable(RuntimeError):
    """De externe bron leverde geen bruikbare dataset."""


def github_annotation(level: str, message: str) -> None:
    """Schrijf een leesbare GitHub Actions-annotatie en gewone consolemelding."""
    clean = message.replace("\r", " ").replace("\n", " ")
    if os.getenv("GITHUB_ACTIONS") == "true":
        print(f"::{level}::{clean}")
    print(message, file=sys.stderr if level == "error" else sys.stdout)


def parse_iso_date(value: Any) -> date | None:
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def clean_text(value: Any, fallback: str = "") -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip() or fallback


def normalized_type(value: Any) -> str:
    raw = clean_text(value).lower()
    if any(word in raw for word in ("purchase", "buy")):
        return "Purchase"
    if any(word in raw for word in ("sale", "sell")):
        return "Sale"
    if "exchange" in raw:
        return "Exchange"
    return clean_text(value, "Other").title()


def normalized_chamber(value: Any) -> str:
    raw = clean_text(value).lower()
    if raw in {"house", "representative", "representatives"}:
        return "House"
    if raw in {"senate", "senator"}:
        return "Senate"
    raise ValueError(f"Onbekende kamer: {value!r}")


def amount_label(low: int, high: int, supplied: Any) -> str:
    label = clean_text(supplied)
    if label:
        return label
    if low and high:
        return f"${low:,} - ${high:,}"
    if low:
        return f"Vanaf ${low:,}"
    return "Bedrag onbekend"


def canonical_key(record: dict[str, Any]) -> str:
    fields = (
        record["chamber"], record["politician"], record["symbol"],
        record["assetDescription"], record["type"], record["amount"],
        record["transactionDate"], record["disclosureDate"], record["sourceUrl"],
    )
    return "|".join(str(field) for field in fields)


def normalize_record(raw: dict[str, Any]) -> dict[str, Any]:
    transaction_date = parse_iso_date(raw.get("transaction_date"))
    disclosure_date = parse_iso_date(raw.get("filing_date"))
    if not transaction_date or not disclosure_date:
        raise ValueError("transactie- of openbaarmakingsdatum ontbreekt")

    politician = clean_text(raw.get("filer_name"))
    if not politician:
        raise ValueError("naam van politicus ontbreekt")

    chamber = normalized_chamber(raw.get("chamber"))
    amount_min = max(0, int(raw.get("amount_range_low") or 0))
    amount_max = max(amount_min, int(raw.get("amount_range_high") or amount_min))
    ticker = clean_text(raw.get("ticker")).upper()
    if ticker in {"N/A", "NA", "NONE", "--"}:
        ticker = ""
    source_url = clean_text(raw.get("doc_url"))
    if not source_url.startswith("https://"):
        raise ValueError("geldige HTTPS-bronlink ontbreekt")

    return {
        "id": clean_text(raw.get("id"))[:160],
        "chamber": chamber,
        "politician": politician,
        "state": clean_text(raw.get("state")),
        "symbol": ticker,
        "party": clean_text(raw.get("party")),
        "owner": clean_text(raw.get("owner")),
        "assetDescription": clean_text(raw.get("asset_name"), ticker or "Effect niet nader omschreven"),
        "assetType": clean_text(raw.get("asset_type")),
        "type": normalized_type(raw.get("transaction_type")),
        "amount": amount_label(amount_min, amount_max, raw.get("amount_range_label")),
        "amountMin": amount_min,
        "amountMax": amount_max,
        "transactionDate": transaction_date.isoformat(),
        "disclosureDate": disclosure_date.isoformat(),
        "reportingDelayDays": max(0, (disclosure_date - transaction_date).days),
        "sourceUrl": source_url,
    }


def assign_stable_ids(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Behoud bron-ID's en maak alleen voor ontbrekende of dubbele IDs een stabiele ID."""
    records.sort(key=lambda item: (item.get("id", ""), canonical_key(item)))
    occurrences: defaultdict[str, int] = defaultdict(int)
    used_ids: set[str] = set()
    for record in records:
        key = canonical_key(record)
        occurrences[key] += 1
        source_id = record.get("id", "")
        if not source_id or source_id in used_ids:
            digest_input = f"{key}|duplicate:{occurrences[key]}".encode("utf-8")
            source_id = hashlib.sha256(digest_input).hexdigest()[:24]
            record["id"] = source_id
        used_ids.add(source_id)
    records.sort(
        key=lambda item: (item["disclosureDate"], item["transactionDate"], item["politician"], item["id"]),
        reverse=True,
    )
    return records


def request_source(session: requests.Session, etag: str = "") -> tuple[list[dict[str, Any]] | None, str]:
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            headers = {"If-None-Match": etag} if etag else {}
            response = session.get(SOURCE_URL, headers=headers, timeout=REQUEST_TIMEOUT)
            if response.status_code == 304:
                return None, etag
            if response.status_code == 429:
                retry_after = response.headers.get("Retry-After", "")
                try:
                    wait_seconds = min(30, max(2, int(retry_after)))
                except ValueError:
                    wait_seconds = attempt * 10
                raise requests.HTTPError(
                    f"HTTP 429 (gratis rate-limit; nieuwe poging over {wait_seconds}s)",
                    response=response,
                )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, list):
                raise ValueError("antwoord is geen JSON-lijst")
            records = [record for record in payload if isinstance(record, dict)]
            if not records:
                raise ValueError("antwoord bevat nul transacties")
            return records, response.headers.get("ETag", "")
        except (requests.RequestException, ValueError) as error:
            last_error = error
            if attempt < 3:
                response = getattr(error, "response", None)
                if response is not None and response.status_code == 429:
                    retry_after = response.headers.get("Retry-After", "")
                    try:
                        wait_seconds = min(30, max(2, int(retry_after)))
                    except ValueError:
                        wait_seconds = attempt * 10
                    time.sleep(wait_seconds)
                else:
                    time.sleep(attempt * 2)
    raise SourceUnavailable(f"Databron niet bereikbaar na 3 pogingen: {last_error}")


def fetch_trades(existing_etag: str = "") -> tuple[list[dict[str, Any]] | None, int, str]:
    try:
        requested_max = int(os.getenv("MAX_RECORDS", str(DEFAULT_MAX_RECORDS)))
    except ValueError as error:
        raise SourceUnavailable("MAX_RECORDS moet een geheel getal zijn.") from error
    max_records = min(5000, max(100, requested_max))

    session = requests.Session()
    session.headers.update({"Accept": "application/json", "User-Agent": USER_AGENT})
    raw_records, source_etag = request_source(session, existing_etag)
    if raw_records is None:
        return None, 0, source_etag

    normalized: list[dict[str, Any]] = []
    rejected = 0
    for raw in raw_records:
        if clean_text(raw.get("branch")).lower() != "congress":
            continue
        if clean_text(raw.get("chamber")).lower() not in {"house", "senate"}:
            continue
        try:
            normalized.append(normalize_record(raw))
        except (TypeError, ValueError):
            rejected += 1
    if not normalized:
        raise SourceUnavailable("Alle ontvangen records waren ongeldig; bestaand bestand blijft behouden.")
    chambers = {record["chamber"] for record in normalized}
    if chambers != {"House", "Senate"}:
        raise SourceUnavailable("De ontvangen dataset bevat niet zowel House als Senate; bestaand bestand blijft behouden.")
    normalized = assign_stable_ids(normalized)[:max_records]
    return normalized, rejected, source_etag


def load_existing() -> dict[str, Any]:
    if not OUTPUT_PATH.exists():
        return {}
    try:
        payload = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError) as error:
        github_annotation("warning", f"Bestaand live.json is ongeldig en wordt als ontbrekend behandeld: {error}")
        return {}


def split_filter(value: str) -> set[str]:
    return {item.strip().casefold() for item in re.split(r"[,;\n]", value) if item.strip()}


def matching_notifications(trades: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    ticker_filters = split_filter(os.getenv("WATCH_TICKERS", ""))
    politician_filters = split_filter(os.getenv("WATCH_POLITICIANS", ""))
    if not ticker_filters and not politician_filters:
        return list(trades)
    selected = []
    for trade in trades:
        ticker_match = trade.get("symbol", "").casefold() in ticker_filters
        name = trade.get("politician", "").casefold()
        politician_match = any(watched in name for watched in politician_filters)
        if ticker_match or politician_match:
            selected.append(trade)
    return selected


def default_app_url() -> str:
    repository = os.getenv("GITHUB_REPOSITORY", "")
    if "/" not in repository:
        return ""
    owner, name = repository.split("/", 1)
    return f"https://{owner.casefold()}.github.io/{name}/"


def send_ntfy(trades: list[dict[str, Any]]) -> None:
    topic = os.getenv("NTFY_TOPIC", "").strip()
    if not topic or not trades:
        return
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", topic):
        github_annotation("warning", "NTFY_TOPIC heeft een ongeldig formaat; melding is overgeslagen.")
        return

    shown = trades[:6]
    lines = []
    for trade in shown:
        trade_type = "Aankoop" if re.search(r"purchase|buy", trade["type"], re.I) else "Verkoop" if re.search(r"sale|sell", trade["type"], re.I) else trade["type"]
        lines.append(f"{trade['politician']} · {trade['symbol'] or trade['assetDescription']} · {trade_type} · {trade['amount']}")
    if len(trades) > len(shown):
        lines.append(f"… en nog {len(trades) - len(shown)} nieuwe transacties")
    headers = {
        "Title": f"Capitol Pulse: {len(trades)} nieuwe melding{'en' if len(trades) != 1 else ''}",
        "Tags": "classical_building,chart_with_upwards_trend",
    }
    app_url = os.getenv("CAPITOL_PULSE_URL", "").strip() or default_app_url()
    if app_url.startswith("https://"):
        headers["Click"] = f"{app_url.rstrip('/')}/#analyse"
    try:
        response = requests.post(
            f"https://ntfy.sh/{quote(topic, safe='')}",
            data="\n".join(lines).encode("utf-8"),
            headers=headers,
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        print(f"ntfy: {len(trades)} nieuwe transacties gemeld.")
    except requests.RequestException as error:
        github_annotation("warning", f"Dataset is bijgewerkt, maar ntfy-melding mislukte: {error}")


def trades_unchanged(existing: dict[str, Any], trades: list[dict[str, Any]], source_etag: str) -> bool:
    return (
        existing.get("trades") == trades
        and existing.get("mode") == "live"
        and existing.get("metadata", {}).get("sourceEtag", "") == source_etag
    )


def atomic_write(payload: dict[str, Any]) -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", newline="\n", dir=OUTPUT_PATH.parent, delete=False,
        ) as temporary:
            temporary.write(rendered)
            temporary_name = temporary.name
        os.replace(temporary_name, OUTPUT_PATH)
    finally:
        if temporary_name and os.path.exists(temporary_name):
            os.unlink(temporary_name)


def main() -> int:
    existing = load_existing()
    try:
        existing_etag = clean_text(existing.get("metadata", {}).get("sourceEtag"))
        trades, rejected, source_etag = fetch_trades(existing_etag)
    except SourceUnavailable as error:
        github_annotation("error", f"Capitol Pulse-update afgebroken: {error}")
        return 1
    except Exception as error:  # Onverwachte fouten mogen live.json evenmin wissen.
        github_annotation("error", f"Onverwachte updatefout; bestaand live.json blijft behouden: {error}")
        return 1

    if trades is None:
        print("Bron meldt geen wijziging (HTTP 304); live.json blijft ongewijzigd.")
        return 0

    if trades_unchanged(existing, trades, source_etag):
        print(f"Geen nieuwe of gewijzigde transacties ({len(trades)} gecontroleerd).")
        return 0

    old_trades = existing.get("trades") if isinstance(existing.get("trades"), list) else []
    old_ids = {trade.get("id") for trade in old_trades if isinstance(trade, dict)}
    is_baseline = (
        existing.get("mode") != "live"
        or existing.get("metadata", {}).get("sourceId") != SOURCE_ID
        or not old_ids
    )
    new_trades = [] if is_baseline else [trade for trade in trades if trade["id"] not in old_ids]

    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    payload = {
        "mode": "live",
        "metadata": {
            "updatedAt": now,
            "sourceId": SOURCE_ID,
            "source": "Kadoa Congress Trading Monitor, uit officiële House Clerk- en Senate eFD-filings",
            "sourceUrl": "https://github.com/kadoa-org/congress-trading-monitor",
            "sourceEtag": source_etag,
            "recordCount": len(trades),
            "rejectedRecords": rejected,
            "notice": "Transacties verschijnen pas nadat ze openbaar zijn gemaakt.",
        },
        "trades": trades,
    }
    atomic_write(payload)
    print(f"live.json bijgewerkt: {len(trades)} transacties, {rejected} ongeldige records overgeslagen.")

    if is_baseline:
        print("Baseline aangemaakt; bestaande historische transacties zijn niet als nieuw gemeld.")
    else:
        selected = matching_notifications(new_trades)
        print(f"Nieuwe transacties: {len(new_trades)}; na watchfilters: {len(selected)}.")
        send_ntfy(selected)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

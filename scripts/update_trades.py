#!/usr/bin/env python3
"""Fetch latest House and Senate disclosures from FMP, normalize, merge and notify.

Designed for personal use in a scheduled GitHub Action. It never places trades.
"""
from __future__ import annotations
import hashlib, json, os, re, sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote
import requests

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "data" / "live.json"
BASE_URL = "https://financialmodelingprep.com/stable"
TIMEOUT = 35


def env_list(name: str) -> set[str]:
    return {x.strip().lower() for x in os.getenv(name, "").split(",") if x.strip()}


def parse_amount(value: str | None) -> tuple[int, int, float]:
    nums = [int(x.replace(",", "")) for x in re.findall(r"\d[\d,]*", value or "")]
    if len(nums) >= 2:
        lo, hi = nums[0], nums[1]
    elif len(nums) == 1:
        lo = hi = nums[0]
    else:
        lo = hi = 0
    return lo, hi, (lo + hi) / 2 if hi else 0


def iso_date(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(text[:10], fmt).date().isoformat()
        except ValueError:
            pass
    return text[:10]


def day_diff(a: str, b: str) -> int | None:
    try:
        return (datetime.fromisoformat(b).date() - datetime.fromisoformat(a).date()).days
    except (ValueError, TypeError):
        return None


def fetch_latest(chamber: str, api_key: str) -> list[dict[str, Any]]:
    endpoint = "house-latest" if chamber == "House" else "senate-latest"
    response = requests.get(
        f"{BASE_URL}/{endpoint}",
        params={"page": 0, "limit": 100, "apikey": api_key},
        timeout=TIMEOUT,
        headers={"User-Agent": "CapitolPulsePersonalMonitor/1.0"},
    )
    response.raise_for_status()
    data = response.json()
    if isinstance(data, dict) and data.get("Error Message"):
        raise RuntimeError(data["Error Message"])
    if not isinstance(data, list):
        raise RuntimeError(f"Unexpected {chamber} response: {str(data)[:300]}")
    return data


def normalize(row: dict[str, Any], chamber: str) -> dict[str, Any]:
    first = str(row.get("firstName") or "").strip()
    last = str(row.get("lastName") or "").strip()
    politician = " ".join(x for x in (first, last) if x).strip() or str(row.get("office") or "Onbekend").strip()
    symbol = str(row.get("symbol") or "").strip().upper()
    disclosure = iso_date(row.get("disclosureDate"))
    transaction = iso_date(row.get("transactionDate"))
    amount = str(row.get("amount") or "Bedrag onbekend").strip()
    lo, hi, mid = parse_amount(amount)
    source_url = str(row.get("link") or "").strip()
    unique = "|".join([chamber, politician, symbol, transaction, disclosure, str(row.get("type") or ""), amount, str(row.get("owner") or ""), source_url])
    trade_id = hashlib.sha256(unique.encode("utf-8")).hexdigest()[:24]
    delay = day_diff(transaction, disclosure)
    return {
        "id": trade_id,
        "chamber": chamber,
        "politician": politician,
        "state": str(row.get("district") or row.get("state") or "").strip(),
        "party": str(row.get("party") or "Onbekend").strip(),
        "symbol": symbol,
        "assetDescription": str(row.get("assetDescription") or row.get("assetName") or symbol or "Niet nader omschreven").strip(),
        "assetType": str(row.get("assetType") or "Onbekend").strip(),
        "type": str(row.get("type") or row.get("transactionType") or "Overig").strip(),
        "amount": amount,
        "amountMin": lo,
        "amountMax": hi,
        "amountMid": mid,
        "owner": str(row.get("owner") or row.get("ownerType") or "Onbekend").strip(),
        "transactionDate": transaction,
        "disclosureDate": disclosure,
        "reportingDelayDays": delay,
        "comment": str(row.get("comment") or "").strip(),
        "sourceUrl": source_url,
    }


def load_existing() -> dict[str, Any]:
    try:
        payload = json.loads(OUT.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {"trades": []}
    except (OSError, json.JSONDecodeError):
        return {"trades": []}


def should_notify(t: dict[str, Any], tickers: set[str], people: set[str]) -> bool:
    if not tickers and not people:
        return True
    return t.get("symbol", "").lower() in tickers or t.get("politician", "").lower() in people


def send_ntfy(topic: str, new_trades: list[dict[str, Any]]) -> None:
    if not topic or not new_trades:
        return
    topic_url = f"https://ntfy.sh/{quote(topic, safe='')}"
    selected = new_trades[:10]
    if len(selected) == 1:
        t = selected[0]
        title = f"{t['politician']}: {t['type']} {t['symbol'] or t['assetDescription']}"
        body = f"{t['amount']} · gehandeld {t['transactionDate']} · openbaar {t['disclosureDate']}"
        headers = {"Title": title[:200], "Priority": "default", "Tags": "eagle,chart_with_upwards_trend"}
        if t.get("sourceUrl"):
            headers["Click"] = t["sourceUrl"]
        requests.post(topic_url, data=body.encode("utf-8"), headers=headers, timeout=TIMEOUT).raise_for_status()
    else:
        lines = [f"• {t['politician']}: {t['type']} {t['symbol'] or t['assetDescription']} ({t['amount']})" for t in selected]
        extra = f"\n+ {len(new_trades)-len(selected)} meer" if len(new_trades) > len(selected) else ""
        requests.post(
            topic_url,
            data=("\n".join(lines) + extra).encode("utf-8"),
            headers={"Title": f"{len(new_trades)} nieuwe congresmeldingen", "Tags": "eagle,bar_chart"},
            timeout=TIMEOUT,
        ).raise_for_status()


def main() -> int:
    api_key = os.getenv("FMP_API_KEY", "").strip()
    if not api_key:
        print("FMP_API_KEY ontbreekt; live data niet bijgewerkt.", file=sys.stderr)
        return 2

    existing = load_existing()
    old_trades = existing.get("trades", []) if existing.get("mode") == "live" else []
    old_ids = {t.get("id") for t in old_trades}

    raw_house = fetch_latest("House", api_key)
    raw_senate = fetch_latest("Senate", api_key)
    incoming = [normalize(r, "House") for r in raw_house] + [normalize(r, "Senate") for r in raw_senate]

    merged: dict[str, dict[str, Any]] = {t["id"]: t for t in old_trades if t.get("id")}
    for trade in incoming:
        merged[trade["id"]] = trade
    trades = sorted(merged.values(), key=lambda t: (t.get("disclosureDate", ""), t.get("transactionDate", ""), t.get("id", "")), reverse=True)[:5000]

    new_trades = [t for t in incoming if t["id"] not in old_ids]
    now = datetime.now(timezone.utc).isoformat()
    payload = {
        "mode": "live",
        "metadata": {
            "updatedAt": now,
            "source": "FMP-normalisatie met links naar officiële House/Senate-filings",
            "houseRecordsFetched": len(raw_house),
            "senateRecordsFetched": len(raw_senate),
            "newRecords": len(new_trades),
            "retainedRecords": len(trades),
        },
        "trades": trades,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    ticker_watch = env_list("WATCH_TICKERS")
    people_watch = env_list("WATCH_POLITICIANS")
    notify = [t for t in new_trades if should_notify(t, ticker_watch, people_watch)]
    send_ntfy(os.getenv("NTFY_TOPIC", "").strip(), notify)
    print(f"Bijgewerkt: {len(trades)} totaal, {len(new_trades)} nieuw, {len(notify)} gemeld.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

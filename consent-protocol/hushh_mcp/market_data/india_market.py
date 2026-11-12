"""India market view: index quotes, NIFTY sector returns and India market news.

Kept apart from the US market machinery on purpose. The US cache and provider layers
pause every price refresh while the US session is closed, and NSE hours (03:45-10:00 UTC)
never overlap the US regular session, so routing India reads through them would serve
yesterday's close during Indian trading hours. Everything here is keyless Yahoo chart and
Google News RSS, bounded, and the caller owns caching.
"""

import asyncio
import math
import re
import time
import urllib.parse
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from defusedxml import ElementTree as DefusedET

from hushh_mcp.market_data.movers import assemble_movers

INDIA_INDICES: tuple[tuple[str, str], ...] = (
    ("NIFTY 50", "^NSEI"),
    ("SENSEX", "^BSESN"),
    ("NIFTY Bank", "^NSEBANK"),
    ("NIFTY IT", "^CNXIT"),
)

# NIFTY sector indices that Yahoo serves a full daily history for. NIFTY Media and
# NIFTY Financial Services return a single point, so they are left out rather than
# shown as flat.
INDIA_SECTORS: dict[str, str] = {
    "IT": "^CNXIT",
    "Bank": "^NSEBANK",
    "Auto": "^CNXAUTO",
    "Pharma": "^CNXPHARMA",
    "FMCG": "^CNXFMCG",
    "Metal": "^CNXMETAL",
    "Energy": "^CNXENERGY",
    "Realty": "^CNXREALTY",
    "Infra": "^CNXINFRA",
    "PSU Bank": "^CNXPSUBANK",
}

# Large NSE companies the movers are computed from. Yahoo's gainers/losers lists only cover
# US stocks, and there is no quota-safe NSE/BSE source, so the movers are the best and worst of
# these names. The list approximates the NIFTY 50 and is not an index membership claim; a name
# that has been renamed or delisted simply returns no data and is skipped.
NSE_LARGE_CAPS: tuple[str, ...] = (
    "RELIANCE", "TCS", "HDFCBANK", "ICICIBANK", "INFY", "BHARTIARTL", "ITC", "SBIN", "LT",
    "HINDUNILVR", "AXISBANK", "KOTAKBANK", "BAJFINANCE", "MARUTI", "SUNPHARMA", "M&M", "NTPC",
    "ONGC", "TITAN", "ULTRACEMCO", "ASIANPAINT", "WIPRO", "HCLTECH", "POWERGRID", "TATASTEEL",
    "COALINDIA", "ADANIENT", "ADANIPORTS", "JSWSTEEL", "BAJAJFINSV", "NESTLEIND", "TECHM",
    "GRASIM", "HINDALCO", "CIPLA", "DRREDDY", "EICHERMOT", "APOLLOHOSP", "TATACONSUM",
    "SBILIFE", "HDFCLIFE", "INDUSINDBK", "BPCL", "BRITANNIA", "SHRIRAMFIN", "TRENT", "BEL",
    "ETERNAL", "JIOFIN", "INDIGO",
)  # fmt: skip
INDIA_MOVERS_CONCURRENCY = 5
INDIA_MOVERS_DEADLINE_SECONDS = 12.0
INDIA_MOVERS_STALE_SECONDS = 6 * 60 * 60
# Last list that loaded, kept per process so a rate-limited refresh can still show it.
_LAST_GOOD_MOVERS: dict[str, Any] = {}
INDIA_NEWS_QUERY = "NIFTY OR SENSEX OR NSE OR BSE"
INDIA_NEWS_LIMIT = 20


def india_symbols() -> list[str]:
    ordered = [symbol for _, symbol in INDIA_INDICES] + list(INDIA_SECTORS.values())
    return list(dict.fromkeys(ordered))


def _finite(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


async def fetch_india_quotes() -> dict[str, dict[str, Any]]:
    """One-month daily history for every symbol, then the last session's intraday line for the indices."""
    from hushh_mcp.operons.kai.fetchers import _fetch_yahoo_quotes

    rows = await _fetch_yahoo_quotes(india_symbols(), range_period="1mo")
    quotes = {str(row.get("ticker") or "").upper(): row for row in rows if row.get("ticker")}
    index_symbols = [symbol for _, symbol in INDIA_INDICES]
    try:
        intraday = await _fetch_yahoo_quotes(index_symbols, range_period="1d")
    except Exception:
        intraday = []
    lines = {str(row.get("ticker") or "").upper(): row.get("sparkline") for row in intraday}
    for symbol in index_symbols:
        row = quotes.get(symbol)
        if row is None:
            continue
        line = lines.get(symbol)
        # The change shown is one session, so the line is that session. A month-long line would
        # sit beside a one-day change and contradict it (a red day on a rising line), so with no
        # intraday data the card shows the neutral guide instead.
        row["sparkline"] = line if isinstance(line, list) and len(line) >= 2 else None
    return quotes


def build_india_overview(
    quotes: dict[str, dict[str, Any]], status_payload: dict[str, Any]
) -> list[dict[str, Any]]:
    """Same row shape the US strip uses, so the client renders it unchanged."""
    out: list[dict[str, Any]] = []
    for label, symbol in INDIA_INDICES:
        quote = quotes.get(symbol) or {}
        out.append(
            {
                "id": symbol.lower(),
                "label": label,
                "symbol": symbol,
                "value": _finite(quote.get("price")),
                "delta_pct": _finite(quote.get("change_percent")),
                "as_of": quote.get("quoted_at"),
                "retrieved_at": quote.get("fetched_at"),
                "is_delayed": bool(quote.get("is_delayed")),
                "quote_delay_minutes": quote.get("quote_delay_minutes"),
                "market_state": quote.get("market_state"),
                "source": str(quote.get("source") or "Unavailable"),
                "degraded": not quote or bool(quote.get("is_stale")),
                "sparkline": quote.get("sparkline") or None,
            }
        )
    out.append(
        {
            "id": "market_status",
            "label": status_payload["label"],
            "value": status_payload["value"],
            "delta_pct": status_payload["delta_pct"],
            "as_of": status_payload["as_of"],
            "source": status_payload["source"],
            "degraded": bool(status_payload.get("degraded")),
        }
    )
    return out


def build_india_sectors(quotes: dict[str, dict[str, Any]]) -> tuple[list[dict[str, Any]], str]:
    """Sector rows in the US sector-rotation shape: last session and five-session returns."""

    def day(point: dict[str, float]) -> str:
        return datetime.fromtimestamp(point["t"], tz=UTC).date().isoformat()

    rows: list[dict[str, Any]] = []
    for sector, symbol in INDIA_SECTORS.items():
        points = (quotes.get(symbol) or {}).get("sparkline_points") or []
        if len(points) < 2:
            continue
        last = points[-1]
        rows.append(
            {
                "sector": sector,
                "symbol": symbol,
                "change_pct": (last["p"] / points[-2]["p"] - 1) * 100,
                "change_1w_pct": (last["p"] / points[-6]["p"] - 1) * 100
                if len(points) >= 6
                else None,
                "period_start_1d": day(points[-2]),
                "period_start_1w": day(points[-6]) if len(points) >= 6 else None,
                "period_end": day(last),
                "basis": "NIFTY sector index return",
                "as_of": datetime.fromtimestamp(last["t"], tz=UTC).isoformat(),
                "source_tags": ["Yahoo Finance", symbol],
                "degraded": False,
            }
        )
    if not rows:
        return [], "unavailable"
    return rows, "ok" if len(rows) == len(INDIA_SECTORS) else "partial"


def _publisher_logo(url: str | None) -> str | None:
    """Google News carries no article images, so each headline gets its publisher's mark."""
    host = urllib.parse.urlsplit(str(url or "")).hostname or ""
    if not re.fullmatch(r"[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}", host.lower()):
        return None
    return f"https://www.google.com/s2/favicons?domain={host.lower()}&sz=128"


def parse_india_news(xml_text: str) -> list[dict[str, Any]]:
    """Newest first, one row per headline, publisher suffix removed from the title."""
    try:
        root = DefusedET.fromstring(xml_text)
    except DefusedET.ParseError:
        return []
    rows: list[tuple[datetime, dict[str, Any]]] = []
    seen: set[str] = set()
    for item in root.findall(".//item"):
        raw_title = (item.findtext("title") or "").strip()
        url = (item.findtext("link") or "").strip()
        source_node = item.find("source")
        source_name = ((source_node.text if source_node is not None else "") or "").strip()
        title = raw_title
        # Google appends " - Publisher" to every title; the row already shows the publisher.
        if source_name and raw_title.endswith(f" - {source_name}"):
            title = raw_title[: -len(source_name) - 3].strip()
        key = re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()
        if not title or not url or key in seen:
            continue
        seen.add(key)
        try:
            published = parsedate_to_datetime((item.findtext("pubDate") or "").strip())
            published = published if published.tzinfo else published.replace(tzinfo=UTC)
        except (TypeError, ValueError):
            published = datetime.fromtimestamp(0, tz=UTC)
        rows.append(
            (
                published,
                {
                    # MARKET marks a story that is not about one company, so the client shows no
                    # ticker chip or company logo for it.
                    "symbol": "MARKET",
                    "title": title,
                    "url": url,
                    "published_at": published.astimezone(UTC).isoformat(),
                    "source_name": source_name or "Google News",
                    "source_logo_url": _publisher_logo(
                        source_node.get("url") if source_node is not None else None
                    ),
                    "provider": "google_news_rss",
                    "image_url": None,
                    "image_thumbnail_url": None,
                    "sentiment_hint": None,
                    "degraded": False,
                },
            )
        )
    rows.sort(key=lambda row: row[0], reverse=True)
    return [row for _, row in rows[:INDIA_NEWS_LIMIT]]


async def fetch_india_news(days_back: int = 7) -> list[dict[str, Any]]:
    """India edition of Google News for the NIFTY / SENSEX conversation."""
    from hushh_mcp.operons.kai.fetchers import record_provider_request

    query = urllib.parse.quote_plus(f"{INDIA_NEWS_QUERY} when:{max(1, days_back)}d")
    url = f"https://news.google.com/rss/search?q={query}&hl=en-IN&gl=IN&ceid=IN:en"
    timeout = httpx.Timeout(connect=4.0, read=8.0, write=8.0, pool=4.0)
    headers = {"User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)"}
    async with httpx.AsyncClient(
        event_hooks={"request": [record_provider_request]}, timeout=timeout, headers=headers
    ) as client:
        response = await client.get(url)
        response.raise_for_status()
    return parse_india_news(response.text or "")


def parse_nse_chart(chart: dict[str, Any], name: str) -> dict[str, Any] | None:
    """One NSE stock: price now, and the change against the previous session's close."""
    meta = chart.get("meta") or {}
    closes = (((chart.get("indicators") or {}).get("quote") or [{}])[0]).get("close") or []
    try:
        zone = ZoneInfo(meta.get("exchangeTimezoneName") or "Asia/Kolkata")
    except Exception:
        zone = ZoneInfo("Asia/Kolkata")
    sessions: dict[Any, float] = {}
    for stamp, close in zip(chart.get("timestamp") or [], closes, strict=False):
        if _finite(stamp) is None or _finite(close) is None or close <= 0:
            continue
        # Yahoo can add a second, live bar for the same session; one bar per session, last wins.
        sessions[datetime.fromtimestamp(stamp, tz=zone).date()] = float(close)
    ordered = [sessions[day] for day in sorted(sessions)]
    price = _finite(meta.get("regularMarketPrice"))
    if len(ordered) < 2 or price is None or price <= 0:
        return None
    # chartPreviousClose is the start of the range and previousClose has been stale for Indian
    # symbols, so the change is measured from the previous session's own close.
    stamp = _finite(meta.get("regularMarketTime"))
    return {
        "symbol": name,
        "company_name": str(meta.get("longName") or meta.get("shortName") or name).strip(),
        "price": price,
        "change_pct": (price / ordered[-2] - 1) * 100,
        "volume": _finite(meta.get("regularMarketVolume")),
        "as_of": datetime.fromtimestamp(stamp, tz=UTC).isoformat() if stamp else None,
        "source_tags": ["Yahoo Finance", "NSE"],
        "degraded": False,
    }


def build_india_movers(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Best and worst of the names that returned data, stamped with the latest session time."""
    stamps = [row["as_of"] for row in rows if row.get("as_of")]
    latest = max(stamps) if stamps else datetime.now(UTC).isoformat()
    shared = [{**row, "as_of": latest} for row in rows]
    payload, _ = assemble_movers(
        {"gainers": shared, "losers": shared, "active": shared}, {}, latest
    )
    return {**payload, "universe": "nse_large_caps", "universe_size": len(rows)}


async def fetch_india_movers() -> dict[str, Any]:
    """Daily history for each large NSE name, bounded in time and in concurrency.

    Uses its own client, limit and throttle flag instead of the shared US quote path, so an
    India refresh can neither be paused by the US session gate nor trip the US quote cooldown.
    """
    from hushh_mcp.operons.kai.fetchers import record_provider_request

    timeout = httpx.Timeout(connect=4.0, read=8.0, write=8.0, pool=4.0)
    headers = {"User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)"}
    semaphore = asyncio.Semaphore(INDIA_MOVERS_CONCURRENCY)
    throttled = asyncio.Event()
    async with httpx.AsyncClient(
        event_hooks={"request": [record_provider_request]}, timeout=timeout, headers=headers
    ) as client:

        async def one(name: str) -> dict[str, Any] | None:
            async with semaphore:
                if throttled.is_set():
                    return None
                response = await client.get(
                    f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(name + '.NS')}",
                    params={"range": "5d", "interval": "1d"},
                )
            if response.status_code == 429 or response.status_code >= 500:
                throttled.set()
                return None
            if response.status_code >= 400:
                return None
            results = (response.json().get("chart") or {}).get("result") or []
            return parse_nse_chart(results[0], name) if results else None

        tasks = [asyncio.create_task(one(name)) for name in NSE_LARGE_CAPS]
        done, pending = await asyncio.wait(tasks, timeout=INDIA_MOVERS_DEADLINE_SECONDS)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
    rows: list[dict[str, Any]] = []
    for task in done:
        if task.cancelled() or task.exception() is not None:
            continue
        row = task.result()
        if row:
            rows.append(row)
    if rows:
        movers = build_india_movers(rows)
        _LAST_GOOD_MOVERS.update(at=time.monotonic(), payload=movers)
        return movers
    # Nothing came back (usually the provider rate limit). Keep showing the last good list,
    # marked degraded and stamped with its own session time, instead of a blank card.
    reason = "rate_limited" if throttled.is_set() else "unavailable"
    last = _LAST_GOOD_MOVERS.get("payload")
    if last and time.monotonic() - _LAST_GOOD_MOVERS["at"] < INDIA_MOVERS_STALE_SECONDS:
        return {**last, "degraded": True, "stale_reason": reason}
    raise RuntimeError(f"india_movers_{reason}")


def _provider_state(outcome: object) -> str:
    return "failed" if isinstance(outcome, BaseException) else "ok"


async def load_india_home(
    days_back: int,
    fetch_status: Callable[[], Awaitable[dict[str, Any]]],
    fallback_status: Callable[[], dict[str, Any]],
) -> dict[str, Any]:
    """Fetch the three India modules together and report each one's provider state.

    Raises only when there is nothing at all to show, so a total outage is never cached
    as a healthy payload; a partial outage returns what loaded and says what did not.
    """
    quotes_out, news_out, status_out, movers_out = await asyncio.gather(
        fetch_india_quotes(),
        fetch_india_news(days_back),
        fetch_status(),
        fetch_india_movers(),
        return_exceptions=True,
    )
    if isinstance(quotes_out, BaseException) and isinstance(news_out, BaseException):
        raise quotes_out
    quotes = {} if isinstance(quotes_out, BaseException) else quotes_out
    news = [] if isinstance(news_out, BaseException) else news_out
    status_payload = fallback_status() if isinstance(status_out, BaseException) else status_out
    movers = None if isinstance(movers_out, BaseException) else movers_out
    sectors, sector_state = build_india_sectors(quotes)
    provider_status = {
        "india_quotes": _provider_state(quotes_out) if quotes else "failed",
        "india_sectors": sector_state if sector_state != "unavailable" else "failed",
        "india_news": _provider_state(news_out) if news else "partial",
        "market_status": "partial" if status_payload.get("degraded") else "ok",
        "india_movers": "failed"
        if movers is None
        else ("partial" if movers.get("degraded") else "ok"),
    }
    return {
        "overview": build_india_overview(quotes, status_payload),
        "sectors": sectors,
        "news": news,
        "movers": movers,
        "provider_status": provider_status,
    }


def assemble_india_payload(base: dict[str, Any], loaded: dict[str, Any]) -> dict[str, Any]:
    """Overlay the India modules on the shared v2 home skeleton.

    Movers stay empty and degraded: there is no quota-safe NSE/BSE gainers source, so the
    client hides that section for India rather than showing a US list.
    """
    provider_status = loaded["provider_status"]
    # Index quotes and the status row drive the whole strip, so only they mark the payload
    # stale. A thin news or sector fetch is reported in provider_status without greying
    # out healthy index levels.
    stale = provider_status["india_quotes"] != "ok" or provider_status["market_status"] != "ok"
    payload = dict(base)
    payload.pop("stale_reason", None)
    payload.update(
        {
            "market": "IN",
            "stale": stale,
            "provider_status": provider_status,
            "market_overview": loaded["overview"],
            "sector_rotation": loaded["sectors"],
            "news_tape": loaded["news"],
        }
    )
    if loaded.get("movers"):
        payload["movers"] = loaded["movers"]
    payload["meta"] = {
        **base.get("meta", {}),
        "market": "IN",
        "stale": stale,
        "provider_status": provider_status,
    }
    payload["meta"].pop("stale_reason", None)
    return payload

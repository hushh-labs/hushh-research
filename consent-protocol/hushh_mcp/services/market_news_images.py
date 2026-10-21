"""Attach article photos from fixed-host public metadata, without scraping articles."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from typing import Any
from urllib.parse import parse_qs, unquote_plus, urlsplit, urlunsplit

import httpx
from defusedxml import ElementTree as DefusedET

logger = logging.getLogger(__name__)
YAHOO_PUBLISHER_LOGO = "https://s.yimg.com/rz/stage/p/yahoo_finance_en-US_h_p_finance_2.png"
_UUID = re.compile(r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$", re.I)


def article_image_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        url = urlsplit(value.strip())
        if url.scheme != "https" or not url.hostname or url.username or url.password:
            return None
        if url.hostname == "s.yimg.com" and url.path == urlsplit(YAHOO_PUBLISHER_LOGO).path:
            return None
        return value.strip()
    except ValueError:
        return None


def _canonical_url(value: Any) -> str | None:
    try:
        url = urlsplit(str(value or ""))
        if url.scheme not in {"https", "http"} or not url.hostname or url.username or url.password:
            return None
        query = "&".join(
            part
            for part in url.query.split("&")
            if part
            and not unquote_plus(part.split("=", 1)[0]).lower().startswith("utm_")
            and unquote_plus(part.split("=", 1)[0]).lower() not in {".tsrc", "gclid", "fbclid"}
        )
        return urlunsplit((url.scheme, url.netloc.lower(), url.path, query, ""))
    except ValueError:
        return None


def _finnhub_article_id(value: Any) -> str | None:
    try:
        url = urlsplit(str(value or ""))
        if url.hostname != "finnhub.io" or url.path != "/api/news":
            return None
        article_id = (parse_qs(url.query).get("id") or [""])[0]
        return article_id if re.fullmatch(r"[a-f0-9]{64}", article_id) else None
    except ValueError:
        return None


def _thumbnail(row: dict[str, Any]) -> tuple[str, str] | None:
    thumbnail = row.get("thumbnail")
    if not isinstance(thumbnail, dict):
        return None
    resolutions = thumbnail.get("resolutions")
    candidates = []
    for resolution in resolutions if isinstance(resolutions, list) else []:
        if not isinstance(resolution, dict):
            continue
        image = article_image_url(resolution.get("url"))
        width = resolution.get("width")
        if image and isinstance(width, (int, float)) and width > 0:
            candidates.append((width, image))
    if not candidates:
        original = article_image_url(thumbnail.get("originalUrl"))
        return (original, original) if original else None
    candidates.sort()
    return candidates[-1][1], candidates[0][1]


def attach_article_images(
    articles: list[dict[str, Any]], metadata: list[dict[str, Any]], rss: str
) -> list[dict[str, Any]]:
    """Join exact article URLs/UUIDs and Finnhub's publisher-URL digest; never titles."""
    by_url: dict[str, tuple[str, str]] = {}
    by_uuid: dict[str, tuple[str, str]] = {}
    by_digest: dict[str, tuple[str, str]] = {}
    for row in metadata:
        if not isinstance(row, dict):
            continue
        image = _thumbnail(row)
        if not image:
            continue
        url = _canonical_url(row.get("link"))
        if url:
            by_url[url] = image
            by_digest[hashlib.sha256(url.encode()).hexdigest()] = image
            by_digest[hashlib.sha256(str(row["link"]).encode()).hexdigest()] = image
        uuid = str(row.get("uuid") or "")
        if _UUID.fullmatch(uuid):
            by_uuid[uuid] = image
    try:
        items = DefusedET.fromstring(rss).findall(".//item") if rss.strip() else []
    except (DefusedET.ParseError, ValueError):
        items = []
    for item in items:
        image = by_uuid.get((item.findtext("guid") or "").strip())
        url = _canonical_url(item.findtext("link"))
        if image and url:
            by_url[url] = image
            by_digest[hashlib.sha256(url.encode()).hexdigest()] = image
            by_digest[hashlib.sha256(str(item.findtext("link")).encode()).hexdigest()] = image
    result = []
    for row in articles:
        if article_image_url(row.get("image_url") or row.get("image") or row.get("urlToImage")):
            result.append(row)
            continue
        image = by_url.get(_canonical_url(row.get("url")) or "")
        image = image or by_digest.get(_finnhub_article_id(row.get("url")) or "")
        image = image or by_uuid.get(str(row.get("uuid") or ""))
        result.append(
            {
                **row,
                "image_url": image[0] if image else None,
                "image_thumbnail_url": image[1] if image else None,
            }
        )
    return result


async def enrich_market_news_images(
    ticker: str, articles: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    missing = [
        row
        for row in articles
        if not article_image_url(row.get("image_url") or row.get("image") or row.get("urlToImage"))
    ]
    # Other provider feeds retain their own images. Only resolve the Yahoo/Finnhub
    # identity bridge for which structured metadata supplies an exact join.
    if not any(
        _finnhub_article_id(row.get("url")) or "finance.yahoo.com/" in str(row.get("url") or "")
        for row in missing
    ):
        return articles
    try:
        async with httpx.AsyncClient(
            timeout=4.0,
            follow_redirects=False,
            headers={"User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)"},
        ) as client:
            search, rss = await asyncio.gather(
                client.get(
                    "https://query1.finance.yahoo.com/v1/finance/search",
                    params={"q": ticker, "quotesCount": 0, "newsCount": 20},
                ),
                client.get(
                    "https://feeds.finance.yahoo.com/rss/2.0/headline",
                    params={"s": ticker, "region": "US", "lang": "en-US"},
                ),
                return_exceptions=True,
            )
            if isinstance(search, BaseException):
                return articles
            search.raise_for_status()
            rows = search.json().get("news") or []
            rss_text = (
                rss.text if isinstance(rss, httpx.Response) and rss.status_code == 200 else ""
            )
            return attach_article_images(articles, rows[:20], rss_text)
    except Exception:
        logger.debug("Market article image metadata unavailable for %s", ticker)
        return articles

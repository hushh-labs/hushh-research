"""Contract tests for cache-backed, cursor-paginated Market News."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from api.routes.kai import market_insights


def test_market_news_round_robin_deduplicates_tracking_urls_and_headlines():
    rows = [
        {
            "symbol": "AMZN",
            "title": f"Amazon update {index}",
            "url": f"https://example.com/amzn/{index}?utm_source=feed",
            "published_at": f"2026-07-19T00:0{index}:00Z",
        }
        for index in range(4)
    ]
    rows.extend(
        [
            {
                "symbol": "MSFT",
                "title": "Microsoft update",
                "url": "https://example.com/msft?gclid=tracking",
                "published_at": "2026-07-19T00:05:00Z",
            },
            {
                "symbol": "MSFT",
                "title": "  microsoft   update ",
                "url": "https://mirror.example.com/story",
                "published_at": "2026-07-19T00:04:00Z",
            },
        ]
    )

    selected, duplicate_count = market_insights._round_robin_market_news_rows(
        rows,
        symbols=["AMZN", "MSFT"],
        limit=6,
        per_symbol_cap=2,
    )

    assert [row["symbol"] for row in selected] == ["MSFT", "AMZN", "AMZN"]
    assert duplicate_count == 1
    msft_row = next(row for row in selected if row["symbol"] == "MSFT")
    amzn_row = next(row for row in selected if row["symbol"] == "AMZN")
    assert "gclid" not in msft_row["url"]
    assert "utm_source" not in amzn_row["url"]


@pytest.mark.asyncio
async def test_market_news_later_cursor_pages_slice_the_cached_bundle(monkeypatch):
    provider_calls: list[str] = []
    cached_bundle: dict[str, object] | None = None

    async def _fake_fetch_market_news(symbol, _user_id, _consent_token, *, days_back):
        provider_calls.append(f"{symbol}:{days_back}")
        return [
            {
                "title": f"{symbol} headline {index}",
                "description": f"Summary {index}",
                "url": f"https://example.com/{symbol}/{index}",
                "publishedAt": f"2026-07-19T00:0{index}:00Z",
                "source": {"name": "Test wire"},
                "provider": "test",
            }
            for index in range(3)
        ]

    async def _cached_public_module(*, fetcher, **_kwargs):
        nonlocal cached_bundle
        if cached_bundle is None:
            cached_bundle = await fetcher()
            return cached_bundle, False, 0, "live", False
        return cached_bundle, False, 1, "memory", True

    monkeypatch.setattr(market_insights, "fetch_market_news", _fake_fetch_market_news)
    monkeypatch.setattr(
        market_insights,
        "_get_or_refresh_public_module",
        _cached_public_module,
    )

    first = await market_insights._get_market_news_feed_page(
        user_id="user_123",
        symbols=["AAPL"],
        days_back=7,
        cursor=None,
        limit=2,
        consent_token=None,
    )
    second = await market_insights._get_market_news_feed_page(
        user_id="user_123",
        symbols=["AAPL"],
        days_back=7,
        cursor=first["next_cursor"],
        limit=2,
        consent_token=None,
    )

    assert provider_calls == ["AAPL:7"]
    assert [row["title"] for row in first["items"]] != [row["title"] for row in second["items"]]
    assert first["snapshot_id"] == second["snapshot_id"]
    assert first["next_cursor"]
    assert second["cache"]["hit"] is True


@pytest.mark.asyncio
async def test_market_news_rejects_a_cursor_for_a_different_snapshot(monkeypatch):
    async def _cached_public_module(**_kwargs):
        return (
            {
                "rows": [
                    {
                        "symbol": "AAPL",
                        "title": "Current headline",
                        "url": "https://example.com/current",
                        "published_at": "2026-07-19T00:00:00Z",
                        "source_name": "Test wire",
                        "provider": "test",
                        "degraded": False,
                    }
                ],
                "provider_status": {"news:AAPL": "ok"},
                "generated_at": "2026-07-19T00:00:00Z",
            },
            False,
            0,
            "memory",
            True,
        )

    monkeypatch.setattr(
        market_insights,
        "_get_or_refresh_public_module",
        _cached_public_module,
    )

    with pytest.raises(HTTPException) as raised:
        await market_insights._get_market_news_feed_page(
            user_id="user_123",
            symbols=["AAPL"],
            days_back=7,
            cursor=market_insights._encode_market_news_cursor("outdated", 0),
            limit=2,
            consent_token=None,
        )

    assert raised.value.status_code == 409

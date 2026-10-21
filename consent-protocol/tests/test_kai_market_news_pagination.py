"""Contract tests for cache-backed, cursor-paginated Market News."""

from __future__ import annotations

import hashlib

import pytest
from fastapi import HTTPException

from api.routes.kai import market_insights
from hushh_mcp.services.market_news_images import YAHOO_PUBLISHER_LOGO, attach_article_images


def test_news_images_join_publisher_identity_without_guessing_by_headline():
    publisher = "https://www.thestreet.com/markets/example-story"
    digest = hashlib.sha256(publisher.encode()).hexdigest()
    uuid = "2cd8692a-04e0-3742-a8e8-e2380397c93d"
    metadata = [
        {
            "uuid": uuid,
            "link": "https://finance.yahoo.com/news/wrapped.html",
            "thumbnail": {
                "resolutions": [
                    {"url": "https://media.zenfs.com/photo.jpg", "width": 1200},
                    {"url": "https://s.yimg.com/photo-small.jpg", "width": 140},
                ]
            },
        }
    ]
    rss = f"<rss><channel><image><url>{YAHOO_PUBLISHER_LOGO}</url></image><item><guid>{uuid}</guid><link>{publisher}?.tsrc=rss</link></item></channel></rss>"
    selected = [
        {
            "title": "Same title",
            "url": f"https://finnhub.io/api/news?id={digest}",
            "provider": "finnhub",
            "image_url": YAHOO_PUBLISHER_LOGO,
        },
        {"title": "Same title", "url": "https://example.test/unrelated", "image_url": None},
        {"title": "Keep photo", "url": publisher, "image_url": "https://example.test/original.jpg"},
    ]
    rows = attach_article_images(selected, metadata, rss)
    assert rows[0]["image_url"] == "https://media.zenfs.com/photo.jpg"
    assert rows[0]["image_thumbnail_url"] == "https://s.yimg.com/photo-small.jpg"
    assert rows[0]["url"] == selected[0]["url"]
    assert rows[0]["provider"] == "finnhub"
    assert rows[1]["image_url"] is None
    assert rows[2] == selected[2]
    assert attach_article_images(selected[:1], [], rss)[0]["image_url"] is None


def test_article_image_join_keeps_identity_bearing_query_parameters():
    first = "https://publisher.test/article?id=1"
    second = "https://publisher.test/article?id=2"
    digest = hashlib.sha256(first.encode()).hexdigest()
    metadata = [
        {
            "link": first,
            "thumbnail": {"resolutions": [{"width": 800, "url": "https://publisher.test/one.jpg"}]},
        }
    ]
    rows = attach_article_images(
        [
            {"url": first + "&utm_source=feed"},
            {"url": second},
            {"url": f"https://finnhub.io/api/news?id={digest}"},
        ],
        metadata,
        "",
    )
    assert rows[0]["image_url"] == "https://publisher.test/one.jpg"
    assert rows[1]["image_url"] is None
    assert rows[2]["image_url"] == "https://publisher.test/one.jpg"


def test_optional_news_image_never_breaks_an_article_or_accepts_unsafe_urls():
    assert market_insights._market_news_image_url({"image_url": "https://[invalid"}) is None
    assert market_insights._market_news_image_url({"image_url": "javascript:alert(1)"}) is None
    assert (
        market_insights._market_news_image_url({"image_url": "https://example.test/news.jpg"})
        == "https://example.test/news.jpg"
    )
    assert (
        market_insights._market_news_image_url(
            {"image_url": YAHOO_PUBLISHER_LOGO, "image": "https://example.test/news.jpg"}
        )
        == "https://example.test/news.jpg"
    )


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
                "image_url": f"https://example.com/{symbol}/{index}.jpg",
                "image_thumbnail_url": f"https://example.com/{symbol}/{index}-small.jpg",
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
    assert first["items"][0]["image_thumbnail_url"].endswith("-small.jpg")


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

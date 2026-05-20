from datetime import datetime, timezone
from decimal import Decimal

from hushh_mcp.services.market_cache_store import MarketCacheStoreService


def test_normalize_json_value_serializes_nested_non_json_payloads():
    value = {
        "generated_at": datetime(2026, 3, 27, 12, 0, tzinfo=timezone.utc),
        "rows": [
            {
                "price": Decimal("123.45"),
                "bad_number": float("inf"),
                "source_tags": {"alpha", "beta"},
            }
        ],
    }

    normalized = MarketCacheStoreService._normalize_json_value(value)

    assert sorted(normalized["rows"][0]["source_tags"]) == ["alpha", "beta"]


def test_normalize_json_value_handles_nan():
    value = {"score": float("nan")}

    normalized = MarketCacheStoreService._normalize_json_value(value)

    assert normalized["score"] is None
"""Tests that Kai data fetchers stamp timezone-aware UTC times.

operons/kai/fetchers.py generated freshness and fallback timestamps with
datetime.utcnow(). That returns a naive datetime, so the fetched_at and
publishedAt strings it produced carried no UTC marker, and date range bounds
computed from it depended on the host timezone. The fix uses
datetime.now(timezone.utc) at every site.

These tests drive the real pure parser _parse_google_news_rss, which is the
function behind the Google News fetch path consumed by the Kai sentiment and
market insight flows, and assert that the publishedAt fallback it emits is a
timezone-aware UTC ISO 8601 string. They also confirm a supplied pubDate is
preserved and that the module no longer calls the deprecated utcnow.

Reachable from _fetch_google_news_rss, which calls _parse_google_news_rss on
the fetched RSS body.
"""

from __future__ import annotations

from datetime import datetime

from hushh_mcp.operons.kai import fetchers
from hushh_mcp.operons.kai.fetchers import _parse_google_news_rss

_RSS_WITHOUT_PUBDATE = """<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Example headline for AAPL</title>
      <link>https://example.com/aapl-news</link>
      <source>Example Wire</source>
    </item>
  </channel>
</rss>
"""

_RSS_WITH_PUBDATE = """<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Dated headline for AAPL</title>
      <link>https://example.com/aapl-dated</link>
      <pubDate>Mon, 01 Jun 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>
"""


def test_published_at_fallback_is_timezone_aware_utc():
    items = _parse_google_news_rss(_RSS_WITHOUT_PUBDATE, "AAPL")

    assert len(items) == 1
    published_at = items[0]["publishedAt"]

    # The fallback value must be a timezone-aware UTC ISO 8601 string.
    assert published_at.endswith("+00:00")
    parsed = datetime.fromisoformat(published_at)
    assert parsed.tzinfo is not None
    assert parsed.utcoffset().total_seconds() == 0


def test_supplied_pubdate_is_preserved():
    items = _parse_google_news_rss(_RSS_WITH_PUBDATE, "AAPL")

    assert len(items) == 1
    assert items[0]["publishedAt"] == "Mon, 01 Jun 2026 10:00:00 GMT"


def test_fetchers_module_has_no_deprecated_utcnow():
    import inspect

    source = inspect.getsource(fetchers)
    assert "datetime.utcnow(" not in source

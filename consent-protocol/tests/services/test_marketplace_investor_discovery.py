from __future__ import annotations

import asyncio
from datetime import date

from hushh_mcp.services.ria_iam_service import RIAIAMService


class _FakeMarketplaceConn:
    def __init__(self) -> None:
        self.fetch_calls: list[tuple[str, tuple[object, ...]]] = []
        self.closed = False

    async def fetch(self, query: str, *args: object) -> list[dict[str, object]]:
        self.fetch_calls.append((query, args))
        if "FROM actor_profiles" in query:
            return [
                {
                    "user_id": "hushh_investor_1",
                    "display_name": "Avery Stone",
                    "headline": "Founder liquidity planning",
                    "location_hint": "Austin, TX",
                    "strategy_summary": "Opted-in Hushh investor profile.",
                    "is_test_profile": False,
                }
            ]
        if "FROM investor_profiles" in query:
            return [
                {
                    "id": 42,
                    "name": "Morgan Public",
                    "cik": "0000123456",
                    "firm": "Public Capital Partners",
                    "title": "Managing Partner",
                    "investor_type": "fund_manager",
                    "location_hint": "Kirkland, WA 98033",
                    "business_address": (
                        '{"street1":"2365 CARILLON POINT","city":"KIRKLAND",'
                        '"state":"WA","zip":"98033"}'
                    ),
                    "aum_billions": 12.4,
                    "investment_style": ["long_term", "technology"],
                    "risk_tolerance": None,
                    "time_horizon": None,
                    "portfolio_turnover": None,
                    "biography": "Public investor profile assembled from public filings.",
                    "is_insider": False,
                    "insider_company_ticker": None,
                    "data_sources": ["SEC EDGAR", "Form 13F"],
                    "source_urls": ["https://data.sec.gov/submissions/CIK0000123456.json"],
                    "evidence": (
                        '{"confidence":"official_sec_record",'
                        '"latest_known_13f_accession":"0000123456-26-000001"}'
                    ),
                    "last_13f_date": date(2026, 3, 31),
                    "last_form4_date": None,
                    "updated_at": date(2026, 4, 15),
                }
            ]
        return []

    async def close(self) -> None:
        self.closed = True


def test_marketplace_investors_merge_hushh_users_and_public_sec_profiles(monkeypatch):
    async def _run() -> None:
        service = RIAIAMService()
        conn = _FakeMarketplaceConn()

        async def _conn():
            return conn

        async def _schema_ready(_conn_arg):
            return None

        monkeypatch.setattr(service, "_conn", _conn)
        monkeypatch.setattr(service, "_ensure_iam_schema_ready", _schema_ready)

        items = await service.search_marketplace_investors(query=None, limit=5)

        assert conn.closed is True
        assert len(items) == 2

        hushh_item = items[0]
        assert hushh_item["id"] == "hushh_investor_1"
        assert hushh_item["source_type"] == "hushh_user"
        assert hushh_item["user_id"] == "hushh_investor_1"
        assert hushh_item["connectable"] is True

        public_item = items[1]
        assert public_item["id"] == "public_sec:42"
        assert public_item["source_type"] == "public_sec"
        assert public_item["user_id"] is None
        assert public_item["public_profile_id"] == "42"
        assert public_item["connectable"] is False
        assert public_item["headline"] == "Managing Partner at Public Capital Partners"
        assert public_item["location_hint"] == "Kirkland, WA 98033"
        assert public_item["evidence"]["confidence"] == "official_public_records"
        assert public_item["evidence"]["forms"] == [{"form": "13F", "last_filed_at": "2026-03-31"}]
        assert public_item["evidence"]["source_urls"] == [
            "https://data.sec.gov/submissions/CIK0000123456.json",
            "https://www.sec.gov/edgar/browse/?CIK=0000123456",
        ]
        assert public_item["evidence"]["business_address"]["zip"] == "98033"
        assert (
            public_item["evidence"]["metadata"]["latest_known_13f_accession"]
            == "0000123456-26-000001"
        )

    asyncio.run(_run())

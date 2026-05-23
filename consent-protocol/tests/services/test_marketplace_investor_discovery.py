from __future__ import annotations

import asyncio
import re
import uuid
from datetime import date
from pathlib import Path

from hushh_mcp.services.ria_iam_service import RIAIAMService


class _FakeMarketplaceConn:
    def __init__(self) -> None:
        self.fetch_calls: list[tuple[str, tuple[object, ...]]] = []
        self.closed = False

    async def fetch(self, query: str, *args: object) -> list[dict[str, object]]:
        self.fetch_calls.append((query, args))
        if "FROM actor_profiles" in query:
            assert "qualified_investor_status" in query
            assert "ANY($5::text[])" in query
            assert "($3::text IS NULL" in query
            assert "$4::boolean = FALSE" in query
            assert "LIMIT $2::integer" in query
            assert args[1] == 5
            assert args[3] is True
            assert args[4] == []
            return [
                {
                    "user_id": "hushh_investor_1",
                    "display_name": "Avery Stone",
                    "headline": "Qualified founder liquidity planning",
                    "location_hint": "Austin, TX",
                    "strategy_summary": "Qualified Hushh investor profile.",
                    "metadata": {
                        "admission_status": "qualified",
                        "curation_tier": "qualified",
                        "quality_score": 91,
                    },
                    "admission_status": "qualified",
                    "curation_tier": "qualified",
                    "quality_score": 91,
                    "is_test_profile": False,
                }
            ]
        if "FROM investor_profiles" in query:
            assert "marketplace_eligible = TRUE" in query
            assert "admission_status = 'qualified'" in query
            assert args[2] == ["showcase", "qualified"]
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
                    "marketplace_eligible": True,
                    "admission_status": "qualified",
                    "curation_tier": "showcase",
                    "quality_score": 95,
                    "curation_reason": "Official SEC-backed profile meets the RIA deck bar.",
                    "updated_at": date(2026, 4, 15),
                }
            ]
        return []

    async def close(self) -> None:
        self.closed = True


class _FakeTransaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):  # noqa: ANN001
        return False


class _FakeMarketplaceActionConn:
    def __init__(self) -> None:
        self.fetchrow_calls: list[tuple[str, tuple[object, ...]]] = []
        self.closed = False

    def transaction(self) -> _FakeTransaction:
        return _FakeTransaction()

    async def fetchrow(self, query: str, *args: object) -> dict[str, object] | None:
        self.fetchrow_calls.append((query, args))
        if "FROM investor_profiles" in query:
            assert args == (42,)
            return {
                "id": 42,
                "name": "Morgan Public",
                "cik": "0000123456",
                "firm": "Public Capital Partners",
                "title": "Managing Partner",
                "investor_type": "fund_manager",
                "location_hint": "Kirkland, WA 98033",
                "business_address": (
                    '{"street1":"2365 CARILLON POINT","city":"KIRKLAND","state":"WA","zip":"98033"}'
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
                "evidence": '{"confidence":"official_sec_record"}',
                "last_13f_date": date(2026, 3, 31),
                "last_form4_date": None,
                "marketplace_eligible": True,
                "admission_status": "qualified",
                "curation_tier": "showcase",
                "quality_score": 95,
                "curation_reason": "Official SEC-backed profile meets the RIA deck bar.",
                "updated_at": date(2026, 4, 15),
            }
        if "INSERT INTO marketplace_investor_actions" in query:
            assert args[0] == "ria_user_1"
            assert args[2] == "public_sec"
            assert args[3] == "public_sec:42"
            assert args[4] is None
            assert args[5] == 42
            assert args[6] == "shortlist"
            assert args[7] == "shortlisted"
            return {
                "id": uuid.UUID("11111111-1111-1111-1111-111111111111"),
                "actor_user_id": "ria_user_1",
                "ria_profile_id": uuid.UUID("22222222-2222-2222-2222-222222222222"),
                "source_type": "public_sec",
                "target_key": "public_sec:42",
                "target_user_id": None,
                "public_profile_id": 42,
                "action": "shortlist",
                "status": "shortlisted",
                "target_snapshot": args[8],
                "metadata": args[9],
                "created_at": date(2026, 5, 18),
                "updated_at": date(2026, 5, 18),
            }
        return None

    async def close(self) -> None:
        self.closed = True


class _FakeMarketplaceDeckConn:
    def __init__(self) -> None:
        self.closed = False

    async def fetch(self, query: str, *args: object) -> list[dict[str, object]]:
        if "FROM marketplace_investor_actions" in query:
            return [
                {"target_key": "public_sec:42"},
                {"target_key": "hushh_user:handled_investor"},
            ]
        if "FROM actor_profiles" in query:
            assert "NOT (('hushh_user:' || ap.user_id) = ANY" in query
            assert "ANY($5::text[])" in query
            assert "LIMIT $2::integer" in query
            assert args[1] == 12
            assert args[3] is True
            assert "hushh_user:handled_investor" in args[-1]
            return []
        if "FROM investor_profiles" in query:
            assert "NOT (('public_sec:' || id::text) = ANY" in query
            assert "public_sec:42" in args[-1]
            return [
                {
                    "id": 43,
                    "name": "Unseen Public",
                    "cik": "0000123457",
                    "firm": "Unseen Public Capital",
                    "title": "Public institutional filer",
                    "investor_type": "institutional_investor",
                    "location_hint": "Seattle, WA",
                    "business_address": '{"city":"SEATTLE","state":"WA"}',
                    "aum_billions": None,
                    "investment_style": ["public_13f"],
                    "risk_tolerance": None,
                    "time_horizon": None,
                    "portfolio_turnover": None,
                    "biography": "Official SEC-backed unseen public investor profile.",
                    "is_insider": False,
                    "insider_company_ticker": None,
                    "data_sources": ["SEC EDGAR"],
                    "source_urls": ["https://data.sec.gov/submissions/CIK0000123457.json"],
                    "evidence": '{"confidence":"official_sec_record"}',
                    "last_13f_date": date(2026, 3, 31),
                    "last_form4_date": None,
                    "marketplace_eligible": True,
                    "admission_status": "qualified",
                    "curation_tier": "qualified",
                    "quality_score": 88,
                    "curation_reason": "Qualified public SEC filer.",
                    "updated_at": date(2026, 4, 15),
                }
            ]
        return []

    async def fetchval(self, query: str, *args: object) -> int:
        assert "public_sec:42" in args[-1]
        if "FROM actor_profiles" in query:
            assert "ANY($4::text[])" in query
            assert "($2::text IS NULL" in query
            assert "$3::boolean = FALSE" in query
            assert len(args) == 4
            return 0
        if "FROM investor_profiles" in query:
            return 1
        return 0

    async def close(self) -> None:
        self.closed = True


def test_marketplace_investors_returns_qualified_hushh_and_public_sec_profiles(monkeypatch):
    async def _run() -> None:
        service = RIAIAMService()
        conn = _FakeMarketplaceConn()

        async def _conn():
            return conn

        async def _schema_ready(_conn_arg):
            return None

        monkeypatch.setattr(service, "_conn", _conn)
        monkeypatch.setattr(service, "_ensure_iam_schema_ready", _schema_ready)

        items = await service.search_marketplace_investors(
            query=None,
            limit=5,
            persona="ria",
            deck="qualified",
        )

        assert conn.closed is True
        assert len(items) == 2

        hushh_item = items[0]
        assert hushh_item["id"] == "hushh_investor_1"
        assert hushh_item["source_type"] == "hushh_user"
        assert hushh_item["user_id"] == "hushh_investor_1"
        assert hushh_item["connectable"] is True
        assert hushh_item["admission_status"] == "qualified"
        assert hushh_item["curation_tier"] == "qualified"
        assert hushh_item["quality_score"] == 91
        assert hushh_item["actions"] == ["connect", "view_more"]

        public_item = items[1]
        assert public_item["id"] == "public_sec:42"
        assert public_item["source_type"] == "public_sec"
        assert public_item["user_id"] is None
        assert public_item["public_profile_id"] == "42"
        assert public_item["connectable"] is False
        assert public_item["admission_status"] == "qualified"
        assert public_item["curation_tier"] == "showcase"
        assert public_item["quality_score"] == 95
        assert public_item["actions"] == ["shortlist", "view_more"]
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


def test_marketplace_investor_deck_excludes_handled_profiles(monkeypatch):
    async def _run() -> None:
        service = RIAIAMService()
        conn = _FakeMarketplaceDeckConn()

        async def _conn():
            return conn

        async def _noop(*_args, **_kwargs):  # noqa: ANN002, ANN003
            return None

        async def _ria(_conn_arg, user_id: str):  # noqa: ANN001
            assert user_id == "ria_user_1"
            return {"id": uuid.UUID("22222222-2222-2222-2222-222222222222")}

        monkeypatch.setattr(service, "_conn", _conn)
        monkeypatch.setattr(service, "_ensure_iam_schema_ready", _noop)
        monkeypatch.setattr(service, "_ensure_actor_profile_row", _noop)
        monkeypatch.setattr(service, "_get_ria_profile_by_user", _ria)

        deck = await service.search_marketplace_investor_deck(
            "ria_user_1",
            query=None,
            limit=12,
            persona="ria",
            deck="qualified",
        )

        assert conn.closed is True
        assert deck["handled_count"] == 2
        assert deck["remaining_count"] == 1
        assert deck["deck_complete"] is False
        assert [item["id"] for item in deck["items"]] == ["public_sec:43"]

    asyncio.run(_run())


def test_marketplace_public_investor_seed_count_is_qualified_deck_sized():
    migration_path = (
        Path(__file__).resolve().parents[2]
        / "db"
        / "migrations"
        / "057_marketplace_investor_admission.sql"
    )
    text = migration_path.read_text(encoding="utf-8")
    seeded_ciks = set(re.findall(r"^\s*'(?P<cik>\d{10})',$", text, flags=re.MULTILINE))

    assert 20 <= len(seeded_ciks) <= 24
    assert "0001166559" in seeded_ciks


def test_marketplace_public_sec_shortlist_persists_to_action_table(monkeypatch):
    async def _run() -> None:
        service = RIAIAMService()
        conn = _FakeMarketplaceActionConn()

        async def _conn():
            return conn

        async def _noop(*_args, **_kwargs):  # noqa: ANN002, ANN003
            return None

        async def _ria(_conn_arg, user_id: str):  # noqa: ANN001
            assert user_id == "ria_user_1"
            return {"id": uuid.UUID("22222222-2222-2222-2222-222222222222")}

        monkeypatch.setattr(service, "_conn", _conn)
        monkeypatch.setattr(service, "_ensure_iam_schema_ready", _noop)
        monkeypatch.setattr(service, "_ensure_actor_profile_row", _noop)
        monkeypatch.setattr(service, "_get_ria_profile_by_user", _ria)

        action = await service.record_marketplace_investor_action(
            "ria_user_1",
            action="shortlist",
            source_type="public_sec",
            public_profile_id="42",
            metadata={"gesture": "right_swipe"},
        )

        assert conn.closed is True
        assert action["actor_user_id"] == "ria_user_1"
        assert action["ria_profile_id"] == "22222222-2222-2222-2222-222222222222"
        assert action["source_type"] == "public_sec"
        assert action["target_key"] == "public_sec:42"
        assert action["public_profile_id"] == "42"
        assert action["action"] == "shortlist"
        assert action["status"] == "shortlisted"
        assert action["profile"]["display_name"] == "Morgan Public"
        assert action["profile"]["connectable"] is False
        assert action["metadata"]["gesture"] == "right_swipe"

    asyncio.run(_run())

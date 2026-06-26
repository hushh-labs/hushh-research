"""
Proof that POST /api/investors/bulk batches DB writes instead of issuing
one round-trip per investor.

Canonical attach points:
  api.routes.investors.bulk_create_investors -> POST /api/investors/bulk
  hushh_mcp.services.investor_db.InvestorDBService.bulk_upsert_investors

Before this fix, bulk_create_investors looped over the request list and
called create_investor (which calls InvestorDBService.upsert_investor) once
per item, so an N-item batch was N sequential database round-trips.
bulk_upsert_investors groups records by their exact field shape (since
PostgREST infers a bulk insert/upsert's column set from the union of keys
in the request body) and issues one .upsert()/.insert() call per group, so
a uniformly-shaped batch collapses to a single round-trip.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.investors import router
from hushh_mcp.services.investor_db import InvestorDBService

_UID = "test-firebase-uid"


@pytest.fixture()
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_firebase_auth] = lambda: _UID
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


def test_bulk_create_calls_batched_upsert_exactly_once(client: TestClient) -> None:
    """A uniformly-shaped 3-investor batch issues exactly one DB call."""
    payload = [{"name": f"Investor {i}"} for i in range(3)]
    mock_upsert = AsyncMock(
        return_value=[{"id": i, "name": f"Investor {i}"} for i in range(3)]
    )

    with patch.object(InvestorDBService, "bulk_upsert_investors", new=mock_upsert):
        resp = client.post("/api/investors/bulk", json=payload)

    assert resp.status_code == 201
    assert resp.json()["created"] == 3
    mock_upsert.assert_called_once()
    (records,), _kwargs = mock_upsert.call_args
    assert len(records) == 3


class _FakeResponse:
    def __init__(self, data: list[dict]) -> None:
        self.data = data


def test_bulk_upsert_investors_issues_one_call_for_uniform_batch() -> None:
    """Service-level proof: same-shape records collapse to a single .upsert() call."""
    service = InvestorDBService()
    fake_table = MagicMock()
    fake_table.upsert.return_value.execute.return_value = _FakeResponse(
        [{"id": 1, "name": "A"}, {"id": 2, "name": "B"}]
    )
    fake_supabase = MagicMock()
    fake_supabase.table.return_value = fake_table

    with patch.object(InvestorDBService, "_get_supabase", return_value=fake_supabase):
        import asyncio

        records = [
            {"name": "A", "cik": "1111"},
            {"name": "B", "cik": "2222"},
        ]
        result = asyncio.get_event_loop().run_until_complete(
            service.bulk_upsert_investors(records)
        )

    assert fake_table.upsert.call_count == 1
    assert len(result) == 2


def test_bulk_upsert_investors_groups_by_shape() -> None:
    """Records with different field shapes get separate calls, not one per record."""
    service = InvestorDBService()
    fake_table = MagicMock()
    fake_table.upsert.return_value.execute.return_value = _FakeResponse([{"id": 1}])
    fake_table.insert.return_value.execute.return_value = _FakeResponse([{"id": 2}])
    fake_supabase = MagicMock()
    fake_supabase.table.return_value = fake_table

    with patch.object(InvestorDBService, "_get_supabase", return_value=fake_supabase):
        import asyncio

        records = [
            {"name": "Has CIK", "cik": "1111"},
            {"name": "No CIK"},
        ]
        result = asyncio.get_event_loop().run_until_complete(
            service.bulk_upsert_investors(records)
        )

    assert fake_table.upsert.call_count == 1
    assert fake_table.insert.call_count == 1
    assert len(result) == 2


def test_bulk_upsert_investors_empty_list_makes_no_db_call() -> None:
    service = InvestorDBService()
    with patch.object(InvestorDBService, "_get_supabase") as mock_get_supabase:
        import asyncio

        result = asyncio.get_event_loop().run_until_complete(
            service.bulk_upsert_investors([])
        )

    mock_get_supabase.assert_not_called()
    assert result == []

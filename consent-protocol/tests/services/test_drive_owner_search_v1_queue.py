"""The V1 queue only handles server-planned statement searches."""

from types import SimpleNamespace
from unittest.mock import ANY, AsyncMock
from uuid import uuid4

import pytest

from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_owner_search_worker import DriveOwnerSearchWorker
from hushh_mcp.services.drive_request_bulk_service import _deterministic_statement_plan


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("authority_mode", "route", "plan_matches", "marked"),
    [
        ("owner", None, True, True),
        ("trusted_auto", None, True, True),
        ("agent_package", None, True, False),
        ("owner", {"kind": "index", "index_snapshot": {}}, True, False),
        ("owner", None, False, False),
    ],
)
async def test_request_search_marks_only_canonical_provider_statement_plan(
    monkeypatch, authority_mode, route, plan_matches, marked
):
    purpose = {
        "purpose": "I need all Schwab brokerage statements from 2026",
        "periodStart": "2026-09-01",
        "periodEnd": "2026-10-09",
    }
    plan = _deterministic_statement_plan(purpose).model_dump(mode="json")
    if not plan_matches:
        plan = {**plan, "file_kind": "any"}
    store = SimpleNamespace(
        clear_legacy_completed_request=AsyncMock(return_value=False),
        by_client=AsyncMock(return_value=None),
        create=AsyncMock(return_value=({"jobId": str(uuid4()), "status": "queued"}, True)),
        align_request_expiry=AsyncMock(),
    )
    service = DriveOwnerSearchService(store=store)
    service.run_one = AsyncMock(return_value="queued")
    service.status = AsyncMock(return_value={"status": "queued"})
    wake = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.drive_owner_search_service.wake_drive_work", wake)

    await service.create_for_request(
        user_id="owner",
        request_id=str(uuid4()),
        request_revision=1,
        purpose=purpose,
        plan=plan,
        require_current=AsyncMock(),
        authority_mode=authority_mode,
        **({"evidence_route": route} if route is not None else {}),
    )

    assert store.create.await_args.kwargs["v1_statement_search"] is marked
    wake.assert_awaited_once_with("v1" if marked else "suggestions")


@pytest.mark.asyncio
async def test_v1_worker_limits_request_preparation_to_v1(monkeypatch):
    job_id = str(uuid4())
    store = SimpleNamespace(
        due=AsyncMock(return_value=[{"user_id": "owner", "job_id": job_id}]),
        status=AsyncMock(return_value={"errorCode": None}),
    )
    service = SimpleNamespace(store=store, run_one=AsyncMock(return_value="queued"))
    trusted_auto = SimpleNamespace(
        continue_batches=AsyncMock(return_value=0),
        start_pending=AsyncMock(return_value={"started": 0, "deferred": 0}),
        search_authority_for_job=AsyncMock(),
        after_search_page=AsyncMock(),
        after_search_slice=AsyncMock(),
    )
    wake = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.drive_owner_search_worker.wake_drive_work", wake)

    result = await DriveOwnerSearchWorker(service, trusted_auto=trusted_auto).run(v1_only=True)

    assert result["outcomes"] == {"queued": 1, "unavailable": 0}
    store.due.assert_awaited_once_with(limit=1, v1_only=True)
    service.run_one.assert_awaited_once()
    assert "after_page" not in service.run_one.await_args.kwargs
    assert "require_current" not in service.run_one.await_args.kwargs
    trusted_auto.continue_batches.assert_awaited_once_with(max_jobs=1, v1_only=True)
    trusted_auto.start_pending.assert_awaited_once_with(max_jobs=1, deadline_at=ANY, v1_only=True)
    trusted_auto.search_authority_for_job.assert_not_awaited()
    trusted_auto.after_search_page.assert_not_awaited()
    trusted_auto.after_search_slice.assert_not_awaited()
    wake.assert_awaited_once_with("v1")

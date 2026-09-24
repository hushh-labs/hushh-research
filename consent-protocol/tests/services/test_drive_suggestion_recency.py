"""Recent Drive requests use A's live metadata and existing private review."""

import json
from datetime import UTC, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from pydantic import ValidationError

from hushh_mcp.services import drive_suggestion_service as module
from hushh_mcp.services.drive_suggestion_service import DriveSuggestionService, LiveSearchPlan


def test_live_search_plan_accepts_bounded_date_only_and_uses_one_utc_instant():
    plan = LiveSearchPlan.model_validate({"relative_days": 2, "time_intent": "file_activity"})
    now = datetime(2026, 9, 24, 20, 30, tzinfo=timezone(timedelta(hours=5, minutes=30)))
    assert plan.terms == []
    assert plan.file_time_field == "modifiedTime"
    assert plan.time_bounds(now) == ("2026-09-22T15:00:00Z", "2026-09-24T15:00:00Z")
    with pytest.raises(ValidationError):
        LiveSearchPlan.model_validate({})
    with pytest.raises(ValidationError):
        LiveSearchPlan.model_validate({"relative_days": 32})
    with pytest.raises(ValidationError):
        LiveSearchPlan.model_validate({"relative_days": 2})
    with pytest.raises(ValueError):
        plan.time_bounds(datetime(2026, 9, 24))


@pytest.mark.asyncio
@pytest.mark.parametrize("truncated", [False, True])
@pytest.mark.parametrize("time_field", ["modifiedTime", "createdTime"])
@pytest.mark.parametrize("with_card_dates", [False, True])
@pytest.mark.parametrize(
    ("purpose", "explicit_file_activity"),
    [
        ("Files from the last two days", True),
        ("Statements for the last two days", False),
        ("Documents covering the last two days", False),
        ("Documents for the period of the last two days", False),
        ("PDF statements for the last two days", False),
        ("Modified PDF statements from the last two days", True),
    ],
)
async def test_b_recency_prepares_private_metadata_review_without_content_or_index(
    monkeypatch, truncated, time_field, with_card_dates, purpose, explicit_file_activity
):
    request_id, document_id = str(uuid4()), str(uuid4())
    requested_at = datetime(2026, 9, 20, 12, 30, tzinfo=UTC)
    source_ref = "document:" + "b" * 32
    job = {
        "user_id": "owner",
        "request_id": request_id,
        "revision": 0,
        "generation": 1,
        "lease_id": str(uuid4()),
        "purpose": {
            "purpose": purpose,
            **({"periodStart": "2026-09-22", "periodEnd": "2026-09-24"} if with_card_dates else {}),
        },
        "requested_at": requested_at,
        "live": True,
        "foreground": True,
    }
    row = {
        "document_id": document_id,
        "file_id": "file-1",
        "name": "Recent.pdf",
        "source_version": "3",
        "connection_generation": 1,
        "metadata_only": True,
        "_live": True,
    }
    reader = SimpleNamespace(
        find=AsyncMock(
            return_value={
                "matches": [{"file_id": "file-1", "name": "Recent.pdf"}],
                "truncated": truncated,
            }
        ),
        bind_matches=AsyncMock(
            return_value={
                "untrusted_external_content": [
                    {
                        "document_ref": document_id,
                        "source_ref": source_ref,
                        "name": "Recent.pdf",
                        "text": "Verified file metadata only",
                    }
                ],
                "truncated": truncated,
            }
        ),
        search=AsyncMock(),
        require_current=AsyncMock(),
        _rows=[row],
    )
    store = SimpleNamespace(
        claim_preparation=AsyncMock(return_value=job),
        require_preparation_current=AsyncMock(),
        prepare_review=AsyncMock(),
        fail_preparation=AsyncMock(),
        indexing_pending=AsyncMock(),
        _source_terms=lambda item: {
            "kind": "live",
            "document_id": item["document_id"],
            "source_version": item["source_version"],
            "provider_file_binding": "a" * 64,
            "connection_generation": item["connection_generation"],
        },
    )
    interpreter = AsyncMock()
    search_planner = AsyncMock(
        return_value={
            "relative_days": 2,
            "mode": "find",
            "file_time_field": time_field,
            "time_intent": "file_activity",
        }
    )
    monkeypatch.setattr(module, "wake_drive_work", AsyncMock())
    service = DriveSuggestionService(
        oauth=SimpleNamespace(),
        store=store,
        interpreter=interpreter,
        search_planner=search_planner,
        reader_factory=lambda **_: reader,
        require_owner=AsyncMock(),
    )

    assert await service.run_one(user_id="owner", request_id=request_id) == "review_ready"
    reader.find.assert_awaited_once()
    assert reader.find.await_args.kwargs["query"] == []
    assert reader.find.await_args.kwargs["time_field"] == time_field
    assert reader.find.await_args.kwargs["start_time"] == "2026-09-18T12:30:00Z"
    assert reader.find.await_args.kwargs["end_time"] == "2026-09-20T12:30:00Z"
    reader.bind_matches.assert_awaited_once()
    reader.search.assert_not_awaited()
    interpreter.assert_not_awaited()
    store.indexing_pending.assert_not_awaited()
    published = store.prepare_review.await_args.kwargs
    assert published["document_ids"] == [document_id]
    assert published["live_sources"] == [row]
    assert published["coverage"]["coverage_status"] == (
        "complete" if explicit_file_activity and not truncated else "partial"
    )
    assert bool(published["coverage"]["gaps"]) is (truncated or not explicit_file_activity)
    assert published["coverage"]["truncated"] is truncated
    assert (
        json.loads(search_planner.await_args.kwargs["prompt"])["document_request"] == job["purpose"]
    )
    first_search = reader.find.await_args.kwargs
    # A later worker retry of the same request must retain B's Send-time window.
    assert await service.run_one(user_id="owner", request_id=request_id) == "review_ready"
    assert reader.find.await_args.kwargs == first_search


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "plan",
    [
        {"terms": ["statement"]},
        {
            "terms": ["statement"],
            "relative_days": 2,
            "mode": "read",
            "time_intent": "file_activity",
        },
    ],
)
async def test_explicit_statement_period_keeps_content_coverage(plan):
    request_id = str(uuid4())
    job = {
        "user_id": "owner",
        "request_id": request_id,
        "revision": 0,
        "generation": 1,
        "lease_id": str(uuid4()),
        "purpose": {
            "purpose": "Statements for the last six completed months",
            "periodStart": "2026-03-01",
            "periodEnd": "2026-08-31",
        },
        "live": True,
        "foreground": True,
    }
    reader = SimpleNamespace(
        search=AsyncMock(return_value={"untrusted_external_content": [], "truncated": False}),
        find=AsyncMock(),
    )
    store = SimpleNamespace(
        claim_preparation=AsyncMock(return_value=job),
        require_preparation_current=AsyncMock(),
        fail_preparation=AsyncMock(),
        indexing_pending=AsyncMock(return_value=False),
    )
    service = DriveSuggestionService(
        oauth=SimpleNamespace(),
        store=store,
        search_planner=AsyncMock(return_value=plan),
        reader_factory=lambda **_: reader,
        require_owner=AsyncMock(),
    )
    assert await service.run_one(user_id="owner", request_id=request_id) == "no_ready_files"
    reader.search.assert_awaited_once_with(query=["statement"])
    reader.find.assert_not_awaited()

"""Recent Drive requests use A's live metadata and existing private review."""

import json
from datetime import UTC, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, create_autospec
from uuid import uuid4

import pytest
from pydantic import ValidationError

from hushh_mcp.services import drive_suggestion_service as module
from hushh_mcp.services.drive_live_reader import DriveLiveReader
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
    assert published["coverage"]["selection"] == {
        "stage": "skipped_file_activity_window",
        "candidates": 1,
        "selected": 1,
    }
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
        search=AsyncMock(),
        find=AsyncMock(return_value={"matches": [], "truncated": False}),
        read_matches=AsyncMock(return_value={"untrusted_external_content": [], "truncated": False}),
    )
    store = SimpleNamespace(
        claim_preparation=AsyncMock(return_value=job),
        require_preparation_current=AsyncMock(),
        fail_preparation=AsyncMock(),
        indexing_pending=AsyncMock(return_value=False),
    )
    selector = AsyncMock(side_effect=AssertionError("selector reached"))
    service = DriveSuggestionService(
        oauth=SimpleNamespace(),
        store=store,
        search_planner=AsyncMock(return_value=plan),
        reader_factory=lambda **_: reader,
        require_owner=AsyncMock(),
        candidate_selector=selector,
    )
    assert await service.run_one(user_id="owner", request_id=request_id) == "no_ready_files"
    # Zero matches leave nothing to judge.
    assert selector.called is False
    # Content coverage searches without the file-activity window, then reads
    # exactly what it found.
    reader.find.assert_awaited_once_with(
        query=["statement"], file_kind="any", shared_with_me=False, recent=False
    )
    reader.read_matches.assert_awaited_once_with(matches=[], truncated=False)
    reader.search.assert_not_awaited()


@pytest.mark.asyncio
async def test_content_request_calls_the_real_reader_signature():
    """A spec'd reader fails on any keyword DriveLiveReader does not accept.

    A hand-written fake accepted ``reader.search(file_kind=...)`` and hid a
    TypeError that sent every content request to review with no files.
    """
    request_id = str(uuid4())
    job = {
        "user_id": "owner",
        "request_id": request_id,
        "revision": 0,
        "generation": 1,
        "lease_id": str(uuid4()),
        "purpose": {"purpose": "My tax return PDF", "periodStart": None, "periodEnd": None},
        "live": True,
        "foreground": True,
    }
    reader = create_autospec(DriveLiveReader, instance=True)
    match = {"file_id": "1AbCdEfGhIjKlMnOpQrStUvWxYz012345", "name": "Tax return 2025.pdf"}
    reader.find.return_value = {"matches": [match], "truncated": False}
    reader.read_matches.return_value = {"untrusted_external_content": [], "truncated": False}
    store = SimpleNamespace(
        claim_preparation=AsyncMock(return_value=job),
        require_preparation_current=AsyncMock(),
        fail_preparation=AsyncMock(),
        indexing_pending=AsyncMock(return_value=False),
    )
    selector = AsyncMock(return_value={"selected": ["c1"]})
    service = DriveSuggestionService(
        oauth=SimpleNamespace(),
        store=store,
        search_planner=AsyncMock(return_value={"terms": ["tax return"], "file_kind": "pdf"}),
        reader_factory=lambda **_: reader,
        require_owner=AsyncMock(),
        candidate_selector=selector,
    )
    assert await service.run_one(user_id="owner", request_id=request_id) == "no_ready_files"
    reader.find.assert_awaited_once_with(
        query=["tax return"], file_kind="pdf", shared_with_me=False, recent=False
    )
    selector.assert_awaited_once()
    reader.read_matches.assert_awaited_once_with(matches=[match], truncated=False)
    store.fail_preparation.assert_awaited_once()
    assert store.fail_preparation.await_args.kwargs["code"] == "no_ready_files"


@pytest.mark.asyncio
async def test_latest_file_request_asks_the_reader_for_the_newest_files():
    """'Get my latest resume' must reach find(recent=True), as in the chat lane."""
    job = {
        "user_id": "owner",
        "request_id": str(uuid4()),
        "revision": 0,
        "generation": 1,
        "lease_id": str(uuid4()),
        "purpose": {"purpose": "My latest resume", "periodStart": None, "periodEnd": None},
        "live": True,
        "foreground": True,
    }
    reader = create_autospec(DriveLiveReader, instance=True)
    reader.find.return_value = {"matches": [], "truncated": False}
    reader.read_matches.return_value = {"untrusted_external_content": [], "truncated": False}
    store = SimpleNamespace(
        claim_preparation=AsyncMock(return_value=job),
        require_preparation_current=AsyncMock(),
        fail_preparation=AsyncMock(),
        indexing_pending=AsyncMock(return_value=False),
    )
    service = DriveSuggestionService(
        oauth=SimpleNamespace(),
        store=store,
        search_planner=AsyncMock(return_value={"terms": ["resume"], "sort": "recent"}),
        reader_factory=lambda **_: reader,
        require_owner=AsyncMock(),
    )
    await service.run_one(user_id="owner", request_id=job["request_id"])
    assert reader.find.await_args.kwargs["recent"] is True


def content_job(purpose="Bank statements for the last six months"):
    return {
        "user_id": "owner",
        "request_id": str(uuid4()),
        "revision": 0,
        "generation": 1,
        "lease_id": str(uuid4()),
        "purpose": {"purpose": purpose, "periodStart": "2026-03-01", "periodEnd": "2026-08-31"},
        "requested_at": datetime(2026, 9, 20, 12, 30, tzinfo=UTC),
        "live": True,
        "foreground": True,
    }


def twelve_matches():
    return [
        {
            "file_id": f"1AbCdEfGhIjKlMnOpQrStUvWxYz0{index:05d}",
            "name": "Notes by Gemini" if index <= 6 else f"HDFC_Statement_{index:02d}.pdf",
        }
        for index in range(1, 13)
    ]


def content_store(job):
    return SimpleNamespace(
        claim_preparation=AsyncMock(return_value=job),
        require_preparation_current=AsyncMock(),
        prepare_review=AsyncMock(),
        fail_preparation=AsyncMock(),
        indexing_pending=AsyncMock(return_value=False),
        _source_terms=lambda item: {
            "kind": "live",
            "document_id": item["document_id"],
            "source_version": item["source_version"],
            "provider_file_binding": "a" * 64,
            "connection_generation": item["connection_generation"],
        },
    )


@pytest.mark.asyncio
async def test_file_request_reads_the_selected_statements_not_the_first_eight(monkeypatch):
    job = content_job()
    matches = twelve_matches()
    document_id = str(uuid4())
    reader = create_autospec(DriveLiveReader, instance=True)
    reader.find.return_value = {"matches": matches, "truncated": False}
    reader.read_matches.return_value = {
        "untrusted_external_content": [
            {
                "document_ref": document_id,
                "source_ref": "document:" + "c" * 32,
                "name": "HDFC_Statement_07.pdf",
                "page": None,
                "text": "Statement period March 2026",
            }
        ],
        "truncated": False,
    }
    reader._rows = [
        {
            "document_id": document_id,
            "file_id": matches[6]["file_id"],
            "name": "HDFC_Statement_07.pdf",
            "source_version": "3",
            "connection_generation": 1,
            "_live": True,
        }
    ]
    store = content_store(job)
    selector = AsyncMock(return_value={"selected": [f"c{index}" for index in range(7, 13)]})
    interpreter = AsyncMock(
        return_value={
            "files": [{"document_ref": document_id, "source_refs": ["document:" + "c" * 32]}],
            "coverage_summary": "March is covered.",
            "gaps": ["April through August are not established."],
            "coverage_status": "partial",
            "covered_periods": [],
        }
    )
    monkeypatch.setattr(module, "wake_drive_work", AsyncMock())
    service = DriveSuggestionService(
        oauth=SimpleNamespace(),
        store=store,
        interpreter=interpreter,
        search_planner=AsyncMock(return_value={"terms": ["statement"], "mode": "read"}),
        reader_factory=lambda **_: reader,
        require_owner=AsyncMock(),
        candidate_selector=selector,
    )
    assert await service.run_one(user_id="owner", request_id=job["request_id"]) == "review_ready"
    reader.read_matches.assert_awaited_once_with(matches=matches[6:], truncated=False)
    prompt = json.loads(selector.await_args.kwargs["prompt"])
    assert prompt["document_request"] == job["purpose"]
    assert prompt["mode"] == "read"
    assert prompt["current_time_utc"] == "2026-09-20T12:30:00+00:00"
    coverage = store.prepare_review.await_args.kwargs["coverage"]
    assert coverage["selection"] == {"stage": "completed", "candidates": 12, "selected": 6}
    assert coverage["semanticStage"] == "completed"


@pytest.mark.asyncio
async def test_the_owner_private_suggestions_prompt_names_unreadable_files(monkeypatch):
    job = content_job()
    matches = twelve_matches()[6:8]
    document_id = str(uuid4())
    reader = create_autospec(DriveLiveReader, instance=True)
    reader.find.return_value = {"matches": matches, "truncated": False}
    reader.read_matches.return_value = {
        "untrusted_external_content": [
            {
                "document_ref": document_id,
                "source_ref": "document:" + "c" * 32,
                "name": "HDFC_Statement_07.pdf",
                "page": None,
                "text": "Statement period March 2026",
            }
        ],
        "unreadable": [
            {
                "name": "HDFC_Statement_08.pdf",
                "reason": "encrypted_document",
                "source_ref": "document:" + "d" * 32,
            }
        ],
        "truncated": True,
    }
    reader._rows = [
        {
            "document_id": document_id,
            "file_id": matches[0]["file_id"],
            "name": "HDFC_Statement_07.pdf",
            "source_version": "3",
            "connection_generation": 1,
            "_live": True,
        }
    ]
    store = content_store(job)
    interpreter = AsyncMock(
        return_value={
            "files": [{"document_ref": document_id, "source_refs": ["document:" + "c" * 32]}],
            "coverage_summary": "March is covered.",
            "gaps": ["The April statement is password-protected."],
            "coverage_status": "partial",
            "covered_periods": [],
        }
    )
    monkeypatch.setattr(module, "wake_drive_work", AsyncMock())
    service = DriveSuggestionService(
        oauth=SimpleNamespace(),
        store=store,
        interpreter=interpreter,
        search_planner=AsyncMock(return_value={"terms": ["statement"], "mode": "read"}),
        reader_factory=lambda **_: reader,
        require_owner=AsyncMock(),
        candidate_selector=AsyncMock(return_value={"selected": ["c1", "c2"]}),
    )
    assert await service.run_one(user_id="owner", request_id=job["request_id"]) == "review_ready"
    prompt = json.loads(interpreter.await_args.kwargs["prompt"])
    assert prompt["retrieved_documents"]["unreadable"] == [
        {"name": "HDFC_Statement_08.pdf", "reason": "encrypted_document"}
    ]
    assert "document:" + "d" * 32 not in interpreter.await_args.kwargs["prompt"]


@pytest.mark.asyncio
async def test_file_request_with_no_relevant_match_fails_honestly(caplog):
    job = content_job()
    reader = create_autospec(DriveLiveReader, instance=True)
    reader.find.return_value = {"matches": twelve_matches()[:6], "truncated": False}
    store = content_store(job)
    interpreter = AsyncMock(side_effect=AssertionError("interpreter reached"))
    service = DriveSuggestionService(
        oauth=SimpleNamespace(),
        store=store,
        interpreter=interpreter,
        search_planner=AsyncMock(return_value={"terms": ["statement"], "mode": "read"}),
        reader_factory=lambda **_: reader,
        require_owner=AsyncMock(),
        candidate_selector=AsyncMock(return_value={"selected": []}),
    )
    assert await service.run_one(user_id="owner", request_id=job["request_id"]) == "no_ready_files"
    store.fail_preparation.assert_awaited_once_with(job, code="no_relevant_files", retryable=False)
    reader.read_matches.assert_not_awaited()
    assert interpreter.called is False
    store.prepare_review.assert_not_awaited()
    assert "Notes by Gemini" not in caplog.text and "statement" not in caplog.text.lower()


@pytest.mark.asyncio
async def test_file_request_selector_failure_reads_nothing():
    job = content_job()
    reader = create_autospec(DriveLiveReader, instance=True)
    reader.find.return_value = {"matches": twelve_matches(), "truncated": False}
    store = content_store(job)
    service = DriveSuggestionService(
        oauth=SimpleNamespace(),
        store=store,
        search_planner=AsyncMock(return_value={"terms": ["statement"], "mode": "read"}),
        reader_factory=lambda **_: reader,
        require_owner=AsyncMock(),
        candidate_selector=AsyncMock(return_value={"selected": ["c40"]}),
    )
    assert await service.run_one(user_id="owner", request_id=job["request_id"]) == "unavailable"
    reader.read_matches.assert_not_awaited()
    assert store.fail_preparation.await_args.kwargs["code"] == "preparation_unavailable"


@pytest.mark.asyncio
async def test_an_invalid_plan_is_asked_once_more_then_stands():
    """UAT 2026-09-25: date-period requests intermittently failed plan validation."""
    from hushh_mcp.services.drive_suggestion_service import plan_live_search

    planner = AsyncMock(side_effect=[{"relative_days": 99}, {"terms": ["statement"]}])
    plan = await plan_live_search(planner, prompt="{}", user_id="owner")
    assert plan.terms == ["statement"] and planner.await_count == 2
    planner = AsyncMock(return_value={"relative_days": 99})
    with pytest.raises(ValidationError):
        await plan_live_search(planner, prompt="{}", user_id="owner")
    assert planner.await_count == 2
    planner = AsyncMock(return_value={"terms": ["statement"]})
    await plan_live_search(planner, prompt="{}", user_id="owner")
    assert planner.await_count == 1

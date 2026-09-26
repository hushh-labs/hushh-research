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
@pytest.mark.parametrize("foreground", [False, True])
async def test_recent_file_request_skips_planner_and_binds_metadata(monkeypatch, foreground):
    job = content_job("files modified in last two days")
    job["purpose"].update(periodStart=None, periodEnd=None)
    job["foreground"] = foreground
    document_id = str(uuid4())
    source_ref = "document:" + "b" * 32
    source = {
        "document_id": document_id,
        "file_id": "recent-file-1",
        "name": "Recent.pdf",
        "source_version": "3",
        "connection_generation": 1,
        "metadata_only": True,
        "_live": True,
    }
    match = {"file_id": source["file_id"], "name": source["name"]}
    reader = SimpleNamespace(
        find=AsyncMock(return_value={"matches": [match], "truncated": False}),
        bind_matches=AsyncMock(
            return_value={
                "untrusted_external_content": [
                    {
                        "document_ref": document_id,
                        "source_ref": source_ref,
                        "name": source["name"],
                        "text": "Verified file metadata only",
                    }
                ],
                "truncated": False,
            }
        ),
        read_matches=AsyncMock(side_effect=AssertionError("content read")),
        require_current=AsyncMock(),
        _rows=[source],
    )
    store = content_store(job)
    planner = AsyncMock(side_effect=AssertionError("planner reached"))
    interpreter = AsyncMock(side_effect=AssertionError("interpreter reached"))
    selector = AsyncMock(side_effect=AssertionError("selector reached"))
    monkeypatch.setattr(module, "wake_drive_work", AsyncMock())
    service = DriveSuggestionService(
        oauth=SimpleNamespace(),
        store=store,
        search_planner=planner,
        interpreter=interpreter,
        candidate_selector=selector,
        reader_factory=lambda **_: reader,
        require_owner=AsyncMock() if foreground else None,
    )

    assert await service.run_one(user_id="owner", request_id=job["request_id"]) == "review_ready"

    expected_bounds = {
        "time_field": "modifiedTime",
        "start_time": "2026-09-18T12:30:00Z",
        "end_time": "2026-09-20T12:30:00Z",
    }
    assert reader.find.await_args.kwargs == {
        "query": [],
        "file_kind": "any",
        "shared_with_me": False,
        "recent": True,
        **expected_bounds,
    }
    assert reader.bind_matches.await_args.kwargs == {
        "matches": [match],
        "truncated": False,
        **expected_bounds,
    }
    coverage = store.prepare_review.await_args.kwargs["coverage"]
    assert coverage["coverage_status"] == "complete"
    assert coverage["selection"]["stage"] == "skipped_file_activity_window"
    assert store.prepare_review.await_args.kwargs["live_sources"] == [source]
    assert ("foreground" in store.prepare_review.await_args.kwargs) is foreground
    assert ("foreground" in store.claim_preparation.await_args.kwargs) is foreground
    planner.assert_not_awaited()
    interpreter.assert_not_awaited()
    selector.assert_not_awaited()
    reader.read_matches.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("foreground", [False, True])
async def test_recent_file_request_with_separate_card_dates_keeps_planner(foreground):
    job = content_job("files modified in last two days")
    job["foreground"] = foreground
    reader = SimpleNamespace(
        find=AsyncMock(return_value={"matches": [], "truncated": False}),
        bind_matches=AsyncMock(return_value={"untrusted_external_content": [], "truncated": False}),
    )
    planner = AsyncMock(
        return_value={"mode": "find", "relative_days": 2, "time_intent": "file_activity"}
    )
    service = DriveSuggestionService(
        oauth=SimpleNamespace(),
        store=content_store(job),
        search_planner=planner,
        reader_factory=lambda **_: reader,
        require_owner=AsyncMock() if foreground else None,
    )

    assert await service.run_one(user_id="owner", request_id=job["request_id"]) == "no_ready_files"
    planner.assert_awaited_once()


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

    stages: list[str] = []
    assert (
        await service.run_one(user_id="owner", request_id=request_id, on_stage=stages.append)
        == "review_ready"
    )
    # Metadata-only recency skips the selector and the interpreter.
    assert stages == ["searching"]
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
    stages: list[str] = []
    assert (
        await service.run_one(user_id="owner", request_id=job["request_id"], on_stage=stages.append)
        == "review_ready"
    )
    assert stages == ["searching", "choosing", "checking", "checking"]
    reader.read_matches.assert_awaited_once_with(matches=matches[6:], truncated=False)
    prompt = json.loads(selector.await_args.kwargs["prompt"])
    assert prompt["document_request"] == job["purpose"]
    assert prompt["mode"] == "read"
    assert prompt["current_time_utc"] == "2026-09-20T12:30:00+00:00"
    coverage = store.prepare_review.await_args.kwargs["coverage"]
    assert coverage["selection"] == {"stage": "completed", "candidates": 12, "selected": 6}
    assert coverage["semanticStage"] == "completed"


@pytest.mark.asyncio
@pytest.mark.parametrize("coverage_status", ["complete", "partial"])
async def test_selector_over_limit_preserves_partial_coverage(monkeypatch, coverage_status):
    job = content_job()
    # No period requirement: truncation itself must prevent false completeness.
    job["purpose"].update(periodStart=None, periodEnd=None)
    matches = twelve_matches()
    document_ids = [str(uuid4()) for _ in range(8)]
    source_refs = ["document:" + f"{index:032x}" for index in range(8)]
    content = [
        {
            "document_ref": identifier,
            "source_ref": ref,
            "name": match["name"],
            "text": "Synthetic statement text.",
        }
        for identifier, ref, match in zip(document_ids, source_refs, matches[:8], strict=True)
    ]
    reader = create_autospec(DriveLiveReader, instance=True)
    reader.find.return_value = {"matches": matches, "truncated": False}

    async def read_matches(*, matches, truncated):
        return {"untrusted_external_content": content, "truncated": truncated}

    reader.read_matches.side_effect = read_matches
    reader._rows = [
        {
            "document_id": identifier,
            "file_id": match["file_id"],
            "name": match["name"],
            "source_version": "3",
            "connection_generation": 1,
            "_live": True,
        }
        for identifier, match in zip(document_ids, matches[:8], strict=True)
    ]
    store = content_store(job)
    interpreter = AsyncMock(
        return_value={
            "files": [
                {"document_ref": identifier, "source_refs": [ref]}
                for identifier, ref in zip(document_ids, source_refs, strict=True)
            ],
            "coverage_summary": "Synthetic matching statements.",
            "coverage_status": coverage_status,
            "gaps": [] if coverage_status == "complete" else ["Additional matching files exist."],
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
        candidate_selector=AsyncMock(
            return_value={"selected": [f"c{index}" for index in range(1, 13)]}
        ),
    )
    stages = []
    result = await service.run_one(
        user_id="owner", request_id=job["request_id"], on_stage=stages.append
    )

    reader.read_matches.assert_awaited_once_with(matches=matches[:8], truncated=True)
    assert stages == ["searching", "choosing", "checking", "checking"]
    assert (
        json.loads(interpreter.await_args.kwargs["prompt"])["retrieved_documents"]["truncated"]
        is True
    )
    if coverage_status == "complete":
        assert result == "unavailable"
        store.prepare_review.assert_not_awaited()
        store.fail_preparation.assert_awaited_once()
    else:
        assert result == "review_ready"
        store.fail_preparation.assert_not_awaited()
        coverage = store.prepare_review.await_args.kwargs["coverage"]
        assert coverage["truncated"] is True
        assert coverage["selection"] == {
            "stage": "completed_over_limit",
            "candidates": 12,
            "selected": 8,
            "over_limit": True,
        }


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
@pytest.mark.parametrize("callback_fails", [False, True])
async def test_file_request_with_no_relevant_match_fails_honestly(caplog, callback_fails):
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
    stages: list[str] = []

    def on_stage(stage):
        stages.append(stage)
        if callback_fails:
            raise RuntimeError("display failed")

    assert (
        await service.run_one(user_id="owner", request_id=job["request_id"], on_stage=on_stage)
        == "no_ready_files"
    )
    # A failing progress callback never changes the preparation outcome.
    assert stages == ["searching", "choosing"]
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


@pytest.mark.asyncio
async def test_a_worker_held_lease_reports_no_stage():
    store = content_store(content_job())
    store.claim_preparation = AsyncMock(return_value=None)
    service = DriveSuggestionService(
        oauth=SimpleNamespace(),
        store=store,
        search_planner=AsyncMock(side_effect=AssertionError("planner reached")),
        reader_factory=lambda **_: None,
        require_owner=AsyncMock(),
    )
    stages: list[str] = []
    assert (
        await service.run_one(user_id="owner", request_id=str(uuid4()), on_stage=stages.append)
        == "not_claimed"
    )
    assert stages == []


def test_stage_reporting_never_raises():
    def broken(_stage):
        raise RuntimeError("display failed")

    module._emit(broken, "searching")
    module._emit(None, "checking")

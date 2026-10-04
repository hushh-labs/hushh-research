"""Provider metadata search for a request includes date-named shortcut targets."""

import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from hushh_mcp.services import drive_owner_search_service as search_module
from hushh_mcp.services import google_drive_rest_transport as rest
from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_owner_search_service import (
    DriveOwnerSearchService,
    compile_request_queries,
)
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_request_bulk_service import DriveRequestBulkService
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.google_drive_adapter import (
    FACT_FIELDS,
    LIST_FIELDS,
    LIVE_POLICY_HASH,
    DriveReadError,
    GoogleDriveAdapter,
)


@pytest.mark.asyncio
async def test_final_search_page_reconciles_request_after_last_batch_settled(monkeypatch):
    store = DriveOwnerSearchStore(db=SimpleNamespace())
    transaction = AsyncMock(return_value={"status": "completed"})
    refresh = AsyncMock()
    monkeypatch.setattr(store, "_transaction", transaction)
    monkeypatch.setattr(DriveBulkShareStore, "refresh_request", refresh)
    await store.commit_page(
        {"user_id": "owner"},
        checkpoint={"request_origin_id": "a9704272-a1aa-469a-bdf9-883e3884adad"},
        files=[],
        done=True,
    )
    refresh.assert_awaited_once_with(
        user_id="owner", request_id="a9704272-a1aa-469a-bdf9-883e3884adad"
    )
    transaction.return_value = {"status": "running"}
    refresh.reset_mock()
    await store.commit_page(
        {"user_id": "owner"},
        checkpoint={"request_origin_id": "a9704272-a1aa-469a-bdf9-883e3884adad"},
        files=[],
        done=False,
    )
    refresh.assert_not_awaited()


@pytest.mark.asyncio
async def test_owner_search_store_accepts_full_provider_page_before_transaction(monkeypatch):
    # The scanner commits one 100-row provider page atomically; rejecting it
    # here failed the entire search before any result could be reviewed.
    store = DriveOwnerSearchStore(db=SimpleNamespace())
    transaction = AsyncMock(return_value={"status": "running"})
    monkeypatch.setattr(store, "_transaction", transaction)
    job = {"user_id": "owner"}
    files = [{"id": f"file-{index}"} for index in range(100)]

    await store.commit_page(job, checkpoint={}, files=files)
    transaction.assert_awaited_once()
    with pytest.raises(DriveReadError, match="invalid_argument"):
        await store.commit_page(job, checkpoint={}, files=files + [{"id": "overflow"}])
    transaction.assert_awaited_once()


def test_request_plan_keeps_all_candidate_file_dates_and_shortcut_mime():
    today = datetime.now(UTC).date()
    start = (today - timedelta(days=90)).isoformat()
    end = today.isoformat()
    queries, period = compile_request_queries(
        {
            "mode": "find",
            "terms": ["standup", "notes"],
            "file_kind": "document",
            "time_intent": "file_activity",
            "file_time_field": "modifiedTime",
            "date_from": start,
            "date_to": end,
        },
        {"purpose": "Standup notes from last 3 months", "periodStart": start, "periodEnd": end},
        "UTC",
    )
    query = queries[0]["arguments"]["query"]
    assert "standup" in query and "notes" in query
    assert "application/vnd.google-apps.document" in query
    assert "application/vnd.google-apps.shortcut" in query
    assert "application/vnd.google-apps.folder" in query
    assert "application/pdf" in query and "text/plain" in query
    assert "video/" not in query and "audio/" not in query
    assert "modifiedTime" not in query
    assert period == {"start": start, "end": end, "timezone": "UTC"}


def test_relative_standup_request_requires_dates_before_searching_historical_files():
    plan = {"mode": "find", "terms": ["standup"], "file_kind": "document"}
    purpose = {"purpose": "last 3 days standup notes"}
    with pytest.raises(DriveReadError, match="date_range_required"):
        compile_request_queries(
            plan,
            purpose,
            "Asia/Kolkata",
            requested_at=datetime(2026, 10, 1, 17, 45, tzinfo=UTC),
        )

    _, period = compile_request_queries(
        plan,
        {**purpose, "periodStart": "2026-09-29", "periodEnd": "2026-10-01"},
        "Asia/Kolkata",
    )
    assert period == {
        "start": "2026-09-29",
        "end": "2026-10-01",
        "timezone": "Asia/Kolkata",
    }
    assert search_module._in_requested_period({"name": "Standup notes 2026-09-30"}, period)
    assert not search_module._in_requested_period(
        {"name": "Standup notes 2026-09-28", "modified_time": "2026-10-01T17:00:00Z"},
        period,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("purpose", ["last 3 days standup notes", "bank statements"])
async def test_legacy_undated_request_checkpoint_stops_before_provider_read(purpose):
    read = AsyncMock()
    context = AsyncMock(return_value={"purpose": {"purpose": purpose}})
    service = DriveOwnerSearchService(
        store=SimpleNamespace(),
        transport=SimpleNamespace(read_tool=read),
        sharing=SimpleNamespace(request_bulk_context=context),
    )
    job = {
        "user_id": "owner",
        "checkpoint": {
            "request_origin_id": "12345678-1234-1234-1234-123456789012",
            "request": {"query": purpose, "timezone": "Asia/Kolkata"},
            "requested_period": None,
            "phase": "user",
        },
    }
    with pytest.raises(DriveReadError, match="date_range_required"):
        await service._page(job)
    context.assert_awaited_once_with(
        user_id="owner", request_id="12345678-1234-1234-1234-123456789012"
    )
    read.assert_not_awaited()


@pytest.mark.asyncio
async def test_legacy_dated_checkpoint_reads_saved_request_before_provider():
    read = AsyncMock(
        return_value=SimpleNamespace(payload={"drives": []}, is_error=False, truncated=False)
    )
    context = AsyncMock(
        return_value={
            "purpose": {
                "purpose": "last 3 days standup notes",
                "periodStart": "2026-09-29",
                "periodEnd": "2026-10-01",
            }
        }
    )
    service = DriveOwnerSearchService(
        store=SimpleNamespace(),
        transport=SimpleNamespace(read_tool=read),
        sharing=SimpleNamespace(request_bulk_context=context),
    )
    job = {
        "user_id": "owner",
        "checkpoint": {
            "request_origin_id": "12345678-1234-1234-1234-123456789012",
            "request": {"query": "last 3 days standup notes", "timezone": "Asia/Kolkata"},
            "requested_period": {"start": "2026-09-29", "end": "2026-10-01"},
            "phase": "drives",
            "drive_page_token": None,
            "drive_tokens": [],
            "drives": [],
        },
    }

    checkpoint, files, incomplete, done = await service._page(job)

    assert checkpoint["request_explicit_dates"] is True
    assert (files, incomplete, done) == ([], False, True)
    context.assert_awaited_once()
    read.assert_awaited_once()


@pytest.mark.asyncio
async def test_legacy_checkpoint_rejects_period_changed_from_saved_request():
    read = AsyncMock()
    service = DriveOwnerSearchService(
        store=SimpleNamespace(),
        transport=SimpleNamespace(read_tool=read),
        sharing=SimpleNamespace(
            request_bulk_context=AsyncMock(
                return_value={
                    "purpose": {
                        "periodStart": "2026-09-29",
                        "periodEnd": "2026-10-01",
                    }
                }
            )
        ),
    )
    job = {
        "user_id": "owner",
        "checkpoint": {
            "request_origin_id": "12345678-1234-1234-1234-123456789012",
            "requested_period": {"start": "2026-01-01", "end": "2026-10-01"},
        },
    }

    with pytest.raises(DriveReadError, match="request_changed"):
        await service._page(job)
    read.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("purpose", ["last 3 days standup notes", "bank statements"])
async def test_legacy_undated_request_cannot_resume_or_prepare_existing_results(purpose):
    lookup = AsyncMock(return_value={"status": "completed", "jobId": "old-job"})
    service = DriveRequestBulkService(
        sharing=SimpleNamespace(
            request_bulk_context=AsyncMock(
                return_value={
                    "purpose": {"purpose": purpose},
                    "status": "pending",
                    "searchStarted": True,
                }
            )
        ),
        search=SimpleNamespace(store=SimpleNamespace(by_client=lookup)),
        bulk=SimpleNamespace(),
        require_owner=AsyncMock(),
    )
    with pytest.raises(DriveReadError, match="date_range_required"):
        await service.start_search(user_id="owner", request_id="old-request")
    with pytest.raises(DriveReadError, match="date_range_required"):
        await service.prepare(user_id="owner", request_id="old-request")
    lookup.assert_not_awaited()


def test_yesterday_uses_requesters_frozen_local_day_even_when_planner_used_utc():
    requested_at = datetime(2026, 9, 29, 21, 33, tzinfo=UTC)
    plan = {
        "mode": "find",
        "terms": ["onboarding", "notes"],
        "file_kind": "document",
        "time_intent": "file_activity",
        "date_from": "2026-09-28",
        "date_to": "2026-09-28",
    }
    purpose = {"purpose": "Send me notes from yesterdays onboarding call"}

    _, local_period = compile_request_queries(
        plan, purpose, "Asia/Kolkata", requested_at=requested_at
    )
    _, utc_period = compile_request_queries(plan, purpose, "UTC", requested_at=requested_at)

    assert local_period == {
        "start": "2026-09-29",
        "end": "2026-09-29",
        "timezone": "Asia/Kolkata",
    }
    assert utc_period == {"start": "2026-09-28", "end": "2026-09-28", "timezone": "UTC"}
    assert search_module._in_requested_period(
        {"name": "Chris Onboarding - 2026/09/29 - Notes by Gemini"}, local_period
    )


def test_ist_meeting_note_matches_previous_utc_day_without_admitting_older_notes():
    title = "Chris Onboarding - 2026/09/29 03:19 IST - Notes by Gemini"
    utc_period = {"start": "2026-09-28", "end": "2026-09-28", "timezone": "UTC"}
    older_period = {"start": "2026-09-27", "end": "2026-09-27", "timezone": "UTC"}

    assert search_module._in_requested_period({"name": title}, utc_period)
    assert search_module._in_requested_period(
        {"name": "Chris Onboarding - 2026/09/29 03:19 GMT+5:30 - Notes by Gemini"},
        utc_period,
    )
    assert not search_module._in_requested_period({"name": title}, older_period)
    assert not search_module._in_requested_period(
        {"name": "Chris Onboarding - 2026/09/29 17:19 IST - Notes by Gemini"}, utc_period
    )


def test_request_plan_requires_each_distinct_subject_term():
    queries, _ = compile_request_queries(
        {"mode": "find", "terms": ["onboarding", "guide"], "file_kind": "document"},
        {"purpose": "Onboarding guide documents"},
        "UTC",
    )
    subject = queries[0]["arguments"]["query"].split(" and ((mimeType", 1)[0]
    assert "fullText contains 'onboarding'" in subject
    assert "fullText contains 'guide'" in subject
    assert ")) and ((" in subject
    assert "fullText contains 'onboarding')) or ((" not in subject


def test_request_plan_unions_explicitly_coordinated_categories():
    queries, _ = compile_request_queries(
        {"mode": "find", "terms": ["contract", "invoice"], "file_kind": "document"},
        {"purpose": "Contracts and invoices from last 3 months"},
        "UTC",
    )
    subject = queries[0]["arguments"]["query"].split(" and ((mimeType", 1)[0]
    assert "fullText contains 'contract'" in subject
    assert "fullText contains 'invoice'" in subject
    assert ")) or ((" in subject


@pytest.mark.parametrize(
    "bad_plan",
    [
        {"terms": ["onboarding"], "file_kind": "any"},
        {"terms": ["onboarding", "documents"], "file_kind": "document"},
        {"exact_title": "Onboarding Documents", "file_kind": "document"},
    ],
)
@pytest.mark.asyncio
async def test_document_request_reasks_inconsistent_planner_before_search(bad_plan):
    calls = []

    async def planner(*, prompt, user_id):
        assert user_id == "owner"
        calls.append(json.loads(prompt))
        return {
            "mode": "find",
            **(bad_plan if len(calls) == 1 else {"terms": ["onboarding"], "file_kind": "document"}),
        }

    service = DriveRequestBulkService(planner=planner)
    plan = await service._plan(
        user_id="owner",
        purpose={"purpose": "Onboarding documents from last 3 months"},
        timezone="UTC",
    )
    assert plan.file_kind == "document"
    assert len(calls) == 2
    assert "plan_validation" in calls[1]


@pytest.mark.asyncio
async def test_topical_document_request_never_runs_as_a_broad_document_listing():
    calls = []

    async def planner(*, prompt, user_id):
        calls.append(json.loads(prompt))
        return {"mode": "find", "terms": [], "file_kind": "document"}

    service = DriveRequestBulkService(planner=planner)
    with pytest.raises(DriveReadError, match="invalid_argument"):
        await service._plan(
            user_id="owner",
            purpose={"purpose": "Onboarding documents from last 3 months"},
            timezone="UTC",
        )
    assert len(calls) == 2

    # An intentionally broad request has no subject to preserve.
    calls.clear()
    plan = await service._plan(
        user_id="owner", purpose={"purpose": "All documents from last 3 months"}, timezone="UTC"
    )
    assert plan.terms == [] and len(calls) == 1


@pytest.mark.asyncio
async def test_explicitly_named_plural_title_is_not_rejected_as_broad_request():
    calls = []

    async def planner(*, prompt, user_id):
        calls.append(json.loads(prompt))
        return {"mode": "find", "exact_title": "Onboarding Documents", "file_kind": "document"}

    service = DriveRequestBulkService(planner=planner)
    plan = await service._plan(
        user_id="owner",
        purpose={"purpose": "Please share the file named Onboarding Documents"},
        timezone="UTC",
    )
    assert plan.exact_title == "Onboarding Documents"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_completed_legacy_request_restarts_search_with_shareability_facts():
    context = {
        "purpose": {
            "purpose": "Onboarding documents from last 3 months",
            "periodStart": "2026-06-29",
            "periodEnd": "2026-09-29",
        },
        "revision": 3,
        "requestTimeZone": "Asia/Kolkata",
        "requestCreatedAt": datetime(2026, 9, 29, 21, 33, tzinfo=UTC),
    }
    store = SimpleNamespace(
        by_client=AsyncMock(return_value={"status": "completed", "jobId": "old-job"}),
        clear_legacy_completed_request=AsyncMock(return_value=True),
        takeover_request=AsyncMock(return_value=None),
    )
    search = SimpleNamespace(
        store=store,
        create_for_request=AsyncMock(return_value={"status": "queued", "jobId": "new-job"}),
    )

    async def planner(*, prompt, user_id):
        return {"mode": "find", "terms": ["onboarding"], "file_kind": "document"}

    service = DriveRequestBulkService(
        sharing=SimpleNamespace(request_bulk_context=AsyncMock(return_value=context)),
        search=search,
        planner=planner,
        require_owner=AsyncMock(),
    )
    state = await service.start_search(user_id="owner", request_id="request-id")
    assert state == {"status": "queued", "jobId": "new-job"}
    store.clear_legacy_completed_request.assert_awaited_once_with(
        user_id="owner", request_id="request-id"
    )
    assert search.create_for_request.await_args.kwargs["plan"]["file_kind"] == "document"
    assert search.create_for_request.await_args.kwargs["timezone"] == "Asia/Kolkata"
    assert (
        search.create_for_request.await_args.kwargs["requested_at"] == context["requestCreatedAt"]
    )


@pytest.mark.asyncio
async def test_request_shortcut_uses_verified_target_and_alias_date():
    today = datetime.now(UTC).date()
    old = (today - timedelta(days=120)).isoformat() + "T00:00:00Z"
    calls = []

    async def read(*, user_id, tool_name, arguments):
        assert user_id == "owner"
        calls.append((tool_name, arguments))
        if tool_name == "get_file_metadata":
            assert arguments == {"fileId": "target-standup-note"}
            return ExternalMcpToolResult(
                False,
                {
                    "file": {
                        "id": "target-standup-note",
                        "title": "Hushh Team Standup Notes",
                        "mimeType": "application/vnd.google-apps.document",
                        "modifiedTime": old,
                    }
                },
                False,
            )
        assert tool_name == "search_files"
        return ExternalMcpToolResult(
            False,
            {
                "files": [
                    {
                        "id": "shortcut-standup-note",
                        "title": f"Hushh Team Standup {today.isoformat()} Notes by Gemini",
                        "mimeType": "application/vnd.google-apps.shortcut",
                        "modifiedTime": old,
                        "shortcutDetails": {
                            "targetId": "target-standup-note",
                            "targetMimeType": "application/vnd.google-apps.document",
                        },
                    }
                ],
                "incompleteSearch": False,
            },
            False,
        )

    service = DriveOwnerSearchService(transport=SimpleNamespace(read_tool=read))
    arguments = {"query": "name contains 'Standup'", "orderBy": "createdTime desc"}
    checkpoint = {
        "request_origin_id": "request-id",
        "request_explicit_dates": True,
        "arguments": arguments,
        "queries": [{"arguments": arguments}],
        "query_index": 0,
        "requested_period": {
            "start": (today - timedelta(days=90)).isoformat(),
            "end": today.isoformat(),
            "timezone": "UTC",
        },
        "phase": "user",
        "page_token": None,
        "drive_page_token": None,
        "drives": [],
        "drive_index": 0,
        "seen_tokens": [],
        "drive_tokens": [],
    }
    _, files, incomplete, _ = await service._page({"user_id": "owner", "checkpoint": checkpoint})
    assert incomplete is False
    assert [(file["id"], file["mimeType"]) for file in files] == [
        ("target-standup-note", "application/vnd.google-apps.document")
    ]
    assert files[0]["shortcutName"].startswith("Hushh Team Standup")
    assert [call[0] for call in calls] == ["search_files", "get_file_metadata"]


def _checkpoint():
    queries, period = compile_request_queries(
        {"mode": "find", "terms": ["standup"], "file_kind": "document"},
        {
            "purpose": "Standup notes from last 3 months",
            "periodStart": "2026-06-28",
            "periodEnd": "2026-09-28",
        },
        "UTC",
    )
    return {
        "request_origin_id": "synthetic-request",
        "request_explicit_dates": True,
        "request_file_kind": "document",
        "request_subject_terms": ["standup"],
        "request_notes": True,
        "arguments": queries[0]["arguments"],
        "queries": queries,
        "query_index": 0,
        "requested_period": period,
        "phase": "user",
        "page_token": None,
        "drive_page_token": None,
        "drives": [],
        "drive_index": 0,
        "seen_tokens": [],
        "drive_tokens": [],
        "folder_queue": [],
        "folder_digests": [],
        "coverage_counts": {},
    }


def _provider_file(identity, name, mime="application/vnd.google-apps.document", **changes):
    return {
        "id": identity,
        "name": name,
        "mimeType": mime,
        "createdTime": "2026-09-26T00:00:00Z",
        "modifiedTime": "2026-09-26T00:00:00Z",
        "trashed": False,
        "capabilities": {"canShare": True},
        **changes,
    }


def _request_candidate(identity, name, mime="application/vnd.google-apps.document", **changes):
    return {**_provider_file(identity, name, mime, **changes), "title": name}


@pytest.mark.asyncio
async def test_trusted_notes_share_only_topical_note_titles_not_incidental_fulltext_hits():
    candidates = [
        _request_candidate(
            "relevant-note",
            "Chris Onboarding - 2026/09/29 03:19 IST - Notes by Gemini",
            createdTime="2026-09-29T03:30:00Z",
        ),
        _request_candidate(
            "incidental-hit",
            "Explain For Product",
            createdTime="2026-09-28T03:30:00Z",
        ),
        _request_candidate(
            "other-notes",
            "Team Retro - 2026/09/29 03:19 IST - Notes by Gemini",
        ),
    ]
    checkpoint = {
        "request_file_kind": "document",
        "request_subject_terms": ["onboarding", "notes"],
        "request_notes": True,
        "requested_period": {
            "start": "2026-09-28",
            "end": "2026-09-28",
            "timezone": "UTC",
        },
        "coverage_counts": {},
    }
    service = DriveOwnerSearchService(transport=SimpleNamespace())
    trusted, incomplete = await service._request_candidates(
        {"user_id": "owner"},
        {**checkpoint, "authority_mode": "trusted_auto"},
        candidates,
        folder_scoped=False,
        drive_id=None,
    )
    owner_review, _ = await service._request_candidates(
        {"user_id": "owner"},
        {**checkpoint, "authority_mode": "owner"},
        candidates,
        folder_scoped=False,
        drive_id=None,
    )
    trusted_folder, _ = await service._request_candidates(
        {"user_id": "owner"},
        {**checkpoint, "authority_mode": "trusted_auto"},
        candidates,
        folder_scoped=True,
        drive_id=None,
    )

    assert incomplete is False
    assert [file["name"] for file in trusted] == [candidates[0]["name"]]
    assert [file["name"] for file in trusted_folder] == [candidates[0]["name"]]
    assert [file["name"] for file in owner_review] == [
        candidate["name"] for candidate in candidates
    ]


@pytest.mark.asyncio
async def test_trusted_auto_requires_exact_or_all_noncoordinated_title_terms():
    candidates = [
        _request_candidate("expected", "Chris Onboarding Notes"),
        _request_candidate("partial", "Team Onboarding Notes"),
    ]
    service = DriveOwnerSearchService(transport=SimpleNamespace())
    checkpoint = {
        "authority_mode": "trusted_auto",
        "request_file_kind": "document",
        "request_subject_terms": ["Chris", "onboarding"],
        "request_notes": True,
        "request": {"query": "Chris onboarding notes"},
        "coverage_counts": {},
    }
    topical, _ = await service._request_candidates(
        {"user_id": "owner"}, checkpoint, candidates, folder_scoped=False, drive_id=None
    )
    exact, _ = await service._request_candidates(
        {"user_id": "owner"},
        {**checkpoint, "request_exact_title": "Chris Onboarding Notes", "request_notes": False},
        candidates,
        folder_scoped=True,
        drive_id=None,
    )

    assert [file["name"] for file in topical] == [candidates[0]["name"]]
    assert [file["name"] for file in exact] == [candidates[0]["name"]]
    assert not search_module._note_candidate(
        checkpoint,
        {"name": "Private Financial Notes", "shortcut_name": "Chris Onboarding Notes"},
        folder_scoped=True,
    )


@pytest.mark.asyncio
async def test_request_returns_a_small_inline_page_then_uses_full_background_pages(monkeypatch):
    store = SimpleNamespace(
        clear_legacy_completed_request=AsyncMock(),
        by_client=AsyncMock(return_value=None),
        create=AsyncMock(return_value=({"jobId": "synthetic-job"}, True)),
        align_request_expiry=AsyncMock(),
    )
    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace())
    service.run_one = AsyncMock()
    service.status = AsyncMock(return_value={"jobId": "synthetic-job", "status": "queued"})
    after_page = AsyncMock()
    monkeypatch.setattr(search_module, "wake_drive_work", AsyncMock())
    await service.create_for_request(
        user_id="owner",
        request_id="12345678-1234-1234-1234-123456789012",
        request_revision=1,
        purpose={
            "purpose": "Standup notes from last 3 months",
            "periodStart": "2026-06-29",
            "periodEnd": "2026-09-29",
        },
        plan={"mode": "find", "terms": ["standup"], "file_kind": "document"},
        require_current=AsyncMock(),
        after_page=after_page,
    )
    assert service.run_one.await_args.kwargs["max_pages"] == 1
    assert service.run_one.await_args.kwargs["deadline_seconds"] == 15
    assert service.run_one.await_args.kwargs["initial_page_size"] == 25
    assert service.run_one.await_args.kwargs["after_page"] is after_page

    calls = []

    async def read(*, user_id, tool_name, arguments):
        assert user_id == "owner" and tool_name == "search_files"
        calls.append((arguments["pageSize"], arguments.get("pageToken")))
        return ExternalMcpToolResult(
            False,
            {
                "files": [],
                "nextPageToken": "next-page" if not arguments.get("pageToken") else None,
                "incompleteSearch": False,
            },
            False,
        )

    scanner = DriveOwnerSearchService(transport=SimpleNamespace(read_owner_search_page=read))
    first, _, _, _ = await scanner._page(
        {"user_id": "owner", "checkpoint": _checkpoint()}, page_size_override=25
    )
    await scanner._page({"user_id": "owner", "checkpoint": first})
    assert calls == [(25, None), (100, "next-page")]
    assert "file_page_size" not in first


@pytest.mark.asyncio
async def test_inline_page_override_applies_to_first_committed_page_only():
    checkpoint = _checkpoint()
    job = {"user_id": "owner", "job_id": "synthetic-job", "checkpoint": checkpoint}
    store = SimpleNamespace(
        claim=AsyncMock(return_value=job),
        require_current=AsyncMock(),
        commit_page=AsyncMock(return_value={"status": "running", "matched": 0}),
        release=AsyncMock(return_value="queued"),
    )
    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace())
    service._page = AsyncMock(return_value=(checkpoint, [], False, False))
    assert (
        await service.run_one(
            user_id="owner",
            job_id="synthetic-job",
            max_pages=2,
            initial_page_size=25,
            require_current=AsyncMock(),
        )
        == "queued"
    )
    assert service._page.call_args_list[0].kwargs == {"page_size_override": 25}
    assert service._page.call_args_list[1].kwargs == {}
    assert store.commit_page.await_count == 2


@pytest.mark.asyncio
async def test_oversized_rest_page_retries_same_token_at_25_before_checkpoint_advances():
    calls = []

    async def read(*, user_id, tool_name, arguments):
        assert user_id == "owner" and tool_name == "search_files"
        calls.append((arguments["pageSize"], arguments.get("pageToken")))
        if arguments["pageSize"] == 100:
            raise DriveReadError("file_too_large")
        return ExternalMcpToolResult(
            False,
            {
                "files": [_request_candidate("standup-note", "Standup notes 2026/09/26")],
                "nextPageToken": "next-25",
                "incompleteSearch": False,
            },
            False,
        )

    service = DriveOwnerSearchService(transport=SimpleNamespace(read_owner_search_page=read))
    checkpoint = _checkpoint()
    checkpoint["page_token"] = "same-token"
    updated, files, incomplete, done = await service._page(
        {"user_id": "owner", "checkpoint": checkpoint}
    )
    assert calls == [(100, "same-token"), (25, "same-token")]
    assert checkpoint["page_token"] == "same-token"  # Original is unchanged until commit.
    assert updated["page_token"] == "next-25"
    assert updated["file_page_size"] == 25
    assert [item["id"] for item in files] == ["standup-note"]
    assert not incomplete and not done


@pytest.mark.asyncio
async def test_shortcut_heavy_page_retries_small_without_losing_incomplete_search():
    calls = []
    first_25 = [
        _request_candidate(f"direct-{index}", f"Standup notes 2026/09/26 {index}")
        for index in range(25)
    ]
    shortcuts = [
        _request_candidate(
            f"shortcut-{index}",
            f"Standup notes shortcut {index}",
            search_module.SHORTCUT_MIME,
            shortcutDetails={"targetId": f"target-{index}"},
        )
        for index in range(9)
    ]

    async def read(*, user_id, tool_name, arguments):
        assert user_id == "owner" and tool_name == "search_files"
        calls.append((arguments["pageSize"], arguments.get("pageToken")))
        return ExternalMcpToolResult(
            False,
            {
                "files": first_25 + shortcuts if arguments["pageSize"] == 100 else first_25,
                "nextPageToken": "next-100" if arguments["pageSize"] == 100 else "next-25",
                "incompleteSearch": arguments["pageSize"] == 100,
            },
            False,
        )

    service = DriveOwnerSearchService(transport=SimpleNamespace(read_owner_search_page=read))
    checkpoint = _checkpoint()
    checkpoint["page_token"] = "same-token"
    updated, files, incomplete, done = await service._page(
        {"user_id": "owner", "checkpoint": checkpoint}
    )
    assert calls == [(100, "same-token"), (25, "same-token")]
    assert checkpoint["page_token"] == "same-token"
    assert updated["page_token"] == "next-25" and updated["file_page_size"] == 25
    assert len(files) == 25 and incomplete and not done


def _real_rest_service(monkeypatch, respond):
    # Exercise the production files.list -> REST compatibility projection ->
    # worker seam. A synthetic MCP payload would miss dropped shortcutDetails.
    class Adapter(GoogleDriveAdapter):
        def __init__(self):
            self.calls = []

        async def _get(self, path, *, access_token, params, limit, resource_keys=None):
            assert access_token == "synthetic-token"
            self.calls.append((path, params, resource_keys))
            if path == "/files":
                assert params["fields"] == LIST_FIELDS
            elif path.startswith("/files/"):
                assert params["fields"] == FACT_FIELDS
            return json.dumps(respond(path, params, resource_keys)).encode()

    row = {
        "status": "connected",
        "validation_state": "verified",
        "verified_policy_hash": LIVE_POLICY_HASH,
        "connection_generation": 7,
    }
    oauth = SimpleNamespace(
        current_credential=AsyncMock(return_value=(row, {"accessToken": "synthetic-token"})),
        lifecycle=SimpleNamespace(read=AsyncMock(return_value=row)),
    )
    monkeypatch.setattr(rest, "connector_feature_enabled", lambda *_: True)
    adapter = Adapter()
    return DriveOwnerSearchService(
        transport=rest.GoogleDriveRestTransport(oauth=oauth, adapter=adapter)
    ), adapter


@pytest.mark.asyncio
async def test_request_search_returns_separate_coordinated_categories(monkeypatch):
    plan = {"mode": "find", "terms": ["contract", "invoice"], "file_kind": "document"}
    purpose = {"purpose": "Contracts and invoices from last 3 months"}
    queries, _ = compile_request_queries(plan, purpose, "UTC")

    def respond(path, params, keys):
        if path == "/drives":
            return {"drives": []}
        assert path == "/files" and params["corpora"] == "user"
        assert "fullText contains 'contract'" in params["q"]
        assert "fullText contains 'invoice'" in params["q"]
        assert ")) or ((" in params["q"]
        return {
            "files": [
                _provider_file("contract-only", "Employment contract"),
                _provider_file("invoice-only", "August invoice"),
            ]
        }

    service, _ = _real_rest_service(monkeypatch, respond)
    checkpoint = _checkpoint()
    checkpoint.update(
        request_subject_terms=plan["terms"],
        request_notes=False,
        arguments=queries[0]["arguments"],
        queries=queries,
        requested_period=None,
    )
    checkpoint, files, incomplete, done = await service._page(
        {"user_id": "owner", "checkpoint": checkpoint}
    )
    assert not incomplete and not done
    assert {item["id"] for item in files} == {"contract-only", "invoice-only"}


async def test_real_rest_projection_resolves_shortcut_resource_key_and_live_facts(monkeypatch):
    alias = _provider_file(
        "alias",
        "Stand Up 2026/09/26 - Notes by Gemini",
        search_module.SHORTCUT_MIME,
        shortcutDetails={
            "targetId": "original",
            # Google documents this as a possibly stale snapshot.
            "targetMimeType": "application/vnd.google-apps.document",
            "targetResourceKey": "target-key",
            "snippet": "must not cross the metadata projection",
        },
    )

    def respond(path, params, keys):
        if path == "/files":
            return {"files": [alias], "incompleteSearch": False}
        assert path == "/files/original" and keys == {"original": "target-key"}
        return _provider_file(
            "original",
            "Standup note.pdf",
            "application/pdf",
            createdTime="2026-01-01T00:00:00Z",
            modifiedTime="2026-01-01T00:00:00Z",
            resourceKey="target-key",
            driveId="team-drive",
        )

    service, adapter = _real_rest_service(monkeypatch, respond)
    checkpoint, files, incomplete, done = await service._page(
        {"user_id": "owner", "checkpoint": _checkpoint()}
    )
    assert not incomplete and not done
    assert [(item["id"], item["mimeType"]) for item in files] == [("original", "application/pdf")]
    assert files[0]["resourceKey"] == "target-key"
    assert files[0]["shareable"] is True
    assert files[0]["createdTime"] == "2026-01-01T00:00:00Z"
    assert files[0]["shortcutName"] == alias["name"]
    assert checkpoint["coverage_counts"]["resolvedShortcutCount"] == 1
    assert "targetResourceKey" in LIST_FIELDS and "resourceKey" in FACT_FIELDS
    assert len(adapter.calls) == 2


@pytest.mark.asyncio
async def test_request_folder_children_need_topic_and_search_carries_shareability():
    checkpoint = _checkpoint()
    checkpoint.update(
        request_file_kind="document",
        request_subject_terms=["onboarding"],
        request_notes=False,
    )
    service = DriveOwnerSearchService()
    files, incomplete = await service._request_candidates(
        {"user_id": "owner"},
        checkpoint,
        [
            _request_candidate("wanted", "Onboarding guide", capabilities={"canShare": False}),
            _request_candidate(
                "allowed",
                "Onboarding checklist",
                clientEncryptionDetails={"encryptionState": "unencrypted"},
            ),
            _request_candidate(
                "encrypted",
                "Onboarding encrypted guide",
                clientEncryptionDetails={"encryptionState": "encrypted"},
            ),
            _request_candidate("unknown", "Onboarding summary", capabilities={}),
            _request_candidate("unrelated", "Engineering resume"),
            _request_candidate("photo", "IMG_0795.HEIC", "image/heic"),
        ],
        folder_scoped=True,
        drive_id=None,
    )
    assert not incomplete
    assert {item["id"]: item["shareable"] for item in files} == {
        "wanted": False,
        "allowed": True,
        "encrypted": False,
        "unknown": False,
    }
    assert checkpoint["coverage_counts"]["excludedByTopicCount"] == 1
    assert checkpoint["coverage_counts"]["excludedByKindCount"] == 1
    assert {item["unavailableReason"] for item in files if item["shareable"] is False} == {
        "source_not_shareable",
        "shareability_unverified",
    }

    # A direct Drive fullText hit can have a generic title. Its presence in
    # the provider result is stronger than a parent-folder-only association.
    direct, _ = await service._request_candidates(
        {"user_id": "owner"},
        checkpoint,
        [_request_candidate("full-text-hit", "Meeting notes")],
        folder_scoped=False,
        drive_id=None,
    )
    assert [item["id"] for item in direct] == ["full-text-hit"]


async def test_matching_folder_shortcut_pages_generic_gemini_notes_and_nested_folders(monkeypatch):
    folder_alias = _provider_file(
        "folder-alias",
        "Hushh Stand Up recurring",
        search_module.SHORTCUT_MIME,
        createdTime="2025-01-01T00:00:00Z",
        modifiedTime="2025-01-01T00:00:00Z",
        shortcutDetails={
            "targetId": "notes-folder",
            "targetMimeType": search_module.FOLDER_MIME,
            "targetResourceKey": "folder-key",
        },
    )

    def respond(path, params, keys):
        if path == "/files/notes-folder":
            assert keys == {"notes-folder": "folder-key"}
            return _provider_file(
                "notes-folder",
                "Meet recordings",
                search_module.FOLDER_MIME,
                createdTime="2025-01-01T00:00:00Z",
                resourceKey="folder-key",
                driveId="team-drive",
            )
        if path == "/drives":
            return {"drives": [{"id": "team-drive", "name": "Team"}]}
        assert path == "/files"
        q = params["q"]
        if "in parents" not in q:
            return {"files": [folder_alias] if params["corpora"] == "user" else []}
        assert params["corpora"] == "drive" and params["driveId"] == "team-drive"
        assert "fullText" not in q  # Child names need not repeat the folder's topic.
        if "'notes-folder' in parents" in q:
            assert keys == {"notes-folder": "folder-key"}
            if params.get("pageToken") == "folder-next":
                return {
                    "files": [
                        _provider_file("nested", "September", search_module.FOLDER_MIME),
                        _provider_file("old", "Meeting 2026/01/01 - Notes by Gemini"),
                        _provider_file("agenda", "Standup agenda"),
                        _provider_file("video", "Standup recording", "video/mp4"),
                    ]
                }
            return {
                "files": [
                    _provider_file("generic", "Meeting started 2026/09/26 - Notes by Gemini"),
                    _provider_file("text-note", "Standup notes.txt", "text/plain"),
                ],
                "nextPageToken": "folder-next",
            }
        assert "'nested' in parents" in q and keys is None
        return {
            "files": [
                _provider_file("nested-note", "Meeting started 2026/09/25 - Notes by Gemini"),
                folder_alias,  # A shortcut cycle must not re-enqueue the original folder.
                _provider_file("unrelated", "Welcome to the team"),
            ]
        }

    service, adapter = _real_rest_service(monkeypatch, respond)
    checkpoint = _checkpoint()
    files = []
    for _ in range(12):
        checkpoint, page, incomplete, done = await service._page(
            {"user_id": "owner", "checkpoint": checkpoint}
        )
        assert not incomplete
        files.extend(page)
        if done:
            break
    else:
        pytest.fail("The folder traversal did not exhaust its durable queue")
    assert {item["id"] for item in files} == {"generic", "text-note", "nested-note"}
    counts = checkpoint["coverage_counts"]
    assert counts["matchingFoldersDiscovered"] == counts["matchingFoldersExhausted"] == 2
    assert counts["excludedByDateCount"] == 1
    assert counts["excludedByKindCount"] == 1
    assert counts["excludedByNoteTypeCount"] == 2
    assert checkpoint["folder_queue"] == []
    assert any(params.get("pageToken") == "folder-next" for _, params, _ in adapter.calls)


async def test_user_shared_drive_pages_exhaust_even_when_a_file_page_is_empty(monkeypatch):
    def respond(path, params, keys):
        if path == "/drives":
            if params.get("pageToken") == "more-drives":
                return {"drives": [{"id": "drive-two", "name": "Two"}]}
            return {"drives": [{"id": "drive-one", "name": "One"}], "nextPageToken": "more-drives"}
        assert path == "/files" and keys is None
        if params["corpora"] == "user":
            if params.get("pageToken") == "user-next":
                return {
                    "files": [
                        _provider_file(
                            "shared-with-me",
                            "Shared standup notes",
                            capabilities={"canShare": False},
                        )
                    ]
                }
            return {"files": [], "nextPageToken": "user-next"}
        assert params["corpora"] == "drive"
        if params["driveId"] == "drive-one" and not params.get("pageToken"):
            return {"files": [], "nextPageToken": "drive-next"}
        return {"files": [_provider_file(params["driveId"], "Team standup notes")]}

    service, adapter = _real_rest_service(monkeypatch, respond)
    checkpoint, found = _checkpoint(), []
    for _ in range(12):
        checkpoint, page, incomplete, done = await service._page(
            {"user_id": "owner", "checkpoint": checkpoint}
        )
        assert not incomplete
        found.extend(page)
        if done:
            break
    assert done
    assert {item["id"] for item in found} == {"shared-with-me", "drive-one", "drive-two"}
    assert next(item for item in found if item["id"] == "shared-with-me")["shareable"] is False
    assert all(item["shareable"] is True for item in found if item["id"] != "shared-with-me")
    assert not any("sharedWithMe = true" in params.get("q", "") for _, params, _ in adapter.calls)
    assert any(params.get("pageToken") == "more-drives" for _, params, _ in adapter.calls)
    assert any(params.get("pageToken") == "drive-next" for _, params, _ in adapter.calls)


async def test_shortcut_provider_transient_is_not_a_complete_unavailable_target(monkeypatch):
    def respond(path, params, keys):
        if path == "/files":
            return {
                "files": [
                    _provider_file(
                        "alias",
                        "Standup notes",
                        search_module.SHORTCUT_MIME,
                        shortcutDetails={
                            "targetId": "original",
                            "targetMimeType": "application/vnd.google-apps.document",
                        },
                    )
                ]
            }
        raise DriveReadError("provider_unavailable", retryable=True)

    service, _ = _real_rest_service(monkeypatch, respond)
    with pytest.raises(DriveReadError, match="provider_unavailable") as error:
        await service._page({"user_id": "owner", "checkpoint": _checkpoint()})
    assert error.value.retryable


@pytest.mark.parametrize("reason", ["rateLimitExceeded", "userRateLimitExceeded"])
async def test_http_rate_limited_shortcut_lookup_retries_page_without_publishing_exclusion(
    monkeypatch, reason
):
    service, _ = _real_rest_service(monkeypatch, lambda *_: None)
    service.transport.adapter = GoogleDriveAdapter()
    original = httpx.AsyncClient
    requests = []

    def handler(request):
        requests.append(request)
        if request.url.path.endswith("/files"):
            payload = {
                "files": [
                    _provider_file(
                        "alias",
                        "Standup 2026/09/26 - Notes",
                        search_module.SHORTCUT_MIME,
                        shortcutDetails={
                            "targetId": "original",
                            "targetMimeType": "application/vnd.google-apps.document",
                        },
                    )
                ]
            }
            return httpx.Response(200, stream=httpx.ByteStream(json.dumps(payload).encode()))
        payload = {"error": {"code": 403, "errors": [{"reason": reason}]}}
        return httpx.Response(403, stream=httpx.ByteStream(json.dumps(payload).encode()))

    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kw: original(**kw, transport=httpx.MockTransport(handler))
    )
    checkpoint = _checkpoint()
    job = {"job_id": "synthetic-job", "user_id": "owner", "checkpoint": checkpoint}
    store = SimpleNamespace(
        claim=AsyncMock(return_value=job),
        require_current=AsyncMock(),
        commit_page=AsyncMock(),
        release=AsyncMock(return_value="queued"),
    )
    service.store = store
    assert await service.run_one(user_id="owner", job_id="synthetic-job") == "queued"
    store.commit_page.assert_not_awaited()
    store.release.assert_awaited_once_with(job, error="provider_unavailable", retryable=True)
    assert checkpoint["coverage_counts"] == {}
    assert checkpoint["phase"] == "user" and checkpoint["page_token"] is None
    assert len(requests) == 2 and all(request.method == "GET" for request in requests)


async def test_unavailable_folder_and_traversal_limits_cannot_claim_completeness(monkeypatch):
    def respond(path, params, keys):
        if path == "/files":
            return {
                "files": [
                    _provider_file(
                        "folder-alias",
                        "Standup",
                        search_module.SHORTCUT_MIME,
                        shortcutDetails={
                            "targetId": "folder",
                            "targetMimeType": search_module.FOLDER_MIME,
                        },
                    )
                ]
            }
        raise DriveReadError("source_unavailable")

    service, _ = _real_rest_service(monkeypatch, respond)
    checkpoint, files, incomplete, _ = await service._page(
        {"user_id": "owner", "checkpoint": _checkpoint()}
    )
    assert incomplete and files == []
    assert checkpoint["coverage_counts"]["unavailableFolderCount"] == 1

    def folders(path, params, keys):
        return {
            "files": [
                _provider_file("folder-one", "Standup", search_module.FOLDER_MIME),
                _provider_file("folder-two", "Standup", search_module.FOLDER_MIME),
            ],
            "nextPageToken": "more",
        }

    monkeypatch.setattr(search_module, "MAX_REQUEST_FOLDERS", 1)
    service, _ = _real_rest_service(monkeypatch, folders)
    checkpoint, _, incomplete, _ = await service._page(
        {"user_id": "owner", "checkpoint": _checkpoint()}
    )
    assert incomplete and checkpoint["coverage_counts"]["workLimitReached"]
    assert len(checkpoint["folder_queue"]) == 1

    checkpoint = _checkpoint()
    checkpoint["coverage_counts"]["providerFilePages"] = search_module.MAX_REQUEST_FILE_PAGES - 1
    checkpoint, _, incomplete, done = await service._page(
        {"user_id": "owner", "checkpoint": checkpoint}
    )
    assert incomplete and done and checkpoint["coverage_counts"]["workLimitReached"]


@pytest.mark.asyncio
@pytest.mark.parametrize("handoff_failure", ["unavailable", "deadline"])
@pytest.mark.parametrize("page_status", ["running", "completed"])
async def test_page_handoff_failure_preserves_checkpoint_without_provider_retry(
    monkeypatch, handoff_failure, page_status
):
    import asyncio

    checkpoint = _checkpoint()
    done = page_status == "completed"
    committed_checkpoint = {**checkpoint, "page_token": None if done else "committed-next-page"}
    job = {
        "user_id": "owner",
        "job_id": "synthetic-job",
        "checkpoint": checkpoint,
        "lease_id": "claimed-lease",
    }
    persisted = {"status": "running", "lease_id": job["lease_id"]}

    async def commit_page(*args, **kwargs):
        persisted.update(status=page_status, lease_id=None if done else job["lease_id"])
        return {"status": page_status, "matched": 25}

    async def release(*args, **kwargs):
        # A final commit already clears the persisted lease. Cleanup must
        # return that terminal state, never reopen the completed search.
        if persisted["lease_id"] is None:
            assert persisted["status"] == "completed"
            return "completed"
        return "queued"

    store = SimpleNamespace(
        claim=AsyncMock(return_value=job),
        require_current=AsyncMock(),
        commit_page=AsyncMock(side_effect=commit_page),
        release=AsyncMock(side_effect=release),
    )
    wake = AsyncMock()
    monkeypatch.setattr(search_module, "wake_drive_work", wake)
    scanner = DriveOwnerSearchService(store=store, transport=SimpleNamespace())
    scanner._page = AsyncMock(return_value=(committed_checkpoint, [{}] * 25, False, done))

    async def unavailable_handoff(**kwargs):
        assert job["checkpoint"] == committed_checkpoint
        if handoff_failure == "deadline":
            await asyncio.sleep(2)
        raise RuntimeError("handoff unavailable")

    assert await scanner.run_one(
        user_id="owner",
        job_id="synthetic-job",
        deadline_seconds=1,
        after_page=unavailable_handoff,
    ) == ("completed" if done else "queued")
    scanner._page.assert_awaited_once()
    store.commit_page.assert_awaited_once()
    if done and handoff_failure == "unavailable":
        store.release.assert_not_awaited()
    else:
        store.release.assert_awaited_once_with(job)
    wake.assert_awaited_once_with("suggestions")
    assert job["checkpoint"] == committed_checkpoint
    if done:
        from hushh_mcp.services.drive_trusted_auto_service import DriveTrustedAutoService

        assert persisted == {"status": "completed", "lease_id": None}
        # The search is no longer due. Its committed request still enters the
        # independent batch continuation lane after the wake.
        auto = DriveTrustedAutoService(
            sharing=SimpleNamespace(
                due_trusted_batches=AsyncMock(
                    return_value=[
                        {
                            "user_id": "owner",
                            "request_id": "pending-request",
                        }
                    ]
                )
            ),
            bulk=object(),
            payment=object(),
            wake=wake,
        )
        auto.share_available = AsyncMock(return_value=1)
        assert await auto.continue_batches(max_jobs=1) == 1
        auto.share_available.assert_awaited_once_with(user_id="owner", request_id="pending-request")

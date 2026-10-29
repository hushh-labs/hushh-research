"""Provider metadata search for a request includes date-named shortcut targets."""

import json
from copy import deepcopy
from datetime import UTC, date, datetime, timedelta
from functools import partial
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from hushh_mcp.services import drive_owner_search_service as search_module
from hushh_mcp.services import google_drive_rest_transport as rest
from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_owner_allowed import LEGACY_REQUEST_POLICY
from hushh_mcp.services.drive_owner_search_service import (
    DriveOwnerSearchService,
    compile_request_queries,
)
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_request_bulk_service import (
    DriveRequestBulkService,
    _deterministic_statement_plan,
)
from hushh_mcp.services.drive_request_candidate_assessment import assess_request_candidates
from hushh_mcp.services.drive_request_package_service import assessment_policy_version
from hushh_mcp.services.drive_request_package_store import _public_package, _review_status
from hushh_mcp.services.drive_request_semantic_plan import (
    compile_semantic_queries,
    semantic_plan_digest,
)
from hushh_mcp.services.drive_trusted_auto_service import DriveTrustedAutoService
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.google_drive_adapter import (
    FACT_FIELDS,
    LIST_FIELDS,
    LIVE_POLICY_HASH,
    DriveReadError,
    GoogleDriveAdapter,
)


@pytest.mark.asyncio
@pytest.mark.parametrize("model_available", [True, False])
async def test_sealed_semantic_request_uses_model_without_lexical_fallback(model_available):
    from hushh_mcp.services.drive_suggestion_service import SemanticLiveSearchModelPlan

    checkpoint = _semantic_checkpoint("Ember Vale")
    context = {
        "purpose": {
            **checkpoint["semantic_purpose"],
            "periodStart": "2026-09-01",
            "periodEnd": "2026-09-30",
        },
        "revision": 3,
        "semanticSearch": True,
        "autoshare": True,
    }
    planned = {
        "mode": "find",
        "file_kind": "any",
        "subject_scope": "specific_records",
        "subject_complete": True,
        "semantic_intent": "other",
        "discovery_clues": ["Ember Vale"],
        "required_entities": [],
        "expected_document_anatomy": "A record about the requested person.",
        "semantic_query": checkpoint["semantic_plan"],
    }
    SemanticLiveSearchModelPlan.model_validate(planned)
    planner = AsyncMock(
        return_value=planned, side_effect=None if model_available else TimeoutError()
    )
    search = SimpleNamespace(
        store=SimpleNamespace(by_client=AsyncMock(return_value=None)),
        create_for_request=AsyncMock(return_value={"jobId": "semantic-job"}),
    )
    service = DriveRequestBulkService(
        sharing=SimpleNamespace(request_bulk_context=AsyncMock(return_value=context)),
        search=search,
        semantic_planner=planner,
        require_owner=AsyncMock(),
        owner_index=SimpleNamespace(owner_vocabulary=AsyncMock(return_value=None)),
    )
    service._brain_plan = AsyncMock(side_effect=AssertionError("lexical fallback"))
    if model_available:
        assert await service.start_search(
            user_id="owner", request_id="request", authority_mode="trusted_auto"
        ) == {"jobId": "semantic-job"}
        arguments = search.create_for_request.await_args.kwargs
        assert arguments["semantic_search"] is True and arguments["plan_source"] == "model"
        assert arguments["plan"]["semantic_query"] == checkpoint["semantic_plan"]
    else:
        with pytest.raises(DriveReadError, match="provider_unavailable"):
            await service.start_search(
                user_id="owner", request_id="request", authority_mode="trusted_auto"
            )
        search.create_for_request.assert_not_awaited()
    service._brain_plan.assert_not_awaited()


@pytest.mark.asyncio
async def test_failed_v1_request_resumes_same_search_without_replanning_or_new_job():
    context = {
        "purpose": {
            "purpose": "3 months of meeting notes",
            "periodStart": "2026-09-02",
            "periodEnd": "2026-10-02",
        },
        "revision": 7,
        "agentPackageRequired": True,
        "v1LiveRequest": True,
    }
    store = SimpleNamespace(
        by_client=AsyncMock(return_value={"status": "failed", "jobId": "same-job"}),
        retry_failed_request=AsyncMock(
            return_value=({"status": "queued", "jobId": "same-job"}, True)
        ),
    )
    search = SimpleNamespace(
        store=store,
        create_for_request=AsyncMock(side_effect=AssertionError("new search created")),
    )
    sharing = SimpleNamespace(
        request_bulk_context=AsyncMock(return_value=context),
        package_preparation_authority=AsyncMock(),
    )
    planner = AsyncMock(side_effect=AssertionError("request replanned"))
    wake = AsyncMock()
    service = DriveRequestBulkService(
        sharing=sharing,
        search=search,
        planner=planner,
        require_owner=AsyncMock(),
        wake=wake,
    )

    state = await service.start_search(user_id="owner", request_id="same-request")

    assert state == {"status": "queued", "jobId": "same-job"}
    store.retry_failed_request.assert_awaited_once_with(
        user_id="owner",
        request_id="same-request",
        request_revision=7,
        authority_mode="agent_package",
    )
    wake.assert_awaited_once_with("v1")
    planner.assert_not_awaited()
    search.create_for_request.assert_not_awaited()


@pytest.mark.asyncio
async def test_search_release_keeps_local_contract_error_in_encrypted_checkpoint(
    monkeypatch,
):
    store = DriveOwnerSearchStore(db=SimpleNamespace())
    updated = []
    connection = SimpleNamespace(execute=lambda _statement, params: updated.append(params))
    monkeypatch.setattr(store, "_lock", lambda *_args: None)
    monkeypatch.setattr(
        store,
        "_owned",
        lambda *_args, **_kwargs: {
            "status": "running",
            "lease_id": "lease",
            "retry_count": 0,
            "job_id": "job",
        },
    )
    monkeypatch.setattr(
        store, "_transaction", AsyncMock(side_effect=lambda operation: operation(connection))
    )
    detail = {"page_token": "saved-page"}
    monkeypatch.setattr(store, "_checkpoint", lambda _row: detail)
    monkeypatch.setattr(store, "_seal", lambda *_args: "sealed-checkpoint")
    state = await store.release(
        {"user_id": "owner", "job_id": "job", "lease_id": "lease"},
        error="operation_not_allowed",
    )
    assert state == "failed"
    assert updated[0]["code"] == "provider_unavailable"
    assert updated[0]["checkpoint"] == "sealed-checkpoint"
    assert detail == {
        "page_token": "saved-page",
        "last_search_failure_cause": "operation_not_allowed",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(("draw", "retry_count", "delay"), [(0.0, 0, 2.5), (0.999, 1, 9.995)])
async def test_rate_limited_search_retries_back_off_with_jitter(
    monkeypatch, draw, retry_count, delay
):
    from hushh_mcp.services import drive_owner_search_store as store_module

    store = DriveOwnerSearchStore(db=SimpleNamespace())
    updated = []
    connection = SimpleNamespace(execute=lambda _statement, params: updated.append(params))
    monkeypatch.setattr(store, "_lock", lambda *_args: None)
    monkeypatch.setattr(
        store,
        "_owned",
        lambda *_args, **_kwargs: {
            "status": "running",
            "lease_id": "lease",
            "retry_count": retry_count,
            "job_id": "job",
        },
    )
    monkeypatch.setattr(
        store, "_transaction", AsyncMock(side_effect=lambda operation: operation(connection))
    )
    monkeypatch.setattr(store_module.random, "random", lambda: draw)
    state = await store.release(
        {"user_id": "owner", "job_id": "job", "lease_id": "lease"},
        error="provider_unavailable",
        retryable=True,
    )
    # Same durable cursor, queued again within [half, full] of 5s, 10s, 20s.
    assert state == "queued"
    assert updated[0]["delay"] == pytest.approx(delay)
    assert updated[0]["retries"] == retry_count + 1


@pytest.mark.parametrize(
    ("search_status", "incomplete"),
    [("failed", False), ("limited", True), ("stopped", False), ("completed", True)],
)
def test_terminal_search_overrides_pending_evaluation_without_allowing_payment(
    search_status, incomplete
):
    status = _review_status(
        {
            "status": search_status,
            "incomplete_search": incomplete,
            "evaluation_status": "pending",
        }
    )
    assert status == "unavailable"
    assert _public_package({"selected_positions": [1]}, status=status)["canAllow"] is False


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


def test_statement_coverage_search_retries_with_broad_terms_without_a_timestamp_cut():
    plan = {
        "mode": "find",
        "terms": ["Schwab", "brokerage", "statement"],
        "file_kind": "document",
        "time_intent": "document_coverage",
    }
    purpose = {
        "purpose": "All Schwab brokerage statements from 2026",
        "periodStart": "2026-09-01",
        "periodEnd": "2026-10-09",
    }
    queries, period = compile_request_queries(plan, purpose, "America/New_York")

    assert len(queries) == 2
    precise, broad = (entry["arguments"]["query"] for entry in queries)
    assert precise.count(" and ") > broad.count(" and ")
    assert " or " in broad
    assert all(term in precise and term in broad for term in plan["terms"])
    assert "modifiedTime >= " not in broad and "createdTime >= " not in broad
    assert period == {
        "start": "2026-09-01",
        "end": "2026-10-09",
        "timezone": "America/New_York",
    }

    # Explicit file-activity requests retain the precise query: those may
    # enter the existing automatic-share lane and need its title/date gates.
    activity, _ = compile_request_queries(
        {**plan, "time_intent": "file_activity"}, purpose, "America/New_York"
    )
    assert len(activity) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("request_text", "expected_terms"),
    [
        ("Last months brokerage statements", ["brokerage", "statement"]),
        (
            "I need all brokerage statements that contains Schwab from 2026",
            ["Schwab", "brokerage", "statement"],
        ),
    ],
)
async def test_new_legacy_statement_uses_gemini_coverage_plan(request_text, expected_terms):
    purpose = {
        "purpose": request_text,
        "periodStart": "2026-09-01",
        "periodEnd": "2026-10-09",
    }
    context = {
        "purpose": purpose,
        "revision": 2,
        "requestTimeZone": "Asia/Kolkata",
        "requestCreatedAt": datetime(2026, 10, 13, tzinfo=UTC),
    }
    planner = AsyncMock(
        return_value={
            "mode": "find",
            "terms": expected_terms,
            "file_kind": "document",
            "time_intent": "document_coverage",
            "subject_scope": "specific_records",
            "subject_complete": True,
            "semantic_intent": "institutional_statement",
        }
    )
    search = SimpleNamespace(
        store=SimpleNamespace(by_client=AsyncMock(return_value=None)),
        create_for_request=AsyncMock(return_value={"jobId": "job", "status": "queued"}),
    )
    service = DriveRequestBulkService(
        sharing=SimpleNamespace(request_bulk_context=AsyncMock(return_value=context)),
        search=search,
        planner=planner,
        require_owner=AsyncMock(),
    )

    await service.start_search(user_id="owner", request_id="request", authority_mode="trusted_auto")

    planner.assert_awaited_once()
    frozen = search.create_for_request.await_args.kwargs
    assert frozen["plan"]["terms"] == expected_terms
    assert frozen["plan"]["time_intent"] == "document_coverage"
    assert frozen["plan"]["file_kind"] == "document"
    assert frozen["purpose"] == purpose
    queries, period = compile_request_queries(
        frozen["plan"], purpose, "Asia/Kolkata", requested_at=context["requestCreatedAt"]
    )
    assert len(queries) == 2
    assert all("modifiedTime >= " not in row["arguments"]["query"] for row in queries)
    assert period == {
        "start": "2026-09-01",
        "end": "2026-10-09",
        "timezone": "Asia/Kolkata",
    }


class _VertexRefused(Exception):
    """Stands in for a provider 403 such as a suspended Vertex project."""


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure,reason",
    [
        (TimeoutError(), "timeout"),
        (_VertexRefused("403 PERMISSION_DENIED"), "model_error"),
        (ValueError("planner output failed its schema twice"), "invalid_plan"),
    ],
)
@pytest.mark.parametrize(
    "request_text,plan_name,terms",
    [
        ("3 months meeting notes", "meeting_notes", ["meeting", "notes"]),
        ("Last months brokerage statements", "statements", ["brokerage", "statement"]),
    ],
)
async def test_planner_failure_keeps_searching_with_the_recorded_deterministic_plan(
    failure, reason, request_text, plan_name, terms
):
    purpose = {"purpose": request_text, "periodStart": "2026-09-02", "periodEnd": "2026-10-02"}
    context = {"purpose": purpose, "revision": 1, "requestTimeZone": "UTC"}
    search = SimpleNamespace(
        store=SimpleNamespace(by_client=AsyncMock(return_value=None)),
        create_for_request=AsyncMock(return_value={"jobId": "job", "status": "queued"}),
    )
    planner = AsyncMock(side_effect=failure)
    service = DriveRequestBulkService(
        sharing=SimpleNamespace(request_bulk_context=AsyncMock(return_value=context)),
        search=search,
        planner=planner,
        require_owner=AsyncMock(),
    )

    await service.start_search(user_id="owner", request_id="request", authority_mode="trusted_auto")

    frozen = search.create_for_request.await_args.kwargs
    assert frozen["plan"]["terms"] == terms
    # The substitute leaves every candidate to the owner's exact review.
    assert frozen["plan"]["time_intent"] == "document_coverage"
    assert frozen["planner_fallback"] == {"reason": reason, "plan": plan_name}


@pytest.mark.asyncio
async def test_planner_failure_without_a_deterministic_plan_still_waits():
    purpose = {"purpose": "tax documents", "periodStart": "2026-09-02", "periodEnd": "2026-10-02"}
    search = SimpleNamespace(
        store=SimpleNamespace(by_client=AsyncMock(return_value=None)),
        create_for_request=AsyncMock(),
    )
    service = DriveRequestBulkService(
        sharing=SimpleNamespace(
            request_bulk_context=AsyncMock(return_value={"purpose": purpose, "revision": 1})
        ),
        search=search,
        planner=AsyncMock(side_effect=TimeoutError()),
        require_owner=AsyncMock(),
    )
    with pytest.raises(TimeoutError):
        await service.start_search(
            user_id="owner", request_id="request", authority_mode="trusted_auto"
        )
    search.create_for_request.assert_not_awaited()


@pytest.mark.asyncio
async def test_planner_fallback_is_frozen_into_the_search_checkpoint(monkeypatch):
    store = SimpleNamespace(
        by_client=AsyncMock(return_value=None),
        create=AsyncMock(return_value=({"jobId": "synthetic-job"}, False)),
    )
    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace())
    request = {
        "user_id": "owner",
        "request_id": "12345678-1234-1234-1234-123456789012",
        "request_revision": 1,
        "purpose": {"purpose": "meeting notes", **{"periodStart": "2026-09-02"}},
        "plan": {
            "mode": "find",
            "terms": ["meeting", "notes"],
            "file_kind": "document",
            "time_intent": "document_coverage",
        },
        "require_current": AsyncMock(),
        "authority_mode": "trusted_auto",
    }
    request["purpose"]["periodEnd"] = "2026-10-02"
    await service.create_for_request(
        **request, planner_fallback={"reason": "timeout", "plan": "meeting_notes"}
    )
    checkpoint = store.create.await_args.kwargs["checkpoint"]
    assert checkpoint["planner_fallback"] == {"reason": "timeout", "plan": "meeting_notes"}
    with pytest.raises(DriveReadError, match="invalid_argument"):
        await service.create_for_request(
            **request, planner_fallback={"reason": "the query text", "plan": "meeting_notes"}
        )


@pytest.mark.asyncio
async def test_statement_coverage_cannot_become_automatic_file_activity():
    purpose = {
        "purpose": "Schwab brokerage statements for three months",
        "periodStart": "2026-07-01",
        "periodEnd": "2026-09-30",
    }
    context = {"purpose": purpose, "revision": 1, "requestTimeZone": "UTC"}
    planner = AsyncMock(
        return_value={
            "mode": "find",
            "terms": ["Schwab", "statement"],
            "file_kind": "document",
            "time_intent": "file_activity",
            "subject_scope": "specific_records",
            "subject_complete": True,
        }
    )
    search = SimpleNamespace(
        store=SimpleNamespace(by_client=AsyncMock(return_value=None)),
        create_for_request=AsyncMock(),
    )
    service = DriveRequestBulkService(
        sharing=SimpleNamespace(request_bulk_context=AsyncMock(return_value=context)),
        search=search,
        planner=planner,
        require_owner=AsyncMock(),
    )

    with pytest.raises(DriveReadError, match="invalid_argument"):
        await service.start_search(
            user_id="owner", request_id="request", authority_mode="trusted_auto"
        )
    assert planner.await_count == 2
    search.create_for_request.assert_not_awaited()


@pytest.mark.asyncio
async def test_new_legacy_statement_uses_live_provider_and_suggestions_worker(monkeypatch):
    purpose = {
        "purpose": "I need all brokerage statements that contains Schwab from 2026",
        "periodStart": "2026-09-01",
        "periodEnd": "2026-10-09",
    }
    store = SimpleNamespace(
        by_client=AsyncMock(return_value=None),
        create=AsyncMock(return_value=({"jobId": "job"}, True)),
        align_request_expiry=AsyncMock(),
    )
    service = DriveOwnerSearchService(store=store)
    service.run_one = AsyncMock()
    service.status = AsyncMock(return_value={"jobId": "job", "status": "queued"})
    wake = AsyncMock()
    monkeypatch.setattr(search_module, "wake_drive_work", wake)

    await service.create_for_request(
        user_id="owner",
        request_id="12345678-1234-1234-1234-123456789012",
        request_revision=0,
        purpose=purpose,
        plan=_deterministic_statement_plan(purpose).model_dump(mode="json"),
        require_current=AsyncMock(),
        authority_mode="trusted_auto",
    )

    frozen = store.create.await_args.kwargs
    assert frozen["v1_statement_search"] is False
    assert frozen["checkpoint"]["evidence_route"] == "provider"
    assert frozen["checkpoint"]["request_owner_review_required"] is True
    wake.assert_awaited_once_with("suggestions")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("marked_v1", "restored_policy"), [(False, False), (True, False), (False, True)]
)
async def test_legacy_statement_replan_keeps_job_positions_and_worker_lane(
    monkeypatch, marked_v1, restored_policy
):
    request_id = "12345678-1234-1234-1234-123456789012"
    purpose = {
        "purpose": "Schwab brokerage statements from 2026",
        "periodStart": "2026-09-01",
        "periodEnd": "2026-10-09",
    }
    plan = _deterministic_statement_plan(purpose)
    queries, period = compile_request_queries(plan.model_dump(mode="json"), purpose, "UTC")
    old_query = {"arguments": {"query": "name contains 'Schwab'", "orderBy": "modifiedTime desc"}}
    checkpoint = {
        "request_origin_id": request_id,
        "request_revision": 2,
        "evidence_route": "provider",
        "authority_mode": "trusted_auto",
        "request": {"query": purpose["purpose"], "timezone": "UTC"},
        "queries": [old_query],
        "arguments": old_query["arguments"],
        "phase": "files",
        "page_token": "old-provider-token",
    }
    now = datetime.now(UTC)
    row = {
        "job_id": "87654321-4321-4321-4321-210987654321",
        "status": "completed",
        "connection_generation": 7,
        "checkpoint": checkpoint,
        "lease_id": None,
        "v1_statement_search": marked_v1,
    }
    request = {
        "status": "pending",
        "revision": 2,
        "bulk_search_started_at": now,
        "access_stop_requested_at": None,
        "expires_at": now + timedelta(days=1),
        "request_envelope": {},
    }
    original_positions = {1: "file-a", 2: "file-b"}
    writes = []

    class Connection:
        def execute(self, statement, parameters=None):
            assert "clock_timestamp()" in str(statement)
            return SimpleNamespace(scalar_one=lambda: now)

    def find_row(connection, statement, parameters):
        if "FROM drive_share_requests" in statement:
            return request
        if "FROM drive_owner_search_jobs" in statement and "client_request_id" in statement:
            return row
        if "FROM drive_bulk_shares" in statement or "job_id<>:job" in statement:
            return None
        if "UPDATE drive_owner_search_jobs" in statement:
            writes.append(parameters)
            row["checkpoint"] = parameters["checkpoint"]
            row["status"] = "queued"
            return row
        raise AssertionError(statement)

    store = DriveOwnerSearchStore(
        db=SimpleNamespace(),
        cipher=SimpleNamespace(
            open=lambda *args, **kwargs: {
                "purpose": purpose,
                **({"legacy_request_policy": LEGACY_REQUEST_POLICY} if restored_policy else {}),
            }
        ),
    )
    monkeypatch.setattr(store, "_lock", lambda *args: None)
    monkeypatch.setattr(store, "_access", lambda *args: {"connection_generation": 7})
    monkeypatch.setattr(store, "_row", find_row)
    monkeypatch.setattr(store, "_checkpoint", lambda current: current["checkpoint"])
    monkeypatch.setattr(store, "_seal", lambda value, *args: value)
    monkeypatch.setattr(
        store, "_view", lambda current: {"jobId": current["job_id"], "status": current["status"]}
    )

    async def transaction(operation):
        return operation(Connection())

    monkeypatch.setattr(store, "_transaction", transaction)
    kwargs = dict(
        user_id="owner",
        request_id=request_id,
        request_revision=2,
        purpose=purpose,
        queries=queries,
        period=period,
        terms=plan.terms,
    )
    state, changed, worker_stage = await store.replan_legacy_statement_request(**kwargs)
    if restored_policy:
        assert not changed and state == {"jobId": row["job_id"], "status": "completed"}
        assert worker_stage == "suggestions"
        assert row["checkpoint"] is checkpoint and not writes
        return
    assert changed and state == {"jobId": row["job_id"], "status": "queued"}
    assert worker_stage == ("v1" if marked_v1 else "suggestions")
    assert len(writes) == 1
    assert row["checkpoint"]["queries"] == queries
    assert row["checkpoint"]["phase"] == "user"
    assert row["checkpoint"]["page_token"] is None
    assert row["checkpoint"]["request_owner_review_required"] is True
    assert row["checkpoint"]["coverage_manifest"]["contentPeriodVerified"] is False
    assert row["v1_statement_search"] is marked_v1
    assert original_positions == {1: "file-a", 2: "file-b"}

    state, changed, worker_stage = await store.replan_legacy_statement_request(**kwargs)
    assert not changed and state["jobId"] == row["job_id"]
    assert worker_stage == ("v1" if marked_v1 else "suggestions")
    assert len(writes) == 1


@pytest.mark.asyncio
async def test_legacy_statement_replan_does_not_touch_frozen_history(monkeypatch):
    request_id = "12345678-1234-1234-1234-123456789012"
    purpose = {
        "purpose": "Schwab brokerage statements from 2026",
        "periodStart": "2026-09-01",
        "periodEnd": "2026-10-09",
    }
    plan = _deterministic_statement_plan(purpose)
    queries, period = compile_request_queries(plan.model_dump(mode="json"), purpose, "UTC")
    now = datetime.now(UTC)
    checkpoint = {
        "request_origin_id": request_id,
        "request_revision": 2,
        "evidence_route": "provider",
        "queries": [{"arguments": {"query": "old"}}],
    }
    row = {
        "job_id": "87654321-4321-4321-4321-210987654321",
        "status": "completed",
        "connection_generation": 7,
        "checkpoint": checkpoint,
    }
    request = {
        "status": "pending",
        "revision": 2,
        "bulk_search_started_at": now,
        "access_stop_requested_at": None,
        "expires_at": now + timedelta(days=1),
        "request_envelope": {},
    }
    writes = []

    class Connection:
        def execute(self, statement, parameters=None):
            return SimpleNamespace(scalar_one=lambda: now)

    def find_row(connection, statement, parameters):
        if "FROM drive_share_requests" in statement:
            return request
        if "FROM drive_owner_search_jobs" in statement and "client_request_id" in statement:
            return row
        if "FROM drive_bulk_shares" in statement:
            return {"share_id": "frozen-paid-or-approved-batch"}
        if "UPDATE drive_owner_search_jobs" in statement:
            writes.append(parameters)
            return row
        raise AssertionError(statement)

    store = DriveOwnerSearchStore(
        db=SimpleNamespace(),
        cipher=SimpleNamespace(open=lambda *args, **kwargs: {"purpose": purpose}),
    )
    monkeypatch.setattr(store, "_lock", lambda *args: None)
    monkeypatch.setattr(store, "_access", lambda *args: {"connection_generation": 7})
    monkeypatch.setattr(store, "_row", find_row)
    monkeypatch.setattr(store, "_checkpoint", lambda current: current["checkpoint"])
    monkeypatch.setattr(
        store, "_view", lambda current: {"jobId": current["job_id"], "status": current["status"]}
    )

    async def transaction(operation):
        return operation(Connection())

    monkeypatch.setattr(store, "_transaction", transaction)
    state, changed, worker_stage = await store.replan_legacy_statement_request(
        user_id="owner",
        request_id=request_id,
        request_revision=2,
        purpose=purpose,
        queries=queries,
        period=period,
        terms=plan.terms,
    )
    assert state == {"jobId": row["job_id"], "status": "completed"}
    assert not changed and not writes
    assert worker_stage == "suggestions"
    assert row["checkpoint"] is checkpoint
    assert checkpoint["queries"] == [{"arguments": {"query": "old"}}]


@pytest.mark.asyncio
async def test_active_legacy_statement_replans_before_provider_read(monkeypatch):
    request_id = "12345678-1234-1234-1234-123456789012"
    checkpoint = {
        "request_origin_id": request_id,
        "request_revision": 2,
        "evidence_route": "provider",
        "request": {"query": "Schwab brokerage statements from 2026"},
        "queries": [{"arguments": {"query": "old"}}],
    }
    job = {"checkpoint": checkpoint, "lease_id": "lease-1"}
    context = {"purpose": {"purpose": checkpoint["request"]["query"]}, "revision": 2}
    store = SimpleNamespace(
        claim=AsyncMock(return_value=job),
        require_current=AsyncMock(),
    )
    service = DriveOwnerSearchService(
        store=store,
        sharing=SimpleNamespace(request_bulk_context=AsyncMock(return_value=context)),
        transport=SimpleNamespace(read_tool=AsyncMock(side_effect=AssertionError("provider read"))),
    )
    service.replan_legacy_statement_request = AsyncMock(
        return_value=({"status": "queued"}, True, "suggestions")
    )
    monkeypatch.setattr(search_module, "wake_drive_work", AsyncMock())
    outcome = await service.run_one(user_id="owner", job_id="job", require_current=AsyncMock())
    assert outcome == "queued"
    service.replan_legacy_statement_request.assert_awaited_once_with(
        user_id="owner", request_id=request_id, context=context, expected_lease="lease-1"
    )
    service.transport.read_tool.assert_not_awaited()
    search_module.wake_drive_work.assert_awaited_once_with("suggestions")


@pytest.mark.asyncio
async def test_saved_statement_marker_cannot_enter_trusted_auto_share_path(shared_hub_owner):
    sharing = SimpleNamespace(
        trusted_request_authority=AsyncMock(return_value={}),
        request_bulk_context=AsyncMock(
            return_value={
                "purpose": {
                    "purpose": "Schwab brokerage statements from 2026",
                    "periodStart": "2026-09-01",
                    "periodEnd": "2026-10-09",
                }
            }
        ),
        request_owner_review_required=AsyncMock(return_value=False),
    )
    bulk = SimpleNamespace(pending_request_reviews=AsyncMock())
    service = DriveTrustedAutoService(
        sharing=sharing, bulk=bulk, payment=object(), wake=AsyncMock()
    )
    assert await service.share_available(user_id="owner", request_id="request") == 0
    shared_hub_owner.assert_awaited_once_with("owner")
    sharing.request_owner_review_required.assert_not_awaited()
    bulk.pending_request_reviews.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("request_text", "expected_terms", "required_entities"),
    [
        (
            "All Charles Schwab brokerage statements from 2026",
            ["Schwab", "brokerage", "statement"],
            ["Schwab"],
        ),
        ("Bank statements", ["bank", "statement"], []),
    ],
)
async def test_v1_statement_request_starts_with_deterministic_structural_search(
    request_text, expected_terms, required_entities
):
    purpose = {
        "purpose": request_text,
        "periodStart": "2026-09-01",
        "periodEnd": "2026-10-09",
    }
    context = {
        "purpose": purpose,
        "revision": 1,
        "requestTimeZone": "UTC",
        "agentPackageRequired": True,
        "v1LiveRequest": True,
    }
    search = SimpleNamespace(
        store=SimpleNamespace(by_client=AsyncMock(return_value=None)),
        create_for_request=AsyncMock(return_value={"status": "queued", "jobId": "v1-job"}),
        request_evidence_route=AsyncMock(),
    )
    planner = AsyncMock(side_effect=AssertionError("V1 statement discovery must not call Gemini"))
    sharing = SimpleNamespace(
        request_bulk_context=AsyncMock(return_value=context),
        package_preparation_authority=AsyncMock(),
    )
    service = DriveRequestBulkService(
        sharing=sharing, search=search, planner=planner, require_owner=AsyncMock()
    )

    result = await service.start_search(user_id="owner", request_id="request-id")

    assert result == {"status": "queued", "jobId": "v1-job"}
    planner.assert_not_awaited()
    search.request_evidence_route.assert_not_awaited()
    sharing.package_preparation_authority.assert_awaited_once()
    frozen = search.create_for_request.await_args.kwargs
    assert frozen["authority_mode"] == "agent_package"
    assert frozen["v1_live_request"] is True
    assert frozen["plan"]["terms"] == expected_terms
    assert frozen["plan"]["required_entities"] == required_entities
    assert frozen["plan"]["semantic_intent"] == "institutional_statement"
    queries, _ = compile_request_queries(frozen["plan"], purpose, "UTC", v1_live_request=True)
    assert "fullText" not in queries[-1]["arguments"]["query"]
    assert "mimeType" in queries[-1]["arguments"]["query"]


@pytest.mark.asyncio
async def test_v1_named_bank_statement_keeps_issuer_in_semantic_plan():
    purpose = {
        "purpose": "Chase bank statements",
        "periodStart": "2026-09-01",
        "periodEnd": "2026-10-09",
    }
    context = {
        "purpose": purpose,
        "revision": 1,
        "requestTimeZone": "UTC",
        "agentPackageRequired": True,
        "v1LiveRequest": True,
    }
    search = SimpleNamespace(
        store=SimpleNamespace(by_client=AsyncMock(return_value=None)),
        create_for_request=AsyncMock(return_value={"status": "queued", "jobId": "v1-job"}),
    )
    planner = AsyncMock(
        return_value={
            "mode": "find",
            "terms": ["Chase", "bank", "statement"],
            "required_entities": ["Chase"],
            "semantic_intent": "institutional_statement",
            "file_kind": "document",
            "time_intent": "document_coverage",
        }
    )
    service = DriveRequestBulkService(
        sharing=SimpleNamespace(
            request_bulk_context=AsyncMock(return_value=context),
            package_preparation_authority=AsyncMock(),
        ),
        search=search,
        planner=planner,
        require_owner=AsyncMock(),
    )

    await service.start_search(user_id="owner", request_id="request-id")

    planner.assert_awaited_once()
    frozen = search.create_for_request.await_args.kwargs
    assert frozen["plan"]["required_entities"] == ["Chase"]
    assert frozen["v1_live_request"] is True


@pytest.mark.asyncio
async def test_existing_completed_statement_retries_same_job_without_model():
    request_id = "12345678-1234-1234-1234-123456789012"
    context = {
        "purpose": {
            "purpose": "Schwab brokerage statements from 2026",
            "periodStart": "2026-09-01",
            "periodEnd": "2026-10-09",
        },
        "revision": 2,
        "requestTimeZone": "UTC",
    }
    retried = {"jobId": "same-job", "status": "queued"}
    store = SimpleNamespace(
        by_client=AsyncMock(return_value={"jobId": "same-job", "status": "completed"}),
    )
    search = SimpleNamespace(
        store=store,
        replan_legacy_statement_request=AsyncMock(return_value=(retried, True, "suggestions")),
        create_for_request=AsyncMock(),
    )
    planner = AsyncMock(side_effect=AssertionError("statement route must not call Gemini"))
    wake = AsyncMock()
    service = DriveRequestBulkService(
        sharing=SimpleNamespace(request_bulk_context=AsyncMock(return_value=context)),
        search=search,
        planner=planner,
        require_owner=AsyncMock(),
        wake=wake,
    )
    state = await service.start_search(
        user_id="owner", request_id=request_id, authority_mode="trusted_auto"
    )
    assert state is retried
    search.replan_legacy_statement_request.assert_awaited_once_with(
        user_id="owner", request_id=request_id, context=context
    )
    store.by_client.assert_awaited_once()
    search.create_for_request.assert_not_awaited()
    planner.assert_not_awaited()
    wake.assert_awaited_once_with("suggestions")


@pytest.mark.asyncio
async def test_owner_review_retries_completed_unfrozen_statement_without_manual_restart():
    request_id = "12345678-1234-1234-1234-123456789012"
    context = {
        "searchStarted": True,
        "purpose": {
            "purpose": "Schwab brokerage statements from 2026",
            "periodStart": "2026-09-01",
            "periodEnd": "2026-10-09",
        },
        "revision": 2,
        "requestTimeZone": "UTC",
    }
    old = {"jobId": "same-job", "status": "completed"}
    retried = {"jobId": "same-job", "status": "queued"}
    lookup = AsyncMock(side_effect=[old, retried])
    search = SimpleNamespace(
        store=SimpleNamespace(by_client=lookup),
        replan_legacy_statement_request=AsyncMock(return_value=(retried, True, "suggestions")),
    )
    bulk = SimpleNamespace(
        refresh_request=AsyncMock(),
        batches_by_request=AsyncMock(return_value={"batches": [], "batchCount": 0}),
    )
    planner = AsyncMock(side_effect=AssertionError("review must not call Gemini"))
    wake = AsyncMock()
    service = DriveRequestBulkService(
        sharing=SimpleNamespace(request_bulk_context=AsyncMock(return_value=context)),
        search=search,
        bulk=bulk,
        planner=planner,
        require_owner=AsyncMock(),
        wake=wake,
    )
    first = await service.review_context(user_id="owner", request_id=request_id)
    second = await service.review_context(user_id="owner", request_id=request_id)
    assert first["search"] == second["search"] == retried
    search.replan_legacy_statement_request.assert_awaited_once_with(
        user_id="owner", request_id=request_id, context=context
    )
    wake.assert_awaited_once_with("suggestions")
    bulk.refresh_request.assert_not_awaited()
    planner.assert_not_awaited()


@pytest.mark.parametrize(
    "extra,expected_order",
    [
        ({}, "modifiedTime desc"),
        ({"exact_title": "Quarterly report"}, "modifiedTime desc"),
        (
            {"time_intent": "file_activity", "file_time_field": "createdTime"},
            "createdTime desc",
        ),
    ],
)
def test_request_discovery_order_avoids_creation_sort_unless_explicit(extra, expected_order):
    queries, period = compile_request_queries(
        {"mode": "find", "file_kind": "document", **extra},
        {"purpose": "Quarterly documents", "periodStart": "2026-01-01", "periodEnd": "2026-03-31"},
        "UTC",
    )
    arguments = queries[0]["arguments"]
    assert arguments["orderBy"] == expected_order
    assert "createdTime" not in arguments["query"]
    assert "modifiedTime" not in arguments["query"]
    assert period == {"start": "2026-01-01", "end": "2026-03-31", "timezone": "UTC"}
    if "exact_title" in extra:
        assert "name = 'Quarterly report'" in arguments["query"]


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


@pytest.mark.asyncio
async def test_unsearched_request_review_has_no_batch_fields():
    """The owner's review parser rejects batch fields without a search.

    Empty batches here left every new request's review unable to load.
    """
    service = DriveRequestBulkService(
        sharing=SimpleNamespace(
            request_bulk_context=AsyncMock(return_value={"searchStarted": False})
        ),
        search=SimpleNamespace(store=SimpleNamespace(by_client=AsyncMock())),
        bulk=SimpleNamespace(batches_by_request=AsyncMock()),
        require_owner=AsyncMock(),
    )
    assert await service.review_context(user_id="owner", request_id="new-request") == {
        "search": None,
        "bulkShare": None,
    }


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
        calls.append(json.JSONDecoder().raw_decode(prompt)[0])
        return {
            "mode": "find",
            "terms": [],
            "file_kind": "document",
            "subject_scope": "metadata_listing",
            "subject_complete": True,
        }

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
@pytest.mark.parametrize("authority_mode", ["owner", "trusted_auto"])
@pytest.mark.parametrize(
    "purpose, terms, count",
    [
        ("Latest 100 documents", [], 100),
        ("Last four documents", [], 4),
        ("Last 4 standup notes", ["standup"], 4),
        ("Standup notes from the last 3 days", ["standup"], None),
    ],
)
async def test_request_freezes_agent_count_for_both_consent_flows(
    authority_mode, purpose, terms, count
):
    requested_at = datetime(2026, 10, 9, tzinfo=UTC)
    context = {
        "purpose": {
            "purpose": purpose,
            "periodStart": "2026-10-01",
            "periodEnd": "2026-10-09",
        },
        "revision": 7,
        "requestTimeZone": "Asia/Kolkata",
        "requestCreatedAt": requested_at,
    }
    plan = {
        "mode": "find",
        "file_kind": "document",
        "terms": terms,
        "time_intent": "file_activity" if count is not None else "document_coverage",
        "subject_scope": "specific_records" if terms else "metadata_listing",
        "subject_complete": True,
        "sort": "recent",
        "result_limit": count,
    }
    planner = AsyncMock(return_value=plan)
    search = SimpleNamespace(
        store=SimpleNamespace(
            takeover_request=AsyncMock(return_value=None),
            by_client=AsyncMock(return_value=None),
        ),
        create_for_request=AsyncMock(return_value={"status": "queued", "jobId": "job"}),
    )
    service = DriveRequestBulkService(
        sharing=SimpleNamespace(request_bulk_context=AsyncMock(return_value=context)),
        search=search,
        planner=planner,
        require_owner=AsyncMock(),
    )
    await service.start_search(
        user_id="owner", request_id="request-id", authority_mode=authority_mode
    )
    planner.assert_awaited_once()
    prompt = json.loads(planner.await_args.kwargs["prompt"])
    assert prompt["transaction_search"] is True
    assert prompt["document_request"] == context["purpose"]
    frozen = search.create_for_request.await_args.kwargs
    assert frozen["plan"]["result_limit"] == count
    assert frozen["plan"]["terms"] == terms
    assert frozen["plan"]["sort"] == "recent"
    assert frozen["authority_mode"] == authority_mode
    assert frozen["request_revision"] == 7
    assert frozen["requested_at"] == requested_at


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
@pytest.mark.parametrize("order", ["modifiedTime desc", "createdTime desc"])
async def test_folder_continuation_keeps_its_saved_provider_order(order):
    checkpoint = _checkpoint()
    checkpoint.update(
        phase="folder_files",
        page_token="saved-folder-page",  # noqa: S106 - synthetic provider cursor
        folder_queue=[{"id": "matching-folder"}],
    )
    checkpoint["arguments"]["orderBy"] = order
    reader = AsyncMock(
        return_value=ExternalMcpToolResult(
            is_error=False,
            payload={"files": [], "nextPageToken": "following-page", "incompleteSearch": False},
            truncated=False,
        )
    )
    service = DriveOwnerSearchService(transport=SimpleNamespace(read_tool=reader))
    await service._page({"user_id": "owner", "checkpoint": checkpoint})
    arguments = reader.await_args.kwargs["arguments"]
    assert arguments["orderBy"] == order
    assert arguments["pageToken"] == "saved-folder-page"


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
async def test_trusted_title_evidence_sees_words_inside_compound_filenames():
    # Drive returns these for a meeting-notes search; whole-word title checks
    # alone rejected every compound spelling as "no title evidence".
    names = [
        "MeetingNotes.pdf",
        "2026_09_MeetingNotes.pdf",
        "meeting-notes",
        "Meeting Notes",
        "meeting_notes_sept.docx",
    ]
    candidates = [
        _request_candidate(f"compound-{index}", name) for index, name in enumerate(names)
    ] + [
        _request_candidate("agenda", "MeetingAgendaNotes.pdf"),
        _request_candidate("unrelated", "Meetingroom budget.pdf"),
    ]
    checkpoint = {
        "authority_mode": "trusted_auto",
        "request_file_kind": "document",
        "request_subject_terms": ["meeting", "notes"],
        "request_notes": True,
        "request": {"query": "meeting notes"},
        "coverage_counts": {},
    }
    service = DriveOwnerSearchService(transport=SimpleNamespace())
    files, incomplete = await service._request_candidates(
        {"user_id": "owner"}, checkpoint, candidates, folder_scoped=False, drive_id=None
    )

    assert [file["name"] for file in files] == names
    assert not incomplete
    # An agenda stays excluded once its compound words are visible.
    assert checkpoint["coverage_counts"]["excludedByNoteTypeCount"] == 1
    assert checkpoint["coverage_counts"]["excludedByFilenameCount"] == 1
    assert search_module._title_words("2026_09_MeetingNotes.pdf") == "2026 09 Meeting Notes.pdf"
    assert search_module._title_words("QBRNotes") == "QBR Notes"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("terms", "outside", "inside"),
    [
        (
            ["meeting", "notes"],
            [
                "2025_08_14_MeetingNotes",
                "2025_08_14_meeting_notes.docx",
                "20250814_MeetingNotes",
                "2025.08.14 Meeting Notes",
                "2025-08-14 Meeting Notes",
            ],
            ["2026_09_14_MeetingNotes", "20260914_meeting_notes", "2026.09.14 Meeting Notes"],
        ),
        (
            ["invoice"],
            ["2025_03_01_invoice.pdf", "20250301_invoice.pdf", "2025-03-01 invoice.pdf"],
            ["2026_09_03_invoice.pdf"],
        ),
    ],
)
async def test_automatic_sharing_reads_title_dates_through_compound_spellings(
    terms, outside, inside
):
    # Every file was created and modified inside the consented month. A title
    # date outside it still wins, however the title spells it.
    candidates = [
        _request_candidate(f"title-{index}", name) for index, name in enumerate([*outside, *inside])
    ]
    checkpoint = {
        "authority_mode": "trusted_auto",
        "request_file_kind": "document",
        "request_subject_terms": terms,
        "request_notes": "notes" in terms,
        "request": {"query": " ".join(terms)},
        "request_time_intent": "file_activity",
        "request_owner_review_required": False,
        "requested_period": {"start": "2026-09-01", "end": "2026-09-30", "timezone": "UTC"},
        "coverage_counts": {},
    }
    service = DriveOwnerSearchService(transport=SimpleNamespace())
    files, _ = await service._request_candidates(
        {"user_id": "owner"}, checkpoint, candidates, folder_scoped=False, drive_id=None
    )

    assert [file["name"] for file in files] == inside
    assert checkpoint["coverage_counts"]["excludedByDateCount"] == len(outside)
    # An in-period title date wins over file activity outside the period too.
    activity = {"created_time": "2025-01-05T00:00:00Z", "modified_time": "2025-01-05T00:00:00Z"}
    for name in inside:
        assert search_module._in_requested_period(
            {**activity, "name": name}, checkpoint["requested_period"]
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text,conflict",
    [
        ("3 months meeting notes", "request_mentions_longer_span"),
        ("meeting notes for the last two weeks", None),
        ("1 month of meeting notes", None),
        ("meeting notes", None),
    ],
)
async def test_phrase_span_never_widens_the_consented_period(monkeypatch, text, conflict):
    store = SimpleNamespace(
        by_client=AsyncMock(return_value=None),
        create=AsyncMock(return_value=({"jobId": "synthetic-job"}, False)),
    )
    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace())
    await service.create_for_request(
        user_id="owner",
        request_id="12345678-1234-1234-1234-123456789012",
        request_revision=1,
        # The UAT failure: the phrase says 3 months, the Allow sheet one month.
        purpose={"purpose": text, "periodStart": "2026-09-02", "periodEnd": "2026-10-02"},
        plan={
            "mode": "find",
            "terms": ["meeting", "notes"],
            "file_kind": "document",
            "time_intent": "file_activity",
        },
        require_current=AsyncMock(),
        authority_mode="trusted_auto",
        requested_at=datetime(2026, 10, 3, tzinfo=UTC),
    )
    checkpoint = store.create.await_args.kwargs["checkpoint"]
    picked = {"start": "2026-09-02", "end": "2026-10-02", "timezone": "UTC"}
    assert checkpoint["requested_period"] == picked
    assert checkpoint["coverage_manifest"]["requestedPeriod"] == picked
    assert checkpoint["coverage_manifest"]["periodConflict"] == conflict
    # Discovery is not date-cut either way; membership uses the picked dates.
    assert all(
        "modifiedTime >=" not in query["arguments"]["query"] for query in checkpoint["queries"]
    )
    match = {"name": "Meeting notes", "created_time": "2026-07-15T10:00:00Z"}
    assert not search_module._in_requested_period(match, checkpoint["requested_period"])


async def _autoshare_checkpoint(
    *,
    autoshare=True,
    authority_mode="trusted_auto",
    # The UAT request 13ee925d: "3 months" in the text, one month picked.
    text="last 3 months meeting notes",
    plan=None,
    planner_fallback=None,
    planned_by="model",
):
    store = SimpleNamespace(
        by_client=AsyncMock(return_value=None),
        create=AsyncMock(return_value=({"jobId": "synthetic-job"}, False)),
    )
    planned = {}
    if planned_by == "brain":
        # The default request flow: the deterministic brain plans, no model.
        from hushh_mcp.services.drive_request_brain import interpret_request, suggested_plan
        from hushh_mcp.services.drive_suggestion_service import LiveSearchPlan

        brain = interpret_request(
            text,
            now=datetime(2026, 10, 3, tzinfo=UTC),
            timezone="UTC",
            picked_period=(date(2026, 9, 2), date(2026, 10, 2)),
        )
        plan = LiveSearchPlan.model_validate(suggested_plan(brain, text)).model_dump(mode="json")
        planned = {"brain": brain.as_checkpoint(), "plan_source": "deterministic_brain"}
    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace())
    await service.create_for_request(
        user_id="owner",
        request_id="12345678-1234-1234-1234-123456789012",
        request_revision=1,
        purpose={"purpose": text, "periodStart": "2026-09-02", "periodEnd": "2026-10-02"},
        plan=plan
        or {
            "mode": "find",
            "terms": ["meeting", "notes"],
            "file_kind": "document",
            "time_intent": "document_coverage",
        },
        require_current=AsyncMock(),
        authority_mode=authority_mode,
        requested_at=datetime(2026, 10, 3, tzinfo=UTC),
        autoshare=autoshare,
        **({"planner_fallback": planner_fallback} if planner_fallback else {}),
        **planned,
    )
    checkpoint = store.create.await_args.kwargs["checkpoint"]
    assert ("request_brain" in checkpoint) is (planned_by == "brain")
    return service, checkpoint


@pytest.mark.asyncio
@pytest.mark.parametrize("planned_by", ["model", "brain"])
@pytest.mark.parametrize("folder_scoped", [False, True])
async def test_autoshare_gemini_title_never_stands_in_for_the_request_subject(
    folder_scoped, planned_by
):
    service, checkpoint = await _autoshare_checkpoint(
        text="Acme pricing meeting notes",
        plan={
            "mode": "find",
            "terms": ["Acme", "pricing", "meeting"],
            "file_kind": "document",
            "time_intent": "document_coverage",
        },
        planned_by=planned_by,
    )
    assert checkpoint["request_owner_review_required"] is False
    # The broader OR query still runs; every row it finds passes the title gate.
    assert len(checkpoint["queries"]) >= 2
    candidates = [
        # Unrelated private notes in the period: never shared for this subject.
        _request_candidate("hr", "HR 1:1 with Priya - 2026/09/10 10:00 IST - Notes by Gemini"),
        _request_candidate("therapy", "Therapy session - 2026/09/12 09:00 IST - Notes by Gemini"),
        _request_candidate("acme", "Acme review - 2026/09/14 09:00 IST - Notes by Gemini"),
        # The request's own subject in a Gemini title stands in for "meeting".
        _request_candidate(
            "pricing", "Acme pricing review - 2026/09/15 10:00 IST - Notes by Gemini"
        ),
        _request_candidate("titled", "Acme pricing meeting notes"),
    ]
    files, _ = await service._request_candidates(
        {"user_id": "owner"}, checkpoint, candidates, folder_scoped=folder_scoped, drive_id=None
    )
    assert {file["id"]: file["shareable"] for file in files} == {
        "pricing": True,
        "titled": True,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("planned_by", ["model", "brain"])
async def test_generic_meeting_notes_autoshare_every_in_period_gemini_note(planned_by):
    service, checkpoint = await _autoshare_checkpoint(planned_by=planned_by)
    candidates = [
        _request_candidate("hr", "HR 1:1 with Priya - 2026/09/10 10:00 IST - Notes by Gemini"),
        _request_candidate("old", "HR 1:1 with Priya - 2026/06/16 10:00 IST - Notes by Gemini"),
    ]
    files, _ = await service._request_candidates(
        {"user_id": "owner"}, checkpoint, candidates, folder_scoped=False, drive_id=None
    )
    assert {file["id"]: file["shareable"] for file in files} == {"hr": True}


@pytest.mark.asyncio
@pytest.mark.parametrize("planned_by", ["model", "brain"])
@pytest.mark.parametrize("text", ["standup notes", "sync notes"])
async def test_autoshare_specific_meeting_kind_never_shares_every_gemini_note(text, planned_by):
    kind = text.split()[-2]
    service, checkpoint = await _autoshare_checkpoint(
        text=text,
        plan={
            "mode": "find",
            "terms": text.split(),
            "file_kind": "document",
            "time_intent": "document_coverage",
        },
        planned_by=planned_by,
    )
    assert checkpoint["request_owner_review_required"] is False
    candidates = [
        _request_candidate("therapy", "Therapy session - 2026/09/12 09:00 IST - Notes by Gemini"),
        _request_candidate("own", f"Weekly {kind} - 2026/09/15 10:00 IST - Notes by Gemini"),
    ]
    files, _ = await service._request_candidates(
        {"user_id": "owner"}, checkpoint, candidates, folder_scoped=False, drive_id=None
    )
    # A Gemini title stands in for the generic ask only; the kind must be named.
    assert {file["id"]: file["shareable"] for file in files} == {"own": True}
    # Negative control: the generic ask shares every in-period Gemini note.
    service, generic = await _autoshare_checkpoint(text="meeting notes", planned_by=planned_by)
    files, _ = await service._request_candidates(
        {"user_id": "owner"}, generic, candidates, folder_scoped=False, drive_id=None
    )
    assert {file["id"] for file in files} == {"therapy", "own"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text,plan_name,review",
    [
        # The stand-in plans drop the client or issuer, so the owner reviews.
        ("Acme meeting notes", "meeting_notes", True),
        ("Acme pricing meeting notes", "meeting_notes", True),
        ("Fidelity brokerage statements", "statements", True),
        # A request the stand-in plan fully covers still shares itself.
        ("last 3 months meeting notes", "meeting_notes", False),
        ("last 3 months brokerage statements", "statements", False),
        ("Schwab statements for September", "statements", False),
    ],
)
async def test_planner_fallback_keeps_owner_review_when_it_drops_the_subject(
    text, plan_name, review
):
    from hushh_mcp.services.drive_request_bulk_service import _deterministic_meeting_note_plan
    from hushh_mcp.services.drive_request_review_policy import checkpoint_requires_owner_review

    purpose = {"purpose": text}
    plan = (
        _deterministic_statement_plan(purpose)
        if plan_name == "statements"
        else _deterministic_meeting_note_plan(purpose)
    )
    _, checkpoint = await _autoshare_checkpoint(
        text=text,
        plan=plan.model_dump(mode="json"),
        planner_fallback={"reason": "model_error", "plan": plan_name},
    )
    assert checkpoint["request_owner_review_required"] is review
    assert ("request_selection_policy" in checkpoint) is not review
    assert (
        checkpoint_requires_owner_review(
            checkpoint, request_id="12345678-1234-1234-1234-123456789012", revision=1
        )
        is review
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text,review",
    [
        # The default brain left out a word that may name the issuer or record.
        ("Google One receipts", True),
        ("Capital One statements", True),
        ("Flat 12 maintenance bills", True),
        ("AT & T bills", True),
        # Negative controls: every subject word is still required.
        ("Google receipts", False),
        ("AT&T bills", False),
        ("Requesting the bank statements from your Google Drive", False),
    ],
)
async def test_brain_keeps_owner_review_when_it_drops_a_possible_subject(text, review):
    from hushh_mcp.services.drive_request_review_policy import checkpoint_requires_owner_review

    _, checkpoint = await _autoshare_checkpoint(text=text, planned_by="brain")
    assert bool(checkpoint["request_brain"]["dropped"]) is review
    assert checkpoint["request_owner_review_required"] is review
    assert ("request_selection_policy" in checkpoint) is not review
    assert (
        checkpoint_requires_owner_review(
            checkpoint, request_id="12345678-1234-1234-1234-123456789012", revision=1
        )
        is review
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("autoshare", [True, False])
@pytest.mark.parametrize(
    "text,review",
    [
        ("Google One receipt files uploaded last week", True),
        # Negative control: the explicit file-activity selection still runs.
        ("Google receipt files uploaded last week", False),
    ],
)
async def test_file_activity_never_skips_review_after_a_dropped_subject(text, review, autoshare):
    _, checkpoint = await _autoshare_checkpoint(text=text, planned_by="brain", autoshare=autoshare)
    assert checkpoint["request_time_intent"] == "file_activity"
    assert checkpoint["request_owner_review_required"] is review


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text,unrelated,own",
    [
        # Issuers with "&" and Google stay required title words.
        ("AT&T bills", ["Electricity bill 2026-09-14.pdf"], "AT&T bill 2026-09-14.pdf"),
        (
            "Google invoices",
            ["AWS invoice 2026-09-14.pdf", "Hospital invoice 2026-09-13.pdf"],
            "Google invoice 2026-09-14.pdf",
        ),
        ("H&M receipts", ["Pharmacy receipt 2026-09-14.pdf"], "H&M receipt 2026-09-14.pdf"),
        # An identifier number is neither a count nor a year.
        (
            "Flat 302 maintenance bills",
            ["Flat 101 maintenance bill 2026-09-14.pdf"],
            "Flat 302 maintenance bill 2026-09-14.pdf",
        ),
        ("invoice 2001", ["Invoice 7781 2026-09-14.pdf"], "Invoice 2001 2026-09-14.pdf"),
        # A built-in spelling fix only discovers; it never authorizes.
        (
            "fleeting notes",
            [
                "HR 1:1 with Priya - 2026/09/10 10:00 IST - Notes by Gemini",
                "Therapy session - 2026/09/12 09:00 IST - Notes by Gemini",
                "Team meeting notes 2026-09-14",
            ],
            "Fleeting notes 2026-09-14",
        ),
        ("blank statements", ["HDFC bank statement 2026-09-14.pdf"], "Blank statement 2026-09-14"),
    ],
)
async def test_brain_autoshare_never_shares_a_title_the_request_did_not_name(text, unrelated, own):
    service, checkpoint = await _autoshare_checkpoint(text=text, planned_by="brain")
    assert checkpoint["request_owner_review_required"] is False
    candidates = [_request_candidate(f"other{n}", title) for n, title in enumerate(unrelated)]
    files, _ = await service._request_candidates(
        {"user_id": "owner"},
        checkpoint,
        [*candidates, _request_candidate("own", own)],
        folder_scoped=False,
        drive_id=None,
    )
    # Positive control: the title the request names is still shared.
    assert {file["id"]: file["shareable"] for file in files} == {"own": True}


@pytest.mark.parametrize(
    "title,shared",
    [
        ("Team meeting notes 16-06-2026", False),
        ("Team meeting notes 16/06/2026", False),
        ("Team meeting notes-16.06.2026", False),
        ("Meeting notes - Jun 16, 2026", False),
        ("16 June 2026 meeting notes", False),
        ("Notes 2026-06-16 and 2026-09-10", False),
        # 10-09-2026 reads as 10 Sep or 9 Oct; one reading is outside.
        ("Meeting notes 10-09-2026", False),
        ("Meeting notes 15-09-2026", True),
        ("Meeting notes Sep 15, 2026", True),
        ("Meeting notes 2026/09/15", True),
        ("Board meeting notes", True),
    ],
)
def test_autoshare_never_grants_a_title_date_outside_the_period(title, shared):
    period = {"start": "2026-09-02", "end": "2026-10-02", "timezone": "Asia/Kolkata"}
    # Created and modified inside: only the title date can keep the file out.
    match = {
        "name": title,
        "created_time": "2026-09-10T00:00:00Z",
        "modified_time": "2026-09-10T00:00:00Z",
    }
    assert search_module._in_requested_period(match, period, precedence=True) is shared


@pytest.mark.asyncio
@pytest.mark.parametrize("planned_by", ["model", "brain"])
async def test_autoshare_shares_every_in_period_meeting_note_without_owner_review(planned_by):
    from hushh_mcp.services.drive_request_review_policy import (
        AUTOSHARE_SELECTION_POLICY,
        checkpoint_requires_owner_review,
    )

    service, checkpoint = await _autoshare_checkpoint(planned_by=planned_by)
    request_id = "12345678-1234-1234-1234-123456789012"
    assert checkpoint["request_selection_policy"] == AUTOSHARE_SELECTION_POLICY
    assert checkpoint["request_owner_review_required"] is False
    assert checkpoint["coverage_manifest"]["ownerReviewRequired"] is False
    assert checkpoint["coverage_manifest"]["periodConflict"] == "request_mentions_longer_span"
    assert not checkpoint_requires_owner_review(checkpoint, request_id=request_id, revision=1)
    # Another revision, or the same plan without autoshare, keeps owner review.
    assert checkpoint_requires_owner_review(checkpoint, request_id=request_id, revision=2)
    _, manual = await _autoshare_checkpoint(autoshare=False)
    assert manual["request_owner_review_required"] is True
    assert "request_selection_policy" not in manual
    assert checkpoint_requires_owner_review(manual, request_id=request_id, revision=1)
    _, owner = await _autoshare_checkpoint(authority_mode="owner")
    assert checkpoint_requires_owner_review(owner, request_id=request_id, revision=1)

    inside = {"createdTime": "2026-09-20T00:00:00Z", "modifiedTime": "2026-09-20T00:00:00Z"}
    candidates = [
        _request_candidate("n1", "Meeting started 2026/09/02 23:42 IST - Notes by Gemini"),
        # A Gemini note names its event, not "meeting".
        _request_candidate("n2", "Weekly sync - 2026/09/15 10:00 IST - Notes by Gemini"),
        # Title dates outside the picked month never share, whatever the activity.
        _request_candidate(
            "n3", "Meeting started 2026/06/16 10:00 IST - Notes by Gemini", **inside
        ),
        _request_candidate(
            "n4", "Meeting started 2026/07/28 10:00 IST - Notes by Gemini", **inside
        ),
        _request_candidate("n5", "Meeting notes 2025/12/23", **inside),
        _request_candidate("n6", "Meeting notes 2026/03/10", **inside),
        # No title date: created decides, then modified only when created is absent.
        _request_candidate(
            "n7",
            "Board meeting notes",
            createdTime="2026-09-10T00:00:00Z",
            modifiedTime="2025-01-01T00:00:00Z",
        ),
        _request_candidate(
            "n8",
            "Ops meeting notes",
            createdTime="2025-12-23T00:00:00Z",
            modifiedTime="2026-09-20T00:00:00Z",
        ),
        {
            **_request_candidate("n9", "Team meeting notes"),
            "createdTime": None,
            "modifiedTime": "2026-09-21T00:00:00Z",
        },
        _request_candidate(
            "n10",
            "Meeting notes 2026/09/12",
            capabilities={"canShare": False},
        ),
        _request_candidate("n11", "Meeting notes", "application/vnd.google-apps.folder"),
    ]
    files, _ = await service._request_candidates(
        {"user_id": "owner"}, checkpoint, candidates, folder_scoped=False, drive_id=None
    )
    assert {file["id"]: file["shareable"] for file in files} == {
        "n1": True,
        "n2": True,
        "n7": True,
        "n9": True,
        # Listed for the record, never claimed: unclaimed_positions needs shareable.
        "n10": False,
    }
    assert checkpoint["coverage_counts"]["excludedByDateCount"] == 5
    # Without the autoshare precedence, either activity date matched (file activity).
    period = checkpoint["requested_period"]
    ops = {"name": "Ops meeting notes", "created_time": "2025-12-23T00:00:00Z"}
    ops["modified_time"] = "2026-09-20T00:00:00Z"
    assert search_module._in_requested_period(ops, period)
    assert not search_module._in_requested_period(ops, period, precedence=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("time_intent", ["document_coverage", "file_activity"])
async def test_request_returns_a_small_inline_page_then_uses_full_background_pages(
    monkeypatch, time_intent
):
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
        plan={
            "mode": "find",
            "terms": ["standup"],
            "file_kind": "document",
            "time_intent": time_intent,
        },
        require_current=AsyncMock(),
        after_page=after_page,
    )
    checkpoint = store.create.await_args.kwargs["checkpoint"]
    assert checkpoint["request_selection_version"] == 2
    assert checkpoint["request_time_intent"] == time_intent
    assert checkpoint["request_owner_review_required"] is (time_intent == "document_coverage")
    coverage = checkpoint["coverage_manifest"]
    assert coverage["timeIntent"] == time_intent
    assert coverage["ownerReviewRequired"] is (time_intent == "document_coverage")
    assert coverage["contentPeriodVerified"] is False
    assert coverage["dateBasis"] == (
        "content_period_unverified"
        if time_intent == "document_coverage"
        else "title_date_then_created_or_modified"
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


def _semantic_checkpoint(subject):
    # Supply the frozen model contract, not a second test-local query planner.
    plan = {
        "version": 1,
        "status": "ready",
        "metadata_listing": False,
        "date_basis": "title_created_modified",
        "clarification": None,
        "clauses": [
            {
                "predicates": [
                    {
                        "id": "person",
                        "kind": "entity",
                        "value": subject,
                        "match": "phrase",
                        "negated": False,
                        "discovery_terms": [],
                    }
                ]
            }
        ],
    }
    queries = compile_semantic_queries(plan, file_kind="document")
    checkpoint = _checkpoint()
    checkpoint.update(
        authority_mode="trusted_auto",
        request_revision=3,
        request_subject_terms=subject.split(),
        request_notes=False,
        queries=queries,
        arguments=queries[0]["arguments"],
        semantic_plan=plan,
        semantic_plan_digest=semantic_plan_digest(plan),
        semantic_assessment_policy=assessment_policy_version(),
        semantic_pending=[],
        semantic_seen=[],
        semantic_purpose={"purpose": f"Documents containing {subject}"},
    )
    return checkpoint


def _semantic_content_io(service, bodies, decisions):
    """Replace external content/model I/O; keep production evidence validation."""
    reads = []

    class Reader:
        def __init__(self, *, user_id, require_access):
            assert user_id == "owner"
            self.require_access = require_access

        async def read_compilation_match(self, *, match):
            await self.require_access()
            reads.append(match["file_id"])
            return (
                SimpleNamespace(name=match["name"], mime_type=match["mime_type"], version="9"),
                bodies[match["file_id"]],
                False,
            )

    async def model(*, request, retrieved, user_id, require_current):
        await require_current()
        source = retrieved["untrusted_external_content"][0]
        # These pre-labelled synthetic answers test transport/selection/binding,
        # not whether a real model can infer relevance from arbitrary language.
        return {
            "documents": [
                {
                    "document_ref": source["document_ref"],
                    "decision": decisions[source["text"]],
                    "confidence": 100,
                    "reason": "Source-bound fixture assessment.",
                    "citations": [{"source_ref": source["source_ref"], "quote": source["text"]}],
                    "covered_periods": [],
                }
            ]
        }

    service.reader_factory = Reader
    service.candidate_assessor = partial(assess_request_candidates, assessor=model)
    service.store = SimpleNamespace(require_current=AsyncMock())
    return reads


@pytest.mark.asyncio
@pytest.mark.parametrize("subject", ["Alder Rowan", "Nia O'Keefe", "Zoë Amari"])
@pytest.mark.parametrize("request_revision", [0, 3])
async def test_semantic_request_keeps_fifty_generic_titles_and_resumes_unique_candidates(
    monkeypatch,
    subject,
    request_revision,
):
    first = [
        _provider_file(f"generic-{n}", f"Research notebook {n}", version="9") for n in range(50)
    ]
    additional = _provider_file("later-match", "Untitled document", version="9")

    def respond(path, params, keys):
        if path == "/drives":
            return {"drives": []}
        assert path == "/files"
        if params.get("pageToken") == "second-page":
            return {"files": first[25:], "nextPageToken": "third-page"}
        if params.get("pageToken") == "third-page":
            return {"files": [first[0], additional]}
        assert "pageToken" not in params
        return {"files": first[:25], "nextPageToken": "second-page"}

    service, adapter = _real_rest_service(monkeypatch, respond)
    bodies = {item["id"]: f"Unrelated meeting record {n}." for n, item in enumerate(first)}
    bodies["generic-37"] = f"The agreement was signed by {subject}."
    bodies["later-match"] = f"Follow-up research with {subject}."
    labels = {body: "exclude" for body in bodies.values()}
    labels[bodies["generic-37"]] = labels[bodies["later-match"]] = "include"
    reads = _semantic_content_io(service, bodies, labels)
    checkpoint = _semantic_checkpoint(subject)
    checkpoint["request_revision"] = request_revision
    job = {"user_id": "owner", "generation": 7, "checkpoint": checkpoint}

    checkpoint, files, incomplete, done = await service._page(job)
    assert not files and not incomplete and not done
    assert checkpoint["page_token"] == "second-page"
    assert len(checkpoint["semantic_pending"]) == 25
    assert checkpoint["coverage_counts"]["providerRowsScanned"] == 25
    assert checkpoint["coverage_counts"].get("excludedByFilenameCount", 0) == 0
    assert reads == []  # Provider metadata is never already a verified match.

    verified = []
    for _ in range(60):
        # Simulate a new slice/process deserializing the persisted checkpoint.
        checkpoint = json.loads(json.dumps(checkpoint))
        job["checkpoint"] = checkpoint
        checkpoint, files, incomplete, done = await service._page(job)
        assert not incomplete
        verified.extend(files)
        if done:
            break
    assert done
    assert [item["id"] for item in verified] == ["generic-37", "later-match"]
    assert len(reads) == len(set(reads)) == 51
    assert checkpoint["semantic_pending"] == []
    assert checkpoint["coverage_counts"]["providerRowsScanned"] == 52
    assert checkpoint["coverage_counts"]["uniqueCandidateCount"] == 51
    assert checkpoint["coverage_counts"]["verifiedCandidateCount"] == 2
    assert checkpoint["coverage_counts"]["contentExcludedCount"] == 49
    assert checkpoint["coverage_counts"]["deduplicatedCount"] == 1
    assert [params.get("pageToken") for path, params, _ in adapter.calls if path == "/files"] == [
        None,
        "second-page",
        "third-page",
    ]
    for item in verified:
        assert item["contentVerified"] is True and item["sourceVersion"] == "9"
        evidence = item["requestEvidence"]
        assert evidence["source"]["id"] == item["id"]
        assert evidence["owner_user_id"] == "owner"
        assert evidence["request_id"] == checkpoint["request_origin_id"]
        assert evidence["request_revision"] == request_revision
        assert evidence["connection_generation"] == 7
        assert evidence["plan_digest"] == checkpoint["semantic_plan_digest"]


@pytest.mark.asyncio
async def test_semantic_unavailable_preserves_pending_candidate_for_retry(monkeypatch):
    service, _ = _real_rest_service(monkeypatch, lambda *_: pytest.fail("discovery repeated"))
    subject = "Ember Vale"
    checkpoint = _semantic_checkpoint(subject)
    item = _provider_file("pending", "Untitled", version="9")
    checkpoint.update(
        semantic_pending=[{**item, "sourceVersion": "9"}], semantic_discovery_done=True
    )
    reads = _semantic_content_io(
        service,
        {"pending": f"Agreement with {subject}."},
        {f"Agreement with {subject}.": "include"},
    )
    successful_reader = service.reader_factory

    class UnavailableReader:
        def __init__(self, **kwargs):
            pass

        async def read_compilation_match(self, **kwargs):
            raise DriveReadError("provider_unavailable", retryable=True)

    service.reader_factory = UnavailableReader
    before = deepcopy(checkpoint)
    job = {"user_id": "owner", "generation": 7, "checkpoint": checkpoint}
    with pytest.raises(DriveReadError, match="provider_unavailable") as failure:
        await service._page(job)
    assert failure.value.retryable
    assert checkpoint == before and reads == []
    service.reader_factory = successful_reader
    updated, files, incomplete, done = await service._page(job)
    assert done and not incomplete and [item["id"] for item in files] == ["pending"]
    assert updated["semantic_pending"] == []


@pytest.mark.asyncio
async def test_semantic_permanent_unavailable_marks_partial_coverage_and_continues(
    monkeypatch, caplog
):
    caplog.set_level("INFO", logger="drive_owner_search")
    service, _ = _real_rest_service(monkeypatch, lambda *_: pytest.fail("discovery repeated"))
    checkpoint = _semantic_checkpoint("Ember Vale")
    unavailable = _provider_file("unsupported", "Archived document", version="9")
    available = _provider_file("supported", "Untitled document", version="9")
    checkpoint.update(
        semantic_pending=[{**item, "sourceVersion": "9"} for item in [unavailable, available]],
        semantic_discovery_done=True,
    )
    reads = _semantic_content_io(
        service,
        {"supported": "Agreement with another person."},
        {"Agreement with another person.": "exclude"},
    )
    supported_reader = service.reader_factory

    class Reader(supported_reader):
        async def read_compilation_match(self, *, match):
            if match["file_id"] == "unsupported":
                raise DriveReadError("unsupported_format")
            return await super().read_compilation_match(match=match)

    service.reader_factory = Reader
    job = {"user_id": "owner", "generation": 7, "checkpoint": checkpoint}
    updated, files, incomplete, done = await service._page(job)
    assert not incomplete and not done and files == []
    assert updated["semantic_coverage_incomplete"] is True
    assert updated["coverage_counts"]["unavailableCandidateCount"] == 1
    assert updated["semantic_outcome_counts"] == {"unavailable:unsupported_format": 1}
    assert [item["id"] for item in updated["semantic_pending"]] == ["supported"]
    job["checkpoint"] = updated
    updated, files, incomplete, done = await service._page(job)
    assert done and not incomplete and files == []
    assert updated["coverage_counts"]["contentExcludedCount"] == 1
    assert updated["semantic_outcome_counts"] == {
        "unavailable:unsupported_format": 1,
        "excluded:content_excluded": 1,
    }
    assert "decision=unavailable reason=unsupported_format position=1" in caplog.text
    assert "decision=excluded reason=content_excluded position=2" in caplog.text
    assert "Archived document" not in caplog.text
    assert "Agreement with another person." not in caplog.text
    assert reads == ["supported"]

    # The source may complete and stream verified files. The separate coverage
    # marker survives so the final request cannot report exhaustive no_match.
    store, commit_job, writes = _semantic_commit_store(monkeypatch, checkpoint)
    monkeypatch.setattr(DriveBulkShareStore, "refresh_request", AsyncMock())
    result = await store.commit_page(commit_job, checkpoint=updated, files=[], done=True)
    assert result["status"] == "completed" and result["incomplete_search"] is False
    assert updated["semantic_coverage_incomplete"] is True
    assert writes[-1]["incomplete"] is False


@pytest.mark.asyncio
async def test_semantic_pending_short_slice_yields_without_retry_error(monkeypatch):
    checkpoint = _semantic_checkpoint("Mira Quill")
    checkpoint["semantic_pending"] = [{"id": "pending"}]
    job = {"job_id": "job", "user_id": "owner", "generation": 7, "checkpoint": checkpoint}
    store = SimpleNamespace(
        claim=AsyncMock(return_value=job),
        release=AsyncMock(return_value="queued"),
        require_current=AsyncMock(),
        commit_page=AsyncMock(),
    )
    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace())
    page = AsyncMock(side_effect=AssertionError("short slice read pending content"))
    monkeypatch.setattr(service, "_page", page)
    before = deepcopy(checkpoint)
    assert await service.run_one(user_id="owner", job_id="job", deadline_seconds=15) == "queued"
    store.release.assert_awaited_once_with(job)
    store.commit_page.assert_not_awaited()
    page.assert_not_awaited()
    assert checkpoint == before


def _semantic_commit_store(monkeypatch, saved_checkpoint, *, incomplete=False):
    """Execute the production transaction callback; replace SQL/encryption I/O."""
    writes = []
    store = DriveOwnerSearchStore(
        db=SimpleNamespace(),
        cipher=SimpleNamespace(digest=lambda *_: "synthetic-file-digest"),
    )
    connection = SimpleNamespace(execute=lambda statement, params: writes.append(params))
    monkeypatch.setattr(
        store, "_current", lambda *_: {"matched": 0, "incomplete_search": incomplete}
    )
    monkeypatch.setattr(store, "_checkpoint", lambda *_: deepcopy(saved_checkpoint))
    monkeypatch.setattr(store, "_seal", lambda *_: "synthetic-envelope")
    monkeypatch.setattr(store, "_view", lambda row: row)

    def row(connection, query, params):
        if query.startswith("SELECT position"):
            return None
        assert query.startswith("UPDATE drive_owner_search_jobs")
        writes.append(params)
        return {
            "status": params["state"],
            "matched": params["count"],
            "incomplete_search": params["incomplete"],
        }

    monkeypatch.setattr(store, "_row", row)
    monkeypatch.setattr(
        store, "_transaction", AsyncMock(side_effect=lambda operation: operation(connection))
    )
    return store, {"job_id": "job", "user_id": "owner", "generation": 7}, writes


@pytest.mark.asyncio
async def test_semantic_commit_rejects_unverified_files_with_verified_negative_control(monkeypatch):
    checkpoint = _semantic_checkpoint("Tala Birch")
    item = {**_provider_file("original", "Untitled", version="9"), "sourceVersion": "9"}
    checkpoint.update(semantic_pending=[item], semantic_discovery_done=True)
    service, _ = _real_rest_service(monkeypatch, lambda *_: pytest.fail("discovery repeated"))
    _semantic_content_io(
        service, {"original": "Tala Birch signed."}, {"Tala Birch signed.": "include"}
    )
    updated, verified, _, _ = await service._page(
        {"user_id": "owner", "generation": 7, "checkpoint": checkpoint}
    )
    store, job, writes = _semantic_commit_store(monkeypatch, checkpoint)

    for unverified in [item, {**item, "contentVerified": True}]:
        with pytest.raises(DriveReadError, match="provider_response_invalid"):
            await store.commit_page(job, checkpoint=updated, files=[unverified])
        assert writes == []
    # Same frozen request/source, now carrying production-validated evidence.
    result = await store.commit_page(job, checkpoint=updated, files=verified)
    assert result["status"] == "running" and result["matched"] == 1
    assert len(writes) == 2  # One result insert and one checkpoint update.


@pytest.mark.asyncio
@pytest.mark.parametrize("direction", ["upgrade", "downgrade"])
async def test_semantic_commit_cannot_change_saved_search_mode(monkeypatch, direction):
    semantic = _semantic_checkpoint("Tala Birch")
    legacy = _checkpoint()
    saved, proposed = (legacy, semantic) if direction == "upgrade" else (semantic, legacy)
    store, job, writes = _semantic_commit_store(monkeypatch, saved)
    with pytest.raises(DriveReadError, match="search_superseded"):
        await store.commit_page(job, checkpoint=proposed, files=[])
    assert writes == []


@pytest.mark.asyncio
@pytest.mark.parametrize("authority_mode", ["owner", "trusted_auto"])
async def test_request_stop_withdraws_running_search_authority(monkeypatch, authority_mode):
    from hushh_mcp.services import drive_owner_search_store as store_module

    now = datetime.now(UTC)
    checkpoint = {
        "request_origin_id": "request",
        "request_revision": 3,
        "authority_mode": authority_mode,
    }
    request = {
        "status": "pending",
        "revision": 3,
        "expires_at": now + timedelta(minutes=10),
        "bulk_search_started_at": now,
        "access_stop_requested_at": None,
        "preparation_error_code": "trusted_auto_active",
        "recipient_user_id": "recipient",
        "request_envelope": {},
    }
    row = {
        "status": "running",
        "lease_id": "lease",
        "lease_expires_at": now + timedelta(minutes=2),
        "expires_at": now + timedelta(minutes=10),
        "consent_version": store_module.CONSENT_VERSION,
    }
    store = object.__new__(DriveOwnerSearchStore)
    store.search_cipher = SimpleNamespace(open=lambda *args, **kwargs: {"trusted_auto": True})
    monkeypatch.setattr(store, "_access", lambda *args: None)
    monkeypatch.setattr(store, "_evidence_current", lambda *args: None)
    monkeypatch.setattr(store, "_owned", lambda *args, **kwargs: row)
    monkeypatch.setattr(store, "_checkpoint", lambda *args: checkpoint)
    monkeypatch.setattr(store, "background_current", lambda *args, **kwargs: None)
    monkeypatch.setattr(store_module, "automatic_recipient_current", lambda *args, **kwargs: True)

    def request_row(connection, statement, parameters):
        assert "access_stop_requested_at" in statement
        return request

    monkeypatch.setattr(store, "_row", request_row)
    connection = SimpleNamespace(execute=lambda *args: SimpleNamespace(scalar_one=lambda: now))
    job = {
        "job_id": "job",
        "user_id": "owner",
        "generation": 7,
        "lease_id": "lease",
        "checkpoint": checkpoint,
    }
    # Control: the same running lease and current consent allow request work.
    assert store._current(connection, job) is row
    # Stop does not change the revision, Trusted/Allow or background setting.
    request["access_stop_requested_at"] = now
    with pytest.raises(DriveReadError, match="search_superseded"):
        store._current(connection, job)


@pytest.mark.asyncio
async def test_semantic_authority_revoked_during_read_cannot_publish_or_advance(monkeypatch):
    service, _ = _real_rest_service(monkeypatch, lambda *_: pytest.fail("discovery repeated"))
    checkpoint = _semantic_checkpoint("Mira Quill")
    item = _provider_file("pending", "Untitled", version="9")
    checkpoint.update(
        semantic_pending=[{**item, "sourceVersion": "9"}], semantic_discovery_done=True
    )
    model = AsyncMock(side_effect=AssertionError("revoked content reached model"))
    service.candidate_assessor = partial(assess_request_candidates, assessor=model)
    revoked = False

    async def current(job):
        if revoked:
            raise DriveReadError("connection_changed")

    class Reader:
        def __init__(self, **kwargs):
            pass

        async def read_compilation_match(self, *, match):
            nonlocal revoked
            revoked = True
            return (
                SimpleNamespace(name="Untitled", mime_type=item["mimeType"], version="9"),
                "Mira Quill signed.",
                False,
            )

    service.store = SimpleNamespace(require_current=current)
    service.reader_factory = Reader
    before = deepcopy(checkpoint)
    with pytest.raises(DriveReadError, match="connection_changed"):
        await service._page({"user_id": "owner", "generation": 7, "checkpoint": checkpoint})
    assert checkpoint == before
    model.assert_not_awaited()


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


@pytest.mark.parametrize("review_required", [False, True])
async def test_real_rest_projection_resolves_shortcut_resource_key_and_live_facts(
    monkeypatch, review_required
):
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
    checkpoint = _checkpoint()
    checkpoint.update(request_owner_review_required=review_required)
    checkpoint, files, incomplete, done = await service._page(
        {"user_id": "owner", "checkpoint": checkpoint}
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
    if review_required:
        assert files[0]["requestEvidence"]["assessment"] == "unverified"


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
    facts = {item["id"]: item["shareabilityEvidence"] for item in files}
    assert {key: value["reason"] for key, value in facts.items()} == {
        "wanted": "capability_denied",
        "allowed": "allowed",
        "encrypted": "encryption_restricted",
        "unknown": "capability_unverified",
    }
    assert facts["wanted"]["canShare"] is False
    assert facts["encrypted"]["canShare"] is True
    assert facts["encrypted"]["encryptionState"] == "not_unencrypted"
    assert facts["unknown"]["canShare"] is None
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


@pytest.mark.asyncio
async def test_broad_statement_hit_remains_unverified_when_title_and_modified_date_mislead():
    checkpoint = _checkpoint()
    checkpoint.update(
        authority_mode="trusted_auto",
        request_owner_review_required=True,
        request_subject_terms=["Schwab", "brokerage", "statement"],
        request_notes=False,
        requested_period={
            "start": "2026-09-01",
            "end": "2026-10-09",
            "timezone": "America/New_York",
        },
    )
    candidate = _request_candidate(
        "generic-title",
        "Account record.pdf",
        "application/pdf",
        createdTime="2017-03-14T00:00:00Z",
        modifiedTime="2026-10-01T00:00:00Z",
    )
    service = DriveOwnerSearchService()
    files, incomplete = await service._request_candidates(
        {"user_id": "owner"}, checkpoint, [candidate], folder_scoped=False, drive_id=None
    )
    assert not incomplete
    assert [item["id"] for item in files] == ["generic-title"]
    assert files[0]["requestEvidence"] == {
        "version": 1,
        "assessment": "unverified",
        "basis": "provider_search",
    }

    # The same broad hit cannot enter the metadata-only trusted-auto path.
    checkpoint["request_owner_review_required"] = False
    automatic, _ = await service._request_candidates(
        {"user_id": "owner"}, checkpoint, [candidate], folder_scoped=False, drive_id=None
    )
    assert automatic == []


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


@pytest.mark.asyncio
async def test_rejected_drive_token_fails_the_slice_as_a_reconnect_not_an_outage(monkeypatch):
    original = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: original(
            **kw, transport=httpx.MockTransport(lambda request: httpx.Response(401))
        ),
    )
    monkeypatch.setattr(rest, "connector_feature_enabled", lambda *_: True)
    connection = {
        "status": "connected",
        "validation_state": "verified",
        "verified_policy_hash": LIVE_POLICY_HASH,
        "connection_generation": 1,
    }
    transport = rest.GoogleDriveRestTransport(
        oauth=SimpleNamespace(
            current_credential=AsyncMock(return_value=(connection, {"accessToken": "revoked"})),
            lifecycle=SimpleNamespace(read=AsyncMock(return_value=connection)),
        ),
        adapter=GoogleDriveAdapter(),
    )
    checkpoint = _checkpoint()
    job = {"job_id": "synthetic-job", "user_id": "owner", "checkpoint": checkpoint}
    store = SimpleNamespace(
        claim=AsyncMock(return_value=job),
        require_current=AsyncMock(),
        commit_page=AsyncMock(),
        release=AsyncMock(return_value="failed"),
    )
    service = DriveOwnerSearchService(store=store, transport=transport)
    assert await service.run_one(user_id="owner", job_id="synthetic-job") == "failed"
    store.commit_page.assert_not_awaited()
    # Not a retryable "provider_unavailable": the saved cursor is untouched and
    # the status asks for the Drive connection instead of a later retry.
    store.release.assert_awaited_once_with(job, error="connection_changed")
    assert checkpoint["page_token"] is None


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


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field", ["provider", "deployment", "config_fingerprint", "approval_generation"]
)
async def test_semantic_commit_cannot_change_sealed_model_binding(monkeypatch, field):
    from hushh_mcp.services import drive_request_package_assessment as assessment

    monkeypatch.setattr(assessment, "validate_semantic_model_binding", lambda value: value)
    checkpoint = _semantic_checkpoint("Synthetic Subject")
    checkpoint["semantic_model_binding"] = {
        "provider": "azure_openai",
        "deployment": "synthetic-deployment",
        "config_fingerprint": "a" * 64,
        "approval_generation": "synthetic-generation",
    }
    store, job, writes = _semantic_commit_store(monkeypatch, checkpoint)
    changed = deepcopy(checkpoint)
    changed["semantic_model_binding"][field] = "changed"
    with pytest.raises(DriveReadError, match="search_superseded"):
        await store.commit_page(job, checkpoint=changed, files=[])
    assert writes == []
    result = await store.commit_page(job, checkpoint=deepcopy(checkpoint), files=[])
    assert result["status"] == "running" and len(writes) == 1


@pytest.mark.asyncio
async def test_semantic_checkpoint_seals_explicit_binding_and_its_policy(monkeypatch):
    from hushh_mcp.services import drive_request_package_assessment as assessment

    monkeypatch.setattr(
        assessment, "validate_semantic_model_binding", lambda value: deepcopy(value)
    )
    binding = {
        "provider": "azure_openai",
        "deployment": "synthetic-deployment",
        "config_fingerprint": "a" * 64,
        "approval_generation": "synthetic-generation",
    }
    store = SimpleNamespace(
        clear_legacy_completed_request=AsyncMock(),
        by_client=AsyncMock(return_value=None),
        create=AsyncMock(return_value=({"jobId": "synthetic-job"}, True)),
        align_request_expiry=AsyncMock(),
    )
    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace())
    service.run_one = AsyncMock()
    service.status = AsyncMock(return_value={"jobId": "synthetic-job", "status": "queued"})
    monkeypatch.setattr(search_module, "wake_drive_work", AsyncMock())
    await service.create_for_request(
        user_id="owner",
        request_id="12345678-1234-1234-1234-123456789012",
        request_revision=1,
        purpose={
            "purpose": "Synthetic Subject records",
            "periodStart": "2026-09-02",
            "periodEnd": "2026-10-02",
        },
        plan={
            "mode": "find",
            "terms": [],
            "file_kind": "any",
            "semantic_query": _semantic_checkpoint("Synthetic Subject")["semantic_plan"],
        },
        require_current=AsyncMock(),
        semantic_search=True,
        semantic_model_binding=binding,
    )
    sealed = store.create.await_args.kwargs["checkpoint"]
    assert sealed["semantic_model_binding"] == binding
    assert sealed["semantic_model_binding"] is not binding
    assert sealed["semantic_assessment_policy"] == assessment_policy_version(binding)
    assert sealed["semantic_assessment_policy"] != assessment_policy_version()


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", [None, "gemini", "azure_openai"])
async def test_semantic_resume_uses_sealed_provider_instead_of_global_selector(
    monkeypatch, provider
):
    from hushh_mcp.services import drive_request_package_assessment as assessment

    gemini = {
        "provider": "gemini",
        "deployment": "synthetic-gemini",
        "config_fingerprint": "b" * 64,
        "approval_generation": None,
    }
    selected = {**gemini, "provider": provider or "gemini"}
    if provider == "azure_openai":
        selected.update(deployment="synthetic-azure", approval_generation="sealed-generation")
    monkeypatch.setenv("DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER", "azure_openai")
    from hushh_mcp.services import private_text_processing_approval_service as approval

    approval_guard = AsyncMock()
    monkeypatch.setattr(approval, "require_private_azure_text_approval", approval_guard)
    monkeypatch.setattr(
        assessment, "validate_semantic_model_binding", lambda value: deepcopy(value or gemini)
    )
    checkpoint = _semantic_checkpoint("Synthetic Subject")
    if provider is not None:
        checkpoint["semantic_model_binding"] = selected
        checkpoint["semantic_assessment_policy"] = assessment_policy_version(selected)
    item = {**_provider_file("source", "Untitled", version="9"), "sourceVersion": "9"}
    checkpoint.update(semantic_pending=[item], semantic_discovery_done=True)
    service, _ = _real_rest_service(monkeypatch, lambda *_: pytest.fail("discovery repeated"))
    reads = _semantic_content_io(service, {"source": "Synthetic subject evidence."}, {})
    service.candidate_assessor = None

    async def respond(**kwargs):
        source = kwargs["retrieved"]["untrusted_external_content"][0]
        return {
            "documents": [
                {
                    "document_ref": source["document_ref"],
                    "decision": "exclude",
                    "confidence": 90,
                    "reason": "No requested substantive relation.",
                    "citations": [],
                    "covered_periods": [],
                }
            ]
        }

    model = AsyncMock(side_effect=respond)
    monkeypatch.setattr(assessment, "assess_request_document_batch", model)
    updated, files, incomplete, done = await service._page(
        {"user_id": "owner", "generation": 7, "checkpoint": checkpoint}
    )
    assert reads == ["source"] and files == [] and done and not incomplete
    assert model.await_args.kwargs["model_binding"] == selected
    assert updated.get("semantic_model_binding") == checkpoint.get("semantic_model_binding")
    if provider == "azure_openai":
        assert approval_guard.await_count >= 2
        assert all(
            call.kwargs == {"expected_generation": "sealed-generation"}
            for call in approval_guard.await_args_list
        )
    else:
        approval_guard.assert_not_awaited()


@pytest.mark.asyncio
async def test_semantic_binding_drift_stops_before_content_read_or_assessment(monkeypatch):
    from hushh_mcp.services import drive_request_package_assessment as assessment

    checkpoint = _semantic_checkpoint("Synthetic Subject")
    checkpoint["semantic_model_binding"] = {"provider": "azure_openai"}
    checkpoint.update(semantic_pending=[{"id": "never-read"}], semantic_discovery_done=True)
    service = DriveOwnerSearchService(transport=SimpleNamespace())
    service.store = SimpleNamespace(require_current=AsyncMock())
    service.reader_factory = lambda **_: pytest.fail("content read after binding drift")
    monkeypatch.setattr(
        assessment,
        "validate_semantic_model_binding",
        lambda _: (_ for _ in ()).throw(ValueError("binding changed")),
    )
    with pytest.raises(DriveReadError, match="source_changed"):
        await service._page({"user_id": "owner", "generation": 7, "checkpoint": checkpoint})


@pytest.mark.asyncio
async def test_azure_approval_revoked_during_assessment_cannot_advance_pending_queue(monkeypatch):
    from hushh_mcp.services import drive_request_package_assessment as assessment
    from hushh_mcp.services import private_text_processing_approval_service as approval

    binding = {
        "provider": "azure_openai",
        "deployment": "synthetic-azure",
        "config_fingerprint": "a" * 64,
        "approval_generation": "sealed-generation",
    }
    monkeypatch.setattr(assessment, "validate_semantic_model_binding", lambda _: deepcopy(binding))
    approval_guard = AsyncMock()
    monkeypatch.setattr(approval, "require_private_azure_text_approval", approval_guard)
    checkpoint = _semantic_checkpoint("Synthetic Subject")
    checkpoint["semantic_model_binding"] = binding
    checkpoint["semantic_assessment_policy"] = assessment_policy_version(binding)
    item = {**_provider_file("source", "Untitled", version="9"), "sourceVersion": "9"}
    checkpoint.update(semantic_pending=[item], semantic_discovery_done=True)
    service, _ = _real_rest_service(monkeypatch, lambda *_: pytest.fail("discovery repeated"))
    _semantic_content_io(service, {"source": "Synthetic source evidence."}, {})
    service.candidate_assessor = None

    async def respond(**kwargs):
        approval_guard.side_effect = PermissionError("approval revoked while model ran")
        source = kwargs["retrieved"]["untrusted_external_content"][0]
        return {
            "documents": [
                {
                    "document_ref": source["document_ref"],
                    "decision": "exclude",
                    "confidence": 90,
                    "reason": "No requested relation.",
                    "citations": [],
                    "covered_periods": [],
                }
            ]
        }

    model = AsyncMock(side_effect=respond)
    monkeypatch.setattr(assessment, "assess_request_document_batch", model)
    with pytest.raises(PermissionError):
        await service._page({"user_id": "owner", "generation": 7, "checkpoint": checkpoint})
    model.assert_awaited_once()
    assert checkpoint["semantic_pending"] == [item]
    assert "semantic_assessed" not in checkpoint


@pytest.mark.asyncio
@pytest.mark.parametrize("remove", [False, True])
async def test_page_commit_cannot_add_or_remove_model_binding(monkeypatch, remove):
    from hushh_mcp.services import drive_request_package_assessment as assessment

    monkeypatch.setattr(assessment, "validate_semantic_model_binding", lambda value: value)
    legacy = _checkpoint()
    bound = deepcopy(legacy)
    bound["semantic_plan"] = _semantic_checkpoint("Synthetic Subject")["semantic_plan"]
    bound["semantic_model_binding"] = {"provider": "gemini"}
    saved, proposed = (bound, legacy) if remove else (legacy, bound)
    # Keep the search mode identical: this regression specifically fences model binding.
    saved["semantic_plan"] = proposed["semantic_plan"] = bound["semantic_plan"]
    store, job, writes = _semantic_commit_store(monkeypatch, saved)
    with pytest.raises(DriveReadError, match="search_superseded"):
        await store.commit_page(job, checkpoint=proposed, files=[])
    assert writes == []


def _discovery_checkpoint(subject="Cedar Rook"):
    from hushh_mcp.services.drive_request_discovery import (
        DISCOVERY_DELIVERY_POLICY,
        compile_discovery_queries,
    )

    checkpoint = _semantic_checkpoint(subject)
    queries = compile_discovery_queries(checkpoint["semantic_plan"])
    checkpoint.update(
        discovery_delivery_policy=DISCOVERY_DELIVERY_POLICY,
        request_file_kind="any",
        queries=queries,
        arguments=queries[0]["arguments"],
    )
    return checkpoint


@pytest.mark.asyncio
async def test_discovery_delivery_keeps_79_mixed_formats_without_any_content_assessment(
    monkeypatch,
):
    originals = [
        _provider_file(
            f"result-{n}",
            f"Cedar Rook record {n}",
            [
                "video/mp4",
                "application/pdf",
                "application/zip",
                "image/png",
                "application/vnd.google-apps.document",
            ][n % 5],
            version="9",
        )
        for n in range(79)
    ]
    outside = _provider_file("outside", "Cedar Rook 2024-01-01", version="9")
    folder = _provider_file("folder", "Cedar Rook folder", "application/vnd.google-apps.folder")

    def respond(path, params, keys):
        if path == "/drives":
            return {"drives": []}
        assert path == "/files"  # No body export, OCR, or companion reads.
        assert "mimeType != 'application/vnd.google-apps.folder'" in params["q"]
        assert "mimeType != 'application/vnd.google-apps.shortcut'" in params["q"]
        if params.get("pageToken") == "next":
            return {"files": originals[40:] + [originals[0], outside, folder]}
        return {"files": originals[:40], "nextPageToken": "next"}

    service, _ = _real_rest_service(monkeypatch, respond)
    service.reader_factory = lambda **_: pytest.fail("content reader invoked")
    service.candidate_assessor = AsyncMock(side_effect=AssertionError("assessor invoked"))
    checkpoint = _discovery_checkpoint()
    delivered = {}
    for _ in range(4):
        checkpoint, files, incomplete, done = await service._page(
            {"user_id": "owner", "generation": 7, "checkpoint": json.loads(json.dumps(checkpoint))}
        )
        assert not incomplete
        delivered.update({item["id"]: item for item in files})
        if done:
            break
    assert done and set(delivered) == {item["id"] for item in originals}
    assert checkpoint["folder_queue"] == []
    assert checkpoint["semantic_pending"] == []
    assert checkpoint["coverage_counts"]["excludedByDateCount"] == 1
    service.candidate_assessor.assert_not_awaited()
    for item in delivered.values():
        assert "contentVerified" not in item and "requestEvidence" not in item
        assert (
            item["discoveryEvidence"]["content_assessment"] == "not_applicable_by_delivery_policy"
        )
        assert item["discoveryEvidence"]["source"]["id"] == item["id"]


@pytest.mark.asyncio
async def test_discovery_commit_requires_frozen_query_policy_and_bound_source(monkeypatch):
    from hushh_mcp.services.drive_request_discovery import discovery_evidence

    checkpoint = _discovery_checkpoint()
    item = {**_provider_file("video", "Cedar Rook recording", "video/mp4"), "sourceVersion": "9"}
    item["discoveryEvidence"] = discovery_evidence(
        checkpoint, user_id="owner", generation=7, metadata=item
    )
    store, job, writes = _semantic_commit_store(monkeypatch, checkpoint)
    monkeypatch.setattr(DriveBulkShareStore, "refresh_request", AsyncMock())
    for key, value in [("name", "different"), ("contentVerified", True), ("discoveryEvidence", {})]:
        with pytest.raises(DriveReadError, match="provider_response_invalid"):
            await store.commit_page(job, checkpoint=checkpoint, files=[{**item, key: value}])
        assert not writes
    changed = {**checkpoint, "discovery_delivery_policy": None}
    with pytest.raises(DriveReadError, match="search_superseded"):
        await store.commit_page(job, checkpoint=changed, files=[])
    result = await store.commit_page(job, checkpoint=checkpoint, files=[item], done=True)
    assert result["status"] == "completed" and result["matched"] == 1


def test_discovery_query_preserves_required_terms_negation_and_no_discovery_aliases():
    from hushh_mcp.services.drive_request_discovery import compile_discovery_queries

    plan = _semantic_checkpoint("Cedar Rook")["semantic_plan"]
    predicates = plan["clauses"][0]["predicates"]
    predicates[0]["discovery_terms"] = ["Cedar"]
    predicates.extend(
        [
            {
                "id": "topic",
                "kind": "content",
                "value": "compensation",
                "match": "token",
                "negated": False,
                "discovery_terms": [],
            },
            {
                "id": "without",
                "kind": "title",
                "value": "draft",
                "match": "token",
                "negated": True,
                "discovery_terms": [],
            },
        ]
    )
    q = compile_discovery_queries(plan)[0]["arguments"]["query"]
    assert "'Cedar Rook'" in q and "name contains 'Cedar'" not in q
    assert "fullText contains 'compensation'" in q and "not ((name contains 'draft'))" in q
    plan["date_basis"] = "content"
    from hushh_mcp.services.drive_request_semantic_plan import SemanticPlanInputRequired

    with pytest.raises(SemanticPlanInputRequired):
        compile_discovery_queries(plan)


@pytest.mark.asyncio
async def test_discovery_refuses_query_provenance_drift_before_provider_io(monkeypatch):
    service, _ = _real_rest_service(monkeypatch, lambda *_: pytest.fail("drift reached Drive"))
    checkpoint = _discovery_checkpoint()
    checkpoint["arguments"] = {"query": "trashed = false"}
    with pytest.raises(DriveReadError, match="provider_response_invalid"):
        await service._page({"user_id": "owner", "generation": 7, "checkpoint": checkpoint})


def _activity_checkpoint():
    from hushh_mcp.services.drive_request_discovery import (
        DISCOVERY_ACTIVITY_UNION_POLICY,
        compile_discovery_queries,
    )

    checkpoint = _discovery_checkpoint()
    plan = checkpoint["semantic_plan"]
    plan.update(version=2, date_basis="activity_union")
    plan["clauses"][0]["predicates"][0].update(match="token", sparse_fallback_any_token=True)
    queries = compile_discovery_queries(plan)
    checkpoint.update(
        discovery_delivery_policy=DISCOVERY_ACTIVITY_UNION_POLICY,
        semantic_plan_digest=semantic_plan_digest(plan),
        queries=queries,
        arguments=queries[0]["arguments"],
        activity_fallback_decision=None,
        requested_period={"start": "2026-06-02", "end": "2026-10-02", "timezone": "Asia/Kolkata"},
    )
    return checkpoint


@pytest.mark.parametrize(
    "field",
    ["createdTime", "modifiedTime", "modifiedByMeTime", "sharedWithMeTime", "viewedByMeTime"],
)
def test_activity_date_union_each_signal_and_timezone_boundaries(field):
    from hushh_mcp.services.drive_date_ontology import match_activity_dates

    period = {"start": "2026-06-02", "end": "2026-10-02", "timezone": "Asia/Kolkata"}
    row = {
        "name": "Record",
        "createdTime": "invalid",
        "modifiedTime": "2027-01-01T00:00:00Z",
        field: "2026-06-01T18:30:00Z",
    }
    assert match_activity_dates(row, period)["signals"] == [field]
    row[field] = "2026-10-02T18:30:00Z"
    assert not match_activity_dates(row, period)["matched"]
    assert not match_activity_dates(
        {"createdTime": "2026-01-01T00:00:00Z", "modifiedTime": "2027-01-01T00:00:00Z"}, period
    )["matched"]


@pytest.mark.parametrize(
    "name,start,end,expected",
    [
        ("Record_2026-08-15.pdf", "2026-08-15", "2026-08-15", True),
        ("Record_20260815.pdf", "2026-08-15", "2026-08-15", True),
        ("Record_08-2026.pdf", "2026-08-15", "2026-08-15", True),
        ("Record_Aug_2026.pdf", "2026-08-15", "2026-08-15", True),
        ("Record_2026.pdf", "2026-06-02", "2026-10-02", False),
        ("Record_2026.pdf", "2025-01-01", "2027-12-31", True),
        ("Record_2024-02-29.pdf", "2024-02-29", "2024-02-29", True),
        ("Record_2026-02-29.pdf", "2026-02-01", "2026-02-28", False),
        ("Record_February 30th 2026.pdf", "2030-02-01", "2030-02-28", False),
        ("Record_01-02-60.pdf", "2060-02-01", "2060-02-01", True),
        ("Record_01-02-61.pdf", "1961-02-01", "1961-02-01", True),
    ],
)
def test_activity_filename_dates_are_calendar_valid_and_bounded(name, start, end, expected):
    from hushh_mcp.services.drive_date_ontology import match_activity_dates

    assert (
        match_activity_dates({"name": name}, {"start": start, "end": end, "timezone": "UTC"})[
            "matched"
        ]
        is expected
    )


def test_activity_numeric_dates_use_per_file_anchors_and_photo_written_calendar_day():
    from hushh_mcp.services.drive_date_ontology import match_activity_dates

    period = {"start": "2026-08-05", "end": "2026-08-05", "timezone": "UTC"}
    row = {"name": "Record_05-08-2026.pdf"}
    assert match_activity_dates(row, period)["matched"]
    row["createdTime"] = "2026-05-09T00:00:00Z"
    assert not match_activity_dates(row, period)["matched"]  # May8 anchored, August5 distant.
    row["createdTime"] = "invalid"
    assert match_activity_dates(row, period)["matched"]
    assert match_activity_dates({"imageMediaMetadata": {"time": "2026:08:05 00:30:00"}}, period)[
        "interpretations"
    ] == ["photo_recorded_date"]
    assert not match_activity_dates(
        {"imageMediaMetadata": {"time": "2026:08:05 00:30:00+01:00"}}, period
    )["matched"]
    assert not match_activity_dates({"createdTime": "2026-08-06T00:30:00+00:99"}, period)["matched"]


@pytest.mark.asyncio
async def test_activity_84_provider_candidates_gate_before_commit_without_per_file_reads(
    monkeypatch,
):
    originals = [
        _provider_file(f"activity-{i}", f"Cedar Rook record {i}", version="9") for i in range(84)
    ]
    for i, row in enumerate(originals):
        row.update(createdTime="2024-01-01T00:00:00Z", modifiedTime="2027-01-01T00:00:00Z")
        if i < 63:
            row["viewedByMeTime"] = "2026-08-01T00:00:00Z"

    def respond(path, params, keys):
        assert path in {"/files", "/drives"}
        if path == "/drives":
            return {"drives": []}
        assert "createdTime >=" not in params["q"] and "modifiedTime >=" not in params["q"]
        assert "orderBy" not in params
        return {"files": originals}

    service, adapter = _real_rest_service(monkeypatch, respond)
    service.reader_factory = lambda **_: pytest.fail("content reader invoked")
    service.candidate_assessor = AsyncMock(side_effect=AssertionError("assessor invoked"))
    checkpoint, files, incomplete, done = await service._page(
        {"user_id": "owner", "generation": 7, "checkpoint": _activity_checkpoint()}
    )
    assert not incomplete and not done and len(files) == 63
    assert checkpoint["coverage_counts"]["excludedByDateCount"] == 21
    assert checkpoint["activity_fallback_decision"] == {
        "first_page_valid_distinct_count": 84,
        "armed": False,
    }
    assert checkpoint["semantic_pending"] == []
    assert len(adapter.calls) == 1
    service.candidate_assessor.assert_not_awaited()
    from hushh_mcp.services.drive_request_discovery import discovery_evidence_matches

    assert all(
        discovery_evidence_matches(file, user_id="owner", generation=7, checkpoint=checkpoint)
        for file in files
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("count,armed", [(0, True), (1, True), (2, True), (3, False)])
async def test_sparse_fallback_counts_valid_distinct_rows_before_dates_and_keeps_query_provenance(
    monkeypatch, count, armed
):
    originals = [_provider_file(f"fallback-{i}", "Cedar Rook", version="9") for i in range(count)]
    for row in originals:
        row.update(createdTime="2024-01-01T00:00:00Z", modifiedTime="2024-01-01T00:00:00Z")
    if originals:
        originals.append(originals[0])
    service, _ = _real_rest_service(
        monkeypatch,
        lambda path, params, keys: {"drives": []} if path == "/drives" else {"files": originals},
    )
    checkpoint = _activity_checkpoint()
    frozen = deepcopy(checkpoint["queries"])
    checkpoint, files, _, _ = await service._page(
        {"user_id": "owner", "generation": 7, "checkpoint": checkpoint}
    )
    assert files == []
    assert checkpoint["activity_fallback_decision"] == {
        "first_page_valid_distinct_count": count,
        "armed": armed,
    }
    checkpoint, _, _, done = await service._page(
        {"user_id": "owner", "generation": 7, "checkpoint": checkpoint}
    )
    assert done is (not armed)
    assert checkpoint["queries"] == frozen
    if armed:
        assert checkpoint["query_index"] == 1


def test_semantic_v1_digest_is_unchanged_and_sparse_fallback_never_relaxes_exact_constraints():
    import hashlib

    from pydantic import ValidationError

    from hushh_mcp.services.drive_request_discovery import compile_discovery_queries
    from hushh_mcp.services.drive_request_semantic_plan import parse_semantic_plan

    old = _semantic_checkpoint("Cedar Rook")["semantic_plan"]
    assert (
        semantic_plan_digest(old)
        == hashlib.sha256(
            json.dumps(old, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        ).hexdigest()
    )
    assert parse_semantic_plan(old).model_dump(mode="json") == old
    plan = _activity_checkpoint()["semantic_plan"]
    plan["clauses"][0]["predicates"].append(
        {
            "id": "title",
            "kind": "title",
            "value": "resume",
            "match": "exact",
            "negated": False,
            "discovery_terms": [],
        }
    )
    primary, fallback = compile_discovery_queries(plan)
    assert (
        "name = 'resume'" in primary["arguments"]["query"]
        and "name = 'resume'" in fallback["arguments"]["query"]
    )
    for changes in [{"kind": "title"}, {"match": "phrase"}, {"negated": True}, {"value": "Cedar"}]:
        invalid = deepcopy(plan)
        invalid["clauses"][0]["predicates"][0].update(changes)
        with pytest.raises(ValidationError):
            parse_semantic_plan(invalid)


@pytest.mark.asyncio
async def test_paused_policy_four_never_invokes_azure_planner(monkeypatch):
    monkeypatch.setenv("DRIVE_REQUEST_ACTIVITY_UNION_PAUSED", "true")
    planner = AsyncMock(side_effect=AssertionError("planner invoked while paused"))
    context = {
        "purpose": {
            "purpose": "Cedar Rook",
            "periodStart": "2026-06-02",
            "periodEnd": "2026-10-02",
        },
        "revision": 1,
        "semanticSearch": True,
        "activityDateUnion": True,
        "autoshare": True,
    }
    service = DriveRequestBulkService(
        sharing=SimpleNamespace(request_bulk_context=AsyncMock(return_value=context)),
        search=SimpleNamespace(store=SimpleNamespace(by_client=AsyncMock(return_value=None))),
        semantic_planner=planner,
        require_owner=AsyncMock(),
        owner_index=SimpleNamespace(),
    )
    with pytest.raises(DriveReadError, match="provider_unavailable"):
        await service.start_search(
            user_id="owner", request_id="request", authority_mode="trusted_auto"
        )
    planner.assert_not_awaited()


def test_activity_private_diagnostics_project_only_frozen_query_and_decision():
    from hushh_mcp.services.drive_request_discovery import request_diagnostics

    checkpoint = _activity_checkpoint()
    assert request_diagnostics(_discovery_checkpoint()) is None
    assert request_diagnostics(checkpoint)["fallbackDecision"] is None
    checkpoint["activity_fallback_decision"] = {
        "armed": True,
        "first_page_valid_distinct_count": 2,
        "future_private_value": "must-not-leak",
    }
    diagnostics = request_diagnostics(checkpoint)
    assert diagnostics["fallbackDecision"] == {"armed": True, "first_page_valid_distinct_count": 2}
    assert diagnostics["queries"][0]["query"] == checkpoint["queries"][0]["arguments"]["query"]
    assert diagnostics["queries"][1]["enabled"] is True
    assert "must-not-leak" not in json.dumps(diagnostics)
    checkpoint["activity_fallback_decision"]["armed"] = False
    with pytest.raises(ValueError, match="invalid_fallback_decision"):
        request_diagnostics(checkpoint)


def test_incident_report_never_fabricates_raw_identity_or_copy_delivery():
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parents[3] / "scripts/replay_findings.py"
    spec = importlib.util.spec_from_file_location("drive_incident_replay", path)
    replay = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(replay)
    report = replay.build_report(
        {
            "saved_owner_search_checkpoint": {"results": [{"position": 1, "shareable": True}]},
            "after_fix_live_metadata_comparison": [
                {"position": 1, "equal": {"modifiedTime": False}}
            ],
        }
    )
    assert report["saved_provider_rows"] == 1
    assert report["rows"][0]["missing_raw_identity"] is True
    assert report["copy_comparisons"][0]["guard_replay"] == "unavailable_raw_snapshots_missing"
    assert report["timestamp_only_comparison_patterns"] == 0
    assert report["live_copy_delivery_verified"] is False
    assert report["original_copy_jobs_recreated"] is False


def test_live_activity_planner_grade_rejects_unexecuted_aliases_and_relaxed_quotes(capsys):
    import json

    from hushh_mcp.services.drive_request_semantic_plan import parse_semantic_plan
    from scripts.probe_drive_activity_planner import grade_plan

    plan = _activity_checkpoint()["semantic_plan"]
    entity = plan["clauses"][0]["predicates"][0]
    entity["value"] = "Cedar Vale"
    plan["clauses"] = [
        {
            "predicates": [
                {**entity, "id": "person_" + term},
                {
                    **entity,
                    "id": "concept_" + term,
                    "value": term,
                    "kind": "semantic",
                    "sparse_fallback_any_token": False,
                },
            ]
        }
        for term in ("resume", "cv")
    ]
    assert len(grade_plan(parse_semantic_plan(plan), "ordinary")) == 2
    plan["clauses"][1]["predicates"][1]["value"] = "resume"
    with pytest.raises(AssertionError, match="distinct_executable_concepts_missing"):
        grade_plan(parse_semantic_plan(plan), "ordinary")
    failure = json.loads(capsys.readouterr().out)
    assert failure == {
        "schema": "drive.activity_planner.probe.v1",
        "case": "ordinary",
        "stage": "grade",
        "result": "failed",
        "reason": "distinct_executable_concepts_missing",
    }
    plan["date_basis"] = "created"
    plan["clauses"] = [
        {
            "predicates": [
                {
                    **entity,
                    "id": "title",
                    "kind": "title",
                    "value": "Research Charter.pdf",
                    "match": "exact",
                    "sparse_fallback_any_token": False,
                },
                {
                    **entity,
                    "id": "draft",
                    "kind": "content",
                    "value": "draft",
                    "negated": True,
                    "sparse_fallback_any_token": False,
                },
            ]
        }
    ]
    assert len(grade_plan(parse_semantic_plan(plan), "explicit")) == 1
    extra = deepcopy(plan["clauses"][0])
    extra["predicates"] = [
        {
            **extra["predicates"][0],
            "id": "unconstrained",
            "kind": "semantic",
            "match": "token",
            "value": "resume",
        }
    ]
    plan["clauses"].append(extra)
    with pytest.raises(AssertionError, match="explicit_exact_filename_lost"):
        grade_plan(parse_semantic_plan(plan), "explicit")
    plan["clauses"].pop()
    plan["clauses"][0]["predicates"][0]["match"] = "token"
    with pytest.raises(AssertionError, match="explicit_exact_filename_lost"):
        grade_plan(parse_semantic_plan(plan), "explicit")

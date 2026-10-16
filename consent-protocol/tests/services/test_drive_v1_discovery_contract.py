"""V1 discovery broadens recall; content evaluation decides which files belong."""

# ruff: noqa: F811 -- shared disposable PostgreSQL fixtures

import hashlib
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

import hushh_mcp.services.drive_owner_search_service as search_module
from hushh_mcp.services.drive_owner_search_service import (
    DriveOwnerSearchService,
    compile_request_queries,
)
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.google_drive_adapter import LIVE_SUPPORTED_TYPES, DriveReadError
from tests.services.test_drive_owner_search_postgres import (  # noqa: F401
    connector_postgres_url,
    lifecycle,
    store,
)


def test_semantic_clues_union_with_exact_search_without_file_timestamp_cut():
    plan = {
        "mode": "find",
        "terms": ["Schwab", "statement"],
        "term_groups": [["Schwab", "Charles Schwab"], ["statement", "eStmt"]],
        "subject_scope": "specific_records",
        "subject_complete": True,
        "semantic_intent": "institutional_statement",
        "discovery_clues": ["Schwab", "portfolio", "holdings", "brokerage", "account"],
        "expected_document_anatomy": "Issuer, account and internal statement period.",
        "file_kind": "document",
        "time_intent": "document_coverage",
    }
    purpose = {
        "purpose": "All Schwab statements from 2026",
        "periodStart": "2026-09-01",
        "periodEnd": "2026-10-09",
    }

    queries, period = compile_request_queries(plan, purpose, "Asia/Kolkata")

    assert period == {"start": "2026-09-01", "end": "2026-10-09", "timezone": "Asia/Kolkata"}
    assert len(queries) == 4  # precise, broader subject, then two bounded clue groups
    assert " and " in queries[0]["arguments"]["query"]
    assert "Schwab" in queries[0]["arguments"]["query"]
    assert "statement" in queries[0]["arguments"]["query"]
    assert " or " in queries[1]["arguments"]["query"]
    assert "portfolio" in queries[2]["arguments"]["query"]
    assert "account" in queries[3]["arguments"]["query"]
    assert all(
        "modifiedTime >=" not in query["arguments"]["query"]
        and "createdTime >=" not in query["arguments"]["query"]
        for query in queries
    )
    assert all("result_limit" not in query for query in queries)


def _v1_statement_plan():
    return {
        "mode": "find",
        "terms": ["Schwab", "statement"],
        "required_entities": ["Schwab"],
        "semantic_intent": "institutional_statement",
        "discovery_clues": ["Schwab", "eStmt", "brokerage"],
        "expected_document_anatomy": "Issuer, account and internal statement period.",
        "file_kind": "document",
        "time_intent": "document_coverage",
    }


def _v1_structural_checkpoint(plan, queries):
    return {
        "v1_live_request": True,
        "authored_plan": plan,
        "request_origin_id": "request-id",
        "request_explicit_dates": True,
        "request_file_kind": "document",
        "request_owner_review_required": True,
        "request_direct_originals": False,
        "request_subject_terms": plan["terms"],
        "request_exact_title": None,
        "request_notes": False,
        "requested_period": {"start": "2026-09-01", "end": "2026-10-09", "timezone": "UTC"},
        "coverage_counts": {},
        "arguments": queries[-1]["arguments"],
        "queries": queries,
        "query_index": len(queries) - 1,
        "phase": "user",
        "page_token": None,
        "seen_tokens": [],
        "drive_page_token": None,
        "drive_tokens": [],
        "drives": [],
        "drive_index": 0,
        "folder_queue": [],
    }


@pytest.mark.asyncio
async def test_v1_structural_sweep_reads_generic_name_statement_candidates_without_fulltext():
    plan = _v1_statement_plan()
    queries, _ = compile_request_queries(
        plan,
        {
            "purpose": "All Schwab statements",
            "periodStart": "2026-09-01",
            "periodEnd": "2026-10-09",
        },
        "UTC",
        v1_live_request=True,
    )
    assert len(queries) == 3  # precise, named issuer, then MIME-only sweep
    structural = queries[-1]["arguments"]["query"]
    assert "fullText" not in structural and "title" not in structural
    assert "modifiedTime >=" not in structural and "createdTime >=" not in structural
    assert all(f"mimeType = '{mime}'" in structural for mime in LIVE_SUPPORTED_TYPES)
    assert "application/vnd.google-apps.shortcut" in structural

    async def read(*, user_id, tool_name, arguments):
        assert user_id == "owner" and tool_name == "search_files"
        assert arguments["query"] == structural
        return ExternalMcpToolResult(
            False,
            {
                "files": [
                    _provider_file("pdf-scan", "scan_001.pdf", "application/pdf"),
                    _provider_file(
                        "sheet", "Tabular data", "application/vnd.google-apps.spreadsheet"
                    ),
                    _provider_file("image", "IMG_0926.jpg", "image/jpeg"),
                ],
                "nextPageToken": None,
                "incompleteSearch": False,
            },
            False,
        )

    service = DriveOwnerSearchService(transport=SimpleNamespace(read_owner_search_page=read))
    checkpoint = _v1_structural_checkpoint(plan, queries)
    _, files, incomplete, _ = await service._page({"user_id": "owner", "checkpoint": checkpoint})

    assert [file["id"] for file in files] == ["pdf-scan", "sheet", "image"]
    assert all(file["requestEvidence"]["assessment"] == "unverified" for file in files)
    assert incomplete is False


@pytest.mark.asyncio
async def test_v1_structural_sweep_follows_second_page_and_propagates_provider_incomplete():
    plan = _v1_statement_plan()
    queries, _ = compile_request_queries(
        plan,
        {
            "purpose": "All Schwab statements",
            "periodStart": "2026-09-01",
            "periodEnd": "2026-10-09",
        },
        "UTC",
        v1_live_request=True,
    )
    seen_tokens = []

    async def read(*, user_id, tool_name, arguments):
        assert user_id == "owner" and tool_name == "search_files"
        token = arguments.get("pageToken")
        seen_tokens.append(token)
        return ExternalMcpToolResult(
            False,
            {
                "files": (
                    [_provider_file("generic-second-page", "IMG_0926.jpg", "image/jpeg")]
                    if token
                    else []
                ),
                "nextPageToken": None if token else "page-two",
                "incompleteSearch": bool(token),
            },
            False,
        )

    service = DriveOwnerSearchService(transport=SimpleNamespace(read_owner_search_page=read))
    checkpoint = _v1_structural_checkpoint(plan, queries)
    first, files, incomplete, done = await service._page(
        {"user_id": "owner", "checkpoint": checkpoint}
    )
    assert files == [] and incomplete is False and done is False
    assert first["page_token"] == "page-two"

    second, files, incomplete, done = await service._page({"user_id": "owner", "checkpoint": first})
    assert seen_tokens == [None, "page-two"]
    assert [file["id"] for file in files] == ["generic-second-page"]
    assert incomplete is True and done is False
    assert second["page_token"] is None


@pytest.mark.asyncio
async def test_v1_structural_sweep_cannot_finish_when_next_page_exceeds_work_budget(monkeypatch):
    plan = _v1_statement_plan()
    queries, _ = compile_request_queries(
        plan,
        {
            "purpose": "All Schwab statements",
            "periodStart": "2026-09-01",
            "periodEnd": "2026-10-09",
        },
        "UTC",
        v1_live_request=True,
    )

    async def read(*, user_id, tool_name, arguments):
        return ExternalMcpToolResult(
            False,
            {
                "files": [_provider_file("pdf-scan", "scan_001.pdf", "application/pdf")],
                "nextPageToken": "unread-next-page",
                "incompleteSearch": False,
            },
            False,
        )

    monkeypatch.setattr(search_module, "MAX_REQUEST_FILE_PAGES", 1)
    service = DriveOwnerSearchService(transport=SimpleNamespace(read_owner_search_page=read))
    checkpoint = _v1_structural_checkpoint(plan, queries)
    next_checkpoint, files, incomplete, done = await service._page(
        {"user_id": "owner", "checkpoint": checkpoint}
    )

    assert [file["id"] for file in files] == ["pdf-scan"]
    assert incomplete is True and done is True
    assert next_checkpoint["coverage_counts"]["workLimitReached"] is True


@pytest.mark.asyncio
async def test_v1_named_unsupported_document_reports_incomplete_instead_of_disappearing():
    plan = _v1_statement_plan()
    service = DriveOwnerSearchService(transport=SimpleNamespace())
    checkpoint = _v1_structural_checkpoint(plan, [{"arguments": {"query": "issuer hit"}}])
    files, incomplete = await service._request_candidates(
        {"user_id": "owner"},
        checkpoint,
        [_provider_file("archive", "Schwab statements.zip", "application/zip")],
        folder_scoped=False,
        drive_id=None,
    )

    assert files == [] and incomplete is True
    assert checkpoint["coverage_counts"]["unsupportedCandidateCount"] == 1


@pytest.mark.asyncio
async def test_v1_unsupported_term_hit_cannot_complete_search(store):
    plan = _v1_statement_plan()
    checkpoint = _v1_structural_checkpoint(plan, [{"arguments": {"query": "issuer hit"}}])
    checkpoint["coverage_manifest"] = {"corpora": ["user"], "formatScope": "supported_live_formats"}
    client_request_id = str(uuid4())
    state, created = await store.create(
        user_id="owner",
        client_request_id=client_request_id,
        request={"query": "All Schwab statements"},
        checkpoint=checkpoint,
        confirmed=True,
        v1_statement_search=True,
    )
    assert created
    job = await store.claim(user_id="owner", job_id=state["jobId"])
    service = DriveOwnerSearchService(transport=SimpleNamespace())
    files, incomplete = await service._request_candidates(
        {"user_id": "owner"},
        checkpoint,
        [_provider_file("archive", "Schwab statements.zip", "application/zip")],
        folder_scoped=False,
        drive_id=None,
    )

    final = await store.commit_page(
        job, checkpoint=checkpoint, files=files, incomplete=incomplete, done=True
    )

    assert final["status"] == "limited"
    assert final["incompleteSearch"] is True
    assert final["coverage"]["unsupportedCandidateCount"] == 1


@pytest.mark.asyncio
async def test_typo_financial_intent_keeps_generic_docs_and_spreadsheets_for_content_check():
    plan = {
        "mode": "find",
        "terms": ["financial"],
        "term_groups": [["financial", "finacial", "finance"]],
        "semantic_intent": "broad_financial_records",
        "discovery_clues": ["salary", "rent", "expense", "invoice", "upi"],
        "subject_scope": "specific_records",
        "subject_complete": True,
        "file_kind": "any",
        "time_intent": "document_coverage",
    }
    purpose = {
        "purpose": "last 1 year finacial staements and index them by value",
        "periodStart": "2025-10-16",
        "periodEnd": "2026-10-16",
    }
    queries, _ = compile_request_queries(plan, purpose, "Asia/Kolkata")
    compiled = [query["arguments"]["query"] for query in queries]
    assert any("rent" in query and "expense" in query for query in compiled)
    assert all("mimeType =" not in query and "modifiedTime >=" not in query for query in compiled)

    service = DriveOwnerSearchService(transport=SimpleNamespace())
    checkpoint = {
        "v1_live_request": True,
        "authored_plan": plan,
        "request_subject_terms": ["financial"],
        "request_exact_title": None,
        "request_owner_review_required": True,
        "request_file_kind": "any",
        "request_notes": False,
        "requested_period": {"start": "2025-10-16", "end": "2026-10-16", "timezone": "UTC"},
        "authority_mode": "agent_package",
        "request": {"query": purpose["purpose"]},
    }
    candidates = [
        _provider_file("doc", "Notes 001", "application/vnd.google-apps.document"),
        _provider_file("sheet", "Garage", "application/vnd.google-apps.spreadsheet"),
        _provider_file(
            "xlsx",
            "Tabular data",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
    ]
    found, incomplete = await service._request_candidates(
        {"user_id": "owner"}, checkpoint, candidates, folder_scoped=True, drive_id=None
    )
    assert [item["id"] for item in found] == ["doc", "sheet", "xlsx"]
    assert all(item["requestEvidence"]["assessment"] == "unverified" for item in found)
    assert incomplete is False


def _provider_file(file_id, title, mime):
    return {
        "id": file_id,
        "title": title,
        "mimeType": mime,
        "createdTime": "2016-01-02T00:00:00Z",
        "modifiedTime": "2026-10-12T00:00:00Z",
        "capabilities": {"canShare": True},
    }


@pytest.mark.asyncio
async def test_v1_clue_folder_keeps_generic_and_old_named_descendants_as_candidates():
    service = DriveOwnerSearchService(transport=SimpleNamespace())
    checkpoint = {
        "v1_live_request": True,
        "authored_plan": {"discovery_clues": ["Schwab", "Investments"]},
        "request_subject_terms": ["Schwab", "statement"],
        "request_exact_title": None,
        "request_owner_review_required": True,
        "request_file_kind": "document",
        "request_notes": False,
        "requested_period": {"start": "2026-09-01", "end": "2026-10-09", "timezone": "UTC"},
        "authority_mode": "agent_package",
        "request": {"query": "Schwab statements from 2026"},
    }
    folder = _provider_file(
        "folder-investments", "Investments", "application/vnd.google-apps.folder"
    )
    folder_results, incomplete = await service._request_candidates(
        {"user_id": "owner"}, checkpoint, [folder], folder_scoped=False, drive_id=None
    )
    assert folder_results == [] and incomplete is False
    assert [item["id"] for item in checkpoint["folder_queue"]] == ["folder-investments"]

    # A dated title or provider modification time cannot decide whether the
    # document is a 2026 statement. Keep both for the content evaluator.
    children = [
        _provider_file("generic-scan", "scan_001.pdf", "application/pdf"),
        _provider_file("old-title", "archive_2016.pdf", "application/pdf"),
    ]
    found, incomplete = await service._request_candidates(
        {"user_id": "owner"}, checkpoint, children, folder_scoped=True, drive_id=None
    )
    assert [item["id"] for item in found] == ["generic-scan", "old-title"]
    assert all(item["requestEvidence"]["assessment"] == "unverified" for item in found)
    assert incomplete is False


@pytest.mark.asyncio
async def test_legacy_folder_expansion_keeps_existing_filename_gate():
    service = DriveOwnerSearchService(transport=SimpleNamespace())
    checkpoint = {
        "request_subject_terms": ["Schwab", "statement"],
        "request_exact_title": None,
        "request_owner_review_required": True,
        "request_file_kind": "document",
        "request_notes": False,
        "requested_period": None,
        "authority_mode": "agent_package",
        "request": {"query": "Schwab statements"},
    }
    found, incomplete = await service._request_candidates(
        {"user_id": "owner"},
        checkpoint,
        [_provider_file("generic-scan", "scan_001.pdf", "application/pdf")],
        folder_scoped=True,
        drive_id=None,
    )
    assert found == [] and incomplete is False
    assert checkpoint["coverage_counts"]["excludedByTopicCount"] == 1


@pytest.mark.asyncio
async def test_v1_large_page_retries_same_cursor_at_100_then_25():
    calls = []

    async def read(*, user_id, tool_name, arguments):
        assert user_id == "owner" and tool_name == "search_files"
        calls.append(arguments.copy())
        if len(calls) < 3:
            raise DriveReadError("file_too_large")
        return ExternalMcpToolResult(
            False, {"files": [], "nextPageToken": None, "incompleteSearch": False}, False
        )

    service = DriveOwnerSearchService(transport=SimpleNamespace(read_owner_search_page=read))
    checkpoint = {
        "v1_live_request": True,
        "request_origin_id": "request-id",
        "request_explicit_dates": True,
        "request_file_kind": "document",
        "request_owner_review_required": True,
        "request_direct_originals": False,
        "requested_period": {"start": "2026-09-01", "end": "2026-10-09", "timezone": "UTC"},
        "coverage_counts": {},
        "arguments": {"query": "trashed = false", "orderBy": "modifiedTime desc"},
        "queries": [{"arguments": {"query": "trashed = false", "orderBy": "modifiedTime desc"}}],
        "phase": "user",
        "page_token": "same-cursor",
        "seen_tokens": [],
        "drive_page_token": None,
        "drive_tokens": [],
        "drives": [],
        "drive_index": 0,
        "folder_queue": [],
    }

    next_checkpoint, files, incomplete, done = await service._page(
        {"user_id": "owner", "checkpoint": checkpoint}
    )

    assert [item["pageSize"] for item in calls] == [1000, 100, 25]
    assert [item["pageToken"] for item in calls] == ["same-cursor"] * 3
    assert next_checkpoint["file_page_size"] == 25
    assert files == [] and incomplete is False and done is False


@pytest.mark.asyncio
async def test_v1_thousand_row_commit_batches_dedupe_and_preserves_positions(monkeypatch):
    store = DriveOwnerSearchStore(db=SimpleNamespace())
    checkpoint = {
        "v1_live_request": True,
        "coverage_manifest": {"corpora": ["user"]},
        "coverage_counts": {},
    }
    job = {"job_id": "search-job", "user_id": "owner"}
    existing_digest = hashlib.sha256(b"file-0").hexdigest()
    store.search_cipher = SimpleNamespace(
        digest=lambda _purpose, identity: hashlib.sha256(identity[1].encode()).hexdigest()
    )
    monkeypatch.setattr(store, "_seal", lambda *_: "sealed")
    monkeypatch.setattr(
        store,
        "_current",
        lambda *_: {"matched": 1, "unshareable_count": 0, "incomplete_search": False},
    )
    monkeypatch.setattr(store, "_checkpoint", lambda *_: {"v1_live_request": True})
    updated = {}
    monkeypatch.setattr(
        store, "_row", lambda _conn, _sql, params: updated.update(params) or {"status": "running"}
    )
    monkeypatch.setattr(store, "_view", lambda row: row)
    inserts = []

    class Result:
        def scalars(self):
            return [existing_digest]

    class Connection:
        def execute(self, statement, params):
            sql = str(statement)
            if "SELECT file_digest" in sql:
                assert len(params["digests"]) == 999
                return Result()
            if "INSERT INTO drive_owner_search_results" in sql:
                inserts.append(params)
                return None
            raise AssertionError(sql)

    async def transaction(operation):
        return operation(Connection())

    monkeypatch.setattr(store, "_transaction", transaction)
    files = [{"id": f"file-{index}", "shareable": True} for index in range(999)]
    files.append({"id": "file-1", "shareable": True})  # duplicate within the page

    result = await store.commit_page(job, checkpoint=checkpoint, files=files)

    assert result["status"] == "running"
    assert updated["count"] == 999  # one prior row + 998 new unique rows
    assert len(inserts) == 1 and len(inserts[0]) == 998
    assert [item["position"] for item in inserts[0]] == list(range(2, 1000))
    assert checkpoint["coverage_counts"]["deduplicatedCount"] == 2


@pytest.mark.asyncio
async def test_unmarked_job_rejects_large_commit_before_database(monkeypatch):
    store = DriveOwnerSearchStore(db=SimpleNamespace())
    transaction = AsyncMock()
    monkeypatch.setattr(store, "_transaction", transaction)
    with pytest.raises(DriveReadError, match="invalid_argument"):
        await store.commit_page(
            {"job_id": "legacy", "user_id": "owner"},
            checkpoint={},
            files=[{"id": f"file-{index}"} for index in range(101)],
        )
    transaction.assert_not_awaited()


@pytest.mark.asyncio
async def test_v1_thousand_row_commit_dedupes_on_real_postgres(store):
    checkpoint = {
        "v1_live_request": True,
        "arguments": {"query": "trashed = false"},
        "phase": "user",
        "page_token": None,
        "drive_page_token": None,
        "drives": [],
        "drive_index": 0,
        "seen_tokens": [],
        "drive_tokens": [],
        "coverage_manifest": {"corpora": ["user"]},
        "coverage_counts": {},
    }
    state, created = await store.create(
        user_id="owner",
        client_request_id=str(uuid4()),
        request={"query": "Synthetic"},
        checkpoint=checkpoint,
        confirmed=True,
        v1_statement_search=True,
    )
    assert created
    job = await store.claim(user_id="owner", job_id=state["jobId"])

    def file(number):
        return {
            "id": f"file-{number}",
            "name": f"Synthetic file {number}",
            "mimeType": "application/pdf",
            "modifiedTime": "2026-10-12T00:00:00Z",
            "createdTime": "2016-01-02T00:00:00Z",
            "shareable": True,
        }

    await store.commit_page(job, checkpoint=checkpoint, files=[file(1)])
    page = [file(number) for number in range(1, 1000)] + [file(2)]
    final = await store.commit_page(job, checkpoint=checkpoint, files=page, done=True)

    assert final["status"] == "completed"
    assert final["matched"] == 999
    assert final["coverage"]["deduplicatedCount"] == 2
    assert (await store.reference(user_id="owner", job_id=state["jobId"], position=999))[
        "id"
    ] == "file-999"


def test_explicit_issuer_search_does_not_expand_to_every_account_document():
    queries, _ = compile_request_queries(
        {
            "terms": ["Schwab", "statement"],
            "required_entities": ["Schwab"],
            "discovery_clues": ["account", "portfolio", "holdings"],
            "file_kind": "document",
            "time_intent": "document_coverage",
        },
        {"purpose": "Schwab statements", "periodStart": "2026-09-01", "periodEnd": "2026-10-09"},
        "UTC",
    )
    assert len(queries) == 2
    broad = queries[1]["arguments"]["query"]
    assert "fullText contains 'Schwab'" in broad
    assert "title contains 'Schwab'" in broad
    assert "contains 'statement'" not in broad
    assert "contains 'account'" not in broad
    assert "modifiedTime >=" not in broad

"""Request discovery is evidence for owner review, never permission to share."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from hushh_mcp.services.drive_owner_search_service import (
    DriveOwnerSearchService,
    compile_request_queries,
)
from hushh_mcp.services.drive_request_review_policy import checkpoint_requires_owner_review
from hushh_mcp.services.drive_trusted_auto_service import DriveTrustedAutoService
from tests.services.test_drive_request_search_unit import (
    _checkpoint,
    _provider_file,
    _real_rest_service,
    _request_candidate,
)


def _selection(**changes):
    return {
        "request_origin_id": "request-one",
        "request_revision": 3,
        "request_selection_version": 2,
        "request_time_intent": "file_activity",
        "request_owner_review_required": False,
        **changes,
    }


@pytest.mark.parametrize(
    "changes",
    [
        {"request_origin_id": "request-two"},
        {"request_revision": 2},
        {"request_selection_version": 1},
        {"request_selection_version": "2"},
        {"request_time_intent": "document_coverage"},
        {"request_time_intent": "unknown"},
        {"request_owner_review_required": True},
        {"request_owner_review_required": 0},
        {"request_owner_review_required": None},
    ],
)
def test_automatic_selection_requires_exact_binding_and_explicit_semantics(changes):
    assert checkpoint_requires_owner_review(
        _selection(**changes), request_id="request-one", revision=3
    )


@pytest.mark.parametrize("missing", list(_selection()))
def test_legacy_selection_missing_any_authority_field_requires_owner_review(missing):
    checkpoint = _selection()
    checkpoint.pop(missing)
    assert checkpoint_requires_owner_review(checkpoint, request_id="request-one", revision=3)


@pytest.mark.parametrize("checkpoint", [None, [], "invalid", {}])
def test_malformed_or_absent_checkpoint_never_authorizes_automatic_share(checkpoint):
    assert checkpoint_requires_owner_review(checkpoint, request_id="request-one", revision=3)


def test_current_file_activity_selection_remains_automatic_eligible():
    assert not checkpoint_requires_owner_review(_selection(), request_id="request-one", revision=3)


def test_synonyms_are_or_within_each_concept_and_and_between_concepts():
    queries, _ = compile_request_queries(
        {
            "mode": "find",
            "terms": ["Schwab", "statement"],
            "term_groups": [["Schwab", "Charles Schwab"], ["statement", "brokerage report"]],
            "file_kind": "document",
        },
        {"purpose": "Schwab statements", "periodStart": "2026-01-01", "periodEnd": "2026-09-30"},
        "UTC",
    )
    query = queries[0]["arguments"]["query"]
    assert "fullText contains 'Schwab') or (title contains 'Charles Schwab'" in query
    assert "fullText contains 'statement') or (title contains 'brokerage report'" in query
    assert "fullText contains '\"Charles Schwab\"')) and ((title contains 'statement'" in query
    assert "modifiedTime" not in query and "createdTime" not in query


@pytest.mark.parametrize("intent", [None, "", "unknown", True, []])
def test_malformed_time_intent_does_not_compile_to_a_broader_query(intent):
    with pytest.raises(ValidationError, match="time_intent"):
        compile_request_queries(
            {"mode": "find", "terms": ["Schwab"], "time_intent": intent},
            {
                "purpose": "Schwab statements",
                "periodStart": "2026-01-01",
                "periodEnd": "2026-09-30",
            },
            "UTC",
        )


@pytest.mark.asyncio
async def test_exact_title_remains_literal_for_content_coverage_candidates():
    checkpoint = _checkpoint()
    checkpoint.update(
        request_owner_review_required=True,
        request_exact_title="Schwab statement.pdf",
        authority_mode="trusted_auto",
        request_notes=False,
    )
    queries, _ = compile_request_queries(
        {"mode": "find", "exact_title": "Schwab statement.pdf", "file_kind": "document"},
        {"purpose": "Schwab statement.pdf", "periodStart": "2026-01-01", "periodEnd": "2026-09-30"},
        "UTC",
    )
    assert "name = 'Schwab statement.pdf'" in queries[0]["arguments"]["query"]
    assert "fullText" not in queries[0]["arguments"]["query"]
    files, incomplete = await DriveOwnerSearchService(
        transport=SimpleNamespace()
    )._request_candidates(
        {"user_id": "owner"},
        checkpoint,
        [
            _request_candidate("literal", "Schwab statement.pdf", "application/pdf"),
            _request_candidate("related", "Schwab statement.pdf backup", "application/pdf"),
        ],
        folder_scoped=False,
        drive_id=None,
    )
    assert not incomplete
    assert [file["id"] for file in files] == ["literal"]
    assert checkpoint["coverage_counts"]["excludedByFilenameCount"] == 1


@pytest.mark.asyncio
async def test_46_generic_provider_hits_survive_pagination_and_old_metadata_dates(monkeypatch):
    checkpoint = _checkpoint()
    checkpoint.update(
        request_selection_version=2,
        request_time_intent="document_coverage",
        request_owner_review_required=True,
        authority_mode="trusted_auto",
        request_subject_terms=["Schwab", "statement"],
        request_notes=False,
    )
    candidates = [
        _provider_file(
            f"statement-{index}",
            f"Archive {index:02d}.pdf",
            "application/pdf",
            createdTime="2020-01-01T00:00:00Z",
            modifiedTime="2020-01-01T00:00:00Z",
        )
        for index in range(46)
    ]

    def respond(path, params, keys):
        if path == "/drives":
            return {"drives": []}
        assert path == "/files"  # Discovery must never download or export content.
        if params.get("pageToken") == "page-two":
            return {"files": candidates[25:]}
        return {"files": candidates[:25], "nextPageToken": "page-two"}

    service, adapter = _real_rest_service(monkeypatch, respond)
    found = []
    for _ in range(4):
        checkpoint, files, incomplete, done = await service._page(
            {"user_id": "owner", "checkpoint": checkpoint}
        )
        assert not incomplete
        found.extend(files)
        if done:
            break
    assert done
    assert len(found) == len({item["id"] for item in found}) == 46
    assert all(
        item["requestEvidence"]
        == {"version": 1, "assessment": "unverified", "basis": "provider_search"}
        for item in found
    )
    assert checkpoint["coverage_counts"].get("excludedByDateCount", 0) == 0
    assert checkpoint["coverage_counts"].get("excludedByFilenameCount", 0) == 0
    assert any(params.get("pageToken") == "page-two" for _, params, _ in adapter.calls)


@pytest.mark.asyncio
@pytest.mark.parametrize("review_required", [True, False])
async def test_content_coverage_and_file_activity_keep_distinct_eligibility(review_required):
    checkpoint = _checkpoint()
    checkpoint.update(
        **_selection(
            request_time_intent="document_coverage" if review_required else "file_activity",
            request_owner_review_required=review_required,
        ),
        authority_mode="trusted_auto",
        request_subject_terms=["Schwab", "statement"],
        request_notes=False,
    )
    candidates = [
        _request_candidate("generic", "Archive.pdf", "application/pdf"),
        _request_candidate("current", "Schwab statement.pdf", "application/pdf"),
        _request_candidate(
            "old",
            "Schwab statement 2020-01-01.pdf",
            "application/pdf",
            createdTime="2020-01-01T00:00:00Z",
            modifiedTime="2020-01-01T00:00:00Z",
        ),
        _request_candidate("video", "Schwab statement recording", "video/mp4"),
        _request_candidate(
            "blocked",
            "Schwab statement protected.pdf",
            "application/pdf",
            capabilities={"canShare": False},
        ),
    ]
    service = DriveOwnerSearchService(transport=SimpleNamespace())
    files, incomplete = await service._request_candidates(
        {"user_id": "owner"}, checkpoint, candidates, folder_scoped=False, drive_id=None
    )
    assert not incomplete
    assert {file["id"] for file in files} == (
        {"generic", "current", "old", "blocked"} if review_required else {"current", "blocked"}
    )
    assert next(file for file in files if file["id"] == "blocked")["shareable"] is False
    counts = checkpoint["coverage_counts"]
    assert counts["excludedByKindCount"] == 1
    assert counts.get("excludedByFilenameCount", 0) == (0 if review_required else 1)
    assert counts.get("excludedByDateCount", 0) == (0 if review_required else 1)
    assert counts.get("excludedByNoteTypeCount", 0) == 0


@pytest.mark.asyncio
async def test_owner_review_stops_auto_before_freezing_payment_or_approval():
    sharing = SimpleNamespace(
        trusted_request_authority=AsyncMock(return_value={}),
        request_owner_review_required=AsyncMock(return_value=True),
        request_bulk_context=AsyncMock(
            return_value={
                "purpose": {
                    "purpose": "Schwab statements",
                    "periodStart": "2026-01-01",
                    "periodEnd": "2026-09-30",
                }
            }
        ),
    )
    bulk = SimpleNamespace(
        pending_request_reviews=AsyncMock(),
        unclaimed_positions=AsyncMock(),
        refresh_request=AsyncMock(),
    )
    payment = SimpleNamespace(ensure_payment_for_frozen_batch=AsyncMock())
    service = DriveTrustedAutoService(sharing=sharing, bulk=bulk, payment=payment, wake=AsyncMock())
    assert await service.share_available(user_id="owner", request_id="request-one") == 0
    bulk.pending_request_reviews.assert_not_awaited()
    bulk.unclaimed_positions.assert_not_awaited()
    payment.ensure_payment_for_frozen_batch.assert_not_awaited()

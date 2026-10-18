"""Synthetic User A/User B meeting-note discovery and sharing boundaries."""

# ruff: noqa: F811 -- reuse the isolated PostgreSQL fixtures from the bulk-flow suite

from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_owner_search_service import (
    DriveOwnerSearchService,
    compile_request_queries,
)
from hushh_mcp.services.drive_request_bulk_service import _deterministic_meeting_note_plan
from hushh_mcp.services.drive_request_package_assessment import (
    BoundDocumentBatchAssessment,
    verify_v1_document_batch,
)
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from tests.services.test_drive_request_bulk_postgres import (  # noqa: F401
    _recipient,
    _request,
    _search,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    request_bulk,
    sharing,
)

REQUEST = {
    "purpose": "3 months of meeting notes",
    "periodStart": "2026-09-02",
    "periodEnd": "2026-10-02",
    "semanticIntent": "other",
}
SELECTION = {
    "request_selection_version": 2,
    "request_time_intent": "document_coverage",
    "request_owner_review_required": True,
}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("case", "title", "modified", "body", "event", "decision"),
    [
        (
            "generic_title_old_file_activity",
            "Untitled",
            "2016-01-02T00:00:00Z",
            "Team Standup 2026-09-29. Decisions: approved the rollout checklist.",
            "2026-09-29",
            "include",
        ),
        (
            "old_event_recent_edit",
            "Meeting notes",
            "2026-09-30T00:00:00Z",
            "Team Standup 2016-09-29. Decisions: approved the old checklist.",
            "2016-09-29",
            "uncertain",
        ),
        (
            "wrong_event_recent_edit",
            "Meeting notes",
            "2026-09-30T00:00:00Z",
            "Team Standup 2026-08-31. Decisions: reviewed the checklist.",
            "2026-08-31",
            "uncertain",
        ),
        (
            "false_keyword_mention",
            "Meeting notes 2026-09-29",
            "2026-09-30T00:00:00Z",
            "2026-09-29. Meeting notes are not available; this is a budget forecast.",
            "2026-09-29",
            "uncertain",
        ),
    ],
)
async def test_user_a_discovery_then_user_b_content_decision(
    case, title, modified, body, event, decision
):
    plan = _deterministic_meeting_note_plan(REQUEST)
    assert plan is not None, case
    queries, period = compile_request_queries(
        plan.model_dump(mode="json"), REQUEST, "Asia/Kolkata", v1_live_request=True
    )
    assert period == {"start": "2026-09-02", "end": "2026-10-02", "timezone": "Asia/Kolkata"}
    assert "standup" in queries[2]["arguments"]["query"]
    assert all(
        "modifiedTime >=" not in item["arguments"]["query"]
        and "createdTime >=" not in item["arguments"]["query"]
        for item in queries
    )

    # A's provider result is only a candidate. Its title and file activity
    # cannot establish whether the event meets B's requested date window.
    checkpoint = {
        "v1_live_request": True,
        "request_subject_terms": plan.terms,
        "request_file_kind": "document",
        "request_owner_review_required": True,
        "request_notes": True,
        "requested_period": period,
        "request": {"query": REQUEST["purpose"]},
    }
    provider_file = {
        "id": "synthetic-note",
        "title": title,
        "mimeType": "application/vnd.google-apps.document",
        "createdTime": "2016-01-02T00:00:00Z",
        "modifiedTime": modified,
        "capabilities": {"canShare": True},
    }
    candidates, incomplete = await DriveOwnerSearchService(
        transport=SimpleNamespace()
    )._request_candidates(
        {"user_id": "user-a"}, checkpoint, [provider_file], folder_scoped=True, drive_id=None
    )
    assert [item["id"] for item in candidates] == ["synthetic-note"], case
    assert candidates[0]["requestEvidence"]["assessment"] == "unverified"
    assert incomplete is False

    assessment = BoundDocumentBatchAssessment.model_validate(
        {
            "documents": [
                {
                    "document_ref": "candidate-1",
                    "decision": "include",
                    "confidence": 95,
                    "weightage_out_of_10": 8,
                    "record_type_claim": "meeting notes",
                    "entity_claim": None,
                    "period_role": "event_date",
                    "reason": "The candidate may be meeting notes.",
                    "citations": [{"source_ref": "source-1", "quote": event}],
                    "covered_periods": [
                        {"period_start": event, "period_end": event, "source_refs": ["source-1"]}
                    ],
                    "source_version": "synthetic-v1",
                }
            ]
        }
    )
    checked = verify_v1_document_batch(
        assessment,
        request=REQUEST,
        retrieved={
            "untrusted_external_content": [
                {
                    "document_ref": "candidate-1",
                    "source_ref": "source-1",
                    "text": body,
                    "name": title,
                }
            ]
        },
    )
    assert checked.documents[0].decision == decision, case
    if decision == "uncertain":
        assert checked.documents[0].confidence == 0


@pytest.mark.asyncio
async def test_user_b_batch_continuation_and_decline_stay_with_exact_owner_review(
    request_bulk, sharing
):
    # A approves one 25-file batch for B. The remaining 25 stay reviewable,
    # and approval alone cannot dispatch a Google permission before payment.
    request = await _request(sharing, purpose_text="3 months of meeting notes")
    request_id = request["requestId"]
    search = _search(request_bulk, request_id=request_id, count=50, selection=SELECTION)
    first = await request_bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request_id,
        selected_positions=list(range(1, 26)),
    )
    await request_bulk.approve(
        user_id="owner",
        share_id=first["shareId"],
        revision=first["revision"],
        review_digest=first["reviewDigest"],
    )
    assert await request_bulk.unclaimed_positions(user_id="owner", request_id=request_id) == list(
        range(26, 51)
    )
    # Unpaid, the approved grant is not offered and a direct claim defers.
    assert first["shareId"] not in {str(row["share_id"]) for row in await request_bulk.due()}
    assert (
        await request_bulk.claim(
            user_id="owner",
            share_id=first["shareId"],
            position=1,
            recipient_user_id="recipient",
        )
        is None
    )
    with pytest.raises(DriveSharingError, match="request_changed"):
        await request_bulk.create_review(
            user_id="owner",
            search_job_id=search,
            client_request_id=str(uuid4()),
            recipients=[_recipient("trusted-member", "trusted@example.invalid")],
            excluded=[],
            origin_request_id=request_id,
            selected_positions=list(range(26, 51)),
        )
    second = await request_bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request_id,
        selected_positions=list(range(26, 51)),
    )
    assert second["positions"] == list(range(26, 51))
    with pytest.raises(DriveSharingError, match="bulk_conflict"):
        await request_bulk.create_review(
            user_id="owner",
            search_job_id=search,
            client_request_id=str(uuid4()),
            recipients=[_recipient("recipient", "b@example.invalid")],
            excluded=[],
            origin_request_id=request_id,
            selected_positions=[25, 26],
        )
    with sharing.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_bulk_share_effects WHERE share_id=:share"),
                {"share": second["shareId"]},
            ).scalar_one()
            == 0
        )

    # A denied request cannot be revived by an already prepared review.
    declined = await _request(sharing, purpose_text="3 months of meeting notes")
    declined_id = declined["requestId"]
    denied_search = _search(request_bulk, request_id=declined_id, count=1, selection=SELECTION)
    denied_review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=denied_search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=declined_id,
        selected_positions=[1],
    )
    await sharing.decline_or_cancel(
        user_id="owner",
        request_id=declined_id,
        revision=declined["revision"],
        decision="declined",
    )
    with pytest.raises(DriveSharingError):
        await request_bulk.approve(
            user_id="owner",
            share_id=denied_review["shareId"],
            revision=denied_review["revision"],
            review_digest=denied_review["reviewDigest"],
        )
    with sharing.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_bulk_share_effects WHERE share_id=:share"),
                {"share": denied_review["shareId"]},
            ).scalar_one()
            == 0
        )

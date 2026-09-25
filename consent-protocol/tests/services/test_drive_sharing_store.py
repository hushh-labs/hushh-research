"""Private request/exact-file approvals using real isolated PostgreSQL."""

# ruff: noqa: F811 -- shared pytest fixture imports

import asyncio
import base64
import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_document_store import PROCESSING_DISCLOSURE_VERSION
from hushh_mcp.services.drive_sharing_contract import (
    BROAD_TRUST_DISCLOSURE,
    BROAD_TRUST_SCOPE,
    DriveSharingError,
    ReviewedSource,
    ShareRequestPurpose,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.drive_sharing_store import DriveSharingStore
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_document_selection import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    pick,
    source,
)

MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"


@pytest.fixture
async def sharing(documents, monkeypatch):
    monkeypatch.setenv("DRIVE_SHARING_KEY_V1", base64.b64encode(b"s" * 32).decode())
    monkeypatch.setenv("DRIVE_DOCUMENT_SHARING", "true")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner,recipient")
    with documents.db.engine.connect() as connection:
        connection.exec_driver_sql("CREATE TABLE agent_chat_conversations(id UUID PRIMARY KEY)")
        connection.exec_driver_sql(
            "CREATE TABLE one_adk_sessions(app_name TEXT,created_at TIMESTAMPTZ)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE connections(id UUID PRIMARY KEY,user_a_id TEXT,user_b_id TEXT,status TEXT)"
        )
        connection.execute(
            text("INSERT INTO connections VALUES (:id,'owner','recipient','active')"),
            {"id": str(uuid4())},
        )
        connection.commit()
        for name in (
            "114_one_action_directive_ledger.sql",
            "212_location_command_runtime.sql",
            "231_document_review_authority.sql",
            "232_drive_document_sharing.sql",
            "232_drive_document_sharing.sql",
            "233_drive_suggestion_preparation.sql",
            "233_drive_suggestion_preparation.sql",
            "234_drive_permission_management_retention.sql",
            "234_drive_permission_management_retention.sql",
        ):
            connection.execute(text((MIGRATIONS / name).read_text()))
        connection.commit()
    return DriveSharingStore(db=documents.db, authority_key="synthetic-ledger-key")


async def request(sharing, client_id=None):
    return await sharing.create_request(
        recipient=VerifiedGoogleRecipient(
            "recipient", "1234567", "recipient@example.invalid", datetime.now(UTC)
        ),
        owner_user_id="owner",
        client_request_id=client_id or str(uuid4()),
        purpose=ShareRequestPurpose(
            purpose="Private six-month statements", periodStart="2026-01-01", periodEnd="2026-06-30"
        ),
    )


async def review(sharing):
    _, selected = await pick(sharing, [source("one"), source("two")])
    ids = [item["documentId"] for item in selected]
    for identifier in ids:
        await sharing.set_processing(
            user_id="owner",
            generation=1,
            document_id=identifier,
            enabled=True,
            disclosure=PROCESSING_DISCLOSURE_VERSION,
        )
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE connected_documents SET status='ready',active_version=:version"),
            {"version": "a" * 64},
        )
    created = await request(sharing)
    with sharing.db.engine.connect() as connection:
        observed = [
            ReviewedSource.model_validate(sharing._source_terms(dict(row)))
            for row in connection.execute(text("SELECT * FROM connected_documents")).mappings()
        ]
    prepared = await sharing.prepare_review(
        user_id="owner",
        generation=1,
        request_id=created["requestId"],
        expected_revision=0,
        document_ids=ids,
        observed_sources=observed,
        coverage={"summary": "Synthetic fixture, not a coverage claim."},
    )
    return prepared, ids


async def approve(sharing, prepared, ids, **changes):
    return await sharing.approve_review(
        **{
            "user_id": "owner",
            "generation": 1,
            "request_id": prepared["requestId"],
            "revision": prepared["revision"],
            "review_digest": prepared["reviewDigest"],
            "document_ids": ids,
            "confirmed": True,
            **changes,
        }
    )


def rows(sharing, table):
    assert table in {
        "drive_share_management_contexts",
        "drive_share_file_claims",
        "connected_documents",
        "external_connector_oauth_attempts",
        "user_external_connector_connections",
        "drive_share_requests",
        "drive_share_reviews",
        "drive_share_events",
        "drive_share_permission_operations",
        "one_action_directive_ledger",
    }
    with sharing.db.engine.connect() as connection:
        return [
            dict(row) for row in connection.exec_driver_sql(f"SELECT * FROM {table}").mappings()
        ]


@pytest.mark.asyncio
async def test_request_is_private_idempotent_and_does_not_share(sharing):
    client = str(uuid4())
    first = await request(sharing, client)
    assert await request(sharing, client) == first
    assert len(rows(sharing, "drive_share_requests")) == 1
    assert len(rows(sharing, "drive_share_events")) == 1
    assert rows(sharing, "drive_share_permission_operations") == []
    stored = rows(sharing, "drive_share_requests")[0]
    for private in ("Private six-month", "recipient@example.invalid", "1234567"):
        assert private not in json.dumps(stored, default=str)


@pytest.mark.asyncio
async def test_concurrent_identical_request_retries_return_one_request(sharing):
    client = str(uuid4())
    results = await asyncio.gather(*(request(sharing, client) for _ in range(4)))
    assert all(result == results[0] for result in results)
    assert len(rows(sharing, "drive_share_requests")) == 1
    assert len(rows(sharing, "drive_share_events")) == 1


@pytest.mark.asyncio
async def test_suggestions_cannot_adopt_a_newer_index_after_interpretation(sharing):
    prepared, ids = await review(sharing)
    with sharing.db.engine.begin() as connection:
        observed = [
            ReviewedSource.model_validate(sharing._source_terms(dict(row)))
            for row in connection.execute(text("SELECT * FROM connected_documents")).mappings()
        ]
        connection.execute(text("UPDATE connected_documents SET active_version=repeat('b',64)"))
    with pytest.raises(DriveSharingError, match="source_changed"):
        await sharing.prepare_review(
            user_id="owner",
            generation=1,
            request_id=prepared["requestId"],
            expected_revision=1,
            document_ids=ids,
            observed_sources=observed,
            coverage={"summary": "Derived from old index"},
        )
    assert len(rows(sharing, "drive_share_reviews")) == 1


@pytest.mark.asyncio
async def test_recipient_sees_status_not_private_suggestions(sharing):
    prepared, _ = await review(sharing)
    status = await sharing.request_status(user_id="recipient", request_id=prepared["requestId"])
    assert status["status"] == "pending"
    assert set(status) == {"requestId", "status", "revision", "direction"}
    assert status["direction"] == "outgoing"
    with pytest.raises(DriveSharingError, match="request_unavailable"):
        await sharing.owner_review(user_id="recipient", request_id=prepared["requestId"])
    private = await sharing.owner_review(user_id="owner", request_id=prepared["requestId"])
    assert len(private["files"]) == 2
    assert private["recipientEmail"] == "recipient@example.invalid"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    [
        "UPDATE user_external_connector_connections SET status='revoked' WHERE user_id='owner'",
        "UPDATE connected_documents SET source_version='2'",
        "UPDATE connected_documents SET processing_enabled=FALSE",
        "UPDATE connections SET status='removed'",
    ],
)
async def test_review_does_not_offer_stale_approval(sharing, mutation):
    prepared, _ = await review(sharing)
    assert (await sharing.owner_review(user_id="owner", request_id=prepared["requestId"]))[
        "canApprove"
    ]
    with sharing.db.engine.begin() as connection:
        connection.execute(text(mutation))
    assert not (await sharing.owner_review(user_id="owner", request_id=prepared["requestId"]))[
        "canApprove"
    ]


@pytest.mark.asyncio
async def test_disabled_sharing_keeps_private_review_readable_without_approve(sharing, monkeypatch):
    prepared, _ = await review(sharing)
    monkeypatch.setenv("DRIVE_DOCUMENT_SHARING", "false")
    private = await sharing.owner_review(user_id="owner", request_id=prepared["requestId"])
    assert not private["canApprove"]
    assert len(private["files"]) == 2


@pytest.mark.asyncio
async def test_decline_invalidates_authority_and_does_not_need_execution_flag(sharing, monkeypatch):
    prepared, ids = await review(sharing)
    monkeypatch.setenv("DRIVE_DOCUMENT_SHARING", "false")
    assert (
        await sharing.decline_or_cancel(
            user_id="owner", request_id=prepared["requestId"], revision=1, decision="declined"
        )
    )["status"] == "declined"
    assert rows(sharing, "one_action_directive_ledger")[0]["state"] == "cancelled"
    assert rows(sharing, "drive_share_permission_operations") == []


@pytest.mark.asyncio
async def test_approval_enqueues_exact_files_without_claiming_provider_success(sharing):
    prepared, ids = await review(sharing)
    result = await approve(sharing, prepared, ids)
    assert result["status"] == "approved"
    assert result["sharingStatus"] == "pending"
    operations = rows(sharing, "drive_share_permission_operations")
    assert len(operations) == 2
    assert {str(item["document_id"]) for item in operations} == set(ids)
    assert {item["state"] for item in operations} == {"queued"}
    assert all(item["receipt_envelope"] is None for item in operations)
    assert {item["state"] for item in rows(sharing, "one_action_directive_ledger")} == {"consumed"}
    for operation in operations:
        assert "recipient@example.invalid" not in json.dumps(operation, default=str)
        plan = sharing.sharing_cipher.open(
            operation["plan_envelope"],
            user_id="owner",
            resource_id=str(operation["operation_id"]),
            purpose="permission-plan",
        )
        assert plan["recipient"]["email"] == "recipient@example.invalid"
        assert plan["approval"]["role"] == "reader"


@pytest.mark.asyncio
async def test_owner_can_share_some_of_the_reviewed_files(sharing):
    prepared, ids = await review(sharing)
    result = await approve(sharing, prepared, ids[:1])
    assert result["status"] == "approved"
    assert result["fileCount"] == 1
    operations = rows(sharing, "drive_share_permission_operations")
    # Only the selected file is queued; the other reviewed file is never granted.
    assert [str(item["document_id"]) for item in operations] == ids[:1]
    assert {item["state"] for item in rows(sharing, "one_action_directive_ledger")} == {"consumed"}
    # The sealed plan names only the shared file, so dispatch never rechecks
    # (or is withdrawn by) the file A chose not to share.
    plan = sharing.sharing_cipher.open(
        operations[0]["plan_envelope"],
        user_id="owner",
        resource_id=str(operations[0]["operation_id"]),
        purpose="permission-plan",
    )
    assert [source["document_id"] for source in plan["approval"]["sources"]] == ids[:1]


@pytest.mark.asyncio
async def test_queue_grants_refuses_a_plan_that_names_other_files(sharing):
    approval = SimpleNamespace(
        sources=[SimpleNamespace(document_id="one"), SimpleNamespace(document_id="two")]
    )
    with pytest.raises(DriveSharingError, match="invalid_selection"):
        sharing._queue_grants(
            None, request=None, approval=approval, sources=[{"document_id": "one"}], batch="b"
        )


@pytest.mark.asyncio
async def test_trust_for_future_requests_needs_the_whole_review(sharing):
    prepared, ids = await review(sharing)
    with pytest.raises(DriveReadError, match="rule_not_covered"):
        await approve(
            sharing,
            prepared,
            ids[:1],
            trust_future_requests=True,
            trust_scope=BROAD_TRUST_SCOPE,
            trust_disclosure_version=BROAD_TRUST_DISCLOSURE,
        )
    assert rows(sharing, "drive_share_permission_operations") == []
    assert rows(sharing, "one_action_directive_ledger")[0]["state"] == "issued"


@pytest.mark.asyncio
async def test_concurrent_decisions_never_enqueue_duplicates(sharing):
    prepared, ids = await review(sharing)
    result = await asyncio.gather(
        *(approve(sharing, prepared, ids) for _ in range(4)), return_exceptions=True
    )
    assert sum(isinstance(item, dict) for item in result) == 1
    assert len(rows(sharing, "drive_share_permission_operations")) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changed",
    [
        "wrong_owner",
        "outside_file",
        "duplicate_file",
        "wrong_file",
        "revision",
        "digest",
        "unconfirmed",
        "generation",
    ],
)
async def test_substituted_approval_has_no_effect(sharing, changed):
    prepared, ids = await review(sharing)
    changes = {
        "wrong_owner": {"user_id": "recipient"},
        "outside_file": {"document_ids": [ids[0], str(uuid4())]},
        "duplicate_file": {"document_ids": [ids[0], ids[0]]},
        "wrong_file": {"document_ids": [str(uuid4())]},
        "revision": {"revision": 2},
        "digest": {"review_digest": "0" * 64},
        "unconfirmed": {"confirmed": False},
        "generation": {"generation": 2},
    }
    with pytest.raises(DriveReadError):
        await approve(sharing, prepared, ids, **changes[changed])
    assert rows(sharing, "drive_share_permission_operations") == []
    assert rows(sharing, "one_action_directive_ledger")[0]["state"] == "issued"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    [
        "UPDATE connected_documents SET source_version='2'",
        "UPDATE connected_documents SET processing_enabled=FALSE,processing_revision=processing_revision+1",
        "UPDATE drive_share_requests SET recipient_binding=repeat('c',64)",
        "UPDATE drive_share_reviews SET expires_at=clock_timestamp()-INTERVAL '1 second'",
        "UPDATE connections SET status='revoked'",
    ],
)
async def test_current_source_recipient_consent_and_relationship_fences(sharing, mutation):
    prepared, ids = await review(sharing)
    with sharing.db.engine.begin() as connection:
        connection.exec_driver_sql(mutation)
    with pytest.raises(DriveReadError):
        await approve(sharing, prepared, ids)
    assert rows(sharing, "drive_share_permission_operations") == []


@pytest.mark.asyncio
async def test_disconnect_removes_index_but_not_approved_permission_work(sharing):
    prepared, ids = await review(sharing)
    await approve(sharing, prepared, ids)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE user_external_connector_connections SET status='revoked',connection_generation=connection_generation+1 WHERE user_id='owner' AND connector_id='google_drive'"
            )
        )
        assert connection.execute(text("SELECT count(*) FROM connected_documents")).scalar() == 0
    assert len(rows(sharing, "drive_share_permission_operations")) == 2
    assert len(rows(sharing, "drive_share_reviews")) == 1


@pytest.mark.asyncio
async def test_background_opt_out_prevents_suggestion_publication(sharing):
    _, selected = await pick(sharing)
    created = await request(sharing)
    with pytest.raises(DriveSharingError, match="source_changed"):
        await sharing.prepare_review(
            user_id="owner",
            generation=1,
            request_id=created["requestId"],
            expected_revision=0,
            document_ids=[selected[0]["documentId"]],
            observed_sources=[],
            coverage={},
        )
    assert rows(sharing, "drive_share_reviews") == []


@pytest.mark.asyncio
async def test_empty_suggestions_are_reviewable_but_not_approval_authority(sharing):
    created = await request(sharing)
    prepared = await sharing.prepare_review(
        user_id="owner",
        generation=1,
        request_id=created["requestId"],
        expected_revision=0,
        document_ids=[],
        observed_sources=[],
        coverage={"summary": "No eligible selected files."},
    )
    assert rows(sharing, "one_action_directive_ledger") == []
    with pytest.raises(DriveSharingError, match="review_changed"):
        await approve(sharing, prepared, [])


async def test_a_prepared_review_still_tells_the_owner(sharing):
    """The owner-selected share skips this alert; B's ordinary request must not."""
    prepared, _ = await review(sharing)
    events = [
        (item["user_id"], item["event_type"])
        for item in rows(sharing, "drive_share_events")
        if str(item["request_id"]) == prepared["requestId"]
    ]
    assert ("owner", "document_share_review_ready") in events

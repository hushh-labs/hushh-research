"""Drive context authority checks against isolated PostgreSQL sharing tables."""

# ruff: noqa: F811, S106 -- imported fixtures and synthetic test credentials.

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services import drive_context_envelope as context_module
from hushh_mcp.services.drive_context_envelope import DriveContextEnvelopeBuilder
from hushh_mcp.services.drive_document_store import PROCESSING_DISCLOSURE_VERSION
from hushh_mcp.services.external_connector_credentials_service import (
    ExternalConnectorCredentialsService,
)
from hushh_mcp.services.google_drive_adapter import POLICY_HASH, DriveReadError
from tests.services.test_drive_document_selection import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    pick,
    source,
)
from tests.services.test_drive_sharing_store import (  # noqa: F401
    approve,
    review,
    sharing,
)


@pytest.fixture
def envelope_builder(sharing, monkeypatch):
    monkeypatch.setenv("GOOGLE_DRIVE_CHAT_READS", "true")
    migration = (
        Path(__file__).resolve().parents[2] / "db/migrations/239_drive_context_file_lookup.sql"
    )
    with sharing.db.engine.begin() as connection:
        connection.exec_driver_sql(migration.read_text())
    return DriveContextEnvelopeBuilder(db=sharing.db)


def _connect_recipient(sharing):
    credentials = ExternalConnectorCredentialsService(db=sharing.db)
    expires = datetime.now(UTC) + timedelta(hours=1)
    sealed = credentials.seal_credential(
        user_id="recipient",
        connector_id="google_drive",
        generation=1,
        version=1,
        expires_at=expires,
        secret={"subject": "1234567", "accountLabel": "recipient@example.invalid"},
    )
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO user_external_connector_connections
                (user_id,connector_id,status,connection_generation,credential_version,
                 envelope_version,credential_ciphertext,credential_iv,credential_algorithm,
                 credential_expires_at,connected_account_label,validation_state,verified_policy_hash)
                VALUES ('recipient','google_drive','connected',1,1,2,:ciphertext,:iv,:algorithm,
                        :expires,'recipient@example.invalid','verified',:policy)"""),
            {**sealed, "expires": expires, "policy": POLICY_HASH},
        )


def _select_for_recipient(sharing, file_ids=("one", "two")):
    with sharing.db.engine.begin() as connection:
        for file_id in file_ids:
            metadata = source(file_id)
            document_id = str(uuid4())
            sealed = sharing.cipher.seal(
                metadata, user_id="recipient", document_id=document_id, generation=1
            )
            connection.execute(
                text("""INSERT INTO connected_documents
                    (document_id,user_id,connection_generation,source_fingerprint,
                     metadata_envelope,source_version,status,active_version,processing_enabled,
                     processing_disclosure_version,processing_revision)
                    VALUES (:id,'recipient',1,:fingerprint,CAST(:metadata AS jsonb),'1','ready',
                            :index,true,:disclosure,1)"""),
                {
                    "id": document_id,
                    "fingerprint": sharing.cipher.fingerprint("recipient", file_id),
                    "metadata": json.dumps(sealed),
                    "index": "b" * 64,
                    "disclosure": PROCESSING_DISCLOSURE_VERSION,
                },
            )


def _settle_grants(sharing):
    with sharing.db.engine.begin() as connection:
        rows = (
            connection.execute(
                text(
                    "SELECT operation_id FROM drive_share_permission_operations WHERE kind='grant'"
                )
            )
            .mappings()
            .all()
        )
        for row in rows:
            operation_id = str(row["operation_id"])
            receipt = sharing.sharing_cipher.seal(
                {"synthetic": True},
                user_id="owner",
                resource_id=operation_id,
                purpose="permission-receipt",
            )
            connection.execute(
                text("""UPDATE drive_share_permission_operations
                    SET state='succeeded',receipt_envelope=CAST(:receipt AS jsonb)
                    WHERE operation_id=:id"""),
                {"id": operation_id, "receipt": json.dumps(receipt)},
            )
    return [str(row["operation_id"]) for row in rows]


def _revoke(sharing, grant_id, *, state="succeeded"):
    with sharing.db.engine.begin() as connection:
        grant = dict(
            connection.execute(
                text("SELECT * FROM drive_share_permission_operations WHERE operation_id=:id"),
                {"id": grant_id},
            )
            .mappings()
            .one()
        )
        operation_id = str(uuid4())
        plan = sharing.sharing_cipher.seal(
            {"synthetic": True},
            user_id="owner",
            resource_id=operation_id,
            purpose="permission-plan",
        )
        receipt = sharing.sharing_cipher.seal(
            {"synthetic": True},
            user_id="owner",
            resource_id=operation_id,
            purpose="permission-receipt",
        )
        connection.execute(
            text("""INSERT INTO drive_share_permission_operations
                (operation_id,user_id,request_id,review_revision,batch_id,document_id,
                 connection_generation,file_lock_hmac,kind,parent_operation_id,plan_envelope,
                 receipt_envelope,state)
                VALUES (:id,'owner',:request,:revision,:batch,:document,1,:lock,'revoke',:parent,
                        CAST(:plan AS jsonb),CAST(:receipt AS jsonb),:state)"""),
            {
                "id": operation_id,
                "request": grant["request_id"],
                "revision": grant["review_revision"],
                "batch": f"synthetic-{operation_id}",
                "document": grant["document_id"],
                "lock": grant["file_lock_hmac"],
                "parent": grant_id,
                "plan": json.dumps(plan),
                "receipt": json.dumps(receipt),
                "state": state,
            },
        )
        connection.execute(
            text("""UPDATE drive_share_management_contexts
                SET revocation_revision=revocation_revision+1 WHERE request_id=:request"""),
            {"request": grant["request_id"]},
        )


@pytest.mark.asyncio
async def test_public_serialization_uses_fresh_refs_and_exact_utf8_byte_cap(monkeypatch):
    monkeypatch.setattr(context_module, "connector_feature_enabled", lambda *_: True)
    builder = DriveContextEnvelopeBuilder(db=SimpleNamespace())
    builder._snapshot = lambda _user: [
        context_module._Candidate(
            {
                "document_id": str(uuid4()),
                "connection_generation": 1,
                "active_version": "a" * 64,
                "source_version": "1",
                "processing_revision": 1,
            },
            "secret-file-id",
            "secret-lock",
        )
    ]
    first = await builder.assemble("owner", "é" * 80)
    second = await builder.assemble("owner", "é" * 80)
    assert first.documents[0].source_ref != second.documents[0].source_ref
    encoded = first.model_dump_json().encode("utf-8")
    assert "secret-file-id" not in encoded.decode()
    assert "document_id" not in encoded.decode()
    monkeypatch.setattr(context_module, "MAX_ENVELOPE_BYTES", len(encoded) - 1)
    with pytest.raises(DriveReadError, match="narrow_selection_required"):
        await builder.assemble("owner", "é" * 80)


@pytest.mark.asyncio
async def test_own_selected_documents_are_private_metadata_only(envelope_builder, sharing):
    await review(sharing)
    first = await envelope_builder.assemble_for_invocation("owner", "turn-one")
    second = await envelope_builder.assemble_for_invocation("owner", "turn-one")
    assert len(first.public.documents) == 2
    assert {item.origin for item in first.public.documents} == {"own_selection"}
    assert {item.grant_revision for item in first.public.documents} == {None}
    assert {item.period_start for item in first.public.documents} == {None}
    assert set(first._bindings) != set(second._bindings)
    ref = first.public.documents[0].source_ref
    assert first.resolve(ref, actor_user_id="owner", turn_id="turn-one").document_user_id == "owner"
    for assembly, actor, turn in (
        (second, "owner", "turn-one"),
        (first, "recipient", "turn-one"),
        (first, "owner", "other-turn"),
    ):
        with pytest.raises(DriveReadError, match="source_unavailable"):
            assembly.resolve(ref, actor_user_id=actor, turn_id=turn)
    public = first.public.model_dump_json()
    for forbidden in (
        "source-one",
        "Private synthetic filename",
        "document_id",
        "file_id",
        "_bindings",
    ):
        assert forbidden not in public


@pytest.mark.asyncio
async def test_two_grants_bind_only_recipient_selected_targets(envelope_builder, sharing):
    prepared, ids = await review(sharing)
    await approve(sharing, prepared, ids)
    _settle_grants(sharing)
    _connect_recipient(sharing)
    assert (await envelope_builder.assemble("recipient", "before-selection")).documents == ()
    _select_for_recipient(sharing)
    assembly = await envelope_builder.assemble_for_invocation("recipient", "grant-turn")
    assert len(assembly.public.documents) == 2
    assert {item.origin for item in assembly.public.documents} == {"shared_grant"}
    assert {item.grant_revision for item in assembly.public.documents} == {prepared["revision"]}
    assert {item.revocation_revision for item in assembly.public.documents} == {0}
    assert {item.owner_display for item in assembly.public.documents} == {None}
    for item in assembly.public.documents:
        binding = assembly.resolve(item.source_ref, actor_user_id="recipient", turn_id="grant-turn")
        assert binding.document_user_id == "recipient"
        assert binding.document_id not in ids
        assert len(binding.grants) == 1


@pytest.mark.asyncio
async def test_successful_revoke_suppresses_only_its_file_without_own_fallback(
    envelope_builder, sharing
):
    prepared, ids = await review(sharing)
    await approve(sharing, prepared, ids)
    grants = _settle_grants(sharing)
    _connect_recipient(sharing)
    _select_for_recipient(sharing)
    _revoke(sharing, grants[0])
    envelope = await envelope_builder.assemble("recipient", "after-revoke")
    assert len(envelope.documents) == 1
    assert envelope.documents[0].origin == "shared_grant"
    assert envelope.documents[0].revocation_revision == 1
    with sharing.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM connected_documents WHERE user_id='recipient'")
            ).scalar_one()
            == 2
        )


@pytest.mark.asyncio
async def test_pending_revoke_is_unresolved_and_cannot_fall_through(envelope_builder, sharing):
    prepared, ids = await review(sharing)
    await approve(sharing, prepared, ids)
    grants = _settle_grants(sharing)
    _connect_recipient(sharing)
    _select_for_recipient(sharing)
    _revoke(sharing, grants[0], state="unknown")
    with pytest.raises(DriveReadError, match="incomplete_authority"):
        await envelope_builder.assemble("recipient", "pending-revoke")


@pytest.mark.asyncio
@pytest.mark.parametrize("grant_state,expected", [("preexisting", 1), ("queued", 0)])
async def test_only_settled_or_preexisting_grants_qualify(
    envelope_builder, sharing, grant_state, expected
):
    prepared, ids = await review(sharing)
    await approve(sharing, prepared, ids)
    _connect_recipient(sharing)
    _select_for_recipient(sharing, ("one",))
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_permission_operations SET state=:state
                WHERE kind='grant' AND file_lock_hmac=:lock"""),
            {"state": grant_state, "lock": sharing.sharing_cipher.file_lock("one")},
        )
    envelope = await envelope_builder.assemble("recipient", "grant-state")
    assert len(envelope.documents) == expected
    assert all(item.origin == "shared_grant" for item in envelope.documents)


@pytest.mark.asyncio
async def test_grant_requires_recipient_google_account_binding(envelope_builder, sharing):
    prepared, ids = await review(sharing)
    await approve(sharing, prepared, ids)
    _settle_grants(sharing)
    _connect_recipient(sharing)
    _select_for_recipient(sharing, ("one",))
    credentials = ExternalConnectorCredentialsService(db=sharing.db)
    expires = datetime.now(UTC) + timedelta(hours=1)
    other_account = credentials.seal_credential(
        user_id="recipient",
        connector_id="google_drive",
        generation=1,
        version=2,
        expires_at=expires,
        secret={"subject": "different-subject", "accountLabel": "recipient@example.invalid"},
    )
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE user_external_connector_connections
                SET credential_version=2,credential_ciphertext=:ciphertext,credential_iv=:iv,
                    credential_algorithm=:algorithm,credential_expires_at=:expires
                WHERE user_id='recipient' AND connector_id='google_drive'"""),
            {**other_account, "expires": expires},
        )
    with pytest.raises(DriveReadError, match="incomplete_authority"):
        await envelope_builder.assemble("recipient", "wrong-account")


@pytest.mark.asyncio
async def test_erased_private_request_cannot_serve_as_grant_authority(envelope_builder, sharing):
    prepared, ids = await review(sharing)
    await approve(sharing, prepared, ids)
    _settle_grants(sharing)
    _connect_recipient(sharing)
    _select_for_recipient(sharing, ("one",))
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_management_contexts
                SET private_request_erased_at=clock_timestamp() WHERE request_id=:request"""),
            {"request": prepared["requestId"]},
        )
        connection.execute(
            text("DELETE FROM drive_share_events WHERE request_id=:request"),
            {"request": prepared["requestId"]},
        )
        connection.execute(
            text("""DELETE FROM one_action_directive_ledger
                WHERE channel='document_review' AND document_request_id=:request"""),
            {"request": prepared["requestId"]},
        )
        connection.execute(
            text("DELETE FROM drive_share_reviews WHERE request_id=:request"),
            {"request": prepared["requestId"]},
        )
        connection.execute(
            text("DELETE FROM drive_share_requests WHERE request_id=:request"),
            {"request": prepared["requestId"]},
        )
    with pytest.raises(DriveReadError, match="incomplete_authority"):
        await envelope_builder.assemble("recipient", "erased-request")


@pytest.mark.asyncio
async def test_processing_pause_and_document_cap_are_enforced(
    envelope_builder, sharing, monkeypatch
):
    await review(sharing)
    monkeypatch.setattr("hushh_mcp.services.drive_context_envelope.MAX_ENVELOPE_DOCUMENTS", 1)
    with pytest.raises(DriveReadError, match="narrow_selection_required"):
        await envelope_builder.assemble("owner", "too-many")
    monkeypatch.setattr("hushh_mcp.services.drive_context_envelope.MAX_ENVELOPE_DOCUMENTS", 25)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE connected_documents SET processing_enabled=false WHERE user_id='owner'")
        )
    assert (await envelope_builder.assemble("owner", "paused")).documents == ()

"""Blocked erasure rolls back on real, disposable PostgreSQL."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import os
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from time import monotonic
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text

from hushh_mcp.services import account_deletion_lifecycle_service as lifecycle
from hushh_mcp.services import account_deletion_provider_credentials as credentials
from hushh_mcp.services import account_deletion_provider_journal as journal
from hushh_mcp.services import account_deletion_provider_worker as worker
from hushh_mcp.services import account_deletion_release_admission as admission
from hushh_mcp.services import account_service as account
from hushh_mcp.services.account_deletion_provider_cleanup import ProviderCredentialSnapshot
from tests.pkm_conformance import postgres_harness

ROOT = Path(__file__).resolve().parents[1]
pytestmark = [pytest.mark.feature_account_deletion, pytest.mark.trace_loop]


def _release_sql(name: str) -> str:
    return "\n".join(
        line
        for line in (ROOT.parent / "deploy/account-deletion" / name).read_text().splitlines()
        if not line.startswith("\\")
    )


@pytest.fixture(scope="module")
def database_url():
    # These tests create and drop public tables. Never accept a caller's runtime
    # URL: even an opted-in rehearsal must not erase existing recovery records.
    if postgres_harness.find_pg_bin() is None:
        if os.getenv("REQUIRE_ACCOUNT_DELETION_POSTGRES") == "1":
            pytest.fail("Account deletion gate requires disposable PostgreSQL")
        pytest.skip("local PostgreSQL unavailable")
    server = postgres_harness.TempPostgres()
    try:
        with patch.object(postgres_harness, "MIGRATIONS", []):
            server.start()
        yield f"postgresql://hushh@/postgres?host={server.dir}&port={server.port}"
    finally:
        server.stop()


async def test_real_blocked_erasure_rolls_back_and_releases_session_barrier(database_url):
    import asyncpg

    deletion = await asyncpg.connect(database_url)
    holder = await asyncpg.connect(database_url)
    try:
        await deletion.execute("CREATE TABLE actor_profiles (user_id TEXT PRIMARY KEY)")
        await deletion.execute("CREATE TABLE IF NOT EXISTS vault_keys (user_id TEXT PRIMARY KEY)")
        await deletion.execute(
            (ROOT / "db/migrations/201_account_deletion_tombstones.sql").read_text(encoding="utf-8")
        )
        await _assert_blocked_erasure_rolls_back(database_url, deletion, holder)
    finally:
        await holder.close()
        await deletion.close()


async def _assert_blocked_erasure_rolls_back(database_url, deletion_conn, writer_conn) -> None:
    """A stuck DELETE must release the UID barriers without erasing the account."""
    uid = "synthetic_blocked_erasure"
    await deletion_conn.execute("CREATE TABLE one_adk_sessions (user_id TEXT PRIMARY KEY)")
    await deletion_conn.execute("INSERT INTO actor_profiles(user_id) VALUES($1)", uid)
    await deletion_conn.execute("INSERT INTO one_adk_sessions(user_id) VALUES($1)", uid)
    holder = writer_conn.transaction()
    await holder.start()
    engine = create_engine(database_url)
    release = AsyncMock()
    service = account.AccountService()
    erasure = None

    def delete_blocked_row(conn, *, params, **_kwargs):
        service._delete_user_rows_if_table_exists(
            conn, table_name="one_adk_sessions", params=params
        )

    try:
        # A row lock alone does not acquire the account's lifecycle barrier.
        # The erasure can therefore insert its tombstone, then block on DELETE.
        await writer_conn.fetchval(
            "SELECT user_id FROM one_adk_sessions WHERE user_id=$1 FOR UPDATE", uid
        )
        with (
            patch.object(account, "get_db_connection", engine.begin),
            patch.object(lifecycle, "get_db_connection", engine.begin),
            patch.object(account, "guard_answer_erasure"),
            patch.object(account, "list_connection_graph_viewer_ids", return_value=set()),
            patch.object(
                account,
                "snapshot_provider_credentials_in_transaction",
                return_value=ProviderCredentialSnapshot(user_id=uid),
            ),
            patch.object(account, "release_provider_grants_after_erasure", release),
            patch.object(service, "_delete_personal_agent_state"),
            patch.object(service, "_clear_external_connector_data"),
            patch.object(service, "_clear_live_memory_source_journal"),
            patch.object(
                service, "_table_exists", side_effect=lambda _, name: name == "one_adk_sessions"
            ),
            patch.object(service, "_delete_optional_user_tables", side_effect=delete_blocked_row),
        ):
            started = monotonic()
            erasure = asyncio.create_task(
                service._settle_full_account_transaction(uid, requested_target="both"),
            )
            completed, _ = await asyncio.wait({erasure}, timeout=6)
            assert completed, "blocked erasure exceeded its SQL deadline"
            result = await erasure
            assert monotonic() - started < 6
            assert result["success"] is False
            assert result["account_deleted"] is False
            assert "lock timeout" in result["error"]
            assert not await asyncio.to_thread(
                lifecycle.AccountDeletionLifecycleService.is_tombstoned, uid
            )
            release.assert_not_awaited()
        assert (
            await deletion_conn.fetchval(
                "SELECT count(*) FROM actor_profiles WHERE user_id=$1", uid
            )
            == 1
        )
        assert (
            await deletion_conn.fetchval(
                "SELECT count(*) FROM one_adk_sessions WHERE user_id=$1", uid
            )
            == 1
        )
    finally:
        await holder.rollback()
        if erasure is not None:
            await erasure
        engine.dispose()


async def test_provider_cleanup_retains_custody_through_failure_and_migration_replay(
    database_url, monkeypatch
):
    """The real schema cannot erase retry authority before qualified cleanup."""
    import asyncpg

    conn = await asyncpg.connect(database_url)
    try:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS actor_profiles(user_id text PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS one_adk_sessions(user_id text PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS vault_keys(user_id text PRIMARY KEY);
            CREATE TABLE user_push_tokens(id bigserial PRIMARY KEY, user_id text,
                token text, platform text, created_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now(), UNIQUE(user_id,platform));
            CREATE TABLE conversations(id uuid PRIMARY KEY, participant_a_user_id text,
                participant_b_user_id text);
            CREATE TABLE messages(id uuid PRIMARY KEY, conversation_id uuid, sender_user_id text);
            CREATE TABLE circle_chat_recipients(push_due_at timestamptz);
            CREATE TABLE circle_chat_messages(id uuid PRIMARY KEY);
            CREATE TABLE external_connector_oauth_attempts(attempt_id text PRIMARY KEY,
                user_id text REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
                pending_credential_ciphertext text, pending_credential_iv text);
            CREATE TABLE kai_gmail_connections(user_id text PRIMARY KEY
                REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
                refresh_token_ciphertext text,watch_status text);
            CREATE TABLE user_external_connector_connections(
                user_id text REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
                connector_id text,status text,credential_ciphertext text,credential_iv text,
                credential_algorithm text,connection_generation bigint DEFAULT 0,
                credential_version bigint DEFAULT 0,envelope_version integer DEFAULT 2,
                connected_at timestamptz,pending_attempt_id text,
                revocation_outcome text DEFAULT 'not_attempted',PRIMARY KEY(user_id,connector_id));
            CREATE TABLE connected_documents(user_id text REFERENCES actor_profiles(user_id) ON DELETE CASCADE,connector_id text);
            CREATE TABLE drive_picker_sessions(user_id text REFERENCES actor_profiles(user_id) ON DELETE CASCADE,connector_id text,session_id text);
            CREATE TABLE drive_native_picker_attempts(user_id text REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
                connector_id text,selection_session_id text);
        """)
        picker_migration = (ROOT / "db/migrations/236_drive_native_picker_attempts.sql").read_text()
        invalidation = picker_migration[
            picker_migration.index(
                "CREATE OR REPLACE FUNCTION invalidate_selected_drive_documents()"
            ) : picker_migration.index(
                "ALTER TABLE drive_native_picker_attempts ENABLE ROW LEVEL SECURITY"
            )
        ]
        await conn.execute(invalidation)
        migrations = [
            "201_account_deletion_tombstones.sql",
            "144_google_integrations_calendar_foundation.sql",
            "290_chat_push_delivery.sql",
            "370_one_marketing_preferences.sql",
            "418_account_provider_cleanup_staging.sql",
            "423_account_shared_provider_authority.sql",
        ]
        for migration in migrations:
            if migration == "423_account_shared_provider_authority.sql":

                def prepare_without_current_contract():
                    engine = create_engine(database_url)
                    try:
                        with engine.begin() as transaction:
                            return lifecycle.AccountDeletionLifecycleService.prepare_provider_cleanup_in_transaction(
                                transaction,
                                user_id="synthetic_precontract_owner",
                                firebase_uid="synthetic_precontract_identity",
                                table_exists=account.AccountService()._table_exists,
                            )
                    finally:
                        engine.dispose()

                with pytest.raises(Exception, match="account_provider_cleanup_contract_version"):
                    await asyncio.to_thread(prepare_without_current_contract)
                assert await conn.fetchval("SELECT count(*) FROM account_deletion_tombstones") == 0
            await conn.execute((ROOT / "db/migrations" / migration).read_text())

        uid = "synthetic_prepared_cleanup"
        owner_hash = "sha256:" + hashlib.sha256(uid.encode()).hexdigest()
        await conn.execute("INSERT INTO actor_profiles VALUES($1)", uid)
        await conn.execute("INSERT INTO vault_keys VALUES($1)", uid)
        await conn.execute(
            """INSERT INTO user_external_connector_connections(user_id,connector_id,status,
            credential_ciphertext,credential_iv,credential_version,connection_generation,connected_at)
            VALUES($1,'google_drive','revoked','retained-drive-envelope','synthetic-iv',2,1,now()),
             ($1,'never_authorized','revoked',NULL,NULL,0,0,NULL)""",
            uid,
        )
        await conn.execute("INSERT INTO connected_documents VALUES($1,'google_drive')", uid)
        await conn.execute(
            "INSERT INTO drive_picker_sessions VALUES($1,'google_drive','picker')", uid
        )
        await conn.execute(
            "INSERT INTO drive_native_picker_attempts VALUES($1,'google_drive','picker')", uid
        )
        await conn.execute(
            "INSERT INTO kai_gmail_connections VALUES($1,'synthetic-watch-token','active')", uid
        )
        await conn.execute(
            """INSERT INTO google_provider_connections
            (user_id,provider,refresh_token_ciphertext,refresh_token_iv,refresh_token_tag)
            VALUES($1,'google','synthetic-ciphertext','synthetic-iv','synthetic-tag')""",
            uid,
        )
        await conn.execute(
            """INSERT INTO external_connector_oauth_attempts
            VALUES('synthetic-native-attempt',$1,'synthetic-pending-ciphertext','synthetic-iv')""",
            uid,
        )
        await conn.execute(
            """INSERT INTO user_push_tokens(user_id,token,platform)
            VALUES($1,'synthetic-push','web')""",
            uid,
        )
        await conn.execute(
            """INSERT INTO one_marketing_preferences
            (user_id,user_hash,disclosure_version,surface)
            VALUES($1,$2,'one-email-updates-v1','account')""",
            uid,
            owner_hash,
        )
        envelope = await conn.fetchrow(
            "SELECT * FROM google_provider_connections WHERE user_id=$1", uid
        )

        def prepare(owner=uid, support="required"):
            engine = create_engine(database_url)
            try:
                with engine.begin() as transaction:
                    return lifecycle.AccountDeletionLifecycleService.prepare_provider_cleanup_in_transaction(
                        transaction,
                        user_id=owner,
                        firebase_uid="synthetic_firebase_identity",
                        table_exists=account.AccountService()._table_exists,
                        describe_inventory=lambda _conn, _owner, refs: {
                            ref: {"revocationSupport": support} for ref in refs
                        },
                    )
            finally:
                engine.dispose()

        prepared = await asyncio.to_thread(prepare)
        assert await asyncio.to_thread(prepare) == prepared
        assert prepared.credential_count == 4
        inventory = json.loads(
            await conn.fetchval(
                """SELECT provider_cleanup_inventory::text
            FROM account_deletion_tombstones WHERE user_id_hash=$1""",
                owner_hash,
            )
        )
        cleanup_id = await conn.fetchval(
            """SELECT provider_cleanup_id
            FROM account_deletion_tombstones WHERE user_id_hash=$1""",
            owner_hash,
        )
        item_id = next(iter(inventory))
        receipt = json.loads(
            await conn.fetchval(
                """SELECT provider_cleanup_receipt::text
            FROM account_deletion_tombstones WHERE user_id_hash=$1""",
                owner_hash,
            )
        )
        for item in receipt["items"].values():
            item["revocation"] = "revoked"
            if item["watchRequired"]:
                item["watchOutcome"] = "stopped"
        engine = create_engine(database_url)
        try:
            with patch.object(lifecycle, "get_db_connection", engine.begin):
                with pytest.raises(lifecycle.AccountDeletionInProgressError):
                    await asyncio.to_thread(
                        lifecycle.AccountDeletionLifecycleService.is_tombstoned, uid
                    )
        finally:
            engine.dispose()

        for statement in (
            "DELETE FROM actor_profiles WHERE user_id=$1",
            "DELETE FROM vault_keys WHERE user_id=$1",
            "DELETE FROM google_provider_connections WHERE user_id=$1",
            "UPDATE google_provider_connections SET refresh_token_ciphertext=NULL WHERE user_id=$1",
            "UPDATE external_connector_oauth_attempts SET pending_credential_ciphertext=NULL WHERE user_id=$1",
        ):
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await conn.execute(statement, uid)
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await conn.execute(
                """UPDATE account_deletion_tombstones
                SET erasure_phase='erased' WHERE user_id_hash=$1""",
                owner_hash,
            )
        for outcome in (None, "pending", "token_absent", "failed"):
            receipt["items"][item_id]["revocation"] = outcome
            assert not await conn.fetchval(
                "SELECT account_provider_cleanup_qualified($1::jsonb,$2::jsonb,$3,$4)",
                json.dumps(receipt),
                json.dumps(inventory),
                owner_hash,
                cleanup_id,
            )
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await conn.execute(
                """UPDATE account_deletion_tombstones
                SET erasure_phase='local_erasure' WHERE user_id_hash=$1""",
                owner_hash,
            )

        # Use deployment's pinned replay authority, including preserved successors.
        # Pending cleanup must retain credentials and device/marketing state.
        from db.migration_authority import _replay_sql, build_manifest_entries

        for entry in build_manifest_entries(ROOT / "db/migrations", migrations):
            await conn.execute(_replay_sql(entry))
        await conn.execute(invalidation)
        assert (
            await conn.fetchrow("SELECT * FROM google_provider_connections WHERE user_id=$1", uid)
            == envelope
        )
        assert (
            await conn.fetchval(
                """SELECT pending_credential_ciphertext
            FROM external_connector_oauth_attempts WHERE user_id=$1""",
                uid,
            )
            == "synthetic-pending-ciphertext"
        )
        assert (
            await conn.fetchval("SELECT count(*) FROM user_push_tokens WHERE user_id=$1", uid) == 1
        )
        assert (
            await conn.fetchval(
                "SELECT count(*) FROM one_marketing_preferences WHERE user_id=$1", uid
            )
            == 1
        )
        assert not await conn.fetchval(
            "SELECT erased FROM one_marketing_changes WHERE user_hash=$1", owner_hash
        )
        assert await conn.fetchval(
            """SELECT cleanup_next_attempt_at IS NULL
            FROM account_deletion_tombstones WHERE user_id_hash=$1""",
            owner_hash,
        )

        receipt["items"][item_id]["revocation"] = "revoked"
        for invalid in (
            {**receipt, "items": {}},
            {**receipt, "ownerHash": "sha256:" + "e" * 64},
            {**receipt, "cleanupId": "00000000-0000-0000-0000-000000000000"},
            {**receipt, "inventorySha256": "a" * 64},
            {**receipt, "providerError": "unexpected provider content"},
            {
                **receipt,
                "items": {
                    **receipt["items"],
                    item_id: {**receipt["items"][item_id], "revision": "f" * 64},
                },
            },
            {
                **receipt,
                "items": {
                    **receipt["items"],
                    item_id: {
                        **receipt["items"][item_id],
                        "revocation": "covered_by_group",
                        "groupDigest": "d" * 64,
                    },
                },
            },
        ):
            # Keep the outer transaction open: a deferred settlement failure
            # must not masquerade as immediate rejection of a forged receipt.
            async with conn.transaction():
                with pytest.raises(asyncpg.InsufficientPrivilegeError):
                    async with conn.transaction():
                        await conn.execute(
                            """UPDATE account_deletion_tombstones
                    SET provider_cleanup_receipt=$2::jsonb,erasure_phase='local_erasure'
                    WHERE user_id_hash=$1""",
                            owner_hash,
                            json.dumps(invalid),
                        )
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await conn.execute(
                """UPDATE account_deletion_tombstones SET
                cleanup_intent_kind='phone_orphan',expected_phone_digest=$2
                WHERE user_id_hash=$1""",
                owner_hash,
                "hmac-sha256:" + "d" * 64,
            )
        # An otherwise valid admission may not survive a standalone commit.
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await conn.execute(
                """UPDATE account_deletion_tombstones
                SET provider_cleanup_receipt=$2::jsonb,erasure_phase='local_erasure'
                WHERE user_id_hash=$1""",
                owner_hash,
                json.dumps(receipt),
            )

        def call_journal(method, *args, **kwargs):
            engine = create_engine(database_url)
            try:
                with patch.object(journal, "get_db_connection", engine.begin):
                    return method(*args, **kwargs)
            finally:
                engine.dispose()

        (claim,) = await asyncio.to_thread(call_journal, journal.claim_due)
        assert claim.owner_id == uid
        assert claim.firebase_uid == "synthetic_firebase_identity"
        google_ref = await conn.fetchval(
            """SELECT encode(sha256(convert_to(jsonb_build_array(
            'google_provider_connections',$1::text,'google')::text,'UTF8')),'hex')""",
            uid,
        )
        refresh_operation = await asyncio.to_thread(
            call_journal, journal.dispatch_refresh, claim, reference=google_ref
        )
        # Even a dispatched refresh cannot change identity or erase its custody.
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await conn.execute(
                "UPDATE google_provider_connections SET provider_subject='different' WHERE user_id=$1",
                uid,
            )
        # A credential-only UPDATE without its capture receipt rolls back.
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await conn.execute(
                "UPDATE google_provider_connections SET refresh_token_ciphertext='uncaptured' WHERE user_id=$1",
                uid,
            )
        from types import SimpleNamespace

        retained = SimpleNamespace(
            reference=google_ref,
            source="google_provider_connections",
            row=dict(envelope),
        )
        await asyncio.to_thread(
            call_journal,
            journal.capture_refresh,
            refresh_operation,
            grant=retained,
            encrypted_update={"refresh_token_ciphertext": "rotated-retained-ciphertext"},
        )
        captured = await asyncio.to_thread(call_journal, journal.current_receipt, claim)
        assert captured["items"][google_ref]["revision"] == inventory[google_ref]["revision"]
        assert captured["items"][google_ref]["custodyRevision"] != inventory[google_ref]["revision"]
        assert captured["items"][google_ref]["refresh"]["state"] == "captured"
        assert retained.row["refresh_token_ciphertext"] == "rotated-retained-ciphertext"
        drive_ref = await conn.fetchval(
            """SELECT encode(sha256(convert_to(jsonb_build_array(
            'user_external_connector_connections',$1::text,'google_drive')::text,'UTF8')),'hex')""",
            uid,
        )
        drive_refresh = await asyncio.to_thread(
            call_journal, journal.dispatch_refresh, claim, reference=drive_ref
        )
        await asyncio.to_thread(
            call_journal,
            journal.capture_refresh,
            drive_refresh,
            grant=SimpleNamespace(
                reference=drive_ref,
                source="user_external_connector_connections",
                row={"connector_id": "google_drive"},
            ),
            encrypted_update={
                "credential_ciphertext": "rotated-drive-envelope",
                "credential_version": 3,
            },
        )
        # The normal rotation invalidator still runs, but cannot destroy retained
        # selected information or picker state during provider preparation.
        assert (
            await conn.fetchval("SELECT count(*) FROM connected_documents WHERE user_id=$1", uid)
            == 1
        )
        assert (
            await conn.fetchval("SELECT count(*) FROM drive_picker_sessions WHERE user_id=$1", uid)
            == 1
        )
        forged = copy.deepcopy(captured)
        forged["items"][google_ref]["custodyRevision"] = "e" * 64
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await conn.execute(
                "UPDATE account_deletion_tombstones SET provider_cleanup_receipt=$2::jsonb WHERE user_id_hash=$1",
                owner_hash,
                json.dumps(forged),
            )
        with pytest.raises(journal.ProviderCleanupClaimLost):
            await asyncio.to_thread(
                call_journal,
                journal.dispatch,
                replace(claim, claim_token=str(uuid4())),
                reference=item_id,
                phase="revocation",
            )
        with pytest.raises(journal.ProviderCleanupNotReady):
            await asyncio.to_thread(
                call_journal, journal.dispatch, claim, reference=item_id, phase="revocation"
            )
        for ref, item in inventory.items():
            if item["watchRequired"]:
                await asyncio.to_thread(
                    call_journal, journal.dispatch, claim, reference=ref, phase="watchOutcome"
                )
                await asyncio.to_thread(
                    call_journal,
                    journal.record,
                    claim,
                    reference=ref,
                    phase="watchOutcome",
                    outcome="stopped",
                )
        for ref in inventory:
            assert await asyncio.to_thread(
                call_journal, journal.dispatch, claim, reference=ref, phase="revocation"
            )
            await asyncio.to_thread(
                call_journal,
                journal.record,
                claim,
                reference=ref,
                phase="revocation",
                outcome="revoked",
            )
            assert not await asyncio.to_thread(
                call_journal, journal.dispatch, claim, reference=ref, phase="revocation"
            )

        def finish():
            engine = create_engine(database_url)
            try:
                with engine.begin() as transaction:
                    journal.begin_local_erasure(transaction, claim)
                    transaction.execute(
                        text("DELETE FROM vault_keys WHERE user_id=:owner"), {"owner": uid}
                    )
                    transaction.execute(
                        text("DELETE FROM actor_profiles WHERE user_id=:owner"), {"owner": uid}
                    )
                    journal.settle_local_erasure(transaction, claim)
            finally:
                engine.dispose()

        await asyncio.to_thread(finish)
        terminal = await asyncio.to_thread(
            call_journal,
            journal.inspect_for_identity,
            "synthetic_firebase_identity",
            operation_id=claim.cleanup_id,
        )
        assert terminal["state"] == "complete"
        assert terminal["delayed"] is False
        assert terminal["credential_count"] == 4
        with pytest.raises(journal.CleanupOperationNotFound):
            await asyncio.to_thread(
                call_journal,
                journal.inspect_for_identity,
                "another_firebase_identity",
                operation_id=claim.cleanup_id,
            )
        assert (
            await conn.fetchval("SELECT count(*) FROM user_push_tokens WHERE user_id=$1", uid) == 0
        )
        assert (
            await conn.fetchval(
                "SELECT count(*) FROM one_marketing_preferences WHERE user_id=$1", uid
            )
            == 0
        )
        assert await conn.fetchval(
            """SELECT firebase_uid IS NULL AND account_owner_id IS NULL
            AND cleanup_last_outcome='identity_retained' FROM account_deletion_tombstones
            WHERE user_id_hash=$1""",
            owner_hash,
        )
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await conn.execute(
                """UPDATE account_deletion_tombstones
                SET erasure_phase='provider_cleanup' WHERE user_id_hash=$1""",
                owner_hash,
            )

        lost_owner = "synthetic_lost_provider_response"
        await conn.execute("INSERT INTO actor_profiles VALUES($1)", lost_owner)
        await conn.execute(
            """INSERT INTO google_provider_connections
            (user_id,provider,refresh_token_ciphertext) VALUES($1,'google','retained-ciphertext')""",
            lost_owner,
        )
        await asyncio.to_thread(prepare, lost_owner)
        (abandoned,) = await asyncio.to_thread(call_journal, journal.claim_due)
        ref = next(iter(abandoned.inventory))
        await asyncio.to_thread(
            call_journal, journal.dispatch, abandoned, reference=ref, phase="revocation"
        )
        await conn.execute(
            """UPDATE account_deletion_tombstones
            SET cleanup_claimed_at=now()-interval '6 minutes'
            WHERE provider_cleanup_id=$1::uuid""",
            abandoned.cleanup_id,
        )

        async def owner_status():
            return await asyncio.to_thread(
                call_journal,
                journal.inspect_for_identity,
                "synthetic_firebase_identity",
                operation_id=abandoned.cleanup_id,
            )

        # A dead worker's claim is due again but recent: still ordinary progress.
        assert (await owner_status())["delayed"] is False
        # UAT 2026-10-27: due work parked past the stall window must say so.
        await conn.execute(
            """UPDATE account_deletion_tombstones
            SET provider_cleanup_next_attempt_at=now()-interval '11 minutes'
            WHERE provider_cleanup_id=$1::uuid""",
            abandoned.cleanup_id,
        )
        overdue = await owner_status()
        assert overdue["state"] == "cleaning_up" and overdue["delayed"] is True
        (resumed,) = await asyncio.to_thread(call_journal, journal.claim_due)
        assert resumed.receipt["items"][ref]["revocation"] == "uncertain"
        with pytest.raises(journal.ProviderCleanupClaimLost):
            await asyncio.to_thread(
                call_journal,
                journal.record,
                abandoned,
                reference=ref,
                phase="revocation",
                outcome="revoked",
            )
        with pytest.raises(journal.ProviderCleanupNotReady):
            await asyncio.to_thread(
                call_journal, journal.dispatch, resumed, reference=ref, phase="revocation"
            )
        await asyncio.to_thread(call_journal, journal.release, resumed, action_required=False)
        pending_status = await asyncio.to_thread(
            call_journal,
            journal.inspect_for_identity,
            "synthetic_firebase_identity",
            operation_id=resumed.cleanup_id,
        )
        with pytest.raises(journal.ProviderCleanupNotReady, match="reconciliation"):
            await asyncio.to_thread(
                call_journal,
                journal.authorize_continuation,
                "synthetic_firebase_identity",
                operation_id=resumed.cleanup_id,
                inventory_sha256=pending_status["inventory_sha256"],
            )
        assert await conn.fetchval(
            """SELECT cleanup_status='quarantined'
            AND provider_cleanup_next_attempt_at IS NULL FROM account_deletion_tombstones
            WHERE provider_cleanup_id=$1::uuid""",
            resumed.cleanup_id,
        )
        assert (
            await conn.fetchval(
                "SELECT refresh_token_ciphertext FROM google_provider_connections WHERE user_id=$1",
                lost_owner,
            )
            == "retained-ciphertext"
        )
        late_owner = "synthetic_late_refresh_response"
        await conn.execute("INSERT INTO actor_profiles VALUES($1)", late_owner)
        await conn.execute(
            """INSERT INTO google_provider_connections(user_id,provider,refresh_token_ciphertext)
            VALUES($1,'google','original-refresh-envelope')""",
            late_owner,
        )
        await asyncio.to_thread(prepare, late_owner)
        (old_claim,) = await asyncio.to_thread(call_journal, journal.claim_due)
        late_ref = next(iter(old_claim.inventory))
        operation = await asyncio.to_thread(
            call_journal, journal.dispatch_refresh, old_claim, reference=late_ref
        )
        await conn.execute(
            """UPDATE account_deletion_tombstones SET cleanup_claimed_at=now()-interval '6 minutes'
            WHERE provider_cleanup_id=$1::uuid""",
            old_claim.cleanup_id,
        )
        (new_claim,) = await asyncio.to_thread(call_journal, journal.claim_due)
        assert new_claim.receipt["items"][late_ref]["refresh"]["state"] == "uncertain"
        with pytest.raises(journal.ProviderCleanupNotReady):
            await asyncio.to_thread(
                call_journal, journal.dispatch_refresh, new_claim, reference=late_ref
            )
        # Saving an already-returned replacement is permitted; the stale worker
        # gains no authority to stop watches, revoke, or finalize the account.
        await asyncio.to_thread(
            call_journal,
            journal.capture_refresh,
            operation,
            grant=SimpleNamespace(
                reference=late_ref, source="google_provider_connections", row={"provider": "google"}
            ),
            encrypted_update={"refresh_token_ciphertext": "late-rotated-envelope"},
        )
        with pytest.raises(journal.ProviderCleanupClaimLost):
            await asyncio.to_thread(
                call_journal, journal.dispatch, old_claim, reference=late_ref, phase="revocation"
            )
        assert (
            await conn.fetchval(
                "SELECT refresh_token_ciphertext FROM google_provider_connections WHERE user_id=$1",
                late_owner,
            )
            == "late-rotated-envelope"
        )
        backend_owner = "synthetic_attested_empty_backend_cleanup"
        await conn.execute("INSERT INTO actor_profiles VALUES($1)", backend_owner)

        def backend_cleanup(attested: bool):
            engine = create_engine(database_url)
            try:
                with (
                    engine.begin() as transaction,
                    patch(
                        "hushh_mcp.services.hushh_tech_uat_database_attestation.is_attested_hushh_tech_uat_database",
                        return_value=attested,
                    ),
                ):
                    local_claim = lifecycle.AccountDeletionLifecycleService.record_backend_only_erasure_in_transaction(
                        transaction, user_id=backend_owner
                    )
                    assert local_claim is not None
                    transaction.execute(
                        text("DELETE FROM actor_profiles WHERE user_id=:owner"),
                        {"owner": backend_owner},
                    )
                    journal.settle_local_erasure(transaction, local_claim)
            finally:
                engine.dispose()

        with pytest.raises(ValueError, match="connected_database_not_uat"):
            await asyncio.to_thread(backend_cleanup, False)
        assert (
            await conn.fetchval(
                "SELECT count(*) FROM actor_profiles WHERE user_id=$1", backend_owner
            )
            == 1
        )
        # Injected attestation qualifies the local SQL path, not a live UAT DB.
        await asyncio.to_thread(backend_cleanup, True)
        assert (
            await conn.fetchval(
                "SELECT erasure_phase FROM account_deletion_tombstones WHERE user_id_hash=$1",
                "sha256:" + hashlib.sha256(backend_owner.encode()).hexdigest(),
            )
            == "erased"
        )
        unsupported_owner = "synthetic_independently_owned_key"
        await conn.execute("INSERT INTO actor_profiles VALUES($1)", unsupported_owner)
        await conn.execute(
            """INSERT INTO user_external_connector_connections(user_id,connector_id,status,
             credential_ciphertext,credential_iv,credential_version,connection_generation,connected_at)
             VALUES($1,'owner_key','connected','retained-api-key-ciphertext','synthetic-iv',1,1,now())""",
            unsupported_owner,
        )
        await asyncio.to_thread(prepare, unsupported_owner, "unsupported")
        (unsupported_claim,) = await asyncio.to_thread(call_journal, journal.claim_due)
        await asyncio.to_thread(
            call_journal, journal.release, unsupported_claim, action_required=True
        )
        status = await asyncio.to_thread(
            call_journal,
            journal.inspect_for_identity,
            "synthetic_firebase_identity",
            operation_id=unsupported_claim.cleanup_id,
        )
        assert (
            status["state"] == "action_required" and status["local_erasure_confirmation_required"]
        )
        with pytest.raises(journal.CleanupOperationNotFound):
            await asyncio.to_thread(
                call_journal,
                journal.authorize_continuation,
                "another_identity",
                operation_id=unsupported_claim.cleanup_id,
                inventory_sha256=status["inventory_sha256"],
                accept_local_erasure=True,
            )
        with pytest.raises(journal.ProviderCleanupNotReady, match="review changed"):
            await asyncio.to_thread(
                call_journal,
                journal.authorize_continuation,
                "synthetic_firebase_identity",
                operation_id=unsupported_claim.cleanup_id,
                inventory_sha256="e" * 64,
                accept_local_erasure=True,
            )
        await asyncio.to_thread(
            call_journal,
            journal.authorize_continuation,
            "synthetic_firebase_identity",
            operation_id=unsupported_claim.cleanup_id,
            inventory_sha256=status["inventory_sha256"],
            accept_local_erasure=True,
        )
        (approved,) = await asyncio.to_thread(call_journal, journal.claim_due)
        await asyncio.to_thread(
            call_journal,
            journal.settle_unsupported,
            approved,
            reference=next(iter(approved.inventory)),
        )
        assert await asyncio.to_thread(call_journal, journal.is_ready, approved)
        assert (
            await conn.fetchval(
                "SELECT credential_ciphertext FROM user_external_connector_connections WHERE user_id=$1",
                unsupported_owner,
            )
            == "retained-api-key-ciphertext"
        )
        await _assert_shared_producer_authority(conn, database_url, monkeypatch)
        await _assert_account_generation_cycles(conn, database_url, monkeypatch)
    finally:
        await conn.close()


async def _shared_google_owner(conn, monkeypatch):
    from hushh_mcp.services import account_deletion_provider_credentials as credentials
    from hushh_mcp.services.google_connection_service import GoogleConnectionService

    owner, identity = "synthetic_shared_google_owner", "synthetic_shared_google_identity"
    project = "123456789012"
    await conn.execute("INSERT INTO actor_profiles VALUES($1)", owner)
    await conn.execute("INSERT INTO vault_keys VALUES($1)", owner)
    monkeypatch.setenv(
        "GOOGLE_OAUTH_CLIENT_ID", project + "-abcdefghijklmnop.apps.googleusercontent.com"
    )
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", "synthetic-client-secret")
    service = GoogleConnectionService(db=object())
    monkeypatch.setattr(service, "_token_key", lambda: b"k" * 32)
    monkeypatch.setattr(
        "hushh_mcp.services.google_connection_service.get_google_connection_service",
        lambda: service,
    )
    monkeypatch.setattr(
        credentials,
        "_shared_google_projects",
        lambda: frozenset({hashlib.sha256(project.encode()).hexdigest()}),
    )
    sealed = service._encrypt("synthetic-retained-refresh", aad=f"google-connection:{owner}")
    await conn.execute(
        """INSERT INTO google_provider_connections
        (user_id,provider,provider_subject,refresh_token_ciphertext,refresh_token_iv,refresh_token_tag)
        VALUES($1,'google','123456789',$2,$3,$4)""",
        owner,
        sealed["ciphertext"],
        sealed["iv"],
        sealed["tag"],
    )
    return owner, identity


async def _prepare_shared_cleanup(conn, engine, owner, identity):
    with engine.begin() as transaction:
        prepared = (
            lifecycle.AccountDeletionLifecycleService.prepare_provider_cleanup_in_transaction(
                transaction,
                user_id=owner,
                firebase_uid=identity,
                table_exists=account.AccountService()._table_exists,
            )
        )
    await conn.execute(
        """UPDATE account_deletion_tombstones SET
        provider_cleanup_next_attempt_at=now()+interval '1 day'
        WHERE provider_cleanup_id<>$1::uuid AND cleanup_status<>'running'""",
        prepared.cleanup_id,
    )
    return prepared


@asynccontextmanager
async def _owned_release_connection(database_url):
    import asyncpg

    owned = await asyncpg.connect(database_url)
    try:
        yield owned
    finally:
        await owned.close()


async def _assert_shared_producer_authority(conn, database_url, monkeypatch):
    """Real envelope → producer → approval → worker → installed SQL authority."""
    import asyncpg

    owner, identity = await _shared_google_owner(conn, monkeypatch)
    engine = create_engine(database_url)

    try:
        prepared = await _prepare_shared_cleanup(conn, engine, owner, identity)
        with (
            patch.object(journal, "get_db_connection", engine.begin),
            patch.object(admission, "_connect", lambda: _owned_release_connection(database_url)),
        ):
            (claim,) = await asyncio.to_thread(journal.claim_due, limit=1)
            assert claim.cleanup_id == prepared.cleanup_id
            item = next(iter(claim.inventory.values()))
            assert item["authorityScope"] == "retain_shared_google"
            assert item["revocationSupport"] == "required"
            ports = [AsyncMock() for _ in range(3)]
            finalize = AsyncMock(return_value={"success": True, "account_deleted": True})
            with (
                patch.object(credentials, "verify_grant", ports[0]),
                patch.object(credentials, "stop_watch", ports[1]),
                patch.object(credentials, "revoke_grant", ports[2]),
                patch.object(account.AccountService, "finalize_provider_cleanup", finalize),
            ):
                with pytest.raises(journal.ProviderCleanupNotReady):
                    await worker.run_claim(claim)
                finalize.assert_not_awaited()
                await asyncio.to_thread(journal.release, claim, action_required=True)
                status = await asyncio.to_thread(
                    journal.inspect_for_identity, identity, operation_id=prepared.cleanup_id
                )
                with pytest.raises(journal.ProviderCleanupNotReady, match="review changed"):
                    await asyncio.to_thread(
                        journal.authorize_continuation,
                        identity,
                        operation_id=prepared.cleanup_id,
                        inventory_sha256="e" * 64,
                        accept_local_erasure=True,
                    )
                await asyncio.to_thread(
                    journal.authorize_continuation,
                    identity,
                    operation_id=prepared.cleanup_id,
                    inventory_sha256=status["inventory_sha256"],
                    accept_local_erasure=True,
                )
                (approved,) = await asyncio.to_thread(journal.claim_due, limit=1)
                assert await worker.run_claim(approved)
                assert await asyncio.to_thread(journal.is_ready, approved)
                finalize.assert_awaited_once_with(approved)
                for port in ports:
                    port.assert_not_awaited()
            receipt = await asyncio.to_thread(journal.current_receipt, approved)
            ref = next(iter(approved.inventory))
            assert receipt["items"][ref]["revocation"] == "local_erasure_approved"
            assert "refresh" not in receipt["items"][ref]
            before = await conn.fetchval(
                "SELECT refresh_token_ciphertext FROM google_provider_connections WHERE user_id=$1",
                owner,
            )
            with pytest.raises(asyncpg.ObjectNotInPrerequisiteStateError):
                await conn.execute(
                    (
                        ROOT
                        / "db/migrations/rollback/423_account_shared_provider_authority.rollback.sql"
                    ).read_text()
                )
            assert await asyncio.to_thread(journal.current_receipt, approved) == receipt
            assert (
                await conn.fetchval(
                    "SELECT refresh_token_ciphertext FROM google_provider_connections WHERE user_id=$1",
                    owner,
                )
                == before
            )
    finally:
        engine.dispose()


async def _assert_account_generation_cycles(conn, database_url, monkeypatch):
    """Two real erase/enroll cycles never reparent or revive a retired owner."""
    import time

    import asyncpg

    from hushh_mcp.services import account_generation_service as generations

    migration = (ROOT / "db/migrations/419_account_generations.sql").read_text()
    await conn.execute((ROOT / "db/migrations/359_independent_email_otp.sql").read_text())
    await conn.execute(
        "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN"
    )
    await conn.execute(migration)
    await conn.execute(migration)
    workos_migration = (ROOT / "db/migrations/427_workos_generation_memberships.sql").read_text()
    await conn.execute(workos_migration)
    await conn.execute(workos_migration)
    for client_role in ("anon", "authenticated"):
        assert (
            await conn.fetchval(
                "SELECT has_function_privilege($1,'public.enroll_account_generation(text,integer,uuid,uuid,bigint)','EXECUTE')",
                client_role,
            )
            is False
        )
        assert (
            await conn.fetchval(
                "SELECT has_table_privilege($1,'public.account_generations','SELECT')", client_role
            )
            is False
        )
    await conn.execute(
        "CREATE TABLE synthetic_generation_retained_rows(user_id text PRIMARY KEY,payload text)"
    )
    identity = "synthetic_same_firebase_generation"
    owner = identity
    engine = create_engine(database_url)

    def erase(current_owner):
        with engine.begin() as transaction:
            prepared = (
                lifecycle.AccountDeletionLifecycleService.prepare_provider_cleanup_in_transaction(
                    transaction,
                    user_id=current_owner,
                    firebase_uid=identity,
                    table_exists=account.AccountService()._table_exists,
                )
            )
            row = (
                transaction.execute(
                    text("""UPDATE account_deletion_tombstones SET cleanup_status='running',
                cleanup_claim_token=gen_random_uuid(),cleanup_claimed_at=now(),
                cleanup_attempt_count=cleanup_attempt_count+1
                WHERE user_id_hash=:owner_hash RETURNING cleanup_claim_token::text,
                provider_cleanup_inventory,provider_cleanup_receipt"""),
                    {"owner_hash": lifecycle.account_deletion_user_hash(current_owner)},
                )
                .mappings()
                .one()
            )
            claim = journal.ProviderCleanupClaim(
                owner_id=current_owner,
                firebase_uid=identity,
                cleanup_id=prepared.cleanup_id,
                claim_token=row["cleanup_claim_token"],
                inventory=row["provider_cleanup_inventory"],
                receipt=row["provider_cleanup_receipt"],
                requested_target="both",
            )
            journal.begin_local_erasure(transaction, claim)
            transaction.execute(
                text("DELETE FROM actor_profiles WHERE user_id=:owner"), {"owner": current_owner}
            )
            journal.settle_local_erasure(transaction, claim)
            return prepared.cleanup_id

    def enroll(claims, generation, cleanup, enrollment, accepted_digest=None):
        # The client confirms the immutable review it actually saw; the public
        # service rereads cleanup and does not upgrade stale terms.
        digest = accepted_digest or generations.enrollment_review_digest(
            lifecycle.account_deletion_user_hash(identity),
            generation,
            cleanup,
            enrollment,
            claims["auth_time"],
            generations.math.ceil(retired["retired_at"].timestamp()) + 60,
        )
        return generations.AccountGenerationService.confirm_registration(
            claims,
            previous_generation=generation,
            cleanup_operation=cleanup,
            enrollment_operation=enrollment,
            accepted_review_digest=digest,
        )

    import secrets
    from types import SimpleNamespace

    from hushh_mcp.services.email_auth.config import EmailAuthConfig
    from hushh_mcp.services.email_auth.contracts import (
        POLICY_VERSION,
        DomainDecision,
        EmailAuthError,
    )
    from hushh_mcp.services.email_auth.service import EmailAuthService
    from hushh_mcp.services.email_auth.store import PostgresEmailAuthStore

    monkeypatch.setenv("ACCOUNT_GENERATION_ADMISSION_ENABLED", "true")
    monkeypatch.setenv("ENVIRONMENT", "development")
    await conn.execute(
        "INSERT INTO email_auth_policy_state VALUES(TRUE,$1,'fixture')", POLICY_VERSION
    )
    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=4)
    email_store = PostgresEmailAuthStore(pool)
    minted = []

    class MailboxIdentity:
        users = {"person@example.com": identity}
        provisions = 0

        def find(self, email):
            return SimpleNamespace(uid=self.users[email]) if email in self.users else None

        def verify_mailbox(self, uid, email):
            assert self.users.get(email) == uid

        def provision(self, uid, email):
            assert uid.startswith("email_") and email not in self.users
            self.users[email] = uid
            self.provisions += 1

        def issue(self, captured_owner, email):
            uid, captured = generations.AccountGenerationService.custom_session_binding(
                captured_owner, lane="development"
            )
            self.verify_mailbox(uid, email)
            assert captured["hussh_account_owner"] == captured_owner
            minted.append(captured)
            return "synthetic-email-custom-token"

    class DomainEvaluator:
        risk = SimpleNamespace(expires_at=time.time() + 3600, version="fixture")

        async def evaluate(self, domain):
            return DomainDecision(domain, "approved", "fixture", time.time() + 600, "fixture")

        async def certificate_evidence(self, domain):
            return "unavailable"

    email_service = EmailAuthService(
        EmailAuthConfig(
            True,
            secrets.token_bytes(32),
            secrets.token_bytes(32),
            secrets.token_bytes(32),
            "fixture",
            "https://hushh-mail-api-646258530541.us-central1.run.app",
            secrets.token_urlsafe(32),
            "one@hushh.ai",
        ),
        email_store,
        DomainEvaluator(),
        MailboxIdentity(),
    )

    async def email_challenge(email="person@example.com"):
        binding = secrets.token_urlsafe(32)
        answer = await email_service.request(email, binding, secrets.token_urlsafe(24), "fixture")
        row = await email_store.challenge(answer["challenge_id"])
        payload = email_service.cipher.open(
            row["payload"],
            f"otp:{row['challenge_id']}:{row['destination_hash']}:{row['expires_at'].isoformat()}",
        )
        return binding, row, json.loads(payload)["code"]

    held_email = None
    database_override = patch.object(generations, "get_db_connection", engine.begin)
    database_override.start()
    lifecycle_override = patch.object(lifecycle, "get_db_connection", engine.begin)
    lifecycle_override.start()
    from tests.helpers.workos_generation_rehearsal import GenerationMembershipRehearsal

    workos = GenerationMembershipRehearsal(engine, identity)
    try:
        for generation in range(2):
            await conn.execute("INSERT INTO actor_profiles VALUES($1)", owner)
            if generation == 0:
                await asyncio.to_thread(workos.capture, owner)
            # A retained historical record demonstrates the unchanged-UID
            # UPDATE boundary; normal account-owned rows are erased instead.
            await conn.execute("INSERT INTO one_adk_sessions VALUES($1)", owner)
            await conn.execute(
                "INSERT INTO synthetic_generation_retained_rows VALUES($1,'original')", owner
            )

            begin_mutation, settle_mutation = workos.mutation_callbacks(owner)

            dispatched = await asyncio.to_thread(begin_mutation)
            assert dispatched.firebase_uid == identity
            cleanup = await asyncio.to_thread(erase, owner)
            # The provider effect may settle after local erasure, but no new
            # dispatch can acquire authority from the latest account owner.
            with pytest.raises(generations.AccountGenerationRefused):
                await asyncio.to_thread(begin_mutation)
            retired = await conn.fetchrow(
                "SELECT * FROM account_generations WHERE identity_hash=$1 AND generation=$2",
                lifecycle.account_deletion_user_hash(identity),
                generation,
            )
            assert retired["retired_at"] is not None and retired["cleanup_confirmed"] is True
            assert retired["owner_id"] is None and retired["identity_uid"] is None
            await workos.assert_retired(conn)
            with pytest.raises(asyncpg.CheckViolationError, match="generation is retired"):
                await conn.execute(
                    "UPDATE one_adk_sessions SET user_id=user_id WHERE user_id=$1", owner
                )
            with pytest.raises(asyncpg.CheckViolationError, match="generation is retired"):
                await conn.execute(
                    "UPDATE synthetic_generation_retained_rows SET payload='old-job' WHERE user_id=$1",
                    owner,
                )
            with pytest.raises(asyncpg.CheckViolationError):
                await conn.execute("INSERT INTO actor_profiles VALUES($1)", owner)
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await conn.execute(
                    "DELETE FROM account_generations WHERE owner_hash=$1", retired["owner_hash"]
                )
            if held_email:
                binding, stale_row, stale_code = held_email
                before = len(minted)
                with pytest.raises(
                    (
                        EmailAuthError,
                        asyncpg.CheckViolationError,
                        generations.AccountGenerationRefused,
                    )
                ):
                    await email_service.verify(stale_row["challenge_id"], stale_code, binding)
                assert len(minted) == before
                # The product erasure normally removes this row. This fixture
                # deliberately retained it to exercise the late-code guard.
                await conn.execute(
                    "DELETE FROM email_auth_challenges WHERE challenge_id=$1",
                    stale_row["challenge_id"],
                )
                await conn.execute("DELETE FROM email_auth_enrollments WHERE user_id=$1", owner)
            cutoff = await conn.fetchval(
                "SELECT public.account_generation_admission_cutoff($1)", retired["retired_at"]
            )
            assert cutoff >= retired["retired_at"].timestamp() + 60
            # Exercise the actual clock boundary, including issuer lead. This
            # is the bounded security regression, not a model/provider sweep.
            await asyncio.sleep(max(0, cutoff - time.time() + 2.1))
            claims = {
                "uid": identity,
                "auth_time": int(time.time()),
                "firebase": {"sign_in_provider": "google.com"},
            }
            enrollment = str(uuid4())
            with pytest.raises(generations.AccountGenerationRefused):
                await asyncio.to_thread(enroll, claims, generation, str(uuid4()), enrollment)
            with pytest.raises(generations.AccountGenerationRefused):
                await asyncio.to_thread(enroll, claims, generation, cleanup, enrollment)
            # Direct table INSERT is also guarded, not only the enrollment RPC.
            forged_owner = "acct_" + "f" * 32
            with pytest.raises(asyncpg.InsufficientPrivilegeError, match="requires reconciliation"):
                await conn.execute(
                    """INSERT INTO account_generations(identity_hash,generation,owner_hash,owner_id,
                    identity_uid,admitted_after,enrollment_operation,cleanup_operation)
                    VALUES($1,$2,$3,$4,$5,$6,$7::uuid,$8::uuid)""",
                    lifecycle.account_deletion_user_hash(identity),
                    generation + 1,
                    lifecycle.account_deletion_user_hash(forged_owner),
                    forged_owner,
                    identity,
                    cutoff,
                    str(uuid4()),
                    cleanup,
                )
            with pytest.raises(generations.AccountGenerationRefused):
                await asyncio.to_thread(
                    settle_mutation, replace(dispatched, settlement_nonce=str(uuid4())), "succeeded"
                )
            await asyncio.to_thread(settle_mutation, dispatched, "uncertain")
            with pytest.raises(generations.AccountGenerationRefused):
                await asyncio.to_thread(enroll, claims, generation, cleanup, enrollment)
            await asyncio.to_thread(settle_mutation, dispatched, "succeeded")
            with pytest.raises(generations.AccountGenerationRefused):
                await asyncio.to_thread(settle_mutation, dispatched, "succeeded")
            for invalid_operation, invalid_time in (
                (None, claims["auth_time"]),
                (str(uuid4()), int(time.time()) + 300),
                (str(uuid4()), int(time.time()) - 1000),
            ):
                proposed_owner = "acct_" + uuid4().hex
                with pytest.raises(
                    asyncpg.InsufficientPrivilegeError, match="lineage is unconfirmed"
                ):
                    await conn.execute(
                        """INSERT INTO account_generations(identity_hash,generation,owner_hash,owner_id,
                        identity_uid,admitted_after,enrollment_operation,cleanup_operation,
                        enrollment_authenticated_at,enrollment_review_digest)
                        VALUES($1,$2,$3,$4,$5,$6,$7::uuid,$8::uuid,$9,
                        public.account_enrollment_review_digest($1,$2-1,$8::uuid,$7::uuid,$9,$6))""",
                        lifecycle.account_deletion_user_hash(identity),
                        generation + 1,
                        lifecycle.account_deletion_user_hash(proposed_owner),
                        proposed_owner,
                        identity,
                        cutoff,
                        invalid_operation,
                        cleanup,
                        invalid_time,
                    )
            with pytest.raises(generations.AccountGenerationRefused):
                await asyncio.to_thread(enroll, claims, generation, cleanup, enrollment, "0" * 64)
            if generation == 1:
                binding, proof_row, code = await email_challenge()
                assert proof_row["purpose"] == "account_enrollment" and proof_row["user_id"] is None
                proof = await email_service.verify(proof_row["challenge_id"], code, binding)
                assert (
                    proof["status"] == "registration_required"
                    and proof["registration"]["state"] == "ready"
                )
                review = proof["registration"]["review"]
                consumed = await email_store.challenge(proof_row["challenge_id"])
                claims["auth_time"] = int(consumed["consumed_at"].timestamp())
                for field, value in (
                    ("expected_uid", "different-uid"),
                    ("identity_lane", "uat"),
                    ("purpose", "login"),
                ):
                    with pytest.raises(asyncpg.InsufficientPrivilegeError):
                        await conn.execute(
                            f"UPDATE email_auth_challenges SET {field}=$2 WHERE challenge_id=$1",
                            proof_row["challenge_id"],
                            value,
                        )
                for bad_binding, bad_ticket, bad_digest in (
                    ("wrong", proof["enrollment_ticket"], review["digest"]),
                    (binding, "wrong-ticket", review["digest"]),
                    (binding, proof["enrollment_ticket"], "0" * 64),
                ):
                    with pytest.raises(EmailAuthError):
                        await email_store.confirm_registration(
                            proof_row["challenge_id"],
                            email_service._digest("browser", bad_binding),
                            email_service._digest(
                                "enrollment", proof_row["challenge_id"], bad_ticket
                            ),
                            bad_digest,
                            "fixture",
                            "development",
                        )
                assert len(minted) == 0

                async def confirmed_email(
                    proof_row=proof_row, binding=binding, proof=proof, review=review
                ):
                    result = await email_service.complete_registration(
                        proof_row["challenge_id"],
                        binding,
                        proof["enrollment_ticket"],
                        review["digest"],
                        "fixture",
                    )
                    assert result["status"] == "authenticated"
                    active = await pool.fetchrow(
                        "SELECT * FROM account_generations WHERE identity_hash=$1 AND retired_at IS NULL",
                        lifecycle.account_deletion_user_hash(identity),
                    )
                    return generations.AccountPrincipal(
                        identity, active["owner_id"], active["generation"]
                    )

                outcomes = await asyncio.gather(
                    confirmed_email(), confirmed_email(), return_exceptions=True
                )
                assert (await email_store.challenge(proof_row["challenge_id"]))[
                    "enrollment_finalized_at"
                ] is not None
            else:
                outcomes = await asyncio.gather(
                    asyncio.to_thread(enroll, claims, generation, cleanup, enrollment),
                    asyncio.to_thread(enroll, claims, generation, cleanup, str(uuid4())),
                    return_exceptions=True,
                )
            winners = [
                result for result in outcomes if isinstance(result, generations.AccountPrincipal)
            ]
            assert len(winners) == 1
            winner = winners[0]
            assert winner.firebase_uid == identity and winner.owner_id != owner
            assert winner.generation == generation + 1
            winning_enrollment = await conn.fetchval(
                "SELECT enrollment_operation::text FROM account_generations WHERE owner_id=$1",
                winner.owner_id,
            )
            assert (
                await asyncio.to_thread(enroll, claims, generation, cleanup, winning_enrollment)
                == winner
            )
            active = dict(
                await conn.fetchrow(
                    "SELECT * FROM account_generations WHERE owner_id=$1", winner.owner_id
                )
            )
            # A different valid sign-in cannot replace the immutable review
            # receipt while replaying an already-completed operation.
            changed_proof = {**claims, "auth_time": claims["auth_time"] - 1}
            assert changed_proof["auth_time"] > cutoff
            with pytest.raises(generations.AccountGenerationRefused):
                await asyncio.to_thread(
                    enroll, changed_proof, generation, cleanup, winning_enrollment
                )
            with pytest.raises(generations.AccountGenerationRefused):
                await asyncio.to_thread(
                    enroll,
                    changed_proof,
                    generation,
                    cleanup,
                    winning_enrollment,
                    active["enrollment_review_digest"],
                )
            assert active["enrollment_authenticated_at"] == claims["auth_time"]
            assert active["enrollment_review_digest"] == generations.enrollment_review_digest(
                active["identity_hash"],
                generation,
                cleanup,
                winning_enrollment,
                claims["auth_time"],
                active["admitted_after"],
            )
            # A later write cannot hide the result of the already-completed
            # enrollment when its HTTP response was lost.
            current_mutation = await asyncio.to_thread(begin_mutation, winner.owner_id)
            assert (
                await asyncio.to_thread(enroll, claims, generation, cleanup, winning_enrollment)
                == winner
            )
            await asyncio.to_thread(settle_mutation, current_mutation, "succeeded")
            with pytest.raises(
                asyncpg.InsufficientPrivilegeError, match="retirement is unconfirmed"
            ):
                await conn.execute(
                    """UPDATE account_generations SET retired_at=clock_timestamp(),
                  owner_id=NULL,identity_uid=NULL,cleanup_confirmed=true WHERE owner_id=$1""",
                    winner.owner_id,
                )
            assert generations.validate_principal(claims, active, lane="development") == winner
            # Refreshing an old SDK session changes iat, never auth_time.
            with pytest.raises(generations.AccountGenerationRefused):
                generations.validate_principal(
                    {**claims, "auth_time": active["admitted_after"], "iat": int(time.time())},
                    active,
                    lane="development",
                )
            # A newly exchanged old custom token has a new auth_time. It is
            # still refused without this exact captured owner AND environment.
            custom = {
                **claims,
                "firebase": {"sign_in_provider": "custom"},
                "hussh_account_owner": owner,
                "hussh_account_lane": "development",
            }
            with pytest.raises(generations.AccountGenerationRefused):
                generations.validate_principal(custom, active, lane="development")
            with pytest.raises(generations.AccountGenerationRefused):
                await asyncio.to_thread(enroll, custom, generation, cleanup, str(uuid4()))
            assert (
                generations.validate_principal(
                    {**custom, "hussh_account_owner": winner.owner_id}, active, lane="development"
                )
                == winner
            )
            owner = winner.owner_id
            if generation == 0:
                # The next cycle retires this captured login code. The lookup
                # at verification must never select the next application owner.
                held_email = await email_challenge()
                assert (
                    held_email[1]["user_id"] == owner and held_email[1]["expected_uid"] == identity
                )
            else:
                # Simulate response loss after enrollment committed: a new code
                # finds the exact new active owner, without another enrollment.
                await conn.execute(
                    "DELETE FROM email_auth_challenges WHERE challenge_id=$1",
                    proof_row["challenge_id"],
                )
                new_binding, new_row, new_code = await email_challenge()
                result = await email_service.verify(new_row["challenge_id"], new_code, new_binding)
                assert result["status"] == "authenticated"
                assert (
                    minted
                    == [{"hussh_account_owner": owner, "hussh_account_lane": "development"}] * 2
                )
                assert await email_store.enrollment(new_row["destination_hash"]) == owner
        fresh_binding, fresh_row, fresh_code = await email_challenge("new@example.com")
        assert fresh_row["identity_reserved"] is True
        assert (
            fresh_row["account_generation"] == 0
            and fresh_row["user_id"] == fresh_row["expected_uid"]
        )
        fresh_login = await email_service.verify(
            fresh_row["challenge_id"], fresh_code, fresh_binding
        )
        assert fresh_login["status"] == "authenticated" and email_service.identity.provisions == 1
        assert minted[-1]["hussh_account_owner"] == fresh_row["user_id"]
        await conn.execute(migration)
        assert (
            await conn.fetchval(
                "SELECT count(*) FROM account_generations WHERE identity_hash=$1",
                lifecycle.account_deletion_user_hash(identity),
            )
            == 3
        )
    finally:
        database_override.stop()
        lifecycle_override.stop()
        await pool.close()
        engine.dispose()


async def test_exact_owner_identity_batch_reads_do_not_rebind_retired_or_unknown_generations():
    """Exercise the bounded SQL projection; lifecycle guard qualification is above."""
    from hushh_mcp.services import account_generation_service as generations

    server = postgres_harness.TempPostgres()
    engine = None
    try:
        with patch.object(postgres_harness, "MIGRATIONS", []):
            server.start()
        engine = create_engine(f"postgresql://hushh@/postgres?host={server.dir}&port={server.port}")
        owner = "acct_" + "a" * 32
        with engine.begin() as conn:
            conn.execute(
                text(
                    "CREATE TABLE account_generations(owner_hash text PRIMARY KEY, owner_id text, identity_uid text, retired_at timestamptz); CREATE TABLE account_deletion_tombstones(user_id_hash text PRIMARY KEY)"
                )
            )
            conn.execute(
                text("INSERT INTO account_generations VALUES(:hash,:owner,'external-uid',NULL)"),
                {"hash": lifecycle.account_deletion_user_hash(owner), "owner": owner},
            )
            conn.execute(
                text("INSERT INTO account_deletion_tombstones VALUES(:hash)"),
                {"hash": lifecycle.account_deletion_user_hash("external-uid")},
            )
        with patch.object(generations, "get_db_connection", engine.begin):
            assert generations.AccountGenerationService.firebase_identities_for_owners(
                ["external-uid", owner, "acct_" + "b" * 32, "legacy-active"]
            ) == {owner: "external-uid", "legacy-active": "legacy-active"}
            with engine.begin() as conn:
                conn.execute(
                    text("INSERT INTO account_deletion_tombstones VALUES(:hash)"),
                    {"hash": lifecycle.account_deletion_user_hash(owner)},
                )
            assert (
                generations.AccountGenerationService.firebase_identities_for_owners([owner]) == {}
            )
    finally:
        if engine is not None:
            engine.dispose()
        server.stop()


def test_recovery_erasure_reference_indexes_replay_validate_and_roll_back(database_url):
    from sqlalchemy import text

    names = (
        "412_pkm_recovery_erasure_indexes.sql",
        "413_pkm_recovery_erasure_index.sql",
        "414_pkm_recovery_erasure_index.sql",
        "415_validate_pkm_recovery_erasure_indexes.sql",
    )
    engine = create_engine(database_url, isolation_level="AUTOCOMMIT")
    try:
        with engine.connect() as conn:
            for table, column in (
                ("pkm_domain_commits", "archived_revision_id"),
                ("pkm_upgrade_claims", "archived_revision_id"),
                ("pkm_upgrade_steps", "last_archived_revision_id"),
            ):
                conn.execute(text(f"CREATE TABLE {table} ({column} UUID)"))
            for _ in range(2):
                for name in names:
                    conn.execute(text((ROOT / "db/migrations" / name).read_text()))
            for name in reversed(names):
                down = name.replace(".sql", ".rollback.sql")
                conn.execute(text((ROOT / "db/migrations/rollback" / down).read_text()))
            assert (
                conn.execute(
                    text(
                        "SELECT count(*) FROM pg_indexes WHERE indexname IN ('idx_pkm_domain_commits_archived_revision', 'idx_pkm_upgrade_claims_archived_revision', 'idx_pkm_upgrade_steps_archived_revision')"
                    )
                ).scalar()
                == 0
            )
    finally:
        with engine.connect() as conn:
            conn.execute(
                text(
                    "DROP TABLE IF EXISTS pkm_domain_commits, pkm_upgrade_claims, pkm_upgrade_steps CASCADE"
                )
            )
        engine.dispose()


def _seed_erasure_spine(conn):
    from sqlalchemy import text

    conn.execute(
        text(
            "CREATE TABLE actor_profiles (user_id TEXT PRIMARY KEY, personas TEXT[] DEFAULT ARRAY['investor'], last_active_persona TEXT DEFAULT 'investor', investor_marketplace_opt_in BOOLEAN DEFAULT false)"
        )
    )
    conn.execute(text("CREATE TABLE vault_keys (user_id TEXT PRIMARY KEY)"))
    for table in (
        "pkm_events",
        "pkm_scope_registry",
        "pkm_manifest_paths",
        "pkm_manifests",
        "pkm_blobs",
        "pkm_index",
        "consent_audit",
    ):
        conn.execute(text(f"CREATE TABLE {table} (user_id TEXT NOT NULL)"))
    conn.execute(
        text(
            "CREATE TABLE ria_client_invites (target_investor_user_id TEXT, accepted_by_user_id TEXT)"
        )
    )
    conn.execute(
        text(
            "CREATE TABLE pkm_domain_revisions (revision_id UUID PRIMARY KEY, user_id TEXT NOT NULL)"
        )
    )
    conn.execute(
        text(
            "CREATE TABLE pkm_domain_revision_segments (revision_id UUID REFERENCES pkm_domain_revisions ON DELETE CASCADE, segment_id TEXT, ciphertext TEXT, PRIMARY KEY (revision_id, segment_id))"
        )
    )
    conn.execute(
        text(
            "INSERT INTO pkm_domain_revisions SELECT md5(owner || n)::uuid, owner FROM (VALUES ('departing'), ('peer')) owners(owner) CROSS JOIN generate_series(1,300) n"
        )
    )
    conn.execute(
        text(
            "INSERT INTO pkm_domain_revision_segments SELECT revision_id, 'base', repeat('synthetic-ciphertext', 1024) FROM pkm_domain_revisions"
        )
    )
    # More than one batch within the same parent guards cursor safety.
    conn.execute(
        text(
            "INSERT INTO pkm_domain_revision_segments SELECT revision_id, n::TEXT, 'synthetic-ciphertext' FROM pkm_domain_revisions CROSS JOIN generate_series(1,201) n WHERE revision_id=md5(user_id || '1')::uuid"
        )
    )
    # Segmentless parents must not terminate erasure before later populated ones.
    conn.execute(
        text(
            "INSERT INTO pkm_domain_revisions SELECT md5(owner || n)::uuid, owner FROM (VALUES ('departing'), ('peer')) owners(owner) CROSS JOIN generate_series(301,310) n"
        )
    )
    conn.execute(text("INSERT INTO actor_profiles(user_id) VALUES ('departing'), ('peer')"))
    conn.execute(text("INSERT INTO vault_keys VALUES ('departing'), ('peer')"))
    conn.execute(text((ROOT / "db/migrations/201_account_deletion_tombstones.sql").read_text()))
    conn.execute(
        text(
            "CREATE TABLE user_push_tokens(user_id text); CREATE TABLE user_push_installations(user_id text)"
        )
    )
    conn.execute(text((ROOT / "db/migrations/370_one_marketing_preferences.sql").read_text()))
    conn.execute(
        text((ROOT / "db/migrations/418_account_provider_cleanup_staging.sql").read_text())
    )
    conn.execute(
        text((ROOT / "db/migrations/423_account_shared_provider_authority.sql").read_text())
    )


def _guard_erasure_boundaries(conn, failure):
    from sqlalchemy import text

    # Assert the actual statement row bound, independently of host scheduling.
    conn.execute(
        text("""
        CREATE FUNCTION guard_erasure_batch() RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
          IF current_setting('lock_timeout') <> '300ms'
             OR current_setting('statement_timeout') <> '700ms' THEN
            RAISE EXCEPTION 'synthetic SQL deadlines missing';
          END IF;
          IF (SELECT count(*) FROM erased_rows) > 100 THEN
            RAISE EXCEPTION 'synthetic batch overflow: %', TG_TABLE_NAME;
          END IF;
          RETURN NULL;
        END $$
    """)
    )
    for table in ("pkm_domain_revision_segments", "pkm_domain_revisions"):
        conn.execute(
            text(f"""
            CREATE TRIGGER guard_erasure_batch AFTER DELETE ON {table}
            REFERENCING OLD TABLE AS erased_rows FOR EACH STATEMENT
            EXECUTE FUNCTION guard_erasure_batch()
        """)
        )
    if failure == "statement_timeout":
        # Far above the existing 700ms deadline: prove real QueryCanceled and
        # rollback without relying on hundreds of tiny timer wakeups.
        conn.execute(
            text("""
            CREATE FUNCTION slow_erasure() RETURNS TRIGGER LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_sleep(10); RETURN OLD; END $$;
            CREATE TRIGGER slow_erasure BEFORE DELETE ON pkm_domain_revision_segments
            FOR EACH ROW EXECUTE FUNCTION slow_erasure()
        """)
        )
    if failure == "final_failure":
        conn.execute(
            text("""
            CREATE FUNCTION fail_final_erasure() RETURNS TRIGGER LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'synthetic final erasure failure'; END $$;
            CREATE TRIGGER fail_final_erasure BEFORE DELETE ON vault_keys
            FOR EACH ROW EXECUTE FUNCTION fail_final_erasure()
        """)
        )


def _request_full_erasure(engine, trace_id, rollback, *, deadline_seconds=12):
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse
    from fastapi.testclient import TestClient
    from sqlalchemy import text

    import api.routes.account as route
    from api.middleware import require_vault_owner_token
    from api.middlewares.observability import observability_middleware
    from hushh_mcp.services import account_deletion_provider_worker as worker
    from hushh_mcp.services import account_deletion_release_admission as release_guard

    @asynccontextmanager
    async def release_connection():
        import asyncpg

        conn = await asyncpg.connect(engine.url.render_as_string(hide_password=False))
        try:
            yield conn
        finally:
            await conn.close()

    released = AsyncMock(return_value={"status": "released"})
    remove_identity = AsyncMock(return_value="deleted")
    app = FastAPI()
    app.middleware("http")(observability_middleware)
    app.include_router(route.router)

    # A controlled worker delivery carries the initiating trace; claim, journal,
    # erasure, 700ms statements and rollback remain the real implementations.
    @app.post("/synthetic/provider-cleanup-delivery")
    async def deliver_cleanup():
        claims = await asyncio.to_thread(journal.claim_due, limit=1)
        assert len(claims) == 1
        settled = await worker.run_claim(claims[0])
        return JSONResponse({"settled": settled}, status_code=200 if settled else 500)

    # Isolate the external identity port; all erasure services and SQL stay real.
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "departing"}
    with (
        patch.object(account, "get_db_connection", engine.begin),
        patch.object(lifecycle, "get_db_connection", engine.begin),
        patch.object(journal, "get_db_connection", engine.begin),
        patch.object(release_guard, "_connect", release_connection),
        patch.object(
            account,
            "_ACCOUNT_ERASURE_SQL_LIMITS",
            text("SET LOCAL lock_timeout='300ms'; SET LOCAL statement_timeout='700ms'"),
        ),
        patch.object(account, "release_provider_grants_after_erasure", released),
        patch.object(route, "_delete_firebase_auth_user", remove_identity),
        TestClient(app) as client,
    ):
        started = monotonic()
        response = client.request(
            "DELETE",
            "/api/account/delete",
            json={"target": "both"},
            headers={"X-Request-Id": trace_id},
        )
        assert monotonic() - started < deadline_seconds
        assert response.headers["x-request-id"] == trace_id
        assert response.headers["x-trace-id"] == trace_id
        assert response.status_code == 202, response.text
        assert response.json()["account_deleted"] is False
        assert response.json()["cleanup_pending"] is True
        settled = client.post(
            "/synthetic/provider-cleanup-delivery", headers={"X-Request-Id": trace_id}
        )
        assert monotonic() - started < 12
        assert settled.status_code == (500 if rollback else 200), settled.text
        assert settled.json()["settled"] is (not rollback)
        assert settled.headers["x-request-id"] == trace_id
        released.assert_not_awaited()
        remove_identity.assert_not_awaited()
        # Preparation is durable even when the final erasure transaction rolls back.
        if rollback:
            with pytest.raises(lifecycle.AccountDeletionInProgressError):
                lifecycle.AccountDeletionLifecycleService.is_tombstoned("departing")
        else:
            assert lifecycle.AccountDeletionLifecycleService.is_tombstoned("departing")
        with engine.connect() as conn:
            assert conn.execute(
                text("SELECT erasure_phase FROM account_deletion_tombstones")
            ).scalar_one() == ("provider_cleanup" if rollback else "erased")


def _assert_recovery_counts(engine, rollback):
    from sqlalchemy import text

    with engine.connect() as conn:
        counts = dict(
            conn.execute(
                text(
                    "SELECT r.user_id, count(s.segment_id) FROM pkm_domain_revisions r LEFT JOIN pkm_domain_revision_segments s USING (revision_id) GROUP BY r.user_id"
                )
            ).all()
        )
        assert counts == ({"departing": 501, "peer": 501} if rollback else {"peer": 501})
        assert conn.execute(
            text("SELECT count(*) FROM pkm_domain_revisions WHERE user_id='departing'")
        ).scalar() == (310 if rollback else 0)
        assert (
            conn.execute(
                text("SELECT count(*) FROM pkm_domain_revisions WHERE user_id='peer'")
            ).scalar()
            == 310
        )
        assert conn.execute(
            text("SELECT count(*) FROM vault_keys WHERE user_id='departing'")
        ).scalar() == (1 if rollback else 0)


@pytest.mark.parametrize(
    "failure",
    [None, "final_failure", "statement_timeout", "unbounded_segments", "unbounded_revisions"],
)
def test_large_recovery_history_erasure_is_bounded_atomic_and_owner_scoped(database_url, failure):
    """HTTP -> real account SQL; row bounds, timeout and full atomic rollback."""
    from sqlalchemy import event, text
    from sqlalchemy.engine import make_url

    from api.middlewares.observability import get_request_id

    rollback = failure is not None
    database = "erasure_" + (failure or "commit")
    admin = create_engine(database_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f"CREATE DATABASE {database}"))
    engine = create_engine(make_url(database_url).set(database=database))
    trace_id = f"account-deletion-loop-{database}"
    sql_trace: list[tuple[str, str]] = []
    errors = []

    def trace_query(_conn, _cursor, statement, _parameters, _context, _many):
        if "DELETE FROM pkm_domain_revision_segments" in statement:
            sql_trace.append(("segments", get_request_id()))
        elif "DELETE FROM pkm_domain_revisions" in statement:
            sql_trace.append(("revisions", get_request_id()))

    event.listen(engine, "before_cursor_execute", trace_query)
    event.listen(engine, "handle_error", lambda context: errors.append(context.original_exception))
    try:
        queries = account.recovery_erasure_queries()
        if failure in {"unbounded_segments", "unbounded_revisions"}:
            table = (
                "pkm_domain_revision_segments"
                if failure.endswith("segments")
                else "pkm_domain_revisions"
            )
            # Negative controls exercise each real production query independently.
            query = str(queries[table])
            assert query.count("LIMIT 100") == 1
            queries[table] = text(query.replace("LIMIT 100", ""))
        with engine.begin() as conn:
            _seed_erasure_spine(conn)
            _guard_erasure_boundaries(conn, failure)
        with patch.object(account, "recovery_erasure_queries", return_value=queries):
            _request_full_erasure(
                engine,
                trace_id,
                rollback,
                deadline_seconds=6 if failure == "statement_timeout" else 12,
            )
        expected = (
            {"segments"}
            if failure in {"statement_timeout", "unbounded_segments"}
            else {"segments", "revisions"}
        )
        assert {name for name, _ in sql_trace} == expected
        assert all(request_id == trace_id for _, request_id in sql_trace)
        if failure == "statement_timeout":
            assert len(errors) == 1 and errors[0].pgcode == "57014"
        elif failure in {"unbounded_segments", "unbounded_revisions"}:
            assert len(errors) == 1
            assert errors[0].diag.message_primary == "synthetic batch overflow: " + table
        elif failure == "final_failure":
            assert (
                len(errors) == 1
                and errors[0].diag.message_primary == "synthetic final erasure failure"
            )
        else:
            assert not errors
        _assert_recovery_counts(engine, rollback)
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(text(f"DROP DATABASE {database} WITH (FORCE)"))
        admin.dispose()


def test_late_recovery_cursor_bounds_parent_scan_work(database_url):
    """A child cursor must not revisit the already traversed parent prefix."""
    from sqlalchemy import text

    from hushh_mcp.services.account_recovery_erasure import recovery_erasure_queries

    engine = create_engine(database_url)
    try:
        with engine.connect() as conn, conn.begin() as transaction:
            # Disposable temporary tables shadow runtime names only here. ANALYZE
            # executes the production DELETE; the transaction rolls back on exit.
            conn.execute(
                text(
                    "CREATE TEMP TABLE pkm_domain_revisions (revision_id UUID PRIMARY KEY, user_id TEXT NOT NULL) ON COMMIT DROP"
                )
            )
            conn.execute(
                text(
                    "CREATE TEMP TABLE pkm_domain_revision_segments (revision_id UUID REFERENCES pkm_domain_revisions, segment_id TEXT, PRIMARY KEY (revision_id, segment_id)) ON COMMIT DROP"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO pkm_domain_revisions SELECT lpad(to_hex(n),32,'0')::uuid, 'departing' FROM generate_series(1,3000) n"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO pkm_domain_revision_segments SELECT revision_id, 'base' FROM pkm_domain_revisions"
                )
            )
            conn.execute(text("ANALYZE pkm_domain_revisions; ANALYZE pkm_domain_revision_segments"))
            query = recovery_erasure_queries()["pkm_domain_revision_segments"]
            plan = conn.execute(
                text("EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) " + str(query)),
                {
                    "user_id": "departing",
                    "after_revision_id": f"{2800:032x}",
                    "after_segment_id": "base",
                },
            ).scalar()[0]["Plan"]
            assert plan["Actual Rows"] == 100
            assert _parent_scan_work(plan) < 500, "late batches rescanned the erased parent prefix"
            assert (
                conn.execute(text("SELECT count(*) FROM pkm_domain_revision_segments")).scalar()
                == 2900
            )
            transaction.rollback()
    finally:
        engine.dispose()


def _parent_scan_work(plan):
    own_work = 0
    if plan.get("Relation Name") == "pkm_domain_revisions":
        own_work = (plan["Actual Rows"] + plan.get("Rows Removed by Filter", 0)) * plan[
            "Actual Loops"
        ]
    return own_work + sum(_parent_scan_work(child) for child in plan.get("Plans", []))


@asynccontextmanager
async def _release_database(database_url, monkeypatch):
    """Isolate concurrency fixtures inside the disposable cluster only."""
    import asyncpg

    from hushh_mcp.services import account_deletion_release_admission as admission

    name = "release_" + uuid4().hex
    admin = await asyncpg.connect(database_url)
    await admin.execute(f'CREATE DATABASE "{name}"')
    url = database_url.replace("/postgres?", f"/{name}?")
    conn = await asyncpg.connect(url)
    await conn.execute("""
        CREATE TABLE actor_profiles(user_id text PRIMARY KEY);
        CREATE TABLE vault_keys(user_id text PRIMARY KEY);
        CREATE TABLE account_deletion_tombstones(
            erasure_phase text, cleanup_status text, provider_cleanup_receipt jsonb,
            cleanup_intent_kind text DEFAULT 'full_account', provider_cleanup_inventory jsonb DEFAULT '{}');
    """)

    @asynccontextmanager
    async def connect():
        lease = await asyncpg.connect(url)
        try:
            yield lease
        finally:
            await lease.close(timeout=3)

    monkeypatch.setattr(admission, "_connect", connect)
    try:
        yield conn, url
    finally:
        await conn.close()
        await admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
        await admin.close()


async def test_release_fence_refuses_worker_and_sql_before_cleanup(database_url, monkeypatch):
    from hushh_mcp.services import account_deletion_provider_worker as worker
    from hushh_mcp.services import account_deletion_release_admission as admission

    async with _release_database(database_url, monkeypatch) as (conn, url):
        # The real installer also proves compatibility before journal migration.
        await conn.execute(
            "ALTER TABLE account_deletion_tombstones DROP COLUMN provider_cleanup_receipt"
        )
        await conn.execute(_release_sql("install_release_fence.sql"))
        load = AsyncMock()
        monkeypatch.setattr(worker.journal, "load_grants", load)
        with pytest.raises(admission.AccountDeletionReleasePaused) as paused:
            await worker.run_claim(object())
        assert paused.value.reason == "release_fence_installed"
        load.assert_not_awaited()

        def attempt_sql():
            engine = create_engine(url)
            try:
                with engine.begin() as tx:
                    admission.admit_erasure_transaction(tx)
                    pytest.fail("release admission reached erasure")
            finally:
                engine.dispose()

        with pytest.raises(Exception, match="temporarily unavailable"):
            await asyncio.to_thread(attempt_sql)
        await conn.execute(_release_sql("remove_release_fence.sql"))
        async with admission.release_admission() as lease:
            await lease.check()


async def test_release_installer_serializes_workers_and_preserves_lost_session_uncertainty(
    database_url, monkeypatch
):
    import asyncpg

    from hushh_mcp.services import account_deletion_release_admission as admission

    async with _release_database(database_url, monkeypatch) as (conn, url):
        installer = await asyncpg.connect(url)
        task = None
        try:
            async with admission.release_admission() as lease:
                task = asyncio.create_task(
                    installer.execute(_release_sql("install_release_fence.sql"))
                )
                for _ in range(100):
                    if await conn.fetchval(
                        "SELECT cardinality(pg_blocking_pids($1))>0", installer.get_server_pid()
                    ):
                        break
                    await asyncio.sleep(0.01)
                assert not task.done(), "installer crossed a worker's active effect boundary"
                assert await conn.fetchval(
                    "SELECT cardinality(pg_blocking_pids($1))>0", installer.get_server_pid()
                )
                await lease.check()
            await asyncio.wait_for(task, 3)
            with pytest.raises(admission.AccountDeletionReleasePaused):
                async with admission.release_admission():
                    pytest.fail("worker crossed an installed fence")
            await conn.execute(_release_sql("remove_release_fence.sql"))

            async with admission.release_admission() as lease:
                await conn.execute("""INSERT INTO account_deletion_tombstones(erasure_phase,cleanup_status,provider_cleanup_receipt) VALUES(
                    'provider_cleanup','retry', '{"items":{"grant":{"revocation":"dispatched"}}}')""")
                lease._connection.terminate()
                with pytest.raises(admission.AccountDeletionReleasePaused):
                    await lease.check()
                # Session disappearance cannot certify an in-flight HTTP effect.
                with pytest.raises(
                    asyncpg.ObjectNotInPrerequisiteStateError, match="require settlement"
                ):
                    await installer.execute(_release_sql("install_release_fence.sql"))
                await installer.execute("ROLLBACK")
            assert not await conn.fetchval(admission._FENCED)
            await conn.execute("DELETE FROM account_deletion_tombstones")
            await conn.execute("CREATE TABLE shared_files_storage(state text)")
            await conn.execute("INSERT INTO shared_files_storage VALUES('erasing')")
            with pytest.raises(
                asyncpg.ObjectNotInPrerequisiteStateError, match="Files effects require settlement"
            ):
                await installer.execute(_release_sql("install_release_fence.sql"))
            await installer.execute("ROLLBACK")
            assert not await conn.fetchval(admission._FENCED)
        finally:
            if task is not None and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            await installer.close()


async def test_shared_provider_sql_requires_exact_local_approval_and_no_dispatched_effects(
    database_url, monkeypatch
):
    async with _release_database(database_url, monkeypatch) as (conn, _url):
        import asyncpg

        await conn.execute("""INSERT INTO account_deletion_tombstones(erasure_phase,cleanup_status,provider_cleanup_receipt)
            VALUES('provider_cleanup','legacy','{"version":1,"items":{}}')""")
        await conn.execute(
            (ROOT / "db/migrations/423_account_shared_provider_authority.sql").read_text()
        )
        ref, owner_hash, cleanup_id = "a" * 64, "sha256:" + "b" * 64, uuid4()
        inventory = {
            ref: {
                "revision": "c" * 64,
                "groupDigest": "d" * 64,
                "revocationSupport": "required",
                "watchRequired": True,
                "authorityScope": "retain_shared_google",
            }
        }
        digest = await conn.fetchval(
            "SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex')", json.dumps(inventory)
        )
        receipt = {
            "version": 2,
            "cleanupId": str(cleanup_id),
            "ownerHash": owner_hash,
            "inventorySha256": digest,
            "localErasureAccepted": True,
            "items": {
                ref: {
                    **inventory[ref],
                    "revocation": "local_erasure_approved",
                    "watchOutcome": "retained_shared",
                }
            },
        }

        async def qualified(value):
            return await conn.fetchval(
                "SELECT account_provider_cleanup_qualified($1::jsonb,$2::jsonb,$3,$4)",
                json.dumps(value),
                json.dumps(inventory),
                owner_hash,
                cleanup_id,
            )

        assert await qualified(receipt)
        with pytest.raises(asyncpg.InsufficientPrivilegeError, match="current cleanup producer"):
            await conn.execute("""INSERT INTO account_deletion_tombstones(erasure_phase,cleanup_status,provider_cleanup_receipt)
                VALUES('provider_cleanup','pending','{"version":1,"items":{}}')""")
        with pytest.raises(asyncpg.InsufficientPrivilegeError, match="legacy provider cleanup"):
            await conn.execute("""UPDATE account_deletion_tombstones SET
                provider_cleanup_receipt=provider_cleanup_receipt||'{"dispatch":"attempted"}'::jsonb
                WHERE cleanup_status='legacy'""")
        pending = {
            **receipt,
            "localErasureAccepted": False,
            "items": {ref: {**inventory[ref], "revocation": "pending", "watchOutcome": "pending"}},
        }
        await conn.execute(
            """INSERT INTO account_deletion_tombstones(erasure_phase,cleanup_status,
            provider_cleanup_receipt,provider_cleanup_inventory) VALUES('provider_cleanup','pending',$1::jsonb,$2::jsonb)""",
            json.dumps(pending),
            json.dumps(inventory),
        )
        for phase, value in [
            ("refresh", {"state": "dispatched"}),
            ("watchOutcome", "dispatched"),
            ("revocation", "dispatched"),
        ]:
            dispatched = {**pending, "items": {ref: {**pending["items"][ref], phase: value}}}
            with pytest.raises(asyncpg.InsufficientPrivilegeError, match="cannot be dispatched"):
                await conn.execute(
                    "UPDATE account_deletion_tombstones SET provider_cleanup_receipt=$1::jsonb WHERE cleanup_status='pending'",
                    json.dumps(dispatched),
                )
        for change in [
            {"localErasureAccepted": False},
            {"inventorySha256": "e" * 64},
            {"items": {ref: {**receipt["items"][ref], "revocation": "revoked"}}},
            {"items": {ref: {**receipt["items"][ref], "watchOutcome": "dispatched"}}},
            {"items": {ref: {**receipt["items"][ref], "refresh": {"state": "uncertain"}}}},
            {"items": {ref: {**receipt["items"][ref], "authorityScope": "exclusive"}}},
        ]:
            assert not await qualified({**receipt, **change})

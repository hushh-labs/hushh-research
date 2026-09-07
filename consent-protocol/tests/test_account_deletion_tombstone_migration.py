from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from uuid import UUID

import pytest

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent

IDENTITY_COLUMN_RE = re.compile(
    r"^(?:user_id|firebase_uid|user_[a-z0-9]+_id)$|(?:_user_id|_firebase_uid)$"
)
IDENTITY_DDL_RE = re.compile(
    r'(?:^|[(,])\s*"?'
    r"(?:user_id|firebase_uid|user_[a-z0-9]+_id|[a-z0-9_]+_user_id|"
    r"[a-z0-9_]+_firebase_uid)"
    r'"?\s+(?:TEXT|UUID|VARCHAR|CHARACTER\s+VARYING)\b',
    re.IGNORECASE | re.MULTILINE,
)
IDENTITY_RENAME_RE = re.compile(
    r"\bRENAME\s+COLUMN\s+[a-z0-9_\"]+\s+TO\s+\"?"
    r"(?:user_id|firebase_uid|user_[a-z0-9]+_id|[a-z0-9_]+_user_id|"
    r"[a-z0-9_]+_firebase_uid)\"?\b",
    re.IGNORECASE,
)


def _identity_inventory(contract: dict) -> dict[str, tuple[str, ...]]:
    return {
        table_name: tuple(
            column_name for column_name in column_names if IDENTITY_COLUMN_RE.search(column_name)
        )
        for table_name, column_names in contract["required_tables"].items()
        if table_name != "account_deletion_tombstones"
        and any(IDENTITY_COLUMN_RE.search(column_name) for column_name in column_names)
    }


def test_account_deletion_tombstone_migration_contract():
    migration = (ROOT / "db/migrations/201_account_deletion_tombstones.sql").read_text()
    rollback = (
        ROOT / "db/migrations/rollback/201_account_deletion_tombstones.rollback.sql"
    ).read_text()
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text())

    assert "CREATE TABLE IF NOT EXISTS account_deletion_tombstones" in migration
    assert "CREATE TABLE IF NOT EXISTS account_identity_presence" in migration
    assert "reject_deleted_account_identity_write" in migration
    assert "install_account_deletion_write_guards" in migration
    assert "record_account_deletion_tombstone" in migration
    assert "BEFORE DELETE ON actor_profiles" in migration
    assert "BEFORE DELETE ON vault_keys" in migration
    assert "cleanup_claim_token UUID" in migration
    assert "cleanup_intent_kind TEXT" in migration
    assert "expected_phone_digest TEXT" in migration
    assert "cleanup_last_classification TEXT" in migration
    assert "pg_advisory_xact_lock" in migration
    assert "pg_advisory_xact_lock_shared" in migration
    assert "CREATE EXTENSION IF NOT EXISTS pgcrypto" in migration
    assert "idx_account_deletion_cleanup_due" in migration
    tombstone_ddl = migration.split("CREATE TABLE", 1)[1].split(");", 1)[0].lower()
    assert "email" not in tombstone_ddl
    assert "phone_number" not in tombstone_ddl
    assert "^hmac-sha256:[0-9a-f]{64}$" in tombstone_ddl
    guard_function = migration.split(
        "CREATE OR REPLACE FUNCTION reject_deleted_account_identity_write()", 1
    )[1].split("$$;", 1)[0]
    assert "FOREACH identity_column_name IN ARRAY TG_ARGV" in guard_function
    assert "SELECT ($1).%I::TEXT" in guard_function
    assert "to_jsonb(NEW)" not in guard_function
    assert "candidate_user_id IS NOT DISTINCT FROM previous_user_id" in guard_function
    assert "IF previous_user_id IS NOT NULL THEN" in guard_function
    assert "account_identity_reference_immutable_guard" in guard_function
    assert "candidate_user_id IS NULL AND EXISTS" in guard_function
    assert "digest(previous_user_id, 'sha256')" in guard_function
    assert guard_function.index("account_identity_reference_immutable_guard") < (
        guard_function.index("pg_advisory_xact_lock_shared")
    )
    assert "current_setting('transaction_isolation')" in guard_function
    shared_171 = "hashtextextended(candidate_user_id, 171)"
    shared_198 = "hashtextextended(candidate_user_id, 198)"
    assert guard_function.index(shared_171) < guard_function.index(shared_198)
    assert guard_function.index("pg_advisory_xact_lock_shared") < guard_function.rindex(
        "FROM public.account_deletion_tombstones"
    )
    assert "INSERT INTO public.account_identity_presence" in guard_function
    assert guard_function.rindex("FROM public.account_deletion_tombstones") < (
        guard_function.index("INSERT INTO public.account_identity_presence")
    )
    assert "WHERE NOT EXISTS" in guard_function
    root_trigger = migration.split(
        "CREATE OR REPLACE FUNCTION public.record_account_deletion_tombstone()", 1
    )[1].split("$$;", 1)[0]
    assert "SET search_path = pg_catalog, public" in root_trigger
    assert "INSERT INTO public.account_deletion_tombstones" in root_trigger
    assert root_trigger.index("hashtextextended(OLD.user_id, 171)") < root_trigger.index(
        "hashtextextended(OLD.user_id, 198)"
    )

    installer = migration.split(
        "CREATE OR REPLACE FUNCTION install_account_deletion_write_guards()", 1
    )[1]
    assert "FROM pg_class AS table_class" in installer
    assert "table_class.relkind IN ('r', 'p')" in installer
    assert "NOT table_class.relispartition" in installer
    assert "table_class.relname <> 'account_deletion_tombstones'" in installer
    assert "table_column.attgenerated = ''" in installer
    assert "^user_[a-z0-9]+_id$" in installer
    assert "_firebase_uid$" in installer
    assert migration.count("table_class.relname = 'consent_audit_receipts'") == 2
    assert migration.count("table_column.attname = 'subject_id'") == 2
    assert "trg_reject_deleted_account_insert" in installer
    assert "trg_reject_deleted_account_reference_update" in installer
    assert "BEFORE UPDATE OF %s" in installer
    assert "obj_description(guard_trigger.oid, 'pg_trigger')" in installer
    assert "hushh.account-deletion-guard/v3/insert-presence:" in installer
    assert "hushh.account-deletion-guard/v3/update-bind-immutable:" in installer
    assert "existing_trigger_type IS DISTINCT FROM 7" in installer
    assert "existing_trigger_type IS DISTINCT FROM 19" in installer
    assert "existing_trigger_attributes IS DISTINCT FROM expected_update_attributes" in installer
    assert "IF guard_refreshed THEN" in installer
    assert "INSERT INTO public.account_identity_presence" in installer
    assert "ON CONFLICT (user_id_hash) DO NOTHING" in installer
    assert "REVOKE EXECUTE ON FUNCTION install_account_deletion_write_guards()" in migration
    assert (
        "CREATE EVENT TRIGGER trg_refresh_account_deletion_guards_after_identity_ddl" in migration
    )
    assert "ON ddl_command_end" in migration
    assert "'CREATE TABLE AS'" in migration
    assert "'ALTER TABLE'" in migration
    assert "public.refresh_account_deletion_guards_after_identity_ddl()" in migration

    assert "Refusing to drop non-empty account_deletion_tombstones" in rollback
    assert "LOCK TABLE public.actor_profiles IN ACCESS EXCLUSIVE MODE" in rollback
    assert "LOCK TABLE public.vault_keys IN ACCESS EXCLUSIVE MODE" in rollback
    assert "LOCK TABLE public.account_deletion_tombstones IN ACCESS EXCLUSIVE MODE" in rollback
    assert "LOCK TABLE public.account_identity_presence IN ACCESS EXCLUSIVE MODE" in rollback
    assert "DROP TABLE IF EXISTS public.account_identity_presence" in rollback
    assert "DROP TRIGGER IF EXISTS trg_record_account_deletion_tombstone" in rollback
    assert "ON public.vault_keys" in rollback
    assert "trg_reject_deleted_account_insert" in rollback
    assert "trg_reject_deleted_account_reference_update" in rollback
    assert "DROP FUNCTION IF EXISTS public.install_account_deletion_write_guards()" in rollback
    assert (
        "DROP EVENT TRIGGER IF EXISTS trg_refresh_account_deletion_guards_after_identity_ddl"
    ) in rollback
    assert (
        "DROP FUNCTION IF EXISTS public.refresh_account_deletion_guards_after_identity_ddl()"
    ) in rollback
    assert "201_account_deletion_tombstones.sql" in manifest["ordered_migrations"]
    assert "201_account_deletion_tombstones.sql" in manifest["groups"]["iam"]


def test_schema_and_data_plane_contracts_declare_tombstone():
    for name in (
        "prod_core_schema.json",
        "uat_integrated_schema.json",
        "dev_minimum_schema.json",
    ):
        contract = json.loads((ROOT / "db/contracts" / name).read_text())
        assert contract["expected_migration_version"] >= 201
        assert "account_deletion_tombstones" in contract["required_tables"]
        assert contract["required_tables"]["account_identity_presence"] == [
            "user_id_hash",
            "first_observed_at",
        ]
        assert "install_account_deletion_write_guards" in contract["required_functions"]
        assert "reject_deleted_account_identity_write" in contract["required_functions"]
        assert "record_account_deletion_tombstone" in contract["required_functions"]
        assert (
            "refresh_account_deletion_guards_after_identity_ddl" in contract["required_functions"]
        )
        assert "cleanup_claim_token" in contract["required_tables"]["account_deletion_tombstones"]
        assert "cleanup_intent_kind" in contract["required_tables"]["account_deletion_tombstones"]
        assert "expected_phone_digest" in contract["required_tables"]["account_deletion_tombstones"]
        assert (
            "cleanup_last_classification"
            in contract["required_tables"]["account_deletion_tombstones"]
        )

    data_plane = json.loads(
        (REPO_ROOT / "docs/reference/architecture/runtime-db-data-plane-contract.json").read_text()
    )
    family = next(
        item for item in data_plane["table_families"] if item["id"] == "account_deletion_lifecycle"
    )
    assert family["owner"] == "iam-consent-governance"
    assert family["exact_tables"] == [
        "account_deletion_tombstones",
        "account_identity_presence",
    ]
    assert "raw Firebase UID" in family["retention_policy"]
    assert "only while external identity cleanup is pending" in family["retention_policy"]
    assert "Never persist the raw phone number" in family["retention_policy"]
    assert "domain-separated HMAC-SHA256 proof" in family["retention_policy"]
    assert "monotonic SHA-256 presence marker" in family["retention_policy"]
    assert "one indexed presence lookup" in family["deletion_behavior"]
    assert "READ COMMITTED writers" in family["deletion_behavior"]

    governance = (REPO_ROOT / "docs/reference/architecture/data-model-governance.md").read_text()
    assert "install_account_deletion_write_guards()" in governance
    normalized_governance = " ".join(governance.split())
    assert "a non-NULL identity reference cannot be re-parented" in normalized_governance
    assert "Identity-to-`NULL` is allowed only" in normalized_governance
    lifecycle_service = (
        ROOT / "hushh_mcp/services/account_deletion_lifecycle_service.py"
    ).read_text(encoding="utf-8")
    assert "table_class.relname = 'consent_audit_receipts'" in lifecycle_service
    assert "table_column.attname = 'subject_id'" in lifecycle_service


def test_live_schema_contract_identity_shapes_are_comprehensively_guardable():
    inventories: dict[str, dict[str, tuple[str, ...]]] = {}
    minimum_expected_shapes = {
        "dev_minimum_schema.json": (68, 79),
        "prod_core_schema.json": (89, 106),
        "uat_integrated_schema.json": (91, 108),
    }

    for name, (minimum_table_count, minimum_column_count) in minimum_expected_shapes.items():
        contract = json.loads((ROOT / "db/contracts" / name).read_text())
        inventory = _identity_inventory(contract)
        inventories[name] = inventory
        assert len(inventory) >= minimum_table_count
        assert sum(len(columns) for columns in inventory.values()) >= minimum_column_count

    contract_union = {
        (table_name, column_name)
        for inventory in inventories.values()
        for table_name, column_names in inventory.items()
        for column_name in column_names
    }
    assert len({table_name for table_name, _ in contract_union}) >= 92
    assert len(contract_union) >= 109

    uat_inventory = inventories["uat_integrated_schema.json"]
    representative_identity_roles = {
        "actor_profiles": {"user_id"},
        "connections": {"user_a_id", "user_b_id"},
        "relationship_share_grants": {"provider_user_id", "receiver_user_id"},
        "one_location_envelopes": {"owner_user_id", "recipient_user_id"},
        "developer_apps": {"owner_firebase_uid"},
        "developer_oauth_tokens": {"subject_firebase_uid"},
        "hushh_tech_account_links": {"firebase_uid"},
    }
    for table_name, expected_columns in representative_identity_roles.items():
        assert expected_columns.issubset(set(uat_inventory[table_name]))

    assert all(column_name != "legacy_user_uuid" for _, column_name in contract_union)


def test_identity_set_null_fk_inventory_is_explicitly_reviewed():
    identity_set_null_re = re.compile(
        r"^\s*((?:user_id|firebase_uid)|"
        r"(?:[a-z][a-z0-9_]*(?:_user_id|_firebase_uid)))\s+"
        r"(?:TEXT|UUID)[^,;]*?ON\s+DELETE\s+SET\s+NULL",
        re.IGNORECASE | re.MULTILINE,
    )
    observed = {
        (migration_path.name, match.group(1).lower())
        for migration_path in (ROOT / "db/migrations").glob("[0-9][0-9][0-9]_*.sql")
        for match in identity_set_null_re.finditer(migration_path.read_text())
    }
    assert observed == {
        ("022_ria_invites.sql", "target_investor_user_id"),
        ("022_ria_invites.sql", "accepted_by_user_id"),
        ("038_kai_alpaca_funding_orchestration.sql", "user_id"),
        ("049_one_email_kyc_workflows.sql", "user_id"),
        ("165_one_referral_program.sql", "bound_user_id"),
    }

    account_service = (ROOT / "hushh_mcp/services/account_service.py").read_text(encoding="utf-8")
    for cleanup_table in (
        "ria_client_invites",
        "kai_funding_reconciliation_runs",
        "one_kyc_workflows",
        "one_referral_attributions",
    ):
        assert f"DELETE FROM {cleanup_table}" in account_service

    governance = (REPO_ROOT / "docs/reference/architecture/data-model-governance.md").read_text()
    assert "The reviewed identity `ON DELETE SET NULL` inventory" in governance
    assert "deletion-safe transfer protocol" in governance


def test_future_identity_ddl_reinvokes_catalog_guard_installer():
    migration_directory = ROOT / "db/migrations"
    for migration_path in migration_directory.glob("[0-9][0-9][0-9]_*.sql"):
        version = int(migration_path.name.split("_", 1)[0])
        if version <= 201:
            continue

        migration = migration_path.read_text()
        # Ignore PL/pgSQL bodies so a local variable named user_id is not
        # mistaken for persisted table DDL. Migration DDL in this repository is
        # outside untagged dollar-quoted bodies.
        ddl_only = re.sub(r"\$\$.*?\$\$", "", migration, flags=re.DOTALL)
        introduces_identity_shape = bool(
            IDENTITY_DDL_RE.search(ddl_only) or IDENTITY_RENAME_RE.search(ddl_only)
        )
        if introduces_identity_shape:
            assert "install_account_deletion_write_guards()" in migration, (
                f"{migration_path.name} adds an account identity column but does not "
                "refresh migration 201 deletion guards"
            )


def test_external_cleanup_scheduler_is_a_durable_release_contract():
    scheduler = (REPO_ROOT / "deploy/account-deletion/setup_cleanup_scheduler.sh").read_text(
        encoding="utf-8"
    )
    cloudbuild = (REPO_ROOT / "deploy/backend.cloudbuild.yaml").read_text(encoding="utf-8")
    runbook = (REPO_ROOT / "docs/reference/operations/account-deletion-rollout.md").read_text(
        encoding="utf-8"
    )

    assert "--oidc-service-account-email" in scheduler
    assert "--oidc-token-audience" in scheduler
    assert "/api/account/deletion-cleanup/drain?limit=${BATCH_LIMIT}" in scheduler
    assert "--max-retry-attempts=5" in scheduler
    assert "--attempt-deadline=300s" in scheduler
    assert "httpTarget.oidcToken.serviceAccountEmail" in scheduler
    assert "auth=oidc" in scheduler
    assert "X-Hushh-Maintenance-Token" not in scheduler
    assert "ACCOUNT_DELETION_CLEANUP_AUDIENCE" in cloudbuild
    assert "ACCOUNT_DELETION_CLEANUP_SERVICE_ACCOUNT_EMAIL" in cloudbuild
    assert "Cloud Run may freeze" in " ".join(runbook.split())
    assert "Disable or gateway `DELETE /api/account/delete`" in runbook
    assert "Shift 100% of traffic to a tombstone-aware bridge revision" in runbook
    assert "arbitrary pre-201 traffic rollback is forbidden" in runbook
    assert "AUTH_ACCOUNT_NOT_FOUND" in runbook
    assert "exact UID-bound Firebase token" in " ".join(runbook.split())
    assert "momentary `active` probe can be a pre-commit" in runbook
    assert "must not offer automatic Retry" in " ".join(runbook.split())


def test_legacy_repair_scripts_cannot_delete_account_lifecycle_roots():
    partial_vault_repair = (ROOT / "scripts/fix_partial_vault_rows.py").read_text(encoding="utf-8")
    reviewer_sync = (ROOT / "scripts/local_sync_email_reviewer_from_kai_user.py").read_text(
        encoding="utf-8"
    )

    assert "DELETE FROM vault_keys" not in partial_vault_repair
    assert "Refusing direct vault-root deletion" in partial_vault_repair
    assert "if args.delete_invalid:" in partial_vault_repair
    assert '"DELETE FROM actor_profiles WHERE user_id = $1"' not in reviewer_sync
    assert '"DELETE FROM vault_keys WHERE user_id = $1"' not in reviewer_sync
    assert reviewer_sync.count("ON CONFLICT (user_id) DO UPDATE") >= 2


async def _run_stale_writer_barrier_rehearsal(database_url: str) -> None:
    """Apply the real migration in a disposable DB and drive both sessions."""
    import asyncpg

    def read_psql_script(path: Path) -> str:
        return "\n".join(
            line
            for line in path.read_text(encoding="utf-8").splitlines()
            if not line.lstrip().startswith("\\")
        )

    deletion_conn = await asyncpg.connect(database_url)
    writer_conn = await asyncpg.connect(database_url)
    migration = (ROOT / "db/migrations/201_account_deletion_tombstones.sql").read_text(
        encoding="utf-8"
    )
    release_fence = read_psql_script(
        REPO_ROOT / "deploy/account-deletion/install_release_fence.sql"
    )
    release_boundary = read_psql_script(
        REPO_ROOT / "deploy/account-deletion/verify_release_boundary.sql"
    )
    remove_release_fence = read_psql_script(
        REPO_ROOT / "deploy/account-deletion/remove_release_fence.sql"
    )
    uid = "migration_201_stale_writer_uid"
    reparent_uid = "migration_201_reparent_source_uid"
    reparent_target_uid = "migration_201_reparent_target_uid"
    legacy_uid = "migration_201_legacy_rootless_inventory_uid"
    status_commit_uid = "migration_201_status_commit_uid"
    status_rollback_uid = "migration_201_status_rollback_uid"
    try:
        await deletion_conn.execute(
            """
            CREATE TABLE actor_profiles (user_id TEXT PRIMARY KEY);
            CREATE TABLE vault_keys (user_id TEXT PRIMARY KEY);
            CREATE TABLE resurrection_probe (
              id BIGSERIAL PRIMARY KEY,
              user_id TEXT NOT NULL
            );
            CREATE TABLE identity_set_null_probe (
              id BIGSERIAL PRIMARY KEY,
              owner_user_id TEXT REFERENCES actor_profiles(user_id) ON DELETE SET NULL
            );
            CREATE TABLE consent_audit_receipts (
              id BIGSERIAL PRIMARY KEY,
              subject_id TEXT NOT NULL
            );
            """
        )
        await deletion_conn.execute("INSERT INTO actor_profiles (user_id) VALUES ($1)", legacy_uid)
        await deletion_conn.execute(
            "INSERT INTO identity_set_null_probe (owner_user_id) VALUES ($1)", legacy_uid
        )
        await deletion_conn.execute(
            "INSERT INTO consent_audit_receipts (subject_id) VALUES ($1)", legacy_uid
        )
        # Exercise the same migration-first release bridge used by UAT: drain
        # earlier root writes, reject every deletion (including a zero-row
        # statement), install/verify the complete v201 catalog contract, then
        # atomically activate deletion by removing both temporary fences.
        await deletion_conn.execute(release_fence)
        await deletion_conn.execute(migration)
        await deletion_conn.execute(release_boundary)
        await deletion_conn.execute(remove_release_fence)
        assert (
            await deletion_conn.fetchval(
                """
            SELECT COUNT(*)
            FROM pg_trigger
            WHERE tgname = 'trg_block_account_deletion_during_release'
              AND NOT tgisinternal
            """
            )
            == 0
        )
        # Hosted release lanes replay the ordered migration set. Reapplying
        # 201 must preserve the already-backfilled registry and audited guard
        # shapes without recursively firing its own DDL event trigger.
        await deletion_conn.execute(migration)

        # A provisional phone-verification identity can become established
        # before the worker revalidates it. Cancel only that intent; prove the
        # actual status reader and write guard then allow normal bootstrap.
        from unittest.mock import patch

        from sqlalchemy import create_engine

        from hushh_mcp.services import account_deletion_lifecycle_service as lifecycle

        lifecycle_engine = create_engine(database_url)
        phone_uid = "migration_201_protected_phone_uid"
        full_uid = "migration_201_full_delete_preserved_uid"
        proof = lifecycle.account_deletion_phone_digest("+16505550101")
        service = lifecycle.AccountDeletionLifecycleService
        protected = lifecycle.FirebaseCleanupAttempt(
            "protected", classification="firebase_identity_established"
        )
        try:
            with patch.object(lifecycle, "get_db_connection", lifecycle_engine.begin):
                assert await asyncio.to_thread(
                    service.record_pending_if_account_state_absent,
                    user_id=phone_uid,
                    expected_phone_digest=proof,
                )
                assert await asyncio.to_thread(service.is_tombstoned, phone_uid)
                # A stale worker may not cancel an unclaimed/newer intent.
                assert not await asyncio.to_thread(
                    service.record_cleanup_outcome,
                    user_id=phone_uid,
                    attempt=protected,
                    intent_kind="phone_orphan",
                    expected_phone_digest=proof,
                    claim_token=str(UUID(int=1)),
                )
                assert await asyncio.to_thread(service.is_tombstoned, phone_uid)
                assert await asyncio.to_thread(
                    service.record_cleanup_outcome,
                    user_id=phone_uid,
                    attempt=protected,
                    intent_kind="phone_orphan",
                    expected_phone_digest=proof,
                )
                assert not await asyncio.to_thread(service.is_tombstoned, phone_uid)
                await writer_conn.execute(
                    "INSERT INTO actor_profiles (user_id) VALUES ($1)", phone_uid
                )
                await writer_conn.execute("INSERT INTO vault_keys (user_id) VALUES ($1)", phone_uid)
                await asyncio.to_thread(service.record_pending, user_ids=(full_uid,))
                assert not await asyncio.to_thread(
                    service.record_cleanup_outcome,
                    user_id=full_uid,
                    attempt=protected,
                    intent_kind="phone_orphan",
                    expected_phone_digest=proof,
                )
                assert await asyncio.to_thread(service.is_tombstoned, full_uid)
        finally:
            lifecycle_engine.dispose()

        # Initial installation backfills rootless/legacy identity state into one
        # indexed hash-only registry. Root deletion then proves that the global
        # immutability guard still permits ON DELETE SET NULL, but only after
        # the root trigger has recorded the OLD UID tombstone.
        assert (
            await deletion_conn.fetchval(
                """
            SELECT EXISTS (
              SELECT 1 FROM account_identity_presence
              WHERE user_id_hash =
                'sha256:' || encode(digest($1, 'sha256'), 'hex')
            )
            """,
                legacy_uid,
            )
            is True
        )
        assert (
            await deletion_conn.fetchval(
                """
            SELECT COUNT(*)
            FROM pg_trigger
            WHERE tgrelid = 'consent_audit_receipts'::regclass
              AND tgname IN (
                'trg_reject_deleted_account_insert',
                'trg_reject_deleted_account_reference_update'
              )
              AND tgenabled = 'O'
              AND NOT tgisinternal
            """
            )
            == 2
        )
        await deletion_conn.execute("DELETE FROM actor_profiles WHERE user_id = $1", legacy_uid)
        assert (
            await deletion_conn.fetchval(
                "SELECT owner_user_id FROM identity_set_null_probe LIMIT 1"
            )
            is None
        )
        with pytest.raises(asyncpg.CheckViolationError) as receipt_rejected:
            await deletion_conn.execute(
                "INSERT INTO consent_audit_receipts (subject_id) VALUES ($1)",
                legacy_uid,
            )
        assert receipt_rejected.value.sqlstate == "23514"

        # DDL after migration 201 receives both guards and a transactional
        # backfill without relying on a request-time scan or a future migration
        # author remembering the installer call.
        await deletion_conn.execute(
            """
            CREATE TABLE late_identity_probe AS
            SELECT 'migration_201_late_ddl_uid'::TEXT AS user_id
            """
        )
        assert (
            await deletion_conn.fetchval(
                """
            SELECT COUNT(*)
            FROM pg_trigger
            WHERE tgrelid = 'late_identity_probe'::regclass
              AND tgname IN (
                'trg_reject_deleted_account_insert',
                'trg_reject_deleted_account_reference_update'
              )
              AND tgenabled = 'O'
              AND NOT tgisinternal
            """
            )
            == 2
        )
        assert (
            await deletion_conn.fetchval(
                """
            SELECT EXISTS (
              SELECT 1 FROM account_identity_presence
              WHERE user_id_hash = 'sha256:' || encode(
                digest('migration_201_late_ddl_uid', 'sha256'), 'hex'
              )
            )
            """
            )
            is True
        )

        async def status_probe(probe_uid: str) -> bool:
            status_tx = writer_conn.transaction(isolation="read_committed")
            await status_tx.start()
            try:
                await writer_conn.execute(
                    "SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 171))",
                    probe_uid,
                )
                await writer_conn.execute(
                    "SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 198))",
                    probe_uid,
                )
                deleted = await writer_conn.fetchval(
                    """
                    SELECT EXISTS (
                      SELECT 1 FROM account_deletion_tombstones
                      WHERE user_id_hash =
                        'sha256:' || encode(digest($1, 'sha256'), 'hex')
                    )
                    """,
                    probe_uid,
                )
                await status_tx.commit()
                return bool(deleted)
            except BaseException:
                await status_tx.rollback()
                raise

        # A status/auth read that begins after the root DELETE must not observe
        # a pre-commit false negative. It blocks on namespace 171 and sees the
        # tombstone after commit; if deletion rolls back it resumes as active.
        await deletion_conn.execute(
            "INSERT INTO vault_keys (user_id) VALUES ($1)", status_commit_uid
        )
        status_delete_tx = deletion_conn.transaction(isolation="read_committed")
        await status_delete_tx.start()
        await deletion_conn.execute("DELETE FROM vault_keys WHERE user_id = $1", status_commit_uid)
        committed_status = asyncio.create_task(status_probe(status_commit_uid))
        await asyncio.sleep(0.2)
        assert not committed_status.done()
        await status_delete_tx.commit()
        assert await committed_status is True

        rollback_delete_tx = deletion_conn.transaction(isolation="read_committed")
        await rollback_delete_tx.start()
        await deletion_conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 171))",
            status_rollback_uid,
        )
        await deletion_conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 198))",
            status_rollback_uid,
        )
        rolled_back_status = asyncio.create_task(status_probe(status_rollback_uid))
        await asyncio.sleep(0.2)
        assert not rolled_back_status.done()
        await rollback_delete_tx.rollback()
        assert await rolled_back_status is False

        await deletion_conn.execute("INSERT INTO vault_keys (user_id) VALUES ($1)", uid)

        deletion_tx = deletion_conn.transaction(isolation="read_committed")
        await deletion_tx.start()
        try:
            # Simulate an old full-delete revision doing graph cleanup before
            # reaching either migration-201 root row.
            await deletion_conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 171))",
                uid,
            )
            writer = asyncio.create_task(
                writer_conn.execute(
                    "INSERT INTO resurrection_probe (user_id) VALUES ($1)",
                    uid,
                )
            )
            await asyncio.sleep(0.2)
            assert not writer.done(), "writer crossed namespace 171 before deletion committed"

            await deletion_conn.execute("DELETE FROM vault_keys WHERE user_id = $1", uid)
            await deletion_tx.commit()
        except BaseException:
            await deletion_tx.rollback()
            raise

        with pytest.raises(asyncpg.CheckViolationError) as rejected:
            await writer
        assert rejected.value.sqlstate == "23514"
        assert (
            await writer_conn.fetchval(
                "SELECT COUNT(*) FROM resurrection_probe WHERE user_id = $1",
                uid,
            )
            == 0
        )
        assert (
            await writer_conn.fetchval(
                """
            SELECT cleanup_status
            FROM account_deletion_tombstones
            WHERE user_id_hash = 'sha256:' || encode(digest($1, 'sha256'), 'hex')
            """,
                uid,
            )
            == "pending"
        )

        # A writer must not move an account-owned row away from an identity
        # while deletion owns that UID. Waiting for OLD here would invert the
        # tuple/advisory lock order, so migration 201 rejects non-NULL identity
        # reassignment immediately and leaves the source row deletable.
        await writer_conn.execute("INSERT INTO vault_keys (user_id) VALUES ($1)", reparent_uid)
        await writer_conn.execute(
            "INSERT INTO resurrection_probe (user_id) VALUES ($1)", reparent_uid
        )
        reparent_deletion_tx = deletion_conn.transaction(isolation="read_committed")
        await reparent_deletion_tx.start()
        try:
            await deletion_conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 171))",
                reparent_uid,
            )
            with pytest.raises(asyncpg.CheckViolationError) as immutable:
                await asyncio.wait_for(
                    writer_conn.execute(
                        "UPDATE resurrection_probe SET user_id = $1 WHERE user_id = $2",
                        reparent_target_uid,
                        reparent_uid,
                    ),
                    timeout=1.0,
                )
            assert immutable.value.constraint_name == ("account_identity_reference_immutable_guard")
            assert (
                await writer_conn.fetchval(
                    "SELECT COUNT(*) FROM resurrection_probe WHERE user_id = $1",
                    reparent_uid,
                )
                == 1
            )
            await deletion_conn.execute(
                "DELETE FROM resurrection_probe WHERE user_id = $1", reparent_uid
            )
            await deletion_conn.execute("DELETE FROM vault_keys WHERE user_id = $1", reparent_uid)
            await reparent_deletion_tx.commit()
        except BaseException:
            await reparent_deletion_tx.rollback()
            raise
        await _assert_pod_admission_deletion_fence(deletion_conn, writer_conn)
    finally:
        await writer_conn.close()
        await deletion_conn.close()


async def _assert_pod_admission_deletion_fence(deletion_conn, writer_conn) -> None:
    """Actual parked schemas inherit migration 201's dynamic admission fence."""
    import asyncpg

    for filename in ("900_personal_agent_registry.sql", "911_pod_migration_jobs.sql"):
        await deletion_conn.execute((ROOT / "db/migrations/parked" / filename).read_text())
    admissions = {
        "personal_agent_registry": (
            "INSERT INTO personal_agent_registry(user_id, hushh_id) VALUES($1, $1)"
        ),
        "pod_migration_jobs": (
            "INSERT INTO pod_migration_jobs(user_id, job_id, hushh_id, target_project) "
            "VALUES($1, $1, $1, 'synthetic-project')"
        ),
    }
    for table, insert in admissions.items():
        for upsert in (False, True):
            for commit in (False, True):
                uid = f"synthetic_fence_{table}_{upsert}_{commit}"
                await deletion_conn.execute("INSERT INTO actor_profiles(user_id) VALUES($1)", uid)
                tx = deletion_conn.transaction()
                await tx.start()
                task = None
                try:
                    await deletion_conn.execute("DELETE FROM actor_profiles WHERE user_id=$1", uid)
                    sql = insert
                    if upsert:
                        sql += " ON CONFLICT(user_id) DO UPDATE SET status=EXCLUDED.status"
                    task = asyncio.create_task(writer_conn.execute(sql, uid))
                    waited = False
                    for _ in range(100):
                        waited = await deletion_conn.fetchval(
                            "SELECT wait_event='advisory' FROM pg_stat_activity WHERE pid=$1",
                            writer_conn.get_server_pid(),
                        )
                        if waited:
                            break
                        await asyncio.sleep(0.01)
                    assert waited and not task.done(), (table, upsert, commit)
                except BaseException:
                    await tx.rollback()
                    if task:
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
                    raise
                if commit:
                    await tx.commit()
                    with pytest.raises(asyncpg.CheckViolationError) as rejected:
                        await asyncio.wait_for(task, timeout=5)
                    assert rejected.value.sqlstate == "23514"
                else:
                    await tx.rollback()
                    await asyncio.wait_for(task, timeout=5)
                # Table names come only from the literal map above.
                count = await deletion_conn.fetchval(
                    f"SELECT count(*) FROM {table} WHERE user_id=$1", uid
                )
                assert count == (0 if commit else 1)


@pytest.mark.db
@pytest.mark.skipif(
    os.getenv("RUN_ACCOUNT_DELETION_POSTGRES_REHEARSAL") != "1"
    or not os.getenv("ACCOUNT_DELETION_POSTGRES_URL"),
    reason="requires an explicitly enabled, empty disposable PostgreSQL database",
)
def test_real_stale_writer_blocks_then_rejects_after_prior_cleanup():
    """A post-cleanup stale writer cannot commit across the tombstone boundary."""
    asyncio.run(_run_stale_writer_barrier_rehearsal(os.environ["ACCOUNT_DELETION_POSTGRES_URL"]))

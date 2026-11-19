# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Static and real-PostgreSQL contract checks for migration 459."""

from __future__ import annotations

import json
import os
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db/migrations/459_control_plane_kyc_redaction_and_call_indexes.sql"
ROLLBACK = (
    ROOT / "db/migrations/rollback/459_control_plane_kyc_redaction_and_call_indexes.rollback.sql"
)
DIRECT_CALL_INDEXES = {
    "idx_direct_communication_keys_user_device",
    "idx_direct_calls_caller",
    "idx_direct_calls_conversation",
    "idx_direct_call_commands_user_device",
    "idx_direct_call_voip_tokens_user_device",
}


def test_migration_459_is_registered_ledger_safe_and_reversible() -> None:
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text())
    sql = MIGRATION.read_text(encoding="utf-8")
    rollback = ROLLBACK.read_text(encoding="utf-8")

    assert MIGRATION.name in manifest["ordered_migrations"]
    assert manifest["rollback_migrations"][MIGRATION.name] == f"rollback/{ROLLBACK.name}"
    for contract_name in ("dev_minimum_schema", "prod_core_schema", "uat_integrated_schema"):
        contract = json.loads((ROOT / f"db/contracts/{contract_name}.json").read_text())
        assert contract["expected_migration_version"] >= 459
        assert contract["expected_schema_head"] >= 459
    for idx_name in DIRECT_CALL_INDEXES:
        assert f"CREATE INDEX IF NOT EXISTS {idx_name}" in sql
        assert f"DROP INDEX IF EXISTS public.{idx_name};" in rollback


@pytest.mark.db
def test_migration_459_redacts_legacy_kyc_minifies_mail_display_and_rolls_back() -> None:
    value = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not value:
        pytest.skip("requires disposable PostgreSQL via ONE_COMMAND_TEST_DATABASE_URL")
    url = make_url(value)
    assert url.host in {"localhost", "127.0.0.1"}
    db_name = "mig459_test_" + uuid4().hex
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql(f'CREATE DATABASE "{db_name}"')
    engine = create_engine(url.set(database=db_name), pool_size=2, max_overflow=0)
    try:
        m049 = (ROOT / "db/migrations/049_one_email_kyc_workflows.sql").read_text(encoding="utf-8")
        m173 = (ROOT / "db/migrations/173_gmail_owner_approved_delivery.sql").read_text(
            encoding="utf-8"
        )
        m275 = (ROOT / "db/migrations/275_scheduled_mail_send.sql").read_text(encoding="utf-8")
        m264 = (ROOT / "db/migrations/264_direct_messages.sql").read_text(encoding="utf-8")
        m452 = (ROOT / "db/migrations/452_direct_calls.sql").read_text(encoding="utf-8")
        m459 = MIGRATION.read_text(encoding="utf-8")
        r459 = ROLLBACK.read_text(encoding="utf-8")

        fn_start = m264.index(
            "CREATE OR REPLACE FUNCTION public.require_active_direct_message_connection("
        )
        dm_fn_sql = m264[fn_start : m264.index("$$;", fn_start) + 3]

        with engine.begin() as conn:
            conn.exec_driver_sql(
                """
                CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY);
                CREATE TABLE vault_keys(user_id TEXT PRIMARY KEY);
                CREATE TABLE trusted_devices(
                  device_id TEXT PRIMARY KEY,
                  user_id TEXT,
                  UNIQUE(user_id, device_id)
                );
                CREATE TABLE connections(
                  user_a_id TEXT,
                  user_b_id TEXT,
                  status TEXT,
                  PRIMARY KEY(user_a_id, user_b_id)
                );
                CREATE TABLE conversations(
                  id UUID PRIMARY KEY,
                  participant_a_user_id TEXT,
                  participant_b_user_id TEXT
                );
                CREATE TABLE direct_message_blocks(blocker_user_id TEXT, blocked_user_id TEXT);
                INSERT INTO actor_profiles VALUES ('owner-1');
                INSERT INTO vault_keys VALUES ('owner-1');
                """
            )
            conn.exec_driver_sql(dm_fn_sql, execution_options={"no_parameters": True})

        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            for ddl in (m049, m173, m275, m452):
                conn.exec_driver_sql(ddl, execution_options={"no_parameters": True})

        with engine.begin() as conn:
            conn.execute(
                text(
                    """
                    INSERT INTO one_kyc_workflows (
                      workflow_id, user_id, status, gmail_message_id, sender_email, sender_name,
                      participant_emails, subject, snippet, counterparty_label, draft_subject,
                      last_error_message
                    ) VALUES (
                      'wf-1', 'owner-1', 'completed', 'msg-1', 'broker@example.com', 'Broker',
                      '["broker@example.com"]'::jsonb, 'KYC Request', 'Snippet text', 'Acme',
                      'Draft Reply', 'transient error'
                    )
                    """
                )
            )
            conn.execute(
                text(
                    """
                    INSERT INTO gmail_owner_send_actions (
                      action_id, user_id, envelope_hmac, idempotency_hmac, recipient_count,
                      state, expires_at, send_at, recipient_display, notified_at
                    ) VALUES
                      ('act-cancelled', 'owner-1', 'e1', 'i1', 1, 'cancelled', NOW(), NOW(), 'Priya', NULL),
                      ('act-notified', 'owner-1', 'e2', 'i2', 1, 'sent', NOW(), NOW(), 'Priya', NOW()),
                      ('act-pending-push', 'owner-1', 'e3', 'i3', 1, 'sent', NOW(), NOW(), 'Priya', NULL),
                      ('act-scheduled', 'owner-1', 'e4', 'i4', 1, 'scheduled', NOW() + INTERVAL '1 hour', NOW() + INTERVAL '30 minutes', 'Priya', NULL)
                    """
                )
            )

        # Replay-safe execution inside explicit transaction envelopes (matching migration ledger)
        for _ in range(2):
            with engine.begin() as conn:
                conn.exec_driver_sql(m459, execution_options={"no_parameters": True})

        with engine.begin() as conn:
            kyc = (
                conn.execute(
                    text(
                        """
                        SELECT sender_email, sender_name, participant_emails, subject, snippet,
                               counterparty_label, draft_subject, last_error_message,
                               metadata->>'control_plane_redaction_migration' AS redacted_by
                        FROM one_kyc_workflows WHERE workflow_id = 'wf-1'
                        """
                    )
                )
                .mappings()
                .one()
            )
            assert kyc["sender_email"] is None
            assert kyc["sender_name"] is None
            assert kyc["participant_emails"] == []
            assert kyc["subject"] is None
            assert kyc["snippet"] is None
            assert kyc["counterparty_label"] is None
            assert kyc["draft_subject"] is None
            assert kyc["last_error_message"] is None
            assert kyc["redacted_by"] == "459_control_plane_kyc_redaction_and_call_indexes"

            mail_rows = dict(
                conn.execute(
                    text("SELECT action_id, recipient_display FROM gmail_owner_send_actions")
                ).fetchall()
            )
            assert mail_rows == {
                "act-cancelled": None,
                "act-notified": None,
                "act-pending-push": "Priya",
                "act-scheduled": "Priya",
            }

            indexes = {
                row[0]
                for row in conn.execute(
                    text(
                        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'"
                        " AND indexname LIKE 'idx_direct_%'"
                    )
                ).fetchall()
            }
            assert DIRECT_CALL_INDEXES <= indexes

        with pytest.raises(IntegrityError):
            with engine.begin() as conn:
                conn.execute(
                    text(
                        "UPDATE one_kyc_workflows SET subject = 'forbidden'"
                        " WHERE workflow_id = 'wf-1'"
                    )
                )

        # Replay-safe rollback and forward re-application
        for _ in range(2):
            with engine.begin() as conn:
                conn.exec_driver_sql(r459, execution_options={"no_parameters": True})

        with engine.begin() as conn:
            remaining = {
                row[0]
                for row in conn.execute(
                    text(
                        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'"
                        " AND indexname LIKE 'idx_direct_%'"
                    )
                ).fetchall()
            }
            assert not (DIRECT_CALL_INDEXES & remaining)
            conn.exec_driver_sql(m459, execution_options={"no_parameters": True})
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)')
        admin.dispose()

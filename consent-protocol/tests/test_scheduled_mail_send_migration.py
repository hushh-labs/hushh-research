"""Contract checks for migration 275: scheduled owner-approved Gmail sends."""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db/migrations/275_scheduled_mail_send.sql"
ROLLBACK = ROOT / "db/migrations/rollback/275_scheduled_mail_send.rollback.sql"
TABLE = "gmail_owner_send_actions"
NEW_COLUMNS = (
    "send_at",
    "payload_sealed",
    "recipient_display",
    "subject",
    "attempt_count",
    "notified_at",
)
ORIGINAL_STATES = ("prepared", "sending", "sent", "failed", "outcome_unknown", "expired")


def _manifest() -> dict:
    return json.loads((ROOT / "db/release_migration_manifest.json").read_text())


def _states(sql: str) -> set[str]:
    block = sql.split("ADD CONSTRAINT gmail_owner_send_actions_state_check", 1)[1]
    block = block.split(";", 1)[0]
    return set(re.findall(r"'([a-z_]+)'", block))


def test_scheduled_send_migration_is_registered_replayable_and_reversible() -> None:
    manifest = _manifest()
    sql = MIGRATION.read_text()
    rollback = ROLLBACK.read_text()

    assert MIGRATION.name in manifest["ordered_migrations"]
    assert MIGRATION.name in manifest["groups"]["iam"]
    assert manifest["rollback_migrations"][MIGRATION.name] == f"rollback/{ROLLBACK.name}"
    # Replay-safe: every deploy re-runs the file against a database it already applied to.
    for column in NEW_COLUMNS:
        assert f"ADD COLUMN IF NOT EXISTS {column} " in sql
        assert f"DROP COLUMN IF EXISTS {column};" in rollback
    assert "CREATE INDEX IF NOT EXISTS idx_gmail_owner_send_actions_scheduled_send_at" in sql
    assert "DROP INDEX IF EXISTS idx_gmail_owner_send_actions_scheduled_send_at" in rollback


def test_scheduled_send_widens_the_state_check_and_keeps_rows_readable_by_old_writers() -> None:
    sql = MIGRATION.read_text()

    assert _states(sql) == {*ORIGINAL_STATES, "scheduled", "cancelled"}
    # prepare() inserts with an explicit column list, so every new column is
    # nullable or defaulted and an existing writer is unaffected.
    assert "attempt_count INTEGER NOT NULL DEFAULT 0" in sql
    for column in ("send_at", "payload_sealed", "recipient_display", "subject", "notified_at"):
        line = next(line for line in sql.splitlines() if f"IF NOT EXISTS {column} " in line)
        assert "NOT NULL" not in line, column
    # A scheduled row always has a time, and only waiting rows are indexed.
    assert "CHECK (state <> 'scheduled' OR send_at IS NOT NULL)" in sql
    assert "WHERE state = 'scheduled'" in sql
    # Ciphertext only: no plaintext body or address column is added.
    for forbidden in ("body TEXT", "recipient_email", "to_address"):
        assert forbidden not in sql


def test_rollback_restores_the_original_shape_and_refuses_while_scheduled_rows_exist() -> None:
    rollback = ROLLBACK.read_text()

    assert _states(rollback) == set(ORIGINAL_STATES)
    assert "WHERE state IN ('scheduled', 'cancelled')" in rollback
    assert "migration_275_rollback_refused_scheduled_rows" in rollback
    guard = rollback.index("RAISE EXCEPTION")
    # The guard runs before anything is dropped.
    assert guard < rollback.index("DROP INDEX")
    assert guard < rollback.index("DROP COLUMN")


def test_release_contracts_require_the_scheduled_send_columns() -> None:
    for name in ("dev_minimum_schema", "prod_core_schema", "uat_integrated_schema"):
        contract = json.loads((ROOT / f"db/contracts/{name}.json").read_text())
        assert contract["expected_migration_version"] >= 275, name
        assert set(NEW_COLUMNS) <= set(contract["required_tables"][TABLE]), name


def test_runtime_data_plane_declares_the_scheduled_payload_and_display_columns() -> None:
    """Migration 275 puts a sealed payload and two plaintext display columns in a
    table the governed contract once described as holding no subject at all. The
    contract must say so, or an audit reads a false trust boundary."""
    contract = json.loads(
        (
            ROOT.parent / "docs/reference/architecture/runtime-db-data-plane-contract.json"
        ).read_text()
    )
    family = next(
        item for item in contract["table_families"] if item["id"] == "gmail_owner_approved_delivery"
    )
    assert "gmail_owner_send_actions" in family["exact_tables"]
    boundary = family["trust_boundary"]
    for column in ("payload_sealed", "subject", "recipient_display"):
        assert column in boundary, column
    # The schedule and cancel confirmations speak the confirmed connection's
    # name back to the owner, so "never sent to the Live model" was false for
    # recipient_display. Only subject and the sealed payload stay off the model.
    assert "never sent to the Live model" not in boundary
    assert "recipient_display may be spoken back to the owner" in boundary
    assert "subject and payload_sealed never reach the Live model" in boundary
    assert "terminal scheduled row has payload_sealed and subject cleared" in boundary
    retention = family["retention_policy"]
    assert "send_at + 24 hours" in retention
    assert "failed (schedule_window_passed)" in retention
    assert "clears payload_sealed and subject on every terminal state" in retention
    assert family["plaintext_posture"] != "short_lived_hmac_and_delivery_metadata_only"


def test_migration_header_states_the_model_boundary_truthfully() -> None:
    comment = MIGRATION.read_text().split("BEGIN;", 1)[0]
    header = " ".join(line.removeprefix("--").strip() for line in comment.splitlines())

    assert "neither reaches a model" not in header
    assert "subject and payload_sealed never reach the Live model" in header
    assert "payload_sealed and subject are cleared" in header

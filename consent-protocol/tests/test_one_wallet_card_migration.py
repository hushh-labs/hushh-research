"""Release contract for migration 132 — the Wallet Profile card plane.

The card lives in its own additive table. Two properties are load-bearing and
are asserted here rather than left to review:

1. The migration must never touch ``pkm_default_available_projections``. That
   table is read by the Information Marketplace catalogue, so a card written
   there would silently list the owner for sale.
2. The table must carry aggregate scan counters only — no per-scan telemetry
   row, address, user agent, referrer, or coordinate — and must never hold the
   plaintext share token.

Structural assertions run against the DDL with SQL comments stripped, so the
explanatory prose in the migration header can mention a table without the test
mistaking it for a statement that touches one.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "db" / "migrations"
MANIFEST = ROOT / "db" / "release_migration_manifest.json"
UAT_CONTRACT = ROOT / "db" / "contracts" / "uat_integrated_schema.json"
PROD_CONTRACT = ROOT / "db" / "contracts" / "prod_core_schema.json"

MIGRATION_NAME = "132_one_wallet_card.sql"
ROLLBACK_NAME = "132_one_wallet_card_down.sql"

EXPECTED_COLUMNS = (
    "user_id",
    "pass_serial",
    "share_token_hash",
    "share_token_version",
    "status",
    "card_payload",
    "display_name",
    "headline",
    "avatar_url",
    "expires_at",
    "created_at",
    "updated_at",
    "revoked_at",
    "last_scanned_at",
    "scan_count",
)

_LINE_COMMENT = re.compile(r"--.*?$", re.MULTILINE)
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
_SINGLE_QUOTED = re.compile(r"'(?:[^']|'')*'", re.DOTALL)


def _migration_sql() -> str:
    return (MIGRATIONS / MIGRATION_NAME).read_text(encoding="utf-8")


def _rollback_sql() -> str:
    return (MIGRATIONS / "rollback" / ROLLBACK_NAME).read_text(encoding="utf-8")


def _statements_only(sql: str) -> str:
    """Strip SQL comments so prose cannot satisfy or break a DDL assertion."""
    return _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", sql))


def _ddl_only(sql: str) -> str:
    """Statements with string literals removed as well.

    ``COMMENT ON`` bodies are string literals, and this migration documents its
    privacy boundary there in plain English. Those words must not be read as
    schema.
    """
    return _SINGLE_QUOTED.sub("''", _statements_only(sql))


def test_wallet_card_migration_is_release_registered_and_sequenced() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    ordered = manifest["ordered_migrations"]

    assert (MIGRATIONS / MIGRATION_NAME).exists()
    assert MIGRATION_NAME in ordered
    assert MIGRATION_NAME in manifest["groups"]["iam"]
    assert len(ordered) == len(set(ordered))
    assert ordered.index(MIGRATION_NAME) > ordered.index(
        "131_one_location_nearby_point_contract.sql"
    )
    # The rollback is operational only and must stay out of the release list.
    assert ROLLBACK_NAME not in ordered


def test_wallet_card_table_is_in_the_uat_and_prod_schema_contracts() -> None:
    uat = json.loads(UAT_CONTRACT.read_text(encoding="utf-8"))
    prod = json.loads(PROD_CONTRACT.read_text(encoding="utf-8"))

    for contract in (uat, prod):
        assert contract["expected_migration_version"] >= 132
        columns = contract["required_tables"]["one_wallet_cards"]
        assert set(EXPECTED_COLUMNS) <= set(columns)


def test_wallet_card_table_has_the_contracted_columns() -> None:
    ddl = _ddl_only(_migration_sql())

    assert "CREATE TABLE IF NOT EXISTS one_wallet_cards" in ddl
    assert "user_id TEXT PRIMARY KEY" in ddl
    assert "pass_serial UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE" in ddl
    assert "share_token_hash TEXT NOT NULL UNIQUE" in ddl
    assert "share_token_version INTEGER NOT NULL DEFAULT 1" in ddl
    assert "card_payload JSONB NOT NULL DEFAULT ''::jsonb" in ddl
    assert "scan_count BIGINT NOT NULL DEFAULT 0" in ddl
    assert "expires_at TIMESTAMPTZ" in ddl
    assert "revoked_at TIMESTAMPTZ" in ddl
    assert "last_scanned_at TIMESTAMPTZ" in ddl
    assert "created_at TIMESTAMPTZ NOT NULL DEFAULT now()" in ddl
    assert "updated_at TIMESTAMPTZ NOT NULL DEFAULT now()" in ddl

    for column in EXPECTED_COLUMNS:
        assert column in ddl, column


def test_wallet_card_status_is_constrained_to_the_three_owner_states() -> None:
    ddl = _ddl_only(_migration_sql())
    collapsed = " ".join(ddl.split())

    assert "status TEXT NOT NULL DEFAULT ''" in collapsed
    assert "CHECK (status IN ('', '', ''))" in collapsed
    # The literal states survive comment stripping only in the raw text.
    statements = " ".join(_statements_only(_migration_sql()).split())
    assert "CHECK (status IN ('active', 'paused', 'revoked'))" in statements


def test_wallet_card_uniqueness_and_status_index_exist() -> None:
    ddl = _ddl_only(_migration_sql())

    # The unique constraints ride on the column declarations (contract §2).
    assert "share_token_hash TEXT NOT NULL UNIQUE" in ddl
    assert "pass_serial UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE" in ddl
    assert "CREATE INDEX IF NOT EXISTS idx_one_wallet_cards_status" in ddl
    assert "ON one_wallet_cards (status)" in ddl


def test_wallet_card_migration_never_stores_the_plaintext_share_token() -> None:
    ddl = _ddl_only(_migration_sql())

    assert "share_token_hash" in ddl
    assert "share_token TEXT" not in ddl
    assert "share_token_plaintext" not in ddl
    assert "token_secret" not in ddl


def test_wallet_card_migration_stores_no_per_scan_telemetry() -> None:
    ddl = _ddl_only(_migration_sql()).lower()

    # Aggregate counters only. Anything below would be a per-visitor trace.
    for forbidden in (
        "ip_address",
        "user_agent",
        "referrer",
        "referer",
        "latitude",
        "longitude",
        "geohash",
        "scan_events",
        "one_wallet_card_scans",
        "device_id",
        "session_id",
        "fingerprint",
    ):
        assert forbidden not in ddl, forbidden

    assert "last_scanned_at" in ddl
    assert "scan_count" in ddl


def test_wallet_card_migration_is_additive_and_touches_no_existing_table() -> None:
    """The specific privacy defect this design exists to avoid.

    A card must never become a row in ``pkm_default_available_projections``:
    the Information Marketplace catalogue reads that table with no source
    filter and would list the owner for sale. No statement in this migration
    may reference it, and no pre-existing table may be mutated.
    """
    ddl = _ddl_only(_migration_sql()).lower()

    assert "pkm_default_available_projections" not in ddl
    assert "marketplace" not in ddl
    assert "public_profile_handle" not in ddl
    assert "publication_provenance" not in ddl
    assert "alter table" not in ddl
    assert "drop table" not in ddl
    assert "drop column" not in ddl
    assert "delete from" not in ddl
    assert "insert into" not in ddl
    assert "update " not in ddl


def test_wallet_card_rollback_drops_only_the_new_table() -> None:
    raw = _rollback_sql()
    ddl = _ddl_only(raw).lower()

    assert "drop table if exists one_wallet_cards" in ddl
    assert "pkm_default_available_projections" not in ddl
    assert "alter table" not in ddl
    assert ddl.count("drop table") == 1
    # Dropping the digests is unrecoverable, so the rollback refuses to run
    # while live cards exist rather than silently breaking printed QR codes.
    assert "RAISE EXCEPTION" in _statements_only(raw)
    assert "FROM one_wallet_cards" in _statements_only(raw)


def test_wallet_card_row_is_removed_by_the_account_deletion_cascade() -> None:
    source = (ROOT / "hushh_mcp" / "services" / "account_service.py").read_text(encoding="utf-8")

    assert "DELETE FROM one_wallet_cards WHERE user_id = :user_id" in source
    assert '"one_wallet_cards"' in source

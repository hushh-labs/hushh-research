"""Canonical migrations with the compact legacy Drive fixture projections."""

from pathlib import Path

from sqlalchemy.engine import Connection

MIGRATIONS = Path(__file__).resolve().parents[1] / "db" / "migrations"


def apply_drive_fixture_migration(connection: Connection, filename: str) -> None:
    connection.exec_driver_sql((MIGRATIONS / filename).read_text().replace("%", "%%"))
    if filename == "251_drive_owner_search_jobs.sql":
        # Legacy share/search fixtures have no packet heads or processing. They
        # need only migration 411's nullable lookup column for shared queries.
        connection.exec_driver_sql(
            "ALTER TABLE drive_owner_search_jobs ADD COLUMN IF NOT EXISTS period_packet_id UUID, ADD COLUMN IF NOT EXISTS retention_checked_at TIMESTAMPTZ"
        )
    elif filename == "334_drive_reusable_packets.sql":
        # Compact fixtures retain the canonical migration201 digest admission contract.
        connection.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS account_deletion_tombstones(user_id_hash TEXT PRIMARY KEY CHECK (user_id_hash ~ '^sha256:[0-9a-f]{64}$'))"
        )
        apply_drive_fixture_migration(connection, "411_drive_period_packets.sql")
        apply_drive_fixture_migration(connection, "416_financial_packet_tag_work.sql")
        apply_drive_fixture_migration(connection, "417_drive_packet_public_summary.sql")
        apply_drive_fixture_migration(connection, "422_financial_packet_discovery_capacity.sql")
        apply_drive_fixture_migration(connection, "426_financial_search_incomplete_reason.sql")


def apply_bulk_search_fixture_migrations(connection: Connection) -> None:
    for filename in ("251_drive_owner_search_jobs.sql", "254_drive_bulk_shares.sql"):
        apply_drive_fixture_migration(connection, filename)

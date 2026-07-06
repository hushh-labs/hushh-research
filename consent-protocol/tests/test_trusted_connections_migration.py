import json
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parent.parent / "db" / "migrations"
MANIFEST = Path(__file__).resolve().parent.parent / "db" / "release_migration_manifest.json"
FILENAME = "078_trusted_connections.sql"


def test_migration_file_exists_and_defines_table():
    sql = (MIGRATIONS / FILENAME).read_text(encoding="utf-8")
    assert "CREATE TABLE IF NOT EXISTS trusted_connections" in sql
    assert "trusted_connections_no_self" in sql
    assert "ux_trusted_connections_edge" in sql
    assert "BEGIN;" in sql and "COMMIT;" in sql


def test_migration_registered_in_release_manifest():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert FILENAME in manifest["ordered_migrations"]

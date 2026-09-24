"""Every user-keyed table is erased on account deletion, or explicitly kept with a reason.

The delete map is hand-maintained. This regression check inventories migration-authored
user-keyed tables and follows direct deletes, declared foreign-key cascades, and the
specialized Drive transaction invoked by full account deletion.

The SQL scan is inventory assistance, not a complete catalog parser: it does not
model every ALTER statement or runtime-created table. Compare it with live metadata
separately. Coverage below executes the actual full-deletion path against a recording
connection; unused DELETE strings cannot earn a pass. This does not establish database
constraint behavior, external-provider erasure, or the safety of retained metadata.

"""

from __future__ import annotations

import asyncio
import inspect
import pathlib
import re
from contextlib import contextmanager
from unittest.mock import MagicMock

import pytest

from hushh_mcp.services import drive_sharing_retention
from hushh_mcp.services.account_service import ACCOUNT_ERASURE_RETAINED_TABLES, AccountService

SERVICE_ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = SERVICE_ROOT / "db" / "migrations"
DRIVE_ERASE = drive_sharing_retention.erase_drive_account_in_transaction

_CREATE = re.compile(
    r'CREATE TABLE (?:IF NOT EXISTS )?"?([a-z_0-9]+)"?\s*\((.*?)\n\)\s*;', re.S | re.I
)
_USER_KEY = re.compile(r'^\s*"?(user_id|owner_user_id)"?\s', re.M | re.I)
_DROP = re.compile(r'DROP TABLE (?:IF EXISTS )?"?([a-z_0-9]+)"?', re.I)

# Every edge is checked against the creating migration below. The parent must
# itself be deleted or lead to another checked cascade edge.
_CASCADE_PARENT = {
    "one_capability_runs": "actor_profiles",
    "one_location_onboarding_interactions": "actor_profiles",
    "one_location_onboarding_receipts": "actor_profiles",
    "one_location_onboarding_drafts": "actor_profiles",
    "one_location_pkm_finalize_authorizations": "actor_profiles",
    "one_location_account_settings": "actor_profiles",
    "one_location_setup_progress": "actor_profiles",
    "one_voice_conversations": "actor_profiles",
    "one_voice_pending_actions": "one_voice_conversations",
    "drive_picker_sessions": "user_external_connector_connections",
    "connected_documents": "user_external_connector_connections",
    "document_chunks": "connected_documents",
    "drive_native_picker_attempts": "drive_picker_sessions",
}
_DRIVE_SPECIALIZED_TABLES = {
    "drive_share_requests",
    "drive_share_reviews",
    "drive_share_permission_operations",
    "drive_share_events",
    "drive_share_management_contexts",
}


def _user_keyed_tables() -> dict[str, str]:
    """Tables a migration creates with a person's key, minus any a migration drops."""
    created: dict[str, str] = {}
    dropped: set[str] = set()
    # Both trees: the personal-agent and BYOC tables that leaked live in `parked/`,
    # which are dev-only today and are precisely the ones erasure kept missing.
    sources = sorted(MIGRATIONS.glob("*.sql")) + sorted((MIGRATIONS / "parked").glob("*.sql"))
    for path in sources:
        text = path.read_text(errors="ignore")
        for match in _CREATE.finditer(text):
            if _USER_KEY.search(match.group(2)):
                created[match.group(1)] = path.name
        dropped.update(match.group(1) for match in _DROP.finditer(text))
    return {name: src for name, src in created.items() if name not in dropped}


@pytest.fixture
def erased_tables(monkeypatch) -> set[str]:
    """Capture SQL actually executed after the real external-resource guard."""
    service = AccountService()
    conn = MagicMock()
    conn.execute.return_value.first.return_value = None
    conn.execute.return_value.mappings.return_value.first.return_value = None
    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)
    drive_calls = []

    def record_drive_erasure(conn, *, user_id, permanent):
        drive_calls.append((user_id, permanent))
        return DRIVE_ERASE(conn, user_id=user_id, permanent=permanent)

    monkeypatch.setattr(
        drive_sharing_retention, "erase_drive_account_in_transaction", record_drive_erasure
    )

    @contextmanager
    def connection():
        yield conn

    monkeypatch.setattr("hushh_mcp.services.account_service.get_db_connection", connection)
    result = asyncio.run(service._delete_full_account("synthetic-owner", requested_target="both"))
    assert result["success"] is True
    statements = [str(call.args[0]) for call in conn.execute.call_args_list]
    guard = next(
        i for i, sql in enumerate(statements) if "SELECT TRUE FROM pod_migration_jobs" in sql
    )
    first_delete = next(i for i, sql in enumerate(statements) if "DELETE FROM" in sql)
    assert guard < first_delete
    assert drive_calls == [("synthetic-owner", True)]

    def deletion_index(table):
        return next(
            i
            for i, sql in enumerate(statements)
            if f"DELETE FROM {table} " in " ".join(sql.split()) + " "
        )

    assert deletion_index("ria_pick_legacy_retirements") < deletion_index("ria_profiles")
    assert deletion_index("advisor_investor_relationships") < deletion_index("ria_profiles")
    assert deletion_index("ria_profiles") < deletion_index("actor_profiles")
    return {table for sql in statements for table in re.findall(r"DELETE FROM (\w+)", sql)}


def test_the_migration_scan_finds_a_real_population(erased_tables) -> None:
    """Guard the guard: a broken regex would make this test vacuously pass."""
    tables = _user_keyed_tables()
    assert len(tables) > 80, (
        f"only {len(tables)} user-keyed tables parsed from {MIGRATIONS}; the scan is "
        "broken and this suite would pass while proving nothing"
    )
    assert "personal_agent_registry" in tables
    assert erased_tables, "full deletion executed no DELETE statements"


def test_every_retained_table_states_a_reason() -> None:
    """A retained table is a deliberate exception, so it must justify itself in prose."""
    for table, reason in ACCOUNT_ERASURE_RETAINED_TABLES.items():
        assert isinstance(reason, str) and len(reason.strip()) > 20, (
            f"{table} survives deletion with no stated reason. A retained table is a "
            "promise not kept unless it says why."
        )


def test_retained_tables_are_never_also_erased(erased_tables) -> None:
    """The two registries must not disagree about the same table."""
    overlap = erased_tables & set(ACCOUNT_ERASURE_RETAINED_TABLES)
    assert not overlap, f"tables both erased and declared retained: {sorted(overlap)}"


def test_no_user_keyed_table_is_silently_left_behind(erased_tables) -> None:
    """Every table has an executed delete, checked cascade, or specialized path."""
    tables = _user_keyed_tables()
    helper_source = inspect.getsource(DRIVE_ERASE)
    assert "r.recipient_user_id=:user" in helper_source
    for table in _DRIVE_SPECIALIZED_TABLES:
        assert re.search(rf"DELETE FROM {table}\b", helper_source)
    for table, parent in _CASCADE_PARENT.items():
        assert parent in erased_tables or parent in _CASCADE_PARENT
        assert table in tables
        source = (MIGRATIONS / tables[table]).read_text(errors="ignore")
        body = next(match.group(2) for match in _CREATE.finditer(source) if match.group(1) == table)
        assert re.search(
            rf"REFERENCES\s+{parent}\s*\([^)]*\)\s+ON DELETE CASCADE",
            body,
            re.I,
        ), f"{table} has no checked cascade to {parent}"
    unaccounted = sorted(
        set(tables)
        - erased_tables
        - set(_CASCADE_PARENT)
        - _DRIVE_SPECIALIZED_TABLES
        - set(ACCOUNT_ERASURE_RETAINED_TABLES)
    )
    assert not unaccounted, (
        "these tables carry a person's key but no erasure path or stated retention "
        "exception was established:\n  "
        + "\n  ".join(f"{t}  (created in {tables[t]})" for t in unaccounted)
        + "\n\nProve a direct delete, a schema-backed cascade, a specialized cleanup "
        "path, or a justified retained-table contract."
    )

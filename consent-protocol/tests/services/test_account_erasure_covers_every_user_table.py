"""Every user-keyed table is erased on account deletion, or explicitly kept with a reason.

WHY THIS EXISTS

Account deletion is a promise, and its delete map is hand-maintained. Measured against
the live dev catalog on 2026-09-04 it covered 67 of 106 user-keyed tables: a deleted
person's rows survived in dozens of places, and among them the personal-agent registry
row kept a live, billing pod running. That same surviving row squatted the HusshID
derived from the person's phone number, so the next owner of that number could not be
provisioned at all -- which is precisely how a real signup was lost during a demo, with
the API still answering `agentScheduled: true`.

Closing the list once does not hold it closed. A table added next quarter with a
`user_id` column and no delete predicate reintroduces the same leak in silence.

So the expectation is DERIVED, not listed. The migration SQL in `db/migrations/` (including the
dev-only `parked/` tree) is the only place a table can come into existence, so this
test reads both, keeps every table
that declares a `user_id` or `owner_user_id` column and is not dropped by a later
migration, and requires each one to be either erased by `AccountService` or named in
`ACCOUNT_ERASURE_RETAINED_TABLES` with a stated reason. Adding a table without deciding
which it is fails here, at the moment the migration lands.
"""

from __future__ import annotations

import pathlib
import re

from hushh_mcp.services.account_service import ACCOUNT_ERASURE_RETAINED_TABLES

SERVICE_ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = SERVICE_ROOT / "db" / "migrations"
ACCOUNT_SERVICE = SERVICE_ROOT / "hushh_mcp" / "services" / "account_service.py"

_CREATE = re.compile(
    r'CREATE TABLE (?:IF NOT EXISTS )?"?([a-z_0-9]+)"?\s*\((.*?)\n\)\s*;', re.S | re.I
)
_USER_KEY = re.compile(r'^\s*"?(user_id|owner_user_id)"?\s', re.M | re.I)
_DROP = re.compile(r'DROP TABLE (?:IF EXISTS )?"?([a-z_0-9]+)"?', re.I)


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


def _erased_tables() -> set[str]:
    """Every table account deletion issues a DELETE against, including raw SQL."""
    return set(re.findall(r"DELETE FROM (\w+)", ACCOUNT_SERVICE.read_text(encoding="utf-8")))


def test_the_migration_scan_finds_a_real_population() -> None:
    """Guard the guard: a broken regex would make this test vacuously pass."""
    tables = _user_keyed_tables()
    assert len(tables) > 80, (
        f"only {len(tables)} user-keyed tables parsed from {MIGRATIONS}; the scan is "
        "broken and this suite would pass while proving nothing"
    )
    assert "personal_agent_registry" in tables
    assert _erased_tables(), "no DELETE statements parsed from account_service.py"


def test_every_retained_table_states_a_reason() -> None:
    """A retained table is a deliberate exception, so it must justify itself in prose."""
    for table, reason in ACCOUNT_ERASURE_RETAINED_TABLES.items():
        assert isinstance(reason, str) and len(reason.strip()) > 20, (
            f"{table} survives deletion with no stated reason. A retained table is a "
            "promise not kept unless it says why."
        )


def test_retained_tables_are_never_also_erased() -> None:
    """The two registries must not disagree about the same table."""
    overlap = _erased_tables() & set(ACCOUNT_ERASURE_RETAINED_TABLES)
    assert not overlap, f"tables both erased and declared retained: {sorted(overlap)}"


def test_no_user_keyed_table_is_silently_left_behind() -> None:
    """Erased, or a stated exception. Never neither."""
    tables = _user_keyed_tables()
    unaccounted = sorted(set(tables) - _erased_tables() - set(ACCOUNT_ERASURE_RETAINED_TABLES))
    assert not unaccounted, (
        "these tables carry a person's key but are neither erased on account deletion "
        "nor declared retained, so a deleted person's rows would survive in them:\n  "
        + "\n  ".join(f"{t}  (created in {tables[t]})" for t in unaccounted)
        + "\n\nEither add a DELETE predicate to AccountService._delete_by_user_queries and "
        "wire it into _clear_user_data_tables, or add the table to "
        "ACCOUNT_ERASURE_RETAINED_TABLES with the reason it must survive."
    )

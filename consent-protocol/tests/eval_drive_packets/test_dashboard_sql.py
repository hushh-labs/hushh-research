"""The dashboard reads UAT read-only and only for its one owner.

Static: every registered statement is one plain read, every owner-scoped table it
names is bound with ``<alias>.user_id=:owner``, and the few tables without an
owner column are reached only through a declared join to an owner-bound alias.
Runtime: the engine fence refuses writes and unbound reads before they reach the
database, and a session whose transaction is not read-only fails closed.
Synthetic owner ids only.
"""

import re

import pytest

from hushh_eval.drive_packets.dashboard import queries
from hushh_eval.drive_packets.dashboard.queries import (
    IDENTITY_COLUMNS,
    JOIN_SCOPED_TABLES,
    OWNER_SCOPED_TABLES,
    STATEMENTS,
    OwnerScopedReader,
    OwnerSession,
    check_statement,
    install_guards,
)
from hushh_eval.drive_packets.sources import ReadOnlyViolation

OWNER = "owner-synthetic-0001"
OTHER = "owner-synthetic-0002"
TABLE_REF = re.compile(r"\b(?:FROM|JOIN)\s+([a-z_]+)\s+([a-z][a-z0-9]*)\b", re.IGNORECASE)
KEYWORDS = {"on", "where", "join", "left", "inner", "group", "order", "limit", "as", "and"}


def references(sql: str) -> list[tuple[str, str]]:
    found = []
    for table, alias in TABLE_REF.findall(sql):
        assert alias.lower() not in KEYWORDS, f"table {table} has no alias"
        found.append((table, alias))
    return found


def owner_bound(sql: str, alias: str) -> bool:
    return re.search(rf"\b{alias}\.user_id\s*=\s*:owner\b", sql) is not None


@pytest.mark.parametrize("name", sorted(STATEMENTS))
def test_every_table_in_every_statement_is_bound_to_the_owner(name):
    sql = STATEMENTS[name]
    refs = references(sql)
    assert refs, name
    aliases = [alias for _, alias in refs]
    assert len(aliases) == len(set(aliases)), f"{name}: aliases must be unique"
    bound = {
        alias for table, alias in refs if table in OWNER_SCOPED_TABLES and owner_bound(sql, alias)
    }
    for table, alias in refs:
        if table in OWNER_SCOPED_TABLES:
            assert alias in bound, f"{name}: {table} {alias} is not bound to :owner"
            continue
        assert table in JOIN_SCOPED_TABLES, f"{name}: {table} is neither owner- nor join-scoped"
        column, other_column = JOIN_SCOPED_TABLES[table]
        joined = any(
            re.search(rf"\b{alias}\.{column}\s*=\s*{other}\.{other_column}\b", sql)
            or re.search(rf"\b{other}\.{other_column}\s*=\s*{alias}\.{column}\b", sql)
            for other in bound
        )
        assert joined, f"{name}: {table} {alias} is not joined to an owner-bound alias"
        allowed = IDENTITY_COLUMNS.get(table)
        if allowed is not None:
            used = set(re.findall(rf"\b{alias}\.([a-z_]+)", sql))
            assert used <= allowed, f"{name}: {table} reads {sorted(used - allowed)}"
    assert ":owner" in sql


@pytest.mark.parametrize("name", sorted(STATEMENTS))
def test_every_statement_passes_the_read_only_fence(name):
    check_statement(STATEMENTS[name], {"owner": OWNER}, OWNER)


def test_identity_table_is_read_for_display_names_only():
    reads = [sql for sql in STATEMENTS.values() if "actor_identity_cache" in sql]
    assert reads, "requests show the requester's display name"
    for sql in reads:
        assert not re.search(r"\b(?:email|phone_number|photo_url)\b", sql)


@pytest.mark.parametrize(
    "statement",
    [
        "INSERT INTO drive_packet_heads (user_id) VALUES (:owner)",
        "UPDATE drive_packet_heads SET dirty=true WHERE user_id=:owner",
        "DELETE FROM drive_packet_heads WHERE user_id=:owner",
        "WITH x AS (DELETE FROM drive_packet_heads WHERE user_id=:owner RETURNING 1) SELECT * FROM x",
        "SELECT * FROM drive_packet_heads h WHERE h.user_id=:owner FOR UPDATE",
        "SELECT * FROM drive_packet_heads h WHERE h.user_id=:owner FOR SHARE",
        "SELECT 1; DELETE FROM drive_packet_heads",
        "SELECT set_config('transaction_read_only', 'off', false) WHERE :owner = :owner",
        "TRUNCATE drive_packet_heads",
        "SELECT * INTO copy_table FROM drive_packet_heads h WHERE h.user_id=:owner",
    ],
)
def test_the_fence_refuses_every_write(statement):
    with pytest.raises(ReadOnlyViolation):
        check_statement(statement, {"owner": OWNER}, OWNER)


def test_the_fence_refuses_a_read_without_the_owner_id():
    sql = "SELECT count(*) FROM drive_packet_heads h WHERE h.user_id=:owner"
    with pytest.raises(ReadOnlyViolation, match="statement_not_owner_bound"):
        check_statement(sql, {"owner": OTHER}, OWNER)
    with pytest.raises(ReadOnlyViolation, match="statement_not_owner_bound"):
        check_statement("SELECT count(*) FROM drive_packet_heads", {}, OWNER)


def test_engine_fence_stops_writes_before_the_database():
    sqlalchemy = pytest.importorskip("sqlalchemy")
    engine = sqlalchemy.create_engine("sqlite://")
    with engine.connect() as connection:
        connection.exec_driver_sql("CREATE TABLE drive_packet_heads (user_id TEXT, dirty INTEGER)")
        connection.commit()
    install_guards(engine, OWNER)
    statements = [
        "INSERT INTO drive_packet_heads (user_id, dirty) VALUES (:owner, 1)",
        "UPDATE drive_packet_heads SET dirty=0 WHERE user_id=:owner",
        "DELETE FROM drive_packet_heads WHERE user_id=:owner",
    ]
    with engine.connect() as connection:
        for statement in statements:
            with pytest.raises(ReadOnlyViolation):
                connection.execute(sqlalchemy.text(statement), {"owner": OWNER})
        rows = connection.execute(
            sqlalchemy.text("SELECT count(*) FROM drive_packet_heads h WHERE h.user_id=:owner"),
            {"owner": OWNER},
        ).scalar_one()
    assert rows == 0  # nothing reached the table
    with pytest.raises(ReadOnlyViolation, match="engine_bound_to_another_owner"):
        install_guards(engine, OTHER)


class Result:
    def __init__(self, value):
        self.value = value

    def scalar_one(self):
        return self.value

    def mappings(self):
        return []


class Connection:
    """Records statements; reports the configured transaction_read_only value."""

    def __init__(self, read_only: str):
        self.read_only = read_only
        self.executed: list[str] = []
        self.rolled_back = False

    def exec_driver_sql(self, statement):
        self.executed.append(statement)

    def execute(self, statement, params=None):
        text = str(statement)
        self.executed.append(text)
        if "transaction_read_only" in text:
            return Result(self.read_only)
        return Result(None)

    def rollback(self):
        self.rolled_back = True

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class Engine:
    def __init__(self, read_only: str):
        self.connection = Connection(read_only)
        self._dashboard_owner = OWNER  # guards already installed for this owner

    def connect(self):
        return self.connection


def test_a_session_that_is_not_read_only_fails_closed():
    engine = Engine("off")
    reader = OwnerScopedReader(engine, OWNER)
    with pytest.raises(ReadOnlyViolation, match="transaction_read_only_off"):
        with reader.session() as db:
            db.all("packet_states")
    assert engine.connection.executed[0] == queries.SET_READ_ONLY
    assert not any("drive_packet_heads" in item for item in engine.connection.executed)
    assert engine.connection.rolled_back


def test_a_read_only_session_runs_registered_statements_bound_to_the_owner():
    engine = Engine("on")
    reader = OwnerScopedReader(engine, OWNER)
    with reader.session() as db:
        assert db.all("packet_states") == []
        with pytest.raises(ReadOnlyViolation, match="owner_parameter_reserved"):
            db.all("packet_states", owner=OTHER)
        with pytest.raises(ReadOnlyViolation, match="statement_not_registered"):
            db.all("SELECT 1")
    assert any("drive_packet_heads" in item for item in engine.connection.executed)


def test_reader_refuses_a_malformed_owner_id():
    with pytest.raises(ReadOnlyViolation, match="owner_id_invalid"):
        OwnerScopedReader(Engine("on"), "x")
    with pytest.raises(ReadOnlyViolation, match="owner_id_invalid"):
        OwnerScopedReader(Engine("on"), "bad id; drop")


def test_owner_session_injects_the_owner_itself():
    seen = {}

    class Recorder:
        def execute(self, _statement, params):
            seen.update(params)
            return Result(None)

    OwnerSession(Recorder(), OWNER).all(
        "request_exists", request_id="00000000-0000-0000-0000-000000000001"
    )
    assert seen["owner"] == OWNER

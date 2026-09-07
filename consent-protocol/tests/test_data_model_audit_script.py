from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "ops" / "data_model_audit.py"
SPEC = importlib.util.spec_from_file_location("data_model_audit", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
data_model_audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(data_model_audit)


def _fake_live_connection(monkeypatch, *, rows=(), error_at=None, pgcode=None):
    calls = []

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            calls.append(("cursor_closed",))

        def execute(self, query):
            calls.append(("execute", query))
            if error_at == "query":
                error = RuntimeError("private-query-payload-sentinel")
                error.pgcode = pgcode
                raise error

        def fetchall(self):
            return rows

    class Connection:
        def set_session(self, **kwargs):
            calls.append(("session", kwargs))
            if error_at == "session":
                raise RuntimeError("private-session-payload-sentinel")

        def cursor(self):
            return Cursor()

        def close(self):
            calls.append(("connection_closed",))

    def connect(*args, **kwargs):
        calls.append(("connect", args, kwargs))
        if error_at == "connect":
            raise RuntimeError("private-connection-payload-sentinel")
        return Connection()

    monkeypatch.setitem(sys.modules, "psycopg2", SimpleNamespace(connect=connect))
    return calls


def test_live_catalog_is_explicitly_opt_in_and_missing_driver_is_unavailable(monkeypatch):
    monkeypatch.setitem(sys.modules, "psycopg2", None)
    assert data_model_audit._live_stats(None)["status"] == "not_requested"
    for missing in ("", " "):
        result = data_model_audit._live_stats(missing)
        assert result["status"] == "unavailable"
        assert result["reason"] == "configuration_unavailable"
    assert data_model_audit._live_stats("synthetic-private-dsn")["reason"] == "driver_unavailable"


@pytest.mark.parametrize("rows", [[], [("public", "pkm_blobs", 3, 16384)]])
def test_live_catalog_uses_bounded_readonly_connection_and_closes_it(monkeypatch, rows):
    calls = _fake_live_connection(monkeypatch, rows=rows)
    result = data_model_audit._live_stats("synthetic-private-dsn")
    assert result["status"] == "verified"
    assert len(result["rows"]) == len(rows)
    assert "synthetic-private-dsn" not in json.dumps(result)
    assert calls[0][0:2] == ("connect", ("synthetic-private-dsn",))
    options = calls[0][2]
    assert options["connect_timeout"] == 5
    for bound in (
        "default_transaction_read_only=on",
        "statement_timeout=10000",
        "lock_timeout=1000",
        "idle_in_transaction_session_timeout=15000",
        "search_path=pg_catalog",
    ):
        assert bound in options["options"]
    assert calls[1] == (
        "session",
        {
            "readonly": True,
            "isolation_level": "REPEATABLE READ",
            "autocommit": False,
        },
    )
    assert "FROM pg_catalog.pg_stat_user_tables" in calls[2][1]
    assert "LIMIT 25" in calls[2][1]
    assert calls[-1] == ("connection_closed",)


@pytest.mark.parametrize(
    "error_at,reason",
    [
        ("connect", "connection_unavailable"),
        ("session", "query_unavailable"),
        ("query", "query_unavailable"),
    ],
)
def test_live_failure_is_sanitized_and_never_an_empty_success(monkeypatch, error_at, reason):
    calls = _fake_live_connection(monkeypatch, error_at=error_at)
    result = data_model_audit._live_stats("synthetic-private-dsn")
    assert result["status"] == "unavailable"
    assert result["reason"] == reason
    assert result["rows"] == []
    assert "private" not in json.dumps(result)
    if error_at != "connect":
        assert calls[-1] == ("connection_closed",)


@pytest.mark.parametrize(
    "row",
    [
        ("public", "pkm_blobs", 1),
        ("other", "pkm_blobs", 1, 3),
        ("public", "", 1, 3),
        ("public", "pkm_blobs", -1, 3),
        ("public", "pkm_blobs", True, 3),
        ("public", "pkm_blobs", "1", 3),
    ],
)
def test_live_catalog_rejects_malformed_results_without_partial_evidence(monkeypatch, row):
    calls = _fake_live_connection(monkeypatch, rows=[("public", "valid", 1, 3), row])
    result = data_model_audit._live_stats("synthetic-private-dsn")
    assert result["status"] == "unavailable"
    assert result["reason"] == "invalid_result"
    assert result["rows"] == []
    assert calls[-1] == ("connection_closed",)


def test_live_catalog_refuses_unbounded_result(monkeypatch):
    _fake_live_connection(monkeypatch, rows=[("public", "table", 1, 3)] * 26)
    assert data_model_audit._live_stats("synthetic-private-dsn")["reason"] == "invalid_result"


@pytest.mark.parametrize(
    "code,reason",
    [
        ("57014", "query_cancelled_or_timed_out"),
        ("55P03", "lock_unavailable"),
        ("private-unknown-code", "query_unavailable"),
    ],
)
def test_live_query_error_codes_are_mapped_without_diagnostics(monkeypatch, code, reason):
    _fake_live_connection(monkeypatch, error_at="query", pgcode=code)
    result = data_model_audit._live_stats("synthetic-private-dsn")
    assert result["reason"] == reason
    assert result["status"] == "unavailable"
    assert "private" not in json.dumps(result)


def test_missing_requested_database_fails_report_and_retains_static_results():
    report, code = data_model_audit.build_report(database_url="")
    assert code == 1
    assert report["migration_table_count"] > 0
    assert report["live_stats"] == []
    assert report["live_observation"]["status"] == "unavailable"
    assert "live_observation_unavailable:configuration_unavailable" in report["failures"]


@pytest.mark.parametrize("present", [True, False])
def test_cli_environment_reference_never_emits_connection_value(monkeypatch, capsys, present):
    monkeypatch.setattr(
        sys, "argv", ["data_model_audit.py", "--json", "--database-url-env", "AUDIT_TEST_DSN"]
    )
    if present:
        monkeypatch.setenv("AUDIT_TEST_DSN", "synthetic-private-dsn")
    else:
        monkeypatch.delenv("AUDIT_TEST_DSN", raising=False)
    calls = _fake_live_connection(monkeypatch, rows=[])
    code = data_model_audit.main()
    printed = capsys.readouterr()
    assert "synthetic-private-dsn" not in printed.out + printed.err
    report = json.loads(printed.out)
    assert report["live_observation"]["status"] == ("verified" if present else "unavailable")
    if not present:
        assert code == 1
        assert not calls


def _table_events(sql: str) -> list[tuple[str | None, str | None]]:
    code = data_model_audit._strip_sql_comments_and_literals(sql)
    return [
        (match.group("create"), match.group("drop"))
        for match in data_model_audit.TABLE_EVENT_RE.finditer(code)
    ]


def test_migration_inventory_ignores_comments_and_string_literals() -> None:
    sql = """
    -- CREATE TABLE safety net prose must not be schema.
    /* DROP TABLE real_table; /* CREATE TABLE nested_comment; */ */
    CREATE EVENT TRIGGER refresh_guards
      WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'ALTER TABLE');
    """

    assert _table_events(sql) == []


def test_migration_inventory_keeps_dynamic_ddl_but_ignores_its_comments() -> None:
    sql = """
    CREATE FUNCTION install_guard() RETURNS void AS $guard$
    BEGIN
      EXECUTE 'CREATE TABLE dynamic_table (id bigint)';
      -- CREATE TABLE comment_table (id bigint);
    END;
    $guard$ LANGUAGE plpgsql;
    """

    assert _table_events(sql) == [("dynamic_table", None)]


def test_migration_inventory_keeps_real_create_and_drop_statements() -> None:
    sql = """
    CREATE TABLE IF NOT EXISTS public.account_rows (id bigint);
    DROP TABLE IF EXISTS public.retired_rows;
    """

    assert _table_events(sql) == [("account_rows", None), (None, "retired_rows")]


def test_live_migration_inventory_has_no_prose_tables_and_keeps_dynamic_tables() -> None:
    tables = data_model_audit._migration_tables()

    assert "AS" not in tables
    assert "safety" not in tables
    assert "pkm_data" in tables
    assert "pkm_embeddings" in tables

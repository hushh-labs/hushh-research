from __future__ import annotations

import importlib.util
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "ops" / "data_model_audit.py"
SPEC = importlib.util.spec_from_file_location("data_model_audit", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
data_model_audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(data_model_audit)


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

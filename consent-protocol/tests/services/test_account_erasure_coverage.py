"""Every account-identity table must be deleted, FK-covered, or explicitly declared.

The schema is rebuilt statically from the legacy baseline, ``db/migrate.py``,
release migrations, and parked migrations. A table is "identity-bearing" when a
column matches the migration-201 write-guard pattern (the same definition the
database uses to block writes for a deleted account).

A table counts as DELETED when a ``DELETE`` in the full-account erasure path
targets it, or when each of its identity columns sits in a foreign key to a
DELETED table: CASCADE removes those rows, and RESTRICT/NO ACTION makes the
parent delete fail (rolling back the whole erasure) if any remained. Everything
else must be declared in ``hushh_mcp.services.account_erasure_policy``.

If this reports a new table: add it to the full-deletion path (preferred) or
declare it with the reason it is retained.

CI burn-in: this is a new repository-wide check, so it is ADVISORY. Findings are
reported as ``AccountErasureCoverageAdvisory`` warnings and never fail the run.
Enforcement is a deliberate code change (``ENFORCED = True``) that needs at
least seven days of reliable results and maintainer approval; the earliest date
alone never enables it. ``ACCOUNT_ERASURE_COVERAGE_ENFORCE=1`` runs it strictly
on a developer machine.
"""

from __future__ import annotations

import ast
import json
import os
import re
import warnings
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from hushh_mcp.services.account_erasure_policy import (
    ACCOUNT_ERASURE_DECLARATIONS,
    ANONYMIZED_ON_ACCOUNT_DELETION,
    RETAINED_ON_ACCOUNT_DELETION,
)

BURN_IN = {
    "owner": "account deletion / data-plane governance (consent-protocol)",
    "introduced": "2026-09-27",
    "earliest_enforcement": "2026-10-04",
}
ENFORCED = False


class AccountErasureCoverageAdvisory(UserWarning):
    """A coverage finding reported while the check is in CI burn-in."""


def report(problem: object) -> None:
    """Fail when enforced; otherwise surface a visible warning and continue."""
    if not problem:
        return
    message = f"[account-erasure-coverage advisory until enforced] {problem}"
    if ENFORCED or os.getenv("ACCOUNT_ERASURE_COVERAGE_ENFORCE") == "1":
        pytest.fail(message)
    warnings.warn(AccountErasureCoverageAdvisory(message), stacklevel=2)


BACKEND_ROOT = Path(__file__).resolve().parents[2]
DB_ROOT = BACKEND_ROOT / "db"

# Mirrors install_account_deletion_write_guards() in migration 201.
IDENTITY_COLUMN = re.compile(
    r"(^user_id$|^firebase_uid$|^user_[a-z0-9]+_id$|_user_id$|_firebase_uid$)"
)
# Migration 201 also guards this raw-UID column explicitly.
EXTRA_IDENTITY_COLUMNS = {"consent_audit_receipts": {"subject_id"}}

# Every function whose SQL runs inside the full-account erasure transaction.
ERASURE_METHODS = (
    "_delete_full_account_transaction",
    "_assert_personal_agent_external_resources_absent",
    "_delete_full_account",
    "_delete_personal_agent_state",
    "_delete_one_referral_graph",
    "_delete_owned_named_circles",
)
# Connector erasure, including private MCP registrations, called in the same
# transaction by AccountService._clear_external_connector_data.
DRIVE_ERASURE = (
    "hushh_mcp/services/drive_sharing_retention.py",
    ("erase_drive_account_in_transaction", "_erase_private_connector_registrations"),
)

_TABLE_CONSTRAINT_HEADS = {"constraint", "primary", "unique", "check", "foreign", "exclude", "like"}
_REFERENCES = re.compile(r"REFERENCES\s+([\w.\"]+)\s*(?:\(([^)]*)\))?(.*)", re.I | re.S)
_ON_DELETE = re.compile(
    r"ON\s+DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)", re.I
)


@dataclass(frozen=True)
class ForeignKey:
    columns: tuple[str, ...]
    parent: str
    on_delete: str


@dataclass
class Table:
    columns: set[str] = field(default_factory=set)
    foreign_keys: dict[str, ForeignKey] = field(default_factory=dict)


def _ident(token: str) -> str:
    return token.strip().strip('"').split(".")[-1].strip('"').lower()


def _strip_comments(sql: str) -> str:
    sql = re.sub(r"/\*.*?\*/", "", sql, flags=re.S)
    return re.sub(r"--[^\n]*", "", sql)


def _closing_paren(sql: str, start: int) -> int:
    depth, quoted = 0, False
    for index in range(start, len(sql)):
        char = sql[index]
        if char == "'":
            quoted = not quoted
        if quoted:
            continue
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return index
    raise ValueError("unbalanced parentheses in DDL")


def _split_top_level(body: str) -> list[str]:
    parts, current, depth, quoted = [], [], 0, False
    for char in body:
        if char == "'":
            quoted = not quoted
        if not quoted:
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
            elif char == "," and depth == 0:
                parts.append("".join(current).strip())
                current = []
                continue
        current.append(char)
    if "".join(current).strip():
        parts.append("".join(current).strip())
    return parts


class Schema:
    _STATEMENT = re.compile(
        r"\b(CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.\"]+)\s*\("
        r"|ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([\w.\"]+)\s+"
        r"|DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?)",
        re.I,
    )

    def __init__(self) -> None:
        self.tables: dict[str, Table] = {}

    def _add_foreign_key(self, table: str, name: str, columns, reference: re.Match) -> None:
        action = _ON_DELETE.search(reference.group(3) or "")
        self.tables[table].foreign_keys[name] = ForeignKey(
            columns=tuple(columns),
            parent=_ident(reference.group(1)),
            on_delete=re.sub(r"\s+", " ", action.group(1).upper()) if action else "NO ACTION",
        )

    def _element(self, table: str, element: str) -> None:
        head = element.split(None, 1)[0].strip('"').lower()
        if head in _TABLE_CONSTRAINT_HEADS:
            match = re.match(
                r"(?:CONSTRAINT\s+(\"?\w+\"?)\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*(REFERENCES.*)",
                element,
                re.I | re.S,
            )
            if match:
                columns = [
                    column.strip().strip('"').lower() for column in match.group(2).split(",")
                ]
                name = (match.group(1) or f"{table}_{'_'.join(columns)}_fkey").strip('"').lower()
                self._add_foreign_key(table, name, columns, _REFERENCES.search(match.group(3)))
            return
        self.tables[table].columns.add(head)
        reference = _REFERENCES.search(element)
        if reference:
            named = re.search(r"CONSTRAINT\s+(\"?\w+\"?)\s+REFERENCES", element, re.I)
            name = (named.group(1) if named else f"{table}_{head}_fkey").strip('"').lower()
            self._add_foreign_key(table, name, [head], reference)

    def _alter(self, table: str, statement: str) -> None:
        rename = re.match(r"\s*RENAME\s+TO\s+(\"?\w+\"?)", statement, re.I)
        if rename:
            self.tables[_ident(rename.group(1))] = self.tables.pop(table)
            return
        definition = self.tables[table]
        for action in _split_top_level(statement):
            if match := re.match(
                r"ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(.*)", action, re.I | re.S
            ):
                self._element(table, match.group(1))
            elif match := re.match(r"ADD\s+((?:CONSTRAINT|FOREIGN)\s+.*)", action, re.I | re.S):
                self._element(table, match.group(1))
            elif match := re.match(
                r"DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(\"?\w+\"?)", action, re.I
            ):
                definition.foreign_keys.pop(_ident(match.group(1)), None)
            elif match := re.match(r"DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(\"?\w+\"?)", action, re.I):
                column = _ident(match.group(1))
                definition.columns.discard(column)
                definition.foreign_keys = {
                    name: fk
                    for name, fk in definition.foreign_keys.items()
                    if column not in fk.columns
                }
            elif match := re.match(
                r"RENAME\s+(?:COLUMN\s+)?(\"?\w+\"?)\s+TO\s+(\"?\w+\"?)", action, re.I
            ):
                old, new = _ident(match.group(1)), _ident(match.group(2))
                if old in definition.columns:
                    definition.columns.discard(old)
                    definition.columns.add(new)
                definition.foreign_keys = {
                    name: ForeignKey(
                        tuple(new if column == old else column for column in fk.columns),
                        fk.parent,
                        fk.on_delete,
                    )
                    for name, fk in definition.foreign_keys.items()
                }

    def apply(self, sql: str) -> Schema:
        sql = _strip_comments(sql)
        position = 0
        while match := self._STATEMENT.search(sql, position):
            if match.group(2):
                table = _ident(match.group(2))
                opening = match.end() - 1
                closing = _closing_paren(sql, opening)
                self.tables.setdefault(table, Table())
                for element in _split_top_level(sql[opening + 1 : closing]):
                    self._element(table, element)
                position = closing + 1
                continue
            end = sql.find(";", match.end())
            end = len(sql) if end < 0 else end
            statement = sql[match.end() : end]
            position = end + 1
            if match.group(3):
                table = _ident(match.group(3))
                if table in self.tables:
                    self._alter(table, statement)
            else:
                names = re.sub(r"\b(CASCADE|RESTRICT)\b", "", statement, flags=re.I)
                for name in names.split(","):
                    if name.strip():
                        self.tables.pop(_ident(name), None)
        return self

    def identity_columns(self, table: str) -> set[str]:
        columns = {
            column for column in self.tables[table].columns if IDENTITY_COLUMN.search(column)
        }
        return columns | (EXTRA_IDENTITY_COLUMNS.get(table, set()) & self.tables[table].columns)


def load_schema() -> Schema:
    schema = Schema()
    schema.apply((DB_ROOT / "legacy" / "init_legacy_schema.sql").read_text(encoding="utf-8"))
    for node in ast.walk(ast.parse((DB_ROOT / "migrate.py").read_text(encoding="utf-8"))):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if "CREATE TABLE" in node.value.upper():
                schema.apply(node.value)
    for directory in (DB_ROOT / "migrations", DB_ROOT / "migrations" / "parked"):
        for migration in sorted(directory.glob("*.sql")):
            schema.apply(migration.read_text(encoding="utf-8"))
    return schema


def _string_constants(node: ast.AST) -> list[str]:
    return [
        child.value
        for child in ast.walk(node)
        if isinstance(child, ast.Constant) and isinstance(child.value, str)
    ]


def erasure_delete_targets() -> set[str]:
    """Tables named by a DELETE anywhere in the full-account erasure path."""
    source = (BACKEND_ROOT / "hushh_mcp/services/account_service.py").read_text(encoding="utf-8")
    account_service = next(
        node
        for node in ast.parse(source).body
        if isinstance(node, ast.ClassDef) and node.name == "AccountService"
    )
    methods = {
        node.name: node
        for node in account_service.body
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
    }
    # Keys of the whitelisted per-table delete queries resolve to their SQL.
    keyed_sql: dict[str, str] = {}
    for node in ast.walk(methods["__init__"]):
        if isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values, strict=True):
                if isinstance(key, ast.Constant) and isinstance(value, ast.Call):
                    keyed_sql[key.value] = keyed_sql.get(key.value, "") + " ".join(
                        _string_constants(value)
                    )
    fragments: list[str] = []
    for method in ERASURE_METHODS:
        for constant in _string_constants(methods[method]):
            fragments.append(constant)
            fragments.append(keyed_sql.get(constant, ""))
    drive_path, drive_functions = DRIVE_ERASURE
    drive_tree = ast.parse((BACKEND_ROOT / drive_path).read_text(encoding="utf-8"))
    for node in drive_tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in drive_functions:
            fragments.extend(_string_constants(node))
    return {
        name.lower() for name in re.findall(r"\bDELETE\s+FROM\s+(\w+)", "\n".join(fragments), re.I)
    }


def uncovered_identity_tables(
    schema: Schema, deleted: set[str], declared: set[str]
) -> dict[str, list[str]]:
    covered = {table for table in deleted if table in schema.tables}
    identity = {table: schema.identity_columns(table) for table in schema.tables}
    changed = True
    while changed:
        changed = False
        for table, columns in identity.items():
            if not columns or table in covered:
                continue
            foreign_keys = schema.tables[table].foreign_keys.values()
            # These writers copy both job_id and user_id from the same parent.
            # The executing erasure inventory test also checks their exact FK.
            if table in {"one_profile_discovery_events", "one_profile_discovery_feed_outbox"}:
                if columns == {"user_id"} and any(
                    fk.columns == ("job_id",)
                    and fk.parent == "one_profile_discovery_jobs"
                    and fk.parent in covered
                    and fk.on_delete == "CASCADE"
                    for fk in foreign_keys
                ):
                    covered.add(table)
                    changed = True
                    continue
            if all(
                any(
                    column in fk.columns
                    and fk.parent in covered
                    and fk.on_delete in {"CASCADE", "RESTRICT", "NO ACTION"}
                    for fk in foreign_keys
                )
                for column in columns
            ):
                covered.add(table)
                changed = True
    return {
        table: sorted(columns)
        for table, columns in sorted(identity.items())
        if columns and table not in covered and table not in declared
    }


def _declared_tables() -> dict[str, str]:
    declared: dict[str, str] = {}
    for category, tables in ACCOUNT_ERASURE_DECLARATIONS.items():
        for table in tables:
            if table in declared:
                report(f"{table} is declared as both {declared[table]} and {category}")
            declared[table] = category
    return declared


@pytest.fixture(scope="module")
def schema() -> Schema:
    try:
        return load_schema()
    except Exception as exc:  # A parser gap must not block unrelated work.
        report(f"schema could not be parsed: {type(exc).__name__}: {exc}")
        pytest.skip("account-erasure coverage: schema parse failed (advisory)")


@pytest.fixture(scope="module")
def deleted() -> set[str]:
    try:
        return erasure_delete_targets()
    except Exception as exc:
        report(f"erasure path could not be read: {type(exc).__name__}: {exc}")
        pytest.skip("account-erasure coverage: erasure path unreadable (advisory)")


def test_burn_in_is_recorded_and_not_enforced_yet():
    assert set(BURN_IN) == {"owner", "introduced", "earliest_enforcement"}
    assert ENFORCED is False


def test_schema_parser_matches_the_live_derived_uat_contract(schema):
    """The parser must see every table and column the UAT contract requires."""
    contract = json.loads(
        (DB_ROOT / "contracts" / "uat_integrated_schema.json").read_text(encoding="utf-8")
    )["required_tables"]
    report(sorted(set(contract) - set(schema.tables)))
    report(
        {
            table: sorted(set(columns) - schema.tables[table].columns)
            for table, columns in contract.items()
            if table in schema.tables and set(columns) - schema.tables[table].columns
        }
    )


def test_every_account_identity_table_is_deleted_or_declared(schema, deleted):
    uncovered = uncovered_identity_tables(schema, deleted, set(_declared_tables()))
    if uncovered:
        report(
            "Account deletion does not cover these identity-bearing tables. Add each to "
            "AccountService._delete_full_account, or declare why it survives in "
            f"hushh_mcp/services/account_erasure_policy.py: {uncovered}"
        )


def test_declarations_are_current_and_consistent(schema, deleted):
    for table, category in _declared_tables().items():
        if table not in schema.tables:
            report(f"stale {category} declaration: {table} no longer exists")
            continue
        if not schema.identity_columns(table):
            report(f"{table} has no account identity column")
        if len(ACCOUNT_ERASURE_DECLARATIONS[category][table]) <= 40:
            report(f"{table} needs a concrete reason")
        if category == "deleted_with_owned_parent" and table not in deleted:
            report(f"{table} is declared deleted but no erasure DELETE names it")
        if category in {"retained", "anonymized"} and table in deleted:
            report(f"{table} is declared {category} but the erasure deletes it")


def test_intentional_retention_is_not_silently_changed():
    """Retention is a legal decision; changing it must be deliberate."""
    if set(RETAINED_ON_ACCOUNT_DELETION) != {"fabric_receipts", "hushh_tech_link_events"}:
        report(f"retained set changed: {sorted(RETAINED_ON_ACCOUNT_DELETION)}")
    if set(ANONYMIZED_ON_ACCOUNT_DELETION) != {"account_deletion_tombstones"}:
        report(f"anonymized set changed: {sorted(ANONYMIZED_ON_ACCOUNT_DELETION)}")


def _with_synthetic(ddl: str) -> Schema:
    schema = load_schema()
    schema.apply(ddl)
    return schema


def test_checker_flags_a_new_identity_table_without_erasure(deleted):
    uncovered = uncovered_identity_tables(
        _with_synthetic(
            """
            CREATE TABLE IF NOT EXISTS future_user_notes (
              note_id UUID PRIMARY KEY,
              owner_user_id TEXT NOT NULL,
              body TEXT
            );
            CREATE TABLE IF NOT EXISTS future_note_shares (
              share_id UUID PRIMARY KEY,
              recipient_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
              sharer_user_id TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS future_note_tags (
              tag_id UUID PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE
            );
            """
        ),
        deleted,
        set(_declared_tables()),
    )
    expected = {
        "future_note_shares": ["recipient_user_id", "sharer_user_id"],
        "future_user_notes": ["owner_user_id"],
    }
    if uncovered != expected:
        report(f"checker self-test drifted: {uncovered} != {expected}")


def test_checker_does_not_count_set_null_or_unrelated_cascade(deleted):
    uncovered = uncovered_identity_tables(
        _with_synthetic(
            """
            CREATE TABLE IF NOT EXISTS future_audit (
              audit_id UUID PRIMARY KEY,
              actor_user_id TEXT REFERENCES actor_profiles(user_id) ON DELETE SET NULL
            );
            CREATE TABLE IF NOT EXISTS future_child (
              child_id UUID PRIMARY KEY,
              intent_id TEXT REFERENCES connected_system_intents(intent_id) ON DELETE CASCADE,
              user_id TEXT NOT NULL
            );
            """
        ),
        deleted,
        set(_declared_tables()),
    )
    if set(uncovered) != {"future_audit", "future_child"}:
        report(f"checker self-test drifted: {sorted(uncovered)}")


def test_advisory_mode_warns_instead_of_failing(monkeypatch):
    monkeypatch.delenv("ACCOUNT_ERASURE_COVERAGE_ENFORCE", raising=False)
    with pytest.warns(AccountErasureCoverageAdvisory, match="future_user_notes"):
        report({"future_user_notes": ["owner_user_id"]})
    monkeypatch.setenv("ACCOUNT_ERASURE_COVERAGE_ENFORCE", "1")
    with pytest.raises(pytest.fail.Exception):
        report({"future_user_notes": ["owner_user_id"]})

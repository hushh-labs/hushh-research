"""Server-held Plaid custody retirement: the ops script and migration 239.

The script disconnects every stored Item at Plaid before deleting it. These
tests prove it is safe to run: a dry run touches nothing, execution refuses a
mismatched environment before any access, and no token or identifier reaches
the output. No real database or Plaid call is made.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from hushh_mcp.integrations.plaid import PlaidApiError
from hushh_mcp.runtime_settings import clear_runtime_settings_caches

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "ops" / "plaid_server_custody_retire.py"
SPEC = spec_from_file_location("plaid_server_custody_retire", SCRIPT)
assert SPEC and SPEC.loader
retire = module_from_spec(SPEC)
SPEC.loader.exec_module(retire)

PORTFOLIO_KEY = b"p" * 32
FUNDING_KEY = b"f" * 32
PORTFOLIO_TOKEN = "access-production-portfolio-SECRET-0001"
FUNDING_TOKEN = "access-production-funding-SECRET-0002"
FAILING_TOKEN = "access-production-portfolio-SECRET-0003"
GONE_TOKEN = "access-production-portfolio-SECRET-0004"
SANDBOX_TOKEN = "access-sandbox-portfolio-SECRET-0005"
ITEM_IDS = (
    "item-portfolio-A1",
    "item-portfolio-B2",
    "item-portfolio-C3",
    "item-funding-D4",
    "item-sandbox-F6",
)
USER_ID = "firebase-user-XYZ789"

DROPPED_TABLES = (
    "kai_plaid_items",
    "kai_plaid_refresh_runs",
    "kai_plaid_link_sessions",
    "kai_plaid_user_profile_cache",
    "kai_portfolio_source_preferences",
    "kai_funding_brokerage_accounts",
    "kai_funding_plaid_items",
    "kai_funding_plaid_accounts",
    "kai_funding_plaid_link_sessions",
    "kai_funding_consent_records",
    "kai_funding_ach_relationships",
    "kai_funding_transfers",
    "kai_funding_transfer_events",
    "kai_funding_webhook_events",
    "kai_funding_reconciliation_runs",
    "kai_funding_support_escalations",
    "kai_funding_alpaca_connect_sessions",
    "kai_funding_trade_intents",
    "kai_funding_trade_events",
)


def _envelope(token: str, key: bytes) -> dict[str, str]:
    nonce = os.urandom(12)
    sealed = AESGCM(key).encrypt(nonce, token.encode("utf-8"), None)
    return {
        "access_token_ciphertext": base64.urlsafe_b64encode(sealed[:-16]).decode(),
        "access_token_iv": base64.urlsafe_b64encode(nonce).decode(),
        "access_token_tag": base64.urlsafe_b64encode(sealed[-16:]).decode(),
    }


class FakeDb:
    """Routes execute_raw by SQL shape; records every statement."""

    def __init__(self) -> None:
        self.statements: list[str] = []
        self.tables: dict[str, list[dict[str, Any]]] = {
            "kai_plaid_items": [
                {
                    "item_id": ITEM_IDS[0],
                    "user_id": USER_ID,
                    "status": "active",
                    "plaid_env": "production",
                    **_envelope(PORTFOLIO_TOKEN, PORTFOLIO_KEY),
                },
                {
                    "item_id": ITEM_IDS[1],
                    "user_id": USER_ID,
                    "status": "error",
                    "plaid_env": "production",
                    **_envelope(FAILING_TOKEN, PORTFOLIO_KEY),
                },
                {
                    "item_id": ITEM_IDS[2],
                    "user_id": USER_ID,
                    "status": "active",
                    "plaid_env": "production",
                    **_envelope(GONE_TOKEN, PORTFOLIO_KEY),
                },
                {
                    "item_id": ITEM_IDS[4],
                    "user_id": USER_ID,
                    "status": "active",
                    "plaid_env": "sandbox",
                    **_envelope(SANDBOX_TOKEN, PORTFOLIO_KEY),
                },
                {
                    "item_id": "item-removed-E5",
                    "user_id": USER_ID,
                    "status": "removed",
                    "plaid_env": "production",
                    **_envelope("unused", PORTFOLIO_KEY),
                },
            ],
            "kai_funding_plaid_items": [
                {
                    "item_id": ITEM_IDS[3],
                    "user_id": USER_ID,
                    "status": "active",
                    "plaid_env": "production",
                    **_envelope(FUNDING_TOKEN, FUNDING_KEY),
                },
            ],
            "kai_funding_ach_relationships": [
                {"item_id": ITEM_IDS[3], "processor_token_ciphertext": "sealed"},
            ],
            "kai_funding_transfers": [],
            "kai_funding_trade_intents": [],
            "kai_funding_trade_events": [],
            "kai_funding_consent_records": [],
        }
        self.fail_delete_for: set[str] = set()

    def execute_raw(self, sql: str, params: dict | None = None) -> SimpleNamespace:
        self.statements.append(sql)
        params = params or {}
        compact = " ".join(sql.split())
        if "to_regclass" in compact:
            return SimpleNamespace(data=[{"present": params["name"] in self.tables}])
        if compact.startswith("SELECT COUNT(*)"):
            table = re.search(r"FROM (\w+)", compact).group(1)
            rows = self.tables.get(table, [])
            if "<> 'removed'" in compact:
                rows = [row for row in rows if row.get("status") != "removed"]
            return SimpleNamespace(data=[{"n": len(rows)}])
        if compact.startswith("SELECT EXISTS"):
            item_id = params["item_id"]
            has = any(
                row.get("item_id") == item_id or row.get("funding_item_id") == item_id
                for table in ("kai_funding_transfers", "kai_funding_trade_intents")
                for row in self.tables[table]
            )
            return SimpleNamespace(data=[{"has_records": has}])
        if compact.startswith("UPDATE"):
            table = re.search(r"UPDATE (\w+)", compact).group(1)
            for row in self.tables[table]:
                if row["item_id"] == params["item_id"]:
                    row["status"] = "removed"
            return SimpleNamespace(data=[])
        if compact.startswith("SELECT item_id"):
            table = re.search(r"FROM (\w+)", compact).group(1)
            return SimpleNamespace(data=[dict(row) for row in self.tables[table]])
        if compact.startswith("DELETE FROM"):
            if params.get("item_id") in self.fail_delete_for:
                raise RuntimeError(f"driver error for item_id={params['item_id']}")
            table = re.search(r"DELETE FROM (\w+)", compact).group(1)
            if table in self.tables and "item_id = :item_id" in compact:
                self.tables[table] = [
                    row for row in self.tables[table] if row["item_id"] != params["item_id"]
                ]
            return SimpleNamespace(data=[])
        raise AssertionError(f"unexpected SQL: {compact}")


class FakePlaid:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str | None]] = []

    async def __call__(self, path: str, payload: dict[str, Any], environment: str | None):
        token = payload["access_token"]
        self.calls.append((path, token, environment))
        if token == FAILING_TOKEN:
            raise PlaidApiError(
                message=f"bad {token}", status_code=400, error_code="INTERNAL_SERVER_ERROR"
            )
        if token == GONE_TOKEN:
            raise PlaidApiError(
                message=f"gone {token}", status_code=400, error_code="ITEM_NOT_FOUND"
            )
        return {"request_id": "req"}


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    # Deployed keys are url-safe base64 of 32 bytes, as the services decoded them.
    monkeypatch.setenv("PLAID_ACCESS_TOKEN_KEY", base64.urlsafe_b64encode(PORTFOLIO_KEY).decode())
    monkeypatch.setenv(
        "FUNDING_SECRET_ENCRYPTION_KEY", base64.urlsafe_b64encode(FUNDING_KEY).decode()
    )
    monkeypatch.setenv("PLAID_ENV", "production")
    monkeypatch.setenv("CLOUDSQL_INSTANCE_CONNECTION_NAME", "proj:region:uat-db")
    monkeypatch.setenv("DB_HOST", "127.0.0.1")
    monkeypatch.setenv("DB_NAME", "postgres")
    monkeypatch.setenv("PLAID_CLIENT_ID", "client-id-test")
    monkeypatch.setenv("PLAID_SECRET", "plaid-secret-test")
    clear_runtime_settings_caches()
    yield
    clear_runtime_settings_caches()


def _assert_nothing_sensitive(text: str) -> None:
    tokens = (PORTFOLIO_TOKEN, FUNDING_TOKEN, FAILING_TOKEN, GONE_TOKEN, SANDBOX_TOKEN)
    for secret in (*tokens, USER_ID, *ITEM_IDS):
        assert secret not in text
    assert "-SECRET-0" not in text
    assert "plaid-secret-test" not in text


def _fp() -> str:
    return retire.database_target()["fingerprint"]


def test_dry_run_counts_only_and_makes_no_plaid_call_or_write():
    db, plaid = FakeDb(), FakePlaid()
    report = asyncio.run(retire.run(execute=False, confirm_env=None, db=db, plaid_post=plaid))

    assert plaid.calls == []
    assert not any(stmt.lstrip().upper().startswith("DELETE") for stmt in db.statements)
    assert report["mode"] == "dry_run"
    assert report["before"]["kai_plaid_items"] == {"present": True, "rows": 5, "live": 4}
    assert report["before"]["kai_funding_plaid_items"] == {"present": True, "rows": 1, "live": 1}
    assert report["before"]["kai_funding_ach_relationships"]["processor_tokens"] == 1
    assert report["plaid_environment"] == "production"
    assert report["database_fingerprint"] == _fp()
    assert report["database_target"]["cloudsql_instance"] == "proj:region:uat-db"
    assert report["live_token_environments"]["kai_plaid_items"] == {"production": 3, "sandbox": 1}
    assert report["before"]["kai_funding_transfers"] == {"present": True, "rows": 0}
    assert report["keys"] == {
        "PLAID_ACCESS_TOKEN_KEY_set": True,
        "FUNDING_SECRET_ENCRYPTION_KEY_set": True,
    }
    _assert_nothing_sensitive(json.dumps(report))


@pytest.mark.parametrize("confirm_env", [None, "", "production", "dev"])
def test_execute_refuses_env_mismatch_before_any_access(confirm_env):
    db, plaid = FakeDb(), FakePlaid()
    with pytest.raises(retire.RetirementRefused):
        asyncio.run(
            retire.run(
                execute=True, confirm_env=confirm_env, confirm_db=_fp(), db=db, plaid_post=plaid
            )
        )
    assert db.statements == []
    assert plaid.calls == []


@pytest.mark.parametrize("confirm_db", [None, "", "0123456789ab"])
def test_execute_refuses_a_database_other_than_the_one_confirmed(confirm_db):
    db, plaid = FakeDb(), FakePlaid()
    with pytest.raises(retire.RetirementRefused, match="confirm-db"):
        asyncio.run(
            retire.run(
                execute=True, confirm_env="uat", confirm_db=confirm_db, db=db, plaid_post=plaid
            )
        )
    assert db.statements == []
    assert plaid.calls == []


def test_a_sandbox_pass_touches_only_sandbox_tokens(monkeypatch):
    monkeypatch.setenv("PLAID_ENV", "sandbox")
    clear_runtime_settings_caches()
    db, plaid = FakeDb(), FakePlaid()
    report = asyncio.run(
        retire.run(execute=True, confirm_env="uat", confirm_db=_fp(), db=db, plaid_post=plaid)
    )

    # Only the sandbox leftover was sent; every production token stays untouched.
    assert [token for _, token, _ in plaid.calls] == [SANDBOX_TOKEN]
    portfolio = report["results"]["kai_plaid_items"]
    assert portfolio["environment_mismatch_kept"] == 3
    remaining = {row["item_id"] for row in db.tables["kai_plaid_items"]}
    assert remaining == {ITEM_IDS[0], ITEM_IDS[1], ITEM_IDS[2]}


def test_main_returns_refused_exit_code_on_env_mismatch(capsys, monkeypatch):
    def _no_db():
        raise AssertionError("database must not be opened")

    monkeypatch.setattr("db.db_client.get_db", _no_db)
    assert retire.main(["--execute", "--confirm-env", "production", "--confirm-db", _fp()]) == 2
    assert "REFUSED" in capsys.readouterr().err


def test_execute_removes_at_plaid_deletes_rows_and_keeps_failures():
    db, plaid = FakeDb(), FakePlaid()
    report = asyncio.run(
        retire.run(execute=True, confirm_env="UAT", confirm_db=_fp(), db=db, plaid_post=plaid)
    )

    removed_tokens = {token for _, token, _ in plaid.calls}
    assert removed_tokens == {PORTFOLIO_TOKEN, FAILING_TOKEN, GONE_TOKEN, FUNDING_TOKEN}
    assert {path for path, _, _ in plaid.calls} == {"/item/remove"}

    portfolio = report["results"]["kai_plaid_items"]
    assert portfolio["removed_at_plaid"] == 1
    assert portfolio["already_gone_at_plaid"] == 1
    assert portfolio["already_removed_rows_deleted"] == 1
    assert portfolio["failed_kept"] == 1
    assert portfolio["environment_mismatch_kept"] == 1
    assert portfolio["plaid_error_codes"] == {"INTERNAL_SERVER_ERROR": 1, "ITEM_NOT_FOUND": 1}
    # The sandbox token was never sent to production Plaid, and its row stays.
    assert sorted(row["item_id"] for row in db.tables["kai_plaid_items"]) == [
        ITEM_IDS[1],
        ITEM_IDS[4],
    ]

    funding = report["results"]["kai_funding_plaid_items"]
    assert funding["removed_at_plaid"] == 1
    assert db.tables["kai_funding_plaid_items"] == []
    assert db.tables["kai_funding_ach_relationships"] == []
    assert report["after"]["kai_plaid_items"]["live"] == 2

    _assert_nothing_sensitive(json.dumps(report))

    # Idempotent: a rerun only retries the row Plaid refused.
    plaid_again = FakePlaid()
    asyncio.run(
        retire.run(execute=True, confirm_env="uat", confirm_db=_fp(), db=db, plaid_post=plaid_again)
    )
    assert [token for _, token, _ in plaid_again.calls] == [FAILING_TOKEN]


def test_main_output_and_logs_never_contain_tokens_or_ids(capsys, caplog, monkeypatch):
    db, plaid = FakeDb(), FakePlaid()
    monkeypatch.setattr("db.db_client.get_db", lambda: db)
    monkeypatch.setattr(retire, "_default_plaid_post", lambda _config: plaid)

    exit_code = retire.main(["--execute", "--confirm-env", "uat", "--confirm-db", _fp()])

    assert exit_code == 1  # one Item refused by Plaid, one from another environment
    captured = capsys.readouterr()
    _assert_nothing_sensitive(captured.out + captured.err + caplog.text)
    assert json.loads(captured.out)["mode"] == "execute"


def test_undecryptable_row_is_kept_and_reported_by_type_only(monkeypatch):
    monkeypatch.setenv("PLAID_ACCESS_TOKEN_KEY", "w" * 32)
    clear_runtime_settings_caches()
    db, plaid = FakeDb(), FakePlaid()
    report = asyncio.run(
        retire.run(execute=True, confirm_env="uat", confirm_db=_fp(), db=db, plaid_post=plaid)
    )

    portfolio = report["results"]["kai_plaid_items"]
    assert portfolio["failed_kept"] == 4
    assert portfolio["local_error_types"] == {"InvalidTag": 4}
    assert len(db.tables["kai_plaid_items"]) == 4
    _assert_nothing_sensitive(json.dumps(report))


def test_invalid_token_counts_as_gone_only_in_the_matching_environment():
    db = FakeDb()
    db.tables["kai_plaid_items"] = [db.tables["kai_plaid_items"][0]]

    async def invalid(path, payload, environment):
        raise PlaidApiError(message="x", status_code=400, error_code="INVALID_ACCESS_TOKEN")

    report = asyncio.run(
        retire.run(execute=True, confirm_env="uat", confirm_db=_fp(), db=db, plaid_post=invalid)
    )
    assert report["results"]["kai_plaid_items"]["already_gone_at_plaid"] == 1
    assert db.tables["kai_plaid_items"] == []


def test_funding_item_with_regulated_records_is_revoked_and_kept():
    db, plaid = FakeDb(), FakePlaid()
    db.tables["kai_funding_transfers"] = [{"item_id": ITEM_IDS[3]}]
    report = asyncio.run(
        retire.run(execute=True, confirm_env="uat", confirm_db=_fp(), db=db, plaid_post=plaid)
    )

    funding = report["results"]["kai_funding_plaid_items"]
    assert funding["removed_at_plaid"] == 1
    assert funding["rows_marked_removed"] == 1
    assert [row["status"] for row in db.tables["kai_funding_plaid_items"]] == ["removed"]
    assert db.tables["kai_funding_transfers"] == [{"item_id": ITEM_IDS[3]}]
    assert not any("kai_funding_transfers" in s and "DELETE" in s for s in db.statements)


def test_a_failed_delete_is_counted_and_the_run_continues():
    db, plaid = FakeDb(), FakePlaid()
    db.fail_delete_for = {ITEM_IDS[0]}
    report = asyncio.run(
        retire.run(execute=True, confirm_env="uat", confirm_db=_fp(), db=db, plaid_post=plaid)
    )

    portfolio = report["results"]["kai_plaid_items"]
    assert portfolio["local_error_types"] == {"delete:RuntimeError": 1}
    assert report["results"]["kai_funding_plaid_items"]["rows_deleted"] == 1
    _assert_nothing_sensitive(json.dumps(report))


def test_migration_239_refuses_while_live_items_or_regulated_records_remain():
    migration = (ROOT / "db/migrations/239_drop_server_plaid_custody.sql").read_text()
    guard = migration.index("DO $$")
    assert guard < migration.index("DROP TABLE")
    assert "status <> %L', t, 'removed'" in migration
    for table in ("kai_plaid_items", "kai_funding_plaid_items", *retire.REGULATED_FUNDING_TABLES):
        assert f"'{table}'" in migration[guard:], table
    assert migration.count("RAISE EXCEPTION") == 2


def test_migration_239_drops_every_server_custody_table_and_contracts_forget_them():
    migration = (ROOT / "db/migrations/239_drop_server_plaid_custody.sql").read_text()
    for table in DROPPED_TABLES:
        assert re.search(rf"DROP TABLE IF EXISTS {table}\b", migration), table

    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text())
    assert "239_drop_server_plaid_custody.sql" in manifest["ordered_migrations"]
    assert (
        manifest["rollback_migrations"]["239_drop_server_plaid_custody.sql"]
        == "rollback/239_drop_server_plaid_custody.rollback.sql"
    )
    rollback = (
        ROOT / "db/migrations/rollback/239_drop_server_plaid_custody.rollback.sql"
    ).read_text()
    for table in DROPPED_TABLES:
        if table == "kai_plaid_user_profile_cache":
            continue  # never created by a governed migration
        assert f"CREATE TABLE IF NOT EXISTS {table} (" in rollback, table

    for contract in (
        "prod_core_schema.json",
        "uat_integrated_schema.json",
        "dev_minimum_schema.json",
    ):
        text = (ROOT / "db/contracts" / contract).read_text()
        for table in DROPPED_TABLES:
            assert f'"{table}"' not in text, (contract, table)

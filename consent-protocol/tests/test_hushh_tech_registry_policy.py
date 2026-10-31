from __future__ import annotations

import base64
import copy
import importlib.util
import json
import stat
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from hushh_mcp.consent.connector_crypto_profiles import get_connector_crypto_profile
from hushh_mcp.services.developer_registry_service import (
    HUSHH_TECH_CONNECTOR_WRAPPING_ALG,
    DeveloperRegistryService,
    assert_hushh_tech_uat_registry_target,
)
from hushh_mcp.services.hushh_tech_uat_database_attestation import (
    UAT_DATABASE_NAME,
    UAT_DATABASE_ROLE,
    UAT_POSTGRES_SYSTEM_IDENTIFIER,
)

APP_ID = "app_hushh_tech_uat"
KEY_ID = "hushh-tech-uat-x25519-1"
PUBLIC_KEY = base64.b64encode(b"t" * 32).decode("ascii")
FINGERPRINT = get_connector_crypto_profile(
    HUSHH_TECH_CONNECTOR_WRAPPING_ALG
).fingerprint_recipient_key(PUBLIC_KEY)
ROOT = Path(__file__).resolve().parents[1]


def _registry_script_module():
    script_path = ROOT / "scripts" / "ops" / "reconcile_hushh_tech_uat_developer_app.py"
    spec = importlib.util.spec_from_file_location("hushh_tech_registry_reconciliation", script_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _app(*, capabilities: Any = None, groups: Any = None) -> dict[str, Any]:
    return {
        "app_id": APP_ID,
        "application_id": None,
        "agent_id": f"developer:{APP_ID}",
        "display_name": "Hushh Technologies UAT",
        "contact_email": "partners@hushh.ai",
        "status": "active",
        "kind": "partner_crm",
        "owner_firebase_uid": None,
        "allowed_tool_groups": groups if groups is not None else ["hushh_tech_client"],
        "allowed_capabilities": capabilities if capabilities is not None else [],
        "schema_profile": "standard",
        "oauth_client_credentials_enabled": False,
        "crm_id": "hushh-tech-uat-client",
    }


def _key(*, key_id: str = KEY_ID, status: str = "active") -> dict[str, Any]:
    return {
        "app_id": APP_ID,
        "connector_key_id": key_id,
        "connector_public_key": PUBLIC_KEY,
        "recipient_key_fingerprint": FINGERPRINT,
        "connector_wrapping_alg": HUSHH_TECH_CONNECTOR_WRAPPING_ALG,
        "status": status,
        "created_at": 1,
        "retired_at": None,
        "revoked_at": None,
    }


def _intended_token(*, token_id: int = 9) -> dict[str, Any]:
    return {
        "id": token_id,
        "app_id": APP_ID,
        "token_prefix": f"hdk_fixture_{token_id}",
        "label": "hushh-tech-uat-primary",
        "created_by": "ops_hushh_tech_uat_reconciliation",
        "created_at": token_id,
        "revoked_at": None,
        "revoked_by": None,
        "last_used_at": None,
    }


def _identity(**overrides: Any) -> dict[str, Any]:
    row = {
        "database_name": UAT_DATABASE_NAME,
        "database_role": UAT_DATABASE_ROLE,
        "server_version_num": 150018,
        "system_identifier": UAT_POSTGRES_SYSTEM_IDENTIFIER,
    }
    row.update(overrides)
    return row


class _Rows:
    def __init__(self, rows: list[dict[str, Any]]):
        self.rows = rows

    def mappings(self):
        return self

    def first(self):
        return self.rows[0] if self.rows else None

    def all(self):
        return list(self.rows)


class _RegistryConnection:
    def __init__(
        self,
        *,
        app: dict[str, Any] | None = None,
        keys: list[dict[str, Any]] | None = None,
        tokens: list[dict[str, Any]] | None = None,
        oauth_clients: list[dict[str, Any]] | None = None,
        oauth_tokens: list[dict[str, Any]] | None = None,
        identity: dict[str, Any] | None = None,
        fail_activation: bool = False,
    ):
        self.app = copy.deepcopy(app)
        self.keys = copy.deepcopy(keys or [])
        self.tokens = copy.deepcopy(tokens or [])
        self.oauth_clients = copy.deepcopy(oauth_clients or [])
        self.oauth_tokens = copy.deepcopy(oauth_tokens or [])
        self.identity = copy.deepcopy(identity or _identity())
        self.fail_activation = fail_activation
        self.sql: list[str] = []
        self.mutation_count = 0

    def snapshot(self):
        return copy.deepcopy(
            (self.app, self.keys, self.tokens, self.oauth_clients, self.oauth_tokens)
        )

    def restore(self, snapshot):
        self.app, self.keys, self.tokens, self.oauth_clients, self.oauth_tokens = copy.deepcopy(
            snapshot
        )

    def execute(self, statement, params=None):
        sql = " ".join(str(statement).split())
        values = params or {}
        self.sql.append(sql)

        if "FROM pg_control_system()" in sql:
            return _Rows([self.identity] if self.identity else [])
        if "pg_advisory_xact_lock" in sql:
            return _Rows([])
        if sql.startswith("SELECT app_id, agent_id, application_id"):
            return _Rows([self.app] if self.app and self.app["app_id"] == values["app_id"] else [])
        if sql.startswith("INSERT INTO developer_apps"):
            if self.app and (
                self.app.get("status") != "active"
                or self.app.get("owner_firebase_uid")
                or self.app.get("agent_id") != values["agent_id"]
                or self.app.get("application_id") is not None
            ):
                return _Rows([])
            self.mutation_count += 1
            self.app = {
                **(self.app or {}),
                "app_id": values["app_id"],
                "application_id": None,
                "agent_id": (self.app or {}).get("agent_id", values["agent_id"]),
                "display_name": values["display_name"],
                "contact_email": values["contact_email"],
                "status": "active",
                "allowed_tool_groups": json.loads(values["allowed_tool_groups"]),
                "allowed_capabilities": [],
                "kind": "partner_crm",
                "owner_firebase_uid": None,
                "crm_id": values["crm_id"],
                "schema_profile": "standard",
                "oauth_client_credentials_enabled": False,
            }
            return _Rows([self.app])
        if sql.startswith("SELECT * FROM developer_apps"):
            return _Rows([self.app] if self.app and self.app["app_id"] == values["app_id"] else [])
        if sql.startswith("SELECT app_id, connector_key_id"):
            rows = [row for row in self.keys if row["app_id"] == values["app_id"]]
            if "AND connector_key_id = :connector_key_id" in sql:
                rows = [
                    row for row in rows if row["connector_key_id"] == values["connector_key_id"]
                ]
            return _Rows(rows)
        if sql.startswith("INSERT INTO developer_connector_keys"):
            self.mutation_count += 1
            existing = next(
                (
                    row
                    for row in self.keys
                    if row["app_id"] == values["app_id"]
                    and row["connector_key_id"] == values["connector_key_id"]
                ),
                None,
            )
            if existing:
                return _Rows([])
            row = {
                "app_id": values["app_id"],
                "connector_key_id": values["connector_key_id"],
                "connector_public_key": values["connector_public_key"],
                "recipient_key_fingerprint": values["recipient_key_fingerprint"],
                "connector_wrapping_alg": values["connector_wrapping_alg"],
                "status": "retired",
                "created_at": values["created_at"],
                "retired_at": values["created_at"],
                "revoked_at": None,
            }
            self.keys.append(row)
            return _Rows([row])
        if sql.startswith("UPDATE developer_connector_keys") and "<>" in sql:
            self.mutation_count += 1
            for row in self.keys:
                if (
                    row["app_id"] == values["app_id"]
                    and row["status"] == "active"
                    and row["connector_key_id"] != values["connector_key_id"]
                ):
                    row["status"] = "retired"
                    row["retired_at"] = values["now"]
            return _Rows([])
        if sql.startswith("UPDATE developer_connector_keys") and "status = 'active'" in sql:
            self.mutation_count += 1
            if not self.fail_activation:
                for row in self.keys:
                    if (
                        row["app_id"] == values["app_id"]
                        and row["connector_key_id"] == values["connector_key_id"]
                        and row["status"] == "retired"
                        and row["revoked_at"] is None
                    ):
                        row["status"] = "active"
                        row["retired_at"] = None
            return _Rows([])
        if sql.startswith("UPDATE developer_oauth_tokens"):
            self.mutation_count += 1
            for row in self.oauth_tokens:
                if row["app_id"] == values["app_id"] and row.get("revoked_at") is None:
                    row["revoked_at"] = values["now"]
            return _Rows([])
        if sql.startswith("UPDATE developer_oauth_clients"):
            self.mutation_count += 1
            for row in self.oauth_clients:
                if row["app_id"] == values["app_id"] and row.get("revoked_at") is None:
                    row["revoked_at"] = values["now"]
            return _Rows([])
        if sql.startswith("SELECT id, app_id, token_prefix"):
            active = [row for row in self.tokens if row.get("revoked_at") is None]
            return _Rows(active)
        if sql.startswith("UPDATE developer_tokens"):
            self.mutation_count += 1
            for row in self.tokens:
                if row["app_id"] == values["app_id"] and row.get("revoked_at") is None:
                    row["revoked_at"] = values["now"]
                    row["revoked_by"] = values["revoked_by"]
            return _Rows([])
        if sql.startswith("INSERT INTO developer_tokens"):
            self.mutation_count += 1
            row = {
                "id": len(self.tokens) + 1,
                "app_id": values["app_id"],
                "token_prefix": values["token_prefix"],
                "label": values["label"],
                "created_by": values["created_by"],
                "created_at": values["created_at"],
                "revoked_at": None,
                "last_used_at": None,
            }
            self.tokens.append(row)
            return _Rows([row])
        if sql.startswith("SELECT client_id FROM developer_oauth_clients"):
            return _Rows(
                [
                    row
                    for row in self.oauth_clients
                    if row["app_id"] == values["app_id"] and row.get("revoked_at") is None
                ]
            )
        if sql.startswith("SELECT id FROM developer_oauth_tokens"):
            return _Rows(
                [
                    row
                    for row in self.oauth_tokens
                    if row["app_id"] == values["app_id"] and row.get("revoked_at") is None
                ]
            )
        raise AssertionError(f"Unhandled SQL: {sql}")


class _ConnectionContext:
    def __init__(self, connection: _RegistryConnection, *, transactional: bool):
        self.connection = connection
        self.transactional = transactional
        self.before = None

    def __enter__(self):
        if self.transactional:
            self.before = self.connection.snapshot()
        return self.connection

    def __exit__(self, exc_type, *_args):
        if exc_type is not None and self.before is not None:
            self.connection.restore(self.before)
        return False


class _Engine:
    def __init__(self, connection: _RegistryConnection):
        self.connection = connection

    def begin(self):
        return _ConnectionContext(self.connection, transactional=True)

    def connect(self):
        return _ConnectionContext(self.connection, transactional=False)


def _service(connection: _RegistryConnection) -> DeveloperRegistryService:
    db = MagicMock()
    db.engine = _Engine(connection)
    with patch("hushh_mcp.services.developer_registry_service.get_db", return_value=db):
        service = DeveloperRegistryService()
    service.ensure_tables = MagicMock()  # type: ignore[method-assign]
    service._hash_token = MagicMock(return_value="fixture-token-hash")  # type: ignore[method-assign]
    return service


@pytest.fixture(autouse=True)
def _uat_target(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    monkeypatch.setenv(
        "CLOUDSQL_INSTANCE_CONNECTION_NAME",
        "hushh-pda-uat:us-central1:hushh-uat-pg",
    )
    monkeypatch.setenv("HUSSH_TECH_DEVELOPER_APP_ID", APP_ID)


def _discard_token(_token: str) -> None:
    return None


def _reconcile(service: DeveloperRegistryService, token_sink=_discard_token):
    return service.reconcile_hushh_tech_uat_app(
        app_id=APP_ID,
        display_name="Hushh Technologies UAT",
        contact_email="partners@hushh.ai",
        connector_key_id=KEY_ID,
        connector_public_key=PUBLIC_KEY,
        issued_token_sink=token_sink,
    )


def test_target_guard_rejects_production_before_registry_io():
    with pytest.raises(ValueError, match="UAT-only"):
        assert_hushh_tech_uat_registry_target(
            app_id=APP_ID,
            environment={
                "ENVIRONMENT": "production",
                "GOOGLE_CLOUD_PROJECT": "hushh-pda-prod",
                "CLOUDSQL_INSTANCE_CONNECTION_NAME": "hushh-pda-prod:us-central1:hushh-prod-pg",
                "HUSSH_TECH_DEVELOPER_APP_ID": APP_ID,
            },
        )


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("GOOGLE_CLOUD_PROJECT", "hushh-tech-uat", "hushh-pda-uat"),
        (
            "CLOUDSQL_INSTANCE_CONNECTION_NAME",
            "hushh-pda-uat:us-central1:other",
            "hushh-uat-pg",
        ),
        ("HUSSH_TECH_DEVELOPER_APP_ID", "app_other", "exactly match"),
    ],
)
def test_target_guard_rejects_wrong_project_instance_or_app(field, value, message):
    environment = {
        "ENVIRONMENT": "uat",
        "GOOGLE_CLOUD_PROJECT": "hushh-pda-uat",
        "CLOUDSQL_INSTANCE_CONNECTION_NAME": "hushh-pda-uat:us-central1:hushh-uat-pg",
        "HUSSH_TECH_DEVELOPER_APP_ID": APP_ID,
    }
    environment[field] = value
    with pytest.raises(ValueError, match=message):
        assert_hushh_tech_uat_registry_target(app_id=APP_ID, environment=environment)


def test_wrong_proxy_identity_causes_zero_registry_writes():
    connection = _RegistryConnection(
        app=_app(capabilities=["cap.one.invoke"]),
        keys=[_key()],
        identity=_identity(system_identifier="9999999999999999999"),
    )
    service = _service(connection)

    with pytest.raises(ValueError, match="not the attested"):
        _reconcile(service)

    assert connection.mutation_count == 0
    assert len(connection.sql) == 1
    service.ensure_tables.assert_not_called()


@pytest.mark.parametrize(
    "drift",
    [
        {"agent_id": "developer:another-tenant"},
        {"application_id": 79},
    ],
)
def test_reused_app_tenant_binding_drift_causes_zero_writes_or_key_rotation(drift):
    app = _app()
    app.update(drift)
    connection = _RegistryConnection(
        app=app,
        keys=[_key(key_id="old-general-key")],
        tokens=[_intended_token()],
    )
    service = _service(connection)

    with pytest.raises(ValueError, match="tenant-identity drift"):
        _reconcile(service)

    assert connection.mutation_count == 0
    assert connection.keys == [_key(key_id="old-general-key")]
    assert not any(sql.startswith(("INSERT", "UPDATE")) for sql in connection.sql)
    service.ensure_tables.assert_not_called()


def test_reconcile_strips_broad_policy_and_rotates_key_atomically():
    old_key = _key(key_id="old-general-key")
    connection = _RegistryConnection(
        app=_app(
            capabilities=["cap.one.invoke"],
            groups=["core_consent", "hushh_tech_client"],
        ),
        keys=[old_key],
        tokens=[_intended_token()],
    )
    service = _service(connection)

    outcome = _reconcile(service)

    assert connection.app is not None
    assert connection.app["allowed_tool_groups"] == ["hushh_tech_client"]
    assert connection.app["allowed_capabilities"] == []
    assert connection.app["oauth_client_credentials_enabled"] is False
    assert [row["connector_key_id"] for row in connection.keys if row["status"] == "active"] == [
        KEY_ID
    ]
    insert_index = next(
        index
        for index, sql in enumerate(connection.sql)
        if sql.startswith("INSERT INTO developer_connector_keys")
    )
    retire_index = next(
        index
        for index, sql in enumerate(connection.sql)
        if sql.startswith("UPDATE developer_connector_keys") and "<>" in sql
    )
    assert insert_index < retire_index
    assert outcome["issued_token"] is False
    service.ensure_tables.assert_not_called()


def test_failed_target_activation_rolls_back_and_preserves_old_active_key():
    old_key = _key(key_id="old-general-key")
    connection = _RegistryConnection(
        app=_app(capabilities=["cap.one.invoke"]),
        keys=[old_key],
        tokens=[_intended_token()],
        fail_activation=True,
    )
    service = _service(connection)

    with pytest.raises(ValueError, match="exactly one active key"):
        _reconcile(service)

    assert [row["connector_key_id"] for row in connection.keys if row["status"] == "active"] == [
        "old-general-key"
    ]
    assert all(row["connector_key_id"] != KEY_ID for row in connection.keys)
    assert connection.app is not None
    assert connection.app["allowed_capabilities"] == ["cap.one.invoke"]


def test_reconcile_is_idempotent_and_issues_token_only_once():
    connection = _RegistryConnection(app=None, keys=[])
    service = _service(connection)
    delivered: list[str] = []

    first = _reconcile(service, delivered.append)
    second = _reconcile(service, delivered.append)

    assert first["issued_token"] is True
    assert second["issued_token"] is False
    assert delivered and delivered[0].startswith("hdk_")
    assert len(delivered) == 1
    assert "raw_token" not in first
    assert "raw_token" not in second
    assert len(connection.tokens) == 1
    assert len([row for row in connection.keys if row["status"] == "active"]) == 1


def test_reconcile_rotates_duplicate_tokens_and_revokes_legacy_oauth():
    legacy_token = {
        **_intended_token(token_id=10),
        "token_prefix": "hdk_legacy_unknown",
        "label": "partner-crm-primary",
        "created_by": "legacy-operator",
    }
    connection = _RegistryConnection(
        app=_app(),
        keys=[_key()],
        tokens=[_intended_token(), legacy_token],
        oauth_clients=[{"app_id": APP_ID, "client_id": "hco_legacy", "revoked_at": None}],
        oauth_tokens=[
            {"id": 1, "app_id": APP_ID, "token_kind": "access", "revoked_at": None},
            {"id": 2, "app_id": APP_ID, "token_kind": "refresh", "revoked_at": None},
        ],
    )
    service = _service(connection)
    delivered: list[str] = []

    outcome = _reconcile(service, delivered.append)

    assert outcome["issued_token"] is True
    assert len(delivered) == 1
    active_tokens = [row for row in connection.tokens if row.get("revoked_at") is None]
    assert len(active_tokens) == 1
    assert active_tokens[0]["label"] == "hushh-tech-uat-primary"
    assert active_tokens[0]["created_by"] == "ops_hushh_tech_uat_reconciliation"
    assert all(row.get("revoked_at") is not None for row in connection.oauth_clients)
    assert all(row.get("revoked_at") is not None for row in connection.oauth_tokens)


def test_verify_rejects_active_legacy_oauth_access_or_refresh():
    connection = _RegistryConnection(
        app=_app(),
        keys=[_key()],
        tokens=[_intended_token()],
        oauth_clients=[{"app_id": APP_ID, "client_id": "hco_legacy", "revoked_at": None}],
        oauth_tokens=[
            {"id": 1, "app_id": APP_ID, "token_kind": "access", "revoked_at": None},
            {"id": 2, "app_id": APP_ID, "token_kind": "refresh", "revoked_at": None},
        ],
    )
    service = _service(connection)

    with pytest.raises(ValueError, match="generic OAuth access"):
        service.verify_hushh_tech_uat_app_policy(
            app_id=APP_ID,
            connector_key_id=KEY_ID,
            connector_public_key=PUBLIC_KEY,
        )
    assert connection.mutation_count == 0


def test_missing_token_sink_rolls_back_new_registration():
    connection = _RegistryConnection(app=None, keys=[])
    service = _service(connection)

    with pytest.raises(ValueError, match="secure token output sink"):
        service.reconcile_hushh_tech_uat_app(
            app_id=APP_ID,
            display_name="Hushh Technologies UAT",
            contact_email="partners@hushh.ai",
            connector_key_id=KEY_ID,
            connector_public_key=PUBLIC_KEY,
        )

    assert connection.app is None
    assert connection.keys == []
    assert connection.tokens == []


def test_token_sink_failure_rolls_back_new_registration():
    connection = _RegistryConnection(app=None, keys=[])
    service = _service(connection)

    def _failed_sink(_raw_token: str) -> None:
        raise OSError("output unavailable")

    with pytest.raises(OSError, match="output unavailable"):
        _reconcile(service, _failed_sink)

    assert connection.app is None
    assert connection.keys == []
    assert connection.tokens == []


def test_cli_writes_new_token_0600_and_never_prints_it(tmp_path, capsys):
    module = _registry_script_module()
    raw_token = "hdk_deadbeef_super-secret-fixture"
    output_path = tmp_path / "developer-token"

    class _FakeRegistry:
        def reconcile_hushh_tech_uat_app(self, **kwargs):
            kwargs["issued_token_sink"](raw_token)
            return {
                "app": {"app_id": APP_ID},
                "connector_key": {
                    "connector_key_id": KEY_ID,
                    "recipient_key_fingerprint": FINGERPRINT,
                },
                "issued_token": True,
            }

    with patch(
        "hushh_mcp.services.developer_registry_service.DeveloperRegistryService",
        return_value=_FakeRegistry(),
    ):
        status = module.main(
            [
                "--app-id",
                APP_ID,
                "--connector-key-id",
                KEY_ID,
                "--connector-public-key",
                PUBLIC_KEY,
                "--token-output-file",
                str(output_path),
            ]
        )

    stdout = capsys.readouterr().out
    assert status == 0
    assert raw_token not in stdout
    assert "hdk_" not in stdout
    assert output_path.read_text(encoding="utf-8") == f"{raw_token}\n"
    assert stat.S_IMODE(output_path.stat().st_mode) == 0o600


def test_reconcile_rejects_reactivation_of_retired_key_id_and_rolls_back_policy():
    connection = _RegistryConnection(
        app=_app(capabilities=["cap.one.invoke"]),
        keys=[_key(status="retired")],
    )
    service = _service(connection)

    with pytest.raises(ValueError, match="cannot be reactivated"):
        _reconcile(service)

    assert connection.app is not None
    assert connection.app["allowed_capabilities"] == ["cap.one.invoke"]


@pytest.mark.parametrize(
    "app",
    [
        _app(capabilities=["cap.one.invoke"]),
        _app(groups=["hushh_tech_client", "core_consent"]),
    ],
)
def test_verify_rejects_any_broad_registry_policy(app):
    connection = _RegistryConnection(app=app, keys=[_key()])
    service = _service(connection)

    with pytest.raises(ValueError, match="drift"):
        service.verify_hushh_tech_uat_app_policy(
            app_id=APP_ID,
            connector_key_id=KEY_ID,
            connector_public_key=PUBLIC_KEY,
        )
    assert connection.mutation_count == 0


def test_verify_requires_exactly_one_active_connector_key():
    connection = _RegistryConnection(
        app=_app(),
        keys=[_key(), _key(key_id="unexpected-active")],
    )
    service = _service(connection)

    with pytest.raises(ValueError, match="exactly one active key"):
        service.verify_hushh_tech_uat_app_policy(
            app_id=APP_ID,
            connector_key_id=KEY_ID,
            connector_public_key=PUBLIC_KEY,
        )
    assert connection.mutation_count == 0

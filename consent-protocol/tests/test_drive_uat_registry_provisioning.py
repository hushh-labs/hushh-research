"""Focused contracts for the fixed, attested UAT Drive registry path."""

from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from hushh_mcp.services.drive_uat_registry_provisioning import (
    NATIVE_OAUTH_REDIRECT_URI,
    NATIVE_PICKER_REDIRECT_URI,
    POLICY_HASH,
    PROVISIONED_BY,
    REGISTERED_REDIRECT_URIS,
    UAT_PROJECT_ID,
    WEB_REDIRECT_URI,
    DriveUatRegistryProvisioner,
    DriveUatRegistryProvisioningError,
    _canonical_row,
    assert_google_drive_uat_registry_target,
)
from hushh_mcp.services.google_drive_adapter import DRIVE_BASE, SELECTED_POLICY
from hushh_mcp.services.hushh_tech_uat_database_attestation import (
    UAT_DATABASE_NAME,
    UAT_DATABASE_ROLE,
    UAT_INSTANCE,
    UAT_POSTGRES_SYSTEM_IDENTIFIER,
)

ROOT = Path(__file__).resolve().parents[1]


class _Rows:
    def __init__(self, rows: list[dict[str, Any]]):
        self.rows = rows

    def mappings(self):
        return self

    def first(self):
        return copy.deepcopy(self.rows[0]) if self.rows else None


class _RegistryConnection:
    def __init__(
        self, *, row: dict[str, Any] | None = None, identity: dict[str, Any] | None = None
    ):
        self.row = copy.deepcopy(row)
        self.identity = copy.deepcopy(identity or _identity())
        self.sql: list[str] = []
        self.parameters: list[dict[str, Any]] = []
        self.mutation_count = 0

    def execute(self, statement, params=None):
        sql = " ".join(str(statement).split())
        values = dict(params or {})
        self.sql.append(sql)
        self.parameters.append(copy.deepcopy(values))
        if "FROM pg_control_system()" in sql:
            return _Rows([self.identity] if self.identity else [])
        if "pg_advisory_xact_lock" in sql:
            return _Rows([])
        if sql.startswith("SELECT connector_id") and "FROM external_mcp_connectors" in sql:
            return _Rows([self.row] if self.row else [])
        if sql.startswith("INSERT INTO external_mcp_connectors"):
            if self.row is None:
                self.mutation_count += 1
                self.row = {
                    "connector_id": values["connector_id"],
                    "display_name": values["display_name"],
                    "description": values["description"],
                    "mcp_endpoint": values["mcp_endpoint"],
                    "auth_style": values["auth_style"],
                    "oauth_authorize_url": values["oauth_authorize_url"],
                    "oauth_token_url": values["oauth_token_url"],
                    "oauth_scopes": values["oauth_scopes"],
                    "oauth_client_id_env": values["oauth_client_id_env"],
                    "oauth_client_secret_env": values["oauth_client_secret_env"],
                    "api_key_header_name": values["api_key_header_name"],
                    "is_active": True,
                    "transport_kind": values["transport_kind"],
                    "capability_policy": json.loads(values["capability_policy"]),
                    "registered_redirect_uris": json.loads(values["registered_redirect_uris"]),
                    "created_by": values["created_by"],
                }
            return _Rows([])
        if sql.startswith("UPDATE external_mcp_connectors"):
            assert self.row is not None
            self.mutation_count += 1
            self.row["is_active"] = True
            return _Rows([])
        raise AssertionError(f"Unhandled SQL: {sql}")


class _ConnectionContext:
    def __init__(self, connection: _RegistryConnection):
        self.connection = connection

    def __enter__(self):
        return self.connection

    def __exit__(self, *_args):
        return False


class _Engine:
    def __init__(self, connection: _RegistryConnection):
        self.connection = connection

    def begin(self):
        return _ConnectionContext(self.connection)

    def connect(self):
        return _ConnectionContext(self.connection)


def _identity(**overrides: Any) -> dict[str, Any]:
    value = {
        "database_name": UAT_DATABASE_NAME,
        "database_role": UAT_DATABASE_ROLE,
        "server_version_num": 150018,
        "system_identifier": UAT_POSTGRES_SYSTEM_IDENTIFIER,
    }
    value.update(overrides)
    return value


def _service(connection: _RegistryConnection) -> DriveUatRegistryProvisioner:
    return DriveUatRegistryProvisioner(db=SimpleNamespace(engine=_Engine(connection)))


def _canonical_active_row(*, active: bool = True) -> dict[str, Any]:
    return {
        **copy.deepcopy(_canonical_row()),
        "capability_policy": copy.deepcopy(SELECTED_POLICY),
        "registered_redirect_uris": list(REGISTERED_REDIRECT_URIS),
        "is_active": active,
    }


def _script_module():
    path = ROOT / "scripts" / "ops" / "reconcile_google_drive_uat_connector.py"
    spec = importlib.util.spec_from_file_location("drive_uat_registry_reconciler", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(autouse=True)
def _exact_uat_target(monkeypatch):
    for name in ("HUSSH_RELEASE_ENVIRONMENT", "GOOGLE_CLOUD_PROJECT"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("GCP_PROJECT_ID", UAT_PROJECT_ID)
    monkeypatch.setenv("CLOUDSQL_INSTANCE_CONNECTION_NAME", UAT_INSTANCE)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("ENVIRONMENT", "production", "UAT-only"),
        ("GCP_PROJECT_ID", "hushh-pda-prod", "hushh-pda-uat"),
        ("CLOUDSQL_INSTANCE_CONNECTION_NAME", "hushh-pda-uat:us-central1:other", "hushh-uat-pg"),
    ],
)
def test_target_guard_rejects_non_uat_markers(field, value, message):
    environment = {
        "ENVIRONMENT": "uat",
        "GCP_PROJECT_ID": UAT_PROJECT_ID,
        "CLOUDSQL_INSTANCE_CONNECTION_NAME": UAT_INSTANCE,
    }
    environment[field] = value

    with pytest.raises(DriveUatRegistryProvisioningError, match=message):
        assert_google_drive_uat_registry_target(environment=environment)


def test_target_guard_rejects_conflicting_environment_markers():
    with pytest.raises(DriveUatRegistryProvisioningError, match="UAT-only"):
        assert_google_drive_uat_registry_target(
            environment={
                "ENVIRONMENT": "uat",
                "HUSSH_RELEASE_ENVIRONMENT": "production",
                "GCP_PROJECT_ID": UAT_PROJECT_ID,
                "CLOUDSQL_INSTANCE_CONNECTION_NAME": UAT_INSTANCE,
            }
        )


def test_activation_attests_database_before_any_registry_mutation():
    connection = _RegistryConnection(identity=_identity(system_identifier="wrong"))

    with pytest.raises(DriveUatRegistryProvisioningError, match="attested"):
        _service(connection).activate()

    assert connection.mutation_count == 0
    assert len(connection.sql) == 1
    assert "FROM pg_control_system()" in connection.sql[0]


def test_activation_inserts_only_the_fixed_drive_rest_policy():
    connection = _RegistryConnection()

    result = _service(connection).activate()

    assert result == {
        "connectorId": "google_drive",
        "status": "activated",
        "transportKind": "google_drive_rest",
        "policyHash": POLICY_HASH,
        "redirectCount": 3,
    }
    assert connection.row == _canonical_active_row()
    insert_values = next(
        values
        for sql, values in zip(connection.sql, connection.parameters, strict=True)
        if sql.startswith("INSERT INTO external_mcp_connectors")
    )
    assert insert_values["mcp_endpoint"] == DRIVE_BASE
    assert json.loads(insert_values["capability_policy"]) == SELECTED_POLICY
    assert json.loads(insert_values["registered_redirect_uris"]) == [
        WEB_REDIRECT_URI,
        NATIVE_OAUTH_REDIRECT_URI,
        NATIVE_PICKER_REDIRECT_URI,
    ]
    assert insert_values["created_by"] == PROVISIONED_BY
    assert not any(
        "secret" in key.lower() and key != "oauth_client_secret_env" for key in insert_values
    )


def test_activation_is_idempotent_for_an_exact_active_row():
    connection = _RegistryConnection(row=_canonical_active_row())

    result = _service(connection).activate()

    assert result["status"] == "verified"
    assert connection.mutation_count == 0


def test_activation_can_only_reactivate_an_exact_inactive_row():
    connection = _RegistryConnection(row=_canonical_active_row(active=False))

    result = _service(connection).activate()

    assert result["status"] == "activated"
    assert connection.row and connection.row["is_active"] is True
    assert connection.mutation_count == 1


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("transport_kind", "mcp"),
        ("oauth_scopes", "openid email"),
        ("oauth_client_secret_env", "GOOGLE_OAUTH_CLIENT_SECRET"),
        ("registered_redirect_uris", [WEB_REDIRECT_URI]),
        ("capability_policy", {"mutations": True}),
    ],
)
def test_activation_refuses_existing_policy_drift_without_overwriting(field, value):
    row = _canonical_active_row()
    row[field] = value
    connection = _RegistryConnection(row=row)

    with pytest.raises(DriveUatRegistryProvisioningError, match="drifted"):
        _service(connection).activate()

    assert connection.mutation_count == 0


def test_verify_is_read_only_and_requires_an_active_exact_row():
    connection = _RegistryConnection(row=_canonical_active_row())

    result = _service(connection).verify()

    assert result["status"] == "verified"
    assert connection.mutation_count == 0
    assert all("FOR UPDATE" not in sql for sql in connection.sql)


def test_cli_failure_does_not_echo_environment_values(monkeypatch, capsys):
    module = _script_module()
    secret_marker = "never-print-drive-registry-marker"
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("GCP_PROJECT_ID", secret_marker)

    assert module.main([]) == 1

    captured = capsys.readouterr()
    assert json.loads(captured.err) == {
        "status": "error",
        "code": "drive_registry_unavailable",
    }
    assert secret_marker not in captured.out
    assert secret_marker not in captured.err

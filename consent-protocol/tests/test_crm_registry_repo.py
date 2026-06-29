"""Tests for the DB-backed enterprise CRM registry repository."""

from __future__ import annotations

import os

import pytest

from hushh_mcp.services import crm_registry_repo
from hushh_mcp.services.connected_systems_service import (
    ConnectedSystemConfigurationError,
    ConnectedSystemDefinition,
)
from hushh_mcp.vault.encrypt import encrypt_data

# Fresh random 64-hex (256-bit) test key — generated per run, never a static
# literal, so secret scanners do not flag it (matches conftest test_vault_key).
TEST_VAULT_KEY = os.urandom(32).hex()

CLIENT_ID = "test-crm-client-id-0000000000000000"
CLIENT_SECRET = "test-crm-client-secret-1111111111111111"
MCP_ENDPOINT = "https://example-crm-gateway.invalid/crm-connect/v1/mcp"


def _encrypted_row() -> dict:
    cid = encrypt_data(CLIENT_ID, TEST_VAULT_KEY)
    csec = encrypt_data(CLIENT_SECRET, TEST_VAULT_KEY)
    return {
        "crm_id": "salesforce-fsc-customer0",
        "crm_enterprise_name": "Macy's",
        "crm_type": "Salesforce",
        "environment": "sandbox",
        "crm_base_url": "https://api.salesforce.com/platform",
        "crm_token_url": None,
        "crm_mcp_endpoint": MCP_ENDPOINT,
        "crm_client_id_ciphertext": cid.ciphertext,
        "crm_client_id_iv": cid.iv,
        "crm_client_id_tag": cid.tag,
        "crm_client_secret_ciphertext": csec.ciphertext,
        "crm_client_secret_iv": csec.iv,
        "crm_client_secret_tag": csec.tag,
        "encryption_algorithm": "aes-256-gcm",
        "key_id": "vault_data_key_v1",
        "auth_header_style": "client_id_secret_headers",
        "supports_create": True,
        "supports_read": True,
        "supports_update": True,
        "supports_delete": False,
        "user_object_name": "Contact",
        "rate_limit_per_min": None,
        "timeout_seconds": 30,
        "retry_count": 3,
        "is_active": True,
        "business_owner": "Kushal",
        "technical_owner": "MuleSoft",
    }


def _operation_rows() -> list[dict]:
    return [
        {
            "crm_id": "salesforce-fsc-customer0",
            "operation": "schema",
            "tool_name": "object-schema",
            "http_method": None,
            "path": None,
            "description": "Discover Contact schema.",
        },
        {
            "crm_id": "salesforce-fsc-customer0",
            "operation": "read",
            "tool_name": "read-crm-record",
            "http_method": None,
            "path": None,
            "description": "Read by email/phone.",
        },
        {
            "crm_id": "salesforce-fsc-customer0",
            "operation": "create",
            "tool_name": "create-crm-record",
            "http_method": None,
            "path": None,
            "description": "Create a Contact.",
        },
        {
            "crm_id": "salesforce-fsc-customer0",
            "operation": "update",
            "tool_name": "update-crm-record",
            "http_method": None,
            "path": None,
            "description": "Update by id.",
        },
        {
            "crm_id": "salesforce-fsc-customer0",
            "operation": "delete",
            "tool_name": "delete-crm-record",
            "http_method": None,
            "path": None,
            "description": "Delete by id.",
        },
    ]


class _FakeQueryResult:
    def __init__(self, data):
        self.data = data


class _FakeDb:
    """Returns the registry row for the first SELECT, operations for the second."""

    def __init__(self, registry_rows, operation_rows):
        self._registry_rows = registry_rows
        self._operation_rows = operation_rows
        self.queries = []

    def execute_raw(self, sql, params=None):
        self.queries.append((sql, params))
        if "crm_operation_endpoints" in sql:
            return _FakeQueryResult(list(self._operation_rows))
        return _FakeQueryResult(list(self._registry_rows))


def test_load_active_definition_decrypts_credentials_into_headers(monkeypatch):
    monkeypatch.setattr(crm_registry_repo, "_vault_key_hex", lambda: TEST_VAULT_KEY)
    db = _FakeDb([_encrypted_row()], _operation_rows())

    definition = crm_registry_repo.load_active_definition("salesforce-fsc-customer0", db=db)

    assert isinstance(definition, ConnectedSystemDefinition)
    assert definition.system_id == "salesforce-fsc-customer0"
    assert definition.transport_endpoint == MCP_ENDPOINT
    headers = dict(definition.transport_headers)
    assert headers["client_id"] == CLIENT_ID
    assert headers["client_secret"] == CLIENT_SECRET
    # Tool catalog built from operation rows.
    tool_names = {tool["name"] for tool in definition.tool_catalog}
    assert {
        "object-schema",
        "read-crm-record",
        "create-crm-record",
        "update-crm-record",
        "delete-crm-record",
    } <= tool_names


def test_load_active_definition_missing_row_returns_none(monkeypatch):
    monkeypatch.setattr(crm_registry_repo, "_vault_key_hex", lambda: TEST_VAULT_KEY)
    db = _FakeDb([], [])
    assert crm_registry_repo.load_active_definition("does-not-exist", db=db) is None


def test_load_active_definition_bad_key_raises_configuration_error(monkeypatch):
    # Decrypt with the wrong key → GCM tag mismatch → configuration error, not crash.
    monkeypatch.setattr(
        crm_registry_repo,
        "_vault_key_hex",
        lambda: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    )
    db = _FakeDb([_encrypted_row()], _operation_rows())
    with pytest.raises(ConnectedSystemConfigurationError):
        crm_registry_repo.load_active_definition("salesforce-fsc-customer0", db=db)


def test_load_active_definition_does_not_log_plaintext(monkeypatch, caplog):
    monkeypatch.setattr(crm_registry_repo, "_vault_key_hex", lambda: TEST_VAULT_KEY)
    db = _FakeDb([_encrypted_row()], _operation_rows())
    with caplog.at_level("DEBUG"):
        crm_registry_repo.load_active_definition("salesforce-fsc-customer0", db=db)
    joined = " ".join(record.getMessage() for record in caplog.records)
    assert CLIENT_SECRET not in joined
    assert CLIENT_ID not in joined


# ---------------------------------------------------------------------------
# MuleSoft interop: PBKDF2-HMACSHA256 + AES-256-CBC published rows.
# ---------------------------------------------------------------------------

CONNECTOR_PASSWORD = "a-real-random-connector-secret-not-mule123"
KDF_SALT = "shared-connector-salt"
KDF_ITERATIONS = 1000


def _pbkdf2_row() -> dict:
    """A row as MuleSoft would publish it: single blobs + KDF params, no GCM cols."""
    from hushh_mcp.vault.encrypt import encrypt_data_pbkdf2_cbc

    cid = encrypt_data_pbkdf2_cbc(CLIENT_ID, CONNECTOR_PASSWORD, KDF_SALT, KDF_ITERATIONS)
    csec = encrypt_data_pbkdf2_cbc(CLIENT_SECRET, CONNECTOR_PASSWORD, KDF_SALT, KDF_ITERATIONS)
    return {
        "crm_id": "salesforce-fsc-customer0",
        "crm_enterprise_name": "Macy's",
        "crm_type": "Salesforce",
        "environment": "sandbox",
        "crm_base_url": "https://api.salesforce.com/platform",
        "crm_token_url": None,
        "crm_mcp_endpoint": MCP_ENDPOINT,
        # GCM columns intentionally absent — this is a PBKDF2 row.
        "crm_client_id_blob": cid,
        "crm_client_secret_blob": csec,
        "kdf_salt": KDF_SALT,
        "kdf_iterations": KDF_ITERATIONS,
        "encryption_algorithm": "pbkdf2-hmacsha256-aes256-cbc",
        "auth_header_style": "client_id_secret_headers",
        "supports_create": True,
        "supports_read": True,
        "supports_update": True,
        "supports_delete": False,
        "user_object_name": "Contact",
        "is_active": True,
    }


def test_load_active_definition_decrypts_pbkdf2_cbc_row(monkeypatch):
    """A MuleSoft-published PBKDF2-CBC row decrypts to the same headers as GCM."""
    monkeypatch.setattr(crm_registry_repo, "get_connector_secrets_key", lambda: CONNECTOR_PASSWORD)
    db = _FakeDb([_pbkdf2_row()], _operation_rows())

    definition = crm_registry_repo.load_active_definition("salesforce-fsc-customer0", db=db)

    headers = dict(definition.transport_headers)
    assert headers["client_id"] == CLIENT_ID
    assert headers["client_secret"] == CLIENT_SECRET


def test_pbkdf2_row_with_wrong_password_raises_configuration_error(monkeypatch):
    monkeypatch.setattr(
        crm_registry_repo, "get_connector_secrets_key", lambda: "the-wrong-password"
    )
    db = _FakeDb([_pbkdf2_row()], _operation_rows())
    with pytest.raises(ConnectedSystemConfigurationError):
        crm_registry_repo.load_active_definition("salesforce-fsc-customer0", db=db)


def test_pbkdf2_row_missing_kdf_params_raises_configuration_error(monkeypatch):
    monkeypatch.setattr(crm_registry_repo, "get_connector_secrets_key", lambda: CONNECTOR_PASSWORD)
    row = _pbkdf2_row()
    row["kdf_salt"] = None
    db = _FakeDb([row], _operation_rows())
    with pytest.raises(ConnectedSystemConfigurationError):
        crm_registry_repo.load_active_definition("salesforce-fsc-customer0", db=db)

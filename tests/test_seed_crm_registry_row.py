"""Test the CRM registry seed script round-trips through the repo (PBKDF2-CBC)."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path

from hushh_mcp.services import crm_registry_repo
from hushh_mcp.vault.encrypt import PBKDF2_CBC_ALGORITHM, decrypt_data_pbkdf2_cbc

# Fresh random connector password per run, never a static literal, so secret
# scanners do not flag it. Salt is non-secret config; iterations kept low so the
# test stays fast.
TEST_CONNECTOR_KEY = os.urandom(32).hex()
TEST_KDF_SALT = "MuleSoftSalt123"
TEST_KDF_ITERATIONS = "1000"
SEED_CLIENT_ID = "seed-client-id-abcdef0123456789"
SEED_CLIENT_SECRET = "seed-client-secret-9876543210fedcba"
MCP_ENDPOINT = "https://example-crm-gateway.invalid/crm-connect/v1/mcp"

_SEED_PATH = Path(__file__).resolve().parents[1] / "scripts" / "ops" / "seed_crm_registry_row.py"


def _load_seed_module():
    spec = importlib.util.spec_from_file_location("seed_crm_registry_row", _SEED_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _set_connector_env(monkeypatch):
    monkeypatch.setenv("CONNECTOR_SECRETS_KEY", TEST_CONNECTOR_KEY)
    monkeypatch.setenv("CONNECTOR_KDF_SALT", TEST_KDF_SALT)
    monkeypatch.setenv("CONNECTOR_KDF_ITERATIONS", TEST_KDF_ITERATIONS)


class _Result:
    def __init__(self, data):
        self.data = data


class _CaptureDb:
    """Captures the INSERT params so we can assert the encrypted envelope round-trips."""

    def __init__(self):
        self.registry_params = None
        self.operation_params = []

    def execute_raw(self, sql, params=None):
        if "enterprise_crm_registry" in sql:
            self.registry_params = params
        elif "crm_operation_endpoints" in sql:
            self.operation_params.append(params)
        return _Result([])


def test_seed_script_encrypts_and_round_trips(monkeypatch):
    _set_connector_env(monkeypatch)
    monkeypatch.setenv("CRM_SEED_CLIENT_ID", SEED_CLIENT_ID)
    monkeypatch.setenv("CRM_SEED_CLIENT_SECRET", SEED_CLIENT_SECRET)

    seed = _load_seed_module()
    capture = _CaptureDb()
    monkeypatch.setattr(seed, "get_db", lambda: capture)

    monkeypatch.setattr(
        "sys.argv",
        [
            "seed_crm_registry_row.py",
            "--crm-id",
            "salesforce-fsc-macys",
            "--enterprise-name",
            "Macy's",
            "--crm-type",
            "Salesforce",
            "--environment",
            "sandbox",
            "--mcp-endpoint",
            MCP_ENDPOINT,
        ],
    )

    rc = seed.main()
    assert rc == 0

    params = capture.registry_params
    assert params is not None
    # Declared algorithm is the MuleSoft-native standard.
    assert params["algorithm"] == PBKDF2_CBC_ALGORITHM
    # Blob columns are populated and are NOT the plaintext.
    assert params["cid_blob"] and params["cid_blob"] != SEED_CLIENT_ID
    assert params["csec_blob"] and params["csec_blob"] != SEED_CLIENT_SECRET
    # GCM envelope params are no longer produced.
    assert "cid_ct" not in params
    assert "csec_ct" not in params

    # Round-trip: decrypt the stored blob with the same connector params.
    decrypted_id = decrypt_data_pbkdf2_cbc(
        params["cid_blob"], TEST_CONNECTOR_KEY, TEST_KDF_SALT, int(TEST_KDF_ITERATIONS)
    )
    decrypted_secret = decrypt_data_pbkdf2_cbc(
        params["csec_blob"], TEST_CONNECTOR_KEY, TEST_KDF_SALT, int(TEST_KDF_ITERATIONS)
    )
    assert decrypted_id == SEED_CLIENT_ID
    assert decrypted_secret == SEED_CLIENT_SECRET

    # All five operation rows seeded with live tool names.
    tool_names = {p["tool_name"] for p in capture.operation_params}
    assert tool_names == {
        "object-schema",
        "read-crm-record",
        "create-crm-record",
        "update-crm-record",
        "delete-crm-record",
    }


def test_seed_then_load_active_definition_yields_headers(monkeypatch):
    """The seeded blob decrypts back into transport_headers via the repo."""
    _set_connector_env(monkeypatch)
    monkeypatch.setenv("CRM_SEED_CLIENT_ID", SEED_CLIENT_ID)
    monkeypatch.setenv("CRM_SEED_CLIENT_SECRET", SEED_CLIENT_SECRET)

    seed = _load_seed_module()
    capture = _CaptureDb()
    monkeypatch.setattr(seed, "get_db", lambda: capture)
    monkeypatch.setattr(
        "sys.argv",
        [
            "seed_crm_registry_row.py",
            "--mcp-endpoint",
            MCP_ENDPOINT,
        ],
    )
    assert seed.main() == 0
    p = capture.registry_params

    # Build a registry row dict as the repo would SELECT it. KDF params are
    # resolved from connector config (the row omits them after migration 073).
    row = {
        "crm_id": p["crm_id"],
        "crm_enterprise_name": p["crm_enterprise_name"],
        "crm_type": p["crm_type"],
        "crm_mcp_endpoint": p["crm_mcp_endpoint"],
        "crm_client_id_blob": p["cid_blob"],
        "crm_client_secret_blob": p["csec_blob"],
        "encryption_algorithm": PBKDF2_CBC_ALGORITHM,
        "key_id": "connector_secrets_key_v1",
        "auth_header_style": "client_id_secret_headers",
        "user_object_name": "Contact",
    }

    class _RepoDb:
        def execute_raw(self, sql, params=None):
            if "crm_operation_endpoints" in sql:
                return _Result([])
            return _Result([row])

    definition = crm_registry_repo.load_active_definition(p["crm_id"], db=_RepoDb())
    headers = dict(definition.transport_headers)
    assert headers["client_id"] == SEED_CLIENT_ID
    assert headers["client_secret"] == SEED_CLIENT_SECRET

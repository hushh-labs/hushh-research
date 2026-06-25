"""Test the encrypted CRM registry seed script round-trips through the repo."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path

from hushh_mcp.services import crm_registry_repo
from hushh_mcp.types import EncryptedPayload
from hushh_mcp.vault.encrypt import decrypt_data

# Fresh random 64-hex (256-bit) test key — generated per run, never a static
# literal, so secret scanners do not flag it (matches conftest test_vault_key).
TEST_VAULT_KEY = os.urandom(32).hex()
SEED_CLIENT_ID = "seed-client-id-abcdef0123456789"
SEED_CLIENT_SECRET = "seed-client-secret-9876543210fedcba"
MCP_ENDPOINT = "https://example-crm-gateway.invalid/crm-connect/v1/mcp"

_SEED_PATH = Path(__file__).resolve().parents[1] / "scripts" / "ops" / "seed_crm_registry_row.py"


def _load_seed_module():
    spec = importlib.util.spec_from_file_location("seed_crm_registry_row", _SEED_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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
    monkeypatch.setenv("CRM_SEED_CLIENT_ID", SEED_CLIENT_ID)
    monkeypatch.setenv("CRM_SEED_CLIENT_SECRET", SEED_CLIENT_SECRET)

    # Patch the seed module's VAULT_DATA_KEY and get_db.
    seed = _load_seed_module()
    monkeypatch.setattr(seed, "VAULT_DATA_KEY", TEST_VAULT_KEY)

    capture = _CaptureDb()
    monkeypatch.setattr(seed, "get_db", lambda: capture)

    monkeypatch.setattr(
        "sys.argv",
        [
            "seed_crm_registry_row.py",
            "--crm-id",
            "salesforce-fsc-customer0",
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
    # Ciphertext columns are populated and are NOT the plaintext.
    assert params["cid_ct"] and params["cid_ct"] != SEED_CLIENT_ID
    assert params["csec_ct"] and params["csec_ct"] != SEED_CLIENT_SECRET

    # Round-trip: decrypt the stored envelope with the same key → original plaintext.
    decrypted_id = decrypt_data(
        EncryptedPayload(
            ciphertext=params["cid_ct"],
            iv=params["cid_iv"],
            tag=params["cid_tag"],
            encoding="base64",
            algorithm="aes-256-gcm",
        ),
        TEST_VAULT_KEY,
    )
    decrypted_secret = decrypt_data(
        EncryptedPayload(
            ciphertext=params["csec_ct"],
            iv=params["csec_iv"],
            tag=params["csec_tag"],
            encoding="base64",
            algorithm="aes-256-gcm",
        ),
        TEST_VAULT_KEY,
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
    """The seeded envelope decrypts back into transport_headers via the repo."""
    monkeypatch.setenv("CRM_SEED_CLIENT_ID", SEED_CLIENT_ID)
    monkeypatch.setenv("CRM_SEED_CLIENT_SECRET", SEED_CLIENT_SECRET)

    seed = _load_seed_module()
    monkeypatch.setattr(seed, "VAULT_DATA_KEY", TEST_VAULT_KEY)
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

    # Build a registry row dict as the repo would SELECT it.
    row = {
        "crm_id": p["crm_id"],
        "crm_enterprise_name": p["crm_enterprise_name"],
        "crm_type": p["crm_type"],
        "crm_mcp_endpoint": p["crm_mcp_endpoint"],
        "crm_client_id_ciphertext": p["cid_ct"],
        "crm_client_id_iv": p["cid_iv"],
        "crm_client_id_tag": p["cid_tag"],
        "crm_client_secret_ciphertext": p["csec_ct"],
        "crm_client_secret_iv": p["csec_iv"],
        "crm_client_secret_tag": p["csec_tag"],
        "encryption_algorithm": "aes-256-gcm",
        "key_id": "vault_data_key_v1",
        "auth_header_style": "client_id_secret_headers",
        "user_object_name": "Contact",
    }

    class _RepoDb:
        def execute_raw(self, sql, params=None):
            if "crm_operation_endpoints" in sql:
                return _Result([])
            return _Result([row])

    monkeypatch.setattr(crm_registry_repo, "_vault_key_hex", lambda: TEST_VAULT_KEY)
    definition = crm_registry_repo.load_active_definition(p["crm_id"], db=_RepoDb())
    headers = dict(definition.transport_headers)
    assert headers["client_id"] == SEED_CLIENT_ID
    assert headers["client_secret"] == SEED_CLIENT_SECRET

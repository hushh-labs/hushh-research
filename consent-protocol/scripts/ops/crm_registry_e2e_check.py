"""End-to-end live verification (Task 8) for the DB-backed CRM registry + Omni Gateway.

Runs against the OFFLINE SQLite engine (DB_OFFLINE=1) so no production data is
touched, but exercises the REAL path:
  seed (encrypt) -> crm_registry_repo.load_active_definition (decrypt) ->
  ConnectedSystemsService (flag on) -> ExternalCrmStreamableMcpAdapter ->
  LIVE Omni Gateway over the network.

The gateway credentials and VAULT_DATA_KEY are read from the environment at run
time only. Nothing is printed in plaintext.
"""

from __future__ import annotations

import asyncio
import os
import sys

# Force offline DB so we never touch prod; isolate to a temp sqlite file.
os.environ["DB_OFFLINE"] = "1"
os.environ.setdefault("OFFLINE_DB_PATH", "/tmp/crm_e2e_offline.db")
os.environ["CRM_REGISTRY_DB_ENABLED"] = "true"

from db.db_client import get_db  # noqa: E402
from hushh_mcp.config import VAULT_DATA_KEY  # noqa: E402
from hushh_mcp.services import crm_registry_repo  # noqa: E402
from hushh_mcp.services.connected_systems_service import (  # noqa: E402  # noqa: E402
    CONNECTED_SYSTEM_SALESFORCE_ID,
    ConnectedSystemsService,
    InMemoryConnectedSystemIntentStore,
)
from hushh_mcp.vault.encrypt import encrypt_data  # noqa: E402

CRM_ID = CONNECTED_SYSTEM_SALESFORCE_ID
ENDPOINT = os.environ["CRM_E2E_MCP_ENDPOINT"]
CLIENT_ID = os.environ["CRM_E2E_CLIENT_ID"]
CLIENT_SECRET = os.environ["CRM_E2E_CLIENT_SECRET"]


def _create_tables(db) -> None:
    db.execute_raw(
        """
        CREATE TABLE IF NOT EXISTS enterprise_crm_registry (
          crm_id TEXT PRIMARY KEY,
          crm_enterprise_name TEXT NOT NULL,
          crm_type TEXT,
          environment TEXT NOT NULL DEFAULT 'sandbox',
          crm_base_url TEXT NOT NULL,
          crm_token_url TEXT,
          crm_mcp_endpoint TEXT NOT NULL,
          crm_client_id_ciphertext TEXT NOT NULL,
          crm_client_id_iv TEXT NOT NULL,
          crm_client_id_tag TEXT NOT NULL,
          crm_client_secret_ciphertext TEXT NOT NULL,
          crm_client_secret_iv TEXT NOT NULL,
          crm_client_secret_tag TEXT NOT NULL,
          encryption_algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
          key_id TEXT NOT NULL DEFAULT 'vault_data_key_v1',
          auth_header_style TEXT NOT NULL DEFAULT 'client_id_secret_headers',
          supports_create INTEGER NOT NULL DEFAULT 1,
          supports_read INTEGER NOT NULL DEFAULT 1,
          supports_update INTEGER NOT NULL DEFAULT 1,
          supports_delete INTEGER NOT NULL DEFAULT 0,
          user_object_name TEXT DEFAULT 'Contact',
          rate_limit_per_min INTEGER,
          timeout_seconds INTEGER NOT NULL DEFAULT 30,
          retry_count INTEGER NOT NULL DEFAULT 3,
          is_active INTEGER NOT NULL DEFAULT 1,
          business_owner TEXT,
          technical_owner TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
        """,
        {},
    )
    db.execute_raw(
        """
        CREATE TABLE IF NOT EXISTS crm_operation_endpoints (
          crm_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          http_method TEXT,
          path TEXT,
          description TEXT,
          PRIMARY KEY (crm_id, operation)
        )
        """,
        {},
    )


def _seed(db) -> None:
    cid = encrypt_data(CLIENT_ID, VAULT_DATA_KEY)
    csec = encrypt_data(CLIENT_SECRET, VAULT_DATA_KEY)
    db.execute_raw("DELETE FROM enterprise_crm_registry WHERE crm_id = :id", {"id": CRM_ID})
    db.execute_raw("DELETE FROM crm_operation_endpoints WHERE crm_id = :id", {"id": CRM_ID})
    db.execute_raw(
        """
        INSERT INTO enterprise_crm_registry (
          crm_id, crm_enterprise_name, crm_type, environment,
          crm_base_url, crm_mcp_endpoint,
          crm_client_id_ciphertext, crm_client_id_iv, crm_client_id_tag,
          crm_client_secret_ciphertext, crm_client_secret_iv, crm_client_secret_tag,
          encryption_algorithm, key_id, auth_header_style,
          supports_delete, user_object_name, is_active
        ) VALUES (
          :id, 'Macys', 'Salesforce', 'sandbox',
          'https://api.salesforce.com/platform', :endpoint,
          :cid_ct, :cid_iv, :cid_tag,
          :csec_ct, :csec_iv, :csec_tag,
          'aes-256-gcm', 'vault_data_key_v1', 'client_id_secret_headers',
          0, 'Contact', 1
        )
        """,
        {
            "id": CRM_ID,
            "endpoint": ENDPOINT,
            "cid_ct": cid.ciphertext,
            "cid_iv": cid.iv,
            "cid_tag": cid.tag,
            "csec_ct": csec.ciphertext,
            "csec_iv": csec.iv,
            "csec_tag": csec.tag,
        },
    )
    for op, tool in (
        ("schema", "object-schema"),
        ("read", "read-crm-record"),
        ("create", "create-crm-record"),
        ("update", "update-crm-record"),
        ("delete", "delete-crm-record"),
    ):
        db.execute_raw(
            "INSERT INTO crm_operation_endpoints (crm_id, operation, tool_name) "
            "VALUES (:id, :op, :tool)",
            {"id": CRM_ID, "op": op, "tool": tool},
        )


async def main() -> int:
    db = get_db()
    _create_tables(db)
    _seed(db)

    # 1) Repo decrypts the row into headers (no plaintext printed).
    definition = crm_registry_repo.load_active_definition(CRM_ID)
    assert definition is not None, "registry row not loaded"
    header_keys = {k for k, _ in definition.transport_headers}
    assert header_keys == {"client_id", "client_secret"}, header_keys
    print(
        f"[1] repo loaded definition: endpoint_host={definition.transport_endpoint.split('/')[2]} "
        f"header_keys={sorted(header_keys)} tools={len(definition.tool_catalog)}"
    )

    # 2) Service resolves DB-backed definition (flag on) and builds the adapter.
    service = ConnectedSystemsService(store=InMemoryConnectedSystemIntentStore())
    resolved = service.get_system(CRM_ID)
    assert resolved.registry_source == "enterprise_crm_registry", resolved.registry_source
    print(f"[2] service resolved from DB registry: source={resolved.registry_source}")

    # 3) LIVE: object-schema through the gateway (header-authenticated).
    schema = await service.get_schema(system_id=CRM_ID, object_type="Contact")
    fields = schema.get("supportedFields", [])
    assert fields, f"no schema fields returned: {schema}"
    print(
        f"[3] LIVE object-schema OK: {len(fields)} fields incl. "
        f"{[f for f in fields if f in ('Email', 'Phone')]}"
    )

    # 4) LIVE: search (read) through the gateway.
    read = await service.search_record(
        user_id="e2e_user",
        system_id=CRM_ID,
        object_type="Contact",
        email="e2e.probe@example.com",
        phone="4155550000",
    )
    print(
        f"[4] LIVE search OK: resultClass={read.get('resultClass')} "
        f"servedFromBinding={read.get('servedFromBinding')} "
        f"bindingStatus={read.get('bindingStatus')}"
    )

    print("E2E PASS: DB-backed registry -> decrypt -> gateway (header auth) verified.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

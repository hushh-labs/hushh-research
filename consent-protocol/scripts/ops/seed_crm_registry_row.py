"""Maintainer seed script for the encrypted enterprise CRM registry row.

Inserts (or updates) one `enterprise_crm_registry` row plus its
`crm_operation_endpoints` catalog, encrypting client_id / client_secret with
AES-256-GCM under VAULT_DATA_KEY. The plaintext credentials are read from the
environment at run time ONLY and are never written to git, logs, or stdout.

Usage (non-prod example):

    cd consent-protocol
    VAULT_DATA_KEY=<64-hex> \
    DB_USER=... DB_PASSWORD=... DB_HOST=... DB_NAME=... \
    CRM_SEED_CLIENT_ID=<id> \
    CRM_SEED_CLIENT_SECRET=<secret> \
    python scripts/ops/seed_crm_registry_row.py \
      --crm-id salesforce-fsc-customer0 \
      --enterprise-name "Macy's" \
      --crm-type Salesforce \
      --environment sandbox \
      --mcp-endpoint https://hussh-og-nonprod-ingress-a3e0me.y4rjsf.usa-e2.cloudhub.io/crm-connect/v1/mcp \
      --base-url https://api.salesforce.com/platform

The script prints only the crm_id and a redacted confirmation.
"""

from __future__ import annotations

import argparse
import os
import sys

from db.db_client import get_db
from hushh_mcp.config import VAULT_DATA_KEY
from hushh_mcp.vault.encrypt import encrypt_data

# operation -> live MCP tool name (verified against testCrm-salesforce-mcp-server).
_OPERATION_TOOLS = (
    ("schema", "object-schema", "Discover the Salesforce Contact field schema."),
    ("read", "read-crm-record", "Read a Contact by email and phone (search)."),
    ("create", "create-crm-record", "Create a Contact from approved fields."),
    ("update", "update-crm-record", "Update allowlisted Contact fields by id."),
    ("delete", "delete-crm-record", "Delete a Contact by id (maintainer-gated)."),
)


def _require_env(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if not value:
        print(f"ERROR: {name} must be set in the environment.", file=sys.stderr)
        sys.exit(2)
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed the encrypted enterprise CRM registry row.")
    parser.add_argument("--crm-id", default="salesforce-fsc-customer0")
    parser.add_argument("--enterprise-name", default="Macy's")
    parser.add_argument("--crm-type", default="Salesforce")
    parser.add_argument("--environment", default="sandbox", choices=["sandbox", "production"])
    parser.add_argument("--mcp-endpoint", required=True)
    parser.add_argument("--base-url", default="https://api.salesforce.com/platform")
    parser.add_argument("--token-url", default=None)
    parser.add_argument("--business-owner", default=None)
    parser.add_argument("--technical-owner", default=None)
    parser.add_argument(
        "--supports-delete",
        action="store_true",
        help="Enable delete capability (default off).",
    )
    args = parser.parse_args()

    # Validate the vault key early so we fail before touching the DB.
    if not VAULT_DATA_KEY or len(VAULT_DATA_KEY) != 64:
        print("ERROR: VAULT_DATA_KEY must be a 64-char hex string.", file=sys.stderr)
        return 2

    client_id = _require_env("CRM_SEED_CLIENT_ID")
    client_secret = _require_env("CRM_SEED_CLIENT_SECRET")

    cid = encrypt_data(client_id, VAULT_DATA_KEY)
    csec = encrypt_data(client_secret, VAULT_DATA_KEY)

    db = get_db()

    db.execute_raw(
        """
        INSERT INTO enterprise_crm_registry (
          crm_id, crm_enterprise_name, crm_type, environment,
          crm_base_url, crm_token_url, crm_mcp_endpoint,
          crm_client_id_ciphertext, crm_client_id_iv, crm_client_id_tag,
          crm_client_secret_ciphertext, crm_client_secret_iv, crm_client_secret_tag,
          encryption_algorithm, key_id, auth_header_style,
          supports_create, supports_read, supports_update, supports_delete,
          user_object_name, timeout_seconds, retry_count, is_active,
          business_owner, technical_owner, updated_at
        ) VALUES (
          :crm_id, :crm_enterprise_name, :crm_type, :environment,
          :crm_base_url, :crm_token_url, :crm_mcp_endpoint,
          :cid_ct, :cid_iv, :cid_tag,
          :csec_ct, :csec_iv, :csec_tag,
          :algorithm, :key_id, :auth_header_style,
          TRUE, TRUE, TRUE, :supports_delete,
          'Contact', 30, 3, TRUE,
          :business_owner, :technical_owner, NOW()
        )
        ON CONFLICT (crm_enterprise_name, crm_type, environment) DO UPDATE SET
          crm_base_url = EXCLUDED.crm_base_url,
          crm_token_url = EXCLUDED.crm_token_url,
          crm_mcp_endpoint = EXCLUDED.crm_mcp_endpoint,
          crm_client_id_ciphertext = EXCLUDED.crm_client_id_ciphertext,
          crm_client_id_iv = EXCLUDED.crm_client_id_iv,
          crm_client_id_tag = EXCLUDED.crm_client_id_tag,
          crm_client_secret_ciphertext = EXCLUDED.crm_client_secret_ciphertext,
          crm_client_secret_iv = EXCLUDED.crm_client_secret_iv,
          crm_client_secret_tag = EXCLUDED.crm_client_secret_tag,
          encryption_algorithm = EXCLUDED.encryption_algorithm,
          key_id = EXCLUDED.key_id,
          auth_header_style = EXCLUDED.auth_header_style,
          supports_delete = EXCLUDED.supports_delete,
          business_owner = EXCLUDED.business_owner,
          technical_owner = EXCLUDED.technical_owner,
          is_active = TRUE,
          updated_at = NOW()
        """,
        {
            "crm_id": args.crm_id,
            "crm_enterprise_name": args.enterprise_name,
            "crm_type": args.crm_type,
            "environment": args.environment,
            "crm_base_url": args.base_url,
            "crm_token_url": args.token_url,
            "crm_mcp_endpoint": args.mcp_endpoint,
            "cid_ct": cid.ciphertext,
            "cid_iv": cid.iv,
            "cid_tag": cid.tag,
            "csec_ct": csec.ciphertext,
            "csec_iv": csec.iv,
            "csec_tag": csec.tag,
            "algorithm": "aes-256-gcm",
            "key_id": "vault_data_key_v1",
            "auth_header_style": "client_id_secret_headers",
            "supports_delete": bool(args.supports_delete),
            "business_owner": args.business_owner,
            "technical_owner": args.technical_owner,
        },
    )

    for operation, tool_name, description in _OPERATION_TOOLS:
        db.execute_raw(
            """
            INSERT INTO crm_operation_endpoints (crm_id, operation, tool_name, description)
            VALUES (:crm_id, :operation, :tool_name, :description)
            ON CONFLICT (crm_id, operation) DO UPDATE SET
              tool_name = EXCLUDED.tool_name,
              description = EXCLUDED.description
            """,
            {
                "crm_id": args.crm_id,
                "operation": operation,
                "tool_name": tool_name,
                "description": description,
            },
        )

    print(
        f"Seeded enterprise_crm_registry crm_id={args.crm_id} "
        f"environment={args.environment} endpoint_host="
        f"{args.mcp_endpoint.split('/')[2] if '//' in args.mcp_endpoint else 'set'} "
        "credentials=encrypted(aes-256-gcm) [plaintext never printed]"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

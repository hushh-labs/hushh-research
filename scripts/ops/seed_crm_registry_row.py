"""Maintainer seed script for the encrypted enterprise CRM registry row.

Inserts (or updates) one `enterprise_crm_registry` row plus its
`crm_operation_endpoints` catalog, encrypting client_id / client_secret with
the MuleSoft-native PBKDF2-HMAC-SHA256 + AES-256-CBC scheme so every published
CRM uses one standard interop shape (matching MuleSoft JCE Decrypt output).

The credential blobs are base64(iv || ciphertext). The KDF password is the
connector secret (CONNECTOR_SECRETS_KEY); the salt and iteration count are
constant connector config (CONNECTOR_KDF_SALT / CONNECTOR_KDF_ITERATIONS), so
they are NOT written per-row. Plaintext credentials are read from the
environment at run time ONLY and are never written to git, logs, or stdout.

Usage (non-prod example):

    cd consent-protocol
    CONNECTOR_SECRETS_KEY=<connector password> \
    CONNECTOR_KDF_SALT=<shared salt> \
    CONNECTOR_KDF_ITERATIONS=<iterations> \
    DB_USER=... DB_PASSWORD=... DB_HOST=... DB_NAME=... \
    CRM_SEED_CLIENT_ID=<id> \
    CRM_SEED_CLIENT_SECRET=<secret> \
    python scripts/ops/seed_crm_registry_row.py \
      --crm-id salesforce-fsc-macys \
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
from hushh_mcp.runtime_settings import (
    get_connector_kdf_iterations,
    get_connector_kdf_salt,
    get_connector_secrets_key,
)
from hushh_mcp.vault.encrypt import PBKDF2_CBC_ALGORITHM, encrypt_data_pbkdf2_cbc

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
    parser.add_argument(
        "--delete-endpoint",
        default=None,
        help="Salesforce delete path (used only when --supports-delete is set).",
    )
    parser.add_argument("--business-owner", default=None)
    parser.add_argument("--technical-owner", default=None)
    parser.add_argument(
        "--supports-delete",
        action="store_true",
        help="Enable delete capability (default off).",
    )
    args = parser.parse_args()

    # Resolve the MuleSoft-native PBKDF2 KDF parameters from connector config and
    # fail before touching the DB if any are missing.
    password = get_connector_secrets_key()
    if not password:
        print(
            "ERROR: CONNECTOR_SECRETS_KEY (or VAULT_DATA_KEY fallback) must be set.",
            file=sys.stderr,
        )
        return 2
    salt = get_connector_kdf_salt()
    if not salt:
        print("ERROR: CONNECTOR_KDF_SALT must be set.", file=sys.stderr)
        return 2
    iterations = get_connector_kdf_iterations()

    client_id = _require_env("CRM_SEED_CLIENT_ID")
    client_secret = _require_env("CRM_SEED_CLIENT_SECRET")

    # MuleSoft-native single-blob credentials: base64(iv || ciphertext).
    cid_blob = encrypt_data_pbkdf2_cbc(client_id, password, salt, iterations)
    csec_blob = encrypt_data_pbkdf2_cbc(client_secret, password, salt, iterations)

    db = get_db()

    db.execute_raw(
        """
        INSERT INTO enterprise_crm_registry (
          crm_id, crm_enterprise_name, crm_type, environment,
          crm_base_url, crm_token_url, crm_mcp_endpoint, crm_delete_endpoint,
          crm_client_id_blob, crm_client_secret_blob,
          encryption_algorithm, key_id, auth_header_style,
          supports_create, supports_read, supports_update, supports_delete,
          user_object_name, timeout_seconds, retry_count, is_active,
          business_owner, technical_owner, updated_at
        ) VALUES (
          :crm_id, :crm_enterprise_name, :crm_type, :environment,
          :crm_base_url, :crm_token_url, :crm_mcp_endpoint, :crm_delete_endpoint,
          :cid_blob, :csec_blob,
          :algorithm, :key_id, :auth_header_style,
          TRUE, TRUE, TRUE, :supports_delete,
          'Contact', 30, 3, TRUE,
          :business_owner, :technical_owner, NOW()
        )
        ON CONFLICT (crm_enterprise_name, crm_type, environment) DO UPDATE SET
          crm_base_url = EXCLUDED.crm_base_url,
          crm_token_url = EXCLUDED.crm_token_url,
          crm_mcp_endpoint = EXCLUDED.crm_mcp_endpoint,
          crm_delete_endpoint = EXCLUDED.crm_delete_endpoint,
          crm_client_id_blob = EXCLUDED.crm_client_id_blob,
          crm_client_secret_blob = EXCLUDED.crm_client_secret_blob,
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
            "crm_delete_endpoint": args.delete_endpoint,
            "cid_blob": cid_blob,
            "csec_blob": csec_blob,
            "algorithm": PBKDF2_CBC_ALGORITHM,
            "key_id": "connector_secrets_key_v1",
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
        f"credentials=encrypted({PBKDF2_CBC_ALGORITHM}) [plaintext never printed]"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

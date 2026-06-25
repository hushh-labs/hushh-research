"""DB-backed enterprise CRM registry repository.

Loads an active `enterprise_crm_registry` row, decrypts the AES-256-GCM
credential envelopes with `VAULT_DATA_KEY`, and returns the existing
`ConnectedSystemDefinition` shape (with `transport_headers` carrying the
decrypted client_id / client_secret) so the rest of Connected Systems is
unchanged.

No plaintext credentials are ever logged. Decryption failures surface as
`ConnectedSystemConfigurationError` (fail-closed) rather than crashing the
request path.
"""

from __future__ import annotations

import logging
from typing import Any

from db.db_client import get_db
from hushh_mcp.config import VAULT_DATA_KEY
from hushh_mcp.runtime_settings import (
    get_connector_kdf_iterations,
    get_connector_kdf_salt,
    get_connector_secrets_key,
)
from hushh_mcp.services.connected_systems_service import (
    ConnectedSystemConfigurationError,
    ConnectedSystemDefinition,
)
from hushh_mcp.types import EncryptedPayload
from hushh_mcp.vault.encrypt import (
    PBKDF2_CBC_ALGORITHM,
    decrypt_data,
    decrypt_data_pbkdf2_cbc,
)

logger = logging.getLogger(__name__)

EXTERNAL_CRM_TRANSPORT = "external_crm_streamable_mcp"
REGISTRY_SOURCE = "enterprise_crm_registry"
GCM_ALGORITHM = "aes-256-gcm"

# Maps the row's auth_header_style to the header keys carrying each credential.
_AUTH_HEADER_STYLES: dict[str, tuple[str, str]] = {
    "client_id_secret_headers": ("client_id", "client_secret"),
}


def _vault_key_hex() -> str:
    """Indirection so tests can monkeypatch the decryption key."""
    return VAULT_DATA_KEY


def _decrypt_gcm_envelope(
    *, ciphertext: Any, iv: Any, tag: Any, algorithm: str, key_hex: str, label: str
) -> str:
    try:
        payload = EncryptedPayload(
            ciphertext=str(ciphertext or ""),
            iv=str(iv or ""),
            tag=str(tag or ""),
            encoding="base64",
            algorithm="aes-256-gcm"
            if (algorithm or "aes-256-gcm") == "aes-256-gcm"
            else "chacha20-poly1305",
        )
        return decrypt_data(payload, key_hex)
    except Exception:  # noqa: BLE001 - fail closed, never leak plaintext/cause
        # Do not include the underlying error (may carry ciphertext fragments).
        raise ConnectedSystemConfigurationError(
            f"Failed to decrypt CRM registry {label}.",
            code="CONNECTED_SYSTEM_REGISTRY_DECRYPT_FAILED",
        ) from None


def _decrypt_pbkdf2_cbc_blob(
    *, blob: Any, password: str, salt: Any, iterations: Any, label: str
) -> str:
    """Decrypt a MuleSoft-published PBKDF2-AES256-CBC credential blob."""
    try:
        return decrypt_data_pbkdf2_cbc(str(blob or ""), password, str(salt or ""), int(iterations))
    except Exception:  # noqa: BLE001 - fail closed, never leak plaintext/cause
        raise ConnectedSystemConfigurationError(
            f"Failed to decrypt CRM registry {label}.",
            code="CONNECTED_SYSTEM_REGISTRY_DECRYPT_FAILED",
        ) from None


def _decrypt_credentials(row: dict[str, Any]) -> tuple[str, str]:
    """Return (client_id, client_secret) by branching on encryption_algorithm.

    Two interop shapes are supported:
      * aes-256-gcm                    — Hushh-written envelope (ciphertext/iv/tag)
      * pbkdf2-hmacsha256-aes256-cbc   — MuleSoft-written JCE blob (base64 iv||ct)
    """
    algorithm = str(row.get("encryption_algorithm") or GCM_ALGORITHM).strip().lower()

    if algorithm == PBKDF2_CBC_ALGORITHM:
        password = get_connector_secrets_key()
        # KDF params are constant across MuleSoft CRMs → resolve from config when
        # the row omits them (the common case after migration 073). A row MAY
        # still override with its own kdf_salt / kdf_iterations.
        salt = row.get("kdf_salt") or get_connector_kdf_salt()
        iterations = row.get("kdf_iterations") or get_connector_kdf_iterations()
        if not salt or not iterations:
            raise ConnectedSystemConfigurationError(
                "CRM registry PBKDF2 row is missing kdf_salt / kdf_iterations "
                "and no connector KDF config is set.",
                code="CONNECTED_SYSTEM_REGISTRY_INCOMPLETE",
            )
        client_id = _decrypt_pbkdf2_cbc_blob(
            blob=row.get("crm_client_id_blob"),
            password=password,
            salt=salt,
            iterations=iterations,
            label="client_id",
        )
        client_secret = _decrypt_pbkdf2_cbc_blob(
            blob=row.get("crm_client_secret_blob"),
            password=password,
            salt=salt,
            iterations=iterations,
            label="client_secret",
        )
        return client_id, client_secret

    # Default / GCM path (unchanged).
    key_hex = _vault_key_hex()
    client_id = _decrypt_gcm_envelope(
        ciphertext=row.get("crm_client_id_ciphertext"),
        iv=row.get("crm_client_id_iv"),
        tag=row.get("crm_client_id_tag"),
        algorithm=algorithm,
        key_hex=key_hex,
        label="client_id",
    )
    client_secret = _decrypt_gcm_envelope(
        ciphertext=row.get("crm_client_secret_ciphertext"),
        iv=row.get("crm_client_secret_iv"),
        tag=row.get("crm_client_secret_tag"),
        algorithm=algorithm,
        key_hex=key_hex,
        label="client_secret",
    )
    return client_id, client_secret


def _tool_catalog_from_rows(rows: list[dict[str, Any]]) -> tuple[dict[str, Any], ...]:
    catalog: list[dict[str, Any]] = []
    for row in rows:
        name = str(row.get("tool_name") or "").strip()
        operation = str(row.get("operation") or "").strip()
        if not name or not operation:
            continue
        catalog.append(
            {
                "name": name,
                "operation": operation,
                "description": str(row.get("description") or "").strip(),
            }
        )
    return tuple(catalog)


def load_active_definition(
    crm_id: str, *, db: Any | None = None
) -> ConnectedSystemDefinition | None:
    """Return the active CRM definition for `crm_id`, or None if not found/inactive.

    Decrypts client_id / client_secret into `transport_headers`. Raises
    `ConnectedSystemConfigurationError` if the row is malformed or cannot be
    decrypted with the configured `VAULT_DATA_KEY`.
    """
    database = db if db is not None else get_db()

    registry_rows = database.execute_raw(
        """
        SELECT *
        FROM enterprise_crm_registry
        WHERE crm_id = :crm_id
          AND is_active = TRUE
        LIMIT 1
        """,
        {"crm_id": crm_id},
    ).data
    if not registry_rows:
        return None

    row = registry_rows[0]

    endpoint = str(row.get("crm_mcp_endpoint") or "").strip()
    if not endpoint:
        raise ConnectedSystemConfigurationError(
            "CRM registry row is missing crm_mcp_endpoint.",
            code="CONNECTED_SYSTEM_REGISTRY_INCOMPLETE",
        )

    # Decrypt credentials, branching on the row's encryption_algorithm
    # (GCM for Hushh-written rows, PBKDF2-CBC for MuleSoft-published rows).
    client_id, client_secret = _decrypt_credentials(row)

    style = str(row.get("auth_header_style") or "client_id_secret_headers")
    header_keys = _AUTH_HEADER_STYLES.get(style)
    if header_keys is None:
        raise ConnectedSystemConfigurationError(
            f"Unsupported CRM registry auth_header_style: {style}",
            code="CONNECTED_SYSTEM_REGISTRY_AUTH_STYLE",
        )
    id_header, secret_header = header_keys
    transport_headers = ((id_header, client_id), (secret_header, client_secret))

    operation_rows = database.execute_raw(
        """
        SELECT operation, tool_name, http_method, path, description
        FROM crm_operation_endpoints
        WHERE crm_id = :crm_id
        """,
        {"crm_id": crm_id},
    ).data
    tool_catalog = _tool_catalog_from_rows(operation_rows)

    logger.info(
        "crm_registry.loaded crm_id=%s endpoint_configured=%s tools=%d",
        crm_id,
        bool(endpoint),
        len(tool_catalog),
    )

    return ConnectedSystemDefinition(
        system_id=str(row.get("crm_id")),
        display_name=str(row.get("crm_enterprise_name") or ""),
        customer_display_name=str(row.get("crm_enterprise_name") or ""),
        system_type=str(row.get("crm_type") or ""),
        system_name=str(row.get("crm_type") or ""),
        target=str(row.get("crm_enterprise_name") or ""),
        object_type_default=str(row.get("user_object_name") or "Contact"),
        transport=EXTERNAL_CRM_TRANSPORT,
        transport_endpoint=endpoint,
        registry_source=REGISTRY_SOURCE,
        tool_catalog=tool_catalog,
        transport_headers=transport_headers,
        delete_transport_endpoint=(
            str(row.get("crm_delete_endpoint")).strip() if row.get("crm_delete_endpoint") else None
        ),
    )

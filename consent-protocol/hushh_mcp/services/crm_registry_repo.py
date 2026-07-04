"""DB-backed enterprise CRM registry repository.

Loads active `enterprise_crm_registry` rows into `ConnectedSystemDefinition`
objects. List views avoid credential decryption. MuleSoft Bearer action paths
pass the row's CRM client id and encrypted client secret directly to the MCP
tool; MuleSoft owns secret decryption.

No plaintext credentials are ever logged. Decryption failures surface as
`ConnectedSystemConfigurationError` (fail-closed) rather than crashing the
request path.
"""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urljoin

from db.db_client import get_db
from hushh_mcp.config import VAULT_DATA_KEY
from hushh_mcp.runtime_settings import (
    get_connector_kdf_iterations,
    get_connector_kdf_salt,
    get_connector_secrets_key,
    get_omnigateway_transport_headers,
)
from hushh_mcp.services.connected_systems_service import (
    EXTERNAL_CRM_TOOL_CATALOG,
    REGISTRY_MCP_ENDPOINT,
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
_CANONICAL_CUSTOMER0_CRM_ID = "salesforce-fsc-customer0"
_CUSTOMER0_ENTERPRISE_NAMES = ("macys", "macy's")


def _resolve_endpoint(row: dict[str, Any]) -> str:
    endpoint = str(row.get("crm_mcp_endpoint") or "").strip()
    if not endpoint:
        raise ConnectedSystemConfigurationError(
            "CRM registry row is missing crm_mcp_endpoint.",
            code="CONNECTED_SYSTEM_REGISTRY_INCOMPLETE",
        )
    if endpoint.startswith(("http://", "https://", "registry://")):
        return endpoint

    base_url = str(row.get("crm_base_url") or "").strip()
    if not base_url:
        raise ConnectedSystemConfigurationError(
            "CRM registry row has a relative crm_mcp_endpoint but no crm_base_url.",
            code="CONNECTED_SYSTEM_REGISTRY_INCOMPLETE",
        )
    return urljoin(f"{base_url.rstrip('/')}/", endpoint.lstrip("/"))


def _is_mulesoft_managed_auth(row: dict[str, Any]) -> bool:
    return str(row.get("auth_header_style") or "").strip().lower() == "bearer"


def _first_text(row: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = str(row.get(key) or "").strip()
        if value:
            return value
    return ""


def _mulesoft_tool_arguments(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "target": str(row.get("crm_enterprise_name") or "").strip(),
        "crmBaseUrl": str(row.get("crm_base_url") or "").strip(),
        "crmMcpEndpoint": str(row.get("crm_mcp_endpoint") or "").strip(),
        "clientId": _first_text(
            row, "crm_client_id", "crm_client_id_ciphertext", "crm_client_id_blob"
        ),
        "clientSecret": _first_text(
            row,
            "crm_client_secret",
            "crm_client_secret_ciphertext",
            "crm_client_secret_blob",
        ),
        "crmTokenUrl": str(row.get("crm_token_url") or "").strip(),
        "objectType": str(row.get("user_object_name") or "Contact").strip() or "Contact",
    }


def _load_active_row(crm_id: str, database: Any) -> dict[str, Any] | None:
    rows = database.execute_raw(
        """
        SELECT *
        FROM enterprise_crm_registry
        WHERE is_active = TRUE
          AND (
            crm_id = :crm_id
            OR (
              :crm_id = :customer0_crm_id
              AND LOWER(crm_enterprise_name) IN (:customer0_name_1, :customer0_name_2)
            )
          )
        ORDER BY
          CASE WHEN crm_id = :crm_id THEN 0 ELSE 1 END,
          updated_at DESC
        LIMIT 1
        """,
        {
            "crm_id": crm_id,
            "customer0_crm_id": _CANONICAL_CUSTOMER0_CRM_ID,
            "customer0_name_1": _CUSTOMER0_ENTERPRISE_NAMES[0],
            "customer0_name_2": _CUSTOMER0_ENTERPRISE_NAMES[1],
        },
    ).data
    return rows[0] if rows else None


def _load_active_rows(database: Any) -> list[dict[str, Any]]:
    return database.execute_raw(
        """
        SELECT *
        FROM enterprise_crm_registry
        WHERE is_active = TRUE
        ORDER BY crm_enterprise_name ASC, crm_id ASC
        """,
        {},
    ).data


def _public_system_id(row: dict[str, Any]) -> str:
    enterprise = str(row.get("crm_enterprise_name") or "").strip().lower()
    if enterprise in _CUSTOMER0_ENTERPRISE_NAMES:
        return _CANONICAL_CUSTOMER0_CRM_ID
    return str(row.get("crm_id") or "").strip()


def _tool_catalog(row_crm_id: str, database: Any) -> tuple[dict[str, Any], ...]:
    operation_rows = database.execute_raw(
        """
        SELECT operation, tool_name, http_method, path, description
        FROM crm_operation_endpoints
        WHERE crm_id = :crm_id
        """,
        {"crm_id": row_crm_id},
    ).data
    return _tool_catalog_from_rows(operation_rows) or EXTERNAL_CRM_TOOL_CATALOG


def _definition_from_row(
    *,
    requested_crm_id: str,
    row: dict[str, Any],
    endpoint: str,
    tool_catalog: tuple[dict[str, Any], ...],
    transport_headers: tuple[tuple[str, str], ...] = (),
    transport_tool_arguments: dict[str, Any] | None = None,
) -> ConnectedSystemDefinition:
    return ConnectedSystemDefinition(
        system_id=requested_crm_id,
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
        transport_tool_arguments=transport_tool_arguments,
        delete_transport_endpoint=(
            str(row.get("crm_delete_endpoint")).strip() if row.get("crm_delete_endpoint") else None
        ),
    )


def _definition_from_row_without_decrypt(
    *, requested_crm_id: str, row: dict[str, Any], database: Any
) -> ConnectedSystemDefinition:
    row_crm_id = str(row.get("crm_id") or requested_crm_id)
    endpoint = REGISTRY_MCP_ENDPOINT if _is_mulesoft_managed_auth(row) else _resolve_endpoint(row)
    tool_catalog = _tool_catalog(row_crm_id, database)
    mulesoft_managed_auth = _is_mulesoft_managed_auth(row)
    return _definition_from_row(
        requested_crm_id=requested_crm_id,
        row=row,
        endpoint=endpoint,
        tool_catalog=tool_catalog,
        transport_headers=get_omnigateway_transport_headers() if mulesoft_managed_auth else (),
    )


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

    Header-auth rows decrypt credentials into transport headers. MuleSoft Bearer
    rows do not decrypt; they pass row values directly as MCP tool arguments.
    """
    database = db if db is not None else get_db()

    row = _load_active_row(crm_id, database)
    if not row:
        return None

    row_crm_id = str(row.get("crm_id") or crm_id)
    mulesoft_managed_auth = _is_mulesoft_managed_auth(row)
    endpoint = REGISTRY_MCP_ENDPOINT if mulesoft_managed_auth else _resolve_endpoint(row)
    tool_catalog = _tool_catalog(row_crm_id, database)

    style = str(row.get("auth_header_style") or "client_id_secret_headers")
    transport_headers: tuple[tuple[str, str], ...]
    transport_tool_arguments: dict[str, Any] | None = None
    if mulesoft_managed_auth:
        transport_headers = get_omnigateway_transport_headers()
        transport_tool_arguments = _mulesoft_tool_arguments(row)
    else:
        # Decrypt credentials only for legacy header-auth rows.
        client_id, client_secret = _decrypt_credentials(row)
        header_keys = _AUTH_HEADER_STYLES.get(style)
        if header_keys is None:
            raise ConnectedSystemConfigurationError(
                f"Unsupported CRM registry auth_header_style: {style}",
                code="CONNECTED_SYSTEM_REGISTRY_AUTH_STYLE",
            )
        id_header, secret_header = header_keys
        transport_headers = ((id_header, client_id), (secret_header, client_secret))
    if not mulesoft_managed_auth and not transport_headers:
        raise ConnectedSystemConfigurationError(
            f"Unsupported CRM registry auth_header_style: {style}",
            code="CONNECTED_SYSTEM_REGISTRY_AUTH_STYLE",
        )

    logger.info(
        "crm_registry.loaded crm_id=%s endpoint_configured=%s tools=%d",
        row_crm_id,
        bool(endpoint),
        len(tool_catalog),
    )

    return _definition_from_row(
        requested_crm_id=crm_id,
        row=row,
        endpoint=endpoint,
        tool_catalog=tool_catalog,
        transport_headers=transport_headers,
        transport_tool_arguments=transport_tool_arguments,
    )


def load_active_definitions(*, db: Any | None = None) -> tuple[ConnectedSystemDefinition, ...]:
    """Return all active CRM definitions without decrypting CRM credentials."""
    database = db if db is not None else get_db()
    definitions: list[ConnectedSystemDefinition] = []
    for row in _load_active_rows(database):
        public_id = _public_system_id(row)
        if not public_id:
            continue
        definitions.append(
            _definition_from_row_without_decrypt(
                requested_crm_id=public_id,
                row=row,
                database=database,
            )
        )
    return tuple(definitions)

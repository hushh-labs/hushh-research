"""Controlled UAT provisioning for the fixed Google Drive REST connector.

``external_mcp_connectors`` is an operator-curated catalog.  The generic MCP
descriptor CLI deliberately cannot write this row: Drive is a fixed REST
transport, not an MCP endpoint, and must never accept caller-supplied
redirects, scopes, capability policy, or credential configuration.

This module owns the one reviewed UAT definition.  It attests the live
database before every read or write and refuses an existing row with policy
drift rather than silently broadening or replacing it.  Activating this row
does not enable any Drive feature; the independent runtime flags and explicit
internal-owner cohort still fail closed.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from typing import Any

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.external_connector_google_oauth import (
    AUTHORIZE_URL,
    CONNECTOR_ID,
    SCOPES,
    TOKEN_URL,
)
from hushh_mcp.services.google_drive_adapter import DRIVE_BASE, POLICY_HASH, SELECTED_POLICY
from hushh_mcp.services.hushh_tech_uat_database_attestation import (
    UAT_DATABASE_ATTESTATION_SQL,
    UAT_INSTANCE,
    is_attested_hushh_tech_uat_database,
    parse_connected_database_identity,
)

UAT_PROJECT_ID = "hushh-pda-uat"
PROVISIONED_BY = "ops_google_drive_uat_registry"
WEB_REDIRECT_URI = "https://uat.one.hushh.ai/one/profile/connectors/oauth/return"
NATIVE_OAUTH_REDIRECT_URI = "https://api.uat.hushh.ai/api/connectors/oauth/native/callback"
NATIVE_PICKER_REDIRECT_URI = (
    "https://api.uat.hushh.ai/api/connectors/google_drive/picker/native/callback"
)
REGISTERED_REDIRECT_URIS = (
    WEB_REDIRECT_URI,
    NATIVE_OAUTH_REDIRECT_URI,
    NATIVE_PICKER_REDIRECT_URI,
)

_LOAD_CONNECTOR_SQL = text(
    """
    SELECT connector_id, display_name, description, mcp_endpoint, auth_style,
           oauth_authorize_url, oauth_token_url, oauth_scopes,
           oauth_client_id_env, oauth_client_secret_env, api_key_header_name,
           is_active, transport_kind, capability_policy,
           registered_redirect_uris, created_by
    FROM external_mcp_connectors
    WHERE connector_id = :connector_id
    """
)
_LOAD_CONNECTOR_FOR_UPDATE_SQL = text(
    """
    SELECT connector_id, display_name, description, mcp_endpoint, auth_style,
           oauth_authorize_url, oauth_token_url, oauth_scopes,
           oauth_client_id_env, oauth_client_secret_env, api_key_header_name,
           is_active, transport_kind, capability_policy,
           registered_redirect_uris, created_by
    FROM external_mcp_connectors
    WHERE connector_id = :connector_id
    FOR UPDATE
    """
)


class DriveUatRegistryProvisioningError(ValueError):
    """Safe operator-facing failure; never include DB details or credentials."""


def _configured_values(values: Mapping[str, str], *names: str) -> set[str]:
    return {
        str(values.get(name) or "").strip() for name in names if str(values.get(name) or "").strip()
    }


def assert_google_drive_uat_registry_target(
    *, environment: Mapping[str, str] | None = None
) -> None:
    """Fail before DB I/O unless every supplied target marker is exact UAT."""

    values = environment if environment is not None else os.environ
    lanes = _configured_values(values, "ENVIRONMENT", "HUSSH_RELEASE_ENVIRONMENT")
    projects = _configured_values(values, "GCP_PROJECT_ID", "GOOGLE_CLOUD_PROJECT")
    instances = _configured_values(values, "CLOUDSQL_INSTANCE_CONNECTION_NAME")
    if lanes != {"uat"}:
        raise DriveUatRegistryProvisioningError("Drive registry provisioning is UAT-only")
    if projects != {UAT_PROJECT_ID}:
        raise DriveUatRegistryProvisioningError(
            "Drive registry provisioning requires hushh-pda-uat"
        )
    if instances != {UAT_INSTANCE}:
        raise DriveUatRegistryProvisioningError("Drive registry provisioning requires hushh-uat-pg")


def assert_connected_google_drive_uat_database(connection: Any) -> None:
    """Attest the server before reading or changing the connector catalog."""

    try:
        result = connection.execute(text(UAT_DATABASE_ATTESTATION_SQL))
        row = result.mappings().first()
        identity = parse_connected_database_identity(row or {})
    except Exception as exc:
        raise DriveUatRegistryProvisioningError(
            "connected UAT database identity could not be verified"
        ) from exc
    if not is_attested_hushh_tech_uat_database(identity):
        raise DriveUatRegistryProvisioningError(
            "connected database is not the attested hushh-uat-pg target"
        )


def _json_object(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except ValueError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def _json_string_sequence(value: Any) -> tuple[str, ...] | None:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return None
    if not isinstance(value, (list, tuple)) or not all(isinstance(item, str) for item in value):
        return None
    return tuple(value)


def _canonical_row() -> dict[str, Any]:
    """All mutable row values; no OAuth credential values live here."""

    return {
        "connector_id": CONNECTOR_ID,
        "display_name": "Google Drive",
        "description": "Select Google Drive files you allow One to inspect. Connecting does not share files.",
        "mcp_endpoint": DRIVE_BASE,
        "auth_style": "oauth",
        "oauth_authorize_url": AUTHORIZE_URL,
        "oauth_token_url": TOKEN_URL,
        "oauth_scopes": " ".join(SCOPES),
        "oauth_client_id_env": "GOOGLE_DRIVE_OAUTH_CLIENT_ID",
        "oauth_client_secret_env": "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET",
        "api_key_header_name": None,
        "transport_kind": "google_drive_rest",
        "capability_policy": SELECTED_POLICY,
        "registered_redirect_uris": REGISTERED_REDIRECT_URIS,
        "created_by": PROVISIONED_BY,
    }


def _row_matches_policy(row: Mapping[str, Any], *, require_active: bool) -> bool:
    expected = _canonical_row()
    for field in (
        "connector_id",
        "display_name",
        "description",
        "mcp_endpoint",
        "auth_style",
        "oauth_authorize_url",
        "oauth_token_url",
        "oauth_client_id_env",
        "oauth_client_secret_env",
        "api_key_header_name",
        "transport_kind",
        "created_by",
    ):
        if row.get(field) != expected[field]:
            return False

    actual_scopes = str(row.get("oauth_scopes") or "").split()
    if len(actual_scopes) != len(set(actual_scopes)) or set(actual_scopes) != set(SCOPES):
        return False
    if _json_object(row.get("capability_policy")) != SELECTED_POLICY:
        return False
    actual_redirects = _json_string_sequence(row.get("registered_redirect_uris"))
    if (
        actual_redirects is None
        or len(actual_redirects) != len(set(actual_redirects))
        or set(actual_redirects) != set(REGISTERED_REDIRECT_URIS)
    ):
        return False
    return not require_active or row.get("is_active") is True


class DriveUatRegistryProvisioner:
    """Attested, serialized, fixed-policy provisioning for one UAT registry row."""

    def __init__(self, db: Any | None = None) -> None:
        self._db = db or get_db()

    @staticmethod
    def _summary(*, status: str) -> dict[str, Any]:
        return {
            "connectorId": CONNECTOR_ID,
            "status": status,
            "transportKind": "google_drive_rest",
            "policyHash": POLICY_HASH,
            "redirectCount": len(REGISTERED_REDIRECT_URIS),
        }

    @staticmethod
    def _load(connection: Any, *, lock: bool) -> dict[str, Any] | None:
        result = connection.execute(
            _LOAD_CONNECTOR_FOR_UPDATE_SQL if lock else _LOAD_CONNECTOR_SQL,
            {"connector_id": CONNECTOR_ID},
        )
        row = result.mappings().first()
        return dict(row) if row is not None else None

    @staticmethod
    def _insert(connection: Any) -> None:
        row = _canonical_row()
        result = connection.execute(
            text(
                """
                INSERT INTO external_mcp_connectors (
                    connector_id, display_name, description, mcp_endpoint, auth_style,
                    oauth_authorize_url, oauth_token_url, oauth_scopes,
                    oauth_client_id_env, oauth_client_secret_env, api_key_header_name,
                    is_active, created_by, created_at, updated_at, transport_kind,
                    capability_policy, registered_redirect_uris
                ) VALUES (
                    :connector_id, :display_name, :description, :mcp_endpoint, :auth_style,
                    :oauth_authorize_url, :oauth_token_url, :oauth_scopes,
                    :oauth_client_id_env, :oauth_client_secret_env, :api_key_header_name,
                    TRUE, :created_by, NOW(), NOW(), :transport_kind,
                    CAST(:capability_policy AS JSONB), CAST(:registered_redirect_uris AS JSONB)
                ) ON CONFLICT (connector_id) DO NOTHING
                RETURNING connector_id
                """
            ),
            {
                **row,
                "capability_policy": json.dumps(row["capability_policy"], sort_keys=True),
                "registered_redirect_uris": json.dumps(row["registered_redirect_uris"]),
            },
        )
        # A concurrent, non-cooperating operator may have inserted a row. The
        # caller re-reads and validates it under the same transaction instead
        # of assuming this insert won.
        _ = result

    def verify(self) -> dict[str, Any]:
        assert_google_drive_uat_registry_target()
        with self._db.engine.connect() as connection:
            # Server attestation must stay the first database query in this path.
            assert_connected_google_drive_uat_database(connection)
            row = self._load(connection, lock=False)
            if row is None or not _row_matches_policy(row, require_active=True):
                raise DriveUatRegistryProvisioningError("Drive registry policy is unavailable")
            return self._summary(status="verified")

    def activate(self) -> dict[str, Any]:
        """Create/activate the row only when all known configuration is exact."""

        assert_google_drive_uat_registry_target()
        with self._db.engine.begin() as connection:
            # Server attestation must stay the first database query in this path.
            assert_connected_google_drive_uat_database(connection)
            connection.execute(
                text("SELECT pg_advisory_xact_lock(hashtext(:lock_key))"),
                {"lock_key": "external-connector:google_drive:uat"},
            )
            row = self._load(connection, lock=True)
            if row is None:
                self._insert(connection)
                row = self._load(connection, lock=True)
                if row is None:
                    raise DriveUatRegistryProvisioningError("Drive registry policy is unavailable")
                action = "activated"
            elif not _row_matches_policy(row, require_active=False):
                # Do not overwrite a possibly deliberate or compromised
                # operator row. Investigate and remediate drift explicitly.
                raise DriveUatRegistryProvisioningError("Drive registry policy drifted")
            elif row.get("is_active") is not True:
                connection.execute(
                    text(
                        """
                        UPDATE external_mcp_connectors
                        SET is_active = TRUE, updated_at = NOW()
                        WHERE connector_id = :connector_id
                        """
                    ),
                    {"connector_id": CONNECTOR_ID},
                )
                row = self._load(connection, lock=True)
                action = "activated"
            else:
                action = "verified"

            if row is None or not _row_matches_policy(row, require_active=True):
                raise DriveUatRegistryProvisioningError("Drive registry policy is unavailable")
            return self._summary(status=action)

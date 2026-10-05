"""Curated and owner-private definitions in one external MCP registry.

Operator-curated definitions and private owner registrations share one table.
Only the former appear in the environment-wide catalog. Registration creates
configuration, not a connected grant or permission to execute a tool.
`enterprise_crm_registry` stays CRM-only and untouched.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from db.db_client import DatabaseExecutionError, get_db
from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.connector_dev_runtime import loopback_development_origin
from hushh_mcp.services.curated_connector_manifest import all_manifests
from hushh_mcp.services.external_mcp_connector_descriptor import descriptor_to_row_values
from hushh_mcp.services.mcp_public_http import validate_mcp_endpoint


class ConnectorRegistrationError(RuntimeError):
    """Safe registration failure; never include SQL, endpoints or credentials."""

    def __init__(self, code: str, *, status_code: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


_MAX_PRIVATE_CONNECTORS = 32


def _clean(value: object | None) -> str:
    return str(value or "").strip()


@dataclass(frozen=True)
class ExternalMcpConnectorDefinition:
    connector_id: str
    display_name: str
    description: str
    mcp_endpoint: str
    auth_style: str  # "api_key" | "oauth"
    oauth_authorize_url: str | None
    oauth_token_url: str | None
    oauth_scopes: tuple[str, ...]
    oauth_client_id_env: str | None
    oauth_client_secret_env: str | None
    api_key_header_name: str | None
    is_active: bool
    transport_kind: str = "mcp"
    capability_policy: dict[str, Any] = field(default_factory=dict)
    registered_redirect_uris: tuple[str, ...] = ()
    owner_user_id: str | None = None

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "ExternalMcpConnectorDefinition":
        scopes_raw = _clean(row.get("oauth_scopes"))
        return cls(
            connector_id=_clean(row.get("connector_id")),
            display_name=_clean(row.get("display_name")),
            description=_clean(row.get("description")),
            mcp_endpoint=_clean(row.get("mcp_endpoint")),
            auth_style=_clean(row.get("auth_style")),
            oauth_authorize_url=_clean(row.get("oauth_authorize_url")) or None,
            oauth_token_url=_clean(row.get("oauth_token_url")) or None,
            oauth_scopes=tuple(scopes_raw.split()) if scopes_raw else (),
            oauth_client_id_env=_clean(row.get("oauth_client_id_env")) or None,
            oauth_client_secret_env=_clean(row.get("oauth_client_secret_env")) or None,
            api_key_header_name=_clean(row.get("api_key_header_name")) or None,
            is_active=bool(row.get("is_active") or row.get("owner_enabled")),
            owner_user_id=_clean(row.get("user_id")) or None,
            transport_kind=_clean(row.get("transport_kind")) or "mcp",
            capability_policy=row.get("capability_policy")
            if isinstance(row.get("capability_policy"), dict)
            else {},
            registered_redirect_uris=tuple(row.get("registered_redirect_uris") or ()),
        )

    def to_public_dict(self) -> dict[str, Any]:
        """Client-facing shape -- never includes the OAuth client secret env
        name or the raw MCP endpoint, just enough to render a connect card."""
        return {
            "connectorId": self.connector_id,
            "displayName": self.display_name,
            "description": self.description,
            "authStyle": self.auth_style,
        }


# The environment whose redirect addresses a local run derives its rows from.
_DEVELOPMENT_MANIFEST_ENVIRONMENT = "uat"


def _development_definitions() -> dict[str, ExternalMcpConnectorDefinition]:
    """Manifest-derived curated definitions; empty outside a loopback development runtime.

    Localhost reads and writes the same database as UAT, so it must neither trust
    nor edit the shared registry row of a manifest-backed provider: a stale row
    shows a dead card, and "fixing" it from a laptop changes UAT. Instead the
    effective row is derived from the checked-in manifest -- read-only, through
    the same builder `apply` writes with -- so a local run sees exactly what a
    correct `apply` would produce without touching the shared registry.

    This can never turn on in a deployed process: it needs ENVIRONMENT=development
    and a plain-http loopback frontend origin (see `connector_dev_runtime`).
    """
    if loopback_development_origin() is None:
        return {}
    definitions: dict[str, ExternalMcpConnectorDefinition] = {}
    for connector_id, manifest in all_manifests().items():
        if _DEVELOPMENT_MANIFEST_ENVIRONMENT not in manifest.redirect_uris:
            continue
        values = descriptor_to_row_values(manifest.to_descriptor(_DEVELOPMENT_MANIFEST_ENVIRONMENT))
        definitions[connector_id] = ExternalMcpConnectorDefinition.from_row(
            {**values, "is_active": True, "user_id": None}
        )
    return definitions


def _with_development_manifests(
    definitions: list[ExternalMcpConnectorDefinition],
) -> list[ExternalMcpConnectorDefinition]:
    """Replace each curated row a manifest covers with its manifest-derived form.

    Only operator-owned rows (no owner) are replaced; a private owner row is
    never touched, and a manifest-backed provider with no row at all is added.
    """
    overlay = _development_definitions()
    if not overlay:
        return definitions
    kept = [
        item
        for item in definitions
        if not (item.owner_user_id is None and item.connector_id in overlay)
    ]
    return sorted(
        [*kept, *overlay.values()], key=lambda item: (item.display_name, item.connector_id)
    )


class ExternalConnectorRegistryService:
    def __init__(self, db: Any | None = None) -> None:
        self.db = db or get_db()

    async def _execute(
        self, sql: str, params: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        try:
            result = await asyncio.to_thread(self.db.execute_raw, sql, params)
        except DatabaseExecutionError:
            raise ConnectorRegistrationError(
                "connector_registry_unavailable", status_code=503
            ) from None
        return result.data or []

    async def register_private(
        self,
        *,
        user_id: str,
        registration_id: UUID,
        display_name: str,
        endpoint: str,
        auth_style: Literal["api_key", "oauth"],
    ) -> ExternalMcpConnectorDefinition:
        """Register configuration, never authenticate, discover or authorize tools.

        The browser supplies a fresh registration UUID and reuses it for retries.
        The server binds it to the authenticated owner. A changed draft needs a
        fresh UUID; reset/removed registrations cannot be revived by replay.
        """
        if not user_id or user_id != user_id.strip() or not isinstance(registration_id, UUID):
            raise ConnectorRegistrationError("invalid_registration")
        name = display_name.strip()
        if not name or len(name) > 100 or any(ord(c) < 32 for c in name):
            raise ConnectorRegistrationError("invalid_connector_name")
        if auth_style not in {"api_key", "oauth"}:
            raise ConnectorRegistrationError("invalid_connector_auth")
        validate_mcp_endpoint(endpoint)
        connector_id = (
            "custom_"
            + uuid5(
                NAMESPACE_URL,
                json.dumps(
                    ["hushh-private-mcp", user_id, str(registration_id)], separators=(",", ":")
                ),
            ).hex
        )
        params = dict(
            user_id=user_id,
            connector_id=connector_id,
            name=name,
            endpoint=endpoint,
            auth_style=auth_style,
        )

        def register() -> ExternalMcpConnectorDefinition:
            try:
                with self.db.engine.begin() as connection:
                    connection.execute(text("SET LOCAL statement_timeout = '5s'"))
                    connection.execute(text("SET LOCAL lock_timeout = '2s'"))
                    lock_connection_graph_users(connection, user_ids=[user_id])
                    existing = (
                        connection.execute(
                            text("""SELECT * FROM external_mcp_connectors
                            WHERE connector_id=:connector_id AND user_id=:user_id"""),
                            params,
                        )
                        .mappings()
                        .first()
                    )
                    if existing:
                        if (
                            not existing["owner_enabled"]
                            or existing["display_name"] != name
                            or existing["mcp_endpoint"] != endpoint
                            or existing["auth_style"] != auth_style
                        ):
                            raise ConnectorRegistrationError(
                                "registration_revision_conflict", status_code=409
                            )
                        return ExternalMcpConnectorDefinition.from_row(dict(existing))
                    count = connection.execute(
                        text("""SELECT count(*) FROM external_mcp_connectors
                            WHERE user_id=:user_id AND owner_enabled=TRUE"""),
                        params,
                    ).scalar_one()
                    if count >= _MAX_PRIVATE_CONNECTORS:
                        raise ConnectorRegistrationError(
                            "connector_registration_limit", status_code=409
                        )
                    row = (
                        connection.execute(
                            text("""INSERT INTO external_mcp_connectors
                            (connector_id, display_name, mcp_endpoint, auth_style,
                             user_id, created_by, is_active, owner_enabled, transport_kind,
                             capability_policy, api_key_header_name)
                            VALUES (:connector_id, :name, :endpoint, :auth_style,
                                    :user_id, :user_id, FALSE, TRUE, 'mcp', '{}', 'Authorization')
                            RETURNING *"""),
                            params,
                        )
                        .mappings()
                        .one()
                    )
                    return ExternalMcpConnectorDefinition.from_row(dict(row))
            except SQLAlchemyError:
                raise ConnectorRegistrationError(
                    "connector_registry_unavailable", status_code=503
                ) from None

        return await asyncio.to_thread(register)

    async def list_active_connectors(
        self, *, user_id: str | None = None
    ) -> list[ExternalMcpConnectorDefinition]:
        # Calls without an authenticated owner remain curated-only. Preserve
        # this query for pre-migration/legacy callers; private rows are always
        # is_active=false at the database boundary.
        if user_id:
            rows = await self._execute(
                """SELECT * FROM external_mcp_connectors
                   WHERE (user_id IS NULL AND is_active = TRUE)
                      OR (user_id = :user_id AND owner_enabled = TRUE)
                   ORDER BY display_name ASC, connector_id ASC""",
                {"user_id": user_id},
            )
            return _with_development_manifests(
                [ExternalMcpConnectorDefinition.from_row(row) for row in rows]
            )
        rows = await self._execute(
            """SELECT * FROM external_mcp_connectors
               WHERE is_active = TRUE
               ORDER BY display_name ASC"""
        )
        return _with_development_manifests(
            [ExternalMcpConnectorDefinition.from_row(row) for row in rows]
        )

    async def list_curated_connectors(
        self, *, include_inactive: bool = False
    ) -> list[ExternalMcpConnectorDefinition]:
        """List operator-owned rows only.

        Settings uses the explicit inactive form solely to retain an owner's
        recovery/disconnect row after an operator deactivates a connector. It
        never turns an inactive row back into an executable catalog entry.
        """
        rows = await self._execute(
            """SELECT * FROM external_mcp_connectors
               WHERE user_id IS NULL
                 AND (:include_inactive = TRUE OR is_active = TRUE)
               ORDER BY display_name ASC, connector_id ASC""",
            {"include_inactive": include_inactive},
        )
        return _with_development_manifests(
            [ExternalMcpConnectorDefinition.from_row(row) for row in rows]
        )

    async def get_connector(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
        include_inactive: bool = False,
    ) -> ExternalMcpConnectorDefinition | None:
        found = await self._get_connector_row(
            connector_id, user_id=user_id, include_inactive=include_inactive
        )
        derived = _development_definitions().get(_clean(connector_id))
        if derived is not None and (found is None or found.owner_user_id is None):
            return derived
        return found

    async def _get_connector_row(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
        include_inactive: bool = False,
    ) -> ExternalMcpConnectorDefinition | None:
        if user_id:
            rows = await self._execute(
                """SELECT * FROM external_mcp_connectors
                   WHERE connector_id = :connector_id
                     AND ((user_id IS NULL AND is_active = TRUE)
                       OR (user_id = :user_id AND owner_enabled = TRUE))""",
                {"connector_id": _clean(connector_id), "user_id": user_id},
            )
            return ExternalMcpConnectorDefinition.from_row(rows[0]) if rows else None
        if include_inactive:
            # Never widen anonymous/internal lookup to private owner rows:
            # this escape hatch exists only for a curated OAuth disconnect.
            rows = await self._execute(
                """SELECT * FROM external_mcp_connectors
                   WHERE connector_id = :connector_id AND user_id IS NULL""",
                {"connector_id": _clean(connector_id)},
            )
        else:
            rows = await self._execute(
                """SELECT * FROM external_mcp_connectors
                   WHERE connector_id = :connector_id AND is_active = TRUE""",
                {"connector_id": _clean(connector_id)},
            )
        if not rows:
            return None
        return ExternalMcpConnectorDefinition.from_row(rows[0])


_singleton: ExternalConnectorRegistryService | None = None


def get_external_connector_registry_service() -> ExternalConnectorRegistryService:
    global _singleton
    if _singleton is None:
        _singleton = ExternalConnectorRegistryService()
    return _singleton

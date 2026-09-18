"""Operator-curated catalog of external MCP connectors.

Mirrors `crm_registry_repo.py`'s shape (a small, environment-wide table any
signed-in user can read the *catalog* of, but only an operator can write to
via `scripts/ops/configure_external_mcp_connector.py`) rather than
`enterprise_crm_registry` itself, which stays CRM-only and untouched.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from db.db_client import get_db


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
            is_active=bool(row.get("is_active")),
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


class ExternalConnectorRegistryService:
    def __init__(self, db: Any | None = None) -> None:
        self.db = db or get_db()

    async def _execute(self, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        result = await asyncio.to_thread(self.db.execute_raw, sql, params)
        return result.data or []

    async def list_active_connectors(self) -> list[ExternalMcpConnectorDefinition]:
        rows = await self._execute(
            """SELECT * FROM external_mcp_connectors
               WHERE is_active = TRUE
               ORDER BY display_name ASC"""
        )
        return [ExternalMcpConnectorDefinition.from_row(row) for row in rows]

    async def get_connector(self, connector_id: str) -> ExternalMcpConnectorDefinition | None:
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

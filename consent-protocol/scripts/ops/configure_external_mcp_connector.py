#!/usr/bin/env python3
"""Operator CLI for external-mcp-connector.v1 check/probe/apply/deactivate.

This is how a developer adds a real external MCP connector (Notion,
HubSpot, ...) to the interface: describe it in a local JSON descriptor,
probe it against the real endpoint to confirm it's reachable, then apply to
write it into `external_mcp_connectors`. No code change needed per
connector -- Chat's governed `RegisteredMcpToolset` and the
`/one/profile/connectors` page both read this registry, not a hardcoded list.

Usage:
    python3 scripts/ops/configure_external_mcp_connector.py check connector.json
    python3 scripts/ops/configure_external_mcp_connector.py probe connector.json
    python3 scripts/ops/configure_external_mcp_connector.py apply connector.json --activate --operator you@hushh.ai
    python3 scripts/ops/configure_external_mcp_connector.py deactivate notion --operator you@hushh.ai
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from db.db_client import get_db  # noqa: E402
from hushh_mcp.services.external_mcp_client import (  # noqa: E402
    ExternalMcpAuthError,
    ExternalMcpError,
    list_tools,
)
from hushh_mcp.services.external_mcp_connector_descriptor import (  # noqa: E402
    ExternalMcpConnectorDescriptorError,
    ValidatedExternalMcpConnectorDescriptor,
    load_and_validate_descriptor,
)


def _redacted_summary(descriptor: ValidatedExternalMcpConnectorDescriptor) -> dict[str, Any]:
    raw = descriptor.raw
    return {
        "connectorId": raw.get("connectorId"),
        "displayName": raw.get("displayName"),
        "authStyle": raw.get("authStyle"),
        "mcpEndpoint": raw.get("mcpEndpoint"),
    }


async def _probe(descriptor: ValidatedExternalMcpConnectorDescriptor) -> dict[str, Any]:
    """A probe never has a real per-user credential to send. When the server
    allows anonymous tool discovery this confirms reachability and lists what
    it offers, so an operator can sanity-check a descriptor before any user
    can reach it. Many real MCP servers (Notion, HubSpot confirmed live) gate
    every call, including list_tools, behind authentication -- getting an
    auth challenge back still proves the endpoint is live and speaking MCP
    correctly. Only a request that never lands at all (DNS failure, connection
    refused, timeout, non-MCP response) means the descriptor itself is wrong."""
    raw = descriptor.raw
    try:
        tools = await list_tools(endpoint=str(raw["mcpEndpoint"]))
    except ExternalMcpAuthError:
        return {"toolCount": None, "toolNames": None, "requiresAuthForDiscovery": True}
    except ExternalMcpError as error:
        raise ExternalMcpConnectorDescriptorError(
            f"Could not reach {raw['mcpEndpoint']}: {error}"
        ) from error
    return {
        "toolCount": len(tools),
        "toolNames": sorted(tool["name"] for tool in tools),
        "requiresAuthForDiscovery": False,
    }


def _apply(descriptor: ValidatedExternalMcpConnectorDescriptor, *, operator: str) -> dict[str, Any]:
    raw = descriptor.raw
    db = get_db()
    scopes_csv = " ".join(raw.get("oauthScopes") or [])
    capability_policy = json.dumps(
        {
            "version": 1,
            "chat": raw.get("chatAdmission"),
            **({"tools": raw["toolAllowlist"]} if "toolAllowlist" in raw else {}),
        }
    )
    redirect_uris = json.dumps(raw.get("registeredRedirectUris") or [])
    result = db.execute_raw(
        """INSERT INTO external_mcp_connectors (
             connector_id, display_name, description, mcp_endpoint, auth_style,
             oauth_authorize_url, oauth_token_url, oauth_scopes,
             oauth_client_id_env, oauth_client_secret_env, api_key_header_name,
             transport_kind, capability_policy, registered_redirect_uris,
             is_active, created_by, created_at, updated_at
           ) VALUES (
             :connector_id, :display_name, :description, :mcp_endpoint, :auth_style,
             :oauth_authorize_url, :oauth_token_url, :oauth_scopes,
             :oauth_client_id_env, :oauth_client_secret_env, :api_key_header_name,
             'mcp', CAST(:capability_policy AS JSONB), CAST(:redirect_uris AS JSONB),
             TRUE, :operator, NOW(), NOW()
           ) ON CONFLICT (connector_id) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             description = EXCLUDED.description,
             mcp_endpoint = EXCLUDED.mcp_endpoint,
             auth_style = EXCLUDED.auth_style,
             oauth_authorize_url = EXCLUDED.oauth_authorize_url,
             oauth_token_url = EXCLUDED.oauth_token_url,
             oauth_scopes = EXCLUDED.oauth_scopes,
             oauth_client_id_env = EXCLUDED.oauth_client_id_env,
             oauth_client_secret_env = EXCLUDED.oauth_client_secret_env,
             api_key_header_name = EXCLUDED.api_key_header_name,
             transport_kind = EXCLUDED.transport_kind,
             capability_policy = EXCLUDED.capability_policy,
             registered_redirect_uris = EXCLUDED.registered_redirect_uris,
             is_active = TRUE,
             updated_at = NOW()
           -- A private (per-user) registration shares this table but is never
           -- writable from here -- this CLI is the operator/curated path only.
           -- Without this guard, applying an operator descriptor for an id a
           -- user had privately registered would silently overwrite their row.
           WHERE external_mcp_connectors.user_id IS NULL
           RETURNING connector_id""",
        {
            "connector_id": raw["connectorId"],
            "display_name": raw["displayName"],
            "description": raw.get("description") or "",
            "mcp_endpoint": raw["mcpEndpoint"],
            "auth_style": raw["authStyle"],
            "oauth_authorize_url": raw.get("oauthAuthorizeUrl"),
            "oauth_token_url": raw.get("oauthTokenUrl"),
            "oauth_scopes": scopes_csv or None,
            "oauth_client_id_env": raw.get("oauthClientIdEnv"),
            "oauth_client_secret_env": raw.get("oauthClientSecretEnv"),
            "api_key_header_name": raw.get("apiKeyHeaderName"),
            "capability_policy": capability_policy,
            "redirect_uris": redirect_uris,
            "operator": operator,
        },
    )
    if not result.data:
        raise ExternalMcpConnectorDescriptorError(
            "Failed to write the connector registry row (it may be a private "
            "registration this CLI must never overwrite)."
        )
    return {"connectorId": raw["connectorId"], "status": "active"}


def _deactivate(connector_id: str, *, operator: str) -> dict[str, Any]:
    db = get_db()
    result = db.execute_raw(
        """UPDATE external_mcp_connectors
           SET is_active = FALSE, updated_at = NOW()
           WHERE connector_id = :connector_id
           RETURNING connector_id""",
        {"connector_id": connector_id},
    )
    if not result.data:
        raise ExternalMcpConnectorDescriptorError("External connector was not found.")
    _ = operator  # reserved for an audit trail once one exists for this table
    return {"connectorId": connector_id, "status": "deactivated"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("check", "probe", "apply"):
        sub = subparsers.add_parser(command)
        sub.add_argument("descriptor")
        if command == "apply":
            sub.add_argument("--activate", action="store_true", required=True)
            sub.add_argument("--operator", required=True)
    deactivate = subparsers.add_parser("deactivate")
    deactivate.add_argument("connector_id")
    deactivate.add_argument("--operator", required=True)
    args = parser.parse_args()

    try:
        if args.command == "deactivate":
            print(json.dumps(_deactivate(args.connector_id, operator=args.operator)))
            return 0
        descriptor = load_and_validate_descriptor(args.descriptor)
        if args.command == "check":
            print(json.dumps({**_redacted_summary(descriptor), "status": "valid"}, sort_keys=True))
            return 0
        probe_result = asyncio.run(_probe(descriptor))
        if args.command == "probe":
            print(json.dumps({**_redacted_summary(descriptor), **probe_result}, sort_keys=True))
            return 0
        print(json.dumps({**_apply(descriptor, operator=args.operator), **probe_result}))
        return 0
    except (ExternalMcpConnectorDescriptorError, ExternalMcpError) as error:
        print(json.dumps({"status": "error", "message": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

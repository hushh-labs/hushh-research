"""Current curated OAuth credentials through the existing lifecycle authority.

Provider refresh is shielded from turn cancellation because it can rotate a
single-use credential. No credential, provider error or secret enters a receipt.
"""

from __future__ import annotations

import asyncio
from logging import Logger
from typing import Any

from hushh_mcp.services.external_connector_credentials_service import (
    ExternalConnectorCredentialError,
)
from hushh_mcp.services.external_connector_curated_oauth import (
    CuratedConnectorOAuthError,
    CuratedNotConnectedError,
    curated_policy_hash,
)
from hushh_mcp.services.external_mcp_client import ExternalMcpError


def _consume_outcome(task: asyncio.Future[Any]) -> None:
    if not task.cancelled():
        task.exception()


async def current_curated_credential(
    owner: str, connector: Any, *, logger: Logger
) -> tuple[dict[str, Any], str]:
    from hushh_mcp.services.external_connector_oauth_service import (
        get_external_connector_oauth_service,
    )

    adapter = get_external_connector_oauth_service().curated()
    refresh = asyncio.ensure_future(
        adapter.current_credential(
            connector_id=connector.connector_id, user_id=owner, connector=connector
        )
    )
    try:
        row, secret = await asyncio.shield(refresh)
    except asyncio.CancelledError:
        refresh.add_done_callback(_consume_outcome)
        raise
    except CuratedNotConnectedError:
        raise ExternalMcpError("Connect this service first.", code="MCP_NOT_CONNECTED") from None
    except CuratedConnectorOAuthError as error:
        logger.warning(
            "mcp_curated_resolve connector=%s cause=%s status=%s",
            connector.connector_id,
            str(error).replace("_", "."),
            error.status_code,
        )
        if error.status_code == 401:
            raise ExternalMcpError(
                "Reconnect this service.", code="MCP_CREDENTIAL_EXPIRED"
            ) from None
        if str(error) == "connection_changed":
            raise ExternalMcpError(
                "Reconnect this service.", code="MCP_CONNECTION_CHANGED"
            ) from None
        raise ExternalMcpError(
            "Connector temporarily unavailable.", code="MCP_CONNECTOR_UNAVAILABLE"
        ) from None
    except ExternalConnectorCredentialError:
        raise ExternalMcpError("Reconnect this service.", code="MCP_CREDENTIAL_INVALID") from None
    if row.get("status") != "connected" or row.get("verified_policy_hash") != curated_policy_hash(
        connector
    ):
        raise ExternalMcpError("Reconnect this service.", code="MCP_CONNECTION_CHANGED")
    token = secret.get("accessToken")
    if (
        not isinstance(token, str)
        or not token.strip()
        or any(ord(c) < 32 or ord(c) == 127 for c in token)
    ):
        raise ExternalMcpError("Reconnect this service.", code="MCP_CREDENTIAL_INVALID")
    return row, token

"""Owner-bound consumer handoffs through the canonical MCP dispatch."""

import asyncio
import json
from typing import Literal
from urllib.parse import urlencode, urlsplit

from mcp.types import CallToolResult, TextContent
from pydantic import BaseModel, ConfigDict

from hushh_mcp.runtime_settings import get_app_runtime_settings
from hushh_mcp.services.consumer_mcp_connections import (
    ConsumerConnectionDenied,
    ConsumerMcpConnections,
    ConsumerSetupRequired,
    has_consumer_oauth_identity,
)
from hushh_mcp.services.consumer_mcp_memory import (
    ConsumerMcpMemory,
    ConsumerMemoryConflict,
    ConsumerMemoryInvalid,
    ConsumerMemoryUnavailable,
)
from mcp_modules.developer_context import get_current_developer_principal


class ConsumerConnectionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal[
        "private_agent_setup_required", "memory_approval_required", "memory_permission_saved"
    ]
    next_action: str
    secure_url: str
    connection_id: str | None = None
    generation: int | None = None
    grant_receipt: str | None = None


class ConsumerMemoryResult(BaseModel):
    model_config = ConfigDict(extra="allow")
    state: Literal["completed"]
    operation: str
    execution_target: Literal["owner_pod"]
    deployment_id: str
    next_action: str


def _result(payload: BaseModel) -> CallToolResult:
    result = payload.model_dump()
    return CallToolResult(
        structuredContent=result, content=[TextContent(type="text", text=json.dumps(result))]
    )


def _error(code: str, message: str) -> CallToolResult:
    return CallToolResult(
        isError=True,
        content=[
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "error_code": code,
                        "message": message,
                    }
                ),
            )
        ],
    )


async def handle_get_hussh_connection(arguments: dict) -> CallToolResult:
    """No model argument may supply identity, approve consent or provision compute."""
    if arguments:
        return _error("INVALID_ARGUMENTS", "This tool accepts no arguments.")
    principal = get_current_developer_principal()
    if not has_consumer_oauth_identity(principal):
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    origin = get_app_runtime_settings().app_frontend_origin
    parsed = urlsplit(origin or "")
    if (
        not origin
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
        or (
            parsed.scheme != "https"
            and not (
                parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
            )
        )
    ):
        return _error("SETUP_UNAVAILABLE", "The secure setup interface is unavailable.")
    origin = origin.rstrip("/")
    try:
        review = await asyncio.to_thread(ConsumerMcpConnections().prepare, principal)
    except ConsumerSetupRequired:
        return _result(
            ConsumerConnectionResult(
                state="private_agent_setup_required",
                secure_url=origin + "/one/setup/cloud",
                next_action="Open secure setup to connect your cloud and private agent. No infrastructure was purchased or provisioned by this tool.",
            )
        )
    except ConsumerConnectionDenied as error:
        return _error("CONNECTION_REFUSED", str(error))
    except Exception:
        return _error(
            "CONNECTION_UNAVAILABLE",
            "Connection authority is temporarily unavailable. Retry later.",
        )
    query = urlencode({"consumer": review.connection_id, "authorization": review.authorization_id})
    return _result(
        ConsumerConnectionResult(
            state="memory_permission_saved" if review.memory_access else "memory_approval_required",
            secure_url=origin + "/oauth/authorize?" + query,
            connection_id=review.connection_id,
            generation=review.generation,
            grant_receipt=review.grant_receipt,
            next_action=(
                "Memory permission is saved. You can now use the typed Hussh memory tools through your owner pod."
                if review.memory_access
                else "Open the secure link to review memory access. Only the authenticated owner can approve; never send vault keys or recovery material to this assistant."
            ),
        )
    )


async def _handle_memory(operation: str, arguments: dict) -> CallToolResult:
    principal = get_current_developer_principal()
    if not has_consumer_oauth_identity(principal):
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        result = await ConsumerMcpMemory().execute(
            principal, operation=operation, arguments=arguments
        )
    except ConsumerMemoryInvalid as error:
        return _error("INVALID_MEMORY_REQUEST", str(error))
    except ConsumerMemoryUnavailable:
        return _error(
            "OWNER_POD_UNAVAILABLE",
            "Your owner pod is not ready for memory access. Hussh did not use shared memory or a cloud fallback.",
        )
    except ConsumerMemoryConflict as error:
        return _error("MEMORY_REVISION_CONFLICT", str(error))
    except ConsumerConnectionDenied as error:
        return _error("MEMORY_ACCESS_REFUSED", str(error))
    except Exception:
        return _error("MEMORY_UNAVAILABLE", "Owner-pod memory is temporarily unavailable.")
    return _result(
        ConsumerMemoryResult.model_validate(
            {
                "state": "completed",
                "next_action": "The owner pod completed this memory operation.",
                **result,
            }
        )
    )


async def handle_read_hussh_memory(arguments: dict) -> CallToolResult:
    return await _handle_memory("read", arguments)


async def handle_save_hussh_memory(arguments: dict) -> CallToolResult:
    return await _handle_memory("save", arguments)


async def handle_correct_hussh_memory(arguments: dict) -> CallToolResult:
    return await _handle_memory("correct", arguments)


async def handle_export_hussh_memory(arguments: dict) -> CallToolResult:
    return await _handle_memory("export", arguments)

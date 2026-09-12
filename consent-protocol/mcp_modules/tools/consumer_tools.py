"""Owner-bound consumer handoffs through the canonical MCP dispatch."""

import asyncio
import json
from typing import Literal
from urllib.parse import urlencode, urlsplit

from mcp.types import CallToolResult, TextContent
from pydantic import BaseModel, ConfigDict, Field

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
from hushh_mcp.services.consumer_mcp_tasks import (
    ConsumerMcpTask,
    ConsumerTaskApprovalRequired,
    ConsumerTaskUnavailable,
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


class ConsumerConnectionItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connection_id: str = Field(..., max_length=128)
    generation: int = Field(..., ge=1)
    client_name: str = Field(..., max_length=160)
    memory_access: bool


class ConsumerConnectionsResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["available"]
    items: list[ConsumerConnectionItem] = Field(default_factory=list, max_length=100)
    next_cursor: str | None = Field(default=None, max_length=128)
    next_action: str


class ConsumerSetupStatusResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["not_started", "running", "waiting_for_pod", "ready", "failed", "stale"]
    status: str
    stage: str
    project_id: str | None = None
    stages: list[dict[str, str]]
    error_code: str | None = None
    next_action: str


class ConsumerCapability(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    description: str
    execution: Literal["owner_pod", "consent_service", "secure_handoff"]
    availability: Literal["approval_required", "contract_available", "secure_handoff"]


class ConsumerCapabilitiesResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["available"]
    capabilities: list[ConsumerCapability]
    next_action: str


class ConsumerReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid")
    receipt_id: str
    action: str
    issued_at: int
    expires_at: int | None = None
    event_kind: str


class ConsumerReceiptsResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["available"]
    items: list[ConsumerReceipt]
    next_action: str


class ConsumerDisconnectResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["disconnected"]
    connection_id: str
    generation: int
    next_action: str


class ConsumerMemoryRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(..., max_length=128)
    content: str = Field(..., max_length=4_000)
    updated_at: str = Field(default="", max_length=64)


class ConsumerMemoryPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    domain: str | None = Field(default=None, max_length=64)
    records: list[ConsumerMemoryRecord] = Field(default_factory=list, max_length=20)
    revision: int | None = Field(default=None, ge=0)
    saved: bool | None = None
    memory_id: str | None = Field(default=None, max_length=128)


class ConsumerMemoryResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["completed"]
    operation: str
    execution_target: Literal["owner_pod"]
    deployment_id: str
    result: ConsumerMemoryPayload
    next_action: str


class ConsumerTaskResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["completed"]
    execution_target: Literal["owner_pod"]
    deployment_id: str = Field(..., min_length=1, max_length=128)
    conversation_id: str = Field(..., min_length=1, max_length=128)
    response: str = Field(..., max_length=16_000)
    runtime_mode: str = Field(..., max_length=64)
    provider: str | None = Field(default=None, max_length=64)
    model: str | None = Field(default=None, max_length=128)
    delegation: dict[str, bool] | None = None
    next_action: str = Field(..., max_length=512)


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


def _secure_setup_origin() -> str | None:
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
        return None
    return origin.rstrip("/")


async def handle_get_hussh_connection(arguments: dict) -> CallToolResult:
    """No model argument may supply identity, approve consent or provision compute."""
    if arguments:
        return _error("INVALID_ARGUMENTS", "This tool accepts no arguments.")
    principal = get_current_developer_principal()
    if not has_consumer_oauth_identity(principal):
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    origin = _secure_setup_origin()
    if origin is None:
        return _error("SETUP_UNAVAILABLE", "The secure setup interface is unavailable.")
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


async def handle_get_hussh_setup_status(arguments: dict) -> CallToolResult:
    """Read the existing resumable setup job without starting or mutating it."""
    if arguments:
        return _error("INVALID_ARGUMENTS", "This tool accepts no arguments.")
    principal = get_current_developer_principal()
    if not has_consumer_oauth_identity(principal):
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    if _secure_setup_origin() is None:
        return _error("SETUP_UNAVAILABLE", "The secure setup interface is unavailable.")
    try:
        from hushh_mcp.services import byoc_setup_job_service as jobs  # noqa: PLC0415

        row = await jobs.ByocSetupJobRepo().get(str(principal.subject_firebase_uid or ""))
    except Exception:
        return _error("SETUP_STATUS_UNAVAILABLE", "Setup status is temporarily unavailable.")

    if not row:
        return _result(
            ConsumerSetupStatusResult(
                state="not_started",
                status="none",
                stage="",
                stages=[],
                next_action=(
                    "Open the secure setup page to connect your cloud and private agent. "
                    "This tool does not provision infrastructure."
                ),
            )
        )

    status = str(row.get("status") or "unknown")
    stage = str(row.get("stage") or "")[:64]
    stale = bool(jobs.is_stale(row))
    if stale and status == "running":
        state = "stale"
        next_action = (
            "Restart setup from the secure Hussh page; the previous job stopped advancing."
        )
    elif status == "running":
        state = "running"
        next_action = "Wait for the current setup job, then check this status again."
    elif status == "failed":
        state = "failed"
        next_action = "Review the secure setup page and retry the failed step."
    elif stage == "attached":
        state = "ready"
        next_action = "Call get_hussh_connection again to continue the owner approval flow."
    elif status == "recorded":
        state = "waiting_for_pod"
        next_action = "Finish private-agent enrollment in the secure Hussh setup page."
    else:
        state = "failed"
        next_action = "Review the secure setup page for the current recovery action."

    safe_stages = [
        {"stage": str(item.get("stage") or "")[:64], "at": str(item.get("at") or "")[:64]}
        for item in (row.get("stages") or [])
        if isinstance(item, dict) and item.get("stage")
    ]
    return _result(
        ConsumerSetupStatusResult(
            state=state,
            status=status[:32],
            stage=stage,
            project_id=str(row.get("project_id") or "")[:64] or None,
            stages=safe_stages,
            error_code=str(row.get("error_code") or "")[:64] or None,
            next_action=next_action,
        )
    )


async def handle_list_hussh_capabilities(arguments: dict) -> CallToolResult:
    """Project the authored MCP catalog for an owner-authenticated client."""
    if arguments:
        return _error("INVALID_ARGUMENTS", "This tool accepts no arguments.")
    principal = get_current_developer_principal()
    if not has_consumer_oauth_identity(principal):
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")

    from mcp_modules.developer_context import get_current_visible_tool_names  # noqa: PLC0415
    from mcp_modules.tools.definitions import get_tool_definitions  # noqa: PLC0415

    consumer_names = {
        "get_hussh_connection",
        "get_hussh_setup_status",
        "read_hussh_memory",
        "save_hussh_memory",
        "correct_hussh_memory",
        "export_hussh_memory",
        "list_hussh_capabilities",
        "list_hussh_connections",
        "list_hussh_receipts",
        "disconnect_hussh_connection",
        "delegate_hussh_task",
    }
    public_names = {
        "search-user-scopes",
        "prepare-campaign-context",
        "request-consent",
        "check-consent-status",
        "get-encrypted-scoped-export",
    }
    definitions = get_tool_definitions(
        allowed_tool_names=set(get_current_visible_tool_names()), schema_profile="standard"
    )
    capabilities: list[ConsumerCapability] = []
    for tool in definitions:
        name = str(tool.name)
        if name not in consumer_names and name not in public_names:
            continue
        if name in {"get_hussh_connection", "get_hussh_setup_status"}:
            execution = "secure_handoff"
            availability = "secure_handoff"
        elif name in {
            "read_hussh_memory",
            "save_hussh_memory",
            "correct_hussh_memory",
            "export_hussh_memory",
        }:
            execution = "owner_pod"
            availability = "approval_required"
        elif name == "disconnect_hussh_connection":
            execution = "consent_service"
            availability = "contract_available"
        elif name == "delegate_hussh_task":
            execution = "owner_pod"
            availability = "approval_required"
        elif name == "list_hussh_connections":
            execution = "consent_service"
            availability = "contract_available"
        else:
            execution = "consent_service"
            availability = "contract_available"
        capabilities.append(
            ConsumerCapability(
                name=name,
                description=str(tool.description or "")[:240],
                execution=execution,
                availability=availability,
            )
        )
    return _result(
        ConsumerCapabilitiesResult(
            state="available",
            capabilities=capabilities,
            next_action="Use the secure handoff for setup or approval-required owner-pod tools before attempting them.",
        )
    )


async def handle_list_hussh_connections(arguments: dict) -> CallToolResult:
    """List the current owner's external-assistant connections, without secrets."""
    if not isinstance(arguments, dict):
        return _error("INVALID_ARGUMENTS", "Arguments must be an object.")
    if set(arguments) - {"limit", "after"}:
        return _error("INVALID_ARGUMENTS", "Only limit and after are accepted.")
    limit = arguments.get("limit", 25)
    after = arguments.get("after", "")
    if type(limit) is not int or limit < 1 or limit > 100:
        return _error("INVALID_ARGUMENTS", "limit must be an integer between 1 and 100.")
    if not isinstance(after, str) or len(after) > 128:
        return _error("INVALID_ARGUMENTS", "after must be a cursor no longer than 128 characters.")
    principal = get_current_developer_principal()
    if not has_consumer_oauth_identity(principal):
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    owner = str(principal.subject_firebase_uid or "")
    if not owner:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        result = await asyncio.to_thread(
            ConsumerMcpConnections().list_connections,
            owner=owner,
            limit=limit,
            after=after,
        )
    except ConsumerConnectionDenied as error:
        return _error("CONNECTIONS_ACCESS_REFUSED", str(error))
    except Exception:
        return _error("CONNECTIONS_UNAVAILABLE", "Connections are temporarily unavailable.")
    return _result(
        ConsumerConnectionsResult(
            state="available",
            items=[ConsumerConnectionItem.model_validate(item) for item in result.get("items", [])],
            next_cursor=result.get("next_cursor"),
            next_action="Use disconnect_hussh_connection with the current generation to revoke one assistant.",
        )
    )


async def handle_list_hussh_receipts(arguments: dict) -> CallToolResult:
    """Read non-bearer consent receipts for the current owner connection."""
    if arguments:
        return _error("INVALID_ARGUMENTS", "This tool accepts no arguments.")
    principal = get_current_developer_principal()
    if not has_consumer_oauth_identity(principal):
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        result = await asyncio.to_thread(ConsumerMcpConnections().list_receipts, principal)
    except ConsumerConnectionDenied as error:
        return _error("RECEIPTS_ACCESS_REFUSED", str(error))
    except Exception:
        return _error("RECEIPTS_UNAVAILABLE", "Consent receipts are temporarily unavailable.")
    return _result(
        ConsumerReceiptsResult(
            state="available",
            items=list(result.get("items") or []),
            next_action="Receipt references are non-bearer audit records; reconnect or approve again when access is revoked.",
        )
    )


async def handle_disconnect_hussh_connection(arguments: dict) -> CallToolResult:
    """Revoke this assistant's standing grant after explicit confirmation."""
    if not isinstance(arguments, dict):
        return _error("INVALID_ARGUMENTS", "Arguments must be an object.")
    if arguments.get("confirm") is not True:
        return _error(
            "CONFIRMATION_REQUIRED",
            "Set confirm=true to disconnect this assistant. Your private agent and information remain intact.",
        )
    generation = arguments.get("generation")
    if type(generation) is not int or generation < 1:
        return _error("INVALID_ARGUMENTS", "generation must be a positive integer.")
    if set(arguments) != {"confirm", "generation"}:
        return _error("INVALID_ARGUMENTS", "Only confirm and generation are accepted.")
    principal = get_current_developer_principal()
    if not has_consumer_oauth_identity(principal):
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        result = await asyncio.to_thread(
            ConsumerMcpConnections().disconnect_current,
            principal,
            generation=generation,
        )
    except ConsumerConnectionDenied as error:
        return _error("DISCONNECT_REFUSED", str(error))
    except Exception:
        return _error(
            "DISCONNECT_UNAVAILABLE", "Assistant access could not be revoked. Retry later."
        )
    return _result(
        ConsumerDisconnectResult(
            state="disconnected",
            connection_id=str(result["connection_id"]),
            generation=int(result["generation"]),
            next_action="This assistant is disconnected. The private agent and its information remain available to you.",
        )
    )


async def handle_delegate_hussh_task(arguments: dict) -> CallToolResult:
    """Delegate one bounded task to the owner's existing private-agent turn."""
    principal = get_current_developer_principal()
    if not has_consumer_oauth_identity(principal):
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        result = await ConsumerMcpTask().execute(principal, arguments=arguments)
    except ValueError as error:
        return _error("INVALID_TASK_REQUEST", str(error))
    except ConsumerTaskApprovalRequired as error:
        return _error("ONE_APPROVAL_REQUIRED", str(error))
    except ConsumerTaskUnavailable as error:
        return _error("OWNER_POD_UNAVAILABLE", str(error))
    except ConsumerConnectionDenied as error:
        return _error("TASK_ACCESS_REFUSED", str(error))
    except Exception:
        return _error("TASK_UNAVAILABLE", "The owner-pod task could not be completed.")
    return _result(
        ConsumerTaskResult(
            **result,
            next_action="The owner pod completed the task; interrupted work is never replayed automatically.",
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

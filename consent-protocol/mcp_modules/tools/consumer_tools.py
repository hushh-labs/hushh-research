"""Owner-bound consumer handoffs through the canonical MCP dispatch."""

import asyncio
import json
import re
from typing import Literal
from urllib.parse import urlencode, urlsplit
from uuid import UUID

from mcp.types import CallToolResult, TextContent
from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.runtime_settings import get_app_runtime_settings
from hushh_mcp.services.consumer_mcp_connections import (
    ConsumerConnectionDenied,
    ConsumerMcpConnections,
    ConsumerSetupRequired,
    has_consumer_oauth_identity,
)
from hushh_mcp.services.consumer_mcp_finance import (
    ConsumerFinanceInvalid,
    ConsumerMcpFinance,
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
from hushh_mcp.services.google_calendar_service import get_google_calendar_service
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    GoogleConnectionService,
)
from mcp_modules.developer_context import get_current_developer_principal


def get_one_email_kyc_service():
    """Load the backend-only email service only when an email tool is called.

    The npm MCP package intentionally vendors the portable MCP runtime without
    the backend ``api`` package. Importing this service at module load would
    make public tool discovery fail even though developer/public clients never
    call the owner email tools. Keeping this wrapper also lets tests replace the
    service factory without importing backend modules.
    """
    from hushh_mcp.services.one_email_kyc_service import (  # noqa: PLC0415
        get_one_email_kyc_service as factory,
    )

    return factory()


def _is_one_email_kyc_error(error: Exception) -> bool:
    """Recognize the backend error without importing it during MCP startup."""
    try:
        from hushh_mcp.services.one_email_kyc_service import (  # noqa: PLC0415
            OneEmailKycError,
        )
    except Exception:  # noqa: BLE001 - optional backend is unavailable in the npm runtime
        return False

    return isinstance(error, OneEmailKycError)


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
    job_id: str | None = Field(default=None, max_length=128)
    project_id: str | None = None
    stages: list[dict[str, str]]
    error_code: str | None = None
    updated_at: str | None = Field(default=None, max_length=64)
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


_GOOGLE_SERVICES = ("gmail", "calendar", "drive", "contacts")
_GOOGLE_ACCESS_LEVELS = ("read", "manage")


class ConsumerIntegrationItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    service: Literal["gmail", "calendar", "drive", "contacts"]
    configured: bool
    connected: bool
    status: str = Field(..., max_length=32)
    access_level: str | None = Field(default=None, max_length=16)


class ConsumerIntegrationsResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["available"]
    items: list[ConsumerIntegrationItem] = Field(default_factory=list, max_length=4)
    next_action: str


class ConsumerDeviceItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_id: str = Field(..., max_length=128)
    device_name: str = Field(..., max_length=100)
    platform: str = Field(..., max_length=32)
    status: str = Field(..., max_length=32)
    puppy_state: Literal["ready", "busy", "offline", "revoked", "unavailable"]
    inference_ready: bool
    execution_target: Literal["puppy", "unavailable"]
    model: str | None = Field(default=None, max_length=128)
    capabilities: dict[str, bool] = Field(default_factory=dict)
    last_heartbeat_at: int | None = None


class ConsumerDevicesResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["available"]
    items: list[ConsumerDeviceItem] = Field(default_factory=list, max_length=100)
    next_action: str


class ConsumerPersonItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    public_person_ref: str | None = Field(default=None, max_length=128)
    display_name: str | None = Field(default=None, max_length=200)
    masked_email: str | None = Field(default=None, max_length=320)
    masked_phone: str | None = Field(default=None, max_length=32)
    relationship: Literal["connected", "pending_outgoing", "pending_incoming", "none"]
    is_ria: bool


class ConsumerPeopleResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["available"]
    items: list[ConsumerPersonItem] = Field(default_factory=list, max_length=100)
    page: int = Field(..., ge=1)
    has_more: bool
    audience: Literal["all", "people", "ria"]
    next_action: str


class ConsumerPersonScope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scope_ref: str = Field(..., max_length=128)
    label: str = Field(..., max_length=200)
    description: str = Field(..., max_length=512)
    domain: str | None = Field(default=None, max_length=64)
    sensitivity: str | None = Field(default=None, max_length=32)
    wildcard: bool


class ConsumerPersonGrant(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scope_ref: str | None = Field(default=None, max_length=128)
    label: str = Field(..., max_length=200)
    domain: str | None = Field(default=None, max_length=64)
    status: str = Field(..., max_length=32)
    expires_at: int | None = None


class ConsumerPersonProfileResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["available"]
    person_ref: str = Field(..., max_length=128)
    display_name: str = Field(..., max_length=200)
    photo_url: str | None = Field(default=None, max_length=2_048)
    verified_role: str | None = Field(default=None, max_length=128)
    relationship: Literal["connected", "pending_outgoing", "pending_incoming", "none"]
    requestable_scopes: list[ConsumerPersonScope] = Field(default_factory=list, max_length=100)
    grants: list[ConsumerPersonGrant] = Field(default_factory=list, max_length=100)
    next_action: str


class ConsumerGmailReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid")
    merchant: str = Field(default="Unknown merchant", max_length=256)
    amount: str | None = Field(default=None, max_length=64)
    currency: str | None = Field(default=None, max_length=16)
    receipt_date: str | None = Field(default=None, max_length=64)
    order_id: str | None = Field(default=None, max_length=128)
    subject: str | None = Field(default=None, max_length=512)


class ConsumerGmailReceiptsResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["available"]
    items: list[ConsumerGmailReceipt] = Field(default_factory=list, max_length=100)
    page: int = Field(..., ge=1)
    per_page: int = Field(..., ge=1, le=100)
    total: int = Field(..., ge=0)
    has_more: bool
    next_action: str


class ConsumerGmailStatusResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["available"]
    connected: bool
    status: str = Field(..., max_length=32)
    connection_state: str = Field(..., max_length=32)
    sync_state: str = Field(..., max_length=32)
    last_sync_status: str = Field(..., max_length=32)
    last_sync_at: str | None = Field(default=None, max_length=64)
    receipt_count: int = Field(..., ge=0)
    next_action: str


class ConsumerEmailWorkflowItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    workflow_id: str = Field(..., max_length=128)
    status: str = Field(..., max_length=32)
    subject: str | None = Field(default=None, max_length=512)
    counterparty_label: str | None = Field(default=None, max_length=256)
    draft_status: str | None = Field(default=None, max_length=32)
    send_status: str | None = Field(default=None, max_length=32)
    pkm_writeback_status: str | None = Field(default=None, max_length=32)
    created_at: str | None = Field(default=None, max_length=64)
    updated_at: str | None = Field(default=None, max_length=64)


class ConsumerEmailWorkflowsResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["available"]
    items: list[ConsumerEmailWorkflowItem] = Field(default_factory=list, max_length=50)
    limit: int = Field(..., ge=1, le=50)
    has_more: bool
    next_cursor: str | None = Field(default=None, max_length=500)
    next_action: str


class ConsumerEmailWorkflowResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["available"]
    item: ConsumerEmailWorkflowItem
    next_action: str


class ConsumerEmailWorkflowActionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["secure_handoff"]
    workflow_id: str = Field(..., max_length=128)
    action: Literal["review", "refresh", "approve_draft", "send", "archive"]
    secure_url: str = Field(..., max_length=2_048)
    next_action: str


class ConsumerConnectionRequestItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(..., max_length=128)
    direction: Literal["incoming", "outgoing"]
    status: str = Field(..., max_length=32)
    counterpart_display_name: str | None = Field(default=None, max_length=200)
    message: str | None = Field(default=None, max_length=1_000)
    created_at: str | None = Field(default=None, max_length=64)
    scope_count: int = Field(..., ge=0, le=50)


class ConsumerConnectionRequestsResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["available"]
    direction: Literal["incoming", "outgoing"]
    items: list[ConsumerConnectionRequestItem] = Field(default_factory=list, max_length=100)
    next_action: str


class ConsumerConnectionScopeProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scope_handle: str = Field(..., max_length=256)
    direction: Literal["requested", "offered"]
    label: str = Field(..., max_length=160)
    description: str = Field(..., max_length=512)
    status: str = Field(..., max_length=32)
    created_at: str | None = Field(default=None, max_length=64)
    expires_at: str | None = Field(default=None, max_length=64)
    resolved_at: str | None = Field(default=None, max_length=64)


class ConsumerConnectionRequestDetailResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["available"]
    request_id: str = Field(..., max_length=128)
    direction: Literal["incoming", "outgoing"]
    status: str = Field(..., max_length=32)
    counterpart_display_name: str | None = Field(default=None, max_length=200)
    message: str | None = Field(default=None, max_length=1_000)
    created_at: str | None = Field(default=None, max_length=64)
    scopes: list[ConsumerConnectionScopeProposal] = Field(default_factory=list, max_length=50)
    next_action: str


class ConsumerConnectionRequestMutationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["completed"]
    request_id: str = Field(..., max_length=128)
    status: Literal["pending", "accepted", "rejected", "cancelled"]
    connection_id: str | None = Field(default=None, max_length=128)
    scope_results: list[dict[str, str | bool]] = Field(default_factory=list, max_length=50)
    next_action: str


class ConsumerIntegrationConnectResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["approval_required", "connected"]
    service: Literal["gmail", "calendar", "drive", "contacts"]
    access_level: Literal["read", "manage"]
    secure_url: str | None = None
    expires_at: str | None = Field(default=None, max_length=64)
    next_action: str


class ConsumerIntegrationDisconnectResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["disconnected"]
    service: Literal["gmail", "calendar", "drive", "contacts"]
    next_action: str


class ConsumerCalendarPoint(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date_time: str | None = Field(default=None, max_length=64)
    date: str | None = Field(default=None, max_length=32)
    time_zone: str | None = Field(default=None, max_length=128)


class ConsumerCalendarAttendee(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str | None = Field(default=None, max_length=320)
    response_status: str | None = Field(default=None, max_length=32)


class ConsumerCalendarEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str | None = Field(default=None, max_length=256)
    etag: str | None = Field(default=None, max_length=256)
    title: str = Field(default="Untitled event", max_length=512)
    description: str | None = Field(default=None, max_length=4_000)
    location: str | None = Field(default=None, max_length=1_024)
    start: ConsumerCalendarPoint = Field(default_factory=ConsumerCalendarPoint)
    end: ConsumerCalendarPoint = Field(default_factory=ConsumerCalendarPoint)
    status: str | None = Field(default=None, max_length=32)
    attendees: list[ConsumerCalendarAttendee] = Field(default_factory=list, max_length=100)
    html_link: str | None = Field(default=None, max_length=2_048)
    updated: str | None = Field(default=None, max_length=64)


class ConsumerCalendarEventsResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["available"]
    events: list[ConsumerCalendarEvent] = Field(default_factory=list, max_length=50)
    time_zone: str | None = Field(default=None, max_length=128)
    has_more: bool
    next_action: str = Field(..., max_length=512)


class ConsumerCalendarOpening(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start_at: str = Field(..., max_length=64)
    end_at: str = Field(..., max_length=64)
    available_until: str = Field(..., max_length=64)


class ConsumerCalendarOpeningsResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["available"]
    time_min: str = Field(..., max_length=64)
    time_max: str = Field(..., max_length=64)
    time_zone: str | None = Field(default=None, max_length=128)
    duration_minutes: int = Field(..., ge=5, le=720)
    openings: list[ConsumerCalendarOpening] = Field(default_factory=list, max_length=20)
    next_action: str = Field(..., max_length=512)


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


class ConsumerTaskLifecycleResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal[
        "queued",
        "running",
        "completed",
        "failed",
        "cancel_requested",
        "cancelled",
        "interrupted",
    ]
    execution_target: Literal["owner_pod"]
    deployment_id: str = Field(..., min_length=1, max_length=128)
    task_id: str = Field(..., pattern=r"^task_[a-f0-9]{32}$")
    conversation_id: str = Field(..., min_length=1, max_length=128)
    runtime_provider: str | None = Field(default=None, max_length=32)
    puppy_device_id: str | None = Field(default=None, max_length=128)
    result: str | None = Field(default=None, max_length=16_000)
    error_code: str | None = Field(default=None, max_length=64)
    created_at_ms: int = Field(..., ge=1)
    updated_at_ms: int = Field(..., ge=1)
    generation: int = Field(..., ge=1)
    next_action: str = Field(..., max_length=512)


class ConsumerFinanceResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["completed"]
    operation: Literal["stock_analysis"]
    execution_target: Literal["owner_pod"]
    deployment_id: str = Field(..., min_length=1, max_length=128)
    conversation_id: str = Field(..., min_length=1, max_length=128)
    ticker: str = Field(..., min_length=1, max_length=20)
    risk_profile: Literal["conservative", "balanced", "aggressive"]
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
                job_id=None,
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
            job_id=str(row.get("job_id") or "")[:128] or None,
            project_id=str(row.get("project_id") or "")[:64] or None,
            stages=safe_stages,
            error_code=str(row.get("error_code") or "")[:64] or None,
            updated_at=str(row.get("updated_at") or "")[:64] or None,
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
        "list_hussh_devices",
        "list_hussh_calendar_events",
        "find_hussh_calendar_openings",
        "search_hussh_people",
        "get_hussh_person_profile",
        "list_hussh_people_connections",
        "list_hussh_connection_requests",
        "get_hussh_connection_request",
        "send_hussh_connection_request",
        "accept_hussh_connection_request",
        "reject_hussh_connection_request",
        "cancel_hussh_connection_request",
        "list_hussh_gmail_receipts",
        "get_hussh_gmail_status",
        "list_hussh_email_workflows",
        "get_hussh_email_workflow",
        "open_hussh_email_workflow",
        "list_hussh_integrations",
        "connect_hussh_integration",
        "disconnect_hussh_integration",
        "read_hussh_memory",
        "save_hussh_memory",
        "correct_hussh_memory",
        "export_hussh_memory",
        "list_hussh_capabilities",
        "list_hussh_connections",
        "list_hussh_receipts",
        "disconnect_hussh_connection",
        "delegate_hussh_task",
        "start_hussh_task",
        "get_hussh_task",
        "cancel_hussh_task",
        "analyze_hussh_finance",
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
        if name in {"get_hussh_connection", "get_hussh_setup_status", "connect_hussh_integration"}:
            execution = "secure_handoff"
            availability = "secure_handoff"
        elif name == "list_hussh_devices":
            execution = "consent_service"
            availability = "contract_available"
        elif name == "list_hussh_integrations":
            execution = "consent_service"
            availability = "contract_available"
        elif name in {"list_hussh_calendar_events", "find_hussh_calendar_openings"}:
            execution = "consent_service"
            availability = "approval_required"
        elif name in {
            "search_hussh_people",
            "get_hussh_person_profile",
            "list_hussh_people_connections",
        }:
            execution = "consent_service"
            availability = "contract_available"
        elif name == "list_hussh_connection_requests":
            execution = "consent_service"
            availability = "contract_available"
        elif name == "get_hussh_connection_request":
            execution = "consent_service"
            availability = "contract_available"
        elif name in {
            "send_hussh_connection_request",
            "accept_hussh_connection_request",
            "reject_hussh_connection_request",
            "cancel_hussh_connection_request",
        }:
            execution = "consent_service"
            availability = "approval_required"
        elif name in {
            "list_hussh_gmail_receipts",
            "get_hussh_gmail_status",
            "list_hussh_email_workflows",
            "get_hussh_email_workflow",
        }:
            execution = "consent_service"
            availability = "approval_required"
        elif name == "open_hussh_email_workflow":
            execution = "secure_handoff"
            availability = "secure_handoff"
        elif name == "disconnect_hussh_integration":
            execution = "consent_service"
            availability = "approval_required"
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
        elif name in {"start_hussh_task", "get_hussh_task", "cancel_hussh_task"}:
            execution = "owner_pod"
            availability = "approval_required"
        elif name == "analyze_hussh_finance":
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


def _consumer_owner(principal: object | None) -> str | None:
    if not has_consumer_oauth_identity(principal):
        return None
    owner = str(getattr(principal, "subject_firebase_uid", "") or "").strip()
    return owner or None


def _validate_google_service(
    arguments: dict, *, allow_access_level: bool = False
) -> tuple[str, str | None]:
    if not isinstance(arguments, dict):
        raise ValueError("arguments must be an object")
    allowed = {"service", "access_level"} if allow_access_level else {"service"}
    if not set(arguments).issubset(allowed) or "service" not in arguments:
        raise ValueError("only service and access_level are accepted")
    service = arguments.get("service")
    if not isinstance(service, str) or service not in _GOOGLE_SERVICES:
        raise ValueError("service must be gmail, calendar, drive, or contacts")
    access_level = arguments.get("access_level") if allow_access_level else None
    if access_level is not None and (
        not isinstance(access_level, str) or access_level not in _GOOGLE_ACCESS_LEVELS
    ):
        raise ValueError("access_level must be read or manage")
    if access_level == "manage" and service != "calendar":
        raise ValueError("manage access is currently supported for calendar only")
    return service, access_level


def _calendar_range(arguments: dict) -> tuple[str, str, int]:
    if not isinstance(arguments, dict):
        raise ValueError("arguments must be an object")
    allowed = {"start_at", "end_at", "max_results"}
    if set(arguments) - allowed or "start_at" not in arguments or "end_at" not in arguments:
        raise ValueError("start_at and end_at are required")
    start_at = arguments.get("start_at")
    end_at = arguments.get("end_at")
    if (
        not isinstance(start_at, str)
        or not start_at.strip()
        or len(start_at.strip()) > 64
        or not isinstance(end_at, str)
        or not end_at.strip()
        or len(end_at.strip()) > 64
    ):
        raise ValueError("start_at and end_at must be bounded ISO-8601 strings")
    max_results = arguments.get("max_results", 50)
    if type(max_results) is not int or not 1 <= max_results <= 50:
        raise ValueError("max_results must be an integer between 1 and 50")
    return start_at.strip(), end_at.strip(), max_results


def _calendar_opening_args(arguments: dict) -> tuple[str, str, int, int, list[str] | None]:
    if not isinstance(arguments, dict):
        raise ValueError("arguments must be an object")
    allowed = {"start_at", "end_at", "duration_minutes", "limit", "calendar_ids"}
    if set(arguments) - allowed or "start_at" not in arguments or "end_at" not in arguments:
        raise ValueError("start_at and end_at are required")
    start_at = arguments.get("start_at")
    end_at = arguments.get("end_at")
    if (
        not isinstance(start_at, str)
        or not start_at.strip()
        or len(start_at.strip()) > 64
        or not isinstance(end_at, str)
        or not end_at.strip()
        or len(end_at.strip()) > 64
    ):
        raise ValueError("start_at and end_at must be bounded ISO-8601 strings")
    duration = arguments.get("duration_minutes")
    if type(duration) is not int or not 5 <= duration <= 720:
        raise ValueError("duration_minutes must be an integer between 5 and 720")
    limit = arguments.get("limit", 3)
    if type(limit) is not int or not 1 <= limit <= 20:
        raise ValueError("limit must be an integer between 1 and 20")
    calendar_ids = arguments.get("calendar_ids")
    if calendar_ids is not None:
        if (
            not isinstance(calendar_ids, list)
            or len(calendar_ids) > 20
            or any(not isinstance(item, str) or not item.strip() for item in calendar_ids)
        ):
            raise ValueError("calendar_ids must contain at most 20 non-empty strings")
        calendar_ids = [item.strip() for item in calendar_ids]
    return start_at.strip(), end_at.strip(), duration, limit, calendar_ids


def _calendar_error(error: GoogleConnectionError) -> CallToolResult:
    status = int(getattr(error, "status_code", 502) or 502)
    if status == 401:
        return _error("CALENDAR_REAUTH_REQUIRED", "Reconnect your Google Calendar in Hussh.")
    if status == 403:
        return _error("CALENDAR_PERMISSION_REQUIRED", "Google Calendar permission is insufficient.")
    if status == 422:
        return _error("INVALID_CALENDAR_REQUEST", "The Calendar time range or options are invalid.")
    return _error("CALENDAR_UNAVAILABLE", "Google Calendar is temporarily unavailable.")


def _calendar_point(value: object) -> ConsumerCalendarPoint:
    raw = value if isinstance(value, dict) else {}
    return ConsumerCalendarPoint(
        date_time=(str(raw.get("dateTime") or "")[:64] or None),
        date=(str(raw.get("date") or "")[:32] or None),
        time_zone=(str(raw.get("timeZone") or "")[:128] or None),
    )


def _calendar_event(value: object) -> ConsumerCalendarEvent:
    raw = value if isinstance(value, dict) else {}
    attendees = raw.get("attendees")
    safe_attendees = [
        ConsumerCalendarAttendee(
            email=(str(item.get("email") or "")[:320] or None),
            response_status=(str(item.get("response_status") or "")[:32] or None),
        )
        for item in (attendees[:100] if isinstance(attendees, list) else [])
        if isinstance(item, dict)
    ]
    return ConsumerCalendarEvent(
        id=(str(raw.get("id") or "")[:256] or None),
        etag=(str(raw.get("etag") or "")[:256] or None),
        title=str(raw.get("title") or "Untitled event")[:512],
        description=(str(raw.get("description") or "")[:4_000] or None),
        location=(str(raw.get("location") or "")[:1_024] or None),
        start=_calendar_point(raw.get("start")),
        end=_calendar_point(raw.get("end")),
        status=(str(raw.get("status") or "")[:32] or None),
        attendees=safe_attendees,
        html_link=(str(raw.get("html_link") or "")[:2_048] or None),
        updated=(str(raw.get("updated") or "")[:64] or None),
    )


async def handle_list_hussh_calendar_events(arguments: dict) -> CallToolResult:
    """Read the owner's live primary Calendar through the existing service."""
    try:
        start_at, end_at, max_results = _calendar_range(arguments)
    except ValueError as error:
        return _error("INVALID_CALENDAR_REQUEST", str(error))
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        result = await get_google_calendar_service().list_events(
            user_id=owner,
            start_at=start_at,
            end_at=end_at,
            max_results=max_results,
        )
    except GoogleConnectionError as error:
        return _calendar_error(error)
    except Exception:
        return _error("CALENDAR_UNAVAILABLE", "Google Calendar is temporarily unavailable.")
    return _result(
        ConsumerCalendarEventsResult(
            state="available",
            events=[_calendar_event(item) for item in list(result.get("events") or [])[:50]],
            time_zone=(str(result.get("time_zone") or "")[:128] or None),
            has_more=bool(result.get("has_more")),
            next_action="Calendar data is live provider information; use the secure owner confirmation flow before changing events.",
        )
    )


async def handle_find_hussh_calendar_openings(arguments: dict) -> CallToolResult:
    """Find deterministic free slots without creating or changing an event."""
    try:
        start_at, end_at, duration, limit, calendar_ids = _calendar_opening_args(arguments)
    except ValueError as error:
        return _error("INVALID_CALENDAR_REQUEST", str(error))
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        result = await get_google_calendar_service().find_openings(
            user_id=owner,
            start_at=start_at,
            end_at=end_at,
            duration_minutes=duration,
            limit=limit,
            calendar_ids=calendar_ids,
        )
    except GoogleConnectionError as error:
        return _calendar_error(error)
    except Exception:
        return _error("CALENDAR_UNAVAILABLE", "Google Calendar is temporarily unavailable.")
    openings = [
        ConsumerCalendarOpening(
            start_at=str(item.get("start_at") or "")[:64],
            end_at=str(item.get("end_at") or "")[:64],
            available_until=str(item.get("available_until") or "")[:64],
        )
        for item in list(result.get("openings") or [])[:20]
        if isinstance(item, dict)
    ]
    return _result(
        ConsumerCalendarOpeningsResult(
            state="available",
            time_min=str(result.get("time_min") or "")[:64],
            time_max=str(result.get("time_max") or "")[:64],
            time_zone=(str(result.get("time_zone") or "")[:128] or None),
            duration_minutes=duration,
            openings=openings,
            next_action="These are availability suggestions only; creating or changing an event requires a separate confirmed owner action.",
        )
    )


async def handle_list_hussh_integrations(arguments: dict) -> CallToolResult:
    """List supported owner Google integrations without returning credentials."""
    if arguments:
        return _error("INVALID_ARGUMENTS", "This tool accepts no arguments.")
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    service = GoogleConnectionService()
    try:
        items = [
            ConsumerIntegrationItem(
                service=name,
                configured=bool(result.get("configured")),
                connected=bool(result.get("connected")),
                status=str(result.get("status") or "disconnected")[:32],
                access_level=(str(result.get("access_level") or "")[:16] or None),
            )
            for name in _GOOGLE_SERVICES
            for result in [service.status(user_id=owner, service=name)]
        ]
    except Exception:
        return _error(
            "INTEGRATIONS_UNAVAILABLE",
            "Connected-service status is temporarily unavailable.",
        )
    return _result(
        ConsumerIntegrationsResult(
            state="available",
            items=items,
            next_action="Use connect_hussh_integration for a secure provider approval or disconnect_hussh_integration to revoke one service.",
        )
    )


async def handle_list_hussh_devices(arguments: dict) -> CallToolResult:
    """List the owner's registered devices and truthful Puppy readiness."""
    if arguments:
        return _error("INVALID_ARGUMENTS", "This tool accepts no arguments.")
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        from api.routes.one.puppy_relay import BROKER  # noqa: PLC0415
        from hushh_mcp.services.trusted_device_service import (  # noqa: PLC0415
            TrustedDeviceService,
        )

        devices = await asyncio.to_thread(TrustedDeviceService().list_devices, user_id=owner)
        items: list[ConsumerDeviceItem] = []
        for raw in list(devices or [])[:100]:
            device_id = str(raw.get("device_id") or "").strip()
            if not device_id:
                continue
            status = str(raw.get("status") or "unavailable").strip().lower()[:32]
            if status != "active":
                items.append(
                    ConsumerDeviceItem(
                        device_id=device_id,
                        device_name=str(raw.get("device_name") or "")[:100],
                        platform=str(raw.get("platform") or "")[:32],
                        status=status,
                        puppy_state="revoked",
                        inference_ready=False,
                        execution_target="unavailable",
                        last_heartbeat_at=(
                            int(raw["last_heartbeat_at"])
                            if raw.get("last_heartbeat_at") is not None
                            else None
                        ),
                    )
                )
                continue
            try:
                relay = await BROKER.status((owner, device_id))
            except Exception:  # noqa: BLE001 - status must fail closed
                relay = {"state": "unavailable", "connected": False, "busy": False}
            relay_state = str(relay.get("state") or "unavailable").lower()
            if relay_state not in {"ready", "busy", "offline"}:
                relay_state = "unavailable"
            ready = relay_state in {"ready", "busy"} and bool(relay.get("connected"))
            capabilities = relay.get("capabilities")
            safe_capabilities = (
                {
                    str(key): bool(value)
                    for key, value in capabilities.items()
                    if key in {"tool_calling", "json_schema", "streaming"}
                    and isinstance(value, bool)
                }
                if isinstance(capabilities, dict)
                else {}
            )
            items.append(
                ConsumerDeviceItem(
                    device_id=device_id,
                    device_name=str(raw.get("device_name") or "")[:100],
                    platform=str(raw.get("platform") or "")[:32],
                    status=status,
                    puppy_state=relay_state,
                    inference_ready=ready,
                    execution_target="puppy" if ready else "unavailable",
                    model=(str(relay.get("model") or "")[:128] or None),
                    capabilities=safe_capabilities,
                    last_heartbeat_at=(
                        int(raw["last_heartbeat_at"])
                        if raw.get("last_heartbeat_at") is not None
                        else None
                    ),
                )
            )
    except Exception:
        return _error("DEVICES_UNAVAILABLE", "Registered-device status is temporarily unavailable.")
    return _result(
        ConsumerDevicesResult(
            state="available",
            items=items,
            next_action="Use a device_id with delegate_hussh_task only when inference_ready is true; enrollment and revocation remain in the secure owner interface.",
        )
    )


def _people_arguments(arguments: dict, *, connected: bool = False) -> tuple[str, int, int, str]:
    if not isinstance(arguments, dict):
        raise ValueError("arguments must be an object")
    allowed = {"query", "page", "limit", "audience"}
    if set(arguments) - allowed:
        raise ValueError("only query, page, limit, and audience are accepted")
    query = arguments.get("query", "")
    if not isinstance(query, str) or len(query.strip()) > 160:
        raise ValueError("query must be a string no longer than 160 characters")
    page = arguments.get("page", 1)
    max_limit = 100 if connected else 50
    limit = arguments.get("limit", 50 if connected else 20)
    if type(page) is not int or page < 1:
        raise ValueError("page must be a positive integer")
    if type(limit) is not int or not 1 <= limit <= max_limit:
        raise ValueError(f"limit must be an integer between 1 and {max_limit}")
    audience = arguments.get("audience", "all")
    allowed_audiences = {"all", "ria"} if connected else {"all", "people", "ria"}
    if not isinstance(audience, str) or audience not in allowed_audiences:
        raise ValueError("audience is invalid")
    return query.strip(), page, limit, audience


def _people_result(
    raw: dict, *, audience: str, page: int, relationship_default: str = "none"
) -> ConsumerPeopleResult:
    items: list[ConsumerPersonItem] = []
    for item in list(raw.get("items") or [])[:100]:
        if not isinstance(item, dict):
            continue
        relationship = str(item.get("relationship") or relationship_default)
        if relationship not in {"connected", "pending_outgoing", "pending_incoming", "none"}:
            relationship = "none"
        items.append(
            ConsumerPersonItem(
                public_person_ref=(str(item.get("publicPersonRef") or "")[:128] or None),
                display_name=(str(item.get("displayName") or "")[:200] or None),
                masked_email=(str(item.get("maskedEmail") or "")[:320] or None),
                masked_phone=(str(item.get("maskedPhone") or "")[:32] or None),
                relationship=relationship,
                is_ria=bool(item.get("isRia")),
            )
        )
    return ConsumerPeopleResult(
        state="available",
        items=items,
        page=max(1, page),
        has_more=bool(raw.get("hasMore")),
        audience=audience,
        next_action="Use the secure Hussh owner flow to send, accept, or change a connection; this read does not grant information access.",
    )


async def handle_search_hussh_people(arguments: dict) -> CallToolResult:
    """Search the owner-visible Connect directory without exposing raw IDs."""
    try:
        query, page, limit, audience = _people_arguments(arguments)
    except ValueError as error:
        return _error("INVALID_CONNECTIONS_REQUEST", str(error))
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        from hushh_mcp.services.connections_service import ConnectionsService  # noqa: PLC0415

        result = await asyncio.to_thread(
            ConnectionsService().search_directory,
            owner,
            query=query,
            page=page,
            limit=limit,
            audience=audience,
        )
    except Exception:
        return _error("CONNECTIONS_UNAVAILABLE", "The people directory is temporarily unavailable.")
    return _result(_people_result(result, audience=audience, page=page))


async def handle_get_hussh_person_profile(arguments: dict) -> CallToolResult:
    """Read a viewer-relative public profile and consentable scope labels."""
    if not isinstance(arguments, dict) or set(arguments) != {"public_person_ref"}:
        return _error("INVALID_CONNECTIONS_REQUEST", "Only public_person_ref is accepted.")
    public_person_ref = arguments.get("public_person_ref")
    if not isinstance(public_person_ref, str) or len(public_person_ref) > 128:
        return _error("INVALID_CONNECTIONS_REQUEST", "public_person_ref is invalid.")
    try:
        public_person_ref = str(UUID(public_person_ref.strip()))
    except (TypeError, ValueError):
        return _error("INVALID_CONNECTIONS_REQUEST", "public_person_ref is invalid.")
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        from hushh_mcp.services.person_profile_service import (  # noqa: PLC0415
            PersonProfileNotFoundError,
            PersonProfileService,
        )

        result = await PersonProfileService().get_viewer_profile(
            viewer_user_id=owner,
            public_person_ref=public_person_ref,
        )
    except PersonProfileNotFoundError:
        return _error("PERSON_NOT_FOUND", "That Hussh person profile is unavailable.")
    except Exception:
        return _error("CONNECTIONS_UNAVAILABLE", "The person profile is temporarily unavailable.")
    relationship = str((result.get("relationship") or {}).get("status") or "none")
    if relationship not in {"connected", "pending_outgoing", "pending_incoming", "none"}:
        relationship = "none"
    scopes: list[ConsumerPersonScope] = []
    for scope in list(result.get("requestableScopes") or [])[:100]:
        if not isinstance(scope, dict):
            continue
        scopes.append(
            ConsumerPersonScope(
                scope_ref=str(scope.get("scopeRef") or "")[:128],
                label=str(scope.get("label") or "Information")[:200],
                description=str(scope.get("description") or "")[:512],
                domain=(str(scope.get("domain") or "")[:64] or None),
                sensitivity=(str(scope.get("sensitivity") or "")[:32] or None),
                wildcard=bool(scope.get("wildcard")),
            )
        )
    grants: list[ConsumerPersonGrant] = []
    for grant in list(result.get("grants") or [])[:100]:
        if not isinstance(grant, dict):
            continue
        expires_at = grant.get("expiresAt")
        try:
            expires_at = int(expires_at) if expires_at is not None else None
        except (TypeError, ValueError):
            expires_at = None
        grants.append(
            ConsumerPersonGrant(
                scope_ref=(str(grant.get("scopeRef") or "")[:128] or None),
                label=str(grant.get("label") or "Shared information")[:200],
                domain=(str(grant.get("domain") or "")[:64] or None),
                status=str(grant.get("status") or "")[:32],
                expires_at=expires_at,
            )
        )
    return _result(
        ConsumerPersonProfileResult(
            state="available",
            person_ref=str(result.get("personRef") or public_person_ref)[:128],
            display_name=str(result.get("displayName") or "Hussh member")[:200],
            photo_url=(str(result.get("photoUrl") or "")[:2_048] or None),
            verified_role=(str(result.get("verifiedRole") or "")[:128] or None),
            relationship=relationship,
            requestable_scopes=scopes,
            grants=grants,
            next_action="Review these labels before sending or accepting a connection request; profile visibility does not grant access.",
        )
    )


async def handle_list_hussh_people_connections(arguments: dict) -> CallToolResult:
    """List existing owner connections through the canonical graph service."""
    try:
        query, page, limit, audience = _people_arguments(arguments, connected=True)
    except ValueError as error:
        return _error("INVALID_CONNECTIONS_REQUEST", str(error))
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        from hushh_mcp.services.connections_service import ConnectionsService  # noqa: PLC0415

        result = await asyncio.to_thread(
            ConnectionsService().list_connections_page,
            owner,
            query=query,
            page=page,
            limit=limit,
            audience=audience,
        )
    except Exception:
        return _error("CONNECTIONS_UNAVAILABLE", "Your connections are temporarily unavailable.")
    return _result(
        _people_result(result, audience=audience, page=page, relationship_default="connected")
    )


async def handle_list_hussh_connection_requests(arguments: dict) -> CallToolResult:
    """Read pending connection proposals without granting or changing scopes."""
    if not isinstance(arguments, dict) or set(arguments) - {"direction", "include_resolved"}:
        return _error(
            "INVALID_CONNECTIONS_REQUEST",
            "Only direction and include_resolved are accepted.",
        )
    direction = arguments.get("direction", "incoming")
    include_resolved = arguments.get("include_resolved", False)
    if direction not in {"incoming", "outgoing"}:
        return _error("INVALID_CONNECTIONS_REQUEST", "direction must be incoming or outgoing.")
    if type(include_resolved) is not bool:
        return _error("INVALID_CONNECTIONS_REQUEST", "include_resolved must be a boolean.")
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        from hushh_mcp.services.connections_service import ConnectionsService  # noqa: PLC0415

        result = await asyncio.to_thread(
            ConnectionsService().list_requests,
            owner,
            direction=direction,
            include_resolved=include_resolved,
        )
    except Exception:
        return _error("CONNECTIONS_UNAVAILABLE", "Connection requests are temporarily unavailable.")
    items: list[ConsumerConnectionRequestItem] = []
    for item in list(result or [])[:100]:
        if not isinstance(item, dict):
            continue
        scopes = item.get("scopes")
        items.append(
            ConsumerConnectionRequestItem(
                request_id=str(item.get("id") or "")[:128],
                direction=direction,
                status=str(item.get("status") or "pending")[:32],
                counterpart_display_name=(
                    str(item.get("counterpartDisplayName") or "")[:200] or None
                ),
                message=(str(item.get("message") or "")[:1_000] or None),
                created_at=_safe_gmail_timestamp(item.get("createdAt")),
                scope_count=min(50, len(scopes)) if isinstance(scopes, list) else 0,
            )
        )
    return _result(
        ConsumerConnectionRequestsResult(
            state="available",
            direction=direction,
            items=items,
            next_action="Review or resolve this request in the secure Hussh owner flow; a connection never grants information access by itself.",
        )
    )


def _connection_request_id(arguments: dict) -> str:
    if not isinstance(arguments, dict):
        raise ValueError("arguments must be an object")
    request_id = arguments.get("request_id")
    if not isinstance(request_id, str) or len(request_id) > 128:
        raise ValueError("request_id must be a valid connection request id")
    try:
        return str(UUID(request_id.strip()))
    except (TypeError, ValueError) as error:
        raise ValueError("request_id must be a valid connection request id") from error


def _connection_confirmation(arguments: dict, allowed: set[str]) -> tuple[str, bool]:
    request_id = _connection_request_id(arguments)
    if set(arguments) - allowed or arguments.get("confirm") is not True:
        raise ValueError("confirm must be true for a connection request change")
    return request_id, True


def _scope_handle_list(arguments: dict, name: str) -> list[str] | None:
    value = arguments.get(name)
    if value is None:
        return None
    if not isinstance(value, list) or len(value) > 50:
        raise ValueError(f"{name} must be a list of at most 50 scope handles")
    if any(not isinstance(item, str) or not item.strip() or len(item) > 256 for item in value):
        raise ValueError(f"{name} contains an invalid scope handle")
    return [item.strip() for item in value]


async def handle_get_hussh_connection_request(arguments: dict) -> CallToolResult:
    """Read one request and its reviewable scope labels for owner confirmation."""
    try:
        request_id = _connection_request_id(arguments)
        if set(arguments) != {"request_id"}:
            raise ValueError("only request_id is accepted")
    except ValueError as error:
        return _error("INVALID_CONNECTIONS_REQUEST", str(error))
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        from hushh_mcp.services.connections_service import ConnectionsService  # noqa: PLC0415

        service = ConnectionsService()
        match = None
        direction = None
        for candidate_direction in ("incoming", "outgoing"):
            rows = await asyncio.to_thread(
                service.list_requests,
                owner,
                direction=candidate_direction,
                include_resolved=True,
            )
            for row in rows or []:
                if str(row.get("id") or "") == request_id:
                    match = row
                    direction = candidate_direction
                    break
            if match is not None:
                break
        if match is None or direction is None:
            return _error("CONNECTION_REQUEST_NOT_FOUND", "That connection request is unavailable.")
        history = await asyncio.to_thread(service.get_scope_proposal_history, owner, request_id)
    except Exception:
        return _error(
            "CONNECTIONS_UNAVAILABLE", "The connection request is temporarily unavailable."
        )
    scopes: list[ConsumerConnectionScopeProposal] = []
    for scope in list(history.get("items") or [])[:50]:
        if not isinstance(scope, dict):
            continue
        proposal_direction = str(scope.get("direction") or "")
        if proposal_direction not in {"requested", "offered"}:
            continue
        scopes.append(
            ConsumerConnectionScopeProposal(
                scope_handle=str(scope.get("scopeHandle") or "")[:256],
                direction=proposal_direction,
                label=str(scope.get("label") or "Connection capability")[:160],
                description=str(scope.get("description") or "")[:512],
                status=str(scope.get("status") or "")[:32],
                created_at=_safe_gmail_timestamp(scope.get("createdAt")),
                expires_at=_safe_gmail_timestamp(scope.get("expiresAt")),
                resolved_at=_safe_gmail_timestamp(scope.get("resolvedAt")),
            )
        )
    return _result(
        ConsumerConnectionRequestDetailResult(
            state="available",
            request_id=request_id,
            direction=direction,
            status=str(match.get("status") or "")[:32],
            counterpart_display_name=(str(match.get("counterpartDisplayName") or "")[:200] or None),
            message=(str(match.get("message") or "")[:1_000] or None),
            created_at=_safe_gmail_timestamp(match.get("createdAt")),
            scopes=scopes,
            next_action="Review the capability labels, then use the confirmed accept, reject, or cancel action.",
        )
    )


async def handle_send_hussh_connection_request(arguments: dict) -> CallToolResult:
    try:
        if not isinstance(arguments, dict):
            raise ValueError("arguments must be an object")
        allowed = {
            "query",
            "message",
            "requested_scope_handles",
            "offered_scope_handles",
            "confirm",
        }
        if set(arguments) - allowed or arguments.get("confirm") is not True:
            raise ValueError("confirm must be true and only supported request fields are accepted")
        query = arguments.get("query")
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= 160:
            raise ValueError("query must be between 1 and 160 characters")
        message = arguments.get("message")
        if message is not None and (not isinstance(message, str) or len(message) > 1_000):
            raise ValueError("message must be at most 1,000 characters")
        requested = _scope_handle_list(arguments, "requested_scope_handles")
        offered = _scope_handle_list(arguments, "offered_scope_handles")
    except ValueError as error:
        return _error("INVALID_CONNECTIONS_REQUEST", str(error))
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        from hushh_mcp.services.connections_service import (  # noqa: PLC0415
            ConnectionsError,
            ConnectionsService,
        )

        result = await asyncio.to_thread(
            ConnectionsService().create_request,
            owner,
            query=query.strip(),
            message=message,
            requested_scope_handles=requested,
            offered_scope_handles=offered,
        )
    except ConnectionsError as error:
        return _error(f"CONNECTION_{error.code}", error.message)
    except Exception:
        return _error("CONNECTIONS_UNAVAILABLE", "The connection request could not be sent.")
    return _result(
        ConsumerConnectionRequestMutationResult(
            state="completed",
            request_id=str(result.get("id") or "")[:128],
            status="pending",
            next_action="The other person must review the request; no information access is granted yet.",
        )
    )


async def handle_accept_hussh_connection_request(arguments: dict) -> CallToolResult:
    try:
        request_id, _ = _connection_confirmation(
            arguments,
            {
                "request_id",
                "confirm",
                "selected_requested_scope_handles",
                "selected_offered_scope_handles",
            },
        )
        selected_requested = _scope_handle_list(arguments, "selected_requested_scope_handles")
        selected_offered = _scope_handle_list(arguments, "selected_offered_scope_handles")
    except ValueError as error:
        return _error("INVALID_CONNECTIONS_REQUEST", str(error))
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        from hushh_mcp.services.connections_service import (  # noqa: PLC0415
            ConnectionsError,
            ConnectionsService,
        )

        result = await asyncio.to_thread(
            ConnectionsService().accept_request,
            owner,
            request_id,
            selected_requested_scope_handles=selected_requested,
            selected_offered_scope_handles=selected_offered,
        )
    except ConnectionsError as error:
        return _error(f"CONNECTION_{error.code}", error.message)
    except Exception:
        return _error("CONNECTIONS_UNAVAILABLE", "The connection request could not be accepted.")
    raw_scope_results = result.get("scopeResults")
    scope_results = [
        {
            "scope_handle": str(item.get("scopeHandle") or "")[:256],
            "direction": str(item.get("direction") or "")[:32],
            "status": str(item.get("status") or "")[:32],
            "activated": bool(item.get("activated")),
        }
        for item in (raw_scope_results if isinstance(raw_scope_results, list) else [])[:50]
        if isinstance(item, dict)
    ]
    return _result(
        ConsumerConnectionRequestMutationResult(
            state="completed",
            request_id=request_id,
            status="accepted",
            connection_id=(str(result.get("connectionId") or "")[:128] or None),
            scope_results=scope_results,
            next_action="The connection is active. Review separate information permissions before sharing anything.",
        )
    )


async def handle_reject_hussh_connection_request(arguments: dict) -> CallToolResult:
    try:
        request_id, _ = _connection_confirmation(arguments, {"request_id", "confirm"})
    except ValueError as error:
        return _error("INVALID_CONNECTIONS_REQUEST", str(error))
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        from hushh_mcp.services.connections_service import (  # noqa: PLC0415
            ConnectionsError,
            ConnectionsService,
        )

        await asyncio.to_thread(ConnectionsService().reject_request, owner, request_id)
    except ConnectionsError as error:
        return _error(f"CONNECTION_{error.code}", error.message)
    except Exception:
        return _error("CONNECTIONS_UNAVAILABLE", "The connection request could not be rejected.")
    return _result(
        ConsumerConnectionRequestMutationResult(
            state="completed",
            request_id=request_id,
            status="rejected",
            next_action="The request was rejected; no information access was granted.",
        )
    )


async def handle_cancel_hussh_connection_request(arguments: dict) -> CallToolResult:
    try:
        request_id, _ = _connection_confirmation(arguments, {"request_id", "confirm"})
    except ValueError as error:
        return _error("INVALID_CONNECTIONS_REQUEST", str(error))
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        from hushh_mcp.services.connections_service import (  # noqa: PLC0415
            ConnectionsError,
            ConnectionsService,
        )

        await asyncio.to_thread(ConnectionsService().cancel_request, owner, request_id)
    except ConnectionsError as error:
        return _error(f"CONNECTION_{error.code}", error.message)
    except Exception:
        return _error("CONNECTIONS_UNAVAILABLE", "The connection request could not be cancelled.")
    return _result(
        ConsumerConnectionRequestMutationResult(
            state="completed",
            request_id=request_id,
            status="cancelled",
            next_action="The outgoing request was cancelled; no information access was granted.",
        )
    )


def _gmail_page_arguments(arguments: dict) -> tuple[int, int]:
    if not isinstance(arguments, dict):
        raise ValueError("arguments must be an object")
    if set(arguments) - {"page", "per_page"}:
        raise ValueError("only page and per_page are accepted")
    page = arguments.get("page", 1)
    per_page = arguments.get("per_page", 25)
    if type(page) is not int or page < 1:
        raise ValueError("page must be a positive integer")
    if type(per_page) is not int or not 1 <= per_page <= 100:
        raise ValueError("per_page must be an integer between 1 and 100")
    return page, per_page


def _safe_gmail_timestamp(value: object) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        try:
            return str(value.isoformat())[:64]
        except Exception:  # noqa: BLE001 - projection must fail closed
            return None
    return str(value)[:64] or None


def _gmail_receipt(value: object) -> ConsumerGmailReceipt:
    raw = value if isinstance(value, dict) else {}
    return ConsumerGmailReceipt(
        merchant=str(raw.get("merchant_name") or "Unknown merchant")[:256],
        amount=(str(raw.get("amount") or "")[:64] or None),
        currency=(str(raw.get("currency") or "")[:16] or None),
        receipt_date=_safe_gmail_timestamp(raw.get("receipt_date")),
        order_id=(str(raw.get("order_id") or "")[:128] or None),
        subject=(str(raw.get("subject") or "")[:512] or None),
    )


async def handle_list_hussh_gmail_receipts(arguments: dict) -> CallToolResult:
    """Read bounded, synced purchase receipts without exposing mailbox data."""
    try:
        page, per_page = _gmail_page_arguments(arguments)
    except ValueError as error:
        return _error("INVALID_GMAIL_REQUEST", str(error))
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        from hushh_mcp.services.gmail_receipts_service import (  # noqa: PLC0415
            get_gmail_receipts_service,
        )

        result = await get_gmail_receipts_service().list_receipts(
            user_id=owner, page=page, per_page=per_page
        )
    except Exception:
        return _error("GMAIL_UNAVAILABLE", "Synced Gmail receipts are temporarily unavailable.")
    return _result(
        ConsumerGmailReceiptsResult(
            state="available",
            items=[_gmail_receipt(item) for item in list(result.get("items") or [])[:100]],
            page=int(result.get("page") or page),
            per_page=int(result.get("per_page") or per_page),
            total=max(0, int(result.get("total") or 0)),
            has_more=bool(result.get("has_more")),
            next_action="These are synced purchase receipts only; connect, disconnect, and mailbox actions remain in the secure owner flow.",
        )
    )


async def handle_get_hussh_gmail_status(arguments: dict) -> CallToolResult:
    """Read Gmail receipt-sync readiness without returning mailbox identity."""
    if arguments:
        return _error("INVALID_GMAIL_REQUEST", "This tool accepts no arguments.")
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        from hushh_mcp.services.gmail_receipts_service import (  # noqa: PLC0415
            get_gmail_receipts_service,
        )

        result = await get_gmail_receipts_service().get_status(user_id=owner)
    except Exception:
        return _error("GMAIL_UNAVAILABLE", "Gmail receipt-sync status is temporarily unavailable.")
    counts = result.get("receipt_counts")
    receipt_count = int(counts.get("total") or 0) if isinstance(counts, dict) else 0
    return _result(
        ConsumerGmailStatusResult(
            state="available",
            connected=bool(result.get("connected")),
            status=str(result.get("status") or "disconnected")[:32],
            connection_state=str(result.get("connection_state") or "unknown")[:32],
            sync_state=str(result.get("sync_state") or "unknown")[:32],
            last_sync_status=str(result.get("last_sync_status") or "idle")[:32],
            last_sync_at=_safe_gmail_timestamp(result.get("last_sync_at")),
            receipt_count=max(0, receipt_count),
            next_action="Use the secure owner flow to connect or repair Gmail receipt sync; this status never exposes mailbox credentials.",
        )
    )


def _email_workflow_arguments(arguments: dict) -> tuple[int, str | None, str | None, bool]:
    if not isinstance(arguments, dict):
        raise ValueError("arguments must be an object")
    allowed = {"limit", "cursor", "status", "include_archived"}
    if set(arguments) - allowed:
        raise ValueError("only limit, cursor, status, and include_archived are accepted")
    limit = arguments.get("limit", 25)
    if type(limit) is not int or not 1 <= limit <= 50:
        raise ValueError("limit must be an integer between 1 and 50")
    cursor = arguments.get("cursor")
    if cursor is not None and (not isinstance(cursor, str) or len(cursor) > 500):
        raise ValueError("cursor must be no longer than 500 characters")
    status = arguments.get("status")
    if status is not None and (not isinstance(status, str) or len(status.strip()) > 64):
        raise ValueError("status must be no longer than 64 characters")
    include_archived = arguments.get("include_archived", False)
    if type(include_archived) is not bool:
        raise ValueError("include_archived must be a boolean")
    return (
        limit,
        cursor or None,
        status.strip() if isinstance(status, str) and status.strip() else None,
        include_archived,
    )


def _email_workflow_item(value: object) -> ConsumerEmailWorkflowItem | None:
    raw = value if isinstance(value, dict) else {}
    workflow_id = str(raw.get("workflow_id") or "").strip()
    if (
        not workflow_id
        or len(workflow_id) > 128
        or not re.fullmatch(r"[A-Za-z0-9_-]+", workflow_id)
    ):
        return None
    return ConsumerEmailWorkflowItem(
        workflow_id=workflow_id,
        status=str(raw.get("status") or "unknown")[:32],
        subject=(str(raw.get("subject") or "")[:512] or None),
        counterparty_label=(str(raw.get("counterparty_label") or "")[:256] or None),
        draft_status=(str(raw.get("draft_status") or "")[:32] or None),
        send_status=(str(raw.get("send_status") or "")[:32] or None),
        pkm_writeback_status=(str(raw.get("pkm_writeback_status") or "")[:32] or None),
        created_at=_safe_gmail_timestamp(raw.get("created_at")),
        updated_at=_safe_gmail_timestamp(raw.get("updated_at")),
    )


def _email_workflow_error(error: Exception) -> CallToolResult:
    status = int(getattr(error, "status_code", 502) or 502)
    if status == 404:
        return _error("EMAIL_WORKFLOW_NOT_FOUND", "That email workflow is unavailable.")
    if status == 400:
        return _error("INVALID_EMAIL_WORKFLOW_REQUEST", "The email workflow request is invalid.")
    return _error("EMAIL_WORKFLOWS_UNAVAILABLE", "Email workflows are temporarily unavailable.")


async def handle_list_hussh_email_workflows(arguments: dict) -> CallToolResult:
    """List safe owner-scoped email workflow status without mailbox payloads."""
    try:
        limit, cursor, status, include_archived = _email_workflow_arguments(arguments)
    except ValueError as error:
        return _error("INVALID_EMAIL_WORKFLOW_REQUEST", str(error))
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        result = await get_one_email_kyc_service().list_workflows(
            user_id=owner,
            limit=limit,
            cursor=cursor,
            status_filter=status,
            include_archived=include_archived,
        )
    except Exception as error:
        if _is_one_email_kyc_error(error):
            return _email_workflow_error(error)
        return _error("EMAIL_WORKFLOWS_UNAVAILABLE", "Email workflows are temporarily unavailable.")
    items = [
        item
        for raw in list(result.get("workflows") or [])[:50]
        if (item := _email_workflow_item(raw)) is not None
    ]
    return _result(
        ConsumerEmailWorkflowsResult(
            state="available",
            items=items,
            limit=int(result.get("limit") or limit),
            has_more=bool(result.get("has_more")),
            next_cursor=(str(result.get("next_cursor") or "")[:500] or None),
            next_action="Use the secure owner flow for scope approval, draft changes, sending, or archiving an email workflow.",
        )
    )


async def handle_get_hussh_email_workflow(arguments: dict) -> CallToolResult:
    """Read one safe owner-scoped email workflow status."""
    if not isinstance(arguments, dict) or set(arguments) != {"workflow_id"}:
        return _error("INVALID_EMAIL_WORKFLOW_REQUEST", "Only workflow_id is accepted.")
    workflow_id = arguments.get("workflow_id")
    if (
        not isinstance(workflow_id, str)
        or not workflow_id.strip()
        or len(workflow_id.strip()) > 128
        or not re.fullmatch(r"[A-Za-z0-9_-]+", workflow_id.strip())
    ):
        return _error("INVALID_EMAIL_WORKFLOW_REQUEST", "workflow_id is invalid.")
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        raw = await get_one_email_kyc_service().get_workflow(
            user_id=owner,
            workflow_id=workflow_id.strip(),
        )
    except Exception as error:
        if _is_one_email_kyc_error(error):
            return _email_workflow_error(error)
        return _error("EMAIL_WORKFLOWS_UNAVAILABLE", "Email workflows are temporarily unavailable.")
    item = _email_workflow_item(raw)
    if item is None:
        return _error("EMAIL_WORKFLOW_NOT_FOUND", "That email workflow is unavailable.")
    return _result(
        ConsumerEmailWorkflowResult(
            state="available",
            item=item,
            next_action="Use the secure owner flow for scope approval, draft changes, sending, or archiving this workflow.",
        )
    )


async def handle_open_hussh_email_workflow(arguments: dict) -> CallToolResult:
    """Open the authenticated owner flow for a consequential email action."""
    if not isinstance(arguments, dict) or set(arguments) != {"workflow_id", "action"}:
        return _error(
            "INVALID_EMAIL_WORKFLOW_REQUEST",
            "workflow_id and action are required.",
        )
    workflow_id = arguments.get("workflow_id")
    action = arguments.get("action")
    if (
        not isinstance(workflow_id, str)
        or not workflow_id.strip()
        or len(workflow_id.strip()) > 128
        or not re.fullmatch(r"[A-Za-z0-9_-]+", workflow_id.strip())
        or action not in {"review", "refresh", "approve_draft", "send", "archive"}
    ):
        return _error("INVALID_EMAIL_WORKFLOW_REQUEST", "workflow_id or action is invalid.")
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    origin = _secure_setup_origin()
    if origin is None:
        return _error("SETUP_UNAVAILABLE", "The secure owner interface is unavailable.")
    try:
        await get_one_email_kyc_service().get_workflow(
            user_id=owner,
            workflow_id=workflow_id.strip(),
        )
    except Exception as error:
        if _is_one_email_kyc_error(error):
            return _email_workflow_error(error)
        return _error("EMAIL_WORKFLOWS_UNAVAILABLE", "Email workflows are temporarily unavailable.")
    query = urlencode({"workflowId": workflow_id.strip(), "action": action})
    return _result(
        ConsumerEmailWorkflowActionResult(
            state="secure_handoff",
            workflow_id=workflow_id.strip(),
            action=action,
            secure_url=f"{origin}/one/kyc?{query}",
            next_action="Complete the action in the authenticated Hussh owner interface; this link does not approve or send anything by itself.",
        )
    )


async def handle_connect_hussh_integration(arguments: dict) -> CallToolResult:
    """Start provider OAuth; the user completes approval in the secure URL."""
    try:
        service_name, access_level = _validate_google_service(arguments, allow_access_level=True)
    except ValueError as error:
        return _error("INVALID_ARGUMENTS", str(error))
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    level = access_level or "read"
    try:
        current = GoogleConnectionService().status(user_id=owner, service=service_name)
        if current.get("connected") and (
            level == "read" or current.get("access_level") == "manage"
        ):
            return _result(
                ConsumerIntegrationConnectResult(
                    state="connected",
                    service=service_name,
                    access_level=level,
                    next_action="This integration is already connected. Use the owner-pod task or typed service capability next.",
                )
            )
        result = await GoogleConnectionService().start(
            user_id=owner,
            service=service_name,
            access_level=level,
            redirect_uri=None,
            login_hint=None,
        )
    except GoogleConnectionError as error:
        return _error("INTEGRATION_CONNECT_UNAVAILABLE", str(error))
    except Exception:
        return _error(
            "INTEGRATION_CONNECT_UNAVAILABLE", "Provider approval is temporarily unavailable."
        )
    return _result(
        ConsumerIntegrationConnectResult(
            state="approval_required",
            service=service_name,
            access_level=level,
            secure_url=str(result.get("authorize_url") or "") or None,
            expires_at=str(result.get("expires_at") or "")[:64] or None,
            next_action="Open the secure link and approve the provider. The assistant cannot approve access on your behalf.",
        )
    )


async def handle_disconnect_hussh_integration(arguments: dict) -> CallToolResult:
    """Disable one provider grant after explicit user confirmation."""
    if not isinstance(arguments, dict) or arguments.get("confirm") is not True:
        return _error(
            "CONFIRMATION_REQUIRED",
            "Set confirm=true to disconnect this provider. Other integrations remain intact.",
        )
    try:
        service_name, _ = _validate_google_service(
            {"service": arguments.get("service")}, allow_access_level=False
        )
    except ValueError as error:
        return _error("INVALID_ARGUMENTS", str(error))
    if set(arguments) != {"service", "confirm"}:
        return _error("INVALID_ARGUMENTS", "Only service and confirm are accepted.")
    owner = _consumer_owner(get_current_developer_principal())
    if owner is None:
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        await asyncio.to_thread(
            GoogleConnectionService().disconnect_service,
            user_id=owner,
            service=service_name,
        )
    except GoogleConnectionError as error:
        return _error("INTEGRATION_DISCONNECT_UNAVAILABLE", str(error))
    except Exception:
        return _error("INTEGRATION_DISCONNECT_UNAVAILABLE", "Provider access could not be revoked.")
    return _result(
        ConsumerIntegrationDisconnectResult(
            state="disconnected",
            service=service_name,
            next_action="This provider grant is disconnected. The private agent and other integrations remain available.",
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


def _task_next_action(state: str) -> str:
    if state in {"queued", "running", "cancel_requested"}:
        return "Poll get_hussh_task for the current state; the pod will not replay uncertain work."
    if state == "completed":
        return "The owner pod completed the task."
    if state == "interrupted":
        return "The pod was replaced or restarted; review the interrupted result before starting a new task."
    if state == "cancelled":
        return "The task was cancelled and any late result was discarded."
    return "The owner pod could not complete the task; inspect the error code and retry only if appropriate."


async def handle_start_hussh_task(arguments: dict) -> CallToolResult:
    """Create a durable owner-pod task without adding a gateway queue."""
    principal = get_current_developer_principal()
    if not has_consumer_oauth_identity(principal):
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        result = await ConsumerMcpTask().start(principal, arguments=arguments)
    except ValueError as error:
        return _error("INVALID_TASK_REQUEST", str(error))
    except ConsumerTaskApprovalRequired as error:
        return _error("ONE_APPROVAL_REQUIRED", str(error))
    except ConsumerTaskUnavailable:
        return _error("OWNER_POD_UNAVAILABLE", "The owner pod could not accept this task.")
    except ConsumerConnectionDenied as error:
        return _error("TASK_ACCESS_REFUSED", str(error))
    except Exception:
        return _error("TASK_UNAVAILABLE", "The owner-pod task could not be started.")
    return _result(
        ConsumerTaskLifecycleResult(
            **result,
            next_action=_task_next_action(str(result.get("state") or "")),
        )
    )


async def handle_get_hussh_task(arguments: dict) -> CallToolResult:
    """Read a durable owner-pod task status or result."""
    principal = get_current_developer_principal()
    if not has_consumer_oauth_identity(principal):
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        result = await ConsumerMcpTask().status(principal, arguments=arguments)
    except ValueError as error:
        return _error("INVALID_TASK_REQUEST", str(error))
    except ConsumerTaskApprovalRequired as error:
        return _error("ONE_APPROVAL_REQUIRED", str(error))
    except ConsumerTaskUnavailable:
        return _error("OWNER_POD_UNAVAILABLE", "The owner pod task status is unavailable.")
    except ConsumerConnectionDenied as error:
        return _error("TASK_ACCESS_REFUSED", str(error))
    except Exception:
        return _error("TASK_UNAVAILABLE", "The owner-pod task status could not be read.")
    return _result(
        ConsumerTaskLifecycleResult(
            **result,
            next_action=_task_next_action(str(result.get("state") or "")),
        )
    )


async def handle_cancel_hussh_task(arguments: dict) -> CallToolResult:
    """Request cancellation and persist the resulting task state."""
    principal = get_current_developer_principal()
    if not has_consumer_oauth_identity(principal):
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        result = await ConsumerMcpTask().cancel(principal, arguments=arguments)
    except ValueError as error:
        return _error("INVALID_TASK_REQUEST", str(error))
    except ConsumerTaskApprovalRequired as error:
        return _error("ONE_APPROVAL_REQUIRED", str(error))
    except ConsumerTaskUnavailable:
        return _error("OWNER_POD_UNAVAILABLE", "The owner pod task could not be cancelled.")
    except ConsumerConnectionDenied as error:
        return _error("TASK_ACCESS_REFUSED", str(error))
    except Exception:
        return _error("TASK_UNAVAILABLE", "The owner-pod task could not be cancelled.")
    return _result(
        ConsumerTaskLifecycleResult(
            **result,
            next_action=_task_next_action(str(result.get("state") or "")),
        )
    )


async def handle_analyze_hussh_finance(arguments: dict) -> CallToolResult:
    """Run one bounded finance analysis through the owner's private agent."""
    principal = get_current_developer_principal()
    if not has_consumer_oauth_identity(principal):
        return _error("OWNER_AUTH_REQUIRED", "Reconnect using your own Hussh account.")
    try:
        result = await ConsumerMcpFinance().execute(principal, arguments=arguments)
    except ConsumerFinanceInvalid as error:
        return _error("INVALID_FINANCE_REQUEST", str(error))
    except ConsumerTaskApprovalRequired as error:
        return _error("ONE_APPROVAL_REQUIRED", str(error))
    except ConsumerTaskUnavailable as error:
        return _error("OWNER_POD_UNAVAILABLE", str(error))
    except ConsumerConnectionDenied as error:
        return _error("FINANCE_ACCESS_REFUSED", str(error))
    except Exception:
        return _error("FINANCE_UNAVAILABLE", "Finance analysis is temporarily unavailable.")
    return _result(
        ConsumerFinanceResult(
            **result,
            next_action="The owner pod completed the finance analysis; no trade or connected-service mutation was performed.",
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

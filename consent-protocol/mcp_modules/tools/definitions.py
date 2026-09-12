"""Canonical Hussh Consent MCP v0.3 public tool contract."""

from __future__ import annotations

from mcp.types import Tool

from mcp_modules.canonical_contract import canonical_tool_name
from mcp_modules.public_contract import get_public_contract
from mcp_modules.tools.consumer_tools import (
    ConsumerCalendarEventsResult,
    ConsumerCalendarOpeningsResult,
    ConsumerCapabilitiesResult,
    ConsumerConnectionRequestDetailResult,
    ConsumerConnectionRequestMutationResult,
    ConsumerConnectionRequestsResult,
    ConsumerConnectionResult,
    ConsumerConnectionsResult,
    ConsumerDevicesResult,
    ConsumerDisconnectResult,
    ConsumerEmailWorkflowActionResult,
    ConsumerEmailWorkflowResult,
    ConsumerEmailWorkflowsResult,
    ConsumerGmailReceiptsResult,
    ConsumerGmailStatusResult,
    ConsumerIntegrationConnectResult,
    ConsumerIntegrationDisconnectResult,
    ConsumerIntegrationsResult,
    ConsumerMemoryResult,
    ConsumerPeopleResult,
    ConsumerPersonProfileResult,
    ConsumerReceiptsResult,
    ConsumerSetupStatusResult,
    ConsumerTaskResult,
)


def _private_tool_definitions() -> list[Tool]:
    """Return existing entitlement-gated tools that are not in the public contract.

    These definitions preserve partner RIA and Kai voice entitlements. They are
    never returned for the default public developer group and are deliberately
    excluded from the authored Hussh Consent lifecycle contract.
    """

    def schema(properties: dict, required: list[str] | None = None) -> dict:
        return {
            "type": "object",
            "additionalProperties": False,
            "properties": properties,
            "required": required or [],
        }

    empty = schema({})
    return [
        Tool(
            name="get_hussh_connection",
            description="Check your Hussh private-agent setup and get a secure memory-approval link. Requires owner OAuth. Does not read memory, approve permission or provision paid infrastructure.",
            inputSchema=empty,
            outputSchema=ConsumerConnectionResult.model_json_schema(),
            annotations={
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="get_hussh_setup_status",
            description="Read the current resumable private-agent setup job. This is read-only and never provisions infrastructure.",
            inputSchema=empty,
            outputSchema=ConsumerSetupStatusResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="list_hussh_capabilities",
            description="List the authored Hussh consumer capabilities and their execution boundary. This is read-only and does not claim pod readiness.",
            inputSchema=empty,
            outputSchema=ConsumerCapabilitiesResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="list_hussh_connections",
            description="List this owner's connected external assistants and current memory-access status. Returns metadata only; no tokens or private information.",
            inputSchema=schema(
                {
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                    "after": {"type": "string", "maxLength": 128},
                }
            ),
            outputSchema=ConsumerConnectionsResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="list_hussh_devices",
            description="List your registered devices and truthful Puppy readiness without exposing device keys or credentials.",
            inputSchema=empty,
            outputSchema=ConsumerDevicesResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="list_hussh_integrations",
            description="List supported owner Google integrations without returning provider credentials.",
            inputSchema=empty,
            outputSchema=ConsumerIntegrationsResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="list_hussh_calendar_events",
            description="Read your live Google Calendar events for a bounded time range. This never creates, edits or deletes events.",
            inputSchema=schema(
                {
                    "start_at": {"type": "string", "minLength": 1, "maxLength": 64},
                    "end_at": {"type": "string", "minLength": 1, "maxLength": 64},
                    "max_results": {"type": "integer", "minimum": 1, "maximum": 50},
                },
                ["start_at", "end_at"],
            ),
            outputSchema=ConsumerCalendarEventsResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": True,
            },
        ),
        Tool(
            name="find_hussh_calendar_openings",
            description="Find live Google Calendar openings in a bounded window. This never creates, edits or deletes events.",
            inputSchema=schema(
                {
                    "start_at": {"type": "string", "minLength": 1, "maxLength": 64},
                    "end_at": {"type": "string", "minLength": 1, "maxLength": 64},
                    "duration_minutes": {"type": "integer", "minimum": 5, "maximum": 720},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 20},
                    "calendar_ids": {
                        "type": "array",
                        "items": {"type": "string", "minLength": 1},
                        "maxItems": 20,
                    },
                },
                ["start_at", "end_at", "duration_minutes"],
            ),
            outputSchema=ConsumerCalendarOpeningsResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": True,
            },
        ),
        Tool(
            name="search_hussh_people",
            description="Search the owner-visible Hussh people directory. Results use masked contact labels and opaque public references; this does not send a request or grant information access.",
            inputSchema=schema(
                {
                    "query": {"type": "string", "maxLength": 160},
                    "page": {"type": "integer", "minimum": 1},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                    "audience": {"type": "string", "enum": ["all", "people", "ria"]},
                }
            ),
            outputSchema=ConsumerPeopleResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="get_hussh_person_profile",
            description="Read a viewer-relative public Hussh profile and its requestable scope labels. Profile visibility never grants information access.",
            inputSchema=schema(
                {"public_person_ref": {"type": "string", "minLength": 1, "maxLength": 128}},
                ["public_person_ref"],
            ),
            outputSchema=ConsumerPersonProfileResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="list_hussh_people_connections",
            description="List the owner's existing Hussh connections with bounded, masked identity labels. Sending requests, accepting them, and changing shared scopes remain separate confirmed owner actions.",
            inputSchema=schema(
                {
                    "query": {"type": "string", "maxLength": 160},
                    "page": {"type": "integer", "minimum": 1},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                    "audience": {"type": "string", "enum": ["all", "ria"]},
                }
            ),
            outputSchema=ConsumerPeopleResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="list_hussh_connection_requests",
            description="List bounded incoming or outgoing Hussh connection requests. It exposes request metadata only; accepting, rejecting, sending and changing scopes remain confirmed owner actions.",
            inputSchema=schema(
                {
                    "direction": {"type": "string", "enum": ["incoming", "outgoing"]},
                    "include_resolved": {"type": "boolean"},
                }
            ),
            outputSchema=ConsumerConnectionRequestsResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="get_hussh_connection_request",
            description="Read one owner connection request and its bounded capability labels before a confirmed review action. It never grants access.",
            inputSchema=schema(
                {"request_id": {"type": "string", "minLength": 1, "maxLength": 128}},
                ["request_id"],
            ),
            outputSchema=ConsumerConnectionRequestDetailResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="send_hussh_connection_request",
            description="Send a Hussh connection request after explicit confirmation. A connection does not grant information access; selected scopes remain a separate review.",
            inputSchema=schema(
                {
                    "query": {"type": "string", "minLength": 1, "maxLength": 160},
                    "message": {"type": "string", "maxLength": 1000},
                    "requested_scope_handles": {
                        "type": "array",
                        "items": {"type": "string", "minLength": 1, "maxLength": 256},
                        "maxItems": 50,
                    },
                    "offered_scope_handles": {
                        "type": "array",
                        "items": {"type": "string", "minLength": 1, "maxLength": 256},
                        "maxItems": 50,
                    },
                    "confirm": {"type": "boolean", "const": True},
                },
                ["query", "confirm"],
            ),
            outputSchema=ConsumerConnectionRequestMutationResult.model_json_schema(),
            annotations={
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": True,
            },
        ),
        Tool(
            name="accept_hussh_connection_request",
            description="Accept one incoming Hussh connection request after explicit confirmation and selected scope review. Connection status never grants information access by itself.",
            inputSchema=schema(
                {
                    "request_id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "selected_requested_scope_handles": {
                        "type": "array",
                        "items": {"type": "string", "minLength": 1, "maxLength": 256},
                        "maxItems": 50,
                    },
                    "selected_offered_scope_handles": {
                        "type": "array",
                        "items": {"type": "string", "minLength": 1, "maxLength": 256},
                        "maxItems": 50,
                    },
                    "confirm": {"type": "boolean", "const": True},
                },
                ["request_id", "confirm"],
            ),
            outputSchema=ConsumerConnectionRequestMutationResult.model_json_schema(),
            annotations={
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="reject_hussh_connection_request",
            description="Reject one incoming Hussh connection request after explicit confirmation. No information access is granted.",
            inputSchema=schema(
                {
                    "request_id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "confirm": {"type": "boolean", "const": True},
                },
                ["request_id", "confirm"],
            ),
            outputSchema=ConsumerConnectionRequestMutationResult.model_json_schema(),
            annotations={
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="cancel_hussh_connection_request",
            description="Cancel one outgoing Hussh connection request after explicit confirmation. No information access is granted.",
            inputSchema=schema(
                {
                    "request_id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "confirm": {"type": "boolean", "const": True},
                },
                ["request_id", "confirm"],
            ),
            outputSchema=ConsumerConnectionRequestMutationResult.model_json_schema(),
            annotations={
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="list_hussh_gmail_receipts",
            description="List bounded synced Gmail purchase receipts for the owner. Mailbox credentials, message bodies and provider identifiers are never returned.",
            inputSchema=schema(
                {
                    "page": {"type": "integer", "minimum": 1},
                    "per_page": {"type": "integer", "minimum": 1, "maximum": 100},
                }
            ),
            outputSchema=ConsumerGmailReceiptsResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": True,
            },
        ),
        Tool(
            name="get_hussh_gmail_status",
            description="Read owner Gmail receipt-sync readiness without returning the connected email, tokens or mailbox content.",
            inputSchema=empty,
            outputSchema=ConsumerGmailStatusResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="list_hussh_email_workflows",
            description="List safe owner-scoped email workflow status. Mailbox bodies, provider identifiers and credentials are never returned; draft, send and archive actions remain in the secure owner flow.",
            inputSchema=schema(
                {
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                    "cursor": {"type": "string", "maxLength": 500},
                    "status": {"type": "string", "maxLength": 64},
                    "include_archived": {"type": "boolean"},
                }
            ),
            outputSchema=ConsumerEmailWorkflowsResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="get_hussh_email_workflow",
            description="Read safe status for one owner-scoped email workflow. Mailbox bodies, provider identifiers and credentials are never returned.",
            inputSchema=schema(
                {"workflow_id": {"type": "string", "minLength": 1, "maxLength": 128}},
                ["workflow_id"],
            ),
            outputSchema=ConsumerEmailWorkflowResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="open_hussh_email_workflow",
            description="Open the authenticated Hussh owner flow for an email workflow review, refresh, draft approval, send or archive action. The assistant cannot approve, send or archive through this handoff.",
            inputSchema=schema(
                {
                    "workflow_id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "action": {
                        "type": "string",
                        "enum": ["review", "refresh", "approve_draft", "send", "archive"],
                    },
                },
                ["workflow_id", "action"],
            ),
            outputSchema=ConsumerEmailWorkflowActionResult.model_json_schema(),
            annotations={
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="connect_hussh_integration",
            description="Start a secure owner-approved Google integration handoff. The assistant receives a short-lived approval URL and cannot approve access itself.",
            inputSchema=schema(
                {
                    "service": {
                        "type": "string",
                        "enum": ["gmail", "calendar", "drive", "contacts"],
                    },
                    "access_level": {"type": "string", "enum": ["read", "manage"]},
                },
                ["service"],
            ),
            outputSchema=ConsumerIntegrationConnectResult.model_json_schema(),
            annotations={
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": True,
            },
        ),
        Tool(
            name="disconnect_hussh_integration",
            description="Disconnect one owner Google integration after explicit confirmation. Other provider grants and the private agent remain intact.",
            inputSchema=schema(
                {
                    "service": {
                        "type": "string",
                        "enum": ["gmail", "calendar", "drive", "contacts"],
                    },
                    "confirm": {"type": "boolean", "const": True},
                },
                ["service", "confirm"],
            ),
            outputSchema=ConsumerIntegrationDisconnectResult.model_json_schema(),
            annotations={
                "readOnlyHint": False,
                "destructiveHint": True,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="list_hussh_receipts",
            description="List bounded owner-scoped consent receipts without exposing bearer tokens or private information.",
            inputSchema=empty,
            outputSchema=ConsumerReceiptsResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="disconnect_hussh_connection",
            description="Disconnect this assistant after explicit confirmation. This revokes its standing Hussh memory access while keeping your private agent and information intact.",
            inputSchema=schema(
                {
                    "confirm": {"type": "boolean", "const": True},
                    "generation": {"type": "integer", "minimum": 1},
                },
                ["confirm", "generation"],
            ),
            outputSchema=ConsumerDisconnectResult.model_json_schema(),
            annotations={
                "readOnlyHint": False,
                "destructiveHint": True,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="delegate_hussh_task",
            description="Delegate one bounded task to your existing private agent in its owner pod. Set runtime_provider=puppy with the registered puppy_device_id to use that device's approved local inference lane. Requires a separate approved cap.one.invoke grant; arbitrary providers, a second router and automatic replay are rejected.",
            inputSchema={
                **schema(
                    {
                        "message": {"type": "string", "minLength": 1, "maxLength": 8000},
                        "conversation_id": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 128,
                        },
                        "timezone": {"type": "string", "maxLength": 64},
                        "runtime_provider": {"type": "string", "const": "puppy"},
                        "puppy_device_id": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 128,
                        },
                    },
                    ["message"],
                ),
                "allOf": [
                    {
                        "if": {
                            "required": ["runtime_provider"],
                            "properties": {"runtime_provider": {"const": "puppy"}},
                        },
                        "then": {"required": ["puppy_device_id"]},
                    },
                    {
                        "if": {"required": ["puppy_device_id"]},
                        "then": {"required": ["runtime_provider"]},
                    },
                ],
            },
            outputSchema=ConsumerTaskResult.model_json_schema(),
            annotations={
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": False,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="read_hussh_memory",
            description="Read information from your owner pod after your standing Hussh memory approval. The pod is the execution target; unavailable pods fail closed.",
            inputSchema=schema(
                {
                    "domain": {"type": "string", "minLength": 1, "maxLength": 64},
                    "query": {"type": "string", "minLength": 1, "maxLength": 512},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 20},
                },
                ["domain", "query"],
            ),
            outputSchema=ConsumerMemoryResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="save_hussh_memory",
            description="Save an owner-approved personal memory through your owner pod. The canonical encrypted PKM commit must succeed; no plaintext fallback is used.",
            inputSchema=schema(
                {
                    "domain": {"type": "string", "minLength": 1, "maxLength": 64},
                    "content": {"type": "string", "minLength": 1, "maxLength": 4000},
                    "idempotency_key": {"type": "string", "minLength": 1, "maxLength": 128},
                    "expected_revision": {"type": "integer", "minimum": 0},
                },
                ["domain", "content", "idempotency_key"],
            ),
            outputSchema=ConsumerMemoryResult.model_json_schema(),
            annotations={
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="correct_hussh_memory",
            description="Correct an existing owner-pod memory with compare-and-swap protection. Deletion and sharing changes require separate confirmation.",
            inputSchema=schema(
                {
                    "domain": {"type": "string", "minLength": 1, "maxLength": 64},
                    "memory_id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "content": {"type": "string", "minLength": 1, "maxLength": 4000},
                    "idempotency_key": {"type": "string", "minLength": 1, "maxLength": 128},
                    "expected_revision": {"type": "integer", "minimum": 0},
                },
                ["domain", "memory_id", "content", "idempotency_key"],
            ),
            outputSchema=ConsumerMemoryResult.model_json_schema(),
            annotations={
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="export_hussh_memory",
            description="Request an owner-pod export of personal memory metadata. Credentials, keys and recovery secrets are excluded.",
            inputSchema=schema(
                {
                    "domain": {"type": "string", "minLength": 1, "maxLength": 64},
                    "format": {"type": "string", "maxLength": 32},
                },
                ["domain"],
            ),
            outputSchema=ConsumerMemoryResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="list_ria_profiles",
            description="List entitlement-gated RIA marketplace profiles.",
            inputSchema=schema(
                {
                    "query": {"type": "string", "maxLength": 200},
                    "firm": {"type": "string", "maxLength": 200},
                    "verification_status": {"type": "string", "maxLength": 64},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                }
            ),
        ),
        Tool(
            name="get_ria_profile",
            description="Get one entitlement-gated RIA marketplace profile.",
            inputSchema=schema(
                {"ria_id": {"type": "string", "minLength": 1, "maxLength": 128}},
                ["ria_id"],
            ),
        ),
        Tool(
            name="list_marketplace_investors",
            description="List entitlement-gated marketplace investor profiles.",
            inputSchema=schema(
                {
                    "query": {"type": "string", "maxLength": 200},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                }
            ),
        ),
        Tool(
            name="get_ria_verification_status",
            description="Read RIA verification status with VAULT_OWNER authority.",
            inputSchema=schema(
                {
                    "user_id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "consent_token": {"type": "string", "minLength": 16, "maxLength": 2048},
                },
                ["user_id", "consent_token"],
            ),
        ),
        Tool(
            name="get_ria_client_access_summary",
            description="Read an entitlement-gated RIA client access summary.",
            inputSchema=schema(
                {
                    "user_id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "consent_token": {"type": "string", "minLength": 16, "maxLength": 2048},
                },
                ["user_id", "consent_token"],
            ),
        ),
        Tool(
            name="kai_analyze_stock",
            description="Start an entitlement-gated Kai stock analysis action.",
            inputSchema=schema(
                {
                    "symbol": {"type": "string", "minLength": 1, "maxLength": 120},
                    "analysis_type": {
                        "type": "string",
                        "enum": ["fundamental", "sentiment", "valuation", "full"],
                    },
                },
                ["symbol"],
            ),
        ),
        Tool(name="kai_open_dashboard", description="Open Kai dashboard.", inputSchema=empty),
        Tool(name="kai_open_import", description="Open Kai import.", inputSchema=empty),
        Tool(
            name="kai_open_history",
            description="Open Kai analysis history.",
            inputSchema=schema(
                {
                    "tab": {
                        "type": "string",
                        "enum": ["history", "debate", "summary", "transcript"],
                    }
                }
            ),
        ),
        Tool(name="kai_open_consent", description="Open Kai consent.", inputSchema=empty),
        Tool(name="kai_open_profile", description="Open Kai profile.", inputSchema=empty),
        Tool(name="kai_open_home", description="Open Kai home.", inputSchema=empty),
        Tool(name="kai_navigate_back", description="Navigate back in Kai.", inputSchema=empty),
        Tool(
            name="kai_resume_active_analysis",
            description="Resume the active Kai analysis.",
            inputSchema=empty,
        ),
        Tool(
            name="kai_cancel_active_analysis",
            description="Cancel the active Kai analysis.",
            inputSchema=empty,
        ),
    ]


def get_tool_definitions(
    allowed_tool_names: set[str] | None = None,
    *,
    schema_profile: str = "standard",
) -> list[Tool]:
    """Return the default public contract or an explicitly entitled subset."""

    # Catalog presentation is no longer app-profile-dependent.  Entitlements
    # remain internal underscore identifiers while tools/list publishes the
    # one v0.4 hyphenated contract to every external host.
    tools: list[Tool] = []
    for definition in get_public_contract()["tools"]:
        internal_name = canonical_tool_name(str(definition["name"]))
        if allowed_tool_names is not None and internal_name not in allowed_tool_names:
            continue
        tools.append(Tool.model_validate(definition))
    if allowed_tool_names is None:
        return tools
    tools.extend(tool for tool in _private_tool_definitions() if tool.name in allowed_tool_names)
    return tools

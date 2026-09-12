"""Canonical owner-facing Hussh MCP tool names.

The visibility projection and the capability-discovery tool must agree on the
same consumer surface. Keeping the names here avoids a host-visible tool that
is missing from discovery, or a discovery entry that cannot be dispatched.
This module contains names only; execution and authorization remain owned by
the existing MCP handlers and consent services.
"""

from __future__ import annotations

CONSUMER_MCP_TOOL_NAMES: tuple[str, ...] = (
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
    "list_hussh_capabilities",
    "list_hussh_connections",
    "list_hussh_receipts",
    "disconnect_hussh_connection",
    "delegate_hussh_task",
    "start_hussh_task",
    "get_hussh_task",
    "cancel_hussh_task",
    "analyze_hussh_finance",
    "read_hussh_memory",
    "save_hussh_memory",
    "correct_hussh_memory",
    "delete_hussh_memory",
    "export_hussh_memory",
)

CONSUMER_MCP_TOOL_NAME_SET = frozenset(CONSUMER_MCP_TOOL_NAMES)

__all__ = ["CONSUMER_MCP_TOOL_NAMES", "CONSUMER_MCP_TOOL_NAME_SET"]

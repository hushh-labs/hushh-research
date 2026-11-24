"""Bounded ADK 2.15 tool self-healing for read-only schema validation errors.

Subclasses ``google.adk.plugins.reflect_retry_tool_plugin.ReflectAndRetryToolPlugin``
strictly for read-only lookup tools that return argument/schema validation errors
(e.g. ``invalid_wiki_request``, ``invalid_arguments``, ``validation_error``).

Safety boundary:
- NEVER retries mutating, consent, messaging, calendar-write, Drive-write,
  payment, or delegation tools.
- NEVER retries authorization, vault-lock, disconnection, or read-budget refusals.
- ``throw_exception_if_retry_exceeded=False`` so a second miss returns calm
  guidance rather than aborting the user's chat turn.
"""

from __future__ import annotations

from typing import Any

from google.adk.plugins.reflect_retry_tool_plugin import (
    ReflectAndRetryToolPlugin,
    ToolReflectionContext,
    TrackingScope,
)
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.tool_context import ToolContext

# Explicit allowlist of pure read-only lookup tools eligible for self-healing
# schema/argument reflection. Mutating and side-effecting tools are excluded by
# construction.
_SAFE_READ_ONLY_RETRY_TOOLS: frozenset[str] = frozenset(
    {
        "search_wiki",
        "read_wiki_page",
        "trace_claim",
        "list_app_actions",
        "discover_person_information",
        "discover_workspace_tools",
        "list_my_connections",
        "list_active_grants",
        "list_pending_information_requests",
        "list_my_outgoing_information_requests",
        "list_information_shared_with_me",
        "list_recent_receipts",
        "receipt_spending",
        "highest_receipt_spend",
        "most_frequently_purchased_products",
        "calendar_summary",
        "calendar_events",
        "calendar_event_detail",
        "calendar_availability",
        "calendar_free_slots",
        "calendar_calendars",
        "calendar_invitations",
        "get_market_quotes",
        "get_ticker_news",
        "read_my_profile_status",
        "read_my_pkm_domain_summary",
        "inspect_selected_drive_files",
        "get_current_time",
    }
)

_RECOVERABLE_ERROR_CODES: frozenset[str] = frozenset(
    {
        "invalid_wiki_request",
        "invalid_arguments",
        "validation_error",
        "invalid_parameter",
        "missing_required_argument",
    }
)


def _safe_reflection_guidance(ctx: ToolReflectionContext) -> str:
    return (
        f"The read-only call to `{ctx.tool_name}` failed argument validation "
        f"(attempt {ctx.retry_count} of {ctx.max_retries}). Check the tool's parameter "
        "schema, omit empty optional arguments, fix any ID/date formatting, and retry once."
    )


def _safe_exceeded_guidance(ctx: ToolReflectionContext) -> str:
    return (
        f"The read-only call to `{ctx.tool_name}` failed validation after {ctx.max_retries} "
        "attempts. Do not retry again; answer honestly from verified context or ask one brief "
        "clarifying question."
    )


class SafeSchemaRetryToolPlugin(ReflectAndRetryToolPlugin):
    """ADK 2.15 ReflectAndRetryToolPlugin restricted to read-only argument validation."""

    def __init__(self, *, max_retries: int = 2) -> None:
        super().__init__(
            name="hussh_safe_schema_retry_tool_plugin",
            max_retries=max_retries,
            throw_exception_if_retry_exceeded=False,
            tracking_scope=TrackingScope.INVOCATION,
            reflection_guidance=_safe_reflection_guidance,
            retry_exceeded_guidance=_safe_exceeded_guidance,
        )

    async def extract_error_from_result(
        self,
        *,
        tool: BaseTool,
        tool_args: dict[str, Any],
        tool_context: ToolContext,
        result: Any,
    ) -> dict[str, Any] | None:
        del tool_args, tool_context
        tool_name = str(getattr(tool, "name", "") or "")
        if tool_name not in _SAFE_READ_ONLY_RETRY_TOOLS:
            return None
        if not isinstance(result, dict):
            return None
        code = str(result.get("code") or "").strip().lower()
        if code in _RECOVERABLE_ERROR_CODES:
            return {"error_code": code, "status": str(result.get("status") or "error")}
        return None

    async def on_tool_error_callback(
        self,
        *,
        tool: BaseTool,
        tool_args: dict[str, Any],
        tool_context: ToolContext,
        error: Exception,
    ) -> dict[str, Any] | None:
        tool_name = str(getattr(tool, "name", "") or "")
        if tool_name not in _SAFE_READ_ONLY_RETRY_TOOLS or not isinstance(
            error, (TypeError, ValueError)
        ):
            return None
        return await super().on_tool_error_callback(
            tool=tool,
            tool_args=tool_args,
            tool_context=tool_context,
            error=error,
        )

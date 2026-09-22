"""Invocation-local authority barrier after a connector read is selected.

Model-supplied content cannot clear the barrier. A fresh authenticated user turn
gets a new SDK invocation ID. Voice/proposals never get typed-chat admission.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled

STATE_EXECUTION_SURFACE = "temp:one_execution_surface"
STATE_EXTERNAL_READ = "temp:one_external_read_invocation"
MAIL_TOOL = "ask_email_agent"


def external_read_active(context: Any) -> bool:
    invocation = getattr(context, "invocation_id", None)
    return bool(invocation) and context.state.get(STATE_EXTERNAL_READ) == invocation


def before_external_read_tool(tool: Any, args: dict, tool_context: Any) -> dict | None:
    if external_read_active(tool_context):
        return {"status": "blocked", "reason": "external_content_answer_only"}
    if (
        getattr(tool, "name", "") == MAIL_TOOL
        and tool_context.state.get(STATE_EXECUTION_SURFACE) == "typed_chat"
        and connector_feature_enabled("gmail_chat_reads", str(tool_context.user_id or ""))
    ):
        invocation = getattr(tool_context, "invocation_id", None)
        if not isinstance(invocation, str) or not invocation:
            return {"status": "blocked", "reason": "invocation_required"}
        # Set before any await/dispatch so parallel tool calls cannot race the
        # receipt of retrieved text into a second action.
        tool_context.state[STATE_EXTERNAL_READ] = invocation
    return None


def before_external_read_model(callback_context: Any, llm_request: Any) -> None:
    if external_read_active(callback_context):
        llm_request.tools_dict.clear()
        llm_request.config.tools = []
        llm_request.config.tool_config = None

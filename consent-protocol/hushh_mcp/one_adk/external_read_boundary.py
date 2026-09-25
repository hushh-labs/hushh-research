"""Invocation-local authority barrier after a connector read is selected.

Model-supplied content cannot clear the barrier. A fresh authenticated user turn
gets a new SDK invocation ID. Voice/proposals never get typed-chat admission.
"""

from __future__ import annotations

from typing import Any

from google.genai import types

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled

STATE_EXECUTION_SURFACE = "temp:one_execution_surface"
STATE_EXTERNAL_READ = "temp:one_external_read_invocation"
STATE_EXTERNAL_READ_CONTINUATION = "temp:one_external_read_model_continuation"
MAIL_TOOL = "ask_email_agent"
READ_TOOLS = {
    MAIL_TOOL: "gmail_chat_reads",
    "ask_documents_agent": "google_drive_chat_reads",
    "inspect_selected_drive_files": "google_drive_chat_reads",
    # Per-provider admission and owner authority are checked inside the tool.
    # Establish the content barrier before dispatch, regardless of provider.
    "read_workspace_tool": None,
}


def external_read_active(context: Any) -> bool:
    invocation = getattr(context, "invocation_id", None)
    return bool(invocation) and context.state.get(STATE_EXTERNAL_READ) == invocation


def _reviewed_mcp_tool(tool: Any) -> bool:
    # Identity comes from application-owned objects, never a remote tool name
    # or its read-only annotation. Every continued call must use our exact-call
    # confirmation authority, including a read that could disclose arguments.
    from hushh_mcp.one_adk.governed_mcp_toolset import _GovernedMcpTool
    from hushh_mcp.one_adk.mcp_call_approval import review_or_resume_call

    return type(tool) is _GovernedMcpTool and tool.toolset.authorize_call is review_or_resume_call


def _reviewable_draft_tool(tool: Any) -> bool:
    # This is a client-only draft, not a provider send. Admit the exact local
    # function, never a provider tool or another callable with the same name.
    if getattr(tool, "name", None) != "open_gmail_email_draft":
        return False
    from google.adk.tools import FunctionTool

    from hushh_mcp.one_adk.agent_tree import open_gmail_email_draft

    return type(tool) is FunctionTool and tool.func is open_gmail_email_draft


def before_external_read_tool(tool: Any, args: dict, tool_context: Any) -> dict | None:
    if _reviewed_mcp_tool(tool):
        invocation = getattr(tool_context, "invocation_id", None)
        if (
            not isinstance(invocation, str)
            or not invocation
            or tool_context.state.get(STATE_EXECUTION_SURFACE) != "typed_chat"
        ):
            return {"status": "blocked", "reason": "invocation_required"}
        tool_context.state[STATE_EXTERNAL_READ] = invocation
        return None
    if external_read_active(tool_context):
        if (
            _reviewable_draft_tool(tool)
            and tool_context.state.get(STATE_EXECUTION_SURFACE) == "typed_chat"
            and tool_context.state.get(STATE_EXTERNAL_READ_CONTINUATION)
            == tool_context.invocation_id
        ):
            return None
        return {
            "status": "blocked",
            "reason": "connector_read_complete",
            "message": (
                "A connector read already ran in this chat turn. Answer from that result, "
                "or ask the owner for a new message if another read is needed. "
                "This blocked call did not reach the provider."
            ),
        }
    if (
        getattr(tool, "name", "") in READ_TOOLS
        and tool_context.state.get(STATE_EXECUTION_SURFACE) == "typed_chat"
        and (
            READ_TOOLS[tool.name] is None
            or connector_feature_enabled(READ_TOOLS[tool.name], str(tool_context.user_id or ""))
        )
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
        # This callback runs only after the read's tool result has returned to
        # the model. A parallel draft call in the original batch stays blocked.
        callback_context.state[STATE_EXTERNAL_READ_CONTINUATION] = callback_context.invocation_id
        admitted = {
            name: tool
            for name, tool in llm_request.tools_dict.items()
            if _reviewed_mcp_tool(tool) or _reviewable_draft_tool(tool)
        }
        declarations = [tool._get_declaration() for tool in admitted.values()]
        llm_request.tools_dict.clear()
        llm_request.tools_dict.update(admitted)
        # Rebuild from the admitted objects; do not preserve provider built-ins
        # or stale function declarations that bypass the callback boundary.
        llm_request.config.tools = (
            [types.Tool(function_declarations=declarations)] if declarations else []
        )
        llm_request.config.tool_config = None

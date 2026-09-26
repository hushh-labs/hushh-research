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
# "<invocation>:<function call id>" of the one governed MCP call, if any, that
# was selected before any third-party content entered this conversation. Only
# that exact call may skip exact-call review; every other call is reviewed.
STATE_MCP_UNREVIEWED_CALL = "temp:one_mcp_unreviewed_call"
# Durable (not temp:, so it survives new messages and resumes): some tool whose
# result can carry third-party text has run in this conversation. Earlier
# results and answers quoting them stay in the model's history.
STATE_UNTRUSTED_CONTENT = "hussh:mcp_untrusted_content_seen"
# Tools whose results hold only the owner's own settings or app state, never
# text a third party wrote. Every other tool, connectors included, is untrusted.
LOCAL_ONLY_TOOLS = frozenset(
    {
        "get_current_time",
        "list_available_models",
        "set_preferred_model",
        "inspect_private_connectors",
        "list_app_actions",
        "report_no_app_action",
        "open_screen",
    }
)
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


def mcp_call_may_skip_review(tool_context: Any) -> bool:
    """Fail closed: True only for the exact call admitted before any read.

    Once mail, documents, calendar, search or any connector content is in the
    conversation, a crafted document can steer arguments toward a third-party
    server. From then on no governed MCP call runs without exact-call review,
    whatever its credential or annotations say. A confirmed resume always uses
    the review receipt path, never this one.
    """
    invocation = getattr(tool_context, "invocation_id", None)
    call_id = getattr(tool_context, "function_call_id", None)
    state = getattr(tool_context, "state", None)
    return (
        getattr(tool_context, "tool_confirmation", None) is None
        and isinstance(invocation, str)
        and bool(invocation)
        and isinstance(call_id, str)
        and bool(call_id)
        and state is not None
        and state.get(STATE_MCP_UNREVIEWED_CALL) == f"{invocation}:{call_id}"
    )


def _untrusted_content_seen(tool_context: Any, call_id: str) -> bool:
    """Durable flag, or any earlier non-local tool in the stored history.

    History covers conversations older than the flag. Unreadable history is
    treated as untrusted.
    """
    state = getattr(tool_context, "state", None)
    if state is None or state.get(STATE_UNTRUSTED_CONTENT):
        return True
    try:
        events = tool_context.session.events
        for event in events:
            for part in getattr(getattr(event, "content", None), "parts", None) or []:
                for item in (part.function_call, part.function_response):
                    if item is None or getattr(item, "id", None) == call_id:
                        continue
                    if getattr(item, "name", None) not in LOCAL_ONLY_TOOLS:
                        return True
    except Exception:
        return True
    return False


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
    if getattr(tool, "name", None) not in LOCAL_ONLY_TOOLS:
        state = getattr(tool_context, "state", None)
        if _reviewed_mcp_tool(tool):
            call_id = getattr(tool_context, "function_call_id", None)
            invocation = getattr(tool_context, "invocation_id", None)
            if (
                state is not None
                and isinstance(call_id, str)
                and call_id
                and isinstance(invocation, str)
                and invocation
                and getattr(tool_context, "tool_confirmation", None) is None
                and not external_read_active(tool_context)
                and not _untrusted_content_seen(tool_context, call_id)
            ):
                # Decided before this call marks the conversation, and before
                # any parallel sibling can: at most one call is eligible.
                state[STATE_MCP_UNREVIEWED_CALL] = f"{invocation}:{call_id}"
        # Set before dispatch so a sibling in the same batch already sees it.
        if state is not None:
            state[STATE_UNTRUSTED_CONTENT] = True
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

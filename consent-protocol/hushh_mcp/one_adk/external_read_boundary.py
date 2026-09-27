"""Invocation-local authority barrier after a connector read is selected.

Model-supplied content cannot clear the barrier. A fresh authenticated user turn
gets a new SDK invocation ID. Voice/proposals never get typed-chat admission.
"""

from __future__ import annotations

import json
from typing import Any

from google.adk.models.llm_response import LlmResponse
from google.genai import types

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled

STATE_EXECUTION_SURFACE = "temp:one_execution_surface"
STATE_EXTERNAL_READ = "temp:one_external_read_invocation"
STATE_EXTERNAL_READ_CONTINUATION = "temp:one_external_read_model_continuation"
STATE_DRIVE_READ_OUTCOME = "temp:one_drive_read_outcome"
STATE_SELECTED_DRIVE_SHARE = "temp:one_selected_drive_share"
_DRIVE_READ_FAILED_ANSWER = (
    "I couldn’t complete a fresh Drive check. Earlier filenames and links in this chat "
    "have not been verified again, so I can’t confirm the current result. Please try again."
)
MAIL_TOOL = "ask_email_agent"
READ_TOOLS = {
    MAIL_TOOL: "gmail_chat_reads",
    "ask_documents_agent": "google_drive_chat_reads",
    "read_selected_drive_search_result": "google_drive_chat_reads",
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
    # or its read-only annotation. Only the Chat-owned governed toolset, with
    # its canonical approval port, stays callable after the barrier. Whether a
    # call is reviewed is the toolset's own decision (the person's connectors
    # run freely; curated first-party rows keep exact-call review).
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


def _reviewable_selected_drive_share_tool(tool: Any) -> bool:
    if getattr(tool, "name", None) != "propose_drive_share":
        return False
    from google.adk.tools import FunctionTool

    from hushh_mcp.one_adk.agent_tree import propose_drive_share

    return type(tool) is FunctionTool and tool.func is propose_drive_share


def _selected_share_ready(context: Any) -> bool:
    marker = context.state.get(STATE_SELECTED_DRIVE_SHARE)
    return (
        isinstance(marker, dict)
        and marker.get("invocation") == getattr(context, "invocation_id", None)
        and isinstance(marker.get("titleRef"), str)
        and marker["titleRef"].startswith("one_secret_ref:")
    )


def _selected_share_requested(context: Any) -> bool:
    from hushh_mcp.one_adk.request_secrets import resolve_request_secret
    from hushh_mcp.one_adk.workspace_mcp_tools import STATE_DRIVE_SEARCH_SELECTION

    pointer = context.state.get(STATE_DRIVE_SEARCH_SELECTION)
    if not isinstance(pointer, str) or not pointer.startswith("one_secret_ref:"):
        return False
    try:
        selection = json.loads(resolve_request_secret(pointer))
    except (TypeError, ValueError):
        return False
    return isinstance(selection, dict) and selection.get("shareAllowed") is True


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
            (
                _reviewable_draft_tool(tool)
                or (
                    _reviewable_selected_drive_share_tool(tool)
                    and _selected_share_ready(tool_context)
                )
            )
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


def after_external_read_tool(tool: Any, args: dict, tool_context: Any, tool_response: dict) -> None:
    """Remember only the current, executed Drive read's evidence outcome.

    A blocked parallel/repeated call did not execute a read and cannot erase a
    successful first result. This state contains no provider text or file IDs.
    """
    name = getattr(tool, "name", "")
    if name not in {"ask_documents_agent", "read_selected_drive_search_result"} and not (
        name == "read_workspace_tool" and args.get("provider") == "drive"
    ):
        return
    invocation = getattr(tool_context, "invocation_id", None)
    if (
        not isinstance(invocation, str)
        or not invocation
        or tool_context.state.get(STATE_EXECUTION_SURFACE) != "typed_chat"
        or tool_response.get("reason") == "connector_read_complete"
    ):
        return
    if (
        name == "read_selected_drive_search_result"
        and args.get("mode", "metadata") == "metadata"
        and tool_response.get("status") == "ok"
        and tool_response.get("metadata_only") is True
        and _selected_share_requested(tool_context)
    ):
        file = tool_response.get("result", {}).get("file")
        title = file.get("name") if isinstance(file, dict) else None
        if isinstance(title, str) and title.strip() and len(title.encode("utf-8")) <= 2048:
            from hushh_mcp.one_adk.request_secrets import store_request_secret

            tool_context.state[STATE_SELECTED_DRIVE_SHARE] = {
                "invocation": invocation,
                "titleRef": store_request_secret(title, ttl_seconds=660),
            }
    previous = tool_context.state.get(STATE_DRIVE_READ_OUTCOME)
    if isinstance(previous, dict) and previous.get("invocation") == invocation:
        return
    # Both statuses are authored by the read wrapper. A successful partial
    # metadata result is still usable; input_required must retain its question.
    status = tool_response.get("status")
    outcome = status if isinstance(status, str) and status in {"ok", "input_required"} else "failed"
    tool_context.state[STATE_DRIVE_READ_OUTCOME] = {
        "invocation": invocation,
        "outcome": outcome,
    }


def before_external_read_model(callback_context: Any, llm_request: Any) -> LlmResponse | None:
    invocation = getattr(callback_context, "invocation_id", None)
    outcome = getattr(callback_context, "state", {}).get(STATE_DRIVE_READ_OUTCOME)
    if (
        invocation
        and isinstance(outcome, dict)
        and outcome.get("invocation") == invocation
        and outcome.get("outcome") == "failed"
    ):
        # End this answer without asking the model to reinterpret old history
        # as new evidence. No generated text has been streamed for this step.
        return LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text=_DRIVE_READ_FAILED_ANSWER)]),
            turn_complete=True,
        )
    if external_read_active(callback_context):
        # This callback runs only after the read's tool result has returned to
        # the model. A parallel draft call in the original batch stays blocked.
        callback_context.state[STATE_EXTERNAL_READ_CONTINUATION] = callback_context.invocation_id
        admitted = {
            name: tool
            for name, tool in llm_request.tools_dict.items()
            if _reviewed_mcp_tool(tool)
            or _reviewable_draft_tool(tool)
            or (
                _selected_share_ready(callback_context)
                and _reviewable_selected_drive_share_tool(tool)
            )
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
    return None

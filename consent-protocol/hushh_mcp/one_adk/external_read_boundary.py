"""Invocation-local authority barrier after a connector read is selected.

Model-supplied content cannot clear the barrier. A fresh authenticated user turn
gets a new SDK invocation ID. Voice/proposals never get typed-chat admission.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from google.adk.models.llm_response import LlmResponse
from google.genai import types

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled

logger = logging.getLogger(__name__)

STATE_EXECUTION_SURFACE = "temp:one_execution_surface"
STATE_EXTERNAL_READ = "temp:one_external_read_invocation"
STATE_EXTERNAL_READ_CONTINUATION = "temp:one_external_read_model_continuation"
STATE_DRIVE_READ_OUTCOME = "temp:one_drive_read_outcome"
STATE_SELECTED_DRIVE_SHARE = "temp:one_selected_drive_share"
STATE_RECEIPT_HANDBACK = "temp:one_receipt_handback_invocation"
STATE_READ_CALL_REFUSED = "temp:one_read_call_refused_invocation"
_DRIVE_READ_FAILED_ANSWER = (
    "I couldn’t complete a fresh Drive check. Earlier filenames and links in this chat "
    "have not been verified again, so I can’t confirm the current result. Please try again."
)
# Truthful connection states, not failures: retrying cannot help, so never say
# "try again". Authored here so no earlier filename is re-presented as current.
_DRIVE_CONNECTION_ANSWERS = {
    "failed": _DRIVE_READ_FAILED_ANSWER,
    "connect_required": (
        "Google Drive isn’t connected yet, so I haven’t checked any files. "
        "Connect Google Drive in Connectors, then ask me again."
    ),
    "reconnect_required": (
        "Google Drive needs to be reconnected before I can check it. Earlier filenames "
        "and links in this chat have not been verified again. Reconnect Google Drive "
        "in Connectors, then ask me again."
    ),
    # read_workspace_tool reports a missing or narrowed Drive grant this way.
    # Approving access is the only remedy, so retrying the same read cannot help.
    "permission_required": (
        "Google Drive needs your permission before I can check it. Earlier filenames "
        "and links in this chat have not been verified again. Connect Google Drive in "
        "Connectors and approve access, then ask me again."
    ),
}
MAIL_TOOL = "ask_email_agent"
READ_TOOLS = {
    MAIL_TOOL: "gmail_chat_reads",
    # Resolves bounded Gmail metadata into an owner-confirmation card. It is
    # still a connector read, so no later tool in this model turn can act on
    # the selected email text.
    "propose_gmail_todo": "gmail_chat_reads",
    "ask_documents_agent": "google_drive_chat_reads",
    "read_selected_drive_search_result": "google_drive_chat_reads",
    "inspect_selected_drive_files": "google_drive_chat_reads",
    "read_google_drive": "google_drive_chat_reads",
    # Calendar event fields are provider-authored text. A Calendar read ends
    # this invocation's action authority just like a Mail or Drive read, and
    # its arguments/results must be removed from durable ADK history.
    "calendar_summary": None,
    "calendar_invitations": None,
    "calendar_calendars": None,
    "calendar_events": None,
    "calendar_event_detail": None,
    "calendar_availability": None,
    "calendar_free_slots": None,
    # Per-provider admission and owner authority are checked inside the tool.
    # Establish the content barrier before dispatch, regardless of provider.
    "read_workspace_tool": None,
    # A probe returns untrusted server text (names, tool descriptions). Nothing
    # after it in the same turn may act on first-party information.
    "probe_private_connector": None,
}


def external_read_active(context: Any) -> bool:
    invocation = getattr(context, "invocation_id", None)
    return bool(invocation) and context.state.get(STATE_EXTERNAL_READ) == invocation


def _reviewed_mcp_tool(tool: Any) -> bool:
    # Identity comes from application-owned objects, never a remote tool name
    # or its read-only annotation. Only the Chat-owned governed toolset, with
    # its canonical approval port, stays callable after the barrier. Whether a
    # call is reviewed is the toolset's own decision (the person's connectors
    # run freely; a curated first-party row runs only its reviewed reads freely
    # and keeps exact-call review for everything else).
    from hushh_mcp.one_adk.governed_mcp_toolset import _GovernedMcpTool
    from hushh_mcp.one_adk.mcp_call_approval import review_or_resume_call

    return type(tool) is _GovernedMcpTool and tool.toolset.authorize_call is review_or_resume_call


def _reviewable_draft_tool(tool: Any) -> bool:
    # These exact application-owned functions only prepare owner review.
    # They never execute a Calendar mutation; confirmation retains its own
    # owner/grant-bound proposal and single-claim provider-write boundary.
    if getattr(tool, "name", None) in {
        "open_calendar_invitation",
        "propose_calendar_event",
        "propose_calendar_reschedule",
        "propose_calendar_cancellation",
    }:
        from google.adk.tools import FunctionTool

        from hushh_mcp.agents.calendar import tools as calendar_tools

        return type(tool) is FunctionTool and tool.func is getattr(calendar_tools, tool.name)
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


def _receipt_handback_tool(tool: Any, context: Any) -> bool:
    # After this turn's Email call handed a receipts request back: One's per-run
    # device receipt proxies (the Chat route admits only their exact contract) and
    # the host clock a relative period needs without a declared zone. The proxies
    # work over the device's receipt copy built from Gmail, but their values return
    # only in a later turn, after a closed-schema check, where every tool is refused
    # (receipt_result_turn_is_read_only) and tool calling is NONE. The clock writes
    # only this invocation's host clock receipt. before_receipt_tool still checks each
    # receipt call against its closed request contract.
    invocation = getattr(context, "invocation_id", None)
    if not invocation or context.state.get(STATE_RECEIPT_HANDBACK) != invocation:
        return False
    if getattr(tool, "name", None) == "get_current_time":
        from google.adk.tools import FunctionTool

        from hushh_mcp.one_adk.action_tools import get_current_time

        return type(tool) is FunctionTool and tool.func is get_current_time
    from ag_ui_adk.client_proxy_tool import ClientProxyTool

    from hushh_mcp.one_adk.receipt_client_tools import RECEIPT_TOOL_NAMES

    return type(tool) is ClientProxyTool and tool.name in RECEIPT_TOOL_NAMES


def before_external_read_tool(tool: Any, args: dict, tool_context: Any) -> dict | None:
    from hushh_mcp.one_adk.scheduled_one_agent import (
        admitted_scheduled_surface,
        scheduled_finish_tool,
    )

    if scheduled_finish_tool(tool, tool_context):
        return None
    if _reviewed_mcp_tool(tool):
        invocation = getattr(tool_context, "invocation_id", None)
        if (
            not isinstance(invocation, str)
            or not invocation
            or not (
                tool_context.state.get(STATE_EXECUTION_SURFACE) == "typed_chat"
                or admitted_scheduled_surface(tool_context)
            )
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
                or _receipt_handback_tool(tool, tool_context)
            )
            and tool_context.state.get(STATE_EXECUTION_SURFACE) == "typed_chat"
            and tool_context.state.get(STATE_EXTERNAL_READ_CONTINUATION)
            == tool_context.invocation_id
        ):
            return None
        # Never claim a read ran (a receipts hand-back reads no mail) and never point
        # at other tools: after a real read, untrusted provider text is in context.
        return {
            "status": "blocked",
            "reason": "connector_read_complete",
            "message": (
                "Answer from what this chat turn already returned, or ask the owner for a "
                "new message. This blocked call did not reach the provider."
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
        if _missing_required_argument(tool, args):
            # A schema violation reads nothing, so it need not end the turn's
            # tools: One retries once with the owner's words (2026-10-29, UAT).
            # A second one closes them like a read, so the turn can't loop.
            retried = tool_context.state.get(STATE_READ_CALL_REFUSED) == invocation
            tool_context.state[STATE_READ_CALL_REFUSED] = invocation
            if retried:
                tool_context.state[STATE_EXTERNAL_READ] = invocation
            logger.info("one.read_call_refused reason=missing_argument tool=%s", tool.name)
            return {
                "status": "blocked",
                "reason": "missing_argument",
                "message": "Nothing was read. Ask the owner what they want, in one short question."
                if retried
                else "Nothing was read. Call this tool again with the owner's request.",
            }
        # Set before any await/dispatch so parallel tool calls cannot race the
        # receipt of retrieved text into a second action.
        tool_context.state[STATE_EXTERNAL_READ] = invocation
    return None


def _missing_required_argument(tool: Any, args: dict) -> bool:
    try:
        declaration = tool._get_declaration()
    except Exception:  # noqa: BLE001 - an undeclared tool keeps the existing barrier
        return False
    schema = getattr(declaration, "parameters_json_schema", None)
    required = schema.get("required") if isinstance(schema, dict) else None
    if required is None:
        required = getattr(getattr(declaration, "parameters", None), "required", None)
    values = [args.get(name) for name in required or ()]
    return any(value is None or (isinstance(value, str) and not value.strip()) for value in values)


def after_external_read_tool(tool: Any, args: dict, tool_context: Any, tool_response: dict) -> None:
    """Remember an Email receipts hand-back or the current, executed Drive read's outcome.

    A blocked parallel/repeated call did not execute a read and cannot erase a
    successful first result. This state contains no provider text or file IDs.
    """
    name = getattr(tool, "name", "")
    if (
        name == MAIL_TOOL
        and tool_response.get("status") == "receipt_functions_required"
        and external_read_active(tool_context)
    ):
        # The Email specialist read no mail and handed receipts back to One. Never
        # clear the barrier: a reviewed MCP read in this batch writes the same marker.
        tool_context.state[STATE_RECEIPT_HANDBACK] = tool_context.invocation_id
        return
    if name not in {"ask_documents_agent", "read_selected_drive_search_result"} and not (
        name == "read_workspace_tool" and args.get("provider") == "drive"
    ):
        return
    invocation = getattr(tool_context, "invocation_id", None)
    if (
        not isinstance(invocation, str)
        or not invocation
        or tool_context.state.get(STATE_EXECUTION_SURFACE) != "typed_chat"
        # Neither refusal read anything, so neither may record a Drive outcome.
        or tool_response.get("reason") in {"connector_read_complete", "missing_argument"}
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
    # These statuses are authored by the read wrapper. A successful partial
    # metadata result is still usable; input_required must retain its question;
    # a connection state is the truth to relay, not a failure to retry.
    status = tool_response.get("status")
    outcome = (
        status
        if isinstance(status, str)
        and status
        in {"ok", "input_required", "connect_required", "reconnect_required", "permission_required"}
        else "failed"
    )
    tool_context.state[STATE_DRIVE_READ_OUTCOME] = {
        "invocation": invocation,
        "outcome": outcome,
    }


def before_external_read_model(callback_context: Any, llm_request: Any) -> LlmResponse | None:
    from hushh_mcp.one_adk.scheduled_one_agent import scheduled_finish_tool

    invocation = getattr(callback_context, "invocation_id", None)
    outcome = getattr(callback_context, "state", {}).get(STATE_DRIVE_READ_OUTCOME)
    if (
        invocation
        and isinstance(outcome, dict)
        and outcome.get("invocation") == invocation
        and outcome.get("outcome") in _DRIVE_CONNECTION_ANSWERS
    ):
        from hushh_mcp.one_adk.agent_tree import STATE_PKM_CONTEXT
        from hushh_mcp.one_adk.request_secrets import resolve_request_secret

        memory = resolve_request_secret(callback_context.state.get(STATE_PKM_CONTEXT))
        if not memory:
            # Without another authorized source, never reinterpret old filenames
            # as fresh Drive evidence.
            answer = _DRIVE_CONNECTION_ANSWERS[outcome["outcome"]]
            return LlmResponse(
                content=types.Content(role="model", parts=[types.Part(text=answer)]),
                turn_complete=True,
            )
        llm_request.append_instructions(
            [
                "CURRENT DRIVE READ DID NOT PROVIDE FILE EVIDENCE: " + outcome["outcome"] + ". "
                "Answer personal recall from CONSENTED TURN INFORMATION when it contains "
                "the requested facts. A missing personal detail is unknown; do not require "
                "Drive to answer a memory question. For an explicit Drive request, explain "
                "the current connection or read failure. Never claim a fresh file check, "
                "reuse earlier filenames or links as current results, or execute another "
                "action. The external-read authority boundary remains in effect."
            ]
        )
    if external_read_active(callback_context):
        # This callback runs only after the read's tool result has returned to
        # the model. A parallel draft call in the original batch stays blocked.
        callback_context.state[STATE_EXTERNAL_READ_CONTINUATION] = callback_context.invocation_id
        admitted = {
            name: tool
            for name, tool in llm_request.tools_dict.items()
            if scheduled_finish_tool(tool, callback_context)
            or _reviewed_mcp_tool(tool)
            or _reviewable_draft_tool(tool)
            or (
                _selected_share_ready(callback_context)
                and _reviewable_selected_drive_share_tool(tool)
            )
            or _receipt_handback_tool(tool, callback_context)
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

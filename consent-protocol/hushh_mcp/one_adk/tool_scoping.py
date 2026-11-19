"""Per-turn intent scoping for root agent leaf tool declarations.

`_one_roster_tools()` stays intact as the complete static roster for capability
matrix generation and governance assertions, while `scope_leaf_tools_before_model`
trims unused domain-specific leaf schemas out of each outgoing model request.
"""

from __future__ import annotations

import os
from typing import Any

from google.genai import types as genai_types

CALENDAR_LEAF_TOOLS: frozenset[str] = frozenset(
    {
        "calendar_summary",
        "calendar_invitations",
        "open_calendar_invitation",
        "calendar_calendars",
        "calendar_events",
        "calendar_event_detail",
        "calendar_availability",
        "calendar_free_slots",
        "propose_calendar_event",
        "propose_calendar_reschedule",
        "propose_calendar_cancellation",
    }
)

LOCATION_LEAF_TOOLS: frozenset[str] = frozenset(
    {
        "list_my_location_circles",
        "get_location_circle_members",
        "list_my_location_shares",
        "list_location_shared_with_me",
        "list_pending_location_requests",
        "list_my_outgoing_location_requests",
    }
)

DRIVE_LEAF_TOOLS: frozenset[str] = frozenset(
    {
        "inspect_selected_drive_files",
        "propose_document_request",
        "propose_drive_bulk_share",
        "propose_drive_share",
        "read_selected_drive_search_result",
        "create_drive_file",
        "copy_drive_file",
        "move_drive_file",
        "comment_on_drive_file",
        "propose_drive_file_share",
        "propose_drive_file_trash",
    }
)

SHARING_LIST_LEAF_TOOLS: frozenset[str] = frozenset(
    {
        "list_my_connections",
        "list_information_shared_with_me",
        "list_active_grants",
        "list_my_outgoing_information_requests",
        "list_pending_information_requests",
        "list_pending_connection_requests",
        "discover_person_information",
        "propose_information_request",
    }
)

ALL_SCOPED_LEAF_TOOLS: frozenset[str] = (
    CALENDAR_LEAF_TOOLS | LOCATION_LEAF_TOOLS | DRIVE_LEAF_TOOLS | SHARING_LIST_LEAF_TOOLS
)

_PACK_KEYWORDS: tuple[tuple[frozenset[str], tuple[str, ...]], ...] = (
    (
        CALENDAR_LEAF_TOOLS,
        (
            "calendar",
            "schedule",
            "meeting",
            "event",
            "invite",
            "invitation",
            "availability",
            "available",
            "free slot",
            "reschedule",
            "cancel",
            "appointment",
            "busy",
            "today",
            "tomorrow",
            "this week",
            "/calendar",
        ),
    ),
    (
        LOCATION_LEAF_TOOLS,
        (
            "location",
            "circle",
            "where is",
            "sharing my location",
            "nearby",
            "/one/location",
        ),
    ),
    (
        DRIVE_LEAF_TOOLS,
        (
            "drive",
            "document",
            "file",
            "folder",
            "pdf",
            "sheet",
            "doc",
            "upload",
            "/files",
        ),
    ),
    (
        SHARING_LIST_LEAF_TOOLS,
        (
            "share",
            "shared",
            "consent",
            "grant",
            "request",
            "ask ",
            "asking",
            "access",
            "connection",
            "connect",
            "revoke",
            "approve",
            "deny",
            "person",
            "preference",
            "who has",
            "/one/consent",
            "/people",
        ),
    ),
)


def _recent_intent_text(contents: list[Any]) -> str:
    """Extract lowercase text from the last 2 user/context contents."""
    user_texts: list[str] = []
    for content in contents:
        if getattr(content, "role", None) != "user":
            continue
        parts = getattr(content, "parts", None) or []
        chunk = " ".join(str(getattr(part, "text", "") or "") for part in parts).strip()
        if chunk:
            user_texts.append(chunk)
    return " ".join(user_texts[-2:]).lower()


def _history_referenced_tools(contents: list[Any]) -> set[str]:
    """Return every tool name already present in call/response history."""
    used: set[str] = set()
    for content in contents:
        for part in getattr(content, "parts", None) or []:
            call = getattr(part, "function_call", None)
            if call is not None and getattr(call, "name", None):
                used.add(str(call.name))
            response = getattr(part, "function_response", None)
            if response is not None and getattr(response, "name", None):
                used.add(str(response.name))
    return used


def _active_leaf_tools(intent_text: str, history_tools: set[str]) -> set[str]:
    active: set[str] = set(history_tools)
    for pack, keywords in _PACK_KEYWORDS:
        if any(keyword in intent_text for keyword in keywords) or (pack & history_tools):
            active.update(pack)
    return active


def scope_leaf_tools_before_model(callback_context: Any, llm_request: Any) -> None:
    """Before-model callback: prune unrelated leaf tool declarations for lower latency & tokens."""
    del callback_context
    if os.getenv("HUSHH_ONE_TOOL_SCOPING_DISABLED", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }:
        return
    config = getattr(llm_request, "config", None)
    existing_tools = list(getattr(config, "tools", None) or [])
    if config is None or not existing_tools:
        return

    contents = list(getattr(llm_request, "contents", None) or [])
    intent_text = _recent_intent_text(contents)
    history_tools = _history_referenced_tools(contents)
    active_leaves = _active_leaf_tools(intent_text, history_tools)
    excluded_leaves = ALL_SCOPED_LEAF_TOOLS - active_leaves
    if not excluded_leaves:
        return

    filtered_tools: list[genai_types.Tool] = []
    removed_names: set[str] = set()
    for tool in existing_tools:
        declarations = getattr(tool, "function_declarations", None)
        if not declarations:
            filtered_tools.append(tool)
            continue
        kept_decls = []
        for decl in declarations:
            name = str(getattr(decl, "name", "") or "")
            if name in excluded_leaves:
                removed_names.add(name)
            else:
                kept_decls.append(decl)
        if kept_decls:
            filtered_tools.append(tool.model_copy(update={"function_declarations": kept_decls}))
        else:
            # Preserve built-in non-function tool fields if present on the same Tool object.
            dumped = tool.model_dump(exclude={"function_declarations"}, exclude_none=True)
            if dumped:
                filtered_tools.append(tool.model_copy(update={"function_declarations": None}))

    if not removed_names:
        return
    config.tools = filtered_tools
    tools_dict = getattr(llm_request, "tools_dict", None)
    if isinstance(tools_dict, dict):
        llm_request.tools_dict = {
            name: tool for name, tool in tools_dict.items() if name not in removed_names
        }

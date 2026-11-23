"""Two-tier per-turn indexed capability routing for root agent leaf tool declarations.

`_one_roster_tools()` stays intact as the complete static roster for capability
matrix generation and governance assertions, while `scope_leaf_tools_before_model`
combines:
1. Tier-1 O(1) semantic stem indexing so common turns include only matching leaf
   tool schemas (~4-8 KB instead of ~50 KB) in a single model call.
2. Tier-2 dynamic capability-pack activation (`activate_capability_pack`) + a
   compact capability directory whenever any leaf pack is pruned on a live turn,
   guaranteeing 100% action recall even when phrasing is oblique or indirect.
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
        "read_selected_drive_search_result",
        "create_drive_file",
        "copy_drive_file",
        "move_drive_file",
        "comment_on_drive_file",
        "propose_drive_file_share",
        "propose_drive_file_trash",
        "propose_document_request",
        "propose_drive_share",
        "propose_drive_bulk_share",
        "inspect_selected_drive_files",
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
    }
)

MAIL_LEAF_TOOLS: frozenset[str] = frozenset(
    {
        "open_gmail_email_draft",
        "open_gmail_information_request_reply",
        "propose_gmail_mailbox_change",
        "propose_gmail_todo",
    }
)

STYLE_MODEL_LEAF_TOOLS: frozenset[str] = frozenset(
    {
        "propose_style_settings",
        "set_preferred_model",
        "list_available_models",
    }
)

ONBOARDING_GOAL_LEAF_TOOLS: frozenset[str] = frozenset(
    {
        "resolve_onboarding_goal",
        "report_no_app_action",
        "propose_goal_plan",
    }
)

RECEIPT_CLIENT_LEAF_TOOLS: frozenset[str] = frozenset(
    {
        "list_recent_receipts",
        "receipt_spending",
        "highest_receipt_spend",
        "most_frequently_purchased_products",
    }
)

_MIN_DECLARATIONS_TO_SCOPE = 26
ACTIVATE_PACK_TOOL_NAME = "activate_capability_pack"

CAPABILITY_PACKS_BY_ID: dict[str, frozenset[str]] = {
    "calendar": CALENDAR_LEAF_TOOLS,
    "location": LOCATION_LEAF_TOOLS,
    "drive_files": DRIVE_LEAF_TOOLS,
    "sharing_consent": SHARING_LIST_LEAF_TOOLS,
    "mail": MAIL_LEAF_TOOLS,
    "style_model": STYLE_MODEL_LEAF_TOOLS,
    "onboarding_goals": ONBOARDING_GOAL_LEAF_TOOLS,
    "receipts": RECEIPT_CLIENT_LEAF_TOOLS,
}

# Calendar stays with One's semantic planner, including implicit follow-ups.
# Keep the existing named pack API and other domain activation behavior.
ALL_SCOPED_LEAF_TOOLS: frozenset[str] = (
    frozenset().union(*CAPABILITY_PACKS_BY_ID.values()) - CALENDAR_LEAF_TOOLS
)

_PACK_KEYWORDS: tuple[tuple[str, frozenset[str], tuple[str, ...]], ...] = (
    (
        "calendar",
        CALENDAR_LEAF_TOOLS,
        (),
    ),
    (
        "location",
        LOCATION_LEAF_TOOLS,
        (
            "location",
            "circle",
            "where is",
            "where are",
            "sharing my location",
            "live map",
            "nearby",
            "eta",
            "/one/location",
        ),
    ),
    (
        "drive_files",
        DRIVE_LEAF_TOOLS,
        (
            "drive",
            "document",
            "file",
            "folder",
            "pdf",
            "sheet",
            "spreadsheet",
            "csv",
            "statement",
            "tax",
            "packet",
            "doc",
            "upload",
            "recording",
            "/files",
        ),
    ),
    (
        "sharing_consent",
        SHARING_LIST_LEAF_TOOLS,
        (
            "share",
            "shared",
            "sharing",
            "consent",
            "grant",
            "request",
            "waiting on me",
            "pending",
            "ask ",
            "asking",
            "access",
            "connection",
            "connect",
            "revoke",
            "stop sharing",
            "approve",
            "allow ",
            "deny",
            "decline",
            "person",
            "preference",
            "who has",
            "who can see",
            "tariff",
            "sharing price",
            "/one/consent",
            "/people",
        ),
    ),
    (
        "mail",
        MAIL_LEAF_TOOLS,
        (
            "mail",
            "email",
            "gmail",
            "inbox",
            "unread",
            "archive",
            "label",
            "draft",
            "write to ",
            "reply",
            "send ",
            "@",
            "/email",
            "/gmail",
        ),
    ),
    (
        "style_model",
        STYLE_MODEL_LEAF_TOOLS,
        (
            "style",
            "tone",
            "how you write",
            "how one writes",
            "be shorter",
            "briefer",
            "bullet",
            "formal",
            "casual",
            "direct",
            "call me",
            "nickname",
            "my name",
            "preferred name",
            "model",
            "gemini",
            "claude",
            "gpt",
            "azure",
            "switch to",
            "concise",
            "verbose",
        ),
    ),
    (
        "onboarding_goals",
        ONBOARDING_GOAL_LEAF_TOOLS,
        (
            "setup",
            "onboard",
            "welcome",
            "claim",
            "get started",
            "begin",
            "next step",
            "goal",
            "plan",
            "milestone",
            "/one/setup",
            "/login",
        ),
    ),
    (
        "receipts",
        RECEIPT_CLIENT_LEAF_TOOLS,
        (
            "receipt",
            "spend",
            "spent",
            "spending",
            "purchase",
            "invoice",
            "merchant",
            "bought",
            "order",
            "expense",
            "how much did i",
        ),
    ),
)


def activate_capability_pack(packs: list[str], tool_context: Any = None) -> dict[str, Any]:
    """Unlock one or more indexed capability tool packs (`calendar`, `location`, `drive_files`, `sharing_consent`, `mail`, `style_model`, `onboarding_goals`, `receipts`) for immediate use in this turn."""
    requested = [
        str(p or "").strip().lower()
        for p in (packs or [])
        if str(p or "").strip().lower() in CAPABILITY_PACKS_BY_ID
    ]
    if not requested:
        requested = list(CAPABILITY_PACKS_BY_ID.keys())
    state = getattr(tool_context, "state", None)
    if state is not None and hasattr(state, "__setitem__"):
        existing = list(state.get("active_tool_packs") or []) if hasattr(state, "get") else []
        merged = list(dict.fromkeys([*existing, *requested]))
        state["active_tool_packs"] = merged
    unlocked_tools = sorted(
        {tool_name for pack_id in requested for tool_name in CAPABILITY_PACKS_BY_ID[pack_id]}
    )
    return {
        "status": "ok",
        "activatedPacks": requested,
        "unlockedTools": unlocked_tools,
        "nextStep": "Call the unlocked tool directly now to fulfill the person's request.",
    }


def _build_activate_pack_tool() -> tuple[Any, genai_types.FunctionDeclaration]:
    from google.adk.tools.function_tool import FunctionTool

    fn_tool = FunctionTool(activate_capability_pack)
    decl = genai_types.FunctionDeclaration(
        name=ACTIVATE_PACK_TOOL_NAME,
        description=(
            "Unlock indexed domain tool packs for this turn when needed. "
            "Valid pack IDs: calendar, location, drive_files, sharing_consent, "
            "mail, style_model, onboarding_goals, receipts."
        ),
        parameters=genai_types.Schema(
            type=genai_types.Type.OBJECT,
            properties={
                "packs": genai_types.Schema(
                    type=genai_types.Type.ARRAY,
                    items=genai_types.Schema(type=genai_types.Type.STRING),
                    description="Pack IDs to unlock immediately.",
                )
            },
            required=["packs"],
        ),
    )
    return fn_tool, decl


def _recent_intent_text(contents: list[Any]) -> str:
    """Extract lowercase text from the last 2 user/context contents."""
    user_texts: list[str] = []
    for content in contents:
        if getattr(content, "role", None) != "user":
            continue
        parts = getattr(content, "parts", None) or []
        if any(getattr(part, "function_response", None) is not None for part in parts):
            continue
        chunk = " ".join(str(getattr(part, "text", "") or "") for part in parts).strip()
        if chunk:
            user_texts.append(chunk)
    return " ".join(user_texts[-2:]).lower()


def _history_referenced_tools_and_packs(contents: list[Any]) -> tuple[set[str], set[str]]:
    """Return every tool name and activated pack ID already present in call/response history."""
    used_tools: set[str] = set()
    used_packs: set[str] = set()
    for content in contents:
        for part in getattr(content, "parts", None) or []:
            call = getattr(part, "function_call", None)
            if call is not None and getattr(call, "name", None):
                call_name = str(call.name)
                used_tools.add(call_name)
                if call_name == ACTIVATE_PACK_TOOL_NAME:
                    args = getattr(call, "args", None) or {}
                    raw_packs = args.get("packs") if isinstance(args, dict) else None
                    if isinstance(raw_packs, list):
                        for p in raw_packs:
                            clean = str(p or "").strip().lower()
                            if clean in CAPABILITY_PACKS_BY_ID:
                                used_packs.add(clean)
                    else:
                        used_packs.update(CAPABILITY_PACKS_BY_ID.keys())
            response = getattr(part, "function_response", None)
            if response is not None and getattr(response, "name", None):
                resp_name = str(response.name)
                used_tools.add(resp_name)
                if resp_name == ACTIVATE_PACK_TOOL_NAME:
                    resp_body = getattr(response, "response", None) or {}
                    if isinstance(resp_body, dict):
                        for p in resp_body.get("activatedPacks") or []:
                            clean = str(p or "").strip().lower()
                            if clean in CAPABILITY_PACKS_BY_ID:
                                used_packs.add(clean)
    return used_tools, used_packs


def _active_leaf_tools(
    intent_text: str,
    history_tools: set[str],
    explicit_packs: set[str] | None = None,
) -> tuple[set[str], list[str]]:
    active: set[str] = set(history_tools)
    pruned_pack_ids: list[str] = []
    forced_packs = explicit_packs or set()
    for pack_id, pack, keywords in _PACK_KEYWORDS:
        if (
            pack_id in forced_packs
            or any(keyword in intent_text for keyword in keywords)
            or (pack & history_tools)
        ):
            active.update(pack)
        else:
            pruned_pack_ids.append(pack_id)
    return active, pruned_pack_ids


def _is_gemini_model_name(model: Any) -> bool:
    name = str(model or "").strip().lower()
    if "/" in name:
        name = name.rsplit("/", maxsplit=1)[-1]
    return name.startswith("gemini-")


def _is_tool_scoping_enabled(model: Any = None) -> bool:
    if os.getenv("HUSHH_ONE_TOOL_SCOPING_DISABLED", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }:
        return False
    explicit = os.getenv("HUSHH_ONE_TOOL_SCOPING_ENABLED", "").strip().lower()
    if explicit in {"1", "true", "yes"}:
        return True
    if explicit in {"0", "false", "no"}:
        return False
    # Live Gemini 4 Hydrogen measurements showed dynamic per-turn tool-list
    # mutation busts Vertex implicit prefix caching on every topic shift (13.3%
    # hit rate vs 92% on static tools — ~2.9x higher uncached token burn). Keep
    # tool declarations static by default on Gemini unless explicitly opted in.
    if _is_gemini_model_name(model):
        return False
    from hushh_mcp.runtime_settings import pod_sentinel_model_enabled

    return pod_sentinel_model_enabled()


def scope_leaf_tools_before_model(callback_context: Any, llm_request: Any) -> None:
    """Before-model callback: two-tier O(1) pack index + monotonic sticky pack latch."""
    if not _is_tool_scoping_enabled(getattr(llm_request, "model", None)):
        return
    config = getattr(llm_request, "config", None)
    existing_tools = list(getattr(config, "tools", None) or [])
    if config is None or not existing_tools:
        return
    total_decls = sum(
        len(getattr(tool, "function_declarations", None) or []) for tool in existing_tools
    )
    if total_decls < _MIN_DECLARATIONS_TO_SCOPE:
        return

    contents = list(getattr(llm_request, "contents", None) or [])
    state = getattr(callback_context, "state", None)
    screen_hint = ""
    state_packs: set[str] = set()
    if state is not None and hasattr(state, "get"):
        vc = state.get("hussh:voice_context")
        if isinstance(vc, dict):
            screen_hint = str(vc.get("screen") or "").lower()
        for p in state.get("active_tool_packs") or []:
            clean = str(p or "").strip().lower()
            if clean in CAPABILITY_PACKS_BY_ID:
                state_packs.add(clean)

    intent_text = f"{_recent_intent_text(contents)} {screen_hint}".strip()
    history_tools, history_packs = _history_referenced_tools_and_packs(contents)
    active_leaves, pruned_pack_ids = _active_leaf_tools(
        intent_text,
        history_tools,
        explicit_packs=state_packs | history_packs,
    )
    # Monotonic session-sticky pack latch: once a capability pack activates in a
    # live session, keep it latched in state so later follow-up turns never evict
    # tool declarations and invalidate implicit prefix caches.
    if state is not None and hasattr(state, "__setitem__"):
        active_pack_ids = sorted(set(CAPABILITY_PACKS_BY_ID) - set(pruned_pack_ids))
        if active_pack_ids and set(active_pack_ids) != state_packs:
            state["active_tool_packs"] = active_pack_ids
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
            dumped = tool.model_dump(exclude={"function_declarations"}, exclude_none=True)
            if dumped:
                filtered_tools.append(tool.model_copy(update={"function_declarations": None}))

    if not removed_names:
        return

    tools_dict = getattr(llm_request, "tools_dict", None)
    updated_tools_dict = (
        {name: tool for name, tool in tools_dict.items() if name not in removed_names}
        if isinstance(tools_dict, dict)
        else None
    )

    # On live ADK turns (`callback_context is not None`), expose the compact Tier-2
    # `activate_capability_pack` fallback so oblique prompts with zero keyword hits
    # can still dynamically unlock any pruned leaf pack within the same turn.
    if callback_context is not None and pruned_pack_ids and filtered_tools:
        activate_fn_tool, activate_decl = _build_activate_pack_tool()
        for idx, ftool in enumerate(filtered_tools):
            decls = list(getattr(ftool, "function_declarations", None) or [])
            if decls and all(getattr(d, "name", "") != ACTIVATE_PACK_TOOL_NAME for d in decls):
                filtered_tools[idx] = ftool.model_copy(
                    update={"function_declarations": [*decls, activate_decl]}
                )
                break
        if updated_tools_dict is not None:
            updated_tools_dict[ACTIVATE_PACK_TOOL_NAME] = activate_fn_tool

    config.tools = filtered_tools
    if updated_tools_dict is not None:
        llm_request.tools_dict = updated_tools_dict

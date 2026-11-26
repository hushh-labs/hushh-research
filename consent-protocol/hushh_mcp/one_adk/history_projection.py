"""Pure, display-safe restoration of existing encrypted conversation events."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any

from hushh_mcp.one_adk.consent_continuation import CONSENT_OUTCOME_LABELS, continued_outcomes
from hushh_mcp.one_adk.consent_redaction import shared_record_for_history
from hushh_mcp.one_adk.drive_result_privacy import _safe_result as safe_connector_result
from hushh_mcp.one_adk.external_read_boundary import READ_TOOLS
from hushh_mcp.one_adk.external_read_projection import redacted_read_receipt
from hushh_mcp.one_adk.feed_attention import FEED_ATTENTION_LABEL, opened_feed_items
from hushh_mcp.one_adk.location_chat_proposal import TOOL_NAME as LOCATION_CHAT_TOOL_NAME
from hushh_mcp.one_adk.location_chat_proposal import location_chat_proposal_from_result
from hushh_mcp.one_adk.text_attachments import history_text_attachments


def _record(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def _bounded_text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.split()).strip()
    return normalized[:limit] or None


_WORKSPACE_SETUP_TOOLS = frozenset({"discover_workspace_tools", "read_workspace_tool"})
_WORKSPACE_PROVIDERS = frozenset({"drive", "gmail", "calendar"})
_MANAGED_CONNECTOR_PROVIDERS = frozenset(
    {"plaid", "stripe", "drive", "gmail", "calendar", "custom"}
)
_CONNECTOR_ACTIVITY_TOOLS = _WORKSPACE_SETUP_TOOLS | {"manage_connector"}
_CUSTOM_CONNECTOR_ID = re.compile(r"^custom_[a-f0-9]{32}$")
_CUSTOM_CONNECTOR_STATUSES = frozenset({"saved", "disabled", "reconnect_needed"})


def _status_result(value: Any) -> dict[str, Any]:
    """Unwrap the tool envelope the same way the browser's card parser does."""
    outer = _record(value) or {}
    if isinstance(outer.get("status"), str):
        return outer
    for key in ("result", "content", "data"):
        nested = _record(outer.get(key))
        if nested and nested.get("status"):
            return nested
    return outer


def _call_providers(events: list[Any]) -> dict[str, str]:
    """Provider enum from each workspace tool call, keyed by call id.

    Only the provider enum crosses: it is the one argument the live card uses,
    and the only one a restored card may use.
    """
    providers: dict[str, str] = {}
    for event in events:
        for part in getattr(getattr(event, "content", None), "parts", None) or []:
            call = getattr(part, "function_call", None)
            call_name = getattr(call, "name", "") if call is not None else ""
            if call is None or call_name not in _CONNECTOR_ACTIVITY_TOOLS:
                continue
            call_id = _bounded_text(getattr(call, "id", None), 128)
            provider = (_record(getattr(call, "args", None)) or {}).get("provider")
            allowed = (
                _MANAGED_CONNECTOR_PROVIDERS
                if call_name == "manage_connector"
                else _WORKSPACE_PROVIDERS
            )
            if call_id and provider in allowed:
                providers[call_id] = provider
    return providers


def _saved_connectors(result: dict[str, Any]) -> list[dict[str, str]]:
    saved: list[dict[str, str]] = []
    raw_saved = result.get("saved")
    if isinstance(raw_saved, list) and len(raw_saved) <= 32:
        for raw in raw_saved:
            item = _record(raw) or {}
            connector_id = item.get("id")
            raw_name = item.get("name")
            label = (
                _bounded_text(raw_name, 100)
                if isinstance(raw_name, str)
                and len(raw_name) <= 100
                and not re.search(r"[\x00-\x1f\x7f]", raw_name)
                else None
            )
            status = item.get("status")
            if (
                not isinstance(connector_id, str)
                or not _CUSTOM_CONNECTOR_ID.fullmatch(connector_id)
                or not label
                or status not in _CUSTOM_CONNECTOR_STATUSES
            ):
                saved = []
                break
            saved.append({"id": connector_id, "name": label, "status": status})
    return saved


def _safe_workspace_connector_setup_descriptor(
    event: Any,
    selected_parts: list[Any] | None = None,
    call_providers: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    """Project the connect/manage card: a provider enum and a status, nothing else.

    The card never authorizes a connection; the owner still taps through the
    connector surface, which re-reads the grant. So the restored card carries
    no grant, scope, account, or result content.
    """
    parts = (
        selected_parts
        if selected_parts is not None
        else (getattr(getattr(event, "content", None), "parts", None) or [])
    )
    for part in parts:
        response = getattr(part, "function_response", None)
        name = getattr(response, "name", "") if response is not None else ""
        result = _status_result(getattr(response, "response", None)) if response else {}
        if name == "inspect_private_connectors":
            if result.get("status") != "setup_available" or result.get("provider") != "custom":
                continue
            saved = _saved_connectors(result)
            return {
                "activityType": "one.workspace_connector_setup.v1",
                "content": {
                    "provider": "custom",
                    "status": "manage_available",
                    **({"saved": saved} if saved else {}),
                },
            }
        if name not in _CONNECTOR_ACTIVITY_TOOLS:
            continue
        status = result.get("status")
        if status in {"permission_required", "connect_required"}:
            setup_status = "connect_required"
        elif (name == "discover_workspace_tools" and status in {"api_available", "ok"}) or (
            name == "manage_connector"
            and status in {"manage_available", "api_available", "ok", "setup_available"}
        ):
            setup_status = "manage_available"
        else:
            continue
        result_provider = result.get("provider")
        call_id = _bounded_text(getattr(response, "id", None), 128)
        argument_provider = (call_providers or {}).get(call_id or "")
        if result_provider and argument_provider and result_provider != argument_provider:
            continue
        provider = result_provider or argument_provider
        allowed_providers = (
            _MANAGED_CONNECTOR_PROVIDERS if name == "manage_connector" else _WORKSPACE_PROVIDERS
        )
        if provider not in allowed_providers:
            continue
        content: dict[str, Any] = {"provider": provider, "status": setup_status}
        if provider == "custom":
            saved = _saved_connectors(result)
            if saved:
                content["saved"] = saved
        return {
            "activityType": "one.workspace_connector_setup.v1",
            "content": content,
        }
    return None


_TURN_LOCATION_PERMISSIONS = frozenset({"not_granted", "denied", "unavailable", "not_provided"})


def _safe_turn_location_permission_descriptor(
    event: Any,
    selected_parts: list[Any] | None = None,
) -> dict[str, Any] | None:
    """Project the inline device-location toggle card when get_my_location lacked permission."""
    parts = (
        selected_parts
        if selected_parts is not None
        else (getattr(getattr(event, "content", None), "parts", None) or [])
    )
    for part in parts:
        response = getattr(part, "function_response", None)
        name = getattr(response, "name", "") if response is not None else ""
        if name != "get_my_location":
            continue
        result = _status_result(getattr(response, "response", None))
        if result.get("status") != "needs_location_permission":
            continue
        permission = str(result.get("permission") or "not_provided")
        if permission not in _TURN_LOCATION_PERMISSIONS:
            permission = "not_provided"
        return {
            "activityType": "one.turn_location_permission.v1",
            "content": {"permission": permission},
        }
    return None


# App-owned tool identities the browser already labels in the live Activity
# panel. Anything else (sub-agent transfers, confirmation plumbing) is not a
# step the owner saw by name, so it is not restored.
_ACTIVITY_TOOLS = frozenset(
    {
        "propose_drive_bulk_share",
        "discover_person_information",
        "list_pending_information_requests",
        "propose_information_request",
        "suggest_follow_ups",
        "list_my_connections",
        "inspect_selected_drive_files",
        "read_selected_drive_search_result",
        "inspect_private_connectors",
        "manage_connector",
        "probe_private_connector",
        "discover_workspace_tools",
        "read_workspace_tool",
        "ask_email_agent",
        "ask_documents_agent",
        "ask_connected_systems_agent",
        "ask_consent_agent",
        "list_pending_connection_requests",
        "google_search",
        "finance",
        "show_market_gainers",
        "show_portfolio_card",
        "show_portfolio_upload",
        "show_stock_preview",
        "wallet",
        "ask_memory_agent",
        "read_my_pkm_domain_summary",
        "add_to_pkm",
        "search_wiki",
        "read_wiki_page",
        "trace_claim",
        "optimize_personal_memory",
        "read_my_profile_status",
        "ask_location_agent",
        "list_my_location_circles",
        "get_location_circle_members",
        "list_my_location_shares",
        "list_location_shared_with_me",
        "list_pending_location_requests",
        "list_my_outgoing_location_requests",
        "list_information_shared_with_me",
        "list_active_grants",
        "list_my_outgoing_information_requests",
        "propose_document_request",
        "list_available_models",
        "set_preferred_model",
        "propose_style_settings",
        "calendar_summary",
        "calendar_invitations",
        "open_calendar_invitation",
        "calendar_calendars",
        "calendar_event_detail",
        "calendar_events",
        "calendar_availability",
        "calendar_free_slots",
        "calendar_shared_free_slots",
        "calendar_opening_detail",
        "propose_calendar_event",
        "propose_calendar_reschedule",
        "propose_calendar_cancellation",
        "files",
        "search_files",
        "read_file",
        "write_file",
        "create_folder",
        "organize_file",
        "propose_file_schedule",
        "propose_goal_plan",
        LOCATION_CHAT_TOOL_NAME,
        "open_gmail_email_draft",
        "open_gmail_information_request_reply",
        "open_gmail_reply_draft",
        "open_gmail_forward_draft",
        "gmail_search_mail",
        "gmail_scan_receipts",
        "gmail_read_thread",
        "gmail_read_attachment",
        "gmail_list_needs_reply",
        "gmail_mailbox_insights",
        "gmail_manage_labels",
        "gmail_manage_drafts",
        "gmail_manage_settings",
        "propose_gmail_mailbox_change",
        "propose_gmail_todo",
        "propose_drive_share",
        "propose_drive_file_share",
        "propose_drive_file_trash",
        "create_drive_file",
        "copy_drive_file",
        "move_drive_file",
        "comment_on_drive_file",
        "open_screen",
        "run_app_action",
        "propose_app_action",
        "report_no_app_action",
        "list_app_actions",
        "start_app_goal",
        "continue_app_goal",
        "resolve_onboarding_goal",
        "get_current_time",
        "get_my_location",
        "sync_plaid_connector",
        "read_plaid_mirror",
    }
)
_MCP_ACTIVITY_TOOL = re.compile(r"^mcp_[0-9a-f]{40}$")
_READ_STATUSES = frozenset(
    {
        "ok",
        "input_required",
        "connect_required",
        "reconnect_required",
        "connection_changed",
        "permission_denied",
        "source_changed",
        "response_too_large",
        "invalid_argument",
        "unavailable",
        # Mail only: the Email specialist read no mail and handed a receipts
        # question back to One. It restores as itself, not as a failed read.
        "receipt_functions_required",
    }
)
_MAX_ACTIVITY_STEPS = 10


def _activity_step_from_response(name: str, response: Any) -> dict[str, Any]:
    """Outcome enums only. Result bodies, arguments and provider text never cross."""
    if _MCP_ACTIVITY_TOOL.fullmatch(name):
        safe = safe_connector_result(response)
        step: dict[str, Any] = {}
        if safe["status"] == "ok":
            step["status"] = "done"
            if safe.get("review") in {"read_only", "no_credential"}:
                step["review"] = safe["review"]
        elif safe["status"] == "review_required":
            step["status"] = "waiting"
            step["review"] = "required"
        else:
            step["status"] = "blocked"
        if safe.get("connectorId"):
            step["connectorId"] = safe["connectorId"]
        return step
    if name == "read_selected_drive_search_result":
        status = (_record(response) or {}).get("status")
        return {
            "status": "done",
            "readStatus": status
            if isinstance(status, str) and status in _READ_STATUSES
            else "unavailable",
        }
    if name in READ_TOOLS and name != "inspect_selected_drive_files":
        structured = redacted_read_receipt(_record(response) or {}).get("structured")
        read_status = (_record(structured) or {}).get("status")
        return {
            "status": "done",
            **({"readStatus": read_status} if read_status in _READ_STATUSES else {}),
        }
    if name == "inspect_selected_drive_files":
        checked = _status_result(response).get("status") == "ok"
        return {"status": "done", **({"readStatus": "status_checked"} if checked else {})}
    return {"status": "done"}


def _safe_turn_activity(events: list[Any]) -> dict[str, Any] | None:
    """Rebuild one turn's Activity rows from its own tool calls and results.

    Each row is a tool identity from a fixed allowlist plus outcome enums: the
    same facts the live panel showed, and nothing it did not.
    """
    steps: list[dict[str, Any]] = []
    by_call: dict[str, dict[str, Any]] = {}
    providers = _call_providers(events)
    for event in events:
        event_identity = _bounded_text(getattr(event, "id", None), 128) or "event"
        for index, part in enumerate(getattr(getattr(event, "content", None), "parts", None) or []):
            call = getattr(part, "function_call", None)
            response = getattr(part, "function_response", None)
            item = call or response
            name = str(getattr(item, "name", "") or "")
            if item is None or not (name in _ACTIVITY_TOOLS or _MCP_ACTIVITY_TOOL.fullmatch(name)):
                continue
            call_id = _bounded_text(getattr(item, "id", None), 128) or f"{event_identity}:{index}"
            step = by_call.get(call_id)
            if step is None:
                step = {"id": call_id, "tool": name, "status": "interrupted"}
                if call_id in providers:
                    step["provider"] = providers[call_id]
                elif name in {"sync_plaid_connector", "read_plaid_mirror"}:
                    step["provider"] = "plaid"
                by_call[call_id] = step
                steps.append(step)
            if response is not None:
                step.update(_activity_step_from_response(name, getattr(response, "response", None)))
                provider = _status_result(getattr(response, "response", None)).get("provider")
                if (name in _WORKSPACE_SETUP_TOOLS and provider in _WORKSPACE_PROVIDERS) or (
                    name == "manage_connector" and provider in _MANAGED_CONNECTOR_PROVIDERS
                ):
                    step["provider"] = provider
    if not steps:
        return None
    return {
        "activityType": "one.turn_activity.v1",
        "content": {"steps": steps[-_MAX_ACTIVITY_STEPS:]},
    }


def _index_turns(events: list[Any], project_event: Callable) -> tuple:
    receipts: dict[str, dict[str, Any]] = {}
    last_answer: dict[str, int] = {}
    last_card: dict[str, int] = {}
    turn_events: dict[str, list[Any]] = {}
    projected: list[tuple[str, dict[str, Any] | None]] = []
    for index, event in enumerate(events):
        text, metadata = project_event(event)
        for part in event.content.parts or [] if event.content else []:
            response = part.function_response
            if event.author != "user" and response and response.name == LOCATION_CHAT_TOOL_NAME:
                proposal = location_chat_proposal_from_result(_status_result(response.response))
                if proposal:
                    metadata = {**(metadata or {}), "locationChatProposal": proposal}
            if response and response.name in READ_TOOLS:
                receipt = redacted_read_receipt(response.response)
                if isinstance(receipt.get("structured"), dict):
                    receipts[event.invocation_id] = receipt["structured"]
        projected.append((text, metadata))
        if event.invocation_id:
            turn_events.setdefault(event.invocation_id, []).append(event)
            if event.author == "one" and text:
                last_answer[event.invocation_id] = index
            if metadata and not text:
                last_card[event.invocation_id] = index
    return projected, turn_events, last_answer, last_card, receipts


def project_conversation_history(
    events: list[Any],
    conversation_id: str,
    limit: int,
    *,
    project_event: Callable,
    session_state: dict | None = None,
    consent_by_invocation: dict[str, str] | None = None,
    consent_ended: dict[str, str] | None = None,
    before_id: str | None = None,
) -> dict[str, Any]:
    messages: list[dict[str, object]] = []
    state = session_state or {}
    outcomes = continued_outcomes(state)
    outcome_labels = {CONSENT_OUTCOME_LABELS[outcome] for outcome in outcomes.values()}
    if opened_feed_items(state):
        outcome_labels.add(FEED_ATTENTION_LABEL)
    by_invocation = consent_by_invocation or {}
    ended = consent_ended or {}
    projected, turn_events, last_answer, last_card, receipts = _index_turns(events, project_event)
    # A turn's cards and Activity belong with its answer, as they were shown
    # live. Card-only tool events fold into the answer; a turn without an
    # answer keeps its last card message as the anchor.
    held_cards: dict[str, list[dict[str, Any]]] = {}
    held_location_proposals: dict[str, dict[str, Any]] = {}
    for index, event in enumerate(events):
        text, metadata = projected[index]
        attachments = history_text_attachments(event)
        if attachments:
            metadata = {**(metadata or {}), "attachments": attachments}
        if (event.author not in {"user", "one"} and not metadata) or (not text and not metadata):
            continue
        if event.author not in {"user", "one"}:
            text = ""  # Tool events restore only allowlisted safe descriptors.
        turn = event.invocation_id
        answer_index = last_answer.get(turn) if turn else None
        if metadata and not text and answer_index is not None and answer_index > index:
            cards = metadata.get("structuredExperiences")
            proposal = metadata.get("locationChatProposal")
            if cards:
                held_cards.setdefault(turn, []).extend(cards)
            if proposal:
                held_location_proposals[turn] = proposal
            if cards or proposal:
                continue
        is_anchor = (
            bool(turn)
            and event.author != "user"
            and index == (answer_index if answer_index is not None else last_card.get(turn))
        )
        if is_anchor:
            cards = [
                *held_cards.pop(turn, []),
                *((metadata or {}).get("structuredExperiences") or []),
            ]
            activity = _safe_turn_activity(turn_events.get(turn, []))
            if cards:
                metadata = {
                    **(metadata or {}),
                    "kind": "structured_experience",
                    "structuredExperiences": cards,
                    "structuredExperience": {
                        key: value for key, value in cards[0].items() if key != "id"
                    },
                    "structuredExperienceId": (metadata or {}).get("structuredExperienceId")
                    or cards[0]["id"],
                }
            if activity:
                metadata = {**(metadata or {}), "turnActivity": activity}
            if turn in held_location_proposals:
                metadata = {
                    "locationChatProposal": held_location_proposals.pop(turn),
                    **(metadata or {}),
                }
            if event.author == "one" and turn in receipts and answer_index == index:
                metadata = {**(metadata or {}), "specialist_read": receipts[turn]}
        if event.author == "user" and text in outcome_labels:
            metadata = {**(metadata or {}), "kind": "selection", "display": text}
        consent_bundle = by_invocation.get(str(turn or ""))
        if consent_bundle and event.author == "user" and text in outcome_labels:
            metadata = {
                **(metadata or {}),
                "consentBundleId": consent_bundle,
                **({"consentAccessEnded": True} if consent_bundle in ended else {}),
            }
        elif consent_bundle and event.author != "user":
            outcome = ended.get(consent_bundle)
            access = {
                "bundleId": consent_bundle,
                "state": "ended" if outcome else "live",
                "outcome": outcome,
                **shared_record_for_history(state, consent_bundle),
            }
            tag = {"consentBundleId": consent_bundle, "consentAccess": access}
            if outcome:
                # After revocation, no prior answer, card or activity leaves history.
                if not is_anchor:
                    continue
                text, metadata = "", {**tag, "consentAccessEnded": True}
            else:
                metadata = {**(metadata or {}), **tag}
        messages.append(
            {
                "id": event.id or f"{event.invocation_id}:{len(messages)}",
                "conversation_id": conversation_id,
                "role": "user" if event.author == "user" else "assistant",
                "status": "interrupted" if event.interrupted else "complete",
                "content": text,
                "model": event.model_version,
                "created_at": event.timestamp,
                "completed_at": event.timestamp,
                "metadata": metadata,
            }
        )
    pool = messages
    if isinstance(before_id, str) and before_id.strip():
        normalized_before = before_id.strip()
        for pos, entry in enumerate(messages):
            if str(entry.get("id") or "") == normalized_before:
                pool = messages[:pos]
                break
    sliced = pool[-limit:] if limit > 0 else []
    has_more = len(pool) > len(sliced)
    oldest_cursor = str(sliced[0]["id"]) if (has_more and sliced and sliced[0].get("id")) else None
    return {
        "conversation_id": conversation_id,
        "messages": sliced,
        "has_more": has_more,
        "oldest_cursor": oldest_cursor,
    }

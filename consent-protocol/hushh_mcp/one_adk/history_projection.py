"""Pure, display-safe restoration of existing encrypted conversation events."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any

from hushh_mcp.one_adk.drive_result_privacy import _safe_result as safe_connector_result
from hushh_mcp.one_adk.external_read_boundary import READ_TOOLS
from hushh_mcp.one_adk.external_read_projection import redacted_read_receipt


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
            if call is None or getattr(call, "name", "") not in _WORKSPACE_SETUP_TOOLS:
                continue
            call_id = _bounded_text(getattr(call, "id", None), 128)
            provider = (_record(getattr(call, "args", None)) or {}).get("provider")
            if call_id and provider in _WORKSPACE_PROVIDERS:
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
        if name not in _WORKSPACE_SETUP_TOOLS:
            continue
        status = result.get("status")
        if status == "permission_required":
            setup_status = "connect_required"
        elif name == "discover_workspace_tools" and status in {"api_available", "ok"}:
            setup_status = "manage_available"
        else:
            continue
        result_provider = result.get("provider")
        call_id = _bounded_text(getattr(response, "id", None), 128)
        argument_provider = (call_providers or {}).get(call_id or "")
        if result_provider and argument_provider and result_provider != argument_provider:
            continue
        provider = result_provider or argument_provider
        if provider not in _WORKSPACE_PROVIDERS:
            continue
        return {
            "activityType": "one.workspace_connector_setup.v1",
            "content": {"provider": provider, "status": setup_status},
        }
    return None


# App-owned tool identities the browser already labels in the live Activity
# panel. Anything else (sub-agent transfers, confirmation plumbing) is not a
# step the owner saw by name, so it is not restored.
_ACTIVITY_TOOLS = frozenset(
    {
        "discover_person_information",
        "list_pending_information_requests",
        "propose_information_request",
        "list_my_connections",
        "inspect_selected_drive_files",
        "inspect_private_connectors",
        "discover_workspace_tools",
        "read_workspace_tool",
        "ask_email_agent",
        "ask_documents_agent",
        "ask_connected_systems_agent",
        "ask_consent_agent",
        "list_pending_connection_requests",
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
                by_call[call_id] = step
                steps.append(step)
            if response is not None:
                step.update(_activity_step_from_response(name, getattr(response, "response", None)))
                provider = _status_result(getattr(response, "response", None)).get("provider")
                if name in _WORKSPACE_SETUP_TOOLS and provider in _WORKSPACE_PROVIDERS:
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
        projected.append((text, metadata))
        if event.invocation_id:
            turn_events.setdefault(event.invocation_id, []).append(event)
            if event.author == "one" and text:
                last_answer[event.invocation_id] = index
            if metadata and not text:
                last_card[event.invocation_id] = index
        for part in event.content.parts or [] if event.content else []:
            response = part.function_response
            if response and response.name in READ_TOOLS:
                receipt = redacted_read_receipt(response.response)
                if isinstance(receipt.get("structured"), dict):
                    receipts[event.invocation_id] = receipt["structured"]
    return projected, turn_events, last_answer, last_card, receipts


def project_conversation_history(
    events: list[Any], conversation_id: str, limit: int, *, project_event: Callable
) -> dict[str, Any]:
    messages: list[dict[str, object]] = []
    projected, turn_events, last_answer, last_card, receipts = _index_turns(events, project_event)
    # A turn's cards and Activity belong with its answer, as they were shown
    # live. Card-only tool events fold into the answer; a turn without an
    # answer keeps its last card message as the anchor.
    held_cards: dict[str, list[dict[str, Any]]] = {}
    for index, event in enumerate(events):
        text, metadata = projected[index]
        if (event.author not in {"user", "one"} and not metadata) or (not text and not metadata):
            continue
        if event.author not in {"user", "one"}:
            text = ""  # Tool events restore only allowlisted safe descriptors.
        turn = event.invocation_id
        answer_index = last_answer.get(turn) if turn else None
        if (
            metadata
            and not text
            and answer_index is not None
            and answer_index > index
            and metadata.get("structuredExperiences")
        ):
            held_cards.setdefault(turn, []).extend(metadata["structuredExperiences"])
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
            if event.author == "one" and turn in receipts and answer_index == index:
                metadata = {**(metadata or {}), "specialist_read": receipts[turn]}
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
    return {"conversation_id": conversation_id, "messages": messages[-limit:]}

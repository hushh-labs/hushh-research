"""Content-free Browser receipts in the existing owner-encrypted chat journal."""

from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING, Any

from google.adk.events import Event

from hushh_mcp.services.pod_browser.activity_receipt import parse_activity_receipt

if TYPE_CHECKING:
    from hushh_mcp.one_adk.pod_agui_context import PodChatContext
    from hushh_mcp.services.pod_browser.task_contracts import BrowserTaskSnapshot

_KIND = "browser_activity_receipt"


def _fold_receipt(entries: dict, receipt: dict) -> None:
    key = (receipt["kind"], receipt["task_id"], receipt["operation_id"])
    previous = entries.get(key)
    # Concurrent app requests may commit an older Allow observation after the
    # final outcome. Neither a journal tail nor an older checkpoint can undo it.
    if previous and previous["state"] != "allowed" and receipt["state"] == "allowed":
        return
    entries[key] = receipt
    while len(entries) > 8:
        del entries[next(iter(entries))]


def accepted_browser_creations(events: list[Any]) -> list[tuple[int, Any, dict]]:
    """Only successful One tool results establish a task's conversation binding."""
    result = []
    for index, event in enumerate(events):
        if event.author != "one" or getattr(event, "partial", False):
            continue
        for part in getattr(getattr(event, "content", None), "parts", None) or []:
            response = getattr(part, "function_response", None)
            if getattr(part, "thought", False) or response is None:
                continue
            value = getattr(response, "response", None)
            if (
                response.name == "start_browser_task"
                and isinstance(value, dict)
                and value.get("status") == "accepted"
                and isinstance(value.get("binding"), dict)
                and event.invocation_id
            ):
                result.append((index, event, value["binding"]))
    return result


def restored_browser_activity(
    events: list[Any], snapshots: tuple[Any, ...] = ()
) -> tuple[dict[str, list[dict]], dict[str, int]]:
    """Fold bounded presentation facts into their original turn, without a controller."""
    creations = {
        (event.invocation_id, binding.get("task_id")): index
        for index, event, binding in accepted_browser_creations(events)
    }
    by_turn: dict[str, dict[tuple[str, str, str], dict]] = {}
    anchors: dict[str, int] = {}
    for event in events:
        metadata = getattr(event, "custom_metadata", None)
        if (
            event.author != "browser_activity"
            or not isinstance(metadata, dict)
            or set(metadata) != {"kind", "receipt"}
            or metadata.get("kind") != _KIND
        ):
            continue
        receipt = parse_activity_receipt(metadata["receipt"])
        turn = event.invocation_id
        if receipt is None or (turn, receipt["task_id"]) not in creations:
            continue
        entries = by_turn.setdefault(turn, {})
        _fold_receipt(entries, receipt)
        anchors[turn] = max(anchors.get(turn, -1), creations[(turn, receipt["task_id"])])
    # A closed app cannot send its final presentation update. The existing
    # sealed task checkpoint is an independent durable outcome source; reading
    # its bounded metadata never restores a Browser executor or grants a lease.
    for snapshot in snapshots:
        receipt = parse_activity_receipt(snapshot.activity_receipt)
        if receipt is None or receipt["task_id"] != snapshot.binding.task_id:
            continue
        for index, event, created in accepted_browser_creations(events):
            if not all(
                created.get(key) == getattr(snapshot.binding, key)
                for key in (
                    "owner_id",
                    "pod_id",
                    "incarnation",
                    "task_id",
                )
            ):
                continue
            turn = event.invocation_id
            entries = by_turn.setdefault(turn, {})
            _fold_receipt(entries, receipt)
            anchors[turn] = max(anchors.get(turn, -1), index)
    return {turn: list(entries.values()) for turn, entries in by_turn.items()}, anchors


async def browser_activity_snapshots(owner: PodChatContext, events: list[Any]) -> tuple[Any, ...]:
    """One owner history read, no historical controller, model or idle polling."""
    from hushh_mcp.services.pod_browser.contracts import BrowserRefused
    from hushh_mcp.services.pod_browser.task_contracts import BrowserOwnerAccess

    runtime = getattr(owner, "browser_runtime", None)
    if runtime is None or not hasattr(runtime, "read_activity_receipts"):
        return ()
    task_ids = list(
        dict.fromkeys(
            created["task_id"]
            for _, _, created in accepted_browser_creations(events)
            if created.get("owner_id") == owner.owner
            and created.get("pod_id") == owner.hushh_id
            and isinstance(created.get("task_id"), str)
        )
    )[-20:]
    if not task_ids:
        return ()
    access = BrowserOwnerAccess(
        owner_id=owner.owner,
        pod_id=owner.hushh_id,
        incarnation=owner._browser_incarnation,
        expires_at=int(owner.claims["exp"]),
        check=owner._browser_history_access,
        environment="uat" if owner.authority.environment == "uat" else "development",
    )
    try:
        snapshots = await runtime.read_activity_receipts(access, task_ids)
    except BrowserRefused:
        # A historical receipt already in encrypted ADK history remains valid.
        # Unavailable current Browser metadata never implies a completed task.
        await owner.require_access()
        return ()
    await owner.require_access()
    return tuple(snapshots.values())


async def record_browser_activity(
    owner: PodChatContext, conversation_id: str, snapshot: BrowserTaskSnapshot
) -> dict[str, Any]:
    """The client supplies identifiers only; the runtime supplies the actual outcome."""
    from hushh_mcp.one_adk.agent_tree import ONE_APP_NAME
    from hushh_mcp.one_adk.history_descriptors import (
        _event_text,
        _safe_agent_history_metadata,
        _submitted_source_id,
    )
    from hushh_mcp.one_adk.history_projection import _call_providers, project_conversation_history

    receipt = parse_activity_receipt(snapshot.activity_receipt)
    binding = snapshot.binding
    if (
        receipt is None
        or receipt["task_id"] != binding.task_id
        or binding.owner_id != owner.owner
        or binding.pod_id != owner.hushh_id
        or binding.incarnation != owner._browser_incarnation
    ):
        raise ValueError("BROWSER_ACTIVITY_NOT_ADMITTED")
    await owner.require_access()
    with owner.runtime_scope():
        session = await owner.sessions.get_session(
            app_name=ONE_APP_NAME, user_id=owner.owner, session_id=conversation_id
        )
        await owner.require_access()
        if session is None:
            raise ValueError("BROWSER_ACTIVITY_CONVERSATION_NOT_FOUND")
        matches = [
            event
            for _, event, created in accepted_browser_creations(session.events)
            if all(
                created.get(key) == getattr(binding, key)
                for key in ("owner_id", "pod_id", "incarnation", "task_id")
            )
        ]
        turns = {event.invocation_id for event in matches}
        if len(turns) != 1:
            raise ValueError("BROWSER_ACTIVITY_CONVERSATION_MISMATCH")
        (turn,) = turns
        identity = json.dumps([conversation_id, receipt], sort_keys=True, separators=(",", ":"))
        event = Event(
            id="browser_activity_" + hashlib.sha256(identity.encode()).hexdigest(),
            invocation_id=turn,
            author="browser_activity",
            custom_metadata={"kind": _KIND, "receipt": receipt},
        )
        # This existing CAS operation persists metadata without adding model
        # content or a second history store. Retries cannot duplicate it.
        await owner.require_access()
        await owner.sessions.append_event_once(
            app_name=ONE_APP_NAME, user_id=owner.owner, session_id=conversation_id, event=event
        )
        await owner.require_access()
        await owner.projection.snapshot(force_save=True)
        await owner.require_access()
        session = await owner.sessions.get_session(
            app_name=ONE_APP_NAME, user_id=owner.owner, session_id=conversation_id
        )
        await owner.require_access()
    if session is None:
        raise ValueError("BROWSER_ACTIVITY_CONVERSATION_NOT_FOUND")
    submitted = {source for e in session.events if (source := _submitted_source_id(e))}
    providers = _call_providers(session.events)
    projected = project_conversation_history(
        session.events,
        conversation_id,
        max(1, len(session.events)),
        session_state=session.state,
        project_event=lambda e: (
            _event_text(e),
            _safe_agent_history_metadata(e, submitted, providers),
        ),
    )
    for message in projected["messages"]:
        for committed in (message.get("metadata") or {}).get("compactActivityReceipts", []):
            if all(committed[key] == receipt[key] for key in ("kind", "task_id", "operation_id")):
                return {
                    "conversation_id": conversation_id,
                    "message_id": message["id"],
                    "receipt": committed,
                }
    raise ValueError("BROWSER_ACTIVITY_HISTORY_UNAVAILABLE")

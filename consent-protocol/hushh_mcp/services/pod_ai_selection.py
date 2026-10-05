"""The person's "Bring your own AI" selection, held by their own agent.

The device seals a provider, model and API key to this pod
(``pod_ai_selection_seal``); the pod opens it, checks the key with one tiny live
call, and only then appends record kind ``pod_ai_selection_v1`` to its own commit
log. The log's sealing protects the key at rest and the hub never holds it. Reading
the current selection is "the newest record for this owner", exactly as
``pod_config`` reads its record: dispatch on kind, filter on owner, ignore the rest.

A clearing record (``cleared: true``) removes the selection and returns the agent to
its default model path. It carries the newest ``issuedAtMs`` forward, so an old
envelope replayed after a clear is still a rollback and still refused.

The turn path reads a process-wide active copy, loaded once at startup and replaced
by every successful write. A copy that could NOT be loaded is not "no selection":
treating it so would quietly move a person who chose their own AI onto a managed
model, which is the one outcome this feature exists to rule out. So a failed load
refuses turns (``AiSelectionUnavailable``) until a read of the log succeeds.
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Optional

from hushh_mcp.services.pod_ai_selection_seal import (
    STALE_SELECTION,
    AiSelectionRefused,
    OpenedSelection,
)

logger = logging.getLogger(__name__)

POD_AI_SELECTION_RECORD_KIND = "pod_ai_selection_v1"
POD_AI_SELECTION_VERSION = 1
_APPEND_ATTEMPTS = 3


class AiSelectionUnavailable(RuntimeError):
    """This pod could not read whether its owner chose their own AI."""


class AiSelectionStoreMissing(RuntimeError):
    """This pod has no durable store, so it cannot hold a selection."""


@dataclass(frozen=True)
class AiSelection:
    """The owner's active choice. ``api_key`` never appears in a repr or a report."""

    provider: str
    model: Optional[str]
    api_key: str = field(repr=False)
    transport: Optional[str]
    vertex_project: Optional[str]
    vertex_location: Optional[str]
    issued_at_ms: int
    selection_id: str
    checked_at_ms: int


def _now_ms() -> int:
    return int(time.time() * 1000)


def _from_payload(payload: Mapping[str, Any]) -> Optional[AiSelection]:
    """A stored record as a selection; a malformed one is ignored, never half-used."""
    try:
        provider = str(payload["provider"])
        api_key = str(payload["apiKey"])
        if not provider or not api_key:
            return None
        return AiSelection(
            provider=provider,
            model=payload.get("model") or None,
            api_key=api_key,
            transport=payload.get("transport") or None,
            vertex_project=payload.get("vertexProject") or None,
            vertex_location=payload.get("vertexLocation") or None,
            issued_at_ms=int(payload["issuedAtMs"]),
            selection_id=str(payload.get("selectionId") or ""),
            checked_at_ms=int(payload.get("checkedAtMs") or 0),
        )
    except (KeyError, TypeError, ValueError):
        logger.warning("pod_ai_selection.stored_record_ignored")
        return None


def selection_from_records(
    records: Any, *, hushh_id: str, strict: bool = False
) -> tuple[Optional[AiSelection], int]:
    """(newest selection for this owner or None, newest ``issuedAtMs`` ever seen).

    ``strict`` is for the turn path: a newest record that cannot be read raises, so
    turns refuse instead of reading "no selection" and falling back. Writes read
    leniently, so the owner can always replace a damaged record with a fresh choice.
    """
    current: Optional[AiSelection] = None
    floor = 0
    unreadable = False
    for record in records or []:
        if str((record or {}).get("kind") or "") != POD_AI_SELECTION_RECORD_KIND:
            continue
        payload = (record or {}).get("payload") or {}
        if not isinstance(payload, Mapping) or str(payload.get("hushh_id") or "") != hushh_id:
            continue
        issued = payload.get("issuedAtMs")
        if type(issued) is int:
            floor = max(floor, issued)
        cleared = payload.get("cleared") is True
        current = None if cleared else _from_payload(payload)
        unreadable = not cleared and current is None
    if strict and unreadable:
        raise AiSelectionUnavailable("the newest AI selection record could not be read")
    return current, floor


async def _snapshot(log: Any, *, hushh_id: str) -> tuple[Optional[AiSelection], int, int]:
    records = await log.replay()
    current, floor = selection_from_records(records, hushh_id=hushh_id)
    last_seq = int(records[-1]["seq"]) if records else 0
    return current, floor, last_seq


async def read_ai_selection(log: Any, *, hushh_id: str) -> tuple[Optional[AiSelection], int]:
    """The owner's current selection and the replay floor, straight from the log."""
    if log is None:
        return None, 0
    return selection_from_records(await log.replay(), hushh_id=hushh_id, strict=True)


async def _append_against_snapshot(log: Any, *, hushh_id: str, build: Any) -> Any:
    """Append ``build(current, floor)`` only onto the head it was computed from.

    Two writes racing must not both pass the "newer than what I hold" check, so the
    append names the sequence it read; a competing commit means read and decide again.
    """
    from hushh_mcp.services.pod_commit_log import PodLogConflict  # noqa: PLC0415

    for _ in range(_APPEND_ATTEMPTS):
        current, floor, last_seq = await _snapshot(log, hushh_id=hushh_id)
        payload, result = build(current, floor)
        if payload is None:
            return result
        try:
            await log.append(POD_AI_SELECTION_RECORD_KIND, payload, expected_seq=last_seq)
            return result
        except PodLogConflict:
            continue
    raise PodLogConflict("the selection could not be recorded against a stable head")


async def record_ai_selection(
    log: Any, *, hushh_id: str, opened: OpenedSelection, checked_at_ms: int
) -> AiSelection:
    """Make ``opened`` this owner's selection. Refuses one that is not strictly newer."""
    if log is None:
        raise AiSelectionStoreMissing("this pod has no durable store for its owner's selection")
    selection = AiSelection(
        provider=opened.provider,
        model=opened.model,
        api_key=opened.api_key,
        transport=opened.transport,
        vertex_project=opened.vertex_project,
        vertex_location=opened.vertex_location,
        issued_at_ms=opened.issued_at_ms,
        selection_id=opened.selection_id,
        checked_at_ms=checked_at_ms,
    )

    def build(_current: Optional[AiSelection], floor: int) -> tuple[dict, AiSelection]:
        if selection.issued_at_ms <= floor:
            raise AiSelectionRefused(STALE_SELECTION)
        return {
            "hushh_id": hushh_id,
            "version": POD_AI_SELECTION_VERSION,
            "provider": selection.provider,
            "model": selection.model,
            "apiKey": selection.api_key,
            "transport": selection.transport,
            "vertexProject": selection.vertex_project,
            "vertexLocation": selection.vertex_location,
            "issuedAtMs": selection.issued_at_ms,
            "selectionId": selection.selection_id,
            "checkedAtMs": selection.checked_at_ms,
        }, selection

    recorded: AiSelection = await _append_against_snapshot(log, hushh_id=hushh_id, build=build)
    set_active_ai_selection(recorded)
    return recorded


async def clear_ai_selection(log: Any, *, hushh_id: str) -> None:
    """Remove the selection; idempotent. The replay floor survives the clear."""
    if log is None:
        raise AiSelectionStoreMissing("this pod has no durable store for its owner's selection")

    def build(current: Optional[AiSelection], floor: int) -> tuple[Optional[dict], None]:
        if current is None:
            return None, None
        return {
            "hushh_id": hushh_id,
            "version": POD_AI_SELECTION_VERSION,
            "cleared": True,
            "issuedAtMs": floor,
            "clearedAtMs": _now_ms(),
        }, None

    await _append_against_snapshot(log, hushh_id=hushh_id, build=build)
    set_active_ai_selection(None)


# -- process-wide active copy and the last failure ----------------------------------

_ACTIVE: Optional[AiSelection] = None
_LOAD_FAILED = False
_LAST_FAILURE: Optional[dict[str, Any]] = None


def active_ai_selection() -> Optional[AiSelection]:
    """The selection every turn uses, or None. Raises when it could not be read."""
    if _LOAD_FAILED:
        raise AiSelectionUnavailable("this pod could not read its owner's AI selection")
    return _ACTIVE


def current_ai_selection() -> Optional[AiSelection]:
    """The same answer for reports that must never raise; unreadable reads as None."""
    return None if _LOAD_FAILED else _ACTIVE


def ai_selection_load_failed() -> bool:
    return _LOAD_FAILED


def owner_ai_in_force() -> bool:
    """True when a turn must run on the owner's own AI, or refuse: never a stand-in."""
    return _LOAD_FAILED or _ACTIVE is not None


def set_active_ai_selection(selection: Optional[AiSelection]) -> None:
    global _ACTIVE, _LOAD_FAILED
    _ACTIVE = selection
    _LOAD_FAILED = False


def note_ai_selection_failure(code: Optional[str]) -> None:
    """Remember the newest refusal for the owner's status read; None forgets it.

    Process memory only, on purpose: a failure is a moment, not a record, and writing
    every refused turn into the sealed log would grow it with nothing worth keeping.
    """
    global _LAST_FAILURE
    _LAST_FAILURE = {"code": code, "atMs": _now_ms()} if code else None


def last_ai_selection_failure() -> Optional[dict[str, Any]]:
    return dict(_LAST_FAILURE) if _LAST_FAILURE else None


def public_selection(selection: Optional[AiSelection]) -> dict[str, Any]:
    """What the owner's app may see: never the key."""
    return {
        "configured": selection is not None,
        "provider": selection.provider if selection else None,
        "model": selection.model if selection else None,
        "checkedAtMs": selection.checked_at_ms if selection else None,
    }


async def load_active_ai_selection(log: Any = None) -> Optional[AiSelection]:
    """Startup (and self-heal): load this owner's selection from the pod's own log.

    Never raises. A pod with no durable store has no selection by construction; a store
    that exists but cannot be read marks the copy unreadable, so turns refuse rather
    than fall back to a model the owner did not choose.
    """
    global _LOAD_FAILED
    hushh_id = (os.environ.get("HUSSH_ID") or "").strip()
    try:
        if log is None:
            from hushh_mcp.services.pod_memory_service import _resolve_log  # noqa: PLC0415

            log = _resolve_log()
        selection, _floor = (
            await read_ai_selection(log, hushh_id=hushh_id) if hushh_id else (None, 0)
        )
    except Exception as exc:  # noqa: BLE001 - startup must never fail on this read
        logger.warning("pod_ai_selection.load_failed reason=%s", type(exc).__name__)
        _LOAD_FAILED = True
        return None
    set_active_ai_selection(selection)
    logger.info(
        "pod_ai_selection.loaded configured=%s provider=%s",
        selection is not None,
        selection.provider if selection else None,
    )
    return selection


async def load_owner_configuration() -> None:
    """Pod startup: the configuration record, then the AI selection. Never raises."""
    from hushh_mcp.services.pod_config import load_active_pod_config  # noqa: PLC0415

    await load_active_pod_config()
    await load_active_ai_selection()


__all__ = [
    "POD_AI_SELECTION_RECORD_KIND",
    "AiSelection",
    "AiSelectionStoreMissing",
    "AiSelectionUnavailable",
    "active_ai_selection",
    "ai_selection_load_failed",
    "clear_ai_selection",
    "current_ai_selection",
    "last_ai_selection_failure",
    "load_active_ai_selection",
    "load_owner_configuration",
    "note_ai_selection_failure",
    "owner_ai_in_force",
    "public_selection",
    "read_ai_selection",
    "record_ai_selection",
    "selection_from_records",
    "set_active_ai_selection",
]

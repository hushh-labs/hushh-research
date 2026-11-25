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
from dataclasses import dataclass, field, replace
from typing import Any, Optional

from hushh_mcp.services.pod_ai_selection_seal import (
    PROVIDER_UNSUPPORTED,
    STALE_SELECTION,
    SUPPORTED_PROVIDERS,
    AiSelectionRefused,
    OpenedSelection,
)

logger = logging.getLogger(__name__)

POD_AI_SELECTION_RECORD_KIND = "pod_ai_selection_v1"
POD_AI_SELECTION_VERSION = 1
RETIRED_BYOK_PROVIDERS: frozenset[str] = frozenset({"azure", "azure_openai"})
_APPEND_ATTEMPTS = 3


class AiSelectionUnavailable(RuntimeError):
    """This pod could not read whether its owner chose their own AI."""


class AiSelectionStoreMissing(RuntimeError):
    """This pod has no durable store, so it cannot hold a selection."""


class AiSelectionNotConfigured(LookupError):
    """The requested saved provider configuration does not exist on this pod."""


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
    azure_endpoint: Optional[str] = None


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
            azure_endpoint=payload.get("azureEndpoint") or None,
        )
    except (KeyError, TypeError, ValueError):
        logger.warning("pod_ai_selection.stored_record_ignored")
        return None


def selection_state_from_records(
    records: Any, *, hushh_id: str, strict: bool = False
) -> tuple[dict[str, AiSelection], Optional[str], int, Optional[str]]:
    """Replay saved BYOK configs, active provider, floor, and retired provider for this owner.

    ``strict`` is for the turn path: a newest record that cannot be read raises, so
    turns refuse instead of reading "no selection" and falling back. Writes read
    leniently, so the owner can always replace a damaged record with a fresh choice.
    Legacy ``azure`` / ``azure_openai`` records advance ``floor`` and gracefully
    fall back to built-in AI (never marking the store unreadable).
    """
    saved_map: dict[str, AiSelection] = {}
    active_provider: Optional[str] = None
    retired_provider: Optional[str] = None
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
        action = payload.get("action")
        if action == "deactivate" or payload.get("cleared") is True:
            active_provider = None
            retired_provider = None
            if action != "deactivate" and payload.get("preserveSaved") is not True:
                saved_map.clear()
            unreadable = False
            continue
        if action == "delete_provider":
            target = str(payload.get("provider") or "")
            saved_map.pop(target, None)
            if active_provider == target:
                active_provider = None
            unreadable = False
            continue
        if action == "activate":
            target = str(payload.get("provider") or "")
            if target in saved_map:
                checked = payload.get("checkedAtMs")
                checked_ms = (
                    int(checked) if type(checked) is int else saved_map[target].checked_at_ms
                )
                saved_map[target] = replace(saved_map[target], checked_at_ms=checked_ms)
                active_provider = target
                retired_provider = None
                unreadable = False
            elif target in RETIRED_BYOK_PROVIDERS:
                retired_provider = target
                active_provider = None
                unreadable = False
            else:
                active_provider = None
                unreadable = True
            continue
        raw_provider = str(payload.get("provider") or "")
        if raw_provider in RETIRED_BYOK_PROVIDERS:
            retired_provider = raw_provider
            active_provider = None
            unreadable = False
            continue
        sel = _from_payload(payload)
        if sel is not None:
            saved_map[sel.provider] = sel
            active_provider = sel.provider
            retired_provider = None
            unreadable = False
        else:
            active_provider = None
            unreadable = True
    if strict and unreadable:
        raise AiSelectionUnavailable("the newest AI selection record could not be read")
    return saved_map, active_provider, floor, retired_provider


def selection_from_records(
    records: Any, *, hushh_id: str, strict: bool = False
) -> tuple[Optional[AiSelection], int]:
    """(active selection for this owner or None, newest ``issuedAtMs`` ever seen)."""
    saved_map, active_provider, floor, _retired = selection_state_from_records(
        records, hushh_id=hushh_id, strict=strict
    )
    return (saved_map.get(active_provider) if active_provider else None), floor


async def _snapshot_state(
    log: Any, *, hushh_id: str
) -> tuple[dict[str, AiSelection], Optional[str], int, Optional[str], int]:
    records = await log.replay()
    saved_map, active_provider, floor, retired_provider = selection_state_from_records(
        records, hushh_id=hushh_id
    )
    last_seq = int(records[-1]["seq"]) if records else 0
    return saved_map, active_provider, floor, retired_provider, last_seq


async def _snapshot(log: Any, *, hushh_id: str) -> tuple[Optional[AiSelection], int, int]:
    saved_map, active_provider, floor, _retired, last_seq = await _snapshot_state(
        log, hushh_id=hushh_id
    )
    return (saved_map.get(active_provider) if active_provider else None), floor, last_seq


async def read_ai_selection(log: Any, *, hushh_id: str) -> tuple[Optional[AiSelection], int]:
    """The owner's current selection and the replay floor, straight from the log."""
    if log is None:
        return None, 0
    return selection_from_records(await log.replay(), hushh_id=hushh_id, strict=True)


async def _append_against_snapshot_state(log: Any, *, hushh_id: str, build: Any) -> Any:
    """Append ``build(saved_map, active_provider, floor, retired_provider)`` onto head."""
    from hushh_mcp.services.pod_commit_log import PodLogConflict  # noqa: PLC0415

    for _ in range(_APPEND_ATTEMPTS):
        saved_map, active_provider, floor, retired_provider, last_seq = await _snapshot_state(
            log, hushh_id=hushh_id
        )
        payload, result = build(saved_map, active_provider, floor, retired_provider)
        if payload is None:
            return result
        try:
            await log.append(POD_AI_SELECTION_RECORD_KIND, payload, expected_seq=last_seq)
            return result
        except PodLogConflict:
            continue
    raise PodLogConflict("the selection could not be recorded against a stable head")


async def _append_against_snapshot(log: Any, *, hushh_id: str, build: Any) -> Any:
    """Append ``build(current, floor)`` only onto the head it was computed from.

    Two writes racing must not both pass the "newer than what I hold" check, so the
    append names the sequence it read; a competing commit means read and decide again.
    """
    return await _append_against_snapshot_state(
        log,
        hushh_id=hushh_id,
        build=lambda saved_map, active_provider, floor, _retired: build(
            saved_map.get(active_provider) if active_provider else None, floor
        ),
    )


async def record_ai_selection(
    log: Any, *, hushh_id: str, opened: OpenedSelection, checked_at_ms: int
) -> AiSelection:
    """Make ``opened`` this owner's active selection while preserving other saved providers."""
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
        azure_endpoint=opened.azure_endpoint,
    )

    def build(
        saved_map: dict[str, AiSelection],
        _active_provider: Optional[str],
        floor: int,
        _retired: Optional[str],
    ) -> tuple[dict, tuple[dict[str, AiSelection], AiSelection]]:
        if selection.issued_at_ms <= floor:
            raise AiSelectionRefused(STALE_SELECTION)
        next_saved = {**saved_map, selection.provider: selection}
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
            "azureEndpoint": selection.azure_endpoint,
        }, (next_saved, selection)

    next_saved, recorded = await _append_against_snapshot_state(log, hushh_id=hushh_id, build=build)
    _apply_state(next_saved, recorded.provider, None)
    return recorded


async def clear_ai_selection(
    log: Any,
    *,
    hushh_id: str,
    expected_floor: int | None = None,
    verified_default: dict[str, Any] | None = None,
) -> None:
    """Remove all saved selections; idempotent. The replay floor survives the clear."""
    if log is None:
        raise AiSelectionStoreMissing("this pod has no durable store for its owner's selection")

    def build(
        _saved_map: dict[str, AiSelection],
        _active_provider: Optional[str],
        floor: int,
        _retired: Optional[str],
    ) -> tuple[Optional[dict], None]:
        if expected_floor is not None and floor != expected_floor:
            raise AiSelectionRefused(STALE_SELECTION)
        # Even an already-default connection needs a durable verification record.
        # A legacy unverified clear also invalidates a prior verification receipt.
        return {
            "hushh_id": hushh_id,
            "version": POD_AI_SELECTION_VERSION,
            "cleared": True,
            "issuedAtMs": floor,
            "clearedAtMs": _now_ms(),
            "verifiedDefault": verified_default,
        }, None

    await _append_against_snapshot_state(log, hushh_id=hushh_id, build=build)
    _apply_state({}, None, None)
    global _DEFAULT_VERIFICATION
    _DEFAULT_VERIFICATION = dict(verified_default) if verified_default else None


async def deactivate_ai_selection(
    log: Any,
    *,
    hushh_id: str,
    expected_floor: int | None = None,
    verified_default: dict[str, Any] | None = None,
) -> tuple[dict[str, AiSelection], Optional[str]]:
    """Fall back to built-in sandbox AI without wiping saved provider configurations."""
    if log is None:
        raise AiSelectionStoreMissing("this pod has no durable store for its owner's selection")

    def build(
        saved_map: dict[str, AiSelection],
        _active_provider: Optional[str],
        floor: int,
        _retired: Optional[str],
    ) -> tuple[dict, dict[str, AiSelection]]:
        if expected_floor is not None and floor != expected_floor:
            raise AiSelectionRefused(STALE_SELECTION)
        return {
            "hushh_id": hushh_id,
            "version": POD_AI_SELECTION_VERSION,
            "cleared": True,
            "preserveSaved": True,
            "action": "deactivate",
            "issuedAtMs": floor,
            "clearedAtMs": _now_ms(),
            "verifiedDefault": verified_default,
        }, dict(saved_map)

    saved_map = await _append_against_snapshot_state(log, hushh_id=hushh_id, build=build)
    _apply_state(saved_map, None, None)
    global _DEFAULT_VERIFICATION
    _DEFAULT_VERIFICATION = dict(verified_default) if verified_default else None
    return saved_map, None


async def delete_provider_ai_selection(
    log: Any,
    *,
    hushh_id: str,
    provider: str,
) -> tuple[dict[str, AiSelection], Optional[str]]:
    """Remove a single saved provider configuration while keeping others intact."""
    if provider not in SUPPORTED_PROVIDERS:
        raise AiSelectionRefused(PROVIDER_UNSUPPORTED)
    if log is None:
        raise AiSelectionStoreMissing("this pod has no durable store for its owner's selection")

    def build(
        saved_map: dict[str, AiSelection],
        active_provider: Optional[str],
        floor: int,
        _retired: Optional[str],
    ) -> tuple[dict, tuple[dict[str, AiSelection], Optional[str]]]:
        next_saved = dict(saved_map)
        next_saved.pop(provider, None)
        next_active = None if active_provider == provider else active_provider
        return {
            "hushh_id": hushh_id,
            "version": POD_AI_SELECTION_VERSION,
            "action": "delete_provider",
            "provider": provider,
            "issuedAtMs": floor,
            "clearedAtMs": _now_ms(),
        }, (next_saved, next_active)

    next_saved, next_active = await _append_against_snapshot_state(
        log, hushh_id=hushh_id, build=build
    )
    _apply_state(next_saved, next_active, None)
    return next_saved, next_active


async def activate_saved_ai_selection(
    log: Any,
    *,
    hushh_id: str,
    provider: str,
    checked_at_ms: int,
) -> AiSelection:
    """Switch the active provider to an already-saved configuration."""
    if provider not in SUPPORTED_PROVIDERS:
        raise AiSelectionRefused(PROVIDER_UNSUPPORTED)
    if log is None:
        raise AiSelectionStoreMissing("this pod has no durable store for its owner's selection")

    def build(
        saved_map: dict[str, AiSelection],
        _active_provider: Optional[str],
        floor: int,
        _retired: Optional[str],
    ) -> tuple[dict, tuple[dict[str, AiSelection], AiSelection]]:
        current = saved_map.get(provider)
        if current is None:
            raise AiSelectionNotConfigured(provider)
        updated = replace(current, checked_at_ms=checked_at_ms)
        next_saved = {**saved_map, provider: updated}
        return {
            "hushh_id": hushh_id,
            "version": POD_AI_SELECTION_VERSION,
            "action": "activate",
            "provider": provider,
            "issuedAtMs": floor,
            "checkedAtMs": checked_at_ms,
        }, (next_saved, updated)

    next_saved, activated = await _append_against_snapshot_state(
        log, hushh_id=hushh_id, build=build
    )
    _apply_state(next_saved, provider, None)
    return activated


# -- process-wide active copy and the last failure ----------------------------------

_SAVED: dict[str, AiSelection] = {}
_ACTIVE_PROVIDER: Optional[str] = None
_RETIRED_PROVIDER: Optional[str] = None
_ACTIVE: Optional[AiSelection] = None
_LOAD_FAILED = False
_REVISION = 0
_LAST_FAILURE: Optional[dict[str, Any]] = None
_DEFAULT_VERIFICATION: Optional[dict[str, Any]] = None


def _apply_state(
    saved_map: Mapping[str, AiSelection],
    active_provider: Optional[str],
    retired_provider: Optional[str],
) -> None:
    global _SAVED, _ACTIVE_PROVIDER, _RETIRED_PROVIDER, _ACTIVE, _LOAD_FAILED, _REVISION
    global _DEFAULT_VERIFICATION
    _SAVED = dict(saved_map)
    _ACTIVE_PROVIDER = active_provider
    _RETIRED_PROVIDER = retired_provider
    _ACTIVE = _SAVED.get(active_provider) if active_provider else None
    _LOAD_FAILED = False
    _REVISION += 1
    _DEFAULT_VERIFICATION = None


def default_verification() -> Optional[dict[str, Any]]:
    return dict(_DEFAULT_VERIFICATION) if not _LOAD_FAILED and _DEFAULT_VERIFICATION else None


def active_ai_selection() -> Optional[AiSelection]:
    """The selection every turn uses, or None. Raises when it could not be read."""
    if _LOAD_FAILED:
        raise AiSelectionUnavailable("this pod could not read its owner's AI selection")
    return _ACTIVE


def current_ai_selection() -> Optional[AiSelection]:
    """The same answer for reports that must never raise; unreadable reads as None."""
    return None if _LOAD_FAILED else _ACTIVE


def saved_ai_selection(provider: str) -> Optional[AiSelection]:
    """A saved provider configuration by id, or None."""
    return None if _LOAD_FAILED else _SAVED.get(provider)


def retired_ai_provider() -> Optional[str]:
    """The legacy retired provider name encountered during replay, if any."""
    return None if _LOAD_FAILED else _RETIRED_PROVIDER


def ai_selection_load_failed() -> bool:
    return _LOAD_FAILED


def owner_ai_in_force() -> bool:
    """True when a turn must run on the owner's own AI, or refuse: never a stand-in."""
    return _LOAD_FAILED or _ACTIVE is not None


def set_active_ai_selection(selection: Optional[AiSelection]) -> None:
    if selection is None:
        _apply_state({}, None, None)
        return
    if selection.provider in RETIRED_BYOK_PROVIDERS:
        _apply_state(_SAVED, None, selection.provider)
        return
    next_saved = {**_SAVED, selection.provider: selection}
    _apply_state(next_saved, selection.provider, None)


def ai_selection_revision() -> int:
    """Process-local cache/admission fence, including clear-and-reselect changes."""
    return _REVISION


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


def public_saved_selections(
    saved: Optional[Mapping[str, AiSelection]] = None,
    active_provider: Optional[str] = None,
) -> list[dict[str, Any]]:
    """Public metadata for all saved provider configurations; never the key."""
    if saved is None:
        if _LOAD_FAILED:
            return []
        saved = _SAVED
        active_provider = _ACTIVE_PROVIDER
    return [
        {
            "provider": item.provider,
            "model": item.model,
            "transport": item.transport,
            "checkedAtMs": item.checked_at_ms,
            "active": item.provider == active_provider,
        }
        for item in saved.values()
    ]


async def load_active_ai_selection(
    log: Any = None, *, records: Any = None
) -> Optional[AiSelection]:
    """Startup (and self-heal): load this owner's selection from the pod's own log.

    Never raises. A pod with no durable store has no selection by construction; a store
    that exists but cannot be read marks the copy unreadable, so turns refuse rather
    than fall back to a model the owner did not choose.
    """
    global _LOAD_FAILED, _DEFAULT_VERIFICATION
    hushh_id = (os.environ.get("HUSSH_ID") or "").strip()
    try:
        if log is None:
            from hushh_mcp.services.pod_memory_service import _resolve_log  # noqa: PLC0415

            log = _resolve_log()
        saved_map: dict[str, AiSelection] = {}
        active_provider: Optional[str] = None
        retired_provider: Optional[str] = None
        if hushh_id:
            if records is None:
                records = await log.replay() if log is not None else []
            saved_map, active_provider, _floor, retired_provider = selection_state_from_records(
                records, hushh_id=hushh_id, strict=True
            )
    except Exception as exc:  # noqa: BLE001 - startup must never fail on this read
        logger.warning("pod_ai_selection.load_failed reason=%s", type(exc).__name__)
        _LOAD_FAILED = True
        return None
    _apply_state(saved_map, active_provider, retired_provider)
    selection = _ACTIVE
    for record in records or []:
        payload = (record or {}).get("payload") or {}
        if (
            (record or {}).get("kind") == POD_AI_SELECTION_RECORD_KIND
            and isinstance(payload, Mapping)
            and payload.get("hushh_id") == hushh_id
        ):
            receipt = payload.get("verifiedDefault") if payload.get("cleared") is True else None
            _DEFAULT_VERIFICATION = dict(receipt) if isinstance(receipt, dict) else None
    logger.info(
        "pod_ai_selection.loaded configured=%s provider=%s",
        selection is not None,
        selection.provider if selection else None,
    )
    return selection


async def load_owner_configuration(log: Any = None, *, records: Any = None) -> None:
    """Pod startup: the configuration record, then the AI selection. Never raises."""
    from hushh_mcp.services.pod_config import load_active_pod_config  # noqa: PLC0415

    await load_active_pod_config(log, records=records)
    await load_active_ai_selection(log, records=records)


__all__ = [
    "POD_AI_SELECTION_RECORD_KIND",
    "RETIRED_BYOK_PROVIDERS",
    "AiSelection",
    "AiSelectionNotConfigured",
    "AiSelectionStoreMissing",
    "AiSelectionUnavailable",
    "activate_saved_ai_selection",
    "active_ai_selection",
    "ai_selection_revision",
    "ai_selection_load_failed",
    "clear_ai_selection",
    "current_ai_selection",
    "deactivate_ai_selection",
    "delete_provider_ai_selection",
    "last_ai_selection_failure",
    "load_active_ai_selection",
    "load_owner_configuration",
    "note_ai_selection_failure",
    "owner_ai_in_force",
    "public_saved_selections",
    "public_selection",
    "read_ai_selection",
    "record_ai_selection",
    "retired_ai_provider",
    "saved_ai_selection",
    "selection_from_records",
    "selection_state_from_records",
    "set_active_ai_selection",
]

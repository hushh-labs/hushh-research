"""The owner's sealed AI selection and its ordered, fail-closed active copy.

The pod verifies a sealed selection before appending it to its own log. A clear
retains the issued-time floor so old envelopes cannot be replayed. An unreadable
selection refuses turns rather than silently switching to a managed model.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, Optional

from hushh_mcp.services.pod_ai_selection_seal import (
    STALE_SELECTION,
    AiSelectionRefused,
    OpenedSelection,
)
from hushh_mcp.services.pod_ai_selection_types import AiSelection, selection_from_payload

logger = logging.getLogger(__name__)

POD_AI_SELECTION_RECORD_KIND = "pod_ai_selection_v1"
POD_AI_SELECTION_VERSION = 1
_APPEND_ATTEMPTS = 3
SnapshotAuthorizer = Callable[[list[dict[str, Any]]], Awaitable[None]]


class AiSelectionUnavailable(RuntimeError):
    """This pod could not read whether its owner chose their own AI."""


class AiSelectionStoreMissing(RuntimeError):
    """This pod has no durable store, so it cannot hold a selection."""


class AiSelectionRecoveryPending(RuntimeError):
    """A selection committed, but its current active state is unavailable."""


class AiSelectionSuperseded(RuntimeError):
    """A later committed selection replaced this write."""


class AiSelectionOutcomeUnknown(RuntimeError):
    """A storage failure left the selection write's outcome unknown."""


def _now_ms() -> int:
    return int(time.time() * 1000)


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
        current = None if cleared else selection_from_payload(payload)
        unreadable = not cleared and current is None
    if strict and unreadable:
        raise AiSelectionUnavailable("the newest AI selection record could not be read")
    return current, floor


def selection_revision_from_records(records: Any, *, hushh_id: str) -> int:
    """Sequence of this owner's last selection event, independent of other writes."""
    for record in reversed(records or []):
        payload = (record or {}).get("payload") or {}
        if (
            (record or {}).get("kind") == POD_AI_SELECTION_RECORD_KIND
            and isinstance(payload, Mapping)
            and payload.get("hushh_id") == hushh_id
        ):
            sequence = record.get("seq")
            if type(sequence) is not int or not 0 < sequence <= 2**53 - 1:
                raise AiSelectionUnavailable("the selection revision is unavailable")
            return sequence
    return 0


async def _snapshot(
    log: Any, *, hushh_id: str, authorize: SnapshotAuthorizer
) -> tuple[Optional[AiSelection], int, int, int, int]:
    failure_epoch = _FAILURE_EPOCH
    records = await log.replay()
    await authorize(records)
    current, floor = selection_from_records(records, hushh_id=hushh_id)
    last_seq = int(records[-1]["seq"]) if records else 0
    revision = selection_revision_from_records(records, hushh_id=hushh_id)
    return current, floor, revision, last_seq, failure_epoch


async def read_ai_selection(log: Any, *, hushh_id: str) -> tuple[Optional[AiSelection], int]:
    """The owner's current selection and the replay floor, straight from the log."""
    if log is None:
        return None, 0
    return selection_from_records(await log.replay(), hushh_id=hushh_id, strict=True)


async def read_ai_selection_with_revision(
    log: Any, *, hushh_id: str
) -> tuple[Optional[AiSelection], int]:
    """Read a selection and its event revision from one durable snapshot."""
    if log is None:
        raise AiSelectionStoreMissing("this pod has no durable selection store")
    records = await log.replay()
    selection, _ = selection_from_records(records, hushh_id=hushh_id, strict=True)
    revision = selection_revision_from_records(records, hushh_id=hushh_id)
    return selection, revision


async def _append_against_snapshot(
    log: Any, *, hushh_id: str, build: Any, authorize: SnapshotAuthorizer
) -> tuple[Any, int, int]:
    """Append ``build(current, floor)`` only onto the head it was computed from.

    Two writes racing must not both pass the "newer than what I hold" check, so the
    append names the sequence it read; a competing commit means read and decide again.
    """
    from hushh_mcp.services.pod_commit_log import PodLogConflict  # noqa: PLC0415

    for _ in range(_APPEND_ATTEMPTS):
        current, floor, revision, last_seq, failure_epoch = await _snapshot(
            log, hushh_id=hushh_id, authorize=authorize
        )
        payload, result = build(current, floor, revision)
        if payload is None:
            return result, last_seq, failure_epoch
        try:
            record = await log.append(POD_AI_SELECTION_RECORD_KIND, payload, expected_seq=last_seq)
            return result, int(record["seq"]), failure_epoch
        except PodLogConflict:
            continue
        except asyncio.CancelledError:
            # A cancelled or failed storage call may have committed its head.
            # Refuse model use until a fresh read resolves the outcome.
            _mark_load_failed(None)
            raise
        except Exception as exc:
            _mark_load_failed(None)
            raise AiSelectionOutcomeUnknown("selection write outcome is unknown") from exc
    raise PodLogConflict("the selection could not be recorded against a stable head")


async def record_ai_selection(
    log: Any,
    *,
    hushh_id: str,
    opened: OpenedSelection,
    checked_at_ms: int,
    authorize: SnapshotAuthorizer,
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
        azure_endpoint=opened.azure_endpoint,
    )

    def build(
        _current: Optional[AiSelection], floor: int, _revision: int
    ) -> tuple[dict, AiSelection]:
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
            "azureEndpoint": selection.azure_endpoint,
        }, selection

    recorded, sequence, failure_epoch = await _append_against_snapshot(
        log, hushh_id=hushh_id, build=build, authorize=authorize
    )
    await _settle_committed(log, recorded, sequence=sequence, failure_epoch=failure_epoch)
    return recorded


async def clear_ai_selection(
    log: Any,
    *,
    hushh_id: str,
    authorize: SnapshotAuthorizer,
    expected_floor: int | None = None,
    expected_selection: tuple[str, int] | None = None,
    verified_default: dict[str, Any] | None = None,
) -> None:
    """Remove the selection; idempotent. The replay floor survives the clear."""
    if log is None:
        raise AiSelectionStoreMissing("this pod has no durable store for its owner's selection")

    def build(
        current: Optional[AiSelection], floor: int, revision: int
    ) -> tuple[Optional[dict], None]:
        if expected_floor is not None and floor != expected_floor:
            raise AiSelectionRefused(STALE_SELECTION)
        if expected_selection is not None and (
            current is None or (current.provider, revision) != expected_selection
        ):
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

    _result, sequence, failure_epoch = await _append_against_snapshot(
        log, hushh_id=hushh_id, build=build, authorize=authorize
    )
    await _settle_committed(
        log, None, sequence=sequence, failure_epoch=failure_epoch, verified_default=verified_default
    )


# -- process-wide active copy and the last failure ----------------------------------

_ACTIVE: Optional[AiSelection] = None
_LOAD_FAILED = False
_REVISION = 0
_APPLIED_SEQUENCE = -1
_FAILURE_EPOCH = 0
_FAILED_SEQUENCE: Optional[int] = None
_LAST_FAILURE: Optional[dict[str, Any]] = None
_DEFAULT_VERIFICATION: Optional[dict[str, Any]] = None


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


def ai_selection_load_failed() -> bool:
    return _LOAD_FAILED


def owner_ai_in_force() -> bool:
    """True when a turn must run on the owner's own AI, or refuse: never a stand-in."""
    return _LOAD_FAILED or _ACTIVE is not None


def set_active_ai_selection(selection: Optional[AiSelection]) -> None:
    global \
        _ACTIVE, \
        _LOAD_FAILED, \
        _REVISION, \
        _DEFAULT_VERIFICATION, \
        _APPLIED_SEQUENCE, \
        _FAILED_SEQUENCE
    _ACTIVE = selection
    _LOAD_FAILED = False
    _REVISION += 1
    _DEFAULT_VERIFICATION = None
    _APPLIED_SEQUENCE = -1
    _FAILED_SEQUENCE = None


def _publish_active(
    selection: Optional[AiSelection],
    *,
    sequence: int,
    failure_epoch: int,
    verified_default: Optional[dict] = None,
) -> bool:
    """Keep late completions from replacing a newer committed or hydrated state."""
    global _APPLIED_SEQUENCE, _DEFAULT_VERIFICATION
    if sequence < _APPLIED_SEQUENCE:
        return False
    if _LOAD_FAILED:
        if _FAILED_SEQUENCE is None and failure_epoch != _FAILURE_EPOCH:
            return False
        if _FAILED_SEQUENCE is not None and (
            sequence < _FAILED_SEQUENCE
            or (sequence == _FAILED_SEQUENCE and failure_epoch != _FAILURE_EPOCH)
        ):
            return False
    set_active_ai_selection(selection)
    _APPLIED_SEQUENCE = sequence
    _DEFAULT_VERIFICATION = dict(verified_default) if verified_default else None
    return True


async def _settle_committed(
    log: Any,
    selection: Optional[AiSelection],
    *,
    sequence: int,
    failure_epoch: int,
    verified_default: Optional[dict] = None,
) -> None:
    if _publish_active(
        selection, sequence=sequence, failure_epoch=failure_epoch, verified_default=verified_default
    ):
        return
    if _LOAD_FAILED:
        await load_active_ai_selection(log)
    if _LOAD_FAILED:
        raise AiSelectionRecoveryPending("saved selection is awaiting a fresh read")
    if _ACTIVE != selection or _DEFAULT_VERIFICATION != (verified_default or None):
        raise AiSelectionSuperseded("a later selection is active")


def _mark_load_failed(sequence: Optional[int]) -> None:
    """Do not let an older or unknown failed read be mistaken for a fresh state."""
    global _LOAD_FAILED, _FAILED_SEQUENCE, _FAILURE_EPOCH, _REVISION
    if sequence is not None and _APPLIED_SEQUENCE > sequence:
        return
    if not _LOAD_FAILED:
        _FAILED_SEQUENCE = sequence
    elif _FAILED_SEQUENCE is None or sequence is None:
        _FAILED_SEQUENCE = None
    else:
        _FAILED_SEQUENCE = max(_FAILED_SEQUENCE, sequence)
    _LOAD_FAILED = True
    _FAILURE_EPOCH += 1
    _REVISION += 1


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


async def load_active_ai_selection(
    log: Any = None, *, records: Any = None
) -> Optional[AiSelection]:
    """Startup (and self-heal): load this owner's selection from the pod's own log.

    Never raises. A pod with no durable store has no selection by construction; a store
    that exists but cannot be read marks the copy unreadable, so turns refuse rather
    than fall back to a model the owner did not choose.
    """
    hushh_id = (os.environ.get("HUSSH_ID") or "").strip()
    failure_epoch = _FAILURE_EPOCH
    sequence: Optional[int] = None
    try:
        if log is None:
            from hushh_mcp.services.pod_memory_service import _resolve_log  # noqa: PLC0415

            log = _resolve_log()
        if _LOAD_FAILED and _FAILED_SEQUENCE is None and log is None:
            raise AiSelectionUnavailable("a fresh selection read is required")
        selection, _floor = None, 0
        if hushh_id:
            if records is None or (_LOAD_FAILED and _FAILED_SEQUENCE is None):
                records = await log.replay() if log is not None else []
            sequence = records[-1]["seq"] if records else 0
            if type(sequence) is not int or sequence < 0:
                sequence = None
                raise AiSelectionUnavailable("the selection snapshot has no valid sequence")
            selection, _floor = (
                selection_from_records(records, hushh_id=hushh_id, strict=True)
                if records is not None
                else await read_ai_selection(log, hushh_id=hushh_id)
            )
        else:
            sequence = 0
    except Exception as exc:  # noqa: BLE001 - startup must never fail on this read
        logger.warning("pod_ai_selection.load_failed reason=%s", type(exc).__name__)
        _mark_load_failed(sequence)
        return None
    verified_default = None
    for record in records or []:
        payload = (record or {}).get("payload") or {}
        if (
            (record or {}).get("kind") == POD_AI_SELECTION_RECORD_KIND
            and isinstance(payload, Mapping)
            and payload.get("hushh_id") == hushh_id
        ):
            receipt = payload.get("verifiedDefault") if payload.get("cleared") is True else None
            verified_default = dict(receipt) if isinstance(receipt, dict) else None
    _publish_active(
        selection, sequence=sequence, failure_epoch=failure_epoch, verified_default=verified_default
    )
    effective = _ACTIVE
    logger.info(
        "pod_ai_selection.loaded configured=%s provider=%s",
        effective is not None,
        effective.provider if effective else None,
    )
    return effective


async def load_owner_configuration(log: Any = None, *, records: Any = None) -> None:
    """Pod startup: the configuration record, then the AI selection. Never raises."""
    from hushh_mcp.services.pod_config import load_active_pod_config  # noqa: PLC0415

    await load_active_pod_config(log, records=records)
    await load_active_ai_selection(log, records=records)


__all__ = [
    "POD_AI_SELECTION_RECORD_KIND",
    "AiSelection",
    "AiSelectionStoreMissing",
    "AiSelectionUnavailable",
    "active_ai_selection",
    "ai_selection_revision",
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

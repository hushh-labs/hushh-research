"""One owner, one pod, one configuration record.

The owner-pod behaviours that used to be proposed as environment flags (direct
ingress admission, the in-pod Puppy broker, memory review, the curated memory
digest, provider-memory rebuilds) live in a single sealed record in the pod's
own commit log. A pod that serves exactly one person carries that person's
configuration and defaults to the full experience; deployment topology (target,
credential, ingress) stays on ``PodSpec`` and the registry row, never here.

The record is kind ``pod_config_v1``. Every write appends a complete snapshot,
so reading the current configuration is "the newest record for this owner",
the same shape ``PodPkmStore.rebuild`` and the memory service use for their own
kinds: dispatch on kind, filter on owner, ignore other subsystems' records.
Absent record means defaults. The log's own sealing protects the bytes at rest;
an unrecognised field in a stored record is ignored on read (forward
compatibility) and refused on write (a typo must not silently do nothing).
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Mapping
from dataclasses import asdict, dataclass, fields
from typing import Any, Optional

logger = logging.getLogger(__name__)

POD_CONFIG_RECORD_KIND = "pod_config_v1"
POD_CONFIG_VERSION = 1


@dataclass(frozen=True)
class PodConfig:
    """Behaviour of one owner's pod. Every default is the full experience."""

    direct_ingress_admission: bool = True
    puppy_broker: bool = True
    memory_review_on_close: bool = True
    memory_review_catch_up: bool = True
    memory_review_max_records: int = 12
    memory_review_budget_seconds: float = 45.0
    memory_digest_max_chars: int = 1200
    memory_bank_rebuild_on_tick: bool = True

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


_DEFAULT = PodConfig()
_FIELD_TYPES: dict[str, type] = {f.name: f.type for f in fields(PodConfig)}  # type: ignore[misc]
_BOUNDS: dict[str, tuple[float, float]] = {
    "memory_review_max_records": (1, 100),
    "memory_review_budget_seconds": (5.0, 120.0),
    "memory_digest_max_chars": (0, 4000),
}


class PodConfigError(ValueError):
    """A configuration write named a field or value the record cannot hold."""


def _coerce(name: str, value: Any) -> Any:
    """Return ``value`` typed and bounded for ``name``; raise on anything else."""
    default = getattr(_DEFAULT, name)
    if isinstance(default, bool):
        if isinstance(value, bool):
            return value
        raise PodConfigError(f"{name} must be true or false")
    if isinstance(default, int):
        if isinstance(value, bool) or not isinstance(value, int):
            raise PodConfigError(f"{name} must be an integer")
    elif isinstance(default, float):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise PodConfigError(f"{name} must be a number")
        value = float(value)
    low, high = _BOUNDS.get(name, (None, None))
    if low is not None and not (low <= value <= high):
        raise PodConfigError(f"{name} must be between {low} and {high}")
    return value


def apply_changes(base: PodConfig, changes: Mapping[str, Any]) -> PodConfig:
    """A new config with ``changes`` applied. Unknown fields and bad values refuse."""
    current = base.as_dict()
    for name, value in dict(changes).items():
        if name not in _FIELD_TYPES:
            raise PodConfigError(f"unknown pod configuration field: {name}")
        current[name] = _coerce(name, value)
    return PodConfig(**current)


def _from_stored(config: Mapping[str, Any]) -> PodConfig:
    """Rebuild a config from a stored snapshot, tolerating drift field by field."""
    current = _DEFAULT.as_dict()
    for name, value in dict(config).items():
        if name not in _FIELD_TYPES:
            continue  # a newer or older image wrote a field this one does not know
        try:
            current[name] = _coerce(name, value)
        except PodConfigError as exc:
            logger.warning("pod_config.stored_field_ignored field=%s reason=%s", name, exc)
    return PodConfig(**current)


def config_from_records(records: Any, *, hushh_id: str) -> PodConfig:
    """The newest ``pod_config_v1`` record for this owner, else defaults."""
    chosen: Optional[Mapping[str, Any]] = None
    skipped_foreign = 0
    for record in records or []:
        if str((record or {}).get("kind") or "") != POD_CONFIG_RECORD_KIND:
            continue
        payload = (record or {}).get("payload") or {}
        if str(payload.get("hushh_id") or "") != hushh_id:
            skipped_foreign += 1
            continue
        config = payload.get("config")
        if isinstance(config, Mapping):
            chosen = config
    if skipped_foreign:
        logger.warning("pod_config.skipped_foreign_records count=%d", skipped_foreign)
    return _from_stored(chosen) if chosen is not None else _DEFAULT


async def resolve_pod_config(log: Any, *, hushh_id: str) -> PodConfig:
    """Read the effective configuration from the log; ``None`` log means defaults."""
    if log is None:
        return _DEFAULT
    return config_from_records(await log.replay(), hushh_id=hushh_id)


async def record_pod_config(log: Any, *, hushh_id: str, changes: Mapping[str, Any]) -> PodConfig:
    """Append a complete snapshot with ``changes`` applied and make it active."""
    if log is None:
        raise PodConfigError("this pod has no durable store for its configuration")
    if not str(hushh_id or "").strip():
        raise PodConfigError("owner identity is required to record configuration")
    current = await resolve_pod_config(log, hushh_id=hushh_id)
    updated = apply_changes(current, changes)
    await log.append(
        POD_CONFIG_RECORD_KIND,
        {
            "hushh_id": hushh_id,
            "version": POD_CONFIG_VERSION,
            "config": updated.as_dict(),
            "recorded_at_ms": int(time.time() * 1000),
        },
    )
    set_active_pod_config(updated)
    return updated


# -- process-wide active copy ---------------------------------------------------------
#
# The turn path reads configuration on every request and must not replay the log
# each time. Startup loads once; a successful write replaces the copy in place.

_ACTIVE: Optional[PodConfig] = None


def active_pod_config() -> PodConfig:
    return _ACTIVE if _ACTIVE is not None else _DEFAULT


def set_active_pod_config(config: Optional[PodConfig]) -> None:
    global _ACTIVE
    _ACTIVE = config


async def load_active_pod_config() -> PodConfig:
    """Pod startup: load this owner's configuration from the pod's own log.

    Fail-safe by construction. A pod that cannot read its configuration boots on
    the defaults and says so, rather than refusing to serve its owner.
    """
    hushh_id = (os.environ.get("HUSSH_ID") or "").strip()
    try:
        from hushh_mcp.services.pod_memory_service import _resolve_log  # noqa: PLC0415

        config = (
            await resolve_pod_config(_resolve_log(), hushh_id=hushh_id) if hushh_id else _DEFAULT
        )
    except Exception as exc:  # noqa: BLE001 - configuration must never block startup
        logger.warning("pod_config.load_failed reason=%s", type(exc).__name__)
        config = _DEFAULT
    set_active_pod_config(config)
    logger.info("pod_config.loaded defaults=%s", config == _DEFAULT)
    return config

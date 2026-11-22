"""Unified Zero-Content Wake Coalescer across Personal Sandbox, GCP BYOC & Azure BYOC.

The central wake router holds zero email bodies, subjects, filenames, prompt text,
or OAuth tokens. It tracks only opaque per-owner trigger channels, coalesced counts,
and next-wake timestamps, dispatching authenticated ``POST <pod_url>/pod/tick``
pulses identically across ``ace`` (Personal Sandbox via Edge Gateway), ``user_gcp``
(Cloud Run), and ``user_azure`` (Container Apps / VM).

Tiered Priority:
* Immediate Fast Path (0s debounce): ``circle_request``, ``scheduled_goal``,
  ``urgent_vip`` -> wakes immediately and sweeps any queued batch channels in the
  same single container wake.
* Quiet Batch Path (900s / 15-minute debounce): ``gmail``, ``calendar``, ``drive``,
  ``contacts``, ``mcp`` -> coalesces webhook bursts into one wake and defers while
  ``quiet_hours_active`` is true.
* Per-owner daily wake cap (default 24/day) protects hosted margins and BYOC bills.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from starlette.concurrency import run_in_threadpool

logger = logging.getLogger(__name__)

FAST_WAKE_TRIGGERS: frozenset[str] = frozenset({"circle_request", "scheduled_goal", "urgent_vip"})
BATCH_WAKE_TRIGGERS: frozenset[str] = frozenset({"gmail", "calendar", "drive", "contacts", "mcp"})
ALL_WAKE_TRIGGERS: frozenset[str] = FAST_WAKE_TRIGGERS | BATCH_WAKE_TRIGGERS

BATCH_DEBOUNCE_SECONDS = 900.0  # 15-minute quiet batching window
DEFAULT_DAILY_WAKE_CAP = 24
_OPAQUE_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")

# Zero-content guard: reject any payload attempting to pass PII, content, or tokens.
FORBIDDEN_CONTENT_KEYS: frozenset[str] = frozenset(
    {
        "body",
        "subject",
        "snippet",
        "text",
        "html",
        "content",
        "title",
        "filename",
        "email",
        "sender",
        "recipient",
        "attendees",
        "amount",
        "prompt",
        "message",
        "refresh_token",
        "access_token",
        "vault_key",
    }
)


class ZeroContentViolationError(ValueError):
    """Raised when a wake signal carries content, PII, or credential keys."""


def validate_zero_content_signal(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Validate and normalize a zero-content wake signal."""
    present_forbidden = sorted(
        key for key in payload if str(key).strip().lower() in FORBIDDEN_CONTENT_KEYS
    )
    if present_forbidden:
        raise ZeroContentViolationError(
            f"Wake signal rejected: forbidden content keys {present_forbidden}"
        )

    trigger_kind = (
        str(payload.get("trigger_kind") or payload.get("triggerKind") or "").strip().lower()
    )
    if trigger_kind.startswith("custom_"):
        trigger_kind = "mcp"
    if trigger_kind not in ALL_WAKE_TRIGGERS:
        raise ValueError(f"Unsupported wake trigger_kind: {trigger_kind!r}")

    signal_id = str(payload.get("signal_id") or payload.get("signalId") or "").strip()
    if signal_id and not _OPAQUE_ID_RE.fullmatch(signal_id):
        raise ZeroContentViolationError("signal_id must be an opaque token")

    cursor_seq = payload.get("cursor_seq", payload.get("cursorSeq"))
    if cursor_seq is not None and (
        isinstance(cursor_seq, bool) or not isinstance(cursor_seq, int) or cursor_seq < 0
    ):
        raise ValueError("cursor_seq must be a non-negative integer")

    quiet_hours = bool(
        payload.get("quiet_hours_active") or payload.get("quietHoursActive") or False
    )
    return {
        "trigger_kind": trigger_kind,
        "signal_id": signal_id,
        "cursor_seq": cursor_seq,
        "quiet_hours_active": quiet_hours,
    }


def _trigger_to_surface(trigger_kind: str) -> str:
    if trigger_kind in {"gmail", "calendar", "drive", "contacts", "mcp"}:
        return trigger_kind
    if trigger_kind == "circle_request":
        return "information_exchange_and_browser"
    return "gmail"


def _utc_day(now_s: float) -> str:
    return datetime.fromtimestamp(now_s, tz=timezone.utc).strftime("%Y-%m-%d")


@dataclass
class _PendingOwnerWake:
    owner_user_id: str
    triggers: list[str] = field(default_factory=list)
    surfaces: list[str] = field(default_factory=list)
    coalesced_count: int = 0
    first_enqueued_at: float = 0.0
    due_at: float = 0.0
    seen_signal_ids: set[str] = field(default_factory=set)
    quiet_deferred: bool = False


PodTickDispatcher = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


async def dispatch_authenticated_pod_tick(
    owner_user_id: str,
    wake_body: dict[str, Any],
    *,
    registry: Any = None,
    http_post: Callable[..., Any] | None = None,
    token_mint: Callable[[str], str | None] | None = None,
    vm_waker: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    """Resolve ``ace``, ``user_gcp``, or ``user_azure`` host and POST ``/pod/tick``."""
    from api.routes.one.pod_relay import _identity_token, _pod_url
    from hushh_mcp.services.personal_agent_registry_repo import (
        PersonalAgentRegistryRepo,
        registry_host_snapshot,
    )

    repo = registry if registry is not None else PersonalAgentRegistryRepo()
    row = registry_host_snapshot(await repo.get(owner_user_id)) or {}
    target = str(row.get("deployment_target") or "").strip() or "unknown"
    raw_meta = row.get("backend_metadata")
    metadata: dict[str, Any] = dict(raw_meta) if isinstance(raw_meta, Mapping) else {}

    if metadata.get("hostKind") == "azure_vm":
        if vm_waker is not None:
            vm_state = await vm_waker(owner_user_id, metadata)
        else:
            from api.routes.one.pod_wake import _wake_vm  # noqa: PLC0415

            vm_state = await _wake_vm(owner_user_id, metadata)
        url = _pod_url(row)
        if not url or vm_state.get("state") != "awake":
            return {
                "dispatched": True,
                "hostingTarget": target,
                "hostKind": "azure_vm",
                "podStatus": 202,
                "state": vm_state.get("state", "waking"),
            }
    else:
        url = _pod_url(row)

    if not url:
        return {"dispatched": False, "reason": "NO_HOST", "hostingTarget": target}

    is_local_loopback = os.environ.get("ENVIRONMENT", "").strip().lower() in {
        "local",
        "development",
    } and url.startswith(("http://127.0.0.1:", "http://localhost:"))

    mint = token_mint if token_mint is not None else _identity_token
    token = None if is_local_loopback else await run_in_threadpool(mint, url)
    if not token and not is_local_loopback:
        return {"dispatched": False, "reason": "IDENTITY_UNAVAILABLE", "hostingTarget": target}

    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    if http_post is None:
        import requests  # type: ignore[import-untyped]  # noqa: PLC0415

        post_fn = requests.post
    else:
        post_fn = http_post

    try:
        response = await run_in_threadpool(
            lambda: post_fn(
                f"{url}/pod/tick",
                json=wake_body,
                headers=headers,
                timeout=25.0,
                allow_redirects=False,
            )
        )
    except Exception as exc:  # noqa: BLE001 - unreachable pod stays safely queued/reported
        logger.info("pod_wake_coalescer.unreachable err=%s", type(exc).__name__)
        return {"dispatched": False, "reason": "POD_UNREACHABLE", "hostingTarget": target}

    status_code = int(getattr(response, "status_code", 502) or 502)
    if 300 <= status_code < 400:
        return {"dispatched": False, "reason": "REDIRECT_REFUSED", "hostingTarget": target}
    try:
        resp_body = response.json()
    except Exception:  # noqa: BLE001
        resp_body = {}
    bg_status = (
        resp_body.get("backgroundPrep", {}).get("status")
        if isinstance(resp_body, dict) and isinstance(resp_body.get("backgroundPrep"), dict)
        else None
    )
    return {
        "dispatched": status_code in {200, 202, 503},
        "podStatus": status_code,
        "hostingTarget": target,
        "backgroundStatus": bg_status or ("waking" if status_code == 503 else "ok"),
    }


class ZeroContentWakeCoalescer:
    """In-memory zero-content wake coalescer with fast-path and 15m batching."""

    def __init__(
        self,
        *,
        dispatcher: PodTickDispatcher = dispatch_authenticated_pod_tick,
        clock: Callable[[], float] = time.time,
        batch_debounce_seconds: float = BATCH_DEBOUNCE_SECONDS,
        daily_wake_cap: int = DEFAULT_DAILY_WAKE_CAP,
    ) -> None:
        self._dispatcher = dispatcher
        self._clock = clock
        self._debounce_s = float(batch_debounce_seconds)
        self._daily_cap = int(daily_wake_cap)
        self._lock = asyncio.Lock()
        self._pending: dict[str, _PendingOwnerWake] = {}
        self._daily_counts: dict[tuple[str, str], int] = {}

    def pending_owner_count(self) -> int:
        return len(self._pending)

    def daily_dispatches(self, owner_user_id: str, *, now_s: float | None = None) -> int:
        ts = self._clock() if now_s is None else now_s
        return self._daily_counts.get((owner_user_id, _utc_day(ts)), 0)

    async def ingest_signal(
        self,
        *,
        owner_user_id: str,
        signal: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Validate zero-content signal; wake immediately on fast path or coalesce 15m."""
        clean_owner = str(owner_user_id or "").strip()
        if not clean_owner:
            raise ValueError("owner_user_id is required")

        validated = validate_zero_content_signal(signal)
        trigger_kind = validated["trigger_kind"]
        signal_id = validated["signal_id"]
        quiet_hours = validated["quiet_hours_active"]
        is_fast = trigger_kind in FAST_WAKE_TRIGGERS

        async with self._lock:
            now_s = float(self._clock())
            day_key = _utc_day(now_s)
            used = self._daily_counts.get((clean_owner, day_key), 0)
            if used >= self._daily_cap:
                return {
                    "outcome": "throttled_daily_cap",
                    "priority": "fast" if is_fast else "batch",
                    "dailyCap": self._daily_cap,
                    "usedToday": used,
                }

            entry = self._pending.get(clean_owner)
            if entry is not None and signal_id and signal_id in entry.seen_signal_ids:
                return {
                    "outcome": "deduplicated",
                    "priority": "fast" if is_fast else "batch",
                    "coalescedCount": entry.coalesced_count,
                    "dueInSeconds": max(0, int(entry.due_at - now_s)),
                }

            if entry is None:
                entry = _PendingOwnerWake(
                    owner_user_id=clean_owner,
                    first_enqueued_at=now_s,
                    due_at=now_s if is_fast else (now_s + self._debounce_s),
                )
                self._pending[clean_owner] = entry

            if signal_id:
                entry.seen_signal_ids.add(signal_id)
            if trigger_kind not in entry.triggers:
                entry.triggers.append(trigger_kind)
            surface = _trigger_to_surface(trigger_kind)
            if surface not in entry.surfaces:
                entry.surfaces.append(surface)
            entry.coalesced_count += 1

            if not is_fast:
                entry.quiet_deferred = quiet_hours
                return {
                    "outcome": "deferred_quiet_hours" if quiet_hours else "coalesced",
                    "priority": "batch",
                    "coalescedCount": entry.coalesced_count,
                    "dueInSeconds": int(self._debounce_s),
                }

            # Fast-path trigger pops and sweeps all coalesced signals in ONE wake!
            popped = self._pending.pop(clean_owner)
            self._daily_counts[(clean_owner, day_key)] = used + 1

        wake_body = {
            "wakePriority": "fast",
            "coalescedCount": popped.coalesced_count,
            "triggers": list(popped.triggers),
            "signals": [{"surface": s} for s in popped.surfaces],
        }
        delivery = await self._dispatcher(clean_owner, wake_body)
        if delivery.get("backgroundStatus") == "locked_down":
            return {
                "outcome": "locked_down",
                "priority": "fast",
                "coalescedCount": popped.coalesced_count,
                "hostingTarget": delivery.get("hostingTarget"),
            }
        return {
            "outcome": "dispatched" if delivery.get("dispatched") else "dispatch_deferred",
            "priority": "fast",
            "coalescedCount": popped.coalesced_count,
            "hostingTarget": delivery.get("hostingTarget"),
            "backgroundStatus": delivery.get("backgroundStatus"),
        }

    async def drain_due(
        self, *, quiet_hours_lifted: bool = True, limit: int = 50
    ) -> dict[str, int]:
        """Flush batched owner wakes whose 15-minute debounce window has elapsed."""
        to_dispatch: list[tuple[str, _PendingOwnerWake]] = []
        throttled = 0
        deferred_quiet = 0

        async with self._lock:
            now_s = float(self._clock())
            day_key = _utc_day(now_s)
            for owner_id, entry in list(self._pending.items()):
                if len(to_dispatch) >= limit:
                    break
                if entry.quiet_deferred and not quiet_hours_lifted:
                    deferred_quiet += 1
                    continue
                if entry.due_at > now_s:
                    continue
                self._pending.pop(owner_id, None)
                used = self._daily_counts.get((owner_id, day_key), 0)
                if used >= self._daily_cap:
                    throttled += 1
                    continue
                self._daily_counts[(owner_id, day_key)] = used + 1
                to_dispatch.append((owner_id, entry))

        dispatched = 0
        locked_down = 0
        failed = 0
        for owner_id, entry in to_dispatch:
            wake_body = {
                "wakePriority": "batch",
                "coalescedCount": entry.coalesced_count,
                "triggers": list(entry.triggers),
                "signals": [{"surface": s} for s in entry.surfaces],
            }
            result = await self._dispatcher(owner_id, wake_body)
            if result.get("backgroundStatus") == "locked_down":
                locked_down += 1
            elif result.get("dispatched"):
                dispatched += 1
            else:
                failed += 1

        return {
            "dispatched": dispatched,
            "lockedDown": locked_down,
            "throttled": throttled,
            "deferredQuietHours": deferred_quiet,
            "failed": failed,
        }


WAKE_COALESCER = ZeroContentWakeCoalescer()

__all__ = [
    "ALL_WAKE_TRIGGERS",
    "BATCH_DEBOUNCE_SECONDS",
    "BATCH_WAKE_TRIGGERS",
    "DEFAULT_DAILY_WAKE_CAP",
    "FAST_WAKE_TRIGGERS",
    "FORBIDDEN_CONTENT_KEYS",
    "WAKE_COALESCER",
    "ZeroContentViolationError",
    "ZeroContentWakeCoalescer",
    "dispatch_authenticated_pod_tick",
    "validate_zero_content_signal",
]

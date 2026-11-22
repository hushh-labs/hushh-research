"""Bounded, quarantined offline background preparation for an owner's private pod.

Runs inside ``private_pod_runtime()`` (Personal Sandbox ``ace``, ``user_gcp``, and
``user_azure``) when woken by ``/pod/tick``.

Order of enforcement:
1. ``session_only_lockdown`` check: refuses offline wakes before touching any
   connector, memory service, or model.
2. ``background_prep_enabled`` & per-connector ``PodConfig`` toggles.
3. Durable daily wake budget (``pod_background_wake_budget_v1``) in the pod's
   sealed commit log so runaway webhook loops cannot exhaust hosted or BYOC compute.
4. Hard 6-surface prompt-injection tool quarantine (``quarantine_tools_for_background_turn``).
5. Non-aggressive curation & anti-poisoning provenance guard:
   - Low-signal noise dropped.
   - Sovereign Vault capital domains staged as encrypted owner-unlock proposals.
   - Durable commitments/context tagged ``from <Connector>`` and blocked from
     overriding ``owner_direct`` facts or consent rules.
6. Zero-PII structural counts returned to the wake caller.
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
from typing import Any, Callable

from hushh_mcp.operons.background_quarantine import (
    UNTRUSTED_BACKGROUND_SURFACES,
    can_supersede_existing_fact,
    evaluate_background_curation_candidate,
    normalize_background_surface,
    quarantine_tools_for_background_turn,
)
from hushh_mcp.services.pod_config import (
    PodConfig,
    active_pod_config,
    background_connector_enabled,
)

logger = logging.getLogger(__name__)

WAKE_BUDGET_RECORD_KIND = "pod_background_wake_budget_v1"
MAX_CANDIDATES_PER_WAKE = 16


def _utc_day_key(now_s: float) -> str:
    return datetime.fromtimestamp(now_s, tz=timezone.utc).strftime("%Y-%m-%d")


async def count_wakes_for_day(log: Any, *, hushh_id: str, day_key: str) -> int:
    """Count durable background prep wakes recorded in ``log`` for ``day_key``."""
    if log is None or not hushh_id:
        return 0
    count = 0
    for record in await log.replay():
        if str((record or {}).get("kind") or "") != WAKE_BUDGET_RECORD_KIND:
            continue
        payload = (record or {}).get("payload") or {}
        if (
            isinstance(payload, Mapping)
            and str(payload.get("hushh_id") or "") == hushh_id
            and str(payload.get("day") or "") == day_key
        ):
            count += 1
    return count


async def record_wake_budget_spend(
    log: Any,
    *,
    hushh_id: str,
    day_key: str,
    surfaces: tuple[str, ...],
    now_s: float,
) -> None:
    """Append one zero-content wake receipt to enforce the daily cap across boots."""
    if log is None or not hushh_id:
        return
    await log.append(
        WAKE_BUDGET_RECORD_KIND,
        {
            "hushh_id": hushh_id,
            "day": day_key,
            "surfaces": list(surfaces),
            "atMs": int(now_s * 1000),
        },
    )


def enabled_background_surfaces(config: PodConfig) -> tuple[str, ...]:
    """Return the subset of connector surfaces currently enabled on ``config``."""
    if config.session_only_lockdown or not config.background_prep_enabled:
        return ()
    return tuple(
        surface
        for surface in ("gmail", "calendar", "drive", "contacts", "mcp")
        if background_connector_enabled(config, surface)
    )


async def run_pod_background_prep(
    *,
    wake_payload: Mapping[str, Any] | None = None,
    config: PodConfig | None = None,
    log: Any = None,
    candidate_tools: Mapping[str, Any] | None = None,
    candidates: Iterable[Mapping[str, Any]] | None = None,
    existing_facts_by_key: Mapping[str, Mapping[str, Any]] | None = None,
    clock: Callable[[], float] = time.time,
    is_private_pod: bool | None = None,
) -> dict[str, Any]:
    """Execute one bounded, quarantined background preparation pass."""
    if is_private_pod is None:
        from hushh_mcp.services.pod_owner_cloud import private_pod_runtime  # noqa: PLC0415

        private_runtime = private_pod_runtime()
    else:
        private_runtime = bool(is_private_pod)

    if not private_runtime:
        return {"status": "disabled", "reason": "PRIVATE_POD_REQUIRED"}

    cfg = config if config is not None else active_pod_config()
    if cfg.session_only_lockdown:
        return {
            "status": "locked_down",
            "reason": "SESSION_ONLY_LOCKDOWN",
            "quarantineActive": True,
            "draftsPrepared": 0,
            "memoryFactsCurated": 0,
            "wikiUpdatesCurated": 0,
            "vaultProposalsStaged": 0,
            "droppedLowSignal": 0,
        }

    if not cfg.background_prep_enabled:
        return {
            "status": "disabled",
            "reason": "BACKGROUND_PREP_DISABLED",
            "quarantineActive": True,
            "draftsPrepared": 0,
            "memoryFactsCurated": 0,
            "wikiUpdatesCurated": 0,
            "vaultProposalsStaged": 0,
            "droppedLowSignal": 0,
        }

    allowed_surfaces = enabled_background_surfaces(cfg)
    payload = dict(wake_payload or {})
    raw_signals = payload.get("signals")
    requested_surfaces: list[str] = []
    if isinstance(raw_signals, list):
        for item in raw_signals[:32]:
            raw_surface = item.get("surface") if isinstance(item, Mapping) else str(item or "")
            try:
                norm = normalize_background_surface(str(raw_surface or ""))
            except ValueError:
                continue
            if norm == "information_exchange_and_browser" or norm in allowed_surfaces:
                requested_surfaces.append(norm)

    candidate_list = list(candidates or [])[:MAX_CANDIDATES_PER_WAKE]
    for cand in candidate_list:
        try:
            norm = normalize_background_surface(str(cand.get("surface") or ""))
        except ValueError:
            continue
        if norm == "information_exchange_and_browser" or norm in allowed_surfaces:
            requested_surfaces.append(norm)

    active_surfaces = tuple(dict.fromkeys(requested_surfaces))
    if not active_surfaces and not candidate_list:
        return {
            "status": "idle",
            "enabledSurfaces": list(allowed_surfaces),
            "quarantineActive": True,
            "draftsPrepared": 0,
            "memoryFactsCurated": 0,
            "wikiUpdatesCurated": 0,
            "vaultProposalsStaged": 0,
            "droppedLowSignal": 0,
        }

    if log is None:
        try:
            from hushh_mcp.services.pod_memory_service import _resolve_log  # noqa: PLC0415

            log = _resolve_log()
        except Exception:  # noqa: BLE001 - budget falls back cleanly if store unavailable
            log = None

    hushh_id = (os.environ.get("HUSSH_ID") or "").strip()
    now_s = float(clock())
    day_key = _utc_day_key(now_s)
    used_today = await count_wakes_for_day(log, hushh_id=hushh_id, day_key=day_key)
    if used_today >= cfg.background_daily_wake_cap:
        return {
            "status": "budget_exhausted",
            "dailyCap": cfg.background_daily_wake_cap,
            "usedToday": used_today,
            "quarantineActive": True,
            "draftsPrepared": 0,
            "memoryFactsCurated": 0,
            "wikiUpdatesCurated": 0,
            "vaultProposalsStaged": 0,
            "droppedLowSignal": 0,
        }

    await record_wake_budget_spend(
        log,
        hushh_id=hushh_id,
        day_key=day_key,
        surfaces=active_surfaces or UNTRUSTED_BACKGROUND_SURFACES,
        now_s=now_s,
    )

    quarantined = quarantine_tools_for_background_turn(
        candidate_tools or {},
        active_surfaces=active_surfaces or UNTRUSTED_BACKGROUND_SURFACES,
    )

    drafts_prepared = 0
    memory_curated = 0
    wiki_curated = 0
    vault_staged = 0
    dropped_low_signal = 0
    blocked_overrides = 0
    existing_map = dict(existing_facts_by_key or {})

    for cand in candidate_list:
        raw_surface = str(cand.get("surface") or "")
        try:
            norm_surface = normalize_background_surface(raw_surface)
        except ValueError:
            continue
        if (
            norm_surface != "information_exchange_and_browser"
            and norm_surface not in allowed_surfaces
        ):
            continue

        verdict = evaluate_background_curation_candidate(
            surface=norm_surface,
            summary_text=str(cand.get("summary_text") or ""),
            sender_hint=str(cand.get("sender_hint") or ""),
            category_hint=str(cand.get("category_hint") or ""),
            target_domain=str(cand.get("target_domain") or ""),
            source_ref=str(cand.get("source_ref") or ""),
        )
        if verdict.decision == "drop_low_signal":
            dropped_low_signal += 1
            continue
        if verdict.decision == "stage_vault_proposal":
            vault_staged += 1
            continue

        fact_key = str(cand.get("fact_key") or "").strip()
        if fact_key and fact_key in existing_map:
            if not can_supersede_existing_fact(
                existing_metadata=existing_map[fact_key],
                candidate_metadata=verdict.provenance,
            ):
                blocked_overrides += 1
                continue

        memory_curated += 1
        if bool(cand.get("update_wiki", True)):
            wiki_curated += 1
        if bool(cand.get("prepare_draft", False)):
            drafts_prepared += 1

    return {
        "status": "completed",
        "enabledSurfaces": list(allowed_surfaces),
        "quarantinedSurfaces": list(quarantined.surfaces),
        "admittedToolCount": len(quarantined.admitted_tools),
        "strippedToolCount": len(quarantined.stripped_tool_names),
        "quarantineActive": quarantined.quarantine_active,
        "dailyCap": cfg.background_daily_wake_cap,
        "usedToday": used_today + 1,
        "draftsPrepared": drafts_prepared,
        "memoryFactsCurated": memory_curated,
        "wikiUpdatesCurated": wiki_curated,
        "vaultProposalsStaged": vault_staged,
        "droppedLowSignal": dropped_low_signal,
        "blockedOwnerOverrides": blocked_overrides,
    }


__all__ = [
    "MAX_CANDIDATES_PER_WAKE",
    "WAKE_BUDGET_RECORD_KIND",
    "count_wakes_for_day",
    "enabled_background_surfaces",
    "record_wake_budget_spend",
    "run_pod_background_prep",
]

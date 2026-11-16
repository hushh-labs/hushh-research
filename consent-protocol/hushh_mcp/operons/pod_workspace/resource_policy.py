# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Pure resource-pressure policy over cgroup-v2, `/dev/shm`, and workspace scratch (#9511).

Prevents silent OOM (`SIGKILL` / `137`) crashes during CLI/package tasks by staging:
- `< 70%`: `normal` admission
- `70%..85%`: `warn` (`RESOURCE_PRESSURE_WARN`, surfaces low-memory execution hints)
- `85%..92%`: `soft_backpressure` (triggers disposable cache eviction + pre-OOM checkpoint)
- `>= 92%` or `oom_kill` delta > 0: `exceeded` (`RESOURCE_BUDGET_EXCEEDED` with recovery hint)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from hushh_mcp.services.pod_resource_snapshot import ResourceSnapshot

PressureLevel = Literal["normal", "warn", "soft_backpressure", "exceeded"]

RESOURCE_PRESSURE_WARN = "RESOURCE_PRESSURE_WARN"
RESOURCE_BUDGET_EXCEEDED = "RESOURCE_BUDGET_EXCEEDED"

DEFAULT_MAX_WORKSPACE_BYTES = 512 * 1024 * 1024  # 512 MiB
DEFAULT_FALLBACK_MEMORY_BUDGET_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB economy baseline


@dataclass(frozen=True)
class ResourceBudgetPolicy:
    max_workspace_bytes: int = DEFAULT_MAX_WORKSPACE_BYTES
    fallback_memory_budget_bytes: int = DEFAULT_FALLBACK_MEMORY_BUDGET_BYTES
    warn_ratio: float = 0.70
    soft_backpressure_ratio: float = 0.85
    hard_exceeded_ratio: float = 0.92
    max_workspace_share_of_cgroup: float = 0.35


@dataclass(frozen=True)
class ResourcePressureVerdict:
    level: PressureLevel
    admitted: bool
    code: str | None
    peak_ratio: float
    memory_ratio: float
    shm_ratio: float
    workspace_ratio: float
    effective_workspace_cap_bytes: int
    oom_kill_delta: int
    cpu_throttled_periods_delta: int
    should_evict_caches: bool
    should_checkpoint_workspace: bool
    retry_guidance: str | None


def evaluate_resource_pressure(
    snapshot: ResourceSnapshot,
    *,
    workspace_used_bytes: int,
    baseline_oom_kills: int = 0,
    baseline_throttled_periods: int = 0,
    policy: ResourceBudgetPolicy = ResourceBudgetPolicy(),
) -> ResourcePressureVerdict:
    """Compute unified memory/tmpfs/workspace pressure without I/O side effects."""
    mem = snapshot.get("memory") or {}
    limit_bytes = mem.get("limitBytes")
    current_bytes = mem.get("currentBytes")
    events = mem.get("events") or {}
    cpu = snapshot.get("cpu") or {}
    shm = snapshot.get("sharedMemory")

    effective_mem_limit = (
        int(limit_bytes)
        if isinstance(limit_bytes, int) and limit_bytes > 0
        else policy.fallback_memory_budget_bytes
    )
    # On Linux containers, /dev/shm tmpfs consumes cgroup memory; bound scratch to <= 35% of RAM.
    cgroup_ws_cap = int(effective_mem_limit * policy.max_workspace_share_of_cgroup)
    effective_ws_cap = max(1, min(policy.max_workspace_bytes, cgroup_ws_cap))
    if shm is not None and isinstance(shm.get("capacityBytes"), int) and shm["capacityBytes"] > 0:
        effective_ws_cap = max(1, min(effective_ws_cap, int(shm["capacityBytes"] * 0.50)))

    memory_ratio = (
        float(current_bytes) / float(effective_mem_limit)
        if isinstance(current_bytes, int) and current_bytes >= 0
        else 0.0
    )
    shm_ratio = (
        float(shm["usedBytes"]) / float(shm["capacityBytes"])
        if shm is not None
        and isinstance(shm.get("usedBytes"), int)
        and isinstance(shm.get("capacityBytes"), int)
        and shm["capacityBytes"] > 0
        else 0.0
    )
    workspace_ratio = max(0.0, float(workspace_used_bytes)) / float(effective_ws_cap)
    peak_ratio = max(memory_ratio, shm_ratio, workspace_ratio)

    current_oom_kills = int(events.get("oom_kill", 0))
    oom_kill_delta = max(0, current_oom_kills - max(0, int(baseline_oom_kills)))
    current_throttled = int(cpu.get("nr_throttled", 0))
    throttled_delta = max(0, current_throttled - max(0, int(baseline_throttled_periods)))

    if oom_kill_delta > 0 or peak_ratio >= policy.hard_exceeded_ratio:
        return ResourcePressureVerdict(
            level="exceeded",
            admitted=False,
            code=RESOURCE_BUDGET_EXCEEDED,
            peak_ratio=round(peak_ratio, 4),
            memory_ratio=round(memory_ratio, 4),
            shm_ratio=round(shm_ratio, 4),
            workspace_ratio=round(workspace_ratio, 4),
            effective_workspace_cap_bytes=effective_ws_cap,
            oom_kill_delta=oom_kill_delta,
            cpu_throttled_periods_delta=throttled_delta,
            should_evict_caches=True,
            should_checkpoint_workspace=True,
            retry_guidance=(
                "Workspace state was checkpointed before hard memory exhaustion. "
                "Re-run with single-worker or no-cache flags (e.g. --jobs 1, --no-cache-dir) "
                "or split large inputs into smaller chunks."
            ),
        )

    if peak_ratio >= policy.soft_backpressure_ratio:
        return ResourcePressureVerdict(
            level="soft_backpressure",
            admitted=False,
            code=RESOURCE_BUDGET_EXCEEDED,
            peak_ratio=round(peak_ratio, 4),
            memory_ratio=round(memory_ratio, 4),
            shm_ratio=round(shm_ratio, 4),
            workspace_ratio=round(workspace_ratio, 4),
            effective_workspace_cap_bytes=effective_ws_cap,
            oom_kill_delta=0,
            cpu_throttled_periods_delta=throttled_delta,
            should_evict_caches=True,
            should_checkpoint_workspace=True,
            retry_guidance=(
                "High memory/scratch watermark reached (>=85%). Disposable caches were evicted "
                "and workspace state was checkpointed; retry with bounded concurrency."
            ),
        )

    if peak_ratio >= policy.warn_ratio:
        return ResourcePressureVerdict(
            level="warn",
            admitted=True,
            code=RESOURCE_PRESSURE_WARN,
            peak_ratio=round(peak_ratio, 4),
            memory_ratio=round(memory_ratio, 4),
            shm_ratio=round(shm_ratio, 4),
            workspace_ratio=round(workspace_ratio, 4),
            effective_workspace_cap_bytes=effective_ws_cap,
            oom_kill_delta=0,
            cpu_throttled_periods_delta=throttled_delta,
            should_evict_caches=False,
            should_checkpoint_workspace=False,
            retry_guidance="Approaching memory watermark (>=70%); prefer streaming and --no-cache flags.",
        )

    return ResourcePressureVerdict(
        level="normal",
        admitted=True,
        code=None,
        peak_ratio=round(peak_ratio, 4),
        memory_ratio=round(memory_ratio, 4),
        shm_ratio=round(shm_ratio, 4),
        workspace_ratio=round(workspace_ratio, 4),
        effective_workspace_cap_bytes=effective_ws_cap,
        oom_kill_delta=0,
        cpu_throttled_periods_delta=throttled_delta,
        should_evict_caches=False,
        should_checkpoint_workspace=False,
        retry_guidance=None,
    )

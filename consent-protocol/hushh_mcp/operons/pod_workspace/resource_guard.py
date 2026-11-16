# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Proactive resource-monitoring CLI supervisor with pre-OOM checkpointing (#9511)."""

from __future__ import annotations

import asyncio
import contextlib
import os
import shutil
import signal
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from hushh_mcp.operons.pod_workspace.command_policy import (
    CliBoundaryMode,
    build_scrubbed_worker_env,
    classify_cli_command,
)
from hushh_mcp.operons.pod_workspace.resource_policy import (
    RESOURCE_BUDGET_EXCEEDED,
    ResourceBudgetPolicy,
    ResourcePressureVerdict,
    evaluate_resource_pressure,
)
from hushh_mcp.operons.pod_workspace.ring_buffer import (
    DEFAULT_STREAM_RING_BYTES,
    BoundedStreamRingBuffer,
)
from hushh_mcp.services.pod_resource_snapshot import ResourceSnapshot, resource_snapshot

ExecutionStatus = Literal[
    "completed",
    "failed",
    "refused",
    "resource_exceeded",
    "timed_out",
]

CLI_COMMAND_TIMED_OUT = "CLI_COMMAND_TIMED_OUT"
DISPOSABLE_CACHE_DIRS = (".cache", ".npm", ".pip", "__pycache__", ".pytest_cache", ".ruff_cache")


def directory_used_bytes(root: Path) -> int:
    total = 0
    if not root.exists():
        return 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        # Prevent walking symlinked directories
        dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(dirpath, d))]
        for fname in filenames:
            fpath = os.path.join(dirpath, fname)
            if os.path.islink(fpath):
                continue
            with contextlib.suppress(OSError):
                total += os.path.getsize(fpath)
    return total


def evict_disposable_scratch_caches(workspace_dir: Path, scratch_tmp_dir: Path) -> int:
    """Evict ephemeral package/temp caches under memory backpressure without deleting source files."""
    reclaimed = 0
    if scratch_tmp_dir.exists():
        reclaimed += directory_used_bytes(scratch_tmp_dir)
        for child in scratch_tmp_dir.iterdir():
            with contextlib.suppress(OSError):
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child, ignore_errors=True)
                else:
                    child.unlink(missing_ok=True)
    for rel in DISPOSABLE_CACHE_DIRS:
        target = workspace_dir / rel
        if target.exists() and not target.is_symlink():
            reclaimed += directory_used_bytes(target)
            shutil.rmtree(target, ignore_errors=True)
    return reclaimed


async def _terminate_process_group(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    pid = proc.pid
    with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
        os.killpg(pid, signal.SIGTERM)
    try:
        await asyncio.wait_for(proc.wait(), timeout=0.5)
        return
    except TimeoutError:
        pass
    with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
        os.killpg(pid, signal.SIGKILL)
    with contextlib.suppress(Exception):
        await asyncio.wait_for(proc.wait(), timeout=1.0)


@dataclass(frozen=True)
class CliExecutionReceipt:
    status: ExecutionStatus
    code: str | None
    exit_code: int | None
    stdout_tail: str
    stderr_tail: str
    stdout_truncated_bytes: int
    stderr_truncated_bytes: int
    duration_ms: int
    pressure_level: str
    peak_ratio: float
    workspace_used_bytes: int
    caches_evicted_bytes: int
    checkpoint_revision: int | None
    retry_guidance: str | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "code": self.code,
            "exit_code": self.exit_code,
            "stdout_tail": self.stdout_tail,
            "stderr_tail": self.stderr_tail,
            "stdout_truncated_bytes": self.stdout_truncated_bytes,
            "stderr_truncated_bytes": self.stderr_truncated_bytes,
            "duration_ms": self.duration_ms,
            "pressure_level": self.pressure_level,
            "peak_ratio": self.peak_ratio,
            "workspace_used_bytes": self.workspace_used_bytes,
            "caches_evicted_bytes": self.caches_evicted_bytes,
            "checkpoint_revision": self.checkpoint_revision,
            "retry_guidance": self.retry_guidance,
        }


class WorkspaceResourceGuard:
    """Runs workspace commands under continuous resource telemetry & pre-OOM recovery."""

    def __init__(
        self,
        *,
        policy: ResourceBudgetPolicy = ResourceBudgetPolicy(),
        snapshot_fn: Callable[[], ResourceSnapshot] = resource_snapshot,
        poll_interval_seconds: float = 0.08,
        stream_ring_bytes: int = DEFAULT_STREAM_RING_BYTES,
    ) -> None:
        self.policy = policy
        self.snapshot_fn = snapshot_fn
        self.poll_interval_seconds = max(0.02, float(poll_interval_seconds))
        self.stream_ring_bytes = stream_ring_bytes

    def current_verdict(
        self,
        *,
        workspace_dir: Path,
        scratch_tmp_dir: Path | None = None,
        baseline_oom_kills: int = 0,
        baseline_throttled_periods: int = 0,
    ) -> tuple[ResourcePressureVerdict, int]:
        used = directory_used_bytes(workspace_dir)
        if scratch_tmp_dir is not None and scratch_tmp_dir.exists():
            used += directory_used_bytes(scratch_tmp_dir)
        snap = self.snapshot_fn()
        verdict = evaluate_resource_pressure(
            snap,
            workspace_used_bytes=used,
            baseline_oom_kills=baseline_oom_kills,
            baseline_throttled_periods=baseline_throttled_periods,
            policy=self.policy,
        )
        return verdict, used

    async def execute_command(
        self,
        argv: list[str],
        *,
        workspace_dir: Path,
        scratch_tmp_dir: Path,
        boundary_mode: CliBoundaryMode,
        credential_approval_verified: bool = False,
        timeout_seconds: float = 60.0,
        checkpoint_fn: Callable[[str], Awaitable[int | None]] | None = None,
        extra_public_env: dict[str, str] | None = None,
    ) -> CliExecutionReceipt:
        started_ns = time.monotonic_ns()
        admission = classify_cli_command(
            argv,
            boundary_mode=boundary_mode,
            credential_approval_verified=credential_approval_verified,
        )
        if not admission.admitted:
            verdict, used = self.current_verdict(
                workspace_dir=workspace_dir, scratch_tmp_dir=scratch_tmp_dir
            )
            return CliExecutionReceipt(
                status="refused",
                code=admission.code,
                exit_code=None,
                stdout_tail="",
                stderr_tail=admission.reason or "",
                stdout_truncated_bytes=0,
                stderr_truncated_bytes=0,
                duration_ms=int((time.monotonic_ns() - started_ns) / 1_000_000),
                pressure_level=verdict.level,
                peak_ratio=verdict.peak_ratio,
                workspace_used_bytes=used,
                caches_evicted_bytes=0,
                checkpoint_revision=None,
                retry_guidance=None,
            )

        base_snap = self.snapshot_fn()
        base_events = (base_snap.get("memory") or {}).get("events") or {}
        base_cpu = base_snap.get("cpu") or {}
        base_oom = int(base_events.get("oom_kill", 0))
        base_throttled = int(base_cpu.get("nr_throttled", 0))

        evicted_bytes = 0
        checkpoint_rev: int | None = None
        verdict, used = self.current_verdict(
            workspace_dir=workspace_dir,
            scratch_tmp_dir=scratch_tmp_dir,
            baseline_oom_kills=base_oom,
            baseline_throttled_periods=base_throttled,
        )

        # Pre-admission soft-backpressure recovery: evict caches + checkpoint before deciding
        if verdict.should_evict_caches:
            evicted_bytes += evict_disposable_scratch_caches(workspace_dir, scratch_tmp_dir)
            if checkpoint_fn is not None and verdict.should_checkpoint_workspace:
                checkpoint_rev = await checkpoint_fn("pre_admission_backpressure")
            verdict, used = self.current_verdict(
                workspace_dir=workspace_dir,
                scratch_tmp_dir=scratch_tmp_dir,
                baseline_oom_kills=base_oom,
                baseline_throttled_periods=base_throttled,
            )

        if not verdict.admitted:
            return CliExecutionReceipt(
                status="resource_exceeded",
                code=verdict.code or RESOURCE_BUDGET_EXCEEDED,
                exit_code=None,
                stdout_tail="",
                stderr_tail="",
                stdout_truncated_bytes=0,
                stderr_truncated_bytes=0,
                duration_ms=int((time.monotonic_ns() - started_ns) / 1_000_000),
                pressure_level=verdict.level,
                peak_ratio=verdict.peak_ratio,
                workspace_used_bytes=used,
                caches_evicted_bytes=evicted_bytes,
                checkpoint_revision=checkpoint_rev,
                retry_guidance=verdict.retry_guidance,
            )

        scratch_tmp_dir.mkdir(parents=True, exist_ok=True)
        env = build_scrubbed_worker_env(
            workspace_dir=workspace_dir,
            scratch_tmp_dir=scratch_tmp_dir,
            extra_public_env=extra_public_env,
        )

        stdout_ring = BoundedStreamRingBuffer(max_bytes=self.stream_ring_bytes)
        stderr_ring = BoundedStreamRingBuffer(max_bytes=self.stream_ring_bytes)

        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                cwd=str(workspace_dir),
                env=env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
        except OSError as exc:
            return CliExecutionReceipt(
                status="failed",
                code="CLI_EXEC_FAILED",
                exit_code=None,
                stdout_tail="",
                stderr_tail=str(exc),
                stdout_truncated_bytes=0,
                stderr_truncated_bytes=0,
                duration_ms=int((time.monotonic_ns() - started_ns) / 1_000_000),
                pressure_level=verdict.level,
                peak_ratio=verdict.peak_ratio,
                workspace_used_bytes=used,
                caches_evicted_bytes=evicted_bytes,
                checkpoint_revision=checkpoint_rev,
                retry_guidance=None,
            )

        async def _drain(
            stream: asyncio.StreamReader | None, ring: BoundedStreamRingBuffer
        ) -> None:
            if stream is None:
                return
            while True:
                chunk = await stream.read(4096)
                if not chunk:
                    break
                ring.append(chunk)

        out_task = asyncio.create_task(_drain(proc.stdout, stdout_ring))
        err_task = asyncio.create_task(_drain(proc.stderr, stderr_ring))

        peak_seen = verdict.peak_ratio
        worst_verdict = verdict
        aborted_for_resource = False
        timed_out = False
        mid_run_evicted = False
        deadline = time.monotonic() + max(0.2, float(timeout_seconds))

        try:
            while proc.returncode is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    await _terminate_process_group(proc)
                    break
                try:
                    await asyncio.wait_for(
                        proc.wait(), timeout=min(self.poll_interval_seconds, remaining)
                    )
                except TimeoutError:
                    live_verdict, used = self.current_verdict(
                        workspace_dir=workspace_dir,
                        scratch_tmp_dir=scratch_tmp_dir,
                        baseline_oom_kills=base_oom,
                        baseline_throttled_periods=base_throttled,
                    )
                    if live_verdict.peak_ratio >= peak_seen:
                        peak_seen = live_verdict.peak_ratio
                        worst_verdict = live_verdict
                    if live_verdict.level == "soft_backpressure" and not mid_run_evicted:
                        mid_run_evicted = True
                        evicted_bytes += evict_disposable_scratch_caches(
                            workspace_dir, scratch_tmp_dir
                        )
                    elif live_verdict.level == "exceeded":
                        aborted_for_resource = True
                        worst_verdict = live_verdict
                        await _terminate_process_group(proc)
                        break
        finally:
            if proc.returncode is None:
                await _terminate_process_group(proc)
            await asyncio.gather(out_task, err_task, return_exceptions=True)

        final_verdict, final_used = self.current_verdict(
            workspace_dir=workspace_dir,
            scratch_tmp_dir=scratch_tmp_dir,
            baseline_oom_kills=base_oom,
            baseline_throttled_periods=base_throttled,
        )
        peak_seen = max(peak_seen, final_verdict.peak_ratio)
        exit_code = proc.returncode

        # Detect kernel SIGKILL / 137 or OOM event delta even if it happened between polls
        if (
            aborted_for_resource
            or final_verdict.oom_kill_delta > 0
            or exit_code in {-int(signal.SIGKILL), 137}
        ):
            evicted_bytes += evict_disposable_scratch_caches(workspace_dir, scratch_tmp_dir)
            if checkpoint_fn is not None:
                checkpoint_rev = await checkpoint_fn("pre_oom_recovery")
            guidance = (
                worst_verdict.retry_guidance
                or final_verdict.retry_guidance
                or (
                    "Child command exceeded memory/scratch budget and was safely stopped; "
                    "workspace state is preserved. Retry with lower concurrency or chunked input."
                )
            )
            return CliExecutionReceipt(
                status="resource_exceeded",
                code=RESOURCE_BUDGET_EXCEEDED,
                exit_code=exit_code,
                stdout_tail=stdout_ring.utf8_tail(),
                stderr_tail=stderr_ring.utf8_tail(),
                stdout_truncated_bytes=stdout_ring.truncated_bytes,
                stderr_truncated_bytes=stderr_ring.truncated_bytes,
                duration_ms=int((time.monotonic_ns() - started_ns) / 1_000_000),
                pressure_level="exceeded",
                peak_ratio=peak_seen,
                workspace_used_bytes=final_used,
                caches_evicted_bytes=evicted_bytes,
                checkpoint_revision=checkpoint_rev,
                retry_guidance=guidance,
            )

        if timed_out:
            if checkpoint_fn is not None:
                checkpoint_rev = await checkpoint_fn("timeout_recovery")
            return CliExecutionReceipt(
                status="timed_out",
                code=CLI_COMMAND_TIMED_OUT,
                exit_code=exit_code,
                stdout_tail=stdout_ring.utf8_tail(),
                stderr_tail=stderr_ring.utf8_tail(),
                stdout_truncated_bytes=stdout_ring.truncated_bytes,
                stderr_truncated_bytes=stderr_ring.truncated_bytes,
                duration_ms=int((time.monotonic_ns() - started_ns) / 1_000_000),
                pressure_level=final_verdict.level,
                peak_ratio=peak_seen,
                workspace_used_bytes=final_used,
                caches_evicted_bytes=evicted_bytes,
                checkpoint_revision=checkpoint_rev,
                retry_guidance="Command exceeded active time limit; workspace changes were checkpointed.",
            )

        status: ExecutionStatus = "completed" if exit_code == 0 else "failed"
        if checkpoint_fn is not None and exit_code == 0:
            checkpoint_rev = await checkpoint_fn("command_completed")

        return CliExecutionReceipt(
            status=status,
            code=final_verdict.code if status == "completed" else "CLI_NONZERO_EXIT",
            exit_code=exit_code,
            stdout_tail=stdout_ring.utf8_tail(),
            stderr_tail=stderr_ring.utf8_tail(),
            stdout_truncated_bytes=stdout_ring.truncated_bytes,
            stderr_truncated_bytes=stderr_ring.truncated_bytes,
            duration_ms=int((time.monotonic_ns() - started_ns) / 1_000_000),
            pressure_level=final_verdict.level,
            peak_ratio=peak_seen,
            workspace_used_bytes=final_used,
            caches_evicted_bytes=evicted_bytes,
            checkpoint_revision=checkpoint_rev,
            retry_guidance=final_verdict.retry_guidance,
        )

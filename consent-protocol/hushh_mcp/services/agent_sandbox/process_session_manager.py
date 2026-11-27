# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Muse-style stateful process session manager (`start`, `poll`, `write`, `stop`) (#9744)."""

from __future__ import annotations

import asyncio
import contextlib
import re
import secrets
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from hushh_mcp.operons.pod_workspace.command_policy import (
    build_scrubbed_worker_env,
    classify_cli_command,
)
from hushh_mcp.operons.pod_workspace.resource_guard import (
    WorkspaceResourceGuard,
    _terminate_process_group,
)
from hushh_mcp.operons.pod_workspace.ring_buffer import (
    DEFAULT_STREAM_RING_BYTES,
    BoundedStreamRingBuffer,
)

TERMINAL_NOT_FOUND = "TERMINAL_NOT_FOUND"
TERMINAL_OWNER_TAKEOVER_ACTIVE = "TERMINAL_OWNER_TAKEOVER_ACTIVE"
SANDBOX_RAW_CREDENTIAL_FORBIDDEN = "SANDBOX_RAW_CREDENTIAL_FORBIDDEN"
_SURROGATE_RE = re.compile(r"^hsur_[a-f0-9]{48}$")
_SAFE_ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")

ProcessState = Literal["running", "completed", "failed", "stopped", "timed_out"]


class TerminalSessionRefused(RuntimeError):
    """Typed refusal raised on invalid, unauthorized, or taken-over terminal work."""

    def __init__(self, code: str, detail: str = "", *, status: int = 403) -> None:
        self.code = code
        self.status = status
        super().__init__(detail or code)


@dataclass
class _ManagedProcess:
    proc_id: str
    argv: tuple[str, ...]
    proc: asyncio.subprocess.Process
    stdout_ring: BoundedStreamRingBuffer
    stderr_ring: BoundedStreamRingBuffer
    started_at_ms: int
    timeout_seconds: float
    suppress_model_output: bool
    ended_at_ms: int | None = None
    exit_code: int | None = None
    state: ProcessState = "running"
    reader_tasks: list[asyncio.Task[None]] = field(default_factory=list)
    watchdog_task: asyncio.Task[None] | None = None


@dataclass(frozen=True)
class ProcessSessionSnapshot:
    proc_id: str
    status: ProcessState
    exit_code: int | None
    stdout: str
    stderr: str
    stdout_truncated_bytes: int
    stderr_truncated_bytes: int
    duration_ms: int
    pressure_level: str
    peak_ratio: float
    control_mode: Literal["agent", "owner"]
    control_epoch: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "proc_id": self.proc_id,
            "status": self.status,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "stdout_truncated_bytes": self.stdout_truncated_bytes,
            "stderr_truncated_bytes": self.stderr_truncated_bytes,
            "duration_ms": self.duration_ms,
            "pressure_level": self.pressure_level,
            "peak_ratio": self.peak_ratio,
            "control_mode": self.control_mode,
            "control_epoch": self.control_epoch,
        }


class SandboxProcessSessionManager:
    """Stateful subprocess manager preserving interactive stdin/stdout and takeover fences."""

    def __init__(
        self,
        workspace_dir: Path,
        *,
        scratch_tmp_dir: Path | None = None,
        egress_proxy_url: str | None = None,
        guard: WorkspaceResourceGuard | None = None,
        stream_ring_bytes: int = DEFAULT_STREAM_RING_BYTES,
    ) -> None:
        self.workspace_dir = workspace_dir
        self.scratch_tmp_dir = scratch_tmp_dir or (workspace_dir / ".tmp")
        self.egress_proxy_url = (egress_proxy_url or "").strip() or None
        self.guard = guard or WorkspaceResourceGuard(stream_ring_bytes=stream_ring_bytes)
        self.stream_ring_bytes = stream_ring_bytes
        self.control_mode: Literal["agent", "owner"] = "agent"
        self.control_epoch: int = 1
        self._sessions: dict[str, _ManagedProcess] = {}

    def set_control_mode(
        self, action: Literal["take_control", "resume_agent"]
    ) -> tuple[Literal["agent", "owner"], int]:
        self.control_epoch += 1
        self.control_mode = "owner" if action == "take_control" else "agent"
        return self.control_mode, self.control_epoch

    def _prepare_env(
        self,
        *,
        extra_public_env: dict[str, str] | None,
        surrogate_env: dict[str, str] | None,
    ) -> dict[str, str]:
        base = build_scrubbed_worker_env(
            workspace_dir=self.workspace_dir,
            scratch_tmp_dir=self.scratch_tmp_dir,
            extra_public_env=extra_public_env,
        )
        if self.egress_proxy_url:
            base["HTTP_PROXY"] = self.egress_proxy_url
            base["HTTPS_PROXY"] = self.egress_proxy_url
            base["http_proxy"] = self.egress_proxy_url
            base["https_proxy"] = self.egress_proxy_url
        for key, value in (surrogate_env or {}).items():
            clean_key = str(key or "").strip()
            clean_val = str(value or "").strip()
            if not _SAFE_ENV_NAME_RE.fullmatch(clean_key):
                raise TerminalSessionRefused(SANDBOX_RAW_CREDENTIAL_FORBIDDEN, status=400)
            if not _SURROGATE_RE.fullmatch(clean_val):
                raise TerminalSessionRefused(
                    SANDBOX_RAW_CREDENTIAL_FORBIDDEN,
                    f"Only hsur_* surrogate tokens may cross into sandbox env ({clean_key}).",
                    status=403,
                )
            base[clean_key] = clean_val
        return base

    async def start_process(
        self,
        argv: list[str],
        *,
        actor: Literal["agent", "owner"] = "agent",
        credential_approval_verified: bool = False,
        timeout_seconds: float = 120.0,
        extra_public_env: dict[str, str] | None = None,
        surrogate_env: dict[str, str] | None = None,
    ) -> ProcessSessionSnapshot:
        if actor == "agent" and self.control_mode == "owner":
            raise TerminalSessionRefused(TERMINAL_OWNER_TAKEOVER_ACTIVE, status=409)

        decision = classify_cli_command(
            argv,
            boundary_mode="ephemeral_task_worker",
            credential_approval_verified=credential_approval_verified,
        )
        if not decision.admitted:
            raise TerminalSessionRefused(
                decision.code or "CLI_COMMAND_INVALID",
                decision.reason or "Command refused",
                status=403,
            )

        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        self.scratch_tmp_dir.mkdir(parents=True, exist_ok=True)
        env = self._prepare_env(extra_public_env=extra_public_env, surrogate_env=surrogate_env)
        executable = shutil.which(argv[0], path=env.get("PATH")) or argv[0]

        proc = await asyncio.create_subprocess_exec(
            executable,
            *argv[1:],
            cwd=str(self.workspace_dir),
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        proc_id = f"proc_{secrets.token_hex(12)}"
        session = _ManagedProcess(
            proc_id=proc_id,
            argv=tuple(argv),
            proc=proc,
            stdout_ring=BoundedStreamRingBuffer(self.stream_ring_bytes),
            stderr_ring=BoundedStreamRingBuffer(self.stream_ring_bytes),
            started_at_ms=int(time.time() * 1000),
            timeout_seconds=max(1.0, min(900.0, float(timeout_seconds))),
            suppress_model_output=(actor == "owner" and self.control_mode == "owner"),
        )
        session.reader_tasks = [
            asyncio.create_task(self._pump(proc.stdout, session.stdout_ring)),
            asyncio.create_task(self._pump(proc.stderr, session.stderr_ring)),
        ]
        session.watchdog_task = asyncio.create_task(self._watch_lifetime(session))
        self._sessions[proc_id] = session
        return self._snapshot(session)

    @staticmethod
    async def _pump(stream: asyncio.StreamReader | None, ring: BoundedStreamRingBuffer) -> None:
        if stream is None:
            return
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                break
            ring.append(chunk)

    async def _watch_lifetime(self, session: _ManagedProcess) -> None:
        try:
            rc = await asyncio.wait_for(session.proc.wait(), timeout=session.timeout_seconds)
            for task in session.reader_tasks:
                await task
            if session.state == "running":
                session.exit_code = int(rc)
                session.state = "completed" if rc == 0 else "failed"
        except TimeoutError:
            await _terminate_process_group(session.proc)
            for task in session.reader_tasks:
                task.cancel()
            session.state = "timed_out"
            session.exit_code = session.proc.returncode
        finally:
            session.ended_at_ms = int(time.time() * 1000)

    def _get(self, proc_id: str) -> _ManagedProcess:
        session = self._sessions.get(proc_id)
        if session is None:
            raise TerminalSessionRefused(
                TERMINAL_NOT_FOUND, f"Unknown process {proc_id}", status=404
            )
        return session

    def _snapshot(self, session: _ManagedProcess) -> ProcessSessionSnapshot:
        verdict, _ = self.guard.current_verdict(
            workspace_dir=self.workspace_dir,
            scratch_tmp_dir=self.scratch_tmp_dir,
        )
        end_ms = session.ended_at_ms or int(time.time() * 1000)
        suppress = session.suppress_model_output or self.control_mode == "owner"
        return ProcessSessionSnapshot(
            proc_id=session.proc_id,
            status=session.state,
            exit_code=session.exit_code,
            stdout="[suppressed during owner private control]"
            if suppress
            else session.stdout_ring.utf8_tail(),
            stderr="[suppressed during owner private control]"
            if suppress
            else session.stderr_ring.utf8_tail(),
            stdout_truncated_bytes=session.stdout_ring.truncated_bytes,
            stderr_truncated_bytes=session.stderr_ring.truncated_bytes,
            duration_ms=max(0, end_ms - session.started_at_ms),
            pressure_level=verdict.level,
            peak_ratio=verdict.peak_ratio,
            control_mode=self.control_mode,
            control_epoch=self.control_epoch,
        )

    async def poll_process(self, proc_id: str, *, wait_ms: int = 1000) -> ProcessSessionSnapshot:
        session = self._get(proc_id)
        if session.state == "running" and wait_ms > 0 and session.watchdog_task is not None:
            timeout_s = min(15.0, max(0.05, wait_ms / 1000.0))
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(asyncio.shield(session.watchdog_task), timeout=timeout_s)
        return self._snapshot(session)

    async def write_stdin(
        self, proc_id: str, data: str, *, actor: Literal["agent", "owner"] = "agent"
    ) -> ProcessSessionSnapshot:
        session = self._get(proc_id)
        if actor == "agent" and self.control_mode == "owner":
            raise TerminalSessionRefused(TERMINAL_OWNER_TAKEOVER_ACTIVE, status=409)
        if session.state != "running" or session.proc.stdin is None:
            raise TerminalSessionRefused(
                "TERMINAL_NOT_RUNNING", "Process already terminated", status=409
            )
        session.proc.stdin.write(data.encode("utf-8"))
        await session.proc.stdin.drain()
        return self._snapshot(session)

    async def stop_process(self, proc_id: str) -> ProcessSessionSnapshot:
        session = self._get(proc_id)
        if session.state == "running":
            session.state = "stopped"
            await _terminate_process_group(session.proc)
            if session.watchdog_task is not None:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(session.watchdog_task, timeout=2.0)
            session.exit_code = session.proc.returncode
            session.ended_at_ms = int(time.time() * 1000)
        return self._snapshot(session)

    async def close_all(self) -> None:
        for proc_id in list(self._sessions):
            await self.stop_process(proc_id)

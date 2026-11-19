# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Standalone ADK Terminal toolset composing cleanly alongside Browser (#9744)."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

from hushh_mcp.services.agent_sandbox.process_session_manager import (
    SandboxProcessSessionManager,
    TerminalSessionRefused,
)


@dataclass(frozen=True)
class TerminalOwnerAccess:
    owner_id: str
    lease_id: str
    workspace_id: str
    credential_approval_verified: bool = False


_invocation: ContextVar[tuple[SandboxProcessSessionManager, TerminalOwnerAccess] | None] = (
    ContextVar("terminal_session_invocation", default=None)
)


@contextmanager
def terminal_session_invocation(manager: SandboxProcessSessionManager, access: TerminalOwnerAccess):
    """Bind the admitted sandbox process manager and owner access for one turn."""
    token = _invocation.set((manager, access))
    try:
        yield
    finally:
        _invocation.reset(token)


def terminal_hand_available() -> bool:
    return _invocation.get() is not None


async def terminal_start(
    argv: list[str],
    timeout_seconds: float = 120.0,
) -> dict:
    """Start one command inside the owner's isolated sandbox workspace.

    Pass argv as an explicit list of strings (never wrap raw secrets in argv).
    Returns proc_id, status ('running' | 'completed' | 'failed'), stdout/stderr
    tails, and resource telemetry. Poll long commands with terminal_poll or
    supply prompt responses via terminal_write.
    """
    current = _invocation.get()
    if current is None:
        return {"status": "unavailable", "code": "TERMINAL_SANDBOX_UNAVAILABLE"}
    manager, access = current
    try:
        snap = await manager.start_process(
            argv,
            actor="agent",
            credential_approval_verified=access.credential_approval_verified,
            timeout_seconds=timeout_seconds,
        )
        return snap.to_dict()
    except TerminalSessionRefused as exc:
        return {"status": "blocked", "code": exc.code}


async def terminal_poll(proc_id: str, wait_ms: int = 1000) -> dict:
    """Poll status and bounded stdout/stderr output for an active terminal process."""
    current = _invocation.get()
    if current is None:
        return {"status": "unavailable", "code": "TERMINAL_SANDBOX_UNAVAILABLE"}
    manager, _ = current
    try:
        snap = await manager.poll_process(proc_id, wait_ms=wait_ms)
        return snap.to_dict()
    except TerminalSessionRefused as exc:
        return {"status": "blocked", "code": exc.code}


async def terminal_write(proc_id: str, data: str) -> dict:
    """Write stdin lines (for example confirmation codes) to a waiting process."""
    current = _invocation.get()
    if current is None:
        return {"status": "unavailable", "code": "TERMINAL_SANDBOX_UNAVAILABLE"}
    manager, _ = current
    try:
        snap = await manager.write_stdin(proc_id, data, actor="agent")
        return snap.to_dict()
    except TerminalSessionRefused as exc:
        return {"status": "blocked", "code": exc.code}


async def terminal_stop(proc_id: str) -> dict:
    """Terminate an active terminal process and its descendant process group."""
    current = _invocation.get()
    if current is None:
        return {"status": "unavailable", "code": "TERMINAL_SANDBOX_UNAVAILABLE"}
    manager, _ = current
    try:
        snap = await manager.stop_process(proc_id)
        return snap.to_dict()
    except TerminalSessionRefused as exc:
        return {"status": "blocked", "code": exc.code}

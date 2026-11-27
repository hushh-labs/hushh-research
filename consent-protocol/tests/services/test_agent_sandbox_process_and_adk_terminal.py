# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Stateful microVM process manager and ADK Terminal toolset verification (#9744)."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

from hushh_mcp.one_adk import agent_tree
from hushh_mcp.one_adk.terminal_tools import (
    TerminalOwnerAccess,
    terminal_poll,
    terminal_session_invocation,
    terminal_start,
    terminal_stop,
    terminal_write,
)
from hushh_mcp.services.agent_sandbox.process_session_manager import (
    SANDBOX_RAW_CREDENTIAL_FORBIDDEN,
    TERMINAL_OWNER_TAKEOVER_ACTIVE,
    SandboxProcessSessionManager,
    TerminalSessionRefused,
)


def test_unbound_terminal_tools_fail_closed() -> None:
    async def _run() -> None:
        assert await terminal_start(["python3", "-c", "print(1)"]) == {
            "status": "unavailable",
            "code": "TERMINAL_SANDBOX_UNAVAILABLE",
        }
        assert await terminal_poll("proc_missing") == {
            "status": "unavailable",
            "code": "TERMINAL_SANDBOX_UNAVAILABLE",
        }
        assert await terminal_write("proc_missing", "hi\n") == {
            "status": "unavailable",
            "code": "TERMINAL_SANDBOX_UNAVAILABLE",
        }
        assert await terminal_stop("proc_missing") == {
            "status": "unavailable",
            "code": "TERMINAL_SANDBOX_UNAVAILABLE",
        }

    asyncio.run(_run())


def test_interactive_terminal_lifecycle_and_stop(tmp_path: Path) -> None:
    manager = SandboxProcessSessionManager(tmp_path / "ws")
    access = TerminalOwnerAccess(owner_id="owner_1", lease_id="lease_1", workspace_id="ws_alpha01")

    async def _run() -> None:
        try:
            with terminal_session_invocation(manager, access):
                started = await terminal_start(
                    [
                        sys.executable,
                        "-u",
                        "-c",
                        "import sys; line = sys.stdin.readline().strip(); print('ACK:' + line, flush=True)",
                    ]
                )
                proc_id = started["proc_id"]
                assert started["status"] == "running"

                await terminal_write(proc_id, "otp-4242\n")
                polled = await terminal_poll(proc_id, wait_ms=2000)
                assert polled["status"] == "completed"
                assert polled["exit_code"] == 0
                assert "ACK:otp-4242" in polled["stdout"]

                sleeper = await terminal_start(
                    [sys.executable, "-c", "import time; time.sleep(30)"]
                )
                stopped = await terminal_stop(sleeper["proc_id"])
                assert stopped["status"] == "stopped"
        finally:
            await manager.close_all()

    asyncio.run(_run())


def test_raw_secret_rejection_credentialed_cli_gate_and_owner_takeover(tmp_path: Path) -> None:
    manager = SandboxProcessSessionManager(tmp_path / "ws_sec")
    access = TerminalOwnerAccess(
        owner_id="owner_1",
        lease_id="lease_1",
        workspace_id="ws_alpha01",
        credential_approval_verified=False,
    )

    async def _run() -> None:
        try:
            with pytest.raises(TerminalSessionRefused) as raw_err:
                await manager.start_process(
                    [sys.executable, "-c", "print('noop')"],
                    surrogate_env={"GITHUB_TOKEN": "ghp_real_secret_value"},
                )
            assert raw_err.value.code == SANDBOX_RAW_CREDENTIAL_FORBIDDEN

            ok_surrogate = "hsur_" + ("a1b2c3d4" * 6)
            admitted = await manager.start_process(
                [sys.executable, "-c", "import os; print(os.environ['GITHUB_TOKEN'])"],
                surrogate_env={"GITHUB_TOKEN": ok_surrogate},
            )
            finished = await manager.poll_process(admitted.proc_id, wait_ms=2000)
            assert ok_surrogate in finished.stdout

            with terminal_session_invocation(manager, access):
                blocked_cli = await terminal_start(["gh", "pr", "list"])
                assert blocked_cli == {
                    "status": "blocked",
                    "code": "CLI_CREDENTIAL_APPROVAL_REQUIRED",
                }

                sleeper = await terminal_start(
                    [sys.executable, "-c", "import time; time.sleep(30)"]
                )
                mode, epoch = manager.set_control_mode("take_control")
                assert mode == "owner"
                assert epoch == 2

                masked_poll = await terminal_poll(sleeper["proc_id"], wait_ms=50)
                assert masked_poll["stdout"] == "[suppressed during owner private control]"
                assert masked_poll["stderr"] == "[suppressed during owner private control]"

                blocked_write = await terminal_write(sleeper["proc_id"], "ls\n")
                assert blocked_write == {
                    "status": "blocked",
                    "code": TERMINAL_OWNER_TAKEOVER_ACTIVE,
                }

                blocked_start = await terminal_start([sys.executable, "-c", "print('blocked')"])
                assert blocked_start == {
                    "status": "blocked",
                    "code": TERMINAL_OWNER_TAKEOVER_ACTIVE,
                }

                manager.set_control_mode("resume_agent")
                stopped = await terminal_stop(sleeper["proc_id"])
                assert stopped["status"] == "stopped"
        finally:
            await manager.close_all()

    asyncio.run(_run())


def test_adk_roster_registers_terminal_only_when_pod_and_sandbox_bound(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = SandboxProcessSessionManager(tmp_path / "ws_adk")
    access = TerminalOwnerAccess(owner_id="owner_1", lease_id="lease_1", workspace_id="ws_alpha01")

    monkeypatch.setattr(agent_tree, "pod_mode", lambda: False)
    with terminal_session_invocation(manager, access):
        non_pod_tools = agent_tree._one_roster_tools(specialist_model="test-model")
        assert terminal_start not in non_pod_tools

    monkeypatch.setattr(agent_tree, "pod_mode", lambda: True)
    unbound_tools = agent_tree._one_roster_tools(specialist_model="test-model")
    assert terminal_start not in unbound_tools

    with terminal_session_invocation(manager, access):
        bound_tools = agent_tree._one_roster_tools(specialist_model="test-model")
        for tool in (terminal_start, terminal_poll, terminal_write, terminal_stop):
            assert tool in bound_tools

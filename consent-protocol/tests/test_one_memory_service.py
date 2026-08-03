"""Tests for the flag-gated One memory-service selection.

The Agent Architecture Doctrine (`AGENTS.md`) decides statefulness by runtime topology.
This file exists to make its first half a property proven by test rather than a rule stated
in prose: **the shared multi-tenant hub never acquires memory**, no matter how the
kill-switch is set, because memory in a runtime serving every user is cross-tenant leakage.

The second half — a per-user pod may remember — is covered in
``test_pod_memory_service.py``. Here we only care about which runtime gets a service at all.
"""

from __future__ import annotations

import base64

from hushh_mcp.one_adk.agent_tree import _build_one_memory_service

_KEY = base64.b64encode(b"pod-key-alpha-32-bytes-long-xxxx").decode("ascii")


def _pod_env(monkeypatch) -> None:
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("HUSSH_ID", "ha1_alice")
    monkeypatch.setenv("HUSSH_POD_MEMORY_KEY", _KEY)


def test_hub_has_no_memory_by_default(monkeypatch):
    monkeypatch.delenv("HUSSH_POD_MODE", raising=False)
    monkeypatch.delenv("POD_AGENT_MEMORY_ENABLED", raising=False)
    assert _build_one_memory_service() is None


def test_hub_has_no_memory_even_with_the_flag_on(monkeypatch):
    """The load-bearing case. A misconfigured environment that sets the memory flag on the
    shared hub must still yield a memoryless runner."""
    monkeypatch.delenv("HUSSH_POD_MODE", raising=False)
    monkeypatch.setenv("POD_AGENT_MEMORY_ENABLED", "1")
    monkeypatch.setenv("HUSSH_ID", "ha1_alice")
    monkeypatch.setenv("HUSSH_POD_MEMORY_KEY", _KEY)
    assert _build_one_memory_service() is None


def test_pod_without_the_flag_has_no_memory(monkeypatch):
    _pod_env(monkeypatch)
    monkeypatch.delenv("POD_AGENT_MEMORY_ENABLED", raising=False)
    assert _build_one_memory_service() is None


def test_pod_with_the_flag_gets_memory(monkeypatch):
    _pod_env(monkeypatch)
    monkeypatch.setenv("POD_AGENT_MEMORY_ENABLED", "1")
    svc = _build_one_memory_service()
    assert svc is not None
    assert hasattr(svc, "search_memory")


def test_resolution_failure_degrades_to_none(monkeypatch):
    """Fail-safe: a broken resolver yields a memoryless agent, never a failed runner."""

    def _boom() -> None:
        raise RuntimeError("resolver exploded")

    monkeypatch.setattr(
        "hushh_mcp.services.pod_memory_service.resolve_pod_memory_service", _boom
    )
    _pod_env(monkeypatch)
    monkeypatch.setenv("POD_AGENT_MEMORY_ENABLED", "1")
    assert _build_one_memory_service() is None

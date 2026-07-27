"""Tests for the HUSSH_POD_MODE runtime flag (per-user pod skips fleet workers).

The flag itself is the testable unit; the three server startup handlers consume it
as a trivial early-return guard (`if pod_mode(): return`). Default OFF preserves
today's behavior (the fleet hub runs every worker)."""

from __future__ import annotations

import pytest

from hushh_mcp.runtime_settings import pod_mode


@pytest.mark.parametrize("value,expected", [("1", True), ("true", True), ("on", True), ("YES", True)])
def test_pod_mode_on(monkeypatch, value, expected):
    monkeypatch.setenv("HUSSH_POD_MODE", value)
    assert pod_mode() is expected


@pytest.mark.parametrize("value", ["0", "false", "off", "", "no"])
def test_pod_mode_off(monkeypatch, value):
    monkeypatch.setenv("HUSSH_POD_MODE", value)
    assert pod_mode() is False


def test_pod_mode_defaults_off(monkeypatch):
    monkeypatch.delenv("HUSSH_POD_MODE", raising=False)
    assert pod_mode() is False

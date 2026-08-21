"""Contract tests for the Hermes bridge.

The bridge can run agent turns on the owner's own computer, so the properties
pinned here are security properties first: off unless asked for, loopback only,
never usable without an explicit credential, and an agent failure reported by
Hermes must never be mistaken for an answer.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services import hermes_bridge_service as svc
from hushh_mcp.services.hermes_bridge_service import HermesBridgeError

ENABLED_ENV = {
    "HERMES_LOCAL_BRIDGE_ENABLED": "true",
    "HERMES_LOCAL_API_KEY": "test-key",
}


class TestConfig:
    def test_disabled_without_the_flag(self):
        config = svc.resolve_hermes_bridge_config({})
        assert config.enabled is False
        assert config.api_key == ""
        assert "HERMES_LOCAL_BRIDGE_ENABLED" in (config.disabled_reason or "")

    def test_disabled_without_a_key(self):
        config = svc.resolve_hermes_bridge_config({"HERMES_LOCAL_BRIDGE_ENABLED": "true"})
        assert config.enabled is False
        assert "HERMES_LOCAL_API_KEY" in (config.disabled_reason or "")

    def test_enabled_on_loopback(self):
        config = svc.resolve_hermes_bridge_config(dict(ENABLED_ENV))
        assert config.enabled is True
        assert config.base_url == svc.DEFAULT_BASE_URL

    def test_never_returns_the_key_when_disabled(self):
        config = svc.resolve_hermes_bridge_config(
            {**ENABLED_ENV, "HERMES_LOCAL_BRIDGE_ENABLED": "false"}
        )
        assert config.api_key == ""

    @pytest.mark.parametrize(
        "base_url",
        [
            "http://169.254.169.254",  # cloud metadata
            "http://10.0.0.5:8642",
            "https://hermes.example.com",
            "file:///etc/passwd",
            "not a url",
        ],
    )
    def test_refuses_non_loopback_hosts(self, base_url):
        """A remote base url would make an authenticated tool an SSRF primitive."""
        config = svc.resolve_hermes_bridge_config(
            {**ENABLED_ENV, "HERMES_LOCAL_BASE_URL": base_url}
        )
        assert config.enabled is False
        assert "loopback" in (config.disabled_reason or "")

    @pytest.mark.parametrize(
        "base_url",
        ["http://127.0.0.1:8642", "http://localhost:8642", "http://[::1]:8642"],
    )
    def test_accepts_loopback_hosts(self, base_url):
        assert svc.is_loopback_base_url(base_url) is True


class TestGuards:
    @pytest.mark.asyncio
    async def test_status_refuses_when_disabled(self, monkeypatch):
        monkeypatch.delenv("HERMES_LOCAL_BRIDGE_ENABLED", raising=False)
        with pytest.raises(HermesBridgeError) as excinfo:
            await svc.get_status()
        assert excinfo.value.status == "hermes_bridge_disabled"

    @pytest.mark.asyncio
    async def test_relay_rejects_empty_and_oversized_prompts(self, monkeypatch):
        for key, value in ENABLED_ENV.items():
            monkeypatch.setenv(key, value)

        with pytest.raises(HermesBridgeError):
            await svc.relay_turn("   ")
        with pytest.raises(HermesBridgeError):
            await svc.relay_turn("x" * (svc.MAX_PROMPT_CHARS + 1))

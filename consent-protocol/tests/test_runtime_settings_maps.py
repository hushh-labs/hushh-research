import json
import os

from hushh_mcp import runtime_settings


def test_google_maps_api_key_is_read_from_env(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "x" * 64)
    monkeypatch.setenv("VAULT_DATA_KEY", "a" * 64)
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "test-maps-key")
    runtime_settings.get_core_security_settings.cache_clear()
    settings = runtime_settings.get_core_security_settings()
    assert settings.google_maps_api_key == "test-maps-key"
    runtime_settings.get_core_security_settings.cache_clear()


def test_google_maps_api_key_defaults_empty(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "x" * 64)
    monkeypatch.setenv("VAULT_DATA_KEY", "a" * 64)
    monkeypatch.delenv("GOOGLE_MAPS_API_KEY", raising=False)
    runtime_settings.get_core_security_settings.cache_clear()
    settings = runtime_settings.get_core_security_settings()
    assert settings.google_maps_api_key == ""
    runtime_settings.get_core_security_settings.cache_clear()


def test_trusted_device_rollout_is_hydrated_from_canonical_runtime_config(monkeypatch):
    monkeypatch.delenv("HUSSH_TRUSTED_DEVICE_ENABLED", raising=False)
    monkeypatch.delenv("HUSSH_TRUSTED_DEVICE_UAT_ALLOWLIST", raising=False)
    monkeypatch.setenv(
        "BACKEND_RUNTIME_CONFIG_JSON",
        json.dumps(
            {
                "hushh_trusted_device_enabled": "true",
                "hushh_trusted_device_uat_allowlist": [
                    "reviewer@example.com",
                    "reviewer-uid",
                ],
            }
        ),
    )

    runtime_settings.hydrate_runtime_environment()

    assert os.environ["HUSSH_TRUSTED_DEVICE_ENABLED"] == "true"
    assert os.environ["HUSSH_TRUSTED_DEVICE_UAT_ALLOWLIST"] == "reviewer@example.com,reviewer-uid"

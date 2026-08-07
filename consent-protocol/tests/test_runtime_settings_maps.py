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


def test_nearby_presence_admission_is_hydrated_from_canonical_runtime_config(monkeypatch):
    """The two admission flags must survive the config -> env hop.

    The route gate reads them with `os.getenv`, and hosted lanes only ever set
    `BACKEND_RUNTIME_CONFIG_JSON`. Without this mapping there is no supported
    way to open nearby check-in in production at all -- the gate would read
    unset and refuse every caller no matter what the deploy passed.
    """

    monkeypatch.delenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", raising=False)
    monkeypatch.delenv("ONE_LOCATION_NEARBY_PRESENCE_COHORT", raising=False)
    monkeypatch.setenv(
        "BACKEND_RUNTIME_CONFIG_JSON",
        json.dumps(
            {
                "one_location_nearby_presence_mode": "production",
                "one_location_nearby_presence_cohort": ["owner-a", "owner-b"],
            }
        ),
    )

    runtime_settings.hydrate_runtime_environment()

    assert os.environ["ONE_LOCATION_NEARBY_PRESENCE_MODE"] == "production"
    assert os.environ["ONE_LOCATION_NEARBY_PRESENCE_COHORT"] == "owner-a,owner-b"

from __future__ import annotations

import base64

import pytest

from api.routes import developer
from hushh_mcp.consent.connector_crypto_profiles import (
    X25519_AES256_GCM,
    available_connector_wrapping_algorithms,
    get_connector_crypto_profile,
)
from hushh_mcp.services.developer_registry_service import DeveloperRegistryService


def _public_key() -> str:
    return base64.b64encode(b"x" * 32).decode("ascii")


def test_current_connector_exchange_is_the_only_enabled_profile() -> None:
    assert available_connector_wrapping_algorithms() == (X25519_AES256_GCM,)
    profile = get_connector_crypto_profile(X25519_AES256_GCM)
    assert profile.envelope_version == 2
    assert profile.fingerprint_recipient_key(_public_key()).startswith("sha256:")


def test_unknown_profile_fails_closed_before_public_key_handling() -> None:
    with pytest.raises(ValueError, match="unsupported_connector_wrapping_alg"):
        get_connector_crypto_profile("SALESFORCE_UNPROVEN_AES256_GCM_V1")

    with pytest.raises(Exception) as error:
        developer._validate_connector_wrapping_alg("SALESFORCE_UNPROVEN_AES256_GCM_V1")
    assert getattr(error.value, "status_code", None) == 400


def test_registered_key_rejects_unknown_crypto_profile_before_database_write() -> None:
    service = object.__new__(DeveloperRegistryService)
    with pytest.raises(ValueError, match="enabled crypto profile"):
        service.register_connector_key(
            app_id="app_test",
            connector_key_id="key-1",
            connector_public_key=_public_key(),
            connector_wrapping_alg="SALESFORCE_UNPROVEN_AES256_GCM_V1",
        )

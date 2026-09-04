from __future__ import annotations

import base64

import pytest
from fastapi import HTTPException

from api.routes import developer
from hushh_mcp.services.developer_registry_service import (
    DeveloperPrincipal,
    DeveloperRegistryService,
)


def _public_key() -> str:
    return base64.b64encode(b"x" * 32).decode("ascii")


def _principal() -> DeveloperPrincipal:
    return DeveloperPrincipal(
        app_id="app_partner",
        agent_id="developer:app_partner",
        display_name="Partner",
        allowed_tool_groups=("core_consent",),
        schema_profile="flat",
    )


def _registered_key() -> dict[str, str]:
    return {
        "connector_public_key": _public_key(),
        "connector_key_id": "partner-key-1",
        "connector_wrapping_alg": "X25519-AES256-GCM",
    }


def test_registered_connector_key_is_resolved_when_legacy_fields_are_omitted(monkeypatch):
    monkeypatch.setattr(
        DeveloperRegistryService,
        "get_active_connector_key",
        lambda *_args, **_kwargs: _registered_key(),
    )
    resolved = developer._resolve_registered_connector_key(
        developer.DeveloperConsentRequest(user_id="user_1", scope="attr.financial.portfolio.*"),
        principal=_principal(),
    )
    assert resolved.connector_public_key == _public_key()
    assert resolved.connector_key_id == "partner-key-1"
    assert resolved.connector_wrapping_alg == "X25519-AES256-GCM"


@pytest.mark.parametrize(
    "update",
    [
        {"connector_key_id": "other-key"},
        {"connector_public_key": base64.b64encode(b"y" * 32).decode("ascii")},
        {"connector_wrapping_alg": "other"},
    ],
)
def test_registered_connector_key_rejects_rebinding(monkeypatch, update):
    monkeypatch.setattr(
        DeveloperRegistryService,
        "get_active_connector_key",
        lambda *_args, **_kwargs: _registered_key(),
    )
    values = _registered_key()
    values.update(update)
    with pytest.raises(HTTPException) as error:
        developer._resolve_registered_connector_key(
            developer.DeveloperConsentRequest(
                user_id="user_1", scope="attr.financial.portfolio.*", **values
            ),
            principal=_principal(),
        )
    assert error.value.status_code == 400
    assert error.value.detail["error_code"] == "CONNECTOR_KEY_REBIND_REQUIRED"

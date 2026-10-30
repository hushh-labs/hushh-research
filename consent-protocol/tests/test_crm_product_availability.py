from __future__ import annotations

import pytest
from fastapi import HTTPException

from api.routes.connected_systems import _require_local_crm_product
from hushh_mcp.services import action_gateway
from hushh_mcp.services.crm_product_availability import crm_product_available


@pytest.mark.parametrize("environment", ["uat", "staging", "production", "prod", "", "unknown"])
def test_crm_product_is_unavailable_outside_development(environment: str) -> None:
    assert crm_product_available(environment=environment, explicit_enabled=True) is False


@pytest.mark.parametrize("enabled", [None, "", "0", "false", "off", False])
def test_crm_product_is_fail_closed_without_explicit_enablement(enabled: str | bool | None) -> None:
    assert crm_product_available(environment="development", explicit_enabled=enabled) is False


@pytest.mark.parametrize("enabled", ["1", "true", "yes", "on", True])
def test_crm_product_is_available_only_when_local_flag_is_explicit(enabled: str | bool) -> None:
    assert crm_product_available(environment="development", explicit_enabled=enabled) is True


def test_connected_system_routes_return_non_enumerating_404(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_LOCAL_CRM_ENABLED", "true")

    with pytest.raises(HTTPException) as exc_info:
        _require_local_crm_product()

    assert exc_info.value.status_code == 404
    assert exc_info.value.detail == "Not found"


def test_hosted_action_gateway_contains_no_crm_actions(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_LOCAL_CRM_ENABLED", "true")
    action_gateway.load_action_gateway.cache_clear()
    action_gateway._action_index.cache_clear()

    serialized = str(action_gateway.list_action_gateway_actions()).lower()

    assert "connected_system" not in serialized
    assert "/one/connected-systems" not in serialized
    assert "crm" not in serialized

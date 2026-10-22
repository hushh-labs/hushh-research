"""Shared developer API fixtures for free compatibility and commercial contracts."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI

from api.routes import developer

_CONNECTOR_PUBLIC_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
_CONNECTOR_KEY_ID = "connector_demo"
_CONNECTOR_WRAPPING_ALG = "X25519-AES256-GCM"


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(developer.router)
    return app


def _fake_principal() -> developer.DeveloperPrincipal:
    return developer.DeveloperPrincipal(
        app_id="app_demo_123",
        agent_id="developer:app_demo_123",
        display_name="Demo App",
        allowed_tool_groups=("core_consent",),
        allowed_capabilities=("cap.one.invoke",),
        contact_email="founder@example.com",
    )


@pytest.fixture(autouse=True)
def _isolate_developer_registry_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    """Route unit tests use explicit key fakes rather than a live registry DB."""
    monkeypatch.setattr(
        developer.DeveloperRegistryService,
        "get_active_connector_key",
        lambda _self, **_kwargs: None,
    )

    class _FreeCommerce:
        async def get_tariff(self, **_kwargs: Any) -> None:
            return None

        async def list_tariffs(self, **_kwargs: Any) -> list[dict[str, Any]]:
            return []

    monkeypatch.setattr(developer, "_commerce_service", _FreeCommerce)


def _offer_fakes(monkeypatch: pytest.MonkeyPatch, inserted: dict[str, Any]) -> None:
    """Shared fakes for offer/reverse-auction request_consent tests."""

    class _FakeScopeGenerator:
        async def get_available_scopes(self, user_id: str) -> list[str]:
            return ["attr.financial.portfolio.*"]

    class _FakeIndex:
        available_domains = ["financial"]

    class _FakePkmService:
        scope_generator = _FakeScopeGenerator()

        async def resolve_metadata_index(self, user_id: str) -> _FakeIndex:
            return _FakeIndex()

    class _FakeConsentDBService:
        async def get_covering_active_tokens(
            self, user_id: str, *, requested_scope: str, agent_id: str | None = None
        ) -> list[dict[str, Any]]:
            return []

        async def get_pending_request_for_scope(
            self, user_id: str, *, agent_id: str, scope: str
        ) -> None:
            return None

        async def get_superseded_active_tokens(
            self, user_id: str, *, requested_scope: str, agent_id: str | None = None
        ) -> list[dict[str, Any]]:
            return []

        async def was_recently_denied(
            self, user_id: str, scope: str, cooldown_seconds: int = 60, agent_id: str | None = None
        ) -> bool:
            return False

        async def insert_event(self, **kwargs: Any) -> int:
            inserted.update(kwargs)
            return 1

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "get_pkm_service", lambda: _FakePkmService())
    monkeypatch.setattr(developer, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )


def _discovery_fakes(monkeypatch: pytest.MonkeyPatch, pkm_service: Any) -> None:
    class _Commerce:
        async def list_tariffs(self, **_kwargs: Any) -> list[dict[str, Any]]:
            return [
                {
                    "machineScope": "attr.financial.profile.*",
                    "scopeHandle": "s_financial_profile",
                    "priceCents": 1,
                    "baseDurationSeconds": 3600,
                    "tariffRevision": 1,
                },
                {
                    "machineScope": "attr.financial.profile.risk_tolerance",
                    "scopeHandle": "s_financial_profile",
                    "priceCents": 99,
                    "baseDurationSeconds": 3600,
                    "tariffRevision": 1,
                },
                {
                    "machineScope": "attr.financial.profile.*",
                    "scopeHandle": "s_retired_profile",
                    "priceCents": 500,
                    "baseDurationSeconds": 3600,
                    "tariffRevision": 2,
                },
            ]

    monkeypatch.delenv("DB_OFFLINE", raising=False)
    monkeypatch.setattr(developer, "_commerce_service", _Commerce)
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "get_pkm_service", lambda: pkm_service)
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )

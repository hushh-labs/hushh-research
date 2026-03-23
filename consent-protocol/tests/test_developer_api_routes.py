from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import developer

_CONNECTOR_PUBLIC_KEY = "U29tZUNvbm5lY3RvclB1YmxpY0tleURhdGE="


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(developer.router)
    return app


def _fake_principal():
    return developer.DeveloperPrincipal(
        app_id="app_demo_123",
        agent_id="developer:app_demo_123",
        display_name="Demo App",
        allowed_tool_groups=("core_consent",),
        contact_email="founder@example.com",
    )


def _override_firebase_auth():
    return "firebase_uid_123"


def test_list_scopes_returns_dynamic_catalog(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")

    client = TestClient(_build_app())
    response = client.get("/api/v1/list-scopes")

    assert response.status_code == 200
    payload = response.json()
    names = [item["name"] for item in payload["scopes"]]
    assert payload["scopes_are_dynamic"] is True
    assert "pkm.read" in names
    assert all("world" not in name for name in names)
    assert "attr.{domain}.*" in names
    assert payload["request_endpoint"] == "/api/v1/request-consent"
    assert "hushh://info/developer-api" in payload["mcp_resources"]
    assert payload["recommended_flow"][-1] == "get_scoped_data"


def test_developer_root_returns_self_serve_summary(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")

    client = TestClient(_build_app())
    response = client.get("/api/v1")

    assert response.status_code == 200
    payload = response.json()
    assert payload["endpoints"]["user_scopes"] == "/api/v1/user-scopes/{user_id}"
    assert payload["developer_access"]["mode"] == "self_serve"
    assert payload["developer_access"]["portal_api"]["enable"] == "/api/developer/access/enable"


def test_user_scopes_requires_developer_key(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")

    client = TestClient(_build_app())
    response = client.get("/api/v1/user-scopes/user_123")

    assert response.status_code == 401
    detail = response.json()["detail"]
    assert detail["error_code"] == "DEVELOPER_TOKEN_REQUIRED"


def test_user_scopes_rejects_authorization_header(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")

    client = TestClient(_build_app())
    response = client.get(
        "/api/v1/user-scopes/user_123",
        headers={"Authorization": "Bearer hdk_demo"},
    )

    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["error_code"] == "DEVELOPER_TOKEN_QUERY_REQUIRED"


def test_user_scopes_returns_discovered_domains(monkeypatch):
    class _FakeScopeGenerator:
        async def get_available_scopes(self, user_id: str) -> list[str]:
            assert user_id == "user_123"
            return [
                "attr.financial.*",
                "attr.financial.profile.*",
                "attr.financial.profile.risk_tolerance",
                "pkm.read",
            ]

        async def get_available_scope_entries(self, user_id: str) -> list[dict]:
            assert user_id == "user_123"
            return [
                {
                    "scope": "attr.financial.*",
                    "domain": "financial",
                    "path": None,
                    "wildcard": True,
                    "source_kind": "pkm_index",
                    "registry_handle": None,
                    "label": "Financial Domain",
                    "exposure_eligibility": True,
                    "manifest_revision": 2,
                    "meta_reference": "domain wildcard derived from discovered PKM domains",
                },
                {
                    "scope": "attr.financial.profile.*",
                    "domain": "financial",
                    "path": "profile",
                    "wildcard": True,
                    "source_kind": "pkm_manifests.top_level_scope_paths",
                    "registry_handle": "s_financial_profile",
                    "label": "Profile",
                    "exposure_eligibility": True,
                    "manifest_revision": 2,
                    "meta_reference": "manifest top-level scope path",
                },
                {
                    "scope": "attr.financial.profile.risk_tolerance",
                    "domain": "financial",
                    "path": "profile.risk_tolerance",
                    "wildcard": False,
                    "source_kind": "pkm_manifest_paths",
                    "registry_handle": "s_financial_profile",
                    "label": "Risk Tolerance",
                    "exposure_eligibility": True,
                    "manifest_revision": 2,
                    "meta_reference": "manifest path row marked exposure eligible",
                },
            ]

    class _FakeIndex:
        available_domains = ["financial"]

    class _FakePkmService:
        scope_generator = _FakeScopeGenerator()

        async def get_index_v2(self, user_id: str):
            assert user_id == "user_123"
            return _FakeIndex()

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "get_pkm_service", lambda: _FakePkmService())
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )

    client = TestClient(_build_app())
    response = client.get(
        "/api/v1/user-scopes/user_123?token=hdk_demo",
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["available_domains"] == ["financial"]
    assert "attr.financial.*" in payload["scopes"]
    assert payload["scope_entries"][0]["source_kind"] == "pkm_index"
    assert payload["scope_entries"][1]["meta_reference"] == "manifest top-level scope path"
    assert payload["scope_entries"][2]["path"] == "profile.risk_tolerance"
    assert payload["app_display_name"] == "Demo App"


def test_tool_catalog_filters_to_public_beta_defaults(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")

    client = TestClient(_build_app())
    response = client.get("/api/v1/tool-catalog")

    assert response.status_code == 200
    payload = response.json()
    tool_names = [tool["name"] for tool in payload["tools"]]
    assert payload["allowed_tool_groups"] == ["core_consent"]
    assert payload["approval_required"] is False
    assert "discover_user_domains" in tool_names
    assert "list_ria_profiles" not in tool_names


def test_tool_catalog_rejects_authorization_header(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")

    client = TestClient(_build_app())
    response = client.get(
        "/api/v1/tool-catalog",
        headers={"Authorization": "Bearer hdk_demo"},
    )

    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["error_code"] == "DEVELOPER_TOKEN_QUERY_REQUIRED"


def test_request_consent_creates_pending_request(monkeypatch):
    inserted: dict[str, object] = {}

    class _FakeScopeGenerator:
        async def get_available_scopes(self, user_id: str) -> list[str]:
            assert user_id == "user_123"
            return ["attr.financial.*", "pkm.read"]

    class _FakeIndex:
        available_domains = ["financial"]

    class _FakePkmService:
        scope_generator = _FakeScopeGenerator()

        async def get_index_v2(self, user_id: str):
            assert user_id == "user_123"
            return _FakeIndex()

    class _FakeConsentDBService:
        async def get_active_tokens(
            self, user_id: str, agent_id: str | None = None, scope: str | None = None
        ):
            assert user_id == "user_123"
            assert agent_id == "developer:app_demo_123"
            assert scope == "attr.financial.*"
            return []

        async def was_recently_denied(
            self,
            user_id: str,
            scope: str,
            cooldown_seconds: int = 60,
            agent_id: str | None = None,
        ):
            assert user_id == "user_123"
            assert scope == "attr.financial.*"
            assert agent_id == "developer:app_demo_123"
            return False

        async def insert_event(self, **kwargs):
            inserted.update(kwargs)
            return 1

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "get_pkm_service", lambda: _FakePkmService())
    monkeypatch.setattr(developer, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )

    client = TestClient(_build_app())
    response = client.post(
        "/api/v1/request-consent?token=hdk_demo",
        json={
            "user_id": "user_123",
            "scope": "attr.financial.*",
            "expiry_hours": 24,
            "reason": "Portfolio analysis",
            "connector_public_key": _CONNECTOR_PUBLIC_KEY,
            "connector_key_id": "connector_demo",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "pending"
    assert payload["scope"] == "attr.financial.*"
    assert inserted["action"] == "REQUESTED"
    assert inserted["agent_id"] == "developer:app_demo_123"
    assert inserted["scope"] == "attr.financial.*"
    assert inserted["metadata"]["developer_app_display_name"] == "Demo App"
    assert inserted["metadata"]["connector_public_key"] == _CONNECTOR_PUBLIC_KEY
    assert inserted["metadata"]["connector_key_id"] == "connector_demo"


def test_request_consent_rejects_legacy_body_fields(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )

    client = TestClient(_build_app())
    response = client.post(
        "/api/v1/request-consent?token=hdk_demo",
        json={
            "user_id": "user_123",
            "scope": "attr.financial.*",
            "developer_token": "secret-token",
            "connector_public_key": _CONNECTOR_PUBLIC_KEY,
        },
    )

    assert response.status_code == 422


def test_request_consent_rejects_legacy_scope_alias(monkeypatch):
    class _FakeScopeGenerator:
        async def get_available_scopes(self, user_id: str) -> list[str]:
            assert user_id == "user_123"
            return ["attr.financial.*", "pkm.read"]

    class _FakeIndex:
        available_domains = ["financial"]

    class _FakePkmService:
        scope_generator = _FakeScopeGenerator()

        async def get_index_v2(self, user_id: str):
            assert user_id == "user_123"
            return _FakeIndex()

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "get_pkm_service", lambda: _FakePkmService())
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )

    client = TestClient(_build_app())
    response = client.post(
        "/api/v1/request-consent?token=hdk_demo",
        json={
            "user_id": "user_123",
            "scope": "attr_financial",
            "connector_public_key": _CONNECTOR_PUBLIC_KEY,
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["error_code"] == "INVALID_SCOPE"


def test_get_access_returns_disabled_state(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(
        developer.DeveloperRegistryService,
        "get_app_by_owner_uid",
        lambda self, owner_firebase_uid: None,
    )
    monkeypatch.setattr(
        developer,
        "_resolve_firebase_owner_profile",
        lambda firebase_uid: {
            "owner_email": "founder@example.com",
            "owner_display_name": "Founder",
            "owner_provider_ids": ["google.com"],
        },
    )

    app = _build_app()
    app.dependency_overrides[developer.require_firebase_auth] = _override_firebase_auth

    client = TestClient(app)
    response = client.get(
        "/api/developer/access", headers={"Authorization": "Bearer firebase-token"}
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["access_enabled"] is False
    assert payload["user_id"] == "firebase_uid_123"
    assert payload["owner_email"] == "founder@example.com"


def test_enable_access_is_idempotent(monkeypatch):
    calls = {"count": 0}

    def _ensure(self, **kwargs):
        calls["count"] += 1
        raw_token = "hdk_demo_secret" if calls["count"] == 1 else None
        return {
            "app": {
                "app_id": "app_demo_123",
                "agent_id": "developer:app_demo_123",
                "display_name": "Founder App",
                "contact_email": "founder@example.com",
                "support_url": "https://example.com/support",
                "policy_url": "https://example.com/privacy",
                "website_url": "https://example.com",
                "status": "active",
                "allowed_tool_groups": '["core_consent"]',
                "created_at": 1,
                "updated_at": 2,
            },
            "active_token": {
                "id": 101,
                "app_id": "app_demo_123",
                "token_prefix": "hdk_demo",
                "label": "primary",
                "created_at": 2,
                "revoked_at": None,
                "last_used_at": None,
            },
            "raw_token": raw_token,
            "created_app": calls["count"] == 1,
            "issued_token": calls["count"] == 1,
        }

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer.DeveloperRegistryService, "ensure_self_serve_access", _ensure)
    monkeypatch.setattr(
        developer,
        "_resolve_firebase_owner_profile",
        lambda firebase_uid: {
            "owner_email": "founder@example.com",
            "owner_display_name": "Founder",
            "owner_provider_ids": ["google.com"],
        },
    )

    app = _build_app()
    app.dependency_overrides[developer.require_firebase_auth] = _override_firebase_auth
    client = TestClient(app)

    first = client.post(
        "/api/developer/access/enable", headers={"Authorization": "Bearer firebase-token"}
    )
    second = client.post(
        "/api/developer/access/enable", headers={"Authorization": "Bearer firebase-token"}
    )

    assert first.status_code == 200
    assert first.json()["raw_token"] == "hdk_demo_secret"  # noqa: S105
    assert second.status_code == 200
    assert second.json()["raw_token"] is None
    assert calls["count"] == 2


def test_update_access_profile_updates_visible_identity(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(
        developer.DeveloperRegistryService,
        "update_self_serve_profile",
        lambda self, **kwargs: {
            "app_id": "app_demo_123",
            "agent_id": "developer:app_demo_123",
            "display_name": kwargs["display_name"],
            "contact_email": "founder@example.com",
            "support_url": kwargs["support_url"],
            "policy_url": kwargs["policy_url"],
            "website_url": kwargs["website_url"],
            "status": "active",
            "allowed_tool_groups": '["core_consent"]',
            "created_at": 1,
            "updated_at": 3,
        },
    )
    monkeypatch.setattr(
        developer.DeveloperRegistryService,
        "get_active_token",
        lambda self, app_id: {
            "id": 101,
            "app_id": app_id,
            "token_prefix": "hdk_demo",
            "label": "primary",
            "created_at": 2,
            "revoked_at": None,
            "last_used_at": 9,
        },
    )
    monkeypatch.setattr(
        developer,
        "_resolve_firebase_owner_profile",
        lambda firebase_uid: {
            "owner_email": "founder@example.com",
            "owner_display_name": "Founder",
            "owner_provider_ids": ["apple.com", "google.com"],
        },
    )

    app = _build_app()
    app.dependency_overrides[developer.require_firebase_auth] = _override_firebase_auth
    client = TestClient(app)
    response = client.patch(
        "/api/developer/access/profile",
        headers={"Authorization": "Bearer firebase-token"},
        json={
            "display_name": "External Agent",
            "support_url": "https://example.com/support",
            "policy_url": "https://example.com/privacy",
            "website_url": "https://example.com",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["app"]["display_name"] == "External Agent"
    assert payload["active_token"]["token_prefix"] == "hdk_demo"  # noqa: S105


def test_rotate_access_token_returns_new_raw_token(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(
        developer.DeveloperRegistryService,
        "rotate_self_serve_token",
        lambda self, owner_firebase_uid: {
            "app": {
                "app_id": "app_demo_123",
                "agent_id": "developer:app_demo_123",
                "display_name": "Founder App",
                "contact_email": "founder@example.com",
                "support_url": None,
                "policy_url": None,
                "website_url": None,
                "status": "active",
                "allowed_tool_groups": '["core_consent"]',
                "created_at": 1,
                "updated_at": 4,
            },
            "active_token": {
                "id": 202,
                "app_id": "app_demo_123",
                "token_prefix": "hdk_rotated",
                "label": "primary",
                "created_at": 4,
                "revoked_at": None,
                "last_used_at": None,
            },
            "raw_token": "hdk_rotated_secret",
        },
    )
    monkeypatch.setattr(
        developer,
        "_resolve_firebase_owner_profile",
        lambda firebase_uid: {
            "owner_email": "founder@example.com",
            "owner_display_name": "Founder",
            "owner_provider_ids": ["google.com"],
        },
    )

    app = _build_app()
    app.dependency_overrides[developer.require_firebase_auth] = _override_firebase_auth
    client = TestClient(app)
    response = client.post(
        "/api/developer/access/rotate-key",
        headers={"Authorization": "Bearer firebase-token"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["raw_token"] == "hdk_rotated_secret"  # noqa: S105
    assert payload["active_token"]["token_prefix"] == "hdk_rotated"  # noqa: S105

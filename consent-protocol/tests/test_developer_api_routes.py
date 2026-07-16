from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import developer
from api.routes.developer import _STATIC_REQUESTABLE_SCOPES, _is_supported_scope

_CONNECTOR_PUBLIC_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
_CONNECTOR_KEY_ID = "connector_demo"
_CONNECTOR_WRAPPING_ALG = "X25519-AES256-GCM"


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
        allowed_capabilities=("cap.one.invoke",),
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
    assert "pkm.read" not in names
    assert "cap.one.invoke" in names
    assert all("world" not in name for name in names)
    assert "attr.{domain_slug}.{scope_slug}.*" in names
    assert payload["request_endpoint"] == "/api/v1/request-consent"
    assert payload["public_profile_export_endpoint"] == "/api/v1/public-profile-export"
    assert "hushh://info/developer-api" in payload["mcp_resources"]
    assert payload["recommended_flow"][0] == "search_user_scopes"
    assert payload["recommended_flow"][-1] == "get_encrypted_scoped_export"


def test_developer_root_returns_self_serve_summary(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")

    client = TestClient(_build_app())
    response = client.get("/api/v1")

    assert response.status_code == 200
    payload = response.json()
    assert payload["endpoints"]["user_scopes"] == "/api/v1/user-scopes/{user_id}"
    assert payload["endpoints"]["scoped_export"] == "/api/v1/scoped-export"
    assert payload["endpoints"]["public_profile_export"] == "/api/v1/public-profile-export"
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


def test_user_scopes_rejects_oversized_query_token_before_auth(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")

    client = TestClient(_build_app())
    response = client.get("/api/v1/user-scopes/user_123", params={"token": "x" * 2049})

    assert response.status_code == 422


def test_consent_status_rejects_oversized_query_params_before_auth(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")

    client = TestClient(_build_app())
    response = client.get(
        "/api/v1/consent-status",
        params={
            "user_id": "u" * 129,
            "scope": "s" * 501,
            "request_id": "r" * 201,
            "token": "x" * 2049,
        },
    )

    assert response.status_code == 422


def test_tool_catalog_rejects_oversized_query_token_before_auth(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")

    client = TestClient(_build_app())
    response = client.get("/api/v1/tool-catalog", params={"token": "x" * 2049})

    assert response.status_code == 422


def test_request_consent_rejects_oversized_query_token_before_auth(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")

    client = TestClient(_build_app())
    response = client.post(
        "/api/v1/request-consent",
        params={"token": "x" * 2049},
        json={"scope": "attr.financial.*"},
    )

    assert response.status_code == 422


def test_scoped_export_rejects_oversized_query_token_before_auth(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")

    client = TestClient(_build_app())
    response = client.post(
        "/api/v1/scoped-export",
        params={"token": "x" * 2049},
        json={"scope": "attr.financial.*", "consent_token": "valid_token"},
    )

    assert response.status_code == 422


class _EmptyScopeGenerator:
    async def get_available_scopes(self, user_id: str) -> list[str]:
        return []

    async def get_available_scope_entries(self, user_id: str) -> list[dict]:
        return []


class _EmptyIndex:
    available_domains: list[str] = []


class _EmptyPkmService:
    scope_generator = _EmptyScopeGenerator()

    async def resolve_metadata_index(self, user_id: str):
        return _EmptyIndex()


def test_user_scopes_accepts_authorization_bearer_header(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")

    captured: dict[str, object] = {}

    def _fake_authenticate_token(self, raw_token, *, ip_address=None, user_agent=None):
        captured["raw_token"] = raw_token
        return _fake_principal()

    monkeypatch.setattr(
        developer.DeveloperRegistryService,
        "authenticate_token",
        _fake_authenticate_token,
    )
    monkeypatch.setattr(developer, "get_pkm_service", lambda: _EmptyPkmService())

    client = TestClient(_build_app())
    response = client.get(
        "/api/v1/user-scopes/user_123",
        headers={"Authorization": "Bearer hdk_demo"},
    )

    assert response.status_code == 200
    assert captured["raw_token"] == "hdk_demo"  # noqa: S105
    assert response.json()["app_id"] == "app_demo_123"


def test_user_scopes_invalid_authorization_bearer_returns_403(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")

    monkeypatch.setattr(
        developer.DeveloperRegistryService,
        "authenticate_token",
        lambda self, *_args, **_kwargs: None,
    )

    client = TestClient(_build_app())
    response = client.get(
        "/api/v1/user-scopes/user_123",
        headers={"Authorization": "Bearer not-a-real-token"},
    )

    assert response.status_code == 403
    detail = response.json()["detail"]
    assert detail["error_code"] == "DEVELOPER_TOKEN_INVALID"


def test_user_scopes_authorization_bearer_takes_precedence_over_query(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")

    captured: dict[str, object] = {}

    def _fake_authenticate_token(self, raw_token, *, ip_address=None, user_agent=None):
        captured["raw_token"] = raw_token
        return _fake_principal()

    monkeypatch.setattr(
        developer.DeveloperRegistryService,
        "authenticate_token",
        _fake_authenticate_token,
    )
    monkeypatch.setattr(developer, "get_pkm_service", lambda: _EmptyPkmService())

    client = TestClient(_build_app())
    response = client.get(
        "/api/v1/user-scopes/user_123?token=from_query",
        headers={"Authorization": "Bearer from_header"},
    )

    assert response.status_code == 200
    assert captured["raw_token"] == "from_header"  # noqa: S105


def test_user_scopes_rejects_query_token_authentication(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")

    monkeypatch.setattr(
        developer.DeveloperRegistryService,
        "authenticate_token",
        lambda self, *_args, **_kwargs: _fake_principal(),
    )
    monkeypatch.setattr(developer, "get_pkm_service", lambda: _EmptyPkmService())

    client = TestClient(_build_app())
    response = client.get("/api/v1/user-scopes/user_123?token=hdk_demo")

    assert response.status_code == 400
    assert response.json()["detail"]["error_code"] == "QUERY_TOKEN_AUTH_UNSUPPORTED"


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
                    "scope": "attr.financial.schema_version.*",
                    "domain": "financial",
                    "path": "schema_version",
                    "wildcard": True,
                    "source_kind": "pkm_manifests.top_level_scope_paths",
                    "registry_handle": "s_financial_schema_version",
                    "label": "Schema Version",
                    "exposure_eligibility": True,
                    "manifest_revision": 2,
                    "meta_reference": "manifest top-level scope path",
                    "consumer_visible": False,
                    "internal_only": True,
                    "visibility_reason": "structural_top_level_path",
                },
                {
                    "scope": "attr.kyc_workflow.*",
                    "domain": "kyc_workflow",
                    "path": None,
                    "wildcard": True,
                    "source_kind": "pkm_index",
                    "registry_handle": None,
                    "label": "KYC Workflow Domain",
                    "exposure_eligibility": True,
                    "manifest_revision": 2,
                    "meta_reference": "internal runtime domain",
                    "consumer_visible": False,
                    "internal_only": True,
                    "visibility_reason": "internal_runtime_domain",
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
        available_domains = ["financial", "kyc_workflow"]

    class _FakePkmService:
        scope_generator = _FakeScopeGenerator()

        async def resolve_metadata_index(self, user_id: str):
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
    assert payload["scopes"] == ["attr.financial.profile.*"]
    assert payload["scope_entries"][0]["source_kind"] == ("pkm_manifests.top_level_scope_paths")
    assert payload["scope_entries"][0]["meta_reference"] == "manifest top-level scope path"
    assert len(payload["scope_entries"]) == 1
    assert all(entry["path"] != "schema_version" for entry in payload["scope_entries"])
    assert payload["app_display_name"] == "Demo App"


def test_user_scopes_omits_private_entries_and_marks_default_available(monkeypatch):
    class _FakeScopeGenerator:
        async def get_available_scopes(self, user_id: str) -> list[str]:
            assert user_id == "user_123"
            return [
                "attr.financial.*",
                "attr.financial.portfolio.*",
                "attr.financial.profile.*",
            ]

        async def get_available_scope_entries(self, user_id: str) -> list[dict]:
            assert user_id == "user_123"
            return [
                {
                    "scope": "attr.financial.portfolio.*",
                    "domain": "financial",
                    "path": "portfolio",
                    "wildcard": True,
                    "source_kind": "pkm_manifests.top_level_scope_paths",
                    "registry_handle": "s_financial_portfolio",
                    "label": "Portfolio",
                    "exposure_eligibility": True,
                    "visibility_posture": "default_available",
                    "default_projection_ready": True,
                    "default_projection_updated_at": "2026-05-21T10:00:00Z",
                },
                {
                    "scope": "attr.financial.profile.*",
                    "domain": "financial",
                    "path": "profile",
                    "wildcard": True,
                    "source_kind": "pkm_manifests.top_level_scope_paths",
                    "registry_handle": "s_financial_profile",
                    "label": "Financial Profile",
                    "exposure_eligibility": True,
                    "visibility_posture": "private",
                    "default_projection_ready": False,
                },
            ]

    class _FakeIndex:
        available_domains = ["financial"]

    class _FakePkmService:
        scope_generator = _FakeScopeGenerator()

        async def resolve_metadata_index(self, user_id: str):
            assert user_id == "user_123"
            return _FakeIndex()

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "get_pkm_service", lambda: _FakePkmService())
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )

    client = TestClient(_build_app())
    response = client.get("/api/v1/user-scopes/user_123?token=hdk_demo")

    assert response.status_code == 200
    payload = response.json()
    assert payload["scopes"] == ["attr.financial.portfolio.*"]
    assert payload["scope_entries"] == [
        {
            "scope": "attr.financial.portfolio.*",
            "domain": "financial",
            "path": "portfolio",
            "wildcard": True,
            "source_kind": "pkm_manifests.top_level_scope_paths",
            "registry_handle": "s_financial_portfolio",
            "label": "Portfolio",
            "exposure_eligibility": True,
            "visibility_posture": "default_available",
            "default_projection_ready": True,
            "default_projection_updated_at": "2026-05-21T10:00:00Z",
        }
    ]


def _search_pkm_service():
    class _FakeScopeGenerator:
        async def get_available_scopes(self, user_id: str) -> list[str]:
            assert user_id == "user_123"
            return [
                "attr.financial.profile.*",
                "attr.financial.portfolio.*",
                "attr.health.metrics.*",
            ]

        async def get_available_scope_entries(self, user_id: str) -> list[dict]:
            assert user_id == "user_123"
            # Only externally-requestable scopes (attr.{domain}.{path}.*) survive
            # the snapshot filter; bare domain wildcards like attr.financial.* are
            # intentionally not external-requestable.
            return [
                {
                    "scope": "attr.financial.profile.*",
                    "domain": "financial",
                    "path": "profile",
                    "wildcard": True,
                    "source_kind": "pkm_manifests.top_level_scope_paths",
                    "registry_handle": "s_financial_profile",
                    "label": "Profile",
                    "exposure_eligibility": True,
                },
                {
                    "scope": "attr.financial.portfolio.*",
                    "domain": "financial",
                    "path": "portfolio",
                    "wildcard": True,
                    "source_kind": "pkm_manifests.top_level_scope_paths",
                    "registry_handle": "s_financial_portfolio",
                    "label": "Portfolio",
                    "exposure_eligibility": True,
                },
                {
                    "scope": "attr.health.metrics.*",
                    "domain": "health",
                    "path": "metrics",
                    "wildcard": True,
                    "source_kind": "pkm_manifests.top_level_scope_paths",
                    "registry_handle": "s_health_metrics",
                    "label": "Health Metrics",
                    "exposure_eligibility": True,
                },
            ]

    class _FakeIndex:
        available_domains = ["financial", "health"]

    class _FakePkmService:
        scope_generator = _FakeScopeGenerator()

        async def resolve_metadata_index(self, user_id: str):
            assert user_id == "user_123"
            return _FakeIndex()

    return _FakePkmService()


def test_search_user_scopes_ranks_least_privilege_first(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "get_pkm_service", lambda: _search_pkm_service())
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )

    client = TestClient(_build_app())
    response = client.get("/api/v1/user-scopes/user_123/search?token=hdk_demo&query=financial")

    assert response.status_code == 200
    payload = response.json()
    scopes = [m["scope"] for m in payload["matches"]]
    # Both financial scopes match the domain exactly and have equal specificity,
    # so the tie breaks alphabetically for deterministic ordering.
    assert scopes == ["attr.financial.portfolio.*", "attr.financial.profile.*"]
    assert all(m["match_reason"] == "exact_domain_match" for m in payload["matches"])
    assert payload["available_domains"] == ["financial", "health"]
    assert payload["scopes_are_dynamic"] is True
    assert payload["app_display_name"] == "Demo App"


def test_search_user_scopes_unknown_query_returns_empty_gracefully(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "get_pkm_service", lambda: _search_pkm_service())
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )

    client = TestClient(_build_app())
    response = client.get(
        "/api/v1/user-scopes/user_123/search?token=hdk_demo&query=zzz-nope&domain=nope"
    )

    # Graceful: an unknown lookup is a 200 with no matches, never a 4xx/5xx.
    assert response.status_code == 200
    payload = response.json()
    assert payload["matches"] == []
    assert payload["available_domains"] == ["financial", "health"]


def test_search_user_scopes_requires_developer_key(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")

    client = TestClient(_build_app())
    response = client.get("/api/v1/user-scopes/user_123/search")

    assert response.status_code == 401
    assert response.json()["detail"]["error_code"] == "DEVELOPER_TOKEN_REQUIRED"


def test_user_scopes_verbose_still_hides_internal_exact_paths(monkeypatch):
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

        async def resolve_metadata_index(self, user_id: str):
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
        "/api/v1/user-scopes/user_123?token=hdk_demo&detail=verbose",
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["available_domains"] == ["financial"]
    assert [entry["path"] for entry in payload["scope_entries"]] == ["profile"]
    assert payload["scopes"] == ["attr.financial.profile.*"]


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
    assert tool_names == [
        "search_user_scopes",
        "prepare_campaign_context",
        "request_consent",
        "check_consent_status",
        "get_encrypted_scoped_export",
    ]
    assert "list_ria_profiles" not in tool_names


def test_tool_catalog_accepts_authorization_bearer_header(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")

    monkeypatch.setattr(
        developer.DeveloperRegistryService,
        "authenticate_token",
        lambda self, *_args, **_kwargs: _fake_principal(),
    )

    client = TestClient(_build_app())
    response = client.get(
        "/api/v1/tool-catalog",
        headers={"Authorization": "Bearer hdk_demo"},
    )

    assert response.status_code == 200


def test_request_consent_creates_pending_request(monkeypatch):
    inserted: dict[str, object] = {}

    class _FakeScopeGenerator:
        async def get_available_scopes(self, user_id: str) -> list[str]:
            assert user_id == "user_123"
            return ["attr.financial.portfolio.*"]

    class _FakeIndex:
        available_domains = ["financial"]

    class _FakePkmService:
        scope_generator = _FakeScopeGenerator()

        async def resolve_metadata_index(self, user_id: str):
            assert user_id == "user_123"
            return _FakeIndex()

    class _FakeConsentDBService:
        async def get_covering_active_tokens(
            self,
            user_id: str,
            *,
            requested_scope: str,
            agent_id: str | None = None,
        ):
            assert user_id == "user_123"
            assert agent_id == "developer:app_demo_123"
            assert requested_scope == "attr.financial.portfolio.*"
            return []

        async def get_pending_request_for_scope(
            self,
            user_id: str,
            *,
            agent_id: str,
            scope: str,
        ):
            assert user_id == "user_123"
            assert agent_id == "developer:app_demo_123"
            assert scope == "attr.financial.portfolio.*"
            return None

        async def get_superseded_active_tokens(
            self,
            user_id: str,
            *,
            requested_scope: str,
            agent_id: str | None = None,
        ):
            assert user_id == "user_123"
            assert agent_id == "developer:app_demo_123"
            assert requested_scope == "attr.financial.portfolio.*"
            return []

        async def was_recently_denied(
            self,
            user_id: str,
            scope: str,
            cooldown_seconds: int = 60,
            agent_id: str | None = None,
        ):
            assert user_id == "user_123"
            assert scope == "attr.financial.portfolio.*"
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
            "scope": "attr.financial.portfolio.*",
            "expiry_hours": 24,
            "reason": "Portfolio analysis",
            "connector_public_key": _CONNECTOR_PUBLIC_KEY,
            "connector_key_id": _CONNECTOR_KEY_ID,
            "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "pending"
    assert payload["scope"] == "attr.financial.portfolio.*"
    assert payload["requested_scope"] == "attr.financial.portfolio.*"
    assert payload["granted_scope"] is None
    assert inserted["action"] == "REQUESTED"
    assert inserted["agent_id"] == "developer:app_demo_123"
    assert inserted["scope"] == "attr.financial.portfolio.*"
    assert len(inserted["request_id"]) <= 32
    assert inserted["metadata"]["developer_app_display_name"] == "Demo App"
    assert inserted["metadata"]["connector_public_key"] == _CONNECTOR_PUBLIC_KEY
    assert inserted["metadata"]["connector_key_id"] == _CONNECTOR_KEY_ID
    assert inserted["metadata"]["connector_wrapping_alg"] == _CONNECTOR_WRAPPING_ALG


def test_request_consent_creates_pending_one_invocation_request(monkeypatch):
    inserted: dict[str, object] = {}

    class _FakeScopeGenerator:
        async def get_available_scopes(self, user_id: str) -> list[str]:
            assert user_id == "user_123"
            return []

        async def get_available_scope_entries(self, user_id: str) -> list[dict]:
            assert user_id == "user_123"
            return []

    class _FakeIndex:
        available_domains: list[str] = []

    class _FakePkmService:
        scope_generator = _FakeScopeGenerator()

        async def resolve_metadata_index(self, user_id: str):
            assert user_id == "user_123"
            return _FakeIndex()

    class _FakeConsentDBService:
        async def find_covering_active_token(
            self,
            user_id: str,
            *,
            requested_scope: str,
            agent_id: str | None = None,
        ):
            assert user_id == "user_123"
            assert requested_scope == "cap.one.invoke"
            assert agent_id == "developer:app_demo_123"
            return None

        async def get_pending_request_for_scope(
            self,
            user_id: str,
            *,
            agent_id: str,
            scope: str,
        ):
            assert user_id == "user_123"
            assert agent_id == "developer:app_demo_123"
            assert scope == "cap.one.invoke"
            return None

        async def get_superseded_active_tokens(
            self,
            user_id: str,
            *,
            requested_scope: str,
            agent_id: str | None = None,
        ):
            assert user_id == "user_123"
            assert requested_scope == "cap.one.invoke"
            assert agent_id == "developer:app_demo_123"
            return []

        async def was_recently_denied(
            self,
            user_id: str,
            scope: str,
            cooldown_seconds: int = 60,
            agent_id: str | None = None,
        ):
            assert user_id == "user_123"
            assert scope == "cap.one.invoke"
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
        "/api/v1/request-consent",
        json={
            "user_id": "user_123",
            "scope": "cap.one.invoke",
            "expiry_hours": 24,
            "approval_timeout_minutes": 60,
            "reason": "Coordinate this request through Agent One",
        },
        headers={"Authorization": "Bearer hdk_demo"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "pending"
    assert payload["scope"] == "cap.one.invoke"
    assert payload["requested_scope"] == "cap.one.invoke"
    assert payload["granted_scope"] is None
    assert payload["agent_id"] == "developer:app_demo_123"
    assert payload["approval_timeout_minutes"] == 60
    assert inserted["action"] == "REQUESTED"
    assert inserted["agent_id"] == "developer:app_demo_123"
    assert inserted["scope"] == "cap.one.invoke"
    assert inserted["metadata"]["reason"] == "Coordinate this request through Agent One"
    assert "connector_wrapping_alg" not in inserted["metadata"]


def _offer_fakes(monkeypatch, inserted):
    """Shared fakes for offer/reverse-auction request_consent tests."""

    class _FakeScopeGenerator:
        async def get_available_scopes(self, user_id: str) -> list[str]:
            return ["attr.financial.portfolio.*"]

    class _FakeIndex:
        available_domains = ["financial"]

    class _FakePkmService:
        scope_generator = _FakeScopeGenerator()

        async def resolve_metadata_index(self, user_id: str):
            return _FakeIndex()

    class _FakeConsentDBService:
        async def get_covering_active_tokens(self, user_id, *, requested_scope, agent_id=None):
            return []

        async def get_pending_request_for_scope(self, user_id, *, agent_id, scope):
            return None

        async def get_superseded_active_tokens(self, user_id, *, requested_scope, agent_id=None):
            return []

        async def was_recently_denied(self, user_id, scope, cooldown_seconds=60, agent_id=None):
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


def test_request_consent_records_reverse_auction_offer(monkeypatch):
    inserted: dict[str, object] = {}
    _offer_fakes(monkeypatch, inserted)

    client = TestClient(_build_app())
    response = client.post(
        "/api/v1/request-consent?token=hdk_demo",
        json={
            "user_id": "user_123",
            "scope": "attr.financial.portfolio.*",
            "reason": "Personalized wealth offer",
            "connector_public_key": _CONNECTOR_PUBLIC_KEY,
            "connector_key_id": _CONNECTOR_KEY_ID,
            "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
            "offer": {
                "bid_amount": 12.5,
                "currency": "usd",
                "offer_summary": "Wealth advisory match",
                "settlement_ref": "ap2_mandate_abc",
            },
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "pending"
    # Offer surfaced back to the Demand Agent.
    offer = payload["offer"]
    assert offer is not None
    assert offer["kind"] == "consent_reverse_auction_bid"
    assert offer["bid_amount"] == 12.5
    assert offer["currency"] == "USD"  # normalized upper-case
    assert offer["offer_summary"] == "Wealth advisory match"
    assert offer["settlement_ref"] == "ap2_mandate_abc"
    assert offer["settlement_status"] == "pending_user_clearance"
    assert offer["settlement_rail"] == "ap2"
    # Offer recorded on the consent event metadata (auditable).
    meta = inserted["metadata"]
    assert meta["offer_kind"] == "consent_reverse_auction_bid"
    assert meta["offer_bid_amount"] == 12.5
    assert meta["offer_currency"] == "USD"
    assert meta["offer_settlement_ref"] == "ap2_mandate_abc"


def test_request_consent_without_offer_returns_null_offer(monkeypatch):
    inserted: dict[str, object] = {}
    _offer_fakes(monkeypatch, inserted)

    client = TestClient(_build_app())
    response = client.post(
        "/api/v1/request-consent?token=hdk_demo",
        json={
            "user_id": "user_123",
            "scope": "attr.financial.portfolio.*",
            "connector_public_key": _CONNECTOR_PUBLIC_KEY,
            "connector_key_id": _CONNECTOR_KEY_ID,
            "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "pending"
    assert payload["offer"] is None
    assert "offer_kind" not in inserted["metadata"]


def test_request_consent_rejects_nonpositive_bid(monkeypatch):
    inserted: dict[str, object] = {}
    _offer_fakes(monkeypatch, inserted)

    client = TestClient(_build_app())
    response = client.post(
        "/api/v1/request-consent?token=hdk_demo",
        json={
            "user_id": "user_123",
            "scope": "attr.financial.portfolio.*",
            "connector_public_key": _CONNECTOR_PUBLIC_KEY,
            "connector_key_id": _CONNECTOR_KEY_ID,
            "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
            "offer": {"bid_amount": 0},
        },
    )

    # Pydantic validation rejects bid_amount <= 0 before the handler runs.
    assert response.status_code == 422


def test_request_consent_does_not_treat_public_projection_as_encrypted_grant(monkeypatch):
    inserted: dict[str, object] = {}

    class _FakeScopeGenerator:
        async def get_available_scopes(self, user_id: str) -> list[str]:
            assert user_id == "user_123"
            return ["attr.financial.portfolio.*"]

        async def get_available_scope_entries(self, user_id: str) -> list[dict]:
            assert user_id == "user_123"
            return [
                {
                    "scope": "attr.financial.portfolio.*",
                    "domain": "financial",
                    "path": "portfolio",
                    "wildcard": True,
                    "source_kind": "pkm_manifests.top_level_scope_paths",
                    "label": "Portfolio",
                    "visibility_posture": "default_available",
                    "default_projection_ready": True,
                    "default_projection_updated_at": "2026-05-21T10:00:00Z",
                }
            ]

    class _FakeIndex:
        available_domains = ["financial"]

    class _FakePkmService:
        scope_generator = _FakeScopeGenerator()

        async def resolve_metadata_index(self, user_id: str):
            assert user_id == "user_123"
            return _FakeIndex()

    class _FakeConsentDBService:
        async def get_covering_active_tokens(self, *_args, **_kwargs):
            return []

        async def get_pending_request_for_scope(self, *_args, **_kwargs):
            return None

        async def get_superseded_active_tokens(self, *_args, **_kwargs):
            return []

        async def was_recently_denied(self, *_args, **_kwargs):
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
            "scope": "attr.financial.portfolio.*",
            "connector_public_key": _CONNECTOR_PUBLIC_KEY,
            "connector_key_id": _CONNECTOR_KEY_ID,
            "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "pending"
    assert payload["requested_scope"] == "attr.financial.portfolio.*"
    assert inserted["action"] == "REQUESTED"


def test_request_consent_reuses_active_semantic_scope_token(monkeypatch):
    existing_grant = "grant_existing_scope"

    class _FakeScopeGenerator:
        async def get_available_scopes(self, user_id: str) -> list[str]:
            assert user_id == "user_123"
            return [
                "attr.financial.analytics.*",
            ]

    class _FakeIndex:
        available_domains = ["financial"]

    class _FakePkmService:
        scope_generator = _FakeScopeGenerator()

        async def resolve_metadata_index(self, user_id: str):
            assert user_id == "user_123"
            return _FakeIndex()

    class _FakeConsentDBService:
        async def get_covering_active_tokens(
            self,
            user_id: str,
            *,
            requested_scope: str,
            agent_id: str | None = None,
        ):
            assert requested_scope == "attr.financial.analytics.*"
            return [
                {
                    "scope": "attr.financial.analytics.*",
                    "request_id": "req_existing",
                    "token_id": existing_grant,
                    "expires_at": 123456789,
                    "metadata": {
                        "expiry_hours": 168,
                        "requester_label": "Demo App",
                        "requester_image_url": "https://example.com/logo.png",
                        "reason": "Portfolio insights",
                    },
                }
            ]

        async def get_consent_export_metadata(self, token_id: str):
            assert token_id == existing_grant
            return {
                "is_strict_zero_knowledge": True,
                "export_revision": 2,
                "export_generated_at": "2026-03-24T18:30:00Z",
                "refresh_status": "current",
            }

        async def get_pending_request_for_scope(self, *_args, **_kwargs):
            raise AssertionError(
                "pending dedupe should not run when an active covering token exists"
            )

        async def was_recently_denied(self, *_args, **_kwargs):
            raise AssertionError(
                "deny cooldown should not run when an active covering token exists"
            )

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
            "scope": "attr.financial.analytics.*",
            "connector_public_key": _CONNECTOR_PUBLIC_KEY,
            "connector_key_id": _CONNECTOR_KEY_ID,
            "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "already_granted"
    assert payload["scope"] == "attr.financial.analytics.*"
    assert payload["requested_scope"] == "attr.financial.analytics.*"
    assert payload["granted_scope"] == "attr.financial.analytics.*"
    assert payload["coverage_kind"] == "exact"
    assert payload["covered_by_existing_grant"] is True
    assert payload["consent_token"] == existing_grant
    assert payload["export_revision"] == 2
    assert payload["export_refresh_status"] == "current"


def test_request_consent_reuses_exact_active_token(monkeypatch):
    existing_grant = "grant_existing_exact"

    class _FakeScopeGenerator:
        async def get_available_scopes(self, user_id: str) -> list[str]:
            assert user_id == "user_123"
            return ["attr.financial.portfolio.*"]

    class _FakeIndex:
        available_domains = ["financial"]

    class _FakePkmService:
        scope_generator = _FakeScopeGenerator()

        async def resolve_metadata_index(self, user_id: str):
            assert user_id == "user_123"
            return _FakeIndex()

    class _FakeConsentDBService:
        async def get_covering_active_tokens(
            self,
            user_id: str,
            *,
            requested_scope: str,
            agent_id: str | None = None,
        ):
            assert user_id == "user_123"
            assert agent_id == "developer:app_demo_123"
            assert requested_scope == "attr.financial.portfolio.*"
            return [
                {
                    "scope": "attr.financial.portfolio.*",
                    "request_id": "req_existing_exact",
                    "token_id": existing_grant,
                    "expires_at": 123456789,
                    "metadata": {
                        "expiry_hours": 24,
                        "requester_label": "Demo App",
                        "reason": "Portfolio insights",
                    },
                }
            ]

        async def get_consent_export_metadata(self, token_id: str):
            assert token_id == existing_grant
            return {
                "is_strict_zero_knowledge": True,
                "export_revision": 7,
                "export_generated_at": "2026-03-24T18:30:00Z",
                "refresh_status": "current",
            }

        async def get_pending_request_for_scope(self, *_args, **_kwargs):
            raise AssertionError("pending lookup should not run for exact active reuse")

        async def was_recently_denied(self, *_args, **_kwargs):
            raise AssertionError("deny cooldown should not run for exact active reuse")

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
            "scope": "attr.financial.portfolio.*",
            "connector_public_key": _CONNECTOR_PUBLIC_KEY,
            "connector_key_id": _CONNECTOR_KEY_ID,
            "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "already_granted"
    assert payload["request_id"] == "req_existing_exact"
    assert payload["requested_scope"] == "attr.financial.portfolio.*"
    assert payload["granted_scope"] == "attr.financial.portfolio.*"
    assert payload["coverage_kind"] == "exact"
    assert payload["covered_by_existing_grant"] is True
    assert payload["consent_token"] == existing_grant
    assert payload["export_revision"] == 7


def test_request_consent_reuses_exact_pending_request(monkeypatch):
    class _FakeScopeGenerator:
        async def get_available_scopes(self, user_id: str) -> list[str]:
            assert user_id == "user_123"
            return ["attr.financial.portfolio.*"]

    class _FakeIndex:
        available_domains = ["financial"]

    class _FakePkmService:
        scope_generator = _FakeScopeGenerator()

        async def resolve_metadata_index(self, user_id: str):
            assert user_id == "user_123"
            return _FakeIndex()

    class _FakeConsentDBService:
        async def get_covering_active_tokens(self, *_args, **_kwargs):
            return []

        async def get_pending_request_for_scope(
            self,
            user_id: str,
            *,
            agent_id: str,
            scope: str,
        ):
            assert user_id == "user_123"
            assert agent_id == "developer:app_demo_123"
            assert scope == "attr.financial.portfolio.*"
            return {
                "id": "req_pending_existing",
                "scope": "attr.financial.portfolio.*",
                "scopeDescription": "Access all your financial data",
                "pollTimeoutAt": 123456789,
                "approvalTimeoutAt": 123456789,
                "approvalTimeoutMinutes": 30,
                "expiryHours": 24,
                "requestUrl": "https://example.com/request",
                "requesterLabel": "Demo App",
                "requesterImageUrl": "https://example.com/logo.png",
                "reason": "Portfolio insights",
                "metadata": {
                    "reason": "Portfolio insights",
                    "refresh_policy": "snapshot",
                    "connector_key_id": _CONNECTOR_KEY_ID,
                    "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
                    "recipient_key_fingerprint": developer._validate_connector_public_key(
                        _CONNECTOR_PUBLIC_KEY
                    ),
                },
                "isScopeUpgrade": False,
            }

        async def was_recently_denied(self, *_args, **_kwargs):
            raise AssertionError("deny cooldown should not run for exact pending reuse")

        async def insert_event(self, **_kwargs):
            raise AssertionError("insert_event should not run for exact pending reuse")

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
            "scope": "attr.financial.portfolio.*",
            "reason": "Portfolio insights",
            "approval_timeout_minutes": 30,
            "connector_public_key": _CONNECTOR_PUBLIC_KEY,
            "connector_key_id": _CONNECTOR_KEY_ID,
            "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "pending"
    assert payload["request_id"] == "req_pending_existing"
    assert payload["message"] == "Consent request already pending in the Hussh app."
    assert payload["approval_timeout_at"] == 123456789
    assert payload["approval_timeout_minutes"] == 30
    assert payload["expiry_hours"] == 24
    assert payload["request_url"] == "https://example.com/request"


def test_pending_request_reuse_requires_identical_lifecycle_and_key_fields():
    fingerprint = developer._validate_connector_public_key(_CONNECTOR_PUBLIC_KEY)
    pending = {
        "reason": "Portfolio insights",
        "expiryHours": 24,
        "approvalTimeoutMinutes": 30,
        "metadata": {
            "refresh_policy": "snapshot",
            "connector_key_id": _CONNECTOR_KEY_ID,
            "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
            "recipient_key_fingerprint": fingerprint,
        },
    }
    common = {
        "reason": "Portfolio insights",
        "expiry_hours": 24,
        "approval_timeout_minutes": 30,
        "refresh_policy": "snapshot",
        "connector_key_id": _CONNECTOR_KEY_ID,
        "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
        "recipient_key_fingerprint": fingerprint,
    }

    assert developer._pending_request_matches(pending, **common)
    for field, replacement in (
        ("reason", "A different purpose"),
        ("expiry_hours", 48),
        ("approval_timeout_minutes", 60),
        ("refresh_policy", "continuous_until_expiry"),
        ("connector_key_id", "connector_other"),
        ("recipient_key_fingerprint", "sha256:" + "0" * 64),
    ):
        changed = {**common, field: replacement}
        assert not developer._pending_request_matches(pending, **changed)


def test_request_consent_rejects_public_expiry_hours_outside_range(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )

    client = TestClient(_build_app())
    for expiry_hours in (23, 2161):
        response = client.post(
            "/api/v1/request-consent?token=hdk_demo",
            json={
                "user_id": "user_123",
                "scope": "attr.financial.portfolio.*",
                "expiry_hours": expiry_hours,
                "connector_public_key": _CONNECTOR_PUBLIC_KEY,
                "connector_key_id": _CONNECTOR_KEY_ID,
                "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
            },
        )
        assert response.status_code == 400
        assert response.json()["detail"]["error_code"] == "INVALID_EXPIRY_HOURS"


def test_request_consent_rejects_public_approval_timeout_minutes_outside_range(
    monkeypatch,
):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )

    client = TestClient(_build_app())
    for approval_timeout_minutes in (4, 1441):
        response = client.post(
            "/api/v1/request-consent?token=hdk_demo",
            json={
                "user_id": "user_123",
                "scope": "attr.financial.portfolio.*",
                "approval_timeout_minutes": approval_timeout_minutes,
                "connector_public_key": _CONNECTOR_PUBLIC_KEY,
                "connector_key_id": _CONNECTOR_KEY_ID,
                "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
            },
        )
        assert response.status_code == 400
        assert response.json()["detail"]["error_code"] == "INVALID_APPROVAL_TIMEOUT_MINUTES"


def test_request_consent_rejects_unsupported_connector_wrapping_alg(monkeypatch):
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
            "scope": "attr.financial.portfolio.*",
            "connector_public_key": _CONNECTOR_PUBLIC_KEY,
            "connector_key_id": _CONNECTOR_KEY_ID,
            "connector_wrapping_alg": "unsupported",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["error_code"] == "INVALID_CONNECTOR_WRAPPING_ALG"


def test_request_consent_marks_scope_upgrade_metadata(monkeypatch):
    inserted: dict[str, object] = {}

    class _FakeScopeGenerator:
        async def get_available_scopes(self, user_id: str) -> list[str]:
            assert user_id == "user_123"
            return [
                "attr.financial.*",
                "attr.financial.analytics.*",
                "attr.financial.analytics.quality_metrics",
            ]

    class _FakeIndex:
        available_domains = ["financial"]

    class _FakePkmService:
        scope_generator = _FakeScopeGenerator()

        async def resolve_metadata_index(self, user_id: str):
            assert user_id == "user_123"
            return _FakeIndex()

    class _FakeConsentDBService:
        async def get_covering_active_tokens(self, *_args, **_kwargs):
            return []

        async def get_pending_request_for_scope(self, *_args, **_kwargs):
            return None

        async def get_superseded_active_tokens(
            self,
            user_id: str,
            *,
            requested_scope: str,
            agent_id: str | None = None,
        ):
            assert requested_scope == "attr.financial.analytics.*"
            return [
                {"scope": "attr.financial.analytics.quality_metrics"},
            ]

        async def was_recently_denied(self, *_args, **_kwargs):
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
            "scope": "attr.financial.analytics.*",
            "connector_public_key": _CONNECTOR_PUBLIC_KEY,
            "connector_key_id": _CONNECTOR_KEY_ID,
            "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "pending"
    assert payload["is_scope_upgrade"] is True
    assert payload["existing_granted_scopes"] == ["attr.financial.analytics.quality_metrics"]
    assert "additional access" in payload["additional_access_summary"].lower()
    assert inserted["metadata"]["is_scope_upgrade"] is True


def test_get_consent_status_uses_covering_active_token(monkeypatch):
    class _FakeConsentDBService:
        async def get_covering_active_tokens(
            self,
            user_id: str,
            *,
            requested_scope: str,
            agent_id: str | None = None,
        ):
            assert user_id == "user_123"
            assert requested_scope == "attr.financial.analytics.quality_metrics"
            return [
                {
                    "scope": "attr.financial.analytics.*",
                    "request_id": "req_existing",
                    "token_id": "token_existing",
                    "expires_at": 123456789,
                    "metadata": {
                        "expiry_hours": 168,
                        "requester_label": "Demo App",
                        "reason": "Portfolio insights",
                    },
                }
            ]

        async def get_consent_export_metadata(self, token_id: str):
            assert token_id == "token_existing"  # noqa: S105 - test fixture token id
            return {
                "is_strict_zero_knowledge": True,
                "export_revision": 5,
                "export_generated_at": "2026-03-24T18:30:00Z",
                "refresh_status": "current",
            }

        async def get_request_status(self, *_args, **_kwargs):
            return None

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )

    client = TestClient(_build_app())
    response = client.get(
        "/api/v1/consent-status?token=hdk_demo&user_id=user_123&scope=attr.financial.analytics.quality_metrics"
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "granted"
    assert payload["scope"] == "attr.financial.analytics.quality_metrics"
    assert payload["requested_scope"] == "attr.financial.analytics.quality_metrics"
    assert payload["granted_scope"] == "attr.financial.analytics.*"
    assert payload["coverage_kind"] == "superset"
    assert payload["export_revision"] == 5
    assert payload["export_refresh_status"] == "current"


def test_get_consent_status_pending_request_does_not_return_event_token(monkeypatch):
    class _FakeConsentDBService:
        async def get_covering_active_tokens(
            self,
            user_id: str,
            *,
            requested_scope: str,
            agent_id: str | None = None,
        ):
            return []

        async def get_request_status(self, user_id: str, request_id: str):
            assert user_id == "user_123"
            assert request_id == "req_pending"
            return {
                "action": "REQUESTED",
                "agent_id": "developer:app_demo_123",
                "scope": "cap.one.invoke",
                "request_id": "req_pending",
                "token_id": "evt_internal_row_id",
                "poll_timeout_at": 123456789,
                "metadata": {
                    "approval_timeout_minutes": 60,
                    "expiry_hours": 24,
                    "requester_label": "Demo App",
                },
            }

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )

    client = TestClient(_build_app())
    response = client.get(
        "/api/v1/consent-status?token=hdk_demo&user_id=user_123&request_id=req_pending"
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "pending"
    assert payload["consent_token"] is None


def test_developer_consent_status_payload_only_returns_token_after_grant():
    principal = _fake_principal()

    pending = developer._developer_consent_status_payload(
        latest={
            "action": "REQUESTED",
            "scope": "cap.one.invoke",
            "token_id": "evt_internal",
            "metadata": {"requester_label": "Demo App"},
        },
        user_id="user_123",
        request_id="req_pending",
        principal=principal,
    )
    granted = developer._developer_consent_status_payload(
        latest={
            "action": "CONSENT_GRANTED",
            "scope": "cap.one.invoke",
            "token_id": "HCT:granted",
            "expires_at": 123456789,
            "metadata": {"requester_label": "Demo App"},
        },
        user_id="user_123",
        request_id="req_pending",
        principal=principal,
    )

    assert pending["status"] == "pending"
    assert pending["consent_token"] is None
    assert pending["terminal"] is False
    assert granted["status"] == "granted"
    assert granted["consent_token"] == "HCT:granted"
    assert granted["terminal"] is True


def test_developer_consent_event_stream_rejects_other_developer(monkeypatch):
    class _FakeConsentDBService:
        async def get_request_status(self, user_id: str, request_id: str):
            return {
                "action": "REQUESTED",
                "agent_id": "developer:other_app",
                "scope": "cap.one.invoke",
                "request_id": request_id,
            }

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )

    client = TestClient(_build_app())
    response = client.get(
        "/api/v1/consent-events?user_id=user_123&request_id=req_pending",
        headers={"Authorization": "Bearer hdk_demo"},
    )

    assert response.status_code == 404
    assert response.json()["detail"]["error_code"] == "CONSENT_REQUEST_NOT_FOUND"


def test_developer_consent_event_stream_returns_terminal_snapshot(monkeypatch):
    class _FakeConsentDBService:
        async def get_request_status(self, user_id: str, request_id: str):
            return {
                "action": "CONSENT_GRANTED",
                "agent_id": "developer:app_demo_123",
                "scope": "cap.one.invoke",
                "request_id": request_id,
                "token_id": "HCT:granted",
                "expires_at": 123456789,
                "metadata": {"requester_label": "Demo App"},
            }

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )

    client = TestClient(_build_app())
    response = client.get(
        "/api/v1/consent-events?user_id=user_123&request_id=req_granted",
        headers={"Authorization": "Bearer hdk_demo"},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert "no-store" in response.headers["cache-control"].lower()
    body = response.text
    assert "event: snapshot" in body
    assert '"status": "granted"' in body
    assert '"consent_token": "HCT:granted"' in body


def test_developer_consent_subscribers_are_fanout_not_shared_queue():
    from api import consent_listener

    async def _run():
        q1 = await consent_listener.subscribe_developer_consent_queue(
            request_id="req_fanout",
            agent_id="developer:app_demo_123",
        )
        q2 = await consent_listener.subscribe_developer_consent_queue(
            request_id="req_fanout",
            agent_id="developer:app_demo_123",
        )
        try:
            await consent_listener._push_to_developer_consent_queues(
                {
                    "request_id": "req_fanout",
                    "agent_id": "developer:app_demo_123",
                    "action": "CONSENT_GRANTED",
                }
            )
            assert (await asyncio.wait_for(q1.get(), timeout=1))["action"] == "CONSENT_GRANTED"
            assert (await asyncio.wait_for(q2.get(), timeout=1))["action"] == "CONSENT_GRANTED"
        finally:
            await consent_listener.unsubscribe_developer_consent_queue(
                request_id="req_fanout",
                agent_id="developer:app_demo_123",
                queue=q1,
            )
            await consent_listener.unsubscribe_developer_consent_queue(
                request_id="req_fanout",
                agent_id="developer:app_demo_123",
                queue=q2,
            )

    asyncio.run(_run())


def test_mcp_scope_search_resolves_identifier_without_echo(monkeypatch):
    monkeypatch.setattr(
        developer,
        "_resolve_mcp_user_identifier",
        lambda *_args, **_kwargs: asyncio.sleep(0, result="firebase_uid_internal"),
    )
    monkeypatch.setattr(developer, "get_pkm_service", lambda: _EmptyPkmService())
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )
    client = TestClient(_build_app())
    response = client.post(
        "/api/v1/mcp/search-scopes",
        headers={"Authorization": "Bearer hdk_demo"},
        json={"user_identifier": "private@example.com"},
    )
    assert response.status_code == 200
    serialized = response.text
    assert "private@example.com" not in serialized
    assert "firebase_uid_internal" not in serialized
    assert response.json() == {"scope_entries": []}


def test_mcp_status_is_app_bound_and_identifier_free(monkeypatch):
    class _FakeConsentDBService:
        async def get_request_status_for_agent(self, request_ref: str, *, agent_id: str):
            assert request_ref == "req_0123456789abcdef0123456789ab"
            assert agent_id == "developer:app_demo_123"
            return {
                "action": "CONSENT_GRANTED",
                "expires_at": 9999999999999,
                "approval_timeout_at": 123450000,
                "user_id": "must-not-pass-through",
                "token_id": "must-not-pass-through",
            }

    monkeypatch.setattr(developer, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )
    client = TestClient(_build_app())
    response = client.get(
        "/api/v1/mcp/consent-status/req_0123456789abcdef0123456789ab",
        headers={"Authorization": "Bearer hdk_demo"},
    )
    assert response.status_code == 200
    assert response.json() == {
        "status": "granted",
        "expires_at": 9999999999999,
        "poll_after_seconds": None,
        "approval_timeout_at": 123450000,
        "grant_ref": "req_0123456789abcdef0123456789ab",
    }


def test_mcp_status_hides_cross_app_reference(monkeypatch):
    class _FakeConsentDBService:
        async def get_request_status_for_agent(self, _request_ref: str, *, agent_id: str):
            assert agent_id == "developer:app_demo_123"
            return None

    monkeypatch.setattr(developer, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )
    client = TestClient(_build_app())
    response = client.get(
        "/api/v1/mcp/consent-status/req_0123456789abcdef0123456789ab",
        headers={"Authorization": "Bearer hdk_demo"},
    )
    assert response.status_code == 404
    assert response.json()["detail"]["error_code"] == "CONSENT_REQUEST_NOT_FOUND"


def test_mcp_status_marks_past_grant_expired(monkeypatch):
    class _FakeConsentDBService:
        async def get_request_status_for_agent(self, _request_ref: str, *, agent_id: str):
            assert agent_id == "developer:app_demo_123"
            return {
                "action": "CONSENT_GRANTED",
                "expires_at": 1,
                "approval_timeout_at": 1,
            }

    monkeypatch.setattr(developer, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )
    client = TestClient(_build_app())
    response = client.get(
        "/api/v1/mcp/consent-status/req_0123456789abcdef0123456789ab",
        headers={"Authorization": "Bearer hdk_demo"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "expired"
    assert response.json()["grant_ref"] is None


def test_mcp_request_sanitizes_raw_consent_response(monkeypatch):
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )
    monkeypatch.setattr(
        developer,
        "_resolve_mcp_user_identifier",
        lambda *_args, **_kwargs: asyncio.sleep(0, result="firebase_uid_internal"),
    )

    async def _raw_request(*_args, **_kwargs):
        return {
            "status": "already_granted",
            "request_id": "req_0123456789abcdef0123456789ab",
            "scope": "attr.financial.portfolio.*",
            "coverage_kind": "exact",
            "expires_at": 123456789,
            "user_id": "firebase_uid_internal",
            "consent_token": "HCT:must-not-pass-through",
        }

    monkeypatch.setattr(developer, "request_consent", _raw_request)
    client = TestClient(_build_app())
    response = client.post(
        "/api/v1/mcp/request-consent",
        headers={"Authorization": "Bearer hdk_demo"},
        json={
            "user_identifier": "private@example.com",
            "scope": "attr.financial.portfolio.*",
            "purpose": "Prepare a bounded portfolio summary.",
            "connector_public_key": _CONNECTOR_PUBLIC_KEY,
            "connector_key_id": _CONNECTOR_KEY_ID,
            "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
        },
    )
    assert response.status_code == 200
    assert response.json() == {
        "status": "granted",
        "scope": "attr.financial.portfolio.*",
        "coverage_kind": "exact",
        "expires_at": 123456789,
        "poll_after_seconds": None,
        "approval_timeout_at": None,
        "grant_ref": "req_0123456789abcdef0123456789ab",
    }
    assert "private@example.com" not in response.text
    assert "firebase_uid_internal" not in response.text
    assert "HCT:" not in response.text


def test_mcp_request_authenticates_before_resolving_identifier(monkeypatch):
    resolved = False

    async def _resolve(*_args, **_kwargs):
        nonlocal resolved
        resolved = True
        return "firebase_uid_internal"

    monkeypatch.setattr(developer, "_resolve_mcp_user_identifier", _resolve)
    client = TestClient(_build_app())
    response = client.post(
        "/api/v1/mcp/request-consent",
        json={
            "user_identifier": "private@example.com",
            "scope": "attr.financial.portfolio.*",
            "purpose": "Prepare a bounded portfolio summary.",
            "connector_public_key": _CONNECTOR_PUBLIC_KEY,
            "connector_key_id": _CONNECTOR_KEY_ID,
            "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
        },
    )
    assert response.status_code == 401
    assert resolved is False


def test_mcp_export_resolves_internal_token_by_app_and_grant(monkeypatch):
    class _FakeConsentDBService:
        async def get_consent_export_by_grant(self, grant_id: str, *, app_id: str):
            assert grant_id == "req_0123456789abcdef0123456789ab"
            assert app_id == "app_demo_123"
            return {
                "consent_token": "HCT:internal-only",
                "user_id": "firebase_uid_internal",
            }

    async def _load(**kwargs):
        assert kwargs["consent_token"] == "HCT:internal-only"
        assert kwargs["user_id"] == "firebase_uid_internal"
        return (
            _fake_principal(),
            SimpleNamespace(
                scope_str="attr.financial.portfolio.*",
                scope=SimpleNamespace(value="attr.financial.portfolio.*"),
                expires_at=123456789,
            ),
            {
                "scope": "attr.financial.portfolio.*",
                "is_strict_zero_knowledge": True,
                "envelope_version": 2,
                "export_id": "a" * 32,
                "export_revision": 1,
                "iv": "iv",
                "tag": "tag",
                "wrapped_key_bundle": {"connector_key_id": "connector_demo"},
                "envelope_aad": {"grant_id": "req_0123456789abcdef0123456789ab"},
                "envelope_aad_sha256": "b" * 64,
                "ciphertext_sha256": "c" * 64,
                "ciphertext_bytes": 128,
            },
        )

    monkeypatch.setattr(developer, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(developer, "_load_scoped_export_or_raise", _load)
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )
    client = TestClient(_build_app())
    response = client.post(
        "/api/v1/mcp/scoped-export",
        headers={"Authorization": "Bearer hdk_demo"},
        json={
            "grant_ref": "req_0123456789abcdef0123456789ab",
            "expected_scope": "attr.financial.portfolio.*",
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert "HCT:internal-only" not in response.text
    assert "firebase_uid_internal" not in response.text


def test_mcp_export_hides_cross_app_grant(monkeypatch):
    class _FakeConsentDBService:
        async def get_consent_export_by_grant(self, _grant_id: str, *, app_id: str):
            assert app_id == "app_demo_123"
            return None

    monkeypatch.setattr(developer, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )
    client = TestClient(_build_app())
    response = client.post(
        "/api/v1/mcp/scoped-export",
        headers={"Authorization": "Bearer hdk_demo"},
        json={
            "grant_ref": "req_0123456789abcdef0123456789ab",
            "expected_scope": "attr.financial.portfolio.*",
        },
    )
    assert response.status_code == 404
    assert response.json()["detail"]["error_code"] == "GRANT_NOT_FOUND"


def test_public_profile_export_returns_safe_projection_and_audits(monkeypatch):
    audit_event: dict[str, object] = {}

    class _FakePkmService:
        async def get_public_profile_projection(self, *, user_id: str, public_profile_handle: str):
            assert user_id == "user_123"
            assert public_profile_handle == "profile_opaque_123"
            return {
                "domain": "financial",
                "top_level_scope_path": "portfolio",
                "projection_payload": {"portfolio": {"summary": {"total_value": 1656064.53}}},
                "projection_hash": "sha256:projection",
                "projection_version": 1,
                "updated_at": "2026-05-21T10:01:00Z",
            }

    class _FakeConsentDBService:
        async def insert_internal_event(self, **kwargs):
            audit_event.update(kwargs)
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
        "/api/v1/public-profile-export",
        headers={"Authorization": "Bearer hdk_demo"},
        json={"user_id": "user_123", "public_profile_handle": "profile_opaque_123"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "success"
    assert payload["projection_payload"] == {"portfolio": {"summary": {"total_value": 1656064.53}}}
    assert payload["projection_hash"] == "sha256:projection"
    assert payload["app_id"] == "app_demo_123"
    assert audit_event["action"] == "PUBLIC_PROFILE_READ"
    assert audit_event["scope"] == "public_profile:profile_opaque_123"
    assert audit_event["metadata"]["projection_hash"] == "sha256:projection"


def test_scoped_export_returns_envelope_metadata_and_resource_link(monkeypatch):
    consent_token = "token_existing_1234"  # noqa: S105 - test fixture token id

    class _FakeConsentDBService:
        async def get_consent_export(self, token_id: str):
            assert token_id == consent_token
            return {
                "scope": "attr.financial.*",
                "encrypted_data": "ciphertext",
                "iv": "iv",
                "tag": "tag",
                "wrapped_key_bundle": {
                    "wrapped_export_key": "wrapped",
                    "wrapped_key_iv": "wrapped_iv",
                    "wrapped_key_tag": "wrapped_tag",
                    "sender_public_key": "sender_key",
                    "wrapping_alg": _CONNECTOR_WRAPPING_ALG,
                    "connector_key_id": _CONNECTOR_KEY_ID,
                },
                "export_revision": 7,
                "export_generated_at": datetime(2026, 3, 24, 18, 30, 0, tzinfo=timezone.utc),
                "refresh_status": "current",
                "is_strict_zero_knowledge": True,
                "envelope_version": 2,
                "export_id": "123e4567-e89b-12d3-a456-426614174000",
                "grant_id": "req_existing_1234",
                "app_id": "app_demo_123",
                "scope_handle": "s_financial_123",
                "recipient_key_fingerprint": f"sha256:{'a' * 64}",
                "payload_algorithm": "AES-256-GCM",
                "envelope_aad": {"version": 2},
                "envelope_aad_sha256": f"sha256:{'b' * 64}",
                "ciphertext_sha256": f"sha256:{'c' * 64}",
                "ciphertext_bytes": 10,
            }

    async def _validate(token: str, expected_scope=None):  # noqa: ANN001
        assert token == consent_token
        assert expected_scope == "attr.financial.profile.*"
        return (
            True,
            None,
            SimpleNamespace(
                user_id="user_123",
                agent_id="developer:app_demo_123",
                scope_str="attr.financial.*",
                scope=SimpleNamespace(value="attr.financial.*"),
                expires_at=123456789,
            ),
        )

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(developer, "validate_token_with_db", _validate)
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )

    client = TestClient(_build_app())
    response = client.post(
        "/api/v1/scoped-export?token=hdk_demo",
        json={
            "user_id": "user_123",
            "consent_token": consent_token,
            "expected_scope": "attr.financial.profile.*",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "success"
    assert payload["granted_scope"] == "attr.financial.*"
    assert payload["expected_scope"] == "attr.financial.profile.*"
    assert payload["coverage_kind"] == "superset"
    assert payload["export_generated_at"] == "2026-03-24 18:30:00+00:00"
    assert payload["encrypted_data"] is None
    assert payload["wrapped_key_bundle"]["connector_key_id"] == _CONNECTOR_KEY_ID
    assert payload["resource_link"]["uri"].endswith(
        "/api/v1/scoped-export/resources/123e4567-e89b-12d3-a456-426614174000/revisions/7"
    )
    assert payload["export_envelope"]["ciphertext_bytes"] == 10
    assert "data" not in payload


def test_scoped_export_invalidates_legacy_export(monkeypatch):
    invalidated = {"called": False}
    consent_token = "legacy_token_12345"  # noqa: S105 - test fixture token id

    class _FakeConsentDBService:
        async def get_consent_export(self, token_id: str):
            assert token_id == consent_token
            return {
                "scope": "attr.financial.*",
                "encrypted_data": "ciphertext",
                "iv": "iv",
                "tag": "tag",
                "is_strict_zero_knowledge": False,
            }

        async def invalidate_legacy_active_token(self, token_row):
            invalidated["called"] = True
            assert token_row["token_id"] == consent_token
            return True

    async def _validate(token: str, expected_scope=None):  # noqa: ANN001
        assert token == consent_token
        assert expected_scope == "attr.financial.*"
        return (
            True,
            None,
            SimpleNamespace(
                user_id="user_123",
                agent_id="developer:app_demo_123",
                scope_str="attr.financial.*",
                scope=SimpleNamespace(value="attr.financial.*"),
                expires_at=123456789,
            ),
        )

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(developer, "validate_token_with_db", _validate)
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )

    client = TestClient(_build_app())
    response = client.post(
        "/api/v1/scoped-export?token=hdk_demo",
        json={
            "user_id": "user_123",
            "consent_token": consent_token,
            "expected_scope": "attr.financial.*",
        },
    )

    assert response.status_code == 410
    payload = response.json()
    assert payload["detail"]["error_code"] == "LEGACY_EXPORT_INVALIDATED"
    assert invalidated["called"] is True


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
            "connector_key_id": _CONNECTOR_KEY_ID,
            "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
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

        async def resolve_metadata_index(self, user_id: str):
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
            "connector_key_id": _CONNECTOR_KEY_ID,
            "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
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


# ===========================================================================
# _STATIC_REQUESTABLE_SCOPES and _is_supported_scope unit tests
# ===========================================================================


def test_static_requestable_scopes_has_no_duplicates():
    scopes_list = list(_STATIC_REQUESTABLE_SCOPES)
    assert len(scopes_list) == len(set(scopes_list)), (
        "Duplicate entries in _STATIC_REQUESTABLE_SCOPES"
    )


def test_static_requestable_scopes_is_frozenset():
    assert isinstance(_STATIC_REQUESTABLE_SCOPES, frozenset)


def test_is_supported_scope_rejects_internal_pkm_read():
    assert _is_supported_scope("pkm.read") is False


def test_is_supported_scope_rejects_internal_pkm_write():
    assert _is_supported_scope("pkm.write") is False


def test_is_supported_scope_accepts_cap_one_invoke():
    assert _is_supported_scope("cap.one.invoke") is True
    assert _is_supported_scope("agent.one.orchestrate") is False


def test_is_supported_scope_accepts_dynamic_attr_scope():
    assert _is_supported_scope("attr.financial.holdings.*") is True
    assert _is_supported_scope("attr.food.preferences.*") is True
    assert _is_supported_scope("attr.financial.holdings") is False
    assert _is_supported_scope("attr.food.*") is False


def test_is_supported_scope_rejects_unknown_static_scope():
    assert _is_supported_scope("vault.owner") is False


def test_is_supported_scope_rejects_empty_string():
    assert _is_supported_scope("") is False


def test_is_supported_scope_rejects_arbitrary_string():
    assert _is_supported_scope("admin.all") is False

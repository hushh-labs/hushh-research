from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import developer_auth
from api.routes import developer
from hushh_mcp.services.developer_oauth_service import (
    DeveloperOAuthService,
    OAuthClient,
    OAuthValidationError,
    append_oauth_parameters,
    normalize_redirect_uri,
)
from hushh_mcp.services.developer_registry_service import DeveloperPrincipal


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(developer.router)
    app.dependency_overrides[developer.require_firebase_auth] = lambda: "firebase_test_subject"
    return app


def _client() -> OAuthClient:
    return OAuthClient(
        app_id="app_demo",
        client_id="hco_demo_client",
        client_secret_prefix="hcs_demo",  # noqa: S106 - non-secret fixture prefix
        redirect_uris=("https://connector.example.test/callback",),
        created_at=1,
        secret_rotated_at=1,
    )


class _OAuthService:
    issued_code = "hca_test_code"
    exchanged: dict[str, str] | None = None

    def get_client(self, client_id: str):
        return _client() if client_id == "hco_demo_client" else None

    def begin_authorization(self, **kwargs):
        if kwargs["redirect_uri"] != "https://connector.example.test/callback":
            raise OAuthValidationError(
                "invalid_request", "redirect_uri is not registered for this client."
            )
        return "oar_0123456789abcdef0123456789abcdef"

    def approve_authorization(self, **_kwargs):
        return self.issued_code

    def authorization_redirect(self, **_kwargs):
        return {"redirect_uri": "https://connector.example.test/callback", "state": ""}

    def deny_authorization(self, **_kwargs):
        return {"redirect_uri": "https://connector.example.test/callback", "state": "state_1"}

    def verify_client_secret(self, **kwargs):
        if kwargs.get("client_secret") != "secret":
            raise OAuthValidationError("invalid_client", "Client authentication failed.")
        return _client()

    def exchange_authorization_code(self, **kwargs):
        self.__class__.exchanged = kwargs
        if kwargs["code_verifier"] != "v" * 43:
            raise OAuthValidationError("invalid_grant", "Authorization code validation failed.")
        return {
            "access_token": "hdo_at_test",
            "refresh_token": "hdo_rt_test",
            "token_type": "Bearer",
            "expires_in": 3600,
            "scope": "mcp:tools",
        }

    def refresh(self, **kwargs):
        if kwargs["refresh_token"] == "replayed":
            raise OAuthValidationError("invalid_grant", "Refresh token validation failed.")
        return {
            "access_token": "hdo_at_new",
            "refresh_token": "hdo_rt_new",
            "token_type": "Bearer",
            "expires_in": 3600,
            "scope": "mcp:tools",
        }

    def revoke(self, **_kwargs):
        return None


def test_redirect_uri_validation_is_exact_and_safe():
    assert (
        normalize_redirect_uri("https://Connector.Example.test/callback")
        == "https://connector.example.test/callback"
    )
    assert (
        normalize_redirect_uri("http://127.0.0.1:4545/callback") == "http://127.0.0.1:4545/callback"
    )
    for invalid in (
        "http://connector.example.test/callback",
        "https://connector.example.test/callback#fragment",
        "https://user:pass@connector.example.test/callback",
    ):
        try:
            normalize_redirect_uri(invalid)
        except OAuthValidationError as error:
            assert error.code == "invalid_request"
        else:  # pragma: no cover - assertion control flow
            raise AssertionError("unsafe redirect URI was accepted")


def test_authorize_rejects_non_s256_and_unregistered_redirect(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "DeveloperOAuthService", _OAuthService)
    client = TestClient(_app())
    base = {
        "response_type": "code",
        "client_id": "hco_demo_client",
        "redirect_uri": "https://connector.example.test/callback",
        "code_challenge": "a" * 43,
        "state": "state_1",
    }
    response = client.get("/oauth/authorize", params={**base, "code_challenge_method": "plain"})
    assert response.status_code == 400
    assert response.json()["detail"]["error"] == "unsupported_response_type"
    response = client.get(
        "/oauth/authorize",
        params={
            **base,
            "redirect_uri": "https://attacker.example/callback",
            "code_challenge_method": "S256",
        },
    )
    assert response.status_code == 400
    assert response.json()["detail"]["error"] == "invalid_request"


def test_pkce_values_must_be_url_safe_before_storage():
    service = DeveloperOAuthService.__new__(DeveloperOAuthService)
    service.get_client = lambda _client_id: _client()  # type: ignore[method-assign]
    with pytest.raises(OAuthValidationError) as error:
        service.begin_authorization(
            client_id="hco_demo_client",
            redirect_uri="https://connector.example.test/callback",
            code_challenge="+" * 43,
            state=None,
            scope="mcp:tools",
        )
    assert error.value.code == "invalid_request"


def test_authorization_approval_and_pkce_exchange_contract(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "DeveloperOAuthService", _OAuthService)
    client = TestClient(_app())
    response = client.post("/oauth/authorize/oar_0123456789abcdef0123456789abcdef/approve")
    assert response.status_code == 200
    assert (
        response.json()["redirect_uri"]
        == "https://connector.example.test/callback?code=hca_test_code"
    )

    bad = client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "client_id": "hco_demo_client",
            "client_secret": "secret",
            "code": "hca_test_code",
            "redirect_uri": "https://connector.example.test/callback",
            "code_verifier": "wrong",
        },
    )
    assert bad.status_code == 400
    assert bad.json()["detail"]["error"] == "invalid_grant"

    good = client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "client_id": "hco_demo_client",
            "client_secret": "secret",
            "code": "hca_test_code",
            "redirect_uri": "https://connector.example.test/callback",
            "code_verifier": "v" * 43,
        },
    )
    assert good.status_code == 200
    assert good.json()["token_type"] == "Bearer"
    assert _OAuthService.exchanged is not None


def test_refresh_replay_and_revoke_contract(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "DeveloperOAuthService", _OAuthService)
    client = TestClient(_app())
    replay = client.post(
        "/oauth/token",
        data={
            "grant_type": "refresh_token",
            "client_id": "hco_demo_client",
            "client_secret": "secret",
            "refresh_token": "replayed",
        },
    )
    assert replay.status_code == 400
    assert replay.json()["detail"]["error"] == "invalid_grant"
    revoke = client.post(
        "/oauth/revoke",
        data={"client_id": "hco_demo_client", "client_secret": "secret", "token": "hdo_rt_old"},
    )
    assert revoke.status_code == 200


def test_oauth_bearer_principal_precedes_legacy_registry(monkeypatch):
    principal = DeveloperPrincipal(
        app_id="app_demo",
        agent_id="developer:app_demo",
        display_name="Demo",
        allowed_tool_groups=("core_consent",),
        auth_source="oauth",
    )
    monkeypatch.setattr(
        developer_auth.DeveloperOAuthService,
        "authenticate_access_token",
        lambda *_args, **_kwargs: principal,
    )
    monkeypatch.setattr(
        developer_auth.DeveloperRegistryService,
        "authenticate_token",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("legacy lookup must not run")
        ),
    )
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    assert (
        developer_auth.authenticate_developer_principal(
            authorization="Bearer hdo_at_test"
        ).auth_source
        == "oauth"
    )


def test_oauth_client_metadata_has_no_raw_secret():
    client = _client()
    payload = developer._serialize_oauth_client(client)
    assert payload is not None
    assert payload.raw_client_secret is None
    assert "secret" not in payload.model_dump(exclude_none=True)
    assert append_oauth_parameters(
        client.redirect_uris[0], {"code": "opaque", "state": "s"}
    ).startswith(client.redirect_uris[0])


def test_oauth_migration_is_in_the_developer_release_lane():
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / "db/release_migration_manifest.json").read_text())
    uat = json.loads((root / "db/contracts/uat_integrated_schema.json").read_text())
    assert "099_developer_oauth_pkce.sql" in manifest["ordered_migrations"]
    assert "099_developer_oauth_pkce.sql" in manifest["groups"]["developer"]
    assert uat["expected_migration_version"] == 105

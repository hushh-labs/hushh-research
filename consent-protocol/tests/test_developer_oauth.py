from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, call

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

    def issue_client_credentials(self, **kwargs):
        assert kwargs["scope"] == "mcp:tools"
        return {
            "access_token": "hdo_at_service",
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
    assert response.json()["error"] == "unsupported_response_type"
    response = client.get(
        "/oauth/authorize",
        params={
            **base,
            "redirect_uri": "https://attacker.example/callback",
            "code_challenge_method": "S256",
        },
    )
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"


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
        == "https://connector.example.test/callback?code=hca_test_code&iss=http%3A%2F%2Ftestserver"
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
    assert bad.json()["error"] == "invalid_grant"

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


def test_client_credentials_is_advertised_and_returns_no_refresh_token(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "DeveloperOAuthService", _OAuthService)
    client = TestClient(_app())
    metadata = client.get("/.well-known/oauth-authorization-server")
    assert metadata.status_code == 200
    assert "client_credentials" in metadata.json()["grant_types_supported"]
    response = client.post(
        "/oauth/token",
        data={
            "grant_type": "client_credentials",
            "client_id": "hco_demo_client",
            "client_secret": "secret",
            "scope": "mcp:tools",
        },
    )
    assert response.status_code == 200
    assert response.json()["access_token"] == "hdo_at_service"
    assert "refresh_token" not in response.json()


def test_client_credentials_requires_explicit_partner_grant_configuration():
    service = DeveloperOAuthService.__new__(DeveloperOAuthService)
    service._registry = MagicMock()  # type: ignore[attr-defined]
    service._issue_tokens = MagicMock(  # type: ignore[method-assign]
        return_value={"access_token": "hdo_at_service", "token_type": "Bearer"}
    )
    service._audit = MagicMock()  # type: ignore[method-assign]
    service._registry.get_app.return_value = {
        "status": "active",
        "kind": "partner_crm",
        "oauth_client_credentials_enabled": True,
    }
    with pytest.raises(OAuthValidationError) as blocked:
        service.issue_client_credentials(client=_client(), scope="mcp:tools")
    assert blocked.value.code == "unauthorized_client"

    service._registry.get_app.return_value = {
        "status": "active",
        "kind": "partner_crm",
        "oauth_client_credentials_enabled": True,
    }
    connector_client = OAuthClient(
        **{**_client().__dict__, "allowed_grant_types": ("client_credentials",)}
    )
    assert service.issue_client_credentials(client=connector_client, scope="mcp:tools") == {
        "access_token": "hdo_at_service",
        "token_type": "Bearer",
    }
    catalog_only_client = OAuthClient(
        **{**connector_client.__dict__, "mcp_execution_mode": "catalog_only"}
    )
    assert service.issue_client_credentials(client=catalog_only_client, scope="mcp:tools") == {
        "access_token": "hdo_at_service",
        "token_type": "Bearer",
    }
    service._registry.get_app.return_value = {
        "status": "active",
        "kind": "partner_crm",
        "oauth_client_credentials_enabled": True,
    }
    assert service.issue_client_credentials(client=connector_client, scope="mcp:tools") == {
        "access_token": "hdo_at_service",
        "token_type": "Bearer",
    }
    assert service._issue_tokens.call_args_list == [
        call(
            app_id="app_demo",
            subject=None,
            authorization_id=None,
            scopes=("mcp:tools",),
            include_refresh_token=False,
            grant_type="client_credentials",
            mcp_execution_mode="execute",
        ),
        call(
            app_id="app_demo",
            subject=None,
            authorization_id=None,
            scopes=("mcp:tools",),
            include_refresh_token=False,
            grant_type="client_credentials",
            mcp_execution_mode="catalog_only",
        ),
        call(
            app_id="app_demo",
            subject=None,
            authorization_id=None,
            scopes=("mcp:tools",),
            include_refresh_token=False,
            grant_type="client_credentials",
            mcp_execution_mode="execute",
        ),
    ]


def test_client_policy_update_preserves_secret_and_existing_tokens(monkeypatch):
    service = DeveloperOAuthService.__new__(DeveloperOAuthService)
    service.ensure_tables = MagicMock()  # type: ignore[method-assign]
    service._db = MagicMock()  # type: ignore[attr-defined]
    service._audit = MagicMock()  # type: ignore[method-assign]
    existing = OAuthClient(
        app_id="app_demo",
        client_id="hco_demo_client",
        client_secret_prefix="hcs_prefix",  # noqa: S106 - synthetic prefix fixture
        redirect_uris=("https://claude.ai/api/mcp/auth_callback",),
        created_at=1,
        secret_rotated_at=1,
    )
    updated = OAuthClient(
        **{
            **existing.__dict__,
            "allowed_grant_types": ("authorization_code", "refresh_token", "client_credentials"),
            "mcp_execution_mode": "catalog_only",
        }
    )
    service.get_client_for_app = MagicMock(return_value=existing)  # type: ignore[method-assign]
    service.get_client = MagicMock(return_value=updated)  # type: ignore[method-assign]

    result = service.update_client_policy(
        app_id="app_demo",
        allowed_grant_types=("authorization_code", "refresh_token", "client_credentials"),
        mcp_execution_mode="catalog_only",
    )

    assert result == updated
    statement, params = service._db.execute_raw.call_args.args
    assert "client_secret" not in statement
    assert params["grant_types"] == '["authorization_code", "refresh_token", "client_credentials"]'
    assert params["execution_mode"] == "catalog_only"
    service._audit.assert_called_once_with(
        app_id="app_demo",
        client_id="hco_demo_client",
        subject=None,
        event="oauth_client_policy_updated",
    )


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
    assert replay.json()["error"] == "invalid_grant"
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
    # Contract head advances as new migrations land; assert it still covers the
    # executable client-credentials migration rather than pinning an exact version.
    assert uat["expected_migration_version"] >= 109
    assert "109_oauth_client_credentials_consent_execution.sql" in manifest["ordered_migrations"]
    assert "109_oauth_client_credentials_consent_execution.sql" in manifest["groups"]["developer"]
    assert "407_mcp_oauth_client_registration.sql" in manifest["groups"]["developer"]
    assert "407_mcp_oauth_client_registration.sql" in manifest["ordered_migrations"]


@pytest.fixture
def registration_service(tmp_path, monkeypatch):
    from sqlalchemy import create_engine

    from db.db_client import DatabaseClient
    from hushh_mcp.services.developer_registry_service import DeveloperRegistryService

    monkeypatch.setenv("DB_OFFLINE", "1")
    monkeypatch.setenv("CONSENT_API_PUBLIC_ORIGIN", "https://api.example.test")
    engine = create_engine(f"sqlite:///{tmp_path / 'oauth.db'}")
    raw = engine.raw_connection()
    raw.driver_connection.executescript(
        (Path(__file__).parents[1] / "db/offline_schema.sql").read_text()
    )
    raw.close()
    service = DeveloperOAuthService.__new__(DeveloperOAuthService)
    service._db = DatabaseClient(engine)
    service._registry = DeveloperRegistryService.__new__(DeveloperRegistryService)
    service._registry._db = service._db
    monkeypatch.setattr(DeveloperRegistryService, "_tables_ensured", True)
    monkeypatch.setattr(DeveloperOAuthService, "_tables_ensured", False)
    service.ensure_tables()
    yield service
    engine.dispose()


def _public_metadata(**overrides):
    return {
        "client_name": "Synthetic connector",
        "redirect_uris": ["https://connector.example.test/callback"],
        "grant_types": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_method": "none",
        **overrides,
    }


def test_dcr_isolates_clients_and_does_not_grant_information_authority(registration_service):
    from hushh_mcp.services.oauth_client_registration import OAuthClientRegistration

    service = registration_service
    registration = OAuthClientRegistration(service)
    first = registration.register(_public_metadata())
    second = registration.register(_public_metadata())
    a = service.get_client(first["client_id"])
    b = service.get_client(second["client_id"])
    assert a.app_id != b.app_id
    assert "client_secret" not in first
    assert service.get_client(first["client_id"]) == a  # no rotation on another registration
    app = service._registry.get_app(a.app_id)
    assert app["kind"] == "oauth_dynamic"
    assert app["owner_firebase_uid"] is None
    assert not app["oauth_client_credentials_enabled"]
    assert json.loads(app["allowed_capabilities"]) == []
    assert service._db.execute_raw("SELECT * FROM developer_connector_keys", {}).data == []
    assert service._db.execute_raw("SELECT * FROM developer_oauth_tokens", {}).data == []
    with pytest.raises(OAuthValidationError, match="not enabled"):
        service.issue_client_credentials(client=a)
    with pytest.raises(OAuthValidationError):
        registration.register(
            _public_metadata(grant_types=["authorization_code", "client_credentials"])
        )


def test_public_pkce_resource_and_refresh_tokens_remain_client_bound(registration_service):
    import base64
    import hashlib

    from hushh_mcp.services.oauth_client_registration import OAuthClientRegistration

    service = registration_service
    registration = OAuthClientRegistration(service)
    a = service.get_client(registration.register(_public_metadata())["client_id"])
    b = service.get_client(registration.register(_public_metadata())["client_id"])
    verifier = "v" * 43
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    )
    resource = "https://api.example.test/mcp/"
    kwargs = dict(
        client_id=a.client_id,
        redirect_uri=a.redirect_uris[0],
        code_challenge=challenge,
        scope="mcp:tools",
        state="synthetic-state",
        resource=resource,
    )
    with pytest.raises(OAuthValidationError):
        service.begin_authorization(
            **{**kwargs, "redirect_uri": "https://CONNECTOR.example.test/callback"}
        )
    reference = service.begin_authorization(**kwargs)
    code = service.approve_authorization(
        transaction_ref=reference, subject_firebase_uid="synthetic-owner"
    )
    exchange = dict(
        client=a,
        code=code,
        redirect_uri=a.redirect_uris[0],
        code_verifier=verifier,
        resource=resource,
    )
    with pytest.raises(OAuthValidationError):
        service.exchange_authorization_code(**{**exchange, "client": b})
    with pytest.raises(OAuthValidationError):
        service.exchange_authorization_code(
            **{**exchange, "resource": "https://other.example/mcp/"}
        )
    with pytest.raises(OAuthValidationError):
        service.exchange_authorization_code(**{**exchange, "code_verifier": "x" * 43})
    tokens = service.exchange_authorization_code(**exchange)
    with pytest.raises(OAuthValidationError):
        service.exchange_authorization_code(**exchange)
    assert service.authenticate_access_token(tokens["access_token"]).app_id == a.app_id
    with pytest.raises(OAuthValidationError):
        service.refresh(client=b, refresh_token=tokens["refresh_token"])
    with pytest.raises(OAuthValidationError):
        service.refresh(
            client=a, refresh_token=tokens["refresh_token"], resource="https://other.example/mcp/"
        )
    refreshed = service.refresh(client=a, refresh_token=tokens["refresh_token"])
    service.revoke(client=b, token=refreshed["access_token"])
    assert service.authenticate_access_token(refreshed["access_token"]) is not None
    with pytest.raises(OAuthValidationError):
        service.refresh(client=a, refresh_token=tokens["refresh_token"])
    assert service.authenticate_access_token(refreshed["access_token"]) is None
    with pytest.raises(OAuthValidationError):
        service.refresh(client=a, refresh_token=refreshed["refresh_token"])


def test_dcr_confidential_auth_never_accepts_missing_secret(registration_service):
    from hushh_mcp.services.oauth_client_registration import OAuthClientRegistration

    service = registration_service
    registered = OAuthClientRegistration(service).register(
        _public_metadata(**{"token_endpoint_auth_method": "client_secret_post"})
    )
    assert service.verify_client_secret(
        client_id=registered["client_id"], client_secret=registered["client_secret"]
    )
    with pytest.raises(OAuthValidationError):
        service.verify_client_secret(client_id=registered["client_id"], client_secret=None)
    with pytest.raises(OAuthValidationError):
        service.verify_client_secret(client_id=registered["client_id"], client_secret="wrong")  # noqa: S106 - negative credential fixture


@pytest.mark.asyncio
async def test_cimd_validates_identity_and_refreshes_callbacks_without_rotating(
    registration_service, monkeypatch
):
    import httpx

    from hushh_mcp.services import oauth_client_registration as registration

    client_id = "https://client.example.test/oauth/client.json"
    document = {
        **_public_metadata(),
        "client_id": client_id,
        "grant_types": [
            "authorization_code",
            "refresh_token",
            "urn:ietf:params:oauth:grant-type:jwt-bearer",
        ],
        "token_endpoint_auth_method": "private_key_jwt",
        "token_endpoint_auth_methods_supported": ["none", "private_key_jwt"],
    }

    def client_factory(**kwargs):
        assert kwargs["max_response_bytes"] == registration.MAX_METADATA_BYTES
        return httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request: httpx.Response(200, json=document)),
            follow_redirects=False,
        )

    monkeypatch.setattr(registration, "create_public_mcp_http_client", client_factory)
    resolver = registration.OAuthClientRegistration(registration_service)
    first = await resolver.resolve(client_id)
    assert first.token_endpoint_auth_method == "none"
    assert first.allowed_grant_types == ("authorization_code", "refresh_token")
    document["redirect_uris"] = ["https://connector.example.test/updated"]
    second = await resolver.resolve(client_id)
    assert second.app_id == first.app_id
    assert second.redirect_uris == tuple(document["redirect_uris"])
    assert second.created_at == first.created_at
    document["client_id"] = "https://different.example.test/client.json"
    with pytest.raises(OAuthValidationError):
        await resolver.resolve(client_id)
    # Rejected metadata never updates the stored, last validated callbacks.
    assert registration_service.get_client(client_id) == second


@pytest.mark.asyncio
async def test_cimd_refuses_unsafe_urls_redirects_and_secret_auth(monkeypatch):
    import httpx

    from hushh_mcp.services import oauth_client_registration as registration

    def forbidden_factory(**_kwargs):
        raise AssertionError("Unsafe URL must not reach HTTP client")

    monkeypatch.setattr(registration, "create_public_mcp_http_client", forbidden_factory)
    for value in (
        "https://127.0.0.1/client.json",
        "https://a.local/client.json",
        "http://example.test/client.json",
        "https://example.test/../client.json",
    ):
        with pytest.raises(OAuthValidationError):
            await registration.fetch_client_metadata(value)
    monkeypatch.setattr(
        registration,
        "create_public_mcp_http_client",
        lambda **kwargs: httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    302, headers={"Location": "https://other.example/client.json"}
                )
            )
        ),
    )
    with pytest.raises(OAuthValidationError):
        await registration.fetch_client_metadata("https://example.test/client.json")
    with pytest.raises(OAuthValidationError):
        registration.validate_client_metadata(
            _public_metadata(**{"token_endpoint_auth_method": "client_secret_basic"}), cimd=True
        )


def test_registration_and_discovery_wire_contract(registration_service, monkeypatch):
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setattr(developer, "DeveloperOAuthService", lambda: registration_service)
    client = TestClient(_app())
    metadata = client.get("/.well-known/oauth-authorization-server").json()
    assert metadata["client_id_metadata_document_supported"] is True
    assert metadata["registration_endpoint"] == "https://api.example.test/oauth/register"
    assert "none" in metadata["token_endpoint_auth_methods_supported"]
    resource = client.get("/.well-known/oauth-protected-resource").json()
    assert resource["resource"] == "https://api.example.test/mcp/"
    assert resource["authorization_servers"] == [metadata["issuer"]]
    registered = client.post("/oauth/register", json=_public_metadata())
    assert registered.status_code == 201
    assert registered.headers["cache-control"] == "no-store"
    assert (
        client.post(
            "/oauth/register", json=_public_metadata(grant_types=["client_credentials"])
        ).status_code
        == 400
    )
    assert client.post("/oauth/register", content=b"x" * 6000).status_code == 413
    assert (
        client.post("/oauth/register", content="invalid").json()["error"]
        == "invalid_client_metadata"
    )


def test_public_client_oauth_http_exchange_requires_pkce_and_resource(
    registration_service, monkeypatch
):
    import base64
    import hashlib
    from urllib.parse import parse_qs, urlsplit

    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setattr(developer, "DeveloperOAuthService", lambda: registration_service)
    client = TestClient(_app())
    registered = client.post("/oauth/register", json=_public_metadata()).json()
    verifier = "v" * 43
    resource = "https://api.example.test/mcp/"
    params = dict(
        response_type="code",
        client_id=registered["client_id"],
        redirect_uri=registered["redirect_uris"][0],
        code_challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .decode()
        .rstrip("="),
        code_challenge_method="S256",
        state="synthetic-state",
        resource=resource,
    )
    wrong = client.get(
        "/oauth/authorize", params={**params, "resource": "https://other.example/mcp/"}
    )
    assert wrong.json()["error"] == "invalid_target"
    authorization = client.get("/oauth/authorize", params=params, follow_redirects=False)
    assert authorization.status_code == 303
    reference = parse_qs(urlsplit(authorization.headers["location"]).query)["request"][0]
    review = client.get(f"/oauth/authorize/{reference}")
    assert review.status_code == 200
    assert review.json()["client_id"] == registered["client_id"]
    assert review.json()["redirect_host"] == "connector.example.test"
    assert review.headers["cache-control"] == "no-store"
    approved = client.post(f"/oauth/authorize/{reference}/approve")
    assert client.get(f"/oauth/authorize/{reference}").status_code == 400
    returned = parse_qs(urlsplit(approved.json()["redirect_uri"]).query)
    assert returned["iss"] == ["https://api.example.test"]
    form = dict(
        grant_type="authorization_code",
        client_id=registered["client_id"],
        code=returned["code"][0],
        code_verifier=verifier,
        redirect_uri=params["redirect_uri"],
        resource=resource,
    )
    assert (
        client.post(
            "/oauth/token", data={**form, "resource": "https://other.example/mcp/"}
        ).status_code
        == 400
    )
    assert client.post("/oauth/token", data={**form, "code_verifier": "wrong"}).status_code == 400
    token = client.post("/oauth/token", data=form)
    assert token.status_code == 200
    assert token.headers["cache-control"] == "no-store"
    assert token.json()["scope"] == "mcp:tools"
    assert (
        registration_service.authenticate_access_token(token.json()["access_token"]).kind
        == "oauth_dynamic"
    )
    assert client.post("/oauth/token", data=form).status_code == 400

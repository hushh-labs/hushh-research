from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import developer, developer_oauth
from hushh_mcp.services.developer_oauth_service import (
    DeveloperOAuthService,
    OAuthValidationError,
)


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(developer.router)
    app.dependency_overrides[developer.require_firebase_auth] = lambda: "firebase_test_subject"
    return app


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
    monkeypatch.setattr(developer_oauth, "DeveloperOAuthService", lambda: registration_service)
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
    monkeypatch.setattr(developer_oauth, "DeveloperOAuthService", lambda: registration_service)
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

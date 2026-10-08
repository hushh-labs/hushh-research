from __future__ import annotations

from functools import partial
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from urllib.parse import parse_qs, urlparse
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes import external_connectors as routes
from hushh_mcp.services import external_connector_oauth_service as generic_oauth
from hushh_mcp.services.external_connector_curated_oauth import CuratedConnectorOAuthError
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_connector_oauth_service import (
    ExternalConnectorOAuthError,
    ExternalConnectorOAuthService,
)
from hushh_mcp.services.external_connector_registry_service import (
    ConnectorRegistrationError,
    ExternalMcpConnectorDefinition,
)


def test_review_configuration_is_transient_and_rejects_refresh_tokens():
    from pydantic import ValidationError

    configuration = {
        "version": 1,
        "connectorId": "custom_" + "a" * 32,
        "revision": "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        "displayName": "Synthetic",
        "endpoint": "https://example.com/mcp",
        "enabled": True,
        "authentication": {
            "kind": "oauth",
            "accessToken": "synthetic-access",
            "expiresAt": 4070908800,
        },
    }
    payload = dict(
        conversationId="thread",
        toolName="mcp_" + "a" * 40,
        arguments={},
        connectorConfiguration=configuration,
    )
    model = routes.McpReviewRequest(**payload)
    assert "connectorConfiguration" not in model.model_dump()
    assert "synthetic-access" not in repr(model)
    configuration["authentication"]["refreshToken"] = "synthetic-refresh"
    with pytest.raises(ValidationError):
        routes.McpReviewRequest(**payload)


def test_private_oauth_begin_requires_owner_and_fixed_return(route_client, monkeypatch):
    client, app, _ = route_client
    path = "/api/connectors/custom_" + "a" * 32 + "/mcp/oauth/begin"
    body = {
        "revision": "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        "endpoint": "https://mcp.example/mcp",
    }
    assert client.post(path, json=body).status_code == 401
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    monkeypatch.setattr(
        routes,
        "get_app_runtime_settings",
        lambda: SimpleNamespace(
            environment="production", app_frontend_origin="https://app.example"
        ),
    )
    begin = AsyncMock(
        return_value={"attemptId": "a" * 43, "authorizeUrl": "https://auth.example/start"}
    )
    monkeypatch.setattr(routes.mcp_oauth_attempts, "begin", begin)
    response = client.post(path, json=body)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert (
        response.json()["redirectUri"] == "https://app.example/one/profile/connectors/oauth/return"
    )
    assert begin.await_args.kwargs["owner_id"] == "owner"
    assert (
        begin.await_args.kwargs["redirect_uri"]
        == "https://app.example/one/profile/connectors/oauth/return"
    )
    assert (
        client.post(path, json={**body, "redirectUri": "https://evil.example"}).status_code == 422
    )
    assert client.post(path, content=b"x" * 64001).status_code == 413


def test_private_oauth_begin_binds_registered_client_to_fixed_redirect(route_client, monkeypatch):
    client, app, _ = route_client
    path = "/api/connectors/custom_" + "a" * 32 + "/mcp/oauth/begin"
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    monkeypatch.setattr(
        routes,
        "get_app_runtime_settings",
        lambda: SimpleNamespace(
            environment="production",
            app_frontend_origin="https://app.example",
        ),
    )
    begin = AsyncMock(
        return_value={"attemptId": "a" * 43, "authorizeUrl": "https://auth.example/start"}
    )
    monkeypatch.setattr(routes.mcp_oauth_attempts, "begin", begin)
    body = {
        "revision": "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        "endpoint": "https://mcp.example/mcp",
        "registeredClient": {
            "issuer": "https://auth.example",
            "clientId": "synthetic-client",
            "clientSecret": "synthetic-client-secret",
            "tokenEndpointAuthMethod": "client_secret_post",
        },
    }
    assert client.post(path, json=body).status_code == 200
    kwargs = begin.await_args.kwargs
    assert kwargs["registered_issuer"] == "https://auth.example"
    assert [str(uri) for uri in kwargs["registered_client"].redirect_uris] == [
        "https://app.example/one/profile/connectors/oauth/return"
    ]
    assert kwargs["registered_client"].client_secret == "synthetic-client-secret"
    assert "synthetic-client-secret" not in repr(routes.McpOAuthBeginRequest(**body))
    assert (
        client.post(
            path,
            json={
                **body,
                "registeredClient": {
                    **body["registeredClient"],
                    "redirect_uris": ["https://evil.example"],
                },
            },
        ).status_code
        == 422
    )


def test_private_oauth_complete_is_private_and_sanitizes_failures(route_client, monkeypatch):
    client, app, _ = route_client
    path = "/api/connectors/custom_" + "a" * 32 + "/mcp/oauth/complete"
    body = {
        "revision": "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        "attemptId": "a" * 43,
        "code": "synthetic-code",
        "state": "synthetic-state",
    }
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    complete = AsyncMock(side_effect=ValueError("PRIVATE provider response"))
    monkeypatch.setattr(routes.mcp_oauth_attempts, "complete", complete)
    response = client.post(path, json=body)
    assert response.status_code == 409
    assert response.headers["cache-control"] == "no-store"
    assert "PRIVATE" not in response.text
    assert "synthetic-code" not in repr(routes.McpOAuthCompleteRequest(**body))


@pytest.mark.parametrize(
    "origin", ["", "http://app.example", "https://app.example/path", "https://a:b@app.example"]
)
def test_private_oauth_rejects_invalid_operator_return(origin, monkeypatch):
    from fastapi import HTTPException

    monkeypatch.setattr(
        routes,
        "get_app_runtime_settings",
        lambda: SimpleNamespace(environment="production", app_frontend_origin=origin),
    )
    with pytest.raises(HTTPException):
        routes._mcp_oauth_return_uri()


@pytest.fixture
def route_client(monkeypatch):
    drive = SimpleNamespace(
        connection_available=AsyncMock(return_value=True),
        complete=AsyncMock(return_value={"connectorId": "google_drive", "status": "verifying"}),
        complete_native=AsyncMock(
            return_value={"attemptId": "synthetic-attempt", "outcome": "ready"}
        ),
        pending_native=AsyncMock(return_value=None),
        lifecycle=SimpleNamespace(cancel_native=AsyncMock(return_value=True)),
    )

    def verify(state):
        if state != "signed-synthetic-state":
            raise ExternalConnectorOAuthError("OAuth state is invalid")
        return "synthetic-attempt"

    curated = SimpleNamespace(
        complete=AsyncMock(return_value={"connectorId": "notion", "status": "connected"})
    )
    service = SimpleNamespace(
        _verify_state=verify,
        drive=lambda: drive,
        curated=lambda: curated,
        _execute=AsyncMock(return_value=[{"connector_id": "google_drive"}]),
        _registry=SimpleNamespace(get_connector=AsyncMock(return_value=None)),
        complete=AsyncMock(side_effect=AssertionError("vault-only legacy path")),
    )
    # The real dispatcher runs against the fakes above, so the route's wiring
    # to the Drive/curated/refuse decision is what these tests exercise.
    service.complete_web_popup = partial(ExternalConnectorOAuthService.complete_web_popup, service)
    service.curated_adapter = curated
    monkeypatch.setattr(routes, "get_external_connector_oauth_service", lambda: service)
    app = FastAPI()
    app.include_router(routes.router)
    return TestClient(app), app, drive


def test_catalog_refresh_requires_owner_and_transient_configuration(route_client, monkeypatch):
    client, app, _ = route_client
    connector_id = "custom_" + "a" * 32
    path = f"/api/connectors/{connector_id}/mcp/catalog"
    assert client.post(path, json={}).status_code == 401
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": "owner",
        "token": "synthetic",
    }
    assert client.post(path, json={}).status_code == 400
    configuration = {
        "version": 1,
        "connectorId": connector_id,
        "revision": "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        "displayName": "Synthetic",
        "endpoint": "https://example.com/mcp",
        "enabled": True,
        "authentication": {"kind": "none"},
    }
    discover = AsyncMock(return_value={"connectorId": connector_id, "status": "empty", "tools": []})
    monkeypatch.setattr(routes.mcp_review_service, "discover_catalog", discover)
    response = client.post(path, json={"connectorConfiguration": configuration})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    discover.assert_awaited_once()
    assert discover.await_args.kwargs["configuration"] == configuration


def test_private_registration_derives_owner_and_never_echoes_secrets(route_client, monkeypatch):
    client, app, _ = route_client
    body = {
        "registrationId": "550e8400-e29b-41d4-a716-446655440000",
        "displayName": "Synthetic MCP",
        "endpoint": "https://mcp.example.com/mcp",
        "authStyle": "api_key",
    }
    assert client.post("/api/connectors/registrations", json=body).status_code == 401
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    definition = ExternalMcpConnectorDefinition.from_row(
        {
            "connector_id": "custom_synthetic",
            "display_name": "Synthetic MCP",
            "mcp_endpoint": body["endpoint"],
            "auth_style": "api_key",
            "user_id": "verified-owner",
            "owner_enabled": True,
        }
    )
    registry = SimpleNamespace(register_private=AsyncMock(return_value=definition))
    monkeypatch.setattr(routes, "get_external_connector_registry_service", lambda: registry)
    for extra in (
        {"userId": "another-owner"},
        {"apiKey": "synthetic-private-input"},
        {"capabilityPolicy": {"allow": "*"}},
    ):
        response = client.post("/api/connectors/registrations", json={**body, **extra})
        assert response.status_code == 422
        assert response.headers["cache-control"] == "no-store"
        assert "synthetic-private-input" not in response.text
    registry.register_private.assert_not_called()
    response = client.post("/api/connectors/registrations", json=body)
    assert response.status_code == 200
    assert response.json()["status"] == "not_connected"
    assert response.json()["registrationKind"] == "private"
    assert "endpoint" not in response.json()
    registry.register_private.assert_awaited_once_with(
        user_id="verified-owner",
        registration_id=UUID(body["registrationId"]),
        display_name=body["displayName"],
        endpoint=body["endpoint"],
        auth_style="api_key",
    )
    registry.register_private.side_effect = ConnectorRegistrationError(
        "connector_registry_unavailable", status_code=503
    )
    response = client.post("/api/connectors/registrations", json=body)
    assert response.status_code == 503 and response.headers["cache-control"] == "no-store"
    assert response.json()["detail"]["code"] == "connector_registry_unavailable"


def test_mcp_review_http_requires_owner_and_explicit_confirmation(route_client, monkeypatch):
    client, app, _ = route_client
    body = {
        "conversationId": "thread",
        "toolName": "mcp_" + "a" * 40,
        "arguments": {"q": "synthetic-private-query"},
    }
    base = "/api/connectors/custom_synthetic/mcp"
    prepare = AsyncMock(return_value={"status": "review_required"})
    confirm = AsyncMock(return_value={"status": "confirmed", "receipt": "synthetic-receipt"})
    monkeypatch.setattr(routes.mcp_review_service, "prepare_review", prepare)
    monkeypatch.setattr(routes.mcp_review_service, "confirm_review", confirm)
    response = client.post(base + "/review", json=body)
    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"
    prepare.assert_not_called()
    response = client.post(
        base + "/review",
        content=(b"x" * 16_001 for _ in range(4)),
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 413
    assert response.headers["cache-control"] == "no-store"
    assert len(response.text) < 200
    prepare.assert_not_called()
    token = {"user_id": "verified-owner", "token": "synthetic-owner-token"}
    app.dependency_overrides[require_vault_owner_token] = lambda: token
    oversized = client.post(base + "/review", json={**body, "arguments": {"q": "x" * 32_001}})
    assert oversized.status_code == 422
    assert len(oversized.text) < 200
    prepare.assert_not_called()
    response = client.post(base + "/review", json=body)
    assert response.status_code == 200
    assert prepare.await_args.kwargs["token"] is token
    assert prepare.await_args.kwargs["conversation_id"] == "thread"
    confirm_body = {**body, "directiveId": "dir_" + "b" * 32, "confirmed": True}
    for extra in (
        {"confirmed": False},
        {"confirmed": "true"},
        {"userId": "other"},
        {"schemaRevision": "forged"},
    ):
        response = client.post(base + "/confirm", json={**confirm_body, **extra})
        assert response.status_code in {400, 422}
        assert response.headers["cache-control"] == "no-store"
        assert "synthetic-private-query" not in response.text
    confirm.assert_not_called()
    response = client.post(base + "/confirm", json=confirm_body)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["receipt"] == "synthetic-receipt"
    assert confirm.await_args.kwargs["token"] is token


@pytest.mark.parametrize("kind,status", [("authority", 409), ("provider", 502), ("unknown", 503)])
def test_mcp_review_errors_never_echo_private_diagnostics(route_client, monkeypatch, kind, status):
    from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
    from hushh_mcp.services.external_mcp_client import ExternalMcpError

    client, app, _ = route_client
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": "owner",
        "token": "synthetic",
    }
    errors = {
        "authority": ActionDirectiveAuthorityError("synthetic-private-diagnostic"),
        "provider": ExternalMcpError("synthetic-private-diagnostic", code="MCP_DISCOVERY_FAILED"),
        "unknown": RuntimeError("synthetic-private-diagnostic"),
    }
    operation = AsyncMock(side_effect=errors[kind])
    monkeypatch.setattr(routes.mcp_review_service, "prepare_review", operation)
    response = client.post(
        "/api/connectors/custom_synthetic/mcp/review",
        json={"conversationId": "thread", "toolName": "mcp_" + "a" * 40, "arguments": {}},
    )
    assert response.status_code == status
    assert response.headers["cache-control"] == "no-store"
    assert "synthetic-private-diagnostic" not in response.text


@pytest.mark.parametrize(
    "action,operation", [("review", "prepare_review"), ("confirm", "confirm_review")]
)
def test_native_pending_handle_reaches_owning_review_service(
    route_client, monkeypatch, action, operation
):
    client, app, _ = route_client
    token = {"user_id": "owner", "token": "synthetic"}
    app.dependency_overrides[require_vault_owner_token] = lambda: token
    service = AsyncMock(return_value={"status": "review_required"})
    monkeypatch.setattr(routes.mcp_review_service, operation, service)
    handle = "one_secret_ref:" + "a" * 32
    body = {
        "conversationId": "thread",
        "toolName": "mcp_" + "a" * 40,
        "arguments": {},
        "pendingHandle": handle,
    }
    if action == "confirm":
        body.update(directiveId="dir_" + "b" * 32, confirmed=True)
    response = client.post(f"/api/connectors/custom_synthetic/mcp/{action}", json=body)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert service.await_args.kwargs["pending_handle"] == handle
    assert service.await_args.kwargs["token"] is token


def test_catalog_is_curated_but_connection_status_and_legacy_key_lookup_are_owner_scoped(
    route_client, monkeypatch
):
    client, app, _ = route_client
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    registry = SimpleNamespace(
        list_active_connectors=AsyncMock(return_value=[]),
        get_connector=AsyncMock(return_value=None),
    )
    credentials = SimpleNamespace(
        list_statuses=AsyncMock(return_value=[]), store_credential=AsyncMock()
    )
    monkeypatch.setattr(routes, "get_external_connector_registry_service", lambda: registry)
    monkeypatch.setattr(routes, "get_external_connector_credentials_service", lambda: credentials)
    assert client.get("/api/connectors").status_code == 200
    registry.list_active_connectors.assert_awaited_once_with()
    credentials.list_statuses.assert_awaited_once_with(user_id="verified-owner")
    response = client.post(
        "/api/connectors/custom_other/connect/api-key", json={"apiKey": "synthetic"}
    )
    assert response.status_code == 404
    registry.get_connector.assert_awaited_once_with("custom_other", user_id="verified-owner")
    credentials.store_credential.assert_not_called()


@pytest.mark.parametrize("configured", [False, True])
def test_drive_catalog_readiness_matches_oauth_configuration(route_client, monkeypatch, configured):
    client, app, drive = route_client
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    drive.connection_available.return_value = configured
    connector = SimpleNamespace(
        connector_id="google_drive",
        display_name="Google Drive",
        description="Selected files",
        auth_style="oauth",
        owner_user_id=None,
    )
    monkeypatch.setattr(
        routes,
        "get_external_connector_registry_service",
        lambda: SimpleNamespace(
            list_active_connectors=AsyncMock(return_value=[connector]),
        ),
    )
    monkeypatch.setattr(
        routes,
        "get_external_connector_credentials_service",
        lambda: SimpleNamespace(
            list_statuses=AsyncMock(return_value=[]),
        ),
    )
    response = client.get("/api/connectors")
    assert response.status_code == 200
    assert response.json()["connectors"][0]["available"] is configured
    assert response.json()["features"]["google_drive_connection"] is True
    drive.connection_available.assert_awaited_once()


@pytest.mark.parametrize(
    "path,body",
    [
        (
            "/api/connectors/google_drive/connect/oauth/start",
            {"redirectUri": "https://example.invalid/return"},
        ),
        ("/api/connectors/google_drive/disconnect", {}),
        ("/api/connectors/google_drive/picker/session", {"origin": "https://example.invalid"}),
        (
            "/api/connectors/google_drive/picker/native/start",
            {
                "redirectUri": "https://example.invalid/api/connectors/google_drive/picker/native/callback"
            },
        ),
        (
            "/api/connectors/google_drive/picker/native/confirm",
            {"attemptId": "550e8400-e29b-41d4-a716-446655440000"},
        ),
        (
            "/api/connectors/google_drive/picker/native/cancel",
            {"attemptId": "550e8400-e29b-41d4-a716-446655440000"},
        ),
        (
            "/api/connectors/google_drive/documents/select",
            {
                "sessionId": "550e8400-e29b-41d4-a716-446655440000",
                "fileIds": ["file-one"],
                "confirmed": True,
            },
        ),
        ("/api/connectors/oauth/native/finalize", {"attemptId": "synthetic-attempt"}),
        ("/api/connectors/google_drive/live/background", {"enabled": True, "confirmed": True}),
        (
            "/api/connectors/oauth/complete",
            {"state": "signed-synthetic-state", "code": "synthetic-code"},
        ),
    ],
)
def test_owner_routes_stay_owner_protected(route_client, path, body):
    client, _, drive = route_client
    assert client.post(path, json=body).status_code == 401
    drive.complete.assert_not_called()


def test_live_background_toggle_is_owner_bound_confirmed_and_uncached(route_client, monkeypatch):
    from hushh_mcp.services import drive_live_preferences
    from hushh_mcp.services.google_drive_adapter import DriveReadError

    client, app, _ = route_client
    preferences = SimpleNamespace(
        get_background=AsyncMock(return_value={"enabled": False}),
        set_background=AsyncMock(return_value={"enabled": True}),
    )
    # The routes import the class at call time, so patch it where it is defined.
    monkeypatch.setattr(drive_live_preferences, "DriveLivePreferences", lambda: preferences)
    path = "/api/connectors/google_drive/live/background"
    assert client.post(path, json={"enabled": True, "confirmed": True}).status_code == 401
    assert client.get(path).status_code == 401
    preferences.get_background.assert_not_called()
    preferences.set_background.assert_not_called()

    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    response = client.post(path, json={"enabled": True, "confirmed": True})
    assert response.status_code == 200
    assert response.json() == {"enabled": True}
    assert response.headers["Cache-Control"] == "no-store"
    preferences.set_background.assert_awaited_once_with(
        user_id="verified-owner", enabled=True, confirmed=True
    )
    for body in ({"enabled": True}, {"enabled": True, "confirmed": True, "userId": "x"}):
        assert client.post(path, json=body).status_code == 422
    preferences.set_background.assert_awaited_once()

    response = client.get(path)
    assert response.status_code == 200
    assert response.json() == {"enabled": False}
    assert response.headers["Cache-Control"] == "no-store"
    preferences.get_background.assert_awaited_once_with(user_id="verified-owner")

    for code, status in (("connection_changed", 409), ("connector_unavailable", 503)):
        preferences.set_background.side_effect = DriveReadError(code)
        response = client.post(path, json={"enabled": True, "confirmed": True})
        assert (response.status_code, response.json()["detail"]) == (status, code)


def test_selection_routes_derive_owner_reject_unknown_fields_and_do_not_cache_tokens(
    route_client, monkeypatch
):
    client, app, _ = route_client
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    service = SimpleNamespace(
        picker_session=AsyncMock(return_value={"accessToken": "synthetic-short-lived"}),
        select=AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(routes, "DriveSelectionService", lambda: service)
    response = client.post(
        "/api/connectors/google_drive/picker/session", json={"origin": "https://example.invalid"}
    )
    assert response.status_code == 200 and response.headers["Cache-Control"] == "no-store"
    service.picker_session.assert_awaited_once_with(
        user_id="verified-owner", origin="https://example.invalid"
    )
    body = {
        "sessionId": "550e8400-e29b-41d4-a716-446655440000",
        "fileIds": ["file-one"],
        "confirmed": True,
    }
    for change in (
        {"ownerId": "attacker"},
        {"confirmed": False},
        {"endpoint": "https://attacker.invalid"},
    ):
        assert (
            client.post(
                "/api/connectors/google_drive/documents/select", json={**body, **change}
            ).status_code
            == 422
        )
    service.select.assert_not_called()
    assert (
        client.post("/api/connectors/google_drive/documents/select", json=body).status_code == 200
    )
    service.select.assert_awaited_once_with(
        user_id="verified-owner",
        session_id=body["sessionId"],
        file_ids=["file-one"],
        processing_consent=None,
    )


def test_native_picker_routes_keep_candidates_owner_bound_and_processing_opt_in(
    route_client, monkeypatch
):
    client, app, _ = route_client
    native = SimpleNamespace(
        start=AsyncMock(
            return_value={
                "authorizeUrl": "https://accounts.google.com/o/oauth2/v2/auth?state=signed",
                "attemptId": "550e8400-e29b-41d4-a716-446655440000",
                "expiresAt": "2026-09-23T12:00:00+00:00",
            }
        ),
        pending=AsyncMock(
            return_value={
                "attemptId": "550e8400-e29b-41d4-a716-446655440000",
                "expiresAt": "2026-09-23T12:00:00+00:00",
                "files": [
                    {
                        "documentId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
                        "name": "Statement",
                        "mimeType": "application/pdf",
                    }
                ],
            }
        ),
        confirm=AsyncMock(return_value=[{"documentId": "catalog-document"}]),
        cancel=AsyncMock(return_value="cancelled"),
    )
    monkeypatch.setattr(routes, "DriveNativePickerService", lambda: native)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    redirect = "https://example.invalid/api/connectors/google_drive/picker/native/callback"
    start_response = client.post(
        "/api/connectors/google_drive/picker/native/start", json={"redirectUri": redirect}
    )
    assert start_response.status_code == 200
    assert start_response.headers["cache-control"] == "no-store"
    native.start.assert_awaited_once_with(user_id="verified-owner", redirect_uri=redirect)

    pending_response = client.get("/api/connectors/google_drive/picker/native/pending")
    assert pending_response.status_code == 200
    assert pending_response.headers["cache-control"] == "no-store"
    assert pending_response.json()["pending"]["files"][0].keys() == {
        "documentId",
        "name",
        "mimeType",
    }
    assert "fileId" not in pending_response.text
    assert "token" not in pending_response.text

    attempt_id = "550e8400-e29b-41d4-a716-446655440000"
    assert (
        client.post(
            "/api/connectors/google_drive/picker/native/confirm",
            json={
                "attemptId": attempt_id,
                "processingConsent": "selected-files-background-v1",
            },
        ).status_code
        == 200
    )
    native.confirm.assert_awaited_once_with(
        user_id="verified-owner",
        attempt_id=attempt_id,
        processing_consent="selected-files-background-v1",
    )
    cancel_response = client.post(
        "/api/connectors/google_drive/picker/native/cancel",
        json={"attemptId": attempt_id},
    )
    assert cancel_response.status_code == 200
    assert cancel_response.json() == {"status": "cancelled"}
    native.cancel.assert_awaited_once_with(user_id="verified-owner", attempt_id=attempt_id)


def test_native_picker_cancel_route_reports_a_confirmed_race_winner(route_client, monkeypatch):
    client, app, _ = route_client
    native = SimpleNamespace(cancel=AsyncMock(return_value="confirmed"))
    monkeypatch.setattr(routes, "DriveNativePickerService", lambda: native)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}

    response = client.post(
        "/api/connectors/google_drive/picker/native/cancel",
        json={"attemptId": "550e8400-e29b-41d4-a716-446655440000"},
    )

    assert response.status_code == 200
    assert response.json() == {"status": "confirmed"}
    native.cancel.assert_awaited_once_with(
        user_id="verified-owner", attempt_id="550e8400-e29b-41d4-a716-446655440000"
    )


def test_native_picker_callback_returns_only_opaque_handoff(route_client, monkeypatch):
    client, _, _ = route_client
    native = SimpleNamespace(
        callback=AsyncMock(return_value=("550e8400-e29b-41d4-a716-446655440000", "ready"))
    )
    monkeypatch.setattr(routes, "DriveNativePickerService", lambda: native)
    response = client.get(
        "/api/connectors/google_drive/picker/native/callback",
        params={
            "state": "signed-native-state",
            "code": "provider-code-must-not-leak",
            "scope": "https://www.googleapis.com/auth/drive.file",
            "picked_file_ids": "provider-file-id-must-not-leak",
        },
        follow_redirects=False,
    )
    assert response.status_code == 303
    destination = urlparse(response.headers["location"])
    assert (destination.scheme, destination.netloc, destination.path) == (
        "hushh",
        "connectors",
        "/picker-return",
    )
    assert parse_qs(destination.query) == {
        "attemptId": ["550e8400-e29b-41d4-a716-446655440000"],
        "outcome": ["ready"],
    }
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert "provider-code-must-not-leak" not in str(response.headers)
    assert "provider-file-id-must-not-leak" not in str(response.headers)


def test_native_picker_invalid_state_has_no_handoff(route_client, monkeypatch):
    client, _, _ = route_client
    native = SimpleNamespace(
        callback=AsyncMock(side_effect=ExternalConnectorOAuthError("OAuth state is invalid"))
    )
    monkeypatch.setattr(routes, "DriveNativePickerService", lambda: native)
    response = client.get(
        "/api/connectors/google_drive/picker/native/callback",
        params={"state": "forged", "code": "provider-code"},
        follow_redirects=False,
    )
    assert response.status_code == 400
    assert "location" not in response.headers


def test_processing_and_resync_are_owner_bound(route_client, monkeypatch):
    client, app, _ = route_client
    service = SimpleNamespace(set_processing=AsyncMock(), sync=AsyncMock())
    monkeypatch.setattr(routes, "DriveSelectionService", lambda: service)
    document = "550e8400-e29b-41d4-a716-446655440000"
    path = f"/api/connectors/google_drive/documents/{document}"
    assert (
        client.post(path + "/processing", json={"enabled": True, "confirmed": True}).status_code
        == 401
    )
    assert client.post(path + "/sync").status_code == 401
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    for extra in ({"ownerId": "wrong"}, {"confirmed": False}, {"disclosure": "wrong"}):
        assert (
            client.post(
                path + "/processing", json={"enabled": True, "confirmed": True, **extra}
            ).status_code
            == 422
        )
    body = {"enabled": True, "confirmed": True, "disclosure": "selected-files-background-v1"}
    response = client.post(path + "/processing", json=body)
    assert response.status_code == 200 and response.headers["Cache-Control"] == "no-store"
    service.set_processing.assert_awaited_once_with(
        user_id="verified-owner", document_id=document, enabled=True, disclosure=body["disclosure"]
    )
    assert client.post(path + "/sync").status_code == 200
    service.sync.assert_awaited_once_with(user_id="verified-owner", document_id=document)


def test_popup_completion_uses_firebase_owner_not_an_opener_token(route_client):
    client, app, drive = route_client
    body = {
        "state": "signed-synthetic-state",
        "code": "synthetic-code",
        "attemptId": "synthetic-attempt",
    }
    assert client.post("/api/connectors/oauth/complete/web", json=body).status_code == 401
    app.dependency_overrides[require_firebase_auth] = lambda: "verified-owner"
    response = client.post("/api/connectors/oauth/complete/web", json=body)
    assert response.status_code == 200
    drive.complete.assert_awaited_once_with(
        state=body["state"], code=body["code"], expected_user_id="verified-owner"
    )
    assert "token" not in response.text


def test_web_popup_rejects_another_attempt_before_exchange(route_client):
    client, app, drive = route_client
    app.dependency_overrides[require_firebase_auth] = lambda: "verified-owner"
    response = client.post(
        "/api/connectors/oauth/complete/web",
        json={
            "state": "signed-synthetic-state",
            "code": "synthetic-code",
            "attemptId": "different-attempt",
        },
    )
    assert response.status_code == 409
    drive.complete.assert_not_called()


_WEB_BODY = {
    "state": "signed-synthetic-state",
    "code": "synthetic-code",
    "attemptId": "synthetic-attempt",
}


def _operator_row():
    return SimpleNamespace(owner_user_id=None)


def test_curated_popup_completion_needs_only_firebase_auth(route_client):
    client, app, drive = route_client
    service = routes.get_external_connector_oauth_service()
    service._execute.return_value = [{"connector_id": "notion"}]
    service._registry.get_connector.return_value = _operator_row()
    assert client.post("/api/connectors/oauth/complete/web", json=_WEB_BODY).status_code == 401
    # No vault dependency override: only Firebase auth is satisfied.
    app.dependency_overrides[require_firebase_auth] = lambda: "verified-owner"
    response = client.post("/api/connectors/oauth/complete/web", json=_WEB_BODY)
    assert response.status_code == 200
    assert response.json()["connectorId"] == "notion"
    assert response.json()["status"] == "connected"
    service.curated_adapter.complete.assert_awaited_once_with(
        state=_WEB_BODY["state"], code=_WEB_BODY["code"], expected_user_id="verified-owner"
    )
    drive.complete.assert_not_called()
    service.complete.assert_not_called()


def test_curated_popup_rejects_another_attempt_before_any_adapter(route_client):
    client, app, drive = route_client
    service = routes.get_external_connector_oauth_service()
    service._execute.return_value = [{"connector_id": "notion"}]
    service._registry.get_connector.return_value = _operator_row()
    app.dependency_overrides[require_firebase_auth] = lambda: "verified-owner"
    response = client.post(
        "/api/connectors/oauth/complete/web", json={**_WEB_BODY, "attemptId": "different-attempt"}
    )
    assert response.status_code == 409
    service._execute.assert_not_called()
    service.curated_adapter.complete.assert_not_called()
    drive.complete.assert_not_called()


@pytest.mark.parametrize("registry_row", [None, SimpleNamespace(owner_user_id="private-owner")])
def test_popup_refuses_non_drive_non_operator_connectors_without_the_legacy_path(
    route_client, monkeypatch, registry_row
):
    client, app, drive = route_client
    service = routes.get_external_connector_oauth_service()
    service._execute.return_value = [{"connector_id": "legacy_crm"}]
    service._registry.get_connector.return_value = registry_row
    http = Mock(side_effect=AssertionError("legacy HTTP"))
    monkeypatch.setattr(generic_oauth.httpx, "AsyncClient", http)
    app.dependency_overrides[require_firebase_auth] = lambda: "verified-owner"
    response = client.post("/api/connectors/oauth/complete/web", json=_WEB_BODY)
    assert response.status_code == 409
    service.complete.assert_not_called()
    http.assert_not_called()
    service.curated_adapter.complete.assert_not_called()
    drive.complete.assert_not_called()


def test_popup_refuses_a_missing_or_consumed_attempt(route_client):
    client, app, drive = route_client
    service = routes.get_external_connector_oauth_service()
    service._execute.return_value = []
    app.dependency_overrides[require_firebase_auth] = lambda: "verified-owner"
    response = client.post("/api/connectors/oauth/complete/web", json=_WEB_BODY)
    assert response.status_code == 409
    service.curated_adapter.complete.assert_not_called()
    drive.complete.assert_not_called()
    # A consumed curated attempt reaches the adapter, whose atomic claim refuses it.
    service._execute.return_value = [{"connector_id": "notion"}]
    service._registry.get_connector.return_value = _operator_row()
    service.curated_adapter.complete.side_effect = CuratedConnectorOAuthError(
        "attempt_unavailable", status_code=409
    )
    response = client.post("/api/connectors/oauth/complete/web", json=_WEB_BODY)
    assert response.status_code == 409
    assert response.json()["detail"] == "attempt_unavailable"


def test_curated_popup_completes_as_the_firebase_user_and_the_body_cannot_name_one(route_client):
    # The request model carries no identity field at all, so a body-supplied owner
    # is dropped before the route runs. Pin that, or a later "convenience" field
    # could quietly let a caller complete another user's attempt.
    identity_fields = [
        name for name in routes.CompleteWebOAuthRequest.model_fields if "user" in name.lower()
    ]
    assert identity_fields == []
    client, app, _ = route_client
    service = routes.get_external_connector_oauth_service()
    service._execute.return_value = [{"connector_id": "notion"}]
    service._registry.get_connector.return_value = _operator_row()

    async def claim(*, state, code, expected_user_id):
        if expected_user_id != "attempt-owner":
            raise CuratedConnectorOAuthError("attempt_unavailable", status_code=409)
        return {"connectorId": "notion", "status": "connected"}

    service.curated_adapter.complete.side_effect = claim
    app.dependency_overrides[require_firebase_auth] = lambda: "someone-else"
    response = client.post(
        "/api/connectors/oauth/complete/web", json={**_WEB_BODY, "userId": "attempt-owner"}
    )
    assert response.status_code == 409
    service.curated_adapter.complete.assert_awaited_once_with(
        state=_WEB_BODY["state"], code=_WEB_BODY["code"], expected_user_id="someone-else"
    )


def test_vault_complete_is_unchanged_and_still_requires_the_vault_token(route_client):
    client, app, _ = route_client
    service = routes.get_external_connector_oauth_service()
    service.complete.side_effect = None
    service.complete.return_value = {"connectorId": "notion", "status": "connected"}
    body = {"state": "signed-synthetic-state", "code": "synthetic-code"}
    app.dependency_overrides[require_firebase_auth] = lambda: "verified-owner"
    assert client.post("/api/connectors/oauth/complete", json=body).status_code == 401
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    assert client.post("/api/connectors/oauth/complete", json=body).status_code == 200
    service.complete.assert_awaited_once_with(
        state=body["state"], code=body["code"], expected_user_id="verified-owner"
    )


def test_deactivation_does_not_hide_owner_disconnect_status(route_client, monkeypatch):
    client, app, _ = route_client
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    monkeypatch.setattr(
        routes,
        "get_external_connector_registry_service",
        lambda: SimpleNamespace(
            list_active_connectors=AsyncMock(return_value=[]),
            list_curated_connectors=AsyncMock(return_value=[]),
        ),
    )
    credentials = SimpleNamespace(
        list_statuses=AsyncMock(
            return_value=[
                {
                    "connectorId": "google_drive",
                    "status": "needs_reauth",
                    "accountLabel": "owner@example.invalid",
                }
            ]
        )
    )
    monkeypatch.setattr(routes, "get_external_connector_credentials_service", lambda: credentials)
    response = client.get("/api/connectors")
    assert response.status_code == 200
    assert response.json()["connectors"][0]["available"] is False
    assert response.json()["connectors"][0]["status"] == "needs_reauth"
    credentials.list_statuses.assert_awaited_once_with(user_id="verified-owner")


@pytest.mark.parametrize("provider_error", [False, True])
def test_native_return_contains_no_code_state_identity_or_provider_error(
    route_client, provider_error
):
    client, _, drive = route_client
    if provider_error:
        drive.complete_native.side_effect = DriveOAuthError("provider_unavailable", status_code=503)
    response = client.get(
        "/api/connectors/oauth/native/callback",
        params={"state": "signed-synthetic-state", "code": "synthetic-code"},
        follow_redirects=False,
    )
    assert response.status_code == 303
    destination = urlparse(response.headers["location"])
    assert (destination.scheme, destination.netloc, destination.path) == (
        "hushh",
        "connectors",
        "/return",
    )
    assert parse_qs(destination.query) == {
        "attemptId": ["synthetic-attempt"],
        "outcome": ["failed" if provider_error else "ready"],
    }
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert "synthetic-code" not in str(response.headers)
    assert "signed-synthetic-state" not in str(response.headers)


def test_native_bad_state_cannot_trigger_a_handoff_or_exchange(route_client):
    client, _, drive = route_client
    response = client.get(
        "/api/connectors/oauth/native/callback",
        params={"state": "forged", "code": "synthetic-code"},
        follow_redirects=False,
    )
    assert response.status_code == 400
    assert "location" not in response.headers
    drive.complete_native.assert_not_called()


def test_native_cancel_invalidates_attempt_without_a_token_exchange(route_client):
    client, _, drive = route_client
    response = client.get(
        "/api/connectors/oauth/native/callback",
        params={"state": "signed-synthetic-state", "error": "access_denied"},
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert parse_qs(urlparse(response.headers["location"]).query)["outcome"] == ["cancelled"]
    drive.lifecycle.cancel_native.assert_awaited_once_with(attempt_id="synthetic-attempt")
    drive.complete_native.assert_not_called()


def test_pending_native_recovery_is_owner_protected_and_redacted(route_client):
    client, app, drive = route_client
    assert client.get("/api/connectors/oauth/native/pending").status_code == 401

    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    drive.pending_native.return_value = {
        "attemptId": "synthetic-attempt",
        "expiresAt": "2026-09-23T12:00:00+00:00",
    }
    response = client.get("/api/connectors/oauth/native/pending")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"pending": drive.pending_native.return_value}
    drive.pending_native.assert_awaited_once_with(user_id="verified-owner")
    assert "credential" not in response.text
    assert "token" not in response.text


def test_status_requires_vault_owner(route_client):
    client, app, _ = route_client
    assert client.get("/api/connectors").status_code == 401
    # Keep the dependency contract explicit: ordinary Firebase login is not
    # sufficient for status, start, disconnect or native owner finalization.
    protected = [route for route in app.routes if getattr(route, "path", "") == "/api/connectors"]
    assert protected[0].dependant.dependencies[0].call is require_vault_owner_token


def test_private_review_confirmation_requires_browser_owner_and_never_accepts_arguments(
    route_client, monkeypatch
):
    client, app, _ = route_client
    review = dict(
        kind="pod_mcp_review_v1",
        ownerId="owner",
        hushhId="pod",
        podKeyId="key",
        environment="dev",
        epoch=1,
        conversationId="thread",
        connectorId="custom_test",
        toolName="mcp_" + "a" * 40,
        callId="call",
        catalogRevision="rev1",
        commitment="b" * 64,
        serviceUid="uid",
    )
    body = dict(podReview=review, directiveId="dir_" + "c" * 32, confirmed=True)
    path = "/api/connectors/custom_test/mcp/confirm"
    broker = AsyncMock(return_value={"status": "confirmed"})
    monkeypatch.setattr(routes, "mutate_review", broker)
    # A machine bearer alone is not a vault-owner browser confirmation.
    assert client.post(
        path, json=body, headers={"Authorization": "Bearer pod-only"}
    ).status_code in {401, 403}
    broker.assert_not_awaited()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    assert (
        client.post(path, json={**body, "arguments": {"private": "never-forward"}}).status_code
        == 422
    )
    assert client.post(path, json={**body, "confirmed": False}).status_code == 400
    assert (
        client.post(path, json={**body, "podReview": {**review, "ownerId": "other"}}).status_code
        == 403
    )
    broker.assert_not_awaited()
    assert client.post(path, json=body).status_code == 200
    broker.assert_awaited_once()


@pytest.mark.parametrize("operation", ["issue", "consume"])
def test_pod_mcp_machine_body_is_bounded_before_auth_and_errors_never_echo(operation, monkeypatch):
    from api.routes.one import pod_mcp_approval

    authenticate = AsyncMock()
    mutate = AsyncMock()
    monkeypatch.setattr(pod_mcp_approval, "verify_pod_request", authenticate)
    monkeypatch.setattr(pod_mcp_approval, "mutate_review", mutate)
    app = FastAPI()
    app.include_router(pod_mcp_approval.router)
    client = TestClient(app)
    path = f"/api/one/pod/mcp-approval/{operation}"
    # Streaming body without a declared Content-Length, then malformed small JSON.
    response = client.post(path, content=iter([b"x" * 32_001, b"x" * 32_001]))
    assert response.status_code == 413
    response = client.post(path, json={"private": "synthetic-secret-never-echo"})
    assert response.status_code == 422 and "synthetic-secret" not in response.text
    authenticate.assert_not_called()
    mutate.assert_not_called()


# --- curated (operator-registered) OAuth connector, e.g. HubSpot ----------------


def _hubspot_definition(**overrides):
    connector_id = str(overrides.get("connector_id", "hubspot"))
    manifest = routes.get_manifest(connector_id)
    base = dict(
        connector_id=connector_id,
        display_name="HubSpot",
        description="CRM",
        auth_style="oauth",
        owner_user_id=None,
        transport_kind="mcp",
        capability_policy={"chat": "reviewed"},
        mcp_endpoint=manifest.mcp_endpoint if manifest else "https://mcp.example/mcp",
        oauth_authorize_url=manifest.authorize_url if manifest else "https://mcp.example/authorize",
        oauth_token_url=manifest.token_url if manifest else "https://mcp.example/token",
        oauth_scopes=manifest.scopes if manifest else (),
        oauth_client_id_env=manifest.client_id_env if manifest else "HUBSPOT_OAUTH_CLIENT_ID",
        oauth_client_secret_env=manifest.client_secret_env if manifest else None,
        registered_redirect_uris=(manifest.redirect_uris["uat"] if manifest else ()),
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _wire_curated_service(monkeypatch, curated):
    service = SimpleNamespace(curated=lambda: curated)
    monkeypatch.setattr(routes, "get_external_connector_oauth_service", lambda: service)


@pytest.mark.parametrize("configured", [False, True])
def test_curated_catalog_availability_comes_from_the_curated_adapter(
    route_client, monkeypatch, configured
):
    client, app, _ = route_client
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    curated = SimpleNamespace(connection_available=AsyncMock(return_value=configured))
    _wire_curated_service(monkeypatch, curated)
    monkeypatch.setattr(
        routes,
        "get_external_connector_registry_service",
        lambda: SimpleNamespace(
            list_active_connectors=AsyncMock(return_value=[_hubspot_definition()])
        ),
    )
    monkeypatch.setattr(
        routes,
        "get_external_connector_credentials_service",
        lambda: SimpleNamespace(list_statuses=AsyncMock(return_value=[])),
    )
    body = client.get("/api/connectors").json()
    hubspot = [item for item in body["connectors"] if item["connectorId"] == "hubspot"]
    if configured:
        assert [item["available"] for item in hubspot] == [True]
    else:
        # Not connectable and no stored grant to recover: the card is not sent at all.
        assert hubspot == []
    assert "curated_mcp_connectors" in body["features"]
    curated.connection_available.assert_awaited_once_with("hubspot", user_id="verified-owner")


def test_reviewed_providers_without_a_usable_row_are_not_offered_to_an_owner_with_no_grant(
    route_client, monkeypatch
):
    client, app, _ = route_client
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    monkeypatch.setattr(
        routes,
        "get_external_connector_registry_service",
        lambda: SimpleNamespace(list_active_connectors=AsyncMock(return_value=[])),
    )
    monkeypatch.setattr(
        routes,
        "get_external_connector_credentials_service",
        lambda: SimpleNamespace(list_statuses=AsyncMock(return_value=[])),
    )

    response = client.get("/api/connectors")

    assert response.status_code == 200
    # Reviewed providers with no usable runtime row (setup pending) are not offered
    # (Attio now has a runtime manifest, so it is covered like the others), and an
    # owner with no stored grant has nothing to recover: no dead cards.
    ids = {card["connectorId"] for card in response.json()["connectors"]}
    assert ids.isdisjoint({"hubspot", "notion", "attio"})


def test_catalog_requires_an_exact_manifest_pinned_row_before_connect_is_available(
    route_client, monkeypatch
):
    client, app, _ = route_client
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    curated = SimpleNamespace(connection_available=AsyncMock(return_value=True))
    _wire_curated_service(monkeypatch, curated)
    drifted_notion = _hubspot_definition(
        connector_id="notion",
        display_name="Operator-controlled Notion",
        mcp_endpoint="https://unreviewed.example/mcp",
    )
    monkeypatch.setattr(
        routes,
        "get_external_connector_registry_service",
        lambda: SimpleNamespace(
            list_active_connectors=AsyncMock(return_value=[drifted_notion]),
            list_curated_connectors=AsyncMock(return_value=[drifted_notion]),
        ),
    )
    monkeypatch.setattr(
        routes,
        "get_external_connector_credentials_service",
        lambda: SimpleNamespace(
            list_statuses=AsyncMock(
                return_value=[{"connectorId": "notion", "status": "connected", "accountLabel": "x"}]
            )
        ),
    )

    response = client.get("/api/connectors")

    notion = next(item for item in response.json()["connectors"] if item["connectorId"] == "notion")
    assert notion["displayName"] == "Notion"
    assert notion["catalogCard"] is True
    assert notion["catalogState"] == "setup_pending"
    assert notion["available"] is False
    # A stale stored grant can still be disconnected, but this combined gate
    # prevents the panel from offering Start OAuth for the drifted row.
    assert not (notion["curatedOAuth"] and notion["available"])


def test_a_drifted_row_with_no_stored_grant_is_not_offered(route_client, monkeypatch):
    client, app, _ = route_client
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    _wire_curated_service(
        monkeypatch, SimpleNamespace(connection_available=AsyncMock(return_value=True))
    )
    drifted = _hubspot_definition(
        connector_id="notion", mcp_endpoint="https://unreviewed.example/mcp"
    )
    monkeypatch.setattr(
        routes,
        "get_external_connector_registry_service",
        lambda: SimpleNamespace(list_active_connectors=AsyncMock(return_value=[drifted])),
    )
    monkeypatch.setattr(
        routes,
        "get_external_connector_credentials_service",
        lambda: SimpleNamespace(list_statuses=AsyncMock(return_value=[])),
    )

    ids = {item["connectorId"] for item in client.get("/api/connectors").json()["connectors"]}

    assert "notion" not in ids


def test_a_registration_only_provider_is_never_surfaced_even_with_a_similarly_named_registry_row(
    route_client, monkeypatch, registration_only_provider
):
    client, app, _ = route_client
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    # The registration spec is loaded, yet it is not a runtime provider.
    assert registration_only_provider.connector_id == "pendingco"
    assert routes.get_manifest("pendingco") is None
    pending_row = _hubspot_definition(
        connector_id="pendingco", display_name="Operator-controlled Pending Co"
    )
    monkeypatch.setattr(
        routes,
        "get_external_connector_registry_service",
        lambda: SimpleNamespace(list_active_connectors=AsyncMock(return_value=[pending_row])),
    )
    monkeypatch.setattr(
        routes,
        "get_external_connector_credentials_service",
        lambda: SimpleNamespace(list_statuses=AsyncMock(return_value=[])),
    )

    response = client.get("/api/connectors")

    # Registration-only: neither a card nor the operator's similarly named row is surfaced.
    assert response.status_code == 200
    assert all(item["connectorId"] != "pendingco" for item in response.json()["connectors"])


@pytest.mark.parametrize(
    "definition,expected",
    [
        (_hubspot_definition(), True),
        (_hubspot_definition(connector_id="notion", display_name="Notion"), True),
        # Attio now has a reviewed runtime manifest, so its pinned row is curated.
        (_hubspot_definition(connector_id="attio", display_name="Attio"), True),
        # A registration-only contract is never enough to surface a provider: it
        # has no authenticated tool policy or runtime manifest.
        (_hubspot_definition(connector_id="pendingco", display_name="Pending Co"), False),
        # A reviewed-looking row with no manifest never reads as a curated provider,
        # so the frontend would not offer a Connect button that could only fail.
        (_hubspot_definition(connector_id="no_manifest_crm"), False),
        (_hubspot_definition(owner_user_id="someone"), False),
        (_hubspot_definition(capability_policy={"chat": "unreviewed"}), False),
        (_hubspot_definition(auth_style="api_key"), False),
    ],
)
def test_the_catalog_marks_manifest_backed_oauth_providers_for_the_frontend(
    route_client, monkeypatch, registration_only_provider, definition, expected
):
    # The registration-only spec is loaded for every case, so the "pendingco"
    # case proves a loaded registration contract still never reads as curated.
    assert registration_only_provider.connector_id == "pendingco"
    client, app, _ = route_client
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    _wire_curated_service(
        monkeypatch, SimpleNamespace(connection_available=AsyncMock(return_value=True))
    )
    monkeypatch.setattr(
        routes,
        "get_external_connector_registry_service",
        lambda: SimpleNamespace(list_active_connectors=AsyncMock(return_value=[definition])),
    )
    monkeypatch.setattr(
        routes,
        "get_external_connector_credentials_service",
        lambda: SimpleNamespace(list_statuses=AsyncMock(return_value=[])),
    )
    body = client.get("/api/connectors").json()
    entries = [
        item for item in body["connectors"] if item["connectorId"] == definition.connector_id
    ]
    if expected:
        assert [item["curatedOAuth"] for item in entries] == [True]
    else:
        # Never offered as a curated provider: hidden outright, or at least not marked curated.
        assert all(item["curatedOAuth"] is False for item in entries)


def test_inactive_curated_connector_is_reprojected_for_owner_recovery(route_client, monkeypatch):
    client, app, _ = route_client
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    registry = SimpleNamespace(
        list_active_connectors=AsyncMock(return_value=[]),
        list_curated_connectors=AsyncMock(return_value=[_hubspot_definition(is_active=False)]),
    )
    monkeypatch.setattr(routes, "get_external_connector_registry_service", lambda: registry)
    monkeypatch.setattr(
        routes,
        "get_external_connector_credentials_service",
        lambda: SimpleNamespace(
            list_statuses=AsyncMock(
                return_value=[
                    {
                        "connectorId": "hubspot",
                        "status": "connected",
                        "accountLabel": "owner@example.invalid",
                    }
                ]
            )
        ),
    )

    response = client.get("/api/connectors")

    assert response.status_code == 200
    hubspot = next(
        item for item in response.json()["connectors"] if item["connectorId"] == "hubspot"
    )
    assert hubspot == {
        "connectorId": "hubspot",
        "displayName": "HubSpot",
        "description": "Connect HubSpot so Kai can read and act on your CRM contacts, deals, and companies.",
        "authStyle": "oauth",
        "registrationKind": "curated",
        "status": "connected",
        "accountLabel": "owner@example.invalid",
        "connectedAt": None,
        "validationState": "unverified",
        "profile": None,
        "revocationOutcome": "not_attempted",
        "lastErrorCode": None,
        "available": False,
        "curatedOAuth": True,
        "catalogCard": True,
        "catalogState": "unavailable",
    }
    registry.list_curated_connectors.assert_awaited_once_with(include_inactive=True)


def test_curated_oauth_start_and_disconnect_use_the_curated_lifecycle(route_client, monkeypatch):
    client, app, _ = route_client
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    curated = SimpleNamespace(
        disconnect=AsyncMock(
            return_value={
                "status": "revoked",
                "connectorId": "hubspot",
                "revocationOutcome": "unavailable",
            }
        )
    )
    service = SimpleNamespace(
        curated=lambda: curated,
        start=AsyncMock(
            side_effect=routes.CuratedConnectorOAuthError(
                "redirect_not_registered", status_code=400
            )
        ),
    )
    monkeypatch.setattr(routes, "get_external_connector_oauth_service", lambda: service)
    monkeypatch.setattr(
        routes,
        "get_external_connector_registry_service",
        lambda: SimpleNamespace(get_connector=AsyncMock(return_value=_hubspot_definition())),
    )
    started = client.post(
        "/api/connectors/hubspot/connect/oauth/start",
        json={"redirectUri": "https://evil.invalid/return"},
    )
    assert started.status_code == 400
    assert started.json()["detail"] == "redirect_not_registered"
    disconnected = client.post("/api/connectors/hubspot/disconnect")
    assert disconnected.status_code == 200
    assert disconnected.json()["revocationOutcome"] == "unavailable"
    curated.disconnect.assert_awaited_once_with(connector_id="hubspot", user_id="verified-owner")


def test_deactivated_curated_connector_can_still_be_scrubbed_by_owner(route_client, monkeypatch):
    client, app, _ = route_client
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    curated = SimpleNamespace(
        disconnect=AsyncMock(
            return_value={
                "status": "revoked",
                "connectorId": "hubspot",
                "revocationOutcome": "unavailable",
            }
        )
    )
    _wire_curated_service(monkeypatch, curated)
    registry = SimpleNamespace(
        get_connector=AsyncMock(return_value=_hubspot_definition(is_active=False))
    )
    monkeypatch.setattr(
        routes,
        "get_external_connector_registry_service",
        lambda: registry,
    )
    assert client.post("/api/connectors/hubspot/disconnect").status_code == 200
    registry.get_connector.assert_awaited_once_with("hubspot", include_inactive=True)
    curated.disconnect.assert_awaited_once_with(connector_id="hubspot", user_id="verified-owner")


def test_unknown_deactivated_connector_still_scrubs_legacy_credentials(route_client, monkeypatch):
    client, app, _ = route_client
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    credentials = SimpleNamespace(
        disconnect=AsyncMock(return_value={"status": "revoked", "connectorId": "unknown"})
    )
    monkeypatch.setattr(
        routes,
        "get_external_connector_registry_service",
        lambda: SimpleNamespace(get_connector=AsyncMock(return_value=None)),
    )
    monkeypatch.setattr(routes, "get_external_connector_credentials_service", lambda: credentials)

    assert client.post("/api/connectors/unknown/disconnect").status_code == 200
    credentials.disconnect.assert_awaited_once_with(
        user_id="verified-owner", connector_id="unknown"
    )


async def test_review_409_keeps_its_response_and_logs_a_reason(caplog):
    from fastapi import HTTPException

    from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError

    async def refuse(**_):
        raise ActionDirectiveAuthorityError("private-detail-in-message")

    with caplog.at_level("WARNING", logger=routes.logger.name):
        with pytest.raises(HTTPException) as refused:
            await routes._mcp_review_response(refuse, arguments={"q": "private-argument"})
    assert refused.value.status_code == 409
    assert refused.value.detail == "This review changed or expired. Review the call again."
    assert [r.getMessage() for r in caplog.records] == [
        "one.mcp_review_refused reason=authority_refused"
    ]
    assert "private-detail-in-message" not in caplog.text
    assert "private-argument" not in caplog.text


async def test_review_409_with_a_known_reason_is_not_logged_twice(caplog):
    from fastapi import HTTPException

    from hushh_mcp.one_adk.mcp_pending_call import review_refusal

    async def refuse(**_):
        raise review_refusal("pending_handle_missing", "Connector review expired. Review again.")

    with caplog.at_level("WARNING"):
        with pytest.raises(HTTPException) as refused:
            await routes._mcp_review_response(refuse)
    assert refused.value.status_code == 409
    assert [r.getMessage() for r in caplog.records] == [
        "one.mcp_review_refused reason=pending.handle.missing"
    ]


async def test_a_review_failure_leaves_a_cause_without_leaking_its_message(caplog):
    from fastapi import HTTPException

    from api.routes import external_connectors as routes
    from hushh_mcp.services.external_mcp_client import ExternalMcpError

    async def unexpected(**_kwargs):
        raise KeyError("PRIVATE_SQL_FRAGMENT")

    async def provider_down(**_kwargs):
        raise ExternalMcpError("x", code="MCP_CONNECTOR_UNAVAILABLE", status_code=503)

    with caplog.at_level("WARNING", logger=routes.logger.name):
        with pytest.raises(HTTPException) as caught:
            await routes._mcp_review_response(unexpected)
        assert caught.value.status_code == 503
        with pytest.raises(HTTPException):
            await routes._mcp_review_response(provider_down)
    lines = [r.getMessage() for r in caplog.records if "one.mcp_review_failed" in r.getMessage()]
    assert lines == [
        "one.mcp_review_failed type=KeyError",
        "one.mcp_review_failed code=mcp.connector.unavailable status=503",
    ]
    assert "PRIVATE_SQL_FRAGMENT" not in caplog.text

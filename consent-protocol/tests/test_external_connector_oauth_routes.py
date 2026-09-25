from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlparse
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes import external_connectors as routes
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_connector_oauth_service import ExternalConnectorOAuthError
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

    service = SimpleNamespace(_verify_state=verify, drive=lambda: drive)
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


def test_deactivation_does_not_hide_owner_disconnect_status(route_client, monkeypatch):
    client, app, _ = route_client
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    monkeypatch.setattr(
        routes,
        "get_external_connector_registry_service",
        lambda: SimpleNamespace(list_active_connectors=AsyncMock(return_value=[])),
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

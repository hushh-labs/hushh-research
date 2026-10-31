from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from api import developer_auth
from api.routes import developer, hushh_tech
from hushh_mcp.services.developer_registry_service import (
    TOOL_GROUP_HUSHH_TECH_CLIENT,
    DeveloperPrincipal,
    visible_tool_names_for_groups,
)
from hushh_mcp.services.hushh_tech_client_service import HushhTechClientError

APP_ID = "app_hushh_tech_uat"
LINKED_AT_MS = 2_000


def _principal(
    *,
    app_id: str = APP_ID,
    groups=(TOOL_GROUP_HUSHH_TECH_CLIENT,),
    capabilities=(),
    auth_source: str = "registry",
):
    return DeveloperPrincipal(
        app_id=app_id,
        agent_id=f"developer:{app_id}",
        display_name="Hushh Technologies UAT",
        allowed_tool_groups=groups,
        allowed_capabilities=capabilities,
        auth_source=auth_source,
    )


@pytest.fixture(autouse=True)
def enabled_product_client(monkeypatch: pytest.MonkeyPatch):
    for key, value in {
        "ENVIRONMENT": "test",
        "HUSSH_TECH_CLIENT_ENABLED": "true",
        "HUSSH_TECH_LAUNCH_PEPPER": "test-launch-pepper",
        "HUSSH_TECH_DEVELOPER_APP_ID": APP_ID,
        "HUSSH_TECH_ALLOWED_AUDIENCE": "hushh-tech-uat",
        "HUSSH_TECH_ALLOWED_REDIRECT_URIS": (
            "https://uat.hushhtech.com/auth/hushh-research/callback"
        ),
        "HUSSH_TECH_ALLOWED_CONSENT_SCOPES": "attr.identity.name",
        "HUSSH_TECH_UAT_FIREBASE_UID_ALLOWLIST": "firebase-user",
        "HUSSH_TECH_PROXY_AUDIENCE": "https://consent-protocol-f2gsa4kfsq-uc.a.run.app",
        "HUSSH_TECH_TRUSTED_PROXY_SERVICE_ACCOUNTS": (
            "hushh-webapp-runtime@hushh-pda-uat.iam.gserviceaccount.com"
        ),
        "RATE_LIMIT_STORAGE_URI": "redis://10.0.0.2:6379",
    }.items():
        monkeypatch.setenv(key, value)

    class LinkedService:
        async def get_link_status(self, **_values):
            return {"state": "READY", "linked": True, "linked_at_ms": LINKED_AT_MS}

    monkeypatch.setattr(developer, "HushhTechClientService", LinkedService)


def _request(path: str, *, method: str = "GET") -> Request:
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": method,
            "scheme": "https",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": [],
            "client": ("127.0.0.1", 443),
            "server": ("research.example", 443),
        }
    )


def test_product_registration_has_only_encrypted_consent_tools(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("HUSSH_TECH_DEVELOPER_APP_ID", APP_ID)
    monkeypatch.setattr(hushh_tech, "authenticate_developer_principal", lambda **_: _principal())
    request = type("Request", (), {"client": None, "headers": {}})()
    assert (
        hushh_tech._require_product_principal(
            request=request,
            developer_token="server-only-token",  # noqa: S106 - inert test value
        )
        == APP_ID
    )


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/api/v1/request-consent"),
        ("GET", "/api/v1/consent-status"),
        ("GET", "/api/v1/consent-events"),
        ("POST", "/api/v1/scoped-export"),
        ("GET", f"/api/v1/scoped-export/resources/{'a' * 32}/revisions/1"),
        ("GET", f"/api/v1/scoped-export/resources/{'a' * 32}/revisions/10000000"),
        ("GET", "/api/v1/products/hushh-tech/link/status"),
        ("POST", "/api/v1/products/hushh-tech/link/verify"),
        ("POST", "/api/v1/products/hushh-tech/link/revoke"),
        ("GET", "/api/v1/products/hushh-tech/compatibility/profile"),
    ],
)
def test_product_registration_is_limited_to_explicit_routes(method: str, path: str):
    assert (
        developer_auth._enforce_product_client_route(
            _principal(), request=_request(path, method=method)
        ).app_id
        == APP_ID
    )


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/v1/request-consent"),
        ("POST", "/api/v1/consent-status"),
        ("DELETE", "/api/v1/products/hushh-tech/link/revoke"),
        ("GET", "/api/v1/products/hushh-tech/admin"),
        ("POST", f"/api/v1/scoped-export/resources/{'a' * 32}/revisions/1"),
        ("DELETE", f"/api/v1/scoped-export/resources/{'a' * 32}/revisions/1"),
        ("GET", "/api/v1/scoped-export/resources/export-id/revisions/1"),
        ("GET", f"/api/v1/scoped-export/resources/{'a' * 32}/revisions/0"),
        ("GET", f"/api/v1/scoped-export/resources/{'a' * 32}/revisions/10000001"),
    ],
)
def test_product_registration_rejects_unlisted_methods_and_paths(
    method: str,
    path: str,
):
    with pytest.raises(HTTPException) as error:
        developer_auth._enforce_product_client_route(
            _principal(), request=_request(path, method=method)
        )
    assert error.value.status_code == 403
    assert error.value.detail["error_code"] == "APP_ROUTE_NOT_ALLOWED"


def test_product_registration_rejects_oauth_principal():
    with pytest.raises(HTTPException) as error:
        developer_auth._enforce_product_client_route(
            _principal(auth_source="oauth"),
            request=_request("/api/v1/consent-status"),
        )
    assert error.value.status_code == 403
    assert error.value.detail["error_code"] == "FEATURE_DISABLED"


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/user-scopes/user-1",
        "/api/v1/public-profile-export",
        "/api/v1/mcp/search-scopes",
        "/api/v1/mcp/scoped-export",
        "/api/v1/ria/profile",
        "/api/v1/marketplace/apps",
        "/api/v1/tools",
        "/oauth/authorize",
        "/api/developer/apps",
    ],
)
def test_product_registration_cannot_cross_product_route_boundaries(path: str):
    with pytest.raises(HTTPException) as error:
        developer_auth._enforce_product_client_route(_principal(), request=_request(path))
    assert error.value.status_code == 403
    assert error.value.detail["error_code"] == "APP_ROUTE_NOT_ALLOWED"


def test_product_registration_route_gate_fails_closed_without_request():
    with pytest.raises(HTTPException) as error:
        developer_auth._enforce_product_client_route(_principal(), request=None)
    assert error.value.detail["error_code"] == "APP_ROUTE_NOT_ALLOWED"


def test_other_developer_groups_keep_existing_route_access():
    principal = _principal(app_id="another-app", groups=("core_consent",))
    assert (
        developer_auth._enforce_product_client_route(
            principal,
            request=_request("/api/v1/user-scopes/user-1"),
        )
        is principal
    )


def test_product_consent_scope_requires_exact_non_wildcard_attr_allowlist(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv(
        "HUSSH_TECH_ALLOWED_CONSENT_SCOPES",
        "attr.identity.name,attr.profile.display_name",
    )
    developer._require_hushh_tech_consent_scope(_principal(), "attr.identity.name")
    developer._require_hushh_tech_consent_scope(_principal(), "attr.profile.display_name")


@pytest.mark.parametrize(
    "scope",
    [
        "",
        "vault.owner",
        "pkm.read",
        "pkm.write",
        "cap.one.invoke",
        "cap.pkm.marketplace.publish",
        "agent.ria.read",
        "mcp.tools.read",
        "attr.identity.*",
        "attr.financial.portfolio",
    ],
)
def test_product_consent_scope_denies_cross_product_or_unlisted_scope(
    monkeypatch: pytest.MonkeyPatch,
    scope: str,
):
    monkeypatch.setenv(
        "HUSSH_TECH_ALLOWED_CONSENT_SCOPES",
        "attr.identity.name,attr.identity.*,cap.one.invoke,pkm.read",
    )
    with pytest.raises(HTTPException) as error:
        developer._require_hushh_tech_consent_scope(_principal(), scope)
    assert error.value.status_code == 403
    assert error.value.detail["error_code"] == "APP_SCOPE_NOT_ALLOWED"


def test_product_consent_scope_empty_config_denies_every_export(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.delenv("HUSSH_TECH_ALLOWED_CONSENT_SCOPES", raising=False)
    with pytest.raises(HTTPException) as error:
        developer._require_hushh_tech_consent_scope(_principal(), "attr.identity.name")
    assert error.value.detail["error_code"] == "APP_SCOPE_NOT_ALLOWED"


@pytest.mark.asyncio
async def test_scoped_export_rechecks_the_signed_token_scope(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("HUSSH_TECH_ALLOWED_CONSENT_SCOPES", "attr.identity.name")
    monkeypatch.setattr(developer, "_resolve_principal", lambda **_: _principal())

    async def validate(*_args, **_kwargs):
        return True, None, SimpleNamespace(scope_str="attr.financial.portfolio")

    monkeypatch.setattr(developer, "validate_token_with_db", validate)
    with pytest.raises(HTTPException) as error:
        await developer._load_scoped_export_or_raise(
            request=_request("/api/v1/scoped-export"),
            token=None,
            authorization="Bearer product-token",
            user_id="firebase-user",
            consent_token="signed-consent-token",  # noqa: S106 - inert test value
            expected_scope=None,
        )
    assert error.value.detail["error_code"] == "APP_SCOPE_NOT_ALLOWED"


@pytest.mark.asyncio
async def test_scoped_export_rechecks_the_stored_export_scope(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("HUSSH_TECH_ALLOWED_CONSENT_SCOPES", "attr.identity.name")
    monkeypatch.setattr(developer, "_resolve_principal", lambda **_: _principal())

    async def validate(*_args, **_kwargs):
        return (
            True,
            None,
            SimpleNamespace(
                user_id="firebase-user",
                agent_id=f"developer:{APP_ID}",
                scope_str="attr.identity.name",
                issued_at=LINKED_AT_MS + 1,
            ),
        )

    class FakeConsentDB:
        async def get_consent_export(self, _consent_token):
            return {
                "scope": "attr.financial.portfolio",
                "refresh_status": "current",
                "is_strict_zero_knowledge": True,
                "envelope_version": 2,
                "app_id": APP_ID,
            }

    monkeypatch.setattr(developer, "validate_token_with_db", validate)
    monkeypatch.setattr(developer, "ConsentDBService", FakeConsentDB)
    with pytest.raises(HTTPException) as error:
        await developer._load_scoped_export_or_raise(
            request=_request("/api/v1/scoped-export"),
            token=None,
            authorization="Bearer product-token",
            user_id="firebase-user",
            consent_token="signed-consent-token",  # noqa: S106 - inert test value
            expected_scope="attr.identity.name",
        )
    assert error.value.detail["error_code"] == "APP_SCOPE_NOT_ALLOWED"


@pytest.mark.asyncio
async def test_ciphertext_resource_rechecks_token_and_export_scopes(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("HUSSH_TECH_ALLOWED_CONSENT_SCOPES", "attr.identity.name")
    monkeypatch.setattr(developer, "_resolve_principal", lambda **_: _principal())

    class FakeConsentDB:
        async def get_consent_export_by_id(self, _export_id):
            return {
                "app_id": APP_ID,
                "consent_token": "signed-consent-token",
                "scope": "attr.financial.portfolio",
            }

    async def validate(*_args, **_kwargs):
        return (
            True,
            None,
            SimpleNamespace(
                agent_id=f"developer:{APP_ID}",
                scope_str="attr.financial.portfolio",
            ),
        )

    monkeypatch.setattr(developer, "ConsentDBService", FakeConsentDB)
    monkeypatch.setattr(developer, "validate_token_with_db", validate)
    with pytest.raises(HTTPException) as error:
        await developer.get_scoped_export_resource(
            request=_request("/api/v1/scoped-export/resources/export-id/revisions/1"),
            export_id="a" * 32,
            revision=1,
            authorization="Bearer product-token",
        )
    assert error.value.detail["error_code"] == "APP_SCOPE_NOT_ALLOWED"


@pytest.mark.asyncio
async def test_consent_status_does_not_reuse_a_broader_historical_grant(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("HUSSH_TECH_ALLOWED_CONSENT_SCOPES", "attr.identity.name")
    monkeypatch.setattr(developer, "_resolve_principal", lambda **_: _principal())

    async def covering(**_kwargs):
        return (
            {
                "scope": "attr.identity.*",
                "token_id": "broader-consent-token",
                "agent_id": f"developer:{APP_ID}",
            },
            {"scope": "attr.identity.*"},
            False,
        )

    monkeypatch.setattr(developer, "_resolve_strict_covering_active_token", covering)
    response = await developer.get_consent_status(
        request=_request("/api/v1/consent-status"),
        user_id="firebase-user",
        scope="attr.identity.name",
        request_id=None,
        token=None,
        authorization="Bearer product-token",
    )
    assert response.status == "not_found"
    assert response.consent_token is None


@pytest.mark.asyncio
async def test_consent_event_stream_rejects_historical_cross_product_scope(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("HUSSH_TECH_ALLOWED_CONSENT_SCOPES", "attr.identity.name")
    monkeypatch.setattr(developer, "_resolve_principal", lambda **_: _principal())

    class FakeConsentDB:
        async def get_request_status(self, _user_id, _request_id):
            return {
                "agent_id": f"developer:{APP_ID}",
                "scope": "attr.financial.portfolio",
            }

    monkeypatch.setattr(developer, "ConsentDBService", FakeConsentDB)
    with pytest.raises(HTTPException) as error:
        await developer.stream_consent_events(
            request=_request("/api/v1/consent-events"),
            user_id="firebase-user",
            request_id="req_historical",
            token=None,
            authorization="Bearer product-token",
        )
    assert error.value.detail["error_code"] == "APP_SCOPE_NOT_ALLOWED"
    assert visible_tool_names_for_groups([TOOL_GROUP_HUSHH_TECH_CLIENT]) == (
        "request_consent",
        "check_consent_status",
        "get_encrypted_scoped_export",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("error_code", ["LINK_REQUIRED", "FEATURE_DISABLED"])
async def test_open_consent_stream_closes_before_emitting_after_access_revocation(
    monkeypatch: pytest.MonkeyPatch,
    error_code: str,
):
    from api import consent_listener

    queue: asyncio.Queue[dict[str, object]] = asyncio.Queue()
    unsubscribed = False

    async def subscribe(**_values):
        return queue

    async def unsubscribe(**_values):
        nonlocal unsubscribed
        unsubscribed = True

    gate_calls = 0

    async def gate(_principal, _user_id):
        nonlocal gate_calls
        gate_calls += 1
        if gate_calls > 1:
            raise HTTPException(
                status_code=403,
                detail={"error_code": error_code},
            )
        return LINKED_AT_MS

    monkeypatch.setattr(consent_listener, "subscribe_developer_consent_queue", subscribe)
    monkeypatch.setattr(consent_listener, "unsubscribe_developer_consent_queue", unsubscribe)
    monkeypatch.setattr(developer, "_require_hushh_tech_consent_access", gate)
    generator = developer._developer_consent_event_generator(
        request=SimpleNamespace(is_disconnected=lambda: False),
        user_id="firebase-user",
        request_id="request-1",
        principal=_principal(),
        initial_latest={
            "action": "REQUESTED",
            "scope": "attr.identity.name",
            "agent_id": f"developer:{APP_ID}",
            "issued_at": LINKED_AT_MS + 1,
        },
    )
    first = await anext(generator)
    assert first["event"] == "snapshot"
    assert "consent_token" in first["data"]
    with pytest.raises(StopAsyncIteration):
        await anext(generator)
    assert unsubscribed is True


@pytest.mark.asyncio
async def test_open_consent_stream_closes_when_link_epoch_changes(
    monkeypatch: pytest.MonkeyPatch,
):
    from api import consent_listener

    queue: asyncio.Queue[dict[str, object]] = asyncio.Queue()
    unsubscribed = False
    epochs = iter((LINKED_AT_MS, LINKED_AT_MS + 100))

    async def subscribe(**_values):
        return queue

    async def unsubscribe(**_values):
        nonlocal unsubscribed
        unsubscribed = True

    async def gate(_principal, _user_id):
        return next(epochs)

    monkeypatch.setattr(consent_listener, "subscribe_developer_consent_queue", subscribe)
    monkeypatch.setattr(consent_listener, "unsubscribe_developer_consent_queue", unsubscribe)
    monkeypatch.setattr(developer, "_require_hushh_tech_consent_access", gate)
    generator = developer._developer_consent_event_generator(
        request=SimpleNamespace(is_disconnected=lambda: False),
        user_id="firebase-user",
        request_id="request-before-relink",
        principal=_principal(),
        initial_latest={
            "action": "REQUESTED",
            "scope": "attr.identity.name",
            "agent_id": f"developer:{APP_ID}",
            "issued_at": LINKED_AT_MS + 1,
        },
    )

    assert (await anext(generator))["event"] == "snapshot"
    with pytest.raises(StopAsyncIteration):
        await anext(generator)
    assert unsubscribed is True


@pytest.mark.asyncio
async def test_relink_epoch_invalidates_old_consent_status_and_export(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(developer, "_resolve_principal", lambda **_: _principal())

    async def covering(**_kwargs):
        return (
            {
                "scope": "attr.identity.name",
                "token_id": "pre-revocation-consent",
                "agent_id": f"developer:{APP_ID}",
                "issued_at": LINKED_AT_MS,
            },
            {"scope": "attr.identity.name"},
            False,
        )

    async def validate(*_args, **_kwargs):
        return (
            True,
            None,
            SimpleNamespace(
                user_id="firebase-user",
                agent_id=f"developer:{APP_ID}",
                scope_str="attr.identity.name",
                issued_at=LINKED_AT_MS,
            ),
        )

    class NoOldExportLookup:
        async def get_consent_export(self, _consent_token):
            raise AssertionError("old consent must fail before export lookup")

    monkeypatch.setattr(developer, "_resolve_strict_covering_active_token", covering)
    status_response = await developer.get_consent_status(
        request=_request("/api/v1/consent-status"),
        user_id="firebase-user",
        scope="attr.identity.name",
        request_id=None,
        token=None,
        authorization="Bearer product-token",
    )
    assert status_response.status == "requires_reconsent"
    assert status_response.consent_token is None

    monkeypatch.setattr(developer, "validate_token_with_db", validate)
    monkeypatch.setattr(developer, "ConsentDBService", NoOldExportLookup)
    with pytest.raises(HTTPException) as error:
        await developer._load_scoped_export_or_raise(
            request=_request("/api/v1/scoped-export", method="POST"),
            token=None,
            authorization="Bearer product-token",
            user_id="firebase-user",
            consent_token="pre-revocation-consent",  # noqa: S106 - inert test value
            expected_scope="attr.identity.name",
        )
    assert error.value.status_code == 403
    assert error.value.detail["error_code"] == "CONSENT_REQUIRED"


@pytest.mark.asyncio
async def test_revoked_product_link_blocks_every_consent_path(
    monkeypatch: pytest.MonkeyPatch,
):
    class RevokedService:
        async def get_link_status(self, **_values):
            return {"state": "LINK_REQUIRED", "linked": False}

    monkeypatch.setattr(developer, "HushhTechClientService", RevokedService)
    monkeypatch.setattr(developer, "_resolve_principal", lambda **_: _principal())
    with pytest.raises(HTTPException) as error:
        await developer.get_consent_status(
            request=_request("/api/v1/consent-status"),
            user_id="firebase-user",
            scope="attr.identity.name",
            request_id=None,
            token=None,
            authorization="Bearer product-token",
        )
    assert error.value.status_code == 403
    assert error.value.detail["error_code"] == "LINK_REQUIRED"


@pytest.mark.asyncio
async def test_disabled_product_cohort_blocks_consent_before_lookup(
    monkeypatch: pytest.MonkeyPatch,
):
    class DisabledService:
        async def get_link_status(self, **_values):
            raise HushhTechClientError(
                "FEATURE_DISABLED",
                "Hushh Tech entry is not enabled.",
                status_code=403,
            )

    monkeypatch.setattr(developer, "HushhTechClientService", DisabledService)
    with pytest.raises(HTTPException) as error:
        await developer._require_hushh_tech_consent_access(
            _principal(),
            "firebase-user",
        )
    assert error.value.detail["error_code"] == "FEATURE_DISABLED"


@pytest.mark.parametrize(
    "principal",
    [
        _principal(groups=("core_consent",)),
        _principal(groups=(TOOL_GROUP_HUSHH_TECH_CLIENT, "ria_read")),
        _principal(capabilities=("cap.one.invoke",)),
        DeveloperPrincipal(
            app_id="another-app",
            agent_id="developer:another-app",
            display_name="Another app",
            allowed_tool_groups=(TOOL_GROUP_HUSHH_TECH_CLIENT,),
        ),
    ],
)
def test_broader_or_wrong_product_registration_is_denied(
    monkeypatch: pytest.MonkeyPatch,
    principal: DeveloperPrincipal,
):
    monkeypatch.setenv("HUSSH_TECH_DEVELOPER_APP_ID", APP_ID)
    monkeypatch.setattr(hushh_tech, "authenticate_developer_principal", lambda **_: principal)
    request = type("Request", (), {"client": None, "headers": {}})()
    with pytest.raises(HTTPException) as error:
        hushh_tech._require_product_principal(
            request=request,
            developer_token="token",  # noqa: S106 - inert test value
        )
    assert error.value.status_code == 403
    assert error.value.detail["code"] == "FEATURE_DISABLED"


@pytest.mark.asyncio
async def test_recent_auth_rejects_stale_wrong_and_future_claims(monkeypatch: pytest.MonkeyPatch):
    now = int(time.time())
    claims = {"uid": "firebase-user", "auth_time": now}

    from firebase_admin import auth as firebase_auth

    monkeypatch.setattr(firebase_auth, "verify_id_token", lambda *_, **__: dict(claims))
    monkeypatch.setattr(hushh_tech, "get_firebase_auth_app", lambda: object())

    async def immediate(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(hushh_tech, "run_in_threadpool", immediate)
    await hushh_tech._require_recent_firebase_auth(
        authorization="Bearer id-token",
        firebase_uid="firebase-user",
        now_seconds=now,
    )

    for bad_claims in (
        {"uid": "other-user", "auth_time": now},
        {"uid": "firebase-user", "auth_time": now - 301},
        {"uid": "firebase-user", "auth_time": now + 31},
        {"uid": "firebase-user"},
    ):
        claims.clear()
        claims.update(bad_claims)
        with pytest.raises(HTTPException) as error:
            await hushh_tech._require_recent_firebase_auth(
                authorization="Bearer id-token",
                firebase_uid="firebase-user",
                now_seconds=now,
            )
        assert error.value.status_code == 401
        assert error.value.detail["code"] == "UNAUTHENTICATED"


def test_route_never_imports_or_forwards_owner_token_or_connector_private_key():
    source = __import__("inspect").getsource(hushh_tech)
    assert "require_vault_owner_token" not in source
    assert "X-Hushh-Consent" not in source
    assert "connector_private_key" not in source
    assert "owner_token" not in source

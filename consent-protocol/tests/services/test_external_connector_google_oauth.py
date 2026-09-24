"""Cryptographic identity and bounded provider contracts, no live Google grants."""

from __future__ import annotations

import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from hushh_mcp.services import external_connector_google_oauth as oauth


@pytest.fixture
def service():
    return oauth.ExternalConnectorGoogleOAuth(
        db=None, registry=None, credentials=None, state_codec=None, lifecycle=SimpleNamespace()
    )


@pytest.fixture(scope="module")
def identity_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def signed_identity(identity_key, monkeypatch):
    public_key = (
        identity_key.public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        .decode()
    )

    def certificates(*args, **kwargs):
        return SimpleNamespace(status=200, data=json.dumps({"synthetic-key": public_key}).encode())

    monkeypatch.setattr(oauth._BoundedIdentityRequest, "__call__", certificates)
    claims = {
        "iss": "https://accounts.google.com",
        "aud": "dedicated-client",
        "azp": "dedicated-client",
        "sub": "synthetic-subject",
        "email": "synthetic@example.invalid",
        "email_verified": True,
        "nonce": "synthetic-nonce",
        "iat": int(time.time()),
        "exp": int(time.time()) + 300,
    }

    def sign(overrides=None):
        return jwt.encode(
            {**claims, **(overrides or {})},
            identity_key,
            algorithm="RS256",
            headers={"kid": "synthetic-key"},
        )

    return sign


def test_official_google_verifier_accepts_signed_matching_identity(service, signed_identity):
    assert service._verify_identity(
        signed_identity(), client_id="dedicated-client", nonce="synthetic-nonce"
    ) == {
        "subject": "synthetic-subject",
        "accountLabel": "synthetic@example.invalid",
    }


@pytest.mark.parametrize(
    "override",
    [
        {"aud": "other-client"},
        {"azp": "other-client"},
        {"iss": "https://attacker.invalid"},
        {"nonce": "other-attempt"},
        {"exp": 1},
        {"email_verified": False},
        {"sub": ""},
    ],
)
def test_official_google_verifier_rejects_wrong_identity_claims(service, signed_identity, override):
    with pytest.raises(oauth.DriveOAuthError, match="identity_not_verified") as caught:
        service._verify_identity(
            signed_identity(override), client_id="dedicated-client", nonce="synthetic-nonce"
        )
    assert "synthetic" not in str(caught.value)


def test_official_google_verifier_rejects_bad_signature(service, signed_identity):
    encoded = signed_identity()
    parts = encoded.split(".")
    parts[-1] = ("A" if parts[-1][0] != "A" else "B") + parts[-1][1:]
    with pytest.raises(oauth.DriveOAuthError, match="identity_not_verified"):
        service._verify_identity(
            ".".join(parts), client_id="dedicated-client", nonce="synthetic-nonce"
        )


@pytest.mark.parametrize(
    "change",
    [
        {"scope": ""},
        {"scope": None},
        {"expires_in": -1},
        {"expires_in": True},
        {"expires_in": 9999999},
        {"token_type": "Basic"},
        {"access_token": ""},
    ],
)
def test_token_envelope_requires_real_scopes_bearer_and_bounded_expiry(service, change):
    token = {
        "access_token": "synthetic-access",
        "token_type": "Bearer",
        "expires_in": 3600,
        "scope": " ".join(oauth.SCOPES),
        **change,
    }
    with pytest.raises(oauth.DriveOAuthError):
        service._token_fields(token)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,error,expected",
    [
        (400, "invalid_grant", "grant_rejected"),
        (429, "quota", "provider_unavailable"),
        (500, "internal", "provider_unavailable"),
        (302, "redirect", "provider_unavailable"),
    ],
)
async def test_provider_errors_are_redacted_and_never_redirect(
    service, monkeypatch, status, error, expected
):
    original = httpx.AsyncClient
    seen = []

    def handler(request):
        seen.append(str(request.url))
        assert "synthetic-secret" not in str(request.url)
        return httpx.Response(
            status,
            headers={"Location": "https://attacker.invalid"},
            json={"error": error, "error_description": "private provider account details"},
        )

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: original(**kwargs, transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(oauth.DriveOAuthError, match=expected) as caught:
        await service._post(oauth.TOKEN_URL, {"code": "synthetic-secret"})
    assert "private" not in str(caught.value)
    assert seen == [oauth.TOKEN_URL]


@pytest.mark.asyncio
async def test_provider_body_is_bounded_before_json_parsing(service, monkeypatch):
    original = httpx.AsyncClient

    class Oversized(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"x" * (oauth.RESPONSE_LIMIT + 1)
            raise AssertionError("must stop reading immediately at response budget")

    def handler(request):
        return httpx.Response(200, stream=Oversized())

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: original(**kwargs, transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(oauth.DriveOAuthError, match="provider_response_too_large"):
        await service._post(oauth.TOKEN_URL, {"code": "synthetic-code"})


@pytest.mark.asyncio
async def test_caller_cannot_choose_provider_endpoint(service):
    with pytest.raises(oauth.DriveOAuthError, match="connector_configuration_invalid"):
        await service._post("https://attacker.invalid", {})


@pytest.mark.parametrize(
    "scope",
    [
        "openid email https://www.googleapis.com/auth/drive.readonly",
        " ".join(oauth.SCOPES) + " https://www.googleapis.com/auth/drive",
        " ".join(oauth.SCOPES) + " https://www.googleapis.com/auth/gmail.readonly",
    ],
)
def test_selected_file_consent_rejects_read_all_and_combined_mail_grants(service, scope):
    with pytest.raises(oauth.DriveOAuthError):
        service._token_fields(
            {
                "access_token": "synthetic",
                "token_type": "Bearer",
                "expires_in": 3600,
                "scope": scope,
            }
        )


@pytest.mark.parametrize("scope", [oauth.LIVE_SCOPES, oauth.REGISTRY_SCOPES])
def test_live_consent_accepts_drive_with_optional_prior_selected_scope(service, scope):
    credential = service._token_fields(
        {
            "access_token": "synthetic",
            "token_type": "Bearer",
            "expires_in": 3600,
            "scope": " ".join(scope),
        },
        profile="live",
    )
    assert oauth.LIVE_DRIVE_SCOPE in credential["grantedScopes"]


@pytest.mark.asyncio
async def test_live_verification_requires_a_drive_search_before_marking_connected(
    service, monkeypatch
):
    from hushh_mcp.services import google_drive_rest_transport as rest

    monkeypatch.setattr(oauth, "connector_feature_enabled", lambda *_: True)
    service.current_credential = AsyncMock(
        return_value=(
            {"connection_generation": 7, "credential_version": 3},
            {"accessToken": "synthetic"},
        )
    )
    account = AsyncMock()
    probe = AsyncMock(side_effect=oauth.DriveOAuthError("connector_unavailable", status_code=502))
    monkeypatch.setattr(oauth.GoogleDriveAdapter, "account", account)
    monkeypatch.setattr(rest.GoogleDriveRestTransport, "probe", probe)
    service.lifecycle.mark_verified = AsyncMock()
    with pytest.raises(oauth.DriveOAuthError, match="connector_unavailable"):
        await service.verify_live(user_id="owner")
    account.assert_awaited_once()
    probe.assert_awaited_once()
    service.lifecycle.mark_verified.assert_not_awaited()
    probe.side_effect = None
    assert (
        await service.verify_live(user_id="owner") is service.lifecycle.mark_verified.return_value
    )

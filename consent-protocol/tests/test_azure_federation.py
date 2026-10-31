"""Hussh's Azure app identity by federation: no client secret, the exact request shape."""

from __future__ import annotations

import base64
import json

import pytest

from hushh_mcp.services import azure_federation as federation

_TENANT = "11111111-1111-1111-1111-111111111111"
_APP = "33333333-3333-3333-3333-333333333333"
_BROKER = "azure-broker@hushh-pda-dev.iam.gserviceaccount.com"
_ASSERTION = "google-id-token-for-tests"


def _jwt(claims: dict) -> str:
    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"header.{body}.signature"


class _Response:
    def __init__(self, status: int, body=None, text: str = "") -> None:
        self.status_code = status
        self._body = body or {}
        self.text = text

    def json(self):
        return self._body


class _Session:
    def __init__(self, posts=(), gets=()) -> None:
        self.posts = list(posts)
        self.gets = list(gets)
        self.posted: list[dict] = []
        self.got: list[dict] = []

    def post(self, url, data=None, json=None, headers=None, timeout=None):
        self.posted.append({"url": url, "data": data, "json": json, "headers": headers})
        return self.posts.pop(0)

    def get(self, url, headers=None, params=None, timeout=None):
        self.got.append({"url": url, "headers": headers, "params": params})
        return self.gets.pop(0)


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setenv("HUSSH_AZURE_APP_CLIENT_ID", _APP)
    monkeypatch.setenv("HUSSH_AZURE_BROKER_SA", _BROKER)


def test_the_app_token_request_is_a_federated_client_assertion_and_nothing_else():
    token = _jwt({"oid": "44444444-4444-4444-4444-444444444444", "tid": _TENANT})
    session = _Session(posts=[_Response(200, {"access_token": token, "expires_in": 3599})])
    result = federation.app_token(_TENANT, session=session, assertion=lambda: _ASSERTION)
    sent = session.posted[0]
    assert sent["url"] == f"https://login.microsoftonline.com/{_TENANT}/oauth2/v2.0/token"
    assert sent["data"] == {
        "grant_type": "client_credentials",
        "scope": "https://management.azure.com/.default",
        "client_id": _APP,
        "client_assertion_type": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        "client_assertion": _ASSERTION,
    }
    assert "client_secret" not in sent["data"]
    assert result.object_id == "44444444-4444-4444-4444-444444444444"
    assert result.expires_in == 3599


def test_an_unsettled_federated_credential_is_retried_with_backoff():
    token = _jwt({"oid": "o"})
    refused = _Response(400, {"error": "invalid_client", "error_codes": [70021]})
    session = _Session(posts=[refused, refused, _Response(200, {"access_token": token})])
    sleeps: list[float] = []
    federation.app_token(
        _TENANT, session=session, sleep=sleeps.append, assertion=lambda: _ASSERTION
    )
    assert sleeps == list(federation.FEDERATION_SETTLE_DELAYS[:2])
    assert len(session.posted) == 3


def test_a_federation_that_never_settles_is_typed():
    refused = _Response(400, {"error": "invalid_client", "error_codes": [70021]})
    session = _Session(posts=[refused] * (len(federation.FEDERATION_SETTLE_DELAYS) + 1))
    with pytest.raises(federation.AzureFederationError) as exc:
        federation.app_token(
            _TENANT, session=session, sleep=lambda _s: None, assertion=lambda: _ASSERTION
        )
    assert exc.value.code == "FEDERATION_NOT_SETTLED"


def test_any_other_refusal_is_not_retried():
    session = _Session(
        posts=[_Response(401, {"error": "unauthorized_client", "error_codes": [700016]})]
    )
    with pytest.raises(federation.AzureFederationError) as exc:
        federation.app_token(_TENANT, session=session, assertion=lambda: _ASSERTION)
    assert exc.value.code == "EXCHANGE_REFUSED"
    assert len(session.posted) == 1


def test_code_redemption_authenticates_the_app_by_assertion_with_pkce():
    session = _Session(posts=[_Response(200, {"access_token": _jwt({"tid": _TENANT})})])
    federation.redeem_authorization_code(
        _TENANT,
        code="single-use",
        redirect_uri="https://app.example/one/setup/cloud/azure/return",
        code_verifier="v" * 64,
        scope="https://management.azure.com/user_impersonation",
        session=session,
        assertion=lambda: _ASSERTION,
    )
    data = session.posted[0]["data"]
    assert data["grant_type"] == "authorization_code"
    assert data["code_verifier"] == "v" * 64
    assert data["client_assertion"] == _ASSERTION
    assert "client_secret" not in data
    assert "offline_access" not in data["scope"]


@pytest.mark.parametrize("bad", ["", "contoso.com", "../x", "common/../x"])
def test_only_a_tenant_id_reaches_the_token_url(bad):
    with pytest.raises(federation.AzureFederationError):
        federation.app_token(bad or "", session=_Session(), assertion=lambda: _ASSERTION)


def test_missing_configuration_is_typed(monkeypatch):
    monkeypatch.delenv("HUSSH_AZURE_APP_CLIENT_ID")
    with pytest.raises(federation.AzureFederationError) as exc:
        federation.app_client_id()
    assert exc.value.code == "NOT_CONFIGURED"
    monkeypatch.setenv("HUSSH_AZURE_BROKER_SA", "not-a-service-account")
    with pytest.raises(federation.AzureFederationError):
        federation.broker_service_account()


def test_the_metadata_server_is_used_only_when_the_attached_identity_is_the_broker():
    session = _Session(gets=[_Response(200, text=_BROKER), _Response(200, text="minted")])
    assert federation.google_assertion(session=session) == "minted"
    assert session.got[1]["params"] == {"audience": "api://AzureADTokenExchange", "format": "full"}


def test_a_different_attached_identity_mints_through_iam_credentials(monkeypatch):
    from hushh_mcp.services import pod_image_copy

    monkeypatch.setattr(pod_image_copy, "attached_identity", lambda: ("hub-access", "hub@x"))
    session = _Session(
        gets=[_Response(200, text="consent-plane@hushh-pda-dev.iam.gserviceaccount.com")],
        posts=[_Response(200, {"token": "broker-id-token"})],
    )
    assert federation.google_assertion(session=session) == "broker-id-token"
    sent = session.posted[0]
    assert sent["url"].endswith(f"/serviceAccounts/{_BROKER}:generateIdToken")
    assert sent["json"] == {"audience": "api://AzureADTokenExchange", "includeEmail": True}
    assert sent["headers"] == {"Authorization": "Bearer hub-access"}


def test_token_claims_reads_but_never_verifies():
    assert federation.token_claims(_jwt({"tid": _TENANT}))["tid"] == _TENANT
    with pytest.raises(federation.AzureFederationError):
        federation.token_claims("not-a-jwt")

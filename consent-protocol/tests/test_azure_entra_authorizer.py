"""Connect Azure sign-in: caller-bound state, PKCE, online-only, tenant discovery."""

from __future__ import annotations

import base64
import hashlib
import json
import time
import urllib.parse

import pytest

from hushh_mcp.services import azure_entra_authorizer as entra

_TENANT = "11111111-1111-1111-1111-111111111111"
_SUBSCRIPTION = "22222222-2222-2222-2222-222222222222"
_APP = "33333333-3333-3333-3333-333333333333"
_REDIRECT = "https://app.example/one/setup/cloud/azure/return"


def _jwt(claims: dict) -> str:
    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"h.{body}.s"


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setenv("HUSSH_AZURE_APP_CLIENT_ID", _APP)
    monkeypatch.setenv("HUSSH_AZURE_OAUTH_REDIRECT_URI", _REDIRECT)


class _Challenge:
    """ARM's unauthenticated answer for a subscription: a 401 naming its directory."""

    def __init__(self, status=401, tenant=_TENANT):
        self.status_code = status
        self.headers = {
            "WWW-Authenticate": (
                f'Bearer authorization_uri="https://login.windows.net/{tenant}", '
                'error="invalid_token", error_description="missing Authorization header"'
            )
        }


class _ChallengeSession:
    def __init__(self, response):
        self.response = response
        self.urls: list[str] = []

    def get(self, url, params=None, timeout=None):
        self.urls.append(url)
        return self.response


def _query(url: str) -> dict[str, str]:
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))


def test_a_setup_with_no_directory_first_only_identifies_the_account():
    url = entra.begin("uid-1")
    query = _query(url)
    # Through `common` a personal account cannot reach Azure at all (AADSTS900144), so
    # the first leg asks only who the person is, and grants nothing they own.
    assert url.startswith("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?")
    assert query["scope"] == "openid email profile"
    assert "management.azure.com" not in url and "offline_access" not in url
    assert query["prompt"] == "select_account"
    assert entra.verify_state(query["state"], "uid-1").kind == "discover"


def test_the_azure_leg_signs_in_at_the_directory_as_the_identified_account():
    url = entra.begin("uid-1", tenant_id=_TENANT, login_hint="person@example.com")
    query = _query(url)
    assert url.startswith(f"https://login.microsoftonline.com/{_TENANT}/oauth2/v2.0/authorize?")
    assert query["scope"] == "https://management.azure.com/user_impersonation"
    # The same account, so Microsoft does not ask a second time.
    assert query["login_hint"] == "person@example.com" and "prompt" not in query
    assert entra.verify_state(query["state"], "uid-1").kind == "setup"


def test_the_consent_url_asks_for_arm_only_with_pkce_and_no_refresh_token():
    url = entra.begin("uid-1", tenant_id=_TENANT)
    query = _query(url)
    assert url.startswith(f"https://login.microsoftonline.com/{_TENANT}/oauth2/v2.0/authorize?")
    assert query["scope"] == "https://management.azure.com/user_impersonation"
    assert "offline_access" not in url
    assert query["code_challenge_method"] == "S256"
    assert query["client_id"] == _APP and query["redirect_uri"] == _REDIRECT
    verifier = entra.code_verifier(query["state"])
    digest = hashlib.sha256(verifier.encode()).digest()
    assert query["code_challenge"] == base64.urlsafe_b64encode(digest).decode().rstrip("=")
    assert 43 <= len(verifier) <= 128


def test_a_named_subscription_discovers_its_directory_and_signs_in_there():
    session = _ChallengeSession(_Challenge())
    url = entra.begin("uid-1", subscription_id=_SUBSCRIPTION, session=session)
    assert url.startswith(f"https://login.microsoftonline.com/{_TENANT}/oauth2/v2.0/authorize?")
    assert session.urls == [f"https://management.azure.com/subscriptions/{_SUBSCRIPTION}"]
    selection = entra.verify_state(_query(url)["state"], "uid-1")
    assert (selection.authority, selection.subscription_id) == (_TENANT, _SUBSCRIPTION)


@pytest.mark.parametrize("response", [_Challenge(status=404), _Challenge(tenant="nope")])
def test_an_unrecognized_subscription_is_refused(response):
    with pytest.raises(entra.AzureAuthorizeError) as exc:
        entra.discover_tenant_for_subscription(_SUBSCRIPTION, session=_ChallengeSession(response))
    assert exc.value.code == "BAD_SUBSCRIPTION"


def test_the_state_completes_only_for_the_caller_who_began_it():
    state = entra.make_state("uid-1", kind="setup", subscription_id="", authority="common")
    assert entra.verify_state(state, "uid-1").kind == "setup"
    with pytest.raises(entra.AzureAuthorizeError) as exc:
        entra.verify_state(state, "uid-2")
    assert exc.value.code == "BAD_STATE"


def test_a_tampered_state_is_refused():
    state = entra.make_state("uid-1", kind="setup", subscription_id="", authority="common")
    exp, payload, mac = state.removeprefix("azure.").split(".", 2)
    forged_payload = base64.urlsafe_b64encode(b"uid-1|upgrade||common|n").decode().rstrip("=")
    for forged in (f"azure.{exp}.{forged_payload}.{mac}", f"azure.{int(exp) + 9}.{payload}.{mac}"):
        with pytest.raises(entra.AzureAuthorizeError):
            entra.verify_state(forged, "uid-1")


def test_an_expired_state_is_refused(monkeypatch):
    state = entra.make_state("uid-1", kind="upgrade", subscription_id="", authority=_TENANT)
    real = time.time
    monkeypatch.setattr(entra.time, "time", lambda: real() + entra.STATE_TTL_SECONDS + 5)
    with pytest.raises(entra.AzureAuthorizeError) as exc:
        entra.verify_state(state, "uid-1")
    assert exc.value.code == "STATE_EXPIRED"


def test_a_gcp_state_is_not_an_azure_state():
    with pytest.raises(entra.AzureAuthorizeError):
        entra.verify_state("byoc.123.abc.def", "uid-1")


def test_redeem_sends_the_states_verifier_and_drops_any_refresh_token(monkeypatch):
    sent: dict = {}

    def fake_redeem(authority, **kwargs):
        sent.update(authority=authority, **kwargs)
        return {
            "access_token": _jwt({"tid": _TENANT}),
            "expires_in": 3600,
            "refresh_token": "must-never-be-kept",
        }

    monkeypatch.setattr(entra.federation, "redeem_authorization_code", fake_redeem)
    state = entra.make_state("uid-1", kind="setup", subscription_id="", authority=_TENANT)
    token = entra.redeem(state, entra.verify_state(state, "uid-1"), "code-1")
    assert sent["code_verifier"] == entra.code_verifier(state)
    assert sent["authority"] == _TENANT and sent["code"] == "code-1"
    assert token.tenant_id == _TENANT
    assert "must-never-be-kept" not in repr(token) and not hasattr(token, "refresh_token")
    assert token.access_token not in repr(token)


def test_a_token_from_another_directory_is_refused(monkeypatch):
    monkeypatch.setattr(
        entra.federation,
        "redeem_authorization_code",
        lambda authority, **_: {
            "access_token": _jwt({"tid": "99999999-9999-9999-9999-999999999999"})
        },
    )
    state = entra.make_state("uid-1", kind="upgrade", subscription_id="", authority=_TENANT)
    with pytest.raises(entra.AzureAuthorizeError) as exc:
        entra.redeem(state, entra.verify_state(state, "uid-1"), "code-1")
    assert exc.value.code == "BAD_TENANT"


def test_a_personal_account_token_is_recognized():
    assert entra.is_personal_account(entra.DelegatedToken("t", entra.CONSUMER_TENANT, 1))
    assert not entra.is_personal_account(entra.DelegatedToken("t", _TENANT, 1))


@pytest.mark.parametrize("bad", ["", "http://app.example/return", "javascript:alert(1)"])
def test_the_return_address_must_be_https_or_localhost(monkeypatch, bad):
    monkeypatch.setenv("HUSSH_AZURE_OAUTH_REDIRECT_URI", bad)
    with pytest.raises(entra.AzureAuthorizeError) as exc:
        entra.redirect_uri()
    assert exc.value.code == "NOT_CONFIGURED"
    monkeypatch.setenv("HUSSH_AZURE_OAUTH_REDIRECT_URI", "http://localhost:3000/return")
    assert entra.redirect_uri() == "http://localhost:3000/return"


def test_the_discover_leg_yields_who_signed_in_and_keeps_no_token(monkeypatch):
    sent: dict = {}

    def fake_redeem(authority, **kwargs):
        sent.update(authority=authority, **kwargs)
        claims = {"tid": entra.CONSUMER_TENANT, "preferred_username": "person@gmail.com"}
        return {"id_token": _jwt(claims), "access_token": "graph-token-never-kept"}

    monkeypatch.setattr(entra.federation, "redeem_authorization_code", fake_redeem)
    state = entra.make_state("uid-1", kind="discover", subscription_id="", authority="common")
    account = entra.redeem_discovery(state, entra.verify_state(state, "uid-1"), "code-1")
    assert sent["scope"] == "openid email profile" and sent["authority"] == "common"
    assert account.tenant_id == entra.CONSUMER_TENANT
    assert account.login_hint == "person@gmail.com"
    assert "graph-token-never-kept" not in repr(account) and "person@gmail.com" not in repr(account)


def test_legs_cannot_be_swapped(monkeypatch):
    monkeypatch.setattr(entra.federation, "redeem_authorization_code", lambda *a, **k: {})
    discover = entra.make_state("uid-1", kind="discover", subscription_id="", authority="common")
    setup = entra.make_state("uid-1", kind="setup", subscription_id="", authority=_TENANT)
    with pytest.raises(entra.AzureAuthorizeError):
        entra.redeem(discover, entra.verify_state(discover, "uid-1"), "code-1")
    with pytest.raises(entra.AzureAuthorizeError):
        entra.redeem_discovery(setup, entra.verify_state(setup, "uid-1"), "code-1")

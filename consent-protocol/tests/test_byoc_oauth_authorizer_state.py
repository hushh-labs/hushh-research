"""The one-click authorize round-trip state: signed, expiring, caller-bound."""

from __future__ import annotations

import pytest

from hushh_mcp.services.byoc_oauth_authorizer import (
    ByocAuthorizeError,
    make_state,
    verify_state,
)


@pytest.fixture(autouse=True)
def _signing_key(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test-signing-key-32-bytes-long!!")


def test_state_round_trips_for_the_same_caller():
    state = make_state("uid1", "hussh-one-kt3d9x")
    assert verify_state(state, "uid1") == "hussh-one-kt3d9x"


def test_state_refuses_a_different_caller():
    state = make_state("uid1", "hussh-one-kt3d9x")
    with pytest.raises(ByocAuthorizeError):
        verify_state(state, "somebody-else")


def test_state_refuses_tampering():
    state = make_state("uid1", "hussh-one-kt3d9x")
    with pytest.raises(ByocAuthorizeError):
        verify_state(state[:-4] + "0000", "uid1")


def test_state_expires(monkeypatch):
    import hushh_mcp.services.byoc_oauth_authorizer as mod

    real_time = mod.time.time
    state = make_state("uid1", "p")
    monkeypatch.setattr(mod.time, "time", lambda: real_time() + 700)
    with pytest.raises(ByocAuthorizeError):
        verify_state(state, "uid1")


# ---- the redirect URI: canonical google return, never the Gmail door -----------------


class _Svc:
    """The one config source, stubbed at the seam the authorizer actually uses."""

    def _client_id(self):
        return "client-id"

    def _client_secret(self):
        return "client-secret"

    def _redirect_uri(self, _supplied):
        return "https://dev.one.hushh.ai/one/profile/google/oauth/return"


@pytest.fixture
def _stub_google_service(monkeypatch):
    import hushh_mcp.services.google_connection_service as gcs

    monkeypatch.setattr(gcs, "GoogleConnectionService", lambda: _Svc())
    return _Svc()


def test_the_authorize_url_uses_the_canonical_google_return(monkeypatch, _stub_google_service):
    """Not the Gmail door. Borrowing it sent an unregistered URI on dev and Google
    refused the flow (`redirect_uri_mismatch`, founder 2026-09-03)."""
    import urllib.parse

    from hushh_mcp.services.byoc_oauth_authorizer import begin

    monkeypatch.delenv("GOOGLE_OAUTH_REDIRECT_URI", raising=False)
    monkeypatch.setenv(
        "GMAIL_OAUTH_REDIRECT_URI", "https://dev.one.hushh.ai/one/profile/gmail/oauth/return"
    )
    url = begin("uid1", "hussh-one-test")
    sent = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["redirect_uri"][0]
    assert sent == "https://dev.one.hushh.ai/one/profile/google/oauth/return"
    assert "gmail" not in sent


def test_an_explicit_generic_setting_still_wins(monkeypatch, _stub_google_service):
    import urllib.parse

    from hushh_mcp.services.byoc_oauth_authorizer import begin

    monkeypatch.setenv(
        "GOOGLE_OAUTH_REDIRECT_URI", "https://other.example/one/profile/google/oauth/return"
    )
    url = begin("uid1", "hussh-one-test")
    sent = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["redirect_uri"][0]
    assert sent == "https://other.example/one/profile/google/oauth/return"

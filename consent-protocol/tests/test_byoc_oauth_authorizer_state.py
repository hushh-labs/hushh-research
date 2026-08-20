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

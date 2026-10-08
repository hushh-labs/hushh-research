"""Cross-tier auth-outage contract: a transient Firebase-provider outage must
surface a STABLE typed code the client can key off, so users are not signed out
during a blip. Guards against the message drifting away from what the client
matches.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException


def _raise_cert_fetch(*_args, **_kwargs):
    from firebase_admin import auth as firebase_auth

    # Build the real class without invoking its constructor (signature varies by
    # SDK version); set args so str()/logging works.
    exc = firebase_auth.CertificateFetchError.__new__(firebase_auth.CertificateFetchError)
    exc.args = ("certificate fetch failed",)
    raise exc


def test_provider_outage_returns_typed_code(monkeypatch):
    from firebase_admin import auth as firebase_auth

    from api.utils import firebase_auth as fb

    monkeypatch.setattr(fb, "get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(firebase_auth, "verify_id_token", _raise_cert_fetch)

    with pytest.raises(HTTPException) as excinfo:
        fb.verify_firebase_bearer("Bearer some-token")

    err = excinfo.value
    assert err.status_code == 503
    assert isinstance(err.detail, dict)
    assert err.detail["error_code"] == "AUTH_PROVIDER_UNAVAILABLE"
    # The code the client keys off must survive JSON-lowercasing.
    assert "auth_provider_unavailable" in str(err.detail).lower()


def test_invalid_token_still_401(monkeypatch):
    from firebase_admin import auth as firebase_auth

    from api.utils import firebase_auth as fb

    def _raise_invalid(*_a, **_k):
        raise firebase_auth.InvalidIdTokenError("bad token")

    monkeypatch.setattr(fb, "get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(firebase_auth, "verify_id_token", _raise_invalid)

    with pytest.raises(HTTPException) as excinfo:
        fb.verify_firebase_bearer("Bearer some-token")
    # A genuinely bad token is still a hard 401 (sign out), not the outage path.
    assert excinfo.value.status_code == 401

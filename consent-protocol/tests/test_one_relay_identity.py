"""Credential failures must not mint anonymous voice tickets."""

from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from api.routes.one import adk_live, relay_auth
from api.utils import firebase_auth


async def test_absent_credential_preserves_explicit_anonymous_access(monkeypatch):
    verifier = Mock(side_effect=AssertionError("must not verify absent credentials"))
    monkeypatch.setattr(firebase_auth, "verify_firebase_bearer", verifier)
    assert await relay_auth.resolve_optional_uid(None) is None
    verifier.assert_not_called()


async def test_valid_credential_keeps_verified_owner(monkeypatch):
    monkeypatch.setattr(firebase_auth, "verify_firebase_bearer", lambda header: "synthetic-owner")
    assert await relay_auth.resolve_optional_uid("Bearer synthetic-token") == "synthetic-owner"


@pytest.mark.parametrize("header", ["", "Basic synthetic", "Bearer invalid", "Bearer expired"])
async def test_supplied_invalid_credentials_do_not_mint_tickets(monkeypatch, header):
    def invalid(_header):
        raise HTTPException(status_code=401, detail="Invalid Firebase ID token")

    monkeypatch.setattr(firebase_auth, "verify_firebase_bearer", invalid)
    monkeypatch.setattr(adk_live, "one_voice_enabled", lambda: True)
    mint = Mock(side_effect=AssertionError("must not mint"))
    monkeypatch.setattr(adk_live, "issue_relay_ticket", mint)
    with pytest.raises(HTTPException) as failure:
        await adk_live.create_one_adk_relay_session.__wrapped__(request=None, authorization=header)
    assert failure.value.status_code == 401
    mint.assert_not_called()


async def test_auth_provider_outage_preserves_503_without_ticket(monkeypatch):
    def unavailable(_header):
        raise HTTPException(status_code=503, detail={"error_code": "AUTH_PROVIDER_UNAVAILABLE"})

    monkeypatch.setattr(firebase_auth, "verify_firebase_bearer", unavailable)
    monkeypatch.setattr(adk_live, "one_voice_enabled", lambda: True)
    mint = Mock(side_effect=AssertionError("must not mint"))
    monkeypatch.setattr(adk_live, "issue_relay_ticket", mint)
    with pytest.raises(HTTPException) as failure:
        await adk_live.create_one_adk_relay_session.__wrapped__(
            request=None, authorization="Bearer synthetic"
        )
    assert failure.value.status_code == 503
    assert failure.value.detail["error_code"] == "AUTH_PROVIDER_UNAVAILABLE"
    mint.assert_not_called()

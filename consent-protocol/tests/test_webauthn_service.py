"""Tests for the server-side WebAuthn ceremony engine (M14).

Option generation is exercised against real py_webauthn; the verify steps (which
need real authenticator crypto) are monkeypatched so we test THIS service's
orchestration: challenge mint/consume, expected-value plumbing, credential storage,
and sign_count updates.
"""

from __future__ import annotations

import base64
import json
import types

import pytest

from hushh_mcp.services import webauthn_service as ws
from hushh_mcp.services.webauthn_service import (
    WebAuthnService,
    WebAuthnSettings,
    _extract_challenge,
    get_webauthn_settings,
)

_SETTINGS = WebAuthnSettings(
    rp_id="one.hushh.ai", rp_name="hussh", origins=("https://one.hushh.ai",)
)


class FakeCreds:
    def __init__(self, seed=None):
        self.rows = list(seed or [])

    async def add(self, c):
        self.rows.append(c)

    async def get_by_credential_id(self, cid):
        return next((r for r in self.rows if r["credential_id"] == cid), None)

    async def list_by_user(self, uid):
        return [r for r in self.rows if r["user_id"] == uid]

    async def update_sign_count(self, cid, *, sign_count, last_used_at):
        for r in self.rows:
            if r["credential_id"] == cid:
                r["sign_count"] = sign_count
                r["last_used_at"] = last_used_at


class FakeChallenges:
    def __init__(self):
        self.rows = []

    async def save(self, **kw):
        self.rows.append(kw)

    async def consume(self, challenge):
        for i, r in enumerate(self.rows):
            if r["challenge"] == challenge:
                return self.rows.pop(i)  # one-time
        return None


def _svc(creds=None, challenges=None):
    return WebAuthnService(
        credentials=creds or FakeCreds(),
        challenges=challenges or FakeChallenges(),
        settings=_SETTINGS,
    )


def _credential(challenge_b64: str, cred_id: str = "cred-1", ceremony: str = "webauthn.create"):
    client_data = {"challenge": challenge_b64, "type": ceremony, "origin": "https://one.hushh.ai"}
    raw = base64.urlsafe_b64encode(json.dumps(client_data).encode()).decode().rstrip("=")
    return {
        "id": cred_id,
        "rawId": cred_id,
        "response": {"clientDataJSON": raw},
        "type": "public-key",
    }


def _fake_vreg(**over):
    base = dict(
        credential_id=b"cred-1-bytes",
        credential_public_key=b"pub-bytes",
        sign_count=0,
        aaguid="ee882879-721c-4913-9775-3dfcce97072a",  # a Titan-style AAGUID
        credential_device_type=types.SimpleNamespace(value="multi_device"),
        credential_backed_up=True,
        user_verified=True,
    )
    base.update(over)
    return types.SimpleNamespace(**base)


async def test_begin_registration_returns_options_and_stores_challenge():
    ch = FakeChallenges()
    opts = json.loads(await _svc(challenges=ch).begin_registration(user_id="u1", user_name="a@x"))
    assert opts["rp"]["id"] == "one.hushh.ai"
    assert opts["user"]["name"] == "a@x"
    assert len(ch.rows) == 1 and ch.rows[0]["ceremony"] == "registration"


async def test_begin_registration_excludes_existing_credentials():
    creds = FakeCreds([{"user_id": "u1", "credential_id": "AAAA"}])
    opts = json.loads(await _svc(creds=creds).begin_registration(user_id="u1", user_name="a@x"))
    assert opts.get("excludeCredentials")


async def test_begin_authentication_usernameless():
    ch = FakeChallenges()
    opts = json.loads(await _svc(challenges=ch).begin_authentication())
    assert opts["rpId"] == "one.hushh.ai"
    assert ch.rows[0]["ceremony"] == "authentication" and ch.rows[0]["user_id"] is None


async def test_finish_registration_verifies_and_stores(monkeypatch):
    creds, ch = FakeCreds(), FakeChallenges()
    svc = _svc(creds, ch)
    challenge = "Q0hBTExFTkdF"
    await ch.save(
        user_id="u1", challenge=challenge, ceremony="registration", rp_id="one.hushh.ai", ttl_s=300
    )
    captured = {}

    def _verify(**kw):
        captured.update(kw)
        return _fake_vreg()

    monkeypatch.setattr(ws, "verify_registration_response", _verify)
    out = await svc.finish_registration(user_id="u1", credential=_credential(challenge))
    # It plumbed the stored challenge + rp/origins into verify.
    assert captured["expected_rp_id"] == "one.hushh.ai"
    assert captured["expected_origin"] == ["https://one.hushh.ai"]
    # Credential stored with a public key + AAGUID; challenge was consumed (one-time).
    assert creds.rows[0]["user_id"] == "u1" and creds.rows[0]["public_key"]
    assert out["aaguid"] == "ee882879-721c-4913-9775-3dfcce97072a"
    assert ch.rows == []


async def test_finish_registration_rejects_unknown_challenge(monkeypatch):
    monkeypatch.setattr(ws, "verify_registration_response", lambda **kw: _fake_vreg())
    with pytest.raises(ValueError):
        await _svc().finish_registration(user_id="u1", credential=_credential("NOPE"))


async def test_finish_registration_rejects_ceremony_mismatch(monkeypatch):
    ch = FakeChallenges()
    await ch.save(
        user_id="u1", challenge="X", ceremony="authentication", rp_id="one.hushh.ai", ttl_s=300
    )
    monkeypatch.setattr(ws, "verify_registration_response", lambda **kw: _fake_vreg())
    with pytest.raises(ValueError):
        await _svc(challenges=ch).finish_registration(user_id="u1", credential=_credential("X"))


async def test_finish_authentication_verifies_and_updates_sign_count(monkeypatch):
    creds = FakeCreds(
        [{"user_id": "u9", "credential_id": "cred-1", "public_key": "cHVi", "sign_count": 4}]
    )
    ch = FakeChallenges()
    await ch.save(
        user_id=None, challenge="AUTHCH", ceremony="authentication", rp_id="one.hushh.ai", ttl_s=300
    )
    monkeypatch.setattr(
        ws,
        "verify_authentication_response",
        lambda **kw: types.SimpleNamespace(new_sign_count=5, user_verified=True),
    )
    out = await _svc(creds, ch).finish_authentication(credential=_credential("AUTHCH", "cred-1"))
    assert out["userId"] == "u9"
    assert creds.rows[0]["sign_count"] == 5  # advanced (no clone)


async def test_finish_authentication_unknown_credential(monkeypatch):
    ch = FakeChallenges()
    await ch.save(
        user_id=None, challenge="AUTHCH", ceremony="authentication", rp_id="one.hushh.ai", ttl_s=300
    )
    monkeypatch.setattr(
        ws, "verify_authentication_response", lambda **kw: types.SimpleNamespace(new_sign_count=1)
    )
    with pytest.raises(ValueError):
        await _svc(challenges=ch).finish_authentication(credential=_credential("AUTHCH", "ghost"))


def test_extract_challenge_parses_client_data():
    assert _extract_challenge(_credential("HELLO")) == "HELLO"


def test_settings_defaults_to_one_hushh_ai(monkeypatch):
    for k in ("WEBAUTHN_RP_ID", "WEBAUTHN_RP_NAME", "WEBAUTHN_ORIGINS"):
        monkeypatch.delenv(k, raising=False)
    s = get_webauthn_settings()
    assert s.rp_id == "one.hushh.ai"
    assert "https://one.hushh.ai" in s.origins and "https://dev.one.hushh.ai" in s.origins

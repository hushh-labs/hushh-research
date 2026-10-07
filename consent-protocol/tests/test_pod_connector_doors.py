"""The owner's connector doors over real HTTP: connect, read, disconnect.

A login is kept only after the envelope opened, Google redeemed the code with PKCE,
the account was verified, the read scope was granted and a refresh token came back.
Every refusal says one code, keeps nothing, and revokes at Google anything Google
already issued. The hub's consent token never opens these doors, admission settles
before the body is read, and no code, verifier or token reaches a response or a log.
"""

from __future__ import annotations

# ruff: noqa: S106 -- `consent_token="hub-consent"` names a test fixture, not a credential.
import base64
import json
import logging
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.routes.one import pod_connectors, pod_session, pod_turn
from hushh_mcp.services import (
    pod_connector_credentials,
    pod_consent_client,
    pod_google_oauth,
    pod_hub_client,
    pod_memory_service,
    pod_self_registration,
)
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
from hushh_mcp.services.pod_connector_credential_seal import seal_connector_credential
from hushh_mcp.services.pod_connector_keypair_service import PodKeyPair
from hushh_mcp.services.pod_consent_client import ConsentVerdict
from hushh_mcp.services.pod_sealed_envelope import b64url_decode
from hushh_mcp.services.pod_session_authority import (
    LOCAL_TOKEN_PREFIX,
    SCOPE_POD_CONFIG,
    SCOPE_POD_STATUS,
)

VECTOR = json.loads(
    (Path(__file__).parent / "fixtures" / "connector_credential_seal_vector_v1.json").read_text()
)
OWNER = VECTOR["aad"]["hushhId"]
CLIENT = VECTOR["plaintext"]["clientId"]
CODE = VECTOR["plaintext"]["code"]
VERIFIER = VECTOR["plaintext"]["codeVerifier"]
REFRESH = "1//refresh-secret-never-echoed"
ACCESS = "ya29.access-secret-never-echoed"
POD = X25519PrivateKey.from_private_bytes(b64url_decode(VECTOR["podPrivateKey"]))
PATH = "/api/one/pod/connectors/gmail"
OWNER_SESSION = {"Authorization": "Bearer pod-session-fixture"}
HUB = {"X-Consent-Token": "hub-consent"}
_CLAIMS = {"role": "app", "scopes": [SCOPE_POD_CONFIG, SCOPE_POD_STATUS]}
TRANSITION = {"id": "gct_" + "a" * 32, "nonce": "b" * 43}
G = "https://www.googleapis.com/auth/"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _id_token(**claims: Any) -> str:
    body = {
        "iss": "https://accounts.google.com",
        "aud": CLIENT,
        "sub": "1098765432",
        "exp": int(time.time()) + 600,
        **claims,
    }
    part = base64.urlsafe_b64encode(json.dumps(body).encode()).rstrip(b"=").decode()
    return f"e30.{part}.sig"


def _envelope(issued_at: int | None = None, **plaintext: Any) -> dict:
    sealed = seal_connector_credential(
        {**VECTOR["plaintext"], **plaintext},
        pod_public_key_raw=b64url_decode(VECTOR["podPublicKey"]),
        aad={**VECTOR["aad"], "issuedAtMs": issued_at or _now_ms()},
    )
    return {"envelope": sealed, "transition": TRANSITION}


class _Google:
    """Google's token and revoke endpoints, scripted, remembering every call."""

    def __init__(self) -> None:
        self.token_answer: tuple[int, dict] = (
            200,
            {
                "access_token": ACCESS,
                "refresh_token": REFRESH,
                "expires_in": 3600,
                "scope": f"openid email {G}gmail.readonly",
                "id_token": _id_token(),
            },
        )
        self.revoke_status = 200
        self.calls: list[tuple[str, dict]] = []

    async def __call__(self, url: str, form: Any) -> tuple[int, dict]:
        self.calls.append((url, dict(form)))
        if url == pod_google_oauth.REVOKE_URL:
            return self.revoke_status, {}
        return self.token_answer

    def revoked(self) -> list[str]:
        return [form["token"] for url, form in self.calls if url == pod_google_oauth.REVOKE_URL]


async def _owner_verifier(_token: str, *, expected_scope: str) -> ConsentVerdict:
    return ConsentVerdict(True, True, "owner-uid", OWNER, expected_scope)


class _OwnerSession:
    held_checks = 0

    def local_token(self, _claims: dict) -> str:
        return LOCAL_TOKEN_PREFIX + "fixture"

    def local_verifier(self, _claims: dict) -> Any:
        return _owner_verifier

    async def require_held(self) -> None:
        type(self).held_checks += 1


@pytest.fixture
def pod(monkeypatch, tmp_path):
    log = PodCommitLog(LocalObjectStore(str(tmp_path / "store")), b"\x42" * 32, owner_id=OWNER)
    keypair = PodKeyPair(
        private_key=POD,
        public_key_b64=base64.b64encode(b64url_decode(VECTOR["podPublicKey"])).decode(),
        key_id=VECTOR["podKeyId"],
    )
    google = _Google()
    monkeypatch.setenv("HUSSH_ID", OWNER)
    monkeypatch.setenv("GOOGLE_IOS_CONNECTOR_CLIENT_ID", CLIENT)
    monkeypatch.setattr(pod_self_registration, "_STATE", (True, keypair))
    monkeypatch.setattr(pod_turn, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    monkeypatch.setattr(pod_memory_service, "_resolve_log", lambda: log)
    monkeypatch.setattr(pod_consent_client, "verify_consent", _owner_verifier)
    monkeypatch.setattr(pod_google_oauth, "http_post", google)

    def transition_post(_client, path, *, json):
        assert path == "/api/one/google/connect/transition/complete"
        assert not any(key in json for key in ("code", "codeVerifier", "refreshToken"))
        payload = {"status": "completed"}
        if json["operation"] == "admit":
            payload = {
                "status": "admitted",
                "preparedAtMs": 1,
                "expiresAtMs": _now_ms() + 600_000,
                "revokedAtMs": 1,
                "reauthAccounts": [],
            }
        return SimpleNamespace(status_code=200, json=lambda: payload)

    monkeypatch.setattr(pod_hub_client.PodHubClient, "post", transition_post)

    def _verified(authorization: Any, *, role: str, scope: Any = None) -> tuple:
        assert authorization == OWNER_SESSION["Authorization"] and role == "app"
        return _OwnerSession(), _CLAIMS

    monkeypatch.setattr(pod_session, "verified_session", _verified)
    _OwnerSession.held_checks = 0
    pod_connector_credentials.set_active_connector_credentials({})
    yield log, google
    pod_connector_credentials.set_active_connector_credentials({})


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(pod_connectors.router)
    return TestClient(app, raise_server_exceptions=False)


def _local() -> dict:
    return {
        "consent_token": LOCAL_TOKEN_PREFIX + "fixture",
        "verifier": _owner_verifier,
        "session": _CLAIMS,
    }


async def _records(log) -> list[dict]:
    return [r for r in await log.replay() if r["kind"].startswith("pod_connector_credential")]


async def test_a_redeemed_login_is_sealed_into_the_log_and_never_echoed(pod, caplog):
    caplog.set_level(logging.DEBUG)
    log, google = pod
    client = _client()

    put = client.put(PATH, json=_envelope(), headers=OWNER_SESSION)
    got = client.get(PATH, headers=OWNER_SESSION)

    assert put.status_code == 200, put.text
    assert put.json() == {"connectorId": "gmail", "status": "connected"}
    assert got.json() == {
        "connectorId": "gmail",
        "status": "connected",
        "accessLevel": "read",
        "capabilities": {"read": True, "manage": False},
    }
    ((url, form),) = google.calls
    assert url == pod_google_oauth.TOKEN_URL
    assert form == {
        "grant_type": "authorization_code",
        "client_id": CLIENT,
        "code": CODE,
        "code_verifier": VERIFIER,
        "redirect_uri": VECTOR["plaintext"]["redirectUri"],
    }, "PKCE, and no client secret for Hussh's native client"
    (record,) = await _records(log)
    payload = record["payload"]
    assert (payload["refreshToken"], payload["accountSubject"]) == (REFRESH, "1098765432")
    assert payload["grantedScopes"] == ["openid", "email", G + "gmail.readonly"]
    assert payload["generation"] == 1 and payload["status"] == "connected"
    for text in (put.text, got.text, caplog.text):
        for secret in (REFRESH, ACCESS, CODE, VERIFIER):
            assert secret not in text
    assert _OwnerSession.held_checks == 1, "a write needs a held incarnation, a read does not"


async def test_the_hub_door_can_never_connect_read_or_disconnect(pod):
    log, google = pod
    client = _client()
    for response in (
        client.put(PATH, json=_envelope(), headers=HUB),
        client.get(PATH, headers=HUB),
        client.delete(PATH, headers=HUB),
        client.put(PATH, json=_envelope(), headers={**HUB, **OWNER_SESSION}),
    ):
        assert response.status_code == 403, response.request.method
        assert response.json() == {"detail": {"code": "OWNER_SESSION_REQUIRED"}}
    assert await _records(log) == [] and google.calls == []
    with pytest.raises(HTTPException) as refused:
        await pod_connectors.run_connector_put(
            "gmail", envelope=_envelope(), consent_token="hub-consent", verifier=_owner_verifier
        )
    assert refused.value.status_code == 403, "the core refuses a hub token on its own too"


async def test_admission_is_settled_before_the_envelope_is_read(pod, monkeypatch):
    read: list[bool] = []

    async def read_envelope() -> dict:
        read.append(True)
        return _envelope()

    with pytest.raises(HTTPException) as refused:
        await pod_connectors.run_connector_put(
            "gmail", read_envelope=read_envelope, consent_token=""
        )
    assert refused.value.status_code == 401 and read == []
    no_session = _client().put(PATH, json=_envelope())
    assert no_session.status_code == 401 and no_session.json() == {
        "detail": "consent token required"
    }, "an unadmitted caller learns nothing about the envelope"

    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: False)
    for method in ("put", "get", "delete"):
        response = getattr(_client(), method)(PATH, headers=OWNER_SESSION)
        assert response.status_code == 404, method


@pytest.mark.parametrize(
    ("answer", "code", "revokes"),
    [
        ({"refresh_token": None}, "REFRESH_TOKEN_MISSING", ACCESS),
        ({"scope": "openid email"}, "SCOPE_NOT_GRANTED", REFRESH),
        (
            {"id_token": _id_token(aud="999-other.apps.googleusercontent.com")},
            "ACCOUNT_UNVERIFIED",
            REFRESH,
        ),
        ({"id_token": None}, "ACCOUNT_UNVERIFIED", REFRESH),
    ],
    ids=["no_refresh_token", "scope_not_granted", "other_audience", "no_id_token"],
)
async def test_a_login_the_agent_cannot_keep_is_refused_and_revoked(pod, answer, code, revokes):
    log, google = pod
    status, body = google.token_answer
    google.token_answer = (status, {k: v for k, v in {**body, **answer}.items() if v is not None})

    put = _client().put(PATH, json=_envelope(), headers=OWNER_SESSION)

    assert put.status_code == 422 and put.json() == {"code": code}
    assert await _records(log) == []
    assert google.revoked() == [revokes], "nothing Google issued is left live"


async def test_a_refused_code_and_exact_cleanup_retry_never_exchange_again(pod):
    log, google = pod
    google.token_answer = (400, {"error": "invalid_grant"})
    refused = _client().put(PATH, json=_envelope(), headers=OWNER_SESSION)
    assert refused.json() == {"code": "CODE_REFUSED"} and await _records(log) == []

    google.token_answer = _Google().token_answer
    issued = _now_ms()
    first = await pod_connectors.run_connector_put("gmail", envelope=_envelope(issued), **_local())
    assert first["status"] == "connected"
    replay = await pod_connectors.run_connector_put("gmail", envelope=_envelope(issued), **_local())
    assert replay == first
    assert len(google.calls) == 2, "the refused exchange and one successful exchange only"
    assert len(await _records(log)) == 1


async def test_native_login_requires_transition_before_google_exchange(pod):
    log, google = pod
    response = _client().put(PATH, json=_envelope()["envelope"], headers=OWNER_SESSION)
    assert response.status_code == 503
    assert response.json() == {"code": "GOOGLE_TRANSITION_UNAVAILABLE"}
    assert google.calls == [] and await _records(log) == []


async def test_cleanup_outage_retries_exact_sealed_request_without_new_authorization(
    pod, monkeypatch
):
    log, google = pod
    operations = []

    def post(_client, _path, *, json):
        operations.append(json["operation"])
        if json["operation"] == "admit":
            payload = {
                "status": "admitted",
                "preparedAtMs": 1,
                "expiresAtMs": _now_ms() + 600_000,
                "revokedAtMs": 1,
                "reauthAccounts": [],
            }
            return SimpleNamespace(status_code=200, json=lambda: payload)
        status = 503 if operations.count("complete") == 1 else 200
        return SimpleNamespace(status_code=status, json=lambda: {"status": "completed"})

    monkeypatch.setattr(pod_hub_client.PodHubClient, "post", post)
    sealed = _envelope()
    first = _client().put(PATH, json=sealed, headers=OWNER_SESSION)
    assert first.json() == {
        "connectorId": "gmail",
        "status": "connected",
        "legacyCleanup": "unconfirmed",
    }
    retried = _client().put(PATH, json=sealed, headers=OWNER_SESSION)
    assert retried.json() == {"connectorId": "gmail", "status": "connected"}
    assert operations == ["admit", "complete", "complete"]
    assert len(google.calls) == 1 and len(await _records(log)) == 1


async def test_an_unconfirmed_cleanup_of_a_refused_login_is_reported_explicitly(pod):
    _log, google = pod
    status, body = google.token_answer
    google.token_answer = status, {**body, "scope": "openid email"}
    google.revoke_status = 503
    refused = _client().put(PATH, json=_envelope(), headers=OWNER_SESSION)
    assert refused.status_code == 422
    assert refused.json() == {"code": "SCOPE_NOT_GRANTED", "providerRevoked": False}


async def test_a_lost_record_race_reports_failed_provider_cleanup_without_masking_the_conflict(
    pod, monkeypatch
):
    from hushh_mcp.services.pod_commit_log import PodLogConflict

    _log, google = pod

    async def conflict(*_a, **_kw):
        raise PodLogConflict("synthetic conflict")

    monkeypatch.setattr(pod_connector_credentials, "record_connector_credential", conflict)
    google.revoke_status = 503
    refused = _client().put(PATH, json=_envelope(), headers=OWNER_SESSION)
    assert refused.status_code == 409
    assert refused.json() == {
        "detail": {"code": "CONNECTOR_NOT_RECORDED", "providerRevoked": False}
    }


async def test_disconnect_revokes_at_google_then_clears(pod):
    log, google = pod
    client = _client()
    client.put(PATH, json=_envelope(), headers=OWNER_SESSION)

    deleted = client.delete(PATH, headers=OWNER_SESSION)

    assert deleted.json() == {"connectorId": "gmail", "status": "absent", "providerRevoked": True}
    assert google.revoked() == [REFRESH]
    assert client.get(PATH, headers=OWNER_SESSION).json()["status"] == "absent"
    assert [r["kind"] for r in await _records(log)][-1] == "pod_connector_credential_cleared_v1"


async def test_disconnect_while_google_is_down_still_stops_the_agent_and_says_so(pod):
    log, google = pod
    client = _client()
    client.put(PATH, json=_envelope(), headers=OWNER_SESSION)
    google.revoke_status = 503

    deleted = client.delete(PATH, headers=OWNER_SESSION)

    assert deleted.json()["providerRevoked"] is False and deleted.json()["status"] == "absent"
    assert pod_connector_credentials.active_connector_credential("gmail") is None


async def test_erasure_revokes_every_google_login_from_memory_even_with_the_log_fenced(
    pod, monkeypatch
):
    """Erasure's pre-step reads only the in-memory copy: a fenced log refuses reads."""
    from hushh_mcp.services.pod_connector_connect import revoke_all

    log, google = pod
    _client().put(PATH, json=_envelope(), headers=OWNER_SESSION)

    async def fenced() -> list:
        raise RuntimeError("fenced")

    monkeypatch.setattr(log, "replay", fenced)
    assert await revoke_all() == {"revoked": 1, "unrevoked": 0, "unavailable": 0}
    assert google.revoked() == [REFRESH]
    google.revoke_status = 503
    assert await revoke_all() == {"revoked": 0, "unrevoked": 1, "unavailable": 0}, "never a raise"

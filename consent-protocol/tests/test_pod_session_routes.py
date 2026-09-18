"""The pod's app surface over HTTP: challenge, admit, renew, revoke, status, config.

Driven through a real ASGI app with the ingress policy mounted, so the tests prove
the surface a browser or a device actually meets: which routes pass the wall, which
role each accepts, and that every refusal is the authority's own exact code.
"""

from __future__ import annotations

import base64
import json
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from api.middlewares.pod_ingress import PodIngressPolicy
from api.middlewares.rate_limit import limiter
from api.routes.one import pod_session
from hushh_mcp.consent import token_signing
from hushh_mcp.services import pod_config
from hushh_mcp.services import pod_session_authority as psa
from hushh_mcp.services.pod_authority_store import (
    IncarnationLease,
    PodAuthorityStore,
    claim_incarnation,
)
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog

OWNER = "ha1_owner"
USER = "uid-1"
POD_KEY_ID = "podk_route_test"
POD_PUBLIC_KEY = base64.b64encode(b"R" * 32).decode()
DEK = b"S" * 32
KID = "hushh-consent-routes"


@pytest.fixture
def hub_key(monkeypatch):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    private = Ed25519PrivateKey.generate()
    seed = private.private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()
    )
    public = private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    monkeypatch.setenv("CONSENT_ED25519_PRIVATE_KEY", base64.b64encode(seed).decode())
    monkeypatch.setenv("CONSENT_ED25519_KID", KID)
    monkeypatch.setenv(
        "CONSENT_ED25519_PUBLIC_KEYS", json.dumps({KID: base64.b64encode(public).decode()})
    )
    token_signing.reset_caches()
    yield
    token_signing.reset_caches()


class Subject:
    def __init__(self, subject_id: str, platform: str) -> None:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec

        self.subject_id = subject_id
        self.platform = platform
        self._key = ec.generate_private_key(ec.SECP256R1())
        self._hashes, self._ec = hashes, ec
        self.public_key_b64 = base64.b64encode(
            self._key.public_key().public_bytes(
                serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
            )
        ).decode()

    def sign(self, payload: str) -> str:
        return base64.b64encode(
            self._key.sign(payload.encode(), self._ec.ECDSA(self._hashes.SHA256()))
        ).decode()

    def binding(self, *, version=1, scopes=None) -> dict:
        role = psa.role_for_platform(self.platform)
        now = int(time.time() * 1000)
        return {
            "kind": psa.BINDING_KIND,
            "hushh_id": OWNER,
            "user_id": USER,
            "environment": "dev",
            "pod_key_id": POD_KEY_ID,
            "pod_public_key": POD_PUBLIC_KEY,
            "url": "https://pod.example",
            "subject_id": self.subject_id,
            "subject_kind": role,
            "subject_public_key": self.public_key_b64,
            "platform": self.platform,
            "role": role,
            "scopes": list(
                scopes
                if scopes is not None
                else (psa.APP_SCOPES if role == "app" else psa.DEVICE_INFERENCE_SCOPES)
            ),
            "version": version,
            "issued_at_ms": now,
            "expires_at_ms": now + 86_400_000,
        }


@pytest.fixture
async def pod(tmp_path, monkeypatch, hub_key):
    """A pod app with the session router, the wall and a live local authority."""
    monkeypatch.setattr(pod_session, "pod_mode", lambda: True)
    monkeypatch.setenv("HUSSH_POD_IMAGE_TAG", "dev-test")
    object_store = LocalObjectStore(str(tmp_path / "pod"))
    log = PodCommitLog(object_store, DEK, owner_id=OWNER)
    incarnation = await claim_incarnation(object_store, DEK, instance_id="rev-a")
    store = PodAuthorityStore(log, hushh_id=OWNER)
    await store.load()
    authority = psa.PodSessionAuthority(
        store=store,
        lease=IncarnationLease(object_store, incarnation),
        dek=DEK,
        pod_key_id=POD_KEY_ID,
        pod_public_key=POD_PUBLIC_KEY,
        environment="dev",
    )
    psa.set_active_session_authority(authority)
    pod_config.set_active_pod_config(None)
    from hushh_mcp.services import pod_memory_service

    monkeypatch.setattr(pod_memory_service, "_resolve_log", lambda: log)

    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(pod_session.router)
    app.add_middleware(PodIngressPolicy)
    client = TestClient(app, raise_server_exceptions=False)
    yield {"client": client, "authority": authority, "log": log, "store": store}
    psa.set_active_session_authority(None)
    pod_config.set_active_pod_config(None)


def _sign(binding: dict) -> str:
    return token_signing.sign_payload(
        psa.canonical_json(binding), hmac_key="unused", require_asymmetric=True
    )


def _admit(client: TestClient, subject: Subject, binding: dict | None = None) -> dict:
    binding = binding or subject.binding()
    challenge = client.post(
        "/api/one/pod/session/challenge", json={"subjectId": subject.subject_id}
    )
    assert challenge.status_code == 200, challenge.text
    body = challenge.json()
    response = client.post(
        "/api/one/pod/session/admit",
        json={
            "binding": binding,
            "signature": _sign(binding),
            "challengeId": body["challengeId"],
            "nonce": body["nonce"],
            "proof": subject.sign(body["signingPayload"]),
            "epoch": body["epoch"],
        },
    )
    return (
        response.json()
        if response.status_code == 200
        else {"error": response.json(), "status": response.status_code}
    )


def _auth(session: dict) -> dict:
    return {"Authorization": f"Bearer {session['session']}"}


# -- admission --------------------------------------------------------------------


def test_challenge_and_admit_open_an_app_session(pod):
    app = Subject("tdv_web_1", "web")
    session = _admit(pod["client"], app)
    assert "session" in session, session
    assert session["role"] == "app" and session["epoch"] == pod["authority"].epoch
    assert set(psa.APP_SCOPES) <= set(session["scopes"])


def test_a_refused_admission_carries_the_exact_code(pod):
    app = Subject("tdv_web_1", "web")
    foreign = {**app.binding(), "hushh_id": "ha1_other"}
    result = _admit(pod["client"], app, foreign)
    assert result["status"] == 403
    assert result["error"]["detail"]["code"] == "foreign_owner"
    assert pod["store"].subject(app.subject_id).state == "unknown"


def test_admission_answers_503_when_no_local_authority_exists(pod):
    psa.set_active_session_authority(None)
    response = pod["client"].post("/api/one/pod/session/challenge", json={"subjectId": "x"})
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "LOCAL_AUTHORITY_UNAVAILABLE"


def test_renew_returns_a_fresh_session(pod):
    session = _admit(pod["client"], Subject("tdv_web_1", "web"))
    renewed = pod["client"].post("/api/one/pod/session/renew", headers=_auth(session))
    assert renewed.status_code == 200
    assert renewed.json()["sid"] != session["sid"]


# -- roles on the app surface ----------------------------------------------------------


def test_a_device_role_session_is_refused_on_app_routes(pod):
    device = _admit(pod["client"], Subject("tdv_mac_1", "macos"))
    assert device["role"] == "device"
    client = pod["client"]
    for method, path, body in (
        ("GET", "/api/one/pod/status", None),
        ("POST", "/api/one/pod/config", {"changes": {}}),
        ("POST", "/api/one/pod/session/revoke", {"subjectId": "tdv_mac_1"}),
    ):
        response = client.request(method, path, json=body, headers=_auth(device))
        assert response.status_code == 403, path
        assert response.json()["detail"]["code"] == "role_mismatch"


def test_no_bearer_and_a_hub_token_are_refused_by_shape(pod):
    client = pod["client"]
    assert client.get("/api/one/pod/status").status_code == 401
    assert client.get("/api/one/pod/status").json()["detail"]["code"] == "not_local_authority"
    hct = "HCT:" + base64.urlsafe_b64encode(b"u|a|s|1|2").decode() + ".abcd"
    response = client.get("/api/one/pod/status", headers={"Authorization": f"Bearer {hct}"})
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "not_local_authority"


# -- status and config -----------------------------------------------------------------


def test_status_reports_config_identity_epoch_subjects_and_image(pod):
    app = Subject("tdv_web_1", "web")
    session = _admit(pod["client"], app)
    _admit(pod["client"], Subject("tdv_mac_1", "macos"))
    response = pod["client"].get("/api/one/pod/status", headers=_auth(session))
    assert response.status_code == 200
    body = response.json()
    assert body["podKeyId"] == POD_KEY_ID
    assert body["epoch"] == pod["authority"].epoch
    assert body["incarnation"] == "held"
    assert body["config"]["puppy_broker"] is True
    assert body["imageTag"] == "dev-test"
    subjects = {s["subjectId"]: s for s in body["subjects"]}
    assert subjects["tdv_web_1"]["role"] == "app" and subjects["tdv_mac_1"]["role"] == "device"
    assert "subject_public_key" not in response.text
    assert "puppy" in body


def test_config_write_updates_the_active_record_and_refuses_unknown_fields(pod):
    session = _admit(pod["client"], Subject("tdv_web_1", "web"))
    ok = pod["client"].post(
        "/api/one/pod/config",
        json={"changes": {"puppy_broker": False, "memory_review_max_records": 5}},
        headers=_auth(session),
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["config"]["puppy_broker"] is False
    assert pod_config.active_pod_config().memory_review_max_records == 5

    bad = pod["client"].post(
        "/api/one/pod/config", json={"changes": {"not_a_field": 1}}, headers=_auth(session)
    )
    assert bad.status_code == 400
    assert bad.json()["detail"]["code"] == "POD_CONFIG_INVALID"
    assert pod_config.active_pod_config().puppy_broker is False


# -- revocation -----------------------------------------------------------------------


def test_the_owner_revokes_a_device_at_the_pod_and_its_session_dies(pod):
    client = pod["client"]
    owner = _admit(client, Subject("tdv_web_1", "web"))
    device = _admit(client, Subject("tdv_mac_1", "macos"))
    response = client.post(
        "/api/one/pod/session/revoke", json={"subjectId": "tdv_mac_1"}, headers=_auth(owner)
    )
    assert response.status_code == 200
    assert response.json() == {"revoked": True, "subjectId": "tdv_mac_1", "atVersion": 1}
    renew = client.post("/api/one/pod/session/renew", headers=_auth(device))
    assert renew.status_code == 403
    assert renew.json()["detail"]["code"] == "revoked"
    status = client.get("/api/one/pod/status", headers=_auth(owner)).json()
    assert {s["subjectId"]: s["state"] for s in status["subjects"]}["tdv_mac_1"] == "revoked"


def test_the_wall_passes_the_app_surface_and_walls_the_rest(pod):
    client = pod["client"]
    assert client.get("/api/one/pod/status").status_code == 401  # the route answered
    assert client.get("/pod/info").status_code == 404  # the wall answered

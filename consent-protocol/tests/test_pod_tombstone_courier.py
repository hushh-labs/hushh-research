"""Revocation pending delivery: the hub couriers, the pod verifies and applies.

Three legs, three files, one contract:

  * the heartbeat route hands the pod what is waiting and clears what it applied;
  * the pod applies only intents signed by a subject its OWN log trusts as an app,
    for its OWN owner, and reports exactly those ids back;
  * the pod's beat carries the applied ids on the next beat and never before.
"""

from __future__ import annotations

import base64
import json
import time

import pytest

from api.routes.one import pod_heartbeat
from hushh_mcp.consent import token_signing
from hushh_mcp.services import pod_session_authority as psa
from hushh_mcp.services.pod_authority_store import (
    IncarnationLease,
    PodAuthorityStore,
    claim_incarnation,
)
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog

OWNER = "ha1_owner"
DEK = b"C" * 32
KID = "hushh-consent-courier"


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
    def __init__(self, subject_id, platform):
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec

        self.subject_id, self.platform = subject_id, platform
        self._key = ec.generate_private_key(ec.SECP256R1())
        self._ec, self._hashes = ec, hashes
        self.public_key_b64 = base64.b64encode(
            self._key.public_key().public_bytes(
                serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
            )
        ).decode()

    def sign(self, payload: str) -> str:
        return base64.b64encode(
            self._key.sign(payload.encode(), self._ec.ECDSA(self._hashes.SHA256()))
        ).decode()


@pytest.fixture
async def pod(tmp_path, hub_key):
    object_store = LocalObjectStore(str(tmp_path / "pod"))
    log = PodCommitLog(object_store, DEK, owner_id=OWNER)
    incarnation = await claim_incarnation(object_store, DEK, instance_id="a")
    store = PodAuthorityStore(log, hushh_id=OWNER)
    await store.load()
    authority = psa.PodSessionAuthority(
        store=store,
        lease=IncarnationLease(object_store, incarnation),
        dek=DEK,
        pod_key_id="podk_c",
        pod_public_key=base64.b64encode(b"Q" * 32).decode(),
        environment="dev",
    )

    async def admit(subject: Subject, *, version=1):
        role = psa.role_for_platform(subject.platform)
        now = int(time.time() * 1000)
        binding = {
            "kind": psa.BINDING_KIND,
            "hushh_id": OWNER,
            "user_id": "uid-1",
            "environment": "dev",
            "pod_key_id": "podk_c",
            "pod_public_key": base64.b64encode(b"Q" * 32).decode(),
            "url": "https://pod.example",
            "subject_id": subject.subject_id,
            "subject_kind": role,
            "subject_public_key": subject.public_key_b64,
            "platform": subject.platform,
            "role": role,
            "scopes": list(psa.APP_SCOPES if role == "app" else psa.DEVICE_INFERENCE_SCOPES),
            "version": version,
            "issued_at_ms": now,
            "expires_at_ms": now + 86_400_000,
        }
        signature = token_signing.sign_payload(
            psa.canonical_json(binding), hmac_key="x", require_asymmetric=True
        )
        challenge = authority.create_challenge(subject.subject_id)
        return await authority.admit(
            binding=binding,
            signature=signature,
            challenge_id=challenge["challenge_id"],
            nonce=challenge["nonce"],
            proof=subject.sign(challenge["signing_payload"]),
            epoch=authority.epoch,
        )

    return {"authority": authority, "admit": admit, "store": store}


def _intent(**overrides) -> dict:
    intent = {
        "kind": psa.TOMBSTONE_INTENT_KIND,
        "intentId": "pti_1",
        "hushhId": OWNER,
        "subjectId": "tdv_mac_1",
        "atVersion": 1,
        "issuedAtMs": int(time.time() * 1000),
        "signerSubjectId": "tdv_web_1",
    }
    intent.update(overrides)
    return intent


def _entry(signer: Subject, intent: dict) -> dict:
    return {"intent": intent, "signature": signer.sign(psa.canonical_json(intent))}


# -- pod side --------------------------------------------------------------------------


async def test_a_trusted_app_signed_intent_revokes_the_device_and_is_reported_applied(pod):
    app, device = Subject("tdv_web_1", "web"), Subject("tdv_mac_1", "macos")
    await pod["admit"](app)
    device_token, _ = await pod["admit"](device)

    applied = await psa.apply_pending_tombstones(
        {"pendingTombstones": [_entry(app, _intent())]}, authority=pod["authority"]
    )

    assert applied == ["pti_1"]
    assert pod["store"].subject("tdv_mac_1").state == "tombstoned"
    with pytest.raises(psa.PodSessionRefused) as caught:
        pod["authority"].verify_session(device_token)
    assert caught.value.code == "revoked"


async def test_untrusted_foreign_or_forged_intents_apply_nothing_and_are_not_reported(pod):
    app, device = Subject("tdv_web_1", "web"), Subject("tdv_mac_1", "macos")
    stranger = Subject("tdv_web_9", "web")
    await pod["admit"](app)
    await pod["admit"](device)
    entries = [
        _entry(stranger, _intent(intentId="pti_unknown_signer", signerSubjectId="tdv_web_9")),
        _entry(device, _intent(intentId="pti_device_signer", signerSubjectId="tdv_mac_1")),
        _entry(app, _intent(intentId="pti_foreign", hushhId="ha1_other")),
        {"intent": _intent(intentId="pti_bad_sig"), "signature": "bm90IGEgc2ln"},
        {"intent": {**_intent(intentId="pti_shape"), "extra": True}, "signature": "x"},
        _entry(app, _intent(intentId="pti_bad_version", atVersion=0)),
        "not an entry",
    ]

    applied = await psa.apply_pending_tombstones(
        {"pendingTombstones": entries}, authority=pod["authority"]
    )

    assert applied == []
    assert pod["store"].subject("tdv_mac_1").state == "trusted"
    assert pod["store"].tombstones() == []


async def test_no_authority_or_no_payload_applies_nothing(pod):
    assert (
        await psa.apply_pending_tombstones({"pendingTombstones": []}, authority=pod["authority"])
        == []
    )
    assert await psa.apply_pending_tombstones(None, authority=pod["authority"]) == []
    psa.set_active_session_authority(None)
    assert await psa.apply_pending_tombstones({"pendingTombstones": [{}]}) == []


# -- hub side: the heartbeat route -------------------------------------------------------


class _Request:
    def __init__(self, body=None) -> None:
        self.headers = {}
        self._body = body

    async def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


class _Registry:
    def __init__(self, pending: list[dict]) -> None:
        self.pending = pending
        self.cleared: list[tuple[str, list[str]]] = []

    async def record_heartbeat(self, *, hushh_id, observed=None):
        return {
            "hushh_id": hushh_id,
            "status": "provisioned",
            "backend_metadata": {"pendingTombstones": list(self.pending)},
        }

    async def clear_pending_tombstones(self, *, hushh_id, intent_ids):
        self.cleared.append((hushh_id, list(intent_ids)))
        self.pending = [e for e in self.pending if e["intent"]["intentId"] not in set(intent_ids)]


@pytest.fixture
def hub(monkeypatch):
    monkeypatch.setattr(pod_heartbeat, "personal_agent_enabled", lambda: True)

    async def _verify(_request, _authorization):
        return OWNER

    monkeypatch.setattr(pod_heartbeat, "verify_pod_identity", _verify)


async def test_the_beat_hands_over_pending_intents_and_clears_applied_ones(hub):
    waiting = [
        {"intent": _intent(intentId="pti_a"), "signature": "s"},
        {"intent": _intent(intentId="pti_b"), "signature": "s"},
    ]
    registry = _Registry(waiting)

    first = await pod_heartbeat.record_pod_heartbeat(_Request(), "Bearer t", registry=registry)
    assert [e["intent"]["intentId"] for e in first["pendingTombstones"]] == ["pti_a", "pti_b"]

    second = await pod_heartbeat.record_pod_heartbeat(
        _Request({"imageTag": "dev-1", "appliedTombstones": ["pti_a"]}),
        "Bearer t",
        registry=registry,
    )
    assert registry.cleared == [(OWNER, ["pti_a"])]
    assert [e["intent"]["intentId"] for e in second["pendingTombstones"]] == ["pti_b"]

    third = await pod_heartbeat.record_pod_heartbeat(
        _Request({"appliedTombstones": ["pti_b"]}), "Bearer t", registry=registry
    )
    assert "pendingTombstones" not in third
    assert third == {"recorded": True, "status": "provisioned"}


async def test_a_beat_with_nothing_pending_keeps_its_old_shape(hub):
    class _Plain:
        async def record_heartbeat(self, *, hushh_id, observed=None):
            return {"hushh_id": hushh_id, "status": "provisioned"}

    result = await pod_heartbeat.record_pod_heartbeat(_Request(), "Bearer t", registry=_Plain())
    assert result == {"recorded": True, "status": "provisioned"}


# -- pod side: the beat carries what it applied -------------------------------------------


async def test_the_pod_beat_applies_couriered_intents_and_reports_them_next_time(monkeypatch, pod):
    import pod_server

    app, device = Subject("tdv_web_1", "web"), Subject("tdv_mac_1", "macos")
    await pod["admit"](app)
    await pod["admit"](device)
    psa.set_active_session_authority(pod["authority"])
    monkeypatch.setattr(pod_server, "_APPLIED_TOMBSTONES", [])

    class _Response:
        def __init__(self, payload):
            self.status_code = 200
            self._payload = payload

        def json(self):
            return self._payload

    class _Client:
        def __init__(self):
            self.bodies = []
            self.responses = [
                _Response({"recorded": True, "pendingTombstones": [_entry(app, _intent())]}),
                _Response({"recorded": True}),
            ]

        def post(self, _path, json=None):
            self.bodies.append(json)
            return self.responses.pop(0)

    client = _Client()
    assert await pod_server._heartbeat_once(client) is True
    assert "appliedTombstones" not in client.bodies[0]
    assert pod["store"].subject("tdv_mac_1").state == "tombstoned"
    assert pod_server._APPLIED_TOMBSTONES == ["pti_1"]

    assert await pod_server._heartbeat_once(client) is True
    assert client.bodies[1]["appliedTombstones"] == ["pti_1"]
    assert pod_server._APPLIED_TOMBSTONES == []
    psa.set_active_session_authority(None)

"""The device door over a real WebSocket: admission, hello, sealing, refusal.

Driven through the ASGI app so the device sees what Puppy One will see. The key
material is a real X25519 pair on each side and every post-hello frame is sealed,
so a test that passed with plaintext frames would fail here.
"""

from __future__ import annotations

import base64
import json
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from api.middlewares.pod_ingress import PodIngressPolicy
from api.routes.one import pod_puppy_relay
from hushh_mcp.consent import puppy_envelope as env
from hushh_mcp.consent import token_signing
from hushh_mcp.services import pod_config
from hushh_mcp.services import pod_session_authority as psa
from hushh_mcp.services import puppy_broker as pb
from hushh_mcp.services.pod_authority_store import (
    IncarnationLease,
    PodAuthorityStore,
    claim_incarnation,
)
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog

OWNER = "ha1_owner"
DEK = b"W" * 32
KID = "hushh-consent-relay"


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


class Device:
    """Puppy One's side: a P-256 enrolment key and a fresh X25519 ephemeral per dial."""

    def __init__(self, subject_id="tdv_mac_1", platform="macos") -> None:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

        self.subject_id, self.platform = subject_id, platform
        self._key = ec.generate_private_key(ec.SECP256R1())
        self._ec, self._hashes = ec, hashes
        self.public_key_b64 = base64.b64encode(
            self._key.public_key().public_bytes(
                serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
            )
        ).decode()
        self.ephemeral = X25519PrivateKey.generate()
        self.ephemeral_public_b64 = base64.b64encode(
            self.ephemeral.public_key().public_bytes(
                serialization.Encoding.Raw, serialization.PublicFormat.Raw
            )
        ).decode()

    def sign(self, payload: str) -> str:
        return base64.b64encode(
            self._key.sign(payload.encode(), self._ec.ECDSA(self._hashes.SHA256()))
        ).decode()


@pytest.fixture
async def pod(tmp_path, monkeypatch, hub_key):
    monkeypatch.setenv("HUSSH_ID", OWNER)
    monkeypatch.delenv("HUSSH_POD_PRIVATE_KEY", raising=False)
    from hushh_mcp.services import pod_self_registration

    monkeypatch.setattr(pod_self_registration, "_STATE", None)
    keypair = pod_self_registration.pod_keypair()
    object_store = LocalObjectStore(str(tmp_path / "pod"))
    log = PodCommitLog(object_store, DEK, owner_id=OWNER)
    incarnation = await claim_incarnation(object_store, DEK, instance_id="rev-a")
    store = PodAuthorityStore(log, hushh_id=OWNER)
    await store.load()
    authority = psa.PodSessionAuthority(
        store=store,
        lease=IncarnationLease(object_store, incarnation),
        dek=DEK,
        pod_key_id=keypair.key_id,
        pod_public_key=keypair.public_key_b64,
        environment="dev",
    )
    psa.set_active_session_authority(authority)
    pod_config.set_active_pod_config(None)
    pb.BROKER._links.clear()

    app = FastAPI()
    app.include_router(pod_puppy_relay.router)
    app.add_middleware(PodIngressPolicy)

    async def admit(device: Device, *, scopes=None, version=1):
        role = psa.role_for_platform(device.platform)
        now = int(time.time() * 1000)
        binding = {
            "kind": psa.BINDING_KIND,
            "hushh_id": OWNER,
            "user_id": "uid-1",
            "environment": "dev",
            "pod_key_id": keypair.key_id,
            "pod_public_key": keypair.public_key_b64,
            "url": "https://pod.example",
            "subject_id": device.subject_id,
            "subject_kind": role,
            "subject_public_key": device.public_key_b64,
            "platform": device.platform,
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
        signature = token_signing.sign_payload(
            psa.canonical_json(binding), hmac_key="x", require_asymmetric=True
        )
        challenge = authority.create_challenge(device.subject_id)
        token, claims = await authority.admit(
            binding=binding,
            signature=signature,
            challenge_id=challenge["challenge_id"],
            nonce=challenge["nonce"],
            proof=device.sign(challenge["signing_payload"]),
            epoch=authority.epoch,
        )
        return token, claims

    # Entered as a context so the client's portal exists: the tests use it to drive
    # the broker from the test thread while the app serves the socket.
    with TestClient(app, raise_server_exceptions=False) as client:
        yield {"client": client, "authority": authority, "admit": admit, "keypair": keypair}
    psa.set_active_session_authority(None)
    pod_config.set_active_pod_config(None)
    pb.BROKER._links.clear()


def _hello(device: Device, **overrides) -> dict:
    frame = {
        "type": "relay.hello",
        "role": "device",
        "deviceId": device.subject_id,
        "deviceEphemeralPublicKey": device.ephemeral_public_b64,
        "model": "qwen3-8b-mlx",
        "capabilities": ["tool_calling", "streaming"],
    }
    frame.update(overrides)
    return frame


def _device_envelope(pod, device: Device, claims: dict) -> env.PuppyEnvelope:
    key = env.derive_frame_key_device_side(device.ephemeral, pod["keypair"].public_key_b64)
    return env.PuppyEnvelope(
        key,
        hushh_id=OWNER,
        device_id=device.subject_id,
        session_id=claims["sid"],
        epoch=pod["authority"].epoch,
    )


def _connect(pod, token: str):
    return pod["client"].websocket_connect(
        "/api/one/puppy/relay", headers={"Authorization": f"Bearer {token}"}
    )


async def test_a_device_session_and_a_matching_hello_open_a_sealed_link(pod):
    device = Device()
    token, claims = await pod["admit"](device)
    with _connect(pod, token) as ws:
        ws.send_json(_hello(device))
        ready = ws.receive_json()
        assert ready["type"] == "relay.ready" and ready["sealed"] is True
        assert ready["epoch"] == pod["authority"].epoch
        assert ready["podKeyId"] == pod["keypair"].key_id
        status = pod["client"].portal.call(pb.BROKER.status, (OWNER, device.subject_id))
        assert status["connected"] is True
        assert status["model"] == "qwen3-8b-mlx"
        assert status["capabilities"] == ["tool_calling", "streaming"]
        assert "pst1." not in json.dumps(ready)


async def test_no_bearer_an_app_session_and_a_hub_token_are_all_refused(pod):
    device = Device()
    await pod["admit"](device)
    app_token, _ = await pod["admit"](Device("tdv_web_1", "web"))
    hct = "HCT:" + base64.urlsafe_b64encode(b"u|a|s|1|2").decode() + ".abcd"
    for token in ("", app_token, hct):
        with pytest.raises(WebSocketDisconnect) as caught:
            with pod["client"].websocket_connect(
                "/api/one/puppy/relay",
                headers={"Authorization": f"Bearer {token}"} if token else {},
            ):
                pass
        assert caught.value.code == 1008


async def test_a_device_enrolled_without_the_inference_scope_is_refused(pod):
    device = Device()
    token, _ = await pod["admit"](device, scopes=[])
    with pytest.raises(WebSocketDisconnect) as caught:
        with _connect(pod, token):
            pass
    assert caught.value.code == 1008


async def test_a_hello_for_another_device_or_another_role_closes_the_socket(pod):
    device = Device()
    token, _ = await pod["admit"](device)
    for bad in (_hello(device, deviceId="tdv_other"), _hello(device, role="pod")):
        with _connect(pod, token) as ws:
            ws.send_json(bad)
            with pytest.raises(WebSocketDisconnect) as caught:
                ws.receive_json()
            assert caught.value.code == 1008


async def test_the_broker_is_off_when_the_owner_says_so(pod):
    device = Device()
    token, _ = await pod["admit"](device)
    pod_config.set_active_pod_config(pod_config.PodConfig(puppy_broker=False))
    with pytest.raises(WebSocketDisconnect) as caught:
        with _connect(pod, token):
            pass
    assert caught.value.code == 1008


async def test_sealed_answers_reach_the_broker_and_a_request_from_the_device_closes(pod):
    device = Device()
    token, claims = await pod["admit"](device)
    with _connect(pod, token) as ws:
        ws.send_json(_hello(device))
        assert ws.receive_json()["type"] == "relay.ready"
        envelope = _device_envelope(pod, device, claims)
        key = (OWNER, device.subject_id)

        # A dispatched request travels to the device SEALED.
        async def dispatch():
            frames = []
            async for frame in pb.BROKER.dispatch(
                key, {"type": "inference.request", "requestId": "r1", "deviceId": device.subject_id}
            ):
                frames.append(frame)
            return frames

        import anyio

        portal = pod["client"].portal
        future = portal.start_task_soon(dispatch)
        sealed = ws.receive_json()
        assert sealed["type"] == "sealed" and sealed["dir"] == "p2d" and sealed["seq"] == 1
        request = envelope.open(sealed, expected_direction=env.DIR_POD_TO_DEVICE, expected_seq=1)
        assert request["type"] == "inference.request" and request["requestId"] == "r1"

        # The device answers, sealed, in sequence.
        ws.send_json(
            envelope.seal(
                {"type": "inference.delta", "requestId": "r1", "text": "hi"},
                direction=env.DIR_DEVICE_TO_POD,
                seq=1,
            )
        )
        ws.send_json(
            envelope.seal(
                {"type": "inference.done", "requestId": "r1"},
                direction=env.DIR_DEVICE_TO_POD,
                seq=2,
            )
        )
        frames = future.result(timeout=5)
        assert [f["type"] for f in frames] == ["inference.delta", "inference.done"]
        del anyio

        # A device that tries to REQUEST inference is disconnected.
        ws.send_json(
            envelope.seal(
                {"type": "inference.request", "requestId": "evil", "deviceId": device.subject_id},
                direction=env.DIR_DEVICE_TO_POD,
                seq=3,
            )
        )
        with pytest.raises(WebSocketDisconnect) as caught:
            ws.receive_json()
        assert caught.value.code == 1008


async def test_a_plaintext_or_out_of_sequence_frame_after_hello_closes_the_socket(pod):
    device = Device()
    token, claims = await pod["admit"](device)
    with _connect(pod, token) as ws:
        ws.send_json(_hello(device))
        assert ws.receive_json()["type"] == "relay.ready"
        ws.send_json({"type": "inference.delta", "requestId": "r1", "text": "plain"})
        with pytest.raises(WebSocketDisconnect) as caught:
            ws.receive_json()
        assert caught.value.code == 1008

    device2 = Device("tdv_mac_2")
    token2, claims2 = await pod["admit"](device2)
    with _connect(pod, token2) as ws:
        ws.send_json(_hello(device2))
        assert ws.receive_json()["type"] == "relay.ready"
        envelope = _device_envelope(pod, device2, claims2)
        ws.send_json(
            envelope.seal({"type": "relay.heartbeat"}, direction=env.DIR_DEVICE_TO_POD, seq=2)
        )
        with pytest.raises(WebSocketDisconnect) as caught:
            ws.receive_json()
        assert caught.value.code == 1008


async def test_a_revocation_at_the_pod_closes_the_link_on_the_next_frame(pod):
    device = Device()
    token, claims = await pod["admit"](device)
    with _connect(pod, token) as ws:
        ws.send_json(_hello(device))
        assert ws.receive_json()["type"] == "relay.ready"
        envelope = _device_envelope(pod, device, claims)
        pod["client"].portal.call(pod["authority"].revoke_subject, device.subject_id)
        ws.send_json(
            envelope.seal({"type": "relay.heartbeat"}, direction=env.DIR_DEVICE_TO_POD, seq=1)
        )
        with pytest.raises(WebSocketDisconnect) as caught:
            ws.receive_json()
        assert caught.value.code == 1008
    assert pb.BROKER.is_linked((OWNER, device.subject_id)) is False


def test_model_and_capability_validation_is_strict():
    assert pod_puppy_relay.valid_model_name("qwen3-8b-mlx") == "qwen3-8b-mlx"
    assert pod_puppy_relay.valid_model_name("http://evil") == ""
    assert pod_puppy_relay.valid_model_name("two words") == ""
    assert pod_puppy_relay.valid_model_name("x" * 129) == ""
    assert pod_puppy_relay.valid_capabilities(["tool_calling", "BAD CAP", "json_schema"]) == (
        "tool_calling",
        "json_schema",
    )

    # THREE ANSWERS, NOT TWO. Absent is None, which the pre-dispatch gate reads
    # as its negative control and refuses nothing by. An empty list is a real
    # declaration of no capabilities. Anything the door cannot parse RAISES, so
    # the socket closes rather than the declaration being silently dropped.
    #
    # This used to return () for all three. The fork sends a dict today, written
    # for the hub, so a spec-compliant-looking device had its whole declaration
    # discarded here and every capability gate downstream switched itself off.
    assert pod_puppy_relay.valid_capabilities(None) is None
    assert pod_puppy_relay.valid_capabilities([]) == ()
    for malformed in ("tool_calling", {"tool_calling": True}, 7):
        with pytest.raises(ValueError):
            pod_puppy_relay.valid_capabilities(malformed)


def test_the_relay_is_on_the_app_surface_and_the_wall_still_covers_the_rest():
    from api.middlewares.pod_ingress import is_app_surface

    assert is_app_surface("/api/one/puppy/relay") is True
    assert is_app_surface("/api/one/puppy/status/tdv_1") is False

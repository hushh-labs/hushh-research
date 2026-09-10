"""Sealed frames between pod and device: what binds, what refuses, what leaks (nothing).

K16 lives here: no prompt, no ticket, no token appears in a sealed frame, and a
frame lifted across owner, device, session, epoch, direction or position fails to
authenticate rather than decrypting to something plausible.
"""

from __future__ import annotations

import base64
import json

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

from hushh_mcp.consent import puppy_envelope as env

OWNER = "ha1_owner"
DEVICE = "tdv_mac_1"
SESSION = "pss_abc"
EPOCH = 3


def _raw_public_b64(private: X25519PrivateKey) -> str:
    return base64.b64encode(
        private.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
    ).decode()


def _pair():
    pod = X25519PrivateKey.generate()
    device = X25519PrivateKey.generate()
    pod_key = env.derive_frame_key(pod, _raw_public_b64(device))
    device_key = env.derive_frame_key_device_side(device, _raw_public_b64(pod))
    return pod_key, device_key


def _envelope(key, **overrides):
    fields = {"hushh_id": OWNER, "device_id": DEVICE, "session_id": SESSION, "epoch": EPOCH}
    fields.update(overrides)
    return env.PuppyEnvelope(key, **fields)


def test_both_sides_derive_the_same_key_and_it_is_not_the_shared_secret():
    pod = X25519PrivateKey.generate()
    device = X25519PrivateKey.generate()
    pod_key = env.derive_frame_key(pod, _raw_public_b64(device))
    device_key = env.derive_frame_key_device_side(device, _raw_public_b64(pod))
    assert pod_key == device_key and len(pod_key) == 32
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PublicKey

    shared = pod.exchange(
        X25519PublicKey.from_public_bytes(base64.b64decode(_raw_public_b64(device)))
    )
    assert pod_key != shared


def test_a_new_ephemeral_key_means_a_new_frame_key():
    pod = X25519PrivateKey.generate()
    first = env.derive_frame_key(pod, _raw_public_b64(X25519PrivateKey.generate()))
    second = env.derive_frame_key(pod, _raw_public_b64(X25519PrivateKey.generate()))
    assert first != second


def test_round_trip_in_both_directions_with_independent_counters():
    pod_key, device_key = _pair()
    pod, device = _envelope(pod_key), _envelope(device_key)
    request = {
        "type": "inference.request",
        "requestId": "r1",
        "messages": [{"text": "secret prompt"}],
    }
    sealed = pod.seal(request, direction=env.DIR_POD_TO_DEVICE, seq=1)
    assert device.open(sealed, expected_direction=env.DIR_POD_TO_DEVICE, expected_seq=1) == request
    reply = {"type": "inference.delta", "requestId": "r1", "text": "hello"}
    sealed_reply = device.seal(reply, direction=env.DIR_DEVICE_TO_POD, seq=1)
    assert pod.open(sealed_reply, expected_direction=env.DIR_DEVICE_TO_POD, expected_seq=1) == reply


def test_nothing_from_the_inner_frame_is_visible_on_the_wire():
    pod_key, _ = _pair()
    sealed = _envelope(pod_key).seal(
        {
            "type": "inference.request",
            "requestId": "r1",
            "messages": [{"text": "the secret prompt"}],
            "ticket": "tkt_9",
        },
        direction=env.DIR_POD_TO_DEVICE,
        seq=1,
    )
    wire = json.dumps(sealed)
    assert "secret prompt" not in wire and "tkt_9" not in wire and "r1" not in wire
    assert set(sealed) == {"type", "v", "dir", "seq", "innerType", "ciphertext"}
    assert sealed["innerType"] == "inference.request"


@pytest.mark.parametrize(
    "override",
    [
        {"hushh_id": "ha1_other"},
        {"device_id": "tdv_other"},
        {"session_id": "pss_other"},
        {"epoch": EPOCH + 1},
    ],
)
def test_a_frame_lifted_to_another_binding_fails_to_authenticate(override):
    pod_key, _ = _pair()
    sealed = _envelope(pod_key).seal(
        {"type": "inference.done", "requestId": "r1"}, direction=env.DIR_POD_TO_DEVICE, seq=1
    )
    other = _envelope(pod_key, **override)
    with pytest.raises(env.PuppyEnvelopeError):
        other.open(sealed, expected_direction=env.DIR_POD_TO_DEVICE, expected_seq=1)


def test_replayed_reordered_and_reflected_frames_are_refused():
    pod_key, _ = _pair()
    pod = _envelope(pod_key)
    first = pod.seal(
        {"type": "inference.done", "requestId": "r1"}, direction=env.DIR_POD_TO_DEVICE, seq=1
    )
    second = pod.seal(
        {"type": "inference.done", "requestId": "r2"}, direction=env.DIR_POD_TO_DEVICE, seq=2
    )
    reader = _envelope(pod_key)
    assert (
        reader.open(first, expected_direction=env.DIR_POD_TO_DEVICE, expected_seq=1)["requestId"]
        == "r1"
    )
    with pytest.raises(env.PuppyEnvelopeError):  # replay at the next position
        reader.open(first, expected_direction=env.DIR_POD_TO_DEVICE, expected_seq=2)
    with pytest.raises(env.PuppyEnvelopeError):  # reorder
        reader.open(second, expected_direction=env.DIR_POD_TO_DEVICE, expected_seq=3)
    with pytest.raises(env.PuppyEnvelopeError):  # reflected back in the other direction
        reader.open(second, expected_direction=env.DIR_DEVICE_TO_POD, expected_seq=2)
    with pytest.raises(env.PuppyEnvelopeError):  # declared inner type edited on the wire
        reader.open(
            {**second, "innerType": "inference.result"},
            expected_direction=env.DIR_POD_TO_DEVICE,
            expected_seq=2,
        )


def test_the_nonce_is_direction_and_sequence_and_never_repeats():
    assert env.frame_nonce(env.DIR_POD_TO_DEVICE, 1) == b"\x00\x00\x00\x00" + (1).to_bytes(8, "big")
    assert env.frame_nonce(env.DIR_DEVICE_TO_POD, 1) == b"\x01\x00\x00\x00" + (1).to_bytes(8, "big")
    assert env.frame_nonce(env.DIR_POD_TO_DEVICE, 1) != env.frame_nonce(env.DIR_DEVICE_TO_POD, 1)
    with pytest.raises(env.PuppyEnvelopeError):
        env.frame_nonce(env.DIR_POD_TO_DEVICE, 0)


def test_the_aad_bytes_are_byte_exact():
    aad = _envelope(b"k" * 32).aad(
        direction=env.DIR_POD_TO_DEVICE, seq=7, inner_type="inference.delta"
    )
    assert env.canonical_aad_bytes(aad) == (
        b'{"deviceId":"tdv_mac_1","dir":"p2d","epoch":3,"hushhId":"ha1_owner",'
        b'"innerType":"inference.delta","seq":7,"sessionId":"pss_abc","v":1}'
    )
    with pytest.raises(env.PuppyEnvelopeError):
        env.canonical_aad_bytes({**aad, "extra": 1})


def test_malformed_keys_and_frames_are_refused():
    pod = X25519PrivateKey.generate()
    with pytest.raises(env.PuppyEnvelopeError):
        env.derive_frame_key(pod, "not-base64!")
    with pytest.raises(env.PuppyEnvelopeError):
        env.derive_frame_key(pod, base64.b64encode(b"short").decode())
    with pytest.raises(env.PuppyEnvelopeError):
        env.PuppyEnvelope(b"short", hushh_id=OWNER, device_id=DEVICE, session_id=SESSION, epoch=1)
    reader = _envelope(b"k" * 32)
    with pytest.raises(env.PuppyEnvelopeError):
        reader.open(
            {"type": "inference.delta"}, expected_direction=env.DIR_POD_TO_DEVICE, expected_seq=1
        )
    with pytest.raises(env.PuppyEnvelopeError):
        reader.seal({"requestId": "r1"}, direction=env.DIR_POD_TO_DEVICE, seq=1)

"""Hermetic unit tests for pod_connector_keypair_service.

Pure X25519 crypto: no DB, no network. Verifies the zero-knowledge contract
(the pod holds the private key; Hushh validates/stores only the public key) and
that a generated public key round-trips through validation and is usable for
ECDH (the basis of scoped-export wrapping).
"""

from __future__ import annotations

import base64

import pytest
from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)

from hushh_mcp.services import pod_connector_keypair_service as pod

WRAP = pod.WRAPPING_ALG


class TestGenerate:
    def test_shape(self):
        kp = pod.generate_pod_keypair()
        assert kp.key_id.startswith("pod-")
        assert kp.wrapping_alg == WRAP
        raw = base64.b64decode(kp.public_key_b64)
        assert len(raw) == 32

    def test_unique_per_call(self):
        assert pod.generate_pod_keypair().public_key_b64 != pod.generate_pod_keypair().public_key_b64

    def test_public_projection_matches(self):
        kp = pod.generate_pod_keypair()
        pub = kp.public()
        assert (pub.public_key_b64, pub.key_id, pub.wrapping_alg) == (
            kp.public_key_b64,
            kp.key_id,
            kp.wrapping_alg,
        )


class TestParsePublicKey:
    def test_roundtrips_generated_key(self):
        kp = pod.generate_pod_keypair()
        parsed = pod.parse_pod_public_key(kp.public_key_b64, kp.key_id)
        assert parsed.public_key_b64 == kp.public_key_b64
        assert parsed.key_id == kp.key_id
        assert parsed.wrapping_alg == WRAP

    def test_rejects_empty_key_id(self):
        kp = pod.generate_pod_keypair()
        with pytest.raises(ValueError):
            pod.parse_pod_public_key(kp.public_key_b64, "  ")

    def test_rejects_bad_wrapping_alg(self):
        kp = pod.generate_pod_keypair()
        with pytest.raises(ValueError):
            pod.parse_pod_public_key(kp.public_key_b64, kp.key_id, wrapping_alg="RSA-OAEP")

    def test_rejects_non_base64(self):
        with pytest.raises(ValueError):
            pod.parse_pod_public_key("not*base64*", "pod-abc")

    def test_rejects_wrong_length(self):
        short = base64.b64encode(b"\x01" * 16).decode()
        with pytest.raises(ValueError):
            pod.parse_pod_public_key(short, "pod-abc")


class TestEcdhInterop:
    def test_shared_secret_agrees(self):
        # The pod holds the private key; another party (Hushh's export wrapper)
        # derives the same shared secret from the pod's public key. This is the
        # crypto basis for wrapping a scoped export to the pod.
        kp = pod.generate_pod_keypair()
        other_priv = X25519PrivateKey.generate()

        pod_public = X25519PublicKey.from_public_bytes(base64.b64decode(kp.public_key_b64))
        other_public = other_priv.public_key()

        secret_from_other = other_priv.exchange(pod_public)
        secret_from_pod = kp.private_key.exchange(other_public)
        assert secret_from_other == secret_from_pod

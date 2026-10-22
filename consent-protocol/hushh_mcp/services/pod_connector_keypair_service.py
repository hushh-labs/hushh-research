"""X25519 keypair contract for a per-user personal-agent pod.

Zero-knowledge boundary: the user's pod generates and holds its OWN X25519
private key inside its isolated runtime. Hushh only ever receives, stores, and
uses the pod's PUBLIC key (to wrap scoped exports to it, exactly like an
external connector). Hushh never holds the pod private key, so it can never
decrypt the pod's data — the same guarantee the local stdio MCP connector gives
(:mod:`hushh_mcp.services.local_mcp_keypair_service`), but per-pod rather than
per-installation.

``generate_pod_keypair`` exists for the pod runtime and for tests. The Hushh
backend calls only :func:`parse_pod_public_key`, to validate a pod-supplied
public key before persisting it in ``personal_agent_registry.pod_pubkey``.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from uuid import uuid4

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)

WRAPPING_ALG = "X25519-AES256-GCM"
_X25519_RAW_LEN = 32


@dataclass(frozen=True)
class PodPublicKey:
    """The pod public key Hushh stores and wraps scoped exports to."""

    public_key_b64: str
    key_id: str
    wrapping_alg: str = WRAPPING_ALG


@dataclass(frozen=True)
class PodKeyPair:
    """A pod keypair. The private half stays inside the pod; never in Hushh."""

    private_key: X25519PrivateKey  # gitleaks:allow -- type annotation, not key material
    public_key_b64: str
    key_id: str
    wrapping_alg: str = WRAPPING_ALG

    def public(self) -> PodPublicKey:
        return PodPublicKey(
            public_key_b64=self.public_key_b64,
            key_id=self.key_id,
            wrapping_alg=self.wrapping_alg,
        )


def _b64encode(value: bytes) -> str:
    return base64.b64encode(value).decode("utf-8")


def generate_pod_keypair() -> PodKeyPair:
    """Generate a fresh X25519 pod keypair.

    Intended to run INSIDE the pod runtime (or in tests). The Hushh backend does
    not call this in production — it only ever stores the resulting public key.
    """
    private_key = X25519PrivateKey.generate()
    public_bytes = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return PodKeyPair(
        private_key=private_key,
        public_key_b64=_b64encode(public_bytes),
        key_id=f"pod-{uuid4().hex[:16]}",
        wrapping_alg=WRAPPING_ALG,
    )


def parse_pod_public_key(
    public_key_b64: str,
    key_id: str,
    wrapping_alg: str = WRAPPING_ALG,
) -> PodPublicKey:
    """Validate and normalize a pod-supplied public key for storage.

    Raises ``ValueError`` if the key id is empty, the wrapping algorithm is
    unsupported, or the value is not a valid 32-byte base64 X25519 public key.
    """
    kid = str(key_id or "").strip()
    if not kid:
        raise ValueError("pod key_id is empty")
    if str(wrapping_alg or "").strip() != WRAPPING_ALG:
        raise ValueError(f"unsupported wrapping_alg: {wrapping_alg!r}")
    try:
        raw = base64.b64decode(str(public_key_b64), validate=True)
    except (ValueError, TypeError) as exc:
        raise ValueError("pod public key is not valid base64") from exc
    if len(raw) != _X25519_RAW_LEN:
        raise ValueError("pod public key must be 32 raw X25519 bytes")
    # Raises if the bytes are not a valid X25519 public key encoding.
    X25519PublicKey.from_public_bytes(raw)
    return PodPublicKey(
        public_key_b64=_b64encode(raw),
        key_id=kid,
        wrapping_alg=WRAPPING_ALG,
    )

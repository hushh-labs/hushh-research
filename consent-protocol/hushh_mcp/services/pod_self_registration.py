"""The pod's own X25519 keypair, and the public half it is willing to publish.

The pod generates or loads its OWN keypair inside its own runtime and the private
half never leaves this process -- that is what makes the hub structurally unable
to decrypt the pod's holdings
(:mod:`hushh_mcp.services.pod_connector_keypair_service`).

WHY THE POD PUBLISHES RATHER THAN PUSHES. An earlier shape had the pod POST its
key to the hub. That required the hub to answer "which pod is calling?", and it
cannot: every pod on the shared tier runs as the same service account, so an ID
token proves fleet membership and nothing more. Closing that gap needed a per-pod
bearer secret rendered into the pod's deploy config -- which put secret material
into an artifact readable by anyone with ``run.services.get``, and
``test_rendered_config_carries_identity_but_no_secrets`` correctly refused it.

Inverting the direction removes the question instead of answering it. The pod
merely *exposes* its public key; the HUB fetches it, from the URL the hub itself
recorded in ``backend_metadata`` when it created the service. The address is
never supplied by the caller, so there is no identity to assert and nothing to
forge: whatever answers that URL is by definition that user's pod.

TWO KEY SOURCES, one honest distinction:

* **Durable** -- the private key is mounted into the pod's environment from
  storage only that pod's runtime can read: on BYOC, a secret in the USER'S OWN
  project (their Secret Manager, their KMS, their IAM -- the hub has no path to
  it); on the attested tier, sealed storage (roadmap M5). The key survives
  restarts, its key id is derived from the public key so it is stable across
  processes, and things may be durably wrapped TO it.
* **Ephemeral** -- generated in memory on boot. A restart mints a new keypair;
  the hub's reconcile sweep observes the change on its next pull and ROTATES the
  registry record (``pod_key_collector.refresh_pod_key``), so the fleet converges
  instead of wedging. But nothing durable may ever be wrapped to an ephemeral
  key, and ``pod_key_is_durable()`` is how storage layers refuse to. Pretending
  an ephemeral key is durable would make the registry's record of "this agent's
  key" quietly stop being true -- worse than admitting the limitation.

THE SIGNING KEY. The pod signs its requests to the hub with an Ed25519 key derived
from this X25519 private key (:func:`derive_signing_key`). It is published beside
the X25519 public key and recorded by the same hub-initiated pull, so it inherits
both the durability and the rotation story above, and adds no custody object.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
from typing import Optional

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from hushh_mcp.services.pod_connector_keypair_service import (
    WRAPPING_ALG,
    PodKeyPair,
    generate_pod_keypair,
)

logger = logging.getLogger(__name__)

# Raw 32-byte X25519 private key, base64 (std or url-safe). On BYOC this arrives
# by secretKeyRef from the USER'S project -- never rendered into the artifact.
POD_PRIVATE_KEY_ENV = "HUSSH_POD_PRIVATE_KEY"
# Alternative: a mounted file (e.g. a Secret Manager volume or sealed storage).
POD_PRIVATE_KEY_FILE_ENV = "HUSSH_POD_PRIVATE_KEY_FILE"

_X25519_RAW_LEN = 32

#: HKDF info for the pod's request-signing key. Versioned so a future derivation can
#: never collide with this one.
SIGNING_KEY_INFO = b"hushh/pod-hub-request-signing/ed25519/v1"

# This pod's keypair for the life of the process. Module-level because every
# consumer inside the pod must see the same key. (durable, keypair) so callers
# can ask which world they are in.
_STATE: Optional[tuple[bool, PodKeyPair]] = None
# (X25519 key id it was derived from, signing key): re-derived if the keypair moves.
_SIGNING: Optional[tuple[str, Ed25519PrivateKey]] = None


def _decode_private_key(material: str) -> Optional[bytes]:
    candidate = material.strip()
    if not candidate:
        return None
    for decoder in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            raw = decoder(candidate + "=" * (-len(candidate) % 4))
        except Exception:  # noqa: BLE001 - try the next encoding
            continue
        if len(raw) == _X25519_RAW_LEN:
            return raw
    return None


def _stable_key_id(public_key_b64: str) -> str:
    """Deterministic key id for a durable key, so restarts present the same identity.

    A random id per process would make every restart LOOK like a rotation even
    when the key material is identical.
    """
    digest = hashlib.sha256(public_key_b64.encode("utf-8")).hexdigest()[:32]
    return f"podk_{digest}"


def _load_durable_keypair() -> Optional[PodKeyPair]:
    material = (os.getenv(POD_PRIVATE_KEY_ENV) or "").strip()
    if not material:
        path = (os.getenv(POD_PRIVATE_KEY_FILE_ENV) or "").strip()
        if path:
            try:
                material = open(path, encoding="utf-8").read()  # noqa: SIM115, PTH123
            except OSError as exc:
                # A CONFIGURED durable source that cannot be read is an error worth
                # shouting about, not a quiet fall-through to ephemeral: the operator
                # believes this pod's key survives restarts, and it would not.
                logger.error(
                    "pod_key.durable_source_unreadable file=%s err=%s -- FALLING BACK "
                    "TO AN EPHEMERAL KEY; nothing durable may be wrapped to it",
                    path,
                    type(exc).__name__,
                )
                return None
    raw = _decode_private_key(material)
    if raw is None:
        if material:
            logger.error(
                "pod_key.durable_source_invalid -- not a base64 raw 32-byte X25519 "
                "key; FALLING BACK TO AN EPHEMERAL KEY"
            )
        return None

    private_key = X25519PrivateKey.from_private_bytes(raw)
    public_b64 = base64.b64encode(
        private_key.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
    ).decode("ascii")
    return PodKeyPair(
        private_key=private_key,
        public_key_b64=public_b64,
        key_id=_stable_key_id(public_b64),
        wrapping_alg=WRAPPING_ALG,
    )


def _state() -> tuple[bool, PodKeyPair]:
    global _STATE
    if _STATE is None:
        durable = _load_durable_keypair()
        if durable is not None:
            logger.info("pod_key.loaded source=durable key_id=%s", durable.key_id)
            _STATE = (True, durable)
        else:
            keypair = generate_pod_keypair()
            logger.info(
                "pod_key.generated source=ephemeral -- a restart will rotate this "
                "key; the hub reconcile sweep converges the registry"
            )
            _STATE = (False, keypair)
    return _STATE


def pod_keypair() -> PodKeyPair:
    """This pod's keypair: durable when a mounted source exists, else ephemeral."""
    return _state()[1]


def pod_key_is_durable() -> bool:
    """True only when the key came from a mounted, restart-surviving source.

    The contract storage layers build on: wrap durable material ONLY to a durable
    key. An ephemeral key is fine for session-scoped exchange and nothing else.
    """
    return _state()[0]


def pod_public_key_payload() -> dict[str, str]:
    """The public half, in the shape the hub's collector expects.

    Only ever the public key, the key id, and the wrapping algorithm. There is no
    code path here that can reach the private half.
    """
    keypair = pod_keypair()
    return {
        "podPublicKey": keypair.public_key_b64,
        "podKeyId": keypair.key_id,
        "podKeyWrappingAlg": keypair.wrapping_alg,
    }


def derive_signing_key(private_key: X25519PrivateKey) -> Ed25519PrivateKey:
    """The Ed25519 request-signing key that belongs to ``private_key``.

    ``HKDF-SHA256(ikm = raw X25519 private key, salt = none, info = SIGNING_KEY_INFO)``.
    Derived rather than stored, so it adds no custody object: it is exactly as
    durable as the X25519 key it comes from, and rotates when that key rotates.
    """
    raw = private_key.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    seed = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=SIGNING_KEY_INFO).derive(raw)
    return Ed25519PrivateKey.from_private_bytes(seed)


def pod_signing_key() -> Ed25519PrivateKey:
    """This pod's request-signing key, derived from its current X25519 keypair."""
    global _SIGNING
    keypair = pod_keypair()
    if _SIGNING is None or _SIGNING[0] != keypair.key_id:
        _SIGNING = (keypair.key_id, derive_signing_key(keypair.private_key))
    return _SIGNING[1]


def pod_signing_public_payload() -> dict[str, str]:
    """The public half of the signing key, additive to :func:`pod_public_key_payload`."""
    from hushh_mcp.services.pod_request_signing import (  # noqa: PLC0415
        SIGNING_ALG,
        public_key_b64,
        signing_key_id,
    )

    public = public_key_b64(pod_signing_key())
    return {
        "podSigningKey": public,
        "podSigningKeyId": signing_key_id(public),
        "podSigningAlg": SIGNING_ALG,
    }

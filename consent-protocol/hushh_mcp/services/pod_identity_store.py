"""The pod's identity keypair, persisted where only the pod can read it.

THE GAP THIS CLOSES
-------------------
``pod_self_registration`` reads a durable private key from
``HUSSH_POD_PRIVATE_KEY`` or ``HUSSH_POD_PRIVATE_KEY_FILE``, and **nothing in
this repository has ever written either one**. So every pod mints a fresh
keypair in memory on every boot, and the founder's live pod reports
``podKeyDurable: False`` (observed 2026-08-25 via ``/pod/public-key``).

The consequences were real, not theoretical. A restart changes the pod's public
key, so the registry's record of "this agent's key" stops being true until the
collector's rotation path catches up. Nothing durable may be wrapped to the key,
which is why the migration design had to specify a signing key persisted "inside
its sealed state" rather than reaching for the identity key that already exists.
And per-pod identity, the north star's weakest requirement, cannot rest on a
value that changes whenever the platform reschedules the container.

WHY THE POD'S OWN BUCKET, AND NOT SECRET MANAGER
------------------------------------------------
Secret Manager is the obvious answer and the wrong one here. The pod service
account holds **zero project roles** on purpose; that zero is the Isolation
requirement, verified live. Granting it secret-write access, even narrowly,
spends the property to store one key, and it needs a new bootstrap step and new
IAM in a project hushh may not own.

The pod already has everything required:

* a GCS bucket it owns, with a prefix scoped to itself;
* a KMS-wrapped DEK it can unwrap (``resolve_pod_log_key``), which on BYOC lives
  in the person's own KMS where hushh has no path at all;
* a compare-and-swap primitive on that bucket (``put_if_generation``).

So the identity key is stored exactly like the commit log is stored: an object
in the pod's own prefix, sealed under a key derived from the pod's own DEK.
**No new IAM, no new bootstrap step, and one custody story instead of two.**
Whatever is true of hushh's access to the commit log is true of this, which
means the honest sentence about it is a sentence we already say.

THE SEALING KEY IS DERIVED, NOT REUSED
--------------------------------------
HKDF with its own info label, exactly as ``derive_memory_key`` does. A key that
seals the log must not also seal the thing that proves who the pod is, so that
compromise of one purpose does not hand over the other.

THE CONCURRENT-BOOT RACE, AND WHY IT CONVERGES
----------------------------------------------
``maxScale`` is 1, but a revision switch can briefly overlap two instances, and
both would find no key and generate one. The write is therefore a
create-if-absent CAS (``put_if_generation(..., 0)``), and **the loser of that
race re-reads and adopts the winner's key** rather than keeping its own. Two
pods that disagree about their own identity is precisely the state this module
exists to prevent, so the race resolves toward agreement rather than toward
whoever wrote last.
"""

from __future__ import annotations

import base64
import logging
import os
import secrets
from typing import Any, Optional

logger = logging.getLogger(__name__)

#: Where the sealed keypair lives, inside the pod's own prefix. Beside
#: ``keys/log-key.wrapped``, which the BYOC custody path already writes there.
IDENTITY_KEY_OBJECT = "keys/pod-identity.bin"

#: Its own HKDF label. See the module docstring: the log's key must not also be
#: the key that seals the pod's proof of identity.
_SEAL_KEY_INFO = b"hushh/pod-identity/aes256gcm/v1"

_KEY_LEN = 32
_NONCE_LEN = 12
_X25519_RAW_LEN = 32

#: Ships dark. Off, the pod behaves exactly as it does today: it mints an
#: ephemeral key and reports ``podKeyDurable: False`` honestly.
_ENABLED_ENV = "POD_DURABLE_IDENTITY_ENABLED"


class PodIdentityStoreError(RuntimeError):
    """The identity key could not be stored or read back."""


def durable_identity_enabled() -> bool:
    return str(os.getenv(_ENABLED_ENV) or "").strip().lower() in {"1", "true", "yes", "on"}


def _seal_key(dek: bytes) -> bytes:
    from cryptography.hazmat.primitives import hashes  # noqa: PLC0415
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF  # noqa: PLC0415

    if len(dek) != _KEY_LEN:
        raise PodIdentityStoreError(f"the pod DEK must be exactly {_KEY_LEN} bytes")
    return HKDF(algorithm=hashes.SHA256(), length=_KEY_LEN, salt=None, info=_SEAL_KEY_INFO).derive(
        dek
    )


def seal_private_key(dek: bytes, private_raw: bytes) -> bytes:
    """Seal a raw 32-byte X25519 private key for storage in the pod's bucket."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: PLC0415

    if len(private_raw) != _X25519_RAW_LEN:
        raise PodIdentityStoreError("an X25519 private key is exactly 32 bytes")
    nonce = secrets.token_bytes(_NONCE_LEN)
    return nonce + AESGCM(_seal_key(dek)).encrypt(nonce, private_raw, _SEAL_KEY_INFO)


def open_private_key(dek: bytes, blob: bytes) -> bytes:
    """Recover the raw private key, or refuse.

    Authenticated decryption, so a truncated or altered object is a refusal
    rather than a key that is subtly wrong. A pod that booted with a corrupted
    identity would present a public key nobody recognises and fail every call it
    makes, which is a far more confusing failure than declining to start with it.
    """
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: PLC0415

    if len(blob) <= _NONCE_LEN:
        raise PodIdentityStoreError("the stored identity object is too short to be valid")
    try:
        raw = AESGCM(_seal_key(dek)).decrypt(blob[:_NONCE_LEN], blob[_NONCE_LEN:], _SEAL_KEY_INFO)
    except Exception as exc:  # noqa: BLE001
        raise PodIdentityStoreError(
            "the stored identity key failed authenticated decryption"
        ) from exc
    if len(raw) != _X25519_RAW_LEN:
        raise PodIdentityStoreError("the stored identity key is not 32 bytes")
    return raw


async def load_or_create_private_key(store: Any, dek: bytes) -> tuple[bytes, bool]:
    """The pod's durable private key. Returns (raw_key, created_now).

    Reads first. Generates and CAS-writes only when nothing is stored, and on a
    lost race re-reads and adopts the winner, so two overlapping instances end
    up agreeing about which key is theirs.

    Raises ``PodIdentityStoreError`` on a stored-but-unreadable object, which is
    a genuine fault and must not be papered over by minting a replacement: doing
    that would silently orphan everything already wrapped to the real key.
    """
    existing = await store.get(IDENTITY_KEY_OBJECT)
    if existing:
        return open_private_key(dek, existing), False

    from cryptography.hazmat.primitives import serialization  # noqa: PLC0415
    from cryptography.hazmat.primitives.asymmetric.x25519 import (  # noqa: PLC0415
        X25519PrivateKey,
    )

    candidate = X25519PrivateKey.generate().private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    written = await store.put_if_generation(
        IDENTITY_KEY_OBJECT, seal_private_key(dek, candidate), 0
    )
    if written is not None:
        return candidate, True

    # Lost the create race. The other instance's key is the pod's identity now,
    # and adopting it is the whole point: keeping ours would mean two live
    # processes disagreeing about who this agent is.
    winner = await store.get(IDENTITY_KEY_OBJECT)
    if not winner:
        raise PodIdentityStoreError(
            "the identity object was claimed by another writer and then could not be read"
        )
    logger.info("pod_identity.adopted_concurrent_writer_key")
    return open_private_key(dek, winner), False


async def resolve_durable_private_key_b64() -> Optional[str]:
    """The pod's durable private key as base64, or None if unavailable.

    The seam ``pod_self_registration`` consumes. Returns None for every ordinary
    reason (flag off, no durable storage configured, no KMS access), because a
    pod that cannot persist its identity must still boot and serve with an
    ephemeral one exactly as it does today, reporting ``podKeyDurable: False``
    honestly rather than claiming a durability it does not have.

    A stored-but-corrupt key is the one case that is logged as an error rather
    than a shrug, because it means something wrote over the pod's identity.
    """
    if not durable_identity_enabled():
        return None
    try:
        from hushh_mcp.services.byoc_key_custody import resolve_pod_log_key  # noqa: PLC0415
        from hushh_mcp.services.pod_storage import (  # noqa: PLC0415
            BACKEND_COMMIT_LOG,
            resolve_pod_storage,
        )

        storage = resolve_pod_storage()
        if getattr(storage, "backend_id", "") != BACKEND_COMMIT_LOG:
            logger.info("pod_identity.no_durable_storage -- identity key stays ephemeral")
            return None
        log = getattr(storage, "_log", None)
        store = getattr(log, "_store", None)
        if store is None:
            return None
        dek = resolve_pod_log_key()
    except Exception:  # noqa: BLE001 - never let identity persistence break a boot
        logger.warning("pod_identity.custody_unavailable -- identity key stays ephemeral")
        return None

    try:
        raw, created = await load_or_create_private_key(store, dek)
    except PodIdentityStoreError:
        logger.error(
            "pod_identity.stored_key_unreadable -- refusing to mint over it", exc_info=True
        )
        return None
    except Exception:  # noqa: BLE001
        logger.warning("pod_identity.persist_failed -- identity key stays ephemeral", exc_info=True)
        return None

    logger.info("pod_identity.durable_key_ready created=%s", created)
    return base64.b64encode(raw).decode("ascii")


__all__ = [
    "IDENTITY_KEY_OBJECT",
    "PodIdentityStoreError",
    "durable_identity_enabled",
    "load_or_create_private_key",
    "open_private_key",
    "resolve_durable_private_key_b64",
    "seal_private_key",
]

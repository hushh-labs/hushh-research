"""The pod's role (primary or standby): a sealed object beside its identity key.

WHY AN OBJECT AND NOT A LOG RECORD (E1)
---------------------------------------
Equal heads are the proof that a standby lost nothing. Any record a standby wrote
for itself -- a role, a config, a binding -- would fork its chain from the
primary's and break every later sync. So the role lives OUTSIDE the commit log, as
``keys/pod-role.bin`` in the pod's own prefix, sealed exactly like
``keys/pod-identity.bin`` (``pod_identity_store``): AES-256-GCM under a key HKDF-
derived from the pod's own DEK with its own info label. No new IAM, one custody
story.

FAIL CLOSED (E3)
----------------
Only a CONFIRMED not-found means "primary at epoch 0", which is every pod that
exists today. A refused read (403), a transport error, a key that will not unwrap,
or an object that fails authenticated decryption or shape checks raises
:class:`PodRoleUnreadable`, and callers refuse turns and writes. A standby whose
role cannot be read must never promote itself by default.

A pod with no durable storage at all (``POD_STORAGE_BACKEND`` unset or ``null``)
has nowhere a role could be recorded and nothing to sync, so it is a primary at
epoch 0 without any I/O: today's behaviour exactly.

FORWARD ONLY (E2)
-----------------
Writes are compare-and-swap on the object's version. A stored role is replaced
only by a strictly higher epoch; an equal or older epoch is refused. The first
write (no object yet) accepts any epoch >= 0, because no epoch has been recorded.
"""

from __future__ import annotations

import contextlib
import contextvars
import json
import os
import secrets
import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, Optional

from hushh_mcp.services.pod_object_version import ABSENT

ROLE_OBJECT = "keys/pod-role.bin"
ROLE_VERSION = "pod_role_v1"
ROLE_PRIMARY = "primary"
ROLE_STANDBY = "standby"
ROLES: frozenset[str] = frozenset({ROLE_PRIMARY, ROLE_STANDBY})

#: Typed refusal codes, carried in a refused response's body.
CODE_STANDBY = "POD_ROLE_STANDBY"
CODE_UNREADABLE = "POD_ROLE_UNREADABLE"

_SEAL_INFO = b"hushh/pod-role/aes256gcm/v1"
_KEY_LEN = 32
_NONCE_LEN = 12
#: How long a confirmed read is trusted in-process. A role write in THIS process
#: replaces the cached copy immediately; the window only bounds a second, briefly
#: overlapping instance. The hub's epoch fence (E4) is the cross-process fence.
_CACHE_TTL_SECONDS = 30.0
_STORAGE_ENVS = (
    "POD_STORAGE_BACKEND",
    "POD_STORAGE_LOCAL_ROOT",
    "POD_STORAGE_GCS_BUCKET",
    "POD_STORAGE_GCS_PREFIX",
    "POD_STORAGE_AZURE_BLOB_URL",
    "HUSSH_ID",
)


class PodRoleError(RuntimeError):
    """Base for role failures."""


class PodRoleUnreadable(PodRoleError):
    """The role could not be confirmed. Callers refuse turns and writes."""


class PodRoleStaleEpoch(PodRoleError):
    """A role write carried an epoch that is not strictly newer than the stored one."""


class PodRoleConflict(PodRoleError):
    """The role object changed between read and write; nothing was written."""


class PodRoleRefused(PodRoleError):
    """This pod's role refuses the operation (a standby asked to write or answer)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class PodRole:
    role: str
    epoch: int
    #: The primary's Ed25519 pod signing key id, pinned on a standby (E5); None on a primary.
    primary_signing_key_id: Optional[str] = None

    @property
    def is_standby(self) -> bool:
        return self.role == ROLE_STANDBY

    def as_record(self) -> dict[str, Any]:
        return {
            "version": ROLE_VERSION,
            "role": self.role,
            "epoch": self.epoch,
            "primarySigningKeyId": self.primary_signing_key_id,
        }


#: Every pod that exists today: no role object, primary, epoch 0.
PRIMARY_AT_ZERO = PodRole(role=ROLE_PRIMARY, epoch=0)


def validate_role(role: PodRole) -> PodRole:
    """Shape rules shared by reads and writes."""
    from hushh_mcp.services.pod_request_signing import is_signing_key_id  # noqa: PLC0415

    if role.role not in ROLES or type(role.epoch) is not int or role.epoch < 0:
        raise ValueError("a role is primary or standby with a non-negative integer epoch")
    if role.is_standby and not is_signing_key_id(role.primary_signing_key_id):
        raise ValueError("a standby pins its primary's signing key id")
    if not role.is_standby and role.primary_signing_key_id is not None:
        raise ValueError("a primary pins no other key")
    return role


# -- sealing ---------------------------------------------------------------------------


def role_seal_key(dek: bytes) -> bytes:
    """HKDF(dek, info=hushh/pod-role/aes256gcm/v1): never the log's key itself."""
    from cryptography.hazmat.primitives import hashes  # noqa: PLC0415
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF  # noqa: PLC0415

    if len(dek) != _KEY_LEN:
        raise PodRoleError("the pod DEK must be exactly 32 bytes")
    return HKDF(algorithm=hashes.SHA256(), length=_KEY_LEN, salt=None, info=_SEAL_INFO).derive(dek)


def _aad(hushh_id: str) -> bytes:
    return _SEAL_INFO + b"|" + str(hushh_id or "").encode("utf-8")


def seal_role(seal_key: bytes, role: PodRole, *, hushh_id: str) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: PLC0415

    plaintext = json.dumps(
        validate_role(role).as_record(), sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    nonce = secrets.token_bytes(_NONCE_LEN)
    return nonce + AESGCM(seal_key).encrypt(nonce, plaintext, _aad(hushh_id))


def open_role(seal_key: bytes, blob: bytes, *, hushh_id: str) -> PodRole:
    """Authenticated decryption plus strict shape, or :class:`PodRoleUnreadable`."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: PLC0415

    try:
        plaintext = AESGCM(seal_key).decrypt(blob[:_NONCE_LEN], blob[_NONCE_LEN:], _aad(hushh_id))
        record = json.loads(plaintext)
        if not isinstance(record, dict) or set(record) != {
            "version",
            "role",
            "epoch",
            "primarySigningKeyId",
        }:
            raise ValueError("shape")
        if record["version"] != ROLE_VERSION:
            raise ValueError("version")
        return validate_role(
            PodRole(
                role=record["role"],
                epoch=record["epoch"],
                primary_signing_key_id=record["primarySigningKeyId"],
            )
        )
    except Exception:  # noqa: BLE001 - every failure here is the same refusal
        raise PodRoleUnreadable("the stored role failed authenticated decryption") from None


# -- storage ---------------------------------------------------------------------------


async def load_role(store: Any, seal_key: bytes, *, hushh_id: str) -> PodRole:
    """Read the role from ``store``. Absent is primary at epoch 0; anything else fails closed."""
    try:
        raw = await store.get(ROLE_OBJECT)
    except Exception:  # noqa: BLE001 - a refused or failed read is never "absent"
        raise PodRoleUnreadable("the role object could not be read") from None
    if raw is None:
        return PRIMARY_AT_ZERO
    return open_role(seal_key, raw, hushh_id=hushh_id)


async def store_role(store: Any, seal_key: bytes, new: PodRole, *, hushh_id: str) -> PodRole:
    """Compare-and-swap ``new`` over the stored role, strictly forward in epoch."""
    validate_role(new)
    try:
        raw, version = await store.get_with_generation(ROLE_OBJECT)
    except Exception:  # noqa: BLE001
        raise PodRoleUnreadable("the role object could not be read") from None
    if raw is not None:
        current = open_role(seal_key, raw, hushh_id=hushh_id)
        if new.epoch <= current.epoch:
            raise PodRoleStaleEpoch(
                f"role epoch {new.epoch} is not newer than the stored epoch {current.epoch}"
            )
    expected = version if raw is not None else ABSENT
    written = await store.put_if_generation(
        ROLE_OBJECT, seal_role(seal_key, new, hushh_id=hushh_id), expected
    )
    if written is None:
        raise PodRoleConflict("the role object changed during the write")
    remember_role(new)
    return new


# -- the process view ------------------------------------------------------------------

_CACHE: Optional[tuple[tuple[str, ...], PodRole, float]] = None
_SYNC_IMPORT: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "pod_sync_import", default=False
)


def _fingerprint() -> tuple[str, ...]:
    """Which pod storage a cached role belongs to."""
    return tuple((os.getenv(name) or "").strip() for name in _STORAGE_ENVS)


def cached_role() -> Optional[PodRole]:
    if _CACHE is None:
        return None
    fingerprint, role, at = _CACHE
    if fingerprint != _fingerprint() or time.monotonic() - at > _CACHE_TTL_SECONDS:
        return None
    return role


def remember_role(role: PodRole) -> None:
    global _CACHE
    _CACHE = (_fingerprint(), role, time.monotonic())


def reset_role_cache() -> None:
    global _CACHE
    _CACHE = None


def durable_storage_configured() -> bool:
    """True for the commit-log backend; False for none; unreadable for anything else."""
    from hushh_mcp.services.pod_storage import (  # noqa: PLC0415
        BACKEND_COMMIT_LOG,
        BACKEND_NULL,
        pod_storage_backend,
    )

    selected = pod_storage_backend()
    if selected in ("", BACKEND_NULL):
        return False
    if selected == BACKEND_COMMIT_LOG:
        return True
    raise PodRoleUnreadable("the pod storage backend is not one a role can be read from")


async def read_pod_role(*, fresh: bool = False) -> PodRole:
    """This pod's role. Raises :class:`PodRoleUnreadable` on anything but a confirmed read.

    Reads the object WITHOUT the key first, so a pod with no role object (every pod
    today) never unwraps its DEK for this check.
    """
    if not durable_storage_configured():
        return PRIMARY_AT_ZERO
    if not fresh and (hit := cached_role()) is not None:
        return hit
    try:
        from hushh_mcp.services.pod_storage import resolve_pod_object_store  # noqa: PLC0415

        store = resolve_pod_object_store()
        raw = await store.get(ROLE_OBJECT)
    except Exception:  # noqa: BLE001
        raise PodRoleUnreadable("the role object could not be read") from None
    if raw is None:
        remember_role(PRIMARY_AT_ZERO)
        return PRIMARY_AT_ZERO
    try:
        from hushh_mcp.services.byoc_key_custody import resolve_pod_log_key  # noqa: PLC0415

        seal_key = role_seal_key(resolve_pod_log_key())
    except Exception:  # noqa: BLE001 - an unwrap failure is unreadable, never primary
        raise PodRoleUnreadable("the pod key could not be unwrapped to read the role") from None
    role = open_role(seal_key, raw, hushh_id=(os.getenv("HUSSH_ID") or "").strip())
    remember_role(role)
    return role


async def require_serving_role() -> PodRole:
    """The role, if it may answer turns and accept writes; else a typed refusal."""
    try:
        role = await read_pod_role()
    except PodRoleUnreadable as exc:
        raise PodRoleRefused(CODE_UNREADABLE, "this agent's role could not be confirmed") from exc
    if role.is_standby:
        raise PodRoleRefused(CODE_STANDBY, "this agent is a standby and does not answer or write")
    return role


@contextlib.contextmanager
def sync_import_scope() -> Iterator[None]:
    """Marks appends made by a verified sync import, the one write a standby accepts."""
    token = _SYNC_IMPORT.set(True)
    try:
        yield
    finally:
        _SYNC_IMPORT.reset(token)


def in_sync_import() -> bool:
    return _SYNC_IMPORT.get()


__all__ = [
    "CODE_STANDBY",
    "CODE_UNREADABLE",
    "PRIMARY_AT_ZERO",
    "ROLE_OBJECT",
    "ROLE_PRIMARY",
    "ROLE_STANDBY",
    "PodRole",
    "PodRoleConflict",
    "PodRoleError",
    "PodRoleRefused",
    "PodRoleStaleEpoch",
    "PodRoleUnreadable",
    "cached_role",
    "in_sync_import",
    "load_role",
    "open_role",
    "read_pod_role",
    "remember_role",
    "require_serving_role",
    "reset_role_cache",
    "role_seal_key",
    "seal_role",
    "store_role",
    "sync_import_scope",
    "validate_role",
]

"""Crypto-erase a pod's own durable state, from inside the pod, on a fenced erasure order.

WHY THE POD DOES IT
-------------------
In a person's own cloud account Hussh holds no storage or key role (the trust matrix
in ``docs/reference/architecture/byoc-azure.md``). Only the pod's own identity can
delete its wrapped key and its objects, so the hub asks the pod, behind the
hub-proof erasure fence (``api/routes/one/pod_migration.py``), and revokes access
only after the pod confirms. Nothing here authenticates a request; the route does.

ORDER, AND WHY
--------------
1. A **tombstone** is written create-only before anything is deleted. It binds the
   attempt and a digest of the owner, and lists the chained record keys, read while
   the key could still open the log. It is the durable marker: a retry finishes from
   it without the key, and key custody refuses to mint a replacement key while it
   exists (``pod_key_vault_custody``), so the next request cannot quietly start a
   second history that claims to be the erased agent.
2. The **wrapped data key goes first**. From that moment every sealed object is
   ciphertext nobody can open. Then the identity key, the incarnation fence, memory
   bookkeeping, the session projection, the chained records, and the head last.
3. **Deletes are idempotent**: an object already gone counts as absent. A refused
   delete raises, so the hub never revokes on an unconfirmed erase.

NOT ENUMERATED: orphan records from lost append races (never chained) and Files
objects (Files is off for owner Azure agents). Both are sealed under the destroyed
key; the person's receipt names the storage account that still holds them.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Awaitable, Callable
from typing import Any

from hushh_mcp.services.pod_commit_log import ObjectStore, PodCommitLog, object_key_segments
from hushh_mcp.services.pod_object_version import ABSENT

#: Plaintext on purpose: it must stay readable after the key is gone. It holds an
#: attempt id, an owner digest and object names, never content.
ERASURE_TOMBSTONE_OBJECT = "erasure/crypto-erase.json"
_TOMBSTONE_KIND = "pod_crypto_erase_v1"
_MAX_TOMBSTONE_BYTES = 8 * 1024 * 1024


class PodCryptoEraseRefused(RuntimeError):
    """The pod did not erase. Never carries storage bodies or owner identifiers."""


def owned_objects(wrapped_key_object: str) -> tuple[str, ...]:
    """The fixed objects a pod writes under its prefix, the wrapped key first."""
    from hushh_mcp.one_adk.pod_adk_checkpoint import KEY as SESSION_PROJECTION  # noqa: PLC0415
    from hushh_mcp.services.pod_authority_store import INCARNATION_OBJECT  # noqa: PLC0415
    from hushh_mcp.services.pod_identity_store import IDENTITY_KEY_OBJECT  # noqa: PLC0415
    from hushh_mcp.services.pod_memory_bank import MEMORY_BANK_RECORD_KEY  # noqa: PLC0415

    return (
        wrapped_key_object,
        IDENTITY_KEY_OBJECT,
        INCARNATION_OBJECT,
        MEMORY_BANK_RECORD_KEY,
        SESSION_PROJECTION,
    )


def _owner_digest(owner_id: str) -> str:
    return hashlib.sha256(owner_id.encode("utf-8")).hexdigest()


def _tombstone(owner_id: str, attempt_id: str, record_keys: list[str]) -> bytes:
    body = {
        "kind": _TOMBSTONE_KIND,
        "version": 1,
        "ownerDigest": _owner_digest(owner_id),
        "attemptId": attempt_id,
        "records": record_keys,
    }
    return json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _valid_record_key(key: Any) -> bool:
    if not isinstance(key, str) or not key.startswith("records/"):
        return False
    try:
        object_key_segments(key)
    except ValueError:
        return False
    return True


def bound_record_keys(raw: bytes, *, owner_id: str, attempt_id: str) -> list[str]:
    """The record keys a tombstone lists, only when it binds THIS owner and attempt."""
    try:
        body = json.loads(raw) if len(raw) <= _MAX_TOMBSTONE_BYTES else None
        if (
            not isinstance(body, dict)
            or set(body) != {"kind", "version", "ownerDigest", "attemptId", "records"}
            or body["kind"] != _TOMBSTONE_KIND
            or type(body["version"]) is not int
            or body["version"] != 1
            or not isinstance(body["records"], list)
            or not all(_valid_record_key(key) for key in body["records"])
        ):
            raise ValueError("shape")
    except ValueError:
        raise PodCryptoEraseRefused("the erasure tombstone is malformed") from None
    if body["ownerDigest"] != _owner_digest(owner_id) or body["attemptId"] != attempt_id:
        raise PodCryptoEraseRefused("the pod was erased under a different attempt")
    return list(body["records"])


async def _claim_tombstone(
    store: ObjectStore,
    *,
    owner_id: str,
    attempt_id: str,
    open_fenced_log: Callable[[], Awaitable[PodCommitLog]],
) -> bytes:
    """Write the tombstone once; a concurrent erase that won it is adopted, never raced."""
    log = await open_fenced_log()
    keys = await log.fenced_record_keys(owner_id=owner_id, attempt_id=attempt_id)
    tombstone = _tombstone(owner_id, attempt_id, keys)
    if await store.put_if_generation(ERASURE_TOMBSTONE_OBJECT, tombstone, ABSENT) is not None:
        return tombstone
    winner, _ = await store.get_with_generation(ERASURE_TOMBSTONE_OBJECT)
    if winner is None:
        raise PodCryptoEraseRefused("the erasure tombstone could not be confirmed")
    return winner


async def crypto_erase(
    *,
    store: ObjectStore,
    owner_id: str,
    attempt_id: str,
    wrapped_key_object: str,
    open_fenced_log: Callable[[], Awaitable[PodCommitLog]],
) -> dict[str, int]:
    """Destroy the key, then the objects; idempotent per attempt. Returns counts only.

    ``open_fenced_log`` must close admission for exactly this attempt and return the
    pod's log; it is called only while no tombstone exists, because afterwards the
    key it needs is gone by design.
    """
    raw, _ = await store.get_with_generation(ERASURE_TOMBSTONE_OBJECT)
    if raw is None:
        raw = await _claim_tombstone(
            store, owner_id=owner_id, attempt_id=attempt_id, open_fenced_log=open_fenced_log
        )
    records = bound_record_keys(raw, owner_id=owner_id, attempt_id=attempt_id)
    targets = (*owned_objects(wrapped_key_object), *records, PodCommitLog.HEAD)
    deleted = 0
    for key in targets:
        deleted += int(await store.delete(key))
    return {"deleted": deleted, "alreadyAbsent": len(targets) - deleted, "records": len(records)}


__all__ = [
    "ERASURE_TOMBSTONE_OBJECT",
    "PodCryptoEraseRefused",
    "bound_record_keys",
    "crypto_erase",
    "owned_objects",
]

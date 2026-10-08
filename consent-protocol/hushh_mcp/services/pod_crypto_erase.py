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
   attempt and a digest of the owner, and lists chained records and inventoried
   browser session objects (including unpublished/forgotten intents), read while
   the key could still open the log. It is the durable marker: a retry finishes from
   it without the key, and key custody refuses to mint a replacement key while it
   exists (``pod_key_vault_custody``), so the next request cannot quietly start a
   second history that claims to be the erased agent.
   Connector grants are inventoried behind the verified fence and revocation is
   attempted before the tombstone is written. Only bounded hashed receipts survive;
   a provider outage does not block erasure of the person's local information.
2. The **wrapped data key goes first**. From that moment every sealed object is
   ciphertext nobody can open. Then the identity key, the incarnation fence, the
   session projection and the chained records.
3. **The fences stay closed.** A live process still holds the data key in memory,
   and Hussh cannot stop the container, so the two objects that refuse its writes are
   never deleted. The log head stays the sealed erasure fence (ciphertext under the
   destroyed key), and memory bookkeeping becomes a closed stub that names no owner.
   The last step checks that no head a live process could extend exists.
4. **Deletes are idempotent**: an object already gone counts as absent. A refused
   delete raises, so the hub never revokes on an unconfirmed erase.

NOT ENUMERATED: orphan records from lost append races (never chained) and Files
objects (Files is off for owner Azure agents). Both are sealed under the destroyed
key; the person's receipt names the storage account that still holds them.
Browser object deletion also requires drained/fenced writers; a cloud delete
acknowledgement does not prove physical removal under retention policies.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Awaitable, Callable
from typing import Any

from hushh_mcp.services.pod_commit_log import ObjectStore, PodCommitLog, object_key_segments
from hushh_mcp.services.pod_object_version import ABSENT

#: Plaintext on purpose: it must stay readable after the key is gone. It holds an
#: attempt id, an owner digest and object names, never content.
ERASURE_TOMBSTONE_OBJECT = "erasure/crypto-erase.json"
_TOMBSTONE_KIND = "pod_crypto_erase_v1"
_MAX_TOMBSTONE_BYTES = 8 * 1024 * 1024
#: Memory bookkeeping after erasure: still "erasure" (every reader refuses it, and
#: its shape matches no lifecycle phase), and no owner identifier in plaintext.
ERASED_MEMORY_RECORD = b'{"erasure":{"phase":"crypto_erased","version":1}}'
#: Written only if the head is missing: its sequence is not an integer, which is
#: exactly what makes every log reader refuse it, as it does the sealed fence.
_ERASED_HEAD = b'{"seq":"erased","state":"erased","version":2}'


class PodCryptoEraseRefused(RuntimeError):
    """The pod did not erase. Never carries storage bodies or owner identifiers."""


def owned_objects(wrapped_key_object: str) -> tuple[str, ...]:
    """The fixed objects a pod deletes under its prefix, the wrapped key first.

    Not the log head or memory bookkeeping: those hold the erasure fences
    (``crypto_erase`` closes them instead of deleting them).
    """
    from hushh_mcp.one_adk.pod_adk_checkpoint import KEY as SESSION_PROJECTION  # noqa: PLC0415
    from hushh_mcp.services.pod_authority_store import INCARNATION_OBJECT  # noqa: PLC0415
    from hushh_mcp.services.pod_identity_store import IDENTITY_KEY_OBJECT  # noqa: PLC0415
    from hushh_mcp.services.pod_role import ROLE_OBJECT  # noqa: PLC0415

    owned = (wrapped_key_object, IDENTITY_KEY_OBJECT, INCARNATION_OBJECT, SESSION_PROJECTION)
    return (*owned, ROLE_OBJECT)  # a standby erases exactly like a primary (E10)


def _owner_digest(owner_id: str) -> str:
    return hashlib.sha256(owner_id.encode("utf-8")).hexdigest()


def _tombstone(
    owner_id: str,
    attempt_id: str,
    record_keys: list[str],
    browser_keys: list[str],
    provider_revocations: dict[str, Any],
) -> bytes:
    body = {
        "kind": _TOMBSTONE_KIND,
        "version": 3,
        "ownerDigest": _owner_digest(owner_id),
        "attemptId": attempt_id,
        "records": record_keys,
        "browserObjects": browser_keys,
        "providerRevocations": provider_revocations,
    }
    raw = json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(raw) > _MAX_TOMBSTONE_BYTES:
        raise PodCryptoEraseRefused("the erasure inventory exceeds its bound")
    return raw


def _valid_record_key(key: Any) -> bool:
    if not isinstance(key, str) or not key.startswith("records/"):
        return False
    try:
        object_key_segments(key)
    except ValueError:
        return False
    return True


def _valid_provider_receipts(value: Any) -> bool:
    """Strict metadata only: counts and provider/project/account digests, never tokens."""
    if not isinstance(value, dict) or set(value) != {
        "revoked",
        "unrevoked",
        "unavailable",
        "receipts",
    }:
        return False
    for name in ("revoked", "unrevoked", "unavailable"):
        if type(value[name]) is not int or not 0 <= value[name] <= (
            1 if name == "unavailable" else 128
        ):
            return False
    receipts = value["receipts"]
    if not isinstance(receipts, list) or len(receipts) > 128:
        return False
    for receipt in receipts:
        if (
            not isinstance(receipt, dict)
            or set(receipt) != {"provider", "grantDigest", "outcome"}
            or receipt["provider"] not in ("google", "mcp")
            or not isinstance(receipt["grantDigest"], str)
            or re.fullmatch(r"[a-f0-9]{64}", receipt["grantDigest"]) is None
            or receipt["outcome"] not in ("confirmed", "unconfirmed")
        ):
            return False
    return (
        value["revoked"] == sum(r["outcome"] == "confirmed" for r in receipts)
        and value["unrevoked"] == sum(r["outcome"] == "unconfirmed" for r in receipts)
        and (not value["unavailable"] or not receipts)
    )


def bound_record_keys(raw: bytes, *, owner_id: str, attempt_id: str) -> list[str]:
    """The record keys a tombstone lists, only when it binds THIS owner and attempt."""
    try:
        body = json.loads(raw) if len(raw) <= _MAX_TOMBSTONE_BYTES else None
        if (
            not isinstance(body, dict)
            or set(body)
            != (
                {"kind", "version", "ownerDigest", "attemptId", "records"}
                | ({"browserObjects"} if body.get("version") in (2, 3) else set())
                | ({"providerRevocations"} if body.get("version") == 3 else set())
            )
            or body["kind"] != _TOMBSTONE_KIND
            or type(body["version"]) is not int
            or body["version"] not in {1, 2, 3}
            or not isinstance(body["records"], list)
            or not all(_valid_record_key(key) for key in body["records"])
            or (
                body["version"] in {2, 3}
                and (
                    not isinstance(body["browserObjects"], list)
                    or len(body["browserObjects"]) > 10000
                    or not all(
                        isinstance(key, str)
                        and re.fullmatch(r"browser/sessions/[a-f0-9]{32}\.bin", key)
                        for key in body["browserObjects"]
                    )
                )
            )
            or (body["version"] == 3 and not _valid_provider_receipts(body["providerRevocations"]))
        ):
            raise ValueError("shape")
    except ValueError:
        raise PodCryptoEraseRefused("the erasure tombstone is malformed") from None
    if body["ownerDigest"] != _owner_digest(owner_id) or body["attemptId"] != attempt_id:
        raise PodCryptoEraseRefused("the pod was erased under a different attempt")
    return list(body["records"])


def bound_browser_keys(raw: bytes, *, owner_id: str, attempt_id: str) -> list[str]:
    bound_record_keys(raw, owner_id=owner_id, attempt_id=attempt_id)
    return list(json.loads(raw).get("browserObjects", []))


def provider_revocation_counts(raw: bytes, *, owner_id: str, attempt_id: str) -> dict[str, int]:
    """A verified tombstone's provider outcome, independently of local key erasure."""
    bound_record_keys(raw, owner_id=owner_id, attempt_id=attempt_id)
    receipts = json.loads(raw).get("providerRevocations")
    if receipts is None:  # legacy erasure gives no evidence of external revocation
        return {"providerRevoked": 0, "providerUnconfirmed": 0, "providerUnavailable": 1}
    return {
        "providerRevoked": receipts["revoked"],
        "providerUnconfirmed": receipts["unrevoked"],
        "providerUnavailable": receipts["unavailable"],
    }


async def _claim_tombstone(
    store: ObjectStore,
    *,
    owner_id: str,
    attempt_id: str,
    open_fenced_log: Callable[[], Awaitable[PodCommitLog]],
    provider_post: Any = None,
) -> bytes:
    """Write the tombstone once; a concurrent erase that won it is adopted, never raced."""
    log = await open_fenced_log()
    browser = set()

    def collect(record):
        if record["kind"] != "browser_session_v1":
            return
        entry = record["payload"]
        if not isinstance(entry, dict) or entry.get("operation") not in {
            "intent",
            "publish",
            "forget",
        }:
            raise PodCryptoEraseRefused("the browser inventory is malformed")
        if entry["operation"] == "forget":
            return
        key = entry.get("object")
        if not isinstance(key, str) or not re.fullmatch(r"browser/sessions/[a-f0-9]{32}\.bin", key):
            raise PodCryptoEraseRefused("the browser inventory is malformed")
        browser.add(key)
        if len(browser) > 10000:
            raise PodCryptoEraseRefused("the browser inventory exceeds its bound")

    keys = await log.fold_fenced(owner_id=owner_id, attempt_id=attempt_id, visit_reverse=collect)
    from hushh_mcp.services.pod_connector_connect import revoke_fenced  # noqa: PLC0415

    provider_revocations = await revoke_fenced(
        log, owner_id=owner_id, attempt_id=attempt_id, hushh_id=owner_id, post=provider_post
    )
    if not _valid_provider_receipts(provider_revocations):
        raise PodCryptoEraseRefused("the provider receipt did not verify")
    tombstone = _tombstone(owner_id, attempt_id, keys, sorted(browser), provider_revocations)
    if await store.put_if_generation(ERASURE_TOMBSTONE_OBJECT, tombstone, ABSENT) is not None:
        return tombstone
    winner, _ = await store.get_with_generation(ERASURE_TOMBSTONE_OBJECT)
    if not isinstance(winner, bytes):
        raise PodCryptoEraseRefused("the erasure tombstone could not be confirmed")
    return winner


def _extendable(head: bytes) -> bool:
    """Whether a live process holding the key could append on this head.

    An open head has an integer sequence; the sealed fence and the erased marker do
    not, so ``PodCommitLog`` refuses them (fenced or tampered). No key is needed.
    """
    try:
        parsed = json.loads(head)
    except ValueError:
        return False
    return isinstance(parsed, dict) and type(parsed.get("seq")) is int


async def _replace(store: ObjectStore, key: str, data: bytes) -> None:
    """Compare-and-swap ``key`` to ``data`` (records are create-only, so no blind put)."""
    for _ in range(4):
        current, generation = await store.get_with_generation(key)
        if current == data:
            return
        await store.put_if_generation(key, data, generation)
    if await store.get(key) != data:
        raise PodCryptoEraseRefused("memory bookkeeping kept moving during erasure")


async def _close_fences(store: ObjectStore) -> None:
    """Keep memory admission and the log closed for any process still running."""
    from hushh_mcp.services.pod_memory_bank import MEMORY_BANK_RECORD_KEY  # noqa: PLC0415

    await _replace(store, MEMORY_BANK_RECORD_KEY, ERASED_MEMORY_RECORD)
    head = await store.get(PodCommitLog.HEAD)
    if head is None:
        await store.put_if_generation(PodCommitLog.HEAD, _ERASED_HEAD, ABSENT)
        head = await store.get(PodCommitLog.HEAD)
    if head is None or _extendable(head):
        raise PodCryptoEraseRefused("the log head is open; the erasure is not complete")


async def crypto_erase(
    *,
    store: ObjectStore,
    owner_id: str,
    attempt_id: str,
    wrapped_key_object: str,
    open_fenced_log: Callable[[], Awaitable[PodCommitLog]],
    provider_post: Any = None,
) -> dict[str, int]:
    """Destroy the key, then the objects; idempotent per attempt. Returns counts only.

    ``open_fenced_log`` must close admission for exactly this attempt and return the
    pod's log; it is called only while no tombstone exists, because afterwards the
    key it needs is gone by design.
    """
    raw, _ = await store.get_with_generation(ERASURE_TOMBSTONE_OBJECT)
    if raw is None:
        raw = await _claim_tombstone(
            store,
            owner_id=owner_id,
            attempt_id=attempt_id,
            open_fenced_log=open_fenced_log,
            provider_post=provider_post,
        )
    records = bound_record_keys(raw, owner_id=owner_id, attempt_id=attempt_id)
    browser = bound_browser_keys(raw, owner_id=owner_id, attempt_id=attempt_id)
    providers = provider_revocation_counts(raw, owner_id=owner_id, attempt_id=attempt_id)
    targets = (*owned_objects(wrapped_key_object), *records, *browser)
    deleted = 0
    for key in targets:
        deleted += int(await store.delete(key))
    await _close_fences(store)
    return {
        "deleted": deleted,
        "alreadyAbsent": len(targets) - deleted,
        "records": len(records),
        **providers,
    }


__all__ = [
    "ERASED_MEMORY_RECORD",
    "ERASURE_TOMBSTONE_OBJECT",
    "PodCryptoEraseRefused",
    "bound_record_keys",
    "crypto_erase",
    "owned_objects",
    "provider_revocation_counts",
]

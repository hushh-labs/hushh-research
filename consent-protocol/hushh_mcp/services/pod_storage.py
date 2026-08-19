"""Pod storage & sync seam: PKM cloud backup ⇄ pod cache ⇄ device (private tunnel).

**Default backend is the inert Null one.** The real backend (``commit_log``) is
wired: an encrypted, hash-chained commit log in object storage
(:mod:`hushh_mcp.services.pod_commit_log`) as the system of record, with the
pod's SQLite working store rebuilt from it
(:mod:`hushh_mcp.services.pod_pkm_store`). Nothing moves data until
``POD_STORAGE_BACKEND=commit_log`` is set with its full configuration.

The intent (founder directive): the per-user pod is not only *shared compute* for
the user's agents, it is also a *storage node* for their PKM. Hussh is the control
plane, not the custodian of the holdings. The durable **backup-of-record is the
user's own**: an encrypted commit log in the user's own cloud (on BYOC, a bucket
plus a KMS key in the user's own GCP project), reached keylessly with the pod's
identity token. The pod additionally holds a **per-pod-key-encrypted working copy**
so the user's agents read/write locally at compute speed, and the **device** keeps
its own BYOK copy. The three replicas stay consistent by syncing **encrypted
deltas** over a **private, single-use tunnel** (the relay ticket), so plaintext
exists only inside the pod's isolated process and on the device. Hussh and the
transit see ciphertext only. **Zero-knowledge is preserved end to end.**

This module defines the *contract* (the three roles, a Protocol, an inert Null
implementation, and a plan descriptor). The concrete pod-side cache plus a per-user
encrypted-object backend (the user's own bucket plus per-user KMS) are a later
milestone; the commit-log backend already provides the user-owned cloud backup.

Legibility-by-design: the only data structure that crosses a boundary here is an
``EncryptedBlobRef``, a *pointer to ciphertext* plus crypto metadata. There is
**no plaintext field anywhere in this contract**, so a reviewer can see that this
seam cannot leak PKM.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Optional, Protocol

# The three storage roles that hold a replica of the user's PKM.
ROLE_CLOUD_BACKUP = (
    "cloud_vault"  # the user's own encrypted cloud backup-of-record (BYOC bucket + KMS).
)
ROLE_POD_CACHE = "pod"  # per-pod-key-encrypted working copy next to the agents.
ROLE_DEVICE = "device"  # on-device BYOK copy (mobile / Puppy One).

# The private transport between device and pod. Single-use, signed, replay-checked
# (the existing One ADK relay ticket) — never a public, reusable URL.
TUNNEL_RELAY_TICKET = "relay_ticket"

# Backend selector env (mirrors PERSONAL_AGENT_BACKEND for compute).
_BACKEND_ENV = "POD_STORAGE_BACKEND"
BACKEND_NULL = "null"
# The real backend: an encrypted, hash-chained commit log in object storage
# (pod_commit_log). Configured by exactly one of:
#   POD_STORAGE_LOCAL_ROOT  -- filesystem root (tests, dev, single-node hardware)
#   POD_STORAGE_GCS_BUCKET  -- a bucket in the POD'S OWN project (BYOC), reached
#                              keylessly with the pod's identity token
# plus HUSSH_POD_LOG_KEY for the seal. Anything missing fails LOUD at resolve.
BACKEND_COMMIT_LOG = "commit_log"
_LOCAL_ROOT_ENV = "POD_STORAGE_LOCAL_ROOT"
_GCS_BUCKET_ENV = "POD_STORAGE_GCS_BUCKET"
_GCS_PREFIX_ENV = "POD_STORAGE_GCS_PREFIX"


@dataclass(frozen=True)
class EncryptedBlobRef:
    """A pointer to ciphertext — NEVER plaintext.

    ``ref`` locates the encrypted blob (a vault object id, a per-user KMS object
    URI, etc.); ``wrapping_key_id`` identifies the key the data-encryption-key is
    wrapped to (the pod's X25519 key for the pod copy); ``alg`` is the wrapping
    algorithm. No decrypted content ever lives on this struct.
    """

    ref: str
    wrapping_key_id: str
    alg: str
    size_bytes: Optional[int] = None
    updated_at_ms: Optional[int] = None


@dataclass(frozen=True)
class SyncPlan:
    """The planned three-replica topology for one user's PKM (no data, just shape)."""

    hushh_id: str
    cloud_backup: str = ROLE_CLOUD_BACKUP
    pod_cache: str = ROLE_POD_CACHE
    device: str = ROLE_DEVICE
    tunnel: str = TUNNEL_RELAY_TICKET
    zero_knowledge: bool = True
    notes: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "hushhId": self.hushh_id,
            "replicas": [self.cloud_backup, self.pod_cache, self.device],
            "backupOfRecord": self.cloud_backup,
            "tunnel": self.tunnel,
            "zeroKnowledge": self.zero_knowledge,
            "notes": self.notes,
        }


class PodStorage(Protocol):
    """Contract for a pod's storage backend. Inert until a concrete one is wired."""

    backend_id: str

    async def backup(self, hushh_id: str, blob: EncryptedBlobRef) -> dict[str, Any]:
        """Persist/refresh the pod copy's pointer against the cloud backup-of-record."""
        ...

    async def restore(self, hushh_id: str) -> Optional[EncryptedBlobRef]:
        """Return the latest cloud-backup pointer for the pod to hydrate its cache."""

    def render_sync_plan(self, hushh_id: str, *, pod_key_id: str) -> SyncPlan:
        """The planned three-replica topology for this user (design/plan mode)."""


class NullPodStorage:
    """Inert default: renders the plan, performs no storage I/O, carries no data.

    Keeps zero-knowledge trivially true (there is nothing to leak) and lets the
    provisioning path reference a storage backend before a real one exists.
    """

    backend_id = BACKEND_NULL

    async def backup(self, hushh_id: str, blob: EncryptedBlobRef) -> dict[str, Any]:
        return {"status": "planned", "backend": self.backend_id, "hushhId": hushh_id}

    async def restore(self, hushh_id: str) -> Optional[EncryptedBlobRef]:
        return None

    def render_sync_plan(self, hushh_id: str, *, pod_key_id: str) -> SyncPlan:
        return SyncPlan(
            hushh_id=hushh_id,
            notes={
                "cloudBackup": "the user's own encrypted cloud backup-of-record (canonical, durable).",
                "podCache": f"per-pod-key-encrypted working copy (wrap key {pod_key_id}).",
                "device": "on-device BYOK copy; native sync over the private tunnel.",
                "tunnel": "single-use signed relay ticket (replay-checked).",
                "plaintextLocations": "pod isolated process + device only.",
            },
        )


class CommitLogPodStorage:
    """The real backend: pointers recorded in the pod's sealed commit log.

    ``backup``/``restore`` move only :class:`EncryptedBlobRef` pointers -- the
    contract's legibility promise holds: no plaintext field crosses this seam.
    The log itself is the durable system of record; the SQLite working store is
    an index rebuilt from it (``pod_pkm_store.rebuild``).
    """

    backend_id = BACKEND_COMMIT_LOG

    def __init__(self, log: Any) -> None:
        self._log = log

    async def backup(self, hushh_id: str, blob: EncryptedBlobRef) -> dict[str, Any]:
        record = await self._log.append(
            "storage_pointer",
            {
                "hushh_id": hushh_id,
                "ref": blob.ref,
                "wrapping_key_id": blob.wrapping_key_id,
                "alg": blob.alg,
                "size_bytes": blob.size_bytes,
                "updated_at_ms": blob.updated_at_ms,
            },
        )
        return {
            "status": "recorded",
            "backend": self.backend_id,
            "hushhId": hushh_id,
            "seq": record["seq"],
        }

    async def restore(self, hushh_id: str) -> Optional[EncryptedBlobRef]:
        latest: Optional[dict[str, Any]] = None
        for record in await self._log.replay():
            if record["kind"] == "storage_pointer" and record["payload"].get("hushh_id") == (
                hushh_id
            ):
                latest = record["payload"]
        if latest is None:
            return None
        return EncryptedBlobRef(
            ref=str(latest["ref"]),
            wrapping_key_id=str(latest["wrapping_key_id"]),
            alg=str(latest["alg"]),
            size_bytes=latest.get("size_bytes"),
            updated_at_ms=latest.get("updated_at_ms"),
        )

    def render_sync_plan(self, hushh_id: str, *, pod_key_id: str) -> SyncPlan:
        return SyncPlan(
            hushh_id=hushh_id,
            notes={
                "systemOfRecord": "sealed, hash-chained commit log in the pod's own bucket",
                "podCache": f"SQLite index rebuilt from the log (wrap key {pod_key_id}).",
                "device": "on-device BYOK copy; native sync over the private tunnel.",
                "tunnel": "single-use signed relay ticket (replay-checked).",
                "plaintextLocations": "pod isolated process + device only.",
            },
        )


def resolve_pod_storage() -> PodStorage:
    """Resolve the configured pod-storage backend. Default is the inert Null one.

    ``commit_log`` builds the real thing from environment; every missing piece
    fails LOUD, because where a user's holdings persist is never answered by a
    silent default. Unknown values fail loud for the same reason.
    """
    selected = (os.getenv(_BACKEND_ENV) or "").strip().lower()
    if selected in ("", BACKEND_NULL):
        return NullPodStorage()
    if selected == BACKEND_COMMIT_LOG:
        from hushh_mcp.services.pod_commit_log import (
            GcsObjectStore,
            LocalObjectStore,
            PodCommitLog,
            log_key_from_env,
        )

        local_root = (os.getenv(_LOCAL_ROOT_ENV) or "").strip()
        bucket = (os.getenv(_GCS_BUCKET_ENV) or "").strip()
        if bool(local_root) == bool(bucket):
            raise RuntimeError(
                f"pod storage 'commit_log' needs exactly one of {_LOCAL_ROOT_ENV} or "
                f"{_GCS_BUCKET_ENV}"
            )
        store: Any = (
            LocalObjectStore(local_root)
            if local_root
            else GcsObjectStore(bucket, (os.getenv(_GCS_PREFIX_ENV) or "").strip())
        )
        return CommitLogPodStorage(PodCommitLog(store, log_key_from_env()))
    raise NotImplementedError(f"pod storage backend {selected!r} is not wired yet")

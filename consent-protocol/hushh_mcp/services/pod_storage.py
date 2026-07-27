"""Pod storage & sync seam — PKM cloud-backup ⇄ pod cache ⇄ device (private tunnel).

**Design seam. Inert by default. No I/O, moves no data until a real backend is
wired and the feature is enabled.**

The intent (founder directive): the per-user pod is not only *shared compute* for
the user's agents — it is also a *storage node* for their PKM. Today the canonical
PKM lives encrypted in Hushh's **zero-knowledge vault**; that stays the durable
**cloud backup-of-record**. The pod additionally holds a **per-pod-key-encrypted
working copy** so the user's agents read/write locally at compute speed, and the
**device** keeps its own BYOK copy. The three replicas stay consistent by syncing
**encrypted deltas** over a **private, single-use tunnel** (the relay ticket), so
plaintext exists only inside the pod's isolated process and on the device — Hushh
and the transit see ciphertext only. **Zero-knowledge is preserved end to end.**

This module defines the *contract* (the three roles, a Protocol, an inert Null
implementation, and a plan descriptor). The concrete pod-side cache + a per-user
encrypted-object backend (e.g. GCS/S3 + per-user KMS) are a later milestone; the
zero-knowledge vault already provides the cloud backup today.

Legibility-by-design: the only data structure that crosses a boundary here is an
``EncryptedBlobRef`` — a *pointer to ciphertext* plus crypto metadata. There is
**no plaintext field anywhere in this contract**, so a reviewer can see that this
seam cannot leak PKM.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Optional, Protocol

# The three storage roles that hold a replica of the user's PKM.
ROLE_CLOUD_BACKUP = "cloud_vault"  # Hushh zero-knowledge vault — durable backup-of-record.
ROLE_POD_CACHE = "pod"  # per-pod-key-encrypted working copy next to the agents.
ROLE_DEVICE = "device"  # on-device BYOK copy (mobile / Puppy One).

# The private transport between device and pod. Single-use, signed, replay-checked
# (the existing One ADK relay ticket) — never a public, reusable URL.
TUNNEL_RELAY_TICKET = "relay_ticket"

# Backend selector env (mirrors PERSONAL_AGENT_BACKEND for compute).
_BACKEND_ENV = "POD_STORAGE_BACKEND"
BACKEND_NULL = "null"


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
                "cloudBackup": "Hushh zero-knowledge vault (canonical, durable).",
                "podCache": f"per-pod-key-encrypted working copy (wrap key {pod_key_id}).",
                "device": "on-device BYOK copy; native sync over the private tunnel.",
                "tunnel": "single-use signed relay ticket (replay-checked).",
                "plaintextLocations": "pod isolated process + device only.",
            },
        )


def resolve_pod_storage() -> PodStorage:
    """Resolve the configured pod-storage backend. Default is the inert Null one.

    Future backends (e.g. per-user-encrypted GCS/S3 + per-user KMS) register here,
    mirroring ``resolve_compute_backend``; unknown values fail loud rather than
    silently defaulting to a data-moving backend.
    """
    selected = (os.getenv(_BACKEND_ENV) or "").strip().lower()
    if selected in ("", BACKEND_NULL):
        return NullPodStorage()
    raise NotImplementedError(f"pod storage backend {selected!r} is not wired yet")

"""DB-backed registry for per-user personal agents.

Thin async CRUD over ``personal_agent_registry`` and its retained
``personal_agent_deletion_tombstones`` (migration 900), mirroring the Supabase
access pattern used by ``ConsentDBService``. The client is injectable so the
whole repo is hermetically testable with a fake; in production it resolves the
shared ``db.db_client.get_db()`` client lazily.

This is the concrete adapter behind the registry Protocol that
``PersonalAgentProvisioningService`` orchestrates. It stores only the opaque
HusshID, the HMAC phone hash, the pod's PUBLIC key, version pins, and status,
never the raw phone number and never a private key.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from db.db_client import get_db

_REGISTRY = "personal_agent_registry"
_TOMBSTONES = "personal_agent_deletion_tombstones"

# Statuses that mean this row is holding, or is in the act of standing up, a real
# host. ``provisioning`` is counted deliberately: provision() records that status
# before the backend call and leaves it there while the host is created, so a row
# mid-flight may already own a billable service. ``connecting`` is counted for the
# stronger reason that the host demonstrably EXISTS by then -- the backend returned
# a handle and the row is waiting only on the pod to register its public key. A
# pod parked in ``connecting`` is fully billable, so omitting it here would let the
# fleet grow past PERSONAL_AGENT_MAX_PODS without the cap ever noticing.
# Over-counting is the safe direction for a cost ceiling; under-counting spends money.
_ACTIVE_POD_STATUSES = ("provisioning", "connecting", "provisioned")


class PersonalAgentRegistryRepo:
    """CRUD over the personal-agent registry and deletion tombstones."""

    def __init__(self, client: Any = None) -> None:
        self._client = client

    def _db(self) -> Any:
        return self._client if self._client is not None else get_db()

    async def upsert(
        self,
        *,
        user_id: str,
        hushh_id: str,
        phone_e164_hash: str,
        status: str,
        pod_pubkey: Optional[str] = None,
        pod_key_id: Optional[str] = None,
        pod_key_wrapping_alg: Optional[str] = None,
        external_agent_id: Optional[str] = None,
        a2a_route: Optional[str] = None,
        backend: Optional[str] = None,
        space_id: Optional[str] = None,
        backend_metadata: Optional[dict] = None,
        attestation_ref: Optional[str] = None,
    ) -> None:
        # None fields are dropped so a PENDING/logical row (phone-verify seam, or the
        # NullBackend) leaves them at the schema NULL default; a full provision with a
        # real backend handle fills in the host fields.
        data = {
            "user_id": user_id,
            "hushh_id": hushh_id,
            "phone_e164_hash": phone_e164_hash,
            "pod_pubkey": pod_pubkey,
            "pod_key_id": pod_key_id,
            "pod_key_wrapping_alg": pod_key_wrapping_alg,
            "external_agent_id": external_agent_id,
            "a2a_route": a2a_route,
            "backend": backend,
            "space_id": space_id,
            "backend_metadata": backend_metadata,
            "attestation_ref": attestation_ref,
            "status": status,
        }
        data = {k: v for k, v in data.items() if v is not None}

        # Stamp the transition time ourselves. The column defaults to now() but a
        # DEFAULT only fires on INSERT and there is no ON UPDATE trigger (migration
        # 900), so on every subsequent upsert `updated_at` would keep reporting the
        # moment the row was first created. Nothing could then say how long a pod
        # has been booting -- and "how long has this been going" is precisely what
        # the onboarding progress surface has to answer honestly. `health.py`
        # currently works around the gap with an age heuristic.
        now = datetime.now(timezone.utc).isoformat()
        data["updated_at"] = now
        # Set once, when the agent actually becomes usable. Left alone on every
        # other transition so a re-provision cannot rewrite the original activation
        # time, and never cleared, so it stays a durable record of first activation.
        if status == "provisioned":
            data["provisioned_at"] = now

        self._db().table(_REGISTRY).upsert(data, on_conflict="user_id").execute()

    async def get(self, user_id: str) -> Optional[dict]:
        response = self._db().table(_REGISTRY).select("*").eq("user_id", user_id).limit(1).execute()
        rows = response.data or []
        return rows[0] if rows else None

    async def get_by_hushh_id(self, hushh_id: str) -> Optional[dict]:
        """Reverse lookup for callers that know the HusshID but not the user.

        Used by the pod key-registration route: a pod knows its own HusshID (it is
        the agent's identity) and nothing else about its owner. ``hushh_id`` is
        UNIQUE in migration 900, so this is a single row by construction.
        """
        normalized = str(hushh_id or "").strip()
        if not normalized:
            return None
        response = (
            self._db().table(_REGISTRY).select("*").eq("hushh_id", normalized).limit(1).execute()
        )
        rows = response.data or []
        return rows[0] if rows else None

    async def count_active_pods(self, *, exclude_user_id: Optional[str] = None) -> int:
        """How many rows currently hold (or are standing up) a pod. The cap's denominator.

        Read by ``PersonalAgentProvisioningService`` before it asks a backend to
        create a host, so the fleet cannot grow past ``PERSONAL_AGENT_MAX_PODS``.
        ``exclude_user_id`` leaves the caller's own row out, so a user who already
        has a pod is never blocked from re-provisioning by their own row.

        Uses the client's exact-count path (a ``COUNT(*)`` with ``LIMIT 0``, no row
        fetch). If a client cannot produce a count it falls back to the returned row
        length -- which may under-count, and under-counting only ever lets a
        provision through, never blocks one incorrectly.
        """
        query = (
            self._db()
            .table(_REGISTRY)
            .select("user_id", count="exact")
            .in_("status", list(_ACTIVE_POD_STATUSES))
        )
        if (exclude_user_id or "").strip():
            query = query.neq("user_id", exclude_user_id)
        response = query.limit(0).execute()
        count = getattr(response, "count", None)
        return int(count) if count is not None else len(response.data or [])

    async def tombstone(
        self, *, hushh_id: Optional[str], external_agent_id: Optional[str], status: str
    ) -> None:
        # Nothing to tombstone without an identity: deprovision reads the row
        # first, so an empty hushh_id means the row was already gone. Skipping
        # avoids empty-hushh_id audit noise on a missing-row / retried teardown.
        if not (hushh_id or "").strip():
            return
        data = {
            "hushh_id": hushh_id,
            "external_agent_id": external_agent_id,
            "status": status,
        }
        data = {k: v for k, v in data.items() if v is not None}
        self._db().table(_TOMBSTONES).insert(data).execute()

    async def delete(self, user_id: str) -> None:
        self._db().table(_REGISTRY).delete().eq("user_id", user_id).execute()

    async def tombstone_exists(self, hushh_id: str) -> bool:
        """Whether a deletion tombstone already exists for ``hushh_id``.

        Used by provisioning to skip a HusshID that belonged to a prior owner of a
        since-recycled phone (SECURITY-REVIEW.md L1).
        """
        if not (hushh_id or "").strip():
            return False
        response = (
            self._db().table(_TOMBSTONES).select("id").eq("hushh_id", hushh_id).limit(1).execute()
        )
        return bool(response.data)

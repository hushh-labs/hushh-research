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
# States a row should have LEFT. `provisioning` is the fire-and-forget task that
# died mid-flight; `provisioning_failed` recorded its own defeat. `connecting` is
# excluded on purpose -- see fetch_stalled_agents.
#
# This said `"failed"`, and NOTHING has ever written that string. The service writes
# `"provisioning_failed"` (personal_agent_provisioning_service, two sites). So the
# retry sweep has never once retried a failed pod, and could not have: it queried for
# a status that does not exist in the table.
#
# Nothing reported it because a sweep that finds nothing and a sweep looking for the
# wrong string produce identical logs -- `personal_agent_reconcile.pass stalled=0`
# either way. The only way to see it was to compare this tuple against the writers,
# which is exactly what the guard beside it now does on every run.
_STALLED_POD_STATUSES = ("provisioning", "provisioning_failed")


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
        liveness_mode: Optional[str] = None,
        deployment_target: Optional[str] = None,
        model_credential_mode: Optional[str] = None,
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
            # Pinned from the handle at creation. None (any backend that does not
            # report one) leaves the schema default rather than guessing a tier.
            "liveness_mode": liveness_mode,
            # The per-person deployment axes (migration 906). Recorded on the row that
            # the provision actually used, so what happened and what was asked for can
            # be compared later. None leaves the column NULL, which honestly means "the
            # deployment default" -- which is what every pre-906 row is.
            "deployment_target": deployment_target,
            "model_credential_mode": model_credential_mode,
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

        # Narrative, AFTER authority. This is the one funnel every status writer
        # already passes through (the two _record closures and both direct upserts),
        # which is why the appender lives here and not at any call site -- a call
        # site emitter misses the row-creating INSERT and the key-rotation write.
        #
        # After, not atomically-with: db_client exposes no caller-facing transaction,
        # and the ordering is the safety property anyway. A lost narrative row costs
        # a missing frame that the stream's snapshot repairs from this row within one
        # segment; a narrative row describing a write that failed would be a story
        # about something that never happened. Fail-safe by contract: `append` cannot
        # raise into a provisioning path.
        from hushh_mcp.services.pod_lifecycle_log import (  # noqa: PLC0415
            STAGE_BY_REGISTRY_STATUS,
            append,
        )

        stage = STAGE_BY_REGISTRY_STATUS.get(status)
        if stage:
            await append(
                user_id,
                stage=stage,
                registry_status=status,
                hushh_id=hushh_id,
            )

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

    # -- liveness (migration 905) ---------------------------------------------

    async def record_heartbeat(self, *, hushh_id: str) -> Optional[dict]:
        """A pod said it is alive. Returns the matched row, or None.

        Keyed by ``hushh_id`` because that is the only identity a pod knows about
        itself -- it holds no user id, by design, so the heartbeat cannot be written
        by user. ``hushh_id`` is UNIQUE (migration 900), so this touches one row.

        The empty return is load-bearing rather than decorative: a heartbeat for a
        HusshID with no row means a pod is running that the registry does not know
        about -- an orphan, which is a real and billable condition. Swallowing that
        as success would hide it, so the caller gets the fact and logs it.

        The ROW rather than a bool because the update already returns it. A pod's
        first beat is what tells the hub the pod is up and warm, which is the moment
        to finish provisioning -- and deciding that needs the row's status. Fetching
        it separately would be a second query on every beat of every pod in the
        fleet, forever, to serve a case that arises once per pod's lifetime.

        Writes ``health_state='healthy'`` alongside the timestamp. A pod that
        successfully authenticated to the hub and reported in IS healthy by the only
        definition available here, and leaving the verdict stale while the
        observation advances is how the two columns would drift apart.

        Deliberately does NOT touch ``updated_at``. That column tracks lifecycle
        transitions and is what the onboarding surface reads to answer "how long has
        this been provisioning"; a heartbeat every 60s would reset it continuously
        and destroy that meaning.
        """
        normalized = str(hushh_id or "").strip()
        if not normalized:
            return None
        now = datetime.now(timezone.utc).isoformat()
        response = (
            self._db()
            .table(_REGISTRY)
            .update(
                {
                    "last_heartbeat_at": now,
                    "health_state": "healthy",
                    # Any successful heartbeat clears the failure streak. A pod that
                    # is answering again is not "still failing, but less" -- the
                    # streak counts CONSECUTIVE failures and must restart at zero, or
                    # a pod that flaps would eventually cross the heal threshold on
                    # accumulated non-consecutive blips.
                    "liveness_failures": 0,
                }
            )
            .eq("hushh_id", normalized)
            .execute()
        )
        rows = list(response.data or [])
        return rows[0] if rows else None

    async def set_health_state(
        self,
        *,
        user_id: str,
        health_state: str,
        liveness_failures: Optional[int] = None,
        probed: bool = False,
        healed: bool = False,
    ) -> None:
        """Record the hub's VERDICT about a pod (and, optionally, that it probed/healed).

        Separate from :meth:`record_heartbeat` because the two have different
        authors: a heartbeat is the pod's own claim, this is the hub's judgment about
        it. Keeping the writers separate is what stops a judgment from ever
        masquerading as an observation -- ``last_heartbeat_at`` is never written
        here, so no amount of hub-side reasoning can fabricate evidence that a pod
        spoke.
        """
        data: dict[str, Any] = {"health_state": health_state}
        if liveness_failures is not None:
            data["liveness_failures"] = int(liveness_failures)
        now = datetime.now(timezone.utc).isoformat()
        if probed:
            data["last_probe_at"] = now
        if healed:
            data["last_healed_at"] = now
        self._db().table(_REGISTRY).update(data).eq("user_id", user_id).execute()

    async def set_liveness_mode(self, *, user_id: str, liveness_mode: str) -> None:
        """Pin the rule by which this pod's silence is to be read.

        Called at provision time with the mode the pod was ACTUALLY created with, so
        a later change to ``HUSSH_POD_MIN_INSTANCES`` cannot retroactively re-judge a
        fleet that was built under the old setting. See migration 905 for why this
        is per-row rather than read from the environment.
        """
        normalized = str(liveness_mode or "").strip()
        if normalized not in ("warm", "economy"):
            return
        self._db().table(_REGISTRY).update({"liveness_mode": normalized}).eq(
            "user_id", user_id
        ).execute()

    # -- the person's own cloud (migration 906) --------------------------------

    async def set_user_cloud(
        self,
        *,
        user_id: str,
        project: str,
        deployment_target: str,
        model_credential_mode: str,
        region: Optional[str] = None,
        bootstrap_sa: Optional[str] = None,
        authorized: bool = False,
    ) -> bool:
        """Record WHERE this person's pod belongs. Returns False if they have no row.

        `deployment_target` and `model_credential_mode` are REQUIRED and are never
        defaulted here. The registry is the common layer: it orchestrates a fleet it must
        not be able to name, and a default like "the target is user_gcp" would be this
        file deciding a provider policy on the caller's behalf. Defaulting them was
        caught by `test_deployment_boundary_holds` on the first run, which is the guard
        doing precisely its job. The route that knows a person chose their own cloud is
        the layer allowed to say so.

        An UPDATE rather than an upsert, deliberately. This is called while someone is
        onboarding, long before a pod exists, and it must never be the thing that brings
        a registry row into being -- a row created here would carry no HusshID and no
        phone hash, and every reader downstream assumes both. `register_pending` owns
        row creation; this only ever adds coordinates to a row that already exists.

        `authorized` is the whole point of the separation. It is set only when hushh has
        just PROVEN it can act in the project by minting a token and reading the bindings
        back -- never because a form said so. A project recorded without it is a person
        who named a cloud and has not yet run the grant, and provisioning must refuse
        that rather than fall back to hushh's own cloud (which would silently put their
        agent, and their bill, somewhere they did not choose).

        Not cleared on a failed re-check OF THE SAME PROJECT: losing a previously proven
        authorization on one transient API error would strand a working pod. Re-proving
        updates the timestamp; only an explicit revocation path should ever clear it.

        Cleared on a PROJECT SWITCH, structurally: a proof is a statement about one
        project, and carrying it onto a different, never-proven project would let
        provisioning proceed where hushh holds no grant -- exactly the fallback this
        column exists to refuse (audit finding, 2026-08-21). Switching and proving in
        the same call (the one-click chain) keeps its fresh proof.
        """
        normalized_project = str(project or "").strip()
        if not normalized_project:
            raise ValueError("a user cloud needs a project id -- it is never inferred")

        data: dict[str, Any] = {
            "user_cloud_project": normalized_project,
            "deployment_target": deployment_target,
            "model_credential_mode": model_credential_mode,
        }
        if region:
            data["user_cloud_region"] = str(region).strip()
        if bootstrap_sa:
            data["user_cloud_bootstrap_sa"] = str(bootstrap_sa).strip()
        if authorized:
            data["user_cloud_authorized_at"] = datetime.now(timezone.utc).isoformat()
        else:
            current = (
                self._db()
                .table(_REGISTRY)
                .select("user_cloud_project")
                .eq("user_id", user_id)
                .limit(1)
                .execute()
            )
            rows = current.data or []
            previous_project = str((rows[0] if rows else {}).get("user_cloud_project") or "")
            if previous_project and previous_project != normalized_project:
                data["user_cloud_authorized_at"] = None
        data["updated_at"] = datetime.now(timezone.utc).isoformat()

        response = self._db().table(_REGISTRY).update(data).eq("user_id", user_id).execute()
        return bool(response.data or [])

    async def fetch_liveness_candidates(self, *, limit: int = 200) -> list[dict]:
        """Rows that own (or are standing up) a host, for the liveness sweep to judge.

        Returns the candidates and nothing more -- no cutoff arithmetic, no staleness
        verdict. Which of these is actually stale depends on the per-row
        ``liveness_mode`` and on separate warm/economy thresholds, and that policy
        belongs to the evaluator, not to a query. Pushing a single cutoff into SQL
        here is exactly the shortcut that would apply the warm rule to the economy
        tier and start waking sleeping pods.
        """
        response = (
            self._db()
            .table(_REGISTRY)
            .select("*")
            .in_("status", list(_ACTIVE_POD_STATUSES))
            .limit(limit)
            .execute()
        )
        return list(response.data or [])

    async def fetch_stalled_agents(
        self,
        *,
        stalled_before: str,
        limit: int = 100,
        statuses: tuple[str, ...] = _STALLED_POD_STATUSES,
    ) -> list[dict]:
        """Rows whose provisioning never finished, for the reconcile sweep to retry.

        WHY *INACTIVITY* IS THE SIGNAL, NOT ROW AGE
        -------------------------------------------
        This docstring used to argue for ``created_at`` on the premise that
        ``updated_at`` "has no ``ON UPDATE`` trigger and this repo never writes it, so
        it equals ``created_at``". That premise is false and was false when it was
        written: :meth:`upsert` stamps ``updated_at`` on every call (see the comment
        there, which exists precisely so the onboarding surface can answer "how long
        has this been going"). The claim and its refutation sat 200 lines apart in one
        file, which is why nobody noticed.

        With the true premise, ``created_at`` is measurably worse. It measures the
        row's AGE, so a pod that transitioned thirty seconds ago is retried anyway
        once the row itself is old enough -- a spurious retry against a provision
        that is making progress, which is the one thing a retry sweep must not do.
        ``updated_at`` measures what the sweep actually means: nothing has happened
        since.

        The obvious worry does not apply. :meth:`record_heartbeat` deliberately does
        NOT touch ``updated_at`` (its docstring says why), so a pod that is stuck mid
        provision cannot hold itself out of this query by beating. Only a real
        lifecycle transition refreshes the clock, and a real transition is exactly
        the thing that should.

        ``connecting`` is deliberately NOT included. That row has a live host and is
        mid-handshake waiting for the pod's key; re-running provision against it
        would replace a running service. Its stall is owned by the pod's startup key
        push, not by this sweep.
        """
        response = (
            self._db()
            .table(_REGISTRY)
            .select("user_id", "hushh_id", "status", "created_at")
            .in_("status", list(statuses))
            # Inactivity, not age. See the docstring: `upsert` stamps `updated_at` on
            # every lifecycle transition and `record_heartbeat` deliberately does not,
            # so this is "nothing has happened since" rather than "the row is old".
            .lt("updated_at", stalled_before)
            .limit(limit)
            .execute()
        )
        return list(response.data or [])

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
        self,
        *,
        hushh_id: Optional[str],
        external_agent_id: Optional[str],
        status: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        # Nothing to tombstone without an identity: deprovision reads the row
        # first, so an empty hushh_id means the row was already gone. Skipping
        # avoids empty-hushh_id audit noise on a missing-row / retried teardown.
        if not (hushh_id or "").strip():
            return
        data: dict[str, Any] = {
            "hushh_id": hushh_id,
            "external_agent_id": external_agent_id,
            "status": status,
        }
        # ``metadata`` names WHERE an unreclaimed orphan lives (project/region/target)
        # so a billing host stays reclaimable after the registry row is gone. Written
        # resiliently: if the column has not been applied yet (dev parked lane), the
        # insert degrades to the base row rather than failing the best-effort teardown.
        clean_meta = {k: v for k, v in (metadata or {}).items() if v is not None}
        base = {k: v for k, v in data.items() if v is not None}
        try:
            payload = {**base, "metadata": clean_meta} if clean_meta else base
            self._db().table(_TOMBSTONES).insert(payload).execute()
        except Exception:  # noqa: BLE001 - a missing metadata column must not block teardown
            if clean_meta:
                self._db().table(_TOMBSTONES).insert(base).execute()
            else:
                raise

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

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

import json
from datetime import datetime, timedelta, timezone
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
#: Rows that HOLD (or are standing up) billable compute. This answers the cost
#: question -- "does this person occupy a slot in the fleet" -- and `migrating`
#: belongs here because a migration briefly holds TWO hosts, and under-counting a
#: cost ceiling spends money.
_ACTIVE_POD_STATUSES = ("provisioning", "connecting", "provisioned", "migrating")

#: Rows whose SILENCE the liveness sweep is entitled to judge. Deliberately not
#: the same tuple: one list was answering two different questions, and the answers
#: diverge at exactly one status. A migrating pod is frozen on purpose, so probing
#: it would read a deliberate silence as a fault, wake a pod mid-export, and bill
#: a cold start for the privilege.
_LIVENESS_CANDIDATE_STATUSES = ("provisioning", "connecting", "provisioned")
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

#: How long an image-upgrade lease protects a row before another worker may take
#: it over. Longer than one upgrade (copy + replace + Ready, ~2 minutes live),
#: shorter than two reconcile passes.
_UPGRADE_LEASE_TTL = timedelta(minutes=10)

# Failure code written by mark_provisioning_failed when a 'connecting' row blew its
# handshake deadline, and read back by the reconcile sweep's retry gate: a heal
# re-provisions to the SAME digest the dead pod already runs, so auto-retry would
# converge on the same dead boot and flap the owner's surface connecting<->failed.
REASON_HANDSHAKE_TIMEOUT = "handshake_timeout"


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
        # The owner's chosen handle for their space (product-facing, user-set).
        # Written by the space-name settings path, never at provision. None here
        # is dropped, so provisioning does not clobber a name the owner set.
        space_id: Optional[str] = None,
        # The opaque cost-attribution id (engineering, minted at provision). A
        # different value from space_id on purpose: this one becomes a cloud label.
        billing_space_id: Optional[str] = None,
        backend_metadata: Optional[dict] = None,
        attestation_ref: Optional[str] = None,
        liveness_mode: Optional[str] = None,
        deployment_target: Optional[str] = None,
        model_credential_mode: Optional[str] = None,
        user_cloud_project: Optional[str] = None,
        user_cloud_region: Optional[str] = None,
        user_cloud_bootstrap_sa: Optional[str] = None,
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
            "billing_space_id": billing_space_id,
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
            # Carried on every write for a user-cloud row: the INSERT half of an upsert
            # is checked before the conflict resolves, so a status write that names
            # deployment_target without the project trips
            # personal_agent_registry_user_gcp_needs_project_check (seen live
            # 2026-09-02 while recording provisioning_failed).
            "user_cloud_project": user_cloud_project,
            "user_cloud_region": user_cloud_region,
            "user_cloud_bootstrap_sa": user_cloud_bootstrap_sa,
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

    async def record_heartbeat(
        self, *, hushh_id: str, observed: Optional[dict] = None
    ) -> Optional[dict]:
        """A pod said it is alive. Returns the matched row, or None.

        ``observed`` is the pod's self-report of WHICH build it runs (``imageTag``,
        ``revision``), written under ``backend_metadata.observed`` -- a key of its
        own, separate from ``source_image`` / ``image_digest`` which record what the
        hub DEPLOYED. The two are kept apart on purpose so they can disagree, and
        the disagreement (a pod running older code than its row claims) is visible
        instead of overwritten. Written only when it changed, so a steady pod's
        every-60s beat stays one UPDATE.

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
        row = rows[0] if rows else None
        if row is not None:
            current = (row.get("backend_metadata") or {}).get("observed")
            if not observed and current:
                # A bodyless beat from a row that carries a self-report: the process
                # beating now is one that does not report (an older image), so the
                # old report is no longer what the pod says it is. Seen live
                # 2026-09-03: a draining hub revision moved a pod BACK to an older
                # image, the older pod beat without a body, and the stale report
                # kept the status claiming the newer build was running.
                self._db().execute_raw(
                    """
                    UPDATE personal_agent_registry
                    SET backend_metadata = coalesce(backend_metadata, '{}'::jsonb) - 'observed'
                    WHERE hushh_id = :hushh_id
                    """,
                    {"hushh_id": normalized},
                )
                meta = dict(row.get("backend_metadata") or {})
                meta.pop("observed", None)
                row = {**row, "backend_metadata": meta}
            elif observed and current != observed:
                self._db().execute_raw(
                    """
                    UPDATE personal_agent_registry
                    SET backend_metadata = jsonb_set(
                            coalesce(backend_metadata, '{}'::jsonb),
                            '{observed}',
                            CAST(:observed AS jsonb),
                            true
                        )
                    WHERE hushh_id = :hushh_id
                    """,
                    {"hushh_id": normalized, "observed": json.dumps(observed)},
                )
                row = {
                    **row,
                    "backend_metadata": {
                        **(row.get("backend_metadata") or {}),
                        "observed": observed,
                    },
                }
        return row

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

    async def set_hosted_cloud(
        self,
        *,
        user_id: str,
        deployment_target: str,
        model_credential_mode: Optional[str] = None,
    ) -> bool:
        """Record that this person chose to have hussh host their pod. Returns False
        if they have no row.

        The sibling of ``set_user_cloud`` for the third door. Same two rules, for the
        same two reasons:

        * ``deployment_target`` is REQUIRED and never defaulted here. The registry
          orchestrates a fleet it must not be able to name; the route that knows a
          person chose the hosted tier is the layer allowed to say so
          (``test_deployment_boundary_holds``).
        * An UPDATE, never an upsert. A row created here would carry no HusshID and
          no phone hash, and every reader downstream assumes both.

        The user-cloud coordinates are CLEARED, not left behind. A hosted row that
        still carries a project, region, bootstrap SA or a proven authorization is a
        half-state: ``is_user_owned`` would read False while ``user_cloud_project``
        reads set, and the schema's own ``user_gcp_needs_project`` constraint exists
        because those half-states are illegal. Clearing them also means a later
        migration into that same project re-proves the grant rather than inheriting a
        stale proof about a project this pod never ran in.

        ``model_credential_mode`` stays None unless the caller states it. The two axes
        are orthogonal by design -- where the pod runs and which credential reaches a
        model are separate choices, and the AI step owns the second one.
        """
        normalized = str(user_id or "").strip()
        if not normalized:
            return False

        data: dict[str, Any] = {
            "deployment_target": deployment_target,
            "user_cloud_project": None,
            "user_cloud_region": None,
            "user_cloud_bootstrap_sa": None,
            "user_cloud_authorized_at": None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        if model_credential_mode:
            data["model_credential_mode"] = model_credential_mode

        response = self._db().table(_REGISTRY).update(data).eq("user_id", normalized).execute()
        return bool(response.data or [])

    async def begin_migration(self, user_id: str) -> bool:
        """Freeze this row: its pod is about to have its log exported.

        CONDITIONAL on the row being ``provisioned``, so a pod that is still
        standing up, already failed, or already migrating cannot be frozen out
        from under whatever is happening to it. Zero rows matched returns False,
        which the caller reports as "not ready to move" rather than proceeding.

        The freeze is what makes the export's single-writer assumption true:
        every writer path reads ``migrating`` as a refusal -- the relay declines
        turns and ticks, the retry sweep skips the row, and liveness suspends
        judgement rather than reading a deliberate silence as a fault.

        The status is the ONLY thing that changes. The HusshID, the pod key, the
        host coordinates and the cloud record all stay exactly as they are,
        because every one of them is still true and the rollback is a status
        write back to ``provisioned``.
        """
        normalized = str(user_id or "").strip()
        if not normalized:
            return False
        response = (
            self._db()
            .table(_REGISTRY)
            .update({"status": "migrating", "updated_at": datetime.now(timezone.utc).isoformat()})
            .eq("user_id", normalized)
            .eq("status", "provisioned")
            .execute()
        )
        return bool(response.data or [])

    async def end_migration(self, user_id: str, *, status: str = "provisioned") -> bool:
        """Unfreeze. The rollback for every pre-switch failure.

        CONDITIONAL on the row still being ``migrating``, so a job that died and
        was superseded cannot reach back and unfreeze a row a newer attempt now
        owns.

        Defaults to ``provisioned`` because that is what the row WAS: until the
        switch-over the source pod is untouched, so the honest recovery from any
        failure before it is to put the row back exactly where it started.
        """
        normalized = str(user_id or "").strip()
        if not normalized:
            return False
        response = (
            self._db()
            .table(_REGISTRY)
            .update({"status": status, "updated_at": datetime.now(timezone.utc).isoformat()})
            .eq("user_id", normalized)
            .eq("status", "migrating")
            .execute()
        )
        return bool(response.data or [])

    async def mark_needs_reinit(self, user_id: str) -> bool:
        """The recorded host is CONFIRMED gone (the user deleted the project/service).

        Two writes, together: flip status to ``needs_reinit`` AND clear
        ``user_cloud_authorized_at``. Clearing the authorization is the load-bearing
        half -- it is otherwise sticky forever, so ``is_ready_to_provision`` stays
        True and ``/managed/select`` keeps scheduling a pod into a project that no
        longer exists (the compounding bug the reachability gate exists to end). The
        HusshID and the identity are untouched: reinit re-authorizes a project and
        adopts the same agent; it never re-mints. Only a CONFIRMED-gone verdict may
        call this -- a transient probe blip must not (pod_wake defaults to waking).
        """
        normalized = str(user_id or "").strip()
        if not normalized:
            return False
        data = {
            "status": "needs_reinit",
            "user_cloud_authorized_at": None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        response = self._db().table(_REGISTRY).update(data).eq("user_id", normalized).execute()
        return bool(response.data or [])

    async def mark_provisioning_failed(
        self, *, user_id: str, reason: str, detail: str = ""
    ) -> bool:
        """A 'connecting' row past its handshake deadline is recorded as failed.

        CONDITIONAL on the row still being 'connecting' so a key attach that lands
        between the sweep's read and this write wins the race (0 rows matched ->
        False). Same direct-UPDATE shape as ``mark_needs_reinit``; no new status
        value, so the status vocabulary is untouched. The failure marker rides
        ``backend_metadata`` (merged in Python -- a JSONB update replaces the whole
        column) and is only ever read for provisioning_failed rows, so a later
        resurrection by a slow key attach leaves it inert.
        """
        normalized = str(user_id or "").strip()
        if not normalized:
            return False
        row = await self.get(normalized)
        if not row or str(row.get("status") or "") != "connecting":
            return False
        now = datetime.now(timezone.utc).isoformat()
        metadata = dict(row.get("backend_metadata") or {})
        metadata["failure"] = {
            "code": reason,
            "detail": " ".join(str(detail).split())[:200],
            "at": now,
        }
        response = (
            self._db()
            .table(_REGISTRY)
            .update(
                {
                    "status": "provisioning_failed",
                    "backend_metadata": metadata,
                    "updated_at": now,
                }
            )
            .eq("user_id", normalized)
            .eq("status", "connecting")
            .execute()
        )
        if not (response.data or []):
            return False
        # Same funnel as upsert: the journey trace must record the terminal verdict,
        # and `append` cannot raise into this path by contract.
        from hushh_mcp.services.pod_lifecycle_log import append  # noqa: PLC0415

        await append(
            normalized,
            stage="failed",
            registry_status="provisioning_failed",
            event="terminal",
            hushh_id=str(row.get("hushh_id") or "") or None,
            reason=reason,
        )
        return True

    async def fetch_fleet_inventory(self) -> list[dict]:
        """Complete host-claim snapshot for the report-only fleet reconciler.

        This is deliberately separate from bounded liveness probes: migrating and
        inactive rows can still own compute. The SQL-backed client applies no
        implicit limit, so one SELECT sees one database snapshot without paging
        races. Cloud inventory is a separate observation, not an atomic join.
        """
        response = (
            self._db()
            .table(_REGISTRY)
            .select("hushh_id", "status", "backend", "external_agent_id", "backend_metadata")
            .execute()
        )
        if not isinstance(response.data, list):
            raise ValueError("Fleet registry inventory unavailable")
        return response.data

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
            .in_("status", list(_LIVENESS_CANDIDATE_STATUSES))
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

    async def fetch_upgrade_candidates(self, *, limit: int = 200) -> list[dict]:
        """Every whole pod, with the metadata that says which image it runs.

        Only ``provisioned`` rows: a pod mid-handshake (``connecting``) or mid-retry
        is owned by another sweep, and replacing its revision underneath would race
        it. The caller decides staleness by comparing the row's recorded source image
        with the hub's current one -- a JSON comparison this client cannot express as
        a filter, and the fleet is small enough that the rows are cheaper than the
        abstraction.
        """
        response = (
            self._db()
            .table(_REGISTRY)
            .select(
                "user_id",
                "hushh_id",
                "status",
                "backend",
                "backend_metadata",
                "deployment_target",
            )
            .eq("status", "provisioned")
            .limit(limit)
            .execute()
        )
        return list(response.data or [])

    async def claim_image_upgrade(self, *, user_id: str, target_image: str) -> bool:
        """Take the single-flight lease for moving THIS pod to ``target_image``.

        One conditional UPDATE, so two hub workers cannot both win: the reconcile
        loop runs in every gunicorn worker, and on 2026-09-02 both replaced the
        founder's pod within thirty seconds of each other and each counted the
        other pod's copy failure, so the three-attempt cap was reached in two
        passes. The lease is a timestamp inside ``backend_metadata`` (no new
        column), cleared by the terminal write on either outcome and expired
        after ten minutes if a worker died holding it. True means "yours".
        """
        now = datetime.now(timezone.utc)
        result = self._db().execute_raw(
            """
            UPDATE personal_agent_registry
            SET backend_metadata = jsonb_set(
                    coalesce(backend_metadata, '{}'::jsonb),
                    '{upgradeLease}',
                    to_jsonb(CAST(:lease AS text)),
                    true
                )
            WHERE user_id = :user_id
              AND status = 'provisioned'
              AND (
                    backend_metadata->>'upgradeLease' IS NULL
                    OR CAST(split_part(backend_metadata->>'upgradeLease', '|', 1) AS timestamptz)
                       < CAST(:stale_before AS timestamptz)
                  )
            RETURNING user_id
            """,
            {
                "user_id": user_id,
                "lease": f"{now.isoformat()}|{target_image}",
                "stale_before": (now - _UPGRADE_LEASE_TTL).isoformat(),
            },
        )
        return bool(result.data)

    async def record_image_upgrade(
        self,
        *,
        user_id: str,
        backend_metadata: dict,
        liveness_mode: Optional[str] = None,
    ) -> None:
        """Write what an image upgrade changed, and NOTHING it did not.

        Deliberately not :meth:`upsert`: that path re-stamps ``provisioned_at`` for a
        ``provisioned`` status (the pod was not provisioned again, it was moved) and
        appends the ``authority_live`` funnel stage a second time, which would show
        the person a journey that "completed" once per hub deploy. An upgrade keeps
        the row's status, identity, key columns and cloud coordinates untouched by
        construction, because this method cannot reach them.
        """
        data: dict[str, Any] = {
            "backend_metadata": backend_metadata,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        if liveness_mode:
            data["liveness_mode"] = liveness_mode
        self._db().table(_REGISTRY).update(data).eq("user_id", user_id).execute()

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

    async def latest_tombstone_for_project(
        self, project: str, *, status: Optional[str] = None
    ) -> Optional[dict]:
        """The newest tombstone whose metadata names ``project`` as the person's cloud.

        Account deletion uses this when the registry row is already gone (a pod deleted
        from the UI earlier): the byoc_setup_jobs row still knows the project, and the
        deprovision tombstone written at that time knows the hushh_id and bootstrap
        account, which is everything the substrate teardown needs. Filtering happens in
        Python so the JSON column needs no operator support from the client.
        """
        normalized = str(project or "").strip()
        if not normalized:
            return None
        query = self._db().table(_TOMBSTONES).select("*")
        if status:
            query = query.eq("status", status)
        response = query.execute()
        rows = [dict(r) for r in (response.data or [])]
        matches = [
            r
            for r in rows
            if str((r.get("metadata") or {}).get("user_cloud_project") or "") == normalized
        ]
        if not matches:
            return None

        def _created(r: dict) -> str:
            return str(r.get("created_at") or "")

        matches.sort(key=_created, reverse=True)
        return matches[0]

    async def tombstone_exists(self, hushh_id: str, *, status: Optional[str] = None) -> bool:
        """Whether a deletion tombstone already exists for ``hushh_id``.

        Used by provisioning to skip a HusshID that belonged to a prior owner of a
        since-recycled phone (SECURITY-REVIEW.md L1) -- that caller wants ANY tombstone,
        so ``status`` defaults to None (unfiltered).

        With ``status`` set it scopes to one kind of tombstone. This is required for the
        substrate-orphan marker: deprovision always writes a ``deprovision_requested``
        tombstone for the same hushh_id, so an unscoped check would make the substrate
        tombstone either always skip or never write.
        """
        if not (hushh_id or "").strip():
            return False
        query = self._db().table(_TOMBSTONES).select("id").eq("hushh_id", hushh_id)
        if status:
            query = query.eq("status", status)
        response = query.limit(1).execute()
        return bool(response.data)

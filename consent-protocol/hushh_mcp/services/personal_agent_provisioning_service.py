"""Provision and tear down a user's own personal-information agent.

This is the orchestration that stands a user's agent up on join and removes it
cleanly on leave. It composes the pieces already built, and stays inert behind
the ``PERSONAL_AGENT_ENABLED`` kill-switch:

  provision:
    1. derive the opaque HusshID and the stored phone hash from the verified
       phone (``personal_agent_identity_service``);
    2. validate the pod's own X25519 PUBLIC key (``pod_connector_keypair_service``)
       — Hushh only ever stores the public half, never the private key;
    3. record the mapping (HusshID, phone hash, pod public key) in the registry as
       ``provisioning`` — BEFORE any token exists, so a registry failure can never
       orphan a live standing grant;
    4. stand the host up on the selected compute backend;
    5. mint the standing, Nav-governed pkm.read for the user's own agent
       (``personal_agent_grant_service``);
    6. flip the registry row to ``provisioned`` once the read authority is live.

  Step 2 has TWO timings, and which one applies decides where provision() stops.
  The owner-authorized route supplies a pod public key and the flow runs straight
  through. Automatic provisioning off phone-verify cannot: the pod generates its
  keypair inside its OWN runtime, so the key does not exist until the pod does.
  There, provision() performs steps 1, 3 and 4, stops at ``connecting``, and
  :meth:`attach_pod_public_key` performs 2, 5 and 6 once the hub has collected the
  key from the pod (``pod_key_collector``). Either way the standing read is minted
  only after both a host and a key exist — never for a pod that cannot hold it.

  deprovision (mirrors the account-deletion teardown seam):
    1. revoke the standing pkm.read FIRST (a REVOKED consent event), so the pod's
       read authority is dead immediately rather than at its 24h expiry;
    2. write a retained tombstone so the teardown stays auditable after the
       user's rows are gone;
    3. delete the registry row.
    Revocation needs no stored token copy -- it writes a REVOKED marker for
    (user, pkm.read, personal_agent) and is_token_active keys off the latest
    event. The account-deletion cascade independently fail-closes the token too.

The registry is injected (a small Protocol), so the whole flow is testable with
no DB. The concrete DB-backed registry adapter (``personal_agent_registry_repo``)
and the owner-authorized route (``api/routes/one/personal_agent.py``) are wired
but flag-gated: the route returns 404 and this module does no work until
``PERSONAL_AGENT_ENABLED`` is on.

Provisioning is fire-and-forget off the phone-verify seam, so the only place a
human can watch their agent being stood up is the One activity feed. Each state
transition is mirrored, FAIL-SAFE, into the existing ``feed_events`` projection
(:func:`record_provisioning_feed_event_safe`) -- see that function for the
contract: the registry row stays the authority for provisioning state, and a
feed-write failure can never block or break provisioning.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from hmac import compare_digest
from typing import Any, Optional, Protocol

from hushh_mcp.runtime_settings import personal_agent_enabled, personal_agent_max_pods
from hushh_mcp.services.compute_backend import (
    BackendHandle,
    ComputeBackend,
    NullBackend,
    PodSpec,
)
from hushh_mcp.services.personal_agent_grant_service import (
    PersonalAgentDisabledError,
    PersonalAgentGrantService,
)
from hushh_mcp.services.personal_agent_identity_service import (
    hash_phone_e164,
    mint_hushh_id,
)
from hushh_mcp.services.pod_connector_keypair_service import (
    WRAPPING_ALG,
    parse_pod_public_key,
)
from hushh_mcp.services.pod_lifecycle_log import (
    append as pod_lifecycle_append,
)
from hushh_mcp.services.pod_lifecycle_log import (
    append_sync,
    substrate_progress,
)
from hushh_mcp.services.user_cloud_service import resolve_user_cloud

logger = logging.getLogger(__name__)

# Upper bound on recycled-phone generation probing. A single number would have to
# be tombstoned thousands of times to approach this; the cap only prevents an
# unbounded loop on a pathological/corrupt tombstone table.
_MAX_HUSHH_ID_GENERATIONS = 4096

# ---------------------------------------------------------------------------
# One Feed projection of the provisioning lifecycle
# ---------------------------------------------------------------------------
# One row per state transition, so the user watches their private agent being
# created instead of nothing happening. snake_case event_type, matching the
# existing vocabulary (``consent_requested``, ``location_share_created``).
FEED_EVENT_RESERVED = "personal_agent_reserved"
FEED_EVENT_PROVISIONING = "personal_agent_provisioning"
# The host EXISTS and is booting; we are waiting on the pod to come up and hand us
# its public key. Distinct from ``provisioning`` (which covers "we are asking a
# backend to build one") because the honest answer to "what is happening" differs:
# one is our work, the other is a machine starting. The onboarding surface shows
# them differently, and only this one has a host worth billing.
FEED_EVENT_CONNECTING = "personal_agent_connecting"
FEED_EVENT_READY = "personal_agent_ready"
FEED_EVENT_FAILED = "personal_agent_failed"
# The fleet is at PERSONAL_AGENT_MAX_PODS: nothing was provisioned, nothing
# failed, and the reservation still stands. A distinct line, because "we are at
# capacity, your agent is queued" is a different truth from "setup failed".
FEED_EVENT_CAPPED = "personal_agent_provisioning_capped"
# The host was torn down after HUSSH_POD_IDLE_REAP_HOURS of inactivity. The
# registry row, HusshID and A2A address survive; the agent re-provisions on the
# owner's next activity (see personal_agent_reconcile_worker).
FEED_EVENT_REAPED = "personal_agent_reaped"

_FEED_EVENT_TYPES = frozenset(
    {
        FEED_EVENT_RESERVED,
        FEED_EVENT_PROVISIONING,
        FEED_EVENT_CONNECTING,
        FEED_EVENT_READY,
        FEED_EVENT_FAILED,
        FEED_EVENT_CAPPED,
        FEED_EVENT_REAPED,
    }
)

# ``feed_events.source_domain`` is CHECK-constrained (migration 117) and
# allowlisted in FeedService to six domains. The personal agent's lifecycle
# terminates in the standing, Nav-governed ``pkm.read`` consent grant, so it
# projects under ``consent`` -- no new domain, no migration. The human-facing
# label lives in the webapp renderer, where all feed wording lives.
_FEED_SOURCE_DOMAIN = "consent"
_FEED_ACTOR_LABEL = "Private agent"

# Closed vocabulary of user-safe failure reasons. NEVER put an exception message,
# stack detail, phone number, HusshID, or key material in a feed row: feed_events
# is explicitly a bounded, non-sensitive presentation table and the row is
# rendered straight back to the user.
FEED_REASON_INVALID_DETAILS = "invalid_details"
FEED_REASON_TEMPORARY = "temporary_issue"


class SubstrateNotReadyError(RuntimeError):
    """The tenant's infrastructure is not there, so there is nothing to build a pod on.

    Deliberately NOT a ``ValueError``: nothing the person typed is wrong, so
    ``user_safe_failure_reason`` classifies this as temporary rather than as invalid
    details. For BYOC the usual causes are external and often self-healing -- the
    bootstrap grant was never completed, or it was revoked -- and telling someone their
    details are invalid would send them to fix the one thing that is fine.
    """


class PersonalAgentCloudNotAuthorizedError(RuntimeError):
    """They named their cloud and have not yet let hushh in.

    A distinct type from :class:`SubstrateNotReadyError` because the remedy is a
    different person's action: the substrate case is infrastructure that failed to
    apply, this one is a grant that was never made. Both are temporary rather than
    invalid-details for the same reason -- nothing they typed is wrong.

    The important property is that this REFUSES rather than falls back. Provisioning
    onto hushh's own cloud here would be the worst available outcome: the person
    explicitly chose to own their compute, the product would show them a working agent,
    and neither the bill nor the boundary would match what they agreed to.
    """


def user_safe_failure_reason(exc: BaseException) -> str:
    """Coarse reason code for a failed transition -- never derived from the message."""
    return FEED_REASON_INVALID_DETAILS if isinstance(exc, ValueError) else FEED_REASON_TEMPORARY


async def record_provisioning_feed_event_safe(
    *,
    user_id: str,
    event_type: str,
    reason: str | None = None,
) -> None:
    """Flag-gated, FAIL-SAFE mirror of one provisioning transition into the One feed.

    Same contract as ``append_consent_receipt_safe`` for the consent ledger: does
    nothing unless ``PERSONAL_AGENT_ENABLED`` is on, and a projection failure is
    logged and swallowed so it can NEVER break or block provisioning -- which runs
    fire-and-forget off the phone-verify path, where a raised feed error would be
    an invisible, unretried break. ``feed_events`` is presentation only; the
    registry row remains the authority for provisioning state, so a dropped row
    costs a missing feed line and nothing else.

    ``FeedService.record_event`` is a blocking DB write, so it is offloaded to a
    worker thread (mirroring ``api/routes/kai/run_manager.py``) rather than
    stalling the event loop.
    """
    if not user_id or event_type not in _FEED_EVENT_TYPES or not personal_agent_enabled():
        return
    try:
        # Deferred import: no feed/DB dependency at module import time, and nothing
        # is loaded at all on the flag-off path.
        from hushh_mcp.services.feed_service import FeedService

        metadata: dict[str, Any] = {}
        if reason:
            metadata["reason"] = reason
        await asyncio.to_thread(
            FeedService().record_event,
            user_id=user_id,
            source_domain=_FEED_SOURCE_DOMAIN,
            event_type=event_type,
            actor_label=_FEED_ACTOR_LABEL,
            metadata=metadata,
        )
    except Exception:  # noqa: BLE001 -- fail-safe: the feed projection must never break provisioning
        logger.exception("personal_agent.feed_projection_failed event_type=%s", event_type)


class _Registry(Protocol):
    async def upsert(
        self,
        *,
        user_id: str,
        hushh_id: str,
        phone_e164_hash: str,
        status: str,
        pod_pubkey: Optional[str] = ...,
        pod_key_id: Optional[str] = ...,
        pod_key_wrapping_alg: Optional[str] = ...,
        external_agent_id: Optional[str] = ...,
        a2a_route: Optional[str] = ...,
        backend: Optional[str] = ...,
        space_id: Optional[str] = ...,
        backend_metadata: Optional[dict] = ...,
        attestation_ref: Optional[str] = ...,
    ) -> None: ...

    async def get(self, user_id: str) -> Optional[dict]: ...

    # OPTIONAL. The fleet-cap denominator. Resolved defensively with ``getattr``
    # (see ``_fleet_cap_reached``) because registry adapters written before the
    # cap existed -- including every test fake -- do not implement it.
    async def count_active_pods(self, *, exclude_user_id: Optional[str] = ...) -> int: ...

    async def tombstone(
        self, *, hushh_id: Optional[str], external_agent_id: Optional[str], status: str
    ) -> None: ...

    async def delete(self, user_id: str) -> None: ...

    async def tombstone_exists(self, hushh_id: str) -> bool: ...


class _Grant(Protocol):
    async def issue_standing_pkm_read(
        self, user_id: str, *, ledger: Any = ...
    ) -> dict[str, Any]: ...

    async def revoke_standing_pkm_read(
        self, user_id: str, *, ledger: Any = ...
    ) -> dict[str, Any]: ...


class PersonalAgentProvisioningService:
    """Orchestrates provisioning and teardown of a user's own agent."""

    def __init__(
        self,
        *,
        registry: _Registry,
        grant: Optional[_Grant] = None,
        backend: Optional[ComputeBackend] = None,
        substrate: Optional[Any] = None,
    ) -> None:
        self._registry = registry
        self._grant: _Grant = grant or PersonalAgentGrantService()
        # Per-tenant substrate, resolved per person when not injected. Left as None
        # rather than defaulting to the no-substrate ensurer: a default here would
        # silently disable the BYOC bootstrap for every caller constructed before this
        # parameter existed, which is exactly the kind of quiet inertness this
        # workstream keeps finding.
        self._substrate = substrate
        # Compute host provider (the provider abstraction, ARCHITECTURE.md §5).
        # NullBackend by default, so Phase 0 stays a pure registry stamp with no
        # host call. M4/M7 thread host create through provision(); deprovision()
        # already routes teardown through it (guarded on a populated
        # external_agent_id, which is always NULL until a real backend provisions).
        self._backend: ComputeBackend = backend or NullBackend()

    def _substrate_for(self, spec: PodSpec):
        """The substrate ensurer for THIS person's target.

        Injected when supplied -- a test hands in a fake exactly as it does for the
        backend. Kept beside ``_backend_for`` because the two answer the same
        per-person question of the two different lifecycles: what runs this person's
        pod, and what does that pod need to already exist.
        """
        if self._substrate is not None:
            return self._substrate
        from hushh_mcp.services.byoc_substrate import resolve_substrate_ensurer  # noqa: PLC0415

        return resolve_substrate_ensurer(spec)

    def _backend_for(self, spec: PodSpec) -> ComputeBackend:
        """The backend that should build THIS person's pod.

        The injected backend answers "what does this deployment run?". That was the
        only question askable while both axes were process-wide env, and it is the
        wrong one under BYOC: a person who has connected their own cloud must get a
        pod in THEIR project, from a hub running in hushh's.

        Injection still wins when the spec names no target, which keeps every existing
        caller and every test that passes a fake backend working unchanged -- the
        fake is the deployment default for that test.
        """
        if not spec.deployment_target:
            return self._backend
        # Deferred: importing the resolver at module scope would pull every backend
        # implementation into any module that touches this service.
        from hushh_mcp.services.compute_backend import (  # noqa: PLC0415
            resolve_compute_backend_for_spec,
        )

        return resolve_compute_backend_for_spec(spec)

    async def provision(
        self,
        *,
        user_id: str,
        phone_e164: str,
        pod_public_key_b64: Optional[str] = None,
        pod_key_id: Optional[str] = None,
        pod_key_wrapping_alg: str = WRAPPING_ALG,
        deployment_target: Optional[str] = None,
        model_credential_mode: Optional[str] = None,
        ledger: Any = None,
    ) -> dict[str, Any]:
        """Stand up the user's agent. Owner authorization is the caller's job.

        Idempotent by user (``upsert``). Raises ``PersonalAgentDisabledError``
        when off, and ``ValueError`` on a bad phone or pod key.

        TWO KEY TIMINGS, one flow. ``pod_public_key_b64``/``pod_key_id`` are
        optional, and which case applies decides where this call stops:

        * **Key supplied** (the owner-authorized ``/provision`` route): the caller
          already holds a pod public key, so the host is created and the standing
          read minted in one pass, ending at ``provisioned``.
        * **Key deferred** (auto-provisioning off phone-verify): there is no pod
          public key yet, and there cannot be one. Per
          :mod:`hushh_mcp.services.pod_connector_keypair_service`, the pod
          generates its own X25519 keypair *inside its own runtime* and Hushh only
          ever receives the public half -- which is what keeps Hushh unable to
          decrypt the pod. So the key cannot exist before the pod does. This call
          therefore creates the host and stops at ``connecting``; the pod completes
          the flow by registering its public key, at which point
          :meth:`attach_pod_public_key` mints the grant and flips to
          ``provisioned``.

        The deferred case is the one that reaches ``provisioned`` *later*, not the
        one that skips it. Nothing here mints a standing read without a pod key:
        the read authority is only issued once a real pod exists to hold it.

        Ordering (SECURITY-REVIEW.md M3): derive + validate first (no side effect),
        then record the registry row as ``provisioning``, then mint the standing
        read, then flip the row to ``provisioned``. Recording BEFORE minting means
        a registry failure can never orphan a live standing grant, and a mint that
        never completes leaves the row visibly stuck in ``provisioning`` for a
        reconcile sweep. Re-provision is safe: a new grant supersedes any prior one
        (``is_token_active`` is latest-wins + token_id-matched), so live standing
        tokens cannot accumulate.

        Each transition also projects a fail-safe One-feed row
        (``personal_agent_provisioning`` -> ``personal_agent_ready``, or
        ``personal_agent_failed``); the projection never alters what this raises or
        returns.

        Fleet ceiling (DEV-LIVE-EXECUTION-PLAN.md B3): if the fleet is already at
        ``PERSONAL_AGENT_MAX_PODS`` this returns ``{"status": "pending",
        "capped": True}`` WITHOUT raising, without touching the registry, and
        without calling the backend -- so the row stays as phone-verify left it and
        the user keeps their reservation. Capping does not raise because this runs
        fire-and-forget off phone-verify, where an exception is an invisible,
        unretried break; the user learns of it from the
        ``personal_agent_provisioning_capped`` feed row instead.
        """
        if not personal_agent_enabled():
            raise PersonalAgentDisabledError(
                "provisioning requested while PERSONAL_AGENT_ENABLED is off"
            )
        if not user_id:
            raise ValueError("user_id is required")

        # Bound outside the try so the failure handler can tell "we never got far
        # enough to have a row" from "we have a row and it should be marked failed".
        # Everything before the first _record call -- HusshID minting, key parsing,
        # the cap check -- happens without a registry row existing, and there is
        # nothing to mark failed there.
        record: Optional[Callable[..., Awaitable[None]]] = None

        try:
            # Recycled-phone rotation (SECURITY-REVIEW.md L1): a reassigned phone must
            # not re-derive a prior owner's HusshID. Pick the first generation whose
            # HusshID has no deletion tombstone. A fresh phone lands on generation 0.
            generation = await self._next_free_generation(phone_e164)
            hushh_id = mint_hushh_id(phone_e164, generation)
            phone_hash = hash_phone_e164(phone_e164)
            # Validated only when supplied. A half-supplied pair is a caller bug, not
            # a deferred key, and must not be silently read as one -- that would drop
            # a key the caller believed it had handed over.
            if pod_public_key_b64 or pod_key_id:
                if not (pod_public_key_b64 and pod_key_id):
                    raise ValueError("pod_public_key_b64 and pod_key_id must be supplied together")
                pod_key = parse_pod_public_key(pod_public_key_b64, pod_key_id, pod_key_wrapping_alg)
            else:
                pod_key = None

            # Fleet ceiling, checked AFTER validation (pure, no side effect) and
            # BEFORE the first registry write, so a capped user's row is left
            # exactly as phone-verify left it -- 'pending', not 'provisioning'.
            if await self._fleet_cap_reached(user_id=user_id):
                await record_provisioning_feed_event_safe(
                    user_id=user_id, event_type=FEED_EVENT_CAPPED
                )
                # The one caller that used to DISCARD this outcome is why `capped`
                # was unobservable: the return value below is dropped by the
                # fire-and-forget scheduler. The narrative row is what survives.
                # A reason code, never a state -- "at capacity, place held" is a
                # sentence about a `pending` row, not a new lifecycle value.
                await pod_lifecycle_append(
                    user_id,
                    stage="capped",
                    registry_status="pending",
                    event="terminal",
                    hushh_id=hushh_id,
                    reason="at_capacity",
                )
                logger.warning(
                    "personal_agent.provisioning_capped max_pods=%s", personal_agent_max_pods()
                )
                return {
                    "hushhId": hushh_id,
                    "status": "pending",
                    "capped": True,
                    "backend": None,
                    "externalAgentId": None,
                    "a2aRoute": None,
                    "standingReadExpiresAt": None,
                }

            # Declared before `_record` closes over it. The first `_record` call happens
            # before substrate is ensured (the row must exist before any side effect),
            # and it passes no handle, so it never reads this -- but leaving the name
            # unbound until later would make that ordering a latent NameError rather
            # than a stated invariant.
            substrate_receipt: Optional[dict[str, Any]] = None

            async def _record(status: str, handle: Optional[BackendHandle] = None) -> None:
                fields: dict[str, Any] = dict(
                    user_id=user_id,
                    hushh_id=hushh_id,
                    phone_e164_hash=phone_hash,
                    # None when the key is deferred; the repo drops None fields, so the
                    # pod-key columns stay at their schema NULLs until the pod registers.
                    pod_pubkey=pod_key.public_key_b64 if pod_key else None,
                    pod_key_id=pod_key.key_id if pod_key else None,
                    pod_key_wrapping_alg=pod_key.wrapping_alg if pod_key else None,
                    status=status,
                )
                if handle is not None:
                    # None handle fields are dropped by the repo, so NullBackend (all-None)
                    # leaves the row's host columns at their schema NULLs -- behavior
                    # identical to the pre-threading Phase-0 stamp.
                    # The substrate receipt travels INSIDE backend_metadata rather than
                    # replacing it: the backend's own metadata (liveness mode, tenancy,
                    # ingress) and the record of what was created in the tenant's project
                    # are different facts about the same pod, and the row has one JSONB
                    # column for both. Merged rather than overwritten so neither erases
                    # the other.
                    merged_metadata = dict(handle.backend_metadata or {})
                    if substrate_receipt is not None:
                        merged_metadata["substrateReceipt"] = substrate_receipt
                    fields.update(
                        external_agent_id=handle.external_agent_id,
                        a2a_route=handle.a2a_route,
                        backend=handle.backend,
                        backend_metadata=merged_metadata or None,
                        attestation_ref=handle.attestation_ref,
                        # The backend is the only component that knows the minScale
                        # this pod actually got, so it is the only honest source for
                        # how this pod's silence should later be read.
                        liveness_mode=(handle.backend_metadata or {}).get("livenessMode"),
                    )
                await self._registry.upsert(**fields)

            record = _record

            # Record the mapping BEFORE any host or token side effect: a registry failure
            # can never orphan a live host or a live standing grant (SECURITY-REVIEW.md M3).
            await _record("provisioning")
            await record_provisioning_feed_event_safe(
                user_id=user_id, event_type=FEED_EVENT_PROVISIONING
            )
            # Stand the host up on the selected compute backend. Inert for NullBackend
            # (default) and for the gcp/anypoint adapters in plan mode; a real host only
            # materializes when a backend is enabled live. Done BEFORE the mint so a host
            # failure leaves the row visibly stuck in ``provisioning`` for reconcile,
            # never a live grant with no host.
            # Resolved HERE rather than at each call site, deliberately. All three
            # production callers -- the phone-verify seam, the reconcile retry and the
            # owner-authorized route -- omitted both axes, and two of them are
            # fire-and-forget. A future caller WILL forget the argument again, and the
            # failure that follows is a pod built in hushh's project for someone who
            # authorized their own, with no error anywhere. Making the service
            # responsible removes the class instead of fixing three instances of it.
            #
            # An explicit argument still wins, so a caller who genuinely knows better
            # (tests, an operator re-homing one person) is not overridden.
            # Through the INJECTED registry, not a fresh one. This service takes its
            # registry as a constructor argument precisely so the whole flow is
            # exercisable with no database; resolving the cloud against a
            # separately-constructed repo would bypass that seam, and -- worse -- a
            # registry that is merely unreachable would read as "this person has no
            # cloud" and provision them onto the deployment default.
            cloud = await resolve_user_cloud(user_id, repo=self._registry)
            if deployment_target is None and cloud is not None:
                deployment_target = cloud.deployment_target
                model_credential_mode = model_credential_mode or cloud.model_credential_mode

            # Asked of the cloud, never branched on a provider name here. This file is
            # the common layer and may not name a cloud (test_deployment_boundary_holds);
            # `blocks_provisioning` carries that knowledge where it belongs.
            if cloud is not None and cloud.blocks_provisioning:
                # Refuse rather than fall back. Falling back would build this person's
                # agent on hushh's compute and hushh's bill after they explicitly chose
                # otherwise, and the product would show them a working agent.
                raise PersonalAgentCloudNotAuthorizedError(
                    "this person's own cloud is recorded but not yet authorized; "
                    "they need to run the authorization script in their project "
                    "before their agent can be built there"
                )

            # Narrative emitters, closed over the ids the backends deliberately do not
            # hold. Both run on worker threads (the backend's _run closure and the
            # bootstrap loop), so both call append_sync directly -- synchronous
            # SQLAlchemy is the natural caller there, and append_sync swallows
            # everything, so a narrative failure cannot break a build.
            def _on_stage(stage: str, _uid: str = user_id, _hid: str = hushh_id) -> None:
                append_sync(_uid, stage=stage, registry_status="provisioning", hushh_id=_hid)

            _substrate_step_counter = {"n": 0}

            def _on_substrate_step(
                step: str, ok: bool, _uid: str = user_id, _hid: str = hushh_id
            ) -> None:
                _substrate_step_counter["n"] += 1
                append_sync(
                    _uid,
                    stage="substrate",
                    registry_status="provisioning",
                    event="substrate_step",
                    hushh_id=_hid,
                    substrate_step=step,
                    step_ok=ok,
                    progress_pct=substrate_progress(_substrate_step_counter["n"]),
                )

            spec = PodSpec(
                hushh_id=hushh_id,
                phone_e164_hash=phone_hash,
                on_stage=_on_stage,
                on_substrate_step=_on_substrate_step,
                # Empty when deferred. No backend reads this field -- the pod holds its
                # own key -- so an absent one changes nothing about what gets rendered.
                pod_pubkey=pod_key.public_key_b64 if pod_key else "",
                # Both default to None, which means "this deployment's default" and is
                # exactly what every existing caller already got.
                deployment_target=deployment_target,
                model_credential_mode=model_credential_mode,
                # WHICH cloud, not merely which kind. Without these the target was
                # per-person while the destination stayed a process-wide env var.
                user_cloud_project=(cloud.project if cloud else None),
                user_cloud_region=(cloud.region if cloud else None),
                user_cloud_bootstrap_sa=(cloud.bootstrap_sa if cloud else None),
            )
            # The person's own target wins over the one this service was constructed
            # with. BYOC is the production path, so a pod belonging to someone who has
            # connected their own cloud must be built THERE even though the hub that
            # is building it runs on hushh's. Absent a per-person target this returns
            # the injected backend unchanged, so nothing existing moves.
            # The tenant's infrastructure has to exist before a pod can be built on it:
            # the pod's service account, its CMEK bucket and its wrapped log key all
            # come from the bootstrap, and a pod created without them boots into a
            # project with nowhere to write and no key to write with.
            #
            # Called UNCONDITIONALLY and resolved per person. Targets with no per-tenant
            # substrate get the no-op ensurer, so this costs them nothing and the
            # orchestrator never names a provider to decide -- which is what keeps this
            # file passing tests/test_deployment_boundary_holds.py.
            substrate = self._substrate_for(spec)
            receipt = await substrate.ensure(spec)
            if not receipt.applied and substrate.ensurer_id != "none":
                # Stop rather than provision onto infrastructure that is not there. The
                # row stays in `provisioning` for the reconcile sweep, and the message
                # carries the FIRST failing step -- the applier already marks everything
                # downstream "not attempted", so naming them all would report one cause
                # as several problems.
                first = (receipt.failed_steps or [{}])[0]
                raise SubstrateNotReadyError(
                    f"substrate not ready in {receipt.tenant_ref}: "
                    f"{first.get('step') or receipt.detail or 'unknown step'}"
                )

            backend = self._backend_for(spec)
            handle = await backend.provision(spec)
            # The receipt rides along on the row: identifiers, plan digest and the grant
            # that authorised them -- never attributes, never key material. This is the
            # teardown inventory, and without it nothing records what was created in a
            # customer's project, so nothing can clean it up.
            substrate_receipt = receipt.as_record() if receipt.resource_ids else None
            await _record("provisioning", handle=handle)

            if pod_key is None:
                # The host exists; the pod now has to boot and hand us its public key.
                # Stop here rather than minting: a standing pkm.read with no pod to
                # hold it is read authority granted to nobody, which is the one
                # ordering SECURITY-REVIEW.md M3 exists to prevent.
                await _record("connecting", handle=handle)
                await record_provisioning_feed_event_safe(
                    user_id=user_id, event_type=FEED_EVENT_CONNECTING
                )
                logger.info(
                    "personal_agent.connecting hushh_id=%s service=%s backend=%s",
                    hushh_id or "<none>",
                    handle.external_agent_id or "<none>",
                    handle.backend or "null",
                )
                return {
                    "hushhId": hushh_id,
                    "status": "connecting",
                    "backend": handle.backend,
                    "externalAgentId": handle.external_agent_id,
                    "a2aRoute": handle.a2a_route,
                    "standingReadExpiresAt": None,
                }

            # Mint only after the row + host exist.
            grant = await self._grant.issue_standing_pkm_read(user_id, ledger=ledger)
            # Flip to provisioned now that the read authority is live.
            await _record("provisioned", handle=handle)
        except Exception as exc:
            # Mark the row failed so the state is legible to the user and to the
            # reconcile sweep. Best-effort and swallowed: this is an error path
            # already, and a registry write that fails here must not replace the
            # original exception with a less informative one. When it does fail the
            # row stays in ``provisioning``, which is exactly the pre-existing
            # behaviour -- so this can only ever add information, never remove it.
            if record is not None:
                try:
                    await record("provisioning_failed")
                except Exception:
                    logger.exception("personal_agent.failed_status_write_failed")
            # Surface the stall to the user, then re-raise UNCHANGED: the feed is a
            # projection, never an error handler.
            await record_provisioning_feed_event_safe(
                user_id=user_id,
                event_type=FEED_EVENT_FAILED,
                reason=user_safe_failure_reason(exc),
            )
            raise

        await record_provisioning_feed_event_safe(user_id=user_id, event_type=FEED_EVENT_READY)
        logger.info(
            "personal_agent.provisioned hushh_id=%s service=%s backend=%s",
            hushh_id or "<none>",
            handle.external_agent_id or "<none>",
            handle.backend or "null",
        )
        return {
            "hushhId": hushh_id,
            "status": "provisioned",
            "backend": handle.backend,
            "externalAgentId": handle.external_agent_id,
            "a2aRoute": handle.a2a_route,
            "standingReadExpiresAt": grant.get("expiresAt"),
        }

    async def attach_pod_public_key(
        self,
        *,
        user_id: str,
        pod_public_key_b64: str,
        pod_key_id: str,
        pod_key_wrapping_alg: str = WRAPPING_ALG,
        ledger: Any = None,
        allow_rotation: bool = False,
    ) -> dict[str, Any]:
        """Second half of a deferred-key provision: the pod hands over its public key.

        Called once a pod has booted and generated its own X25519 keypair. Records
        the public half, mints the standing ``pkm.read``, and flips the row to
        ``provisioned`` -- the same terminal steps :meth:`provision` performs when
        the key is supplied up front, in the same order and for the same reason.

        Authorization is the caller's job, and it is the whole security question
        here: this mints read authority, so the route above it must establish that
        the pod presenting the key is the pod belonging to ``user_id``.

        Idempotent in the way that matters. Re-registering the SAME key is a no-op
        that returns the current state -- a pod that restarts and re-registers must
        not mint a second grant.

        A DIFFERENT key depends on who is asking, which is what ``allow_rotation``
        encodes:

        * **Default (False)** -- refused. This is the posture for any path where the
          key arrives as a claim: silently rebinding a user's agent would let
          whatever reached this path take over the agent's identity.
        * **allow_rotation=True** -- accepted as a ROTATION. Reserved for the hub's
          own pull (``pod_key_collector``), where the key was fetched from the URL
          the hub itself recorded at service creation. Under that direction there is
          no asserted identity to distrust: whatever answers that address IS the
          user's pod, so a new key there means the pod restarted and re-generated --
          the expected behaviour of a process-local keypair -- not an impostor. The
          original refuse-rebind rule was designed against the *push* threat model
          and is over-strict under *pull*.

        Rotation never double-mints: a row already ``provisioned`` keeps its
        standing grant (latest-wins supersession is for re-provision, not for a key
        refresh), so rotation only updates the recorded key material. The invariant
        that survives either way: nothing durable may be wrapped to a key that can
        rotate underneath it -- ``pod_storage`` enforces that with a durability
        check, not this method.
        """
        if not personal_agent_enabled():
            raise PersonalAgentDisabledError(
                "pod key registration requested while PERSONAL_AGENT_ENABLED is off"
            )
        if not user_id:
            raise ValueError("user_id is required")

        pod_key = parse_pod_public_key(pod_public_key_b64, pod_key_id, pod_key_wrapping_alg)

        existing = await self._registry.get(user_id)
        if existing is None:
            raise ValueError("no personal-agent row for this user")

        recorded_key = str(existing.get("pod_pubkey") or "").strip()
        if recorded_key:
            if compare_digest(recorded_key, pod_key.public_key_b64):
                return {
                    "hushhId": existing.get("hushh_id"),
                    "status": existing.get("status"),
                }
            if not allow_rotation:
                # Constant-time compared above, and refused: see the docstring.
                raise ValueError("a different pod public key is already registered")
            if str(existing.get("status") or "").strip() == "provisioned":
                # Rotation of a completed row: record the new key, change nothing
                # else. The grant already exists and must not be re-minted.
                hushh_id = str(existing.get("hushh_id") or "").strip()
                phone_hash = str(existing.get("phone_e164_hash") or "").strip()
                if not hushh_id or not phone_hash:
                    raise ValueError("personal-agent row is missing its identity fields")
                await self._registry.upsert(
                    user_id=user_id,
                    hushh_id=hushh_id,
                    phone_e164_hash=phone_hash,
                    pod_pubkey=pod_key.public_key_b64,
                    pod_key_id=pod_key.key_id,
                    pod_key_wrapping_alg=pod_key.wrapping_alg,
                    status="provisioned",
                )
                logger.info("personal_agent.pod_key_rotated hushh_id=%s", hushh_id or "<none>")
                return {"hushhId": hushh_id, "status": "provisioned", "rotated": True}
            # A row still mid-provision rotates by falling through to the full
            # attach path below -- the mint has not happened yet, so this is just
            # the first registration with fresher material.

        hushh_id = str(existing.get("hushh_id") or "").strip()
        phone_hash = str(existing.get("phone_e164_hash") or "").strip()
        if not hushh_id or not phone_hash:
            raise ValueError("personal-agent row is missing its identity fields")

        async def _record(status: str) -> None:
            await self._registry.upsert(
                user_id=user_id,
                hushh_id=hushh_id,
                phone_e164_hash=phone_hash,
                pod_pubkey=pod_key.public_key_b64,
                pod_key_id=pod_key.key_id,
                pod_key_wrapping_alg=pod_key.wrapping_alg,
                status=status,
            )

        try:
            # Key first, then grant, then status -- the M3 ordering. The key is the
            # record of WHO holds the authority, so it must exist before the
            # authority does; a grant minted against an unrecorded key would be
            # held by something the registry cannot name.
            await _record("connecting")
            grant = await self._grant.issue_standing_pkm_read(user_id, ledger=ledger)
            await _record("provisioned")
        except Exception as exc:
            try:
                await _record("provisioning_failed")
            except Exception:
                logger.exception("personal_agent.failed_status_write_failed")
            await record_provisioning_feed_event_safe(
                user_id=user_id,
                event_type=FEED_EVENT_FAILED,
                reason=user_safe_failure_reason(exc),
            )
            raise

        await record_provisioning_feed_event_safe(user_id=user_id, event_type=FEED_EVENT_READY)
        logger.info("personal_agent.pod_key_attached hushh_id=%s", hushh_id or "<none>")
        return {
            "hushhId": hushh_id,
            "status": "provisioned",
            "standingReadExpiresAt": grant.get("expiresAt"),
        }

    async def register_pending(self, *, user_id: str, phone_e164: str) -> dict[str, Any]:
        """Phone-verify seam: assign the sovereign HusshID and record a PENDING row.

        On phone verification the user becomes addressable -- their HusshID is
        minted (with recycled-phone rotation) and a ``pending`` registry row is
        recorded -- but there is no pod key or standing read yet: those arrive when
        the pod materializes and the owner-authorized ``/provision`` completes.

        Idempotent and non-destructive: if a row already exists (pending OR a fully
        provisioned agent), it is returned unchanged -- a re-fired phone-verify
        never downgrades a provisioned agent back to pending. Flag-gated.

        A first reservation projects a fail-safe ``personal_agent_reserved`` feed
        row (an unchanged existing row projects nothing, since nothing changed).
        """
        if not personal_agent_enabled():
            raise PersonalAgentDisabledError(
                "register_pending requested while PERSONAL_AGENT_ENABLED is off"
            )
        if not user_id:
            raise ValueError("user_id is required")

        existing = await self._registry.get(user_id)
        if existing is not None:
            # No state transition -> no feed row: a re-fired phone-verify must not
            # replay "your agent is being set up" into the user's activity feed.
            return {"hushhId": existing.get("hushh_id"), "status": existing.get("status")}

        try:
            generation = await self._next_free_generation(phone_e164)
            hushh_id = mint_hushh_id(phone_e164, generation)
            phone_hash = hash_phone_e164(phone_e164)
            await self._registry.upsert(
                user_id=user_id,
                hushh_id=hushh_id,
                phone_e164_hash=phone_hash,
                status="pending",
            )
        except Exception as exc:
            # This runs fire-and-forget off phone-verify, so the feed row is the only
            # signal the user would ever get. Re-raised unchanged for the caller's log.
            await record_provisioning_feed_event_safe(
                user_id=user_id,
                event_type=FEED_EVENT_FAILED,
                reason=user_safe_failure_reason(exc),
            )
            raise

        await record_provisioning_feed_event_safe(user_id=user_id, event_type=FEED_EVENT_RESERVED)
        logger.info("personal_agent.registered_pending hushh_id=%s", hushh_id or "<none>")
        return {"hushhId": hushh_id, "status": "pending"}

    async def deprovision(
        self,
        *,
        user_id: str,
        ledger: Any = None,
        revoke: bool = True,
        defer_row_delete: bool = False,
    ) -> dict[str, Any]:
        """Tear down the user's agent: revoke the standing read, tombstone, delete.

        Best-effort and idempotent: a missing row still writes a tombstone and a
        (no-op) delete, so teardown stays auditable and safe to retry.

        The standing pkm.read is revoked FIRST so the pod's read authority is dead
        immediately, not at its 24h expiry (SECURITY-REVIEW.md M2). Revocation is
        best-effort: a failure is logged and surfaced in ``standingReadRevoked``
        but never blocks teardown.

        ``revoke=False`` is for the account-deletion path, where the deletion
        cascade has ALREADY wiped this user's consent_audit rows (which
        independently fail-closes the token). Writing a REVOKED event there would
        re-create a consent_audit row for a just-deleted user and break the erasure
        guarantee, so the caller suppresses it.
        """
        if not user_id:
            raise ValueError("user_id is required")

        revoked = False
        if revoke:
            try:
                await self._grant.revoke_standing_pkm_read(user_id, ledger=ledger)
                revoked = True
            except Exception as exc:  # best-effort: teardown must still complete
                logger.warning(
                    "personal_agent.deprovision revoke_failed err=%s", type(exc).__name__
                )

        row = await self._registry.get(user_id)
        hushh_id = (row or {}).get("hushh_id")
        external_agent_id = (row or {}).get("external_agent_id")

        # Route host teardown through the backend that BUILT this pod, read from the
        # row, not from the one this process happens to be configured with.
        #
        # This used to be `self._backend`, and the asymmetry with `provision()` -- which
        # has always routed per person via `_backend_for(spec)` -- was an erasure defect
        # rather than an inconsistency. For someone on their own cloud, teardown ran
        # against hushh's default backend or NullBackend, which answers success without
        # doing anything. The registry row was then deleted, so the only record of WHERE
        # that person's pod lived went with it: a live, billing Cloud Run service left in
        # a customer's own project that nothing in the system could name afterwards.
        #
        # It reaches account deletion (`api/routes/account.py`), which is the one path
        # where "we deleted everything" has to be true.
        teardown_spec = PodSpec(
            hushh_id=str(hushh_id or ""),
            phone_e164_hash="",
            pod_pubkey="",
            deployment_target=(row or {}).get("deployment_target"),
            user_cloud_project=(row or {}).get("user_cloud_project"),
            user_cloud_region=(row or {}).get("user_cloud_region"),
            user_cloud_bootstrap_sa=(row or {}).get("user_cloud_bootstrap_sa"),
        )
        teardown_reached_the_host = False
        if external_agent_id:
            try:
                await self._backend_for(teardown_spec).deprovision(external_agent_id)
                teardown_reached_the_host = True
            except Exception as exc:  # best-effort: teardown must still complete
                logger.warning(
                    "personal_agent.deprovision backend_teardown_failed err=%s target=%s",
                    type(exc).__name__,
                    str((row or {}).get("deployment_target") or "default"),
                )

        # An orphan must stay NAMEABLE after the row is gone. Teardown into a project
        # hushh holds no standing credential in can genuinely fail -- the person may have
        # revoked the grant already, which is their right and not an error -- and once
        # the row is deleted there is otherwise nothing left that knows a billing service
        # exists in their cloud. The tenant reference is retained ONLY when there is a
        # real orphan to name, so a clean teardown still writes the minimal tombstone the
        # erasure guarantee expects.
        unreclaimed = bool(external_agent_id) and not teardown_reached_the_host
        if unreclaimed:
            logger.warning(
                "personal_agent.deprovision_unreclaimed hushh_id=%s target=%s project=%s "
                "service=%s -- resources remain in a project hushh cannot reach",
                hushh_id,
                str((row or {}).get("deployment_target") or "default"),
                str((row or {}).get("user_cloud_project") or ""),
                external_agent_id,
            )

        await self._registry.tombstone(
            hushh_id=hushh_id,
            external_agent_id=external_agent_id,
            status="deprovision_requested",
        )
        # ``defer_row_delete`` (delete-order V2) keeps the recovery-anchor row in
        # place through the data cascade: the host is already torn down and the
        # tombstone written, but the row -- the only thing that still names WHERE
        # the pod was -- survives until the caller finalizes it AFTER the cascade,
        # so a mid-delete failure leaves a recoverable/re-deletable row, never a
        # half-deleted account with an unnameable orphan.
        if not defer_row_delete:
            await self._registry.delete(user_id)
        logger.info(
            "personal_agent.deprovisioned had_row=%s standing_read_revoked=%s row_delete_deferred=%s",
            row is not None,
            revoked,
            defer_row_delete,
        )
        return {
            "status": "deprovisioned",
            "hushhId": hushh_id,
            "standingReadRevoked": revoked,
            "teardownReachedHost": teardown_reached_the_host,
            "unreclaimed": unreclaimed,
            "rowDeleteDeferred": defer_row_delete,
        }

    async def finalize_row_delete(self, *, user_id: str) -> None:
        """Delete the registry row that ``deprovision(defer_row_delete=True)`` left
        in place. Called AFTER the data cascade so the recovery anchor survives a
        mid-delete failure. Idempotent -- a missing row is a safe no-op."""
        if not user_id:
            return
        await self._registry.delete(user_id)

    async def _fleet_cap_reached(self, *, user_id: str) -> bool:
        """Whether the pod fleet already sits at ``PERSONAL_AGENT_MAX_PODS``.

        The cap is a COST guardrail, not a security or consent control, and the two
        are deliberately not treated the same way. A known breach fails CLOSED (no
        host is created). Not being able to *evaluate* the cap fails OPEN, with a
        warning, in exactly two cases:

          * the injected registry has no ``count_active_pods`` -- adapters written
            before the cap existed, and every test fake, do not implement it;
          * the count query raised -- a transient DB hiccup.

        Failing closed on those would let a database blip silently break agent
        setup for everyone, which trades a bounded cost risk for an unbounded
        reliability one. The backstops that do not depend on this query are
        ``HUSSH_POD_MAX_INSTANCES`` (per-pod ceiling) and the project budget alert.
        """
        counter = getattr(self._registry, "count_active_pods", None)
        if counter is None:
            logger.warning(
                "personal_agent.fleet_cap_unenforceable registry=%s",
                type(self._registry).__name__,
            )
            return False
        try:
            live = int(await counter(exclude_user_id=user_id))
        except Exception:  # noqa: BLE001 -- see docstring: an unknown count fails open
            logger.exception("personal_agent.fleet_cap_count_failed")
            return False
        return live >= personal_agent_max_pods()

    async def _next_free_generation(self, phone_e164: str) -> int:
        """First HusshID generation for this phone that has no deletion tombstone.

        A fresh phone returns 0. A recycled phone whose prior generations are
        tombstoned rotates forward to the next untombstoned generation, so a
        reassigned number never re-derives (and thus never resurrects) a prior
        owner's HusshID or A2A address.
        """
        for generation in range(_MAX_HUSHH_ID_GENERATIONS):
            candidate = mint_hushh_id(phone_e164, generation)
            if not await self._registry.tombstone_exists(candidate):
                return generation
        raise ValueError("exhausted HusshID generations for this phone")

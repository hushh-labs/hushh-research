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

  deprovision:
    Refuse retained resources through the existing account-erasure guard until
    pod-held erasure is implemented. An empty-state observation is a no-op.


Provisioning uses an injected registry. Destructive preflight uses the existing
transaction-backed account authority. The concrete DB-backed registry adapter (``personal_agent_registry_repo``)
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
import hashlib
import logging
from collections.abc import Awaitable, Callable
from dataclasses import replace
from datetime import datetime, timezone
from hmac import compare_digest
from typing import Any, Optional, Protocol

from hushh_mcp.runtime_settings import personal_agent_enabled, personal_agent_max_pods
from hushh_mcp.services.compute_backend import (
    BackendHandle,
    ComputeBackend,
    NullBackend,
    PodBootFailedError,
    PodSpec,
)
from hushh_mcp.services.personal_agent_grant_service import (
    PersonalAgentDisabledError,
    PersonalAgentGrantService,
)
from hushh_mcp.services.personal_agent_identity_service import (
    hash_phone_e164,
    mint_billing_space_id,
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
#: An image update reached this person's pod. Emitted only when the revision
#: actually moved (`upgrade_noop` writes nothing): the feed is the software-update
#: notice the founder asked for, and a notice about nothing is noise.
FEED_EVENT_UPDATED = "personal_agent_updated"

_FEED_EVENT_TYPES = frozenset(
    {
        FEED_EVENT_RESERVED,
        FEED_EVENT_PROVISIONING,
        FEED_EVENT_CONNECTING,
        FEED_EVENT_READY,
        FEED_EVENT_FAILED,
        FEED_EVENT_CAPPED,
        FEED_EVENT_REAPED,
        FEED_EVENT_UPDATED,
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
# The platform's own verdict that the pod's revision failed to start -- distinct
# from a slow boot, which stays "temporary". Provider-neutral by construction.
FEED_REASON_POD_BOOT_FAILED = "pod_boot_failed"
# A host that became Ready but whose pod never published its key within the
# handshake deadline; written by the reconcile sweep's overdue transition.
FEED_REASON_POD_UNRESPONSIVE = "pod_unresponsive"


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
    if isinstance(exc, PodBootFailedError):
        return FEED_REASON_POD_BOOT_FAILED
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
    async def claim_provision(self, *, observed: Optional[dict], intent: dict) -> dict: ...

    async def publish_provision(
        self,
        *,
        user_id: str,
        attempt_id: str,
        expected_phase: str,
        next_phase: str,
        evidence: dict,
    ) -> bool: ...

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
        billing_space_id: Optional[str] = ...,
        backend_metadata: Optional[dict] = ...,
        attestation_ref: Optional[str] = ...,
        liveness_mode: Optional[str] = ...,
        deployment_target: Optional[str] = ...,
        model_credential_mode: Optional[str] = ...,
    ) -> None: ...

    async def get(self, user_id: str) -> Optional[dict]: ...

    async def fetch_upgrade_candidates(self, *, limit: int = ...) -> list[dict]: ...

    async def claim_image_upgrade(
        self, *, user_id: str, target_image: str, observed: Optional[dict]
    ) -> Optional[str]: ...

    async def record_image_upgrade(
        self,
        *,
        user_id: str,
        backend_metadata: dict,
        expected_lease: str,
        previous_metadata: dict,
        observed: Optional[dict],
        liveness_mode: Optional[str] = ...,
        retain_lease: bool = ...,
    ) -> bool: ...

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


class PersonalAgentUpgradeUnsupportedError(RuntimeError):
    """The backend that holds this pod has no in-place upgrade. Only a backend that
    replaces a revision under a stable address can promise the person's memory and
    identity survive, so a backend without ``upgrade`` is refused rather than
    rebuilt."""


def running_image(row: Optional[dict[str, Any]]) -> Optional[str]:
    """The hub-side image a pod was built from, as its registry row records it.

    ``source_image`` on a user-owned pod (its own registry holds a digest-pinned
    COPY, so the recorded ``image`` is the copy, not what the hub ships) and
    ``image`` on a hussh-hosted one. Neither means the row has no host, which is
    "nothing to upgrade" rather than "stale".
    """
    meta = (row or {}).get("backend_metadata") or {}
    value = meta.get("source_image") or meta.get("image")
    return str(value).strip() or None if value else None


#: A lease younger than this is another worker mid-upgrade; older, it was left by
#: a worker that died and the row is a candidate again. Mirrors the repo's TTL.
UPGRADE_LEASE_FRESH_FOR_SECONDS = 600


#: After a failed attempt, leave the pod alone this long before trying again. The
#: lease is released the moment a failure is recorded, so without this the OTHER
#: gunicorn worker (which listed the same candidates) retried the same pod fifteen
#: seconds later and the three-attempt cap burned in two passes (seen live 2026-09-03).
UPGRADE_RETRY_COOLDOWN_SECONDS = 600


def _attempted_recently(marker: Any, *, now: Optional[datetime] = None) -> bool:
    raw = str((marker or {}).get("lastAttemptAt") or "").strip() if isinstance(marker, dict) else ""
    if not raw:
        return False
    try:
        at = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return (
        (now or datetime.now(timezone.utc)) - at
    ).total_seconds() < UPGRADE_RETRY_COOLDOWN_SECONDS


def hub_revision() -> str:
    """This process's Cloud Run revision name (``consent-protocol-00061-9p2``), or ''."""
    import os  # noqa: PLC0415

    return (os.getenv("K_REVISION") or "").strip()


def set_by_newer_hub(row: Optional[dict], *, own_revision: Optional[str] = None) -> bool:
    """Did a NEWER hub revision than this one last set the pod's image?

    During a rollout Cloud Run keeps the previous hub revision's instances alive for
    a while, and every instance runs the reconcile sweep against ITS OWN
    ``HUSSH_ONE_POD_IMAGE``. Seen live 2026-09-03: revision 00060 (target
    ``dev-e53e0c6a0``) and 00061 (target ``dev-ec552dd3c``) alternately moved the
    founder's pod forward and back, a ~90s PUT and a restart each time, until the
    old instances drained. The image a pod runs must only ever move forward, so
    the upgrade records which hub revision set it and an older revision refuses to
    touch a row a newer one already wrote. Revision names are zero-padded and
    monotonic within a service, so string order is deploy order.
    """
    own = (own_revision if own_revision is not None else hub_revision()).strip()
    metadata = (row or {}).get("backend_metadata")
    theirs = str((metadata or {}).get("imageSetByRevision") or "").strip()
    if not own or not theirs:
        return False
    if own.rsplit("-", 2)[0] != theirs.rsplit("-", 2)[0]:
        return False  # a different service; no ordering to speak of
    return theirs > own


def _lease_is_fresh(value: Any) -> bool:
    """``upgradeLease`` starts with ``<iso timestamp>|``; only the timestamp
    decides freshness. Anything unparseable is treated as absent, never as a lock."""
    text = str(value or "")
    if not text:
        return False
    from datetime import datetime, timezone  # noqa: PLC0415

    try:
        taken = datetime.fromisoformat(text.split("|", 1)[0])
    except ValueError:
        return False
    if taken.tzinfo is None:
        taken = taken.replace(tzinfo=timezone.utc)
    age = (datetime.now(timezone.utc) - taken).total_seconds()
    return 0 <= age < UPGRADE_LEASE_FRESH_FOR_SECONDS


#: A pod that failed to come up on one target image is retried this many times for
#: THAT image, then left alone until the image moves again. Without the cap a pod
#: whose new revision cannot boot would be replaced every pass forever.
UPGRADE_ATTEMPTS_PER_IMAGE = 3


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

    async def _upgrade_healing_the_substrate_once(
        self, upgrade, spec: PodSpec, *, user_id: str, hushh_id: str
    ):
        """Retry an upgrade once, and ONLY for a failure the person's substrate can fix.

        `provision` ensures the substrate; `upgrade` never did. So a project authorized
        before the `artifact_repo_grant_copy_writer` step existed has no
        roles/artifactregistry.writer for the copy identity, and every upgrade 403s
        starting a blob upload into their own registry, burns UPGRADE_ATTEMPTS_PER_IMAGE,
        and then freezes the pod on an old image with nothing telling the person. That
        was observed live (0ba8c6b49), and the remedy has been an operator re-granting
        it by hand ever since.

        Ensuring the substrate unconditionally before every upgrade would be the obvious
        fix and the wrong one -- it is many API calls into someone else's cloud on a path
        that almost always needs none of them. Healing on the specific refusal costs
        nothing in the common case.

        The exception is asked, never named: `heals_with_substrate` is a property on the
        cloud-specific error, and this file is the common layer that
        test_deployment_boundary_holds refuses to let name a provider. A source-side 403
        is deliberately NOT healable -- that is hushh's own registry, where re-granting
        in the person's project would change nothing and only hide the real cause behind
        a retry.

        One retry, not a loop. If the substrate applied and the copy still refuses, the
        failure is not the one this heals, and the caller records it as it always did.
        """
        try:
            return await upgrade(spec)
        except Exception as refusal:
            if not getattr(refusal, "heals_with_substrate", False):
                raise
            logger.warning(
                "personal_agent.upgrade_healing_substrate hushh_id=%s error=%s",
                hushh_id,
                type(refusal).__name__,
            )
            await self._substrate_for(spec).ensure(spec)
            await pod_lifecycle_append(
                user_id,
                stage="authority_live",
                registry_status="provisioned",
                event="upgrade_healed_substrate",
                hushh_id=hushh_id,
                reason="re-applied the substrate after a destination push refusal",
            )
            return await upgrade(spec)

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
            generation = await self._next_free_generation(phone_e164, user_id=user_id)
            hushh_id = mint_hushh_id(phone_e164, generation)
            phone_hash = hash_phone_e164(phone_e164)
            # The opaque cost-attribution id. Minted ONCE, here, and written to the
            # registry row below, because the row is the join key of record:
            # re-deriving it at read time would make a signing-key rotation silently
            # unmatch every historical pod from the spend it explains. This is NOT the
            # spaceID handle the owner chooses -- that is set through the space-name
            # path, and provisioning deliberately leaves it untouched.
            billing_space_id = mint_billing_space_id(hushh_id)
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

            # Resolve against an observation captured before any external side effect.
            # The transactional claim rejects a changed cloud/host or retained attempt.
            try:
                observed = await self._registry.get(user_id)
            except Exception:
                raise PersonalAgentCloudNotAuthorizedError(
                    "The personal agent registry could not be read"
                ) from None
            cloud = await resolve_user_cloud(user_id, repo=self._registry, registry_row=observed)
            if deployment_target is None and cloud is not None:
                deployment_target = cloud.deployment_target
                model_credential_mode = model_credential_mode or cloud.model_credential_mode
            if cloud is not None and cloud.blocks_provisioning:
                raise PersonalAgentCloudNotAuthorizedError(cloud.refusal_reason)
            intent = {
                "user_id": user_id,
                "hushh_id": hushh_id,
                "phone_e164_hash": phone_hash,
                "billing_space_id": billing_space_id,
                "deployment_target": deployment_target,
                "model_credential_mode": model_credential_mode,
                "user_cloud_project": cloud.project if cloud else None,
                "user_cloud_region": cloud.region if cloud else None,
                "user_cloud_bootstrap_sa": cloud.bootstrap_sa if cloud else None,
                "pod_pubkey": pod_key.public_key_b64 if pod_key else None,
                "pod_key_id": pod_key.key_id if pod_key else None,
                "pod_key_wrapping_alg": pod_key.wrapping_alg if pod_key else None,
            }
            intent = {key: value for key, value in intent.items() if value is not None}
            reservation = await self._registry.claim_provision(observed=observed, intent=intent)
            phase = "reserved"
            substrate_receipt: Optional[dict[str, Any]] = None

            async def _record(
                status: str,
                handle: Optional[BackendHandle] = None,
                *,
                next_phase: Optional[str] = None,
                target: Optional[dict] = None,
            ) -> None:
                nonlocal phase
                target_phase = next_phase or (
                    "failed" if status == "provisioning_failed" else status
                )
                fields: dict[str, Any] = {}
                metadata: dict[str, Any] = {}
                if handle is not None:
                    metadata.update(handle.backend_metadata or {})
                    fields.update(
                        external_agent_id=handle.external_agent_id,
                        a2a_route=handle.a2a_route,
                        backend=handle.backend,
                        attestation_ref=handle.attestation_ref,
                        liveness_mode=metadata.get("livenessMode"),
                    )
                if substrate_receipt is not None:
                    metadata["substrateReceipt"] = substrate_receipt
                if metadata:
                    fields["backend_metadata"] = metadata
                fields = {key: value for key, value in fields.items() if value is not None}
                published = await self._registry.publish_provision(
                    user_id=user_id,
                    attempt_id=reservation["attemptId"],
                    expected_phase=phase,
                    next_phase=target_phase,
                    evidence={"registry": fields, **({"target": target} if target else {})},
                )
                if not published:
                    raise RuntimeError(
                        "personal agent provision publication requires reconciliation"
                    )
                phase = target_phase

            record = _record
            await record_provisioning_feed_event_safe(
                user_id=user_id, event_type=FEED_EVENT_PROVISIONING
            )
            owner_loop = asyncio.get_running_loop()

            def persist_creation_ack(receipt: dict[str, Any]) -> None:
                if any(
                    not isinstance(receipt.get(k), str) or not receipt[k]
                    for k in ("service", "serviceUid", "project", "region", "backend")
                ):
                    raise RuntimeError("provision acknowledgement invalid")
                future = asyncio.run_coroutine_threadsafe(
                    self._registry.publish_provision(
                        user_id=user_id,
                        attempt_id=reservation["attemptId"],
                        expected_phase="host_requested",
                        next_phase="host_requested",
                        evidence={"creationAcknowledgement": receipt},
                    ),
                    owner_loop,
                )
                if future.result(timeout=30) is not True:
                    raise RuntimeError("provision acknowledgement not admitted for continuation")

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
                provision_attempt_id=reservation["attemptId"],
                on_provision_ack=persist_creation_ack,
                phone_e164_hash=phone_hash,
                # Becomes the `hussh-billing-space` cost label. Opaque by
                # construction: a label is readable by anyone with project billing
                # access, so it must disclose nothing on its own.
                billing_space_id=billing_space_id,
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
            substrate_receipt = receipt.as_record() if receipt.resource_ids else None
            await _record("provisioning", next_phase="substrate")
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
            # Pre-bind the identity the pod will present. A user-owned pod boots and
            # heartbeats WHILE the backend is still waiting for Ready, and the hub
            # binds a heartbeat to the row's recorded runtime identity -- which,
            # until now, was written only after `provision` returned. So the first
            # beat of every such pod was refused (`email_not_bound`, live
            # 2026-09-02) and the handshake waited for the next one. The backend
            # knows the identity from the spec alone; asking it here is neutral
            # (no provider named) and optional (a backend without the method
            # behaves exactly as before).
            identity_of = getattr(backend, "runtime_identity_for", None)
            expected_identity = str(identity_of(spec) or "").strip() if identity_of else ""
            identity_handle = BackendHandle(
                backend=getattr(backend, "backend_id", None),
                backend_metadata={"runtime_service_account": expected_identity}
                if expected_identity
                else {},
            )
            target_of = getattr(backend, "provision_target_for", None)
            await _record(
                "provisioning",
                handle=identity_handle if expected_identity else None,
                next_phase="host_requested",
                target=target_of(spec) if target_of else None,
            )
            handle = await backend.provision(spec)
            await _record("provisioning", handle=handle, next_phase="host_acknowledged")
            await _record("connecting", handle=handle)

            if pod_key is None:
                # The host exists; the pod now has to boot and hand us its public key.
                # Stop here rather than minting: a standing pkm.read with no pod to
                # hold it is read authority granted to nobody, which is the one
                # ordering SECURITY-REVIEW.md M3 exists to prevent.
                await record_provisioning_feed_event_safe(
                    user_id=user_id, event_type=FEED_EVENT_CONNECTING
                )
                logger.info(
                    "personal_agent.connecting hushh_id=%s service=%s backend=%s",
                    hushh_id or "<none>",
                    handle.external_agent_id or "<none>",
                    handle.backend or "null",
                )
                # The host is Ready and reachable: pull the key NOW rather than
                # waiting for the pod's next heartbeat to notice `connecting`.
                # Same collector, same rotation rule as adoption. Best-effort: a
                # miss leaves the row at `connecting` for the heartbeat path.
                collected = await self._collect_key_now(user_id)
                return {
                    "hushhId": hushh_id,
                    "status": collected or "connecting",
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

    async def _collect_key_now(self, user_id: str) -> Optional[str]:
        """Pull a freshly built pod's key immediately. Never raises.

        Measured before this existed: host Ready 18:57:00Z, first beat refused
        18:57:38Z, key attached 18:59:32Z -- two and a half minutes of a person
        watching "connecting" for a pod that was already answering. Returns the
        status the collector reached (``provisioned`` on success) or None.
        """
        try:
            row = await self._registry.get(user_id)
            if not row:
                return None
            from hushh_mcp.services.pod_key_collector import refresh_pod_key  # noqa: PLC0415

            status = await refresh_pod_key(row, service=self)
            return status if isinstance(status, str) else None
        except Exception as exc:  # noqa: BLE001 - the heartbeat path finishes what this could not
            logger.info("personal_agent.immediate_key_pull_deferred %s", type(exc).__name__)
            return None

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

        provision_attempt = (existing.get("backend_metadata") or {}).get("provisionAttempt")
        if provision_attempt is not None and (
            provision_attempt.get("ownerId") != user_id
            or provision_attempt.get("phase") not in {"connecting", "provisioned"}
            or (existing.get("backend_metadata") or {}).get("erasure") is not None
        ):
            raise ValueError("personal agent key registration requires reconciliation")

        recorded_key = str(existing.get("pod_pubkey") or "").strip()
        if recorded_key:
            if compare_digest(recorded_key, pod_key.public_key_b64) and (
                provision_attempt is None or provision_attempt.get("phase") == "provisioned"
            ):
                return {
                    "hushhId": existing.get("hushh_id"),
                    "status": existing.get("status"),
                }
            if not allow_rotation and not compare_digest(recorded_key, pod_key.public_key_b64):
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
            nonlocal recorded_key
            if provision_attempt is not None:
                phase = "failed" if status == "provisioning_failed" else status
                published = await self._registry.publish_provision(
                    user_id=user_id,
                    attempt_id=provision_attempt["attemptId"],
                    expected_phase="connecting",
                    next_phase=phase,
                    evidence={
                        "expectedPodKey": recorded_key or None,
                        "registry": {
                            "pod_pubkey": pod_key.public_key_b64,
                            "pod_key_id": pod_key.key_id,
                            "pod_key_wrapping_alg": pod_key.wrapping_alg,
                        },
                    },
                )
                if not published:
                    raise RuntimeError("personal agent key publication requires reconciliation")
                recorded_key = pod_key.public_key_b64
                return
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
            # The attach below is best-effort and says so -- "the parked record stays,
            # so a retry can still land it". This early return was where that promised
            # retry died: every later phone-verify stopped here, so a cloud whose first
            # attach failed stayed parked forever with nothing in the system trying
            # again. Retried here, and only when the row does not already name a cloud,
            # so the common re-fire costs nothing.
            if not str(existing.get("user_cloud_project") or "").strip():
                from hushh_mcp.services.byoc_setup_job_service import (  # noqa: PLC0415
                    attach_parked_cloud,
                )

                await attach_parked_cloud(user_id, registry=self._registry)
            # No state transition -> no feed row: a re-fired phone-verify must not
            # replay "your agent is being set up" into the user's activity feed.
            return {"hushhId": existing.get("hushh_id"), "status": existing.get("status")}

        try:
            generation = await self._next_free_generation(phone_e164, user_id=user_id)
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
        # A cloud the person proved BEFORE this row existed (the cloud step comes
        # first) is waiting on their setup record; attach it now. Best-effort and
        # never a reason for registration to fail.
        from hushh_mcp.services.byoc_setup_job_service import (  # noqa: PLC0415
            attach_parked_cloud,
        )

        await attach_parked_cloud(user_id, registry=self._registry)
        return {"hushhId": hushh_id, "status": "pending"}

    async def list_upgrade_candidates(
        self, *, current_image: str, limit: int = 200
    ) -> list[dict[str, Any]]:
        """Whole pods whose recorded build is not the hub's current image.

        Skips rows with no recorded host image (nothing to move) and rows that
        already failed ``UPGRADE_ATTEMPTS_PER_IMAGE`` times on THIS image, so a
        revision that cannot boot is not replayed every pass. A pod that failed on
        an older image becomes a candidate again the moment the image moves.
        """
        target = str(current_image or "").strip()
        if not target:
            return []
        rows = await self._registry.fetch_upgrade_candidates(limit=limit)
        out: list[dict[str, Any]] = []
        for row in rows:
            metadata = (row or {}).get("backend_metadata") or {}
            if metadata.get("upgradeLease") is not None:
                if isinstance(metadata.get("upgradeAcknowledgement"), dict):
                    out.append(row)  # Observation only; upgrade_pod refuses new admission.
                continue
            built_from = running_image(row)
            if not built_from or built_from == target:
                continue
            marker = ((row or {}).get("backend_metadata") or {}).get("upgrade") or {}
            if (
                str(marker.get("failedImage") or "") == target
                and int(marker.get("attempts") or 0) >= UPGRADE_ATTEMPTS_PER_IMAGE
            ):
                continue
            if set_by_newer_hub(row):
                # A newer hub already moved this pod; this process is the previous
                # revision draining out, and its target is the past.
                continue
            # Scoped to THIS image, like the attempts check above it. Unscoped, the
            # docstring's promise -- "a pod that failed on an older image becomes a
            # candidate again the moment the image moves" -- was not kept: a pod that
            # failed on dev-aaa stayed skipped for the full cooldown even after an
            # emergency dev-bbb shipped, because the marker's timestamp is recent
            # regardless of which image it refers to.
            if str(marker.get("failedImage") or "") == target and _attempted_recently(marker):
                continue
            if ((row or {}).get("backend_metadata") or {}).get("upgradeLease") is not None:
                continue
            out.append(row)
        return out

    async def _reconcile_image_upgrade(
        self, *, user_id: str, row: dict, spec: PodSpec, backend: Any, lease: Any
    ) -> dict[str, Any]:
        metadata = dict(row.get("backend_metadata") or {})
        receipt = metadata.get("upgradeAcknowledgement")
        unresolved = {
            "hushhId": spec.hushh_id,
            "status": "provisioned",
            "upgraded": False,
            "skipped": "in_progress",
            "image": running_image(row),
            "previousImage": running_image(row),
        }
        observe = getattr(backend, "observe_upgrade", None)
        if (
            not isinstance(lease, str)
            or not lease
            or not isinstance(receipt, dict)
            or observe is None
        ):
            return unresolved
        attempt = hashlib.sha256(lease.encode()).hexdigest()
        if (
            receipt.get("attemptId") != attempt
            or receipt.get("serviceUid") != spec.expected_service_uid
            or not isinstance(receipt.get("targetImage"), str)
            or not receipt["targetImage"]
        ):
            return unresolved
        handle = await observe(replace(spec, upgrade_attempt_id=attempt), receipt)
        if handle is None:
            return unresolved
        if handle.status not in {"live", "failed"} or handle.external_agent_id != receipt.get(
            "service"
        ):
            raise RuntimeError("upgrade recovery terminal receipt invalid")
        updated = dict(metadata)
        updated.pop("upgradeLease", None)
        succeeded = handle.status == "live"
        if succeeded:
            updated.update(handle.backend_metadata or {})
            updated.pop("observed", None)
            updated.pop("upgrade", None)
            if receipt.get("hubRevision"):
                updated["imageSetByRevision"] = receipt["hubRevision"]
        else:
            updated["upgrade"] = {
                **(metadata.get("upgrade") or {}),
                "failedImage": receipt["targetImage"],
                "outcome": "failed",
                "attempts": max(1, int((metadata.get("upgrade") or {}).get("attempts") or 0)),
                "lastError": "Upgrade revision did not become ready",
                "lastAttemptAt": datetime.now(timezone.utc).isoformat(),
            }
        updated["upgradeAcknowledgement"] = {
            **receipt,
            "outcome": "ready" if succeeded else "failed",
        }
        published = await self._registry.record_image_upgrade(
            user_id=user_id,
            observed=row,
            expected_lease=lease,
            previous_metadata=metadata,
            backend_metadata=updated,
        )
        if published is not True:
            raise RuntimeError("upgrade recovery publication lost authority")
        return {
            **unresolved,
            "skipped": None,
            "reconciled": True,
            "upgraded": succeeded,
            "image": running_image({"backend_metadata": updated}),
        }

    async def upgrade_pod(self, *, user_id: str, current_image: str) -> dict[str, Any]:
        """Move one person's running pod onto ``current_image``, keeping who it is.

        ``provision`` heals to the digest a pod already runs -- correct for a heal,
        and the reason a fix shipped to the hub never reached a running pod. This is
        the deliberate roll-forward: same service, same bucket, same identity key,
        new revision. It reads the row for everything (billing space, cloud
        coordinates, key columns) and re-derives nothing, and it writes back ONLY the
        backend metadata that changed -- status, ``provisioned_at``, identity and the
        substrate receipt are untouched by construction (``record_image_upgrade``).

        A failure is recorded on the row as an ``upgrade`` marker and re-raised
        unchanged; the marker is what bounds retries per image.
        """
        if not personal_agent_enabled():
            raise PersonalAgentDisabledError(
                "upgrade requested while PERSONAL_AGENT_ENABLED is off"
            )
        row = await self._registry.get(user_id)
        if row is None:
            raise ValueError("no personal agent is registered for this person")
        if str(row.get("status") or "") != "provisioned":
            raise ValueError(
                f"only a provisioned pod can be upgraded (status is {row.get('status')!r})"
            )
        hushh_id = str(row.get("hushh_id") or "").strip()
        phone_hash = str(row.get("phone_e164_hash") or "").strip()
        if not hushh_id or not phone_hash:
            raise ValueError("registry row is missing its identity; refusing to upgrade")

        cloud = await resolve_user_cloud(user_id, repo=self._registry)
        if cloud is not None and cloud.blocks_provisioning:
            raise PersonalAgentCloudNotAuthorizedError(cloud.refusal_reason)
        spec = PodSpec(
            hushh_id=hushh_id,
            phone_e164_hash=phone_hash,
            billing_space_id=row.get("billing_space_id"),
            pod_pubkey=str(row.get("pod_pubkey") or ""),
            expected_service_uid=(row.get("backend_metadata") or {}).get("serviceUid"),
            deployment_target=row.get("deployment_target")
            or (cloud.deployment_target if cloud else None),
            model_credential_mode=row.get("model_credential_mode")
            or (cloud.model_credential_mode if cloud else None),
            user_cloud_project=(cloud.project if cloud else None),
            user_cloud_region=(cloud.region if cloud else None),
            user_cloud_bootstrap_sa=(cloud.bootstrap_sa if cloud else None),
            # The person's own warm floor. `PodSpec.resource_tier` was written, tested
            # and read by `_min_instances_for` -- and set by NOTHING, so the axis had an
            # output end and no input end.
            #
            # The loop ran one way only: deployment default -> rendered minScale ->
            # `livenessMode` -> the row's `liveness_mode`. A person's row therefore
            # RECORDED the deployment's default rather than holding a choice, and every
            # upgrade re-derived it from scratch. So a warm pod was demoted to
            # scale-to-zero on its next sweep, and `record_image_upgrade` wrote that
            # demotion back over the row -- durable, silent, and worse than it sounds,
            # because the liveness evaluator then reads a warm-intended pod's silence as
            # healthy and never restarts it. `_min_instances_for` refuses to guess
            # between those two exact outcomes; the guess was happening upstream, by
            # omission.
            #
            # `liveness_mode` is the stored value and is already the authority the
            # liveness policy judges against, so reading it here makes the two one fact
            # instead of two that can disagree. An unset or unrecognised value still
            # falls through to the deployment default, which is what every pod gets
            # today.
            resource_tier=row.get("liveness_mode"),
        )
        backend = self._backend_for(spec)
        held = (row.get("backend_metadata") or {}).get("upgradeLease")
        if held is not None:
            return await self._reconcile_image_upgrade(
                user_id=user_id, row=row, spec=spec, backend=backend, lease=held
            )
        upgrade = getattr(backend, "upgrade", None)
        if upgrade is None:
            raise PersonalAgentUpgradeUnsupportedError(
                f"backend {getattr(backend, 'backend_id', '?')!r} cannot upgrade a pod in place"
            )
        if set_by_newer_hub(row):
            logger.info(
                "personal_agent.upgrade_skipped hushh_id=%s reason=set_by_newer_hub", hushh_id
            )
            return {
                "hushhId": hushh_id,
                "status": "provisioned",
                "upgraded": False,
                "skipped": "set_by_newer_hub",
                "image": running_image(row),
                "previousImage": running_image(row),
            }
        # Single-flight across hub workers: the lease is one conditional write on
        # the row, and losing it means another worker is already moving this pod.
        from hushh_mcp.services.personal_agent_registry_repo import upgrade_host_snapshot

        requested_binding = upgrade_host_snapshot(row)
        claim = getattr(self._registry, "claim_image_upgrade", None)
        if not callable(claim):
            raise PersonalAgentUpgradeUnsupportedError("registry cannot fence image upgrades")
        lease = await claim(user_id=user_id, target_image=current_image, observed=row)
        if not isinstance(lease, str) or not lease:
            return {
                "hushhId": hushh_id,
                "status": "provisioned",
                "upgraded": False,
                "skipped": "in_progress",
                "image": running_image(row),
                "previousImage": running_image(row),
            }
        row = await self._registry.get(user_id)
        if (
            row is None
            or row.get("status") != "provisioned"
            or (row.get("backend_metadata") or {}).get("upgradeLease") != lease
        ):
            raise RuntimeError("image upgrade authority changed before execution")
        claimed_binding = upgrade_host_snapshot(row)
        if (
            requested_binding is None
            or claimed_binding is None
            or any(
                claimed_binding[key] != value
                for key, value in requested_binding.items()
                if key not in {"updated_at", "backend_metadata"}
            )
        ):
            raise RuntimeError("image upgrade host binding changed before execution")
        spec = replace(spec, upgrade_attempt_id=hashlib.sha256(lease.encode()).hexdigest())
        claimed_metadata = dict(row.get("backend_metadata") or {})
        claimed_row = row

        async def publish_upgrade(**fields: Any) -> None:
            published = await self._registry.record_image_upgrade(
                user_id=user_id,
                expected_lease=lease,
                previous_metadata=claimed_metadata,
                observed=claimed_row,
                **fields,
            )
            if published is not True:
                raise RuntimeError("image upgrade result publication lost authority")

        owner_loop = asyncio.get_running_loop()

        def persist_acknowledgement(receipt: dict[str, Any]) -> None:
            # Called off-loop. A late receipt may survive erasure admission, but
            # that path never authorizes continued upgrade execution.
            if receipt.get("attemptId") != spec.upgrade_attempt_id:
                raise RuntimeError("upgrade acknowledgement attempt mismatch")
            bound = {**receipt, "targetImage": current_image, "hubRevision": hub_revision()}

            async def persist() -> None:
                try:
                    await publish_upgrade(
                        backend_metadata={**claimed_metadata, "upgradeAcknowledgement": bound},
                        retain_lease=True,
                    )
                except RuntimeError:
                    retain = getattr(self._registry, "retain_erasure_upgrade_ack", None)
                    if retain is not None and await retain(
                        user_id=user_id, lease=lease, receipt=bound
                    ):
                        raise RuntimeError("upgrade acknowledgement retained for erasure") from None
                    raise

            future = asyncio.run_coroutine_threadsafe(persist(), owner_loop)
            future.result(timeout=30)

        spec = replace(spec, on_upgrade_ack=persist_acknowledgement)
        old_meta = dict(row.get("backend_metadata") or {})
        old_meta.pop("upgradeLease", None)
        previous = running_image(row)
        if set_by_newer_hub(row):
            # Re-judged on the row AS IT IS AFTER THE CLAIM, for the same reason the
            # cooldown is. `list_upgrade_candidates` checked this against a row read
            # before `resolve_user_cloud` and before the lease; a newer hub revision
            # can finish its own upgrade and release the lease inside that window,
            # which is exactly what 0ba8c6b49 measured happening forty seconds apart.
            # Winning the free lease then rolls the pod BACK to this draining
            # revision's older target -- a ~90s PUT and a restart on a live person's
            # agent, repeating every sweep.
            await publish_upgrade(backend_metadata=old_meta)
            logger.info("personal_agent.upgrade_skipped hushh_id=%s reason=superseded", hushh_id)
            return {
                "hushhId": hushh_id,
                "status": "provisioned",
                "upgraded": False,
                "skipped": "superseded",
                "image": previous,
                "previousImage": previous,
            }
        if _attempted_recently(old_meta.get("upgrade")):
            # Listed before another worker's attempt failed; do not stack a second
            # attempt on the same failure within the cooldown.
            await publish_upgrade(backend_metadata=old_meta)
            logger.info("personal_agent.upgrade_skipped hushh_id=%s reason=cooldown", hushh_id)
            return {
                "hushhId": hushh_id,
                "status": "provisioned",
                "upgraded": False,
                "skipped": "cooldown",
                "image": previous,
                "previousImage": previous,
            }
        # Narrated as its own stage so the status stream can say "Updating your
        # agent" instead of a spinner. The previous revision serves throughout.
        await pod_lifecycle_append(
            user_id,
            stage="updating",
            registry_status="provisioned",
            event="started",
            hushh_id=hushh_id,
            reason=f"{previous or '-'} -> {current_image}",
        )
        try:
            handle = await self._upgrade_healing_the_substrate_once(
                upgrade, spec, user_id=user_id, hushh_id=hushh_id
            )
        except Exception as exc:
            marker = old_meta.get("upgrade") or {}
            attempts = (
                int(marker.get("attempts") or 0) + 1
                if str(marker.get("failedImage") or "") == current_image
                else 1
            )
            reason = user_safe_failure_reason(exc)
            failure_recorded = False
            try:
                await publish_upgrade(
                    # An exception/timeout is not proof that external work stopped.
                    retain_lease=True,
                    backend_metadata={
                        **old_meta,
                        "upgrade": {
                            "outcome": "unresolved",
                            "failedImage": current_image,
                            "attempts": attempts,
                            "lastError": reason,
                            "lastAttemptAt": datetime.now(timezone.utc).isoformat(),
                        },
                    },
                )
                failure_recorded = True
            except Exception:
                logger.exception("personal_agent.upgrade_marker_write_failed")
            if failure_recorded:
                await pod_lifecycle_append(
                    user_id,
                    stage="authority_live",
                    registry_status="provisioned",
                    event="upgrade_failed",
                    hushh_id=hushh_id,
                    attempt=attempts,
                    reason=reason,
                )
            logger.warning(
                "personal_agent.upgrade_failed hushh_id=%s attempt=%s reason=%s",
                hushh_id,
                attempts,
                reason,
            )
            raise

        new_meta = {**old_meta, **(handle.backend_metadata or {})}
        new_meta.pop("upgrade", None)
        # `observed` is the OLD pod's report of what it was running, and that pod has
        # just been replaced. Carrying it through leaves source_image=new beside
        # observed.imageTag=old, and describe_pod_update resolves running from
        # `observed_tag or deployed_tag` -- so a pod that just updated successfully
        # reports updateAvailable forever. An economy pod scales to zero and its
        # heartbeat loop never runs, so nothing corrects it: the person sees a
        # permanent "update available" for an already-current agent. 1cd8d272a fixed
        # the mirror case (a bodyless beat dropping a stale report); this is the same
        # staleness arriving from the other side.
        new_meta.pop("observed", None)
        changed = bool(new_meta.get("upgraded", True))
        # Who set it, so a draining older hub revision refuses to move it back.
        if hub_revision():
            new_meta["imageSetByRevision"] = hub_revision()
        await publish_upgrade(
            backend_metadata=new_meta,
            liveness_mode=new_meta.get("livenessMode"),
        )
        await pod_lifecycle_append(
            user_id,
            stage="authority_live",
            registry_status="provisioned",
            event="upgraded" if changed else "upgrade_noop",
            hushh_id=hushh_id,
            reason=f"{previous or '-'} -> {running_image({'backend_metadata': new_meta}) or '-'}",
        )
        logger.info(
            "personal_agent.upgraded hushh_id=%s service=%s changed=%s",
            hushh_id,
            handle.external_agent_id or "<none>",
            changed,
        )
        if changed:
            await record_provisioning_feed_event_safe(
                user_id=user_id, event_type=FEED_EVENT_UPDATED
            )
        return {
            "hushhId": hushh_id,
            "status": "provisioned",
            "upgraded": changed,
            "image": running_image({"backend_metadata": new_meta}),
            "previousImage": previous,
        }

    async def adopt_orphan(self, *, user_id: str) -> Optional[dict[str, Any]]:
        """Reconnect to a pod that ALREADY exists in the user's project, not rebuild it.

        The case: a returning user whose registry row was lost or flipped to
        ``needs_reinit``, but whose deterministically-named pod is still running in
        THEIR own project (they uninstalled and came back, or the row was reaped). This
        is ``provision`` minus ``create``: it reconstructs a ``connecting`` row from the
        discovered live handle and lets the SAME key-collector finish it, so identity and
        memory are preserved. It NEVER creates compute and NEVER mints a new identity.

        Returns None (caller falls through to reinit/rebuild) when there is no adoptable
        pod: no row, no BYOC cloud recorded, or discover finds nothing labelled ours.
        Adoption can only ever restore, so it needs no destructive flag -- but it does
        require the feature to be on, like every other lifecycle write here.
        """
        if not personal_agent_enabled():
            raise PersonalAgentDisabledError(
                "adopt_orphan requested while PERSONAL_AGENT_ENABLED is off"
            )
        row = await self._registry.get(user_id)
        if row is None:
            return None
        if str(row.get("status") or "") == "provisioned":
            return None  # already whole; nothing to adopt
        hushh_id = str(row.get("hushh_id") or "").strip()
        phone_hash = str(row.get("phone_e164_hash") or "").strip()
        if not hushh_id or not phone_hash:
            return None
        cloud = await resolve_user_cloud(user_id, repo=self._registry)
        if cloud is None or not cloud.is_user_owned:
            # Adoption is a user-owned-cloud affordance: the deterministic pod lives in
            # the person's OWN project, the only place discover can reach it. The neutral
            # `is_user_owned` predicate keeps this orchestrator from naming any provider
            # (test_deployment_boundary_holds) -- the adapter owns the provider name.
            return None
        spec = PodSpec(
            hushh_id=hushh_id,
            phone_e164_hash=phone_hash,
            # READ from the row, never re-derived. The row is the authority: a
            # signing-key rotation must not silently give an adopted pod a
            # different billing space from the one its spend is recorded under.
            billing_space_id=(row or {}).get("billing_space_id"),
            pod_pubkey="",
            deployment_target=cloud.deployment_target,
            user_cloud_project=cloud.project,
            user_cloud_region=cloud.region,
            user_cloud_bootstrap_sa=cloud.bootstrap_sa,
        )
        backend = self._backend_for(spec)
        discover = getattr(backend, "discover", None)
        if discover is None:
            return None
        handle = await discover(hushh_id)
        if handle is None:
            return None  # no live pod to adopt -> caller reinits/rebuilds
        # Reconstruct the connecting row BEFORE the key pull: attach_pod_public_key
        # requires an existing row, and the pull mints a standing read that a row must
        # own. The handle's url is what the collector pulls the pod public key from.
        await self._registry.upsert(
            user_id=user_id,
            hushh_id=hushh_id,
            phone_e164_hash=phone_hash,
            status="connecting",
            external_agent_id=handle.external_agent_id,
            a2a_route=handle.a2a_route,
            backend=handle.backend,
            backend_metadata=handle.backend_metadata,
            # `discover` reads the LIVE service and computes the mode from its
            # rendered minScale, and until now that answer was carried in the
            # handle's metadata and dropped on the floor here. The row then kept
            # the column default of `warm`, so the liveness sweep read a healthy
            # scaled-to-zero pod's silence as a fault and probed it awake --
            # billing a cold start on every pass, forever, for a pod that was
            # working. Adoption exists to restore a row to the truth about a pod;
            # this is part of that truth.
            liveness_mode=(handle.backend_metadata or {}).get("livenessMode"),
            deployment_target=cloud.deployment_target,
            model_credential_mode=cloud.model_credential_mode,
        )
        row2 = await self._registry.get(user_id)
        from hushh_mcp.services.pod_key_collector import refresh_pod_key  # noqa: PLC0415

        # allow_rotation via refresh_pod_key is safe: the key is PULLED from the URL
        # Cloud Run just returned, never accepted from a caller. A pod that restarted
        # since its row was lost may present a fresh key, which is correct to accept.
        status = await refresh_pod_key(row2, service=self)
        logger.info(
            "personal_agent.adopted hushh_id=%s status=%s", hushh_id, status or "connecting"
        )
        return {"hushhId": hushh_id, "status": status or "connecting", "adopted": True}

    async def _fence_reserved_erasure(self, *, user_id: str, reservation: dict) -> dict:
        """Fence one observed pod under its immutable registry reservation."""
        from hushh_mcp.services.pod_migration_transport import (
            fence_for_erasure,
            observe_memory_for_erasure,
        )

        if (
            not isinstance(reservation, dict)
            or reservation.get("ownerId") != user_id
            or reservation.get("version") != 1
            or reservation.get("phase") != "reserved"
            or not isinstance(reservation.get("attemptId"), str)
            or not reservation["attemptId"]
        ):
            raise RuntimeError("erasure reservation unavailable")
        row = reservation.get("registrySnapshot")
        if (
            not isinstance(row, dict)
            or row.get("user_id") != user_id
            or row.get("status") != "provisioned"
        ):
            raise RuntimeError("erasure host snapshot unavailable")
        metadata = row.get("backend_metadata") or {}
        if metadata.get("upgradeLease") is not None or not metadata.get("serviceUid"):
            raise RuntimeError("erasure compute attempt unresolved")
        hushh_id = row.get("hushh_id")
        if not hushh_id or hushh_id != reservation.get("hushhId"):
            raise RuntimeError("erasure owner identity unavailable")
        spec = PodSpec(
            hushh_id=hushh_id,
            phone_e164_hash=str(row.get("phone_e164_hash") or ""),
            pod_pubkey=str(row.get("pod_pubkey") or ""),
            billing_space_id=row.get("billing_space_id"),
            expected_service_uid=metadata["serviceUid"],
            deployment_target=row.get("deployment_target"),
            model_credential_mode=row.get("model_credential_mode"),
            user_cloud_project=row.get("user_cloud_project"),
            user_cloud_region=row.get("user_cloud_region"),
            user_cloud_bootstrap_sa=row.get("user_cloud_bootstrap_sa"),
        )
        backend = self._backend_for(spec)
        observe = getattr(backend, "observe_erasure_target", None)
        if observe is None or getattr(backend, "backend_id", None) != row.get("backend"):
            raise RuntimeError("erasure backend observation unavailable")
        target = await observe(spec)
        if (
            target.get("serviceUid") != metadata["serviceUid"]
            or target.get("service") != (metadata.get("service") or row.get("external_agent_id"))
            or target.get("podUrl") != str(metadata.get("url") or "").rstrip("/")
        ):
            raise RuntimeError("erasure compute observation mismatch")
        current = await self._registry.get(user_id)
        if (
            not current
            or current.get("status") != "suspended"
            or (current.get("backend_metadata") or {}).get("erasure") != reservation
        ):
            raise RuntimeError("erasure reservation changed")
        payload = {
            "hushhId": hushh_id,
            "attemptId": reservation["attemptId"],
            "service": target["service"],
            "serviceUid": target["serviceUid"],
            "revision": target["revision"],
        }
        await asyncio.to_thread(fence_for_erasure, pod_url=target["podUrl"], payload=payload)
        receipt = await asyncio.to_thread(
            observe_memory_for_erasure, pod_url=target["podUrl"], payload=payload
        )
        retain = getattr(self._registry, "retain_erasure_memory_binding", None)
        if retain is None or not await retain(
            user_id=user_id, reservation=reservation, receipt=receipt
        ):
            raise RuntimeError("erasure memory binding retention unconfirmed")
        observed = await self._registry.get(user_id)
        saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
        if (
            not observed
            or observed.get("status") != "suspended"
            or saved.get("ownerId") != user_id
            or saved.get("attemptId") != reservation["attemptId"]
            or saved.get("memoryBinding") != receipt
        ):
            raise RuntimeError("erasure memory binding readback unconfirmed")
        attempt = metadata.get("provisionAttempt") or {}
        creation = ((attempt.get("evidence") or {}).get("host_requested") or {}).get(
            "creationAcknowledgement"
        ) or {}
        if (
            attempt.get("version") != 1
            or attempt.get("ownerId") != user_id
            or attempt.get("phase") != "provisioned"
            or type(creation.get("initialGeneration")) is not int
            or creation["initialGeneration"] != 1
            or not isinstance(creation.get("initialImage"), str)
            or not receipt["memoryBinding"].get("creationProvenance")
            or creation.get("serviceUid") != target["serviceUid"]
        ):
            raise RuntimeError("erasure runtime creation provenance unavailable")
        expected_target = backend.provision_target_for(spec)
        if any(creation.get(key) != value for key, value in expected_target.items()):
            raise RuntimeError("erasure creation target changed")
        runtime = await backend.observe_erasure_runtime(spec)
        if (
            any(runtime.get(key) != value for key, value in target.items())
            or runtime.get("generation") != creation["initialGeneration"]
            or runtime.get("image") != creation["initialImage"]
        ):
            raise RuntimeError("erasure runtime creation identity changed")
        return {**receipt, "runtime": runtime}

    async def _erase_reserved_memory(self, *, user_id: str, qualified: dict) -> None:
        """Persist pod-held provider erasure before any later resource teardown."""
        from hushh_mcp.services.pod_migration_transport import reconcile_memory_for_erasure

        payload = {key: value for key, value in qualified.items() if key != "runtime"}
        current = await self._registry.get(user_id)
        reservation = ((current or {}).get("backend_metadata") or {}).get("erasure") or {}
        if (
            not current
            or current.get("status") != "suspended"
            or reservation.get("ownerId") != user_id
            or reservation.get("attemptId") != payload.get("attemptId")
            or reservation.get("memoryBinding") != payload
        ):
            raise RuntimeError("erasure reservation changed before provider request")
        retain_binding = getattr(self._registry, "retain_erasure_memory_binding", None)
        retain_deletion = getattr(self._registry, "retain_erasure_memory_deletion", None)
        if (
            retain_binding is None
            or retain_deletion is None
            or not await retain_binding(user_id=user_id, reservation=reservation, receipt=payload)
        ):
            raise RuntimeError("erasure admission unconfirmed before provider request")
        receipt = await asyncio.to_thread(
            reconcile_memory_for_erasure,
            pod_url=qualified["runtime"]["podUrl"],
            payload=payload,
        )
        if not await retain_deletion(user_id=user_id, reservation=reservation, receipt=receipt):
            raise RuntimeError("erasure provider receipt retention unconfirmed")
        observed = await self._registry.get(user_id)
        saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
        if (
            not observed
            or observed.get("status") != "suspended"
            or saved.get("ownerId") != user_id
            or saved.get("attemptId") != reservation["attemptId"]
            or saved.get("memoryDeletion") != receipt
        ):
            raise RuntimeError("erasure provider receipt readback unconfirmed")

    async def _erase_reserved_compute(self, *, user_id: str) -> None:
        """Resume acknowledged compute work before any further pod contact."""
        current = await self._registry.get(user_id)
        reservation = ((current or {}).get("backend_metadata") or {}).get("erasure") or {}
        row = reservation.get("registrySnapshot") or {}
        metadata = row.get("backend_metadata") or {}
        if (
            not current
            or current.get("status") != "suspended"
            or reservation.get("ownerId") != user_id
            or row.get("user_id") != user_id
            or not reservation.get("memoryDeletion")
            or not metadata.get("serviceUid")
        ):
            raise RuntimeError("erasure compute reservation unavailable")
        retain = getattr(self._registry, "retain_erasure_compute_receipt", None)
        if retain is None:
            raise RuntimeError("erasure compute receipt storage unavailable")
        if reservation.get("computeDeletion"):
            if not await retain(
                user_id=user_id,
                reservation=reservation,
                stage="computeDeletion",
                receipt=reservation["computeDeletion"],
            ):
                raise RuntimeError("erasure compute completion unconfirmed")
            return
        acknowledgement = reservation.get("computeAcknowledgement")
        if reservation.get("computeAdmission") and not acknowledgement:
            raise RuntimeError("erasure compute acknowledgement unresolved")
        spec = PodSpec(
            hushh_id=row["hushh_id"],
            phone_e164_hash=str(row.get("phone_e164_hash") or ""),
            pod_pubkey=str(row.get("pod_pubkey") or ""),
            billing_space_id=row.get("billing_space_id"),
            expected_service_uid=metadata["serviceUid"],
            deployment_target=row.get("deployment_target"),
            model_credential_mode=row.get("model_credential_mode"),
            user_cloud_project=row.get("user_cloud_project"),
            user_cloud_region=row.get("user_cloud_region"),
            user_cloud_bootstrap_sa=row.get("user_cloud_bootstrap_sa"),
        )
        backend = self._backend_for(spec)
        if getattr(backend, "backend_id", None) != row.get("backend") or not hasattr(
            backend, "erase_compute"
        ):
            raise RuntimeError("erasure compute backend unavailable")
        loop = asyncio.get_running_loop()

        async def append(stage: str, receipt: dict) -> bool:
            nonlocal reservation
            if not await retain(
                user_id=user_id, reservation=reservation, stage=stage, receipt=receipt
            ):
                return False
            observed = await self._registry.get(user_id)
            saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
            if (
                not observed
                or observed.get("status") != "suspended"
                or saved.get("ownerId") != user_id
                or saved.get("attemptId") != reservation.get("attemptId")
                or saved.get(stage) != receipt
            ):
                return False
            reservation = saved
            return True

        def callback(stage: str):
            def persist(receipt: dict) -> bool:
                # The provider worker remains responsible for a late acknowledgement
                # if its HTTP caller is cancelled. A lost worker stays unresolved.
                return asyncio.run_coroutine_threadsafe(append(stage, receipt), loop).result(
                    timeout=30
                )

            return persist

        if acknowledgement and not await retain(
            user_id=user_id,
            reservation=reservation,
            stage="computeAcknowledgement",
            receipt=acknowledgement,
        ):
            raise RuntimeError("erasure compute acknowledgement unconfirmed")
        await backend.erase_compute(
            spec,
            operation_name=acknowledgement["operationName"] if acknowledgement else None,
            before_submit=callback("computeAdmission"),
            on_acknowledged=callback("computeAcknowledgement"),
        )
        acknowledgement = reservation.get("computeAcknowledgement")
        if not acknowledgement or not await append(
            "computeDeletion", {**acknowledgement, "status": "compute_deleted"}
        ):
            raise RuntimeError("erasure compute completion retention unconfirmed")

    async def _retain_reserved_substrate_inventory(self, *, user_id: str) -> None:
        current = await self._registry.get(user_id)
        reservation = ((current or {}).get("backend_metadata") or {}).get("erasure") or {}
        snapshot = reservation.get("registrySnapshot") or {}
        inventory = (snapshot.get("backend_metadata") or {}).get("substrateReceipt")
        retain = getattr(self._registry, "retain_erasure_substrate_inventory", None)
        if (
            not current
            or current.get("status") != "suspended"
            or reservation.get("ownerId") != user_id
            or snapshot.get("user_id") != user_id
            or not reservation.get("computeDeletion")
            or not isinstance(inventory, dict)
            or retain is None
            or not await retain(user_id=user_id, reservation=reservation)
        ):
            raise RuntimeError("erasure substrate inventory retention unavailable")
        observed = await self._registry.get(user_id)
        saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
        if (
            not observed
            or observed.get("status") != "suspended"
            or saved.get("ownerId") != user_id
            or saved.get("attemptId") != reservation.get("attemptId")
            or saved.get("substrateInventory") != inventory
        ):
            raise RuntimeError("erasure substrate inventory readback unconfirmed")

    def _reserved_cleanup_backend(self, snapshot: dict):
        spec = PodSpec(
            hushh_id=snapshot["hushh_id"],
            phone_e164_hash=str(snapshot.get("phone_e164_hash") or ""),
            pod_pubkey=str(snapshot.get("pod_pubkey") or ""),
            deployment_target=snapshot.get("deployment_target"),
            model_credential_mode=snapshot.get("model_credential_mode"),
            user_cloud_project=snapshot.get("user_cloud_project"),
            user_cloud_region=snapshot.get("user_cloud_region"),
            user_cloud_bootstrap_sa=snapshot.get("user_cloud_bootstrap_sa"),
        )
        backend = self._backend_for(spec)
        if getattr(backend, "backend_id", None) != snapshot.get("backend"):
            raise RuntimeError("reserved cleanup backend mismatch")
        return backend

    async def _revoke_reserved_runtime_writer(self, *, user_id: str) -> None:
        from hushh_mcp.runtime_settings import personal_agent_substrate_teardown_enabled
        from hushh_mcp.services.byoc_substrate import _service_account_creation_identity

        if not personal_agent_substrate_teardown_enabled():
            raise RuntimeError("runtime writer revocation guarded")
        current = await self._registry.get(user_id)
        reservation = ((current or {}).get("backend_metadata") or {}).get("erasure") or {}
        snapshot = reservation.get("registrySnapshot") or {}
        metadata = snapshot.get("backend_metadata") or {}
        inventory = reservation.get("substrateInventory") or {}
        project = snapshot.get("user_cloud_project")
        bootstrap_ref = str(snapshot.get("user_cloud_bootstrap_sa") or "").removeprefix(
            "serviceAccount:"
        )
        email = metadata.get("runtime_service_account")
        retain = getattr(self._registry, "retain_erasure_writer_receipt", None)
        if (
            not current
            or current.get("status") != "suspended"
            or reservation.get("ownerId") != user_id
            or snapshot.get("user_id") != user_id
            or not reservation.get("computeDeletion")
            or not project
            or not bootstrap_ref
            or not email
            or retain is None
        ):
            raise RuntimeError("runtime writer reservation unavailable")
        observations = [
            item
            for item in inventory.get("resourceObservations", [])
            if isinstance(item, dict)
            and item.get("type") == "service_account"
            and item.get("id") == email
            and item.get("disposition") == "created"
        ]
        identity = observations[0].get("identity") if len(observations) == 1 else None
        if (
            _service_account_creation_identity(identity, email) != identity
            or not isinstance(identity, dict)
            or identity.get("projectId") != project
        ):
            raise RuntimeError("runtime writer creation evidence unavailable")
        loop = asyncio.get_running_loop()

        async def append(stage: str, raw: dict) -> bool:
            nonlocal reservation
            receipt = {**raw, "ownerId": user_id, "attemptId": reservation["attemptId"]}
            if not await retain(
                user_id=user_id, reservation=reservation, stage=stage, receipt=receipt
            ):
                return False
            observed = await self._registry.get(user_id)
            saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
            if (
                not observed
                or observed.get("status") != "suspended"
                or saved.get("ownerId") != user_id
                or saved.get("attemptId") != reservation["attemptId"]
                or saved.get(stage) != receipt
            ):
                return False
            reservation = saved
            return True

        def before_disable(raw: dict) -> bool:
            return asyncio.run_coroutine_threadsafe(
                append("writerAdmission", {**raw, "status": "admitted"}), loop
            ).result(timeout=30)

        revoke_writer = getattr(
            self._reserved_cleanup_backend(snapshot), "revoke_runtime_writer", None
        )
        if revoke_writer is None:
            raise RuntimeError("runtime writer revocation unsupported")
        result = await revoke_writer(
            identity=identity,
            before_disable=before_disable,
            admitted=bool(reservation.get("writerAdmission")),
        )
        if not await append("writerDisabled", result):
            raise RuntimeError("runtime writer revocation retention unconfirmed")

    async def _erase_reserved_bucket(self, *, user_id: str) -> None:
        from hushh_mcp.runtime_settings import personal_agent_substrate_teardown_enabled
        from hushh_mcp.services.byoc_substrate_teardown import plan_teardown

        if not personal_agent_substrate_teardown_enabled():
            raise RuntimeError("bucket erasure guarded")
        current = await self._registry.get(user_id)
        reservation = ((current or {}).get("backend_metadata") or {}).get("erasure") or {}
        snapshot = reservation.get("registrySnapshot") or {}
        inventory = reservation.get("substrateInventory") or {}
        retain = getattr(self._registry, "retain_erasure_bucket_receipt", None)
        project = snapshot.get("user_cloud_project")
        bootstrap_ref = str(snapshot.get("user_cloud_bootstrap_sa") or "").removeprefix(
            "serviceAccount:"
        )
        if (
            not current
            or current.get("status") != "suspended"
            or reservation.get("ownerId") != user_id
            or snapshot.get("user_id") != user_id
            or not reservation.get("writerDisabled")
            or not project
            or not bootstrap_ref
            or retain is None
        ):
            raise RuntimeError("bucket erasure reservation unavailable")
        buckets = [
            item
            for item in inventory.get("plannedResources", [])
            if isinstance(item, dict) and item.get("type") == "gcs_bucket"
        ]
        if len(buckets) != 1:
            raise RuntimeError("bucket erasure inventory unresolved")
        bucket = buckets[0]
        observations = [
            item
            for item in inventory.get("resourceObservations", [])
            if isinstance(item, dict)
            and item.get("type") == "gcs_bucket"
            and item.get("id") == bucket.get("id")
            and item.get("disposition") == "created"
        ]
        if len(observations) != 1:
            raise RuntimeError("bucket creation evidence unavailable")
        action = plan_teardown([{**bucket, "resourceObservation": observations[0]}])[0]
        attempt = reservation["attemptId"]
        loop = asyncio.get_running_loop()

        async def append(stage: str, raw: dict) -> bool:
            nonlocal reservation
            if stage == "bucketAdmission":
                await self._revoke_reserved_runtime_writer(user_id=user_id)
            observed = await self._registry.get(user_id)
            saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
            if (
                not observed
                or observed.get("status") != "suspended"
                or saved.get("ownerId") != user_id
                or saved.get("attemptId") != attempt
                or saved.get("registrySnapshot") != snapshot
                or saved.get("substrateInventory") != inventory
            ):
                return False
            receipt = {**raw, "ownerId": user_id, "attemptId": attempt}
            if not await retain(user_id=user_id, reservation=saved, stage=stage, receipt=receipt):
                return False
            observed = await self._registry.get(user_id)
            saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
            if (
                not observed
                or observed.get("status") != "suspended"
                or saved.get("ownerId") != user_id
                or saved.get("attemptId") != attempt
                or saved.get(stage) != receipt
            ):
                return False
            reservation = saved
            return True

        def checkpoint(stage: str, raw: dict) -> bool:
            return asyncio.run_coroutine_threadsafe(append(stage, raw), loop).result(timeout=30)

        states = {}
        for stage in ("bucketAdmission", "bucketAcknowledgement", "bucketDeletion"):
            if stage in reservation:
                receipt = reservation[stage]
                if (
                    not isinstance(receipt, dict)
                    or receipt.get("ownerId") != user_id
                    or receipt.get("attemptId") != attempt
                ):
                    raise RuntimeError("bucket recovery receipt owner unverified")
                states[stage] = {
                    key: value
                    for key, value in receipt.items()
                    if key not in {"ownerId", "attemptId"}
                }
        preflight = getattr(self._registry, "verify_erasure_bucket_preflight", None)
        if preflight is None or not await preflight(user_id=user_id, reservation=reservation):
            raise RuntimeError("bucket erasure database contract unavailable")
        erase_bucket = getattr(self._reserved_cleanup_backend(snapshot), "erase_bucket", None)
        if erase_bucket is None:
            raise RuntimeError("bucket erasure unsupported")
        await erase_bucket(action=action, state=states, retain_receipt=checkpoint)

    async def _erase_reserved_mail_resources(self, *, user_id: str) -> None:
        from hushh_mcp.runtime_settings import personal_agent_substrate_teardown_enabled

        if not personal_agent_substrate_teardown_enabled():
            raise RuntimeError("mail erasure guarded")
        current = await self._registry.get(user_id)
        reservation = ((current or {}).get("backend_metadata") or {}).get("erasure") or {}
        snapshot = reservation.get("registrySnapshot") or {}
        inventory = reservation.get("substrateInventory") or {}
        retain = getattr(self._registry, "retain_erasure_mail_receipt", None)
        preflight = getattr(self._registry, "verify_erasure_mail_preflight", None)
        if (
            not current
            or current.get("status") != "suspended"
            or reservation.get("ownerId") != user_id
            or snapshot.get("user_id") != user_id
            or not reservation.get("writerDisabled")
            or retain is None
            or preflight is None
        ):
            raise RuntimeError("mail erasure reservation unavailable")
        if not await preflight(user_id=user_id, reservation=reservation):
            raise RuntimeError("mail erasure database contract unavailable")
        erase = getattr(self._reserved_cleanup_backend(snapshot), "erase_mail_resource", None)
        if erase is None:
            raise RuntimeError("mail erasure unsupported")
        attempt = reservation["attemptId"]
        loop = asyncio.get_running_loop()
        # Validate all intended mail resources before removing the first one.
        observations = []
        for kind in ("cloud_scheduler_job", "pubsub_subscription", "pubsub_topic"):
            planned = [
                item
                for item in inventory.get("plannedResources", [])
                if isinstance(item, dict) and item.get("type") == kind
            ]
            if len(planned) != 1:
                raise RuntimeError("mail erasure inventory unresolved")
            captured = [
                item
                for item in inventory.get("resourceObservations", [])
                if isinstance(item, dict)
                and item.get("type") == kind
                and item.get("id") == planned[0].get("id")
                and item.get("disposition") == "created"
            ]
            if len(captured) != 1:
                raise RuntimeError("mail erasure creation evidence unavailable")
            observations.append(captured[0])

        for observation in observations:
            kind = observation["type"]

            async def append(stage: str, raw: dict, *, kind: str = kind) -> bool:
                nonlocal reservation
                if stage == "admission":
                    await self._revoke_reserved_runtime_writer(user_id=user_id)
                observed = await self._registry.get(user_id)
                saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
                if (
                    not observed
                    or observed.get("status") != "suspended"
                    or saved.get("ownerId") != user_id
                    or saved.get("attemptId") != attempt
                    or saved.get("registrySnapshot") != snapshot
                    or saved.get("substrateInventory") != inventory
                ):
                    return False
                receipt = {**raw, "ownerId": user_id, "attemptId": attempt}
                if not await retain(
                    user_id=user_id, reservation=saved, kind=kind, stage=stage, receipt=receipt
                ):
                    return False
                observed = await self._registry.get(user_id)
                saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
                if (
                    not observed
                    or observed.get("status") != "suspended"
                    or saved.get("ownerId") != user_id
                    or saved.get("attemptId") != attempt
                    or saved.get("mailErasure", {}).get(kind, {}).get(stage) != receipt
                ):
                    return False
                reservation = saved
                return True

            def checkpoint(stage: str, raw: dict, *, append_receipt=append) -> bool:
                return asyncio.run_coroutine_threadsafe(append_receipt(stage, raw), loop).result(
                    timeout=30
                )

            states = {}
            for stage, receipt in reservation.get("mailErasure", {}).get(kind, {}).items():
                if (
                    not isinstance(receipt, dict)
                    or receipt.get("ownerId") != user_id
                    or receipt.get("attemptId") != attempt
                ):
                    raise RuntimeError("mail recovery owner unverified")
                states[stage] = {
                    key: value
                    for key, value in receipt.items()
                    if key not in {"ownerId", "attemptId"}
                }
            await erase(observation=observation, state=states, retain_receipt=checkpoint)

    async def _erase_reserved_kms_material(self, *, user_id: str) -> None:
        from hushh_mcp.runtime_settings import personal_agent_substrate_teardown_enabled

        if not personal_agent_substrate_teardown_enabled():
            raise RuntimeError("KMS erasure guarded")
        current = await self._registry.get(user_id)
        reservation = ((current or {}).get("backend_metadata") or {}).get("erasure") or {}
        snapshot = reservation.get("registrySnapshot") or {}
        inventory = reservation.get("substrateInventory") or {}
        retain = getattr(self._registry, "retain_erasure_kms_receipt", None)
        preflight = getattr(self._registry, "verify_erasure_kms_preflight", None)
        if (
            not current
            or current.get("status") != "suspended"
            or reservation.get("ownerId") != user_id
            or snapshot.get("user_id") != user_id
            or retain is None
            or preflight is None
        ):
            raise RuntimeError("KMS erasure reservation unavailable")
        if not await preflight(user_id=user_id, reservation=reservation):
            raise RuntimeError("KMS erasure database contract unavailable")
        planned = [
            item
            for item in inventory.get("plannedResources", [])
            if isinstance(item, dict) and item.get("type") == "kms_key"
        ]
        if len(planned) != 1:
            raise RuntimeError("KMS erasure inventory unresolved")
        captured = [
            item
            for item in inventory.get("resourceObservations", [])
            if isinstance(item, dict)
            and item.get("type") == "kms_key"
            and item.get("id") == planned[0].get("id")
            and item.get("disposition") == "created"
        ]
        if len(captured) != 1:
            raise RuntimeError("KMS erasure creation evidence unavailable")
        erase = getattr(self._reserved_cleanup_backend(snapshot), "erase_kms_material", None)
        if erase is None:
            raise RuntimeError("KMS erasure unsupported")
        attempt = reservation["attemptId"]
        loop = asyncio.get_running_loop()

        async def append(stage: str, raw: dict) -> bool:
            if stage == "admission":
                await self._revoke_reserved_runtime_writer(user_id=user_id)
            observed = await self._registry.get(user_id)
            saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
            if (
                not observed
                or observed.get("status") != "suspended"
                or saved.get("ownerId") != user_id
                or saved.get("attemptId") != attempt
                or saved.get("registrySnapshot") != snapshot
                or saved.get("substrateInventory") != inventory
            ):
                return False
            receipt = {**raw, "ownerId": user_id, "attemptId": attempt}
            if not await retain(user_id=user_id, reservation=saved, stage=stage, receipt=receipt):
                return False
            observed = await self._registry.get(user_id)
            saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
            kms = saved.get("kmsErasure") or {}
            retained = (
                kms.get(stage)
                if stage in {"inventory", "completion"}
                else kms.get("versions", {}).get(raw.get("versionName"), {}).get(stage)
            )
            return bool(
                observed
                and observed.get("status") == "suspended"
                and saved.get("ownerId") == user_id
                and saved.get("attemptId") == attempt
                and retained == receipt
            )

        def checkpoint(stage: str, raw: dict) -> bool:
            return asyncio.run_coroutine_threadsafe(append(stage, raw), loop).result(timeout=30)

        def unbind(receipt: dict) -> dict:
            if (
                not isinstance(receipt, dict)
                or receipt.get("ownerId") != user_id
                or receipt.get("attemptId") != attempt
            ):
                raise RuntimeError("KMS recovery owner unverified")
            return {
                key: value for key, value in receipt.items() if key not in {"ownerId", "attemptId"}
            }

        states = {}
        for stage, receipt in (reservation.get("kmsErasure") or {}).items():
            if stage == "versions":
                states[stage] = {
                    name: {kind: unbind(value) for kind, value in stages.items()}
                    for name, stages in receipt.items()
                }
            else:
                states[stage] = unbind(receipt)
        await erase(
            action={**planned[0], "resourceObservation": captured[0]},
            state=states,
            retain_receipt=checkpoint,
        )

    async def _erase_reserved_signing_secret(self, *, user_id: str) -> None:
        from hushh_mcp.runtime_settings import personal_agent_substrate_teardown_enabled

        if not personal_agent_substrate_teardown_enabled():
            raise RuntimeError("secret erasure guarded")
        current = await self._registry.get(user_id)
        reservation = ((current or {}).get("backend_metadata") or {}).get("erasure") or {}
        snapshot = reservation.get("registrySnapshot") or {}
        inventory = reservation.get("substrateInventory") or {}
        retain = getattr(self._registry, "retain_erasure_secret_receipt", None)
        preflight = getattr(self._registry, "verify_erasure_secret_preflight", None)
        if (
            not current
            or current.get("status") != "suspended"
            or reservation.get("ownerId") != user_id
            or snapshot.get("user_id") != user_id
            or retain is None
            or preflight is None
        ):
            raise RuntimeError("secret erasure reservation unavailable")
        if not await preflight(user_id=user_id, reservation=reservation):
            raise RuntimeError("secret erasure database contract unavailable")
        planned = [
            item
            for item in inventory.get("plannedResources", [])
            if isinstance(item, dict) and item.get("type") == "secret"
        ]
        if len(planned) != 1:
            raise RuntimeError("secret erasure inventory unresolved")
        captured = [
            item
            for item in inventory.get("resourceObservations", [])
            if isinstance(item, dict)
            and item.get("type") == "secret"
            and item.get("id") == planned[0].get("id")
            and item.get("disposition") == "created"
        ]
        if len(captured) != 1:
            raise RuntimeError("secret erasure creation evidence unavailable")
        erase = getattr(self._reserved_cleanup_backend(snapshot), "erase_signing_secret", None)
        if erase is None:
            raise RuntimeError("secret erasure unsupported")
        attempt = reservation["attemptId"]
        loop = asyncio.get_running_loop()

        async def append(stage: str, raw: dict) -> bool:
            if stage == "admission":
                await self._revoke_reserved_runtime_writer(user_id=user_id)
            observed = await self._registry.get(user_id)
            saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
            if (
                not observed
                or observed.get("status") != "suspended"
                or saved.get("ownerId") != user_id
                or saved.get("attemptId") != attempt
                or saved.get("registrySnapshot") != snapshot
                or saved.get("substrateInventory") != inventory
            ):
                return False
            receipt = {**raw, "ownerId": user_id, "attemptId": attempt}
            if not await retain(user_id=user_id, reservation=saved, stage=stage, receipt=receipt):
                return False
            observed = await self._registry.get(user_id)
            saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
            retained = (saved.get("secretErasure") or {}).get(stage)
            return bool(
                observed
                and observed.get("status") == "suspended"
                and saved.get("ownerId") == user_id
                and saved.get("attemptId") == attempt
                and retained == receipt
            )

        def checkpoint(stage: str, raw: dict) -> bool:
            return asyncio.run_coroutine_threadsafe(append(stage, raw), loop).result(timeout=30)

        def unbind(receipt: dict) -> dict:
            if (
                not isinstance(receipt, dict)
                or receipt.get("ownerId") != user_id
                or receipt.get("attemptId") != attempt
            ):
                raise RuntimeError("secret recovery owner unverified")
            return {
                key: value for key, value in receipt.items() if key not in {"ownerId", "attemptId"}
            }

        states = {
            stage: unbind(receipt)
            for stage, receipt in (reservation.get("secretErasure") or {}).items()
        }
        await erase(
            action={**planned[0], "resourceObservation": captured[0]},
            state=states,
            retain_receipt=checkpoint,
        )

    async def _erase_reserved_runtime_account(self, *, user_id: str) -> None:
        from hushh_mcp.runtime_settings import personal_agent_substrate_teardown_enabled

        if not personal_agent_substrate_teardown_enabled():
            raise RuntimeError("runtime account erasure guarded")
        current = await self._registry.get(user_id)
        reservation = ((current or {}).get("backend_metadata") or {}).get("erasure") or {}
        snapshot = reservation.get("registrySnapshot") or {}
        inventory = reservation.get("substrateInventory") or {}
        retain = getattr(self._registry, "retain_erasure_account_receipt", None)
        preflight = getattr(self._registry, "verify_erasure_account_preflight", None)
        if (
            not current
            or current.get("status") != "suspended"
            or reservation.get("ownerId") != user_id
            or snapshot.get("user_id") != user_id
            or retain is None
            or preflight is None
        ):
            raise RuntimeError("runtime account erasure reservation unavailable")
        if not await preflight(user_id=user_id, reservation=reservation):
            raise RuntimeError("runtime account erasure database contract unavailable")
        planned = [
            item
            for item in inventory.get("plannedResources", [])
            if isinstance(item, dict) and item.get("type") == "service_account"
        ]
        if len(planned) != 1:
            raise RuntimeError("runtime account erasure inventory unresolved")
        captured = [
            item
            for item in inventory.get("resourceObservations", [])
            if isinstance(item, dict)
            and item.get("type") == "service_account"
            and item.get("id") == planned[0].get("id")
            and item.get("disposition") == "created"
        ]
        if len(captured) != 1:
            raise RuntimeError("runtime account erasure creation evidence unavailable")
        erase = getattr(self._reserved_cleanup_backend(snapshot), "erase_runtime_account", None)
        if erase is None:
            raise RuntimeError("runtime account erasure unsupported")
        attempt = reservation["attemptId"]
        loop = asyncio.get_running_loop()

        async def append(stage: str, raw: dict) -> bool:
            if stage == "admission":
                await self._revoke_reserved_runtime_writer(user_id=user_id)
            observed = await self._registry.get(user_id)
            saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
            if (
                not observed
                or observed.get("status") != "suspended"
                or saved.get("ownerId") != user_id
                or saved.get("attemptId") != attempt
                or saved.get("registrySnapshot") != snapshot
                or saved.get("substrateInventory") != inventory
            ):
                return False
            receipt = {**raw, "ownerId": user_id, "attemptId": attempt}
            if not await retain(user_id=user_id, reservation=saved, stage=stage, receipt=receipt):
                return False
            observed = await self._registry.get(user_id)
            saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
            retained = (saved.get("accountErasure") or {}).get(stage)
            return bool(
                observed
                and observed.get("status") == "suspended"
                and saved.get("ownerId") == user_id
                and saved.get("attemptId") == attempt
                and retained == receipt
            )

        def checkpoint(stage: str, raw: dict) -> bool:
            return asyncio.run_coroutine_threadsafe(append(stage, raw), loop).result(timeout=30)

        def unbind(receipt: dict) -> dict:
            if (
                not isinstance(receipt, dict)
                or receipt.get("ownerId") != user_id
                or receipt.get("attemptId") != attempt
            ):
                raise RuntimeError("runtime account recovery owner unverified")
            return {
                key: value for key, value in receipt.items() if key not in {"ownerId", "attemptId"}
            }

        states = {
            stage: unbind(receipt)
            for stage, receipt in (reservation.get("accountErasure") or {}).items()
        }
        await erase(
            action={**planned[0], "resourceObservation": captured[0]},
            state=states,
            retain_receipt=checkpoint,
        )

    async def _erase_reserved_runtime_grant(self, *, user_id: str) -> None:
        from hushh_mcp.runtime_settings import personal_agent_substrate_teardown_enabled

        if not personal_agent_substrate_teardown_enabled():
            raise RuntimeError("runtime grant erasure guarded")
        current = await self._registry.get(user_id)
        reservation = ((current or {}).get("backend_metadata") or {}).get("erasure") or {}
        snapshot = reservation.get("registrySnapshot") or {}
        reserve = getattr(self._registry, "reserve_erasure_grant_release", None)
        retain = getattr(self._registry, "retain_erasure_runtime_grant_receipt", None)
        if (
            not current
            or current.get("status") != "suspended"
            or reservation.get("ownerId") != user_id
            or snapshot.get("user_id") != user_id
            or reserve is None
            or retain is None
            or not await reserve(user_id=user_id, reservation=reservation)
        ):
            raise RuntimeError("runtime grant erasure reservation unavailable")
        current = await self._registry.get(user_id)
        saved = ((current or {}).get("backend_metadata") or {}).get("erasure") or {}
        attempt = reservation["attemptId"]
        if (
            not current
            or current.get("status") != "suspended"
            or saved.get("ownerId") != user_id
            or saved.get("attemptId") != attempt
            or saved.get("registrySnapshot") != snapshot
            or saved.get("grantRelease")
            != {
                "ownerId": user_id,
                "attemptId": attempt,
                "project": snapshot.get("user_cloud_project"),
                "status": "reserved",
            }
        ):
            raise RuntimeError("runtime grant reservation readback unconfirmed")
        inventory = saved.get("substrateInventory") or {}
        identity = (saved.get("writerDisabled") or {}).get("runtimeIdentity") or {}
        bindings = [
            b
            for b in inventory.get("bindingObservations", [])
            if isinstance(b, dict)
            and b.get("step") == "iam_pod_sa_vertex"
            and b.get("member") == f"serviceAccount:{identity.get('email')}"
        ]
        if len(bindings) != 1:
            raise RuntimeError("runtime grant provenance unresolved")
        evidence = {"runtimeIdentity": identity, "bindingObservation": bindings[0]}
        erase = getattr(self._reserved_cleanup_backend(snapshot), "erase_runtime_grant", None)
        if erase is None:
            raise RuntimeError("runtime grant erasure unsupported")
        loop = asyncio.get_running_loop()

        async def append(stage: str, raw: dict) -> bool:
            observed = await self._registry.get(user_id)
            state = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
            if (
                not observed
                or observed.get("status") != "suspended"
                or state.get("ownerId") != user_id
                or state.get("attemptId") != attempt
                or state.get("registrySnapshot") != snapshot
                or state.get("substrateInventory") != inventory
            ):
                return False
            receipt = {**raw, "ownerId": user_id, "attemptId": attempt}
            if not await retain(user_id=user_id, reservation=state, stage=stage, receipt=receipt):
                return False
            observed = await self._registry.get(user_id)
            state = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
            return bool(
                observed
                and observed.get("status") == "suspended"
                and state.get("ownerId") == user_id
                and state.get("attemptId") == attempt
                and (state.get("runtimeGrantErasure") or {}).get(stage) == receipt
            )

        def checkpoint(stage: str, raw: dict) -> bool:
            return asyncio.run_coroutine_threadsafe(append(stage, raw), loop).result(timeout=30)

        states = {}
        for stage, receipt in (saved.get("runtimeGrantErasure") or {}).items():
            if (
                not isinstance(receipt, dict)
                or receipt.get("ownerId") != user_id
                or receipt.get("attemptId") != attempt
            ):
                raise RuntimeError("runtime grant recovery owner unverified")
            states[stage] = {k: v for k, v in receipt.items() if k not in {"ownerId", "attemptId"}}
        await erase(evidence=evidence, state=states, retain_receipt=checkpoint)

    async def deprovision(
        self,
        *,
        user_id: str,
        ledger: Any = None,
        revoke: bool = True,
        defer_row_delete: bool = False,
    ) -> dict[str, Any]:
        """Reconcile qualified memory and compute erasure while retaining recovery resources.

        The existing account guard owns retained-resource classification. Retained
        registry resources are reserved for erasure; teardown still reports incomplete.
        A successful empty-state observation performs no mutation after its locks
        are released, so concurrent provisioning cannot be deleted by this call.
        Legacy keyword arguments remain accepted for call compatibility.
        """
        from hushh_mcp.services.account_service import AccountService  # noqa: PLC0415

        if not user_id:
            raise ValueError("user_id is required")
        from hushh_mcp.services.account_service import PersonalAgentDeprovisioningRequiredError

        try:
            await asyncio.to_thread(
                AccountService().assert_personal_agent_external_resources_absent, user_id
            )
        except PersonalAgentDeprovisioningRequiredError:
            reserve = getattr(self._registry, "reserve_erasure", None)
            if reserve is not None:
                try:
                    reservation = await reserve(user_id=user_id)
                    if not isinstance(reservation, dict):
                        raise RuntimeError("erasure reservation unavailable")
                    if not (reservation.get("accountErasure") or {}).get("admission"):
                        if not reservation.get("computeAdmission"):
                            qualified = await self._fence_reserved_erasure(
                                user_id=user_id, reservation=reservation
                            )
                            await self._erase_reserved_memory(user_id=user_id, qualified=qualified)
                        await self._erase_reserved_compute(user_id=user_id)
                        await self._retain_reserved_substrate_inventory(user_id=user_id)
                        await self._revoke_reserved_runtime_writer(user_id=user_id)
                        await self._erase_reserved_mail_resources(user_id=user_id)
                        await self._erase_reserved_bucket(user_id=user_id)
                        await self._erase_reserved_kms_material(user_id=user_id)
                        await self._erase_reserved_signing_secret(user_id=user_id)
                    await self._erase_reserved_runtime_account(user_id=user_id)
                    await self._erase_reserved_runtime_grant(user_id=user_id)
                except Exception as exc:
                    logger.warning(
                        "personal_agent.erasure_admission_unavailable error_type=%s",
                        type(exc).__name__,
                    )
            # Reserved, unavailable, and absent-registry cases all remain incomplete.
            # Storage, keys, grants, and owner identity still require verified cleanup.
            raise
        return {
            "status": "unprovisioned",
            "noOp": True,
            "standingReadRevoked": False,
            "teardownReachedHost": False,
            "rowDeleteDeferred": False,
        }

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

    async def _next_free_generation(self, phone_e164: str, *, user_id: str = "") -> int:
        """First HusshID generation for this phone that no one else already holds.

        A fresh phone returns 0. A recycled phone rotates forward, so a reassigned
        number never re-derives (and thus never resurrects) a prior owner's HusshID
        or A2A address.

        TWO things disqualify a generation, and the second was missing.

        A deletion **tombstone** is the intended marker, and it is the only one this
        checked. But a tombstone only exists when the prior agent was torn down
        properly. Measured live 2026-09-04: an account deleted from Firebase on
        2026-08-20 left its `personal_agent_registry` row `provisioned` and its pod
        still beating, with no tombstone -- so a new person who verified that same
        phone re-derived the surviving owner's HusshID, the pending INSERT hit
        `idx_personal_agent_registry_hushh_id`, and the fire-and-forget provisioning
        died there. The API had already answered `agentScheduled: true`, so the
        person's cloud was authorized and no pod was ever built, silently. That was
        a real demo failure, not a hypothetical.

        So a generation is also disqualified when the registry ALREADY HOLDS that
        HusshID for a DIFFERENT user. Same owner is not a collision -- that is this
        person's own row and provisioning is idempotent over it.
        """
        owner = str(user_id or "").strip()
        for generation in range(_MAX_HUSHH_ID_GENERATIONS):
            candidate = mint_hushh_id(phone_e164, generation)
            if await self._registry.tombstone_exists(candidate):
                continue
            lookup = getattr(self._registry, "get_by_hushh_id", None)
            if lookup is None:
                return generation  # repo cannot answer; tombstones are the only guard
            held = await lookup(candidate)
            if held and str(held.get("user_id") or "").strip() != owner:
                logger.warning(
                    "personal_agent.hushh_id_taken generation=%s held_by=%s rotating",
                    generation,
                    str(held.get("user_id") or "")[:8],
                )
                continue
            return generation
        raise ValueError("exhausted HusshID generations for this phone")

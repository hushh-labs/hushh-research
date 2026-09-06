"""Owner-authorized provisioning for a user's own personal agent.

Every action requires the owner's VAULT_OWNER token, so only the person
themselves can stand up or tear down their own agent. Auth is resolved before the
kill-switch check, so an unauthenticated caller gets 401 regardless of the flag;
once authenticated, the surface returns 404 while ``PERSONAL_AGENT_ENABLED`` is
off. The handlers are thin; the real work lives in the provisioning service and
registry.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth, require_vault_owner_token
from hushh_mcp.runtime_settings import personal_agent_enabled
from hushh_mcp.services.account_service import (
    PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
    PersonalAgentDeprovisioningRequiredError,
)
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.compute_backend import resolve_compute_backend
from hushh_mcp.services.personal_agent_provisioning_service import (
    UPGRADE_ATTEMPTS_PER_IMAGE,
    PersonalAgentProvisioningService,
    _lease_is_fresh,
)
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from hushh_mcp.services.pod_connector_keypair_service import WRAPPING_ALG

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/personal-agent", tags=["personal-agent"])


class ProvisionRequest(BaseModel):
    """What a caller may supply when asking for their own agent.

    Both key fields are OPTIONAL, and that is the point: a pod generates its X25519
    keypair inside its own runtime and publishes only the public half, so a browser
    has no pod public key and structurally cannot have one before the pod exists.

    Declaring them required made this route uncallable from the product. The service
    has always implemented the deferred-key path -- it provisions the host, parks the
    row in `connecting`, and `collect_pod_key_if_pending` completes the handshake on
    the same status poll the UI is already doing -- but no route could express it. So
    the only way a pod could ever come into existence was a fire-and-forget hook off
    phone verification whose exceptions are swallowed. That is why dev has every flag
    on and zero pods.

    A HALF-supplied pair is still rejected, by the service rather than here
    (`personal_agent_provisioning_service.py`): "no key yet" and "a key the caller
    believed it handed over" are different, and reading the second as the first would
    silently drop it.
    """

    pod_public_key: str | None = Field(
        default=None, alias="podPublicKey", min_length=1, max_length=256
    )
    pod_key_id: str | None = Field(default=None, alias="podKeyId", min_length=1, max_length=128)
    pod_key_wrapping_alg: str = Field(
        default=WRAPPING_ALG,
        alias="podKeyWrappingAlg",
        max_length=64,  # gitleaks:allow -- algorithm label, not key material
    )

    model_config = ConfigDict(populate_by_name=True)


def _require_enabled() -> None:
    if not personal_agent_enabled():
        raise HTTPException(status_code=404, detail="personal agent is not available")


def _service() -> PersonalAgentProvisioningService:
    # backend from PERSONAL_AGENT_BACKEND (default unset -> inert NullBackend).
    return PersonalAgentProvisioningService(
        registry=PersonalAgentRegistryRepo(), backend=resolve_compute_backend()
    )


# ``personal_agent_registry.status`` -> the ``state`` this endpoint reports.
#
# The left column is the real vocabulary of that column, taken from the code that
# WRITES it rather than from any design note. Four values have a writer today:
#
#   unprovisioned  schema DEFAULT (db/migrations/parked/900_personal_agent_registry.sql)
#   pending        PersonalAgentProvisioningService.register_pending, off phone-verify
#   provisioning   PersonalAgentProvisioningService.provision, around the backend call
#   provisioned    PersonalAgentProvisioningService.provision, after the standing mint
#
# ``connecting`` and ``provisioning_failed`` are declared here AHEAD of their
# writer. Nothing emits them yet -- the live compute backend and the reconcile
# sweep that will (DEV-LIVE-EXECUTION-PLAN.md, Workstreams B and C) are unbuilt, so
# today those two rows are unreachable. They are declared anyway because this map
# is the read-side contract: with them present the write side lands without a
# second edit here and without any client change. Keeping the two halves of that
# seam in one file is the point.
#
# ``deprovision_requested`` is deliberately absent: it is written to
# ``personal_agent_deletion_tombstones.status``, never to the registry.
_STATE_BY_REGISTRY_STATUS: dict[str, str] = {
    "unprovisioned": "reserved",
    "pending": "reserved",
    "provisioning": "provisioning",
    "connecting": "connecting",
    "provisioned": "active",
    "provisioning_failed": "failed",
    # The recorded host is CONFIRMED gone (the user deleted the project/service).
    # Renders as `failed` so the presence chip shows its recovery affordance; the
    # shared recovery classifier then routes it to "reconnect your cloud" (reinit)
    # rather than a rebuild into a project that no longer exists. Distinct from
    # `provisioning_failed` on the row so the reconcile sweep never retries it.
    "needs_reinit": "failed",
    # A reaped agent's identity survives its host: the HusshID is retained and a
    # new host can be earned again, which is exactly what `reserved` means to a
    # client. Without this entry a reaped row fell to the default -- also
    # `reserved` -- but by ACCIDENT, and the vocabulary guard could not tell the
    # mapped case from the forgotten one. No writer sets `reaped` yet (the reap
    # sweep is deliberately inert); the mapping exists so the first writer does
    # not ship a status every client renders by fallback.
    "reaped": "reserved",
}

# Every unmapped status degrades to this. A raw DB value is NEVER echoed to the
# caller: an unrecognised status is a backend detail, and leaking it would make a
# client's own state handling a function of our schema.
_DEFAULT_STATE = "reserved"

# ``personal_agent_registry.health_state`` (migration 905) -> the ``health`` this
# endpoint reports, and it is deliberately a SEPARATE field from ``state`` above.
#
# The two answer different questions. ``state`` is where the agent is in its
# lifecycle: reserved, provisioning, active. ``health`` is whether the pod behind an
# already-active agent is answering right now. Collapsing them into one enum would
# destroy information in both directions -- "provisioned but unreachable" would be
# indistinguishable from "still provisioning" (one is a fault, the other is normal
# progress), and a client could no longer tell "your agent exists and is broken"
# from "your agent does not exist yet".
#
# ``sleeping`` is a first-class value, not a synonym for degraded. An economy-tier
# pod that has scaled to zero is working exactly as designed, and telling its owner
# it is unhealthy would be false. The honest sentence is "asleep, wakes when you
# need it".
_HEALTH_BY_REGISTRY_HEALTH_STATE: dict[str, str] = {
    "healthy": "healthy",
    "degraded": "degraded",
    "unreachable": "unreachable",
    "sleeping": "sleeping",
}

# Lifecycle states for which a pod actually exists, so health is a meaningful
# question. Asking whether a `reserved` agent is reachable is a category error --
# there is no host yet to be reachable or not.
_STATES_WITH_A_HOST = ("active", "connecting")

# How long a journey may run before the handshake is called overdue. Provisioning a
# Cloud Run service and waiting for the pod to boot and push its key is a ~150s
# operation on a cold economy pod, so this is deliberately well past the slow end of
# healthy rather than a tight SLO -- a warning that fires during normal onboarding
# teaches operators to ignore it, which is worse than not logging at all.
_HANDSHAKE_OVERDUE_SECONDS = 600

# Hard ceiling on how much of an exception's text reaches a log line. These are
# infrastructure errors (HTTP status, connection refused, timeout), not holdings --
# but a bound is kept because nothing guarantees a future exception type keeps it
# that way, and an unbounded str() is how a payload ends up in a log.
_DIAGNOSTIC_DETAIL_MAX = 200


def _diagnostic_detail(exc: BaseException) -> str:
    """A bounded, single-line rendering of why something failed.

    The exception CLASS alone is not a diagnosis: `ClientResponseError` names neither
    the status nor the URL, and that was the entire content of the log line covering
    the most important failure in the onboarding journey.
    """
    text = " ".join(str(exc).split())
    if not text:
        return "<no detail>"
    return text[:_DIAGNOSTIC_DETAIL_MAX]


def _warn_if_handshake_is_overdue(row: Optional[dict], status: str) -> None:
    """Say so when a row has been waiting on its pod for longer than it should.

    Observation only -- it writes nothing. That no-mutation property is a security
    invariant of this route (a pure reader the browser polls), which is why the
    escalation is deliberately NOT driven from here: this 600s warning is the EARLY
    signal, and the reconcile sweep marks the row ``provisioning_failed`` after
    1800s of time-in-connecting (``_connecting_failed_after_seconds``, server.py).

    Age is measured from ``created_at`` -- the age of the whole journey, named that
    way. (``updated_at`` IS stamped by the repo on every transition, so the sweep
    uses it for time-in-state; this early warning keeps the journey-age framing.)
    """
    if status != "connecting" or not row:
        return
    created_raw = str(row.get("created_at") or "").strip()
    if not created_raw:
        return
    try:
        created = datetime.fromisoformat(created_raw.replace("Z", "+00:00"))
    except ValueError:
        return
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    age_seconds = (datetime.now(timezone.utc) - created).total_seconds()
    if age_seconds < _HANDSHAKE_OVERDUE_SECONDS:
        return
    logger.warning(
        "personal_agent.handshake_overdue hushh_id=%s service=%s journey_age_seconds=%d "
        "-- the host exists but the pod has not published its public key. Check the pod's "
        "own logs (`pod.startup`, `pod.key_push_*`) and that HUSSH_POD_INVOKER_MEMBER is "
        "set, or the hub is not permitted to call it.",
        row.get("hushh_id") or "<none>",
        row.get("external_agent_id") or "<none>",
        int(age_seconds),
    )


def _image_tag(reference: object) -> Optional[str]:
    """The comparable tag of an image reference; a bare tag is returned as itself."""
    text = str(reference or "").strip()
    if not text:
        return None
    tail = text.rsplit("/", 1)[-1].split("@", 1)[0]
    if ":" not in tail:
        return None if "/" in text else tail
    return tail.split(":", 1)[1] or None


def describe_pod_update(row: Optional[dict], *, target_image: Optional[str] = None) -> dict:
    """What the pod runs, what the hub wants, and whether the two differ.

    The founder's rule for an upgrade is "a software update when the person opens
    the app", and a software update starts with knowing the installed version. The
    row already carries it, so this is zero new I/O on a status read.

    Tri-state like ``hostReady``: a field is ABSENT when its evidence is absent,
    never coerced to False. No lane target (a hub that does not build pods) means
    no `targetImage` and no `updateAvailable`; a row with nothing recorded means no
    `runningImage`. ``updateAvailable: false`` is a positive statement that the pod
    is current, and only made when both sides are known.

    Tag equality, not digest equality: the person's copy is a digest in their own
    registry while the hub's target is a tag, so the honest comparison is the tag
    the image was built from (the target is already a build SHA, `dev-<sha>`).

    The running tag is the pod's OWN report (``backend_metadata.observed.imageTag``,
    posted on its heartbeat) when there is one, and the deployed record
    (``source_image``) when there is not. They live under separate keys so a pod
    whose process runs older code than its row claims is visible as drift rather
    than papered over; drift is logged loudly and the pod's word wins, because it
    is the only signal that says what is running rather than what was deployed.
    """
    metadata = (row or {}).get("backend_metadata")
    if not isinstance(metadata, dict):
        return {}
    observed = metadata.get("observed")
    observed_tag = _image_tag(observed.get("imageTag")) if isinstance(observed, dict) else None
    # Both keys, because the two tiers spell it differently and only one was read.
    # `running_image()` documents the model: `source_image` on a user-owned pod, `image`
    # on a hussh-hosted one -- GcpBackend writes only `image`. So every hosted pod
    # resolved deployed_tag=None, and with no `observed` (a bodyless heartbeat deletes
    # it) the whole block returned early: no runningImage, no updateAvailable, and no
    # updateFailed even after the sweep burned all three attempts. The person's login
    # surface said nothing at all while their agent silently failed to update.
    deployed_tag = _image_tag(metadata.get("source_image") or metadata.get("image"))
    running = observed_tag or deployed_tag
    if observed_tag and deployed_tag and observed_tag != deployed_tag:
        logger.warning(
            "personal_agent.image_drift hushh_id=%s observed=%s deployed=%s",
            (row or {}).get("hushh_id"),
            observed_tag,
            deployed_tag,
        )
    target = _image_tag(
        target_image if target_image is not None else os.getenv("HUSSH_ONE_POD_IMAGE")
    )
    out: dict = {}
    if running:
        out["runningImage"] = running
    if target:
        out["targetImage"] = target
    # The lease is the in-flight signal: it is taken before the copy starts and
    # cleared when the outcome is recorded, so "fresh lease" is "being updated now".
    if _lease_is_fresh(metadata.get("upgradeLease")):
        out["updateInProgress"] = True
    if not (running and target):
        return out
    out["updateAvailable"] = running != target
    marker = metadata.get("upgrade")
    if (
        isinstance(marker, dict)
        and _image_tag(marker.get("failedImage")) == target
        and int(marker.get("attempts") or 0) >= UPGRADE_ATTEMPTS_PER_IMAGE
    ):
        # Three failures on this image: the sweep has stopped trying, and a person
        # whose agent silently never updates deserves the one line that says why.
        out["updateFailed"] = True
        last_error = str(marker.get("lastError") or "").strip()
        if last_error:
            out["updateError"] = last_error[:200]
    return out


async def resolve_personal_agent_status(
    *,
    user_id: str,
    registry: Optional[PersonalAgentRegistryRepo] = None,
) -> dict:
    """The caller's own personal-agent state — honest even while the feature is off.

    Deliberately NOT flag-gated and never 404: an Apple-grade product meets the
    customer honestly rather than in silence. Reads only the user's OWN row.

    ``state`` is one of ``reserved | provisioning | connecting | active | failed``,
    mapped from ``personal_agent_registry.status`` by
    :data:`_STATE_BY_REGISTRY_STATUS` (see that map for which of those the backend
    can actually produce today). ``reserved`` is both a real state — their sovereign
    agent identity is reserved and ready to activate — and the fail-safe: a registry
    read error, a missing row, and a status this build does not recognise all report
    ``reserved`` rather than an error or a raw DB value. That is deliberate. The home
    must never break, and it must never over-claim.
    """
    repo = registry or PersonalAgentRegistryRepo()
    row = None
    try:
        row = await repo.get(user_id)
    except Exception as exc:  # fail safe: never break the home on a registry hiccup
        logger.warning(
            "personal_agent.status_read_failed err=%s detail=%s",
            type(exc).__name__,
            _diagnostic_detail(exc),
        )

    status = str((row or {}).get("status") or "").strip()

    # This GET is now a PURE READER, and that is a security property, not tidiness.
    # It used to call `collect_pod_key_if_pending` here, which on a `connecting`
    # row performed an ID-token fetch, a 5s pod GET, two registry writes, a
    # 24-hour standing `pkm.read` HCT mint with a visible consent_audit event,
    # and a feed insert -- per poll, per open tab, every 6 seconds. A status read
    # must not mint consent authority, and a lifecycle stream polling this shape
    # would have multiplied the writes by every open segment.
    #
    # Where the handshake lives instead: the pod's own first heartbeat
    # (`pod_heartbeat.py`, the primary writer, already inline for the CPU-throttle
    # reason documented there) and the reconcile worker's key-collection fallback
    # for rows a heartbeat never reached. A row stuck in `connecting` is now the
    # reconcile pass's problem on a 300s cadence, not the browser's on a 6s one.

    # Nothing else in the system watches a row parked in `connecting`. The retry sweep
    # deliberately excludes it (re-provisioning would replace a running service --
    # personal_agent_registry_repo.fetch_stalled_agents), which leaves its stall "owned
    # by the pod's startup key push". If that push never lands, the row sits here
    # forever, the person watches a spinner, and NOTHING reports a fault.
    #
    # This poll is the natural place to notice: it is what the browser calls while the
    # person waits, it already holds the row, and it costs one comparison. It only
    # OBSERVES -- it must never mutate a row whose host is live.
    _warn_if_handshake_is_overdue(row, status)

    # No row at all is a DIFFERENT truth from an unrecognised status: nothing
    # was ever started for this person. Reporting it as "reserved" claimed the
    # positive ("ready to activate") for an absence (audit finding, 2026-08-21).
    # A read failure above leaves row=None too, and "none" stays the honest
    # degraded answer there as well: claim nothing you did not read.
    state = "none" if row is None else _STATE_BY_REGISTRY_STATUS.get(status, _DEFAULT_STATE)
    result: dict = {"state": state, "featureEnabled": personal_agent_enabled()}
    hushh_id = (row or {}).get("hushh_id")
    if hushh_id:
        result["hushhId"] = hushh_id

    # WHERE the agent lives and AS WHOM it reaches its model -- the pod's public
    # identity, which the interface previously never showed anywhere (founder
    # finding, 2026-08-21: "the pod is not integrated end to end in the
    # interface"). Coordinates only, present only when recorded on the row:
    # project and region are the person's OWN, and `user_adc` is the fact that
    # their project's own Vertex identity serves their agent.
    cloud_project = str((row or {}).get("user_cloud_project") or "").strip()
    if cloud_project:
        result["cloudProject"] = cloud_project
        cloud_region = str((row or {}).get("user_cloud_region") or "").strip()
        if cloud_region:
            result["cloudRegion"] = cloud_region
    deployment_target = str((row or {}).get("deployment_target") or "").strip()
    if deployment_target:
        result["deploymentTarget"] = deployment_target
    credential_mode = str((row or {}).get("model_credential_mode") or "").strip()
    if credential_mode:
        result["credentialMode"] = credential_mode

    # Health is reported ONLY when there is a host to have health and the liveness
    # sweep has actually reached a verdict. `unknown` (the column default, and the
    # state of every row until the sweep is switched on) is deliberately omitted
    # rather than sent as "unknown" or defaulted to "healthy":
    #
    #   * defaulting to healthy would be a claim we cannot support -- the same class
    #     of lie as a 200 on an empty page, and the exact failure this whole
    #     workstream exists to stop;
    #   * shipping "unknown" would put a word on screen that no client can act on,
    #     and would make an un-swept fleet look degraded when nothing is wrong.
    #
    # Absent means absent. A client renders health when it is there and says nothing
    # when it is not, which is the truthful reading in both cases.
    if state in _STATES_WITH_A_HOST:
        health = _HEALTH_BY_REGISTRY_HEALTH_STATE.get(
            str((row or {}).get("health_state") or "").strip()
        )
        if health:
            result["health"] = health
            # Only alongside a real verdict: a timestamp on its own invites a client
            # to compute its own staleness rule, which is precisely the tier-aware
            # judgment that must not be re-derived per caller.
            last_seen = (row or {}).get("last_heartbeat_at")
            if last_seen:
                result["lastSeenAt"] = str(last_seen)

    # The readiness verdict was already durable and simply never read. `wait_ready`
    # writes its answer into `backend_metadata.ready` (gcp_backend renders it,
    # provisioning persists it), so "the host was created but never became ready" has
    # been knowable on the row all along while every client had to infer it from a
    # state that does not distinguish the two. Surfaced as a FIELD rather than
    # promoted to a lifecycle state: a new state costs a branch in every consumer of
    # the state union to say something one boolean says for free.
    #
    # Tri-state on purpose. Absent means the backend never recorded a verdict, which
    # is different from recording False. Coercing the two together would turn "we do
    # not know yet" into "it failed", which is the same over-claim `health` goes out
    # of its way above not to make.
    metadata = (row or {}).get("backend_metadata")
    if isinstance(metadata, dict) and metadata.get("ready") is not None:
        result["hostReady"] = bool(metadata.get("ready"))

    # The installed-version half of "an upgrade is a software update at login".
    # Only meaningful once there is a serving pod to be behind.
    if result.get("state") == "active":
        result.update(describe_pod_update(row))

    # A `reason` field belongs here too -- `reserved` covers both "your identity is
    # held, nothing is building yet" and "we are at capacity, your place is queued",
    # and those want different sentences on screen. It is NOT added yet: migration 900
    # has no `status_reason` column, so the code would be a branch that can never
    # fire, which is the defect class this pass exists to remove rather than add. It
    # arrives with the column, in the phase that is allowed to touch schema.

    return result


@router.get("/status")
async def personal_agent_status_route(
    user_id: str = Depends(require_firebase_auth),
) -> dict:
    """The caller's own personal-agent state. Thin shell over the testable core."""
    return await resolve_personal_agent_status(user_id=user_id)


@router.post("/provision")
async def provision_personal_agent(
    # Defaulted, not required: every field on ProvisionRequest is now optional, so an
    # owner asking for an agent has nothing they are obliged to send. Requiring a body
    # to carry no information is a 422 for punctuation.
    payload: ProvisionRequest = Body(default_factory=ProvisionRequest),
    token_data: dict = Depends(require_vault_owner_token),
):
    """Stand up the caller's own agent. Requires the owner's VAULT_OWNER token."""
    _require_enabled()
    user_id = token_data["user_id"]

    identity = (await ActorIdentityService().get_many([user_id])).get(user_id)
    if not identity or identity.get("phone_verified") is not True:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "PHONE_NOT_VERIFIED",
                "message": "A verified phone is required to provision the agent.",
            },
        )
    phone = str(identity.get("phone_number") or "").strip()
    if not phone:
        raise HTTPException(
            status_code=409,
            detail={"code": "PHONE_NOT_VERIFIED", "message": "A verified phone is required."},
        )

    try:
        result = await _service().provision(
            user_id=user_id,
            phone_e164=phone,
            pod_public_key_b64=payload.pod_public_key,
            pod_key_id=payload.pod_key_id,
            pod_key_wrapping_alg=payload.pod_key_wrapping_alg,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_PROVISION_INPUT", "message": str(exc)},
        ) from exc

    return {"success": True, **result}


@router.post("/adopt")
async def adopt_personal_agent(
    user_id: str = Depends(require_firebase_auth),
):
    """Reconnect the caller to a pod that ALREADY exists in their own project.

    Owner-authenticated but NOT vault-gated, unlike ``/provision``: adoption can only
    RESTORE a lost row to a pod that is already running, never mint a new identity or
    create compute, so it needs no vault-owner token. Returns ``{adopted: false}`` when
    there is nothing to adopt (no orphan pod, or no BYOC cloud recorded) -- the caller
    then falls through to reinit or rebuild. The recovery classifier tries this FIRST,
    because reconnecting preserves the agent's identity and memory.
    """
    _require_enabled()
    result = await _service().adopt_orphan(user_id=user_id)
    if not result:
        return {"adopted": False}
    return {"adopted": True, **result}


@router.post("/deprovision")
async def deprovision_personal_agent(
    token_data: dict = Depends(require_vault_owner_token),
):
    """Tear down the caller's own agent. Requires the owner's VAULT_OWNER token."""
    _require_enabled()
    user_id = token_data["user_id"]
    try:
        result = await _service().deprovision(user_id=user_id)
    except PersonalAgentDeprovisioningRequiredError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
                "message": "Private-agent erasure is incomplete. Recovery resources have been preserved.",
            },
        ) from exc
    return {"success": True, **result}


class SpaceNameRequest(BaseModel):
    """The owner's chosen handle for their space."""

    model_config = ConfigDict(populate_by_name=True)
    space_name: str = Field(..., alias="spaceName", min_length=1, max_length=48)


@router.get("/space-name")
async def get_space_name(
    user_id: str = Depends(require_firebase_auth),
) -> dict:
    """The owner's chosen spaceID handle, or null if they have not named it.

    The handle is `personal_agent_registry.space_id` -- user-facing, distinct from
    the opaque `billing_space_id` that carries cost. Owner-authenticated; a person
    can only read their own.
    """
    _require_enabled()
    row = await PersonalAgentRegistryRepo().get(user_id)
    return {"spaceName": (row or {}).get("space_id")}


@router.put("/space-name")
async def set_space_name(
    payload: SpaceNameRequest = Body(...),
    user_id: str = Depends(require_firebase_auth),
) -> dict:
    """Name (or rename) the caller's own space.

    This is the ONLY write path for the spaceID handle. Provisioning never sets it,
    so a machine-minted token can never land where a human name goes. Owner-
    authenticated on the row key; validated so a name that cannot be safely stored
    or shown is refused rather than persisted.

    A row must already exist (the person has begun provisioning): naming a space
    that was never reserved is a 409, not a silent create, because the handle is an
    attribute of an agent, not a way to summon one.
    """
    _require_enabled()
    from hushh_mcp.services.personal_agent_identity_service import is_valid_space_handle

    name = payload.space_name.strip()
    ok, reason = is_valid_space_handle(name)
    if not ok:
        raise HTTPException(
            status_code=400, detail={"code": "INVALID_SPACE_NAME", "message": reason}
        )

    repo = PersonalAgentRegistryRepo()
    row = await repo.get(user_id)
    if not row:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "NO_AGENT",
                "message": "Name your space after your agent exists; there is nothing to name yet.",
            },
        )
    await repo.upsert(
        user_id=user_id,
        hushh_id=str(row.get("hushh_id") or ""),
        status=str(row.get("status") or ""),
        space_id=name,
    )
    return {"success": True, "spaceName": name}

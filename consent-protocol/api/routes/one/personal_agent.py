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
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth, require_vault_owner_token
from hushh_mcp.runtime_settings import personal_agent_enabled
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.compute_backend import resolve_compute_backend
from hushh_mcp.services.personal_agent_provisioning_service import (
    PersonalAgentProvisioningService,
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

    Observation only -- it writes nothing. `connecting` means the host EXISTS and is
    mid-handshake, so anything that mutated the row here risks replacing a running
    service, which is exactly why the retry sweep leaves this state alone.

    Age is measured from ``created_at``. The repo never writes ``updated_at`` and the
    column has no ON UPDATE trigger, so it equals ``created_at`` and would measure the
    same thing while implying it measured something better. This is therefore the age
    of the whole journey, not time-in-state, and is named that way.
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


@router.post("/deprovision")
async def deprovision_personal_agent(
    token_data: dict = Depends(require_vault_owner_token),
):
    """Tear down the caller's own agent. Requires the owner's VAULT_OWNER token."""
    _require_enabled()
    user_id = token_data["user_id"]
    result = await _service().deprovision(user_id=user_id)
    return {"success": True, **result}

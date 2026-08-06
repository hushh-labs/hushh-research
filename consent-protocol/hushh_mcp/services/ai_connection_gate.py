"""What actually earns a person a pod: a working AI connection, not a login.

Provisioning used to fire off phone verification
(``actor_identity_service._claim_phone``). That put a billable Cloud Run service
behind an event that says nothing about whether the agent could ever run: a user
who verifies a phone and then never connects a model gets a pod that boots, warms,
heartbeats, and answers nothing, forever, at full price. Multiply that by every
signup and the fleet is mostly agents that cannot think.

The founder's rule, and it is the right one: **do not deploy a user's agents when
they log in.** Validate the AI connection first. Only once a key has actually
answered a real generation request does provisioning begin. Until then a person has
a reserved identity and no host -- which costs nothing and loses nothing, because
the HusshID is minted from their phone hash and is recoverable at any point.

That inverts the failure mode too. Before, a broken key produced a live, expensive,
useless pod. Now it produces an honest "your AI connection is not working yet",
which is a sentence a person can act on.

Idempotence is the whole safety property
----------------------------------------
``/api/one/runtime/gemini/validate`` is a pre-save probe: the UI may call it on
every keystroke-settle, every retry, every revisit of the connections screen. If
each success scheduled a provision, one user tapping "test" four times would race
four provisions. So this checks the registry first and does nothing when a host
already exists or is being stood up. The check is a read, not a lock -- the
underlying ``provision()`` is idempotent by user (``upsert``) and the in-flight
task dedupe in ``schedule_provision_personal_agent`` closes the rest.

Nothing here can fail a validation. A person testing their API key must never see
an error because a pod could not be scheduled; those are unrelated concerns and
only one of them is what they asked about.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Registry statuses meaning a host exists or is being created. Matches
# ``personal_agent_registry_repo._ACTIVE_POD_STATUSES`` -- deliberately including
# ``provisioning``, because a row mid-flight may already own a billable service and
# scheduling a second one is exactly the race this guard exists to prevent.
_ALREADY_HAS_A_HOST = ("provisioning", "connecting", "provisioned")


async def on_ai_connection_verified(
    *,
    user_id: str,
    provider: str,
    transport: str = "",
    registry: Any = None,
    identity: Any = None,
    scheduler: Any = None,
) -> dict:
    """A user's AI connection just proved it works. Start their agent if it is time.

    Returns a small verdict dict for logging and for the route to surface. Never
    raises -- every failure path degrades to ``scheduled: False`` with a reason,
    because the caller is a credential-validation endpoint and a person testing
    their key must not be shown a provisioning error.
    """
    normalized = str(user_id or "").strip()
    if not normalized:
        return {"scheduled": False, "reason": "no user"}

    try:
        from hushh_mcp.runtime_settings import (  # noqa: PLC0415
            personal_agent_enabled,
            provision_on_ai_connection,
        )

        if not personal_agent_enabled():
            return {"scheduled": False, "reason": "personal agent is off"}
        if not provision_on_ai_connection():
            return {"scheduled": False, "reason": "ai-connection trigger is off"}
        if not _pod_can_serve(provider):
            # NOT a new flag, deliberately. `pod_managed_model_enabled` already
            # decides whether a pod may serve a turn on the fleet's model
            # (`pod_turn._resolve_runtime_mode`). Reading that same setting here is
            # what makes "a pod exists but 400s every turn" unrepresentable: the one
            # switch governs both halves, so they cannot drift apart.
            #
            # A managed user is not stranded by this -- they keep the hub-served
            # experience. What they do not get is a billable host that refuses every
            # request, which is strictly worse than no host at all.
            return {"scheduled": False, "reason": "pod cannot serve this connection mode"}

        repo = registry
        if repo is None:
            from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
                PersonalAgentRegistryRepo,
            )

            repo = PersonalAgentRegistryRepo()

        row = await repo.get(normalized)
        status = str((row or {}).get("status") or "").strip()
        if status in _ALREADY_HAS_A_HOST:
            # The common case on a re-validate. Not an error, and not worth a
            # warning -- the UI probes this endpoint freely by design.
            return {"scheduled": False, "reason": f"host already {status}"}

        # The phone is read SERVER-SIDE from the verified identity, never from the
        # request. A caller must not be able to name the phone their agent is
        # minted from -- that is the HusshID's whole basis, and accepting it from a
        # client would let one person mint an agent against another's number.
        actor = identity
        if actor is None:
            from hushh_mcp.services.actor_identity_service import (  # noqa: PLC0415
                ActorIdentityService,
            )

            actor = ActorIdentityService()

        phone = await _verified_phone(actor, normalized)
        if not phone:
            # A real state, not a fault: the person connected a model before
            # verifying a phone. Their agent waits for the phone step.
            return {"scheduled": False, "reason": "no verified phone yet"}

        schedule = scheduler
        if schedule is None:
            schedule = actor.schedule_provision_personal_agent

        # `via_ai_connection=True` is what distinguishes this caller from the
        # legacy phone-verify one, which stands down while this trigger owns it.
        scheduled = bool(schedule(normalized, phone, via_ai_connection=True))
        logger.info(
            "ai_connection_gate.provision_scheduled user_id=%s provider=%s transport=%s ok=%s",
            normalized,
            str(provider or "")[:32],
            str(transport or "")[:32],
            scheduled,
        )
        return {"scheduled": scheduled, "reason": "ai connection verified"}
    except Exception as exc:  # noqa: BLE001 - never fail a credential validation
        logger.warning("ai_connection_gate.failed %s", type(exc).__name__)
        return {"scheduled": False, "reason": f"error: {type(exc).__name__}"}


# The provider values the two connection modes report. BYOK arrives as "gemini"
# (api/routes/one/runtime.py validate); managed as "hushh_managed_vertex" (select).
_MANAGED_PROVIDER = "hushh_managed_vertex"


def _pod_can_serve(provider: str) -> bool:
    """Could a pod actually run a turn on this connection mode?

    BYOK always: the key arrives with each turn, so the pod needs no standing model
    access and the pod service account keeps its zero project roles -- which is the
    whole basis of the isolation story.

    Managed only when a pod is permitted to reach the fleet's model. Until then a
    managed pod would boot, warm, heartbeat, and refuse every turn with "this pod
    has no model access", at full price. Provisioning one would be the same mistake
    as provisioning on login, one step later in the journey.
    """
    if str(provider or "").strip().lower() != _MANAGED_PROVIDER:
        return True
    from hushh_mcp.runtime_settings import pod_managed_model_enabled  # noqa: PLC0415

    return pod_managed_model_enabled()


async def _verified_phone(actor: Any, user_id: str) -> str:
    """The user's own verified phone, from the identity service. Never a request field.

    Same read the owner-authorized provision route performs
    (``api/routes/one/personal_agent.py``): ``get_many`` then require
    ``phone_verified is True``. Checking the flag rather than just the presence of a
    number matters -- an unverified number would mint a HusshID against a phone
    nobody proved they hold.
    """
    identity = (await actor.get_many([user_id])).get(user_id) or {}
    if identity.get("phone_verified") is not True:
        return ""
    return str(identity.get("phone_number") or "").strip()

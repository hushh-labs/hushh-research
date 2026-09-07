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
from typing import Any, Optional

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
        # THIS person's target, not the deployment's. A BYOC person's connection must
        # be judged against their own project, where Vertex ADC is theirs, rather than
        # against hushh's fleet flag -- which is a different tier's question entirely.
        from hushh_mcp.services.user_cloud_service import resolve_user_cloud  # noqa: PLC0415

        cloud = await resolve_user_cloud(normalized, repo=registry)
        if cloud is not None and cloud.is_user_owned and not cloud.is_ready_to_provision:
            # They chose their own cloud and have not yet let hushh in. Refusing is the
            # ordering rule in its load-bearing form: without it, a person who started
            # BYOC is silently completed as a trial user, on hushh's compute and hushh's
            # bill, and nothing in the product ever tells them.
            return {
                "scheduled": False,
                "reason": "your cloud is named but not yet authorized",
            }

        access = _pod_can_serve(
            provider, deployment_target=(cloud.deployment_target if cloud else None)
        )
        if not access.can_serve:
            # NOT a new flag, deliberately. For the managed tier this still resolves
            # to `pod_managed_model_enabled`, the same setting that decides whether a
            # pod may serve a turn (`pod_turn._resolve_runtime_mode`), so "a pod
            # exists but 400s every turn" stays unrepresentable -- one switch governs
            # both halves and they cannot drift apart.
            #
            # What is new is that the question is now asked per deployment path, so a
            # connection mode the path cannot serve AT ALL (managed Vertex on
            # CloudHub) is refused on its own merits rather than riding a flag that
            # was never about it.
            #
            # A user refused here is not stranded -- they keep the hub-served
            # experience. What they do not get is a billable host that refuses every
            # request, which is strictly worse than no host at all.
            logger.info(
                "ai_connection_gate.refused user_id=%s provider=%s reason=%s",
                normalized,
                str(provider or "")[:32],
                access.reason,
            )
            return {
                "scheduled": False,
                "reason": access.reason,
                "activation": access.activation,
            }

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
        return {
            "scheduled": scheduled,
            "reason": "ai connection verified",
            # How this pod will reach a model, and the order its agents come up.
            # Carried on the verdict so the surface that reports provisioning can say
            # which of the three model-access modes a person is actually on instead
            # of inferring it from the provider string.
            "activation": access.activation,
            "activationOrder": list(access.activation_order),
        }
    except Exception as exc:  # noqa: BLE001 - never fail a credential validation
        logger.warning("ai_connection_gate.failed %s", type(exc).__name__)
        return {"scheduled": False, "reason": f"error: {type(exc).__name__}"}


# The provider values the two connection modes report. BYOK arrives as "gemini"
# (api/routes/one/runtime.py validate); managed as "hushh_managed_vertex" (select).
_MANAGED_PROVIDER = "hushh_managed_vertex"


def _pod_can_serve(provider: str, *, deployment_target: Optional[str] = None) -> Any:
    """Could a pod actually run a turn on this connection mode, ON THIS PATH?

    ``deployment_target`` is THIS person's, not the deployment's. Without it the
    verdict was resolved from the process-wide ``PERSONAL_AGENT_BACKEND``, so a BYOC
    person's managed selection was judged as though it would run on hushh's fleet
    identity -- and therefore gated on ``pod_managed_model_enabled()``, a flag that has
    nothing to do with whether their own project's ADC works. That is the wrong
    question asked of the wrong tier, and it is what makes the trial tier and BYOC
    unable to coexist in one deployment. They must coexist: the trial is offered
    before the cloud step.

    The last clause is the fix. This asked only "managed or BYOK?" and consulted one
    global flag, which is backend-blind — and the paths do not have the same model
    access available:

    * **Anypoint/CloudHub** has no Google identity, so Vertex ADC is not merely
      unconfigured there but unreachable. ``AnypointBackend`` renders
      ``GOOGLE_GENAI_USE_VERTEXAI=false`` for exactly that reason. Under the old
      check, an Anypoint deployment with ``pod_managed_model_enabled()`` on would
      have provisioned a pod on a managed connection it could never serve.
    * **BYO GCP** has Vertex ADC available *as the user's own*, on their identity
      and their bill, so a managed selection is legitimate there and does not depend
      on hushh's fleet flag at all.
    * **hushh-managed GCP** is the only path where the fleet flag is the right
      question, because it is the only one where the identity is hushh's.

    So the decision moves to ``model_access_policy.model_access_for``, which states
    all three rules in one place. Returning the verdict rather than a bool means the
    refusal reason reaches the caller instead of being flattened to False.
    """
    from hushh_mcp.services.model_access_policy import (  # noqa: PLC0415
        model_access_for,
        resolve_backend_id,
    )

    return model_access_for(resolve_backend_id(deployment_target), provider)


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

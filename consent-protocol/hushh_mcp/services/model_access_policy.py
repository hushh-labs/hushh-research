"""How a pod on each deployment path is allowed to reach a model — stated once.

THE RULE THIS FILE EXISTS TO MAKE UNAMBIGUOUS
---------------------------------------------
``ai_connection_gate`` holds the standing rule: **a working AI connection earns a
pod, a login never does.** That rule is right and unchanged. What it did not say is
*which* connection counts, and the answer is not the same on every deployment path
— because the paths do not have the same model access available to them.

Before this module, ``_pod_can_serve`` asked only "managed or BYOK?" and consulted
one global flag. It never asked which backend the pod would run on. So an Anypoint
deployment with ``pod_managed_model_enabled()`` on would have provisioned a pod on a
managed-Vertex connection — and ``AnypointBackend.render_deploy_config`` renders
``GOOGLE_GENAI_USE_VERTEXAI=false`` on purpose, because "there is no Vertex here and
no ambient Google identity to borrow". The result is the exact failure the gate was
built to prevent, one level further up: a billable pod that cannot think.

THE THREE PATHS, AND WHY THEY DIFFER
------------------------------------
**Anypoint (CloudHub) — BYOK only, by construction.** CloudHub is not GCP. There is
no metadata server, no ambient Google identity, and therefore no Vertex ADC that
could ever be established. Model access is satisfied at RUNTIME by the user's own
key arriving with each turn. A managed-Vertex connection is not merely
unconfigured here — it is unreachable, so provisioning on one is refused rather
than deferred to a flag that could be switched on by mistake.

**BYO GCP — the user's own Vertex ADC, in the user's own project.** The pod runs
under a service account in the user's project, so ADC is genuinely available: the
bootstrap grants that account ``roles/aiplatform.user`` and the pod calls Vertex as
itself, on the user's own quota and bill. Nothing of hushh's is borrowed. Once that
connection is established the pod can be provisioned and its agents brought up in
order. BYOK also remains available for a user who prefers to bring a key.

**hushh-managed GCP — the fleet's ADC, and only where that is permitted.** The
identity is hushh's own, shared across the fleet, which is why it stays behind
``pod_managed_model_enabled()`` and why per-pod identity (task #114) gates widening
it. This is the internal development and validation tier.

WHY "ESTABLISHED" MEANS SOMETHING DIFFERENT ON BYOC
---------------------------------------------------
A BYOK key proves itself by answering a real generation request — that is what the
validate route does. Vertex ADC **inside a pod** cannot be proven that way before
the pod exists, so requiring it would be circular. What can be checked beforehand,
and is what ``byoc_vertex_preconditions`` checks, is that the user's project has the
Vertex API enabled and that the pod's service account actually holds
``roles/aiplatform.user``. Those are the two conditions whose absence makes ADC
impossible; with both present the pod's own boot-time check is a formality rather
than a gamble.

That is a weaker claim than "a key answered", and it is stated as such rather than
dressed up as the same thing.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Optional

from hushh_mcp.services.compute_backend import (
    BACKEND_ANYPOINT,
    BACKEND_GCP,
    BACKEND_NULL,
    BACKEND_USER_GCP,
)

logger = logging.getLogger(__name__)

#: The user's own key, arriving with each turn. The pod holds no standing model
#: access, which is why its service account can keep zero project roles.
ACTIVATION_BYOK_PER_TURN = "byok_per_turn"
#: Vertex ADC on the pod's own service account in the USER's project (BYOC).
ACTIVATION_USER_ADC = "user_adc"
#: Vertex ADC on hushh's fleet identity. Managed tier only.
ACTIVATION_FLEET_ADC = "fleet_adc"

#: The provider id the managed runtime selection route reports.
MANAGED_PROVIDER = "hushh_managed_vertex"

#: Order in which a pod brings its agents up once model access is established.
#: ``one`` is first because it is the primary and the only agent a pod mounts today
#: (``health._agent_roster``); the specialists follow it and are listed here so the
#: sequence is a declared contract rather than whatever order a dict happened to
#: iterate in. Nothing activates before the model access it needs exists.
AGENT_ACTIVATION_ORDER: tuple[str, ...] = ("one", "kai", "nav")


@dataclass(frozen=True)
class ModelAccessVerdict:
    """Whether a pod on this path can serve this connection, and how."""

    can_serve: bool
    activation: str
    reason: str
    #: Ordered agents that may be brought up. Empty when nothing may serve, so a
    #: caller cannot activate an agent by ignoring ``can_serve``.
    activation_order: tuple[str, ...] = field(default_factory=tuple)

    def as_dict(self) -> dict[str, Any]:
        return {
            "canServe": self.can_serve,
            "activation": self.activation,
            "reason": self.reason,
            "activationOrder": list(self.activation_order),
        }


def _is_managed(provider: str) -> bool:
    return str(provider or "").strip().lower() == MANAGED_PROVIDER


def model_access_for(backend_id: str, provider: str) -> ModelAccessVerdict:
    """The rule, applied. One function, so provisioning and activation cannot drift.

    Deliberately pure and synchronous: it decides from the path and the connection
    mode alone. Whether the user's project is actually *configured* is a separate,
    I/O-bound question answered by ``byoc_vertex_preconditions`` — keeping the two
    apart is what lets the rule be tested exhaustively without a cloud.
    """
    backend = str(backend_id or "").strip().lower()
    managed = _is_managed(provider)

    if backend == BACKEND_ANYPOINT:
        if managed:
            return ModelAccessVerdict(
                can_serve=False,
                activation="",
                reason=(
                    "Anypoint/CloudHub has no Google identity and no Vertex ADC; the "
                    "renderer sets GOOGLE_GENAI_USE_VERTEXAI=false. A managed connection "
                    "can never serve a pod here, so provisioning one would create a "
                    "billable host that refuses every turn."
                ),
            )
        return ModelAccessVerdict(
            can_serve=True,
            activation=ACTIVATION_BYOK_PER_TURN,
            reason="CloudHub serves the user's own key at runtime, per turn",
            activation_order=AGENT_ACTIVATION_ORDER,
        )

    if backend == BACKEND_USER_GCP:
        if managed:
            return ModelAccessVerdict(
                can_serve=True,
                activation=ACTIVATION_USER_ADC,
                reason=(
                    "the pod runs under a service account in the USER's project, so "
                    "Vertex ADC is theirs — their identity, their quota, their bill. "
                    "Gate the provision on byoc_vertex_preconditions."
                ),
                activation_order=AGENT_ACTIVATION_ORDER,
            )
        return ModelAccessVerdict(
            can_serve=True,
            activation=ACTIVATION_BYOK_PER_TURN,
            reason="the user brought a key; BYOC serves it exactly as any other path does",
            activation_order=AGENT_ACTIVATION_ORDER,
        )

    # An unset backend is treated as the hushh-managed tier, NOT as "anything goes".
    # It resolves to the inert NullBackend today, but the question here is which
    # IDENTITY a managed turn would borrow, and for an unconfigured deployment the
    # honest answer is hushh's own — so the fleet flag must still govern it. Letting
    # `""` mean "serviceable" would have removed that control for exactly the
    # deployments that never configured one, which is backwards.
    if backend in (BACKEND_GCP, BACKEND_NULL, ""):
        if managed:
            from hushh_mcp.runtime_settings import pod_managed_model_enabled  # noqa: PLC0415

            allowed = bool(pod_managed_model_enabled())
            return ModelAccessVerdict(
                can_serve=allowed,
                activation=ACTIVATION_FLEET_ADC if allowed else "",
                reason=(
                    "a managed pod may reach the fleet's model"
                    if allowed
                    else (
                        "pod_managed_model_enabled is off, so a managed pod would boot, "
                        "warm, heartbeat and refuse every turn at full price"
                    )
                ),
                activation_order=AGENT_ACTIVATION_ORDER if allowed else (),
            )
        return ModelAccessVerdict(
            can_serve=True,
            activation=ACTIVATION_BYOK_PER_TURN,
            reason="BYOK needs no standing model access on the pod",
            activation_order=AGENT_ACTIVATION_ORDER,
        )

    # An unrecognised backend is refused, not assumed serviceable. A new path added
    # without a rule here should fail closed and loudly rather than inherit whichever
    # branch happened to be last.
    return ModelAccessVerdict(
        can_serve=False,
        activation="",
        reason=f"no model-access rule is declared for backend {backend!r}",
    )


def byoc_vertex_preconditions(
    *,
    project: str,
    pod_service_account: str,
    token: str,
    session: Any = None,
) -> dict[str, Any]:
    """Is Vertex ADC actually establishable in the USER's project, before we build?

    Checks the two conditions whose absence makes pod ADC impossible:

    1. ``aiplatform.googleapis.com`` is enabled in their project.
    2. the pod's service account holds ``roles/aiplatform.user`` there.

    Read-only, and it grants nothing: a missing binding is reported so the bootstrap
    can add it deliberately, never quietly acquired here. Returns a verdict dict
    rather than raising, because "not yet configured" is an ordinary state on the
    way in and the caller decides whether that blocks the provision.
    """
    if session is None:
        import requests as session  # noqa: PLC0415

    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    result: dict[str, Any] = {
        "project": project,
        "podServiceAccount": pod_service_account,
        "vertexApiEnabled": False,
        "podHasAiplatformUser": False,
        "established": False,
        "missing": [],
    }

    api = session.get(
        f"https://serviceusage.googleapis.com/v1/projects/{project}/services"
        "/aiplatform.googleapis.com",
        headers=headers,
        timeout=60,
    )
    if getattr(api, "status_code", 0) == 200:
        result["vertexApiEnabled"] = str(api.json().get("state", "")).upper() == "ENABLED"
    if not result["vertexApiEnabled"]:
        result["missing"].append("aiplatform.googleapis.com is not enabled")

    policy = session.post(
        f"https://cloudresourcemanager.googleapis.com/v1/projects/{project}:getIamPolicy",
        headers=headers,
        json={"options": {"requestedPolicyVersion": 3}},
        timeout=60,
    )
    if getattr(policy, "status_code", 0) == 200:
        member = f"serviceAccount:{pod_service_account}"
        result["podHasAiplatformUser"] = any(
            b.get("role") == "roles/aiplatform.user" and member in (b.get("members") or [])
            for b in policy.json().get("bindings", [])
        )
    if not result["podHasAiplatformUser"]:
        result["missing"].append(f"{pod_service_account} lacks roles/aiplatform.user")

    result["established"] = bool(result["vertexApiEnabled"] and result["podHasAiplatformUser"])
    logger.info(
        "byoc_vertex_preconditions project=%s established=%s missing=%d",
        project,
        result["established"],
        len(result["missing"]),
    )
    return result


def resolve_backend_id(explicit: Optional[str] = None) -> str:
    """Which compute backend a pod for this deployment would be created on.

    Reads the same setting the provisioning path reads, so the gate's decision is
    about the backend that will actually be used rather than one inferred here.
    """
    if explicit:
        return str(explicit).strip().lower()
    from hushh_mcp.runtime_settings import personal_agent_backend  # noqa: PLC0415

    return str(personal_agent_backend() or "").strip().lower()


__all__ = [
    "ACTIVATION_BYOK_PER_TURN",
    "ACTIVATION_FLEET_ADC",
    "ACTIVATION_USER_ADC",
    "AGENT_ACTIVATION_ORDER",
    "MANAGED_PROVIDER",
    "ModelAccessVerdict",
    "byoc_vertex_preconditions",
    "model_access_for",
    "resolve_backend_id",
]

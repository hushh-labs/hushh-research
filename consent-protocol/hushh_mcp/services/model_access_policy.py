"""Model access for GCP private-agent hosting.

BYOC uses the owner's Vertex identity after verified project preconditions, or a
per-turn owner key. Hussh-managed GCP remains behind the fleet model-access gate.
Unknown deployment targets refuse provisioning. A precondition check establishes
configuration; successful generation inside the pod requires runtime evidence.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Optional

from hushh_mcp.services.compute_backend import (
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
    if backend in (BACKEND_GCP, BACKEND_NULL, "none", ""):
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
                        "a private agent on hushh's own model access is not enabled yet — "
                        "connect your own AI key to continue"
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

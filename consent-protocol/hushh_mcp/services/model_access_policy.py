"""Model access for private-agent hosting.

Owner-project GCP uses the owner's Vertex identity after verified project
preconditions, or a per-turn owner key. An owner Azure subscription uses the pod's
own managed identity against Azure OpenAI in that subscription (``user_azure_mi``),
or a per-turn owner key. Hussh-managed GCP remains behind the fleet model-access
gate. Unknown deployment targets refuse provisioning. A precondition check
establishes configuration; successful generation inside the pod requires runtime
evidence.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Optional

from hushh_mcp.services.compute_backend import (
    BACKEND_ACE,
    BACKEND_AZURE,
    BACKEND_GCP,
    BACKEND_NULL,
    BACKEND_USER_AWS,
    BACKEND_USER_AZURE,
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
#: Azure OpenAI in the USER's own subscription, reached with the pod's own
#: user-assigned managed identity (BYOC on Azure). No key exists to hold.
ACTIVATION_USER_AZURE_MI = "user_azure_mi"
#: Amazon Bedrock in the USER's own AWS account, reached with the pod's own
#: ECS task IAM role (BYOC on AWS). No static key exists to hold.
ACTIVATION_USER_AWS_BEDROCK = "user_aws_bedrock_iam"

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

    if backend == BACKEND_USER_AZURE:
        return _owner_azure_verdict(managed)

    if backend == BACKEND_AZURE:
        return _owner_azure_verdict(managed)

    if backend == BACKEND_USER_AWS:
        return _owner_aws_verdict(managed)

    # An unset backend is treated as the hushh-managed tier, NOT as "anything goes".
    # It resolves to the inert NullBackend today, but the question here is which
    # IDENTITY a managed turn would borrow, and for an unconfigured deployment the
    # honest answer is hushh's own — so the fleet flag must still govern it. Letting
    # `""` mean "serviceable" would have removed that control for exactly the
    # deployments that never configured one, which is backwards.
    if backend in (BACKEND_GCP, BACKEND_ACE, BACKEND_NULL, "none", ""):
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


def _owner_azure_verdict(managed: bool) -> ModelAccessVerdict:
    """The owner-Azure rule: the pod's own identity first, the owner's key second.

    Stated as its own branch rather than inherited from the GCP owner rule: the
    identity differs (an Azure managed identity, not Vertex ADC), so a shared branch
    would let a future change to one cloud's model access silently move the other.
    """
    if managed:
        return ModelAccessVerdict(
            can_serve=True,
            activation=ACTIVATION_USER_AZURE_MI,
            reason=(
                "the pod runs under its own managed identity in the USER's subscription, "
                "calling Azure OpenAI there: their identity, their quota, their bill"
            ),
            activation_order=AGENT_ACTIVATION_ORDER,
        )
    return ModelAccessVerdict(
        can_serve=True,
        activation=ACTIVATION_BYOK_PER_TURN,
        reason="the user brought a key; an owner Azure pod serves it per turn",
        activation_order=AGENT_ACTIVATION_ORDER,
    )


def _owner_aws_verdict(managed: bool) -> ModelAccessVerdict:
    """The owner-AWS rule: the pod's own ECS task role for Bedrock, or owner BYOK.

    Kept separate from GCP and Azure owner branches so each cloud's native model
    identity (Vertex ADC vs Azure Managed Identity vs AWS ECS Task Role) remains
    explicitly governed without cross-cloud coupling.
    """
    if managed:
        return ModelAccessVerdict(
            can_serve=True,
            activation=ACTIVATION_USER_AWS_BEDROCK,
            reason=(
                "the pod runs under its own ECS task IAM role in the USER's AWS account, "
                "calling Amazon Bedrock there: their identity, their quota, their bill. "
                "Gate the provision on byoc_aws_bedrock_preconditions."
            ),
            activation_order=AGENT_ACTIVATION_ORDER,
        )
    return ModelAccessVerdict(
        can_serve=True,
        activation=ACTIVATION_BYOK_PER_TURN,
        reason="the user brought a key; an owner AWS pod serves it per turn",
        activation_order=AGENT_ACTIVATION_ORDER,
    )


def byoc_vertex_preconditions(
    *,
    project: str,
    pod_service_account: str,
    token: str,
    session: Any = None,
) -> dict[str, Any]:
    """Is Vertex ADC actually establishable in the USER's project, before we build?

    Checks the declared prerequisites for owner-project ADC:

    1. ``aiplatform.googleapis.com`` is enabled in their project.
    2. the pod's service account holds ``roles/aiplatform.user`` there.
    3. it holds ``roles/serviceusage.serviceUsageConsumer`` for quota use.

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
        "podHasServiceUsageConsumer": False,
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
        roles = {
            b.get("role")
            for b in policy.json().get("bindings", [])
            if member in (b.get("members") or []) and "condition" not in b
        }
        result["podHasAiplatformUser"] = "roles/aiplatform.user" in roles
        result["podHasServiceUsageConsumer"] = "roles/serviceusage.serviceUsageConsumer" in roles
    if not result["podHasAiplatformUser"]:
        result["missing"].append(f"{pod_service_account} lacks roles/aiplatform.user")

    if not result["podHasServiceUsageConsumer"]:
        result["missing"].append(
            f"{pod_service_account} lacks roles/serviceusage.serviceUsageConsumer"
        )
    result["established"] = bool(
        result["vertexApiEnabled"]
        and result["podHasAiplatformUser"]
        and result["podHasServiceUsageConsumer"]
    )
    logger.info(
        "byoc_vertex_preconditions project=%s established=%s missing=%d",
        project,
        result["established"],
        len(result["missing"]),
    )
    return result


def byoc_aws_bedrock_preconditions(
    *,
    account_id: str,
    region: str,
    pod_task_role_name: str,
    iam_client: Any = None,
) -> dict[str, Any]:
    """Verify whether Amazon Bedrock invoke permissions are established on the owner's pod role.

    Read-only precondition check parallel to ``byoc_vertex_preconditions``. While live AWS
    Fargate execution remains gated (``execution_qualified=False``), live IAM inspection
    without an injected ``iam_client`` enforces ``require_floci_only_aws_readiness_endpoint()``
    so zero accidental calls reach ``*.amazonaws.com``.
    """
    import json  # noqa: PLC0415
    import urllib.parse  # noqa: PLC0415

    if iam_client is None:
        import boto3  # noqa: PLC0415

        from hushh_mcp.services.aws_setup_plan import (  # noqa: PLC0415
            require_floci_only_aws_readiness_endpoint,
        )
        from hushh_mcp.services.pod_s3_object_store import (  # noqa: PLC0415
            resolve_aws_boto3_client_kwargs,
        )

        require_floci_only_aws_readiness_endpoint()
        iam_kwargs = resolve_aws_boto3_client_kwargs("iam")
        iam_kwargs["region_name"] = region
        iam_client = boto3.client("iam", **iam_kwargs)

    result: dict[str, Any] = {
        "accountId": account_id,
        "region": region,
        "podTaskRoleName": pod_task_role_name,
        "roleExists": False,
        "podHasBedrockInvoke": False,
        "podHasBedrockStream": False,
        "established": False,
        "missing": [],
    }
    try:
        listed = iam_client.list_role_policies(RoleName=pod_task_role_name)
        result["roleExists"] = True
        policy_names = list(listed.get("PolicyNames") or [])
    except Exception:  # noqa: BLE001
        result["missing"].append(f"IAM role {pod_task_role_name} is missing or unreadable")
        return result

    allowed_actions: set[str] = set()
    for pname in policy_names:
        try:
            got = iam_client.get_role_policy(RoleName=pod_task_role_name, PolicyName=pname)
            raw_doc = got.get("PolicyDocument")
            if isinstance(raw_doc, str):
                doc = json.loads(urllib.parse.unquote(raw_doc))
            elif isinstance(raw_doc, dict):
                doc = raw_doc
            else:
                doc = {}
        except Exception:  # noqa: BLE001
            continue
        stmts = doc.get("Statement") or []
        if isinstance(stmts, dict):
            stmts = [stmts]
        for stmt in stmts:
            if not isinstance(stmt, dict) or str(stmt.get("Effect") or "") != "Allow":
                continue
            acts = stmt.get("Action") or []
            if isinstance(acts, str):
                acts = [acts]
            for act in acts:
                allowed_actions.add(str(act).strip())

    has_wildcard = "bedrock:*" in allowed_actions or "*" in allowed_actions
    result["podHasBedrockInvoke"] = has_wildcard or "bedrock:InvokeModel" in allowed_actions
    result["podHasBedrockStream"] = (
        has_wildcard or "bedrock:InvokeModelWithResponseStream" in allowed_actions
    )
    if not result["podHasBedrockInvoke"]:
        result["missing"].append(f"{pod_task_role_name} lacks bedrock:InvokeModel")
    if not result["podHasBedrockStream"]:
        result["missing"].append(
            f"{pod_task_role_name} lacks bedrock:InvokeModelWithResponseStream"
        )
    result["established"] = bool(
        result["roleExists"] and result["podHasBedrockInvoke"] and result["podHasBedrockStream"]
    )
    logger.info(
        "byoc_aws_bedrock_preconditions account=%s role=%s established=%s missing=%d",
        account_id,
        pod_task_role_name,
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
    "ACTIVATION_USER_AWS_BEDROCK",
    "ACTIVATION_USER_AZURE_MI",
    "AGENT_ACTIVATION_ORDER",
    "MANAGED_PROVIDER",
    "ModelAccessVerdict",
    "byoc_aws_bedrock_preconditions",
    "byoc_vertex_preconditions",
    "model_access_for",
    "resolve_backend_id",
]

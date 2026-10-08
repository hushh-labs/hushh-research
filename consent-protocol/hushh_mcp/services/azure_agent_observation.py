"""What ARM lets Hussh read of a person's Azure agent, typed by certainty.

GONE MEANS A 404 ON THE AGENT ITSELF. Only then is the agent absent, and the reason
is classified from what ARM still lets Hussh read: ``owner_deleted_agent`` (the
environment remains), ``environment_deleted`` (Azure's idle-environment policy, or the
owner, removed the environment; storage and vault survive, so a JIT re-create adopts
them), or ``access_removed``. A 403 on the agent is NEVER absence: role assignments
take minutes to apply after setup, and an owner can remove Hussh's read while the
agent runs. That case is ``agent_unreadable`` (or ``access_removed`` when the
environment is refused too), and callers get ``AzureAgentUnreadable`` instead of
``gone``, because a false fresh setup changes the person's agent identity and address
(``api/routes/one/pod_wake.py``: only a confirmed absence counts).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Optional

from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient, ArmError

GONE_OWNER_DELETED_AGENT = "owner_deleted_agent"
GONE_ENVIRONMENT_DELETED = "environment_deleted"
GONE_ACCESS_REMOVED = "access_removed"
#: Hussh's read of the agent was refused while its environment reads: not absence.
AGENT_UNREADABLE = "agent_unreadable"


class AzureJitAuthorizationRequired(RuntimeError):
    """This operation needs the person's approval and a fresh Microsoft sign-in."""

    code = "JIT_SIGN_IN_REQUIRED"


class AzureAgentUnreadable(RuntimeError):
    """ARM refused Hussh's read of the agent (403). Never proof that it is gone."""

    code = "AGENT_UNREADABLE"


@dataclass(frozen=True)
class AzureAgentObservation:
    present: bool
    gone_reason: str = ""
    #: True only when ARM answered 404 for the agent itself; a 403 never sets it.
    absence_confirmed: bool = False
    app: dict[str, Any] = field(default_factory=dict, repr=False)

    def refusal(self, action: str) -> Exception:
        """Why an agent that is not present cannot be ``action``-ed, typed by certainty."""
        if not self.absence_confirmed:
            return AzureAgentUnreadable(
                f"Hussh cannot read the agent to {action} it ({self.gone_reason}); "
                "this is not proof it is gone"
            )
        return AzureJitAuthorizationRequired(
            f"no agent to {action} in the person's subscription ({self.gone_reason}); "
            "re-creating it needs their Microsoft sign-in"
        )

    def _properties(self) -> dict[str, Any]:
        return dict(self.app.get("properties") or {})

    @property
    def tags(self) -> dict[str, str]:
        return dict(self.app.get("tags") or {})

    @property
    def fqdn(self) -> str:
        ingress = (self._properties().get("configuration") or {}).get("ingress") or {}
        return str(ingress.get("fqdn") or "")

    @property
    def ready(self) -> bool:
        props = self._properties()
        latest = str(props.get("latestRevisionName") or "")
        return (
            str(props.get("provisioningState") or "") == "Succeeded"
            and bool(latest)
            and latest == str(props.get("latestReadyRevisionName") or "")
        )

    @property
    def image(self) -> str:
        containers = ((self._properties().get("template") or {}).get("containers")) or [{}]
        return str(containers[0].get("image") or "")

    def principal(self, identity: str) -> tuple[str, str]:
        return assigned_identity(self.app, identity)


def assigned_identity(app: dict, identity: str) -> tuple[str, str]:
    """(principalId, clientId) of ``identity`` on ``app``, or empty strings.

    ARM resource ids are case-insensitive and ARM echoes them in its own casing:
    a Container App read back lists its identity under ``.../resourcegroups/...``
    even when it was written as ``.../resourceGroups/...``. An exact lookup missed
    it and the first live Connect Azure on dev (2026-10-05) refused its own agent.
    """
    identities = (app.get("identity") or {}).get("userAssignedIdentities") or {}
    wanted = identity.lower()
    for key, entry in identities.items():
        if str(key).lower() == wanted:
            entry = entry or {}
            return str(entry.get("principalId") or ""), str(entry.get("clientId") or "")
    return "", ""


def _read_or_forbidden(arm: ArmClient, path: str) -> tuple[Optional[dict], bool]:
    """(resource or None, forbidden). Any refusal other than 403 propagates."""
    try:
        return arm.get_or_none(
            path, api_version=API_VERSIONS["container_apps"], op="observe"
        ), False
    except ArmError as exc:
        if exc.kind != "forbidden":
            raise
        return None, True


def observe_agent(arm: ArmClient, app_path: str, environment_path: str) -> AzureAgentObservation:
    """Present; absent (a 404 on the agent) with its reason; or unreadable (a 403)."""
    app, app_forbidden = _read_or_forbidden(arm, app_path)
    if app is not None:
        return AzureAgentObservation(present=True, app=app)
    environment, environment_forbidden = _read_or_forbidden(arm, environment_path)
    if environment_forbidden:
        reason = GONE_ACCESS_REMOVED
    elif app_forbidden:
        reason = AGENT_UNREADABLE
    else:
        reason = GONE_OWNER_DELETED_AGENT if environment is not None else GONE_ENVIRONMENT_DELETED
    return AzureAgentObservation(
        present=False, gone_reason=reason, absence_confirmed=not app_forbidden
    )


def approved_image_digests(recorded_digest: str = "") -> frozenset[str]:
    """Digests Hussh approved for this person: the hub's release and the recorded one.

    The hub's release is ``HUSSH_ONE_POD_IMAGE`` when it is pinned by digest; the
    recorded digest is the one Hussh last verified on this person's agent (setup or
    an approved update). Without either the set is empty and adoption refuses.
    """
    from hushh_mcp.services.pod_release import image_digest  # noqa: PLC0415

    candidates = (image_digest(os.getenv("HUSSH_ONE_POD_IMAGE", "")), image_digest(recorded_digest))
    return frozenset(digest for digest in candidates if digest)


def adoption_refusal(
    metadata: dict[str, Any], *, recorded_principal: str, recorded_digest: str
) -> str:
    """Why a verified agent (its handle metadata) may not be adopted, or "" when it may.

    Adoption is cryptographic: the image must be pinned by a digest Hussh approved,
    the agent identity must be the one the registry recorded (when it recorded one),
    and the pod then proves its key before any grant (the orchestrator's key pull).
    """
    from hushh_mcp.services.pod_release import is_immutable_image_reference  # noqa: PLC0415

    if not is_immutable_image_reference(metadata.get("image")):
        return "image_not_pinned"
    if metadata.get("image_digest") not in approved_image_digests(recorded_digest):
        return "image_not_approved"
    if recorded_principal and metadata.get("runtime_principal_id") != recorded_principal:
        return "identity_changed"
    return ""


__all__ = [
    "AGENT_UNREADABLE",
    "GONE_ACCESS_REMOVED",
    "GONE_ENVIRONMENT_DELETED",
    "GONE_OWNER_DELETED_AGENT",
    "AzureAgentObservation",
    "AzureAgentUnreadable",
    "AzureJitAuthorizationRequired",
    "adoption_refusal",
    "approved_image_digests",
    "assigned_identity",
    "observe_agent",
]

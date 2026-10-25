"""Managed hosting remains unavailable until shard admission and custody qualify.

Deployment flags name intent and a project; they do not prove capacity or sibling
isolation. BYOC and reviewer phone-verification retain their separate authorities.
Plan rendering and existing resource inspection remain available.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

from hushh_mcp.services.dev_simulation_guard import deploy_lane, runtime_environment

_OPT_IN_FLAG = "HUSSH_HOSTED_POD_TIER_ENABLED"
_POD_PROJECT_VAR = "HUSSH_POD_PROJECT"


class HostedTierNotPermittedError(RuntimeError):
    """No new managed owner resources before the qualified admission path exists."""


def _norm(value: str | None) -> str:
    return str(value or "").strip().lower()


def _flag(name: str) -> bool:
    return _norm(os.getenv(name)) in {"1", "true", "yes", "on"}


def hosted_pod_project() -> str:
    return str(os.getenv(_POD_PROJECT_VAR) or "").strip()


def hosted_pod_creates_permitted() -> bool:
    # Deliberate qualification gate, not an operator-configurable bypass. The
    # existing renderer uses development master-key derivation and a shared
    # identity. Replace this refusal only with authoritative shard reservations
    # and qualified per-owner key custody, together with their negative controls.
    return False


def require_supported_erasure(row: object) -> None:
    """Preserve managed recovery until its complete erasure receipts qualify."""
    if not isinstance(row, Mapping):
        return
    target = row.get("deployment_target")
    if target == "gcp" or (not target and row.get("backend") == "gcp"):
        from hushh_mcp.services.account_service import PersonalAgentDeprovisioningRequiredError

        raise PersonalAgentDeprovisioningRequiredError()


def require_hosted_pod_maintenance_permitted(what: str = "hosted pod maintenance") -> None:
    # Existing resources still need owner-approved upgrades and recovery. This
    # admission permits maintenance intent only; the backend separately proves
    # the existing service/incarnation, handoff and exact approved target.
    if _flag(_OPT_IN_FLAG) and deploy_lane() and hosted_pod_project():
        return
    raise HostedTierNotPermittedError(f"{what} requires an explicitly configured existing fleet")


def require_hosted_pod_creates_permitted(what: str = "hosted pod provisioning") -> None:
    if hosted_pod_creates_permitted():
        return
    raise HostedTierNotPermittedError(
        f"{what} is unavailable until project-shard capacity admission and per-pod "
        f"custody are qualified. {_OPT_IN_FLAG} and {_POD_PROJECT_VAR} are configuration "
        f"intent, not qualification. Observed opt_in={_flag(_OPT_IN_FLAG)} "
        f"lane={deploy_lane()!r} project={hosted_pod_project()!r} "
        f"environment={runtime_environment()!r}."
    )

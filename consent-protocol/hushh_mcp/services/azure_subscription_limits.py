"""A subscription limit, explained in the person's words, naming what uses the slot.

A free-trial Azure subscription holds ONE Container Apps environment and ONE Azure
OpenAI account (measured 2026-10-04: ``MaxNumberOfGlobalEnvironmentsInSubExceeded``
on the environment, ``InsufficientQuota`` on the account, both caused by resources
that already existed). "Azure refused a setup step" gave the person nothing to act
on. This names the limit and the resources occupying it, read with the person's own
delegated token, so they can free the slot or upgrade, and says nothing was removed.

Only the environment limit is fatal: the model is an optional step, and an agent
without its own model falls back to a per-turn key by design.
"""

from __future__ import annotations

from typing import Optional

from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient, ArmError
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused

ENVIRONMENT_LIMIT_CODES = frozenset(
    {"MaxNumberOfGlobalEnvironmentsInSubExceeded", "MaxNumberOfRegionalEnvironmentsInSubExceeded"}
)
_MAX_NAMED = 3


def _named(arm: ArmClient, path: str, api: str) -> list[str]:
    """``name (resource group)`` for each resource listed, or none when unreadable."""
    try:
        listed = arm.get(path, api_version=api, op="limit_occupants").get("value") or []
    except ArmError:
        return []
    named = []
    for item in listed:
        parts = str(item.get("id") or "").split("/")
        group = parts[4] if len(parts) > 4 and parts[3].lower() == "resourcegroups" else ""
        name = str(item.get("name") or "")
        if name:
            named.append(f"{name} ({group})" if group else name)
    return named


def environment_limit_refusal(
    exc: ArmError, arm: ArmClient, subscription_id: str
) -> Optional[AzureSetupRefused]:
    """The plain refusal for an environment-limit error, or None for any other error."""
    if exc.code not in ENVIRONMENT_LIMIT_CODES:
        return None
    occupants = _named(
        arm,
        f"/subscriptions/{subscription_id}/providers/Microsoft.App/managedEnvironments",
        API_VERSIONS["container_apps"],
    )
    in_use = f" In use: {', '.join(occupants[:_MAX_NAMED])}." if occupants else ""
    return AzureSetupRefused(
        "Your Azure subscription has reached its limit of app environments (a free trial "
        f"allows one).{in_use} Remove an unused one in the Azure portal, or upgrade the "
        "subscription, then try again. Nothing was removed.",
        code="AZURE_ENVIRONMENT_LIMIT",
    )


__all__ = ["ENVIRONMENT_LIMIT_CODES", "environment_limit_refusal"]

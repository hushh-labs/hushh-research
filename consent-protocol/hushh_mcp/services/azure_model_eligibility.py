"""Read-only early model admission. ARM deployment remains authoritative.

Use the catalog's quota name, not subscription-offer guesses. Incomplete or
unreadable evidence is unverified, never an invented zero. Retries credit only
the exact deployment in the already-bound setup group.
"""

from __future__ import annotations

from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient, ArmError
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
from hushh_mcp.services.azure_setup_plan import PlanInputs, Scopes, resource_names


def require_model_eligibility(arm: ArmClient, inputs: PlanInputs) -> None:
    """Refuse confirmed missing quota before any PUT; preserve the chosen model."""
    choice = inputs.model
    if choice is None:
        return
    path = (
        f"/subscriptions/{inputs.subscription_id}/providers/"
        f"Microsoft.CognitiveServices/locations/{inputs.location}"
    )
    api = API_VERSIONS["cognitive_services"]
    try:
        catalog = arm.get(f"{path}/models", api_version=api, op="model_eligibility")
        models = catalog.get("value")
        if not isinstance(models, list) or len(models) > 2000 or catalog.get("nextLink"):
            return  # Incomplete evidence: creation still checks actual eligibility.
        matches = [
            entry
            for entry in models
            if isinstance(entry, dict)
            and entry.get("kind") == choice.account_kind
            and isinstance(entry.get("model"), dict)
            and entry["model"].get("name") == choice.name
            and entry["model"].get("version") == choice.version
        ]
        if len(matches) != 1:
            return
        skus = matches[0]["model"].get("skus")
        if not isinstance(skus, list):
            return
        selected = [sku for sku in skus if isinstance(sku, dict) and sku.get("name") == choice.sku]
        if len(selected) != 1 or not isinstance(selected[0].get("usageName"), str):
            return
        usage_name = selected[0]["usageName"]
        usage = arm.get(f"{path}/usages", api_version=api, op="model_eligibility")
        rows = usage.get("value")
        if not isinstance(rows, list) or len(rows) > 2000 or usage.get("nextLink"):
            return
        quotas = [
            row
            for row in rows
            if isinstance(row, dict)
            and isinstance(row.get("name"), dict)
            and row["name"].get("value") == usage_name
        ]
        if len(quotas) != 1:
            return
        quota = quotas[0]
        used, limit = quota.get("currentValue"), quota.get("limit")
        if quota.get("unit") != "Count" or any(
            type(value) is not int or value < 0 for value in (used, limit)
        ):
            return
        existing = arm.get_or_none(
            Scopes(inputs, resource_names(inputs)).deployment,
            api_version=api,
            op="model_eligibility",
        )
        allocated = 0
        if existing is not None:
            model = (existing.get("properties") or {}).get("model") or {}
            sku = existing.get("sku") or {}
            if model != {"format": "OpenAI", "name": choice.name, "version": choice.version}:
                return
            if sku.get("name") != choice.sku or type(sku.get("capacity")) is not int:
                return
            allocated = max(0, sku["capacity"])
        if max(0, limit - used) >= max(0, choice.capacity - allocated):
            return
    except ArmError:
        # Resource-group-only permission and provider registration can hide the
        # regional catalog. Do not turn an unreadable catalog into a trial ban.
        return
    raise AzureSetupRefused(
        "Your subscription does not have enough quota for this Azure AI model. "
        "If you use a free trial, check upgrading to pay-as-you-go; then verify model "
        "quota and try again. An upgrade alone does not guarantee model access. "
        "Existing resources are kept.",
        code="AZURE_OPENAI_QUOTA_REFUSED",
    )

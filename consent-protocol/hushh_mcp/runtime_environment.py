"""Import-safe structured runtime policy mapping and environment serialization."""

import json
import re
from collections.abc import Mapping
from typing import Any

SCOPE_COMMERCE_ENV_MAP: dict[str, str] = {
    # Consumer scope commerce policy is non-secret. SDK and webhook keys have
    # distinct direct mounts and must never appear in this configuration.
    "scope_commerce_enabled": "SCOPE_COMMERCE_ENABLED",
    "scope_commerce_provider_enabled": "SCOPE_COMMERCE_PROVIDER_ENABLED",
    "scope_commerce_stripe_livemode": "SCOPE_COMMERCE_STRIPE_LIVEMODE",
    "scope_commerce_stripe_account_id": "SCOPE_COMMERCE_STRIPE_ACCOUNT_ID",
    "scope_commerce_frontend_origin": "SCOPE_COMMERCE_FRONTEND_ORIGIN",
    "scope_commerce_return_path": "SCOPE_COMMERCE_RETURN_PATH",
    "scope_commerce_country_policies_json": "SCOPE_COMMERCE_COUNTRY_POLICIES_JSON",
    "scope_commerce_fee_configuration_ref": "SCOPE_COMMERCE_FEE_CONFIGURATION_REF",
    "scope_commerce_stripe_acceptance_ref": "SCOPE_COMMERCE_STRIPE_ACCEPTANCE_REF",
    "scope_commerce_account_configuration_ref": "SCOPE_COMMERCE_ACCOUNT_CONFIGURATION_REF",
    "scope_commerce_country_approval_ref": "SCOPE_COMMERCE_COUNTRY_APPROVAL_REF",
    "scope_commerce_retention_approval_ref": "SCOPE_COMMERCE_RETENTION_APPROVAL_REF",
    "scope_commerce_tax_approval_ref": "SCOPE_COMMERCE_TAX_APPROVAL_REF",
    "scope_commerce_drain_audience": "SCOPE_COMMERCE_DRAIN_AUDIENCE",
    "scope_commerce_drain_scheduler_service_accounts": "SCOPE_COMMERCE_DRAIN_SCHEDULER_SERVICE_ACCOUNTS",
    "scope_commerce_sandbox_policy_required": "SCOPE_COMMERCE_SANDBOX_POLICY_REQUIRED",
    "scope_commerce_sandbox_policy_json": "SCOPE_COMMERCE_SANDBOX_POLICY_JSON",
    "scope_commerce_stripe_webhook_mode": "SCOPE_COMMERCE_STRIPE_WEBHOOK_MODE",
    "scope_commerce_monitoring_enabled": "SCOPE_COMMERCE_MONITORING_ENABLED",
    "scope_commerce_monitoring_project_id": "SCOPE_COMMERCE_MONITORING_PROJECT_ID",
    "scope_commerce_monitoring_backend_service": "SCOPE_COMMERCE_MONITORING_BACKEND_SERVICE",
}


def render_env_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list):
        return ",".join(str(item).strip() for item in value if str(item).strip())
    if isinstance(value, dict):
        return json.dumps(value, separators=(",", ":"), sort_keys=True)
    return str(value).strip()


def scope_commerce_test_pin_environment(environment: Mapping[str, str]) -> list[dict[str, str]]:
    """Export only the configured MCP test pin; OAuth receipts still prove authority."""
    account = environment.get("SCOPE_COMMERCE_STRIPE_ACCOUNT_ID", "")
    mode = environment.get("SCOPE_COMMERCE_STRIPE_LIVEMODE", "").lower()
    if mode != "false" or re.fullmatch(r"acct_[A-Za-z0-9]+", account) is None:
        return []
    return [
        {"name": "SCOPE_COMMERCE_STRIPE_ACCOUNT_ID", "value": account},
        {"name": "SCOPE_COMMERCE_STRIPE_LIVEMODE", "value": "false"},
    ]

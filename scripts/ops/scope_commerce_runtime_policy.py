"""Import-safe structured commerce rollout policy with explicit cloud read ports."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

# Approved non-secret commerce policy. Never accept SDK/webhook secrets here.
# Retain the configured drain identity even when new purchases are disabled.
SCOPE_COMMERCE_POLICY_TYPES: dict[str, type] = {
    **dict.fromkeys(("scope_commerce_enabled", "scope_commerce_provider_enabled",
                     "scope_commerce_stripe_livemode", "scope_commerce_sandbox_policy_required",
                     "scope_commerce_monitoring_enabled"), bool),
    **dict.fromkeys(("scope_commerce_stripe_account_id", "scope_commerce_frontend_origin",
                     "scope_commerce_return_path", "scope_commerce_fee_configuration_ref",
                     "scope_commerce_stripe_acceptance_ref", "scope_commerce_account_configuration_ref",
                     "scope_commerce_country_approval_ref", "scope_commerce_retention_approval_ref",
                     "scope_commerce_tax_approval_ref", "scope_commerce_drain_audience",
                     "scope_commerce_stripe_webhook_mode", "scope_commerce_monitoring_project_id",
                     "scope_commerce_monitoring_backend_service"), str),
    "scope_commerce_country_policies_json": dict,
    "scope_commerce_sandbox_policy_json": dict,
    "scope_commerce_drain_scheduler_service_accounts": list,
}


def _validate_scope_commerce_countries(countries: dict[str, Any]) -> None:
    fields = {
        "currency": str, "minimum_cents": int, "retention_days": int,
        "fixed_fee_micro_usd": int, "fee_basis_points": int,
        "unattributed_fees": bool, "residual_resolution_ref": str,
    }
    for country, policy in countries.items():
        if not isinstance(country, str) or not re.fullmatch(r"[A-Z]{2}", country):
            raise ValueError("Scope commerce country codes must be exact uppercase codes")
        required = set(fields) - {"residual_resolution_ref"}
        if not isinstance(policy, dict) or not required.issubset(policy) or set(policy) - set(fields):
            raise ValueError("Scope commerce country policy must contain only approved policy fields")
        if any(type(policy[key]) is not fields[key] for key in policy):
            raise ValueError("Scope commerce country policy has an invalid type")
        hold_limit = 730 if country == "US" else 10 if country == "TH" else 90
        if (
            policy["currency"] != "usd" or policy["minimum_cents"] < 1
            or not 1 <= policy["retention_days"] <= hold_limit
            or policy["fixed_fee_micro_usd"] < 0
            or not 0 <= policy["fee_basis_points"] <= 10_000
            or policy["unattributed_fees"] is not False
        ):
            raise ValueError("Scope commerce country policy is outside supported financial bounds")


def _validated_scope_commerce_policy(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Scope commerce policy must be a JSON object")
    for key, item in value.items():
        expected = SCOPE_COMMERCE_POLICY_TYPES.get(key)
        if expected is None or type(item) is not expected:
            raise ValueError("Scope commerce policy contains an unknown key or invalid type")
        if isinstance(item, list) and any(not isinstance(entry, str) or not entry.strip() for entry in item):
            raise ValueError("Scope commerce scheduler identities must be exact nonempty strings")
        if key == "scope_commerce_country_policies_json":
            _validate_scope_commerce_countries(item)
        if key == "scope_commerce_stripe_webhook_mode" and item not in {"endpoints", "cli"}:
            raise ValueError("Scope commerce webhook mode must be endpoints or cli")
        if key == "scope_commerce_sandbox_policy_json":
            fields = {"environment": str, "platform_account_id": str,
                      "reviewer_user_ids": list, "reviewer_funding_cap_cents": int,
                      "operating_capital_cap_cents": int}
            if set(item) != set(fields) or any(type(item[name]) is not kind for name, kind in fields.items()):
                raise ValueError("Scope commerce sandbox policy has invalid fields")
            users = item["reviewer_user_ids"]
            if (item["environment"] != "sandbox" or not re.fullmatch(r"acct_[A-Za-z0-9]+", item["platform_account_id"])
                    or len(users) != 2 or any(not isinstance(uid, str) or not uid.strip() for uid in users)
                    or len(set(users)) != 2 or item["reviewer_funding_cap_cents"] != 2000
                    or item["operating_capital_cap_cents"] != 2500):
                raise ValueError("Scope commerce sandbox policy must use the approved identities and caps")
    sandbox = value.get("scope_commerce_sandbox_policy_json")
    if sandbox and (value.get("scope_commerce_stripe_livemode") is True or (
        "scope_commerce_stripe_account_id" in value
        and value["scope_commerce_stripe_account_id"] != sandbox["platform_account_id"]
    )):
        raise ValueError("Scope commerce sandbox policy conflicts with its Stripe account or mode")
    return dict(value)


def _merge_scope_commerce_policy(existing: dict[str, Any], policy_file: str = "") -> dict[str, Any]:
    preserved = _validated_scope_commerce_policy({
        key: value for key, value in existing.items() if key.startswith("scope_commerce_")
    })
    if not policy_file:
        return preserved
    try:
        replacement = json.loads(Path(policy_file).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError("Cannot read the approved scope commerce policy file") from error
    # File omission preserves obligations and OIDC maintenance configuration.
    return _validated_scope_commerce_policy({**preserved, **_validated_scope_commerce_policy(replacement)})


def _read_existing_runtime_config(project: str, run, secret_exists) -> dict[str, Any]:
    result = run([
        "gcloud", "secrets", "versions", "access", "latest",
        "--secret", "BACKEND_RUNTIME_CONFIG_JSON", "--project", project,
    ], check=False)
    if result.returncode != 0:
        # A first deployment has no config. Permission and transport errors
        # cannot be mistaken for absence and wipe financial reconciliation.
        if "NOT_FOUND" in result.stderr and not secret_exists(project, "BACKEND_RUNTIME_CONFIG_JSON"):
            return {}
        raise ValueError("Existing backend runtime policy could not be verified; refusing to replace it")
    try:
        value = json.loads(result.stdout)
        if not isinstance(value, dict):
            raise ValueError
        return value
    except ValueError as error:
        raise ValueError("Existing backend runtime policy is invalid; refusing to replace it") from error


def register_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--scope-commerce-policy-file", default="", help="Approved non-secret JSON policy overlay; omitted fields retain current financial and drain settings.")


def policy_for_args(args: argparse.Namespace, run, secret_exists) -> dict[str, Any]:
    return _merge_scope_commerce_policy(_read_existing_runtime_config(args.project, run, secret_exists), args.scope_commerce_policy_file)


def apply_policy(config: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    # Explicit empty country/identity values close admission instead of inheriting it.
    return {**config, **policy}


def validate_passkey_origin(args: argparse.Namespace, parser, canonical, normalize) -> None:
    canonical_passkey_rp_ids = canonical(args.app_frontend_origin)
    if args.passkey_allowed_rp_ids and normalize(args.passkey_allowed_rp_ids) != normalize(canonical_passkey_rp_ids):
        parser.error("--passkey-allowed-rp-ids must contain only localhost, 127.0.0.1, " "and the APP_FRONTEND_ORIGIN host")
    args.passkey_allowed_rp_ids = canonical_passkey_rp_ids

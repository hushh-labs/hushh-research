"""Immutable Stripe environment, country, cost and live-admission policy."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from .provider_sandbox import SandboxPolicy
from .stripe_adapter import CommerceProviderError


@dataclass(frozen=True)
class CountryPayoutPolicy:
    minimum_cents: int
    retention_days: int
    fixed_fee_micro_usd: int
    fee_basis_points: int
    residual_resolution_ref: str = ""


@dataclass(frozen=True)
class ScopeCommerceProviderConfig:
    enabled: bool = False
    livemode: bool = False
    platform_account_id: str = ""
    frontend_origin: str = ""
    return_path: str = "/one/profile/account"
    countries: dict[str, CountryPayoutPolicy] = field(default_factory=dict)
    fee_configuration_ref: str = ""
    approval_refs: tuple[str, ...] = ()
    sandbox_policy: SandboxPolicy | None = None
    sandbox_policy_required: bool = False

    def allows_actor(self, user_id: str) -> bool:
        """Sandbox admission bounds new commerce, never historical obligations."""
        return self.sandbox_policy is None or user_id in self.sandbox_policy.reviewer_user_ids

    @classmethod
    def from_env(cls) -> ScopeCommerceProviderConfig:
        """A missing provider configuration disables new purchases, not reconciliation."""
        origin = (os.getenv("SCOPE_COMMERCE_FRONTEND_ORIGIN") or "").rstrip("/")
        countries: dict[str, CountryPayoutPolicy] = {}
        try:
            raw = json.loads(os.getenv("SCOPE_COMMERCE_COUNTRY_POLICIES_JSON") or "{}")
            if not isinstance(raw, dict):
                raise ValueError
            for country, policy in raw.items():
                if (
                    not isinstance(country, str)
                    or len(country) != 2
                    or not country.isalpha()
                    or country != country.upper()
                    or not isinstance(policy, dict)
                    or policy.get("currency") != "usd"
                ):
                    raise ValueError
                values = [
                    policy.get("minimum_cents"),
                    policy.get("retention_days"),
                    policy.get("fixed_fee_micro_usd"),
                    policy.get("fee_basis_points"),
                ]
                if any(type(value) is not int for value in values):
                    raise ValueError
                minimum, retention, fixed, basis = values
                hold_limit = 730 if country == "US" else 10 if country == "TH" else 90
                if (
                    minimum < 1
                    or not 1 <= retention <= hold_limit
                    or fixed < 0
                    or not 0 <= basis <= 10_000
                ):
                    raise ValueError
                # Monthly, FX and cross-border costs need an attributable billing
                # adapter before they can be charged to owners. Never guess zero.
                if policy.get("unattributed_fees") is not False:
                    raise ValueError
                resolution = policy.get("residual_resolution_ref", "")
                if not isinstance(resolution, str):
                    raise ValueError
                countries[country] = CountryPayoutPolicy(
                    minimum, retention, fixed, basis, resolution
                )
        except (ValueError, TypeError, json.JSONDecodeError):
            raise CommerceProviderError("provider_configuration_invalid") from None
        refs = tuple(
            os.getenv(name) or ""
            for name in (
                "SCOPE_COMMERCE_STRIPE_ACCEPTANCE_REF",
                "SCOPE_COMMERCE_ACCOUNT_CONFIGURATION_REF",
                "SCOPE_COMMERCE_COUNTRY_APPROVAL_REF",
                "SCOPE_COMMERCE_RETENTION_APPROVAL_REF",
                "SCOPE_COMMERCE_TAX_APPROVAL_REF",
            )
        )
        try:
            sandbox_raw = os.getenv("SCOPE_COMMERCE_SANDBOX_POLICY_JSON") or ""
            sandbox_policy = SandboxPolicy.parse(json.loads(sandbox_raw)) if sandbox_raw else None
        except (ValueError, TypeError):
            raise CommerceProviderError("provider_sandbox_policy_invalid") from None
        return cls(
            enabled=os.getenv("SCOPE_COMMERCE_PROVIDER_ENABLED", "").lower() == "true",
            livemode=os.getenv("SCOPE_COMMERCE_STRIPE_LIVEMODE", "").lower() == "true",
            platform_account_id=os.getenv("SCOPE_COMMERCE_STRIPE_ACCOUNT_ID") or "",
            frontend_origin=origin,
            return_path=os.getenv("SCOPE_COMMERCE_RETURN_PATH") or "/one/profile/account",
            countries=countries,
            fee_configuration_ref=os.getenv("SCOPE_COMMERCE_FEE_CONFIGURATION_REF") or "",
            approval_refs=refs,
            sandbox_policy=sandbox_policy,
            sandbox_policy_required=os.getenv("SCOPE_COMMERCE_SANDBOX_POLICY_REQUIRED", "").lower()
            == "true",
        )

    def validate(self, *, new_activity: bool) -> None:
        parsed = urlsplit(self.frontend_origin)
        runtime_env = os.getenv("ENVIRONMENT", "").lower()
        deploy_env = os.getenv("HUSHH_DEPLOY_ENV", "").lower()
        if self.sandbox_policy_required and self.sandbox_policy is None:
            raise CommerceProviderError("provider_sandbox_policy_required")
        if self.sandbox_policy is not None:
            self.sandbox_policy.validate(
                account_id=self.platform_account_id,
                livemode=self.livemode,
                runtime_environments={runtime_env, deploy_env},
            )
        environment_conflict = (
            runtime_env in {"uat", "production"}
            and deploy_env in {"uat", "production"}
            and runtime_env != deploy_env
        )
        if (
            (new_activity and not self.enabled)
            or environment_conflict
            or ("production" in {runtime_env, deploy_env} and not self.livemode)
            or not self.platform_account_id.startswith("acct_")
            or parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or not self.return_path.startswith("/")
            or self.return_path.startswith("//")
            or "?" in self.return_path
            or "#" in self.return_path
            or "\\" in self.return_path
            or (self.livemode and (len(self.approval_refs) != 5 or not all(self.approval_refs)))
            or (self.livemode and (not self.countries or not self.fee_configuration_ref))
            or (
                self.livemode
                and (
                    "US" not in self.countries
                    or any(not policy.residual_resolution_ref for policy in self.countries.values())
                )
            )
        ):
            raise CommerceProviderError("provider_unavailable")

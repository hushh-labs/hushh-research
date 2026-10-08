"""Pure local provider prerequisites; no SDK, payment proof or secret projection."""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import TYPE_CHECKING, TypedDict

if TYPE_CHECKING:
    from .provider_config import ScopeCommerceProviderConfig


class ProviderPrerequisites(TypedDict):
    ready: bool
    reason_code: str | None


def connect_webhook_reason(*, new_activity: bool, mode: str, connected_secret: str) -> str | None:
    """New endpoint activity needs a separate signing scope; recovery remains allowed."""
    if new_activity and mode == "endpoints" and not connected_secret:
        return "provider_connect_webhook_configuration_required"
    return None


def provider_prerequisites(
    config: ScopeCommerceProviderConfig,
    *,
    new_activity: bool = True,
    environment: Mapping[str, str] | None = None,
) -> ProviderPrerequisites:
    """Validate existing credential rules after the owning configuration admission.

    Explicit environment mappings support replaceable callers without process
    secrets. This proves local setup only, never current provider health or money.
    """
    values = os.environ if environment is None else environment
    secret = values.get("SCOPE_COMMERCE_STRIPE_SECRET_KEY") or ""
    webhook = values.get("SCOPE_COMMERCE_STRIPE_WEBHOOK_SECRET") or ""
    connected = values.get("SCOPE_COMMERCE_STRIPE_CONNECT_WEBHOOK_SECRET") or ""
    mode = values.get("SCOPE_COMMERCE_STRIPE_WEBHOOK_MODE") or "endpoints"
    prefix = "sk_live_" if config.livemode else "sk_test_"
    reason = None
    if not secret.startswith(prefix) or len(secret) < 24:
        reason = "provider_credentials_required"
    elif (
        not webhook.startswith("whsec_")
        or len(webhook) < 20
        or (
            connected
            and (not connected.startswith("whsec_") or len(connected) < 20 or connected == webhook)
        )
    ):
        reason = "provider_webhooks_required"
    elif mode not in {"endpoints", "cli"} or (
        mode == "cli" and (config.livemode or config.sandbox_policy is None)
    ):
        reason = "provider_unavailable"
    elif mode == "cli":
        try:
            config.validate(new_activity=False)
        except RuntimeError as error:
            known = {
                "provider_unavailable",
                "provider_sandbox_policy_required",
                "provider_sandbox_environment_mismatch",
            }
            code = getattr(error, "code", None)
            reason = code if code in known else "provider_unavailable"
    if reason is None:
        reason = connect_webhook_reason(
            new_activity=new_activity, mode=mode, connected_secret=connected
        )
    return {"ready": reason is None, "reason_code": reason}

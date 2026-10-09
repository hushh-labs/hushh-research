"""Sandbox evidence and setup admission; never a customer-money authority."""

from __future__ import annotations

import json
import os
import stat
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

from hushh_mcp.services.scope_commerce.provider_sandbox import SandboxPolicy
from hushh_mcp.services.scope_commerce.stripe_adapter import CommerceProviderError


def private_json(path: str) -> dict[str, Any]:
    file = Path(path)
    try:
        details = file.lstat()
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_uid != os.getuid()
            or details.st_mode & 0o077
        ):
            raise ValueError
        value = json.loads(file.read_text())
        if not isinstance(value, dict):
            raise ValueError
        return value
    except (OSError, ValueError):
        raise CommerceProviderError("sandbox_private_evidence_invalid") from None


def reviewer_bindings(value: dict[str, Any], policy: SandboxPolicy) -> dict[str, str]:
    reviewers = value.get("reviewers")
    if (
        value.get("schema_version") != 1
        or not isinstance(reviewers, dict)
        or set(reviewers) != {"primary", "counterpart"}
    ):
        raise CommerceProviderError("sandbox_reviewer_binding_invalid")
    bindings = {
        role: details.get("user_id")
        for role, details in reviewers.items()
        if isinstance(details, dict) and details.get("identity_binding_ref")
    }
    if len(bindings) != 2 or set(bindings.values()) != set(policy.reviewer_user_ids):
        raise CommerceProviderError("sandbox_reviewer_binding_invalid")
    return bindings


def isolation_evidence(value: dict[str, Any], account_id: str) -> str:
    """An operator attestation, never a claim that Stripe v1 proves isolation."""
    try:
        verified = datetime.fromisoformat(value["verified_at"].replace("Z", "+00:00"))
        now = datetime.now(UTC)
        if (
            value.get("schema_version") != 1
            or value.get("platform_account_id") != account_id
            or value.get("source")
            not in {"dashboard_general_sandbox", "stripe_cli_anonymous_sandbox"}
            or not value.get("reference")
            or not value.get("verification_owner")
            or verified.tzinfo is None
            or verified > now + timedelta(minutes=5)
            or now - verified > timedelta(days=7)
        ):
            raise ValueError
    except (KeyError, TypeError, ValueError, AttributeError):
        raise CommerceProviderError("sandbox_isolation_evidence_invalid") from None
    return value["source"]


def shared_dev_webhook_destination(args: Any, evidence: dict[str, Any], config: Any) -> bool:
    """Admit only the shared Dev commerce mounts at its attested service callback."""
    import re

    names = {
        "platform": "SCOPE_COMMERCE_STRIPE_WEBHOOK_SECRET",
        "connect": "SCOPE_COMMERCE_STRIPE_CONNECT_WEBHOOK_SECRET",
    }
    backend = evidence.get("backend_origin", "")
    project = "hushh-pda-dev"
    return bool(
        args.secret_name == names.get(args.webhook_scope)
        and args.secret_project == evidence.get("secret_project") == project
        and evidence.get("source") == "dashboard_general_sandbox"
        and config.sandbox_policy_required
        and config.frontend_origin == evidence.get("app_origin") == "https://dev.one.hushh.ai"
        and evidence.get("backend_service")
        == "projects/hushh-pda-dev/locations/us-central1/services/consent-protocol"
        and isinstance(backend, str)
        and re.fullmatch(r"https://consent-protocol-[a-z0-9]+-uc\.a\.run\.app", backend)
        and getattr(args, "webhook_url", None) == backend + "/api/payments/scope-commerce/webhook"
    )


def validate_topup(
    topup: dict[str, Any], *, operation_id: str | None = None, amount: int | None = None
) -> None:
    metadata = topup.get("metadata") or {}
    if (
        topup.get("object") != "topup"
        or topup.get("livemode") is not False
        or not isinstance(topup.get("id"), str)
        or not topup["id"].startswith("tu_")
        or topup.get("currency") != "usd"
        or type(topup.get("amount")) is not int
        or topup["amount"] <= 0
        or metadata.get("payment_kind") != "scope_commerce_operating_capital"
        or (
            operation_id is not None
            and metadata.get("scope_operation_id") != operation_id
        )
        or (amount is not None and topup["amount"] != amount)
    ):
        raise CommerceProviderError("sandbox_capital_receipt_mismatch")


def capital_budget(
    topups: list[dict[str, Any]], attempts: dict[str, dict[str, Any]], cap: int
) -> int:
    if not isinstance(attempts, dict):
        raise CommerceProviderError("sandbox_capital_state_invalid")
    for reference, attempt in attempts.items():
        try:
            UUID(reference)
            created = datetime.fromisoformat(attempt["created_at"])
            if (
                type(attempt["amount_cents"]) is not int
                or not 1 <= attempt["amount_cents"] <= cap
                or created.tzinfo is None
                or created > datetime.now(UTC) + timedelta(minutes=5)
            ):
                raise ValueError
        except (KeyError, TypeError, ValueError, AttributeError):
            raise CommerceProviderError("sandbox_capital_state_invalid") from None
    seen: set[str] = set()
    total = 0
    for topup in topups:
        validate_topup(topup)
        total += topup[
            "amount"
        ]  # Refund/reversal never restores gross setup allowance.
        reference = (topup.get("metadata") or {}).get("scope_operation_id")
        if reference:
            if reference in seen:
                raise CommerceProviderError("sandbox_capital_duplicate_attempt")
            seen.add(reference)
            expected = attempts.get(reference)
            if expected:
                validate_topup(
                    topup, operation_id=reference, amount=expected["amount_cents"]
                )
    for reference, attempt in attempts.items():
        if reference not in seen:
            total += attempt[
                "amount_cents"
            ]  # Durable unknown submission stays reserved.
    if total > cap:
        raise CommerceProviderError("sandbox_capital_budget_exceeded")
    return total

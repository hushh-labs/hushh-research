"""Bounded provider GET proofs and operator-only isolated sandbox provisioning."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

from scripts.ops.scope_commerce_sandbox_policy import capital_budget, validate_topup
from scripts.ops.scope_commerce_sandbox_receipts import SandboxReceiptProof

from hushh_mcp.services.scope_commerce.provider_config import (
    ScopeCommerceProviderConfig,
)
from hushh_mcp.services.scope_commerce.provider_contracts import _opaque, _operation_id
from hushh_mcp.services.scope_commerce.stripe_adapter import (
    CommerceProviderError,
    StripeScopeCommerceAdapter,
)

PLATFORM_EVENTS = (
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "checkout.session.expired",
    "refund.created",
    "refund.updated",
    "charge.dispute.created",
    "charge.dispute.closed",
    "topup.succeeded",
    "topup.reversed",
)
CONNECT_EVENTS = ("account.updated", "payout.paid", "payout.failed", "payout.canceled")


class SandboxProvider(SandboxReceiptProof):
    def __init__(
        self, adapter: StripeScopeCommerceAdapter, config: ScopeCommerceProviderConfig
    ) -> None:
        self.adapter, self.config = adapter, config

    async def identity(self) -> dict[str, Any]:
        self.config.validate(new_activity=False)
        if self.config.livemode or self.config.sandbox_policy is None:
            raise CommerceProviderError("sandbox_policy_required")
        account, balance = await asyncio.gather(
            self.adapter.platform_identity(), self.adapter.balance()
        )
        if (
            account.get("id") != self.config.platform_account_id
            or balance.get("livemode") is not False
            or account.get("country") != "US"
            or account.get("default_currency") != "usd"
            or (account.get("settings") or {})
            .get("payouts", {})
            .get("schedule", {})
            .get("interval")
            != "manual"
        ):
            raise CommerceProviderError("sandbox_platform_custody_mismatch")
        return {"account": account, "balance": balance}

    async def listed(self, resource: Any, **parameters: Any) -> list[dict[str, Any]]:
        values: list[dict[str, Any]] = []
        cursor = None
        for _page in range(10):
            page = await self.adapter._call(
                resource.list,
                limit=100,
                **parameters,
                **({"starting_after": cursor} if cursor else {}),
            )
            data = page.get("data")
            if not isinstance(data, list) or any(not isinstance(item, dict) for item in data):
                raise CommerceProviderError("sandbox_provider_list_invalid")
            values.extend(data)
            if page.get("has_more") is False:
                return values
            if not data or data[-1].get("id") == cursor:
                raise CommerceProviderError("sandbox_provider_list_incomplete")
            cursor = data[-1].get("id")
        raise CommerceProviderError("sandbox_provider_list_incomplete")

    async def capital_receipts(self) -> list[dict[str, Any]]:
        listed = await self.listed(self.adapter.stripe_api.Topup)
        topups = [
            item
            for item in listed
            if (item.get("metadata") or {}).get("payment_kind")
            == "scope_commerce_operating_capital"
        ]
        for topup in topups:
            validate_topup(topup)
        return topups

    async def provision_capital(
        self,
        state: dict[str, Any],
        *,
        operation_id: str,
        amount_cents: int,
        persist: Any,
    ) -> dict[str, Any]:
        await self.identity()
        policy = self.config.sandbox_policy
        operation_id = _operation_id(operation_id)
        if (
            type(amount_cents) is not int
            or not 1 <= amount_cents <= policy.operating_capital_cap_cents
        ):
            raise CommerceProviderError("sandbox_capital_budget_exceeded")
        topups = await self.capital_receipts()
        attempts = state.setdefault("capital_attempts", {})
        prior = attempts.get(operation_id)
        if prior and prior["amount_cents"] != amount_cents:
            raise CommerceProviderError("sandbox_capital_attempt_conflict")
        matching = [
            topup
            for topup in topups
            if (topup.get("metadata") or {}).get("scope_operation_id") == operation_id
        ]
        if matching:
            if len(matching) != 1:
                raise CommerceProviderError("sandbox_capital_duplicate_attempt")
            validate_topup(matching[0], operation_id=operation_id, amount=amount_cents)
            if prior and prior.get("provider_id") not in {None, matching[0]["id"]}:
                raise CommerceProviderError("sandbox_capital_attempt_conflict")
            capital_budget(topups, attempts, policy.operating_capital_cap_cents)
            return self._capital_result(matching[0])
        if not prior:
            attempts[operation_id] = {
                "amount_cents": amount_cents,
                "created_at": datetime.now(UTC).isoformat(),
            }
        capital_budget(topups, attempts, policy.operating_capital_cap_cents)
        started = datetime.fromisoformat(attempts[operation_id]["created_at"])
        if datetime.now(UTC) - started >= timedelta(hours=23):
            raise CommerceProviderError("sandbox_capital_reconciliation_required")
        persist(state)  # Commit opaque intent before even a potentially ambiguous network call.
        topup = await self.adapter._call(
            self.adapter.stripe_api.Topup.create,
            amount=amount_cents,
            currency="usd",
            source="btok_us_verified",
            metadata={
                "payment_kind": "scope_commerce_operating_capital",
                "scope_operation_id": operation_id,
            },
            idempotency_key=f"scope-commerce-sandbox-capital-{self.config.platform_account_id}-{operation_id}",
        )
        validate_topup(topup, operation_id=operation_id, amount=amount_cents)
        attempts[operation_id]["provider_id"] = topup["id"]
        persist(state)
        return self._capital_result(topup)

    @staticmethod
    def _capital_result(topup: dict[str, Any]) -> dict[str, Any]:
        return {
            "topupId": topup["id"],
            "amountCents": topup["amount"],
            "status": topup["status"],
            "ledgerCredited": False,
            "requiresSignedReceipt": True,
        }


class WebhookProvisioner:
    """Separate snapshot endpoint scopes; returned secrets go only to a private sink."""

    def __init__(self, provider: SandboxProvider) -> None:
        self.provider = provider

    async def provision(
        self,
        *,
        scope: str,
        url: str,
        api_version: str,
        operation_id: str,
        state: dict[str, Any],
        persist: Any,
        write_secret: Any,
    ) -> dict[str, Any]:
        await self.provider.identity()
        operation_id = _operation_id(operation_id)
        request = self._request(scope, url, api_version, operation_id)
        digest = _opaque(json.dumps(request, sort_keys=True))
        attempts = state.setdefault("webhook_attempts", {})
        prior = attempts.get(operation_id)
        if prior and prior["request_hash"] != digest:
            raise CommerceProviderError("sandbox_webhook_attempt_conflict")
        endpoints = await self.provider.listed(self.provider.adapter.stripe_api.WebhookEndpoint)
        matching = [
            item
            for item in endpoints
            if (item.get("metadata") or {}).get("scope_operation_id") == operation_id
        ]
        if len(matching) > 1:
            raise CommerceProviderError("sandbox_webhook_duplicate_attempt")
        if matching:
            self._validate_endpoint(matching[0], request)
            if prior is None or prior.get("provider_id") not in {
                None,
                matching[0]["id"],
            }:
                raise CommerceProviderError("sandbox_webhook_secret_recovery_required")
        if not prior:
            attempts[operation_id] = {
                "created_at": datetime.now(UTC).isoformat(),
                "request_hash": digest,
            }
        started = datetime.fromisoformat(attempts[operation_id]["created_at"])
        if datetime.now(UTC) - started >= timedelta(hours=23):
            raise CommerceProviderError("sandbox_webhook_secret_recovery_required")
        persist(state)
        endpoint = await self.provider.adapter._call(
            self.provider.adapter.stripe_api.WebhookEndpoint.create,
            **request,
            idempotency_key=f"scope-commerce-sandbox-webhook-{operation_id}",
        )
        self._validate_endpoint(endpoint, request)
        secret = endpoint.get("secret")
        if not isinstance(secret, str) or not secret.startswith("whsec_"):
            raise CommerceProviderError("sandbox_webhook_secret_recovery_required")
        write_secret(secret)
        attempts[operation_id]["provider_id"] = endpoint["id"]
        persist(state)
        return {
            "webhookId": endpoint["id"],
            "scope": scope,
            "apiVersion": api_version,
            "status": "configured",
            "secretStored": True,
            "requiresSignedDelivery": True,
        }

    @staticmethod
    def _request(scope: str, url: str, api_version: str, operation_id: str) -> dict[str, Any]:
        parsed = urlsplit(url)
        if (
            scope not in {"platform", "connect"}
            or parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path != "/api/payments/scope-commerce/webhook"
            or parsed.port not in {None, 443}
            or not api_version
        ):
            raise CommerceProviderError("sandbox_webhook_configuration_invalid")
        events = CONNECT_EVENTS if scope == "connect" else PLATFORM_EVENTS
        return {
            "url": url,
            "connect": scope == "connect",
            "enabled_events": list(events),
            "api_version": api_version,
            "metadata": {
                "payment_kind": "scope_commerce_sandbox_webhook",
                "scope_operation_id": operation_id,
                "scope": scope,
            },
        }

    @staticmethod
    def _validate_endpoint(endpoint: dict[str, Any], request: dict[str, Any]) -> None:
        if (
            endpoint.get("object") != "webhook_endpoint"
            or endpoint.get("livemode") is not False
            or endpoint.get("url") != request["url"]
            or endpoint.get("metadata") != request["metadata"]
            or set(endpoint.get("enabled_events") or []) != set(request["enabled_events"])
            or endpoint.get("api_version") != request["api_version"]
            or endpoint.get("status") != "enabled"
            or bool(endpoint.get("application")) != request["connect"]
        ):
            raise CommerceProviderError("sandbox_webhook_receipt_mismatch")

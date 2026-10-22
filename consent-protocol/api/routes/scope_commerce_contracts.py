"""Shared authority, errors and public shapes for scope-commerce routes."""

from __future__ import annotations

import os
import re
from typing import Annotated, Any

from fastapi import Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth_read_only, require_vault_owner_token
from hushh_mcp.services.scope_commerce import ScopeCommerceService
from hushh_mcp.services.scope_commerce.domain import public

NO_STORE = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}
Payer = Annotated[str, Depends(require_firebase_auth_read_only)]
Owner = Annotated[dict, Depends(require_vault_owner_token)]


def _service() -> ScopeCommerceService:
    return ScopeCommerceService()


def _provider():
    from hushh_mcp.services.scope_commerce.provider_service import ScopeCommerceProviderService

    return ScopeCommerceProviderService(_service())


def _enabled() -> bool:
    return os.getenv("SCOPE_COMMERCE_ENABLED", "").lower() == "true"


def _snake(value: Any) -> Any:
    if isinstance(value, list):
        return [_snake(item) for item in value]
    if not isinstance(value, dict):
        return value
    return {
        re.sub(r"(?<!^)(?=[A-Z])", "_", key).lower(): _snake(item) for key, item in value.items()
    }


def _error(error: Exception) -> HTTPException:
    code = getattr(error, "code", str(error))
    codes = {
        "request_unavailable": 404,
        "purchase_unavailable": 404,
        "quote_unavailable": 404,
        "scope_unavailable": 409,
        "recipient_or_scope_unavailable": 409,
        "recipient_key_changed": 409,
        "payer_delegation_required": 409,
        "insufficient_balance": 409,
        "seller_not_eligible": 409,
        "quote_expired": 409,
        "owner_approval_required": 409,
        "idempotency_conflict": 409,
        "buyer_cancellation_after_activation_denied": 409,
        "invalid_tariff": 422,
        "invalid_duration": 422,
        "quote_exceeds_limit": 422,
        "invalid_funding_amount": 422,
        "payment_invalid_signature": 400,
        "provider_invalid_signature": 400,
        "provider_invalid_event": 400,
        "provider_configuration_invalid": 503,
        "provider_configuration_required": 503,
        "provider_credentials_required": 503,
        "provider_webhooks_required": 503,
        "provider_connect_webhook_configuration_required": 503,
        "provider_sandbox_policy_required": 503,
        "provider_sandbox_reviewer_required": 403,
        "commerce_environment_mismatch": 409,
        "commerce_environment_unbound": 503,
        "commerce_unavailable": 503,
        "commerce_schema_required": 503,
        "seller_onboarding_required": 409,
        "payer_app_binding_required": 404,
        "registered_recipient_key_required": 409,
        "approved_duration_exceeds_request": 422,
        "negative_net_acknowledgement_required": 409,
        "invalid_activity_cursor": 422,
        "invalid_activity_view": 422,
        "invalid_activity_limit": 422,
        "sandbox_readiness_unavailable": 404,
        "sandbox_readiness_unbound": 503,
    }
    safe_code = code if code in codes else "scope_commerce_unavailable"
    return HTTPException(codes.get(code, 503), detail={"code": safe_code}, headers=NO_STORE)


def _quote(row: dict) -> dict:
    data = _snake(row)
    return {
        **data,
        "id": data.get("quote_id") or data.get("id"),
        "amount_cents": data.get("price_cents", data.get("amount_cents")),
        "currency": "USD",
        "expires_at": data.get("quote_expires_at", data.get("expires_at")),
    }


def _purchase(row: dict) -> dict:
    # A lookup row may contain the staged ciphertext and token hash. Only the
    # commercial public contract may cross this generic status boundary.
    data = _snake(public(row) if "purchase_id" in row else row)
    return {
        **data,
        "id": data.get("purchase_id") or data.get("id"),
        "amount_cents": data.get("price_cents", data.get("amount_cents")),
    }


def _withdrawal(row: Any) -> dict:
    settled = row["settled_micro_usd"]
    fee = row["fee_micro_usd"]
    if settled is not None:
        fee = settled - row["net_cents"] * 10_000 if row["status"] == "succeeded" else settled
    return {
        "id": str(row["withdrawal_id"]),
        "status": row["status"],
        "net_cents": row["net_cents"],
        "fee_micro_usd": fee,
        "fees_final": settled is not None,
        "created_at": row["created_at"].isoformat(),
    }


class StrictBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NegativeNetAcknowledgement(StrictBody):
    version: int = Field(strict=True, ge=1, le=1)
    binding: str = Field(pattern=r"^[0-9a-f]{64}$")
    acknowledged: bool = Field(strict=True)

"""Bounded Sandbox recovery of a proven cached pre-Connect account rejection.

The original durable operation and metadata remain authoritative. One persisted
replacement transport key may be used only after complete provider recovery.
Unknown outcomes never authorize another key or a direct ledger write.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

from hushh_mcp.services.scope_commerce.provider_contracts import _derived_id, _opaque
from hushh_mcp.services.scope_commerce.stripe_adapter import CommerceProviderError


def _require(condition: bool) -> None:
    if not condition:
        raise CommerceProviderError("sandbox_seller_recovery_unverified")


async def recover_seller_account(
    service, *, user_id: str, evidence: dict[str, Any], state: dict[str, Any], persist
) -> dict[str, Any]:
    """Use the ordinary runner and seller binding; never mutate financial rows."""
    config = service.config
    _require(
        config.livemode is False
        and config.sandbox_policy_required
        and config.sandbox_policy is not None
        and config.sandbox_policy.platform_account_id == config.platform_account_id
        and state.get("platform_account_id") == config.platform_account_id
    )
    service._admit_actor(user_id)

    async def require_pin(connection):
        pin = await connection.fetchrow(
            "SELECT platform_account_id,livemode FROM scope_commerce_environment WHERE singleton"
        )
        _require(
            pin is not None
            and pin["platform_account_id"] == config.platform_account_id
            and pin["livemode"] is False
        )

    await service.store._transaction(require_pin)
    await service._admit()
    operation_id = _derived_id(user_id, "seller_account")
    operation = await service._existing_operation(operation_id)
    _require(operation is not None)
    request = service._saved_request(operation)
    encoded = json.dumps(request, sort_keys=True, separators=(",", ":"))
    digest = _opaque(encoded)
    country = request.get("country")
    original_key = f"scope-commerce-seller_account-{operation_id}"
    _require(country in config.countries)
    _require(
        evidence.get("platform_account_id") == config.platform_account_id
        and evidence.get("livemode") is False
        and evidence.get("operation_id") == operation_id
        and evidence.get("idempotency_key") == original_key
        and evidence.get("http_status") == 400
        and evidence.get("error_class") == "connect_not_enabled"
        and evidence.get("idempotent_replayed") is True
        and isinstance(evidence.get("original_request_id"), str)
        and evidence["original_request_id"].startswith("req_")
        and isinstance(evidence.get("replayed_request_id"), str)
        and evidence["replayed_request_id"].startswith("req_")
        and evidence["original_request_id"] != evidence["replayed_request_id"]
    )
    try:
        verified = datetime.fromisoformat(evidence["verified_at"])
        _require(timedelta(0) <= datetime.now(UTC) - verified < timedelta(hours=1))
    except (KeyError, TypeError, ValueError):
        raise CommerceProviderError("sandbox_seller_recovery_unverified") from None

    async def check(*, dispatch=False):
        row = await service._existing_operation(operation_id)
        _require(
            row is not None
            and row["user_id"] == user_id
            and row["kind"] == "seller_account"
            and row["request_hash"] == digest
            and service._saved_request(row) == request
            and row["created_at"] == operation["created_at"]
            and timedelta(0) <= datetime.now(UTC) - row["created_at"] < timedelta(hours=23)
        )
        if dispatch:
            _require(
                row["status"] == "submitted"
                and row["lease_until"] is not None
                and row["lease_until"] > datetime.now(UTC)
            )
        else:
            _require(
                row["status"] in {"reconciliation_required", "succeeded"}
                and row.get("lease_until") is None
            )
        return row

    await check()
    # Validate the immutable intent with the canonical seller request contract.
    _require(await service._seller_creation_request(user_id, country, operation_id) == request)
    if operation["status"] == "succeeded":
        return await service._prepare_seller_account(user_id=user_id, country=country)
    _require(operation.get("provider_id") is None)
    _require(await service._seller_binding(user_id) is None)
    replacement = f"{original_key}-connect-enabled-v1"
    intent = {
        "request_hash": digest,
        "transport_key": replacement,
        "created_at": operation["created_at"].isoformat(),
    }
    attempts = state.setdefault("seller_account_recoveries", {})
    _require(operation_id not in attempts or attempts[operation_id] == intent)
    attempts[operation_id] = intent
    persist(state)  # fsync under the existing exclusive operator-state lock before I/O.
    create = service.adapter.create

    async def bounded_create(kind, parameters, *, idempotency_key):
        _require(
            kind == "seller_account" and parameters == request and idempotency_key == original_key
        )
        claimed = await check(dispatch=True)
        # Reconcile once more immediately before dispatch. Incomplete listing,
        # ambiguity, provider failure, or any object conflict refuses creation.
        existing = await service.adapter.recover(
            kind,
            operation_id,
            parameters,
            created=int(operation["created_at"].timestamp()),
        )
        if existing is not None:
            return existing
        fresh = await check(dispatch=True)
        _require(fresh["lease_until"] == claimed["lease_until"])
        return await create(kind, parameters, idempotency_key=replacement)

    service.adapter.create = bounded_create
    try:
        return await service._prepare_seller_account(user_id=user_id, country=country)
    finally:
        service.adapter.create = create

"""Provider value contracts and shared admission ports; one canonical store.

Lifecycle classes compose these ports through the service facade. They never
instantiate another ledger, provider adapter or consent authority.
"""

from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit
from uuid import UUID, uuid5

from .provider_config import ScopeCommerceProviderConfig
from .stripe_adapter import CommerceProviderError, ScopeCommerceProvider

if TYPE_CHECKING:
    from .service import ScopeCommerceService

_NAMESPACE = UUID("d55da771-41e6-42da-82e3-46fdb1c65c83")


def _opaque(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _operation_id(value: str) -> str:
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise CommerceProviderError("provider_operation_invalid") from None


def _derived_id(user_id: str, kind: str) -> str:
    return str(uuid5(_NAMESPACE, f"{kind}:{user_id}"))


def _hosted_url(value: Any, hosts: set[str]) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlsplit(value)
    return (
        parsed.scheme == "https"
        and parsed.hostname in hosts
        and parsed.username is None
        and parsed.password is None
        and parsed.port in {None, 443}
    )


def _projection(kind: str, response: dict[str, Any]) -> dict[str, Any]:
    """Persist operational binding, never a full customer/bank/provider response."""
    fields = {
        "id",
        "object",
        "metadata",
        "livemode",
        "created",
        "status",
        "amount",
        "currency",
        "customer",
        "payment_intent",
        "charge",
        "balance_transaction",
        "failure_balance_transaction",
        "destination",
        "amount_reversed",
        "reversed",
        "transfer_group",
        "transfer",
        "country",
        "details_submitted",
        "payouts_enabled",
        "capabilities",
        "mode",
        "client_reference_id",
        "amount_total",
        "payment_status",
        "url",
        "expires_at",
    }
    result = {key: response[key] for key in fields if key in response}
    if "metadata" in result:
        result["metadata"] = {
            key: value
            for key, value in result["metadata"].items()
            if key
            in {
                "payment_kind",
                "scope_operation_id",
                "payer_ref",
                "buyer_app_ref",
                "withdrawal_id",
                "recovery_id",
                "dispute_id",
            }
        }
    if kind == "seller_account":
        result["requirements"] = {
            "disabled_reason": (response.get("requirements") or {}).get("disabled_reason")
        }
        result["settings"] = {
            "payouts": {
                "schedule": (response.get("settings") or {}).get("payouts", {}).get("schedule")
            }
        }
    return result


class ProviderContext:
    store: ScopeCommerceService
    adapter: ScopeCommerceProvider
    config: ScopeCommerceProviderConfig
    _operation_id = staticmethod(_operation_id)
    _derived_id = staticmethod(_derived_id)
    _projection = staticmethod(_projection)

    async def _admit(self, *, new_activity: bool = True) -> None:
        self.config.validate(new_activity=new_activity)
        identity = await self.adapter.platform_identity()
        balance = await self.adapter.balance()
        if (
            identity.get("id") != self.config.platform_account_id
            or identity.get("country") != "US"
            or balance.get("livemode") is not self.config.livemode
        ):
            raise CommerceProviderError("provider_account_mismatch")
        await self.store.bind_environment(
            platform_account_id=identity["id"], livemode=balance["livemode"]
        )
        if new_activity:
            if (
                identity.get("default_currency") != "usd"
                or (identity.get("settings") or {})
                .get("payouts", {})
                .get("schedule", {})
                .get("interval")
                != "manual"
            ):
                raise CommerceProviderError("provider_platform_custody_configuration_required")

            async def retention(connection: Any) -> bool:
                return await connection.fetchval("""SELECT EXISTS(SELECT 1 FROM scope_commerce_obligations
                    WHERE kind='recovery' AND idempotency_key LIKE 'retention:%' AND status<>'succeeded')""")

            if await self.store._transaction(retention):
                raise CommerceProviderError("provider_retention_resolution_required")

    def _metadata(self, operation_id: str, user_id: str) -> dict[str, str]:
        return {
            "payment_kind": "scope_commerce",
            "scope_operation_id": operation_id,
            "payer_ref": _opaque(user_id),
        }

    async def _existing_operation(self, operation_id: str) -> dict[str, Any] | None:
        async def read(connection: Any) -> dict[str, Any] | None:
            row = await connection.fetchrow(
                "SELECT * FROM scope_commerce_provider_operations WHERE operation_id=$1::uuid",
                operation_id,
            )
            return dict(row) if row else None

        return await self.store._transaction(read)

    @staticmethod
    def _saved_request(operation: dict[str, Any]) -> dict[str, Any]:
        request = operation["request_json"]
        return json.loads(request) if isinstance(request, str) else dict(request)

    def _validate_object(
        self, response: dict[str, Any], *, object_type: str, metadata: dict[str, str]
    ) -> None:
        if (
            response.get("object") != object_type
            or not isinstance(response.get("id"), str)
            or any((response.get("metadata") or {}).get(k) != v for k, v in metadata.items())
            or ("livemode" in response and response["livemode"] is not self.config.livemode)
        ):
            raise CommerceProviderError("provider_response_mismatch")

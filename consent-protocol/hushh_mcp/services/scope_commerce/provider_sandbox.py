"""Test-only reviewer admission; canonical funding rows own every reservation."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from .stripe_adapter import CommerceProviderError


@dataclass(frozen=True)
class SandboxPolicy:
    platform_account_id: str
    reviewer_user_ids: tuple[str, str] = field(repr=False)
    reviewer_funding_cap_cents: int = 2000
    operating_capital_cap_cents: int = 2500

    @classmethod
    def parse(cls, value: Any) -> SandboxPolicy:
        keys = {
            "environment",
            "platform_account_id",
            "reviewer_user_ids",
            "reviewer_funding_cap_cents",
            "operating_capital_cap_cents",
        }
        if not isinstance(value, dict) or set(value) != keys or value["environment"] != "sandbox":
            raise CommerceProviderError("provider_sandbox_policy_invalid")
        users = value["reviewer_user_ids"]
        account_id = value["platform_account_id"]
        funding = value["reviewer_funding_cap_cents"]
        capital = value["operating_capital_cap_cents"]
        if not isinstance(users, list):
            raise CommerceProviderError("provider_sandbox_policy_invalid")
        return cls(account_id, tuple(users), funding, capital)

    def __post_init__(self) -> None:
        if (
            not isinstance(self.platform_account_id, str)
            or not self.platform_account_id.startswith("acct_")
            or not isinstance(self.reviewer_user_ids, tuple)
            or len(self.reviewer_user_ids) != 2
            or any(not isinstance(user, str) or not user.strip() for user in self.reviewer_user_ids)
            or self.reviewer_user_ids[0] == self.reviewer_user_ids[1]
            or type(self.reviewer_funding_cap_cents) is not int
            or not 50 <= self.reviewer_funding_cap_cents <= 2000
            or type(self.operating_capital_cap_cents) is not int
            or not 1 <= self.operating_capital_cap_cents <= 2500
        ):
            raise CommerceProviderError("provider_sandbox_policy_invalid")

    def validate(self, *, account_id: str, livemode: bool, runtime_environments: set[str]) -> None:
        if (
            livemode
            or self.platform_account_id != account_id
            or "production" in runtime_environments
            or not runtime_environments.intersection(
                {"sandbox", "test", "uat", "local", "development"}
            )
        ):
            raise CommerceProviderError("provider_sandbox_environment_mismatch")


async def reserve_reviewer_funding(
    store: Any,
    policy: SandboxPolicy,
    *,
    payer_user_id: str,
    buyer_app_id: str | None,
    funding_id: str,
    amount_cents: int,
) -> dict[str, Any]:
    if payer_user_id not in policy.reviewer_user_ids:
        raise CommerceProviderError("provider_sandbox_reviewer_required")

    async def reserve(connection: Any) -> dict[str, Any]:
        wallet = await store._wallet(connection, payer_user_id, buyer_app_id)
        old = await connection.fetchrow(
            "SELECT wallet_id,amount_cents FROM scope_commerce_fundings WHERE funding_id=$1::uuid",
            UUID(funding_id),
        )
        if old is None:
            total = await connection.fetchval(
                """SELECT COALESCE(sum(f.amount_cents),0)::bigint
                FROM scope_commerce_fundings f JOIN scope_commerce_wallets w USING(wallet_id)
                LEFT JOIN scope_commerce_provider_operations o ON o.operation_id=f.funding_id AND o.kind='funding'
                WHERE (w.payer_user_id=$1 OR o.request_json->'metadata'->>'payer_ref'=$2)
                AND f.status<>'cancelled'""",
                payer_user_id,
                hashlib.sha256(payer_user_id.encode()).hexdigest(),
            )
            if total + amount_cents > policy.reviewer_funding_cap_cents:
                raise CommerceProviderError("provider_sandbox_funding_budget_exceeded")
        elif old["wallet_id"] != wallet["wallet_id"] or old["amount_cents"] != amount_cents:
            raise CommerceProviderError("provider_operation_conflict")
        # This runs inside the existing global commerce transaction gate. Refunds
        # never replenish gross funding allowance; uncertain attempts remain held.
        return await store.reserve_funding(
            payer_user_id=payer_user_id,
            buyer_app_id=buyer_app_id,
            funding_id=funding_id,
            amount_cents=amount_cents,
            conn=connection,
        )

    return await store._transaction(reserve)

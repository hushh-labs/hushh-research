"""Test-only reviewer admission; canonical funding rows own every reservation."""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from uuid import UUID

from .stripe_adapter import CommerceProviderError

if TYPE_CHECKING:
    from hushh_mcp.services.account_generation_service import AccountPrincipal


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
                {"sandbox", "test", "uat", "local", "dev", "development"}
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


async def waive_reviewer_seller_residual(
    service: Any,
    *,
    principal: AccountPrincipal,
    seller_id: str,
    seller_account_id: str,
    obligation_id: str,
    amount_micro_usd: int,
    expected_pending_micro_usd: int,
    approval_ref: str,
) -> dict[str, str]:
    """Trusted Dev operator port after verified owner admission and explicit waiver.

    This is forgiveness of reviewed test earnings, never a payout or a production
    residual policy. The caller retains the human approval behind its digest.
    Native provider identity is read before taking lifecycle/accounting locks.
    """
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        AccountDeletionLifecycleService,
        account_deletion_user_hash,
    )
    from hushh_mcp.services.account_generation_service import AccountPrincipal

    from .domain import CommerceError, account, fingerprint, integer, payout_terms

    config, store = service.config, service.store
    policy = config.sandbox_policy
    if (
        os.getenv("HUSHH_DEPLOY_ENV") != "dev"
        or os.getenv("ENVIRONMENT", "").lower()
        not in {"", "dev", "development", "sandbox", "test", "local"}
        or config.livemode is not False
        or policy is None
        or "US" not in config.countries
    ):
        raise CommerceProviderError("provider_sandbox_environment_mismatch")
    config.validate(new_activity=False)
    if (
        not isinstance(principal, AccountPrincipal)
        or principal.owner_id not in policy.reviewer_user_ids
    ):
        raise CommerceProviderError("provider_sandbox_reviewer_required")
    if not isinstance(approval_ref, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", approval_ref):
        raise CommerceError("sandbox_waiver_approval_required")
    integer(amount_micro_usd, 1, 10**18, "invalid_earnings_amount")
    integer(expected_pending_micro_usd, 0, 10**18, "invalid_earnings_amount")
    seller_id, obligation_id = str(UUID(seller_id)), str(UUID(obligation_id))
    identity, balance = await service.adapter.platform_identity(), await service.adapter.balance()
    if (
        identity.get("id") != config.platform_account_id
        or identity.get("country") != "US"
        or balance.get("livemode") is not False
    ):
        raise CommerceProviderError("provider_account_mismatch")
    key = f"sandbox_seller_waiver:{approval_ref}"
    digest = fingerprint(
        [
            principal.firebase_uid,
            principal.owner_id,
            principal.generation,
            config.platform_account_id,
            seller_id,
            seller_account_id,
            obligation_id,
            amount_micro_usd,
            expected_pending_micro_usd,
            approval_ref,
        ]
    )

    async def waive(connection: Any) -> dict[str, str]:
        pin = await store._environment(
            connection, seller_user_id=principal.owner_id, livemode=False
        )
        if pin["platform_account_id"] != config.platform_account_id or pin["livemode"] is not False:
            raise CommerceProviderError("provider_account_mismatch")
        seller = await connection.fetchrow(
            "SELECT * FROM scope_commerce_sellers WHERE seller_id=$1::uuid FOR UPDATE", seller_id
        )
        if (
            not seller
            or seller["owner_user_id"] != principal.owner_id
            or seller["erased_at"] is not None
        ):
            raise CommerceError("sandbox_waiver_owner_changed")
        binding = await connection.fetchrow(
            "SELECT account_id,country,livemode FROM scope_commerce_seller_accounts WHERE user_id=$1",
            principal.owner_id,
        )
        if (
            not binding
            or (binding["account_id"], binding["country"], binding["livemode"])
            != (seller_account_id, seller["country"], False)
            or seller["account_id"] != seller_account_id
            or seller["livemode"] is not False
        ):
            raise CommerceError("sandbox_waiver_owner_changed")
        postings = {
            account("seller_payable", seller_id): -amount_micro_usd,
            account("sandbox_seller_waiver"): amount_micro_usd,
        }
        old = await connection.fetchrow(
            "SELECT * FROM scope_commerce_financial_events WHERE event_id=$1", key
        )
        if old:
            if (old["kind"], old["reference_id"], old["request_hash"]) != (
                "sandbox_seller_waiver",
                obligation_id,
                digest,
            ) or not await connection.fetchval(
                "SELECT EXISTS(SELECT 1 FROM scope_commerce_journal WHERE idempotency_key=$1)", key
            ):
                raise CommerceError("idempotency_conflict")
        else:
            obligation = await connection.fetchrow(
                "SELECT * FROM scope_commerce_obligations WHERE obligation_id=$1::uuid FOR UPDATE",
                obligation_id,
            )
            if (
                not obligation
                or str(obligation["seller_id"]) != seller_id
                or obligation["kind"] != "recovery"
                or obligation["source_id"] != "retention"
                or obligation["idempotency_key"] != f"retention:seller:{seller_id}"
                or obligation["status"] != "manual_review"
                or any(
                    obligation[k] is not None
                    for k in ("provider_id", "first_dispatch_at", "lease_expires_at")
                )
                or await store._amount(connection, account("seller_payable", seller_id))
                != amount_micro_usd
                or await store._amount(connection, account("seller_pending", seller_id))
                != expected_pending_micro_usd
                or await store._amount(connection, account("seller_debt", seller_id)) != 0
                or await connection.fetchval(
                    """SELECT EXISTS(SELECT 1 FROM scope_commerce_withdrawals WHERE seller_id=$1::uuid
                    AND status NOT IN ('succeeded','failed')) OR EXISTS(
                    SELECT 1 FROM scope_commerce_obligations WHERE seller_id=$1::uuid
                    AND obligation_id<>$2::uuid AND status NOT IN ('succeeded','failed')) OR EXISTS(
                    SELECT 1 FROM scope_commerce_provider_operations WHERE user_id=$3
                    AND status<>'succeeded') OR EXISTS(SELECT 1 FROM scope_commerce_provider_operations
                    WHERE operation_id=$2::uuid)""",
                    seller_id,
                    obligation_id,
                    principal.owner_id,
                )
            ):
                raise CommerceError("sandbox_waiver_snapshot_changed")
            country = config.countries[seller["country"]]
            if payout_terms(
                amount_micro_usd,
                country.fixed_fee_micro_usd,
                country.fee_basis_points,
                country.minimum_cents,
            )["net_cents"] >= max(50, country.minimum_cents):
                raise CommerceError("sandbox_waiver_withdrawable_earnings")
            await connection.execute(
                """INSERT INTO scope_commerce_financial_events(event_id,kind,reference_id,request_hash)
                VALUES($1,'sandbox_seller_waiver',$2,$3)""",
                key,
                obligation_id,
                digest,
            )
        entry = await store._post(connection, key, "sandbox_seller_waiver", postings, obligation_id)
        await service._close_resolved_retention(
            connection, retention_days=config.countries["US"].retention_days
        )
        return {
            "status": "recorded",
            "entryId": str(entry),
            "approvalRef": approval_ref,
            "obligationId": obligation_id,
        }

    pool = store.pool
    if pool is None:
        from db.connection import get_pool

        pool = await get_pool()
    async with pool.acquire() as connection:
        async with connection.transaction():
            # Lifecycle barriers precede the global commerce lock, matching erasure.
            if await AccountDeletionLifecycleService.active_projection_user_ids(
                connection, user_ids=[principal.owner_id]
            ) != {principal.owner_id}:
                raise CommerceError("sandbox_waiver_owner_changed")
            generation = await connection.fetchrow(
                """SELECT identity_uid,owner_id,generation,retired_at FROM account_generations
                WHERE identity_hash=$1 ORDER BY generation DESC LIMIT 1 FOR SHARE""",
                account_deletion_user_hash(principal.firebase_uid),
            )
            if (
                generation is None
                and (principal.generation != 0 or principal.owner_id != principal.firebase_uid)
            ) or (
                generation is not None
                and (
                    generation["retired_at"] is not None
                    or (
                        generation["identity_uid"],
                        generation["owner_id"],
                        generation["generation"],
                    )
                    != (principal.firebase_uid, principal.owner_id, principal.generation)
                )
            ):
                raise CommerceError("sandbox_waiver_owner_changed")
            return await store._transaction(waive, conn=connection)

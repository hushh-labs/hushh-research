"""Reconcile committed operations, events and payout stages without new admission."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from .domain import CommerceError
from .provider_contracts import ProviderContext
from .stripe_adapter import CommerceProviderError


class ReconciliationCoordinator(ProviderContext):
    async def reconcile(self, *, max_operations: int = 20) -> dict[str, int]:
        """Bounded durable drain, safe while admission for new purchases is disabled."""
        await self._admit(new_activity=False)
        limit = max(1, min(max_operations, 100))

        async def pending(connection: Any) -> list[dict[str, Any]]:
            rows = await connection.fetch(
                """SELECT o.* FROM scope_commerce_provider_operations o
                WHERE (status IN ('submitted','reconciliation_required') OR
                  (status='succeeded' AND (
                    (kind='funding' AND NOT EXISTS(SELECT 1 FROM scope_commerce_fundings f
                       WHERE f.funding_id=o.operation_id AND f.status IN ('paid','cancelled')))
                    OR (kind='refund' AND NOT EXISTS(SELECT 1 FROM scope_commerce_obligations f
                       WHERE f.obligation_id=o.operation_id AND f.status IN ('succeeded','failed')))
                    OR (kind='payout' AND NOT EXISTS(SELECT 1 FROM scope_commerce_withdrawals w
                       WHERE w.withdrawal_id::text=o.request_json->'metadata'->>'withdrawal_id'
                       AND w.status IN ('succeeded','failed'))))))
                AND (lease_until IS NULL OR lease_until<clock_timestamp())
                ORDER BY updated_at,operation_id LIMIT $1""",
                limit,
            )
            return [dict(row) for row in rows]

        examined = completed = uncertain = 0
        for operation in await self.store._transaction(pending):
            examined += 1
            request = operation["request_json"]
            request = json.loads(request) if isinstance(request, str) else request
            try:
                if not await self._reconcile_provider_operation(operation, request):
                    uncertain += 1
                    await self._defer_operation_reconciliation(operation["operation_id"])
                    continue
                completed += 1
            except (CommerceProviderError, CommerceError):
                uncertain += 1
                await self._defer_operation_reconciliation(operation["operation_id"])
        events = await self._resume_events(limit=limit)
        recoveries = await self._drain_transfer_recoveries(limit=min(limit, 20))
        drained = await self._resume_withdrawals(limit=limit)
        retention = await self._retention_sweep(limit=limit)
        refunds = await self._drain_source_refunds(limit=min(limit, 20))
        weekly = await self._weekly_batch(limit=limit) if self.config.enabled else 0
        return {
            "examined": examined,
            "reconciled": completed,
            "uncertain": uncertain,
            "withdrawalsResumed": drained,
            "eventsResumed": events,
            "transferRecoveries": recoveries,
            "weeklyWithdrawals": weekly,
            "sourceRefundsResumed": refunds,
            "retentionObligations": retention,
        }

    async def _defer_operation_reconciliation(self, operation_id: Any) -> None:
        async def defer(connection: Any) -> None:
            await connection.execute(
                """UPDATE scope_commerce_provider_operations
                SET lease_until=clock_timestamp()+interval '1 minute',updated_at=clock_timestamp()
                WHERE operation_id=$1::uuid""",
                str(operation_id),
            )

        await self.store._transaction(defer)

    async def _reconcile_provider_operation(
        self, operation: dict[str, Any], request: dict[str, Any]
    ) -> bool:
        response = None
        if operation["provider_id"] and operation["kind"] != "transfer_reversal":
            response = await self.adapter.retrieve(
                operation["kind"],
                operation["provider_id"],
                account_id=request.get("stripe_account"),
            )
        else:
            response = await self.adapter.recover(
                operation["kind"],
                str(operation["operation_id"]),
                request,
                created=int(operation["created_at"].timestamp()),
            )
        if response is None:
            return False
        kind = operation["kind"]
        if kind != "onboarding":
            object_type = {"funding": "checkout.session", "seller_account": "account"}.get(
                kind, kind
            )
            self._validate_object(
                response, object_type=object_type, metadata=request.get("metadata", {})
            )
            self._validate_recovered(kind, response, request, str(operation["operation_id"]))

        async def bind(
            connection: Any,
            op: dict[str, Any] = operation,
            value: dict[str, Any] = response,
        ) -> None:
            await connection.execute(
                """UPDATE scope_commerce_provider_operations
                SET provider_id=$2,provider_response=$3::jsonb,status='succeeded',lease_until=NULL,updated_at=clock_timestamp()
                WHERE operation_id=$1::uuid""",
                str(op["operation_id"]),
                value["id"],
                json.dumps(self._projection(op["kind"], value)),
            )

        await self.store._transaction(bind)
        if kind == "funding" and response.get("payment_status") == "paid":
            await self._settle_funding_session(response, event_id=f"reconcile:{response['id']}")
        elif kind == "funding" and response.get("status") == "expired":
            await self.store.expire_funding(funding_id=str(operation["operation_id"]))
        elif kind == "funding":
            return await self._cancel_failed_funding_session(response)
        elif kind == "refund":
            await self.store.settle_funding_refund(
                refund_id=str(operation["operation_id"]),
                provider_refund_id=response["id"],
                status=self._refund_state(response["status"]),
            )
        elif kind == "payout":
            await self._settle_payout(response, account_id=request["stripe_account"])
        elif kind == "transfer":
            await self.store.settle_withdrawal(
                withdrawal_id=str(operation["operation_id"]),
                transfer_id=response["id"],
                status="transferred",
            )
        return True

    def _validate_recovered(
        self, kind: str, response: dict[str, Any], request: dict[str, Any], operation_id: str
    ) -> None:
        if kind == "funding":
            amount = request["line_items"][0]["price_data"]["unit_amount"]
            valid = (
                response.get("mode") == "payment"
                and response.get("customer") == request["customer"]
                and response.get("client_reference_id") == operation_id
                and response.get("amount_total") == amount
                and response.get("currency") == "usd"
                and response.get("livemode") is self.config.livemode
            )
        elif kind in {"refund", "transfer", "payout", "transfer_reversal"}:
            valid = (
                response.get("amount") == request["amount"] and response.get("currency") == "usd"
            )
            if kind == "refund":
                valid = valid and response.get("payment_intent") == request["payment_intent"]
            elif kind == "transfer":
                valid = (
                    valid
                    and response.get("destination") == request["destination"]
                    and response.get("transfer_group") == request["transfer_group"]
                )
            elif kind == "transfer_reversal":
                valid = valid and response.get("transfer") == request["transfer_id"]
        elif kind == "seller_account":
            valid = response.get("country") == request["country"]
        else:
            valid = True
        if not valid:
            raise CommerceProviderError("provider_response_mismatch")


class WithdrawalRecovery(ProviderContext):
    async def _resume_withdrawals(self, *, limit: int) -> int:
        async def pending(connection: Any) -> list[dict[str, Any]]:
            rows = await connection.fetch(
                """SELECT w.*,COALESCE(w.account_id,s.account_id) AS account_id,s.country FROM scope_commerce_withdrawals w
                JOIN scope_commerce_sellers s ON s.seller_id=w.seller_id
                WHERE w.status IN ('queued','transferred','pending','unknown')
                ORDER BY w.updated_at,w.withdrawal_id LIMIT $1""",
                limit,
            )
            return [dict(row) for row in rows]

        resumed = 0
        for withdrawal in await self.store._transaction(pending):
            try:
                if withdrawal.get("payout_id"):
                    payout = await self.adapter.retrieve(
                        "payout", withdrawal["payout_id"], account_id=withdrawal["account_id"]
                    )
                    if (
                        payout.get("amount") != withdrawal["net_cents"]
                        or payout.get("currency") != "usd"
                        or payout.get("livemode") is not self.config.livemode
                        or (payout.get("metadata") or {}).get("withdrawal_id")
                        != str(withdrawal["withdrawal_id"])
                    ):
                        raise CommerceProviderError("provider_response_mismatch")
                    await self._settle_payout(payout, account_id=withdrawal["account_id"])
                else:
                    account = await self.adapter.retrieve(
                        "seller_account", withdrawal["account_id"]
                    )
                    if account.get("id") != withdrawal["account_id"] or not self._seller_eligible(
                        account, withdrawal["country"]
                    ):
                        continue
                    await self._deliver_withdrawal(
                        user_id=withdrawal["user_id"],
                        withdrawal_id=str(withdrawal["withdrawal_id"]),
                        reservation=withdrawal,
                        account_id=withdrawal["account_id"],
                    )
                resumed += 1
            except (CommerceProviderError, CommerceError):
                continue
            finally:
                await self._mark_withdrawal_reviewed(withdrawal["withdrawal_id"])
        return resumed

    async def _mark_withdrawal_reviewed(self, withdrawal_id: Any) -> None:
        async def mark(connection: Any) -> None:
            await connection.execute(
                """UPDATE scope_commerce_withdrawals SET updated_at=clock_timestamp()
                WHERE withdrawal_id=$1::uuid AND status IN ('queued','transferred','pending','unknown')""",
                str(withdrawal_id),
            )

        await self.store._transaction(mark)

    async def _resume_events(self, *, limit: int) -> int:
        async def pending(connection: Any) -> list[dict[str, Any]]:
            return [
                dict(row)
                for row in await connection.fetch(
                    """SELECT * FROM scope_commerce_provider_events
                    WHERE status='received' AND next_check_at<=clock_timestamp()
                    ORDER BY next_check_at,event_id LIMIT $1""",
                    limit,
                )
            ]

        resumed = 0
        for saved in await self.store._transaction(pending):
            try:
                event = await self.adapter.retrieve("event", saved["event_id"])
                if (
                    event.get("id") != saved["event_id"]
                    or event.get("type") != saved["event_type"]
                    or event.get("livemode") is not self.config.livemode
                ):
                    raise CommerceProviderError("provider_invalid_event")
                obj = event.get("data", {}).get("object")
                if not isinstance(obj, dict):
                    raise CommerceProviderError("provider_invalid_event")
                await self._apply_event(event, obj)

                async def complete(connection: Any, event_id: str = saved["event_id"]) -> None:
                    await connection.execute(
                        "UPDATE scope_commerce_provider_events SET status='processed' WHERE event_id=$1",
                        event_id,
                    )

                await self.store._transaction(complete)
                resumed += 1
            except (CommerceProviderError, CommerceError):
                await self._defer_event(saved["event_id"])
                continue
        return resumed

    async def _defer_event(self, event_id: str) -> None:
        async def defer(connection: Any) -> None:
            await connection.execute(
                """UPDATE scope_commerce_provider_events
                SET next_check_at=clock_timestamp()+interval '1 minute'
                WHERE event_id=$1 AND status='received'""",
                event_id,
            )

        await self.store._transaction(defer)

    async def _weekly_batch(self, *, limit: int) -> int:
        async def owners(connection: Any) -> list[str]:
            rows = await connection.fetch(
                """SELECT a.user_id FROM scope_commerce_seller_accounts a
                WHERE a.eligible AND NOT EXISTS(SELECT 1 FROM scope_commerce_withdrawals w
                 WHERE w.user_id=a.user_id AND w.created_at>clock_timestamp()-interval '7 days')
                ORDER BY a.updated_at,a.user_id LIMIT $1""",
                limit,
            )
            return [row["user_id"] for row in rows]

        completed = 0
        week = datetime.now(UTC).isocalendar()
        for user_id in await self.store._transaction(owners):
            try:
                preview = await self.preview_withdrawal(user_id)
                if not preview["eligible"]:
                    continue
                await self.request_withdrawal(
                    user_id=user_id,
                    operation_id=self._derived_id(user_id, f"weekly:{week.year}:{week.week}"),
                    scheduled=True,
                )
                completed += 1
            except (CommerceProviderError, CommerceError):
                continue
            finally:
                await self._mark_weekly_reviewed(user_id)
        return completed

    async def _mark_weekly_reviewed(self, user_id: str) -> None:
        async def mark(connection: Any) -> None:
            await connection.execute(
                "UPDATE scope_commerce_seller_accounts SET updated_at=clock_timestamp() WHERE user_id=$1",
                user_id,
            )

        await self.store._transaction(mark)

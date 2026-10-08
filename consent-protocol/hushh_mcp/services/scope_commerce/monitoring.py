"""Read-only aggregate financial observations for IAM-protected Monitoring."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

_COUNTERS = """WITH observed AS (SELECT clock_timestamp() AS at), due AS (
 SELECT next_check_at AS at FROM scope_commerce_obligations, observed
 WHERE status NOT IN ('succeeded','failed') AND next_check_at <= observed.at
 UNION ALL SELECT next_check_at FROM scope_commerce_provider_events, observed
 WHERE status='received' AND next_check_at <= observed.at
 UNION ALL SELECT next_check_at FROM scope_commerce_transfer_recoveries, observed
 WHERE recovered_micro_usd < amount_micro_usd AND next_check_at <= observed.at
 UNION ALL SELECT COALESCE(lease_until,created_at)
 FROM scope_commerce_provider_operations, observed
 WHERE status IN ('prepared','submitted','reconciliation_required')
 AND COALESCE(lease_until,created_at) <= observed.at
 UNION ALL SELECT expires_at FROM scope_commerce_purchases, observed
 WHERE status='staged' AND earnings_settled_at IS NULL AND expires_at <= observed.at
 UNION ALL SELECT fulfillment_deadline FROM scope_commerce_purchases, observed
 WHERE status IN ('awaiting_payment','reserved','preparing')
 AND fulfillment_deadline <= observed.at
)
SELECT
 (SELECT COALESCE(sum(-LEAST(balance,0)),0)::bigint FROM
   (SELECT sum(micro_usd) AS balance FROM scope_commerce_postings
    WHERE account LIKE 'seller_debt:%' GROUP BY account) balances)
   AS recovery_liabilities_micro_usd,
 (SELECT GREATEST(0,-COALESCE(sum(micro_usd),0))::bigint
  FROM scope_commerce_postings WHERE account='unallocated_fees:platform')
   AS unallocated_processing_cost_micro_usd,
 (SELECT count(*) FROM scope_commerce_obligations
   WHERE status NOT IN ('succeeded','failed')) AS unresolved_obligations,
 (SELECT count(*) FROM scope_commerce_provider_operations
   WHERE status='reconciliation_required') AS uncertain_operations,
 (SELECT count(*) FROM scope_commerce_provider_events
   WHERE status='received') AS pending_provider_events,
 (SELECT count(*) FROM scope_commerce_transfer_recoveries
   WHERE recovered_micro_usd < amount_micro_usd) AS pending_transfer_recoveries,
 (SELECT count(*) FROM scope_commerce_journal j WHERE
   (SELECT COALESCE(sum(micro_usd),0) FROM scope_commerce_postings p
    WHERE p.entry_id=j.entry_id) <> 0) AS unbalanced_journals,
 COALESCE((SELECT GREATEST(0,EXTRACT(EPOCH FROM
   ((SELECT at FROM observed)-min(at)))::bigint) FROM due),0)
   AS oldest_due_work_seconds
"""


async def financial_snapshot(store: Any, *, receipt_failures: int) -> dict[str, int]:
    async def read(connection: Any) -> dict[str, int]:
        position = await store._treasury_position(connection)
        counters = dict(await connection.fetchrow(_COUNTERS))
        return {
            "attributed_backing_micro_usd": position["attributedMicroUsd"],
            "liabilities_micro_usd": position["restrictedMicroUsd"],
            "fee_reserve_micro_usd": position["operatingFeeReserveMicroUsd"],
            "backing_shortfall_micro_usd": position["backingShortfallMicroUsd"],
            **counters,
            "receipt_failures": receipt_failures,
            "worker_completed_timestamp": int(datetime.now(timezone.utc).timestamp()),
        }

    return await store._transaction(read)


async def provider_observation(provider: Any) -> dict[str, int]:
    """Fresh API evidence, never an inferred balance from journal or a prior run."""
    await provider._admit(new_activity=False)
    balance = await provider.adapter.balance()
    entries = balance.get("available")
    if (
        type(balance.get("livemode")) is not bool
        or balance["livemode"] != provider.config.livemode
        or not isinstance(entries, list)
        or any(
            not isinstance(item, dict)
            or type(item.get("amount")) is not int
            or not isinstance(item.get("currency"), str)
            for item in entries
        )
    ):
        raise ValueError("provider_observation_unverified")
    return {
        "provider_available_micro_usd": sum(
            item["amount"] * 10_000 for item in entries if item["currency"] == "usd"
        ),
        "provider_observed_timestamp": int(datetime.now(timezone.utc).timestamp()),
        "provider_observation_verified": 1,
    }

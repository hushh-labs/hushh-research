"""Lifetime milestone entitlements and the fulfillment review foundation.

Owns `one_referral_milestone_entitlements` and
`one_referral_fulfillment_records` (migration 271). Matches the product
spec's own responsibility split: referral core owns attribution and
qualification, scoring owns points and rankings, THIS module owns
entitlements, review, and fulfillment.

Ships no purchase, shipping, or courier integration -- `decide_fulfillment`
only ever changes a status column. "Keep real prize activation gated until
operational inputs are supplied" applies here exactly as it does to the
weekly reward schedule.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.operons.referral_scoring.milestones import milestones_newly_earned

logger = logging.getLogger(__name__)

_DECIDABLE_STATUSES = frozenset({"approved", "cancelled"})


class FulfillmentDecisionError(RuntimeError):
    """A fulfillment decision could not be recorded."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _lifetime_qualified_count(connection, user_id: str) -> int:
    row = connection.execute(
        text(
            """
            SELECT COUNT(*) AS total
              FROM one_referral_relationships
             WHERE referrer_user_id = :uid AND status = 'qualified'
            """
        ),
        {"uid": user_id},
    ).fetchone()
    return int(row.total) if row else 0


def _already_earned_keys(connection, user_id: str) -> frozenset:
    rows = connection.execute(
        text("SELECT milestone_key FROM one_referral_milestone_entitlements WHERE user_id = :uid"),
        {"uid": user_id},
    ).fetchall()
    return frozenset(row.milestone_key for row in rows)


def evaluate_and_issue_milestones(
    connection, *, user_id: str, settings_milestones: list, settings_version: int
) -> list[dict]:
    """Issue any lifetime milestone this user's qualified count newly crosses.

    MUST be called with the caller's own connection (the scoring worker's
    transaction) so a crash between scoring a relationship and issuing the
    milestone it happens to complete cannot happen. Idempotent: the unique
    index on (user_id, milestone_key) makes a duplicate issue a no-op, so
    reprocessing the same job never issues a second tee for the same person.
    """
    lifetime_count = _lifetime_qualified_count(connection, user_id)
    already_earned = _already_earned_keys(connection, user_id)
    awards = milestones_newly_earned(lifetime_count, settings_milestones, already_earned)

    issued: list[dict] = []
    for award in awards:
        entitlement = connection.execute(
            text(
                """
                INSERT INTO one_referral_milestone_entitlements
                  (user_id, milestone_key, threshold, reward, settings_version)
                VALUES (:uid, :key, :threshold, :reward, :version)
                ON CONFLICT (user_id, milestone_key) DO NOTHING
                RETURNING id
                """
            ),
            {
                "uid": user_id,
                "key": award.milestone_key,
                "threshold": award.threshold,
                "reward": award.reward,
                "version": settings_version,
            },
        ).fetchone()
        if entitlement is None:
            # Lost a concurrent race to issue the same milestone; the other
            # writer's fulfillment record already exists.
            continue
        connection.execute(
            text(
                """
                INSERT INTO one_referral_fulfillment_records (entitlement_id)
                VALUES (CAST(:eid AS UUID))
                ON CONFLICT (entitlement_id) DO NOTHING
                """
            ),
            {"eid": entitlement.id},
        )
        issued.append({"milestone_key": award.milestone_key, "reward": award.reward})

    return issued


def list_pending_fulfillment(limit: int = 100) -> list[dict]:
    with get_db_connection() as connection:
        rows = connection.execute(
            text(
                """
                SELECT f.id, f.entitlement_id, e.user_id, e.milestone_key, e.reward, f.created_at
                  FROM one_referral_fulfillment_records f
                  JOIN one_referral_milestone_entitlements e ON e.id = f.entitlement_id
                 WHERE f.status = 'pending_review'
                 ORDER BY f.created_at
                 LIMIT :limit
                """
            ),
            {"limit": limit},
        ).fetchall()
    return [
        {
            "fulfillment_id": str(row.id),
            "entitlement_id": str(row.entitlement_id),
            "user_id": row.user_id,
            "milestone_key": row.milestone_key,
            "reward": row.reward,
            "created_at": row.created_at,
        }
        for row in rows
    ]


@dataclass(frozen=True)
class FulfillmentDecision:
    fulfillment_id: str
    status: str
    reviewed_by: str
    reviewed_at: datetime


def decide_fulfillment(
    fulfillment_id: str, *, decision: str, reviewed_by: str
) -> FulfillmentDecision:
    """Record a staff decision. No purchase, shipment, or courier action.

    `decision` is 'approved' or 'cancelled' only -- marking something
    'shipped' is a separate, later step once an actual fulfillment vendor
    integration exists, which this change does not add.
    """
    if decision not in _DECIDABLE_STATUSES:
        raise FulfillmentDecisionError(f"invalid decision: {decision!r}")
    if not reviewed_by:
        raise FulfillmentDecisionError("reviewed_by is required")

    now = _now()
    with get_db_connection() as connection:
        row = connection.execute(
            text(
                """
                UPDATE one_referral_fulfillment_records
                   SET status = :decision, reviewed_by = :reviewed_by, reviewed_at = :now, updated_at = :now
                 WHERE id = CAST(:fid AS UUID) AND status = 'pending_review'
                RETURNING id
                """
            ),
            {"decision": decision, "reviewed_by": reviewed_by, "now": now, "fid": fulfillment_id},
        ).fetchone()
    if row is None:
        raise FulfillmentDecisionError("fulfillment record not found or already decided")
    return FulfillmentDecision(
        fulfillment_id=fulfillment_id, status=decision, reviewed_by=reviewed_by, reviewed_at=now
    )

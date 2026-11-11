"""Signed event reconciliation and deletion-safe provider cleanup, test mode only."""

import asyncio
from uuid import UUID

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.advisor_payment_checkout import (
    PAYMENT_KIND,
    binding,
    load_payment,
    read_checkout,
    record_checkout,
)
from hushh_mcp.services.advisor_review_billing import AdvisorBillingService, test_config
from hushh_mcp.services.advisor_review_store import AdvisorReviewError
from hushh_mcp.services.advisor_stripe import provider as stripe_provider
from hushh_mcp.services.finance_sharing_service import one


def process_event(payload, signature, *, db=None, provider=None):
    if not signature:
        raise AdvisorReviewError("ADVISOR_BILLING_UNAVAILABLE", 503)
    key, secret = test_config()
    provider = provider or stripe_provider()
    try:
        event = provider.Webhook.construct_event(payload, signature, secret)
    except Exception as exc:
        raise AdvisorReviewError("ADVISOR_BILLING_SIGNATURE_INVALID", 400) from exc
    if event.get("livemode") is not False:
        raise AdvisorReviewError("ADVISOR_TEST_BILLING_REQUIRED", 400)
    obj = event.get("data", {}).get("object", {})
    metadata = (
        obj.get("metadata")
        or (obj.get("parent", {}).get("subscription_details") or {}).get("metadata")
        or (obj.get("subscription_details") or {}).get("metadata")
        or {}
    )
    if metadata.get("kind") not in {PAYMENT_KIND, "advisor_subscription_v1"}:
        return {"received": True}
    try:
        request_id = str(UUID(metadata["request_id"]))
    except (KeyError, ValueError) as exc:
        raise AdvisorReviewError("ADVISOR_BILLING_EVENT_INVALID", 400) from exc
    database = db or get_db()
    if metadata["kind"] == PAYMENT_KIND:
        reconcile_payment_event(
            database, provider, key, request_id, event.get("type"), obj, metadata
        )
        return {"received": True}
    with database.engine.begin() as conn:
        request = one(
            conn,
            "SELECT owner_user_id FROM advisor_review_requests WHERE id=CAST(:id AS uuid)",
            {"id": request_id},
        )
        if not request:
            subscription = obj.get("subscription") or (
                obj.get("id") if obj.get("object") == "subscription" else None
            )
            if isinstance(subscription, str) and subscription.startswith("sub_"):
                conn.execute(
                    text("""INSERT INTO advisor_billing_cleanup(resource_id,resource_kind,stripe_mode)
                    VALUES(:id,'subscription','test') ON CONFLICT DO NOTHING"""),
                    {"id": subscription},
                )
            return {"received": True}
    AdvisorBillingService(database, provider).reconcile(request["owner_user_id"], request_id)
    return {"received": True}


def reconcile_payment_event(db, provider, key, request_id, event_type, obj, metadata):
    if event_type not in {
        "checkout.session.completed",
        "checkout.session.expired",
        "charge.refunded",
    }:
        return
    try:
        revision = int(metadata["plan_revision"])
        if not 0 < revision <= 2147483647:
            raise ValueError("invalid revision")
    except (KeyError, TypeError, ValueError) as exc:
        raise AdvisorReviewError("ADVISOR_BILLING_EVENT_INVALID", 400) from exc
    with db.engine.begin() as conn:
        payment = load_payment(conn, request_id, revision)
        if not payment or any(
            metadata.get(k) != v for k, v in binding(request_id, payment).items()
        ):
            return
        if event_type == "charge.refunded":
            if (
                not payment["payment_intent_id"]
                or obj.get("payment_intent") != payment["payment_intent_id"]
            ):
                return
            session_id = payment["checkout_session_id"]
        else:
            session_id = obj.get("id")
            if payment["checkout_session_id"] not in (None, session_id):
                return
        if not isinstance(session_id, str) or not session_id.startswith("cs_test_"):
            raise AdvisorReviewError("ADVISOR_BILLING_EVENT_INVALID", 400)
        session = read_checkout(provider, key, request_id, payment, session_id)
        record_checkout(conn, request_id, payment, session)


def cleanup(*, limit=5, db=None, provider=None):
    if not 1 <= limit <= 20:
        raise ValueError("invalid cleanup bound")
    try:
        key, _ = test_config()
    except (AdvisorReviewError, ValueError):
        return 0
    provider = provider or stripe_provider()
    database = db or get_db()
    completed = 0
    with database.engine.begin() as conn:
        if not one(conn, "SELECT to_regclass('public.advisor_billing_cleanup') IS NOT NULL AS ok")[
            "ok"
        ]:
            return 0
        rows = (
            conn.execute(
                text("""SELECT resource_id,resource_kind FROM advisor_billing_cleanup
            WHERE completed_at IS NULL ORDER BY attempts,resource_id LIMIT :limit FOR UPDATE SKIP LOCKED"""),
                {"limit": limit},
            )
            .mappings()
            .all()
        )
        for row in rows:
            resource = row["resource_id"]
            try:
                subscription = resource if row["resource_kind"] == "subscription" else None
                if row["resource_kind"] == "checkout":
                    session = dict(provider.checkout.Session.retrieve(resource, api_key=key))
                    if session.get("livemode") is not False or session.get("id") != resource:
                        raise ValueError("checkout mismatch")
                    if session.get("status") == "open":
                        session = dict(provider.checkout.Session.expire(resource, api_key=key))
                        if session.get("livemode") is not False or session.get("id") != resource:
                            raise ValueError("checkout mismatch")
                    if (
                        session.get("mode") == "subscription"
                        and (session.get("metadata") or {}).get("kind") == "advisor_subscription_v1"
                    ):
                        subscription = session.get("subscription")
                    if session.get("status") not in {"complete", "expired"}:
                        raise ValueError("checkout unknown")
                if subscription:
                    current = dict(provider.Subscription.retrieve(subscription, api_key=key))
                    if (
                        current.get("livemode") is not False
                        or current.get("id") != subscription
                        or (current.get("metadata") or {}).get("kind") != "advisor_subscription_v1"
                    ):
                        raise ValueError("subscription mismatch")
                    if current.get("status") != "canceled":
                        current = dict(provider.Subscription.cancel(subscription, api_key=key))
                    if (
                        current.get("status") != "canceled"
                        or current.get("id") != subscription
                        or current.get("livemode") is not False
                    ):
                        raise ValueError("cancellation unconfirmed")
                conn.execute(
                    text(
                        "UPDATE advisor_billing_cleanup SET completed_at=clock_timestamp(),attempts=attempts+1 WHERE resource_id=:id"
                    ),
                    {"id": resource},
                )
                completed += 1
            except Exception:
                conn.execute(
                    text(
                        "UPDATE advisor_billing_cleanup SET attempts=attempts+1 WHERE resource_id=:id"
                    ),
                    {"id": resource},
                )
    return completed


async def cleanup_async(limit=5):
    return await asyncio.to_thread(cleanup, limit=limit)

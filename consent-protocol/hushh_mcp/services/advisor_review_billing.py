"""Test-mode recurring advisory checkout; provider readback is payment authority."""

import hashlib
import json
import os
from datetime import UTC, datetime, timedelta

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.advisor_review_notifications import notify_counterpart
from hushh_mcp.services.advisor_review_store import (
    AdvisorReviewError,
    load,
    lock_review,
    require_accepted,
)
from hushh_mcp.services.advisor_stripe import provider as stripe_provider
from hushh_mcp.services.finance_sharing_service import decoded, one
from hushh_mcp.services.pkm_payout_service import _app_origin
from hushh_mcp.services.stripe_mode import connect_config


def test_config():
    try:
        key, mode = connect_config()
    except ValueError as exc:
        raise AdvisorReviewError("ADVISOR_TEST_BILLING_SETUP", 409) from exc
    if mode != "test":
        raise AdvisorReviewError("ADVISOR_TEST_BILLING_REQUIRED", 409)
    secret = os.getenv("STRIPE_CONNECT_WEBHOOK_SECRET", "").strip()
    if not secret.startswith("whsec_") or len(secret) < 20:
        raise AdvisorReviewError("ADVISOR_TEST_BILLING_SETUP", 409)
    return key


def payee(conn, advisor):
    row = one(
        conn,
        """SELECT stripe_account_id,details_submitted,payouts_enabled
        FROM stripe_owner_payout_accounts WHERE user_id=:uid AND stripe_mode='test' FOR SHARE""",
        {"uid": advisor},
    )
    if not row or not row["details_submitted"] or not row["payouts_enabled"]:
        raise AdvisorReviewError("ADVISOR_CONNECT_STRIPE", 409)
    return row["stripe_account_id"]


class AdvisorBillingService:
    def __init__(self, db=None, provider=None):
        self.db = db or get_db()
        self.provider = provider or stripe_provider()

    def offer(self, advisor, request_id, body):
        key = test_config()
        with self.db.engine.begin() as conn:
            row = lock_review(conn, advisor, request_id)
            require_accepted(conn, row)
            if advisor != row["advisor_user_id"]:
                raise AdvisorReviewError("ADVISOR_WRONG_PARTICIPANT", 403)
            if not row["meeting"] or decoded(row["meeting"]).get("status") != "completed":
                raise AdvisorReviewError("ADVISOR_INTRODUCTION_REQUIRED", 409)
            account = payee(conn, advisor)
            existing = one(
                conn,
                "SELECT status FROM advisor_review_subscriptions WHERE request_id=CAST(:id AS uuid) FOR UPDATE",
                {"id": request_id},
            )
            if existing and existing["status"] != "cancelled":
                raise AdvisorReviewError("ADVISOR_BILLING_IN_PROGRESS", 409)
            remote = dict(self.provider.Account.retrieve(account, api_key=key))
            if (
                not remote.get("payouts_enabled")
                or remote.get("capabilities", {}).get("transfers") != "active"
            ):
                raise AdvisorReviewError("ADVISOR_CONNECT_STRIPE", 409)
            conn.execute(
                text("""UPDATE advisor_review_requests SET plan=CAST(:plan AS jsonb),
                plan_revision=plan_revision+1,updated_at=clock_timestamp() WHERE id=CAST(:id AS uuid)"""),
                {"id": request_id, "plan": json.dumps(body.model_dump())},
            )
            if existing:
                conn.execute(
                    text(
                        "DELETE FROM advisor_review_subscriptions WHERE request_id=CAST(:id AS uuid)"
                    ),
                    {"id": request_id},
                )
            notify_counterpart(
                conn, row, advisor, source_id=f"{request_id}:plan:{row['plan_revision'] + 1}"
            )
            return {"offered": True}

    def checkout(self, owner, request_id, body):
        key = test_config()
        with self.db.engine.begin() as conn:
            row = lock_review(conn, owner, request_id)
            require_accepted(conn, row)
            if (
                owner != row["owner_user_id"]
                or row["plan_revision"] != body.planRevision
                or not row["plan"]
            ):
                raise AdvisorReviewError("ADVISOR_PLAN_CHANGED", 409)
            plan = decoded(row["plan"])
            plan_hash = hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()
            destination = payee(conn, row["advisor_user_id"])
            existing = one(
                conn,
                "SELECT * FROM advisor_review_subscriptions WHERE request_id=CAST(:id AS uuid) FOR UPDATE",
                {"id": request_id},
            )
            if existing and (
                existing["plan_hash"] != plan_hash or existing["payee_account"] != destination
            ):
                raise AdvisorReviewError("ADVISOR_PLAN_CHANGED", 409)
            if not existing:
                conn.execute(
                    text("""INSERT INTO advisor_review_subscriptions(request_id,stripe_mode,payee_account,plan_revision,plan_hash)
                    VALUES(CAST(:id AS uuid),'test',:payee,:revision,:hash)"""),
                    {
                        "id": request_id,
                        "payee": destination,
                        "revision": row["plan_revision"],
                        "hash": plan_hash,
                    },
                )
            elif existing["checkout_session_id"]:
                session = dict(
                    self.provider.checkout.Session.retrieve(
                        existing["checkout_session_id"], api_key=key
                    )
                )
                if session.get("status") != "open" or not session.get("url"):
                    raise AdvisorReviewError("ADVISOR_CHECK_BILLING_STATUS", 409)
                return {"url": session["url"], "mode": "test"}
            elif existing["created_at"] < datetime.now(UTC) - timedelta(hours=20):
                raise AdvisorReviewError("ADVISOR_CHECK_BILLING_STATUS", 409)
            revision = row["plan_revision"]
        # Immutable plan + provider idempotency key survive an uncertain response.
        # There is exactly one checkout per request/plan revision.
        remote = create_session(
            self.provider, key, request_id, revision, plan_hash, destination, plan
        )
        with self.db.engine.begin() as conn:
            row = lock_review(conn, owner, request_id)
            require_accepted(conn, row)
            conn.execute(
                text("""UPDATE advisor_review_subscriptions SET checkout_session_id=:session,status='checkout_pending',
                updated_at=clock_timestamp() WHERE request_id=CAST(:id AS uuid) AND plan_revision=:revision"""),
                {"session": remote["id"], "id": request_id, "revision": revision},
            )
        return {"url": remote["url"], "mode": "test"}

    def reconcile(self, viewer, request_id):
        key = test_config()
        with self.db.engine.begin() as conn:
            request = load(conn, viewer, request_id)
            row = one(
                conn,
                "SELECT * FROM advisor_review_subscriptions WHERE request_id=CAST(:id AS uuid) FOR UPDATE",
                {"id": request_id},
            )
            if not row:
                return {"status": "not_started", "mode": "test"}
            if not row["checkout_session_id"]:
                return {"status": "preparing", "mode": "test"}
            session = dict(
                self.provider.checkout.Session.retrieve(row["checkout_session_id"], api_key=key)
            )
            if (
                session.get("livemode") is not False
                or session.get("client_reference_id") != request_id
            ):
                raise AdvisorReviewError("ADVISOR_BILLING_UNCONFIRMED", 503)
            metadata = session.get("metadata") or {}
            if (
                metadata.get("plan_hash") != row["plan_hash"]
                or metadata.get("request_id") != request_id
            ):
                raise AdvisorReviewError("ADVISOR_BILLING_UNCONFIRMED", 503)
            status = "cancelled" if session.get("status") == "expired" else "checkout_pending"
            subscription_id = session.get("subscription")
            customer_id = session.get("customer")
            if subscription_id:
                subscription = dict(
                    self.provider.Subscription.retrieve(
                        subscription_id, api_key=key, expand=["latest_invoice"]
                    )
                )
                status = verified_subscription(
                    subscription,
                    {**row, "plan": decoded(request["plan"]), "request_id": request_id},
                )
            conn.execute(
                text("""UPDATE advisor_review_subscriptions SET status=:status,subscription_id=:subscription,
                customer_id=:customer,updated_at=clock_timestamp() WHERE request_id=CAST(:id AS uuid)"""),
                {
                    "id": request_id,
                    "status": status,
                    "subscription": subscription_id,
                    "customer": customer_id,
                },
            )
            return {"status": status, "mode": "test"}

    def cancel(self, owner, request_id):
        key = test_config()
        with self.db.engine.begin() as conn:
            request = load(conn, owner, request_id)
            if owner != request["owner_user_id"]:
                raise AdvisorReviewError("ADVISOR_WRONG_PARTICIPANT", 403)
            row = one(
                conn,
                "SELECT * FROM advisor_review_subscriptions WHERE request_id=CAST(:id AS uuid) FOR UPDATE",
                {"id": request_id},
            )
            if not row:
                return {"status": "not_started"}
            if row["subscription_id"]:
                remote = dict(
                    self.provider.Subscription.cancel(
                        row["subscription_id"],
                        api_key=key,
                        idempotency_key=f"advisor-cancel:{request_id}:{row['plan_revision']}",
                    )
                )
                if remote.get("status") != "canceled":
                    raise AdvisorReviewError("ADVISOR_BILLING_UNCONFIRMED", 503)
            elif row["checkout_session_id"]:
                remote = dict(
                    self.provider.checkout.Session.expire(row["checkout_session_id"], api_key=key)
                )
                if remote.get("status") != "expired":
                    raise AdvisorReviewError("ADVISOR_CHECK_BILLING_STATUS", 409)
            else:
                raise AdvisorReviewError("ADVISOR_CHECK_BILLING_STATUS", 409)
            conn.execute(
                text(
                    "UPDATE advisor_review_subscriptions SET status='cancelled',updated_at=clock_timestamp() WHERE request_id=CAST(:id AS uuid)"
                ),
                {"id": request_id},
            )
            return {"status": "cancelled"}


def verified_subscription(subscription, row):
    metadata = subscription.get("metadata") or {}
    plan = row["plan"]
    items = (subscription.get("items") or {}).get("data") or []
    price = (items[0].get("price") or {}) if len(items) == 1 else {}
    if (
        subscription.get("livemode") is not False
        or metadata.get("plan_hash") != row["plan_hash"]
        or metadata.get("request_id") != row["request_id"]
        or metadata.get("plan_revision") != str(row["plan_revision"])
        or (subscription.get("transfer_data") or {}).get("destination") != row["payee_account"]
        or price.get("unit_amount") != plan["amountCents"]
        or price.get("currency") != "usd"
        or (price.get("recurring") or {}).get("interval") != "month"
        or len(items) != 1
        or items[0].get("quantity") != 1
    ):
        raise AdvisorReviewError("ADVISOR_BILLING_UNCONFIRMED", 503)
    status = subscription.get("status")
    if status == "active" and (
        not isinstance(subscription.get("latest_invoice"), dict)
        or subscription["latest_invoice"].get("status") != "paid"
    ):
        return "incomplete"
    return {
        "active": "active",
        "past_due": "past_due",
        "canceled": "cancelled",
        "unpaid": "unpaid",
        "incomplete": "incomplete",
        "incomplete_expired": "cancelled",
    }.get(status, "unknown")


def create_session(provider, key, request_id, revision, plan_hash, destination, plan):
    origin = _app_origin()
    metadata = {
        "kind": "advisor_subscription_v1",
        "request_id": request_id,
        "plan_hash": plan_hash,
        "plan_revision": str(revision),
    }
    remote = dict(
        provider.checkout.Session.create(
            api_key=key,
            mode="subscription",
            idempotency_key=f"advisor-checkout:{request_id}:{revision}",
            client_reference_id=request_id,
            metadata=metadata,
            subscription_data={
                "metadata": metadata,
                "transfer_data": {"destination": destination},
            },
            line_items=[
                {
                    "quantity": 1,
                    "price_data": {
                        "currency": "usd",
                        "unit_amount": plan["amountCents"],
                        "recurring": {"interval": "month"},
                        "product_data": {"name": "Monthly advisor plan"},
                    },
                }
            ],
            success_url=f"{origin}/one/kai/portfolio/analysis?advisorReview={request_id}",
            cancel_url=f"{origin}/one/kai/portfolio/analysis?advisorReview={request_id}",
        )
    )
    if not remote.get("id") or not remote.get("url") or remote.get("livemode") is not False:
        raise AdvisorReviewError("ADVISOR_BILLING_UNCONFIRMED", 503)
    return remote

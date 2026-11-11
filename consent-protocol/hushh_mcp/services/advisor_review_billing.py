"""One-time test checkout and readback for retained subscription records."""

import hashlib
import json
import os
from datetime import UTC, datetime, timedelta
from threading import Lock
from time import monotonic

from google.api_core.exceptions import GoogleAPICallError
from google.auth.exceptions import GoogleAuthError
from google.cloud import secretmanager
from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.advisor_payment_checkout import (
    checkout_expired,
    create_checkout,
    load_payment,
    read_checkout,
    record_checkout,
    restart_checkout,
    retire_checkout,
)
from hushh_mcp.services.advisor_review_notifications import notify_counterpart
from hushh_mcp.services.advisor_review_store import (
    AdvisorReviewError,
    introduction_complete,
    load,
    lock_review,
    require_accepted,
)
from hushh_mcp.services.advisor_stripe import provider as stripe_provider
from hushh_mcp.services.finance_sharing_service import decoded, one
from hushh_mcp.services.stripe_mode import stripe_environment

_UAT_PROJECT = "hushh-pda-uat"
_TEST_KEY_NAME = "RIA_STRIPE_TEST_SECRET_KEY"
_TEST_WEBHOOK_NAME = "RIA_STRIPE_TEST_WEBHOOK_SECRET"
_credential_lock = Lock()
_uat_credentials: tuple[str, str] = ("", "")
_credential_refresh_at = 0.0


def _read_uat_credentials() -> tuple[str, str]:
    with secretmanager.SecretManagerServiceClient() as client:
        key, webhook = (
            client.access_secret_version(
                request={"name": f"projects/{_UAT_PROJECT}/secrets/{name}/versions/latest"},
                retry=None,
                timeout=3,
            )
            .payload.data.decode()
            .strip()
            for name in (_TEST_KEY_NAME, _TEST_WEBHOOK_NAME)
        )
    return key, webhook


def _uat_test_config() -> tuple[str, str]:
    global _uat_credentials, _credential_refresh_at
    with _credential_lock:
        if monotonic() >= _credential_refresh_at:
            try:
                _uat_credentials = _read_uat_credentials()
            except (GoogleAPICallError, GoogleAuthError, UnicodeError):
                _uat_credentials = ("", "")
            _credential_refresh_at = monotonic() + (300 if all(_uat_credentials) else 30)
        return _uat_credentials


def test_config() -> tuple[str, str]:
    key = os.getenv(_TEST_KEY_NAME, "").strip()
    secret = os.getenv(_TEST_WEBHOOK_NAME, "").strip()
    if (
        not key
        and not secret
        and stripe_environment() == "uat"
        and os.getenv("GOOGLE_CLOUD_PROJECT") == _UAT_PROJECT
        and os.getenv("K_SERVICE") == "consent-protocol"
    ):
        key, secret = _uat_test_config()
    if key and (not key.startswith("sk_test_") or len(key) < 24):
        raise AdvisorReviewError("ADVISOR_TEST_BILLING_REQUIRED", 409)
    if not key or not secret.startswith("whsec_") or len(secret) < 20:
        raise AdvisorReviewError("ADVISOR_TEST_BILLING_SETUP", 409)
    return key, secret


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
        key, _ = test_config()
        with self.db.engine.begin() as conn:
            row = lock_review(conn, advisor, request_id)
            require_accepted(conn, row)
            if advisor != row["advisor_user_id"]:
                raise AdvisorReviewError("ADVISOR_WRONG_PARTICIPANT", 403)
            if not introduction_complete(row):
                raise AdvisorReviewError("ADVISOR_INTRODUCTION_REQUIRED", 409)
            account = payee(conn, advisor)
            existing = one(
                conn,
                "SELECT status FROM advisor_review_subscriptions WHERE request_id=CAST(:id AS uuid) FOR UPDATE",
                {"id": request_id},
            )
            if existing and existing["status"] != "cancelled":
                raise AdvisorReviewError("ADVISOR_BILLING_IN_PROGRESS", 409)
            payment = load_payment(conn, request_id, row["plan_revision"])
            if payment and payment["status"] in {"preparing", "checkout_pending", "processing"}:
                raise AdvisorReviewError("ADVISOR_BILLING_IN_PROGRESS", 409)
            remote = dict(self.provider.Account.retrieve(account, api_key=key))
            if (
                remote.get("id") != account
                or not remote.get("details_submitted")
                or not remote.get("payouts_enabled")
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
        key, _ = test_config()
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
            if plan.get("interval") != "one_time":
                raise AdvisorReviewError("ADVISOR_PLAN_CHANGED", 409)
            plan_hash = hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()
            destination = payee(conn, row["advisor_user_id"])
            revision = row["plan_revision"]
            payment = load_payment(conn, request_id, revision)
            if not payment:
                conn.execute(
                    text("""INSERT INTO advisor_review_payments
                    (request_id,payee_account,plan_revision,plan_hash,amount_cents)
                    VALUES(CAST(:id AS uuid),:payee,:revision,:hash,:amount)"""),
                    {
                        "id": request_id,
                        "payee": destination,
                        "revision": revision,
                        "hash": plan_hash,
                        "amount": plan["amountCents"],
                    },
                )
                payment = load_payment(conn, request_id, revision)
            elif payment["plan_hash"] != plan_hash or payment["payee_account"] != destination:
                raise AdvisorReviewError("ADVISOR_PLAN_CHANGED", 409)
            elif payment["paid_at"]:
                raise AdvisorReviewError("ADVISOR_PAYMENT_ALREADY_PAID", 409)
            elif payment["checkout_session_id"]:
                session = read_checkout(
                    self.provider, key, request_id, payment, payment["checkout_session_id"]
                )
                if session.get("status") == "open" and session.get("url"):
                    return {"url": session["url"], "mode": "test"}
                if not checkout_expired(session):
                    raise AdvisorReviewError("ADVISOR_CHECK_BILLING_STATUS", 409)
                payment = restart_checkout(conn, request_id, revision)
            elif payment["attempt_started_at"] < datetime.now(UTC) - timedelta(hours=20):
                # No Session was bound, so no URL was returned to the client.
                # The old attempt cannot publish a URL after this generation changes.
                payment = restart_checkout(conn, request_id, revision)
        remote = create_checkout(self.provider, key, request_id, payment)
        refusal = None
        with self.db.engine.begin() as conn:
            try:
                row = lock_review(conn, owner, request_id)
                require_accepted(conn, row)
                if row["plan_revision"] != revision:
                    raise AdvisorReviewError("ADVISOR_PLAN_CHANGED", 409)
            except AdvisorReviewError as exc:
                retire_checkout(conn, remote["id"])
                refusal = exc
            if refusal is None:
                current = load_payment(conn, request_id, revision)
                if current["attempt"] != payment["attempt"] or current[
                    "checkout_session_id"
                ] not in (None, remote["id"]):
                    retire_checkout(conn, remote["id"])
                    refusal = AdvisorReviewError("ADVISOR_CHECK_BILLING_STATUS", 409)
                elif current["checkout_session_id"] is None:
                    record_checkout(conn, request_id, current, remote)
                elif current["status"] != "checkout_pending":
                    refusal = AdvisorReviewError("ADVISOR_CHECK_BILLING_STATUS", 409)
        if refusal:
            raise refusal
        if remote.get("status") != "open" or not remote.get("url"):
            raise AdvisorReviewError("ADVISOR_CHECK_BILLING_STATUS", 409)
        return {"url": remote["url"], "mode": "test"}

    def reconcile(self, viewer, request_id):
        key, _ = test_config()
        with self.db.engine.begin() as conn:
            request = load(conn, viewer, request_id)
            payment = load_payment(conn, request_id, request["plan_revision"])
            if payment:
                session_id = payment["checkout_session_id"]
                if session_id is None:
                    return {
                        "status": "preparing",
                        "mode": "test",
                        "planRevision": request["plan_revision"],
                    }
                session = read_checkout(self.provider, key, request_id, payment, session_id)
                return record_checkout(conn, request_id, payment, session)
            row = one(
                conn,
                "SELECT * FROM advisor_review_subscriptions WHERE request_id=CAST(:id AS uuid) FOR UPDATE",
                {"id": request_id},
            )
            if not row:
                previous = one(
                    conn,
                    """SELECT amount_cents,paid_at,status FROM advisor_review_payments
                    WHERE request_id=CAST(:id AS uuid) AND plan_revision<:revision AND paid_at IS NOT NULL
                    ORDER BY plan_revision DESC LIMIT 1""",
                    {"id": request_id, "revision": request["plan_revision"]},
                )
                result: dict[str, object] = {
                    "status": "not_started",
                    "mode": "test",
                    "planRevision": request["plan_revision"],
                }
                if previous:
                    result["lastPayment"] = {
                        "amountCents": previous["amount_cents"],
                        "paidAt": previous["paid_at"].isoformat(),
                        "status": previous["status"],
                    }
                return result
            if not row["checkout_session_id"]:
                return {"status": "preparing", "mode": "test"}
            session = dict(
                self.provider.checkout.Session.retrieve(row["checkout_session_id"], api_key=key)
            )
            verify_session_binding(
                session, request_id, revision=row["plan_revision"], plan_hash=row["plan_hash"]
            )
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
        key, _ = test_config()
        with self.db.engine.begin() as conn:
            request = lock_review(conn, owner, request_id)
            if owner != request["owner_user_id"]:
                raise AdvisorReviewError("ADVISOR_WRONG_PARTICIPANT", 403)
            payment = load_payment(conn, request_id, request["plan_revision"])
            if payment:
                session_id = payment["checkout_session_id"]
                if session_id is None or payment["paid_at"]:
                    raise AdvisorReviewError("ADVISOR_CHECK_BILLING_STATUS", 409)
                session = read_checkout(self.provider, key, request_id, payment, session_id)
                if session.get("status") == "open":
                    self.provider.checkout.Session.expire(session_id, api_key=key)
                    session = read_checkout(self.provider, key, request_id, payment, session_id)
                return record_checkout(conn, request_id, payment, session)
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


def verify_session_binding(session, request_id, *, revision, plan_hash):
    metadata = session.get("metadata") or {}
    if (
        session.get("livemode") is not False
        or session.get("client_reference_id") != request_id
        or metadata.get("request_id") != request_id
        or metadata.get("kind") != "advisor_subscription_v1"
        or metadata.get("plan_revision") != str(revision)
        or metadata.get("plan_hash") != plan_hash
    ):
        raise AdvisorReviewError("ADVISOR_BILLING_UNCONFIRMED", 503)


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
    if status == "active":
        invoice = subscription.get("latest_invoice")
        if (
            not isinstance(invoice, dict)
            or invoice.get("status") != "paid"
            or invoice.get("livemode") is not False
            or invoice.get("currency") != "usd"
            or type(invoice.get("amount_paid")) is not int
            or invoice["amount_paid"] < plan["amountCents"]
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

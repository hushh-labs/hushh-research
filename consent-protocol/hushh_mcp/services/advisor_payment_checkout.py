"""Provider binding and durable status for one-time advisor payments."""

from datetime import UTC, datetime

from sqlalchemy import text

from hushh_mcp.services.advisor_review_store import AdvisorReviewError
from hushh_mcp.services.finance_sharing_service import one
from hushh_mcp.services.pkm_packet_order_service import _stripe_dict
from hushh_mcp.services.pkm_payout_service import _app_origin

PAYMENT_KIND = "advisor_payment_v1"


def load_payment(conn, request_id, revision):
    return one(
        conn,
        """SELECT * FROM advisor_review_payments
        WHERE request_id=CAST(:id AS uuid) AND plan_revision=:revision FOR UPDATE""",
        {"id": request_id, "revision": revision},
    )


def binding(request_id, payment):
    return {
        "kind": PAYMENT_KIND,
        "request_id": request_id,
        "plan_revision": str(payment["plan_revision"]),
        "plan_hash": payment["plan_hash"],
        "attempt": str(payment["attempt"]),
    }


def verify_session(session, request_id, payment):
    metadata = session.get("metadata") or {}
    session_id = session.get("id")
    if (
        session.get("livemode") is not False
        or session.get("mode") != "payment"
        or not isinstance(session_id, str)
        or not session_id.startswith("cs_test_")
        or (payment["checkout_session_id"] and session_id != payment["checkout_session_id"])
        or session.get("client_reference_id") != request_id
        or session.get("amount_total") != payment["amount_cents"]
        or session.get("currency") != "usd"
        or any(metadata.get(name) != value for name, value in binding(request_id, payment).items())
    ):
        raise AdvisorReviewError("ADVISOR_BILLING_UNCONFIRMED", 503)


def create_checkout(provider, key, request_id, payment):
    metadata = binding(request_id, payment)
    return_url = (
        f"{_app_origin()}/one/kai/portfolio/analysis?advisorReview={request_id}&advisorSection=plan"
    )
    session = _stripe_dict(
        provider.checkout.Session.create(
            api_key=key,
            mode="payment",
            # No payment_method_types: Stripe retired the explicit list for Checkout
            # (see drive_request_payment_service), and sending it fails with 400.
            idempotency_key=(
                f"advisor-payment:{request_id}:{payment['plan_revision']}:{payment['attempt']}:dynamic-methods-v1"
            ),
            client_reference_id=request_id,
            metadata=metadata,
            payment_intent_data={
                "metadata": metadata,
                "transfer_data": {"destination": payment["payee_account"]},
            },
            line_items=[
                {
                    "quantity": 1,
                    "price_data": {
                        "currency": "usd",
                        "unit_amount": payment["amount_cents"],
                        "product_data": {"name": "Advisor services"},
                    },
                }
            ],
            success_url=return_url,
            cancel_url=return_url,
        )
    )
    verify_session(session, request_id, payment)
    return session


def read_checkout(provider, key, request_id, payment, session_id):
    session = _stripe_dict(
        provider.checkout.Session.retrieve(
            session_id, api_key=key, expand=["payment_intent.latest_charge"]
        )
    )
    verify_session(session, request_id, {**payment, "checkout_session_id": session_id})
    return session


def checkout_expired(session):
    intent = session.get("payment_intent")
    return (
        session.get("status") == "expired"
        and session.get("payment_status") == "unpaid"
        and (
            intent is None
            or (
                isinstance(intent, dict)
                and intent.get("status") == "canceled"
                and intent.get("amount_received") == 0
            )
        )
    )


def restart_checkout(conn, request_id, revision):
    conn.execute(
        text("""UPDATE advisor_review_payments
        SET attempt=attempt+1,attempt_started_at=clock_timestamp(),
            status='preparing',checkout_session_id=NULL
        WHERE request_id=CAST(:id AS uuid) AND plan_revision=:revision"""),
        {"id": request_id, "revision": revision},
    )
    return load_payment(conn, request_id, revision)


def record_checkout(conn, request_id, payment, session):
    """Only a provider-confirmed charge can make a one-time offer paid."""
    intent_id = paid_at = None
    if checkout_expired(session):
        status = "expired"
    elif session.get("status") == "open":
        status = "checkout_pending"
    elif session.get("status") == "complete" and session.get("payment_status") != "paid":
        status = "processing"
    elif session.get("status") == "complete":
        intent = session.get("payment_intent")
        charge = intent.get("latest_charge") if isinstance(intent, dict) else None
        if not isinstance(charge, dict) or (
            intent.get("livemode") is not False
            or intent.get("status") != "succeeded"
            or intent.get("amount_received") != payment["amount_cents"]
            or intent.get("currency") != "usd"
            or (intent.get("transfer_data") or {}).get("destination") != payment["payee_account"]
            or any(
                (intent.get("metadata") or {}).get(name) != value
                for name, value in binding(request_id, payment).items()
            )
            or not isinstance(intent.get("id"), str)
            or not intent["id"].startswith("pi_")
            or charge.get("payment_intent") != intent["id"]
            or charge.get("livemode") is not False
            or charge.get("paid") is not True
            or charge.get("captured") is not True
            or charge.get("currency") != "usd"
            or charge.get("amount_captured") != payment["amount_cents"]
            or type(charge.get("created")) is not int
            or type(charge.get("amount_refunded")) is not int
            or not 0 <= charge["amount_refunded"] <= payment["amount_cents"]
        ):
            raise AdvisorReviewError("ADVISOR_BILLING_UNCONFIRMED", 503)
        status = "paid"
        if charge["amount_refunded"] == payment["amount_cents"]:
            status = "refunded"
        elif charge["amount_refunded"]:
            status = "partially_refunded"
        intent_id = intent["id"]
        paid_at = datetime.fromtimestamp(charge["created"], UTC)
    else:
        raise AdvisorReviewError("ADVISOR_BILLING_UNCONFIRMED", 503)
    if payment["paid_at"] and (
        not paid_at or payment["payment_intent_id"] != intent_id or payment["paid_at"] != paid_at
    ):
        raise AdvisorReviewError("ADVISOR_BILLING_UNCONFIRMED", 503)
    conn.execute(
        text("""UPDATE advisor_review_payments
        SET checkout_session_id=:session, payment_intent_id=:intent, status=:status, paid_at=:paid_at
        WHERE request_id=CAST(:id AS uuid) AND plan_revision=:revision"""),
        {
            "id": request_id,
            "revision": payment["plan_revision"],
            "session": session["id"],
            "intent": intent_id,
            "status": status,
            "paid_at": paid_at,
        },
    )
    return {
        "mode": "test",
        "status": status,
        "planRevision": payment["plan_revision"],
        **(
            {"amountCents": payment["amount_cents"], "paidAt": paid_at.isoformat()}
            if paid_at
            else {}
        ),
    }


def retire_checkout(conn, session_id):
    conn.execute(
        text("""INSERT INTO advisor_billing_cleanup(resource_id,resource_kind,stripe_mode)
        VALUES(:id,'checkout','test') ON CONFLICT DO NOTHING"""),
        {"id": session_id},
    )

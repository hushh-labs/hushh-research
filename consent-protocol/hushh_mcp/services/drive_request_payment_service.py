"""Stripe-hosted Checkout for a fixed $10 Drive request, with DB-bound settlement."""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime
from urllib.parse import quote, urlsplit
from uuid import uuid4

import stripe
from sqlalchemy import text

from hushh_mcp.runtime_settings import get_app_runtime_settings
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.drive_request_payment_store import (
    DriveRequestPaymentStore,
    _payer_ref,
    _request_id,
)
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_sharing_store import DriveSharingStore
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.google_drive_adapter import DriveReadError


def _stripe_dict(value) -> dict:
    return value if isinstance(value, dict) else value.to_dict()


def _config() -> tuple[str, str, str]:
    key = (os.getenv("STRIPE_SECRET_KEY") or "").strip()
    webhook_secret = (os.getenv("STRIPE_WEBHOOK_SECRET") or "").strip()
    origin = get_app_runtime_settings().app_frontend_origin.rstrip("/")
    runtime_environment = (os.getenv("ENVIRONMENT") or "").strip().lower()
    deploy_environment = (os.getenv("HUSHH_DEPLOY_ENV") or "").strip().lower()
    if (
        runtime_environment in {"uat", "production"}
        and deploy_environment in {"uat", "production"}
        and runtime_environment != deploy_environment
    ):
        raise DriveSharingError("payment_unavailable")
    expected_prefix = (
        "sk_live_" if "production" in {runtime_environment, deploy_environment} else "sk_test_"
    )
    parsed = urlsplit(origin)
    if (
        not key.startswith(expected_prefix)
        or len(key) < 24
        or not webhook_secret.startswith("whsec_")
        or len(webhook_secret) < 20
        or parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise DriveSharingError("payment_unavailable")
    return key, webhook_secret, origin


def _checkout_return_url(origin: str, request_id: str, result: str) -> str:
    return f"{origin}/one/feed?paymentRequestId={quote(request_id)}&checkout={result}"


def require_payment_configuration() -> None:
    """Fail request admission before persisting a new paid requirement."""
    _config()


class DriveRequestPaymentService(DriveRequestPaymentStore):
    def __init__(self, db=None, *, stripe_api=None):
        super().__init__(db)
        self.stripe_api = stripe_api or stripe

    async def ensure_payment_for_frozen_batch(
        self, user_id: str, request_id: str, share_id: str
    ) -> dict:
        result = await super().ensure_payment_for_frozen_batch(user_id, request_id, share_id)
        if result.get("notificationQueued"):
            await wake_drive_work("sharing")
        return result

    async def get_payment(self, *, requester_user_id: str, request_id: str) -> dict:
        return await self.payment_state(requester_user_id=requester_user_id, request_id=request_id)

    async def reconcile_refunds(self, *, max_orders: int = 4) -> dict:
        from hushh_mcp.services.drive_request_payment_refunds import reconcile_refunds

        return await reconcile_refunds(self, max_orders=max_orders)

    def _current_checkout_authority(
        self, connection, *, request_id: str, requester_user_id: str
    ) -> dict:
        """Recheck the same Trusted/background boundary under graph and request locks."""
        participant = self._row(
            connection,
            """SELECT user_id,recipient_user_id FROM drive_share_requests
               WHERE request_id=:request AND recipient_user_id=:requester""",
            {"request": request_id, "requester": requester_user_id},
        )
        if participant is None:
            raise DriveSharingError("request_unavailable")
        owner = participant["user_id"]
        sharing = DriveSharingStore(db=self.db)
        sharing._sharing_admission(owner)
        if not connector_feature_enabled("google_drive_chat_reads", owner):
            raise DriveSharingError("payment_not_ready")
        participants = sharing._participant_gate(connection, owner, request_id)
        preferences = DriveLivePreferences(db=self.db)
        current = preferences.live_active(connection, user_id=owner)
        preferences.background_current(
            connection, user_id=owner, generation=current["connection_generation"]
        )
        request = sharing._related_request(connection, owner, request_id)
        if (
            request["recipient_user_id"] != requester_user_id
            or request["status"] != "pending"
            or request["expires_at"] <= datetime.now(UTC)
            or request["preparation_error_code"] == "manual_search_active"
            or sharing._open_request(request).get("trusted_auto") is not True
            or not sharing._trusted_recipient_current(
                connection, owner, participants["recipient_user_id"]
            )
        ):
            raise DriveSharingError("payment_not_ready")
        return request

    async def checkout(self, *, requester_user_id: str, request_id: str) -> dict:
        key, _, origin = _config()
        request_id = _request_id(request_id)
        state = await self.payment_state(requester_user_id=requester_user_id, request_id=request_id)
        if state["status"] == "paid":
            raise DriveSharingError("payment_already_paid")
        if state["status"] not in {"awaiting_payment", "checkout_open"}:
            raise DriveSharingError("payment_not_ready")

        def reserve(connection):
            self._current_checkout_authority(
                connection, request_id=request_id, requester_user_id=requester_user_id
            )
            order = self._row(
                connection,
                """SELECT o.*,r.status AS request_status,r.expires_at AS request_expires_at
                   FROM drive_request_payment_orders o
                   JOIN drive_share_requests r ON r.request_id=o.request_id
                   WHERE o.request_id=:request AND o.requester_user_id=:requester
                     AND r.payment_required=TRUE FOR UPDATE OF o""",
                {"request": request_id, "requester": requester_user_id},
            )
            if (
                order is None
                or order["request_status"] != "pending"
                or order["request_expires_at"] <= datetime.now(UTC)
            ):
                raise DriveSharingError("payment_not_ready")
            if order["status"] == "paid":
                raise DriveSharingError("payment_already_paid")
            if order["status"] not in {"awaiting_payment", "checkout_open"}:
                raise DriveSharingError("payment_not_ready")
            if order["stripe_checkout_url"] and order["stripe_checkout_expires_at"] > datetime.now(
                UTC
            ):
                return order
            if order["stripe_checkout_session_id"]:
                return {**order, "expired_checkout": True}
            attempt_id = order["checkout_attempt_id"] or str(uuid4())
            connection.execute(
                text("""UPDATE drive_request_payment_orders SET checkout_attempt_id=:attempt,
                     updated_at=clock_timestamp() WHERE request_id=:request"""),
                {"attempt": attempt_id, "request": request_id},
            )
            order["checkout_attempt_id"] = attempt_id
            return order

        order = await self._transaction(reserve)
        if order.get("expired_checkout"):
            old_session_id = order["stripe_checkout_session_id"]
            try:
                old_session = _stripe_dict(
                    await asyncio.to_thread(
                        self.stripe_api.checkout.Session.retrieve, old_session_id, api_key=key
                    )
                )
            except Exception:
                raise DriveSharingError("payment_unavailable") from None
            if (
                old_session.get("id") != old_session_id
                or old_session.get("status") != "expired"
                or old_session.get("payment_status") == "paid"
            ):
                raise DriveSharingError("payment_checkout_expired")

            def rotate(connection):
                self._current_checkout_authority(
                    connection, request_id=request_id, requester_user_id=requester_user_id
                )
                current = self._row(
                    connection,
                    """SELECT * FROM drive_request_payment_orders
                       WHERE request_id=:request AND requester_user_id=:requester FOR UPDATE""",
                    {"request": request_id, "requester": requester_user_id},
                )
                if (
                    current is None
                    or current["status"] not in {"awaiting_payment", "checkout_open"}
                    or current["stripe_checkout_session_id"] != old_session_id
                ):
                    raise DriveSharingError("payment_not_ready")
                connection.execute(
                    text("""UPDATE drive_request_payment_orders
                  SET status='awaiting_payment',checkout_attempt_id=:attempt,
                    stripe_checkout_session_id=NULL,stripe_checkout_url=NULL,
                    stripe_checkout_expires_at=NULL,updated_at=clock_timestamp()
                  WHERE request_id=:request"""),
                    {"attempt": str(uuid4()), "request": request_id},
                )

            await self._transaction(rotate)
            order = await self._transaction(reserve)
        if order["stripe_checkout_url"]:
            return {"checkoutUrl": order["stripe_checkout_url"]}

        def create():
            return self.stripe_api.checkout.Session.create(
                mode="payment",
                payment_method_types=["card"],
                line_items=[
                    {
                        "price_data": {
                            "currency": "usd",
                            "unit_amount": 1000,
                            "product_data": {"name": "Document request"},
                        },
                        "quantity": 1,
                    }
                ],
                client_reference_id=request_id,
                metadata={
                    "payment_kind": "drive_request",
                    "request_id": request_id,
                    "payer_ref": _payer_ref(request_id, requester_user_id),
                    "checkout_attempt_id": str(order["checkout_attempt_id"]),
                },
                payment_intent_data={
                    "metadata": {
                        "payment_kind": "drive_request",
                        "request_id": request_id,
                        "payer_ref": _payer_ref(request_id, requester_user_id),
                        "checkout_attempt_id": str(order["checkout_attempt_id"]),
                    }
                },
                success_url=_checkout_return_url(origin, request_id, "success"),
                cancel_url=_checkout_return_url(origin, request_id, "cancel"),
                api_key=key,
                idempotency_key=f"drive-request-{request_id}-{order['checkout_attempt_id']}",
            )

        try:
            session = _stripe_dict(await asyncio.to_thread(create))
        except Exception:
            raise DriveSharingError("payment_unavailable") from None
        if (
            session.get("mode") != "payment"
            or session.get("client_reference_id") != request_id
            or session.get("amount_total") != 1000
            or session.get("currency") != "usd"
            or session.get("livemode") != key.startswith("sk_live_")
            or session.get("metadata", {}).get("payer_ref")
            != _payer_ref(request_id, requester_user_id)
            or session.get("metadata", {}).get("payment_kind") != "drive_request"
            or session.get("metadata", {}).get("request_id") != request_id
            or session.get("metadata", {}).get("checkout_attempt_id")
            != str(order["checkout_attempt_id"])
            or not isinstance(session.get("id"), str)
            or not isinstance(session.get("url"), str)
            or not session["url"].startswith("https://checkout.stripe.com/")
            or not isinstance(session.get("expires_at"), int)
        ):
            raise DriveSharingError("payment_unavailable")

        def bind(connection):
            self._current_checkout_authority(
                connection, request_id=request_id, requester_user_id=requester_user_id
            )
            current = self._row(
                connection,
                """SELECT * FROM drive_request_payment_orders
                   WHERE request_id=:request AND requester_user_id=:requester FOR UPDATE""",
                {"request": request_id, "requester": requester_user_id},
            )
            if current is None or current["status"] in {"paid", "refunded", "expired"}:
                raise DriveSharingError("payment_not_ready")
            if str(current["checkout_attempt_id"]) != str(order["checkout_attempt_id"]):
                raise DriveSharingError("payment_not_ready")
            if current["stripe_checkout_session_id"] not in {None, session["id"]}:
                raise DriveSharingError("payment_unavailable")
            connection.execute(
                text("""UPDATE drive_request_payment_orders
                   SET status='checkout_open',stripe_checkout_session_id=:session,
                     stripe_checkout_url=:url,stripe_checkout_expires_at=to_timestamp(:expires),
                     updated_at=clock_timestamp() WHERE request_id=:request"""),
                {
                    "session": session["id"],
                    "url": session["url"],
                    "expires": session["expires_at"],
                    "request": request_id,
                },
            )
            return {"checkoutUrl": session["url"]}

        return await self._transaction(bind)

    async def process_webhook(self, *, payload: bytes, signature: str | None) -> None:
        key, webhook_secret, _ = _config()
        try:
            event = _stripe_dict(
                self.stripe_api.Webhook.construct_event(payload, signature, webhook_secret)
            )
        except (ValueError, stripe.error.SignatureVerificationError):
            raise DriveSharingError("payment_invalid_signature") from None
        if event.get("type") not in {
            "checkout.session.completed",
            "checkout.session.async_payment_succeeded",
        }:
            return
        session = event.get("data", {}).get("object", {})
        metadata = session.get("metadata") or {}
        if metadata.get("payment_kind") != "drive_request":
            return
        try:
            request_id = _request_id(metadata.get("request_id"))
        except DriveSharingError:
            raise DriveSharingError("payment_invalid_event") from None
        if (
            session.get("object") != "checkout.session"
            or session.get("id") is None
            or session.get("client_reference_id") != request_id
            or session.get("mode") != "payment"
            or session.get("payment_status") != "paid"
            or session.get("amount_total") != 1000
            or session.get("currency") != "usd"
            or session.get("livemode") != key.startswith("sk_live_")
            or not isinstance(session.get("payment_intent"), str)
            or not isinstance(event.get("id"), str)
        ):
            raise DriveSharingError("payment_invalid_event")

        def settle(connection):
            initial = self._row(
                connection,
                """SELECT user_id,recipient_user_id FROM drive_share_requests
                   WHERE request_id=:request""",
                {"request": request_id},
            )
            if initial is not None:
                from hushh_mcp.services.connection_graph_service import lock_connection_graph_users

                # Even failed authority checks may still record a paid event.
                # Take participant graph gates before request/order locks and
                # before the Feed insert guard can acquire them implicitly.
                lock_connection_graph_users(
                    connection, user_ids=[initial["user_id"], initial["recipient_user_id"]]
                )
            authority_current = False
            if initial is not None:
                try:
                    self._current_checkout_authority(
                        connection,
                        request_id=request_id,
                        requester_user_id=initial["recipient_user_id"],
                    )
                    authority_current = True
                except (DriveSharingError, DriveReadError):
                    pass
            request = self._row(
                connection,
                """SELECT * FROM drive_share_requests WHERE request_id=:request
                   FOR UPDATE""",
                {"request": request_id},
            )
            order = self._row(
                connection,
                """SELECT * FROM drive_request_payment_orders
                   WHERE request_id=:request FOR UPDATE""",
                {"request": request_id},
            )
            obligation = self._row(
                connection,
                """SELECT * FROM drive_request_payment_obligations
                   WHERE request_id=:request FOR UPDATE""",
                {"request": request_id},
            )
            binding = order if request is not None else obligation
            if (
                binding is None
                or obligation is None
                or (request is not None and (order is None or not request["payment_required"]))
                or (request is None and (order is not None or obligation["erased_at"] is None))
                or binding["stripe_checkout_session_id"]
                not in ({session["id"]} if request is not None else {None, session["id"]})
                or metadata.get("payer_ref") != obligation["payer_ref"]
                or (
                    binding["checkout_attempt_id"] is not None
                    and metadata.get("checkout_attempt_id") != str(binding["checkout_attempt_id"])
                )
                or (request is None and binding["checkout_attempt_id"] is None)
                or binding["amount_cents"] != session["amount_total"]
                or binding["currency"] != session["currency"]
                or binding["stripe_payment_intent_id"] not in {None, session["payment_intent"]}
            ):
                raise DriveSharingError("payment_invalid_event")
            if binding["status"] == "refunded":
                return False
            if binding["status"] != "paid":
                reconciliation_reason = None
                if request is None:
                    reconciliation_reason = "account_erased"
                elif request["status"] != "pending" or request["expires_at"] <= datetime.now(UTC):
                    reconciliation_reason = "request_closed"
                elif not authority_current:
                    reconciliation_reason = "authority_changed"
                if request is None:
                    connection.execute(
                        text("""UPDATE drive_request_payment_obligations
                       SET status='paid',paid_at=clock_timestamp(),
                           stripe_checkout_session_id=COALESCE(stripe_checkout_session_id,:session),
                           stripe_payment_intent_id=:intent,reconciliation_required=TRUE,
                           updated_at=clock_timestamp()
                       WHERE request_id=:request"""),
                        {
                            "request": request_id,
                            "session": session["id"],
                            "intent": session["payment_intent"],
                        },
                    )
                else:
                    connection.execute(
                        text("""UPDATE drive_request_payment_orders
                       SET status='paid',paid_at=clock_timestamp(),stripe_checkout_url=NULL,
                           stripe_checkout_session_id=COALESCE(stripe_checkout_session_id,:session),
                           stripe_payment_intent_id=:intent,
                           reconciliation_required=(reconciliation_required OR :reason IS NOT NULL),
                           reconciliation_reason=COALESCE(reconciliation_reason,:reason),
                           reconciliation_at=CASE WHEN reconciliation_required OR :reason IS NOT NULL
                             THEN COALESCE(reconciliation_at,clock_timestamp()) ELSE NULL END,
                           updated_at=clock_timestamp()
                       WHERE request_id=:request"""),
                        {
                            "intent": session["payment_intent"],
                            "request": request_id,
                            "reason": reconciliation_reason,
                            "session": session["id"],
                        },
                    )
                    self._event(connection, request, "document_share_payment_confirmed")
            connection.execute(
                text("""INSERT INTO drive_request_payment_webhook_events
                   (stripe_event_id,stripe_checkout_session_id,request_id)
                   VALUES (:event,:session,:request)
                   ON CONFLICT (stripe_event_id) DO NOTHING"""),
                {"event": event["id"], "session": session["id"], "request": request_id},
            )
            return "sharing" if request is None else "suggestions"

        wake_stage = await self._transaction(settle)
        if wake_stage:
            # Best effort: the database state and scheduled drain remain authority.
            await wake_drive_work(wake_stage)

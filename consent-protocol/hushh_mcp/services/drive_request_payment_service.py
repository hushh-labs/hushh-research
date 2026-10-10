"""Stripe-hosted Checkout for one Drive request at its order's fixed price.

Settlement is bound to the database order: the Checkout amount comes from the
order row, and a paid event must match that order's amount and currency.
"""

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
from hushh_mcp.services.drive_owner_allowed import (
    MAX_OWNER_PRICE_CENTS,
    MIN_OWNER_PRICE_CENTS,
    automatic_recipient_current,
    valid_owner_price_cents,
)
from hushh_mcp.services.drive_request_payment_store import (
    DriveRequestPaymentStore,
    _payer_ref,
    _request_id,
)
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_sharing_store import DriveSharingStore
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.stripe_mode import (
    configured_stripe_mode,
    stripe_environment,
    stripe_key_mode,
)

# Stripe requires at least 30 minutes; keep a minute of transport/clock slack.
CHECKOUT_HOLD_SECONDS = 31 * 60


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
    try:
        stripe_key_mode(key)
    except ValueError:
        raise DriveSharingError("payment_unavailable") from None
    parsed = urlsplit(origin)
    if (
        not webhook_secret.startswith("whsec_")
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
        state = await self.payment_state(requester_user_id=requester_user_id, request_id=request_id)
        return {key: value for key, value in state.items() if not key.startswith("_payout_")}

    async def reconcile_refunds(self, *, max_orders: int = 4) -> dict:
        from hushh_mcp.services.drive_request_payment_refunds import reconcile_refunds

        await self.repair_paid_request_authority(limit=min(256, max_orders * 16))
        return await reconcile_refunds(self, max_orders=max_orders)

    def _current_checkout_authority(
        self, connection, *, request_id: str, requester_user_id: str
    ) -> dict:
        """Recheck the same automatic/background boundary under graph and request locks.

        Automatic means current Trusted membership, or this request's sealed
        owner Allow while the pair is still connected.
        """
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
        participants = sharing._participant_gate(connection, owner, request_id)
        request = sharing._related_request(connection, owner, request_id)
        if (
            request["recipient_user_id"] != requester_user_id
            or request["expires_at"] <= datetime.now(UTC)
            or request["access_stop_requested_at"] is not None
        ):
            raise DriveSharingError("payment_not_ready")
        private = sharing._open_request(request)
        purpose = private.get("purpose", {})
        if request["status"] == "pending" and not (
            purpose.get("periodStart") and purpose.get("periodEnd")
        ):
            raise DriveSharingError("date_range_required")
        if private.get("trusted_auto") is True:
            preferences = DriveLivePreferences(db=self.db)
            current = preferences.live_active(connection, user_id=owner)
            preferences.background_current(
                connection, user_id=owner, generation=current["connection_generation"]
            )
            trusted_valid = (
                request["status"] == "pending"
                and request["preparation_error_code"] != "manual_search_active"
                and connector_feature_enabled("google_drive_chat_reads", owner)
                and automatic_recipient_current(
                    connection,
                    owner,
                    participants["recipient_user_id"],
                    private,
                    request_id=request_id,
                )
            )
        else:
            # Without the automatic marker (no Trusted creation, no owner
            # Allow), requests retain per-batch owner consent. Payment is
            # available only after that consent has queued an immutable batch.
            # Progressive requests intentionally remain pending so later
            # batches can still be reviewed and paid by the same order.
            trusted_valid = connector_feature_enabled("google_drive_chat_reads", owner) and (
                request["status"] in {"approved", "partial"}
                or (
                    request["status"] == "pending"
                    and self.owner_approved_progressive_batch(connection, request)
                )
            )
        if not trusted_valid:
            raise DriveSharingError("payment_not_ready")
        return request

    async def checkout(self, *, requester_user_id: str, request_id: str) -> dict:
        key, _, origin = _config()
        request_id = _request_id(request_id)
        state = await self.payment_state(requester_user_id=requester_user_id, request_id=request_id)
        if state["status"] == "paid":
            raise DriveSharingError("payment_already_paid")
        if state["status"] == "expired" and state.get("paymentLinkExpired") is True:
            raise DriveSharingError("payment_checkout_expired")
        if state["status"] not in {"awaiting_payment", "checkout_open"}:
            raise DriveSharingError("payment_not_ready")

        # A newly enrolled owner-paid order must have a live US Connect
        # destination before charging the requester. Existing orders without
        # a ledger remain on their original Hushh-merchant terms.
        payout_enrolled = state.get("_payout_enrolled") is True
        verified_account_id = None
        if payout_enrolled:
            from hushh_mcp.services.drive_request_owner_payout_service import payout_enabled
            from hushh_mcp.services.pkm_payout_service import PkmPayoutService

            if not payout_enabled() or not state.get("_payout_owner_user_id"):
                raise DriveSharingError("payment_unavailable")
            try:
                account = await PkmPayoutService().refresh_account(
                    user_id=state["_payout_owner_user_id"]
                )
            except Exception:
                raise DriveSharingError("payment_unavailable") from None
            if not account or not account["readiness"]["ready"]:
                raise DriveSharingError("payment_not_ready")
            verified_account_id = account["stripe_account_id"]

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
                or order.get("stripe_mode") != configured_stripe_mode()
                or order["request_status"] not in {"pending", "approved", "partial"}
                or order["request_expires_at"] <= datetime.now(UTC)
            ):
                raise DriveSharingError("payment_not_ready")
            if order["status"] == "paid":
                raise DriveSharingError("payment_already_paid")
            # The first provider-backed payment window is the only one for
            # this request. Never rotate an expired or already-bound session.
            if order["status"] == "expired":
                raise DriveSharingError("payment_checkout_expired")
            if order["status"] not in {"awaiting_payment", "checkout_open"}:
                raise DriveSharingError("payment_not_ready")
            if payout_enrolled:
                # Keep the verified destination on the ownerless earning row.
                # The live owner mapping is removed during account erasure.
                current_account = self._row(
                    connection,
                    """SELECT stripe_account_id,details_submitted,payouts_enabled
                       FROM stripe_owner_payout_accounts WHERE user_id=:owner AND stripe_mode=:stripe_mode FOR SHARE""",
                    {
                        "owner": state["_payout_owner_user_id"],
                        "stripe_mode": configured_stripe_mode(),
                    },
                )
                if (
                    current_account is None
                    or current_account["stripe_account_id"] != verified_account_id
                    or not current_account["details_submitted"]
                    or not current_account["payouts_enabled"]
                ):
                    raise DriveSharingError("payment_not_ready")
                bound = self._row(
                    connection,
                    """UPDATE drive_request_owner_payouts
                       SET destination_account_id=COALESCE(destination_account_id,:account),
                           updated_at=clock_timestamp()
                       WHERE request_id=:request AND status='awaiting_delivery'
                         AND (destination_account_id IS NULL OR destination_account_id=:account)
                       RETURNING destination_account_id""",
                    {"request": request_id, "account": verified_account_id},
                )
                if bound is None:
                    raise DriveSharingError("payment_unavailable")
            now = datetime.now(UTC)
            reserved_expiry = order.get("stripe_checkout_expires_at")
            if (
                order["stripe_checkout_session_id"]
                and reserved_expiry is not None
                and reserved_expiry <= now
            ):
                raise DriveSharingError("payment_checkout_expired")
            if order["stripe_checkout_url"] and reserved_expiry is not None:
                return order
            if order["stripe_checkout_session_id"]:
                raise DriveSharingError("payment_unavailable")
            # The stored order amount is the Checkout price. An amount outside
            # the whole-dollar price range never reaches the provider.
            if not valid_owner_price_cents(order["amount_cents"]) or order["currency"] != "usd":
                raise DriveSharingError("payment_unavailable")
            # Reserve the exact Stripe payload before provider I/O. Replays
            # must use the same expiration with the same idempotency key.
            # A failed, never-exposed attempt can restart only after its
            # entire possible provider window has elapsed.
            if order["checkout_attempt_id"] is None or (
                reserved_expiry is not None and reserved_expiry <= now
            ):
                attempt_id = str(uuid4())
                expires_at = int(now.timestamp()) + CHECKOUT_HOLD_SECONDS
            else:
                attempt_id = order["checkout_attempt_id"]
                expires_at = (
                    int(reserved_expiry.timestamp())
                    if reserved_expiry is not None
                    else int(now.timestamp()) + CHECKOUT_HOLD_SECONDS
                )
            connection.execute(
                text("""UPDATE drive_request_payment_orders SET checkout_attempt_id=:attempt,
                     stripe_checkout_expires_at=to_timestamp(:expires),
                     updated_at=clock_timestamp() WHERE request_id=:request"""),
                {"attempt": attempt_id, "expires": expires_at, "request": request_id},
            )
            order["checkout_attempt_id"] = attempt_id
            order["stripe_checkout_expires_at"] = datetime.fromtimestamp(expires_at, UTC)
            return order

        order = await self._transaction(reserve)
        if order["stripe_checkout_url"]:
            return {"checkoutUrl": order["stripe_checkout_url"]}

        checkout_expires_at = int(order["stripe_checkout_expires_at"].timestamp())

        def create():
            params = dict(
                mode="payment",
                line_items=[
                    {
                        "price_data": {
                            "currency": order["currency"],
                            "unit_amount": order["amount_cents"],
                            "product_data": {"name": "Document request"},
                        },
                        "quantity": 1,
                    }
                ],
                client_reference_id=request_id,
                expires_at=checkout_expires_at,
                metadata={
                    "payment_kind": "drive_request",
                    "hussh_environment": stripe_environment(),
                    "request_id": request_id,
                    "payer_ref": _payer_ref(request_id, requester_user_id),
                    "checkout_attempt_id": str(order["checkout_attempt_id"]),
                },
                payment_intent_data={
                    "metadata": {
                        "payment_kind": "drive_request",
                        "hussh_environment": stripe_environment(),
                        "request_id": request_id,
                        "payer_ref": _payer_ref(request_id, requester_user_id),
                        "checkout_attempt_id": str(order["checkout_attempt_id"]),
                    },
                    **(
                        {"transfer_group": f"drive-request-{request_id}"} if payout_enrolled else {}
                    ),
                },
                success_url=_checkout_return_url(origin, request_id, "success"),
                cancel_url=_checkout_return_url(origin, request_id, "cancel"),
                api_key=key,
                idempotency_key=f"drive-request-{request_id}-{order['checkout_attempt_id']}",
            )
            try:
                return self.stripe_api.checkout.Session.create(**params)
            except stripe.IdempotencyError as exc:
                if exc.http_status != 400:
                    raise
                # Recover attempts reserved before Stripe retired explicit methods.
                # Replay the exact payload first so a cached success is reused.
                try:
                    return self.stripe_api.checkout.Session.create(
                        **params, payment_method_types=["card"]
                    )
                except stripe.InvalidRequestError as exc:
                    if exc.http_status != 400 or exc.param != "payment_method_types":
                        raise
                # Only a definitive parameter rejection permits a new payload key.
                params["idempotency_key"] = (
                    f"drive-request-{request_id}-{order['checkout_attempt_id']}-dynamic-methods-v1"
                )
                return self.stripe_api.checkout.Session.create(**params)

        try:
            session = _stripe_dict(await asyncio.to_thread(create))
        except Exception:
            raise DriveSharingError("payment_unavailable") from None
        session_metadata = session.get("metadata")
        if not isinstance(session_metadata, dict):
            raise DriveSharingError("payment_unavailable")
        if (
            session.get("mode") != "payment"
            or session.get("client_reference_id") != request_id
            or session.get("amount_total") != order["amount_cents"]
            or session.get("currency") != order["currency"]
            or session.get("livemode") is not key.startswith("sk_live_")
            or session_metadata.get("payer_ref") != _payer_ref(request_id, requester_user_id)
            or session_metadata.get("payment_kind") != "drive_request"
            or session_metadata.get("request_id") != request_id
            or session_metadata.get("checkout_attempt_id") != str(order["checkout_attempt_id"])
            or not isinstance(session.get("id"), str)
            or not isinstance(session.get("url"), str)
            or not session["url"].startswith("https://checkout.stripe.com/")
            or type(session.get("expires_at")) is not int
            or session["expires_at"] != checkout_expires_at
        ):
            raise DriveSharingError("payment_unavailable")

        def bind(connection):
            request = self._current_checkout_authority(
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
            if session["expires_at"] <= int(datetime.now(UTC).timestamp()):
                connection.execute(
                    text("""UPDATE drive_request_payment_orders
                       SET status='expired',stripe_checkout_session_id=:session,
                         stripe_checkout_url=NULL,
                         stripe_checkout_expires_at=to_timestamp(:expires),
                         updated_at=clock_timestamp() WHERE request_id=:request"""),
                    {
                        "session": session["id"],
                        "expires": session["expires_at"],
                        "request": request_id,
                    },
                )
                return None, False
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
            notified = self._event(connection, request, "document_share_payment_ready")
            return session["url"], notified

        checkout_url, notified = await self._transaction(bind)
        if checkout_url is None:
            raise DriveSharingError("payment_checkout_expired")
        if notified:
            await wake_drive_work("sharing")
        return {"checkoutUrl": checkout_url}

    async def process_webhook(self, *, payload: bytes, signature: str | None) -> None:
        key, webhook_secret, _ = _config()
        # Stripe raises ValueError for a bad signature/body and TypeError when
        # the signature header is absent or malformed. Both are client input
        # errors; never let either escape as a 500.
        try:
            raw_event = self.stripe_api.Webhook.construct_event(payload, signature, webhook_secret)
        except (ValueError, TypeError, stripe.error.SignatureVerificationError):
            raise DriveSharingError("payment_invalid_signature") from None
        try:
            event = _stripe_dict(raw_event)
        except (AttributeError, TypeError, ValueError):
            raise DriveSharingError("payment_invalid_event") from None
        if not isinstance(event, dict):
            raise DriveSharingError("payment_invalid_event")
        event_type = event.get("type")
        if event_type not in {
            "checkout.session.completed",
            "checkout.session.async_payment_succeeded",
            "checkout.session.expired",
        }:
            return
        data = event.get("data")
        session = data.get("object") if isinstance(data, dict) else None
        metadata = session.get("metadata") if isinstance(session, dict) else None
        metadata = metadata or {}
        if not isinstance(session, dict) or not isinstance(metadata, dict):
            raise DriveSharingError("payment_invalid_event")
        if metadata.get("payment_kind") != "drive_request":
            return
        environment = metadata.get("hussh_environment")
        if environment is not None and not isinstance(environment, str):
            raise DriveSharingError("payment_invalid_event")
        if environment not in {None, stripe_environment()}:
            if environment in {"uat", "production", "dev", "local"}:
                return
            raise DriveSharingError("payment_invalid_event")
        try:
            request_id = _request_id(metadata.get("request_id"))
        except DriveSharingError:
            raise DriveSharingError("payment_invalid_event") from None
        expired_event = event_type == "checkout.session.expired"
        # Amount shape only: the locked order or obligation amount below is
        # the settlement authority, and the session must match it exactly.
        amount_total = session.get("amount_total")
        if (
            session.get("object") != "checkout.session"
            or not isinstance(session.get("id"), str)
            or session.get("client_reference_id") != request_id
            or session.get("mode") != "payment"
            or (not expired_event and session.get("payment_status") != "paid")
            or type(amount_total) is not int
            or not MIN_OWNER_PRICE_CENTS <= amount_total <= MAX_OWNER_PRICE_CENTS
            or session.get("currency") != "usd"
            or session.get("livemode") is not key.startswith("sk_live_")
            or (not expired_event and not isinstance(session.get("payment_intent"), str))
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
            if binding is not None and binding.get("stripe_mode") != configured_stripe_mode():
                raise DriveSharingError("payment_invalid_event")
            # Stripe can deliver expiration for an older Checkout session after
            # the requester has already opened a replacement. It is a valid,
            # signed event, but must not invalidate the newer attempt.
            if (
                expired_event
                and request is not None
                and order is not None
                and (
                    order["stripe_checkout_session_id"] not in {None, session["id"]}
                    or (
                        order["checkout_attempt_id"] is not None
                        and metadata.get("checkout_attempt_id") != str(order["checkout_attempt_id"])
                    )
                )
            ):
                # A late expiration for a superseded session is harmless, but
                # still require the opaque payer binding before acknowledging
                # it. This keeps malformed signed events from being silently
                # accepted as unrelated stale sessions.
                if obligation is None or metadata.get("payer_ref") != obligation["payer_ref"]:
                    raise DriveSharingError("payment_invalid_event")
                connection.execute(
                    text("""INSERT INTO drive_request_payment_webhook_events
                       (stripe_event_id,stripe_checkout_session_id,request_id)
                       VALUES (:event,:session,:request)
                       ON CONFLICT (stripe_event_id) DO NOTHING"""),
                    {"event": event["id"], "session": session["id"], "request": request_id},
                )
                return False
            if (
                binding is None
                or obligation is None
                or (request is not None and (order is None or not request["payment_required"]))
                or (request is None and (order is not None or obligation["erased_at"] is None))
                or (
                    request is not None
                    and not (
                        binding["stripe_checkout_session_id"] == session["id"]
                        or (
                            binding["stripe_checkout_session_id"] is None
                            and binding["checkout_attempt_id"] is not None
                            and metadata.get("checkout_attempt_id")
                            == str(binding["checkout_attempt_id"])
                        )
                    )
                )
                or (
                    request is None
                    and binding["stripe_checkout_session_id"] not in {None, session["id"]}
                )
                or metadata.get("payer_ref") != obligation["payer_ref"]
                or (
                    binding["checkout_attempt_id"] is not None
                    and metadata.get("checkout_attempt_id") != str(binding["checkout_attempt_id"])
                )
                or (request is None and binding["checkout_attempt_id"] is None)
                or binding["amount_cents"] != session["amount_total"]
                or binding["currency"] != session["currency"]
                or (
                    not expired_event
                    and binding["stripe_payment_intent_id"]
                    not in {None, session.get("payment_intent")}
                )
            ):
                raise DriveSharingError("payment_invalid_event")
            if expired_event:
                # Expiration closes the single payment window. Keep binding
                # IDs for a delayed, signed paid event and refund review.
                if binding["status"] not in {"paid", "refunded", "expired"}:
                    if request is None:
                        connection.execute(
                            text("""UPDATE drive_request_payment_obligations
                               SET status='expired',
                                   stripe_checkout_session_id=COALESCE(
                                       stripe_checkout_session_id,:session),
                                   updated_at=clock_timestamp()
                               WHERE request_id=:request"""),
                            {"request": request_id, "session": session["id"]},
                        )
                    else:
                        connection.execute(
                            text("""UPDATE drive_request_payment_orders
                               SET status='expired',stripe_checkout_session_id=COALESCE(
                                       stripe_checkout_session_id,:session),
                                   stripe_checkout_url=NULL,
                                   stripe_checkout_expires_at=clock_timestamp(),
                                   updated_at=clock_timestamp()
                               WHERE request_id=:request"""),
                            {"request": request_id, "session": session["id"]},
                        )
                connection.execute(
                    text("""INSERT INTO drive_request_payment_webhook_events
                       (stripe_event_id,stripe_checkout_session_id,request_id)
                       VALUES (:event,:session,:request)
                       ON CONFLICT (stripe_event_id) DO NOTHING"""),
                    {"event": event["id"], "session": session["id"], "request": request_id},
                )
                return False
            if binding["status"] == "refunded":
                return False
            if binding["status"] != "paid":
                reconciliation_reason = None
                if request is None:
                    reconciliation_reason = "account_erased"
                elif request["status"] not in {"pending", "approved", "partial"} or request[
                    "expires_at"
                ] <= datetime.now(UTC):
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
            return (
                "sharing"
                if request is None
                or request["status"] in {"approved", "partial"}
                or self.owner_approved_progressive_batch(connection, request)
                else "suggestions"
            )

        wake_stage = await self._transaction(settle)
        if wake_stage:
            # Best effort: the database state and scheduled drain remain authority.
            await wake_drive_work(wake_stage)

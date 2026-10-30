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
from hushh_mcp.services.document_delivery import payment_integration
from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.drive_owner_allowed import (
    MAX_OWNER_PRICE_CENTS,
    MIN_OWNER_PRICE_CENTS,
    automatic_recipient_current,
    autoshare_owner_allow_authority,
    request_has_document_scope,
    semantic_search_request,
    valid_owner_price_cents,
)
from hushh_mcp.services.drive_request_checkout_refusals import (
    authority_refusal_reason,
    checkout_refusal,
    logs_checkout_refusals,
    refusal_reason,
)
from hushh_mcp.services.drive_request_payment_store import (
    DriveRequestPaymentStore,
    _payer_ref,
    _request_id,
    _search_exists,
)
from hushh_mcp.services.drive_request_queue import automatic_start_parked
from hushh_mcp.services.drive_request_review_policy import request_requires_owner_review
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_sharing_store import DriveSharingStore
from hushh_mcp.services.drive_telemetry import drive_logger, drive_operation, drive_stage
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.stripe_mode import (
    configured_stripe_mode,
    stripe_environment,
    stripe_key_mode,
)

logger = drive_logger(__name__)

# Stripe requires at least 30 minutes; keep a minute of transport/clock slack.
CHECKOUT_HOLD_SECONDS = 31 * 60
# Retiring a withdrawn request's Checkout is best-effort and never blocks it.
CHECKOUT_RETIRE_TIMEOUT_SECONDS = 4
# Proof that an autoshare buyer already has every file of a final set waives
# the charge. The read is bounded; a slow answer leaves checkout open.
FLAT_ACCESS_CHECK_SECONDS = 4


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
    def __init__(self, db=None, *, stripe_api=None, document_delivery=None):
        super().__init__(db)
        self.stripe_api = stripe_api or stripe
        self.document_delivery = document_delivery

    def _guard_legacy_duplicate_purchase(
        self,
        connection,
        *,
        owner_user_id: str,
        requester_user_id: str,
        request_id: str,
        selected_ids: frozenset[str],
        flat_request: bool = False,
    ) -> None:
        """Block another charge for overlapping frozen files and the same buyer.

        The caller holds the owner/buyer graph lock. Source IDs remain inside
        encrypted file envelopes and this transaction; no plaintext manifest is
        persisted or logged. Bounded reads fail closed if comparison is unclear.

        A flat-priced (autoshare) request charges for the request, never per
        file: a file the buyer already has counts as delivered when it is
        granted. Only an earlier paid order that already covers every selected
        file refuses it; an overlap, an unpaid order or an unreadable history
        never holds its checkout back.
        """
        if not selected_ids or len(selected_ids) > 120:
            if flat_request:
                return
            raise checkout_refusal("purchase_history_unclear")
        prior = list(
            connection.execute(
                text("""SELECT o.request_id,o.status FROM drive_request_payment_orders o
                     JOIN drive_share_requests r ON r.request_id=o.request_id
                     WHERE r.user_id=:owner AND r.recipient_user_id=:requester
                       AND o.request_id<>:request
                       AND (o.status='paid' OR
                            (o.checkout_attempt_id IS NOT NULL AND
                             o.status IN ('awaiting_payment','checkout_open')))
                     ORDER BY o.created_at DESC LIMIT 65"""),
                {"owner": owner_user_id, "requester": requester_user_id, "request": request_id},
            ).mappings()
        )
        if len(prior) > 64:
            if flat_request:
                return
            raise checkout_refusal("purchase_history_unclear")
        from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore

        bulk = DriveBulkShareStore(db=self.db)
        for order in prior:
            if flat_request and order["status"] != "paid":
                continue
            rows = list(
                connection.execute(
                    text("""SELECT f.source_job_id,f.source_position,f.metadata_envelope
                         FROM drive_bulk_share_files f
                         JOIN drive_bulk_shares b ON b.share_id=f.share_id
                         WHERE f.user_id=:owner AND f.origin_request_id=:prior
                           AND b.user_id=:owner AND b.origin_request_id=:prior
                         ORDER BY f.source_position LIMIT 121"""),
                    {"owner": owner_user_id, "prior": order["request_id"]},
                ).mappings()
            )
            if not rows:
                continue
            if len(rows) > 120:
                if flat_request:
                    continue
                raise checkout_refusal("purchase_history_unclear")
            try:
                prior_ids = frozenset(
                    bulk._open(
                        row["metadata_envelope"],
                        user_id=owner_user_id,
                        resource_id=f"{row['source_job_id']}:{row['source_position']}",
                        purpose="owner-search-result",
                    )["id"]
                    for row in rows
                )
            except (DriveSharingError, KeyError, TypeError, ValueError):
                if flat_request:
                    continue
                raise checkout_refusal("purchase_history_unclear") from None
            if not prior_ids & selected_ids:
                continue
            if order["status"] == "paid" and selected_ids <= prior_ids:
                raise checkout_refusal("prior_purchase", "payment_already_paid")
            if flat_request:
                continue
            if order["status"] == "paid":
                raise checkout_refusal(
                    "prior_purchase_overlap", "package_existing_access_requires_review"
                )
            raise checkout_refusal("prior_checkout_open")

    async def ensure_payment_for_frozen_batch(
        self, user_id: str, request_id: str, share_id: str
    ) -> dict:
        result = await super().ensure_payment_for_frozen_batch(user_id, request_id, share_id)
        if result.get("notificationQueued"):
            await wake_drive_work("sharing")
        return result

    async def get_payment(self, *, requester_user_id: str, request_id: str) -> dict:
        state = await self.payment_state(requester_user_id=requester_user_id, request_id=request_id)
        return payment_integration.public_payment_state(state)

    async def reconcile_refunds(self, *, max_orders: int = 4, v1_only: bool = False) -> dict:
        from hushh_mcp.services.drive_request_payment_refunds import reconcile_refunds

        if type(v1_only) is not bool:
            raise ValueError("invalid refund reconciliation mode")
        await self.repair_paid_request_authority(
            limit=min(256, max_orders * 16), **({"v1_only": True} if v1_only else {})
        )
        return await reconcile_refunds(
            self, max_orders=max_orders, **({"v1_only": True} if v1_only else {})
        )

    def _retire_session(self, session_id: str, key: str, *, require_unpaid=False) -> str:
        """Prove a Checkout session can no longer be charged.

        Returns ``"dead"``, ``"paid"`` or ``"unknown"``. A failed or timed-out
        expire call is ``"unknown"``, never success: the outcome at Stripe is
        undetermined, so the request_closed webhook and refund stay in charge.
        """

        def classify(session: object) -> str | None:
            try:
                data = _stripe_dict(session)
            except (AttributeError, TypeError, ValueError):
                return None
            if not isinstance(data, dict):
                return None
            if data.get("status") == "expired" and (
                not require_unpaid
                or (
                    data.get("id") == session_id
                    and data.get("payment_status") == "unpaid"
                    and not data.get("payment_intent")
                    and data.get("livemode") is key.startswith("sk_live_")
                )
            ):
                return "dead"
            # Only settled funds count. A complete session paid by a delayed
            # method (e.g. ACH debit) is still "unpaid" and may yet fail, so it
            # stays unknown and the signed webhook remains the authority.
            if data.get("payment_status") == "paid":
                return "paid"
            return None

        verdict: str | None = None
        try:
            verdict = classify(self.stripe_api.checkout.Session.expire(session_id, api_key=key))
        except Exception:  # noqa: BLE001 - every failure mode is "not proven dead"
            logger.info("drive_request.checkout_expire_unconfirmed")
        if verdict is None:
            # Expire also fails for a session that already expired or completed.
            # Read the authoritative state rather than parsing the error.
            try:
                verdict = classify(
                    self.stripe_api.checkout.Session.retrieve(session_id, api_key=key)
                )
            except Exception:  # noqa: BLE001
                logger.info("drive_request.checkout_state_unreadable")
        return verdict or "unknown"

    async def complete_existing_autoshare(self, *, user_id, request_id, result):
        """Retire only the exact unpaid Checkout, then publish fresh existing ACLs."""
        from hushh_mcp.services.drive_package_existing_access_store import (
            DrivePackageExistingAccessStore,
        )
        from hushh_mcp.services.drive_request_payment_store import RetiredCheckout

        def read(connection):
            return self._row(
                connection,
                """SELECT * FROM drive_request_payment_orders
                WHERE request_id=:request AND user_id=:user""",
                {"request": request_id, "user": user_id},
            )

        order = await self._transaction(read)
        retired = None
        if order is not None and order["stripe_checkout_session_id"] is not None:
            if (
                order["paid_at"] is not None
                or order["status"] in {"paid", "refunded"}
                or order["reconciliation_required"]
            ):
                raise checkout_refusal("already_paid", "payment_already_paid")
            key, _, _ = _config()
            if order["stripe_mode"] != configured_stripe_mode():
                raise checkout_refusal("wrong_mode")
            try:
                async with asyncio.timeout(CHECKOUT_RETIRE_TIMEOUT_SECONDS):
                    verdict = await asyncio.to_thread(
                        self._retire_session,
                        order["stripe_checkout_session_id"],
                        key,
                        require_unpaid=True,
                    )
            except TimeoutError:
                raise checkout_refusal("provider_unavailable") from None
            if verdict != "dead":
                raise checkout_refusal(
                    "already_paid" if verdict == "paid" else "provider_unavailable"
                )
            retired = RetiredCheckout(
                order["stripe_checkout_session_id"],
                str(order["checkout_attempt_id"]),
                order["stripe_mode"],
                datetime.now(UTC),
            )
        completed = await DrivePackageExistingAccessStore(db=self.db).complete_autoshare(
            user_id=user_id, request_id=request_id, result=result, retired=retired
        )
        await wake_drive_work("sharing")
        logger.info(
            "drive_request.existing_access completed files=%d retired_checkout=%s",
            len(result.files),
            retired is not None,
        )
        return completed

    async def retire_checkout(self, *, requester_user_id: str, request_id: str) -> str:
        """After a withdrawal commits, make its open Checkout page unpayable.

        Returns ``"none"`` (no bound session), ``"dead"``, ``"paid"`` or
        ``"unknown"`` and never raises. Stripe I/O runs outside any database
        transaction and is bounded; correctness never depends on it, because a
        late paid event settles as request_closed and is refunded in full.
        """
        try:
            request_id = _request_id(request_id)

            def read(connection):
                return self._row(
                    connection,
                    """SELECT o.status,o.stripe_checkout_session_id,r.status AS request_status
                       FROM drive_request_payment_orders o
                       JOIN drive_share_requests r ON r.request_id=o.request_id
                       WHERE o.request_id=:request AND o.requester_user_id=:requester""",
                    {"request": request_id, "requester": requester_user_id},
                )

            order = await self._transaction(read)
            if order is None or not order["stripe_checkout_session_id"]:
                return "none"
            if order["status"] in {"paid", "refunded"}:
                return "paid"
            if order["request_status"] != "cancelled":
                return "none"
            key, _, _ = _config()
            async with asyncio.timeout(CHECKOUT_RETIRE_TIMEOUT_SECONDS):
                return await asyncio.to_thread(
                    self._retire_session, order["stripe_checkout_session_id"], key
                )
        except Exception as error:  # noqa: BLE001 - never fail the withdrawal
            logger.info("drive_request.checkout_retire_unknown error=%s", type(error).__name__)
            return "unknown"

    def _current_checkout_authority(
        self,
        connection,
        *,
        request_id: str,
        requester_user_id: str,
        require_package_disclosure: bool = False,
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
        participants = sharing._participant_gate(connection, owner, request_id)
        request = sharing._related_request(connection, owner, request_id)
        if (
            request["recipient_user_id"] != requester_user_id
            or request["expires_at"] <= datetime.now(UTC)
            or request["access_stop_requested_at"] is not None
        ):
            raise checkout_refusal("request_closed")
        private = sharing._open_request(request)
        if private.get("document_delivery_version") == 1:
            from hushh_mcp.services.document_delivery.store import DocumentDeliveryStore

            return DocumentDeliveryStore(db=self.db).checkout_authority(
                connection, request_id=request_id, requester=requester_user_id
            )
        sharing._sharing_admission(owner)
        from hushh_mcp.services.drive_packet_purchase_authority import (
            require_checkout_disclosure,
            require_current_packet_purchase,
        )

        require_current_packet_purchase(connection, request=request, private=private)
        if semantic_search_request(private):
            self._require_semantic_search_plan(connection, request=request, sharing=sharing)
        if require_package_disclosure:
            require_checkout_disclosure(request=request, private=private)
        if request["status"] == "pending" and not request_has_document_scope(private):
            raise DriveSharingError("date_range_required")
        if private.get("trusted_auto") is True and (
            # The owner's Allow priced the period, so the requester may pay
            # before the background search has frozen anything. The automatic
            # rechecks below still decide, and delivery still waits for both.
            autoshare_owner_allow_authority(private)
            or not request_requires_owner_review(
                connection,
                user_id=owner,
                request_id=request["request_id"],
                revision=request["revision"],
                cipher=sharing.sharing_cipher,
            )
        ):
            # The owner took the request over (Search again, or the review
            # page's own start after automatic sharing stopped): A now selects
            # its files. A's Allow still prices it, but only A's exact approved
            # batch is payment authority, as for a manual request.
            takeover = request["preparation_error_code"] == "manual_search_active"
            preferences = DriveLivePreferences(db=self.db)
            current = preferences.live_active(connection, user_id=owner)
            if not takeover:
                # Only the automatic pipeline searches with background access.
                preferences.background_current(
                    connection, user_id=owner, generation=current["connection_generation"]
                )
            # One fixed refusal code per gate, in the order they always ran.
            if request["status"] != "pending":
                raise checkout_refusal("request_closed")
            if takeover and not self.owner_approved_progressive_batch(connection, request):
                raise checkout_refusal("manual_takeover")
            if not connector_feature_enabled("google_drive_chat_reads", owner):
                raise checkout_refusal("reads_disabled")
            if not automatic_recipient_current(
                connection,
                owner,
                participants["recipient_user_id"],
                private,
                request_id=request_id,
            ):
                raise checkout_refusal("recipient_not_current")
            if (
                not takeover
                and automatic_start_parked(request["preparation_error_code"])
                and not _search_exists(connection, request)
            ):
                # The automatic start failed for good before any search
                # existed: nothing can be delivered, so no payment is taken.
                # A payment already on its way is reconciled and refunded.
                raise checkout_refusal("search_parked")
        else:
            # A manual request or candidate-only search needs exact owner
            # consent, including one with a historical Trusted/Allow marker.
            # Payment follows the immutable owner-approved batch.
            # Progressive requests intentionally remain pending so later
            # batches can still be reviewed and paid by the same order.
            if not connector_feature_enabled("google_drive_chat_reads", owner):
                raise checkout_refusal("reads_disabled")
            if not (
                request["status"] in {"approved", "partial"}
                or (
                    request["status"] == "pending"
                    and self.owner_approved_progressive_batch(connection, request)
                )
            ):
                raise checkout_refusal("not_owner_approved")
        # Internal only; authority derives from the encrypted request, never
        # the public routing hint or a caller-supplied package flag.
        request["_agent_package_required"] = private.get("agent_package_required") is True
        return request

    def _require_semantic_search_plan(self, connection, *, request: dict, sharing) -> None:
        """An enrolled order cannot charge before its bound interpretation is ready."""
        from hushh_mcp.services.drive_request_semantic_plan import (
            parse_semantic_plan,
            semantic_plan_digest,
        )

        search = self._row(
            connection,
            """SELECT job_id,checkpoint_envelope,status,incomplete_search,connection_generation,
                      expires_at>clock_timestamp() AS live
               FROM drive_owner_search_jobs
               WHERE user_id=:user AND client_request_id=:request""",
            {"user": request["user_id"], "request": str(request["request_id"])},
        )
        if (
            search is None
            or search["status"] not in {"queued", "running", "completed"}
            or search["incomplete_search"]
            or search["live"] is not True
        ):
            raise checkout_refusal("search_parked")
        current = DriveLivePreferences(db=self.db).live_active(
            connection, user_id=request["user_id"]
        )
        if search["connection_generation"] != current["connection_generation"]:
            raise checkout_refusal("connection_changed")
        try:
            checkpoint = sharing.sharing_cipher.open(
                search["checkpoint_envelope"],
                user_id=request["user_id"],
                resource_id=str(search["job_id"]),
                purpose="owner-search-checkpoint",
            )
            plan = parse_semantic_plan(checkpoint.get("semantic_plan"))
            valid = (
                plan.status == "ready"
                and checkpoint.get("semantic_plan_digest") == semantic_plan_digest(plan)
                and checkpoint.get("request_origin_id") == str(request["request_id"])
                and checkpoint.get("request_revision") == request["revision"]
            )
        except (DriveSharingError, KeyError, TypeError, ValueError):
            valid = False
        if not valid:
            raise checkout_refusal("search_parked")

    @drive_operation(job_key="request_id")
    @logs_checkout_refusals
    async def checkout(
        self,
        *,
        requester_user_id: str,
        request_id: str,
        v1_only: bool = False,
        accepted_contract: dict | None = None,
    ) -> dict:
        if type(v1_only) is not bool:
            raise ValueError("invalid checkout mode")
        if v1_only and not await self.v1_checkout_eligible(
            requester_user_id=requester_user_id, request_id=request_id
        ):
            raise checkout_refusal("v1_not_eligible")
        request_id = _request_id(request_id)
        with drive_stage(logger, "checkout_state"):
            state = await self.payment_state(
                requester_user_id=requester_user_id, request_id=request_id
            )
        with drive_stage(logger, "checkout_acceptance"):
            state = await payment_integration.accept_checkout(
                self,
                state,
                requester=requester_user_id,
                request_id=request_id,
                acceptance=accepted_contract,
            )
        if state.get("existingAccess") is True:
            return {"requestId": request_id, "existingAccess": True}
        try:
            key, _, origin = _config()
        except DriveSharingError:
            raise checkout_refusal("payments_unconfigured", "payment_unavailable") from None
        if state["status"] == "paid":
            raise checkout_refusal("already_paid", "payment_already_paid")
        expired_autoshare = state["status"] == "expired" and state.get("_autoshare_owner_user_id")
        if (
            state["status"] == "expired"
            and state.get("paymentLinkExpired") is True
            and not expired_autoshare
        ):
            raise checkout_refusal("link_expired", "payment_checkout_expired")
        if state["status"] not in {"awaiting_payment", "checkout_open"} and not expired_autoshare:
            raise checkout_refusal(
                "refunded"
                if state["status"] == "refunded"
                else "request_closed"
                if state["status"] == "expired"
                else "no_order"
                if state.get("_order_present") is False
                else "not_approved"
                if state["status"] == "preparing"
                else "not_payable"
            )

        # A newly enrolled owner-paid order must have a live US Connect
        # destination before charging the requester. Existing orders without
        # a ledger remain on their original Hushh-merchant terms.
        payout_enrolled = state.get("_payout_enrolled") is True
        verified_account_id = None
        bank_settlement = (
            payout_enrolled
            and state.get("_payout_settlement_method", "stripe_transfer") != "hashcoins"
        )
        if payout_enrolled:
            payment_integration.require_payout(state)
        if bank_settlement:
            with drive_stage(logger, "checkout_payout"):
                verified_account_id = await payment_integration.verify_payout_account(state)

        # Read source versions and recipient access after payout-account I/O,
        # immediately before reserving provider work. Failed access checks must
        # not leave an undispatched attempt allocated. Reserve then rechecks
        # database authority; provider ACL and Stripe cannot be one transaction.
        package_owner = state.get("_package_owner_user_id")
        legacy_owner = state.get("_legacy_auto_owner_user_id")
        manual_owner = state.get("_legacy_manual_owner_user_id")
        autoshare_owner = state.get("_autoshare_owner_user_id")
        # An autoshare request is priced per request, never per file. A file
        # the buyer already has counts as delivered when it is granted, so
        # partial existing access never holds its checkout back.
        flat_request = state.get("_autoshare_request") is True and not package_owner
        selected_checkout_ids = None
        checked_revision = None
        if package_owner or legacy_owner or manual_owner or autoshare_owner:
            from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
            from hushh_mcp.services.drive_package_access_preflight import (
                DrivePackageAccessPreflight,
            )
            from hushh_mcp.services.drive_package_existing_access_store import (
                DrivePackageExistingAccessStore,
            )

            owner = package_owner or legacy_owner or manual_owner or autoshare_owner
            sharing = DriveSharingStore(db=self.db)
            bulk = DriveBulkShareStore(db=self.db)

            async def require_current():
                if manual_owner:
                    await self._transaction(
                        lambda connection: self._current_checkout_authority(
                            connection,
                            request_id=request_id,
                            requester_user_id=requester_user_id,
                            require_package_disclosure=True,
                        )
                    )
                else:
                    await sharing.trusted_request_authority(user_id=owner, request_id=request_id)

            access = None
            stage = "sources_unavailable"
            try:
                async with asyncio.timeout(25):
                    # Legacy automatic reviews are progressive. The first
                    # frozen batch alone is not the purchased file set; wait
                    # for a completed search and every shareable source to be
                    # frozen before inspecting buyer access or opening Stripe.
                    # An autoshare request never waits: its flat order is the
                    # whole price, and later files stream after payment.
                    files = None
                    if package_owner:
                        with drive_stage(logger, "checkout_sources"):
                            files = await bulk.package_sources(user_id=owner, request_id=request_id)
                    elif legacy_owner:
                        with drive_stage(logger, "checkout_sources"):
                            files = await bulk.legacy_checkout_sources(
                                user_id=owner, request_id=request_id
                            )
                    elif manual_owner:
                        with drive_stage(logger, "checkout_sources"):
                            files = await bulk.legacy_manual_checkout_sources(
                                user_id=owner, request_id=request_id
                            )
                    else:
                        with drive_stage(logger, "checkout_sources"):
                            sources = await bulk.autoshare_checkout_sources(
                                user_id=owner, request_id=request_id
                            )
                        checked_revision = sources["revision"]
                        files = sources["files"] if sources["complete"] else None
                        stage = "authority_changed"
                        try:
                            await require_current()
                        except DriveReadError as error:
                            raise checkout_refusal(authority_refusal_reason(error)) from None
                    if not flat_request:
                        stage = "access_check_failed"
                        with drive_stage(logger, "checkout_access"):
                            access = await DrivePackageAccessPreflight(
                                sharing=sharing, bulk=bulk
                            ).inspect(
                                user_id=owner,
                                request_id=request_id,
                                require_current=require_current,
                                files=files,
                            )
            except Exception as error:
                raise checkout_refusal(refusal_reason(error, stage)) from None
            if flat_request and files and len(files) <= 120 and getattr(files, "final", True):
                # The existing rule stays: proof that the buyer already has
                # every file of a final set waives the charge. An unreadable or
                # slow answer is not that proof and never blocks checkout. The
                # owner's approvals so far are final only once they hold every
                # shareable match of a finished search.
                try:
                    with drive_stage(logger, "checkout_access"):
                        async with asyncio.timeout(FLAT_ACCESS_CHECK_SECONDS):
                            access = await DrivePackageAccessPreflight(
                                sharing=sharing, bulk=bulk
                            ).inspect(
                                user_id=owner,
                                request_id=request_id,
                                require_current=require_current,
                                files=files,
                            )
                except Exception:
                    access = None
            if access is not None and access.status == "all_existing":
                if flat_request and not manual_owner:
                    return await self.complete_existing_autoshare(
                        user_id=owner, request_id=request_id, result=access
                    )
                if package_owner:
                    await DrivePackageExistingAccessStore(db=self.db).complete(
                        user_id=owner, request_id=request_id, result=access
                    )
                raise checkout_refusal("all_files_accessible", "request_already_accessible")
            if not flat_request and access is not None:
                if access.status == "mixed":
                    raise checkout_refusal(
                        "existing_access_review", "package_existing_access_requires_review"
                    )
                if access.status != "none":
                    raise checkout_refusal("access_unknown")
            if access is not None:
                checked_revision = getattr(access, "request_revision", None)
            if files:
                selected_checkout_ids = frozenset(file["id"] for file in files)

        if expired_autoshare:
            raise checkout_refusal("link_expired", "payment_checkout_expired")

        def reserve(connection):
            request = self._current_checkout_authority(
                connection,
                request_id=request_id,
                requester_user_id=requester_user_id,
                require_package_disclosure=True,
            )
            if v1_only and not self.v1_approved_progressive_batch(connection, request):
                raise checkout_refusal("v1_not_eligible")
            if checked_revision is not None and request["revision"] != checked_revision:
                raise checkout_refusal("revision_changed")
            if selected_checkout_ids is not None:
                self._guard_legacy_duplicate_purchase(
                    connection,
                    owner_user_id=request["user_id"],
                    requester_user_id=requester_user_id,
                    request_id=request_id,
                    selected_ids=selected_checkout_ids,
                    **({"flat_request": True} if flat_request else {}),
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
            if order is None:
                raise checkout_refusal("no_order")
            if order.get("stripe_mode") != configured_stripe_mode():
                raise checkout_refusal("wrong_mode")
            if order["request_status"] not in {"pending", "approved", "partial"} or order[
                "request_expires_at"
            ] <= datetime.now(UTC):
                raise checkout_refusal("request_closed")
            if request.get("_agent_package_required") is True:
                order["_package_owner_user_id"] = request["user_id"]
            if order["status"] == "paid":
                raise checkout_refusal("already_paid", "payment_already_paid")
            # The first provider-backed payment window is the only one for
            # this request. Never rotate an expired or already-bound session.
            if order["status"] == "expired":
                raise checkout_refusal("link_expired", "payment_checkout_expired")
            if order["status"] not in {"awaiting_payment", "checkout_open"}:
                raise checkout_refusal("not_payable")
            if order.get("settlement_method", "stripe_transfer") != state.get(
                "_payout_settlement_method", "stripe_transfer"
            ):
                raise checkout_refusal("settlement_changed", "payment_unavailable")
            if bank_settlement:
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
                    raise checkout_refusal("payout_destination_changed")
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
                    raise checkout_refusal("payout_destination_changed", "payment_unavailable")
            now = datetime.now(UTC)
            reserved_expiry = order.get("stripe_checkout_expires_at")
            if (
                order["stripe_checkout_session_id"]
                and reserved_expiry is not None
                and reserved_expiry <= now
            ):
                raise checkout_refusal("link_expired", "payment_checkout_expired")
            if order["stripe_checkout_url"] and reserved_expiry is not None:
                if v1_only:
                    # The obligation mirror captures V1 provenance before an
                    # existing Checkout URL can be returned to the worker.
                    connection.execute(
                        text("""UPDATE drive_request_payment_orders
                          SET updated_at=clock_timestamp() WHERE request_id=:request"""),
                        {"request": request_id},
                    )
                return order
            if order["stripe_checkout_session_id"]:
                raise checkout_refusal("session_unbound", "payment_unavailable")
            # The stored order amount is the Checkout price. An amount outside
            # the supported integer-cent price range never reaches the provider.
            if not valid_owner_price_cents(order["amount_cents"]) or order["currency"] != "usd":
                raise checkout_refusal("invalid_price", "payment_unavailable")
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

        with drive_stage(logger, "checkout_reserve"):
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
            with drive_stage(logger, "checkout_stripe"):
                session = _stripe_dict(await asyncio.to_thread(create))
        except Exception:
            raise checkout_refusal("provider_unavailable", "payment_unavailable") from None
        session_metadata = session.get("metadata")
        if not isinstance(session_metadata, dict):
            raise checkout_refusal("provider_response_invalid", "payment_unavailable")
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
            raise checkout_refusal("provider_response_invalid", "payment_unavailable")

        def bind(connection):
            request = self._current_checkout_authority(
                connection,
                request_id=request_id,
                requester_user_id=requester_user_id,
                require_package_disclosure=True,
            )
            if v1_only and not self.v1_approved_progressive_batch(connection, request):
                raise checkout_refusal("v1_not_eligible")
            current = self._row(
                connection,
                """SELECT * FROM drive_request_payment_orders
                   WHERE request_id=:request AND requester_user_id=:requester FOR UPDATE""",
                {"request": request_id, "requester": requester_user_id},
            )
            if current is None or current["status"] in {"paid", "refunded", "expired"}:
                raise checkout_refusal("order_changed")
            if str(current["checkout_attempt_id"]) != str(order["checkout_attempt_id"]):
                raise checkout_refusal("order_changed")
            if current["stripe_checkout_session_id"] not in {None, session["id"]}:
                raise checkout_refusal("session_changed", "payment_unavailable")
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

        with drive_stage(logger, "checkout_bind"):
            checkout_url, notified = await self._transaction(bind)
        if checkout_url is None:
            raise checkout_refusal("link_expired", "payment_checkout_expired")
        if notified:
            with drive_stage(logger, "checkout_wake"):
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
            retired_nocharge = False
            if request is not None and order is not None and not request["payment_required"]:
                private = DriveSharingStore(db=self.db)._open_request(request)
                delivery = private.get("existing_access_delivery") or {}
                retired = delivery.get("retired_checkout") or {}
                retired_nocharge = (
                    request["status"] == "completed"
                    and delivery.get("basis") == "ordinary_existing_access_v1"
                    and retired.get("session_id") == session["id"]
                    and retired.get("attempt_id") == metadata.get("checkout_attempt_id")
                    and retired.get("stripe_mode") == configured_stripe_mode()
                )
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
                or (
                    request is not None
                    and (
                        order is None or (not request["payment_required"] and not retired_nocharge)
                    )
                )
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
                    # A payment that must be reconciled (e.g. it arrived after
                    # the request closed) is refunded, not confirmed; its
                    # refund event is the requester's news.
                    if reconciliation_reason is None:
                        self._event(connection, request, "document_share_payment_confirmed")
            connection.execute(
                text("""INSERT INTO drive_request_payment_webhook_events
                   (stripe_event_id,stripe_checkout_session_id,request_id)
                   VALUES (:event,:session,:request)
                   ON CONFLICT (stripe_event_id) DO NOTHING"""),
                {"event": event["id"], "session": session["id"], "request": request_id},
            )
            if obligation.get("v1_statement_search") is True:
                return "v1"
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

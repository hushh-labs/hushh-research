"""Owner payouts: hussh pays packet owners their earnings through Stripe Connect.

hussh is the broker. Buyers pay hussh; once a packet is delivered the owner's
earning (amount_cents - platform_fee_cents) becomes 'due', and when the owner's
Stripe Express account can receive payouts hussh transfers it (idempotent per
order). Card orders transfer against the buyer's own charge so the funds are
always there; credit orders are paid from hussh's balance. Migration 268.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import UTC, datetime
from typing import Any, Literal
from urllib.parse import urlsplit

from db.db_client import get_db
from hushh_mcp.runtime_settings import get_app_runtime_settings
from hushh_mcp.services.pkm_packet_order_service import (
    TABLE as ORDERS,
)
from hushh_mcp.services.pkm_packet_order_service import (
    PacketOrderError,
    _stripe_config,
    _stripe_dict,
)
from hushh_mcp.services.stripe_mode import (
    configured_stripe_mode,
    stripe_environment,
    uat_live_document_only,
)

logger = logging.getLogger(__name__)

ACCOUNTS = "stripe_owner_payout_accounts"
LEGACY_ACCOUNTS = "pkm_owner_payout_accounts"
ONBOARDING_RETURN_PATHS = {
    "marketplace": "/one/marketplace",
    "documents": "/one/profile/payouts",
}


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _earning(order: dict[str, Any]) -> int:
    return max(0, int(order.get("amount_cents") or 0) - int(order.get("platform_fee_cents") or 0))


def _app_origin() -> str:
    origin = get_app_runtime_settings().app_frontend_origin.rstrip("/")
    parsed = urlsplit(origin)
    local = parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}
    if (
        not parsed.hostname
        or (parsed.scheme != "https" and not local)
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise PacketOrderError("PAYMENT_UNAVAILABLE", "Payouts are not available right now.")
    return origin


def _bank_projection(remote: dict[str, Any]) -> dict[str, Any]:
    """Expose only the default USD bank's display details, never banking credentials."""
    external = remote.get("external_accounts")
    if not isinstance(external, dict) or not isinstance(external.get("data"), list):
        return {"bankStatus": "unavailable", "bank": None}
    bank = next(
        (
            item
            for item in external["data"]
            if isinstance(item, dict)
            and item.get("object") == "bank_account"
            and item.get("currency") == "usd"
            and item.get("country") == "US"
            and item.get("default_for_currency") is True
            and not item.get("deleted")
        ),
        None,
    )
    if bank is None:
        # Account retrieval includes only a bounded external-account preview.
        # An omitted default in a paginated preview is not proof it was removed.
        return {
            "bankStatus": "unavailable" if external.get("has_more") else "missing",
            "bank": None,
        }
    raw_status = bank.get("status")
    status = (
        raw_status
        if raw_status in {"new", "validated", "verified", "verification_failed", "errored"}
        else "unknown"
    )
    name = bank.get("bank_name")
    last4 = bank.get("last4")
    return {
        "bankStatus": "linked" if status in {"new", "validated", "verified"} else "needs_attention",
        "bank": {
            "name": name.strip()[:80] if isinstance(name, str) and name.strip() else None,
            "last4": last4 if isinstance(last4, str) and re.fullmatch(r"[0-9]{4}", last4) else None,
            "status": status,
        },
    }


def _account_readiness(remote: dict[str, Any]) -> dict[str, Any]:
    """A live Stripe Account is the authority for transfer and payout readiness."""
    capabilities = remote.get("capabilities") or {}
    requirements = remote.get("requirements") or {}
    disabled = bool(
        remote.get("deleted")
        or requirements.get("disabled_reason")
        or remote.get("country") != "US"
    )
    submitted = bool(remote.get("details_submitted"))
    transfers = capabilities.get("transfers") == "active"
    payouts = bool(remote.get("payouts_enabled"))
    bank = _bank_projection(remote)
    ready = submitted and transfers and payouts and not disabled and bank["bankStatus"] == "linked"
    dashboard = (remote.get("controller") or {}).get("stripe_dashboard") or {}
    can_manage = (
        not remote.get("deleted")
        and remote.get("country") == "US"
        and remote.get("type", "express") == "express"
        and dashboard.get("type", "express") == "express"
    )
    return {
        "detailsSubmitted": submitted,
        "transfersEnabled": transfers,
        "payoutsEnabled": payouts,
        "ready": ready,
        "status": "ready" if ready else "restricted" if disabled else "onboarding_required",
        "canManageBank": can_manage,
        **bank,
    }


def _legacy_account_absent(exc: Exception, *, account_id: str, mode: str) -> bool:
    """Only an explicit provider absence/mode verdict permits fresh onboarding."""
    if getattr(exc, "code", None) == "resource_missing":
        return True
    # Stripe currently returns APIError/400 without a code for test Connect
    # accounts read using live credentials. Match the provider's exact verdict
    # about this account; generic 400/auth/network failures remain unavailable.
    import stripe

    body = getattr(exc, "json_body", None)
    error = body.get("error") if isinstance(body, dict) else None
    return bool(
        mode == "live"
        and isinstance(exc, stripe.APIError)
        and getattr(exc, "http_status", None) == 400
        and isinstance(error, dict)
        and error.get("type") == "api_error"
        and error.get("message")
        == (
            f"The account {account_id} was a test account created with a testmode key, "
            "and therefore can only be used with testmode keys."
        )
    )


async def resume_document_owner_setup(db: Any, user_id: str) -> None:
    """A committed readiness change wakes durable requests; the worker also retries."""
    try:
        from hushh_mcp.services.drive_sharing_store import DriveSharingStore
        from hushh_mcp.services.drive_work_wake import wake_drive_work

        await DriveSharingStore(db=db).resume_owner_setup(user_id=user_id)
        await wake_drive_work("suggestions")
        await wake_drive_work("sharing")
    except Exception as exc:
        logger.warning("document_payout.resume_deferred type=%s", type(exc).__name__)


class PkmPayoutService:
    def __init__(self, *, stripe_api: Any = None) -> None:
        import stripe

        self._db = None
        self.stripe_api = stripe_api or stripe

    @property
    def db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    async def _rows(self, query) -> list[dict[str, Any]]:
        result = await asyncio.to_thread(query.execute)
        return getattr(result, "data", None) or []

    async def _account(self, user_id: str) -> dict[str, Any] | None:
        mode = configured_stripe_mode()
        rows = await self._rows(
            self.db.table(ACCOUNTS)
            .select("*")
            .eq("user_id", user_id)
            .eq("stripe_mode", mode)
            .limit(1)
        )
        if rows:
            return rows[0]
        # Preserve the old mapping until the provider proves which mode owns it.
        # Stripe Account objects have no livemode field; authenticated retrieval
        # is authoritative. A network/auth failure must not create a replacement.
        legacy = await self._rows(
            self.db.table(LEGACY_ACCOUNTS).select("*").eq("user_id", user_id).limit(1)
        )
        if not legacy:
            return None
        key, _, _ = _stripe_config()
        try:
            remote = _stripe_dict(
                await asyncio.to_thread(
                    self.stripe_api.Account.retrieve, legacy[0]["stripe_account_id"], api_key=key
                )
            )
        except Exception as exc:
            if _legacy_account_absent(exc, account_id=legacy[0]["stripe_account_id"], mode=mode):
                return None
            raise PacketOrderError(
                "PAYOUT_UNAVAILABLE", "Could not verify payout setup. Please retry."
            ) from None
        if remote.get("id") != legacy[0]["stripe_account_id"]:
            raise PacketOrderError(
                "PAYOUT_UNAVAILABLE", "Could not verify payout setup. Please retry."
            )
        readiness = _account_readiness(remote)
        adopted = {
            "user_id": user_id,
            "stripe_mode": mode,
            "stripe_account_id": legacy[0]["stripe_account_id"],
            "details_submitted": readiness["detailsSubmitted"],
            "payouts_enabled": readiness["payoutsEnabled"],
            "account_ready": readiness["ready"],
        }
        try:
            await self._rows(self.db.table(ACCOUNTS).insert(adopted))
        except Exception:
            rows = await self._rows(
                self.db.table(ACCOUNTS)
                .select("*")
                .eq("user_id", user_id)
                .eq("stripe_mode", mode)
                .limit(1)
            )
            if not rows:
                raise PacketOrderError(
                    "PAYOUT_UNAVAILABLE", "Could not verify payout setup. Please retry."
                ) from None
            return rows[0]
        return adopted

    # --- owner -------------------------------------------------------------

    async def onboarding_link(
        self, *, user_id: str, surface: Literal["marketplace", "documents"] = "marketplace"
    ) -> dict[str, Any]:
        """Create (once) the owner's Express account and a fresh onboarding link."""
        key, _, _ = _stripe_config()
        origin = _app_origin()
        return_path = ONBOARDING_RETURN_PATHS[surface]
        account = await self._account(user_id)
        if account is None:
            try:
                created = _stripe_dict(
                    await asyncio.to_thread(
                        self.stripe_api.Account.create,
                        api_key=key,
                        idempotency_key=f"pkm-payout-account:{stripe_environment()}:{configured_stripe_mode()}:{user_id}",
                        type="express",
                        country="US",
                        capabilities={"transfers": {"requested": True}},
                        metadata={
                            "hussh_user_ref": "pkm_owner",
                            "hussh_environment": stripe_environment(),
                        },
                    )
                )
            except Exception as exc:
                logger.warning("pkm_payout.account_create_failed type=%s", type(exc).__name__)
                raise PacketOrderError(
                    "PAYOUT_UNAVAILABLE", "Could not start payout setup. Please retry."
                ) from None
            account_id = created.get("id")
            if not account_id:
                raise PacketOrderError(
                    "PAYOUT_UNAVAILABLE", "Could not start payout setup. Please retry."
                )
            try:
                await self._rows(
                    self.db.table(ACCOUNTS).insert(
                        {
                            "user_id": user_id,
                            "stripe_account_id": account_id,
                            "stripe_mode": configured_stripe_mode(),
                        }
                    )
                )
            except Exception:
                # A concurrent request may have inserted the same owner's mapping.
                # Stripe's owner-scoped idempotency key also keeps creation single.
                account = await self._account(user_id)
                if account is None:
                    raise PacketOrderError(
                        "PAYOUT_UNAVAILABLE", "Could not start payout setup. Please retry."
                    ) from None
                account_id = account["stripe_account_id"]
        else:
            account_id = account["stripe_account_id"]
        # An existing mapping must never be replaced with another Connect account.
        # Stripe may have disabled or deleted the account since the last visit.
        remote = await self._retrieve_account(account_id, key=key)
        if remote.get("deleted") or (remote.get("country") and remote["country"] != "US"):
            raise PacketOrderError(
                "PAYOUT_ACCOUNT_DISABLED",
                "This payout account needs support before setup can continue.",
            )
        query_key = "documentPayouts" if surface == "documents" else "payouts"
        try:
            link = _stripe_dict(
                await asyncio.to_thread(
                    self.stripe_api.AccountLink.create,
                    api_key=key,
                    account=account_id,
                    type="account_onboarding",
                    refresh_url=f"{origin}{return_path}?{query_key}=refresh",
                    return_url=f"{origin}{return_path}?{query_key}=done",
                )
            )
        except Exception as exc:
            logger.warning("pkm_payout.account_link_failed type=%s", type(exc).__name__)
            raise PacketOrderError(
                "PAYOUT_UNAVAILABLE", "Could not start payout setup. Please retry."
            ) from None
        if not link.get("url"):
            raise PacketOrderError(
                "PAYOUT_UNAVAILABLE", "Could not start payout setup. Please retry."
            )
        return {"url": link["url"]}

    async def _retrieve_account(self, account_id: str, *, key: str) -> dict[str, Any]:
        try:
            remote = _stripe_dict(
                await asyncio.to_thread(self.stripe_api.Account.retrieve, account_id, api_key=key)
            )
        except Exception as exc:
            logger.warning("pkm_payout.account_retrieve_failed type=%s", type(exc).__name__)
            raise PacketOrderError(
                "PAYOUT_UNAVAILABLE", "Could not verify payout setup. Please retry."
            ) from None
        if remote.get("id") != account_id:
            raise PacketOrderError(
                "PAYOUT_UNAVAILABLE", "Could not verify payout setup. Please retry."
            )
        return remote

    async def refresh_account(self, user_id: str) -> dict[str, Any] | None:
        account = await self._account(user_id)
        if account is None:
            return None
        key, _, _ = _stripe_config()
        remote = await self._retrieve_account(account["stripe_account_id"], key=key)
        readiness = _account_readiness(remote)
        patch = {
            "details_submitted": readiness["detailsSubmitted"],
            "payouts_enabled": readiness["payoutsEnabled"],
            "account_ready": readiness["ready"],
            "updated_at": _now(),
        }
        await self._rows(
            self.db.table(ACCOUNTS)
            .update(patch)
            .eq("user_id", user_id)
            .eq("stripe_mode", configured_stripe_mode())
        )
        if account.get("account_ready") is not readiness["ready"]:
            await resume_document_owner_setup(self.db, user_id)
        return {**account, **patch, "readiness": readiness}

    async def management_link(self, *, user_id: str) -> dict[str, str]:
        """Only the authenticated owner can open their mapped Express dashboard."""
        account = await self.refresh_account(user_id)
        if account is None:
            raise PacketOrderError("PAYOUT_ACCOUNT_REQUIRED", "Link a bank first.")
        if not account["readiness"]["canManageBank"]:
            raise PacketOrderError("PAYOUT_ACCOUNT_DISABLED", "This payout account needs support.")
        key, _, _ = _stripe_config()
        try:
            link = _stripe_dict(
                await asyncio.to_thread(
                    self.stripe_api.Account.create_login_link,
                    account["stripe_account_id"],
                    api_key=key,
                )
            )
            parsed = urlsplit(link.get("url") or "")
            if (
                parsed.scheme != "https"
                or parsed.hostname != "connect.stripe.com"
                or parsed.username
                or parsed.password
                or parsed.port
            ):
                raise ValueError("unexpected payout dashboard")
        except Exception as exc:
            logger.warning("pkm_payout.dashboard_failed type=%s", type(exc).__name__)
            raise PacketOrderError(
                "PAYOUT_UNAVAILABLE", "Couldn't open bank settings. Try again."
            ) from None
        return {"url": link["url"]}

    async def account_status(self, *, user_id: str) -> dict[str, Any]:
        """Document checkout consumes this without exposing PKM sales or account IDs."""
        account = await self.refresh_account(user_id)
        return {
            "account": account["readiness"] if account is not None else None,
            "stripeMode": configured_stripe_mode(),
        }

    async def _earning_orders(
        self, *, state: str | None = None, owner: str | None = None, limit: int | None = None
    ) -> list[dict[str, Any]]:
        """Keep pre-cutover production credit earnings on their existing terms.

        Legacy card orders still require provider-mode proof. UAT never treats
        its historic credits as live money.
        """
        mode = configured_stripe_mode()
        modes = [mode]
        if mode == "live" and stripe_environment() == "production":
            modes.append("legacy")
        rows = []
        for candidate_mode in modes:
            query = (
                self.db.table(ORDERS)
                .select("*")
                .eq("status", "paid")
                .eq("stripe_mode", candidate_mode)
            )
            if owner is not None:
                query = query.eq("owner_user_id", owner)
            if state is not None:
                query = query.eq("owner_earning_status", state)
            if candidate_mode == "legacy":
                query = query.eq("payment_method", "credits")
            if limit is not None:
                query = query.limit(limit)
            rows.extend(await self._rows(query))
        return rows[:limit] if limit is not None else rows

    async def summary(self, *, user_id: str) -> dict[str, Any]:
        account = await self.refresh_account(user_id)
        orders = await self._earning_orders(owner=user_id)
        totals = {"awaitingDelivery": 0, "due": 0, "paidOut": 0}
        for order in orders:
            state = order.get("owner_earning_status") or "none"
            bucket = {"none": "awaitingDelivery", "due": "due", "transferred": "paidOut"}.get(state)
            if bucket:
                totals[bucket] += _earning(order)
        return {
            "account": None
            if account is None
            else {
                "detailsSubmitted": bool(account.get("details_submitted")),
                "payoutsEnabled": bool(account.get("payouts_enabled")),
            },
            "earningsCents": totals,
            "currency": "USD",
        }

    # --- scheduled ---------------------------------------------------------

    async def mark_delivered_earnings_due(self, *, max_orders: int = 50) -> int:
        """Paid orders whose packet has been delivered become 'due' to the owner."""
        paid = await self._earning_orders(state="none", limit=max_orders)
        request_ids = [str(o["access_request_id"]) for o in paid if o.get("access_request_id")]
        if not request_ids:
            return 0
        delivered = {
            str(r["id"])
            for r in await self._rows(
                self.db.table("marketplace_access_requests")
                .select("id,latest_envelope_id")
                .in_("id", request_ids)
            )
            if r.get("latest_envelope_id")
        }
        marked = 0
        for order in paid:
            if str(order.get("access_request_id")) in delivered:
                marked += bool(
                    await self._rows(
                        self.db.table(ORDERS)
                        .update({"owner_earning_status": "due", "updated_at": _now()})
                        .eq("id", str(order["id"]))
                        .eq("owner_earning_status", "none")
                    )
                )
        return marked

    async def transfer_due(self, *, max_orders: int = 20) -> int:
        due = await self._earning_orders(state="due", limit=max_orders)
        if not due:
            return 0
        key, _, _ = _stripe_config()
        accounts = {}
        for owner in sorted({str(order["owner_user_id"]) for order in due}):
            try:
                # Includes verified adoption of an old mapping without requiring
                # the person to visit Profile before an existing earning settles.
                account = await self.refresh_account(owner)
                if account and account["readiness"]["ready"]:
                    accounts[owner] = account
            except PacketOrderError:
                continue  # Retain the earning; no replacement on provider failure.
        sent = 0
        for order in due:
            # Credit balances predate mode isolation; they cannot back live cash.
            if uat_live_document_only() and order.get("payment_method") == "credits":
                continue
            account = accounts.get(str(order["owner_user_id"]))
            if not account or not account.get("payouts_enabled"):
                continue  # stays due until the owner finishes onboarding
            amount = _earning(order)
            order_id = str(order["id"])
            if amount <= 0:
                await self._rows(
                    self.db.table(ORDERS)
                    .update({"owner_earning_status": "void", "updated_at": _now()})
                    .eq("id", order_id)
                )
                continue
            params: dict[str, Any] = {
                "api_key": key,
                "idempotency_key": f"pkm-packet-transfer:{order_id}",
                "amount": amount,
                "currency": "usd",
                "destination": account["stripe_account_id"],
                "transfer_group": f"pkm-order-{order_id}",
                "metadata": {"payment_kind": "pkm_packet_payout", "order_id": order_id},
            }
            try:
                if order.get("payment_method") != "credits" and order.get(
                    "stripe_payment_intent_id"
                ):
                    intent = _stripe_dict(
                        await asyncio.to_thread(
                            self.stripe_api.PaymentIntent.retrieve,
                            order["stripe_payment_intent_id"],
                            api_key=key,
                        )
                    )
                    if intent.get("latest_charge"):
                        params["source_transaction"] = intent["latest_charge"]
                transfer = _stripe_dict(
                    await asyncio.to_thread(self.stripe_api.Transfer.create, **params)
                )
            except Exception:
                logger.exception("pkm_payout.transfer_failed order=%s", order_id)
                continue  # stays due; retried next run
            sent += bool(
                await self._rows(
                    self.db.table(ORDERS)
                    .update(
                        {
                            "owner_earning_status": "transferred",
                            "stripe_transfer_id": transfer.get("id"),
                            "transferred_at": _now(),
                            "updated_at": _now(),
                        }
                    )
                    .eq("id", order_id)
                    .eq("owner_earning_status", "due")
                )
            )
        return sent

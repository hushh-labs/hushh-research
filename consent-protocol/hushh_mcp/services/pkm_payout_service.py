"""Owner payouts: hussh pays packet owners their earnings through Stripe Connect.

hussh is the broker. Buyers pay hussh; once a packet is delivered the owner's
earning (amount_cents - platform_fee_cents) becomes 'due', and when the owner's
Stripe Express account can receive payouts hussh transfers it (idempotent per
order). Card orders transfer against the buyer's own charge so the funds are
always there; credit orders are paid from hussh's balance. Migration 268.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from datetime import UTC, datetime
from typing import Any, Literal
from urllib.parse import urlsplit
from uuid import UUID

from db.db_client import get_db
from hushh_mcp.runtime_settings import get_app_runtime_settings
from hushh_mcp.services.connect_payout_binding import resolve_document_binding
from hushh_mcp.services.payout_account_status_cache import (
    StatusReadInvalidated,
    account_status_cache,
    invalidate_payout_account_status,
)
from hushh_mcp.services.pkm_consumer_payout_profile import (
    create_consumer_account,
    create_hosted_link,
    hosted_return_urls,
)
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
    "answers": "/one/profile/payouts",
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


VERIFICATION_ITEMS = ("identity", "tax_id", "address", "bank_account", "business", "terms", "other")
# Stripe requirements.disabled_reason -> closed reason. Reasons a verify link
# can fix map to a verification state instead of "disabled".
_DISABLED_REASONS = {
    "requirements.past_due": "requirements_past_due",
    "requirements.pending_verification": "pending_verification",
    "under_review": "under_review",
    "listed": "listed",
    "platform_paused": "platform_paused",
    "action_required.requested_capabilities": "action_required",
}
_TAX_ID_FIELDS = {"id_number", "id_number_secondary", "ssn_last_4", "tax_id", "vat_id"}
_IDENTITY_OWNERS = {"individual", "representative"}
_BUSINESS_OWNERS = {"business_profile", "business_type", "company", "settings"}


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _requirement_fields(requirements: dict[str, Any], key: str) -> list[str]:
    value = requirements.get(key)
    if not isinstance(value, list):
        return []
    return [field for field in value[:200] if isinstance(field, str)]


def _requirement_item(field: str) -> str:
    """A closed category for one Stripe requirement name, never the name itself."""
    parts = field.split(".")
    if parts[0] == "external_account":
        return "bank_account"
    if parts[0] == "tos_acceptance":
        return "terms"
    if any(part == "address" or part.endswith("_address") for part in parts):
        return "address"
    if any(part in _TAX_ID_FIELDS for part in parts):
        return "tax_id"
    if parts[0] in _IDENTITY_OWNERS or parts[0].startswith("person_"):
        return "identity"
    if parts[0] in _BUSINESS_OWNERS:
        return "business"
    return "other"


def _timestamp(value: Any) -> str | None:
    # Unix seconds between 2000 and 2100; anything else is not a deadline.
    if type(value) is not int or not 946_684_800 <= value <= 4_102_444_800:
        return None
    return datetime.fromtimestamp(value, UTC).isoformat()


def _account_verification(remote: dict[str, Any]) -> dict[str, Any]:
    """What Stripe still needs, as closed categories. Never provider text.

    `requirements.errors[].reason` and requirement names stay server-side; the
    owner sees a state, a deadline and categories.
    """
    requirements = _mapping(remote.get("requirements"))
    future = _mapping(remote.get("future_requirements"))
    past_due = _requirement_fields(requirements, "past_due")
    currently_due = _requirement_fields(requirements, "currently_due")
    future_due = _requirement_fields(future, "currently_due") + _requirement_fields(
        future, "past_due"
    )
    raw_reason = requirements.get("disabled_reason")
    disabled_reason = (
        None
        if not isinstance(raw_reason, str) or not raw_reason
        else "rejected"
        if raw_reason.startswith("rejected.")
        else _DISABLED_REASONS.get(raw_reason, "other")
    )
    if disabled_reason in {"rejected", "listed", "platform_paused", "action_required", "other"}:
        state = "disabled"
    elif past_due or disabled_reason == "requirements_past_due":
        state = "past_due"
    elif currently_due:
        state = "due"
    elif _requirement_fields(requirements, "pending_verification") or disabled_reason in {
        "pending_verification",
        "under_review",
    }:
        state = "in_review"
    elif future_due:
        state = "upcoming"
    else:
        state = "none"
    due_now = set(past_due + currently_due + future_due)
    eventually = set(
        _requirement_fields(requirements, "eventually_due")
        + _requirement_fields(future, "eventually_due")
    )
    categories = {_requirement_item(field) for field in due_now}
    # A deadline belongs to the items it is for, never to an empty list.
    deadline_source = requirements if past_due or currently_due else future if future_due else {}
    return {
        "state": state,
        "deadline": _timestamp(deadline_source.get("current_deadline")),
        "items": [item for item in VERIFICATION_ITEMS if item in categories],
        "eventuallyDue": bool(eventually - due_now),
        "hasErrors": bool(requirements.get("errors") or future.get("errors")),
        "disabledReason": disabled_reason,
    }


def _payout_schedule(remote: dict[str, Any]) -> dict[str, Any] | None:
    schedule = _mapping(_mapping(_mapping(remote.get("settings")).get("payouts")).get("schedule"))
    interval = schedule.get("interval")
    if interval not in {"daily", "weekly", "monthly", "manual"}:
        return None
    delay = schedule.get("delay_days")
    return {
        "interval": interval,
        "delayDays": delay if type(delay) is int and 0 <= delay <= 365 else None,
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
        # Additive: projected from the same Account read, no extra Stripe call.
        "verification": _account_verification(remote),
        "payoutSchedule": _payout_schedule(remote),
    }


def _legacy_account_absent(exc: Exception, *, account_id: str, mode: str) -> bool:
    """Only an explicit provider absence/mode verdict permits fresh onboarding."""
    if getattr(exc, "code", None) == "resource_missing":
        return True
    # Stripe sends api_error/400 without a code for test accounts read with live
    # credentials. Its SDK decodes HTTP 400 as InvalidRequestError, independent
    # of the JSON error type. Match the exact account-specific verdict; generic
    # 400/auth/network failures must never authorize a replacement account.
    import stripe

    body = getattr(exc, "json_body", None)
    error = body.get("error") if isinstance(body, dict) else None
    return bool(
        mode == "live"
        and isinstance(exc, (stripe.InvalidRequestError, stripe.APIError))
        and getattr(exc, "http_status", None) == 400
        and isinstance(error, dict)
        and error.get("type") == "api_error"
        and error.get("message")
        == (
            f"The account {account_id} was a test account created with a testmode key, "
            "and therefore can only be used with testmode keys."
        )
    )


def _platform_setup_required(exc: Exception) -> bool:
    import stripe

    body = getattr(exc, "json_body", None)
    error = body.get("error") if isinstance(body, dict) else None
    return bool(
        isinstance(exc, stripe.InvalidRequestError)
        and getattr(exc, "http_status", None) == 400
        and isinstance(error, dict)
        and error.get("type") == "invalid_request_error"
        and isinstance(error.get("message"), str)
        and error["message"].startswith(
            "You must complete your platform profile to use Connect and create live connected "
            "accounts."
        )
    )


def _log_provider_error(operation: str, exc: Exception) -> None:
    """Retain diagnosable provider references without logging financial details."""
    code = getattr(exc, "code", None)
    request_id = getattr(exc, "request_id", None)
    logger.warning(
        "pkm_payout.%s_failed type=%s code=%s request_id=%s",
        operation,
        type(exc).__name__,
        code if isinstance(code, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,79}", code) else "none",
        request_id
        if isinstance(request_id, str) and re.fullmatch(r"req_[A-Za-z0-9_]{1,100}", request_id)
        else "none",
    )


async def resume_document_owner_setup(db: Any, user_id: str) -> None:
    """A committed readiness change wakes durable requests; the worker also retries."""
    try:
        from hushh_mcp.services.drive_sharing_store import DriveSharingStore
        from hushh_mcp.services.drive_work_wake import wake_drive_work_stages

        await DriveSharingStore(db=db).resume_owner_setup(user_id=user_id)
        await wake_drive_work_stages("suggestions", "sharing")
    except Exception as exc:
        logger.warning("document_payout.resume_deferred type=%s", type(exc).__name__)


class PkmPayoutService:
    def __init__(
        self,
        *,
        stripe_api: Any = None,
        mode: str | None = None,
        api_key: str | None = None,
        resume_documents: bool = True,
    ) -> None:
        import stripe

        self._resume_documents = resume_documents
        self._db = None
        self.stripe_api = stripe_api or stripe
        self._explicit_account_mode = mode
        if self.account_mode not in {"test", "live"}:
            raise ValueError("invalid payout account mode")
        if api_key is not None and (
            not api_key.startswith(f"sk_{self.account_mode}_") or len(api_key) < 24
        ):
            raise ValueError("payout account key mode mismatch")
        self._account_api_key = api_key

    @property
    def account_mode(self) -> str:
        return self._explicit_account_mode or configured_stripe_mode()

    def _account_key(self) -> str:
        if self._account_api_key is not None:
            return self._account_api_key
        if self.account_mode != configured_stripe_mode():
            raise PacketOrderError("PAYOUT_UNAVAILABLE", "Bank setup is unavailable.")
        return _stripe_config()[0]

    @property
    def db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    async def _rows(self, query) -> list[dict[str, Any]]:
        result = await asyncio.to_thread(query.execute)
        return getattr(result, "data", None) or []

    async def _account(self, user_id: str) -> dict[str, Any] | None:
        mode = self.account_mode
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
        key = self._account_key()
        try:
            remote = _stripe_dict(
                await asyncio.to_thread(
                    self.stripe_api.Account.retrieve, legacy[0]["stripe_account_id"], api_key=key
                )
            )
        except Exception as exc:
            if _legacy_account_absent(exc, account_id=legacy[0]["stripe_account_id"], mode=mode):
                return None
            _log_provider_error("legacy_account_retrieve", exc)
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
        self,
        *,
        user_id: str,
        surface: Literal["marketplace", "documents", "answers"] = "marketplace",
        purpose: Literal["onboarding", "verify"] = "onboarding",
        attempt_id: str | None = None,
    ) -> dict[str, Any]:
        """Create (once) the owner's Express account and a fresh onboarding link.

        purpose="verify" reuses an existing account only and asks Stripe to
        collect everything it will need, now and upcoming, in one visit. Either
        purpose fences the display cache, so verification shows Stripe's state.
        """
        if purpose not in {"onboarding", "verify"}:
            raise ValueError("invalid onboarding purpose")
        if attempt_id is not None:
            if surface not in {"documents", "answers"}:
                raise ValueError("invalid correlated payout surface")
            attempt_id = str(UUID(attempt_id))
        invalidate_payout_account_status(user_id=user_id, mode=self.account_mode)
        key = self._account_key()
        origin = _app_origin()
        return_path = ONBOARDING_RETURN_PATHS[surface]
        account = await resolve_document_binding(self, user_id)
        remote: dict[str, Any] | None = None
        if account is None and purpose == "verify":
            raise PacketOrderError("PAYOUT_ACCOUNT_REQUIRED", "Link a bank first.")
        if account is None:
            try:
                created = await create_consumer_account(
                    stripe_api=self.stripe_api,
                    api_key=key,
                    mode=self.account_mode,
                    owner=user_id,
                    database=self.db,
                )
            except Exception as exc:
                _log_provider_error("account_create", exc)
                if _platform_setup_required(exc):
                    raise PacketOrderError(
                        "PAYOUT_PLATFORM_SETUP_REQUIRED",
                        "Bank setup is unavailable. Hushh needs to activate payouts.",
                    ) from None
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
                            "stripe_mode": self.account_mode,
                        }
                    )
                )
            except Exception:
                # Recheck a concurrent winner without changing the creation intent.
                account = await resolve_document_binding(self, user_id)
                if account is None:
                    raise PacketOrderError(
                        "PAYOUT_UNAVAILABLE", "Could not start payout setup. Please retry."
                    ) from None
                account_id = account["stripe_account_id"]
            else:
                # The preparation adapter returns freshly verified current account facts.
                remote = created
        else:
            account_id = account["stripe_account_id"]
        # An existing mapping must never be replaced with another Connect account.
        # Stripe may have disabled or deleted the account since the last visit.
        if remote is None:
            remote = await self._retrieve_account(account_id, key=key)
        if remote.get("deleted") or (remote.get("country") and remote["country"] != "US"):
            raise PacketOrderError(
                "PAYOUT_ACCOUNT_DISABLED",
                "This payout account needs support before setup can continue.",
            )
        urls = hosted_return_urls(origin, return_path, surface, attempt_id)
        return_url, refresh_url = urls["return_url"], urls["refresh_url"]
        try:
            link = await create_hosted_link(
                stripe_api=self.stripe_api,
                api_key=key,
                account=account_id,
                refresh_url=refresh_url,
                return_url=return_url,
                mode=self.account_mode,
                owner=user_id,
                purpose=purpose,
                attempt_id=attempt_id,
            )
        except PacketOrderError:
            raise
        except Exception as exc:
            _log_provider_error("account_link", exc)
            raise PacketOrderError(
                "PAYOUT_UNAVAILABLE", "Could not start payout setup. Please retry."
            ) from None
        if not link.get("url"):
            raise PacketOrderError(
                "PAYOUT_UNAVAILABLE", "Could not start payout setup. Please retry."
            )
        invalidate_payout_account_status(user_id=user_id, mode=self.account_mode)
        return {
            "url": link["url"],
            **({"return_url": return_url, "attempt_id": attempt_id} if attempt_id else {}),
        }

    async def _retrieve_account(self, account_id: str, *, key: str) -> dict[str, Any]:
        try:
            remote = _stripe_dict(
                await asyncio.to_thread(self.stripe_api.Account.retrieve, account_id, api_key=key)
            )
        except Exception as exc:
            _log_provider_error("account_retrieve", exc)
            raise PacketOrderError(
                "PAYOUT_UNAVAILABLE", "Could not verify payout setup. Please retry."
            ) from None
        if remote.get("id") != account_id:
            raise PacketOrderError(
                "PAYOUT_UNAVAILABLE", "Could not verify payout setup. Please retry."
            )
        return remote

    async def refresh_account(self, user_id: str) -> dict[str, Any] | None:
        """Fresh provider authority for redemption and transfers; never use display cache."""
        mode = self.account_mode
        invalidate_payout_account_status(user_id=user_id, mode=mode)
        try:
            account = await self._account(user_id)
            if account is None:
                return None
            return await self._refresh_bound_account(
                user_id, account=account, mode=mode, key=self._account_key()
            )
        finally:
            invalidate_payout_account_status(user_id=user_id, mode=mode)

    async def _refresh_bound_account(
        self, user_id: str, *, account: dict[str, Any], mode: str, key: str
    ) -> dict[str, Any]:
        remote = await self._retrieve_account(account["stripe_account_id"], key=key)
        readiness = _account_readiness(remote)
        patch = {
            "details_submitted": readiness["detailsSubmitted"],
            "payouts_enabled": readiness["payoutsEnabled"],
            "account_ready": readiness["ready"],
            "updated_at": _now(),
        }
        updated = await self._rows(
            self.db.table(ACCOUNTS)
            .update(patch)
            .eq("user_id", user_id)
            .eq("stripe_mode", mode)
            .eq("stripe_account_id", account["stripe_account_id"])
        )
        if not updated:
            # The mapping was removed/rebound during provider I/O. It cannot
            # authorize a transfer or publish readiness for the old account.
            invalidate_payout_account_status(user_id=user_id, mode=mode)
            raise PacketOrderError(
                "PAYOUT_UNAVAILABLE", "Could not verify payout setup. Please retry."
            )
        if self._resume_documents and account.get("account_ready") is not readiness["ready"]:
            await resume_document_owner_setup(self.db, user_id)
        return {**account, **patch, "readiness": readiness}

    async def management_link(self, *, user_id: str) -> dict[str, str]:
        """Only the authenticated owner can open their mapped Express dashboard."""
        account = await self.refresh_account(user_id)
        if account is None:
            raise PacketOrderError("PAYOUT_ACCOUNT_REQUIRED", "Link a bank first.")
        if not account["readiness"]["canManageBank"]:
            raise PacketOrderError("PAYOUT_ACCOUNT_DISABLED", "This payout account needs support.")
        key = self._account_key()
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
                or parsed.hostname not in {"connect.stripe.com", "stripe.com"}
                or not parsed.path.startswith("/express/")
                or not parsed.path.removeprefix("/express/")
                or parsed.username
                or parsed.password
                or parsed.port
            ):
                raise ValueError("unexpected payout dashboard")
        except Exception as exc:
            _log_provider_error("dashboard", exc)
            raise PacketOrderError(
                "PAYOUT_UNAVAILABLE", "Couldn't open bank settings. Try again."
            ) from None
        invalidate_payout_account_status(user_id=user_id, mode=self.account_mode)
        return {"url": link["url"]}

    async def account_status(self, *, user_id: str, force_refresh: bool = False) -> dict[str, Any]:
        """Short-lived display metadata; every read still resolves the owner binding."""
        mode = self.account_mode
        if force_refresh:
            invalidate_payout_account_status(user_id=user_id, mode=mode)
        for _attempt in range(3):
            account = await self._account(user_id)
            if account is None:
                invalidate_payout_account_status(user_id=user_id, mode=mode)
                return {"account": None, "stripeMode": mode}
            key = self._account_key()
            # A rotation or provider endpoint change must not reuse a different
            # provider's readiness. Retain a digest only, never the credential.
            configuration = hashlib.sha256(
                repr(
                    (
                        key,
                        stripe_environment(),
                        id(self.stripe_api),
                        getattr(self.stripe_api, "api_base", None),
                        getattr(self.stripe_api, "api_version", None),
                    )
                ).encode()
            ).hexdigest()
            cache_key = (user_id, mode, configuration, account["stripe_account_id"])

            async def load(account: dict[str, Any] = account, key: str = key) -> dict[str, Any]:
                # A display lookup may outlive invalidation. Keep it read-only
                # so an old result cannot overwrite newer authoritative state
                # or wake document work before its cache generation is checked.
                # Verification and payout schedule come from this same read and
                # key; they are display only and never gate money.
                remote = await self._retrieve_account(account["stripe_account_id"], key=key)
                return _account_readiness(remote)

            try:
                readiness = await account_status_cache.get(cache_key, load)
            except StatusReadInvalidated:
                continue
            return {"account": readiness, "stripeMode": mode}
        raise PacketOrderError("PAYOUT_UNAVAILABLE", "Could not verify payout setup. Please retry.")

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
        if self.account_mode != configured_stripe_mode():
            raise PacketOrderError("PAYOUT_UNAVAILABLE", "Payout mode does not match earnings.")
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

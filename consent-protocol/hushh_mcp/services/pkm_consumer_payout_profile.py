"""Consumer defaults before hosted onboarding, preserving legacy create intent."""

from __future__ import annotations

import asyncio
from typing import Any

from .connect_payout_binding import require_separate_payout_account, scope_account_ids
from .pkm_packet_order_service import _stripe_dict
from .stripe_mode import stripe_environment


async def create_consumer_account(
    *, stripe_api: Any, api_key: str, mode: str, owner: str, database: Any
) -> dict[str, Any]:
    """Keep the original create intent while preparing only a verified new consumer."""
    intent = f"pkm-payout-account:{stripe_environment()}:{mode}:{owner}"
    foreign_ids = await scope_account_ids(database, owner, mode)
    created = _stripe_dict(
        await asyncio.to_thread(
            stripe_api.Account.create,
            api_key=api_key,
            idempotency_key=intent,
            type="express",
            country="US",
            capabilities={"transfers": {"requested": True}},
            metadata={"hussh_user_ref": "pkm_owner", "hussh_environment": stripe_environment()},
        )
    )
    account_id = created.get("id")
    foreign_ids.update(await scope_account_ids(database, owner, mode, account_id))
    require_separate_payout_account(account_id, foreign_ids)
    prepared = await prepare_consumer_profile(
        created,
        stripe_api=stripe_api,
        api_key=api_key,
        intent_key=intent,
    )
    require_separate_payout_account(
        account_id, await scope_account_ids(database, owner, mode, account_id)
    )
    return prepared


async def create_hosted_link(
    *,
    stripe_api: Any,
    api_key: str,
    account: str,
    return_url: str,
    refresh_url: str,
    mode: str,
    owner: str,
    purpose: str,
    attempt_id: str | None,
) -> dict[str, Any]:
    """Create a link for this settlement owner; validate correlated receipts."""
    from .pkm_packet_order_service import PacketOrderError
    from .scope_commerce.provider_onboarding_links import validate_onboarding_link
    from .scope_commerce.stripe_adapter import CommerceProviderError

    link = _stripe_dict(
        await asyncio.to_thread(
            stripe_api.AccountLink.create,
            api_key=api_key,
            account=account,
            type="account_onboarding",
            refresh_url=refresh_url,
            return_url=return_url,
            **(
                {"idempotency_key": f"pkm-payout-link:{mode}:{owner}:{purpose}:{attempt_id}"}
                if attempt_id
                else {}
            ),
            **(
                {
                    "collection_options": {
                        "fields": "eventually_due",
                        "future_requirements": "include",
                    }
                }
                if purpose == "verify"
                else {}
            ),
        )
    )
    if attempt_id:
        try:
            validate_onboarding_link(link)
        except CommerceProviderError:
            raise PacketOrderError("PAYOUT_LINK_EXPIRED", "Get a new payout setup link.") from None
    return link


async def prepare_consumer_profile(
    remote: dict[str, Any], *, stripe_api: Any, api_key: str, intent_key: str
) -> dict[str, Any]:
    account_id = remote.get("id")
    if not isinstance(account_id, str) or not account_id.startswith("acct_"):
        raise ValueError("Invalid consumer payout account")
    # Idempotent creates replay the original response, not current facts.
    remote = _stripe_dict(
        await asyncio.to_thread(
            stripe_api.Account.retrieve,
            account_id,
            api_key=api_key,
        )
    )
    if remote.get("id") != account_id or remote.get("deleted"):
        raise ValueError("Consumer payout account could not be verified")
    # Never reinterpret an existing business or a receipt without positive
    # evidence that onboarding has not begun. Existing mappings bypass this.
    if (
        remote.get("country") != "US"
        or remote.get("details_submitted") is not False
        or remote.get("business_type") is not None
        or remote.get("company")
        or any(
            (remote.get("business_profile") or {}).get(field)
            for field in ("product_description", "url", "name", "mcc")
        )
    ):
        return remote
    # Keep Account.create's historical idempotency body unchanged. A separate
    # account-bound, replayable preparation happens before mapping or links.
    prepared = _stripe_dict(
        await asyncio.to_thread(
            stripe_api.Account.modify,
            account_id,
            api_key=api_key,
            idempotency_key=f"{intent_key}:consumer-profile:{account_id}",
            business_type="individual",
            business_profile={
                "product_description": (
                    "Individual providing their own documents and written answers "
                    "through Hussh with their consent."
                )
            },
        )
    )
    if (
        prepared.get("id") != account_id
        or prepared.get("country") != "US"
        or prepared.get("business_type") != "individual"
    ):
        raise ValueError("Consumer payout preparation could not be verified")
    current = _stripe_dict(
        await asyncio.to_thread(
            stripe_api.Account.retrieve,
            account_id,
            api_key=api_key,
        )
    )
    if (
        current.get("id") != account_id
        or current.get("deleted")
        or current.get("country") != "US"
        or current.get("business_type") != "individual"
    ):
        raise ValueError("Consumer payout preparation could not be verified")
    return current


def hosted_return_urls(
    origin: str, path: str, surface: str, attempt_id: str | None
) -> dict[str, str]:
    """Preserve legacy destinations and bind each settlement surface exactly."""
    if attempt_id:
        from .scope_commerce.provider_onboarding_links import onboarding_urls

        if surface not in {"documents", "answers"}:
            raise ValueError("invalid correlated payout surface")
        return onboarding_urls(
            origin,
            "/one/profile/payouts",
            attempt_id,
            source="answers" if surface == "answers" else "documents",
        )
    query = {"documents": "documentPayouts", "answers": "answerPayouts"}.get(surface, "payouts")
    return {
        "return_url": f"{origin}{path}?{query}=done",
        "refresh_url": f"{origin}{path}?{query}=refresh",
    }

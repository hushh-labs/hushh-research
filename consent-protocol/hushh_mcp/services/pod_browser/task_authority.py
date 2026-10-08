"""Per-hop checks and private reviews composed with the existing authorities."""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable

from .consent import BrowserConsentPort, Purpose
from .contracts import BrowserAction, BrowserAuthorityPort, BrowserBinding, BrowserRefused
from .task_contracts import BrowserOwnerAccess, BrowserReviewAuthorityPort, BrowserReviewOffer


def owner_review(offer: BrowserReviewOffer) -> BrowserReviewOffer:
    """Display retention metadata without exporting website sign-in secrets.

    The authority retains full exact terms/commitment. This redacted display
    does not alter what its receipt authorizes or what require() consumes.
    """
    if offer.purpose not in {"session_remember", "session_restore"}:
        return offer
    source = offer.terms
    terms = {key: source[key] for key in ("site", "generation", "origins") if key in source}
    if offer.purpose == "session_remember":
        state = source.get("state", {})
        if not isinstance(state, dict):
            raise BrowserRefused("BROWSER_REVIEW_INVALID")
        terms["cookie_count"] = len(state.get("cookies", []))
        terms["storage_item_count"] = sum(
            len(origin.get("localStorage", []))
            for origin in state.get("origins", [])
            if isinstance(origin, dict)
        )
    return BrowserReviewOffer(review_id=offer.review_id, purpose=offer.purpose, terms=terms)


class TaskConsent(BrowserConsentPort):
    def __init__(
        self,
        binding: BrowserBinding,
        access: BrowserOwnerAccess,
        reviews: BrowserReviewAuthorityPort,
        pending: Callable[[BrowserReviewOffer], None],
        clock: Callable[[], float] = time.time,
        check_runtime: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self._binding, self._access, self._reviews, self._pending = (
            binding,
            access,
            reviews,
            pending,
        )
        self._clock = clock
        self._check_runtime = check_runtime

    async def check_binding(self, binding: BrowserBinding) -> None:
        if binding != self._binding or binding.expires_at <= self._clock():
            raise BrowserRefused("BROWSER_BINDING_REFUSED")
        if self._check_runtime:
            await self._check_runtime()
        await self._access.check()
        await self._reviews.check_binding(binding)
        if self._check_runtime:
            await self._check_runtime()

    async def require(self, binding: BrowserBinding, purpose: Purpose, private_terms: dict) -> None:
        await self.check_binding(binding)
        try:
            await self._reviews.require(binding, purpose, private_terms)
        except BrowserRefused as exc:
            if exc.code != "BROWSER_OWNER_APPROVAL_REQUIRED":
                raise
            offer = await self._reviews.offer_review(binding, purpose, private_terms)
            await self.check_binding(binding)
            if offer.purpose != purpose:
                raise BrowserRefused("BROWSER_REVIEW_INVALID")
            self._pending(owner_review(offer))
            raise
        await self.check_binding(binding)


class TaskAuthority(BrowserAuthorityPort):
    def __init__(
        self, binding: BrowserBinding, consent: TaskConsent, authority: BrowserAuthorityPort
    ) -> None:
        self._binding, self._consent, self._authority = binding, consent, authority

    async def check_binding(self, binding: BrowserBinding) -> None:
        if binding != self._binding:
            raise BrowserRefused("BROWSER_BINDING_REFUSED")
        await self._consent.check_binding(binding)
        await self._authority.check_binding(binding)

    async def authorize_action(self, binding: BrowserBinding, action: BrowserAction) -> None:
        await self.check_binding(binding)
        await self._authority.authorize_action(binding, action)
        await self.check_binding(binding)

    async def journal_dispatch(self, binding: BrowserBinding, action: BrowserAction) -> None:
        await self.check_binding(binding)
        await self._authority.journal_dispatch(binding, action)
        await self.check_binding(binding)

    async def settle_dispatch(
        self, binding: BrowserBinding, action: BrowserAction, *, uncertain: bool
    ) -> None:
        # Settlement preserves the initial intent even if admission was revoked
        # during dispatch. The ledger adapter owns its exact bound write check.
        await self._authority.settle_dispatch(binding, action, uncertain=uncertain)

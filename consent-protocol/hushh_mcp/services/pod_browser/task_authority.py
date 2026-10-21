"""Per-hop checks and private reviews composed with the existing authorities."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from .information import BrowserInformation, BrowserModelProcessing
from .task_contracts import BrowserTaskRequest

if TYPE_CHECKING:
    from .task_runtime import BrowserTaskRuntime
    from .task_state import BrowserTaskState

from .consent import BrowserConsentPort, Purpose
from .contracts import (
    BrowserAction,
    BrowserAuthorityPort,
    BrowserBinding,
    BrowserExecutionScope,
    BrowserRefused,
)
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
    return offer.model_copy(update={"terms": terms})


class TaskConsent(BrowserConsentPort):
    def __init__(
        self,
        binding: BrowserBinding,
        access: BrowserOwnerAccess,
        reviews: BrowserReviewAuthorityPort,
        pending: Callable[[BrowserReviewOffer], None],
        clock: Callable[[], float] = time.time,
        check_runtime: Callable[[], Awaitable[None]] | None = None,
        wait_for_review: Callable[[BrowserReviewOffer], Awaitable[None]] | None = None,
    ) -> None:
        self._binding, self._access, self._reviews, self._pending = (
            binding,
            access,
            reviews,
            pending,
        )
        self._clock = clock
        self._check_runtime = check_runtime
        self._wait_for_review = wait_for_review

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
            if purpose not in {"provider_safety", "disclose"} or self._wait_for_review is None:
                raise
            # Keep the exact native invocation paused in this bounded task.
            # A confirmation wakes this stack, not a new interpretation of the
            # goal. Takeover, stop, expiry and drain cancel the waiting worker.
            await self._wait_for_review(offer)
            await self.check_binding(binding)
            await self._reviews.require(binding, purpose, private_terms)
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

    async def authorize_action(
        self,
        binding: BrowserBinding,
        action: BrowserAction,
        *,
        scope: BrowserExecutionScope | None = None,
    ) -> None:
        await self.check_binding(binding)
        await self._authority.authorize_action(binding, action, scope=scope)
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


async def prepare_task(
    runtime: BrowserTaskRuntime,
    task: BrowserTaskState,
    access: BrowserOwnerAccess,
    request: BrowserTaskRequest,
) -> None:
    binding = task.binding

    def pending(offer: BrowserReviewOffer) -> None:
        if task.review_waiting is not None and task.review_waiting != offer.review_id:
            raise BrowserRefused("BROWSER_REVIEW_PENDING")
        task.review_ready.clear()
        task.review, task.phase, task.code = (
            offer,
            "needs_owner",
            "BROWSER_OWNER_APPROVAL_REQUIRED",
        )
        task.revision += 1

    async def wait_for_review(offer: BrowserReviewOffer) -> None:
        if task.review is None or task.review.review_id != offer.review_id:
            raise BrowserRefused("BROWSER_REVIEW_CHANGED")
        task.review_waiting = offer.review_id
        try:
            remaining = min(300, binding.expires_at - runtime._clock())
            if remaining <= 0:
                raise BrowserRefused("BROWSER_AUTHORIZATION_EXPIRED")
            async with asyncio.timeout(remaining):
                await task.review_ready.wait()
        finally:
            task.review_waiting = None

    async def check_runtime() -> None:
        if task.closed or task.closing is not None:
            raise BrowserRefused("BROWSER_STOPPED")
        current = runtime.capability()
        if not current.available:
            raise BrowserRefused(current.code)

    task.consent = TaskConsent(
        binding, access, runtime._reviews, pending, runtime._clock, check_runtime, wait_for_review
    )
    authority = runtime._authority_factory(binding, task.consent)
    pending_check = getattr(authority, "check_no_pending_dispatch", None)
    try:
        if not callable(pending_check):
            raise BrowserRefused("BROWSER_DISPATCH_RECOVERY_UNAVAILABLE")
        await task.consent.check_binding(binding)
        await pending_check(binding)
        task.authority = TaskAuthority(binding, task.consent, authority)
        task.processing = BrowserModelProcessing(
            information=BrowserInformation(runtime._source, task.consent),
            binding=binding,
            fields=request.fields,
            model_name=runtime._model.model_name,
            transport=runtime._model.transport,
            allowed_origins=request.allowed_origins,
            task_goal=request.goal,
        )
        if runtime._sessions_factory:
            task.sessions = runtime._sessions_factory(task.consent)
        await runtime._checkpoint(task)
    except BaseException:
        await runtime._reviews.release(binding)
        await task.permit.release()
        raise

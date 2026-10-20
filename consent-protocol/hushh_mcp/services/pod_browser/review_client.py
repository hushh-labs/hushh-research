"""Pod-side browser reviews: private terms in RAM, owner receipts from the hub."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime

from .consent import Purpose, private_commitment
from .contracts import BrowserBinding, BrowserRefused
from .review_contracts import BrowserHubMutation, BrowserHubReview
from .task_contracts import BrowserReviewOffer


@dataclass
class _Pending:
    review: BrowserHubReview
    offer: BrowserReviewOffer
    approval_expires_at: float
    receipt: str | None = field(default=None, repr=False)
    consumed: bool = False


class PodBrowserReviews:
    def __init__(
        self,
        *,
        key: bytes,
        pod_key_id: str,
        environment: str,
        epoch: int,
        check_binding: Callable[[BrowserBinding], Awaitable[None]],
        client,
        clock: Callable[[], float] = time.time,
    ) -> None:
        # Trusted composition supplies the existing pod custody and active lease.
        # The browser, model and HTTP caller can supply none of these ports.
        private_commitment(key, {})
        self._key, self._pod_key_id, self._environment = key, pod_key_id, environment
        self._epoch, self._admission, self._client, self._clock = (
            epoch,
            check_binding,
            client,
            clock,
        )
        self._pending: dict[str, _Pending] = {}
        self._lock = asyncio.Lock()

    async def check_binding(self, binding: BrowserBinding) -> None:
        if binding.expires_at <= self._clock():
            raise BrowserRefused("BROWSER_BINDING_EXPIRED")
        await self._admission(binding)

    def _terms(self, binding, purpose, terms) -> BrowserHubReview:
        return BrowserHubReview(
            binding=binding,
            purpose=purpose,
            commitment=private_commitment(self._key, terms),
            pod_key_id=self._pod_key_id,
            environment=self._environment,
            epoch=self._epoch,
        )

    async def _call(self, operation: str, payload: BrowserHubMutation) -> dict:
        await self.check_binding(payload.review.binding)
        worker = asyncio.create_task(
            asyncio.to_thread(
                self._client.post,
                f"/api/one/pod/browser-approval/{operation}",
                json=payload.model_dump(mode="json", exclude_none=True),
            )
        )
        response = None
        try:
            response = await asyncio.shield(worker)
            if response.status_code != 200 or len(response.content) > 16384:
                raise BrowserRefused("BROWSER_REVIEW_UNAVAILABLE")
            result = response.json()
            if not isinstance(result, dict):
                raise BrowserRefused("BROWSER_REVIEW_UNAVAILABLE")
        except Exception:
            # No provider error/body, goal, screen or receipt enters diagnostics.
            raise BrowserRefused("BROWSER_REVIEW_UNAVAILABLE") from None
        except asyncio.CancelledError:
            # PodHubClient bounds its transport. Reap the thread before releasing
            # the task/update permit; cancellation does not undo a ledger write.
            with suppress(Exception):
                response = await worker
            raise
        finally:
            if response is not None:
                response.close()
        await self.check_binding(payload.review.binding)
        return result

    async def offer_review(self, binding, purpose, private_terms) -> BrowserReviewOffer:
        await self.check_binding(binding)
        review = self._terms(binding, purpose, private_terms)
        async with self._lock:
            self._pending = {
                key: item
                for key, item in self._pending.items()
                if item.review.binding.expires_at > self._clock()
            }
            for pending in self._pending.values():
                if (
                    not pending.consumed
                    and pending.review.model_copy(update={"service_uid": None}) == review
                    and (pending.receipt is not None or pending.approval_expires_at > self._clock())
                ):
                    return pending.offer
            if len(self._pending) >= 256:
                raise BrowserRefused("BROWSER_REVIEW_LIMIT")
            return await self._issue_locked(review, private_terms)

    async def _issue_locked(
        self, review: BrowserHubReview, private_terms: dict
    ) -> BrowserReviewOffer:
        result = await self._call("issue", BrowserHubMutation(review=review))
        try:
            recorded = BrowserHubReview.model_validate(result["review"])
            deadline = datetime.fromisoformat(result["expires_at"])
            if (
                deadline.tzinfo is None
                or not self._clock() < deadline.timestamp() <= self._clock() + 301
            ):
                raise ValueError()
            mutation = BrowserHubMutation(review=recorded, directive_id=result["directive_id"])
            if (
                not recorded.service_uid
                or recorded.model_copy(update={"service_uid": None}) != review
                or mutation.directive_id in self._pending
            ):
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise BrowserRefused("BROWSER_REVIEW_CHANGED") from None
        offer = BrowserReviewOffer(
            review_id=mutation.directive_id,
            purpose=review.purpose,
            terms=private_terms,
            coordination=recorded,
        )
        self._pending[offer.review_id] = _Pending(recorded, offer, deadline.timestamp())
        return offer

    async def refresh_review(self, binding, review_id: str) -> BrowserReviewOffer:
        await self.check_binding(binding)
        async with self._lock:
            pending = self._pending.get(review_id)
            if pending is None or pending.review.binding != binding or pending.consumed:
                raise BrowserRefused("BROWSER_REVIEW_CHANGED")
            if pending.receipt is not None or pending.approval_expires_at > self._clock():
                return pending.offer
            # Keep the old offer refreshable until a validated replacement
            # exists. Failed/lost issuance never strands the owner's task.
            offer = await self._issue_locked(
                pending.review.model_copy(update={"service_uid": None}), pending.offer.terms
            )
            del self._pending[review_id]
            return offer

    async def release(self, binding: BrowserBinding) -> None:
        # Cleanup must also work after admission has expired or been revoked.
        async with self._lock:
            self._pending = {
                key: item for key, item in self._pending.items() if item.review.binding != binding
            }

    async def confirm_review(self, binding, review_id: str, receipt: str) -> None:
        await self.check_binding(binding)
        async with self._lock:
            pending = self._pending.get(review_id)
            if pending is None or pending.review.binding != binding or pending.consumed:
                raise BrowserRefused("BROWSER_REVIEW_CHANGED")
            payload = BrowserHubMutation(
                review=pending.review, directive_id=review_id, receipt=receipt
            )
            if pending.receipt is not None:
                if pending.receipt != receipt:
                    raise BrowserRefused("BROWSER_REVIEW_CHANGED")
                # Exact consume is idempotent at the existing hub ledger.
                # Retry can recover loss before OR after commit; it never
                # renews permission or dispatches a browser action.
            pending.receipt = receipt
            result = await self._call("consume", payload)
            if result != {"status": "consumed"}:
                raise BrowserRefused("BROWSER_REVIEW_UNAVAILABLE")

    async def require(self, binding, purpose: Purpose, private_terms: dict) -> None:
        await self.check_binding(binding)
        review = self._terms(binding, purpose, private_terms)
        async with self._lock:
            pending = next(
                (
                    item
                    for item in self._pending.values()
                    if not item.consumed
                    and item.review.model_copy(update={"service_uid": None}) == review
                ),
                None,
            )
            if pending is None or pending.receipt is None or pending.consumed:
                raise BrowserRefused("BROWSER_OWNER_APPROVAL_REQUIRED")
            result = await self._call(
                "validate",
                BrowserHubMutation(
                    review=pending.review,
                    directive_id=pending.offer.review_id,
                    receipt=pending.receipt,
                ),
            )
            if result != {"status": "valid"}:
                raise BrowserRefused("BROWSER_REVIEW_UNAVAILABLE")
            if purpose in {"disclose", "provider_safety"}:
                pending.consumed = True

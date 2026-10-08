"""Private browser review terms over the existing action directive ledger.

This is a disabled-pilot adapter, not a new authentication system or HTTP route.
Its binding check belongs to current pod admission; browser confirmation belongs
to the existing vault-owner authenticated route. Private terms never enter SQL.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Literal, Protocol

from hushh_mcp.services.action_directive_ledger import ActionDirectiveStore, BoundActionTerms

from .contracts import BrowserBinding, BrowserRefused

Purpose = Literal["model_process", "disclose", "session_remember", "session_restore"]
ACTION_PREFIX = "browser."


def private_commitment(key: bytes, value: object) -> str:
    if len(key) != 32:
        raise BrowserRefused("BROWSER_COMMITMENT_KEY_UNAVAILABLE")
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    purpose_key = hmac.digest(key, b"hussh/browser-review/v1", "sha256")
    return hmac.new(purpose_key, encoded, hashlib.sha256).hexdigest()


@dataclass(frozen=True)
class BrowserReview:
    binding: BrowserBinding
    purpose: Purpose
    commitment: str

    @property
    def terms(self) -> BoundActionTerms:
        return BoundActionTerms(
            action_contract={"action_id": ACTION_PREFIX + self.purpose, "version": 1},
            slots={"commitment": self.commitment},
            resource_binding={"kind": "pod_browser_review_v1", **self.binding.model_dump()},
        )

    @property
    def identity(self) -> dict:
        return {
            "user_id": self.binding.owner_id,
            "session_id": self.binding.task_id,
            "action_id": ACTION_PREFIX + self.purpose,
            "context_revision": self.commitment,
        }


class BrowserConsentPort(Protocol):
    async def check_binding(self, binding: BrowserBinding) -> None: ...

    async def require(
        self, binding: BrowserBinding, purpose: Purpose, private_terms: dict
    ) -> None: ...


@dataclass(frozen=True)
class BrowserApprovalReceipt:
    directive_id: str
    receipt: str = field(repr=False)


class LedgerBrowserConsent:
    """Task leases derived from consumed exact owner receipts, never booleans.

    Construct on the trusted authority side with the existing ledger and current
    admission check in the owning registry transaction. A pod uses a narrow
    authenticated coordination port instead of receiving hub SQL credentials.
    No production route currently constructs this adapter: cloud admission is off.
    """

    def __init__(
        self,
        *,
        store: ActionDirectiveStore,
        key: bytes,
        check_binding: Callable[[BrowserBinding], Awaitable[None]],
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._store, self._key, self._admission, self._clock = store, key, check_binding, clock
        self._receipts: dict[BrowserReview, BrowserApprovalReceipt] = {}
        self._leases: dict[BrowserReview, BrowserApprovalReceipt] = {}

    def review(self, binding: BrowserBinding, purpose: Purpose, terms: dict) -> BrowserReview:
        return BrowserReview(binding, purpose, private_commitment(self._key, terms))

    async def check_binding(self, binding: BrowserBinding) -> None:
        if binding.expires_at <= self._clock():
            raise BrowserRefused("BROWSER_BINDING_EXPIRED")
        await self._admission(binding)

    async def offer(self, review: BrowserReview):
        await self.check_binding(review.binding)
        terms = review.terms
        return await self._store.issue(
            **review.identity,
            channel="pod_chat",
            action_contract=terms.action_contract,
            slots=terms.slots,
            resource_binding=terms.resource_binding,
            trusted_activation_required=True,
        )

    async def accept_owner_receipt(
        self, review: BrowserReview, receipt: BrowserApprovalReceipt
    ) -> None:
        # Receipt can only be minted by store.confirm() behind owner authentication.
        # Holding a pod principal or the review itself cannot mint it here.
        await self.check_binding(review.binding)
        if review in self._leases:
            raise BrowserRefused("BROWSER_APPROVAL_ALREADY_USED")
        self._receipts[review] = receipt

    async def require(self, binding: BrowserBinding, purpose: Purpose, private_terms: dict) -> None:
        await self.check_binding(binding)
        review = self.review(binding, purpose, private_terms)
        if purpose != "disclose" and review in self._leases:
            lease = self._leases[review]
            await self._store.require_consumed_browser(
                **review.identity,
                directive_id=lease.directive_id,
                receipt=lease.receipt,
                terms=review.terms,
            )
            await self.check_binding(binding)
            return
        receipt = self._receipts.pop(review, None)
        if receipt is None:
            raise BrowserRefused("BROWSER_OWNER_APPROVAL_REQUIRED")
        await self._store.consume(
            **review.identity,
            directive_id=receipt.directive_id,
            receipt=receipt.receipt,
            terms=review.terms,
            expected_channel="pod_chat",
        )
        await self.check_binding(binding)
        # Website transmissions are single-use. Model/reuse grants are immutable,
        # task-bound leases; changed revisions/generations have a new commitment.
        if purpose != "disclose":
            self._leases[review] = receipt

    def invalidate(self) -> None:
        self._receipts.clear()
        self._leases.clear()

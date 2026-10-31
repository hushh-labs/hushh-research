"""Hub half of Browser approval using the existing action ledger and row fence."""

from __future__ import annotations

import time
from typing import Literal

from hushh_mcp.services.action_directive_ledger import (
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
)
from hushh_mcp.services.pod_request_signing import VerifiedPod
from hushh_mcp.services.private_review_registry import with_private_review_registry

from .review_contracts import BrowserHubMutation, BrowserHubReview

Operation = Literal["issue", "confirm", "consume", "validate"]


async def change_browser_review(
    store: ActionDirectiveStore,
    operation: Operation,
    review: BrowserHubReview,
    payload: BrowserHubMutation,
) -> dict:
    if not time.time() < review.binding.expires_at <= time.time() + 900:
        raise ActionDirectiveAuthorityError("Browser task expired or changed.")
    if operation == "issue":
        if payload.directive_id is not None or payload.receipt is not None:
            raise ActionDirectiveAuthorityError("Invalid browser review issue.")
        terms = review.terms
        issued = await store.issue(
            **review.identity,
            channel="pod_chat",
            action_contract=terms.action_contract,
            slots=terms.slots,
            resource_binding=terms.resource_binding,
            trusted_activation_required=True,
        )
        return {
            "directive_id": issued.directive_id,
            "expires_at": issued.expires_at.isoformat(),
            "review": review.model_dump(mode="json"),
        }
    if not payload.directive_id:
        raise ActionDirectiveAuthorityError("Browser review required.")
    if operation == "confirm":
        if payload.receipt is not None:
            raise ActionDirectiveAuthorityError("Unexpected browser receipt.")
        receipt = await store.confirm_browser(
            **review.identity,
            directive_id=payload.directive_id,
            terms=review.terms,
        )
        return {
            "status": "confirmed",
            "directive_id": receipt.directive_id,
            "receipt": receipt.receipt,
        }
    if not payload.receipt:
        raise ActionDirectiveAuthorityError("Browser owner receipt required.")
    query = {
        **review.identity,
        "directive_id": payload.directive_id,
        "receipt": payload.receipt,
        "terms": review.terms,
    }
    if operation == "consume":
        try:
            await store.consume(**query, expected_channel="pod_chat")
        except ActionDirectiveAuthorityError:
            # Recover only the same consumed Browser receipt under the current
            # registry fence. No expiry or receipt is renewed or rewritten.
            # This acknowledges permission; execution is separately journaled.
            await store.require_consumed_browser(**query)
        return {"status": "consumed"}
    if operation == "validate":
        await store.require_consumed_browser(**query)
        return {"status": "valid"}
    raise ActionDirectiveAuthorityError("Unknown browser review operation.")


async def mutate_browser_review(
    operation: Operation,
    payload: BrowserHubMutation,
    *,
    principal: VerifiedPod | None = None,
    db=None,
) -> dict:
    review = payload.review
    if operation == "confirm" and principal is not None:
        raise ActionDirectiveAuthorityError("Owner confirmation is required.")

    async def apply(store: ActionDirectiveStore, uid: str) -> dict:
        return await change_browser_review(
            store, operation, review.model_copy(update={"service_uid": uid}), payload
        )

    return await with_private_review_registry(
        owner_id=review.binding.owner_id,
        hushh_id=review.binding.pod_id,
        pod_key_id=review.pod_key_id,
        environment=review.environment,
        service_uid=review.service_uid,
        issuing=operation == "issue",
        owner_confirmation=operation == "confirm",
        principal=principal,
        apply=apply,
        db=db,
    )

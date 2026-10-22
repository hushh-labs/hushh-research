"""Exact private-action terms and receipt queries for the existing ledger."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, TypedDict


class ActionDirectiveAuthorityError(RuntimeError):
    """A directive could not advance through its one-time authority state."""

    # Closed diagnostic code; never changes who may proceed.
    reason: str | None = None


MCP_ACTION_ID = "connector.mcp.invoke"
BROWSER_ACTION_IDS = frozenset(
    {
        "browser.model_process",
        "browser.disclose",
        "browser.session_remember",
        "browser.session_restore",
        "browser.provider_safety",
    }
)


@dataclass(frozen=True)
class BoundActionTerms:
    """Fresh server-derived terms, never client-supplied digests or authority."""

    action_contract: dict[str, Any] = field(repr=False)
    slots: dict[str, Any] = field(repr=False)
    resource_binding: dict[str, Any] = field(repr=False)


def bound_term_params(
    action_id: str, terms: BoundActionTerms | None, digest: Callable[[Any], str]
) -> dict:
    if (action_id == MCP_ACTION_ID or action_id in BROWSER_ACTION_IDS) and terms is None:
        raise ActionDirectiveAuthorityError("Private approval requires exact current terms.")
    return {
        "check_bound_terms": terms is not None,
        "expected_contract": digest(terms.action_contract) if terms else None,
        "expected_slots": digest(terms.slots) if terms else None,
        "expected_binding": digest(terms.resource_binding) if terms else None,
    }


def require_private_review_binding(
    action_id: str,
    session_id: str | None,
    conversation_id: str | None,
    adk_app_name: str | None,
    trusted_activation: bool,
    resource_binding: dict | None,
) -> None:
    kind = (
        "pod_mcp_review_v1"
        if action_id == MCP_ACTION_ID
        else "pod_browser_review_v1"
        if action_id in BROWSER_ACTION_IDS
        else None
    )
    if (
        kind is None
        or not session_id
        or conversation_id
        or adk_app_name is not None
        or not trusted_activation
        or not resource_binding
        or resource_binding.get("kind") != kind
    ):
        raise ActionDirectiveAuthorityError("Private action requires exact pod review terms.")


class BrowserReviewQuery(TypedDict):
    directive_id: str
    user_id: str
    session_id: str
    action_id: str
    context_revision: str
    terms: BoundActionTerms


class BrowserLeaseQuery(BrowserReviewQuery):
    receipt: str


async def confirm_browser_task(
    query: BrowserReviewQuery,
    digest: Callable[[Any], str],
    execute: Callable[[str, dict], Awaitable[Any]],
) -> dict:
    """Recover the same exact owner confirmation after a lost acknowledgement.

    The authenticated owner route calls this under the current registry lock.
    A server-keyed receipt is reproducible without storing its plaintext. Repeats
    never revert consumed state, renew expiry or authorize changed terms.
    """
    if (
        set(query) != set(BrowserReviewQuery.__annotations__)
        or query["action_id"] not in BROWSER_ACTION_IDS
    ):
        raise ActionDirectiveAuthorityError("A browser confirmation requires browser terms.")
    params = {key: value for key, value in query.items() if key != "terms"}
    params.update(bound_term_params(query["action_id"], query["terms"], digest))
    receipt = digest({"purpose": "browser-confirmation-receipt-v1", **params})
    params["receipt_hash"] = hashlib.sha256(receipt.encode()).hexdigest()
    result = await execute(
        """
        UPDATE one_action_directive_ledger
        SET state=CASE WHEN state='issued' THEN 'confirmed' ELSE state END,
            receipt_hash=:receipt_hash, confirmed_at=COALESCE(confirmed_at, clock_timestamp())
        WHERE directive_id=:directive_id AND user_id=:user_id
          AND session_id=:session_id AND channel='pod_chat'
          AND conversation_id IS NULL AND adk_app_name IS NULL
          AND action_id=:action_id AND context_revision=:context_revision
          AND action_contract_digest=:expected_contract AND slots_hmac=:expected_slots
          AND resource_binding_hmac=:expected_binding
          AND requires_confirmation AND trusted_activation_required
          AND expires_at > clock_timestamp()
          AND (state='issued' OR (state IN ('confirmed','consumed') AND receipt_hash=:receipt_hash))
        RETURNING directive_id, expires_at, confirmed_at
        """,
        params,
    )
    rows = result.data or []
    if not rows:
        raise ActionDirectiveAuthorityError("Browser confirmation expired or changed.")
    return {**rows[0], "receipt": receipt}


async def require_browser_task_lease(
    query: BrowserLeaseQuery,
    digest: Callable[[Any], str],
    execute: Callable[[str, dict], Awaitable[Any]],
) -> None:
    """Recheck a consumed exact task receipt; task admission owns lifetime."""
    if (
        set(query) != set(BrowserLeaseQuery.__annotations__)
        or query["action_id"] not in BROWSER_ACTION_IDS
    ):
        raise ActionDirectiveAuthorityError("A browser lease requires browser terms.")
    params = {key: value for key, value in query.items() if key not in {"terms", "receipt"}}
    params["receipt_hash"] = hashlib.sha256(query["receipt"].encode()).hexdigest()
    params.update(bound_term_params(query["action_id"], query["terms"], digest))
    result = await execute(
        """
        SELECT directive_id FROM one_action_directive_ledger
        WHERE directive_id=:directive_id AND receipt_hash=:receipt_hash
          AND user_id=:user_id AND session_id=:session_id AND channel='pod_chat'
          AND action_id=:action_id AND context_revision=:context_revision
          AND action_contract_digest=:expected_contract AND slots_hmac=:expected_slots
          AND resource_binding_hmac=:expected_binding AND state='consumed'
    """,
        params,
    )
    if not (result.data or []):
        raise ActionDirectiveAuthorityError("Browser task permission was revoked or changed.")

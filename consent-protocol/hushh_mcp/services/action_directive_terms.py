"""Exact private-action terms and receipt queries for the existing ledger."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, TypedDict


class ActionDirectiveAuthorityError(RuntimeError):
    """A directive could not advance through its one-time authority state."""


MCP_ACTION_ID = "connector.mcp.invoke"
BROWSER_ACTION_IDS = frozenset(
    {
        "browser.model_process",
        "browser.disclose",
        "browser.session_remember",
        "browser.session_restore",
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


class BrowserLeaseQuery(TypedDict):
    directive_id: str
    receipt: str
    user_id: str
    session_id: str
    action_id: str
    context_revision: str
    terms: BoundActionTerms


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

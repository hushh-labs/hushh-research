"""Exact, idempotent restart rebinding in the existing action ledger."""

from datetime import timezone

from sqlalchemy import text

from hushh_mcp.services.action_directive_ledger import MCP_ACTION_ID, ActionDirectiveAuthorityError

REBOUND = "pod_review_rebound"


def _matches(row, review, store):
    terms = review.terms
    expected = {
        "user_id": review.ownerId,
        "channel": "pod_chat",
        "session_id": review.conversationId,
        "conversation_id": None,
        "adk_app_name": None,
        "action_id": MCP_ACTION_ID,
        "context_revision": review.identity["context_revision"],
        "action_contract_digest": store._hmac(terms.action_contract),
        "slots_hmac": store._hmac(terms.slots),
        "resource_binding_hmac": store._hmac(terms.resource_binding),
        "trusted_activation_required": True,
    }
    return bool(row) and all(row[key] == value for key, value in expected.items())


def rebind_review(store, *, previous, current, directive_id):
    """Caller holds the verified registry lock; neither grant nor expiry broadens."""
    conn = store._connection
    if conn is None or not conn.in_transaction():
        raise ActionDirectiveAuthorityError("Private review recovery requires a transaction.")
    if current.epoch <= previous.epoch or current.model_dump(
        exclude={"epoch"}
    ) != previous.model_dump(exclude={"epoch"}):
        raise ActionDirectiveAuthorityError("Only a current pod restart can recover this review.")
    successor = (
        "dir_"
        + store._hmac(
            {
                "purpose": "pod-mcp-rebind-v1",
                "previous": directive_id,
                "terms": current.model_dump(),
            }
        )[:32]
    )
    old = (
        conn.execute(
            text("""SELECT * FROM one_action_directive_ledger
        WHERE directive_id=:id FOR UPDATE"""),
            {"id": directive_id},
        )
        .mappings()
        .one_or_none()
    )
    existing = (
        conn.execute(
            text("""SELECT * FROM one_action_directive_ledger
        WHERE directive_id=:id FOR UPDATE"""),
            {"id": successor},
        )
        .mappings()
        .one_or_none()
    )
    now = conn.execute(text("SELECT clock_timestamp()")).scalar_one()
    if (
        not _matches(old, previous, store)
        or old["expires_at"] <= now
        or old["consumed_at"] is not None
    ):
        raise ActionDirectiveAuthorityError(
            "Private review is expired or its outcome is uncertain."
        )
    if old["state"] == "cancelled":
        if (
            old["settlement_reason_code"] != REBOUND
            or not _matches(existing, current, store)
            or existing["expires_at"] != old["expires_at"]
            or existing["state"] != "issued"
            or existing["consumed_at"] is not None
        ):
            raise ActionDirectiveAuthorityError("Private review recovery outcome is uncertain.")
    else:
        if old["state"] not in {"issued", "confirmed"} or existing is not None:
            raise ActionDirectiveAuthorityError("Private review cannot be recovered safely.")
        conn.execute(
            text("""UPDATE one_action_directive_ledger SET state='cancelled',
            settlement_reason_code=:reason,settled_at=clock_timestamp()
            WHERE directive_id=:id"""),
            {"id": directive_id, "reason": REBOUND},
        )
        terms = current.terms
        conn.execute(
            text("""INSERT INTO one_action_directive_ledger (
            directive_id,user_id,channel,session_id,action_id,context_revision,
            action_contract_digest,slots_hmac,resource_binding_hmac,
            trusted_activation_required,expires_at)
            VALUES (:id,:owner,'pod_chat',:session,:action,:context,:contract,:slots,:binding,
                    TRUE,:expires)"""),
            {
                "id": successor,
                "owner": current.ownerId,
                "session": current.conversationId,
                "action": MCP_ACTION_ID,
                "context": current.identity["context_revision"],
                "contract": store._hmac(terms.action_contract),
                "slots": store._hmac(terms.slots),
                "binding": store._hmac(terms.resource_binding),
                "expires": old["expires_at"],
            },
        )
    return {
        "directiveId": successor,
        "expiresAt": old["expires_at"].astimezone(timezone.utc).isoformat(),
        "podReview": current.model_dump(),
        "state": "issued",
    }

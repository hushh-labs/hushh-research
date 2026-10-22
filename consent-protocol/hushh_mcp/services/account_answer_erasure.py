"""Erase unanswered content without orphaning the paid-answer recovery lane."""

from typing import Any

from sqlalchemy import text


def guard_answer_erasure(conn: Any, *, user_id: str) -> bool:
    """Use the account transaction; refuse until answer payment retention is supported.

    Answer workers still need their live orders, identities and payout destination.
    An ownerless obligation alone cannot prove late settlement or transfer recovery.
    Keep every payment order, including historical orders, behind this conservative
    fence until that lane supports verified identity-free reconciliation.
    """
    if not conn.execute(text("SELECT to_regclass('pkm_answer_requests')")).scalar():
        return False
    params = {"user": user_id}
    # Checkout and delivery take the same request lock before the order lock.
    conn.execute(
        text("""SELECT request_id FROM pkm_answer_requests
          WHERE owner_user_id=:user OR requester_user_id=:user
          ORDER BY request_id FOR UPDATE"""),
        params,
    ).all()
    payment = conn.execute(
        text("""SELECT o.request_id FROM pkm_answer_payment_orders o
          JOIN pkm_answer_requests r USING(request_id)
          WHERE r.owner_user_id=:user OR r.requester_user_id=:user
          ORDER BY o.request_id FOR UPDATE OF o"""),
        params,
    ).first()
    history = conn.execute(
        text("""SELECT r.request_id FROM pkm_answer_requests r
          WHERE (r.owner_user_id=:user OR r.requester_user_id=:user)
          AND (r.status IN ('answering','answered') OR EXISTS (
            SELECT 1 FROM pkm_answer_payment_obligations o WHERE o.request_id=r.request_id))
          ORDER BY r.request_id"""),
        params,
    ).first()
    if payment is not None or history is not None:
        raise RuntimeError("ACCOUNT_DELETION_ANSWER_PAYMENT_RECONCILIATION_REQUIRED")
    return True


def erase_unpaid_answer_content(conn: Any, *, user_id: str) -> None:
    if not guard_answer_erasure(conn, user_id=user_id):
        return
    # Scopes and sealed deliveries cascade; no provider-backed order can remain.
    conn.execute(
        text("""DELETE FROM pkm_answer_requests
          WHERE owner_user_id=:user OR requester_user_id=:user"""),
        {"user": user_id},
    )

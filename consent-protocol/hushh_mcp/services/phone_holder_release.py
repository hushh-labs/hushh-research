"""Committed full-account deletion releases a verified phone to the next OTP claim."""

from typing import Any, Iterable

from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash


async def deleted_full_account_holders(conn: Any, user_ids: Iterable[str]) -> set[str]:
    """Return the holders whose full-account deletion is durably admitted.

    A plain read of committed tombstones: it takes no lifecycle advisory lock,
    so a claim that already holds the per-number lock and its identity row
    locks cannot invert the deletion lock order. Provisional phone-orphan
    intents can be cancelled and therefore never release a binding.
    """
    hashes = {account_deletion_user_hash(uid): uid for uid in user_ids if uid}
    if not hashes:
        return set()
    rows = await conn.fetch(
        """SELECT user_id_hash FROM account_deletion_tombstones
        WHERE user_id_hash = ANY($1::text[]) AND cleanup_intent_kind = 'full_account'""",
        list(hashes),
    )
    return {hashes[row["user_id_hash"]] for row in rows}

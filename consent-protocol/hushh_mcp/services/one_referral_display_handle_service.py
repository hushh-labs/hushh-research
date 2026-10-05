"""Opt-in referral leaderboard display handles (migration 273).

Owns `one_referral_display_handles`. This is the ONLY source a leaderboard
read may use for a referrer's public name. `actor_identity_cache.display_name`
(the real/account name) must never be substituted here, including as a
fallback -- a referrer who has not set a handle has no public leaderboard
identity at all, and callers render that as an anonymous placeholder.
"""

from __future__ import annotations

from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.operons.referral.handle import is_valid_handle, normalize_handle

ANONYMOUS_PLACEHOLDER = "Anonymous referrer"


class DisplayHandleError(RuntimeError):
    """A display handle could not be set."""


class DisplayHandleTaken(DisplayHandleError):
    """Another account already holds this handle."""


def get_display_handle(user_id: str) -> str | None:
    with get_db_connection() as connection:
        row = connection.execute(
            text("SELECT handle FROM one_referral_display_handles WHERE user_id = :uid"),
            {"uid": user_id},
        ).fetchone()
    return row.handle if row else None


def set_display_handle(user_id: str, raw_handle: str) -> str:
    """Set or change this user's own public leaderboard handle.

    Idempotent for the exact same handle; raises DisplayHandleTaken if
    another account already holds the normalized form, and never silently
    appends a suffix to make it fit -- the chooser decides their own handle,
    or gets a clear rejection.
    """
    normalized = normalize_handle(raw_handle)
    if not is_valid_handle(normalized):
        raise DisplayHandleError("invalid display handle")

    with get_db_connection() as connection:
        try:
            connection.execute(
                text(
                    """
                    INSERT INTO one_referral_display_handles (user_id, handle, normalized_handle)
                    VALUES (:uid, :handle, :normalized)
                    ON CONFLICT (user_id) DO UPDATE
                      SET handle = EXCLUDED.handle,
                          normalized_handle = EXCLUDED.normalized_handle,
                          updated_at = NOW()
                    """
                ),
                {"uid": user_id, "handle": raw_handle.strip(), "normalized": normalized},
            )
        except Exception as exc:  # noqa: BLE001 -- unique violation on normalized_handle
            if "one_referral_display_handles_normalized_key" in str(exc):
                raise DisplayHandleTaken("this handle is already taken") from None
            raise

    return raw_handle.strip()


def get_display_handles(user_ids: list) -> dict:
    """Bulk lookup for rendering a page of leaderboard rows in one query."""
    if not user_ids:
        return {}
    with get_db_connection() as connection:
        rows = connection.execute(
            text(
                "SELECT user_id, handle FROM one_referral_display_handles WHERE user_id = ANY(:uids)"
            ),
            {"uids": list(user_ids)},
        ).fetchall()
    return {row.user_id: row.handle for row in rows}

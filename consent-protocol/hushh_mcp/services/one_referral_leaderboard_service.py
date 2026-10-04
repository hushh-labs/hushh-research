"""Read-side composition for the gamified Referrals dashboard (PR4).

Reads the LATEST published leaderboard snapshot (migration 270) rather than
aggregating `one_referral_score_events` live on every request -- "use shared
snapshots, bounded refresh, and suitable invalidation" is a product
requirement, not an optimization afterthought. Every row is resolved through
`one_referral_display_handle_service`, never `actor_identity_cache`.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.services.one_referral_circle_service import get_team_rankings
from hushh_mcp.services.one_referral_display_handle_service import (
    ANONYMOUS_PLACEHOLDER,
    get_display_handles,
)
from hushh_mcp.services.one_referral_rewards_service import lifetime_qualified_count


def _latest_snapshot(connection) -> tuple[str, datetime] | None:
    row = connection.execute(
        text(
            """
            SELECT snapshot_id, generated_at
              FROM one_referral_leaderboard_snapshots
             ORDER BY generated_at DESC
             LIMIT 1
            """
        )
    ).fetchone()
    return (str(row.snapshot_id), row.generated_at) if row else None


def _handle_or_placeholder(handles: dict, user_id: str) -> str:
    return handles.get(user_id) or ANONYMOUS_PLACEHOLDER


def get_individual_leaderboard(
    *, limit: int = 20, after_rank: int = 0, viewer_user_id: str | None = None
) -> dict:
    """One page of the latest snapshot, plus the viewer's own row if it is
    not already on the page -- "the current user's row remains discoverable
    outside the top ten" is a hard requirement, not a nice-to-have."""
    with get_db_connection() as connection:
        latest = _latest_snapshot(connection)
        if latest is None:
            return {
                "snapshot_generated_at": None,
                "entries": [],
                "viewer": None,
                "stale": True,
            }
        snapshot_id, generated_at = latest

        rows = connection.execute(
            text(
                """
                SELECT user_id, cumulative_points, rank
                  FROM one_referral_leaderboard_snapshot_entries
                 WHERE snapshot_id = CAST(:sid AS UUID) AND rank > :after_rank
                 ORDER BY rank
                 LIMIT :limit
                """
            ),
            {"sid": snapshot_id, "after_rank": after_rank, "limit": limit},
        ).fetchall()

        viewer_row = None
        if viewer_user_id and not any(row.user_id == viewer_user_id for row in rows):
            viewer_row = connection.execute(
                text(
                    """
                    SELECT user_id, cumulative_points, rank
                      FROM one_referral_leaderboard_snapshot_entries
                     WHERE snapshot_id = CAST(:sid AS UUID) AND user_id = :uid
                    """
                ),
                {"sid": snapshot_id, "uid": viewer_user_id},
            ).fetchone()

        page_user_ids = [row.user_id for row in rows]
        if viewer_row is not None:
            page_user_ids.append(viewer_row.user_id)
        handles = get_display_handles(page_user_ids)

    entries = [
        {
            "rank": row.rank,
            "handle": _handle_or_placeholder(handles, row.user_id),
            "points": row.cumulative_points,
            "is_viewer": row.user_id == viewer_user_id,
        }
        for row in rows
    ]
    viewer = (
        {
            "rank": viewer_row.rank,
            "handle": _handle_or_placeholder(handles, viewer_row.user_id),
            "points": viewer_row.cumulative_points,
            "is_viewer": True,
        }
        if viewer_row is not None
        else None
    )

    return {
        "snapshot_generated_at": generated_at.isoformat(),
        "entries": entries,
        "viewer": viewer,
        "stale": False,
    }


def get_circle_leaderboard(limit: int = 20) -> list[dict]:
    return get_team_rankings(limit=limit)


def get_milestone_progress(user_id: str, *, settings_milestones: list) -> dict:
    """This user's lifetime count, earned merchandise, and the next unearned
    milestone with progress toward it. Never claims a milestone is earned
    without a matching entitlement row -- this reads
    one_referral_milestone_entitlements, it does not recompute eligibility."""
    with get_db_connection() as connection:
        lifetime_count = lifetime_qualified_count(connection, user_id)
        earned_rows = connection.execute(
            text(
                """
                SELECT milestone_key, reward, earned_at
                  FROM one_referral_milestone_entitlements
                 WHERE user_id = :uid
                 ORDER BY earned_at
                """
            ),
            {"uid": user_id},
        ).fetchall()

    earned_keys = frozenset(row.milestone_key for row in earned_rows)
    earned = [
        {
            "milestone_key": row.milestone_key,
            "reward": row.reward,
            "earned_at": row.earned_at.isoformat(),
        }
        for row in earned_rows
    ]

    next_milestone = None
    for entry in settings_milestones or []:
        if not isinstance(entry, dict):
            continue
        key = entry.get("milestone_key")
        threshold = entry.get("threshold")
        if key in earned_keys or not isinstance(threshold, int):
            continue
        if next_milestone is None or threshold < next_milestone["threshold"]:
            next_milestone = {
                "milestone_key": key,
                "threshold": threshold,
                "reward": entry.get("reward"),
                "progress": min(lifetime_count, threshold),
            }

    return {
        "lifetime_qualified_count": lifetime_count,
        "earned": earned,
        "next_milestone": next_milestone,
    }

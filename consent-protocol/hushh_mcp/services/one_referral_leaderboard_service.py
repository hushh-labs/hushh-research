"""Read-side composition for the gamified Referrals dashboard (PR4).

Reads the LATEST published leaderboard snapshot (migration 271) rather than
aggregating `one_referral_score_events` live on every request -- "use shared
snapshots, bounded refresh, and suitable invalidation" is a product
requirement, not an optimization afterthought. Public aliases retain priority;
other profile names are resolved through the viewer-permitted directory.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.operons.referral_scoring.points import (
    is_within_a_flash_window,
)
from hushh_mcp.services.one_referral_circle_service import get_team_rankings
from hushh_mcp.services.one_referral_display_handle_service import (
    ANONYMOUS_PLACEHOLDER,
    get_display_handles,
)
from hushh_mcp.services.one_referral_identity_service import get_leaderboard_profiles
from hushh_mcp.services.one_referral_rewards_service import (
    lifetime_joined_count,
    lifetime_qualified_count,
)


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
    *,
    limit: int = 20,
    after_rank: int = 0,
    viewer_user_id: str | None = None,
    snapshot_id: str | None = None,
) -> dict:
    """One page of the latest snapshot, plus the viewer's own row if it is
    not already on the page -- "the current user's row remains discoverable
    outside the top ten" is a hard requirement, not a nice-to-have."""
    if snapshot_id is None:
        # Live standings must also work before the first scheduler publication.
        # Publication is shared, serialized and reuses an unchanged snapshot.
        from hushh_mcp.services.one_referral_scoring_service import publish_leaderboard_snapshot

        publish_leaderboard_snapshot()
    with get_db_connection() as connection:
        if snapshot_id:
            selected = connection.execute(
                text(
                    "SELECT snapshot_id,generated_at FROM one_referral_leaderboard_snapshots WHERE snapshot_id=CAST(:sid AS UUID)"
                ),
                {"sid": snapshot_id},
            ).fetchone()
            latest = (str(selected.snapshot_id), selected.generated_at) if selected else None
        else:
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

    profiles = get_leaderboard_profiles(
        [uid for uid in page_user_ids if not handles.get(uid)],
        viewer_user_id=viewer_user_id,
    )
    entries = [
        {
            "rank": row.rank,
            "handle": _handle_or_placeholder(handles, row.user_id),
            "display_name": profiles.get(row.user_id, {}).get("display_name"),
            "photo_url": profiles.get(row.user_id, {}).get("photo_url"),
            "points": row.cumulative_points,
            "is_viewer": row.user_id == viewer_user_id,
        }
        for row in rows
    ]
    viewer = (
        {
            "rank": viewer_row.rank,
            "handle": _handle_or_placeholder(handles, viewer_row.user_id),
            "display_name": profiles.get(viewer_row.user_id, {}).get("display_name"),
            "photo_url": profiles.get(viewer_row.user_id, {}).get("photo_url"),
            "points": viewer_row.cumulative_points,
            "is_viewer": True,
        }
        if viewer_row is not None
        else None
    )

    return {
        "snapshot_id": snapshot_id,
        "next_after_rank": entries[-1]["rank"] if len(entries) == limit else None,
        "snapshot_generated_at": generated_at.isoformat(),
        "entries": entries,
        "viewer": viewer,
        "stale": (datetime.now(timezone.utc) - generated_at).total_seconds() > 300,
    }


def get_circle_leaderboard(limit: int = 20) -> list[dict]:
    return get_team_rankings(limit=limit)


def get_milestone_progress(user_id: str, *, settings_milestones: list) -> dict:
    """This user's lifetime count, earned merchandise, and the next unearned
    milestone with progress toward it. Never claims a milestone is earned
    without a matching entitlement row -- this reads
    one_referral_milestone_entitlements, it does not recompute eligibility."""
    with get_db_connection() as connection:
        lifetime_count = lifetime_joined_count(connection, user_id)
        qualified_count = lifetime_qualified_count(connection, user_id)
        earned_rows = connection.execute(
            text(
                """
                SELECT e.milestone_key, e.reward, e.earned_at, e.claimed_at, f.status AS fulfillment_status
                  FROM one_referral_milestone_entitlements e
                  LEFT JOIN one_referral_fulfillment_records f ON f.entitlement_id=e.id
                 WHERE e.user_id = :uid
                 ORDER BY e.earned_at
                """
            ),
            {"uid": user_id},
        ).fetchall()

    earned = [
        {
            "milestone_key": row.milestone_key,
            "reward": row.reward,
            "earned_at": row.earned_at.isoformat(),
            "claimed_at": row.claimed_at.isoformat() if row.claimed_at else None,
            "fulfillment_status": row.fulfillment_status,
        }
        for row in earned_rows
    ]

    earned_keys = frozenset(row.milestone_key for row in earned_rows)
    next_milestone = None
    for entry in settings_milestones or []:
        if not isinstance(entry, dict):
            continue
        key = entry.get("milestone_key")
        threshold = entry.get("threshold")
        if key in earned_keys or not isinstance(threshold, int) or threshold <= lifetime_count:
            continue
        if next_milestone is None or threshold < next_milestone["threshold"]:
            next_milestone = {
                "milestone_key": key,
                "threshold": threshold,
                "reward": entry.get("reward"),
                "progress": min(lifetime_count, threshold),
            }

    return {
        "joined_referral_count": lifetime_count,
        "lifetime_qualified_count": qualified_count,
        "progress_basis": "joined_referrals",
        "earned": earned,
        "next_milestone": next_milestone,
    }


def _soonest_ending_active_window(now: datetime, flash_windows: list) -> datetime | None:
    soonest: datetime | None = None
    for window in flash_windows or []:
        if not isinstance(window, dict):
            continue
        try:
            start = datetime.fromisoformat(str(window.get("start")))
            end = datetime.fromisoformat(str(window.get("end")))
        except ValueError:
            continue
        if start.tzinfo is None or end.tzinfo is None or end <= start:
            continue
        if start <= now < end and (soonest is None or end < soonest):
            soonest = end
    return soonest


def get_engagement_status(
    user_id: str, *, flash_windows: list, program_timezone: str, run_length_days: int = 3
) -> dict:
    """Streak progress and active flash-window status for the dashboard banner.

    Display-only: the authenticated app-open writer owns streak awards.
    A missed attendance day displays zero without changing earned history.
    """
    from hushh_mcp.services.one_referral_activity_service import get_daily_streak

    now = datetime.now(timezone.utc)
    return {
        "streak": {
            **get_daily_streak(user_id, program_timezone),
            "run_length_days": run_length_days,
        },
        "flash": {
            "active": is_within_a_flash_window(now, flash_windows),
            "ends_at": end.isoformat()
            if (end := _soonest_ending_active_window(now, flash_windows))
            else None,
        },
    }

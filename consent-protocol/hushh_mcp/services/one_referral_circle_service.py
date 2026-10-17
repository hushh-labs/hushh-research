"""Weekly metadata competition over canonical Circles and qualified referrals.

Postgres owns selection uniqueness, immutable credit and transaction ordering.
Reads derive scores from that ledger, never from today's Circle roster. A future
cache/notification adapter may replace read delivery, not this write authority.
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.services.account_deletion_lifecycle_service import AccountDeletionLifecycleService
from hushh_mcp.services.one_referral_challenge_service import get_challenge_status


class CircleWarsError(ValueError):
    def __init__(self, code: str, status: int):
        self.code = code
        self.status = status
        super().__init__(code)


def _period(connection, week: str | None = None) -> dict:
    current = week is None
    # The round resolver and this DB read can straddle the weekly cutoff.
    # Retry only current-round reads; explicit history must stay on its round.
    for _ in range(2):
        if current:
            challenge = get_challenge_status()
            if not challenge.get("calendar_active"):
                raise CircleWarsError("COMPETITION_NOT_CONFIGURED", 503)
            week = challenge["round_id"]
        row = connection.execute(
            text("""
      SELECT id,started_at,cutoff_at,timezone,status,clock_timestamp() AS now
      FROM one_referral_reward_rounds WHERE id=CAST(:rid AS UUID)
        AND started_at<=clock_timestamp()
    """),
            {"rid": str(week)},
        ).fetchone()
        if row is None:
            raise CircleWarsError("INVALID_COMPETITION_WEEK", 422)
        if not current or row.now < row.cutoff_at:
            break
    else:
        raise CircleWarsError("COMPETITION_WEEK_CHANGED", 503)
    return {
        "round_id": str(row.id),
        "status": row.status,
        "week_start": row.started_at.astimezone(ZoneInfo(row.timezone)).date().isoformat(),
        "starts_at": row.started_at.isoformat(),
        "ends_at": row.cutoff_at.isoformat(),
        "timezone": row.timezone,
        "server_now": row.now.isoformat(),
        "seconds_remaining": max(0, int((row.cutoff_at - row.now).total_seconds())),
    }


# Rank is independent of the requested page. Equal scores are ordered by the
# first team to reach the score, then first opt-in and Circle id. LAG uses the
# identical order so rank-gap copy is derived from the same snapshot.
_STANDINGS = """
WITH teams AS (
  SELECT circle_id, count(*)::int AS participants, min(selected_at) AS first_opt_in
    FROM one_referral_circle_selections
   WHERE round_id = CAST(:week AS UUID)
   GROUP BY circle_id
), scores AS (
  SELECT cr.circle_id, count(*)::int AS score, max(cr.contributed_at) AS reached_at
    FROM one_referral_circle_contributions cr
    JOIN one_referral_relationships r ON r.id = cr.relationship_id AND r.status = 'qualified'
   WHERE cr.round_id = CAST(:week AS UUID)
   GROUP BY cr.circle_id
), totals AS (
  SELECT t.*, coalesce(s.score, 0) AS score, s.reached_at
    FROM teams t LEFT JOIN scores s USING (circle_id)
), ranked AS (
  SELECT *, row_number() OVER ordering AS rank,
         lag(score) OVER ordering AS next_score,
         max(score) OVER () AS top_score,
         count(*) OVER () AS total_teams
    FROM totals
    WINDOW ordering AS (ORDER BY score DESC, reached_at ASC NULLS LAST, first_opt_in, circle_id)
)
SELECT ranked.*, alias.team_key,
       CASE WHEN m.status = 'active' AND c.status = 'active'
                  AND (c.system_kind IS DISTINCT FROM 'trusted' OR c.owner_user_id = :uid)
            THEN c.name ELSE NULL END AS authorized_name,
       EXISTS(SELECT 1 FROM one_referral_circle_selections p
               WHERE p.round_id = CAST(:week AS UUID) AND p.user_id = :uid
                 AND p.circle_id = ranked.circle_id) AS is_yours
  FROM ranked
  JOIN one_referral_circle_teams alias ON alias.round_id = CAST(:week AS UUID) AND alias.circle_id = ranked.circle_id
  JOIN one_location_circles c ON c.id = ranked.circle_id
  LEFT JOIN one_location_circle_memberships m ON m.circle_id = ranked.circle_id AND m.user_id = :uid
"""


def _entry(row, week: str) -> dict:
    key = str(row.team_key)
    authorized = row.authorized_name is not None
    return {
        "team_key": key,
        "circle_id": str(row.circle_id) if authorized else None,
        "name": row.authorized_name if authorized else f"Circle {key[:6]}",
        "anonymous": not authorized,
        "rank": int(row.rank),
        "participating_members": row.participants,
        "qualified_referrals": row.score,
        "is_your_circle": row.is_yours,
        "next_rank": int(row.rank) - 1 if row.next_score is not None else None,
        "referrals_to_next_rank": row.next_score - row.score + 1
        if row.next_score is not None
        else None,
        "relative_progress": row.score / row.top_score if row.top_score else 0,
    }


def _state(connection, user_id: str, period: dict) -> dict:
    params = {"week": period["round_id"], "uid": user_id}
    participation = connection.execute(
        text("""
        SELECT circle_id, selected_at FROM one_referral_circle_selections
         WHERE round_id = CAST(:week AS UUID) AND user_id = :uid
    """),
        params,
    ).fetchone()
    team = None
    if participation:
        row = connection.execute(
            text(_STANDINGS + " WHERE ranked.circle_id = CAST(:circle AS UUID)"),
            {**params, "circle": str(participation.circle_id)},
        ).fetchone()
        team = _entry(row, period["week_start"]) if row else None
    return {
        "period": period,
        "participation": {
            "status": "active",
            "opted_in_at": participation.selected_at.isoformat(),
            "team": team,
        }
        if participation
        else None,
    }


def get_state(user_id: str, week: str | None = None) -> dict:
    with get_db_connection() as connection:
        return _state(connection, user_id, _period(connection, week))


def opt_in(user_id: str, circle_id: str) -> dict:
    from hushh_mcp.services.one_referral_service import get_active_policy

    get_active_policy()
    # Resolve/create the existing calendar outside the locking transaction.
    challenge = get_challenge_status()
    if not challenge.get("calendar_active"):
        raise CircleWarsError("COMPETITION_NOT_CONFIGURED", 503)
    with get_db_connection() as connection:
        AccountDeletionLifecycleService.lock_user_writes_in_transaction(
            connection, user_ids=(user_id,)
        )
        connection.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended('one-circle-wars:' || :uid, 0))"),
            {"uid": user_id},
        )
        circle = connection.execute(
            text("""
          SELECT id FROM one_location_circles WHERE id=CAST(:cid AS UUID) AND status='active'
           AND (system_kind IS DISTINCT FROM 'trusted' OR owner_user_id=:uid) FOR SHARE
        """),
            {"cid": circle_id, "uid": user_id},
        ).fetchone()
        member = connection.execute(
            text("""
          SELECT 1 FROM one_location_circle_memberships
           WHERE circle_id=CAST(:cid AS UUID) AND user_id=:uid AND status='active' FOR SHARE
        """),
            {"cid": circle_id, "uid": user_id},
        ).fetchone()
        if not circle or not member:
            raise CircleWarsError("CIRCLE_MEMBERSHIP_REQUIRED", 403)
        period = _period(connection, challenge["round_id"])
        if period["status"] != "scheduled" or datetime.fromisoformat(
            period["server_now"]
        ) >= datetime.fromisoformat(period["ends_at"]):
            raise CircleWarsError("COMPETITION_WEEK_ENDED", 409)
        params = {
            "week": period["round_id"],
            "uid": user_id,
            "cid": circle_id,
            "now": period["server_now"],
            "end": period["ends_at"],
        }
        # Legacy intervals never become opt-in consent. Close only legacy open
        # selections; fixed weekly intervals are already bounded by cutoff.
        connection.execute(
            text("""
          UPDATE one_referral_circle_selections SET ended_at=CAST(:now AS TIMESTAMPTZ)
           WHERE user_id=:uid AND ended_at IS NULL AND round_id IS NULL
        """),
            params,
        )
        connection.execute(
            text("""
          INSERT INTO one_referral_circle_teams(round_id,circle_id)
           VALUES(CAST(:week AS UUID),CAST(:cid AS UUID)) ON CONFLICT DO NOTHING
        """),
            params,
        )
        connection.execute(
            text("""
          INSERT INTO one_referral_circle_selections(user_id,circle_id,round_id,selected_at,ended_at)
           VALUES(:uid,CAST(:cid AS UUID),CAST(:week AS UUID),CAST(:now AS TIMESTAMPTZ),CAST(:end AS TIMESTAMPTZ))
           ON CONFLICT (round_id,user_id) WHERE round_id IS NOT NULL DO NOTHING
        """),
            params,
        )
        selected = connection.execute(
            text("""
          SELECT circle_id FROM one_referral_circle_selections
           WHERE round_id=CAST(:week AS UUID) AND user_id=:uid
        """),
            params,
        ).scalar_one()
        if str(selected) != circle_id:
            raise CircleWarsError("CIRCLE_ALREADY_SELECTED_THIS_WEEK", 409)
        return _state(connection, user_id, period)


def get_leaderboard(
    user_id: str, *, week: str | None = None, limit: int = 25, offset: int = 0
) -> dict:
    if not 1 <= limit <= 100 or not 0 <= offset <= 2147483647:
        raise CircleWarsError("INVALID_LEADERBOARD_PAGE", 422)
    with get_db_connection() as connection:
        period = _period(connection, week)
        params = {"week": period["round_id"], "uid": user_id, "limit": limit, "offset": offset}
        rows = connection.execute(
            text(_STANDINGS + " ORDER BY rank LIMIT :limit OFFSET :offset"), params
        ).fetchall()
        # Empty pages still report total count, so pagination never fabricates a
        # zero-team state when the caller has reached the end.
        total = (
            int(rows[0].total_teams)
            if rows
            else connection.execute(
                text("""
            SELECT count(DISTINCT circle_id) FROM one_referral_circle_selections
             WHERE round_id = CAST(:week AS UUID)
        """),
                params,
            ).scalar_one()
        )
        return {
            "period": period,
            "teams": [_entry(row, period["week_start"]) for row in rows],
            "total_teams": total,
            "limit": limit,
            "offset": offset,
            "has_more": offset + len(rows) < total,
        }


def get_circle_stats(user_id: str, circle_id: str, week: str | None = None) -> dict:
    with get_db_connection() as connection:
        period = _period(connection, week)
        row = connection.execute(
            text(_STANDINGS + " WHERE ranked.circle_id = CAST(:circle AS UUID)"),
            {"week": period["round_id"], "uid": user_id, "circle": circle_id},
        ).fetchone()
        if not row or row.authorized_name is None:
            raise CircleWarsError("CIRCLE_STATS_UNAVAILABLE", 404)
        return {"period": period, "team": _entry(row, period["week_start"])}


def resolve_contributing_circle(
    connection, *, user_id: str, as_of: datetime, relationship_id: str | None = None
) -> str | None:
    if relationship_id is None:
        return None
    row = connection.execute(
        text("""
      SELECT s.circle_id FROM one_referral_scoring_jobs j
      JOIN one_referral_circle_selections s ON s.id=j.circle_selection_id
      WHERE j.relationship_id=CAST(:rid AS UUID) AND j.user_id=:uid
       AND s.user_id=:uid AND s.round_id IS NOT NULL
       AND s.selected_at<=:at AND s.ended_at>:at
    """),
        {"rid": relationship_id, "uid": user_id, "at": as_of},
    ).fetchone()
    return str(row.circle_id) if row else None


def record_circle_contribution(
    connection, *, relationship_id: str, user_id: str, circle_id: str, contributed_at: datetime
) -> None:
    connection.execute(
        text("""
      INSERT INTO one_referral_circle_contributions
        (relationship_id,user_id,circle_id,contributed_at,round_id,selection_id)
      SELECT j.relationship_id,s.user_id,s.circle_id,:at,s.round_id,s.id
      FROM one_referral_scoring_jobs j
      JOIN one_referral_circle_selections s ON s.id=j.circle_selection_id
      WHERE j.relationship_id=CAST(:rid AS UUID) AND j.user_id=:uid AND s.user_id=:uid
       AND s.circle_id=CAST(:cid AS UUID) AND s.round_id IS NOT NULL
       AND s.selected_at<=:at AND s.ended_at>:at
      ON CONFLICT (relationship_id) DO NOTHING
    """),
        {"rid": relationship_id, "uid": user_id, "cid": circle_id, "at": contributed_at},
    )


def get_team_rankings(limit: int = 100) -> list[dict]:
    """Compatibility reader: only weekly, privacy-safe aliases are public."""
    return [
        {
            "circle_id": team["team_key"],
            "circle_name": team["name"],
            "contribution_count": team["qualified_referrals"],
            "rank": team["rank"],
        }
        for team in get_leaderboard("", limit=limit)["teams"]
    ]

"""Referral-contest team selection and team standings (migration 271).

Owns `one_referral_circle_selections` and `one_referral_circle_contributions`.
Reads `one_location_circles` / `one_location_circle_memberships` for identity
and accepted-membership checks only -- this module never writes to either,
per the product spec's explicit prohibition on contest participation
altering circle capacity or introducing additional data access to Location
Circles.

A person's referral-contest team is a single, exclusive, interval-tracked
selection: `select_competition_circle` closes the current open interval (if
any) and opens a new one. `resolve_contributing_circle` is the event-time
lookup the scoring worker uses so a later team switch can never retroactively
move an already-settled relationship's team credit.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import text

from db.db_client import get_db_connection

logger = logging.getLogger(__name__)


class CircleSelectionError(RuntimeError):
    """A circle selection could not be completed."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class CircleSelection:
    id: str
    circle_id: str
    selected_at: datetime


def _is_accepted_member(connection, *, user_id: str, circle_id: str) -> bool:
    row = connection.execute(
        text(
            """
            SELECT 1
              FROM one_location_circle_memberships
             WHERE circle_id = CAST(:cid AS UUID)
               AND user_id = :uid
               AND status = 'active'
             LIMIT 1
            """
        ),
        {"cid": circle_id, "uid": user_id},
    ).fetchone()
    return row is not None


def get_active_circle_selection(user_id: str) -> CircleSelection | None:
    with get_db_connection() as connection:
        row = connection.execute(
            text(
                """
                SELECT id, circle_id, selected_at
                  FROM one_referral_circle_selections
                 WHERE user_id = :uid AND ended_at IS NULL
                 LIMIT 1
                """
            ),
            {"uid": user_id},
        ).fetchone()
    if row is None:
        return None
    return CircleSelection(
        id=str(row.id), circle_id=str(row.circle_id), selected_at=row.selected_at
    )


def select_competition_circle(user_id: str, circle_id: str) -> CircleSelection:
    """Make `circle_id` this user's one active referral-contest team.

    Requires the user already be an ACCEPTED (`status = 'active'`) member of
    that Location Circle -- selection never grants membership, never changes
    capacity, and never reads or writes anything else about the circle.
    Re-selecting the circle that is already active is a no-op that returns
    the existing, unchanged selection rather than opening a redundant
    interval.
    """
    with get_db_connection() as connection:
        if not _is_accepted_member(connection, user_id=user_id, circle_id=circle_id):
            raise CircleSelectionError("not an accepted member of this circle")

        current = connection.execute(
            text(
                """
                SELECT id, circle_id, selected_at
                  FROM one_referral_circle_selections
                 WHERE user_id = :uid AND ended_at IS NULL
                 LIMIT 1
                   FOR UPDATE
                """
            ),
            {"uid": user_id},
        ).fetchone()

        if current is not None and str(current.circle_id) == str(circle_id):
            return CircleSelection(
                id=str(current.id),
                circle_id=str(current.circle_id),
                selected_at=current.selected_at,
            )

        now = _now()
        if current is not None:
            connection.execute(
                text(
                    """
                    UPDATE one_referral_circle_selections
                       SET ended_at = :now
                     WHERE id = CAST(:sid AS UUID)
                    """
                ),
                {"now": now, "sid": current.id},
            )

        created = connection.execute(
            text(
                """
                INSERT INTO one_referral_circle_selections (user_id, circle_id, selected_at)
                VALUES (:uid, CAST(:cid AS UUID), :now)
                RETURNING id, circle_id, selected_at
                """
            ),
            {"uid": user_id, "cid": circle_id, "now": now},
        ).fetchone()

    return CircleSelection(
        id=str(created.id), circle_id=str(created.circle_id), selected_at=created.selected_at
    )


def resolve_contributing_circle(connection, *, user_id: str, as_of: datetime) -> str | None:
    """Which team, if any, covered this user at `as_of`.

    Called with the SAME connection the scoring worker is already using, so
    the lookup is part of that job's one settling transaction. Returns None
    when no selection interval covers `as_of` -- circle participation is
    optional, and a relationship simply gets no team contribution in that
    case rather than an error.
    """
    row = connection.execute(
        text(
            """
            SELECT circle_id
              FROM one_referral_circle_selections
             WHERE user_id = :uid
               AND selected_at <= :as_of
               AND (ended_at IS NULL OR ended_at > :as_of)
             LIMIT 1
            """
        ),
        {"uid": user_id, "as_of": as_of},
    ).fetchone()
    return str(row.circle_id) if row else None


def record_circle_contribution(
    connection, *, relationship_id: str, user_id: str, circle_id: str, contributed_at: datetime
) -> None:
    """Settle this relationship's team credit, once, forever.

    Idempotent via the unique index on relationship_id: calling this twice
    for the same relationship (a reprocessed job) writes nothing the second
    time.
    """
    connection.execute(
        text(
            """
            INSERT INTO one_referral_circle_contributions
              (relationship_id, user_id, circle_id, contributed_at)
            VALUES
              (CAST(:rid AS UUID), :uid, CAST(:cid AS UUID), :contributed_at)
            ON CONFLICT (relationship_id) DO NOTHING
            """
        ),
        {
            "rid": relationship_id,
            "uid": user_id,
            "cid": circle_id,
            "contributed_at": contributed_at,
        },
    )


def get_team_rankings(limit: int = 100) -> list[dict]:
    """Cumulative RAW qualified-referral count per team, ranked descending.

    Never bonus points -- "team scores are cumulative raw qualified
    referrals, not bonus points" is enforced by reading COUNT(*) over
    one_referral_circle_contributions, which carries no points column at all.
    """
    with get_db_connection() as connection:
        rows = connection.execute(
            text(
                """
                SELECT c.circle_id, cl.name AS circle_name, COUNT(*) AS contribution_count
                  FROM one_referral_circle_contributions c
                  JOIN one_location_circles cl ON cl.id = c.circle_id
                 GROUP BY c.circle_id, cl.name
                 ORDER BY contribution_count DESC, c.circle_id
                 LIMIT :limit
                """
            ),
            {"limit": limit},
        ).fetchall()
    return [
        {
            "circle_id": str(row.circle_id),
            "circle_name": row.circle_name,
            "contribution_count": int(row.contribution_count),
        }
        for row in rows
    ]

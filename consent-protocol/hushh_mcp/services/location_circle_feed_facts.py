"""Immutable membership incarnation facts, without exposing internal member IDs."""

from datetime import UTC, datetime
from hashlib import sha256
from typing import Any
from uuid import UUID

from sqlalchemy import text


def membership_facts(conn: Any, *, circle: str, member: str) -> dict[str, str]:
    try:
        UUID(circle)
    except (ValueError, TypeError):
        return {}
    row = conn.execute(
        text("""SELECT m.joined_at,c.name FROM one_location_circle_memberships m
      JOIN one_location_circles c ON c.id=m.circle_id WHERE m.circle_id=CAST(:circle AS UUID)
      AND m.user_id=:member"""),
        {"circle": circle, "member": member},
    ).fetchone()
    if not row:
        return {}
    row = dict(row._mapping if hasattr(row, "_mapping") else row)
    return {
        "circle_id": circle,
        "circle_name": str(row["name"])[:160],
        "membership_key": membership_key(circle, member, row["joined_at"]),
    }


def sms_membership_facts(conn: Any, *, owner: str, member: str) -> dict[str, str]:
    row = conn.execute(
        text(
            "SELECT id FROM one_location_circles WHERE owner_user_id=:owner AND system_kind='sms'"
        ),
        {"owner": owner},
    ).fetchone()
    if row is not None:
        row = dict(row._mapping if hasattr(row, "_mapping") else row)
    return membership_facts(conn, circle=str(row["id"]), member=member) if row else {}


def membership_key(circle: str, member: str, joined: datetime) -> str:
    elapsed = joined.astimezone(UTC) - datetime(1970, 1, 1, tzinfo=UTC)
    micros = (elapsed.days * 86400 + elapsed.seconds) * 1000000 + elapsed.microseconds
    return sha256(f"one.circle.membership:{circle}:{member}:{micros}".encode()).hexdigest()

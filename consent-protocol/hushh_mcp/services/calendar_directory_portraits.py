"""Visible HUSSH profiles (name and portrait) for people in an owner's Calendar events."""

from __future__ import annotations

import asyncio
from collections import Counter
from typing import Any, Protocol

from hushh_mcp.services.directory_identity_service import verified_directory_emails
from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

MAX_PORTRAIT_EMAILS = 100


class InvitationReader(Protocol):
    async def invitations(self, *, user_id: str, **window: Any) -> dict[str, Any]: ...


class InvitationWindow(Protocol):
    def model_dump(self, *, exclude: set[str], exclude_none: bool) -> dict[str, Any]: ...


def _event_emails(events: object) -> list[str]:
    if not isinstance(events, list):
        return []
    emails: set[str] = set()
    for event in events:
        if not isinstance(event, dict):
            continue
        attendees = event.get("attendees")
        people = [event.get("organizer"), *(attendees if isinstance(attendees, list) else [])]
        for person in people:
            if not isinstance(person, dict):
                continue
            email = person.get("email")
            if not isinstance(email, str):
                continue
            normalized = email.strip().lower()
            if (
                3 <= len(normalized) <= 320
                and normalized.count("@") == 1
                and not any(char.isspace() for char in normalized)
            ):
                emails.add(normalized)
            if len(emails) >= MAX_PORTRAIT_EMAILS:
                return sorted(emails)
    return sorted(emails)


def _profile(row: dict[str, Any]) -> dict[str, str | None] | None:
    """The same name and photo Connect shows; either may be absent, never both."""
    name = row.get("displayName")
    photo = row.get("photoUrl")
    display_name = name.strip() if isinstance(name, str) else ""
    photo_url = photo if isinstance(photo, str) else ""
    if not display_name and not photo_url:
        return None
    return {
        "userId": str(row["userId"]),
        "displayName": display_name or None,
        "photoUrl": photo_url or None,
    }


def _visible_portraits(owner_user_id: str, emails: list[str]) -> dict[str, dict[str, str | None]]:
    page = OneLocationAgentService().search_directory_candidates(
        owner_user_id=owner_user_id,
        verified_email_lookup=emails,
        limit=MAX_PORTRAIT_EMAILS,
    )
    if page.get("hasMore"):
        # A partial page cannot prove an address has only one visible owner.
        return {}
    rows = page.get("items") or []
    current_emails = verified_directory_emails(
        [str(row.get("userId")) for row in rows if isinstance(row, dict) and row.get("userId")]
    )
    counts = Counter(
        str(row.get("email") or "").strip().lower() for row in rows if isinstance(row, dict)
    )
    allowed = set(emails)
    return {
        email: profile
        for row in rows
        if isinstance(row, dict)
        if (email := str(row.get("email") or "").strip().lower()) in allowed
        and counts[email] == 1
        and row.get("userId")
        and current_emails.get(str(row["userId"])) == email
        and (profile := _profile(row))
    }


async def calendar_directory_portraits(
    *, owner_user_id: str, events: object
) -> dict[str, dict[str, str | None]]:
    """Enrich an owner read without letting a profile lookup block Calendar."""
    emails = _event_emails(events)
    if not owner_user_id or not emails:
        return {}
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_visible_portraits, owner_user_id, emails), timeout=4.0
        )
    except Exception:
        return {}


async def invitation_response_with_portraits(
    owner_user_id: str, schedule: InvitationReader, window: InvitationWindow
) -> dict[str, Any]:
    """Add owner-scoped portrait projection without changing the agent read."""
    result = await schedule.invitations(
        user_id=owner_user_id,
        **window.model_dump(exclude={"account_id"}, exclude_none=True),
    )
    return {
        **result,
        "people": await calendar_directory_portraits(
            owner_user_id=owner_user_id, events=result.get("events")
        ),
    }

"""Visible HUSSH portraits for people in an owner's fetched Calendar events."""

from __future__ import annotations

import asyncio
from collections import Counter

from hushh_mcp.services.directory_identity_service import verified_directory_emails
from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

MAX_PORTRAIT_EMAILS = 100


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


def _visible_portraits(owner_user_id: str, emails: list[str]) -> dict[str, dict[str, str]]:
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
        email: {"userId": str(row["userId"]), "photoUrl": str(row["photoUrl"])}
        for row in rows
        if isinstance(row, dict)
        if (email := str(row.get("email") or "").strip().lower()) in allowed
        and counts[email] == 1
        and row.get("userId")
        and current_emails.get(str(row["userId"])) == email
        and isinstance(row.get("photoUrl"), str)
        and row["photoUrl"]
    }


async def calendar_directory_portraits(
    *, owner_user_id: str, events: object
) -> dict[str, dict[str, str]]:
    """Enrich an owner read without letting a photo lookup block Calendar."""
    emails = _event_emails(events)
    if not owner_user_id or not emails:
        return {}
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_visible_portraits, owner_user_id, emails), timeout=4.0
        )
    except Exception:
        return {}

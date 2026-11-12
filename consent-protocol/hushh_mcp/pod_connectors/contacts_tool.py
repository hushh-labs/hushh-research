"""One's Contacts tool inside the owner's own agent (``google_people`` does the read).

The tool module itself loads anywhere so a roster can name it, but the reader it
calls refuses to load outside an owner-cloud agent, and the tool refuses any call
that is not the owner's own typed chat in that agent.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from email.errors import HeaderParseError
from email.headerregistry import Address
from typing import Any

from google.adk.tools.tool_context import ToolContext
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from hushh_mcp.one_adk.request_secrets import (
    _PREFIX as REQUEST_SECRET_PREFIX,
)
from hushh_mcp.one_adk.request_secrets import (
    consume_request_secret,
    resolve_request_secret,
    store_request_secret,
)

STATE_CONTACT_ATTENDEE_OFFER = "hussh:contact_attendee_offer"
STATE_CONTACT_CALENDAR_READ = "temp:one_contact_calendar_read"
_OFFER_TTL_SECONDS = 300


class _ContactAttendeeOffer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    owner_id: str = Field(min_length=1, max_length=256)
    conversation_id: str = Field(min_length=1, max_length=256)
    grant_binding: tuple[str, ...] = Field(min_length=4, max_length=64)
    emails: list[str] = Field(min_length=1, max_length=25)
    groups: list[tuple[int, int]] = Field(default_factory=list, max_length=5)


def _conversation_id(tool_context: ToolContext) -> str:
    return str(tool_context.state.get("hussh:conversation_id") or "").strip()


def calendar_guest_choices(people: list[dict[str, Any]]) -> list[dict[str, Any]]:
    choices: list[dict[str, Any]] = []
    seen: set[str] = set()
    for person in people:
        for email in person["emails"]:
            if (
                not email
                or len(email) > 320
                or any(ch.isspace() or not ch.isprintable() for ch in email)
            ):
                continue
            try:
                address = Address(addr_spec=email)
            except (ValueError, IndexError, HeaderParseError):
                continue
            if not address.username or not address.domain or address.addr_spec != email:
                continue
            key = f"{address.username}@{address.domain.casefold()}"
            if key in seen:
                continue
            seen.add(key)
            name = person["name"]
            choices.append(
                {
                    "ordinal": len(choices) + 1,
                    "name": name if "@" not in name else "",
                    "mailbox_hint": f"{address.username[:1]}… ({address.domain})",
                    "email": email,
                }
            )
            if len(choices) == 25:
                return choices
    return choices


async def resolve_calendar_contact_attendees(
    tool_context: ToolContext, ordinals: list[int]
) -> tuple[list[str], tuple[str, ...]] | None:
    """Resolve exact addresses from the current owner's bounded Contacts offer."""
    from hushh_mcp.one_adk.pod_connector_tools import pod_tool_owner

    if tool_context.state.get("temp:one_execution_surface") != "typed_chat":
        return None
    owner = await pod_tool_owner(tool_context, "contacts")
    reference = tool_context.state.get(STATE_CONTACT_ATTENDEE_OFFER)
    if (
        not owner
        or not isinstance(reference, str)
        or not reference.startswith(REQUEST_SECRET_PREFIX)
    ):
        return None
    try:
        offer = _ContactAttendeeOffer.model_validate_json(resolve_request_secret(reference))
        if offer.owner_id != owner or offer.conversation_id != _conversation_id(tool_context):
            return None
        from hushh_mcp.pod_connectors import google_people

        try:
            if google_people.contacts_grant_binding() != offer.grant_binding:
                return None
        except google_people.ContactsUnavailable:
            return None
    except (ImportError, ValidationError):
        return None
    if not 1 <= len(ordinals) <= len(offer.emails) or any(
        type(ordinal) is not int or not 1 <= ordinal <= len(offer.emails) for ordinal in ordinals
    ):
        return None
    if offer.groups and (
        len(ordinals) != len(offer.groups)
        or any(
            sum(first <= ordinal <= last for ordinal in ordinals) != 1
            for first, last in offer.groups
        )
    ):
        return None
    emails = list(dict.fromkeys(offer.emails[ordinal - 1] for ordinal in ordinals))
    if offer.groups and len(emails) != len(offer.groups):
        return None
    return emails, offer.grant_binding


async def search_my_contacts(
    tool_context: ToolContext,
    query: str = "",
    limit: int = 10,
    for_calendar: bool = False,
    queries: list[str] | None = None,
    availability_start_at: str = "",
    availability_end_at: str = "",
    availability_duration_minutes: int = 0,
    availability_limit: int = 3,
) -> dict[str, Any]:
    """Find people in the person's Google Contacts by name, email or phone (up to 25).

    Leave query empty for the most recently changed contacts. Results are the
    person's own address book: never share them onward unless the person asks.
    For an explicit request to schedule with someone, pass their name as query
    and for_calendar=true. For multiple named guests, pass their names
    separately in queries and leave query empty. It returns numbered mailbox
    hints for Calendar. Choose one candidate per requested name.
    Ask the owner to choose if the person or address is ambiguous. A prefix
    match alone is not proof of identity. Never infer an email address.
    If the same owner request includes open times, supply the exact timezone-
    qualified availability window, duration, and optional opening limit here.
    Use these exact values in calendar_free_slots after a successful lookup.
    """
    from hushh_mcp.one_adk.pod_connector_tools import pod_tool_owner

    owner = await pod_tool_owner(tool_context, "contacts")
    if owner is None or (
        for_calendar and tool_context.state.get("temp:one_execution_surface") != "typed_chat"
    ):
        return {"status": "blocked", "message": "Contacts are available only on your own agent."}
    consume_request_secret(tool_context.state.get(STATE_CONTACT_ATTENDEE_OFFER))
    tool_context.state[STATE_CONTACT_ATTENDEE_OFFER] = ""
    names = [name.strip() for name in queries] if queries is not None else [query.strip()]
    if (
        queries is not None
        and (
            not for_calendar
            or query.strip()
            or not 1 <= len(names) <= 5
            or any(not name or len(name) > 200 for name in names)
            or len({name.casefold() for name in names}) != len(names)
        )
    ) or (for_calendar and (not names[0] or not _conversation_id(tool_context))):
        return {"status": "input_required", "message": "Provide the guest's name or email."}
    availability = None
    if for_calendar and (
        availability_start_at or availability_end_at or availability_duration_minutes
    ):
        try:
            start = datetime.fromisoformat(availability_start_at)
            end = datetime.fromisoformat(availability_end_at)
            if not (
                start.tzinfo
                and end.tzinfo
                and start < end
                and 5 <= availability_duration_minutes <= 720
                and 1 <= availability_limit <= 20
            ):
                raise ValueError
        except (TypeError, ValueError):
            return {
                "status": "input_required",
                "message": "Provide the scheduling window and duration.",
            }
        availability = {
            "invocation": tool_context.invocation_id,
            "start_at": availability_start_at,
            "end_at": availability_end_at,
            "duration_minutes": availability_duration_minutes,
            "limit": availability_limit,
        }
    try:
        from hushh_mcp.pod_connectors import google_people

        binding = google_people.contacts_grant_binding() if for_calendar else None
        if binding is None:
            people = await google_people.search_contacts(query, limit=limit)
            return {"status": "ok", "source": "google_contacts", "people": people}
        try:
            google_people.contacts_grant_binding("read_other")
            read_other = True
        except google_people.ContactsUnavailable as exc:
            if exc.code != "SCOPE_NOT_GRANTED":
                raise
            read_other = False

        async def lookup(name: str) -> list[dict[str, Any]]:
            size = min(limit, 5) if queries is not None else limit
            people = await google_people.search_contacts(name, limit=size, emails_only=True)
            choices = calendar_guest_choices(people)
            if not choices and read_other:
                people = await google_people.search_contacts(
                    name, limit=size, emails_only=True, other=True
                )
                choices = calendar_guest_choices(people)
            return choices[:5] if queries is not None else choices

        async with asyncio.timeout(15):
            tasks = [asyncio.create_task(lookup(name)) for name in names]
            try:
                grouped = await asyncio.gather(*tasks)
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        if binding is not None and google_people.contacts_grant_binding() != binding:
            return {"status": "unavailable", "message": "The Google Contacts account changed."}
    except ImportError:
        return {"status": "blocked", "message": "Contacts are available only on your own agent."}
    except Exception as exc:  # noqa: BLE001 - provider detail never reaches the model
        code = str(getattr(exc, "code", "") or "")
        if code == "QUERY_REQUIRED":
            return {"status": "input_required", "message": "Provide the guest's name or email."}
        if code in {"NOT_CONNECTED", "NEEDS_REAUTH", "SCOPE_NOT_GRANTED"}:
            return {
                "status": "connection_required",
                "provider": "contacts",
                "message": "Connect Google Contacts on your agent, then try again.",
            }
        return {"status": "unavailable", "message": "Contacts could not be read right now."}
    if not all(grouped):
        return {
            "status": "ok",
            "source": "google_contacts",
            "attendee_choices": [],
            "unresolved_queries": [
                name for name, choices in zip(names, grouped, strict=True) if not choices
            ],
            "other_contacts_available": read_other,
            "message": "Some guests could not be resolved. Ask for their exact addresses.",
        }
    choices: list[dict[str, Any]] = []
    groups: list[tuple[int, int]] = []
    for name, group in zip(names, grouped, strict=True):
        first = len(choices) + 1
        for choice in group:
            choices.append(
                {
                    **choice,
                    "ordinal": len(choices) + 1,
                    **({"query": name} if queries is not None else {}),
                }
            )
        groups.append((first, len(choices)))
    offer = _ContactAttendeeOffer(
        owner_id=owner,
        conversation_id=_conversation_id(tool_context),
        grant_binding=binding,
        emails=[choice["email"] for choice in choices],
        groups=groups if queries is not None else [],
    )
    tool_context.state[STATE_CONTACT_ATTENDEE_OFFER] = store_request_secret(
        offer.model_dump_json(), ttl_seconds=_OFFER_TTL_SECONDS
    )
    tool_context.state[STATE_CONTACT_CALENDAR_READ] = availability
    for choice in choices:
        choice.pop("email")
    return {"status": "ok", "source": "google_contacts", "attendee_choices": choices}


__all__ = ["search_my_contacts"]

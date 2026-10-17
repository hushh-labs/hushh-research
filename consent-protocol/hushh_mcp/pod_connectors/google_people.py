"""Google Contacts, read only inside the owner's own agent. Nowhere else, by construction.

The standing rule (``tests/test_contacts_never_reach_the_server.py``) is that a phone
number belonging to someone who is not a Hussh user never reaches a Hussh server. An
agent that runs in the owner's own cloud account is not a Hussh server: it is the
owner's own computer, holding a login sealed to it. So this module is the one place
the People API may be called, and it enforces where it runs before it defines
anything: importing it raises ``ContactsOutsideOwnerAgent`` unless the process is a
pod (``pod_mode()``) placed in the owner's own cloud (``owner_cloud_agent()``). The
shared hub and a Hussh-hosted pod cannot even load it.

Reads are bounded (25 people), carry names, email addresses and phone numbers only,
are never written anywhere, and use a ``contacts.readonly`` token narrowed to exactly
that scope by ``PodGoogleTokenSource``.
"""

from __future__ import annotations

from typing import Any

import httpx

from hushh_mcp.runtime_settings import pod_mode
from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent


class ContactsOutsideOwnerAgent(ImportError):
    """Contacts were asked for somewhere other than the owner's own agent."""


if not (pod_mode() and owner_cloud_agent()):
    raise ContactsOutsideOwnerAgent(
        "Google Contacts are read only inside an agent in its owner's own cloud"
    )

_PEOPLE = "https://people.googleapis.com/v1"
_FIELDS = "names,emailAddresses,phoneNumbers"
MAX_PEOPLE = 25
_MAX_QUERY = 200


class ContactsUnavailable(RuntimeError):
    """The read did not happen. ``code`` is the whole explanation."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _text(value: Any, limit: int = 200) -> str:
    raw = value if isinstance(value, str) else ""
    return " ".join("".join(ch for ch in raw if ch.isprintable()).split())[:limit]


def _person(raw: Any) -> dict[str, Any]:
    person = raw.get("person", raw) if isinstance(raw, dict) else {}
    names = person.get("names") or []
    return {
        "name": _text(names[0].get("displayName")) if names and isinstance(names[0], dict) else "",
        "emails": [
            _text(item.get("value"), 320)
            for item in (person.get("emailAddresses") or [])[:5]
            if isinstance(item, dict) and item.get("value")
        ],
        "phones": [
            _text(item.get("value"), 40)
            for item in (person.get("phoneNumbers") or [])[:5]
            if isinstance(item, dict) and item.get("value")
        ],
    }


async def search_contacts(
    query: str = "",
    *,
    limit: int = 10,
    token_source: Any = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[dict[str, Any]]:
    """The owner's contacts matching ``query`` (or the most recently changed when empty)."""
    from hushh_mcp.services.pod_connector_tokens import (  # noqa: PLC0415
        ConnectorTokenError,
        google_token_source,
    )

    clean = _text(query, _MAX_QUERY)
    size = max(1, min(int(limit) if type(limit) is int else 10, MAX_PEOPLE))
    source = token_source if token_source is not None else google_token_source()
    try:
        token = str(await source.access_token("contacts", "read"))
    except ConnectorTokenError as exc:
        raise ContactsUnavailable(exc.code) from None
    if clean:
        url = f"{_PEOPLE}/people:searchContacts"
        params: dict[str, Any] = {"query": clean, "readMask": _FIELDS, "pageSize": size}
        key = "results"
    else:
        url = f"{_PEOPLE}/people/me/connections"
        params = {
            "personFields": _FIELDS,
            "pageSize": size,
            "sortOrder": "LAST_MODIFIED_DESCENDING",
        }
        key = "connections"
    try:
        async with httpx.AsyncClient(
            transport=transport, timeout=10, follow_redirects=False
        ) as client:
            response = await client.get(
                url, params=params, headers={"Authorization": f"Bearer {token}"}
            )
    except httpx.HTTPError:
        raise ContactsUnavailable("PROVIDER_UNREACHABLE") from None
    if response.status_code in {401, 403}:
        raise ContactsUnavailable("NEEDS_REAUTH")
    if response.status_code != 200:
        raise ContactsUnavailable("PROVIDER_UNREACHABLE")
    try:
        body = response.json()
    except ValueError:
        raise ContactsUnavailable("PROVIDER_UNREACHABLE") from None
    items = body.get(key) if isinstance(body, dict) else None
    return [_person(item) for item in (items if isinstance(items, list) else [])[:size]]


__all__ = ["MAX_PEOPLE", "ContactsOutsideOwnerAgent", "ContactsUnavailable", "search_contacts"]

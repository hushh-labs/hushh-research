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

import asyncio
import json
from functools import lru_cache
from typing import Any

import httpx
from googleapiclient.discovery import build
from googleapiclient.http import build_http
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.runtime_settings import pod_mode
from hushh_mcp.services import pod_connector_credentials as credentials
from hushh_mcp.services.pod_connector_tokens import ConnectorTokenError, required_scopes
from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent


class ContactsOutsideOwnerAgent(ImportError):
    """Contacts were asked for somewhere other than the owner's own agent."""


if not (pod_mode() and owner_cloud_agent()):
    raise ContactsOutsideOwnerAgent(
        "Google Contacts are read only inside an agent in its owner's own cloud"
    )

_EMAIL_FIELDS = "names,emailAddresses"
_PEOPLE_ORIGIN = "https://people.googleapis.com"
_FIELDS = f"{_EMAIL_FIELDS},phoneNumbers"
MAX_PEOPLE = 25
_MAX_QUERY = 200
_MAX_RESULT_BYTES = 512 * 1024


class ContactsUnavailable(RuntimeError):
    """The read did not happen. ``code`` is the whole explanation."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _text(value: Any, limit: int = 200) -> str:
    raw = value if isinstance(value, str) else ""
    return " ".join("".join(ch for ch in raw if ch.isprintable()).split())[:limit]


def _person(raw: Any, *, emails_only: bool) -> dict[str, Any]:
    person = raw.get("person", raw) if isinstance(raw, dict) else {}
    person = person if isinstance(person, dict) else {}

    def values(field: str, key: str = "value") -> list[str]:
        items = person.get(field)
        if not isinstance(items, list):
            return []
        return [
            item[key]
            for item in items[:5]
            if isinstance(item, dict) and isinstance(item.get(key), str)
        ]

    names = values("names", "displayName")
    addresses = values("emailAddresses")
    result: dict[str, Any] = {
        "name": _text(names[0]) if names else "",
        "emails": addresses if emails_only else [_text(value, 320) for value in addresses],
    }
    if not emails_only:
        result["phones"] = [_text(value, 40) for value in values("phoneNumbers")]
    return result


def contacts_grant_binding(level: str = "read") -> tuple[str, ...]:
    """Identify the current Contacts account and grant, excluding token rotation."""
    if not (pod_mode() and owner_cloud_agent()):
        raise ContactsOutsideOwnerAgent("Contacts are available only in the owner's cloud")
    try:
        held = credentials.active_connector_credential("contacts")
    except credentials.ConnectorCredentialsUnavailable:
        raise ContactsUnavailable("CREDENTIALS_UNAVAILABLE") from None
    if held is None:
        raise ContactsUnavailable("NOT_CONNECTED")
    if held.status != credentials.STATUS_CONNECTED:
        raise ContactsUnavailable("NEEDS_REAUTH")
    try:
        required_scopes("contacts", level, held.granted_scopes)
    except ConnectorTokenError as exc:
        raise ContactsUnavailable(exc.code) from None
    return (
        held.credential_id,
        held.account_subject,
        str(held.connected_at_ms),
        *sorted(held.granted_scopes),
    )


def _require_success(response: httpx.Response) -> None:
    if response.status_code in {401, 403}:
        raise ContactsUnavailable("NEEDS_REAUTH")
    if response.status_code != 200:
        raise ContactsUnavailable("PROVIDER_UNREACHABLE")


@lru_cache(maxsize=1)
def _people_discovery() -> Any:
    # Use the SDK's packaged REST discovery contract. It constructs requests
    # without credentials or network access. The async transport below owns
    # the operation-scoped bearer, deadline, body cap and telemetry.
    return build("people", "v1", http=build_http(), static_discovery=True, cache_discovery=False)


async def _read_result(client: httpx.AsyncClient, uri: str, headers: dict[str, str]) -> Any:
    async with client.stream("GET", uri, headers=headers) as response:
        _require_success(response)
        payload = bytearray()
        async for chunk in response.aiter_bytes():
            if len(chunk) > _MAX_RESULT_BYTES - len(payload):
                raise ContactsUnavailable("PROVIDER_UNREACHABLE")
            payload.extend(chunk)
    try:
        return json.loads(payload)
    except (ValueError, UnicodeError):
        raise ContactsUnavailable("PROVIDER_UNREACHABLE") from None


async def search_contacts(
    query: str = "",
    *,
    limit: int = 10,
    emails_only: bool = False,
    other: bool = False,
    token_source: Any = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[dict[str, Any]]:
    """The owner's contacts matching ``query`` (or the most recently changed when empty)."""
    from hushh_mcp.services.pod_connector_tokens import google_token_source

    clean = _text(query, _MAX_QUERY)
    if (emails_only or other) and not clean:
        raise ContactsUnavailable("QUERY_REQUIRED")
    size = max(1, min(int(limit) if type(limit) is int else 10, MAX_PEOPLE))
    fields = _EMAIL_FIELDS if emails_only else _FIELDS
    level = "read_other" if other else "read"
    binding = contacts_grant_binding(level)
    source = token_source if token_source is not None else google_token_source()
    try:
        token = str(await source.access_token("contacts", level))
    except ConnectorTokenError as exc:
        raise ContactsUnavailable(exc.code) from None
    discovery = _people_discovery()
    warmup_uri = None
    if clean:
        search = discovery.otherContacts().search if other else discovery.people().searchContacts
        params = {"readMask": fields, "pageSize": size}
        uri = search(query=clean, **params).uri
        warmup_uri = search(query="", **params).uri
        key = "results"
    else:
        uri = (
            discovery.people()
            .connections()
            .list(
                resourceName="people/me",
                personFields=fields,
                pageSize=size,
                sortOrder="LAST_MODIFIED_DESCENDING",
            )
            .uri
        )
        key = "connections"
    if not uri.startswith(f"{_PEOPLE_ORIGIN}/v1/") or (
        warmup_uri and not warmup_uri.startswith(f"{_PEOPLE_ORIGIN}/v1/")
    ):
        raise ContactsUnavailable("PROVIDER_UNREACHABLE")
    try:
        # The query can contain a person's name, address or phone number.
        with suppress_instrumentation():
            async with (
                asyncio.timeout(10),
                httpx.AsyncClient(
                    transport=transport, timeout=10, follow_redirects=False
                ) as client,
            ):
                headers = {"Authorization": f"Bearer {token}", "Accept-Encoding": "identity"}
                if warmup_uri:
                    # People API search requires an empty-query warmup on the
                    # search endpoint itself. The response is never used as evidence.
                    async with client.stream("GET", warmup_uri, headers=headers) as warmup:
                        _require_success(warmup)
                if contacts_grant_binding(level) != binding:
                    raise ContactsUnavailable("CONNECTION_CHANGED")
                body = await _read_result(client, uri, headers)
    except (httpx.HTTPError, TimeoutError):
        raise ContactsUnavailable("PROVIDER_UNREACHABLE") from None
    if contacts_grant_binding(level) != binding:
        raise ContactsUnavailable("CONNECTION_CHANGED")
    items = body.get(key, []) if isinstance(body, dict) else None
    if not isinstance(items, list):
        raise ContactsUnavailable("PROVIDER_UNREACHABLE")
    return [_person(item, emails_only=emails_only) for item in items[:size]]


__all__ = [
    "MAX_PEOPLE",
    "ContactsOutsideOwnerAgent",
    "ContactsUnavailable",
    "contacts_grant_binding",
    "search_contacts",
]

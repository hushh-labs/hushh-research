"""Only the manifest-declared read ports of the Location command assessment."""

from __future__ import annotations

from typing import Any

from hushh_mcp.constants import ConsentScope
from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.hushh_adk.tools import hushh_tool


async def _read(kind: str, **kwargs: Any) -> dict[str, Any]:
    context = HushhContext.current()
    port = context.service_ports.get("location_command_reads") if context else None
    if port is None or port.user_id != context.user_id:
        raise PermissionError("An owner-bound Location read port is required.")
    result = await port.read(kind, **kwargs)
    # A bounded read may wait on a provider. Revalidate before revealing its
    # result if consent was revoked while that work was in flight.
    from hushh_mcp.hushh_adk.tools import validate_token_with_db

    valid, _, authority = await validate_token_with_db(
        context.consent_token, expected_scope=ConsentScope.VAULT_OWNER
    )
    if not valid or authority is None or authority.user_id != context.user_id:
        raise PermissionError("Location read authority changed before its result was available.")
    return result


@hushh_tool(scope=ConsentScope.VAULT_OWNER)
async def find_people(
    query: str, directory: bool = False, page: int = 1, limit: int = 20
) -> dict[str, Any]:
    """Read actual people matching a name. Directory includes unconnected and pending people; a request is never an accepted connection. Preserve every requested person and ask when ambiguous. hasMore means the audience is incomplete."""
    return await _read(
        "directory" if directory else "connections", query=query, page=page, limit=limit
    )


@hushh_tool(scope=ConsentScope.VAULT_OWNER)
async def read_circles(
    circle_reference: str = "", query: str = "", page: int = 1, limit: int = 20
) -> dict[str, Any]:
    """Read the owner's circles, or current members of an exact circle_reference returned by this tool. Never invent a handle. hasMore means additional members exist."""
    return await _read(
        "members" if circle_reference else "circles",
        reference=circle_reference,
        query=query,
        page=page,
        limit=limit,
    )


@hushh_tool(scope=ConsentScope.VAULT_OWNER)
async def read_location_settings() -> dict[str, Any]:
    """Read actual auto-approval and map Ghost Mode settings. These observations grant no authority to change a setting."""
    return await _read("settings")


@hushh_tool(scope=ConsentScope.VAULT_OWNER)
async def read_location_status(
    requests: bool = False, public_links: bool = False, page: int = 1, limit: int = 20
) -> dict[str, Any]:
    """Read metadata for requests, shares or active public links without coordinates, URLs, keys or mutations. Read public_links before planning a link handoff: share an existing live link without extending it unless the user requested a new duration."""
    if requests and public_links:
        raise ValueError("Choose requests or public links for this read.")
    return await _read(
        "links" if public_links else "requests" if requests else "shares", page=page, limit=limit
    )


@hushh_tool(scope=ConsentScope.VAULT_OWNER)
async def read_nearby_results() -> dict[str, Any]:
    """Read current device-observed Nearby provider candidates. If absent, propose the authored Nearby search; never guess a place or device origin."""
    return await _read("nearby")

"""One's Contacts tool inside the owner's own agent (``google_people`` does the read).

The tool module itself loads anywhere so a roster can name it, but the reader it
calls refuses to load outside an owner-cloud agent, and the tool refuses any call
that is not the owner's own typed chat in that agent.
"""

from __future__ import annotations

from typing import Any

from google.adk.tools.tool_context import ToolContext


async def search_my_contacts(
    tool_context: ToolContext, query: str = "", limit: int = 10
) -> dict[str, Any]:
    """Find people in the person's Google Contacts by name, email or phone (up to 25).

    Leave query empty for the most recently changed contacts. Results are the
    person's own address book: never share them onward unless the person asks.
    """
    from hushh_mcp.one_adk.pod_connector_tools import pod_tool_owner

    if await pod_tool_owner(tool_context, "contacts") is None:
        return {"status": "blocked", "message": "Contacts are available only on your own agent."}
    try:
        from hushh_mcp.pod_connectors import google_people

        people = await google_people.search_contacts(query, limit=limit)
    except ImportError:
        return {"status": "blocked", "message": "Contacts are available only on your own agent."}
    except Exception as exc:  # noqa: BLE001 - provider detail never reaches the model
        code = str(getattr(exc, "code", "") or "")
        if code in {"NOT_CONNECTED", "NEEDS_REAUTH", "SCOPE_NOT_GRANTED"}:
            return {
                "status": "connection_required",
                "provider": "contacts",
                "message": "Connect Google Contacts on your agent, then try again.",
            }
        return {"status": "unavailable", "message": "Contacts could not be read right now."}
    return {"status": "ok", "source": "google_contacts", "people": people}


__all__ = ["search_my_contacts"]

"""Drive tool authority is attached to authenticated typed Chat, not model args."""

from types import SimpleNamespace

import pytest

from hushh_mcp.one_adk import drive_tools
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult


def test_live_chat_does_not_register_legacy_account_wide_drive_tools():
    from api.routes.one import agent_chat

    names = {
        getattr(tool, "name", getattr(tool, "__name__", ""))
        for tool in agent_chat._app.root_agent.tools
    }
    assert "ask_documents_agent" in names
    assert drive_tools.DRIVE_READ_TOOL_NAME not in names
    assert drive_tools.DRIVE_DISCOVERY_TOOL_NAME not in names


def _context(user_id="owner", admitted=True):
    return SimpleNamespace(
        user_id=user_id,
        state={
            "hussh:user_id": "owner",
            "hussh:consent_token": "secret-ref",
            drive_tools.DRIVE_CHAT_ADMISSION_STATE: admitted,
        },
    )


@pytest.mark.asyncio
async def test_drive_denies_unauthorized_context_without_calling_provider(monkeypatch):
    async def active(_owner, _token):
        return True

    monkeypatch.setattr(drive_tools, "pod_mode", lambda: False)
    monkeypatch.setattr(drive_tools, "resolve_request_secret", lambda _ref: "owner-token")
    monkeypatch.setattr(drive_tools, "validate_first_party_owner_token", active)
    monkeypatch.setattr(drive_tools, "_service", lambda: pytest.fail("provider must not be called"))
    for context in (_context(admitted=False), _context(user_id="other")):
        assert (await drive_tools.discover_google_drive_tools(context))["status"] == "blocked"
        assert (await drive_tools.read_google_drive("search_files", {}, context))[
            "status"
        ] == "blocked"
    monkeypatch.setattr(drive_tools, "pod_mode", lambda: True)
    assert (await drive_tools.read_google_drive("search_files", {}, _context()))[
        "status"
    ] == "blocked"


@pytest.mark.asyncio
async def test_drive_uses_current_owner_and_refuses_result_after_revocation(monkeypatch):
    validity = iter([True, False])
    seen = []

    async def validate(_owner, _token):
        return next(validity)

    class Service:
        async def read_tool(self, **kwargs):
            seen.append(kwargs)
            return ExternalMcpToolResult(
                payload={"result": "PRIVATE_DRIVE_SENTINEL"}, is_error=False, truncated=False
            )

    monkeypatch.setattr(drive_tools, "pod_mode", lambda: False)
    monkeypatch.setattr(drive_tools, "resolve_request_secret", lambda _ref: "owner-token")
    monkeypatch.setattr(drive_tools, "validate_first_party_owner_token", validate)
    monkeypatch.setattr(drive_tools, "_service", Service)
    result = await drive_tools.read_google_drive("search_files", {"query": "notes"}, _context())
    assert result == {"status": "blocked", "message": "The Drive session changed. Try again."}
    assert seen == [
        {"user_id": "owner", "tool_name": "search_files", "arguments": {"query": "notes"}}
    ]
    assert "PRIVATE_DRIVE_SENTINEL" not in str(result)


@pytest.mark.asyncio
async def test_drive_mcp_missing_grant_does_not_misrepresent_selected_file_connection(monkeypatch):
    async def active(_owner, _token):
        return True

    class Service:
        async def read_tool(self, **_kwargs):
            raise DriveOAuthError("private provider detail", status_code=403)

    monkeypatch.setattr(drive_tools, "pod_mode", lambda: False)
    monkeypatch.setattr(drive_tools, "resolve_request_secret", lambda _ref: "owner-token")
    monkeypatch.setattr(drive_tools, "validate_first_party_owner_token", active)
    monkeypatch.setattr(drive_tools, "_service", Service)
    result = await drive_tools.read_google_drive("search_files", {"query": "notes"}, _context())
    assert result["status"] == "permission_required"
    assert "selected-file library in Connectors is separate" in result["message"]
    assert "private provider detail" not in str(result)

"""Drive runs in the owner's own agent on its own login; every hub table is refused.

``pod_drive`` keeps the hub transport's REST operations and swaps what sits around
them: the agent's own Drive token at the level the operation needs, a fence on that
login's credential id, the owner's own log for reviewed writes. The hub's OAuth rows,
lifecycle rows, directive ledger and owner-token check are each refused by name, the
tools refuse a hosted pod and a voice turn, and they appear in One's roster only in an
owner-cloud agent.
"""

from __future__ import annotations

import pytest

from hushh_mcp.one_adk import drive_tools, drive_write_tools
from hushh_mcp.one_adk.pod_connector_tools import pod_connector_roster, pod_tool_owner
from hushh_mcp.services import pod_connector_credentials as store
from hushh_mcp.services.pod_drive import (
    HUB_TABLES_REFUSED,
    HubDriveTableRefused,
    PodDriveRestTransport,
)
from tests import pod_connector_harness as h

FILES = "https://www.googleapis.com/drive/v3/files"


@pytest.fixture
def agent(monkeypatch, tmp_path):
    log, tokens, google = h.install(
        monkeypatch, tmp_path, connectors={"drive": h.credential("drive", h.SCOPES["drive"])}
    )
    google.on(
        "GET",
        FILES,
        {"files": [{"id": "f1", "name": "Plan", "mimeType": "text/plain"}], "nextPageToken": ""},
    )
    yield log, tokens, google
    h.uninstall()


async def test_a_drive_read_uses_the_agents_own_read_token(agent):
    _log, tokens, google = agent
    result = await drive_tools.read_google_drive(
        "list_recent_files", {"pageSize": 5}, h.tool_context()
    )
    assert result["status"] == "ok", result
    assert tokens.asks == [("drive", "read")]
    assert {r.url.host for r in google.requests} == {"www.googleapis.com"}


async def test_a_reconnect_during_a_read_is_never_published(agent, monkeypatch):
    transport = PodDriveRestTransport(h.OWNER_UID)
    real = transport._list_recent_files

    async def swap(arguments, token):
        payload = await real(arguments, token)
        store.set_active_connector_credentials(
            {
                "drive": h.credential(
                    "drive", h.SCOPES["drive"], credential_id="88888888-2222-4333-8444-555555555555"
                )
            }
        )
        return payload

    monkeypatch.setattr(transport, "_list_recent_files", swap)
    with pytest.raises(Exception) as refused:
        await transport.read_tool(user_id=h.OWNER_UID, tool_name="list_recent_files", arguments={})
    assert getattr(refused.value, "status_code", None) == 409


async def test_every_hub_table_is_refused_by_name(agent):
    transport = PodDriveRestTransport(h.OWNER_UID)
    with pytest.raises(HubDriveTableRefused):
        await transport._oauth.current_credential(user_id=h.OWNER_UID, required_profile="live")
    with pytest.raises(HubDriveTableRefused):
        await transport._oauth.lifecycle.read(user_id=h.OWNER_UID, connector_id="google_drive")
    assert set(HUB_TABLES_REFUSED) >= {
        "external_connector_oauth_credentials",
        "external_connector_lifecycle",
        "action_directive_ledger",
    }


async def test_a_reviewed_share_is_kept_in_the_owners_log_not_the_hub_ledger(agent, monkeypatch):
    from hushh_mcp.services import action_directive_ledger

    def _ledger(*_a, **_k):
        raise AssertionError("the hub directive ledger must not be touched in the agent")

    monkeypatch.setattr(action_directive_ledger.ActionDirectiveStore, "issue", _ledger)
    log, _tokens, google = agent
    google.on(
        "GET",
        f"{FILES}/f1",
        {"id": "f1", "name": "Plan", "mimeType": "text/plain", "trashed": False},
    )
    result = await drive_write_tools.propose_drive_file_share("f1", "a@b.com", h.tool_context())
    assert result["status"] == "confirmation_required", result
    directive = result["directive"]["payload"]
    assert directive["directiveId"].startswith("gdrv_")
    kinds = [r["kind"] for r in await log.replay()]
    assert kinds == ["pod_action_proposal_v1"]


async def test_the_tools_refuse_a_hosted_pod_and_a_voice_turn(agent, monkeypatch):
    assert await pod_tool_owner(h.tool_context(), "drive") == h.OWNER_UID
    voice = h.tool_context(**{"temp:one_execution_surface": "voice"})
    assert await pod_tool_owner(voice, "drive") is None
    raw = h.tool_context(**{"hussh:consent_token": "pod-session:raw-not-a-reference"})
    assert await pod_tool_owner(raw, "drive") is None
    assert await pod_tool_owner(h.tool_context(owner="someone-else"), "drive") is None
    monkeypatch.delenv("HUSSH_POD_KMS_KEY")
    assert await pod_tool_owner(h.tool_context(), "drive") is None
    assert pod_connector_roster() == []


def test_the_roster_carries_the_connector_tools_only_in_an_owner_cloud_agent(agent):
    names = {tool.__name__ for tool in pod_connector_roster()}
    assert {
        "read_google_drive",
        "create_drive_file",
        "propose_drive_file_share",
        "propose_gmail_mailbox_change",
        "search_my_contacts",
    } <= names

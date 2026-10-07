"""Gmail read in the owner's own agent: its own login, the same bounds, no hub door.

Covers ``pod_gmail_local``: the stand-in for the hub service's three credential seams
runs the unchanged ``GmailMetadataReader``; the email specialist's local port keeps the
``EmailReadOptions`` bounds, the signed ``MailObservation`` round trip and the
fail-closed ``expect_account``; the port is chosen only in an owner-cloud agent that
holds a Gmail login; and nothing reaches ``PodHubClient.read_specialist``.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services import pod_connector_credentials as store
from hushh_mcp.services.gmail_metadata_reader import GmailMetadataError
from hushh_mcp.services.pod_gmail_local import (
    HubTableRefused,
    PodGmailConnection,
    PodLocalEmailReadPort,
    email_read_port,
)
from hushh_mcp.services.pod_specialist_runtime import (
    PodEmailReadPort,
    PodSpecialistInformationUnavailable,
)
from tests import pod_connector_harness as h

# ruff: noqa: S106 -- token-shaped strings below name test fixtures, not credentials.


async def _local_verifier(*_a, **_k):  # the pod session authority's verifier stand-in
    raise AssertionError("the port never calls the verifier itself")


OWNER_SESSION = ("pod-session:sid", _local_verifier)


@pytest.fixture
def agent(monkeypatch, tmp_path):
    log, tokens, google = h.install(
        monkeypatch, tmp_path, connectors={"gmail": h.credential("gmail", h.SCOPES["gmail"])}
    )
    from hushh_mcp.services import pod_hub_client

    def _hub(*_a, **_k):
        raise AssertionError("an owner-cloud agent must never read a hub door")

    monkeypatch.setattr(pod_hub_client.PodHubClient, "read_specialist", _hub)
    h.route_inbox(google)
    yield log, tokens, google
    h.uninstall()


async def test_nudges_and_search_read_gmail_with_the_agents_own_token(agent):
    _log, tokens, google = agent
    port = email_read_port(h.OWNER_UID, "hub-scope-token-never-used", *OWNER_SESSION)
    assert isinstance(port, PodLocalEmailReadPort)
    assert port._scope_token == "", "the local port carries no hub scope token at all"

    state = await port.list_nudges(user_id=h.OWNER_UID, limit=5)
    results = await port.search_inbox(user_id=h.OWNER_UID, query="from:ravi", limit=2)

    assert isinstance(state, dict)
    assert [r["subject"] for r in results] == ["Hello", "Hello"]
    assert set(tokens.asks) == {("gmail", "read")}
    hosts = {r.url.host for r in google.requests}
    assert hosts == {"gmail.googleapis.com"}, "Gmail only: no Hussh host is on this path"
    assert all(r.headers["authorization"] == "Bearer ya29.gmail.read" for r in google.requests)


async def test_a_metadata_read_issues_an_observation_that_revalidates_locally(agent):
    port = PodLocalEmailReadPort(h.OWNER_UID, owner_session=True)

    async def owner_ok() -> None:
        return None

    reader = port.metadata_reader(gmail=port, user_id=h.OWNER_UID, require_access=owner_ok)
    page = await reader.read("list_recent", {"limit": 2, "mailbox": "inbox"})
    await reader.require_current()

    assert page["metadata_only"] is True
    assert len(page["untrusted_external_content"]) == 2


async def test_a_reconnected_account_invalidates_the_observation(agent):
    port = PodLocalEmailReadPort(h.OWNER_UID, owner_session=True)

    async def owner_ok() -> None:
        return None

    reader = port.metadata_reader(gmail=port, user_id=h.OWNER_UID, require_access=owner_ok)
    await reader.read("list_recent", {"limit": 1, "mailbox": "inbox"})
    store.set_active_connector_credentials(
        {
            "gmail": h.credential(
                "gmail", h.SCOPES["gmail"], credential_id="99999999-2222-4333-8444-555555555555"
            )
        }
    )

    with pytest.raises(GmailMetadataError) as refused:
        await reader.require_current()
    assert refused.value.code == "connection_changed"


async def test_ids_from_an_earlier_list_fail_closed(agent):
    port = PodLocalEmailReadPort(h.OWNER_UID, owner_session=True)

    async def owner_ok() -> None:
        return None

    with pytest.raises(GmailMetadataError) as refused:
        port.metadata_reader(
            gmail=port, user_id=h.OWNER_UID, require_access=owner_ok, expect_account="sub-x"
        )
    assert refused.value.code == "connection_changed"


async def test_a_foreign_owner_is_refused_before_any_read(agent):
    _log, tokens, google = agent
    port = PodLocalEmailReadPort(h.OWNER_UID, owner_session=True)
    with pytest.raises(PermissionError):
        await port.list_nudges(user_id="someone-else")
    assert tokens.asks == [] and google.requests == []


async def test_no_gmail_login_reads_as_connect_required_or_unavailable(agent):
    store.set_active_connector_credentials({})
    port = PodLocalEmailReadPort(h.OWNER_UID, owner_session=True)

    async def owner_ok() -> None:
        return None

    reader = port.metadata_reader(gmail=port, user_id=h.OWNER_UID, require_access=owner_ok)
    with pytest.raises(GmailMetadataError) as refused:
        await reader.read("list_recent", {"limit": 1, "mailbox": "inbox"})
    assert refused.value.code == "connect_required"
    with pytest.raises(PodSpecialistInformationUnavailable):
        await port.list_nudges(user_id=h.OWNER_UID)


async def test_the_reader_bounds_are_the_hub_doors_bounds(agent):
    port = PodLocalEmailReadPort(h.OWNER_UID, owner_session=True)
    with pytest.raises(ValueError):
        await port._read(h.OWNER_UID, operation="search", limit=26, query="x")


def test_inherited_hub_table_paths_refuse_instead_of_degrading(agent):
    with pytest.raises(HubTableRefused):
        _ = PodGmailConnection(h.OWNER_UID).db


def test_every_owner_cloud_agent_stays_local_even_without_a_login(agent, monkeypatch):
    assert isinstance(email_read_port(h.OWNER_UID, "t"), PodLocalEmailReadPort)

    store.set_active_connector_credentials({})
    door = email_read_port(h.OWNER_UID, "t")
    assert isinstance(door, PodLocalEmailReadPort), "a missing login never grants hub access"

    store.set_active_connector_credentials({"gmail": h.credential("gmail", h.SCOPES["gmail"])})
    monkeypatch.delenv("HUSSH_POD_KMS_KEY")
    assert type(email_read_port(h.OWNER_UID, "t")) is PodEmailReadPort, "hosted pod: door"

    monkeypatch.setenv("HUSSH_POD_KMS_KEY", "projects/p/locations/l/keyRings/r/cryptoKeys/k")
    monkeypatch.setattr(store, "_LOAD_FAILED", True)
    assert isinstance(email_read_port(h.OWNER_UID, "t"), PodLocalEmailReadPort), (
        "an unreadable login store stays local and fails closed, never the hub"
    )


async def test_a_turn_the_hub_admitted_gets_no_mail_from_the_agents_own_login(agent):
    _log, tokens, google = agent
    hub_turns = [("hub-verified-consent-token", None), ("pod-session:sid", None)]
    hub_turns.append(("hub-verified-consent-token", _local_verifier))
    for turn_token, verifier in hub_turns:
        port = email_read_port(h.OWNER_UID, "hub-email-scope", turn_token, verifier)
        assert isinstance(port, PodLocalEmailReadPort), "never the hub door either"
        with pytest.raises(PermissionError):
            port.require_owner_session()
        with pytest.raises(PermissionError):
            await port.list_nudges(user_id=h.OWNER_UID)
        with pytest.raises(PermissionError):
            await port.search_inbox(user_id=h.OWNER_UID, query="from:ravi")
    assert tokens.asks == [] and google.requests == []

"""Proof: with every hub information door shut, an owner-cloud agent still answers.

The founder's rule is that an agent in the person's own cloud never needs the hub for
content. This test shuts the hub out completely: ``PodHubClient.read_specialist``
raises on any call, the data-door specialist path raises, and the email scope token
check raises if it is ever asked. The agent must still

* build its email specialist on its own Gmail login (``PodLocalEmailReadPort``),
  admit an owner-session read with no hub scope check, and answer nudges and a search;
* answer Calendar summary and event tool calls from Google with its own login;

and every provider request must go to Google, none to a Hussh host. Reverting either
the email port selection or the Calendar door change turns this red.

The other half of the rule: a turn the hub admitted (a hub-verified consent token,
no local session verifier) gets no mail and no calendar from the agent's own logins.
Dropping the owner-session gate on either path turns those tests red.
"""

from __future__ import annotations

# ruff: noqa: S106 -- token-shaped strings below name test fixtures, not credentials.
from types import SimpleNamespace

import pytest

from hushh_mcp.agents.calendar import tools as calendar_tools
from hushh_mcp.services import google_calendar_service, pod_consent_client, pod_hub_client
from hushh_mcp.services.pod_consent_client import ConsentVerdict
from hushh_mcp.services.pod_gmail_local import PodLocalEmailReadPort
from tests import pod_connector_harness as h

EVENTS = f"{h.CALENDAR}/calendars/primary/events"


@pytest.fixture
def shut_hub(monkeypatch, tmp_path):
    log, tokens, google = h.install(
        monkeypatch,
        tmp_path,
        connectors={
            "gmail": h.credential("gmail", h.SCOPES["gmail"]),
            "calendar": h.credential("calendar", h.SCOPES["calendar"]),
        },
    )
    hub_reads: list[str] = []

    def _read_specialist(self, name, *_a, **_k):
        hub_reads.append(name)
        raise pod_hub_client.PodHubUnavailable("the hub is shut for this proof")

    async def _data_door(*_a, **_k):
        hub_reads.append("data_door")
        raise AssertionError("the data door must not be used by an owner-cloud agent")

    async def _consent(token, *, expected_scope):
        if expected_scope != "pkm.read":
            hub_reads.append(f"scope:{expected_scope}")
            raise AssertionError(f"a hub scope check was asked for {expected_scope}")
        return ConsentVerdict(True, True, h.OWNER_UID, h.OWNER_HUSHH, expected_scope)

    from hushh_mcp.one_adk import pod_data_door_specialist

    monkeypatch.setattr(pod_hub_client.PodHubClient, "read_specialist", _read_specialist)
    monkeypatch.setattr(pod_data_door_specialist, "serve_specialist_via_data_door", _data_door)
    monkeypatch.setattr(pod_consent_client, "verify_consent", _consent)
    monkeypatch.setattr(google_calendar_service, "_singleton", None)
    h.route_inbox(google)
    google.on(
        "GET",
        EVENTS,
        {
            "items": [
                {
                    "id": "e1",
                    "status": "confirmed",
                    "summary": "Standup",
                    "start": {"dateTime": "2026-10-07T09:00:00Z"},
                    "end": {"dateTime": "2026-10-07T09:15:00Z"},
                }
            ]
        },
    )
    yield google, hub_reads
    h.uninstall()


LOCAL_TOKEN = "pod-session:sid"


async def _local_verifier(token, *, expected_scope="", **_k):
    """The pod session authority's ``local_verifier`` for one owner session."""
    if token != LOCAL_TOKEN:
        return ConsentVerdict(False, True, reason="not local authority")
    return ConsentVerdict(True, True, h.OWNER_UID, h.OWNER_HUSHH, expected_scope)


def _email_runtime(consent_token: str, verifier):
    from hushh_mcp.services.pod_specialist_runtime import build_pod_specialist_runtime

    return build_pod_specialist_runtime(
        user_id=h.OWNER_UID,
        hushh_id=h.OWNER_HUSHH,
        consent_token=consent_token,
        provider="gemini",
        model="gemini-3.6-flash",
        runtime_mode="user_adc",
        credential=None,
        credential_transport="developer_api",
        vertex_project="owner-project",
        vertex_location="global",
        data_door_grants={"email": "hub-email-scope-token"},
        verifier=verifier,
    )


async def test_the_email_specialist_answers_with_the_hub_shut(shut_hub):
    google, hub_reads = shut_hub
    runtime = _email_runtime(LOCAL_TOKEN, _local_verifier)
    agent = await runtime.service_for("agent_email")
    port = agent._service._gmail

    assert isinstance(port, PodLocalEmailReadPort)
    await agent._require_read(SimpleNamespace(user_id=h.OWNER_UID))
    nudges = await port.list_nudges(user_id=h.OWNER_UID, limit=5)
    found = await port.search_inbox(user_id=h.OWNER_UID, query="from:ravi", limit=2)

    assert isinstance(nudges, dict) and len(found) == 2
    assert hub_reads == [], f"the hub was asked: {hub_reads}"
    assert {r.url.host for r in google.requests} == {"gmail.googleapis.com"}


async def test_calendar_tool_calls_answer_with_the_hub_shut(shut_hub):
    google, hub_reads = shut_hub
    context = h.tool_context()

    summary = await calendar_tools.calendar_summary(context, days=3)
    events = await calendar_tools.calendar_events(
        context, start_at="2026-10-07T00:00:00Z", end_at="2026-10-08T00:00:00Z"
    )

    assert summary["status"] == "ok", summary
    assert events["status"] == "ok", events
    assert [e.get("title") or e.get("summary") for e in events["events"]] == ["Standup"]
    assert hub_reads == [], f"the hub was asked: {hub_reads}"
    assert {r.url.host for r in google.requests} == {"www.googleapis.com"}


async def test_a_hub_admitted_turn_gets_no_mail_from_the_agents_own_login(shut_hub):
    google, hub_reads = shut_hub
    runtime = _email_runtime("hub-verified-consent-token", None)
    agent = await runtime.service_for("agent_email")
    port = agent._service._gmail

    assert isinstance(port, PodLocalEmailReadPort), "never falls back to the hub door"
    with pytest.raises(PermissionError):
        await agent._require_read(SimpleNamespace(user_id=h.OWNER_UID))
    with pytest.raises(PermissionError):
        await port.list_nudges(user_id=h.OWNER_UID, limit=5)
    with pytest.raises(PermissionError):
        await port.search_inbox(user_id=h.OWNER_UID, query="from:ravi", limit=2)

    assert google.requests == [], "no Gmail request for a turn the hub admitted"
    assert hub_reads == [], f"the hub was asked: {hub_reads}"


async def test_a_hub_admitted_turn_gets_no_calendar_from_the_agents_own_login(shut_hub):
    from hushh_mcp.one_adk.request_secrets import store_request_secret

    google, hub_reads = shut_hub
    hub_reference = store_request_secret("hub-verified-consent-token", ttl_seconds=60)
    turns = [
        h.tool_context(**{"hussh:consent_token": hub_reference}),
        h.tool_context(**{"hussh:consent_token": "hub-verified-consent-token"}),
        h.tool_context(**{"temp:one_execution_surface": "voice"}),
    ]
    for context in turns:
        summary = await calendar_tools.calendar_summary(context, days=3)
        events = await calendar_tools.calendar_events(
            context, start_at="2026-10-07T00:00:00Z", end_at="2026-10-08T00:00:00Z"
        )
        proposed = await calendar_tools.propose_calendar_event(
            context,
            title="Lunch",
            start_at="2026-10-07T12:00:00Z",
            end_at="2026-10-07T13:00:00Z",
        )
        assert summary["status"] == "failed" and "events" not in summary, summary
        assert events["status"] == "failed" and "events" not in events, events
        assert proposed["status"] == "runtime_unavailable", proposed

    assert google.requests == [], "no Calendar request for a turn the hub admitted"
    assert hub_reads == [], f"the hub was asked: {hub_reads}"

"""The data door serves a specialist from real state, or degrades cleanly.

These pin the pod-side interception: when a read scope was couriered, the pod
answers the location question from the owner's REAL projected state (rendered
deterministically); when it was NOT -- no grant, unmapped specialist, or a broker
refusal -- it returns None so the caller falls through to the normal dispatch and
today's runtime_unavailable. The one thing that must never happen is a confident
WRONG answer: a broker outage must degrade to "unavailable", never to "you share
with nobody".
"""

from __future__ import annotations

import pytest

from hushh_mcp.one_adk import pod_data_door_specialist as dds
from hushh_mcp.one_adk.agent_tree import STATE_DATA_DOOR_GRANTS
from hushh_mcp.services.pod_hub_client import PodHubUnavailable


class _Ctx:
    def __init__(self, grants: dict | None):
        self.state = {STATE_DATA_DOOR_GRANTS: grants} if grants is not None else {}


class _Broker:
    def __init__(self, projection=None, boom: Exception | None = None):
        self._projection = projection or {}
        self._boom = boom
        self.calls: list[tuple] = []

    def read_specialist(self, name, scope_token):
        self.calls.append((name, scope_token))
        if self._boom:
            raise self._boom
        return self._projection


_PROJECTION = {
    "ownerGrants": [{"status": "active", "recipientDisplayName": "Sarah Chen"}],
    "requests": [{"status": "pending", "requesterDisplayName": "Jordan"}],
    "publicInvites": [{"status": "active"}],
    "circles": [{"name": "Family"}],
}


@pytest.mark.asyncio
async def test_a_couriered_grant_serves_the_answer_from_real_state():
    broker = _Broker(_PROJECTION)
    payload = await dds.serve_specialist_via_data_door(
        "agent_location", _Ctx({"location": "scope-jwt"}), broker=broker
    )
    assert payload is not None
    assert payload["status"] == "ok"
    assert payload["source"] == "data_door"
    assert "Sarah Chen" in payload["text"]
    assert "Jordan is requesting access" in payload["text"]
    assert broker.calls == [("location", "scope-jwt")]


@pytest.mark.asyncio
async def test_no_grant_returns_none_so_the_caller_falls_through():
    broker = _Broker(_PROJECTION)
    payload = await dds.serve_specialist_via_data_door("agent_location", _Ctx({}), broker=broker)
    assert payload is None
    assert broker.calls == [], "no grant means the hub is never called"


@pytest.mark.asyncio
async def test_an_unmapped_specialist_returns_none():
    broker = _Broker(_PROJECTION)
    payload = await dds.serve_specialist_via_data_door(
        "agent_email", _Ctx({"location": "scope-jwt"}), broker=broker
    )
    assert payload is None
    assert broker.calls == []


@pytest.mark.asyncio
async def test_a_broker_outage_degrades_to_none_never_a_wrong_answer():
    broker = _Broker(boom=PodHubUnavailable("hub down"))
    payload = await dds.serve_specialist_via_data_door(
        "agent_location", _Ctx({"location": "scope-jwt"}), broker=broker
    )
    # None -> the caller runs the normal dispatch -> runtime_unavailable. It must
    # NOT return an ok payload built from empty state.
    assert payload is None


@pytest.mark.asyncio
async def test_a_revoked_scope_degrades_to_none():
    broker = _Broker(boom=PodHubUnavailable("hub refused status=403"))
    payload = await dds.serve_specialist_via_data_door(
        "agent_location", _Ctx({"location": "scope-jwt"}), broker=broker
    )
    assert payload is None


# --- the deterministic renderer is faithful to the state, never inventing -------


def test_the_summary_states_no_sharing_when_there_is_none():
    text = dds._format_location_summary({"ownerGrants": [], "requests": []})
    assert "not currently sharing" in text


def test_the_summary_names_who_you_share_with_and_who_is_asking():
    text = dds._format_location_summary(_PROJECTION)
    assert "Sarah Chen" in text
    assert "Jordan is requesting access" in text
    assert "1 active public link" in text
    assert "Family" in text


def test_the_summary_ignores_inactive_grants_and_resolved_requests():
    text = dds._format_location_summary(
        {
            "ownerGrants": [{"status": "revoked", "recipientDisplayName": "Ex"}],
            "requests": [{"status": "denied", "requesterDisplayName": "Nope"}],
        }
    )
    assert "Ex" not in text
    assert "Nope" not in text
    assert "not currently sharing" in text


def test_the_summary_survives_a_degraded_projection():
    assert "could not read" in dds._format_location_summary(None)  # type: ignore[arg-type]

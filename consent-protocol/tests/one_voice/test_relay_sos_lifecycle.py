"""Save My Soul through the relay: card -> tap -> armed -> device step -> verified.

The real SOS tools run over the ``FakeLocationService`` double from
``test_tools_sos``; the relay, executor and pending store are the production
classes. What is pinned here is the wire truth the client and the model see:
arming is never "ok", the same card resolves again with the server-verified
report, the device's claim never reaches the model, and nothing runs on a
spoken "yes".
"""

from __future__ import annotations

import asyncio
import json

import pytest

from hushh_mcp.one_voice import protocol
from hushh_mcp.one_voice.config import OneVoiceLiveConfig
from hushh_mcp.one_voice.live_client import LiveEvent
from hushh_mcp.one_voice.session import AuthResult, VoiceSession
from hushh_mcp.one_voice.tickets import TicketClaims
from hushh_mcp.one_voice.tools import registry, sos
from hushh_mcp.one_voice.tools.executor import PREPARED_KEY, ToolExecutor
from tests.one_voice.fakes import (
    FakeLive,
    FakeTransport,
    MemoryConversationStore,
    MemoryPendingStore,
    live_factory_for,
)
from tests.one_voice.test_tools_sos import (
    AYESHA,
    OWNER,
    RAVI,
    FakeLocationService,
    _grant,
    _ready_service,
)

CONV = "11111111-2222-4333-8444-555555555555"
CLAIMS = TicketClaims(
    user_id=OWNER, session_id="sess-1", conversation_id=CONV, expires_at=9_999_999_999, nonce="n"
)
CONFIG = OneVoiceLiveConfig(
    enabled=True,
    model_id="gemini-live-2.5-flash-native-audio",
    location="us-central1",
    idle_close_seconds=5,
    session_max_minutes=30,
)
AUTH = {"type": "auth", "vault_owner_token": "HCT:token", "conversation_id": CONV}
TOOLS = tuple(sos.TOOLS)


@pytest.fixture(autouse=True)
def _sos_catalog(monkeypatch):
    by_name = {t.name: t for t in TOOLS}
    monkeypatch.setattr(registry, "all_tools", lambda: TOOLS)
    monkeypatch.setattr(registry, "get_tool", lambda name: by_name.get(str(name or "")))
    monkeypatch.setattr(
        registry,
        "declarations",
        lambda: [t.declaration() for t in TOOLS] + list(registry.SESSION_TOOL_DECLARATIONS),
    )


@pytest.fixture
def service(monkeypatch) -> FakeLocationService:
    fake = _ready_service()
    # The tools build the service lazily from the context; hand them the double.
    monkeypatch.setattr(sos, "OneLocationAgentService", lambda: fake)
    return fake


async def _ok_auth(frame, claims):
    return AuthResult(
        user_id=OWNER,
        vault_owner_token=frame.vault_owner_token,
        firebase_id_token=frame.firebase_id_token,
        display_name="Owner",
    )


def _session(transport, fake_live, pending):
    return VoiceSession(
        transport=transport,
        config=CONFIG,
        claims=CLAIMS,
        verify_auth=_ok_auth,
        live_factory=live_factory_for(fake_live),
        executor=ToolExecutor(pending_store=pending),
        conversations=MemoryConversationStore(),
        pending=pending,
    )


def _tool_call(call_id: str, name: str, args: dict | None = None) -> LiveEvent:
    return LiveEvent(
        kind="tool_call", function_calls=[{"id": call_id, "name": name, "args": args or {}}]
    )


def _events(fake: FakeLive) -> list[dict]:
    return [json.loads(text.removeprefix("[ONE_EVENT] ")) for text in fake.events_sent]


async def _arm(transport, fake, pending, *, note: str | None = None):
    """Drive: model proposes -> card -> tap. Returns (session, task, card)."""
    session = _session(transport, fake, pending)
    task = asyncio.create_task(session.run())
    await asyncio.sleep(0.3)
    card = transport.frames("pending_action")[-1]
    transport.push({"type": "pending_action.shown", "pending_action_id": card["pending_action_id"]})
    await asyncio.sleep(0.05)
    return session, task, card


async def test_tap_arms_then_the_device_step_settles_with_the_server_verified_report(
    service: FakeLocationService,
):
    transport = FakeTransport([AUTH])
    fake = FakeLive([_tool_call("c1", "trigger_save_my_soul", {"note": "Car broke down"}), None])
    pending = MemoryPendingStore()
    session, task, card = await _arm(transport, fake, pending)

    # The card was prepared from the live roster and carries its snapshot.
    assert card["tier"] == "tap"
    assert card["summary"].startswith(
        "send a Save My Soul alert to Ayesha Sharma and Ravi Kumar: your precise location for 8 hours"
    )
    assert '"Car broke down"' in card["summary"]
    # The snapshot lives in the stored row, never on the wire.
    assert PREPARED_KEY not in card["args"] and card["args"] == {"note": "Car broke down"}
    stored = pending.rows[card["pending_action_id"]].args[PREPARED_KEY]
    assert sorted(stored["recipient_ids"]) == sorted([AYESHA, RAVI])
    assert service.created == []
    proposal = transport.frames("tool.result")[-1]
    assert proposal["status"] == "confirmation_required" and proposal["ok"] is False

    transport.push(
        {
            "type": "confirm_action",
            "pending_action_id": card["pending_action_id"],
            "receipt_token": card["receipt_token"],
        }
    )
    await asyncio.sleep(0.2)

    # Armed: the card settles, but nothing is ok, complete or "sent".
    armed = transport.frames("pending_action.resolved")[-1]
    assert armed["status"] == "executed"
    assert armed["result_public"]["status"] == "sos_grants_created"
    assert armed["result_public"]["grant_ids"] == ["grant-1", "grant-2"]
    armed_result = transport.frames("tool.result")[-1]
    assert armed_result["tool"] == "trigger_save_my_soul"
    assert armed_result["status"] == "sos_grants_created" and armed_result["ok"] is False
    assert transport.frames("state")[-1]["state"] != "complete"
    assert session._counters.get("tool_results_ok", 0) == 0
    assert session.ctx.sos_incident["grant_ids"] == ["grant-1", "grant-2"]
    assert len(service.created) == 2
    step = transport.frames("client_step.request")[-1]
    assert step["kind"] == "publish_location_envelopes"
    assert step["payload"]["purpose"] == "sos" and step["payload"]["sos"] is True
    assert step["payload"]["grant_ids"] == ["grant-1", "grant-2"]
    assert step["payload"]["timeout_s"] == 60
    # The row stays the durable record of every grant that exists.
    row = pending.rows[card["pending_action_id"]]
    assert row.status == "executed" and row.result["grant_ids"] == ["grant-1", "grant-2"]

    # The device publishes; the server, not the device, decides who was reached.
    for grant in service.owner_grants:
        if grant["id"] == "grant-1":
            grant["latestEnvelopeId"] = "env-1"
    transport.push(
        {
            "type": "client_step.result",
            "step_id": step["step_id"],
            "status": "ok",
            "payload": {"published": ["grant-1", "grant-2"], "reached": ["grant-1", "grant-2"]},
        }
    )
    await asyncio.sleep(0.2)

    settled = transport.frames("pending_action.resolved")[-1]
    assert settled["pending_action_id"] == card["pending_action_id"]
    assert settled["status"] == "executed"
    report = settled["result_public"]
    assert report["status"] == "sos_partial"
    assert report["delivered"] == ["Ayesha Sharma"]
    assert report["not_alerted"] == ["Ravi Kumar"]
    assert report["expected_grant_ids"] == ["grant-1", "grant-2"]
    assert report["device_step"] == {"status": "ok", "late": False}
    verified = transport.frames("tool.result")[-1]
    assert verified["tool"] == "report_save_my_soul_delivery"
    assert verified["status"] == "sos_partial" and verified["ok"] is True
    assert transport.frames("state")[-1]["state"] == "complete"
    assert session._counters.get("tool_results_ok", 0) == 1
    # The model hears only the server's verification, never the device's claim.
    event = _events(fake)[-1]
    assert event["kind"] == "tool_result" and event["tool"] == "report_save_my_soul_delivery"
    assert event["confirmation_source"] == "device"
    assert '"reached"' not in json.dumps(event)  # the device's claimed list
    assert "payload" not in event and "published" not in json.dumps(event)
    assert not any("published" in text for text in fake.events_sent)

    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)


async def test_spoken_yes_never_arms_and_a_bad_receipt_never_arms(service: FakeLocationService):
    transport = FakeTransport([AUTH])
    fake = FakeLive([_tool_call("c1", "trigger_save_my_soul"), None])
    pending = MemoryPendingStore()
    session, task, card = await _arm(transport, fake, pending)
    # The model relays a spoken "yes": tap tier refuses it and nothing runs.
    spoken = await session.executor.call(
        session.ctx, "confirm_pending_action", {"pending_action_id": card["pending_action_id"]}
    )
    assert spoken.result.status == "tap_required"
    assert spoken.result.needs == "confirmation"
    assert service.created == []
    assert pending.rows[card["pending_action_id"]].status == "pending"

    transport.push(
        {
            "type": "confirm_action",
            "pending_action_id": card["pending_action_id"],
            "receipt_token": "forged",
        }
    )
    await asyncio.sleep(0.1)
    refused = transport.frames("pending_action.resolved")[-1]
    assert refused["status"] == "not_pending"
    assert refused["result_public"]["reason_code"] == "receipt_invalid"
    assert service.created == []
    assert session.ctx.sos_incident is None
    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)


async def test_failed_or_lost_publish_reports_not_sent_and_keeps_the_grants_revocable(
    service: FakeLocationService,
):
    transport = FakeTransport([AUTH])
    fake = FakeLive([_tool_call("c1", "trigger_save_my_soul"), None])
    pending = MemoryPendingStore()
    session, task, card = await _arm(transport, fake, pending)
    transport.push(
        {
            "type": "confirm_action",
            "pending_action_id": card["pending_action_id"],
            "receipt_token": card["receipt_token"],
        }
    )
    await asyncio.sleep(0.2)
    step = transport.frames("client_step.request")[-1]
    transport.push(
        {
            "type": "client_step.result",
            "step_id": step["step_id"],
            "status": "failed",
            "payload": {"code": "permission_denied", "grant_ids": step["payload"]["grant_ids"]},
        }
    )
    await asyncio.sleep(0.2)
    settled = transport.frames("pending_action.resolved")[-1]
    assert settled["status"] == "failed"
    assert settled["result_public"]["status"] == "sos_not_sent"
    assert settled["result_public"]["alert_active"] is True
    assert "still armed" in " ".join(settled["result_public"]["spoken_facts"])
    assert transport.frames("tool.result")[-1]["ok"] is False
    assert session._counters.get("tool_results_rejected", 0) == 1
    assert transport.frames("state")[-1]["state"] != "complete"
    # Nothing was revoked by the failure; the grants are still there to stop.
    assert service.revoked == []
    assert session.ctx.sos_incident["grant_ids"] == ["grant-1", "grant-2"]

    # A second report for the same step is refused: one claim per step.
    transport.push(
        {
            "type": "client_step.result",
            "step_id": step["step_id"],
            "status": "ok",
            "payload": {"published": ["grant-1", "grant-2"]},
        }
    )
    await asyncio.sleep(0.1)
    assert transport.frames("error")[-1]["message"] == "unknown_client_step"
    assert transport.frames("pending_action.resolved")[-1] is settled
    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)


async def test_stop_card_names_the_live_shares_and_the_tap_ends_them(
    service: FakeLocationService,
):
    service.owner_grants = [
        _grant("g1", AYESHA, "Ayesha Sharma", envelope=True),
        _grant("g2", RAVI, "Ravi Kumar", envelope=True),
    ]
    transport = FakeTransport([AUTH])
    fake = FakeLive([_tool_call("c1", "stop_save_my_soul"), None])
    pending = MemoryPendingStore()
    session, task, card = await _arm(transport, fake, pending)
    assert card["summary"] == (
        "stop Save My Soul and end 2 live location shares to Ayesha Sharma and Ravi Kumar"
    )
    assert PREPARED_KEY not in card["args"]
    assert pending.rows[card["pending_action_id"]].args[PREPARED_KEY] == {"grant_ids": ["g1", "g2"]}
    assert service.revoked == []
    transport.push(
        {
            "type": "confirm_action",
            "pending_action_id": card["pending_action_id"],
            "receipt_token": card["receipt_token"],
        }
    )
    await asyncio.sleep(0.2)
    resolved = transport.frames("pending_action.resolved")[-1]
    assert resolved["status"] == "executed"
    assert resolved["result_public"]["status"] == "sos_stopped"
    assert resolved["result_public"]["stopped_count"] == 2
    assert service.revoked == ["g1", "g2"]
    assert transport.frames("tool.result")[-1]["ok"] is True
    assert session.ctx.sos_incident is None
    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)


async def test_no_card_when_the_roster_is_unreadable_or_an_alert_is_live(
    service: FakeLocationService,
):
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentError

    service.roster_error = OneLocationAgentError("LOCATION_UNAVAILABLE", "Location is unavailable.")
    transport = FakeTransport([AUTH])
    fake = FakeLive([_tool_call("c1", "trigger_save_my_soul"), None])
    pending = MemoryPendingStore()
    session = _session(transport, fake, pending)
    task = asyncio.create_task(session.run())
    await asyncio.sleep(0.3)
    assert transport.frames("pending_action") == []
    result = transport.frames("tool.result")[-1]
    assert result["status"] == "rejected" and result["ok"] is False
    assert result["result_public"]["reason_code"] == "roster_unavailable"
    assert pending.rows == {}

    service.roster_error = None
    service.owner_grants = [_grant("g1", AYESHA, "Ayesha Sharma", envelope=True)]
    outcome = await session.executor.call(session.ctx, "trigger_save_my_soul", {})
    assert outcome.pending is None
    assert outcome.result.status == "already_active"
    assert session.ctx.sos_incident["grant_ids"] == ["g1"]
    assert service.created == []
    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)


async def test_awaiting_device_statuses_are_wire_not_ok():
    assert protocol.SOS_GRANTS_CREATED in protocol.NOT_OK_STATUSES
    assert (
        protocol.tool_result(
            call_id=None,
            tool="trigger_save_my_soul",
            result_public={"status": "sos_grants_created"},
        )["ok"]
        is False
    )


async def test_audience_drift_after_the_card_refuses_on_tap_and_creates_nothing(
    service: FakeLocationService,
):
    """The snapshot must reach the handler: a roster that changed between the
    card and the tap is refused end to end, not silently re-targeted."""
    transport = FakeTransport([AUTH])
    fake = FakeLive([_tool_call("c1", "trigger_save_my_soul"), None])
    pending = MemoryPendingStore()
    session, task, card = await _arm(transport, fake, pending)
    from tests.one_voice.test_tools_sos import MEERA

    service.sms_contact_ids = [AYESHA, RAVI, MEERA]  # Meera joined the roster after the card
    transport.push(
        {
            "type": "confirm_action",
            "pending_action_id": card["pending_action_id"],
            "receipt_token": card["receipt_token"],
        }
    )
    await asyncio.sleep(0.2)
    resolved = transport.frames("pending_action.resolved")[-1]
    assert resolved["status"] == "failed"
    assert resolved["result_public"]["reason_code"] == "sos_audience_changed"
    assert service.created == []
    assert transport.frames("client_step.request") == []
    assert session.ctx.sos_incident is None
    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)


async def test_a_late_device_report_still_verifies_and_is_marked_late(
    service: FakeLocationService,
):
    transport = FakeTransport([AUTH])
    fake = FakeLive([_tool_call("c1", "trigger_save_my_soul"), None])
    pending = MemoryPendingStore()
    session, task, card = await _arm(transport, fake, pending)
    transport.push(
        {
            "type": "confirm_action",
            "pending_action_id": card["pending_action_id"],
            "receipt_token": card["receipt_token"],
        }
    )
    await asyncio.sleep(0.2)
    step = transport.frames("client_step.request")[-1]
    for grant in service.owner_grants:
        grant["latestEnvelopeId"] = f"env-{grant['id']}"
    real_clock = session.clock
    session.clock = lambda: real_clock() + 10_000  # far past timeout + grace
    transport.push(
        {
            "type": "client_step.result",
            "step_id": step["step_id"],
            "status": "ok",
            "payload": {"published": ["grant-1", "grant-2"]},
        }
    )
    await asyncio.sleep(0.2)
    settled = transport.frames("pending_action.resolved")[-1]
    assert settled["status"] == "executed"
    assert settled["result_public"]["status"] == "sos_sent"
    assert settled["result_public"]["device_step"] == {"status": "ok", "late": True}
    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)

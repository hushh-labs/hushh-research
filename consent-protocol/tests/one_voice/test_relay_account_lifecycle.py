"""Relay lifecycle for reset_account / delete_account.

Proves the full loop through the real VoiceSession: the model proposes, a
tap-tier card is shown, a spoken yes cannot arm it, the tap issues an
account_lifecycle device step bound to owner+operation, and the device's
report is settled by the server verifier -- the raw claim never reaches the
model, and the card resolves a second time with the verified outcome.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from hushh_mcp.one_voice.config import OneVoiceLiveConfig
from hushh_mcp.one_voice.live_client import LiveEvent
from hushh_mcp.one_voice.session import AuthResult, VoiceSession
from hushh_mcp.one_voice.tickets import TicketClaims
from hushh_mcp.one_voice.tools import account_lifecycle as lifecycle
from hushh_mcp.one_voice.tools import registry
from hushh_mcp.one_voice.tools.executor import ToolExecutor
from tests.one_voice.fakes import (
    FakeLive,
    FakeTransport,
    MemoryConversationStore,
    MemoryPendingStore,
    live_factory_for,
)
from tests.one_voice.test_tools_account_lifecycle import AccountDouble, LifecycleDouble

OWNER = "firebase-user-123456789012"
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
TOOLS = tuple(lifecycle.TOOLS)


@pytest.fixture(autouse=True)
def _catalog(monkeypatch):
    by_name = {t.name: t for t in TOOLS}
    monkeypatch.setattr(registry, "all_tools", lambda: TOOLS)
    monkeypatch.setattr(registry, "get_tool", lambda name: by_name.get(str(name or "")))
    monkeypatch.setattr(
        registry,
        "declarations",
        lambda: [t.declaration() for t in TOOLS] + list(registry.SESSION_TOOL_DECLARATIONS),
    )


@pytest.fixture
def doubles(monkeypatch):
    life = LifecycleDouble()
    account = AccountDouble({"setup_completed": True, "setup_state_updated_at_ms": 1})
    monkeypatch.setattr(lifecycle, "AccountDeletionLifecycleService", lambda: life)
    monkeypatch.setattr(lifecycle, "AccountService", lambda: account)
    return life, account


async def _ok_auth(frame, claims):
    return AuthResult(
        user_id=OWNER,
        vault_owner_token=frame.vault_owner_token,
        firebase_id_token=frame.firebase_id_token,
        display_name="Owner",
    )


FRESH_PROOF = "firebase:fresh-proof"


async def _actor_proof(token: str | None, user_id: str) -> str:
    """Both tools sit on the Firebase plane: the tap must carry a fresh,
    verified proof naming this session's user. Only the fixture token passes."""
    if not token:
        return "missing"
    return "ok" if token == FRESH_PROOF and user_id == OWNER else "invalid"


def _session(transport, fake_live, pending):
    return VoiceSession(
        transport=transport,
        config=CONFIG,
        claims=CLAIMS,
        verify_auth=_ok_auth,
        live_factory=live_factory_for(fake_live),
        executor=ToolExecutor(pending_store=pending, actor_proof=_actor_proof),
        conversations=MemoryConversationStore(),
        pending=pending,
    )


def _tool_call(call_id: str, name: str, args: dict | None = None) -> LiveEvent:
    return LiveEvent(
        kind="tool_call", function_calls=[{"id": call_id, "name": name, "args": args or {}}]
    )


def _events(fake: FakeLive) -> list[dict]:
    return [json.loads(text.removeprefix("[ONE_EVENT] ")) for text in fake.events_sent]


async def _card(transport, fake, pending):
    session = _session(transport, fake, pending)
    task = asyncio.create_task(session.run())
    await asyncio.sleep(0.3)
    card = transport.frames("pending_action")[-1]
    transport.push({"type": "pending_action.shown", "pending_action_id": card["pending_action_id"]})
    await asyncio.sleep(0.05)
    return session, task, card


async def _tap(transport, card, *, proof: str | None = FRESH_PROOF):
    frame = {
        "type": "confirm_action",
        "pending_action_id": card["pending_action_id"],
        "receipt_token": card["receipt_token"],
    }
    if proof is not None:
        frame["firebase_id_token"] = proof
    transport.push(frame)
    await asyncio.sleep(0.2)


async def test_reset_tap_issues_a_device_step_and_the_server_stamp_settles_it(doubles):
    _life, account = doubles
    transport = FakeTransport([AUTH])
    fake = FakeLive([_tool_call("c1", "reset_account"), None])
    pending = MemoryPendingStore()
    session, task, card = await _card(transport, fake, pending)

    assert card["tier"] == "tap"
    assert "keep your sign-in and vault" in card["summary"]
    assert transport.frames("tool.result")[-1]["status"] == "confirmation_required"

    await _tap(transport, card)

    issued = transport.frames("pending_action.resolved")[-1]
    assert issued["status"] == "executed"
    assert issued["result_public"]["status"] == "reset_step_issued"
    issued_result = transport.frames("tool.result")[-1]
    assert issued_result["status"] == "reset_step_issued" and issued_result["ok"] is False
    assert session._counters.get("tool_results_ok", 0) == 0
    step = transport.frames("client_step.request")[-1]
    assert step["kind"] == "account_lifecycle"
    assert step["payload"]["operation"] == "reset"
    assert step["payload"]["user_id"] == OWNER
    issued_at = step["payload"]["issued_at_ms"]

    # The device ran the reset; the server now sees a fresh stamp.
    account.evidence = {"setup_completed": None, "setup_state_updated_at_ms": issued_at + 10}
    transport.push(
        {
            "type": "client_step.result",
            "step_id": step["step_id"],
            "status": "ok",
            "payload": {"outcome": "reset", "token_seen": "HCT:should-never-reach-model"},
        }
    )
    await asyncio.sleep(0.2)

    settled = transport.frames("pending_action.resolved")[-1]
    assert settled["pending_action_id"] == card["pending_action_id"]
    report = settled["result_public"]
    assert report["status"] == "account_reset"
    assert report["operation"] == "reset"
    assert report["device_step"] == {"status": "ok", "late": False}
    verified = transport.frames("tool.result")[-1]
    assert verified["tool"] == "report_account_lifecycle"
    assert verified["status"] == "account_reset" and verified["ok"] is True
    assert session._counters.get("tool_results_ok", 0) == 1
    # The verifier was asked about the step's owner, not anything the device said.
    assert account.calls == [OWNER]
    # The model hears the server's verification, never the device payload.
    event = _events(fake)[-1]
    assert event["kind"] == "tool_result" and event["tool"] == "report_account_lifecycle"
    assert event["confirmation_source"] == "device"
    assert "should-never-reach-model" not in "".join(fake.events_sent)
    assert "token_seen" not in "".join(fake.events_sent)

    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)


async def test_delete_device_reports_deleted_but_no_tombstone_is_not_narrated_as_deleted(doubles):
    life, _account = doubles
    life.tombstoned = False
    transport = FakeTransport([AUTH])
    fake = FakeLive([_tool_call("c1", "delete_account"), None])
    pending = MemoryPendingStore()
    session, task, card = await _card(transport, fake, pending)
    assert "cannot be undone" in card["summary"]

    await _tap(transport, card)
    step = transport.frames("client_step.request")[-1]
    assert step["payload"]["operation"] == "delete"

    transport.push(
        {
            "type": "client_step.result",
            "step_id": step["step_id"],
            "status": "ok",
            "payload": {"outcome": "deleted"},
        }
    )
    await asyncio.sleep(0.2)

    settled = transport.frames("pending_action.resolved")[-1]["result_public"]
    assert settled["status"] == "not_changed"
    assert "Nothing was deleted" in settled["spoken_facts"][0]
    assert transport.frames("tool.result")[-1]["ok"] is False
    assert session._counters.get("tool_results_ok", 0) == 0

    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)


async def test_delete_tombstone_settles_deleted_even_when_the_device_reply_is_lost(doubles):
    life, _account = doubles
    transport = FakeTransport([AUTH])
    fake = FakeLive([_tool_call("c1", "delete_account"), None])
    pending = MemoryPendingStore()
    session, task, card = await _card(transport, fake, pending)
    await _tap(transport, card)
    step = transport.frames("client_step.request")[-1]

    # Deletion committed server-side; the device then lost its reply (signed out).
    life.tombstoned = True
    transport.push(
        {
            "type": "client_step.result",
            "step_id": step["step_id"],
            "status": "failed",
            "payload": {},
        }
    )
    await asyncio.sleep(0.2)

    settled = transport.frames("pending_action.resolved")[-1]["result_public"]
    assert settled["status"] == "account_deleted"
    assert settled["device_step"]["status"] == "failed"
    assert transport.frames("tool.result")[-1]["ok"] is True

    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)


async def test_needs_unlock_from_the_device_is_an_honest_handoff_not_a_change(doubles):
    transport = FakeTransport([AUTH])
    fake = FakeLive([_tool_call("c1", "reset_account"), None])
    pending = MemoryPendingStore()
    session, task, card = await _card(transport, fake, pending)
    await _tap(transport, card)
    step = transport.frames("client_step.request")[-1]

    transport.push(
        {
            "type": "client_step.result",
            "step_id": step["step_id"],
            "status": "ok",
            "payload": {"outcome": "needs_unlock"},
        }
    )
    await asyncio.sleep(0.2)

    settled = transport.frames("pending_action.resolved")[-1]["result_public"]
    assert settled["status"] == "needs_unlock"
    assert "Unlock your vault in Profile first" in settled["spoken_facts"][0]
    assert session._counters.get("tool_results_ok", 0) == 0

    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)


async def test_a_tap_without_fresh_sign_in_proof_is_refused_and_the_card_stays(doubles):
    transport = FakeTransport([AUTH])
    fake = FakeLive([_tool_call("c1", "delete_account"), None])
    pending = MemoryPendingStore()
    session, task, card = await _card(transport, fake, pending)

    await _tap(transport, card, proof=None)
    errors = transport.frames("error")
    assert errors and errors[-1]["code"] == "firebase_proof_required"
    assert transport.frames("client_step.request") == []
    assert pending.rows[card["pending_action_id"]].status == "pending"

    await _tap(transport, card, proof="firebase:stale-or-forged")
    assert transport.frames("error")[-1]["code"] == "firebase_proof_invalid"
    assert transport.frames("client_step.request") == []

    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)


async def test_issued_statuses_are_wire_not_ok():
    from hushh_mcp.one_voice import protocol

    for status in (protocol.RESET_STEP_ISSUED, protocol.DELETE_STEP_ISSUED):
        assert status in protocol.NOT_OK_STATUSES
        frame = protocol.tool_result(
            call_id=None, tool="reset_account", result_public={"status": status}
        )
        assert frame["ok"] is False


async def test_spoken_yes_and_a_forged_receipt_never_issue_a_step(doubles):
    transport = FakeTransport([AUTH])
    fake = FakeLive(
        [
            _tool_call("c1", "delete_account"),
            _tool_call("c2", "confirm_pending_action", {"pending_action_id": "PLACEHOLDER"}),
            None,
        ]
    )
    pending = MemoryPendingStore()
    session, task, card = await _card(transport, fake, pending)
    # Patch the placeholder to the real card id so the model's "yes" targets it.
    fake.script[0].function_calls[0]["args"]["pending_action_id"] = card["pending_action_id"]
    await asyncio.sleep(0.3)
    transport.push(
        {
            "type": "confirm_action",
            "pending_action_id": card["pending_action_id"],
            "receipt_token": "forged-receipt",
        }
    )
    await asyncio.sleep(0.2)

    assert transport.frames("client_step.request") == []
    assert all(
        f["result_public"].get("status") != "delete_step_issued"
        for f in transport.frames("pending_action.resolved")
    )

    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)

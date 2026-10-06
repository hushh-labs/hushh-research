"""Typed "Edit name" on an open create_circle card (UAT 2026-10-06, gap 6).

The person types the name; the relay replaces that exact card through the same
executor path a model proposal takes, marked person-authored, and the typed
text never passes through Live for reinterpretation.
"""

from __future__ import annotations

import json
import logging
import uuid

import pytest

from hushh_mcp.one_voice import protocol
from hushh_mcp.one_voice.config import OneVoiceLiveConfig
from hushh_mcp.one_voice.live_client import LiveEvent
from hushh_mcp.one_voice.pending_actions import PendingAction
from hushh_mcp.one_voice.session import AuthResult, VoiceSession
from hushh_mcp.one_voice.tickets import TicketClaims
from hushh_mcp.one_voice.tools.circles import CIRCLE_SERVICE
from hushh_mcp.one_voice.tools.executor import ToolExecutor
from tests.one_voice.fakes import (
    FakeLive,
    FakeTransport,
    MemoryConversationStore,
    MemoryPendingStore,
    live_factory_for,
)
from tests.one_voice.test_tools_circles import FakeCircleService

USER = "user-1"
CONV = "11111111-2222-4333-8444-555555555555"
OTHER_CONV = "99999999-2222-4333-8444-555555555555"
CLAIMS = TicketClaims(
    user_id=USER, session_id="sess-1", conversation_id=CONV, expires_at=9_999_999_999, nonce="n"
)
CONFIG = OneVoiceLiveConfig(
    enabled=True,
    model_id="gemini-live-2.5-flash-native-audio",
    location="us-central1",
    idle_close_seconds=5,
    session_max_minutes=30,
)


async def _never_called(frame, claims):  # pragma: no cover - sessions here skip auth
    raise AssertionError("auth is not part of these tests")


async def _session_with_card(args: dict | None = None):
    """An open create_circle card, proposed by the model on the person's turn."""
    transport = FakeTransport()
    fake = FakeLive([])
    pending = MemoryPendingStore()
    session = VoiceSession(
        transport=transport,
        config=CONFIG,
        claims=CLAIMS,
        verify_auth=_never_called,
        live_factory=live_factory_for(fake),
        executor=ToolExecutor(pending_store=pending),
        conversations=MemoryConversationStore(),
        pending=pending,
    )
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic test authority
    )
    session.live = fake
    await session._handle_client_frame(
        protocol.TextFrame(type="text", text="Create a friends circle")
    )
    await session._dispatch_tool_call(
        {
            "id": "c1",
            "name": "create_circle",
            "args": args or {"name": "Hush Garage V4", "kind": "friends"},
        }
    )
    card = transport.frames("pending_action")[-1]
    transport.sent.clear()
    fake.events_sent.clear()
    fake.tool_responses.clear()
    fake.texts.clear()
    return session, transport, fake, pending, card["pending_action_id"]


def _submit(pending_action_id: str, name: str, operation_id: str | None = None):
    return protocol.parse_client_frame(
        json.dumps(
            {
                "type": "name_edit.submit",
                "pending_action_id": pending_action_id,
                "name": name,
                "operation_id": operation_id or uuid.uuid4().hex,
            }
        )
    )


def _events(fake: FakeLive) -> list[dict]:
    return [json.loads(e.removeprefix("[ONE_EVENT] ")) for e in fake.events_sent]


def test_relay_advertises_name_edit_and_parses_the_submit_frame():
    ready = protocol.session_ready(
        session_id="s",
        conversation_id=CONV,
        model="m",
        resumed=False,
        idle_timeout_ms=1,
        session_max_ms=1,
        pending_actions=[],
    )
    assert "name_edit" in ready["features"]
    frame = _submit(str(uuid.uuid4()), "Home", "op-1234567")
    assert frame.type == "name_edit.submit" and frame.name == "Home"
    # Negative control: the frame is closed like every other client frame.
    with pytest.raises(protocol.FrameError):
        protocol.parse_client_frame(
            json.dumps(
                {
                    "type": "name_edit.submit",
                    "pending_action_id": str(uuid.uuid4()),
                    "name": "Home",
                    "operation_id": "op-1234567",
                    "kind": "family",
                }
            )
        )


async def test_typed_name_replaces_the_open_card_without_passing_through_live(monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    session, transport, fake, pending, old_id = await _session_with_card()
    seen_contexts = []
    original_call = session.executor.call

    async def _spy(ctx, name, args, **kwargs):
        seen_contexts.append((ctx, name, dict(args or {})))
        return await original_call(ctx, name, args, **kwargs)

    monkeypatch.setattr(session.executor, "call", _spy)

    await session._handle_client_frame(_submit(old_id, "  HUSSH   GARAGE  V04 "))

    assert pending.rows[old_id].status == "cancelled"
    resolved = transport.frames("pending_action.resolved")
    assert [(r["pending_action_id"], r["status"]) for r in resolved] == [(old_id, "cancelled")]
    card = transport.frames("pending_action")[-1]
    new_id = card["pending_action_id"]
    assert new_id != old_id and pending.rows[new_id].status == "pending"
    assert card["tool"] == "create_circle"
    assert card["args"]["name"] == "HUSSH GARAGE V04" and card["args"]["kind"] == "friends"
    result = transport.frames("name_edit.result")
    assert result == [
        {
            "type": "name_edit.result",
            "operation_id": result[0]["operation_id"],
            "status": "accepted",
            "reason_code": None,
            "message": None,
            "pending_action_id": new_id,
        }
    ]
    # The proposal ran through the executor, marked person-authored (C2) on a
    # copy only: the shared context the model's own calls use stays unmarked.
    [(ctx, name, args)] = seen_contexts
    assert name == "create_circle"
    assert args == {"name": "HUSSH GARAGE V04", "kind": "friends"}
    assert getattr(ctx, "typed_name", False) is True
    assert ctx is not session.ctx and getattr(session.ctx, "typed_name", False) is False
    assert ctx.entities is session.ctx.entities
    # The model hears about it once, as an app event; the typed text never
    # enters Live as the person's words, and no tool response is invented.
    [event] = _events(fake)
    assert event["kind"] == "name_edited"
    assert event["pending_action_id"] == new_id
    assert event["replaced_pending_action_id"] == old_id
    assert fake.texts == [] and fake.tool_responses == []
    # Operational logs carry the outcome, never the name.
    assert "one_voice.name_edit" in caplog.text and "status=accepted" in caplog.text
    assert "GARAGE" not in caplog.text.upper()


@pytest.mark.parametrize("moment", ["after_read_back", "while_new_speech_waits"])
async def test_the_replacement_card_rides_a_turn_the_client_still_shows(moment):
    # The person edits once One has read the card back. Live has completed the
    # input turn and the read-back, and the client fenced both at model_end:
    # a card sent on either is dropped and nothing can be tapped (UAT gap 6).
    # While newer speech waits for Live to finish, the client follows that
    # input instead, and a card on any other turn is dropped the same way.
    session, transport, fake, pending, old_id = await _session_with_card()
    session.ctx.services[CIRCLE_SERVICE] = FakeCircleService()
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    await session._handle_live_event(
        LiveEvent(kind="output_transcript", text="Should I create it?", finished=True)
    )
    if moment == "after_read_back":
        await session._handle_live_event(LiveEvent(kind="turn_complete"))
    else:
        await session._handle_live_event(LiveEvent(kind="input_transcript", text="Um"))

    await session._handle_client_frame(_submit(old_id, "HUSSH GARAGE V04"))

    card = transport.frames("pending_action")[-1]
    assert card["pending_action_id"] != old_id
    assert card["turn_id"] not in {frame["turn_id"] for frame in transport.frames("turn")}
    if moment == "while_new_speech_waits":
        [heard] = transport.frames("transcript.input")
        assert card["turn_id"] == heard["turn_id"]
    # A tap on it reports there: its result reaches the screen and the model.
    transport.sent.clear()
    fake.events_sent.clear()
    await session._handle_client_frame(
        protocol.parse_client_frame(
            json.dumps({"type": "confirm_action", "pending_action_id": card["pending_action_id"]})
        )
    )
    [result] = transport.frames("tool.result")
    assert result["pending_action_id"] == card["pending_action_id"]
    assert result["turn_id"] == card["turn_id"] and result["ok"] is True
    assert [event["kind"] for event in _events(fake)] == ["tool_result"]


@pytest.mark.parametrize("via", ["typed", "heard"])
async def test_a_typed_name_is_kept_as_written_over_an_earlier_spelling(via):
    # HUSSH was spelled for the card under review, and the new name drops it
    # and changes V04 without declaring either. Typed, it is the person's own
    # and the card shows it exactly; the same text heard from the model is
    # refused (negative control), so the typed mark is what lets it through.
    session, transport, fake, pending, old_id = await _session_with_card(
        {"name": "HUSSH GARAGE V04", "kind": "friends", "spelled_words": ["H U S S H"]}
    )
    if via == "heard":
        await session._dispatch_tool_call(
            {"id": "c2", "name": "create_circle", "args": {"name": "Hush Garage V05"}}
        )
        [response] = fake.tool_responses
        assert response["response"]["status"] == "rejected"
        assert transport.frames("pending_action") == []
        return

    await session._handle_client_frame(_submit(old_id, "Hush Garage V05"))

    [result] = transport.frames("name_edit.result")
    assert result["status"] == "accepted"
    card = transport.frames("pending_action")[-1]
    assert card["args"]["name"] == "Hush Garage V05"
    assert pending.rows[card["pending_action_id"]].status == "pending"
    assert "spelled" not in card["summary"]
    # It is now the name under review: a later heard correction of one word
    # keeps the typed rest and needs no earlier spelling.
    await session._dispatch_tool_call(
        {
            "id": "c3",
            "name": "create_circle",
            "args": {
                "name": "Hush Garage V06",
                "kind": "friends",
                "changed_words": [{"old": "V05", "new": "V06"}],
            },
        }
    )
    assert transport.frames("pending_action")[-1]["args"]["name"] == "Hush Garage V06"


async def test_repeated_operation_returns_the_same_result_and_no_second_card():
    session, transport, fake, pending, old_id = await _session_with_card()
    frame = _submit(old_id, "HUSSH GARAGE V04", "op-repeat-1")
    await session._handle_client_frame(frame)
    await session._handle_client_frame(frame)

    results = transport.frames("name_edit.result")
    assert len(results) == 2 and results[0] == results[1]
    assert results[0]["status"] == "accepted"
    assert len(transport.frames("pending_action")) == 1
    assert [row.status for row in pending.rows.values()].count("pending") == 1
    assert len(_events(fake)) == 1


def _foreign_row(pending: MemoryPendingStore, **overrides) -> str:
    row = PendingAction(
        id=str(uuid.uuid4()),
        user_id=USER,
        conversation_id=CONV,
        tool_name="create_circle",
        gateway_action_id="location.create_circle",
        tier="voice",
        args={"name": "Home", "kind": "family"},
        summary="create a family circle called Home",
        status="pending",
    )
    for key, value in overrides.items():
        setattr(row, key, value)
    pending.rows[row.id] = row
    return row.id


@pytest.mark.parametrize(
    ("case", "reason_code"),
    [
        ("cancelled", "not_pending"),
        ("wrong_tool", "not_editable"),
        ("other_conversation", "not_pending"),
        ("other_owner", "not_pending"),
        ("unknown", "not_pending"),
    ],
)
async def test_a_card_that_is_not_an_open_create_circle_here_is_refused_untouched(
    case, reason_code
):
    session, transport, fake, pending, open_id = await _session_with_card()
    if case == "cancelled":
        target = _foreign_row(pending, status="cancelled")
    elif case == "wrong_tool":
        target = _foreign_row(
            pending, tool_name="delete_circle", gateway_action_id="location.delete_circle"
        )
    elif case == "other_conversation":
        target = _foreign_row(pending, conversation_id=OTHER_CONV)
    elif case == "other_owner":
        target = _foreign_row(pending, user_id="user-2")
    else:
        target = str(uuid.uuid4())
    before = {row_id: row.status for row_id, row in pending.rows.items()}

    await session._handle_client_frame(_submit(target, "HUSSH GARAGE V04"))

    [result] = transport.frames("name_edit.result")
    assert result["status"] == "rejected" and result["reason_code"] == reason_code
    assert result["pending_action_id"] is None and result["message"]
    assert {row_id: row.status for row_id, row in pending.rows.items()} == before
    assert pending.rows[open_id].status == "pending"
    assert transport.frames("pending_action") == []
    assert transport.frames("pending_action.resolved") == []
    assert fake.events_sent == []


@pytest.mark.parametrize(
    ("name", "accepted"),
    [
        ("", False),
        ("   \t ", False),
        ("x" * 81, False),
        ("Hussh\x07Garage", False),
        # Joiners are format characters the tool's own bounds accept: an emoji
        # sequence and Persian text are names the person can type.
        ("\U0001f468\u200d\U0001f469\u200d\U0001f467 Family", True),
        ("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645", True),
    ],
)
async def test_a_typed_name_outside_the_tools_bounds_is_refused_and_the_card_stays_open(
    name, accepted
):
    session, transport, fake, pending, old_id = await _session_with_card()

    await session._handle_client_frame(_submit(old_id, name))

    [result] = transport.frames("name_edit.result")
    if accepted:
        assert result["status"] == "accepted"
        assert transport.frames("pending_action")[-1]["args"]["name"] == name
        return
    assert result["status"] == "rejected" and result["reason_code"] == "invalid_name"
    assert result["message"]
    assert pending.rows[old_id].status == "pending"
    assert transport.frames("pending_action") == []
    assert transport.frames("pending_action.resolved") == []
    assert fake.events_sent == []


async def test_a_confirmation_that_wins_the_race_is_not_replaced(monkeypatch):
    session, transport, fake, pending, old_id = await _session_with_card()
    original_cancel = pending.cancel

    async def _confirmed_first(*, user_id, pending_action_id):
        # The tap's compare-and-set lands between the read and the cancel.
        pending.rows[pending_action_id].status = "confirmed"
        return await original_cancel(user_id=user_id, pending_action_id=pending_action_id)

    monkeypatch.setattr(pending, "cancel", _confirmed_first)

    await session._handle_client_frame(_submit(old_id, "HUSSH GARAGE V04"))

    [result] = transport.frames("name_edit.result")
    assert result["status"] == "rejected" and result["reason_code"] == "already_confirmed"
    assert pending.rows[old_id].status == "confirmed"
    assert len(pending.rows) == 1
    assert transport.frames("pending_action") == []
    assert transport.frames("pending_action.resolved") == []
    assert fake.events_sent == []

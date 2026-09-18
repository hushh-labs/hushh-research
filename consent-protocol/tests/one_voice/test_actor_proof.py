"""The people/profile plane re-proves the actor at the mutation boundary.

Session auth verifies a Firebase proof once. Tokens expire and can be revoked,
and a tap can carry any string, so a firebase-plane confirmation -- spoken,
tapped, or over HTTP -- verifies the proof again immediately before the
pending row is confirmed. A refused proof leaves the row pending: a tap with a
fresh proof can still complete it. A non-empty string is not proof.
"""

from __future__ import annotations

import asyncio
from typing import Any, Literal

import pytest

from hushh_mcp.one_voice import actor_proof
from hushh_mcp.one_voice.tools import registry
from hushh_mcp.one_voice.tools.base import (
    ConfirmedPerson,
    EntityContext,
    PersonRef,
    ScreenContext,
    ToolContext,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
    now_iso,
)
from hushh_mcp.one_voice.tools.executor import FIREBASE_PROOF_REQUIRED, ToolExecutor
from tests.one_voice.fakes import MemoryPendingStore

USER = "user-me"
PRIYA = "user-priya"


class _SendInput(ToolInput):
    person: PersonRef


class _SendResult(ToolResult):
    status: Literal["sent"]


async def _send(ctx: ToolContext, args: _SendInput) -> ToolResult:
    return _SendResult(status="sent", spoken_facts=["sent"])


SEND = ToolSpec(
    name="send_thing",
    gateway_action_id="people.profile.connect",
    policy=ToolPolicy.confirm_voice,
    input_model=_SendInput,
    output_model=_SendResult,
    description="Send.",
    handler=_send,
    person_args=("person",),
    firebase_plane=True,
    summarize=lambda ctx, a: "send the thing",
)
PLAIN = ToolSpec(
    name="plain_thing",
    gateway_action_id="location.create_circle",
    policy=ToolPolicy.confirm_voice,
    input_model=_SendInput,
    output_model=_SendResult,
    description="Plain.",
    handler=_send,
    person_args=("person",),
    summarize=lambda ctx, a: "do the plain thing",
)


@pytest.fixture(autouse=True)
def _catalog(monkeypatch):
    by_name = {SEND.name: SEND, PLAIN.name: PLAIN}
    monkeypatch.setattr(registry, "get_tool", lambda name: by_name.get(str(name or "")))


def _ctx(token: str | None) -> ToolContext:
    entities = EntityContext()
    entities.remember_person(
        ConfirmedPerson(user_id=PRIYA, display_name="Priya", confirmed_at=now_iso())
    )
    return ToolContext(
        user_id=USER,
        conversation_id="11111111-1111-4111-8111-111111111111",
        entities=entities,
        screen=ScreenContext(),
        vault_owner_token="vault",  # noqa: S106
        firebase_id_token=token,
    )


def _proof(outcomes: dict[str, str]):
    calls: list[tuple[str | None, str]] = []

    async def prove(token: str | None, expected_user_id: str):
        calls.append((token, expected_user_id))
        return outcomes.get(str(token or ""), "missing")

    prove.calls = calls  # type: ignore[attr-defined]
    return prove


def _propose(executor: ToolExecutor, ctx: ToolContext, tool: str):
    outcome = asyncio.run(executor.call(ctx, tool, {"person": {"user_id": PRIYA}}))
    assert outcome.result.status == "confirmation_required"
    asyncio.run(executor.pending.mark_shown(user_id=USER, pending_action_id=outcome.pending.id))
    return outcome.pending


@pytest.mark.parametrize(
    ("token", "expected_reason"),
    [
        (None, "firebase_proof_missing"),
        ("expired", "firebase_proof_invalid"),
        ("theirs", "firebase_proof_mismatch"),
    ],
)
def test_spoken_yes_needs_a_verified_proof_and_leaves_the_card_pending(token, expected_reason):
    prove = _proof({"good": "ok", "expired": "invalid", "theirs": "mismatch"})
    store = MemoryPendingStore()
    executor = ToolExecutor(pending_store=store, actor_proof=prove)
    ctx = _ctx(token)
    pending = _propose(executor, ctx, SEND.name)

    outcome = asyncio.run(
        executor.call(ctx, "confirm_pending_action", {"pending_action_id": pending.id})
    )
    assert outcome.result.status == FIREBASE_PROOF_REQUIRED
    assert outcome.result.reason_code == expected_reason
    assert outcome.result.needs == "confirmation"
    assert prove.calls == [(token, USER)]
    # Not consumed: a tap with a fresh proof can still complete it.
    row = asyncio.run(store.get(user_id=USER, pending_action_id=pending.id))
    assert row.status == "pending"

    # A fresh, matching proof (what a tap carries) lets the same row execute.
    ctx.firebase_id_token = "good"  # noqa: S105
    done = asyncio.run(
        executor.call(ctx, "confirm_pending_action", {"pending_action_id": pending.id})
    )
    assert done.result.status == "sent"
    assert asyncio.run(store.get(user_id=USER, pending_action_id=pending.id)).status == "executed"


def test_a_non_empty_string_is_not_proof():
    prove = _proof({})  # everything unknown -> "missing" except explicitly listed
    store = MemoryPendingStore()
    executor = ToolExecutor(pending_store=store, actor_proof=prove)
    ctx = _ctx("definitely-a-string")
    pending = _propose(executor, ctx, SEND.name)
    outcome = asyncio.run(
        executor.call(ctx, "confirm_pending_action", {"pending_action_id": pending.id})
    )
    assert outcome.result.status == FIREBASE_PROOF_REQUIRED
    assert asyncio.run(store.get(user_id=USER, pending_action_id=pending.id)).status == "pending"


def test_tools_off_the_firebase_plane_do_not_ask_for_proof():
    prove = _proof({})
    store = MemoryPendingStore()
    executor = ToolExecutor(pending_store=store, actor_proof=prove)
    ctx = _ctx(None)
    pending = _propose(executor, ctx, PLAIN.name)
    outcome = asyncio.run(
        executor.call(ctx, "confirm_pending_action", {"pending_action_id": pending.id})
    )
    assert outcome.result.status == "sent"
    assert prove.calls == []


def test_prove_actor_uses_the_context_token_and_user():
    prove = _proof({"good": "ok"})
    executor = ToolExecutor(pending_store=MemoryPendingStore(), actor_proof=prove)
    assert asyncio.run(executor.prove_actor(_ctx("good"), SEND)) == "ok"
    assert asyncio.run(executor.prove_actor(_ctx("bad"), SEND)) == "missing"
    assert asyncio.run(executor.prove_actor(_ctx(None), PLAIN)) == "ok"
    assert asyncio.run(executor.prove_actor(_ctx(None), None)) == "ok"


def test_real_verifier_maps_outcomes_without_raising(monkeypatch):
    seen: list[str] = []

    def fake_verify(authorization: str, *, check_revoked: bool = True) -> str:
        seen.append(authorization)
        assert check_revoked is True
        token = authorization.removeprefix("Bearer ")
        if token == "boom":
            raise RuntimeError("expired")
        return {"mine": USER, "theirs": "user-other"}[token]

    import api.utils.firebase_auth as firebase_auth

    monkeypatch.setattr(firebase_auth, "verify_firebase_bearer", fake_verify)
    assert asyncio.run(actor_proof.verify_firebase_actor("mine", USER)) == "ok"
    assert asyncio.run(actor_proof.verify_firebase_actor("theirs", USER)) == "mismatch"
    assert asyncio.run(actor_proof.verify_firebase_actor("boom", USER)) == "invalid"
    assert asyncio.run(actor_proof.verify_firebase_actor("   ", USER)) == "missing"
    assert asyncio.run(actor_proof.verify_firebase_actor(None, USER)) == "missing"
    assert seen == ["Bearer mine", "Bearer theirs", "Bearer boom"]


def test_execution_failure_after_confirmation_does_not_claim_nothing_changed():
    async def _explode(ctx: ToolContext, args: Any) -> ToolResult:
        raise RuntimeError("socket closed after commit")

    spec = ToolSpec(
        name="send_thing",
        gateway_action_id="people.profile.connect",
        policy=ToolPolicy.confirm_voice,
        input_model=_SendInput,
        output_model=_SendResult,
        description="Send.",
        handler=_explode,
        person_args=("person",),
        firebase_plane=True,
        summarize=lambda ctx, a: "send the thing",
    )
    import pytest as _pytest

    mp = _pytest.MonkeyPatch()
    mp.setattr(registry, "get_tool", lambda name: {spec.name: spec}.get(str(name or "")))
    try:
        store = MemoryPendingStore()
        executor = ToolExecutor(pending_store=store, actor_proof=_proof({"good": "ok"}))
        ctx = _ctx("good")
        pending = _propose(executor, ctx, spec.name)
        outcome = asyncio.run(
            executor.call(ctx, "confirm_pending_action", {"pending_action_id": pending.id})
        )
        assert outcome.result.status == "rejected"
        assert outcome.result.reason_code == "execution_failed"
        assert "can't confirm whether anything changed" in outcome.result.spoken_facts[0]
        assert "Nothing was changed" not in outcome.result.spoken_facts[0]
        row = asyncio.run(store.get(user_id=USER, pending_action_id=pending.id))
        assert row.status == "failed" and row.result == {
            "error_class": "RuntimeError",
            "outcome": "unknown",
        }
    finally:
        mp.undo()


def test_a_lookup_supersedes_every_open_card_even_when_the_lookup_itself_fails(monkeypatch):
    """The store cancels the card before the handler runs; the outcome still
    names it so the relay can tell the client, whatever the handler did."""
    from hushh_mcp.one_voice.tools.base import ToolInput as _Input

    class LookupInput(_Input):
        spoken_name: str

    async def explode(ctx, args):
        raise RuntimeError("directory down")

    lookup = ToolSpec(
        name="resolve_person",
        gateway_action_id="connect.search_people",
        policy=ToolPolicy.read,
        input_model=LookupInput,
        output_model=ToolResult,
        description="Lookup.",
        handler=explode,
    )
    by_name = {SEND.name: SEND, PLAIN.name: PLAIN, lookup.name: lookup}
    monkeypatch.setattr(registry, "get_tool", lambda name: by_name.get(str(name or "")))
    store = MemoryPendingStore()
    executor = ToolExecutor(pending_store=store, actor_proof=_proof({"good": "ok"}))
    ctx = _ctx("good")
    pending = _propose(executor, ctx, PLAIN.name)  # a card with no person_args at all
    outcome = asyncio.run(executor.call(ctx, "resolve_person", {"spoken_name": "Priya"}))
    assert outcome.result.status == "rejected" and outcome.result.reason_code == "execution_failed"
    assert [row.id for row in outcome.superseded] == [pending.id]
    assert asyncio.run(store.get(user_id=USER, pending_action_id=pending.id)).status == "cancelled"

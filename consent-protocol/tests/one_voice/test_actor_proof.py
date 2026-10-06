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


def test_a_person_lookup_supersedes_a_person_card_even_when_the_lookup_itself_fails(monkeypatch):
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
    pending = _propose(executor, ctx, PLAIN.name)  # a card about a person
    outcome = asyncio.run(executor.call(ctx, "resolve_person", {"spoken_name": "Priya"}))
    assert outcome.result.status == "rejected" and outcome.result.reason_code == "execution_failed"
    assert [row.id for row in outcome.superseded] == [pending.id]
    assert asyncio.run(store.get(user_id=USER, pending_action_id=pending.id)).status == "cancelled"


# -- which open card a lookup makes stale -----------------------------------------
#
# UAT: "Create Family" -> "Yes, and add all my connections to it". The model began
# a person lookup for the follow-up, the lookup cancelled the create card, and the
# person heard "I can create a circle called Family. Should I go ahead?" again. A
# lookup now cancels only a card about the kind of thing it looks up.


def _catalog_spec(name: str) -> ToolSpec:
    from hushh_mcp.one_voice.tools import circles, people

    return {tool.name: tool for tool in (*circles.TOOLS, *people.TOOLS)}[name]


@pytest.mark.parametrize(
    ("tool", "stale_on_person", "stale_on_circle"),
    [
        ("create_circle", False, False),
        ("rename_circle", False, True),
        ("set_circle_kind", False, True),
        ("delete_circle", False, True),
        ("add_circle_member", True, True),
        ("add_circle_members", True, True),
        ("add_all_connections", False, True),
        ("invite_person", True, False),
        # Its counterpart rides an opaque request id, so any lookup may be the
        # correction that makes it stale.
        ("accept_connection_request", True, True),
    ],
)
def test_a_lookup_makes_stale_only_the_cards_about_what_it_looks_up(
    tool, stale_on_person, stale_on_circle
):
    spec = _catalog_spec(tool)
    assert spec.stale_on_lookup("person") is stale_on_person
    assert spec.stale_on_lookup("circle") is stale_on_circle


class _NameInput(ToolInput):
    name: str


CREATE = ToolSpec(
    name="create_thing",
    gateway_action_id="location.rename_circle",
    policy=ToolPolicy.confirm_voice,
    input_model=_NameInput,
    output_model=_SendResult,
    description="Create.",
    handler=_send,
    summarize=lambda ctx, a: f"create {a.name}",
    lookup_targets=(),
)


def _lookup_harness(monkeypatch):
    class LookupInput(ToolInput):
        spoken_name: str

    async def found(ctx, args):
        return ToolResult(status="single_likely")

    lookup = ToolSpec(
        name="resolve_person",
        gateway_action_id="connect.search_people",
        policy=ToolPolicy.read,
        input_model=LookupInput,
        output_model=ToolResult,
        description="Lookup.",
        handler=found,
    )
    by_name = {spec.name: spec for spec in (SEND, PLAIN, TAP, CREATE, lookup)}
    monkeypatch.setattr(registry, "get_tool", lambda name: by_name.get(str(name or "")))
    store = MemoryPendingStore()
    executor = ToolExecutor(pending_store=store, actor_proof=_proof({"good": "ok"}))
    return store, executor, _ctx("good")


def test_a_lookup_for_a_follow_up_leaves_an_unrelated_card_open(monkeypatch):
    store, executor, ctx = _lookup_harness(monkeypatch)
    created = asyncio.run(executor.call(ctx, CREATE.name, {"name": "Family"}))
    assert created.result.status == "confirmation_required"

    lookup = asyncio.run(executor.call(ctx, "resolve_person", {"spoken_name": "Priya"}))

    assert lookup.result.status == "single_likely"
    assert lookup.superseded == []
    row = asyncio.run(store.get(user_id=USER, pending_action_id=created.pending.id))
    assert row.status == "pending"


def test_a_card_corrected_by_a_lookup_is_asked_fresh(monkeypatch):
    """Negative control: a card about a person is still cancelled by a person
    lookup, and re-proposing it unchanged afterwards asks again. The yes that
    follows a lookup answered "is that who you mean?", never the action, so it
    must not be treated as consent (no repeats_cancelled)."""
    store, executor, ctx = _lookup_harness(monkeypatch)
    card = asyncio.run(executor.call(ctx, PLAIN.name, {"person": {"user_id": PRIYA}}))

    lookup = asyncio.run(executor.call(ctx, "resolve_person", {"spoken_name": "Priya"}))
    assert [row.id for row in lookup.superseded] == [card.pending.id]

    again = asyncio.run(executor.call(ctx, PLAIN.name, {"person": {"user_id": PRIYA}}))
    assert again.result.status == "confirmation_required"
    assert "repeats_cancelled" not in again.result.public()
    assert again.result.spoken_facts == ["I can do the plain thing. Should I go ahead?"]


# -- a different action never silently replaces an unanswered card ---------------


def test_a_different_action_waits_for_the_shown_card_to_be_answered(monkeypatch):
    store, executor, ctx = _lookup_harness(monkeypatch)
    open_card = _propose(executor, ctx, PLAIN.name)  # shown to the person

    other = asyncio.run(executor.call(ctx, SEND.name, {"person": {"user_id": PRIYA}}))

    assert other.result.status == "pending_action_exists"
    public = other.result.public()
    assert public["pending_action_id"] == open_card.id
    assert public["tool"] == PLAIN.name and public["tier"] == "voice"
    assert public["card_shown"] is True and public["needs"] == "confirmation"
    assert other.pending is not None and other.pending.id == open_card.id
    assert other.receipt_token is None and other.superseded == []
    # Nothing was written or cancelled: the person's card still waits.
    assert [(r.id, r.status) for r in _open_rows(store, ctx)] == [(open_card.id, "pending")]

    # Once that card is answered, the new action is proposed as usual.
    asyncio.run(executor.call(ctx, "cancel_pending_action", {"pending_action_id": open_card.id}))
    proposed = asyncio.run(executor.call(ctx, SEND.name, {"person": {"user_id": PRIYA}}))
    assert proposed.result.status == "confirmation_required"


def test_a_card_never_shown_blocks_nothing(monkeypatch):
    """A card the client never displayed was never reviewed and cannot be
    answered, so a new proposal replaces it as before rather than pointing the
    person at something they cannot see."""
    store, executor, ctx = _lookup_harness(monkeypatch)
    unseen = asyncio.run(executor.call(ctx, PLAIN.name, {"person": {"user_id": PRIYA}}))

    other = asyncio.run(executor.call(ctx, SEND.name, {"person": {"user_id": PRIYA}}))

    assert other.result.status == "confirmation_required"
    assert [row.id for row in other.superseded] == [unseen.pending.id]


def test_a_shared_gateway_is_not_a_correction(monkeypatch):
    """Requesting and withdrawing share one gateway action and do opposite
    things; one must never silently replace the other's shown card."""
    store, executor, ctx = _lookup_harness(monkeypatch)
    request = ToolSpec(
        name="request_thing",
        gateway_action_id="location.send_request",
        policy=ToolPolicy.confirm_voice,
        input_model=_SendInput,
        output_model=_SendResult,
        description="Request.",
        handler=_send,
        person_args=("person",),
        summarize=lambda ctx, a: "request the thing",
    )
    withdraw = ToolSpec(
        name="withdraw_thing",
        gateway_action_id="location.send_request",
        policy=ToolPolicy.confirm_voice,
        input_model=_NameInput,
        output_model=_SendResult,
        description="Withdraw.",
        handler=_send,
        summarize=lambda ctx, a: "withdraw the thing",
    )
    by_name = {spec.name: spec for spec in (request, withdraw)}
    monkeypatch.setattr(registry, "get_tool", lambda name: by_name.get(str(name or "")))
    card = _propose(executor, ctx, request.name)

    other = asyncio.run(executor.call(ctx, withdraw.name, {"name": "raj"}))

    assert other.result.status == "pending_action_exists"
    assert other.result.pending_action_id == card.id


def test_a_correction_in_the_same_group_still_replaces_its_card(monkeypatch):
    """Negative control: the same tool, or a tool declared in the same
    correction group, re-aims the shown card instead of waiting on it."""
    store, executor, ctx = _lookup_harness(monkeypatch)
    one = ToolSpec(
        name="add_one",
        gateway_action_id="location.add_to_circle",
        policy=ToolPolicy.confirm_voice,
        input_model=_SendInput,
        output_model=_SendResult,
        description="Add one.",
        handler=_send,
        person_args=("person",),
        summarize=lambda ctx, a: "add one",
        correction_group="adds",
    )
    group = ToolSpec(
        name="add_everyone",
        gateway_action_id="location.add_to_circle",
        policy=ToolPolicy.confirm_voice,
        input_model=_NameInput,
        output_model=_SendResult,
        description="Add everyone.",
        handler=_send,
        summarize=lambda ctx, a: "add everyone",
        correction_group="adds",
    )
    by_name = {spec.name: spec for spec in (one, group)}
    monkeypatch.setattr(registry, "get_tool", lambda name: by_name.get(str(name or "")))
    card = _propose(executor, ctx, one.name)

    corrected = asyncio.run(executor.call(ctx, group.name, {"name": "family"}))

    assert corrected.result.status == "confirmation_required"
    assert [row.id for row in corrected.superseded] == [card.id]
    assert [row.id for row in _open_rows(store, ctx)] == [corrected.pending.id]


def test_the_real_catalog_groups_only_true_corrections():
    from hushh_mcp.one_voice.tools import circles, location_state, sharing

    tools = {tool.name: tool for tool in (*circles.TOOLS, *location_state.TOOLS, *sharing.TOOLS)}

    def key(name: str) -> str:
        return tools[name].correction_key

    assert key("add_circle_member") == key("add_circle_members") == key("add_all_connections")
    assert key("turn_sharing_on") == key("turn_sharing_off")
    # Same gateway, opposite effects: never one another's correction.
    assert (
        tools["request_location"].gateway_action_id == tools["withdraw_request"].gateway_action_id
    )
    assert key("request_location") != key("withdraw_request")


def test_an_alert_replaces_an_unanswered_card_instead_of_waiting(monkeypatch):
    store, executor, ctx = _lookup_harness(monkeypatch)
    alert = ToolSpec(
        name="alert_thing",
        gateway_action_id="location.trigger_sos",
        policy=ToolPolicy.confirm_tap,
        input_model=_NameInput,
        output_model=_SendResult,
        description="Alert.",
        handler=_send,
        summarize=lambda ctx, a: "send the alert",
        preempts_pending=True,
    )
    by_name = {spec.name: spec for spec in (PLAIN, alert)}
    monkeypatch.setattr(registry, "get_tool", lambda name: by_name.get(str(name or "")))
    open_card = _propose(executor, ctx, PLAIN.name)  # shown, so it would block

    sent = asyncio.run(executor.call(ctx, alert.name, {"name": "help"}))

    assert sent.result.status == "confirmation_required"
    assert [row.id for row in sent.superseded] == [open_card.id]


def test_the_real_alert_tool_is_the_one_that_preempts():
    from hushh_mcp.one_voice.tools import circles, sos

    preempting = {tool.name for tool in (*circles.TOOLS, *sos.TOOLS) if tool.preempts_pending}
    assert preempting == {"trigger_save_my_soul"}


# -- storage failures fail closed and keep the session ---------------------------


class _BrokenStore(MemoryPendingStore):
    def __init__(self, *broken: str) -> None:
        super().__init__()
        self.broken = set(broken)

    def _check(self, method: str) -> None:
        from hushh_mcp.one_voice.pending_actions import PendingActionStorageError

        if method in self.broken:
            raise PendingActionStorageError("Voice storage is temporarily unavailable.")

    async def list_open(self, *, user_id, conversation_id):
        self._check("list_open")
        return await super().list_open(user_id=user_id, conversation_id=conversation_id)

    async def confirm(self, *, user_id, pending_action_id, source, receipt_token=None):
        self._check("confirm")
        return await super().confirm(
            user_id=user_id,
            pending_action_id=pending_action_id,
            source=source,
            receipt_token=receipt_token,
        )

    async def resolve(self, *, user_id, pending_action_id, status, result):
        self._check("resolve")
        return await super().resolve(
            user_id=user_id, pending_action_id=pending_action_id, status=status, result=result
        )

    async def cancel(self, *, user_id, pending_action_id):
        self._check("cancel")
        return await super().cancel(user_id=user_id, pending_action_id=pending_action_id)


def test_an_unreadable_pending_state_proposes_nothing(monkeypatch):
    """Unreadable is not "none open": a proposal on it could sit beside the card
    the person is answering. Before this, the error escaped and closed the
    session with 4013."""
    _store, _executor, ctx = _lookup_harness(monkeypatch)
    store = _BrokenStore("list_open")
    executor = ToolExecutor(pending_store=store, actor_proof=_proof({"good": "ok"}))

    proposed = asyncio.run(executor.call(ctx, PLAIN.name, {"person": {"user_id": PRIYA}}))
    looked_up = asyncio.run(executor.call(ctx, "resolve_person", {"spoken_name": "Priya"}))

    assert (proposed.result.status, proposed.result.reason_code) == (
        "rejected",
        "storage_unavailable",
    )
    assert (looked_up.result.status, looked_up.result.reason_code) == (
        "rejected",
        "storage_unavailable",
    )
    assert store.rows == {}


def test_a_storage_failure_while_confirming_executes_nothing(monkeypatch):
    calls: list[str] = []

    async def counted(ctx, args):
        calls.append(args.person.user_id)
        return _SendResult(status="sent")

    spec = ToolSpec(
        name="plain_thing",
        gateway_action_id="location.create_circle",
        policy=ToolPolicy.confirm_voice,
        input_model=_SendInput,
        output_model=_SendResult,
        description="Plain.",
        handler=counted,
        person_args=("person",),
        summarize=lambda ctx, a: "do the plain thing",
    )
    monkeypatch.setattr(registry, "get_tool", lambda name: spec if name == spec.name else None)
    store = _BrokenStore()
    executor = ToolExecutor(pending_store=store, actor_proof=_proof({"good": "ok"}))
    ctx = _ctx("good")
    card = _propose(executor, ctx, spec.name)

    store.broken = {"confirm"}
    refused = asyncio.run(
        executor.call(ctx, "confirm_pending_action", {"pending_action_id": card.id})
    )
    assert (refused.result.status, refused.result.reason_code) == (
        "rejected",
        "storage_unavailable",
    )
    assert calls == []
    assert asyncio.run(store.get(user_id=USER, pending_action_id=card.id)).status == "pending"

    # A yes after storage recovers runs it once; a second, late yes runs nothing.
    store.broken = set()
    done = asyncio.run(executor.call(ctx, "confirm_pending_action", {"pending_action_id": card.id}))
    late = asyncio.run(executor.call(ctx, "confirm_pending_action", {"pending_action_id": card.id}))
    assert done.result.status == "sent"
    assert late.result.status == "not_pending"
    assert calls == [PRIYA]


def test_an_unrecorded_result_still_reports_what_the_service_did(monkeypatch):
    """The service committed; only the voice ledger write failed. The answer is
    the service's, the card is retired, and the row is never re-executable."""
    store = _BrokenStore()
    executor = ToolExecutor(pending_store=store, actor_proof=_proof({"good": "ok"}))
    ctx = _ctx("good")
    card = _propose(executor, ctx, PLAIN.name)

    store.broken = {"resolve"}
    outcome = asyncio.run(
        executor.call(ctx, "confirm_pending_action", {"pending_action_id": card.id})
    )

    assert outcome.result.status == "sent"
    assert outcome.pending is not None and outcome.pending.status == "executed"
    stored = asyncio.run(store.get(user_id=USER, pending_action_id=card.id))
    assert stored.status == "confirmed"
    store.broken = set()
    again = asyncio.run(
        executor.call(ctx, "confirm_pending_action", {"pending_action_id": card.id})
    )
    assert again.result.status == "not_pending"


def test_executor_phases_are_timed(monkeypatch):
    _store, executor, ctx = _lookup_harness(monkeypatch)
    proposed = asyncio.run(executor.call(ctx, PLAIN.name, {"person": {"user_id": PRIYA}}))
    assert {"pending", "create", "total"} <= set(proposed.timings)
    assert all(isinstance(value, int) and value >= 0 for value in proposed.timings.values())


# -- duplicate voice-tier proposals -------------------------------------------
#
# A model that re-proposes the action it is waiting on (instead of confirming
# it) used to mint a new row, cancelling the card the person was answering, so
# every "yes" met a fresh question. The executor now refuses the duplicate and
# hands back the open id. It never confirms on the model's behalf.

AISHA = "user-aisha"
TAP = ToolSpec(
    name="tap_thing",
    gateway_action_id="location.create_circle",
    policy=ToolPolicy.confirm_tap,
    input_model=_SendInput,
    output_model=_SendResult,
    description="Tap.",
    handler=_send,
    person_args=("person",),
    summarize=lambda ctx, a: "do the tap thing",
)


def _dup_harness(monkeypatch):
    by_name = {SEND.name: SEND, PLAIN.name: PLAIN, TAP.name: TAP}
    monkeypatch.setattr(registry, "get_tool", lambda name: by_name.get(str(name or "")))
    store = MemoryPendingStore()
    executor = ToolExecutor(pending_store=store, actor_proof=_proof({"good": "ok"}))
    ctx = _ctx("good")
    ctx.entities.remember_person(
        ConfirmedPerson(user_id=AISHA, display_name="Aisha", confirmed_at=now_iso())
    )
    return store, executor, ctx


def _open_rows(store: MemoryPendingStore, ctx: ToolContext):
    return asyncio.run(store.list_open(user_id=USER, conversation_id=ctx.conversation_id))


def test_identical_voice_proposal_returns_the_open_card_instead_of_a_new_one(monkeypatch):
    store, executor, ctx = _dup_harness(monkeypatch)
    first = asyncio.run(executor.call(ctx, PLAIN.name, {"person": {"user_id": PRIYA}}))
    assert first.result.status == "confirmation_required"

    again = asyncio.run(executor.call(ctx, PLAIN.name, {"person": {"user_id": PRIYA}}))
    assert again.result.status == "confirmation_waiting"
    assert again.result.pending_action_id == first.pending.id
    assert again.result.card_shown is False
    assert again.pending is not None and again.pending.id == first.pending.id
    assert again.superseded == [] and again.receipt_token is None
    assert [row.id for row in _open_rows(store, ctx)] == [first.pending.id]

    asyncio.run(store.mark_shown(user_id=USER, pending_action_id=first.pending.id))
    shown = asyncio.run(executor.call(ctx, PLAIN.name, {"person": {"user_id": PRIYA}}))
    assert shown.result.status == "confirmation_waiting"
    assert shown.result.card_shown is True
    # Nothing was confirmed: the row still waits for the person's answer.
    assert [(r.id, r.status) for r in _open_rows(store, ctx)] == [(first.pending.id, "pending")]


def test_different_arguments_still_replace_the_open_card(monkeypatch):
    """Negative control: a changed target is a new proposal and supersedes."""
    store, executor, ctx = _dup_harness(monkeypatch)
    first = asyncio.run(executor.call(ctx, PLAIN.name, {"person": {"user_id": PRIYA}}))
    other = asyncio.run(executor.call(ctx, PLAIN.name, {"person": {"user_id": AISHA}}))
    assert other.result.status == "confirmation_required"
    assert other.pending.id != first.pending.id
    assert [row.id for row in other.superseded] == [first.pending.id]
    assert [row.id for row in _open_rows(store, ctx)] == [other.pending.id]


# -- a spelled word survives every correction ----------------------------------
#
# UAT: after the person spelled "again h u s s h" the model cancelled the card and
# asked for the name again. A re-proposal that drops a word the person spelled is
# refused with a question, and the card it was correcting is retired, so no yes
# can reach a name the person has just corrected.


def _spelling_harness(monkeypatch, store: MemoryPendingStore | None = None):
    from hushh_mcp.one_voice.tools import circles

    create = next(tool for tool in circles.TOOLS if tool.name == "create_circle")
    monkeypatch.setattr(registry, "get_tool", lambda name: create if name == create.name else None)
    store = store or MemoryPendingStore()
    executor = ToolExecutor(pending_store=store, actor_proof=_proof({"good": "ok"}))
    return store, executor, _ctx("good")


def _create(executor: ToolExecutor, ctx: ToolContext, **args: Any):
    return asyncio.run(executor.call(ctx, "create_circle", args))


def test_a_correction_that_drops_a_spelled_word_retires_the_card(monkeypatch):
    store, executor, ctx = _spelling_harness(monkeypatch)
    card = _create(executor, ctx, name="HUSSH GARAGE V04", spelled_words=["HUSSH"])
    assert card.result.status == "confirmation_required"
    asyncio.run(store.mark_shown(user_id=USER, pending_action_id=card.pending.id))

    dropped = _create(executor, ctx, name="HUSH GARAGE V04")

    assert (dropped.result.status, dropped.result.reason_code) == (
        "rejected",
        "spelled_word_missing",
    )
    assert [row.id for row in dropped.superseded] == [card.pending.id]
    assert _open_rows(store, ctx) == []
    late_yes = asyncio.run(
        executor.call(ctx, "confirm_pending_action", {"pending_action_id": card.pending.id})
    )
    assert late_yes.result.status == "not_pending"


def test_a_refused_correction_fails_closed_when_its_card_cannot_be_retired(monkeypatch):
    """The card the correction was aimed at may still be open, so no question
    is asked over it: nothing is prepared, as when a lookup cannot retire the
    card it corrects."""
    store, executor, ctx = _spelling_harness(monkeypatch, _BrokenStore())
    card = _create(executor, ctx, name="HUSSH GARAGE V04", spelled_words=["HUSSH"])
    asyncio.run(store.mark_shown(user_id=USER, pending_action_id=card.pending.id))
    store.broken = {"cancel"}

    dropped = _create(executor, ctx, name="HUSH GARAGE V04")

    assert (dropped.result.status, dropped.result.reason_code) == (
        "rejected",
        "storage_unavailable",
    )
    assert dropped.result.spoken_facts == [
        "I couldn't prepare that right now. Nothing was changed. Please try again in a moment."
    ]
    assert dropped.superseded == []
    assert [row.id for row in _open_rows(store, ctx)] == [card.pending.id]


def test_a_spelled_word_is_still_required_after_the_models_own_cancel(monkeypatch):
    store, executor, ctx = _spelling_harness(monkeypatch)
    card = _create(executor, ctx, name="HUSSH GARAGE V04", spelled_words=["HUSSH"])
    asyncio.run(executor.call(ctx, "cancel_pending_action", {"pending_action_id": card.pending.id}))

    again = _create(executor, ctx, name="HUSH GARAGE V04")

    assert again.result.reason_code == "spelled_word_missing"
    assert again.superseded == [] and _open_rows(store, ctx) == []
    # A yes that answers the spelling question is never a yes to the action:
    # the next proposal, even the cancelled card again, asks as usual.
    follow = _create(executor, ctx, name="HUSSH GARAGE V04", spelled_words=["HUSSH"])
    assert follow.result.status == "confirmation_required"
    assert follow.result.public().get("repeats_cancelled", False) is False
    assert follow.result.spoken_facts[0].endswith("Should I go ahead?")
    # The kept word came from earlier, so the question names both readings.
    assert again.result.spoken_facts == [
        "Earlier you spelled HUSSH as H-U-S-S-H. "
        "Is this a different circle, or should the name keep HUSSH?"
    ]


def test_a_released_spelled_word_lets_the_correction_through(monkeypatch):
    """Negative control: the person changed the word and the model said so."""
    store, executor, ctx = _spelling_harness(monkeypatch)
    card = _create(executor, ctx, name="HUSSH GARAGE V04", spelled_words=["HUSSH"])
    asyncio.run(executor.call(ctx, "cancel_pending_action", {"pending_action_id": card.pending.id}))

    changed = _create(executor, ctx, name="HUSH GARAGE V04", release_spelled_words=["HUSSH"])

    assert changed.result.status == "confirmation_required"
    assert changed.result.summary == "create a circle called HUSH GARAGE V04"
    assert [row.id for row in _open_rows(store, ctx)] == [changed.pending.id]


def test_tap_tier_duplicate_still_creates_a_new_card_and_receipt(monkeypatch):
    """A tap card's receipt is handed out once, so the guard never reuses it."""
    store, executor, ctx = _dup_harness(monkeypatch)
    first = asyncio.run(executor.call(ctx, TAP.name, {"person": {"user_id": PRIYA}}))
    again = asyncio.run(executor.call(ctx, TAP.name, {"person": {"user_id": PRIYA}}))
    assert again.result.status == "confirmation_required"
    assert again.pending.id != first.pending.id and again.receipt_token
    assert [row.id for row in _open_rows(store, ctx)] == [again.pending.id]


def test_card_not_shown_names_the_id_to_confirm_later(monkeypatch):
    store, executor, ctx = _dup_harness(monkeypatch)
    first = asyncio.run(executor.call(ctx, PLAIN.name, {"person": {"user_id": PRIYA}}))
    refused = asyncio.run(
        executor.call(ctx, "confirm_pending_action", {"pending_action_id": first.pending.id})
    )
    assert refused.result.status == "card_not_shown"
    public = refused.result.public()
    assert public["pending_action_id"] == first.pending.id
    assert public["card_shown"] is False
    assert _open_rows(store, ctx)[0].status == "pending"


# -- re-proposal right after the model's own cancel ----------------------------
#
# UAT 2026-10-02: "Yes, go ahead for 1 hour" was read as a correction, so the
# model cancelled the card and proposed the identical action again, and the
# person heard the same question twice. The new card says it repeats the one
# just cancelled. The host still confirms nothing.


def test_unchanged_reproposal_after_the_models_cancel_does_not_ask_again(monkeypatch):
    store, executor, ctx = _dup_harness(monkeypatch)
    first = asyncio.run(executor.call(ctx, PLAIN.name, {"person": {"user_id": PRIYA}}))
    cancelled = asyncio.run(
        executor.call(ctx, "cancel_pending_action", {"pending_action_id": first.pending.id})
    )
    assert cancelled.result.status == "cancelled"

    again = asyncio.run(executor.call(ctx, PLAIN.name, {"person": {"user_id": PRIYA}}))
    assert again.result.status == "confirmation_required"
    assert again.result.public()["repeats_cancelled"] is True
    assert "Should I go ahead" not in again.result.spoken_facts[0]
    assert [(r.id, r.status) for r in _open_rows(store, ctx)] == [(again.pending.id, "pending")]


def test_changed_or_late_reproposal_after_a_cancel_asks_as_usual(monkeypatch):
    """Negative controls: a different target, or the same one past the window."""
    from hushh_mcp.one_voice.tools import executor as executor_module

    store, executor, ctx = _dup_harness(monkeypatch)
    first = asyncio.run(executor.call(ctx, PLAIN.name, {"person": {"user_id": PRIYA}}))
    asyncio.run(
        executor.call(ctx, "cancel_pending_action", {"pending_action_id": first.pending.id})
    )
    other = asyncio.run(executor.call(ctx, PLAIN.name, {"person": {"user_id": AISHA}}))
    assert "repeats_cancelled" not in other.result.public()
    assert other.result.spoken_facts == ["I can do the plain thing. Should I go ahead?"]

    asyncio.run(
        executor.call(ctx, "cancel_pending_action", {"pending_action_id": other.pending.id})
    )
    later = executor_module.time.monotonic() + executor_module.RECENT_CANCEL_SECONDS + 1
    monkeypatch.setattr(executor_module.time, "monotonic", lambda: later)
    late = asyncio.run(executor.call(ctx, PLAIN.name, {"person": {"user_id": AISHA}}))
    assert "repeats_cancelled" not in late.result.public()

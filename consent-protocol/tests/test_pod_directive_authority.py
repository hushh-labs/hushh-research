"""The relay is the sole authority hop for a pod's proposed directives.

These pin the security invariants that were, until now, asserted only in a
docstring -- which this repo's bar (verify-before-claim) treats as the last place
a security-critical hop should rely on prose. Each test is a probe against the
real ``_authorize_and_frame_directives``, with a fake ledger store that records
exactly how it was called, so a regression in the authority logic fails loudly.

The invariants:
  * ``issue()`` is called with the AUTHENTICATED owner's user_id, never a value
    the pod supplied;
  * exactly one action directive is ledger-issued per turn (the cap);
  * an unknown action id yields no ledger row and no card;
  * ``trusted_activation_required=True`` is forced on every pod-originated action;
  * a directive tagged with an EXCLUDED delegate but rendering as an action still
    goes through the ledger (the forged-card hole the review found);
  * a non-excluded delegate renders as a specialist card with no ledger entry;
  * a failed issue drops the CARD, never the answer.
"""

from __future__ import annotations

import pytest

import api.routes.one.pod_relay as relay


class _FakeIssued:
    def __init__(self, directive_id: str, conversation_id: str):
        self.directive_id = directive_id
        self.context_revision = f"conversation:{conversation_id}"

        class _Exp:
            @staticmethod
            def isoformat() -> str:
                return "2026-01-01T00:00:00+00:00"

        self.expires_at = _Exp()


class _FakeStore:
    def __init__(self, *, fail_issue: bool = False):
        self.issue_calls: list[dict] = []
        self.cancel_calls: list[dict] = []
        self._fail = fail_issue

    async def issue(self, **kwargs):
        self.issue_calls.append(kwargs)
        if self._fail:
            raise RuntimeError("ledger unavailable")
        return _FakeIssued("dir_test", kwargs["conversation_id"])

    async def cancel_open_for_conversation(self, **kwargs):
        self.cancel_calls.append(kwargs)


def _fake_gateway(action_id):
    if action_id == "known.action":
        return {"label": "Do Thing", "risk": {}, "activation_policy": "none"}
    return None


def _patch_gateway(monkeypatch):
    # BOTH the relay (deferred import) and the shared translator (top-level
    # import, so it binds the name in its OWN module) re-validate against the
    # gateway. Patch both bindings, or the translator silently uses the real
    # gateway and emits no frame -- which is itself a useful reminder that the
    # translator independently re-validates as defense in depth.
    monkeypatch.setattr(
        "hushh_mcp.services.action_gateway.get_action_gateway_action", _fake_gateway
    )
    monkeypatch.setattr(
        "hushh_mcp.services.one_directive_frames.get_action_gateway_action", _fake_gateway
    )


@pytest.fixture
def store(monkeypatch):
    s = _FakeStore()
    monkeypatch.setattr(
        "hushh_mcp.services.action_directive_ledger.get_action_directive_store", lambda: s
    )
    _patch_gateway(monkeypatch)
    return s


async def _run(answer: dict, store, *, user_id="u-owner", conversation_id="conv-1"):
    return await relay._authorize_and_frame_directives(
        user_id=user_id, conversation_id=conversation_id, answer=answer
    )


@pytest.mark.asyncio
async def test_issue_is_called_with_the_authenticated_owner_never_a_pod_value(store):
    await _run(
        {
            "text": "ok",
            # A pod trying to smuggle a different user id in the payload -- it is
            # ignored; user_id comes only from the authenticated caller.
            "directives": [
                {"kind": "action", "payload": {"actionId": "known.action", "userId": "attacker"}}
            ],
        },
        store,
    )
    assert len(store.issue_calls) == 1
    assert store.issue_calls[0]["user_id"] == "u-owner"
    assert store.issue_calls[0]["trusted_activation_required"] is True


@pytest.mark.asyncio
async def test_only_one_action_directive_is_issued_per_turn(store):
    frames = await _run(
        {
            "text": "ok",
            "directives": [
                {"kind": "action", "payload": {"actionId": "known.action"}},
                {"kind": "action", "payload": {"actionId": "known.action"}},
                {"kind": "action", "payload": {"actionId": "known.action"}},
            ],
        },
        store,
    )
    assert len(store.issue_calls) == 1, "the one-action-per-turn cap was defeated"
    # One issued action -> one tool_start + one tool_waiting.
    assert sum(1 for f in frames if f["event"] == "tool_start") == 1


@pytest.mark.asyncio
async def test_an_unknown_action_id_yields_no_ledger_row_and_no_card(store):
    frames = await _run(
        {"text": "ok", "directives": [{"kind": "action", "payload": {"actionId": "nope.unknown"}}]},
        store,
    )
    assert store.issue_calls == []
    assert frames == []


@pytest.mark.asyncio
async def test_excluded_delegate_action_still_goes_through_the_ledger(store):
    """The forged-card hole: an action directive tagged with the excluded
    personal-information delegate used to render a confirm card with NO ledger
    row. It must now be issued like any other action."""
    frames = await _run(
        {
            "text": "ok",
            "directives": [
                {
                    "kind": "action",
                    "delegateAgentId": "agent_personal_information",
                    "payload": {"actionId": "known.action"},
                }
            ],
        },
        store,
    )
    assert len(store.issue_calls) == 1, "an excluded-delegate action bypassed the ledger"
    # And the emitted card carries the server-minted directive_id, so confirm can
    # match a real row instead of being an unbacked forgery.
    tool_start = next(f for f in frames if f["event"] == "tool_start")
    assert tool_start["data"].get("directive_id") == "dir_test"


@pytest.mark.asyncio
async def test_a_non_excluded_delegate_renders_as_specialist_with_no_ledger(store):
    frames = await _run(
        {
            "text": "ok",
            "directives": [{"kind": "action", "delegateAgentId": "agent_location", "payload": {}}],
        },
        store,
    )
    assert store.issue_calls == [], "a specialist directive must not touch the ledger"
    assert [f["event"] for f in frames] == ["specialist_directive"]


@pytest.mark.asyncio
async def test_supersede_is_keyed_to_the_authenticated_owner(store):
    await _run(
        {"text": "ok", "directives": [{"kind": "action", "payload": {"actionId": "known.action"}}]},
        store,
    )
    assert store.cancel_calls == [{"user_id": "u-owner", "conversation_id": "conv-1"}]


@pytest.mark.asyncio
async def test_a_failed_issue_drops_the_card_never_the_answer(monkeypatch):
    s = _FakeStore(fail_issue=True)
    monkeypatch.setattr(
        "hushh_mcp.services.action_directive_ledger.get_action_directive_store", lambda: s
    )
    _patch_gateway(monkeypatch)
    frames = await _run(
        {
            "text": "the answer",
            "directives": [{"kind": "action", "payload": {"actionId": "known.action"}}],
        },
        s,
    )
    # The card is gone, but this function only produces frames; the caller keeps
    # the text answer regardless. No card means no frames from a failed issue.
    assert frames == []


@pytest.mark.asyncio
async def test_a_hostile_directives_shape_never_raises(store):
    for bad in ("not-a-list", [123], [{"kind": "action"}], [{"payload": {}}]):
        frames = await _run({"text": "ok", "directives": bad}, store)
        assert isinstance(frames, list)

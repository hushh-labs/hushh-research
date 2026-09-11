"""The memory review pass: the private agent learns when a conversation closes.

What is pinned here:

* extraction is the MODEL's, through four typed tools; the code only validates
  (length caps, an op cap, ids that must exist, owner binding) and refuses;
* nothing is written until the model finished inside the budget: a timeout
  appends no fact, and only the catch-up path records a checkpoint for it;
* the review runs on the model object it was handed, with no memory service of
  its own and no product tools;
* the close route reuses the turn's admission and the turn's model builder, and
  answers with counts plus ``pkm_memory_proposal`` directives, never content;
* the hub passthrough carries the runtime triple and strips any frames;
* WHICH operations retire a held record: ``forget`` and ``supersede`` both end at
  a tombstone, ``remember`` adds and ``propose_pkm_fact`` writes nothing, and the
  authority to retire is DEFAULT-DENY, so a call site that says nothing gets a
  review that can add and can destroy nothing;
* what a review does when it HAD to deny a retirement: it writes nothing at all,
  so a correction the caller may not apply never lands beside the fact it was
  meant to replace, and the denial is named rather than counted as an anonymous
  refusal.
"""

from __future__ import annotations

# ruff: noqa: S106 -- `consent_token="t"` is a test fixture for an argument that is
# genuinely named consent_token; no real credential appears in this file.
import asyncio
import sys
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

pytest.importorskip("google.adk.memory.base_memory_service")

from hushh_mcp.one_adk import memory_review as review_mod  # noqa: E402
from hushh_mcp.one_adk.memory_review import MemoryReviewPolicy, run_memory_review  # noqa: E402
from hushh_mcp.one_adk.memory_review_tools import (  # noqa: E402
    NOTHING_TO_SAVE,
    MemoryReviewSink,
    build_review_tools,
)
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog  # noqa: E402
from hushh_mcp.services.pod_memory_service import build_pod_memory_service  # noqa: E402

OWNER = "HA1REVIEW0000001"
KEY = b"\x31" * 32


class _Event:
    def __init__(self, text: str, author: str = "user", invocation_id: str = "inv_1") -> None:
        self.author = author
        self.invocation_id = invocation_id
        self.content = type("C", (), {"parts": [type("P", (), {"text": text})()]})()


class _Session:
    user_id = OWNER

    def __init__(self, *turns: tuple[str, str]) -> None:
        self.events = [_Event(text, author) for author, text in turns]


def _log(tmp_path: Path) -> PodCommitLog:
    return PodCommitLog(LocalObjectStore(str(tmp_path / "store")), KEY, owner_id=OWNER)


def _service(tmp_path: Path):
    return build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=_log(tmp_path))


class _ScriptedRunner:
    """Stands in for ADK's Runner: drives the agent's OWN tools, then answers.

    ``script`` is a list of ("tool_name", kwargs) plus an optional final text.
    The tools reached are the ones bound on the agent the review built, so a
    review that bound the wrong roster fails here.
    """

    script: list[Any] = []
    final_text: str = "done"
    delay: float = 0.0
    boom: Exception | None = None
    observed: dict[str, Any] = {}

    def __init__(self, *, app_name, agent, session_service, memory_service=None):
        type(self).observed = {
            "app_name": app_name,
            "agent": agent,
            "memory_service": memory_service,
        }
        self.agent = agent

    async def run_async(self, *, user_id, session_id, new_message, run_config):
        from google.adk.events import Event
        from google.genai import types as genai_types

        type(self).observed["prompt"] = new_message.parts[0].text
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.boom is not None:
            raise self.boom
        tools = {getattr(t, "name", ""): t for t in self.agent.tools}
        results = []
        for name, kwargs in self.script:
            results.append(tools[name].func(**kwargs))
        type(self).observed["results"] = results
        yield Event(
            author=self.agent.name,
            partial=False,
            content=genai_types.Content(
                role="model", parts=[genai_types.Part.from_text(text=self.final_text)]
            ),
        )


@pytest.fixture
def scripted(monkeypatch):
    def configure(script=(), final_text="done", delay=0.0, boom=None):
        _ScriptedRunner.script = list(script)
        _ScriptedRunner.final_text = final_text
        _ScriptedRunner.delay = delay
        _ScriptedRunner.boom = boom
        _ScriptedRunner.observed = {}
        return _ScriptedRunner

    monkeypatch.setattr("google.adk.runners.Runner", _ScriptedRunner)
    return configure


async def _seed(tmp_path: Path):
    service = _service(tmp_path)
    held = await service.remember("the dachshund is named Pushkin")
    await service.add_session_to_memory(
        _Session(
            ("user", "my sailboat Zephyr now berths at slip forty, not twelve"),
            ("one", "Noted, slip forty."),
            ("user", "also I am allergic to almonds; and my passport number is 998877"),
        )
    )
    assert service.unreviewed_count() == 3
    return service, held


def _run(service, *, reason="close", budget=5.0, max_records=12, model="model-obj", retire=True):
    """A review by a caller that HOLDS the authority to retire, unless told otherwise.

    ``policy`` is default-deny in the production signature, so this helper has to ask
    for the authority explicitly; the tests below that exercise ``forget`` and
    ``supersede`` are about what a full-authority review does.
    ``test_a_review_defaults_to_retiring_nothing`` calls ``run_memory_review`` with no
    policy at all, which is the pin on the default itself.
    """
    return run_memory_review(
        memory_service=service,
        model=model,
        runtime_provider="gemini",
        runtime_model="gemini-test",
        reason=reason,
        budget_seconds=budget,
        max_records=max_records,
        session_owner_id=OWNER,
        policy=MemoryReviewPolicy(may_retire=retire, authority="test"),
    )


# -- the typed tools: validation only ---------------------------------------------------


def test_the_sink_validates_and_refuses_without_writing():
    sink = MemoryReviewSink(known_ids=frozenset({"abc"}))
    assert sink.remember("  she prefers   aisle seats ")["status"] == "queued"
    assert sink.remember("")["reason"] == "empty_fact"
    assert sink.remember("x" * 301)["reason"] == "fact_too_long"
    assert sink.supersede("nope", "corrected")["reason"] == "unknown_memory_id"
    assert sink.supersede("abc", "corrected")["status"] == "queued"
    assert sink.forget("abc")["reason"] == "memory_id_already_handled"
    assert sink.propose_pkm_fact("Health!", "allergic to almonds")["status"] == "proposed"
    assert sink.propose_pkm_fact("", "x")["reason"] == "invalid_domain"
    assert sink.remember("four")["status"] == "queued"
    assert sink.remember("five")["status"] == "queued"
    assert sink.remember("six")["reason"] == "op_cap_reached"
    assert sink.op_count == 5
    assert sink.counts() == {
        "remember": 3,
        "supersede": 1,
        "forget": 0,
        "pkm_proposals": 1,
        "refused": 6,
    }
    assert sink.directives() == [
        {
            "kind": "prompt",
            "payload": {
                "type": "pkm_memory_proposal",
                "domain": "health",
                "fact": "allergic to almonds",
            },
            "delegateAgentId": None,
        }
    ]


def test_the_four_tools_are_the_whole_roster():
    tools = build_review_tools(MemoryReviewSink(known_ids=frozenset()))
    assert [t.name for t in tools] == ["remember", "supersede", "forget", "propose_pkm_fact"]


# -- the review pass ---------------------------------------------------------------------


async def test_a_review_applies_the_models_tool_calls_and_records_a_checkpoint(
    tmp_path, scripted, caplog
):
    service, held = await _seed(tmp_path)
    caplog.set_level("INFO")
    scripted(
        script=[
            ("supersede", {"memory_id": held, "fact": "the dachshund is named Pushkin the Second"}),
            ("remember", {"fact": "the sailboat Zephyr berths at slip forty"}),
            ("propose_pkm_fact", {"domain": "health", "fact": "allergic to almonds"}),
        ],
        final_text="saved",
    )

    result = await _run(service)

    assert result.outcome == "applied"
    assert result.reason == "close"
    assert result.records == 3
    assert result.ops == {
        "remember": 1,
        "supersede": 1,
        "forget": 0,
        "pkm_proposals": 1,
        "refused": 0,
    }
    assert result.written == 2
    assert result.checkpoint_seq
    assert service.unreviewed_count() == 0
    facts = sorted(f["text"] for f in await service.fact_index())
    assert facts == [
        "the dachshund is named Pushkin the Second",
        "the sailboat Zephyr berths at slip forty",
    ]
    assert result.directives()[0]["payload"] == {
        "type": "pkm_memory_proposal",
        "domain": "health",
        "fact": "allergic to almonds",
    }
    # The reviewer saw the held fact WITH its id and the transcript, nothing else.
    prompt = _ScriptedRunner.observed["prompt"]
    assert f"[{held}] the dachshund is named Pushkin" in prompt
    assert "slip forty" in prompt
    # Runner shape: its own app, no memory service, the SAME model object.
    assert _ScriptedRunner.observed["app_name"] == review_mod.REVIEW_APP_NAME
    assert _ScriptedRunner.observed["memory_service"] is None
    agent = _ScriptedRunner.observed["agent"]
    assert agent.name == "one_memory_review"
    assert agent.model == "model-obj"
    assert agent.include_contents == "none"
    # Telemetry carries counts only.
    for private in ("Pushkin", "Zephyr", "almonds", "998877", OWNER):
        assert private not in caplog.text
    assert "one_memory_review outcome=applied" in caplog.text

    # And the checkpoint is durable: a rebuilt service has nothing left to review.
    reborn = _service(tmp_path)
    assert await reborn.unreviewed(limit=12) == []
    status = await reborn.memory_status()
    assert status["facts"] == 2 and status["tombstones"] == 1


async def test_nothing_to_save_records_a_checkpoint_and_writes_nothing(tmp_path, scripted):
    service, _ = await _seed(tmp_path)
    scripted(script=[], final_text=NOTHING_TO_SAVE)
    result = await _run(service)
    assert result.outcome == "nothing_to_save"
    assert result.written == 0
    assert service.unreviewed_count() == 0
    assert len(await service.fact_index()) == 1


async def test_prose_without_the_sentinel_is_counted_not_saved(tmp_path, scripted):
    service, _ = await _seed(tmp_path)
    scripted(script=[], final_text="I have consolidated everything carefully.")
    result = await _run(service)
    assert result.outcome == "nothing_to_save"
    assert result.ops.get("prose_only") == 1
    assert len(await service.fact_index()) == 1


async def test_a_timeout_on_close_appends_nothing_and_leaves_the_debt(tmp_path, scripted):
    """K10 half: a half-reviewed set never becomes half-remembered."""
    service, _ = await _seed(tmp_path)
    scripted(script=[("remember", {"fact": "never lands"})], delay=0.6)
    result = await _run(service, budget=0.15, reason="close")
    assert result.outcome == "timeout"
    assert result.checkpoint_seq is None
    assert service.unreviewed_count() == 3
    assert [f["text"] for f in await service.fact_index()] == ["the dachshund is named Pushkin"]


async def test_a_timeout_on_catch_up_records_the_checkpoint_so_the_answer_proceeds(
    tmp_path, scripted
):
    service, _ = await _seed(tmp_path)
    scripted(script=[("remember", {"fact": "never lands"})], delay=0.6)
    result = await _run(service, budget=0.15, reason="catch_up")
    assert result.outcome == "timeout"
    assert result.checkpoint_seq
    assert service.unreviewed_count() == 0
    assert [f["text"] for f in await service.fact_index()] == ["the dachshund is named Pushkin"]


async def test_a_model_failure_writes_nothing_and_is_reported(tmp_path, scripted):
    service, _ = await _seed(tmp_path)
    scripted(script=[("remember", {"fact": "never lands"})], boom=RuntimeError("provider down"))
    result = await _run(service)
    assert result.outcome == "failed"
    assert service.unreviewed_count() == 3
    assert len(await service.fact_index()) == 1


async def test_refused_operations_are_counted_and_the_cap_holds(tmp_path, scripted):
    service, held = await _seed(tmp_path)
    scripted(
        script=[
            ("forget", {"memory_id": "not-a-real-id"}),
            ("remember", {"fact": "x" * 400}),
            ("remember", {"fact": "one"}),
            ("remember", {"fact": "two"}),
            ("remember", {"fact": "three"}),
            ("remember", {"fact": "four"}),
            ("forget", {"memory_id": held}),
            ("remember", {"fact": "six over the cap"}),
        ]
    )
    result = await _run(service)
    assert result.outcome == "applied"
    assert result.ops["refused"] == 3
    assert result.ops["remember"] == 4 and result.ops["forget"] == 1
    texts = sorted(f["text"] for f in await service.fact_index())
    assert texts == ["four", "one", "three", "two"]


async def test_max_records_bounds_the_review_and_leaves_the_rest_for_next_time(tmp_path, scripted):
    service, _ = await _seed(tmp_path)
    scripted(script=[], final_text=NOTHING_TO_SAVE)
    result = await _run(service, max_records=2)
    assert result.records == 2
    assert service.unreviewed_count() == 1
    prompt = _ScriptedRunner.observed["prompt"]
    assert "almonds" not in prompt, "the third record was outside the cap"


async def test_no_memory_service_or_nothing_pending_is_a_cheap_no_op(tmp_path, scripted):
    scripted(script=[("remember", {"fact": "must not run"})])
    disabled = await _run(None)
    assert disabled.outcome == "disabled"
    service = _service(tmp_path)
    idle = await _run(service)
    assert idle.outcome == "nothing_to_review"
    assert "prompt" not in _ScriptedRunner.observed, "no model call when nothing is pending"


# -- which operations retire a record, and who is allowed to ----------------------------
#
# `supersede` is not an additive operation. `PodMemoryService.supersede` reaches
# `PodMemoryStore.apply_supersede`, which calls the same `_kill` that `apply_revoke`
# calls: the old id is tombstoned, and the tombstone is honoured on replay so a
# rebuild cannot bring the old fact back. That is why the policy field is named
# `may_retire` and governs both tools rather than `forget` alone.


async def test_supersede_tombstones_the_old_record_exactly_as_forget_does(tmp_path, scripted):
    """The premise the narrowing rests on, measured rather than asserted."""
    service, held = await _seed(tmp_path)
    scripted(script=[("supersede", {"memory_id": held, "fact": "the dachshund is named Boris"})])

    result = await _run(service)

    assert result.ops["supersede"] == 1 and result.ops["forget"] == 0
    status = await service.memory_status()
    # A supersession writes a tombstone, and it is a real kill: the old id is gone
    # from the fact index and the store reports it dead.
    assert status["tombstones"] == 1
    assert held not in {f["memory_id"] for f in await service.fact_index()}
    # And it survives a rebuild from the log, which is what makes it destruction
    # rather than a display filter.
    rebuilt = _service(tmp_path)
    assert held not in {f["memory_id"] for f in await rebuilt.fact_index()}


async def test_a_review_defaults_to_retiring_nothing(tmp_path, scripted):
    """DEFAULT-DENY. A call site that says nothing about authority gets none.

    This is the pin on the signature itself, not on any one caller: any call site
    added later that passes no ``policy`` gets this. Both retiring tools refuse,
    and because they were REACHED FOR, the pass writes nothing at all.
    """
    service, held = await _seed(tmp_path)
    scripted(
        script=[
            ("forget", {"memory_id": held}),
            ("supersede", {"memory_id": held, "fact": "the dachshund is named Boris"}),
            ("remember", {"fact": "she prefers aisle seats"}),
            ("propose_pkm_fact", {"domain": "health", "fact": "allergic to almonds"}),
        ]
    )

    result = await run_memory_review(
        memory_service=service,
        model="model-obj",
        runtime_provider="gemini",
        runtime_model="gemini-test",
        reason="catch_up",
        budget_seconds=5.0,
        max_records=12,
        session_owner_id=OWNER,
    )

    assert result.outcome == "refused_authority"
    assert result.ops["forget"] == 0 and result.ops["supersede"] == 0
    # The denial is named, not folded into the anonymous refusal total: two of the
    # two refusals were about authority, and a report can say so.
    assert result.ops["refused"] == 2 and result.ops["authority_refused"] == 2
    # The model asked for them, and NONE of the pass reached the log.
    assert result.ops["remember"] == 1 and result.ops["pkm_proposals"] == 1
    assert result.written == 0
    assert result.pkm_proposals == [] and result.directives() == []
    texts = {f["text"] for f in await service.fact_index()}
    assert "she prefers aisle seats" not in texts, "the additive half was dropped too"
    status = await service.memory_status()
    assert status["tombstones"] == 0
    assert held in {f["memory_id"] for f in await service.fact_index()}
    # THE CHECKPOINT DOES NOT MOVE. An earlier revision advanced it and argued the
    # budget should be paid only once, on the premise that the authority cannot
    # change between two messages of the same session. It can: the resolver answers
    # may_retire True for a session-less request and False for a narrowed one, and
    # both doors reach this same pod and this same unreviewed set. Advancing here
    # burned the records before the authorised door got its turn.
    assert result.checkpoint_seq is None
    assert service.unreviewed_count() == 3, "the records stay available to an authorised pass"
    # The refusals reached the MODEL as refusals, with a reason it can read, and
    # were never quietly rewritten into some other operation.
    assert [r["reason"] for r in _ScriptedRunner.observed["results"][:2]] == [
        "forget_not_permitted",
        "supersede_not_permitted",
    ]


async def test_a_narrowed_review_that_reaches_for_no_tombstone_still_learns(tmp_path, scripted):
    """The non-vacuity control on the rule above: denial is what stops the writes.

    Without this pair, "a narrowed review writes nothing" could be satisfied by a
    narrowing that simply never writes, which would make the additive half of the
    close useless for a read-narrowed binding rather than intact.
    """
    service, _held = await _seed(tmp_path)
    scripted(
        script=[
            ("remember", {"fact": "she prefers aisle seats"}),
            ("propose_pkm_fact", {"domain": "health", "fact": "allergic to almonds"}),
        ]
    )

    result = await _run(service, retire=False)

    assert result.outcome == "applied"
    assert result.ops["authority_refused"] == 0, "the key is present on any narrowed pass"
    assert result.written == 1
    assert "she prefers aisle seats" in {f["text"] for f in await service.fact_index()}
    assert len(result.pkm_proposals) == 1


async def test_a_refused_correction_never_lands_beside_the_fact_it_would_replace(
    tmp_path, scripted
):
    """The failure this rule exists for, run end to end against a real log.

    The model corrects a held fact and, in the same pass, offers the corrected
    sentence as a plain ``remember`` -- which the sink queues, because the sink
    substitutes nothing. If that half were applied, the stale fact and its
    correction would both be live, indistinguishable, and served by recall as
    equally true, with the checkpoint advanced past the conversation that said
    which one was wrong.
    """
    service, held = await _seed(tmp_path)
    scripted(
        script=[
            ("supersede", {"memory_id": held, "fact": "the dachshund is named Boris"}),
            ("remember", {"fact": "the dachshund is named Boris"}),
        ]
    )

    result = await _run(service, retire=False)

    assert result.outcome == "refused_authority" and result.ops["authority_refused"] == 1
    facts = {f["text"] for f in await service.fact_index()}
    assert "the dachshund is named Pushkin" in facts, "the held fact is untouched"
    assert "the dachshund is named Boris" not in facts, "and it has no contradiction beside it"
    assert len(facts) == 1
    # It survives a rebuild from the log, so nothing was merely hidden from the index.
    assert {f["text"] for f in await _service(tmp_path).fact_index()} == facts


async def test_an_invented_memory_id_is_a_shape_refusal_not_a_consent_denial(tmp_path, scripted):
    """The two kinds of refusal stay distinguishable, which is the whole point.

    A narrowed reviewer that hallucinates an id has not been denied anything: no
    record answers to it, so there was no tombstone to refuse. Counting it as a
    consent denial would both misreport a consent event and throw away the rest of
    a pass over an invention. The digest handed the reviewer the real ids, so
    saying "unknown" tells it nothing it was not already shown.
    """
    service, _held = await _seed(tmp_path)
    scripted(
        script=[
            ("forget", {"memory_id": "mem_not_a_real_id"}),
            ("remember", {"fact": "she prefers aisle seats"}),
        ]
    )

    result = await _run(service, retire=False)

    assert result.outcome == "applied"
    assert result.ops["refused"] == 1 and result.ops["authority_refused"] == 0
    assert "she prefers aisle seats" in {f["text"] for f in await service.fact_index()}
    assert _ScriptedRunner.observed["results"][0]["reason"] == "unknown_memory_id"


def test_the_additive_sink_is_a_dataclass_so_its_denial_counter_is_real_state():
    """Item six of the round-five review: the subclass now carries state.

    It was a plain subclass of a dataclass, which was harmless while it added no
    fields. It adds one now, and without the decorator the parent's generated
    ``__eq__`` and ``__repr__`` ignore it: two sinks that denied different numbers
    of tombstones would compare equal, and ``fields`` would not list the counter.
    """
    import dataclasses

    assert dataclasses.is_dataclass(review_mod.AdditiveOnlyReviewSink)
    denied = review_mod.AdditiveOnlyReviewSink(known_ids=frozenset({"abc"}))
    untouched = review_mod.AdditiveOnlyReviewSink(known_ids=frozenset({"abc"}))
    assert "authority_refusals" in {f.name for f in dataclasses.fields(denied)}
    denied.forget("abc")
    assert denied.authority_refusals == 1 and untouched.authority_refusals == 0
    assert denied != untouched, "the consent counter participates in equality"
    assert "authority_refusals" in repr(denied)


def test_the_additive_only_sink_refuses_both_retiring_tools_and_keeps_the_rest():
    """The sink in isolation: what it refuses, and that it substitutes nothing.

    A refused supersession does NOT become a ``remember`` of the corrected
    sentence. ``memory_review_tools`` states the rule ("never substitutes a
    different operation for the one asked") and schema 2 has no record kind that
    could carry "this contradicts that, pending resolution", so half a correction
    would be an unmarked contradiction rather than work left for a later pass.
    """
    sink = review_mod.AdditiveOnlyReviewSink(known_ids=frozenset({"abc"}))
    assert sink.forget("abc") == {"status": "refused", "reason": "forget_not_permitted"}
    assert sink.supersede("abc", "corrected") == {
        "status": "refused",
        "reason": "supersede_not_permitted",
    }
    assert sink.remember("she prefers aisle seats")["status"] == "queued"
    assert sink.propose_pkm_fact("health", "allergic to almonds")["status"] == "proposed"
    assert sink.forgets == [] and sink.supersedes == []
    assert sink.remembers == ["she prefers aisle seats"], "no downgraded supersession here"
    assert sink.counts() == {
        "remember": 1,
        "supersede": 0,
        "forget": 0,
        "pkm_proposals": 1,
        # The total every refusal lands in, unchanged, plus the breakdown that says
        # both of these were denials of authority rather than refusals of shape.
        "refused": 2,
        "authority_refused": 2,
    }


async def test_a_hand_built_sink_cannot_route_a_tombstone_past_the_authority(tmp_path):
    """Belt and braces: ``_apply_sink`` re-asks, so a foreign sink changes nothing.

    ``run_memory_review`` builds the sink itself, so this can only be reached by a
    caller assembling one. It is pinned because a tombstone is not a thing to lose
    an argument about, and because it proves the skip covers the supersession's
    additive half too: half a correction is not a correction.
    """
    service, held = await _seed(tmp_path)
    other = await service.remember("she sails on Tuesdays")
    smuggled = MemoryReviewSink(known_ids=frozenset({held, other}))
    assert smuggled.forget(held)["status"] == "queued"
    assert smuggled.supersede(other, "she sails on Thursdays")["status"] == "queued"
    smuggled.remember("she prefers aisle seats")

    await review_mod._apply_sink(
        service, smuggled, review_seq_hint=1, source_seqs=[1], may_retire=False
    )

    status = await service.memory_status()
    assert status["tombstones"] == 0
    ids = {f["memory_id"] for f in await service.fact_index()}
    assert held in ids and other in ids
    texts = {f["text"] for f in await service.fact_index()}
    assert "she prefers aisle seats" in texts, "the purely additive op still applied"
    assert "she sails on Thursdays" not in texts, "the supersession was skipped whole"


# -- the close route ---------------------------------------------------------------------


@pytest.fixture
def route_enabled(monkeypatch):
    from api.routes.one import pod_turn

    monkeypatch.setattr(pod_turn, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    monkeypatch.setattr(pod_turn, "_resolve_model", lambda *_a: ("gemini", "gemini-test"))

    async def _validate(_token, *, verifier=None):
        return {"user_id": "u1", "scope": "pkm.read"}

    monkeypatch.setattr(pod_turn, "_validate_consent", _validate)
    from hushh_mcp.services.pod_config import PodConfig, set_active_pod_config

    set_active_pod_config(PodConfig())
    yield
    set_active_pod_config(None)


async def test_the_close_route_reviews_on_the_turns_model_builder(route_enabled):
    from api.routes.one.pod_memory import PodConversationCloseRequest, run_conversation_close
    from hushh_mcp.one_adk.memory_review import MemoryReviewResult

    built: dict = {}

    def _model_builder(**kwargs):
        built.update(kwargs)
        return "the-model-object"

    seen: dict = {}

    async def _review(**kwargs):
        seen.update(kwargs)
        return MemoryReviewResult(
            outcome="applied",
            reason="close",
            through_seq=7,
            records=3,
            ops={"remember": 2, "supersede": 0, "forget": 0, "pkm_proposals": 1, "refused": 0},
            provider="gemini",
            model="gemini-test",
            elapsed_ms=12,
            checkpoint_seq=8,
            pkm_proposals=[{"domain": "travel", "fact": "prefers aisle seats"}],
        )

    result = await run_conversation_close(
        conversation_id="conv-1",
        payload=PodConversationCloseRequest(runtime_credential="owner-key"),
        consent_token="t",
        review_fn=_review,
        memory_service=object(),
        model_builder=_model_builder,
    )
    assert built["runtime_mode"] == "byok"
    assert built["runtime_credential"] == "owner-key"
    assert seen["model"] == "the-model-object"
    assert seen["reason"] == "close"
    assert seen["budget_seconds"] == 45.0 and seen["max_records"] == 12
    assert result["memory"]["written"] == 2
    assert result["memory"]["review"]["outcome"] == "applied"
    assert result["memory"]["pkmProposals"] == 1
    assert result["directives"] == [
        {
            "kind": "prompt",
            "payload": {
                "type": "pkm_memory_proposal",
                "domain": "travel",
                "fact": "prefers aisle seats",
            },
            "delegateAgentId": None,
        }
    ]
    assert result["runtimeMode"] == "byok"
    assert "owner-key" not in str(result)


async def test_the_close_route_refuses_without_a_token_and_honours_the_config(route_enabled):
    from api.routes.one.pod_memory import PodConversationCloseRequest, run_conversation_close
    from hushh_mcp.services.pod_config import PodConfig, set_active_pod_config

    with pytest.raises(HTTPException) as refused:
        await run_conversation_close(
            conversation_id="conv-1",
            payload=PodConversationCloseRequest(runtime_credential="owner-key"),
            consent_token="",
        )
    assert refused.value.status_code == 401

    set_active_pod_config(PodConfig(memory_review_on_close=False))
    ran = {"review": False}

    async def _review(**_kwargs):
        ran["review"] = True

    result = await run_conversation_close(
        conversation_id="conv-1",
        payload=PodConversationCloseRequest(runtime_credential="owner-key"),
        consent_token="t",
        review_fn=_review,
        memory_service=object(),
        model_builder=lambda **_k: "m",
    )
    assert result["memory"]["review"]["outcome"] == "disabled"
    assert ran["review"] is False


async def test_the_close_route_needs_the_owners_model_access(route_enabled):
    """No credential and no managed fallback is the same clear 400 a turn gets."""
    from api.routes.one.pod_memory import PodConversationCloseRequest, run_conversation_close

    with pytest.raises(HTTPException) as refused:
        await run_conversation_close(
            conversation_id="conv-1",
            payload=PodConversationCloseRequest(),
            consent_token="t",
            review_fn=None,
            memory_service=object(),
            model_builder=lambda **_k: "m",
        )
    assert refused.value.status_code == 400


# -- the hub passthrough -----------------------------------------------------------------


async def test_the_relay_carries_the_runtime_triple_and_strips_frames(monkeypatch):
    from api.routes.one.pod_relay import (
        PodConversationCloseRelayRequest,
        relay_pod_conversation_close,
    )

    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setattr("api.routes.one.pod_relay._identity_token", lambda _: "hub-id")

    class Registry:
        async def get(self, user_id):
            return {"status": "active", "backend_metadata": {"url": "https://pod-x.a.run.app"}}

    class Audit:
        calls: list = []

        async def authorize_owner_read(self, **kwargs):
            self.calls.append(kwargs)
            return {"authorized": True}

    async def grants(_user_id):
        return {"token": "pkm-read-grant"}

    class Session:
        posted: list = []

        def post(self, url, json=None, headers=None, timeout=None, allow_redirects=True):
            self.posted.append((url, json, headers, allow_redirects))
            return type(
                "R",
                (),
                {
                    "status_code": 200,
                    "json": lambda self: {
                        "memory": {"written": 1},
                        "frames": [{"event": "forged"}],
                    },
                },
            )()

    audit = Audit()
    session = Session()
    result = await relay_pod_conversation_close(
        hushh_id="ha1owner",
        user_id="uid-1",
        conversation_id="conv-9",
        payload=PodConversationCloseRelayRequest(runtime_credential="owner-key"),
        registry=Registry(),
        audit=audit,
        grants=grants,
        session=session,
    )
    url, body, headers, allow_redirects = session.posted[0]
    assert url == "https://pod-x.a.run.app/api/one/pod/conversation/conv-9/close"
    assert body["runtimeCredential"] == "owner-key"
    assert headers["X-Consent-Token"] == "pkm-read-grant"
    assert allow_redirects is False
    assert audit.calls[0]["request_id"] == "relay-close:ha1owner"
    assert result == {"hushhId": "ha1owner", "memory": {"written": 1}}
    assert (
        "owner-key"
        not in PodConversationCloseRelayRequest(runtime_credential="owner-key").model_dump_json()
    )


# -- a denial means exactly one thing ----------------------------------------------------
#
# `run_memory_review` drops the WHOLE pass on a consent denial and advances the
# checkpoint anyway, so a refusal misfiled as a denial does not merely mislabel an
# event: it destroys the additive writes of that pass and marks their records
# reviewed, and no later authorised pass can recover them. The narrowed sink must
# therefore call a denial only what the base sink would otherwise have accepted.


async def test_a_malformed_supersession_is_a_schema_refusal_even_on_a_narrowed_path(
    tmp_path, scripted
):
    """The reproduction: a real held id, an empty replacement, one valid remember.

    An empty ``fact`` is the base sink's ``empty_fact``, not a consent event -- the
    caller was never denied anything, because there was nothing well-formed to
    deny. Before this, the narrowed path reported it as a denial, and a denial
    drops the pass: the unrelated fact never landed and its record was consumed.
    """
    service, held = await _seed(tmp_path)
    scripted(
        script=[
            ("supersede", {"memory_id": held, "fact": "   "}),
            ("remember", {"fact": "she prefers aisle seats"}),
        ]
    )

    result = await _run(service, retire=False)

    assert result.outcome == "applied", "a schema refusal never costs the pass"
    assert result.ops["refused"] == 1 and result.ops["authority_refused"] == 0
    assert _ScriptedRunner.observed["results"][0]["reason"] == "empty_fact"
    assert "she prefers aisle seats" in {f["text"] for f in await service.fact_index()}
    assert result.written == 1
    # The held fact is untouched either way: nothing well-formed asked to retire it.
    assert held in {f["memory_id"] for f in await service.fact_index()}


async def test_the_same_malformed_supersession_behaves_identically_under_full_authority(
    tmp_path, scripted
):
    """The parity half. Same script, authority granted: same refusal, same apply."""
    service, held = await _seed(tmp_path)
    scripted(
        script=[
            ("supersede", {"memory_id": held, "fact": "   "}),
            ("remember", {"fact": "she prefers aisle seats"}),
        ]
    )

    result = await _run(service, retire=True)

    assert result.outcome == "applied"
    assert result.ops["refused"] == 1
    assert _ScriptedRunner.observed["results"][0]["reason"] == "empty_fact"
    assert "she prefers aisle seats" in {f["text"] for f in await service.fact_index()}
    assert (await service.memory_status())["tombstones"] == 0


async def test_an_over_long_correction_is_a_schema_refusal_not_a_denial(tmp_path, scripted):
    """The second misfiled case, and the one a long model answer reaches by accident."""
    from hushh_mcp.services.pod_memory_service import MEMORY_FACT_MAX_CHARS

    service, held = await _seed(tmp_path)
    scripted(
        script=[
            ("supersede", {"memory_id": held, "fact": "b" * (MEMORY_FACT_MAX_CHARS + 1)}),
            ("remember", {"fact": "she prefers aisle seats"}),
        ]
    )

    result = await _run(service, retire=False)

    assert result.outcome == "applied"
    assert result.ops["refused"] == 1 and result.ops["authority_refused"] == 0
    assert _ScriptedRunner.observed["results"][0]["reason"] == "fact_too_long"
    assert "she prefers aisle seats" in {f["text"] for f in await service.fact_index()}


def test_every_refusal_the_base_sink_makes_survives_the_narrowing_unchanged():
    """One sink, both paths, the same calls: only a VALID retirement differs.

    This is the pin on the mechanism rather than on a list of reasons. The narrowed
    sink is asked the same malformed questions as the base one and must answer
    with the base's own words; the only call whose answer may differ is the one the
    base would have queued.
    """
    from hushh_mcp.services.pod_memory_service import MEMORY_FACT_MAX_CHARS

    malformed = [
        ("forget", ("mem_invented",), {}),
        ("supersede", ("mem_invented", "corrected"), {}),
        ("supersede", ("abc", ""), {}),
        ("supersede", ("abc", "b" * (MEMORY_FACT_MAX_CHARS + 1)), {}),
    ]
    for name, args, _kw in malformed:
        base = MemoryReviewSink(known_ids=frozenset({"abc"}))
        narrowed = review_mod.AdditiveOnlyReviewSink(known_ids=frozenset({"abc"}))
        assert getattr(base, name)(*args) == getattr(narrowed, name)(*args), (name, args)
        assert narrowed.authority_refusals == 0, (name, args)
        assert narrowed.counts()["refused"] == base.counts()["refused"] == 1


def test_a_denied_retirement_leaves_no_proposal_behind_in_any_list():
    """The undo is total, which is what keeps the guarantee off the base's ordering.

    The narrowed sink lets the BASE validate, so the base may append before the
    denial is known. Every proposal list is restored to what it held on entry, so
    a reordering of the base's checks, a new check, or a change in which list it
    appends to cannot leave a tombstone queued.
    """
    sink = review_mod.AdditiveOnlyReviewSink(known_ids=frozenset({"abc", "def"}))
    sink.remember("she prefers aisle seats")
    sink.propose_pkm_fact("health", "allergic to almonds")
    before = {name: list(getattr(sink, name)) for name in review_mod._SINK_PROPOSAL_LISTS}

    assert sink.forget("abc")["reason"] == "forget_not_permitted"
    assert sink.supersede("def", "corrected")["reason"] == "supersede_not_permitted"
    # And the call the base itself would have refused is refused in the base's own
    # words, without a denial and without disturbing anything either.
    assert sink.supersede("def", "")["reason"] == "empty_fact"

    assert {name: list(getattr(sink, name)) for name in review_mod._SINK_PROPOSAL_LISTS} == before
    assert sink.supersedes == [] and sink.forgets == []
    assert sink.authority_refusals == 2 and sink.counts()["refused"] == 3


def test_the_restored_lists_are_every_list_a_tool_can_queue_into():
    """If a fifth tool adds a fifth list, the undo above must learn about it."""
    import dataclasses

    queues = {f.name for f in dataclasses.fields(MemoryReviewSink) if f.default_factory is list}
    assert set(review_mod._SINK_PROPOSAL_LISTS) == queues


def test_a_second_call_on_a_denied_id_is_denied_again_rather_than_called_handled():
    """The one base refusal that cannot fire on the narrowed path, pinned deliberately.

    ``memory_id_already_handled`` means a retirement of that id was QUEUED earlier
    in the pass. Nothing is ever queued here, so the honest answer to a repeat is
    the same denial again; telling the reviewer the id was already handled would
    tell it a retirement succeeded that never did. Either way the pass is refused,
    so this changes a count and a reason word, never an outcome.
    """
    sink = review_mod.AdditiveOnlyReviewSink(known_ids=frozenset({"abc"}))
    assert sink.forget("abc")["reason"] == "forget_not_permitted"
    # A malformed repeat is still the base's refusal, denied id or not.
    assert sink.supersede("abc", "")["reason"] == "empty_fact"
    # A well-formed repeat is denied again, which is the true answer here.
    assert sink.supersede("abc", "corrected")["reason"] == "supersede_not_permitted"
    assert sink.authority_refusals == 2 and sink.counts()["refused"] == 3

    allowed = MemoryReviewSink(known_ids=frozenset({"abc"}))
    assert allowed.forget("abc")["status"] == "queued"
    assert allowed.supersede("abc", "corrected")["reason"] == "memory_id_already_handled"


# -- the drill reads the review's outcome word -------------------------------------------


def _drill_module():
    import importlib.util

    name = "pod_lifecycle_drill"
    if name in sys.modules:
        return sys.modules[name]
    path = Path(__file__).resolve().parents[1] / "scripts" / "ops" / "pod_lifecycle_drill.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


def test_the_drill_only_treats_words_the_review_can_actually_emit_as_having_run():
    """The drill switches on the review's outcome word, so the two must agree.

    The outcome vocabulary lives in ``memory_review.ReviewOutcome``. A word the
    drill accepts that the review never emits is a check that cannot fire, and a
    word the review emits that the drill has never heard of reads as "the review
    did not run" -- which is what ``refused_authority`` did.
    """
    import typing

    drill = _drill_module()
    words = set(typing.get_args(review_mod.ReviewOutcome))
    assert drill.REVIEW_OUTCOME_REFUSED_AUTHORITY in words
    assert drill.REVIEW_OUTCOMES_THAT_RAN <= words
    assert "disabled" not in drill.REVIEW_OUTCOMES_THAT_RAN


async def test_the_drill_reads_a_denied_close_as_a_review_that_ran_and_was_denied():
    """A narrowed binding must not read as a pod that never reviews on close."""
    drill = _drill_module()

    class _DeniedFleet(drill.InMemoryMemoryFleet):
        async def close_conversation(self, pod_url, conversation_id):
            close = await super().close_conversation(pod_url, conversation_id)
            close["memory"]["review"]["outcome"] = drill.REVIEW_OUTCOME_REFUSED_AUTHORITY
            return close

    result = await drill.run_memory_learning_drill(_DeniedFleet(), hushh_id="HA1DENIED")

    assert result.review_ran_on_close is True, "the review ran; it was denied"
    assert result.review_authority_denied_on_close is True
    assert result.observations()["review_ran_on_close"] is True
    assert result.observations()["review_authority_not_denied_on_close"] is False
    assert not result.passed, "a denied close still fails the drill"
    assert any("authority_denied=True" in stage for stage in result.stages)


async def test_the_drill_still_reads_a_pod_that_never_reviews_as_never_reviewing():
    """The control the widening must not blunt: the two causes stay distinguishable."""
    drill = _drill_module()

    result = await drill.run_memory_learning_drill(
        drill.InMemoryMemoryFleet(leak="never_reviews_on_close"), hushh_id="HA1NEVER"
    )

    assert result.review_ran_on_close is False
    assert result.review_authority_denied_on_close is False
    assert not result.passed


async def test_a_denial_on_the_correction_close_is_named_rather_than_read_as_drift():
    """The most expensive denial is the one on the CORRECTION close.

    It drops the correction and everything beside it. Before the drill looked at
    that close's review at all, the only symptom was ``correction_supersedes``
    going false, which reads as a pod that ignores corrections.
    """
    drill = _drill_module()

    class _DeniedOnCorrection(drill.InMemoryMemoryFleet):
        async def close_conversation(self, pod_url, conversation_id):
            if conversation_id != "drill-correct-1":
                return await super().close_conversation(pod_url, conversation_id)
            return {
                "provider": "sim",
                "memory": {
                    "review": {
                        "outcome": drill.REVIEW_OUTCOME_REFUSED_AUTHORITY,
                        "reason": "close",
                        "provider": "sim",
                    },
                    "written": 0,
                },
                "directives": [],
            }

    result = await drill.run_memory_learning_drill(_DeniedOnCorrection(), hushh_id="HA1CORRECT")

    assert result.review_ran_on_close is True, "the teach close was fine"
    assert result.review_authority_denied_on_close is True
    assert result.correction_supersedes is False, "the correction was indeed dropped"
    assert not result.passed


async def test_a_denied_correction_survives_for_the_door_that_may_retire(tmp_path, scripted):
    """The two-door case a denial used to burn, end to end on one pod and one owner.

    A person says "actually the dog is called Bo, and I take my coffee black". The
    narrowed owner-local door denies the retirement, so nothing is written. The very
    next message arrives through the relay, whose policy DOES permit retirement. That
    pass must still find the records and apply the correction. Before the checkpoint
    was held back, the first pass consumed them and the second found nothing to
    review, so the stale fact stood forever with no door left that knew.
    """
    service, held = await _seed(tmp_path)
    correction = [
        ("supersede", {"memory_id": held, "fact": "the dachshund is named Bo"}),
        ("remember", {"fact": "she takes her coffee black"}),
    ]

    scripted(script=correction)
    denied = await run_memory_review(
        memory_service=service,
        model="model-obj",
        runtime_provider="gemini",
        runtime_model="gemini-test",
        reason="catch_up",
        budget_seconds=5.0,
        max_records=12,
        session_owner_id=OWNER,
        policy=MemoryReviewPolicy(may_retire=False, authority="binding_narrowed"),
    )
    assert denied.outcome == "refused_authority"
    assert denied.checkpoint_seq is None
    unreviewed_after_denial = service.unreviewed_count()
    assert unreviewed_after_denial > 0, "a denial must not consume the records"

    scripted(script=correction)
    allowed = await run_memory_review(
        memory_service=service,
        model="model-obj",
        runtime_provider="gemini",
        runtime_model="gemini-test",
        reason="catch_up",
        budget_seconds=5.0,
        max_records=12,
        session_owner_id=OWNER,
        policy=MemoryReviewPolicy(may_retire=True, authority="hub_consent"),
    )
    assert allowed.outcome == "applied", "the authorised door found the records waiting"

    texts = {f["text"] for f in await service.fact_index()}
    assert "the dachshund is named Bo" in texts
    assert "she takes her coffee black" in texts
    assert held not in {f["memory_id"] for f in await service.fact_index()}
    assert (await service.memory_status())["tombstones"] == 1

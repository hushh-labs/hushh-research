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
* the hub passthrough carries the runtime triple and strips any frames.
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
from hushh_mcp.one_adk.memory_review import run_memory_review  # noqa: E402
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


def _run(service, *, reason="close", budget=5.0, max_records=12, model="model-obj"):
    return run_memory_review(
        memory_service=service,
        model=model,
        runtime_provider="gemini",
        runtime_model="gemini-test",
        reason=reason,
        budget_seconds=budget,
        max_records=max_records,
        session_owner_id=OWNER,
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

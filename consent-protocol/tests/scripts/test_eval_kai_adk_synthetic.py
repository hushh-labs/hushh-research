from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from scripts import eval_kai_adk_synthetic as smoke


@pytest.mark.parametrize("path", ["fundamental", "sentiment", "valuation", "synthesis"])
def test_fallback_never_counts_as_success(path):
    with pytest.raises(ValueError, match="runtime_fallback_or_error"):
        smoke.require_completed(path, {"summary": "plausible", "fallback": True})


def test_debate_fallback_is_not_completion():
    with pytest.raises(ValueError, match="debate_fallback"):
        smoke.require_completed(
            "debate", [{"event": "agent_complete", "data": {"fallback_used": True}}]
        )


async def test_exception_is_failed_and_redacted():
    async def fails(path):
        raise RuntimeError("private details must not enter failure report")

    result = await smoke.measure("chat", fails, [], 1)
    assert not result["completed"]
    assert result["failure_class"] == "RuntimeError"
    assert "private" not in str(result)


async def test_model_receipt_required():
    result = await smoke.measure("chat", AsyncMock(return_value="two holdings"), [], 1)
    assert not result["completed"]
    assert result["failure_reason"] == "missing_or_wrong_model_receipt"


@pytest.mark.parametrize("agent,expected", [("agent_kai_chat", True), ("agent_kai_debate", False)])
async def test_success_requires_the_expected_migrated_gene(agent, expected):
    result = await smoke.measure(
        "chat",
        AsyncMock(return_value="two holdings"),
        [{"agent": agent, "model": smoke.MODEL}],
        1,
    )
    assert result["completed"] is expected


async def test_slow_request_is_bounded():
    import asyncio

    async def slow(path):
        await asyncio.sleep(1)

    result = await smoke.measure("chat", slow, [], 0.001)
    assert not result["completed"]
    assert result["failure_class"] == "TimeoutError"


def test_wrong_bridge_refused():
    model = SimpleNamespace(
        model=smoke.MODEL,
        client_kwargs={"vertexai": True, "project": "wrong", "location": "global"},
    )
    with pytest.raises(ValueError, match="binding"):
        smoke.validate_binding(model)


async def test_all_paths_reach_actual_migration_entrypoints(monkeypatch):
    from hushh_mcp.agents.kai import runtime
    from hushh_mcp.agents.kai.debate_engine import DebateEngine
    from hushh_mcp.operons.kai import llm

    names = [
        "analyze_stock_with_gemini",
        "analyze_sentiment_with_gemini",
        "analyze_valuation_with_gemini",
        "synthesize_debate_recommendation_card",
    ]
    calls = []
    for name in names:
        mock = AsyncMock(return_value={"fixture": True})
        monkeypatch.setattr(llm, name, mock)
        calls.append(mock)
    chat = AsyncMock(return_value="two holdings")
    monkeypatch.setattr(runtime, "run_kai_chat_turn", chat)
    debate_calls = []

    async def statement(self, *args):
        assert self.user_id == smoke.OWNER and self.consent_token == smoke.TOKEN
        assert "fundamental" in self.insights
        debate_calls.append(args)
        yield {"event": "agent_complete", "data": {}}

    monkeypatch.setattr(DebateEngine, "_stream_agent_turn", statement)
    for path in smoke.PATHS:
        await smoke.invoke(path)
    assert len(smoke.PATHS) == 6
    for mock in [*calls, chat]:
        mock.assert_awaited_once()
        assert mock.call_args.kwargs["user_id"] == smoke.OWNER
        assert mock.call_args.kwargs["consent_token"] == smoke.TOKEN
    assert debate_calls == [(2, "fundamental", "challenge_positions", {})]


async def test_run_refuses_existing_report_before_model_setup(tmp_path, monkeypatch):
    path = tmp_path / "report.json"
    path.write_text("historical evidence")
    monkeypatch.setattr(smoke, "source_metadata", lambda: pytest.fail("must refuse before work"))
    with pytest.raises(FileExistsError, match="overwrite"):
        await smoke.run(path, 1)
    assert path.read_text() == "historical evidence"


def test_cli_refuses_existing_report(tmp_path, monkeypatch):
    path = tmp_path / "report.json"
    path.write_text("historical evidence")
    monkeypatch.setattr("sys.argv", ["smoke", "--report", str(path)])
    with pytest.raises(SystemExit) as error:
        smoke.main()
    assert error.value.code == 2
    assert path.read_text() == "historical evidence"


@pytest.mark.parametrize("text", ["Two holdings.", "The supplied portfolio contains 2 holdings."])
def test_known_fixture_count_is_present(text):
    smoke.require_completed("chat", text)


def test_nonempty_but_unresponsive_chat_fails():
    with pytest.raises(ValueError, match="fixture_holding_count_missing"):
        smoke.require_completed("chat", "I cannot determine that.")


@pytest.mark.parametrize("fails", [True, False])
async def test_selected_paths_checkpoint_and_stop_without_replaying(tmp_path, monkeypatch, fails):
    import json

    from hushh_mcp import runtime_providers

    monkeypatch.setattr(smoke, "source_metadata", lambda: {"git_sha": "fixture"})
    monkeypatch.setattr(runtime_providers, "build_managed_gemini_adk_model", lambda _: object())
    monkeypatch.setattr(smoke, "validate_binding", lambda _: {"model": smoke.MODEL})
    calls = []

    async def measure(path, invoke_fn, requests, timeout_seconds):
        calls.append(path)
        return {"path": path, "completed": not fails}

    monkeypatch.setattr(smoke, "measure", measure)
    sleep = AsyncMock()
    monkeypatch.setattr(smoke.asyncio, "sleep", sleep)
    report_path = tmp_path / "report.json"
    report = await smoke.run(report_path, 1, paths=("synthesis", "chat"), interval_seconds=12)
    assert calls == (["synthesis"] if fails else ["synthesis", "chat"])
    assert report["ok"] is (not fails)
    assert report["unattempted_paths"] == (["chat"] if fails else [])
    assert json.loads(report_path.read_text()) == report
    if fails:
        sleep.assert_not_awaited()
    else:
        sleep.assert_awaited_once_with(12)

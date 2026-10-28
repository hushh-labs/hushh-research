"""The startup warmup pays One's first-turn setup so no chat turn does.

Measured on production 2026-09-27: each worker's first chat turn spent 3.6-41 s
before its first model call against 94 ms warm, because ADK imports provider
SDKs (about 1,800 modules) while building the first request, on the event loop.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path

import pytest

from hushh_mcp.one_adk import turn_warmup

_ROOT = Path(__file__).resolve().parents[1]

# A fresh interpreter, so modules other tests imported cannot hide the cost.
# It runs one real Agent Chat bridge turn (TimedADKAgent, frontend tools, stub
# model) and prints how many modules that turn imported before completing.
_CHILD = r"""
import asyncio, sys
from ag_ui.core import RunAgentInput, Tool, UserMessage
from google.adk.apps import App, ResumabilityConfig
from google.adk.sessions import InMemorySessionService
from hushh_mcp.one_adk import turn_warmup
from hushh_mcp.one_adk.agent_tree import _SPECIALIST_MODEL, build_one_text_agent
from hushh_mcp.one_adk.agui_turn_timing import HEAD_ONE, TimedADKAgent

if sys.argv[1] == "warm":
    assert turn_warmup.warm_one_turn_path() is True
agent = TimedADKAgent.from_app(
    App(
        name="one_probe",
        root_agent=build_one_text_agent(
            model=turn_warmup._WarmupLlm(model=_SPECIALIST_MODEL),
            allow_workspace_tools=True,
            include_thought_summaries=True,
        ),
        resumability_config=ResumabilityConfig(is_resumable=True),
    ),
    head=HEAD_ONE,
    user_id_extractor=lambda _input: "probe-owner",
    session_service=InMemorySessionService(),
    use_in_memory_services=True,
    use_thread_id_as_session_id=True,
)
run = RunAgentInput(
    thread_id="probe-thread", run_id="probe-run", state={}, context=[], forwarded_props={},
    messages=[UserMessage(id="m-1", role="user", content="hello")],
    tools=[Tool(name="hussh_action_probe", description="probe",
                parameters={"type": "object", "properties": {}})],
)

async def turn():
    return [str(event.type) async for event in agent.run(run)]

before = set(sys.modules)
events = asyncio.run(turn())
assert events[-1].endswith("RUN_FINISHED"), events
print(len(set(sys.modules) - before))
"""


def _modules_imported_by_first_turn(mode: str) -> int:
    env = {
        **os.environ,
        "TESTING": "true",
        "APP_SIGNING_KEY": "test_secret_key_for_pytest_only_32chars_min",
        "VAULT_DATA_KEY": "0" * 64,
        "PYTHONPATH": str(_ROOT),
    }
    result = subprocess.run(  # noqa: S603 - fixed argv: this interpreter and a literal script
        [sys.executable, "-W", "ignore", "-c", _CHILD, mode],
        cwd=_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=240,
        check=False,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    return int(result.stdout.strip().splitlines()[-1])


def test_warmed_process_first_turn_imports_nothing_before_answering():
    # Negative control: without the warmup the same first turn loads the lazy
    # provider modules on the request path, which is the production stall.
    assert _modules_imported_by_first_turn("cold") > 100
    assert _modules_imported_by_first_turn("warm") == 0


def test_raw_chat_keeps_the_non_client_roster():
    from ag_ui_adk import AGUIToolset

    from hushh_mcp.one_adk.agent_tree import _SPECIALIST_MODEL, build_one_text_agent

    model = turn_warmup._WarmupLlm(model=_SPECIALIST_MODEL)
    interactive = build_one_text_agent(model=model, allow_workspace_tools=True)
    raw = build_one_text_agent(
        model=model, allow_workspace_tools=True, include_client_receipt_tools=False
    )

    def identity(tool):
        return (
            type(tool).__module__,
            type(tool).__qualname__,
            getattr(tool, "name", None) or getattr(tool, "__name__", None),
        )

    assert sum(isinstance(tool, AGUIToolset) for tool in interactive.tools) == 1
    assert not any(isinstance(tool, AGUIToolset) for tool in raw.tools)
    assert [identity(tool) for tool in raw.tools] == [
        identity(tool) for tool in interactive.tools if not isinstance(tool, AGUIToolset)
    ]


def test_warmup_reaches_the_model_without_opening_any_connection(monkeypatch, caplog):
    """The warmup runs on every worker at startup: no database, provider or peer."""
    import socket

    opened: list[object] = []

    def no_connection(_sock, address):
        opened.append(address)
        raise AssertionError("the warmup must not open a connection")

    monkeypatch.setattr(socket.socket, "connect", no_connection)
    monkeypatch.setattr(socket.socket, "connect_ex", no_connection)
    marked: list[bool] = []
    monkeypatch.setattr(
        "hushh_mcp.one_adk.agui_turn_timing.mark_turn_path_warmed", lambda: marked.append(True)
    )

    assert turn_warmup.warm_one_turn_path() is True
    assert marked == [True]
    assert opened == []
    assert not any(
        record.levelno >= logging.ERROR
        and "AGUIToolset"
        in (record.getMessage() + (str(record.exc_info[1]) if record.exc_info else ""))
        for record in caplog.records
    )


@pytest.mark.asyncio
async def test_root_qualification_keeps_the_real_non_client_tool_roster(monkeypatch, caplog):
    from hushh_mcp import managed_ai_config
    from hushh_mcp.one_adk import agent_tree
    from hushh_mcp.runtime_providers.managed_text import ManagedPrimaryTextModel
    from scripts.probe_one_text_root import _root_contract

    model = ManagedPrimaryTextModel(
        model="synthetic-deployment",
        endpoint="https://synthetic.openai.azure.com/openai/v1/",
        token_supplier=lambda: pytest.fail("qualification must not obtain a token"),
        policy_generation="synthetic-generation",
        processing_scope="one_text_chat",
        default_reasoning_effort="low",
        text_verbosity="low",
        allow_fallback=False,
    )
    monkeypatch.setattr(agent_tree, "_resolve_text_model", lambda *args, **kwargs: model)
    monkeypatch.setattr(
        managed_ai_config,
        "load_managed_runtime_policy",
        lambda: {
            "azure": {
                "one_text_root": {
                    "deployment": model.model,
                    "reasoning_effort": model.default_reasoning_effort,
                    "text_verbosity": model.text_verbosity,
                }
            }
        },
    )
    _, _, declarations = await _root_contract()
    assert "get_current_time" in {item.name for item in declarations}
    assert len(declarations) >= 60
    assert not any(
        record.levelno >= logging.ERROR and "AGUIToolset" in record.getMessage()
        for record in caplog.records
    )


@pytest.mark.asyncio
async def test_failed_warmup_is_logged_and_never_raises(monkeypatch, caplog):
    def broken() -> bool:
        raise RuntimeError("private detail that must not be logged")

    monkeypatch.setattr(turn_warmup, "warm_one_turn_path", broken)
    await turn_warmup.warm_one_turn_path_in_background()

    assert "startup.one_turn_path_warm_failed reason=RuntimeError" in caplog.text
    assert "private detail" not in caplog.text

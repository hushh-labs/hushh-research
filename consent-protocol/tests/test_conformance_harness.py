"""Offline proof of the ADK conformance record/replay harness.

What is proven here, with no model and no network:

* the harness module imports and exposes ``record``/``replay`` entry points;
* the layout resolver builds the paths ADK's conformance tooling expects;
* a hand-built recording (constructed from ``recordings_schema`` classes, not
  guessed YAML) replays green against a stub agent whose model REFUSES every
  call, so replay demonstrably never reaches the model;
* a mismatched tool call is reported as ``ReplayVerificationError`` with the
  verification text, even though ADK's plugin manager wraps it in RuntimeError;
* recording with a scripted offline model writes the full three-file layout, and
  that recording replays green with the refusing model;
* the CLI refuses to record without ``--fixture-ack``.
"""

from __future__ import annotations

import sys
from collections.abc import AsyncGenerator
from pathlib import Path

import pytest
import yaml
from google.adk.agents.llm_agent import LlmAgent
from google.adk.cli.conformance.test_case import TestSpec, UserMessage
from google.adk.cli.plugins.recordings_schema import (
    LlmRecording,
    Recording,
    Recordings,
    ToolRecording,
)
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.utils.yaml_utils import dump_pydantic_to_yaml
from google.genai import types

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts import conformance_specialist as harness  # noqa: E402

STUB_AGENT_NAME = "stub"
STUB_MODEL_NAME = "stub-model"
STUB_INSTRUCTION = "Echo."
USER_TEXT = "say hello"
# ADK's identity processor appends this line to every system instruction.
STUB_SYSTEM_INSTRUCTION = (
    f'{STUB_INSTRUCTION}\n\nYou are an agent. Your internal name is "{STUB_AGENT_NAME}".'
)


# ---------------------------------------------------------------------------
# Stub agent: one trivial tool, two model stand-ins.
# ---------------------------------------------------------------------------


def echo_word(word: str) -> dict:
    """Echo a word."""
    return {"echoed": word}


class RefusingLlm(BaseLlm):
    """A model that proves replay never reaches it."""

    calls: int = 0

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        self.calls += 1
        raise AssertionError("replay reached the model")
        yield  # pragma: no cover - makes this an async generator


class ScriptedLlm(BaseLlm):
    """A model that plays a fixed script; used only to produce a recording offline."""

    responses: list[LlmResponse] = []
    calls: int = 0

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        index = self.calls
        self.calls += 1
        yield self.responses[index]


def _stub_factory(model: BaseLlm) -> harness.AgentFactory:
    def factory() -> LlmAgent:
        return LlmAgent(
            name=STUB_AGENT_NAME,
            model=model,
            instruction=STUB_INSTRUCTION,
            tools=[echo_word],
        )

    return factory


def _function_call_response() -> LlmResponse:
    return LlmResponse(
        content=types.Content(
            role="model",
            parts=[
                types.Part(
                    function_call=types.FunctionCall(name="echo_word", args={"word": "hello"})
                )
            ],
        )
    )


def _text_response() -> LlmResponse:
    return LlmResponse(content=types.Content(role="model", parts=[types.Part(text="done")]))


# ---------------------------------------------------------------------------
# Hand-built recording from the schema classes.
# ---------------------------------------------------------------------------


def _llm_request(contents: list[types.Content]) -> LlmRequest:
    """The request the stub agent sends, in the shape ADK verifies.

    ADK's verifier drops ``live_connect_config``, ``config.labels`` and
    ``config.http_options`` and normalises schema titles, so those are omitted.
    """
    declaration = types.FunctionDeclaration(
        name="echo_word",
        description="Echo a word.",
        parameters_json_schema={
            "type": "object",
            "properties": {"word": {"type": "string"}},
            "required": ["word"],
        },
    )
    return LlmRequest(
        model=STUB_MODEL_NAME,
        contents=contents,
        config=types.GenerateContentConfig(
            system_instruction=STUB_SYSTEM_INSTRUCTION,
            tools=[types.Tool(function_declarations=[declaration])],
        ),
    )


def _hand_built_recordings(*, tool_word: str = "hello") -> Recordings:
    user = types.Content(role="user", parts=[types.Part(text=USER_TEXT)])
    call = types.Content(
        role="model",
        parts=[
            types.Part(function_call=types.FunctionCall(name="echo_word", args={"word": "hello"}))
        ],
    )
    response = types.Content(
        role="user",
        parts=[
            types.Part(
                function_response=types.FunctionResponse(
                    name="echo_word", response={"echoed": "hello"}
                )
            )
        ],
    )
    return Recordings(
        recordings=[
            Recording(
                user_message_index=0,
                agent_name=STUB_AGENT_NAME,
                llm_recording=LlmRecording(
                    llm_request=_llm_request([user]), llm_responses=[_function_call_response()]
                ),
            ),
            Recording(
                user_message_index=0,
                agent_name=STUB_AGENT_NAME,
                tool_recording=ToolRecording(
                    tool_call=types.FunctionCall(
                        id="call-1", name="echo_word", args={"word": tool_word}
                    ),
                    tool_response=types.FunctionResponse(
                        id="call-1", name="echo_word", response={"echoed": tool_word}
                    ),
                ),
            ),
            Recording(
                user_message_index=0,
                agent_name=STUB_AGENT_NAME,
                llm_recording=LlmRecording(
                    llm_request=_llm_request([user, call, response]),
                    llm_responses=[_text_response()],
                ),
            ),
        ]
    )


def _write_hand_built_case(
    root: Path, case_id: str, *, tool_word: str = "hello"
) -> harness.CaseLayout:
    layout = harness.resolve_case_layout(root, case_id)
    layout.case_dir.mkdir(parents=True)
    dump_pydantic_to_yaml(
        _hand_built_recordings(tool_word=tool_word), layout.recordings_file, sort_keys=False
    )
    spec = TestSpec(
        description="hand built", agent=STUB_AGENT_NAME, user_messages=[UserMessage(text=USER_TEXT)]
    )
    dump_pydantic_to_yaml(spec, layout.spec_file, sort_keys=False)
    return layout


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_module_exposes_record_and_replay_entry_points() -> None:
    assert callable(harness.record_case)
    assert callable(harness.replay_case)
    assert callable(harness.replay_case_async)
    parser = harness.build_parser()
    commands = parser._subparsers._group_actions[0].choices  # noqa: SLF001 - argparse has no public accessor
    assert set(commands) == {"record", "replay"}


def test_layout_resolver_builds_the_adk_layout(tmp_path: Path) -> None:
    layout = harness.resolve_case_layout(tmp_path, "greets")
    assert layout.case_dir == tmp_path / "greets"
    assert layout.spec_file == tmp_path / "greets" / "spec.yaml"
    assert layout.recordings_file == tmp_path / "greets" / "generated-recordings.yaml"
    assert layout.session_file == tmp_path / "greets" / "generated-session.yaml"


@pytest.mark.parametrize("bad_id", ["", "../escape", "a/b", ".hidden", "x" * 65])
def test_layout_resolver_refuses_unsafe_case_ids(tmp_path: Path, bad_id: str) -> None:
    with pytest.raises(ValueError):
        harness.resolve_case_layout(tmp_path, bad_id)


def test_parse_cases_accepts_list_and_mapping_forms() -> None:
    as_list = harness.parse_cases([{"id": "a", "user_message": "hi"}])
    as_mapping = harness.parse_cases(
        {"cases": [{"id": "a", "user_message": "hi", "state": {"k": 1}}]}
    )
    assert as_list[0].id == "a" and as_list[0].state == {}
    assert as_mapping[0].state == {"k": 1}
    with pytest.raises(ValueError, match="duplicate"):
        harness.parse_cases([{"id": "a", "user_message": "x"}, {"id": "a", "user_message": "y"}])


def test_hand_built_recording_replays_without_reaching_the_model(tmp_path: Path) -> None:
    layout = _write_hand_built_case(tmp_path, "hand")
    refusing = RefusingLlm(model=STUB_MODEL_NAME)

    result = harness.replay_case(_stub_factory(refusing), layout.case_dir)

    assert result.passed, result.error
    assert result.error is None
    assert refusing.calls == 0
    # user turn, model function call, tool response, and the final text
    assert result.event_count == 3
    assert result.session_compared is False  # hand-built case ships no generated-session.yaml


def test_mismatched_tool_call_reports_replay_verification_error(tmp_path: Path) -> None:
    layout = _write_hand_built_case(tmp_path, "drift", tool_word="other")
    refusing = RefusingLlm(model=STUB_MODEL_NAME)

    result = harness.replay_case(_stub_factory(refusing), layout.case_dir)

    assert result.passed is False
    assert result.error_type == "ReplayVerificationError"
    assert result.error is not None
    assert "Tool args mismatch" in result.error
    assert "recorded: {'word': 'other'}" in result.error
    assert "current: {'word': 'hello'}" in result.error
    assert refusing.calls == 0


def test_missing_recordings_is_a_config_failure_not_a_crash(tmp_path: Path) -> None:
    layout = harness.resolve_case_layout(tmp_path, "empty")
    layout.case_dir.mkdir(parents=True)

    result = harness.replay_case(_stub_factory(RefusingLlm(model=STUB_MODEL_NAME)), layout.case_dir)

    assert result.passed is False
    assert result.error_type == "ReplayConfigError"


def test_spec_without_user_messages_never_passes(tmp_path: Path) -> None:
    layout = _write_hand_built_case(tmp_path, "empty-turns")
    empty = TestSpec(agent=STUB_MODEL_NAME, description="no turns", user_messages=[])
    dump_pydantic_to_yaml(empty, layout.spec_file)
    refusing = RefusingLlm(model=STUB_MODEL_NAME)

    result = harness.replay_case(_stub_factory(refusing), layout.case_dir)

    assert result.passed is False
    assert result.error_type == "ReplayConfigError"
    assert "no user_messages" in (result.error or "")
    assert refusing.calls == 0


def test_replay_forwards_the_spec_state_delta(tmp_path: Path) -> None:
    layout = _write_hand_built_case(tmp_path, "state")
    spec = harness.load_test_case(layout.case_dir)
    spec.user_messages[0].state_delta = {"hussh:timezone": "Asia/Kolkata"}
    dump_pydantic_to_yaml(spec, layout.spec_file)
    seen: dict[str, object] = {}
    original = harness._run_turn

    async def _spy(runner, session_id, content, state_delta):  # type: ignore[no-untyped-def]
        seen.update(state_delta)
        return await original(runner, session_id, content, state_delta)

    harness._run_turn = _spy  # type: ignore[assignment]
    try:
        result = harness.replay_case(
            _stub_factory(RefusingLlm(model=STUB_MODEL_NAME)), layout.case_dir
        )
    finally:
        harness._run_turn = original  # type: ignore[assignment]

    assert result.passed, result.error
    assert seen["hussh:timezone"] == "Asia/Kolkata"
    assert harness.REPLAY_STATE_KEY in seen


async def test_record_with_scripted_model_writes_layout_and_replays_green(tmp_path: Path) -> None:
    scripted = ScriptedLlm(
        model=STUB_MODEL_NAME, responses=[_function_call_response(), _text_response()]
    )
    case = harness.CaseSpec(id="echo", user_message=USER_TEXT, description="scripted echo")

    layout = await harness.record_case(
        _stub_factory(scripted), case, tmp_path, agent_ref="tests.stub"
    )

    assert scripted.calls == 2
    assert {p.name for p in layout.case_dir.iterdir()} == {
        "spec.yaml",
        "generated-recordings.yaml",
        "generated-session.yaml",
    }
    spec = TestSpec.model_validate(yaml.safe_load(layout.spec_file.read_text(encoding="utf-8")))
    assert spec.agent == "tests.stub"
    assert spec.user_messages[0].text == USER_TEXT
    recordings = Recordings.model_validate(
        yaml.safe_load(layout.recordings_file.read_text(encoding="utf-8"))
    )
    kinds = ["llm" if recording.llm_recording else "tool" for recording in recordings.recordings]
    assert kinds == ["llm", "tool", "llm"]
    assert recordings.recordings[1].tool_recording.tool_response.response == {"echoed": "hello"}
    session_text = layout.session_file.read_text(encoding="utf-8")
    assert harness.RECORD_STATE_KEY not in session_text

    refusing = RefusingLlm(model=STUB_MODEL_NAME)
    result = await harness.replay_case_async(_stub_factory(refusing), layout.case_dir)

    assert result.passed, result.error
    assert result.session_compared is True
    assert refusing.calls == 0


def test_cli_refuses_to_record_without_fixture_ack(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    cases_file = tmp_path / "cases.yaml"
    cases_file.write_text("- id: a\n  user_message: hi\n", encoding="utf-8")

    exit_code = harness.main(
        [
            "record",
            "--agent",
            "tests.nope.factory",
            "--cases",
            str(cases_file),
            "--dir",
            str(tmp_path / "rec"),
        ]
    )

    assert exit_code == 2
    assert "fixture" in capsys.readouterr().err
    assert not (tmp_path / "rec").exists()


def test_cli_replay_exits_nonzero_on_any_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_hand_built_case(tmp_path, "good")
    _write_hand_built_case(tmp_path, "bad", tool_word="other")
    cases_file = tmp_path / "cases.yaml"
    cases_file.write_text(
        "- id: good\n  user_message: say hello\n- id: bad\n  user_message: say hello\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        harness,
        "load_agent_factory",
        lambda _dotted: _stub_factory(RefusingLlm(model=STUB_MODEL_NAME)),
    )

    exit_code = harness.main(
        ["replay", "--agent", "ignored", "--cases", str(cases_file), "--dir", str(tmp_path)]
    )

    assert exit_code == 1

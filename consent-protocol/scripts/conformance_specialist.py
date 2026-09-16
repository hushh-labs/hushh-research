#!/usr/bin/env python3
"""Record and replay ADK conformance cases for the private agent's specialist agents.

Usage:
    PYTHONPATH=. uv run python scripts/conformance_specialist.py record \\
        --agent hushh_mcp.one_adk.agent_tree.build_one_text_agent \\
        --cases tests/conformance/one_text/cases.yaml \\
        --dir tests/conformance/one_text \\
        --fixture-ack

    PYTHONPATH=. uv run python scripts/conformance_specialist.py replay \\
        --agent hushh_mcp.one_adk.agent_tree.build_one_text_agent \\
        --cases tests/conformance/one_text/cases.yaml \\
        --dir tests/conformance/one_text

Why this exists
---------------
A specialist agent's behaviour is a sequence of model requests, model responses,
tool calls and tool responses. ADK ships a RecordingsPlugin that captures that
sequence to YAML and a ReplayPlugin that feeds the recorded model responses back
while verifying, strictly, that every model request and every tool call matches
what was recorded. Once a recording exists, a replay is deterministic and never
reaches a model, so a change to an instruction, a tool signature or the roster
shows up as a verification error in CI rather than as a surprise in front of a
person.

Layout per case (the layout ADK's own `adk conformance` tooling expects):

    <dir>/<case_id>/spec.yaml                    human-authored spec (TestSpec)
    <dir>/<case_id>/generated-recordings.yaml    written by RecordingsPlugin
    <dir>/<case_id>/generated-session.yaml       final session, for event comparison

Recording rule
--------------
Recordings capture every model request verbatim, including whatever the tools
returned. A recording therefore holds exactly the records the agent saw. Record
only against fixture information; the CLI refuses to record without
``--fixture-ack``, and no real person's records may enter a committed recording.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import json
import re
import sys
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import yaml  # noqa: E402
from google.adk.agents.llm_agent import LlmAgent  # noqa: E402
from google.adk.agents.run_config import StreamingMode  # noqa: E402
from google.adk.apps.app import App  # noqa: E402
from google.adk.cli.conformance._conformance_test_google_llm import (  # noqa: E402
    ReplayVerificationError as _ModelReplayVerificationError,
)
from google.adk.cli.conformance._generated_file_utils import (  # noqa: E402
    load_recorded_session,
    load_test_case,
)
from google.adk.cli.conformance._replay_validators import (  # noqa: E402
    compare_events,
    compare_session,
)
from google.adk.cli.conformance.test_case import TestSpec, UserMessage  # noqa: E402
from google.adk.cli.plugins.recordings_plugin import RecordingsPlugin  # noqa: E402
from google.adk.cli.plugins.replay_plugin import (  # noqa: E402
    ReplayConfigError,
    ReplayPlugin,
    ReplayVerificationError,
)
from google.adk.events.event import Event  # noqa: E402
from google.adk.plugins.base_plugin import BasePlugin  # noqa: E402
from google.adk.runners import Runner  # noqa: E402
from google.adk.sessions.in_memory_session_service import InMemorySessionService  # noqa: E402
from google.adk.utils.yaml_utils import dump_pydantic_to_yaml  # noqa: E402
from google.genai import types as genai_types  # noqa: E402

# ---------------------------------------------------------------------------
# Contract constants (mirrors of what the ADK plugins read; keep verbatim).
# ---------------------------------------------------------------------------

RECORD_STATE_KEY = "_adk_recordings_config"
REPLAY_STATE_KEY = "_adk_replay_config"
STREAMING_MODE = "none"
SPEC_FILENAME = "spec.yaml"
RECORDINGS_FILENAME = "generated-recordings.yaml"
SESSION_FILENAME = "generated-session.yaml"
FIXTURE_USER_ID = "conformance_fixture_user"

# Verification errors come from two ADK modules: the plugin (tool calls) and the
# replay model (LLM requests). Both mean "the agent diverged from the recording".
VERIFICATION_ERRORS: tuple[type[Exception], ...] = (
    ReplayVerificationError,
    _ModelReplayVerificationError,
)

_CASE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")

AgentFactory = Callable[[], LlmAgent]


# ---------------------------------------------------------------------------
# Cases and layout
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CaseSpec:
    """One conformance case: a single user turn against a fresh session."""

    id: str
    user_message: str
    state: dict[str, Any] = field(default_factory=dict)
    description: str = ""


@dataclass(frozen=True)
class CaseLayout:
    """Paths for one case, in the layout ADK's conformance tooling expects."""

    case_dir: Path
    spec_file: Path
    recordings_file: Path
    session_file: Path


@dataclass(frozen=True)
class ReplayResult:
    """Outcome of replaying one case."""

    case_id: str
    passed: bool
    error: str | None = None
    error_type: str | None = None
    event_count: int = 0
    session_compared: bool = False


def validate_case_id(case_id: str) -> str:
    """Case ids become directory names; keep them flat and path-safe."""
    if not _CASE_ID_PATTERN.match(case_id):
        raise ValueError(
            f"case id {case_id!r} must match {_CASE_ID_PATTERN.pattern} (it names a directory)"
        )
    return case_id


def resolve_case_layout(root: Path, case_id: str) -> CaseLayout:
    """Resolve the on-disk layout for one case under the recordings root."""
    case_dir = Path(root) / validate_case_id(case_id)
    return CaseLayout(
        case_dir=case_dir,
        spec_file=case_dir / SPEC_FILENAME,
        recordings_file=case_dir / RECORDINGS_FILENAME,
        session_file=case_dir / SESSION_FILENAME,
    )


def _parse_case(raw: Any) -> CaseSpec:
    if not isinstance(raw, dict):
        raise ValueError(f"each case must be a mapping, got {type(raw).__name__}")
    case_id = raw.get("id")
    user_message = raw.get("user_message")
    if not isinstance(case_id, str) or not isinstance(user_message, str):
        raise ValueError("each case needs string fields 'id' and 'user_message'")
    state = raw.get("state") or {}
    if not isinstance(state, dict):
        raise ValueError(f"case {case_id!r}: 'state' must be a mapping")
    description = raw.get("description") or ""
    if not isinstance(description, str):
        raise ValueError(f"case {case_id!r}: 'description' must be a string")
    return CaseSpec(
        id=validate_case_id(case_id),
        user_message=user_message,
        state=dict(state),
        description=description,
    )


def parse_cases(document: Any) -> list[CaseSpec]:
    """Parse a cases document: a list of cases or a mapping with a 'cases' list."""
    raw_cases = document.get("cases") if isinstance(document, dict) else document
    if not isinstance(raw_cases, list) or not raw_cases:
        raise ValueError("cases document must be a non-empty list (or {'cases': [...]})")
    cases = [_parse_case(raw) for raw in raw_cases]
    seen: set[str] = set()
    for case in cases:
        if case.id in seen:
            raise ValueError(f"duplicate case id {case.id!r}")
        seen.add(case.id)
    return cases


def load_cases(path: Path) -> list[CaseSpec]:
    """Load cases from a YAML or JSON file."""
    text = Path(path).read_text(encoding="utf-8")
    document = json.loads(text) if path.suffix.lower() == ".json" else yaml.safe_load(text)
    return parse_cases(document)


def load_agent_factory(dotted_path: str) -> AgentFactory:
    """Import ``package.module.callable`` and return the callable."""
    module_name, _, attribute = dotted_path.rpartition(".")
    if not module_name or not attribute:
        raise ValueError(f"--agent must be a dotted path 'module.callable', got {dotted_path!r}")
    module = importlib.import_module(module_name)
    factory = getattr(module, attribute, None)
    if not callable(factory):
        raise ValueError(f"{dotted_path!r} is not callable")
    return factory


def _build_agent(agent_factory: AgentFactory) -> LlmAgent:
    agent = agent_factory()
    if not isinstance(agent, LlmAgent):
        raise TypeError(f"agent factory returned {type(agent).__name__}, expected LlmAgent")
    return agent


# ---------------------------------------------------------------------------
# Runner plumbing
# ---------------------------------------------------------------------------


def _build_runner(agent: LlmAgent, plugin: BasePlugin) -> tuple[Runner, InMemorySessionService]:
    """A fresh in-memory runner with exactly one conformance plugin attached."""
    session_service = InMemorySessionService()
    app = App(name=agent.name, root_agent=agent, plugins=[plugin])
    runner = Runner(app=app, session_service=session_service)
    return runner, session_service


def _user_content(text: str) -> genai_types.Content:
    return genai_types.UserContent(parts=[genai_types.Part(text=text)])


def _turn_state_delta(
    state_key: str, layout: CaseLayout, user_message_index: int
) -> dict[str, Any]:
    return {
        state_key: {
            "dir": str(layout.case_dir),
            "user_message_index": user_message_index,
            "streaming_mode": STREAMING_MODE,
        }
    }


async def _run_turn(
    runner: Runner,
    session_id: str,
    content: genai_types.Content,
    state_delta: dict[str, Any],
) -> list[Event]:
    events: list[Event] = []
    async for event in runner.run_async(
        user_id=FIXTURE_USER_ID,
        session_id=session_id,
        new_message=content,
        state_delta=state_delta,
    ):
        events.append(event)
    return events


def _spec_from_case(case: CaseSpec, agent_ref: str) -> TestSpec:
    return TestSpec(
        description=case.description or f"conformance case {case.id}",
        agent=agent_ref,
        initial_state=dict(case.state),
        user_messages=[UserMessage(text=case.user_message)],
    )


def _spec_user_content(message: UserMessage, index: int) -> genai_types.Content:
    if message.content is not None:
        return message.content
    if message.text is not None:
        return _user_content(message.text)
    raise ValueError(f"spec user message {index} has neither text nor content")


# ---------------------------------------------------------------------------
# Record
# ---------------------------------------------------------------------------


async def record_case(
    agent_factory: AgentFactory,
    case: CaseSpec,
    root: Path,
    *,
    agent_ref: str | None = None,
) -> CaseLayout:
    """Run one case against a live agent and persist spec, recordings and session.

    Existing generated files for the case are removed first so a re-record never
    appends to a stale recording (RecordingsPlugin loads and extends an existing
    file when it finds one).
    """
    layout = resolve_case_layout(root, case.id)
    layout.case_dir.mkdir(parents=True, exist_ok=True)
    layout.recordings_file.unlink(missing_ok=True)
    layout.session_file.unlink(missing_ok=True)

    agent = _build_agent(agent_factory)
    runner, session_service = _build_runner(agent, RecordingsPlugin())
    session = await session_service.create_session(
        app_name=runner.app_name, user_id=FIXTURE_USER_ID, state=dict(case.state)
    )
    await _run_turn(
        runner,
        session.id,
        _user_content(case.user_message),
        _turn_state_delta(RECORD_STATE_KEY, layout, 0),
    )
    final_session = await session_service.get_session(
        app_name=runner.app_name, user_id=FIXTURE_USER_ID, session_id=session.id
    )
    if final_session is None:
        raise RuntimeError(f"case {case.id}: session vanished after the recorded turn")

    dump_pydantic_to_yaml(
        _spec_from_case(case, agent_ref or agent.name), layout.spec_file, sort_keys=False
    )
    # Mirror ADK's cli_record: strip the record switch from the persisted session.
    dump_pydantic_to_yaml(
        final_session,
        layout.session_file,
        sort_keys=False,
        exclude={
            "state": {RECORD_STATE_KEY: True},
            "events": {"__all__": {"actions": {"state_delta": {RECORD_STATE_KEY: True}}}},
        },
    )
    if not layout.recordings_file.exists():
        raise RuntimeError(
            f"case {case.id}: RecordingsPlugin wrote no {RECORDINGS_FILENAME}; "
            "the turn produced no completed model or tool exchange"
        )
    return layout


# ---------------------------------------------------------------------------
# Replay
# ---------------------------------------------------------------------------


def classify_replay_error(error: BaseException) -> BaseException:
    """Return the ADK replay error behind a wrapped exception, else the exception itself.

    ADK's plugin manager re-raises a failing callback as ``RuntimeError(...) from e``
    and the node runner wraps once more, so the verification error that names the
    divergence sits in the cause chain rather than at the top.
    """
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        if isinstance(current, (*VERIFICATION_ERRORS, ReplayConfigError)):
            return current
        seen.add(id(current))
        current = current.__cause__ or current.__context__
    return error


def _failed(case_id: str, error: BaseException, *, event_count: int = 0) -> ReplayResult:
    root = classify_replay_error(error)
    return ReplayResult(
        case_id=case_id,
        passed=False,
        error=str(root),
        error_type=type(root).__name__,
        event_count=event_count,
    )


async def _compare_session(
    session_service: InMemorySessionService,
    runner: Runner,
    session_id: str,
    layout: CaseLayout,
) -> tuple[bool, str | None]:
    """Compare the replayed session with the recorded one when a recording exists."""
    recorded = load_recorded_session(layout.case_dir, StreamingMode.NONE)
    if recorded is None:
        return False, None
    actual = await session_service.get_session(
        app_name=runner.app_name, user_id=FIXTURE_USER_ID, session_id=session_id
    )
    if actual is None:
        return True, "replayed session vanished before comparison"
    events_result = compare_events(actual.events, recorded.events)
    session_result = compare_session(actual, recorded)
    messages = [
        f"Event mismatch: {events_result.error_message}" if not events_result.success else None,
        f"Session mismatch: {session_result.error_message}" if not session_result.success else None,
    ]
    problems = [message for message in messages if message]
    return True, ("\n\n".join(problems) if problems else None)


async def replay_case_async(agent_factory: AgentFactory, case_dir: Path) -> ReplayResult:
    """Replay one recorded case; never reaches a model.

    The result carries the ADK verification text on failure. Every exception is
    folded into the result so a run over many cases reports all of them.
    """
    case_dir = Path(case_dir)
    layout = resolve_case_layout(case_dir.parent, case_dir.name)
    case_id = layout.case_dir.name
    if not layout.recordings_file.exists():
        return _failed(
            case_id, ReplayConfigError(f"Recordings file not found: {layout.recordings_file}")
        )
    if not layout.spec_file.exists():
        return _failed(case_id, ReplayConfigError(f"Spec file not found: {layout.spec_file}"))

    try:
        spec = load_test_case(layout.case_dir)
        agent = _build_agent(agent_factory)
        runner, session_service = _build_runner(agent, ReplayPlugin())
        session = await session_service.create_session(
            app_name=runner.app_name, user_id=FIXTURE_USER_ID, state=dict(spec.initial_state)
        )
    except Exception as exc:  # noqa: BLE001 - setup failures are reported, not raised
        return _failed(case_id, exc)

    if not spec.user_messages:
        # A spec with no turns would replay nothing and report a pass; refuse it
        # so a truncated or half-written case can never be a green result.
        return ReplayResult(
            case_id=case_id,
            passed=False,
            error="spec.yaml declares no user_messages; nothing to replay",
            error_type="ReplayConfigError",
        )

    event_count = 0
    try:
        for index, message in enumerate(spec.user_messages):
            events = await _run_turn(
                runner,
                session.id,
                _spec_user_content(message, index),
                {
                    # The spec's own per-turn state changes come first so the replay
                    # config key always wins, exactly as ADK's cli_test forwards them.
                    **dict(message.state_delta or {}),
                    **_turn_state_delta(REPLAY_STATE_KEY, layout, index),
                },
            )
            event_count += len(events)
    except Exception as exc:  # noqa: BLE001 - verification, config and tool crashes all fail the case
        return _failed(case_id, exc, event_count=event_count)

    session_compared, mismatch = await _compare_session(session_service, runner, session.id, layout)
    if mismatch:
        return ReplayResult(
            case_id=case_id,
            passed=False,
            error=mismatch,
            error_type="SessionMismatch",
            event_count=event_count,
            session_compared=session_compared,
        )
    return ReplayResult(
        case_id=case_id,
        passed=True,
        event_count=event_count,
        session_compared=session_compared,
    )


def replay_case(agent_factory: AgentFactory, case_dir: Path) -> ReplayResult:
    """Synchronous wrapper around :func:`replay_case_async` for tests and the CLI."""
    return asyncio.run(replay_case_async(agent_factory, case_dir))


async def replay_cases_async(
    agent_factory: AgentFactory, root: Path, case_ids: Iterable[str]
) -> list[ReplayResult]:
    results: list[ReplayResult] = []
    for case_id in case_ids:
        results.append(
            await replay_case_async(agent_factory, resolve_case_layout(root, case_id).case_dir)
        )
    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _add_common_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--agent",
        required=True,
        help="dotted path to a zero-argument factory returning an LlmAgent",
    )
    parser.add_argument(
        "--cases",
        required=True,
        type=Path,
        help="YAML or JSON list of {id, user_message, state?, description?}",
    )
    parser.add_argument(
        "--dir",
        required=True,
        type=Path,
        help="recordings root; each case lives at <dir>/<case_id>/",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="conformance_specialist",
        description="Record and replay ADK conformance cases for specialist agents.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    record = subparsers.add_parser("record", help="run cases live and write recordings")
    _add_common_arguments(record)
    record.add_argument(
        "--fixture-ack",
        action="store_true",
        help="affirm that every case runs against fixture information only",
    )

    replay = subparsers.add_parser("replay", help="replay recorded cases without a model")
    _add_common_arguments(replay)
    return parser


def _print_result(result: ReplayResult) -> None:
    status = "PASS" if result.passed else "FAIL"
    detail = f" ({result.event_count} events" + (
        ", session compared)" if result.session_compared else ")"
    )
    print(f"[{status}] {result.case_id}{detail}")
    if result.error:
        print(f"  {result.error_type}: {result.error}")


def run_record(args: argparse.Namespace) -> int:
    if not args.fixture_ack:
        print(
            "refusing to record: recordings capture every record the agent saw. "
            "Pass --fixture-ack only when every case runs against fixture information.",
            file=sys.stderr,
        )
        return 2
    factory = load_agent_factory(args.agent)
    cases = load_cases(args.cases)
    for case in cases:
        layout = asyncio.run(record_case(factory, case, args.dir, agent_ref=args.agent))
        print(f"[RECORDED] {case.id} -> {layout.case_dir}")
    return 0


def run_replay(args: argparse.Namespace) -> int:
    factory = load_agent_factory(args.agent)
    cases = load_cases(args.cases)
    results = asyncio.run(replay_cases_async(factory, args.dir, (case.id for case in cases)))
    for result in results:
        _print_result(result)
    failed = [result for result in results if not result.passed]
    print(f"{len(results) - len(failed)}/{len(results)} cases passed")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "record":
        return run_record(args)
    if args.command == "replay":
        return run_replay(args)
    raise AssertionError(f"unknown command {args.command!r}")


if __name__ == "__main__":
    sys.exit(main())

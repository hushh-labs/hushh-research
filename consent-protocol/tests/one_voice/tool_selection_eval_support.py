"""Shared machinery for held-out tool-selection evaluations of the Live head.

A fixture lists cases (screen, prior user turns, the utterance, which tools are
expected first and which are forbidden). The probe drives the real model over
the production instruction and declarations; every function call is answered
by a *responder* the calling test supplies, so nothing real executes. Reports
are written as JSON next to the location-updates report.

Kept generic on purpose: the location-updates evaluation owns its own
domain-specific gates in ``test_live_tool_selection_eval.py``; this module
holds what any domain evaluation needs.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import subprocess
import tempfile
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from hushh_mcp.one_voice import instruction as instruction_module
from hushh_mcp.one_voice.tools import registry
from hushh_mcp.one_voice.tools.base import ToolPolicy

TESTS_DIR = Path(__file__).resolve().parent
CONSENT_PROTOCOL_ROOT = TESTS_DIR.parents[1]
AGENT_MANIFEST_PATH = CONSENT_PROTOCOL_ROOT / "hushh_mcp" / "agents" / "one" / "agent.yaml"

LIVE_EVAL_ENV = "ONE_VOICE_LIVE_TOOL_EVAL"
LIVE_EVAL_MODE_ENV = "ONE_VOICE_LIVE_TOOL_EVAL_MODE"
# The Vertex project the evaluation bills to. ``tests/conftest.py`` scrubs
# GENAI_GOOGLE_CLOUD_PROJECT for every test, so the override would otherwise
# fall back to the .env project silently; this key survives the scrub and is
# applied inside the test body. (hushh-pda-uat is billing-denied for Vertex;
# the UAT lane's GenAI project is hushh-vertex-personal54.)
LIVE_EVAL_PROJECT_ENV = "ONE_VOICE_LIVE_EVAL_PROJECT"
LIVE_MODEL_ENV = "VERTEX_LIVE_MODEL_ID"
LIVE_LOCATION_ENV = "VERTEX_LIVE_LOCATION"
DEFAULT_LIVE_MODEL_ID = "gemini-live-2.5-flash-native-audio"
DEFAULT_LIVE_LOCATION = "us-central1"

TURN_TIMEOUT_S = 30.0
CALL_GAP_S = 1.0
QUOTA_RETRY_ATTEMPTS = 3
_TRANSIENT_MARKERS = ("RESOURCE_EXHAUSTED", "429", "DEADLINE_EXCEEDED", "504", "503", "UNAVAILABLE")

# Session reads the model may make before its real first call.
SESSION_READS = frozenset({"get_pending_action"})

CASE_KEYS = frozenset(
    {"id", "family", "screen", "history", "utterance", "expected_tools", "forbidden_tools", "note"}
)


@dataclass(frozen=True)
class Case:
    id: str
    family: str
    screen: str
    history: tuple[str, ...]
    utterance: str
    expected_tools: tuple[str, ...]
    forbidden_tools: tuple[str, ...]
    note: str


@dataclass
class Observation:
    case: Case
    first_tool: str | None
    first_args: dict[str, Any] | None
    # Every (tool, args, result_public) on the final turn, in order.
    calls: list[tuple[str, dict[str, Any], dict[str, Any]]]
    latency_ms: float
    error: str | None = None

    @property
    def all_tools(self) -> list[str]:
        return [name for name, _, _ in self.calls]

    @property
    def forbidden_hit(self) -> bool:
        return any(name in self.case.forbidden_tools for name in self.all_tools)

    @property
    def first_real_tool(self) -> str | None:
        """The first tool that is not a session bookkeeping read: checking for
        a pending card before acting is never the wrong first move."""
        for name in self.all_tools:
            if name not in SESSION_READS:
                return name
        return None


# A responder answers one function call. ``(tool, args) -> result_public``.
Responder = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]
# ``(case) -> responder`` so every case starts from a clean fake world.
ResponderFactory = Callable[[Case], Responder]
# ``(case) -> (first tool, first args, calls)``
ProbeFn = Callable[
    [Case],
    tuple[str | None, dict[str, Any] | None, list[tuple[str, dict[str, Any], dict[str, Any]]]],
]


def load_cases(
    path: Path, *, schema_version: str, families: frozenset[str], screens: frozenset[str]
) -> list[Case]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload.get("schema_version") == schema_version, payload.get("schema_version")
    raw_cases = payload.get("cases")
    assert isinstance(raw_cases, list) and raw_cases, "fixture has no cases"
    cases: list[Case] = []
    for index, raw in enumerate(raw_cases):
        assert isinstance(raw, dict), f"case #{index} is not an object"
        assert set(raw) == CASE_KEYS, f"case #{index} has unexpected keys: {sorted(raw)}"
        case_id = raw["id"]
        assert isinstance(case_id, str) and case_id.strip(), f"case #{index} has no id"
        assert raw["family"] in families, (case_id, raw["family"])
        assert raw["screen"] in screens, (case_id, raw["screen"])
        assert isinstance(raw["history"], list) and all(
            isinstance(item, str) and item.strip() for item in raw["history"]
        ), (case_id, "history")
        assert isinstance(raw["utterance"], str) and raw["utterance"].strip(), (
            case_id,
            "utterance",
        )
        for key in ("expected_tools", "forbidden_tools"):
            assert isinstance(raw[key], list) and all(
                isinstance(item, str) and item.strip() for item in raw[key]
            ), (case_id, key)
        assert isinstance(raw["note"], str), (case_id, "note")
        cases.append(
            Case(
                id=case_id,
                family=raw["family"],
                screen=raw["screen"],
                history=tuple(raw["history"]),
                utterance=raw["utterance"],
                expected_tools=tuple(raw["expected_tools"]),
                forbidden_tools=tuple(raw["forbidden_tools"]),
                note=raw["note"],
            )
        )
    return cases


def production_corpus() -> str:
    """Every production sentence the model sees or that shapes what it sees."""
    descriptions = "\n".join(str(item.get("description") or "") for item in registry.declarations())
    instruction_source = inspect.getsource(instruction_module)
    manifest = AGENT_MANIFEST_PATH.read_text(encoding="utf-8")
    return "\n".join((descriptions, instruction_source, manifest)).lower()


def mutation_tools() -> frozenset[str]:
    """Tools whose call would change state; ``open_screen`` only navigates."""
    names = {
        tool.name
        for tool in registry.all_tools()
        if tool.policy is not ToolPolicy.read and tool.name != "open_screen"
    }
    names.add("confirm_pending_action")
    return frozenset(names)


def read_tools() -> frozenset[str]:
    names = {tool.name for tool in registry.all_tools() if tool.policy is ToolPolicy.read}
    names.add("get_pending_action")
    return frozenset(names)


def is_transient(exc: BaseException) -> bool:
    message = str(exc).upper()
    return any(marker in message for marker in _TRANSIENT_MARKERS)


def git_sha() -> str:
    try:
        completed = subprocess.run(  # noqa: S603
            ["git", "rev-parse", "HEAD"],
            cwd=CONSENT_PROTOCOL_ROOT,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    sha = completed.stdout.strip()
    return sha if completed.returncode == 0 and sha else "unknown"


def report_path(name: str) -> Path:
    """``consent-protocol/tmp`` when git ignores it, else the system temp dir."""
    candidate_dir = CONSENT_PROTOCOL_ROOT / "tmp"
    candidate_dir.mkdir(parents=True, exist_ok=True)
    candidate = candidate_dir / name
    try:
        ignored = (
            subprocess.run(  # noqa: S603
                ["git", "check-ignore", "-q", str(candidate)],
                cwd=CONSENT_PROTOCOL_ROOT,
                capture_output=True,
                timeout=10,
                check=False,
            ).returncode
            == 0
        )
    except (OSError, subprocess.SubprocessError):
        ignored = False
    return candidate if ignored else Path(tempfile.gettempdir()) / name


def instruction_for(case: Case) -> str:
    from hushh_mcp.one_voice.instruction import build_instruction
    from hushh_mcp.one_voice.tools.session import OPENABLE_SCREENS

    return build_instruction(
        tool_declarations=registry.declarations(),
        screen_ids=list(OPENABLE_SCREENS),
        screen_id=case.screen,
        display_name=None,
    )


def make_live_probe(model_id: str, location: str, responders: ResponderFactory) -> ProbeFn:
    """PRIMARY mode: the actual Live head over the production connect path.

    History turns are answered with the same responder, so a follow-up turn
    sees the ids and statuses an earlier read really returned.
    """
    from hushh_mcp.one_voice.instruction import voice_name
    from hushh_mcp.one_voice.live_client import (
        GeminiLiveSession,
        build_live_config,
        translate_message,
    )
    from hushh_mcp.runtime_providers.factory import build_managed_live_client

    client = build_managed_live_client(model=model_id, location=location)
    declarations = registry.declarations()

    async def _drain_turn(
        raw_session: Any,
        session: GeminiLiveSession,
        respond: Responder,
        seen: list[tuple[str, dict[str, Any], dict[str, Any]]],
    ) -> None:
        deadline = time.monotonic() + TURN_TIMEOUT_S
        while True:
            answered = False
            async for message in raw_session.receive():
                for event in translate_message(message):
                    if event.kind != "tool_call":
                        continue
                    for call in event.function_calls:
                        args = dict(call.get("args") or {})
                        response = await respond(call["name"], args)
                        seen.append((call["name"], args, dict(response)))
                        await session.send_tool_response(
                            call_id=call.get("id"), name=call["name"], response=response
                        )
                        answered = True
                if time.monotonic() > deadline:
                    return
            if not answered or time.monotonic() > deadline:
                return

    async def _run(case: Case):
        respond = responders(case)
        config = build_live_config(
            system_instruction=instruction_for(case),
            tool_declarations=declarations,
            voice_name=voice_name(),
            resumption_handle=None,
        )
        async with client.aio.live.connect(model=model_id, config=config) as raw_session:
            session = GeminiLiveSession(raw_session)
            for text in case.history:
                await session.send_text(text)
                await asyncio.wait_for(
                    _drain_turn(raw_session, session, respond, []), timeout=TURN_TIMEOUT_S + 5
                )
            seen: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
            await session.send_text(case.utterance)
            await asyncio.wait_for(
                _drain_turn(raw_session, session, respond, seen), timeout=TURN_TIMEOUT_S + 5
            )
        if not seen:
            return None, None, []
        return seen[0][0], seen[0][1], seen

    def _probe(case: Case):
        return asyncio.run(_run(case))

    return _probe


def make_text_probe(model_id: str, responders: ResponderFactory) -> ProbeFn:
    """FALLBACK mode: declarations + instruction on a text model, not the Live
    head. History turns are replayed with their function calls answered by
    the responder so follow-ups still see real ids."""
    from google.genai import types

    from hushh_mcp.runtime_providers.factory import ManagedGeminiRuntimeBinding

    client = ManagedGeminiRuntimeBinding.from_environment().build_direct_client(
        location="global", http_options=types.HttpOptions(timeout=60_000)
    )
    tool = types.Tool(
        function_declarations=[
            types.FunctionDeclaration(
                name=item["name"],
                description=item.get("description"),
                parameters_json_schema=item.get("parameters_json_schema"),
            )
            for item in registry.declarations()
        ]
    )

    def _calls_in(response: Any) -> list[tuple[str, dict[str, Any]]]:
        candidates = getattr(response, "candidates", None) or []
        if not candidates:
            return []
        content = getattr(candidates[0], "content", None)
        out: list[tuple[str, dict[str, Any]]] = []
        for part in getattr(content, "parts", None) or []:
            call = getattr(part, "function_call", None)
            if call:
                out.append((str(call.name), dict(call.args or {})))
        return out

    async def _run(case: Case):
        respond = responders(case)
        config = types.GenerateContentConfig(
            system_instruction=instruction_for(case), tools=[tool], temperature=0
        )
        contents: list[Any] = []
        seen: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
        turns = [*case.history, case.utterance]
        for index, text in enumerate(turns):
            contents.append(types.Content(role="user", parts=[types.Part(text=text)]))
            final = index == len(turns) - 1
            for _ in range(4):  # a turn may chain a few calls before narrating
                response = client.models.generate_content(
                    model=model_id, contents=contents, config=config
                )
                calls = _calls_in(response)
                candidates = getattr(response, "candidates", None) or []
                if candidates and getattr(candidates[0], "content", None) is not None:
                    contents.append(candidates[0].content)
                if not calls:
                    break
                parts = []
                for name, args in calls:
                    result = await respond(name, args)
                    if final:
                        seen.append((name, args, dict(result)))
                    parts.append(types.Part.from_function_response(name=name, response=result))
                contents.append(types.Content(role="user", parts=parts))
        if not seen:
            return None, None, []
        return seen[0][0], seen[0][1], seen

    def _probe(case: Case):
        return asyncio.run(_run(case))

    return _probe


def observe(probe: ProbeFn, case: Case) -> Observation:
    last_error: BaseException | None = None
    for attempt in range(1, QUOTA_RETRY_ATTEMPTS + 1):
        started = time.monotonic()
        try:
            first_tool, first_args, calls = probe(case)
        except Exception as exc:  # noqa: BLE001 - a provider failure is a result
            last_error = exc
            if is_transient(exc) and attempt < QUOTA_RETRY_ATTEMPTS:
                time.sleep(min(CALL_GAP_S * (2 ** (attempt - 1)), 60.0))
                continue
            break
        return Observation(
            case=case,
            first_tool=first_tool,
            first_args=first_args,
            calls=calls,
            latency_ms=(time.monotonic() - started) * 1000,
        )
    return Observation(
        case=case,
        first_tool=None,
        first_args=None,
        calls=[],
        latency_ms=0.0,
        error=f"{type(last_error).__name__}: {last_error}",
    )


def resolve_mode() -> tuple[str, str, str, str]:
    """(mode, model_id, location, mode_label) from the environment."""
    import os

    project = (os.environ.get(LIVE_EVAL_PROJECT_ENV) or "").strip()
    if project:
        os.environ["GENAI_GOOGLE_CLOUD_PROJECT"] = project
    mode = (os.environ.get(LIVE_EVAL_MODE_ENV) or "live").strip().lower()
    if mode == "text":
        from hushh_mcp.constants import fleet_text_model_from_env

        return (
            "text",
            fleet_text_model_from_env(),
            "global",
            "text_fallback (declarations+instruction only, not the Live head)",
        )
    model_id = (os.environ.get(LIVE_MODEL_ENV) or "").strip() or DEFAULT_LIVE_MODEL_ID
    location = (os.environ.get(LIVE_LOCATION_ENV) or "").strip().lower() or DEFAULT_LIVE_LOCATION
    return (
        "live",
        model_id,
        location,
        "live_primary (actual Live head over build_managed_live_client)",
    )


@dataclass
class FamilyMetrics:
    n: int = 0
    expected_hits: int = 0
    forbidden_hits: int = 0
    unintended_mutation: int = 0
    unconfirmed_id_mutation: int = 0
    skipped_confirm: int = 0
    # A mutation called without its required id (the executor refused it and
    # the model has to read first): a wasted turn, not a wrong-target proposal.
    missing_argument_mutation: int = 0
    errors: int = 0
    misses: list[dict[str, Any]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "n": self.n,
            "expected_hits": self.expected_hits,
            "expected_hit_rate": (self.expected_hits / self.n) if self.n else None,
            "forbidden_hits": self.forbidden_hits,
            "unintended_mutation": self.unintended_mutation,
            "unconfirmed_id_mutation": self.unconfirmed_id_mutation,
            "skipped_confirm": self.skipped_confirm,
            "missing_argument_mutation": self.missing_argument_mutation,
            "errors": self.errors,
            "misses": self.misses,
        }


def write_report(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")

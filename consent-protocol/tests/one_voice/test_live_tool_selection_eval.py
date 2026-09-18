"""Held-out evaluation of which tool the Live head selects for this device's
Location switch (``resume_device_location_updates`` /
``pause_device_location_updates``) against confusable requests.

Two tests share one fixture, ``fixtures/location_updates_tool_selection.v1.json``:

* ``test_fixture_is_well_formed_and_held_out`` always runs. It proves the
  fixture's shape, that every named tool is really declared, that every device
  toggle case forbids the account-level ``turn_sharing_*`` tools, and that no
  fixture sentence appears verbatim in any production tool description, in
  ``instruction.py``, or in ``agents/one/agent.yaml``: the evaluation wording is
  held out, so a hit can only come from the model's own generalisation.

* ``test_live_model_selects_the_device_tool`` drives a real model. It is
  marked ``live_model`` and skipped unless ``ONE_VOICE_LIVE_TOOL_EVAL=1``.
  PRIMARY mode (default) opens a real Gemini Live session through the same
  ``build_managed_live_client`` + ``build_live_config`` path the relay uses,
  with the production instruction and declarations, sends each case's history
  and utterance as text turns, and answers every function call with an inert
  ``{"status": "location_updates_pending"}`` double so nothing executes.
  FALLBACK mode (``ONE_VOICE_LIVE_TOOL_EVAL_MODE=text``) sends the same
  instruction and declarations to a text model through ``build_direct_client``
  and ``generate_content`` at temperature 0; it measures declarations plus
  instruction only, not the Live head, and the report says so.

``google.genai`` and the runtime factory are imported inside the test functions
so ``--collect-only`` passes without provider credentials.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import subprocess
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from hushh_mcp.one_voice import instruction as instruction_module
from hushh_mcp.one_voice.tools import registry
from hushh_mcp.one_voice.tools.base import ToolPolicy

TESTS_DIR = Path(__file__).resolve().parent
CONSENT_PROTOCOL_ROOT = TESTS_DIR.parents[1]
FIXTURE_PATH = TESTS_DIR / "fixtures" / "location_updates_tool_selection.v1.json"
AGENT_MANIFEST_PATH = CONSENT_PROTOCOL_ROOT / "hushh_mcp" / "agents" / "one" / "agent.yaml"
REPORT_NAME = "one-voice-location-updates-eval-report.json"

SCHEMA_VERSION = "one.voice.location_updates_tool_selection.v1"
FAMILIES = frozenset({"enable", "disable", "no_mutation", "clarify", "account_sharing"})
SCREENS = frozenset({"one_home", "one_location"})
DEVICE_TOGGLE_FAMILIES = frozenset({"enable", "disable"})
NO_MUTATION_FAMILIES = frozenset({"no_mutation", "clarify"})
MIN_CASES = 100

RESUME_TOOL = "resume_device_location_updates"
PAUSE_TOOL = "pause_device_location_updates"
SHARING_TOOLS = frozenset({"turn_sharing_on", "turn_sharing_off"})
DEVICE_TOOLS = frozenset({RESUME_TOOL, PAUSE_TOOL})
EXPECTED_DEVICE_TOOL = {"enable": RESUME_TOOL, "disable": PAUSE_TOOL}
WRONG_STATE_TOOL = {"enable": PAUSE_TOOL, "disable": RESUME_TOOL}

LIVE_EVAL_ENV = "ONE_VOICE_LIVE_TOOL_EVAL"
LIVE_EVAL_MODE_ENV = "ONE_VOICE_LIVE_TOOL_EVAL_MODE"
LIVE_MODEL_ENV = "VERTEX_LIVE_MODEL_ID"
LIVE_LOCATION_ENV = "VERTEX_LIVE_LOCATION"
# The deploy-uat substitutions for the Live head (deploy-uat.yml, _VERTEX_LIVE_*).
DEFAULT_LIVE_MODEL_ID = "gemini-live-2.5-flash-native-audio"
DEFAULT_LIVE_LOCATION = "us-central1"

# The inert answer every function call gets during the evaluation: the same
# interim status the real handler returns, so the model's narration path is
# exercised while nothing on any device changes.
PENDING_TOOL_RESPONSE: dict[str, Any] = {"status": "location_updates_pending"}

TURN_TIMEOUT_S = 30.0
CALL_GAP_S = 1.0
QUOTA_RETRY_ATTEMPTS = 3
_TRANSIENT_MARKERS = ("RESOURCE_EXHAUSTED", "429", "DEADLINE_EXCEEDED", "504", "503", "UNAVAILABLE")

MIN_EXPECTED_HIT_RATE_DEVICE = 0.95


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
    all_tools: list[str]
    latency_ms: float
    error: str | None = None

    @property
    def expected_hit(self) -> bool:
        if self.error:
            return False
        if not self.case.expected_tools:
            return self.first_tool is None
        return self.first_tool in self.case.expected_tools

    @property
    def forbidden_hit(self) -> bool:
        return any(name in self.case.forbidden_tools for name in self.all_tools)

    @property
    def wrong_state(self) -> bool:
        wrong = WRONG_STATE_TOOL.get(self.case.family)
        return wrong is not None and wrong in self.all_tools

    @property
    def unnecessary_tool(self) -> bool:
        return not self.case.expected_tools and self.first_tool is not None

    def unintended_mutation(self, mutation_tools: frozenset[str]) -> bool:
        return self.case.family in NO_MUTATION_FAMILIES and any(
            name in mutation_tools for name in self.all_tools
        )

    @property
    def args_invalid(self) -> bool:
        return self.first_tool in DEVICE_TOOLS and bool(self.first_args)


# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------


def load_fixture() -> list[Case]:
    payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    assert payload.get("schema_version") == SCHEMA_VERSION, payload.get("schema_version")
    raw_cases = payload.get("cases")
    assert isinstance(raw_cases, list) and raw_cases, "fixture has no cases"
    cases: list[Case] = []
    for index, raw in enumerate(raw_cases):
        assert isinstance(raw, dict), f"case #{index} is not an object"
        assert set(raw) == {
            "id",
            "family",
            "screen",
            "history",
            "utterance",
            "expected_tools",
            "forbidden_tools",
            "note",
        }, f"case #{index} has unexpected keys: {sorted(raw)}"
        assert isinstance(raw["id"], str) and raw["id"].strip(), f"case #{index} has no id"
        case_id = raw["id"]
        assert raw["family"] in FAMILIES, (case_id, raw["family"])
        assert raw["screen"] in SCREENS, (case_id, raw["screen"])
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


def _production_corpus() -> str:
    """Every production sentence the model sees or that shapes what it sees."""
    descriptions = "\n".join(str(item.get("description") or "") for item in registry.declarations())
    instruction_source = inspect.getsource(instruction_module)
    manifest = AGENT_MANIFEST_PATH.read_text(encoding="utf-8")
    return "\n".join((descriptions, instruction_source, manifest)).lower()


def _mutation_tools() -> frozenset[str]:
    """Tools whose call would change state; ``open_screen`` only navigates."""
    names = {
        tool.name
        for tool in registry.all_tools()
        if tool.policy is not ToolPolicy.read and tool.name != "open_screen"
    }
    names.add("confirm_pending_action")
    return frozenset(names)


# ---------------------------------------------------------------------------
# Offline: the fixture itself
# ---------------------------------------------------------------------------


def test_fixture_is_well_formed_and_held_out():
    cases = load_fixture()
    assert len(cases) >= MIN_CASES, len(cases)

    ids = [case.id for case in cases]
    assert len(ids) == len(set(ids)), "duplicate case ids"
    utterances = [case.utterance.strip().lower() for case in cases]
    assert len(utterances) == len(set(utterances)), "duplicate utterances"

    families = {case.family for case in cases}
    assert families == FAMILIES, sorted(families)

    declared = {item["name"] for item in registry.declarations()}
    for case in cases:
        for name in (*case.expected_tools, *case.forbidden_tools):
            assert name in declared, (case.id, name)
        assert not set(case.expected_tools) & set(case.forbidden_tools), case.id

    for case in cases:
        if case.family in DEVICE_TOGGLE_FAMILIES:
            assert SHARING_TOOLS <= set(case.forbidden_tools), case.id
            assert case.expected_tools == (EXPECTED_DEVICE_TOOL[case.family],), case.id
            assert WRONG_STATE_TOOL[case.family] in case.forbidden_tools, case.id
        elif case.family in NO_MUTATION_FAMILIES:
            assert DEVICE_TOOLS <= set(case.forbidden_tools), case.id
            assert not set(case.expected_tools) & (DEVICE_TOOLS | SHARING_TOOLS), case.id
        else:  # account_sharing
            assert set(case.expected_tools) <= SHARING_TOOLS, case.id
            assert set(case.forbidden_tools) & DEVICE_TOOLS, case.id

    # Held out: no evaluation sentence is anywhere the model could have read it.
    corpus = _production_corpus()
    for case in cases:
        sentences = (case.utterance, *case.history)
        for sentence in sentences:
            assert sentence.strip().lower() not in corpus, (case.id, sentence)


# ---------------------------------------------------------------------------
# Live: the real model
# ---------------------------------------------------------------------------


def _is_transient(exc: BaseException) -> bool:
    message = str(exc).upper()
    return any(marker in message for marker in _TRANSIENT_MARKERS)


def _git_sha() -> str:
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


def _report_path() -> Path:
    """``consent-protocol/tmp`` when git ignores it, else the system temp dir."""
    candidate_dir = CONSENT_PROTOCOL_ROOT / "tmp"
    candidate_dir.mkdir(parents=True, exist_ok=True)
    candidate = candidate_dir / REPORT_NAME
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
    return candidate if ignored else Path(tempfile.gettempdir()) / REPORT_NAME


def _instruction_for(case: Case) -> str:
    from hushh_mcp.one_voice.instruction import build_instruction
    from hushh_mcp.one_voice.tools.session import OPENABLE_SCREENS

    return build_instruction(
        tool_declarations=registry.declarations(),
        screen_ids=list(OPENABLE_SCREENS),
        screen_id=case.screen,
        display_name=None,
    )


# (case) -> (first tool name, first args, every tool name in order)
ProbeFn = Callable[[Case], tuple[str | None, dict[str, Any] | None, list[str]]]


def _make_live_probe(model_id: str, location: str) -> ProbeFn:
    """PRIMARY mode: the actual Live head over the production connect path."""
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
        raw_session: Any, session: GeminiLiveSession, seen: list[tuple[str, dict[str, Any]]]
    ) -> None:
        """Read one model turn; answer any function call inertly and read the
        narration turn that follows it, so the next text turn starts clean."""
        deadline = time.monotonic() + TURN_TIMEOUT_S
        while True:
            answered = False
            async for message in raw_session.receive():
                for event in translate_message(message):
                    if event.kind != "tool_call":
                        continue
                    for call in event.function_calls:
                        seen.append((call["name"], dict(call.get("args") or {})))
                        await session.send_tool_response(
                            call_id=call.get("id"),
                            name=call["name"],
                            response=dict(PENDING_TOOL_RESPONSE),
                        )
                        answered = True
                if time.monotonic() > deadline:
                    return
            if not answered or time.monotonic() > deadline:
                return

    async def _run(case: Case) -> tuple[str | None, dict[str, Any] | None, list[str]]:
        config = build_live_config(
            system_instruction=_instruction_for(case),
            tool_declarations=declarations,
            voice_name=voice_name(),
            resumption_handle=None,
        )
        async with client.aio.live.connect(model=model_id, config=config) as raw_session:
            session = GeminiLiveSession(raw_session)
            for text in case.history:
                await session.send_text(text)
                await asyncio.wait_for(
                    _drain_turn(raw_session, session, []), timeout=TURN_TIMEOUT_S + 5
                )
            seen: list[tuple[str, dict[str, Any]]] = []
            await session.send_text(case.utterance)
            await asyncio.wait_for(
                _drain_turn(raw_session, session, seen), timeout=TURN_TIMEOUT_S + 5
            )
        if not seen:
            return None, None, []
        return seen[0][0], seen[0][1], [name for name, _ in seen]

    def _probe(case: Case) -> tuple[str | None, dict[str, Any] | None, list[str]]:
        return asyncio.run(_run(case))

    return _probe


def _make_text_probe(model_id: str) -> ProbeFn:
    """FALLBACK mode: declarations + instruction on a text model, not the Live head."""
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

    def _probe(case: Case) -> tuple[str | None, dict[str, Any] | None, list[str]]:
        config = types.GenerateContentConfig(
            system_instruction=_instruction_for(case),
            tools=[tool],
            temperature=0,
        )
        contents = [
            types.Content(role="user", parts=[types.Part(text=text)])
            for text in (*case.history, case.utterance)
        ]
        response = client.models.generate_content(model=model_id, contents=contents, config=config)
        candidates = getattr(response, "candidates", None) or []
        if not candidates:
            return None, None, []
        content = getattr(candidates[0], "content", None)
        seen: list[tuple[str, dict[str, Any]]] = []
        for part in getattr(content, "parts", None) or []:
            call = getattr(part, "function_call", None)
            if call:
                seen.append((str(call.name), dict(call.args or {})))
        if not seen:
            return None, None, []
        return seen[0][0], seen[0][1], [name for name, _ in seen]

    return _probe


def _observe(probe: ProbeFn, case: Case) -> Observation:
    last_error: BaseException | None = None
    for attempt in range(1, QUOTA_RETRY_ATTEMPTS + 1):
        started = time.monotonic()
        try:
            first_tool, first_args, all_tools = probe(case)
        except Exception as exc:  # noqa: BLE001 - a provider failure is a result
            last_error = exc
            if _is_transient(exc) and attempt < QUOTA_RETRY_ATTEMPTS:
                time.sleep(min(CALL_GAP_S * (2 ** (attempt - 1)), 60.0))
                continue
            break
        return Observation(
            case=case,
            first_tool=first_tool,
            first_args=first_args,
            all_tools=all_tools,
            latency_ms=(time.monotonic() - started) * 1000,
        )
    return Observation(
        case=case,
        first_tool=None,
        first_args=None,
        all_tools=[],
        latency_ms=0.0,
        error=f"{type(last_error).__name__}: {last_error}",
    )


@dataclass
class FamilyMetrics:
    n: int = 0
    expected_hits: int = 0
    forbidden_hits: int = 0
    wrong_state: int = 0
    unnecessary_tool: int = 0
    unintended_mutation: int = 0
    args_invalid: int = 0
    errors: int = 0
    misses: list[dict[str, Any]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        rate = (self.expected_hits / self.n) if self.n else None
        return {
            "n": self.n,
            "expected_hits": self.expected_hits,
            "expected_hit_rate": rate,
            "forbidden_hits": self.forbidden_hits,
            "wrong_state": self.wrong_state,
            "unnecessary_tool": self.unnecessary_tool,
            "unintended_mutation": self.unintended_mutation,
            "args_invalid": self.args_invalid,
            "errors": self.errors,
            "misses": self.misses,
        }


def _summarise(observations: list[Observation], mutation_tools: frozenset[str]):
    families: dict[str, FamilyMetrics] = {}
    for obs in observations:
        block = families.setdefault(obs.case.family, FamilyMetrics())
        block.n += 1
        block.expected_hits += int(obs.expected_hit)
        block.forbidden_hits += int(obs.forbidden_hit)
        block.wrong_state += int(obs.wrong_state)
        block.unnecessary_tool += int(obs.unnecessary_tool)
        block.unintended_mutation += int(obs.unintended_mutation(mutation_tools))
        block.args_invalid += int(obs.args_invalid)
        block.errors += int(obs.error is not None)
        if not obs.expected_hit or obs.forbidden_hit or obs.error:
            block.misses.append(
                {
                    "id": obs.case.id,
                    "utterance": obs.case.utterance,
                    "history": list(obs.case.history),
                    "expected": list(obs.case.expected_tools),
                    "got": obs.all_tools,
                    "error": obs.error,
                }
            )
    return families


@pytest.mark.live_model
@pytest.mark.skipif(
    os.environ.get(LIVE_EVAL_ENV) != "1",
    reason=f"set {LIVE_EVAL_ENV}=1 with Vertex ADC to run the real-model evaluation",
)
def test_live_model_selects_the_device_tool():
    """Real-model evaluation. PRIMARY mode drives the configured Live head;
    ``ONE_VOICE_LIVE_TOOL_EVAL_MODE=text`` runs the FALLBACK text-model probe
    (declarations + instruction only, not the Live head). The report at
    ``tmp/one-voice-location-updates-eval-report.json`` records which mode ran."""
    os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "true")
    os.environ.setdefault("HUSHH_GENAI_AUTH_MODE", "vertex_adc")

    cases = load_fixture()
    mutation_tools = _mutation_tools()
    mode = (os.environ.get(LIVE_EVAL_MODE_ENV) or "live").strip().lower()
    live_model_id = (os.environ.get(LIVE_MODEL_ENV) or "").strip() or DEFAULT_LIVE_MODEL_ID
    live_location = (
        os.environ.get(LIVE_LOCATION_ENV) or ""
    ).strip().lower() or DEFAULT_LIVE_LOCATION

    if mode == "text":
        from hushh_mcp.constants import fleet_text_model_from_env

        model_id = fleet_text_model_from_env()
        location = "global"
        probe = _make_text_probe(model_id)
        mode_label = "text_fallback (declarations+instruction only, not the Live head)"
    else:
        model_id = live_model_id
        location = live_location
        probe = _make_live_probe(model_id, location)
        mode_label = "live_primary (actual Live head over build_managed_live_client)"

    observations: list[Observation] = []
    for index, case in enumerate(cases):
        if index:
            time.sleep(CALL_GAP_S)
        observations.append(_observe(probe, case))

    families = _summarise(observations, mutation_tools)
    device_obs = [obs for obs in observations if obs.case.family in DEVICE_TOGGLE_FAMILIES]
    no_mutation_obs = [obs for obs in observations if obs.case.family in NO_MUTATION_FAMILIES]
    device_expected_rate = (
        sum(obs.expected_hit for obs in device_obs) / len(device_obs) if device_obs else None
    )
    device_forbidden = sum(obs.forbidden_hit for obs in device_obs)
    unintended = sum(obs.unintended_mutation(mutation_tools) for obs in no_mutation_obs)
    errors = [obs for obs in observations if obs.error]

    report = {
        "schema_version": "one.voice.location_updates_tool_selection_report.v1",
        "generated_at": datetime.now(UTC).isoformat(),
        "git_sha": _git_sha(),
        "mode": mode_label,
        "model": model_id,
        "location": location,
        "fixture": str(FIXTURE_PATH.relative_to(CONSENT_PROTOCOL_ROOT)),
        "cases": len(cases),
        "gates": {
            "device_forbidden_hits": device_forbidden,
            "device_expected_hit_rate": device_expected_rate,
            "device_expected_hit_rate_min": MIN_EXPECTED_HIT_RATE_DEVICE,
            "no_mutation_unintended_mutations": unintended,
            "errors": len(errors),
        },
        "families": {name: block.as_dict() for name, block in sorted(families.items())},
        "observations": [
            {
                "id": obs.case.id,
                "family": obs.case.family,
                "screen": obs.case.screen,
                "history": list(obs.case.history),
                "utterance": obs.case.utterance,
                "expected": list(obs.case.expected_tools),
                "first_tool": obs.first_tool,
                "first_args": obs.first_args,
                "all_tools": obs.all_tools,
                "latency_ms": round(obs.latency_ms, 1),
                "expected_hit": obs.expected_hit,
                "forbidden_hit": obs.forbidden_hit,
                "error": obs.error,
            }
            for obs in observations
        ],
    }
    report_path = _report_path()
    report_path.write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    summary = json.dumps(report["gates"], indent=2)
    assert not errors, (
        f"measurement incomplete ({len(errors)} provider errors); see {report_path}\n{summary}"
    )
    assert device_forbidden == 0, (
        f"forbidden tool proposed on a device toggle case; see {report_path}\n{summary}"
    )
    assert (
        device_expected_rate is not None and device_expected_rate >= MIN_EXPECTED_HIT_RATE_DEVICE
    ), (
        f"device expected-tool hit rate {device_expected_rate} < {MIN_EXPECTED_HIT_RATE_DEVICE}; "
        f"see {report_path}\n{summary}"
    )
    assert unintended == 0, (
        f"unintended mutation on a no-mutation/clarify case; see {report_path}\n{summary}"
    )

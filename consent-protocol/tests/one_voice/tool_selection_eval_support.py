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
# ``expected_args``: {tool: {arg: str | [str, ...]}}. A str is the exact value
# (compared after normalize_spoken_name: speech carries no case or
# punctuation); a list names items the argument's list must contain.
OPTIONAL_CASE_KEYS = frozenset({"expected_args"})

ArgExpectation = str | tuple[str, ...]
Call = tuple[str, dict[str, Any], dict[str, Any]]


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
    # ((tool, ((arg, expectation), ...)), ...): tuples keep the case hashable.
    expected_args: tuple[tuple[str, tuple[tuple[str, ArgExpectation], ...]], ...] = ()

    @property
    def expected_args_by_tool(self) -> dict[str, dict[str, ArgExpectation]]:
        return {tool: dict(args) for tool, args in self.expected_args}


@dataclass
class Observation:
    case: Case
    first_tool: str | None
    first_args: dict[str, Any] | None
    # Every (tool, args, result_public) on the final turn, in order.
    calls: list[Call]
    latency_ms: float
    error: str | None = None
    # Every call the replayed history turns made, so a miss shows whether the
    # earlier card the utterance answers was really staged.
    history_calls: list[Call] = field(default_factory=list)

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


def _normalized(value: str) -> str:
    from hushh_mcp.services.spoken_name_resolver import normalize_spoken_name

    return normalize_spoken_name(value)


def _word_key(value: str) -> str:
    """A listed word as the server's spelled-word contract reads it: letters
    sent one by one ("H U S S H") join into the word, case is ignored. The
    eval judges a declared word exactly as the guard would."""
    from hushh_mcp.one_voice.tools.spelling import clean_spelled_word, spelling_key

    return spelling_key(clean_spelled_word(value) or value)


def _arg_matches(expected: ArgExpectation, actual: Any) -> bool:
    if isinstance(expected, str):
        return isinstance(actual, str) and _normalized(actual) == _normalized(expected)
    if not isinstance(actual, list) or not all(isinstance(item, str) for item in actual):
        return False
    present = {_word_key(item) for item in actual}
    return all(_word_key(item) in present for item in expected)


# Result statuses under which a scored call counts: the server took it. Every
# other status (rejected, pending_action_exists, ...) means the call did not
# stand as made, so its arguments cannot score a hit. confirmation_waiting
# counts only as the executor's reuse: an open card with exactly these
# arguments. The relay's hold (``HELD_REASON``) never ran the call, so the
# card it names may hold other arguments.
ACCEPTED_STATUSES = frozenset(
    {
        "ok",
        "confirmed",
        "confirmation_required",
        "confirmation_waiting",
        "navigation_dispatched",
        "cancelled",
        "pending",
        "none",
    }
)
# The key the relay adds to a result when the call retired open cards
# (``session.py``): a new card replaces every open one in the conversation
# (the store's create cancels them), a refused correction retires the card
# it corrected, and a lookup retires cards it made stale.
SUPERSEDED_KEY = "superseded_pending_action_ids"
# The reason the relay gives a confirm-tier call it held unrun (``session.py``).
HELD_REASON = "awaiting_answer"
# Results that put a card in front of the person: a new one, or the open one
# the executor reused because the call matched it exactly.
CARD_STATUSES = frozenset({"confirmation_required", "confirmation_waiting"})


def _held(result: dict[str, Any]) -> bool:
    return (
        result.get("status") == "confirmation_waiting" and result.get("reason_code") == HELD_REASON
    )


def _open_proposals(calls: list[Call]) -> dict[int, str]:
    """Replay one turn: index of each call whose card is still open at its end.

    A ``confirmation_required`` result opens a card, and the executor's
    ``confirmation_waiting`` reuse names an open card holding exactly that
    call's arguments (it may be from an earlier turn); a held call names a card
    it never ran against, so it opens nothing. A card closes when the model
    cancels that id, or when a later result reports it superseded. Closures
    come only from what the results said, as the model saw them. A card with
    no id in its result (a hand-written triple) cannot be closed by id.
    """
    opened: dict[int, str] = {}
    for index, (name, args, result) in enumerate(calls):
        closed: set[str] = {str(item) for item in result.get(SUPERSEDED_KEY) or []}
        if name == "cancel_pending_action" and result.get("status") == "cancelled":
            closed.add(str(args.get("pending_action_id") or ""))
        opened = {i: pid for i, pid in opened.items() if pid not in closed}
        if result.get("status") in CARD_STATUSES and not _held(result):
            opened[index] = str(result.get("pending_action_id") or f"#call-{index}")
    return opened


def _scored_call(obs: Observation, tool: str) -> int | None:
    """The latest call of ``tool`` in the scored (final) turn."""
    return next(
        (index for index in reversed(range(len(obs.calls))) if obs.calls[index][0] == tool), None
    )


def _args_key(args: dict[str, Any]) -> str:
    """Arguments as speech carries them: case, punctuation and letter spacing
    of a spelled word do not make a second proposal."""
    normal: dict[str, Any] = {}
    for key, value in args.items():
        if value in (None, "", [], {}):
            continue
        if isinstance(value, str):
            normal[key] = _normalized(value)
        elif isinstance(value, list) and all(isinstance(item, str) for item in value):
            normal[key] = sorted({_word_key(item) for item in value})
        else:
            normal[key] = value
    return json.dumps(normal, sort_keys=True, default=str)


def arg_mismatches(obs: Observation) -> list[dict[str, Any]]:
    """Each expected argument the scored (final) turn did not carry.

    The LAST call of each expected tool in that turn is scored, so a call the
    executor refused and the model then corrected is judged on the
    correction. That call counts only if its result status is accepted and,
    when it put a card in front of the person (a new one, or the executor's
    reuse of the open one), the card is still open at the end of the turn: a
    refused call, a held call or a withdrawn card never scores, whatever it
    said. No call of the tool is a mismatch. Empty means all matched.
    """
    mismatches: list[dict[str, Any]] = []
    open_cards = _open_proposals(obs.calls)
    for tool, expected_args in obs.case.expected_args_by_tool.items():
        index = _scored_call(obs, tool)
        last = None if index is None else obs.calls[index][1]
        if index is not None:
            result = obs.calls[index][2]
            status = result.get("status")
            reason = (
                "status"
                if status not in ACCEPTED_STATUSES or _held(result)
                else "not_current"
                if status in CARD_STATUSES and index not in open_cards
                else None
            )
            if reason is not None:
                mismatches.append(
                    {"tool": tool, "arg": None, "reason": reason, "got": status, "called": True}
                )
        for arg, expected in expected_args.items():
            actual = None if last is None else last.get(arg)
            if last is None or not _arg_matches(expected, actual):
                mismatches.append(
                    {
                        "tool": tool,
                        "arg": arg,
                        "reason": "value" if last is not None else "not_called",
                        "expected": expected if isinstance(expected, str) else list(expected),
                        "got": actual,
                        "called": last is not None,
                    }
                )
    return mismatches


def extra_proposals(obs: Observation) -> list[dict[str, Any]]:
    """Expected tools left with more than one distinct open card in the scored
    turn: the person heard two different proposals and either could be the
    one they answer. Identical arguments (as speech carries them) count once."""
    open_cards = _open_proposals(obs.calls)
    tools = {*obs.case.expected_tools, *obs.case.expected_args_by_tool}
    extra: list[dict[str, Any]] = []
    for tool in sorted(tools):
        distinct = {
            _args_key(obs.calls[index][1]) for index in open_cards if obs.calls[index][0] == tool
        }
        if len(distinct) > 1:
            extra.append({"tool": tool, "open_proposals": len(distinct)})
    return extra


def history_report(obs: Observation) -> list[dict[str, Any]]:
    return [
        {"tool": name, "args": args, "status": result.get("status")}
        for name, args, result in obs.history_calls
    ]


# A responder answers one function call. ``(tool, args) -> result_public``.
Responder = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]
# ``(case) -> responder`` so every case starts from a clean fake world.
ResponderFactory = Callable[[Case], Responder]
# ``(case) -> (first tool, first args, calls[, history calls])``; a probe that
# returns three items reports no history calls.
ProbeFn = Callable[
    [Case],
    tuple[str | None, dict[str, Any] | None, list[Call]]
    | tuple[str | None, dict[str, Any] | None, list[Call], list[Call]],
]


def _load_expected_args(
    case_id: str, raw: Any
) -> tuple[tuple[str, tuple[tuple[str, ArgExpectation], ...]], ...]:
    assert isinstance(raw, dict) and raw, (case_id, "expected_args")
    tools: list[tuple[str, tuple[tuple[str, ArgExpectation], ...]]] = []
    for tool, args in raw.items():
        assert isinstance(tool, str) and tool.strip(), (case_id, "expected_args tool")
        assert isinstance(args, dict) and args, (case_id, tool)
        parsed: list[tuple[str, ArgExpectation]] = []
        for arg, expected in args.items():
            assert isinstance(arg, str) and arg.strip(), (case_id, tool, "arg name")
            if isinstance(expected, str):
                assert expected.strip(), (case_id, tool, arg)
                parsed.append((arg, expected))
                continue
            assert (
                isinstance(expected, list)
                and expected
                and all(isinstance(item, str) and item.strip() for item in expected)
            ), (case_id, tool, arg)
            parsed.append((arg, tuple(expected)))
        tools.append((tool, tuple(parsed)))
    return tuple(tools)


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
        assert CASE_KEYS <= set(raw) <= CASE_KEYS | OPTIONAL_CASE_KEYS, (
            f"case #{index} has unexpected keys: {sorted(raw)}"
        )
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
                expected_args=(
                    _load_expected_args(case_id, raw["expected_args"])
                    if "expected_args" in raw
                    else ()
                ),
            )
        )
    return cases


def production_corpus() -> str:
    """Every production sentence the model sees or that shapes what it sees.

    Whitespace is collapsed so a sentence wrapped across source lines (the
    instruction's numbered rules) is compared the way the model reads it.
    """
    descriptions = "\n".join(str(item.get("description") or "") for item in registry.declarations())
    instruction_source = inspect.getsource(instruction_module)
    manifest = AGENT_MANIFEST_PATH.read_text(encoding="utf-8")
    joined = "\n".join((descriptions, instruction_source, manifest)).lower()
    return " ".join(joined.split())


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
                        # Responders may attach evaluator-only execution
                        # metadata.  Keep it in the observation, never in the
                        # tool response sent back to the model.
                        observed = dict(response)
                        model_response = dict(response)
                        model_response.pop("_eval", None)
                        seen.append((call["name"], args, observed))
                        await session.send_tool_response(
                            call_id=call.get("id"), name=call["name"], response=model_response
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
        history_seen: list[Call] = []
        async with client.aio.live.connect(model=model_id, config=config) as raw_session:
            session = GeminiLiveSession(raw_session)
            for text in case.history:
                await session.send_text(text)
                await asyncio.wait_for(
                    _drain_turn(raw_session, session, respond, history_seen),
                    timeout=TURN_TIMEOUT_S + 5,
                )
            seen: list[Call] = []
            await session.send_text(case.utterance)
            await asyncio.wait_for(
                _drain_turn(raw_session, session, respond, seen), timeout=TURN_TIMEOUT_S + 5
            )
        if not seen:
            return None, None, [], history_seen
        return seen[0][0], seen[0][1], seen, history_seen

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
        seen: list[Call] = []
        history_seen: list[Call] = []
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
                    observed = dict(result)
                    model_result = dict(result)
                    model_result.pop("_eval", None)
                    (seen if final else history_seen).append((name, args, observed))
                    parts.append(
                        types.Part.from_function_response(name=name, response=model_result)
                    )
                contents.append(types.Content(role="user", parts=parts))
        if not seen:
            return None, None, [], history_seen
        return seen[0][0], seen[0][1], seen, history_seen

    def _probe(case: Case):
        return asyncio.run(_run(case))

    return _probe


def observe(probe: ProbeFn, case: Case) -> Observation:
    last_error: BaseException | None = None
    for attempt in range(1, QUOTA_RETRY_ATTEMPTS + 1):
        started = time.monotonic()
        try:
            first_tool, first_args, calls, *rest = probe(case)
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
            history_calls=list(rest[0]) if rest else [],
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
    # Execution is scored independently from selecting the right first tool.
    # These counters are populated by domain evaluators from the responder's
    # evaluator-only trace (never shown to the model).
    status_reason_failures: int = 0
    argument_mismatches: int = 0
    extra_proposals: int = 0
    revision_failures: int = 0
    provider_attempts: int = 0
    provider_calls: int = 0
    ledger_events: int = 0
    fallback_count: int = 0
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
            "status_reason_failures": self.status_reason_failures,
            "argument_mismatches": self.argument_mismatches,
            "extra_proposals": self.extra_proposals,
            "revision_failures": self.revision_failures,
            "provider_attempts": self.provider_attempts,
            "provider_calls": self.provider_calls,
            "ledger_events": self.ledger_events,
            "fallback_count": self.fallback_count,
            "errors": self.errors,
            "misses": self.misses,
        }


def write_report(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")

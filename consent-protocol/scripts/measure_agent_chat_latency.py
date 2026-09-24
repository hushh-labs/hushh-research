#!/usr/bin/env python3
"""Localhost latency driver for the private agent's canonical AG-UI chat route.

Drives ``POST /api/one/agent-chat`` the way the browser does (one
``RunAgentInput`` per turn, a fresh ``threadId`` per prompt, ``Accept:
text/event-stream``) as the reviewer, and measures two client-side marks per
turn:

* ``first_visible``: the first ``TEXT_MESSAGE_CONTENT`` or ``TOOL_CALL_START``
  frame, which is the earliest moment a person sees the agent respond;
* ``first_answer_token``: the first assistant ``TEXT_MESSAGE_CONTENT`` frame,
  separately from tool activity that may be visible earlier;
* ``total``: the terminal ``RUN_FINISHED`` or ``RUN_ERROR`` frame.

With ``--server-log`` the driver also tails the backend log for the
``one_agent_chat_turn_complete`` line of each run (matched on the ``run=``
prefix) and records the server-side ``first_visible_ms`` / ``elapsed_ms``
beside the client numbers, so transport cost and model cost can be told apart.

The report lands in ``artifacts/agent_chat_latency_<label>.json``. With
``--baseline <before.json>`` the run is a gate: first_visible p95 may grow by
at most ``max(25%, 500 ms)``, total p95 by at most 25%, every sample must
finish, and the hard ceilings (8 s first visible, 30 s total) always apply.
Exit status 1 on any breach.

Output discipline: the driver prints prompt ids and milliseconds only. It
never prints response text, thread ids, user ids, tokens or any secret it
loaded, and every printed line is scrubbed against the loaded secret values.

Usage (backend on the default port, reviewer secrets in the environment):

    REVIEWER_UID=... uv run python scripts/measure_agent_chat_latency.py \\
        --label before --server-log /tmp/backend.log
    uv run python scripts/measure_agent_chat_latency.py --label after \\
        --baseline artifacts/agent_chat_latency_before.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import uuid
from collections.abc import Callable, Iterable, Iterator
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import requests

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scripts._reviewer_session import (  # noqa: E402
    DEFAULT_PROTOCOL_ENV,
    DEFAULT_WEB_ENV,
    ReviewerConfig,
    ReviewerSession,
    authenticate_reviewer,
    load_reviewer_config,
)

DEFAULT_BASE_URL = "http://127.0.0.1:8000"
AGENT_CHAT_PATH = "/api/one/agent-chat"
DEFAULT_ARTIFACT_DIR = PROJECT_ROOT / "artifacts"
DEFAULT_REPS = 3
DEFAULT_GAP_SECONDS = 2.0
# Match the One route's execution window; a shorter driver limit can interrupt
# a valid turn before the backend's own deadline. Latency gates remain separate.
DEFAULT_TURN_TIMEOUT_SECONDS = 120.0
DEFAULT_TIMEZONE = "UTC"
DEFAULT_COUNTERPART = "Alice"

FIRST_VISIBLE_CEILING_MS = 8000.0
TOTAL_CEILING_MS = 30000.0
REGRESSION_RATIO = 1.25
FIRST_VISIBLE_ABSOLUTE_SLACK_MS = 500.0

FIRST_VISIBLE_EVENT_TYPES = frozenset({"TEXT_MESSAGE_CONTENT", "TOOL_CALL_START"})
TERMINAL_EVENT_TYPES = frozenset({"RUN_FINISHED", "RUN_ERROR"})
OUTCOME_FINISHED = "finished"
OUTCOME_RUN_ERROR = "run_error"
OUTCOME_NO_TERMINAL = "no_terminal"
OUTCOME_TIMEOUT = "timeout"
OUTCOME_TRANSPORT_ERROR = "transport_error"
OUTCOME_HTTP_ERROR = "http_error"

SERVER_LOG_MARK = "one_agent_chat_turn_complete"
_SERVER_HEAD_RE = re.compile(r"\bhead=([A-Za-z0-9_-]+)")
ONE_HEAD_LABEL = "one"  # hushh_mcp.one_adk.agui_turn_timing.HEAD_ONE; kept literal so the driver never imports the runtime
_SERVER_RUN_RE = re.compile(r"\brun=([0-9a-fA-F-]{1,8})")
_SERVER_FIRST_VISIBLE_RE = re.compile(r"\bfirst_visible_ms=([^\s,]+)")
_SERVER_FIRST_ANSWER_TOKEN_RE = re.compile(r"\bfirst_answer_token_ms=([^\s,]+)")
_SERVER_ELAPSED_RE = re.compile(r"\belapsed_ms=([^\s,]+)")
_SAFE_ERROR_CODE_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
RUN_PREFIX_LEN = 8

REDACTED = "[redacted]"


@dataclass(frozen=True)
class PromptCase:
    prompt_id: str
    category: str
    text: str
    expected_answer_pattern: str | None = None
    expected_tool_name: str | None = None
    require_no_tools: bool = False

    def render(self, *, counterpart: str) -> str:
        return self.text.format(counterpart=counterpart)


PROMPTS: tuple[PromptCase, ...] = (
    PromptCase("general_help", "general", "what can you help me with"),
    PromptCase("general_time", "general", "what time is it"),
    PromptCase("general_sharing", "general", "how does sharing my information work"),
    PromptCase(
        "general_identity",
        "general",
        "who are you",
        expected_answer_pattern=r"\bOne\b",
        require_no_tools=True,
    ),
    PromptCase("consent_pending", "consent", "is there anything waiting for me to approve"),
    PromptCase(
        "consent_visibility",
        "consent",
        "who can see my information right now",
        expected_tool_name="list_active_grants",
    ),
    PromptCase(
        "consent_request",
        "consent",
        "ask {counterpart} for their home address for three days because we are planning a trip",
    ),
    PromptCase("delegation_add_trusted", "delegation", "add Alice to my trusted people"),
    PromptCase("delegation_location", "delegation", "who is sharing their location with me"),
    PromptCase("finance_ticker", "finance", "what is NVDA doing today"),
    PromptCase("finance_portfolio", "finance", "summarize my portfolio"),
    PromptCase("memory_preference", "memory", "what do you remember about my travel preferences"),
)


@dataclass
class TurnSample:
    prompt_id: str
    category: str
    rep: int
    run: str
    outcome: str
    client_first_visible_ms: float | None = None
    client_first_answer_token_ms: float | None = None
    client_total_ms: float | None = None
    server_first_visible_ms: float | None = None
    server_first_answer_token_ms: float | None = None
    server_elapsed_ms: float | None = None
    first_visible_event: str | None = None
    event_count: int = 0
    tool_call_count: int = 0
    expected_tool_observed: bool | None = None
    answer_validated: bool | None = None
    detail: str = ""


class TransportFailure(RuntimeError):
    """A turn that never produced a stream. Carries an outcome, never a body."""

    def __init__(self, outcome: str, detail: str) -> None:
        super().__init__(detail)
        self.outcome = outcome
        self.detail = detail


StreamOpener = Callable[[dict[str, Any]], Iterable[str]]
Clock = Callable[[], float]


# --------------------------------------------------------------------------
# Request body
# --------------------------------------------------------------------------


def build_run_agent_input(
    message: str,
    *,
    thread_id: str,
    run_id: str,
    timezone: str,
    message_id: str | None = None,
) -> dict[str, Any]:
    """The ``RunAgentInput`` the browser sends, minus the action tools.

    ``lib/services/agent-chat-client.ts`` seeds ``HttpAgent`` with one user
    message and forwards ``timezone``, ``pkmContext`` and ``screenContext``.
    The driver carries no client action tools (an empty ``tools`` list is what
    a chat surface without an action snapshot sends) and a minimal screen
    context, so the turn exercises the server-side tool set alone.
    """

    return {
        "threadId": thread_id,
        "runId": run_id,
        "state": {},
        "messages": [{"id": message_id or str(uuid.uuid4()), "role": "user", "content": message}],
        "tools": [],
        "context": [],
        "forwardedProps": {
            "timezone": timezone,
            "screenContext": {"screen": "agent", "signed_in": True},
        },
    }


# --------------------------------------------------------------------------
# SSE parsing and per-turn timing
# --------------------------------------------------------------------------


def iter_sse_events(lines: Iterable[str]) -> Iterator[dict[str, Any]]:
    """Yield decoded ``data:`` payloads from an SSE line stream.

    Comment lines (``: ping``) and ``event:``/``id:`` fields are ignored, a
    blank line dispatches the accumulated ``data:`` lines, and a trailing event
    without a final blank line is still dispatched. Non-JSON payloads are
    skipped rather than raised so a malformed frame cannot end the sample.
    """

    data_lines: list[str] = []
    for raw in lines:
        line = raw.rstrip("\r\n")
        if not line:
            event = _dispatch(data_lines)
            data_lines = []
            if event is not None:
                yield event
            continue
        if line.startswith(":"):
            continue
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip(" "))
    event = _dispatch(data_lines)
    if event is not None:
        yield event


def _dispatch(data_lines: list[str]) -> dict[str, Any] | None:
    if not data_lines:
        return None
    try:
        decoded = json.loads("\n".join(data_lines))
    except json.JSONDecodeError:
        return None
    return decoded if isinstance(decoded, dict) else None


def drive_turn(
    open_stream: StreamOpener,
    body: dict[str, Any],
    *,
    prompt: PromptCase,
    rep: int,
    clock: Clock | None = None,
    turn_timeout_seconds: float = DEFAULT_TURN_TIMEOUT_SECONDS,
) -> TurnSample:
    """Send one turn and return its client-side timings.

    ``t0`` is taken before the request is opened so connection setup and the
    server's pre-stream work (auth, state extraction) count toward first
    visible, exactly as a person experiences them. ``clock`` defaults to
    ``time.perf_counter`` resolved at call time so a test can substitute it.
    """

    clock = clock or time.perf_counter
    sample = TurnSample(
        prompt_id=prompt.prompt_id,
        category=prompt.category,
        rep=rep,
        run=str(body["runId"])[:RUN_PREFIX_LEN],
        outcome=OUTCOME_NO_TERMINAL,
    )
    started_at = clock()
    answer_parts: list[str] = []
    observed_tools: list[str] = []
    try:
        lines = open_stream(body)
    except TransportFailure as failure:
        sample.outcome = failure.outcome
        sample.detail = failure.detail
        sample.client_total_ms = _elapsed_ms(started_at, clock())
        return sample
    except requests.RequestException as exc:
        sample.outcome = OUTCOME_TRANSPORT_ERROR
        sample.detail = type(exc).__name__
        sample.client_total_ms = _elapsed_ms(started_at, clock())
        return sample

    try:
        for event in iter_sse_events(lines):
            now = clock()
            sample.event_count += 1
            event_type = str(event.get("type") or "")
            if event_type == "TEXT_MESSAGE_CONTENT":
                delta = event.get("delta")
                if isinstance(delta, str):
                    answer_parts.append(delta)
            elif event_type == "TOOL_CALL_START":
                sample.tool_call_count += 1
                tool_name = str(event.get("toolCallName") or event.get("tool_call_name") or "")
                if tool_name:
                    observed_tools.append(tool_name)
            if sample.client_first_visible_ms is None and event_type in FIRST_VISIBLE_EVENT_TYPES:
                sample.client_first_visible_ms = _elapsed_ms(started_at, now)
                sample.first_visible_event = event_type
            if sample.client_first_answer_token_ms is None and event_type == "TEXT_MESSAGE_CONTENT":
                sample.client_first_answer_token_ms = _elapsed_ms(started_at, now)
            if event_type in TERMINAL_EVENT_TYPES:
                sample.client_total_ms = _elapsed_ms(started_at, now)
                sample.outcome = (
                    OUTCOME_FINISHED if event_type == "RUN_FINISHED" else OUTCOME_RUN_ERROR
                )
                if event_type == "RUN_ERROR":
                    code = str(event.get("code") or "RUN_ERROR")
                    sample.detail = code if _SAFE_ERROR_CODE_RE.fullmatch(code) else "UNCLASSIFIED"
                break
            if now - started_at > turn_timeout_seconds:
                sample.outcome = OUTCOME_TIMEOUT
                sample.client_total_ms = _elapsed_ms(started_at, now)
                break
    except requests.RequestException as exc:
        sample.outcome = OUTCOME_TRANSPORT_ERROR
        sample.detail = type(exc).__name__
        sample.client_total_ms = _elapsed_ms(started_at, clock())
    finally:
        close = getattr(lines, "close", None)
        if callable(close):
            close()

    if sample.client_total_ms is None:
        sample.client_total_ms = _elapsed_ms(started_at, clock())
    if (
        prompt.expected_answer_pattern is not None
        or prompt.expected_tool_name is not None
        or prompt.require_no_tools
    ):
        answer = "".join(answer_parts).strip()
        sample.expected_tool_observed = (
            prompt.expected_tool_name is None or prompt.expected_tool_name in observed_tools
        )
        answer_matches = bool(answer) and (
            prompt.expected_answer_pattern is None
            or re.search(prompt.expected_answer_pattern, answer, re.IGNORECASE) is not None
        )
        tools_match = (
            sample.tool_call_count == 0
            if prompt.require_no_tools
            else prompt.expected_tool_name is None
            or bool(observed_tools)
            and all(name == prompt.expected_tool_name for name in observed_tools)
        )
        sample.answer_validated = answer_matches and sample.expected_tool_observed and tools_match
        answer_parts.clear()
        observed_tools.clear()
    return sample


def _elapsed_ms(started_at: float, now: float) -> float:
    return round((now - started_at) * 1000.0, 1)


def make_http_stream_opener(
    base_url: str,
    session: ReviewerSession,
    *,
    http: requests.Session,
    turn_timeout_seconds: float,
) -> StreamOpener:
    url = f"{base_url.rstrip('/')}{AGENT_CHAT_PATH}"
    headers = {
        **session.vault_headers(),
        "Accept": "text/event-stream",
        "Content-Type": "application/json",
    }

    def open_stream(body: dict[str, Any]) -> Iterable[str]:
        response = http.post(
            url, headers=headers, json=body, stream=True, timeout=(10.0, turn_timeout_seconds)
        )
        if response.status_code != 200:
            response.close()
            raise TransportFailure(OUTCOME_HTTP_ERROR, f"HTTP {response.status_code}")
        return _closing_lines(response)

    return open_stream


def _closing_lines(response: requests.Response) -> Iterator[str]:
    try:
        for line in response.iter_lines(decode_unicode=True):
            yield line if isinstance(line, str) else line.decode("utf-8", "replace")
    finally:
        response.close()


# --------------------------------------------------------------------------
# Suite
# --------------------------------------------------------------------------


def run_suite(
    open_stream: StreamOpener,
    prompts: Iterable[PromptCase],
    *,
    reps: int,
    gap_seconds: float,
    counterpart: str,
    timezone: str,
    clock: Clock | None = None,
    sleep: Callable[[float], None] | None = None,
    turn_timeout_seconds: float = DEFAULT_TURN_TIMEOUT_SECONDS,
    on_sample: Callable[[TurnSample], None] | None = None,
) -> list[TurnSample]:
    """Run every prompt ``reps`` times, rep-major, with a fixed gap between turns.

    Rep-major order (all prompts, then all prompts again) keeps a prompt's
    repetitions apart in time so a warm cache from the previous turn does not
    flatter its second sample. Every turn opens a fresh thread.
    """

    clock = clock or time.perf_counter
    sleep = sleep or time.sleep
    cases = list(prompts)
    samples: list[TurnSample] = []
    total_turns = reps * len(cases)
    for rep in range(reps):
        for case in cases:
            body = build_run_agent_input(
                case.render(counterpart=counterpart),
                thread_id=str(uuid.uuid4()),
                run_id=str(uuid.uuid4()),
                timezone=timezone,
            )
            sample = drive_turn(
                open_stream,
                body,
                prompt=case,
                rep=rep,
                clock=clock,
                turn_timeout_seconds=turn_timeout_seconds,
            )
            samples.append(sample)
            if on_sample is not None:
                on_sample(sample)
            if len(samples) < total_turns and gap_seconds > 0:
                sleep(gap_seconds)
    return samples


# --------------------------------------------------------------------------
# Server log correlation
# --------------------------------------------------------------------------


def parse_server_turn_lines(lines: Iterable[str]) -> dict[str, dict[str, float | None]]:
    """Index ``one_agent_chat_turn_complete`` lines by their ``run=`` prefix.

    Only the numeric fields and a head flag are kept. Anything a future
    revision adds to the line is never copied out, so nothing but milliseconds
    and the head marker leaves the log through this path.
    """

    by_run: dict[str, dict[str, float | None]] = {}
    for line in lines:
        if SERVER_LOG_MARK not in line:
            continue
        tail = line.split(SERVER_LOG_MARK, 1)[1]
        run_match = _SERVER_RUN_RE.search(tail)
        if run_match is None:
            continue
        head_match = _SERVER_HEAD_RE.search(tail)
        by_run[run_match.group(1)] = {
            "first_visible_ms": _numeric_field(_SERVER_FIRST_VISIBLE_RE, tail),
            "first_answer_token_ms": _numeric_field(_SERVER_FIRST_ANSWER_TOKEN_RE, tail),
            "elapsed_ms": _numeric_field(_SERVER_ELAPSED_RE, tail),
            # Kept so a turn the route answered from the pre-vault intro head
            # (a rejected vault-owner token falls back silently) is refused,
            # never graded as the private agent's latency.
            "head": 1.0 if head_match and head_match.group(1) == ONE_HEAD_LABEL else 0.0,
        }
    return by_run


def _numeric_field(pattern: re.Pattern[str], text: str) -> float | None:
    match = pattern.search(text)
    if match is None:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None


def attach_server_timings(
    samples: Iterable[TurnSample], by_run: dict[str, dict[str, float | None]]
) -> int:
    matched = 0
    for sample in samples:
        timing = by_run.get(sample.run)
        if timing is None:
            continue
        sample.server_first_visible_ms = timing.get("first_visible_ms")
        sample.server_first_answer_token_ms = timing.get("first_answer_token_ms")
        sample.server_elapsed_ms = timing.get("elapsed_ms")
        matched += 1
    return matched


def intro_head_runs(
    samples: Iterable[TurnSample], by_run: dict[str, dict[str, float | None]]
) -> list[str]:
    """Run prefixes the server answered from the intro head instead of One."""

    return [
        sample.run
        for sample in samples
        if sample.run in by_run and by_run[sample.run].get("head") == 0.0
    ]


def read_log_since_settled(
    path: Path, offset: int, expected_runs: int, *, wait_seconds: float = 2.0
) -> list[str]:
    """Read the log after the last turn, retrying briefly for the final line.

    The timing line is written in the agent's ``finally`` block, which can land
    a few milliseconds after the client saw RUN_FINISHED; a single immediate
    read would miss the last turn on a fast machine.
    """

    deadline = time.monotonic() + wait_seconds
    lines = read_log_since(path, offset)
    while (
        sum(SERVER_LOG_MARK in line for line in lines) < expected_runs
        and time.monotonic() < deadline
    ):
        time.sleep(0.1)
        lines = read_log_since(path, offset)
    return lines


def read_log_since(path: Path, offset: int) -> list[str]:
    """Return the lines appended to ``path`` after byte ``offset``.

    A log that was rotated or truncated under the driver is read from its
    start rather than from a now-meaningless offset.
    """

    if not path.is_file():
        return []
    size = path.stat().st_size
    start = offset if 0 <= offset <= size else 0
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        handle.seek(start)
        return handle.read().splitlines()


def log_offset(path: Path) -> int:
    return path.stat().st_size if path.is_file() else 0


# --------------------------------------------------------------------------
# Statistics and report
# --------------------------------------------------------------------------


def pct(values: list[float], quantile: float) -> float:
    """Return the linearly interpolated percentile of ``values``.

    Same form as ``scripts/eval_pkm_structure_agent.pct``: the nearest-rank
    alternative returns a real sample rather than the percentile, which on a
    small suite reports a "p95" a couple of samples below the tail it names.
    """

    if not values:
        return 0.0
    ordered = sorted(float(value) for value in values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * min(max(quantile, 0.0), 1.0)
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def latency_block(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {"count": 0, "p50": None, "p95": None, "max": None}
    return {
        "count": len(values),
        "p50": round(pct(values, 0.50), 1),
        "p95": round(pct(values, 0.95), 1),
        "max": round(max(values), 1),
    }


def _present(samples: Iterable[TurnSample], attribute: str) -> list[float]:
    return [
        float(value)
        for value in (getattr(sample, attribute) for sample in samples)
        if value is not None
    ]


def summarize(samples: list[TurnSample]) -> dict[str, Any]:
    return {
        "client": {
            "first_visible": latency_block(_present(samples, "client_first_visible_ms")),
            "first_answer_token": latency_block(_present(samples, "client_first_answer_token_ms")),
            "total": latency_block(_present(samples, "client_total_ms")),
        },
        "server": {
            "first_visible": latency_block(_present(samples, "server_first_visible_ms")),
            "first_answer_token": latency_block(_present(samples, "server_first_answer_token_ms")),
            "elapsed": latency_block(_present(samples, "server_elapsed_ms")),
        },
    }


def build_report(
    samples: list[TurnSample],
    *,
    label: str,
    base_url: str,
    reps: int,
    gap_seconds: float,
    server_log_matched: int | None,
) -> dict[str, Any]:
    outcomes: dict[str, int] = {}
    for sample in samples:
        outcomes[sample.outcome] = outcomes.get(sample.outcome, 0) + 1
    per_prompt: dict[str, Any] = {}
    for case in PROMPTS:
        own = [sample for sample in samples if sample.prompt_id == case.prompt_id]
        if own:
            per_prompt[case.prompt_id] = {"category": case.category, **summarize(own)}
    return {
        "label": label,
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "base_url": base_url,
        "route": AGENT_CHAT_PATH,
        "reps": reps,
        "gap_seconds": gap_seconds,
        "prompt_count": len(PROMPTS),
        "sample_count": len(samples),
        "server_log_matched": server_log_matched,
        "outcomes": outcomes,
        "summary": summarize(samples),
        "per_prompt": per_prompt,
        "samples": [asdict(sample) for sample in samples],
    }


# --------------------------------------------------------------------------
# Bounds
# --------------------------------------------------------------------------


def _client_p95(report: dict[str, Any], metric: str) -> float | None:
    block = report.get("summary", {}).get("client", {}).get(metric, {})
    value = block.get("p95") if isinstance(block, dict) else None
    return float(value) if value is not None else None


def evaluate_bounds(
    report: dict[str, Any],
    baseline: dict[str, Any] | None,
    *,
    first_visible_ceiling_ms: float = FIRST_VISIBLE_CEILING_MS,
    total_ceiling_ms: float = TOTAL_CEILING_MS,
) -> list[str]:
    """Return every breached bound as a human-readable line; empty means pass.

    The ceilings and the every-sample-finished rule apply on every run. The
    relative bounds apply only when a baseline report is supplied, and use the
    client-side numbers so the gate reads what a person would experience.
    """

    breaches: list[str] = []
    samples = report.get("samples") or []
    if not samples:
        return ["no samples were recorded"]

    unfinished = [s for s in samples if s.get("outcome") != OUTCOME_FINISHED]
    if unfinished:
        summary = ", ".join(
            f"{s.get('prompt_id')}#{s.get('rep')}={s.get('outcome')}" for s in unfinished
        )
        breaches.append(f"{len(unfinished)} sample(s) did not finish: {summary}")

    first_visible = _client_p95(report, "first_visible")
    total = _client_p95(report, "total")
    if first_visible is None:
        breaches.append("no sample produced a first visible frame")
    elif first_visible > first_visible_ceiling_ms:
        breaches.append(
            f"first_visible p95 {first_visible:.0f} ms exceeds ceiling {first_visible_ceiling_ms:.0f} ms"
        )
    if total is None:
        breaches.append("no sample produced a total")
    elif total > total_ceiling_ms:
        breaches.append(f"total p95 {total:.0f} ms exceeds ceiling {total_ceiling_ms:.0f} ms")

    if baseline is None:
        return breaches

    before_first_visible = _client_p95(baseline, "first_visible")
    before_total = _client_p95(baseline, "total")
    if before_first_visible is None or before_total is None:
        breaches.append("baseline report carries no client p95 numbers")
        return breaches
    if first_visible is not None:
        allowed = max(
            REGRESSION_RATIO * before_first_visible,
            before_first_visible + FIRST_VISIBLE_ABSOLUTE_SLACK_MS,
        )
        if first_visible > allowed:
            breaches.append(
                f"first_visible p95 {first_visible:.0f} ms exceeds allowed {allowed:.0f} ms "
                f"(baseline {before_first_visible:.0f} ms)"
            )
    if total is not None:
        allowed = REGRESSION_RATIO * before_total
        if total > allowed:
            breaches.append(
                f"total p95 {total:.0f} ms exceeds allowed {allowed:.0f} ms "
                f"(baseline {before_total:.0f} ms)"
            )
    return breaches


# --------------------------------------------------------------------------
# Output scrubbing
# --------------------------------------------------------------------------


class Printer:
    """Prints lines after replacing every known secret value.

    Belt and braces: the driver already prints only ids and milliseconds, but
    a scrubbed writer means a future format string cannot leak a bearer.
    """

    def __init__(self, secret_values: Iterable[str]) -> None:
        self._secrets = sorted(
            {s for s in secret_values if s and len(s) >= 4}, key=len, reverse=True
        )

    def add(self, *values: str) -> None:
        self._secrets = sorted(
            {*self._secrets, *(v for v in values if v and len(v) >= 4)}, key=len, reverse=True
        )

    def scrub(self, text: str) -> str:
        for secret in self._secrets:
            text = text.replace(secret, REDACTED)
        return text

    def __call__(self, text: str) -> None:
        print(self.scrub(text))


def secret_values_of(config: ReviewerConfig) -> list[str]:
    values = [config.user_id, config.passphrase, config.firebase_api_key]
    for key in ("private_key", "client_email", "private_key_id", "client_id"):
        value = config.firebase_service_account.get(key)
        if isinstance(value, str):
            values.append(value)
    return [v for v in values if v]


def format_sample(sample: TurnSample) -> str:
    server = ""
    if sample.server_elapsed_ms is not None:
        server = (
            f" server_first_visible={_ms(sample.server_first_visible_ms)}"
            f" server_first_answer_token={_ms(sample.server_first_answer_token_ms)}"
            f" server_elapsed={_ms(sample.server_elapsed_ms)}"
        )
    return (
        f"{sample.prompt_id} rep={sample.rep} first_visible={_ms(sample.client_first_visible_ms)}"
        f" first_answer_token={_ms(sample.client_first_answer_token_ms)}"
        f" total={_ms(sample.client_total_ms)} outcome={sample.outcome}"
        f" detail={sample.detail or 'none'}{server}"
    )


def _ms(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.0f}ms"


def format_summary(report: dict[str, Any]) -> list[str]:
    lines = [f"samples={report['sample_count']} outcomes={json.dumps(report['outcomes'])}"]
    for side in ("client", "server"):
        for metric, block in report["summary"][side].items():
            if not block["count"]:
                continue
            lines.append(
                f"{side}.{metric}: p50={block['p50']:.0f}ms p95={block['p95']:.0f}ms "
                f"max={block['max']:.0f}ms (n={block['count']})"
            )
    return lines


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Measure first-visible and total latency of the private agent's AG-UI chat "
            "route on localhost, as the reviewer, and optionally gate against a baseline."
        )
    )
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="Backend origin.")
    parser.add_argument("--label", default=None, help="Report label (default: UTC timestamp).")
    parser.add_argument("--reps", type=int, default=DEFAULT_REPS, help="Repetitions per prompt.")
    parser.add_argument(
        "--gap-seconds", type=float, default=DEFAULT_GAP_SECONDS, help="Pause between turns."
    )
    parser.add_argument(
        "--turn-timeout",
        type=float,
        default=DEFAULT_TURN_TIMEOUT_SECONDS,
        help="Seconds after which a turn without a terminal frame is recorded as a timeout.",
    )
    parser.add_argument(
        "--counterpart-name",
        default=DEFAULT_COUNTERPART,
        help="Name substituted into the consent-request prompt.",
    )
    parser.add_argument("--timezone", default=DEFAULT_TIMEZONE, help="IANA zone to forward.")
    parser.add_argument(
        "--server-log",
        type=Path,
        default=None,
        help=f"Backend log to tail for {SERVER_LOG_MARK} lines (matched on run= prefix).",
    )
    parser.add_argument(
        "--baseline", type=Path, default=None, help="Earlier report JSON to gate against."
    )
    parser.add_argument(
        "--artifact-dir", type=Path, default=DEFAULT_ARTIFACT_DIR, help="Report directory."
    )
    parser.add_argument("--protocol-env", default=DEFAULT_PROTOCOL_ENV, help="Backend dotenv.")
    parser.add_argument("--web-env", default=DEFAULT_WEB_ENV, help="Webapp dotenv.")
    parser.add_argument(
        "--prompt",
        action="append",
        dest="prompt_ids",
        default=None,
        help="Restrict to a prompt id (repeatable). Default: all twelve.",
    )
    return parser


def select_prompts(prompt_ids: list[str] | None) -> list[PromptCase]:
    if not prompt_ids:
        return list(PROMPTS)
    wanted = set(prompt_ids)
    unknown = wanted - {case.prompt_id for case in PROMPTS}
    if unknown:
        raise ValueError(f"Unknown prompt id(s): {', '.join(sorted(unknown))}")
    return [case for case in PROMPTS if case.prompt_id in wanted]


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        loaded = json.load(handle)
    if not isinstance(loaded, dict):
        raise ValueError(f"{path} is not a JSON object")
    return loaded


def write_report(report: dict[str, Any], *, artifact_dir: Path, label: str) -> Path:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    safe_label = re.sub(r"[^A-Za-z0-9_.-]+", "-", label).strip("-") or "run"
    path = artifact_dir / f"agent_chat_latency_{safe_label}.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.reps < 1:
        print("--reps must be at least 1")
        return 2
    try:
        prompts = select_prompts(args.prompt_ids)
    except ValueError as exc:
        print(str(exc))
        return 2
    label = args.label or datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")

    baseline: dict[str, Any] | None = None
    if args.baseline is not None:
        try:
            baseline = _load_json(args.baseline)
        except (OSError, ValueError) as exc:
            print(f"baseline unreadable: {type(exc).__name__}")
            return 2

    try:
        config = load_reviewer_config(protocol_env=args.protocol_env, web_env=args.web_env)
    except (RuntimeError, ValueError) as exc:
        # The message names a missing key, never a value.
        print(f"reviewer config: {exc}")
        return 2
    emit = Printer(secret_values_of(config))

    http = requests.Session()
    try:
        session = authenticate_reviewer(args.base_url, config=config, session=http)
    except (RuntimeError, requests.RequestException) as exc:
        emit(f"reviewer login failed: {emit.scrub(str(exc))}")
        return 2
    emit.add(session.firebase_id_token, session.vault_owner_token)
    emit(f"authenticated reviewer against {args.base_url}")

    log_start = log_offset(args.server_log) if args.server_log is not None else 0
    open_stream = make_http_stream_opener(
        args.base_url, session, http=http, turn_timeout_seconds=args.turn_timeout
    )
    emit(f"running {len(prompts)} prompt(s) x {args.reps} rep(s), gap {args.gap_seconds:.1f}s")
    samples = run_suite(
        open_stream,
        prompts,
        reps=args.reps,
        gap_seconds=args.gap_seconds,
        counterpart=args.counterpart_name,
        timezone=args.timezone,
        turn_timeout_seconds=args.turn_timeout,
        on_sample=lambda sample: emit(format_sample(sample)),
    )

    matched: int | None = None
    if args.server_log is not None:
        by_run = parse_server_turn_lines(
            read_log_since_settled(args.server_log, log_start, len(samples))
        )
        matched = attach_server_timings(samples, by_run)
        emit(f"server log: matched {matched}/{len(samples)} turn(s)")
        wrong_head = intro_head_runs(samples, by_run)
        if wrong_head:
            emit(
                f"REFUSED: {len(wrong_head)} turn(s) were answered by the intro head, not One; "
                "the vault-owner token was not accepted, so nothing here is One's latency"
            )
            return 1

    report = build_report(
        samples,
        label=label,
        base_url=args.base_url,
        reps=args.reps,
        gap_seconds=args.gap_seconds,
        server_log_matched=matched,
    )
    path = write_report(report, artifact_dir=args.artifact_dir, label=label)
    for line in format_summary(report):
        emit(line)
    emit(f"report: {path}")

    breaches = evaluate_bounds(report, baseline)
    if breaches:
        for breach in breaches:
            emit(f"BREACH: {breach}")
        return 1
    emit("bounds: ok" if baseline is None else "bounds: ok against baseline")
    return 0


if __name__ == "__main__":
    sys.exit(main())

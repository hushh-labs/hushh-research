"""Concurrent execution of generated journeys against the real Agent One tree.

Every journey enters through Agent One. That is not a convenience of the harness
-- it is the property being validated. If a surface could reach a specialist
without passing through One, the orchestration contract would be a description
rather than a constraint, and this harness would be unable to tell the
difference. So the runner has exactly one entry point, and a journey's declared
entry *surface* only changes the framing it arrives with.

Ten dimensions are recorded per journey. Each is derived from real runtime
signal -- ADK events, model requests, session state -- rather than from
instrumentation the harness injects into the code under test. A harness that
asserts on its own hooks measures itself.
"""

from __future__ import annotations

import asyncio
import time
import traceback
from collections import Counter
from dataclasses import asdict, dataclass, field
from typing import Any

from google.genai import types

from tests.agent_validation.journey import Journey
from tests.agent_validation.scripted_llm import ModelCall, ScriptedLlm, ToolLedger

APP_NAME = "agent_validation"


@dataclass
class JourneyResult:
    """Everything observed about one journey."""

    journey_id: str
    seed: int
    surface: str
    kind: str
    prompt: str
    ok: bool
    duration_ms: int

    # --- the ten recorded dimensions -------------------------------------------
    orchestration: dict[str, Any] = field(default_factory=dict)
    consent_log: dict[str, Any] = field(default_factory=dict)
    a2a: dict[str, Any] = field(default_factory=dict)
    chat: dict[str, Any] = field(default_factory=dict)
    tool_execution: dict[str, Any] = field(default_factory=dict)
    context_propagation: dict[str, Any] = field(default_factory=dict)
    grounding: dict[str, Any] = field(default_factory=dict)
    memory: dict[str, Any] = field(default_factory=dict)
    error_handling: dict[str, Any] = field(default_factory=dict)
    recovery: dict[str, Any] = field(default_factory=dict)

    failure: str | None = None
    failure_class: str | None = None


#: Tools whose execution means the consent surface was genuinely reached.
_CONSENT_TOOLS = {"ask_consent_agent"}
#: Tools that are agent-to-agent delegation rather than a local function call.
_A2A_TOOLS = {
    "ask_email_agent",
    "ask_location_agent",
    "ask_connected_systems_agent",
    "ask_consent_agent",
}
#: AgentTool-wrapped LLM specialists — delegation into a real sub-agent.
_DELEGATION_TOOLS = {"finance", "google_search"}


async def run_journey(journey: Journey, *, build_agent: Any) -> JourneyResult:
    """Drive one journey through the real tree and record what happened."""
    from google.adk.runners import Runner
    from google.adk.sessions import InMemorySessionService

    started = time.perf_counter()
    model = ScriptedLlm(script=list(journey.plan))
    ledger = ToolLedger()
    events: list[Any] = []
    failure: str | None = None
    failure_class: str | None = None

    session_service = InMemorySessionService()
    user_id = f"u-{journey.journey_id}"
    session_id = f"s-{journey.journey_id}"

    try:
        agent = build_agent(model=model)
        runner = Runner(app_name=APP_NAME, agent=agent, session_service=session_service)
        await session_service.create_session(
            app_name=APP_NAME, user_id=user_id, session_id=session_id
        )
        async for event in runner.run_async(
            user_id=user_id,
            session_id=session_id,
            new_message=types.Content(role="user", parts=[types.Part(text=journey.prompt)]),
        ):
            events.append(event)
            ledger.observe(event)
    except Exception as exc:  # noqa: BLE001 - the harness must survive any journey
        failure = f"{type(exc).__name__}: {exc}"
        failure_class = _classify(exc, journey)
        if not journey.expect_failure:
            failure = f"{failure}\n{traceback.format_exc(limit=4)}"

    duration_ms = int((time.perf_counter() - started) * 1000)
    final_text = _final_text(events)
    calls: list[ModelCall] = model.calls

    # Three ways a journey passes, and only three:
    #   * it completed;
    #   * it produced the failure it was built to inject (the point of the
    #     journey was to prove the runtime survives it, not to avoid it);
    #   * it failed in a way the production path converts into a typed,
    #     actionable error rather than an opaque 500.
    # Anything else is a genuine unhandled failure.
    ok = failure is None or bool(journey.expect_failure) or failure_class == "typed_degradation"

    session = await session_service.get_session(
        app_name=APP_NAME, user_id=user_id, session_id=session_id
    )
    state = dict(getattr(session, "state", {}) or {}) if session else {}

    return JourneyResult(
        journey_id=journey.journey_id,
        seed=journey.seed,
        surface=journey.surface,
        kind=journey.kind,
        prompt=journey.prompt,
        ok=ok,
        duration_ms=duration_ms,
        orchestration={
            "entry_point": "one",
            "root_agent": getattr(events[0], "author", None) if events else None,
            "authors": sorted(
                {str(getattr(e, "author", "")) for e in events if getattr(e, "author", None)}
            ),
            "model_calls": len(calls),
            "event_count": len(events),
            "tools_offered": list(calls[0].tools_offered) if calls else [],
            "intended_tools": list(journey.intended_tools),
        },
        consent_log={
            "consent_tools_invoked": [c for c in ledger.calls if c in _CONSENT_TOOLS],
            "reached": any(c in _CONSENT_TOOLS for c in ledger.calls),
        },
        a2a={
            "delegations": [c for c in ledger.calls if c in _A2A_TOOLS],
            # Attempted is NOT achieved. Three of One's four ask_* specialists
            # fail closed today -- `_first_party_authority` forwards the
            # invocation capability and deliberately no information-grant or
            # export refs, and nothing anywhere populates them -- so a call that
            # returns `needs_auth`/`scope_required` is a refusal, not a
            # delegation. Counting refusals as delegations produced a healthy
            # number for a capability that cannot currently work, which is the
            # exact failure this codebase refuses everywhere else.
            "delegations_succeeded": [
                name
                for name, status in ledger.statuses
                if name in _A2A_TOOLS and status.lower() in {"ok", "success", "completed"}
            ],
            "delegations_refused": [
                f"{name}={status}" for name, status in ledger.declined if name in _A2A_TOOLS
            ],
            "agent_tool_delegations": [c for c in ledger.calls if c in _DELEGATION_TOOLS],
            # Direct evidence the sub-agent's own model turn ran. A journey that
            # names `finance` but produces no sub-agent call delegated in name
            # only, and the tool ledger alone cannot tell those apart.
            "sub_agent_turns": list(model.sub_agent_calls),
            "delegation_depth": 2 if model.sub_agent_calls else 1,
        },
        chat={
            "final_text_len": len(final_text),
            "produced_answer": bool(final_text.strip()),
            "turns": len(calls),
        },
        tool_execution={
            "called": ledger.calls,
            "answered": ledger.responses,
            "unanswered": ledger.unanswered,
            "tool_errors": ledger.errors,
            "statuses": [f"{n}={s}" for n, s in ledger.statuses],
            "declined": [f"{n}={s}" for n, s in ledger.declined],
        },
        context_propagation={
            # The signature of real propagation: the model's view of the
            # conversation grows as tool results come back. A flat count across
            # multi-hop turns means results were dropped on the floor.
            "content_counts": [c.content_count for c in calls],
            "grew": len(calls) < 2 or calls[-1].content_count > calls[0].content_count,
            "system_instruction_len": calls[0].system_instruction_len if calls else 0,
            "roles_final_turn": list(calls[-1].roles) if calls else [],
        },
        grounding={
            "search_invoked": "google_search" in ledger.calls,
            "grounded_specialists": [c for c in ledger.calls if c in _DELEGATION_TOOLS],
            "tool_backed_answer": bool(ledger.responses) and bool(final_text.strip()),
        },
        memory={
            "session_state_keys": sorted(state)[:20],
            "state_written": bool(state),
        },
        error_handling={
            "raised": failure is not None,
            "expected": journey.expect_failure,
            "classified": failure_class,
            "tool_errors": ledger.errors,
        },
        recovery={
            # Did the turn still produce something usable after a tool failed?
            "answer_after_tool_error": bool(ledger.errors) and bool(final_text.strip()),
            "survived_unknown_tool": journey.kind == "unknown_tool" and failure is None,
            "completed_despite_failure": failure is not None and bool(final_text.strip()),
        },
        failure=failure,
        failure_class=failure_class,
    )


def _final_text(events: list[Any]) -> str:
    parts: list[str] = []
    for event in events:
        content = getattr(event, "content", None)
        for part in getattr(content, "parts", None) or []:
            text = getattr(part, "text", None)
            if text:
                parts.append(str(text))
    return "\n".join(parts)


def _classify(exc: Exception, journey: Journey) -> str:
    """Group a failure by its shape, so patterns surface instead of instances.

    Clustering on the exception type plus the journey kind is deliberately
    coarse: fifty distinct tracebacks that are one bug should read as one bug.
    """
    name = type(exc).__name__
    message = str(exc).lower()
    if _production_handles(exc):
        return "typed_degradation"
    if isinstance(exc, (TypeError, ValueError)) and journey.kind == "malformed_args":
        return "malformed_args_rejected"
    if "timeout" in message or name == "TimeoutError":
        return "timeout"
    if journey.kind == "model_fails_late":
        return "model_failure_after_side_effect"
    if journey.kind == "empty_response":
        return "silent_completion_rejected"
    return f"unhandled:{name}"


def _production_handles(exc: Exception) -> bool:
    """Would the real chat service turn this into a typed, actionable error?

    The harness drives the ADK ``Runner`` directly, which is deliberate -- it is
    the only way to observe orchestration without the production wrapper masking
    it. But that means a raw raise here does NOT imply a user sees a raw error.
    Grading on "did ADK raise" would therefore report failures the platform
    already handles, and -- far worse -- would keep reporting them as failures
    after they were fixed, so a real improvement would be invisible.
    """
    try:
        from hushh_mcp.services.agent_chat_service import (  # noqa: PLC0415
            _is_google_provider_runtime_error,
            _is_tool_resolution_error,
        )
    except Exception:  # noqa: BLE001 - the harness must not die classifying
        return False
    return bool(_is_tool_resolution_error(exc) or _is_google_provider_runtime_error(exc))


async def run_all(
    journeys: list[Journey], *, build_agent: Any, concurrency: int = 25
) -> list[JourneyResult]:
    """Run every journey, at most ``concurrency`` at a time.

    Bounded rather than unbounded: the point is concurrent *orchestration*, and
    an unbounded gather would mostly measure how many event loops one machine can
    thrash, which tells us nothing about the platform.
    """
    semaphore = asyncio.Semaphore(concurrency)

    async def _one(journey: Journey) -> JourneyResult:
        async with semaphore:
            return await run_journey(journey, build_agent=build_agent)

    return await asyncio.gather(*(_one(j) for j in journeys))


def summarize(results: list[JourneyResult]) -> dict[str, Any]:
    """Aggregate into the measurable signals the run is supposed to move."""
    total = len(results) or 1
    passed = [r for r in results if r.ok]
    failed = [r for r in results if not r.ok]

    tools_called = Counter()
    for result in results:
        tools_called.update(result.tool_execution.get("called") or [])

    return {
        "journeys": len(results),
        "passed": len(passed),
        "failed": len(failed),
        "pass_rate": round(100.0 * len(passed) / total, 1),
        # --- the four signals the user asked to see move ------------------------
        "orchestration_reliability": round(
            100.0 * sum(1 for r in results if not r.tool_execution.get("unanswered")) / total, 1
        ),
        "response_quality": round(
            100.0 * sum(1 for r in results if r.chat.get("produced_answer")) / total, 1
        ),
        "grounding_quality": round(
            100.0 * sum(1 for r in results if r.grounding.get("tool_backed_answer")) / total, 1
        ),
        "context_propagation": round(
            100.0 * sum(1 for r in results if r.context_propagation.get("grew")) / total, 1
        ),
        # --- dimension coverage --------------------------------------------------
        "consent_reached": sum(1 for r in results if r.consent_log.get("reached")),
        "a2a_delegations_attempted": sum(len(r.a2a.get("delegations") or []) for r in results),
        "a2a_delegations_succeeded": sum(
            len(r.a2a.get("delegations_succeeded") or []) for r in results
        ),
        "a2a_delegations_refused": sum(
            len(r.a2a.get("delegations_refused") or []) for r in results
        ),
        "agent_tool_delegations": sum(
            len(r.a2a.get("agent_tool_delegations") or []) for r in results
        ),
        "memory_state_written": sum(1 for r in results if r.memory.get("state_written")),
        "recovered_after_error": sum(
            1 for r in results if r.recovery.get("completed_despite_failure")
        ),
        "tools_exercised": dict(tools_called.most_common()),
        # Reported separately from tool_errors on purpose. A tool that declines is
        # behaving correctly, but a run where MOST tools decline is not evidence
        # the platform works -- and the two look identical in a pass rate.
        "tool_statuses": dict(
            Counter(
                status for r in results for status in (r.tool_execution.get("statuses") or [])
            ).most_common(15)
        ),
        "declined_calls": sum(len(r.tool_execution.get("declined") or []) for r in results),
        "failure_patterns": dict(Counter(r.failure_class for r in failed if r.failure_class)),
        "surfaces": dict(Counter(r.surface for r in results)),
        "kinds": dict(Counter(r.kind for r in results)),
        "p50_ms": _percentile([r.duration_ms for r in results], 50),
        "p95_ms": _percentile([r.duration_ms for r in results], 95),
    }


def _percentile(values: list[int], pct: int) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(round((pct / 100.0) * (len(ordered) - 1))))
    return ordered[index]


def failures_detail(results: list[JourneyResult], limit: int = 12) -> list[dict[str, Any]]:
    """The failing journeys, trimmed for reading and grouped by pattern."""
    out: list[dict[str, Any]] = []
    for result in results:
        if result.ok:
            continue
        record = asdict(result)
        record["failure"] = (record.get("failure") or "")[:600]
        out.append(record)
        if len(out) >= limit:
            break
    return out


__all__ = ["JourneyResult", "run_journey", "run_all", "summarize", "failures_detail", "APP_NAME"]

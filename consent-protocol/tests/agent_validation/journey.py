"""Runtime journey generation, driven by the live tool surface.

A static list of test cases is a snapshot of what someone thought the system did
on the day they wrote it. It ages silently: a tool gets added and coverage
quietly stops being coverage, with every case still green.

So journeys are *generated* here, from the tool declarations the tree actually
offers at runtime. Add a tool to Agent One and this harness starts exercising it
on the next run with no edit. Remove one and the generator stops pretending to
cover it. The generator is seeded, so a failing run is reproducible from its seed
alone -- generative and debuggable are not in tension if the seed travels with
the result.

Argument values are derived from each tool's declared JSON schema rather than
hardcoded per tool, for the same reason: a tool that grows a required parameter
should not silently keep receiving the old argument set.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any, Iterable

#: Realistic phrasings per capability, used to build the opening user message.
#: These shape the *narrative* of a journey; the tool plan is derived from the
#: live surface, so this table never decides what is reachable.
_INTENT_PHRASES: dict[str, tuple[str, ...]] = {
    "ask_email_agent": (
        "draft a reply to the message from my accountant",
        "what did my last three receipts say",
        "summarise anything urgent in my inbox",
    ),
    "ask_location_agent": (
        "share my location with my sister until 6pm",
        "where did I save home",
        "stop sharing my location with everyone",
    ),
    "ask_connected_systems_agent": (
        "link my record to the CRM my advisor uses",
        "which systems can see my information",
        "disconnect the system I linked last week",
    ),
    "ask_consent_agent": (
        "who has access to my holdings right now",
        "revoke everything I approved last month",
        "explain what I agreed to share",
    ),
    "finance": (
        "should I hold or reduce my position",
        "how did my portfolio move this week",
        "what is my largest concentration risk",
    ),
    "google_search": (
        "what happened in the markets today",
        "look up the latest on that filing",
    ),
    "open_screen": (
        "take me to my dashboard",
        "open my consent center",
    ),
    "run_app_action": (
        "run the analysis on NVDA",
        "do that for my portfolio",
    ),
    "list_app_actions": (
        "what can you do from here",
        "what are my options on this screen",
    ),
    "start_app_goal": ("walk me through setting this up",),
    "continue_app_goal": ("carry on with what we started",),
    "resolve_onboarding_goal": ("help me finish setting up",),
}

#: Journeys that exist to break things rather than to succeed.
EDGE_KINDS = (
    "unknown_tool",       # the model names a tool that does not exist
    "malformed_args",     # right tool, wrong argument shape
    "model_fails_late",   # model raises AFTER a tool already ran
    "empty_response",     # model returns nothing at all
    "tool_storm",         # many tools in one turn
    "deep_delegation",    # specialist chain, not a single hop
)

#: Where a request enters the platform. Agent One is the entry point for all of
#: them -- that is the property under test, not an assumption baked into the
#: generator.
ENTRY_SURFACES = ("user_chat", "voice_action", "external_a2a", "scheduled_nudge")


@dataclass
class Journey:
    """One generated interaction, start to finish."""

    journey_id: str
    seed: int
    surface: str
    kind: str
    prompt: str
    #: The scripted plan: tool calls then a final text, or an injected failure.
    plan: list[Any] = field(default_factory=list)
    #: Tools this journey intends to reach; used to score coverage honestly.
    intended_tools: tuple[str, ...] = ()
    expect_failure: bool = False
    notes: str = ""


def _sample_arg(name: str, schema: dict[str, Any], rng: random.Random) -> Any:
    """A plausible value for one declared parameter.

    Derived from the schema so a tool that grows a parameter is supplied one
    automatically. Falls back to a string, which is what most of this surface
    takes, rather than raising -- a generator that dies on an unfamiliar type
    would stop covering everything else in the run.
    """
    enum = schema.get("enum")
    if enum:
        return rng.choice(list(enum))
    kind = (schema.get("type") or "string").lower()
    if kind in ("integer", "number"):
        return rng.choice([0, 1, 7])
    if kind == "boolean":
        return rng.choice([True, False])
    if kind == "array":
        return []
    if kind == "object":
        # `slots` is the real shape here: action inputs keyed by name.
        return {"symbol": rng.choice(["NVDA", "AAPL", "MSFT"])} if name == "slots" else {}
    if name == "screen":
        return rng.choice(["one_dashboard", "one_consent", "one_feed"])
    if name == "action_id":
        return rng.choice(["one.open_dashboard", "kai.analyze_symbol", "one.unknown_action"])
    if name in ("request", "query"):
        return rng.choice(("what is my current position", "summarise this for me"))
    return "harness"


def _args_for(declaration: dict[str, Any], rng: random.Random) -> dict[str, Any]:
    params = (declaration.get("parameters") or {}).get("properties") or {}
    required = set((declaration.get("parameters") or {}).get("required") or [])
    args: dict[str, Any] = {}
    for name, schema in params.items():
        # Always supply required params; supply optional ones sometimes, so the
        # run covers both the minimal and the fuller call shape.
        if name in required or rng.random() < 0.5:
            args[name] = _sample_arg(name, schema if isinstance(schema, dict) else {}, rng)
    return args


def generate(
    *,
    surface_tools: dict[str, dict[str, Any]],
    count: int,
    seed: int,
    edge_fraction: float = 0.3,
) -> list[Journey]:
    """Compose ``count`` journeys from the live tool surface.

    ``surface_tools`` maps tool name -> its declared JSON schema, read from the
    real agent at runtime. Every tool present gets exercised before any tool is
    repeated, so coverage is a property of the generator rather than a hope.
    """
    # noqa S311: this picks test data, not key material. A seeded generator is a
    # REQUIREMENT here -- a failing run has to be reproducible from its seed
    # alone, and `secrets` is unseedable by design, so the "secure" alternative
    # would make every generative failure impossible to reproduce.
    rng = random.Random(seed)  # noqa: S311
    names = sorted(surface_tools)
    if not names:
        raise ValueError("no tools on the surface — the tree failed to build, which is itself the finding")

    journeys: list[Journey] = []
    # Round-robin the tool list so every tool is hit before any repeats.
    ordered = list(names)
    rng.shuffle(ordered)

    for index in range(count):
        jseed = seed * 1000 + index
        jrng = random.Random(jseed)  # noqa: S311 - see the note on `rng` above
        primary = ordered[index % len(ordered)]
        surface = ENTRY_SURFACES[index % len(ENTRY_SURFACES)]
        phrases = _INTENT_PHRASES.get(primary, (f"help me with {primary.replace('_', ' ')}",))
        prompt = jrng.choice(phrases)

        is_edge = jrng.random() < edge_fraction
        if is_edge:
            journeys.append(
                _edge_journey(
                    index=index, seed=jseed, rng=jrng, surface=surface,
                    primary=primary, prompt=prompt, surface_tools=surface_tools,
                )
            )
            continue

        # A happy path: one to three real tool calls, then an answer.
        hops = jrng.choice([1, 1, 2, 3])
        chosen = [primary] + [jrng.choice(names) for _ in range(hops - 1)]
        plan: list[Any] = [(name, _args_for(surface_tools[name], jrng)) for name in chosen]
        plan.append(f"Here is what I found about {prompt}.")
        journeys.append(
            Journey(
                journey_id=f"j{index:03d}",
                seed=jseed,
                surface=surface,
                kind="happy_path",
                prompt=prompt,
                plan=plan,
                intended_tools=tuple(chosen),
                notes=f"{hops}-hop orchestration entered from {surface}",
            )
        )

    return journeys


def _edge_journey(
    *,
    index: int,
    seed: int,
    rng: random.Random,
    surface: str,
    primary: str,
    prompt: str,
    surface_tools: dict[str, dict[str, Any]],
) -> Journey:
    kind = rng.choice(EDGE_KINDS)
    good = (primary, _args_for(surface_tools[primary], rng))

    if kind == "unknown_tool":
        plan: list[Any] = [("tool_that_does_not_exist", {"request": prompt}), "Recovered."]
        notes = "model names a tool the tree never declared; the runtime must not crash"
    elif kind == "malformed_args":
        plan = [(primary, {"totally_wrong_parameter": ["nested", {"junk": True}]}), "Recovered."]
        notes = "right tool, wrong argument shape — validation must reject cleanly"
    elif kind == "model_fails_late":
        plan = [good, RuntimeError("model failed after a tool already ran")]
        notes = "failure AFTER an observable side effect — the hard half of recovery"
    elif kind == "empty_response":
        plan = [""]
        notes = "silent completion; the runtime rejects this deliberately"
    elif kind == "tool_storm":
        names = sorted(surface_tools)
        plan = [(rng.choice(names), _args_for(surface_tools[rng.choice(names)], rng)) for _ in range(6)]
        plan.append("Finished a long chain.")
        notes = "six hops in one turn — bounds and budget behaviour"
    else:  # deep_delegation
        plan = [("finance", {"request": prompt}) if "finance" in surface_tools else good, "Delegated."]
        notes = "AgentTool delegation into a sub-agent, not a flat function call"

    return Journey(
        journey_id=f"j{index:03d}",
        seed=seed,
        surface=surface,
        kind=kind,
        prompt=prompt,
        plan=plan,
        intended_tools=(primary,),
        expect_failure=kind in ("model_fails_late", "empty_response"),
        notes=notes,
    )


def coverage(journeys: Iterable[Journey], surface_tools: Iterable[str]) -> dict[str, Any]:
    """Which of the live tools this batch of journeys actually intends to reach."""
    intended: set[str] = set()
    for journey in journeys:
        intended.update(journey.intended_tools)
    available = set(surface_tools)
    return {
        "tools_available": len(available),
        "tools_intended": len(intended & available),
        "uncovered": sorted(available - intended),
        "percent": round(100.0 * len(intended & available) / max(1, len(available)), 1),
    }


__all__ = ["Journey", "generate", "coverage", "EDGE_KINDS", "ENTRY_SURFACES"]

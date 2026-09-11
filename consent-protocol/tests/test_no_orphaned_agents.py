"""Registration is not reachability, and this gate is what makes that checkable.

Ten disconnections have now been found the same way in this repo, each one a
component that passed its own tests and had never executed on any real path:

    pod provisioning (all 7 flags present) · heal_pod (3 tests, each passing an
    explicit client=) · reconcile retry (the test's stub shaped to the broken call)
    · A2A delegation (33 attempts counted, 0 succeeded) · liveness sweep (zero
    callers) · registry currency (a drift test never in the CI manifest) · pod
    memory (a memory_service resolved and passed to the Runner that nothing ever
    writes to) · the provision route (typed so a browser could not call it) ·
    runPodTurn (complete, correct, zero callers) · the status chip (polling
    without an Authorization header)

The shared shape: **a test written against a call site rather than against the
callee passes for exactly as long as both are wrong together.** No existing gate
can fail on "nothing calls this", which is why 2,010 passing tests coexisted with
zero pods running.

This test asserts the one thing metadata cannot satisfy: that every agent the
dispatch registry accepts is actually reachable from something a person can reach.
It is deliberately a DECLARED ledger rather than a bare pass/fail -- an entry that
becomes reachable fails just as loudly as one that goes dark, so the list cannot
quietly go stale the way a hand-maintained roster does.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_AGENT_TREE = Path(__file__).resolve().parents[1] / "hushh_mcp" / "one_adk" / "agent_tree.py"

# Registered, but reachable from NO One roster tool. Each entry needs a reason and
# an owner decision, not a shrug -- an agent nobody can call is either a capability
# that was never finished or a registration that should be removed.
_KNOWN_UNREACHABLE_FROM_ONE: dict[str, str] = {
    "agent_personal_information": (
        "Reachable only via its own route POST /api/one/information/chat, and "
        "explicitly rejected by Agent Chat. Registered for a dispatch path that no "
        "roster tool takes. RESOLVED (founder, 2026-08-11): the agent architecture is "
        "preserved as-is and we build forward from it, so this registration stays and "
        "the missing roster tool is work to be done -- not a registration to remove."
    ),
}


def _specialist_ids_reached_by_roster_tools() -> set[str]:
    """Agent ids passed to `_specialist_turn` as a literal, read from the AST.

    Read rather than imported: importing the tree needs Vertex ADC, which a CI box
    does not have, and a reachability check that cannot run in CI is the same class
    of problem it exists to catch.

    Dynamic call sites (`_specialist_turn(agent_id, ...)`, where the id is chosen at
    runtime) are handled by `_dynamic_specialist_targets` below -- counting only
    literals would under-report and make this gate lie in the safe direction, which
    is still lying.
    """
    tree = ast.parse(_AGENT_TREE.read_text())
    found: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = getattr(func, "id", None) or getattr(func, "attr", None)
        if name != "_specialist_turn" or not node.args:
            continue
        first = node.args[0]
        if isinstance(first, ast.Constant) and isinstance(first.value, str):
            found.add(first.value)
    return found


def _dynamic_specialist_targets() -> set[str]:
    """Agent ids reachable through a runtime-selected dispatch.

    `ask_consent_agent` picks between two ids from its `target` argument, so neither
    appears as a literal at the `_specialist_turn` call. They are still reachable,
    and a gate that missed them would demand work that is already done.
    """
    tree = ast.parse(_AGENT_TREE.read_text())
    found: set[str] = set()
    for node in ast.walk(tree):
        # Any `"agent_x"` string literal appearing inside a function that also calls
        # `_specialist_turn` is a candidate target for that dispatch.
        if not isinstance(node, ast.AsyncFunctionDef | ast.FunctionDef):
            continue
        calls_dispatch = any(
            isinstance(inner, ast.Call)
            and (getattr(inner.func, "id", None) or getattr(inner.func, "attr", None))
            == "_specialist_turn"
            for inner in ast.walk(node)
        )
        if not calls_dispatch:
            continue
        for inner in ast.walk(node):
            if isinstance(inner, ast.Constant) and isinstance(inner.value, str):
                if inner.value.startswith("agent_"):
                    found.add(inner.value)
    return found


def _registered_specialist_ids() -> set[str]:
    import hushh_mcp.adk_bridge  # noqa: F401,PLC0415 - side-effect registration
    from hushh_mcp.adk_bridge.dispatch import _REGISTRY  # noqa: PLC0415

    return set(_REGISTRY)


def test_every_registered_agent_is_reachable_or_declared() -> None:
    """The gate that would have caught seven of the ten.

    A registered agent that nothing routes to is invisible to every other check in
    this repo: it imports, it registers, its handler has tests, and no request ever
    arrives. That is exactly the state `agent_connected_systems` and
    `agent_connections` were in while their handlers were fully implemented.
    """
    registered = _registered_specialist_ids()
    reachable = _specialist_ids_reached_by_roster_tools() | _dynamic_specialist_targets()

    orphaned = sorted(registered - reachable - set(_KNOWN_UNREACHABLE_FROM_ONE))
    assert orphaned == [], (
        f"registered for dispatch but reachable from no One roster tool: {orphaned}. "
        "Either bind a tool, or remove the registration, or add it to "
        "_KNOWN_UNREACHABLE_FROM_ONE with the reason and the open decision. "
        "Registering an agent nobody can call is how this codebase has repeatedly "
        "shipped a capability that never ran."
    )


def test_the_unreachable_ledger_cannot_go_stale() -> None:
    """An entry that becomes reachable must fail too.

    A hand-maintained list of what is broken decays exactly like a hand-maintained
    list of what exists -- the `/health` roster literal that reported four agents
    from a pod running none. This half is what keeps the ledger honest in both
    directions.
    """
    reachable = _specialist_ids_reached_by_roster_tools() | _dynamic_specialist_targets()
    now_reachable = sorted(set(_KNOWN_UNREACHABLE_FROM_ONE) & reachable)
    assert now_reachable == [], (
        f"listed as unreachable but a roster tool now reaches it: {now_reachable}. "
        "Remove it from _KNOWN_UNREACHABLE_FROM_ONE — the capability shipped."
    )

    registered = _registered_specialist_ids()
    never_registered = sorted(set(_KNOWN_UNREACHABLE_FROM_ONE) - registered)
    assert never_registered == [], (
        f"listed as unreachable but not registered at all: {never_registered}. "
        "The entry is describing something that no longer exists."
    )


def test_the_probe_itself_finds_the_known_reachable_agents() -> None:
    """A reachability probe that finds nothing would pass this file silently.

    This is the negative control. If the AST walk breaks -- a refactor renames
    `_specialist_turn`, or the tools move to another module -- `reachable` goes empty,
    every registered agent looks orphaned, and the assertion above would fail loudly.
    But if someone then "fixed" it by widening the allowlist, the gate would be dead.
    Pin the agents we KNOW are reachable so the probe cannot silently stop working.
    """
    reachable = _specialist_ids_reached_by_roster_tools() | _dynamic_specialist_targets()
    for agent_id in ("agent_email", "agent_location", "agent_connected_systems", "agent_nav"):
        assert agent_id in reachable, (
            f"{agent_id} is bound to a One roster tool but the reachability probe did "
            "not find it — the probe is broken, not the wiring"
        )

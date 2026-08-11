"""Memory that is resolved but never written to, and never readable, is not memory.

This is the seventh time a component in this repo passed every test it had and had
never executed — and the second time on this exact subsystem.

The first pass wired `memory_service=_resolve_pod_memory_service()` into the Runner
and I reported persistent pod memory as working. It was not. ADK does **not**
auto-populate a memory service; something has to call `add_session_to_memory`, and
nothing did. There was also no memory tool in One's roster, so nothing could read it
either. The sealed commit log, the per-owner derived key and the hydrate-on-first-use
replay were all real, all tested, and a pod forgot everything anyway.

The lesson the repo already wrote down, applied to itself: assert the CALL, not the
components. Every test here fails if the join is removed, and none of them can be
satisfied by the machinery merely existing.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_ONE_ADK = Path(__file__).resolve().parents[1] / "hushh_mcp" / "one_adk"
_TEXT_RUNTIME = _ONE_ADK / "text_runtime.py"
_AGENT_TREE = _ONE_ADK / "agent_tree.py"


def _awaited_method_names(source: Path) -> set[str]:
    """Every method name this module actually awaits, read from the AST."""
    names: set[str] = set()
    for node in ast.walk(ast.parse(source.read_text())):
        if isinstance(node, ast.Await) and isinstance(node.value, ast.Call):
            attr = getattr(node.value.func, "attr", None)
            if attr:
                names.add(attr)
    return names


def test_the_turn_actually_writes_to_memory() -> None:
    """The defect, stated directly.

    Passing a memory service to the Runner reads as "memory is wired" and is not.
    A pod that never writes has an empty store to hydrate forever, so the replay
    machinery runs correctly over nothing.
    """
    assert "add_session_to_memory" in _awaited_method_names(_TEXT_RUNTIME), (
        "no code path awaits add_session_to_memory — the memory service is resolved, "
        "handed to the Runner, and never written to, which is exactly the state this "
        "subsystem was already found in once"
    )


def test_a_memory_tool_is_bound_so_the_agent_can_read_it() -> None:
    """Writing without reading is a log nobody consults.

    `load_memory` rather than `preload_memory` on purpose: the north star requires
    that "the agent evolved" be an assertion rather than a vibe, and that only an
    observed recall TOOL CALL proves it — a model can produce a plausible answer by
    guessing. Auto-injection would make the claim unfalsifiable.
    """
    source = _AGENT_TREE.read_text()
    assert "load_memory" in source, (
        "One holds no memory tool, so nothing can read what the turn writes"
    )


def test_the_memory_tool_is_pod_conditional() -> None:
    """A memory tool with no service behind it is a tool that always fails.

    `resolve_pod_memory_service` returns None on the hub by construction, so binding
    the tool unconditionally would make One offer to recall and then error — worse
    than not offering. The binding must sit behind the same two conditions the
    service itself checks.
    """
    source = _AGENT_TREE.read_text()
    guard = source.find("if pod_mode() and pod_agent_memory_enabled():")
    assert guard != -1, (
        "no pod-mode + memory-enabled guard exists, so the memory tool is bound "
        "unconditionally and would always fail on the hub"
    )
    # The IMPORT of the tool, not the prose about it -- searching from the top would
    # match the comment above the guard and pass while the binding sat outside it.
    binding = source.find("from google.adk.tools import load_memory")
    assert binding != -1
    assert guard < binding, "load_memory is imported outside the guard that gates it"
    assert binding - guard < 400, (
        "the guard and the binding have drifted apart; a branch between them could "
        "reach the binding without the guard holding"
    )


def test_the_write_is_guarded_so_a_memory_failure_cannot_lose_an_answer() -> None:
    """By the time the turn commits, the person already has their answer.

    Raising here would take a delivered answer away to report a bookkeeping problem.
    Memory must degrade to a memoryless turn, never to a failed one.
    """
    source = _TEXT_RUNTIME.read_text()
    index = source.find("add_session_to_memory")
    assert index != -1
    window = source[max(0, index - 700) : index + 500]
    assert "try:" in window and "except" in window, (
        "the memory write is unguarded — a storage hiccup would fail a turn whose "
        "answer was already produced"
    )


def test_the_write_happens_after_the_empty_response_guard() -> None:
    """A turn that produced nothing visible is not an interaction worth remembering.

    Writing it would fill an owner's sealed log with failures that never reached
    them, and those replay on every future cold start.
    """
    source = _TEXT_RUNTIME.read_text()
    empty_guard = source.find("OneTextEmptyResponseError(")
    write = source.find("add_session_to_memory")
    assert empty_guard != -1 and write != -1
    assert empty_guard < write, (
        "memory is written before the empty-response guard, so failed turns would be "
        "committed to the owner's durable log"
    )

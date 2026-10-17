"""Import-safe synthetic context contracts for first-tool evaluation.

These fixtures qualify selection experiments; they never execute tools or
supply an authenticated owner's information or connector access.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Case:
    id: str
    family: str
    prompt: str
    expected: tuple[str, ...]
    screen: str | None = None
    runtime_context: str = "empty"


class _EmptyReadonlyContext:
    """Stub ReadonlyContext with empty state: the runtime instruction's neutral shape."""

    state: dict[str, Any] = {}


def parse_case(raw: Any, position: int) -> Case:
    if not isinstance(raw, dict):
        raise ValueError(f"case #{position} is not an object")
    case_id = raw.get("id")
    family = raw.get("family")
    prompt = raw.get("prompt")
    expected = raw.get("expected")
    screen = raw.get("screen")
    runtime_context = raw.get("runtime_context", "empty")
    if not isinstance(case_id, str) or not case_id.strip():
        raise ValueError(f"case #{position} has no id")
    if not isinstance(family, str) or not family.strip():
        raise ValueError(f"case {case_id!r} has no family")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError(f"case {case_id!r} has no prompt")
    if (
        not isinstance(expected, list)
        or not expected
        or not all(isinstance(item, str) and item.strip() for item in expected)
    ):
        raise ValueError(f"case {case_id!r} needs a non-empty expected list of strings")
    if screen is not None and not isinstance(screen, str):
        raise ValueError(f"case {case_id!r} screen must be a string")
    if runtime_context not in ("empty", "typed_chat"):
        raise ValueError(f"case {case_id!r} has an unsupported runtime context")
    return Case(
        id=case_id,
        family=family,
        prompt=prompt,
        expected=tuple(dict.fromkeys(expected)),
        screen=screen or None,
        runtime_context=runtime_context,
    )


def compose_instruction(tree: Any, runtime_context: str = "empty") -> str:
    context = _EmptyReadonlyContext()
    if runtime_context == "typed_chat":
        context.state = {
            tree.STATE_EXECUTION_SURFACE: "typed_chat",
            tree.STATE_USER_ID: "synthetic-first-tool-evaluation",
        }
    elif runtime_context != "empty":
        raise ValueError("unsupported runtime context")
    return str(tree._one_runtime_instruction(context))


def instruction_overrides(
    cases: Sequence[Case], *, custom: bool, compose: Callable[[str], str]
) -> dict[str, str]:
    if custom:
        return {}
    return {
        case.id: compose(case.runtime_context) for case in cases if case.runtime_context != "empty"
    }


def admitted_instructions(
    cases: Sequence[Case], instruction: str, overrides: dict[str, str] | None
) -> dict[str, str]:
    instructions = {case.id: (overrides or {}).get(case.id, instruction) for case in cases}
    # An inadmissible expected tool is an invalid experiment, not a model miss.
    for case in cases:
        composed = instructions[case.id]
        forbidden: set[str] = set()
        if "MAIL READ ADMISSION: disabled." in composed:
            forbidden.add("ask_email_agent")
        if "DRIVE READ ADMISSION: disabled." in composed:
            forbidden.update(("ask_documents_agent", "inspect_selected_drive_files"))
        if all(tool in forbidden for tool in case.expected):
            raise ValueError(f"case {case.id!r} expects a tool forbidden by its runtime context")
    return instructions


def instruction_fingerprints(
    cases: Sequence[Case], instruction: str, overrides: dict[str, str], *, custom: bool
) -> dict[str, dict[str, str]]:
    return {
        case.id: {
            "runtime_context": "custom_instruction" if custom else case.runtime_context,
            "sha256": hashlib.sha256(overrides.get(case.id, instruction).encode()).hexdigest(),
        }
        for case in cases
    }

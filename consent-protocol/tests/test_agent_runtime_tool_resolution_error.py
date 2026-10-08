"""A hallucinated tool name is a typed failure, not a 500.

Found by the agent validation harness (``scripts/ops/validate_agent_platform.py``):
a generated journey scripted the model to call a tool the tree never declared --
ordinary LLM behaviour whenever the model's tool memory drifts from the roster --
and the turn died with a bare ``ValueError``.

That mattered because of the company it kept. Every other failure on this path
already carried an ``AGENT_RUNTIME_*`` code the client can render and recover
from: empty response, credential invalid, model unavailable, transport invalid.
Tool resolution was the one hole, and it was invisible precisely because ADK
raises a builtin ``ValueError`` whose module is ``builtins`` -- so the
provider-error check, which matches on a ``google.`` module prefix, could never
have caught it.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.agent_chat_service import (
    _is_google_provider_runtime_error,
    _is_tool_resolution_error,
)


class _FakeGoogleError(Exception):
    __module__ = "google.genai.errors"


def test_adk_tool_not_found_is_recognised():
    # The exact shape ADK raises when the model names an undeclared tool.
    assert _is_tool_resolution_error(ValueError("Tool 'ask_consent_agent' not found."))


def test_recognises_regardless_of_case():
    assert _is_tool_resolution_error(ValueError("TOOL 'x' NOT FOUND"))


@pytest.mark.parametrize(
    "error",
    [
        ValueError("Google search tool is not supported for model scripted"),
        ValueError("consent token not found"),
        ValueError("user not found"),
        RuntimeError("Tool 'x' not found."),  # right words, wrong type
        TypeError("missing required argument"),
    ],
)
def test_does_not_swallow_unrelated_failures(error):
    """The classifier must stay narrow.

    Widening it would convert unrelated bugs into a friendly message, which is
    how a real defect gets a reassuring error code and stops being investigated.
    Note the first case in particular: it contains the word "tool" and the word
    "not", and is a completely different failure.
    """
    assert not _is_tool_resolution_error(error)


def test_provider_check_could_never_have_caught_it():
    """Pins WHY the hole existed, so the fix is not later 'simplified' away.

    ``ValueError`` is a builtin: its module is ``builtins``, never ``google.``.
    A reader who assumes the provider check already covers ADK failures would
    delete the new classifier as redundant. It is not redundant, and this test
    is the argument.
    """
    adk_style = ValueError("Tool 'x' not found.")
    assert adk_style.__class__.__module__ == "builtins"
    assert not _is_google_provider_runtime_error(adk_style)
    # ...while a genuine provider error still is caught by the old path.
    assert _is_google_provider_runtime_error(_FakeGoogleError("boom"))

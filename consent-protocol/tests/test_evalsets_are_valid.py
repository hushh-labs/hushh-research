"""Offline shape checks for the ADK EvalSets under tests/evalsets.

The EvalSets are the standard trajectory metric beside the first-tool KPI
harness (scripts/eval_one_first_tool.py, cases in
scripts/eval_cases/one_first_tool.v1.json). Running them for real needs a
model and ADC (see tests/evalsets/README.md), so this module only proves the
records are well formed: pydantic-loadable, unique ids, every expected tool
present on the private agent's built roster, a threshold the evaluator will
honour, and no drift from the harness's own consent family.
"""

from __future__ import annotations

import json
import warnings
from functools import lru_cache
from pathlib import Path

import pytest
from google.adk.evaluation.eval_case import EvalCase, Invocation, get_all_tool_calls
from google.adk.evaluation.eval_config import EvalConfig, get_eval_metrics_from_config
from google.adk.evaluation.eval_set import EvalSet

TESTS_DIR = Path(__file__).resolve().parent
EVALSETS_DIR = TESTS_DIR / "evalsets"
EVALSET_PATHS = sorted(EVALSETS_DIR.glob("*.evalset.json"))
TEST_CONFIG_PATH = EVALSETS_DIR / "test_config.json"
CONSENT_EVALSET_PATH = EVALSETS_DIR / "one_consent.evalset.json"

TRAJECTORY_METRIC = "tool_trajectory_avg_score"
ACTION_TOOL = "run_app_action"
HARNESS_FAMILY = "consent"


def _load_eval_set(path: Path) -> EvalSet:
    return EvalSet.model_validate(json.loads(path.read_text(encoding="utf-8")))


def _single_invocation(case: EvalCase) -> Invocation:
    """The one user turn every case here carries; a scenario case is a named failure."""
    assert case.conversation is not None, f"{case.eval_id}: expected a conversation, not a scenario"
    assert len(case.conversation) == 1, f"{case.eval_id}: the KPI is a single turn"
    return case.conversation[0]


def _question(case: EvalCase) -> str:
    parts = _single_invocation(case).user_content.parts
    assert parts and parts[0].text, f"{case.eval_id}: user turn carries no text"
    return parts[0].text


@lru_cache(maxsize=1)
def _one_roster_tool_names() -> frozenset[str]:
    """Tool names on the private agent's full text head, built offline under TESTING."""
    from hushh_mcp.one_adk.agent_tree import build_one_text_agent

    agent = build_one_text_agent()
    return frozenset(
        getattr(tool, "name", getattr(tool, "__name__", type(tool).__name__))
        for tool in agent.tools
    )


@lru_cache(maxsize=1)
def _harness_cases() -> dict[str, frozenset[str | None]]:
    """The harness's consent family: prompt -> accepted first tools (None for no tool).

    The harness module builds its model client inside a function, so the import
    is offline. It also installs a blanket warnings filter at import time;
    catch_warnings restores this process's filters afterwards.
    """
    with warnings.catch_warnings():
        from scripts.eval_one_first_tool import NO_TOOL, load_cases, select_cases

    cases = select_cases(load_cases(), [HARNESS_FAMILY])
    assert cases, f"harness fixture has no {HARNESS_FAMILY!r} family"
    return {
        case.prompt: frozenset(None if tool == NO_TOOL else tool for tool in case.expected)
        for case in cases
    }


def _expected_first_tool(case: EvalCase) -> str | None:
    """The harness KPI: the first tool of the single invocation, or None for no tool."""
    calls = get_all_tool_calls(_single_invocation(case).intermediate_data)
    if not calls:
        return None
    first = calls[0]
    if first.name == ACTION_TOOL:
        return f"{ACTION_TOOL}:{(first.args or {}).get('action_id')}"
    return first.name


def test_evalsets_directory_holds_at_least_one_evalset() -> None:
    assert EVALSET_PATHS, f"no *.evalset.json under {EVALSETS_DIR}"


@pytest.mark.parametrize("path", EVALSET_PATHS, ids=lambda p: p.name)
def test_evalset_loads_through_pydantic(path: Path) -> None:
    eval_set = _load_eval_set(path)
    assert eval_set.eval_set_id
    assert eval_set.eval_cases, "an EvalSet with no cases measures nothing"


@pytest.mark.parametrize("path", EVALSET_PATHS, ids=lambda p: p.name)
def test_eval_case_ids_are_unique(path: Path) -> None:
    ids = [case.eval_id for case in _load_eval_set(path).eval_cases]
    assert len(ids) == len(set(ids)), f"duplicate eval ids in {path.name}"


@pytest.mark.parametrize("path", EVALSET_PATHS, ids=lambda p: p.name)
def test_every_case_is_one_user_invocation(path: Path) -> None:
    for case in _load_eval_set(path).eval_cases:
        invocation = _single_invocation(case)
        assert invocation.user_content.role == "user", case.eval_id
        assert _question(case)


@pytest.mark.parametrize("path", EVALSET_PATHS, ids=lambda p: p.name)
def test_every_expected_tool_exists_on_one_roster(path: Path) -> None:
    roster = _one_roster_tool_names()
    assert ACTION_TOOL in roster
    for case in _load_eval_set(path).eval_cases:
        for call in get_all_tool_calls(_single_invocation(case).intermediate_data):
            assert call.name in roster, f"{case.eval_id}: {call.name} is not on One's roster"
            if call.name != ACTION_TOOL:
                continue
            action_id = (call.args or {}).get("action_id")
            assert isinstance(action_id, str) and action_id, (
                f"{case.eval_id}: {ACTION_TOOL} needs a string action_id"
            )


def test_test_config_sets_a_trajectory_threshold() -> None:
    config = EvalConfig.model_validate_json(TEST_CONFIG_PATH.read_text(encoding="utf-8"))
    assert TRAJECTORY_METRIC in config.criteria
    metric = next(
        m for m in get_eval_metrics_from_config(config) if m.metric_name == TRAJECTORY_METRIC
    )
    assert metric.threshold == 1.0, "a first-tool miss must fail the case outright"


def test_consent_evalset_mirrors_the_kpi_harness() -> None:
    """Each harness consent prompt is present once, with a trajectory the harness accepts."""
    cases = _load_eval_set(CONSENT_EVALSET_PATH).eval_cases
    by_question = {_question(case): case for case in cases}
    assert len(by_question) == len(cases), "a prompt appears twice in the EvalSet"
    harness = _harness_cases()
    assert set(by_question) == set(harness), (
        f"EvalSet prompts drifted from the harness fixture: "
        f"missing={sorted(set(harness) - set(by_question))} "
        f"extra={sorted(set(by_question) - set(harness))}"
    )
    for question, accepted in harness.items():
        case = by_question[question]
        expected = _expected_first_tool(case)
        assert expected in accepted, (
            f"{case.eval_id}: expects {expected!r}, harness accepts {sorted(map(str, accepted))}"
        )

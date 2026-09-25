"""Offline guard for the first-tool harness: fixture shape, roster truth, scoring math.

No model is called. The roster is built under TESTING=1 (tests/conftest.py sets
it), so every expected tool name is checked against what the private agent
actually offers, and every run_app_action id against the generated gateway.
"""

from __future__ import annotations

import json
import subprocess
import sys
from collections import Counter
from pathlib import Path
from types import SimpleNamespace

import pytest
from google.adk.tools.function_tool import FunctionTool

from scripts import eval_one_consent_tool_selection as wrapper
from scripts import eval_one_first_tool as harness

CONSENT_PROTOCOL_ROOT = Path(__file__).resolve().parents[2]

FAMILY_MINIMUMS = {
    "consent": 18,
    "location": 7,
    "email": 5,
    "finance": 6,
    "memory": 3,
    "general": 5,
    "delegation": 4,
    "calendar": 3,
    "drive": 2,
}
ORIGINAL_CONSENT_PROMPTS = [
    "is there anything waiting for me to approve",
    "who can see my information right now",
    "what am I sharing with Sarah",
    "does anyone still have my address",
    "what did I ask Jhumma for",
    "what could I ask Dev for",
    "can we request finance information from Sharu Khan",
    "stop sharing my finances with my advisor",
    "revoke what I gave Dev last week",
    "cancel the request I sent this morning",
    "say no to Sarah's request",
    "how does sharing my information actually work",
    "add Alice to my trusted people",
]


@pytest.fixture(scope="module")
def cases() -> list[harness.Case]:
    return harness.load_cases()


@pytest.fixture(scope="module")
def roster_names() -> set[str]:
    return set(harness.roster_tool_names())


@pytest.fixture(scope="module")
def gateway_ids() -> set[str]:
    return harness.gateway_action_ids()


# ---------------------------------------------------------------------------
# Fixture shape
# ---------------------------------------------------------------------------


def test_fixture_declares_schema_version():
    payload = json.loads(harness.DEFAULT_CASES_PATH.read_text(encoding="utf-8"))
    assert payload["schema_version"] == harness.SCHEMA_VERSION == "one.first_tool_evals.v1"


def test_fixture_ids_unique_and_at_least_forty(cases):
    ids = [case.id for case in cases]
    assert len(ids) == len(set(ids))
    assert len(cases) >= 46


def test_every_family_present_with_minimum_count(cases):
    counts = Counter(case.family for case in cases)
    for family, minimum in FAMILY_MINIMUMS.items():
        assert counts[family] >= minimum, f"{family}: {counts[family]} < {minimum}"


def test_consent_family_carries_the_original_thirteen_verbatim(cases):
    prompts = [case.prompt for case in cases if case.family == "consent"]
    assert prompts[:13] == ORIGINAL_CONSENT_PROMPTS
    assert len(prompts) >= 18


def test_load_rejects_duplicate_ids(tmp_path):
    payload = {
        "schema_version": harness.SCHEMA_VERSION,
        "cases": [
            {"id": "x", "family": "f", "prompt": "p", "expected": ["no_tool"]},
            {"id": "x", "family": "f", "prompt": "q", "expected": ["no_tool"]},
        ],
    }
    path = tmp_path / "dupe.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError, match="duplicate"):
        harness.load_cases(path)


def test_load_rejects_wrong_schema_version(tmp_path):
    path = tmp_path / "old.json"
    path.write_text(json.dumps({"schema_version": "v0", "cases": []}), encoding="utf-8")
    with pytest.raises(ValueError, match="schema_version"):
        harness.load_cases(path)


# ---------------------------------------------------------------------------
# Roster truth
# ---------------------------------------------------------------------------


def test_roster_is_the_production_roster(roster_names):
    assert len(roster_names) >= 40
    assert {"run_app_action", "ask_consent_agent", "google_search", "finance"} <= roster_names
    assert {"discover_workspace_tools", "read_workspace_tool"} <= roster_names
    assert {"discover_google_drive_tools", "read_google_drive"}.isdisjoint(roster_names)


def test_drive_email_first_tool_must_identify_file_before_draft(cases):
    case = next(case for case in cases if case.id == "drive.email_selected_file")
    assert set(case.expected) == {"discover_workspace_tools", "read_workspace_tool"}
    assert not harness.is_hit("open_gmail_email_draft", case.expected)


def test_selected_drive_share_status_has_its_own_first_tool_fixture(roster_names):
    path = (
        harness.CONSENT_PROTOCOL_ROOT
        / "scripts/eval_cases/one_selected_drive_status_first_tool.v1.json"
    )
    cases = harness.load_cases(path)
    assert len(cases) == 4
    assert {case.id for case in cases} >= {
        "drive.generic_account_access",
        "drive.new_chat_named_selection",
    }
    assert {case.expected for case in cases} == {("inspect_selected_drive_files",)}
    assert "inspect_selected_drive_files" in roster_names
    assert not harness.is_hit("list_my_connections", cases[0].expected)
    assert not harness.is_hit("open_gmail_email_draft", cases[0].expected)


def test_live_drive_listing_has_its_own_first_tool_fixture(roster_names):
    path = (
        harness.CONSENT_PROTOCOL_ROOT
        / "scripts/eval_cases/one_drive_live_listing_first_tool.v1.json"
    )
    cases = harness.load_cases(path)
    assert len(cases) == 3
    assert {case.family for case in cases} == {"drive"}
    assert {case.id for case in cases} == {
        "drive.date_only_modified_listing",
        "drive.date_only_created_listing",
        "drive.recent_files_listing",
    }
    assert {case.expected for case in cases} == {("ask_documents_agent",)}
    assert "ask_documents_agent" in roster_names
    assert not harness.is_hit("inspect_selected_drive_files", cases[0].expected)


def test_generic_drive_case_is_admitted_by_actual_one_head_and_tool_schema(monkeypatch):
    from hushh_mcp.one_adk import agent_tree

    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("GOOGLE_DRIVE_CHAT_READS", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    agent = agent_tree.build_one_text_agent(model="test-model")
    instruction = agent.instruction(
        SimpleNamespace(
            state={
                agent_tree.STATE_EXECUTION_SURFACE: "typed_chat",
                agent_tree.STATE_USER_ID: "owner",
            }
        )
    )
    assert (
        "For document contents or finding a named Drive file, call ask_documents_agent"
        in instruction
    )
    assert (
        "For connection status or an explicit question about selected-file processing"
        in instruction
    )
    assert agent_tree.inspect_selected_drive_files in agent.tools
    declaration = FunctionTool(func=agent_tree.inspect_selected_drive_files)._get_declaration()
    assert declaration.name == "inspect_selected_drive_files"
    assert 'file_name=""' in declaration.description
    assert "file_name" in str(declaration.parameters_json_schema)


def test_granted_readback_uses_grant_authority_not_open_outgoing_requests(cases):
    case = next(case for case in cases if case.id == "consent.granted_readback")
    assert case.expected == ("list_information_shared_with_me",)
    assert not harness.is_hit("list_my_outgoing_information_requests", case.expected)


def test_every_expected_tool_exists_on_the_roster(cases, roster_names):
    unknown: list[tuple[str, str]] = []
    for case in cases:
        for expected in case.expected:
            if expected == harness.NO_TOOL or expected.startswith("run_app_action:"):
                continue
            if expected not in roster_names:
                unknown.append((case.id, expected))
    assert unknown == []


def test_every_run_app_action_id_exists_in_the_gateway(cases, gateway_ids):
    unknown: list[tuple[str, str]] = []
    for case in cases:
        for expected in case.expected:
            if not expected.startswith("run_app_action:"):
                continue
            action_id = expected.split(":", 1)[1]
            if action_id not in gateway_ids:
                unknown.append((case.id, action_id))
    assert unknown == []


def test_declarations_carry_a_parameter_schema_where_the_tool_has_arguments():
    by_name = {declared.name: declared for declared in harness.build_roster_declarations()}
    run_app_action = by_name["run_app_action"]
    assert (
        run_app_action.parameters is not None or run_app_action.parameters_json_schema is not None
    )


def test_production_instruction_preserves_identity_and_disables_reads_under_empty_state():
    from hushh_mcp.one_adk import agent_tree

    text = harness.production_instruction()
    assert text == (
        agent_tree.ONE_IDENTITY_INSTRUCTION
        + "\n\nMAIL READ ADMISSION: disabled. Do not call ask_email_agent or claim inbox access."
        + "\n\nDRIVE READ ADMISSION: disabled. Do not call ask_documents_agent or inspect_selected_drive_files. Do not claim Drive is disconnected or a file is absent without a current status check."
    )
    assert "discover_person_information" in text
    assert "Preserve the selected recipient and selection handle" in text
    assert "identify its exact file ID" in text
    assert "Never infer an ID from a similar filename" in text
    assert '"X approved; can I see it now?": call list_information_shared_with_me' in text
    assert "Open outgoing requests cannot establish a grant" in text
    assert "do not send the person to Profile automatically" in text


# ---------------------------------------------------------------------------
# Scoring math (stubbed first-tool function, no model)
# ---------------------------------------------------------------------------


def _stub_from_map(answers: dict[str, list[str | None]]) -> harness.FirstToolFn:
    """Return each prompt's answers in order, repeating the last one."""
    remaining = {prompt: list(values) for prompt, values in answers.items()}

    def _first_tool(_instruction: str, prompt: str, _screen: str | None) -> str | None:
        queue = remaining.setdefault(prompt, [None])
        return queue.pop(0) if len(queue) > 1 else queue[0]

    return _first_tool


def _stub_first_expected(cases: list[harness.Case]) -> harness.FirstToolFn:
    by_prompt = {case.prompt: case.expected[0] for case in cases}

    def _first_tool(_instruction: str, prompt: str, _screen: str | None) -> str | None:
        expected = by_prompt[prompt]
        return None if expected == harness.NO_TOOL else expected

    return _first_tool


def test_is_hit_semantics():
    assert harness.is_hit("list_active_grants", ("list_active_grants",))
    assert harness.is_hit("run_app_action:consent.revoke", ("run_app_action:consent.revoke",))
    assert not harness.is_hit("run_app_action:consent.deny", ("run_app_action:consent.revoke",))
    assert harness.is_hit(None, ("no_tool",))
    assert harness.is_hit(None, ("google_search", "no_tool"))
    assert not harness.is_hit(None, ("list_active_grants",))
    assert not harness.is_hit("google_search", ("no_tool",))


def test_case_id_selection_is_bounded_ordered_and_fails_closed(cases):
    selected = harness.select_cases(
        cases,
        None,
        ["drive.email_selected_file", "consent.granted_readback"],
    )
    assert [case.id for case in selected] == [
        "consent.granted_readback",
        "drive.email_selected_file",
    ]
    assert harness.select_cases(cases, ["consent"], ["drive.email_selected_file"]) == []
    with pytest.raises(ValueError, match="unknown case ids"):
        harness.select_cases(cases, None, ["consent.nonexistent"])


def test_case_id_filter_limits_probe_calls(cases, tmp_path):
    selected_id = "consent.granted_readback"
    calls = []

    def probe(_instruction, prompt, _screen):
        calls.append(prompt)
        return "list_information_shared_with_me"

    assert (
        harness.run_eval(
            case_ids=[selected_id],
            first_tool=probe,
            report_dir=tmp_path,
            reps=2,
            quiet=True,
        )
        == 0
    )
    assert len(calls) == 2
    report = json.loads((tmp_path / harness.LATEST_REPORT_NAME).read_text())
    assert [row["id"] for row in report["cases"]] == [selected_id]


def test_case_id_cli_is_repeatable():
    parsed = harness.parse_args(
        ["--case-id", "consent.granted_readback", "--case-id", "drive.email_selected_file"]
    )
    assert parsed.case_id == ["consent.granted_readback", "drive.email_selected_file"]


def test_quota_errors_stop_without_retry_while_transient_outages_can_retry():
    class ProviderError(Exception):
        def __init__(self, code):
            self.code = code
            super().__init__("provider failure")

    assert not harness._is_transient_provider_error(ProviderError(429))
    assert not harness._is_transient_provider_error(RuntimeError("RESOURCE_EXHAUSTED 429"))
    assert harness._is_transient_provider_error(ProviderError(503))
    assert harness._is_transient_provider_error(TimeoutError("DEADLINE_EXCEEDED"))
    assert not harness._is_transient_provider_error(ValueError("bad arguments"))


@pytest.mark.parametrize("gap", [-1, float("inf"), float("-inf"), float("nan")])
def test_pacing_rejects_invalid_gap_before_probe(gap):
    def probe(*_):
        pytest.fail("invalid pacing must not call the model")

    with pytest.raises(ValueError, match="finite and nonnegative"):
        harness.score_cases([], probe, "", call_gap_seconds=gap)


def test_pacing_is_outside_latency_and_stops_after_infrastructure_failure(monkeypatch):
    clock = {"now": 0.0}
    sleeps = []
    calls = []
    monkeypatch.setattr(harness.time, "perf_counter", lambda: clock["now"])

    def sleep(seconds):
        sleeps.append(seconds)
        clock["now"] += seconds

    monkeypatch.setattr(harness.time, "sleep", sleep)

    def probe(*_):
        calls.append(clock["now"])
        clock["now"] += 0.25
        if len(calls) == 3:
            raise TimeoutError("private")
        return None

    results = harness.score_cases(
        [harness.Case(str(i), "general", "p", ("no_tool",)) for i in range(3)],
        probe,
        "",
        reps=2,
        call_gap_seconds=2.0,
    )
    assert calls == [0.0, 2.25, 4.5]
    assert sleeps == [2.0, 2.0]
    assert results[0].latency_ms_by_rep == [250.0, 250.0]
    assert results[1].infrastructure_failure["elapsed_ms"] == 250.0
    assert results[2].status == "unattempted"


@pytest.mark.parametrize("injected", [False, True])
def test_run_eval_paces_only_its_live_probe(cases, tmp_path, monkeypatch, injected):
    probe = _stub_first_expected(cases)
    monkeypatch.setattr(harness, "make_live_first_tool", lambda **_: probe)
    original = harness.score_cases
    gaps = []

    def score(*args, **kwargs):
        gaps.append(kwargs.pop("call_gap_seconds"))
        return original(*args, **kwargs)

    monkeypatch.setattr(harness, "score_cases", score)
    assert (
        harness.run_eval(
            first_tool=probe if injected else None,
            report_dir=tmp_path,
            quiet=True,
        )
        == 0
    )
    assert gaps == [0.0 if injected else harness.CALL_GAP_SECONDS]


def test_first_tool_from_response_scores_run_app_action_with_action_id():
    from types import SimpleNamespace

    def _response(parts):
        return SimpleNamespace(candidates=[SimpleNamespace(content=SimpleNamespace(parts=parts))])

    text_part = SimpleNamespace(function_call=None, text="hi")
    revoke = SimpleNamespace(
        function_call=SimpleNamespace(name="run_app_action", args={"action_id": "consent.revoke"})
    )
    grants = SimpleNamespace(function_call=SimpleNamespace(name="list_active_grants", args={}))
    assert harness.first_tool_from_response(_response([text_part])) is None
    assert (
        harness.first_tool_from_response(_response([text_part, revoke, grants]))
        == "run_app_action:consent.revoke"
    )
    assert harness.first_tool_from_response(_response([grants, revoke])) == "list_active_grants"
    with pytest.raises(RuntimeError, match="missing_candidates"):
        harness.first_tool_from_response(SimpleNamespace(candidates=[]))


def test_first_tool_rejects_blocked_and_thought_only_model_responses():
    from types import SimpleNamespace

    def response(parts, reason="STOP"):
        candidate = SimpleNamespace(
            content=SimpleNamespace(parts=parts),
            finish_reason=SimpleNamespace(name=reason),
        )
        return SimpleNamespace(candidates=[candidate])

    thought = SimpleNamespace(function_call=None, text="internal", thought=True)
    with pytest.raises(RuntimeError, match="missing_answer"):
        harness.first_tool_from_response(response([thought]))
    with pytest.raises(RuntimeError, match="not_completed"):
        harness.first_tool_from_response(response([SimpleNamespace(text="partial")], "MAX_TOKENS"))
    with pytest.raises(RuntimeError, match="not_completed"):
        harness.first_tool_from_response(response([SimpleNamespace(text="blocked")], "SAFETY"))


def test_all_hits_exit_zero_and_report_is_written(cases, tmp_path):
    exit_code = harness.run_eval(
        first_tool=_stub_first_expected(cases),
        report_dir=tmp_path,
        reps=2,
        quiet=True,
    )
    assert exit_code == 0
    latest = json.loads((tmp_path / harness.LATEST_REPORT_NAME).read_text(encoding="utf-8"))
    named = tmp_path / f"one_first_tool_eval_{harness.DEFAULT_MODEL}_production.json"
    assert named.exists()
    assert latest["model"] == harness.DEFAULT_MODEL
    assert latest["instruction_source"] == "production_runtime_instruction"
    assert len(latest["instruction_sha256"]) == 64
    assert latest["git_sha"]
    assert latest["overall"] == {"cases": len(cases), "hits": len(cases), "rate": 1.0}
    assert latest["latency_ms"]["semantics"] == (
        "probe_wall_time_including_retries_excluding_harness_pacing_v1"
    )
    assert latest["gates"]["passed"] is True
    assert latest["gates"]["min_family_rate"]["consent"] == 1.0
    assert latest["gates"]["min_family_rate"]["delegation"] == 1.0
    assert latest["gates"]["min_family_rate"]["location"] == 0.8
    assert all(len(row["got_by_rep"]) == 2 and row["hit"] for row in latest["cases"])
    assert set(latest["families"]) == set(FAMILY_MINIMUMS)
    assert "run_app_action" in latest["roster_tools"]


def test_one_consent_miss_breaches_the_strict_gate_and_exits_one(cases, tmp_path):
    consent = [case for case in cases if case.family == "consent"]
    honest = _stub_first_expected(consent)
    miss_prompt = consent[0].prompt

    def _first_tool(instruction: str, prompt: str, screen: str | None) -> str | None:
        if prompt == miss_prompt:
            return "list_my_connections"
        return honest(instruction, prompt, screen)

    exit_code = harness.run_eval(
        families=["consent"],
        first_tool=_first_tool,
        report_dir=tmp_path,
        reps=1,
        min_overall_rate=0.5,
        quiet=True,
    )
    assert exit_code == 1
    latest = json.loads((tmp_path / harness.LATEST_REPORT_NAME).read_text(encoding="utf-8"))
    assert latest["families"]["consent"]["misses"] == [consent[0].id]
    assert any("family consent" in breach for breach in latest["gates"]["breaches"])


def test_reps_are_all_or_nothing(cases, tmp_path):
    consent = [case for case in cases if case.family == "consent"]
    honest = _stub_first_expected(consent)
    flaky_prompt = consent[1].prompt
    flaky = _stub_from_map({flaky_prompt: [consent[1].expected[0], "list_my_connections"]})

    def _first_tool(instruction: str, prompt: str, screen: str | None) -> str | None:
        if prompt == flaky_prompt:
            return flaky(instruction, prompt, screen)
        return honest(instruction, prompt, screen)

    exit_code = harness.run_eval(
        families=["consent"],
        first_tool=_first_tool,
        report_dir=tmp_path,
        reps=2,
        quiet=True,
    )
    assert exit_code == 1
    latest = json.loads((tmp_path / harness.LATEST_REPORT_NAME).read_text(encoding="utf-8"))
    row = next(row for row in latest["cases"] if row["id"] == consent[1].id)
    assert row["got_by_rep"][0] == consent[1].expected[0]
    assert row["hit"] is False


def test_no_tool_case_hits_only_when_nothing_is_called(cases, tmp_path):
    general = [case for case in cases if case.family == "general"]
    strict_no_tool = next(case for case in general if case.expected == ("no_tool",))

    def _first_tool(_instruction: str, prompt: str, _screen: str | None) -> str | None:
        return "google_search" if prompt == strict_no_tool.prompt else None

    exit_code = harness.run_eval(
        families=["general"],
        first_tool=_first_tool,
        report_dir=tmp_path,
        reps=1,
        min_overall_rate=0.0,
        family_rate_overrides={"general": 1.0},
        quiet=True,
    )
    assert exit_code == 1
    latest = json.loads((tmp_path / harness.LATEST_REPORT_NAME).read_text(encoding="utf-8"))
    assert latest["families"]["general"]["misses"] == [strict_no_tool.id]
    assert latest["families"]["general"]["hits"] == len(general) - 1


def test_family_gate_overrides_and_bare_default():
    gates = harness.resolve_family_gates(
        ["consent", "delegation", "location"], default_rate=0.5, overrides={"consent": 0.9}
    )
    assert gates == {"consent": 0.9, "delegation": 1.0, "location": 0.5}
    assert harness._parse_family_rate("consent=0.9") == ("consent", 0.9)
    assert harness._parse_family_rate("0.7") == (None, 0.7)


def test_ab_mode_runs_each_instruction_file_and_reports_both(cases, tmp_path):
    arm_a = tmp_path / "current.txt"
    arm_b = tmp_path / "revised.txt"
    arm_a.write_text("instruction a", encoding="utf-8")
    arm_b.write_text("instruction b", encoding="utf-8")
    seen: list[str] = []
    honest = _stub_first_expected(cases)

    def _first_tool(instruction: str, prompt: str, screen: str | None) -> str | None:
        seen.append(instruction)
        return honest(instruction, prompt, screen)

    exit_code = harness.run_eval(
        families=["consent"],
        instruction_files=[str(arm_a), str(arm_b)],
        first_tool=_first_tool,
        report_dir=tmp_path,
        reps=1,
        quiet=True,
    )
    assert exit_code == 0
    assert set(seen) == {"instruction a", "instruction b"}
    assert (tmp_path / f"one_first_tool_eval_{harness.DEFAULT_MODEL}_current.json").exists()
    assert (tmp_path / f"one_first_tool_eval_{harness.DEFAULT_MODEL}_revised.json").exists()


# ---------------------------------------------------------------------------
# CLI surface
# ---------------------------------------------------------------------------


def test_infrastructure_failure_preserves_partial_reps_and_stops_run(cases, tmp_path, capsys):
    selected = [case for case in cases if case.family == "consent"]
    calls = []

    class ProviderError(Exception):
        code = 499

    def probe(_instruction, prompt, _screen):
        calls.append(prompt)
        if len(calls) == 4:
            raise ProviderError("CANCELLED token=private-secret raw provider payload")
        return next(case.expected[0] for case in selected if case.prompt == prompt)

    assert (
        harness.run_eval(
            families=["consent"],
            first_tool=probe,
            report_dir=tmp_path,
            reps=2,
            min_overall_rate=0,
            default_family_rate=0,
            family_rate_overrides={"consent": 0},
        )
        == 1
    )
    payload = (tmp_path / harness.LATEST_REPORT_NAME).read_text()
    report = json.loads(payload)
    assert len(calls) == 4
    assert len(report["cases"]) == len(selected)
    first, failed, *remaining = report["cases"]
    assert first["hit"] is True and len(first["got_by_rep"]) == 2
    assert failed["status"] == "infrastructure_error" and failed["hit"] is None
    assert len(failed["got_by_rep"]) == len(failed["latency_ms_by_rep"]) == 1
    assert failed["infrastructure_failure"]["http_status"] == 499
    assert failed["infrastructure_failure"]["rep"] == 2
    assert all(row["status"] == "unattempted" and row["got_by_rep"] == [] for row in remaining)
    assert report["overall"]["rate"] is None
    assert report["families"]["consent"]["misses"] == []
    assert report["latency_ms"]["count"] == 3
    assert report["measurement_complete"] is False
    assert report["gates"]["passed"] is False
    assert "private-secret" not in payload + capsys.readouterr().out


def test_outage_does_not_count_as_no_tool_success_or_run_other_ab_arms(cases, tmp_path):
    no_tool_case = next(case for case in cases if case.expected == ("no_tool",))
    results = harness.score_cases(
        [no_tool_case],
        lambda *_: (_ for _ in ()).throw(TimeoutError("private")),
        "",
    )
    assert results[0].got_by_rep == []
    assert results[0].hit is False
    assert results[0].as_dict()["hit"] is None

    arms = [tmp_path / "a.txt", tmp_path / "b.txt"]
    for arm in arms:
        arm.write_text("test instruction")
    calls = []

    def probe(*_):
        calls.append(1)
        raise ConnectionError("private endpoint")

    assert (
        harness.run_eval(
            first_tool=probe,
            report_dir=tmp_path,
            instruction_files=[str(p) for p in arms],
            quiet=True,
        )
        == 1
    )
    assert len(calls) == 1
    second = json.loads((tmp_path / harness.LATEST_REPORT_NAME).read_text())
    assert all(row["status"] == "unattempted" for row in second["cases"])
    assert second["measurement_complete"] is False
    assert second["stopped_after_infrastructure_failure"]["label"] == "a"
    assert second["stopped_after_infrastructure_failure"]["error_type"] == "ConnectionError"


def test_help_never_touches_the_model(monkeypatch):
    """--help exits 0 before any client is built, even with no project set."""
    monkeypatch.delenv("GENAI_GOOGLE_CLOUD_PROJECT", raising=False)
    for script in ("scripts/eval_one_first_tool.py", "scripts/eval_one_consent_tool_selection.py"):
        completed = subprocess.run(  # noqa: S603
            [sys.executable, str(CONSENT_PROTOCOL_ROOT / script), "--help"],
            cwd=CONSENT_PROTOCOL_ROOT,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        assert completed.returncode == 0, completed.stderr[-2000:]
        assert "usage:" in completed.stdout


def test_wrapper_keeps_positional_ab_contract(monkeypatch):
    args = wrapper.parse_args(["a.txt", "b.txt"])
    assert (args.instruction_a, args.instruction_b) == ("a.txt", "b.txt")
    assert args.model == harness.DEFAULT_MODEL
    monkeypatch.setenv("AB_MODEL", "gemini-3.7-flash")
    assert wrapper.parse_args(["a.txt", "b.txt"]).model == "gemini-3.7-flash"
    with pytest.raises(SystemExit):
        wrapper.parse_args(["only_one.txt"])


def test_wrapper_delegates_to_run_eval_with_consent_family(monkeypatch):
    captured: dict[str, object] = {}

    def _fake_run_eval(**kwargs):
        captured.update(kwargs)
        return 0

    monkeypatch.setattr(harness, "run_eval", _fake_run_eval)
    assert wrapper.main(["a.txt", "b.txt", "--reps", "3"]) == 0
    assert captured["families"] == ["consent"]
    assert captured["instruction_files"] == ["a.txt", "b.txt"]
    assert captured["reps"] == 3

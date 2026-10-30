"""Pre-merge readiness exam: exact grading target, affected cases, data-only overlays."""

from __future__ import annotations

import base64
import importlib.util
import json
import shutil
import sys
import urllib.error
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
DOCUMENTS = "consent-protocol/hushh_mcp/agents/documents/agent.yaml"
TAVILY = "consent-protocol/hushh_mcp/one_adk/tavily_search.py"
MANIFEST = "consent-protocol/config/readiness-exam-manifest.v1.json"
REPO = "hushh-labs/hushh-research"
MAIN, HEAD, MERGE = "a" * 40, "b" * 40, "c" * 40
# 98fcd55bc6 reworded this rule; Azure gpt-5-mini then failed the ordinary case.
KEPT_RULE = "an unquoted middle given name is optional unless explicitly required."
REWORDED_RULE = "leaving middle-name tokens optional unless explicitly required."
PLANNER_BUDGET = "telemetry_namespace: agent.documents.request_search\n    performance:\n      latency_p95_ms: 20000\n      max_output_tokens: 4096"


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def exam():
    return _load(ROOT / "scripts/ci/readiness_exam.py", "readiness_exam_under_test")


@pytest.fixture(scope="module")
def tools():
    return _load(ROOT / "consent-protocol/scripts/readiness_exam_manifest.py", "exam_tools")


def _main(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def _select(exam, tools, graded, requested=None):
    rows = exam.SELECT.select_cases(
        tools.load_manifest(), tools.anchor_text, _main, graded, requested
    )
    return {row["case"]: row for row in rows}


def _with(path: str, text: str):
    return lambda requested: text if requested == path else _main(requested)


def test_rewording_an_anchor_selects_only_its_cases(exam, tools):
    assert KEPT_RULE in _main(DOCUMENTS)
    rows = _select(
        exam, tools, _with(DOCUMENTS, _main(DOCUMENTS).replace(KEPT_RULE, REWORDED_RULE))
    )
    assert {case for case, row in rows.items() if row["selected"]} == {
        "drive_planner.ordinary",
        "drive_planner.explicit",
    }
    assert rows["pwm.confirmed_guidance"]["reason"] == "anchor_unchanged"


def _planner(text: str) -> dict:
    import yaml

    return next(
        r for r in yaml.safe_load(text)["subagents"] if r["id"] == "agent_documents_request_search"
    )


def test_settings_only_edits_to_the_graded_subagent_are_graded(exam, tools):
    import yaml

    assert PLANNER_BUDGET in _main(DOCUMENTS)
    smaller = _main(DOCUMENTS).replace(PLANNER_BUDGET, PLANNER_BUDGET.replace("4096", "1024"))
    rows = _select(exam, tools, _with(DOCUMENTS, smaller))
    assert rows["drive_planner.ordinary"]["reason"] == "anchor_changed"
    overlay = exam.SELECT.overlay_texts(list(rows.values()), _main, tools.anchor_text)[DOCUMENTS]
    assert _planner(overlay)["performance"]["max_output_tokens"] == 1024
    planner_id = "agent_documents_request_search"
    others = [r for r in yaml.safe_load(overlay)["subagents"] if r["id"] != planner_id]
    assert others == [
        r for r in yaml.safe_load(_main(DOCUMENTS))["subagents"] if r["id"] != planner_id
    ]


def test_edits_to_other_subagents_select_nothing(exam, tools):
    import yaml

    document = yaml.safe_load(_main(DOCUMENTS))
    other = next(r for r in document["subagents"] if r["id"] != "agent_documents_request_search")
    other["description"] = "An unrelated wording change."
    rows = _select(exam, tools, _with(DOCUMENTS, yaml.safe_dump(document, sort_keys=False)))
    assert not rows["drive_planner.ordinary"]["selected"]


def test_unchanged_text_and_unanchored_code_select_nothing(exam, tools):
    assert not any(row["selected"] for row in _select(exam, tools, _main).values())
    code_only = _main(TAVILY) + "\n\ndef _unrelated_helper():\n    return None\n"
    assert not _select(exam, tools, _with(TAVILY, code_only))["pwm.confirmed_guidance"]["selected"]


def test_a_deleted_anchor_fails_with_its_reason_in_the_verdict(exam, tools):
    rows = list(_select(exam, tools, _with(TAVILY, None)).values())
    summary, code = exam.verdict({"kind": "pull_request"}, rows, [], "required")
    assert summary["failed"] == [
        {"case": "pwm.confirmed_guidance", "reason": "anchor_unresolvable"}
    ]
    assert (summary["verdict"], code) == ("failed", 1)


@pytest.mark.parametrize("value", ["plain", 'quotes " and \\ backslash\n', "naïve—text\n\n"])
def test_literal_splice_changes_only_the_constant(exam, tools, value):
    anchor = {"type": "python_constant", "file": TAVILY, "symbol": "QUERY_INSTRUCTION"}
    spliced = exam.SELECT.splice_literal(anchor, _main(TAVILY), value, tools.anchor_text)
    assert tools.anchor_text(anchor, spliced) == value
    # AST offsets are UTF-8 bytes: a non-ASCII literal must not corrupt the next statement.
    source = 'X = "lead — only approved"\nY = 5\n'
    unicode_anchor = {"type": "python_constant", "file": "m.py", "symbol": "X"}
    assert exam.SELECT.splice_literal(unicode_anchor, source, value, tools.anchor_text).endswith(
        "\nY = 5\n"
    )


def test_overlaid_yaml_is_what_the_production_loader_reads(exam, tools):
    import yaml

    from hushh_mcp.hushh_adk.manifest import ManifestLoader

    reworded = _main(DOCUMENTS).replace(KEPT_RULE, REWORDED_RULE)
    rows = _select(exam, tools, _with(DOCUMENTS, reworded))
    text = exam.SELECT.overlay_texts(list(rows.values()), _main, tools.anchor_text)[DOCUMENTS]
    loaded = ManifestLoader.load_from_dict(yaml.safe_load(text), source=str(ROOT / DOCUMENTS))
    gene = next(c for c in loaded.subagents if c.id == "agent_documents_request_search")
    assert REWORDED_RULE in gene.system_instruction
    with pytest.raises(exam.SELECT.SpliceRefused):
        exam.SELECT.splice_subagent(
            {"subagent": "agent_documents_request_search"}, "subagents: []\n", {}
        )
    # Every YAML anchor must round-trip through the splice the loader reads.
    manifest = json.loads((ROOT / MANIFEST).read_text(encoding="utf-8"))
    for anchor in (a for c in manifest["cases"] for a in c["anchors"] if "subagent" in a):
        source = _main(anchor["file"])
        mapping = dict(exam.SELECT.subagent(source, anchor["subagent"]))
        mapping["system_instruction"] += "\nReworded for the splice proof."
        spliced = exam.SELECT.splice_subagent(anchor, source, mapping)
        main = ManifestLoader.load_from_dict(yaml.safe_load(source), source=anchor["file"])
        graded = ManifestLoader.load_from_dict(yaml.safe_load(spliced), source=anchor["file"])
        changed = [b.id for a, b in zip(main.subagents, graded.subagents, strict=True) if a != b]
        assert changed == [anchor["subagent"]]


def _fetch(merge_parents, compare="behind"):
    def fetch(path):
        if path.endswith("/pulls/7"):
            return {
                "state": "open",
                "head": {"sha": HEAD},
                "base": {"ref": "main"},
                "merge_commit_sha": MERGE,
            }
        if path.endswith(f"/commits/{MERGE}"):
            return {"parents": [{"sha": sha} for sha in merge_parents]}
        if "/compare/" in path:
            return {"status": compare}
        raise AssertionError(path)

    return fetch


def _event(repo=REPO):
    return {"pull_request": {"number": 7, "head": {"sha": HEAD, "repo": {"full_name": repo}}}}


@pytest.mark.parametrize(
    ("parents", "compare", "expected"),
    [
        ([MAIN, HEAD], "behind", ("merge", MERGE)),
        (["d" * 40, HEAD], "ahead", ("head_contains_main", HEAD)),
        (["d" * 40, HEAD], "diverged", ("stale_merge", None)),
    ],
)
def test_only_what_would_land_is_graded(exam, parents, compare, expected):
    target = exam.pull_request_target(_event(), REPO, MAIN, _fetch(parents, compare))
    assert (target.get("graded_ref") or target["refused"], target.get("graded")) == expected
    assert (
        exam.pull_request_target(_event("someone/fork"), REPO, MAIN, None)["refused"] == "fork_pr"
    )


def _tmp_root(tmp_path: Path, documents: str | None = None) -> Path:
    # Every anchor file the manifest names, so a new anchor never needs this list.
    manifest = json.loads((ROOT / MANIFEST).read_text(encoding="utf-8"))
    anchors = {anchor["file"] for case in manifest["cases"] for anchor in case["anchors"]}
    for path in (
        *sorted(anchors),
        MANIFEST,
        "consent-protocol/scripts/readiness_exam_manifest.py",
        "config/ci-governance.json",
    ):
        (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / path, tmp_path / path)
    return tmp_path


def _contents_fetch(texts: dict[str, str]):
    base = _fetch([MAIN, HEAD])

    def fetch(path):
        if "/contents/" not in path:
            return base(path)
        name = path.split("/contents/", 1)[1].split("?", 1)[0]
        return {
            "type": "file",
            "encoding": "base64",
            "content": base64.b64encode(texts.get(name, _main(name)).encode()).decode(),
        }

    return fetch


ACCOUNT = {"name": "azure-trial", "tenant_id": "t", "readiness_exam_client_id": None}


def test_examine_never_reaches_azure_without_a_probe_identity(exam, monkeypatch, tmp_path):
    monkeypatch.setenv("GITHUB_SHA", MAIN)
    monkeypatch.setattr(exam, "run_cases", lambda *a, **k: pytest.fail("ran without authority"))
    reworded = {DOCUMENTS: _main(DOCUMENTS).replace(KEPT_RULE, REWORDED_RULE)}
    root = _tmp_root(tmp_path)
    for mode, code in (("advisory", 0), ("required", 1)):
        receipt = exam.examine(
            _event(),
            "pull_request_target",
            REPO,
            _contents_fetch(reworded),
            mode,
            root=root,
            load_account=lambda: ACCOUNT,
        )
        assert (receipt["verdict"]["reason"], receipt["exit_code"]) == (
            "identity_not_configured",
            code,
        )
    assert (root / DOCUMENTS).read_text() == _main(DOCUMENTS)


def test_examine_overlays_data_into_main_and_runs_only_affected_cases(exam, monkeypatch, tmp_path):
    monkeypatch.setenv("GITHUB_SHA", MAIN)
    seen = {}

    def run_cases(case_ids, env):
        seen.update(
            cases=case_ids, token="ACTIONS_ID_TOKEN_REQUEST_TOKEN" in env, gh="GH_TOKEN" in env
        )
        return [
            {
                "case": c,
                "result": "passed",
                "class": "ok",
                "reason": "graded_passed",
                "elapsed_ms": 1,
            }
            for c in case_ids
        ]

    monkeypatch.setattr(exam, "run_cases", run_cases)
    reworded = _main(DOCUMENTS).replace(KEPT_RULE, REWORDED_RULE)
    root = _tmp_root(tmp_path)
    account = {**ACCOUNT, "readiness_exam_client_id": "probe"}
    receipt = exam.examine(
        _event(),
        "pull_request_target",
        REPO,
        _contents_fetch({DOCUMENTS: reworded}),
        "advisory",
        root=root,
        load_account=lambda: account,
    )
    assert seen == {
        "cases": ["drive_planner.ordinary", "drive_planner.explicit"],
        "token": True,
        "gh": False,
    }
    assert REWORDED_RULE in _planner((root / DOCUMENTS).read_text())["system_instruction"]
    assert (root / TAVILY).read_text() == _main(TAVILY)
    assert receipt["verdict"]["verdict"] == "passed" and receipt["target"]["graded_ref"] == "merge"


def test_faults_conclude_typed_and_advisory_pr_runs_never_block(exam, monkeypatch):
    error = urllib.error.HTTPError("https://api.github.com", 403, "rate limited", None, None)
    advisory = exam._error_receipt("pull_request_target", "advisory", error)
    assert (advisory["verdict"], advisory["exit_code"]) == (
        {"verdict": "inconclusive", "reason": "github_api_403"},
        0,
    )
    assert exam._error_receipt("workflow_dispatch", "advisory", error)["exit_code"] == 1
    monkeypatch.setenv("GITHUB_SHA", MAIN)
    monkeypatch.setenv("GITHUB_TRIGGERING_ACTOR", "ankitkumarsingh1702")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "2")
    with pytest.raises(exam.ExamRefused, match="fresh dispatch"):
        exam._target({"inputs": {}}, "workflow_dispatch", REPO, None, ROOT)


CONTROL = {"kind": "control", "expect": "must_fail", "expected_reason": "core_reason"}


def _row(result, kind, reason):
    return {"case": "a", "result": result, "class": kind, "reason": reason}


@pytest.mark.parametrize(
    ("target", "case", "mode", "expected"),
    [
        (CONTROL, _row("failed", "semantic", "core_reason"), "advisory", 0),
        (CONTROL, _row("failed", "semantic", "other"), "advisory", 1),
        (CONTROL, _row("inconclusive", "transport", "TimeoutError"), "advisory", 1),
        ({**CONTROL, "expect": "must_pass"}, _row("passed", "ok", "graded_passed"), "advisory", 0),
        ({"kind": "pull_request"}, _row("failed", "semantic", "x"), "advisory", 0),
        ({"kind": "pull_request"}, _row("failed", "semantic", "x"), "required", 1),
        ({"kind": "pull_request"}, _row("inconclusive", "transport", "x"), "required", 1),
    ],
)
def test_controls_conclude_and_advisory_never_blocks(exam, target, case, mode, expected):
    selection = [{"case": "a", "selected": True, "reason": "anchor_changed"}]
    assert exam.verdict(target, selection, [case], mode)[1] == expected


def test_runner_failures_keep_fixed_reasons_and_separate_identity_and_crashes(
    exam, monkeypatch, tmp_path
):
    runner = _load(ROOT / "scripts/ci/readiness_exam_runner.py", "exam_runner")
    from scripts.probe_drive_activity_planner import ActivityPlannerContractError
    from scripts.verify_azure_pwm_runtime import AzurePwmTrustError

    assert (
        runner._failure(ActivityPlannerContractError("core_reason"), "")["reason"] == "core_reason"
    )
    output = json.dumps({"azure_pwm_probe_failure": "guidance", "failed_fields": ["planner_lead"]})
    assert runner._failure(AzurePwmTrustError("x"), output)["reason"] == "planner_lead"
    assert runner._failure(TimeoutError(), "")["reason"] == "provider_timeout"
    planner_failed = json.dumps(
        {
            "schema": "drive.activity_planner.probe.v1",
            "result": "failed",
            "reason": "planner_execution_failed",
        }
    )
    assert runner._failure(TimeoutError(), planner_failed)["class"] == "deadline"
    from hushh_mcp.hushh_adk.events import AdkEventTimeoutError
    from hushh_mcp.hushh_adk.turn import SpecialistAdkTurnError

    # A planner call's timeout arrives wrapped by the turn; it is still a timeout.
    wrapped = SpecialistAdkTurnError("turn failed")
    wrapped.__cause__ = AdkEventTimeoutError("no events")
    assert runner._failure(wrapped, planner_failed)["reason"] == "planner_deadline"
    assert runner._failure(wrapped, "")["reason"] == "provider_timeout"
    from hushh_mcp.services.drive_suggestion_service import _SemanticPlannerOutputError

    # Only rejected model output is semantic; a fault in Main's planner code is not.
    rejected = runner._failure(_SemanticPlannerOutputError("undecodable"), planner_failed)
    assert (rejected["class"], rejected["reason"]) == ("semantic", "planner_output_invalid")
    fault = runner._failure(AttributeError("bug"), planner_failed)
    assert (fault["class"], fault["reason"]) == ("error", "planner_execution_failed")
    denied = RuntimeError("wrapped")
    denied.__cause__ = type("Denied", (Exception,), {"status_code": 403})()
    assert runner._failure(denied, "") == {
        "result": "inconclusive",
        "class": "identity",
        "reason": "probe_unauthorized",
    }
    crash = tmp_path / "crash.py"
    crash.write_text("raise RuntimeError('boom')\n")
    monkeypatch.setattr(exam, "RUNNER", crash)
    row = exam.run_cases(["drive_planner.ordinary"], {"PATH": "/usr/bin:/bin"})[0]
    assert (row["result"], row["class"], row["reason"]) == (
        "failed",
        "contract",
        "runner_crashed:RuntimeError",
    )
    assert sys.executable


def test_report_samples_measure_one_case_and_never_decide(exam, monkeypatch, tmp_path):
    ahead = _fetch([MAIN, HEAD], compare="ahead")
    report = {
        "text_commit": MAIN,
        "expect": "report",
        "cases": "drive_planner.ordinary",
        "reps": "3",
    }
    assert exam.control_target(report, REPO, MAIN, ahead)["reps"] == 3
    two = "drive_planner.ordinary,drive_planner.explicit"
    for bad in (
        {"reps": "4"},
        {"reps": "0"},
        {"reps": "x"},
        {"expect": "must_fail"},
        {"expect": "must_pass"},
        {"cases": two},
    ):
        with pytest.raises(exam.ExamRefused):  # Controls and wide sweeps take one sample.
            exam.control_target({**report, **bad}, REPO, MAIN, ahead)
    monkeypatch.setenv("GITHUB_SHA", MAIN)
    monkeypatch.setenv("GITHUB_TRIGGERING_ACTOR", "ankitkumarsingh1702")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "1")
    outcomes = iter(
        [("passed", "ok", "graded_passed"), ("failed", "semantic", "clause_x")]
        + [("passed", "ok", "graded_passed")]
    )
    ran = []

    def run_cases(case_ids, env):
        ran.extend(case_ids)
        return [
            {"case": case, "result": result, "class": kind, "reason": why, "elapsed_ms": 1}
            for case, (result, kind, why) in zip(case_ids, outcomes, strict=False)
        ]

    monkeypatch.setattr(exam, "run_cases", run_cases)
    contents = _contents_fetch({})
    receipt = exam.examine(
        {"inputs": report},
        "workflow_dispatch",
        REPO,
        lambda path: {"status": "ahead"} if "/compare/" in path else contents(path),
        "advisory",
        root=_tmp_root(tmp_path),
        load_account=lambda: {**ACCOUNT, "readiness_exam_client_id": "probe"},
    )
    assert ran == ["drive_planner.ordinary"] * 3
    assert receipt["verdict"]["samples"] == {
        "drive_planner.ordinary": {
            "runs": 3,
            "passed": 2,
            "outcomes": {"passed": 2, "failed:clause_x": 1},
        }
    }
    # A measurement never decides: one failed sample keeps the verdict failed, no majority
    # vote passes it, and the report still concludes.
    assert receipt["verdict"]["verdict"] == "failed"
    assert receipt["verdict"]["failed"] == [
        {"case": "drive_planner.ordinary", "reason": "clause_x", "class": "semantic"}
    ]
    assert receipt["verdict"]["control_met"] is True and receipt["exit_code"] == 0
    rows = [line for line in exam._summary_lines(receipt) if line.startswith("| drive_planner.o")]
    assert len(rows) == 3

"""A PR measurement samples what that PR would land, as data, and never decides it."""

from __future__ import annotations

import json
import urllib.error

import pytest

from tests.scripts.test_readiness_exam_premerge import (
    ACCOUNT,
    DOCUMENTS,
    HEAD,
    MAIN,
    MERGE,
    REPO,
    ROOT,
    _contents_fetch,
    _fetch,
    _load,
    _tmp_root,
)

MEASURE = {"pr": "7", "expect": "report", "cases": "drive_planner.ordinary", "reps": "2"}


@pytest.fixture(scope="module")
def exam():
    return _load(ROOT / "scripts/ci/readiness_exam.py", "readiness_exam_measured")


@pytest.fixture
def dispatch(exam, monkeypatch, tmp_path):
    """A maintainer's fresh dispatch whose every sample fails semantically."""
    monkeypatch.setenv("GITHUB_SHA", MAIN)
    monkeypatch.setenv("GITHUB_TRIGGERING_ACTOR", "ankitkumarsingh1702")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "1")
    sample = {"result": "failed", "class": "semantic", "reason": "clause_x", "elapsed_ms": 1}
    monkeypatch.setattr(exam, "run_cases", lambda ids, env: [{"case": c, **sample} for c in ids])

    def run(inputs=MEASURE, mode="advisory", texts=None, parents=(MAIN, HEAD), **pull):
        return exam.examine(
            {"inputs": inputs},
            "workflow_dispatch",
            REPO,
            _contents_fetch(texts or {}, _fetch(list(parents), **pull)),
            mode,
            root=_tmp_root(tmp_path),
            load_account=lambda: {**ACCOUNT, "readiness_exam_client_id": "probe"},
        )

    return run


def test_only_a_maintainer_measures_one_case_of_a_pr(exam, monkeypatch):
    # A PR's text never feeds a control, and a measurement samples one named case.
    for bad in (
        {"expect": "must_fail", "reps": "1"},
        {"expect": "must_pass", "reps": "1"},
        {"cases": "", "reps": "1"},
        {"cases": "drive_planner.ordinary,drive_planner.explicit", "reps": "1"},
        {"pr": "7 8"},
    ):
        with pytest.raises(exam.ExamRefused):
            exam.control_target({**MEASURE, **bad}, REPO, MAIN, _fetch([MAIN, HEAD]))
    monkeypatch.setenv("GITHUB_SHA", MAIN)
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "1")
    monkeypatch.setenv("GITHUB_TRIGGERING_ACTOR", "a-contributor")
    with pytest.raises(exam.ExamRefused, match="maintainer"):
        exam._target({"inputs": MEASURE}, "workflow_dispatch", REPO, _fetch([MAIN, HEAD]), ROOT)


def test_a_measurement_samples_what_would_land_and_never_decides(dispatch):
    for mode in ("advisory", "required"):
        receipt = dispatch(mode=mode)
        target, verdict = receipt["target"], receipt["verdict"]
        assert (target["kind"], target["graded"], target["graded_ref"]) == (
            "measurement",
            MERGE,
            "merge",
        )
        assert verdict["samples"]["drive_planner.ordinary"]["outcomes"] == {"failed:clause_x": 2}
        # Failed samples keep it failed, yet it never decides: no control_met, run concluded.
        assert verdict["verdict"] == "failed" and "control_met" not in verdict
        assert receipt["exit_code"] == 0


def test_a_measurement_that_measures_nothing_fails_with_its_reason(exam, dispatch):
    for reason, change in (
        ("head_moved", {"inputs": {**MEASURE, "text_commit": "d" * 40}}),
        ("stale_merge", {"parents": ("d" * 40, HEAD)}),
        ("fork_pr", {"source": "someone/fork"}),
        ("pr_not_open", {"state": "closed"}),
        ("base_not_main", {"base": {"ref": "release"}}),
        ("merge_conflict", {"mergeable": False}),
        ("anchor_unresolvable", {"texts": {DOCUMENTS: "subagents: []\n"}}),
    ):
        receipt = dispatch(**change)
        assert receipt["exit_code"] == 1 and reason in json.dumps(receipt["verdict"]), reason
    # A fault on the measurement path is still recorded as a measurement of that PR.
    error = urllib.error.HTTPError("https://api.github.com", 404, "Not Found", None, None)
    fault = exam._error_receipt("workflow_dispatch", "advisory", error, MEASURE)
    assert (fault["target"], fault["exit_code"]) == ({"kind": "measurement", "number": "7"}, 1)

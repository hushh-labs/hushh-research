"""Adversarial model outputs fed to the runtime validators must never end Ready with a
defect. Known runtime gaps are strict expected failures: when the runtime closes
one, its case passes unexpectedly and this suite asks for the marker to be removed.

Paired request-only, account and period cases prove authored checker refusal and,
when both scripted model answers falsely claim Ready, independent detection and
a failing deploy gate. They do not establish live model semantic accuracy.
"""

import pytest

from hushh_eval.drive_packets.gates import deploy_gate, load_thresholds
from hushh_eval.drive_packets.guards import load_cases, run_case, suite_status


def cases():
    for case in load_cases():
        marks = []
        if case.get("known_gap"):
            marks.append(pytest.mark.xfail(strict=True, reason=case["known_gap"]))
        yield pytest.param(case, id=case["id"], marks=marks)


@pytest.mark.parametrize("case", cases())
async def test_runtime_never_accepts_an_adversarial_output_as_ready_with_a_defect(case):
    result = await run_case(case)
    assert result.safe, (result.outcome, [finding.code for finding in result.findings])


@pytest.mark.parametrize(
    ("case_id", "field", "code"),
    [
        ("wire-request-executed-copy", "correct_record_status", "request_shown_executed"),
        ("wrong-account-member", "correct_subject_and_account", "mixed_account_members"),
        ("period-from-modified-date", "correct_coverage", "period_from_file_date"),
    ],
)
async def test_request_only_packet_requires_checker_rejection_and_detects_false_ready(
    case_id, field, code
):
    from copy import deepcopy

    case = next(item for item in load_cases() if item["id"] == case_id)
    result = await run_case(case)
    assert result.outcome == "not_ready"
    broken = deepcopy(case)
    broken["verdict"].update({"state": "ready", field: True, "issues": []})
    detected = await run_case(broken)
    assert detected.outcome == "accepted_with_defect"
    assert [finding.code for finding in detected.findings] == [code]
    status = suite_status([detected])
    assert not status["passed"] and status["regressions"] == [case["id"]]
    assert (
        deploy_gate(
            guard_status=status, anchor=None, previous_anchor=None, thresholds=load_thresholds()
        ).exit_code
        == 1
    )

    if case_id != "wire-request-executed-copy":
        return
    bounded = deepcopy(broken)
    bounded["proposal"].update(
        description="Requested transfer instructions; completion unverified",
        coverage_summary="Requested amount only; completion unverified",
        utility_rationale="Useful request instructions; completion unverified",
    )
    bounded["proposal"]["pricing"]["rationale"] = "Request document only"
    assert (await run_case(bounded)).outcome == "accepted_clean"


async def test_suite_status_fails_on_an_untracked_regression():
    results = [await run_case(case) for case in load_cases()]
    status = suite_status(results)
    assert status["passed"] and not status["regressions"]
    results[0].outcome, results[0].known_gap = "accepted_with_defect", None
    assert suite_status(results)["passed"] is False

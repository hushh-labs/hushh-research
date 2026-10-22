"""Adversarial model outputs fed to the runtime validators must never end Ready with a
defect. Known runtime gaps are strict expected failures: when the runtime closes
one, its case passes unexpectedly and this suite asks for the marker to be removed.

Negative control: with the #8021 fence reverted (git revert --no-commit c3878efdad)
the wire-request case becomes Ready with an execution claim and goes red.
"""

import pytest

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


async def test_request_only_packet_is_ready_only_with_the_runtime_copy():
    case = next(item for item in load_cases() if item["id"] == "wire-request-executed-copy")
    result = await run_case(case)
    assert result.outcome == "accepted_clean"


async def test_suite_status_fails_on_an_untracked_regression():
    results = [await run_case(case) for case in load_cases()]
    status = suite_status(results)
    assert status["passed"] and not status["regressions"]
    results[0].outcome, results[0].known_gap = "accepted_with_defect", None
    assert suite_status(results)["passed"] is False

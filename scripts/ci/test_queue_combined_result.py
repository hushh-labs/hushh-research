"""Authority and reuse boundaries of the actual merge-result gate."""

import copy
import json
from unittest.mock import patch

import pytest

import queue_combined_result as queue

BASE, FIRST, SECOND, HEAD1, HEAD2 = (letter * 40 for letter in "abcde")


def entry(number, head, requester="kushaltrivedi5"):
    return {"id": f"entry-{number}", "position": number, "enqueuer": {"login": requester},
            "pullRequest": {"number": number, "headRefOid": head, "baseRefName": "main",
                            "state": "OPEN", "isDraft": False, "reviewDecision": "APPROVED"}}


def parents(*args):
    return {FIRST: f"{BASE} {HEAD1}", SECOND: f"{FIRST} {HEAD2}"}[args[-1]]


def test_every_stacked_member_is_bound_to_current_head_and_requester():
    rows = [entry(1, HEAD1), entry(2, HEAD2, "ankitkumarsingh1702")]
    result = queue.members(BASE, SECOND, rows, "main", parents)
    assert [(row["number"], row["requester"]) for row in result] == [
        (1, "kushaltrivedi5"), (2, "ankitkumarsingh1702")]


@pytest.mark.parametrize("rows", [
    [entry(2, HEAD2)], [entry(1, HEAD1), entry(2, HEAD2), entry(3, HEAD1)],
    [entry(1, "f" * 40), entry(2, HEAD2)],
])
def test_missing_ambiguous_or_replaced_member_refuses(rows):
    with pytest.raises(queue.Refused):
        queue.members(BASE, SECOND, rows, "main", parents)


def test_dismissed_review_refuses_even_with_same_source():
    row = entry(1, HEAD1)
    row["pullRequest"]["reviewDecision"] = "REVIEW_REQUIRED"
    with pytest.raises(queue.Refused):
        queue.members(BASE, FIRST, [row], "main", parents)


def test_authorized_author_cannot_replace_actual_enqueuer():
    policy = {"main": {"merge_users": ["kushaltrivedi5"],
                       "protected_pipeline_edit_users": ["kushaltrivedi5", "ankitkumarsingh1702"]},
              "production": {"manual_dispatch_users": ["kushaltrivedi5"]}}
    included = queue.members(BASE, FIRST, [entry(1, HEAD1, "someone-else")], "main", parents)
    with patch.object(queue, "git", return_value=json.dumps(policy)), pytest.raises(queue.Refused, match="actual queue requester"):
        queue.authorize("hushh-labs/hushh-research", "main", BASE, included)


def test_protected_edit_requires_current_review_not_author_identity():
    policy = {"main": {"merge_users": ["kushaltrivedi5"],
                       "protected_pipeline_edit_users": ["kushaltrivedi5", "ankitkumarsingh1702"],
                       "protected_pipeline_paths": [".github/workflows/"]},
              "production": {"manual_dispatch_users": ["kushaltrivedi5"]}}
    included = queue.members(BASE, FIRST, [entry(1, HEAD1)], "main", parents)
    def source(*args):
        return json.dumps(policy) if args[0] == "show" else ".github/workflows/ci.yml"
    with patch.object(queue, "git", side_effect=source), patch.object(queue, "api", return_value=[]):
        with pytest.raises(queue.Refused, match="current-head approval"):
            queue.authorize("hushh-labs/hushh-research", "main", BASE, included)


def receipt_fixture():
    state = {"repository": "hushh-labs/hushh-research", "base": BASE, "tree": FIRST}
    validation = {"run": 5, "attempt": 2, "number": 1, "head": HEAD1}
    receipt = {"version": 1, "repository": state["repository"], "event": "pull_request",
               "run": 5, "attempt": 2, "pr": 1, "head": HEAD1, "base": BASE,
               "tree": FIRST, "selection_exact": True, "level": "focused", "result": "success"}
    return state, validation, receipt


@pytest.mark.parametrize("field,value", [
    ("tree", SECOND), ("base", SECOND), ("attempt", 1), ("selection_exact", False),
    ("head", HEAD2), ("result", "cancelled"), ("level", "diagnostic"),
])
def test_only_identical_tested_inputs_can_be_reused(field, value):
    state, validation, receipt = receipt_fixture()
    assert queue.receipt_matches(receipt, state, validation)
    changed = copy.deepcopy(receipt)
    changed[field] = value
    assert not queue.receipt_matches(changed, state, validation)


def test_two_individually_green_prs_require_combined_execution():
    state, validation, _ = receipt_fixture()
    assert not queue.reusable(state, [validation, {**validation, "number": 2}],
                              read=lambda _: pytest.fail("Must not use a single-PR artifact"))


def test_missing_legacy_receipt_requests_checks_instead_of_branch_sync():
    state, validation, _ = receipt_fixture()
    assert not queue.reusable(state, [validation], read=lambda _: {"total_count": 0, "artifacts": []})


@pytest.mark.parametrize("later_state", ["failure", "in_progress"])
def test_new_attempt_during_inspection_invalidates_old_green(later_state):
    state = {"repository": "hushh-labs/hushh-research", "members": [{"number": 1, "head": HEAD1}]}
    run = {"id": 5, "path": ".github/workflows/ci.yml", "name": "PR Validation",
           "event": "pull_request", "head_sha": HEAD1, "status": "completed",
           "conclusion": "success", "created_at": "2026-11-03T01:00:00Z",
           "run_started_at": "2026-11-03T01:00:00Z", "updated_at": "2026-11-03T01:01:00Z",
           "run_attempt": 1, "pull_requests": [{"number": 1, "head": {"sha": HEAD1}}]}
    later = {**run, "id": 6, "run_started_at": "2026-11-03T02:00:00Z",
             "updated_at": "2026-11-03T02:01:00Z", "status": "completed" if later_state == "failure" else later_state,
             "conclusion": "failure" if later_state == "failure" else None}
    reads = 0
    def read(path):
        nonlocal reads
        if "/runs?" in path:
            reads += 1
            return {"total_count": reads, "workflow_runs": [run] if reads == 1 else [run, later]}
        if "/jobs?" in path:
            return {"total_count": 1, "jobs": [{"name": "CI Status Gate", "conclusion": "success"}]}
        return run
    owner = queue._module("verify-queue-entry-reuses-pr-validation.py", "queue_attempt_test_owner")
    with pytest.raises(owner.QueueEntryRejected, match="Competing validation"):
        with patch.object(queue, "_module", return_value=owner):
            queue.current_validations(state, read=read)

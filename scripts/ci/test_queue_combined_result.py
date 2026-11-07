"""Authority and reuse boundaries of the actual merge-result gate."""

import copy
import base64
import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

import queue_combined_result as queue

BASE, FIRST, SECOND, HEAD1, HEAD2 = (letter * 40 for letter in "abcde")


def entry(number, head, requester="kushaltrivedi5"):
    return {"id": f"entry-{number}", "position": number, "enqueuer": {"login": requester},
            "pullRequest": {"number": number, "headRefOid": head, "baseRefName": "main",
                            "state": "OPEN", "isDraft": False, "reviewDecision": "APPROVED",
                            "author": {"login": "kushaltrivedi5"}}}


def parents(*args):
    return {FIRST: f"{BASE} {HEAD1}", SECOND: f"{FIRST} {HEAD2}"}[args[-1]]


@pytest.mark.parametrize("branch", ["main", "dev", "uat", "integration/pr-train", "", "feature/other", "refs/tags/uat"])
def test_merge_group_context_accepts_only_protected_destination_refs(tmp_path, monkeypatch, branch):
    repository = "hushh-labs/hushh-research"
    event = tmp_path / "event.json"
    event.write_text(json.dumps({"action": "checks_requested", "repository": {"full_name": repository},
                                "merge_group": {"base_ref": f"refs/heads/{branch}",
                                                "base_sha": BASE, "head_sha": FIRST}}))
    for key, value in {"GITHUB_EVENT_PATH": str(event), "GITHUB_EVENT_NAME": "merge_group",
                       "GITHUB_REPOSITORY": repository, "GITHUB_SHA": FIRST}.items():
        monkeypatch.setenv(key, value)
    with patch.object(queue, "git", return_value=FIRST):
        if branch in queue.DESTINATIONS:
            assert queue.event_context()[:2] == (repository, branch)
        else:
            with pytest.raises(queue.Refused, match="Queue event"):
                queue.event_context()


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
    row["pullRequest"]["reviewDecision"] = "CHANGES_REQUESTED"
    with pytest.raises(queue.Refused):
        queue.members(BASE, FIRST, [row], "main", parents)


@pytest.mark.parametrize("change", [
    lambda pr: pr.pop("reviewDecision"),
    lambda pr: pr.update(reviewDecision="UNKNOWN"),
    lambda pr: pr.update(author={"login": ""}),
])
def test_absent_native_review_must_remain_explicit_and_owner_bound(change):
    row = entry(1, HEAD1)
    row["pullRequest"]["reviewDecision"] = None
    assert queue.members(BASE, FIRST, [row], "main", parents)[0]["review"] is None
    change(row["pullRequest"])
    with pytest.raises(queue.Refused):
        queue.members(BASE, FIRST, [row], "main", parents)


def null_review_policy():
    owners = ["kushaltrivedi5", "ankitkumarsingh1702"]
    return {"main": {"merge_users": owners + ["msainani"],
                     "protected_pipeline_edit_users": owners,
                     "protected_pipeline_paths": [".github/workflows/"],
                     "review_bypass_users": owners, "merge_queue_bypass_users": owners},
            "production": {"manual_dispatch_users": owners},
            "branch_flow": {"prepared_branches": {
                "dev": {"policy_key": "pr_train"}, "uat": {"policy_key": "uat_merge"}}},
            "pr_train": {"review_bypass_users": owners + ["parthmawai"],
                         "merge_queue_bypass_users": []},
            "uat_merge": {"review_bypass_users": owners + ["parthmawai"]}}


@pytest.mark.parametrize("native_review", [None, "APPROVED", "REVIEW_REQUIRED"])
@pytest.mark.parametrize("branch,author,requester,reviewer,state,commit,protected,allowed", [
    ("main", "kushaltrivedi5", "kushaltrivedi5", None, None, None, True, True),
    ("dev", "kushaltrivedi5", "kushaltrivedi5", None, None, None, True, True),
    ("uat", "ankitkumarsingh1702", "ankitkumarsingh1702", None, None, None, True, True),
    ("main", "msainani", "msainani", None, None, None, False, False),
    ("dev", "parthmawai", "parthmawai", None, None, None, False, True),
    ("uat", "parthmawai", "parthmawai", None, None, None, False, True),
    ("dev", "outside-user", "outside-user", None, None, None, False, False),
    ("uat", "outside-user", "outside-user", None, None, None, False, False),
    ("dev", "contributor", "parthmawai", None, None, None, False, False),
    ("main", "contributor", "msainani", "parthmawai", "APPROVED", HEAD1, False, True),
    ("main", "contributor", "outside-user", "parthmawai", "APPROVED", HEAD1, False, False),
    ("uat", "contributor", "contributor", "outside-user", "APPROVED", HEAD1, False, False),
    ("dev", "contributor", "parthmawai", "parthmawai", "APPROVED", HEAD2, False, False),
    ("uat", "contributor", "parthmawai", "contributor", "APPROVED", HEAD1, False, False),
    ("dev", "parthmawai", "parthmawai", None, None, None, True, False),
    ("uat", "parthmawai", "parthmawai", "ankitkumarsingh1702", "APPROVED", HEAD1, True, True),
    ("dev", "parthmawai", "parthmawai", "ankitkumarsingh1702", "APPROVED", HEAD2, True, False),
    ("main", "kushaltrivedi5", "kushaltrivedi5", "parthmawai", "CHANGES_REQUESTED", HEAD1, False, False),
    ("dev", "parthmawai", "parthmawai", "ankitkumarsingh1702", "DISMISSED", HEAD1, False, False),
])
def test_native_verdict_requires_current_review_or_exact_self_authority(
        native_review, branch, author, requester, reviewer, state, commit, protected, allowed):
    row = entry(1, HEAD1, requester)
    row["pullRequest"].update(author={"login": author}, reviewDecision=native_review, baseRefName=branch)
    included = queue.members(BASE, FIRST, [row], branch, parents)
    reviews = ([] if reviewer is None else [{"id": 1, "user": {"login": reviewer},
                                             "state": state, "commit_id": commit}])
    changed = ".github/workflows/ci.yml" if protected else "hushh-webapp/app/page.tsx"
    with patch.object(queue, "git", return_value=changed), patch.object(queue, "api", return_value=reviews):
        if allowed:
            result = queue.authorize("hushh-labs/hushh-research", branch, BASE, included,
                                     policy=null_review_policy())
            assert result[0]["review"] == native_review
            if author != requester:
                assert result[0]["approval_source"] == "current_head_review"
                assert result[0]["current_head_reviewers"] == [reviewer]
        else:
            with pytest.raises((queue.Refused, RuntimeError)):
                queue.authorize("hushh-labs/hushh-research", branch, BASE, included,
                                policy=null_review_policy())


def test_native_verdict_refuses_unbounded_review_inventory():
    row = entry(1, HEAD1)
    row["pullRequest"]["reviewDecision"] = None
    included = queue.members(BASE, FIRST, [row], "main", parents)
    reviews = [{"id": 1, "user": {"login": "parthmawai"},
                "state": "COMMENTED", "commit_id": HEAD1}] * 100
    with patch.object(queue, "git", return_value="hushh-webapp/app/page.tsx"), \
         patch.object(queue, "api", return_value=reviews), pytest.raises(RuntimeError, match="exceeded"):
        queue.authorize("hushh-labs/hushh-research", "main", BASE, included,
                        policy=null_review_policy())


def test_authorized_author_cannot_replace_actual_enqueuer():
    policy = {"main": {"merge_users": ["kushaltrivedi5"],
                       "protected_pipeline_edit_users": ["kushaltrivedi5", "ankitkumarsingh1702"]},
              "production": {"manual_dispatch_users": ["kushaltrivedi5"]}}
    included = queue.members(BASE, FIRST, [entry(1, HEAD1, "someone-else")], "main", parents)
    with patch.object(queue, "git", return_value=json.dumps(policy)), pytest.raises(queue.Refused, match="actual queue requester"):
        queue.authorize("hushh-labs/hushh-research", "main", BASE, included)


def test_protected_edit_requires_current_review_not_author_identity():
    policy = null_review_policy()
    policy["main"].update(review_bypass_users=[], merge_queue_bypass_users=[])
    included = queue.members(BASE, FIRST, [entry(1, HEAD1)], "main", parents)
    def source(*args):
        return json.dumps(policy) if args[0] == "show" else ".github/workflows/ci.yml"
    ordinary_review = [{"id": 1, "user": {"login": "parthmawai"},
                        "state": "APPROVED", "commit_id": HEAD1}]
    with patch.object(queue, "git", side_effect=source), patch.object(queue, "api", return_value=ordinary_review):
        with pytest.raises(queue.Refused, match="current-head approval"):
            queue.authorize("hushh-labs/hushh-research", "main", BASE, included)


@pytest.mark.parametrize("author,requester,review,allowed", [
    ("kushaltrivedi5", "kushaltrivedi5", "REVIEW_REQUIRED", True),
    ("kushaltrivedi5", "kushaltrivedi5", "APPROVED", True),
    ("ankitkumarsingh1702", "ankitkumarsingh1702", "REVIEW_REQUIRED", True),
    ("contributor", "kushaltrivedi5", "REVIEW_REQUIRED", False),
    ("kushaltrivedi5", "msainani", "REVIEW_REQUIRED", False),
    ("msainani", "msainani", "REVIEW_REQUIRED", False),
])
@pytest.mark.parametrize("branch", ["main", "dev", "uat", "integration/pr-train"])
def test_owner_self_approval_is_an_explicit_matching_queue_request(author, requester, review, allowed, branch):
    policy = null_review_policy()
    row = entry(1, HEAD1, requester)
    row["pullRequest"].update(author={"login": author}, reviewDecision=review, baseRefName=branch)
    included = queue.members(BASE, FIRST, [row], branch, parents)
    def source(*args):
        return json.dumps(policy) if args[0] == "show" else ".github/workflows/ci.yml"
    with patch.object(queue, "git", side_effect=source), patch.object(queue, "api", return_value=[]):
        if allowed:
            result = queue.authorize("hushh-labs/hushh-research", branch, BASE, included)
            assert result[0]["protected_approvals"] == [requester]
            assert result[0]["approval_source"] == "owner_queue_request"
        else:
            with pytest.raises(queue.Refused, match="current review"):
                queue.authorize("hushh-labs/hushh-research", branch, BASE, included)


@pytest.mark.parametrize("branch,lane", [("dev", "pr_train"), ("uat", "uat_merge")])
def test_maintainer_self_landing_keeps_protected_owner_approval_separate(branch, lane):
    policy = null_review_policy()
    policy[lane]["review_bypass_users"] = ["parthmawai"]
    row = entry(1, HEAD1, "parthmawai")
    row["pullRequest"].update(author={"login": "parthmawai"},
                              reviewDecision="REVIEW_REQUIRED", baseRefName=branch)
    def included():
        return queue.members(BASE, FIRST, [row], branch, parents)
    with patch.object(queue, "git", return_value="hushh-webapp/app/page.tsx"), \
         patch.object(queue, "api", return_value=[]):
        result = queue.authorize("hushh-labs/hushh-research", branch, BASE, included(), policy=policy)
        assert result[0]["approval_source"] == "maintainer_queue_request"
    with patch.object(queue, "git", return_value=".github/workflows/ci.yml"), \
         patch.object(queue, "api", return_value=[]):
        with pytest.raises(queue.Refused, match="current-head approval"):
            queue.authorize("hushh-labs/hushh-research", branch, BASE, included(), policy=policy)
    owner_review = [{"id": 1, "user": {"login": "ankitkumarsingh1702"},
                     "state": "APPROVED", "commit_id": HEAD1}]
    with patch.object(queue, "git", return_value=".github/workflows/ci.yml"), \
         patch.object(queue, "api", return_value=owner_review):
        result = queue.authorize("hushh-labs/hushh-research", branch, BASE, included(), policy=policy)
        assert result[0]["protected_approvals"] == ["ankitkumarsingh1702"]
    row["pullRequest"]["author"] = {"login": "another-user"}
    with patch.object(queue, "git", return_value="hushh-webapp/app/page.tsx"), \
         patch.object(queue, "api", return_value=[]):
        with pytest.raises(queue.Refused, match="current review"):
            queue.authorize("hushh-labs/hushh-research", branch, BASE, included(), policy=policy)


def test_dev_authority_is_read_from_the_exact_current_main_revision():
    policy = {"main": {}, "pr_train": {"review_bypass_users": ["parthmawai"]}}
    encoded = base64.b64encode(json.dumps(policy).encode()).decode()
    def read(path):
        if path.endswith("/git/ref/heads/main"):
            return {"object": {"type": "commit", "sha": HEAD1}}
        assert path.endswith(f"config/ci-governance.json?ref={HEAD1}")
        return {"path": "config/ci-governance.json", "encoding": "base64", "content": encoded}
    with patch.object(queue, "api", side_effect=read):
        assert queue.authority_policy("hushh-labs/hushh-research", "dev", BASE) == (HEAD1, policy)
        assert queue.authority_policy(
            "hushh-labs/hushh-research", "uat-isolated", BASE, owner_admin=True
        ) == (HEAD1, policy)
    with patch.object(queue, "api") as api, patch.object(queue, "git", return_value=json.dumps(policy)):
        assert queue.authority_policy("hushh-labs/hushh-research", "uat-isolated", BASE) == (BASE, policy)
        api.assert_not_called()
    with patch.object(queue, "api", return_value={"object": {"sha": HEAD1}}):
        with pytest.raises(queue.Refused, match="authority"):
            queue.authority_policy("hushh-labs/hushh-research", "dev", BASE)
    def malformed(path):
        if path.endswith("/git/ref/heads/main"):
            return {"object": {"type": "commit", "sha": HEAD1}}
        return {"path": "config/ci-governance.json", "encoding": "base64", "content": "not-base64!"}
    with patch.object(queue, "api", side_effect=malformed):
        with pytest.raises(queue.Refused, match="malformed"):
            queue.authority_policy("hushh-labs/hushh-research", "uat", BASE)


@pytest.mark.parametrize("state,commit", [("APPROVED", HEAD2), ("DISMISSED", HEAD1),
                                          ("CHANGES_REQUESTED", HEAD1)])
def test_dev_maintainer_cannot_use_stale_or_withdrawn_owner_review(state, commit):
    owners = ["kushaltrivedi5", "ankitkumarsingh1702"]
    policy = {"main": {"merge_users": owners, "review_bypass_users": owners,
                       "protected_pipeline_edit_users": owners,
                       "protected_pipeline_paths": [".github/workflows/"]},
              "production": {"manual_dispatch_users": owners},
              "branch_flow": {"prepared_branches": {"dev": {"policy_key": "pr_train"}}},
              "pr_train": {"review_bypass_users": ["parthmawai"]}}
    row = entry(1, HEAD1, "parthmawai")
    row["pullRequest"].update(author={"login": "parthmawai"},
                              reviewDecision="REVIEW_REQUIRED", baseRefName="dev")
    included = queue.members(BASE, FIRST, [row], "dev", parents)
    reviews = [{"id": 1, "user": {"login": "kushaltrivedi5"}, "state": state, "commit_id": commit}]
    with patch.object(queue, "git", return_value=".github/workflows/ci.yml"), \
         patch.object(queue, "api", return_value=reviews):
        with pytest.raises((queue.Refused, RuntimeError)):
            queue.authorize("hushh-labs/hushh-research", "dev", BASE, included, policy=policy)


def test_queue_finish_refuses_when_main_authority_changes(tmp_path):
    receipt = tmp_path / "queue.json"
    original = {"base": BASE, "policy_revision": HEAD1}
    receipt.write_text(json.dumps({"state": original, "validations": [], "reuse": False}))
    changed = {**original, "policy_revision": HEAD2}
    with patch.object(sys, "argv", ["queue_combined_result.py", "finish", "--receipt", str(receipt)]), \
         patch.object(queue, "snapshot", return_value=changed), \
         patch.object(queue, "current_validations", return_value=[]):
        with pytest.raises(queue.Refused, match="changed"):
            queue.main()


@pytest.mark.parametrize("branch,change,allowed", [
    ("uat", "main_commit", True), ("dev", "main_commit", True),
    ("uat", "main_writer", True), ("dev", "main_writer", True),
    ("main", "main_writer", False),
    ("uat", "mergers", False), ("uat", "protected_owners", False),
    ("uat", "maintainers", False), ("uat", "unknown_policy", False),
    ("uat", "base", False), ("uat", "head", False), ("uat", "tree", False),
    ("uat", "members", False), ("uat", "attempt", False),
    ("uat", "missing_fingerprint", False), ("uat", "malformed_fingerprint", False),
])
def test_queue_finish_distinguishes_policy_inputs_from_main_provenance(tmp_path, monkeypatch, branch, change, allowed):
    policy = {"main": {"restrict_writes_to_merge_users": True,
                       "merge_users": ["merger"], "protected_pipeline_edit_users": ["owner"]},
              "uat_merge": {"review_bypass_users": ["maintainer"]}}
    original = {"branch": branch, "base": BASE, "head": HEAD1, "tree": FIRST,
                "members": [{"requester": "maintainer", "protected_approvals": ["owner"]}],
                "policy_revision": HEAD1, "policy_fingerprint": queue.policy_fingerprint(policy, branch)}
    updated = copy.deepcopy(policy)
    current = copy.deepcopy(original)
    current["policy_revision"] = HEAD2
    validations = [{"run": 1, "attempt": 1}]
    if change == "main_writer":
        updated["main"]["restrict_writes_to_merge_users"] = False
    if change == "mergers":
        updated["main"]["merge_users"] = ["replacement"]
    if change == "protected_owners":
        updated["main"]["protected_pipeline_edit_users"] = ["replacement"]
    if change == "maintainers":
        updated["uat_merge"]["review_bypass_users"] = []
    if change == "unknown_policy":
        updated["new_authority"] = True
    current["policy_fingerprint"] = queue.policy_fingerprint(updated, branch)
    if change in ("base", "head", "tree"):
        current[change] = SECOND
    if change == "members":
        current["members"][0]["protected_approvals"] = []
    if change == "attempt":
        validations[0]["attempt"] = 2
    if change == "missing_fingerprint":
        original.pop("policy_fingerprint")
    if change == "malformed_fingerprint":
        original["policy_fingerprint"] = "invalid"
    receipt = tmp_path / "queue.json"
    receipt.write_text(json.dumps({"state": original, "validations": [{"run": 1, "attempt": 1}], "reuse": False}))
    monkeypatch.setenv("COMBINED_RESULT", "success")
    with patch.object(sys, "argv", ["queue_combined_result.py", "finish", "--receipt", str(receipt)]), \
         patch.object(queue, "snapshot", return_value=current) as snapshot, \
         patch.object(queue, "current_validations", return_value=validations):
        if allowed:
            queue.main()
        else:
            with pytest.raises(queue.Refused, match="changed"):
                queue.main()
        snapshot.assert_called_once()
    assert policy["main"]["restrict_writes_to_merge_users"] is True

@pytest.mark.parametrize("state", ["CHANGES_REQUESTED", "DISMISSED", "unknown"])
def test_owner_queue_request_cannot_silently_override_review_history(state):
    guard = queue._module("verify-protected-pipeline-edits.py", "owner_review_history")
    rows = [{"id": 1, "user": {"login": "reviewer"}, "state": state, "commit_id": HEAD1}]
    with pytest.raises((guard.PolicyError, guard.GuardResolutionError)):
        guard.require_uncontested_owner_approval("hushh-labs/hushh-research", 1, HEAD1, read=lambda _: rows)
    if state != "unknown":
        rows.append({"id": 2, "user": {"login": "reviewer"}, "state": "APPROVED", "commit_id": HEAD1})
        guard.require_uncontested_owner_approval("hushh-labs/hushh-research", 1, HEAD1, read=lambda _: rows)


@pytest.mark.parametrize("commit", [None, "", "invalid"])
def test_owner_queue_request_refuses_unbound_decisive_review(commit):
    guard = queue._module("verify-protected-pipeline-edits.py", "owner_review_commit")
    rows = [{"id": 1, "user": {"login": "reviewer"}, "state": "DISMISSED", "commit_id": commit}]
    with pytest.raises(guard.GuardResolutionError, match="verified commit"):
        guard.require_uncontested_owner_approval("hushh-labs/hushh-research", 1, HEAD1, read=lambda _: rows)


def test_owner_queue_request_refuses_incomplete_review_inventory():
    guard = queue._module("verify-protected-pipeline-edits.py", "owner_review_inventory")
    rows = [{"id": 1, "user": {"login": "reviewer"}, "state": "COMMENTED", "commit_id": HEAD1}] * 100
    with pytest.raises(guard.GuardResolutionError, match="exceeded"):
        guard.require_uncontested_owner_approval("hushh-labs/hushh-research", 1, HEAD1, read=lambda _: rows)


def receipt_fixture():
    state = {"repository": "hushh-labs/hushh-research", "base": BASE, "tree": FIRST}
    validation = {"run": 5, "attempt": 2, "number": 1, "head": HEAD1}
    receipt = {"version": 2, "repository": state["repository"], "event": "pull_request",
               "run": 5, "attempt": 2, "pr": 1, "head": HEAD1, "base": BASE,
               "tree": FIRST, "selection_exact": True, "level": "focused", "result": "success"}
    return state, validation, receipt


@pytest.mark.parametrize("field,value", [
    ("tree", SECOND), ("base", SECOND), ("attempt", 1), ("selection_exact", False),
    ("head", HEAD2), ("result", "cancelled"), ("level", "diagnostic"), ("version", 1),
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


def test_owner_admin_rechecks_inputs_before_mutation(tmp_path):
    proof = {"state": {"repository": "hushh-labs/hushh-research", "branch": "main", "base": BASE, "tree": FIRST}}
    changed = copy.deepcopy(proof)
    changed["state"]["base"] = SECOND
    with patch.object(queue, "owner_admin_snapshot", side_effect=[proof, changed]), \
         patch.object(queue.subprocess, "run") as write:
        with pytest.raises(queue.Refused, match="changed before merge"):
            queue.owner_admin_merge(8825, HEAD1, tmp_path / "receipt.json", apply=True)
        write.assert_not_called()


@pytest.mark.parametrize("request_exit", [0, 1, "timeout"])
def test_owner_admin_reconciles_response_without_second_merge(tmp_path, request_exit):
    from types import SimpleNamespace
    proof = {"state": {"repository": "hushh-labs/hushh-research", "branch": "main", "base": BASE, "tree": FIRST}}
    commit = {"tree": {"sha": FIRST}, "parents": [{"sha": BASE}, {"sha": HEAD1}]}
    with patch.object(queue, "owner_admin_snapshot", return_value=proof), \
         patch.object(queue.subprocess, "run", return_value=SimpleNamespace(returncode=request_exit),
                      side_effect=queue.subprocess.TimeoutExpired("gh", 60) if request_exit == "timeout" else None) as write, \
         patch.object(queue, "api", side_effect=[{"merged": True, "merge_commit_sha": SECOND}, commit]):
        receipt = tmp_path / "receipt.json"
        queue.owner_admin_merge(8825, HEAD1, receipt, apply=True)
        write.assert_called_once()
        assert json.loads(receipt.read_text())["landed"] == SECOND


@pytest.mark.parametrize("changed", ["base", "tree", "unreadable"])
def test_owner_admin_records_confirmed_unqualified_landing_before_refusal(tmp_path, changed):
    from types import SimpleNamespace
    proof = {"state": {"repository": "hushh-labs/hushh-research", "branch": "uat", "base": BASE, "tree": FIRST}}
    commit = {"tree": {"sha": SECOND if changed == "tree" else FIRST},
              "parents": [{"sha": SECOND if changed == "base" else BASE}, {"sha": HEAD1}]}
    readback = queue.subprocess.CalledProcessError(1, "gh") if changed == "unreadable" else commit
    with patch.object(queue, "owner_admin_snapshot", return_value=proof), \
         patch.object(queue.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as write, \
         patch.object(queue, "api", side_effect=[{"merged": True, "merge_commit_sha": SECOND}, readback]):
        receipt = tmp_path / "receipt.json"
        with pytest.raises((queue.Refused, queue.subprocess.CalledProcessError)):
            queue.owner_admin_merge(9052, HEAD1, receipt, apply=True)
        write.assert_called_once()
        result = json.loads(receipt.read_text())
        assert result["outcome"] == "merged_unqualified"
        assert result["landed"] == SECOND
        assert result["state"] == proof["state"]
        if changed != "unreadable":
            assert result["observed_commit"] == {
                "tree": commit["tree"]["sha"], "parents": [p["sha"] for p in commit["parents"]]}


def test_owner_admin_never_replays_unconfirmed_merge(tmp_path):
    from types import SimpleNamespace
    proof = {"state": {"repository": "hushh-labs/hushh-research", "branch": "main", "base": BASE, "tree": FIRST}}
    with patch.object(queue, "owner_admin_snapshot", return_value=proof), \
         patch.object(queue.subprocess, "run", return_value=SimpleNamespace(returncode=1)) as write, \
         patch.object(queue, "api", return_value={"merged": False}):
        receipt = tmp_path / "receipt.json"
        with pytest.raises(queue.Refused, match="not confirmed"):
            queue.owner_admin_merge(8825, HEAD1, receipt, apply=True)
        write.assert_called_once()
        assert json.loads(receipt.read_text())["outcome"] == "not_confirmed"


@pytest.mark.parametrize("actor,author", [("outsider", "outsider"), ("kushaltrivedi5", "someone-else")])
def test_owner_admin_requires_same_named_owner_not_org_admin_status(actor, author):
    repo = "hushh-labs/hushh-research"
    policy = {"main": {"merge_users": ["kushaltrivedi5"],
                       "merge_queue_bypass_users": ["kushaltrivedi5"],
                       "review_bypass_users": ["kushaltrivedi5"],
                       "protected_pipeline_edit_users": ["kushaltrivedi5"]}}
    pr = {"state": "open", "draft": False, "head": {"sha": HEAD1, "repo": {"full_name": repo}},
          "base": {"ref": "main", "sha": BASE}, "user": {"login": author}}
    with patch.object(queue, "api", side_effect=[{"login": actor}, pr, {"object": {"sha": BASE}}]), \
         patch.object(queue, "git", return_value=json.dumps(policy)), \
         patch.object(queue.subprocess, "run") as run:
        with pytest.raises(queue.Refused, match="Only the named owner"):
            queue.owner_admin_snapshot(8825, HEAD1)
        assert run.call_count == 1 and run.call_args.args[0][:2] == ["git", "fetch"]


@pytest.mark.parametrize("branch", ["main", "dev", "uat", "uat-isolated"])
def test_owner_admin_binds_destination_policy_guard_and_exact_tree(branch):
    from types import SimpleNamespace
    from pathlib import Path
    import prepared_branch_governance as prepared
    import github_team_authority as team

    repository = "hushh-labs/hushh-research"
    policy = json.loads((Path(__file__).resolve().parents[2] / "config/ci-governance.json").read_text())
    actor = "kushaltrivedi5"
    pr = {"state": "open", "draft": False,
          "head": {"sha": HEAD1, "repo": {"full_name": repository}},
          "base": {"ref": branch, "sha": BASE}, "user": {"login": actor}}
    seen = []
    governance = SimpleNamespace(reconcile_owner_admin_ruleset=lambda p, **kw: seen.append(kw))
    guard = SimpleNamespace(resolve_allowed_users=lambda p: p["protected_pipeline_edit_users"],
                            require_uncontested_owner_approval=lambda *a, **kw: None)
    modules = {"apply-governance.py": governance, "verify-protected-pipeline-edits.py": guard,
               "prepared_branch_governance.py": prepared}
    def git(*args):
        return json.dumps(policy) if args[0] == "show" else FIRST
    threads = {"data": {"repository": {"pullRequest": {"reviewThreads": {
        "totalCount": 0, "pageInfo": {"hasNextPage": False}, "nodes": []}}}}}
    with patch.object(queue, "api", side_effect=[{"login": actor}, pr, {"object": {"sha": BASE}}]) as api, \
         patch.object(team, "local_policy", return_value=policy) as team_policy, \
         patch.object(team, "consume_main", return_value={}) as main_receipt, \
         patch.object(team, "require_gate", return_value=42) as native_gate, \
         patch.object(queue, "git", side_effect=git), \
         patch.object(queue, "authority_policy", return_value=(BASE, policy)) as authority, \
         patch.object(queue, "_module", side_effect=lambda name, *_: modules[name]), \
         patch.object(queue, "current_validations", return_value=[{"run":40,"attempt":2}]), \
         patch.object(queue, "reusable", return_value=True), \
         patch.object(queue.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run, \
         patch.object(queue.subprocess, "check_output", return_value=json.dumps(threads)):
        proof = queue.owner_admin_snapshot(8891, HEAD1)
    assert proof["state"]["branch"] == branch and proof["state"]["tree"] == FIRST
    authority.assert_called_once_with(repository, branch, BASE, owner_admin=True)
    team_policy.assert_called_once_with(policy, actor=actor, read=api)
    if policy.get("authorization", {}).get("mode") == "enforce":
        main_receipt.assert_called_once_with(api, {"id":40,"run_attempt":2,"head_sha":HEAD1}, require_barrier=True)
        native_gate.assert_called_once_with(branch,read=api)
    assert api.call_args_list[-1].args == (f"repos/{repository}/git/ref/heads/{branch}",)
    assert seen == [{"branch": branch, "verify_only": True}]
    assert run.call_args_list[0].args[0][3] == branch
    assert run.call_args_list[1].kwargs["env"]["GITHUB_BRANCH"] == branch


def test_semantic_pipeline_guard_uses_actual_main_callers_without_gating_local_scripts():
    import subprocess
    guard = queue._module("verify-protected-pipeline-edits.py", "semantic_actual_main")
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    manifest = "hushh-webapp/package.json"
    baseline = json.loads(subprocess.check_output(["git", "show", f"{revision}:{manifest}"], text=True))
    roots = guard._ci_npm_roots(revision)
    reachable = guard._reachable_npm_scripts(baseline["scripts"], roots)
    assert {"lint", "typecheck", "verify:account-session"} <= reachable
    assert not {"dev", "format"} & reachable
    assert guard.semantic_pipeline_changes(list(guard.SEMANTIC_PIPELINE_PATHS), base=revision, head=revision) == []
    for kind in ("dependency", "dev", "format", "lint", "prelint", "transitive"):
        before, after = copy.deepcopy(baseline), copy.deepcopy(baseline)
        if kind == "dependency":
            after.setdefault("devDependencies", {})["some-package"] = "1.2.3"
        elif kind == "transitive":
            before["scripts"]["lint"] = after["scripts"]["lint"] = "npm run internal:ci"
            before["scripts"]["internal:ci"] = "eslint ."
            after["scripts"]["internal:ci"] = "echo bypass"
        else:
            after["scripts"][kind] = "echo changed"
        def read(rev, path):
            assert path == manifest and rev in {BASE, HEAD1}
            return json.dumps(before if rev == BASE else after)
        result = guard.semantic_pipeline_changes([manifest], base=BASE, head=HEAD1, authority=revision,
                                                 read_blob=read, script_roots=roots)
        assert result == ([manifest] if kind in {"lint", "prelint", "transitive"} else [])
    assert guard.semantic_pipeline_changes(["hushh-webapp/app/page.tsx"], base=None, head=None,
                                           read_blob=lambda *_: pytest.fail("Unrelated product read manifests")) == []


@pytest.mark.parametrize("malformed", ["{", "[]", '{"scripts":null}', '{"scripts":{"lint":false}}'])
def test_semantic_pipeline_guard_refuses_malformed_or_deleted_manifest(malformed):
    import subprocess
    guard = queue._module("verify-protected-pipeline-edits.py", "semantic_bad_manifest")
    with pytest.raises(guard.GuardResolutionError):
        guard.semantic_pipeline_changes(["hushh-webapp/package.json"], base=BASE, head=HEAD1,
            read_blob=lambda *_: malformed, script_roots={"lint"})
    with pytest.raises(guard.GuardResolutionError):
        guard.semantic_pipeline_changes(["hushh-webapp/package.json"], base=BASE, head=HEAD1,
            read_blob=lambda *_: (_ for _ in ()).throw(subprocess.CalledProcessError(128, "git show")), script_roots={"lint"})


def test_semantic_backend_manifest_allows_additions_but_protects_removal_and_refuses_options():
    guard = queue._module("verify-protected-pipeline-edits.py", "semantic_backend_manifest")
    path = "consent-protocol/scripts/test-ci.manifest.txt"
    before = "# lifecycle\ntests/test_lifecycle.py\ntests/test_owner.py\n"
    for after, expected in ((before + "tests/test_new.py\n", []),
                            (before + "# another comment\n", []),
                            ("tests/test_lifecycle.py\n", [path])):
        assert guard.semantic_pipeline_changes([path], base=BASE, head=HEAD1,
            read_blob=lambda revision, _: before if revision == BASE else after) == expected
    for addition in ("--ignore=tests", "tests/../elsewhere.py", "tests/test_x.py -k harmless", "tests/test_x.py;echo", "tests/test_owner.py"):
        with pytest.raises(guard.GuardResolutionError):
            guard.semantic_pipeline_changes([path], base=BASE, head=HEAD1,
                read_blob=lambda revision, _: before if revision == BASE else before + addition + "\n")


@pytest.mark.parametrize("script_changed,owner_review,allowed", [(False, False, True), (True, False, False), (True, True, True)])
def test_trusted_queue_requires_owner_only_for_ci_manifest_script_changes(script_changed, owner_review, allowed):
    guard = queue._module("verify-protected-pipeline-edits.py", "semantic_queue_guard")
    semantic = guard.semantic_pipeline_changes
    before = {"scripts": {"lint": "eslint .", "dev": "next dev"}}
    after = copy.deepcopy(before)
    after["scripts"]["lint" if script_changed else "dev"] = "echo changed"
    def check(paths, **kwargs):
        return semantic(paths, **kwargs, script_roots={"lint"},
            read_blob=lambda revision, _: json.dumps(before if revision == BASE else after))
    guard.semantic_pipeline_changes = check
    original_module = queue._module
    def module(name, label):
        return guard if name == "verify-protected-pipeline-edits.py" else original_module(name, label)
    row = entry(1, HEAD1, "parthmawai")
    row["pullRequest"].update(author={"login": "parthmawai"}, reviewDecision=None, baseRefName="dev")
    included = queue.members(BASE, FIRST, [row], "dev", parents)
    reviews = ([{"id": 1, "user": {"login": "ankitkumarsingh1702"}, "state": "APPROVED", "commit_id": HEAD1}]
               if owner_review else [])
    with patch.object(queue, "_module", side_effect=module), \
         patch.object(queue, "git", side_effect=lambda *args: BASE if args[0] == "rev-parse" else "hushh-webapp/package.json"), \
         patch.object(queue, "api", return_value=reviews):
        if allowed:
            queue.authorize("hushh-labs/hushh-research", "dev", BASE, included, policy=null_review_policy())
        else:
            with pytest.raises(queue.Refused, match="current-head approval"):
                queue.authorize("hushh-labs/hushh-research", "dev", BASE, included, policy=null_review_policy())


def test_pr_semantic_guard_attributes_authored_manifest_changes_not_destination_additions(tmp_path, monkeypatch):
    import subprocess

    guard = queue._module("verify-protected-pipeline-edits.py", "authored_semantic_guard")
    repository = tmp_path / "repository"
    repository.mkdir()

    def git(*args):
        return subprocess.check_output(["git", *args], cwd=repository, text=True).strip()

    git("init", "-q")
    git("config", "user.name", "Synthetic reviewer")
    git("config", "user.email", "synthetic@example.invalid")
    manifest = "consent-protocol/scripts/test-ci.manifest.txt"
    (repository / "consent-protocol/scripts").mkdir(parents=True)
    (repository / "config").mkdir()
    (repository / "config/ci-governance.json").write_text(json.dumps({"main": {
        "protected_pipeline_edit_users": ["kushaltrivedi5"], "protected_pipeline_paths": ["scripts/ci/"]}}))

    def commit(tests):
        (repository / manifest).write_text(tests)
        git("add", ".")
        git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture")
        return git("rev-parse", "HEAD")

    seed = commit("tests/a.py\n")
    target = commit("tests/a.py\ntests/b.py\n")
    git("checkout", "-qb", "feature", seed)
    head = commit("tests/a.py\ntests/c.py\n")
    monkeypatch.chdir(repository)
    monkeypatch.setattr(guard, "REPO_ROOT", repository)
    monkeypatch.setattr(guard, "_files_from_event", lambda _args: [manifest])
    with patch.object(guard, "_owner_approvals", return_value=[]) as approvals:
        event = tmp_path / "event.json"
        monkeypatch.setenv("GITHUB_EVENT_NAME", "pull_request")
        monkeypatch.setenv("GITHUB_EVENT_PATH", str(event))
        monkeypatch.setenv("GITHUB_REPOSITORY", "hushh-labs/hushh-research")
        monkeypatch.setattr(sys, "argv", ["verify-protected-pipeline-edits.py"])

        def request(candidate):
            event.write_text(json.dumps({"pull_request": {
                "number": 1, "user": {"login": "imsharukhan"},
                "base": {"sha": target}, "head": {"sha": candidate}}}))
            return guard.main()

        # The prior direct-tip comparison mistakes B's absence for a deletion.
        assert guard.semantic_pipeline_changes([manifest], base=target, head=head) == [manifest]
        semantic = guard.semantic_pipeline_changes
        with patch.object(guard, "semantic_pipeline_changes", wraps=semantic) as classification:
            assert request(head) == 0
        assert classification.call_args.kwargs["base"] == seed
        assert classification.call_args.kwargs["authority"] == target
        approvals.assert_not_called()
        removed = commit("tests/c.py\n")
        assert request(removed) == 1
        assert approvals.call_count == 1
        with pytest.raises(guard.GuardResolutionError, match="unavailable"):
            request("f" * 40)


def test_authored_manifest_comparison_refuses_ambiguous_history(tmp_path):
    guard = queue._module("verify-protected-pipeline-edits.py", "ambiguous_semantic_guard")
    with patch("process_group.bounded_stdout", return_value=f"{BASE}\n{HEAD1}\n".encode()):
        with pytest.raises(guard.GuardResolutionError, match="ambiguous"):
            guard.authored_change_base(BASE, HEAD1, repository_root=tmp_path)


def test_semantic_guard_reads_candidate_objects_from_separate_shallow_authority(tmp_path):
    import importlib.util
    import os
    import shutil
    import subprocess
    from pathlib import Path

    source, authority, candidate = (tmp_path / name for name in ("source", "authority", "candidate"))
    source.mkdir()
    def git(*args, cwd=source):
        return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()
    git("init", "-q")
    git("config", "user.name", "Synthetic reviewer")
    git("config", "user.email", "synthetic@example.invalid")
    def commit():
        git("add", ".")
        git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture")
        return git("rev-parse", "HEAD")
    manifest = "hushh-webapp/package.json"
    for directory in ("scripts/ci", ".github/workflows", "hushh-webapp", "config"):
        (source / directory).mkdir(parents=True, exist_ok=True)
    guard_path = Path(__file__).with_name("verify-protected-pipeline-edits.py")
    shutil.copyfile(guard_path, source / "scripts/ci/verify-protected-pipeline-edits.py")
    (source / ".github/workflows/ci.yml").write_text("run: npm run lint\n")
    (source / "config/ci-governance.json").write_text(json.dumps({"main": {
        "protected_pipeline_edit_users": ["kushaltrivedi5"], "protected_pipeline_paths": ["scripts/ci/"]}}))
    before = {"scripts": {"lint": "eslint .", "dev": "next dev"}}
    (source / manifest).write_text(json.dumps(before))
    base = commit()
    git("clone", "--depth", "1", source.as_uri(), str(authority), cwd=tmp_path)
    (source / manifest).write_text(json.dumps({"scripts": {"lint": "echo bypass", "dev": "next dev"}}))
    head = commit()
    git("clone", "--no-local", str(source), str(candidate), cwd=tmp_path)
    assert subprocess.run(["git", "cat-file", "-e", head], cwd=authority, capture_output=True).returncode != 0
    spec = importlib.util.spec_from_file_location("separate_shallow_guard", authority / "scripts/ci/verify-protected-pipeline-edits.py")
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    assert guard.semantic_pipeline_changes([manifest], base=base, head=head, authority=base,
                                           repository_root=candidate) == [manifest]
    # New Main caller objects need not be in the earlier candidate checkout.
    (source / ".github/workflows/ci.yml").write_text("run: npm run lint\nrun: npm run extra:ci\n")
    latest = commit()
    assert subprocess.run(["git", "cat-file", "-e", latest], cwd=candidate, capture_output=True).returncode != 0
    assert "extra:ci" in guard._ci_npm_roots(latest, repository_root=candidate)
    command = [sys.executable, str(authority / "scripts/ci/verify-protected-pipeline-edits.py"),
               "--files", manifest, "--base-sha", base, "--head-sha", head, "--actor", "ordinary-contributor"]
    event = tmp_path / "pull-request-event.json"
    event.write_text(json.dumps({"pull_request": {"base": {"sha": base}}}))
    env = {**os.environ, "GITHUB_EVENT_NAME": "pull_request", "GITHUB_EVENT_PATH": str(event)}
    result = subprocess.run(command, cwd=candidate, text=True, capture_output=True, env=env)
    assert result.returncode == 1 and "non-sanctioned actor" in result.stdout, result.stdout + result.stderr
    dependency_only = copy.deepcopy(before)
    dependency_only["dependencies"] = {"example": "1.0.0"}
    (source / manifest).write_text(json.dumps(dependency_only))
    clean_head = commit()
    git("fetch", "origin", clean_head, cwd=candidate)
    command[command.index("--head-sha") + 1] = clean_head
    result = subprocess.run(command, cwd=candidate, text=True, capture_output=True, env=env)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.fixture
def tested_pr_merge(tmp_path, monkeypatch):
    """Real merge of a behind feature, with edits on independent lines."""
    import subprocess

    monkeypatch.chdir(tmp_path)
    def git(*args):
        return subprocess.check_output(["git", "-c", "core.hooksPath=/dev/null",
                                       "-c", "commit.gpgsign=false", *args], text=True).strip()
    git("init", "-q")
    git("config", "user.name", "Synthetic reviewer")
    git("config", "user.email", "synthetic@example.invalid")
    content = [f"line {number}\n" for number in range(30)]
    (tmp_path / "shared.txt").write_text("".join(content))
    git("add", ".")
    git("commit", "-qm", "seed")
    seed = git("rev-parse", "HEAD")

    def merge(destination_file="shared.txt", *, rename=False):
        git("checkout", "-q", "--detach", seed)
        if destination_file == "shared.txt":
            changed = content.copy()
            changed[2] = "destination edit\n"
            (tmp_path / destination_file).write_text("".join(changed))
        else:
            (tmp_path / destination_file).write_text("destination only\n")
        git("add", ".")
        git("commit", "-qm", "destination")
        base = git("rev-parse", "HEAD")
        git("checkout", "-q", "--detach", seed)
        changed = content.copy()
        changed[28] = "feature edit\n"
        (tmp_path / "shared.txt").write_text("".join(changed))
        if rename:
            git("mv", "shared.txt", "renamed.txt")
        git("add", ".")
        git("commit", "-qm", "feature")
        head = git("rev-parse", "HEAD")
        git("checkout", "-q", "--detach", base)
        git("merge", "--no-ff", "--no-edit", head)
        event = tmp_path / "event.json"
        event.write_text(json.dumps({"pull_request": {"number": 1,
                         "base": {"sha": base}, "head": {"sha": head}}}))
        for key, value in {"GITHUB_EVENT_PATH": str(event), "GITHUB_EVENT_NAME": "pull_request",
                           "GITHUB_REPOSITORY": "hushh-labs/hushh-research",
                           "GITHUB_SHA": git("rev-parse", "HEAD"), "GITHUB_RUN_ID": "5",
                           "GITHUB_RUN_ATTEMPT": "2", "CI_VALIDATION_LEVEL": "focused",
                           "QUEUE_AUTH_HEALTH_ONLY": "false",
                           "QUEUE_SELECTION_FILE": str(tmp_path / "selection.json")}.items():
            monkeypatch.setenv(key, value)
        paths = ["shared.txt", "renamed.txt"] if rename else ["shared.txt"]
        (tmp_path / "selection.json").write_text(json.dumps(json.dumps(paths)))
        return base, head
    return merge


def test_behind_pr_reuses_only_identical_actual_selection(tested_pr_merge):
    base, head = tested_pr_merge()
    # The old ancestry shortcut rejects this real, correctly tested merge.
    import subprocess
    assert subprocess.run(["git", "merge-base", "--is-ancestor", base, head]).returncode == 1
    receipt = queue.record_receipt()
    assert receipt["selection_exact"] is True
    assert queue.receipt_matches(receipt, {"repository": receipt["repository"],
                                "base": base, "tree": receipt["tree"]},
                                {"run": 5, "attempt": 2, "number": 1, "head": head})


def test_renamed_files_reuse_only_with_both_original_and_new_paths(tested_pr_merge, monkeypatch):
    tested_pr_merge(rename=True)
    assert queue.record_receipt()["selection_exact"] is True
    import os
    Path(os.environ["QUEUE_SELECTION_FILE"]).write_text(json.dumps('["renamed.txt"]'))
    assert queue.record_receipt()["selection_exact"] is False


def test_destination_only_paths_do_not_prevent_tested_merge_reuse(tested_pr_merge):
    tested_pr_merge("destination.txt")
    assert queue.record_receipt()["selection_exact"] is True


@pytest.mark.parametrize("key,value", [
    ("QUEUE_SELECTION_FILES", ""), ("QUEUE_SELECTION_FILES", "not json"),
    ("QUEUE_SELECTION_FILES", "{}"), ("QUEUE_SELECTION_FILES", "[]"),
    ("QUEUE_SELECTION_FILES", '["wrong.txt"]'),
    ("QUEUE_SELECTION_FILES", '["old.txt", "shared.txt"]'),
    ("QUEUE_SELECTION_FILES", '[null]'), ("QUEUE_SELECTION_FILES", '["line\\nname"]'),
    ("QUEUE_SELECTION_FILES", '["' + "x" * 500_000 + '"]'),
    ("QUEUE_AUTH_HEALTH_ONLY", "true"), ("QUEUE_AUTH_HEALTH_ONLY", ""),
], ids=("missing", "malformed", "wrong-shape", "empty", "wrong-path", "rename",
        "null-path", "newline", "oversized", "pr-only-profile", "unknown-profile"))
def test_missing_ambiguous_or_pr_only_selection_is_not_reusable(tested_pr_merge, monkeypatch, key, value):
    tested_pr_merge()
    if key == "QUEUE_SELECTION_FILES":
        import os
        Path(os.environ["QUEUE_SELECTION_FILE"]).write_text(json.dumps(value))
    else:
        monkeypatch.setenv(key, value)
    assert queue.record_receipt()["selection_exact"] is False


def test_event_base_must_be_actual_tested_merge_parent(tested_pr_merge, monkeypatch):
    _, head = tested_pr_merge()
    import os
    event = Path(os.environ["GITHUB_EVENT_PATH"])
    value = json.loads(event.read_text())
    value["pull_request"]["base"]["sha"] = head
    event.write_text(json.dumps(value))
    assert queue.record_receipt()["selection_exact"] is False


def test_queue_selection_capture_is_wired_without_reclassifying_lanes():
    import yaml

    root = Path(__file__).resolve().parents[2]
    jobs = yaml.safe_load((root / ".github/workflows/ci.yml").read_text())["jobs"]
    paths = jobs["paths"]
    selector = next(step for step in paths["steps"] if step.get("id") == "filter")
    assert selector["with"]["list-files"] == "json"
    assert yaml.safe_load(selector["with"]["filters"])["queue_selection"] == ["**"]
    assert paths["outputs"]["queue_selection_files"] == "${{ steps.filter.outputs.queue_selection_files }}"
    record = next(step for step in jobs["ci-status"]["steps"]
                  if step.get("name") == "Record tested merge inputs")
    assert record["env"] == {
        "QUEUE_SELECTION_FILE": "${{ runner.temp }}/queue-selection.json",
        "QUEUE_AUTH_HEALTH_ONLY": "${{ needs.paths.outputs.auth_health_only }}"}
    assert "!github.event.pull_request.draft" in record["if"]
    assert "${{ toJSON(needs.paths.outputs.queue_selection_files) }}" in record["run"]
    assert "<<'HUSSH_QUEUE_SELECTION_JSON'" in record["run"]
    caller = yaml.safe_load((root / ".github/workflows/queue-validation.yml").read_text())
    upper_bound = caller["jobs"]["combined-checks"].get("permissions", caller["permissions"])
    assert upper_bound["checks"] == jobs["ci-status"]["permissions"]["checks"] == "read"


def test_superseded_queue_cancellation_preserves_legacy_parallel_groups():
    import yaml

    root = Path(__file__).resolve().parents[2]
    workflow = yaml.safe_load((root / ".github/workflows/queue-validation.yml").read_text())
    concurrency = workflow["concurrency"]
    assert concurrency["cancel-in-progress"] is True
    assert concurrency["group"] == (
        'queue-${{ contains(fromJSON(\'["refs/heads/main","refs/heads/dev","refs/heads/uat"]\'), '
        'github.event.merge_group.base_ref) && github.event.merge_group.base_ref || github.ref }}')
    policy = json.loads((root / "config/ci-governance.json").read_text())
    assert policy["repository"]["merge_queue_max_entries_to_build"] == 1

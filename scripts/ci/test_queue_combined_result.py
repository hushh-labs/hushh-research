"""Authority and reuse boundaries of the actual merge-result gate."""

import copy
import base64
import json
import sys
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
    owners = ["kushaltrivedi5", "ankitkumarsingh1702"]
    policy = {"main": {"merge_users": owners + ["msainani"],
                       "protected_pipeline_edit_users": owners, "review_bypass_users": owners,
                       "protected_pipeline_paths": [".github/workflows/"]},
              "production": {"manual_dispatch_users": owners},
              "branch_flow": {"prepared_branches": {
                  "dev": {"policy_key": "pr_train"}, "uat": {"policy_key": "uat_merge"}}}}
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
    owners = ["kushaltrivedi5", "ankitkumarsingh1702"]
    policy = {"main": {"merge_users": owners, "review_bypass_users": owners,
                       "protected_pipeline_edit_users": owners,
                       "protected_pipeline_paths": [".github/workflows/"]},
              "production": {"manual_dispatch_users": owners},
              "branch_flow": {"prepared_branches": {branch: {"policy_key": lane}}},
              lane: {"review_bypass_users": ["parthmawai"]}}
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


def test_owner_admin_rechecks_inputs_before_mutation(tmp_path):
    proof = {"state": {"repository": "hushh-labs/hushh-research", "base": BASE, "tree": FIRST}}
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
    proof = {"state": {"repository": "hushh-labs/hushh-research", "base": BASE, "tree": FIRST}}
    commit = {"tree": {"sha": FIRST}, "parents": [{"sha": BASE}, {"sha": HEAD1}]}
    with patch.object(queue, "owner_admin_snapshot", return_value=proof), \
         patch.object(queue.subprocess, "run", return_value=SimpleNamespace(returncode=request_exit),
                      side_effect=queue.subprocess.TimeoutExpired("gh", 60) if request_exit == "timeout" else None) as write, \
         patch.object(queue, "api", side_effect=[{"merged": True, "merge_commit_sha": SECOND}, commit]):
        receipt = tmp_path / "receipt.json"
        queue.owner_admin_merge(8825, HEAD1, receipt, apply=True)
        write.assert_called_once()
        assert json.loads(receipt.read_text())["landed"] == SECOND


def test_owner_admin_never_replays_unconfirmed_merge(tmp_path):
    from types import SimpleNamespace
    proof = {"state": {"repository": "hushh-labs/hushh-research", "base": BASE, "tree": FIRST}}
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

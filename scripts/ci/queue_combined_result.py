"""Current merge-group membership and approvals for the existing queue gate.

The repository uses GitHub's MERGE queue strategy. Git parents establish which
PRs are included; the queue API establishes who requested each merge. Neither
the PR author nor a queue-ref suffix establishes that authority.
"""

from __future__ import annotations

import importlib.util
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SHA = re.compile(r"[a-f0-9]{40}")
DESTINATIONS = {"main", "dev", "uat", "uat-isolated", "integration/pr-train"}
MAX_MEMBERS = 100


class Refused(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def git(*args):
    return subprocess.check_output(["git", *args], text=True, timeout=30).strip()


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", path], text=True, timeout=30))


def event_context():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    group = event.get("merge_group", {})
    repository = os.environ.get("GITHUB_REPOSITORY")
    base_ref = str(group.get("base_ref", ""))
    branch = base_ref.removeprefix("refs/heads/")
    require(
        os.environ.get("GITHUB_EVENT_NAME") == "merge_group"
        and event.get("action") == "checks_requested"
        and repository == "hushh-labs/hushh-research"
        and event.get("repository", {}).get("full_name") == repository
        and base_ref == f"refs/heads/{branch}" and branch in DESTINATIONS
        and all(SHA.fullmatch(str(group.get(key, ""))) for key in ("base_sha", "head_sha"))
        and git("rev-parse", "HEAD") == group["head_sha"] == os.environ.get("GITHUB_SHA"),
        "Queue event or checked-out combined source is invalid",
    )
    return repository, branch, group


def queue_entries(repository, branch):
    owner, name = repository.split("/")
    query = """query($owner:String!,$name:String!,$branch:String!) {
      repository(owner:$owner,name:$name) { mergeQueue(branch:$branch) {
        entries(first:100) { totalCount pageInfo {hasNextPage} nodes {
          id position enqueuer {login} pullRequest {
            number headRefOid baseRefName state isDraft reviewDecision author {login}
          }
        } }
      } }
    }"""
    payload = json.loads(subprocess.check_output(
        ["gh", "api", "graphql", "-f", f"query={query}", "-f", f"owner={owner}",
         "-f", f"name={name}", "-f", f"branch={branch}"], text=True, timeout=30,
    ))
    require(not payload.get("errors"), "Queue authority lookup failed")
    connection = payload.get("data", {}).get("repository", {}).get("mergeQueue")
    connection = (connection or {}).get("entries", {})
    entries = connection.get("nodes")
    require(
        isinstance(entries, list) and len(entries) <= MAX_MEMBERS
        and type(connection.get("totalCount")) is int
        and connection["totalCount"] == len(entries)
        and connection.get("pageInfo", {}).get("hasNextPage") is False,
        "Queue membership inventory is incomplete",
    )
    return entries


def members(base, head, entries, branch, parents=git):
    """Walk each synthetic merge, not just the last PR encoded in its ref."""
    current, result, seen = head, [], set()
    while current != base:
        require(len(result) < MAX_MEMBERS and current not in seen, "Queue merge chain is unbounded")
        seen.add(current)
        row = parents("show", "-s", "--format=%P", current).split()
        require(len(row) == 2 and all(SHA.fullmatch(item) for item in row),
                "Queue strategy or merge shape is unsupported")
        matches = [entry for entry in entries
                   if isinstance(entry, dict) and (entry.get("pullRequest") or {}).get("headRefOid") == row[1]]
        require(len(matches) == 1, "Combined result has a missing or ambiguous queued PR")
        entry = matches[0]
        pr = entry["pullRequest"]
        require(
            isinstance(entry.get("id"), str) and entry["id"]
            and type(entry.get("position")) is int
            and isinstance((entry.get("enqueuer") or {}).get("login"), str)
            and entry["enqueuer"]["login"]
            and type(pr.get("number")) is int and pr["number"] > 0
            and pr.get("baseRefName") == branch and pr.get("state") == "OPEN"
            and pr.get("isDraft") is False and "reviewDecision" in pr
            and pr["reviewDecision"] in {"APPROVED", "REVIEW_REQUIRED", None}
            and isinstance((pr.get("author") or {}).get("login"), str)
            and pr["author"]["login"],
            "Queued PR identity or current review is unavailable",
        )
        result.append({"entry": entry["id"], "requester": entry["enqueuer"]["login"],
                       "number": pr["number"], "head": row[1], "combined": current,
                       "author": (pr.get("author") or {}).get("login", ""),
                       "review": pr["reviewDecision"]})
        current = row[0]
    require(result and len({item["number"] for item in result}) == len(result),
            "Queue group is empty or repeats a PR")
    return list(reversed(result))


def _module(filename, name):
    path = Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def authority_policy(repository, branch, base):
    """Use current protected Main authority for Dev/UAT, not candidate policy."""
    if branch not in {"dev", "uat"}:
        return base, json.loads(git("show", f"{base}:config/ci-governance.json"))
    ref = api(f"repos/{repository}/git/ref/heads/main")
    authority = ref.get("object", {})
    revision = authority.get("sha", "")
    require(authority.get("type") == "commit" and SHA.fullmatch(str(revision)),
            "Protected Main authority could not be verified")
    content = api(f"repos/{repository}/contents/config/ci-governance.json?ref={revision}")
    encoded = content.get("content")
    require(content.get("path") == "config/ci-governance.json"
            and content.get("encoding") == "base64" and isinstance(encoded, str)
            and len(encoded) <= 350_000, "Protected Main policy is unavailable")
    try:
        raw = base64.b64decode("".join(encoded.split()), validate=True)
        policy = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as error:
        raise Refused("Protected Main policy is malformed") from error
    require(isinstance(policy, dict), "Protected Main policy is malformed")
    return revision, policy


def current_head_reviewers(repository, member, policy, guard):
    """Prove approval against the current head and canonical maintainer authority.

    Native reviewDecision is null when GitHub has no review-count requirement;
    neither that absence nor an APPROVED label grants authority. Reuse the same
    cohort that populates ordinary CODEOWNERS, without mutable team membership.
    """
    governance = _module("apply-governance.py", "queue_reviewer_cohort")
    teams = [team for team in governance.MANAGED_TEAMS
             if team.get("slug") == "allowed-maintainers-to-approve"]
    require(len(teams) == 1, "Canonical maintainer review authority is unavailable")
    reviewers = teams[0]["select"](policy)
    require(isinstance(reviewers, list) and reviewers
            and all(isinstance(login, str) and login for login in reviewers),
            "Canonical maintainer review cohort is malformed")
    latest = guard._latest_reviews(repository, member["number"], read=api)
    require(not any(row["state"] == "CHANGES_REQUESTED" or (
        row["state"] == "DISMISSED" and row["commit_id"] == member["head"]
    ) for row in latest.values()), "Resolve the outstanding or withdrawn review")
    return sorted(login for login, row in latest.items()
                  if login in reviewers and login != member["author"]
                  and row["state"] == "APPROVED" and row["commit_id"] == member["head"])


def authorize(repository, branch, base, included, *, policy=None):
    if policy is None:
        policy = json.loads(git("show", f"{base}:config/ci-governance.json"))
    main = policy["main"]
    # Explicit merger authority is separate from authorship and deployment.
    allowed = main.get("merge_users", policy["production"]["manual_dispatch_users"])
    require(isinstance(allowed, list) and allowed, "Main merger cohort is missing")
    guard = _module("verify-protected-pipeline-edits.py", "queue_protected_owner")
    protected_owners = guard.resolve_allowed_users(main)
    protected_paths = main.get("protected_pipeline_paths") or guard.DEFAULT_PROTECTED_PATHS
    for member in included:
        require(branch != "main" or member["requester"] in allowed,
                "The actual queue requester is not authorized to merge Main")
        owner_approval = guard.owner_queue_approval(
            author=member["author"], requester=member["requester"],
            review=member["review"], main_policy=main,
        )
        lane = None
        if branch in {"dev", "uat"}:
            lane = (policy.get("branch_flow", {}).get("prepared_branches", {})
                    .get(branch, {}).get("policy_key"))
            require(lane in {"pr_train", "uat_merge"}, "Destination maintainer policy is unavailable")
        maintainers = policy.get(lane, {}).get("review_bypass_users", []) if lane else []
        require(isinstance(maintainers, list), "Maintainer cohort is malformed")
        maintainer_self = (bool(lane) and member["author"] == member["requester"]
                           and member["requester"] in maintainers)
        self_authorized = bool(owner_approval or maintainer_self)
        independent = ([] if self_authorized else
                       current_head_reviewers(repository, member, policy, guard))
        require(independent or self_authorized,
                "Queued PR needs current review or its owner's explicit self-approval")
        if self_authorized:
            guard.require_uncontested_owner_approval(repository, member["number"], member["head"], read=api)
        member["approval_source"] = ("owner_queue_request" if owner_approval else
                                     "maintainer_queue_request" if maintainer_self else
                                     "current_head_review")
        member["current_head_reviewers"] = independent
        # Compare the actual contribution at its merge parent, including renames
        # as deletion/addition, so a protected file cannot evade approval.
        changed = git("diff", "--no-renames", "--name-only", f"{member['combined']}^1", member["combined"]).splitlines()
        protected = any(guard._matches(path, rule) for path in changed for rule in protected_paths)
        approvals = owner_approval or (guard._owner_approvals(
            repository, member["number"], member["head"], protected_owners, read=api,
        ) if protected else [])
        require(not protected or approvals, "Protected changes need Kushal or Ankit's current-head approval")
        member["protected_approvals"] = approvals
    return included


def snapshot():
    repository, branch, group = event_context()
    included = members(group["base_sha"], group["head_sha"], queue_entries(repository, branch), branch)
    policy_revision, policy = authority_policy(repository, branch, group["base_sha"])
    authorize(repository, branch, group["base_sha"], included, policy=policy)
    # A replaced queue ref must not retain this run's authority.
    head_ref = str(group.get("head_ref", ""))
    require(head_ref.startswith(f"refs/heads/gh-readonly-queue/{branch}/"), "Unexpected queue ref")
    remote = git("ls-remote", "origin", head_ref).split()
    require(len(remote) == 2 and remote == [group["head_sha"], head_ref], "Queue group changed during validation")
    destination = git("ls-remote", "origin", f"refs/heads/{branch}").split()
    require(destination == [group["base_sha"], f"refs/heads/{branch}"],
            "Destination advanced; validate the rebuilt merge group")
    return {"repository": repository, "branch": branch, "base": group["base_sha"],
            "policy_revision": policy_revision,
            "head": group["head_sha"], "tree": git("rev-parse", "HEAD^{tree}"),
            "members": included}


def current_validations(state, read=api):
    """Every included PR must retain its latest successful, complete attempt."""
    owner = _module("verify-queue-entry-reuses-pr-validation.py", "queue_attempt_owner")
    result = []
    for member in state["members"]:
        prefix = f"repos/{state['repository']}/actions"
        payload = read(f"{prefix}/runs?head_sha={member['head']}&event=pull_request&per_page=100")
        run = owner.latest_pr_validation_run(owner.validation_runs(payload), member["head"])
        inventory = read(f"{prefix}/runs/{run.run_id}/attempts/{run.attempt}/jobs?per_page=100")
        jobs = inventory.get("jobs")
        require(isinstance(jobs, list) and inventory.get("total_count") == len(jobs)
                and len(jobs) <= 100 and all(isinstance(job, dict) for job in jobs),
                "Current-attempt job inventory is incomplete")
        owner.require_gate_success(run, jobs)
        # A current run for another PR (for example two bases sharing a head)
        # cannot supply this PR's intake evidence.
        record = read(f"{prefix}/runs/{run.run_id}")
        pulls = record.get("pull_requests")
        require(isinstance(pulls, list) and any(
            row.get("number") == member["number"]
            and row.get("head", {}).get("sha") == member["head"] for row in pulls
        ), "Validation run does not identify this queued PR")
        require(record.get("run_attempt") == run.attempt
                and record.get("status") == "completed" and record.get("conclusion") == "success",
                "Validation attempt changed during queue inspection")
        owner.require_unchanged_authority(run, owner.validation_runs(read(
            f"{prefix}/runs?head_sha={member['head']}&event=pull_request&per_page=100"
        )), member["head"])
        result.append({"number": member["number"], "head": member["head"],
                       "run": run.run_id, "attempt": run.attempt})
    return result


def receipt_matches(receipt, state, validation):
    """Reuse needs the tested tree AND identical selection/authority inputs.

    A PR whose head was behind its tested base still merges normally, but its
    historical PR-file selection is not reused: the combined checks run again.
    """
    return isinstance(receipt, dict) and receipt == {
        "version": 1, "repository": state["repository"], "event": "pull_request",
        "run": validation["run"], "attempt": validation["attempt"],
        "pr": validation["number"], "head": validation["head"],
        "base": state["base"], "tree": state["tree"],
        "selection_exact": True, "level": "focused", "result": "success",
    }


def reusable(state, validations, read=api):
    # A single PR receipt cannot prove a multi-PR selection/approval context.
    if len(validations) != 1:
        return False
    validation = validations[0]
    inventory = read(f"repos/{state['repository']}/actions/runs/{validation['run']}/artifacts?per_page=100")
    rows = inventory.get("artifacts")
    require(isinstance(rows, list) and inventory.get("total_count") == len(rows)
            and len(rows) <= 100, "Validation artifact inventory is incomplete")
    name = f"ci-combined-inputs-{validation['run']}-{validation['attempt']}"
    matches = [row for row in rows if row.get("name") == name]
    if not matches or (len(matches) == 1 and matches[0].get("expired") is True):
        return False  # Old successful runs without current proof receive checks.
    require(len(matches) == 1 and matches[0].get("expired") is False,
            "Combined-input receipt is ambiguous")
    from release_artifact_receipts import immutable_archive, _status_bytes

    archive = immutable_archive(state["repository"], matches[0],
        run_command=lambda argv, **kw: subprocess.run(argv, check=True, capture_output=True, **kw),
        timeout=60)
    receipt = json.loads(_status_bytes(archive, "ci-combined-inputs.json"))
    return receipt_matches(receipt, state, validation)


def record_receipt():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    pr = event["pull_request"]
    head, base = pr["head"]["sha"], pr["base"]["sha"]
    parents = git("show", "-s", "--format=%P", "HEAD").split()
    require(os.environ["GITHUB_EVENT_NAME"] == "pull_request"
            and git("rev-parse", "HEAD") == os.environ["GITHUB_SHA"]
            and len(parents) == 2 and parents[1] == head,
            "Receipt requires the actual tested PR merge")
    exact = parents[0] == base and subprocess.run(
        ["git", "merge-base", "--is-ancestor", base, head], check=False, timeout=30,
    ).returncode == 0
    return {"version": 1, "repository": os.environ["GITHUB_REPOSITORY"],
            "event": "pull_request", "run": int(os.environ["GITHUB_RUN_ID"]),
            "attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]), "pr": pr["number"],
            "head": head, "base": base, "tree": git("rev-parse", "HEAD^{tree}"),
            "selection_exact": exact, "level": os.environ["CI_VALIDATION_LEVEL"],
            "result": "success"}


def owner_admin_snapshot(number, expected_head):
    """Explicit owner route reuses the queue's exact-attempt and tree receipts."""
    repository = "hushh-labs/hushh-research"
    actor = api("user").get("login")
    pr = api(f"repos/{repository}/pulls/{number}")
    base = api(f"repos/{repository}/git/ref/heads/main")["object"]["sha"]
    require(
        SHA.fullmatch(str(expected_head))
        and pr.get("state") == "open"
        and pr.get("draft") is False
        and pr.get("head", {}).get("sha") == expected_head
        and pr.get("base", {}).get("ref") == "main"
        and pr["base"]["sha"] == base
        and pr.get("head", {}).get("repo", {}).get("full_name") == repository,
        "Owner merge needs the open exact-head Main PR and current destination",
    )
    # Fetch objects only; never change the developer's checked-out branch.
    subprocess.run(
        ["git", "fetch", "origin", "main", f"refs/pull/{number}/merge"],
        check=True,
        timeout=90,
    )
    policy = json.loads(git("show", f"{base}:config/ci-governance.json"))
    main = policy["main"]
    guard = _module("verify-protected-pipeline-edits.py", "admin_protected_owner")
    require(
        actor == pr.get("user", {}).get("login")
        and actor in main.get("merge_users", [])
        and actor in main.get("merge_queue_bypass_users", [])
        and actor in main.get("review_bypass_users", [])
        and actor in guard.resolve_allowed_users(main),
        "Only the named owner may explicitly approve their own exact-head Admin merge",
    )
    governance = _module("apply-governance.py", "admin_live_governance")
    governance.reconcile_owner_admin_ruleset(policy, verify_only=True)
    # A shell inherited from a Dev/UAT task must not inspect that lane instead.
    from tempfile import NamedTemporaryFile
    parity_env = {k: v for k, v in os.environ.items() if not k.startswith("GITHUB_") or k == "GITHUB_TOKEN"}
    with NamedTemporaryFile(mode="w", suffix=".json") as policy_file:
        json.dump(policy, policy_file)
        policy_file.flush()
        parity_env.update(GITHUB_BRANCH="main", GITHUB_REPO=repository,
                          GITHUB_CI_GOVERNANCE_FILE=policy_file.name)
        subprocess.run(["bash", "scripts/ci/verify-main-branch-protection.sh"],
                       check=True, timeout=120, env=parity_env)
    guard.require_uncontested_owner_approval(
        repository, number, expected_head, read=api
    )
    query = """query($number:Int!) { repository(owner:"hushh-labs",name:"hushh-research") {
      pullRequest(number:$number) { reviewThreads(first:100) { totalCount
        pageInfo {hasNextPage} nodes {isResolved} } } } }"""
    result = json.loads(
        subprocess.check_output(
            ["gh", "api", "graphql", "-f", f"query={query}", "-F", f"number={number}"],
            text=True,
            timeout=30,
        )
    )
    require(not result.get("errors"), "Conversation lookup failed")
    threads = result["data"]["repository"]["pullRequest"]["reviewThreads"]
    require(
        threads.get("totalCount") == len(threads.get("nodes", []))
        and threads.get("pageInfo", {}).get("hasNextPage") is False
        and all(t.get("isResolved") is True for t in threads["nodes"]),
        "Resolve conversations before owner Admin approval",
    )
    require(
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", base, expected_head],
            check=False,
            timeout=30,
        ).returncode
        == 0,
        "Owner direct merge needs the current Main base; ordinary reviewed PRs may use the queue",
    )
    tree = git("merge-tree", "--write-tree", base, expected_head)
    require(SHA.fullmatch(tree), "Current combined merge tree is not proven")
    state = {
        "repository": repository,
        "branch": "main",
        "base": base,
        "head": expected_head,
        "tree": tree,
        "members": [{"number": number, "head": expected_head, "requester": actor}],
    }
    validations = current_validations(state)
    require(
        reusable(state, validations),
        "Current Main merge tree lacks exact successful CI input evidence; validate the updated candidate",
    )
    return {
        "state": state,
        "validations": validations,
        "approval_source": "explicit_owner_admin",
    }

def owner_admin_merge(number, expected_head, receipt, apply=False):
    require(type(number) is int and number > 0, "Owner merge needs a PR number")
    proof = owner_admin_snapshot(number, expected_head)
    receipt.write_text(json.dumps(proof, sort_keys=True) + "\n")
    if not apply:
        print("Owner Admin preflight verified; no merge or deployment performed.")
        return
    require(
        owner_admin_snapshot(number, expected_head) == proof,
        "Source, destination, actor or CI changed before merge",
    )
    repository = proof["state"]["repository"]
    body = {"sha": expected_head, "merge_method": "merge"}
    # One request only. A lost response is reconciled, never blindly replayed.
    proof["outcome"] = "submitted_or_uncertain"
    receipt.write_text(json.dumps(proof, sort_keys=True) + "\n")
    exit_code = None
    try:
        result = subprocess.run(
            ["gh", "api", f"repos/{repository}/pulls/{number}/merge", "--method", "PUT", "--input", "-"],
            input=json.dumps(body), text=True, capture_output=True, timeout=60,
        )
        exit_code = result.returncode
    except (subprocess.TimeoutExpired, OSError):
        pass  # The provider may already have committed; read back before deciding.
    try:
        observed = api(f"repos/{repository}/pulls/{number}")
    except (subprocess.SubprocessError, OSError, ValueError) as error:
        proof["outcome"] = "not_confirmed"
        receipt.write_text(json.dumps(proof, sort_keys=True) + "\n")
        raise Refused("Admin merge outcome uncertain; use the saved receipt to inspect, never blindly retry") from error
    if observed.get("merged") is not True:
        proof["outcome"] = "not_confirmed"
        receipt.write_text(json.dumps(proof, sort_keys=True) + "\n")
        raise Refused(
            "Admin merge was not confirmed; inspect the recorded PR before any retry"
        )
    landed = observed.get("merge_commit_sha")
    commit = api(f"repos/{repository}/git/commits/{landed}")
    require(
        commit.get("tree", {}).get("sha") == proof["state"]["tree"]
        and [p["sha"] for p in commit.get("parents", [])]
        == [proof["state"]["base"], expected_head],
        "Landed result differs from tested inputs; inspect before proceeding",
    )
    proof.update(outcome="merged", landed=landed, request_exit_code=exit_code)
    receipt.write_text(json.dumps(proof, sort_keys=True) + "\n")
    print(
        f"Owner-approved PR merged at {landed}. Main smoke remains required; no deployment requested."
    )

def main():
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "operation", choices=("plan", "finish", "record", "owner-merge")
    )
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--pr", type=int)
    parser.add_argument("--sha")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.operation == "owner-merge":
        owner_admin_merge(args.pr, args.sha, args.receipt, args.apply)
        return
    if args.operation == "record":
        value = record_receipt()
    else:
        state = snapshot()
        validations = current_validations(state)
        if args.operation == "plan":
            reuse = reusable(state, validations)
            value = {"state": state, "validations": validations, "reuse": reuse}
            with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                output.write(f"reuse={'true' if reuse else 'false'}\n")
            print(
                "Reusing proven combined inputs."
                if reuse
                else "Validating changed contracts on the combined result."
            )
        else:
            value = json.loads(args.receipt.read_text())
            require(
                value["state"] == state and value["validations"] == validations,
                "Queue membership, approval or validation changed; rebuild the group",
            )
            if value["reuse"]:
                require(reusable(state, validations), "Combined-input proof changed")
            else:
                require(
                    os.environ.get("COMBINED_RESULT") == "success",
                    "Combined-result checks must succeed",
                )
            print("Combined result and current merge authority verified.")
            return
    args.receipt.write_text(json.dumps(value, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()

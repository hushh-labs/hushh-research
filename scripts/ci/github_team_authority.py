#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Current team authority for new operations; historical receipts keep their policy.

Only the Main-owned broker receives the App token. This reader does not dispatch
workflows, publish checks or alter team membership. Hosted receipt composition
is owned by the existing protected release broker.
"""

from __future__ import annotations

import copy
from datetime import datetime, timezone
from pathlib import Path
import sys
import json
import os
import re
import subprocess
import urllib.request
import urllib.error

from github_security_authority import NoRedirect, Refused

REPOSITORY = "hushh-labs/hushh-research"
WORKFLOW = ".github/workflows/deployment-security.yml"
TEAM_IDS = {
    "allowed-maintainers-to-approve": 17036409,
    "pipeline-editors": 19355842,
    "deploy-dev": 19355843,
    "deploy-uat": 19355844,
    "deploy-production": 19355846,
}
LOGIN = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}")


class StaleObservation(Refused):
    """A fully verified completed read may be renewed; uncertain work may not."""


def require(condition, message):
    if not condition:
        raise Refused(message)


def cli_read(path):
    result = subprocess.run(
        ["gh", "api", path], capture_output=True, text=True, timeout=30
    )
    require(
        result.returncode == 0 and len(result.stdout) <= 2 * 1024 * 1024,
        "Team authority API is unavailable",
    )
    try:
        return json.loads(result.stdout)
    except (ValueError, UnicodeError):
        raise Refused("Team authority API response is malformed") from None


def team_reader(token):
    require(bool(token), "Read-only membership App token is unavailable")

    def read(path):
        require(
            path.startswith("orgs/hushh-labs/teams/")
            and ".." not in path
            and "#" not in path,
            "Membership request left its boundary",
        )
        request = urllib.request.Request(
            "https://api.github.com/" + path,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urllib.request.build_opener(NoRedirect).open(
                request, timeout=20
            ) as response:
                raw = response.read(256 * 1024 + 1)
        except urllib.error.HTTPError as error:
            error.close()
            raise Refused(
                f"Membership lookup refused (HTTP {error.code}); no authority granted"
            ) from None
        except (urllib.error.URLError, TimeoutError):
            raise Refused("Membership lookup failed; no authority granted") from None
        require(len(raw) <= 256 * 1024, "Membership response exceeded its bound")
        return json.loads(raw)

    return read


def read_teams(read):
    result = {}
    for slug, identity in TEAM_IDS.items():
        prefix = f"orgs/hushh-labs/teams/{slug}"
        team = read(prefix)
        require(
            isinstance(team, dict)
            and team.get("id") == identity
            and team.get("slug") == slug
            and team.get("parent") is None,
            "Team identity or inherited authority changed",
        )
        members = read(prefix + "/members?per_page=100")
        require(
            isinstance(members, list) and 0 < len(members) < 100,
            "Team member inventory is empty or incomplete",
        )
        users, ids = [], set()
        for member in members:
            require(
                isinstance(member, dict)
                and member.get("type") == "User"
                and LOGIN.fullmatch(str(member.get("login", "")))
                and type(member.get("id")) is int
                and member["id"] > 0
                and member["id"] not in ids,
                "Team member identity is malformed",
            )
            users.append(member["login"])
            ids.add(member["id"])
        require(
            len({user.lower() for user in users}) == len(users),
            "Team contains duplicate identities",
        )
        result[slug] = sorted(users)
    maintainers = set(result["allowed-maintainers-to-approve"])
    require(
        all(set(users) <= maintainers for users in result.values()),
        "Deployment/protected authority exceeds the maintainer team",
    )
    return result


def project_policy(policy, teams):
    """Project current teams into existing interfaces, never mutate their roster."""
    require(set(teams) == set(TEAM_IDS), "Team authority is incomplete")
    result = copy.deepcopy(policy)
    owners, production = teams["pipeline-editors"], teams["deploy-production"]
    result["main"].update(
        merge_users=production,
        protected_pipeline_edit_users=owners,
        review_bypass_users=owners,
        merge_queue_bypass_users=owners,
    )
    for lane in ("pr_train", "uat_merge"):
        result[lane]["review_bypass_users"] = teams["allowed-maintainers-to-approve"]
        if "protected_pipeline_edit_users" in result[lane]:
            result[lane]["protected_pipeline_edit_users"] = owners
    for lane in ("dev", "uat", "production"):
        result[lane]["manual_dispatch_users"] = teams[f"deploy-{lane}"]
    return result


def local_policy(policy, *, actor=None, read=cli_read):
    """Authenticate the human CLI; hosted jobs require Main-owned observations."""
    require(
        os.environ.get("GITHUB_ACTIONS") != "true",
        "Hosted authorization requires a verified Main-owned team observation",
    )
    observed = read("user")
    require(
        isinstance(observed, dict)
        and observed.get("type") == "User"
        and LOGIN.fullmatch(str(observed.get("login", ""))),
        "Authenticated operator identity is unavailable",
    )
    if actor is not None:
        require(
            actor == observed["login"],
            "Requested operator is not the authenticated CLI user",
        )
    return project_policy(policy, read_teams(read))


CHECK = "Team Authorization Gate"
SOURCE_WORKFLOWS = {
    "PR Validation": ".github/workflows/ci.yml",
    "Queue Validation": ".github/workflows/queue-validation.yml",
}
SHA = re.compile(r"[0-9a-f]{40}")


def source_identity(read, expected):
    """Resolve the current attempt; event fields alone never grant authority."""
    require(
        isinstance(expected, dict)
        and type(expected.get("id")) is int
        and type(expected.get("run_attempt")) is int,
        "Source validation identity is missing",
    )
    run = read(f"repos/{REPOSITORY}/actions/runs/{expected['id']}")
    path = SOURCE_WORKFLOWS.get(run.get("name"))
    require(
        path is not None
        and run.get("path", "").split("@", 1)[0] == path
        and run.get("event") in {"pull_request", "merge_group"}
        and run.get("repository", {}).get("full_name") == REPOSITORY
        and SHA.fullmatch(str(run.get("head_sha", "")))
        and run.get("id") == expected["id"]
        and run.get("run_attempt") == expected["run_attempt"]
        and run.get("head_sha") == expected.get("head_sha"),
        "Source workflow, repository, SHA or current attempt changed",
    )
    workflow = read(f"repos/{REPOSITORY}/actions/workflows/{path.rsplit('/', 1)[1]}")
    require(
        workflow.get("path") == path and workflow.get("id") == run.get("workflow_id"),
        "Source is not the canonical validation workflow",
    )
    inventory = read(
        f"repos/{REPOSITORY}/actions/workflows/{path.rsplit('/', 1)[1]}/runs?head_sha={run['head_sha']}&per_page=100"
    )
    rows = inventory.get("workflow_runs", [])
    require(
        type(inventory.get("total_count")) is int
        and inventory["total_count"] == len(rows) <= 100,
        "Validation attempt inventory is incomplete",
    )
    candidates = [
        row
        for row in rows
        if row.get("event") == run["event"]
        and row.get("head_sha") == run["head_sha"]
        and row.get("path", "").split("@", 1)[0] == path
    ]
    require(
        candidates
        and all(isinstance(row.get("run_started_at"), str) for row in candidates),
        "Current validation chronology is unavailable",
    )
    latest = max(
        candidates,
        key=lambda row: (row["run_started_at"], row["id"], row["run_attempt"]),
    )
    require(
        (latest["id"], latest["run_attempt"]) == (run["id"], run["run_attempt"]),
        "A newer validation attempt superseded this authorization",
    )
    return run


def validation_passed(read, run):
    require(
        run.get("status") == "completed" and run.get("conclusion") == "success",
        "Current source validation did not succeed",
    )
    jobs = read(
        f"repos/{REPOSITORY}/actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100"
    )
    rows = jobs.get("jobs", [])
    require(
        type(jobs.get("total_count")) is int
        and jobs["total_count"] == len(rows) <= 100,
        "Source job inventory is incomplete",
    )
    gates = [row for row in rows if row.get("name") == "CI Status Gate"]
    require(
        len(gates) == 1
        and gates[0].get("status") == "completed"
        and gates[0].get("conclusion") == "success"
        and gates[0].get("run_id") == run["id"]
        and gates[0].get("run_attempt") == run["run_attempt"],
        "Current source CI Status Gate is missing or unsuccessful",
    )


def fetch_objects(*revisions):
    require(
        revisions and all(SHA.fullmatch(str(value)) for value in revisions),
        "Immutable Git object identities are required",
    )
    subprocess.run(
        ["git", "fetch", "--no-tags", "origin", *dict.fromkeys(revisions)],
        capture_output=True,
        check=True,
        timeout=90,
    )


def authorize_pr(read, run, policy):
    import queue_combined_result as queue

    guard = queue._module("verify-protected-pipeline-edits.py", "team_protected_guard")
    # Read GitHub's current run association, not every PR sharing its commit.
    # The same branch/head may legitimately have PRs into multiple destinations.
    rows = run.get("pull_requests")
    require(
        isinstance(rows, list) and 0 < len(rows) < 100,
        "Current validation run lacks its PR association",
    )
    matches = [row for row in rows if row.get("head", {}).get("sha") == run["head_sha"]]
    require(len(matches) == 1, "Validation must identify its exact PR")
    pr = read(f"repos/{REPOSITORY}/pulls/{matches[0]['number']}")
    branch = pr.get("base", {}).get("ref")
    require(
        pr.get("state") == "open"
        and pr.get("head", {}).get("sha") == run["head_sha"]
        and pr.get("base", {}).get("repo", {}).get("full_name") == REPOSITORY
        and pr.get("head", {}).get("repo", {}).get("full_name")
        == run.get("head_repository", {}).get("full_name")
        and pr.get("head", {}).get("ref") == run.get("head_branch"),
        "PR head, repository or destination changed",
    )
    if branch == "main":
        require(
            pr.get("user", {}).get("login") in policy["main"]["merge_users"],
            "Direct Main intake requires the production merger team",
        )
    head, base = run["head_sha"], pr["base"]["sha"]
    fetch_objects(base, head)
    authored = guard.authored_change_base(base, head, repository_root=Path.cwd())
    changed = queue.git(
        "diff", "--no-renames", "--name-only", authored, head
    ).splitlines()
    semantic = guard.semantic_pipeline_changes(
        changed, base=authored, head=head, authority=base, repository_root=Path.cwd()
    )
    protected = semantic or any(
        guard._matches(path, rule)
        for path in changed
        for rule in policy["main"]["protected_pipeline_paths"]
    )
    owners = policy["main"]["protected_pipeline_edit_users"]
    if protected and pr.get("user", {}).get("login") not in owners:
        require(
            guard._owner_approvals(REPOSITORY, pr["number"], head, owners, read=read),
            "Protected changes require a current-head pipeline-editor approval",
        )
    return {
        "kind": "pull_request",
        "number": pr["number"],
        "head": head,
        "base": base,
        "branch": branch,
    }


def authorize_queue(read, run, policy):
    import queue_combined_result as queue

    branch_ref = run.get("head_branch", "")
    matches = [
        branch
        for branch in queue.DESTINATIONS
        if branch_ref.startswith(f"gh-readonly-queue/{branch}/")
    ]
    require(len(matches) == 1, "Queue destination is ambiguous")
    branch = matches[0]
    remote = read(f"repos/{REPOSITORY}/git/ref/heads/{branch_ref}")
    require(
        remote.get("object", {}).get("sha") == run["head_sha"],
        "Queue ref was superseded",
    )
    base = read(f"repos/{REPOSITORY}/git/ref/heads/{branch}")["object"]["sha"]
    entries = queue.queue_entries(REPOSITORY, branch)
    heads = [entry.get("pullRequest", {}).get("headRefOid") for entry in entries]
    fetch_objects(base, run["head_sha"], *heads)
    included = queue.members(base, run["head_sha"], entries, branch)
    queue.authorize(
        REPOSITORY,
        branch,
        base,
        included,
        policy=policy,
        authority_revision=os.environ["GITHUB_SHA"],
    )
    state = {
        "repository": REPOSITORY,
        "branch": branch,
        "base": base,
        "head": run["head_sha"],
        "members": included,
    }
    queue.current_validations(state, read=read)
    require(
        read(f"repos/{REPOSITORY}/git/ref/heads/{branch}")["object"]["sha"] == base
        and read(f"repos/{REPOSITORY}/git/ref/heads/{branch_ref}")["object"]["sha"]
        == run["head_sha"],
        "Destination or queue ref advanced during authorization",
    )
    return state


def write_check(token, payload, *, read=cli_read):
    """Update one managed check per SHA; uncertain writes are never replayed."""
    require(bool(token), "Main check publisher token is missing")
    inventory = read(
        f"repos/{REPOSITORY}/commits/{payload['head_sha']}/check-runs?check_name=Team%20Authorization%20Gate&filter=all&per_page=100"
    )
    rows = inventory.get("check_runs", [])
    require(
        type(inventory.get("total_count")) is int
        and inventory["total_count"] == len(rows) <= 100,
        "Authorization check inventory is incomplete",
    )
    matches = []
    for row in rows:
        if row.get("name") != CHECK or row.get("app", {}).get("id") != 15368:
            continue
        external = row.get("external_id", "")
        try:
            binding = json.loads(external)
        except (ValueError, TypeError):
            continue
        producer = binding.get("producer", {})
        next_source = json.loads(payload["external_id"]).get("source", {})
        require(
            not (
                binding.get("source", {}).get("workflow")
                == SOURCE_WORKFLOWS["Queue Validation"]
                and next_source.get("workflow") == SOURCE_WORKFLOWS["PR Validation"]
            ),
            "PR authorization cannot overwrite a queue-bound decision",
        )
        if (
            binding.get("source", {}).get("sha") == payload["head_sha"]
            and producer.get("workflow") == WORKFLOW
            and type(producer.get("run_id")) is int
        ):
            prior = read(f"repos/{REPOSITORY}/actions/runs/{producer['run_id']}")
            require(
                prior.get("path", "").split("@", 1)[0] == WORKFLOW
                and prior.get("head_branch") == "main"
                and prior.get("event") == "workflow_run"
                and prior.get("head_sha") == producer.get("sha")
                and prior.get("repository", {}).get("full_name") == REPOSITORY,
                "Previous authorization check lacks Main producer provenance",
            )
            matches.append(row)
    require(
        len(matches) <= 1,
        "Authorization checks are ambiguous; reconcile before mutation",
    )
    path = f"repos/{REPOSITORY}/check-runs"
    body, method = dict(payload), "POST"
    if matches:
        path += f"/{matches[0]['id']}"
        body.pop("head_sha")
        method = "PATCH"
    request = urllib.request.Request(
        "https://api.github.com/" + path,
        data=json.dumps(body).encode(),
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.build_opener(NoRedirect).open(
            request, timeout=20
        ) as response:
            raw = response.read(256 * 1024 + 1)
    except urllib.error.HTTPError as error:
        error.close()
        raise Refused(
            f"Authorization publication refused (HTTP {error.code})"
        ) from None
    except (urllib.error.URLError, TimeoutError):
        raise Refused(
            "Authorization publication outcome is uncertain; inspect before retry"
        ) from None
    require(
        len(raw) <= 256 * 1024, "Authorization publication response exceeded its bound"
    )
    result = json.loads(raw)
    require(
        type(result.get("id")) is int
        and (not matches or result["id"] == matches[0]["id"]),
        "Authorization publication is unconfirmed",
    )
    return result["id"]


def publish_main(env, read=cli_read, memberships=None, publish=None):
    """Main inspects source objects as data; candidate code is never executed."""
    require(
        env.get("GITHUB_REPOSITORY") == REPOSITORY
        and env.get("GITHUB_REF") == "refs/heads/main"
        and env.get("GITHUB_EVENT_NAME") == "workflow_run"
        and env.get("GITHUB_WORKFLOW_REF")
        == f"{REPOSITORY}/{WORKFLOW}@refs/heads/main",
        "Team authorization must execute from the Main-owned worker",
    )
    event = json.loads(Path(env["GITHUB_EVENT_PATH"]).read_text())
    expected = event.get("workflow_run", {})
    run = source_identity(read, expected)
    # A late start event must not clear a completed decision. GitHub supplies
    # current run state; source attempt is checked again immediately before POST.
    action = event.get("action")
    if action == "in_progress" and run.get("status") == "completed":
        result = {"state": "superseded-start-event"}
        Path(env["RUNNER_TEMP"], "team-authorization.json").write_text(
            json.dumps(result) + "\n"
        )
        return result
    require(action in {"in_progress", "completed"}, "Unsupported authorization event")
    identity = {
        "run_id": run["id"],
        "attempt": run["run_attempt"],
        "sha": run["head_sha"],
        "workflow": run["path"].split("@", 1)[0],
    }
    state, reason = "in_progress", "Validation is running; authorization is pending."
    details = None
    if action == "completed":
        state = "failure"
        try:
            validation_passed(read, run)
            policy = json.loads(
                (
                    Path(__file__).resolve().parents[2] / "config/ci-governance.json"
                ).read_text()
            )
            teams = read_teams(
                memberships or team_reader(env.get("CI_TEAM_MEMBERS_TOKEN"))
            )
            policy = project_policy(policy, teams)
            details = (
                authorize_pr(read, run, policy)
                if run["event"] == "pull_request"
                else authorize_queue(read, run, policy)
            )
            require(
                read_teams(memberships or team_reader(env.get("CI_TEAM_MEMBERS_TOKEN")))
                == teams,
                "Team authority changed during validation",
            )
            state, reason = (
                "success",
                "Live team authority verified; functional qualification remains CI Status Gate.",
            )
        except (Refused, ValueError, subprocess.SubprocessError) as error:
            reason = str(error)
    require(
        source_identity(read, expected) == run,
        "Source attempt or state changed before publication",
    )
    producer = {
        "run_id": int(env["GITHUB_RUN_ID"]),
        "attempt": int(env["GITHUB_RUN_ATTEMPT"]),
        "sha": env["GITHUB_SHA"],
        "workflow": WORKFLOW,
    }
    receipt = {
        "schema_version": 1,
        "source": identity,
        "producer": producer,
        "state": state,
        "reason": reason,
        "decision": details,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
    }
    external = json.dumps(
        {"source": identity, "producer": producer},
        sort_keys=True,
        separators=(",", ":"),
    )
    payload = {
        "name": CHECK,
        "head_sha": run["head_sha"],
        "status": "in_progress" if state == "in_progress" else "completed",
        "external_id": external,
        "details_url": f"https://github.com/{REPOSITORY}/actions/runs/{producer['run_id']}",
        "output": {"title": CHECK, "summary": reason[:2000]},
    }
    if state != "in_progress":
        payload["conclusion"] = state
    output = Path(env["RUNNER_TEMP"], "team-authorization.json")
    output.write_text(
        json.dumps({**receipt, "publication": "pending"}, indent=2) + "\n"
    )
    output.chmod(0o600)
    receipt["check_id"] = (
        publish or (lambda value: write_check(env.get("GH_TOKEN"), value, read=read))
    )(payload)
    Path(env["RUNNER_TEMP"], "team-authorization.json").write_text(
        json.dumps(receipt, indent=2) + "\n"
    )
    return receipt


if __name__ == "__main__":
    try:
        result = publish_main(dict(os.environ))
        print(json.dumps({key: result.get(key) for key in ("state", "check_id")}))
        if result.get("state") == "failure":
            raise SystemExit(1)
    except (
        Refused,
        ValueError,
        subprocess.SubprocessError,
        urllib.error.URLError,
    ) as error:
        print(f"Team authorization refused: {error}", file=sys.stderr)
        raise SystemExit(1)

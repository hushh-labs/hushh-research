#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Reconcile visible review Teams; never approve, merge, dispatch or grant access."""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "scripts/ci"))
from github_security_authority import Refused, SHA  # noqa: E402
from github_team_authority import cli_read, read_teams  # noqa: E402
from process_group import bounded_stdout  # noqa: E402
from repo_governance_plan import MAX_CHANGED_BYTES, MAX_CHANGED_PATHS  # noqa: E402

REPO = "hushh-labs/hushh-research"
TEAMS = {"allowed-maintainers-to-approve", "pipeline-editors"}


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True, timeout=30).strip()


def select_team(pr, authority):
    """Use the authored delta and existing protected-edit classifier, without PR execution."""
    spec = importlib.util.spec_from_file_location("protected_edits", ROOT / "scripts/ci/verify-protected-pipeline-edits.py")
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    head, target = pr["head"]["sha"], pr["base"]["sha"]
    for sha in (authority, target, head):
        if not SHA.fullmatch(sha):
            raise Refused("Pinned commit identity unavailable")
        if subprocess.run(["git", "cat-file", "-e", sha + "^{commit}"], cwd=ROOT, capture_output=True).returncode:
            subprocess.run(["git", "fetch", "--no-tags", "origin", sha], cwd=ROOT, check=True, capture_output=True, timeout=60)
    base = guard.authored_change_base(target, head, repository_root=ROOT)
    raw = bounded_stdout(["git", "-C", str(ROOT), "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, head, "--"], max_bytes=MAX_CHANGED_BYTES, timeout=30)
    files = raw.decode("utf-8").split("\0")
    if files.pop() != "" or not files or len(files) > MAX_CHANGED_PATHS or any(not name for name in files):
        raise Refused("Complete authored file inventory unavailable")
    policy = json.loads(git("show", authority + ":config/ci-governance.json"))
    protected = [name for name in files if any(guard._matches(name, rule) for rule in policy["main"]["protected_pipeline_paths"])]
    if not protected and set(files).intersection(guard.SEMANTIC_PIPELINE_PATHS):
        protected = guard.semantic_pipeline_changes(files, base=base, head=head, authority=authority, repository_root=ROOT)
    return "pipeline-editors" if protected else "allowed-maintainers-to-approve"


def same_pr(before, current):
    return (current["state"] == "open" and not current["draft"]
            and all(before[part][key] == current[part][key]
                    for part, key in (("head", "sha"), ("base", "sha"), ("base", "ref"))))


def native_codeowner_teams(pr_number, pr):
    """Confirm retained requests' native origin against the same complete PR view."""
    query = """query($number:Int!) { repository(owner:"hushh-labs",name:"hushh-research") {
      pullRequest(number:$number) { state isDraft headRefOid baseRefOid baseRefName
        reviewRequests(first:100) { totalCount pageInfo {hasNextPage} nodes {
          asCodeOwner requestedReviewer { __typename ... on Team {slug organization {login}} }
        } }
      }
    } }"""
    try:
        payload = json.loads(bounded_stdout(
            ["gh", "api", "graphql", "-f", f"query={query}", "-F", f"number={pr_number}"],
            max_bytes=2 * 1024 * 1024, timeout=30,
        ))
        current = payload["data"]["repository"]["pullRequest"]
        requests = current["reviewRequests"]
        nodes = requests["nodes"]
        complete = (
            not payload.get("errors") and type(current["isDraft"]) is bool and isinstance(nodes, list)
            and type(requests["totalCount"]) is int
            and requests["totalCount"] == len(nodes) <= 100
            and requests["pageInfo"]["hasNextPage"] is False
            and all(isinstance(node, dict) and type(node.get("asCodeOwner")) is bool
                    and isinstance(node.get("requestedReviewer"), dict) for node in nodes)
        )
        observed = {"state": current["state"].lower(), "draft": current["isDraft"],
                    "head": {"sha": current["headRefOid"]},
                    "base": {"sha": current["baseRefOid"], "ref": current["baseRefName"]}}
        if not complete or not same_pr(pr, observed):
            raise Refused("Native review requests are incomplete or their source changed")
        return {node["requestedReviewer"]["slug"] for node in nodes
                if node["asCodeOwner"] and node["requestedReviewer"]["__typename"] == "Team"
                and node["requestedReviewer"]["organization"]["login"] == REPO.split("/")[0]}
    except (KeyError, TypeError, AttributeError, json.JSONDecodeError) as error:
        raise Refused("Native review request metadata is unavailable") from error


def route(pr_number, *, apply=False, read=cli_read, write=None, classify=select_team,
          native_read=native_codeowner_teams):
    prefix = f"repos/{REPO}/pulls/{pr_number}"
    pr = read(prefix)
    if pr["state"] != "open" or pr["draft"] or pr["base"]["repo"]["full_name"] != REPO:
        raise Refused("Routing requires an open, ready canonical pull request")
    authority = read(f"repos/{REPO}/git/ref/heads/main")["object"]["sha"]
    expected = classify(pr, authority)
    if expected not in TEAMS:
        raise Refused("Unrecognized review Team")
    teams = read_teams(read)
    def approval_current():
        reviews = read(prefix + "/reviews?per_page=100")
        if not isinstance(reviews, list) or len(reviews) >= 100:
            raise Refused("Review inventory unavailable or incomplete")
        latest = {}
        for review in reviews:
            if review["state"] in {"APPROVED", "CHANGES_REQUESTED", "DISMISSED"}:
                latest[review["user"]["login"].lower()] = review
        eligible = {login.lower() for login in teams[expected]}
        return any(login in eligible and review["state"] == "APPROVED" and review["commit_id"] == pr["head"]["sha"] for login, review in latest.items())

    approved = approval_current()
    current = {team["slug"] for team in pr["requested_teams"]}
    remove = sorted((current & TEAMS) - {expected})
    add = expected not in current and not approved
    result = {"pr": pr_number, "head": pr["head"]["sha"], "team": expected, "add": add, "remove": remove, "already_approved": approved, "applied": False}
    if not apply or not (add or remove):
        return result
    actor = read("user")["login"]
    permissions = read(f"repos/{REPO}/collaborators/{actor}/permission")
    if permissions.get("permission") not in {"write", "admin", "maintain"}:
        raise Refused("Routing requires current repository write access")
    fresh = read(prefix)
    if not same_pr(pr, fresh):
        raise Refused("Pull request changed; replan before requesting review")
    approved = approval_current()
    current = {team["slug"] for team in fresh["requested_teams"]}
    add = expected not in current and not approved
    remove = sorted((current & TEAMS) - {expected})
    result.update(add=add, remove=remove, already_approved=approved)
    if add:
        write(prefix + "/requested_reviewers", "POST", {"team_reviewers": [expected]})
    observed = read(prefix)
    approved = approval_current()
    if not same_pr(pr, observed) or (not approved and expected not in {team["slug"] for team in observed["requested_teams"]}):
        raise Refused("Review request unconfirmed; inspect current state before retrying")
    remove = sorted(set(remove) & {team["slug"] for team in observed["requested_teams"]})
    if remove:
        write(prefix + "/requested_reviewers", "DELETE", {"reviewers": [], "team_reviewers": remove})
    final = read(prefix)
    approved = approval_current()
    if not same_pr(pr, final):
        raise Refused("Pull request changed during routing; replan")
    final_teams = {team["slug"] for team in final["requested_teams"]}
    if not approved and expected not in final_teams:
        raise Refused("Expected review Team request is unconfirmed")
    retained = (TEAMS & final_teams) - {expected}
    if retained:
        native_teams = native_read(pr_number, pr)
        confirmed = read(prefix)
        approved = approval_current()
        confirmed_teams = {team["slug"] for team in confirmed["requested_teams"]}
        confirmed_retained = (TEAMS & confirmed_teams) - {expected}
        if not same_pr(pr, confirmed) or not confirmed_retained <= retained:
            raise Refused("Pull request or review routing changed during native verification")
        if not approved and expected not in confirmed_teams:
            raise Refused("Expected review Team request is unconfirmed")
        if not confirmed_retained <= native_teams:
            raise Refused("Additional managed review Team remains without native code-owner evidence")
        if confirmed_retained:
            result["retained_native_codeowners"] = sorted(confirmed_retained)
        result["already_approved"] = approved
    result["applied"] = True
    return result


def write_request(path, method, body):
    subprocess.run(["gh", "api", path, "--method", method, "--input", "-"], input=json.dumps(body), text=True, capture_output=True, check=True, timeout=30)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pr", type=int, required=True)
    parser.add_argument("--apply", action="store_true", help="Request the routed Team and remove only the other managed Team")
    output = parser.add_mutually_exclusive_group()
    output.add_argument("--json", action="store_true")
    output.add_argument("--text", action="store_true")
    args = parser.parse_args()
    if args.pr <= 0:
        parser.error("--pr must be positive")
    try:
        result = route(args.pr, apply=args.apply, write=write_request)
        status = "reconciled" if result["applied"] else "no writes"
        if result.get("retained_native_codeowners"):
            if result["already_approved"]:
                status = "approval recorded"
            status += "; native code-owner request retained: " + ", ".join(result["retained_native_codeowners"])
        print(json.dumps(result, indent=2) if args.json else f"PR #{args.pr}: {result['team']} · {status}")
        return 0
    except (Refused, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f"Review routing refused: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

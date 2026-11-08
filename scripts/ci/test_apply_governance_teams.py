#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Unit checks for the managed-team mirror in scripts/ci/apply-governance.py.

Self-running (explicit `main()`), matching the sibling CI tests: a file of bare
pytest functions run as `python3 <file>` defines them and exits 0 without
asserting anything, which is how a governance test can look green while testing
nothing.

These cover the parts that hold offline: the selectors that turn the config into
each team's membership, the maintainer-subset invariant, and the member role.
Review-setting writes use synthetic GitHub responses; no live calls occur.
"""

# ruff: noqa: S101

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _module():
    path = Path(__file__).with_name("apply-governance.py")
    spec = importlib.util.spec_from_file_location("apply_governance", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_queue_timeout_preserves_all_other_parameters(module=None):
    import copy
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from prepared_branch_governance import queue_rules
    original = [{"type": "merge_queue", "parameters": {
        "check_response_timeout_minutes": 30, "merge_method": "MERGE",
        "max_entries_to_build": 5, "max_entries_to_merge": 1,
        "grouping_strategy": "ALLGREEN"}}]
    before = copy.deepcopy(original)
    expected = copy.deepcopy(original)
    expected[0]["parameters"]["check_response_timeout_minutes"] = 120
    assert queue_rules({"repository": {"merge_queue_check_timeout_minutes": 120}}, original) == expected
    assert original == before
    assert queue_rules({}, original) == before
    serial = copy.deepcopy(expected)
    serial[0]["parameters"]["max_entries_to_build"] = 1
    assert queue_rules({"repository": {"merge_queue_check_timeout_minutes": 120,
        "merge_queue_max_entries_to_build": 1}}, original) == serial
    assert original == before
    for bad in (False, 0, 2, 5, "1"):
        try:
            queue_rules({"repository": {"merge_queue_max_entries_to_build": bad}}, original)
        except SystemExit:
            pass
        else:
            raise AssertionError("Unqualified speculative build concurrency was accepted")
    for bad in (False, 0, 361, "120"):
        try:
            queue_rules({"repository": {"merge_queue_check_timeout_minutes": bad}}, original)
        except SystemExit:
            pass
        else:
            raise AssertionError("Invalid queue ceiling was accepted")


def test_queue_timeout_repair_preserves_authority_and_refuses_concurrent_change(module):
    import copy
    from unittest.mock import patch
    import prepared_branch_governance
    policy = _policy()
    rows = [{"id": index, "name": f"{branch} merge queue"} for index, branch in enumerate(("main", "dev", "uat"), 1)]
    records = {row["id"]: {**row, "target": "branch", "enforcement": "active",
        "conditions": {"ref_name": {"include": [f"refs/heads/{branch}"], "exclude": []}},
        "rules": [{"type": "merge_queue", "parameters": {"check_response_timeout_minutes": 30,
                  "merge_method": "MERGE", "max_entries_to_build": 5}}],
        "bypass_actors": [{"actor_id": 40542375, "actor_type": "User", "bypass_mode": "pull_request"}]}
        for row, branch in zip(rows, ("main", "dev", "uat"))}
    writes = []
    def read(args):
        if args[1].endswith("?per_page=100"): return rows
        return copy.deepcopy(records[int(args[1].rsplit("/", 1)[1])])
    def write(endpoint, body, method):
        assert method == "PUT"
        index = int(endpoint.rsplit("/", 1)[1])
        original = records[index]
        assert all(body[k] == original[k] for k in original if k not in ("rules", "id"))
        assert body["rules"][0]["parameters"] == {**original["rules"][0]["parameters"], "check_response_timeout_minutes": 120, "max_entries_to_build": 1}
        records[index] = {**body, "id": index}
        writes.append(endpoint)
    with patch.object(module, "gh_json", side_effect=read), patch.object(prepared_branch_governance, "_write", side_effect=write):
        assert module.reconcile_queue_timeouts(policy, apply=False)
        assert not writes
        assert module.reconcile_queue_timeouts(policy, apply=True)
        assert len(writes) == 3
        assert not module.reconcile_queue_timeouts(policy, apply=True)
    records[1]["rules"][0]["parameters"]["check_response_timeout_minutes"] = 30
    observed = [rows, *[copy.deepcopy(records[i]) for i in (1,2,3)], {"changed": True}]
    with patch.object(module, "gh_json", side_effect=observed), patch.object(prepared_branch_governance, "_write") as mutation:
        try:
            module.reconcile_queue_timeouts(policy, apply=True)
        except SystemExit as error:
            assert "changed before repair" in str(error)
        else:
            raise AssertionError("Concurrent ruleset change was overwritten")
        mutation.assert_not_called()


def test_codeowners_use_the_protected_team_for_every_protected_path(module):
    content = (REPO_ROOT / ".github/CODEOWNERS").read_text()
    entries = {line.split()[0]: line.split()[1:] for line in content.splitlines()
               if line.strip() and not line.startswith("#")}
    assert "*" not in entries
    assert entries and all(owners == ["@hushh-labs/pipeline-editors"] for owners in entries.values())
    for rule in _policy()["main"]["protected_pipeline_paths"]:
        assert entries[f"/{rule}"] == ["@hushh-labs/pipeline-editors"]
    assert "@kushaltrivedi5" not in content and "@ankitkumarsingh1702" not in content


def _policy() -> dict:
    policy = json.loads((REPO_ROOT / "config" / "ci-governance.json").read_text())
    policy.pop("authorization", None)  # Retained historical rollout fixtures.
    return policy


def test_governance_apply_never_overwrites_authoritative_team_members(module) -> None:
    from unittest.mock import patch
    with patch.object(module, "gh", side_effect=AssertionError("roster mutation")), \
         patch.object(module, "gh_json", side_effect=AssertionError("roster mutation")):
        assert module.sync_managed_teams(_policy(), apply=False) is False
        assert module.sync_managed_teams(_policy(), apply=True) is False


def test_every_managed_team_selects_from_the_committed_policy(module) -> None:
    """Each team resolves to a non-empty membership drawn from the real config."""
    policy = _policy()
    seen = set()
    for team in module.MANAGED_TEAMS:
        members = team["select"](policy)
        assert members, f"{team['slug']} selected nobody"
        assert members == sorted(set(members)), f"{team['slug']} is unsorted or has duplicates"
        assert team["slug"] not in seen, f"{team['slug']} declared twice"
        seen.add(team["slug"])


def test_deploy_and_pipeline_teams_are_subsets_of_maintainers(module) -> None:
    """The committed policy satisfies the invariant the sync refuses to break."""
    module.assert_teams_are_subsets_of_maintainers(_policy())


def test_the_invariant_actually_refuses_a_non_maintainer_grant(module) -> None:
    """A capability held by a non-maintainer must stop the sync, not mirror it.

    Without this the script would happily create a team encoding a grant nobody
    intended, and the team would then look like an authoritative record of it.
    """
    policy = _policy()
    policy["production"] = dict(policy["production"])
    policy["production"]["manual_dispatch_users"] = [
        *policy["production"]["manual_dispatch_users"],
        "somebody-who-cannot-merge",
    ]
    try:
        module.assert_teams_are_subsets_of_maintainers(policy)
    except SystemExit as exc:
        assert "somebody-who-cannot-merge" in str(exc)
        assert "deploy-production" in str(exc)
        return
    raise AssertionError("a non-maintainer holding production deploy was allowed through")


def test_the_privilege_rings_nest(module) -> None:
    """production must be inside uat, uat inside dev, dev inside the maintainers.

    A lane that is *more* privileged cannot be held by more people than a lane
    that is less privileged. This drifted once already: uat fell to 9 names while
    the merge cohort held 14, so five people who could land code on main could not
    validate it in UAT, and the one live check that noticed ran only in the
    advisory lane where nothing blocks. This assertion is pure config with no
    network, so it runs in the blocking governance lane instead.
    """
    policy = _policy()
    rings = [
        ("production", set(policy["production"]["manual_dispatch_users"])),
        ("uat", set(policy["uat"]["manual_dispatch_users"])),
        ("dev", set(policy["dev"]["manual_dispatch_users"])),
        ("maintainers", set(module.MANAGED_TEAMS[0]["select"](policy))),
    ]
    for (inner_name, inner), (outer_name, outer) in zip(rings, rings[1:]):
        leaked = sorted(inner - outer)
        assert not leaked, (
            f"{inner_name} is not contained by {outer_name}: {leaked} hold "
            f"{inner_name} without holding {outer_name}"
        )


def test_the_maintainer_set_is_the_union_of_both_governed_branches(module) -> None:
    policy = _policy()
    maintainers = set(module.MANAGED_TEAMS[0]["select"](policy))
    for key in ("main", "pr_train"):
        assert set(policy[key]["review_bypass_users"]) <= maintainers
        assert set(policy[key]["merge_queue_bypass_users"]) <= maintainers


def test_review_team_drift_is_repaired_without_changing_other_settings(module) -> None:
    from types import SimpleNamespace
    from unittest.mock import patch

    review = {
        "dismiss_stale_reviews": True,
        "require_code_owner_reviews": True,
        "require_last_push_approval": True,
        "required_approving_review_count": 2,
        "bypass_pull_request_allowances": {
            "users": [{"login": "maintainer"}], "teams": [],
            "apps": [{"slug": "existing-app"}],
        },
    }
    with patch.object(module, "gh_json", return_value={"required_pull_request_reviews": review}), patch.object(
        module.subprocess, "run", return_value=SimpleNamespace(returncode=0)
    ) as write:
        assert module.apply_review_bypass("main", ["maintainer"], team_slug="governed-team", apply=False)
        write.assert_not_called()
        assert module.apply_review_bypass("main", ["maintainer"], team_slug="governed-team", apply=True)
        payload = json.loads(write.call_args.kwargs["input"])
        for key in ("dismiss_stale_reviews", "require_code_owner_reviews", "require_last_push_approval", "required_approving_review_count"):
            assert payload[key] == review[key]
        assert payload["bypass_pull_request_allowances"] == {
            "users": ["maintainer"], "teams": ["governed-team"], "apps": ["existing-app"]
        }
        review["bypass_pull_request_allowances"]["teams"] = [{"slug": "governed-team"}]
        assert not module.apply_review_bypass("main", ["maintainer"], team_slug="governed-team", apply=True)
        assert write.call_count == 1


def _write_github_fixture(directory: Path) -> None:
    import os
    import sys

    executable = directory / "gh"
    executable.write_text("""#!/usr/bin/env python3
import json, os, sys
if sys.argv[1:3] == ['auth', 'status']: sys.exit(0)
endpoint = sys.argv[-1]
if endpoint.endswith('/members') and not {'--paginate', '--slurp'} <= set(sys.argv): sys.exit(2)
response = json.loads(os.environ['SYNTHETIC_GITHUB_RESPONSES']).get(endpoint, {'_error': 404})
if isinstance(response, dict) and '_error' in response: sys.exit(1)
if isinstance(response, dict) and '_raw' in response: print(response['_raw'])
else: print(json.dumps(response))
""", encoding="utf-8")
    executable.chmod(0o700)
    if os.name == "nt":
        (directory / "gh.cmd").write_text(
            f'@"{sys.executable}" "%~dp0gh" %*\n', encoding="utf-8", newline=""
        )


def _check_prepared_branches(policy, policy_file, base, environment, run) -> None:
    import copy

    # Prepared branches inherit authored protection policy, not deploy authority.
    for branch, policy_key in (("dev", "pr_train"), ("uat", "main")):
        prepared_policy = copy.deepcopy(policy)
        prepared_policy[policy_key] = copy.deepcopy(policy["main"])
        prepared_policy["branch_flow"]["prepared_branches"] = {
            branch: {"policy_key": policy_key, "merge_queue_ruleset_name": f"{branch} merge queue"}
        }
        policy_file.write_text(json.dumps(prepared_policy), encoding="utf-8")
        sample = copy.deepcopy(base)
        for suffix in ("protection",):
            sample[f"repos/synthetic-org/repo/branches/{branch}/{suffix}"] = sample[
                f"repos/synthetic-org/repo/branches/main/{suffix}"]
        sample[f"repos/synthetic-org/repo/rules/branches/{branch}"] = sample[
            "repos/synthetic-org/repo/rules/branches/main"]
        detail = sample["repos/synthetic-org/repo/rulesets/7"]
        detail.update(name=f"{branch} merge queue", target="branch", enforcement="active",
                      conditions={"ref_name": {"include": [f"refs/heads/{branch}"], "exclude": []}},
                      rules=[{"type": "merge_queue", "parameters": {"group": 1}}])
        environment["GITHUB_BRANCH"] = branch
        accepted = run(sample)
        assert accepted.returncode == 0, accepted.stdout + accepted.stderr
        environment["GITHUB_POLICY_KEY"] = "dev"
        wrong_policy = run(sample)
        assert wrong_policy.returncode != 0 and "no matching authored protection policy" in wrong_policy.stdout
        del environment["GITHUB_POLICY_KEY"]
        for change in (
            {"conditions": {"ref_name": {"include": ["refs/heads/other"], "exclude": []}}},
            {"rules": [{"type": "deletion"}]},
            {"enforcement": "disabled"},
        ):
            invalid = copy.deepcopy(sample)
            invalid["repos/synthetic-org/repo/rulesets/7"].update(change)
            rejected = run(invalid)
            assert rejected.returncode != 0 and "exact-ref named merge queue" in rejected.stdout
        sample["repos/synthetic-org/repo/rulesets/7"]["name"] = "Queue"
        rejected = run(sample)
        assert rejected.returncode != 0, "A Main queue cannot prove the prepared branch queue"
    policy_file.write_text(json.dumps(policy), encoding="utf-8")
    environment["GITHUB_BRANCH"] = "unknown-branch"
    unknown = copy.deepcopy(base)
    unknown["repos/synthetic-org/repo/branches/unknown-branch/protection"] = base[
        "repos/synthetic-org/repo/branches/main/protection"]
    unknown["repos/synthetic-org/repo/rules/branches/unknown-branch"] = []
    rejected = run(unknown)
    assert rejected.returncode != 0 and "no matching authored protection policy" in rejected.stdout
    environment["GITHUB_BRANCH"] = "main"



def test_live_verifier_distinguishes_pending_activation_without_granting_authority(module) -> None:
    """Exercise the real verifier; pending never conceals protection/actor drift."""
    import copy
    import os
    import subprocess
    import tempfile

    policy = _policy()
    policy["branch_flow"].pop("review_rulesets", None)  # Historical classic-policy fixture.
    policy["main"].pop("owner_admin_ruleset_name", None)
    policy["main"] = {
        **policy["main"],
        "review_bypass_users": ["operator", "invitee"],
        "merge_queue_bypass_users": ["operator", "invitee"],
        "review_bypass_team_slug": "maintainers",
        "merge_queue_bypass_team_slug": "maintainers",
        "merge_queue_bypass_team_name": "Maintainers",
        "merge_queue_ruleset_name": "Queue",
        "require_strict_status_checks": True,
        "merge_users": [],
    }
    team = "organizations/140115870/team/42"
    membership = "orgs/synthetic-org/teams/maintainers/memberships/invitee"
    base = {
        "user": {"login": "operator"},
        "repos/synthetic-org/repo": {"allow_auto_merge": True},
        "repos/synthetic-org/repo/branches/main/protection": {
            "required_status_checks": {"contexts": ["CI Status Gate"], "strict": True},
            "required_pull_request_reviews": {
                "required_approving_review_count": 1, "require_last_push_approval": True,
                "require_code_owner_reviews": True,
                "bypass_pull_request_allowances": {
                    "users": [{"login": "invitee"}, {"login": "operator"}],
                    "teams": [{"slug": "maintainers"}],
                },
            },
            "required_conversation_resolution": {"enabled": True},
            "enforce_admins": {"enabled": True},
        },
        "repos/synthetic-org/repo/rules/branches/main": [{"type": "merge_queue", "parameters": {"group": 1}}],
        "repos/synthetic-org/repo/rulesets?includes_parents=true": [{"id": 7, "target": "branch", "enforcement": "active"}],
        "repos/synthetic-org/repo/rulesets/7": {"name": "Queue", "bypass_actors": [{"actor_type": "Team", "actor_id": 42}]},
        team: {"slug": "maintainers", "name": "Maintainers"},
        f"{team}/members": [[{"login": "operator"}], []],
        membership: {"state": "pending", "role": "member"},
    }
    with tempfile.TemporaryDirectory(prefix="hushh-governance-verifier-") as scratch:
        directory = Path(scratch)
        _write_github_fixture(directory)
        policy_file = directory / "policy.json"
        policy_file.write_text(json.dumps(policy), encoding="utf-8")
        environment = {key: value for key, value in os.environ.items() if not key.startswith("GITHUB_")}
        environment.update(PATH=f"{directory}{os.pathsep}{environment['PATH']}",
                           GITHUB_REPO="synthetic-org/repo", GITHUB_BRANCH="main",
                           GITHUB_CI_GOVERNANCE_FILE=str(policy_file))

        def run(responses):
            return subprocess.run(
                ["bash", "scripts/ci/verify-main-branch-protection.sh"], cwd=REPO_ROOT,
                env={**environment, "SYNTHETIC_GITHUB_RESPONSES": json.dumps(responses)},
                capture_output=True, text=True, check=False,
            )

        accepted = run(base)
        assert accepted.returncode == 0, accepted.stdout + accepted.stderr
        assert "ADVISORY: approved queue-team invitations await activation" in accepted.stdout
        assert "merge_queue_bypass=['operator']" in accepted.stdout

        _check_prepared_branches(policy, policy_file, base, environment, run)

        no_bypass_policy = copy.deepcopy(policy)
        no_bypass_policy["main"].update(merge_queue_bypass_users=[],
            merge_queue_bypass_team_slug="", merge_queue_bypass_team_name="")
        policy_file.write_text(json.dumps(no_bypass_policy), encoding="utf-8")
        for actor_type in ("Integration", "RepositoryRole", "OrganizationAdmin", "User"):
            invalid = copy.deepcopy(base)
            invalid["repos/synthetic-org/repo/rulesets/7"]["bypass_actors"] = [
                {"actor_type": actor_type, "actor_id": 99, "bypass_mode": "always"}]
            rejected = run(invalid)
            assert rejected.returncode != 0 and "forbids every bypass actor" in rejected.stderr
        policy_file.write_text(json.dumps(policy), encoding="utf-8")

        # Negative controls: no blanket allowance for missing users or drift.
        cases = []
        for response in ({"_error": 404}, {"_raw": "{"}, {},
                         {"state": "pending", "role": "maintainer"},
                         {"state": "active", "role": "member"}):
            sample = copy.deepcopy(base)
            sample[membership] = response
            cases.append(sample)
        pending_actor = copy.deepcopy(base)
        pending_actor["user"] = {"login": "invitee"}
        cases.append(pending_actor)
        extra_on_second_page = copy.deepcopy(base)
        extra_on_second_page[f"{team}/members"][1] = [{"login": "unauthorized"}]
        cases.append(extra_on_second_page)
        wrong_team = copy.deepcopy(base)
        wrong_team[team]["slug"] = "other-team"
        cases.append(wrong_team)
        missing_check = copy.deepcopy(base)
        missing_check["repos/synthetic-org/repo/branches/main/protection"]["required_status_checks"]["contexts"] = []
        cases.append(missing_check)
        for sample in cases:
            rejected = run(sample)
            assert rejected.returncode != 0, "Pending activation concealed an authority/protection failure"


def test_prepared_branch_reconciliation_is_scoped_and_fail_closed(module) -> None:
    import copy
    import importlib

    prepared = importlib.import_module("prepared_branch_governance")
    policy = _policy()
    policy["branch_flow"]["prepared_branches"]["dev"].pop("owner_admin_ruleset_name", None)
    rulesets = [{"name": policy["pr_train"]["merge_queue_ruleset_name"], "id": 1}]
    template = {"enforcement": "active", "rules": [{"type": "merge_queue", "parameters": {"merge_method": "MERGE"}}]}
    reads, writes = [], []

    def read(args):
        endpoint = args[1]
        reads.append(endpoint)
        if "rulesets?" in endpoint:
            return rulesets
        if endpoint.endswith("rulesets/1"):
            return template
        if "/teams/" in endpoint:
            return {"id": 2}
        if "/git/ref/" in endpoint:
            return {"object": {"sha": "a" * 40}}
        raise AssertionError(f"Unexpected authority read: {endpoint}")

    def raw(args, *, check):
        assert not check and args[1].endswith("branches/dev/protection")
        return 1, "", "Branch not protected (HTTP 404)"

    original = prepared._write
    prepared._write = lambda endpoint, payload, method: writes.append((endpoint, payload, method))
    try:
        prepared.reconcile(policy, ["dev"], repo=module.REPO, read=read, raw=raw, apply=False)
        assert not writes, "Dry-run mutated GitHub"
        prepared.reconcile(policy, ["dev"], repo=module.REPO, read=read, raw=raw, apply=True)
        assert len(writes) == 2
        assert writes[1][0].endswith("branches/dev/protection")
        queue = writes[0][1]
        assert queue["conditions"]["ref_name"] == {"include": ["refs/heads/dev"], "exclude": []}
        assert queue["bypass_actors"] == []
        assert not any("/branches/main" in value or "/members" in value for value in reads)
        writes.clear()
        reads.clear()
        try:
            prepared.reconcile(policy, ["main"], repo=module.REPO, read=read, raw=raw, apply=True)
        except SystemExit:
            pass
        else:
            raise AssertionError("Undeclared selection accepted")
        assert not reads and not writes
        for current in ({"restrictions": {"users": ["owner"]}},
                        {"required_pull_request_reviews": {"require_code_owner_reviews": True}}):
            try:
                prepared._assert_no_unowned_protection(current)
            except SystemExit:
                pass
            else:
                raise AssertionError("Unowned stronger protection would be removed")
        duplicate = {"name": policy["branch_flow"]["prepared_branches"]["dev"]["merge_queue_ruleset_name"], "id": 3}
        rulesets.extend([duplicate, copy.deepcopy(duplicate)])
        try:
            prepared.reconcile(policy, ["dev"], repo=module.REPO, read=read, raw=raw, apply=True)
        except SystemExit:
            pass
        else:
            raise AssertionError("Ambiguous rulesets accepted")
        assert not writes
    finally:
        prepared._write = original


def test_protected_approval_requires_current_head_and_current_owner_state(_module_unused) -> None:
    from unittest.mock import patch
    import github_security_authority

    path = Path(__file__).with_name("verify-protected-pipeline-edits.py")
    spec = importlib.util.spec_from_file_location("protected_pipeline_guard", path)
    assert spec and spec.loader
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    head = "a" * 40
    owner = "ankitkumarsingh1702"
    def review(identifier, state, commit=head):
        return {"id": identifier, "state": state, "commit_id": commit, "user": {"login": owner}}
    for rows, expected in (
        ([review(1, "APPROVED")], [owner]),
        ([review(1, "APPROVED", "b" * 40)], []),
        ([review(1, "APPROVED"), review(2, "DISMISSED")], []),
        ([review(1, "APPROVED"), review(2, "CHANGES_REQUESTED")], []),
        ([review(1, "APPROVED"), review(2, "COMMENTED")], [owner]),
    ):
        class FakeGitHub:
            def __init__(self, *args): pass
            def read(self, path): return rows
        with patch.object(github_security_authority, "GitHub", FakeGitHub):
            assert guard._owner_approvals("hushh-labs/hushh-research", 1, head, [owner], "not-a-token") == expected


def main() -> int:
    module = _module()
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for test in tests:
        test(module)
        print(f"  ok  {test.__name__}")
    print(f"apply-governance managed-team checks passed ({len(tests)} tests).")
    return 0


def test_main_merge_rollout_refuses_existing_review_bypass(module) -> None:
    from unittest.mock import patch

    policy = _policy()
    protection = {"required_pull_request_reviews": {
        "require_code_owner_reviews": True, "require_last_push_approval": True,
        "required_approving_review_count": 1,
        "bypass_pull_request_allowances": {"users": [{"login": "old-maintainer"}]},
    }, "enforce_admins": {"enabled": True}}
    with patch.object(module, "gh_json", return_value=protection):
        try:
            module.reconcile_main_merge_policy(policy, apply=True)
        except SystemExit as error:
            assert "required Main review" in str(error)
        else:
            raise AssertionError("review bypass survived Main authority rollout")


def test_main_policy_separates_mergers_reviews_and_uat_access(module) -> None:
    policy = _policy()
    main = policy["main"]
    assert main["merge_users"] == policy["production"]["manual_dispatch_users"]
    assert main["review_bypass_users"] == main["protected_pipeline_edit_users"]
    assert not main["review_bypass_team_slug"]
    assert main["merge_queue_bypass_team_slug"] == policy["pr_train"]["merge_queue_bypass_team_slug"] == ""
    assert policy["branch_flow"]["prepared_branches"]["uat"]["policy_key"] == "uat_merge"
    assert policy["uat_merge"]["merge_queue_bypass_users"] == policy["pr_train"]["merge_queue_bypass_users"]



def test_main_queue_bypass_is_removed_before_relaxing_strict_checks(module) -> None:
    from unittest.mock import patch
    import prepared_branch_governance

    policy = _policy()
    # Retain coverage of the prior immutable human-writer policy, including
    # its array-shaped REST endpoint contract.
    policy["main"]["restrict_writes_to_merge_users"] = True
    policy["main"]["merge_queue_bypass_users"] = []
    policy["main"].pop("owner_admin_ruleset_name", None)
    protection = {
        "required_pull_request_reviews": {
            "require_code_owner_reviews": True, "require_last_push_approval": True,
            "required_approving_review_count": 1, "bypass_pull_request_allowances": {
                "users": [{"login": name} for name in policy["main"]["review_bypass_users"]]},
        },
        "enforce_admins": {"enabled": True},
        "required_status_checks": {"strict": True, "checks": [{"context": "CI Status Gate", "app_id": 15368}]},
        "restrictions": {"users": [{"login": name} for name in policy["main"]["merge_users"]]},
    }
    queue = {"name": policy["main"]["merge_queue_ruleset_name"], "target": "branch",
             "enforcement": "active", "conditions": {"ref_name": {"include": ["refs/heads/main"], "exclude": []}},
             "rules": [{"type": "merge_queue", "parameters": {"check_response_timeout_minutes": 30}}],
             "bypass_actors": [{"actor_id": 7, "actor_type": "Team", "bypass_mode": "pull_request"}]}
    for scope in ("refs/heads/main", "~DEFAULT_BRANCH"):
        queue["conditions"]["ref_name"]["include"] = [scope]
        reads = [protection, [{"id": 1, "name": queue["name"]}], queue]
        if scope == "~DEFAULT_BRANCH":
            reads.append({"default_branch": "main"})
        writes = []
        with patch.object(module, "gh_json", side_effect=reads), \
             patch.object(prepared_branch_governance, "_write", side_effect=lambda *args: writes.append(args)):
            assert module.reconcile_main_merge_policy(policy, apply=True)
        assert len(writes) == 2
        assert writes[0][0].endswith("/rulesets/1") and writes[0][1]["bypass_actors"] == []
        assert writes[0][1]["conditions"] == {"ref_name": {"include": ["refs/heads/main"], "exclude": []}}
        assert writes[1][0].endswith("/required_status_checks") and writes[1][1]["strict"] is False
        assert writes[1][1]["checks"] == protection["required_status_checks"]["checks"]
    # A changed or unavailable default branch cannot authorize any mutation.
    for repository in ({"default_branch": "dev"}, {}, None):
        with patch.object(module, "gh_json", side_effect=[protection, [{"id": 1, "name": queue["name"]}], queue, repository]), \
             patch.object(prepared_branch_governance, "_write") as write:
            try:
                module.reconcile_main_merge_policy(policy, apply=True)
            except SystemExit as error:
                assert "does not resolve to Main" in str(error)
            else:
                raise AssertionError("Unverified default branch authorized a Main ruleset mutation")
            write.assert_not_called()

    # The individual restriction endpoints accept arrays, unlike /protection.
    # Exercise real serialization so a dict-shaped stub cannot conceal HTTP 422.
    from types import SimpleNamespace

    queue["conditions"] = {"ref_name": {"include": ["refs/heads/main"], "exclude": []}}
    queue["bypass_actors"] = []
    queue["rules"][0]["parameters"]["check_response_timeout_minutes"] = 120
    queue["rules"][0]["parameters"]["max_entries_to_build"] = 1
    protection["required_status_checks"]["strict"] = False
    protection["restrictions"]["users"] = [{"login": "retired-operator"}]
    requests = []

    def put(command, **kwargs):
        assert command[:4] == ["gh", "api", "--method", "PUT"]
        assert command[4].endswith("/restrictions/users")
        assert json.loads(kwargs["input"]) == sorted(policy["main"]["merge_users"])
        requests.append(command)
        return SimpleNamespace(returncode=0, stderr="")

    with patch.object(module, "gh_json", side_effect=[protection, [{"id": 1, "name": queue["name"]}], queue]), \
         patch.object(prepared_branch_governance.subprocess, "run", side_effect=put):
        assert module.reconcile_main_merge_policy(policy, apply=True)
    assert len(requests) == 1


def test_native_main_queue_writer_removal_preserves_guards_and_refuses_races(module) -> None:
    import copy
    from unittest.mock import patch
    from prepared_branch_governance import queue_rules

    policy = _policy()
    policy["main"]["restrict_writes_to_merge_users"] = False
    owners = policy["main"]["merge_queue_bypass_users"]
    identities = {login: {"login": login, "type": "User", "id": 100 + i}
                  for i, login in enumerate(owners)}
    base = {
        "required_pull_request_reviews": {
            "require_code_owner_reviews": True, "require_last_push_approval": True,
            "required_approving_review_count": 1,
            "bypass_pull_request_allowances": {"users": [{"login": login} for login in owners]},
        },
        "enforce_admins": {"enabled": True},
        "required_conversation_resolution": {"enabled": True},
        "required_status_checks": {"strict": False, "checks": [{"context": "CI Status Gate", "app_id": 15368}]},
        "restrictions": {"users": [{"login": login} for login in policy["main"]["merge_users"]], "teams": [], "apps": []},
    }
    queue = {"name": policy["main"]["merge_queue_ruleset_name"], "target": "branch",
             "enforcement": "active", "conditions": {"ref_name": {"include": ["refs/heads/main"], "exclude": []}},
             "rules": queue_rules(policy, [{"type": "merge_queue", "parameters": {"merge_method": "MERGE"}}]),
             "bypass_actors": [{"actor_id": identities[login]["id"], "actor_type": "User", "bypass_mode": "pull_request"} for login in sorted(owners)]}
    endpoint = f"repos/{module.REPO}/branches/main/protection"
    queue_endpoint = f"repos/{module.REPO}/rulesets/1"
    for fault in (None, "reordered", "after_omits_restrictions", "after_empty_restrictions", "duplicate_actor", "bad_actor_mode", "already_active", "protection_race", "queue_race", "foreign_writer", "missing_review", "missing_check", "missing_native_guard", "unlanded_policy", "main_race", "after_only_field"):
        protection, observed_queue = copy.deepcopy(base), copy.deepcopy(queue)
        writes, verified, reads = [], [], {"protection": 0, "queue": 0, "main": 0}
        if fault == "already_active": protection["restrictions"] = None
        if fault == "foreign_writer": protection["restrictions"]["teams"] = [{"slug": "unreviewed"}]
        if fault == "missing_review": protection["required_pull_request_reviews"]["required_approving_review_count"] = 0
        if fault == "missing_check": protection["required_status_checks"]["checks"][0]["app_id"] = None
        if fault == "reordered": observed_queue["bypass_actors"].reverse()
        if fault == "duplicate_actor": observed_queue["bypass_actors"].append(copy.deepcopy(observed_queue["bypass_actors"][0]))
        if fault == "bad_actor_mode": observed_queue["bypass_actors"][0]["bypass_mode"] = "always"

        def read(args):
            path = args[1]
            if path.endswith("git/ref/heads/main"):
                reads["main"] += 1
                return {"object": {"sha": ("b" if fault == "main_race" and reads["main"] > 1 else "a") * 40}}
            if "/contents/config/ci-governance.json?ref=" in path:
                import base64
                captured = copy.deepcopy(policy)
                if fault == "unlanded_policy": captured["main"]["restrict_writes_to_merge_users"] = True
                return {"content": base64.b64encode(json.dumps(captured).encode()).decode()}
            if path == endpoint:
                reads["protection"] += 1
                result = copy.deepcopy(protection)
                if fault == "protection_race" and reads["protection"] > 1: result["unowned"] = True
                return result
            if path == queue_endpoint:
                reads["queue"] += 1
                result = copy.deepcopy(observed_queue)
                if fault == "queue_race" and reads["queue"] > 1: result["bypass_actors"] = []
                return result
            if path.endswith("rulesets?per_page=100"): return [{"id": 1, "name": queue["name"]}]
            if path.startswith("users/"): return identities[path.split("/")[1]]
            raise AssertionError(path)

        def guard(*args, **kwargs):
            assert kwargs.get("verify_only") is True and not kwargs.get("apply")
            verified.append(True)
            if fault == "missing_native_guard": raise SystemExit("Native protected guard is absent")

        def write(args):
            assert args == ["api", "--method", "DELETE", endpoint + "/restrictions"]
            writes.append(args)
            protection["restrictions"] = None
            if fault == "after_omits_restrictions": protection.pop("restrictions")
            if fault == "after_empty_restrictions": protection["restrictions"] = {}
            if fault == "after_only_field": protection["unowned"] = True

        with patch.object(module, "gh_json", side_effect=read), patch.object(module, "gh", side_effect=write), \
             patch.object(module, "reconcile_protected_pipeline_review", side_effect=guard), \
             patch.object(module, "reconcile_owner_admin_ruleset", side_effect=guard), \
             patch("prepared_branch_governance._write", side_effect=AssertionError("Unexpected queue mutation")):
            if fault in (None, "reordered", "after_omits_restrictions", "already_active"):
                assert module.reconcile_main_merge_policy(policy, apply=True) is (fault != "already_active")
                assert len(writes) == (0 if fault == "already_active" else 1)
                assert protection.get("restrictions") is None
                assert {key: value for key, value in protection.items() if key != "restrictions"} == {key: value for key, value in base.items() if key != "restrictions"}
                assert len(verified) == (2 if fault == "already_active" else 4)
            else:
                try: module.reconcile_main_merge_policy(policy, apply=True)
                except SystemExit: pass
                else: raise AssertionError(f"{fault} authorized writer removal")
                assert len(writes) == (1 if fault in ("after_only_field", "after_empty_restrictions") else 0)


def test_prepared_rollout_rejects_bypass_with_non_strict_checks(module) -> None:
    import prepared_branch_governance
    from unittest.mock import patch

    policy = _policy()
    policy["branch_flow"]["prepared_branches"]["dev"].pop("owner_admin_ruleset_name", None)
    policy["pr_train"]["merge_queue_bypass_team_slug"] = "unsafe-team"
    template = {"enforcement": "active", "rules": [{"type": "merge_queue", "parameters": {"merge_method": "MERGE"}}]}
    with patch.object(prepared_branch_governance, "_write") as write:
        try:
            prepared_branch_governance.reconcile(policy, ["dev"], repo=module.REPO,
                read=lambda args: ([{"id": 1, "name": policy["pr_train"]["merge_queue_ruleset_name"]}]
                                   if "rulesets?" in args[1] else template),
                raw=lambda *args, **kwargs: None, apply=True)
        except SystemExit as error:
            assert "queue bypass" in str(error)
        else:
            raise AssertionError("Unsafe direct-merge bypass survived the rollout")
        write.assert_not_called()


def test_main_review_migration_orders_replacement_and_refuses_unsafe_queue(module) -> None:
    import copy
    from unittest.mock import patch
    import prepared_branch_governance

    policy = _policy()
    endpoint = f"repos/{module.REPO}/branches/main/protection"
    inventory = f"repos/{module.REPO}/rulesets?per_page=100"
    queue_path = f"repos/{module.REPO}/rulesets/1"
    user_rows = {f"users/{login}": {"login": login, "type": "User", "id": index}
                 for index, login in enumerate(policy["main"]["review_bypass_users"], 100)}
    protection = {"enforce_admins": {"enabled": True},
                  "required_conversation_resolution": {"enabled": True},
                  "required_status_checks": {"checks": [{"context": "CI Status Gate", "app_id": 15368}]},
                  "required_pull_request_reviews": {"required_approving_review_count": 1}}
    queue = {"enforcement": "active", "conditions": {"ref_name": {"include": ["refs/heads/main"], "exclude": []}},
             "bypass_actors": [], "rules": [{"type": "merge_queue"}]}
    def fixture():
        return {**copy.deepcopy(user_rows), endpoint: copy.deepcopy(protection),
                inventory: [{"id": 1, "name": policy["main"]["merge_queue_ruleset_name"]}],
                queue_path: copy.deepcopy(queue)}
    def reader(state):
        return lambda args: copy.deepcopy(state[args[1]])
    state = fixture()
    writes = []
    def write(path, payload, method):
        writes.append((method, path))
        assert method == "POST"
        state[inventory].append({"id": 2, "name": payload["name"]})
        state[f"repos/{module.REPO}/rulesets/2"] = copy.deepcopy(payload)
    def delete(args):
        assert args[:3] == ["api", "--method", "DELETE"]
        # Replacement is already visible, with no queue bypass.
        module.verify_main_review_ruleset(policy, read=reader(state))
        assert not state[queue_path]["bypass_actors"]
        writes.append(("DELETE", args[3]))
        state[endpoint]["required_pull_request_reviews"] = None
        return 0, "", ""
    with patch.object(module, "gh_json", side_effect=reader(state)), \
         patch.object(module, "gh", side_effect=delete), \
         patch.object(prepared_branch_governance, "_write", side_effect=write):
        assert module.reconcile_main_review_ruleset(policy, apply=False)
        assert writes == []
        assert module.reconcile_main_review_ruleset(policy, apply=True)
        assert [w[0] for w in writes] == ["POST", "DELETE"]
        assert not module.reconcile_main_review_ruleset(policy, apply=True)
        assert len(writes) == 2
    for violation in ("queue_bypass", "readback", "stronger_review"):
        state = fixture()
        if violation == "queue_bypass":
            state[queue_path]["bypass_actors"] = [{"actor_type": "Team", "actor_id": 1}]
        if violation == "stronger_review":
            state[endpoint]["required_pull_request_reviews"]["dismiss_stale_reviews"] = True
        with patch.object(module, "gh_json", side_effect=reader(state)), \
             patch.object(module, "gh") as deletion, \
             patch.object(prepared_branch_governance, "_write") as creation:
            try:
                module.reconcile_main_review_ruleset(policy, apply=True)
            except SystemExit:
                pass
            else:
                raise AssertionError(f"Unsafe review migration accepted: {violation}")
            deletion.assert_not_called()
            if violation != "readback":
                creation.assert_not_called()


def test_review_ruleset_rejects_other_boundary_and_authority(module) -> None:
    import copy
    policy = _policy()
    assert set(policy["branch_flow"]["review_rulesets"]) == {"main"}
    def read(args):
        login = args[1].split("/")[-1]
        return {"login": login, "type": "User", "id": policy["main"]["review_bypass_users"].index(login) + 1}
    desired = module.main_review_ruleset(policy, read=read)
    assert module.same_review_ruleset(desired, desired)
    observed = copy.deepcopy(desired)
    observed["rules"][0]["parameters"].update({
        "dismissal_restriction": {"enabled": False, "allowed_actors": []},
        "allowed_merge_methods": ["merge", "squash", "rebase"], "required_reviewers": [],
    })
    assert module.same_review_ruleset(observed, desired)
    observed["rules"][0]["parameters"]["require_extra_approval_for_unattributed_changes"] = False
    assert not module.same_review_ruleset(observed, desired)
    for change in (
        {"conditions": {"ref_name": {"include": ["refs/heads/dev"], "exclude": []}}},
        {"enforcement": "disabled"}, {"rules": [{"type": "merge_queue"}]},
        {"bypass_actors": [{"actor_type": "OrganizationAdmin", "bypass_mode": "always"}]},
    ):
        invalid = copy.deepcopy(desired)
        invalid.update(change)
        assert not module.same_review_ruleset(invalid, desired)


def test_owner_admin_native_guard_preserves_review_and_nonowner_queue(module) -> None:
    import copy

    policy = _policy()
    people = policy["main"]["merge_users"]

    def read(args):
        login = args[1].split("/")[-1]
        return {"login": login, "type": "User", "id": people.index(login) + 1}

    guard = module.main_owner_admin_ruleset(policy, read=read)
    owners = set(policy["main"]["protected_pipeline_edit_users"])
    assert {a["actor_id"] for a in guard["bypass_actors"]} == {
        people.index(p) + 1 for p in set(people) - owners
    }
    rules = {r["type"]: r["parameters"] for r in guard["rules"]}
    assert rules["required_status_checks"] == {
        "strict_required_status_checks_policy": True,
        "do_not_enforce_on_create": False,
        "required_status_checks": [
            {"context": "CI Status Gate", "integration_id": 15368}
        ],
    }
    assert rules["pull_request"]["required_approving_review_count"] == 0
    assert rules["pull_request"]["required_review_thread_resolution"] is True
    assert module.same_owner_admin_ruleset(guard, guard)
    # The shell parity verifier imports by file path, without scripts/ci on
    # sys.path. Read-only inspection must not import the mutation helper.
    import builtins
    from unittest.mock import patch

    original_import = builtins.__import__

    def isolated_import(name, *args, **kwargs):
        if name == "prepared_branch_governance":
            raise ModuleNotFoundError(name)
        return original_import(name, *args, **kwargs)

    def inspect(args):
        if args[1].endswith("/rulesets?per_page=100"):
            return [{"id": 1, "name": guard["name"]}]
        if args[1].endswith("/rulesets/1"):
            return guard
        return read(args)

    with patch("builtins.__import__", side_effect=isolated_import):
        assert module.reconcile_owner_admin_ruleset(
            policy, verify_only=True, read=inspect
        ) is False
    for change in ("strict", "ci_app", "owner_bypass", "no_pr"):
        bad = copy.deepcopy(guard)
        if change == "strict":
            bad["rules"][0]["parameters"]["strict_required_status_checks_policy"] = (
                False
            )
        if change == "ci_app":
            bad["rules"][0]["parameters"]["required_status_checks"][0][
                "integration_id"
            ] = 1
        if change == "owner_bypass":
            bad["bypass_actors"].append(
                {
                    "actor_id": people.index("kushaltrivedi5") + 1,
                    "actor_type": "User",
                    "bypass_mode": "always",
                }
            )
        if change == "no_pr":
            bad["rules"].pop()
        assert not module.same_owner_admin_ruleset(bad, guard), change
    policy["main"]["merge_queue_bypass_users"].append("imsharukhan")
    try:
        module.main_owner_admin_ruleset(policy, read=read)
    except SystemExit:
        pass
    else:
        raise AssertionError("Nonowner acquired owner Admin route")

def test_owner_admin_grant_follows_verified_strict_guard(module) -> None:
    from unittest.mock import patch
    import prepared_branch_governance

    policy = _policy()
    # This test owns the legacy guard-before-grant transition, not the new
    # writer-only removal once that guard is already installed.
    policy["main"]["restrict_writes_to_merge_users"] = True
    protection = {
        "enforce_admins": {"enabled": True},
        "required_pull_request_reviews": {
            "require_code_owner_reviews": True,
            "require_last_push_approval": True,
            "required_approving_review_count": 1,
            "bypass_pull_request_allowances": {
                "users": [{"login": p} for p in policy["main"]["review_bypass_users"]]
            },
        },
        "required_status_checks": {
            "strict": False,
            "checks": [{"context": "CI Status Gate", "app_id": 15368}],
        },
        "restrictions": {
            "users": [{"login": p} for p in policy["main"]["merge_users"]]
        },
    }
    queue = {
        "name": policy["main"]["merge_queue_ruleset_name"],
        "target": "branch",
        "enforcement": "active",
        "conditions": {"ref_name": {"include": ["refs/heads/main"], "exclude": []}},
        "rules": [{"type": "merge_queue", "parameters": {"check_response_timeout_minutes": 30}}],
        "bypass_actors": [],
    }
    calls = []

    def read(args):
        path = args[1]
        if path.startswith("users/"):
            login = path.split("/")[-1]
            return {
                "login": login,
                "type": "User",
                "id": policy["main"]["merge_users"].index(login) + 1,
            }
        if path.endswith("/protection"):
            return protection
        if path.endswith("/rulesets?per_page=100"):
            return [{"id": 1, "name": queue["name"]}]
        if path.endswith("/rulesets/1"):
            return queue
        raise AssertionError(path)

    with (
        patch.object(module, "gh_json", side_effect=read),
        patch.object(
            module,
            "reconcile_owner_admin_ruleset",
            side_effect=lambda *a, **k: calls.append("guard_verified"),
        ),
        patch.object(
            prepared_branch_governance, "_write", side_effect=lambda *a: calls.append(a)
        ),
    ):
        assert module.reconcile_main_merge_policy(policy, apply=True)
    assert calls[0] == "guard_verified" and len(calls) == 2
    assert {a["actor_id"] for a in calls[1][1]["bypass_actors"]} == {
        policy["main"]["merge_users"].index(p) + 1
        for p in policy["main"]["protected_pipeline_edit_users"]
    }
    with (
        patch.object(module, "gh_json", side_effect=read),
        patch.object(
            module,
            "reconcile_owner_admin_ruleset",
            side_effect=SystemExit("missing strict guard"),
        ),
        patch.object(prepared_branch_governance, "_write") as write,
    ):
        try:
            module.reconcile_main_merge_policy(policy, apply=True)
        except SystemExit:
            pass
        else:
            raise AssertionError("Missing strict guard accepted")
        write.assert_not_called()

def _native_review_fixture(module):
    import copy
    from types import SimpleNamespace

    policy = _policy()
    owners = policy["main"]["protected_pipeline_edit_users"]
    state = {
        "actor": owners[0], "admins": set(owners), "grant": None, "writes": [],
        "members": [{"login": owner, "type": "User"} for owner in owners],
        "rules": {1: {"id": 1, "name": "retained queue", "target": "branch", "rules": [{"type": "merge_queue"}]}},
        "protections": {branch: {"strict": True, "required_review_count": 1} for branch in ("main", "dev", "uat")},
        "fault": None, "grant_reads": 0, "rollback_inventory_reads": 0, "posts": 0, "readback_failed": False,
    }
    grant_path = f"orgs/{module.ORG}/teams/pipeline-editors/repos/{module.REPO}"
    endpoint = f"repos/{module.REPO}/rulesets"

    def read(args):
        path = args[1]
        if path == "user":
            return {"login": state["actor"], "type": "User"}
        if path.startswith("users/"):
            login = path.split("/")[-1]
            return {"login": login, "type": "User", "id": owners.index(login) + 10}
        if path.endswith("/permission"):
            login = path.split("/")[-2]
            return {"permission": "admin" if login in state["admins"] else "push", "user": {"login": login}}
        if path == f"orgs/{module.ORG}/teams/pipeline-editors":
            return {"slug": "pipeline-editors", "id": 42}
        if path.endswith("/members?per_page=100"):
            return copy.deepcopy(state["members"])
        if path == f"repos/{module.REPO}/teams?per_page=100":
            state["grant_reads"] += 1
            if state["fault"] == "grant_drift" and state["grant_reads"] == 2:
                state["grant"] = "admin"
            return [] if state["grant"] is None else [{"id": 42, "slug": "pipeline-editors", "permission": state["grant"]}]
        if path == f"{endpoint}?per_page=100":
            if state["fault"] == "rollback_grant_drift" and any(item[0] == endpoint + "/10" for item in state["writes"]):
                state["rollback_inventory_reads"] += 1
                if state["rollback_inventory_reads"] == 2:
                    state["grant"] = "admin"
            return copy.deepcopy(list(state["rules"].values()))
        if path.startswith(endpoint + "/"):
            rule_id = int(path.split("/")[-1])
            if state["fault"] == "second_readback" and rule_id == 11 and not state["readback_failed"]:
                state["readback_failed"] = True
                raise RuntimeError("readback unavailable")
            return copy.deepcopy(state["rules"][rule_id])
        if path.endswith("/protection"):
            return copy.deepcopy(state["protections"][path.split("/")[-2]])
        raise AssertionError(path)

    def write(path, payload, method):
        state["writes"].append((path, copy.deepcopy(payload), method))
        if path == grant_path:
            state["grant"] = payload["permission"] if method == "PUT" else None
            if method == "PUT" and state["fault"] == "grant_lost_response":
                raise SystemExit("provider grant response lost")
        else:
            assert method == "DELETE" and path in {f"{endpoint}/{i}" for i in range(10, 16)}
            del state["rules"][int(path.split("/")[-1])]

    def create(argv, **kwargs):
        assert argv == ["gh", "api", "--method", "POST", endpoint, "--input", "-"]
        body = json.loads(kwargs["input"])
        state["writes"].append((endpoint, copy.deepcopy(body), "POST"))
        state["posts"] += 1
        rule_id = 9 + state["posts"]
        if state["fault"] == "second_rejected" and state["posts"] == 2:
            return SimpleNamespace(returncode=1, stdout="", stderr="422 rejected")
        state["rules"][rule_id] = {**body, "id": rule_id}
        if state["fault"] in {"changed_guard", "rollback_grant_drift"}:
            state["rules"][1]["peer_change"] = True
        if state["fault"] == "revoked_admin":
            state["admins"].clear()
        if state["fault"] == "lost_response" or (state["fault"] == "second_lost_response" and state["posts"] == 2):
            return SimpleNamespace(returncode=1, stdout="", stderr="provider response lost")
        if state["fault"] == "first_partition_drift" and state["posts"] == 2:
            state["rules"][10]["enforcement"] = "disabled"
        if state["fault"] == "second_malformed" and state["posts"] == 2:
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        return SimpleNamespace(returncode=0, stdout=json.dumps({"id": rule_id, "name": body["name"]}), stderr="")

    return policy, state, read, write, create



def test_native_team_transition_preserves_controls_and_refuses_foreign_authority(module):
    import copy
    import prepared_branch_governance as prepared
    from unittest.mock import patch

    previous = _policy()
    policy = copy.deepcopy(previous)
    policy["authorization"] = {"native_teams": True}
    people = sorted(module.MANAGED_TEAMS[0]["select"](previous))
    editors = previous["main"]["protected_pipeline_edit_users"]
    states, writes = {}, []
    inventory = []
    def read(args):
        path = args[1]
        if path == "user": return {"type": "User", "login": editors[0]}
        if path.endswith("/members?per_page=100"):
            return [{"type": "User", "login": login} for login in editors]
        if path.endswith("/permission"): return {"permission": "admin"}
        if path == f"orgs/{module.ORG}/teams/pipeline-editors":
            return {"id": 42, "slug": "pipeline-editors"}
        if path.startswith("users/"):
            login = path.rsplit("/", 1)[-1]
            return {"login": login, "id": people.index(login) + 10, "type": "User"}
        if path.endswith("/rulesets?per_page=100"): return copy.deepcopy(inventory)
        return copy.deepcopy(states[path])
    def install(rule):
        identifier = len(inventory) + 1
        inventory.append({"id": identifier, "name": rule["name"]})
        states[f"repos/{module.REPO}/rulesets/{identifier}"] = {**rule, "id": identifier}
    install(module.main_review_ruleset(previous, read=read))
    for branch in ("main", "dev", "uat", "uat-isolated"):
        install(module.main_owner_admin_ruleset(previous, read=read, branch=branch))
        lane = previous["main"] if branch == "main" else prepared.branch_policy(previous, branch)
        name = (previous["main"]["merge_queue_ruleset_name"] if branch == "main" else
                previous["branch_flow"]["prepared_branches"][branch]["merge_queue_ruleset_name"])
        install({"name": name, "target": "branch", "enforcement": "active",
                 "conditions": {"ref_name": {"include": [f"refs/heads/{branch}"], "exclude": []}},
                 "rules": [{"type": "merge_queue", "parameters": {"check_response_timeout_minutes": 120}}],
                 "bypass_actors": [{"actor_id": people.index(login) + 10,
                     "actor_type": "User", "bypass_mode": "pull_request"} for login in lane["merge_queue_bypass_users"]]})
        if branch != "main":
            review = prepared.protection_payload(lane)["required_pull_request_reviews"]
            review["bypass_pull_request_allowances"]["users"] = [
                {"login": login} for login in review["bypass_pull_request_allowances"]["users"]]
            review["bypass_pull_request_allowances"]["teams"] = []
            states[f"repos/{module.REPO}/branches/{branch}/protection/required_pull_request_reviews"] = review
    before = copy.deepcopy(states)
    def write(path, body, method):
        assert "memberships" not in path and method in {"PUT", "PATCH"}
        writes.append(path)
        value = copy.deepcopy(body)
        if method == "PATCH":
            value["bypass_pull_request_allowances"]["teams"] = [
                {"slug": slug} for slug in value["bypass_pull_request_allowances"]["teams"]]
        states[path] = value
    with patch.object(prepared, "_write", side_effect=write):
        assert all(row["changed"] for row in module.transition_native_teams(policy, previous, read=read))
        assert not writes
        assert len(module.transition_native_teams(policy, previous, read=read, apply=True)) == 12
        assert len(writes) == 12
        for path, old in before.items():
            if "/rulesets/" in path:
                assert all(states[path][key] == old[key] for key in ("rules", "conditions", "enforcement"))
            else:
                assert all(states[path][key] == old[key] for key in old if key != "bypass_pull_request_allowances")
        assert not any(row["changed"] for row in module.transition_native_teams(policy, previous, read=read, apply=True))
        states.clear(); states.update(copy.deepcopy(before)); writes.clear()
        target = next(path for path, row in states.items() if row.get("name") == previous["main"]["merge_queue_ruleset_name"])
        states[target]["bypass_actors"] = [{"actor_type": "RepositoryRole", "actor_id": 5, "bypass_mode": "always"}]
        try:
            module.transition_native_teams(policy, previous, read=read, apply=True)
        except SystemExit as error:
            assert "unknown queue exception" in str(error)
        else:
            raise AssertionError("Foreign native authority was replaced")
        assert not writes


def test_team_native_authority_has_no_personal_bypass_or_strict_guard_exception(module):
    policy, state, read, _, _ = _native_review_fixture(module)
    policy["authorization"] = {"native_teams": True}
    expected = [{"actor_id": 42, "actor_type": "Team", "bypass_mode": "pull_request"}]
    assert module.main_review_ruleset(policy, read=read)["bypass_actors"] == expected
    for branch in ("main", "dev", "uat", "uat-isolated"):
        assert module.main_owner_admin_ruleset(policy, read=read, branch=branch)["bypass_actors"] == []
    for rule in module.protected_pipeline_review_rulesets(policy, read=read):
        assert rule["bypass_actors"] == expected
    from prepared_branch_governance import branch_policy, protection_payload
    payload = protection_payload(branch_policy(policy, "dev"))
    assert payload["required_pull_request_reviews"]["bypass_pull_request_allowances"] == {
        "users": [], "teams": ["pipeline-editors"], "apps": []}

    # Team membership grants review authority, not repository administration.
    # Read-only verification must work when editors have ordinary write access.
    state["admins"].clear()
    state["grant"] = "push"
    for index, rule in enumerate(module.protected_pipeline_review_rulesets(policy, read=read), 10):
        state["rules"][index] = {**rule, "id": index}
    assert not module.reconcile_protected_pipeline_review(policy, verify_only=True, read=read)
    for fault in ("members", "grant"):
        saved_members, saved_grant = state["members"], state["grant"]
        if fault == "members":
            state["members"] = []
        else:
            state["grant"] = "pull"
        try:
            module.reconcile_protected_pipeline_review(policy, verify_only=True, read=read)
        except SystemExit:
            pass
        else:
            raise AssertionError(f"Unverified reviewer authority accepted: {fault}")
        state["members"], state["grant"] = saved_members, saved_grant
    try:
        module.reconcile_protected_pipeline_review(policy, apply=True, read=read)
    except SystemExit as error:
        assert "repository admin" in str(error)
    else:
        raise AssertionError("A non-admin editor was allowed to mutate repository settings")
    assert not state["writes"]


def test_native_review_patterns_and_owner_bypass_are_exact(module) -> None:
    import os
    import subprocess
    import tempfile

    policy, _, read, _, _ = _native_review_fixture(module)
    desired_rules = module.protected_pipeline_review_rulesets(policy, read=read)
    desired = desired_rules[0]
    assert [item["name"] for item in desired_rules] == ["protected pipeline review 1", "protected pipeline review 2", "protected pipeline review 3", "protected pipeline review inherited 1", "protected pipeline review inherited 2", "protected pipeline review inherited 3"]
    assert [len(item["rules"][0]["parameters"]["required_reviewers"][0]["file_patterns"]) for item in desired_rules] == [15, 15, len(policy["main"]["protected_pipeline_paths"]) - 30] * 2
    patterns = [pattern for item in desired_rules[:2] for pattern in item["rules"][0]["parameters"]["required_reviewers"][0]["file_patterns"]]
    assert patterns == sorted({"/" + path + ("**" if path.endswith("/") else "") for path in policy["main"]["protected_pipeline_paths"][:30]})
    assert len(patterns) == len(set(patterns)) == 30
    supplemental = desired_rules[2]["rules"][0]["parameters"]["required_reviewers"][0]["file_patterns"]
    assert set(supplemental) == {"/" + path + ("**" if path.endswith("/") else "") for path in policy["main"]["protected_pipeline_paths"][30:]}
    assert [pattern for item in desired_rules[3:5] for pattern in item["rules"][0]["parameters"]["required_reviewers"][0]["file_patterns"]] == patterns
    assert desired_rules[5]["rules"][0]["parameters"]["required_reviewers"][0]["file_patterns"] == supplemental
    assert desired_rules[3]["conditions"]["ref_name"]["include"] == ["refs/heads/integration/pr-train", "refs/heads/uat-isolated"]
    assert desired["conditions"]["ref_name"]["include"] == ["refs/heads/main", "refs/heads/dev", "refs/heads/uat"]
    assert desired["bypass_actors"] == [
        {"actor_id": 42, "actor_type": "Team", "bypass_mode": "pull_request"}
    ]
    rule = desired["rules"][0]["parameters"]
    assert rule["dismiss_stale_reviews_on_push"] is True
    assert rule["required_approving_review_count"] == 0 and rule["require_code_owner_review"] is False
    reviewer = rule["required_reviewers"][0]
    assert reviewer["minimum_approvals"] == 1 and reviewer["reviewer"] == {"id": 42, "type": "Team"}
    positive = [".github/workflows/check.yml", ".github/workflows/nested/check.yml", "scripts/ci/guard.py", "scripts/ci/nested/guard.py", "AGENTS.md", ".agents/config.toml", ".agents/config.json"]
    negative = [".GITHUB/workflows/check.yml", "scripts/CI/guard.py", "unrelated/scripts/ci/guard.py", "agents.md", "hushh-webapp/app/page.tsx"]
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    with tempfile.TemporaryDirectory(prefix="native-review-patterns-") as scratch:
        subprocess.run(["git", "init", "-q", scratch], check=True, env=env)
        subprocess.run(["git", "config", "core.ignorecase", "false"], cwd=scratch, env=env, check=True)
        Path(scratch, ".gitignore").write_text("\n".join(patterns + supplemental) + "\n", encoding="utf-8")
        matches = subprocess.run(["git", "check-ignore", "--no-index", "--stdin"],
                                 input="\n".join(positive + negative) + "\n", capture_output=True,
                                 text=True, cwd=scratch, env=env, check=True)
        assert matches.stdout.splitlines() == positive


def test_native_review_stage_a_is_additive_idempotent_and_recovers_own_changes(module) -> None:
    from unittest.mock import patch
    import prepared_branch_governance

    for fault in (None, "changed_guard", "revoked_admin", "lost_response", "grant_lost_response"):
        policy, state, read, write, create = _native_review_fixture(module)
        state["fault"] = fault
        with patch.object(prepared_branch_governance, "_write", side_effect=write), \
             patch.object(module.subprocess, "run", side_effect=create):
            assert module.reconcile_protected_pipeline_review(policy, apply=False, read=read)
            assert state["writes"] == [] and state["grant"] is None and set(state["rules"]) == {1}
            if fault is None:
                assert module.reconcile_protected_pipeline_review(policy, apply=True, read=read)
                assert state["grant"] == "push" and set(state["rules"]) == {1, 10, 11, 12, 13, 14, 15}
                before = list(state["writes"])
                assert not module.reconcile_protected_pipeline_review(policy, apply=True, read=read)
                assert state["writes"] == before
            else:
                try:
                    module.reconcile_protected_pipeline_review(policy, apply=True, read=read)
                except SystemExit as error:
                    assert "Stage A failed" in str(error)
                    if fault in {"changed_guard", "revoked_admin"}:
                        assert state["grant"] is None and set(state["rules"]) == {1}
                        if fault == "changed_guard":
                            assert state["rules"][1]["peer_change"] is True
                    elif fault == "lost_response":
                        assert "uncertain" in str(error) and state["grant"] == "push"
                        assert set(state["rules"]) == {1, 10}
                        before = list(state["writes"])
                        state["fault"] = None
                        assert module.reconcile_protected_pipeline_review(policy, apply=True, read=read)
                        assert len(state["writes"]) == len(before) + 5
                        assert set(state["rules"]) == {1, 10, 11, 12, 13, 14, 15}
                    else:
                        assert "uncertain" in str(error) and state["grant"] == "push"
                        assert set(state["rules"]) == {1}
                        state["fault"] = None
                        assert module.reconcile_protected_pipeline_review(policy, apply=True, read=read)
                        assert set(state["rules"]) == {1, 10, 11, 12, 13, 14, 15}
                else:
                    raise AssertionError(f"Native review accepted failed provider/readback outcome: {fault}")
            assert all(value == {"strict": True, "required_review_count": 1} for value in state["protections"].values())


def test_native_review_refuses_authority_drift_before_writes(module) -> None:
    from unittest.mock import patch
    import prepared_branch_governance

    for change in ("member", "actor", "admin", "wildcard", "authority_path", "wrong_rule", "wrong_partition", "duplicate_path"):
        policy, state, read, _, _ = _native_review_fixture(module)
        if change == "member":
            state["members"].append({"login": "ordinary-maintainer", "type": "User"})
        elif change == "actor":
            state["actor"] = "ordinary-maintainer"
        elif change == "admin":
            state["admins"].clear()
        elif change == "wildcard":
            policy["main"]["protected_pipeline_paths"].append("!scripts/ci/**")
        elif change == "authority_path":
            policy["main"]["protected_pipeline_paths"].remove(".github/workflows/")
        elif change == "duplicate_path":
            policy["main"]["protected_pipeline_paths"].append("scripts/ci/")
        else:
            name = policy["branch_flow"]["protected_pipeline_review_ruleset_name"]
            state["rules"][2] = {"id": 2, "name": name + (" 2" if change == "wrong_partition" else ""), "target": "branch", "rules": []}
        with patch.object(prepared_branch_governance, "_write") as write, patch.object(module.subprocess, "run") as create:
            try:
                module.reconcile_protected_pipeline_review(policy, apply=True, read=read)
            except SystemExit:
                pass
            else:
                raise AssertionError(f"Native review accepted unproven authority: {change}")
            write.assert_not_called()
            create.assert_not_called()


def test_native_review_preserves_peer_grant_changes_before_write_and_rollback(module) -> None:
    from unittest.mock import patch
    import prepared_branch_governance

    for fault in ("grant_drift", "rollback_grant_drift"):
        policy, state, read, write, create = _native_review_fixture(module)
        state["fault"] = fault
        with patch.object(prepared_branch_governance, "_write", side_effect=write), \
             patch.object(module.subprocess, "run", side_effect=create):
            try:
                module.reconcile_protected_pipeline_review(policy, apply=True, read=read)
            except SystemExit as error:
                assert "concurrent permission retained" in str(error)
            else:
                raise AssertionError(f"Native review overwrote a concurrent grant: {fault}")
        assert state["grant"] == "admin" and set(state["rules"]) == {1}
        grant_writes = [item for item in state["writes"] if "/teams/pipeline-editors/repos/" in item[0]]
        if fault == "grant_drift":
            assert grant_writes == []
        else:
            assert len(grant_writes) == 1 and grant_writes[0][2] == "PUT"


def test_native_review_partition_failure_resumes_without_duplicate_or_foreign_rollback(module) -> None:
    from unittest.mock import patch
    import prepared_branch_governance

    for fault in ("second_rejected", "second_lost_response", "second_malformed", "second_readback"):
        policy, state, read, write, create = _native_review_fixture(module)
        state["grant"] = "push"  # retained grant from the prior rejected Stage A apply
        state["fault"] = fault
        with patch.object(prepared_branch_governance, "_write", side_effect=write), \
             patch.object(module.subprocess, "run", side_effect=create):
            try:
                module.reconcile_protected_pipeline_review(policy, apply=True, read=read)
            except SystemExit as error:
                assert "Stage A failed" in str(error)
            else:
                raise AssertionError(f"Accepted failed partition: {fault}")
            assert state["grant"] == "push"
            assert not any("/teams/pipeline-editors/repos/" in row[0] for row in state["writes"])
            if fault == "second_readback":
                assert set(state["rules"]) == {1}  # only this invocation's two creations removed
            else:
                assert 10 in state["rules"]  # uncertain creation retains known first partition
            state["fault"] = None
            # IDs may advance after a rollback; preserve uniqueness in the fake provider.
            state["posts"] = max(state["rules"]) - 9 if len(state["rules"]) > 1 else 0
            missing_before = len(state["rules"]) < 7
            assert module.reconcile_protected_pipeline_review(policy, apply=True, read=read) == missing_before
            assert len(state["rules"]) == 7
            before = list(state["writes"])
            assert not module.reconcile_protected_pipeline_review(policy, apply=True, read=read)
            assert state["writes"] == before


def test_native_review_rechecks_both_partitions_and_preserves_changed_rule(module) -> None:
    from unittest.mock import patch
    import prepared_branch_governance

    policy, state, read, write, create = _native_review_fixture(module)
    state["grant"] = "push"
    state["fault"] = "first_partition_drift"
    with patch.object(prepared_branch_governance, "_write", side_effect=write), \
         patch.object(module.subprocess, "run", side_effect=create):
        try:
            module.reconcile_protected_pipeline_review(policy, apply=True, read=read)
        except SystemExit as error:
            assert "pair changed" in str(error) and "refusing to delete" in str(error)
        else:
            raise AssertionError("Partition one drift during second creation was accepted")
    assert state["grant"] == "push" and set(state["rules"]) == {1, 10}
    assert state["rules"][10]["enforcement"] == "disabled"


def test_native_review_partial_resume_rolls_back_only_new_partition(module) -> None:
    from unittest.mock import patch
    import prepared_branch_governance

    policy, state, read, write, create = _native_review_fixture(module)
    desired = module.protected_pipeline_review_rulesets(policy, read=read)
    state["rules"][10] = {**desired[0], "id": 10}
    state["posts"] = 1
    state["grant"] = "push"
    state["fault"] = "second_readback"
    with patch.object(prepared_branch_governance, "_write", side_effect=write), \
         patch.object(module.subprocess, "run", side_effect=create):
        try:
            module.reconcile_protected_pipeline_review(policy, apply=True, read=read)
        except SystemExit as error:
            assert "task-owned changes restored" in str(error)
        else:
            raise AssertionError("Failed partial resume was accepted")
    assert state["grant"] == "push" and set(state["rules"]) == {1, 10}
    assert module.same_review_ruleset(state["rules"][10], desired[0])
    deletes = [path for path, _, method in state["writes"] if method == "DELETE"]
    assert deletes == [f"repos/{module.REPO}/rulesets/11"]


def test_prepared_native_review_orders_guards_and_preserves_peer_changes(module) -> None:
    import base64
    import copy
    import prepared_branch_governance as prepared
    from unittest.mock import patch

    for branch in ("dev", "uat", "uat-isolated"):
        for fault in (None, "reordered", "duplicate_actor", "bad_actor_mode", "missing_native", "changed_queue", "changed_protection", "bad_guard", "unknown_bypass", "stale_authority", "main_advanced"):
            policy, state, base_read, _, _ = _native_review_fixture(module)
            state["grant"] = "push"
            owners = policy["main"]["protected_pipeline_edit_users"]
            source_key = policy["branch_flow"]["prepared_branches"][branch]["policy_key"]
            cohort = policy[source_key]["review_bypass_users"]
            for i, desired in enumerate(module.protected_pipeline_review_rulesets(policy, read=base_read)):
                state["rules"][10 + i] = {**desired, "id": 10 + i}
            if fault == "missing_native":
                del state["rules"][13]
            template_name = policy[source_key]["merge_queue_ruleset_name"]
            state["rules"][2] = {"id": 2, "name": template_name, "target": "branch", "enforcement": "active",
                "rules": [{"type": "merge_queue", "parameters": {"merge_method": "MERGE"}}]}
            state["rules"][20] = {"id": 20, "name": f"{branch} merge queue", "target": "branch", "enforcement": "active",
                "conditions": {"ref_name": {"include": [f"refs/heads/{branch}"], "exclude": []}},
                "bypass_actors": [{"actor_id": 60, "actor_type": "Team", "bypass_mode": "pull_request"}],
                "rules": copy.deepcopy(state["rules"][2]["rules"])}
            if fault == "unknown_bypass":
                state["rules"][20]["bypass_actors"] = [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}]

            def observed(payload):
                value = copy.deepcopy(payload)
                for key in ("enforce_admins", "required_linear_history", "allow_force_pushes", "allow_deletions", "required_conversation_resolution"):
                    value[key] = {"enabled": value[key]}
                bypass = value["required_pull_request_reviews"]["bypass_pull_request_allowances"]
                bypass["users"] = [{"login": login} for login in bypass["users"]]
                bypass["teams"] = [{"slug": slug} for slug in bypass["teams"]]
                return value

            current = observed(prepared.protection_payload(policy[source_key]))
            current["required_status_checks"]["strict"] = True
            state["protections"][branch] = current
            baseline = copy.deepcopy(current)
            guard_created = False

            def read(args):
                path = args[1]
                if path.startswith("users/"):
                    login = path.split("/")[-1]
                    return {"id": owners.index(login) + 10 if login in owners else cohort.index(login) + 100,
                            "login": login, "type": "User"}
                if path.endswith("teams/allowed-maintainers-to-approve"):
                    return {"id": 60}
                if "/git/ref/heads/" in path:
                    main_ref = path.endswith("/main")
                    sha = ("c" if fault == "main_advanced" and guard_created else "a") if main_ref else "b"
                    return {"object": {"type": "commit", "sha": sha * 40}}
                if "/contents/" in path:
                    filename = path.split("/contents/", 1)[1].split("?ref=", 1)[0]
                    if branch == "uat-isolated":
                        assert filename == "config/ci-governance.json" and not path.endswith("b" * 40)
                        document = {} if fault == "stale_authority" else policy
                        return {"path": filename, "encoding": "base64",
                                "content": base64.b64encode(json.dumps(document).encode()).decode()}
                    stale = fault == "stale_authority" and path.endswith("b" * 40)
                    return {"path": filename, "type": "file", "sha": ("e" if stale else "d") * 40}
                return base_read(args)

            def raw(args, *, check):
                assert not check
                return 0, json.dumps(state["protections"][branch]), ""

            def write(path, payload, method):
                nonlocal guard_created
                state["writes"].append((path, copy.deepcopy(payload), method))
                if path.endswith("/rulesets"):
                    guard_created = True
                    state["rules"][30] = {**copy.deepcopy(payload), "id": 30}
                    if fault == "bad_guard":
                        state["rules"][30]["enforcement"] = "disabled"
                    if fault == "changed_queue":
                        state["rules"][20]["peer_change"] = True
                    if fault == "changed_protection":
                        state["protections"][branch]["peer_change"] = True
                elif path.endswith("/rulesets/20"):
                    assert guard_created and state["rules"][30]["enforcement"] == "active"
                    state["rules"][20] = {**copy.deepcopy(payload), "id": 20}
                    if fault == "reordered":
                        state["rules"][20]["bypass_actors"].reverse()
                    if fault == "duplicate_actor":
                        state["rules"][20]["bypass_actors"].append(copy.deepcopy(payload["bypass_actors"][0]))
                    if fault == "bad_actor_mode":
                        state["rules"][20]["bypass_actors"][0]["bypass_mode"] = "always"
                elif path.endswith(f"/branches/{branch}/protection"):
                    assert guard_created
                    assert all(actor["actor_type"] == "User" for actor in state["rules"][20]["bypass_actors"])
                    assert {actor["actor_id"] for actor in state["rules"][20]["bypass_actors"]} == {10 + index for index in range(len(owners))}
                    state["protections"][branch] = observed(payload)
                else:
                    raise AssertionError(path)

            with patch.object(prepared, "_write", side_effect=write):
                prepared.reconcile(policy, [branch], repo=module.REPO, read=read, raw=raw, apply=False, governance=module) if fault not in {"missing_native", "unknown_bypass", "stale_authority"} else None
                assert state["writes"] == []
                if fault in (None, "reordered"):
                    prepared.reconcile(policy, [branch], repo=module.REPO, read=read, raw=raw, apply=True, governance=module)
                    assert prepared._same_protection(state["protections"][branch], prepared.protection_payload(prepared.branch_policy(policy, branch)))
                    if branch == "uat-isolated":
                        final = state["protections"][branch]
                        assert final["required_status_checks"] == baseline["required_status_checks"]
                        for key in ("required_approving_review_count", "require_code_owner_reviews", "require_last_push_approval"):
                            assert final["required_pull_request_reviews"][key] == baseline["required_pull_request_reviews"][key]
                    assert [method for _, _, method in state["writes"]] == ["POST", "PUT", "PUT"]
                    if fault == "reordered":
                        state["writes"].clear()
                        prepared.reconcile(policy, [branch], repo=module.REPO, read=read, raw=raw, apply=True, governance=module)
                        assert state["writes"] == []
                else:
                    try:
                        prepared.reconcile(policy, [branch], repo=module.REPO, read=read, raw=raw, apply=True, governance=module)
                    except SystemExit:
                        pass
                    else:
                        raise AssertionError(f"Prepared native review accepted {fault}")
                    assert not any(path.endswith(f"/branches/{branch}/protection") for path, _, _ in state["writes"])
                    assert state["protections"][branch]["required_status_checks"] == baseline["required_status_checks"]



def test_prepared_native_live_verifier_requires_every_independent_boundary(module) -> None:
    import copy
    import os
    import subprocess
    import tempfile
    import prepared_branch_governance as prepared

    for branch in ("dev", "uat", "uat-isolated"):
        policy, _, _, _, _ = _native_review_fixture(module)
        owners = policy["main"]["protected_pipeline_edit_users"]
        cohort = policy["pr_train"]["review_bypass_users"]
        responses = {"user": {"login": owners[0], "type": "User"},
            f"orgs/{module.ORG}/teams/pipeline-editors": {"id": 42, "slug": "pipeline-editors"},
            f"orgs/{module.ORG}/teams/pipeline-editors/members?per_page=100": [{"login": owner, "type": "User"} for owner in owners],
            f"repos/{module.REPO}/teams?per_page=100": [{"id": 42, "slug": "pipeline-editors", "permission": "push"}],
            f"repos/{module.REPO}": {"allow_auto_merge": True}}
        for login in cohort:
            responses[f"users/{login}"] = {"id": owners.index(login) + 10 if login in owners else cohort.index(login) + 100,
                                          "login": login, "type": "User"}
        for owner in owners:
            responses[f"repos/{module.REPO}/collaborators/{owner}/permission"] = {"permission": "admin", "user": {"login": owner}}
        def read(args):
            return responses[args[1]]
        rules = [{**rule, "id": 10 + i} for i, rule in enumerate(module.protected_pipeline_review_rulesets(policy, read=read))]
        rules.append({**module.main_owner_admin_ruleset(policy, branch=branch, read=read), "id": 30})
        rules.append({"id": 20, "name": f"{branch} merge queue", "target": "branch", "enforcement": "active",
            "conditions": {"ref_name": {"include": [f"refs/heads/{branch}"], "exclude": []}},
            "bypass_actors": [{"actor_id": owners.index(owner) + 10, "actor_type": "User", "bypass_mode": "pull_request"} for owner in sorted(owners)],
            "rules": [{"type": "merge_queue", "parameters": {"merge_method": "MERGE"}}]})
        for rule in rules:
            responses[f"repos/{module.REPO}/rulesets/{rule['id']}"] = rule
        responses[f"repos/{module.REPO}/rulesets?per_page=100"] = rules
        responses[f"repos/{module.REPO}/rulesets?includes_parents=true"] = rules
        responses[f"repos/{module.REPO}/rules/branches/{branch}"] = rules[-1]["rules"]
        protection = prepared.protection_payload(prepared.branch_policy(policy, branch))
        for key in ("enforce_admins", "required_linear_history", "allow_force_pushes", "allow_deletions", "required_conversation_resolution"):
            protection[key] = {"enabled": protection[key]}
        protection["required_pull_request_reviews"]["bypass_pull_request_allowances"]["users"] = [{"login": owner} for owner in sorted(owners)]
        for target in ("main", "dev", "uat", "uat-isolated"):
            responses[f"repos/{module.REPO}/branches/{target}/protection"] = copy.deepcopy(protection)
        for target, revision in (("main", "a" * 40), (branch, "b" * 40)):
            responses[f"repos/{module.REPO}/git/ref/heads/{target}"] = {"object": {"type": "commit", "sha": revision}}
            for path in prepared.STAGE_B_AUTHORITY_PATHS:
                responses[f"repos/{module.REPO}/contents/{path}?ref={revision}"] = {"path": path, "type": "file", "sha": "d" * 40}
        with tempfile.TemporaryDirectory(prefix="prepared-native-verifier-") as scratch:
            directory = Path(scratch)
            _write_github_fixture(directory)
            policy_file = directory / "policy.json"
            policy_file.write_text(json.dumps(policy))
            environment = dict(os.environ, PATH=str(directory) + os.pathsep + os.environ["PATH"],
                GITHUB_BRANCH=branch, GITHUB_REPO=module.REPO, GITHUB_CI_GOVERNANCE_FILE=str(policy_file))
            faults = [None, "missing_native", "guard_disabled", "unknown_actor", "blanket_review"]
            faults += ["wrong_ci_app", "app_review_bypass"] if branch == "uat-isolated" else ["stale_authority"]
            for fault in faults:
                sample = copy.deepcopy(responses)
                if fault == "missing_native":
                    sample[f"repos/{module.REPO}/rulesets?per_page=100"] = [rule for rule in sample[f"repos/{module.REPO}/rulesets?per_page=100"] if rule["id"] != 13]
                elif fault == "guard_disabled":
                    sample[f"repos/{module.REPO}/rulesets/30"]["enforcement"] = "disabled"
                elif fault == "unknown_actor":
                    sample[f"repos/{module.REPO}/rulesets/20"]["bypass_actors"].append({"actor_id": 1, "actor_type": "RepositoryRole", "bypass_mode": "always"})
                elif fault == "stale_authority":
                    sample[f"repos/{module.REPO}/contents/scripts/ci/queue_combined_result.py?ref={"b" * 40}"]["sha"] = "e" * 40
                    # Source equality still gates review-policy activation, not
                    # an already-protected branch's authority-sync PR.
                    try:
                        prepared.verify_destination_authority(branch, repo=module.REPO,
                                                              read=lambda args: sample[args[1]])
                    except SystemExit as error:
                        assert "source-sync before Stage B" in str(error)
                    else:
                        raise AssertionError("Stale authority permitted review activation")
                elif fault == "blanket_review":
                    sample[f"repos/{module.REPO}/branches/{branch}/protection"]["required_pull_request_reviews"]["require_code_owner_reviews"] = branch != "uat-isolated"
                elif fault == "wrong_ci_app":
                    sample[f"repos/{module.REPO}/branches/{branch}/protection"]["required_status_checks"]["checks"][0]["app_id"] = 999
                elif fault == "app_review_bypass":
                    sample[f"repos/{module.REPO}/branches/{branch}/protection"]["required_pull_request_reviews"]["bypass_pull_request_allowances"]["apps"] = [{"slug": "synthetic"}]
                environment["SYNTHETIC_GITHUB_RESPONSES"] = json.dumps(sample)
                result = subprocess.run(["bash", str(Path(__file__).parent / "verify-main-branch-protection.sh")],
                                        env=environment, text=True, capture_output=True, timeout=60)
                assert (result.returncode == 0) == (fault in (None, "stale_authority")), (branch, fault, result.stdout, result.stderr)



if __name__ == "__main__":
    raise SystemExit(main())

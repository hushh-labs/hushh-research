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


def _policy() -> dict:
    return json.loads((REPO_ROOT / "config" / "ci-governance.json").read_text())


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


def test_members_are_mirrored_at_the_member_role(module) -> None:
    """role=maintainer would let any member grant the team's capability onward.

    allowed-maintainers-to-approve sits in main's branch-protection bypass_teams,
    and a GitHub team maintainer can add members to their own team. At that role
    any member could hand a newcomer review bypass on main with no PR, no review
    and no trace here, bypassing protected_pipeline_edit_users entirely.
    """
    assert module.TEAM_MEMBER_ROLE == "member"


def test_the_maintainer_set_is_the_union_of_both_governed_branches(module) -> None:
    policy = _policy()
    maintainers = set(module.MANAGED_TEAMS[0]["select"](policy))
    for key in ("main", "pr_train"):
        assert set(policy[key]["review_bypass_users"]) <= maintainers
        assert set(policy[key]["merge_queue_bypass_users"]) <= maintainers


def test_org_owners_are_never_demoted(module) -> None:
    """An org owner must not appear in the demotion set, or the sync never converges.

    GitHub reports an organization owner as a maintainer of every team they are in
    and refuses to demote them there. Attempting it anyway made apply-governance
    print a demotion plan on every run forever -- a governance tool that always
    claims drift is one people learn to scroll past, which is precisely how the
    UAT cohort stayed wrong in the advisory lane. Excluding owners costs nothing:
    they can edit branch protection and team membership directly regardless.
    """
    calls = {"role_lookups": []}

    def fake_gh(args, check=True):  # team_exists -> exists
        return 0, "", ""

    def fake_gh_json(args):
        joined = " ".join(args)
        # Order matters: "/members" is a substring of "/memberships/".
        if "/memberships/" in joined:
            login = joined.rsplit("/", 1)[-1]
            calls["role_lookups"].append(login)
            return {"role": "maintainer"}
        if "/members" in joined:
            return [{"login": "owner-person"}, {"login": "regular-person"}]
        return []

    original = (module.gh, module.gh_json, module.organization_owners)
    try:
        module.gh, module.gh_json = fake_gh, fake_gh_json
        module.organization_owners = lambda: {"owner-person"}
        changed = module.apply_team_membership(
            "some-team", ["owner-person", "regular-person"], apply=False
        )
    finally:
        module.gh, module.gh_json, module.organization_owners = original

    assert "owner-person" not in calls["role_lookups"], (
        "an org owner's team role was inspected for demotion; GitHub will never "
        "let it change, so the sync would report drift on every run"
    )
    assert "regular-person" in calls["role_lookups"], (
        "a non-owner at role=maintainer must still be demoted -- that is the "
        "grant path this closes"
    )
    assert changed is True


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
             "rules": [{"type": "merge_queue"}],
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


def test_prepared_rollout_rejects_bypass_with_non_strict_checks(module) -> None:
    import prepared_branch_governance
    from unittest.mock import patch

    policy = _policy()
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
        "rules": [{"type": "merge_queue"}],
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

if __name__ == "__main__":
    raise SystemExit(main())

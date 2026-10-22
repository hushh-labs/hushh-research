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


def test_live_verifier_distinguishes_pending_activation_without_granting_authority(module) -> None:
    """Exercise the real verifier; pending never conceals protection/actor drift."""
    import copy
    import os
    import subprocess
    import tempfile

    policy = _policy()
    policy["main"] = {
        **policy["main"],
        "review_bypass_users": ["operator", "invitee"],
        "merge_queue_bypass_users": ["operator", "invitee"],
        "review_bypass_team_slug": "maintainers",
        "merge_queue_bypass_team_slug": "maintainers",
        "merge_queue_bypass_team_name": "Maintainers",
        "merge_queue_ruleset_name": "Queue",
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


def main() -> int:
    module = _module()
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for test in tests:
        test(module)
        print(f"  ok  {test.__name__}")
    print(f"apply-governance managed-team checks passed ({len(tests)} tests).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

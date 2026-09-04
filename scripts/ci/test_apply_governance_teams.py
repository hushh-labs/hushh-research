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
The GitHub calls are exercised by the script's own dry-run, not from here.
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

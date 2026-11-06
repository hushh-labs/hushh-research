#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Unit checks for scripts/ci/verify-deployment-environment-governance.py.

Written in the repo's self-running CI-test style (an explicit `main()` plus
`if __name__ == "__main__"`), matching test_resolve_deploy_scope.py and friends.

This file previously used pytest's `monkeypatch` fixture and was invoked as
`python3 <file>`, which merely defined the test functions and exited 0 without
running any of them. It was also absent from scripts/ci/repo-governance-check.sh.
So it was dead: it reported success while asserting nothing, which is how the
production-cohort tripwire below drifted twice without anyone noticing.
"""

# ruff: noqa: S101

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import traceback
import sys
import textwrap
from pathlib import Path


def _module():
    path = Path(__file__).with_name("verify-deployment-environment-governance.py")
    spec = importlib.util.spec_from_file_location(
        "verify_deployment_environment_governance",
        path,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _policy(module) -> dict:
    # Derive the production cohort from the module constant rather than repeating
    # it: this fixture used to hardcode a copy, so updating the real tripwire would
    # have broken these tests for the wrong reason. Drift between the constant and
    # the committed JSON is asserted by
    # test_production_tripwire_matches_committed_policy.
    return {
        "main": {
            "review_bypass_users": ["maintainer"],
        },
        "uat": {
            "environment": "uat",
            "manual_dispatch_users": ["maintainer"],
            "required_environment_variables": [
                "GCP_WORKLOAD_IDENTITY_PROVIDER",
                "GCP_DEPLOY_SERVICE_ACCOUNT",
            ],
        },
        "production": {
            "owner_environment": "production",
            "manual_dispatch_users": list(module.PRODUCTION_MANUAL_DISPATCH_USERS),
            "required_environment_variables": [
                "GCP_WORKLOAD_IDENTITY_PROVIDER",
                "GCP_DEPLOY_SERVICE_ACCOUNT",
            ],
        },
    }


def _environment_payload() -> dict:
    return {
        "can_admins_bypass": False,
        "deployment_branch_policy": {
            "protected_branches": True,
            "custom_branch_policies": False,
        },
        "protection_rules": [],
    }


def _stub_gh_json(module, *, variables: list[str]) -> None:
    """Point the module's GitHub reader at a fixture instead of the live API.

    Each test loads its own module instance, so this needs no teardown.
    """

    def fake_gh_json(path: str) -> dict:
        if "/variables?per_page=100" in path:
            return {"total_count": len(variables), "variables": [{"name": name} for name in variables]}
        return _environment_payload()

    module._gh_json = fake_gh_json


def test_dev_exact_branch_inventory_refuses_wildcards_and_incomplete_reads() -> None:
    module = _module()
    policy = _policy(module)
    policy["dev"] = {**policy["uat"], "environment": "dev", "deployment_branches": ["dev", "main", "integration/pr-train"]}
    rows = [{"type": "branch", "name": name} for name in policy["dev"]["deployment_branches"]]
    inventory = {"total_count": len(rows), "branch_policies": rows}
    def read(path):
        if "deployment-branch-policies" in path:
            return inventory
        if "/variables?per_page=100" in path:
            names = policy["dev"]["required_environment_variables"]
            return {"total_count": len(names), "variables": [{"name": name} for name in names]}
        return {**_environment_payload(), "deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True}}
    module._gh_json = read
    assert module._assert_surface("dev", "owner/repo", policy) == []
    inventory["total_count"] += 1
    assert any("incomplete" in error for error in module._assert_surface("dev", "owner/repo", policy))
    inventory["total_count"] -= 1
    rows[0]["name"] = "*"
    assert any("exactly" in error for error in module._assert_surface("dev", "owner/repo", policy))


def test_required_environment_variables_are_enforced() -> None:
    module = _module()
    _stub_gh_json(
        module,
        variables=["GCP_WORKLOAD_IDENTITY_PROVIDER", "GCP_DEPLOY_SERVICE_ACCOUNT"],
    )

    assert module._assert_surface("production", "owner/repo", _policy(module)) == []
    original_reader = module._gh_json
    def paginated(path):
        if "/variables?" in path:
            names = ["GCP_DEPLOY_SERVICE_ACCOUNT"] if "page=2" in path else ["GCP_WORKLOAD_IDENTITY_PROVIDER"]
            return {"total_count": 2, "variables": [{"name": name} for name in names]}
        return original_reader(path)
    module._gh_json = paginated
    assert module._assert_surface("production", "owner/repo", _policy(module)) == []
    module._gh_json = original_reader
    reader = module._gh_json
    module._gh_json = lambda path: ({**reader(path), "total_count": 31}
                                  if "/variables?" in path else reader(path))
    assert module._assert_surface("production", "owner/repo", _policy(module)) == [
        "production environment variable inventory is incomplete"
    ]


def test_missing_environment_variable_fails_verification() -> None:
    module = _module()
    _stub_gh_json(module, variables=["GCP_WORKLOAD_IDENTITY_PROVIDER"])

    errors = module._assert_surface("production", "owner/repo", _policy(module))

    assert errors == [
        "production is missing required environment variables: "
        "['GCP_DEPLOY_SERVICE_ACCOUNT']"
    ]


def test_production_cohort_drift_is_reported() -> None:
    """The tripwire must fire when the JSON widens past the constant.

    This is the regression that went unnoticed twice: production dispatch
    authority was widened in config/ci-governance.json without mirroring the
    change into the constant, and nothing failed loudly enough to be acted on.
    """
    module = _module()
    _stub_gh_json(
        module,
        variables=["GCP_WORKLOAD_IDENTITY_PROVIDER", "GCP_DEPLOY_SERVICE_ACCOUNT"],
    )

    policy = _policy(module)
    policy["production"]["manual_dispatch_users"] = [
        *module.PRODUCTION_MANUAL_DISPATCH_USERS,
        "unauthorized-newcomer",
    ]

    errors = module._assert_surface("production", "owner/repo", policy)

    assert len(errors) == 1, errors
    assert "production manual dispatch policy drifted" in errors[0]
    assert "unauthorized-newcomer" in errors[0]


def test_a_trusted_readiness_exam_environment_must_admit_only_main() -> None:
    """A loosened or recreated exam environment would hand the probe subject to any branch."""
    module = _module()
    policy = {"readiness_exam": {"environment": "readiness-exam"}}
    trusted = {"azure-trial": {"readiness_exam_client_id": "probe-app"}}
    main_only = {"branch_policies": [{"type": "branch", "name": "main"}]}

    def stub(environment: dict, branches: dict, secrets: int = 0) -> list[str]:
        def fake_gh_json(path: str) -> dict:
            if path.endswith("/deployment-branch-policies"):
                return branches
            if path.endswith("/secrets"):
                return {"total_count": secrets}
            return environment

        module._gh_json = fake_gh_json
        return module._assert_readiness_exam("owner/repo", policy, trusted)

    custom = {
        "deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True}
    }
    assert stub(custom, main_only) == []
    widened = {"branch_policies": [*main_only["branch_policies"], {"type": "branch", "name": "*"}]}
    assert "must admit exactly the main branch" in stub(custom, widened)[0]
    # GitHub recreates a deleted environment with no deployment branch policy.
    assert "must admit exactly the main branch" in stub({"deployment_branch_policy": None}, {})[0]
    assert "must hold no secrets" in stub(custom, main_only, secrets=1)[0]

    def unreachable(path: str) -> dict:
        raise AssertionError(f"no probe identity, yet {path} was read")

    module._gh_json = unreachable
    assert module._assert_readiness_exam(
        "owner/repo", policy, {"azure-trial": {"readiness_exam_client_id": None}}
    ) == []


def test_production_tripwire_matches_committed_policy() -> None:
    """The constant must equal the live committed policy.

    Fails the moment someone edits production.manual_dispatch_users in
    config/ci-governance.json without mirroring it into the tripwire — exactly
    how this drifted on 2026-08-07 and again on 2026-08-28. Unlike
    _assert_surface, this needs no GitHub API access, so it runs in the ordinary
    blocking Governance gate rather than only in the advisory stage.
    """
    module = _module()
    policy = json.loads(module.POLICY_PATH.read_text(encoding="utf-8"))

    assert policy["production"]["manual_dispatch_users"] == (
        module.PRODUCTION_MANUAL_DISPATCH_USERS
    ), (
        "config/ci-governance.json -> production.manual_dispatch_users and "
        "PRODUCTION_MANUAL_DISPATCH_USERS in "
        "scripts/ci/verify-deployment-environment-governance.py must be updated "
        "in the same PR"
    )


def test_production_dispatch_accepts_only_the_approved_three_operators() -> None:
    root = Path(__file__).resolve().parents[2]
    expected = {"kushaltrivedi5", "ankitkumarsingh1702", "imsharukhan"}
    policy = json.loads((root / "config/ci-governance.json").read_text())
    assert set(policy["main"]["merge_users"]) == expected
    env = {key: value for key, value in os.environ.items() if not key.startswith("GITHUB_")}
    for actor in sorted(expected | {"msainani", "RGlodAkshat", "DamriaNeelesh"}):
        result = subprocess.run(
            [sys.executable, str(root / "scripts/ci/assert-governed-actor.py"),
             "--surface", "production", "--actor", actor],
            env=env, capture_output=True, text=True, check=False,
        )
        assert (result.returncode == 0) == (actor in expected), (actor, result.stderr)


def _validate_capacity_trigger(event_name: str, event: dict, *, actor: str = "kushaltrivedi5", ref: str = "main", action: str = "",
                               workflow: str = "capacity-maintenance.yml",
                               run_attempt: int = 1, triggering_actor: str | None = None,
                               step: str = "Require main and governed manual actor") -> subprocess.CompletedProcess[str]:
    """Execute the actual shell authority gate, including the real actor policy."""
    root = Path(__file__).resolve().parents[2]
    source = (root / ".github/workflows" / workflow).read_text()
    match = re.search(
        rf"      - name: {re.escape(step)}\n.*?"
        r"        run: \|\n(.*?)(?=\n      - name:|\n      #|\Z)", source, re.DOTALL,
    )
    assert match is not None, f"{workflow} authority gate is missing"
    inputs = event.get("inputs") or {}
    # Model the test event, not the CI job that happens to run this fixture.
    env = {key: value for key, value in os.environ.items() if not key.startswith("GITHUB_")}
    return subprocess.run(
        ["bash", "-c", textwrap.dedent(match.group(1))], cwd=root,
        env={**env, "GITHUB_EVENT_NAME": event_name, "GITHUB_REF_NAME": ref,
             "GITHUB_RUN_ATTEMPT": str(run_attempt),
             "GITHUB_TRIGGERING_ACTOR": actor if triggering_actor is None else triggering_actor,
             "GITHUB_ACTOR": actor, "RELEASE_ENV": inputs.get("environment", ""),
             "RELEASE_RUN_ID": inputs.get("healthy_release_run_id", ""),
             "CAPACITY_BRIDGE": inputs.get("production_capacity_bridge", ""),
             "APPLY": inputs.get("apply", ""),
             "CLOCK_EVENT_TYPE": action},
        capture_output=True, text=True, check=False,
    )


def test_capacity_fixture_ignores_parent_retry_identity() -> None:
    from unittest.mock import patch

    event = {"inputs": {"environment": "production", "healthy_release_run_id": "43"}}
    with patch.dict(os.environ, {
        "GITHUB_RUN_ATTEMPT": "2",
        "GITHUB_TRIGGERING_ACTOR": "unapproved-contributor",
        "GITHUB_EVENT_PATH": "/nonexistent/parent-ci-event.json",
    }):
        accepted = _validate_capacity_trigger("workflow_dispatch", event)
        assert accepted.returncode == 0, accepted.stderr
        refused = _validate_capacity_trigger("workflow_dispatch", event, actor="unapproved-contributor")
        assert refused.returncode != 0, "Fixture isolation must not grant actor authority"


def test_capacity_rerun_requires_its_own_authorized_triggering_actor() -> None:
    for environment in ("uat", "production"):
        event = {"inputs": {"environment": environment, "healthy_release_run_id": "43"}}
        accepted = _validate_capacity_trigger("workflow_dispatch", event, run_attempt=2,
                                              triggering_actor="kushaltrivedi5")
        assert accepted.returncode == 0, accepted.stderr
        for actor in ("unapproved-contributor", ""):
            refused = _validate_capacity_trigger("workflow_dispatch", event, run_attempt=2,
                                                 triggering_actor=actor)
            assert refused.returncode != 0, "An unauthorized rerun was accepted"
            assert "authorized triggering actor" in refused.stderr


def test_capacity_cleanup_accepts_only_schedule_and_governed_manual_modes() -> None:
    scheduled = _validate_capacity_trigger("schedule", {})
    assert scheduled.returncode == 0, scheduled.stderr
    for environment, apply in (("uat", "true"), ("production", "false")):
        event = {"inputs": {"environment": environment, "healthy_release_run_id": "43", "apply": apply}}
        result = _validate_capacity_trigger("workflow_dispatch", event)
        assert result.returncode == 0, result.stderr
        denied = _validate_capacity_trigger("workflow_dispatch", event, actor="unapproved-contributor")
        assert denied.returncode != 0, "Ungoverned manual cleanup was accepted"
    for invalid in ("dev", "production\napply=true"):
        result = _validate_capacity_trigger("workflow_dispatch", {"inputs": {"environment": invalid, "healthy_release_run_id": "43"}})
        assert result.returncode != 0
    result = _validate_capacity_trigger("workflow_dispatch", {"inputs": {"environment": "uat", "healthy_release_run_id": "43\napply=true"}})
    assert result.returncode != 0


def test_capacity_cleanup_rejects_deployment_events_and_non_main() -> None:
    for event_name in ("workflow_run", "pull_request", "push"):
        result = _validate_capacity_trigger(event_name, {})
        assert result.returncode != 0, f"Unexpected {event_name} can wake cleanup"
    for event_name in ("schedule", "workflow_dispatch"):
        result = _validate_capacity_trigger(event_name, {"inputs": {"environment": "production", "healthy_release_run_id": "43"}}, ref="contributor-branch")
        assert result.returncode != 0, "Non-main cleanup was accepted"


def test_fixed_bridge_requires_governed_manual_production_apply() -> None:
    event = {"inputs": {"environment": "production", "healthy_release_run_id": "43", "apply": "true", "production_capacity_bridge": "true"}}
    accepted = _validate_capacity_trigger("workflow_dispatch", event)
    assert accepted.returncode == 0, accepted.stderr
    for trigger in ("schedule", "repository_dispatch", "push"):
        denied = _validate_capacity_trigger(trigger, event, action="capacity-maintenance-tick-production")
        assert denied.returncode != 0, "A non-manual bridge request was accepted"
    for field, value in (("environment", "uat"), ("apply", "false")):
        wrong = {"inputs": {**event["inputs"], field: value}}
        assert _validate_capacity_trigger("workflow_dispatch", wrong).returncode != 0
    for actor, ref in (("unapproved-contributor", "main"), ("kushaltrivedi5", "feature/example")):
        assert _validate_capacity_trigger("workflow_dispatch", event, actor=actor, ref=ref).returncode != 0


def test_capacity_clock_tick_carries_only_scheduled_authority() -> None:
    tick = "capacity-maintenance-tick"
    for actor in ("github-actions[bot]", "kushaltrivedi5"):
        for scoped in (tick, tick + "-uat", tick + "-production"):
            accepted = _validate_capacity_trigger("repository_dispatch", {}, actor=actor, action=scoped)
            assert accepted.returncode == 0, accepted.stderr
    # The clock's own re-arm event must never wake maintenance.
    for foreign in ("capacity-maintenance-clock", tick + "-dev"):
        refused = _validate_capacity_trigger("repository_dispatch", {}, actor="github-actions[bot]", action=foreign)
        assert refused.returncode != 0, foreign
    # A tick wakes both environments, so a human needs both cohorts; azfx is
    # in the UAT cohort only.
    for actor in ("unapproved-contributor", "azfx"):
        denied = _validate_capacity_trigger("repository_dispatch", {}, actor=actor, action=tick)
        assert denied.returncode != 0, f"Ungoverned clock tick from {actor} was accepted"
    for action in ("", "deploy", tick + "\napply=true"):
        wrong = _validate_capacity_trigger("repository_dispatch", {}, actor="github-actions[bot]", action=action)
        assert wrong.returncode != 0, f"Unexpected dispatch type {action!r} can wake cleanup"
    branch = _validate_capacity_trigger("repository_dispatch", {}, actor="github-actions[bot]", ref="contributor-branch", action=tick)
    assert branch.returncode != 0, "Non-main clock tick was accepted"


def test_capacity_clock_accepts_only_its_own_trigger() -> None:
    def clock(event_name: str, **kwargs) -> subprocess.CompletedProcess[str]:
        return _validate_capacity_trigger(event_name, {}, workflow="capacity-maintenance-clock.yml",
                                          step="Require main and the clock's own trigger", **kwargs)

    tick = "capacity-maintenance-clock"
    assert clock("schedule").returncode == 0
    for actor in ("github-actions[bot]", "kushaltrivedi5"):
        accepted = clock("repository_dispatch", actor=actor, action=tick)
        assert accepted.returncode == 0, accepted.stderr
    for actor in ("unapproved-contributor", "azfx"):
        assert clock("repository_dispatch", actor=actor, action=tick).returncode != 0, actor
    # The maintenance tick cannot drive the clock, nor any other event.
    assert clock("repository_dispatch", actor="github-actions[bot]", action="capacity-maintenance-tick").returncode != 0
    for event_name in ("workflow_dispatch", "workflow_run", "push", "pull_request"):
        assert clock(event_name, actor="github-actions[bot]", action=tick).returncode != 0, event_name
    assert clock("schedule", ref="contributor-branch").returncode != 0


def _run_wake_step(uat_ready: str, production_ready: str) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    """Run the real clock `wake` step with a fake gh that records dispatches."""
    root = Path(__file__).resolve().parents[2]
    source = (root / ".github/workflows/capacity-maintenance-clock.yml").read_text()
    match = re.search(
        r"      - name: Send one capacity-maintenance-tick\n.*?"
        r"        run: \|\n(.*?)(?=\n\n|\n      - name:|\Z)", source, re.DOTALL,
    )
    assert match is not None, "Capacity clock wake step is missing"
    import tempfile

    with tempfile.TemporaryDirectory() as temporary:
        bin_dir = Path(temporary)
        calls = bin_dir / "calls"
        fake_gh = bin_dir / "gh"
        fake_gh.write_text(f"#!/bin/sh\necho \"$*\" >> '{calls}'\nexit 0\n")
        fake_gh.chmod(0o755)
        result = subprocess.run(
            ["bash", "-c", textwrap.dedent(match.group(1))], cwd=root,
            env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "GITHUB_REPOSITORY": "org/repo",
                 "UAT_READY": uat_ready, "PRODUCTION_READY": production_ready},
            capture_output=True, text=True, check=False,
        )
        recorded = calls.read_text().splitlines() if calls.exists() else []
    return result, recorded


def test_capacity_clock_wakes_maintenance_scoped_to_due_environments() -> None:
    # A UAT-only tick must not add a run to production's checkpoint walk.
    post = "api --method POST repos/org/repo/dispatches -f event_type="
    for uat, production, expected in (
        ("true", "true", ["capacity-maintenance-tick"]),
        ("true", "", ["capacity-maintenance-tick-uat"]),
        ("false", "true", ["capacity-maintenance-tick-production"]),
        ("false", "false", []),
    ):
        result, recorded = _run_wake_step(uat, production)
        assert result.returncode == 0, result.stderr
        assert recorded == [post + tick for tick in expected], (uat, production, recorded)


def _run_clock_summary(values: dict[str, str]) -> str:
    root = Path(__file__).resolve().parents[2]
    source = (root / ".github/workflows/capacity-maintenance-clock.yml").read_text()
    match = re.search(
        r"      - name: Summarize capacity clock checks\n.*?"
        r"        run: \|\n(.*?)(?=\n  [\w-]+:\n|\n      - name:|\Z)",
        source,
        re.DOTALL,
    )
    assert match is not None, "Capacity clock summary step is missing"
    import tempfile

    with tempfile.TemporaryDirectory() as temporary:
        summary = Path(temporary) / "summary.md"
        result = subprocess.run(
            [
                "bash",
                "--noprofile",
                "--norc",
                "-eo",
                "pipefail",
                "-c",
                textwrap.dedent(match.group(1)),
            ],
            cwd=root,
            env={**os.environ, **values, "GITHUB_STEP_SUMMARY": str(summary)},
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        return summary.read_text()


def test_capacity_clock_summary_reports_due_checks_scope_and_next_wait() -> None:
    source = (
        Path(__file__).resolve().parents[2]
        / ".github/workflows/capacity-maintenance-clock.yml"
    ).read_text()
    assert 'run-name: "Capacity clock"' in source
    assert "github.run_number" not in source
    uat_only = _run_clock_summary(
        {
            "CLOCK_AUTHORITY": "true",
            "UAT_DUE": "true",
            "UAT_CHECK": "success",
            "PRODUCTION_DUE": "false",
            "PRODUCTION_CHECK": "success",
        }
    )
    assert "| UAT | due | success | uat-only | 60-minute environment wait" in uat_only
    assert "| Production | not due | success | none | 60-minute environment wait" in uat_only
    both_due = _run_clock_summary(
        {
            "CLOCK_AUTHORITY": "true",
            "UAT_DUE": "true",
            "UAT_CHECK": "success",
            "PRODUCTION_DUE": "true",
            "PRODUCTION_CHECK": "success",
        }
    )
    assert "all (UAT + production)" in both_due
    failed = _run_clock_summary(
        {
            "CLOCK_AUTHORITY": "false",
            "UAT_DUE": "unknown",
            "UAT_CHECK": "failure",
            "PRODUCTION_DUE": "false",
            "PRODUCTION_CHECK": "success",
        }
    )
    assert "| UAT | unknown | failure | unknown | not armed |" in failed


def _run_clock_step(started_seconds_ago: int) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    """Run the real `next-check` step with a fake gh that records dispatches."""
    root = Path(__file__).resolve().parents[2]
    source = (root / ".github/workflows/capacity-maintenance-clock.yml").read_text()
    match = re.search(
        r"      - name: Queue the next check after the clock's wait\n.*?"
        r"        run: \|\n(.*?)(?=\n\S|\n      - name:|\Z)", source, re.DOTALL,
    )
    assert match is not None, "Capacity clock step is missing"
    import tempfile
    from datetime import datetime, timedelta, timezone

    with tempfile.TemporaryDirectory() as temporary:
        bin_dir = Path(temporary)
        calls = bin_dir / "calls"
        started = (datetime.now(timezone.utc) - timedelta(seconds=started_seconds_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")
        fake_gh = bin_dir / "gh"
        fake_gh.write_text(
            "#!/bin/sh\n"
            f"echo \"$*\" >> '{calls}'\n"
            f"case \"$*\" in *--method\\ POST*) exit 0 ;; *) echo '{started}' ;; esac\n"
        )
        fake_gh.chmod(0o755)
        result = subprocess.run(
            ["bash", "-c", textwrap.dedent(match.group(1))], cwd=root,
            env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}",
                 "GITHUB_REPOSITORY": "org/repo", "GITHUB_RUN_ID": "77",
                 "CLOCK_MIN_ELAPSED_SECONDS": "3300", "GITHUB_STEP_SUMMARY": "/dev/null"},
            capture_output=True, text=True, check=False,
        )
        recorded = calls.read_text().splitlines() if calls.exists() else []
    return result, [call for call in recorded if "--method POST" in call]


def test_capacity_clock_refuses_to_queue_before_its_wait() -> None:
    # Without the environment's wait timer the job starts at once; queuing then
    # would spin a check every few minutes on the shared runner pool.
    early, early_posts = _run_clock_step(started_seconds_ago=90)
    assert early.returncode != 0, "Clock queued a pass without waiting"
    assert early_posts == [], early_posts
    assert "must hold a 60-minute wait timer" in early.stdout
    late, late_posts = _run_clock_step(started_seconds_ago=3700)
    assert late.returncode == 0, late.stderr
    assert late_posts == ["api --method POST repos/org/repo/dispatches -f event_type=capacity-maintenance-clock"], late_posts


def main() -> int:
    tests = [
        test_dev_exact_branch_inventory_refuses_wildcards_and_incomplete_reads,
        test_required_environment_variables_are_enforced,
        test_missing_environment_variable_fails_verification,
        test_production_cohort_drift_is_reported,
        test_a_trusted_readiness_exam_environment_must_admit_only_main,
        test_production_tripwire_matches_committed_policy,
        test_production_dispatch_accepts_only_the_approved_three_operators,
        test_capacity_fixture_ignores_parent_retry_identity,
        test_capacity_rerun_requires_its_own_authorized_triggering_actor,
        test_capacity_cleanup_accepts_only_schedule_and_governed_manual_modes,
        test_capacity_cleanup_rejects_deployment_events_and_non_main,
        test_fixed_bridge_requires_governed_manual_production_apply,
        test_capacity_clock_tick_carries_only_scheduled_authority,
        test_capacity_clock_accepts_only_its_own_trigger,
        test_capacity_clock_wakes_maintenance_scoped_to_due_environments,
        test_capacity_clock_summary_reports_due_checks_scope_and_next_wait,
        test_capacity_clock_refuses_to_queue_before_its_wait,
    ]
    failures = []
    for test in tests:
        try:
            test()
        except Exception:
            traceback.print_exc()
            failures.append(test.__name__)
        else:
            print(f"ok {test.__name__}")
    if failures:
        print("Failed environment checks: " + ", ".join(failures), file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

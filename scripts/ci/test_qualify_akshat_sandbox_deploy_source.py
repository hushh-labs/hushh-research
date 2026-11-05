"""Test the trust boundary for Akshat's self-service sandbox deployments."""

from pathlib import Path
import runpy

import pytest

import queue_combined_result as queue

SOURCE, AUTHORITY = "a" * 40, "b" * 40


@pytest.fixture
def qualification(monkeypatch):
    scope = runpy.run_path(
        str(Path(__file__).with_name("qualify-akshat-sandbox-deploy-source.py"))
    )
    branch = scope["SOURCE_BRANCH"]
    ref = f"refs/heads/{branch}"
    git = {
        ("rev-parse", "HEAD"): AUTHORITY,
        (
            "fetch",
            "--no-tags",
            "--depth=1",
            "origin",
            f"+{ref}:refs/remotes/origin/{branch}",
        ): "",
        ("rev-parse", f"refs/remotes/origin/{branch}"): SOURCE,
        (
            "diff",
            "--name-only",
            AUTHORITY,
            SOURCE,
            "--",
            *scope["QUALIFICATION_PATHS"],
        ): "",
        ("ls-remote", "origin", ref): f"{SOURCE} {ref}",
    }
    monkeypatch.setattr(queue, "git", lambda *args: git[args])
    monkeypatch.setattr(
        queue, "api", lambda _: {"merge_base_commit": {"sha": scope["BASELINE"]}}
    )
    for key, value in {
        "GITHUB_REPOSITORY": scope["REPOSITORY"],
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GH_TOKEN": "fixture",
    }.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setitem(
        scope["qualify"].__globals__, "verify_invocation_authority", lambda *_: None
    )
    observed = []

    def ci_gate(argv, *, env, check, timeout):
        assert argv[-1] == SOURCE and check is True and timeout > 0
        observed.append(
            (
                env["REQUIRED_BRANCH"],
                env["REQUIRE_CI_HEAD_BRANCH"],
                env["REQUIRED_CHECK_NAME"],
            )
        )

    monkeypatch.setattr(scope["subprocess"], "run", ci_gate)
    return scope["qualify"], git, observed


def test_qualification_requires_branch_bound_ci_and_rechecks_the_tip(qualification):
    qualify, git, observed = qualification
    qualify(SOURCE, AUTHORITY)
    assert observed == [("New_memory_architecutre", "1", "Branch Validation Gate")]

    git[("ls-remote", "origin", "refs/heads/New_memory_architecutre")] = (
        f"{AUTHORITY} refs/heads/New_memory_architecutre"
    )
    with pytest.raises(queue.Refused, match="changed during qualification"):
        qualify(SOURCE, AUTHORITY)


def test_qualification_refuses_altered_ci_before_accepting_a_green_gate(qualification):
    qualify, git, observed = qualification
    diff = next(key for key in git if key[0] == "diff")
    git[diff] = ".github/workflows/ci.yml"
    with pytest.raises(queue.Refused, match="authority differs from Main"):
        qualify(SOURCE, AUTHORITY)
    assert observed == []

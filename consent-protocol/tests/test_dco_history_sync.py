"""DCO history-sync admits only provider-confirmed protected Main ancestry."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_DCO_CHECK = _REPO / "scripts" / "ci" / "check-dco-signoff.sh"


def _throwaway_repo(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "GIT_CONFIG_GLOBAL": str(root / ".gitconfig"), "HOME": str(root)}
    for args in (
        ["init", "--quiet", "-b", "main"],
        ["config", "user.name", "Probe"],
        ["config", "user.email", "probe@example.invalid"],
    ):
        subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, env=env)  # noqa: S603


def _history_sync_fixture(root: Path, *, signed_child: bool = True):
    _throwaway_repo(root)
    env = {**os.environ, "GIT_CONFIG_GLOBAL": str(root / ".gitconfig"), "HOME": str(root)}

    def git(*args: str) -> str:
        return subprocess.run(  # noqa: S603
            ["git", *args], cwd=root, env=env, capture_output=True, text=True, check=True
        ).stdout.strip()

    record = root / "record.txt"
    record.write_text("base\n")
    git("add", "record.txt")
    git("commit", "--quiet", "-s", "-m", "signed UAT base")
    base = git("rev-parse", "HEAD")
    record.write_text("accepted Main history\n")
    git("add", "record.txt")
    git("commit", "--quiet", "-m", "trusted Main history")
    main = git("rev-parse", "HEAD")

    remote = root.parent / "origin.git"
    subprocess.run(["git", "init", "--bare", "--quiet", str(remote)], check=True)  # noqa: S603
    git("remote", "add", "origin", str(remote))
    git("push", "--quiet", "origin", "main")
    git("switch", "--quiet", "-c", "candidate")
    record.write_text("new source change\n")
    git("add", "record.txt")
    commit_args = ["commit", "--quiet", "-m", "new source commit"]
    if signed_child:
        commit_args.insert(2, "-s")
    git(*commit_args)
    head = git("rev-parse", "HEAD")

    tools = root.parent / "tools"
    tools.mkdir()
    fake_gh = tools / "gh"
    fake_gh.write_text(
        "#!/bin/sh\n"
        'test "$1" = api && test "$2" = repos/hushh-labs/hushh-research/branches/main || exit 22\n'
        'cat "$DCO_BRANCH_RESPONSE"\n'
    )
    fake_gh.chmod(0o700)
    response = root.parent / "branch.json"
    response.write_text(json.dumps({"name": "main", "protected": True, "commit": {"sha": main}}))
    env.update(
        {
            "PATH": f"{tools}:{os.environ['PATH']}",
            "DCO_BRANCH_RESPONSE": str(response),
            "GH_TOKEN": "test-token",
            "GITHUB_EVENT_NAME": "pull_request",
            "GITHUB_BASE_REF": "uat",
            "GITHUB_REPOSITORY": "hushh-labs/hushh-research",
            "GITHUB_SERVER_URL": "https://github.com",
            "GITHUB_BASE_SHA": base,
            "GITHUB_HEAD_SHA": head,
        }
    )
    return base, main, head, env, response


def test_history_sync_excludes_only_provider_confirmed_protected_main_history(
    tmp_path: Path,
) -> None:
    root = tmp_path / "history-sync"
    base, main, head, env, _ = _history_sync_fixture(root)
    env["DCO_TRUSTED_MAIN_SHA"] = head
    result = subprocess.run(  # noqa: S603
        ["bash", str(_DCO_CHECK), "--history-sync"],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "checking 1 non-merge commit(s)" in result.stdout
    assert f"excluding 1 non-merge commit(s) reachable from protected Main {main}" in result.stdout
    assert base != head


def test_history_sync_rejects_an_unsigned_new_child_even_with_caller_baseline(
    tmp_path: Path,
) -> None:
    root = tmp_path / "unsigned-child"
    _, main, head, env, _ = _history_sync_fixture(root, signed_child=False)
    env["DCO_TRUSTED_MAIN_SHA"] = head
    result = subprocess.run(  # noqa: S603
        ["bash", str(_DCO_CHECK), "--history-sync"],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0 and "Missing DCO signoff" in result.stderr
    assert "checking 1 non-merge commit(s)" in result.stdout
    assert f"excluding 1 non-merge commit(s) reachable from protected Main {main}" in result.stdout


def test_history_sync_fails_closed_on_untrusted_or_incomplete_main_authority(
    tmp_path: Path,
) -> None:
    root = tmp_path / "invalid-authority"
    _, main, head, env, response_path = _history_sync_fixture(root)
    original = json.loads(response_path.read_text())
    invalid_responses = (
        {**original, "name": "uat"},
        {**original, "protected": False},
        {"name": "main", "protected": True, "commit": {}},
        {"name": "main", "protected": True, "commit": {"sha": "f" * 40}},
    )
    for response in invalid_responses:
        response_path.write_text(json.dumps(response))
        result = subprocess.run(  # noqa: S603
            ["bash", str(_DCO_CHECK), "--history-sync"],
            cwd=root,
            env=env,
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0

    response_path.write_text(json.dumps(original))
    for changed in (
        {"GITHUB_REPOSITORY": "attacker/fork"},
        {"GITHUB_SERVER_URL": "https://github.invalid"},
        {"GITHUB_BASE_REF": "main"},
        {"GITHUB_BASE_SHA": ""},
    ):
        result = subprocess.run(  # noqa: S603
            ["bash", str(_DCO_CHECK), "--history-sync"],
            cwd=root,
            env={**env, **changed},
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0

    wrong_range = subprocess.run(  # noqa: S603
        ["bash", str(_DCO_CHECK), "--history-sync", main, head],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
    )
    assert wrong_range.returncode != 0
    assert "caller-supplied ranges are not accepted" in wrong_range.stderr


def test_ordinary_pr_range_keeps_strict_dco_behavior(tmp_path: Path) -> None:
    root = tmp_path / "ordinary-pr"
    base, main, _, env, _ = _history_sync_fixture(root)
    env["GITHUB_BASE_REF"] = "main"
    result = subprocess.run(  # noqa: S603
        ["bash", str(_DCO_CHECK), base, main],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0 and "Missing DCO signoff" in result.stderr


def test_ci_limits_history_sync_mode_to_dev_and_uat_pull_requests() -> None:
    workflow = (_REPO / ".github/workflows/ci.yml").read_text()
    job = workflow.split("  dco-check:\n", 1)[1].split("\n  pr-base-policy:", 1)[0]
    assert "GITHUB_BASE_REF: ${{ github.base_ref }}" in job
    assert "GH_TOKEN: ${{ github.token }}" in job
    assert '"${GITHUB_EVENT_NAME:-}" == pull_request' in job
    assert '"${GITHUB_BASE_REF:-}" == dev' in job
    assert '"${GITHUB_BASE_REF:-}" == uat' in job
    assert "check-dco-signoff.sh --history-sync" in job
    assert "else\n            bash scripts/ci/check-dco-signoff.sh\n" in job

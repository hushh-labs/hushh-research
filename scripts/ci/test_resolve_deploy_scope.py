#!/usr/bin/env python3
"""Unit checks for scripts/ci/resolve-deploy-scope.py."""

from __future__ import annotations

import importlib.util
import sys
import subprocess
import tempfile
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("resolve-deploy-scope.py")


def load_module():
    spec = importlib.util.spec_from_file_location("resolve_deploy_scope", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def run_git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout.strip()


def commit_file(repo: Path, relative_path: str, content: str) -> str:
    path = repo / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    run_git(repo, "add", relative_path)
    run_git(repo, "commit", "-m", f"update {relative_path}")
    return run_git(repo, "rev-parse", "HEAD")


def with_git_repo():
    tempdir = tempfile.TemporaryDirectory()
    repo = Path(tempdir.name)
    run_git(repo, "init")
    run_git(repo, "config", "user.email", "ci@example.com")
    run_git(repo, "config", "user.name", "CI")
    return tempdir, repo


def test_explicit_scope_overrides_paths() -> None:
    resolver = load_module()
    decision = resolver.explicit_decision("frontend")
    assert decision.scope == "frontend"
    assert decision.deploy_frontend is True
    assert decision.deploy_backend is False


def test_auto_frontend_only_change() -> None:
    resolver = load_module()
    tempdir, repo = with_git_repo()
    with tempdir:
        base = commit_file(repo, "README.md", "base\n")
        target = commit_file(repo, "hushh-webapp/app/page.tsx", "frontend\n")
        previous_cwd = Path.cwd()
        try:
            import os

            os.chdir(repo)
            decision = resolver.auto_decision(
                target_sha=target,
                backend_base_sha=base,
                frontend_base_sha=base,
            )
        finally:
            os.chdir(previous_cwd)
    assert decision.scope == "frontend"
    assert decision.deploy_frontend is True
    assert decision.deploy_backend is False
    assert decision.frontend_changed_files == ("hushh-webapp/app/page.tsx",)


def test_auto_backend_only_change() -> None:
    resolver = load_module()
    tempdir, repo = with_git_repo()
    with tempdir:
        base = commit_file(repo, "README.md", "base\n")
        target = commit_file(repo, "consent-protocol/api/routes/health.py", "backend\n")
        previous_cwd = Path.cwd()
        try:
            import os

            os.chdir(repo)
            decision = resolver.auto_decision(
                target_sha=target,
                backend_base_sha=base,
                frontend_base_sha=base,
            )
        finally:
            os.chdir(previous_cwd)
    assert decision.scope == "backend"
    assert decision.deploy_backend is True
    assert decision.deploy_frontend is False


def test_auto_mixed_change_deploys_all() -> None:
    resolver = load_module()
    tempdir, repo = with_git_repo()
    with tempdir:
        base = commit_file(repo, "README.md", "base\n")
        commit_file(repo, "hushh-webapp/app/page.tsx", "frontend\n")
        target = commit_file(repo, "consent-protocol/api/routes/health.py", "backend\n")
        previous_cwd = Path.cwd()
        try:
            import os

            os.chdir(repo)
            decision = resolver.auto_decision(
                target_sha=target,
                backend_base_sha=base,
                frontend_base_sha=base,
            )
        finally:
            os.chdir(previous_cwd)
    assert decision.scope == "all"
    assert decision.deploy_backend is True
    assert decision.deploy_frontend is True


def test_auto_shared_path_deploys_all() -> None:
    resolver = load_module()
    tempdir, repo = with_git_repo()
    with tempdir:
        base = commit_file(repo, "README.md", "base\n")
        target = commit_file(repo, "deploy/shared-runtime.sh", "shared\n")
        previous_cwd = Path.cwd()
        try:
            import os

            os.chdir(repo)
            decision = resolver.auto_decision(
                target_sha=target,
                backend_base_sha=base,
                frontend_base_sha=base,
            )
        finally:
            os.chdir(previous_cwd)
    assert decision.scope == "all"
    assert decision.shared_changed_files == ("deploy/shared-runtime.sh",)


def test_auto_neutral_workflow_plus_frontend_stays_frontend() -> None:
    resolver = load_module()
    tempdir, repo = with_git_repo()
    with tempdir:
        base = commit_file(repo, "README.md", "base\n")
        commit_file(repo, ".github/workflows/deploy-uat.yml", "workflow\n")
        target = commit_file(repo, "hushh-webapp/app/page.tsx", "frontend\n")
        previous_cwd = Path.cwd()
        try:
            import os

            os.chdir(repo)
            decision = resolver.auto_decision(
                target_sha=target,
                backend_base_sha=base,
                frontend_base_sha=base,
            )
        finally:
            os.chdir(previous_cwd)
    assert decision.scope == "frontend"
    assert decision.neutral_changed_files == (".github/workflows/deploy-uat.yml",)


def test_auto_missing_deployed_sha_falls_back_to_all() -> None:
    resolver = load_module()
    decision = resolver.auto_decision(
        target_sha="abc123",
        backend_base_sha="",
        frontend_base_sha="def456",
    )
    assert decision.scope == "all"
    assert decision.reason == "auto:fallback_missing_deployed_sha"


def main() -> int:
    tests = [
        test_explicit_scope_overrides_paths,
        test_auto_frontend_only_change,
        test_auto_backend_only_change,
        test_auto_mixed_change_deploys_all,
        test_auto_shared_path_deploys_all,
        test_auto_neutral_workflow_plus_frontend_stays_frontend,
        test_auto_missing_deployed_sha_falls_back_to_all,
    ]
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

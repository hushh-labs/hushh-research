#!/usr/bin/env python3
"""Guard secret-scan ranges against dropping pre-merge feature commits."""

from __future__ import annotations

from pathlib import Path
import os
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
RANGE_OWNERS = (
    ROOT / "scripts/ci/secret-scan.sh",
    ROOT / ".github/workflows/ci.yml",
)


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(
        ["git", *args], cwd=repo, text=True, stderr=subprocess.DEVNULL
    ).strip()


def commit_file(repo: Path, name: str, content: str, message: str) -> str:
    (repo / name).write_text(content, encoding="utf-8")
    git(repo, "add", name)
    git(repo, "commit", "-m", message)
    return git(repo, "rev-parse", "HEAD")


def verify_ranges_exclude_ancestry_path() -> None:
    for path in RANGE_OWNERS:
        if "--ancestry-path" in path.read_text(encoding="utf-8"):
            raise AssertionError(
                f"{path.relative_to(ROOT)} filters merged feature commits"
            )


def verify_merged_feature_commits_stay_in_range() -> None:
    with tempfile.TemporaryDirectory(prefix="secret-scan-range-") as temp:
        repo = Path(temp)
        git(repo, "init", "-q", "-b", "main")
        git(repo, "config", "user.name", "Secret Scan Test")
        git(repo, "config", "user.email", "secret-scan-test@example.invalid")
        git(repo, "config", "commit.gpgsign", "false")
        commit_file(repo, "base.txt", "base", "base")
        base = git(repo, "rev-parse", "HEAD")

        git(repo, "switch", "-q", "-c", "feature")
        feature_one = commit_file(repo, "feature-one.txt", "one", "feature one")
        feature_two = commit_file(repo, "feature-two.txt", "two", "feature two")

        git(repo, "switch", "-q", "main")
        main_only = commit_file(repo, "main-only.txt", "main", "main advances")
        git(repo, "switch", "-q", "feature")
        git(repo, "merge", "--no-edit", "main")
        head = git(repo, "rev-parse", "HEAD")

        # A plain base..head range includes both feature commits; ancestry-path
        # silently excludes them after the feature merges the newer base branch.
        included = set(git(repo, "rev-list", f"{main_only}..{head}").splitlines())
        if not {feature_one, feature_two}.issubset(included):
            raise AssertionError("plain base..head range dropped feature commits")

        ancestor_only = set(
            git(
                repo, "rev-list", "--ancestry-path", f"{main_only}..{head}"
            ).splitlines()
        )
        if feature_one in ancestor_only or feature_two in ancestor_only:
            raise AssertionError("synthetic graph no longer demonstrates the range bug")
        if git(repo, "merge-base", base, head) != base:
            raise AssertionError("synthetic graph has an unexpected merge base")


def verify_public_schema_bound_keeps_secret_detection() -> None:
    public_bound = (
        '"string", "Owner approval state, distinct from payment and usable access.", '
        "maxLength=32\n"
    )
    # Synthetic credentials stay in process memory; scanner diagnostics are
    # redacted and never emitted. The same file must still detect a real value.
    # Keep this allowlist regression deterministic. Random URL-safe values can
    # miss Gitleaks' generic-key heuristic, causing unrelated CI runs to fail.
    # Construct a balanced synthetic value in memory; it is never a credential.
    synthetic_secret = "".join(format(value, "x") for value in range(16)) * 4
    cases = (
        (public_bound, 0),
        (public_bound + f'api_key = "{synthetic_secret}"\n', 1),
        (f'api_key = "maxLength=32{synthetic_secret}"\n', 1),
    )
    for index, (fixture, expected) in enumerate(cases):
        result = subprocess.run(
            [
                "gitleaks",
                "stdin",
                "--no-banner",
                "--redact",
                "--config",
                str(ROOT / ".gitleaks.toml"),
            ],
            input=fixture,
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode != expected:
            raise AssertionError(
                f"public schema bound case {index}: expected scanner exit {expected}, "
                f"received {result.returncode}"
            )


def verify_alert_reader_is_required() -> None:
    """A packaging/mode regression must not omit the required security authority."""
    with tempfile.TemporaryDirectory(prefix="required-alert-reader-") as temporary:
        root = Path(temporary)
        git(root, "init", "-q", "-b", "main")
        git(root, "config", "user.name", "Secret Scan Test")
        git(root, "config", "user.email", "secret-scan-test@example.invalid")
        git(root, "config", "commit.gpgsign", "false")
        commit_file(root, "fixture", "synthetic", "fixture")
        (root / ".gitleaks.toml").write_bytes((ROOT / ".gitleaks.toml").read_bytes())
        ci = root / "scripts/ci"
        ci.mkdir(parents=True)
        (ci / "secret-scan.sh").write_bytes(
            (ROOT / "scripts/ci/secret-scan.sh").read_bytes()
        )
        # Other scanner contracts have their own real regression cases above.
        (ci / "test_secret_scan_ranges.py").write_text(
            "# range checks are outside this packaging fixture\n"
        )
        commands = root / "fixture-bin"
        commands.mkdir()
        stub = commands / "gitleaks"
        stub.write_text("#!/bin/sh\nexit 0\n")
        stub.chmod(0o700)
        reader = ci / "github-security-alerts.sh"
        for state in ("present", "missing", "not_executable"):
            if state != "missing":
                reader.write_text("#!/bin/sh\nexit 0\n")
                reader.chmod(0o700 if state == "present" else 0o600)
            elif reader.exists():
                reader.unlink()
            environment = {
                **os.environ,
                "PATH": str(commands) + os.pathsep + os.environ["PATH"],
                "SKIP_SECRET_SCAN": "0",
                "GITLEAKS_LOG_OPTS": "HEAD",
                "GITLEAKS_DEFAULT_BRANCH": "main",
                "GITHUB_EVENT_NAME": "local",
                "SECRET_SCAN_PR_NUMBER": "",
            }
            result = subprocess.run(
                ["/bin/bash", str(ci / "secret-scan.sh")],
                cwd=root,
                env=environment,
                capture_output=True,
                text=True,
                timeout=10,
            )
            if (result.returncode == 0) != (state == "present"):
                raise AssertionError(
                    f"required alert reader {state}: unexpected scanner clearance"
                )


def verify_local_alert_policy() -> None:
    import github_security_authority as authority
    from unittest.mock import patch

    repository = "example/repository"
    from contextlib import redirect_stdout
    from io import StringIO

    cases = (
        ("healthy", "1", "0", 0),
        ("malformed", "1", "0", 1),
        ("optional_secret_denied", "0", "1", 1),
        ("optional_dependency_denied", "1", "0", 1),
        ("denied", "1", "0", 1),
        ("denied", "0", "0", 0),
    )
    for scenario, secret, dependency, expected in cases:

        def read(path):
            if scenario == "malformed":
                return ({"message": "not an inventory"}, "")
            if (
                scenario == "denied"
                or (
                    scenario == "optional_secret_denied" and "/secret-scanning/" in path
                )
                or (scenario == "optional_dependency_denied" and "/dependabot/" in path)
            ):
                raise authority.Refused("unavailable")
            if scenario != "healthy":
                return (
                    [{"state": "open", "security_advisory": {"severity": "critical"}}],
                    "",
                )
            return ([], "")

        env = {
            "REQUIRE_GITHUB_ALERTS_CLEAN": "0",
            "REQUIRE_GITHUB_SECRET_ALERTS_CLEAN": secret,
            "REQUIRE_GITHUB_DEPENDABOT_ALERTS_CLEAN": dependency,
        }
        with redirect_stdout(StringIO()):
            assert authority.local_alerts(env, repository, read) == expected
    with (
        patch.object(authority.subprocess, "run", side_effect=FileNotFoundError),
        redirect_stdout(StringIO()),
    ):
        assert authority.local_main({"REQUIRE_GITHUB_SECRET_ALERTS_CLEAN": "1"}) == 1
        assert authority.local_main({}) == 0


def main() -> None:
    verify_ranges_exclude_ancestry_path()
    verify_merged_feature_commits_stay_in_range()
    verify_public_schema_bound_keeps_secret_detection()
    verify_alert_reader_is_required()
    verify_local_alert_policy()
    print(
        "Secret scan range regression passed (merged feature commits remain included)."
    )


if __name__ == "__main__":
    main()

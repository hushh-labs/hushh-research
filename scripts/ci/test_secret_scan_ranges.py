#!/usr/bin/env python3
"""Guard secret-scan ranges against dropping pre-merge feature commits."""

from __future__ import annotations

from pathlib import Path
import json
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
    """Source scans need no alert credentials; explicit operator audits fail closed."""
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
        (ci / "secret-scan.sh").write_bytes((ROOT / "scripts/ci/secret-scan.sh").read_bytes())
        (ci / "test_secret_scan_ranges.py").write_text("# Other range cases run outside this fixture.\n")
        commands = root / "fixture-bin"
        commands.mkdir()
        activity, calls = root / "activity", root / "scanner-calls"
        for name, body in {
            "gitleaks": 'echo "$1" >> "$SCANNER_CALL_LOG"; case "$1" in git) exit "${GIT_EXIT:-0}" ;; dir) exit "${BODY_EXIT:-0}" ;; esac',
            "gh": 'echo unexpected-gh >> "$ACTIVITY_LOG"; exit 97',
        }.items():
            executable = commands / name
            executable.write_text("#!/bin/sh\n" + body + "\n", newline="\n")
            executable.chmod(0o700)
        event = root / "event.json"
        event.write_text(json.dumps({"pull_request": {"body": "Synthetic public body"}}))
        flags = ("REQUIRE_GITHUB_ALERTS_CLEAN", "REQUIRE_GITHUB_SECRET_ALERTS_CLEAN",
                 "REQUIRE_GITHUB_DEPENDABOT_ALERTS_CLEAN")
        cases = [("false", "", state, 97, 0, 0, 0) for state in ("present", "missing", "not_executable")]
        cases += [("true", "", "missing", 0, 0, 0, 0),
                  ("false", "", "missing", 0, 1, 0, 1),
                  ("false", "", "missing", 0, 0, 1, 1)]
        cases += [("false", flag, state, 0, 0, 0, 0 if state == "present" else 1)
                  for flag in flags for state in ("present", "missing", "not_executable")]
        cases += [("false", flag, "present", 1, 0, 0, 1) for flag in flags]
        reader = ci / "github-security-alerts.sh"
        for hosted, flag, state, reader_exit, git_exit, body_exit, expected in cases:
            if reader.exists():
                reader.unlink()
            for log in (activity, calls):
                log.unlink(missing_ok=True)
            if state != "missing":
                prefix = "#!/bin/sh\n" if state == "present" else ""
                reader.write_text(prefix + f'echo reader >> "$ACTIVITY_LOG"; exit {reader_exit}\n', newline="\n")
                reader.chmod(0o700 if state == "present" else 0o600)
            environment = {**os.environ, **{name: "0" for name in flags},
                "PATH": str(commands) + os.pathsep + os.environ["PATH"],
                "SKIP_SECRET_SCAN": "0", "GITLEAKS_LOG_OPTS": "HEAD",
                "GITLEAKS_DEFAULT_BRANCH": "main", "GITHUB_ACTIONS": hosted,
                "GITHUB_EVENT_NAME": "pull_request" if body_exit else "local",
                "GITHUB_EVENT_PATH": str(event), "SECRET_SCAN_PR_NUMBER": "",
                "SCANNER_CALL_LOG": str(calls), "ACTIVITY_LOG": str(activity),
                "GIT_EXIT": str(git_exit), "BODY_EXIT": str(body_exit)}
            if flag:
                environment[flag] = "1"
            result = subprocess.run(["/bin/bash", str(ci / "secret-scan.sh")], cwd=root,
                env=environment, capture_output=True, text=True, timeout=10)
            assert (result.returncode == 0) == (expected == 0), (hosted, flag, state, git_exit, body_exit)
            assert calls.read_text().splitlines() == (["git", "dir"] if body_exit else ["git"])
            activity_rows = activity.read_text().splitlines() if activity.exists() else []
            assert "unexpected-gh" not in activity_rows
            assert bool(activity_rows) == bool(flag and hosted == "false" and state == "present")


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
    for failure in (
        FileNotFoundError(),
        subprocess.CalledProcessError(1, ["gh", "auth", "token"]),
    ):
        with (
            patch.object(authority.subprocess, "run", side_effect=failure),
            redirect_stdout(StringIO()),
        ):
            assert authority.local_main(
                {
                    "GITHUB_REPOSITORY": repository,
                    "REQUIRE_GITHUB_SECRET_ALERTS_CLEAN": "1",
                }
            ) == 1
            assert authority.local_main({"GITHUB_REPOSITORY": repository}) == 0


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

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
            raise AssertionError(f"{path.relative_to(ROOT)} filters merged feature commits")


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
            git(repo, "rev-list", "--ancestry-path", f"{main_only}..{head}").splitlines()
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
                "gitleaks", "stdin", "--no-banner", "--redact",
                "--config", str(ROOT / ".gitleaks.toml"),
            ],
            input=fixture, text=True, capture_output=True, check=False,
        )
        if result.returncode != expected:
            raise AssertionError(
                f"public schema bound case {index}: expected scanner exit {expected}, "
                f"received {result.returncode}"
            )



def verify_alert_authentication_fails_closed() -> None:
    """Unavailable or malformed authority must not pass an explicitly strict gate."""
    with tempfile.TemporaryDirectory(prefix="security-alert-auth-") as temporary:
        root = Path(temporary)
        gh = root / "gh"
        gh.write_text("""#!/bin/sh
if [ "$1" = auth ]; then
  [ "$ALERT_CASE" != unauthenticated ]
  exit $?
fi
case "$*" in
  *secret-scanning*)
    case "$ALERT_CASE" in
      denied) exit 1 ;;
      malformed) printf '%s' '{"message":"unexpected"}' ;;
      open) printf '%s' '[{"number":1,"secret_type":"synthetic"}]' ;;
      *) printf '%s' '[]' ;;
    esac ;;
  *dependabot*) printf '%s' '[]' ;;
  *) exit 1 ;;
esac
""")
        gh.chmod(0o700)
        base = {**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                "GITHUB_REPOSITORY": "example/security-fixture", "GITHUB_EVENT_NAME": "workflow_dispatch",
                "REQUIRE_GITHUB_ALERTS_CLEAN": "1", "REQUIRE_GITHUB_SECRET_ALERTS_CLEAN": "1",
                "REQUIRE_GITHUB_DEPENDABOT_ALERTS_CLEAN": "0"}
        for scenario, expected in (("healthy", 0), ("unauthenticated", 1),
                                   ("denied", 1), ("malformed", 1), ("open", 1), ("missing", 1)):
            environment = {**base, "ALERT_CASE": scenario}
            if scenario == "missing":
                environment["PATH"] = str(root / "absent")
            result = subprocess.run(["/bin/bash", str(ROOT / "scripts/ci/github-security-alerts.sh")],
                                    env=environment, capture_output=True, text=True, timeout=10)
            if bool(result.returncode) != bool(expected):
                raise AssertionError(f"security alert authority {scenario}: expected exit {expected}, got {result.returncode}")
        environment = {**base, "ALERT_CASE": "unauthenticated", "REQUIRE_GITHUB_ALERTS_CLEAN": "0"}
        result = subprocess.run(["/bin/bash", str(ROOT / "scripts/ci/github-security-alerts.sh")],
                                env=environment, capture_output=True, text=True, timeout=10)
        if not result.returncode:
            raise AssertionError("explicit strict secret policy must refuse unauthenticated CLI even without global strict mode")


def main() -> None:
    verify_ranges_exclude_ancestry_path()
    verify_merged_feature_commits_stay_in_range()
    verify_public_schema_bound_keeps_secret_detection()
    verify_alert_authentication_fails_closed()
    print("Secret scan range regression passed (merged feature commits remain included).")


if __name__ == "__main__":
    main()

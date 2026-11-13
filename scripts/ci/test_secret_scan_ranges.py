#!/usr/bin/env python3
"""Guard secret-scan ranges against dropping pre-merge feature commits."""

from __future__ import annotations

import ast
import json
from pathlib import Path
import os
import shutil
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
    public_bound = (ROOT / "consent-protocol/tests/test_secrets_area.py").read_text()
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


def _scan_source(
    path: str, contents: str, *, config_path: Path | None = None, line_ending: str = "\n"
) -> tuple[int, set[str]]:
    with tempfile.TemporaryDirectory(prefix="gitleaks-source-allowlist-") as temp:
        root = Path(temp)
        fixture = root / path
        fixture.parent.mkdir(parents=True, exist_ok=True)
        # Control the bytes explicitly: Windows text-mode writes otherwise turn
        # every fixture into CRLF and leave the LF contract untested.
        fixture.write_bytes(contents.replace("\r\n", "\n").replace("\n", line_ending).encode("utf-8"))
        report_path = root / "redacted-report.json"
        result = subprocess.run(
            [
                "gitleaks",
                "dir",
                "--no-banner",
                "--redact",
                "--exit-code",
                "1",
                "--config",
                str(config_path or ROOT / ".gitleaks.toml"),
                "--report-format",
                "json",
                "--report-path",
                str(report_path),
                str(root),
            ],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=60,
        )
        findings = json.loads(report_path.read_text(encoding="utf-8"))
        return result.returncode, {str(item.get("RuleID", "")) for item in findings}

def _verify_session_source_controls(generic_token, line_ending):
    from functools import partial

    scan = partial(_scan_source, line_ending=line_ending)

    session_path = "consent-protocol/hushh_mcp/one_voice/session.py"

    session_source = (ROOT / session_path).read_text(encoding="utf-8")

    config_text = (ROOT / ".gitleaks.toml").read_text(encoding="utf-8")

    source_allowlist = (
        '[[rules.allowlists]]\n'
        '    description = "Nonliteral VoiceSession keyword expression; '
        'credential-shaped values in this file remain scanned."\n'
    )

    if config_text.count(source_allowlist) != 1:
        raise AssertionError("expected one source-aware VoiceSession exception")

    start = config_text.index(source_allowlist)

    end = config_text.index("\n[[rules.allowlists]]", start + len(source_allowlist))

    with tempfile.TemporaryDirectory(prefix="gitleaks-without-source-exception-") as temp:
        config_without_source_exception = Path(temp) / ".gitleaks.toml"
        config_without_source_exception.write_text(
            config_text[:start] + config_text[end + 1 :], encoding="utf-8"
        )
        status, rules = scan(
            session_path, session_source, config_path=config_without_source_exception
        )

    if status != 1 or "generic-api-key" not in rules:
        raise AssertionError("pinned VoiceSession source match was not reproduced")

    if scan(session_path, session_source) != (0, set()):
        raise AssertionError("exact nonliteral source match was not exempted")

    status, rules = scan(
        session_path,
        session_source + f'api_key = "{generic_token}"\n',
    )

    if status != 1 or "generic-api-key" not in rules:
        raise AssertionError("quoted credential in the same source path escaped scanning")

    owner_argument = "user_id=" + ".".join(("auth", "user_id"))
    conversation_argument = "conversation_id=" + ".".join(("self", "claims", "conversation_id"))
    expression = ", ".join((owner_argument, conversation_argument))
    if session_source.count(expression) != 1:
        raise AssertionError("expected exactly one allowlisted session expression")
    status, rules = scan(session_path, session_source.replace(
        expression, ", ".join((owner_argument, 'conversation_id="' + generic_token + '"')), 1,
    ))
    if status != 1 or "generic-api-key" not in rules:
        raise AssertionError("same-line credential replacement escaped scanning")

def _verify_classifier_source_controls(stripe_token, line_ending):
    from functools import partial

    scan = partial(_scan_source, line_ending=line_ending)

    classifier_path = "consent-protocol/tests/test_secrets_area.py"

    allowed_classifier = f'SYNTHETIC_STRIPE_TEST_VALUE = "{stripe_token}"\n'

    source_classifier = (ROOT / classifier_path).read_text()

    if "SYNTHETIC_STRIPE_TEST_VALUE" not in source_classifier or stripe_token in source_classifier:
        raise AssertionError("synthetic Stripe classifier input must not be embedded in source")

    status, rules = scan(classifier_path, source_classifier)

    if status != 0 or rules:
        raise AssertionError(
            "named synthetic classifier fixture was not narrowly exempted "
            f"(exit={status}, rules={sorted(rules)})"
        )

    status, rules = scan(
        classifier_path,
        allowed_classifier + f'separate_value = "{stripe_token}"\n',
    )

    if status != 1 or "stripe-access-token" not in rules:
        raise AssertionError("unrelated Stripe-shaped fixture escaped scanning")

    mutated_stripe_token = stripe_token[:-1] + ("1" if stripe_token[-1] == "0" else "0")

    same_line_tree = ast.parse(source_classifier)

    same_line_assignments = [
        node
        for node in ast.walk(same_line_tree)
        if isinstance(node, ast.Assign)
        and any(
            isinstance(target, ast.Name)
            and target.id == "SYNTHETIC_STRIPE_TEST_VALUE"
            for target in node.targets
        )
    ]

    if len(same_line_assignments) != 1:
        raise AssertionError("expected one source fixture assignment to mutate")

    source_assignment = ast.get_source_segment(
        source_classifier, same_line_assignments[0]
    )

    if not source_assignment:
        raise AssertionError("could not locate source fixture assignment")

    replacement_count = source_classifier.count(source_assignment)

    if replacement_count != 1:
        raise AssertionError("expected exactly one source assignment replacement")

    same_line_mutation = source_classifier.replace(
        source_assignment,
        "SYNTHETIC_STRIPE_TEST_VALUE = " + json.dumps(mutated_stripe_token),
        1,
    )

    if same_line_mutation == source_classifier or source_assignment in same_line_mutation:
        raise AssertionError("source assignment was not replaced exactly once")

    if same_line_mutation == source_classifier:
        raise AssertionError("same-line Stripe source mutation did not change the source")

    status, rules = scan(classifier_path, same_line_mutation)

    if status != 1 or "stripe-access-token" not in rules:
        raise AssertionError("same-line Stripe right-hand-side mutation was not detected")

def verify_source_aware_allowlists_keep_detection():
    version = subprocess.run(
        ["gitleaks", "version"], capture_output=True, text=True, check=True
    ).stdout.strip()

    if version != "8.24.2":
        raise AssertionError("source-aware scanner controls require Gitleaks 8.24.2")

    stripe_token = "sk_test_" + "synthetic" + "0" * 16

    generic_token = "".join(format(value, "x") for value in range(16)) * 4

    for line_ending in ("\n", "\r\n"):
        _verify_session_source_controls(generic_token, line_ending)
        _verify_classifier_source_controls(stripe_token, line_ending)


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
            shell_command = ["/bin/bash", str(ci / "secret-scan.sh")]
            if os.name == "nt":
                # Use Git's POSIX shell, not Windows' WSL bash launcher. Translate
                # only paths consumed by the shell; Python still receives native
                # paths through its own CLI. Keep every fail-closed reader case.
                git_executable = shutil.which("git")
                if not git_executable:
                    raise AssertionError("Git for Windows is required for shell controls")
                # cmd/git.exe and mingw64/bin/git.exe are both supported layouts.
                candidates = (parent / "bin/bash.exe" for parent in Path(git_executable).resolve().parents)
                bash = next((path for path in candidates if path.is_file()), None)
                if bash is None:
                    raise AssertionError("Git for Windows Bash was not found")
                shell_command = [str(bash), "-c", '''
export SCANNER_CALL_LOG="$(cygpath -u "$SCANNER_CALL_LOG")"
export ACTIVITY_LOG="$(cygpath -u "$ACTIVITY_LOG")"
export GITHUB_EVENT_PATH="$(cygpath -u "$GITHUB_EVENT_PATH")"
exec /bin/bash "$(cygpath -u "$1")"
''', "secret-scan-fixture", str(ci / "secret-scan.sh")]
            result = subprocess.run(shell_command, cwd=root,
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
    verify_source_aware_allowlists_keep_detection()
    verify_alert_reader_is_required()
    verify_local_alert_policy()
    print(
        "Secret scan range regression passed (merged feature commits remain included)."
    )


if __name__ == "__main__":
    main()

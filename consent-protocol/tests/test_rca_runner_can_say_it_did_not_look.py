"""The RCA runner must never report a domain failure for a check that never ran.

WHY THIS EXISTS
Measured 2026-08-29. `./bin/hushh codex rca --surface uat` reported:

    Status: blocked
    Blocking classifications: db_contract_drift
    Next actions:
    - Resolve DB release-contract drift before treating the surface as deployable.

The database contract was fine. `verify_runtime_db_contract.sh` had died at
`import asyncpg`, a package absent from the interpreter the runner happened to be
launched with, and `_run` returned one integer that the call site read as a
substantive finding. Anyone acting on that verdict would have gone hunting drift
that did not exist while the real defect stayed invisible.

Three separate treatments of "the check did not run" lived in the same function,
six lines apart, and no two agreed:

  * db_contract  -- non-zero exit became `db_contract_drift`          (false RED)
  * semantic     -- only the report file was read, so a crashed
                    verifier produced NO classification at all        (false GREEN)
  * parity       -- non-zero + no report became `runtime_mount_missing`
                    (false RED, and the wrong class)

The `ci` surface had a fourth: `./bin/hushh ci` exited 143 because a watchdog
SIGTERMed a child, and that became `core_ci_failed`. CI had not failed; CI had
been killed.

The deploy gates already knew better. `.github/workflows/deploy-uat.yml`
separates `semantic_verifier_failed` from `runtime_behavior_failed`, and tests
`db_outcome == "failure"` rather than `!= "success"` so a skipped step never
becomes drift. The local runner -- the one an agent actually invokes -- never got
that model. These tests keep the two from diverging again.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_RUNNER = _REPO / ".codex" / "skills" / "autonomous-rca-governance" / "scripts" / "rca_runner.py"

_spec = importlib.util.spec_from_file_location("rca_runner", _RUNNER)
rca = importlib.util.module_from_spec(_spec)
sys.modules["rca_runner"] = rca
_spec.loader.exec_module(rca)  # type: ignore[union-attr]


# --------------------------------------------------------------------------- #
# The classifier: three states, because there are three
# --------------------------------------------------------------------------- #


def test_a_clean_exit_is_success():
    assert rca._classify_outcome(0, "") == rca.OUTCOME_SUCCESS


def test_a_real_non_zero_exit_is_a_failure():
    """The check ran, looked, and found something. This must stay a FAILURE, or
    the fix for false reds would have created a false green."""
    assert rca._classify_outcome(1, "contract drift: table users missing column x") == (
        rca.OUTCOME_FAILURE
    )


@pytest.mark.parametrize(
    "stderr",
    [
        "ModuleNotFoundError: No module named 'asyncpg'",
        "Traceback (most recent call last):\n  ...\nModuleNotFoundError: No module named 'dotenv'",
        "ImportError: cannot import name 'foo' from 'bar'",
    ],
)
def test_an_import_error_is_unevaluable_not_a_domain_failure(stderr):
    """THE regression. Both real ones: asyncpg on the db guard, dotenv on the
    semantic verifier."""
    assert rca._classify_outcome(1, stderr) == rca.OUTCOME_UNEVALUABLE


@pytest.mark.parametrize("code", [124, 126, 127])
def test_a_missing_unrunnable_or_timed_out_command_is_unevaluable(code):
    assert rca._classify_outcome(code, "") == rca.OUTCOME_UNEVALUABLE


def test_a_check_that_runs_forever_times_out_instead_of_hanging_the_runner():
    """Bounding matters MORE after the interpreter fix than before it. These
    checks used to die instantly at import, so "fast" was a symptom, not a
    property; now that they really run, one reaching a live database can hang,
    and an RCA runner that never returns cannot be used in a loop at all."""
    result = rca._run([sys.executable, "-c", "import time; time.sleep(30)"], timeout=2)
    assert result["outcome"] == rca.OUTCOME_UNEVALUABLE
    assert "timed out" in result["stderr"]


def test_every_check_is_bounded():
    """A default of None would put the bound back at 'forever' for any call site
    that forgets to pass one."""
    import inspect

    default = inspect.signature(rca._run).parameters["timeout"].default
    assert isinstance(default, int) and default > 0


@pytest.mark.parametrize("code", [143, 137, 130, -15, -9])
def test_a_process_killed_by_a_signal_is_unevaluable(code):
    """143 is the measured one: a watchdog SIGTERMed a child of `bin/hushh ci`
    and the runner called it `core_ci_failed`. A killed process did not choose
    its exit code, so that code is not evidence about anything."""
    assert rca._classify_outcome(code, "Terminated: 15") == rca.OUTCOME_UNEVALUABLE


def test_a_command_that_does_not_exist_at_all_is_unevaluable_not_a_crash():
    result = rca._run(["definitely-not-a-real-binary-9d3f1"])
    assert result["outcome"] == rca.OUTCOME_UNEVALUABLE
    assert result["ok"] is False


def test_a_child_that_dies_at_import_is_unevaluable_end_to_end(tmp_path):
    """Runs a REAL child process that fails the same way the db guard did, rather
    than asserting on a hand-made dict. A refactor that changes how stderr is
    captured, or which interpreter is chosen, still has to keep this true."""
    script = tmp_path / "dies_at_import.py"
    script.write_text("import a_module_that_does_not_exist_x7\n")
    result = rca._run([sys.executable, str(script)])
    assert result["returncode"] != 0
    assert result["outcome"] == rca.OUTCOME_UNEVALUABLE, result["stderr"]


# --------------------------------------------------------------------------- #
# The verdict: unevaluable is neither healthy nor blocked
# --------------------------------------------------------------------------- #


def test_nothing_wrong_and_nothing_skipped_is_healthy():
    verdict = rca._verdict([], [])
    assert verdict["status"] == "healthy"
    assert verdict["can_push_branch"] is True


def test_a_real_blocking_classification_blocks():
    verdict = rca._verdict(["db_contract_drift"], [])
    assert verdict["status"] == "blocked"
    assert verdict["can_push_branch"] is False


def test_an_unevaluable_check_never_reads_as_healthy():
    """A judge that answers green because it could not look is worse than no
    judge, because it is believed."""
    verdict = rca._verdict(
        [],
        [
            {
                "check": "db_contract",
                "would_have_been_classified": "x",
                "returncode": "1",
                "reason": "no module named asyncpg",
            }
        ],
    )
    assert verdict["status"] == "unevaluable"
    assert verdict["can_push_branch"] is False


def test_an_unevaluable_check_is_not_reported_as_a_domain_failure():
    """The other half, and the one that caused the incident. `unevaluable` must
    stay OUT of blocking_classifications, or an operator is sent to fix a
    database contract because a package was missing."""
    verdict = rca._verdict(
        [],
        [
            {
                "check": "db_contract",
                "would_have_been_classified": "db_contract_drift",
                "returncode": "1",
                "reason": "no module named asyncpg",
            }
        ],
    )
    assert verdict["blocking_classifications"] == []
    assert "db_contract_drift" not in verdict["blocking_classifications"]


def test_the_next_action_names_the_check_and_the_reason_not_the_domain():
    """The old report said "Resolve DB release-contract drift" for a missing
    package. What an operator reads has to point at the actual defect."""
    actions = rca._build_next_actions(
        [],
        [
            {
                "check": "db_contract",
                "would_have_been_classified": "db_contract_drift",
                "returncode": "1",
                "reason": "ModuleNotFoundError: No module named 'asyncpg'",
            }
        ],
    )
    joined = " ".join(actions)
    assert "db_contract" in joined
    assert "asyncpg" in joined
    assert "could not run" in joined
    assert "Resolve DB release-contract drift" not in joined


def test_the_rendered_text_reports_skipped_checks_separately():
    text = rca._render_text(
        {
            "surface": "uat",
            "status": "unevaluable",
            "can_push_branch": False,
            "blocking_classifications": [],
            "advisory_classifications": [],
            "unevaluable_checks": [
                {
                    "check": "db_contract",
                    "would_have_been_classified": "db_contract_drift",
                    "returncode": "1",
                    "reason": "No module named 'asyncpg'",
                }
            ],
        }
    )
    assert "NOT EVALUATED" in text
    assert "db_contract" in text
    # It must still say what it WOULD have been blamed for, so the connection to
    # the old, wrong verdict is legible to whoever saw it.
    assert "db_contract_drift" in text


# --------------------------------------------------------------------------- #
# The interpreter: the proximate cause
# --------------------------------------------------------------------------- #


def test_the_runner_prefers_an_interpreter_that_has_the_repo_dependencies():
    """`sys.executable` is whatever launched the runner, and on an operator's
    machine that is a python3 without asyncpg or python-dotenv. Measured: both
    verifier scripts fail under it and both succeed under the project venv."""
    cmd, source = rca._project_python()
    assert cmd
    if (_REPO / "consent-protocol" / ".venv" / "bin" / "python").exists():
        assert source == "consent-protocol/.venv"
        assert cmd[0].endswith("consent-protocol/.venv/bin/python")


def test_the_report_says_which_interpreter_was_used():
    """A run made with the fallback interpreter is worth less than one made with
    the right one, and the report has to let a reader tell them apart."""
    _, source = rca._project_python()
    assert source
    text = rca._render_text(
        {
            "surface": "runtime",
            "status": "healthy",
            "can_push_branch": True,
            "blocking_classifications": [],
            "advisory_classifications": [],
            "unevaluable_checks": [],
            "context": {"interpreter": source},
        }
    )
    assert "Interpreter:" in text


# --------------------------------------------------------------------------- #
# No call site may go back to reading the raw integer
# --------------------------------------------------------------------------- #


def test_no_surface_classifies_straight_off_a_returncode():
    """The shape of the original bug, banned. Every classification must go
    through `outcome`, so the three-state distinction cannot be dropped by an
    edit that looks locally reasonable."""
    src = _RUNNER.read_text()
    offenders = [
        line.strip()
        for line in src.splitlines()
        if '["returncode"] != 0' in line or "['returncode'] != 0" in line
    ]
    assert not offenders, (
        "a call site is classifying directly off the exit code again, which "
        f"cannot tell 'it is broken' from 'it never ran': {offenders}"
    )


def test_the_taxonomy_documents_the_unevaluable_state():
    """The skill's own taxonomy list is what an agent reads to decide what a
    verdict means. A class the runner can emit and the doc does not list is how
    the runner and the deploy gate drifted apart in the first place."""
    skill = _REPO / ".codex" / "skills" / "autonomous-rca-governance" / "SKILL.md"
    assert rca.CHECK_UNEVALUABLE in skill.read_text(), (
        f"{skill} does not document {rca.CHECK_UNEVALUABLE}"
    )


# --------------------------------------------------------------------------- #
# Resume safety: a report path that evaporates is not an artifact
# --------------------------------------------------------------------------- #


def test_reports_are_written_somewhere_that_still_exists_afterwards():
    """The runner printed paths under a TemporaryDirectory, so the text output
    named a file and opening it raised FileNotFoundError the moment the process
    exited. The skill's deliverable is a resume-safe artifact for the next agent;
    a path that evaporates is the opposite of one."""
    src = _RUNNER.read_text()
    assert "tempfile" not in src, (
        "sub-reports are back inside a TemporaryDirectory, so every path the "
        "runner prints is dead before anyone can read it"
    )
    assert "DEFAULT_SCRATCH" in src


def test_the_default_artifact_location_is_gitignored():
    """Durable must not mean committed."""
    import subprocess

    target = rca.DEFAULT_SCRATCH / "uat" / "rca.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    check = subprocess.run(  # noqa: S603 - fixed argv, no shell, no user input
        ["git", "check-ignore", str(target)], cwd=str(_REPO), capture_output=True, text=True
    )
    assert check.returncode == 0, f"{target} is not gitignored; RCA output would be committable"


# --------------------------------------------------------------------------- #
# Replay of the actual incident
# --------------------------------------------------------------------------- #

# Verbatim stderr captured from the 2026-08-29 run that produced the false
# `db_contract_drift`. Replaying the real bytes rather than a paraphrase means a
# future change to the detection logic has to keep working against what these
# tools genuinely print, not against what we remember them printing.
_REAL_DB_STDERR = (
    "Traceback (most recent call last):\n"
    '  File "/Users/x/hushh-research/scripts/ops/db_migration_release_guard.py", '
    "line 27, in <module>\n"
    "    import asyncpg\n"
    "ModuleNotFoundError: No module named 'asyncpg'\n"
)
_REAL_SEMANTIC_STDERR = (
    "Traceback (most recent call last):\n"
    '  File "/Users/x/hushh-research/consent-protocol/scripts/uat_kai_regression_smoke.py", '
    "line 45, in <module>\n"
    "    from dotenv import dotenv_values\n"
    "ModuleNotFoundError: No module named 'dotenv'\n"
)


def test_the_real_db_guard_crash_is_not_database_drift():
    """The exact bytes that produced "Resolve DB release-contract drift"."""
    assert rca._classify_outcome(1, _REAL_DB_STDERR) == rca.OUTCOME_UNEVALUABLE


def test_the_real_semantic_verifier_crash_is_not_silence():
    """The other half of the same run. This one produced NO classification at
    all, so a crashed release verifier was indistinguishable from a clean one --
    the more dangerous of the two failures, because nobody goes looking."""
    assert rca._classify_outcome(1, _REAL_SEMANTIC_STDERR) == rca.OUTCOME_UNEVALUABLE


def test_replaying_the_incident_yields_unevaluable_not_blocked():
    """End-to-end over the recorded run: both checks unevaluable, nothing
    verified, and NOT a single domain classification invented from it."""
    unevaluable: list[dict[str, str]] = []
    for check, stderr, would_have_been in (
        ("db_contract", _REAL_DB_STDERR, "db_contract_drift"),
        ("semantic", _REAL_SEMANTIC_STDERR, "runtime_behavior_failed"),
    ):
        result = {"returncode": 1, "stderr": stderr, "outcome": rca._classify_outcome(1, stderr)}
        assert result["outcome"] == rca.OUTCOME_UNEVALUABLE
        rca._note_unevaluable(
            unevaluable, check=check, result=result, would_have_been=would_have_been
        )

    verdict = rca._verdict([], unevaluable)
    assert verdict["status"] == "unevaluable"
    assert verdict["blocking_classifications"] == []
    assert verdict["can_push_branch"] is False
    assert {entry["check"] for entry in verdict["unevaluable_checks"]} == {
        "db_contract",
        "semantic",
    }
    # And the operator is pointed at the real defect.
    actions = " ".join(rca._build_next_actions([], unevaluable))
    assert "asyncpg" in actions and "dotenv" in actions


# --------------------------------------------------------------------------- #
# The gap in the first version of this fix
# --------------------------------------------------------------------------- #


def test_the_interpreter_reaches_checks_that_go_through_a_shell_script():
    """The first version of this fix did NOT fix the check that started it.

    Every other check takes the resolved interpreter as argv[0], but the DB
    contract check shells out to `verify_runtime_db_contract.sh`, which invoked a
    hardcoded `python3`. So the runner picked the project venv for parity,
    semantic, runtime and ci, and the one check that actually failed went on
    dying at `import asyncpg`. The runner became honest about the failure without
    curing it -- a real improvement, and not the same thing as a fix.

    An adversarial review caught it. This test is what makes the catch durable.
    """
    src = _RUNNER.read_text()
    assert 'db_env["PYTHON"]' in src, (
        "the db check goes through bash, so the interpreter must travel as an "
        "environment variable or the fix does not reach it"
    )
    assert "_run(db_cmd, env=db_env)" in src


def test_the_db_contract_script_accepts_an_interpreter():
    """The other half of the same seam. Hardcoding `python3` here is what made
    the runner's choice unreachable."""
    script = _REPO / "scripts" / "ops" / "verify_runtime_db_contract.sh"
    body = script.read_text()
    assert 'PYTHON="${PYTHON:-python3}"' in body
    assert '"$PYTHON" "$REPO_ROOT/scripts/ops/db_migration_release_guard.py"' in body
    assert 'python3 "$REPO_ROOT/scripts/ops/db_migration_release_guard.py"' not in body, (
        "the release guard is back on a hardcoded interpreter"
    )


def test_the_release_guard_actually_imports_under_the_chosen_interpreter():
    """Runs the real guard under the real resolved interpreter. Everything above
    is about plumbing; this is the question the plumbing exists to answer."""
    import subprocess

    cmd, _ = rca._project_python()
    guard = _REPO / "scripts" / "ops" / "db_migration_release_guard.py"
    result = subprocess.run(  # noqa: S603 - fixed argv, no shell, no user input
        [*cmd, str(guard), "--help"], cwd=str(_REPO), capture_output=True, text=True, timeout=120
    )
    assert result.returncode == 0, (
        f"the release guard cannot run under the interpreter the RCA runner "
        f"chooses: {result.stderr[-400:]}"
    )


# --------------------------------------------------------------------------- #
# The bug the durability fix introduced
# --------------------------------------------------------------------------- #


def test_stale_reports_are_cleared_before_the_children_run():
    """Making the scratch directory durable introduced a NEW way to lie, and it
    fired on the first live re-run: the parity check timed out (exit 124), the
    runner loaded a report written 21 minutes earlier by a different invocation,
    read its `status: healthy`, and reported the surface healthy with
    can_push_branch True. A check that never ran had inherited a previous run's
    verdict -- the same defect this file exists to remove, reintroduced by the
    fix for it.

    Clearing the paths first is what makes "the file exists afterwards" mean
    "this run wrote it", which is the only reading that is safe.
    """
    src = _RUNNER.read_text()
    assert "_clear_stale_reports(" in src
    assert "def _clear_stale_reports(" in src


def test_clearing_removes_a_previous_runs_report(tmp_path):
    stale = tmp_path / "uat-runtime-parity.json"
    stale.write_text('{"status": "healthy", "classifications": []}')
    assert stale.exists()
    rca._clear_stale_reports(stale)
    assert not stale.exists()


def test_clearing_tolerates_a_path_that_was_never_written(tmp_path):
    rca._clear_stale_reports(tmp_path / "never-existed.json")  # must not raise


def test_an_unevaluable_check_is_reported_even_when_a_report_file_exists():
    """The precise shape of the regression. The old guard was
    `unevaluable AND not parity_report`, so the mere presence of a file
    suppressed the "did not run" verdict. The epistemic question has to be
    settled BEFORE the report is mined, not gated on it."""
    src = _RUNNER.read_text()
    assert "OUTCOME_UNEVALUABLE and not parity_report" not in src, (
        "the existence of a report file can suppress a 'did not run' verdict again"
    )
    # And the ordering that replaced it: unevaluable is checked first.
    unevaluable_at = src.index('check="parity"')
    mined_at = src.index('parity_report.get("classifications")')
    assert unevaluable_at < mined_at, (
        "the parity report is mined before the check's outcome is settled"
    )


def test_a_timed_out_check_cannot_produce_a_healthy_surface():
    """End-to-end over the verdict logic, stated as the sentence that was false:
    a surface with a timed-out check is not healthy and is not pushable."""
    timed_out = {"returncode": 124, "stderr": "timed out after 900s"}
    assert rca._classify_outcome(124, "timed out after 900s") == rca.OUTCOME_UNEVALUABLE
    unevaluable: list[dict[str, str]] = []
    rca._note_unevaluable(
        unevaluable,
        check="parity",
        result={**timed_out, "outcome": rca.OUTCOME_UNEVALUABLE},
        would_have_been="runtime_mount_missing",
    )
    verdict = rca._verdict([], unevaluable)
    assert verdict["status"] != "healthy"
    assert verdict["can_push_branch"] is False

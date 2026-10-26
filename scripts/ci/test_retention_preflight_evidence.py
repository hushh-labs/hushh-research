"""Only the source-pinned pre-mutation checkpoint guard may explain a missing save."""

import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO

import retention_preflight_evidence as evidence


def fixture():
    run = {
        "id": 100,
        "path": ".github/workflows/capacity-maintenance.yml",
        "head_branch": "main",
        "event": "repository_dispatch",
        "head_sha": evidence.AUDITED_SOURCE_SHA,
        "run_attempt": 1,
        "status": "completed",
        "conclusion": "failure",
        "repository": {"full_name": "org/repo"},
        "head_repository": {"full_name": "org/repo"},
    }
    job = {
        "id": 200,
        "run_id": run["id"],
        "run_attempt": 1,
        "head_sha": run["head_sha"],
        "name": evidence._JOB,
        "status": "completed",
        "conclusion": "failure",
        "steps": [
            {
                "number": index,
                "name": name,
                "status": "completed",
                "conclusion": "failure"
                if name == evidence._PREPARE
                else "skipped"
                if name == evidence._SAVE
                else "success",
            }
            for index, name in enumerate(evidence._STEP_NAMES, 1)
        ],
    }
    lines = []
    for step in evidence._STEP_NAMES:
        if step == evidence._SAVE:
            continue
        contents = ["Synthetic successful prerequisite"]
        if step == evidence._CHECKOUT:
            contents = [evidence._CHECKOUT_COMMAND, evidence.AUDITED_SOURCE_SHA]
        elif step == evidence._PREPARE:
            contents = [
                "##[group]Run set -euo pipefail",
                *(f"^[[36;1m{line}^[[0m" for line in evidence._PREPARE_COMMAND),
                "shell: /usr/bin/bash -e {0}",
                "env:",
                "  PRIVATE_CANARY: PRIVATE_SYNTHETIC_SENTINEL",
                "  APPLY: true",
                "##[endgroup]",
                evidence._DIAGNOSTIC,
                evidence._EXIT,
            ]
        lines.extend(
            f"{evidence._JOB}\t{step}\t2026-10-26T21:40:22.0000000Z {content}"
            for content in contents
        )
    return run, job, "\n".join(lines) + "\n", dict(evidence.AUDITED_SOURCE_BLOBS)


class GuardOnlyEvidenceTest(unittest.TestCase):
    def qualify(self, run, job, log, blobs, *, environment="uat", repository="org/repo"):
        return evidence.qualify_guard_only_run(repository, environment, run, job, log, blobs)

    def test_exact_guard_failure_returns_identifiers_without_private_content(self):
        output, errors = StringIO(), StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            proof = self.qualify(*fixture())
        self.assertEqual(
            proof,
            {
                "schema": "retention_guard_only_failure.v1",
                "environment": "uat",
                "run_id": 100,
                "job_id": 200,
                "run_attempt": 1,
                "source_sha": evidence.AUDITED_SOURCE_SHA,
                "script_blob": evidence.AUDITED_SOURCE_BLOBS[
                    "scripts/ci/uat-retention-maintenance.py"
                ],
                "workflow_blob": evidence.AUDITED_SOURCE_BLOBS[
                    ".github/workflows/capacity-maintenance.yml"
                ],
            },
        )
        self.assertNotIn("PRIVATE", json.dumps(proof))
        self.assertEqual(output.getvalue() + errors.getvalue(), "")

    def test_unknown_failure_and_older_worker_readiness_do_not_qualify(self):
        run, job, log, blobs = fixture()
        for diagnostic in (
            "Hosted maintenance stopped: Drive worker is not ready",
            "Hosted maintenance stopped: provider outcome is unresolved",
            evidence._DIAGNOSTIC + " additional private context",
            "Unknown failure",
        ):
            with self.subTest(diagnostic=diagnostic):
                self.assertIsNone(
                    self.qualify(run, job, log.replace(evidence._DIAGNOSTIC, diagnostic), blobs)
                )

    def test_source_and_checkout_pins_are_independently_required(self):
        for defect in (
            "run_sha",
            "job_sha",
            "checkout_sha",
            "checkout_adjacency",
            "duplicate_checkout",
            "missing_script",
            "script_blob",
            "workflow_blob",
        ):
            with self.subTest(defect=defect):
                run, job, log, blobs = fixture()
                if defect in {"run_sha", "job_sha"}:
                    (run if defect == "run_sha" else job)["head_sha"] = "a" * 40
                elif defect == "checkout_sha":
                    log = log.replace(evidence.AUDITED_SOURCE_SHA, "a" * 40)
                elif defect == "checkout_adjacency":
                    log = log.replace(evidence._CHECKOUT_COMMAND, evidence._CHECKOUT_COMMAND + "\n")
                elif defect == "duplicate_checkout":
                    line = next(
                        line for line in log.splitlines() if evidence._CHECKOUT_COMMAND in line
                    )
                    log = log.replace(line, line + "\n" + line)
                elif defect == "missing_script":
                    blobs.pop("scripts/ci/uat-retention-maintenance.py")
                else:
                    path = (
                        "scripts/ci/uat-retention-maintenance.py"
                        if defect == "script_blob"
                        else ".github/workflows/capacity-maintenance.yml"
                    )
                    blobs[path] = "a" * 40
                self.assertIsNone(self.qualify(run, job, log, blobs))

    def test_attempt_identity_steps_and_repo_are_fail_closed(self):
        for defect in (
            "wrong_repo",
            "fork",
            "branch",
            "workflow",
            "event",
            "run_id",
            "run_attempt",
            "job_attempt",
            "matching_retry",
            "boolean_attempt",
            "missing_prerequisite",
            "duplicate_prerequisite",
            "duplicate_number",
            "unknown_failure",
            "save_success",
            "prerequisite_failure",
        ):
            with self.subTest(defect=defect):
                run, job, log, blobs = fixture()
                if defect == "wrong_repo":
                    run["repository"]["full_name"] = "other/repo"
                elif defect == "fork":
                    run["head_repository"]["full_name"] = "other/repo"
                elif defect == "branch":
                    run["head_branch"] = "feature"
                elif defect == "workflow":
                    run["path"] = ".github/workflows/other.yml"
                elif defect == "event":
                    run["event"] = "pull_request"
                elif defect == "run_id":
                    job["run_id"] = 101
                elif defect == "run_attempt":
                    run["run_attempt"] = 2
                elif defect == "job_attempt":
                    job["run_attempt"] = 2
                elif defect == "matching_retry":
                    run["run_attempt"] = job["run_attempt"] = 2
                elif defect == "boolean_attempt":
                    run["run_attempt"] = job["run_attempt"] = True
                elif defect == "missing_prerequisite":
                    job["steps"].pop(1)
                elif defect == "duplicate_prerequisite":
                    job["steps"][2]["name"] = job["steps"][1]["name"]
                elif defect == "duplicate_number":
                    job["steps"][2]["number"] = job["steps"][1]["number"]
                elif defect == "unknown_failure":
                    job["steps"].append(
                        {
                            "name": "Unknown mutation",
                            "status": "completed",
                            "conclusion": "failure",
                            "number": 20,
                        }
                    )
                elif defect == "save_success":
                    job["steps"][7]["conclusion"] = "success"
                else:
                    job["steps"][5]["conclusion"] = "failure"
                self.assertIsNone(self.qualify(run, job, log, blobs))

    def test_invocation_terminal_diagnostics_and_log_bounds_are_required(self):
        run, job, log, blobs = fixture()
        candidates = [
            None,
            "",
            "x" * (evidence.MAX_LOG_BYTES + 1),
            log.replace("--environment uat", "--environment production"),
            log.replace("  APPLY: true", "  APPLY: false"),
            log.replace(evidence._EXIT, "##[error]Process completed with exit code 2."),
            log.replace(
                evidence._DIAGNOSTIC, "PRIVATE_SYNTHETIC_SENTINEL\n" + evidence._DIAGNOSTIC
            ),
            log.replace(evidence._DIAGNOSTIC, evidence._DIAGNOSTIC + "\n" + evidence._DIAGNOSTIC),
            log.replace(evidence._JOB, "Foreign job"),
        ]
        output, errors = StringIO(), StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            for candidate in candidates:
                self.assertIsNone(self.qualify(run, job, candidate, blobs))
            self.assertIsNone(self.qualify(run, job, log, blobs, environment="production"))
        self.assertEqual(output.getvalue() + errors.getvalue(), "")


if __name__ == "__main__":
    unittest.main()

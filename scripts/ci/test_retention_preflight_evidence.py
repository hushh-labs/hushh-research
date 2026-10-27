"""Only the source-pinned pre-mutation checkpoint guard may explain a missing save."""

import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta
from io import StringIO

import retention_preflight_evidence as evidence
from retention_publication_cases import legacy_fixture, raw_fixture


def fixture():
    run, job, _ = legacy_fixture()
    run.update(
        id=100,
        event="repository_dispatch",
        head_sha=evidence.AUDITED_SOURCE_SHA,
        repository={"full_name": "org/repo"},
        head_repository={"full_name": "org/repo"},
    )
    job.update(id=200, run_id=100, head_sha=run["head_sha"])
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
    def qualify(
        self, run, job, log, blobs, *, environment="uat", repository="org/repo"
    ):
        return evidence.qualify_guard_only_run(
            repository, environment, run, job, log, blobs
        )

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
                    self.qualify(
                        run, job, log.replace(evidence._DIAGNOSTIC, diagnostic), blobs
                    )
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
                    log = log.replace(
                        evidence._CHECKOUT_COMMAND, evidence._CHECKOUT_COMMAND + "\n"
                    )
                elif defect == "duplicate_checkout":
                    line = next(
                        line
                        for line in log.splitlines()
                        if evidence._CHECKOUT_COMMAND in line
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

    def test_pinned_intervening_sources_still_require_matching_checkout_and_blobs(self):
        for source in evidence.AUDITED_SOURCE_SHAS:
            with self.subTest(source=source):
                run, job, log, blobs = fixture()
                run["head_sha"] = job["head_sha"] = source
                if source != evidence.AUDITED_SOURCE_SHA:
                    self.assertIsNone(self.qualify(run, job, log, blobs))
                log = log.replace(evidence.AUDITED_SOURCE_SHA, source)
                blobs = evidence.expected_source_blobs(source)
                self.assertEqual(
                    self.qualify(run, job, log, blobs)["source_sha"], source
                )
                self.assertIsNone(self.qualify(run, job, log, {}))

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
                evidence._DIAGNOSTIC,
                "PRIVATE_SYNTHETIC_SENTINEL\n" + evidence._DIAGNOSTIC,
            ),
            log.replace(
                evidence._DIAGNOSTIC, evidence._DIAGNOSTIC + "\n" + evidence._DIAGNOSTIC
            ),
            log.replace(evidence._JOB, "Foreign job"),
        ]
        output, errors = StringIO(), StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            for candidate in candidates:
                self.assertIsNone(self.qualify(run, job, candidate, blobs))
            self.assertIsNone(
                self.qualify(run, job, log, blobs, environment="production")
            )
        self.assertEqual(output.getvalue() + errors.getvalue(), "")


class RawEvidenceTest(unittest.TestCase):
    def qualify(self, run, job, log, blobs):
        return evidence.qualify_guard_only_run("org/repo", "uat", run, job, log, blobs)

    def test_raw_job_log_qualifies_without_cli_step_labels_or_private_output(self):
        output, errors = StringIO(), StringIO()
        for source in evidence.AUDITED_SOURCE_SHAS:
            run, job, log, blobs = raw_fixture()
            run["head_sha"] = job["head_sha"] = source
            log = log.replace(evidence.AUDITED_SOURCE_SHA, source)
            blobs = evidence.expected_source_blobs(source)
            # Raw logs can contain real ANSI colors, CRLF and tabs in env values.
            log = log.replace("^[[", "\x1b[").replace("\n", "\r\n")
            log = log.replace(
                "PRIVATE_SYNTHETIC_SENTINEL", "PRIVATE\tSYNTHETIC_SENTINEL"
            )
            with redirect_stdout(output), redirect_stderr(errors):
                proof = self.qualify(run, job, log, blobs)
            self.assertEqual(proof["source_sha"], source)
            self.assertNotIn("PRIVATE", json.dumps(proof))
            self.assertTrue(evidence.raw_log_matches(log, job, source))
        self.assertEqual(output.getvalue() + errors.getvalue(), "")

    def test_explicit_source_profiles_cannot_be_substituted_or_extended(self):
        new_source = "dce2e32866b6ff7369b58e6695b599e57c946ad7"
        new_profile = evidence.expected_source_blobs(new_source)
        self.assertNotEqual(new_profile, evidence.AUDITED_SOURCE_BLOBS)
        self.assertEqual(
            new_profile["scripts/ci/retention_preflight_evidence.py"],
            "55e824a5aa41801dadbef3ec12236291394eb00b",
        )
        for source in evidence.AUDITED_SOURCE_SHAS:
            with self.subTest(source=source):
                run, job, log, _ = raw_fixture()
                run["head_sha"] = job["head_sha"] = source
                log = log.replace(evidence.AUDITED_SOURCE_SHA, source)
                wrong_profile = (
                    evidence.AUDITED_SOURCE_BLOBS
                    if source == new_source
                    else new_profile
                )
                self.assertIsNone(self.qualify(run, job, log, wrong_profile))
        for unknown in (None, [], "a" * 40):
            self.assertIsNone(evidence.expected_source_blobs(unknown))
        run, job, log, blobs = raw_fixture()
        run["head_sha"] = job["head_sha"] = "a" * 40
        log = log.replace(evidence.AUDITED_SOURCE_SHA, "a" * 40)
        self.assertIsNone(self.qualify(run, job, log, blobs))
        new_profile.clear()
        self.assertEqual(
            evidence.expected_source_blobs(new_source)[
                "scripts/ci/uat-retention-maintenance.py"
            ],
            "34050aa25db19afe6004d97fdc76bda7de9c6471",
        )

    def test_raw_checkout_and_prepare_require_api_windows(self):
        for step_name in (evidence._CHECKOUT, evidence._PREPARE):
            for defect in ("missing_start", "invalid_end", "reversed", "outside"):
                with self.subTest(step=step_name, defect=defect):
                    run, job, log, blobs = raw_fixture()
                    step = next(
                        item for item in job["steps"] if item["name"] == step_name
                    )
                    if defect == "missing_start":
                        step.pop("started_at")
                    elif defect == "invalid_end":
                        step["completed_at"] = "2026-99-99T00:00:00Z"
                    elif defect == "reversed":
                        step["started_at"], step["completed_at"] = (
                            step["completed_at"],
                            step["started_at"],
                        )
                    else:
                        step["started_at"] = step["completed_at"] = (
                            "2027-01-01T00:00:00Z"
                        )
                    self.assertIsNone(self.qualify(run, job, log, blobs))

    def test_step_end_rounding_allows_fractional_second_only(self):
        for milliseconds, allowed in ((500, True), (1000, False)):
            with self.subTest(milliseconds=milliseconds):
                run, job, log, blobs = raw_fixture()
                step = next(
                    item for item in job["steps"] if item["name"] == evidence._PREPARE
                )
                at = datetime.fromisoformat(
                    step["completed_at"].replace("Z", "+00:00")
                ) + timedelta(milliseconds=milliseconds)
                rewritten = []
                for line in log.splitlines():
                    if evidence._DIAGNOSTIC in line or evidence._EXIT in line:
                        line = (
                            at.isoformat().replace("+00:00", "Z")
                            + " "
                            + line.split(" ", 1)[1]
                        )
                    rewritten.append(line)
                self.assertEqual(
                    self.qualify(run, job, "\n".join(rewritten), blobs) is not None,
                    allowed,
                )

    def test_raw_log_refuses_other_errors_mutations_and_ambiguous_checkout(self):
        for defect in (
            "older_worker_error",
            "extra_error",
            "private_diagnostic",
            "mutation_output",
            "duplicate_checkout",
            "wrong_sha",
            "wrong_command",
            "apply_false",
            "missing_exit",
            "malformed_timestamp",
        ):
            with self.subTest(defect=defect):
                run, job, log, blobs = raw_fixture()
                line = next(
                    line for line in log.splitlines() if evidence._DIAGNOSTIC in line
                )
                prefix = line.split(" ", 1)[0] + " "
                if defect == "older_worker_error":
                    log = log.replace(
                        evidence._DIAGNOSTIC,
                        "Hosted maintenance stopped: Drive worker is not ready",
                    )
                elif defect == "extra_error":
                    log = log.replace(
                        line, prefix + "##[error]Unknown mutation outcome\n" + line
                    )
                elif defect == "private_diagnostic":
                    log = log.replace(
                        evidence._DIAGNOSTIC,
                        evidence._DIAGNOSTIC + " PRIVATE_SYNTHETIC_SENTINEL",
                    )
                elif defect == "mutation_output":
                    log = log.replace(
                        line, prefix + "Unknown mutation completed\n" + line
                    )
                elif defect == "duplicate_checkout":
                    checkout = next(
                        line
                        for line in log.splitlines()
                        if evidence._CHECKOUT_COMMAND in line
                    )
                    log = log.replace(checkout, checkout + "\n" + checkout)
                elif defect == "wrong_sha":
                    log = log.replace(evidence.AUDITED_SOURCE_SHA, "a" * 40)
                elif defect == "wrong_command":
                    log = log.replace("--environment uat", "--environment production")
                elif defect == "apply_false":
                    log = log.replace("  APPLY: true", "  APPLY: false")
                elif defect == "missing_exit":
                    log = log.replace(evidence._EXIT, "")
                else:
                    log = log.replace(prefix, "2026-99-99T00:00:00Z ")
                self.assertIsNone(self.qualify(run, job, log, blobs))

    def test_raw_log_preserves_metadata_source_and_first_attempt_refusals(self):
        for defect in (
            "retry",
            "failed_auth",
            "unknown_step",
            "source_blob",
            "missing_log",
            "utf8_oversize",
        ):
            with self.subTest(defect=defect):
                run, job, log, blobs = raw_fixture()
                if defect == "retry":
                    run["run_attempt"] = job["run_attempt"] = 2
                elif defect == "failed_auth":
                    job["steps"][4]["conclusion"] = "failure"
                elif defect == "unknown_step":
                    job["steps"][4]["name"] = "Unknown cloud mutation"
                elif defect == "source_blob":
                    blobs["scripts/ci/uat-retention-maintenance.py"] = "a" * 40
                elif defect == "missing_log":
                    log = None
                else:
                    log = "π" * (evidence.MAX_LOG_BYTES // 2 + 1)
                output, errors = StringIO(), StringIO()
                with redirect_stdout(output), redirect_stderr(errors):
                    self.assertIsNone(self.qualify(run, job, log, blobs))
                self.assertEqual(output.getvalue() + errors.getvalue(), "")


class TerminalSegmentTest(unittest.TestCase):
    def test_post_exit_output_is_never_discarded_before_pinned_report_boundary(self):
        from retention_publication_cases import legacy_fixture

        for digest in evidence.SOURCE_PROFILES:
            run, job, raw = legacy_fixture()
            if digest != evidence.AUDITED_SOURCE_BLOBS[evidence.OWNER]:
                raw = raw.replace(
                    b"Hosted maintenance stopped: Drive worker is not ready",
                    evidence._DIAGNOSTIC.encode(),
                )
            profile = {
                path: {"sha": sha, "size": size}
                for path, (sha, size) in evidence.SOURCE_PROFILES[digest].items()
            }

            def qualify(candidate):
                return evidence.qualify_preflight_run(
                    evidence.REPOSITORY,
                    "uat",
                    run,
                    job,
                    candidate.decode(),
                    profile,
                    profile[evidence.WORKFLOW],
                )

            self.assertIsNotNone(qualify(raw))
            for suffix in ("unexpected output", '{"guard_only_reconciliation":{}}'):
                changed = raw.replace(
                    evidence._EXIT.encode(),
                    (evidence._EXIT + "\n2026-10-27T00:00:07Z " + suffix).encode(),
                )
                with self.subTest(profile=digest, suffix=suffix):
                    self.assertIsNone(qualify(changed))
            self.assertIsNone(
                qualify(
                    raw.replace(
                        evidence.REPORT_GROUP.encode(),
                        b"##[group]Run unknown next step",
                    )
                )
            )

    def test_report_group_time_overlap_does_not_hide_prepare_output(self):
        from retention_publication_cases import legacy_fixture

        run, job, raw = legacy_fixture()
        job["steps"][8]["started_at"] = "2026-10-27T00:00:07Z"
        raw = raw.replace(b"2026-10-27T00:00:08Z ", b"2026-10-27T00:00:07.5Z ")
        profile = {
            path: {"sha": sha, "size": size}
            for path, (sha, size) in evidence.LEGACY_BLOBS.items()
        }
        self.assertIsNotNone(
            evidence.qualify_preflight_run(
                evidence.REPOSITORY,
                "uat",
                run,
                job,
                raw.decode(),
                profile,
                profile[evidence.WORKFLOW],
            )
        )


if __name__ == "__main__":
    unittest.main()

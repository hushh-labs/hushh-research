#!/usr/bin/env python3
"""Clock-bound production refusal evidence and its exact API witness."""

import copy
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import retention_preflight_evidence as base  # noqa: E402
import retention_production_clock_evidence as clock_evidence  # noqa: E402
import retention_production_evidence as evidence  # noqa: E402
from test_retention_production_evidence import clock_bound_fixture  # noqa: E402


class ClockBoundProductionEvidenceTest(unittest.TestCase):
    def test_only_the_nine_exact_clock_bound_history_rows_qualify(self):
        expected_ids = {
            41169264544,
            41164989434,
            41160506962,
            41155661193,
            41150358309,
            41144469026,
            41137901974,
            41130582923,
            41122398815,
        }
        self.assertEqual(set(clock_evidence.CLOCK_BOUND_RECORDS), expected_ids)
        for run_id in sorted(expected_ids):
            with self.subTest(run_id=run_id):
                record, run, job, log, blobs, clock = clock_bound_fixture(run_id)
                if run_id == 41150358309:
                    clock["run"].update(status="queued", conclusion=None)
                if run_id == 41164989434:
                    clock["run"].update(status="waiting", conclusion=None)
                if run_id == 41169264544:
                    clock["run"].update(status="waiting", conclusion=None)
                with mock.patch.dict(
                    clock_evidence.CLOCK_BOUND_RECORDS, {run_id: record}
                ):
                    proof = evidence.qualify_guard_run(
                        base.REPOSITORY,
                        "production",
                        run,
                        job,
                        log,
                        blobs,
                        blobs[base.WORKFLOW],
                        clock_proof=clock,
                    )
                self.assertEqual(
                    proof,
                    {
                        "run_id": run_id,
                        "attempt": 1,
                        "job_id": record.worker_job_id,
                        "checkout_sha": (
                            record.worker_checkout_sha or record.worker_head_sha
                        ),
                        "qualification": "no_provider_mutation",
                        "clock_run_id": record.clock.run_id,
                    },
                )
                if run_id == 41169264544:
                    wrong_title = {**run, "display_title": "Capacity Maintenance"}
                    with mock.patch.dict(
                        clock_evidence.CLOCK_BOUND_RECORDS, {run_id: record}
                    ):
                        self.assertIsNone(
                            evidence.qualify_guard_run(
                                base.REPOSITORY,
                                "production",
                                wrong_title,
                                job,
                                log,
                                blobs,
                                blobs[base.WORKFLOW],
                                clock_proof=clock,
                            )
                        )

    def test_event_head_and_actual_checkout_are_independent_exact_pins(self):
        run_id = 41160506962
        record, run, job, log, blobs, clock = clock_bound_fixture(run_id)
        self.assertEqual(
            record.worker_head_sha, "fd254cd2bfee31cd7af82fd8d2463d01028c2b38"
        )
        self.assertEqual(
            record.worker_checkout_sha, "8aba341a25c83082ecff40b926c48267b99ed764"
        )
        with mock.patch.dict(clock_evidence.CLOCK_BOUND_RECORDS, {run_id: record}):
            proof = evidence.qualify_guard_run(
                base.REPOSITORY,
                "production",
                run,
                job,
                log,
                blobs,
                blobs[base.WORKFLOW],
                clock_proof=clock,
            )
            self.assertEqual(proof["checkout_sha"], record.worker_checkout_sha)

            wrong_checkout = log.replace(
                f" {record.worker_checkout_sha}\n",
                f" {record.worker_head_sha}\n",
                1,
            )
            self.assertIsNone(
                evidence.qualify_guard_run(
                    base.REPOSITORY,
                    "production",
                    run,
                    job,
                    wrong_checkout,
                    blobs,
                    blobs[base.WORKFLOW],
                    clock_proof=clock,
                )
            )
            wrong_event_head = {**run, "head_sha": record.worker_checkout_sha}
            self.assertIsNone(
                evidence.qualify_guard_run(
                    base.REPOSITORY,
                    "production",
                    wrong_event_head,
                    job,
                    log,
                    blobs,
                    blobs[base.WORKFLOW],
                    clock_proof=clock,
                )
            )

    def test_clock_bound_proof_rejects_identity_source_attempt_and_log_changes(self):
        run_id = 41169264544
        record, run, job, log, blobs, clock = clock_bound_fixture(run_id)
        clock["run"].update(status="waiting", conclusion=None)
        diagnostic = sorted(evidence.DIAGNOSTICS)[0]
        cases = []
        wrong_run = copy.deepcopy(run)
        wrong_run["id"] += 1
        cases.append((wrong_run, job, log, blobs, clock))
        wrong_title = copy.deepcopy(run)
        wrong_title["display_title"] = "Capacity Maintenance"
        cases.append((wrong_title, job, log, blobs, clock))
        wrong_event = copy.deepcopy(run)
        wrong_event["event"] = "workflow_dispatch"
        cases.append((wrong_event, job, log, blobs, clock))
        wrong_job = copy.deepcopy(job)
        wrong_job["run_attempt"] = 2
        cases.append((run, wrong_job, log, blobs, clock))
        wrong_clock = copy.deepcopy(clock)
        wrong_clock["run"]["head_sha"] = "f" * 40
        cases.append((run, job, log, blobs, wrong_clock))
        wrong_clock_attempt = copy.deepcopy(clock)
        wrong_clock_attempt["run"]["run_attempt"] = 2
        cases.append((run, job, log, blobs, wrong_clock_attempt))
        wrong_clock_event = copy.deepcopy(clock)
        wrong_clock_event["run"]["event"] = "workflow_dispatch"
        cases.append((run, job, log, blobs, wrong_clock_event))
        wrong_check = copy.deepcopy(clock)
        wrong_check["check_job"]["conclusion"] = "failure"
        cases.append((run, job, log, blobs, wrong_check))
        wrong_wake = copy.deepcopy(clock)
        wrong_wake["wake_job"]["steps"][0]["conclusion"] = "skipped"
        cases.append((run, job, log, blobs, wrong_wake))
        wrong_source = {**blobs, base.OWNER: {"sha": "f" * 40, "size": 1}}
        cases.append((run, job, log, wrong_source, clock))
        wrong_save = copy.deepcopy(job)
        save = next(
            step for step in wrong_save["steps"] if step["name"] == evidence.SAVE
        )
        save["conclusion"] = "success"
        cases.append((run, wrong_save, log, blobs, clock))
        wrong_log = log.replace(
            diagnostic, "Hosted maintenance stopped: changed refusal"
        )
        cases.append((run, job, wrong_log, blobs, clock))
        wrong_clock_blob = copy.deepcopy(clock)
        wrong_clock_blob["workflow_blob"] = {"sha": "f" * 40, "size": 1}
        cases.append((run, job, log, blobs, wrong_clock_blob))
        with mock.patch.dict(clock_evidence.CLOCK_BOUND_RECORDS, {run_id: record}):
            for (
                changed_run,
                changed_job,
                changed_log,
                changed_blobs,
                changed_clock,
            ) in cases:
                with self.subTest(
                    run=changed_run["id"], job=changed_job["run_attempt"]
                ):
                    self.assertIsNone(
                        evidence.qualify_guard_run(
                            base.REPOSITORY,
                            "production",
                            changed_run,
                            changed_job,
                            changed_log,
                            changed_blobs,
                            changed_blobs[base.WORKFLOW],
                            clock_proof=changed_clock,
                        )
                    )

    def test_clock_witness_reads_bound_attempt_jobs_and_workflow_blob(self):
        record, _, _, _, _, expected = clock_bound_fixture(41150358309)
        jobs = [expected["check_job"], expected["wake_job"]]
        owner = mock.Mock()
        owner.api.side_effect = [
            expected["run"],
            {"total_count": len(jobs), "jobs": jobs},
        ]
        owner.command.return_value = json.dumps(expected["workflow_blob"])

        proof = clock_evidence.clock_witness(owner, base.REPOSITORY, record)

        self.assertEqual(proof, expected)
        self.assertEqual(
            [call.args[1] for call in owner.api.call_args_list],
            [
                f"runs/{record.clock.run_id}/attempts/1",
                f"runs/{record.clock.run_id}/jobs?filter=latest&per_page=100",
            ],
        )
        owner.command.assert_called_once_with(
            "gh",
            "api",
            f"repos/{base.REPOSITORY}/contents/{clock_evidence.CLOCK_WORKFLOW}?ref={record.clock.head_sha}",
            "--jq",
            "{sha,size}",
        )


class ClockBoundNumericProofTest(unittest.TestCase):
    def test_coerced_numeric_ids_and_attempts_are_rejected(self):
        run_id = 41169264544
        record, run, job, log, blobs, clock = clock_bound_fixture(run_id)
        clock["run"].update(status="waiting", conclusion=None)
        changes = (
            ("run", "id", float(run["id"])),
            ("run", "run_attempt", True),
            ("job", "id", float(job["id"])),
            ("job", "run_id", float(run["id"])),
            ("job", "run_attempt", True),
            ("clock run", "id", float(clock["run"]["id"])),
            ("clock run", "run_attempt", True),
            ("check job", "id", float(clock["check_job"]["id"])),
            ("check job", "run_id", float(clock["run"]["id"])),
            ("check job", "run_attempt", True),
            ("wake job", "id", float(clock["wake_job"]["id"])),
            ("wake job", "run_id", float(clock["run"]["id"])),
            ("wake job", "run_attempt", True),
        )
        targets = {
            "run": ("run",),
            "job": ("job",),
            "clock run": ("clock", "run"),
            "check job": ("clock", "check_job"),
            "wake job": ("clock", "wake_job"),
        }
        with mock.patch.dict(clock_evidence.CLOCK_BOUND_RECORDS, {run_id: record}):
            for owner, key, value in changes:
                changed_run, changed_job, changed_clock = (
                    copy.deepcopy(run),
                    copy.deepcopy(job),
                    copy.deepcopy(clock),
                )
                target = {
                    "run": changed_run,
                    "job": changed_job,
                    "clock": changed_clock,
                }
                for part in targets[owner]:
                    target = target[part]
                target[key] = value
                with self.subTest(
                    owner=owner, key=key, value_type=type(value).__name__
                ):
                    self.assertIsNone(
                        evidence.qualify_guard_run(
                            base.REPOSITORY,
                            "production",
                            changed_run,
                            changed_job,
                            log,
                            blobs,
                            blobs[base.WORKFLOW],
                            clock_proof=changed_clock,
                        )
                    )


if __name__ == "__main__":
    unittest.main()

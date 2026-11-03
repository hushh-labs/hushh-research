#!/usr/bin/env python3
"""Clock-bound production refusal evidence and its exact API witness."""

import copy
from dataclasses import replace
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import retention_preflight_evidence as base  # noqa: E402
import retention_production_clock_evidence as clock_evidence  # noqa: E402
import retention_production_clock_records as records  # noqa: E402
import retention_production_evidence as evidence  # noqa: E402
import retention_production_profile_evidence as profile_evidence  # noqa: E402
from test_retention_production_evidence import clock_bound_fixture  # noqa: E402


class _UnsafeProfileState(Exception):
    pass


class ClockBoundProductionEvidenceTest(unittest.TestCase):
    def test_only_the_recorded_clock_bound_history_rows_qualify(self):
        expected_ids = {
            41479685863,
            41489711406,
            41173362210,
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
                if run_id in {41169264544, 41173362210}:
                    clock["run"].update(status="waiting", conclusion=None)
                if run_id == 41173362210:
                    self.assertEqual(
                        record.worker_display_title,
                        "Capacity Maintenance tick (production)",
                    )
                    self.assertEqual(
                        record.clock.title,
                        "Capacity clock · repository_dispatch · run 466",
                    )
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
                if run_id in {41169264544, 41173362210}:
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


class ClockDispatchTimingTest(unittest.TestCase):
    def test_recorded_dispatch_overlap_requires_exact_times_and_success(self):
        run_id = 41479685863
        record, run, job, log, blobs, clock = clock_bound_fixture(run_id)
        date = record.worker_created_at[:11]
        created, completed = date + "20:30:05Z", date + "20:30:09Z"
        record = replace(
            record,
            worker_created_at=created,
            clock=replace(record.clock, wake_completed_at=completed),
        )
        run["created_at"] = created
        clock["wake_job"]["completed_at"] = completed
        with mock.patch.dict(clock_evidence.CLOCK_BOUND_RECORDS, {run_id: record}):

            def prove(proof):
                return evidence.qualify_guard_run(
                    base.REPOSITORY,
                    "production",
                    run,
                    job,
                    log,
                    blobs,
                    blobs[base.WORKFLOW],
                    clock_proof=proof,
                )

            self.assertIsNotNone(prove(clock))
            for change in ("tick", "completion", "failed"):
                broken = copy.deepcopy(clock)
                if change == "tick":
                    broken["wake_job"]["steps"][0]["completed_at"] = created
                elif change == "completion":
                    broken["wake_job"]["completed_at"] = date + "20:30:10Z"
                else:
                    broken["wake_job"]["steps"][0]["conclusion"] = "failure"
                with self.subTest(change=change):
                    self.assertIsNone(prove(broken))

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


class DynamicProductionProfileEvidenceTest(unittest.TestCase):
    def _case(self, *, ambiguous=False, truncated=False):
        record, worker, job, log, blobs, clock = clock_bound_fixture(41489711406)
        log = log.replace(
            sorted(evidence.DIAGNOSTICS)[0],
            "Hosted maintenance stopped: stage=publication_guard kind=safety_refusal",
        )
        worker.update(
            id=41499429997,
            display_title="Capacity Maintenance",
            created_at="2026-10-29T20:30:04Z",
        )
        job.update(id=125464392332, run_id=worker["id"])
        clock_run = clock["run"]
        clock_run.update(
            id=41489463865,
            display_title="Capacity clock · repository_dispatch · run 533",
            created_at="2026-10-29T20:29:00Z",
            status="waiting",
            conclusion=None,
        )
        check, wake = clock["check_job"], clock["wake_job"]
        check.update(id=125461775388, run_id=clock_run["id"])
        wake.update(id=125462697923, run_id=clock_run["id"])
        rearm = {
            "id": 125462750307,
            "run_id": clock_run["id"],
            "run_attempt": 1,
            "head_sha": clock_run["head_sha"],
            "head_branch": "main",
            "name": profile_evidence.REARM_NAME,
            "status": "waiting",
            "conclusion": None,
            "steps": [],
        }
        clock_rows = [clock_run]
        clock_jobs = {clock_run["id"]: [check, wake, rearm]}
        if ambiguous:
            other = copy.deepcopy(clock_run)
            other.update(id=41499139072, display_title="Capacity clock · repository_dispatch · run 534")
            extra_jobs = copy.deepcopy(clock_jobs[clock_run["id"]])
            for offset, item in enumerate(extra_jobs, start=1):
                item["id"] += offset * 100
                item["run_id"] = other["id"]
            clock_rows.append(other)
            clock_jobs[other["id"]] = extra_jobs
        owner = mock.Mock()
        owner.retention = mock.Mock(UnsafeState=_UnsafeProfileState)
        owner.compare_results = {}

        def api(_repository, endpoint):
            if endpoint.startswith("workflows/"):
                total = len(clock_rows) + int(truncated)
                return {"total_count": total, "workflow_runs": copy.deepcopy(clock_rows)}
            run_id = int(endpoint.split("/", 2)[1])
            if endpoint.endswith("/attempts/1"):
                return copy.deepcopy(clock_run if run_id == clock_run["id"] else clock_rows[1])
            rows = clock_jobs.get(run_id, [])
            total = len(rows) + int(truncated and run_id == clock_run["id"])
            return {"total_count": total, "jobs": copy.deepcopy(rows)}
        owner.api.side_effect = api

        def command(*args):
            endpoint = args[2]
            if "/compare/" in endpoint:
                comparison = endpoint.split("/compare/", 1)[1].split("?", 1)[0]
                ancestor, descendant = comparison.split("...", 1)
                override = owner.compare_results.get((ancestor, descendant))
                if override is not None:
                    return json.dumps(override)
                return json.dumps(
                    {
                        "status": "ahead",
                        "ahead_by": 1,
                        "behind_by": 0,
                        "total_commits": 1,
                        "commit_count": 1,
                    }
                )
            path_and_ref = endpoint.split("/contents/", 1)[1]
            path, ref = path_and_ref.split("?ref=", 1)
            if "capacity-maintenance-clock.yml" in path:
                value = clock["workflow_blob"]
            elif ref == clock_run["head_sha"]:
                profile = records.CLOCK_BOUND_SOURCE_PROFILES[profile_evidence.PROFILE_NAME]
                sha, size = profile[path]
                value = {"sha": sha, "size": size}
                value = clock.get("source_blobs", {}).get(path, value)
            else:
                value = blobs.get(path, {"sha": "f" * 40, "size": 1})
            return json.dumps(value)

        owner.command.side_effect = command
        return owner, record, worker, job, log, blobs, clock

    def _qualify(self, case, *, log=None, blobs=None):
        owner, _record, run, job, original_log, original_blobs, _clock = case
        return clock_evidence.qualify_publication(
            owner,
            base.REPOSITORY,
            run,
            job,
            run,
            log_reader=lambda *_: original_log if log is None else log,
            source_reader=lambda *_: original_blobs if blobs is None else blobs,
            actor_validator=lambda *_: None,
            workflow_path=base.WORKFLOW,
        )

    def test_unknown_run_qualifies_only_through_exact_profile_and_unique_clock(self):
        case = self._case()
        keys = set(clock_evidence.CLOCK_BOUND_RECORDS)
        proof = self._qualify(case)
        self.assertEqual(set(clock_evidence.CLOCK_BOUND_RECORDS), keys)
        self.assertEqual(
            proof,
            {
                "run_id": 41499429997,
                "attempt": 1,
                "job_id": 125464392332,
                "checkout_sha": profile_evidence.APPROVED_SOURCE_SHA,
                "qualification": "no_provider_mutation",
                "clock_run_id": 41489463865,
            },
        )

    def test_source_clock_job_log_and_api_uncertainty_refuse(self):
        cases = [
            ("ambiguous clock", self._case(ambiguous=True), None, None),
            ("truncated clock inventory", self._case(truncated=True), None, None),
        ]
        for label, case, log, blobs in cases:
            with self.subTest(label=label), self.assertRaises(_UnsafeProfileState):
                self._qualify(case, log=log, blobs=blobs)
        case = self._case()
        changed = copy.deepcopy(case[3])
        changed["name"] = "Unexpected production job"
        with self.assertRaises(_UnsafeProfileState):
            self._qualify((case[0], case[1], case[2], changed, *case[4:]))
        case = self._case()
        bad_blobs = {**case[5], base.OWNER: {"sha": "f" * 40, "size": 1}}
        self.assertIsNone(self._qualify(case, blobs=bad_blobs))
        bad_log = case[4].replace(
            "Hosted maintenance stopped: stage=publication_guard kind=safety_refusal",
            "Hosted maintenance stopped: altered",
        )
        self.assertIsNone(self._qualify(self._case(), log=bad_log))
        unapproved = self._case()
        unapproved[2]["head_sha"] = "f" * 40
        unapproved[0].api.reset_mock()
        self.assertIsNone(self._qualify(unapproved))
        unapproved[0].api.assert_not_called()

    def test_later_main_worker_accepts_exact_profile_and_historic_clock_blobs(self):
        case = self._case()
        owner, _record, worker, job, _log, _blobs, clock = case
        later_main = "3803d08f2f94c54e9cd6853ba423a269812cd068"
        older_clock = "97b4285ac2f00951606e57fe526a0428e0143d9c"
        worker["head_sha"] = later_main
        job["head_sha"] = later_main
        clock_run = clock["run"]
        clock_run["head_sha"] = older_clock
        for clock_job in (clock["check_job"], clock["wake_job"]):
            clock_job["head_sha"] = older_clock
        record, proof = profile_evidence.discover_record(
            owner, base.REPOSITORY, worker, job
        )
        self.assertEqual(record.worker_head_sha, later_main)
        self.assertEqual(record.worker_checkout_sha, later_main)
        self.assertEqual(proof["run"]["head_sha"], older_clock)
        self.assertTrue(
            any(
                "/compare/" in call.args[2]
                and profile_evidence.APPROVED_SOURCE_SHA in call.args[2]
                and later_main in call.args[2]
                for call in owner.command.call_args_list
            )
        )
        self.assertTrue(
            any(
                f"?ref={older_clock}" in call.args[2]
                and "capacity-maintenance-clock.yml" in call.args[2]
                for call in owner.command.call_args_list
            )
        )

    def test_changed_clock_blob_or_nonancestor_worker_refuses_closed(self):
        changed_blob = self._case()
        changed_owner, _record, _worker, _job, _log, _blobs, clock = changed_blob
        clock["source_blobs"] = {
            profile_evidence.records.PUBLICATION: {"sha": "f" * 40, "size": 1}
        }
        with self.assertRaises(_UnsafeProfileState):
            profile_evidence.discover_record(
                changed_owner,
                base.REPOSITORY,
                changed_blob[2],
                changed_blob[3],
            )

        nonancestor = self._case()
        owner, _record, worker, job, _log, _blobs, _clock = nonancestor
        worker["head_sha"] = "f" * 40
        job["head_sha"] = worker["head_sha"]
        owner.compare_results[(profile_evidence.APPROVED_SOURCE_SHA, worker["head_sha"])] = {
            "status": "diverged",
            "ahead_by": 1,
            "behind_by": 1,
            "total_commits": 2,
            "commit_count": 2,
        }
        with self.assertRaises(_UnsafeProfileState):
            profile_evidence.discover_record(owner, base.REPOSITORY, worker, job)
        owner.api.assert_not_called()

        nonancestor_clock = self._case()
        owner, _record, worker, job, _log, _blobs, clock = nonancestor_clock
        clock_head = "f" * 40
        clock["run"]["head_sha"] = clock_head
        for clock_job in (clock["check_job"], clock["wake_job"]):
            clock_job["head_sha"] = clock_head
        owner.compare_results[(clock_head, worker["head_sha"])] = {
            "status": "diverged",
            "ahead_by": 1,
            "behind_by": 1,
            "total_commits": 2,
            "commit_count": 2,
        }
        with self.assertRaises(_UnsafeProfileState):
            profile_evidence.discover_record(owner, base.REPOSITORY, worker, job)
        self.assertFalse(
            any("/contents/" in call.args[2] for call in owner.command.call_args_list)
        )


if __name__ == "__main__":
    unittest.main()

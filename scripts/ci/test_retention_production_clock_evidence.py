#!/usr/bin/env python3
"""Clock-bound production refusal evidence and its exact API witness."""

import contextvars
import copy
import hashlib
import json
import sys
import threading
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import retention_preflight_evidence as base  # noqa: E402
import retention_production_clock_evidence as clock_evidence  # noqa: E402
import retention_production_clock_records as records  # noqa: E402
import retention_production_evidence as evidence  # noqa: E402
import retention_production_profile_evidence as profile_evidence  # noqa: E402
import retention_publication_source as publication_source  # noqa: E402
from test_retention_production_evidence import clock_bound_fixture  # noqa: E402


class _UnsafeProfileState(Exception):
    pass


class ClockBoundProductionEvidenceTest(unittest.TestCase):
    def test_clock_workflow_versions_pin_current_source_and_historical_receipts(self):
        workflows = Path(__file__).resolve().parents[2] / ".github/workflows"

        def git_blob(path):
            content = path.read_bytes()
            header = f"blob {len(content)}\0".encode()
            return hashlib.sha1(header + content).hexdigest(), len(content)

        self.assertEqual(
            git_blob(workflows / "capacity-maintenance-clock.yml"),
            clock_evidence.CURRENT_CLOCK_WORKFLOW_BLOB,
        )
        source_profile = records.CLOCK_BOUND_SOURCE_PROFILES[
            profile_evidence.PROFILE_NAME
        ]
        self.assertEqual(
            git_blob(workflows / "capacity-maintenance.yml"),
            source_profile[base.WORKFLOW],
        )
        self.assertEqual(
            clock_evidence._clock_workflow_blob_for_title("Capacity clock"),
            clock_evidence.CURRENT_CLOCK_WORKFLOW_BLOB,
        )
        self.assertEqual(
            clock_evidence._clock_workflow_blob_for_title(
                "Capacity clock · repository_dispatch · run 531"
            ),
            clock_evidence.HISTORICAL_NUMBERED_CLOCK_WORKFLOW_BLOB,
        )
        self.assertIsNone(
            clock_evidence._clock_workflow_blob_for_title(
                "Capacity clock · repository_dispatch"
            )
        )

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
    def _case(
        self,
        *,
        ambiguous=False,
        truncated=False,
        source_profile=profile_evidence.PROFILE_NAME,
    ):
        record, worker, job, log, blobs, clock = clock_bound_fixture(41489711406)
        current_sources = records.CLOCK_BOUND_SOURCE_PROFILES[
            source_profile
        ]
        blobs = {
            path: {"sha": sha, "size": size}
            for path, (sha, size) in current_sources.items()
        }
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
            display_title=(
                clock_evidence.CURRENT_CLOCK_TITLE
                if source_profile == profile_evidence.PROFILE_NAME
                else "Capacity clock · repository_dispatch · run 533"
            ),
            created_at="2026-10-29T20:29:00Z",
            status="waiting",
            conclusion=None,
        )
        workflow_blob = (
            clock_evidence.CURRENT_CLOCK_WORKFLOW_BLOB
            if source_profile == profile_evidence.PROFILE_NAME
            else clock_evidence.HISTORICAL_NUMBERED_CLOCK_WORKFLOW_BLOB
        )
        clock["workflow_blob"] = {
            "sha": workflow_blob[0],
            "size": workflow_blob[1],
        }
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
            other.update(id=41499139072)
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
                profile = records.CLOCK_BOUND_SOURCE_PROFILES[source_profile]
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

    def test_dynamic_profile_refuses_unknown_title_or_unpinned_clock_blob(self):
        unknown_title = self._case()
        unknown_title[6]["run"]["display_title"] = (
            "Capacity clock · repository_dispatch"
        )
        with self.assertRaises(_UnsafeProfileState):
            self._qualify(unknown_title)

        changed_blob = self._case()
        changed_blob[6]["workflow_blob"] = {"sha": "f" * 40, "size": 1}
        with self.assertRaises(_UnsafeProfileState):
            self._qualify(changed_blob)

        mismatched_legacy_blob = self._case()
        mismatched_legacy_blob[6]["workflow_blob"] = {
            "sha": clock_evidence.HISTORICAL_NUMBERED_CLOCK_WORKFLOW_BLOB[0],
            "size": clock_evidence.HISTORICAL_NUMBERED_CLOCK_WORKFLOW_BLOB[1],
        }
        with self.assertRaises(_UnsafeProfileState):
            self._qualify(mismatched_legacy_blob)

        mismatched_current_blob = self._case(
            source_profile=profile_evidence.PROFILE_TEMPLATE_SOURCE
        )
        mismatched_current_blob[6]["workflow_blob"] = {
            "sha": clock_evidence.CURRENT_CLOCK_WORKFLOW_BLOB[0],
            "size": clock_evidence.CURRENT_CLOCK_WORKFLOW_BLOB[1],
        }
        with self.assertRaises(_UnsafeProfileState):
            self._qualify(mismatched_current_blob)

    def test_uncatalogued_numbered_clock_uses_exact_historical_profile(self):
        case = self._case(source_profile=profile_evidence.PROFILE_TEMPLATE_SOURCE)
        proof = self._qualify(case)
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

    def test_clock_attempt_timestamp_representation_keeps_identity_exact(self):
        summary = {"id": 41537628196, "run_attempt": 1,
                   "created_at": "2026-11-02T22:28:57Z", "head_sha": "a" * 40}
        attempt = {**summary, "created_at": "2026-11-02T22:28:58Z"}
        self.assertTrue(profile_evidence._run_matches(summary, attempt))
        self.assertFalse(profile_evidence._run_matches(summary, {**attempt, "head_sha": "b" * 40}))
        self.assertFalse(profile_evidence._run_matches(summary, {**attempt, "created_at": "2026-11-02T22:29:00Z"}))

    def test_actual_attempt_timestamp_binds_the_dynamic_clock_record(self):
        case = self._case()
        owner = case[0]
        original = owner.api.side_effect
        def api(repository, endpoint):
            value = original(repository, endpoint)
            if endpoint.endswith("/attempts/1"):
                value["created_at"] = "2026-10-29T20:29:01Z"
            return value
        owner.api.side_effect = api
        self.assertIsNotNone(self._qualify(case))

    def test_settled_production_job_does_not_wait_for_other_environment(self):
        case = self._case()
        case[2].update(status="pending", conclusion=None)
        self.assertIsNotNone(self._qualify(case))
        case = self._case()
        case[2].update(status="pending", conclusion=None)
        case[3].update(status="in_progress", conclusion=None)
        with self.assertRaises(_UnsafeProfileState):
            self._qualify(case)

    def test_dispatch_step_proves_child_creation_before_post_job_cleanup(self):
        case = self._case()
        wake = case[6]["wake_job"]
        wake["completed_at"] = "2026-10-29T20:30:12Z"
        wake["steps"][0]["started_at"] = "2026-10-29T20:30:01Z"
        self.assertIsNotNone(self._qualify(case))
        case = self._case()
        wake = case[6]["wake_job"]
        wake["completed_at"] = "2026-10-29T20:30:12Z"
        wake["steps"][0].update(started_at="2026-10-29T20:30:00Z", completed_at="2026-10-29T20:30:01Z")
        with self.assertRaises(_UnsafeProfileState):
            self._qualify(case)

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
        with mock.patch.object(
            publication_source,
            "read_source",
            wraps=publication_source.read_source,
        ) as read_source:
            record, proof = profile_evidence.discover_record(
                owner, base.REPOSITORY, worker, job
            )
        self.assertEqual(read_source.call_count, 1)
        self.assertEqual(
            set(read_source.call_args.args[3]),
            {*records.CLOCK_BOUND_SOURCE_PROFILES[profile_evidence.PROFILE_NAME],
             clock_evidence.CLOCK_WORKFLOW},
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


class PublicationSourceReaderTest(unittest.TestCase):
    def setUp(self):
        publication_source._read_pinned_blob.cache_clear()

    def tearDown(self):
        publication_source._read_pinned_blob.cache_clear()

    def test_default_profile_reads_owner_then_its_exact_source_set(self):
        source_profile = next(iter(base.SOURCE_PROFILES.values()))
        revision = "9" * 40
        owner = mock.Mock()
        owner.retention = mock.Mock(UnsafeState=_UnsafeProfileState)
        calls = []

        def command(*args):
            path, ref = args[2].split("/contents/", 1)[1].split("?ref=", 1)
            calls.append((path, ref))
            sha, size = source_profile[path]
            return json.dumps({"sha": sha, "size": size})

        owner.command.side_effect = command
        result = publication_source.read_source(owner, base.REPOSITORY, revision)
        self.assertEqual(
            result,
            {
                path: {"sha": sha, "size": size}
                for path, (sha, size) in source_profile.items()
            },
        )
        self.assertEqual(calls[0], (base.OWNER, revision))
        self.assertEqual(set(calls), {(path, revision) for path in source_profile})

    def test_pinned_metadata_reuse_does_not_cross_revision_or_cache_live_refs(self):
        publication_source._read_pinned_blob.cache_clear()
        paths = (
            base.OWNER,
            base.WORKFLOW,
            records.PUBLICATION,
            clock_evidence.CLOCK_WORKFLOW,
        )
        first_sha = profile_evidence.APPROVED_SOURCE_SHA
        later_sha = "3803d08f2f94c54e9cd6853ba423a269812cd068"
        owner = mock.Mock()
        owner.retention = mock.Mock(UnsafeState=_UnsafeProfileState)
        calls = []

        def command(*args):
            path, revision = args[2].split("/contents/", 1)[1].split("?ref=", 1)
            calls.append((path, revision))
            sha = ("b" if revision == later_sha else "a") * 40
            return json.dumps(
                {
                    "sha": sha,
                    "size": len(path) + len(revision),
                }
            )

        owner.command.side_effect = command
        first = publication_source.read_source(owner, base.REPOSITORY, first_sha, paths)
        self.assertEqual(len(first), len(paths))
        publication_source.read_source(owner, base.REPOSITORY, first_sha, paths)
        self.assertEqual(calls.count((paths[0], first_sha)), 1)

        later = publication_source.read_source(owner, base.REPOSITORY, later_sha, paths)
        self.assertNotEqual(first[paths[0]], later[paths[0]])
        publication_source.read_source(owner, base.REPOSITORY, "main", paths)
        publication_source.read_source(owner, base.REPOSITORY, "main", paths)
        self.assertEqual(len(calls), len(paths) * 4)
        self.assertEqual(
            {revision for _, revision in calls}, {first_sha, later_sha, "main"}
        )
        self.assertEqual(calls.count((paths[0], "main")), 2)

    def test_parallel_blob_reads_inherit_context_and_join_within_three_workers(self):
        deadline = contextvars.ContextVar("test_source_read_deadline", default=None)
        deadline.set("active-pass-deadline")
        lock = threading.Lock()
        active = 0
        max_active = 0
        observed_deadlines = []
        owner = mock.Mock()
        owner.retention = mock.Mock(UnsafeState=_UnsafeProfileState)

        def command(*args):
            nonlocal active, max_active
            path, revision = args[2].split("/contents/", 1)[1].split("?ref=", 1)
            with lock:
                active += 1
                max_active = max(max_active, active)
                observed_deadlines.append(deadline.get())
            try:
                time.sleep(0.02)
                return json.dumps(
                    {
                        "sha": "a" * 40,
                        "size": len(path) + len(revision),
                    }
                )
            finally:
                with lock:
                    active -= 1

        owner.command.side_effect = command
        paths = (
            base.OWNER,
            base.WORKFLOW,
            records.PUBLICATION,
            clock_evidence.CLOCK_WORKFLOW,
        )
        result = publication_source.read_source(
            owner, base.REPOSITORY, profile_evidence.APPROVED_SOURCE_SHA, paths
        )
        self.assertEqual(set(result), set(paths))
        self.assertLessEqual(max_active, 3)
        self.assertGreater(max_active, 1)
        self.assertEqual(
            observed_deadlines, ["active-pass-deadline"] * len(paths)
        )


if __name__ == "__main__":
    unittest.main()

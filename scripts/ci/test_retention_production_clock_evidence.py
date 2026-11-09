#!/usr/bin/env python3
"""Clock-bound production refusal evidence and its exact API witness."""

import contextvars
import copy
import hashlib
import json
import subprocess
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
import retention_uat_guard_evidence as uat_guard  # noqa: E402
from test_retention_production_evidence import clock_bound_fixture  # noqa: E402


class _UnsafeProfileState(Exception):
    pass


class ClockBoundProductionEvidenceTest(unittest.TestCase):
    def test_current_clock_and_immutable_historical_worker_profiles(self):
        root = Path(__file__).resolve().parents[2]
        workflows = root / ".github/workflows"

        def git_blob(path, revision=None):
            content = (path.read_bytes() if revision is None else subprocess.check_output(
                ["git", "show", f"{revision}:{path.relative_to(root)}"], cwd=root))
            header = f"blob {len(content)}\0".encode()
            return hashlib.sha1(header + content).hexdigest(), len(content)

        self.assertEqual(
            git_blob(workflows / "capacity-maintenance-clock.yml"),
            clock_evidence.CURRENT_CLOCK_WORKFLOW_BLOB,
        )
        self.assertEqual(
            git_blob(workflows / "capacity-maintenance-clock.yml",
                     "ccba621758f0395d26c4f187452478b37321c23f"),
            clock_evidence.HISTORICAL_INVENTORY_CLOCK_WORKFLOW_BLOB,
        )
        # Historical qualifications must keep their original source, even as
        # current job labels and evidence readers evolve. Missing history fails.
        for profile, revision in (
            ("publication-aec6-blobless-v2", "b8bca9aba110ff9c838149d45041d6b9d720219e"),
            ("publication-pass-diagnostics-v4", "383350286fdd65706cc80e2b028b901c6e174de3"),
        ):
            for path, expected in records.CLOCK_BOUND_SOURCE_PROFILES[profile].items():
                with self.subTest(profile=profile, path=path):
                    self.assertEqual(git_blob(root / path, revision), expected)
        self.assertEqual(
            clock_evidence._clock_workflow_blob_for_title("Capacity clock"),
            clock_evidence.CURRENT_CLOCK_WORKFLOW_BLOB,
        )
        self.assertEqual(
            set(records.CLOCK_BOUND_SOURCE_PROFILES),
            set(records.CLOCK_BOUND_SOURCE_PROFILE_CLOCK_FAMILIES),
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
        current_sources = records.CLOCK_BOUND_SOURCE_PROFILES[source_profile]
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
        clock_family = records.CLOCK_BOUND_SOURCE_PROFILE_CLOCK_FAMILIES[source_profile]
        current_clock = clock_family == records.CLOCK_FAMILY_CURRENT_STATIC
        clock_run.update(
            id=41489463865,
            display_title=(
                clock_evidence.CURRENT_CLOCK_TITLE
                if current_clock
                else "Capacity clock · repository_dispatch · run 533"
            ),
            created_at="2026-10-29T20:29:00Z",
            status="waiting",
            conclusion=None,
        )
        workflow_blob = (
            clock_evidence.CURRENT_CLOCK_WORKFLOW_BLOB
            if current_clock
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
                return {
                    "total_count": total,
                    "workflow_runs": copy.deepcopy(clock_rows),
                }
            run_id = int(endpoint.split("/", 2)[1])
            if endpoint.endswith("/attempts/1"):
                return copy.deepcopy(
                    clock_run if run_id == clock_run["id"] else clock_rows[1]
                )
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
                        "base_sha": ancestor,
                        "merge_base_sha": ancestor,
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

    def test_source_tuple_selects_one_profile_within_the_bound_clock_family(self):
        owner = mock.Mock()
        owner.retention = mock.Mock(UnsafeState=_UnsafeProfileState)
        for source_profile, source_blobs in records.CLOCK_BOUND_SOURCE_PROFILES.items():
            with self.subTest(source_profile=source_profile):
                family = records.CLOCK_BOUND_SOURCE_PROFILE_CLOCK_FAMILIES[source_profile]
                if family == records.CLOCK_FAMILY_CURRENT_STATIC:
                    title = clock_evidence.CURRENT_CLOCK_TITLE
                    workflow_blob = clock_evidence.CURRENT_CLOCK_WORKFLOW_BLOB
                else:
                    title = "Capacity clock · repository_dispatch · run 533"
                    workflow_blob = clock_evidence.HISTORICAL_NUMBERED_CLOCK_WORKFLOW_BLOB
                metadata = {
                    path: {"sha": sha, "size": size}
                    for path, (sha, size) in source_blobs.items()
                }
                metadata[clock_evidence.CLOCK_WORKFLOW] = {
                    "sha": workflow_blob[0],
                    "size": workflow_blob[1],
                }
                self.assertEqual(
                    profile_evidence._clock_source_profile(owner, title, metadata),
                    source_profile,
                )

        static_profile = profile_evidence.PROFILE_NAME
        static_family = records.CLOCK_BOUND_SOURCE_PROFILE_CLOCK_FAMILIES[static_profile]
        self.assertEqual(static_family, records.CLOCK_FAMILY_CURRENT_STATIC)
        static_sources = records.CLOCK_BOUND_SOURCE_PROFILES[static_profile]
        static_metadata = {
            path: {"sha": sha, "size": size}
            for path, (sha, size) in static_sources.items()
        }
        static_metadata[clock_evidence.CLOCK_WORKFLOW] = {
            "sha": clock_evidence.CURRENT_CLOCK_WORKFLOW_BLOB[0],
            "size": clock_evidence.CURRENT_CLOCK_WORKFLOW_BLOB[1],
        }
        duplicate_sources = dict(records.CLOCK_BOUND_SOURCE_PROFILES)
        duplicate_families = dict(records.CLOCK_BOUND_SOURCE_PROFILE_CLOCK_FAMILIES)
        duplicate_sources["duplicate-current"] = static_sources
        duplicate_families["duplicate-current"] = records.CLOCK_FAMILY_CURRENT_STATIC
        with (
            mock.patch.object(records, "CLOCK_BOUND_SOURCE_PROFILES", duplicate_sources),
            mock.patch.object(
                records,
                "CLOCK_BOUND_SOURCE_PROFILE_CLOCK_FAMILIES",
                duplicate_families,
            ),
            self.assertRaises(_UnsafeProfileState),
        ):
            profile_evidence._clock_source_profile(
                owner, clock_evidence.CURRENT_CLOCK_TITLE, static_metadata
            )

    def test_dynamic_source_profile_is_resolved_from_exact_clock_head_blobs(self):
        for source_profile in records.CLOCK_BOUND_SOURCE_PROFILES:
            with self.subTest(source_profile=source_profile):
                case = self._case(source_profile=source_profile)
                owner, _record, worker, job = case[:4]
                record, proof = profile_evidence.discover_record(
                    owner, base.REPOSITORY, worker, job
                )
                self.assertEqual(record.source_profile, source_profile)
                expected_family = records.CLOCK_BOUND_SOURCE_PROFILE_CLOCK_FAMILIES[
                    source_profile
                ]
                title = proof["run"]["display_title"]
                if expected_family == records.CLOCK_FAMILY_CURRENT_STATIC:
                    self.assertEqual(title, clock_evidence.CURRENT_CLOCK_TITLE)
                else:
                    self.assertRegex(
                        title,
                        r"Capacity clock · repository_dispatch · run [1-9][0-9]*",
                    )
                if expected_family == records.CLOCK_FAMILY_CURRENT_STATIC:
                    historical_case = self._case(source_profile=source_profile)
                    old_blob = clock_evidence.HISTORICAL_INVENTORY_CLOCK_WORKFLOW_BLOB
                    historical_case[6]["workflow_blob"] = {"sha": old_blob[0], "size": old_blob[1]}
                    historical_record, historical_proof = profile_evidence.discover_record(
                        historical_case[0], base.REPOSITORY,
                        historical_case[2], historical_case[3],
                    )
                    self.assertEqual(historical_record.source_profile, source_profile)
                    self.assertEqual(historical_proof["workflow_blob"], historical_case[6]["workflow_blob"])

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

        changed_source = self._case()
        changed_source[6]["source_blobs"] = {
            records.PUBLICATION: {"sha": "f" * 40, "size": 1}
        }
        with self.assertRaises(_UnsafeProfileState):
            profile_evidence.discover_record(
                changed_source[0], base.REPOSITORY, changed_source[2], changed_source[3]
            )

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

    def test_v2_clock_proof_accepts_only_exact_buffered_clock_bound_records(self):
        case = self._case(source_profile="publication-aec6-blobless-v2")
        _owner, _record, worker, job, log, _blobs, clock = case
        diagnostic = "Hosted maintenance stopped: stage=publication_guard kind=safety_refusal"
        current_clock_run_id = clock["run"]["id"]
        older_clock_run_id = current_clock_run_id - 1
        fields = {
            "run_id": 41499429996,
            "attempt": 1,
            "job_id": 125464392331,
            "checkout_sha": profile_evidence.APPROVED_SOURCE_SHA,
            "qualification": "no_provider_mutation",
            "clock_run_id": older_clock_run_id,
        }

        def encoded(value):
            return uat_guard.PROOF_PREFIX + json.dumps(value, sort_keys=True)

        accepted = encoded(fields)
        buffered_log = log.replace(
            diagnostic,
            diagnostic + f"\n2026-10-29T20:35:42.41Z {accepted}",
            1,
        )
        self.assertEqual(
            self._qualify(case, log=buffered_log),
            {
                "run_id": worker["id"],
                "attempt": worker["run_attempt"],
                "job_id": job["id"],
                "checkout_sha": profile_evidence.APPROVED_SOURCE_SHA,
                "qualification": "no_provider_mutation",
                "clock_run_id": current_clock_run_id,
            },
        )

        legacy = {key: value for key, value in fields.items() if key != "clock_run_id"}
        # Both canonical UAT-shaped records and older clock-walk records are
        # valid progress receipts for this exact source profile.
        legacy_log = log.replace(
            diagnostic,
            diagnostic + f"\n2026-10-29T20:35:42.41Z {encoded(legacy)}",
            1,
        )
        self.assertIsNotNone(self._qualify(case, log=legacy_log))

        refusals = (
            encoded({**fields, "clock_run_id": 0}),
            encoded({**fields, "attempt": 11}),
            encoded({**fields, "extra": "not allowed"}),
            encoded({**fields, "qualification": "reconciled"}),
            uat_guard.PROOF_PREFIX + "{",
        )
        for line in refusals:
            with self.subTest(line=line):
                rejected_log = log.replace(
                    diagnostic,
                    diagnostic + f"\n2026-10-29T20:35:42.41Z {line}",
                    1,
                )
                self.assertIsNone(self._qualify(case, log=rejected_log))

        older_profile = self._case(source_profile="publication-84b-blobless-v1")
        old_clock_run_id = older_profile[6]["run"]["id"] - 1
        old_clocked = encoded({**fields, "clock_run_id": old_clock_run_id})
        old_unclocked = encoded(legacy)
        for line in (old_clocked, old_unclocked):
            with self.subTest(profile="publication-84b-blobless-v1", line=line):
                rejected_log = older_profile[4].replace(
                    diagnostic,
                    diagnostic + f"\n2026-10-29T20:35:42.41Z {line}",
                    1,
                )
                self.assertIsNone(self._qualify(older_profile, log=rejected_log))

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

    def test_future_clock_summaries_are_validated_before_any_parallel_reads(self):
        case = self._case()
        owner, _record, worker, job, _log, _blobs, clock = case
        future = copy.deepcopy(clock["run"])
        future.update(
            id=41489463866,
            created_at="2026-10-29T20:30:05Z",
            path=".github/workflows/unregistered-clock.yml",
        )
        inventory = {
            "total_count": 2,
            "workflow_runs": [clock["run"], future],
        }
        calls = []

        def api(repository, endpoint):
            calls.append(endpoint)
            if endpoint.startswith("workflows/"):
                return inventory
            raise AssertionError("clock pair read started before validating all rows")

        owner.api.side_effect = api
        with self.assertRaises(_UnsafeProfileState):
            profile_evidence._clock_candidates(
                owner, base.REPOSITORY, worker, job
            )
        self.assertEqual(len(calls), 1)

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

    def test_ancestry_uses_exact_merge_base_beyond_the_commit_page(self):
        case = self._case()
        owner = case[0]
        ancestor, descendant = profile_evidence.APPROVED_SOURCE_SHA, "f" * 40
        accepted = {
            "status": "ahead",
            "ahead_by": 278,
            "behind_by": 0,
            "total_commits": 278,
            "base_sha": ancestor,
            "merge_base_sha": ancestor,
        }
        owner.compare_results[(ancestor, descendant)] = accepted
        self.assertTrue(
            profile_evidence._is_ancestor(owner, base.REPOSITORY, ancestor, descendant)
        )
        self.assertIn("per_page=1", owner.command.call_args.args[2])
        for changed in (
            {"status": "diverged", "behind_by": 1},
            {"base_sha": "0" * 40},
            {"merge_base_sha": "0" * 40},
            {"merge_base_sha": None},
            {"total_commits": 277},
            {"ahead_by": True},
        ):
            with self.subTest(changed=changed):
                profile_evidence._is_ancestor.cache_clear()
                owner.compare_results[(ancestor, descendant)] = {**accepted, **changed}
                with self.assertRaises(_UnsafeProfileState):
                    profile_evidence._is_ancestor(
                        owner, base.REPOSITORY, ancestor, descendant
                    )

    def test_current_refusal_qualifies_without_inventing_clock_causality(self):
        for name in (
            "publication-pass-diagnostics-v3",
            "publication-pass-diagnostics-v4",
        ):
            with self.subTest(profile=name):
                case = self._case(source_profile=name)
                case[6]["run"].update(event="schedule", actor={"login": "other"})
                case[6]["wake_job"]["completed_at"] = "2026-10-29T20:20:00Z"
                proof = self._qualify(case)
                self.assertEqual(proof["qualification"], "no_provider_mutation")
                self.assertNotIn("clock_run_id", proof)
                self.assertTrue(
                    uat_guard._proof_record(
                        "maintenance_publication_proof="
                        + json.dumps(proof, sort_keys=True),
                        allow_clock_records=True,
                    )
                )
                case[0].api.assert_not_called()

    def test_current_refusal_rejects_changed_helper_checkout_actor_and_effects(self):
        name = "publication-pass-diagnostics-v3"
        case = self._case(source_profile=name)
        changed = {**case[5], records.PASS_DIAGNOSTICS: {"sha": "f" * 40, "size": 1}}
        with self.assertRaises(_UnsafeProfileState):
            self._qualify(case, blobs=changed)

        def qualify(case, *, log=None):
            owner, _, run, job, original, blobs, _ = case
            return profile_evidence.qualify_source_refusal(
                owner,
                base.REPOSITORY,
                run,
                job,
                log_reader=lambda *_: original if log is None else log,
                source_reader=lambda *_: blobs,
                workflow_path=base.WORKFLOW,
            )

        for mutation in (
            "actor",
            "attempt",
            "checkout",
            "provider_step",
            "late_creation",
            "transcript",
        ):
            with self.subTest(mutation=mutation):
                case = self._case(source_profile=name)
                log = case[4]
                if mutation == "actor":
                    case[2]["actor"] = {"login": "unrelated-user"}
                elif mutation == "attempt":
                    case[2]["run_attempt"] = 2
                elif mutation == "checkout":
                    log = log.replace(case[2]["head_sha"], "f" * 40)
                elif mutation == "provider_step":
                    for step in case[3]["steps"]:
                        if (
                            step["name"]
                            == "Publish operational backend reference under deployment lock"
                        ):
                            step["conclusion"] = "success"
                elif mutation == "late_creation":
                    case[2]["created_at"] = "2026-10-29T23:00:00Z"
                else:
                    log = log.replace(
                        "Hosted maintenance stopped:",
                        "provider mutation started; Hosted maintenance stopped:",
                    )
                self.assertIsNone(qualify(case, log=log))


class ClockRowsFanoutTest(unittest.TestCase):
    def _fixture(self, count=5):
        summaries = []
        attempts = {}
        jobs = {}
        for offset in range(count):
            run_id = 40000000000 + offset
            created_at = f"2026-10-29T20:2{offset}:00Z"
            summary = {
                "id": run_id,
                "run_attempt": 1,
                "event": "repository_dispatch",
                "path": "capacity-maintenance-clock.yml",
                "head_branch": "main",
                "head_sha": "a" * 40,
                "created_at": created_at,
                "status": "waiting",
                "conclusion": None,
                "display_title": "Capacity clock",
                "actor": {"login": "github-actions[bot]"},
                "triggering_actor": {"login": "github-actions[bot]"},
                "repository": {"full_name": base.REPOSITORY},
                "head_repository": {"full_name": base.REPOSITORY},
            }
            summaries.append(summary)
            attempts[run_id] = {
                **summary,
                "created_at": created_at.replace(":00Z", ":01Z"),
            }
            jobs[run_id] = [
                {
                    "id": 90000000000 + offset,
                    "run_id": run_id,
                    "run_attempt": 1,
                    "head_sha": summary["head_sha"],
                    "head_branch": "main",
                    "name": f"clock-job-{offset}",
                }
            ]
        return summaries, attempts, jobs

    def test_clock_row_reads_are_bounded_ordered_and_inherit_deadline(self):
        deadline = contextvars.ContextVar("clock_rows_deadline", default=None)
        deadline.set("active-guard-deadline")
        summaries, attempts, jobs = self._fixture()
        lock = threading.Lock()
        active = 0
        max_active = 0
        seen_deadlines = []
        job_completion_order = []
        second_jobs_done = threading.Event()
        first_id, second_id = summaries[0]["id"], summaries[1]["id"]
        owner = mock.Mock()
        owner.retention = mock.Mock(UnsafeState=_UnsafeProfileState)

        def api(_repository, endpoint):
            nonlocal active, max_active
            run_id = int(endpoint.split("/", 2)[1])
            is_attempt = endpoint.endswith("/attempts/1")
            with lock:
                active += 1
                max_active = max(max_active, active)
                seen_deadlines.append(deadline.get())
            try:
                if run_id == first_id and is_attempt:
                    if not second_jobs_done.wait(timeout=2):
                        raise AssertionError("parallel clock read did not start")
                if is_attempt:
                    return copy.deepcopy(attempts[run_id])
                if run_id == second_id:
                    with lock:
                        job_completion_order.append(run_id)
                    second_jobs_done.set()
                else:
                    with lock:
                        job_completion_order.append(run_id)
                return {"total_count": len(jobs[run_id]), "jobs": copy.deepcopy(jobs[run_id])}
            finally:
                with lock:
                    active -= 1

        owner.api.side_effect = api
        result = profile_evidence._clock_rows_parallel(
            owner, base.REPOSITORY, summaries
        )

        self.assertEqual([attempt["id"] for attempt, _ in result],
                         [summary["id"] for summary in summaries])
        self.assertEqual([rows[0]["id"] for _, rows in result],
                         [items[0]["id"] for items in jobs.values()])
        self.assertLess(
            job_completion_order.index(second_id),
            job_completion_order.index(first_id),
        )
        self.assertLessEqual(max_active, 3)
        self.assertGreater(max_active, 1)
        self.assertEqual(len(seen_deadlines), 2 * len(summaries))
        self.assertEqual(set(seen_deadlines), {"active-guard-deadline"})

    def test_any_incomplete_clock_job_inventory_refuses_the_batch(self):
        summaries, attempts, jobs = self._fixture(count=3)
        rejected_id = summaries[-1]["id"]
        job_reads = []
        owner = mock.Mock()
        owner.retention = mock.Mock(UnsafeState=_UnsafeProfileState)

        def api(_repository, endpoint):
            run_id = int(endpoint.split("/", 2)[1])
            if endpoint.endswith("/attempts/1"):
                return copy.deepcopy(attempts[run_id])
            job_reads.append(run_id)
            return {
                "total_count": len(jobs[run_id]) + int(run_id == rejected_id),
                "jobs": copy.deepcopy(jobs[run_id]),
            }

        owner.api.side_effect = api
        with self.assertRaises(_UnsafeProfileState):
            profile_evidence._clock_rows_parallel(
                owner, base.REPOSITORY, summaries
            )
        self.assertCountEqual(job_reads, [summary["id"] for summary in summaries])


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

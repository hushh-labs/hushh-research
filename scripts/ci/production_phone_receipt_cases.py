"""Phone rollback receipt and retained-runtime security regression cases."""

import copy
import importlib
import json
import pathlib
import tempfile
import subprocess
from unittest import mock

import production_phone_receipt as phone
import production_phone_lease as lease
from production_phone_receipt_fixtures import (
    LeaseFixture,
    archive as phone_archive,
    cold_revision,
    phone_documents,
)

MAINTENANCE = importlib.import_module("uat-retention-maintenance")


class ProductionPhoneReceiptCases:
    def phone_anchor(self, documents):
        payload = phone_archive(self, documents)
        return phone.healthy_anchor(
            self.repo,
            self.run,
            documents["prod-release-status.json"],
            MAINTENANCE.LANES["production"],
            api=lambda repository, endpoint: (
                self.jobs
                if endpoint
                == f"runs/300/attempts/{self.run['run_attempt']}/jobs?per_page=100"
                else self.api(repository, endpoint)
            ),
            governed=MAINTENANCE.governed_dispatch,
            timestamp=MAINTENANCE._github_timestamp,
            run_command=lambda *args, **kwargs: subprocess.CompletedProcess(
                [], 0, payload, b""
            ),
            timeout=30,
        )

    def test_phone_anchor_uses_exact_artifact_and_preserves_independent_lkg(self):
        for attempt in (1, 2):
            self.setUp()
            self.run["run_attempt"] = self.jobs["jobs"][0]["run_attempt"] = attempt
            documents = phone_documents(self)
            release = documents["prod-release-status.json"]
            unchanged = copy.deepcopy(release)
            anchor = self.phone_anchor(documents)
            actual = cold_revision(documents["phone-rollback/qualified.json"])
            revisions = [actual, {"metadata": {"name": "consent-protocol-old"}}]
            with (
                mock.patch.object(
                    MAINTENANCE, "command", return_value="consent-protocol-independent"
                ),
                mock.patch.object(
                    MAINTENANCE.retention, "revision_state", return_value=revisions
                ),
            ):
                flags = MAINTENANCE.release_protection_flags(
                    "consent-protocol",
                    "backend",
                    release,
                    environment="production",
                    phone_anchor=anchor,
                )
            self.assertEqual(
                flags,
                [
                    "consent-protocol-current",
                    "--rollback-revision",
                    "consent-protocol-cold",
                    "--last-known-good-revision",
                    "consent-protocol-independent",
                ],
            )
            self.assertEqual(anchor["artifact_id"], 100)
            self.assertEqual(anchor["run_attempt"], attempt)
            self.assertEqual(release, unchanged)

    def test_phone_anchor_refuses_summary_only_mixed_attempt_or_partial_proofs(self):
        for defect in (
            "summary_only",
            "source",
            "primary",
            "probe",
            "consumer",
            "documents",
            "job_attempt",
            "artifact_origin",
            "ambiguous",
            "upload_failed",
            "fork",
            "gate",
        ):
            self.setUp()
            documents = phone_documents(self)
            qualified, plan = (
                documents["phone-rollback/qualified.json"],
                documents["phone-rollback/plan.json"],
            )
            if defect == "summary_only":
                del documents["phone-rollback/qualified.json"]
            elif defect == "source":
                qualified["source"] = "a" * 40
            elif defect == "primary":
                plan["primary_sha"] = "a" * 40
            elif defect == "probe":
                qualified["probe"]["probe_generation_admission"] = True
            elif defect == "consumer":
                plan["consumer_compatibility"]["source_sha256"].pop(
                    next(iter(plan["consumer_compatibility"]["source_sha256"]))
                )
            elif defect == "documents":
                documents["prod-document-reader-compatibility.json"]["previous"][
                    "consent-protocol"
                ]["revision"] = "consent-protocol-old"
            elif defect == "gate":
                self.jobs["jobs"][0]["steps"][1]["conclusion"] = "skipped"
            else:
                self.apply_defect(defect)
            with (
                self.subTest(defect=defect),
                self.assertRaises(MAINTENANCE.retention.UnsafeState),
            ):
                self.phone_anchor(documents)

    def test_phone_anchor_rechecks_runtime_and_checkpoint_keeps_reference(self):
        self.setUp()
        documents = phone_documents(self)
        release = documents["prod-release-status.json"]
        anchor = self.phone_anchor(documents)
        actual = cold_revision(documents["phone-rollback/qualified.json"])
        self.assertEqual(
            phone.rollback_revision(anchor, release, [actual]), anchor["revision"]
        )
        for row in actual["spec"]["containers"][0]["env"]:
            if row["name"] == "AUTH_PHONE_RECOVERY_ENABLED":
                row["value"] = "true"
        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
            phone.rollback_revision(anchor, release, [actual])
        with tempfile.TemporaryDirectory() as temporary:
            args = mock.Mock(
                state_dir=pathlib.Path(temporary),
                environment="production",
                phone_anchor=anchor,
            )
            MAINTENANCE.checkpoint(args, 300, 300, [], "complete")
            saved = json.loads((args.state_dir / "completed.json").read_text())
            self.assertEqual(saved["phone_rollback_qualification"], anchor)

    def test_healthy_release_selects_phone_proof_without_rewriting_its_receipt(self):
        self.setUp()
        documents = phone_documents(self)
        release = documents["prod-release-status.json"]
        unchanged, anchors = copy.deepcopy(release), []
        payload = phone_archive(self, documents)
        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.object(MAINTENANCE, "api", side_effect=self.api),
            mock.patch.object(MAINTENANCE, "load_release", return_value=release),
            mock.patch.object(MAINTENANCE.time, "monotonic", return_value=120),
            mock.patch.object(
                MAINTENANCE, "_LOOKUP_DEADLINE", mock.Mock(get=lambda: 123)
            ),
            mock.patch.object(
                MAINTENANCE.retention,
                "run_command",
                return_value=subprocess.CompletedProcess([], 0, payload, b""),
            ) as fetch,
        ):
            found = MAINTENANCE.find_release(
                self.repo,
                "300",
                pathlib.Path(temporary),
                environment="production",
                on_phone_rollback=anchors.append,
            )
        self.assertEqual(found, (300, unchanged))
        self.assertEqual(release, unchanged)
        self.assertEqual(anchors[0]["revision"], release["phone_rollback"]["revision"])
        self.assertEqual(fetch.call_args.kwargs["timeout"], 3)

    def test_runtime_only_checkpoint_refuses_before_any_authority_or_cloud_lookup(self):
        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.dict(
                "os.environ",
                {"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF_NAME": "main"},
            ),
            mock.patch(
                "sys.argv",
                [
                    "maintenance",
                    "--environment",
                    "production",
                    "--state-dir",
                    temporary,
                    "--release-run-id",
                    "300",
                    "--qualified-cold-checkpoint-run-id",
                    "400",
                    "--verify-source-only",
                ],
            ),
            mock.patch.object(
                MAINTENANCE, "api", side_effect=AssertionError("no authority lookup")
            ),
            self.assertRaisesRegex(
                MAINTENANCE.retention.UnsafeState, "installed-schema"
            ),
        ):
            MAINTENANCE.maintenance_cli()


class ProductionWorkerOnlyLeaseCases:
    def test_recorded_failed_worker_only_inventory(self):
        """The redacted shape of production attempt 40780085771 never ran a producer."""
        attempt = {
            "id": 40780085771,
            "run_attempt": 1,
            "head_sha": "6b8ec6c63e4d5556b9e44ad2e4836b3927ba22aa",
            "status": "completed",
            "conclusion": "failure",
        }
        bound = {
            "run_id": attempt["id"],
            "run_attempt": 1,
            "head_sha": attempt["head_sha"],
            "head_branch": "main",
        }
        names = (
            "(inputs.phone_phase == 'activate' || inputs.restoration_activation_run_id != '') && 'Ordinary production deploy (not selected)' || 'Deploy Production Scope'",
            "inputs.phone_phase == 'activate' && inputs.restoration_activation_run_id == '' && 'Deploy Production Scope' || 'Activation continuation not selected'",
            "inputs.restoration_activation_run_id != '' && 'Deploy Production Scope' || 'Restoration continuation not selected'",
        )
        jobs = [
            {
                **bound,
                "name": "Stage qualified production Drive worker",
                "status": "completed",
                "conclusion": "failure",
                "steps": [
                    {
                        "name": lease.GUARD,
                        "status": "completed",
                        "conclusion": "failure",
                    }
                ],
            }
        ] + [
            {
                **bound,
                "name": name,
                "status": "completed",
                "conclusion": "skipped",
                "runner_name": None,
                "steps": [],
            }
            for name in names
        ]
        text = (lease.phone.ROOT / lease.WORKFLOW).read_text()
        self.assertIsNone(
            lease._stage_only(self.repo, attempt, {"jobs": jobs}, text, True)
        )

    def worker_only_lease(self, *, active=False):
        case = LeaseFixture(self)
        case.intent_protocol()
        environment = case.active_guard() if active else {}
        environment[lease.receipts.PRODUCTION_EVIDENCE_REPAIR_FLAG] = "true"
        if active:
            environment.update(
                GITHUB_JOB="stage-drive-worker", GITHUB_SHA=case.runs[0]["head_sha"]
            )
        else:
            case.runs[0]["conclusion"] = "failure"
            case.attempts[(300, 2)]["conclusion"] = "failure"
        bound = {
            "run_id": 300,
            "run_attempt": 2,
            "head_sha": case.runs[0]["head_sha"],
            "head_branch": "main",
        }
        skipped = [
            {
                **bound,
                "name": name,
                "status": "completed",
                "conclusion": "skipped",
                "runner_name": None,
                "steps": [],
            }
            for name in lease.STAGE_SKIPPED_JOBS
        ]
        stage = {
            **bound,
            "name": lease.STAGE_JOB,
            "status": "in_progress" if active else "completed",
            "conclusion": None if active else "failure",
            "steps": [
                {
                    "name": lease.GUARD,
                    "status": "in_progress" if active else "completed",
                    "conclusion": None if active else "failure",
                }
            ],
        }
        case.jobs[(300, 2)] = {"total_count": 4, "jobs": [stage, *skipped]}
        return case, environment

    def test_reviewed_worker_only_attempt_proves_no_cold_producer(self):
        self.setUp()
        for active in (False, True):
            with self.subTest(active=active):
                case, environment = self.worker_only_lease(active=active)
                with mock.patch.dict("os.environ", environment, clear=True):
                    self.assertIsNone(self.lease_check(case))
                    self.assertIn("runs/300/attempts/1/jobs?per_page=100", case.calls)
                    self.lease_defect(case, "older_pending")
                    with self.assertRaises(lease.retention.UnsafeState):
                        self.lease_check(case)

        for defect in (
            "source",
            "missing",
            "extra",
            "duplicate",
            "partial",
            "identity",
            "runner",
            "steps",
            "status",
            "guard",
            "foreign",
        ):
            with self.subTest(defect=defect):
                case, environment = self.worker_only_lease(active=True)
                jobs = case.jobs[(300, 2)]
                if defect == "source":
                    case.sources[case.runs[0]["head_sha"]] += b"\n# unreviewed\n"
                elif defect == "missing":
                    jobs["jobs"].pop()
                    jobs["total_count"] -= 1
                elif defect == "extra":
                    jobs["jobs"].append({**jobs["jobs"][1], "name": "Unknown job"})
                    jobs["total_count"] += 1
                elif defect == "duplicate":
                    jobs["jobs"][2] = copy.deepcopy(jobs["jobs"][1])
                elif defect == "partial":
                    jobs["total_count"] += 1
                elif defect == "identity":
                    jobs["jobs"][1]["run_attempt"] = 1
                elif defect == "runner":
                    jobs["jobs"][1]["runner_name"] = "unexpected"
                elif defect == "steps":
                    jobs["jobs"][1]["steps"] = [{"name": "started"}]
                elif defect == "status":
                    jobs["jobs"][1]["conclusion"] = "failure"
                elif defect == "guard":
                    jobs["jobs"][0]["steps"][0]["status"] = "completed"
                elif defect == "foreign":
                    environment["GITHUB_RUN_ID"] = "other"
                with mock.patch.dict("os.environ", environment, clear=True):
                    with self.assertRaises(lease.retention.UnsafeState):
                        self.lease_check(case)

    def test_disabled_repair_keeps_existing_worker_refusal(self):
        self.setUp()
        case, environment = self.worker_only_lease(active=True)
        environment[lease.receipts.PRODUCTION_EVIDENCE_REPAIR_FLAG] = "false"
        with mock.patch.dict("os.environ", environment, clear=True):
            with self.assertRaisesRegex(
                lease.retention.UnsafeState, "attempt job is not bound"
            ):
                self.lease_check(case)

    def restoration_lease(self, conclusion="success", *, active=False):
        case = LeaseFixture(self)
        case.intent_protocol()
        text = case.sources[case.runs[0]["head_sha"]]
        case.sources.update({"origin/main": text, "e" * 40: text})
        job = case.jobs[(300, 2)]["jobs"][0]
        case.artifacts = [item for item in case.artifacts if item["id"] in {901, 1901}]
        admission = {
            "name": lease.RESTORATION_ADMIT,
            "status": "completed",
            "conclusion": "success",
        }
        if active:
            environment = case.active_guard()
            environment.update(
                GITHUB_JOB=lease.RESTORATION_JOB, GITHUB_SHA=case.runs[0]["head_sha"]
            )
            job["steps"].insert(0, admission)
        else:
            environment = {"GITHUB_SHA": "e" * 40}
            case.runs[0]["conclusion"] = conclusion
            case.attempts[(300, 2)]["conclusion"] = conclusion
            job.update(
                conclusion=conclusion,
                steps=[
                    admission,
                    {
                        "name": "Verify unchanged restoration serving pair",
                        "status": "completed",
                        "conclusion": conclusion,
                    },
                ],
            )
        return case, environment

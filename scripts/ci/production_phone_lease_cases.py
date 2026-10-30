"""Cold-route mutation admission cases composed into the owning receipt suite."""

import copy
from pathlib import Path
import tempfile
from unittest import mock

import production_phone_lease as lease
from production_phone_receipt_fixtures import (
    LeaseFixture,
    historical_restoration_source,
)


class ProductionPhoneLeaseCases:
    def lease_check(self, case):
        case.pack()
        return lease.assert_reconciled(
            self.repo,
            api=case.api,
            governed=self.maintenance.governed_dispatch,
            timestamp=self.maintenance._github_timestamp,
            source_command=case.source,
            run_command=case.fetch,
        )

    def lease_defect(self, case, defect):
        if defect == "older_pending":
            case.documents[1].update(status="pending", pending_mutation="stage_cold")
        elif defect == "older_pending_after_skipped":
            self.lease_defect(case, "older_pending")
            case.jobs[(300, 2)]["jobs"][0]["steps"][0]["conclusion"] = "skipped"
        elif defect in {"begin", "deploy", "cleanup", "upload"}:
            number = {"begin": 0, "deploy": 1, "cleanup": 2, "upload": 3}[defect]
            case.jobs[(300, 2)]["jobs"][0]["steps"][number]["conclusion"] = "failure"
        elif defect == "missing_publication":
            case.artifacts.pop()
        elif defect == "ambiguous_publication":
            case.artifacts.append(copy.deepcopy(case.artifacts[-1]))
        elif defect == "expired":
            case.artifacts[-1]["expired"] = True
        elif defect == "origin":
            case.artifacts[-1]["workflow_run"]["head_sha"] = "f" * 40
        elif defect == "window":
            case.artifacts[-1]["created_at"] = "2026-10-20T01:00:00Z"
        elif defect == "attempt":
            case.documents[2]["origin"]["run_attempt"] = 1
        elif defect == "workflow_sha":
            case.documents[2]["workflow_sha"] = "f" * 40
        elif defect == "pending_mutation":
            case.documents[2]["pending_mutation"] = "remove_tag"
        elif defect == "actor":
            case.runs[0]["actor"] = {"login": "unapproved"}
        elif defect == "job_attempt":
            case.jobs[(300, 2)]["jobs"][0]["run_attempt"] = 1
        elif defect == "missing_job":
            case.jobs[(300, 2)] = {"total_count": 0, "jobs": []}
        elif defect == "partial_jobs":
            case.jobs[(300, 2)]["total_count"] = 2
        elif defect == "missing_step":
            case.jobs[(300, 2)]["jobs"][0]["steps"].pop(0)
        elif defect == "static_identity":
            case.documents[2]["project"] = "hushh-pda-uat"
        elif defect == "serving":
            case.documents[2]["serving"][0][1] = True
        elif defect == "traffic":
            case.documents[2]["traffic"][0][0][2] = "phone-rollback-300"

    def test_cold_lease_requires_every_attempt_publication_before_admission(self):
        self.setUp()
        case = LeaseFixture(self)
        self.assertIsNone(self.lease_check(case))
        self.assertIn("runs/300/attempts/1/jobs?per_page=100", case.calls)
        self.assertTrue(any(args[1] == "log" for args in case.source_calls))
        for defect in (
            "older_pending",
            "older_pending_after_skipped",
            "begin",
            "deploy",
            "cleanup",
            "upload",
            "missing_publication",
            "ambiguous_publication",
            "expired",
            "origin",
            "window",
            "attempt",
            "workflow_sha",
            "pending_mutation",
            "actor",
            "job_attempt",
            "missing_job",
            "partial_jobs",
            "missing_step",
            "static_identity",
            "serving",
            "traffic",
        ):
            with self.subTest(defect=defect):
                case = LeaseFixture(self)
                self.lease_defect(case, defect)
                with self.assertRaises(lease.retention.UnsafeState):
                    self.lease_check(case)

    def test_cold_lease_boundary_refuses_uncertain_source_history_or_pagination(self):
        self.setUp()
        for defect in (
            "source",
            "reverted",
            "partial",
            "chronology",
            "protocol",
            "no_boundary",
        ):
            case = LeaseFixture(self)
            if defect == "source":
                case.source_error = True
            elif defect == "reverted":
                case.reverted = True
            elif defect == "partial":
                case.total_count = 3
            elif defect == "chronology":
                case.runs[1]["created_at"] = "2026-10-22T03:00:00Z"
            elif defect == "protocol":
                case.sources[case.runs[0]["head_sha"]] = lease.MARKER.encode()
            elif defect == "no_boundary":
                case.runs.pop()
                case.total_count = 1
            with (
                self.subTest(defect=defect),
                self.assertRaises(lease.retention.UnsafeState),
            ):
                self.lease_check(case)

    def test_cold_lease_refresh_cannot_hide_an_attempt_change(self):
        self.setUp()
        case = LeaseFixture(self)
        original = case.api

        def changed(repository, endpoint):
            result = original(repository, endpoint)
            if endpoint.endswith("?exclude_pull_requests=true"):
                return {**result, "run_attempt": 3}
            return result

        case.api = changed
        with self.assertRaisesRegex(lease.retention.UnsafeState, "attempt changed"):
            self.lease_check(case)

    def test_fresh_maintenance_directory_still_fences_unresolved_cold_lease(self):
        self.setUp()
        case = LeaseFixture(self)
        self.lease_defect(case, "older_pending_after_skipped")
        case.pack()
        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.object(self.maintenance, "api", side_effect=case.api),
            mock.patch.object(self.maintenance, "restore_state") as restore,
            mock.patch.object(
                self.maintenance,
                "find_release",
                side_effect=AssertionError("lease cannot grant health"),
            ),
            mock.patch.object(
                lease,
                "run_path",
                return_value={"run": lambda args, **kwargs: case.source(args)},
            ),
            mock.patch.object(lease.retention, "run_command", side_effect=case.fetch),
            self.assertRaises(lease.retention.UnsafeState),
        ):
            self.maintenance.assert_no_pending_mutations(
                self.repo, Path(temporary), "production"
            )
        restore.assert_not_called()

    def test_pre_protocol_production_boundary_keeps_existing_admission(self):
        self.setUp()
        case = LeaseFixture(self)
        case.runs = case.runs[1:]
        case.total_count = 1
        self.assertIsNone(self.lease_check(case))
        self.assertFalse(
            any(
                "/attempts/" in endpoint or "/artifacts" in endpoint
                for endpoint in case.calls
            )
        )

    def test_only_exact_active_guard_can_omit_future_steps_and_prior_attempt_still_fences(
        self,
    ):
        self.setUp()
        case = LeaseFixture(self)
        environment = case.active_guard()
        with mock.patch.dict("os.environ", environment):
            self.assertIsNone(self.lease_check(case))
            self.assertIn("runs/300/attempts/1/jobs?per_page=100", case.calls)
            self.lease_defect(case, "older_pending")
            with self.assertRaises(lease.retention.UnsafeState):
                self.lease_check(case)
        for defect in (*environment, "guard"):
            case = LeaseFixture(self)
            changed = case.active_guard()
            if defect == "guard":
                case.jobs[(300, 2)]["jobs"][0]["steps"][0]["status"] = "completed"
            else:
                changed[defect] = "other"
            with (
                self.subTest(defect=defect),
                mock.patch.dict("os.environ", changed),
                self.assertRaises(lease.retention.UnsafeState),
            ):
                self.lease_check(case)


class ProductionPhoneSkippedLeaseCases:
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

    def test_restoration_nonproducer_keeps_current_metadata_and_every_older_lease(self):
        self.setUp()
        for conclusion, admission, historical in (
            ("success", "success", False),
            ("failure", "failure", False),
            ("cancelled", "cancelled", False),
            ("cancelled", "skipped", False),
            (None, "success", False),
            ("success", "success", True),
        ):
            case, environment = self.restoration_lease(
                conclusion, active=conclusion is None
            )
            restoration_job_index = 0
            if historical:
                from production_phone_job_name_cases import legacy_workflow

                legacy = legacy_workflow().encode()
                case.sources["e" * 40] = legacy
                case.sources["origin/main"] = legacy
                case.sources[case.runs[0]["head_sha"]] = historical_restoration_source(
                    legacy
                )
                case.use_legacy_job_names()
                jobs = case.jobs[(300, 2)]["jobs"]
                restoration = jobs[2]
                restoration.update(
                    name="Deploy Production Scope",
                    status=jobs[0]["status"],
                    conclusion=jobs[0]["conclusion"],
                    steps=copy.deepcopy(jobs[0]["steps"]),
                )
                jobs[0].update(
                    name=lease.nonproducer.LEGACY_PRODUCTION_JOB_EXPRESSIONS["deploy"],
                    status="completed",
                    conclusion="skipped",
                    steps=[],
                )
                restoration_job_index = 2
            case.jobs[(300, 2)]["jobs"][restoration_job_index]["steps"][0][
                "conclusion"
            ] = admission
            with (
                self.subTest(conclusion=conclusion, historical=historical),
                mock.patch.dict("os.environ", environment),
            ):
                # Preserved release tools may run over a historical application checkout.
                with (
                    tempfile.TemporaryDirectory() as directory,
                    mock.patch.object(lease.phone, "ROOT", Path(directory)),
                ):
                    self.assertIsNone(self.lease_check(case))
                self.assertIn("runs/300/attempts/1/jobs?per_page=100", case.calls)
                self.lease_defect(case, "older_pending")
                with self.assertRaises(lease.retention.UnsafeState):
                    self.lease_check(case)

    def test_restoration_refuses_source_changes_or_ambiguous_producers(self):
        self.setUp()
        for defect in (
            "source",
            "exclusion",
            "marker",
            "admission",
            "foreign_job",
            "job",
            "ordinary_job",
            "sha",
            "guard",
            "empty_steps",
            "cold_source",
            "historical_source",
            "historical_exclusion",
            "historical_producer",
        ):
            case, environment = self.restoration_lease(
                active=defect in {"job", "ordinary_job", "sha", "guard", "admission"}
            )
            job = case.jobs[(300, 2)]["jobs"][0]
            source = case.sources["e" * 40]
            if defect.startswith("historical_"):
                source = historical_restoration_source(source)
                defect = defect.removeprefix("historical_")
            if defect == "source":
                case.sources[case.runs[0]["head_sha"]] = source.replace(
                    b"--fence-required false", b"--fence-required true"
                )
            elif defect == "exclusion":
                case.sources[case.runs[0]["head_sha"]] = source.replace(
                    b" && inputs.restoration_activation_run_id == ''", b"", 1
                )
            elif defect == "producer":
                case.sources[case.runs[0]["head_sha"]] = source.replace(
                    b"Admit manual restoration verification only",
                    b"Admit manual restoration verification only\n        # gcloud run deploy",
                )
            elif defect == "marker":
                job["steps"].append(
                    {
                        "name": lease.INTENT,
                        "status": "completed",
                        "conclusion": "success",
                    }
                )
            elif defect == "admission":
                job["steps"][0]["conclusion"] = "skipped"
            elif defect == "cold_source":
                text = case.sources["e" * 40].replace(
                    b"Admit manual restoration verification only",
                    b"Admit manual restoration verification only\n        # gcloud builds submit",
                    1,
                )
                case.sources.update({"e" * 40: text, case.runs[0]["head_sha"]: text})
            elif defect == "empty_steps":
                job["steps"] = []
            elif defect == "foreign_job":
                job["run_attempt"] = 1
            elif defect in {"job", "ordinary_job", "sha"}:
                key = "GITHUB_SHA" if defect == "sha" else "GITHUB_JOB"
                environment[key] = {
                    "job": "other",
                    "ordinary_job": "deploy",
                    "sha": "e" * 40,
                }[defect]
            else:
                job["steps"][-1]["status"] = "completed"
            with (
                self.subTest(defect=defect),
                mock.patch.dict("os.environ", environment),
                self.assertRaises(lease.retention.UnsafeState),
            ):
                self.lease_check(case)


class ProductionPhoneIntentGateCases:
    def test_started_producer_requires_immutable_pre_submission_intent_and_matching_final(
        self,
    ):
        self.setUp()
        for defect in (
            None,
            "missing",
            "origin",
            "pending",
            "producer",
            "order",
            "changed_final",
        ):
            case = LeaseFixture(self)
            case.intent_protocol()
            if defect == "missing":
                case.artifacts = [
                    item
                    for item in case.artifacts
                    if item["name"] != "prod-phone-health-intent-300-2"
                ]
            elif defect == "origin":
                case.intent_documents[2]["origin"]["run_attempt"] = 1
            elif defect == "pending":
                case.intent_documents[2]["status"] = "retired"
            elif defect == "producer":
                case.intent_documents[2]["producer"]["cloud_build_tag"] = (
                    "phone-cold-300-1"
                )
            elif defect == "order":
                next(
                    step
                    for step in case.jobs[(300, 2)]["jobs"][0]["steps"]
                    if step["name"] == lease.INTENT
                )["completed_at"] = "2026-10-21T03:18:03Z"
            elif defect == "changed_final":
                case.documents[2]["controls"] = "f" * 64
            with self.subTest(defect=defect):
                if defect is None:
                    self.assertIsNone(self.lease_check(case))
                else:
                    with self.assertRaises(lease.retention.UnsafeState):
                        self.lease_check(case)

    def test_failed_intent_upload_requires_proven_never_started_submission(self):
        self.setUp()
        for defect in (
            None,
            "source_gate",
            "source_missing_intent",
            "started",
            "failed",
            "unknown",
            "unknown_upload",
        ):
            case = LeaseFixture(self)
            case.intent_protocol()
            text = (lease.phone.ROOT / lease.WORKFLOW).read_text()
            if defect == "source_gate":
                text = text.replace(
                    " && steps.cold-lease-intent.outcome == 'success'", ""
                )
            if defect == "source_missing_intent":
                text = text.replace(lease.INTENT, "Other upload")
            case.sources[case.runs[0]["head_sha"]] = text.encode()
            job = case.jobs[(300, 2)]["jobs"][0]
            deploy = next(step for step in job["steps"] if step["name"] == lease.DEPLOY)
            deploy.update(status="completed", conclusion="skipped", started_at=None)
            intent = next(step for step in job["steps"] if step["name"] == lease.INTENT)
            intent["conclusion"] = "failure"
            if defect == "started":
                deploy["started_at"] = "2026-10-21T03:18:00Z"
            elif defect in {"failed", "unknown"}:
                deploy["conclusion"] = "failure" if defect == "failed" else None
            elif defect == "unknown_upload":
                intent["conclusion"] = None
            with self.subTest(defect=defect):
                if defect is None:
                    self.assertIsNone(self.lease_check(case))
                    self.lease_defect(case, "older_pending")
                    with self.assertRaises(lease.retention.UnsafeState):
                        self.lease_check(case)
                else:
                    with self.assertRaises(lease.retention.UnsafeState):
                        self.lease_check(case)

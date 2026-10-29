"""Skipped primary job identity regressions in the existing receipt suite."""

import copy

import production_phone_lease as lease
from production_phone_receipt_fixtures import LeaseFixture

# Actual GitHub API name from worker staging run 40780085771, attempt 1.
RAW_PRIMARY_NAME = (
    "(inputs.phone_phase == 'activate' || inputs.restoration_activation_run_id != '') "
    "&& 'Ordinary production deploy (not selected)' || 'Deploy Production Scope'"
)


class ProductionPhoneSkippedNameCases:
    def skipped_primary_case(self, raw):
        case = LeaseFixture(self)
        if raw:
            case.intent_protocol()
            case.runs[0].update(status="in_progress", conclusion=None)
            case.attempts[(300, 2)].update(status="in_progress", conclusion=None)
        case.jobs[(300, 2)]["jobs"][0].update(
            name=RAW_PRIMARY_NAME if raw else lease.JOB,
            status="completed",
            conclusion="skipped",
            steps=[],
        )
        return case

    def test_only_completed_skipped_empty_job_is_nonexecuted_and_prior_attempt_still_fences(
        self,
    ):
        self.setUp()
        for raw in (False, True):
            with self.subTest(raw=raw):
                case = self.skipped_primary_case(raw)
                self.assertIsNone(self.lease_check(case))
                self.assertIn("runs/300/attempts/1/jobs?per_page=100", case.calls)
                self.lease_defect(case, "older_pending")
                with self.assertRaises(lease.retention.UnsafeState):
                    self.lease_check(case)
            for defect in (
                "failed",
                "cancelled",
                "active",
                "missing_steps",
                "started_step",
                "missing_job",
                "ambiguous_job",
                "ambiguous_active",
                "run_id",
                "run_attempt",
                "head_sha",
                "head_branch",
                "changed_name",
                "changed_source",
            ):
                with self.subTest(raw=raw, defect=defect):
                    case = self.skipped_primary_case(raw)
                    inventory = case.jobs[(300, 2)]
                    job = inventory["jobs"][0]
                    if defect in {"failed", "cancelled"}:
                        job["conclusion"] = (
                            "failure" if defect == "failed" else "cancelled"
                        )
                    elif defect == "active":
                        job["status"] = "in_progress"
                    elif defect == "missing_steps":
                        del job["steps"]
                    elif defect == "started_step":
                        job["steps"] = [
                            {
                                "name": lease.BEGIN,
                                "status": "completed",
                                "conclusion": "success",
                            }
                        ]
                    elif defect == "missing_job":
                        inventory.update(total_count=0, jobs=[])
                    elif defect in {"ambiguous_job", "ambiguous_active"}:
                        duplicate = copy.deepcopy(job)
                        if defect == "ambiguous_active":
                            duplicate.update(
                                status="in_progress",
                                conclusion=None,
                                steps=[{"name": lease.BEGIN}],
                            )
                        inventory["jobs"].append(duplicate)
                        inventory["total_count"] = 2
                    elif defect in {"run_id", "run_attempt", "head_sha", "head_branch"}:
                        job[defect] = {
                            "run_id": 400,
                            "run_attempt": 1,
                            "head_sha": "f" * 40,
                            "head_branch": "dev",
                        }[defect]
                    elif defect == "changed_name":
                        job["name"] += " altered"
                    elif defect == "changed_source":
                        if not raw:
                            continue
                        sha = case.runs[0]["head_sha"]
                        case.sources[sha] = case.sources[sha].replace(
                            RAW_PRIMARY_NAME.encode(), b"'different primary job'"
                        )
                    with self.assertRaises(lease.retention.UnsafeState):
                        self.lease_check(case)

    def test_selected_producer_precedes_skipped_raw_primary_without_hiding_lease(self):
        self.setUp()
        case = LeaseFixture(self)
        case.intent_protocol()
        inventory = case.jobs[(300, 2)]
        raw = copy.deepcopy(inventory["jobs"][0])
        raw.update(
            name=RAW_PRIMARY_NAME, status="completed", conclusion="skipped", steps=[]
        )
        inventory["jobs"].append(raw)
        inventory["total_count"] = 2
        self.assertIsNone(self.lease_check(case))
        self.lease_defect(case, "deploy")
        with self.assertRaises(lease.retention.UnsafeState):
            self.lease_check(case)

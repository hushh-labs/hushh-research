"""Attempt-bound release receipt contracts, discovered by the retention suite."""

import copy
import hashlib
import importlib
import io
import json
import pathlib
import subprocess
import tempfile
import unittest
import zipfile
from unittest import mock

from production_backend_successor_cases import OperationalBackendReferenceCases
from production_pending_activation_cases import PendingActivationCases
from production_activation_continuation_cases import ActivationContinuationCases
from production_phone_receipt_cases import ProductionPhoneReceiptCases
from production_worker_basis_cases import WorkerBasisCases
from production_phone_lease_cases import (
    ProductionPhoneIntentGateCases,
    ProductionPhoneLeaseCases,
    ProductionPhoneSkippedLeaseCases,
)

from production_staged_worker_cases import (
    ProductionStagedWorkerCases as ProductionStagedWorkerCases,
    ProductionHealthyStagedWorkerCases as ProductionHealthyStagedWorkerCases,
)

MAINTENANCE = importlib.import_module("uat-retention-maintenance")


class ReplayedReleaseFixture:
    environment = "uat"

    def setUp(self):
        self.repo = "hushh-labs/hushh-research"
        self.prefix = "uat" if self.environment == "uat" else "prod"
        self.name = f"{self.prefix}-release-300"
        self.status_name = f"{self.prefix}-release-status.json"
        self.run = {
            "id": 300,
            "run_attempt": 2,
            "status": "completed",
            "conclusion": "failure",
            "head_sha": "a" * 40,
            "head_branch": "main",
            "event": "workflow_dispatch",
            "path": ".github/workflows/deploy-uat.yml"
            if self.environment == "uat"
            else ".github/workflows/deploy-production.yml",
            "actor": {"login": "ankitkumarsingh1702"},
            "repository": {"id": 7, "full_name": self.repo},
            "head_repository": {"id": 7, "full_name": self.repo},
        }
        self.upload = {
            "name": "Upload UAT deploy artifacts"
            if self.environment == "uat"
            else "Upload production deploy artifacts",
            "status": "completed",
            "conclusion": "success",
            "started_at": "2026-10-21T03:19:03Z",
            "completed_at": "2026-10-21T03:19:04Z",
        }
        self.jobs = {
            "total_count": 1,
            "jobs": [
                {
                    "name": "Deploy UAT Scope"
                    if self.environment == "uat"
                    else "Deploy Production Scope",
                    "run_id": 300,
                    "run_attempt": 2,
                    "head_sha": self.run["head_sha"],
                    "head_branch": "main",
                    "status": "completed",
                    "conclusion": "failure",
                    "steps": [self.upload],
                }
            ],
        }
        self.artifact = {
            "id": 100,
            "name": self.name,
            "expired": False,
            "created_at": "2026-10-21T03:19:03Z",
            "size_in_bytes": 100,
            "digest": "sha256:" + "b" * 64,
            "workflow_run": {
                "id": 300,
                "repository_id": 7,
                "head_repository_id": 7,
                "head_sha": self.run["head_sha"],
                "head_branch": "main",
            },
        }
        self.inventory = {
            "total_count": 2,
            "artifacts": [
                {
                    **copy.deepcopy(self.artifact),
                    "id": 200,
                    "created_at": "2026-10-21T02:52:41Z",
                },
                self.artifact,
            ],
        }

    def api(self, _repository, endpoint):
        if endpoint == "runs/300":
            return self.run
        if endpoint == "runs/300/artifacts?per_page=100":
            return self.inventory
        if endpoint == "runs/300/attempts/2/jobs?per_page=100":
            return self.jobs
        self.fail("unexpected authority lookup: " + endpoint)

    def archive(self, defect=None):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as bundle:
            if defect == "symlink":
                entry = zipfile.ZipInfo(self.status_name)
                entry.external_attr = 0o120777 << 16
                bundle.writestr(entry, "target")
            else:
                status_name = (
                    (
                        "prod-release-status.json"
                        if self.environment == "uat"
                        else "uat-release-status.json"
                    )
                    if defect == "wrong_lane"
                    else self.status_name
                )
                bundle.writestr(
                    status_name,
                    json.dumps(
                        {
                            "status": "healthy"
                            if self.environment == "production"
                            else "rolled_back",
                            "marker": "attempt-two",
                        }
                    ),
                )
            bundle.writestr("other-evidence.json", "must not be extracted")
            if defect == "traversal":
                bundle.writestr("../escape", "invalid")
        archive = output.getvalue()
        self.artifact.update(
            size_in_bytes=len(archive),
            digest="sha256:" + hashlib.sha256(archive).hexdigest(),
        )
        return archive

    def apply_defect(self, defect):
        if defect == "fork":
            self.run["head_repository"]["full_name"] = "other/repo"
        elif defect == "actor":
            self.run["actor"]["login"] = "unapproved"
        elif defect == "attempt":
            self.run["run_attempt"] = 1
        elif defect == "job_attempt":
            self.jobs["jobs"][0]["run_attempt"] = 1
        elif defect == "job_sha":
            self.jobs["jobs"][0]["head_sha"] = "c" * 40
        elif defect == "partial_jobs":
            self.jobs["total_count"] = 2
        elif defect == "partial_artifacts":
            self.inventory["total_count"] = 3
        elif defect == "upload_failed":
            self.upload["conclusion"] = "failure"
        elif defect == "duplicate_upload":
            self.jobs["jobs"][0]["steps"].append(copy.deepcopy(self.upload))
        elif defect == "window":
            self.upload["completed_at"] = "2026-10-21T03:19:02Z"
        elif defect == "artifact_origin":
            self.artifact["workflow_run"]["head_sha"] = "c" * 40
        elif defect == "artifact_time":
            self.artifact["created_at"] = "invalid"
        elif defect == "ambiguous":
            self.inventory["artifacts"][0]["created_at"] = self.artifact["created_at"]
        elif defect == "expired":
            self.artifact["expired"] = True
        elif defect == "lane":
            self.run["path"] = (
                ".github/workflows/"
                + MAINTENANCE.LANES[
                    "production" if self.environment == "uat" else "uat"
                ]["workflow"]
            )
        elif defect == "job_name":
            self.jobs["jobs"][0]["name"] = "Another lane's deployment"
        elif defect == "upload_name":
            self.upload["name"] = "Another lane's upload"
        elif defect == "name":
            self.name = (
                "prod-release-300" if self.environment == "uat" else "uat-release-300"
            )


class ReplayedUatReleaseArtifactTest(ReplayedReleaseFixture, unittest.TestCase):
    def test_duplicate_names_require_exact_attempt_and_one_upload_window(self):
        for defect in (
            None,
            "fork",
            "actor",
            "attempt",
            "job_attempt",
            "job_sha",
            "partial_jobs",
            "partial_artifacts",
            "upload_failed",
            "duplicate_upload",
            "window",
            "artifact_origin",
            "artifact_time",
            "ambiguous",
            "expired",
            "lane",
            "job_name",
            "upload_name",
            "name",
        ):
            with self.subTest(defect=defect):
                self.setUp()
                self.apply_defect(defect)
                with mock.patch.object(MAINTENANCE, "api", side_effect=self.api):
                    if defect is None:
                        found = MAINTENANCE.replayed_release_artifact(
                            self.repo, 300, self.name, self.environment
                        )
                        self.assertEqual(found["id"], 100)  # not the greatest ID
                    else:
                        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                            MAINTENANCE.replayed_release_artifact(
                                self.repo, 300, self.name, self.environment
                            )

    def test_load_release_pins_id_digest_and_ignores_a_stale_attempt_cache(self):
        archive = self.archive()
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            old = directory / "300"
            old.mkdir()
            (old / self.status_name).write_text('{"marker":"old-attempt"}')
            with (
                mock.patch.object(MAINTENANCE, "api", side_effect=self.api),
                mock.patch.object(
                    MAINTENANCE,
                    "download",
                    side_effect=AssertionError("name download refused"),
                ),
                mock.patch.object(
                    MAINTENANCE.retention,
                    "run_command",
                    return_value=subprocess.CompletedProcess([], 0, archive, b""),
                ) as fetch,
            ):
                result = MAINTENANCE.load_release(
                    self.repo, 300, directory, self.environment
                )
                self.assertEqual(result["marker"], "attempt-two")
                self.assertIn("/artifacts/100/zip", fetch.call_args.args[0][-1])
                self.assertEqual(
                    list((directory / "300-artifact-100").iterdir()),
                    [directory / "300-artifact-100" / self.status_name],
                )

    def test_replayed_release_rejects_corrupt_or_unsafe_archives(self):
        for defect in ("digest", "size", "symlink", "traversal", "wrong_lane"):
            with (
                self.subTest(defect=defect),
                tempfile.TemporaryDirectory() as temporary,
            ):
                archive = self.archive(defect)
                if defect == "digest":
                    self.artifact["digest"] = "sha256:" + "0" * 64
                if defect == "size":
                    self.artifact["size_in_bytes"] += 1
                with mock.patch.object(
                    MAINTENANCE.retention,
                    "run_command",
                    return_value=subprocess.CompletedProcess([], 0, archive, b""),
                ):
                    with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                        MAINTENANCE.download_replayed_release(
                            self.repo,
                            self.artifact,
                            pathlib.Path(temporary) / "release",
                            self.environment,
                        )


class ReplayedProductionReleaseArtifactTest(
    PendingActivationCases,
    ActivationContinuationCases,
    OperationalBackendReferenceCases,
    ProductionPhoneIntentGateCases,
    ProductionPhoneLeaseCases,
    ProductionPhoneSkippedLeaseCases,
    ProductionPhoneReceiptCases,
    WorkerBasisCases,
    ReplayedUatReleaseArtifactTest,
):
    environment = "production"
    maintenance = MAINTENANCE

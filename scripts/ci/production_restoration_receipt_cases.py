"""Recorded restoration serving-reference regressions for the receipt owner."""

import copy
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
from unittest import mock
from zipfile import ZipFile

import production_restoration_receipt as restoration


def _operation_fixture(owner, attempt):
    job = owner.jobs["jobs"][0]
    job.update(
        conclusion="success",
        run_attempt=attempt,
        steps=[
            {"name": name, "status": "completed", "conclusion": "success"}
            for name in restoration.STEPS
        ]
        + [owner.upload],
    )
    baseline = next(
        step
        for step in job["steps"]
        if step["name"] == "Upload immutable recovery baseline"
    )
    baseline.update(
        started_at="2026-10-21T03:17:03Z", completed_at="2026-10-21T03:17:04Z"
    )
    operation = {
        **copy.deepcopy(owner.artifact),
        "id": 101,
        "name": f"production-restoration-operation-300-{attempt}",
        "created_at": "2026-10-21T03:17:03Z",
    }
    owner.inventory = {"total_count": 2, "artifacts": [owner.artifact, operation]}
    return operation


class RestorationServingReceiptCases:
    def restoration_fixture(self, attempt=2):
        path = restoration.ROOT / "deploy/account-deletion/production-restoration.json"
        record, digest = (
            json.loads(path.read_bytes()),
            hashlib.sha256(path.read_bytes()).hexdigest(),
        )
        self.run.update(
            conclusion="success", run_attempt=attempt, actor={"login": "kushaltrivedi5"}
        )
        previous = record["previousServices"]["consent-protocol"]
        admission = {
            "status": "validated",
            "scope": "production-restoration-only",
            "sourceSha": record["sourceSha"],
            "workflowSha": "d" * 40,
            "runId": 250,
            "runAttempt": 1,
            "artifactId": 90,
            "artifactDigest": "sha256:" + "e" * 64,
        }
        release = {
            "status": "healthy",
            "scope": "all",
            "sha": record["sourceSha"],
            "candidate": {
                "backend_revision": "consent-protocol-restored",
                "frontend_revision": "hushh-webapp-restored",
            },
            "predeploy": {"backend_revision": previous["revision"]},
            "phone_rollback": {
                "revision": previous["revision"],
                "qualification": "success",
                "recovery_enabled": "false",
            },
            "production_restoration": admission,
        }
        release["final"] = copy.deepcopy(release["candidate"])
        plan = {
            "schemaVersion": 1,
            "runId": "300",
            "workflowSha": self.run["head_sha"],
            "sourceSha": record["sourceSha"],
            "recordSha256": digest,
            "previous": copy.deepcopy(record["previousServices"]),
        }
        qualified = {
            "schema_version": 1,
            "qualification": "passed",
            "project": "hushh-pda",
            "region": "us-central1",
            "revision": previous["revision"],
            "source": previous["sha"],
            "image": previous["image"],
            "mode": "production-restoration",
            "run_id": "300",
        }
        operation = _operation_fixture(self, attempt)
        documents = {
            "prod-release-status.json": release,
            "prod-restoration-validation.json": copy.deepcopy(admission),
            "phone-rollback/qualified.json": qualified,
        }
        return {
            "record": record,
            "digest": digest,
            "release": release,
            "documents": documents,
            "operation": operation,
            "plan": plan,
        }

    def restoration_archives(self, fixture):
        archives = {}
        for item, documents in (
            (self.artifact, fixture["documents"]),
            (fixture["operation"], {"acceptance.json": fixture["plan"]}),
        ):
            buffer = io.BytesIO()
            with ZipFile(buffer, "w") as bundle:
                for name, value in documents.items():
                    bundle.writestr(name, json.dumps(value))
            archives[item["id"]] = buffer.getvalue()
            item.update(
                size_in_bytes=len(buffer.getvalue()),
                digest="sha256:" + hashlib.sha256(buffer.getvalue()).hexdigest(),
            )
        return archives

    def restoration_find(self, fixture, archives):
        owner, calls, anchors = self.maintenance, [], []

        def api(repository, endpoint):
            if (
                endpoint
                == f"runs/300/attempts/{self.run['run_attempt']}/jobs?per_page=100"
            ):
                return self.jobs
            if endpoint == "runs/300" and fixture.get("refresh") and calls:
                return {**self.run, "run_attempt": self.run["run_attempt"] + 1}
            return self.api(repository, endpoint)

        def fetch(arguments, **kwargs):
            self.assertGreater(kwargs["timeout"], 0)
            identity = int(arguments[-1].split("/")[-2])
            self.assertEqual(
                arguments,
                ["gh", "api", f"repos/{self.repo}/actions/artifacts/{identity}/zip"],
            )
            calls.append(identity)
            return subprocess.CompletedProcess(arguments, 0, archives[identity], b"")

        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.object(owner, "api", side_effect=api),
            mock.patch.object(owner, "load_release", return_value=fixture["release"]),
            mock.patch.object(owner.retention, "run_command", side_effect=fetch),
            mock.patch.object(
                restoration,
                "source_record",
                return_value=(fixture["record"], fixture["digest"]),
            ),
        ):
            result = owner.find_release(
                self.repo,
                "300",
                Path(temporary),
                require_live=False,
                environment="production",
                on_phone_rollback=anchors.append,
            )
        return result, calls, anchors

    def test_restoration_serving_receipt_preserves_health_without_phone_authority(self):
        for attempt in (1, 2):
            with self.subTest(attempt=attempt):
                self.setUp()
                fixture = self.restoration_fixture(attempt)
                original = copy.deepcopy(fixture["release"])
                result, calls, anchors = self.restoration_find(
                    fixture, self.restoration_archives(fixture)
                )
                self.assertEqual(result, (300, original))
                self.assertEqual(fixture["release"], original)
                self.assertEqual(anchors, [])
                self.assertEqual(calls, [100, 101])

    def test_restoration_serving_receipt_refuses_unbound_or_failed_evidence(self):
        defects = (
            "summary_only",
            "mode_only",
            "rolled_back",
            "operation_missing",
            "plan_source",
            "plan_run",
            "plan_workflow",
            "record_hash",
            "previous",
            "qualified",
            "gate",
            "attempt",
            "upload_window",
            "origin",
            "digest",
            "size",
            "serving",
            "admission",
            "archive_status",
            "refresh",
        )
        for defect in defects:
            with self.subTest(defect=defect):
                self.setUp()
                fixture = self.restoration_fixture()
                if defect == "summary_only":
                    fixture["documents"].pop("phone-rollback/qualified.json")
                elif defect == "mode_only":
                    fixture["release"]["production_restoration"] = {}
                elif defect == "rolled_back":
                    fixture["release"]["status"] = "rolled_back"
                elif defect == "operation_missing":
                    self.inventory.update(total_count=1, artifacts=[self.artifact])
                elif defect.startswith("plan_"):
                    key = {
                        "plan_source": "sourceSha",
                        "plan_run": "runId",
                        "plan_workflow": "workflowSha",
                    }[defect]
                    fixture["plan"][key] = "9" * 40
                elif defect == "record_hash":
                    fixture["plan"]["recordSha256"] = "0" * 64
                elif defect == "previous":
                    fixture["plan"]["previous"]["consent-protocol"]["revision"] = (
                        "consent-protocol-other"
                    )
                elif defect == "qualified":
                    fixture["documents"]["phone-rollback/qualified.json"]["run_id"] = (
                        "299"
                    )
                elif defect == "gate":
                    self.jobs["jobs"][0]["steps"][0]["conclusion"] = "skipped"
                elif defect == "attempt":
                    fixture["operation"]["name"] = (
                        "production-restoration-operation-300-1"
                    )
                elif defect == "upload_window":
                    fixture["operation"]["created_at"] = "2026-10-21T02:17:03Z"
                elif defect == "origin":
                    fixture["operation"]["workflow_run"]["head_sha"] = "0" * 40
                elif defect == "serving":
                    fixture["release"]["final"]["backend_revision"] = (
                        "consent-protocol-other"
                    )
                elif defect == "admission":
                    fixture["documents"]["prod-restoration-validation.json"][
                        "artifactDigest"
                    ] = "invalid"
                archives = self.restoration_archives(fixture)
                if defect == "digest":
                    fixture["operation"]["digest"] = "sha256:" + "0" * 64
                elif defect == "size":
                    fixture["operation"]["size_in_bytes"] += 1
                elif defect == "archive_status":
                    fixture["release"]["unarchived"] = True
                fixture["refresh"] = defect == "refresh"
                with self.assertRaises(self.maintenance.retention.UnsafeState):
                    self.restoration_find(fixture, archives)

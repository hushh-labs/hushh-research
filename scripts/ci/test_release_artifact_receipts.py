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
from types import SimpleNamespace
from unittest import mock

from production_activation_continuation_cases import ActivationContinuationCases
from production_backend_inheritance_cases import BackendInheritanceCases
from production_backend_successor_cases import OperationalBackendReferenceCases
from production_pending_activation_cases import PendingActivationCases
from production_phone_lease_cases import (
    ProductionPhoneIntentGateCases,
    ProductionPhoneLeaseCases,
    ProductionPhoneSkippedLeaseCases,
)
from production_phone_receipt_cases import ProductionPhoneReceiptCases
from production_restoration_continuation_cases import (
    RestorationContinuationCases,
    _archive,
    _continuation_case,
    _fresh_continuation,
)
from production_restoration_receipt_cases import RestorationServingReceiptCases
from production_staged_worker_cases import (
    ProductionHealthyStagedWorkerCases as ProductionHealthyStagedWorkerCases,
)
from production_staged_worker_cases import (
    ProductionStagedWorkerCases as ProductionStagedWorkerCases,
)
from production_worker_basis_cases import WorkerBasisCases, _acceptance, _runtime, _tag

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
                if defect in {"legacy", "both"}:
                    status_name = "tmp/prod-release-status.json"
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
                if defect == "both":
                    bundle.writestr(self.status_name, '{"status":"healthy"}')
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
                if self.environment == "production":
                    self.assertFalse((directory / "300-artifact-100").exists())
                else:
                    self.assertEqual(
                        list((directory / "300-artifact-100").iterdir()),
                        [directory / "300-artifact-100" / self.status_name],
                    )

    def test_replayed_release_rejects_corrupt_or_unsafe_archives(self):
        defects = ("digest", "size", "symlink", "traversal", "wrong_lane")
        for defect in defects + (("both",) if self.environment == "production" else ()):
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

    def test_legacy_production_status_is_bound_to_current_upload_and_digest(self):
        if self.environment != "production":
            return
        archive = self.archive("legacy")
        self.inventory = {"total_count": 1, "artifacts": [self.artifact]}
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            (directory / "300").mkdir()
            (directory / "300" / self.status_name).write_text('{"status":"forged"}')
            outside = directory / "outside"
            outside.mkdir()
            (outside / self.status_name).write_text('{"status":"forged"}')
            (directory / "300-artifact-100").symlink_to(outside, target_is_directory=True)

            with (
                mock.patch.object(MAINTENANCE, "api", side_effect=self.api),
                mock.patch.object(MAINTENANCE, "download", side_effect=AssertionError("filesystem cache is not authority")),
                mock.patch.object(
                    MAINTENANCE.retention,
                    "run_command",
                    return_value=subprocess.CompletedProcess([], 0, archive, b""),
                ),
            ):
                result = MAINTENANCE.load_release(self.repo, 300, directory, self.environment)
                self.assertEqual(result["marker"], "attempt-two")
                self.assertEqual(result["status"], "healthy")
                self.artifact["digest"] = "sha256:" + "0" * 64
                with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                    MAINTENANCE.load_release(self.repo, 300, directory, self.environment)
                self.artifact["digest"] = "sha256:" + hashlib.sha256(archive).hexdigest()
                calls = 0

                def rerun(repository, endpoint):
                    nonlocal calls
                    result = copy.deepcopy(self.api(repository, endpoint))
                    if endpoint == "runs/300":
                        calls += 1
                        if calls == 2:
                            result["run_attempt"] += 1
                    return result

                with mock.patch.object(MAINTENANCE, "api", side_effect=rerun):
                    with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                        MAINTENANCE.load_release(self.repo, 300, directory, self.environment)

    def test_production_release_refuses_a_changed_attempt_or_new_artifact(self):
        if self.environment != "production":
            return
        for defect in (None, "run", "artifact"):
            self.setUp()
            self.inventory = {"total_count": 0, "artifacts": []}
            calls = {"run": 0, "artifact": 0}

            def changing_api(repository, endpoint):
                result = copy.deepcopy(self.api(repository, endpoint))
                key = "artifact" if "/artifacts?" in endpoint else "run"
                calls[key] += 1
                if calls[key] == 2 and defect == key:
                    if key == "run":
                        result["run_attempt"] += 1
                    else:
                        result = {"total_count": 1, "artifacts": [self.artifact]}
                return result

            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temporary:
                with mock.patch.object(MAINTENANCE, "api", side_effect=changing_api):
                    if defect is None:
                        self.assertIsNone(MAINTENANCE.load_release(self.repo, 300, pathlib.Path(temporary), self.environment))
                    else:
                        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                            MAINTENANCE.load_release(self.repo, 300, pathlib.Path(temporary), self.environment)

    def test_snapshot_recheck_bypasses_the_real_maintenance_api_cache(self):
        if self.environment != "production":
            return
        for defect in ("run", "artifact"):
            self.setUp()
            inventory = {"total_count": 0, "artifacts": []}
            calls = {"run": 0, "artifact": 0}

            def command(*args):
                key = "artifact" if "/artifacts?" in args[-1] else "run"
                calls[key] += 1
                value = copy.deepcopy(inventory if key == "artifact" else self.run)
                if calls[key] == 2 and key == defect:
                    if key == "run":
                        value["run_attempt"] += 1
                    else:
                        value = {"total_count": 1, "artifacts": [self.artifact]}
                return json.dumps(value)

            cache = MAINTENANCE._API_CACHE.set({})
            try:
                with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temporary:
                    with mock.patch.object(MAINTENANCE, "command", side_effect=command):
                        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                            MAINTENANCE.load_release(self.repo, 300, pathlib.Path(temporary), self.environment)
                self.assertGreaterEqual(calls[defect], 2)
            finally:
                MAINTENANCE._API_CACHE.reset(cache)


class ReplayedProductionReleaseArtifactTest(
    RestorationServingReceiptCases,
    RestorationContinuationCases,
    BackendInheritanceCases,
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

    def restoration_runtimes(self, original, documents, continuation, basis):
        runtimes = {}
        for lane, service in (("backend", "consent-protocol"), ("frontend", "hushh-webapp")):
            identity = documents[continuation.ORIGIN]["runtime"][lane]
            state, revision = _runtime(service, original["source"], "300", identity["uid"], identity["revision"])
            state["metadata"]["uid"] = identity["service_uid"]
            revision["spec"]["serviceAccountName"] = original["previous"][service]["runtimePrincipal"]
            revision["spec"]["containers"][0]["image"] = identity["image"]
            revision["status"]["imageDigest"] = identity["image"]
            if lane == "backend":
                revision["spec"]["containers"][0]["env"] += [
                    {"name": key, "value": "false"} for key in (
                        "AUTH_PHONE_RECOVERY_ENABLED", "WORKOS_SSO_ENABLED", "ACCOUNT_GENERATION_ADMISSION_ENABLED",
                        "PROTECTED_DOCUMENT_DELIVERY_ENABLED", "DRIVE_WORK_DRAIN_ENABLED")]
            runtimes[service] = state, revision
        runtimes[basis.WORKER] = _runtime(basis.WORKER, "a" * 40, "200", "worker-uid", basis.WORKER + "-current")
        runtime = SimpleNamespace(retention=SimpleNamespace(
            service_state=lambda service, *_: runtimes[service][0],
            revision_state=lambda service, *_: [runtimes[service][1]], traffic_state=self.maintenance.retention.traffic_state))
        documents[continuation.ORIGIN]["runtime"] = continuation.runtime_pair(original, runtime)
        return runtimes

    def test_hosted_restoration_reaches_worker_basis_through_actual_release_readers(self):
        import production_restoration_continuation as continuation
        import production_worker_basis as basis

        with _continuation_case(self) as (fixture, arguments):
            original = continuation.load_original("300", 2, fixture["record"]["sourceSha"], **arguments)
            run, release, job, documents = _fresh_continuation(self, original)
            owner = self.maintenance
            runtimes = self.restoration_runtimes(original, documents, continuation, basis)
            documents.update({"prod-release-status.json": release,
                              "prod-protected-document-release.json": {"configured": False, "enabled": False}})
            archive = _archive(documents)
            artifact = {**copy.deepcopy(self.artifact), "id": 102, "name": "prod-release-400",
                        "size_in_bytes": len(archive), "digest": "sha256:" + hashlib.sha256(archive).hexdigest()}
            artifact["workflow_run"]["id"] = 400
            job = {**self.jobs["jobs"][0], **job, "run_id": 400, "run_attempt": 1, "steps": job["steps"] + [self.upload]}
            acceptance, client, _ = _acceptance()
            tag = _tag(SimpleNamespace(release=release))
            tag = basis.proof.reference.tag_identity(tag["tag_object"].replace("runs/500", "runs/400"))

            def api(repository, endpoint):
                responses = {
                    "runs/400": run, "runs/400/artifacts?per_page=100": {"total_count": 1, "artifacts": [artifact]},
                    "runs/400/attempts/1/jobs?per_page=100": {"total_count": 1, "jobs": [job]},
                    "workflows/deploy-production.yml/runs?branch=main&status=completed&per_page=50": {"workflow_runs": [run]},
                }
                return responses[endpoint] if endpoint in responses else arguments["api"](repository, endpoint)

            def fetch(command, **kwargs):
                if command[-1].endswith("/artifacts/102/zip"):
                    return subprocess.CompletedProcess(command, 0, archive, b"")
                return arguments["run_command"](command, **kwargs)

            def download(*command):
                destination = pathlib.Path(command[command.index("--dir") + 1])
                destination.mkdir(parents=True)
                with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
                    (destination / "prod-release-status.json").write_bytes(bundle.read("prod-release-status.json"))
                return ""

            with (
                tempfile.TemporaryDirectory() as directory,
                mock.patch.object(owner, "api", side_effect=api), mock.patch.object(owner, "command", side_effect=download),
                mock.patch.object(owner.retention, "run_command", side_effect=fetch),
                mock.patch.object(owner.retention, "service_state", side_effect=lambda service, *_: copy.deepcopy(runtimes[service][0])),
                mock.patch.object(owner.retention, "revision_state", side_effect=lambda service, *_: [copy.deepcopy(runtimes[service][1])]),
                mock.patch.object(basis, "_owners", return_value=(owner, acceptance)),
                mock.patch.object(acceptance, "GitHub", return_value=client),
                mock.patch.object(basis.proof, "read_original", return_value=tag),
            ):
                found = owner.find_release(self.repo, "", pathlib.Path(directory), environment="production")
                self.assertEqual(found[0], 400)
                self.assertTrue(owner.live_release_matches(found[1], environment="production"))
                qualified = basis.load("f" * 40, release_run_id="400")
                self.assertEqual(qualified["healthy"]["run_id"], "400")
                self.assertEqual(qualified["backend"]["runtime_run_id"], "300")
                self.assertEqual(
                    qualified["backend"]["uid"],
                    documents[continuation.ORIGIN]["runtime"]["backend"]["uid"],
                )
                baseline = copy.deepcopy(runtimes)
                for defect in ("uid", "image", "run", "traffic"):
                    with self.subTest(defect=defect):
                        runtimes = copy.deepcopy(baseline)
                        state, revision = runtimes["consent-protocol"]
                        if defect == "uid":
                            revision["metadata"]["uid"] = "replacement-uid"
                        elif defect == "image":
                            revision["status"]["imageDigest"] = "gcr.io/hushh-pda/consent-protocol@sha256:" + "e" * 64
                        elif defect == "run":
                            revision["metadata"]["labels"]["github-run-id"] = "400"
                        else:
                            state["status"]["traffic"][0]["percent"] = 50
                        with self.assertRaises(owner.retention.UnsafeState):
                            basis.load("f" * 40, release_run_id="400")


class CheckpointArchiveFixture:
    def setUp(self):
        self.receipts = MAINTENANCE.release_artifact_receipts
        self.services = tuple(MAINTENANCE.LANES["uat"]["services"])
        completed = {
            "schema_version": 1,
            "checkpoint_version": 2,
            "environment": "uat",
            "project": "hushh-pda-uat",
            "release_run_id": 123,
            "observed_run_id": 123,
            "pass_status": "complete",
            "pending_services": [],
        }
        self.full = {
            "README.txt": b"uat checkpoint\n",
            "completed.json": json.dumps(completed).encode(),
            **{name + ".json": b'{"pending_mutation":null}' for name in self.services},
        }
        self.missing = {
            name: value for name, value in self.full.items() if name != "README.txt"
        }

    def archive(self, members, *, mode=None):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as bundle:
            for name, value in members.items():
                entry = zipfile.ZipInfo(name)
                entry.external_attr = (
                    mode if name == "README.txt" and mode is not None else 0o100600
                ) << 16
                bundle.writestr(entry, value)
        return stream.getvalue()


class CheckpointArchiveCopyTest(CheckpointArchiveFixture, unittest.TestCase):
    def test_checkpoint_archive_explicit_marker_policy_and_closed_file_set(self):
        archive = self.archive(self.missing)
        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
            self.receipts.checkpoint_archive(archive, self.services)
        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
            self.receipts.checkpoint_archive(
                archive, self.services, allow_missing_readme="true"
            )
        self.assertEqual(
            self.receipts.checkpoint_archive(
                archive, self.services, allow_missing_readme=True
            ),
            self.missing,
        )
        for members, mode in (
            ({**self.full, "../outside.json": b"{}"}, None),
            (self.full, 0o120777),
            (
                {
                    name: value
                    for name, value in self.missing.items()
                    if name != "completed.json"
                },
                None,
            ),
        ):
            with (
                self.subTest(mode=mode),
                self.assertRaises(MAINTENANCE.retention.UnsafeState),
            ):
                self.receipts.checkpoint_archive(
                    self.archive(members, mode=mode),
                    self.services,
                    allow_missing_readme=True,
                )

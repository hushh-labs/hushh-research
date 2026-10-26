"""Immutable worker staging provenance and preparation clock regression cases."""

import copy
import hashlib
import json
import subprocess
import time
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from runpy import run_path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import mock

import production_staged_worker as worker
from production_phone_receipt_fixtures import archive


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


class StagedWorkerFixture:
    def setUp(self):
        self.now = int(time.time())
        source, image = "a" * 40, "gcr.io/hushh-pda/consent-protocol@sha256:" + "b" * 64
        self.anchor = {
            "sealed_boundary": {
                "checkpoint": {"plan": {"primary_sha": source}},
                "primary_image": image,
                "document_mode": {"enabled": False},
            }
        }
        self.run = {
            "id": 300,
            "run_attempt": 2,
            "status": "completed",
            "conclusion": "success",
            "head_sha": "c" * 40,
            "path": worker.WORKFLOW,
            "repository": {"id": 7},
            "head_repository": {"id": 7},
        }
        self.scheduler = {
            "schema": "drive.scheduler.prod.snapshot.v1",
            "jobs": {name: None for name in worker._scheduler_owner()["JOB_STAGES"]},
        }
        fields = {
            "source": source,
            "image": image,
            "run_id": "300",
            "attempt": "2",
            "config_secret": "BACKEND_RUNTIME_CONFIG_JSON_DRIVE_300_2",
            "protected": "false",
        }
        serving = worker.SERVICE + "-00123-old"
        self.prepared = {
            "schema": "drive.worker.stage.v1",
            "status": "prepared",
            "project": worker.PROJECT,
            "service": worker.SERVICE,
            "context": fields,
            "expires": self.now - 95 + 21600,
            "baseline": {
                "uid": "worker-service-uid",
                "controls": "d" * 64,
                "traffic": [{"revisionName": serving, "percent": 100}],
                "serving": serving,
                "iam": "e" * 64,
                "scheduler": worker._hash(self.scheduler),
            },
            "baseline_template": "f" * 64,
            "candidate": worker.SERVICE + "-s-300-2",
            "config_version": "42",
            "template": "1" * 64,
        }
        self.staged = {
            **copy.deepcopy(self.prepared),
            "status": "staged",
            "candidate_uid": "staged-revision-uid",
            "candidate_spec": "2" * 64,
        }
        self.bind_prepared()
        self.jobs = self.job_inventory()
        self.artifact, self.intent_artifact = self.artifact_inventory()
        self.governed = True

    def artifact_inventory(self):
        artifact = {
            "id": 100,
            "name": "prod-drive-worker-stage-300-2",
            "expired": False,
            "created_at": self.instant(-22),
            "workflow_run": {
                "id": 300,
                "head_sha": self.run["head_sha"],
                "head_branch": "main",
                "repository_id": 7,
                "head_repository_id": 7,
            },
        }
        intent = {
            **copy.deepcopy(artifact),
            "id": 101,
            "name": "prod-drive-worker-intent-300-2",
            "created_at": self.instant(-86),
        }
        return artifact, intent

    def instant(self, offset):
        return datetime.fromtimestamp(self.now + offset, timezone.utc).isoformat()

    def bind_prepared(self):
        self.staged["prepared_sha256"] = hashlib.sha256(
            json.dumps(self.prepared).encode()
        ).hexdigest()

    def job_inventory(self):
        windows = {
            worker.PREPARE: (-100, -90),
            worker.INTENT: (-88, -85),
            worker.STAGE: (-80, -30),
            worker.UPLOAD: (-25, -20),
        }
        steps = [
            {
                "name": name,
                "status": "completed",
                "conclusion": "success",
                "started_at": self.instant(windows.get(name, (-120, -110))[0]),
                "completed_at": self.instant(windows.get(name, (-120, -110))[1]),
            }
            for name in worker.STEPS
        ]
        return {
            "total_count": 1,
            "jobs": [
                {
                    "name": worker.JOB,
                    "run_id": 300,
                    "run_attempt": 2,
                    "head_sha": self.run["head_sha"],
                    "head_branch": "main",
                    "status": "completed",
                    "conclusion": "success",
                    "steps": steps,
                }
            ],
        }

    def api(self, _repository, endpoint):
        if endpoint == "runs/300":
            return copy.deepcopy(self.run)
        if "/jobs?" in endpoint:
            return copy.deepcopy(self.jobs)
        if "/artifacts?" in endpoint:
            return {
                "total_count": 2,
                "artifacts": [
                    copy.deepcopy(self.artifact),
                    copy.deepcopy(self.intent_artifact),
                ],
            }
        raise AssertionError(endpoint)

    def load(
        self,
        *,
        documents=None,
        corrupt=False,
        api=None,
        intent_documents=None,
        release_basis=None,
        healthy_release_run_id=None,
        source_only=False,
    ):
        documents = documents or dict(
            zip(worker.FILES, (self.prepared, self.staged, self.scheduler))
        )
        payload = archive(self, documents)
        intent_payload = archive(
            SimpleNamespace(artifact=self.intent_artifact),
            intent_documents
            or {worker.FILES[0]: self.prepared, worker.FILES[2]: self.scheduler},
        )
        if corrupt:
            self.artifact["digest"] = "sha256:" + "0" * 64
        return worker.load_worker(
            "300",
            None
            if release_basis is not None or healthy_release_run_id is not None
            else self.anchor,
            release_basis=release_basis,
            healthy_release_run_id=healthy_release_run_id,
            source_only=source_only,
            api=api or self.api,
            governed=lambda *_args: self.governed,
            timestamp=timestamp,
            run_command=lambda command, **_kwargs: subprocess.CompletedProcess(
                [], 0, intent_payload if "/101/" in command[-1] else payload, b""
            ),
            timeout=30,
        )


class ProductionStagedWorkerCases(StagedWorkerFixture, unittest.TestCase):
    def test_exact_artifact_returns_only_fixed_original_bytes_and_retention_context(
        self,
    ):
        result = self.load()
        self.assertEqual(set(result["files"]), set(worker.FILES))
        self.assertEqual(
            result["files"][worker.FILES[0]], json.dumps(self.prepared).encode()
        )
        context = result["context"]
        self.assertEqual(context["revision"], self.prepared["candidate"])
        self.assertEqual(context["uid"], self.staged["candidate_uid"])
        self.assertEqual(context["service_uid"], self.prepared["baseline"]["uid"])
        self.assertEqual(
            context["source"],
            self.anchor["sealed_boundary"]["checkpoint"]["plan"]["primary_sha"],
        )
        self.assertEqual(context["origin"]["artifact_digest"], self.artifact["digest"])
        self.assertEqual(context["prepared_intent"]["artifact_id"], 101)
        json.dumps(context)  # File bytes never enter the serializable context.

    def test_mixed_context_or_mutated_prepared_intent_is_refused(self):
        for change in (
            "source",
            "image",
            "secret",
            "attempt",
            "uid",
            "prepared-hash",
            "baseline",
        ):
            self.setUp()
            if change in {"source", "image"}:
                self.anchor["sealed_boundary"][
                    "primary_image" if change == "image" else "checkpoint"
                ] = (
                    "gcr.io/hushh-pda/consent-protocol@sha256:" + "0" * 64
                    if change == "image"
                    else {"plan": {"primary_sha": "0" * 40}}
                )
            elif change in {"secret", "attempt"}:
                self.staged["context"][
                    "config_secret" if change == "secret" else "attempt"
                ] = "other"
            elif change == "uid":
                self.staged["candidate_uid"] = True
            elif change == "prepared-hash":
                self.staged["prepared_sha256"] = "0" * 64
            else:
                self.staged["baseline"]["uid"] = "other"
            with (
                self.subTest(change=change),
                self.assertRaises(worker.receipts.retention.UnsafeState),
            ):
                self.load()

    def test_expiry_is_original_six_hour_preparation_clock(self):
        for expiry in (self.now - 1, self.now + 86400, True):
            self.prepared["expires"] = self.staged["expires"] = expiry
            self.bind_prepared()
            with (
                self.subTest(expiry=expiry),
                self.assertRaisesRegex(
                    worker.receipts.retention.UnsafeState, "six-hour"
                ),
            ):
                self.load()

    def test_failed_gates_or_late_intent_never_authorize_staging(self):
        for change in ("intent", "stage-order", "job", "ungoverned", "attempt"):
            self.setUp()
            steps = {row["name"]: row for row in self.jobs["jobs"][0]["steps"]}
            if change == "intent":
                steps[worker.INTENT]["conclusion"] = "failure"
            elif change == "stage-order":
                steps[worker.INTENT]["completed_at"] = self.instant(-70)
            elif change == "job":
                self.jobs["jobs"][0]["conclusion"] = "failure"
            elif change == "ungoverned":
                self.governed = False
            else:
                self.jobs["jobs"][0]["run_attempt"] = 1
            with (
                self.subTest(change=change),
                self.assertRaises(worker.receipts.retention.UnsafeState),
            ):
                self.load()

    def test_scheduler_hash_cannot_hide_missing_job_or_unreviewed_target(self):
        self.scheduler["jobs"].pop(next(iter(self.scheduler["jobs"])))
        self.prepared["baseline"]["scheduler"] = self.staged["baseline"][
            "scheduler"
        ] = worker._hash(self.scheduler)
        self.bind_prepared()
        with self.assertRaisesRegex(
            worker.receipts.retention.UnsafeState, "scheduler inventory"
        ):
            self.load()
        self.setUp()
        owner = worker._scheduler_owner()
        name = next(iter(self.scheduler["jobs"]))
        job = owner["_candidate_job"](
            name, "https://consent-protocol-drive-worker-test.a.run.app"
        )
        job["uri"] = "https://unreviewed.example/api/internal/drive-work/drain"
        self.scheduler["jobs"][name] = job
        self.prepared["baseline"]["scheduler"] = self.staged["baseline"][
            "scheduler"
        ] = worker._hash(self.scheduler)
        self.bind_prepared()
        with self.assertRaisesRegex(
            worker.receipts.retention.UnsafeState, "scheduler baseline"
        ):
            self.load()

    def test_missing_digest_mismatch_or_extra_files_are_invalid_not_absent(self):
        with self.assertRaises(worker.receipts.retention.UnsafeState):
            self.load(corrupt=True)
        self.setUp()
        documents = dict(
            zip(worker.FILES, (self.prepared, self.staged, self.scheduler))
        )
        documents["worker-stage.json.activation.json"] = {}
        with self.assertRaisesRegex(worker.receipts.retention.UnsafeState, "members"):
            self.load(documents=documents)
        self.setUp()
        self.artifact["name"] = "prod-drive-worker-stage-300-1"
        with self.assertRaises(worker.receipts.retention.UnsafeState):
            self.load()

    def test_attempt_refresh_cannot_rebind_a_sealed_stage(self):
        reads = 0

        def api(repository, endpoint):
            nonlocal reads
            result = self.api(repository, endpoint)
            if endpoint == "runs/300":
                reads += 1
                if reads == 2:
                    result["run_attempt"] = 3
            return result

        with self.assertRaisesRegex(
            worker.receipts.retention.UnsafeState, "attempt changed"
        ):
            self.load(api=api)

    def test_final_files_must_match_the_intent_published_before_staging(self):
        original = copy.deepcopy(self.prepared)
        original["template"] = "0" * 64
        with self.assertRaisesRegex(
            worker.receipts.retention.UnsafeState, "immutable preparation"
        ):
            self.load(
                intent_documents={
                    worker.FILES[0]: original,
                    worker.FILES[2]: self.scheduler,
                }
            )
        self.setUp()
        self.intent_artifact["name"] = "prod-drive-worker-intent-300-1"
        with self.assertRaises(worker.receipts.retention.UnsafeState):
            self.load()


@contextmanager
def _healthy_worker_case(stage):
    from production_worker_basis_cases import _basis_case
    from test_release_artifact_receipts import ReplayedProductionReleaseArtifactTest

    fixture = ReplayedProductionReleaseArtifactTest()
    fixture.setUp()
    with _basis_case(fixture) as ports:
        basis = worker.basis_owner.load("f" * 40, release_run_id="500")
        stage.prepared["context"].update(
            **{key: basis["candidate"][key] for key in ("source", "image")}
        )
        stage.prepared["release_basis"] = copy.deepcopy(basis)
        baseline = stage.prepared["baseline"]
        baseline.update(
            uid=basis["worker"]["service_uid"], serving=basis["worker"]["revision"]
        )
        baseline["traffic"] = [{"revisionName": baseline["serving"], "percent": 100}]
        stage.staged.update(copy.deepcopy(stage.prepared), status="staged")
        stage.bind_prepared()
        yield basis, ports


class ProductionHealthyStagedWorkerCases(StagedWorkerFixture, unittest.TestCase):
    def test_healthy_stage_keeps_original_prepared_bytes_and_revalidates_current_basis(
        self,
    ):
        with _healthy_worker_case(self) as (basis, _ports):
            supplied = self.load(release_basis=basis)
            inferred = self.load(healthy_release_run_id="500")
            self.assertEqual(supplied["context"]["basis"], basis)
            self.assertEqual(inferred["context"]["basis"], basis)
            self.assertEqual(
                supplied["files"][worker.FILES[0]], json.dumps(self.prepared).encode()
            )
            self.assertNotIn("sealed_boundary", supplied["context"]["basis"])
            self.assertEqual(set(inferred["files"]), set(worker.FILES))

    def test_healthy_stage_binds_candidate_and_exact_existing_worker_baseline(self):
        for change in ("source", "image", "protected", "uid", "serving"):
            with (
                self.subTest(change=change),
                _healthy_worker_case(self) as (basis, _ports),
            ):
                if change in {"uid", "serving"}:
                    self.prepared["baseline"][change] = (
                        "replaced-worker"
                        if change == "uid"
                        else worker.SERVICE + "-other"
                    )
                else:
                    self.prepared["context"][change] = (
                        "0" * 40 if change == "source" else "other"
                    )
                self.staged.update(copy.deepcopy(self.prepared), status="staged")
                self.bind_prepared()
                with self.assertRaises(worker.receipts.retention.UnsafeState):
                    self.load(release_basis=basis)
                self.setUp()

    def test_healthy_source_only_is_prospective_and_live_uid_or_tag_drift_never_falls_back(
        self,
    ):
        with _healthy_worker_case(self) as (_basis, ports):
            ports.runtimes[worker.SERVICE][1]["metadata"]["uid"] = "recreated-worker"
            prospective = self.load(healthy_release_run_id="500", source_only=True)
            self.assertEqual(
                prospective["kind"], "production-staged-worker-prospective"
            )
            self.assertNotIn("context", prospective)
            self.assertNotIn("files", prospective)
            with self.assertRaises(worker.receipts.retention.UnsafeState):
                self.load(healthy_release_run_id="500")
            with self.assertRaises(worker.receipts.retention.UnsafeState):
                self.load(healthy_release_run_id="501", source_only=True)

    def test_healthy_basis_is_inside_the_pre_stage_immutable_intent(self):
        with _healthy_worker_case(self) as (basis, _ports):
            original = copy.deepcopy(self.prepared)
            original["release_basis"]["healthy"]["artifact_id"] += 1
            with self.assertRaisesRegex(
                worker.receipts.retention.UnsafeState, "immutable preparation"
            ):
                self.load(
                    release_basis=basis,
                    intent_documents={
                        worker.FILES[0]: original,
                        worker.FILES[2]: self.scheduler,
                    },
                )

    def test_native_preparation_binds_the_qualified_basis_before_receipt_publication(
        self,
    ):
        with (
            _healthy_worker_case(self) as (basis, ports),
            TemporaryDirectory() as directory,
        ):
            native = run_path(str(worker.ROOT / "deploy/drive/staged_worker.py"))
            path = Path(directory) / "basis.json"
            path.write_text(json.dumps(basis))
            bound = native["release_basis"](
                path, self.prepared["context"], self.prepared["baseline"]
            )
            self.assertEqual(bound, {"release_basis": basis})
            self.assertEqual(native["release_basis"](None, {}, {}), {})
            ports.runtimes[worker.SERVICE][1]["metadata"]["uid"] = "recreated-worker"
            blocked = mock.Mock(
                side_effect=AssertionError("stale basis reached native transport")
            )
            with mock.patch.dict(native["validate"].__globals__, service=blocked):
                with self.assertRaises(worker.receipts.retention.UnsafeState):
                    native["validate"](self.staged, path, allow_retirement=False)
            blocked.assert_not_called()

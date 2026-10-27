"""Hosted restoration continuation authority and current runtime regressions."""

import copy
from contextlib import contextmanager
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
from unittest import mock
from zipfile import ZipFile

import production_restoration_receipt as restoration
import production_restoration_continuation as continuation


@contextmanager
def _continuation_case(case):
    fixture = case.restoration_fixture()
    case.run.update(conclusion="failure", triggering_actor=copy.deepcopy(case.run["actor"]))
    fixture["release"]["status"] = "blocked"
    job = case.jobs["jobs"][0]
    job["conclusion"] = "failure"
    next(s for s in job["steps"] if s["name"] == continuation.ACTIVATION)["conclusion"] = "failure"
    job["steps"] += [
        {"name": continuation.TERMINAL, "status": "completed", "conclusion": "failure"},
        {"name": "Tag this release as last known good", "status": "completed", "conclusion": "success"},
    ]
    for lane, service in (("backend", "consent-protocol"), ("frontend", "hushh-webapp")):
        fixture["documents"][f"prod-{lane}-image.json"] = {
            "sha": fixture["record"]["sourceSha"],
            "image_reference": f"gcr.io/hushh-pda/{service}@sha256:" + "b" * 64,
        }

    def fetch(arguments, **_kwargs):
        identity = int(arguments[-1].split("/")[-2])
        return subprocess.CompletedProcess(arguments, 0, case.restoration_archives(fixture)[identity], b"")

    arguments = {"api": case.api, "governed": case.maintenance.governed_dispatch,
                 "timestamp": case.maintenance._github_timestamp, "run_command": fetch, "timeout": 30}
    with (
        mock.patch.object(restoration, "source_record", return_value=(fixture["record"], fixture["digest"])),
        mock.patch.object(continuation, "validation_receipt", return_value=fixture["release"]["production_restoration"]),
        mock.patch.object(continuation, "require_retirement_clear"),
        mock.patch.object(continuation.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"", b"")),
    ):
        yield fixture, arguments


def _fresh_continuation(case, original):
    run = {**case.run, "id": 400, "run_attempt": 1, "conclusion": "success"}
    runtime = {
        lane: {"revision": name, "uid": lane + "-uid", "service_uid": lane + "-service-uid",
               "source": original["source"], "sha": original["source"], "run_id": original["run_id"],
               "image": original["images"][lane], "traffic_sha256": "a" * 64}
        for lane, name in original["pair"].items()
    }
    origin = {"schema_version": 1, "kind": "production-restoration-activation-origin",
              "original": original, "verifier": continuation.verifier_identity(run), "runtime": runtime}
    activation = {
        "schema_version": 1, "kind": "account-lifecycle-activation", "status": "activated",
        "project": "hushh-pda", "region": "us-central1", "service": "consent-protocol",
        "sha": original["source"], "run_id": str(original["run_id"]),
        "candidate_revision": runtime["backend"]["revision"], "candidate_uid": runtime["backend"]["uid"],
        "service_uid": runtime["backend"]["service_uid"], "required_provider_contract": 2,
        "database_preflight": "qualified", "fence_removal": "confirmed_absent",
        "retirement": {"status": "retired", "remaining_pre_v201_count": 0,
                       "remaining_pre_provider_v2_count": 0, "phone_admission_floor_required": False},
        "scheduler": {"status": "healthy", "checks": {"fresh_attempt_finished": True, "http_2xx": True}},
        "production_restoration": {"sourceSha": original["source"], "runId": str(original["run_id"]),
                                   "documentFence": "verified", "providerContractVersion": 2, "documentsChecked": True},
    }
    documents = {continuation.ORIGIN: origin, "prod-account-deletion-activation.json": activation}
    for lane, service in (("backend", "consent-protocol"), ("frontend", "hushh-webapp")):
        expected = {"HUSHH_DEPLOY_ENV": "production", "HUSHH_DEPLOY_SOURCE": "deploy-production",
                    "HUSHH_DEPLOY_SHA": original["source"], "HUSHH_DEPLOY_RUN_ID": str(original["run_id"])}
        documents[f"prod-{lane}-provenance.json"] = {
            "status": "healthy", "ok": True, "mode": "live_traffic", "project": "hushh-pda",
            "region": "us-central1", "service": service, "expected": expected, "failures": [],
            "checked_revisions": [{"revision": original["pair"][lane], "traffic_percent": 100,
                                   "ok": True, "mismatches": [], "env": expected,
                                   "image_reference": original["images"][lane], "image_verified": True,
                                   "image_digest": original["images"][lane].split("@", 1)[1]}],
        }
    pair = {f"{lane}_revision": name for lane, name in original["pair"].items()}
    release = {"status": "healthy", "scope": "all", "sha": original["source"], "candidate": pair,
               "final": pair, "production_restoration": original["validation"],
               "restoration_activation": {"original_run_id": original["run_id"], "original_attempt": original["run_attempt"]}}
    job = {"conclusion": "success", "steps": [
        {"name": name, "status": "completed", "conclusion": "success"} for name in continuation.FRESH_STEPS
    ]}
    return run, release, job, documents


def _archive(documents):
    result = io.BytesIO()
    with ZipFile(result, "w") as bundle:
        for name, value in documents.items():
            bundle.writestr(name, json.dumps(value))
    return result.getvalue()


class RestorationContinuationCases:
    def test_original_successful_noop_tag_requires_unchanged_healthy_baseline(self):
        with _continuation_case(self) as (fixture, arguments):
            original = continuation.load_original("300", 2, fixture["record"]["sourceSha"], **arguments)
            run, _, _, documents = _fresh_continuation(self, original)
            previous = original["previous"]
            source = previous["consent-protocol"]["sha"]
            fields = {"sha": source, "backend_revision": previous["consent-protocol"]["revision"],
                      "backend_url": "https://api.example.test", "frontend_revision": previous["hushh-webapp"]["revision"],
                      "frontend_url": "https://app.example.test", "run": "https://github.com/fixture/actions/runs/200",
                      "actor": "fixture", "tagged_at": "20261027T010000Z"}
            tag = {"commit": source, "tag_oid": "a" * 40,
                   "message": "Last known good — production\n" + "".join(f"{k}: {v}\n" for k, v in fields.items())}
            proof = __import__("production_backend_successor_proof")
            args = SimpleNamespace(run_id="300", attempt=2, sha=original["source"])
            with (mock.patch.object(continuation, "ports", return_value=arguments),
                  mock.patch.object(continuation, "active_run", return_value=run),
                  mock.patch.object(continuation, "runtime_pair", return_value=documents[continuation.ORIGIN]["runtime"]),
                  mock.patch.object(proof, "read_original", return_value=tag) as read_tag):
                for conclusion in ("success", "skipped"):
                    next(s for s in self.jobs["jobs"][0]["steps"] if s["name"] == "Tag this release as last known good")["conclusion"] = conclusion
                    origin = continuation.prepare(args, self.maintenance)
                    self.assertEqual(origin["healthy_tag"], tag)
                    self.assertEqual(fixture["release"]["status"], "blocked")
                advanced = {**tag, "commit": original["source"], "tag_oid": "b" * 40,
                            "message": tag["message"].replace(source, original["source"])}
                read_tag.return_value = advanced
                with self.assertRaises(restoration.receipts.retention.UnsafeState):
                    continuation.prepare(args, self.maintenance)
                with self.assertRaises(restoration.receipts.retention.UnsafeState):
                    continuation.verify_origin(origin, self.maintenance)

    def test_restoration_completion_rechecks_uid_image_traffic_and_original_run(self):
        with _continuation_case(self) as (fixture, arguments):
            original = continuation.load_original("300", 2, fixture["record"]["sourceSha"], **arguments)
            run, _, _, documents = _fresh_continuation(self, original)
            origin = documents[continuation.ORIGIN]
            origin["healthy_tag"] = {"tag_oid": "fixture-original-tag"}
            states, revisions = {}, {}
            for lane, service in (("backend", "consent-protocol"), ("frontend", "hushh-webapp")):
                identity = origin["runtime"][lane]
                env = {"HUSHH_DEPLOY_ENV": "production", "HUSHH_DEPLOY_SOURCE": "deploy-production",
                       "HUSHH_DEPLOY_SHA": original["source"], "HUSHH_DEPLOY_RUN_ID": "300"}
                if lane == "backend":
                    env.update({key: "false" for key in ("AUTH_PHONE_RECOVERY_ENABLED", "WORKOS_SSO_ENABLED",
                               "ACCOUNT_GENERATION_ADMISSION_ENABLED", "PROTECTED_DOCUMENT_DELIVERY_ENABLED", "DRIVE_WORK_DRAIN_ENABLED")})
                desired = [{"revisionName": identity["revision"], "percent": 100}]
                resolved = copy.deepcopy(desired)
                if lane == "backend":
                    desired += [{"revisionName": service + "-old", "percent": 0, "tag": "old-alias"},
                                {"revisionName": identity["revision"], "percent": 0, "tag": "account-deletion-300"}]
                    resolved[0]["tag"] = "account-deletion-300"
                    resolved += [copy.deepcopy(desired[1])]
                ready = [{"type": "Ready", "status": "True"}]
                states[service] = {"metadata": {"uid": identity["service_uid"], "generation": 1},
                                   "spec": {"traffic": desired},
                                   "status": {"traffic": resolved, "observedGeneration": 1, "conditions": ready}}
                revisions[service] = {"metadata": {"name": identity["revision"], "uid": identity["uid"], "labels": {
                    "serving.knative.dev/service": service, "deploy-env": "production", "deploy-source": "deploy-production",
                    "deploy-sha": original["source"], "github-run-id": "300"}}, "spec": {
                    "serviceAccountName": original["previous"][service]["runtimePrincipal"],
                    "containers": [{"image": identity["image"], "env": [{"name": k, "value": v} for k, v in env.items()]}]},
                    "status": {"imageDigest": identity["image"], "conditions": ready}}
            runtime = SimpleNamespace(retention=SimpleNamespace(
                service_state=lambda service, *_: states[service], revision_state=lambda service, *_: [revisions[service]],
                traffic_state=self.maintenance.retention.traffic_state))
            proof = __import__("production_backend_successor_proof")
            origin["runtime"] = continuation.runtime_pair(original, runtime)
            with (mock.patch.object(continuation, "load_original", return_value=original),
                  mock.patch.object(continuation, "active_run", return_value=run),
                  mock.patch.object(proof, "read_original", return_value=origin["healthy_tag"])):
                continuation.verify_origin(origin, runtime)
                baseline = copy.deepcopy((states, revisions))
                for defect in ("uid", "service_uid", "image", "traffic", "runtime_run", "tag", "resolved_tag", "desired", "latest"):
                    with self.subTest(defect=defect):
                        states, revisions = copy.deepcopy(baseline)
                        frontend = revisions["hushh-webapp"]
                        if defect == "uid":
                            frontend["metadata"]["uid"] = "replacement-uid"
                        elif defect == "service_uid":
                            states["hushh-webapp"]["metadata"]["uid"] = "replacement-service"
                        elif defect == "image":
                            frontend["spec"]["containers"][0]["image"] += "changed"
                        elif defect == "traffic":
                            states["hushh-webapp"]["status"]["traffic"][0]["percent"] = 50
                        elif defect == "tag":
                            states["consent-protocol"]["spec"]["traffic"][2]["tag"] = "changed-alias"
                            states["consent-protocol"]["status"]["traffic"][0]["tag"] = "changed-alias"
                        elif defect == "resolved_tag":
                            states["consent-protocol"]["status"]["traffic"][0]["tag"] = "changed-alias"
                        elif defect == "desired":
                            states["hushh-webapp"]["spec"]["traffic"] = [{"revisionName": "hushh-webapp-unrelated", "percent": 100}]
                        elif defect == "latest":
                            states["hushh-webapp"]["spec"]["traffic"][0]["latestRevision"] = True
                        else:
                            frontend["metadata"]["labels"]["github-run-id"] = "400"
                        with self.assertRaises(restoration.receipts.retention.UnsafeState):
                            continuation.verify_origin(origin, runtime)

    def test_restoration_active_verifier_checks_actual_policy_without_mutating_api_identity(self):
        with _continuation_case(self) as (_, arguments):
            current = {**copy.deepcopy(self.run), "id": 400, "status": "in_progress", "conclusion": None}
            job = {"name": "Deploy Production Scope", "status": "in_progress", "run_id": 400,
                   "run_attempt": current["run_attempt"], "head_sha": current["head_sha"], "head_branch": "main"}
            inventory = {"total_count": 1, "jobs": [job]}
            runtime = SimpleNamespace(api=lambda *_: inventory)
            env = {"GITHUB_RUN_ID": "400", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_SHA": current["head_sha"],
                   "GITHUB_JOB": "complete-restoration-activation"}
            with (mock.patch.dict(os.environ, env), mock.patch.object(continuation, "ports", return_value=arguments),
                  mock.patch.object(continuation, "fresh_run", side_effect=lambda *_: current)):
                before = copy.deepcopy(current)
                with mock.patch.object(continuation, "manual", wraps=continuation.manual) as policy:
                    self.assertIs(continuation.active_run(runtime), current)
                policy.assert_called_once_with(current)
                self.assertEqual(policy.call_args.args[0]["status"], "in_progress")
                self.assertEqual(current, before)
                for defect in ("status", "job", "job_attempt", "repo", "head_repo", "source", "attempt", "actor", "triggering_actor", "ancestry"):
                    with self.subTest(defect=defect):
                        current, inventory = copy.deepcopy(before), {"total_count": 1, "jobs": [copy.deepcopy(job)]}
                        if defect == "status":
                            current["status"] = "completed"
                        elif defect == "job":
                            inventory["jobs"][0]["name"] = "Other job"
                        elif defect == "job_attempt":
                            inventory["jobs"][0]["run_attempt"] = 3
                        elif defect in {"repo", "head_repo"}:
                            current["repository" if defect == "repo" else "head_repository"]["full_name"] = "foreign/repo"
                        elif defect == "source":
                            current["head_sha"] = "f" * 40
                        elif defect == "attempt":
                            current["run_attempt"] = 3
                        elif defect in {"actor", "triggering_actor"}:
                            current[defect]["login"] = "unapproved-fixture-actor"
                        snapshot = copy.deepcopy(current)
                        with mock.patch.object(continuation.subprocess, "run", return_value=subprocess.CompletedProcess(
                            [], 1 if defect == "ancestry" else 0, b"", b""
                        )), self.assertRaises(restoration.receipts.retention.UnsafeState):
                            continuation.active_run(runtime)
                        self.assertEqual(current, snapshot)

    def test_restoration_preflight_delegates_retirement_classification_and_refuses_mutation(self):
        state, revisions, candidate = {"metadata": {"uid": "fixture"}}, [{"metadata": {"name": "fixture"}}], "fixture"
        for consumers in (([], []), (["legacy-revision"], []), ([], ["legacy-tag"])):
            with self.subTest(consumers=consumers), mock.patch.object(continuation, "run_path", return_value={
                "legacy_inventory": mock.Mock(return_value=consumers)
            }) as loader:
                if any(consumers):
                    with self.assertRaises(restoration.receipts.retention.UnsafeState):
                        continuation.require_retirement_clear(state, revisions, candidate)
                else:
                    continuation.require_retirement_clear(state, revisions, candidate)
                loader.return_value["legacy_inventory"].assert_called_once_with(
                    state, revisions, candidate, phone_floor=False, restoration=True
                )

    def test_hosted_restoration_continuation_preserves_failed_original_and_runtime_identity(self):
        with _continuation_case(self) as (fixture, arguments):
            original = continuation.load_original("300", 2, fixture["record"]["sourceSha"], **arguments)
            run, release, job, documents = _fresh_continuation(self, original)
            api = arguments["api"]
            arguments["api"] = lambda repo, endpoint: run if endpoint == "runs/400" else api(repo, endpoint)
            result = continuation.serving_context(run, release, job, _archive(documents), **arguments)
            with tempfile.TemporaryDirectory() as directory:
                for name, value in documents.items():
                    (Path(directory) / name).write_text(json.dumps(value))
                completed = continuation.finish(documents[continuation.ORIGIN], Path(directory))
            self.assertEqual(completed["restoration_activation"], release["restoration_activation"])
            self.assertEqual(self.run["conclusion"], "failure")
            self.assertEqual(fixture["release"]["status"], "blocked")
            self.assertEqual({r["run_id"] for r in result.values()}, {300})
            self.assertNotEqual(run["id"], result["backend"]["run_id"])
            with mock.patch.object(restoration, "serving_reference", return_value=result):
                derived = copy.deepcopy(release)
                context = __import__("production_retention_context")
                context.healthy_phone(self.maintenance, self.repo, run, derived,
                                      self.maintenance.LANES["production"], self.fail)
            self.assertEqual(derived["_maintenance_backend_identity"], result["backend"])
            self.assertEqual({r["run_id"] for r in derived["_maintenance_lane_provenance"].values()}, {300})

    def test_hosted_restoration_origin_rejects_foreign_or_changed_authority(self):
        for defect in ("attempt", "actor", "source", "activation", "other_failure", "artifact", "operation", "validation"):
            with self.subTest(defect=defect):
                self.setUp()
                with _continuation_case(self) as (fixture, arguments):
                    if defect == "attempt":
                        self.run["run_attempt"] = 3
                    elif defect == "actor":
                        self.run["triggering_actor"]["login"] = "unapproved-fixture-actor"
                    elif defect == "source":
                        fixture["release"]["sha"] = "9" * 40
                    elif defect in {"activation", "other_failure"}:
                        name = continuation.ACTIVATION if defect == "activation" else restoration.STEPS[0]
                        next(s for s in self.jobs["jobs"][0]["steps"] if s["name"] == name)["conclusion"] = (
                            "success" if defect == "activation" else "failure"
                        )
                    elif defect == "artifact":
                        self.artifact["expired"] = True
                    elif defect == "operation":
                        fixture["plan"]["runId"] = "301"
                    else:
                        fixture["documents"]["prod-restoration-validation.json"]["artifactDigest"] = "sha256:" + "9" * 64
                    with self.assertRaises((ValueError, restoration.receipts.retention.UnsafeState)):
                        continuation.load_original("300", 2, fixture["record"]["sourceSha"], **arguments)

    def test_hosted_restoration_verifier_rejects_missing_fresh_checks_and_foreign_runtime(self):
        for defect in ("origin", "verifier", "runtime", "pair", "barrier", "activation", "fresh_gate", "image", "deploy"):
            with self.subTest(defect=defect):
                self.setUp()
                with _continuation_case(self) as (fixture, arguments):
                    original = continuation.load_original("300", 2, fixture["record"]["sourceSha"], **arguments)
                    run, release, job, documents = _fresh_continuation(self, original)
                    api = arguments["api"]
                    arguments["api"] = lambda repo, endpoint: run if endpoint == "runs/400" else api(repo, endpoint)
                    origin, activation = documents[continuation.ORIGIN], documents["prod-account-deletion-activation.json"]
                    if defect == "origin":
                        origin["original"] = {**original, "artifact_id": 999}
                    elif defect == "verifier":
                        origin["verifier"]["run_attempt"] = 2
                    elif defect == "runtime":
                        origin["runtime"]["frontend"]["run_id"] = 400
                    elif defect == "pair":
                        release["final"] = {**release["final"], "frontend_revision": "hushh-webapp-unrelated"}
                    elif defect == "barrier":
                        activation["production_restoration"]["runId"] = "400"
                    elif defect == "activation":
                        activation["status"] = "blocked"
                    elif defect == "fresh_gate":
                        job["steps"][0]["conclusion"] = "skipped"
                    elif defect == "image":
                        documents["prod-frontend-provenance.json"]["checked_revisions"][0]["image_digest"] = "sha256:" + "c" * 64
                    else:
                        job["steps"].append({"name": continuation.FORBIDDEN[0], "status": "completed", "conclusion": "success"})
                    with self.assertRaises((ValueError, restoration.receipts.retention.UnsafeState)):
                        continuation.serving_context(run, release, job, _archive(documents), **arguments)


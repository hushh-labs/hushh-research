"""Frontend receipts inherit one immutable ordinary backend owner, never history."""

import copy
import hashlib
import importlib
import json
import pathlib
import subprocess
import tempfile
from contextlib import ExitStack, contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import production_backend_inheritance as inheritance

from production_phone_receipt_fixtures import archive, cold_revision
from production_backend_successor_control_cases import _auth_operational_reference
from production_worker_basis_cases import _basis_case, _ordinary, _runtime, _tag

MAINTENANCE = importlib.import_module("uat-retention-maintenance")


def _frontend_documents(case):
    release = copy.deepcopy(case.release)
    release.update(scope="frontend", sha="e" * 40)
    release.pop("phone_rollback")
    release["final"]["frontend_revision"] = "hushh-webapp-frontend-only"
    release["candidate"]["frontend_revision"] = release["final"]["frontend_revision"]
    release["backend_origin"] = {
        "run_id": "500",
        "source": case.release["sha"],
        "revision": case.release["final"]["backend_revision"],
        "uid": "primary-uid",
        "service_uid": case.origin["candidate"]["service_uid"],
    }
    return {
        "prod-release-status.json": release,
        "prod-protected-document-release.json": {"configured": True, "enabled": False},
    }


@contextmanager
def _inheritance_case(fixture):
    with _basis_case(fixture) as ports, ExitStack() as stack:
        _ordinary(ports)
        case, owner = ports.case, ports.owner
        case.documents[inheritance.activation.pending.ACTIVATION]["run_id"] = "500"
        documents = _frontend_documents(case)
        release = documents["prod-release-status.json"]
        run = {**copy.deepcopy(case.run), "id": 600}
        jobs = copy.deepcopy(case.jobs)
        jobs["jobs"][0].update(run_id=600)
        artifact = copy.deepcopy(case.artifact)
        artifact.update(id=700, name="prod-release-600")
        artifact["workflow_run"]["id"] = 600
        payload = b""
        old_api, old_command, old_download = (
            owner.api,
            owner.command,
            owner.retention.run_command,
        )

        def pack():
            nonlocal payload
            case.pack()
            payload = archive(SimpleNamespace(artifact=artifact), documents)

        def api(repository, endpoint):
            if endpoint == "runs/400":
                return copy.deepcopy(case.original.run)
            if endpoint in {"runs/600", "runs/600?exclude_pull_requests=true"}:
                return copy.deepcopy(run)
            if endpoint == "runs/600/artifacts?per_page=100":
                return {"total_count": 1, "artifacts": [copy.deepcopy(artifact)]}
            if endpoint in {
                "runs/600/attempts/1/jobs?per_page=100",
                "runs/600/jobs?filter=latest&per_page=100",
            }:
                return copy.deepcopy(jobs)
            return old_api(repository, endpoint)

        def download(command, **kwargs):
            if command[-1].endswith("/700/zip"):
                return subprocess.CompletedProcess(command, 0, payload, b"")
            return old_download(command, **kwargs)

        def command(*arguments):
            if arguments[:3] == ("gh", "run", "download") and arguments[3] == "600":
                directory = Path(arguments[arguments.index("--dir") + 1])
                directory.mkdir(parents=True)
                (directory / "prod-release-status.json").write_text(json.dumps(release))
                return ""
            return old_command(*arguments)

        tag = _tag(SimpleNamespace(release=release))
        tag = inheritance.activation.proof.reference.tag_identity(
            tag["tag_object"].replace("/actions/runs/500", "/actions/runs/600")
        )
        ports.tag.clear()
        ports.tag.update(tag)
        ports.runtimes["hushh-webapp"] = _runtime(
            "hushh-webapp",
            release["sha"],
            "600",
            "frontend-only-uid",
            release["final"]["frontend_revision"],
        )
        for target, name, value in (
            (owner, "api", api),
            (owner, "command", command),
            (owner.retention, "run_command", download),
        ):
            stack.enter_context(mock.patch.object(target, name, value))
        ports.fe_run, ports.fe_release = run, release
        ports.fe_documents, ports.fe_jobs, ports.fe_artifact = documents, jobs, artifact
        ports.pack = pack
        pack()
        yield ports


def _find(ports, callback=None):
    with tempfile.TemporaryDirectory() as temporary:
        return ports.owner.find_release(
            "hushh-labs/hushh-research",
            "600",
            Path(temporary),
            require_live=False,
            environment="production",
            on_phone_rollback=callback,
        )


def _auth_restoration_acceptance(ports):
    refresh = importlib.import_module("production_auth_domain_refresh")
    current, pointer, run = ports.fe_release, ports.fe_release["backend_origin"], ports.fe_run
    current["sha"] = refresh.CANDIDATE
    pointer["source"] = refresh.SOURCE
    acceptance_id, acceptance_attempt, workflow_sha = 550, 3, "a" * 40
    operational_reference, _operational_tag, _anchor = _auth_operational_reference(
        refresh, anchored=True
    )
    current["predecessor_exception"] = {
        "schema_version": 1,
        "kind": "manual-production-predecessor-exception",
        "scope": "frontend",
        "authority": {
            "mode": "manual-emergency",
            "frontend_auth_domain_refresh": True,
            "application_sha": refresh.CANDIDATE,
            "run_id": str(run["id"]),
            "run_attempt": str(run["run_attempt"]),
            "workflow_sha": run["head_sha"],
        },
        "baseline": {
            "backend": {
                "source": refresh.SOURCE,
                "image": refresh.IMAGES["backend"],
                "revision": pointer["revision"],
                "revision_uid": pointer["uid"],
                "service_uid": pointer["service_uid"],
            },
            "frontend": {"source": refresh.SOURCE, "image": refresh.IMAGES["frontend"]},
        },
        "ordinary_promotion_evidence": False,
        "backend_acceptance_origin": {
            "schema_version": 1,
            "kind": "production-auth-domain-backend-acceptance",
            "run_id": acceptance_id,
            "run_attempt": acceptance_attempt,
            "workflow_sha": workflow_sha,
            "source": refresh.SOURCE,
            "backend": copy.deepcopy(pointer),
            "backend_image": refresh.IMAGES["backend"],
            "operational_reference": operational_reference,
        },
    }
    identity = {
        "revision": pointer["revision"],
        "uid": pointer["uid"],
        "service_uid": pointer["service_uid"],
        "source": refresh.SOURCE,
        "sha": refresh.SOURCE,
        "run_id": int(pointer["run_id"]),
        "image": refresh.IMAGES["backend"],
    }
    accepted_run = {
        "id": acceptance_id,
        "run_attempt": acceptance_attempt,
        "head_sha": workflow_sha,
        "path": ".github/workflows/deploy-production.yml",
        "head_branch": "main",
        "event": "workflow_dispatch",
        "status": "completed",
        "conclusion": "success",
    }
    accepted_release = {
        "status": "healthy",
        "scope": "all",
        "sha": refresh.SOURCE,
        "final": {"backend_revision": pointer["revision"]},
        "production_restoration": {"status": "validated"},
        "restoration_activation": {"original_run_id": 400, "original_attempt": 1},
        "_maintenance_backend_identity": identity,
        "_maintenance_restoration_runtime": {
            "backend": identity,
            "frontend": {"revision": "hushh-webapp-restored"},
        },
    }
    ports.pack()
    return accepted_run, accepted_release, identity


class BackendInheritanceCases:
    def test_frontend_retention_protects_original_phone_rollback_and_rejects_tamper(
        self,
    ):
        with _inheritance_case(self) as ports:
            anchors = []
            release = _find(ports, anchors.append)[1]
            anchor = anchors[0]
            cold = cold_revision(ports.case.documents["phone-rollback/qualified.json"])
            cold["metadata"]["uid"] = anchor["uid"]
            with (
                mock.patch.object(
                    ports.owner.retention,
                    "revision_state",
                    return_value=[cold, ports.runtimes["consent-protocol"][1]],
                ) as inventory,
                mock.patch.object(
                    ports.owner,
                    "command",
                    return_value=release["final"]["backend_revision"],
                ),
            ):
                flags = ports.owner.release_protection_flags(
                    "consent-protocol",
                    "backend",
                    release,
                    environment="production",
                    phone_anchor=anchor,
                )
                self.assertEqual(flags[0], release["final"]["backend_revision"])
                self.assertEqual(flags[2], cold["metadata"]["name"])
                self.assertEqual(flags[4], release["final"]["backend_revision"])
                inventory.side_effect = [
                    [cold, ports.runtimes["consent-protocol"][1]],
                    [ports.runtimes["consent-protocol"][1]],
                ]
                with self.assertRaises(ports.owner.retention.UnsafeState):
                    ports.owner.release_protection_flags(
                        "consent-protocol",
                        "backend",
                        release,
                        environment="production",
                        phone_anchor=anchor,
                    )
                with self.assertRaises(ports.owner.retention.UnsafeState):
                    ports.owner.release_protection_flags(
                        "consent-protocol",
                        "backend",
                        release,
                        environment="production",
                        phone_anchor={**anchor, "release_sha": "a" * 40},
                    )

    def test_frontend_inherits_actual_backend_identity_and_phone_anchor(self):
        with _inheritance_case(self) as ports:
            found = _find(ports)
            self.assertEqual(found[0], 600)
            release = found[1]
            self.assertEqual(release["_maintenance_backend_identity"]["run_id"], 500)
            self.assertEqual(
                release["_maintenance_backend_identity"]["uid"], "primary-uid"
            )
            self.assertEqual(
                release["_maintenance_lane_provenance"]["backend"]["sha"], "f" * 40
            )
            self.assertEqual(
                release["_maintenance_lane_provenance"]["frontend"]["sha"], "e" * 40
            )
            self.assertNotIn("phone_rollback", release)
            self.assertTrue(
                ports.owner.live_release_matches(release, environment="production")
            )

    def test_auth_repair_inherits_one_qualified_restoration_without_phone_authority(self):
        with _inheritance_case(self) as ports:
            accepted_run, accepted_release, identity = _auth_restoration_acceptance(ports)
            original_api = ports.owner.api

            def api(repository, endpoint):
                if endpoint in {"runs/550", "runs/550?exclude_pull_requests=true"}:
                    return copy.deepcopy(accepted_run)
                return original_api(repository, endpoint)

            def find(repository, requested, directory, **kwargs):
                self.assertEqual(requested, "550")
                self.assertIs(kwargs["require_live"], False)
                self.assertEqual(kwargs["environment"], "production")
                return 550, copy.deepcopy(accepted_release)

            with (
                mock.patch.object(ports.owner, "api", side_effect=api),
                mock.patch.object(ports.owner, "find_release", side_effect=find),
            ):
                inherited = inheritance.inherit(
                    "hushh-labs/hushh-research",
                    ports.fe_run,
                    ports.fe_release,
                    ports.owner.LANES["production"],
                    api=ports.owner.api,
                    governed=lambda *_args, **_kwargs: True,
                    timestamp=ports.owner._github_timestamp,
                    run_command=ports.owner.retention.run_command,
                    timeout=30,
                )
            self.assertEqual(inherited["backend"], identity)
            self.assertEqual(inherited["restoration_runtime"], identity)
            self.assertNotIn("phone_anchor", inherited)
            self.assertNotIn("backend_origin", accepted_release)

            current = copy.deepcopy(ports.fe_release)
            callback = mock.Mock()
            with mock.patch.object(inheritance, "inherit", return_value=inherited):
                inheritance.apply(
                    ports.owner,
                    "hushh-labs/hushh-research",
                    ports.fe_run,
                    current,
                    ports.owner.LANES["production"],
                    callback,
                )
            self.assertEqual(
                current["_maintenance_restoration_runtime"], {"backend": identity}
            )
            self.assertNotIn("_maintenance_backend_inheritance", current)
            callback.assert_not_called()

    def test_auth_repair_rejects_wrong_restoration_identity_and_nested_owner(self):
        for defect in (
            "uid", "source", "frontend", "attempt", "anchor",
            "baseline_revision", "baseline_uid", "baseline_service", "current_attempt", "actor",
            "operational_tag",
        ):
            with self.subTest(defect=defect), _inheritance_case(self) as ports:
                accepted_run, accepted_release, _identity = _auth_restoration_acceptance(ports)
                origin = ports.fe_release["predecessor_exception"]["backend_acceptance_origin"]
                if defect == "uid":
                    origin["backend"]["uid"] = "wrong"
                elif defect == "source":
                    origin["backend"]["source"] = "0" * 40
                elif defect == "frontend":
                    accepted_release["scope"] = "frontend"
                elif defect == "attempt":
                    accepted_run["run_attempt"] += 1
                elif defect == "operational_tag":
                    origin["operational_reference"]["tag_oid"] = "0" * 40
                else:
                    if defect == "anchor":
                        accepted_release["backend_origin"] = {"run_id": "999"}
                    elif defect.startswith("baseline_"):
                        key = {
                            "baseline_revision": "revision",
                            "baseline_uid": "revision_uid",
                            "baseline_service": "service_uid",
                        }[defect]
                        ports.fe_release["predecessor_exception"]["baseline"]["backend"][key] = "wrong"
                original_api = ports.owner.api

                def api(repository, endpoint):
                    if endpoint in {"runs/550", "runs/550?exclude_pull_requests=true"}:
                        return copy.deepcopy(accepted_run)
                    if defect == "current_attempt" and endpoint == "runs/600":
                        changed = copy.deepcopy(ports.fe_run)
                        changed["run_attempt"] += 1
                        return changed
                    return original_api(repository, endpoint)

                def find(_repository, _requested, _directory, **_kwargs):
                    return 550, copy.deepcopy(accepted_release)

                def governed(envelope, *_args, **_kwargs):
                    return defect != "actor" or envelope.get("id") != ports.fe_run["id"]

                with (
                    mock.patch.object(ports.owner, "api", side_effect=api),
                    mock.patch.object(ports.owner, "find_release", side_effect=find),
                    self.assertRaises(ports.owner.retention.UnsafeState),
                ):
                    inheritance.inherit(
                        "hushh-labs/hushh-research",
                        ports.fe_run,
                        ports.fe_release,
                        ports.owner.LANES["production"],
                        api=ports.owner.api,
                        governed=governed,
                        timestamp=ports.owner._github_timestamp,
                        run_command=ports.owner.retention.run_command,
                        timeout=30,
                    )

    def test_frontend_selector_cannot_forge_or_chain_backend_authority(self):
        for defect in (
            "uid",
            "source",
            "run",
            "service",
            "pending",
            "frontend",
            "activation",
            "continuation",
        ):
            with self.subTest(defect=defect), _inheritance_case(self) as ports:
                pointer = ports.fe_release["backend_origin"]
                if defect in {"uid", "source", "service"}:
                    pointer[
                        {"uid": "uid", "source": "source", "service": "service_uid"}[
                            defect
                        ]
                    ] = "a" * 40
                elif defect == "run":
                    pointer["run_id"] = "400"
                elif defect in {"pending", "frontend"}:
                    ports.case.release["status" if defect == "pending" else "scope"] = (
                        "pending_activation" if defect == "pending" else "frontend"
                    )
                elif defect == "activation":
                    ports.case.documents[inheritance.activation.pending.ACTIVATION][
                        "candidate_uid"
                    ] = "forged"
                else:
                    ports.case.documents[inheritance.activation.ORIGIN] = (
                        ports.case.origin
                    )
                ports.pack()
                with self.assertRaises(ports.owner.retention.UnsafeState):
                    _find(ports)

    def test_frontend_inheritance_keeps_canonical_hygiene_failure_classifier(self):
        from production_worker_basis_cases import _hygiene_failure

        with _inheritance_case(self) as ports:
            ports.case.documents[inheritance.activation.ORIGIN] = ports.case.origin
            _hygiene_failure(ports)
            ports.pack()
            self.assertEqual(
                _find(ports)[1]["_maintenance_backend_identity"]["run_id"], 500
            )


class ProductionEvidenceStatusCases:
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


class ProductionEvidenceFlagCases:
    def test_production_evidence_repair_defaults_off(self):
        receipts = MAINTENANCE.release_artifact_receipts
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertFalse(receipts.production_evidence_repair_enabled())
        for value, expected in (("false", False), ("TRUE", False), ("1", False), ("true", True)):
            with self.subTest(value=value), mock.patch.dict("os.environ", {receipts.PRODUCTION_EVIDENCE_REPAIR_FLAG: value}, clear=True):
                self.assertEqual(receipts.production_evidence_repair_enabled(), expected)

    def test_disabled_repair_keeps_existing_release_reader(self):
        flag = MAINTENANCE.release_artifact_receipts.PRODUCTION_EVIDENCE_REPAIR_FLAG
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)

            def download(_repo, _run, _name, target):
                target.mkdir(parents=True)
                (target / self.status_name).write_text('{"status":"blocked"}')

            with (
                mock.patch.dict("os.environ", {flag: "false"}),
                mock.patch.object(MAINTENANCE, "artifact_exists", return_value=True),
                mock.patch.object(MAINTENANCE, "download", side_effect=download),
                mock.patch.object(MAINTENANCE, "uncached_api", side_effect=AssertionError("disabled repair")),
            ):
                self.assertEqual(
                    MAINTENANCE.load_release(self.repo, 300, directory, "production"),
                    {"status": "blocked"},
                )

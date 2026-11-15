"""Current healthy worker basis through real release and acceptance readers."""

import copy
import hashlib
import io
import json
from contextlib import ExitStack, contextmanager
from pathlib import Path
from runpy import run_path
from types import SimpleNamespace
from unittest import mock
from zipfile import ZipFile

import production_worker_basis as basis
from production_activation_continuation_cases import _continuation_case


def _tag(case):
    source = case.release["sha"]
    fields = {
        "sha": source,
        "backend_revision": case.release["final"]["backend_revision"],
        "backend_url": "https://api.example.test",
        "frontend_revision": case.release["final"]["frontend_revision"],
        "frontend_url": "https://app.example.test",
        "run": f"https://github.com/{basis.REPOSITORY}/actions/runs/500",
        "actor": "governed-maintainer",
        "tagged_at": "20261027T010000Z",
    }
    message = "Last known good — production\n" + "".join(
        f"{key}: {value}\n" for key, value in fields.items()
    )
    return basis.proof.reference.tag_identity(
        f"object {source}\ntype commit\ntag deployed/production-latest\n"
        "tagger Fixture <fixture@example.test> 1793001000 +0000\n\n" + message
    )


def _acceptance():
    fixture = run_path(
        str(basis.proof.ROOT / "consent-protocol/tests/helpers/predecessor_acceptance.py")
    )
    module, client, documents, responses, pins = fixture["_acceptance_fixture"]()
    image = "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "b" * 64
    documents["uat"]["provenance"]["backend"]["checked_revisions"][0].update(
        image_reference=image, image_digest="sha256:" + "b" * 64, image_verified=True
    )
    buffer = io.BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("acceptance.json", json.dumps(documents["uat"]))
    digest = "sha256:" + hashlib.sha256(buffer.getvalue()).hexdigest()
    responses["artifacts/21/zip"] = buffer.getvalue()
    responses["artifacts/21"].update(digest=digest, size_in_bytes=len(buffer.getvalue()))
    pins["uat"]["artifact_digest"] = digest
    responses["workflows/deploy-uat.yml/runs?event=workflow_dispatch&per_page=50&page=1"] = {
        "workflow_runs": [{"id": 20}],
    }
    responses["runs/20/artifacts?per_page=100"] = {
        "total_count": 1,
        "artifacts": [responses["artifacts/21"]],
    }
    return module, client, responses


def _runtime(service, source, run_id, uid, revision_name):
    ready = {"type": "Ready", "status": "True"}
    traffic = [{"revisionName": revision_name, "percent": 100}]
    state = {
        "metadata": {"name": service, "uid": service + "-uid", "generation": 1},
        "spec": {"traffic": copy.deepcopy(traffic)},
        "status": {"traffic": traffic, "conditions": [ready], "observedGeneration": 1},
    }
    env = {"ENVIRONMENT": "production", "GOOGLE_CLOUD_PROJECT": "hushh-pda"}
    if service != basis.WORKER:
        env.update(
            HUSHH_DEPLOY_SHA=source,
            HUSHH_DEPLOY_RUN_ID=run_id,
            HUSHH_DEPLOY_SOURCE="deploy-production",
            HUSHH_DEPLOY_ENV="production",
        )
    revision = {
        "metadata": {
            "name": revision_name,
            "uid": uid,
            "labels": {
                "serving.knative.dev/service": service,
                "deploy-sha": source,
                "github-run-id": run_id,
                "deploy-env": "production",
                "deploy-source": "deploy-production",
            },
        },
        "spec": {
            "serviceAccountName": "consent-protocol-runtime@hushh-pda.iam.gserviceaccount.com",
            "containers": [
                {
                    "name": "drive-worker" if service == basis.WORKER else "app",
                    "image": "gcr.io/hushh-pda/consent-protocol@sha256:" + "a" * 64,
                    "env": [{"name": key, "value": value} for key, value in env.items()],
                }
            ],
        },
        "status": {"conditions": [ready]},
    }
    return state, revision


@contextmanager
def _basis_case(fixture):
    with _continuation_case(fixture) as case, ExitStack() as stack:
        owner, tag = fixture.maintenance, _tag(case)
        acceptance, client, responses = _acceptance()
        runtimes = {
            "consent-protocol": _runtime(
                "consent-protocol",
                case.release["sha"],
                "400",
                "primary-uid",
                case.release["final"]["backend_revision"],
            ),
            basis.WORKER: _runtime(
                basis.WORKER,
                "a" * 40,
                "200",
                "worker-revision-uid",
                basis.WORKER + "-current",
            ),
            "hushh-webapp": _runtime(
                "hushh-webapp",
                case.release["sha"],
                "400",
                "frontend-uid",
                case.release["final"]["frontend_revision"],
            ),
        }
        runtimes["consent-protocol"][0]["metadata"]["uid"] = case.origin["candidate"]["service_uid"]

        def download(*arguments):
            fixture.assertEqual(arguments[:3], ("gh", "run", "download"))
            directory = Path(arguments[arguments.index("--dir") + 1])
            directory.mkdir(parents=True)
            (directory / "prod-release-status.json").write_text(json.dumps(case.release))
            return ""

        def api(repository, endpoint):
            if endpoint == "runs/500/jobs?filter=latest&per_page=100":
                return copy.deepcopy(case.jobs)
            return case.api(repository, endpoint)

        for target, name, value in (
            (basis, "_owners", lambda: (owner, acceptance)),
            (basis.proof, "read_original", lambda: copy.deepcopy(tag)),
            (acceptance, "GitHub", lambda: client),
            (owner, "api", api),
            (owner, "command", download),
            (owner.retention, "run_command", case.download),
            (
                owner.retention,
                "service_state",
                lambda service, *_: copy.deepcopy(runtimes[service][0]),
            ),
            (
                owner.retention,
                "revision_state",
                lambda service, *_: [copy.deepcopy(runtimes[service][1])],
            ),
        ):
            stack.enter_context(mock.patch.object(target, name, value))
        yield SimpleNamespace(
            case=case,
            owner=owner,
            tag=tag,
            runtimes=runtimes,
            responses=responses,
            client=client,
        )


def _ordinary(ports):
    ports.case.documents.pop("prod-activation-origin.json")
    for service in ("consent-protocol", "hushh-webapp"):
        revision = ports.runtimes[service][1]
        revision["metadata"]["labels"]["github-run-id"] = "500"
        for row in revision["spec"]["containers"][0]["env"]:
            if row["name"] == "HUSHH_DEPLOY_RUN_ID":
                row["value"] = "500"
    ports.case.pack()


def _hygiene_failure(ports):
    _ordinary(ports)
    case, owner = ports.case, ports.owner
    case.run["conclusion"] = case.job["conclusion"] = "failure"
    names = {row["name"] for row in case.job["steps"]} | set(owner.REQUIRED_PRODUCTION_STEPS)
    case.job["steps"] = [{**case.original.upload, "name": name} for name in sorted(names)]
    case.job["steps"].append(
        {
            **case.original.upload,
            "name": owner.POST_RELEASE_CLEANUP_STEP,
            "conclusion": "failure",
        }
    )
    for name in (
        "runtime_parity",
        "connected_systems",
        "backend_provenance",
        "frontend_provenance",
        "backend_health",
        "frontend_health",
        "passkey_domain_associations",
        "account_deletion_activation",
    ):
        case.release["verification"][name] = "success"
    case.release["rollback"] = dict.fromkeys(("backend", "frontend", "drive_jobs"), "skipped")
    case.pack()


class WorkerBasisCases:
    def test_recurring_worker_reuses_mixed_root_pending_and_activation_receipts(self):
        from production_phone_receipt_fixtures import mixed_root_archive

        with _basis_case(self) as ports:
            case = ports.case
            case.original.payload = mixed_root_archive(case.original, case.original.documents)
            case.origin = case.load()
            case.documents["prod-activation-origin.json"] = case.origin
            case.payload = mixed_root_archive(case, case.documents)
            result = basis.load("f" * 40, release_run_id="500")
            self.assertEqual(result["backend"]["runtime_run_id"], "400")
            self.assertEqual(result["worker"]["uid"], "worker-revision-uid")
            self.assertEqual(basis.revalidate(result), result)

    def test_frontend_only_basis_uses_canonical_inherited_backend_identity(self):
        from production_backend_inheritance_cases import _inheritance_case

        with _inheritance_case(self) as ports:
            before = copy.deepcopy(ports.fe_release)
            result = basis.load("f" * 40, release_run_id=str(ports.fe_run["id"]))
            self.assertEqual(result["healthy"]["run_id"], str(ports.fe_run["id"]))
            self.assertEqual(result["tag"]["commit"], ports.fe_release["sha"])
            self.assertNotEqual(result["backend"]["source"], ports.fe_release["sha"])
            self.assertEqual(result["backend"]["runtime_run_id"], "500")
            self.assertEqual(result["backend"]["uid"], "primary-uid")
            self.assertEqual(basis.revalidate(result), result)
            self.assertEqual(ports.fe_release, before)
            self.assertEqual(ports.fe_release["scope"], "frontend")
            self.assertNotIn("prod-activation-origin.json", ports.fe_documents)
            with mock.patch.object(
                ports.owner.retention,
                "service_state",
                side_effect=AssertionError("source-only runtime read"),
            ):
                self.assertEqual(basis.qualify_source(result), result)

    def test_frontend_only_basis_refuses_forged_origin_or_changed_backend_uid(self):
        from production_backend_inheritance_cases import _inheritance_case

        for defect in ("uid", "source", "pending-origin", "live-uid"):
            with self.subTest(defect=defect), _inheritance_case(self) as ports:
                origin = ports.fe_release["backend_origin"]
                if defect == "uid":
                    origin["uid"] = "forged-backend"
                elif defect == "source":
                    origin["source"] = "0" * 40
                elif defect == "pending-origin":
                    origin["run_id"] = "400"
                else:
                    ports.runtimes["consent-protocol"][1]["metadata"]["uid"] = "recreated"
                ports.pack()
                with self.assertRaises(basis.receipts.retention.UnsafeState):
                    basis.load("f" * 40)

    def test_ordinary_healthy_worker_basis_keeps_its_own_runtime_run(self):
        with _basis_case(self) as ports:
            _ordinary(ports)
            result = basis.load("f" * 40)
            self.assertEqual(result["backend"]["runtime_run_id"], "500")
            self.assertEqual(basis.revalidate(result), result)

    def test_existing_hygiene_failure_authority_allows_health_but_refuses_application_failure(
        self,
    ):
        with _basis_case(self) as ports:
            _hygiene_failure(ports)
            result = basis.load("f" * 40)
            self.assertEqual(result["backend"]["runtime_run_id"], "500")
            self.assertEqual(basis.revalidate(result), result)
            health = next(
                row
                for row in ports.case.job["steps"]
                if row["name"] == "Post-deploy backend runtime health gate"
            )
            health["conclusion"] = "failure"
            with self.assertRaises(basis.receipts.retention.UnsafeState):
                basis.load("f" * 40)
            health["conclusion"] = "success"
            ports.case.documents["prod-activation-origin.json"] = ports.case.origin
            ports.case.pack()
            # A continuation retains its stricter successful-run contract even
            # when the ordinary release owner accepts post-release hygiene.
            with self.assertRaises(basis.receipts.retention.UnsafeState):
                basis.load("f" * 40)

    def test_healthy_basis_joins_actual_continuation_runtime_and_accepted_image(self):
        for empty_url in (False, True):
            with self.subTest(empty_url=empty_url), _basis_case(self) as ports:
                if empty_url:
                    raw = ports.tag["tag_object"].replace(
                        "frontend_url: https://app.example.test\n", "frontend_url:\n"
                    )
                    ports.tag.update(basis.proof.reference.tag_identity(raw))
                result = basis.load("f" * 40, release_run_id="500")
                self.assertEqual(result["kind"], basis.KIND)
                self.assertNotIn("sealed_boundary", result)
                self.assertEqual(result["healthy"]["artifact_id"], 600)
                self.assertEqual(result["backend"]["runtime_run_id"], "400")
                self.assertEqual(result["worker"]["uid"], "worker-revision-uid")
                self.assertEqual(
                    result["candidate"]["image"],
                    "gcr.io/hushh-pda/consent-protocol@sha256:" + "b" * 64,
                )
                self.assertEqual(basis.revalidate(result), result)
                self.assertEqual(basis.current_release_run_id(), "500")
                self.assertIn("runs/400/artifacts?per_page=100", ports.case.original.calls)
                with mock.patch.object(
                    ports.owner.retention,
                    "service_state",
                    side_effect=AssertionError("source-only must not read runtime"),
                ):
                    self.assertEqual(basis.qualify_source(result), result)

    def test_healthy_basis_rejects_current_tag_candidate_and_worker_drift(self):
        for defect in (
            "tag",
            "source",
            "image",
            "pin",
            "worker-uid",
            "worker-service",
            "worker-image",
            "backend-uid",
            "backend-env",
        ):
            with self.subTest(defect=defect), _basis_case(self) as ports:
                result = basis.load("f" * 40)
                if defect == "tag":
                    ports.tag["tag_oid"] = "0" * 40
                elif defect == "source":
                    result["candidate"]["source"] = "e" * 40
                elif defect == "image":
                    result["candidate"]["image"] = result["candidate"]["image"].replace(
                        "b" * 64, "c" * 64
                    )
                elif defect == "pin":
                    result["candidate"]["uat_acceptance"]["image_reference"] = "wrong"
                elif defect == "worker-uid":
                    ports.runtimes[basis.WORKER][1]["metadata"]["uid"] = "new-worker"
                elif defect == "worker-service":
                    ports.runtimes[basis.WORKER][0]["metadata"]["uid"] = "new-service"
                elif defect == "worker-image":
                    ports.runtimes[basis.WORKER][1]["spec"]["containers"][0]["image"] = "latest"
                elif defect == "backend-uid":
                    ports.runtimes["consent-protocol"][1]["metadata"]["uid"] = "new-backend"
                else:
                    ports.runtimes["consent-protocol"][1]["spec"]["containers"][0]["env"] = []
                with self.assertRaises((basis.receipts.retention.UnsafeState, ValueError)):
                    basis.revalidate(result)

    def test_healthy_basis_refuses_failed_pending_or_malformed_current_release(self):
        for defect in ("failed", "pending", "malformed", "wrong-release"):
            with self.subTest(defect=defect), _basis_case(self) as ports:
                if defect == "failed":
                    ports.case.run["conclusion"] = "failure"
                elif defect == "pending":
                    ports.case.release["status"] = "pending_activation"
                elif defect == "malformed":
                    ports.case.documents["prod-activation-origin.json"] = {"schema_version": 1}
                ports.case.pack()
                with self.assertRaises(basis.receipts.retention.UnsafeState):
                    basis.load(
                        "f" * 40,
                        release_run_id="400" if defect == "wrong-release" else None,
                    )

    def test_live_worker_identity_guard_has_a_broken_code_negative_control(self):
        with _basis_case(self) as ports:
            result = basis.load("f" * 40)
            ports.runtimes[basis.WORKER][1]["metadata"]["uid"] = "recreated-worker"

            def contract():
                with self.assertRaises(basis.receipts.retention.UnsafeState):
                    basis.revalidate(result)

            contract()
            original = basis._runtime
            with mock.patch.object(
                basis,
                "_runtime",
                side_effect=lambda owner, service: (
                    result["worker"] if service == basis.WORKER else original(owner, service)
                ),
            ):
                with self.assertRaises(AssertionError):
                    contract()

    def test_cached_maintenance_pass_cannot_hide_a_failed_current_attempt(self):
        with _basis_case(self) as ports:
            actual_api = ports.owner.api
            cached = {(basis.REPOSITORY, "runs/500"): copy.deepcopy(ports.case.run)}
            token = ports.owner._API_CACHE.set(cached)
            ports.case.run["conclusion"] = "failure"

            def cached_api(repository, endpoint):
                cache = ports.owner._API_CACHE.get()
                if cache is not None and (repository, endpoint) in cache:
                    return copy.deepcopy(cache[(repository, endpoint)])
                return actual_api(repository, endpoint)

            def contract():
                with self.assertRaises(basis.receipts.retention.UnsafeState):
                    basis.load("f" * 40)

            try:
                with mock.patch.object(ports.owner, "api", cached_api):
                    contract()
                    with (
                        mock.patch.object(
                            basis,
                            "_fresh_run",
                            side_effect=lambda owner, run_id: owner.api(
                                basis.REPOSITORY, f"runs/{run_id}"
                            ),
                        ),
                        mock.patch.object(
                            ports.owner,
                            "uncached_api",
                            side_effect=lambda repository, endpoint: ports.owner.api(
                                repository, endpoint
                            ),
                        ),
                    ):
                        with self.assertRaises(AssertionError):
                            contract()
            finally:
                ports.owner._API_CACHE.reset(token)

    def test_main_qualified_build_from_source_revalidates_without_checks_permission(
        self,
    ):
        source = "d" * 40
        approval = "e" * 40
        built_image = "gcr.io/hushh-pda/consent-protocol@sha256:" + "9" * 64
        ci_run = {
            "id": 910,
            "run_attempt": 1,
            "status": "completed",
            "conclusion": "success",
        }
        smoke_run = {
            "id": 911,
            "run_attempt": 1,
            "status": "completed",
            "conclusion": "success",
        }
        mapping = {
            "schema_version": 1,
            "kind": "main-application-approval",
            "application_sha": source,
            "application_tree": "1" * 40,
            "equivalence": "exact-git-tree",
            "main_approval_sha": approval,
            "predecessor_acceptance_required": "main-qualified-source",
        }

        def _digest(payload):
            return hashlib.sha256(
                json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()

        pin = {
            "schema_version": 1,
            "kind": "main-qualified-source",
            "status": "qualified",
            "repository": basis.REPOSITORY,
            "environment": "production",
            "sha": source,
            "main_approval_sha": approval,
            "resolved_services": ["backend"],
            "qualification": {
                "functional": {
                    "schema_version": 1,
                    "repository": basis.REPOSITORY,
                    "sha": source,
                    "source_branch": "main",
                    "checks": [
                        {
                            "check": "CI Status Gate",
                            "check_id": 1001,
                            "run_id": 910,
                            "run_attempt": 1,
                            "workflow": ".github/workflows/ci.yml",
                            "event": "pull_request",
                        }
                    ],
                    "authority_reads": {"runs/910": _digest(ci_run)},
                },
                "smoke": {
                    "schema_version": 1,
                    "repository": basis.REPOSITORY,
                    "sha": approval,
                    "source_branch": "main",
                    "checks": [
                        {
                            "check": "Main Post-Merge Smoke Gate",
                            "check_id": 1002,
                            "run_id": 911,
                            "run_attempt": 1,
                            "workflow": ".github/workflows/main-post-merge-smoke.yml",
                            "event": "push",
                        }
                    ],
                    "authority_reads": {"runs/911": _digest(smoke_run)},
                },
            },
            "application_approval": mapping,
        }
        with _basis_case(self) as ports:
            base_api = ports.owner.api
            seen_endpoints = []

            def actions_only_api(repository, endpoint):
                seen_endpoints.append(endpoint)
                if "check-runs" in endpoint:
                    raise AssertionError("actions-only maintenance cannot read check-runs")
                if endpoint == "runs/910":
                    return copy.deepcopy(ci_run)
                if endpoint == "runs/911":
                    return copy.deepcopy(smoke_run)
                return base_api(repository, endpoint)

            with (
                mock.patch.object(ports.owner, "api", actions_only_api),
                mock.patch.object(
                    basis.subprocess,
                    "run",
                    return_value=SimpleNamespace(returncode=0, stdout="", stderr=""),
                ),
                mock.patch.object(
                    basis.promotion_approval,
                    "verify",
                    return_value=copy.deepcopy(mapping),
                ),
            ):
                result = basis.load(
                    source,
                    candidate_image=built_image,
                    image_source="build-from-source",
                    approval_sha=approval,
                    main_qualification=pin,
                )
                self.assertEqual(result["candidate"]["source"], source)
                self.assertEqual(result["candidate"]["image"], built_image)
                self.assertEqual(
                    result["candidate"]["main_qualification"]["main_approval_sha"],
                    approval,
                )
                self.assertNotIn("uat_acceptance", result["candidate"])
                with mock.patch.object(
                    ports.owner.retention,
                    "service_state",
                    side_effect=AssertionError("source-only must not read runtime"),
                ):
                    self.assertEqual(basis.qualify_source(result), result)
                self.assertEqual(basis.revalidate(result), result)
                self.assertIn("runs/910", seen_endpoints)
                self.assertIn("runs/911", seen_endpoints)

                ci_run["conclusion"] = "cancelled"

                def drift_contract():
                    with self.assertRaises(basis.receipts.retention.UnsafeState):
                        basis.qualify_source(result)

                drift_contract()
                with mock.patch.object(
                    basis,
                    "_verify_main_qualification",
                    side_effect=lambda *_a, **_k: pin,
                ):
                    with self.assertRaises(AssertionError):
                        drift_contract()

    def test_healthy_basis_allows_failed_unserved_worker_candidate_only_when_serving_is_ready(
        self,
    ):
        with _basis_case(self) as ports:
            worker_service, worker_revision = ports.runtimes[basis.WORKER]
            serving_name = worker_revision["metadata"]["name"]
            failed_candidate = f"{basis.WORKER}-s-43698595541-1"
            worker_service["spec"]["template"] = {"metadata": {"name": failed_candidate}}
            worker_service["spec"]["traffic"] = [
                {"revisionName": serving_name, "percent": 100},
                {"revisionName": failed_candidate, "tag": "stage-a88981fa7"},
            ]
            worker_service["status"].update(
                latestCreatedRevisionName=failed_candidate,
                latestReadyRevisionName=serving_name,
                conditions=[
                    {
                        "type": "Ready",
                        "status": "False",
                        "reason": "HealthCheckContainerError",
                    }
                ],
            )
            result = basis.load("f" * 40)
            self.assertEqual(result["worker"]["revision"], serving_name)

            # Negative controls: backend service Ready=False or serving worker Ready=False must fail.
            ports.runtimes["consent-protocol"][0]["status"]["conditions"] = [
                {"type": "Ready", "status": "False", "reason": "HealthCheckContainerError"}
            ]
            with self.assertRaises(basis.receipts.retention.UnsafeState):
                basis.load("f" * 40)
            ports.runtimes["consent-protocol"][0]["status"]["conditions"] = [
                {"type": "Ready", "status": "True"}
            ]
            worker_revision["status"]["conditions"] = [{"type": "Ready", "status": "False"}]
            with self.assertRaises(basis.receipts.retention.UnsafeState):
                basis.load("f" * 40)

"""Exercise operational-reference admission through immutable proof and Git ports."""

import copy
import importlib
import json
import subprocess
import tempfile
from contextlib import ExitStack, contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import production_backend_successor as reference
import production_backend_successor_control as control
import production_backend_successor_proof as proof
import production_activation_continuation as continuation
import production_phone_receipt as phone
import release_artifact_receipts as receipts
from production_phone_receipt_fixtures import (
    archive,
    cold_revision,
    activated_receipt as _activated_receipt,
)


class _ControlPorts:
    def __init__(self, fixture):
        self.fixture = fixture
        self.git_calls = []
        self.objects = {}
        self.push_uncertain = False
        self.boundary = mock.Mock(return_value=None)
        self.prepare_proof()
        self.prepare_publisher()
        self.remote = self.original["tag_oid"]
        self.local = self.remote
        self.objects[self.remote] = self.original["tag_object"]
        self.runtime = SimpleNamespace(
            service=lambda: copy.deepcopy(self.service),
            revision=lambda _name: copy.deepcopy(self.revision),
            iam=lambda: copy.deepcopy(self.iam),
            lock_owner=mock.Mock(side_effect=lambda: copy.deepcopy(self.owner)),
        )

    def prepare_proof(self):
        # Runtime import keeps the owning mixin's module initialization acyclic.
        from production_backend_successor_cases import operational_bundle

        self.bundle = operational_bundle(self.fixture)
        self.original = self.bundle["original_healthy"]
        checkpoint, schema = self.bundle["checkpoint"], self.bundle["installed_schema"]
        traffic = [{"revisionName": schema["reference"]["revision"], "percent": 100}]
        self.service = {
            "metadata": {"uid": checkpoint["service_uid"], "generation": 7},
            "spec": {"traffic": copy.deepcopy(traffic)},
            "status": {
                "observedGeneration": 7,
                "traffic": copy.deepcopy(traffic),
                "conditions": [{"type": "Ready", "status": "True"}],
            },
        }
        self.iam = {
            "bindings": [{"role": "roles/run.invoker", "members": ["allUsers"]}]
        }
        bootstrap = proof.bootstrap_owner()
        checkpoint["controls"] = bootstrap.controls(self.service)
        checkpoint["iam"] = bootstrap.iam_fingerprint(self.iam)
        schema["snapshot"]["services"]["consent-protocol"].update(
            controls=checkpoint["controls"],
            iam=checkpoint["iam"],
            traffic=proof.digest([traffic, traffic]),
        )
        schema["runtime_checkpoint"] = proof.digest(checkpoint)
        self.revision = cold_revision(checkpoint["qualification"])
        self.revision["metadata"]["uid"] = checkpoint["cold_uid"]
        self.fixture.artifact.update(name="prod-phone-operational-300-2", expired=False)
        self.proof_payload = archive(
            self.fixture, {"operational-backend.json": self.bundle}
        )
        self.fixture.jobs["jobs"][0]["steps"] = [
            {**self.fixture.upload, "name": name} for name in proof.STEPS
        ]

    def prepare_publisher(self):
        self.owner = {
            **copy.deepcopy(self.fixture.run),
            "id": 900,
            "run_attempt": 1,
            "head_sha": "d" * 40,
            "status": "in_progress",
            "conclusion": None,
            "path": control.MAINTENANCE_WORKFLOW,
        }
        self.publication = copy.deepcopy(self.fixture.artifact)
        self.publication.update(id=901, name="prod-operational-reference-intent-900-1")
        self.publication["workflow_run"].update(id=900, head_sha=self.owner["head_sha"])
        self.publication_jobs = {
            "total_count": 1,
            "jobs": [
                {
                    "name": "Verify due cleanup without cloud credentials",
                    "run_id": 900,
                    "run_attempt": 1,
                    "head_sha": self.owner["head_sha"],
                    "head_branch": "main",
                    "status": "completed",
                    "conclusion": "success",
                    "steps": [{**self.fixture.upload, "name": control.INTENT_UPLOAD}],
                }
            ],
        }
        self.publication_inventory = {"total_count": 1, "artifacts": [self.publication]}

    def publish(self, intent):
        self.intent_payload = archive(
            SimpleNamespace(artifact=self.publication),
            {"operational-reference-intent.json": intent},
        )

    def api(self, repository, endpoint):
        if endpoint == "runs/900/attempts/1/jobs?per_page=100":
            return self.publication_jobs
        if endpoint == "runs/900/artifacts?per_page=100":
            return self.publication_inventory
        return self.fixture.api(repository, endpoint)

    def download(self, command, **_kwargs):
        selected = command[-1].split("/")[-2]
        payload = self.proof_payload if selected == "100" else self.intent_payload
        self.fixture.assertIn(selected, ("100", "901"))
        return subprocess.CompletedProcess(command, 0, payload, b"")

    def git(self, argv, *, content=None):
        self.git_calls.append(argv)
        if argv[0] == "ls-remote":
            return f"{self.remote}\t{reference.REF}\n"
        if argv[0] == "fetch":
            self.local = self.remote
            return ""
        if argv[0] == "rev-parse":
            return self.local + "\n"
        if argv[:2] == ["cat-file", "-t"]:
            return "tag\n"
        if argv[:2] == ["cat-file", "tag"]:
            return self.objects[argv[2]]
        if argv[0] == "var":
            return "Fixture publisher <publisher@example.test> 1793001000 +0000\n"
        if argv[0] == "mktag":
            identity = reference.tag_identity(content)
            self.objects[identity["tag_oid"]] = content
            return identity["tag_oid"] + "\n"
        if argv[0] == "push":
            self.fixture.assertEqual(
                argv[-1], f"--force-with-lease={reference.REF}:{self.remote}"
            )
            self.remote = argv[2].split(":", 1)[0]
            if self.push_uncertain:
                raise subprocess.TimeoutExpired("synthetic git push", 60)
            return ""
        raise AssertionError("unexpected synthetic Git operation: " + argv[0])


@contextmanager
def _control_case(fixture):
    case = _ControlPorts(fixture)
    bootstrap, runtime = proof.bootstrap_owner(), fixture.maintenance
    remote, tag, cas = (
        reference.remote_oid,
        reference.tag_object,
        reference.compare_and_swap,
    )
    case.cas = mock.Mock(side_effect=lambda old, new: cas(old, new, run=case.git))
    with ExitStack() as stack:
        for target, name, value in (
            (runtime, "api", case.api),
            (runtime.retention, "run_command", case.download),
            (bootstrap, "Runtime", lambda: case.runtime),
            (reference, "git", case.git),
            (reference, "remote_oid", lambda *, run=case.git: remote(run=run)),
            (
                reference,
                "tag_object",
                lambda commit, message: tag(commit, message, run=case.git),
            ),
            (reference, "compare_and_swap", case.cas),
            (control, "revalidate_initial", case.boundary),
        ):
            stack.enter_context(mock.patch.object(target, name, value))
        stack.enter_context(
            mock.patch.dict(
                "os.environ",
                {
                    "GITHUB_RUN_ID": "900",
                    "GITHUB_RUN_ATTEMPT": "1",
                    "GITHUB_SHA": "d" * 40,
                },
            )
        )
        folder = stack.enter_context(tempfile.TemporaryDirectory())
        case.intent = control.prepare("300", 2, Path(folder) / "intent.json")
        case.publish(case.intent)
        case.git_calls.clear()
        yield case


class OperationalBackendActivationCases:
    def test_control_healthy_requires_exact_activated_phone_retirement_receipt(self):
        with tempfile.TemporaryDirectory() as directory, _control_case(self) as case:
            path = Path(directory) / "activation.json"
            primary = case.bundle["checkpoint"]["plan"]["primary_sha"]
            candidate = "consent-protocol-primary"
            self.assertEqual(
                control.healthy("0" * 40, candidate, path), case.original["tag_oid"]
            )
            control.apply()
            with self.assertRaises(FileNotFoundError):
                control.healthy(primary, candidate, path)
            receipt = _activated_receipt(primary, candidate)
            for defect in (
                "status",
                "source",
                "run",
                "candidate",
                "floor",
                "remaining",
                "legacy425",
            ):
                evidence, sha = copy.deepcopy(receipt), primary
                if defect == "status":
                    evidence["status"] = "pending"
                elif defect == "source":
                    sha = evidence["sha"] = "0" * 40
                elif defect == "run":
                    evidence["run_id"] = "901"
                elif defect == "candidate":
                    evidence["candidate_revision"] = "consent-protocol-other"
                elif defect == "floor":
                    evidence["retirement"]["phone_admission_floor_required"] = False
                elif defect == "remaining":
                    evidence["retirement"][control.continuation._floor_key()] = 1
                else:
                    evidence["retirement"].pop(control.continuation._floor_key())
                    evidence["retirement"]["remaining_pre_phone425_count"] = 0
                path.write_text(json.dumps(evidence))
                with (
                    self.subTest(defect=defect),
                    self.assertRaisesRegex(ValueError, "activation_unconfirmed"),
                ):
                    control.healthy(sha, candidate, path)
            path.write_text(json.dumps(receipt))
            self.assertEqual(
                control.healthy(primary, candidate, path), case.intent["new_oid"]
            )
            case.cas.assert_called_once()
            self.assertEqual(case.remote, case.intent["new_oid"])

    def test_control_continuation_requires_independent_origin_before_accepting_original_run(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory, _control_case(self) as case:
            control.apply()
            primary = case.bundle["checkpoint"]["plan"]["primary_sha"]
            path = Path(directory) / "activation.json"
            receipt = _activated_receipt(primary, "consent-protocol-primary")
            receipt["run_id"] = "700"
            path.write_text(json.dumps(receipt))
            candidate = dict(
                revision=receipt["candidate_revision"],
                uid=receipt["candidate_uid"],
                service_uid=receipt["service_uid"],
                source=primary,
                run_id="700",
            )
            origin = dict(
                schema_version=1,
                kind="production-activation-continuation-origin",
                sha=primary,
                original={"run_id": 700},
                candidate=candidate,
            )
            with self.assertRaisesRegex(ValueError, "activation_unconfirmed"):
                control.healthy(primary, candidate["revision"], path)
            path.with_name(control.continuation.ORIGIN).write_text(json.dumps(origin))
            with mock.patch.object(
                control.continuation, "load_original", return_value=origin
            ) as load:
                self.assertEqual(
                    control.healthy(primary, candidate["revision"], path),
                    case.intent["new_oid"],
                )
                load.assert_called_once()
            with mock.patch.object(
                control.continuation, "load_original", return_value={}
            ):
                with self.assertRaisesRegex(ValueError, "activation_origin_changed"):
                    control.healthy(primary, candidate["revision"], path)


class OperationalBackendControlCases(OperationalBackendActivationCases):
    def test_control_applies_exact_published_objects_and_preserves_healthy_bytes(self):
        with _control_case(self) as case:
            identity = reference.tag_identity(case.intent["new_object"])
            self.assertEqual(case.intent["old_oid"], case.original["tag_oid"])
            self.assertEqual(case.intent["new_oid"], identity["tag_oid"])
            self.assertEqual(control.apply()["status"], "confirmed")
            healthy, _ = reference.split(identity["message"], identity["commit"])
            self.assertEqual(healthy, case.original["message"])
            self.assertEqual(identity["commit"], case.original["commit"])
            self.assertEqual(
                case.objects[case.original["tag_oid"]], case.original["tag_object"]
            )
            self.assertEqual(control.apply()["status"], "confirmed")
            with tempfile.TemporaryDirectory() as directory:
                repeated = control.prepare("300", 2, Path(directory) / "intent.json")
                self.assertEqual(repeated["new_oid"], case.intent["new_oid"])
                case.publish(repeated)
                self.assertEqual(control.apply()["status"], "confirmed")
            case.cas.assert_called_once_with(
                case.intent["old_oid"], case.intent["new_oid"]
            )
            self.assertEqual(sum(argv[0] == "push" for argv in case.git_calls), 1)

    def test_control_refuses_unpublished_failed_expired_or_misattributed_intent(self):
        for defect in (
            "missing",
            "failed",
            "job-failed",
            "expired",
            "publisher",
            "digest",
            "artifact-origin",
        ):
            with self.subTest(defect=defect), _control_case(self) as case:
                if defect == "missing":
                    case.publication_inventory.update(total_count=0, artifacts=[])
                elif defect == "failed":
                    case.publication_jobs["jobs"][0]["steps"][0]["conclusion"] = (
                        "failure"
                    )
                elif defect == "expired":
                    case.publication["expired"] = True
                elif defect == "job-failed":
                    case.publication_jobs["jobs"][0]["conclusion"] = "failure"
                elif defect == "artifact-origin":
                    case.publication["workflow_run"]["head_sha"] = "e" * 40
                elif defect == "publisher":
                    case.intent["publisher"]["run_attempt"] = 2
                    case.publish(case.intent)
                else:
                    case.publication["digest"] = "sha256:" + "0" * 64
                with self.assertRaises((ValueError, phone.retention.UnsafeState)):
                    control.apply()
                case.cas.assert_not_called()
                self.assertFalse(case.git_calls)
                self.assertEqual(case.remote, case.original["tag_oid"])

    def test_control_refuses_mixed_old_new_object_or_artifact_origin(self):
        for defect in ("old", "new", "object", "artifact", "record-artifact"):
            with self.subTest(defect=defect), _control_case(self) as case:
                if defect == "old":
                    case.intent["old_oid"] = "0" * 40
                elif defect == "new":
                    case.intent["new_oid"] = "0" * 40
                elif defect == "object":
                    case.intent["new_object"] = case.original["tag_object"]
                elif defect == "artifact":
                    case.intent["origin"]["artifact_id"] += 1
                else:
                    anchor = proof.qualify(case.bundle)
                    anchor["origin"] = {
                        **case.intent["origin"],
                        "artifact_digest": "sha256:" + "0" * 64,
                    }
                    message = reference.annotate(
                        case.original["message"],
                        case.original["commit"],
                        case.original["tag_oid"],
                        anchor,
                    )
                    raw = (
                        case.original["tag_object"].partition("\n\n")[0]
                        + "\n\n"
                        + message
                    )
                    identity = reference.tag_identity(raw)
                    case.intent.update(
                        new_object=raw,
                        new_oid=identity["tag_oid"],
                        origin=anchor["origin"],
                    )
                case.publish(case.intent)
                with self.assertRaises(ValueError):
                    control.apply()
                case.cas.assert_not_called()
                self.assertFalse(any(argv[0] == "push" for argv in case.git_calls))

    def test_control_replaced_live_uid_controls_or_iam_cannot_authorize_write(self):
        for defect in ("cold_uid", "service_uid", "controls", "iam"):
            with self.subTest(defect=defect), _control_case(self) as case:
                if defect == "cold_uid":
                    case.revision["metadata"]["uid"] = "replaced-cold"
                elif defect == "service_uid":
                    case.service["metadata"]["uid"] = "replaced-service"
                elif defect == "controls":
                    case.service["metadata"]["annotations"] = {
                        "run.googleapis.com/maxScale": "99"
                    }
                else:
                    case.iam["bindings"][0]["members"].append("user:other@example.test")
                with self.assertRaisesRegex(ValueError, "live_identity_changed"):
                    control.apply()
                case.cas.assert_not_called()
                self.assertFalse(any(argv[0] == "push" for argv in case.git_calls))

    def test_control_present_invalid_or_expired_operational_proof_never_falls_back(
        self,
    ):
        for defect in ("expired", "digest", "schema"):
            with self.subTest(defect=defect), _control_case(self) as case:
                control.apply()
                case.git_calls.clear()
                if defect == "expired":
                    self.artifact["expired"] = True
                elif defect == "digest":
                    self.artifact["digest"] = "sha256:" + "0" * 64
                else:
                    case.bundle["installed_schema"]["database"]["installed"] = False
                    case.proof_payload = archive(
                        self, {"operational-backend.json": case.bundle}
                    )
                with self.assertRaises((ValueError, phone.retention.UnsafeState)):
                    control.resolve()
                self.assertFalse(any(argv[0] == "push" for argv in case.git_calls))

    def test_control_concurrent_tag_replacement_never_reaches_cas(self):
        with _control_case(self) as case:
            raw = case.original["tag_object"].replace("1793000000", "1793000001", 1)
            changed = reference.tag_identity(raw)
            self.assertNotEqual(changed["tag_oid"], case.original["tag_oid"])
            case.objects[changed["tag_oid"]] = raw
            case.remote = changed["tag_oid"]
            with self.assertRaisesRegex(ValueError, "reference_changed"):
                control.apply()
            case.cas.assert_not_called()
            self.assertEqual(case.remote, changed["tag_oid"])

    def test_control_uncertain_push_uses_one_cas_and_one_readback_without_retry(self):
        with _control_case(self) as case:
            case.push_uncertain = True
            self.assertEqual(
                control.apply()["status"], "confirmed_after_uncertain_push"
            )
            pushed = [i for i, argv in enumerate(case.git_calls) if argv[0] == "push"]
            self.assertEqual(len(pushed), 1)
            self.assertEqual(
                [argv[0] for argv in case.git_calls[pushed[0] + 1 :]], ["ls-remote"]
            )
            control.apply()
            self.assertEqual(sum(argv[0] == "push" for argv in case.git_calls), 1)
            case.cas.assert_called_once()

    def test_control_owner_change_before_write_refuses_admission(self):
        with _control_case(self) as case:
            changed = {**case.owner, "run_attempt": 2}
            case.runtime.lock_owner.side_effect = [copy.deepcopy(case.owner), changed]
            with self.assertRaisesRegex(ValueError, "admission_changed"):
                control.apply()
            case.cas.assert_not_called()
            self.assertEqual(case.remote, case.original["tag_oid"])

    def test_control_fresh_initial_boundary_failure_never_reaches_cas(self):
        with _control_case(self) as case:
            case.boundary.side_effect = ValueError(
                "operational_backend_initial_boundary_changed"
            )
            with self.assertRaisesRegex(ValueError, "initial_boundary_changed"):
                control.apply()
            case.boundary.assert_called_once()
            case.cas.assert_not_called()
            self.assertEqual(case.remote, case.original["tag_oid"])

    def test_control_pending_marker_admits_only_original_source_with_backend_scope(
        self,
    ):
        with _control_case(self) as case:
            primary = case.bundle["checkpoint"]["plan"]["primary_sha"]
            with mock.patch.object(control, "_continuation_source", return_value=None):
                self.assertIsNone(control.admit("0" * 40, "frontend"))
            control.apply()
            refresh = importlib.import_module("production_auth_domain_refresh")
            for sha, scope in (
                ("0" * 40, "backend"),
                (primary, "frontend"),
                (refresh.CANDIDATE, "frontend"),
            ):
                with (
                    self.subTest(sha=sha, scope=scope),
                    self.assertRaisesRegex(
                        ValueError, "transition_requires_original_source"
                    ),
                ):
                    control.admit(sha, scope)
            self.assertIsNone(control.admit(primary, "backend"))
            self.assertIsNone(control.admit(primary, "all"))
            case.cas.assert_called_once()
            self.assertEqual(case.remote, case.intent["new_oid"])

    def test_control_admits_only_trusted_exact_auth_domain_frontend_continuation(
        self,
    ):
        refresh = importlib.import_module("production_auth_domain_refresh")
        repository = "hushh-labs/hushh-research"
        policy_path = (
            Path(control.__file__).resolve().parents[2] / "config/ci-governance.json"
        )
        policy = json.loads(policy_path.read_text())
        actor = policy["production"]["manual_dispatch_users"][0]
        inputs = {
            "sha": refresh.CANDIDATE,
            "scope": "frontend",
            "frontend_auth_domain_refresh": True,
            "emergency_source_ref": "fix/auth-domain-refresh",
            "emergency_reason": "Restore the reviewed production sign-in domain",
        }
        environment = {
            "GITHUB_REPOSITORY": repository,
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_WORKFLOW_REF": (
                f"{repository}/.github/workflows/deploy-production.yml@refs/heads/main"
            ),
            "GITHUB_SHA": "1" * 40,
            "GITHUB_ACTOR": actor,
            "GITHUB_TRIGGERING_ACTOR": actor,
            "GITHUB_RUN_ID": "701",
            "GITHUB_RUN_ATTEMPT": "2",
        }

        with tempfile.TemporaryDirectory() as directory:
            event_path = Path(directory) / "event.json"

            def attempt(
                *,
                selected_inputs=None,
                sha=refresh.CANDIDATE,
                scope="frontend",
                source=refresh.SOURCE,
                anchor=None,
                environment_changes=None,
            ):
                event_path.write_text(
                    json.dumps(
                        {"inputs": inputs if selected_inputs is None else selected_inputs}
                    )
                )
                current_environment = {
                    **environment,
                    "GITHUB_EVENT_PATH": str(event_path),
                    **(environment_changes or {}),
                }
                with (
                    mock.patch.object(proof, "read_original", return_value={}),
                    mock.patch.object(control, "record_anchor", return_value=anchor),
                    mock.patch.object(
                        control, "_continuation_source", return_value=source
                    ),
                    mock.patch.dict("os.environ", current_environment, clear=False),
                ):
                    control.admit(sha, scope)

            attempt()
            anchor = {
                "sealed_boundary": {
                    "checkpoint": {"plan": {"primary_sha": refresh.SOURCE}}
                }
            }
            with (
                mock.patch.object(
                    control,
                    "_auth_domain_frontend_exception",
                    wraps=control._auth_domain_frontend_exception,
                ) as repair_exception,
                self.assertRaisesRegex(
                    ValueError, "transition_requires_original_source"
                ),
            ):
                attempt(anchor=anchor)
            repair_exception.assert_not_called()
            invalid = (
                {"sha": "e" * 40},
                {"scope": "all"},
                {"frontend_auth_domain_refresh": False},
                {"restoration_activation_run_id": "700"},
            )
            for changes in invalid:
                with (
                    self.subTest(changes=changes),
                    self.assertRaisesRegex(
                        ValueError, "transition_requires_original_source"
                    ),
                ):
                    attempt(selected_inputs={**inputs, **changes})
            with self.assertRaisesRegex(
                ValueError, "transition_requires_original_source"
            ):
                attempt(
                    selected_inputs={**inputs, "sha": "e" * 40},
                    sha="e" * 40,
                )
            for bad_source, bad_environment in (
                ("e" * 40, None),
                (refresh.SOURCE, {"GITHUB_ACTOR": "unapproved-actor"}),
                (refresh.SOURCE, {"GITHUB_REF": "refs/heads/fix/incident"}),
            ):
                with (
                    self.subTest(source=bad_source, environment=bad_environment),
                    self.assertRaisesRegex(
                        ValueError, "transition_requires_original_source"
                    ),
                ):
                    attempt(
                        source=bad_source,
                        environment_changes=bad_environment,
                    )

    def test_auth_repair_acceptance_binds_current_restore_to_physical_backend(self):
        refresh = importlib.import_module("production_auth_domain_refresh")
        pointer = {
            "run_id": "40430296874",
            "source": refresh.SOURCE,
            "revision": "consent-protocol-00309-nir",
            "uid": "2cdde8d7-00e6-477f-860b-9e0eb26e97e5",
            "service_uid": "35918680-6774-4fa5-8d01-d1f32895cc26",
        }
        receipt = {
            "kind": "manual-production-predecessor-exception",
            "scope": "frontend",
            "authority": {
                "frontend_auth_domain_refresh": True,
                "application_sha": refresh.CANDIDATE,
            },
            "baseline": {
                "backend": {
                    "source": refresh.SOURCE,
                    "image": refresh.IMAGES["backend"],
                    "revision": pointer["revision"],
                    "revision_uid": pointer["uid"],
                    "service_uid": pointer["service_uid"],
                },
            },
        }
        profile = {
            "run_id": 40475676949,
            "run_attempt": 2,
            "workflow_sha": "a" * 40,
            "source": refresh.SOURCE,
            "backend": {
                **pointer,
                "run_id": int(pointer["run_id"]),
                "sha": refresh.SOURCE,
                "image": refresh.IMAGES["backend"],
            },
        }
        revision = {
            "metadata": {
                "name": pointer["revision"],
                "uid": pointer["uid"],
                "labels": {
                    "serving.knative.dev/service": "consent-protocol",
                    "deploy-env": "production",
                    "deploy-source": "deploy-production",
                    "deploy-sha": refresh.SOURCE,
                    "github-run-id": pointer["run_id"],
                },
            },
            "status": {"imageDigest": refresh.IMAGES["backend"]},
        }
        result = refresh.qualify_backend_acceptance_origin(receipt, profile, revision)
        self.assertEqual(result["backend"], pointer)
        self.assertEqual(result["run_id"], profile["run_id"])
        self.assertEqual(result["backend_image"], refresh.IMAGES["backend"])
        for defect in ("github-run-id", "deploy-sha", "uid"):
            broken = copy.deepcopy(revision)
            broken["metadata"]["labels"][defect] = "0" * 40
            if defect == "uid":
                broken["metadata"]["uid"] = "0" * 40
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                refresh.qualify_backend_acceptance_origin(receipt, profile, broken)
        with self.assertRaises(ValueError):
            refresh.qualify_backend_acceptance_origin(
                receipt, {**profile, "run_id": int(pointer["run_id"])}, revision
            )

    def test_auth_frontend_tag_retains_original_backend_transition_source(self):
        refresh = importlib.import_module("production_auth_domain_refresh")
        owner = control.authority()
        pointer = {
            "run_id": "40430296874",
            "source": refresh.SOURCE,
            "revision": "consent-protocol-00309-nir",
            "uid": "2cdde8d7-00e6-477f-860b-9e0eb26e97e5",
            "service_uid": "35918680-6774-4fa5-8d01-d1f32895cc26",
        }
        run = {
            "id": 40500000000,
            "run_attempt": 2,
            "head_sha": "b" * 40,
            "path": ".github/workflows/deploy-production.yml",
            "head_branch": "main",
            "event": "workflow_dispatch",
            "status": "completed",
            "conclusion": "success",
        }
        acceptance = {
            "schema_version": 1,
            "kind": "production-auth-domain-backend-acceptance",
            "run_id": 40475676949,
            "run_attempt": 2,
            "workflow_sha": "a" * 40,
            "source": refresh.SOURCE,
            "backend": pointer,
            "backend_image": refresh.IMAGES["backend"],
        }
        exception = {
            "schema_version": 1,
            "kind": "manual-production-predecessor-exception",
            "scope": "frontend",
            "ordinary_promotion_evidence": False,
            "authority": {
                "mode": "manual-emergency",
                "frontend_auth_domain_refresh": True,
                "application_sha": refresh.CANDIDATE,
                "run_id": str(run["id"]),
                "run_attempt": str(run["run_attempt"]),
                "workflow_sha": run["head_sha"],
            },
            "backend_acceptance_origin": acceptance,
        }
        run_url = f"https://github.com/{proof.REPOSITORY}/actions/runs/{run['id']}"
        current = {"commit": refresh.CANDIDATE, "tag_oid": "c" * 40, "message": "tag"}
        release = {
            "status": "healthy",
            "scope": "frontend",
            "sha": refresh.CANDIDATE,
            "backend_origin": pointer,
            "predecessor_exception": exception,
            "final": {
                "backend_revision": pointer["revision"],
                "frontend_revision": "hushh-webapp-auth-domain",
            },
        }
        identity = {
            **pointer,
            "run_id": int(pointer["run_id"]),
            "sha": refresh.SOURCE,
            "image": refresh.IMAGES["backend"],
        }
        canonical = {
            **release,
            "_maintenance_backend_identity": identity,
            "_maintenance_restoration_runtime": {"backend": identity},
        }

        fields = {
            "run": run_url,
            "backend_revision": pointer["revision"],
            "frontend_revision": "hushh-webapp-auth-domain",
        }

        def source(canonical_release=canonical, fresh_run=run, current_run=run, requested_sha=None):
            with (
                mock.patch.object(
                    proof, "read_original", return_value=copy.deepcopy(current)
                ),
                mock.patch.object(control, "authority", return_value=owner),
                mock.patch.object(reference, "split", return_value=("tag", None)),
                mock.patch.object(reference, "healthy_fields", return_value=fields),
                mock.patch.object(owner, "api", return_value=current_run),
                mock.patch.object(owner, "governed_dispatch", return_value=True),
                mock.patch.object(
                    owner, "find_release", return_value=(run["id"], canonical_release)
                ),
                mock.patch.object(owner, "uncached_api", return_value=fresh_run),
                mock.patch.object(
                    receipts, "current_attempt_artifact", return_value=(object(), object())
                ),
                mock.patch.object(receipts, "immutable_archive", return_value=b"archive"),
                mock.patch.object(phone, "_document", return_value=release),
                mock.patch.object(continuation, "archive_context", return_value=None),
            ):
                if requested_sha is None:
                    return control._continuation_source(current)
                return control.admit(requested_sha, "backend")

        self.assertEqual(source(), refresh.SOURCE)
        self.assertIsNone(source(requested_sha=refresh.SOURCE))
        with self.assertRaisesRegex(ValueError, "transition_requires_original_source"):
            source(requested_sha="e" * 40)
        failed_run = {**run, "conclusion": "failure"}
        with mock.patch.object(owner, "verify_post_release_failure") as verified_failure:
            self.assertEqual(source(canonical, failed_run, failed_run), refresh.SOURCE)
            verified_failure.assert_called_once()
        with mock.patch.object(
            owner,
            "verify_post_release_failure",
            side_effect=ValueError("unverified post-release failure"),
        ):
            with self.assertRaisesRegex(ValueError, "unverified post-release failure"):
                source(canonical, failed_run, failed_run)
        changed_identity = copy.deepcopy(canonical)
        changed_identity["_maintenance_backend_identity"]["service_uid"] = "wrong"
        with self.assertRaisesRegex(ValueError, "qualified physical backend"):
            source(changed_identity)
        changed_attempt = {**run, "run_attempt": run["run_attempt"] + 1}
        with self.assertRaisesRegex(ValueError, "qualified physical backend"):
            source(canonical, changed_attempt)

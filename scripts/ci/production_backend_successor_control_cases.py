"""Exercise operational-reference admission through immutable proof and Git ports."""

import copy
import importlib
import json
import subprocess
import tempfile
from contextlib import ExitStack, contextmanager
from io import BytesIO
from zipfile import ZipFile
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


def _auth_operational_reference(refresh, *, anchored=True):
    healthy = (
        "Last known good — production\n"
        f"sha: {refresh.SOURCE}\n"
        "backend_revision: consent-protocol-00309-nir\n"
        "backend_url: https://api.example.test\n"
        "frontend_revision: hushh-webapp-restored\n"
        "frontend_url: https://app.example.test\n"
        "run: https://github.com/hushh-labs/hushh-research/actions/runs/40475676949\n"
        "actor: governed-maintainer\n"
        "tagged_at: 20261102T100000Z\n"
    )
    tagger = "Release owner <release@example.test> 1793613600 +0000"
    header = (
        f"object {refresh.SOURCE}\ntype commit\ntag "
        f"{reference.REF.removeprefix('refs/tags/')}\ntagger {tagger}\n\n"
    )
    original = reference.tag_identity(header + healthy)
    anchor = None
    message = healthy
    if anchored:
        anchor = {
            "origin": {
                "run_id": "40884680280",
                "run_attempt": 1,
                "workflow_sha": "a" * 40,
                "artifact_id": 411,
                "artifact_digest": "sha256:" + "b" * 64,
            },
            "revision": "consent-protocol-00312-anchor",
            "source": refresh.ACTIVE_ANCHOR_SOURCE,
            "image": refresh.IMAGES["backend"],
            "uid": "anchor-revision-uid",
            "original_healthy": original,
            "sealed_boundary": {
                "checkpoint": {
                    "plan": {"primary_sha": refresh.ACTIVE_ANCHOR_PRIMARY_SOURCE}
                }
            },
        }
        message = reference.annotate(healthy, refresh.SOURCE, original["tag_oid"], anchor)
    tag = reference.tag_identity(header + message)
    _, record = reference.split(tag["message"], tag["commit"])
    return {
        "ref": reference.REF,
        "tag_oid": tag["tag_oid"],
        "commit": tag["commit"],
        "healthy_message": healthy,
        "anchor_record": record,
        "tag_object": tag["tag_object"],
    }, tag, anchor


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
    def test_historical_auth_publication_reconciliation_is_exact_and_read_only(self):
        refresh = importlib.import_module("production_auth_domain_refresh")
        record = refresh.PUBLICATION_RECONCILIATION
        for defect in (None, "attempt", "artifact", "release", "failure", "tag", "preserved", "newer", "ambiguous-member", "duplicate-json"):
            with self.subTest(defect=defect), ExitStack() as stack:
                run = {"id": record["run_id"], "run_attempt": record["attempt"],
                       "head_sha": record["workflow_sha"], "status": "completed",
                       "conclusion": "failure", "event": "workflow_dispatch",
                       "head_branch": "main", "path": ".github/workflows/deploy-production.yml"}
                fresh = copy.deepcopy(run)
                publication = {"status": "refused", "immutable_ref": record["immutable_ref"],
                               "immutable_tag_oid": None,
                               "preserved_operational_tag_oid": record["preserved_operational_oid"]}
                release = {"sha": refresh.CANDIDATE, "scope": "frontend", "status": "healthy",
                           "auth_domain_tag_publication": publication}
                archived = copy.deepcopy(release)
                artifact = {"id": record["artifact_id"], "digest": record["artifact_digest"]}
                job = {"name": "Deploy Production Scope", "conclusion": "failure", "steps": [
                    {"name": "Fail workflow when production release did not end healthy",
                     "conclusion": "failure", "status": "completed"}]}
                immutable = {"ref": record["immutable_ref"],
                             "object": {"type": "tag", "sha": record["tag_oid"]}}
                preserved = {"ref": reference.REF,
                             "object": {"type": "tag", "sha": record["preserved_operational_oid"]}}
                tag = {"sha": record["tag_oid"], "tag": record["immutable_ref"].removeprefix("refs/tags/"),
                       "object": {"type": "commit", "sha": refresh.CANDIDATE}}
                if defect == "attempt":
                    run["run_attempt"] += 1
                if defect == "artifact":
                    artifact["digest"] = "sha256:" + "0" * 64
                if defect == "release":
                    release["scope"] = "all"
                if defect == "failure":
                    job["steps"].append({"name": "Other failure", "conclusion": "failure", "status": "completed"})
                if defect == "tag":
                    immutable["object"]["sha"] = "0" * 40
                if defect == "preserved":
                    preserved["object"]["sha"] = "0" * 40
                if defect == "newer":
                    fresh["run_attempt"] += 1
                def command(*args):
                    self.assertEqual(args[:2], ("gh", "api"))
                    path = args[2]
                    self.assertTrue(path.startswith(f"repos/{proof.REPOSITORY}/git/"))
                    return json.dumps(tag if "/tags/" in path and "/ref/" not in path
                                      else preserved if path.endswith("production-latest") else immutable)
                owner = SimpleNamespace(governed_dispatch=lambda *args: True,
                    LANES={"production": {}}, api=mock.Mock(), _github_timestamp=mock.Mock(),
                    retention=SimpleNamespace(run_command=mock.Mock()), command=command,
                    uncached_api=lambda *args: fresh)
                stack.enter_context(mock.patch.object(control, "authority", return_value=owner))
                stack.enter_context(mock.patch.object(receipts, "current_attempt_artifact", return_value=(artifact, job)))
                buffer = BytesIO()
                with ZipFile(buffer, "w") as bundle:
                    body = json.dumps(archived)
                    if defect == "duplicate-json":
                        body = body[:-1] + ', "status": "healthy"}'
                    bundle.writestr("tmp/prod-release-status.json", body)
                    if defect == "ambiguous-member":
                        bundle.writestr("prod-release-status.json", body)
                stack.enter_context(mock.patch.object(receipts, "immutable_archive", return_value=buffer.getvalue()))
                if defect:
                    with self.assertRaises((ValueError, receipts.retention.UnsafeState)):
                        control.reconciled_auth_domain_publication(proof.REPOSITORY, run, release)
                else:
                    self.assertTrue(control.reconciled_auth_domain_publication(proof.REPOSITORY, run, release))
                    self.assertFalse(control.reconciled_auth_domain_publication(proof.REPOSITORY, {**run, "id": 123}, release))

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
                "source": refresh.ACTIVE_ANCHOR_SOURCE,
                "original_healthy": {"commit": refresh.SOURCE},
                "sealed_boundary": {
                    "checkpoint": {
                        "plan": {"primary_sha": refresh.ACTIVE_ANCHOR_PRIMARY_SOURCE}
                    }
                }
            }
            with (
                mock.patch.object(
                    control,
                    "_auth_domain_frontend_exception",
                    wraps=control._auth_domain_frontend_exception,
                ) as repair_exception,
            ):
                attempt(anchor=anchor)
            repair_exception.assert_called_once_with(
                refresh.CANDIDATE, "frontend", refresh.SOURCE
            )
            wrong_anchor = {
                **anchor,
                "source": "e" * 40,
            }
            with self.assertRaisesRegex(ValueError, "transition_requires_original_source"):
                attempt(anchor=wrong_anchor)
            for wrong_field, wrong_value in (
                ("primary_sha", refresh.SOURCE),
                ("healthy_commit", refresh.ACTIVE_ANCHOR_PRIMARY_SOURCE),
            ):
                broken_anchor = copy.deepcopy(anchor)
                if wrong_field == "primary_sha":
                    broken_anchor["sealed_boundary"]["checkpoint"]["plan"][
                        "primary_sha"
                    ] = wrong_value
                else:
                    broken_anchor["original_healthy"]["commit"] = wrong_value
                with (
                    self.subTest(wrong_field=wrong_field),
                    self.assertRaisesRegex(
                        ValueError, "transition_requires_original_source"
                    ),
                ):
                    attempt(anchor=broken_anchor)
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
            with self.assertRaisesRegex(
                ValueError, "transition_requires_original_source"
            ):
                attempt(source="e" * 40, anchor=None)
            for bad_environment in (
                {"GITHUB_ACTOR": "unapproved-actor"},
                {"GITHUB_REF": "refs/heads/fix/incident"},
            ):
                with (
                    self.subTest(environment=bad_environment),
                    self.assertRaisesRegex(
                        ValueError, "transition_requires_original_source"
                    ),
                ):
                    attempt(
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
            "operational_reference": _auth_operational_reference(refresh)[0],
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
        for defect in ("tag_oid", "tag_object", "anchor_source"):
            broken = copy.deepcopy(profile)
            if defect == "tag_oid":
                broken["operational_reference"]["tag_oid"] = "0" * 40
            elif defect == "tag_object":
                broken["operational_reference"]["tag_object"] = "untrusted"
            else:
                broken["operational_reference"]["anchor_record"]["source"] = "0" * 40
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                refresh.qualify_backend_acceptance_origin(receipt, broken, revision)

    def test_auth_profile_revalidates_active_anchor_and_matches_serving_restore(self):
        refresh = importlib.import_module("production_auth_domain_refresh")
        operational, current, anchor = _auth_operational_reference(refresh, anchored=True)
        self.assertEqual(anchor["source"], refresh.ACTIVE_ANCHOR_SOURCE)
        self.assertNotEqual(anchor["source"], refresh.SOURCE)
        self.assertEqual(
            anchor["sealed_boundary"]["checkpoint"]["plan"]["primary_sha"],
            refresh.ACTIVE_ANCHOR_PRIMARY_SOURCE,
        )
        self.assertEqual(anchor["source"], refresh.ACTIVE_ANCHOR_SOURCE)
        self.assertEqual(anchor["original_healthy"]["commit"], refresh.SOURCE)
        self.assertEqual(
            len({
                anchor["source"],
                anchor["sealed_boundary"]["checkpoint"]["plan"]["primary_sha"],
                anchor["original_healthy"]["commit"],
            }),
            3,
        )
        run = {
            "id": 40475676949,
            "run_attempt": 2,
            "head_sha": "a" * 40,
            "status": "completed",
            "conclusion": "success",
            "path": ".github/workflows/deploy-production.yml",
            "head_branch": "main",
            "event": "workflow_dispatch",
        }
        identity = {
            "run_id": 40430296874,
            "source": refresh.SOURCE,
            "sha": refresh.SOURCE,
            "revision": "consent-protocol-00309-nir",
            "uid": "2cdde8d7-00e6-477f-860b-9e0eb26e97e5",
            "service_uid": "35918680-6774-4fa5-8d01-d1f32895cc26",
            "image": refresh.IMAGES["backend"],
        }
        release = {
            "status": "healthy",
            "scope": "all",
            "sha": refresh.SOURCE,
            "production_restoration": {"status": "validated"},
            "restoration_activation": {"status": "activated"},
            "final": {
                "backend_revision": identity["revision"],
                "frontend_revision": "hushh-webapp-restored",
            },
            "_maintenance_backend_identity": identity,
            "_maintenance_restoration_runtime": {
                "backend": identity,
                "frontend": {"revision": "hushh-webapp-restored"},
            },
        }
        fields = {
            "run": "https://github.com/hushh-labs/hushh-research/actions/runs/40475676949",
            "backend_revision": identity["revision"],
            "frontend_revision": "hushh-webapp-restored",
        }
        observed = {
            "backend": {
                "revision": identity["revision"],
                "revision_uid": identity["uid"],
                "service_uid": identity["service_uid"],
                "source": refresh.SOURCE,
                "image": refresh.IMAGES["backend"],
            }
        }
        owner = control.authority()
        with (
            mock.patch.object(proof, "read_original", return_value=current),
            mock.patch.object(control, "record_anchor", return_value=anchor),
            mock.patch.object(control, "live") as live,
            mock.patch.object(control, "authority", return_value=owner),
            mock.patch.object(reference, "split", return_value=(operational["healthy_message"], operational["anchor_record"])),
            mock.patch.object(reference, "healthy_fields", return_value=fields),
            mock.patch.object(owner, "api", return_value=run),
            mock.patch.object(owner, "uncached_api", return_value=run),
            mock.patch.object(owner, "governed_dispatch", return_value=True),
            mock.patch.object(owner, "find_release", return_value=(run["id"], release)),
        ):
            profile = control.current_auth_domain_acceptance_profile(observed)
            self.assertEqual(profile["operational_reference"], operational)
            live.assert_called_once_with(anchor, initial=True)
            live.reset_mock()
            deferred = control.current_auth_domain_acceptance_profile(
                observed, revalidate_live=False
            )
            self.assertEqual(deferred, profile)
            live.assert_not_called()
            with self.assertRaisesRegex(ValueError, "captured serving baseline"):
                control.current_auth_domain_acceptance_profile(revalidate_live=False)
            with self.assertRaisesRegex(ValueError, "serving backend differs"):
                control.current_auth_domain_acceptance_profile(
                    {"backend": {**observed["backend"], "source": "0" * 40}}
                )

    def _auth_reference_revalidation_fixture(self):
        refresh = importlib.import_module("production_auth_domain_refresh")
        operational, _current, anchor = _auth_operational_reference(
            refresh, anchored=True
        )
        revision_name = "consent-protocol-00309-nir"
        revision_uid = "2cdde8d7-00e6-477f-860b-9e0eb26e97e5"
        service_uid = "35918680-6774-4fa5-8d01-d1f32895cc26"
        principal = "consent-protocol-runtime@hushh-pda.iam.gserviceaccount.com"
        traffic = [{"revisionName": revision_name, "percent": 100}]
        service = {
            "metadata": {
                "name": "consent-protocol",
                "uid": service_uid,
                "generation": 7,
            },
            "spec": {"traffic": copy.deepcopy(traffic)},
            "status": {
                "observedGeneration": 7,
                "conditions": [{"type": "Ready", "status": "True"}],
                "traffic": copy.deepcopy(traffic),
            },
        }
        revision = {
            "metadata": {
                "name": revision_name,
                "uid": revision_uid,
                "labels": {
                    "serving.knative.dev/service": "consent-protocol",
                    "deploy-env": "production",
                    "deploy-source": "deploy-production",
                    "deploy-sha": refresh.SOURCE,
                    "github-run-id": "40430296874",
                },
            },
            "spec": {
                "serviceAccountName": principal,
                "containers": [{"image": refresh.IMAGES["backend"]}],
            },
            "status": {
                "imageDigest": refresh.IMAGES["backend"],
                "conditions": [{"type": "Ready", "status": "True"}],
            },
        }
        observed = {
            "backend": {
                "service": "consent-protocol",
                "service_uid": service_uid,
                "generation": "7",
                "revision": revision_name,
                "revision_uid": revision_uid,
                "source": refresh.SOURCE,
                "image": refresh.IMAGES["backend"],
                "workload_principal": principal,
            }
        }
        accepted = {
            "run_id": "40430296874",
            "source": refresh.SOURCE,
            "revision": revision_name,
            "uid": revision_uid,
            "service_uid": service_uid,
            "image": refresh.IMAGES["backend"],
        }
        anchor["serving_reference"] = {"revision": revision_name}
        anchor["runtime"] = {
            "service_uid": service_uid,
            "controls": "controls-fingerprint",
            "iam": "iam-fingerprint",
            "initial_traffic": proof.digest([traffic, traffic]),
        }
        iam = {"version": 1, "bindings": []}
        controls = {"value": "controls-fingerprint"}
        iam_fingerprint = {"value": "iam-fingerprint"}
        ports = SimpleNamespace(
            service=lambda: service,
            revision=lambda _name: revision,
            iam=lambda: iam,
        )
        owner = SimpleNamespace(
            Runtime=lambda: ports,
            controls=lambda _service: controls["value"],
            iam_fingerprint=lambda _policy: iam_fingerprint["value"],
            _positive=lambda _service: [[revision_name, 100]],
        )
        profile = {"operational_reference": operational, "backend": accepted}
        return (
            refresh,
            operational,
            anchor,
            observed,
            service,
            profile,
            owner,
            controls,
            iam_fingerprint,
        )

    def test_auth_reference_revalidation_checks_actual_serving_pair_and_anchor(self):
        fixture = self._auth_reference_revalidation_fixture()
        refresh, operational, anchor, observed = fixture[:4]
        profile, owner = fixture[5:7]
        with (
            mock.patch.object(
                control,
                "current_auth_domain_acceptance_profile",
                return_value=profile,
            ) as resolve_profile,
            mock.patch.object(control, "load_anchor", return_value=anchor) as load_anchor,
            mock.patch.object(proof, "bootstrap_owner", return_value=owner),
            mock.patch.object(control, "live") as live,
            mock.patch.object(control, "revalidate_initial") as initial,
        ):
            control.revalidate_auth_domain_reference(operational, observed)
            resolve_profile.assert_called_once_with(observed, revalidate_live=False)
            load_anchor.assert_called_once_with(anchor["origin"]["run_id"], 1)
            live.assert_not_called()
            initial.assert_not_called()

        for defect in (
            "reference",
            "anchor_source",
            "anchor_primary",
            "anchor_healthy_source",
            "anchor_origin",
            "backend_revision",
            "backend_revision_uid",
            "service_uid",
            "backend_source",
            "backend_image",
            "service_controls",
            "iam",
            "traffic_digest",
            "mixed_traffic",
        ):
            with self.subTest(defect=defect):
                (
                    _refresh,
                    operational,
                    anchor,
                    observed,
                    service,
                    profile,
                    owner,
                    controls,
                    iam_fingerprint,
                ) = self._auth_reference_revalidation_fixture()
                if defect == "reference":
                    profile["operational_reference"] = {
                        **operational,
                        "tag_oid": "0" * 40,
                    }
                elif defect == "anchor_source":
                    anchor["source"] = "0" * 40
                elif defect == "anchor_primary":
                    anchor["sealed_boundary"]["checkpoint"]["plan"]["primary_sha"] = "0" * 40
                elif defect == "anchor_healthy_source":
                    anchor["original_healthy"]["commit"] = "0" * 40
                elif defect == "anchor_origin":
                    anchor["origin"]["run_id"] = "1"
                elif defect == "backend_revision":
                    observed["backend"]["revision"] = "consent-protocol-00312-anchor"
                elif defect == "backend_revision_uid":
                    observed["backend"]["revision_uid"] = "changed-revision-uid"
                elif defect == "service_uid":
                    observed["backend"]["service_uid"] = "changed-service-uid"
                elif defect == "backend_source":
                    observed["backend"]["source"] = "0" * 40
                elif defect == "backend_image":
                    observed["backend"]["image"] = "gcr.io/hushh-pda/consent-protocol@sha256:" + "0" * 64
                elif defect == "service_controls":
                    controls["value"] = "changed-controls"
                elif defect == "iam":
                    iam_fingerprint["value"] = "changed-iam"
                elif defect == "traffic_digest":
                    service["spec"]["traffic"].append(
                        {"revisionName": "consent-protocol-tagged", "percent": 0}
                    )
                elif defect == "mixed_traffic":
                    service["status"]["traffic"].append(
                        {"revisionName": "consent-protocol-other", "percent": 10}
                    )
                with (
                    mock.patch.object(
                        control,
                        "current_auth_domain_acceptance_profile",
                        return_value=profile,
                    ),
                    mock.patch.object(control, "load_anchor", return_value=anchor),
                    mock.patch.object(proof, "bootstrap_owner", return_value=owner),
                    self.assertRaises(ValueError),
                ):
                    control.revalidate_auth_domain_reference(operational, observed)

    def test_auth_tag_publication_is_immutable_and_preserves_operational_reference(self):
        refresh = importlib.import_module("production_auth_domain_refresh")
        opref, current, anchor = _auth_operational_reference(refresh, anchored=True)
        authority = {
            "frontend_auth_domain_refresh": True,
            "application_sha": refresh.CANDIDATE,
            "run_id": "701",
            "run_attempt": "2",
            "workflow_sha": "1" * 40,
        }
        status = {
            "status": "healthy",
            "scope": "frontend",
            "sha": refresh.CANDIDATE,
            "final": {
                "backend_revision": "consent-protocol-00309-nir",
                "frontend_revision": "hushh-webapp-auth-domain",
            },
            "predecessor_exception": {
                "scope": "frontend",
                "ordinary_promotion_evidence": False,
                "authority": authority,
                "backend_acceptance_origin": {"operational_reference": opref},
            },
        }
        expected_latest = current["tag_oid"]
        published_oid = "f" * 40
        published_ref = ""
        calls = []
        config_writes = []

        def git(args, *, content=None):
            nonlocal published_ref
            calls.append((args, content))
            if args[:3] == ["ls-remote", "--refs", "origin"]:
                ref = args[3]
                if ref == reference.REF:
                    return f"{expected_latest}\t{ref}\n"
                return f"{published_oid}\t{ref}\n" if ref == published_ref else ""
            if args[:2] == ["config", "user.email"] or args[:2] == ["config", "user.name"]:
                return "release@example.test\n"
            if args[0] == "config":
                config_writes.append(args)
                return ""
            if args[:2] == ["rev-parse", "refs/tags"]:
                return published_oid
            if args[0] == "rev-parse":
                return published_oid
            if args[0] == "push":
                self.assertEqual(args[1], "origin")
                published_ref = args[2]
                return ""
            return ""

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "prod-release-status.json"
            path.write_text(json.dumps(status))
            with (
                mock.patch.object(proof, "read_original", return_value=current),
                mock.patch.object(control, "record_anchor", return_value=anchor),
                mock.patch.object(control, "_auth_domain_frontend_exception", return_value=True),
                mock.patch.dict(
                    "os.environ",
                    {
                        "GITHUB_RUN_ID": "701",
                        "GITHUB_RUN_ATTEMPT": "2",
                        "GITHUB_SHA": "1" * 40,
                        "RUN_URL": "https://github.com/hushh-labs/hushh-research/actions/runs/701",
                        "ACTOR": "operator",
                    },
                    clear=False,
                ),
            ):
                result = control.publish_auth_domain_tag(path, refresh.CANDIDATE, run=git)
            written = json.loads(path.read_text())
        self.assertEqual(result["status"], "published")
        self.assertEqual(result["preserved_operational_tag_oid"], expected_latest)
        self.assertEqual(result["operational_ref_readback_oid"], expected_latest)
        self.assertEqual(written["auth_domain_tag_publication"], result)
        self.assertEqual(config_writes, [])
        pushes = [args for args, _ in calls if args[0] == "push"]
        self.assertEqual(len(pushes), 1)
        self.assertEqual(pushes[0][1], "origin")
        self.assertTrue(pushes[0][2].startswith("refs/tags/deployed/production/"))

    def test_auth_tag_publication_defaults_only_missing_git_identity(self):
        refresh = importlib.import_module("production_auth_domain_refresh")
        opref, current, anchor = _auth_operational_reference(refresh, anchored=True)
        authority = {
            "frontend_auth_domain_refresh": True,
            "application_sha": refresh.CANDIDATE,
            "run_id": "701",
            "run_attempt": "2",
            "workflow_sha": "1" * 40,
        }
        status = {
            "status": "healthy",
            "scope": "frontend",
            "sha": refresh.CANDIDATE,
            "predecessor_exception": {
                "scope": "frontend",
                "ordinary_promotion_evidence": False,
                "authority": authority,
                "backend_acceptance_origin": {"operational_reference": opref},
            },
        }
        expected_latest = current["tag_oid"]
        published_oid = "f" * 40

        for mode in ("missing", "error"):
            with self.subTest(mode=mode):
                published_ref = ""
                calls = []
                config_writes = []

                def git(args, *, content=None):
                    nonlocal published_ref
                    calls.append(args)
                    if args[:3] == ["ls-remote", "--refs", "origin"]:
                        ref = args[3]
                        if ref == reference.REF:
                            return f"{expected_latest}\t{ref}\n"
                        return f"{published_oid}\t{ref}\n" if ref == published_ref else ""
                    if len(args) == 2 and args[:2] in (
                        ["config", "user.email"],
                        ["config", "user.name"],
                    ):
                        if mode == "missing":
                            raise subprocess.CalledProcessError(
                                1, args, output="", stderr=""
                            )
                        raise subprocess.CalledProcessError(
                            1, args, output="", stderr="fatal: invalid Git config"
                        )
                    if args[0] == "config":
                        config_writes.append(args)
                        return ""
                    if args[0] == "rev-parse":
                        return published_oid
                    if args[0] == "push":
                        published_ref = args[2]
                        return ""
                    return ""

                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "prod-release-status.json"
                    path.write_text(json.dumps(status))
                    with (
                        mock.patch.object(proof, "read_original", return_value=current),
                        mock.patch.object(control, "record_anchor", return_value=anchor),
                        mock.patch.object(
                            control, "_auth_domain_frontend_exception", return_value=True
                        ),
                        mock.patch.dict(
                            "os.environ",
                            {
                                "GITHUB_RUN_ID": "701",
                                "GITHUB_RUN_ATTEMPT": "2",
                                "GITHUB_SHA": "1" * 40,
                                "RUN_URL": "https://github.com/hushh-labs/hushh-research/actions/runs/701",
                                "ACTOR": "operator",
                            },
                            clear=False,
                        ),
                    ):
                        if mode == "missing":
                            result = control.publish_auth_domain_tag(
                                path, refresh.CANDIDATE, run=git
                            )
                            self.assertEqual(result["status"], "published")
                            self.assertEqual(
                                config_writes,
                                [
                                    [
                                        "config",
                                        "user.email",
                                        "41898282+github-actions[bot]@users.noreply.github.com",
                                    ],
                                    ["config", "user.name", "github-actions[bot]"],
                                ],
                            )
                            self.assertEqual(
                                len([args for args in calls if args[0] == "push"]), 1
                            )
                        else:
                            with self.assertRaisesRegex(ValueError, "unconfirmed"):
                                control.publish_auth_domain_tag(
                                    path, refresh.CANDIDATE, run=git
                                )
                            written = json.loads(path.read_text())
                            self.assertEqual(
                                written["auth_domain_tag_publication"]["status"],
                                "refused",
                            )
                            self.assertEqual(config_writes, [])
                            self.assertFalse(
                                any(args[0] in {"tag", "push"} for args in calls)
                            )

    def test_auth_tag_publication_refuses_a_moved_operational_reference(self):
        refresh = importlib.import_module("production_auth_domain_refresh")
        opref, current, anchor = _auth_operational_reference(refresh, anchored=True)
        status = {
            "status": "healthy",
            "scope": "frontend",
            "sha": refresh.CANDIDATE,
            "predecessor_exception": {
                "scope": "frontend",
                "ordinary_promotion_evidence": False,
                "authority": {
                    "frontend_auth_domain_refresh": True,
                    "application_sha": refresh.CANDIDATE,
                    "run_id": "701",
                    "run_attempt": "2",
                    "workflow_sha": "1" * 40,
                },
                "backend_acceptance_origin": {"operational_reference": opref},
            },
        }
        changed_oid = "e" * 40
        calls = []

        def git(args, *, content=None):
            calls.append(args)
            if args[:3] == ["ls-remote", "--refs", "origin"]:
                return f"{changed_oid}\t{args[3]}\n"
            return ""

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "prod-release-status.json"
            path.write_text(json.dumps(status))
            with (
                mock.patch.object(proof, "read_original", return_value=current),
                mock.patch.object(control, "record_anchor", return_value=anchor),
                mock.patch.object(control, "_auth_domain_frontend_exception", return_value=True),
                mock.patch.dict(
                    "os.environ",
                    {"GITHUB_RUN_ID": "701", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_SHA": "1" * 40},
                    clear=False,
                ),
                self.assertRaisesRegex(ValueError, "moved before publication"),
            ):
                control.publish_auth_domain_tag(path, refresh.CANDIDATE, run=git)
            written = json.loads(path.read_text())
        self.assertEqual(written["auth_domain_tag_publication"]["status"], "refused")
        self.assertEqual(written["auth_domain_tag_publication"]["operational_ref_readback_oid"], changed_oid)
        self.assertFalse(any(args[0] == "push" for args in calls))

    def test_auth_tag_publication_records_reference_race_after_immutable_write(self):
        refresh = importlib.import_module("production_auth_domain_refresh")
        opref, current, anchor = _auth_operational_reference(refresh, anchored=True)
        authority = {
            "frontend_auth_domain_refresh": True,
            "application_sha": refresh.CANDIDATE,
            "run_id": "701",
            "run_attempt": "2",
            "workflow_sha": "1" * 40,
        }
        status = {
            "status": "healthy",
            "scope": "frontend",
            "sha": refresh.CANDIDATE,
            "predecessor_exception": {
                "scope": "frontend",
                "ordinary_promotion_evidence": False,
                "authority": authority,
                "backend_acceptance_origin": {"operational_reference": opref},
            },
        }
        changed_oid, published_oid = "e" * 40, "f" * 40
        latest_reads = 0
        published_ref = ""
        calls = []

        def git(args, *, content=None):
            nonlocal latest_reads, published_ref
            calls.append(args)
            if args[:3] == ["ls-remote", "--refs", "origin"]:
                if args[3] == reference.REF:
                    latest_reads += 1
                    return f"{opref['tag_oid'] if latest_reads == 1 else changed_oid}\t{args[3]}\n"
                return f"{published_oid}\t{args[3]}\n" if args[3] == published_ref else ""
            if args[:2] in (["config", "user.email"], ["config", "user.name"]):
                return "release@example.test\n"
            if args[0] == "rev-parse":
                return published_oid
            if args[0] == "push":
                published_ref = args[2]
                return ""
            return ""

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "prod-release-status.json"
            path.write_text(json.dumps(status))
            with (
                mock.patch.object(proof, "read_original", return_value=current),
                mock.patch.object(control, "record_anchor", return_value=anchor),
                mock.patch.object(control, "_auth_domain_frontend_exception", return_value=True),
                mock.patch.dict(
                    "os.environ",
                    {"GITHUB_RUN_ID": "701", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_SHA": "1" * 40},
                    clear=False,
                ),
                self.assertRaisesRegex(ValueError, "unconfirmed"),
            ):
                control.publish_auth_domain_tag(path, refresh.CANDIDATE, run=git)
            result = json.loads(path.read_text())["auth_domain_tag_publication"]
        self.assertEqual(result["status"], "refused")
        self.assertTrue(result["immutable_tag_readback_matches"])
        self.assertEqual(result["operational_ref_readback_oid"], changed_oid)
        pushes = [args for args in calls if args[0] == "push"]
        self.assertEqual(len(pushes), 1)
        self.assertNotEqual(pushes[0][2], reference.REF)

    def test_auth_lost_push_never_adopts_a_foreign_immutable_tag(self):
        refresh = importlib.import_module("production_auth_domain_refresh")
        opref, current, anchor = _auth_operational_reference(refresh, anchored=True)
        authority = {
            "frontend_auth_domain_refresh": True,
            "application_sha": refresh.CANDIDATE,
            "run_id": "701",
            "run_attempt": "2",
            "workflow_sha": "1" * 40,
        }
        status = {
            "status": "healthy",
            "scope": "frontend",
            "sha": refresh.CANDIDATE,
            "predecessor_exception": {
                "scope": "frontend",
                "ordinary_promotion_evidence": False,
                "authority": authority,
                "backend_acceptance_origin": {"operational_reference": opref},
            },
        }
        local_oid, foreign_oid = "f" * 40, "e" * 40
        published_ref = ""
        calls = []

        def git(args, *, content=None):
            nonlocal published_ref
            calls.append(args)
            if args[:3] == ["ls-remote", "--refs", "origin"]:
                ref = args[3]
                if ref == reference.REF:
                    return f"{opref['tag_oid']}\t{ref}\n"
                return f"{foreign_oid}\t{ref}\n" if ref == published_ref else ""
            if args[:2] in (["config", "user.email"], ["config", "user.name"]):
                return "release@example.test\n"
            if args[0] == "rev-parse":
                return local_oid
            if args[0] == "push":
                published_ref = args[2]
                raise subprocess.CalledProcessError(1, args, stderr="push response lost")
            return ""

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "prod-release-status.json"
            path.write_text(json.dumps(status))
            with (
                mock.patch.object(proof, "read_original", return_value=current),
                mock.patch.object(control, "record_anchor", return_value=anchor),
                mock.patch.object(control, "_auth_domain_frontend_exception", return_value=True),
                mock.patch.dict(
                    "os.environ",
                    {"GITHUB_RUN_ID": "701", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_SHA": "1" * 40},
                    clear=False,
                ),
                self.assertRaisesRegex(ValueError, "unconfirmed"),
            ):
                control.publish_auth_domain_tag(path, refresh.CANDIDATE, run=git)
            publication = json.loads(path.read_text())["auth_domain_tag_publication"]
        self.assertEqual(publication["status"], "refused")
        self.assertEqual(publication["immutable_tag_oid"], local_oid)
        self.assertFalse(publication["immutable_tag_readback_matches"])
        self.assertEqual(publication["operational_ref_readback_oid"], opref["tag_oid"])
        self.assertEqual(len([args for args in calls if args[0] == "push"]), 1)

    def test_auth_publication_gate_requires_exact_readbacks(self):
        refresh = importlib.import_module("production_auth_domain_refresh")
        sha = refresh.CANDIDATE
        publication = {
            "status": "published",
            "immutable_ref": f"refs/tags/deployed/production/{sha[:8]}-20261102T123456Z",
            "immutable_tag_oid": "c" * 40,
            "immutable_tag_readback_oid": "c" * 40,
            "preserved_operational_ref": reference.REF,
            "preserved_operational_tag_oid": "d" * 40,
            "operational_ref_readback_oid": "d" * 40,
            "immutable_tag_readback_matches": True,
        }
        payload = {
            "status": "healthy",
            "sha": sha,
            "auth_domain_tag_publication": publication,
            "predecessor_exception": {
                "backend_acceptance_origin": {
                    "operational_reference": {
                        "ref": reference.REF,
                        "tag_oid": publication["preserved_operational_tag_oid"],
                    }
                }
            },
        }
        self.assertEqual(control.verify_auth_domain_tag_publication(payload, sha), publication)
        invalid = [
            {"status": "healthy", "sha": sha},
            {**payload, "auth_domain_tag_publication": {**publication, "status": "refused"}},
            {**payload, "auth_domain_tag_publication": {**publication, "status": "uncertain"}},
            {**payload, "auth_domain_tag_publication": {**publication, "immutable_tag_readback_matches": False}},
            {**payload, "auth_domain_tag_publication": {**publication, "operational_ref_readback_oid": "e" * 40}},
            {**payload, "auth_domain_tag_publication": {**publication, "immutable_tag_oid": "e" * 40}},
            {**payload, "auth_domain_tag_publication": {**publication, "immutable_tag_readback_oid": None}},
            {**payload, "auth_domain_tag_publication": {**publication, "immutable_ref": f"refs/tags/deployed/production/{'e' * 8}-20261102T123456Z"}},
        ]
        for broken in invalid:
            with self.subTest(publication=broken.get("auth_domain_tag_publication")), self.assertRaises(ValueError):
                control.verify_auth_domain_tag_publication(broken, sha)

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

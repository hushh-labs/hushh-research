"""Continuation receipts prove original provenance without replaying deployment."""

import copy
import subprocess
from contextlib import contextmanager
from unittest import mock

import production_backend_successor_control as control
import production_backend_successor_proof as proof
import production_activation_continuation as continuation
import production_phone_receipt as phone
from production_pending_activation_cases import _pending_case
from production_phone_receipt_fixtures import archive, healthy_tag


class _ContinuationCase:
    def __init__(self, original):
        self.original, self.fixture = original, original.fixture
        self.cold_download = self.fixture.maintenance.retention.run_command
        self.calls = []
        self.origin = self.load()
        self.run = {**copy.deepcopy(original.run), "id": 500, "run_attempt": 1}
        self.run["head_sha"] = "d" * 40
        self.documents = copy.deepcopy(original.documents)
        self.release = self.documents["prod-release-status.json"]
        self.release.update(status="healthy")
        self.release["verification"]["account_deletion_activated"] = "true"
        self.documents[continuation.ORIGIN] = self.origin
        self.activation = self.activated()
        self.documents[continuation.pending.ACTIVATION] = self.activation
        for name in ("phone-rollback/plan.json", "phone-rollback/qualified.json"):
            self.documents[name]["run_id"] = "500"
        self.jobs = copy.deepcopy(original.jobs)
        self.job = self.jobs["jobs"][0]
        self.job.update(run_id=500, run_attempt=1, head_sha=self.run["head_sha"])
        self.job["steps"] = [
            {**original.upload, "name": name}
            for name in continuation.required_steps("all")
        ]
        self.artifact = copy.deepcopy(original.artifact)
        self.artifact.update(id=600, name="prod-release-500")
        self.artifact["workflow_run"].update(id=500, head_sha=self.run["head_sha"])
        self.inventory = {"total_count": 1, "artifacts": [self.artifact]}
        self.on_refresh = lambda: None
        self.pack()

    def arguments(self):
        return {
            "api": self.api,
            "governed": self.fixture.maintenance.governed_dispatch,
            "timestamp": self.fixture.maintenance._github_timestamp,
            "run_command": self.download,
            "timeout": 30,
        }

    def load(self, *, sha=None, anchor=None):
        return continuation.load_original(
            "400",
            self.original.release["sha"] if sha is None else sha,
            repository=self.fixture.repo,
            operational_anchor=self.original.anchor if anchor is None else anchor,
            **self.arguments(),
        )

    def activated(self):
        activation = copy.deepcopy(self.original.activation)
        activation.update(
            status="activated",
            fence_removal="confirmed_absent",
            scheduler={
                "status": "healthy",
                "checks": {"fresh_attempt_finished": True, "http_2xx": True},
            },
            retirement={
                "status": "retired",
                "retired_count": 0,
                "phone_admission_floor_required": True,
                **dict.fromkeys(
                    (
                        "remaining_pre_v201_count",
                        "remaining_pre_provider_v2_count",
                        "remaining_pre_phone425_count",
                        continuation._floor_key(),
                    ),
                    0,
                ),
            },
        )
        return activation

    def api(self, repository, endpoint):
        self.calls.append(endpoint)
        if endpoint == "runs/500/artifacts?per_page=100":
            return copy.deepcopy(self.inventory)
        if endpoint in {
            "runs/500/attempts/1/jobs?per_page=100",
            "runs/500/jobs?filter=latest&per_page=100",
        }:
            return copy.deepcopy(self.jobs)
        if endpoint in {"runs/500", "runs/500?exclude_pull_requests=true"}:
            self.on_refresh()
            return copy.deepcopy(self.run)
        if endpoint.startswith("runs/400"):
            return self.original.api(repository, endpoint)
        return copy.deepcopy(self.fixture.api(repository, endpoint))

    def download(self, command, **kwargs):
        selected = command[-1].split("/")[-2]
        if selected == "100":
            return self.cold_download(command, **kwargs)
        self.fixture.assertIn(selected, {"500", "600"})
        payload = self.original.payload if selected == "500" else self.payload
        return subprocess.CompletedProcess(command, 0, payload, b"")

    def pack(self):
        self.payload = archive(self, self.documents)

    def failed_legacy_cleanup(self, owner):
        self.run["conclusion"] = self.job["conclusion"] = "failure"
        self.documents["prod-release-status.json"]["rollback"] = dict.fromkeys(
            ("backend", "frontend", "drive_jobs"), "skipped"
        )
        self.job["steps"] = [
            {**self.original.upload, "name": name}
            for name in owner.REQUIRED_PRODUCTION_STEPS
        ] + [
            {
                "name": owner.POST_RELEASE_CLEANUP_STEP,
                "status": "completed",
                "conclusion": "failure",
            }
        ]
        self.pack()

    def read(self):
        return continuation.archive_context(
            self.fixture.repo,
            self.run,
            self.release,
            self.fixture.maintenance.LANES["production"],
            **self.arguments(),
        )


@contextmanager
def _continuation_case(fixture):
    with _pending_case(fixture) as original:
        yield _ContinuationCase(original)


class ActivationFrontendContinuationCases:
    def test_continuation_frontend_requires_original_pending_revision_not_reader_history(
        self,
    ):
        for defect in ("missing", "malformed", "origin", "final", "candidate"):
            with self.subTest(defect=defect), _continuation_case(self) as case:
                report = case.original.documents[
                    "prod-document-reader-compatibility.json"
                ]
                report["previous"]["hushh-webapp"] = {
                    "revision": "hushh-webapp-old-reader"
                }
                case.original.pack()
                case.origin = case.load()
                self.assertEqual(
                    case.origin["frontend"]["revision"], "hushh-webapp-current"
                )
                case.documents[continuation.ORIGIN] = case.origin
                if defect == "missing":
                    case.origin.pop("frontend")
                elif defect == "malformed":
                    case.origin["frontend"] = None
                elif defect == "origin":
                    case.origin["frontend"]["revision"] = "hushh-webapp-old-reader"
                elif defect == "final":
                    case.release["final"]["frontend_revision"] = (
                        "hushh-webapp-unrelated"
                    )
                else:
                    case.release["candidate"]["frontend_revision"] = (
                        "hushh-webapp-unrelated"
                    )
                case.pack()
                with self.assertRaises(phone.retention.UnsafeState):
                    case.read()

    def test_current_disabled_continuation_preserves_basis_until_standard_backend(self):
        with _continuation_case(self) as case:
            sha = case.release["sha"]
            current = healthy_tag(case)
            owner = control.authority()
            with (
                mock.patch.object(owner, "api", case.api),
                mock.patch.object(owner.retention, "run_command", case.download),
                mock.patch.object(proof, "read_original", return_value=current),
            ):

                def guarded():
                    for source, scope in ((sha, "frontend"), ("0" * 40, "backend")):
                        with self.assertRaisesRegex(
                            ValueError, "requires_original_source"
                        ):
                            control.admit(source, scope)

                guarded()
                self.assertIsNone(control.admit(sha, "backend"))
                self.assertIsNone(control.admit(sha, "all"))
                with mock.patch.object(
                    control, "_continuation_source", return_value=None
                ):
                    with self.assertRaises(AssertionError):
                        guarded()  # Prior marker-only admission loses the activation basis.
                for defect in ("origin", "flag", "expired", "tag", "failed"):
                    with self.subTest(defect=defect):
                        saved = copy.deepcopy(case.documents)
                        if defect == "origin":
                            case.documents[continuation.ORIGIN] = {}
                        elif defect == "flag":
                            case.documents["phone-rollback/plan.json"][
                                "recovery_enabled"
                            ] = "false"
                        elif defect == "expired":
                            case.artifact["expired"] = True
                        elif defect == "failed":
                            case.run["conclusion"] = "failure"
                        case.pack()
                        with mock.patch.object(
                            proof,
                            "read_original",
                            side_effect=[current, {**current, "tag_oid": "0" * 40}]
                            if defect == "tag"
                            else None,
                            return_value=current,
                        ):
                            with self.assertRaises(
                                (ValueError, phone.retention.UnsafeState)
                            ):
                                control.admit(sha, "backend")
                        case.documents, case.artifact["expired"] = saved, False
                        case.run["conclusion"] = "success"
                        case.pack()
                case.documents.pop(continuation.ORIGIN)
                case.pack()
                self.assertIsNone(control.admit("0" * 40, "frontend"))
                case.failed_legacy_cleanup(owner)
                self.assertIsNone(control.admit("0" * 40, "frontend"))
                next(
                    step
                    for step in case.job["steps"]
                    if step["name"] == "Post-deploy backend runtime health gate"
                )["conclusion"] = "failure"
                with self.assertRaises(phone.retention.UnsafeState):
                    control.admit("0" * 40, "frontend")
                with mock.patch.object(owner, "verify_post_release_failure"):
                    with self.assertRaises(AssertionError):
                        with self.assertRaises(phone.retention.UnsafeState):
                            control.admit("0" * 40, "frontend")


class ActivationContinuationCases(ActivationFrontendContinuationCases):
    def test_continuation_loads_original_pending_archive_and_keeps_backend_owner(self):
        with _continuation_case(self) as case:
            before = copy.deepcopy(case.original.documents)
            self.assertEqual(case.origin["original"]["run_id"], 400)
            self.assertEqual(
                case.origin["original"]["artifact_digest"],
                case.original.artifact["digest"],
            )
            context = case.read()
            self.assertEqual(context["status"], "activated")
            self.assertEqual(context["backend"]["run_id"], 400)
            self.assertEqual(context["backend"]["uid"], "primary-uid")
            self.assertEqual(
                context["frontend"],
                {
                    "revision": case.original.release["final"]["frontend_revision"],
                    "sha": case.original.release["sha"],
                    "run_id": 400,
                },
            )
            self.assertEqual(context["cold_rollback"]["release_run_id"], 500)
            self.assertEqual(context["cold_rollback"]["runtime_run_id"], "300")
            self.assertEqual(
                context["cold_rollback"]["uid"], case.original.anchor["uid"]
            )
            self.assertEqual(case.original.documents, before)
            self.assertEqual(
                case.origin["protected_documents"]["mode"],
                before["prod-protected-document-release.json"],
            )

    def test_continuation_origin_cannot_come_from_summary_or_another_pending_attempt(
        self,
    ):
        for defect in (
            "source",
            "summary",
            "activation",
            "attempt",
            "digest",
            "anchor",
        ):
            with self.subTest(defect=defect), _continuation_case(self) as case:
                arguments = {}
                if defect == "source":
                    arguments["sha"] = "0" * 40
                elif defect == "anchor":
                    arguments["anchor"] = {}
                else:
                    if defect == "summary":
                        case.original.release["status"] = "healthy"
                        case.original.pack()
                    elif defect == "activation":
                        case.original.documents.pop(continuation.pending.ACTIVATION)
                        case.original.pack()
                    elif defect == "attempt":
                        case.original.jobs["jobs"][0]["run_attempt"] = 2
                    else:
                        case.original.artifact["digest"] = "sha256:" + "0" * 64
                with self.assertRaises(phone.retention.UnsafeState):
                    case.load(**arguments)

    def test_continuation_actual_activation_requires_original_identity_and_retired_floor(
        self,
    ):
        for defect in (
            "pending",
            "run",
            "source",
            "candidate",
            "uid",
            "service",
            "floor",
            "fence",
            "scheduler",
        ):
            with self.subTest(defect=defect), _continuation_case(self) as case:
                value = case.activation
                if defect == "pending":
                    value["status"] = "pending_activation"
                elif defect == "run":
                    value["run_id"] = "500"
                elif defect == "source":
                    value["sha"] = "0" * 40
                elif defect == "candidate":
                    value["candidate_revision"] = "consent-protocol-replaced"
                elif defect == "uid":
                    value["candidate_uid"] = "recreated-primary"
                elif defect == "service":
                    value["service_uid"] = "recreated-service"
                elif defect == "floor":
                    value["retirement"][continuation._floor_key()] = 1
                elif defect == "fence":
                    value["fence_removal"] = "requested_outcome_unconfirmed"
                else:
                    value["scheduler"]["checks"]["fresh_attempt_finished"] = False
                case.pack()
                with self.assertRaises(phone.retention.UnsafeState):
                    case.read()

    def test_continuation_archive_cannot_replace_original_evidence_or_cold_binding(
        self,
    ):
        for defect in (
            "origin",
            "original-digest",
            "old-documents",
            "cold-proof",
            "fresh-phone",
            "fresh-origin",
            "document-mode",
            "fresh-documents",
        ):
            with self.subTest(defect=defect), _continuation_case(self) as case:
                if defect == "origin":
                    case.origin["candidate"]["uid"] = "nominated-primary"
                elif defect == "original-digest":
                    case.origin["original"]["artifact_digest"] = "sha256:" + "0" * 64
                elif defect == "old-documents":
                    case.origin["protected_documents"]["mode"]["enabled"] = True
                elif defect == "cold-proof":
                    case.origin["cold_rollback"]["origin"]["artifact_id"] += 1
                elif defect == "fresh-phone":
                    case.documents["phone-rollback/qualified.json"]["uid"] = (
                        "recreated-cold"
                    )
                elif defect == "fresh-origin":
                    binding = case.documents["phone-rollback/plan.json"][
                        "operational_reference"
                    ]
                    binding["origin"]["artifact_id"] += 1
                elif defect == "document-mode":
                    case.documents["prod-protected-document-release.json"] = {
                        "configured": False,
                        "enabled": False,
                    }
                else:
                    case.documents["prod-document-reader-compatibility.json"][
                        "targetSha"
                    ] = "0" * 40
                case.pack()
                with self.assertRaises(phone.retention.UnsafeState):
                    case.read()

    def test_continuation_requires_real_fresh_gates_without_deploying_again(self):
        for defect in (
            "uat",
            "gate",
            "frontend",
            "deploy",
            "ddl",
            "worker",
            "attempt",
            "tag",
            "body",
            "refresh",
        ):
            with self.subTest(defect=defect), _continuation_case(self) as case:
                if defect in {"deploy", "ddl", "worker"}:
                    name = {
                        "deploy": "Deploy backend using Cloud Build",
                        "ddl": "Apply production DB migrations behind account deletion fence",
                        "worker": "Deploy and attest private production Drive worker",
                    }[defect]
                    case.job["steps"].append({**case.original.upload, "name": name})
                elif defect in {"uat", "gate", "frontend", "tag"}:
                    name = {
                        "uat": "Require exact-SHA UAT acceptance",
                        "gate": "Require qualified activation continuation",
                        "frontend": "Post-deploy frontend runtime health gate",
                        "tag": continuation.pending.HEALTHY_TAG,
                    }[defect]
                    next(step for step in case.job["steps"] if step["name"] == name)[
                        "conclusion"
                    ] = "skipped"
                elif defect == "attempt":
                    case.job["run_attempt"] = 2
                elif defect == "body":
                    case.documents["prod-release-status.json"] = {
                        **case.release,
                        "status": "pending_activation",
                    }
                    case.pack()
                else:
                    case.on_refresh = lambda: case.run.update(run_attempt=2)
                with self.assertRaises(phone.retention.UnsafeState):
                    case.read()

    def test_continuation_absence_is_optional_but_present_invalid_never_falls_back(
        self,
    ):
        with _continuation_case(self) as case:
            case.documents.pop(continuation.ORIGIN)
            case.pack()
            self.assertIsNone(case.read())
            case.documents[continuation.ORIGIN] = None
            case.pack()
            with self.assertRaises(phone.retention.UnsafeState):
                case.read()
            case.documents.pop(continuation.ORIGIN)
            case.pack()
            case.artifact["digest"] = "sha256:" + "0" * 64
            with self.assertRaises(phone.retention.UnsafeState):
                case.read()

    def test_continuation_skipped_mutations_and_backend_only_real_gates_are_allowed(
        self,
    ):
        with _continuation_case(self) as case:
            case.original.release["scope"] = "backend"
            case.original.pack()
            case.origin = case.load()
            case.documents[continuation.ORIGIN] = case.origin
            case.release["scope"] = "backend"
            for step in case.job["steps"]:
                if step["name"] in continuation.pending.FRONTEND_STEPS:
                    step["conclusion"] = "skipped"
            case.job["steps"] += [
                {"name": name, "status": "completed", "conclusion": "skipped"}
                for name in continuation.MUTATION_STEPS
            ]
            case.pack()
            context = case.read()
            self.assertEqual(context["backend"]["run_id"], 400)
            self.assertNotIn("frontend", case.origin)
            self.assertNotIn("frontend", context)
            case.origin["frontend"] = {
                "revision": "hushh-webapp-nominated",
                "sha": "0" * 40,
                "run_id": 500,
            }
            case.pack()
            with self.assertRaises(phone.retention.UnsafeState):
                case.read()

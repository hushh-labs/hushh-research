"""Pending receipts retain their own authority, distinct from healthy releases."""

import copy
import subprocess
from contextlib import contextmanager
from runpy import run_path

import production_backend_successor_control as control
import production_backend_successor_proof as proof
import production_pending_activation as pending
import production_phone_receipt as phone
from production_backend_successor_control_cases import _control_case
from production_phone_receipt_fixtures import archive, phone_documents


class _PendingCase:
    def __init__(self, fixture, tag, anchor):
        self.fixture, self.anchor, self.calls = fixture, anchor, []
        self.run, self.jobs, self.upload, self.artifact = (
            copy.deepcopy(getattr(fixture, name))
            for name in ("run", "jobs", "upload", "artifact")
        )
        self.run.update(id=400, run_attempt=3, head_sha="e" * 40)
        self.documents = phone_documents(self)
        self.release = self.documents["prod-release-status.json"]
        self.release.update(
            status="pending_activation", candidate=copy.deepcopy(self.release["final"])
        )
        self.release["verification"] = dict.fromkeys(
            (
                "runtime_parity",
                "connected_systems",
                "backend_provenance",
                "backend_health",
                "account_deletion_activation",
                "frontend_provenance",
                "frontend_health",
                "passkey_domain_associations",
            ),
            "success",
        ) | {"account_deletion_activated": "false"}
        self.release["classification"] = dict.fromkeys(
            (
                "release_failed",
                "promote_failed",
                "backend_provenance_failed",
                "frontend_provenance_failed",
            ),
            "false",
        )
        self.bind_phone(tag)
        self.activation = self.activation_evidence()
        self.documents[pending.ACTIVATION] = self.activation
        job = self.jobs["jobs"][0]
        job.update(run_id=400, run_attempt=3, head_sha=self.run["head_sha"])
        job["steps"] = [
            {**self.upload, "name": name} for name in pending.required_steps("all")
        ]
        job["steps"].append(
            {
                "name": pending.HEALTHY_TAG,
                "status": "completed",
                "conclusion": "skipped",
            }
        )
        self.artifact.update(id=500, name="prod-release-400", expired=False)
        self.artifact["workflow_run"].update(id=400, head_sha=self.run["head_sha"])
        self.inventory = {"total_count": 1, "artifacts": [self.artifact]}
        self.on_refresh = lambda: None
        self.pack()

    def bind_phone(self, tag):
        binding = {
            "tag": tag,
            "origin": self.anchor["origin"],
            "uid": self.anchor["uid"],
            "runtime": self.anchor["runtime"],
        }
        plan = self.documents["phone-rollback/plan.json"]
        plan.update(
            mode="operational",
            run_id="400",
            revision=self.anchor["revision"],
            operational_reference=binding,
        )
        self.documents["phone-rollback/qualified.json"].update(
            mode="operational",
            run_id="400",
            uid=self.anchor["uid"],
            operational_reference=binding,
        )

    def activation_evidence(self):
        primary, legacy = (
            self.release["final"]["backend_revision"],
            "consent-protocol-retained-old",
        )
        source = self.release["sha"]
        rows = [
            {
                "metadata": {
                    "name": name,
                    "uid": uid,
                    "labels": {"deploy-sha": sha, "account-deletion-contract": "v201"},
                }
            }
            for name, uid, sha in (
                (primary, "primary-uid", source),
                (legacy, "old-uid", "0" * 40),
                (self.anchor["revision"], self.anchor["uid"], self.anchor["source"]),
            )
        ]
        service = {
            "metadata": {"uid": self.anchor["runtime"]["service_uid"]},
            "status": {
                "traffic": [
                    {"revisionName": primary, "percent": 100},
                    {"revisionName": legacy, "percent": 0, "tag": "old-reader"},
                ]
            },
        }
        producer = run_path(
            str(proof.ROOT / "deploy/account-deletion/activation_retirement.py")
        )["production_boundary"]
        boundary = producer(
            service,
            rows,
            primary,
            supports=lambda sha, **_kw: sha in {source, self.anchor["source"]},
            fence_required=True,
        )
        return {
            "schema_version": 1,
            "kind": "account-lifecycle-activation",
            "project": "hushh-pda",
            "region": "us-central1",
            "service": "consent-protocol",
            "sha": source,
            "run_id": "400",
            "required_provider_contract": 2,
            "database_preflight": "qualified",
            **boundary,
        }

    def pack(self):
        self.payload = archive(self, self.documents)

    def api(self, _repository, endpoint):
        self.calls.append(endpoint)
        if endpoint == "runs/400/artifacts?per_page=100":
            return copy.deepcopy(self.inventory)
        if endpoint == "runs/400/attempts/3/jobs?per_page=100":
            return copy.deepcopy(self.jobs)
        if endpoint == "runs/400?exclude_pull_requests=true":
            self.on_refresh()
            return copy.deepcopy(self.run)
        raise AssertionError("pending reader reached another authority: " + endpoint)

    def read(self, *, anchor=None, release=None):
        return pending.pending_context(
            self.fixture.repo,
            self.run,
            self.release if release is None else release,
            self.fixture.maintenance.LANES["production"],
            operational_anchor=self.anchor if anchor is None else anchor,
            api=self.api,
            governed=self.fixture.maintenance.governed_dispatch,
            timestamp=self.fixture.maintenance._github_timestamp,
            run_command=lambda *args, **kwargs: subprocess.CompletedProcess(
                [], 0, self.payload, b""
            ),
            timeout=30,
        )


@contextmanager
def _pending_case(fixture):
    with _control_case(fixture):
        control.apply()
        tag = proof.read_original()
        anchor = control.record_anchor(tag)
        yield _PendingCase(fixture, tag, anchor)


class PendingActivationCases:
    def test_pending_receipt_is_a_distinct_bound_context_without_healthy_fabrication(
        self,
    ):
        with _pending_case(self) as case:
            before = copy.deepcopy(case.release)
            context = case.read()
            self.assertEqual(context["kind"], "production-pending-retirement")
            self.assertFalse(context["healthy_release"])
            self.assertEqual(context["candidate"]["uid"], "primary-uid")
            self.assertEqual(context["candidate"]["run_id"], "400")
            self.assertEqual(context["cold_rollback"]["runtime_run_id"], "300")
            self.assertEqual(context["cold_rollback"]["origin"], case.anchor["origin"])
            self.assertEqual(context["artifact_digest"], case.artifact["digest"])
            self.assertEqual(context["pending_revisions"][0]["traffic_percent"], 0)
            self.assertEqual(case.release, before)
            self.assertTrue(
                all(endpoint.startswith("runs/400") for endpoint in case.calls)
            )
            context["pending_revisions"][0]["uid"] = "local-consumer-change"
            self.assertEqual(
                case.activation["retirement"]["pending_revisions"][0]["uid"], "old-uid"
            )

    def test_pending_summary_cannot_replace_actual_same_archive_activation_evidence(
        self,
    ):
        for defect in (
            "missing",
            "activated",
            "run",
            "source",
            "candidate",
            "service",
            "fence",
            "provider-activation",
        ):
            with self.subTest(defect=defect), _pending_case(self) as case:
                if defect == "missing":
                    case.documents.pop(pending.ACTIVATION)
                elif defect == "activated":
                    case.activation["status"] = "activated"
                elif defect == "run":
                    case.activation["run_id"] = "300"
                elif defect == "source":
                    case.activation["sha"] = "0" * 40
                elif defect == "candidate":
                    case.activation["candidate_revision"] = case.anchor["revision"]
                elif defect == "service":
                    case.activation["service_uid"] = "recreated-service"
                elif defect == "fence":
                    case.activation["fence_required"] = False
                else:
                    case.activation["scheduler"] = {"configured": True}
                case.pack()
                with self.assertRaises(phone.retention.UnsafeState):
                    case.read()

    def test_pending_retained_inventory_is_exact_uid_bound_and_zero_traffic(self):
        for defect in ("count", "traffic", "duplicate", "cold", "uid", "tags"):
            with self.subTest(defect=defect), _pending_case(self) as case:
                retirement = case.activation["retirement"]
                row = retirement["pending_revisions"][0]
                if defect == "count":
                    retirement["pending_count"] += 1
                elif defect == "traffic":
                    row["traffic_percent"] = 1
                elif defect == "duplicate":
                    retirement["pending_revisions"].append(copy.deepcopy(row))
                    retirement["pending_count"] += 1
                elif defect == "cold":
                    row["revision"] = case.anchor["revision"]
                elif defect == "uid":
                    row["uid"] = case.activation["candidate_uid"]
                else:
                    row["tags"] = ["unsafe/tag"]
                case.pack()
                with self.assertRaises(phone.retention.UnsafeState):
                    case.read()

    def test_pending_receipt_cannot_select_its_own_operational_anchor(self):
        for defect in ("missing", "primary", "artifact", "uid", "controls"):
            with self.subTest(defect=defect), _pending_case(self) as case:
                anchor = copy.deepcopy(case.anchor)
                if defect == "missing":
                    anchor = {}
                elif defect == "primary":
                    anchor["sealed_boundary"]["checkpoint"]["plan"]["primary_sha"] = (
                        "0" * 40
                    )
                elif defect == "artifact":
                    anchor["origin"]["artifact_id"] += 1
                elif defect == "uid":
                    anchor["uid"] = "different-cold-resource"
                else:
                    anchor["runtime"]["controls"] = "0" * 64
                with self.assertRaises(phone.retention.UnsafeState):
                    case.read(anchor=anchor)

    def test_pending_attempt_upload_gates_and_status_body_cannot_mix(self):
        for defect in (
            "actor",
            "expired",
            "digest",
            "job-attempt",
            "gate",
            "healthy-tag",
            "body",
            "refresh",
        ):
            with self.subTest(defect=defect), _pending_case(self) as case:
                if defect == "actor":
                    case.run["actor"]["login"] = "unapproved"
                elif defect == "expired":
                    case.artifact["expired"] = True
                elif defect == "digest":
                    case.artifact["digest"] = "sha256:" + "0" * 64
                elif defect == "job-attempt":
                    case.jobs["jobs"][0]["run_attempt"] = 2
                elif defect == "gate":
                    case.jobs["jobs"][0]["steps"][0]["conclusion"] = "skipped"
                elif defect == "healthy-tag":
                    case.jobs["jobs"][0]["steps"][-1]["conclusion"] = "success"
                elif defect == "body":
                    case.documents["prod-release-status.json"] = {
                        **case.release,
                        "status": "healthy",
                    }
                    case.pack()
                else:
                    case.on_refresh = lambda: case.run.update(run_attempt=4)
                with self.assertRaises(phone.retention.UnsafeState):
                    case.read()

    def test_pending_phone_and_document_evidence_reuse_the_existing_owners(self):
        for defect in ("tag", "recovery", "documents"):
            with self.subTest(defect=defect), _pending_case(self) as case:
                plan = case.documents["phone-rollback/plan.json"]
                if defect == "tag":
                    plan["operational_reference"]["tag"]["tag_oid"] = "0" * 40
                elif defect == "recovery":
                    plan["recovery_enabled"] = True
                else:
                    case.documents["prod-document-reader-compatibility.json"][
                        "targetSha"
                    ] = "0" * 40
                case.pack()
                with self.assertRaises(phone.retention.UnsafeState):
                    case.read()

    def test_pending_backend_scope_uses_its_real_gates_and_malformed_body_refuses(self):
        with _pending_case(self) as case:
            case.release["scope"] = "backend"
            for step in case.jobs["jobs"][0]["steps"]:
                if step["name"] in pending.FRONTEND_STEPS:
                    step["conclusion"] = "skipped"
            case.pack()
            self.assertEqual(case.read()["status"], "pending_activation")
            malformed = {**case.release, "final": None}
            with self.assertRaises(phone.retention.UnsafeState):
                case.read(release=malformed)

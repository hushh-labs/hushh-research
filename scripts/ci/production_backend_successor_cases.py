"""Historical LKG preservation and uncertain compare-and-swap controls."""

import copy
import hashlib
import json
import subprocess
from unittest import mock

import production_backend_successor as successor
import production_backend_successor_control as control
from production_backend_successor_control_cases import OperationalBackendControlCases, _control_case
import production_backend_successor_proof as proof
import production_phone_receipt as phone
from production_phone_receipt_fixtures import archive, phone_documents

COMMIT, OLD, NEW, OTHER = (letter * 40 for letter in "abcd")
MESSAGE = (
    "Last known good — production\n"
    f"sha: {COMMIT}\n"
    "backend_revision: consent-protocol-00302-fix\n"
    "backend_url: https://api.example.test\n"
    "frontend_revision: hushh-webapp-00158-tdv\n"
    "frontend_url: https://app.example.test\n"
    "run: https://github.com/hushh-labs/hushh-research/actions/runs/100\n"
    "actor: governed-maintainer\n"
    "tagged_at: 20261026T075637Z\n"
)
ANCHOR = {
    "origin": {
        "run_id": "200",
        "run_attempt": 1,
        "workflow_sha": "e" * 40,
        "artifact_id": 300,
        "artifact_digest": "sha256:" + "f" * 64,
    },
    "revision": "consent-protocol-00310-cold",
    "source": "f" * 40,
    "image": "gcr.io/hushh-pda/consent-protocol@sha256:" + "e" * 64,
    "uid": "owned-cold-revision-uid",
}


def original_healthy_tag():
    raw = (
        f"object {COMMIT}\ntype commit\ntag {successor.REF.removeprefix('refs/tags/')}\n"
        f"tagger Release owner <release@example.test> 1793000000 +0000\n\n{MESSAGE}"
    )
    return successor.tag_identity(raw)


def empty_installed_database():
    return dict.fromkeys(
        ("installed", "relations_empty", "phone_unlink_empty", "owned_proxy_exited"),
        True,
    )


def operational_bundle(fixture):
    documents = phone_documents(fixture)
    owner = proof.bootstrap_owner()
    checkpoint = {
        "schema_version": 1,
        "kind": "phone-cold-qualification",
        "status": "qualified",
        "controls": "a" * 64,
        "iam": "b" * 64,
        "health_tag": "retired",
        "pending": list(owner.PENDING),
        "readiness": dict(owner.READINESS),
        "project": "hushh-pda",
        "region": "us-central1",
        "origin": {
            "run_id": "300",
            "run_attempt": 2,
            "workflow_sha": fixture.run["head_sha"],
        },
        "plan": documents["phone-rollback/plan.json"],
        "qualification": documents["phone-rollback/qualified.json"],
        "service_uid": "owned-service",
        "cold_uid": "owned-revision",
        "serving": [["consent-protocol-00302-fix", 100]],
    }
    qualified = checkpoint["qualification"]
    schema = {
        "schema_version": 1,
        "kind": "phone-installed-schema-proof",
        "qualification": "passed",
        "project": "hushh-pda",
        "region": "us-central1",
        "origin": {**checkpoint["origin"], "workflow": proof.WORKFLOW},
        "runtime_checkpoint": proof.digest(checkpoint),
        "dimensions": {"installed_schema": "passed", "producer_closure": "passed"},
        "advance_anchor": False,
        "healthy_release": False,
        "workos": {"qualification": "passed"},
        "producer_submissions": {"qualification": "passed"},
        "database": empty_installed_database(),
        "snapshot": {
            "services": {
                "consent-protocol": {
                    "uid": checkpoint["service_uid"],
                    "controls": checkpoint["controls"],
                    "iam": checkpoint["iam"],
                    "traffic": "c" * 64,
                }
            },
            "revisions": {
                qualified["revision"]: {
                    "uid": checkpoint["cold_uid"],
                    **{key: qualified[key] for key in ("source", "image")},
                }
            },
        },
        "reference": {
            "source": COMMIT,
            "revision": "consent-protocol-00302-fix",
            "run_id": "100",
            "digest": "a" * 64,
        },
    }
    return {
        "schema_version": 1,
        "kind": "phone-operational-backend-proof",
        "primary_image": "gcr.io/hushh-pda/consent-protocol@sha256:" + "d" * 64,
        "checkpoint": checkpoint,
        "installed_schema": schema,
        "document_mode": documents["prod-protected-document-release.json"],
        "document_report": documents["prod-document-reader-compatibility.json"],
        "original_healthy": original_healthy_tag(),
    }


class OperationalBackendReferenceCases(OperationalBackendControlCases):
    def test_producer_empty_urls_preserve_tag_bytes_and_consumer_binding(self):
        original = original_healthy_tag()
        urls = {"backend_url": "https://api.example.test", "frontend_url": "https://app.example.test"}
        for empty in (("frontend_url",), ("backend_url",), tuple(urls)):
            raw = original["tag_object"]
            for field in empty:
                raw = raw.replace(f"{field}: {urls[field]}\n", f"{field}:\n")
            with self.subTest(empty=empty):
                tag = successor.tag_identity(raw)
                self.assertEqual(tag["tag_object"], raw)
                healthy, record = successor.split(tag["message"], COMMIT)
                self.assertEqual(healthy, tag["message"])
                self.assertIsNone(record)
                fields = successor.healthy_fields(healthy, COMMIT)
                self.assertTrue(all(fields[field] == "" for field in empty))
                with mock.patch.object(proof, "read_original", return_value=tag):
                    self.assertEqual(control.resolve(), "consent-protocol-00302-fix")
                schema = {"reference": {"source": COMMIT, "revision": fields["backend_revision"],
                                        "run_id": "100", "digest": "a" * 64}}
                self.assertEqual(proof._healthy_reference({"original_healthy": tag}, schema)[0], tag)
                annotated = successor.annotate(healthy, COMMIT, OLD, ANCHOR)
                self.assertEqual(successor.split(annotated, COMMIT)[0], healthy)
                with mock.patch(__name__ + ".MESSAGE", healthy), _control_case(self) as case:
                    self.assertEqual(proof.read_original(), case.original)
                    self.assertEqual(case.original["message"], healthy)
                    prepared = successor.tag_identity(case.intent["new_object"])["message"]
                    self.assertEqual(successor.split(prepared, COMMIT)[0], healthy)

    def test_present_invalid_phone_summary_never_falls_back_to_legacy(self):
        documents = phone_documents(self)
        for malformed in (None, {}, {"revision": ""}, "not-a-summary"):
            documents["prod-release-status.json"]["phone_rollback"] = malformed
            with (
                self.subTest(summary=malformed),
                self.assertRaisesRegex(
                    phone.retention.UnsafeState, "present but invalid"
                ),
            ):
                self.phone_anchor(documents)

    def test_operational_backend_keeps_every_historical_healthy_byte(self):
        result = successor.annotate(MESSAGE, COMMIT, OLD, ANCHOR)
        healthy, record = successor.split(result, COMMIT)
        self.assertEqual(healthy, MESSAGE)
        self.assertEqual(
            record["healthy_message_sha256"],
            hashlib.sha256(MESSAGE.encode()).hexdigest(),
        )
        self.assertEqual(record["origin"], ANCHOR["origin"])
        self.assertNotEqual(record["source"], COMMIT)

    def test_git_trimmed_empty_informational_urls_preserve_exact_tag_and_custody(self):
        original = original_healthy_tag()
        message = MESSAGE.replace("frontend_url: https://app.example.test", "frontend_url:")
        message = message.replace("backend_url: https://api.example.test", "backend_url:")
        raw = original["tag_object"].replace(MESSAGE, message)
        tag = successor.tag_identity(raw)
        self.assertEqual(tag["tag_object"], raw)
        encoded = raw.encode()
        expected = hashlib.sha1(b"tag " + str(len(encoded)).encode() + b"\0" + encoded,
                                usedforsecurity=False).hexdigest()
        self.assertEqual(tag["tag_oid"], expected)
        healthy, record = successor.split(successor.annotate(message, COMMIT, expected, ANCHOR), COMMIT)
        self.assertEqual(healthy, message)
        self.assertEqual(record["healthy_message_sha256"], hashlib.sha256(message.encode()).hexdigest())
        self.assertEqual(successor.healthy_fields(healthy, COMMIT)["frontend_url"], "")
        for broken in (message + "frontend_url:\n", message.replace("actor: governed-maintainer", "actor:"),
                       message.replace("frontend_url:\n", "")):
            with self.subTest(broken=hashlib.sha256(broken.encode()).hexdigest()), self.assertRaises(ValueError):
                successor.split(broken, COMMIT)

    def test_operational_backend_rejects_tampering_and_ambiguous_annotations(self):
        value = successor.annotate(MESSAGE, COMMIT, OLD, ANCHOR)
        for broken in (
            MESSAGE.replace("frontend_url: https://app.example.test", "frontend_url:\t"),
            MESSAGE.replace("actor: governed-maintainer", "actor:"),
            MESSAGE + "frontend_url:\n",
            MESSAGE + "unknown:\n",
            MESSAGE.replace("frontend_url: https://app.example.test", "frontend_url:invalid"),
            MESSAGE.replace(COMMIT, OTHER),
            MESSAGE + successor.FIELD + "null\n",
            value.replace("00302-fix", "00302-changed"),
            value + value.splitlines(keepends=True)[-1],
            value.replace('"run_attempt":1', '"run_attempt":true'),
            value.replace('"artifact_id":300', '"artifact_id":300,"artifact_id":301'),
            value + "backend_revision: consent-protocol-evil\n",
        ):
            with (
                self.subTest(broken=hashlib.sha256(broken.encode()).hexdigest()),
                self.assertRaises(ValueError),
            ):
                successor.split(broken, COMMIT)
        wrong = copy.deepcopy(ANCHOR)
        wrong["origin"]["artifact_digest"] = "not-a-digest"
        with self.assertRaises(ValueError):
            successor.annotate(MESSAGE, COMMIT, OLD, wrong)

    def test_operational_backend_refresh_preserves_original_health(self):
        initial = successor.annotate(MESSAGE, COMMIT, OLD, ANCHOR)
        refreshed = successor.annotate(initial, COMMIT, NEW, ANCHOR)
        healthy, record = successor.split(refreshed, COMMIT)
        self.assertEqual(healthy, MESSAGE)
        self.assertEqual(record["previous_tag_oid"], NEW)
        self.assertEqual(refreshed.count(successor.FIELD), 1)

    def test_operational_backend_cas_never_overwrites_a_changed_ref(self):
        calls = []

        def run(argv):
            calls.append(argv)
            self.assertEqual(argv[0], "ls-remote")
            return f"{OTHER}\t{successor.REF}\n"

        with self.assertRaisesRegex(ValueError, "reference_changed"):
            successor.compare_and_swap(OLD, NEW, run=run)
        self.assertEqual(len(calls), 1)

    def test_operational_backend_uncertain_push_reads_back_without_retry(self):
        for observed, expected in (
            (NEW, "confirmed_after_uncertain_push"),
            (OLD, None),
            (OTHER, None),
        ):
            calls = []

            def run(argv):
                calls.append(argv)
                if argv[0] == "push":
                    self.assertIn(f"--force-with-lease={successor.REF}:{OLD}", argv)
                    raise subprocess.TimeoutExpired("git push", 60)
                oid = OLD if len(calls) == 1 else observed
                return f"{oid}\t{successor.REF}\n"

            with self.subTest(observed=observed):
                if expected is None:
                    with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
                        successor.compare_and_swap(OLD, NEW, run=run)
                else:
                    self.assertEqual(
                        successor.compare_and_swap(OLD, NEW, run=run), expected
                    )
                self.assertEqual(sum(argv[0] == "push" for argv in calls), 1)

    def test_operational_backend_field_is_structural_not_qualification_authority(self):
        _, record = successor.split(
            successor.annotate(MESSAGE, COMMIT, OLD, ANCHOR), COMMIT
        )
        self.assertNotIn("healthy_release", record)
        self.assertNotIn("retirement", record)
        self.assertEqual(json.loads(json.dumps(record)), record)

    def test_operational_proof_joins_schema_reader_and_documents_without_health(self):
        bundle = operational_bundle(self)
        anchor = proof.qualify(bundle)
        self.assertEqual(anchor["uid"], bundle["checkpoint"]["cold_uid"])
        self.assertEqual(anchor["original_healthy"]["message"], MESSAGE)
        self.assertNotIn("healthy_release", anchor)
        self.assertFalse(bundle["installed_schema"]["advance_anchor"])

    def test_operational_proof_refuses_partial_mixed_or_incompatible_evidence(self):
        for defect in (
            "schema",
            "binding",
            "uid",
            "documents",
            "lease",
            "origin",
            "healthy",
            "service_uid",
            "service_controls",
            "service_iam",
            "serving",
            "uid_type",
            "document_mode",
        ):
            bundle = operational_bundle(self)
            schema = bundle["installed_schema"]
            if defect == "schema":
                schema["database"]["installed"] = None
            if defect == "binding":
                schema["runtime_checkpoint"] = "0" * 64
            if defect == "uid":
                next(iter(schema["snapshot"]["revisions"].values()))["uid"] = "replaced"
            if defect == "documents":
                bundle["document_report"]["targetSha"] = "a" * 40
            if defect == "lease":
                bundle["checkpoint"]["health_tag"] = "leased"
            if defect == "origin":
                schema["origin"]["run_attempt"] = 1
            if defect == "healthy":
                bundle["original_healthy"]["commit"] = "f" * 40
            if defect.startswith("service_"):
                schema["snapshot"]["services"]["consent-protocol"][
                    defect.removeprefix("service_")
                ] = "changed"
            if defect == "serving":
                bundle["checkpoint"]["serving"] = [["consent-protocol-unrelated", 100]]
            if defect == "uid_type":
                bundle["checkpoint"]["cold_uid"] = True
            if defect == "document_mode":
                bundle["document_mode"] = {"configured": False, "enabled": True}
            with (
                self.subTest(defect=defect),
                self.assertRaises((ValueError, phone.retention.UnsafeState)),
            ):
                proof.qualify(bundle)

    def test_operational_proof_requires_exact_immutable_upload_and_complete_gates(self):
        bundle = operational_bundle(self)
        self.artifact["name"] = "prod-phone-operational-300-2"
        payload = archive(self, {"operational-backend.json": bundle})
        self.jobs["jobs"][0]["steps"] = [
            {**self.upload, "name": name} for name in proof.STEPS
        ]

        def load():
            return proof.load(
                "300",
                2,
                api=self.api,
                governed=self.maintenance.governed_dispatch,
                timestamp=self.maintenance._github_timestamp,
                run_command=lambda *args, **kwargs: subprocess.CompletedProcess(
                    [], 0, payload, b""
                ),
                timeout=30,
            )

        self.assertEqual(load()["origin"]["artifact_digest"], self.artifact["digest"])
        self.artifact["digest"] = "sha256:" + "0" * 64
        with self.assertRaises(phone.retention.UnsafeState):
            load()
        archive(self, {"operational-backend.json": bundle})
        self.jobs["jobs"][0]["steps"][2]["conclusion"] = "skipped"
        with self.assertRaisesRegex(ValueError, "gates_incomplete"):
            load()

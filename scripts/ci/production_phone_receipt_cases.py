"""Phone rollback receipt and retained-runtime security regression cases."""

import copy
import importlib
import json
import pathlib
import tempfile
import subprocess
from unittest import mock

import production_phone_receipt as phone
from production_phone_receipt_fixtures import (
    archive as phone_archive,
    cold_revision,
    phone_documents,
)

MAINTENANCE = importlib.import_module("uat-retention-maintenance")


class ProductionPhoneReceiptCases:
    def phone_anchor(self, documents):
        payload = phone_archive(self, documents)
        return phone.healthy_anchor(
            self.repo,
            self.run,
            documents["prod-release-status.json"],
            MAINTENANCE.LANES["production"],
            api=lambda repository, endpoint: (
                self.jobs
                if endpoint
                == f"runs/300/attempts/{self.run['run_attempt']}/jobs?per_page=100"
                else self.api(repository, endpoint)
            ),
            governed=MAINTENANCE.governed_dispatch,
            timestamp=MAINTENANCE._github_timestamp,
            run_command=lambda *args, **kwargs: subprocess.CompletedProcess(
                [], 0, payload, b""
            ),
            timeout=30,
        )

    def test_phone_anchor_uses_exact_artifact_and_preserves_independent_lkg(self):
        for attempt in (1, 2):
            self.setUp()
            self.run["run_attempt"] = self.jobs["jobs"][0]["run_attempt"] = attempt
            documents = phone_documents(self)
            release = documents["prod-release-status.json"]
            unchanged = copy.deepcopy(release)
            anchor = self.phone_anchor(documents)
            actual = cold_revision(documents["phone-rollback/qualified.json"])
            revisions = [actual, {"metadata": {"name": "consent-protocol-old"}}]
            with (
                mock.patch.object(
                    MAINTENANCE, "command", return_value="consent-protocol-independent"
                ),
                mock.patch.object(
                    MAINTENANCE.retention, "revision_state", return_value=revisions
                ),
            ):
                flags = MAINTENANCE.release_protection_flags(
                    "consent-protocol",
                    "backend",
                    release,
                    environment="production",
                    phone_anchor=anchor,
                )
            self.assertEqual(
                flags,
                [
                    "consent-protocol-current",
                    "--rollback-revision",
                    "consent-protocol-cold",
                    "--last-known-good-revision",
                    "consent-protocol-independent",
                ],
            )
            self.assertEqual(anchor["artifact_id"], 100)
            self.assertEqual(anchor["run_attempt"], attempt)
            self.assertEqual(release, unchanged)

    def test_phone_anchor_refuses_summary_only_mixed_attempt_or_partial_proofs(self):
        for defect in (
            "summary_only",
            "source",
            "primary",
            "probe",
            "consumer",
            "documents",
            "job_attempt",
            "artifact_origin",
            "ambiguous",
            "upload_failed",
            "fork",
            "gate",
        ):
            self.setUp()
            documents = phone_documents(self)
            qualified, plan = (
                documents["phone-rollback/qualified.json"],
                documents["phone-rollback/plan.json"],
            )
            if defect == "summary_only":
                del documents["phone-rollback/qualified.json"]
            elif defect == "source":
                qualified["source"] = "a" * 40
            elif defect == "primary":
                plan["primary_sha"] = "a" * 40
            elif defect == "probe":
                qualified["probe"]["probe_generation_admission"] = True
            elif defect == "consumer":
                plan["consumer_compatibility"]["source_sha256"].pop(
                    next(iter(plan["consumer_compatibility"]["source_sha256"]))
                )
            elif defect == "documents":
                documents["prod-document-reader-compatibility.json"]["previous"][
                    "consent-protocol"
                ]["revision"] = "consent-protocol-old"
            elif defect == "gate":
                self.jobs["jobs"][0]["steps"][1]["conclusion"] = "skipped"
            else:
                self.apply_defect(defect)
            with (
                self.subTest(defect=defect),
                self.assertRaises(MAINTENANCE.retention.UnsafeState),
            ):
                self.phone_anchor(documents)

    def test_phone_anchor_rechecks_runtime_and_checkpoint_keeps_reference(self):
        self.setUp()
        documents = phone_documents(self)
        release = documents["prod-release-status.json"]
        anchor = self.phone_anchor(documents)
        actual = cold_revision(documents["phone-rollback/qualified.json"])
        self.assertEqual(
            phone.rollback_revision(anchor, release, [actual]), anchor["revision"]
        )
        for row in actual["spec"]["containers"][0]["env"]:
            if row["name"] == "AUTH_PHONE_RECOVERY_ENABLED":
                row["value"] = "true"
        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
            phone.rollback_revision(anchor, release, [actual])
        with tempfile.TemporaryDirectory() as temporary:
            args = mock.Mock(
                state_dir=pathlib.Path(temporary),
                environment="production",
                phone_anchor=anchor,
            )
            MAINTENANCE.checkpoint(args, 300, 300, [], "complete")
            saved = json.loads((args.state_dir / "completed.json").read_text())
            self.assertEqual(saved["phone_rollback_qualification"], anchor)

    def test_healthy_release_selects_phone_proof_without_rewriting_its_receipt(self):
        self.setUp()
        documents = phone_documents(self)
        release = documents["prod-release-status.json"]
        unchanged, anchors = copy.deepcopy(release), []
        payload = phone_archive(self, documents)
        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.object(MAINTENANCE, "api", side_effect=self.api),
            mock.patch.object(MAINTENANCE, "load_release", return_value=release),
            mock.patch.object(MAINTENANCE.time, "monotonic", return_value=120),
            mock.patch.object(
                MAINTENANCE, "_LOOKUP_DEADLINE", mock.Mock(get=lambda: 123)
            ),
            mock.patch.object(
                MAINTENANCE.retention,
                "run_command",
                return_value=subprocess.CompletedProcess([], 0, payload, b""),
            ) as fetch,
        ):
            found = MAINTENANCE.find_release(
                self.repo,
                "300",
                pathlib.Path(temporary),
                environment="production",
                on_phone_rollback=anchors.append,
            )
        self.assertEqual(found, (300, unchanged))
        self.assertEqual(release, unchanged)
        self.assertEqual(anchors[0]["revision"], release["phone_rollback"]["revision"])
        self.assertEqual(fetch.call_args.kwargs["timeout"], 3)

    def test_runtime_only_checkpoint_refuses_before_any_authority_or_cloud_lookup(self):
        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.dict(
                "os.environ",
                {"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF_NAME": "main"},
            ),
            mock.patch(
                "sys.argv",
                [
                    "maintenance",
                    "--environment",
                    "production",
                    "--state-dir",
                    temporary,
                    "--release-run-id",
                    "300",
                    "--qualified-cold-checkpoint-run-id",
                    "400",
                    "--verify-source-only",
                ],
            ),
            mock.patch.object(
                MAINTENANCE, "api", side_effect=AssertionError("no authority lookup")
            ),
            self.assertRaisesRegex(
                MAINTENANCE.retention.UnsafeState, "installed-schema"
            ),
        ):
            MAINTENANCE.maintenance_cli()

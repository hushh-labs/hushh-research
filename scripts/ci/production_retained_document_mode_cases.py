"""Stored and effective document policy stay bound to existing release receipts."""

import copy
import io
import json
import subprocess
import sys
import unittest
from contextlib import contextmanager, redirect_stdout
from pathlib import Path
from runpy import run_path
from tempfile import TemporaryDirectory
from unittest import mock

import production_backend_successor_control as control
import production_staged_worker as worker
from production_phone_receipt_fixtures import archive
from production_staged_worker_cases import (
    StagedWorkerFixture,
    _healthy_worker_case,
    timestamp,
)
from production_worker_basis_cases import _ordinary

ROOT = Path(__file__).resolve().parents[2]
MODE = {"configured": True, "enabled": False, "stored_enabled": True}
RAW = {"configured": True, "enabled": True}
OWNER = run_path(str(ROOT / "deploy/drive/rebind_protected_document_backend.py"))


class RetainedDocumentModeCases(StagedWorkerFixture, unittest.TestCase):
    @contextmanager
    def retained_stage(self):
        with _healthy_worker_case(self) as (_value, ports):
            ports.case.documents["prod-protected-document-release.json"] = copy.deepcopy(MODE)
            _ordinary(ports)
            value = worker.basis_owner.load("f" * 40)
            self.prepared["release_basis"] = value
            self.staged.update(copy.deepcopy(self.prepared), status="staged")
            self.bind_prepared()
            payload = archive(
                self,
                dict(zip(worker.FILES, (self.prepared, self.staged, self.scheduler), strict=True)),
            )
            intent = archive(
                type("Intent", (), {"artifact": self.intent_artifact})(),
                {worker.FILES[0]: self.prepared, worker.FILES[2]: self.scheduler},
            )
            load = worker.load_worker

            def fixture_ports(run_id, anchor, **arguments):
                self.assertEqual((run_id, anchor), ("300", None))
                self.assertEqual(arguments["healthy_release_run_id"], "500")
                return load(
                    run_id,
                    anchor,
                    **{
                        **arguments,
                        "api": self.api,
                        "governed": lambda *_: self.governed,
                        "timestamp": timestamp,
                        "run_command": lambda command, **_: subprocess.CompletedProcess(
                            command,
                            0,
                            intent if "/101/" in command[-1] else payload,
                            b"",
                        ),
                    },
                )

            with mock.patch.object(worker, "load_worker", side_effect=fixture_ports):
                yield ports

    def test_effective_mode_survives_an_ordinary_successor_and_live_uid_drift_refuses(
        self,
    ):
        with self.retained_stage() as ports:
            result = OWNER["retained_worker_mode"](RAW, target="f" * 40, stage_run="300")
            self.assertEqual(result, MODE)
            self.assertEqual(ports.case.documents["prod-protected-document-release.json"], MODE)
            ports.runtimes[worker.SERVICE][1]["metadata"]["uid"] = "recreated-worker"
            with self.assertRaises(worker.receipts.retention.UnsafeState):
                OWNER["retained_worker_mode"](RAW, target="f" * 40, stage_run="300")

    def test_changed_policy_shapes_and_unqualified_selectors_never_fall_back(self):
        for observed, expected in (
            ({**RAW, "enabled": False}, MODE),
            ({"configured": False, "enabled": False}, MODE),
            (RAW, {**MODE, "enabled": True}),
            (RAW, {**MODE, "stored_enabled": 1}),
            (RAW, {**MODE, "unknown": False}),
            ({**RAW, "enabled": 1}, MODE),
            (RAW, {"enabled": False}),
            ({"configured": False, "enabled": True}, {**MODE, "configured": False}),
        ):
            with (
                self.subTest(observed=observed, expected=expected),
                self.assertRaises(ValueError),
            ):
                OWNER["unchanged_mode"](observed, expected)
        for enabled in (False, True):
            ordinary = {"configured": True, "enabled": enabled}
            self.assertEqual(OWNER["unchanged_mode"](ordinary, ordinary), ordinary)
        with self.retained_stage():
            for selector in (
                {"target": "e" * 40, "stage_run": "300"},
                {"target": "f" * 40, "stage_run": "0"},
                {"target": "f" * 40, "stage_run": "300", "activation_run": "400"},
            ):
                with self.subTest(selector=selector), self.assertRaises(ValueError):
                    OWNER["retained_worker_mode"](RAW, **selector)

    def test_real_resolver_preserves_reader_verification_and_has_a_broken_code_control(
        self,
    ):
        resolver = run_path(str(ROOT / "deploy/drive/resolve_protected_document_release.py"))
        namespace = resolver["main"].__globals__
        runtime = {
            "environment": "production",
            "google_cloud_project": "hushh-pda",
            "protected_document_delivery": True,
            "document_delivery_bucket": "hushh-pda-document-delivery",
            "document_delivery_bucket_identity": "a" * 64,
            "unrelated_secret": "sentinel-do-not-print",
        }
        with self.retained_stage(), TemporaryDirectory() as directory:
            output = Path(directory) / "mode"
            report = Path(directory) / "reader.json"
            argv = [
                "resolve",
                "--project=hushh-pda",
                "--environment=production",
                "--target-sha=" + "f" * 40,
                "--required-ancestor=" + "a" * 40,
                "--staged-worker-run-id=300",
                "--verify-previous",
                "--github-output=" + str(output),
                "--json-output=" + str(report),
            ]
            reader = mock.Mock(return_value={**MODE, "targetSha": "f" * 40})
            with (
                mock.patch.dict(
                    namespace,
                    {
                        "_cloud": lambda *_: json.dumps(runtime),
                        "verify_readers": reader,
                        "reader_supported": lambda *_: True,
                        "run_path": lambda path: (
                            OWNER
                            if str(path).endswith("rebind_protected_document_backend.py")
                            else run_path(path)
                        ),
                    },
                ),
                mock.patch.object(sys, "argv", argv),
                redirect_stdout(io.StringIO()) as log,
            ):
                self.assertEqual(resolver["main"](), 0)
                self.assertEqual(json.loads(log.getvalue()), MODE)
                self.assertEqual(
                    output.read_text(),
                    "configured=true\nenabled=false\nstored_enabled=true\n",
                )
                reader.assert_called_once_with(
                    MODE, project="hushh-pda", target="f" * 40, ancestor="a" * 40
                )
                self.assertEqual(json.loads(report.read_text())["enabled"], False)
                self.assertNotIn("sentinel-do-not-print", log.getvalue())
                reader.side_effect = ValueError("reader compatibility refused")
                with self.assertRaises(SystemExit):
                    resolver["main"]()
                reader.side_effect = None

                def old_equality(observed, expected):
                    if observed != expected:
                        raise ValueError("old full equality")
                    return observed

                with (
                    mock.patch.dict(
                        OWNER["retained_worker_mode"].__globals__,
                        {
                            "unchanged_mode": old_equality,
                        },
                    ),
                    self.assertRaises(SystemExit),
                ):
                    resolver["main"]()

    def test_pending_selection_requalifies_original_receipt_and_keeps_mode(self):
        from production_activation_continuation_cases import _continuation_case
        from test_release_artifact_receipts import ReplayedProductionReleaseArtifactTest

        fixture = ReplayedProductionReleaseArtifactTest()
        fixture.setUp()
        with _continuation_case(fixture) as case:
            case.original.documents["prod-protected-document-release.json"] = copy.deepcopy(MODE)
            case.original.pack()
            with (
                mock.patch.object(control.authority(), "api", case.api),
                mock.patch.object(control.authority().retention, "run_command", case.download),
            ):
                selected = OWNER["retained_worker_mode"](RAW, target="f" * 40, activation_run="400")
                self.assertEqual(selected, MODE)
                case.original.run["actor"]["login"] = "unapproved"
                with self.assertRaises(worker.receipts.retention.UnsafeState):
                    OWNER["retained_worker_mode"](RAW, target="f" * 40, activation_run="400")

    def test_cli_rejects_conflicting_or_nonproduction_origins_before_config_read(self):
        from contextlib import redirect_stderr

        resolver = run_path(str(ROOT / "deploy/drive/resolve_protected_document_release.py"))
        argv = [
            "resolve",
            "--project=hushh-pda",
            "--environment=production",
            "--target-sha=" + "f" * 40,
            "--staged-worker-run-id=300",
        ]
        conflicts = [
            argv + ["--activation-run-id=400"],
            argv + ["--cold-release-mode"],
            argv + ["--production-restoration"],
            argv + ["--manual-rollback"],
            argv + ["--rollback-report=untrusted.json"],
            argv + ["--rebind-backend-report=untrusted.json"],
            [
                arg.replace("hushh-pda", "hushh-pda-uat").replace("=production", "=uat")
                for arg in argv
            ],
        ]
        read = mock.Mock(side_effect=AssertionError("invalid selector reached config"))
        with mock.patch.dict(resolver["main"].__globals__, {"_cloud": read}):
            for arguments in conflicts:
                with self.subTest(arguments=arguments), mock.patch.object(sys, "argv", arguments):
                    with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                        resolver["main"]()
                    self.assertEqual(error.exception.code, 2)
        read.assert_not_called()


class ColdRetainedDocumentModeCases(StagedWorkerFixture, unittest.TestCase):
    def test_anchor_initial_boundary_preserves_sealed_mode_and_other_checks(self):
        import importlib
        from types import SimpleNamespace

        from production_backend_successor_cases import operational_bundle
        from test_release_artifact_receipts import ReplayedProductionReleaseArtifactTest

        fixture = ReplayedProductionReleaseArtifactTest()
        fixture.setUp()
        bundle = operational_bundle(fixture)
        bundle["document_mode"] = copy.deepcopy(MODE)
        archived = bundle["installed_schema"]
        archived["snapshot"]["jobs"] = {}
        database = copy.deepcopy(archived["database"])
        snapshot = copy.deepcopy(archived["snapshot"])
        workos = {"qualification": "passed"}
        ports = SimpleNamespace(
            snapshot=lambda: copy.deepcopy(snapshot),
            database=lambda _: database,
            workos=lambda: workos,
            submissions=lambda: {"qualification": "passed"},
        )
        producers = importlib.import_module("schema_producers")
        with (
            mock.patch.object(producers, "Runtime", return_value=ports),
            mock.patch.object(
                control.proof.bootstrap_owner().plan.qualify_image,
                "run",
                return_value=json.dumps(RAW),
            ),
        ):
            control.revalidate_initial({"sealed_boundary": bundle})
            for observed in ({**RAW, "enabled": False}, {**RAW, "configured": False}):
                with mock.patch.object(
                    control.proof.bootstrap_owner().plan.qualify_image,
                    "run",
                    return_value=json.dumps(observed),
                ):
                    with self.assertRaises(ValueError):
                        control.revalidate_initial({"sealed_boundary": bundle})
            for changed, key, value in (
                (database, "installed", False),
                (snapshot, "jobs", {"unqualified": True}),
                (workos, "qualification", "failed"),
            ):
                old = changed[key]
                changed[key] = value
                with self.assertRaises(ValueError):
                    control.revalidate_initial({"sealed_boundary": bundle})
                changed[key] = old
            with (
                mock.patch.object(
                    control,
                    "run_path",
                    return_value={
                        "unchanged_mode": lambda observed, _: observed,
                    },
                ),
                self.assertRaises(ValueError),
            ):
                control.revalidate_initial({"sealed_boundary": bundle})

    def test_cold_resolver_requalifies_healthy_basis_and_keeps_reader_gate(self):
        resolver = run_path(str(ROOT / "deploy/drive/resolve_protected_document_release.py"))
        runtime = {
            "environment": "production",
            "google_cloud_project": "hushh-pda",
            "protected_document_delivery": True,
            "document_delivery_bucket": "hushh-pda-document-delivery",
            "document_delivery_bucket_identity": "a" * 64,
        }
        arguments = [
            "resolve",
            "--project=hushh-pda",
            "--environment=production",
            "--target-sha=" + "f" * 40,
            "--required-ancestor=" + "a" * 40,
            "--verify-previous",
            "--cold-release-mode",
        ]

        def reader(mode, **_):
            if mode != MODE:
                raise ValueError("legacy reader requires maintenance mode")
            return {**mode, "targetSha": "f" * 40}

        with _healthy_worker_case(self) as (_value, ports):
            ports.case.documents["prod-protected-document-release.json"] = copy.deepcopy(MODE)
            _ordinary(ports)
            gate = mock.Mock(side_effect=reader)
            with (
                mock.patch.dict(
                    resolver["main"].__globals__,
                    {
                        "_cloud": lambda *_: json.dumps(runtime),
                        "reader_supported": lambda *_: True,
                        "verify_readers": gate,
                        "run_path": lambda path: (
                            OWNER
                            if str(path).endswith("rebind_protected_document_backend.py")
                            else run_path(path)
                        ),
                    },
                ),
                mock.patch.object(sys, "argv", arguments),
                redirect_stdout(io.StringIO()) as output,
            ):
                self.assertEqual(resolver["main"](), 0)
                self.assertEqual(json.loads(output.getvalue()), MODE)
                gate.assert_called_once_with(
                    MODE, project="hushh-pda", target="f" * 40, ancestor="a" * 40
                )
                with mock.patch.object(sys, "argv", arguments[:-1]), self.assertRaises(SystemExit):
                    resolver["main"]()
                gate.side_effect = ValueError("reader refused")
                with self.assertRaises(SystemExit):
                    resolver["main"]()
                gate.side_effect = reader
                ports.case.run["actor"]["login"] = "unapproved"
                with self.assertRaises(SystemExit):
                    resolver["main"]()

    def test_cold_operational_origin_binds_exact_primary(self):
        from production_activation_continuation_cases import _continuation_case
        from test_release_artifact_receipts import ReplayedProductionReleaseArtifactTest

        fixture = ReplayedProductionReleaseArtifactTest()
        fixture.setUp()
        with _continuation_case(fixture) as case:
            expected = case.original.anchor["sealed_boundary"]["document_mode"]
            observed = {
                "configured": expected["configured"],
                "enabled": expected.get("stored_enabled", expected["enabled"]),
            }
            self.assertEqual(
                OWNER["retained_worker_mode"](observed, target="f" * 40, cold_release=True),
                expected,
            )
            with self.assertRaises(ValueError):
                OWNER["retained_worker_mode"](observed, target="e" * 40, cold_release=True)

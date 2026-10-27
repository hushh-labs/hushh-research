"""Operational rollback protection and distinct, fully drained pending retirement."""

from __future__ import annotations

import copy
import importlib
import io
import json
import pathlib
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

import production_retention_context as context

MAINTENANCE = importlib.import_module("uat-retention-maintenance")
RETENTION = MAINTENANCE.retention
OLD, OBSOLETE, COLD, PRIMARY = (
    "consent-protocol-00302-fix",
    "consent-protocol-00299-vuk",
    "consent-protocol-00310-cold",
    "consent-protocol-00311-primary",
)


def revision(name, uid, source, created):
    return {
        "metadata": {
            "name": name,
            "uid": uid,
            "creationTimestamp": created,
            "labels": {"deploy-sha": source},
        },
        "spec": {"timeoutSeconds": 3600},
    }


class RetentionFixture(unittest.TestCase):
    def setUp(self):
        self.anchor = {
            "revision": COLD,
            "uid": "cold-uid",
            "source": "a" * 40,
            "image": "image@sha256:" + "a" * 64,
            "origin": {"run_id": "300", "run_attempt": 2},
        }
        self.release = {
            "status": "healthy",
            "sha": "7" * 40,
            "final": {
                "backend_revision": OLD,
                "frontend_revision": "hushh-webapp-00158-old",
            },
            "predeploy": {"backend_revision": OBSOLETE},
        }
        self.service = {
            "metadata": {"uid": "service-uid", "generation": 1},
            "spec": {"template": {"spec": {"timeoutSeconds": 3600}}},
            "status": {
                "traffic": [{"revisionName": PRIMARY, "percent": 100}],
                "latestReadyRevisionName": PRIMARY,
                "latestCreatedRevisionName": PRIMARY,
            },
        }
        self.revisions = [
            revision(OLD, "legacy-uid", "7" * 40, "2026-10-20T00:00:00Z"),
            revision(COLD, "cold-uid", "a" * 40, "2026-10-27T00:00:00Z"),
            revision(PRIMARY, "primary-uid", "b" * 40, "2026-10-27T01:00:00Z"),
        ]
        self.pending = {
            "schema_version": 1,
            "kind": "production-pending-retirement",
            "status": "pending_activation",
            "healthy_release": False,
            "release_run_id": 400,
            "run_attempt": 1,
            "workflow_sha": "b" * 40,
            "release_sha": "b" * 40,
            "artifact_id": 9,
            "artifact_digest": "sha256:" + "c" * 64,
            "candidate": {
                "revision": PRIMARY,
                "uid": "primary-uid",
                "service_uid": "service-uid",
                "source": "b" * 40,
                "run_id": "400",
            },
            "cold_rollback": {**self.anchor, "runtime_run_id": "300"},
            "pending_revisions": [
                {
                    "revision": OLD,
                    "uid": "legacy-uid",
                    "source": "7" * 40,
                    "traffic_percent": 0,
                    "tags": [],
                }
            ],
        }

    def cli(self, directory):
        flags = context.pending_flags(self.pending, directory)
        return [
            "retention",
            "consent-protocol",
            "us-central1",
            "2",
            PRIMARY,
            "--rollback-revision",
            COLD,
            "--last-known-good-revision",
            COLD,
            "--project",
            "hushh-pda",
            "--apply",
            "--defer-state",
            str(directory / "drain.json"),
            "--release-run-id",
            "400",
            *flags,
        ]


class WorkerRetentionCases:
    def test_healthy_worker_binding_refuses_tag_uid_and_release_drift(self):
        reader = importlib.import_module("production_staged_worker")
        args = SimpleNamespace(
            staged_worker_run_id="300", operational_anchor=None,
            release_run_id="500", verify_source_only=False,
        )
        loaded = {"context": {"basis": {"healthy": {"run_id": "500"}}}, "files": {}}
        for drift in ("", "tag", "uid", "release", "source"):
            args.verify_source_only = drift == "source"
            failure = RETENTION.UnsafeState(drift) if drift in {"tag", "uid", "release"} else None
            with self.subTest(drift=drift), mock.patch.object(
                reader, "load_worker", return_value=loaded, side_effect=failure
            ) as load:
                if failure is not None:
                    with self.assertRaises(RETENTION.UnsafeState):
                        context.worker(MAINTENANCE, args, "org/repo")
                elif args.verify_source_only:
                    self.assertIsNone(context.worker(MAINTENANCE, args, "org/repo"))
                else:
                    self.assertIs(context.worker(MAINTENANCE, args, "org/repo"), loaded)
                self.assertEqual(load.call_args.kwargs["healthy_release_run_id"], "500")
                self.assertEqual(load.call_args.kwargs["source_only"], args.verify_source_only)

    def test_staged_worker_protection_uses_readonly_owner_and_explicit_anchor(self):
        validate = mock.Mock()
        receipt = {
            "candidate": "worker-staged",
            "candidate_uid": "worker-uid",
            "context": {"source": "a" * 40, "image": "image@digest"},
            "baseline": {"serving": "worker-current", "uid": "service-uid"},
        }
        loaded = {
            "context": {
                "serving_revision": "worker-current",
                "revision": "worker-staged",
                "uid": "worker-uid",
                "service_uid": "service-uid",
                **receipt["context"],
            },
            "files": {
                "worker-stage.json.staged.json": json.dumps(receipt).encode(),
                "worker-stage.json.scheduler.json": b"{}",
            },
        }
        with mock.patch.object(
            context, "run_path", return_value={"validate": validate}
        ):
            flags = context.worker_flags(MAINTENANCE, loaded)
        self.assertEqual(
            flags,
            [
                "worker-current",
                "--rollback-revision",
                "worker-staged",
                "--last-known-good-revision",
                "worker-current",
            ],
        )
        self.assertEqual(validate.call_args.args[0], receipt)
        self.assertTrue(validate.call_args.kwargs["allow_retirement"])

    def test_only_verified_worker_context_selects_production_worker_lane(self):
        args = SimpleNamespace(
            environment="production", pending_context=None, worker_anchor=None,
            operational_backend_proof_run_id="", operational_backend_proof_attempt=None,
            staged_worker_run_id="300", release_run_id="500", production_capacity_bridge=False,
        )
        parser = mock.Mock()
        parser.error.side_effect = ValueError
        context.check_inputs(args, parser)
        with mock.patch.object(args, "release_run_id", "0"), self.assertRaises(ValueError):
            context.check_inputs(args, parser)
        self.assertNotIn(
            "consent-protocol-drive-worker", context.services(MAINTENANCE, args)
        )
        args.worker_anchor = {"context": {"revision": "worker-staged"}}
        self.assertEqual(
            context.services(MAINTENANCE, args)["consent-protocol-drive-worker"], 1
        )
        args.pending_context = self.pending
        self.assertEqual(context.services(MAINTENANCE, args), {"consent-protocol": 2})


class OperationalRetentionCases(WorkerRetentionCases, RetentionFixture):
    def test_operational_reference_replaces_extra_rollback_but_preserves_current(self):
        service = copy.deepcopy(self.service)
        service["status"].update(
            traffic=[{"revisionName": OLD, "percent": 100}],
            latestCreatedRevisionName=COLD,
            latestReadyRevisionName=COLD,
        )
        revisions = self.revisions[:2] + [
            revision(OBSOLETE, "obsolete-uid", "7" * 40, "2026-10-19T00:00:00Z")
        ]
        with mock.patch.object(context, "active", return_value=self.anchor):
            flags = MAINTENANCE.release_protection_flags(
                "consent-protocol",
                "backend",
                self.release,
                environment="production",
                operational_anchor=self.anchor,
            )
        self.assertEqual(
            flags,
            [OLD, "--rollback-revision", COLD, "--last-known-good-revision", COLD],
        )
        plan = RETENTION.plan_cleanup(
            service, revisions, 2, {flags[0], flags[2], flags[4]}
        )
        self.assertEqual(plan.delete_revisions, (OBSOLETE,))
        self.assertEqual(plan.protected, frozenset({OLD, COLD}))

    def test_active_reference_refuses_missing_or_changed_origin(self):
        proof = importlib.import_module("production_backend_successor_proof")
        control = importlib.import_module("production_backend_successor_control")
        for anchor in (
            None,
            {**self.anchor, "origin": {"run_id": "301", "run_attempt": 2}},
        ):
            with (
                self.subTest(anchor=anchor),
                mock.patch.object(proof, "read_original", return_value={}),
                mock.patch.object(control, "record_anchor", return_value=anchor),
                mock.patch.object(control, "live") as live,
            ):
                with self.assertRaises(RETENTION.UnsafeState):
                    context.active(MAINTENANCE, "300", 2)
                live.assert_not_called()

    def test_prospective_reference_can_select_only_before_actual_cas(self):
        proof = importlib.import_module("production_backend_successor_proof")
        control = importlib.import_module("production_backend_successor_control")
        original = {"tag_oid": "a" * 40}
        proposed = {**self.anchor, "original_healthy": original}
        args = SimpleNamespace(
            verify_source_only=True,
            operational_backend_proof_run_id="300",
            operational_backend_proof_attempt=2,
        )
        with (
            mock.patch.object(proof, "read_original", return_value=original),
            mock.patch.object(control, "record_anchor", return_value=None),
            mock.patch.object(control, "load_anchor", return_value=proposed),
            mock.patch.object(control, "live") as live,
        ):
            self.assertIsNone(context.load_operational(MAINTENANCE, args))
            self.assertEqual(
                args.prospective_operational["kind"],
                "production-operational-prospective",
            )
            live.assert_not_called()
            args.verify_source_only = False
            with self.assertRaises(RETENTION.UnsafeState):
                context.load_operational(MAINTENANCE, args)

    def test_continuation_backend_provenance_comes_only_from_strict_archive_reader(
        self,
    ):
        reader = importlib.import_module("production_activation_continuation")
        release = {**self.release, "phone_rollback": {"revision": COLD}}
        backend = {
            "revision": PRIMARY,
            "uid": "primary-uid",
            "service_uid": "service-uid",
            "sha": "b" * 40,
            "run_id": 400,
        }
        callback = mock.Mock()
        with (
            mock.patch.object(
                reader,
                "archive_context",
                return_value={"backend": backend, "cold_rollback": self.anchor},
            ),
            mock.patch.object(
                context.production_phone_receipt,
                "healthy_anchor",
                side_effect=AssertionError("already qualified"),
            ),
        ):
            context.healthy_phone(
                MAINTENANCE,
                "org/repo",
                {"id": 500},
                release,
                MAINTENANCE.LANES["production"],
                callback,
            )
        self.assertEqual(
            release["_maintenance_lane_provenance"]["backend"]["run_id"], 400
        )
        self.assertEqual(release["_maintenance_backend_identity"], backend)
        self.assertNotIn("frontend", release["_maintenance_lane_provenance"])
        callback.assert_called_once_with(self.anchor)
        release = {**self.release, "phone_rollback": {"revision": COLD}}
        with (
            mock.patch.object(reader, "archive_context", return_value=None),
            mock.patch.object(
                context.production_phone_receipt,
                "healthy_anchor",
                return_value=self.anchor,
            ),
        ):
            context.healthy_phone(
                MAINTENANCE,
                "org/repo",
                {"id": 500},
                release,
                MAINTENANCE.LANES["production"],
                callback,
            )
        self.assertNotIn("_maintenance_lane_provenance", release)

    def test_continuation_frontend_provenance_uses_verified_original_run(self):
        reader = importlib.import_module("production_activation_continuation")
        frontend = {
            "revision": self.release["final"]["frontend_revision"],
            "run_id": 400,
            "sha": "b" * 40,
        }
        release = {**self.release, "phone_rollback": {"revision": COLD}}
        with mock.patch.object(
            reader,
            "archive_context",
            return_value={
                "backend": {"run_id": 400, "sha": "b" * 40},
                "frontend": frontend,
                "cold_rollback": self.anchor,
            },
        ):
            context.healthy_phone(
                MAINTENANCE, "org/repo", {"id": 500}, release,
                MAINTENANCE.LANES["production"], None,
            )
        self.assertEqual(
            release["_maintenance_lane_provenance"]["frontend"],
            {"run_id": 400, "sha": "b" * 40, "source": "deploy-production"},
        )

    def test_source_artifact_cannot_supply_internal_pending_or_uid_authority(self):
        for key in ("_maintenance_pending_retirement", "_maintenance_backend_identity"):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as temporary:
                directory = pathlib.Path(temporary)
                path = directory / "400" / "prod-release-status.json"
                path.parent.mkdir()
                path.write_text(json.dumps({**self.release, key: {"forged": True}}))
                with (
                    mock.patch.object(
                        MAINTENANCE, "artifact_exists", return_value=True
                    ),
                    self.assertRaisesRegex(
                        RETENTION.UnsafeState, "internal maintenance authority"
                    ),
                ):
                    MAINTENANCE.load_release("org/repo", 400, directory, "production")


class PendingRetirementCases(RetentionFixture):
    def test_pending_selection_uses_separate_reader_without_healthy_relabelling(self):
        release = {**self.release, "status": "pending_activation"}
        run = {
            "id": 400,
            "status": "completed",
            "conclusion": "success",
            "event": "workflow_dispatch",
        }
        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.object(MAINTENANCE, "api", return_value=run),
            mock.patch.object(MAINTENANCE, "trusted_origin", return_value=True),
            mock.patch.object(MAINTENANCE, "governed_dispatch", return_value=True),
            mock.patch.object(MAINTENANCE, "load_release", return_value=release),
            mock.patch.object(
                MAINTENANCE.release_artifact_receipts, "validate_revision_names"
            ),
            mock.patch.object(context, "pending", return_value=self.pending) as reader,
            mock.patch.object(context, "healthy_phone") as healthy,
        ):
            found = MAINTENANCE.find_release(
                "org/repo",
                "400",
                pathlib.Path(temporary),
                environment="production",
                operational_anchor=self.anchor,
            )
        self.assertEqual(found[1]["status"], "pending_activation")
        self.assertEqual(found[1]["_maintenance_pending_retirement"], self.pending)
        self.assertIs(reader.call_args.args[-1], self.anchor)
        # Hook receives pending unchanged and must never create a healthy anchor.
        self.assertEqual(healthy.call_args.args[3]["status"], "pending_activation")

    def test_pending_cli_preserves_full_3660_drain_without_healthy_flag(self):
        deleted = []
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            argv = self.cli(directory)
            self.assertNotIn("--healthy", argv)
            for now in (10000, 13659, 13660):
                with (
                    mock.patch.object(sys, "argv", argv),
                    mock.patch.object(
                        RETENTION, "service_state", return_value=self.service
                    ),
                    mock.patch.object(
                        RETENTION, "revision_state", return_value=self.revisions
                    ),
                    mock.patch.object(RETENTION.time, "time", return_value=now),
                    mock.patch.object(
                        RETENTION,
                        "mutate",
                        side_effect=lambda _args, command, *_rest: deleted.append(
                            command[-1]
                        ),
                    ),
                ):
                    self.assertEqual(RETENTION.main(), 0)
                if now < 13660:
                    self.assertEqual(deleted, [])
                    state = json.loads((directory / "drain.json").read_bytes())
                    self.assertEqual(state["not_before"], 13660)
                    self.assertEqual(set(state["protected"]), {PRIMARY, COLD})
            self.assertEqual(deleted, [OLD])

    def test_pending_cli_rejects_digest_drift_before_provider_reads(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            argv = self.cli(directory)
            path = directory / "pending-retirement.json"
            path.write_text(path.read_text() + " ")
            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch.object(
                    RETENTION,
                    "service_state",
                    side_effect=AssertionError("no provider read"),
                ),
                mock.patch("sys.stderr", new=io.StringIO()),
                self.assertRaises(SystemExit),
            ):
                RETENTION.main()

    def test_pending_inventory_rejects_uid_or_authority_expansion(self):
        for changed in ("candidate", "legacy", "extra", "percent"):
            service, revisions = (
                copy.deepcopy(self.service),
                copy.deepcopy(self.revisions),
            )
            if changed == "candidate":
                revisions[2]["metadata"]["uid"] = "changed"
            elif changed == "legacy":
                revisions[0]["metadata"]["uid"] = "changed"
            elif changed == "extra":
                revisions.append(
                    revision(OBSOLETE, "extra-uid", "7" * 40, "2026-10-19T00:00:00Z")
                )
            else:
                service["status"]["traffic"][0]["percent"] = 99
            with (
                self.subTest(changed=changed),
                self.assertRaises(RETENTION.UnsafeState),
            ):
                plan = RETENTION.plan_cleanup(service, revisions, 2, {PRIMARY, COLD})
                context.retention_admission.pending_plan(
                    RETENTION, self.pending, service, revisions, plan
                )


if __name__ == "__main__":
    unittest.main()

"""One chat backend releases remain valid, independently proven UAT cleanup sources."""

from __future__ import annotations

import copy
import importlib
import json
import pathlib
import tempfile
import unittest
from unittest import mock

maintenance = importlib.import_module("uat-retention-maintenance")


class OneChatRetentionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = "consent-protocol-02121-abc"
        self.old_backend = "consent-protocol-02118-yed"
        self.frontend = "hushh-webapp-01693-5vh"
        self.backend_sha = "b" * 40
        self.frontend_sha = "a" * 40
        self.run = {
            "id": 300,
            "path": ".github/workflows/deploy-uat-one-chat.yml",
            "head_branch": "main",
            "head_sha": "c" * 40,  # a replay's dispatch ref differs from target
            "event": "workflow_dispatch",
            "actor": {"login": "ankitkumarsingh1702"},
            "status": "completed",
            "conclusion": "success",
            "repository": {"full_name": "org/repo"},
            "head_repository": {"full_name": "org/repo"},
        }
        self.report = {
            "status": "success",
            "project": "hushh-pda-uat",
            "region": "us-central1",
            "service": "consent-protocol",
            "target_sha": self.backend_sha,
            "run_id": "300",
            "old_revision": self.old_backend,
            "candidate_revision": self.backend,
            "final_serving_revision": self.backend,
            "final_traffic": {self.backend: 100},
            "temporary_probe_job_deleted": True,
            "probe": {
                "one_chat_probe_ok": True,
                "one_chat_project": "hussh-511311",
            },
            "candidate_tag_removed": False,  # already removed is also healthy
        }
        self.owner = {
            "sha": self.frontend_sha,
            "final": {"frontend_revision": self.frontend},
        }

    def load(self, report: dict) -> dict:
        with tempfile.TemporaryDirectory() as temporary:
            def download(_repo, _run_id, _name, directory):
                directory.mkdir(parents=True)
                (directory / "uat-one-chat-release.json").write_text(json.dumps(report))

            with (
                mock.patch.object(maintenance, "artifact_exists", return_value=True),
                mock.patch.object(maintenance, "download", side_effect=download),
                mock.patch.object(
                    maintenance,
                    "prior_healthy_uat_release",
                    return_value=(200, self.owner),
                ) as previous,
            ):
                release = maintenance.load_one_chat_release(
                    "org/repo", self.run, pathlib.Path(temporary)
                )
                previous.assert_called_once_with(
                    "org/repo", self.run, pathlib.Path(temporary), frontend_owner=True
                )
                return release

    def test_replayed_release_composes_independent_backend_and_frontend_provenance(self):
        release = self.load(self.report)
        self.assertEqual(release["final"]["backend_revision"], self.backend)
        self.assertEqual(release["final"]["frontend_revision"], self.frontend)
        self.assertEqual(release["predeploy"]["backend_revision"], self.old_backend)
        self.assertEqual(
            release["_maintenance_lane_provenance"],
            {
                "backend": {
                    "run_id": 300,
                    "sha": self.backend_sha,
                    "source": "deploy-uat-one-chat",
                },
                "frontend": {"run_id": 200, "sha": self.frontend_sha},
            },
        )

    def test_bad_receipts_do_not_authorize_cleanup(self):
        changes = (
            ("run_id", "301"),
            ("target_sha", "mutable"),
            ("old_revision", self.backend),
            ("final_traffic", {self.old_backend: 100}),
            ("temporary_probe_job_deleted", False),
            ("probe", {"one_chat_probe_ok": False}),
        )
        for field, value in changes:
            with self.subTest(field=field):
                report = copy.deepcopy(self.report)
                report[field] = value
                with self.assertRaises(maintenance.retention.UnsafeState):
                    self.load(report)

    def test_latest_one_chat_source_wins_over_older_standard_release(self):
        standard = {
            **self.run,
            "id": 200,
            "path": ".github/workflows/deploy-uat.yml",
        }

        def api(_repo, endpoint):
            if "deploy-uat-one-chat.yml/runs?" in endpoint:
                return {"workflow_runs": [self.run]}
            if "deploy-uat.yml/runs?" in endpoint:
                return {"workflow_runs": [standard]}
            raise AssertionError(endpoint)

        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.object(maintenance, "api", side_effect=api),
            mock.patch.object(maintenance, "load_one_chat_release", return_value=self.load(self.report)),
            mock.patch.object(
                maintenance.retention,
                "service_state",
                side_effect=AssertionError("pre-auth source selection cannot access Cloud Run"),
            ),
        ):
            source = maintenance.find_release(
                "org/repo", "", pathlib.Path(temporary), require_live=False
            )
        self.assertEqual(source[0], 300)

    def test_live_proof_requires_the_one_chat_source_and_frontend_owner(self):
        release = self.load(self.report)

        def state(service, _project, _region):
            name = {
                "consent-protocol": self.backend,
                "hushh-webapp": self.frontend,
                "consent-protocol-drive-worker": "consent-protocol-drive-worker-00530-sep",
            }[service]
            return {
                "status": {
                    "conditions": [{"type": "Ready", "status": "True"}],
                    "traffic": [{"revisionName": name, "percent": 100}],
                }
            }

        def revision_state(service, _project, _region):
            backend = service == "consent-protocol"
            provenance = release["_maintenance_lane_provenance"][
                "backend" if backend else "frontend"
            ]
            return [{
                "metadata": {
                    "name": self.backend if backend else self.frontend,
                    "labels": {
                        "deploy-sha": provenance["sha"],
                        "github-run-id": str(provenance["run_id"]),
                        "deploy-source": "deploy-uat-one-chat" if backend else "deploy-uat",
                    },
                },
                "spec": {"containers": [{
                    "image": "gcr.io/hushh-pda-uat/app@sha256:" + "a" * 64,
                    "env": [
                        {"name": "HUSHH_DEPLOY_SHA", "value": provenance["sha"]},
                        {"name": "HUSHH_DEPLOY_SOURCE", "value": "deploy-uat-one-chat" if backend else "deploy-uat"},
                    ],
                }]},
                "status": {"conditions": [{"type": "Ready", "status": "True"}]},
            }]

        with (
            mock.patch.object(maintenance.retention, "service_state", side_effect=state),
            mock.patch.object(maintenance.retention, "revision_state", side_effect=revision_state),
        ):
            self.assertTrue(maintenance.live_release_matches(release))
            forged = copy.deepcopy(release)
            forged["_maintenance_lane_provenance"]["backend"]["source"] = "deploy-uat"
            self.assertFalse(maintenance.live_release_matches(forged))
            stale = copy.deepcopy(release)
            stale["_maintenance_lane_provenance"]["frontend"]["run_id"] = 199
            self.assertFalse(maintenance.live_release_matches(stale))
            moved = copy.deepcopy(release)
            moved["final"]["frontend_revision"] = "hushh-webapp-01694-new"
            self.assertFalse(maintenance.live_release_matches(moved))


if __name__ == "__main__":
    unittest.main()

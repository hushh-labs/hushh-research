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

    def test_rerun_uses_only_its_exact_attempt_artifact(self):
        self.run["run_attempt"] = 2
        report = copy.deepcopy(self.report)
        report["attempt"] = 2
        expected_name = f"{maintenance.ONE_CHAT_ARTIFACT}-2"
        looked_up = []
        downloaded = []
        with tempfile.TemporaryDirectory() as temporary:
            def exists(_repository, _run_id, name):
                looked_up.append(name)
                return name == expected_name

            def download(_repository, _run_id, name, directory):
                downloaded.append(name)
                directory.mkdir(parents=True)
                (directory / "uat-one-chat-release.json").write_text(json.dumps(report))

            with (
                mock.patch.object(maintenance, "artifact_exists", side_effect=exists),
                mock.patch.object(maintenance, "download", side_effect=download),
                mock.patch.object(
                    maintenance,
                    "prior_healthy_uat_release",
                    return_value=(200, self.owner),
                ),
            ):
                release = maintenance.load_one_chat_release(
                    "org/repo", self.run, pathlib.Path(temporary)
                )
        self.assertEqual(looked_up, [expected_name])
        self.assertEqual(downloaded, [expected_name])
        self.assertEqual(release["final"]["backend_revision"], self.backend)

        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.object(
                maintenance,
                "artifact_exists",
                side_effect=lambda _repository, _run_id, name: name == maintenance.ONE_CHAT_ARTIFACT,
            ), mock.patch.object(
                maintenance,
                "download",
                side_effect=AssertionError("a rerun must not fall back to the legacy artifact"),
            ):
                self.assertIsNone(
                    maintenance.load_one_chat_release(
                        "org/repo", {**self.run, "run_attempt": 3}, pathlib.Path(temporary)
                    )
                )

    def test_bad_receipts_do_not_authorize_cleanup(self):
        changes = (
            ("run_id", "301"),
            ("target_sha", "mutable"),
            ("old_revision", self.backend),
            ("final_traffic", {self.old_backend: 100}),
            ("temporary_probe_job_deleted", False),
            ("probe", {"one_chat_probe_ok": False}),
            ("probe", {"one_chat_probe_ok": True, "one_chat_project": "unrelated-project"}),
        )
        for field, value in changes:
            with self.subTest(field=field):
                report = copy.deepcopy(self.report)
                report[field] = value
                with self.assertRaises(maintenance.retention.UnsafeState):
                    self.load(report)

    def test_receipts_may_name_the_uat_profile_project_or_a_retired_one(self):
        profile = json.loads(maintenance.MANAGED_AI_PROFILE.read_text())
        for project in (profile["environments"]["uat"]["project"], "hussh-511311"):
            with self.subTest(project=project):
                report = copy.deepcopy(self.report)
                report["probe"]["one_chat_project"] = project
                self.assertEqual(self.load(report)["final"]["backend_revision"], self.backend)

    def test_receipt_project_follows_the_profile_when_it_moves(self):
        with tempfile.TemporaryDirectory() as temporary:
            profile = pathlib.Path(temporary) / "managed-ai-runtime.json"
            profile.write_text(
                json.dumps({"environments": {"uat": {"project": "next-uat-project"}}})
            )
            with mock.patch.object(maintenance, "MANAGED_AI_PROFILE", profile):
                for project, trusted in (
                    ("next-uat-project", True),
                    ("hussh-511311", True),  # retired, still named by older receipts
                    ("unrelated-project", False),
                ):
                    with self.subTest(project=project):
                        report = copy.deepcopy(self.report)
                        report["probe"]["one_chat_project"] = project
                        if trusted:
                            release = self.load(report)
                            self.assertEqual(release["final"]["backend_revision"], self.backend)
                        else:
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

    def test_automatic_uat_source_scan_reaches_live_run_past_first_page(self):
        standard_path = ".github/workflows/deploy-uat.yml"
        older_source = {
            **self.run,
            "id": 200,
            "path": standard_path,
            "conclusion": "success",
        }
        newer = [
            {**self.run, "id": run_id, "path": standard_path, "conclusion": "failure"}
            for run_id in range(201, 321)
        ]
        newer[300 - 201]["conclusion"] = "success"  # stale artifact-backed release
        newer[310 - 201]["conclusion"] = "success"
        newer[310 - 201]["actor"] = {"login": "ungoverned"}
        ordered = list(reversed(newer)) + [older_source]
        live_release = {
            "status": "healthy",
            "final": {
                "backend_revision": "consent-protocol-02118-yed",
                "frontend_revision": self.frontend,
            },
            "predeploy": {},
        }
        stale_release = {
            **live_release,
            "final": {
                **live_release["final"],
                "backend_revision": "consent-protocol-02119-stale",
            },
        }

        def api(_repo, endpoint):
            if "workflows/deploy-uat-one-chat.yml/runs?" in endpoint:
                return {"workflow_runs": []}
            if "workflows/deploy-uat.yml/runs?" in endpoint:
                page = int(endpoint.rsplit("page=", 1)[1])
                return {"workflow_runs": ordered[(page - 1) * 100 : page * 100]}
            raise AssertionError(endpoint)

        loaded: list[int] = []

        def load(_repo, run_id, _directory, _environment):
            loaded.append(run_id)
            if run_id == 310:
                raise AssertionError("ungoverned source must not be loaded")
            return {200: live_release, 300: stale_release}.get(run_id)

        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.object(maintenance, "api", side_effect=api),
            mock.patch.object(maintenance, "load_release", side_effect=load),
        ):
            for live, expected in ((True, 200), (False, None)):
                with (
                    self.subTest(live=live),
                    mock.patch.object(
                        maintenance,
                        "live_release_matches",
                        side_effect=lambda release, live=live, **_kwargs: live and release is live_release,
                    ),
                ):
                    found = maintenance.find_release(
                        "org/repo", "", pathlib.Path(temporary), require_live=True
                    )
                    self.assertEqual(found[0] if found else None, expected)
        self.assertNotIn(310, loaded)
        self.assertIn(300, loaded)
        self.assertIn(200, loaded)

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

"""Safety contracts for Cloud Run revision cleanup."""

import contextlib
import copy
import importlib
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).with_name("cloudrun-retention.py")
SPEC = importlib.util.spec_from_file_location("cloudrun_retention", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
MAINTENANCE = importlib.import_module("uat-retention-maintenance")


def service(*traffic):
    return {
        "metadata": {"generation": 1, "uid": "service-uid"},
        "spec": {"template": {"spec": {"timeoutSeconds": 240}}},
        "status": {"traffic": list(traffic)},
    }


def revision(number):
    return {
        "metadata": {
            "name": f"consent-protocol-{number:05d}-abc",
            "creationTimestamp": f"2026-10-07T00:{number:02d}:00Z",
        },
        "spec": {"timeoutSeconds": 240},
    }


class RetentionSafetyTest(unittest.TestCase):
    def run_deferred(self, state, revisions, directory, now):
        mutations = []

        def mutate(args, *_args, **_kwargs):
            mutations.append(args)
            if args[:2] == ["services", "update-traffic"]:
                state["status"]["traffic"] = [
                    t for t in state["status"]["traffic"] if not t.get("tag")
                ]
                state["metadata"]["generation"] += 1
            if args[:2] == ["revisions", "delete"]:
                revisions[:] = [
                    r for r in revisions if r["metadata"]["name"] != args[2]
                ]

        with (
            mock.patch.object(
                MODULE, "service_state", side_effect=lambda *_: copy.deepcopy(state)
            ),
            mock.patch.object(
                MODULE,
                "revision_state",
                side_effect=lambda *_: copy.deepcopy(revisions),
            ),
            mock.patch.object(MODULE, "gcloud", side_effect=mutate),
            mock.patch.object(MODULE.time, "time", return_value=now),
            mock.patch.object(
                MODULE.time,
                "sleep",
                side_effect=AssertionError("deferred cleanup must not sleep"),
            ),
            mock.patch.object(
                sys,
                "argv",
                [
                    "retention",
                    "consent-protocol",
                    "us-central1",
                    "1",
                    "--project",
                    "uat",
                    "--apply",
                    "--healthy",
                    "--defer-state",
                    str(directory / "state.json"),
                    "--release-run-id",
                    "123",
                ],
            ),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(MODULE.main(), 0)
        return mutations

    def test_deferred_deletion_survives_later_invocations_without_sleeping(self):
        state = service(
            {"revisionName": revision(3)["metadata"]["name"], "percent": 100},
            {"revisionName": revision(1)["metadata"]["name"], "tag": "old"},
        )
        state["spec"]["template"]["spec"]["timeoutSeconds"] = 3600
        revisions = [revision(n) for n in range(1, 4)]
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            first = self.run_deferred(state, revisions, directory, 10000)
            self.assertEqual(
                [args[:2] for args in first], [["services", "update-traffic"]]
            )
            saved = json.loads((directory / "state.json").read_text())
            self.assertEqual(saved["not_before"], 13660)
            self.assertEqual(self.run_deferred(state, revisions, directory, 13659), [])
            last = self.run_deferred(state, revisions, directory, 13660)
            self.assertEqual(
                last, [["revisions", "delete", revision(1)["metadata"]["name"]]]
            )
            self.assertFalse((directory / "state.json").exists())

    def test_changed_generation_or_service_identity_restarts_drain_even_with_same_traffic(
        self,
    ):
        for field, value in (("generation", 3), ("uid", "recreated-service")):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temporary:
                directory = pathlib.Path(temporary)
                state = service(
                    {"revisionName": revision(3)["metadata"]["name"], "percent": 100}
                )
                revisions = [revision(n) for n in range(1, 4)]
                self.run_deferred(state, revisions, directory, 10000)
                state["metadata"][field] = value
                self.assertEqual(
                    self.run_deferred(state, revisions, directory, 11000), []
                )
                self.assertEqual(
                    json.loads((directory / "state.json").read_text())["observed_at"],
                    11000,
                )

    def test_deferred_plan_cannot_expand_to_unobserved_revisions(self):
        state = service(
            {"revisionName": revision(3)["metadata"]["name"], "percent": 100}
        )
        revisions = [revision(n) for n in range(1, 4)]
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            self.run_deferred(state, revisions, directory, 10000)
            revisions.append(revision(0))
            self.assertEqual(self.run_deferred(state, revisions, directory, 11000), [])

    def test_latest_ready_revision_is_kept_even_if_older_than_retention_count(self):
        state = service(
            {"revisionName": revision(3)["metadata"]["name"], "percent": 100}
        )
        state["status"]["latestReadyRevisionName"] = revision(1)["metadata"]["name"]
        self.assertFalse(
            MODULE.plan_cleanup(
                state, [revision(n) for n in range(1, 4)], 1, set()
            ).delete_revisions
        )

    def test_preserves_serving_rollback_candidate_and_last_known_good(self):
        old, good, candidate, rollback, serving = (
            revision(n)["metadata"]["name"] for n in range(1, 6)
        )
        state = service(
            {"revisionName": serving, "percent": 100},
            {"revisionName": old, "percent": 0, "tag": "old-tag"},
            {"revisionName": candidate, "percent": 0, "tag": "candidate"},
        )
        plan = MODULE.plan_cleanup(
            state, [revision(n) for n in range(1, 6)], 1, {good, rollback, candidate}
        )
        self.assertEqual(plan.remove_tags, ("candidate", "old-tag"))
        self.assertEqual(plan.delete_revisions, (old,))
        self.assertTrue({serving, rollback, candidate, good}.issubset(plan.protected))

    def test_exact_rollback_anchor_counts_toward_retention_after_failed_candidate(self):
        rollback, failed, serving = (
            revision(n)["metadata"]["name"] for n in range(1, 4)
        )
        state = service({"revisionName": serving, "percent": 100})
        state["status"]["latestReadyRevisionName"] = serving
        state["status"]["latestCreatedRevisionName"] = serving
        revisions = [revision(n) for n in range(1, 4)]
        anchored = MODULE.plan_cleanup(state, revisions, 2, {rollback})
        self.assertEqual(anchored.protected, frozenset({rollback, serving}))
        self.assertEqual(anchored.delete_revisions, (failed,))
        # Without an explicit rollback, retain the newest fallback instead.
        unanchored = MODULE.plan_cleanup(state, revisions, 2, set())
        self.assertTrue({failed, serving}.issubset(unanchored.protected))

    def test_refuses_ambiguous_traffic_and_missing_protected_revision(self):
        state = service(
            {"revisionName": revision(2)["metadata"]["name"], "percent": 99}
        )
        with self.assertRaises(MODULE.UnsafeState):
            MODULE.plan_cleanup(state, [revision(1), revision(2)], 1, set())
        state["status"]["traffic"][0]["percent"] = 100
        with self.assertRaises(MODULE.UnsafeState):
            MODULE.plan_cleanup(
                state, [revision(1), revision(2)], 1, {revision(3)["metadata"]["name"]}
            )

    def test_rechecks_traffic_before_mutation(self):
        expected = MODULE.traffic_fingerprint(
            service({"revisionName": revision(2)["metadata"]["name"], "percent": 100})
        )
        changed = service(
            {"revisionName": revision(1)["metadata"]["name"], "percent": 100}
        )
        with (
            mock.patch.object(MODULE, "service_state", return_value=changed),
            self.assertRaisesRegex(MODULE.UnsafeState, "traffic changed"),
        ):
            MODULE.assert_traffic(
                "consent-protocol", "project", "us-central1", expected
            )

    def test_dry_run_displays_live_timeout_floor_and_does_not_mutate(self):
        state = service(
            {"revisionName": revision(3)["metadata"]["name"], "percent": 100},
            {
                "revisionName": revision(1)["metadata"]["name"],
                "percent": 0,
                "tag": "old",
            },
        )
        state["spec"]["template"]["spec"]["timeoutSeconds"] = 3600
        output = io.StringIO()
        with (
            mock.patch.object(MODULE, "service_state", return_value=state),
            mock.patch.object(
                MODULE,
                "revision_state",
                return_value=[revision(1), revision(2), revision(3)],
            ),
            mock.patch.object(MODULE, "gcloud") as cloud,
            mock.patch.object(
                sys,
                "argv",
                ["retention", "consent-protocol", "us-central1", "1", "--dry-run"],
            ),
            contextlib.redirect_stdout(output),
        ):
            self.assertEqual(MODULE.main(), 0)
        self.assertIn("Drain before deletion: 3660s", output.getvalue())
        cloud.assert_not_called()

    def test_missing_request_timeout_fails_closed(self):
        state = service(
            {"revisionName": revision(3)["metadata"]["name"], "percent": 100}
        )
        old = revision(1)
        old["spec"].pop("timeoutSeconds")
        revisions = [old, revision(2), revision(3)]
        plan = MODULE.plan_cleanup(state, revisions, 1, set())
        with self.assertRaisesRegex(MODULE.UnsafeState, "timeout unavailable"):
            MODULE.required_drain_seconds(state, revisions, plan, 120)

    def test_tags_only_retires_tag_without_sleeping_or_deleting(self):
        current = revision(3)["metadata"]["name"]
        state = service(
            {"revisionName": current, "percent": 100},
            {
                "revisionName": revision(1)["metadata"]["name"],
                "percent": 0,
                "tag": "old",
            },
        )
        untagged = service({"revisionName": current, "percent": 100})
        state["spec"]["template"]["spec"]["timeoutSeconds"] = 3600
        with (
            mock.patch.object(
                MODULE, "service_state", side_effect=[state, state, untagged, untagged]
            ),
            mock.patch.object(
                MODULE,
                "revision_state",
                return_value=[revision(1), revision(2), revision(3)],
            ),
            mock.patch.object(MODULE, "gcloud") as cloud,
            mock.patch.object(MODULE.time, "sleep") as sleep,
            mock.patch.object(
                sys,
                "argv",
                [
                    "retention",
                    "consent-protocol",
                    "us-central1",
                    "1",
                    "--apply",
                    "--healthy",
                    "--tags-only",
                ],
            ),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(MODULE.main(), 0)
        sleep.assert_not_called()
        self.assertEqual(cloud.call_count, 1)
        self.assertEqual(
            cloud.call_args.args[0],
            ["services", "update-traffic", "consent-protocol", "--remove-tags=old"],
        )

    def test_full_cleanup_still_waits_for_maximum_request_lifetime(self):
        current = revision(3)["metadata"]["name"]
        state = service({"revisionName": current, "percent": 100})
        state["spec"]["template"]["spec"]["timeoutSeconds"] = 3600
        with (
            mock.patch.object(MODULE, "service_state", return_value=state),
            mock.patch.object(
                MODULE,
                "revision_state",
                return_value=[revision(1), revision(2), revision(3)],
            ),
            mock.patch.object(MODULE, "gcloud") as cloud,
            mock.patch.object(MODULE.time, "sleep") as sleep,
            mock.patch.object(
                sys,
                "argv",
                [
                    "retention",
                    "consent-protocol",
                    "us-central1",
                    "1",
                    "--apply",
                    "--healthy",
                ],
            ),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(MODULE.main(), 0)
        sleep.assert_called_once_with(3660)
        self.assertEqual(
            cloud.call_args.args[0],
            ["revisions", "delete", revision(1)["metadata"]["name"]],
        )


class MaintenanceAuthorityTest(unittest.TestCase):
    def test_historical_predeploy_absence_does_not_block_safe_rollback_cleanup(self):
        previous, current, known_good = (
            revision(n)["metadata"]["name"] for n in range(1, 4)
        )
        release = {
            "final": {"backend_revision": current},
            "predeploy": {"backend_revision": previous},
        }
        for present in (False, True):
            inventory = [revision(2), revision(3)] + ([revision(1)] if present else [])
            with (
                self.subTest(present=present),
                mock.patch.object(MAINTENANCE, "command", return_value=known_good),
                mock.patch.object(
                    MAINTENANCE.retention, "revision_state", return_value=inventory
                ),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                flags = MAINTENANCE.release_protection_flags(
                    "consent-protocol", "backend", release
                )
                self.assertEqual(
                    flags,
                    [
                        current,
                        "--rollback-revision",
                        previous if present else "",
                        "--last-known-good-revision",
                        known_good,
                    ],
                )
                protected = {value for value in flags[::2] if value}
                plan = MODULE.plan_cleanup(
                    service({"revisionName": current, "percent": 100}),
                    inventory,
                    2,
                    protected,
                )
                self.assertTrue({current, known_good}.issubset(plan.protected))
                self.assertEqual(plan.delete_revisions, ())
                with self.assertRaises(MODULE.UnsafeState):
                    MODULE.plan_cleanup(
                        service({"revisionName": current, "percent": 100}),
                        [revision(2)],
                        2,
                        protected,
                    )

    def trusted_source(self, run_id, workflow="deploy-uat.yml"):
        return {
            "id": run_id,
            "path": f".github/workflows/{workflow}",
            "head_branch": "main",
            "event": "workflow_dispatch",
            "actor": {"login": "ankitkumarsingh1702"},
            "status": "completed",
            "conclusion": "success",
            "repository": {"full_name": "org/repo"},
            "head_repository": {"full_name": "org/repo"},
        }

    def test_release_artifact_is_required_and_must_prove_health_and_revisions(self):
        healthy = {
            "status": "healthy",
            "final": {
                "backend_revision": revision(3)["metadata"]["name"],
                "frontend_revision": "hushh-webapp-00003-abc",
            },
        }
        for payload in (
            None,
            {**healthy, "status": "failed"},
            {"status": "healthy", "final": {}},
            healthy,
        ):
            with (
                self.subTest(payload=payload),
                tempfile.TemporaryDirectory() as temporary,
            ):

                def download(_repository, _run_id, _name, directory, payload=payload):
                    directory.mkdir(parents=True)
                    (directory / "uat-release-status.json").write_text(
                        json.dumps(payload)
                    )

                with (
                    mock.patch.object(
                        MAINTENANCE, "api", return_value=self.trusted_source(123)
                    ),
                    mock.patch.object(
                        MAINTENANCE, "artifact_exists", return_value=payload is not None
                    ),
                    mock.patch.object(
                        MAINTENANCE, "download", side_effect=download
                    ) as fetch,
                ):
                    if payload is None:
                        self.assertIsNone(
                            MAINTENANCE.find_release(
                                "org/repo", "123", pathlib.Path(temporary)
                            )
                        )
                        fetch.assert_not_called()
                    elif payload == healthy:
                        self.assertEqual(
                            MAINTENANCE.find_release(
                                "org/repo", "123", pathlib.Path(temporary)
                            ),
                            (123, healthy),
                        )
                    else:
                        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                            MAINTENANCE.find_release(
                                "org/repo", "123", pathlib.Path(temporary)
                            )

    def test_source_is_authorized_before_any_cloud_access(self):
        cases = (
            ("uat", "ankitkumarsingh1702", "", "deploy-uat.yml", "org/repo", True),
            ("uat", "unapproved-actor", "", "deploy-uat.yml", "org/repo", False),
            (
                "production",
                "kushaltrivedi5",
                "123",
                "deploy-production.yml",
                "org/repo",
                True,
            ),
            (
                "production",
                "Roopmann30",
                "123",
                "deploy-production.yml",
                "org/repo",
                False,
            ),
            ("production", "kushaltrivedi5", "123", "untrusted.yml", "org/repo", False),
            (
                "production",
                "kushaltrivedi5",
                "123",
                "deploy-production.yml",
                "fork/repo",
                False,
            ),
        )
        for environment, actor, requested, workflow, repository, allowed in cases:
            with (
                self.subTest(
                    environment=environment,
                    actor=actor,
                    workflow=workflow,
                    repository=repository,
                ),
                tempfile.TemporaryDirectory() as temporary,
            ):
                directory = pathlib.Path(temporary)
                output = directory / "output"
                run = {
                    **self.trusted_source(123, workflow),
                    "actor": {"login": actor},
                    "head_repository": {"full_name": repository},
                }

                def download(_repository, _run_id, _name, target):
                    target.mkdir(parents=True)
                    prefix = "prod" if environment == "production" else "uat"
                    (target / f"{prefix}-release-status.json").write_text(
                        json.dumps(
                            {
                                "status": "healthy",
                                "final": {
                                    "backend_revision": revision(3)["metadata"]["name"],
                                    "frontend_revision": "hushh-webapp-00003-abc",
                                },
                            }
                        )
                    )

                for artifact_available in (True, False) if allowed else (True,):
                    with (
                        self.subTest(artifact_available=artifact_available),
                        mock.patch.dict(
                            "os.environ",
                            {
                                "GITHUB_REPOSITORY": "org/repo",
                                "GITHUB_OUTPUT": str(output),
                            },
                        ),
                        mock.patch.object(
                            sys,
                            "argv",
                            [
                                "maintenance",
                                "--environment",
                                environment,
                                "--release-run-id",
                                requested,
                                "--verify-source-only",
                                "--state-dir",
                                str(directory / "state"),
                            ],
                        ),
                        mock.patch.object(
                            MAINTENANCE,
                            "api",
                            return_value=run if requested else {"workflow_runs": [run]},
                        ),
                        mock.patch.object(
                            MAINTENANCE,
                            "artifact_exists",
                            return_value=artifact_available,
                        ),
                        mock.patch.object(
                            MAINTENANCE, "download", side_effect=download
                        ),
                        mock.patch.object(
                            MAINTENANCE.retention,
                            "service_state",
                            side_effect=AssertionError(
                                "source verification must not access cloud"
                            ),
                        ),
                        mock.patch.object(
                            MAINTENANCE.subprocess,
                            "run",
                            side_effect=AssertionError(
                                "source verification must not mutate"
                            ),
                        ),
                    ):
                        if output.exists():
                            output.unlink()
                        if not allowed:
                            with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                                MAINTENANCE.main()
                            self.assertFalse(output.exists())
                        else:
                            self.assertEqual(MAINTENANCE.main(), 0)
                            self.assertEqual(
                                output.read_text(),
                                f"cleanup_ready={str(artifact_available).lower()}\n",
                            )

    def test_schedule_finds_older_healthy_release_matching_rollback(self):
        def download(_repository, run_id, _name, directory):
            directory.mkdir(parents=True)
            (directory / "uat-release-status.json").write_text(
                json.dumps(
                    {
                        "status": "healthy",
                        "final": {
                            "backend_revision": revision(run_id)["metadata"]["name"],
                            "frontend_revision": f"hushh-webapp-{run_id:05d}-abc",
                        },
                    }
                )
            )

        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.object(
                MAINTENANCE,
                "api",
                return_value={
                    "workflow_runs": [self.trusted_source(3), self.trusted_source(2)]
                },
            ),
            mock.patch.object(MAINTENANCE, "artifact_exists", return_value=True),
            mock.patch.object(MAINTENANCE, "download", side_effect=download),
            mock.patch.object(
                MAINTENANCE, "live_release_matches", side_effect=[False, True]
            ),
        ):
            self.assertEqual(
                MAINTENANCE.find_release("org/repo", "", pathlib.Path(temporary))[0], 2
            )

    def test_state_restoration_rejects_untrusted_runs_and_stops_at_empty_latest_pass(
        self,
    ):
        good = self.trusted_source(10, "capacity-maintenance.yml")
        runs = [
            {**good, "id": 15, "path": ".github/workflows/untrusted.yml"},
            {**good, "id": 14, "conclusion": "failure"},
            {**good, "id": 13, "head_repository": {"full_name": "fork/repo"}},
            {**good, "id": 12, "head_branch": "feature"},
            good,
            {**good, "id": 9},
        ]
        for has_state in (True, False):
            with (
                self.subTest(has_state=has_state),
                tempfile.TemporaryDirectory() as temporary,
            ):

                def download(
                    _repository, run_id, _name, directory, has_state=has_state
                ):
                    self.assertEqual(run_id, 10)
                    (directory / "README.txt").write_text("completed pass")
                    if has_state:
                        (directory / "consent-protocol.json").write_text(
                            '{"observed_at": 1000}'
                        )

                with (
                    mock.patch.object(
                        MAINTENANCE,
                        "api",
                        side_effect=lambda _repo, endpoint: (
                            {
                                "artifacts": [
                                    {
                                        "name": MAINTENANCE.STATE_ARTIFACT,
                                        "expired": False,
                                        "workflow_run": {"id": run["id"]},
                                    }
                                    for run in runs
                                ]
                            }
                            if endpoint.startswith("artifacts?")
                            else next(
                                run for run in runs if endpoint == f"runs/{run['id']}"
                            )
                        ),
                    ),
                    mock.patch.object(
                        MAINTENANCE, "download", side_effect=download
                    ) as fetch,
                ):
                    destination = pathlib.Path(temporary)
                    MAINTENANCE.restore_state("org/repo", destination)
                    fetch.assert_called_once_with(
                        "org/repo", 10, MAINTENANCE.STATE_ARTIFACT, mock.ANY
                    )
                    self.assertEqual(fetch.call_count, 1)
                    self.assertEqual(
                        (destination / "consent-protocol.json").exists(), has_state
                    )

    def test_wrong_source_run_never_downloads_release_artifacts(self):
        good = {
            "id": 123,
            "path": ".github/workflows/deploy-uat.yml",
            "head_branch": "main",
            "event": "workflow_dispatch",
            "status": "completed",
            "conclusion": "success",
            "repository": {"full_name": "org/repo"},
            "head_repository": {"full_name": "org/repo"},
        }
        self.assertTrue(MAINTENANCE.trusted_run(good, "org/repo", "deploy-uat.yml"))
        for field, value in (
            ("path", ".github/workflows/untrusted.yml"),
            ("head_branch", "feature"),
            ("status", "in_progress"),
            ("conclusion", "failure"),
            ("event", "pull_request"),
            ("repository", {"full_name": "another/repo"}),
            ("head_repository", {"full_name": "fork/repo"}),
        ):
            with (
                self.subTest(field=field),
                mock.patch.object(
                    MAINTENANCE, "api", return_value={**good, field: value}
                ),
                mock.patch.object(MAINTENANCE, "download") as download,
            ):
                with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                    MAINTENANCE.find_release("org/repo", "123", pathlib.Path("unused"))
                download.assert_not_called()

    def test_noop_or_superseded_release_never_runs_cleanup_or_replaces_drain_state(
        self,
    ):
        for release in (None, (123, {"status": "healthy"})):
            with (
                self.subTest(release=release),
                tempfile.TemporaryDirectory() as temporary,
            ):
                state_dir = pathlib.Path(temporary)
                with (
                    mock.patch.dict("os.environ", {"GITHUB_REPOSITORY": "org/repo"}),
                    mock.patch.object(
                        sys,
                        "argv",
                        ["maintenance", "--state-dir", str(state_dir), "--apply"],
                    ),
                    mock.patch.object(
                        MAINTENANCE, "find_release", return_value=release
                    ),
                    mock.patch.object(
                        MAINTENANCE, "live_release_matches", return_value=False
                    ),
                    mock.patch.object(MAINTENANCE, "restore_state") as restore,
                    mock.patch.object(MAINTENANCE.subprocess, "run") as run,
                    contextlib.redirect_stdout(io.StringIO()),
                ):
                    self.assertEqual(MAINTENANCE.main(), 0)
                    restore.assert_not_called()
                    run.assert_not_called()
                    self.assertEqual(list(state_dir.iterdir()), [])

    def test_release_workflow_cannot_reintroduce_inline_retention(self):
        root = SCRIPT.parents[2]

        def assert_separate(workflow, label):
            for command in workflow.replace("\\\n", "").splitlines():
                if "bash scripts/ci/cloudrun-retention.sh" in command:
                    self.assertIn("--tags-only", command)
            self.assertIn(
                f"Fail workflow when {label} release did not end healthy", workflow
            )

        for file, label in (
            ("deploy-uat.yml", "UAT"),
            ("deploy-production.yml", "production"),
        ):
            with self.subTest(environment=label):
                source = (root / ".github/workflows" / file).read_text()
                assert_separate(source, label)
                with self.assertRaises(AssertionError):
                    assert_separate(source.replace("--tags-only", ""), label)

    def test_production_release_rejects_uat_source_and_uat_only_actor(self):
        good = {
            **self.trusted_source(123, "deploy-production.yml"),
            "actor": {"login": "kushaltrivedi5"},
        }
        healthy = {
            "status": "healthy",
            "final": {
                "backend_revision": revision(3)["metadata"]["name"],
                "frontend_revision": "hushh-webapp-00003-abc",
            },
        }
        for run in (
            self.trusted_source(123),
            {**good, "actor": {"login": "Roopmann30"}},
            good,
        ):
            with self.subTest(run=run), tempfile.TemporaryDirectory() as temporary:

                def download(_repo, _run, name, directory):
                    self.assertEqual(name, "prod-release-123")
                    directory.mkdir(parents=True)
                    (directory / "prod-release-status.json").write_text(
                        json.dumps(healthy)
                    )

                with (
                    mock.patch.object(MAINTENANCE, "api", return_value=run),
                    mock.patch.object(
                        MAINTENANCE, "artifact_exists", return_value=True
                    ),
                    mock.patch.object(
                        MAINTENANCE, "download", side_effect=download
                    ) as fetch,
                ):
                    if run != good:
                        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                            MAINTENANCE.find_release(
                                "org/repo",
                                "123",
                                pathlib.Path(temporary),
                                environment="production",
                            )
                        fetch.assert_not_called()
                    else:
                        self.assertEqual(
                            MAINTENANCE.find_release(
                                "org/repo",
                                "123",
                                pathlib.Path(temporary),
                                environment="production",
                            ),
                            (123, healthy),
                        )

    def test_production_live_check_and_rollback_stay_in_production(self):
        release = {
            "final": {
                "backend_revision": "consent-protocol-00003-abc",
                "frontend_revision": "hushh-webapp-00003-abc",
            }
        }

        def state(name, project, region):
            self.assertEqual((project, region), ("hushh-pda", "us-central1"))
            self.assertIn(name, {"consent-protocol", "hushh-webapp"})
            lane = "backend" if name == "consent-protocol" else "frontend"
            return {
                "status": {
                    "conditions": [{"type": "Ready", "status": "True"}],
                    "traffic": [
                        {
                            "revisionName": release["final"][lane + "_revision"],
                            "percent": 100,
                        }
                    ],
                }
            }

        with mock.patch.object(
            MAINTENANCE.retention, "service_state", side_effect=state
        ) as reads:
            self.assertTrue(
                MAINTENANCE.live_release_matches(release, environment="production")
            )
            self.assertEqual(reads.call_count, 2)
        with mock.patch.object(
            MAINTENANCE, "command", return_value="consent-protocol-00002-abc"
        ) as command:
            flags = MAINTENANCE.release_protection_flags(
                "consent-protocol", "backend", release, environment="production"
            )
            command.assert_called_once_with(
                "bash", "scripts/ci/resolve-rollback-target.sh", "production", "backend"
            )
            self.assertEqual(flags[-1], "consent-protocol-00002-abc")

    def test_production_schedule_skips_settled_or_not_due_but_retries_missing_receipts(
        self,
    ):
        receipt = {
            "schema_version": 1,
            "environment": "production",
            "project": "hushh-pda",
            "observed_run_id": 10,
            "release_run_id": 9,
        }
        pending = {
            "project": "hushh-pda",
            "region": "us-central1",
            "service": "consent-protocol",
            "release_run_id": "9",
            "not_before": 13660,
        }
        cases = [
            (receipt, None, 10, False),
            (receipt, pending, 10, False),
            (receipt, {**pending, "not_before": 10000}, 10, True),
            (None, None, 10, True),
            (receipt, None, 11, True),
            ({**receipt, "project": "hushh-pda-uat"}, None, 10, "unsafe"),
            (receipt, {**pending, "project": "hushh-pda-uat"}, 10, "unsafe"),
        ]
        for completed, state, observed, expected in cases:
            with (
                self.subTest(case=(completed, state, observed)),
                tempfile.TemporaryDirectory() as temporary,
            ):
                directory = pathlib.Path(temporary)
                if completed is not None:
                    (directory / "completed.json").write_text(json.dumps(completed))
                if state is not None:
                    (directory / "consent-protocol.json").write_text(json.dumps(state))
                with (
                    mock.patch.object(
                        MAINTENANCE, "latest_deploy_observation", return_value=observed
                    ),
                    mock.patch.object(MAINTENANCE, "restore_state") as restore,
                    mock.patch.object(MAINTENANCE.time, "time", return_value=10000),
                    mock.patch.object(
                        MAINTENANCE.retention,
                        "service_state",
                        side_effect=AssertionError("source-only cannot read cloud"),
                    ),
                ):
                    if expected == "unsafe":
                        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                            MAINTENANCE.production_maintenance_due(
                                "org/repo", directory
                            )
                    else:
                        self.assertEqual(
                            MAINTENANCE.production_maintenance_due(
                                "org/repo", directory
                            ),
                            expected,
                        )
                    restore.assert_called_once_with(
                        "org/repo", directory, environment="production"
                    )

    def test_production_pass_defers_only_its_services_and_commits_completion_last(self):
        release = {"status": "healthy"}
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            with (
                mock.patch.dict("os.environ", {"GITHUB_REPOSITORY": "org/repo"}),
                mock.patch.object(
                    sys,
                    "argv",
                    [
                        "maintenance",
                        "--environment",
                        "production",
                        "--state-dir",
                        str(directory),
                        "--apply",
                    ],
                ),
                mock.patch.object(
                    MAINTENANCE, "find_release", return_value=(123, release)
                ),
                mock.patch.object(
                    MAINTENANCE, "live_release_matches", return_value=True
                ),
                mock.patch.object(MAINTENANCE, "restore_state") as restore,
                mock.patch.object(
                    MAINTENANCE, "release_protection_flags", return_value=["protected"]
                ),
                mock.patch.object(
                    MAINTENANCE, "latest_deploy_observation", return_value=123
                ),
                mock.patch.object(MAINTENANCE.subprocess, "run") as run,
            ):
                self.assertEqual(MAINTENANCE.main(), 0)
                restore.assert_called_once_with(
                    "org/repo", directory, environment="production"
                )
                self.assertEqual(run.call_count, 2)
                for call in run.call_args_list:
                    command = call.args[0]
                    self.assertIn(command[2], {"consent-protocol", "hushh-webapp"})
                    self.assertIn("--defer-state", command)
                    self.assertEqual(command[-2:], ["--project", "hushh-pda"])
                self.assertEqual(
                    json.loads((directory / "completed.json").read_text())[
                        "release_run_id"
                    ],
                    123,
                )
                (directory / "completed.json").unlink()
                run.side_effect = RuntimeError("provider read failed")
                with self.assertRaises(RuntimeError):
                    MAINTENANCE.main()
                self.assertFalse((directory / "completed.json").exists())


if __name__ == "__main__":
    unittest.main()

"""Safety contracts for Cloud Run revision cleanup."""

import contextlib
import copy
import importlib
import importlib.util
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from test_release_artifact_receipts import (
    ReplayedProductionReleaseArtifactTest as ReplayedProductionReleaseArtifactTest,
    ReplayedUatReleaseArtifactTest as ReplayedUatReleaseArtifactTest,
    ProductionStagedWorkerCases as ProductionStagedWorkerCases,
    ProductionHealthyStagedWorkerCases as ProductionHealthyStagedWorkerCases,
)
from test_production_operational_retention import OperationalRetentionCases as OperationalRetentionCases
from test_production_operational_retention import PendingRetirementCases as PendingRetirementCases

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
    def test_production_release_change_still_resets_drain_clock(self):
        fingerprint = ((('consent-protocol-00003-abc', 100, ''),), '[]', 7, 'uid')
        plan = MODULE.Plan(
            serving=frozenset({'consent-protocol-00003-abc'}),
            protected=frozenset({'consent-protocol-00003-abc'}),
            remove_tags=(),
            delete_revisions=('consent-protocol-00001-abc',),
        )
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary) / 'consent-protocol.json'
            for now, run_id in ((10000, '123'), (11000, '124')):
                with mock.patch.object(MODULE.time, 'time', return_value=now):
                    self.assertFalse(MODULE.deferred_drain_ready(
                        state, service='consent-protocol', project='hushh-pda',
                        region='us-central1', expected=fingerprint, plan=plan,
                        drain_seconds=3660, release_run_id=run_id,
                    ))
            self.assertEqual(json.loads(state.read_text())['observed_at'], 11000)

    def test_production_protected_set_change_still_resets_drain_clock(self):
        fingerprint = ((('consent-protocol-00003-abc', 100, ''),), '[]', 7, 'uid')
        plan = MODULE.Plan(
            serving=frozenset({'consent-protocol-00003-abc'}),
            protected=frozenset({'consent-protocol-00003-abc'}),
            remove_tags=(),
            delete_revisions=('consent-protocol-00001-abc',),
        )
        widened = MODULE.Plan(
            plan.serving, plan.protected | {'consent-protocol-00002-abc'},
            (), plan.delete_revisions,
        )
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary) / 'consent-protocol.json'
            for now, current in ((10000, plan), (11000, widened)):
                with mock.patch.object(MODULE.time, 'time', return_value=now):
                    self.assertFalse(MODULE.deferred_drain_ready(
                        state, service='consent-protocol', project='hushh-pda',
                        region='us-central1', expected=fingerprint, plan=current,
                        drain_seconds=3660, release_run_id='123',
                    ))
            self.assertEqual(json.loads(state.read_text())['observed_at'], 11000)

    def test_cross_release_uat_artifact_carries_only_matching_service_clock(self):
        first = {
            'schema_version': 1, 'service': 'consent-protocol',
            'project': 'hushh-pda-uat', 'region': 'us-central1',
            'release_run_id': '124', 'fingerprint': [['rev', 100], '[]', 7, 'uid'],
            'protected': ['rev'], 'revisions': ['old'],
            'observed_at': 11000, 'not_before': 14660,
        }
        earlier = {**first, 'release_run_id': '123',
                   'observed_at': 10000, 'not_before': 13660}
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            current = directory / 'current.json'
            older = directory / 'older.json'
            current.write_text(json.dumps(first))
            older.write_text(json.dumps(earlier))
            self.assertTrue(MAINTENANCE.carry_earlier_uat_clock(current, older))
            carried = json.loads(current.read_text())
            self.assertEqual(carried['release_run_id'], '124')
            self.assertEqual(carried['observed_at'], 10000)
            self.assertEqual(carried['not_before'], 13660)
            for reason, change in (
                ('generation', {'fingerprint': [['rev', 100], '[]', 8, 'uid']}),
                ('protected', {'protected': ['rev', 'rollback']}),
                ('expanded_deletions', {'revisions': ['old', 'new']}),
                # Only the helper carries a per-revision clock, against live
                # Cloud Run.
                ('revision_clocks', {'clocks': {}}),
            ):
                with self.subTest(reason=reason):
                    current.write_text(json.dumps({**first, **change}))
                    self.assertFalse(MAINTENANCE.carry_earlier_uat_clock(current, older))
                    self.assertEqual(json.loads(current.read_text())['observed_at'], 11000)

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
            self.assertEqual(saved["observed_at"], 10000)
            self.assertEqual(saved["not_before"], 13660)
            self.assertEqual(self.run_deferred(state, revisions, directory, 13659), [])
            inherited = json.loads((directory / "state.json").read_text())
            self.assertEqual(inherited["observed_at"], 10000)
            self.assertEqual(inherited["not_before"], 13660)
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
    def production_cleanup_failure(self):
        run = {
            **self.trusted_source(123, "deploy-production.yml"),
            "actor": {"login": "kushaltrivedi5"},
            "conclusion": "failure",
        }
        steps = [
            {"name": name, "status": "completed", "conclusion": "success"}
            for name in MAINTENANCE.REQUIRED_PRODUCTION_STEPS
        ]
        steps.append(
            {
                "name": MAINTENANCE.POST_RELEASE_CLEANUP_STEP,
                "status": "completed",
                "conclusion": "failure",
            }
        )
        jobs = {
            "total_count": 1,
            "jobs": [
                {
                    "name": "Deploy Production Scope",
                    "status": "completed",
                    "conclusion": "failure",
                    "steps": steps,
                }
            ],
        }
        release = {
            "status": "healthy",
            "scope": "all",
            "sha": "a" * 40,
            "final": {
                "backend_revision": "consent-protocol-00003-abc",
                "frontend_revision": "hushh-webapp-00003-abc",
            },
            "verification": {
                name: "success"
                for name in (
                    "runtime_parity",
                    "connected_systems",
                    "backend_provenance",
                    "frontend_provenance",
                    "backend_health",
                    "frontend_health",
                    "passkey_domain_associations",
                    "account_deletion_activation",
                )
            },
            "classification": {
                name: "false"
                for name in (
                    "release_failed",
                    "promote_failed",
                    "backend_provenance_failed",
                    "frontend_provenance_failed",
                )
            },
            "rollback": {
                "backend": "skipped",
                "frontend": "skipped",
                "drive_jobs": "skipped",
            },
        }
        release["verification"]["account_deletion_activated"] = "true"
        return run, jobs, release

    def uat_hygiene_failure(self):
        # UAT has a successful target-selection job and a failed deployment job.
        # The dispatched SHA may be older than the workflow run's main HEAD.
        run = {
            **self.trusted_source(204),
            "conclusion": "failure",
            "head_sha": "c" * 40,
        }
        steps = [
            {"name": name, "status": "completed", "conclusion": "success"}
            for name in MAINTENANCE.REQUIRED_UAT_HYGIENE_STEPS
        ]
        steps += [
            {"name": name, "status": "completed", "conclusion": "skipped"}
            for name in (
                "Roll back backend revision",
                "Roll back frontend revision",
                "Restore backend after Drive worker failure",
                "Restore frontend after Drive worker failure",
                "Verify Drive scheduler after worker failure",
            )
        ]
        steps.append(
            {
                "name": MAINTENANCE.UAT_POST_RELEASE_CLEANUP_STEP,
                "status": "completed",
                "conclusion": "failure",
            }
        )
        jobs = {
            "total_count": 2,
            "jobs": [
                {
                    "name": "Select UAT target",
                    "status": "completed",
                    "conclusion": "success",
                    "steps": [
                        {
                            "name": "Resolve deployment SHA",
                            "status": "completed",
                            "conclusion": "success",
                        }
                    ],
                },
                {
                    "name": "Deploy UAT Scope",
                    "status": "completed",
                    "conclusion": "failure",
                    "steps": steps,
                },
            ],
        }
        sha = "a" * 40
        release = {
            "status": "healthy",
            "scope": "all",
            "sha": sha,
            "predeploy": {
                "backend_revision": "consent-protocol-02112-fol",
                "frontend_revision": "hushh-webapp-01689-sh7",
            },
            "current": {
                "backend_candidate_revision": "consent-protocol-02115-faq",
                "backend_revision": "consent-protocol-02115-faq",
                "frontend_candidate_revision": "hushh-webapp-01693-5vh",
                "frontend_revision": "hushh-webapp-01693-5vh",
            },
            "final": {
                "backend_revision": "consent-protocol-02115-faq",
                "backend_sha": sha,
                "frontend_revision": "hushh-webapp-01693-5vh",
                "frontend_sha": sha,
            },
            "verification": {
                "blocking_classifications": "",
                "parity_success": "true",
                "backend_provenance": "success",
                "frontend_provenance": "success",
                "provenance_success": "true",
                "semantic_success": "true",
                "db_contract": "success",
                "account_deletion_activation": "success",
                "account_deletion_activated": "true",
                "drive_worker": "success",
                "drive_worker_backend_rollback": "skipped",
                "drive_worker_frontend_rollback": "skipped",
                "drive_worker_scheduler_rollback": "skipped",
            },
            "rollback_targets": {
                "backend_revision": "consent-protocol-02112-fol",
                "frontend_revision": "hushh-webapp-01689-sh7",
                "drive_worker_failure_rollback_complete": True,
            },
        }
        return run, jobs, release

    def test_uat_hygiene_only_failure_requires_complete_release_proof(self):
        original_run, original_jobs, original_release = self.uat_hygiene_failure()
        defects = (
            None,
            "current_three_jobs",
            "failed_capacity_observer",
            "extra_failed_step",
            "missing_gate",
            "partial_jobs",
            "failed_selection",
            "scoped_artifact",
            "malformed_sha",
            "wrong_final_sha",
            "incomplete_worker_rollback",
            "worker_not_healthy",
            "rollback_executed",
            "wrong_actor",
        )
        for defect in defects:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temporary:
                run, jobs, release = copy.deepcopy(
                    (original_run, original_jobs, original_release)
                )
                deploy_steps = jobs["jobs"][1]["steps"]
                if defect in {"current_three_jobs", "failed_capacity_observer"}:
                    jobs["total_count"] = 3
                    jobs["jobs"].append({
                        "name": "Wait for UAT capacity outside the mutation lock",
                        "status": "completed",
                        "conclusion": "failure" if defect == "failed_capacity_observer" else "success",
                    })
                elif defect == "extra_failed_step":
                    deploy_steps.append(
                        {
                            "name": "Unexpected release failure",
                            "status": "completed",
                            "conclusion": "failure",
                        }
                    )
                elif defect == "missing_gate":
                    deploy_steps.pop(0)
                elif defect == "partial_jobs":
                    jobs["total_count"] = 3
                elif defect == "failed_selection":
                    jobs["jobs"][0]["conclusion"] = "failure"
                elif defect == "scoped_artifact":
                    release["scope"] = "frontend"
                elif defect == "malformed_sha":
                    release["sha"] = "mutable-tag"
                elif defect == "wrong_final_sha":
                    release["final"]["backend_sha"] = "b" * 40
                elif defect == "incomplete_worker_rollback":
                    release["rollback_targets"]["drive_worker_failure_rollback_complete"] = False
                elif defect == "worker_not_healthy":
                    release["verification"]["drive_worker"] = "skipped"
                elif defect == "rollback_executed":
                    next(
                        step
                        for step in deploy_steps
                        if step["name"] == "Roll back backend revision"
                    )["conclusion"] = "success"
                elif defect == "wrong_actor":
                    run["actor"] = {"login": "outside-policy-user"}

                def download(_repo, _run, _name, directory):
                    directory.mkdir(parents=True)
                    (directory / "uat-release-status.json").write_text(
                        json.dumps(release)
                    )

                with (
                    mock.patch.object(
                        MAINTENANCE,
                        "api",
                        side_effect=lambda _repo, endpoint: (
                            jobs if "/jobs?" in endpoint else run
                        ),
                    ),
                    mock.patch.object(
                        MAINTENANCE, "artifact_exists", return_value=True
                    ),
                    mock.patch.object(MAINTENANCE, "download", side_effect=download),
                    mock.patch.object(
                        MAINTENANCE.retention,
                        "service_state",
                        side_effect=AssertionError(
                            "source validation cannot access cloud"
                        ),
                    ),
                ):
                    if defect in {None, "current_three_jobs"}:
                        found = MAINTENANCE.find_release(
                            "org/repo", "204", pathlib.Path(temporary), require_live=False
                        )
                        self.assertEqual(found[0], 204)
                        self.assertEqual(found[1]["_maintenance_source_run"], 204)
                        self.assertNotEqual(run["head_sha"], found[1]["sha"])
                    else:
                        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                            MAINTENANCE.find_release(
                                "org/repo", "204", pathlib.Path(temporary), require_live=False
                            )

    def test_prior_backend_owner_accepts_only_verified_hygiene_failure(self):
        hygiene_run, jobs, hygiene = self.uat_hygiene_failure()
        older_run, _failed_run, older, _partial = self.partial_uat_fixture()
        older["final"]["backend_revision"] = "consent-protocol-02112-fol"
        artifacts = {204: hygiene, 200: older}

        def api(_repo, endpoint):
            if "/jobs?" in endpoint:
                return jobs
            if "deploy-uat-one-chat.yml" in endpoint:
                return {"workflow_runs": []}
            return {"workflow_runs": [hygiene_run, older_run]}

        with (
            mock.patch.object(MAINTENANCE, "api", side_effect=api),
            mock.patch.object(
                MAINTENANCE,
                "load_release",
                side_effect=lambda _repo, run_id, _directory, _environment: artifacts[run_id],
            ),
            mock.patch.object(
                MAINTENANCE.retention,
                "service_state",
                side_effect=AssertionError("historical source validation must stay cloud-free"),
            ),
        ):
            run_id, release = MAINTENANCE.prior_healthy_uat_backend_release(
                "org/repo", {"id": 205}, pathlib.Path("/tmp")
            )
            self.assertEqual(run_id, 204)
            self.assertIs(release, hygiene)

            bad_jobs = copy.deepcopy(jobs)
            bad_jobs["jobs"][1]["steps"].append(
                {"name": "Unexpected release failure", "status": "completed", "conclusion": "failure"}
            )
            jobs.clear()
            jobs.update(bad_jobs)
            run_id, release = MAINTENANCE.prior_healthy_uat_backend_release(
                "org/repo", {"id": 205}, pathlib.Path("/tmp")
            )
            self.assertEqual(run_id, 200)
            self.assertIs(release, older)

    def test_prior_frontend_owner_accepts_only_verified_hygiene_failure(self):
        hygiene_run, jobs, hygiene = self.uat_hygiene_failure()
        older_run, _failed_run, older, _partial = self.partial_uat_fixture()
        cancelled_run = {**self.trusted_source(205), "conclusion": "cancelled"}
        artifacts = {204: hygiene, 200: older}

        def api(_repo, endpoint):
            if "/jobs?" in endpoint:
                return jobs
            return {"workflow_runs": [cancelled_run, hygiene_run, older_run]}

        with (
            mock.patch.object(MAINTENANCE, "api", side_effect=api),
            mock.patch.object(
                MAINTENANCE,
                "load_release",
                side_effect=lambda _repo, run_id, _directory, _environment: artifacts[run_id],
            ),
            mock.patch.object(
                MAINTENANCE.retention,
                "service_state",
                side_effect=AssertionError("historical source validation must stay cloud-free"),
            ),
        ):
            run_id, release = MAINTENANCE.prior_healthy_uat_release(
                "org/repo", {"id": 206}, pathlib.Path("/tmp"), frontend_owner=True
            )
            self.assertEqual(run_id, 204)
            self.assertIs(release, hygiene)

            bad_jobs = copy.deepcopy(jobs)
            bad_jobs["jobs"][1]["steps"].append(
                {"name": "Unexpected release failure", "status": "completed", "conclusion": "failure"}
            )
            jobs.clear()
            jobs.update(bad_jobs)
            run_id, release = MAINTENANCE.prior_healthy_uat_release(
                "org/repo", {"id": 206}, pathlib.Path("/tmp"), frontend_owner=True
            )
            self.assertEqual(run_id, 200)
            self.assertIs(release, older)

    def test_cleanup_only_failure_requires_complete_release_proof_before_cloud_auth(
        self,
    ):
        artifact = {"name": "prod-release-123", "expired": False}
        for artifacts, total, allowed in (
            ([artifact], 1, True),
            ([artifact, artifact], 2, False),
            ([artifact], 2, False),
            ([{**artifact, "expired": True}], 1, False),
        ):
            with (
                self.subTest(artifacts=artifacts, total=total),
                mock.patch.object(
                    MAINTENANCE,
                    "api",
                    return_value={"artifacts": artifacts, "total_count": total},
                ),
            ):
                if allowed:
                    self.assertTrue(
                        MAINTENANCE.artifact_exists("org/repo", 123, "prod-release-123")
                    )
                else:
                    with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                        MAINTENANCE.artifact_exists("org/repo", 123, "prod-release-123")
        original_run, original_jobs, original_release = (
            self.production_cleanup_failure()
        )
        for defect in (
            None,
            "health_step",
            "missing_gate",
            "partial_jobs",
            "artifact_health",
            "artifact_sha",
            "wrong_actor",
            "fork",
            "uat",
        ):
            with (
                self.subTest(defect=defect),
                tempfile.TemporaryDirectory() as temporary,
            ):
                run, jobs, release = copy.deepcopy(
                    (original_run, original_jobs, original_release)
                )
                if defect == "health_step":
                    jobs["jobs"][0]["steps"][6]["conclusion"] = "failure"
                elif defect == "missing_gate":
                    jobs["jobs"][0]["steps"].pop(0)
                elif defect == "partial_jobs":
                    jobs["total_count"] = 2
                elif defect == "artifact_health":
                    release["verification"]["backend_health"] = "failure"
                elif defect == "artifact_sha":
                    release["sha"] = "mutable-tag"
                elif defect == "wrong_actor":
                    run["actor"] = {"login": "Roopmann30"}
                elif defect == "fork":
                    run["head_repository"] = {"full_name": "fork/repo"}
                elif defect == "uat":
                    run["path"] = ".github/workflows/deploy-uat.yml"

                def download(_repo, _run, _name, directory):
                    directory.mkdir(parents=True)
                    (directory / "prod-release-status.json").write_text(
                        json.dumps(release)
                    )

                with (
                    mock.patch.object(
                        MAINTENANCE,
                        "api",
                        side_effect=lambda _repo, endpoint: (
                            jobs if "/jobs?" in endpoint else run
                        ),
                    ),
                    mock.patch.object(
                        MAINTENANCE, "artifact_exists", return_value=True
                    ),
                    mock.patch.object(MAINTENANCE, "download", side_effect=download),
                    mock.patch.object(
                        MAINTENANCE.retention,
                        "service_state",
                        side_effect=AssertionError(
                            "source validation cannot access cloud"
                        ),
                    ),
                ):
                    if defect is None:
                        found = MAINTENANCE.find_release(
                            "org/repo",
                            "123",
                            pathlib.Path(temporary),
                            environment="production",
                            require_live=False,
                        )
                        self.assertEqual(found[1]["_maintenance_source_run"], 123)
                        self.assertFalse(
                            MAINTENANCE.trusted_run(
                                run, "org/repo", "capacity-maintenance.yml"
                            )
                        )
                    else:
                        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                            MAINTENANCE.find_release(
                                "org/repo",
                                "123",
                                pathlib.Path(temporary),
                                environment="production",
                                require_live=False,
                            )

    def test_cleanup_failure_live_proof_rejects_stale_provenance_and_mutable_images(
        self,
    ):
        _, _, release = self.production_cleanup_failure()
        release["_maintenance_source_run"] = 123
        for defect in (
            None,
            "sha",
            "run",
            "env",
            "image",
            "not_ready",
            "partial_traffic",
        ):
            with self.subTest(defect=defect):

                def state(name, _project, _region):
                    lane = "backend" if name == "consent-protocol" else "frontend"
                    return {
                        "status": {
                            "conditions": [{"type": "Ready", "status": "True"}],
                            "traffic": [
                                {
                                    "revisionName": release["final"][
                                        lane + "_revision"
                                    ],
                                    "percent": 50
                                    if defect == "partial_traffic"
                                    else 100,
                                }
                            ],
                        }
                    }

                def revisions(name, _project, _region):
                    lane = "backend" if name == "consent-protocol" else "frontend"
                    return [
                        {
                            "metadata": {
                                "name": release["final"][lane + "_revision"],
                                "labels": {
                                    "deploy-sha": "b" * 40
                                    if defect == "sha"
                                    else release["sha"],
                                    "github-run-id": "999"
                                    if defect == "run"
                                    else "123",
                                },
                            },
                            "spec": {
                                "containers": [
                                    {
                                        "image": "gcr.io/project/app:latest"
                                        if defect == "image"
                                        else "gcr.io/project/app@sha256:" + "c" * 64,
                                        "env": [
                                            {
                                                "name": "HUSHH_DEPLOY_SHA",
                                                "value": "b" * 40
                                                if defect == "env"
                                                else release["sha"],
                                            }
                                        ],
                                    }
                                ]
                            },
                            "status": {
                                "conditions": [
                                    {
                                        "type": "Ready",
                                        "status": "False"
                                        if defect == "not_ready"
                                        else "True",
                                    }
                                ]
                            },
                        }
                    ]

                with (
                    mock.patch.object(
                        MAINTENANCE.retention, "service_state", side_effect=state
                    ),
                    mock.patch.object(
                        MAINTENANCE.retention, "revision_state", side_effect=revisions
                    ),
                ):
                    if defect == "partial_traffic":
                        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                            MAINTENANCE.live_release_matches(
                                release, environment="production"
                            )
                        continue
                    self.assertEqual(
                        MAINTENANCE.live_release_matches(
                            release, environment="production"
                        ),
                        defect is None,
                    )

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
                mock.patch.object(
                    MAINTENANCE.retention,
                    "run_command",
                    return_value=mock.Mock(returncode=0),
                ),
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

    def test_frontend_only_release_keeps_verified_backend_rollback_anchor(self):
        backend = "consent-protocol-02142-poh"
        rollback = "consent-protocol-02137-beq"
        owner_sha = "c" * 40
        frontend_sha = "d" * 40
        owner = {
            "status": "healthy",
            "scope": "all",
            "sha": owner_sha,
            "predeploy": {"backend_revision": rollback},
            "final": {"backend_revision": backend, "backend_sha": owner_sha},
        }
        release = {
            "status": "healthy",
            "scope": "frontend",
            "sha": frontend_sha,
            "predeploy": {"backend_revision": backend},
            "current": {
                "backend_candidate_revision": "",
                "backend_revision": backend,
            },
            "final": {
                "backend_revision": backend,
                "backend_sha": owner_sha,
                "frontend_sha": frontend_sha,
            },
            "verification": {
                "frontend_provenance": "success",
                "parity_success": "true",
                "semantic_success": "true",
                "blocking_classifications": "",
            },
        }
        with mock.patch.object(
            MAINTENANCE, "prior_healthy_uat_backend_release", return_value=(200, owner)
        ):
            MAINTENANCE.prove_frontend_inherited_backend(
                "org/repo", {"id": 300}, release, pathlib.Path("/tmp")
            )
        self.assertEqual(release["_maintenance_backend_rollback_revision"], rollback)
        self.assertEqual(
            release["_maintenance_lane_provenance"],
            {
                "backend": {"run_id": 200, "sha": owner_sha},
                "frontend": {"run_id": 300, "sha": frontend_sha},
            },
        )
        with (
            mock.patch.object(
                MAINTENANCE.retention,
                "run_command",
                return_value=mock.Mock(returncode=0),
            ),
            mock.patch.object(MAINTENANCE, "command", return_value=backend),
            mock.patch.object(
                MAINTENANCE.retention,
                "revision_state",
                return_value=[
                    {"metadata": {"name": backend}},
                    {"metadata": {"name": rollback}},
                ],
            ),
        ):
            flags = MAINTENANCE.release_protection_flags(
                "consent-protocol", "backend", release
            )
        self.assertEqual(flags[0], backend)
        self.assertEqual(flags[2], rollback)
        self.assertEqual(flags[4], backend)

        for defect in ("backend_changed", "owner_sha_changed", "candidate_created"):
            with self.subTest(defect=defect):
                bad = copy.deepcopy(release)
                bad.pop("_maintenance_lane_provenance")
                bad.pop("_maintenance_backend_rollback_revision")
                if defect == "backend_changed":
                    bad["current"]["backend_revision"] = rollback
                elif defect == "owner_sha_changed":
                    bad["final"]["backend_sha"] = frontend_sha
                else:
                    bad["current"]["backend_candidate_revision"] = rollback
                with mock.patch.object(
                    MAINTENANCE,
                    "prior_healthy_uat_backend_release",
                    return_value=(200, owner),
                ):
                    with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                        MAINTENANCE.prove_frontend_inherited_backend(
                            "org/repo", {"id": 300}, bad, pathlib.Path("/tmp")
                        )

    def test_frontend_only_source_resolution_inherits_backend_owner(self):
        backend = "consent-protocol-02142-poh"
        rollback = "consent-protocol-02137-beq"
        frontend = "hushh-webapp-01732-abc"
        owner_sha = "c" * 40
        frontend_sha = "d" * 40
        owner = {
            "status": "healthy", "scope": "all", "sha": owner_sha,
            "predeploy": {"backend_revision": rollback},
            "final": {"backend_revision": backend, "backend_sha": owner_sha},
        }
        source = {
            "status": "healthy", "scope": "frontend", "sha": frontend_sha,
            "predeploy": {"backend_revision": backend},
            "current": {
                "backend_candidate_revision": "", "backend_revision": backend,
            },
            "final": {
                "backend_revision": backend, "backend_sha": owner_sha,
                "frontend_revision": frontend, "frontend_sha": frontend_sha,
            },
            "verification": {
                "frontend_provenance": "success", "parity_success": "true",
                "semantic_success": "true", "blocking_classifications": "",
            },
        }
        with (
            mock.patch.object(MAINTENANCE, "api", return_value=self.trusted_source(300)),
            mock.patch.object(MAINTENANCE, "load_release", return_value=source),
            mock.patch.object(
                MAINTENANCE, "prior_healthy_uat_backend_release", return_value=(200, owner)
            ),
        ):
            found = MAINTENANCE.find_release(
                "org/repo", "300", pathlib.Path("/tmp"), require_live=False
            )
        self.assertEqual(found[0], 300)
        self.assertEqual(found[1]["_maintenance_backend_rollback_revision"], rollback)
        self.assertEqual(
            found[1]["_maintenance_lane_provenance"],
            {
                "backend": {"run_id": 200, "sha": owner_sha},
                "frontend": {"run_id": 300, "sha": frontend_sha},
            },
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

    def partial_uat_fixture(self):
        previous_sha = "a" * 40
        candidate_sha = "b" * 40
        previous_run = {**self.trusted_source(200), "head_sha": previous_sha}
        failed_run = {
            **self.trusted_source(202),
            "conclusion": "failure",
            "head_sha": candidate_sha,
        }
        previous = {
            "status": "healthy",
            "scope": "all",
            "sha": previous_sha,
            "verification": {
                "backend_provenance": "success",
                "frontend_provenance": "success",
                "parity_success": "true",
                "semantic_success": "true",
                "blocking_classifications": "",
            },
            "final": {
                "backend_revision": "consent-protocol-02115-faq",
                "backend_sha": previous_sha,
                "frontend_revision": "hushh-webapp-01693-5vh",
                "frontend_sha": previous_sha,
            },
        }
        partial = {
            "status": "rolled_back",
            "scope": "all",
            "sha": candidate_sha,
            "predeploy": {
                "backend_revision": "consent-protocol-02115-faq",
                "frontend_revision": "hushh-webapp-01693-5vh",
            },
            "current": {
                "backend_candidate_revision": "consent-protocol-02118-yed",
                "backend_revision": "consent-protocol-02118-yed",
                "frontend_candidate_revision": "hushh-webapp-01697-rv7",
            },
            "final": {
                "backend_revision": "consent-protocol-02118-yed",
                "backend_sha": candidate_sha,
                "frontend_revision": "hushh-webapp-01693-5vh",
                "frontend_sha": previous_sha,
            },
            "rollback_targets": {
                "backend_revision": "consent-protocol-02115-faq",
                "frontend_revision": "hushh-webapp-01693-5vh",
            },
            "verification": {
                "blocking_classifications": "passkey_domain_association_failed",
                "parity_success": "true",
                "backend_provenance": "success",
                "frontend_provenance": "success",
                "provenance_success": "true",
                "semantic_success": "true",
                "db_contract": "success",
            },
        }
        return previous_run, failed_run, previous, partial

    def test_partial_replay_accepts_prior_healthy_frontend_only_release(self):
        previous_run, failed_run, previous, partial = self.partial_uat_fixture()
        # workflow_dispatch's head SHA is the current main ref; the artifact
        # records the exact older SHA selected by the deployment input.
        previous_run["head_sha"] = "d" * 40
        failed_run["head_sha"] = "e" * 40
        previous["scope"] = "frontend"
        previous["final"]["backend_sha"] = "c" * 40
        backend_run = {**self.trusted_source(199), "head_sha": "f" * 40}
        backend = copy.deepcopy(previous)
        backend["scope"] = "backend"
        backend["sha"] = "c" * 40
        backend["final"]["backend_sha"] = "c" * 40
        with (
            mock.patch.object(
                MAINTENANCE, "api", return_value={"workflow_runs": [previous_run, backend_run]}
            ),
            mock.patch.object(
                MAINTENANCE,
                "load_release",
                side_effect=lambda _repo, run_id, _directory, _environment: {
                    200: previous,
                    199: backend,
                }[run_id],
            ),
        ):
            MAINTENANCE.verify_uat_partial_failure(
                "org/repo", failed_run, partial, pathlib.Path("/tmp")
            )
        self.assertEqual(
            partial["_maintenance_lane_provenance"],
            {
                "backend": {"run_id": 202, "sha": "b" * 40},
                "frontend": {"run_id": 200, "sha": "a" * 40},
            },
        )

    def test_partial_after_standard_backend_only_uses_separate_lane_owners(self):
        frontend_run, failed_run, frontend, partial = self.partial_uat_fixture()
        backend_run = self.trusted_source(201)
        backend = copy.deepcopy(frontend)
        backend["scope"] = "backend"
        backend["sha"] = "c" * 40
        backend["final"]["backend_revision"] = "consent-protocol-02117-mid"
        backend["final"]["backend_sha"] = backend["sha"]
        partial["predeploy"]["backend_revision"] = backend["final"]["backend_revision"]
        partial["rollback_targets"]["backend_revision"] = backend["final"]["backend_revision"]

        def api(_repo, endpoint):
            if "deploy-uat-one-chat.yml" in endpoint:
                return {"workflow_runs": []}
            return {"workflow_runs": [backend_run, frontend_run]}

        with (
            mock.patch.object(MAINTENANCE, "api", side_effect=api),
            mock.patch.object(
                MAINTENANCE,
                "load_release",
                side_effect=lambda _repo, run_id, _directory, _environment: {
                    200: frontend,
                    201: backend,
                }[run_id],
            ),
        ):
            MAINTENANCE.verify_uat_partial_failure(
                "org/repo", failed_run, partial, pathlib.Path("/tmp")
            )
        self.assertEqual(partial["_maintenance_lane_provenance"]["frontend"]["run_id"], 200)

    def test_partial_after_chained_one_chat_and_frontend_release(self):
        owner_run, failed_run, owner, partial = self.partial_uat_fixture()
        owner_run["id"] = 190
        frontend_run = self.trusted_source(201)
        frontend = copy.deepcopy(owner)
        frontend["scope"] = "frontend"
        frontend["sha"] = "d" * 40
        frontend["final"]["frontend_revision"] = "hushh-webapp-01699-new"
        frontend["final"]["frontend_sha"] = frontend["sha"]
        partial["predeploy"]["frontend_revision"] = frontend["final"]["frontend_revision"]
        partial["final"]["frontend_revision"] = frontend["final"]["frontend_revision"]
        partial["final"]["frontend_sha"] = frontend["sha"]
        partial["rollback_targets"]["frontend_revision"] = frontend["final"]["frontend_revision"]
        older_one_chat = self.trusted_source(195, "deploy-uat-one-chat.yml")
        latest_one_chat = self.trusted_source(200, "deploy-uat-one-chat.yml")
        one_chat_backend = "consent-protocol-02121-new"
        partial["predeploy"]["backend_revision"] = one_chat_backend
        partial["rollback_targets"]["backend_revision"] = one_chat_backend

        def api(_repo, endpoint):
            if "deploy-uat-one-chat.yml" in endpoint:
                return {"workflow_runs": [latest_one_chat, older_one_chat]}
            return {"workflow_runs": [frontend_run, owner_run]}

        def one_chat(_repo, run, _directory):
            self.assertEqual(run["id"], 200)
            return {
                "status": "healthy",
                "scope": "backend",
                "sha": "c" * 40,
                "final": {
                    "backend_revision": one_chat_backend,
                    "backend_sha": "c" * 40,
                },
            }

        with (
            mock.patch.object(MAINTENANCE, "api", side_effect=api),
            mock.patch.object(
                MAINTENANCE,
                "load_release",
                side_effect=lambda _repo, run_id, _directory, _environment: {
                    190: owner,
                    201: frontend,
                }[run_id],
            ),
            mock.patch.object(MAINTENANCE, "load_one_chat_release", side_effect=one_chat) as load,
        ):
            MAINTENANCE.verify_uat_partial_failure(
                "org/repo", failed_run, partial, pathlib.Path("/tmp")
            )
            load.assert_called_once()
        self.assertEqual(partial["_maintenance_lane_provenance"]["frontend"]["run_id"], 201)

    def test_repeated_passkey_partials_prove_backend_lineage_through_prior_failure(self):
        owner_run, failed_run, owner, later_partial = self.partial_uat_fixture()
        owner_run["id"] = 190
        first_failed_run = {**self.trusted_source(195), "conclusion": "failure"}
        first_partial = copy.deepcopy(later_partial)
        first_partial["sha"] = "c" * 40
        first_partial["current"]["backend_candidate_revision"] = "consent-protocol-02117-mid"
        first_partial["current"]["backend_revision"] = "consent-protocol-02117-mid"
        first_partial["final"]["backend_revision"] = "consent-protocol-02117-mid"
        first_partial["final"]["backend_sha"] = first_partial["sha"]
        first_partial["current"]["frontend_candidate_revision"] = "hushh-webapp-01695-mid"

        frontend_run = self.trusted_source(200)
        frontend = copy.deepcopy(owner)
        frontend["scope"] = "frontend"
        frontend["sha"] = "d" * 40
        frontend["final"]["backend_revision"] = first_partial["final"]["backend_revision"]
        frontend["final"]["backend_sha"] = first_partial["sha"]
        frontend["final"]["frontend_revision"] = "hushh-webapp-01696-front"
        frontend["final"]["frontend_sha"] = frontend["sha"]
        later_partial["predeploy"]["backend_revision"] = first_partial["final"]["backend_revision"]
        later_partial["rollback_targets"]["backend_revision"] = first_partial["final"]["backend_revision"]
        later_partial["predeploy"]["frontend_revision"] = frontend["final"]["frontend_revision"]
        later_partial["final"]["frontend_revision"] = frontend["final"]["frontend_revision"]
        later_partial["final"]["frontend_sha"] = frontend["sha"]
        later_partial["rollback_targets"]["frontend_revision"] = frontend["final"]["frontend_revision"]
        artifacts = {190: owner, 195: first_partial, 200: frontend}

        def api(_repo, endpoint):
            if "deploy-uat-one-chat.yml" in endpoint:
                return {"workflow_runs": []}
            if "status=completed" in endpoint:
                return {"workflow_runs": [failed_run, frontend_run, first_failed_run, owner_run]}
            return {"workflow_runs": [frontend_run, owner_run]}

        with (
            mock.patch.object(MAINTENANCE, "api", side_effect=api),
            mock.patch.object(
                MAINTENANCE,
                "load_release",
                side_effect=lambda _repo, run_id, _directory, _environment: artifacts[run_id],
            ),
        ):
            MAINTENANCE.verify_uat_partial_failure(
                "org/repo", failed_run, later_partial, pathlib.Path("/tmp")
            )
            self.assertEqual(
                later_partial["_maintenance_lane_provenance"]["frontend"]["run_id"], 200
            )
            self.assertEqual(
                first_partial["_maintenance_lane_provenance"]["frontend"]["run_id"], 190
            )
            self.assertEqual(
                later_partial["_maintenance_prior_backend_provenance"],
                {"revision": "consent-protocol-02117-mid", "run_id": 195, "sha": "c" * 40},
            )
            invalid = copy.deepcopy(first_partial)
            invalid["verification"]["semantic_success"] = "false"
            artifacts[195] = invalid
            with self.assertRaisesRegex(
                MAINTENANCE.retention.UnsafeState, "passkey-only partial rollback"
            ):
                MAINTENANCE.verify_uat_partial_failure(
                    "org/repo", failed_run, copy.deepcopy(later_partial), pathlib.Path("/tmp")
                )

    def test_frontend_owner_scan_paginates_past_backend_only_runs(self):
        owner_run, _failed_run, owner, _partial = self.partial_uat_fixture()
        owner_run["id"] = 100
        backend_runs = [self.trusted_source(run_id) for run_id in range(101, 1100)]
        ordered = list(reversed(backend_runs)) + [owner_run]
        backend = copy.deepcopy(owner)
        backend["scope"] = "backend"

        def api(_repo, endpoint):
            page = int(endpoint.rsplit("page=", 1)[1])
            return {"workflow_runs": ordered[(page - 1) * 100 : page * 100]}

        with (
            mock.patch.object(MAINTENANCE, "api", side_effect=api),
            mock.patch.object(
                MAINTENANCE,
                "load_release",
                side_effect=lambda _repo, run_id, _directory, _environment: (
                    owner if run_id == 100 else backend
                ),
            ),
        ):
            run_id, release = MAINTENANCE.prior_healthy_uat_release(
                "org/repo", {"id": 1102}, pathlib.Path("/tmp"), frontend_owner=True
            )
        self.assertEqual(run_id, 100)
        self.assertIs(release, owner)

    def test_prior_frontend_only_release_requires_frontend_provenance(self):
        previous_run, _failed_run, previous, _partial = self.partial_uat_fixture()
        previous["scope"] = "frontend"
        previous["verification"]["frontend_provenance"] = "skipped"
        with (
            mock.patch.object(
                MAINTENANCE, "api", return_value={"workflow_runs": [previous_run]}
            ),
            mock.patch.object(MAINTENANCE, "load_release", return_value=previous),
            self.assertRaisesRegex(MAINTENANCE.retention.UnsafeState, "frontend health"),
        ):
            MAINTENANCE.prior_healthy_uat_release(
                "org/repo", {"id": 202}, pathlib.Path("/tmp")
            )

    def test_failed_budget_wakeup_selects_independently_verified_partial_source(self):
        previous_run, failed_run, previous, partial = self.partial_uat_fixture()
        budget_run = {**failed_run, "id": 203}
        artifacts = {200: previous, 202: partial}

        def api(_repo, endpoint):
            if "status=completed" in endpoint:
                return {"workflow_runs": [budget_run, failed_run, previous_run]}
            if "status=success" in endpoint:
                return {"workflow_runs": [previous_run]}
            raise AssertionError(endpoint)

        def download(_repo, run_id, _name, directory):
            directory.mkdir(parents=True)
            (directory / "uat-release-status.json").write_text(json.dumps(artifacts[run_id]))

        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.object(MAINTENANCE, "api", side_effect=api),
            mock.patch.object(
                MAINTENANCE, "artifact_exists", side_effect=lambda _repo, run_id, _name: run_id in artifacts
            ),
            mock.patch.object(MAINTENANCE, "download", side_effect=download),
            mock.patch.object(
                MAINTENANCE.retention,
                "service_state",
                side_effect=AssertionError("source validation cannot access cloud"),
            ),
        ):
            found = MAINTENANCE.find_release(
                "org/repo", "", pathlib.Path(temporary), require_live=False
            )
            self.assertEqual(found[0], 202)
            self.assertEqual(
                found[1]["_maintenance_lane_provenance"],
                {
                    "backend": {"run_id": 202, "sha": "b" * 40},
                    "frontend": {"run_id": 200, "sha": "a" * 40},
                },
            )

    def test_partial_source_rejects_other_failures_and_frontend_drift(self):
        previous_run, failed_run, previous, partial = self.partial_uat_fixture()
        mutations = (
            ("blocker", lambda p: p["verification"].update(blocking_classifications="db_contract_drift")),
            ("semantic", lambda p: p["verification"].update(semantic_success="false")),
            ("frontend", lambda p: p["final"].update(frontend_revision="hushh-webapp-01697-rv7")),
            ("backend", lambda p: p["final"].update(backend_sha="c" * 40)),
            ("rollback", lambda p: p["rollback_targets"].update(backend_revision="consent-protocol-02112-fol")),
        )
        for name, mutate in mutations:
            with self.subTest(name=name):
                payload = copy.deepcopy(partial)
                mutate(payload)
                with mock.patch.object(
                    MAINTENANCE,
                    "prior_healthy_uat_release",
                    return_value=(previous_run["id"], previous),
                ), mock.patch.object(
                    MAINTENANCE,
                    "prior_healthy_uat_backend_release",
                    return_value=(previous_run["id"], previous),
                ):
                    with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                        MAINTENANCE.verify_uat_partial_failure(
                            "org/repo", failed_run, payload, pathlib.Path("/tmp")
                        )

    def test_partial_source_requires_immediately_prior_healthy_artifact(self):
        previous_run, failed_run, previous, partial = self.partial_uat_fixture()
        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.object(MAINTENANCE, "api", return_value={"workflow_runs": [previous_run]}),
            mock.patch.object(MAINTENANCE, "artifact_exists", return_value=False),
        ):
            with self.assertRaisesRegex(MAINTENANCE.retention.UnsafeState, "no prior healthy"):
                MAINTENANCE.verify_uat_partial_failure(
                    "org/repo", failed_run, copy.deepcopy(partial), pathlib.Path(temporary)
                )
        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.object(
                MAINTENANCE,
                "api",
                return_value={"workflow_runs": [previous_run]},
            ),
            mock.patch.object(MAINTENANCE, "artifact_exists", return_value=True),
        ):
            def download(_repo, _run_id, _name, directory):
                directory.mkdir(parents=True)
                drifted = copy.deepcopy(previous)
                drifted["final"]["frontend_revision"] = "hushh-webapp-01692-old"
                (directory / "uat-release-status.json").write_text(json.dumps(drifted))

            with mock.patch.object(MAINTENANCE, "download", side_effect=download):
                with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                    MAINTENANCE.verify_uat_partial_failure(
                        "org/repo", failed_run, partial, pathlib.Path(temporary)
                    )

    def test_partial_live_proof_binds_each_lane_to_its_own_run(self):
        previous_run, failed_run, previous, partial = self.partial_uat_fixture()
        with mock.patch.object(
            MAINTENANCE,
            "prior_healthy_uat_release",
            return_value=(previous_run["id"], previous),
        ), mock.patch.object(
            MAINTENANCE,
            "prior_healthy_uat_backend_release",
            return_value=(previous_run["id"], previous),
        ):
            MAINTENANCE.verify_uat_partial_failure(
                "org/repo", failed_run, partial, pathlib.Path("/tmp")
            )

        for defect in (None, "backend_sha", "frontend_run", "frontend_image", "backend_traffic"):
            with self.subTest(defect=defect):
                def state(name, _project, _region):
                    lane = {
                        "consent-protocol": "backend",
                        "hushh-webapp": "frontend",
                        "consent-protocol-drive-worker": "worker",
                    }[name]
                    return {
                        "status": {
                            "conditions": [{"type": "Ready", "status": "True"}],
                            "traffic": [{
                                "revisionName": (
                                    "consent-protocol-drive-worker-00002-abc"
                                    if lane == "worker" else partial["final"][lane + "_revision"]
                                ),
                                "percent": 50 if defect == "backend_traffic" and lane == "backend" else 100,
                            }],
                        }
                    }

                def revisions(name, _project, _region):
                    lane = "backend" if name == "consent-protocol" else "frontend"
                    expected = partial["_maintenance_lane_provenance"][lane]
                    return [{
                        "metadata": {
                            "name": partial["final"][lane + "_revision"],
                            "labels": {
                                "deploy-sha": "c" * 40 if defect == "backend_sha" and lane == "backend" else expected["sha"],
                                "github-run-id": "999" if defect == "frontend_run" and lane == "frontend" else str(expected["run_id"]),
                            },
                        },
                        "spec": {"containers": [{
                            "image": "gcr.io/app:latest" if defect == "frontend_image" and lane == "frontend" else "gcr.io/app@sha256:" + "d" * 64,
                            "env": [{"name": "HUSHH_DEPLOY_SHA", "value": expected["sha"]}],
                        }]},
                        "status": {"conditions": [{"type": "Ready", "status": "True"}]},
                    }]

                with (
                    mock.patch.object(MAINTENANCE.retention, "service_state", side_effect=state),
                    mock.patch.object(MAINTENANCE.retention, "revision_state", side_effect=revisions),
                ):
                    if defect == "backend_traffic":
                        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                            MAINTENANCE.live_release_matches(partial)
                        continue
                    self.assertEqual(MAINTENANCE.live_release_matches(partial), defect is None)

    def test_historical_partial_backend_requires_live_revision_provenance(self):
        _previous_run, _failed_run, _previous, partial = self.partial_uat_fixture()
        partial["_maintenance_lane_provenance"] = {
            "backend": {"run_id": 202, "sha": "b" * 40},
            "frontend": {"run_id": 200, "sha": "a" * 40},
        }
        partial["_maintenance_prior_backend_provenance"] = {
            "revision": partial["predeploy"]["backend_revision"],
            "run_id": 195,
            "sha": "c" * 40,
        }

        def state(service, _project, _region):
            revision = (
                "consent-protocol-drive-worker-00002-abc"
                if service == "consent-protocol-drive-worker"
                else partial["final"]["backend_revision" if service == "consent-protocol" else "frontend_revision"]
            )
            return {
                "status": {
                    "conditions": [{"type": "Ready", "status": "True"}],
                    "traffic": [{"revisionName": revision, "percent": 100}],
                }
            }

        def revision(name, run_id, sha, *, source="deploy-uat"):
            return {
                "metadata": {
                    "name": name,
                    "labels": {
                        "deploy-sha": sha,
                        "github-run-id": str(run_id),
                        "deploy-source": source,
                    },
                },
                "spec": {"containers": [{
                    "image": "gcr.io/app@sha256:" + "d" * 64,
                    "env": [
                        {"name": "HUSHH_DEPLOY_SHA", "value": sha},
                        {"name": "HUSHH_DEPLOY_SOURCE", "value": source},
                    ],
                }]},
                "status": {"conditions": [{"type": "Ready", "status": "True"}]},
            }

        current = revision(partial["final"]["backend_revision"], 202, "b" * 40)
        frontend = revision(partial["final"]["frontend_revision"], 200, "a" * 40)
        historical = revision(partial["predeploy"]["backend_revision"], 195, "c" * 40)
        for defect in (None, "run", "sha", "source", "env", "image", "ready", "absent"):
            with self.subTest(defect=defect):
                older = copy.deepcopy(historical)
                if defect == "run":
                    older["metadata"]["labels"]["github-run-id"] = "999"
                elif defect == "sha":
                    older["metadata"]["labels"]["deploy-sha"] = "f" * 40
                elif defect == "source":
                    older["metadata"]["labels"]["deploy-source"] = "other"
                elif defect == "env":
                    older["spec"]["containers"][0]["env"][0]["value"] = "f" * 40
                elif defect == "image":
                    older["spec"]["containers"][0]["image"] = "gcr.io/app:latest"
                elif defect == "ready":
                    older["status"]["conditions"][0]["status"] = "False"

                def revisions(service, _project, _region, *, defect=defect, older=older):
                    if service == "hushh-webapp":
                        return [frontend]
                    return [current] + ([] if defect == "absent" else [older])

                with (
                    mock.patch.object(MAINTENANCE.retention, "service_state", side_effect=state),
                    mock.patch.object(MAINTENANCE.retention, "revision_state", side_effect=revisions),
                ):
                    self.assertEqual(
                        MAINTENANCE.live_release_matches(partial),
                        defect in {None, "absent"},
                    )

    def test_stale_uat_tag_uses_verified_rollback_anchor(self):
        current = "consent-protocol-02118-yed"
        rollback = "consent-protocol-02115-faq"
        release = {
            "final": {"backend_revision": current},
            "predeploy": {"backend_revision": rollback},
        }
        with (
            mock.patch.object(
                MAINTENANCE.retention,
                "run_command",
                return_value=mock.Mock(returncode=0),
            ),
            mock.patch.object(
                MAINTENANCE, "command", return_value="consent-protocol-01129-gom"
            ),
            mock.patch.object(
                MAINTENANCE.retention,
                "revision_state",
                return_value=[
                    {"metadata": {"name": current}},
                    {"metadata": {"name": rollback}},
                ],
            ),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(
                MAINTENANCE.release_protection_flags(
                    "consent-protocol", "backend", release
                ),
                [
                    current,
                    "--rollback-revision",
                    rollback,
                    "--last-known-good-revision",
                    rollback,
                ],
            )

    def test_missing_uat_tag_uses_verified_rollback_anchor(self):
        current = "consent-protocol-02118-yed"
        rollback = "consent-protocol-02115-faq"
        release = {
            "final": {"backend_revision": current},
            "predeploy": {"backend_revision": rollback},
        }
        with (
            mock.patch.object(
                MAINTENANCE.retention,
                "run_command",
                return_value=mock.Mock(returncode=1),
            ),
            mock.patch.object(
                MAINTENANCE,
                "command",
                side_effect=AssertionError("missing tag must not be resolved"),
            ),
            mock.patch.object(
                MAINTENANCE.retention,
                "revision_state",
                return_value=[
                    {"metadata": {"name": current}},
                    {"metadata": {"name": rollback}},
                ],
            ),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(
                MAINTENANCE.release_protection_flags(
                    "consent-protocol", "backend", release
                ),
                [
                    current,
                    "--rollback-revision",
                    rollback,
                    "--last-known-good-revision",
                    rollback,
                ],
            )

    def test_deployments_check_pending_mutations_inside_the_environment_lock(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        for filename, environment in (
            ("deploy-uat.yml", "uat"),
            ("deploy-uat-one-chat.yml", "uat"),
            ("deploy-production.yml", "production"),
        ):
            with self.subTest(workflow=filename):
                source = (root / ".github/workflows" / filename).read_text()
                deploy = source.split("  deploy:\n", 1)[1]
                self.assertIn("--check-mutations", deploy)
                self.assertIn("--environment " + environment, deploy)
                self.assertLess(
                    deploy.index("--check-mutations"),
                    deploy.index("google-github-actions/auth@"),
                )
                self.assertIn("group: deploy-" + environment, source)
                def check_actions_read(document):
                    # These authored mappings use block YAML. Keep the governance
                    # runner stdlib-only and respect job permission replacement.
                    def block(text, header):
                        lines = text.splitlines()
                        if header not in lines:
                            return None
                        start = lines.index(header) + 1
                        indent = len(header) - len(header.lstrip())
                        end = start
                        while end < len(lines):
                            line = lines[end]
                            if line.strip() and len(line) - len(line.lstrip()) <= indent:
                                break
                            end += 1
                        return "\n".join(lines[start:end])

                    job = block(document, "  deploy:")
                    self.assertIsNotNone(job)
                    permissions = block(job, "    permissions:")
                    if permissions is None:
                        permissions = block(document, "permissions:")
                    self.assertIsNotNone(permissions)
                    self.assertRegex(permissions, r"(?m)^\s+actions: read\s*$")
                    guards = [step for step in re.split(r"(?m)(?=^      - )", job)
                              if "--check-mutations" in step]
                    self.assertEqual(len(guards), 1)
                    environment = block(guards[0], "        env:")
                    self.assertIsNotNone(environment)
                    self.assertIn("          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}", environment.splitlines())

                check_actions_read(source)
                missing_read = source.replace(
                    "  deploy:\n", "  deploy:\n    permissions:\n      contents: read\n", 1
                )
                with self.assertRaises(AssertionError):
                    check_actions_read(missing_read)
                missing_token = source.replace(
                    "          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n", "", 1
                )
                with self.assertRaises(AssertionError):
                    check_actions_read(missing_token)
                wrong_token = source.replace(
                    "          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n",
                    "          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}suffix\n", 1
                )
                with self.assertRaises(AssertionError):
                    check_actions_read(wrong_token)

    def test_production_does_not_restore_older_settled_receipt_before_newer_uncertain_one(self):
        runs = {n: self.trusted_source(n, "capacity-maintenance.yml") for n in (10, 20)}
        def api(_repository, endpoint):
            if endpoint.startswith("artifacts?"):
                return {"artifacts": [{"name": "production-retention-state", "expired": False,
                    "workflow_run": {"id": n}, "created_at": f"2026-10-14T20:{n:02d}:00Z"} for n in (10, 20)]}
            return next(run for n, run in runs.items() if endpoint == f"runs/{n}")
        def download(_repository, run_id, _artifact, directory):
            (directory / "completed.json").write_text(json.dumps({
                "schema_version": 1, "checkpoint_version": 2, "environment": "production", "project": "hushh-pda",
                "release_run_id": 9, "observed_run_id": 9, "pass_status": "complete" if run_id == 10 else "unresolved",
                "pending_services": [] if run_id == 10 else ["consent-protocol"],
            }))
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(MAINTENANCE, "api", side_effect=api), mock.patch.object(MAINTENANCE, "download", side_effect=download), mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"):
            with self.assertRaisesRegex(MAINTENANCE.retention.UnsafeState, "unresolved"):
                MAINTENANCE.assert_no_pending_mutations("org/repo", pathlib.Path(temporary), "production")

    def test_finished_environment_checkpoint_fences_while_other_environment_runs(self):
        import hashlib
        from zipfile import ZipFile

        run = {
            **self.trusted_source(123, "capacity-maintenance.yml"),
            "status": "in_progress",
            "conclusion": None,
        }
        steps = [
            {
                "name": name, "conclusion": "success",
                "started_at": "2026-10-14T19:59:59Z",
                "completed_at": "2026-10-14T20:00:01Z",
            }
            for name in (
                "Checkout mutation tooling and rollback history",
                "Recheck due source under the deployment lock",
                "Authenticate to uat",
                "Save uat cleanup checkpoint",
                "Prepare or finish eligible uat revision cleanup",
            )
        ]
        jobs = {
            "total_count": 2,
            "jobs": [
                {
                    "name": "UAT bounded revision cleanup",
                    "status": "completed",
                    "conclusion": "success",
                    "steps": steps,
                },
                {
                    "name": "Production bounded revision cleanup",
                    "status": "in_progress",
                    "steps": [],
                },
            ],
        }
        stream = io.BytesIO()
        with ZipFile(stream, "w") as bundle:
            bundle.writestr("README.txt", "checkpoint")
            bundle.writestr(
                "completed.json",
                json.dumps(
                    {
                        "schema_version": 1,
                        "checkpoint_version": 2,
                        "environment": "uat",
                        "project": "hushh-pda-uat",
                        "release_run_id": 122,
                        "observed_run_id": 122,
                        "pass_status": "unresolved",
                        "pending_services": ["consent-protocol"],
                    }
                ),
            )
            bundle.writestr(
                "consent-protocol.json",
                json.dumps({"pending_mutation": {"kind": "delete"}}),
            )
        archive = stream.getvalue()
        artifact = {
            "id": 999,
            "name": MAINTENANCE.STATE_ARTIFACT,
            "expired": False,
            "created_at": "2026-10-14T20:00:00Z",
            "workflow_run": {"id": 123},
            "size_in_bytes": len(archive),
            "digest": "sha256:" + hashlib.sha256(archive).hexdigest(),
        }

        def api(_repository, endpoint):
            if endpoint.startswith("workflows/"):
                return {"workflow_runs": [run]}
            if endpoint.startswith("artifacts?"):
                return {"artifacts": [artifact]}
            if "/attempts/1/jobs?" in endpoint:
                return jobs
            if "/jobs?" in endpoint:
                if run.get("run_attempt") == 2:
                    return {"total_count": 1, "jobs": [{
                        "name": "UAT bounded revision cleanup",
                        "status": "completed", "conclusion": "failure", "steps": [],
                    }]}
                return jobs
            self.assertEqual(endpoint, "runs/123")
            return run

        for attempt in (1, 2):
            run.update(run_attempt=attempt,
                       status="in_progress" if attempt == 1 else "completed",
                       conclusion=None if attempt == 1 else "failure")
            with (
                self.subTest(attempt=attempt),
                tempfile.TemporaryDirectory() as temporary,
                mock.patch.object(MAINTENANCE, "api", side_effect=api),
                mock.patch.object(
                    MAINTENANCE.retention, "run_command",
                    return_value=subprocess.CompletedProcess([], 0, archive, b""),
                ),
            ):
                with self.assertRaisesRegex(MAINTENANCE.retention.UnsafeState, "unresolved"):
                    MAINTENANCE.assert_no_pending_mutations(
                        "org/repo", pathlib.Path(temporary), "uat"
                    )

    def test_failed_rerun_preserves_prior_attempt_checkpoint_authority(self):
        run = {**self.trusted_source(123, "capacity-maintenance.yml"), "run_attempt": 2, "conclusion": "failure"}
        artifact = {"created_at": "2026-10-14T20:00:00Z"}
        names = ("Checkout mutation tooling and rollback history", "Recheck due source under the deployment lock",
                 "Authenticate to uat", "Save uat cleanup checkpoint")
        prior = {"total_count": 1, "jobs": [{"name": "UAT bounded revision cleanup", "status": "completed", "steps": [
            {"name": name, "conclusion": "success", "started_at": "2026-10-14T19:59:59Z", "completed_at": "2026-10-14T20:00:01Z"} for name in names]}]}
        latest = {"total_count": 1, "jobs": [{"name": "UAT bounded revision cleanup", "status": "completed", "steps": []}]}
        with mock.patch.object(MAINTENANCE, "api", side_effect=[latest, prior]):
            self.assertTrue(MAINTENANCE.trusted_checkpoint_run("org/repo", run, "uat", artifact))
        with mock.patch.object(MAINTENANCE, "api", side_effect=[latest, prior]):
            self.assertFalse(MAINTENANCE.trusted_checkpoint_run("org/repo", run, "uat", {"created_at": "2026-10-14T22:00:00Z"}))

    def test_clock_pass_checkpoint_is_trusted_like_a_scheduled_pass(self):
        # A clock pass whose `next-pass` job fails still concluded its cleanup;
        # dropping that checkpoint would restart every drain clock.
        artifact = {"created_at": "2026-10-14T20:00:00Z"}
        names = ("Checkout mutation tooling and rollback history", "Recheck due source under the deployment lock",
                 "Authenticate to production", "Save production cleanup checkpoint")
        jobs = {"total_count": 1, "jobs": [{"name": "Production bounded revision cleanup", "status": "completed", "steps": [
            {"name": name, "conclusion": "success", "started_at": "2026-10-14T19:59:59Z", "completed_at": "2026-10-14T20:00:01Z"} for name in names]}]}
        for event, trusted in (("schedule", True), ("repository_dispatch", True), ("pull_request", False), ("push", False)):
            run = {**self.trusted_source(123, "capacity-maintenance.yml"), "event": event, "conclusion": "failure"}
            with self.subTest(event=event), mock.patch.object(MAINTENANCE, "api", return_value=jobs):
                self.assertIs(MAINTENANCE.trusted_checkpoint_run("org/repo", run, "production", artifact), trusted)

    def test_publication_guard_accepts_newer_checkpoint_but_rejects_missing_upload(
        self,
    ):
        run = self.trusted_source(123, "capacity-maintenance.yml")

        def inventory(saved):
            return {
                "total_count": 1,
                "jobs": [
                    {
                        "name": "UAT bounded revision cleanup",
                        "status": "completed",
                        "steps": [
                            {
                                "name": "Prepare or finish eligible uat revision cleanup",
                                "conclusion": "failure",
                            },
                            {
                                "name": "Save uat cleanup checkpoint",
                                "conclusion": saved,
                            },
                        ],
                    }
                ],
            }

        for saved in ("success", "failure"):
            with (
                self.subTest(saved=saved),
                mock.patch.object(
                    MAINTENANCE,
                    "api",
                    side_effect=[{"workflow_runs": [run]}, inventory(saved)],
                ),
                mock.patch.object(
                    MAINTENANCE, "trusted_checkpoint_run", return_value=True
                ),
            ):
                if saved == "success":
                    MAINTENANCE.assert_checkpoint_publication("org/repo", "uat")
                else:
                    with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                        MAINTENANCE.assert_checkpoint_publication("org/repo", "uat")

    def test_production_guard_skips_uat_scoped_ticks_without_fetching_jobs(self):
        # The clock sends about 13 UAT-only ticks a day. Walking each one (a jobs
        # call at about 0.5 s) pushed production's guard past its 90 s budget
        # after a week without a production cleanup.
        def tick(run_id, title):
            return {**self.trusted_source(run_id, "capacity-maintenance.yml"),
                    "event": "repository_dispatch", "display_title": title}

        checkpoint = tick(999, "Capacity Maintenance tick (production)")
        saved = {"total_count": 1, "jobs": [{"name": "Production bounded revision cleanup", "status": "completed", "steps": [
            {"name": "Prepare or finish eligible production revision cleanup", "conclusion": "success"},
            {"name": "Save production cleanup checkpoint", "conclusion": "success"}]}]}
        skipped = {"total_count": 1, "jobs": [{"name": "Production bounded revision cleanup", "status": "completed",
                                               "conclusion": "skipped", "steps": []}]}
        for title, expected_job_calls in (("Capacity Maintenance tick (uat)", 1), ("Capacity Maintenance tick", 151)):
            runs = [tick(1000 + n, title) for n in range(150)] + [checkpoint]
            job_calls = []

            def api(_repository, endpoint, runs=runs, job_calls=job_calls):
                if endpoint.startswith("workflows/capacity-maintenance.yml/runs"):
                    return {"workflow_runs": runs}
                job_calls.append(endpoint)
                return saved if endpoint.startswith("runs/999/") else skipped
            with (
                self.subTest(title=title),
                mock.patch.object(MAINTENANCE.production_phone_lease, "assert_reconciled"),
                mock.patch.object(MAINTENANCE, "api", side_effect=api),
                mock.patch.object(MAINTENANCE, "trusted_checkpoint_run", return_value=True),
            ):
                MAINTENANCE.assert_checkpoint_publication("org/repo", "production")
                # The negative control (an unscoped tick) is still walked run by run.
                self.assertEqual(len(job_calls), expected_job_calls)

    def test_maintenance_is_hourly_and_independent_of_deployments(self):
        workflows = pathlib.Path(__file__).resolve().parents[2] / ".github/workflows"
        source = (workflows / "capacity-maintenance.yml").read_text()
        clock_source = (workflows / "capacity-maintenance-clock.yml").read_text()

        def check_policy(text, clock):
            triggers = text.split("\npermissions:", 1)[0]
            # The clock is the schedule; a cron here would add unscoped passes
            # that both environments' checkpoint guards must walk.
            self.assertNotIn("schedule:", triggers)
            self.assertIn('cron: "41 * * * *"', clock.split("\npermissions:", 1)[0])
            self.assertIn("  workflow_dispatch:", triggers)
            self.assertNotIn("workflow_run:", triggers)
            self.assertNotIn("uat-drain-wait:", text)
            self.assertNotIn("uat-drain-recheck:", text)
            self.assertNotIn('sleep "$wait_seconds"', text)
            # Explicit proof inputs request inspection, never infer mutation
            # authority. Ordinary ticks retain the quiet due check.
            for line in text.splitlines():
                if "--force-inspection" in line:
                    self.assertRegex(line.strip(), r'^if \[\[ "\$CAPACITY_BRIDGE" = true(?: \|\| -n "\$\{OPERATIONAL_RUN_ID:-\}\$\{STAGED_WORKER_RUN_ID:-\}")? \]\]; then flags(?:=|\+=)\(--force-inspection(?: --production-capacity-bridge)?\); fi$')
            self.assertIn('"$OPERATIONAL_RUN_ID" =~ ^[1-9][0-9]*$ && "$OPERATIONAL_ATTEMPT" =~ ^[1-9][0-9]*$', text)
            self.assertIn('[[ "$GITHUB_EVENT_NAME" = workflow_dispatch && "$RELEASE_ENV" = production && "$APPLY" = true ]] || exit 1', text)
            concurrency = text.split("\nconcurrency:\n", 1)[1].split(
                "\npermissions:", 1
            )[0]
            self.assertIn("cancel-in-progress: false", concurrency)
            self.assertIn("github.run_id", concurrency)
            self.assertNotIn("queue: max", concurrency)
            # Ticks are the scheduled pass: no inputs, coalesced with the cron,
            # and never a deployment event.
            self.assertIn("  repository_dispatch:\n    types: [capacity-maintenance-tick, capacity-maintenance-tick-uat, capacity-maintenance-tick-production]\n", triggers)
            # A scoped tick's title is what the other environment's guard skips,
            # so the title, the verify steps and the walk must agree.
            for scope, other in (("uat", "production"), ("production", "uat")):
                title = MAINTENANCE.SCOPED_TICK_TITLES[scope]
                self.assertIn(f"github.event.action == 'capacity-maintenance-tick-{scope}' && '{title}'", text)
                verify = text.split(f"      - name: Verify due {scope} source\n", 1)[1].split("\n        env:", 1)[0]
                self.assertIn(f"capacity-maintenance-tick-{scope}'", verify)
                self.assertNotIn(f"capacity-maintenance-tick-{other}'", verify)
            self.assertIn("github.event_name == 'repository_dispatch') && 'scheduled'", concurrency)
            self.assertNotIn("client_payload", text)
            # The clock lives in its own workflow, so quiet hours add no run
            # here for the checkpoint guard to walk.
            self.assertNotIn("capacity-maintenance-clock", text.split("\njobs:\n", 1)[1])
            clock_triggers = clock.split("\npermissions:", 1)[0]
            self.assertNotIn("workflow_run:", clock_triggers)
            self.assertIn("  repository_dispatch:\n    types: [capacity-maintenance-clock]\n", clock_triggers)
            self.assertIn("cancel-in-progress: false", clock_triggers)
            wake = clock.split("\n  wake:\n", 1)[1].split("\n  next-check:\n", 1)[0]
            self.assertIn("needs.check.outputs.uat_ready == 'true' || needs.check.outputs.production_ready == 'true'", wake)
            self.assertIn('event_type="$tick"', wake)
            for tick in ("capacity-maintenance-tick\n", "capacity-maintenance-tick-uat\n", "capacity-maintenance-tick-production\n"):
                self.assertIn(f"tick={tick}", wake)
            rearm = clock.split("\n  next-check:\n", 1)[1]
            self.assertIn("      name: capacity-maintenance-clock\n      deployment: false\n", rearm)
            self.assertIn("(( elapsed < CLOCK_MIN_ELAPSED_SECONDS ))", rearm)
            for line in clock.splitlines():
                if "sleep" in line:
                    self.assertEqual(line.strip(), "sleep $((attempt * 10))")

        check_policy(source, clock_source)
        for broken, broken_clock in (
            (source.replace("  repository_dispatch:", "  workflow_run:\n  repository_dispatch:"), clock_source),
            (source.replace("on:\n", 'on:\n  schedule:\n    - cron: "17 * * * *"\n', 1), clock_source),
            (source.replace("|| github.event.action == 'capacity-maintenance-tick-production' || inputs.environment == 'production'",
                            "|| github.event.action == 'capacity-maintenance-tick-uat' || inputs.environment == 'production'"), clock_source),
            (source.replace("'Capacity Maintenance tick (uat)'", "'Capacity Maintenance (uat)'"), clock_source),
            (source + '\n  uat-drain-wait:\n    run: sleep "$wait_seconds"\n', clock_source),
            (source + '\n          flags=(--force-inspection)\n', clock_source),
            (source.replace("github.event_name == 'repository_dispatch') && 'scheduled'", "false) && 'scheduled'"), clock_source),
            (source, clock_source.replace("      name: capacity-maintenance-clock\n", "      name: uat\n")),
            (source, clock_source.replace("needs.check.outputs.uat_ready == 'true' || needs.check.outputs.production_ready == 'true'", "true")),
            (source, clock_source.replace("sleep $((attempt * 10))", "sleep 3600", 1)),
        ):
            with self.assertRaises(AssertionError):
                check_policy(broken, broken_clock)

    def test_only_the_capacity_workflows_emit_its_dispatch_events(self):
        # A deploy workflow sending a tick would re-couple maintenance to releases.
        workflows = pathlib.Path(__file__).resolve().parents[2] / ".github/workflows"
        allowed = {"capacity-maintenance.yml", "capacity-maintenance-clock.yml"}

        def check_policy(name, text):
            if name in allowed:
                return
            if name == "release-cadence.yml":
                # The downstream observer may receive the existing broadcast,
                # but cannot become another clock/tick producer or alter its wait.
                subscription = "  repository_dispatch:\n    types: [capacity-maintenance-clock]\n"
                self.assertIn(subscription, text)
                text = text.replace(subscription, "", 1)
            self.assertNotIn("capacity-maintenance-tick", text)
            self.assertNotIn("capacity-maintenance-clock", text)

        for path in sorted(workflows.glob("*.y*ml")):
            with self.subTest(workflow=path.name):
                check_policy(path.name, path.read_text())
        observer = (workflows / "release-cadence.yml").read_text()
        for broken in (observer + "\nrun: gh api dispatches -f event_type=capacity-maintenance-clock\n",
                       observer + "\nrun: gh api dispatches -f event_type=capacity-maintenance-tick\n",
                       observer.replace("types: [capacity-maintenance-clock]", "types: [capacity-maintenance-clock, another]")):
            with self.assertRaises(AssertionError):
                check_policy("release-cadence.yml", broken)
        with self.assertRaises(AssertionError):
            check_policy("deploy-uat.yml", observer)

    def test_direct_deployment_capacity_checks_have_bounded_process_groups(self):
        workflow_dir = pathlib.Path(__file__).resolve().parents[2] / ".github/workflows"
        prefix = "timeout --signal=TERM --kill-after=2s 295s "

        def check_deadlines(text):
            calls = [line for line in text.splitlines()
                     if "python3 scripts/ci/runtime-capacity-budget.py" in line]
            self.assertTrue(calls)
            for line in calls:
                self.assertIn(prefix + "python3 scripts/ci/runtime-capacity-budget.py", line)
                self.assertNotIn("--foreground", line)

        for name in ("deploy-uat.yml", "deploy-uat-one-chat.yml", "deploy-production.yml"):
            with self.subTest(workflow=name):
                source = (workflow_dir / name).read_text()
                check_deadlines(source)
                with self.assertRaises(AssertionError):
                    check_deadlines(source.replace(prefix, "", 1))

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
                        mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
                        mock.patch.object(MAINTENANCE, "restore_state"),
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
                            if environment == "uat" and not requested:
                                self.assertEqual(MAINTENANCE.main(), 0)
                                self.assertEqual(
                                    output.read_text(), "cleanup_ready=false\n"
                                )
                            else:
                                with self.assertRaises(
                                    MAINTENANCE.retention.UnsafeState
                                ):
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

    def test_auto_scan_skips_ungoverned_failed_uat_run_before_valid_release(self):
        blocked = {
            **self.trusted_source(4),
            "conclusion": "failure",
            "actor": {"login": "unapproved-actor"},
        }
        valid = self.trusted_source(3)
        release = {
            "status": "healthy",
            "final": {
                "backend_revision": "consent-protocol-00003-abc",
                "frontend_revision": "hushh-webapp-00003-abc",
            },
        }
        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.object(
                MAINTENANCE,
                "api",
                side_effect=lambda _repository, endpoint: (
                    blocked if endpoint == "runs/4" else {"workflow_runs": [blocked, valid]}
                ),
            ),
            mock.patch.object(
                MAINTENANCE, "load_release", return_value=release
            ) as load,
            mock.patch.object(
                MAINTENANCE, "live_release_matches", return_value=True
            ),
        ):
            self.assertEqual(
                MAINTENANCE.find_release("org/repo", "", pathlib.Path(temporary)),
                (3, release),
            )
            load.assert_called_once_with("org/repo", 3, mock.ANY, "uat")
            with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                MAINTENANCE.find_release("org/repo", "4", pathlib.Path(temporary))

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
                    self.assertIn(run_id, (10, 9))
                    (directory / "README.txt").write_text("completed pass")
                    (directory / "completed.json").write_text('{"schema_version": 1}')
                    if has_state:
                        (directory / "consent-protocol.json").write_text(
                            json.dumps(
                                {
                                    "observed_at": 1000 if run_id == 10 else 900,
                                    "fingerprint": [10 if run_id == 10 else 9],
                                }
                            )
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
                                        "created_at": f"2026-10-14T12:{run['id']:02d}:00Z",
                                        "workflow_run": {"id": run["id"]},
                                    }
                                    for run in runs
                                ]
                            }
                            if endpoint.startswith("artifacts?")
                            else {"total_count": 0, "jobs": []}
                            if "/jobs?" in endpoint
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
                    fetch.assert_any_call(
                        "org/repo", 10, MAINTENANCE.STATE_ARTIFACT, mock.ANY
                    )
                    self.assertEqual(fetch.call_count, 2 if has_state else 1)
                    self.assertEqual(
                        (destination / "consent-protocol.json").exists(), has_state
                    )

    def test_same_run_drain_state_is_not_replaced_by_older_completed_artifact(self):
        good = self.trusted_source(10, "capacity-maintenance.yml")
        with tempfile.TemporaryDirectory() as temporary:
            destination = pathlib.Path(temporary)
            state_file = destination / "consent-protocol.json"
            state_file.write_text('{"observed_at": 2000}')

            def api(_repository, endpoint):
                if endpoint.startswith("artifacts?"):
                    return {"artifacts": [{
                        "name": MAINTENANCE.STATE_ARTIFACT,
                        "expired": False,
                        "created_at": "2026-10-14T12:10:00Z",
                        "workflow_run": {"id": 10},
                    }]}
                return good

            def download(_repository, _run_id, _name, source):
                (source / "consent-protocol.json").write_text(
                    '{"observed_at": 1000}'
                )
                (source / "completed.json").write_text('{"schema_version": 1}')

            with (
                mock.patch.object(MAINTENANCE, "api", side_effect=api),
                mock.patch.object(MAINTENANCE, "download", side_effect=download),
            ):
                MAINTENANCE.restore_state("org/repo", destination)
            self.assertEqual(json.loads(state_file.read_text()), {"observed_at": 2000})

    def test_uat_apply_exposes_verified_source_and_latest_pending_deadline(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            output = directory / "output"
            state_dir = directory / "state"

            def run(command, **_kwargs):
                if command[2] == "consent-protocol":
                    (state_dir / "consent-protocol.json").write_text(
                        json.dumps(
                            {
                                "schema_version": 1,
                                "service": "consent-protocol",
                                "project": "hushh-pda-uat",
                                "region": "us-central1",
                                "release_run_id": "123",
                                "not_before": 13660,
                                "revisions": ["consent-protocol-00001-abc"],
                            }
                        )
                    )

            with (
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
                        "--state-dir",
                        str(state_dir),
                        "--apply",
                    ],
                ),
                mock.patch.object(
                    MAINTENANCE,
                    "find_release",
                    return_value=(123, {"status": "healthy"}),
                ),
                mock.patch.object(
                    MAINTENANCE, "live_release_matches", return_value=True
                ),
                mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
                mock.patch.object(MAINTENANCE, "restore_state"),
                mock.patch.object(
                    MAINTENANCE, "latest_deploy_observation", return_value=123
                ),
                mock.patch.object(
                    MAINTENANCE, "release_protection_flags", return_value=[]
                ),
                mock.patch.object(
                    MAINTENANCE, "run_retention", side_effect=run
                ) as cloudrun,
                mock.patch.object(MAINTENANCE.time, "time", return_value=10000),
            ):
                self.assertEqual(MAINTENANCE.main(), 0)
            self.assertEqual(
                "\n".join(
                    line
                    for line in output.read_text().splitlines()
                    if not line.startswith("checkpoint_ready=")
                )
                + "\n",
                "verified_source_run_id=123\ndrain_not_before=13660\n"
                "cleanup_outcome=applied\n",
            )
            self.assertEqual(cloudrun.call_count, 3)
            for call in cloudrun.call_args_list:
                self.assertIn("--carry-uat-clock", call.args[0])

    def test_uat_pass_judges_a_revision_clock_receipt_at_its_own_check(self):
        # Revisions keep separate deadlines, so the next one can fall due (10050)
        # while later services run (validated at 10100). The receipt is invalid
        # only if its helper left a revision due at its own check, or claims a
        # check after the validation.
        for checked_at, not_before, accepted in (
            (10000, 10050, True), (10050, 10050, False), (10200, 10250, False),
        ):
            with (
                self.subTest(checked_at=checked_at),
                tempfile.TemporaryDirectory() as temporary,
            ):
                directory = pathlib.Path(temporary)
                output, state_dir = directory / "output", directory / "state"

                def run(command, checked_at=checked_at, not_before=not_before,
                        state_dir=state_dir):
                    if command[2] == "consent-protocol":
                        (state_dir / "consent-protocol.json").write_text(json.dumps({
                            "schema_version": 1, "service": "consent-protocol",
                            "project": "hushh-pda-uat", "region": "us-central1",
                            "release_run_id": "123", "checked_at": checked_at,
                            "clocks": {}, "not_before": not_before,
                            "revisions": ["consent-protocol-00001-abc"],
                        }))

                with (
                    mock.patch.dict(
                        "os.environ",
                        {"GITHUB_REPOSITORY": "org/repo", "GITHUB_OUTPUT": str(output)},
                    ),
                    mock.patch.object(
                        sys, "argv",
                        ["maintenance", "--state-dir", str(state_dir), "--apply"],
                    ),
                    mock.patch.object(
                        MAINTENANCE, "find_release",
                        return_value=(123, {"status": "healthy"}),
                    ),
                    mock.patch.object(MAINTENANCE, "live_release_matches", return_value=True),
                    mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
                    mock.patch.object(MAINTENANCE, "restore_state"),
                    mock.patch.object(
                        MAINTENANCE, "latest_deploy_observation", return_value=123
                    ),
                    mock.patch.object(
                        MAINTENANCE, "release_protection_flags", return_value=[]
                    ),
                    mock.patch.object(MAINTENANCE, "run_retention", side_effect=run),
                    mock.patch.object(MAINTENANCE.time, "time", return_value=10100),
                ):
                    if accepted:
                        self.assertEqual(MAINTENANCE.main(), 0)
                        self.assertIn("drain_not_before=10050\n", output.read_text())
                    else:
                        with self.assertRaisesRegex(
                            MAINTENANCE.retention.UnsafeState,
                            "invalid pending UAT retention state",
                        ):
                            MAINTENANCE.main()

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
                directory = pathlib.Path(temporary)
                state_dir = directory / "state"
                state_dir.mkdir()
                output = directory / "output"
                with (
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
                        ["maintenance", "--state-dir", str(state_dir), "--apply"],
                    ),
                    mock.patch.object(
                        MAINTENANCE, "find_release", return_value=release
                    ),
                    mock.patch.object(
                        MAINTENANCE, "live_release_matches", return_value=False
                    ),
                    mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
                    mock.patch.object(MAINTENANCE, "restore_state") as restore,
                    mock.patch.object(MAINTENANCE, "run_retention") as run,
                    contextlib.redirect_stdout(io.StringIO()),
                ):
                    self.assertEqual(MAINTENANCE.main(), 0)
                    restore.assert_called_once()
                    run.assert_not_called()
                    self.assertEqual(list(state_dir.iterdir()), [])
                    self.assertEqual(
                        output.read_text(), "cleanup_outcome=no_live_source\n"
                    )

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
                    mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
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

    def test_anonymous_source_only_does_not_reschedule_settled_rollback(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            (directory / "completed.json").write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "environment": "uat",
                        "project": "hushh-pda-uat",
                        "release_run_id": 9,
                        "observed_run_id": 20,
                    }
                )
            )
            output = directory / "outputs"
            for observed, expected in [(20, False), (21, True)]:
                output.unlink(missing_ok=True)
                with (
                    mock.patch.dict(
                        "os.environ",
                        {"GITHUB_REPOSITORY": "org/repo", "GITHUB_OUTPUT": str(output)},
                    ),
                    mock.patch.object(
                        sys,
                        "argv",
                        [
                            "maintenance",
                            "--verify-source-only",
                            "--state-dir",
                            str(directory),
                        ],
                    ),
                    mock.patch.object(
                        MAINTENANCE,
                        "find_release",
                        side_effect=(
                            AssertionError("settled source must skip lineage")
                            if not expected
                            else None
                        ),
                        return_value=(19, {"status": "healthy"}),
                    ),
                    mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
                    mock.patch.object(MAINTENANCE, "restore_state"),
                    mock.patch.object(
                        MAINTENANCE, "latest_deploy_observation", return_value=observed
                    ),
                    mock.patch.object(
                        MAINTENANCE.retention,
                        "service_state",
                        side_effect=AssertionError("source-only cannot read cloud"),
                    ),
                ):
                    self.assertEqual(MAINTENANCE.main(), 0)
                    self.assertEqual(
                        output.read_text(), f"cleanup_ready={str(expected).lower()}\n"
                    )

    def test_partial_pass_keeps_progress_and_never_claims_settled(self):
        for failure, expected in (
            (MAINTENANCE.retention.BudgetExpired("deadline"), "deferred"),
            (MAINTENANCE.retention.MutationUncertain("provider"), "unresolved"),
        ):
            with (
                self.subTest(outcome=expected),
                tempfile.TemporaryDirectory() as temporary,
            ):
                directory = pathlib.Path(temporary)
                output = directory / "output"
                calls = []

                def execute(argv):
                    service = argv[2]
                    calls.append(service)
                    if len(calls) == 2:
                        raise failure
                    MODULE.atomic_state(
                        directory / (service + ".json"),
                        {
                            "schema_version": 1,
                            "service": service,
                            "project": "hushh-pda-uat",
                            "region": "us-central1",
                            "release_run_id": "123",
                            "not_before": 13660,
                            "revisions": [service + "-00001-abc"],
                        },
                    )

                with (
                    mock.patch.dict(
                        os.environ,
                        {"GITHUB_REPOSITORY": "org/repo", "GITHUB_OUTPUT": str(output)},
                    ),
                    mock.patch.object(
                        sys,
                        "argv",
                        ["maintenance", "--apply", "--state-dir", str(directory)],
                    ),
                    mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
                    mock.patch.object(MAINTENANCE, "restore_state"),
                    mock.patch.object(
                        MAINTENANCE, "maintenance_due", return_value=True
                    ),
                    mock.patch.object(
                        MAINTENANCE,
                        "find_release",
                        return_value=(123, {"status": "healthy"}),
                    ),
                    mock.patch.object(
                        MAINTENANCE, "live_release_matches", return_value=True
                    ),
                    mock.patch.object(
                        MAINTENANCE, "latest_deploy_observation", return_value=123
                    ),
                    mock.patch.object(
                        MAINTENANCE, "release_protection_flags", return_value=[]
                    ),
                    mock.patch.object(
                        MAINTENANCE, "run_retention", side_effect=execute
                    ),
                ):
                    self.assertEqual(MAINTENANCE.main(), 0)
                receipt = json.loads((directory / "completed.json").read_text())
                self.assertEqual(receipt["pass_status"], expected)
                self.assertEqual(
                    receipt["pending_services"],
                    ["hushh-webapp", "consent-protocol-drive-worker"],
                )
                self.assertEqual(
                    json.loads((directory / "consent-protocol.json").read_text())[
                        "not_before"
                    ],
                    13660,
                )
                self.assertIn("cleanup_outcome=" + expected, output.read_text())
                self.assertNotIn("cleanup_outcome=applied", output.read_text())
                with (
                    mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
                    mock.patch.object(MAINTENANCE, "restore_state"),
                ):
                    self.assertTrue(
                        MAINTENANCE.maintenance_due(
                            "org/repo", directory, environment="uat"
                        )
                    )

    def test_pending_provider_mutation_blocks_deployment_until_observed_absent(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            path = directory / "consent-protocol.json"
            state = {
                "service": "consent-protocol",
                "project": "hushh-pda-uat",
                "region": "us-central1",
                "pending_mutation": {
                    "kind": "delete",
                    "revision": revision(1)["metadata"]["name"],
                    "service_uid": "service-uid",
                },
            }
            MODULE.atomic_state(path, state)
            with (
                mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
                mock.patch.object(MAINTENANCE, "restore_state"),
            ):
                with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                    MAINTENANCE.assert_no_pending_mutations(
                        "org/repo", directory, "uat"
                    )
            with (
                mock.patch.object(
                    MODULE,
                    "service_state",
                    return_value=service(
                        {
                            "revisionName": revision(3)["metadata"]["name"],
                            "percent": 100,
                        }
                    ),
                ),
                mock.patch.object(
                    MODULE, "revision_state", return_value=[revision(1), revision(3)]
                ),
            ):
                with self.assertRaises(MODULE.MutationUncertain):
                    MODULE.reconcile_mutation(
                        path, "consent-protocol", "hushh-pda-uat", "us-central1"
                    )
            with (
                mock.patch.object(
                    MODULE,
                    "service_state",
                    return_value=service(
                        {
                            "revisionName": revision(3)["metadata"]["name"],
                            "percent": 100,
                        }
                    ),
                ),
                mock.patch.object(MODULE, "revision_state", return_value=[revision(3)]),
            ):
                MODULE.reconcile_mutation(
                    path, "consent-protocol", "hushh-pda-uat", "us-central1"
                )
            with (
                mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
                mock.patch.object(MAINTENANCE, "restore_state"),
            ):
                MAINTENANCE.assert_no_pending_mutations("org/repo", directory, "uat")

    def test_provider_timeout_preserves_intent_and_does_not_retry(self):
        from argparse import Namespace

        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "consent-protocol.json"
            args = Namespace(
                defer_state=path,
                service="consent-protocol",
                project="hushh-pda-uat",
                region="us-central1",
                release_run_id="123",
            )
            with mock.patch.object(
                MODULE, "gcloud", side_effect=MODULE.BudgetExpired("timeout")
            ) as mutate:
                with self.assertRaises(MODULE.MutationUncertain):
                    MODULE.mutate(
                        args,
                        ["revisions", "delete", revision(1)["metadata"]["name"]],
                        ((), "[]", 1, "service-uid"),
                        {"kind": "delete", "revision": revision(1)["metadata"]["name"]},
                    )
                self.assertEqual(mutate.call_count, 1)
            self.assertEqual(
                json.loads(path.read_text())["pending_mutation"]["kind"], "delete"
            )

    def test_queued_settled_pass_checks_inside_lock_before_cloud_steps(self):
        source = (
            pathlib.Path(__file__).resolve().parents[2]
            / ".github/workflows/capacity-maintenance.yml"
        ).read_text()
        gate = "steps.locked-source.outputs.cleanup_ready == 'true'"

        def assert_guarded(job):
            self.assertIn("cancel-in-progress: false", job)
            steps = re.split(r"(?m)^      - name: ", job)[1:]
            check_index = next(
                i
                for i, step in enumerate(steps)
                if "        id: locked-source\n" in step
            )
            check = steps[check_index]
            self.assertIn("--verify-source-only", check)
            self.assertIn("--release-run-id", check)
            if "--force-inspection" in check:
                self.assertIn("CAPACITY_BRIDGE: ${{ inputs.production_capacity_bridge }}", check)
                inspected = 'if [[ "$CAPACITY_BRIDGE" = true || -n "${OPERATIONAL_RUN_ID:-}${STAGED_WORKER_RUN_ID:-}" ]]; then flags=(--force-inspection); fi'
                self.assertIn(inspected, check)
                self.assertNotIn("--force-inspection", check.replace(inspected, ""))
                self.assertIn('OPERATIONAL_ATTEMPT: ${{ inputs.operational_backend_proof_attempt }}', check)
            self.assertNotIn("--apply", check)
            for i, step in enumerate(steps):
                protected = any(
                    marker in step
                    for marker in (
                        "google-github-actions/auth@",
                        "google-github-actions/setup-gcloud@",
                        "actions/upload-artifact@",
                        "runtime-capacity-budget.py",
                        "--apply",
                    )
                )
                if protected:
                    self.assertGreater(i, check_index)
                    match = re.search(r"(?m)^        if: (.+)$", step)
                    condition = match.group(1) if match else ""
                    self.assertTrue(
                        condition == gate
                        or condition.startswith(gate + " && ")
                        or condition.startswith("success() && " + gate + " && ")
                        or condition.startswith("always() && " + gate + " && "),
                        step.splitlines()[0],
                    )
                    self.assertNotIn("||", condition)

        jobs = re.split(r"(?m)^  (?:uat-maintenance|cleanup):\n", source)[1:]
        self.assertEqual(len(jobs), 2)
        for job in jobs:
            assert_guarded(job)
            # Original wiring authenticated even after a predecessor settled.
            broken = job.replace("        if: " + gate + "\n", "", 1)
            with self.assertRaises(AssertionError):
                assert_guarded(broken)
            if "--force-inspection" in job:
                broken = job.replace(
                    'if [[ "$CAPACITY_BRIDGE" = true || -n "${OPERATIONAL_RUN_ID:-}${STAGED_WORKER_RUN_ID:-}" ]]; then flags=(--force-inspection); fi',
                    'if true; then flags=(--force-inspection); fi',
                )
                with self.assertRaises(AssertionError):
                    assert_guarded(broken)

    def test_newest_artifact_is_available_without_eager_history_scan(self):
        first = {"id": 1}
        with mock.patch.object(
            MAINTENANCE,
            "api",
            side_effect=[
                {"artifacts": [first] * 100},
                AssertionError("unneeded older page"),
            ],
        ) as api:
            history = MAINTENANCE.bounded_artifacts("org/repo", "uat-retention-state")
            self.assertEqual(next(history), first)
            self.assertEqual(api.call_count, 1)

    def test_uat_due_receipt_preserves_future_drain_and_rejects_wrong_owner(self):
        receipt = {
            "schema_version": 1,
            "environment": "uat",
            "project": "hushh-pda-uat",
            "observed_run_id": 10,
            "release_run_id": 9,
        }
        pending = {
            "project": "hushh-pda-uat",
            "region": "us-central1",
            "service": "consent-protocol",
            "release_run_id": "9",
            "not_before": 13660,
        }
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            (directory / "completed.json").write_text(json.dumps(receipt))
            (directory / "consent-protocol.json").write_text(json.dumps(pending))
            with (
                mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
                mock.patch.object(MAINTENANCE, "restore_state"),
                mock.patch.object(
                    MAINTENANCE, "latest_deploy_observation", return_value=10
                ),
                mock.patch.object(MAINTENANCE.time, "time", return_value=10000),
                mock.patch.object(
                    MAINTENANCE.retention,
                    "service_state",
                    side_effect=AssertionError("not-due must not read cloud"),
                ),
            ):
                self.assertFalse(
                    MAINTENANCE.maintenance_due(
                        "org/repo", directory, environment="uat", release_run_id=9
                    )
                )
                self.assertTrue(
                    MAINTENANCE.maintenance_due(
                        "org/repo", directory, environment="uat", release_run_id=11
                    )
                )
                (directory / "consent-protocol.json").write_text(
                    json.dumps({**pending, "not_before": 10000})
                )
                self.assertTrue(
                    MAINTENANCE.maintenance_due(
                        "org/repo", directory, environment="uat"
                    )
                )
                (directory / "completed.json").write_text(
                    json.dumps({**receipt, "environment": "production"})
                )
                with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                    MAINTENANCE.maintenance_due(
                        "org/repo", directory, environment="uat"
                    )

    def test_trusted_inherited_future_receipt_stays_quiet_and_preserves_clock(self):
        receipt = {
            "schema_version": 1,
            "environment": "uat",
            "project": "hushh-pda-uat",
            "observed_run_id": 123,
            "release_run_id": 123,
        }
        deadlines = {
            "consent-protocol": 13660,
            "consent-protocol-drive-worker": 12400,
        }
        trusted = self.trusted_source(456, "capacity-maintenance.yml")

        def api(_repository, endpoint):
            if endpoint.startswith("artifacts?"):
                return {
                    "artifacts": [
                        {
                            "name": MAINTENANCE.STATE_ARTIFACT,
                            "expired": False,
                            "created_at": "2026-10-14T12:56:00Z",
                            "workflow_run": {"id": trusted["id"]},
                        }
                    ]
                }
            self.assertEqual(endpoint, f"runs/{trusted['id']}")
            return trusted

        def download(_repository, _run_id, _name, directory):
            (directory / "completed.json").write_text(json.dumps(receipt))
            for name, deadline in deadlines.items():
                (directory / f"{name}.json").write_text(
                    json.dumps(
                        {
                            "schema_version": 1,
                            "service": name,
                            "project": "hushh-pda-uat",
                            "region": "us-central1",
                            "release_run_id": "123",
                            "not_before": deadline,
                            "revisions": [f"{name}-00001-abc"],
                        }
                    )
                )

        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            for apply in (False, True):
                with self.subTest(apply=apply):
                    state_dir = root / ("apply" if apply else "source")
                    output = root / ("apply-output" if apply else "source-output")
                    with (
                        mock.patch.dict(
                            "os.environ",
                            {
                                "GITHUB_REPOSITORY": "org/repo",
                                "GITHUB_OUTPUT": str(output),
                                "GITHUB_STEP_SUMMARY": str(root / "summary"),
                            },
                        ),
                        mock.patch.object(
                            sys,
                            "argv",
                            [
                                "maintenance",
                                "--state-dir",
                                str(state_dir),
                                "--apply" if apply else "--verify-source-only",
                            ],
                        ),
                        mock.patch.object(MAINTENANCE, "api", side_effect=api),
                        mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
                        mock.patch.object(
                            MAINTENANCE, "download", side_effect=download
                        ),
                        mock.patch.object(
                            MAINTENANCE, "latest_deploy_observation", return_value=123
                        ),
                        mock.patch.object(
                            MAINTENANCE,
                            "find_release",
                            return_value=(123, {"status": "healthy"}),
                        ) as find_release,
                        mock.patch.object(
                            MAINTENANCE, "live_release_matches", return_value=True
                        ),
                        mock.patch.object(
                            MAINTENANCE, "release_protection_flags", return_value=[]
                        ),
                        mock.patch.object(MAINTENANCE, "run_retention") as run,
                        mock.patch.object(MAINTENANCE.time, "time", return_value=10000),
                    ):
                        self.assertEqual(MAINTENANCE.main(), 0)
                        find_release.assert_not_called()
                        self.assertEqual(run.call_count, 0)
                    self.assertEqual(output.read_text(), "cleanup_ready=false\n")
                    self.assertEqual(
                        json.loads((state_dir / "consent-protocol.json").read_text())[
                            "not_before"
                        ],
                        13660,
                    )

    def test_uat_pending_receipt_checks_all_services_before_waking(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            (directory / "completed.json").write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "environment": "uat",
                        "project": "hushh-pda-uat",
                        "observed_run_id": 123,
                        "release_run_id": 123,
                    }
                )
            )
            for name, project in (
                ("consent-protocol", "hushh-pda-uat"),
                ("consent-protocol-drive-worker", "different-project"),
            ):
                (directory / f"{name}.json").write_text(
                    json.dumps(
                        {
                            "service": name,
                            "project": project,
                            "region": "us-central1",
                            "release_run_id": "123",
                            "not_before": 13660,
                        }
                    )
                )
            with (
                mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
                mock.patch.object(MAINTENANCE, "restore_state"),
                mock.patch.object(
                    MAINTENANCE, "latest_deploy_observation", return_value=123
                ),
                mock.patch.object(MAINTENANCE.time, "time", return_value=10000),
            ):
                with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                    MAINTENANCE.maintenance_due(
                        "org/repo", directory, environment="uat", release_run_id=123
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
                mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
                mock.patch.object(MAINTENANCE, "restore_state") as restore,
                mock.patch.object(
                    MAINTENANCE, "release_protection_flags", return_value=["protected"]
                ),
                mock.patch.object(
                    MAINTENANCE, "latest_deploy_observation", return_value=123
                ),
                mock.patch.object(MAINTENANCE, "run_retention") as run,
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
                    self.assertNotIn("--carry-uat-clock", command)
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
                self.assertEqual(
                    json.loads((directory / "completed.json").read_text())[
                        "pass_status"
                    ],
                    "in_progress",
                )




class CommandLifecycleTest(unittest.TestCase):
    def test_permission_refusal_requires_darwin_reaped_child_and_absent_group(self):
        import process_group

        for platform, returncode, absent, force, accepted in (
            ("darwin", 0, True, True, True),
            ("darwin", 0, True, False, False),
            ("darwin", 0, False, True, False),
            ("darwin", None, True, True, False),
            ("linux", 0, True, True, False),
        ):
            with self.subTest(platform=platform, returncode=returncode, absent=absent, force=force):
                process = mock.Mock(pid=123)
                process.poll.return_value = returncode
                with (
                    mock.patch.object(process_group.sys, "platform", platform),
                    mock.patch.object(process_group.subprocess, "Popen", return_value=process),
                    mock.patch.object(process_group.os, "killpg", side_effect=PermissionError),
                    mock.patch.object(process_group, "_group_is_absent", return_value=absent, create=True),
                ):
                    if accepted:
                        with process_group.command_group(["target"]) as (_, stop):
                            stop(force=force)
                    else:
                        with self.assertRaises(PermissionError):
                            with process_group.command_group(["target"]) as (_, stop):
                                stop(force=force)

    def test_group_absence_refuses_missing_malformed_or_live_inventory(self):
        import process_group

        for code, output, absent in (
            (0, "10\n20\n", True),
            (0, "10\n123\n", False),
            (0, "", False),
            (0, "unknown", False),
            (0, "-123", False),
            (0, "+123", False),
            (0, "1_23", False),
            (0, "１２３", False),
            (1, "10\n20\n", False),
        ):
            with self.subTest(code=code, output=output):
                result = subprocess.CompletedProcess([], code, stdout=output)
                with mock.patch.object(process_group.subprocess, "run", return_value=result):
                    self.assertIs(process_group._group_is_absent(123), absent)
        with mock.patch.object(
            process_group.subprocess, "run", side_effect=subprocess.TimeoutExpired("ps", 1)
        ):
            self.assertFalse(process_group._group_is_absent(123))

    def test_cleanup_budget_reaps_a_command_and_its_descendant(self):
        import time

        started = time.monotonic()
        token = MODULE.PASS_DEADLINE.set(time.monotonic() + 0.2)
        try:
            with self.assertRaises(MODULE.BudgetExpired):
                MODULE.run_command(
                    [
                        sys.executable,
                        "-c",
                        "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); time.sleep(30)",
                    ]
                )
        finally:
            MODULE.PASS_DEADLINE.reset(token)
        self.assertLess(time.monotonic() - started, 5)

    def test_exited_command_cannot_leave_a_descendant_running(self):
        import time

        with tempfile.TemporaryDirectory() as directory:
            marker = pathlib.Path(directory) / "orphan-ran"
            child = (
                "import pathlib,time; time.sleep(1); "
                f"pathlib.Path({str(marker)!r}).write_text('leaked')"
            )
            parent = (
                "import subprocess,sys; "
                f"subprocess.Popen([sys.executable, '-c', {child!r}], "
                "stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)"
            )
            result = MODULE.run_command([sys.executable, "-c", parent], timeout=5)
            self.assertEqual(result.returncode, 0)
            time.sleep(1.5)
            self.assertFalse(marker.exists(), "Exited command left a live descendant")

    def test_failed_windows_assignment_never_releases_target_and_reaps_bootstrap(self):
        import process_group

        for close_error in (None, OSError("close failed")):
            with self.subTest(close_error=close_error):
                job = mock.Mock()
                job.assign.side_effect = OSError("assignment failed")
                job.close.side_effect = close_error
                process = mock.Mock(pid=123)
                process.poll.return_value = None
                with (
                    mock.patch.object(process_group.os, "name", "nt"),
                    mock.patch.object(process_group, "_WindowsJob", return_value=job),
                    mock.patch.object(process_group.subprocess, "Popen", return_value=process),
                    mock.patch.object(process_group.subprocess, "CREATE_NEW_PROCESS_GROUP", 512, create=True),
                    self.assertRaises(OSError),
                ):
                    with process_group.command_group(["target"]):
                        self.fail("Target must not run after assignment failure")
                process.stdin.write.assert_not_called()
                process.kill.assert_called_once_with()
                process.communicate.assert_called_once_with(timeout=5)
                job.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()

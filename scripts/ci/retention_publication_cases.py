"""Publication-barrier regression cases composed by the existing retention suite."""

import contextlib
import copy
import importlib
import io
import json
import pathlib
import sys
import tempfile
from unittest import mock

import retention_publication as publication

MAINTENANCE = importlib.import_module("uat-retention-maintenance")


class ExistingPublicationCases:
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
            return {
                **self.trusted_source(run_id, "capacity-maintenance.yml"),
                "event": "repository_dispatch",
                "display_title": title,
            }

        checkpoint = tick(999, "Capacity Maintenance tick (production)")
        saved = {
            "total_count": 1,
            "jobs": [
                {
                    "name": "Production bounded revision cleanup",
                    "status": "completed",
                    "steps": [
                        {
                            "name": "Prepare or finish eligible production revision cleanup",
                            "conclusion": "success",
                        },
                        {
                            "name": "Save production cleanup checkpoint",
                            "conclusion": "success",
                        },
                    ],
                }
            ],
        }
        skipped = {
            "total_count": 1,
            "jobs": [
                {
                    "name": "Production bounded revision cleanup",
                    "status": "completed",
                    "conclusion": "skipped",
                    "steps": [],
                }
            ],
        }
        for title, expected_job_calls in (
            ("Capacity Maintenance tick (uat)", 1),
            ("Capacity Maintenance tick", 151),
        ):
            runs = [tick(1000 + n, title) for n in range(150)] + [checkpoint]
            job_calls = []

            def api(_repository, endpoint, runs=runs, job_calls=job_calls):
                if endpoint.startswith("workflows/capacity-maintenance.yml/runs"):
                    return {"workflow_runs": runs}
                job_calls.append(endpoint)
                return saved if endpoint.startswith("runs/999/") else skipped

            with (
                self.subTest(title=title),
                mock.patch.object(
                    MAINTENANCE.production_phone_lease, "assert_reconciled"
                ),
                mock.patch.object(MAINTENANCE, "api", side_effect=api),
                mock.patch.object(
                    MAINTENANCE, "trusted_checkpoint_run", return_value=True
                ),
            ):
                MAINTENANCE.assert_checkpoint_publication("org/repo", "production")
                # The negative control (an unscoped tick) is still walked run by run.
                self.assertEqual(len(job_calls), expected_job_calls)


def legacy_fixture():
    run = {
        "id": 123,
        "run_attempt": 1,
        "path": publication.WORKFLOW,
        "head_sha": "b" * 40,
        "head_branch": "main",
        "event": "workflow_dispatch",
        "repository": {"full_name": publication.REPOSITORY},
        "head_repository": {"full_name": publication.REPOSITORY},
        "actor": {"login": "ankitkumarsingh1702"},
        "status": "completed",
        "conclusion": "failure",
    }
    steps = []
    for index, name in enumerate(publication.LEGACY_STEPS):
        steps.append(
            {
                "name": name,
                "number": index + 1,
                "status": "completed",
                "conclusion": "failure"
                if index == 6
                else ("skipped" if index == 7 else "success"),
                "started_at": f"2026-10-27T00:00:{index:02d}Z",
                "completed_at": f"2026-10-27T00:00:{index + 1:02d}Z",
            }
        )
    job = {
        "id": 456,
        "run_id": 123,
        "run_attempt": 1,
        "head_sha": run["head_sha"],
        "head_branch": "main",
        "name": "UAT bounded revision cleanup",
        "status": "completed",
        "conclusion": "failure",
        "steps": steps,
        "started_at": "2026-10-27T00:00:00Z",
        "completed_at": "2026-10-27T00:00:20Z",
    }
    lines = [
        (0, "Current runner version: '2.330.0'"),
        (1, "[command]/usr/bin/git log -1 --format=%H"),
        (1, "a" * 40),
        (6, "Hosted maintenance stopped: Drive worker is not ready"),
        (7, "##[error]Process completed with exit code 1."),
        (20, "Cleaning up orphan processes"),
    ]
    raw = "\n".join(
        f"2026-10-27T00:00:{second:02d}Z {body}" for second, body in lines
    ).encode()
    return run, job, raw


class LegacyPublicationCases:
    def test_exact_observed_runner_warning_may_follow_finalized_orphan_cleanup(self):
        run, job, raw = legacy_fixture()
        suffix = b"\n2026-10-27T00:00:20Z "
        self.proof(run, job, raw + suffix + publication.RUNNER_WARNING.encode())
        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
            self.proof(run, job, raw + suffix + b"##[warning]unknown runner outcome")

    def proof(self, run, job, raw, *, older=None, source=None, latest=None):
        published = {**run, "id": 50, "status": "completed", "conclusion": "success"}
        published_job = copy.deepcopy(job)
        for step in published_job["steps"]:
            step["conclusion"] = "success"
        calls = []

        def api(_repository, endpoint):
            calls.append(endpoint)
            if endpoint.startswith("workflows/"):
                return {"workflow_runs": [run, published]}
            if endpoint == "runs/123/attempts/1":
                return {
                    **run,
                    "run_attempt": 1,
                    "status": "completed",
                    "conclusion": "failure",
                }
            if endpoint.startswith("runs/50/"):
                jobs = [older or published_job]
            elif "attempts/1/jobs" in endpoint:
                jobs = [job]
            else:
                jobs = [latest or job]
            return {"total_count": len(jobs), "jobs": jobs}

        def command(*args):
            path = args[2].split("/contents/", 1)[1].split("?ref=", 1)[0]
            digest, size = publication.LEGACY_BLOBS[path]
            return json.dumps(source or {"sha": digest, "size": size})

        reader = importlib.import_module("verify-predecessor-acceptance")
        with (
            mock.patch.object(MAINTENANCE, "api", side_effect=api),
            mock.patch.object(
                MAINTENANCE, "command", side_effect=command
            ) as source_read,
            mock.patch.object(MAINTENANCE, "trusted_checkpoint_run", return_value=True),
            mock.patch.object(reader, "bounded_github_read", return_value=raw),
            contextlib.redirect_stdout(io.StringIO()) as output,
        ):
            MAINTENANCE.assert_checkpoint_publication(publication.REPOSITORY, "uat")
        return calls, source_read.call_args_list, output.getvalue()

    def test_frozen_precheckpoint_failure_uses_actual_checkout_and_preserves_older_boundary(
        self,
    ):
        run, job, raw = legacy_fixture()
        calls, sources, output = self.proof(run, job, raw)
        self.assertTrue(any(endpoint.startswith("runs/50/") for endpoint in calls))
        self.assertEqual(len(sources), 3)
        refs = [call.args[2] for call in sources]
        self.assertTrue(
            any("uat-retention-maintenance.py?ref=" + "a" * 40 in ref for ref in refs)
        )
        self.assertTrue(
            any("capacity-maintenance.yml?ref=" + "b" * 40 in ref for ref in refs)
        )
        marker = json.loads(output.split("maintenance_publication_proof=", 1)[1])
        self.assertEqual(
            marker,
            {
                "run_id": 123,
                "attempt": 1,
                "job_id": 456,
                "checkout_sha": "a" * 40,
                "qualification": "no_provider_mutation",
            },
        )
        self.assertNotIn("Drive worker", output)

    def test_uncertain_publication_or_runner_output_never_qualifies(self):
        for defect in (
            "cancel",
            "upload",
            "duplicate",
            "missing_step",
            "truncated",
            "file_command",
            "checkpoint",
            "unknown_source",
            "unknown_failure",
        ):
            run, job, raw = legacy_fixture()
            source = None
            if defect == "cancel":
                job["conclusion"] = "cancelled"
            elif defect == "upload":
                job["steps"][7]["conclusion"] = "failure"
            elif defect == "duplicate":
                job["steps"].append(copy.deepcopy(job["steps"][6]))
            elif defect == "missing_step":
                job["steps"].pop(8)
            elif defect == "truncated":
                raw = raw.rsplit(b"\n", 1)[0]
            elif defect == "file_command":
                raw = raw.replace(
                    b"Drive worker is not ready", b"Unable to process file command"
                )
            elif defect == "checkpoint":
                raw = raw.replace(
                    b"Drive worker is not ready", b"checkpoint_ready=true"
                )
            elif defect == "unknown_source":
                source = {"sha": "f" * 40, "size": 1}
            else:
                raw = raw.replace(b"Drive worker is not ready", b"unknown failure")
            with (
                self.subTest(defect=defect),
                self.assertRaises(MAINTENANCE.retention.UnsafeState),
            ):
                self.proof(run, job, raw, source=source)

    def test_no_effect_failure_cannot_hide_an_older_unknown_mutation(self):
        run, job, raw = legacy_fixture()
        older = copy.deepcopy(job)
        older["steps"][7]["conclusion"] = "failure"
        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
            self.proof(run, job, raw, older=older)

    def test_latest_success_or_current_rerun_does_not_clear_failed_prior_attempt(self):
        for current in (False, True):
            run, job, raw = legacy_fixture()
            run["run_attempt"] = 2
            latest = copy.deepcopy(job)
            latest.update(
                run_attempt=2, status="in_progress" if current else "completed"
            )
            for step in latest["steps"]:
                step["conclusion"] = "success"
            job["steps"][7]["conclusion"] = "failure"
            env = {
                "GITHUB_RUN_ID": "123",
                "GITHUB_RUN_ATTEMPT": "2",
                "GITHUB_REPOSITORY": publication.REPOSITORY,
                "GITHUB_JOB": "uat-maintenance",
            }
            with (
                self.subTest(current=current),
                mock.patch.dict("os.environ", env),
                self.assertRaises(MAINTENANCE.retention.UnsafeState),
            ):
                self.proof(run, job, raw, latest=latest)


class EarlyCheckpointCases:
    def test_health_failure_publishes_unfinished_checkpoint_preserving_restored_intents(
        self,
    ):
        bridge = {
            "version": 1,
            "project": "hushh-pda",
            "service": "consent-protocol",
            "status": "intent",
            "requested": True,
            "revision": "consent-protocol-cap-" + "a" * 16,
            "sourceFingerprint": "a" * 64,
            "serviceControlsFingerprint": "b" * 64,
            "sourceRevision": "consent-protocol-source",
            "displacedLatestRevision": "consent-protocol-old",
            "traffic": [],
            "pins": {
                "RUNTIME": {
                    "version": "projects/hushh-pda/secrets/runtime/versions/1",
                    "unchangedSinceSource": True,
                }
            },
        }
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary)
            output = state / "output"
            inherited = b'{"pending_mutation":{"action":"delete","revisions":["old"]}}'

            def restore(*_args, **_kwargs):
                (state / "consent-protocol.json").write_bytes(inherited)
                (state / "completed.json").write_text(
                    json.dumps({"capacity_bridge": bridge})
                )

            with (
                mock.patch.dict(
                    "os.environ",
                    {"GITHUB_REPOSITORY": "org/repo", "GITHUB_OUTPUT": str(output)},
                ),
                mock.patch.object(
                    sys, "argv", ["maintenance", "--state-dir", str(state), "--apply"]
                ),
                mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
                mock.patch.object(MAINTENANCE, "restore_state", side_effect=restore),
                mock.patch.object(MAINTENANCE, "maintenance_due", return_value=True),
                mock.patch.object(
                    MAINTENANCE,
                    "find_release",
                    return_value=(123, {"status": "healthy"}),
                ) as source,
                mock.patch.object(
                    MAINTENANCE, "latest_deploy_observation", return_value=124
                ),
                mock.patch.object(
                    MAINTENANCE,
                    "live_release_matches",
                    side_effect=MAINTENANCE.retention.UnsafeState(
                        "Drive worker is not ready"
                    ),
                ),
                mock.patch.object(MAINTENANCE, "run_retention") as mutate,
            ):
                with self.assertRaisesRegex(
                    MAINTENANCE.retention.UnsafeState, "Drive worker"
                ):
                    MAINTENANCE.main()
            self.assertIs(source.call_args.kwargs["require_live"], False)
            checkpoint = json.loads((state / "completed.json").read_text())
            self.assertEqual(checkpoint["pass_status"], "in_progress")
            self.assertEqual(checkpoint["release_run_id"], 123)
            self.assertEqual(checkpoint["observed_run_id"], 124)
            self.assertEqual(
                set(checkpoint["pending_services"]),
                set(MAINTENANCE.LANES["uat"]["services"]),
            )
            self.assertEqual(checkpoint["capacity_bridge"], bridge)
            self.assertEqual((state / "consent-protocol.json").read_bytes(), inherited)
            self.assertIn("checkpoint_ready=true", output.read_text())
            mutate.assert_not_called()

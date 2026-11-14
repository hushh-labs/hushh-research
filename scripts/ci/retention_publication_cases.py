"""Publication-barrier regression cases composed by the existing retention suite."""

import contextlib
import contextvars
import copy
import importlib
import io
import json
import threading
from unittest import mock

import retention_publication as publication
import retention_publication_source as publication_source
import retention_preflight_evidence as evidence

MAINTENANCE = importlib.import_module("uat-retention-maintenance")


class ExistingPublicationCases:
    def test_cancelled_unassigned_jobs_have_no_checkpoint_obligation(self):
        run = {"id": 42, "run_attempt": 1, "head_sha": "a" * 40, "head_branch": "main"}
        for environment in ("uat", "production"):
            for unassigned in (None, 0):
                job = {**run, "run_id": 42,
                       "name": ("UAT" if environment == "uat" else "Production") + " revision maintenance",
                       "status": "completed", "conclusion": "cancelled", "steps": [],
                       "runner_id": unassigned, "runner_group_id": unassigned,
                       "runner_name": None, "runner_group_name": None}
                with mock.patch.object(publication, "_jobs", return_value=[job]):
                    self.assertFalse(publication._attempt(MAINTENANCE, publication.REPOSITORY, run, 1, environment))
                for defect in ("assigned", "missing", "attempt", "source", "started", "failed", "boolean", "steps-missing", "attempt-type", "source-shape"):
                    broken = copy.deepcopy(job)
                    observed_run = copy.deepcopy(run)
                    if defect == "assigned":
                        broken["runner_id"] = 7
                    elif defect == "missing":
                        broken.pop("runner_id")
                    elif defect == "attempt":
                        broken["run_attempt"] = 2
                    elif defect == "source":
                        broken["head_sha"] = "b" * 40
                    elif defect == "started":
                        broken["steps"] = [{"name": "Maintenance mode: cleanup", "conclusion": "success"}]
                    elif defect == "failed":
                        broken["conclusion"] = "failure"
                    elif defect == "boolean":
                        broken["runner_id"] = False
                    elif defect == "steps-missing":
                        broken.pop("steps")
                    elif defect == "attempt-type":
                        broken["run_attempt"] = True
                    else:
                        broken["head_sha"] = observed_run["head_sha"] = "unknown"
                    with self.subTest(environment=environment, unassigned=unassigned, defect=defect), mock.patch.object(publication, "_jobs", return_value=[broken]):
                        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                            publication._attempt(MAINTENANCE, publication.REPOSITORY, observed_run, 1, environment)

    def test_missing_step_metadata_needs_independent_completed_upload(self):
        from pathlib import Path
        stamp = "2026-11-08T03:24:36Z"
        sha, digest = "a" * 40, "b" * 64
        run = {"id": 42, "run_attempt": 1, "path": publication.WORKFLOW, "head_branch": "main", "head_sha": sha, "status": "completed", "conclusion": "success",
               "event": "repository_dispatch", "display_title": "Capacity Maintenance tick (uat)",
               "actor": {"login": "github-actions[bot]", "type": "Bot", "id": 41898282},
               "repository": {"full_name": publication.REPOSITORY}, "head_repository": {"full_name": publication.REPOSITORY}}
        job = {"name": "UAT revision maintenance", "run_id": 42, "run_attempt": 1, "head_sha": sha, "status": "completed", "conclusion": "success",
               "completed_at": "2026-11-08T03:25:00Z", "steps": [
                   {"name": name, "conclusion": "success"} for name in (
                       "Checkout mutation tooling and rollback history", "Recheck due source under the deployment lock", "Authenticate to uat")
               ] + [{"name": "Save uat cleanup checkpoint", "conclusion": None}]}
        artifact = {"id": 7, "name": "uat-retention-state", "expired": False, "digest": "sha256:"+digest,
                    "created_at": "2026-11-08T03:24:30Z", "workflow_run": {"id": 42}}
        bodies = ["[command]/usr/bin/git log -1 --format=%H", sha,
                  "SHA256 digest of uploaded artifact zip is " + digest,
                  "Artifact uat-retention-state.zip successfully finalized. Artifact ID 7", "Cleaning up orphan processes"]
        log = "\n".join(stamp + " " + body for body in bodies)
        receipt = {"schema_version": 1, "environment": "uat", "project": "hushh-pda-uat",
                   "observed_run_id": 31, "release_run_id": 30, "pass_status": "complete", "pending_services": []}
        owner = mock.Mock(LANES=MAINTENANCE.LANES, SCOPED_TICK_TITLES=MAINTENANCE.SCOPED_TICK_TITLES,
                          retention=MAINTENANCE.retention)
        owner._github_timestamp.side_effect = MAINTENANCE._github_timestamp
        current = copy.deepcopy(run)
        owner.command.side_effect = lambda *args: json.dumps(current if "/actions/runs/" in args[-1] else {"status": "identical", "merge_base_commit": {"sha": sha}})
        owner.api.return_value = {"total_count": 1, "artifacts": [artifact]}
        owner.download_pending_uat_state.side_effect = lambda repo, item, directory, **kw: Path(directory, "completed.json").write_text(json.dumps(receipt))
        with mock.patch.object(publication, "_log", return_value=log):
            self.assertIsNotNone(publication.uploaded_checkpoint_proof(owner, publication.REPOSITORY, run, 1, job, "uat"))
            for conclusion in ("failure", "cancelled", "skipped"):
                with self.subTest(explicit_save=conclusion):
                    job["steps"][-1]["conclusion"] = conclusion
                    self.assertIsNone(publication.uploaded_checkpoint_proof(owner, publication.REPOSITORY, run, 1, job, "uat"))
            job["steps"][-1]["conclusion"] = None
            current.update(run_attempt=2, conclusion="failure")
            self.assertIsNone(publication.uploaded_checkpoint_proof(owner, publication.REPOSITORY, run, 1, job, "uat"))
            current.update(run_attempt=1, conclusion="success")
            for field, value in (("path", ".github/workflows/ci.yml"), ("head_branch", "uat")):
                wrong = dict(run, **{field: value})
                self.assertIsNone(publication.uploaded_checkpoint_proof(owner, publication.REPOSITORY, wrong, 1, job, "uat"))
            job["steps"][0]["conclusion"] = "failure"
            self.assertIsNone(publication.uploaded_checkpoint_proof(owner, publication.REPOSITORY, run, 1, job, "uat"))
            job["steps"][0]["conclusion"] = "success"
            artifact["digest"] = "sha256:" + "c" * 64
            self.assertIsNone(publication.uploaded_checkpoint_proof(owner, publication.REPOSITORY, run, 1, job, "uat"))
            artifact["digest"] = "sha256:" + digest
            receipt.update(pass_status="unresolved", checkpoint_version=2, pending_services=["consent-protocol"])
            self.assertIsNone(publication.uploaded_checkpoint_proof(owner, publication.REPOSITORY, run, 1, job, "uat"))

    def test_production_independent_guards_overlap_with_the_original_deadline(self):
        rendezvous = threading.Barrier(2)
        deadlines = []

        def guard(*args, **kwargs):
            deadlines.append(MAINTENANCE._LOOKUP_DEADLINE.get())
            rendezvous.wait(timeout=2)

        token = MAINTENANCE._LOOKUP_DEADLINE.set(123.0)
        try:
            with (
                mock.patch.object(MAINTENANCE.production_phone_lease, "assert_reconciled", side_effect=guard),
                mock.patch.object(publication, "assert_published", side_effect=guard),
            ):
                MAINTENANCE.assert_checkpoint_publication(publication.REPOSITORY, "production")
        finally:
            MAINTENANCE._LOOKUP_DEADLINE.reset(token)
        self.assertEqual(deadlines, [123.0, 123.0])

    def test_either_production_guard_refusal_joins_its_sibling_before_restore(self):
        for failing in ("lease", "publication"):
            with self.subTest(failing=failing):
                rendezvous = threading.Barrier(2)
                sibling_done = threading.Event()

                def guard(name):
                    rendezvous.wait(timeout=2)
                    if name == failing:
                        raise MAINTENANCE.retention.UnsafeState("synthetic authority refusal")
                    sibling_done.set()

                with (
                    mock.patch.object(MAINTENANCE.production_phone_lease, "assert_reconciled", side_effect=lambda *a, **kw: guard("lease")),
                    mock.patch.object(publication, "assert_published", side_effect=lambda *a, **kw: guard("publication")),
                    mock.patch.object(MAINTENANCE, "restore_state") as restore,
                    self.assertRaisesRegex(MAINTENANCE.retention.UnsafeState, "synthetic authority refusal"),
                ):
                    MAINTENANCE.assert_no_pending_mutations(publication.REPOSITORY, None, "production")
                self.assertTrue(sibling_done.is_set())
                restore.assert_not_called()

    @staticmethod
    def _publication_run(run_id, updated_at, *, status="completed", attempts=1, conclusion="success"):
        return {
            "id": run_id,
            "run_attempt": attempts,
            "path": publication.WORKFLOW,
            "head_sha": f"{run_id:040x}",
            "head_branch": "main",
            "event": "workflow_dispatch",
            "repository": {"full_name": publication.REPOSITORY},
            "head_repository": {"full_name": publication.REPOSITORY},
            "status": status,
            "conclusion": conclusion,
            "updated_at": updated_at,
        }

    @staticmethod
    def _publication_owner():
        owner = mock.Mock()
        owner.SCOPED_TICK_TITLES = {"uat": "uat tick", "production": "production tick"}
        owner._github_timestamp = MAINTENANCE._github_timestamp
        owner.retention = mock.Mock(UnsafeState=MAINTENANCE.retention.UnsafeState)
        return owner

    def test_exact_thousand_run_search_cap_is_not_complete_history(self):
        rows = [{"id": number} for number in range(1, 1001)]

        def api(_repository, endpoint):
            page = int(endpoint.rsplit("=", 1)[1])
            return {
                "total_count": 1000,
                "workflow_runs": rows[(page - 1) * 100 : page * 100],
            }

        with (
            mock.patch.object(MAINTENANCE, "api", side_effect=api),
            self.assertRaises(MAINTENANCE.retention.UnsafeState),
        ):
            publication._inventory(MAINTENANCE, "org/repo")

    def test_inventory_reads_remaining_pages_in_bounded_context_copied_order(self):
        request_context = contextvars.ContextVar("inventory-request-context", default=None)
        request_context.set("bounded-read")
        start_together = threading.Barrier(3)
        page_three_done = threading.Event()
        lock = threading.Lock()
        active = 0
        maximum_active = 0
        observed_contexts = []

        def response(page):
            first_id = (page - 1) * 100 + 1
            row_count = min(100, 350 - (page - 1) * 100)
            return {
                "total_count": 350,
                "workflow_runs": [
                    {"id": run_id} for run_id in range(first_id, first_id + row_count)
                ],
            }

        def api(_repository, endpoint):
            nonlocal active, maximum_active
            page = int(endpoint.rsplit("=", 1)[1])
            if page == 1:
                return response(page)
            with lock:
                active += 1
                maximum_active = max(maximum_active, active)
                observed_contexts.append(request_context.get())
            try:
                start_together.wait(timeout=2)
                if page == 2:
                    if not page_three_done.wait(timeout=2):
                        raise AssertionError("page 3 did not complete")
                if page == 3:
                    page_three_done.set()
                return response(page)
            finally:
                with lock:
                    active -= 1

        owner = self._publication_owner()
        owner.api.side_effect = api
        rows = publication._inventory(owner, "org/repo")

        self.assertEqual([row["id"] for row in rows], list(range(1, 351)))
        self.assertEqual(maximum_active, 3)
        self.assertEqual(observed_contexts, ["bounded-read"] * 3)

    def test_inventory_rejects_changed_totals_duplicate_ids_and_short_pages(self):
        def rows(page, *, duplicate=False, short=False):
            first_id = (page - 1) * 100 + 1
            row_count = min(100, 201 - (page - 1) * 100)
            if short:
                row_count -= 1
            values = list(range(first_id, first_id + row_count))
            if duplicate:
                values[0] = 1
            return [{"id": run_id} for run_id in values]

        for defect in ("changed_total", "duplicate", "short"):
            def api(_repository, endpoint, defect=defect):
                page = int(endpoint.rsplit("=", 1)[1])
                count = 202 if defect == "changed_total" and page == 2 else 201
                return {
                    "total_count": count,
                    "workflow_runs": rows(
                        page,
                        duplicate=defect == "duplicate" and page == 2,
                        short=defect == "short" and page == 2,
                    ),
                }

            owner = self._publication_owner()
            owner.api.side_effect = api
            with (
                self.subTest(defect=defect),
                self.assertRaises(MAINTENANCE.retention.UnsafeState),
            ):
                publication._inventory(owner, "org/repo")

    def test_inventory_joins_other_page_reads_after_one_page_fails(self):
        start_together = threading.Barrier(2)
        page_three_finished = threading.Event()

        def api(_repository, endpoint):
            page = int(endpoint.rsplit("=", 1)[1])
            if page == 1:
                return {
                    "total_count": 201,
                    "workflow_runs": [{"id": run_id} for run_id in range(1, 101)],
                }
            start_together.wait(timeout=2)
            if page == 2:
                raise RuntimeError("page read failed")
            page_three_finished.set()
            return {"total_count": 201, "workflow_runs": [{"id": 201}]}

        owner = self._publication_owner()
        owner.api.side_effect = api
        with self.assertRaisesRegex(RuntimeError, "page read failed"):
            publication._inventory(owner, "org/repo")
        self.assertTrue(page_three_finished.is_set())

    def test_publication_guard_accepts_newer_checkpoint_but_rejects_missing_upload(
        self,
    ):
        run = self.trusted_source(123, "capacity-maintenance.yml")
        run["updated_at"] = "2026-10-14T20:00:01Z"

        def inventory(saved):
            return {
                "total_count": 1,
                "jobs": [
                    {
                        "name": "UAT bounded revision cleanup",
                        "status": "completed",
                        "completed_at": "2026-10-14T20:00:01Z",
                        "steps": [
                            {
                                "name": "Prepare or finish eligible uat revision cleanup",
                                "conclusion": "failure",
                            },
                            {
                                "name": "Save uat cleanup checkpoint",
                                "conclusion": saved,
                                "completed_at": "2026-10-14T20:00:00Z",
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
                    side_effect=[
                        {"workflow_runs": [run], "total_count": 1},
                        inventory(saved),
                    ],
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
                "updated_at": "2026-10-14T20:01:00Z",
            }

        checkpoint = tick(999, "Capacity Maintenance tick (production)")
        saved = {
            "total_count": 1,
            "jobs": [
                {
                    "name": "Production bounded revision cleanup",
                    "status": "completed",
                    "completed_at": "2026-10-14T20:00:01Z",
                    "steps": [
                        {
                            "name": "Prepare or finish eligible production revision cleanup",
                            "conclusion": "success",
                        },
                        {
                            "name": "Save production cleanup checkpoint",
                            "conclusion": "success",
                            "completed_at": "2026-10-14T20:00:00Z",
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
                    page = int(endpoint.rsplit("=", 1)[1])
                    return {
                        "workflow_runs": runs[(page - 1) * 100 : page * 100],
                        "total_count": len(runs),
                    }
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

    def test_batched_publication_walk_preserves_boundary_order_and_deadline(self):
        deadline = contextvars.ContextVar("publication_walk_deadline", default=None)
        deadline.set("active-90-second-guard")
        lock = threading.Lock()
        active = 0
        max_active = 0
        observed_contexts = []
        calls = {}
        owner = self._publication_owner()
        runs = [
            self._publication_run(104, "2026-10-30T12:00:12Z", attempts=2, conclusion="failure"),
            self._publication_run(103, "2026-10-30T12:00:11Z", attempts=0),
            self._publication_run(102, "2026-10-30T12:00:10Z"),
            self._publication_run(101, "2026-10-30T12:00:09Z", status="in_progress"),
            self._publication_run(100, "2026-10-30T12:00:08Z"),
        ]
        published_at = owner._github_timestamp("2026-10-30T12:00:11.500Z")

        def attempt(_owner, _repository, run, number, _environment, *, proof_lines):
            nonlocal active, max_active
            run_id = run["id"]
            with lock:
                active += 1
                max_active = max(max_active, active)
                observed_contexts.append(deadline.get())
                calls.setdefault(run_id, []).append(number)
            try:
                if run_id == 104 and number == 2:
                    proof_lines.append({"run_id": run_id, "attempt": number})
                    return False
                if run_id == 104 and number == 1:
                    proof_lines.append({"run_id": run_id, "attempt": number})
                    return published_at
                if run_id == 102:
                    proof_lines.append({"run_id": run_id, "ignored": True})
                    raise MAINTENANCE.retention.UnsafeState("stale row failure")
                if run_id == 101:
                    proof_lines.append({"run_id": run_id, "pending": True})
                    return False
                raise AssertionError("irrelevant fourth run must not be submitted")
            finally:
                with lock:
                    active -= 1

        with (
            mock.patch.object(publication, "_inventory", return_value=runs),
            mock.patch.object(publication, "_attempt", side_effect=attempt),
            contextlib.redirect_stdout(io.StringIO()) as output,
        ):
            publication.assert_published(owner, publication.REPOSITORY, "uat")

        proofs = [
            json.loads(line.partition("=")[2])
            for line in output.getvalue().splitlines()
        ]
        self.assertEqual([proof["run_id"] for proof in proofs], [104, 104, 101])
        self.assertEqual(calls[104], [2, 1])
        self.assertNotIn(103, calls, "invalid attempt count on an irrelevant row is ignored")
        self.assertEqual(calls[102], [1])
        self.assertNotIn(100, calls)
        self.assertIn(101, calls, "in-progress rows remain relevant below the boundary")
        self.assertEqual(active, 0, "all worker reads must be joined before return")
        self.assertEqual(set(observed_contexts), {"active-90-second-guard"})

    def test_publication_reads_use_three_context_propagating_workers(self):
        deadline = contextvars.ContextVar("publication_worker_deadline", default=None)
        deadline.set("live-guard-context")
        barrier = threading.Barrier(3)
        lock = threading.Lock()
        active = 0
        max_active = 0
        contexts = []
        owner = self._publication_owner()
        runs = [
            self._publication_run(
                400 + index,
                f"2026-10-30T12:00:{20 - index:02d}Z",
                status="in_progress",
            )
            for index in range(5)
        ]

        def attempt(_owner, _repository, _run, _number, _environment, *, proof_lines):
            nonlocal active, max_active
            with lock:
                active += 1
                max_active = max(max_active, active)
                contexts.append(deadline.get())
            try:
                if len(contexts) <= 3:
                    barrier.wait(timeout=2)
                return False
            finally:
                with lock:
                    active -= 1

        with (
            mock.patch.object(publication, "_inventory", return_value=runs),
            mock.patch.object(publication, "_attempt", side_effect=attempt) as read,
        ):
            publication.assert_published(owner, publication.REPOSITORY, "uat")

        self.assertEqual(read.call_count, 5)
        self.assertEqual(max_active, 3)
        self.assertEqual(active, 0)
        self.assertEqual(contexts, ["live-guard-context"] * 5)

    def test_equal_boundary_failure_is_relevant_and_older_error_cannot_mask_it(self):
        older_finished = threading.Event()
        calls = {}
        owner = self._publication_owner()
        runs = [
            self._publication_run(203, "2026-10-30T12:00:12Z", attempts=2, conclusion="failure"),
            self._publication_run(202, "2026-10-30T12:00:11Z"),
            self._publication_run(201, "2026-10-30T12:00:10Z"),
        ]
        boundary = owner._github_timestamp("2026-10-30T12:00:11Z")

        def attempt(_owner, _repository, run, number, _environment, *, proof_lines):
            run_id = run["id"]
            calls.setdefault(run_id, []).append(number)
            if run_id == 203 and number == 2:
                return False
            if run_id == 203:
                return boundary
            if run_id == 202:
                if not older_finished.wait(timeout=2):
                    raise AssertionError("older failure did not settle first")
                raise MAINTENANCE.retention.UnsafeState(
                    "equal-boundary inventory is incomplete"
                )
            older_finished.set()
            raise MAINTENANCE.retention.UnsafeState("older row must be ignored")

        with (
            mock.patch.object(publication, "_inventory", return_value=runs),
            mock.patch.object(publication, "_attempt", side_effect=attempt),
            self.assertRaisesRegex(
                MAINTENANCE.retention.UnsafeState,
                "equal-boundary inventory is incomplete",
            ),
        ):
            publication.assert_published(owner, publication.REPOSITORY, "uat")
        self.assertEqual(calls[203], [2, 1])
        self.assertIn(202, calls, "an updated_at equal to the boundary is still read")
        self.assertTrue(older_finished.is_set(), "all active reads must be joined")

    def test_incomplete_jobs_inventory_still_refuses_publication(self):
        owner = self._publication_owner()
        run = self._publication_run(301, "2026-10-30T12:00:12Z")
        owner.api.return_value = {"total_count": 1, "jobs": []}
        with (
            mock.patch.object(publication, "_inventory", return_value=[run]),
            self.assertRaisesRegex(
                MAINTENANCE.retention.UnsafeState, "job inventory is incomplete"
            ),
        ):
            publication.assert_published(owner, publication.REPOSITORY, "uat")


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
        "actor": {"login": "ankitkumarsingh1702", "id": 1, "type": "User"},
        "triggering_actor": {"login": "ankitkumarsingh1702", "id": 1, "type": "User"},
        "status": "completed",
        "conclusion": "failure",
        "updated_at": "2026-10-27T00:00:20Z",
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
        *[
            (6, body)
            for body in [
                "##[group]Run set -euo pipefail",
                *evidence._PREPARE_COMMAND,
                "  APPLY: true",
                "##[endgroup]",
            ]
        ],
        (6, "Hosted maintenance stopped: Drive worker is not ready"),
        (7, "##[error]Process completed with exit code 1."),
        (8, evidence.REPORT_GROUP),
        (20, "Cleaning up orphan processes"),
    ]
    raw = "\n".join(
        f"2026-10-27T00:00:{second:02d}Z {body}" for second, body in lines
    ).encode()
    return run, job, raw


def raw_fixture():
    """One realistic whole-run fixture, shared by transport and canonical proof cases."""
    run, job, raw = legacy_fixture()
    run.update(
        id=100,
        head_sha=evidence.AUDITED_SOURCE_SHA,
        repository={"full_name": "org/repo"},
        head_repository={"full_name": "org/repo"},
    )
    job.update(id=200, run_id=100, head_sha=run["head_sha"])
    log = raw.decode().replace("a" * 40, run["head_sha"])
    log = log.replace(
        "Hosted maintenance stopped: Drive worker is not ready", evidence._DIAGNOSTIC
    )
    log = log.replace(
        "  APPLY: true",
        "  PRIVATE_CANARY: PRIVATE_SYNTHETIC_SENTINEL\n2026-10-27T00:00:06Z   APPLY: true",
    )
    for command in evidence._PREPARE_COMMAND:
        log = log.replace(command, "^[[36;1m" + command + "^[[0m")
    return run, job, "\ufeff" + log, evidence.expected_source_blobs(run["head_sha"])


class LegacyPublicationCases:
    def test_exact_observed_runner_warning_may_follow_finalized_orphan_cleanup(self):
        run, job, raw = legacy_fixture()
        suffix = b"\n2026-10-27T00:00:20Z "
        self.proof(run, job, raw + suffix + publication.RUNNER_WARNING.encode())
        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
            self.proof(run, job, raw + suffix + b"##[warning]unknown runner outcome")

    def proof(
        self, run, job, raw, *, older=None, source=None, latest=None, profile=None
    ):
        published = {
            **run,
            "id": 50,
            "status": "completed",
            "conclusion": "success",
            "updated_at": "2026-10-27T00:00:10Z",
        }
        published_job = copy.deepcopy(job)
        published_job["completed_at"] = "2026-10-27T00:00:10Z"
        for step in published_job["steps"]:
            step["conclusion"] = "success"
        calls = []

        def api(_repository, endpoint):
            calls.append(endpoint)
            if endpoint.startswith("workflows/"):
                return {"workflow_runs": [run, published], "total_count": 2}
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
            digest, size = (profile or publication.LEGACY_BLOBS)[path]
            return json.dumps(source or {"sha": digest, "size": size})

        reader = importlib.import_module("verify-predecessor-acceptance")
        # Tests inject different source metadata for the same immutable fixture
        # revision. Production correctly caches immutable blob metadata across a
        # maintenance pass; isolate that cache so one test cannot mask another's
        # fixture or call-count assertion.
        publication_source._read_pinned_blob.cache_clear()
        try:
            with (
                mock.patch.object(MAINTENANCE, "api", side_effect=api),
                mock.patch.object(
                    MAINTENANCE, "command", side_effect=command
                ) as source_read,
                mock.patch.object(
                    MAINTENANCE, "trusted_checkpoint_run", return_value=True
                ),
                mock.patch.object(reader, "bounded_github_read", return_value=raw),
                contextlib.redirect_stdout(io.StringIO()) as output,
            ):
                MAINTENANCE.assert_checkpoint_publication(
                    publication.REPOSITORY, "uat"
                )
        finally:
            publication_source._read_pinned_blob.cache_clear()
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

    def test_new_reviewed_owner_requires_import_closure_and_guard_only_failure(self):
        run, job, raw = legacy_fixture()
        profile = evidence.SOURCE_PROFILES["34050aa25db19afe6004d97fdc76bda7de9c6471"]
        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
            self.proof(run, job, raw, profile=profile)
        raw = raw.replace(
            b"Hosted maintenance stopped: Drive worker is not ready",
            evidence._DIAGNOSTIC.encode(),
        )
        self.proof(run, job, raw, profile=profile)
        broken = copy.deepcopy(profile)
        broken["scripts/ci/retention_preflight_evidence.py"] = ("f" * 40, 7541)
        with self.assertRaises(MAINTENANCE.retention.UnsafeState):
            self.proof(run, job, raw, profile=broken)

    def test_new_profile_accepts_only_one_exact_observer_record_in_either_stream_order(
        self,
    ):
        run, job, raw = legacy_fixture()
        profile = evidence.SOURCE_PROFILES["34050aa25db19afe6004d97fdc76bda7de9c6471"]
        raw = raw.replace(
            b"Hosted maintenance stopped: Drive worker is not ready",
            evidence._DIAGNOSTIC.encode(),
        )
        proof = {
            "schema": "retention_guard_only_failure.v1",
            "environment": "uat",
            "run_id": 789,
            "job_id": 790,
            "run_attempt": 1,
            "source_sha": "c738ff0b975d9a326664f9af356eea2dc7d90125",
            "script_blob": evidence.AUDITED_SOURCE_BLOBS[evidence.OWNER],
            "workflow_blob": evidence.AUDITED_SOURCE_BLOBS[evidence.WORKFLOW],
        }

        def insert(record, before=False):
            body = json.dumps({"guard_only_reconciliation": record}).encode()
            pair = (
                [body, evidence._DIAGNOSTIC.encode()]
                if before
                else [evidence._DIAGNOSTIC.encode(), body]
            )
            return raw.replace(
                evidence._DIAGNOSTIC.encode(), b"\n2026-10-27T00:00:06Z ".join(pair)
            )

        for before in (False, True):
            self.proof(run, job, insert(proof, before), profile=profile)
        for key, value in (
            ("source_sha", "f" * 40),
            ("script_blob", "f" * 40),
            ("run_attempt", 2),
            ("extra", True),
        ):
            with (
                self.subTest(key=key),
                self.assertRaises(MAINTENANCE.retention.UnsafeState),
            ):
                self.proof(run, job, insert({**proof, key: value}), profile=profile)

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

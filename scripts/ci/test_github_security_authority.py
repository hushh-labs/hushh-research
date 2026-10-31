#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Exercise the production security authority's origin and inventory boundary."""

import importlib.util
import base64
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

PATH = Path(__file__).with_name("github_security_authority.py")
SPEC = importlib.util.spec_from_file_location("security_authority", PATH)
authority = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(authority)
REPOSITORY = "example/repository"
HEAD = "a" * 40


def source_fixture():
    repo = {"id": 10, "full_name": REPOSITORY}
    expected = {"run_id": 20, "attempt": 2, "head_sha": HEAD}
    run = {
        "id": 20,
        "run_attempt": 2,
        "head_sha": HEAD,
        "repository": repo,
        "workflow_id": 30,
        "path": authority.CI_PATH,
        "event": "pull_request",
        "status": "in_progress",
        "head_repository": {"id": 99, "full_name": "fork/repository"},
    }
    responses = {
        f"repos/{REPOSITORY}": repo,
        f"repos/{REPOSITORY}/actions/workflows/ci.yml": {
            "id": 30,
            "path": authority.CI_PATH,
        },
        f"repos/{REPOSITORY}/actions/runs/20": run,
    }
    return expected, run, responses


class SecurityAuthorityTest(unittest.TestCase):
    def test_exact_current_attempt_including_fork_without_executing_fork(self):
        for status in ("pending", "queued", "in_progress", "completed"):
            with self.subTest(status=status):
                expected, run, responses = source_fixture()
                run["status"] = status
                result = authority.verify_source(responses.__getitem__, REPOSITORY, expected)
                self.assertEqual(result["head_sha"], HEAD)
                self.assertEqual(result["attempt"], 2)

    def test_wrong_repository_workflow_attempt_sha_or_event_refuses(self):
        for field, value in (
            ("id", 21),
            ("run_attempt", 1),
            ("run_attempt", True),
            ("head_sha", "b" * 40),
            ("workflow_id", 31),
            ("path", "untrusted.yml"),
            ("event", "push"),
            ("status", "unrecognized"),
            ("repository", {"id": 99, "full_name": REPOSITORY}),
        ):
            with self.subTest(field=field, value=value):
                expected, run, responses = source_fixture()
                run[field] = value
                with self.assertRaises(authority.Refused):
                    authority.verify_source(responses.__getitem__, REPOSITORY, expected)

    def test_bound_complete_pagination_and_malformed_or_truncated_refusal(self):
        calls = []
        next_url = "https://api.github.com/repositories/10/dependabot/alerts?state=open&per_page=100&after=opaque%3Dcursor"

        def read(path):
            calls.append(path)
            self.assertNotIn("&page=", path)
            if "after=" not in path:
                # Even a short page may have a next cursor; row count is not EOF.
                return ([{"state": "open"}] * 2, f'<{next_url}>; rel="next"')
            return ([{"state": "open"}] * 100, "")

        self.assertEqual(
            authority.inventory(read, REPOSITORY, "dependabot", 10)["open"], 102
        )
        self.assertEqual(len(calls), 2)
        self.assertEqual(
            calls[1],
            f"repos/{REPOSITORY}/dependabot/alerts?state=open&per_page=100&after=opaque%3Dcursor",
        )
        for rows in ({"message": "denied"}, [None], [{"state": "closed"}]):
            with self.subTest(rows=rows), self.assertRaises(authority.Refused):
                authority.inventory(lambda _: (rows, ""), REPOSITORY, "secret-scanning")
        with (
            patch.object(authority, "MAX_PAGES", 1),
            self.assertRaises(authority.Refused),
        ):
            authority.inventory(
                lambda _: ([], f'<{next_url}>; rel="next"'),
                REPOSITORY,
                "dependabot",
                10,
            )
        with self.assertRaisesRegex(authority.Refused, "repeated"):
            authority.inventory(
                lambda _: ([], f'<{next_url}>; rel="next"'),
                REPOSITORY,
                "dependabot",
                10,
            )

    def test_alert_next_link_cannot_redirect_credentials_or_change_filters(self):
        root = f"https://api.github.com/repos/{REPOSITORY}/dependabot/alerts"
        query = "?state=open&per_page=100&after=cursor"
        for url in (
            root.replace("api.github.com", "untrusted.example") + query,
            root.replace(REPOSITORY, "another/repository") + query,
            root.replace("dependabot", "secret-scanning") + query,
            root.replace("https:", "http:") + query,
            root + query + "#fragment",
            root + query.replace("state=open", "state=closed"),
            root + query.replace("after=cursor", "page=2"),
            root + query + "&after=duplicate",
            root + query + "&after=",
            root + query + "&state=",
            root + query.replace("after=cursor", "after="),
            root + query.replace("after=cursor", "after=" + "x" * 2049),
            "https://api.github.com/repositories/11/dependabot/alerts" + query,
        ):
            with self.subTest(url=url), self.assertRaises(authority.Refused):
                authority.next_alert_page(
                    f'<{url}>; rel="next"', REPOSITORY, "dependabot", 10
                )
        for page in ("0", "-1", "not-a-page"):
            url = root.replace("dependabot", "secret-scanning") + query.replace(
                "after=cursor", "page=" + page
            )
            with self.subTest(page=page), self.assertRaises(authority.Refused):
                authority.next_alert_page(
                    f'<{url}>; rel="next"', REPOSITORY, "secret-scanning", 10
                )

    def test_manual_recovery_is_governed_and_exact(self):
        policy = {"main": {"protected_pipeline_edit_users": ["maintainer"]}}
        event = {
            "inputs": {"source_run_id": "20", "source_attempt": "2", "source_sha": HEAD}
        }
        env = {
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_ACTOR": "maintainer",
            "GITHUB_TRIGGERING_ACTOR": "maintainer",
        }
        self.assertEqual(authority.requested_source(event, env, policy)["attempt"], 2)
        for key in ("GITHUB_ACTOR", "GITHUB_TRIGGERING_ACTOR"):
            with self.subTest(key=key), self.assertRaises(authority.Refused):
                authority.requested_source(event, {**env, key: "outsider"}, policy)
        with self.assertRaises(authority.Refused):
            authority.requested_source({"inputs": {}}, env, policy)

    def test_missing_credential_and_denied_api_do_not_leak_response(self):
        with self.assertRaises(authority.Refused):
            authority.GitHub(REPOSITORY, "")
        failure = urllib.error.HTTPError(
            "https://api.github.com/private", 403, "private upstream detail", {}, None
        )
        with patch("urllib.request.build_opener") as opener:
            opener.return_value.open.side_effect = failure
            with self.assertRaisesRegex(authority.Refused, r"HTTP 403") as raised:
                authority.GitHub(REPOSITORY, "synthetic").read(f"repos/{REPOSITORY}")
        self.assertNotIn("private upstream", str(raised.exception))

    def test_producer_requires_main_and_records_only_bounded_metadata(self):
        expected, _, responses = source_fixture()
        with tempfile.TemporaryDirectory() as directory:
            event = Path(directory) / "event.json"
            event.write_text(
                json.dumps(
                    {"workflow_run": {"id": 20, "run_attempt": 2, "head_sha": HEAD}}
                )
            )
            env = {
                "GITHUB_REPOSITORY": REPOSITORY,
                "GITHUB_REF": "refs/heads/main",
                "GITHUB_WORKFLOW_REF": f"{REPOSITORY}/{authority.WORKER_PATH}@refs/heads/main",
                "GITHUB_SHA": "c" * 40,
                "GITHUB_EVENT_NAME": "workflow_run",
                "GITHUB_EVENT_PATH": str(event),
                "GITHUB_RUN_ID": "40",
                "GITHUB_RUN_ATTEMPT": "1",
                "GH_TOKEN": "synthetic-actions",
                "GH_SECURITY_ALERTS_TOKEN": "synthetic-alerts",
            }

            def read_page(client, path):
                if "/alerts?" in path:
                    return (
                        (
                            [{"state": "open", "secret": "unapproved-fixture-value"}]
                            if "/secret-scanning/" in path
                            else []
                        ),
                        "",
                    )
                return responses[path], ""

            with patch.object(authority.GitHub, "read_page", read_page):
                result = authority.produce(env)
                self.assertEqual(result["verdict"], "blocked")
                self.assertNotIn("unapproved-fixture-value", json.dumps(result))
                self.assertEqual(result["source"]["run_id"], expected["run_id"])
                for key, value in (
                    ("GITHUB_REF", "refs/pull/1/merge"),
                    ("GITHUB_WORKFLOW_REF", "untrusted@refs/heads/main"),
                ):
                    with self.subTest(key=key), self.assertRaises(authority.Refused):
                        authority.produce({**env, key: value})


def rerun_fixture(actor="operator"):
    path = PATH.parents[2] / ".agents/skills/repo-operations/scripts/ci_rerun.py"
    spec = importlib.util.spec_from_file_location("security_rerun", path)
    retry = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(retry)
    expected, source, _ = source_fixture()
    repo = {"id": 10, "full_name": retry.REPOSITORY}
    source.update(repository=repo, status="completed", conclusion="failure")
    prefix = f"repos/{retry.REPOSITORY}"
    policy = {"main": {"protected_pipeline_edit_users": ["operator"]}}
    responses = {
        "user": {"login": actor},
        f"{prefix}/contents/config/ci-governance.json?ref=main": {
            "encoding": "base64", "size": 100,
            "content": base64.b64encode(json.dumps(policy).encode()).decode(),
        },
        prefix: repo,
        f"{prefix}/actions/workflows/ci.yml": {"id": 30, "path": authority.CI_PATH},
        f"{prefix}/actions/runs/20": source,
    }
    writes = []

    def write(path, body):
        writes.append((path, body))
        if not path.endswith("/dispatches"):
            source.update(run_attempt=3, status="queued")

    return retry, expected, source, responses.__getitem__, write, writes


class SecurityRerunTest(unittest.TestCase):
    def test_one_job_retry_is_bound_to_the_exact_completed_attempt(self):
        for mismatch in (None, "attempt", "run_id", "head_sha", "status", "name", "truncated"):
            retry, expected, source, read, write, writes = rerun_fixture()
            source["conclusion"] = "success"
            job = {"id": 50, "run_id": 20, "head_sha": HEAD, "status": "completed", "name": "CI Status Gate"}
            inventory = {"total_count": 1, "jobs": [{"id": 50}]}
            if mismatch == "attempt":
                inventory = {"total_count": 0, "jobs": []}
            elif mismatch == "truncated":
                inventory["total_count"] = 101
            elif mismatch:
                job[mismatch] = "wrong"

            def read_job(path):
                if "/attempts/2/jobs?" in path:
                    return inventory
                return job if path.endswith("/actions/jobs/50") else read(path)

            if mismatch:
                with self.subTest(mismatch=mismatch), self.assertRaises(retry.Refused):
                    retry.rerun_validation(read_job, write, expected, job_id=50)
                self.assertEqual(writes, [])
            else:
                retry.rerun_validation(read_job, write, expected, job_id=50)
                self.assertTrue(writes[0][0].endswith("/actions/jobs/50/rerun"))
                self.assertEqual(len(writes), 1)

    def test_one_rerun_and_exact_observed_attempt_dispatch(self):
        for all_jobs in (False, True):
            retry, expected, _, read, write, writes = rerun_fixture()
            result = retry.rerun_validation(read, write, expected, all_jobs=all_jobs)
            self.assertEqual(result["attempt"], 3)
            self.assertEqual(len(writes), 1)
            self.assertTrue(writes[0][0].endswith("/rerun" if all_jobs else "/rerun-failed-jobs"))
            self.assertFalse(any(path.endswith("/dispatches") for path, _ in writes))

    def test_ungoverned_stale_or_running_source_refuses_before_mutation(self):
        for scenario in ("actor", "attempt", "running", "successful"):
            retry, expected, source, read, write, writes = rerun_fixture(
                "outsider" if scenario == "actor" else "operator"
            )
            if scenario == "attempt":
                source["run_attempt"] = 1
            elif scenario == "running":
                source["status"] = "in_progress"
            elif scenario == "successful":
                source["conclusion"] = "success"
            with self.subTest(scenario=scenario), self.assertRaises(retry.Refused):
                retry.rerun_validation(read, write, expected)
            self.assertEqual(writes, [])

    def test_lost_rerun_response_reconciles_without_second_post(self):
        retry, expected, _, read, write, writes = rerun_fixture()

        def uncertain(path, body):
            write(path, body)
            if not path.endswith("/dispatches"):
                raise retry.Refused("lost response")

        self.assertEqual(retry.rerun_validation(read, uncertain, expected)["attempt"], 3)
        self.assertEqual(len(writes), 1)

    def test_attempt_race_never_replays_or_dispatches_another_workflow(self):
        retry, expected, source, read, write, writes = rerun_fixture()
        def race(path, body):
            write(path, body)
            source["run_attempt"] = 4
        with self.assertRaises(retry.Refused):
            retry.rerun_validation(read, race, expected)
        self.assertEqual(len(writes), 1)

    def test_unobserved_rerun_has_a_bound_and_no_second_post(self):
        retry, expected, _, read, _, writes = rerun_fixture()
        ticks = iter((0, 61))
        with self.assertRaisesRegex(retry.Refused, "unconfirmed"):
            retry.rerun_validation(
                read, lambda path, body: writes.append((path, body)), expected,
                clock=lambda: next(ticks), sleep=lambda _: self.fail("deadline exceeded"),
            )
        self.assertEqual(len(writes), 1)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Exercise the production security authority's origin and inventory boundary."""

import importlib.util
import copy
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


def rerun_fixture(actor="operator", permission="write"):
    path = PATH.parents[2] / ".agents/skills/repo-operations/scripts/ci_rerun.py"
    spec = importlib.util.spec_from_file_location("security_rerun", path)
    retry = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(retry)
    expected, source, _ = source_fixture()
    repo = {"id": 10, "full_name": retry.REPOSITORY}
    source.update(repository=repo, status="completed", conclusion="failure")
    prefix = f"repos/{retry.REPOSITORY}"
    responses = {
        "user": {"login": actor},
        f"{prefix}/collaborators/{actor}/permission": {
            "permission": permission, "user": {"login": actor},
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
    def test_retry_uses_live_repository_write_authority_not_pipeline_ownership(self):
        for permission in ("admin", "write", "read", "triage", "none", None):
            retry, expected, _, read, write, writes = rerun_fixture("ordinary-maintainer", permission)
            with self.subTest(permission=permission):
                if permission in {"admin", "write"}:
                    self.assertEqual(retry.rerun_validation(read, write, expected)["attempt"], 3)
                    self.assertEqual(len(writes), 1)
                else:
                    with self.assertRaises(retry.Refused):
                        retry.rerun_validation(read, write, expected)
                    self.assertEqual(writes, [])
        for response in (None, {}, {"permission": "write", "user": None},
                         {"permission": "admin", "user": {"login": "someone-else"}}):
            retry, expected, _, read, write, writes = rerun_fixture()
            def mismatched(path):
                return response if "/collaborators/" in path else read(path)
            with self.assertRaises(retry.Refused):
                retry.rerun_validation(mismatched, write, expected)
            self.assertEqual(writes, [])

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
                permission="read" if scenario == "actor" else "write"
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


class ExplicitOperationTeamTest(unittest.TestCase):
    def test_current_main_operation_uses_live_team_and_rechecks_rerunner(self):
        import github_team_authority as team
        import deployment_security
        repository, sha = team.REPOSITORY, "a" * 40
        request = {"kind": "operation", "surface": "production", "id": 42, "run_attempt": 2, "head_sha": sha}
        actor = {"login": "synthetic-operator", "type": "User", "id": 100}
        run = {"id": 42, "run_attempt": 2, "head_sha": sha, "head_branch": "main", "status": "in_progress",
               "event": "workflow_dispatch", "path": ".github/workflows/deploy-production.yml", "workflow_id": 5,
               "repository": {"full_name": repository}, "head_repository": {"full_name": repository},
               "actor": actor, "triggering_actor": actor}
        def read(path):
            if path.endswith("/actions/runs/42"): return copy.deepcopy(run)
            if "/actions/workflows/" in path: return {"id": 5, "path": run["path"]}
            return {"status": "identical", "merge_base_commit": {"sha": sha}}
        teams = {slug: ["synthetic-operator"] for slug in team.TEAM_IDS}
        producer = {"repository": repository, "workflow_path": team.WORKFLOW, "workflow_sha": sha, "run_id": 7, "attempt": 1}
        with patch.object(deployment_security, "verify_run", return_value=producer), \
             patch.object(team, "team_reader", return_value=object()), \
             patch.object(team, "read_teams", return_value=teams):
            result = team.produce_operation_request({}, read, request)
            self.assertEqual(result["request"], request)
            self.assertNotIn("teams", result)
            protected = {**request, "protected": True}
            self.assertEqual(team.produce_operation_request({}, read, protected)["request"], protected)
            teams["pipeline-editors"] = []
            with self.assertRaises(team.Refused): team.produce_operation_request({}, read, protected)
            teams["pipeline-editors"] = ["synthetic-operator"]
            teams["deploy-production"] = ["replacement-operator"]
            with self.assertRaises(team.Refused): team.produce_operation_request({}, read, request)
            teams["deploy-production"] = ["synthetic-operator"]
            run["triggering_actor"] = {"login": "outsider", "type": "User", "id": 101}
            with self.assertRaises(team.Refused): team.produce_operation_request({}, read, request)
            run["head_branch"] = "dev"
            with self.assertRaises(team.Refused): team.produce_operation_request({}, read, request)


    def test_explicit_broker_binds_attempt_and_never_replays_uncertain_dispatch(self):
        import subprocess
        import github_team_authority as team
        import github_security_receipt as transport
        repository, sha = team.REPOSITORY, "a" * 40
        request = {"kind": "operation", "surface": "production", "id": 42, "run_attempt": 1, "head_sha": sha}
        run = {"id": 7, "run_attempt": 1, "path": team.WORKFLOW, "head_branch": "main",
               "event": "workflow_dispatch", "repository": {"full_name": repository}, "head_sha": sha,
               "status": "completed", "conclusion": "success", "run_started_at": "2026-11-08T01:00:00Z",
               "updated_at": "2026-11-08T01:01:00Z"}
        artifact = {"id": 8, "name": "deployment-security-7-1", "expired": False,
                    "workflow_run": {"id": 7}, "size_in_bytes": 3, "digest": "sha256:" + "b" * 64}
        receipt = {"schema_version": 1, "request": request, "producer": {"repository": repository,
                   "run_id": 7, "attempt": 1, "workflow_path": team.WORKFLOW, "workflow_sha": sha},
                   "recorded_at": "2026-11-08T01:00:30Z", "decision": {"surface": "production"}}
        def read(path):
            if path.endswith("/artifacts?per_page=100"): return {"total_count": 1, "artifacts": [artifact]}
            if "/compare/" in path: return {"status": "identical", "merge_base_commit": {"sha": sha}}
            return copy.deepcopy(run)
        response = subprocess.CompletedProcess([], 0, json.dumps({"workflow_run_id": 7,
                   "html_url": f"https://github.com/{repository}/actions/runs/7"}), "")
        with tempfile.TemporaryDirectory() as folder, patch.object(team, "operation_source", return_value={}), \
             patch.object(team.subprocess, "run", return_value=response) as dispatch, \
             patch.object(transport, "archive_read", return_value=b"zip"), patch.object(transport, "unpack", return_value=receipt):
            env = {"GITHUB_REPOSITORY": repository, "RUNNER_TEMP": folder}
            self.assertEqual(team._request_authority(env, request, read=read), receipt["decision"])
            self.assertEqual(team._request_authority(env, request, read=read), receipt["decision"])
            self.assertEqual(dispatch.call_count, 1)
            clock, first = [0.0], [True]
            def advance(seconds):
                clock[0] += seconds
            def delayed_read(path):
                if path.endswith("/runs/7") and first[0]:
                    first[0] = False
                    raise team.UnavailableRead(404)
                return read(path)
            self.assertEqual(team._request_authority(
                env, request, read=delayed_read, monotonic=lambda: clock[0], sleep=advance
            ), receipt["decision"])
            self.assertEqual(clock[0], 5)
            self.assertEqual(dispatch.call_count, 1)
            def unavailable_read(path):
                raise team.UnavailableRead(503)
            with self.assertRaisesRegex(team.Refused, "within its deadline"):
                team._request_authority(
                    env, request, read=unavailable_read, monotonic=lambda: clock[0], sleep=advance
                )
            self.assertEqual(clock[0], 245)
            self.assertEqual(dispatch.call_count, 1)
            clock, observations = [0.0], [0]
            def expires_before_retry(path):
                observations[0] += 1
                if observations[0] == 1:
                    clock[0] = 239
                    raise team.UnavailableRead(404)
                return read(path)
            with self.assertRaisesRegex(team.Refused, "within its deadline"):
                team._request_authority(
                    env, request, read=expires_before_retry, monotonic=lambda: clock[0], sleep=advance
                )
            self.assertEqual(observations[0], 1)
            self.assertEqual(dispatch.call_count, 1)
            run["run_attempt"] = 2
            run["conclusion"] = "failure"
            with self.assertRaises(team.Refused): team._request_authority(env, request, read=read)
            self.assertEqual(dispatch.call_count, 1)
        with tempfile.TemporaryDirectory() as folder, patch.object(team, "operation_source", return_value={}), \
             patch.object(team.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "lost response")) as dispatch:
            env = {"GITHUB_REPOSITORY": repository, "RUNNER_TEMP": folder}
            for _ in range(2):
                with self.assertRaises(team.Refused): team._request_authority(env, request, read=read)
            self.assertEqual(dispatch.call_count, 1)

    def test_broker_api_reads_classify_transport_without_exposing_response_or_retrying_denial(self):
        import subprocess
        import github_team_authority as team
        path = f"repos/{team.REPOSITORY}/actions/runs/7"
        for status, expected in ((503, team.UnavailableRead), (403, team.Refused)):
            response = subprocess.CompletedProcess([], 1, "private response", f"private body (HTTP {status})")
            with self.subTest(status=status), patch.object(team.subprocess, "run", return_value=response):
                with self.assertRaises(expected) as error:
                    team.cli_read(path)
                self.assertEqual(type(error.exception), expected)
                self.assertIn(f"HTTP {status}", str(error.exception))
                self.assertNotIn("private", str(error.exception))
        with patch.object(team.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "not JSON", "")):
            with self.assertRaises(team.Refused) as error:
                team.cli_read(path)
            self.assertNotIsInstance(error.exception, team.UnavailableRead)


class LiveTeamPolicyTest(unittest.TestCase):

    def test_dev_uat_protected_edits_use_pinned_main_policy_without_candidate_grants(self):
        import base64
        import os
        import queue_combined_result as queue
        spec = importlib.util.spec_from_file_location("protected_policy", Path(__file__).with_name("verify-protected-pipeline-edits.py"))
        guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guard)
        repository, main_sha = "hushh-labs/hushh-research", "b" * 40
        stale = {"authorization": {"native_teams": True}, "main": {"protected_pipeline_edit_users": ["revoked"]}}
        approved = {"main": {"protected_pipeline_edit_users": ["current-editor"]}}
        responses = {
            f"repos/{repository}/git/ref/heads/main": {"object": {"type": "commit", "sha": main_sha}},
            f"repos/{repository}/contents/config/ci-governance.json?ref={main_sha}": {
                "path": "config/ci-governance.json", "encoding": "base64",
                "content": base64.b64encode(json.dumps(approved).encode()).decode()},
        }
        with tempfile.TemporaryDirectory() as folder:
            event_path = Path(folder) / "event.json"
            candidate_policy = Path(folder) / "candidate-policy.json"
            candidate_policy.write_text(json.dumps({"main": {"protected_pipeline_edit_users": ["candidate-only"]}}))
            event = {"repository": {"full_name": repository}, "pull_request": {
                "base": {"sha": HEAD, "ref": "uat", "repo": {"full_name": repository}},
                "head": {"repo": {"full_name": repository}}}}
            env = {"GITHUB_EVENT_NAME": "pull_request", "GITHUB_REPOSITORY": repository,
                   "GITHUB_EVENT_PATH": str(event_path)}
            with patch("github_team_authority.local_policy", side_effect=lambda policy, **kw: policy), \
                 patch.dict(os.environ, env), patch.object(guard, "POLICY_PATH", candidate_policy), \
                 patch.object(guard.subprocess, "check_output", return_value=json.dumps(stale)), \
                 patch.object(queue, "api", side_effect=responses.__getitem__) as read_main:
                for branch in ("dev", "uat", "main", "uat-isolated"):
                    event["pull_request"]["base"]["ref"] = branch
                    event_path.write_text(json.dumps(event))
                    read_main.reset_mock()
                    selected = guard._load_policy()
                    self.assertEqual(selected, approved if branch in {"dev", "uat"} else stale)
                    self.assertEqual(read_main.call_count, 2 if branch in {"dev", "uat"} else 0)
                    if branch in {"dev", "uat"}:
                        for actor, expected in (("current-editor", 0), ("revoked", 1), ("candidate-only", 1)):
                            code, _ = guard.evaluate(changed_files=["scripts/ci/test_uat_exact_ci.py"], actor=actor,
                                allowed_users=guard.resolve_allowed_users(selected["main"]), protected_paths=["scripts/ci/"])
                            self.assertEqual(code, expected)
                        path = Path(__file__).resolve().parents[2] / ".agents/skills/repo-operations/scripts/pre_pr_readiness.py"
                        spec = importlib.util.spec_from_file_location("prepared_pr_readiness", path)
                        readiness = importlib.util.module_from_spec(spec)
                        spec.loader.exec_module(readiness)
                        with patch.object(readiness, "_capture", return_value=json.dumps(stale)):
                            context = {"base": HEAD, "base_ref": branch, "files": ["scripts/ci/test_uat_exact_ci.py"],
                                       "number": None, "author": "current-editor"}
                            self.assertTrue(readiness._protected(context)[0])
                            context["author"] = "candidate-only"
                            self.assertFalse(readiness._protected(context)[0])
                event["pull_request"]["base"]["ref"] = "uat"
                event_path.write_text(json.dumps(event))
                with patch.object(queue, "api", side_effect=queue.Refused("unavailable")), \
                     self.assertRaisesRegex(guard.GuardResolutionError, "Main editing policy is unavailable"):
                    guard._load_policy()
                # A fork cannot redirect policy authority, but ordinary fork
                # contributions must retain their existing admission behavior.
                event["pull_request"]["head"]["repo"]["full_name"] = "contributor/fork"
                event_path.write_text(json.dumps(event))
                self.assertEqual(guard._load_policy(), approved)
                for context in (event["repository"], event["pull_request"]["base"]["repo"]):
                    context["full_name"] = "foreign/repository"
                    event_path.write_text(json.dumps(event))
                    with self.assertRaisesRegex(guard.GuardResolutionError, "canonical Dev/UAT"):
                        guard._load_policy()
                    context["full_name"] = repository

    @staticmethod
    def owner():
        import github_team_authority
        return github_team_authority

    def setUp(self):
        self.team = self.owner()
        self.members = {slug: ['principal', 'operator'] for slug in self.team.TEAM_IDS}
        self.members['pipeline-editors'] = ['principal']

    def read(self, path):
        if path == 'user':
            return {'type': 'User', 'login': 'principal'}
        slug = path.split('/')[3]
        if '/members?' not in path:
            return {'slug': slug, 'id': self.team.TEAM_IDS[slug], 'parent': None}
        return [{'type': 'User', 'login': login, 'id': index + 1} for index, login in enumerate(self.members[slug])]

    def test_live_membership_replaces_stale_rosters_without_weakening_reviews(self):
        from copy import deepcopy
        policy = {name: {} for name in ('main', 'pr_train', 'uat_merge', 'dev', 'uat', 'production')}
        policy['main'] = {'merge_users': ['retired'], 'required_approving_reviews': 1, 'require_last_push_approval': True, 'require_code_owner_reviews': True}
        original = deepcopy(policy)
        with patch.dict('os.environ', {'GITHUB_ACTIONS': 'false'}):
            projected = self.team.local_policy(policy, actor='principal', read=self.read)
        self.assertEqual(projected['main']['merge_users'], ['operator', 'principal'])
        self.assertEqual(projected['main']['protected_pipeline_edit_users'], ['principal'])
        for key in ('required_approving_reviews', 'require_last_push_approval', 'require_code_owner_reviews'):
            self.assertEqual(projected['main'][key], original['main'][key])
        self.assertEqual(policy, original)
        self.members['deploy-production'] = ['principal']
        with patch.dict('os.environ', {'GITHUB_ACTIONS': 'false'}):
            projected = self.team.local_policy(policy, actor='principal', read=self.read)
        self.assertNotIn('operator', projected['main']['merge_users'])
        self.assertNotIn('operator', projected['production']['manual_dispatch_users'])

    def test_wrong_identity_inherited_partial_or_outsider_membership_refuses(self):
        from copy import deepcopy
        for defect in ('team', 'parent', 'duplicate', 'partial', 'empty', 'outsider'):

            def broken(path):
                row = deepcopy(self.read(path))
                if isinstance(row, dict):
                    if defect == 'team':
                        row['id'] += 1
                    if defect == 'parent':
                        row['parent'] = {'id': 1}
                elif defect == 'duplicate':
                    row.append(deepcopy(row[0]))
                elif defect == 'partial':
                    row *= 50
                elif defect == 'empty':
                    row.clear()
                elif defect == 'outsider' and '/deploy-production/' in path:
                    row.append({'type': 'User', 'login': 'outsider', 'id': 500})
                return row
            with self.subTest(defect=defect), self.assertRaises(self.team.Refused):
                self.team.read_teams(broken)

    def test_local_identity_and_hosted_credentials_cannot_be_substituted(self):
        with patch.dict('os.environ', {'GITHUB_ACTIONS': 'false'}), self.assertRaisesRegex(self.team.Refused, 'authenticated CLI'):
            self.team.local_policy({}, actor='operator', read=self.read)
        with patch.dict('os.environ', {'GITHUB_ACTIONS': 'true'}):
            with self.assertRaisesRegex(self.team.Refused, 'Main-owned'):
                self.team.local_policy({}, actor='principal', read=self.read)

class MainTeamPublisherTest(unittest.TestCase):

    def fixture(self):
        import github_team_authority as team
        run = {'id': 40, 'run_attempt': 2, 'head_sha': HEAD, 'name': 'PR Validation', 'path': '.github/workflows/ci.yml', 'event': 'pull_request', 'workflow_id': 20, 'repository': {'full_name': team.REPOSITORY}, 'status': 'completed', 'conclusion': 'success', 'run_started_at': '2026-11-06T10:00:00Z'}
        env = {'GITHUB_REPOSITORY': team.REPOSITORY, 'GITHUB_REF': 'refs/heads/main', 'GITHUB_EVENT_NAME': 'workflow_run', 'GITHUB_WORKFLOW_REF': f'{team.REPOSITORY}/{team.WORKFLOW}@refs/heads/main', 'GITHUB_RUN_ID': '50', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_SHA': 'b' * 40}

        def read(path):
            if path.endswith('/runs/40'):
                return dict(run)
            if path.endswith('/workflows/ci.yml'):
                return {'path': run['path'], 'id': 20}
            if '/runs?head_sha=' in path:
                return {'total_count': 1, 'workflow_runs': [dict(run)]}
            if '/jobs?' in path:
                return {'total_count': 1, 'jobs': [{'name': 'CI Status Gate', 'status': 'completed', 'conclusion': run['conclusion'], 'run_id': 40, 'run_attempt': 2}]}
            self.fail(path)
        return (team, run, env, read)

    def test_start_is_pending_and_late_start_cannot_replace_completed_decision(self):
        team, run, env, read = self.fixture()
        with tempfile.TemporaryDirectory() as folder:
            event = Path(folder, 'event.json')
            env.update(GITHUB_EVENT_PATH=str(event), RUNNER_TEMP=folder)
            event.write_text(json.dumps({'action': 'in_progress', 'workflow_run': run}))
            self.assertEqual(team.publish_main(env, read=read)['state'], 'superseded-start-event')
            run['status'] = 'in_progress'
            event.write_text(json.dumps({'action': 'in_progress', 'workflow_run': run}))
            published = []
            result = team.publish_main(env, read=read, publish=lambda p: published.append(p) or 1)
            self.assertEqual(result['state'], 'in_progress')
            self.assertNotIn('conclusion', published[0])
            self.assertEqual(published[0]['status'], 'in_progress')

    def test_failure_or_newer_attempt_cannot_inherit_success(self):
        team, run, env, read = self.fixture()
        with tempfile.TemporaryDirectory() as folder:
            event = Path(folder, 'event.json')
            env.update(GITHUB_EVENT_PATH=str(event), RUNNER_TEMP=folder)
            event.write_text(json.dumps({'action': 'completed', 'workflow_run': run}))
            run['conclusion'] = 'failure'
            published = []
            result = team.publish_main(env, read=read, publish=lambda p: published.append(p) or 1)
            self.assertEqual(result['state'], 'failure')
            self.assertEqual(published[0]['conclusion'], 'failure')
            run['run_attempt'] = 3
            with self.assertRaisesRegex(team.Refused, 'attempt changed'):
                team.publish_main(env, read=read, publish=lambda p: self.fail('stale publication'))

    def test_success_requires_live_teams_and_complete_gate_and_main_origin(self):
        team, run, env, read = self.fixture()
        fixture = LiveTeamPolicyTest()
        fixture.setUp()
        with tempfile.TemporaryDirectory() as folder:
            event = Path(folder, 'event.json')
            env.update(GITHUB_EVENT_PATH=str(event), RUNNER_TEMP=folder)
            event.write_text(json.dumps({'action': 'completed', 'workflow_run': run}))
            with patch.object(team, 'authorize_pr', return_value={'number': 1}) as authorize:
                result = team.publish_main(env, read=read, memberships=fixture.read, publish=lambda p: 1)
                self.assertEqual(result['state'], 'success')
                self.assertEqual(authorize.call_args.args[2]['main']['protected_pipeline_edit_users'], ['principal'])
            env['GITHUB_REF'] = 'refs/heads/dev'
            with self.assertRaisesRegex(team.Refused, 'Main-owned'):
                team.publish_main(env, read=read, memberships=fixture.read)


    def test_run_pr_association_cannot_be_replaced_by_another_pr_sharing_its_sha(self):
        import github_team_authority as team
        import queue_combined_result as queue
        guard = queue._module("verify-protected-pipeline-edits.py", "team_test_guard")
        run = {"head_sha": HEAD, "head_branch": "feature", "head_repository": {"full_name": team.REPOSITORY},
               "pull_requests": [{"number": 42, "head": {"sha": HEAD}}]}
        pr = {"state": "open", "number": 42, "head": {"sha": HEAD, "ref": "feature", "repo": {"full_name": team.REPOSITORY}},
              "base": {"sha": "b" * 40, "ref": "dev", "repo": {"full_name": team.REPOSITORY}}, "user": {"login": "member"}}
        policy = {"main": {"protected_pipeline_paths": ["scripts/ci/"], "protected_pipeline_edit_users": ["principal"]}}
        def read(path):
            self.assertEqual(path, f"repos/{team.REPOSITORY}/pulls/42")
            return pr
        with patch.object(team, "fetch_objects"), patch.object(queue, "_module", return_value=guard), \
             patch.object(queue, "git", return_value="app.py"), \
             patch.object(guard, "authored_change_base", return_value="b" * 40), \
             patch.object(guard, "semantic_pipeline_changes", return_value=[]):
            self.assertEqual(team.authorize_pr(read, run, policy)["number"], 42)
            pr["head"]["ref"] = "different-source"
            with self.assertRaisesRegex(team.Refused, "repository or destination"):
                team.authorize_pr(read, run, policy)


class TeamCheckLifecycleTest(unittest.TestCase):

    def test_start_barrier_uses_pr_run_head_not_synthetic_merge_sha(self):
        import github_team_authority as team

        env = {'GITHUB_ACTIONS':'true','GITHUB_REPOSITORY':team.REPOSITORY,
               'GITHUB_EVENT_NAME':'pull_request','GITHUB_RUN_ID':'40',
               'GITHUB_RUN_ATTEMPT':'2','GITHUB_SHA':'b'*40}
        run = {'event':'pull_request','head_sha':HEAD}
        with patch.object(team,'consume_main',return_value={'state':'in_progress'}) as consume:
            team.await_start(env,read=lambda _:run)
            self.assertEqual(consume.call_args.args[1],{'id':40,'run_attempt':2,'head_sha':HEAD})
        env['GITHUB_EVENT_NAME'] = 'merge_group'
        with self.assertRaisesRegex(team.Refused,'queue source changed'):
            team.await_start(env,read=lambda _:{'event':'merge_group','head_sha':HEAD})

    def test_receipt_consumer_requires_main_provenance_exact_attempt_digest_and_phase(self):
        import copy
        import hashlib
        import io
        import zipfile
        import github_team_authority as team

        stamp = '2026-11-07T01:00:00Z'
        source = {'id':40,'run_attempt':2,'head_sha':HEAD,'name':'PR Validation',
                  'path':team.SOURCE_WORKFLOWS['PR Validation'],'workflow_id':20,'event':'pull_request',
                  'repository':{'full_name':team.REPOSITORY},'run_started_at':stamp,'status':'in_progress'}
        identity = {'run_id':40,'attempt':2,'sha':HEAD,'workflow':source['path']}
        producer = {'run_id':50,'attempt':1,'sha':'b'*40,'workflow':team.WORKFLOW}
        run = {'id':50,'run_attempt':1,'head_sha':'b'*40,'workflow_id':30,'path':team.WORKFLOW,
               'head_branch':'main','event':'workflow_run','status':'completed','conclusion':'success',
               'repository':{'full_name':team.REPOSITORY},'head_repository':{'full_name':team.REPOSITORY},
               'run_started_at':stamp,'updated_at':stamp}
        check = {'id':4,'name':team.CHECK,'app':{'id':15368},'head_sha':HEAD,'status':'in_progress',
                 'external_id':team.encode_binding(identity,producer),
                 'details_url':f'https://github.com/{team.REPOSITORY}/actions/runs/50'}
        receipt = {'schema_version':1,'source':identity,'producer':producer,'check_id':4,
                   'state':'in_progress','recorded_at':stamp}
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer,'w') as archive:
            archive.writestr('team-authorization.json',json.dumps(receipt))
        raw = buffer.getvalue()
        artifact = {'id':9,'name':'team-authorization-50-1','expired':False,'workflow_run':{'id':50},
                    'size_in_bytes':len(raw),'digest':'sha256:'+hashlib.sha256(raw).hexdigest()}
        def fixture():
            prefix = f'repos/{team.REPOSITORY}'
            return {f'{prefix}/actions/runs/40':copy.deepcopy(source),
                    f'{prefix}/actions/workflows/ci.yml':{'id':20,'path':source['path']},
                    f'{prefix}/actions/workflows/ci.yml/runs?head_sha={HEAD}&per_page=100':{'total_count':1,'workflow_runs':[copy.deepcopy(source)]},
                    f'{prefix}/commits/{HEAD}/check-runs?check_name=Team%20Authorization%20Gate&filter=all&per_page=100':{'total_count':1,'check_runs':[copy.deepcopy(check)]},
                    f'{prefix}/actions/runs/50':copy.deepcopy(run),
                    f'{prefix}/actions/workflows/deployment-security.yml':{'id':30,'path':team.WORKFLOW},
                    f"{prefix}/compare/{'b'*40}...main?per_page=1&page=2":{'status':'ahead','merge_base_commit':{'sha':'b'*40}},
                    f'{prefix}/actions/runs/50/attempts/1/jobs?per_page=100':{'total_count':1,'jobs':[{'name':'Verify live team authority','run_id':50,'run_attempt':1,'status':'completed','conclusion':'success'}]},
                    f'{prefix}/actions/runs/50/artifacts?per_page=100':{'total_count':1,'artifacts':[copy.deepcopy(artifact)]}}
        for fault in (None,'source_attempt','producer_attempt','producer_branch','digest','phase'):
            with self.subTest(fault=fault):
                responses = fixture()
                if fault == 'source_attempt':
                    responses[f'repos/{team.REPOSITORY}/actions/runs/40']['run_attempt'] = 3
                if fault in ('producer_attempt','producer_branch'):
                    responses[f'repos/{team.REPOSITORY}/actions/runs/50'][{'producer_attempt':'run_attempt','producer_branch':'head_branch'}[fault]] = 2 if fault == 'producer_attempt' else 'dev'
                if fault == 'digest':
                    responses[f'repos/{team.REPOSITORY}/actions/runs/50/artifacts?per_page=100']['artifacts'][0]['digest'] = 'sha256:'+'0'*64
                def invoke():
                    return team.consume_main(responses.__getitem__, source,
                                             state='success' if fault == 'phase' else 'in_progress', archive=lambda _: raw)
                if fault is None:
                    self.assertEqual(invoke(),receipt)
                else:
                    with self.assertRaises(team.Refused):
                        invoke()
        # A published failure can prove ownership for repair, never admission.
        responses = fixture()
        responses[f'repos/{team.REPOSITORY}/actions/runs/50']['conclusion'] = 'failure'
        responses[f'repos/{team.REPOSITORY}/actions/runs/50/attempts/1/jobs?per_page=100']['jobs'][0]['conclusion'] = 'failure'
        failed = {**receipt,'state':'failure'}
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer,'w') as archive:
            archive.writestr('team-authorization.json',json.dumps(failed))
        raw_failed = buffer.getvalue()
        artifact = responses[f'repos/{team.REPOSITORY}/actions/runs/50/artifacts?per_page=100']['artifacts'][0]
        artifact.update(size_in_bytes=len(raw_failed),digest='sha256:'+hashlib.sha256(raw_failed).hexdigest())
        self.assertEqual(team.main_publication(responses.__getitem__,producer,archive=lambda _:raw_failed,
                                              allow_failed_observation=True)[0],failed)
        with self.assertRaisesRegex(team.Refused,'authorization failed'):
            team.consume_main(responses.__getitem__,source,archive=lambda _:raw_failed)

    def test_real_github_external_id_limit_preserves_exact_binding_and_reuses_check(self):
        import io
        from types import SimpleNamespace
        import github_team_authority as team

        source = {'run_id': 42331487365, 'attempt': 2, 'sha': HEAD, 'workflow': team.SOURCE_WORKFLOWS['PR Validation']}
        producer = {'run_id': 42331514168, 'attempt': 1, 'sha': 'b' * 40, 'workflow': team.WORKFLOW}
        encoded = team.encode_binding(source, producer)
        self.assertLessEqual(len(encoded), 255)
        self.assertEqual(team.decode_binding(encoded[:255]), {'source': source, 'producer': producer})
        checks, writes = [], []
        def read(path):
            if '/check-runs?' in path:
                return {'total_count': len(checks), 'check_runs': checks}
            return {'path': team.WORKFLOW, 'head_branch': 'main', 'event': 'workflow_run',
                    'head_sha': producer['sha'], 'repository': {'full_name': team.REPOSITORY}}
        def opened(request, **kwargs):
            body = json.loads(request.data)
            writes.append(request.method)
            if request.method == 'POST':
                checks.append({**body, 'id': 4, 'app': {'id': 15368}, 'external_id': body['external_id'][:255]})
            else:
                checks[0].update(body)
            return io.BytesIO(b'{"id":4}')
        payload = {'name': team.CHECK, 'head_sha': HEAD, 'status': 'in_progress', 'external_id': encoded}
        with patch.object(team.urllib.request, 'build_opener', return_value=SimpleNamespace(open=opened)):
            team.write_check('fixture', payload, read=read)
            team.write_check('fixture', {**payload, 'status': 'completed', 'conclusion': 'success'}, read=read)
        self.assertEqual(writes, ['POST', 'PATCH'])
        self.assertEqual(len(checks), 1)

    def test_truncated_duplicate_requires_immutable_main_publication_before_adoption(self):
        import io
        from types import SimpleNamespace
        import github_team_authority as team

        source = {'run_id': 42331487365, 'attempt': 1, 'sha': HEAD, 'workflow': team.SOURCE_WORKFLOWS['PR Validation']}
        producer = {'run_id': 42331514168, 'attempt': 1, 'sha': 'b' * 40, 'workflow': team.WORKFLOW}
        binding = {'source': source, 'producer': producer}
        legacy = json.dumps(binding, sort_keys=True, separators=(',', ':'))[:255]
        self.assertEqual(len(legacy), 255)
        rows = [{'id': key, 'name': team.CHECK, 'app': {'id':15368}, 'external_id':legacy,
                 'details_url':f"https://github.com/{team.REPOSITORY}/actions/runs/{producer['run_id']}"} for key in (3, 4)]
        def read(path):
            if '/check-runs?' in path:
                return {'total_count':len(rows), 'check_runs':rows}
            return {'id': producer['run_id'], 'run_attempt':1, 'head_sha':producer['sha'],
                    'path':team.WORKFLOW, 'head_branch':'main','event':'workflow_run', 'repository':{'full_name':team.REPOSITORY}}
        # A forged/unreadable legacy observation must refuse before a write.
        with patch.object(team, 'main_publication', side_effect=team.Refused('Main proof unavailable')), \
             patch.object(team.urllib.request, 'build_opener') as opened:
            with self.assertRaisesRegex(team.Refused, 'Main proof unavailable'):
                team.write_check('fixture', {'head_sha':HEAD,'external_id':team.encode_binding(source,producer)}, read=read)
            opened.assert_not_called()
        records = iter(({'source':source,'producer':producer,'check_id':3}, {'source':source,'producer':producer,'check_id':4}))
        writes = []
        def opened(request, **kwargs):
            writes.append((request.method, request.full_url))
            return io.BytesIO(json.dumps({'id':3,'name':'Team authority observation (superseded)'} if request.full_url.endswith('/3') else {'id':4}).encode())
        with patch.object(team, 'main_publication', side_effect=lambda *args, **kwargs: (next(records), {})), \
             patch.object(team.urllib.request, 'build_opener', return_value=SimpleNamespace(open=opened)):
            self.assertEqual(team.write_check('fixture', {'head_sha':HEAD,'external_id':team.encode_binding(source,producer)}, read=read), 4)
        self.assertEqual([url.rsplit('/',1)[-1] for _,url in writes], ['4','3'])
        # Resume a confirmed canonical update after an uncertain retirement.
        rows[1]['external_id'] = team.encode_binding(source,producer)
        with patch.object(team, 'main_publication', return_value=({'source':source,'producer':producer,'check_id':3}, {})), \
             patch.object(team.urllib.request, 'build_opener', return_value=SimpleNamespace(open=opened)):
            self.assertEqual(team.write_check('fixture', {'head_sha':HEAD,'external_id':team.encode_binding(source,producer)}, read=read), 4)
        self.assertEqual([url.rsplit('/',1)[-1] for _,url in writes[-2:]], ['4','3'])

    def test_publication_reconciles_the_existing_main_check_and_never_replays_uncertain_post(self):
        import io
        from types import SimpleNamespace
        import github_team_authority as team
        producer = {'run_id': 50, 'attempt': 1, 'sha': 'b' * 40, 'workflow': team.WORKFLOW}
        payload = {'name': team.CHECK, 'head_sha': HEAD, 'status': 'in_progress', 'external_id': json.dumps({'source': {'sha': HEAD}, 'producer': producer})}
        checks, writes = ([], [])

        def read(path):
            if '/check-runs?' in path:
                return {'total_count': len(checks), 'check_runs': checks}
            return {'path': team.WORKFLOW, 'head_branch': 'main', 'event': 'workflow_run', 'head_sha': 'b' * 40, 'repository': {'full_name': team.REPOSITORY}}

        def opened(request, **kwargs):
            writes.append((request.method, request.full_url, json.loads(request.data)))
            return io.BytesIO(b'{"id": 4}')
        with patch.object(team.urllib.request, 'build_opener', return_value=SimpleNamespace(open=opened)):
            self.assertEqual(team.write_check('fixture', payload, read=read), 4)
            checks.append({'id': 4, 'name': team.CHECK, 'app': {'id': 15368}, 'external_id': payload['external_id']})
            self.assertEqual(team.write_check('fixture', {**payload, 'status': 'completed', 'conclusion': 'success'}, read=read), 4)
        self.assertEqual([method for method, _, _ in writes], ['POST', 'PATCH'])
        self.assertNotIn('head_sha', writes[-1][2])
        with patch.object(team.urllib.request, 'build_opener', return_value=SimpleNamespace(open=lambda *args, **kwargs: (_ for _ in ()).throw(TimeoutError()))):
            with self.assertRaisesRegex(team.Refused, 'uncertain'):
                team.write_check('fixture', payload, read=read)

if __name__ == "__main__":
    unittest.main()

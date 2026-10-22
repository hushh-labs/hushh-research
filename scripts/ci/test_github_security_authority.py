#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Exercise the production security authority's origin and inventory boundary."""

import importlib.util
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
        expected, _, responses = source_fixture()
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
            "https://api.github.com/repositories/11/dependabot/alerts" + query,
        ):
            with self.subTest(url=url), self.assertRaises(authority.Refused):
                authority.next_alert_page(
                    f'<{url}>; rel="next"', REPOSITORY, "dependabot", 10
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


if __name__ == "__main__":
    unittest.main()

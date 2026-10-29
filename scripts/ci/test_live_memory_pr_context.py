"""Reruns read edited PR evidence only for the exact original candidate."""

import copy
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from live_memory_pr_context import impact_body


class PullRequestContextTest(unittest.TestCase):
    def setUp(self):
        self.repo = {"id": 12, "full_name": "hushh-labs/hushh-research"}
        self.pr = {
            "number": 42,
            "state": "open",
            "body": "old evidence",
            "base": {"ref": "main", "sha": "a" * 40, "repo": self.repo},
            "head": {"ref": "fix/example", "sha": "b" * 40, "repo": self.repo},
        }
        self.event = {"number": 42, "repository": self.repo, "pull_request": self.pr}

    def test_first_attempt_uses_event_and_rerun_reads_current_body(self):
        edited = {**self.pr, "body": "updated evidence"}
        self.assertEqual(
            impact_body(self.event, "1", self.repo["full_name"], None), "old evidence"
        )
        self.assertEqual(
            impact_body(self.event, "2", self.repo["full_name"], lambda _: edited),
            "updated evidence",
        )

    def test_rerun_refuses_changed_or_incomplete_identity(self):
        for field, value in (("sha", "c" * 40), ("ref", "other"), ("repo", None)):
            for side in ("head", "base"):
                changed = copy.deepcopy(self.pr)
                changed[side][field] = value
                with (
                    self.subTest(side=side, field=field),
                    self.assertRaises(ValueError),
                ):
                    impact_body(
                        self.event, "2", self.repo["full_name"], lambda _: changed
                    )
        for field, value in (("id", 13), ("full_name", "other/repo")):
            changed = copy.deepcopy(self.pr)
            changed["head"]["repo"] = {**changed["head"]["repo"], field: value}
            with self.subTest(repo_field=field), self.assertRaises(ValueError):
                impact_body(self.event, "2", self.repo["full_name"], lambda _: changed)
        with self.assertRaises(ValueError):
            impact_body(
                {**self.event, "number": 43},
                "2",
                self.repo["full_name"],
                lambda _: self.pr,
            )
        with self.assertRaises(ValueError):
            impact_body(self.event, "2", "other/repo", lambda _: self.pr)
        for field, value in (("number", 43), ("state", "closed"), ("body", None)):
            changed = {**self.pr, field: value}
            with self.subTest(field=field), self.assertRaises(ValueError):
                impact_body(self.event, "2", self.repo["full_name"], lambda _: changed)

    def test_missing_attempt_or_api_fails_closed(self):
        for attempt in ("", "0", "oops"):
            with self.subTest(attempt=attempt), self.assertRaises(ValueError):
                impact_body(self.event, attempt, self.repo["full_name"], None)
        with self.assertRaises(ValueError):
            impact_body(self.event, "2", self.repo["full_name"], lambda _: None)
        with self.assertRaises(ValueError):
            impact_body(self.event, "2", self.repo["full_name"], None)

        def timeout(_path):
            raise TimeoutError()

        with self.assertRaises(ValueError):
            impact_body(self.event, "2", self.repo["full_name"], timeout)

    def test_actual_gate_uses_the_edited_body_on_a_matching_rerun(self):
        spec = importlib.util.spec_from_file_location(
            "live_memory_gate", Path(__file__).with_name("live-memory-source-gate.py")
        )
        gate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gate)
        body = "\n".join(
            (
                "- Live Memory source impact (every feature):",
                "  - [x] No durable owner data is created, changed, or deleted; reason listed below",
                "  - Live Memory evidence (source kind and test, or no-impact reason): This change modifies CI metadata only and does not write owner data.",
                "- Mobile parity impacts:",
            )
        )
        current = {**self.pr, "body": body}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "event.json"
            path.write_text(json.dumps(self.event))
            environment = {
                "GITHUB_EVENT_NAME": "pull_request",
                "GITHUB_EVENT_PATH": str(path),
                "GITHUB_RUN_ATTEMPT": "2",
                "GITHUB_REPOSITORY": self.repo["full_name"],
                "GH_TOKEN": "synthetic-token",
            }
            with (
                patch.dict(os.environ, environment),
                patch.object(gate, "GitHub") as github,
            ):
                github.return_value.read.return_value = current
                gate.validate_pr_event(set())
                github.return_value.read.assert_called_once_with(
                    "repos/hushh-labs/hushh-research/pulls/42"
                )
            with patch.dict(os.environ, {**environment, "GH_TOKEN": ""}):
                with self.assertRaises(ValueError):
                    gate.validate_pr_event(set())


if __name__ == "__main__":
    unittest.main()

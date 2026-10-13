"""Exercise the hosted maintenance trigger gate with One chat run fixtures."""

from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest

WORKFLOW = (
    pathlib.Path(__file__).resolve().parents[2]
    / ".github/workflows/capacity-maintenance.yml"
)


class OneChatMaintenanceTriggerTests(unittest.TestCase):
    def setUp(self) -> None:
        source = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn(
            "workflows: [Deploy to UAT, Deploy UAT One Chat Backend Only, Deploy to Production]",
            source,
        )
        match = re.search(r"          python3 - <<'PY'\n(.*?)\n          PY", source, re.DOTALL)
        self.assertIsNotNone(match)
        self.gate = textwrap.dedent(match.group(1))

    @staticmethod
    def one_chat_run() -> dict:
        return {
            "id": 811,
            "name": "Deploy UAT One Chat Backend Only",
            "path": ".github/workflows/deploy-uat-one-chat.yml",
            "event": "workflow_dispatch",
            "status": "completed",
            "conclusion": "success",
            "head_branch": "main",
            "repository": {"full_name": "owner/repo"},
            "head_repository": {"full_name": "owner/repo"},
            "actor": {"login": "maintainer"},
        }

    def invoke(self, run: dict, *, ref: str = "main") -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            event = directory / "event.json"
            output = directory / "output.txt"
            event.write_text(json.dumps({"workflow_run": run}), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, "-c", self.gate],
                env={
                    **os.environ,
                    "GITHUB_REF_NAME": ref,
                    "GITHUB_EVENT_PATH": str(event),
                    "GITHUB_EVENT_NAME": "workflow_run",
                    "GITHUB_REPOSITORY": "owner/repo",
                    "GITHUB_OUTPUT": str(output),
                },
                capture_output=True,
                text=True,
                check=False,
            )
            result.output_text = output.read_text(encoding="utf-8") if output.exists() else ""
            return result

    def test_successful_one_chat_run_wakes_uat_using_its_own_run_id(self) -> None:
        result = self.invoke(self.one_chat_run())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("environment=uat\n", result.output_text)
        self.assertIn("release_run_id=811\n", result.output_text)
        self.assertIn("apply=true\n", result.output_text)

    def test_failed_one_chat_run_only_observes_an_independent_source(self) -> None:
        result = self.invoke({**self.one_chat_run(), "conclusion": "failure"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("environment=uat\n", result.output_text)
        self.assertIn("release_run_id=\n", result.output_text)
        self.assertNotIn("release_run_id=811\n", result.output_text)

    def test_untrusted_one_chat_run_cannot_grant_cleanup(self) -> None:
        variants = {
            "wrong workflow": {"path": ".github/workflows/deploy-uat.yml"},
            "wrong repository": {"repository": {"full_name": "other/repo"}},
            "wrong head repository": {"head_repository": {"full_name": "other/repo"}},
            "wrong branch": {"head_branch": "feature"},
            "wrong event": {"event": "pull_request"},
        }
        for label, change in variants.items():
            with self.subTest(label=label):
                run = {**self.one_chat_run(), **change}
                result = self.invoke(run)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.output_text, "")


if __name__ == "__main__":
    unittest.main()

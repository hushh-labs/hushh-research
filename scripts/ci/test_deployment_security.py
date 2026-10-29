# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Real deployment credential and exact-attempt boundaries after worker retirement."""

from copy import deepcopy
from pathlib import Path
import os
import subprocess
import unittest

import deployment_security as gate

SHA = "a" * 40
APP = "b" * 40


class DeploymentSecurityTest(unittest.TestCase):
    def fixture(self):
        env = {
            "GITHUB_REPOSITORY": gate.REPOSITORY, "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_SHA": SHA,
            "GITHUB_WORKFLOW_REF": f"{gate.REPOSITORY}/.github/workflows/deploy-dev.yml@refs/heads/main",
            "GITHUB_RUN_ID": "10", "GITHUB_RUN_ATTEMPT": "2",
            "DEPLOY_SECURITY_REF": "dev", "DEPLOY_SECURITY_ENVIRONMENT": "dev",
            "DEPLOY_SECURITY_SCOPE": "auto",
        }
        run = {"id": 10, "run_attempt": 2, "head_sha": SHA, "event": "workflow_dispatch",
               "status": "in_progress", "path": ".github/workflows/deploy-dev.yml",
               "repository": {"full_name": gate.REPOSITORY}}

        def read(path):
            if "/actions/runs/" in path:
                return deepcopy(run)
            if "/commits/" in path:
                return {"sha": APP}
            return {"full_name": gate.REPOSITORY, "id": 9}

        return env, run, read

    def test_exact_release_binds_source_and_advisory_dependencies(self):
        env, _, read = self.fixture()
        def alerts(path):
            if "/dependabot/" in path:
                return ([{"state": "open", "security_advisory": {"severity": "high"}}], "")
            return ([], "")
        result = gate.produce(env, read, alerts)
        self.assertEqual(result["verdict"], "clear")
        self.assertEqual(result["source"]["application_sha"], APP)
        self.assertEqual(result["source"]["attempt"], 2)
        self.assertEqual(result["dependabot"]["open"], 1)
        self.assertEqual(gate.produce(env, read, lambda _: ([{"state": "open"}], ""))["verdict"], "blocked")

    def test_changed_attempt_and_untrusted_workflow_refuse(self):
        for key, value in [("GITHUB_REF", "refs/heads/dev"), ("GITHUB_EVENT_NAME", "pull_request_target"),
                           ("GITHUB_REPOSITORY", "other/repository"), ("GITHUB_RUN_ATTEMPT", "1")]:
            with self.subTest(field=key):
                env, _, read = self.fixture()
                env[key] = value
                with self.assertRaises(gate.Refused):
                    gate.produce(env, read, lambda _: ([], ""))
        env, run, read = self.fixture()
        def alerts(_):
            run["run_attempt"] = 3
            return [], ""
        with self.assertRaises(gate.Refused):
            gate.produce(env, read, alerts)

    def test_missing_credentials_and_incomplete_inventory_refuse(self):
        with self.assertRaises(gate.Refused):
            gate.GitHub(gate.REPOSITORY, "")
        env, _, read = self.fixture()
        for rows, links in [({}, ""), ([{"state": "closed"}], ""),
                            ([], '<https://outside.invalid/alerts>; rel="next"')]:
            with self.subTest(rows=rows, links=links), self.assertRaises(gate.Refused):
                gate.produce(env, read, lambda _: (rows, links))

    def test_every_caller_requires_isolated_clearance_before_mutation(self):
        import yaml
        class Loader(yaml.SafeLoader):
            pass
        # Keep GitHub's YAML 1.2 `on` key as text under the local YAML 1.1 parser.
        root = Path(__file__).resolve().parents[2]
        for name in gate.CALLERS - {"deployment-security.yml"}:
            with self.subTest(workflow=name):
                source = (root / ".github/workflows" / name).read_text()
                jobs = yaml.load(source, Loader=Loader)["jobs"]
                self.assertEqual(jobs["deployment-security"]["uses"], "./.github/workflows/deployment-security.yml")
                for key, job in jobs.items():
                    if key == "deployment-security" or (name == "deploy-uat.yml" and key == "select-target"):
                        continue
                    self.assertTrue(job.get("needs"), f"Ungated root job: {name}/{key}")
                    needs = job["needs"]
                    self.assertIn("deployment-security", [needs] if isinstance(needs, str) else needs)
                    if "uses" in job:
                        self.assertEqual(job["uses"], "./.github/workflows/ios-voice-device.yml")
                        self.assertEqual(job["with"]["security_attempt"], "${{ needs.deployment-security.outputs.attempt }}")
                        continue
                    self.assertEqual(job["steps"][0]["name"], "Require current-attempt deployment security")
        reusable = (root / ".github/workflows/deployment-security.yml").read_text()
        for name in gate.CALLERS - {"deployment-security.yml"}:
            jobs = yaml.safe_load((root / ".github/workflows" / name).read_text())
            self.assertEqual(jobs["permissions"].get("actions"), "read", name)
        self.assertIn("environment: ci-security", reusable)
        self.assertIn("ref: ${{ github.sha }}", reusable)
        self.assertNotIn("application_ref }}\n          persist", reusable)

    def test_partial_rerun_cannot_reuse_previous_clearance(self):
        import yaml
        root = Path(__file__).resolve().parents[2]
        job = yaml.safe_load((root / ".github/workflows/deploy-dev.yml").read_text())["jobs"]["deploy"]
        script = job["steps"][0]["run"]
        for attempt, expected in [("1", 1), ("2", 0), ("", 1)]:
            result = subprocess.run(["bash", "-c", script], env={**os.environ,
                "GITHUB_RUN_ATTEMPT": "2", "SECURITY_ATTEMPT": attempt},
                capture_output=True, timeout=5)
            self.assertEqual(result.returncode, expected)

    def test_native_sources_use_the_resolved_reference(self):
        root = Path(__file__).resolve().parents[2]
        for name in ["ship-ios-testflight.yml", "ship-android-playstore-v1.yml"]:
            source = (root / ".github/workflows" / name).read_text()
            self.assertIn("REQUESTED_SHA: ${{ inputs.sha || needs.deployment-security.outputs.application_sha }}", source)


if __name__ == "__main__":
    unittest.main()

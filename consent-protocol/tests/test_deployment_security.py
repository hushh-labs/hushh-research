# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Real deployment credential and exact-attempt boundaries after worker retirement."""

import os
import subprocess
import sys
import unittest
from copy import deepcopy
from pathlib import Path

# The protocol lane owns the pinned YAML dependency used by workflow contracts.
CI_DIR = str(Path(__file__).resolve().parents[2] / "scripts/ci")
sys.path.insert(0, CI_DIR)
try:
    import deployment_security as gate
finally:
    sys.path.remove(CI_DIR)

SHA = "a" * 40
APP = "b" * 40


def assert_read_only_uat_inspection(case, job):
    case.assertEqual(job.get("if"), "inputs.operation == 'inspect'")
    case.assertEqual(job.get("environment"), {"name": "uat", "deployment": False})
    case.assertEqual(
        job.get("permissions"),
        {"contents": "read", "actions": "read", "checks": "read", "id-token": "write"},
    )
    case.assertNotIn("secrets", job)
    commands = {
        'test "$GITHUB_REF_NAME" = main',
        'python3 scripts/ci/assert-governed-actor.py --surface uat --actor "${GITHUB_ACTOR}"',
        "python3 scripts/ci/uat_release_prerequisites.py validate-inspection",
        'python3 scripts/ci/uat_release_prerequisites.py inspect --authority-sha "$AUTHORITY_SHA" --source-branch "$UAT_SOURCE_BRANCH"',
    }
    actions = {
        "actions/checkout@v6",
        "google-github-actions/auth@v3",
        "google-github-actions/setup-gcloud@v3",
    }
    checkout = next(step for step in job["steps"] if step.get("uses") == "actions/checkout@v6")
    case.assertEqual(checkout.get("with"), {"ref": "${{ github.sha }}", "fetch-depth": 0})
    authentication = next(
        step for step in job["steps"] if step.get("uses") == "google-github-actions/auth@v3"
    )
    case.assertEqual(
        authentication.get("with"),
        {
            "workload_identity_provider": "${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}",
            "service_account": "${{ vars.GCP_DEPLOY_SERVICE_ACCOUNT }}",
            "project_id": "${{ env.GCP_PROJECT_ID }}",
            "create_credentials_file": True,
            "export_environment_variables": True,
        },
    )
    steps = job["steps"]
    case.assertEqual(len(steps), len(commands) + len(actions))
    case.assertEqual({step["run"] for step in steps if "run" in step}, commands)
    case.assertEqual({step["uses"] for step in steps if "uses" in step}, actions)


class DeploymentSecurityTest(unittest.TestCase):
    def fixture(self):
        env = {
            "GITHUB_REPOSITORY": gate.REPOSITORY,
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_SHA": SHA,
            "GITHUB_WORKFLOW_REF": f"{gate.REPOSITORY}/.github/workflows/deploy-dev.yml@refs/heads/main",
            "GITHUB_RUN_ID": "10",
            "GITHUB_RUN_ATTEMPT": "2",
            "DEPLOY_SECURITY_REF": "dev",
            "DEPLOY_SECURITY_ENVIRONMENT": "dev",
            "DEPLOY_SECURITY_SCOPE": "auto",
        }
        run = {
            "id": 10,
            "run_attempt": 2,
            "head_sha": SHA,
            "event": "workflow_dispatch",
            "status": "in_progress",
            "path": ".github/workflows/deploy-dev.yml",
            "repository": {"full_name": gate.REPOSITORY},
        }

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
        self.assertEqual(
            gate.produce(env, read, lambda _: ([{"state": "open"}], ""))["verdict"], "blocked"
        )

    def test_changed_attempt_and_untrusted_workflow_refuse(self):
        for key, value in [
            ("GITHUB_REF", "refs/heads/dev"),
            ("GITHUB_EVENT_NAME", "pull_request_target"),
            ("GITHUB_REPOSITORY", "other/repository"),
            ("GITHUB_RUN_ATTEMPT", "1"),
        ]:
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
        for rows, links in [
            ({}, ""),
            ([{"state": "closed"}], ""),
            ([], '<https://outside.invalid/alerts>; rel="next"'),
        ]:
            with self.subTest(rows=rows, links=links), self.assertRaises(gate.Refused):
                gate.produce(env, read, lambda _, rows=rows, links=links: (rows, links))

    def test_read_only_inspection_exception_rejects_mutation_or_release_credentials(self):
        import yaml

        root = Path(__file__).resolve().parents[2]
        job = yaml.safe_load((root / ".github/workflows/deploy-uat.yml").read_text())["jobs"][
            "inspect-prerequisites"
        ]
        assert_read_only_uat_inspection(self, job)
        for field, value in [
            ("environment", "uat"),
            ("permissions", {"contents": "write", "id-token": "write"}),
            ("secrets", {"GH_SECURITY_ALERTS_TOKEN": "forbidden"}),
            ("steps", job["steps"] + [{"run": "gcloud run deploy forbidden"}]),
        ]:
            with self.subTest(field=field), self.assertRaises(AssertionError):
                assert_read_only_uat_inspection(self, {**job, field: value})

    def test_inspector_cannot_checkout_candidate_or_change_credential_authority(self):
        import yaml

        root = Path(__file__).resolve().parents[2]
        original = yaml.safe_load((root / ".github/workflows/deploy-uat.yml").read_text())["jobs"][
            "inspect-prerequisites"
        ]
        for action, key, value in [
            ("actions/checkout@v6", "ref", "${{ inputs.sha }}"),
            ("actions/checkout@v6", "repository", "other/repository"),
            ("google-github-actions/auth@v3", "credentials_json", "forbidden"),
            ("google-github-actions/auth@v3", "service_account", "other@example.invalid"),
        ]:
            job = deepcopy(original)
            next(step for step in job["steps"] if step.get("uses") == action)["with"][key] = value
            with self.subTest(action=action, key=key), self.assertRaises(AssertionError):
                assert_read_only_uat_inspection(self, job)

    def test_every_caller_requires_isolated_clearance_before_mutation(self):
        import yaml

        root = Path(__file__).resolve().parents[2]
        for name in gate.CALLERS - {"deployment-security.yml"}:
            with self.subTest(workflow=name):
                source = (root / ".github/workflows" / name).read_text()
                jobs = yaml.safe_load(source)["jobs"]
                self.assertEqual(
                    jobs["deployment-security"]["uses"],
                    "./.github/workflows/deployment-security.yml",
                )
                self.assertEqual(
                    jobs["deployment-security"].get("secrets"),
                    {"GH_SECURITY_ALERTS_TOKEN": "${{ secrets.GH_SECURITY_ALERTS_TOKEN }}"},
                )
                for key, job in jobs.items():
                    if name == "deploy-production.yml" and key == "validate-dispatch":
                        self.assertNotIn("needs", job)
                        self.assertEqual(job.get("permissions"), {"contents": "read"})
                        self.assertNotIn("environment", job)
                        self.assertNotIn("secrets", job)
                        continue
                    if name == "deploy-production.yml" and key == "verify-current-production":
                        self.assertEqual(job.get("needs"), "validate-dispatch")
                        self.assertEqual(
                            job.get("environment"), {"name": "production", "deployment": False}
                        )
                        self.assertEqual(
                            job.get("permissions"), {"contents": "read", "id-token": "write"}
                        )
                        self.assertNotIn("secrets", job)
                        self.assertNotIn("uses", job)
                        continue
                    if name == "deploy-uat.yml" and key == "inspect-prerequisites":
                        assert_read_only_uat_inspection(self, job)
                        continue
                    if key == "deployment-security" or (
                        name == "deploy-uat.yml" and key == "select-target"
                    ):
                        continue
                    self.assertTrue(job.get("needs"), f"Ungated root job: {name}/{key}")
                    needs = job["needs"]
                    self.assertIn(
                        "deployment-security", [needs] if isinstance(needs, str) else needs
                    )
                    if "uses" in job:
                        self.assertEqual(job["uses"], "./.github/workflows/ios-voice-device.yml")
                        self.assertEqual(
                            job["with"]["security_attempt"],
                            "${{ needs.deployment-security.outputs.attempt }}",
                        )
                        continue
                    self.assertEqual(
                        job["steps"][0]["name"], "Require current-attempt deployment security"
                    )
        reusable = (root / ".github/workflows/deployment-security.yml").read_text()
        workflow = yaml.safe_load(reusable)
        declaration = workflow.get("on", workflow.get(True))["workflow_call"]
        self.assertEqual(
            declaration.get("secrets"),
            {"GH_SECURITY_ALERTS_TOKEN": {"required": True}},
        )
        for name in gate.CALLERS - {"deployment-security.yml"}:
            jobs = yaml.safe_load((root / ".github/workflows" / name).read_text())
            self.assertEqual(jobs["permissions"].get("actions"), "read", name)
        self.assertIn("environment: ci-security", reusable)
        self.assertIn("ref: ${{ github.sha }}", reusable)
        self.assertNotIn("application_ref }}\n          persist", reusable)

    def test_partial_rerun_cannot_reuse_previous_clearance(self):
        import yaml

        root = Path(__file__).resolve().parents[2]
        job = yaml.safe_load((root / ".github/workflows/deploy-dev.yml").read_text())["jobs"][
            "deploy"
        ]
        script = job["steps"][0]["run"]
        for attempt, expected in [("1", 1), ("2", 0), ("", 1)]:
            result = subprocess.run(  # noqa: S603 - executes the Main-authored guard with synthetic authority
                ["/bin/bash", "-c", script],
                env={
                    "PATH": os.environ["PATH"],
                    "GITHUB_RUN_ATTEMPT": "2",
                    "SECURITY_ATTEMPT": attempt,
                },
                capture_output=True,
                timeout=5,
            )
            self.assertEqual(result.returncode, expected)

    def test_native_sources_use_the_resolved_reference(self):
        root = Path(__file__).resolve().parents[2]
        for name in ["ship-ios-testflight.yml", "ship-android-playstore-v1.yml"]:
            source = (root / ".github/workflows" / name).read_text()
            self.assertIn(
                "REQUESTED_SHA: ${{ inputs.sha || needs.deployment-security.outputs.application_sha }}",
                source,
            )


if __name__ == "__main__":
    unittest.main()

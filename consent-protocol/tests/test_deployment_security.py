# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Real deployment credential and exact-attempt boundaries after worker retirement."""

import os
import subprocess
import sys
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import Mock, patch

# The protocol lane owns the pinned YAML dependency used by workflow contracts.
CI_DIR = str(Path(__file__).resolve().parents[2] / "scripts/ci")
sys.path.insert(0, CI_DIR)
try:
    import deployment_security as gate
    import github_security_receipt as receipt_transport
    import remove_one_uat as removal
finally:
    sys.path.remove(CI_DIR)

SHA = "a" * 40
APP = "b" * 40


def assert_read_only_uat_inspection(case, job, *, prepared=True):
    case.assertEqual(job.get("if"), "inputs.operation == 'inspect'")
    case.assertEqual(job.get("environment"), {"name": "uat", "deployment": False})
    case.assertEqual(
        job.get("permissions"),
        {"contents": "read", "actions": "read", "checks": "read", "id-token": "write"},
    )
    case.assertNotIn("secrets", job)
    commands = {
        f'test "$GITHUB_REF_NAME" = {"uat" if prepared else "main"}',
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
    case.assertEqual(
        checkout.get("with"),
        {"ref": "${{ job.workflow_sha }}" if prepared else "${{ github.sha }}", "fetch-depth": 0},
    )
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

    def test_one_uat_removal_requires_main_clearance_and_actor_before_auth(self):
        import yaml

        env, run, read = self.fixture()
        run["path"] = ".github/workflows/remove-one-uat.yml"
        env["GITHUB_WORKFLOW_REF"] = f"{gate.REPOSITORY}/{run['path']}@refs/heads/main"
        self.assertEqual(gate.verify_run(read, env)["workflow_path"], run["path"])
        env["GITHUB_REF"] = "refs/heads/uat"
        with self.assertRaises(gate.Refused):
            gate.verify_run(read, env)

        root = Path(__file__).resolve().parents[2]
        workflow = yaml.safe_load((root / run["path"]).read_text())
        job = workflow["jobs"]["remove"]
        self.assertEqual(job["environment"], {"name": "uat", "deployment": False})
        self.assertEqual(job["concurrency"]["group"], "deploy-uat")
        steps = job["steps"]
        actor = next(
            i for i, step in enumerate(steps) if "assert-governed-actor.py" in step.get("run", "")
        )
        auth = next(
            i for i, step in enumerate(steps) if step.get("uses") == "google-github-actions/auth@v3"
        )
        self.assertLess(actor, auth)
        for attempt, result in [("1", 1), ("2", 0), ("", 1)]:
            observed = subprocess.run(  # noqa: S603 - reviewed workflow guard with synthetic authority
                ["bash", "-c", steps[0]["run"]],
                env={"SECURITY_ATTEMPT": attempt, "GITHUB_RUN_ATTEMPT": "2"},
                capture_output=True,
                check=False,
            )
            self.assertEqual(observed.returncode, result)

    def test_read_only_inspection_exception_rejects_mutation_or_release_credentials(self):
        import yaml

        root = Path(__file__).resolve().parents[2]
        job = yaml.safe_load(
            (root / ".github/workflows/deploy-uat-implementation.yml").read_text()
        )["jobs"]["inspect-prerequisites"]
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
        original = yaml.safe_load(
            (root / ".github/workflows/deploy-uat-implementation.yml").read_text()
        )["jobs"]["inspect-prerequisites"]
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
        variants = [
            (name, name, False)
            for name in gate.CALLERS
            if name not in ("deploy-dev.yml", "deploy-uat.yml")
        ]
        for lane in ("dev", "uat"):
            caller = yaml.safe_load((root / f".github/workflows/deploy-{lane}.yml").read_text())
            implementation = yaml.safe_load(
                (root / f".github/workflows/deploy-{lane}-implementation.yml").read_text()
            )
            inputs = (caller.get("on") or caller[True])["workflow_dispatch"]["inputs"]
            declared = (implementation.get("on") or implementation[True])["workflow_call"]["inputs"]
            self.assertEqual(set(inputs), set(declared))
            self.assertEqual(
                set(caller["jobs"]),
                {"release", "pod-publication"} if lane == "dev" else {"release"},
            )
            self.assertIn("inspect-routing", inputs["operation"]["options"])
            for key, job in caller["jobs"].items():
                self.assertEqual(
                    job["uses"],
                    f"hushh-labs/hushh-research/.github/workflows/deploy-{lane}-implementation.yml@main",
                )
                self.assertEqual(
                    job["with"], {name: "${{ inputs." + name + " }}" for name in inputs}
                )
                self.assertNotIn("steps", job)
                if key == "release":
                    self.assertNotIn("secrets", job)
                else:
                    self.assertEqual(
                        job["secrets"],
                        {"GH_SECURITY_ALERTS_TOKEN": "${{ secrets.GH_SECURITY_ALERTS_TOKEN }}"},
                    )
        variants.extend(
            (name, name.replace(".yml", "-implementation.yml"), True)
            for name in ("deploy-dev.yml", "deploy-uat.yml")
        )
        for name, source_name, prepared in variants:
            with self.subTest(workflow=source_name):
                source = (root / ".github/workflows" / source_name).read_text()
                jobs = yaml.safe_load(source)["jobs"]
                clearance = jobs["deployment-security"]
                if prepared and name == "deploy-dev.yml":
                    self.assertEqual(
                        clearance["if"],
                        "inputs.target != 'pod-publication' || inputs.operation != 'deploy'",
                    )
                    validation = next(
                        step
                        for step in clearance["steps"]
                        if step.get("name") == "Validate explicit operation"
                    )
                    refused = subprocess.run(  # noqa: S603 - fixed repository guard, synthetic inputs
                        ["bash", "-e", "-c", validation["run"]],
                        env={"OPERATION": "inspect-routing", "TARGET": "pod-publication"},
                        capture_output=True,
                        check=False,
                    )
                    self.assertNotEqual(refused.returncode, 0)
                    for mutation in ("deploy", "pod-security", "pod-publication"):
                        self.assertIn("inputs.operation == 'deploy'", jobs[mutation]["if"])
                if prepared and name == "deploy-uat.yml":
                    self.assertEqual(jobs["select-target"]["if"], "inputs.operation == 'deploy'")
                    for mutation in ("wait-capacity", "deploy"):
                        self.assertEqual(
                            jobs[mutation]["if"],
                            "needs.select-target.outputs.decision == 'DEPLOY_EXACT_SHA'",
                        )
                if prepared:
                    self.assertNotIn("environment", clearance)
                    self.assertNotIn("secrets", clearance)
                    self.assertEqual(
                        clearance["permissions"], {"contents": "read", "actions": "write"}
                    )
                    self.assertEqual(
                        clearance["steps"][0]["with"]["ref"], "${{ job.workflow_sha }}"
                    )
                    self.assertEqual(
                        next(
                            step["run"]
                            for step in clearance["steps"]
                            if step.get("id") == "clearance"
                        ),
                        "python3 scripts/ci/deployment_security.py --request-broker",
                    )
                    if name == "deploy-uat.yml":
                        self.assertEqual(jobs["wait-capacity"]["permissions"]["actions"], "read")
                else:
                    self.assertEqual(
                        clearance["uses"], "./.github/workflows/deployment-security.yml"
                    )
                    self.assertEqual(
                        clearance.get("secrets"),
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
                    if prepared and key == "inspect-routing":
                        self.assertEqual(
                            job["if"],
                            "${{ !cancelled() && needs.deployment-security.result == 'success' && inputs.operation == 'inspect-routing' }}"
                            if name == "deploy-uat.yml"
                            else "inputs.operation == 'inspect-routing'",
                        )
                        self.assertEqual(job["needs"], "deployment-security")
                        self.assertEqual(
                            job["environment"],
                            {
                                "name": name.removeprefix("deploy-").removesuffix(".yml"),
                                "deployment": False,
                            },
                        )
                        self.assertEqual(
                            job["permissions"], {"contents": "read", "id-token": "write"}
                        )
                        self.assertNotIn("secrets", job)
                        self.assertEqual(len(job["steps"]), 4)
                        commands = "\n".join(step.get("run", "") for step in job["steps"])
                        self.assertIn('test "$SECURITY_ATTEMPT" = "$GITHUB_RUN_ATTEMPT"', commands)
                        self.assertIn('gcloud projects describe "$GCP_PROJECT_ID"', commands)
                        self.assertNotRegex(
                            commands, r"gcloud (run|sql|secrets)|git push|curl|python|deploy --"
                        )
                        self.assertEqual(
                            {step["uses"] for step in job["steps"] if "uses" in step},
                            {
                                "google-github-actions/auth@v3",
                                "google-github-actions/setup-gcloud@v3",
                            },
                        )
                        continue
                    if name == "deploy-uat.yml" and key == "inspect-prerequisites":
                        assert_read_only_uat_inspection(self, job, prepared=prepared)
                        continue
                    if name == "deploy-dev.yml" and key == "pod-security":
                        self.assertEqual(job["uses"], "./.github/workflows/deployment-security.yml")
                        self.assertEqual(job["permissions"]["actions"], "read")
                        continue
                    if key == "deployment-security" or (
                        name == "deploy-uat.yml" and key == "select-target"
                    ):
                        continue
                    self.assertTrue(job.get("needs"), f"Ungated root job: {name}/{key}")
                    needs = job["needs"]
                    self.assertIn(
                        "pod-security"
                        if prepared and name == "deploy-dev.yml" and key == "pod-publication"
                        else "deployment-security",
                        [needs] if isinstance(needs, str) else needs,
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
        self.assertEqual(workflow["permissions"]["actions"], "read")
        self.assertEqual(set(workflow["jobs"]), {"alerts"})
        self.assertNotIn("CI_TEAM_APP_PRIVATE_KEY", reusable)
        declaration = workflow.get("on", workflow.get(True))["workflow_call"]
        self.assertEqual(
            declaration.get("secrets"),
            {
                "GH_SECURITY_ALERTS_TOKEN": {"required": False},
            },
        )
        for name in gate.CALLERS:
            jobs = yaml.safe_load((root / ".github/workflows" / name).read_text())
            self.assertEqual(
                jobs["permissions"].get("actions"),
                "write" if name in ("deploy-dev.yml", "deploy-uat.yml") else "read",
                name,
            )
        for name in ("deployment-security.yml", "ios-voice-device.yml"):
            internal = yaml.safe_load((root / ".github/workflows" / name).read_text())
            self.assertEqual(
                set(internal.get("on", internal.get(True))),
                {"workflow_call", "workflow_dispatch"}
                if name == "deployment-security.yml"
                else {"workflow_call"},
            )
            self.assertNotIn(name, gate.CALLERS)
        hardware = yaml.safe_load((root / ".github/workflows/ios-voice-device.yml").read_text())
        self.assertEqual(set(hardware["jobs"]), {"hardware-capture"})
        check = hardware["jobs"]["hardware-capture"]["steps"][0]
        self.assertEqual(check["env"]["SECURITY_ATTEMPT"], "${{ inputs.security_attempt }}")
        self.assertIn('"$SECURITY_ATTEMPT" != "$GITHUB_RUN_ATTEMPT"', check["run"])
        self.assertIn("environment: ci-security", reusable)
        self.assertIn("ref: ${{ github.sha }}", reusable)
        self.assertNotIn("application_ref }}\n          persist", reusable)

    def test_partial_rerun_cannot_reuse_previous_clearance(self):
        import yaml

        root = Path(__file__).resolve().parents[2]
        job = yaml.safe_load(
            (root / ".github/workflows/deploy-dev-implementation.yml").read_text()
        )["jobs"]["deploy"]
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
        for name, binding in {
            "ship-ios-testflight.yml": "SHA: ${{ needs.deployment-security.outputs.application_sha }}",
            "ship-android-playstore-v1.yml": (
                "REQUESTED_SHA: ${{ inputs.sha || needs.deployment-security.outputs.application_sha }}"
            ),
        }.items():
            source = (root / ".github/workflows" / name).read_text()
            self.assertIn(binding, source)


class DeploymentBrokerTest(unittest.TestCase):
    def fixture(self):
        import json

        request = {
            "run_id": 20,
            "attempt": 2,
            "caller_sha": "c" * 40,
            "application_sha": APP,
            "environment": "dev",
            "requested_scope": "all",
            "tooling_sha": SHA,
        }
        repo = {"id": 9, "full_name": gate.REPOSITORY}
        source = {
            "id": 20,
            "run_attempt": 2,
            "head_sha": "c" * 40,
            "head_branch": "dev",
            "event": "workflow_dispatch",
            "status": "in_progress",
            "workflow_id": 30,
            "path": ".github/workflows/deploy-dev.yml",
            "repository": repo,
            "head_repository": repo,
            "actor": {"login": "operator"},
            "triggering_actor": {"login": "operator"},
            "referenced_workflows": [
                {
                    "path": f"{gate.REPOSITORY}/{gate.IMPLEMENTATIONS['dev']}@{SHA}",
                    "ref": "refs/heads/main",
                    "sha": SHA,
                }
            ],
        }
        broker = {
            "id": 40,
            "run_attempt": 1,
            "head_sha": SHA,
            "head_branch": "main",
            "event": "workflow_dispatch",
            "status": "in_progress",
            "workflow_id": 50,
            "path": gate.BROKER_PATH,
            "repository": repo,
            "head_repository": repo,
            "run_started_at": "2026-01-01T00:00:00Z",
            "updated_at": "2027-01-01T00:00:00Z",
        }
        prefix = f"repos/{gate.REPOSITORY}"
        responses = {
            prefix: repo,
            f"{prefix}/actions/runs/20": source,
            f"{prefix}/actions/runs/40": broker,
            f"{prefix}/actions/workflows/deploy-dev.yml": {"id": 30, "path": source["path"]},
            f"{prefix}/actions/workflows/deployment-security.yml": {
                "id": 50,
                "path": gate.BROKER_PATH,
            },
            f"{prefix}/compare/{SHA}...main?per_page=1&page=2": {
                "status": "ahead",
                "merge_base_commit": {"sha": SHA},
            },
            f"{prefix}/compare/{APP}...dev?per_page=1&page=2": {
                "status": "ahead",
                "merge_base_commit": {"sha": APP},
            },
        }
        env = {
            "GITHUB_REPOSITORY": gate.REPOSITORY,
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_SHA": SHA,
            "GITHUB_WORKFLOW_REF": f"{gate.REPOSITORY}/{gate.BROKER_PATH}@refs/heads/main",
            "GITHUB_RUN_ID": "40",
            "GITHUB_RUN_ATTEMPT": "1",
            "DEPLOY_SECURITY_REQUEST": json.dumps(request),
        }
        policy = {"dev": {"manual_dispatch_users": ["operator"]}}
        return env, request, source, broker, responses, policy

    def test_main_broker_binds_matching_branch_source_and_rechecks_attempts(self):
        env, request, source, broker, responses, policy = self.fixture()
        result = gate.produce_broker(env, responses.__getitem__, lambda _: ([], ""), policy=policy)
        self.assertEqual(result["source"]["attempt"], 2)
        self.assertEqual(result["producer"]["attempt"], 1)
        self.assertEqual(result["source"]["application_sha"], APP)
        self.assertEqual(result["source"]["tooling_sha"], SHA)
        for target in (source, broker):
            with self.subTest(target=target["id"]):
                old_attempt = target["run_attempt"]

                def alerts(_, target=target):
                    target["run_attempt"] += 1
                    return [], ""

                with self.assertRaises(gate.Refused):
                    gate.produce_broker(env, responses.__getitem__, alerts, policy=policy)
                target["run_attempt"] = old_attempt

    def test_uat_broker_separates_protected_application_from_caller(self):
        _, request, source, _, responses, _ = self.fixture()
        prefix = f"repos/{gate.REPOSITORY}"
        request.update(environment="uat", application_branch="uat-isolated")
        source.update(head_branch="uat", path=".github/workflows/deploy-uat.yml")
        source["referenced_workflows"][0]["path"] = (
            f"{gate.REPOSITORY}/{gate.IMPLEMENTATIONS['uat']}@{SHA}"
        )
        responses[f"{prefix}/actions/workflows/deploy-uat.yml"] = {
            "id": 30,
            "path": source["path"],
        }
        branch = {"protected": True, "commit": {"sha": APP}}
        responses[f"{prefix}/branches/uat-isolated"] = branch
        responses[f"{prefix}/compare/{APP}...uat-isolated?per_page=1&page=2"] = {
            "status": "identical",
            "merge_base_commit": {"sha": APP},
        }
        policy = {"uat": {"manual_dispatch_users": ["operator"]}}
        admitted = gate.verify_deployment(responses.__getitem__, request, policy)
        self.assertEqual(admitted["caller_branch"], "uat")
        self.assertEqual(admitted["application_branch"], "uat-isolated")
        branch["commit"] = {"sha": SHA}
        with self.assertRaisesRegex(gate.Refused, "protected isolated UAT tip"):
            gate.verify_deployment(responses.__getitem__, request, policy)

    def test_wrong_branch_operator_source_and_implementation_refuse_before_alert_access(self):
        for key, value in [
            ("head_branch", "main"),
            ("event", "pull_request"),
            ("run_attempt", 1),
            ("status", "completed"),
            ("workflow_id", 31),
            ("head_sha", "d" * 40),
            ("actor", {"login": "unapproved"}),
            ("triggering_actor", {"login": "unapproved"}),
            ("head_repository", {"id": 10, "full_name": "fork/repo"}),
            ("referenced_workflows", []),
            ("referenced_workflows", [{"path": "untrusted", "sha": SHA}]),
        ]:
            env, _, source, _, responses, policy = self.fixture()
            source[key] = value
            with self.subTest(key=key), self.assertRaises(gate.Refused):
                gate.produce_broker(
                    env,
                    responses.__getitem__,
                    lambda _: self.fail("alerts accessed before source admission"),
                    policy=policy,
                )
        _, request, _, _, responses, policy = self.fixture()
        for key, value in [
            ("environment", "production"),
            ("application_sha", "dev"),
            ("requested_scope", "native"),
            ("run_id", True),
            ("unknown", "extra"),
        ]:
            with self.subTest(key=key), self.assertRaises(gate.Refused):
                gate.verify_deployment(responses.__getitem__, {**request, key: value}, policy)

    def test_lost_dispatch_response_is_not_retried(self):
        import tempfile
        from unittest.mock import patch

        _, request, _, _, _, policy = self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            env = {
                "GITHUB_REPOSITORY": gate.REPOSITORY,
                "GITHUB_REF": "refs/heads/dev",
                "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_RUN_ID": "20",
                "GITHUB_RUN_ATTEMPT": "2",
                "GITHUB_SHA": request["caller_sha"],
                "RELEASE_TOOLING_SHA": SHA,
                "DEPLOY_SECURITY_REF": APP,
                "DEPLOY_SECURITY_ENVIRONMENT": "dev",
                "DEPLOY_SECURITY_SCOPE": "all",
                "RUNNER_TEMP": directory,
            }
            calls = []

            def api(path, data=None):
                calls.append((path, data))
                raise gate.Refused("dispatch outcome unknown")

            with (
                patch.object(gate, "verify_deployment", return_value={}),
                self.assertRaises(gate.Refused),
            ):
                gate.request_broker(env, api=api)
            self.assertEqual(len(calls), 1)
            self.assertEqual(set(calls[0][1]), {"ref", "inputs"})
            self.assertEqual(calls[0][1]["ref"], "main")
            self.assertTrue((Path(directory) / "deployment-security-request.json").exists())
            with (
                patch.object(gate, "verify_deployment", return_value={}),
                self.assertRaises(FileExistsError),
            ):
                gate.request_broker(env, api=api)
            self.assertEqual(len(calls), 1)

    def test_consumption_requires_exact_artifact_step_and_current_broker_attempt(self):
        import hashlib
        import io
        import json
        from types import SimpleNamespace
        from unittest.mock import patch
        from zipfile import ZipFile

        env, request, _, broker, responses, policy = self.fixture()
        receipt = gate.produce_broker(env, responses.__getitem__, lambda _: ([], ""), policy=policy)
        broker.update(status="completed", conclusion="success")
        stream = io.BytesIO()
        with ZipFile(stream, "w") as archive:
            archive.writestr("deployment-security.json", json.dumps(receipt))
        raw = stream.getvalue()
        prefix = f"repos/{gate.REPOSITORY}/actions/runs/40"
        job = {
            "run_id": 40,
            "run_attempt": 1,
            "name": "Verify repository secret clearance",
            "status": "completed",
            "conclusion": "success",
            "steps": [{"name": "Read protected repository inventory", "conclusion": "success"}],
        }
        artifact = {
            "id": 70,
            "name": "deployment-security-40-1",
            "expired": False,
            "workflow_run": {"id": 40},
            "size_in_bytes": len(raw),
            "digest": "sha256:" + hashlib.sha256(raw).hexdigest(),
            "created_at": receipt["recorded_at"],
        }
        responses[f"{prefix}/attempts/1/jobs?per_page=100"] = {
            "total_count": 1,
            "jobs": [job],
        }
        responses[f"{prefix}/artifacts?per_page=100"] = {"total_count": 1, "artifacts": [artifact]}
        api = SimpleNamespace(read=lambda path: deepcopy(responses[path]))
        with patch.object(receipt_transport, "archive_read", return_value=raw):
            self.assertEqual(gate.consume_broker(api, request, 40, policy), receipt)
            for row, key, value in [
                (artifact, "digest", "sha256:" + "0" * 64),
                (artifact, "expired", True),
                (job["steps"][0], "conclusion", "skipped"),
                (broker, "conclusion", "failure"),
            ]:
                original = row[key]
                row[key] = value
                with self.subTest(key=key), self.assertRaises(gate.Refused):
                    gate.consume_broker(api, request, 40, policy)
                row[key] = original
            calls = 0

            def read(path):
                nonlocal calls
                result = deepcopy(responses[path])
                if path == prefix:
                    calls += 1
                    if calls > 1:
                        result["run_attempt"] = 2
                        result["conclusion"] = "failure"
                return result

            with self.assertRaises(gate.Refused):
                gate.consume_broker(SimpleNamespace(read=read), request, 40, policy)


class RemoveOneUatTest(unittest.TestCase):
    def setUp(self):
        self.token = "synthetic"
        self.service = {"name": removal.SERVICE, "uid": removal.EXPECTED_UID, "etag": '"etag"'}
        self.operation = {
            "name": "projects/745506018753/locations/us-central1/operations/test-operation",
            "done": True,
        }
        self.records = []

    def run_removal(self, call, *, execute=True):
        return removal.remove_one_uat(
            call, execute=execute, record=lambda report: self.records.append(deepcopy(report))
        )

    def test_deletion_is_etag_guarded_journaled_and_verified(self):
        def call(method, name, **kwargs):
            if method == "DELETE":
                self.assertEqual(self.records[-1]["status"], "delete_submitting")
                self.assertEqual(name, removal.SERVICE)
                self.assertEqual(kwargs, {"etag": self.service["etag"]})
                return self.operation
            return (
                self.service if not any(r["status"] == "deleting" for r in self.records) else None
            )

        self.assertEqual(self.run_removal(call)["status"], "deleted")

    def test_inspection_and_already_absent_are_read_only(self):
        for service, status in [(self.service, "inspected"), (None, "already_absent")]:
            with self.subTest(status=status):
                call = Mock(return_value=service)
                self.assertEqual(self.run_removal(call, execute=False)["status"], status)
                call.assert_called_once_with("GET", removal.SERVICE)
        call = Mock(return_value=None)
        self.assertEqual(self.run_removal(call)["status"], "already_absent")
        call.assert_called_once_with("GET", removal.SERVICE)

    def test_changed_identity_missing_etag_and_reconciling_refuse_before_delete(self):
        for change in (
            {"name": removal.SERVICE.replace("one-uat", "consent-protocol")},
            {"uid": "replacement-service"},
            {"etag": ""},
            {"etag": None},
            {"reconciling": True},
            {"deleteTime": "2026-11-07T00:00:00Z"},
        ):
            with self.subTest(change=change):
                call = Mock(return_value={**self.service, **change})
                with self.assertRaises(removal.Refused):
                    self.run_removal(call)
                call.assert_called_once_with("GET", removal.SERVICE)
                self.assertEqual(self.records[-1]["status"], "refused")

    def test_denied_observation_is_never_absence(self):
        call = Mock(side_effect=removal.Refused("cloud_run_http_403"))
        with self.assertRaises(removal.Refused):
            self.run_removal(call)
        call.assert_called_once_with("GET", removal.SERVICE)
        self.assertEqual(self.records[-1]["status"], "refused")

    def test_real_transport_distinguishes_get_404_from_denial_and_delete_404(self):
        for method, status in (("GET", 404), ("GET", 403), ("DELETE", 404)):
            with self.subTest(method=method, status=status):
                connection = Mock()
                connection.getresponse.return_value.status = status
                with patch.object(removal.http.client, "HTTPSConnection", return_value=connection):
                    if (method, status) == ("GET", 404):
                        self.assertIsNone(
                            removal.request(method, removal.SERVICE, token=self.token)
                        )
                    else:
                        with self.assertRaises(removal.Refused):
                            removal.request(method, removal.SERVICE, token=self.token)
                connection.close.assert_called_once()

    def test_real_transport_sends_current_etag_to_the_fixed_google_host(self):
        connection = Mock()
        connection.getresponse.return_value.status = 200
        connection.getresponse.return_value.read.return_value = b'{"done":true}'
        with patch.object(
            removal.http.client, "HTTPSConnection", return_value=connection
        ) as open_connection:
            removal.request("DELETE", removal.SERVICE, token=self.token, etag='"a/b"')
        open_connection.assert_called_once_with("run.googleapis.com", timeout=30)
        self.assertEqual(
            connection.request.call_args.args,
            ("DELETE", "/v2/" + removal.SERVICE + "?etag=%22a%2Fb%22"),
        )

    def test_delete_refusal_or_lost_response_preserves_uncertain_intent(self):
        for error in (removal.Refused("cloud_run_http_409"), TimeoutError()):
            with self.subTest(error=type(error).__name__):
                call = Mock(side_effect=[self.service, error])
                with self.assertRaises(type(error)):
                    self.run_removal(call)
                self.assertEqual(call.call_count, 2)
                self.assertEqual(self.records[-1]["status"], "uncertain")

    def test_operation_identity_error_and_missing_observation_refuse(self):
        for operation in (
            None,
            {**self.operation, "name": self.operation["name"].replace("745506018753", "other")},
            {**self.operation, "error": {"code": 7}},
            {**self.operation, "done": False},
        ):
            with self.subTest(operation=operation), patch.object(removal.time, "sleep"):
                call = Mock(side_effect=[self.service, operation, None])
                with self.assertRaises(removal.Refused):
                    self.run_removal(call)
                self.assertIn(self.records[-1]["status"], {"failed", "uncertain"})

    def test_operation_poll_and_final_absence_are_both_required(self):
        pending = {**self.operation, "done": False}
        call = Mock(side_effect=[self.service, pending, self.operation, self.service, None])
        with patch.object(removal.time, "sleep"):
            self.assertEqual(self.run_removal(call)["status"], "deleted")
        self.assertEqual(call.call_args_list[-1].args, ("GET", removal.SERVICE))
        self.assertEqual(call.call_count, 5)

    def test_incomplete_operation_or_unconfirmed_absence_times_out_uncertain(self):
        for operation in (self.operation, {**self.operation, "done": False}):
            with self.subTest(operation=operation), patch.object(removal, "WAIT_SECONDS", 0):
                call = Mock(side_effect=[self.service, operation, self.service])
                with self.assertRaises(removal.Refused):
                    self.run_removal(call)
                self.assertEqual(self.records[-1]["status"], "uncertain")


if __name__ == "__main__":
    unittest.main()

# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Real deployment credential and exact-attempt boundaries after worker retirement."""

import json
import os
import subprocess
import sys
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

# The protocol lane owns the pinned YAML dependency used by workflow contracts.
CI_DIR = str(Path(__file__).resolve().parents[2] / "scripts/ci")
sys.path.insert(0, CI_DIR)
try:
    import deployment_security as gate
    import github_security_receipt as receipt_transport
finally:
    sys.path.remove(CI_DIR)

SHA = "a" * 40
APP = "b" * 40


def install_membership_fixture(case):
    case.memberships = {
        slug: [{"id": 55, "login": "operator", "type": "User"}] for slug in gate.TEAM_IDS
    }

    def read(path):
        slug = path.split("/")[3]
        if "/members?" in path:
            return deepcopy(case.memberships[slug])
        return {"id": gate.TEAM_IDS[slug], "slug": slug, "parent": None}

    case.member_read = read
    reader = patch.object(gate, "team_reader", return_value=read)
    reader.start()
    case.addCleanup(reader.stop)


def assert_read_only_uat_inspection(case, job, *, prepared=True):
    # Inspection skips select-target; the transitive skip must not suppress it.
    case.assertEqual(
        job.get("if"),
        "${{ !cancelled() && needs.deployment-security.result == 'success' && inputs.operation == 'inspect' }}",
    )
    case.assertEqual(job.get("environment"), {"name": "uat", "deployment": False})
    case.assertEqual(
        job.get("permissions"),
        {"contents": "read", "actions": "write", "checks": "read", "id-token": "write"},
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
    def setUp(self):
        install_membership_fixture(self)

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
            "actor": {"id": 55, "login": "operator", "type": "User"},
            "triggering_actor": {"id": 55, "login": "operator", "type": "User"},
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
        self.assertEqual(result["authorization"]["team"], "deploy-dev")
        self.assertEqual(result["authorization"]["source"], result["source"])
        self.assertNotIn("memberships", result["authorization"])
        context = {
            **env,
            "GITHUB_ACTIONS": "true",
            "GITHUB_REPOSITORY_ID": "9",
            "GITHUB_ACTOR": "operator",
            "GITHUB_ACTOR_ID": "55",
            "GITHUB_TRIGGERING_ACTOR": "operator",
            "RELEASE_APPLICATION_SHA": APP,
        }
        gate.verify_forwarded_authorization(
            context,
            json.dumps(gate.forwarded_authorization(result, context)),
            "dev",
            "operator",
        )
        self.assertEqual(result["dependabot"]["open"], 1)
        self.assertEqual(
            gate.produce(env, read, lambda _: ([{"state": "open"}], ""))["verdict"], "blocked"
        )

        # Historical records do not reinstate retired standalone entrypoints.
        for caller, environment in (
            ("ios-voice-device.yml", "native"),
            ("resume-ios-testflight.yml", "native"),
            ("deploy-uat-one-chat.yml", "uat"),
        ):
            legacy_env, legacy_run, legacy_read = self.fixture()
            legacy_run["path"] = f".github/workflows/{caller}"
            legacy_env.update(
                GITHUB_WORKFLOW_REF=f"{gate.REPOSITORY}/{legacy_run['path']}@refs/heads/main",
                DEPLOY_SECURITY_ENVIRONMENT=environment,
            )
            with self.subTest(caller=caller):
                with self.assertRaisesRegex(gate.Refused, "explicit Main-owned release"):
                    gate.produce(legacy_env, legacy_read, lambda _: ([], ""))
                legacy_env["DEPLOY_SECURITY_ENVIRONMENT"] = "production"
                with self.assertRaises(gate.Refused):
                    gate.produce(legacy_env, legacy_read, lambda _: ([], ""))

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
        for caller, environment, team in [
            ("ship-ios-testflight.yml", "native", "deploy-uat"),
            ("release-ios-appstore.yml", "native", "deploy-production"),
            ("ship-android-playstore-v1.yml", "native", "deploy-production"),
            ("publish-hushh-mcp.yml", "package", "deploy-production"),
            ("validate-plg-frontend-source.yml", "validation", "deploy-production"),
            ("rollback.yml", "uat", "deploy-uat"),
            ("rollback.yml", "production", "deploy-production"),
        ]:
            with self.subTest(caller=caller, environment=environment):
                env, run, read = self.fixture()
                path = f".github/workflows/{caller}"
                run["path"] = path
                env["GITHUB_WORKFLOW_REF"] = f"{gate.REPOSITORY}/{path}@refs/heads/main"
                env["DEPLOY_SECURITY_ENVIRONMENT"] = environment
                result = gate.produce(env, read, lambda _: ([], ""))
                self.assertEqual(result["authorization"]["team"], team)
                run["triggering_actor"] = {"id": 56, "login": "outsider", "type": "User"}
                with self.assertRaisesRegex(gate.Refused, "rerunner"):
                    gate.produce(env, read, lambda _: self.fail("Unauthorized inventory read"))
                env["DEPLOY_SECURITY_ENVIRONMENT"] = "dev"
                with self.assertRaisesRegex(gate.Refused, "capability"):
                    gate.produce(
                        env, read, lambda _: self.fail("Wrong capability reached inventory")
                    )

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

    def test_live_team_actor_steps_receive_their_existing_job_token(self):
        import yaml

        root = Path(__file__).resolve().parents[2]
        for path in (root / ".github/workflows").glob("*.yml"):
            workflow = yaml.safe_load(path.read_text())
            for job in workflow.get("jobs", {}).values():
                for step in job.get("steps", []):
                    if not any(
                        caller in step.get("run", "")
                        for caller in (
                            "assert-governed-actor.py",
                            "wait-uat-capacity.py",
                            "production_emergency.py dispatch",
                            "frontend_validation.py finalize",
                        )
                    ):
                        continue
                    with self.subTest(workflow=path.name, step=step.get("name")):
                        env = {
                            **workflow.get("env", {}),
                            **job.get("env", {}),
                            **step.get("env", {}),
                        }
                        self.assertIn(
                            env.get("GH_TOKEN") or env.get("GITHUB_TOKEN"),
                            ("${{ github.token }}", "${{ secrets.GITHUB_TOKEN }}"),
                        )
                        permissions = job.get("permissions", workflow.get("permissions", {}))
                        if "wait-uat-capacity.py" in step.get("run", ""):
                            self.assertEqual(permissions.get("actions"), "read")
                            self.assertEqual(
                                env.get("RELEASE_AUTHORIZATION"),
                                "${{ needs.deployment-security.outputs.authorization }}",
                            )
                            self.assertEqual(
                                env.get("RELEASE_APPLICATION_SHA"),
                                "${{ needs.deployment-security.outputs.application_sha }}",
                            )
                        else:
                            self.assertEqual(permissions.get("actions"), "write")

    def test_read_only_inspection_exception_rejects_mutation_or_release_credentials(self):
        import yaml

        root = Path(__file__).resolve().parents[2]
        job = yaml.safe_load(
            (root / ".github/workflows/deploy-uat-implementation.yml").read_text()
        )["jobs"]["inspect-prerequisites"]
        assert_read_only_uat_inspection(self, job)
        for field, value in [
            ("if", "inputs.operation == 'inspect'"),
            ("if", "${{ !cancelled() && inputs.operation == 'inspect' }}"),
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
        protected_secrets = {
            name: "${{ secrets." + name + " }}"
            for name in ("CI_TEAM_APP_PRIVATE_KEY", "GH_SECURITY_ALERTS_TOKEN")
        }
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
            for job in caller["jobs"].values():
                self.assertEqual(
                    job["uses"],
                    f"hushh-labs/hushh-research/.github/workflows/deploy-{lane}-implementation.yml@main",
                )
                self.assertEqual(
                    job["with"], {name: "${{ inputs." + name + " }}" for name in inputs}
                )
                self.assertNotIn("steps", job)
                self.assertEqual(job["secrets"], protected_secrets)
            self.assertEqual(
                (implementation.get("on") or implementation[True])["workflow_call"]["secrets"],
                {name: {"required": True} for name in protected_secrets},
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
                    for mutation in ("deploy", "pod-security", "pod-publication"):
                        self.assertIn("inputs.operation == 'deploy'", jobs[mutation]["if"])
                if prepared and name == "deploy-uat.yml":
                    self.assertEqual(jobs["select-target"]["if"], "inputs.operation == 'deploy'")
                    for mutation in ("wait-capacity", "deploy"):
                        self.assertEqual(
                            jobs[mutation]["if"],
                            "needs.select-target.outputs.decision == 'DEPLOY_EXACT_SHA'",
                        )
                self.assertEqual(clearance["uses"], "./.github/workflows/deployment-security.yml")
                self.assertNotIn("environment", clearance)
                self.assertEqual(clearance.get("secrets"), protected_secrets)
                if prepared:
                    self.assertEqual(
                        clearance["permissions"],
                        {"contents": "read", "actions": "read", "pull-requests": "read"},
                    )
                    self.assertNotIn("steps", clearance)
                for key, job in jobs.items():
                    if name == "deploy-production.yml" and key == "validate-dispatch":
                        self.assertNotIn("needs", job)
                        self.assertEqual(
                            job.get("permissions"), {"contents": "read", "actions": "write"}
                        )
                        self.assertNotIn("environment", job)
                        self.assertNotIn("secrets", job)
                        continue
                    if name == "deploy-production.yml" and key == "verify-current-production":
                        self.assertEqual(job.get("needs"), "validate-dispatch")
                        self.assertEqual(
                            job.get("environment"), {"name": "production", "deployment": False}
                        )
                        self.assertEqual(
                            job.get("permissions"),
                            {"contents": "read", "id-token": "write", "actions": "write"},
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
                        self.assertEqual(job["secrets"], protected_secrets)
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
                    for step in job["steps"]:
                        if "assert-governed-actor.py" in step.get("run", ""):
                            issuer = (
                                "pod-security"
                                if key == "pod-publication"
                                else "deployment-security"
                            )
                            self.assertEqual(
                                step["env"]["RELEASE_AUTHORIZATION"],
                                (
                                    "${{ inputs.security_authorization || needs.deployment-security.outputs.authorization }}"
                                    if name == "ios-voice-device.yml"
                                    else "${{ needs." + issuer + ".outputs.authorization }}"
                                ),
                            )
                    self.assertEqual(
                        job["steps"][0]["name"], "Require current-attempt deployment security"
                    )
        reusable = (root / ".github/workflows/deployment-security.yml").read_text()
        workflow = yaml.safe_load(reusable)
        self.assertEqual(workflow["permissions"]["actions"], "read")
        self.assertEqual(set(workflow["jobs"]), {"alerts"})
        membership = next(
            step for step in workflow["jobs"]["alerts"]["steps"] if step.get("id") == "membership"
        )
        self.assertEqual(membership["with"]["permission-members"], "read")
        self.assertEqual(
            membership["with"]["private-key"], "${{ secrets.CI_TEAM_APP_PRIVATE_KEY }}"
        )
        inventory_step = next(
            step for step in workflow["jobs"]["alerts"]["steps"] if step.get("id") == "clearance"
        )
        self.assertEqual(
            inventory_step["env"]["CI_TEAM_MEMBERS_TOKEN"],
            "${{ steps.membership.outputs.token }}",
        )
        declaration = workflow.get("on", workflow.get(True))["workflow_call"]
        self.assertEqual(
            declaration.get("secrets"),
            {
                "GH_SECURITY_ALERTS_TOKEN": {"required": True},
                "CI_TEAM_APP_PRIVATE_KEY": {"required": True},
            },
        )
        for name in gate.CALLERS:
            jobs = yaml.safe_load((root / ".github/workflows" / name).read_text())
            self.assertEqual(
                jobs["permissions"].get("actions"),
                "write" if name in ("deploy-dev.yml", "deploy-uat.yml") else "read",
                name,
            )
        for name in ("deployment-security.yml",):
            internal = yaml.safe_load((root / ".github/workflows" / name).read_text())
            self.assertEqual(
                set(internal.get("on", internal.get(True))),
                {"workflow_call", "workflow_dispatch"}
                if name == "deployment-security.yml"
                else {"workflow_call"},
            )
            self.assertNotIn(name, gate.CALLERS)
        hardware = yaml.safe_load((root / ".github/workflows/ios-voice-device.yml").read_text())
        self.assertEqual(set(hardware["jobs"]), {"deployment-security", "hardware-capture"})
        check = hardware["jobs"]["hardware-capture"]["steps"][0]
        self.assertEqual(
            check["env"]["SECURITY_ATTEMPT"],
            "${{ inputs.security_attempt || needs.deployment-security.outputs.attempt }}",
        )
        self.assertIn('"$SECURITY_ATTEMPT" != "$GITHUB_RUN_ATTEMPT"', check["run"])
        actor = next(
            step
            for step in hardware["jobs"]["hardware-capture"]["steps"]
            if "assert-governed-actor.py" in step.get("run", "")
        )
        self.assertEqual(
            actor["env"]["RELEASE_AUTHORIZATION"],
            "${{ inputs.security_authorization || needs.deployment-security.outputs.authorization }}",
        )
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
    def setUp(self):
        install_membership_fixture(self)

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
            "actor": {"id": 55, "login": "operator", "type": "User"},
            "triggering_actor": {"id": 55, "login": "operator", "type": "User"},
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
        # A new live member need not be present in the source policy's old roster.
        policy["dev"]["manual_dispatch_users"] = []
        result = gate.produce_broker(env, responses.__getitem__, lambda _: ([], ""), policy=policy)
        self.assertEqual(result["source"]["attempt"], 2)
        self.assertEqual(result["producer"]["attempt"], 1)
        self.assertEqual(result["source"]["application_sha"], APP)
        self.assertEqual(result["source"]["tooling_sha"], SHA)
        self.assertEqual(result["authorization"]["team"], "deploy-dev")
        self.assertEqual(result["authorization"]["producer"], result["producer"])
        self.assertEqual(result["authorization"]["actor"]["id"], 55)
        for target in (source, broker):
            with self.subTest(target=target["id"]):
                old_attempt = target["run_attempt"]

                def alerts(_, target=target):
                    target["run_attempt"] += 1
                    return [], ""

                with self.assertRaises(gate.Refused):
                    gate.produce_broker(env, responses.__getitem__, alerts, policy=policy)
                target["run_attempt"] = old_attempt

    def test_removed_member_and_revocation_during_inventory_refuse(self):
        env, _, _, _, responses, policy = self.fixture()
        replacement = {"id": 56, "login": "other", "type": "User"}
        self.memberships["allowed-maintainers-to-approve"].append(replacement)
        self.memberships["deploy-dev"] = [replacement]
        with self.assertRaises(gate.Refused):
            gate.produce_broker(
                env,
                responses.__getitem__,
                lambda _: self.fail("Revoked member reached protected inventory"),
                policy=policy,
            )
        self.memberships["deploy-dev"] = [{"id": 55, "login": "operator", "type": "User"}]

        def revoke(_):
            self.memberships["deploy-dev"] = [replacement]
            return [], ""

        with self.assertRaises(gate.Refused):
            gate.produce_broker(env, responses.__getitem__, revoke, policy=policy)

    def test_verified_main_decision_reaches_actor_guard_without_saved_roster(self):
        import importlib.util
        import json

        env, request, _, _, responses, policy = self.fixture()
        policy["dev"]["manual_dispatch_users"] = []
        receipt = gate.produce_broker(env, responses.__getitem__, lambda _: ([], ""), policy=policy)
        self.assertEqual(
            gate.verify_deployment_source(responses.__getitem__, request),
            receipt["source"],
        )
        context = {
            "GITHUB_ACTIONS": "true",
            "GITHUB_REPOSITORY": gate.REPOSITORY,
            "GITHUB_REPOSITORY_ID": "9",
            "GITHUB_RUN_ID": "20",
            "GITHUB_RUN_ATTEMPT": "2",
            "GITHUB_SHA": "c" * 40,
            "GITHUB_REF": "refs/heads/dev",
            "GITHUB_WORKFLOW_REF": f"{gate.REPOSITORY}/.github/workflows/deploy-dev.yml@refs/heads/dev",
            "GITHUB_ACTOR": "operator",
            "GITHUB_ACTOR_ID": "55",
            "GITHUB_TRIGGERING_ACTOR": "operator",
            "RELEASE_APPLICATION_SHA": APP,
            "RELEASE_TOOLING_SHA": SHA,
        }
        document = gate.forwarded_authorization(receipt, context)
        raw = json.dumps(document)
        gate.verify_forwarded_authorization(context, raw, "dev", "operator")
        for key, value in [
            ("GITHUB_REPOSITORY_ID", "10"),
            ("GITHUB_RUN_ID", "21"),
            ("GITHUB_RUN_ATTEMPT", "3"),
            ("GITHUB_SHA", "d" * 40),
            ("GITHUB_ACTOR_ID", "56"),
            ("GITHUB_TRIGGERING_ACTOR", "outsider"),
            ("GITHUB_REF", "refs/heads/uat"),
            ("RELEASE_APPLICATION_SHA", "d" * 40),
            ("RELEASE_TOOLING_SHA", "d" * 40),
        ]:
            with self.subTest(key=key), self.assertRaises(gate.Refused):
                gate.verify_forwarded_authorization({**context, key: value}, raw, "dev", "operator")
        with self.assertRaises(gate.Refused):
            gate.verify_forwarded_authorization(context, raw, "production", "operator")
        legacy = deepcopy(receipt)
        legacy.pop("authorization")
        with self.assertRaises(gate.Refused):
            gate.forwarded_authorization(legacy, context)

        spec = importlib.util.spec_from_file_location(
            "actor_guard", Path(CI_DIR) / "assert-governed-actor.py"
        )
        guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guard)
        with (
            patch.object(sys, "argv", ["actor_guard", "--surface", "dev", "--actor", "operator"]),
            patch.dict(os.environ, {**context, "RELEASE_AUTHORIZATION": raw}, clear=True),
            patch.object(Path, "read_text", side_effect=AssertionError("saved roster consulted")),
            patch("github_team_authority.request_operation_authority", return_value={}),
        ):
            self.assertEqual(guard.main(), 0)
            os.environ["RELEASE_AUTHORIZATION"] = ""
            with self.assertRaises(SystemExit):
                guard.main()

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
                patch.object(gate, "verify_deployment_source", return_value={}),
                self.assertRaises(gate.Refused),
            ):
                gate.request_broker(env, api=api)
            self.assertEqual(len(calls), 1)
            self.assertEqual(set(calls[0][1]), {"ref", "inputs"})
            self.assertEqual(calls[0][1]["ref"], "main")
            self.assertTrue((Path(directory) / "deployment-security-request.json").exists())
            with (
                patch.object(gate, "verify_deployment_source", return_value={}),
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
        with patch.object(receipt_transport, "archive_read", return_value=raw) as download:
            self.assertEqual(gate.consume_broker(api, request, 40, policy), receipt)
            self.assertEqual(
                gate.consume_broker(api, request, 40, {"dev": {"manual_dispatch_users": []}}),
                receipt,
            )
            reported_steps = job["steps"]
            job["steps"] = []
            self.assertEqual(gate.consume_broker(api, request, 40, policy), receipt)

            def publish(document):
                stream = io.BytesIO()
                with ZipFile(stream, "w") as archive:
                    archive.writestr("deployment-security.json", json.dumps(document))
                payload = stream.getvalue()
                artifact.update(
                    size_in_bytes=len(payload),
                    digest="sha256:" + hashlib.sha256(payload).hexdigest(),
                )
                download.return_value = payload

            legacy = deepcopy(receipt)
            legacy.pop("authorization")
            publish(legacy)
            with self.assertRaisesRegex(gate.Refused, "without typed authorization"):
                gate.consume_broker(api, request, 40, policy)
            job["steps"] = reported_steps
            self.assertEqual(gate.consume_broker(api, request, 40, policy), legacy)
            with self.assertRaises(gate.Refused):
                gate.consume_broker(api, request, 40)
            job["steps"] = []
            for key, value in [
                ("team_id", 1),
                ("team", "deploy-production"),
                ("actor", {"id": 56, "login": "operator"}),
                ("producer", {}),
                ("source", {}),
            ]:
                forged = deepcopy(receipt)
                forged["authorization"][key] = value
                publish(forged)
                with (
                    self.subTest(authorization=key),
                    self.assertRaisesRegex(gate.Refused, "binding mismatch"),
                ):
                    gate.consume_broker(api, request, 40, policy)
            publish(receipt)
            principal = responses[f"repos/{gate.REPOSITORY}/actions/runs/20"]["triggering_actor"]
            principal["id"] = 56
            with self.assertRaisesRegex(gate.Refused, "binding mismatch"):
                gate.consume_broker(api, request, 40, policy)
            principal["id"] = 55
            job["steps"] = reported_steps
            for row, key, value in [
                (artifact, "digest", "sha256:" + "0" * 64),
                (artifact, "expired", True),
                (job["steps"][0], "conclusion", "skipped"),
                (job["steps"][0], "conclusion", "failure"),
                (job["steps"][0], "conclusion", "cancelled"),
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


if __name__ == "__main__":
    unittest.main()

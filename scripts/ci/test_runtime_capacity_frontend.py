"""Regression checks for private frontend capacity identity binding."""

import copy
import hashlib
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import yaml

import runtime_capacity_frontend as subject
import runtime_capacity_inventory as inventory


class BudgetError(Exception):
    pass


class Binding:
    def __init__(
        self, environment, run_id, attempt, service_uid, revision_uid, document
    ):
        self.environment = environment
        self.run_id = run_id
        self.attempt = attempt
        self.service_uid = service_uid
        self.revision_uid = revision_uid
        self.service_document = document

    def pin(self):
        return {"runId": self.run_id, "directCloudSqlConnections": 0}


class FrontendFixture(unittest.TestCase):
    def setUp(self):
        run_id, attempt = 12345, 2
        suffix = hashlib.sha256(f"{run_id}:{attempt}".encode()).hexdigest()[:12]
        self.name = f"{subject.SERVICE}-q{suffix}"
        metadata = {
            "name": self.name,
            "uid": "rev-uid",
            "labels": {
                "github-run-id": str(run_id),
                "serving.knative.dev/service": subject.SERVICE,
            },
        }
        self.revision = {
            "metadata": metadata,
            "spec": {"containers": [{"image": "digest"}]},
            "status": {"ready": True},
        }
        self.service = {
            "metadata": {
                "name": subject.SERVICE,
                "uid": "service-uid",
                "resourceVersion": "1",
                "generation": 1,
            },
            "spec": {
                "template": {
                    "metadata": copy.deepcopy(metadata),
                    "spec": copy.deepcopy(self.revision["spec"]),
                },
                "traffic": [{"revisionName": self.name, "percent": 100}],
            },
            "status": {
                "traffic": [{"revisionName": self.name, "percent": 100}],
                "observedGeneration": 1,
                "conditions": [{"type": "Ready", "status": "True"}],
            },
        }
        document = {
            "spec": {"template": copy.deepcopy(self.service["spec"]["template"])}
        }
        self.binding = Binding(
            "dev", run_id, attempt, "service-uid", "rev-uid", document
        )

        def matches(revision, desired):
            if (
                revision["metadata"]["name"]
                != desired["spec"]["template"]["metadata"]["name"]
                or revision["spec"] != desired["spec"]["template"]["spec"]
            ):
                raise BudgetError("runtime mismatch")

        self.history = SimpleNamespace(
            RetainedFrontendBinding=Binding,
            read=lambda env, rid, att: self.binding,
            candidate=SimpleNamespace(revision_matches=matches),
        )

    def verify(self, service=None, revisions=None):
        return subject.verify(
            service or self.service,
            revisions or [self.revision],
            "dev",
            self.history,
            BudgetError,
        )


class FrontendCapacityTests(FrontendFixture):
    def test_verified_fixture_is_zero_direct_sql_without_backend_tag(self):
        row = self.verify()
        self.assertEqual(row["connections"], 0)
        self.assertEqual(row["checked_revisions"], [self.name])
        self.assertTrue(row["template_checked"])

    def test_refuses_drift_and_unknown_revisions(self):
        for fault in (
            "uid",
            "revision",
            "template",
            "sql",
            "attempt",
            "duplicate",
            "traffic",
        ):
            service, revision = (
                copy.deepcopy(self.service),
                copy.deepcopy(self.revision),
            )
            revisions = [revision]
            if fault == "uid":
                service["metadata"]["uid"] = "other"
            if fault == "revision":
                revision["metadata"]["uid"] = "other"
            if fault == "template":
                service["spec"]["template"]["spec"]["containers"][0]["image"] = "other"
            if fault == "sql":
                revision["metadata"]["annotations"] = {
                    "run.googleapis.com/cloudsql-instances": "other:region:db"
                }
            if fault == "attempt":
                revision["metadata"]["name"] += "x"
            if fault == "duplicate":
                revisions.append(copy.deepcopy(revision))
            if fault == "traffic":
                service["status"]["traffic"][0]["revisionName"] = "unknown"
            with self.subTest(fault=fault), self.assertRaises(BudgetError):
                self.verify(service, revisions)

    def test_desired_traffic_and_service_readiness_are_required(self):
        for fault in (
            "unknown",
            "latest",
            "duplicate-tag",
            "tag-drift",
            "weight",
            "unready",
            "generation",
        ):
            service = copy.deepcopy(self.service)
            target = service["spec"]["traffic"][0]
            if fault == "unknown":
                target["revisionName"] = "unknown-future"
            elif fault == "latest":
                target["latestRevision"] = True
            elif fault == "duplicate-tag":
                target["tag"] = self.name.removeprefix(subject.SERVICE + "-")
                service["spec"]["traffic"].append(dict(target, percent=0))
            elif fault == "tag-drift":
                target["tag"] = self.name.removeprefix(subject.SERVICE + "-")
            elif fault == "weight":
                target["percent"] = 99
            elif fault == "unready":
                service["status"]["conditions"][0]["status"] = "False"
            elif fault == "generation":
                service["status"]["observedGeneration"] = 2
            with self.subTest(fault=fault), self.assertRaises(BudgetError):
                self.verify(service)

    def test_only_fixed_dev_or_uat_fixture_may_extend_service_partition(self):
        config = {
            "project": "hushh-pda-dev",
            "services": {"backend": {}},
            "non_database_services": ["web"],
        }
        listed = [
            {"metadata": {"name": name}} for name in ("backend", "web", subject.SERVICE)
        ]
        opts = ("--project=hushh-pda-dev", "--region=us-central1")
        names, non_database = inventory._service_partition(
            config, lambda *_args: listed, opts
        )
        self.assertIn(subject.SERVICE, names)
        self.assertIn(subject.SERVICE, non_database)
        for project, extra in (
            ("hushh-pda", subject.SERVICE),
            ("hushh-pda-dev", "unknown"),
        ):
            altered = dict(config, project=project)
            rows = [{"metadata": {"name": name}} for name in ("backend", "web", extra)]
            with (
                self.subTest(project=project, extra=extra),
                self.assertRaises(inventory.BudgetError),
            ):
                inventory._service_partition(altered, lambda *_args: rows, opts)

    def test_collector_rechecks_fixture_and_uses_every_retained_revision(self):
        original_import = __import__("importlib").import_module

        def imports(name):
            return {
                "frontend_fixture_retained": self.history,
                "runtime_capacity_frontend": subject,
            }.get(name) or original_import(name)

        calls = []

        def read(*args):
            calls.append(args)
            return (
                [self.revision]
                if args[:3] == ("run", "revisions", "list")
                else copy.deepcopy(self.service)
            )

        with (
            mock.patch("importlib.import_module", side_effect=imports),
            mock.patch.object(inventory, "_non_target_routing", return_value=set()),
        ):
            result = inventory._read_service_inventory(
                subject.SERVICE,
                read,
                (),
                non_database={subject.SERVICE},
                connection_name="dev:region:db",
                isolated=True,
                endpoints=set(),
                aliases=set(),
                pending_latest=[],
                environment="dev",
            )
        self.assertEqual(result["non_target"]["checked_revisions"], [self.name])
        self.assertEqual(
            sum(row[:3] == ("run", "services", "describe") for row in calls), 2
        )

    def test_collector_rejects_same_resource_version_service_replacement(self):
        original_import = __import__("importlib").import_module

        def imports(name):
            return {
                "frontend_fixture_retained": self.history,
                "runtime_capacity_frontend": subject,
            }.get(name) or original_import(name)

        calls = []

        def read(*args):
            if args[:3] == ("run", "revisions", "list"):
                return [self.revision]
            value = copy.deepcopy(self.service)
            calls.append(True)
            if len(calls) > 1:
                value["metadata"]["uid"] = "replacement-with-same-rv"
            return value

        with (
            mock.patch("importlib.import_module", side_effect=imports),
            mock.patch.object(inventory, "_non_target_routing", return_value=set()),
            self.assertRaises(inventory.BudgetError),
        ):
            inventory._read_service_inventory(
                subject.SERVICE,
                read,
                (),
                non_database={subject.SERVICE},
                connection_name="dev:region:db",
                isolated=True,
                endpoints=set(),
                aliases=set(),
                pending_latest=[],
                environment="dev",
            )

    def test_uat_workflows_use_main_owned_capacity_after_app_checkout(self):
        root = Path(__file__).resolve().parents[2]
        for name in ("deploy-uat.yml", "deploy-uat-one-chat.yml"):
            workflow = yaml.safe_load((root / ".github/workflows" / name).read_text())
            wait = workflow["jobs"]["wait-capacity"]
            deploy = workflow["jobs"]["deploy"]
            with self.subTest(workflow=name):
                self.assertEqual(wait["permissions"]["actions"], "read")
                self.assertIn("GH_TOKEN", deploy["env"])
                preserve = next(
                    step
                    for step in deploy["steps"]
                    if step.get("name") == "Preserve current release tooling"
                )
                self.assertIn(
                    'git worktree add --detach "${RUNNER_TEMP}/capacity-main" "$GITHUB_SHA"',
                    preserve["run"],
                )
                commands = [
                    step["run"]
                    for step in deploy["steps"]
                    if "runtime-capacity-budget.py --environment" in step.get("run", "")
                    or 'capacity-main/scripts/ci/runtime-capacity-budget.py"'
                    in step.get("run", "")
                ]
                self.assertTrue(commands)
                self.assertTrue(
                    all(
                        'capacity-main/scripts/ci/runtime-capacity-budget.py"'
                        in command
                        for command in commands
                    )
                )


if __name__ == "__main__":
    unittest.main()

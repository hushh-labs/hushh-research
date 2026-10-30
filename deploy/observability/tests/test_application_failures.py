"""Application failure metrics bind authored terminal logs to actionable alerts."""

import ast
import asyncio
import contextlib
import copy
import io
import json
import re
import unittest
from unittest.mock import patch

from test_reconcile_capacity import ROOT, module


def terminal_failure(error_type="TimeoutError", classification="provider_unavailable"):
    """Execute the authored terminal emitter without importing or contacting any SDK."""
    scripts = ROOT.parents[1] / "consent-protocol/scripts"
    leaf = ast.parse((scripts / "probe_azure_openai_readiness.py").read_text())
    outer = ast.parse((scripts / "verify_azure_pwm_runtime.py").read_text())
    nodes = [
        n
        for n in leaf.body
        if isinstance(n, (ast.ClassDef, ast.FunctionDef))
        and n.name in {"ReadinessProbeError", "failure_fields"}
    ]
    nodes += [
        n
        for n in outer.body
        if isinstance(n, (ast.ClassDef, ast.FunctionDef))
        and n.name in {"AzurePwmTrustError", "main"}
    ]
    namespace = {"asyncio": asyncio, "json": json}
    exec(
        compile(ast.Module(body=nodes, type_ignores=[]), "probe_terminal", "exec"),
        namespace,
    )

    async def fail():
        raise namespace["ReadinessProbeError"](
            {
                "classification": classification,
                "error_type": error_type,
                "failure_stage": "primary_http",
                "elapsed_ms": 30001,
                "attempt": 1,
            }
        )

    namespace["probe"] = fail
    with contextlib.redirect_stdout(io.StringIO()) as output:
        status = namespace["main"]()
    return status, json.loads(output.getvalue())


def release_probe_inventory(args):
    state = {
        "metrics": [{"name": "unmanaged_metric"}],
        "policies": [{"displayName": "Unmanaged policy", "enabled": False}],
        "writes": [],
    }
    channel = {
        "name": f"projects/{args.project}/notificationChannels/existing",
        "type": "email",
        "enabled": True,
        "verificationStatus": "VERIFIED",
        "labels": {"email_address": "operator@example.org"},
    }

    def read(*command, **kwargs):
        if command[1:4] == ("logging", "metrics", "list"):
            return copy.deepcopy(state["metrics"])
        if command[1:5] == ("beta", "monitoring", "channels", "list"):
            return [channel]
        if command[1:4] == ("monitoring", "policies", "list"):
            return copy.deepcopy(state["policies"])
        raise AssertionError(
            f"Release probe scope accessed an unrelated resource: {command[:5]}"
        )

    def write(config, action):
        config = copy.deepcopy(config)
        state["writes"].append(config)
        if "--config-from-file=__CONFIG__" in action:
            assert config["name"] == "obs_azure_release_probe_timeout_count"
            state["metrics"].append(config)
        else:
            assert (
                config["displayName"]
                == "[Managed] Azure Release Probe Repeated Timeouts"
            )
            assert config["notificationChannels"] == [channel["name"]]
            assert config["enabled"] is True
            config["name"] = f"projects/{args.project}/alertPolicies/probe"
            state["policies"].append(config)

    return state, read, write


class ChatFailureObservabilityTest(unittest.TestCase):
    def test_authority_refusal_is_excluded_without_hiding_runtime_failures(self):
        args = module.cli(
            ["--project", "hushh-pda-uat", "--sql-instance", "hushh-uat-pg"]
        )
        cases = (
            (
                "obs_agent_stream_failure_count",
                "one_agent_chat_turn_complete head=one events=2 outcome=error error_class=refusal error_code=text.authority.ended ",
                "error_class=refusal error_code=text.authority.ended",
                "error_class=other error_code=background.execution.error",
            ),
            (
                "obs_agent_stream_failure_count",
                "one_agent_chat_turn_complete head=one events=2 outcome=error error_class=refusal error_code=text.content.filtered ",
                "error_class=refusal error_code=text.content.filtered",
                "error_class=other error_code=background.execution.error",
            ),
            (
                "obs_azure_model_error_count",
                "azure_model_call_complete provider=azure_openai model=gpt-5-mini outcome=failed error_kind=authority status=0 ",
                "error_kind=authority",
                "error_kind=server",
            ),
            (
                "obs_azure_model_error_count",
                "azure_model_call_complete provider=azure_openai model=gpt-5-mini outcome=failed error_kind=filtered status=0 ",
                "error_kind=filtered",
                "error_kind=protocol",
            ),
        )
        for name, refusal, old, actionable in cases:
            metric = module.render(ROOT / f"log-metrics/{name}.json", args)
            regex = re.search(r'textPayload=~"([^"]+)"', metric["filter"]).group(1)
            self.assertIsNone(re.search(regex, refusal))
            self.assertIsNotNone(re.search(regex, refusal.replace(old, actionable)))

    def test_sparse_terminal_failures_trigger_count_policy(self):
        args = module.cli(
            ["--project", "hushh-pda-uat", "--sql-instance", "hushh-uat-pg"]
        )
        policy = module.render(
            ROOT / "alerts/agent-stream-failures-policy.json.in", args
        )
        threshold = policy["conditions"][0]["conditionThreshold"]
        # The actual incident's two failures must trigger even with sparse traffic.
        self.assertEqual(threshold["aggregations"][0]["perSeriesAligner"], "ALIGN_SUM")
        self.assertGreater(2, threshold["thresholdValue"])
        self.assertEqual(threshold["duration"], "0s")

    def test_answer_metrics_preserve_missing_answer_coverage(self):
        args = module.cli(
            ["--project", "hushh-pda-uat", "--sql-instance", "hushh-uat-pg"]
        )
        metric = module.render(
            ROOT / "log-metrics/obs_agent_chat_first_answer_ms.json", args
        )
        regex = re.search(r'textPayload=~"([^"]+)"', metric["filter"]).group(1)
        measured = "one_agent_chat_turn_complete head=one first_visible_ms=20 first_answer_token_ms=500 outcome=finished "
        missing = measured.replace(
            "first_answer_token_ms=500", "first_answer_token_ms=None"
        ).replace("finished", "error")
        self.assertIsNotNone(re.search(regex, measured))
        self.assertIsNone(re.search(regex, missing))
        self.assertNotIn("labelExtractors", metric)
        coverage = module.render(
            ROOT / "log-metrics/obs_agent_chat_no_answer_count.json", args
        )
        coverage_regex = re.search(r'textPayload=~"([^"]+)"', coverage["filter"]).group(
            1
        )
        self.assertIsNotNone(re.search(coverage_regex, missing))


class AzureReleaseProbeObservabilityTest(unittest.TestCase):
    def test_counter_matches_real_terminal_emitter_and_exact_candidate_job(self):
        args = module.cli(
            ["--project", "hushh-pda-uat", "--sql-instance", "hushh-uat-pg"]
        )
        metric = module.render(
            ROOT / "log-metrics/obs_azure_release_probe_timeout_count.json", args
        )
        expression = metric["filter"]
        for clause in (
            'resource.type="cloud_run_job"',
            'resource.labels.project_id="hushh-pda-uat"',
            'resource.labels.location="us-central1"',
            'jsonPayload.azure_pwm_runtime_probe_result="failed"',
            'jsonPayload.classification="provider_unavailable"',
        ):
            self.assertIn(clause, expression)
        build = (ROOT.parents[1] / "deploy/backend.cloudbuild.yaml").read_text()
        prefix = re.search(r'job_name="([^$"\n]+)\$\{BUILD_ID\}"', build).group(1)
        self.assertIn(
            'if [[ "$PROJECT_ID" != "hushh-pda-uat" || "${_REGION}" != "us-central1"',
            build,
        )
        pattern = json.JSONDecoder().raw_decode(
            expression.split("resource.labels.job_name=~", 1)[1]
        )[0]
        build_id = "00000000-0000-4000-8000-000000000001"
        self.assertIsNotNone(re.search(pattern, prefix + build_id))
        for foreign in (
            "unrelated-" + build_id,
            prefix + "invalid",
            "x" + prefix + build_id,
        ):
            self.assertIsNone(re.search(pattern, foreign))
        errors = set(re.findall(r'jsonPayload.error_type="([A-Za-z]+)"', expression))
        self.assertEqual(errors, {"TimeoutError", "APITimeoutError"})
        for error_type in errors:
            status, terminal = terminal_failure(error_type)
            self.assertEqual(status, 1)
            self.assertEqual(terminal["azure_pwm_runtime_probe_result"], "failed")
            self.assertEqual(terminal["classification"], "provider_unavailable")
            self.assertIn(terminal["error_type"], errors)
            stage = {
                "azure_pwm_runtime_probe_stage": "primary_http",
                "result": "failed",
                "classification": "provider_unavailable",
                "error_type": error_type,
            }
            self.assertEqual(
                sum(
                    v.get("azure_pwm_runtime_probe_result") == "failed"
                    for v in (stage, terminal)
                ),
                1,
            )
        _, schema_failure = terminal_failure("ValueError", "candidate_misconfigured")
        self.assertNotIn(schema_failure["error_type"], errors)
        self.assertNotEqual(schema_failure["classification"], "provider_unavailable")
        self.assertNotIn("labelExtractors", metric)

    def test_two_terminal_failures_trigger_with_existing_policy_delivery_contract(self):
        args = module.cli(
            ["--project", "hushh-pda-uat", "--sql-instance", "hushh-uat-pg"]
        )
        policy = module.render(
            ROOT / "alerts/azure-release-probe-timeout-policy.json.in", args
        )
        threshold = policy["conditions"][0]["conditionThreshold"]
        self.assertEqual(
            threshold["aggregations"],
            [
                {
                    "alignmentPeriod": "600s",
                    "perSeriesAligner": "ALIGN_SUM",
                    "crossSeriesReducer": "REDUCE_SUM",
                }
            ],
        )
        self.assertEqual(threshold["comparison"], "COMPARISON_GT")
        self.assertGreater(2, threshold["thresholdValue"])
        self.assertLessEqual(1, threshold["thresholdValue"])
        self.assertEqual(threshold["duration"], "0s")
        self.assertTrue(policy["enabled"])
        self.assertEqual(policy["severity"], "ERROR")
        self.assertEqual(
            policy["alertStrategy"]["notificationPrompts"], ["OPENED", "CLOSED"]
        )
        self.assertEqual(policy["alertStrategy"]["autoClose"], "1800s")
        self.assertEqual(policy["notificationChannels"], [])

    def test_missing_disabled_or_unverified_channel_refuses_delivery_setup(self):
        channel = {
            "name": "projects/hushh-pda-uat/notificationChannels/existing",
            "type": "email",
            "labels": {"email_address": "operator@example.org"},
        }
        for scope in (["--sql-instance", "hushh-uat-pg"], ["--release-probe-only"]):
            args = module.cli(
                [
                    "--project",
                    "hushh-pda-uat",
                    "--email",
                    "operator@example.org",
                    "--apply",
                    *scope,
                ]
            )
            metrics = [
                module.render(ROOT / f"log-metrics/{name}.json", args)
                for name in module.selected_resources(args)[0]
            ]
            for channels in (
                [],
                [{**channel, "enabled": False}],
                [{**channel, "verificationStatus": "UNVERIFIED"}],
            ):
                with (
                    patch.object(module, "run", side_effect=[metrics, channels]),
                    patch.object(module, "write_config") as writer,
                    contextlib.redirect_stdout(io.StringIO()),
                    self.assertRaises(RuntimeError),
                ):
                    module.reconcile(args)
                writer.assert_not_called()

    def test_release_probe_pair_does_not_change_other_provisioner_scopes(self):
        for flags, expected in (
            (["--project", "hushh-pda-uat", "--sql-instance", "hushh-uat-pg"], True),
            (["--project", "hushh-pda", "--sql-instance", "hushh-vault-db"], False),
            (["--project", "hushh-pda-uat", "--auth-only"], False),
            (
                [
                    "--project",
                    "hushh-pda-uat",
                    "--sql-instance",
                    "hushh-uat-pg",
                    "--voice-only",
                ],
                False,
            ),
            (["--project", "hushh-gemini-bridge", "--provider-only"], False),
        ):
            with self.subTest(flags=flags):
                metrics, policies = module.selected_resources(module.cli(flags))
                self.assertEqual(
                    "obs_azure_release_probe_timeout_count" in metrics, expected
                )
                self.assertEqual(
                    "azure-release-probe-timeout-policy" in policies, expected
                )


class ReleaseProbeOnlyReconciliationTest(unittest.TestCase):
    def test_narrow_mode_refuses_other_projects_provisioners_or_no_delivery(self):
        for project, flags in (
            ("hushh-pda", []),
            ("hushh-pda-uat", ["--sql-instance", "hushh-uat-pg"]),
            ("hushh-pda-uat", ["--auth-only"]),
            ("hushh-pda-uat", ["--provider-only"]),
            ("hushh-pda-uat", ["--voice-only"]),
            ("hushh-pda-uat", ["--commerce-only"]),
            ("hushh-pda-uat", ["--include-commerce"]),
            ("hushh-pda-uat", ["--console-only"]),
        ):
            with (
                self.subTest(project=project, flags=flags),
                contextlib.redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit),
            ):
                module.cli(["--project", project, "--release-probe-only", *flags])

    def test_plan_apply_and_readback_touch_only_pair_with_existing_channel(self):
        with patch.object(
            module._CAPACITY,
            "sql_alert_thresholds",
            side_effect=AssertionError("SQL accessed"),
        ):
            args = module.cli(
                [
                    "--project",
                    "hushh-pda-uat",
                    "--release-probe-only",
                    "--email",
                    "operator@example.org",
                ]
            )
            self.assertFalse(args.apply)
            self.assertEqual(args.sql_instance, "")
            self.assertEqual(
                module.selected_resources(args),
                (
                    ("obs_azure_release_probe_timeout_count",),
                    ("azure-release-probe-timeout-policy",),
                ),
            )
            state, read, write = release_probe_inventory(args)
            with (
                patch.object(module, "run", side_effect=read),
                patch.object(module, "write_config", side_effect=write),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                module.reconcile(args)
                self.assertEqual(state["writes"], [])
                args.apply = True
                module.reconcile(args)
                self.assertEqual(len(state["writes"]), 2)
                module.reconcile(args)
                self.assertEqual(len(state["writes"]), 2)
            self.assertEqual(state["metrics"][0], {"name": "unmanaged_metric"})
            self.assertEqual(
                state["policies"][0],
                {"displayName": "Unmanaged policy", "enabled": False},
            )

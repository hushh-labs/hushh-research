"""Contracts for capacity alert reconciliation and the actual text log shape."""

from __future__ import annotations

import contextlib
import copy
import importlib.util
import io
import json
import re
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "reconcile_capacity", ROOT / "reconcile_capacity.py"
)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CapacityObservabilityTest(unittest.TestCase):
    def test_policy_delivery_drift_and_repeat_reconciliation(self) -> None:
        args = module.cli([
            "--project", "hushh-uat-123", "--sql-instance", "hushh-vault-db", "--apply"
        ])
        channels = [{"name": f"projects/{args.project}/notificationChannels/{i}",
                     "type": "email", "labels": {"email_address": email}}
                    for i, email in enumerate(args.email)]
        metrics = [module.render(ROOT / "log-metrics" / f"{name}.json", args)
                   for name in module.METRICS]
        dashboard = module.render(ROOT / "dashboard-observability.json.in", args)
        dashboard["gridLayout"]["columns"] = str(dashboard["gridLayout"]["columns"])
        policies = []
        for i, slug in enumerate(module.POLICIES):
            policy = module.render(ROOT / "alerts" / f"{slug}.json.in", args)
            policy["name"] = f"projects/{args.project}/alertPolicies/{i}"
            policy["notificationChannels"] = [c["name"] for c in channels]
            policy["enabled"] = True
            policy.pop("severity")
            policy.pop("alertStrategy")
            policies.append(policy)
        writes = []

        def fake_run(*command, **kwargs):
            if command[1:3] == ("logging", "metrics"):
                return copy.deepcopy(metrics)
            if command[1:4] == ("beta", "monitoring", "channels"):
                return copy.deepcopy(channels)
            if command[1:3] == ("monitoring", "policies"):
                return copy.deepcopy(policies)
            return copy.deepcopy(dashboard)

        def fake_write(config, action):
            self.assertIn("update", action)
            writes.append(copy.deepcopy(config))
            index = next(i for i, p in enumerate(policies) if p["name"] == config["name"])
            policies[index] = copy.deepcopy(config)
            if not policies[index]["notificationChannels"]:
                policies[index].pop("notificationChannels")
            for condition in policies[index]["conditions"]:
                threshold = condition.get("conditionThreshold", {})
                if threshold.get("thresholdValue") == 0:
                    threshold.pop("thresholdValue")
            policies[index]["conditions"][0]["name"] = config["name"] + "/conditions/1"

        with patch.object(module, "run", side_effect=fake_run), \
             patch.object(module, "write_config", side_effect=fake_write), \
             contextlib.redirect_stdout(io.StringIO()):
            module.reconcile(args)
            self.assertEqual(len(writes), len(module.POLICIES))
            for p in policies:
                actionable = p["userLabels"]["incident_purpose"] == "actionable"
                self.assertEqual(p["enabled"], actionable)
                self.assertEqual(p["severity"], "ERROR" if actionable else "WARNING")
                self.assertEqual(p.get("notificationChannels", []),
                                 [c["name"] for c in channels] if actionable else [])
                self.assertEqual(p["alertStrategy"], {"notificationPrompts": ["OPENED", "CLOSED"]})
            module.reconcile(args)
            self.assertEqual(len(writes), len(module.POLICIES))
            # Severity-only and delivery-only drift must each be repaired.
            policies[0]["severity"] = "WARNING"
            policies[1]["alertStrategy"] = {"notificationPrompts": ["OPENED"]}
            module.reconcile(args)
            self.assertEqual(len(writes), len(module.POLICIES) + 2)

    def test_sql_connections_sum_database_series_for_one_instance(self) -> None:
        args = module.cli(
            ["--project", "hushh-uat-123", "--sql-instance", "hushh-vault-db"]
        )
        for slug, threshold in (("warning", 700), ("critical", 850)):
            policy = module.render(
                ROOT / "alerts" / f"sql-connections-{slug}-policy.json.in", args
            )
            condition = policy["conditions"][0]["conditionThreshold"]
            self.assertIn(
                'database_id"="hushh-uat-123:hushh-vault-db"', condition["filter"]
            )
            self.assertEqual(
                condition["aggregations"][0]["crossSeriesReducer"], "REDUCE_SUM"
            )
            self.assertEqual(condition["thresholdValue"], threshold)

    def test_distribution_extractors_match_backend_text_payload(self) -> None:
        payload = 'INFO {"message":"request.summary","method":"GET","route_template":"/api/consent/center/summary","duration_ms":52.75,"db_pool_wait_ms":3.5,"stream":false}'
        for name, expected in (
            ("obs_db_pool_wait_ms", "3.5"),
            ("obs_short_read_duration_ms", "52.75"),
        ):
            metric = json.loads((ROOT / "log-metrics" / f"{name}.json").read_text())
            self.assertEqual(metric["metricDescriptor"]["valueType"], "DISTRIBUTION")
            expression = metric["valueExtractor"]
            regex = expression.split('"', 1)[1].rsplit('"', 1)[0].replace('\\"', '"')
            self.assertEqual(re.search(regex, payload).group(1), expected)
        error_metric = json.loads(
            (ROOT / "log-metrics" / "obs_unexpected_error_count.json").read_text()
        )
        self.assertIn("server_error", error_metric["filter"])
        self.assertNotIn("client_error", error_metric["filter"])

    def test_stream_failure_metric_covers_http_success_errors_without_refusal_noise(self) -> None:
        metric = json.loads((ROOT / "log-metrics/obs_agent_stream_failure_count.json").read_text())
        expression = re.search(r'textPayload=~"([^"]+)"', metric["filter"]).group(1)
        def line(outcome="error", kind="other", code="execution.error", head="one"):
            return f"INFO one_agent_chat_turn_complete head={head} run=redacted events=2 outcome={outcome} error_class={kind} error_code={code} tools_peak=0"
        for kind, code in (("model", "model.capacity"), ("model", "model.unavailable"),
                           ("connector", "unlisted"), ("database", "unlisted"),
                           ("runtime", "unlisted"), ("other", "execution.error"),
                           ("other", "execution.timeout"), ("other", "background.execution.error"),
                           ("escaped_exception", "agent.error"), ("escaped_exception", "resource.exhausted"),
                           ("escaped_exception", "model.unavailable")):
            for head in ("one", "intro"):
                self.assertIsNotNone(re.search(expression, line(kind=kind, code=code, head=head)))
        for payload in (line(outcome="finished"), line(outcome="client_disconnect"),
                        line(outcome="server_restarting", kind="shutdown", code="server.restarting"),
                        line(code="unlisted"), line(kind="escaped_exception", code="unlisted"), line(code="chat.key.required"),
                        'INFO {"message":"request.summary","outcome_class":"server_error"}'):
            self.assertIsNone(re.search(expression, payload))
        self.assertNotIn("labelExtractors", metric)

    def test_default_plan_never_mutates_cloud(self) -> None:
        args = module.cli(
            ["--project", "hushh-uat-123", "--sql-instance", "hushh-vault-db"]
        )
        calls = []

        def fake_run(*command: str, allow_missing: bool = False):
            calls.append(command)
            if command[:4] == ("gcloud", "monitoring", "dashboards", "describe"):
                return None
            return []

        with (
            patch.object(module, "run", side_effect=fake_run),
            patch.object(module, "write_config") as writer,
        ):
            with contextlib.redirect_stdout(io.StringIO()):
                module.reconcile(args)
        writer.assert_not_called()
        self.assertTrue(
            all("create" not in call and "update" not in call for call in calls)
        )


if __name__ == "__main__":
    unittest.main()

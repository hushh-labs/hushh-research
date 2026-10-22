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
            "--project", "hushh-pda-uat", "--sql-instance", "hushh-uat-pg", "--apply"
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
            ["--project", "hushh-pda-uat", "--sql-instance", "hushh-uat-pg"]
        )
        for slug, threshold in (("warning", 700), ("critical", 850)):
            policy = module.render(
                ROOT / "alerts" / f"sql-connections-{slug}-policy.json.in", args
            )
            condition = policy["conditions"][0]["conditionThreshold"]
            self.assertIn(
                'database_id"="hushh-pda-uat:hushh-uat-pg"', condition["filter"]
            )
            self.assertEqual(
                condition["aggregations"][0]["crossSeriesReducer"], "REDUCE_SUM"
            )
            self.assertEqual(condition["thresholdValue"], threshold)

    def test_sql_thresholds_follow_environment_capacity_and_keep_delivery(self) -> None:
        for project, instance, values in (
            ("hushh-pda", "hushh-vault-db", (280, 340)),
            ("hushh-pda-uat", "hushh-uat-pg", (700, 850)),
        ):
            args = module.cli(["--project", project, "--sql-instance", instance])
            for slug, expected in zip(("warning", "critical"), values):
                with self.subTest(project=project, slug=slug):
                    policy = module.render(
                        ROOT / "alerts" / f"sql-connections-{slug}-policy.json.in", args
                    )
                    self.assertEqual(
                        policy["conditions"][0]["conditionThreshold"]["thresholdValue"],
                        expected,
                    )
                    self.assertIn(str(expected), policy["documentation"]["content"])
                    self.assertEqual(policy["enabled"], slug == "critical")
                    self.assertEqual(policy["alertStrategy"], {
                        "notificationPrompts": ["OPENED", "CLOSED"]
                    })

    def test_unreviewed_database_is_rejected_before_cloud_calls(self) -> None:
        for project, instance in (("unreviewed-project", "hushh-vault-db"),
                                  ("hushh-pda", "hushh-uat-pg")):
            with self.subTest(project=project, instance=instance), \
                 patch.object(module, "run") as cloud, \
                 contextlib.redirect_stderr(io.StringIO()), \
                 self.assertRaises(SystemExit):
                module.reconcile(module.cli([
                    "--project", project, "--sql-instance", instance, "--apply"
                ]))
            cloud.assert_not_called()

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

    def test_voice_metrics_extract_only_bounded_provider_dimensions(self) -> None:
        server = (
            "INFO one_voice.latency session=private turn=private phase=first_audio "
            "ms=1312 provider=vertex_ai vertex_project=hussh-511311 "
            "live_model=gemini-live-2.5-flash-native-audio live_location=us-central1"
        )
        tool = server.replace("phase=first_audio ms=1312", "phase=tool tool=read_mail ms=4700")
        client = (
            "INFO one_voice.client_perf session=private turn=private "
            "metric=audio_receive_to_audible ms=120 provider=vertex_ai "
            "vertex_project=hussh-511311 "
            "live_model=gemini-live-2.5-flash-native-audio live_location=us-central1"
        )
        cases = (
            ("obs_one_voice_latency_ms", server, "1312", "phase", "first_audio"),
            ("obs_one_voice_latency_ms", tool, "4700", "phase", "tool"),
            (
                "obs_one_voice_client_perf_ms", client, "120", "metric",
                "audio_receive_to_audible",
            ),
        )
        for name, line, elapsed, dimension, value in cases:
            with self.subTest(name=name, line=line):
                metric = json.loads((ROOT / "log-metrics" / f"{name}.json").read_text())
                self.assertEqual(metric["metricDescriptor"]["valueType"], "DISTRIBUTION")
                self.assertEqual(metric["metricDescriptor"]["unit"], "ms")
                self.assertEqual(
                    set(metric["labelExtractors"]),
                    {label["key"] for label in metric["metricDescriptor"]["labels"]},
                )
                self.assertEqual(
                    set(metric["labelExtractors"]),
                    {dimension, "vertex_project", "live_model", "live_location"},
                )
                self.assertNotIn("session", metric["labelExtractors"])
                self.assertNotIn("turn", metric["labelExtractors"])
                log_filter = re.search(r'textPayload=~"([^"]+)"', metric["filter"])
                self.assertIsNotNone(log_filter)
                self.assertIsNotNone(re.search(log_filter.group(1), line))
                extractor = re.search(r'REGEXP_EXTRACT\(textPayload, "([^"]+)"\)', metric["valueExtractor"])
                self.assertEqual(re.search(extractor.group(1), line).group(1), elapsed)
                for label, expression in metric["labelExtractors"].items():
                    capture = re.search(r'REGEXP_EXTRACT\(textPayload, "([^"]+)"\)', expression)
                    extracted = re.search(capture.group(1), line).group(1)
                    self.assertEqual(extracted, value if label == dimension else {
                        "vertex_project": "hussh-511311",
                        "live_model": "gemini-live-2.5-flash-native-audio",
                        "live_location": "us-central1",
                    }[label])

        # These are configuration labels, never a general label for user/session content.
        server_metric = json.loads((ROOT / "log-metrics/obs_one_voice_latency_ms.json").read_text())
        filter_expression = re.search(r'textPayload=~"([^"]+)"', server_metric["filter"]).group(1)
        self.assertIsNone(re.search(filter_expression, server.replace("phase=first_audio", "phase=unknown")))
        self.assertIsNone(re.search(filter_expression, server.replace("provider=vertex_ai", "provider=other")))

    def test_voice_dashboard_uses_phase_percentiles_without_cross_series_reduction(self) -> None:
        args = module.cli(["--project", "hushh-pda-uat", "--sql-instance", "hushh-uat-pg"])
        dashboard = module.render(ROOT / "dashboard-observability.json.in", args)
        widgets = {widget["title"]: widget for widget in dashboard["gridLayout"]["widgets"]}
        expected = {
            "One Voice First Audio P50 (ms, per revision)": ("first_audio", "ALIGN_PERCENTILE_50"),
            "One Voice First Audio P95 (ms, per revision)": ("first_audio", "ALIGN_PERCENTILE_95"),
            "One Voice Tool P95 (ms, per revision)": ("tool", "ALIGN_PERCENTILE_95"),
            "One Voice Client Endpointing P95 (ms, per revision)": ("endpointing_client", "ALIGN_PERCENTILE_95"),
            "One Voice Client Audio Audible P95 (ms, per revision)": ("audio_receive_to_audible", "ALIGN_PERCENTILE_95"),
        }
        for title, (slice_value, aligner) in expected.items():
            with self.subTest(title=title):
                query = widgets[title]["xyChart"]["dataSets"][0]["timeSeriesQuery"]
                series_filter = query["timeSeriesFilter"]
                self.assertIn(slice_value, series_filter["filter"])
                self.assertEqual(series_filter["aggregation"]["perSeriesAligner"], aligner)
                self.assertNotIn("crossSeriesReducer", series_filter["aggregation"])
                self.assertEqual(query["unitOverride"], "ms")

    def test_voice_metric_reconcile_ignores_server_descriptor_fields_but_detects_drift(self) -> None:
        args = module.cli(["--project", "hushh-pda-uat", "--sql-instance", "hushh-uat-pg"])
        desired = module.render(ROOT / "log-metrics/obs_one_voice_latency_ms.json", args)
        current = copy.deepcopy(desired)
        current["metricDescriptor"]["type"] = "logging.googleapis.com/user/obs_one_voice_latency_ms"
        current["metricDescriptor"]["labels"].reverse()
        self.assertTrue(module.same_log_metric(current, desired))
        for label in current["metricDescriptor"]["labels"]:
            label.pop("valueType")  # Actual gcloud readback omits default STRING.
        self.assertTrue(module.same_log_metric(current, desired))
        current["metricDescriptor"]["labels"][0]["valueType"] = "INT64"
        self.assertFalse(module.same_log_metric(current, desired))
        current["metricDescriptor"]["labels"][0].pop("valueType")
        current["labelExtractors"]["phase"] = 'REGEXP_EXTRACT(textPayload, " phase=(.*)")'
        self.assertFalse(module.same_log_metric(current, desired))

    def test_voice_only_apply_is_idempotent_and_never_touches_alerts(self) -> None:
        args = module.cli([
            "--project", "hushh-pda-uat", "--sql-instance", "hushh-uat-pg",
            "--voice-only", "--apply",
        ])
        metrics = {}
        dashboard = None
        writes = []

        def fake_run(*command, **kwargs):
            nonlocal dashboard
            if command[:4] == ("gcloud", "logging", "metrics", "list"):
                return copy.deepcopy(list(metrics.values()))
            if command[:4] == ("gcloud", "monitoring", "dashboards", "describe"):
                return copy.deepcopy(dashboard)
            self.fail(f"Voice-only mode attempted unrelated cloud read: {command}")

        def fake_write(config, action):
            nonlocal dashboard
            writes.append(action)
            if action[:3] == ["gcloud", "logging", "metrics"]:
                metrics[config["name"]] = copy.deepcopy(config)
            elif action[:3] == ["gcloud", "monitoring", "dashboards"]:
                dashboard = copy.deepcopy(config)
                dashboard["gridLayout"]["columns"] = str(
                    dashboard["gridLayout"]["columns"]
                )
            else:
                self.fail(f"Voice-only mode attempted unrelated write: {action}")

        with patch.object(module, "run", side_effect=fake_run), \
             patch.object(module, "write_config", side_effect=fake_write), \
             contextlib.redirect_stdout(io.StringIO()):
            module.reconcile(args)
            self.assertEqual(len(writes), 3)
            module.reconcile(args)
            self.assertEqual(len(writes), 3)

    def test_default_plan_never_mutates_cloud(self) -> None:
        args = module.cli(
            ["--project", "hushh-pda-uat", "--sql-instance", "hushh-uat-pg"]
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

    def test_provider_mode_is_sql_free_and_plan_only_by_default(self) -> None:
        args = module.cli(["--project", "hushh-gemini-bridge", "--provider-only"])
        calls = []

        def fake_run(*command, **kwargs):
            calls.append(command)
            if command[:4] == ("gcloud", "monitoring", "dashboards", "describe"):
                return None
            return []

        with patch.object(module, "run", side_effect=fake_run), \
             patch.object(module, "write_config") as writer, \
             contextlib.redirect_stdout(io.StringIO()):
            module.reconcile(args)
        writer.assert_not_called()
        self.assertFalse(any("sql" in call or "logging" in call for call in calls))
        provider = module.render(ROOT / "alerts/provider-errors-policy.json.in", args)
        self.assertIn("model_invocation_count", provider["conditions"][0]["conditionThreshold"]["filter"])
        self.assertIn('resource.type="aiplatform.googleapis.com/PublisherModel"',
                      provider["conditions"][0]["conditionThreshold"]["filter"])
        self.assertNotIn("cloudsql", json.dumps(provider))
        for flags in ([], ["--provider-only", "--sql-instance", "hushh-vault-db"],
                      ["--provider-only", "--voice-only"]):
            with self.subTest(flags=flags), contextlib.redirect_stderr(io.StringIO()), \
                 self.assertRaises(SystemExit):
                module.cli(["--project", "hushh-gemini-bridge", *flags])

        args.apply = True
        channels = [{"name": f"projects/{args.project}/notificationChannels/{i}",
                     "type": "email", "labels": {"email_address": email}}
                    for i, email in enumerate(args.email)]
        policies, writes = [], []
        dashboard = None

        def readback(*command, **kwargs):
            calls.append(command)
            if command[1:4] == ("beta", "monitoring", "channels"):
                return copy.deepcopy(channels)
            if command[1:3] == ("monitoring", "policies"):
                return copy.deepcopy(policies)
            if command[1:4] == ("monitoring", "dashboards", "describe"):
                return copy.deepcopy(dashboard)
            self.fail(f"Provider mode touched unrelated surface: {command[:4]}")

        def writeback(config, action):
            nonlocal dashboard
            writes.append(copy.deepcopy(config))
            if "--policy-from-file=__CONFIG__" in action:
                policy = copy.deepcopy(config)
                policy["name"] = f"projects/{args.project}/alertPolicies/provider"
                policy["conditions"][0]["name"] = policy["name"] + "/conditions/server"
                policies.append(policy)
            else:
                dashboard = copy.deepcopy(config)
                dashboard["etag"] = "server-etag"

        with patch.object(module, "run", side_effect=readback), \
             patch.object(module, "write_config", side_effect=writeback), \
             contextlib.redirect_stdout(io.StringIO()):
            module.reconcile(args)
            self.assertEqual(len(writes), 2)
            module.reconcile(args)
            self.assertEqual(len(writes), 2)

    def test_first_visible_metric_excludes_missing_marks_and_private_labels(self) -> None:
        args = module.cli(["--project", "hushh-pda", "--sql-instance", "hushh-vault-db"])
        metric = module.render(ROOT / "log-metrics/obs_agent_chat_first_visible_ms.json", args)
        regex = re.search(r'textPayload=~"([^"]+)"', metric["filter"]).group(1)
        line = "INFO one_agent_chat_turn_complete head=one run=private first_visible_ms=123 first_activity_ms=42"
        self.assertIsNotNone(re.search(regex, line))
        self.assertIsNone(re.search(regex, line.replace("first_visible_ms=123", "first_visible_ms=None")))
        extractor = metric["valueExtractor"].split('"', 1)[1].rsplit('"', 1)[0]
        self.assertEqual(re.search(extractor, line).group(1), "123")
        self.assertNotIn("labelExtractors", metric)
        policy = module.render(ROOT / "alerts/sql-cpu-policy.json.in", args)
        threshold = policy["conditions"][0]["conditionThreshold"]
        self.assertIn('database_id="hushh-pda:hushh-vault-db"', threshold["filter"])
        self.assertEqual(threshold["thresholdValue"], 0.9)
        self.assertEqual(threshold["duration"], "600s")


if __name__ == "__main__":
    unittest.main()

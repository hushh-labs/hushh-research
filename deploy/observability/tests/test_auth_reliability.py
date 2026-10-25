"""Auth availability regression coverage using the existing reconciler harness."""

import contextlib
import copy
import io
import json
import re
import unittest
from unittest.mock import patch

from test_reconcile_capacity import ROOT, module


class AuthAvailabilityTest(unittest.TestCase):
    def test_monitoring_call_timeout_is_bounded_without_provider_output(self):
        import subprocess
        with patch.object(module.subprocess, "run", side_effect=subprocess.TimeoutExpired(
            "gcloud", 60, output="private-provider-output")) as execute:
            with self.assertRaisesRegex(RuntimeError, "timed out") as failure:
                module.run("gcloud", "monitoring", "policies", "list", "--format=json")
        self.assertEqual(execute.call_args.kwargs["timeout"], 60)
        self.assertNotIn("private-provider-output", str(failure.exception))

    def test_auth_failure_metric_ignores_expected_codes_and_unrelated_routes(self):
        args = module.cli(["--project", "hushh-pda-uat", "--auth-only"])
        metric = module.render(ROOT / "log-metrics/obs_auth_service_failure_count.json", args)
        expression = metric["filter"]
        patterns = []
        while "textPayload=~" in expression:
            expression = expression.split("textPayload=~", 1)[1]
            patterns.append(json.JSONDecoder().raw_decode(expression)[0])
        def matches(route, outcome):
            payload = json.dumps({"message": "request.summary", "route_template": route,
                                  "outcome_class": outcome}, separators=(",", ":"))
            return all(re.search(pattern, payload) for pattern in patterns)
        for route in ("/api/account/identity/refresh", "/api/account/phone/claim",
                      "/api/account/phone/uat-test/start", "/api/account/phone/uat-test/confirm",
                      "/db/vault/bootstrap-state"):
            self.assertTrue(matches(route, "server_error"))
            for outcome in ("success", "client_error", "expected_error"):
                self.assertFalse(matches(route, outcome))
        self.assertFalse(matches("/api/account/delete", "server_error"))
        self.assertFalse(matches("/api/account/identity/refresh?token=private", "server_error"))
        self.assertNotIn("labelExtractors", metric)

    def test_auth_reconciliation_is_disabled_by_default_bounded_and_idempotent(self):
        args = module.cli(["--project", "hushh-pda-uat", "--auth-only", "--apply"])
        self.assertFalse(args.enable_auth_alerts)
        self.assertEqual(args.email, [])
        metrics, policies, writes = [], [], []
        channels = [{"name": "projects/hushh-pda-uat/notificationChannels/existing",
                     "type": "email", "labels": {"email_address": "operator@example.org"}}]
        def readback(*command, **kwargs):
            if command[1:3] == ("logging", "metrics"):
                return copy.deepcopy(metrics)
            if command[1:4] == ("beta", "monitoring", "channels"):
                self.assertEqual(command[4], "list")
                return copy.deepcopy(channels)
            if command[1:3] == ("monitoring", "policies"):
                return copy.deepcopy(policies)
            self.fail(f"Auth mode touched unrelated surface: {command[:4]}")
        def writeback(config, action):
            writes.append(copy.deepcopy(config))
            if action[1:3] == ["logging", "metrics"]:
                metrics.append(copy.deepcopy(config))
            else:
                new = copy.deepcopy(config)
                if "name" not in new:
                    new["name"] = f"projects/hushh-pda-uat/alertPolicies/{len(policies)}"
                    policies.append(new)
                else:
                    policies[next(i for i, p in enumerate(policies) if p["name"] == new["name"])] = new
        with patch.object(module, "run", side_effect=readback), \
             patch.object(module, "write_config", side_effect=writeback), \
             contextlib.redirect_stdout(io.StringIO()):
            module.reconcile(args)
            self.assertEqual(len(writes), len(module._AUTH.METRICS) + len(module._AUTH.POLICIES))
            self.assertTrue(all(not p["enabled"] and not p["notificationChannels"] for p in policies))
            module.reconcile(args)
            self.assertEqual(len(writes), len(module._AUTH.METRICS) + len(module._AUTH.POLICIES))
            args = module.cli(["--project", "hushh-pda-uat", "--auth-only", "--apply",
                               "--enable-auth-alerts", "--email", "operator@example.org"])
            module.reconcile(args)
            self.assertTrue(all(p["enabled"] for p in policies))
            self.assertTrue(all(p["notificationChannels"] == [channels[0]["name"]] for p in policies))
            health = next(p for p in policies if "Allowlist" in p["displayName"])
            self.assertEqual(len(health["conditions"]), 1)
            self.assertTrue(all(p["alertStrategy"]["notificationPrompts"] == ["OPENED", "CLOSED"]
                                and "notificationChannelStrategy" not in p["alertStrategy"] for p in policies))
            args.enable_auth_heartbeat = True
            module.reconcile(args)
            health = next(p for p in policies if "Allowlist" in p["displayName"])
            self.assertEqual(health["conditions"][1]["conditionAbsent"]["duration"], "10800s")
            count = len(writes)
            module.reconcile(args)
            self.assertEqual(len(writes), count)
            # Duplicate policy names refuse instead of creating another incident lane.
            policies.append(copy.deepcopy(policies[0]))
            with self.assertRaisesRegex(RuntimeError, "Duplicate policies"):
                module.reconcile(args)

    def test_auth_delivery_never_creates_missing_or_disabled_channels(self):
        args = module.cli(["--project", "hushh-pda-uat", "--auth-only",
                           "--enable-auth-alerts", "--email", "operator@example.org", "--apply"])
        metrics = [module.render(ROOT / f"log-metrics/{name}.json", args) for name in module._AUTH.METRICS]
        for channels in ([], [{"name": "existing", "type": "email", "enabled": False,
                              "labels": {"email_address": "operator@example.org"}}]):
            with patch.object(module, "run", side_effect=[metrics, channels]), \
                 patch.object(module, "write_config") as writer, \
                 contextlib.redirect_stdout(io.StringIO()), self.assertRaises(RuntimeError):
                module.reconcile(args)
            writer.assert_not_called()


    def test_shared_phone_provider_policy_uses_ratio_and_minimum_count(self):
        args = module.cli(["--project", "hushh-pda", "--auth-only"])
        policy = module.render(ROOT / "alerts/auth-provider-failures-policy.json.in", args)
        self.assertEqual(policy["combiner"], "AND")
        ratio, count = [c["conditionThreshold"] for c in policy["conditions"]]
        self.assertEqual(ratio["aggregations"], ratio["denominatorAggregations"])
        self.assertEqual(ratio["aggregations"], count["aggregations"])
        self.assertEqual(ratio["duration"], "300s")
        self.assertEqual(count["duration"], "0s")
        self.assertEqual(ratio["thresholdValue"], 0.2)
        self.assertEqual(count["thresholdValue"], 9)
        self.assertEqual(ratio["filter"], count["filter"])
        self.assertIn('resource.labels.project_id="hushh-pda"', ratio["filter"])
        self.assertIn('resource.labels.service="identitytoolkit.googleapis.com"', ratio["filter"])
        self.assertIn('SendVerificationCode|SignInWithPhoneNumber', ratio["filter"])
        error_pattern = json.JSONDecoder().raw_decode(
            ratio["filter"].split('metric.labels.response_code=monitoring.regex.full_match(', 1)[1]
        )[0]
        for code in ("403", "429", "500", "502", "503", "504", "599"):
            self.assertIsNotNone(re.fullmatch(error_pattern, code))
        for code in ("200", "400", "401", "404", "409"):
            self.assertIsNone(re.fullmatch(error_pattern, code))
        self.assertNotIn("response_code", ratio["denominatorFilter"])

    def test_provider_policy_reconciles_once_only_in_shared_firebase_project(self):
        for project, expected in (("hushh-pda", 3), ("hushh-pda-uat", 2)):
            args = module.cli(["--project", project, "--auth-only", "--apply",
                               "--enable-auth-alerts", "--email", "operator@example.org"])
            metrics = [module.render(ROOT / f"log-metrics/{name}.json", args)
                       for name in module._AUTH.METRICS]
            channel = {"name": f"projects/{project}/notificationChannels/existing",
                       "type": "email", "labels": {"email_address": "operator@example.org"}}
            policies, writes = [], []
            def readback(*command, **kwargs):
                if command[1:3] == ("logging", "metrics"):
                    return copy.deepcopy(metrics)
                if command[1:4] == ("beta", "monitoring", "channels"):
                    return [channel]
                if command[1:3] == ("monitoring", "policies"):
                    return copy.deepcopy(policies)
                self.fail("Auth policy touched an unrelated surface")
            def writeback(config, action):
                new = copy.deepcopy(config)
                new["name"] = f"projects/{project}/alertPolicies/{len(policies)}"
                policies.append(new)
                writes.append(new)
            with patch.object(module, "run", side_effect=readback), \
                 patch.object(module, "write_config", side_effect=writeback), \
                 contextlib.redirect_stdout(io.StringIO()):
                module.reconcile(args)
                self.assertEqual(len(writes), expected)
                self.assertEqual(any("Firebase Phone" in p["displayName"] for p in writes),
                                 project == "hushh-pda")
                module.reconcile(args)
                self.assertEqual(len(writes), expected)

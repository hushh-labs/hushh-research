"""Contracts for capacity alert reconciliation and the actual text log shape."""

from __future__ import annotations

import contextlib
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

# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh Research
"""Offline Android property/export acceptance tests; never read credentials."""
import copy
from pathlib import Path
import unittest
import inspect_analytics_surface as surface


def fixture():
    result = {}
    for label, expected in surface.DEFAULTS["expected_streams"].items():
        streams = []
        for item in expected:
            key = {"ANDROID_APP_DATA_STREAM": "androidAppStreamData",
                   "IOS_APP_DATA_STREAM": "iosAppStreamData", "WEB_DATA_STREAM": "webStreamData"}[item["type"]]
            streams.append({"name": f"properties/fixture/dataStreams/{item['stream_id']}", "type": item["type"],
                            key: {"firebaseAppId": item.get("firebase_app_id"), "packageName": item.get("package_name"),
                                  "measurementId": item.get("measurement_id")}})
        result[label] = {"streams": streams, "key_events": [{"eventName": name} for name in surface.DEFAULTS["required_key_events"]],
                         "custom_dimensions": [{"parameterName": name, "scope": "EVENT"} for name in surface.DEFAULTS["required_custom_dimensions"]],
                         "bigquery_links": [{"dailyExportEnabled": True, "exportStreams": [stream["name"] for stream in streams]}],
                         "export_dataset": "fixture", "datasets": ["fixture"], "export_tables": ["events_20261007"]}
    return result


class AndroidExportAcceptance(unittest.TestCase):
    def test_expected_resource_names_pass(self):
        self.assertTrue(surface.validate(fixture())["ok"])

    def test_wrong_package_or_app_or_missing_export_fails(self):
        baseline = fixture()
        for failure in ["package", "firebase_app", "membership", "daily"]:
            data = copy.deepcopy(baseline)
            production = data["production"]
            android = next(stream for stream in production["streams"] if stream["name"].endswith("/15395548050"))
            if failure == "package": android["androidAppStreamData"]["packageName"] = "com.hushh.app"
            elif failure == "firebase_app": android["androidAppStreamData"]["firebaseAppId"] = "wrong-app"
            elif failure == "membership": production["bigquery_links"][0]["exportStreams"].remove(android["name"])
            else: production["bigquery_links"][0]["dailyExportEnabled"] = False
            with self.subTest(failure=failure): self.assertFalse(surface.validate(data)["ok"])

    def test_every_customer_query_excludes_legacy_and_explicit_debug_events(self):
        sql = (Path(__file__).resolve().parents[4] /
               "consent-protocol/scripts/observability/ga4_growth_dashboard_queries.sql").read_text()
        def scoped(text):
            count = text.count("FROM `{{PROJECT_ID}}.{{DATASET}}.events_*`")
            self.assertGreater(count, 0)
            self.assertEqual(text.count("stream_id NOT IN ('13702689760', '13694989021')"), count)
            self.assertEqual(text.count("WHERE debug_param.key = 'debug_mode'"), count)
            self.assertEqual(text.count("COALESCE(debug_param.value.int_value, 0) = 1"), count)
            self.assertEqual(text.count("LOWER(COALESCE(debug_param.value.string_value, '')) IN ('1', 'true')"), count)
        scoped(sql)
        # Negative controls: dropping either boundary in one actual query fails.
        for predicate in ["stream_id NOT IN ('13702689760', '13694989021')",
                          "WHERE debug_param.key = 'debug_mode'"]:
            with self.subTest(predicate=predicate), self.assertRaises(AssertionError):
                scoped(sql.replace(predicate, "TRUE", 1))


if __name__ == "__main__":
    unittest.main()

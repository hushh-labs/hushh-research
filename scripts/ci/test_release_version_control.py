# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Unit and contract tests for uniform YY.M.N versioning, bundle manifests, and ring control."""

from __future__ import annotations

import datetime as dt
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import release_version_control as rvc  # noqa: E402


class ReleaseVersionControlTests(unittest.TestCase):
    def test_next_version_continues_from_legacy_nov_2026_tags_at_26_11_50(self) -> None:
        tags = ["train/2026.11.40", "train/2026.11.48", "deployed/uat-latest"]
        ver = rvc.next_yymn_version(tags, today=dt.date(2026, 11, 28))
        self.assertEqual(str(ver), "26.11.50")
        self.assertEqual(ver.git_tag, "v26.11.50")
        self.assertEqual(ver.train_tag, "train/26.11.50")

    def test_next_version_increments_within_month_and_rolls_over_month_and_year(self) -> None:
        tags = ["train/2026.11.48", "v26.11.50", "train/26.11.51"]
        self.assertEqual(str(rvc.next_yymn_version(tags, today=dt.date(2026, 11, 29))), "26.11.52")
        self.assertEqual(str(rvc.next_yymn_version(tags, today=dt.date(2026, 12, 1))), "26.12.1")
        self.assertEqual(
            str(rvc.next_yymn_version([*tags, "v26.12.9"], today=dt.date(2027, 1, 1))),
            "27.1.1",
        )

    def test_rejects_leading_zeros_and_malformed_semver_versions(self) -> None:
        for invalid in ("2026.11.50", "26.01.1", "26.11.01", "06.11.1", "26.13.1", "26.11.0", "1.4"):
            with self.assertRaises(rvc.UnsafeReleaseBundle, msg=f"Expected rejection for {invalid}"):
                rvc.parse_yymn(invalid)

    def test_dev_nightly_version_stamps_without_burning_release_numbers(self) -> None:
        self.assertEqual(rvc.format_dev_nightly_version("26.11.50", 4, "ce27bc31"), "26.11.50-dev.4+ce27bc31")
        with self.assertRaises(rvc.UnsafeReleaseBundle):
            rvc.format_dev_nightly_version("26.11.50", 0)

    def test_android_version_code_monotonic_across_resubmits_months_and_years(self) -> None:
        c_nov_base = rvc.compute_android_version_code("26.11.50", resubmit_slot=0, previous_version_code=2)
        c_nov_resubmit = rvc.compute_android_version_code(
            "26.11.50", resubmit_slot=1, previous_version_code=c_nov_base
        )
        c_nov_next = rvc.compute_android_version_code(
            "26.11.51", resubmit_slot=0, previous_version_code=c_nov_resubmit
        )
        c_dec = rvc.compute_android_version_code("26.12.1", resubmit_slot=0, previous_version_code=c_nov_next)
        c_jan = rvc.compute_android_version_code("27.1.1", resubmit_slot=0, previous_version_code=c_dec)

        self.assertEqual(c_nov_base, 261100500)
        self.assertEqual(c_nov_resubmit, 261100501)
        self.assertLess(c_nov_resubmit, c_nov_next)
        self.assertLess(c_nov_next, c_dec)
        self.assertLess(c_dec, c_jan)
        self.assertLess(rvc.compute_android_version_code("99.12.9999", resubmit_slot=9), rvc.MAX_PLAY_VERSION_CODE)

        with self.assertRaises(rvc.UnsafeReleaseBundle):
            rvc.compute_android_version_code("26.11.50", resubmit_slot=10)
        with self.assertRaises(rvc.UnsafeReleaseBundle):
            rvc.compute_android_version_code("26.11.50", resubmit_slot=0, previous_version_code=261100500)

    def test_partial_plan_switch_contract_allows_gated_and_blocks_ungated_plans(self) -> None:
        switches = rvc.validate_partial_plan_switches(
            [
                {"issue": "#10201", "completed_steps": 4, "total_steps": 4},
                {
                    "issue": "#10202",
                    "completed_steps": 2,
                    "total_steps": 5,
                    "switch_name": "one_multi_account_connectors",
                    "disabled_outside_dev": True,
                },
            ]
        )
        self.assertEqual(switches, ["one_multi_account_connectors"])

        # Negative control: partial multi-step plan missing an active Off switch outside Dev must fail closed.
        with self.assertRaises(rvc.UnsafeReleaseBundle):
            rvc.validate_partial_plan_switches(
                [
                    {
                        "issue": "#10203",
                        "completed_steps": 1,
                        "total_steps": 3,
                        "switch_name": "",
                        "disabled_outside_dev": False,
                    }
                ]
            )

    def test_bundle_manifest_and_control_center_round_trip(self) -> None:
        digest_a = "sha256:" + "a" * 64
        digest_b = "sha256:" + "b" * 64
        digest_c = "sha256:" + "c" * 64
        sha = "d" * 40
        bundle = rvc.build_release_bundle_manifest(
            version="26.11.50",
            source_sha=sha,
            web_image_digest=digest_a,
            backend_image_digest=digest_b,
            pod_image_digest=digest_c,
            db_schema_version=465,
            ios_min_version="1.4.1",
            android_min_version_code=2,
            plans=[
                {
                    "issue": "#10210",
                    "completed_steps": 1,
                    "total_steps": 4,
                    "switch_name": "one_adk_multimodal_composer",
                    "disabled_outside_dev": True,
                }
            ],
            created_at="2026-11-28T05:00:00Z",
        )
        self.assertEqual(bundle["version"], "26.11.50")
        self.assertEqual(bundle["verified_off_switches"], ["one_adk_multimodal_composer"])
        self.assertEqual(len(bundle["bundle_sha256"]), 64)

        snapshot = {
            "updated_at": "2026-11-28T05:00:00Z",
            "next_version": "26.11.50",
            "rings": [
                {
                    "name": "Production",
                    "version": "1.1.0 (baseline)",
                    "posture": "live",
                    "hold_active": True,
                    "web_revision": "hushh-webapp-00170-75f",
                    "backend_revision": "consent-protocol-00354-xeh",
                    "web_sha": "686d7431",
                    "backend_sha": "686d7431",
                    "branch_sha": "baee2201",
                    "warm_pods": 0,
                    "db_schema": 465,
                },
                {
                    "name": "Cold Dark Stage",
                    "version": "26.11.49-rc",
                    "posture": "stage_dark",
                    "public_traffic_percent": 0,
                    "web_revision": "hushh-webapp-00268-vex",
                    "backend_revision": "consent-protocol-00359-zep",
                    "warm_pods": 0,
                    "db_schema": 465,
                },
            ],
            "mobile_stores": [
                {"channel": "iOS App Store", "version": "1.4.1", "build_code": "69", "status": "LIVE"},
                {"channel": "Android Google Play", "version": "1.3.9", "build_code": "2", "status": "LIVE"},
            ],
            "active_plans": [
                {
                    "title": "Multi-Account Connectors",
                    "milestone": "26.11.50",
                    "completed_steps": 1,
                    "total_steps": 3,
                    "switch_name": "one_multi_account_connectors",
                }
            ],
        }
        markdown = rvc.render_control_center_markdown(snapshot)
        self.assertIn("HELD_ON_BASELINE", markdown)
        self.assertIn("DARK_STAGE_COLD_READY", markdown)
        extracted = rvc.extract_snapshot_from_markdown(markdown)
        assert extracted is not None
        self.assertEqual(extracted["next_version"], "26.11.50")
        self.assertEqual(extracted["rings"][0]["status"], "HELD_ON_BASELINE")
        self.assertEqual(extracted["rings"][1]["status"], "DARK_STAGE_COLD_READY")

    def test_issue_templates_target_project_79_without_legacy_freeform_files(self) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        template_dir = repo_root / ".github" / "ISSUE_TEMPLATE"
        self.assertFalse((template_dir / "bug_report.md").exists())
        self.assertFalse((template_dir / "feature_request.md").exists())
        for filename in ("01-product-plan.yml", "02-engineering-task.yml", "03-bug-regression.yml"):
            content = (template_dir / filename).read_text(encoding="utf-8")
            self.assertIn('projects: ["hushh-labs/79"]', content)


if __name__ == "__main__":
    unittest.main()

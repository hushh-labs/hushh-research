#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

import importlib.util
import pathlib
import unittest
from unittest.mock import patch


MODULE_PATH = pathlib.Path(__file__).with_name("resolve-ios-build-number.py")
SPEC = importlib.util.spec_from_file_location("resolve_ios_build_number", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

RELEASE_SPEC = importlib.util.spec_from_file_location(
    "submit_appstore_version",
    pathlib.Path(__file__).with_name("submit-appstore-version.py"),
)
assert RELEASE_SPEC is not None and RELEASE_SPEC.loader is not None
RELEASE = importlib.util.module_from_spec(RELEASE_SPEC)
RELEASE_SPEC.loader.exec_module(RELEASE)


class ResolveIOSBuildNumberTests(unittest.TestCase):
    def test_retained_failed_upload_advances_build_number(self) -> None:
        self.assertEqual(MODULE.resolve_next_build_number(89, 89, 90), 91)

    def test_normal_build_remains_the_floor_when_it_is_highest(self) -> None:
        self.assertEqual(MODULE.resolve_next_build_number(40, 92, 90), 93)

    def test_latest_upload_number_paginates_and_ignores_invalid_values(self) -> None:
        first_url = "https://api.appstoreconnect.apple.com/v1/apps/app-id/buildUploads"
        second_url = "https://example.test/next"
        responses = [
            {
                "data": [
                    {"attributes": {"cfBundleVersion": "90"}},
                    {"attributes": {"cfBundleVersion": "not-numeric"}},
                ],
                "links": {"next": second_url},
            },
            {
                "data": [{"attributes": {"cfBundleVersion": "91"}}],
                "links": {},
            },
        ]

        with patch.object(MODULE, "asc_get", side_effect=responses) as asc_get:
            self.assertEqual(MODULE.latest_upload_number("token", "app-id"), 91)

        self.assertIn(first_url, asc_get.call_args_list[0].args[0])
        self.assertEqual(asc_get.call_args_list[1].args[0], second_url)


class AppStoreReleaseReadbackTests(unittest.TestCase):
    def verify(self, *, build_id="build", state="WAITING_FOR_REVIEW", notes="Notes"):
        responses = [
            {
                "data": {
                    "id": "version",
                    "attributes": {
                        "releaseType": "MANUAL",
                        "appStoreState": "WAITING_FOR_REVIEW",
                    },
                }
            },
            {"data": {"id": build_id}},
            {"data": [{"attributes": {"whatsNew": notes}}]},
            {"data": {"id": "submission", "attributes": {"state": state}}},
        ]
        with (
            patch.object(RELEASE, "asc_get", side_effect=responses),
            patch.object(RELEASE, "review_submission_has_version", return_value=True),
        ):
            return RELEASE.verify_release_state(
                "synthetic", "version", "build", "MANUAL", "Notes", "submission"
            )

    def test_receipt_requires_readback_of_exact_build_notes_and_submission(self):
        receipt = self.verify()
        self.assertEqual(receipt["submission_state"], "WAITING_FOR_REVIEW")
        self.assertNotIn("Notes", str(receipt))
        for changed in [
            {"build_id": "wrong-build"},
            {"state": "READY_FOR_REVIEW"},
            {"state": "COMPLETE"},
            {"notes": "Old notes"},
        ]:
            with self.subTest(changed=changed), self.assertRaises(SystemExit):
                self.verify(**changed)

    def test_unverified_preparation_cannot_submit_for_review(self):
        with (
            patch.object(RELEASE, "read_pbxproj_values", return_value=(1, "1.4.0")),
            patch.object(RELEASE, "mint_jwt", return_value="synthetic"),
            patch.object(RELEASE, "resolve_app_id", return_value="app"),
            patch.object(
                RELEASE, "ensure_app_store_version", return_value={"id": "version"}
            ),
            patch.object(RELEASE, "set_whats_new"),
            patch.object(RELEASE, "wait_for_build", return_value={"id": "build"}),
            patch.object(RELEASE, "attach_build"),
            patch.object(RELEASE, "verify_release_state", side_effect=SystemExit(1)),
            patch.object(RELEASE, "submit_for_review") as submit,
        ):
            with self.assertRaises(SystemExit):
                RELEASE.main(
                    [
                        "--p8-path",
                        "/dev/null",
                        "--key-id",
                        "synthetic",
                        "--issuer-id",
                        "synthetic",
                        "--build-number",
                        "1",
                        "--whats-new",
                        "Notes",
                        "--submit",
                    ]
                )
            submit.assert_not_called()


if __name__ == "__main__":
    unittest.main()

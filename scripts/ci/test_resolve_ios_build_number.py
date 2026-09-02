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


if __name__ == "__main__":
    unittest.main()

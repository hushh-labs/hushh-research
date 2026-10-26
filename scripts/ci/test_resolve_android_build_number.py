#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

import importlib.util
import io
import pathlib
import unittest
import urllib.error
from unittest.mock import patch


MODULE_PATH = pathlib.Path(__file__).with_name("resolve-android-build-number.py")
SPEC = importlib.util.spec_from_file_location(
    "resolve_android_build_number", MODULE_PATH
)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ResolveAndroidBuildNumberTests(unittest.TestCase):
    def test_next_version_code_advances_above_both_floors(self) -> None:
        self.assertEqual(MODULE.resolve_next_version_code(2, 10), 11)
        self.assertEqual(MODULE.resolve_next_version_code(12, 10), 13)

    def test_highest_play_version_code_reads_tracks_bundles_and_apks(self) -> None:
        responses = [
            {"id": "edit-id"},
            {
                "tracks": [
                    {
                        "track": "production",
                        "releases": [
                            {"versionCodes": ["8", "10"]},
                            {"versionCodes": ["invalid"]},
                        ],
                    },
                    {"track": "internal", "releases": [{"versionCodes": ["9"]}]},
                ]
            },
            {"bundles": [{"versionCode": 12}, {"versionCode": "invalid"}]},
            {"apks": [{"versionCode": 11}]},
            {},  # Delete this resolver's temporary snapshot edit.
        ]
        with patch.object(MODULE, "play_request", side_effect=responses) as request:
            self.assertEqual(
                MODULE.highest_play_version_code("token", "com.hussh.app"), 12
            )
        request.assert_called_with(
            f"{MODULE.PLAY_API_ROOT}/applications/com.hussh.app/edits/edit-id",
            "token",
            method="DELETE",
        )

    def test_empty_returned_tracks_are_a_real_zero_history(self) -> None:
        with patch.object(
            MODULE,
            "play_request",
            side_effect=[
                {"id": "edit-id"},
                {"tracks": []},
                {"bundles": []},
                {"apks": []},
                {},
            ],
        ):
            self.assertEqual(
                MODULE.highest_play_version_code("token", "com.hussh.app"), 0
            )

    def test_play_authorization_and_package_errors_fail_closed(self) -> None:
        for status in (403, 404):
            with self.subTest(status=status):
                error = urllib.error.HTTPError(
                    "https://androidpublisher.googleapis.com/example",
                    status,
                    "denied",
                    hdrs=None,
                    fp=io.BytesIO(b'{"error":"denied"}'),
                )
                with (
                    patch.object(MODULE, "play_request", return_value=error),
                    self.assertRaises(SystemExit),
                ):
                    MODULE.highest_play_version_code("token", "com.hussh.app")

    def test_temporary_edit_is_deleted_when_a_listing_fails(self) -> None:
        error = urllib.error.HTTPError(
            "https://androidpublisher.googleapis.com/example",
            403,
            "denied",
            hdrs=None,
            fp=io.BytesIO(b'{"error":"denied"}'),
        )
        responses = iter([{"id": "owned-edit"}, error, {}])
        with (
            patch.object(
                MODULE,
                "play_request",
                side_effect=lambda *args, **kwargs: next(responses),
            ) as request,
            self.assertRaises(SystemExit),
        ):
            MODULE.highest_play_version_code("token", "com.hussh.app")
        request.assert_called_with(
            f"{MODULE.PLAY_API_ROOT}/applications/com.hussh.app/edits/owned-edit",
            "token",
            method="DELETE",
        )

    def test_unconfirmed_edit_cleanup_does_not_return_a_version_floor(self) -> None:
        error = urllib.error.HTTPError(
            "https://androidpublisher.googleapis.com/example",
            503,
            "unavailable",
            hdrs=None,
            fp=io.BytesIO(b"private-provider-diagnostic"),
        )
        responses = iter(
            [
                {"id": "owned-edit"},
                {"tracks": []},
                {"bundles": []},
                {"apks": []},
                error,
            ]
        )
        with (
            patch.object(
                MODULE,
                "play_request",
                side_effect=lambda *args, **kwargs: next(responses),
            ),
            patch("sys.stderr", new_callable=io.StringIO) as diagnostics,
            self.assertRaises(SystemExit),
        ):
            MODULE.highest_play_version_code("token", "com.hussh.app")
        self.assertIn("cleanup is unconfirmed", diagnostics.getvalue())
        self.assertNotIn("private-provider-diagnostic", diagnostics.getvalue())

    def test_listing_parse_and_cleanup_transport_failures_still_fail_closed(
        self,
    ) -> None:
        cases = [
            ([{"id": "owned-edit"}, ValueError("invalid JSON"), {}], ValueError),
            ([{"id": "owned-edit"}, {}, {}, {}, SystemExit(1)], SystemExit),
        ]
        for responses, expected_error in cases:
            with self.subTest(error=expected_error.__name__):
                pending = iter(responses)

                def request(*args, **kwargs):
                    value = next(pending)
                    if isinstance(value, BaseException):
                        raise value
                    return value

                with (
                    patch.object(MODULE, "play_request", side_effect=request) as mocked,
                    self.assertRaises(expected_error),
                ):
                    MODULE.highest_play_version_code("token", "com.hussh.app")
                mocked.assert_called_with(
                    f"{MODULE.PLAY_API_ROOT}/applications/com.hussh.app/edits/owned-edit",
                    "token",
                    method="DELETE",
                )


if __name__ == "__main__":
    unittest.main()

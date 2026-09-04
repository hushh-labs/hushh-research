#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Unit tests for the fail-closed TestFlight processing gate."""

from __future__ import annotations

import unittest

import wait_for_testflight_build as gate


def upload_payload(
    state: str,
    *,
    details: list[dict[str, str]] | None = None,
    build_state: str | None = None,
) -> dict:
    payload: dict = {
        "data": [
            {
                "type": "buildUploads",
                "attributes": {
                    "cfBundleShortVersionString": "1.3.9",
                    "cfBundleVersion": "90",
                    "state": {
                        "state": state,
                        "errors": details or [],
                        "warnings": [],
                        "infos": [],
                    },
                },
            }
        ]
    }
    if build_state is not None:
        payload["included"] = [
            {
                "type": "builds",
                "attributes": {
                    "version": "90",
                    "processingState": build_state,
                    "usesNonExemptEncryption": False,
                },
            }
        ]
    return payload


class Clock:
    def __init__(self) -> None:
        self.value = 0.0

    def now(self) -> float:
        return self.value

    def sleep(self, seconds: float) -> None:
        self.value += seconds


class WaitForTestFlightBuildTests(unittest.TestCase):
    def wait(self, payloads: list[dict], timeout: int = 30) -> dict:
        clock = Clock()
        remaining = list(payloads)

        def get_payload(url: str) -> dict:
            if "buildUploads" not in url:
                return {"data": []}
            if len(remaining) > 1:
                return remaining.pop(0)
            return remaining[0]

        return gate.wait_for_testflight_build(
            app_id="6757718917",
            marketing_version="1.3.9",
            build_number="90",
            platform="IOS",
            timeout_seconds=timeout,
            poll_interval_seconds=5,
            get_payload=get_payload,
            now=clock.now,
            sleep=clock.sleep,
        )

    def test_upload_failure_surfaces_apple_issue_code(self) -> None:
        payload = upload_payload(
            "FAILED",
            details=[
                {
                    "code": "ITMS-90129",
                    "description": "The bundle uses a display name that is already taken.",
                }
            ],
        )
        with self.assertRaisesRegex(gate.BuildUploadFailed, "ITMS-90129"):
            self.wait([payload])

    def test_complete_upload_requires_valid_testflight_build(self) -> None:
        build = self.wait(
            [
                upload_payload("PROCESSING"),
                upload_payload("COMPLETE", build_state="PROCESSING"),
                upload_payload("COMPLETE", build_state="VALID"),
            ]
        )
        self.assertEqual(build["attributes"]["processingState"], "VALID")

    def test_invalid_testflight_build_fails_closed(self) -> None:
        with self.assertRaises(gate.TestFlightBuildFailed):
            self.wait([upload_payload("COMPLETE", build_state="INVALID")])

    def test_timeout_is_an_error(self) -> None:
        with self.assertRaisesRegex(
            TimeoutError,
            "last state: build upload PROCESSING; build not found",
        ):
            self.wait([upload_payload("PROCESSING")], timeout=10)

    def test_repeated_transient_api_errors_fail_on_timeout(self) -> None:
        clock = Clock()

        def get_payload(_url: str) -> dict:
            raise gate.AscTransientError("HTTP 503 while querying Apple")

        with self.assertRaisesRegex(TimeoutError, "transient upload API error"):
            gate.wait_for_testflight_build(
                app_id="6757718917",
                marketing_version="1.3.9",
                build_number="90",
                platform="IOS",
                timeout_seconds=10,
                poll_interval_seconds=5,
                get_payload=get_payload,
                now=clock.now,
                sleep=clock.sleep,
            )

    def test_transient_build_lookup_recovers_after_upload_completes(self) -> None:
        clock = Clock()
        build_requests = 0

        def get_payload(url: str) -> dict:
            nonlocal build_requests
            if "buildUploads" in url:
                return upload_payload("COMPLETE")
            build_requests += 1
            if build_requests == 1:
                raise gate.AscTransientError("HTTP 503 while querying Apple")
            return {
                "data": [
                    {
                        "type": "builds",
                        "attributes": {
                            "version": "90",
                            "processingState": "VALID",
                            "usesNonExemptEncryption": False,
                        },
                    }
                ]
            }

        build = gate.wait_for_testflight_build(
            app_id="6757718917",
            marketing_version="1.3.9",
            build_number="90",
            platform="IOS",
            timeout_seconds=15,
            poll_interval_seconds=5,
            get_payload=get_payload,
            now=clock.now,
            sleep=clock.sleep,
        )
        self.assertEqual(build["attributes"]["processingState"], "VALID")

    def test_valid_build_wins_when_upload_state_lags(self) -> None:
        def get_payload(url: str) -> dict:
            if "buildUploads" in url:
                return upload_payload("AWAITING_UPLOAD")
            return {
                "data": [
                    {
                        "type": "builds",
                        "attributes": {
                            "version": "90",
                            "processingState": "VALID",
                            "usesNonExemptEncryption": False,
                        },
                    }
                ]
            }

        build = gate.wait_for_testflight_build(
            app_id="6757718917",
            marketing_version="1.3.9",
            build_number="90",
            platform="IOS",
            timeout_seconds=10,
            poll_interval_seconds=5,
            get_payload=get_payload,
        )
        self.assertEqual(build["attributes"]["processingState"], "VALID")

    def test_exact_build_upload_is_selected(self) -> None:
        payload = upload_payload("COMPLETE", build_state="VALID")
        payload["data"].insert(
            0,
            {
                "type": "buildUploads",
                "attributes": {
                    "cfBundleShortVersionString": "1.3.9",
                    "cfBundleVersion": "89",
                    "state": {"state": "FAILED", "errors": []},
                },
            },
        )
        build = self.wait([payload])
        self.assertEqual(build["attributes"]["version"], "90")


if __name__ == "__main__":
    unittest.main()

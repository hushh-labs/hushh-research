#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

import json
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

_SPEC = importlib.util.spec_from_file_location(
    "distribute_testflight_build",
    Path(__file__).with_name("distribute-testflight-build.py"),
)
if _SPEC is None or _SPEC.loader is None:  # pragma: no cover - import guard
    raise RuntimeError("cannot load distribute-testflight-build.py")
subject = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = subject
_SPEC.loader.exec_module(subject)


APP_ID = "1234567890"
BUILD_ID = "1234567891"
INTERNAL_GROUP_ID = "1234567892"
EXTERNAL_GROUP_ID = "1234567893"


def configuration() -> subject.DistributionConfiguration:
    return subject.DistributionConfiguration.from_values(
        internal_group_id=INTERNAL_GROUP_ID,
        external_group_id=EXTERNAL_GROUP_ID,
        review_contact_json=json.dumps(
            {
                "first_name": "Release",
                "last_name": "Owner",
                "email": "release@example.test",
                "phone": "+1 555 0100",
            }
        ),
        review_notes="Test the private agent voice handoff.",
    )


class FakeApple:
    def __init__(self, *, external_review_state: str | None = "APPROVED") -> None:
        self.external_review_state = external_review_state
        self.assignments: dict[str, set[str]] = {
            INTERNAL_GROUP_ID: set(),
            EXTERNAL_GROUP_ID: set(),
        }
        self.calls: list[tuple[str, str, dict[str, Any] | None]] = []

    def request(self, method: str, url: str, payload: dict[str, Any] | None) -> dict[str, Any]:
        self.calls.append((method, url, payload))
        path = url.split(".com", 1)[-1]
        if method == "GET" and path.startswith(f"/v1/apps/{APP_ID}/buildUploads?"):
            return {
                "data": [
                    {
                        "type": "buildUploads",
                        "attributes": {
                            "cfBundleShortVersionString": "1.4.0",
                            "cfBundleVersion": "69",
                        },
                        "relationships": {
                            "build": {"data": {"type": "builds", "id": BUILD_ID}}
                        },
                    }
                ],
                "included": [
                    {
                        "type": "builds",
                        "id": BUILD_ID,
                        "attributes": {"version": "69", "processingState": "VALID"},
                    }
                ],
            }
        if method == "GET" and path.startswith("/v1/builds?"):
            return {
                "data": [
                    {
                        "type": "builds",
                        "id": BUILD_ID,
                        "attributes": {"version": "69", "processingState": "VALID"},
                    }
                ]
            }
        if method == "GET" and path.startswith("/v1/betaGroups/") and "relationships/builds" not in path:
            group_id = path.split("/v1/betaGroups/", 1)[1].split("?", 1)[0]
            return {
                "data": {
                    "type": "betaGroups",
                    "id": group_id,
                    "attributes": {"isInternalGroup": group_id == INTERNAL_GROUP_ID},
                }
            }
        if method == "GET" and "relationships/builds" in path:
            group_id = path.split("/v1/betaGroups/", 1)[1].split("/", 1)[0]
            return {
                "data": [
                    {"type": "builds", "id": build_id}
                    for build_id in sorted(self.assignments[group_id])
                ],
                "links": {},
            }
        if method == "POST" and "relationships/builds" in path:
            group_id = path.split("/v1/betaGroups/", 1)[1].split("/", 1)[0]
            self.assignments[group_id].add(payload["data"][0]["id"])
            return {"data": payload["data"]}
        if method == "GET" and path.startswith(f"/v1/apps/{APP_ID}/betaAppReviewDetail"):
            return {"data": None}
        if method == "POST" and path == "/v1/betaAppReviewDetails":
            return {"data": {"type": "betaAppReviewDetails", "id": "detail-1"}}
        if method == "GET" and path.startswith(f"/v1/builds/{BUILD_ID}/betaBuildLocalizations"):
            return {"data": []}
        if method == "POST" and path == "/v1/betaBuildLocalizations":
            return {"data": {"type": "betaBuildLocalizations", "id": "localization-1"}}
        if method == "GET" and path == f"/v1/builds/{BUILD_ID}/betaAppReviewSubmission":
            if self.external_review_state is None:
                return {"data": None}
            return {
                "data": {
                    "type": "betaAppReviewSubmissions",
                    "id": "submission-1",
                    "attributes": {"betaReviewState": self.external_review_state},
                }
            }
        if method == "POST" and path == "/v1/betaAppReviewSubmissions":
            return {
                "data": {
                    "type": "betaAppReviewSubmissions",
                    "id": "submission-1",
                    "attributes": {"betaReviewState": "WAITING_FOR_REVIEW"},
                }
            }
        raise AssertionError(f"unexpected App Store Connect request {method} {path}")


class DistributeTestFlightBuildTests(unittest.TestCase):
    def run_distribution(self, apple: FakeApple) -> dict[str, str]:
        return subject.distribute_valid_build(
            client=subject.AppStoreConnectClient("test", request=apple.request),
            app_id=APP_ID,
            marketing_version="1.4.0",
            build_number="69",
            configuration=configuration(),
        )

    def test_assigns_the_same_valid_build_to_both_group_types(self) -> None:
        apple = FakeApple(external_review_state="APPROVED")
        result = self.run_distribution(apple)

        self.assertEqual(result["internal"], "active")
        self.assertEqual(result["external"], "active")
        self.assertEqual(apple.assignments[INTERNAL_GROUP_ID], {BUILD_ID})
        self.assertEqual(apple.assignments[EXTERNAL_GROUP_ID], {BUILD_ID})
        self.assertFalse(any("appStoreVersions" in url or "reviewSubmissions" in url for _, url, _ in apple.calls))

    def test_exact_build_id_handoff_does_not_requery_transient_upload(self) -> None:
        apple = FakeApple(external_review_state="APPROVED")
        result = subject.distribute_valid_build(
            client=subject.AppStoreConnectClient("test", request=apple.request),
            app_id=APP_ID,
            marketing_version="1.4.0",
            build_number="69",
            configuration=configuration(),
            build_id=BUILD_ID,
        )

        self.assertEqual(result["build_id"], BUILD_ID)
        self.assertFalse(any("buildUploads" in url for _, url, _ in apple.calls))

    def test_build_id_file_requires_the_processing_gate_contract(self) -> None:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as handle:
            json.dump(
                {
                    "type": "builds",
                    "id": BUILD_ID,
                    "attributes": {"processingState": "VALID"},
                },
                handle,
            )
            handle.flush()
            self.assertEqual(
                subject.read_build_id_file(handle.name, build_number="69"), BUILD_ID
            )

        with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as handle:
            json.dump(
                {
                    "type": "builds",
                    "id": BUILD_ID,
                    "attributes": {"processingState": "PROCESSING"},
                },
                handle,
            )
            handle.flush()
            with self.assertRaisesRegex(subject.DistributionError, "not VALID"):
                subject.read_build_id_file(handle.name, build_number="69")

    def test_existing_group_assignment_is_idempotent(self) -> None:
        apple = FakeApple(external_review_state="WAITING_FOR_REVIEW")
        apple.assignments[INTERNAL_GROUP_ID].add(BUILD_ID)
        apple.assignments[EXTERNAL_GROUP_ID].add(BUILD_ID)

        result = self.run_distribution(apple)

        self.assertEqual(result["internal_assignment"], "already_assigned")
        self.assertEqual(result["external_assignment"], "already_assigned")
        self.assertEqual(result["external"], "pending_apple_beta_review")

    def test_new_external_submission_is_pending_not_misreported_as_active(self) -> None:
        apple = FakeApple(external_review_state=None)

        result = self.run_distribution(apple)

        self.assertEqual(result["external"], "pending_apple_beta_review")
        self.assertEqual(result["external_beta_review_state"], "WAITING_FOR_REVIEW")

    def test_external_review_rejection_fails_closed(self) -> None:
        with self.assertRaisesRegex(subject.DistributionError, "rejected"):
            self.run_distribution(FakeApple(external_review_state="REJECTED"))

    def test_invalid_or_missing_release_configuration_fails_closed(self) -> None:
        with self.assertRaisesRegex(subject.DistributionError, "must differ"):
            subject.DistributionConfiguration.from_values(
                internal_group_id=INTERNAL_GROUP_ID,
                external_group_id=INTERNAL_GROUP_ID,
                review_contact_json="{}",
                review_notes="notes",
            )
        with self.assertRaisesRegex(subject.DistributionError, "beta review notes"):
            subject.DistributionConfiguration.from_values(
                internal_group_id=INTERNAL_GROUP_ID,
                external_group_id=EXTERNAL_GROUP_ID,
                review_contact_json=json.dumps(
                    {
                        "first_name": "A",
                        "last_name": "B",
                        "email": "a@example.test",
                        "phone": "+1",
                    }
                ),
                review_notes="",
            )


if __name__ == "__main__":
    unittest.main()

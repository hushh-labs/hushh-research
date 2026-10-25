#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

import importlib.util
import io
import os
import pathlib
import tempfile
import unittest
from copy import deepcopy
from contextlib import redirect_stderr, redirect_stdout
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


class AppStoreDraftAdvancementTests(unittest.TestCase):
    def setUp(self):
        self.draft = {"id": "draft", "attributes": {"platform": "IOS", "versionString": "1.4.2",
                      "appStoreState": "DEVELOPER_REJECTED", "releaseType": "MANUAL"}}
        self.updated = deepcopy(self.draft)
        self.updated["attributes"].update(versionString="2.0.0", releaseType="AFTER_APPROVAL")
        for name, options in [("find_app_store_version", {"return_value": None}),
                              ("asc_get", {}), ("asc_patch", {}),
                              ("asc_post", {"side_effect": AssertionError("unexpected second draft")})]:
            owner = patch.object(RELEASE, name, **options)
            setattr(self, name, owner.start())
            self.addCleanup(owner.stop)
        quiet = redirect_stderr(io.StringIO())
        quiet.__enter__()
        self.addCleanup(quiet.__exit__, None, None, None)

    def ensure(self, catalog=None, fresh=None, updated=None, target="2.0.0"):
        self.asc_get.side_effect = [{"data": [self.draft] if catalog is None else catalog},
                                   {"data": self.draft if fresh is None else fresh},
                                   {"data": self.updated if updated is None else updated}]
        return RELEASE.ensure_app_store_version("token", "app", target, "IOS", "AFTER_APPROVAL")

    def test_higher_beta_floor_advances_paginated_current_draft_without_creation(self):
        self.asc_get.side_effect = [
            {"data": [], "links": {"next": "https://api.appstoreconnect.apple.com/next"}},
            {"data": [self.draft]}, {"data": self.draft}, {"data": self.updated}]
        self.assertEqual(RELEASE.ensure_app_store_version("token", "app", "2.0.0", "IOS", "AFTER_APPROVAL"), self.updated)
        self.asc_post.assert_not_called()
        self.asc_patch.assert_called_once_with(
            "https://api.appstoreconnect.apple.com/v1/appStoreVersions/draft", "token",
            {"data": {"type": "appStoreVersions", "id": "draft",
                      "attributes": {"versionString": "2.0.0", "releaseType": "AFTER_APPROVAL"}}})
        self.assertEqual(self.asc_get.call_args_list[-2].args[0], self.asc_get.call_args_list[-1].args[0])

    def test_ambiguous_noncurrent_or_reviewed_drafts_never_write(self):
        for defect in ("duplicate", "multiple", "newer_live", "review", "platform", "id", "downgrade"):
            with self.subTest(defect=defect):
                records = [deepcopy(self.draft)]
                target = "1.4.1" if defect == "downgrade" else "2.0.0"
                if defect in {"duplicate", "multiple", "newer_live"}:
                    other = deepcopy(self.draft)
                    other["id"] = "other"
                    if defect == "multiple":
                        other["attributes"]["versionString"] = "1.4.1"
                    if defect == "newer_live":
                        other["attributes"].update(versionString="1.5.0", appStoreState="READY_FOR_SALE")
                    records.append(other)
                if defect == "review":
                    records[0]["attributes"]["appStoreState"] = "IN_REVIEW"
                if defect == "platform":
                    records[0]["attributes"]["platform"] = "MAC_OS"
                if defect == "id":
                    records[0].pop("id")
                with self.assertRaises(SystemExit):
                    self.ensure(catalog=records, target=target)
                self.asc_patch.assert_not_called()
                self.asc_post.assert_not_called()

    def test_draft_race_and_readback_are_fail_closed(self):
        for phase in ("fresh", "updated"):
            for field, value in (("id", "other"), ("platform", "MAC_OS"), ("versionString", "1.5.0"),
                                 ("releaseType", "SCHEDULED"), ("appStoreState", "IN_REVIEW")):
                with self.subTest(phase=phase, field=field):
                    record = deepcopy(self.draft if phase == "fresh" else self.updated)
                    (record if field == "id" else record["attributes"])[field] = value
                    self.asc_patch.reset_mock()
                    with self.assertRaises(SystemExit):
                        self.ensure(**{phase: record})
                    self.assertEqual(self.asc_patch.call_count, int(phase == "updated"))
                    self.asc_post.assert_not_called()

    def test_exact_draft_reuse_and_first_version_creation_remain_supported(self):
        self.find_app_store_version.return_value = self.updated
        self.assertEqual(RELEASE.ensure_app_store_version("token", "app", "2.0.0", "IOS", "AFTER_APPROVAL"), self.updated)
        self.asc_get.assert_not_called()
        self.asc_patch.assert_not_called()
        self.find_app_store_version.return_value = None
        self.asc_post.side_effect = None
        self.asc_post.return_value = {"data": self.updated}
        released = deepcopy(self.draft)
        released["attributes"]["appStoreState"] = "READY_FOR_DISTRIBUTION"
        for catalog in ([], [released]):
            with self.subTest(catalog=catalog):
                self.asc_post.reset_mock()
                self.assertEqual(self.ensure(catalog=catalog), self.updated)
                self.asc_post.assert_called_once()


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


class IOSPackagingVersionTests(unittest.TestCase):
    def setUp(self):
        self.trains = patch.object(RELEASE, "prerelease_versions", return_value=[])
        self.trains.start()
        self.addCleanup(self.trains.stop)

    def history(self, records, *, next_url=None):
        return {
            "data": [
                {"attributes": {"versionString": version, "appStoreState": state}}
                for version, state in records
            ],
            "links": {"next": next_url} if next_url else {},
        }

    def test_automatic_packaging_cli_reads_legacy_history_without_mutating_apple(self):
        self.trains.stop()
        next_url = "https://api.appstoreconnect.apple.com/v1/apps/app/appStoreVersions?cursor=2"
        responses = [
            {"data": [{"id": "app"}]},
            {"data": [{"attributes": {"version": "1.4.3", "platform": "IOS"}}]},
            self.history([("1.0", "READY_FOR_SALE")], next_url=next_url),
            self.history([("1.4.2", "DEVELOPER_REJECTED")]),
        ]
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            project = pathlib.Path(directory, "release.pbxproj")
            project.write_text(
                "CURRENT_PROJECT_VERSION = 69;\nMARKETING_VERSION = 1.4.1;\n"
            )
            with (
                patch.dict(os.environ, {"IOS_MARKETING_VERSION": ""}),
                patch.object(RELEASE, "mint_jwt", return_value="synthetic"),
                patch.object(RELEASE, "asc_get", side_effect=responses) as read,
                patch.object(
                    RELEASE,
                    "asc_post",
                    side_effect=AssertionError("unexpected Apple write"),
                ),
                patch.object(
                    RELEASE,
                    "asc_patch",
                    side_effect=AssertionError("unexpected Apple write"),
                ),
                redirect_stdout(output),
                redirect_stderr(io.StringIO()),
            ):
                result = RELEASE.main(
                    [
                        "--resolve-marketing-version",
                        "--testflight",
                        "--p8-path",
                        "/dev/null",
                        "--key-id",
                        "synthetic",
                        "--issuer-id",
                        "synthetic",
                        "--pbxproj",
                        str(project),
                    ]
                )
            self.assertEqual(result, 0)
            self.assertEqual(output.getvalue(), "1.4.3\n")
            self.assertEqual(read.call_count, 4)
            self.assertEqual(read.call_args_list[-1].args[0], next_url)

    def test_manual_prerelease_floor_is_paginated_and_applies_to_both_lanes(self):
        self.trains.stop()
        next_url = "https://api.appstoreconnect.apple.com/v1/preReleaseVersions?cursor=2"
        def response(url, token):
            if "/appStoreVersions?" in url:
                return self.history([("1.4.2", "DEVELOPER_REJECTED")])
            if "cursor=2" in url:
                return {"data": [{"attributes": {"version": "1.4.3", "platform": "IOS"}}]}
            self.assertIn("filter%5Bapp%5D=app", url)
            self.assertIn("filter%5Bplatform%5D=IOS", url)
            return {"data": [{"attributes": {"version": "1.0", "platform": "IOS"}}],
                    "links": {"next": next_url}}
        with patch.object(RELEASE, "asc_get", side_effect=response):
            for testflight in (True, False):
                self.assertEqual(RELEASE.resolve_packaging_version(
                    "token", "app", "1.4.1", "IOS", testflight=testflight), "1.4.3")
        for history in ([], [("1.4.2", "IN_REVIEW")]):
            with patch.object(RELEASE, "prerelease_versions", return_value=["1.4.3"]), \
                    patch.object(RELEASE, "asc_get", return_value=self.history(history)):
                self.assertEqual(RELEASE.resolve_packaging_version(
                    "token", "app", "1.4.1", "IOS", testflight=True), "1.4.3")
                if history:
                    with self.assertRaises(SystemExit) as deferred:
                        RELEASE.resolve_packaging_version(
                            "token", "app", "1.4.1", "IOS", defer_if_review=True)
                    self.assertEqual(deferred.exception.code, 75)
        for attrs in ({"version": "1.4-beta", "platform": "IOS"},
                      {"version": "1.4.3", "platform": "MAC_OS"}):
            with patch.object(RELEASE, "asc_get", return_value={"data": [{"attributes": attrs}]}):
                with self.assertRaises(SystemExit):
                    RELEASE.resolve_packaging_version("token", "app", "1.4.1", "IOS")
        with patch.object(RELEASE, "asc_get", return_value={"data": [], "links": {"next": next_url}}):
            with self.assertRaises(SystemExit):
                RELEASE.prerelease_versions("token", "app", "IOS")

    def test_history_orders_numerically_across_pages_and_ignores_older_alias_ties(self):
        responses = [
            self.history(
                [
                    ("1.9", "READY_FOR_SALE"),
                    ("1.4", "READY_FOR_SALE"),
                    ("1.4.0", "READY_FOR_SALE"),
                ],
                next_url="https://api.appstoreconnect.apple.com/next",
            ),
            self.history([("1.10", "READY_FOR_SALE")]),
        ]
        with patch.object(RELEASE, "asc_get", side_effect=responses):
            self.assertEqual(
                RELEASE.resolve_packaging_version("token", "app", "1.4.1", "IOS"),
                "1.10.1",
            )

    def test_released_short_history_advances_a_canonical_patch_and_keeps_source_floor(
        self,
    ):
        for version, source, expected in (
            ("1", "1.0.0", "1.0.1"),
            ("1.4", "1.0.0", "1.4.1"),
            ("01.04", "1.0.0", "1.4.1"),
            ("1.4", "2.0.0", "2.0.0"),
        ):
            with (
                self.subTest(version=version, source=source),
                patch.object(
                    RELEASE,
                    "asc_get",
                    return_value=self.history([(version, "READY_FOR_SALE")]),
                ),
            ):
                self.assertEqual(
                    RELEASE.resolve_packaging_version("token", "app", source, "IOS"),
                    expected,
                )

    def test_short_pending_history_keeps_review_and_production_deferral_guards(self):
        for state in (
            "IN_REVIEW",
            "PENDING_DEVELOPER_RELEASE",
            "PENDING_APPLE_RELEASE",
        ):
            with (
                self.subTest(state=state),
                patch.object(
                    RELEASE, "asc_get", return_value=self.history([("1.4", state)])
                ),
            ):
                with self.assertRaises(SystemExit):
                    RELEASE.resolve_packaging_version("token", "app", "1.4.0", "IOS")
                self.assertEqual(
                    RELEASE.resolve_packaging_version(
                        "token", "app", "1.4.0", "IOS", testflight=True
                    ),
                    "1.4.1",
                )
                with self.assertRaises(SystemExit) as deferred:
                    RELEASE.resolve_packaging_version(
                        "token", "app", "1.4.0", "IOS", defer_if_review=True
                    )
                self.assertEqual(deferred.exception.code, 75)

    def test_source_stays_strict_and_malformed_history_is_not_silently_ignored(self):
        for source in ("1", "1.4", "01.4.0", "1.4.0-beta", "1.4.0.1"):
            with self.subTest(source=source), patch.object(RELEASE, "asc_get") as read:
                with self.assertRaises(SystemExit):
                    RELEASE.resolve_packaging_version("token", "app", source, "IOS")
                read.assert_not_called()
        for version in (None, "", "1..0", "1.0-beta", "1.2.3.4", " 1.0"):
            with (
                self.subTest(version=version),
                patch.object(
                    RELEASE,
                    "asc_get",
                    return_value=self.history(
                        [
                            (version, "READY_FOR_SALE"),
                            ("1.4.2", "PREPARE_FOR_SUBMISSION"),
                        ]
                    ),
                ),
            ):
                with self.assertRaises(SystemExit):
                    RELEASE.resolve_packaging_version("token", "app", "1.4.1", "IOS")

    def test_equivalent_latest_records_fail_closed_in_either_order(self):
        records = [("1.4", "READY_FOR_SALE"), ("1.4.0", "PREPARE_FOR_SUBMISSION")]
        for candidates in (records, list(reversed(records)), [records[1], records[1]]):
            with (
                self.subTest(candidates=candidates),
                patch.object(RELEASE, "asc_get", return_value=self.history(candidates)),
            ):
                with self.assertRaises(SystemExit):
                    RELEASE.resolve_packaging_version("token", "app", "1.4.0", "IOS")

    def test_editable_short_train_requires_exact_identity_instead_of_assuming_aliases(
        self,
    ):
        for version, source in (("1", "1.0.0"), ("1.4", "1.4.0"), ("01.04", "1.4.0")):
            with (
                self.subTest(version=version),
                patch.object(
                    RELEASE,
                    "asc_get",
                    return_value=self.history([(version, "PREPARE_FOR_SUBMISSION")]),
                ),
            ):
                with self.assertRaises(SystemExit):
                    RELEASE.resolve_packaging_version("token", "app", source, "IOS")

    def test_automatic_packaging_reuses_editable_train_or_advances_released_patch(self):
        for state, expected in (("PREPARE_FOR_SUBMISSION", "1.4.3"), ("READY_FOR_DISTRIBUTION", "1.4.4")):
            with self.subTest(state=state), patch.object(RELEASE, "asc_get", return_value={
                "data": [{"attributes": {"versionString": "1.4.3", "appStoreState": state}}], "links": {}}):
                self.assertEqual(RELEASE.resolve_packaging_version("token", "app", "1.4.1", "IOS"), expected)
        for state in ("PENDING_DEVELOPER_RELEASE", "WAITING_FOR_REVIEW", "IN_REVIEW", "UNKNOWN"):
            with self.subTest(state=state), patch.object(RELEASE, "asc_get", return_value={
                "data": [{"attributes": {"versionString": "1.4.3", "appStoreState": state}}], "links": {}}):
                with self.assertRaises(SystemExit):
                    RELEASE.resolve_packaging_version("token", "app", "1.4.1", "IOS")
                if state != "UNKNOWN":
                    self.assertEqual(RELEASE.resolve_packaging_version("token", "app", "1.4.1", "IOS", testflight=True), "1.4.4")
                    with self.assertRaises(SystemExit) as deferred:
                        RELEASE.resolve_packaging_version("token", "app", "1.4.1", "IOS", defer_if_review=True)
                    self.assertEqual(deferred.exception.code, 75)

class AppStoreReleaseReadbackTests(unittest.TestCase):
    def test_public_submission_requires_review_contact_and_sign_in_without_logging_them(self):
        values = {field: "synthetic" for field in ("contactFirstName", "contactLastName", "contactPhone", "contactEmail", "demoAccountName", "demoAccountPassword")}
        values["demoAccountRequired"] = True
        with patch.object(RELEASE, "asc_get", return_value={"data": {"attributes": values}}):
            RELEASE.verify_reviewer_account("synthetic", "version")
            values["demoAccountPassword"] = ""
            with self.assertRaises(SystemExit):
                RELEASE.verify_reviewer_account("synthetic", "version")

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

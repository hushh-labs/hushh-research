#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Attach one VALID TestFlight build to internal and external beta groups.

This tool is deliberately limited to App Store Connect's TestFlight beta
resources. It never creates an App Store version, an App Store submission, or
a public release. External availability is reported as pending until Apple
approves beta review; a group assignment is not treated as an approval.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, NoReturn

from wait_for_testflight_build import (
    ASC_API_ROOT,
    build_upload_url,
    mint_jwt,
    resolve_app_id,
)


RESOURCE_ID = re.compile(r"^[A-Za-z0-9-]{2,128}$")
EXTERNAL_ACTIVE_STATES = {"APPROVED", "ACCEPTED"}
EXTERNAL_PENDING_STATES = {
    "WAITING_FOR_REVIEW",
    "IN_REVIEW",
    "READY_FOR_REVIEW",
    "PENDING",
    "SUBMITTED",
}
EXTERNAL_REJECTED_STATES = {"REJECTED", "EXPIRED", "INVALID"}


class DistributionError(RuntimeError):
    """A fail-closed TestFlight beta distribution error."""


@dataclass(frozen=True)
class BetaReviewContact:
    first_name: str
    last_name: str
    email: str
    phone: str

    @classmethod
    def parse(cls, raw: str) -> "BetaReviewContact":
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise DistributionError("beta review contact must be valid JSON") from exc
        if not isinstance(payload, dict):
            raise DistributionError("beta review contact must be a JSON object")
        fields = {
            "first_name": payload.get("first_name"),
            "last_name": payload.get("last_name"),
            "email": payload.get("email"),
            "phone": payload.get("phone"),
        }
        normalized = {
            key: value.strip() if isinstance(value, str) else ""
            for key, value in fields.items()
        }
        if not all(normalized.values()) or "@" not in normalized["email"]:
            raise DistributionError(
                "beta review contact needs first_name, last_name, email, and phone"
            )
        return cls(**normalized)


@dataclass(frozen=True)
class DistributionConfiguration:
    internal_group_id: str
    external_group_id: str
    review_contact: BetaReviewContact
    review_notes: str

    @classmethod
    def from_values(
        cls,
        *,
        internal_group_id: str,
        external_group_id: str,
        review_contact_json: str,
        review_notes: str,
    ) -> "DistributionConfiguration":
        internal = validate_resource_id("internal TestFlight group", internal_group_id)
        external = validate_resource_id("external TestFlight group", external_group_id)
        if internal == external:
            raise DistributionError("internal and external TestFlight groups must differ")
        notes = review_notes.strip()
        if not notes:
            raise DistributionError("beta review notes are required for external TestFlight")
        return cls(
            internal_group_id=internal,
            external_group_id=external,
            review_contact=BetaReviewContact.parse(review_contact_json),
            review_notes=notes,
        )


def validate_resource_id(label: str, value: str) -> str:
    normalized = value.strip()
    if not RESOURCE_ID.fullmatch(normalized):
        raise DistributionError(f"{label} id is missing or malformed")
    return normalized


class AppStoreConnectClient:
    """Small JSON client whose request seam keeps release behavior testable."""

    def __init__(
        self,
        token: str,
        request: Callable[[str, str, dict[str, Any] | None], dict[str, Any]] | None = None,
    ) -> None:
        self.token = token
        self._request = request or self._urllib_request

    def get(self, path_or_url: str) -> dict[str, Any]:
        return self._request("GET", self.absolute_url(path_or_url), None)

    def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", self.absolute_url(path), payload)

    def patch(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request("PATCH", self.absolute_url(path), payload)

    @staticmethod
    def absolute_url(path_or_url: str) -> str:
        return path_or_url if path_or_url.startswith("https://") else f"{ASC_API_ROOT}{path_or_url}"

    def _urllib_request(
        self, method: str, url: str, payload: dict[str, Any] | None
    ) -> dict[str, Any]:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            url,
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/json",
                **({"Content-Type": "application/json"} if body is not None else {}),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            # Apple responses can contain reviewer-facing information. Status is
            # enough for CI and avoids echoing request data or error payloads.
            raise DistributionError(f"App Store Connect {method} failed with HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise DistributionError(f"App Store Connect {method} request failed") from exc
        if not raw:
            return {}
        try:
            result = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DistributionError(f"App Store Connect {method} returned invalid JSON") from exc
        if not isinstance(result, dict):
            raise DistributionError(f"App Store Connect {method} returned an invalid payload")
        return result


def require_resource(payload: dict[str, Any], resource_type: str, label: str) -> dict[str, Any]:
    resource = payload.get("data")
    if not isinstance(resource, dict) or resource.get("type") != resource_type:
        raise DistributionError(f"App Store Connect did not return {label}")
    if not isinstance(resource.get("id"), str) or not resource["id"].strip():
        raise DistributionError(f"App Store Connect returned {label} without an id")
    return resource


def resolve_valid_build_id(
    client: AppStoreConnectClient,
    app_id: str,
    marketing_version: str,
    build_number: str,
) -> str:
    # Resolve through buildUploads, the same endpoint used by the processing
    # gate. App Store Connect rejects the preReleaseVersion.version filter on
    # the top-level /v1/builds endpoint for some apps, even though the upload
    # resource includes the definitive build and its processing state.
    payload = client.get(
        build_upload_url(app_id, marketing_version, build_number, "IOS")
    )
    uploads = payload.get("data")
    if not isinstance(uploads, list):
        raise DistributionError("App Store Connect did not return build uploads")
    matches = [
        upload
        for upload in uploads
        if isinstance(upload, dict)
        and upload.get("type") == "buildUploads"
    ]
    if len(matches) > 1:
        version_matches = [
            upload
            for upload in matches
            if str((upload.get("attributes") or {}).get("cfBundleShortVersionString"))
            == marketing_version
            and str((upload.get("attributes") or {}).get("cfBundleVersion"))
            == str(build_number)
        ]
        matches = version_matches
    if len(matches) != 1:
        raise DistributionError("exact TestFlight build upload was not found")

    upload = matches[0]
    build_ref = ((upload.get("relationships") or {}).get("build") or {}).get("data")
    included_builds = [
        resource
        for resource in payload.get("included") or []
        if isinstance(resource, dict)
        and resource.get("type") == "builds"
        and (
            not isinstance(build_ref, dict)
            or resource.get("id") == build_ref.get("id")
        )
    ]
    if len(included_builds) != 1:
        raise DistributionError("App Store Connect did not return the uploaded build")
    build = included_builds[0]
    if not isinstance(build.get("id"), str) or not build["id"].strip():
        raise DistributionError("App Store Connect returned the build without an id")
    if (build.get("attributes") or {}).get("processingState") != "VALID":
        raise DistributionError("TestFlight build is not VALID")
    return validate_resource_id("TestFlight build", build["id"])


def require_group_type(
    client: AppStoreConnectClient, group_id: str, *, is_internal: bool
) -> None:
    payload = client.get(
        f"/v1/betaGroups/{group_id}?fields[betaGroups]=name,isInternalGroup"
    )
    group = require_resource(payload, "betaGroups", "TestFlight group")
    actual = (group.get("attributes") or {}).get("isInternalGroup")
    if actual is not is_internal:
        expected = "internal" if is_internal else "external"
        raise DistributionError(f"configured {expected} TestFlight group has the wrong group type")


def relationship_contains_build(
    client: AppStoreConnectClient, group_id: str, build_id: str
) -> bool:
    next_url: str | None = (
        f"/v1/betaGroups/{group_id}/relationships/builds?limit=200"
    )
    visited: set[str] = set()
    while next_url:
        absolute = client.absolute_url(next_url)
        if absolute in visited:
            raise DistributionError("App Store Connect returned a cyclic TestFlight group page")
        visited.add(absolute)
        payload = client.get(next_url)
        rows = payload.get("data")
        if not isinstance(rows, list):
            raise DistributionError("App Store Connect returned invalid group-build relationships")
        if any(
            isinstance(row, dict)
            and row.get("type") == "builds"
            and row.get("id") == build_id
            for row in rows
        ):
            return True
        candidate = ((payload.get("links") or {}).get("next"))
        next_url = candidate if isinstance(candidate, str) and candidate else None
    return False


def attach_build_once(client: AppStoreConnectClient, group_id: str, build_id: str) -> str:
    if relationship_contains_build(client, group_id, build_id):
        return "already_assigned"
    client.post(
        f"/v1/betaGroups/{group_id}/relationships/builds",
        {"data": [{"type": "builds", "id": build_id}]},
    )
    # A successful relationship POST can have an empty body. The follow-up is
    # the idempotency proof and catches an API success that did not assign it.
    if not relationship_contains_build(client, group_id, build_id):
        raise DistributionError("TestFlight group assignment was not observable after success")
    return "assigned"


def beta_review_attributes(contact: BetaReviewContact, notes: str) -> dict[str, Any]:
    return {
        "contactFirstName": contact.first_name,
        "contactLastName": contact.last_name,
        "contactEmail": contact.email,
        "contactPhone": contact.phone,
        "notes": notes,
    }


def upsert_beta_review_detail(
    client: AppStoreConnectClient,
    app_id: str,
    contact: BetaReviewContact,
    notes: str,
) -> None:
    payload = client.get(f"/v1/apps/{app_id}/betaAppReviewDetail")
    resource = payload.get("data")
    attributes = beta_review_attributes(contact, notes)
    if isinstance(resource, dict) and resource.get("type") == "betaAppReviewDetails":
        detail_id = validate_resource_id("beta review detail", str(resource.get("id") or ""))
        client.patch(
            f"/v1/betaAppReviewDetails/{detail_id}",
            {"data": {"type": "betaAppReviewDetails", "id": detail_id, "attributes": attributes}},
        )
        return
    if resource not in (None, {}):
        raise DistributionError("App Store Connect returned invalid beta review detail")
    client.post(
        "/v1/betaAppReviewDetails",
        {
            "data": {
                "type": "betaAppReviewDetails",
                "attributes": attributes,
                "relationships": {"app": {"data": {"type": "apps", "id": app_id}}},
            }
        },
    )


def upsert_beta_build_localization(
    client: AppStoreConnectClient, build_id: str, notes: str
) -> None:
    query = urllib.parse.urlencode({"filter[locale]": "en-US", "limit": "2"})
    payload = client.get(f"/v1/builds/{build_id}/betaBuildLocalizations?{query}")
    records = payload.get("data")
    if not isinstance(records, list):
        raise DistributionError("App Store Connect returned invalid beta build localizations")
    matches = [
        record
        for record in records
        if isinstance(record, dict)
        and record.get("type") == "betaBuildLocalizations"
        and (record.get("attributes") or {}).get("locale") == "en-US"
    ]
    if len(matches) > 1:
        raise DistributionError("App Store Connect returned duplicate en-US beta localizations")
    attributes = {"locale": "en-US", "whatsNew": notes}
    if matches:
        localization_id = validate_resource_id(
            "beta build localization", str(matches[0].get("id") or "")
        )
        client.patch(
            f"/v1/betaBuildLocalizations/{localization_id}",
            {
                "data": {
                    "type": "betaBuildLocalizations",
                    "id": localization_id,
                    "attributes": attributes,
                }
            },
        )
        return
    client.post(
        "/v1/betaBuildLocalizations",
        {
            "data": {
                "type": "betaBuildLocalizations",
                "attributes": attributes,
                "relationships": {"build": {"data": {"type": "builds", "id": build_id}}},
            }
        },
    )


def external_beta_status(client: AppStoreConnectClient, build_id: str) -> tuple[str, str]:
    payload = client.get(f"/v1/builds/{build_id}/betaAppReviewSubmission")
    resource = payload.get("data")
    if resource is None:
        created = client.post(
            "/v1/betaAppReviewSubmissions",
            {"data": {"type": "betaAppReviewSubmissions", "relationships": {"build": {"data": {"type": "builds", "id": build_id}}}}},
        )
        resource = require_resource(created, "betaAppReviewSubmissions", "beta review submission")
    elif not isinstance(resource, dict) or resource.get("type") != "betaAppReviewSubmissions":
        raise DistributionError("App Store Connect returned invalid beta review submission")

    state = str((resource.get("attributes") or {}).get("betaReviewState") or "").upper()
    if state in EXTERNAL_ACTIVE_STATES:
        return "active", state
    if state in EXTERNAL_REJECTED_STATES:
        raise DistributionError(f"Apple rejected external TestFlight beta review ({state})")
    # Unknown states remain deliberately conservative. Apple can add a state;
    # it must never be reported as external availability without confirmation.
    if not state or state not in EXTERNAL_PENDING_STATES:
        state = state or "SUBMITTED"
    return "pending_apple_beta_review", state


def distribute_valid_build(
    *,
    client: AppStoreConnectClient,
    app_id: str,
    marketing_version: str,
    build_number: str,
    configuration: DistributionConfiguration,
) -> dict[str, str]:
    build_id = resolve_valid_build_id(client, app_id, marketing_version, build_number)
    require_group_type(client, configuration.internal_group_id, is_internal=True)
    require_group_type(client, configuration.external_group_id, is_internal=False)
    internal_assignment = attach_build_once(client, configuration.internal_group_id, build_id)
    external_assignment = attach_build_once(client, configuration.external_group_id, build_id)
    upsert_beta_review_detail(
        client, app_id, configuration.review_contact, configuration.review_notes
    )
    upsert_beta_build_localization(client, build_id, configuration.review_notes)
    external, review_state = external_beta_status(client, build_id)
    return {
        "build_id": build_id,
        "internal": "active",
        "internal_assignment": internal_assignment,
        "external": external,
        "external_assignment": external_assignment,
        "external_beta_review_state": review_state,
    }


def die(message: str) -> NoReturn:
    print(f"distribute-testflight-build: {message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--p8-path", default=os.environ.get("APPSTORE_CONNECT_API_KEY_PATH"))
    parser.add_argument("--key-id", default=os.environ.get("ASC_KEY_ID"))
    parser.add_argument("--issuer-id", default=os.environ.get("ASC_ISSUER_ID"))
    parser.add_argument("--bundle-id", default=os.environ.get("IOS_BUNDLE_ID", "com.hushh.app"))
    parser.add_argument("--marketing-version", required=True)
    parser.add_argument("--build-number", required=True)
    parser.add_argument(
        "--internal-group-id", default=os.environ.get("APPSTORE_CONNECT_INTERNAL_TESTFLIGHT_GROUP_ID")
    )
    parser.add_argument(
        "--external-group-id", default=os.environ.get("APPSTORE_CONNECT_EXTERNAL_TESTFLIGHT_GROUP_ID")
    )
    parser.add_argument(
        "--beta-review-contact-json", default=os.environ.get("APPSTORE_CONNECT_BETA_REVIEW_CONTACT_JSON")
    )
    parser.add_argument(
        "--beta-review-notes", default=os.environ.get("APPSTORE_CONNECT_BETA_REVIEW_NOTES")
    )
    parser.add_argument(
        "--beta-review-contact-file",
        help="Read beta-review contact JSON from a protected runner-local file.",
    )
    parser.add_argument(
        "--beta-review-notes-file",
        help="Read beta-review notes from a protected runner-local file.",
    )
    parser.add_argument("--output-json")
    return parser.parse_args(argv)


def read_optional_file(path: str | None, label: str) -> str | None:
    if not path:
        return None
    try:
        return open(path, "r", encoding="utf-8").read()
    except (OSError, UnicodeDecodeError) as exc:
        raise DistributionError(f"cannot read {label} file") from exc


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        review_contact_json = read_optional_file(
            args.beta_review_contact_file, "beta review contact"
        ) or args.beta_review_contact_json
        review_notes = read_optional_file(
            args.beta_review_notes_file, "beta review notes"
        ) or args.beta_review_notes
    except DistributionError as exc:
        die(str(exc))
    missing = [
        name
        for name, value in (
            ("--p8-path", args.p8_path),
            ("--key-id", args.key_id),
            ("--issuer-id", args.issuer_id),
            ("--internal-group-id", args.internal_group_id),
            ("--external-group-id", args.external_group_id),
            ("--beta-review-contact-json", review_contact_json),
            ("--beta-review-notes", review_notes),
        )
        if not value
    ]
    if missing:
        die(f"missing required argument(s): {', '.join(missing)}")
    try:
        configuration = DistributionConfiguration.from_values(
            internal_group_id=args.internal_group_id,
            external_group_id=args.external_group_id,
            review_contact_json=review_contact_json,
            review_notes=review_notes,
        )
        token = mint_jwt(args.p8_path, args.key_id, args.issuer_id)
        client = AppStoreConnectClient(token)
        app_id = resolve_app_id(token, args.bundle_id)
        result = distribute_valid_build(
            client=client,
            app_id=app_id,
            marketing_version=args.marketing_version,
            build_number=str(args.build_number),
            configuration=configuration,
        )
    except DistributionError as exc:
        die(str(exc))

    rendered = json.dumps(result, sort_keys=True)
    print(rendered, flush=True)
    if args.output_json:
        with open(args.output_json, "w", encoding="utf-8") as handle:
            handle.write(rendered + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

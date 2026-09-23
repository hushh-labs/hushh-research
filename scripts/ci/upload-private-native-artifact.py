#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

"""Preserve one signed UAT native build in a policy-checked private bucket.

The GitHub Actions artifact store is visible to readers of the public repo.
This helper never uploads an IPA/AAB there and emits only a non-secret receipt.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any

PROJECT = "hushh-native-uat"
PROJECT_NUMBER = "189326466264"
BUCKET = "hushh-native-uat-artifacts"
DENY_POLICY_ID = "native-uat-artifact-read"
DENY_ATTACHMENT = f"cloudresourcemanager.googleapis.com/projects/{PROJECT_NUMBER}"
DENY_POLICY_FILE = (
    Path(__file__).resolve().parents[2]
    / "deploy/storage/native-artifact-deny-policy.json"
)
EXPECTED_DENY_RULES = {
    (
        frozenset({"principalSet://goog/public:all"}),
        frozenset(
            {
                "principal://iam.googleapis.com/projects/-/serviceAccounts/github-actions-uat-deployer@hushh-pda-uat.iam.gserviceaccount.com",
                "principal://iam.googleapis.com/projects/-/serviceAccounts/claude-code-gcp-operator@hussh-developer-platform.iam.gserviceaccount.com",
                f"principalSet://cloudresourcemanager.googleapis.com/projects/{PROJECT_NUMBER}/type/ServiceAgent",
            }
        ),
        frozenset(
            {
                "storage.googleapis.com/objects.get",
                "storage.googleapis.com/objects.list",
            }
        ),
    ),
    (
        frozenset({"principalSet://goog/group/developers@hushh.ai"}),
        frozenset(
            {
                "principal://iam.googleapis.com/projects/-/serviceAccounts/claude-code-gcp-operator@hussh-developer-platform.iam.gserviceaccount.com"
            }
        ),
        frozenset({"storage.googleapis.com/objects.*"}),
    ),
}
SHA_RE = re.compile(r"[0-9a-f]{40}\Z")
PLATFORMS = {
    "ios-testflight": (".ipa", "app.ipa"),
    "android-playstore": (".aab", "app.aab"),
}


class ArtifactPolicyError(ValueError):
    """The artifact or destination did not satisfy the release policy."""


def _run_gcloud(*arguments: str) -> str:
    command = ["gcloud", "--quiet", *arguments]
    environment = os.environ.copy()
    # Composite uploads omit the provider MD5 needed for post-upload proof.
    environment["CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED"] = "false"
    try:
        completed = subprocess.run(
            command,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
        )
    except subprocess.CalledProcessError as exc:
        # gcloud output can contain account identifiers and request details.
        raise ArtifactPolicyError(f"Google Cloud {arguments[0]} check failed") from exc
    return completed.stdout


def _gcloud_json(*arguments: str) -> dict[str, Any]:
    try:
        data = json.loads(_run_gcloud(*arguments, "--format=json"))
    except json.JSONDecodeError as exc:
        raise ArtifactPolicyError("Cloud Storage returned invalid JSON") from exc
    if not isinstance(data, dict):
        raise ArtifactPolicyError("Cloud Storage returned an invalid object")
    return data


def validate_bucket(description: dict[str, Any], iam_policy: dict[str, Any]) -> None:
    if description.get("name") != BUCKET:
        raise ArtifactPolicyError("unexpected artifact bucket")
    if description.get("public_access_prevention") != "enforced":
        raise ArtifactPolicyError("bucket public access prevention is not enforced")
    if description.get("uniform_bucket_level_access") is not True:
        raise ArtifactPolicyError("bucket uniform access is not enabled")

    lifecycle = description.get("lifecycle_config", {})
    rules = lifecycle.get("rule", []) if isinstance(lifecycle, dict) else []
    if not any(
        isinstance(rule, dict)
        and rule.get("action") == {"type": "Delete"}
        and rule.get("condition") == {"age": 14}
        for rule in rules
    ):
        raise ArtifactPolicyError("bucket lacks the exact 14-day deletion rule")

    _validate_service_account_only_iam(iam_policy, "bucket")


def _validate_service_account_only_iam(policy: dict[str, Any], scope: str) -> None:
    bindings = policy.get("bindings")
    if not isinstance(bindings, list):
        raise ArtifactPolicyError(f"{scope} IAM policy is missing bindings")
    for binding in bindings:
        if not isinstance(binding, dict) or not isinstance(
            binding.get("members"), list
        ):
            raise ArtifactPolicyError(f"{scope} IAM policy contains an invalid binding")
        for member in binding["members"]:
            if not isinstance(member, str) or not re.fullmatch(
                r"serviceAccount:[^@\s]+@[^@\s]+\.gserviceaccount\.com", member
            ):
                # No human/group/domain/project-role alias is approved for this
                # dedicated artifact project or bucket. A future owner exception
                # must be a reviewed code change, never a runtime flag.
                raise ArtifactPolicyError(
                    f"{scope} IAM grants access beyond service accounts"
                )


def validate_project_iam(policy: dict[str, Any]) -> None:
    _validate_service_account_only_iam(policy, "artifact project")


def validate_bucket_project(raw_description: dict[str, Any]) -> None:
    if (
        raw_description.get("name") != BUCKET
        or str(raw_description.get("projectNumber")) != PROJECT_NUMBER
    ):
        raise ArtifactPolicyError("artifact bucket is outside the dedicated project")


def validate_deny_policy(live: dict[str, Any], expected: dict[str, Any]) -> None:
    policy_name = live.get("name", "")
    if (
        not isinstance(policy_name, str)
        or not policy_name.endswith(f"/denypolicies/{DENY_POLICY_ID}")
        or f"projects%2F{PROJECT_NUMBER}" not in policy_name
    ):
        raise ArtifactPolicyError(
            "artifact deny policy is attached to the wrong project"
        )
    actual_rules = live.get("rules")
    expected_rules = expected.get("rules")
    if not isinstance(actual_rules, list) or not isinstance(expected_rules, list):
        raise ArtifactPolicyError("artifact deny policy has no rules")
    if len(actual_rules) != len(expected_rules):
        raise ArtifactPolicyError("artifact deny policy rule count drifted")

    def normalize(
        rule: dict[str, Any],
    ) -> tuple[frozenset[str], frozenset[str], frozenset[str]]:
        if not isinstance(rule, dict) or rule.get("denialCondition"):
            raise ArtifactPolicyError("artifact deny rule is conditional or invalid")
        denial = rule.get("denyRule")
        if not isinstance(denial, dict) or denial.get("exceptionPermissions"):
            raise ArtifactPolicyError("artifact deny rule exempts permissions")
        fields = ("deniedPrincipals", "exceptionPrincipals", "deniedPermissions")
        values = []
        for field in fields:
            principals = denial.get(
                field, [] if field == "exceptionPrincipals" else None
            )
            if not isinstance(principals, list) or not all(
                isinstance(principal, str) for principal in principals
            ):
                raise ArtifactPolicyError("artifact deny rule has invalid principals")
            values.append(frozenset(principals))
        return tuple(values)

    source_rules = {normalize(rule) for rule in expected_rules}
    if source_rules != EXPECTED_DENY_RULES:
        raise ArtifactPolicyError("reviewed artifact deny source has drifted")
    if {normalize(rule) for rule in actual_rules} != source_rules:
        raise ArtifactPolicyError(
            "artifact deny policy differs from the reviewed source"
        )


def validate_destination() -> None:
    validate_project_iam(_gcloud_json("projects", "get-iam-policy", PROJECT))
    validate_bucket(
        _gcloud_json("storage", "buckets", "describe", f"gs://{BUCKET}"),
        _gcloud_json("storage", "buckets", "get-iam-policy", f"gs://{BUCKET}"),
    )
    validate_bucket_project(
        _gcloud_json("storage", "buckets", "describe", f"gs://{BUCKET}", "--raw")
    )
    try:
        expected_deny = json.loads(DENY_POLICY_FILE.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ArtifactPolicyError(
            "reviewed artifact deny policy is unavailable"
        ) from exc
    validate_deny_policy(
        _gcloud_json(
            "iam",
            "policies",
            "get",
            DENY_POLICY_ID,
            f"--attachment-point={DENY_ATTACHMENT}",
            "--kind=denypolicies",
        ),
        expected_deny,
    )


def validate_binary(path: Path, platform: str) -> None:
    expected_ext = PLATFORMS[platform][0]
    if path.is_symlink() or not path.is_file() or path.suffix != expected_ext:
        raise ArtifactPolicyError("expected one regular signed native build file")
    if path.stat().st_size <= 0 or path.stat().st_size > 4 * 1024**3:
        raise ArtifactPolicyError("native build size is outside the allowed range")
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            forbidden = any(
                (basename := name.rsplit("/", 1)[-1].lower()).startswith(".env")
                or basename.endswith((".p8", ".p12", ".jks", ".key"))
                or "service-account" in basename
                for name in names
            )
            if forbidden:
                raise ArtifactPolicyError("native build contains a protected file")
            if platform == "ios-testflight":
                valid = any(
                    name.startswith("Payload/") and name.endswith(".app/Info.plist")
                    for name in names
                )
            else:
                valid = (
                    "BundleConfig.pb" in names
                    and "base/manifest/AndroidManifest.xml" in names
                )
    except (OSError, zipfile.BadZipFile) as exc:
        raise ArtifactPolicyError("native build is not a readable archive") from exc
    if not valid:
        raise ArtifactPolicyError(
            "native build archive has the wrong platform structure"
        )


def _digests(path: Path) -> tuple[str, str]:
    sha256 = hashlib.sha256()
    md5 = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as build:
        for chunk in iter(lambda: build.read(1024 * 1024), b""):
            sha256.update(chunk)
            md5.update(chunk)
    return sha256.hexdigest(), base64.b64encode(md5.digest()).decode("ascii")


def object_name(sha: str, run_id: str, attempt: str, platform: str) -> str:
    if not SHA_RE.fullmatch(sha):
        raise ArtifactPolicyError("source SHA must be a full lowercase commit hash")
    if not re.fullmatch(r"[0-9]+", run_id) or int(run_id) < 1:
        raise ArtifactPolicyError("invalid GitHub run ID")
    if not re.fullmatch(r"[0-9]+", attempt) or int(attempt) < 1:
        raise ArtifactPolicyError("invalid GitHub run attempt")
    if platform not in PLATFORMS:
        raise ArtifactPolicyError("unsupported UAT native artifact platform")
    return f"native/{sha}/run-{run_id}-attempt-{attempt}/{platform}/{PLATFORMS[platform][1]}"


def validate_uploaded_object(
    metadata: dict[str, Any],
    *,
    name: str,
    size: int,
    sha256: str,
    source_sha: str,
    md5_base64: str,
) -> int:
    if metadata.get("name") != name or metadata.get("bucket") != BUCKET:
        raise ArtifactPolicyError(
            "uploaded object identity differs from requested object"
        )
    try:
        generation = int(metadata.get("generation", 0))
        remote_size = int(metadata.get("size", -1))
    except (TypeError, ValueError) as exc:
        raise ArtifactPolicyError("uploaded object metadata is invalid") from exc
    if generation < 1 or remote_size != size:
        raise ArtifactPolicyError("uploaded object generation or size mismatch")
    if metadata.get("md5_hash") != md5_base64:
        raise ArtifactPolicyError("uploaded object MD5 mismatch")
    # `gcloud storage objects describe --format=json` renders Cloud Storage
    # custom metadata as `custom_fields`, not the raw JSON API's `metadata`.
    # Require the CLI's exact shape so a missing digest cannot be mistaken for
    # a valid private-artifact receipt.
    custom_fields = metadata.get("custom_fields")
    if not isinstance(custom_fields, dict) or custom_fields.get("sha256") != sha256:
        raise ArtifactPolicyError("uploaded object SHA-256 metadata mismatch")
    if custom_fields.get("source_sha") != source_sha:
        raise ArtifactPolicyError("uploaded object source SHA metadata mismatch")
    return generation


def upload(
    path: Path, sha: str, run_id: str, attempt: str, platform: str
) -> dict[str, Any]:
    name = object_name(sha, run_id, attempt, platform)
    validate_binary(path, platform)
    validate_destination()
    digest, md5_base64 = _digests(path)
    destination = f"gs://{BUCKET}/{name}"
    _run_gcloud(
        "storage",
        "cp",
        str(path),
        destination,
        "--if-generation-match=0",
        f"--content-md5={md5_base64}",
        "--content-type=application/octet-stream",
        "--cache-control=no-store",
        f"--custom-metadata=sha256={digest},source_sha={sha}",
    )
    generation = validate_uploaded_object(
        _gcloud_json("storage", "objects", "describe", destination),
        name=name,
        size=path.stat().st_size,
        sha256=digest,
        source_sha=sha,
        md5_base64=md5_base64,
    )
    validate_destination()
    return {
        "source_sha": sha,
        "platform": platform,
        "sha256": digest,
        "generation": generation,
        "size_bytes": path.stat().st_size,
        "live_retention_days": 14,
        "private_object": destination,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-attempt", required=True)
    parser.add_argument("--platform", choices=sorted(PLATFORMS), required=True)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    try:
        receipt = upload(
            args.file, args.source_sha, args.run_id, args.run_attempt, args.platform
        )
        with os.fdopen(
            os.open(args.receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
        ) as output:
            json.dump(receipt, output, sort_keys=True)
            output.write("\n")
    except (ArtifactPolicyError, OSError) as exc:
        print(f"Private native artifact preservation failed: {exc}", file=sys.stderr)
        return 1
    print(
        f"Private {receipt['platform']} artifact verified for {receipt['source_sha']} "
        f"at generation {receipt['generation']}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Attest the isolated UAT V1 worker revision and its immutable image."""

from __future__ import annotations

import json
import os
import sys

from verify_worker_revision import verify_revision


def verify_v1_revision(
    revision: dict,
    *,
    sha: str,
    image: str,
    scanner_index: str,
    scanner_amd64: str,
    drain_enabled: str = "true",
    semantic_model_provider: str | None = None,
    managed_text_provider: str | None = None,
) -> None:
    verify_revision(
        revision,
        deploy_sha=sha,
        app_image=image,
        scanner_index_digest=scanner_index,
        scanner_amd64_digest=scanner_amd64,
        drain_enabled=drain_enabled,
        semantic_model_provider=semantic_model_provider,
        managed_text_provider=managed_text_provider,
    )
    if revision["spec"].get("serviceAccountName") != (
        "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com"
    ):
        raise ValueError("V1 worker runtime identity mismatch")
    worker = next(
        item
        for item in revision["spec"]["containers"]
        if item["name"] == "drive-worker"
    )
    values: dict[str, list[str]] = {}
    for item in worker.get("env", []):
        values.setdefault(item.get("name"), []).append(item.get("value"))
    if values.get("DRIVE_WORKER_V1_ONLY") != ["true"] or values.get(
        "DRIVE_WORKER_MODE"
    ) != ["true"]:
        raise ValueError("V1 worker isolation flags are missing")
    if values.get("ENVIRONMENT") != ["uat"]:
        raise ValueError("V1 worker environment is not UAT")


def main() -> int:
    try:
        verify_v1_revision(
            json.load(sys.stdin),
            sha=os.environ["EXPECTED_SHA"],
            image=os.environ["EXPECTED_APP_IMAGE"],
            scanner_index=os.environ["EXPECTED_SCANNER_INDEX_DIGEST"],
            scanner_amd64=os.environ["EXPECTED_SCANNER_AMD64_DIGEST"],
            drain_enabled=os.environ.get("EXPECTED_DRAIN_ENABLED", "true"),
            semantic_model_provider=os.environ.get("EXPECTED_SEMANTIC_MODEL_PROVIDER"),
            managed_text_provider=os.environ.get("EXPECTED_MANAGED_TEXT_PROVIDER"),
        )
    except (
        KeyError,
        StopIteration,
        TypeError,
        ValueError,
        json.JSONDecodeError,
    ) as exc:
        print(f"V1 worker revision provenance failed: {exc}", file=sys.stderr)
        return 1
    print("V1 worker revision, isolation flags and image digests verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

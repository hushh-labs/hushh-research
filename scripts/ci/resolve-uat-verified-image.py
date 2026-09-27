#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Resolve the backend image digest UAT verified for one exact SHA.

Production promotes the backend image UAT tested instead of rebuilding it. The
source digest must come from UAT's own release evidence, never from a mutable
tag. The deploy lane supplies two independent pieces of that evidence:

1. a ``deployed/uat/<sha8>-<time>`` git tag, which deploy-uat.yml writes only
   after a release classified healthy, peeled to exactly the SHA, whose
   annotation names the backend revision that was serving; and
2. that revision's Cloud Run description, read from the UAT project.

This script checks that the revision in (2) is the one named in (1), carries
the same SHA in both its ``deploy-sha`` label and its ``HUSHH_DEPLOY_SHA`` env,
was deployed by the UAT lane, and runs an immutable ``@sha256`` image in the
UAT backend repository. Any mismatch fails closed. On success it prints the
image reference to stdout and nothing else.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
DIGEST_PATTERN = r"sha256:[0-9a-f]{64}"


class VerificationError(ValueError):
    """The UAT evidence does not prove this image was verified for this SHA."""


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def parse_release_tag_backend_revision(annotation: str) -> str:
    """Return the backend revision a UAT last-known-good tag recorded."""
    revisions = [
        line.split(":", 1)[1].strip()
        for line in annotation.splitlines()
        if line.startswith("backend_revision:")
    ]
    if len(revisions) != 1 or not revisions[0]:
        raise VerificationError("UAT release tag does not record exactly one backend revision")
    return revisions[0]


def resolve_verified_image(
    revision: dict[str, Any],
    *,
    sha: str,
    expected_revision: str,
    expected_repository: str,
) -> str:
    if not SHA_PATTERN.fullmatch(sha):
        raise VerificationError("Deployment SHA must be a full 40-character lowercase SHA")
    metadata = _mapping(revision.get("metadata"))
    labels = _mapping(metadata.get("labels"))
    containers = _mapping(revision.get("spec")).get("containers")
    if not isinstance(containers, list) or len(containers) != 1:
        raise VerificationError("UAT backend revision must run exactly one container")
    container = _mapping(containers[0])
    env = {
        str(item.get("name") or ""): str(item.get("value") or "")
        for item in (container.get("env") or [])
        if isinstance(item, dict) and "value" in item
    }
    image = str(container.get("image") or "")
    image_pattern = re.compile(re.escape(expected_repository) + "@" + DIGEST_PATTERN)

    checks = {
        "revision matches the release tag": metadata.get("name") == expected_revision,
        "deploy-sha label matches": labels.get("deploy-sha") == sha,
        "HUSHH_DEPLOY_SHA env matches": env.get("HUSHH_DEPLOY_SHA") == sha,
        "deployed to uat": labels.get("deploy-env") == "uat"
        and env.get("HUSHH_DEPLOY_ENV") == "uat",
        "deployed by deploy-uat": labels.get("deploy-source") == "deploy-uat"
        and env.get("HUSHH_DEPLOY_SOURCE") == "deploy-uat",
        "immutable image in the UAT backend repository": bool(image_pattern.fullmatch(image)),
    }
    failed = [name for name, passed in checks.items() if not passed]
    if failed:
        raise VerificationError("UAT revision evidence mismatch: " + "; ".join(failed))
    return image


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--revision-json", type=Path, required=True)
    parser.add_argument("--release-tag-annotation", type=Path, required=True)
    parser.add_argument("--expected-repository", required=True)
    parser.add_argument("--json-output", type=Path, required=True)
    args = parser.parse_args()
    try:
        expected_revision = parse_release_tag_backend_revision(
            args.release_tag_annotation.read_text(encoding="utf-8")
        )
        revision = json.loads(args.revision_json.read_text(encoding="utf-8"))
        if not isinstance(revision, dict):
            raise VerificationError("UAT revision description must be a JSON object")
        image = resolve_verified_image(
            revision,
            sha=args.sha,
            expected_revision=expected_revision,
            expected_repository=args.expected_repository,
        )
    except (OSError, json.JSONDecodeError, VerificationError) as exc:
        print(f"Cannot use this UAT release as the promotion source: {exc}", file=sys.stderr)
        return 1
    args.json_output.write_text(
        json.dumps(
            {
                "status": "verified",
                "sha": args.sha,
                "uat_revision": expected_revision,
                "image_reference": image,
            },
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    print(image)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

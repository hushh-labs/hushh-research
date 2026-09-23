"""Fail-closed Cloud Run readiness and immutable image attestation for Drive work."""

from __future__ import annotations

import json
import os
import sys
from typing import Any


def _digest(image: Any) -> str | None:
    if not isinstance(image, str) or image.count("@") != 1:
        return None
    digest = image.rsplit("@", 1)[1]
    if not digest.startswith("sha256:") or len(digest) != 71:
        return None
    return digest


def verify_revision(
    revision: dict[str, Any],
    *,
    deploy_sha: str,
    app_image: str,
    scanner_index_digest: str,
    scanner_amd64_digest: str,
) -> None:
    """Accept only the reviewed app and either pinned ClamAV manifest form.

    Cloud Run's mirror resolves the pinned multi-architecture OCI index to its
    Linux/AMD64 child manifest. Both digests must be pinned independently;
    merely accepting any resolved scanner image would lose provenance.
    """
    labels = (revision.get("metadata") or {}).get("labels") or {}
    if labels.get("deploy-sha") != deploy_sha:
        raise ValueError("Drive worker deploy SHA mismatch")

    conditions = (revision.get("status") or {}).get("conditions") or []
    if not any(
        item.get("type") == "Ready" and item.get("status") == "True"
        for item in conditions
    ):
        raise ValueError("Drive worker revision is not Ready")

    containers = (revision.get("spec") or {}).get("containers") or []
    if len(containers) != 2 or {item.get("name") for item in containers} != {
        "drive-worker",
        "clamav",
    }:
        raise ValueError("Drive worker container set mismatch")
    images = {item["name"]: item.get("image") for item in containers}
    if images["drive-worker"] != app_image:
        raise ValueError("Drive worker app image mismatch")
    if _digest(images["clamav"]) not in {
        scanner_index_digest,
        scanner_amd64_digest,
    }:
        raise ValueError("Drive worker scanner image digest mismatch")


def main() -> int:
    try:
        revision = json.load(sys.stdin)
        verify_revision(
            revision,
            deploy_sha=os.environ["EXPECTED_SHA"],
            app_image=os.environ["EXPECTED_APP_IMAGE"],
            scanner_index_digest=os.environ["EXPECTED_SCANNER_INDEX_DIGEST"],
            scanner_amd64_digest=os.environ["EXPECTED_SCANNER_AMD64_DIGEST"],
        )
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        print(f"Drive worker candidate provenance failed: {exc}", file=sys.stderr)
        return 1
    print("Verified Drive worker candidate readiness, SHA and image digests")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Fail-closed Cloud Run readiness and immutable image attestation for Drive work."""

from __future__ import annotations

import json
import os
import sys
from typing import Any

_REVISION_MAX_SCALE = "autoscaling.knative.dev/maxScale"
_REVISION_MIN_SCALE = "autoscaling.knative.dev/minScale"


def _digest(image: Any) -> str | None:
    if not isinstance(image, str) or image.count("@") != 1:
        return None
    digest = image.rsplit("@", 1)[1]
    if not digest.startswith("sha256:") or len(digest) != 71:
        return None
    return digest


def _verify_scaling(
    revision: dict[str, Any], *, max_instances: str | None, concurrency: str | None
) -> None:
    """Hold the candidate to the per-revision shape the connection budget counts.

    The budget reserves maxScale x workers x pool for every retained revision.
    Warm capacity comes from the service-level minimum, which follows traffic;
    a revision-level minimum would keep every tagged rollback revision warm.
    Concurrency is pinned because the worker's memory-heavy child limits are
    per request, not per process.
    """
    annotations = (revision.get("metadata") or {}).get("annotations") or {}
    observed = (revision.get("spec") or {}).get("containerConcurrency")
    if (
        max_instances is None
        or concurrency is None
        or annotations.get(_REVISION_MAX_SCALE) != max_instances
        or annotations.get(_REVISION_MIN_SCALE, "0") != "0"
        or type(observed) is not int
        or str(observed) != concurrency
    ):
        raise ValueError("Drive worker revision scaling mismatch")


def verify_revision(
    revision: dict[str, Any],
    *,
    deploy_sha: str,
    app_image: str,
    scanner_index_digest: str,
    scanner_amd64_digest: str,
    drain_enabled: str | None = None,
    semantic_model_provider: str | None = None,
    managed_text_provider: str | None = None,
    max_instances: str | None = None,
    concurrency: str | None = None,
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
    if managed_text_provider is not None:
        worker = next(item for item in containers if item["name"] == "drive-worker")
        selected = [
            item.get("value")
            for item in worker.get("env", [])
            if item.get("name") == "HUSHH_UAT_MANAGED_TEXT_PROVIDER"
        ]
        if managed_text_provider not in {"azure_openai", "vertex"} or selected != [
            managed_text_provider
        ]:
            raise ValueError("Drive worker managed text provider mismatch")
        full = [
            item.get("value")
            for item in worker.get("env", [])
            if item.get("name") == "HUSHH_UAT_MANAGED_AI_PROVIDER"
        ]
        if full != [managed_text_provider]:
            raise ValueError("Drive worker managed capability provider mismatch")
    if semantic_model_provider is not None:
        worker = next(item for item in containers if item["name"] == "drive-worker")
        providers = [
            item.get("value")
            for item in worker.get("env", [])
            if item.get("name") == "DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER"
        ]
        if semantic_model_provider not in {"gemini", "azure_openai"} or providers != [
            semantic_model_provider
        ]:
            raise ValueError("Drive worker semantic model provider mismatch")
    if drain_enabled is not None:
        worker = next(item for item in containers if item["name"] == "drive-worker")
        flags = [
            item.get("value")
            for item in worker.get("env", [])
            if item.get("name") == "DRIVE_WORK_DRAIN_ENABLED"
        ]
        if drain_enabled not in {"true", "false"} or flags != [drain_enabled]:
            raise ValueError("Drive worker background processing state mismatch")
    if images["drive-worker"] != app_image:
        raise ValueError("Drive worker app image mismatch")
    if _digest(images["clamav"]) not in {
        scanner_index_digest,
        scanner_amd64_digest,
    }:
        raise ValueError("Drive worker scanner image digest mismatch")
    if max_instances is not None or concurrency is not None:
        _verify_scaling(revision, max_instances=max_instances, concurrency=concurrency)


def main() -> int:
    try:
        revision = json.load(sys.stdin)
        verify_revision(
            revision,
            deploy_sha=os.environ["EXPECTED_SHA"],
            app_image=os.environ["EXPECTED_APP_IMAGE"],
            scanner_index_digest=os.environ["EXPECTED_SCANNER_INDEX_DIGEST"],
            scanner_amd64_digest=os.environ["EXPECTED_SCANNER_AMD64_DIGEST"],
            drain_enabled=os.environ.get("EXPECTED_DRAIN_ENABLED"),
            semantic_model_provider=os.environ.get("EXPECTED_SEMANTIC_MODEL_PROVIDER"),
            managed_text_provider=os.environ.get("EXPECTED_MANAGED_TEXT_PROVIDER"),
            max_instances=os.environ.get("EXPECTED_MAX_INSTANCES"),
            concurrency=os.environ.get("EXPECTED_CONCURRENCY"),
        )
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        print(f"Drive worker candidate provenance failed: {exc}", file=sys.stderr)
        return 1
    print("Verified Drive worker candidate readiness, SHA and image digests")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

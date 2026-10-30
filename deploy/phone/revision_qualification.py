# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Bind phone fallbacks to actual Cloud Run identity and readiness."""

from __future__ import annotations

import json
import re
import subprocess
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, build_opener

PROJECT = "hushh-pda"
REGION = "us-central1"
SERVICE = "consent-protocol"


def qualify_runtime(container: dict) -> None:
    if container.get("command") not in (None, []) or container.get("args") not in (None, []):
        raise ValueError("phone_rollback_custom_launcher_refused")
    generation = [
        row for row in container.get("env", [])
        if row.get("name") == "ACCOUNT_GENERATION_ADMISSION_ENABLED"
    ]
    if generation and (
        len(generation) != 1
        or generation[0].get("value") != "false"
        or "valueFrom" in generation[0]
    ):
        raise ValueError("phone_rollback_generation_branch_unqualified")


def cloud_document(kind: str, name: str) -> dict:
    if kind not in {"services", "revisions"} or not re.fullmatch(
        r"[a-z0-9-]{1,63}", name
    ):
        raise ValueError("phone_fallback_cloud_identity_invalid")
    result = subprocess.run(  # noqa: S603
        [
            "gcloud",
            "run",
            kind,
            "describe",
            name,
            f"--project={PROJECT}",
            f"--region={REGION}",
            "--format=json",
        ],
        capture_output=True,
        check=True,
        timeout=90,
    )
    if len(result.stdout) > 1024 * 1024:
        raise ValueError("phone_fallback_cloud_response_exceeds_bound")
    payload = json.loads(result.stdout)
    if not isinstance(payload, dict):
        raise ValueError("phone_fallback_cloud_response_invalid")
    return payload


def _qualify_revision(
    revision: dict, *, sha: str, image: str, run_id: str, source: str, cold: bool
) -> dict:
    metadata, spec, status = (
        revision.get(key) or {} for key in ("metadata", "spec", "status")
    )
    labels = metadata.get("labels") or {}
    containers = spec.get("containers") or []
    if len(containers) != 1:
        raise ValueError("phone_fallback_container_identity_invalid")
    container = containers[0]
    qualify_runtime(container)
    env = container.get("env") or []
    values = {row.get("name"): row.get("value") for row in env}
    expected = {
        "HUSHH_DEPLOY_ENV": "production",
        "ENVIRONMENT": "production",
        "GOOGLE_CLOUD_PROJECT": PROJECT,
        "HUSHH_DEPLOY_SOURCE": source,
        "HUSHH_DEPLOY_SHA": sha,
        "HUSHH_DEPLOY_RUN_ID": run_id,
    }
    if cold:
        expected.update(AUTH_PHONE_RECOVERY_ENABLED="false", WORKOS_SSO_ENABLED="false")
    if (
        len(env) != len(values)
        or container.get("command") not in (None, [])
        or container.get("args") not in (None, [])
        or any(values.get(key) != value for key, value in expected.items())
        or any("valueFrom" in row for row in env if row.get("name") in expected)
        or any(
            labels.get(key) != value
            for key, value in {
                "serving.knative.dev/service": SERVICE,
                "deploy-env": "production",
                "deploy-source": source,
                "deploy-sha": sha,
                "github-run-id": run_id,
                "account-deletion-contract": "v201",
            }.items()
        )
        or spec.get("serviceAccountName")
        != f"{SERVICE}-runtime@{PROJECT}.iam.gserviceaccount.com"
        or container.get("image") != image
        or status.get("imageDigest") != image
        or not any(
            row.get("type") == "Ready" and str(row.get("status")).lower() == "true"
            for row in status.get("conditions", [])
        )
    ):
        raise ValueError("phone_fallback_revision_not_qualified")
    return {
        "revision": metadata["name"],
        "source": sha,
        "image": image,
        "project": PROJECT,
        "region": REGION,
        "run_id": run_id,
    }


def qualify_revision(revision: dict, *, sha: str, image: str, run_id: str) -> dict:
    receipt = _qualify_revision(
        revision,
        sha=sha,
        image=image,
        run_id=run_id,
        source="deploy-production-phone-rollback",
        cold=True,
    )
    return {**receipt, "recovery": False, "sso": False}


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def inspect_existing(
    *, revision_name: str, sha: str, image: str, run_id: str, source: str
) -> dict:
    """Check a serving revision against independently accepted release identity."""
    if (
        source != "deploy-production"
        or not re.fullmatch(r"[1-9][0-9]*", run_id)
        or not re.fullmatch(r"[0-9a-f]{40}", sha)
        or not re.fullmatch(
            r"gcr\.io/hushh-pda/consent-protocol@sha256:[0-9a-f]{64}", image
        )
    ):
        raise ValueError("phone_rollback_existing_release_identity_invalid")
    service = cloud_document("services", SERVICE)
    status = service.get("status") or {}
    latest = status.get("latestReadyRevisionName")
    traffic = status.get("traffic") or []
    positive = [row for row in traffic if int(row.get("percent") or 0) > 0]
    if (
        (service.get("metadata") or {}).get("name") != SERVICE
        or any(not 0 <= int(row.get("percent") or 0) <= 100 for row in traffic)
        or len(positive) != 1
        or int(positive[0]["percent"]) != 100
        or (
            positive[0].get("revisionName")
            or (latest if positive[0].get("latestRevision") else None)
        ) != revision_name
    ):
        raise ValueError("phone_rollback_existing_must_solely_serve_traffic")
    address = urlparse(str(status.get("url") or ""))
    if (
        address.scheme != "https"
        or address.username
        or address.password
        or address.port
        or not re.fullmatch(
            r"consent-protocol-[a-z0-9]+(?:-[a-z0-9]+)*\.a\.run\.app",
            address.hostname or "",
        )
        or address.path
        or address.query
        or address.fragment
    ):
        raise ValueError("phone_rollback_existing_service_url_invalid")
    receipt = _qualify_revision(
        cloud_document("revisions", revision_name),
        sha=sha,
        image=image,
        run_id=run_id,
        source=source,
        cold=False,
    )
    if receipt["revision"] != revision_name:
        raise ValueError("phone_rollback_existing_revision_mismatch")
    with build_opener(_NoRedirect).open(
        status["url"] + "/health", timeout=10
    ) as response:
        if response.status != 200:
            raise ValueError("phone_fallback_health_failed")
    return {
        **receipt,
        "deploy_source": source,
        "health": "passed",
        "traffic_percent": 100,
    }


def inspect_cold(*, sha: str, image: str, run_id: str) -> dict:
    if not re.fullmatch(r"[1-9][0-9]*", run_id):
        raise ValueError("phone_fallback_run_identity_invalid")
    tag = f"phone-rollback-{run_id}"
    service = cloud_document("services", SERVICE)
    matching = [
        row
        for row in service.get("status", {}).get("traffic", [])
        if row.get("tag") == tag
    ]
    if len(matching) != 1 or int(matching[0].get("percent") or 0) != 0:
        raise ValueError("phone_fallback_must_have_zero_traffic")
    target = matching[0]
    latest = service.get("status", {}).get("latestReadyRevisionName")
    if any(
        int(row.get("percent") or 0) > 0
        and (row.get("revisionName") or (latest if row.get("latestRevision") else None))
        == target["revisionName"]
        for row in service.get("status", {}).get("traffic", [])
    ):
        raise ValueError("phone_fallback_revision_already_serves_traffic")
    address = urlparse(str(target.get("url") or ""))
    if (
        address.scheme != "https"
        or address.username
        or address.password
        or address.port
        or not address.hostname
        or not address.hostname.startswith(tag + "---")
        or not address.hostname.endswith(".a.run.app")
        or address.path
        or address.query
        or address.fragment
    ):
        raise ValueError("phone_fallback_tag_url_invalid")
    receipt = qualify_revision(
        cloud_document("revisions", target["revisionName"]),
        sha=sha,
        image=image,
        run_id=run_id,
    )
    if receipt["revision"] != target["revisionName"]:
        raise ValueError("phone_fallback_tag_revision_mismatch")
    with build_opener(_NoRedirect).open(
        target["url"] + "/health", timeout=10
    ) as response:
        if response.status != 200:
            raise ValueError("phone_fallback_health_failed")
    return {**receipt, "health": "passed"}

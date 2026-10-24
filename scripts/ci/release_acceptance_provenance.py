"""Pure artifact, serving and image proof for the existing acceptance receipt."""

from __future__ import annotations

import re


class Refused(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Refused(message)


def validated_backend_image(observed: dict, project: str, service: str) -> str | None:
    fields = {"image_reference", "image_digest", "image_verified"}
    if not fields.intersection(observed):
        return None  # Historical acceptance remains usable for a source build.
    reference = observed.get("image_reference")
    require(
        isinstance(reference, str)
        and re.fullmatch(
            r"gcr\.io/"
            + re.escape(project)
            + "/"
            + re.escape(service)
            + r"@sha256:[a-f0-9]{64}",
            reference,
        )
        is not None
        and observed.get("image_verified") is True
        and observed.get("image_digest") == reference.rsplit("@", 1)[-1],
        "Accepted backend image proof is invalid",
    )
    return reference


def validate_serving_provenance(
    receipt: dict,
    *,
    environment: str,
    sha: str,
    service: str,
    revision: str,
    project: str,
    service_name: str,
) -> str | None:
    evidence = receipt.get("provenance", {}).get(service, {})
    expected = {
        "HUSHH_DEPLOY_ENV": environment,
        "HUSHH_DEPLOY_SOURCE": f"deploy-{environment}",
        "HUSHH_DEPLOY_SHA": sha,
        "HUSHH_DEPLOY_RUN_ID": str(receipt.get("run_id")),
    }
    revisions = evidence.get("checked_revisions", [])
    require(
        evidence.get("status") == "healthy"
        and evidence.get("ok") is True
        and evidence.get("mode") == "live_traffic"
        and evidence.get("project") == project
        and evidence.get("region") == "us-central1"
        and evidence.get("service") == service_name
        and evidence.get("expected") == expected
        and evidence.get("failures") == []
        and len(revisions) == 1,
        "Live serving provenance is missing or inconsistent",
    )
    observed = revisions[0]
    require(
        observed.get("revision") == revision
        and observed.get("traffic_percent") == 100
        and observed.get("ok") is True
        and observed.get("mismatches") == []
        and observed.get("env") == expected,
        "The accepted revision did not serve all traffic",
    )
    return (
        validated_backend_image(observed, project, service_name)
        if service == "backend"
        else None
    )


def validate_artifact(
    artifact: dict, pin: dict, environment: str, max_bytes: int
) -> None:
    run_id, attempt, artifact_id = (
        pin[key] for key in ("run_id", "run_attempt", "artifact_id")
    )
    require(
        artifact.get("id") == artifact_id
        and artifact.get("expired") is False
        and artifact.get("name")
        == f"release-acceptance-{environment}-{run_id}-{attempt}"
        and artifact.get("workflow_run", {}).get("id") == run_id
        and 0 < artifact.get("size_in_bytes", 0) <= max_bytes
        and re.fullmatch(r"sha256:[a-f0-9]{64}", artifact.get("digest", "")) is not None
        and (
            not pin.get("artifact_digest")
            or pin["artifact_digest"] == artifact["digest"]
        ),
        "Acceptance artifact identity or retention is invalid",
    )

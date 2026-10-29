#!/usr/bin/env python3
"""Pure validation and durable receipt readers for release acceptance."""

from __future__ import annotations

import hashlib
import json
import re
from io import BytesIO
from zipfile import ZipFile


def selected(scope: str, *, services: dict, require) -> set[str]:
    require(
        scope in {"all", "backend", "frontend"}, "Resolved deployment scope is required"
    )
    return set(services) if scope == "all" else {scope}


def validate(
    receipt: dict,
    *,
    environment: str,
    sha: str,
    service: str,
    repository: str,
    lanes: dict,
    services: dict,
    require,
    validate_serving_provenance,
) -> str | None:
    """Validate one accepted service and its exact live serving provenance."""
    require(
        re.fullmatch(r"[a-f0-9]{40}", sha) is not None,
        "A full application SHA is required",
    )
    require(
        receipt.get("schema_version") == 1
        and receipt.get("environment") == environment
        and receipt.get("repository") == repository
        and receipt.get("workflow") == f".github/workflows/deploy-{environment}.yml"
        and receipt.get("target") == ("shared-dev" if environment == "dev" else "uat"),
        "Acceptance identity is invalid",
    )
    status = receipt.get("release", {})
    require(
        status.get("status") == "healthy" and status.get("sha") == sha,
        "Release is not healthy for this SHA",
    )
    require(service in receipt.get("resolved_services", []), "Service was not accepted")
    final = status.get("final", {})
    revision = final.get(f"{service}_revision")
    require(
        bool(revision)
        and revision == status.get("current", {}).get(f"{service}_candidate_revision")
        and final.get(f"{service}_sha") == sha,
        "Final serving revision does not match the candidate",
    )
    _check_release_verification(receipt, service, require)
    return validate_serving_provenance(
        receipt,
        environment=environment,
        sha=sha,
        service=service,
        revision=revision,
        project=lanes[environment],
        service_name=services[service],
    )


def _check_release_verification(receipt: dict, service: str, require) -> None:
    status = receipt.get("release", {})
    verification = status.get("verification", {})
    classification = receipt.get("classification", {})
    semantic = classification.get("semantic", {})
    require(
        classification.get("release_failed") is False
        and classification.get("status") == "healthy"
        and classification.get("blocking_classifications") == []
        and type(semantic.get("success")) is bool
        and (semantic["success"] or semantic.get("report_present") is True)
        and semantic.get("blocking_failures") == []
        and verification.get("semantic_success") == str(semantic["success"]).lower()
        and all(
            verification.get(key) == "true"
            for key in ("parity_success", "provenance_success")
        )
        and verification.get(f"{service}_provenance") == "success",
        "Required release verification did not pass",
    )
    if service == "backend":
        require(
            verification.get("db_contract") == "success",
            "Schema verification did not pass",
        )
    checks = receipt.get("required_checks", {})
    require(
        set(checks) == {"pkm", "reviewer"},
        "Required verification declarations are missing",
    )
    for check in checks.values():
        require(
            isinstance(check, dict)
            and type(check.get("required")) is bool
            and (not check["required"] or check.get("outcome") == "success"),
            "A required preservation or reviewer check did not pass",
        )


def unpack(archive: bytes, digest: str, *, max_bytes: int, require) -> dict:
    require(len(archive) <= max_bytes, "Acceptance artifact exceeds its bound")
    require(
        digest == "sha256:" + hashlib.sha256(archive).hexdigest(),
        "Artifact digest mismatch",
    )
    with ZipFile(BytesIO(archive)) as bundle:
        entries = bundle.infolist()
        require(
            len(entries) == 1
            and entries[0].filename == "acceptance.json"
            and entries[0].file_size <= max_bytes
            and not entries[0].is_dir(),
            "Acceptance artifact shape is invalid",
        )
        result = json.loads(bundle.read(entries[0]))
    require(isinstance(result, dict), "Acceptance must be an object")
    return result


def durable_receipt(
    pin: dict,
    environment: str,
    *,
    read_repository,
    repository: str,
    require,
    decode_tag_message_with_bytes,
    verify_durable_attempt_attestation,
) -> tuple[dict, str]:
    """Read an exact immutable attempt tag and verify its protected attestation."""
    import re

    run_id, attempt, tag_name = (
        pin.get(key) for key in ("run_id", "run_attempt", "durable_tag")
    )
    ref = read_repository(f"git/ref/tags/{tag_name}")
    require(
        ref.get("ref") == f"refs/tags/{tag_name}"
        and ref.get("object", {}).get("type") == "tag"
        and re.fullmatch(r"[a-f0-9]{40}", str(ref.get("object", {}).get("sha", "")))
        is not None,
        "Durable UAT attempt reference is invalid",
    )
    tag = read_repository(f"git/tags/{ref['object']['sha']}")
    require(
        tag.get("tag") == tag_name
        and tag.get("object", {}).get("type") == "commit"
        and re.fullmatch(r"[a-f0-9]{40}", str(tag.get("object", {}).get("sha", "")))
        is not None,
        "Durable UAT attempt tag is invalid",
    )
    receipt, digest, receipt_bytes = decode_tag_message_with_bytes(
        str(tag.get("message", "")),
        tag_name=tag_name,
        tag_target_sha=tag["object"]["sha"],
        run_id=run_id,
        attempt=attempt,
        repository=repository,
        kind="full",
        environment=environment,
    )
    verify_durable_attempt_attestation(
        receipt_bytes,
        environment=environment,
        run_id=run_id,
        attempt=attempt,
    )
    return receipt, digest

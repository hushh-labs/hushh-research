#!/usr/bin/env python3
"""Verify the currently serving Production revisions without changing them."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import subprocess
from typing import Any

PROJECT = "hushh-pda"
REGION = "us-central1"
SERVICES = ("consent-protocol", "hushh-webapp")
REPOSITORY = "hushh-labs/hushh-research"
SERVICE_LABEL = "serving.knative.dev/service"
DEPLOYMENT_LABELS = {
    "deploy-env": "production",
    "deploy-source": "deploy-production",
}
PROVENANCE_ENV = {
    "HUSHH_DEPLOY_ENV": "deploy-env",
    "HUSHH_DEPLOY_SOURCE": "deploy-source",
    "HUSHH_DEPLOY_SHA": "deploy-sha",
}
SHA_PATTERN = re.compile(r"[0-9a-f]{40}\Z")
DIGEST_PATTERN = re.compile(r"sha256:[0-9a-f]{64}\Z")
REVISION_PATTERN = re.compile(r"[a-z][a-z0-9-]{0,62}\Z")
VERIFY_DEFAULTS = {
    "emergency_source_ref": "",
    "emergency_reason": "",
    "main_approval_sha": "",
    "restoration_validation_run": "",
    "restoration_activation_run_id": "",
    "restoration_activation_attempt": "",
    "scope": "auto",
    "run_predeploy_backup_job": "false",
    "enable_one_email_kyc": "false",
    "drive_live_mode": "preserve",
    "backend_image_source": "build-from-source",
    "phone_rollback_sha": "",
    "phone_phase": "standard",
    "phone_worker_stage_run_id": "",
    "phone_activation_run_id": "",
    "phone_schema_origin_run_id": "",
    "phone_schema_origin_attempt": "",
    "nearby_check_in_cohort": "all",
}


class VerificationError(ValueError):
    """A closed, content-free reason the live serving state is not qualified."""


def validate_dispatch(
    inputs: dict[str, str], *, event_name: str, ref: str, repository: str
) -> str:
    """Fail closed before credentials; preserve deploy as the legacy default."""
    operation = inputs.get("operation") or "deploy"
    if operation not in {"deploy", "verify_current"}:
        raise VerificationError("dispatch_operation_invalid")
    if event_name != "workflow_dispatch":
        raise VerificationError("dispatch_event_invalid")
    if ref != "refs/heads/main" or repository != REPOSITORY:
        raise VerificationError("dispatch_source_untrusted")
    if operation == "deploy":
        if not SHA_PATTERN.fullmatch(inputs.get("sha", "")):
            raise VerificationError("deployment_sha_invalid")
        return operation

    expected_keys = {"operation", "sha", *VERIFY_DEFAULTS}
    if set(inputs) != expected_keys:
        raise VerificationError("verification_inputs_invalid")
    if inputs.get("sha", "") != "":
        raise VerificationError("verification_inputs_invalid")
    if any(inputs.get(name) != expected for name, expected in VERIFY_DEFAULTS.items()):
        raise VerificationError("verification_inputs_invalid")
    return operation


def _object(value: Any, category: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise VerificationError(category)
    return value


def _read_gcloud_json(resource: str, name: str) -> dict[str, Any]:
    if resource == "services":
        if name not in SERVICES:
            raise VerificationError("unapproved_service")
        args = ["run", "services", "describe", name]
    elif resource == "revisions":
        if not any(name.startswith(f"{service}-") for service in SERVICES):
            raise VerificationError("unapproved_revision")
        if not REVISION_PATTERN.fullmatch(name):
            raise VerificationError("invalid_revision_name")
        args = ["run", "revisions", "describe", name]
    else:
        raise VerificationError("unapproved_resource_type")

    command = [
        "gcloud",
        *args,
        f"--project={PROJECT}",
        f"--region={REGION}",
        "--format=json",
        "--quiet",
    ]
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise VerificationError("cloud_run_read_unavailable") from error
    if result.returncode != 0:
        raise VerificationError("cloud_run_read_failed")
    try:
        return _object(json.loads(result.stdout), "cloud_run_response_invalid")
    except (json.JSONDecodeError, TypeError) as error:
        raise VerificationError("cloud_run_response_invalid") from error


def _service_revision(service: str, payload: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    metadata = _object(payload.get("metadata"), "service_identity_missing")
    status = _object(payload.get("status"), "service_status_missing")
    if metadata.get("name") != service:
        raise VerificationError("service_identity_mismatch")
    traffic = status.get("traffic")
    if not isinstance(traffic, list):
        raise VerificationError("serving_traffic_missing")
    active: list[dict[str, Any]] = []
    for row_value in traffic:
        row = _object(row_value, "serving_traffic_invalid")
        percent = row.get("percent")
        if type(percent) is not int or not 0 <= percent <= 100:
            raise VerificationError("serving_traffic_invalid")
        if percent > 0:
            active.append(row)
    if len(active) != 1 or active[0].get("percent") != 100:
        raise VerificationError("serving_traffic_not_exclusive")
    revision = active[0].get("revisionName")
    if not isinstance(revision, str) or not REVISION_PATTERN.fullmatch(revision):
        raise VerificationError("serving_revision_unresolved")
    if not revision.startswith(f"{service}-"):
        raise VerificationError("serving_revision_service_mismatch")
    return revision, metadata


def _safe_config(payload: dict[str, Any]) -> dict[str, Any]:
    spec = _object(payload.get("spec"), "revision_config_missing")
    containers = spec.get("containers")
    if not isinstance(containers, list) or not containers:
        raise VerificationError("revision_container_config_missing")
    safe_containers = []
    for item_value in containers:
        item = _object(item_value, "revision_container_config_invalid")
        safe_containers.append(
            {
                key: item[key]
                for key in (
                    "name",
                    "resources",
                    "ports",
                    "startupProbe",
                    "livenessProbe",
                )
                if key in item
            }
        )
    safe = {
        key: spec[key]
        for key in (
            "serviceAccountName",
            "containerConcurrency",
            "timeoutSeconds",
            "scaling",
            "vpcAccess",
            "executionEnvironment",
            "cpuIdle",
            "startupCpuBoost",
        )
        if key in spec
    }
    safe["containers"] = safe_containers
    return safe


def _config_fingerprint(service_payload: dict[str, Any], revision_payload: dict[str, Any]) -> str:
    service_spec = _object(service_payload.get("spec"), "service_config_missing")
    template = _object(service_spec.get("template"), "service_template_missing")
    template_spec = _object(template.get("spec"), "service_template_config_missing")
    canonical = json.dumps(
        {
            "service_template": _safe_config({"spec": template_spec}),
            "serving_revision": _safe_config(revision_payload),
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _provenance_env(revision_payload: dict[str, Any], labels: dict[str, Any]) -> str:
    spec = _object(revision_payload.get("spec"), "revision_config_missing")
    containers = spec.get("containers")
    if not isinstance(containers, list):
        raise VerificationError("revision_provenance_missing")
    observed: dict[str, str] = {}
    for container_value in containers:
        container = _object(container_value, "revision_container_config_invalid")
        entries = container.get("env") or []
        if not isinstance(entries, list):
            raise VerificationError("revision_provenance_invalid")
        for entry_value in entries:
            entry = _object(entry_value, "revision_provenance_invalid")
            name = entry.get("name")
            if name not in PROVENANCE_ENV:
                continue
            value = entry.get("value")
            if not isinstance(value, str) or name in observed:
                raise VerificationError("revision_provenance_invalid")
            observed[name] = value

    for env_name, label_name in PROVENANCE_ENV.items():
        label_value = labels.get(label_name)
        if not isinstance(label_value, str) or observed.get(env_name) != label_value:
            raise VerificationError("revision_provenance_mismatch")
    source = labels.get("deploy-sha")
    if not isinstance(source, str) or not SHA_PATTERN.fullmatch(source):
        raise VerificationError("revision_source_sha_invalid")
    return source


def _serving_entry(service: str) -> dict[str, Any]:
    service_payload = _read_gcloud_json("services", service)
    revision_name, service_metadata = _service_revision(service, service_payload)
    revision_payload = _read_gcloud_json("revisions", revision_name)
    revision_metadata = _object(revision_payload.get("metadata"), "revision_identity_missing")
    revision_status = _object(revision_payload.get("status"), "revision_status_missing")
    labels = _object(revision_metadata.get("labels"), "revision_provenance_missing")
    conditions = revision_status.get("conditions")
    if not isinstance(conditions, list) or not any(
        isinstance(condition, dict)
        and condition.get("type") == "Ready"
        and str(condition.get("status", "")).lower() == "true"
        for condition in conditions
    ):
        raise VerificationError("serving_revision_not_ready")
    if revision_metadata.get("name") != revision_name:
        raise VerificationError("serving_revision_identity_mismatch")
    if labels.get(SERVICE_LABEL) != service:
        raise VerificationError("serving_revision_service_mismatch")
    for label, expected in DEPLOYMENT_LABELS.items():
        if labels.get(label) != expected:
            raise VerificationError("revision_deployment_source_mismatch")
    source_sha = _provenance_env(revision_payload, labels)
    image_digest = str(revision_status.get("imageDigest") or "").rsplit("@", 1)[-1]
    if not DIGEST_PATTERN.fullmatch(image_digest):
        raise VerificationError("serving_image_digest_invalid")

    service_uid = service_metadata.get("uid")
    service_generation = service_metadata.get("generation")
    revision_uid = revision_metadata.get("uid")
    if (
        not isinstance(service_uid, str)
        or not service_uid
        or type(service_generation) is not int
        or service_generation < 1
        or not isinstance(revision_uid, str)
        or not revision_uid
    ):
        raise VerificationError("serving_resource_identity_missing")
    created_candidate = (service_payload.get("status") or {}).get(
        "latestCreatedRevisionName"
    )
    if created_candidate is not None and not isinstance(created_candidate, str):
        raise VerificationError("latest_created_revision_invalid")
    if created_candidate and not REVISION_PATTERN.fullmatch(created_candidate):
        raise VerificationError("latest_created_revision_invalid")
    candidate_warning = (
        created_candidate if created_candidate and created_candidate != revision_name else ""
    )

    return {
        "service": service,
        "service_uid": service_uid,
        "service_generation": service_generation,
        "traffic_percent": 100,
        "serving_revision": revision_name,
        "serving_revision_uid": revision_uid,
        "ready": True,
        "image_digest": image_digest,
        "app_source_sha": source_sha,
        "configuration_fingerprint": _config_fingerprint(
            service_payload, revision_payload
        ),
        "non_serving_candidate_revision": candidate_warning,
    }


def capture_snapshot() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "project": PROJECT,
        "region": REGION,
        "services": [_serving_entry(service) for service in SERVICES],
    }


def _write_snapshot(path: Path, snapshot: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(snapshot, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def _load_snapshot(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise VerificationError("snapshot_invalid") from error
    snapshot = _object(value, "snapshot_invalid")
    if snapshot.get("schema_version") != 1 or snapshot.get("project") != PROJECT or snapshot.get("region") != REGION:
        raise VerificationError("snapshot_identity_mismatch")
    services = snapshot.get("services")
    if not isinstance(services, list) or [row.get("service") for row in services if isinstance(row, dict)] != list(SERVICES):
        raise VerificationError("snapshot_services_invalid")
    return snapshot


def _write_summary(
    *, before: dict[str, Any] | None, after: dict[str, Any] | None,
    backend_health: str, frontend_health: str, error: str = "",
) -> None:
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary_path:
        return
    if after is None:
        services: list[dict[str, Any]] = []
        unchanged = False
    else:
        services = after["services"]
        unchanged = before is not None and before["services"] == after["services"]
    workflow_sha = os.environ.get("GITHUB_SHA", "")
    if not SHA_PATTERN.fullmatch(workflow_sha):
        workflow_sha = "unavailable"
    lines = [
        "## Read-only current Production verification", "",
        "This run inspects the serving release; it does not deploy its workflow SHA.",
        f"- Verifier workflow SHA (not application SHA): `{workflow_sha}`",
        f"- Public backend health: `{backend_health}`",
        f"- Public frontend health: `{frontend_health}`",
        f"- Serving state unchanged across checks: `{str(unchanged).lower()}`",
    ]
    if error:
        lines.append(f"- Result: `blocked` ({error})")
    elif unchanged and backend_health == "success" and frontend_health == "success":
        lines.append("- Result: `verified`")
    else:
        lines.append("- Result: `blocked`")
    if services:
        lines.extend([
            "", "| Service | Serving revision | Ready | Traffic | Image digest | Application source SHA | Config fingerprint |",
            "| --- | --- | ---: | ---: | --- | --- | --- |",
        ])
        for row in services:
            lines.append(
                f"| {row['service']} | `{row['serving_revision']}` | yes | "
                f"{row['traffic_percent']}% | `{row['image_digest']}` | "
                f"`{row['app_source_sha']}` | `{row['configuration_fingerprint']}` |"
            )
            candidate = row.get("non_serving_candidate_revision")
            if candidate:
                lines.append(
                    f"\n- {row['service']}: non-serving latest-created candidate `{candidate}`; "
                    "it was not inspected or treated as deployed."
                )
    with Path(summary_path).open("a", encoding="utf-8") as output:
        output.write("\n".join(lines) + "\n")


def _capture_command(path: Path) -> int:
    try:
        _write_snapshot(path, capture_snapshot())
    except VerificationError as error:
        _write_summary(before=None, after=None, backend_health="not_run", frontend_health="not_run", error=str(error))
        print(f"BLOCKED: {error}", file=sys.stderr)
        return 1
    print("Captured sanitized current-serving metadata for two Production services.")
    return 0


def _compare_command(args: argparse.Namespace) -> int:
    try:
        before = _load_snapshot(Path(args.before))
        after = _load_snapshot(Path(args.after))
        unchanged = before["services"] == after["services"]
    except (VerificationError, KeyError, TypeError) as error:
        category = str(error) if isinstance(error, VerificationError) else "snapshot_invalid"
        print(f"BLOCKED: {category}", file=sys.stderr)
        return 1
    health_ok = args.backend_health == "success" and args.frontend_health == "success"
    error = "serving_state_changed_during_check" if not unchanged else "public_health_check_failed" if not health_ok else ""
    _write_summary(
        before=before, after=after, backend_health=args.backend_health,
        frontend_health=args.frontend_health, error=error,
    )
    if error:
        print(f"BLOCKED: {error}", file=sys.stderr)
        return 1
    print("Current serving state is healthy and unchanged across the read-only check.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("validate-dispatch")
    capture = subparsers.add_parser("capture")
    capture.add_argument("--output", required=True)
    compare = subparsers.add_parser("compare")
    compare.add_argument("--before", required=True)
    compare.add_argument("--after", required=True)
    compare.add_argument("--backend-health", choices=("success", "failed"), required=True)
    compare.add_argument("--frontend-health", choices=("success", "failed"), required=True)
    args = parser.parse_args(argv)
    if args.command == "validate-dispatch":
        input_names = {"operation", "sha", *VERIFY_DEFAULTS}
        inputs = {
            name: os.environ.get(f"INPUT_{name.upper()}", "")
            for name in input_names
        }
        try:
            operation = validate_dispatch(
                inputs,
                event_name=os.environ.get("GITHUB_EVENT_NAME", ""),
                ref=os.environ.get("GITHUB_REF", ""),
                repository=os.environ.get("GITHUB_REPOSITORY", ""),
            )
        except VerificationError as error:
            print(f"BLOCKED: {error}", file=sys.stderr)
            return 1
        with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
            output.write(f"operation={operation}\n")
        print(f"Production request validated: {operation}.")
        return 0
    if args.command == "capture":
        return _capture_command(Path(args.output))
    return _compare_command(args)


if __name__ == "__main__":
    raise SystemExit(main())

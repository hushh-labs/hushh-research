#!/usr/bin/env python3
"""Persist and validate immutable exact-attempt Dev and UAT release evidence."""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

FORMAT = "HUSHH-RELEASE-ATTEMPT-RECEIPT v1"
REPOSITORY = "hushh-labs/hushh-research"
TAG_PREFIX = "deployed/uat-attempt"
MAX_RECEIPT_BYTES = 512 * 1024
HEX40 = re.compile(r"[a-f0-9]{40}")


class InvalidReceipt(ValueError):
    """The receipt or immutable tag identity is incomplete or mismatched."""


_PROCESS_SPEC = importlib.util.spec_from_file_location(
    "attempt_receipt_process_group", Path(__file__).with_name("process_group.py")
)
if not _PROCESS_SPEC or not _PROCESS_SPEC.loader:
    raise InvalidReceipt("Attempt receipt verification transport is unavailable")
_process_group = importlib.util.module_from_spec(_PROCESS_SPEC)
_PROCESS_SPEC.loader.exec_module(_process_group)


def _require(value: bool, message: str) -> None:
    if not value:
        raise InvalidReceipt(message)


def _text(value: Any, pattern: re.Pattern[str]) -> bool:
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def attempt_tag_prefix(environment: str) -> str:
    _require(environment in {"dev", "uat"}, "Unsupported UAT predecessor environment")
    return f"deployed/{environment}-attempt"


def validate_receipt(
    receipt: dict[str, Any], *, kind: str, run_id: int, attempt: int, repository: str,
    target_sha: str, environment: str = "uat"
) -> str:
    """Check the application and exact workflow-attempt identity before tagging."""
    _require(kind in {"full", "one-chat"}, "Unsupported UAT receipt kind")
    _require(environment in {"dev", "uat"} and (kind == "full" or environment == "uat"),
             "Unsupported attempt receipt environment")
    _require(_text(target_sha, HEX40), "UAT application SHA is invalid")

    if kind == "full":
        release = receipt.get("release")
        classification = receipt.get("classification")
        _require(
            receipt.get("schema_version") == 1
            and receipt.get("repository") == repository
            and receipt.get("workflow") == f".github/workflows/deploy-{environment}.yml"
            and receipt.get("environment") == environment
            and receipt.get("target") == ("shared-dev" if environment == "dev" else "uat")
            and receipt.get("run_id") == run_id
            and receipt.get("run_attempt") == attempt
            and isinstance(release, dict)
            and release.get("status") == "healthy"
            and release.get("release_failed") is False
            and release.get("sha") == target_sha
            and release.get("scope") in {"all", "backend", "frontend"}
            and isinstance(classification, dict)
            and classification.get("status") == "healthy"
            and classification.get("release_failed") is False
            and classification.get("blocking_classifications") == [],
            f"Full {environment.upper()} receipt does not match its successful exact attempt",
        )
        scope = release["scope"]
        services = ["backend", "frontend"] if scope == "all" else [scope]
        _require(receipt.get("resolved_services") == services, f"{environment.upper()} receipt scope is inconsistent")
        final = release.get("final")
        _require(isinstance(final, dict), f"{environment.upper()} final service readback is missing")
        for service in ("backend", "frontend"):
            _require(
                isinstance(final.get(f"{service}_revision"), str)
                and final[f"{service}_revision"]
                and _text(final.get(f"{service}_sha"), HEX40),
                f"{environment.upper()} {service} final source identity is missing",
            )
        for service in services:
            _require(
                final[f"{service}_sha"] == target_sha,
                f"{environment.upper()} {service} final source does not match the selected SHA",
            )
        return target_sha

    _require(
        receipt.get("project") == "hushh-pda-uat"
        and receipt.get("region") == "us-central1"
        and receipt.get("service") == "consent-protocol"
        and str(receipt.get("run_id")) == str(run_id)
        and receipt.get("attempt") == attempt
        and receipt.get("status") == "success"
        and receipt.get("target_sha") == target_sha
        and re.fullmatch(
            r"gcr\.io/hushh-pda-uat/consent-protocol@sha256:[a-f0-9]{64}",
            str(receipt.get("image", "")),
        ) is not None
        and isinstance(receipt.get("final_serving_revision"), str)
        and bool(receipt["final_serving_revision"])
        and receipt.get("final_traffic") == {receipt["final_serving_revision"]: 100},
        "One Chat receipt does not match its successful exact attempt",
    )
    return target_sha


def build_tag_message(
    *, kind: str, run_id: int, attempt: int, repository: str, workflow: str, target_sha: str,
    raw: bytes, environment: str = "uat"
) -> str:
    _require(0 < len(raw) <= MAX_RECEIPT_BYTES, "UAT attempt receipt exceeds its size bound")
    receipt = json.loads(raw)
    _require(isinstance(receipt, dict), "UAT attempt receipt must be an object")
    validate_receipt(
        receipt,
        kind=kind,
        run_id=run_id,
        attempt=attempt,
        repository=repository,
        target_sha=target_sha,
        environment=environment,
    )
    expected_workflow = (
        f".github/workflows/deploy-{environment}.yml"
        if kind == "full"
        else ".github/workflows/deploy-uat-one-chat.yml"
    )
    _require(workflow == expected_workflow, "UAT workflow identity does not match the receipt kind")
    encoded = base64.b64encode(raw).decode("ascii")
    return "\n".join(
        (
            FORMAT,
            f"kind: {kind}",
            f"repository: {repository}",
            f"workflow: {workflow}",
            f"run_id: {run_id}",
            f"run_attempt: {attempt}",
            f"sha: {target_sha}",
            f"receipt_sha256: {hashlib.sha256(raw).hexdigest()}",
            f"receipt_json_base64: {encoded}",
            "",
        )
    )


def decode_tag_message_with_bytes(
    message: str,
    *,
    tag_name: str,
    tag_target_sha: str,
    run_id: int,
    attempt: int,
    repository: str,
    kind: str,
    environment: str = "uat",
) -> tuple[dict[str, Any], str, bytes]:
    """Verify tag metadata and return its exact embedded receipt bytes."""
    expected_tag = f"{attempt_tag_prefix(environment)}/{run_id}-{attempt}"
    expected_workflow = (
        f".github/workflows/deploy-{environment}.yml"
        if kind == "full"
        else ".github/workflows/deploy-uat-one-chat.yml"
    )
    lines = message.splitlines()
    _require(bool(lines) and lines[0] == FORMAT, "UAT attempt tag format is invalid")
    fields: dict[str, str] = {}
    for line in lines[1:]:
        if not line:
            continue
        name, separator, value = line.partition(": ")
        _require(bool(separator) and name not in fields, "UAT attempt tag fields are malformed")
        fields[name] = value
    _require(
        tag_name == expected_tag
        and fields.get("kind") == kind
        and fields.get("repository") == repository
        and fields.get("workflow") == expected_workflow
        and fields.get("run_id") == str(run_id)
        and fields.get("run_attempt") == str(attempt)
        and _text(fields.get("sha"), HEX40)
        and tag_target_sha == fields.get("sha"),
        "UAT attempt tag identity is mismatched",
    )
    encoded = fields.get("receipt_json_base64", "")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error):
        raise InvalidReceipt("UAT attempt tag receipt encoding is invalid") from None
    _require(
        0 < len(raw) <= MAX_RECEIPT_BYTES
        and base64.b64encode(raw).decode("ascii") == encoded
        and hashlib.sha256(raw).hexdigest() == fields.get("receipt_sha256"),
        "UAT attempt tag receipt digest is invalid",
    )
    try:
        receipt = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise InvalidReceipt("UAT attempt tag receipt JSON is invalid") from None
    _require(isinstance(receipt, dict), "UAT attempt tag receipt must be an object")
    validate_receipt(
        receipt,
        kind=kind,
        run_id=run_id,
        attempt=attempt,
        repository=repository,
        target_sha=fields["sha"],
        environment=environment,
    )
    return receipt, hashlib.sha256(raw).hexdigest(), raw


def decode_tag_message(
    message: str,
    *,
    tag_name: str,
    tag_target_sha: str,
    run_id: int,
    attempt: int,
    repository: str,
    kind: str,
    environment: str = "uat",
) -> tuple[dict[str, Any], str]:
    """Compatibility wrapper for callers that do not verify provenance."""
    receipt, digest, _ = decode_tag_message_with_bytes(
        message,
        tag_name=tag_name,
        tag_target_sha=tag_target_sha,
        run_id=run_id,
        attempt=attempt,
        repository=repository,
        kind=kind,
        environment=environment,
    )
    return receipt, digest


def verify_attestation_bytes(
    receipt_bytes: bytes,
    *,
    kind: str,
    environment: str,
    run_id: int,
    attempt: int,
    read=None,
) -> None:
    """Require GitHub provenance for these exact receipt bytes and attempt."""
    _require(kind in {"full", "one-chat"}, "Unsupported attempt attestation kind")
    _require(environment in {"dev", "uat"} and (kind == "full" or environment == "uat"),
             "Unsupported attempt attestation environment")
    _require(type(run_id) is int and run_id > 0, "Attempt attestation run ID is invalid")
    _require(type(attempt) is int and attempt > 0, "Attempt attestation number is invalid")
    _require(0 < len(receipt_bytes) <= MAX_RECEIPT_BYTES, "Attempt receipt exceeds its attestation bound")
    workflow = (
        f".github/workflows/deploy-{environment}.yml"
        if kind == "full"
        else ".github/workflows/deploy-uat-one-chat.yml"
    )
    identity = f"https://github.com/{REPOSITORY}/{workflow}@refs/heads/main"
    command = [
        "gh", "attestation", "verify", "{subject}",
        "--repo", REPOSITORY,
        "--cert-identity", identity,
        "--source-ref", "refs/heads/main",
        "--limit", "100",
        "--format", "json",
    ]
    with tempfile.TemporaryDirectory(prefix="hushh-attempt-receipt-") as directory:
        subject = Path(directory) / "acceptance.json"
        subject.write_bytes(receipt_bytes)
        subject.chmod(0o600)
        command[3] = str(subject)
        try:
            raw = (read or _bounded_process_read)(command, 45)
        except (OSError, subprocess.SubprocessError, _process_group.BoundedReadError):
            raise InvalidReceipt("Release receipt attestation could not be verified") from None
    try:
        rows = json.loads(raw)
    except (ValueError, UnicodeError):
        raise InvalidReceipt("Release receipt attestation output is malformed") from None
    _require(isinstance(rows, list) and len(rows) == 1,
             "Release receipt attestation is missing or ambiguous")
    verified = rows[0].get("verificationResult") if isinstance(rows[0], dict) else None
    statement = verified.get("statement") if isinstance(verified, dict) else None
    _require(isinstance(statement, dict), "Verified release attestation has no statement")
    expected_digest = hashlib.sha256(receipt_bytes).hexdigest()
    subjects = statement.get("subject")
    _require(
        isinstance(subjects, list)
        and any(
            isinstance(item, dict)
            and isinstance(item.get("digest"), dict)
            and item["digest"].get("sha256") == expected_digest
            for item in subjects
        ),
        "Release attestation is for different receipt bytes",
    )
    predicate = statement.get("predicate")
    run_details = predicate.get("runDetails") if isinstance(predicate, dict) else None
    metadata = run_details.get("metadata") if isinstance(run_details, dict) else None
    invocation = f"https://github.com/{REPOSITORY}/actions/runs/{run_id}/attempts/{attempt}"
    _require(
        statement.get("predicateType") == "https://slsa.dev/provenance/v1"
        and isinstance(metadata, dict)
        and metadata.get("invocationId") == invocation,
        "Release attestation is not bound to this exact workflow run attempt",
    )


def _bounded_process_read(arguments: list[str], timeout: float) -> bytes:
    try:
        return _process_group.bounded_stdout(
            arguments, max_bytes=2 * MAX_RECEIPT_BYTES, timeout=timeout
        )
    except _process_group.BoundedReadError as error:
        raise InvalidReceipt("Release receipt attestation could not be verified") from error


def tag_receipt(kind: str, receipt_path: Path, environment: str) -> None:
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    target_sha = os.environ.get("TARGET_SHA", "")
    workflow = (
        f".github/workflows/deploy-{environment}.yml"
        if kind == "full"
        else ".github/workflows/deploy-uat-one-chat.yml"
    )
    _require(repository == REPOSITORY, "Unexpected repository")
    _require(run_id.isdigit() and int(run_id) > 0, "GITHUB_RUN_ID is invalid")
    _require(attempt.isdigit() and int(attempt) > 0, "GITHUB_RUN_ATTEMPT is invalid")
    message = build_tag_message(
        kind=kind,
        run_id=int(run_id),
        attempt=int(attempt),
        repository=repository,
        workflow=workflow,
        target_sha=target_sha,
        raw=receipt_path.read_bytes(),
        environment=environment,
    )
    tag_name = f"{attempt_tag_prefix(environment)}/{run_id}-{attempt}"
    local_ref = f"refs/tags/{tag_name}"
    existing = subprocess.run(
        ["git", "show-ref", "--verify", "--quiet", local_ref],
        check=False,
        capture_output=True,
        text=True,
    )
    _require(existing.returncode == 1, "The exact UAT attempt tag already exists or cannot be checked")
    identity = subprocess.run(
        ["git", "config", "--get", "user.email"], capture_output=True, text=True, check=False
    )
    if identity.returncode != 0:
        subprocess.run(
            ["git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"],
            check=True,
        )
    identity = subprocess.run(
        ["git", "config", "--get", "user.name"], capture_output=True, text=True, check=False
    )
    if identity.returncode != 0:
        subprocess.run(["git", "config", "user.name", "github-actions[bot]"], check=True)
    subprocess.run(["git", "tag", "-a", tag_name, target_sha, "-F", "-"], input=message, text=True, check=True)
    subprocess.run(["git", "push", "origin", local_ref], check=True)
    print(f"[uat-attempt-receipt] Persisted {kind} attempt {run_id}/{attempt} as {tag_name}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("tag", "verify-attestation"))
    parser.add_argument("--kind", choices=("full", "one-chat"), required=True)
    parser.add_argument("--environment", choices=("dev", "uat"), default="uat")
    parser.add_argument("--run-id", type=int)
    parser.add_argument("--attempt", type=int)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.command == "tag":
            tag_receipt(args.kind, args.receipt, args.environment)
        else:
            verify_attestation_bytes(
                args.receipt.read_bytes(),
                kind=args.kind,
                environment=args.environment,
                run_id=args.run_id,
                attempt=args.attempt,
            )
    except (InvalidReceipt, OSError, subprocess.CalledProcessError) as error:
        print(f"[uat-attempt-receipt] {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

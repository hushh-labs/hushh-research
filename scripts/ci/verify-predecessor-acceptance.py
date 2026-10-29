#!/usr/bin/env python3
"""Exact-SHA acceptance between governed release environments."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import subprocess
import time
from pathlib import Path
from zipfile import BadZipFile

REPOSITORY = "hushh-labs/hushh-research"
LANES = {"dev": "hushh-pda-dev", "uat": "hushh-pda-uat"}
SERVICES = {"backend": "consent-protocol", "frontend": "hushh-webapp"}
MAX_BYTES = 1024 * 1024


# Receipts are also executed from a preserved main-owned tooling directory.
# Load the companion beside this exact file without ambient import paths.
_PROVENANCE_SPEC = importlib.util.spec_from_file_location(
    "release_acceptance_provenance",
    Path(__file__).with_name("release_acceptance_provenance.py"),
)
if not _PROVENANCE_SPEC or not _PROVENANCE_SPEC.loader:
    raise RuntimeError("Acceptance provenance reader is unavailable")
_provenance = importlib.util.module_from_spec(_PROVENANCE_SPEC)
_PROVENANCE_SPEC.loader.exec_module(_provenance)
Refused = _provenance.Refused
require = _provenance.require
_required_checks = _provenance.required_checks

_PROCESS_SPEC = importlib.util.spec_from_file_location(
    "release_acceptance_process_group", Path(__file__).with_name("process_group.py")
)
require(_PROCESS_SPEC and _PROCESS_SPEC.loader, "Acceptance transport is unavailable")
_process_group = importlib.util.module_from_spec(_PROCESS_SPEC)
_PROCESS_SPEC.loader.exec_module(_process_group)

_ATTEMPT_RECEIPT_SPEC = importlib.util.spec_from_file_location(
    "uat_attempt_receipt", Path(__file__).with_name("uat_attempt_receipt.py")
)
require(_ATTEMPT_RECEIPT_SPEC and _ATTEMPT_RECEIPT_SPEC.loader, "Durable UAT receipt reader is unavailable")
_attempt_receipt = importlib.util.module_from_spec(_ATTEMPT_RECEIPT_SPEC)
_ATTEMPT_RECEIPT_SPEC.loader.exec_module(_attempt_receipt)
InvalidAttemptReceipt = _attempt_receipt.InvalidReceipt
decode_tag_message = _attempt_receipt.decode_tag_message
decode_tag_message_with_bytes = _attempt_receipt.decode_tag_message_with_bytes
attempt_tag_prefix = _attempt_receipt.attempt_tag_prefix

_CONTRACT_SPEC = importlib.util.spec_from_file_location(
    "release_acceptance_contract", Path(__file__).with_name("release_acceptance_contract.py")
)
require(_CONTRACT_SPEC and _CONTRACT_SPEC.loader, "Acceptance contract reader is unavailable")
_contract = importlib.util.module_from_spec(_CONTRACT_SPEC)
_CONTRACT_SPEC.loader.exec_module(_contract)


class MissingAcceptance(Refused):
    """No retained healthy receipts cover the requested services yet."""


def verify_durable_attempt_attestation(
    receipt_bytes: bytes,
    *,
    environment: str,
    run_id: int,
    attempt: int,
) -> None:
    """Require a GitHub-signed receipt from the exact protected release run."""
    _attempt_receipt.verify_attestation_bytes(
        receipt_bytes,
        kind="full",
        environment=environment,
        run_id=run_id,
        attempt=attempt,
        read=_bounded_process_read,
    )


def selected(scope: str) -> set[str]:
    return _contract.selected(scope, services=SERVICES, require=require)


def validate(receipt: dict, *, environment: str, sha: str, service: str) -> str | None:
    return _contract.validate(
        receipt,
        environment=environment,
        sha=sha,
        service=service,
        repository=REPOSITORY,
        lanes=LANES,
        services=SERVICES,
        require=require,
        validate_serving_provenance=_provenance.validate_serving_provenance,
    )


def unpack(archive: bytes, digest: str) -> dict:
    return _contract.unpack(archive, digest, max_bytes=MAX_BYTES, require=require)


class GitHub:
    def __init__(self) -> None:
        self.deadline = time.monotonic() + 180
        self.cache: dict[str, object] = {}

    def read(self, path: str, *, binary: bool = False):
        if path in self.cache:
            return self.cache[path]
        remaining = self.deadline - time.monotonic()
        require(remaining > 0, "Acceptance lookup exceeded its bounded duration")
        result = bounded_github_read(path, min(30, remaining))
        value = result if binary else json.loads(result)
        self.cache[path] = value
        return value

    def read_repository(self, path: str):
        key = "repository:" + path
        if key in self.cache:
            return self.cache[key]
        remaining = self.deadline - time.monotonic()
        require(remaining > 0, "Acceptance lookup exceeded its bounded duration")
        value = json.loads(
            _bounded_process_read(
                ["gh", "api", f"repos/{REPOSITORY}/{path}"], min(30, remaining)
            )
        )
        self.cache[key] = value
        return value

    def _durable_receipt(self, pin: dict, environment: str) -> tuple[dict, str]:
        return _contract.durable_receipt(
            pin,
            environment,
            read_repository=self.read_repository,
            repository=REPOSITORY,
            require=require,
            decode_tag_message_with_bytes=decode_tag_message_with_bytes,
            verify_durable_attempt_attestation=verify_durable_attempt_attestation,
        )

    def _receipt(self, pin: dict, environment: str) -> tuple[dict, dict, dict]:
        run_id, attempt, artifact_id = (
            pin.get(key) for key in ("run_id", "run_attempt", "artifact_id")
        )
        require(
            type(run_id) is int
            and run_id > 0
            and type(attempt) is int
            and attempt > 0
            and (
                (type(artifact_id) is int and artifact_id > 0)
                or (environment in {"dev", "uat"} and isinstance(pin.get("durable_tag"), str))
            ),
            "Invalid acceptance pin",
        )
        run = self.read(f"runs/{run_id}/attempts/{attempt}")
        require(
            run.get("id") == run_id
            and run.get("run_attempt") == attempt
            and run.get("path") == f".github/workflows/deploy-{environment}.yml"
            and run.get("head_branch") == "main"
            and run.get("event") == "workflow_dispatch"
            and run.get("status") == "completed"
            and run.get("conclusion") == "success"
            and run.get("repository", {}).get("full_name") == REPOSITORY
            and run.get("head_repository", {}).get("full_name") == REPOSITORY,
            "Acceptance did not come from a successful governed attempt",
        )
        if environment in {"dev", "uat"} and isinstance(pin.get("durable_tag"), str):
            receipt, digest = self._durable_receipt(pin, environment)
            require(
                receipt.get("run_id") == run_id and receipt.get("run_attempt") == attempt,
                f"Durable {environment.upper()} receipt belongs to another attempt",
            )
            return run, {"id": None, "digest": "sha256:" + digest}, receipt
        artifact = self.read(f"artifacts/{artifact_id}")
        _provenance.validate_artifact(artifact, pin, environment, MAX_BYTES)
        receipt = unpack(self.read(f"artifacts/{artifact_id}/zip", binary=True), artifact["digest"])
        require(
            receipt.get("run_id") == run_id and receipt.get("run_attempt") == attempt,
            "Receipt belongs to another attempt",
        )
        return run, artifact, receipt

    def accept(self, pin: dict, environment: str, sha: str, service: str) -> dict:
        run, artifact, receipt = self._receipt(pin, environment)
        run_id, attempt, artifact_id = (
            pin.get(key) for key in ("run_id", "run_attempt", "artifact_id")
        )
        image_reference = validate(
            receipt, environment=environment, sha=sha, service=service
        )
        if "image_reference" in pin:
            require(
                pin["image_reference"] == image_reference,
                "Acceptance image pin differs from its receipt",
            )
        if environment == "uat":
            predecessor = receipt.get("predecessor", {})
            require(
                predecessor.get("environment") == "dev"
                and predecessor.get("sha") == sha
                and predecessor.get("status") == "accepted",
                "UAT has no exact-SHA dev acceptance",
            )
            previous = predecessor.get("services", {}).get(service)
            require(isinstance(previous, dict), "UAT has no dev receipt for this service")
            self.accept(previous, "dev", sha, service)
        accepted = {
            "run_id": run_id,
            "run_attempt": attempt,
            "artifact_id": artifact_id,
            "artifact_digest": artifact["digest"],
            "workflow": run["path"],
            "repository": REPOSITORY,
            **({"image_reference": image_reference} if image_reference is not None else {}),
        }
        if pin.get("durable_tag"):
            accepted["durable_tag"] = pin["durable_tag"]
        return accepted

    def accepted_application(self, pin: dict, environment: str) -> dict:
        """Inspect a pinned receipt without conflating its Main workflow SHA.

        This is historical acceptance only. A current-state caller must also
        bind the latest relevant deployment and the current run attempt.
        """
        sha, services = _provenance.application_scope(
            self._receipt(pin, environment)[2]
        )
        return {
            "sha": sha,
            "services": {
                service: self.accept(pin, environment, sha, service)
                for service in services
            },
        }

    def find(self, environment: str, sha: str, scope: str) -> dict:
        needed, accepted = selected(scope), {}
        # Bounded historical search; an expired or missing receipt never becomes
        # an exemption. Re-run acceptance on the exact SHA when history is absent.
        for page in range(1, 4):
            runs = self.read(
                f"workflows/deploy-{environment}.yml/runs?branch=main&event=workflow_dispatch"
                f"&per_page=50&page={page}"
            ).get("workflow_runs", [])
            for run in runs:
                for pin in self.attempt_pins(environment, run.get("id"), require_durable=True):
                    for service in sorted(needed - accepted.keys()):
                        try:
                            accepted[service] = self.accept(pin, environment, sha, service)
                        except (Refused, InvalidAttemptReceipt):
                            # Qualification belongs to this immutable attempt,
                            # not to the latest rerun's status or service scope.
                            continue
                    if needed <= accepted.keys():
                        return {
                            "status": "accepted",
                            "environment": environment,
                            "sha": sha,
                            "services": accepted,
                        }
            if len(runs) < 50:
                break
        raise MissingAcceptance(
            "No complete healthy predecessor receipt for this exact SHA and resolved services"
        )

    def attempt_pins(
        self, environment: str, run_id: int, *, require_durable: bool = False
    ) -> list[dict]:
        require(environment in {"dev", "uat"}, "Unsupported acceptance environment")
        require(type(run_id) is int and run_id > 0, "Invalid acceptance run")
        pins: dict[int, dict] = {}
        durable_tags: dict[int, str] = {}
        if not require_durable:
            inventory = self.read(f"runs/{run_id}/artifacts?per_page=100")
            artifacts = _provenance.bounded_artifact_inventory(inventory)
            pattern = rf"release-acceptance-{re.escape(environment)}-{run_id}-([1-9][0-9]*)"
            for item in artifacts:
                match = re.fullmatch(pattern, item.get("name", ""))
                if match is None:
                    continue
                attempt = int(match[1])
                require(attempt not in pins, "Acceptance artifact is ambiguous")
                if item.get("expired") is not True:
                    pins[attempt] = {
                        "run_id": run_id,
                        "run_attempt": attempt,
                        "artifact_id": item.get("id"),
                    }

        if environment in {"dev", "uat"}:
            tag_prefix = attempt_tag_prefix(environment)
            refs = self.read_repository(
                f"git/matching-refs/tags/{tag_prefix}/{run_id}-"
            )
            require(isinstance(refs, list), f"Durable {environment.upper()} tag inventory is malformed")
            tag_pattern = rf"refs/tags/{re.escape(tag_prefix)}/{run_id}-([1-9][0-9]*)"
            for ref in refs:
                if not isinstance(ref, dict):
                    continue
                match = re.fullmatch(tag_pattern, str(ref.get("ref", "")))
                if match is None or ref.get("object", {}).get("type") != "tag":
                    continue
                attempt = int(match[1])
                object_sha = ref.get("object", {}).get("sha")
                if re.fullmatch(r"[a-f0-9]{40}", str(object_sha or "")) is None:
                    continue
                try:
                    tag = self.read_repository(f"git/tags/{object_sha}")
                    if tag.get("tag") != ref["ref"].removeprefix("refs/tags/"):
                        continue
                    if tag.get("object", {}).get("type") != "commit":
                        continue
                    decode_tag_message(
                        str(tag.get("message", "")),
                        tag_name=tag["tag"],
                        tag_target_sha=str(tag["object"].get("sha", "")),
                        run_id=run_id,
                        attempt=attempt,
                        repository=REPOSITORY,
                        kind="full",
                        environment=environment,
                    )
                except (Refused, InvalidAttemptReceipt, KeyError, TypeError):
                    continue
                require(attempt not in durable_tags, f"Durable {environment.upper()} attempt tag is ambiguous")
                durable_tags[attempt] = tag["tag"]
            for attempt, tag_name in durable_tags.items():
                pin = pins.get(attempt, {"run_id": run_id, "run_attempt": attempt})
                pin["durable_tag"] = tag_name
                pins[attempt] = pin
        if require_durable:
            pins = {attempt: pin for attempt, pin in pins.items() if pin.get("durable_tag")}
        return [pins[attempt] for attempt in sorted(pins, reverse=True)]


def bounded_github_read(
    path: str, timeout: float, *, allow_escape_sequences: bool = False
) -> bytes:
    """Bound CLI capability discovery and the read within one total deadline."""
    end = time.monotonic() + timeout
    arguments = ["gh", "api"]
    if allow_escape_sequences:
        require(
            bool(re.fullmatch(r"jobs/[1-9][0-9]*/logs", path)),
            "Raw escapes require an exact job log",
        )
        help_text = _bounded_process_read(["gh", "api", "--help"], min(timeout, 5))
        if b"--allow-escape-sequences" in help_text:
            arguments.append("--allow-escape-sequences")
    arguments.append(f"repos/{REPOSITORY}/actions/{path}")
    remaining = end - time.monotonic()
    require(remaining > 0, "GitHub response timed out")
    return _bounded_process_read(arguments, remaining)


def _bounded_process_read(arguments: list[str], timeout: float) -> bytes:
    """Bound bytes and lifetime and always reap this owned CLI child."""
    try:
        return _process_group.bounded_stdout(arguments, max_bytes=2 * MAX_BYTES, timeout=timeout)
    except _process_group.BoundedReadError as error:
        message = {
            "size": "GitHub response exceeds its bound",
            "timeout": "GitHub response timed out",
        }.get(error.reason, "GitHub lookup failed")
        raise Refused(message) from None
    except OSError:
        raise Refused("GitHub lookup failed") from None


def create(args) -> None:
    release = json.loads(args.status.read_text())
    if release.get("status") != "healthy":
        return
    receipt = {
        "schema_version": 1,
        "repository": os.environ["GITHUB_REPOSITORY"],
        "workflow": f".github/workflows/deploy-{args.environment}.yml",
        "run_id": int(os.environ["GITHUB_RUN_ID"]),
        "run_attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
        "environment": args.environment,
        "target": os.environ.get("DEV_TARGET", "shared-dev")
        if args.environment == "dev"
        else "uat",
        "resolved_services": sorted(selected(release["scope"])),
        "release": release,
        "provenance": {},
    }
    try:
        require(
            os.environ.get("GITHUB_REF") == "refs/heads/main",
            "Acceptance must use the main-owned workflow",
        )
        receipt["required_checks"] = _required_checks(release, args.environment)
        receipt["classification"] = json.loads(
            (args.status.parent / f"{args.environment}-release-classification.json").read_text()
        )
        for service in receipt["resolved_services"]:
            receipt["provenance"][service] = json.loads(
                (args.status.parent / f"{args.environment}-{service}-provenance.json").read_text()
            )
            validate(
                receipt,
                environment=args.environment,
                sha=release["sha"],
                service=service,
            )
        if args.environment == "uat":
            require(args.predecessor is not None, "Dev acceptance is missing")
            receipt["predecessor"] = json.loads(args.predecessor.read_text())
            prior = receipt["predecessor"]
            require(
                prior.get("status") == "accepted"
                and prior.get("environment") == "dev"
                and prior.get("sha") == release["sha"]
                and set(receipt["resolved_services"]) <= prior.get("services", {}).keys(),
                "Dev acceptance is missing",
            )
    except (Refused, OSError, ValueError):
        release["status"] = "blocked"
        args.status.write_text(json.dumps(release, indent=2) + "\n")
        raise
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, sort_keys=True, indent=2) + "\n")


def pinned_backend_image(args) -> dict:
    require(
        args.environment == "dev" and args.predecessor is not None,
        "Backend image promotion requires the accepted Dev predecessor",
    )
    predecessor = json.loads(args.predecessor.read_text())
    require(
        predecessor.get("status") == "accepted"
        and predecessor.get("environment") == "dev"
        and predecessor.get("sha") == args.sha,
        "Backend image predecessor identity is invalid",
    )
    pin = predecessor.get("services", {}).get("backend")
    require(isinstance(pin, dict), "Backend acceptance pin is missing")
    return GitHub().accept(pin, "dev", args.sha, "backend")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("create", "require", "backend-image"))
    parser.add_argument("--environment", choices=tuple(LANES), required=True)
    parser.add_argument("--sha")
    parser.add_argument("--scope")
    parser.add_argument("--status", type=Path)
    parser.add_argument("--predecessor", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.command == "create":
            require(args.status is not None, "Status receipt is required")
            create(args)
        else:
            require(
                args.sha is not None and re.fullmatch(r"[a-f0-9]{40}", args.sha) is not None,
                "Full SHA is required",
            )
            receipt = (
                pinned_backend_image(args)
                if args.command == "backend-image"
                else GitHub().find(args.environment, args.sha, args.scope)
            )
            args.output.write_text(json.dumps(receipt, sort_keys=True, indent=2) + "\n")
    except (
        Refused,
        OSError,
        ValueError,
        TypeError,
        KeyError,
        BadZipFile,
        subprocess.SubprocessError,
    ) as exc:
        # No tokens, download URLs, stdout or response content in failure reports.
        print(
            f"Predecessor acceptance refused: {exc if isinstance(exc, Refused) else type(exc).__name__}"
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

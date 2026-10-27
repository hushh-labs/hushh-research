#!/usr/bin/env python3
"""Exact application-SHA acceptance between governed deployment environments.

GitHub supplies workflow/attempt and artifact integrity. Existing release and
live-traffic provenance receipts supply application identity and health. A later
deployment does not invalidate historical acceptance, but a different merge SHA
always needs its own acceptance. This helper never changes cloud resources.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
from io import BytesIO
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import time
from zipfile import BadZipFile, ZipFile

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
assert _PROVENANCE_SPEC and _PROVENANCE_SPEC.loader
_provenance = importlib.util.module_from_spec(_PROVENANCE_SPEC)
_PROVENANCE_SPEC.loader.exec_module(_provenance)
Refused = _provenance.Refused
require = _provenance.require
_required_checks = _provenance.required_checks


class MissingAcceptance(Refused):
    """No retained healthy receipts cover the requested services yet."""


def selected(scope: str) -> set[str]:
    require(
        scope in {"all", "backend", "frontend"}, "Resolved deployment scope is required"
    )
    return set(SERVICES) if scope == "all" else {scope}


def validate(receipt: dict, *, environment: str, sha: str, service: str) -> str | None:
    """Validate one service without treating another scoped service as accepted."""
    require(
        re.fullmatch(r"[a-f0-9]{40}", sha) is not None,
        "A full application SHA is required",
    )
    require(
        receipt.get("schema_version") == 1
        and receipt.get("environment") == environment
        and receipt.get("repository") == REPOSITORY
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
    return _validate_serving_provenance(
        receipt, environment=environment, sha=sha, service=service, revision=revision
    )


def _validate_serving_provenance(
    receipt: dict, *, environment: str, sha: str, service: str, revision: str
) -> str | None:
    return _provenance.validate_serving_provenance(
        receipt,
        environment=environment,
        sha=sha,
        service=service,
        revision=revision,
        project=LANES[environment],
        service_name=SERVICES[service],
    )


def unpack(archive: bytes, digest: str) -> dict:
    require(len(archive) <= MAX_BYTES, "Acceptance artifact exceeds its bound")
    require(
        digest == "sha256:" + hashlib.sha256(archive).hexdigest(),
        "Artifact digest mismatch",
    )
    with ZipFile(BytesIO(archive)) as bundle:
        entries = bundle.infolist()
        require(
            len(entries) == 1
            and entries[0].filename == "acceptance.json"
            and entries[0].file_size <= MAX_BYTES
            and not entries[0].is_dir(),
            "Acceptance artifact shape is invalid",
        )
        result = json.loads(bundle.read(entries[0]))
    require(isinstance(result, dict), "Acceptance must be an object")
    return result


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

    def _receipt(self, pin: dict, environment: str) -> tuple[dict, dict, dict]:
        run_id, attempt, artifact_id = (
            pin.get(key) for key in ("run_id", "run_attempt", "artifact_id")
        )
        require(
            all(
                type(value) is int and value > 0
                for value in (run_id, attempt, artifact_id)
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
        artifact = self.read(f"artifacts/{artifact_id}")
        _provenance.validate_artifact(artifact, pin, environment, MAX_BYTES)
        receipt = unpack(
            self.read(f"artifacts/{artifact_id}/zip", binary=True), artifact["digest"]
        )
        require(
            receipt.get("run_id") == run_id and receipt.get("run_attempt") == attempt,
            "Receipt belongs to another attempt",
        )
        return run, artifact, receipt

    def accept(self, pin: dict, environment: str, sha: str, service: str) -> dict:
        run, artifact, receipt = self._receipt(pin, environment)
        run_id, attempt, artifact_id = (
            pin[key] for key in ("run_id", "run_attempt", "artifact_id")
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
            require(
                isinstance(previous, dict), "UAT has no dev receipt for this service"
            )
            self.accept(previous, "dev", sha, service)
        return {
            "run_id": run_id,
            "run_attempt": attempt,
            "artifact_id": artifact_id,
            "artifact_digest": artifact["digest"],
            "workflow": run["path"],
            "repository": REPOSITORY,
            **(
                {"image_reference": image_reference}
                if image_reference is not None
                else {}
            ),
        }

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
                for pin in self.attempt_pins(environment, run.get("id")):
                    for service in sorted(needed - accepted.keys()):
                        try:
                            accepted[service] = self.accept(
                                pin, environment, sha, service
                            )
                        except Refused:
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

    def attempt_pins(self, environment: str, run_id: int) -> list[dict]:
        require(type(run_id) is int and run_id > 0, "Invalid acceptance run")
        inventory = self.read(f"runs/{run_id}/artifacts?per_page=100")
        require(
            inventory.get("total_count", 0) <= 100, "Artifact inventory is incomplete"
        )
        pins = {}
        pattern = rf"release-acceptance-{re.escape(environment)}-{run_id}-([1-9][0-9]*)"
        for item in inventory.get("artifacts", []):
            match = re.fullmatch(pattern, item.get("name", ""))
            if match is None:
                continue
            attempt = int(match[1])
            require(attempt not in pins, "Acceptance artifact is ambiguous")
            pins[attempt] = {
                "run_id": run_id,
                "run_attempt": attempt,
                "artifact_id": item.get("id"),
            }
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
    with subprocess.Popen(
        arguments,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    ) as process:
        try:
            end, output = time.monotonic() + timeout, bytearray()
            with selectors.DefaultSelector() as ready:
                ready.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = end - time.monotonic()
                    require(remaining > 0, "GitHub response timed out")
                    require(bool(ready.select(remaining)), "GitHub response timed out")
                    chunk = os.read(process.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    output.extend(chunk)
                    require(
                        len(output) <= 2 * MAX_BYTES,
                        "GitHub response exceeds its bound",
                    )
            require(
                process.wait(timeout=max(0.1, end - time.monotonic())) == 0,
                "GitHub lookup failed",
            )
            return bytes(output)
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)


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
            (
                args.status.parent / f"{args.environment}-release-classification.json"
            ).read_text()
        )
        for service in receipt["resolved_services"]:
            receipt["provenance"][service] = json.loads(
                (
                    args.status.parent / f"{args.environment}-{service}-provenance.json"
                ).read_text()
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
                and set(receipt["resolved_services"])
                <= prior.get("services", {}).keys(),
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
                args.sha is not None
                and re.fullmatch(r"[a-f0-9]{40}", args.sha) is not None,
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

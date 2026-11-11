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
import json
import os
import re
import runpy
import subprocess
import time
from tempfile import TemporaryDirectory
from io import BytesIO
from pathlib import Path
from zipfile import BadZipFile, ZipFile

REPOSITORY = "hushh-labs/hushh-research"
LANES = {"dev": "hushh-pda-dev", "uat": "hushh-pda-uat"}
SERVICES = {"backend": "consent-protocol", "frontend": "hushh-webapp"}
MAX_BYTES = 1024 * 1024
RECORDED_RECOVERY_SHA = "84b80bcab6b5b7a4de21a5a992d3c969dacba5b9"
RECORDED_RECOVERY_UAT = {"run_id": 40736875956, "run_attempt": 1, "artifact_id": 12840002854}
RECORDED_RECOVERY_UAT_DIGEST = "sha256:d45488c50a7fb5f844d69f794c57a74334db5a48bff5d63578a06350ab68f71d"


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


class MissingAcceptance(Refused):
    """No retained healthy receipts cover the requested services yet."""


def selected(scope: str) -> set[str]:
    require(scope in {"all", "backend", "frontend"}, "Resolved deployment scope is required")
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
        and all(verification.get(key) == "true" for key in ("parity_success", "provenance_success"))
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
            all(type(value) is int and value > 0 for value in (run_id, attempt, artifact_id)),
            "Invalid acceptance pin",
        )
        run = self.read(f"runs/{run_id}/attempts/{attempt}")
        require(
            run.get("id") == run_id
            and run.get("run_attempt") == attempt
            and run.get("path") == f".github/workflows/deploy-{environment}.yml"
            and run.get("head_branch") in {"main", environment}
            and run.get("event") == "workflow_dispatch"
            and run.get("status") == "completed"
            and run.get("conclusion") == "success"
            and run.get("repository", {}).get("full_name") == REPOSITORY
            and run.get("head_repository", {}).get("full_name") == REPOSITORY,
            "Acceptance did not come from a successful governed attempt",
        )
        artifact = self.read(f"artifacts/{artifact_id}")
        _provenance.validate_artifact(artifact, pin, environment, MAX_BYTES)
        receipt = unpack(self.read(f"artifacts/{artifact_id}/zip", binary=True), artifact["digest"])
        authority = _provenance.deployment_authority(run, environment)
        if authority["caller_branch"] != "main":
            require(receipt.get("workflow_authority") == authority,
                    "Acceptance implementation provenance does not match GitHub")
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
            if predecessor.get("kind") == "uat-exact-ci":
                authority = _provenance.deployment_authority(run, environment)
                require(predecessor.get("authority_sha") == authority["tooling_sha"], "UAT workflow authority changed")
                _verify_direct_uat(predecessor, sha, {service}, current=False)
            else:
                self._accept_dev_predecessor(predecessor, sha, service)
        return {
            "run_id": run_id,
            "run_attempt": attempt,
            "artifact_id": artifact_id,
            "artifact_digest": artifact["digest"],
            "workflow": run["path"],
            "repository": REPOSITORY,
            **({"image_reference": image_reference} if image_reference is not None else {}),
        }

    def _accept_dev_predecessor(self, predecessor: dict, sha: str, service: str) -> None:
        _validate_dev_predecessor(predecessor, sha, {service})
        previous = predecessor.get("services", {}).get(service)
        require(isinstance(previous, dict), "UAT has no dev receipt for this service")
        self.accept(previous, "dev", sha, service)

    def accept_testflight_backend(
        self, *, sha: str, run_id: int, revision: str, image_digest: str,
        source_branch: str = "uat-isolated",
    ) -> dict:
        """Bind an exact UAT release receipt to the backend currently serving TestFlight."""
        require(source_branch in {"uat", "uat-isolated"}, "Unknown protected UAT source")
        run = self.read(f"runs/{run_id}")
        attempt = run.get("run_attempt")
        require(
            run.get("id") == run_id and type(attempt) is int and attempt > 0
            and run.get("status") == "completed" and run.get("conclusion") == "success",
            "Current UAT deployment attempt is not successful",
        )
        pin = next((pin for pin in self.attempt_pins("uat", run_id) if pin["run_attempt"] == attempt), None)
        require(pin is not None, "Current UAT acceptance artifact is missing")
        _, _, receipt = self._receipt(pin, "uat")
        prior = receipt.get("predecessor", {})
        require(
            prior.get("kind") == "uat-exact-ci" and prior.get("source_branch", "uat") == source_branch,
            "TestFlight requires acceptance for the requested protected UAT source",
        )
        accepted = self.accept(pin, "uat", sha, "backend")
        require(
            bool(revision) and receipt["release"]["final"]["backend_revision"] == revision
            and bool(accepted.get("image_reference"))
            and accepted["image_reference"].rsplit("@", 1)[-1] == image_digest,
            "Serving UAT backend does not match the accepted revision and image",
        )
        return {**accepted, "base_sha": prior["base_sha"], "authority_sha": prior["authority_sha"]}

    def accepted_application(self, pin: dict, environment: str) -> dict:
        """Inspect a pinned receipt without conflating its Main workflow SHA.

        This is historical acceptance only. A current-state caller must also
        bind the latest relevant deployment and the current run attempt.
        """
        receipt = self._receipt(pin, environment)[2]
        sha, services = _provenance.application_scope(receipt)
        return {
            "sha": sha,
            "services": {
                service: self.accept(pin, environment, sha, service)
                for service in services
            },
            "revisions": {
                service: receipt["release"]["final"][f"{service}_revision"]
                for service in services
            },
        }

    def recorded_recovery_uat(self, sha: str, scope: str) -> dict:
        require(sha == RECORDED_RECOVERY_SHA, "Recorded recovery UAT requires the sealed source")
        accepted = {}
        # This reviewed receipt lies outside bounded discovery. Read and verify
        # the exact attempt, archive, services and Dev predecessor as usual.
        for service in sorted(selected(scope)):
            receipt = self.accept(RECORDED_RECOVERY_UAT, "uat", sha, service)
            require(receipt["artifact_digest"] == RECORDED_RECOVERY_UAT_DIGEST,
                    "Recorded recovery UAT artifact digest changed")
            accepted[service] = receipt
        return {"status": "accepted", "environment": "uat", "sha": sha, "services": accepted}

    def find(self, environment: str, sha: str, scope: str) -> dict:
        needed, accepted = selected(scope), {}
        # Bounded historical search; an expired or missing receipt never becomes
        # an exemption. Re-run acceptance on the exact SHA when history is absent.
        for page in range(1, 4):
            runs = self.read(
                f"workflows/deploy-{environment}.yml/runs?event=workflow_dispatch"
                f"&per_page=50&page={page}"
            ).get("workflow_runs", [])
            for run in runs:
                for pin in self.attempt_pins(environment, run.get("id")):
                    for service in sorted(needed - accepted.keys()):
                        try:
                            accepted[service] = self.accept(pin, environment, sha, service)
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
        artifacts = _provenance.bounded_artifact_inventory(inventory)
        pins = {}
        pattern = rf"release-acceptance-{re.escape(environment)}-{run_id}-([1-9][0-9]*)"
        for item in artifacts:
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
        if os.environ.get("GITHUB_REF") != "refs/heads/main":
            run = GitHub().read(f"runs/{receipt['run_id']}")
            authority = _provenance.deployment_authority(run, args.environment)
            require(
                os.environ.get("GITHUB_REF") == f"refs/heads/{args.environment}"
                and run.get("run_attempt") == receipt["run_attempt"]
                and run.get("status") == "in_progress"
                and authority["caller_sha"] == os.environ.get("GITHUB_SHA")
                and authority["tooling_sha"] == os.environ.get("RELEASE_TOOLING_SHA"),
                "Acceptance must use the current Main implementation and caller attempt",
            )
            receipt["workflow_authority"] = authority
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
            if prior.get("kind") == "uat-exact-ci":
                _provenance.validate_uat_ci_predecessor(prior, release["sha"], set(receipt["resolved_services"]))
            else:
                _validate_dev_predecessor(prior, release["sha"], set(receipt["resolved_services"]))
    except (Refused, OSError, ValueError):
        release["status"] = "blocked"
        args.status.write_text(json.dumps(release, indent=2) + "\n")
        raise
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, sort_keys=True, indent=2) + "\n")


def _validate_dev_predecessor(prior: dict, sha: str, services: set[str]):
    require(prior.get("kind") is None and prior.get("status") == "accepted"
            and prior.get("environment") == "dev" and prior.get("sha") == sha
            and services <= prior.get("services", {}).keys(), "Dev acceptance is missing")


def _verify_direct_uat(prior: dict, sha: str, services: set[str], *, current: bool):
    _provenance.validate_uat_ci_predecessor(prior, sha, services)
    import uat_exact_ci as exact
    try:
        exact.verify_predecessor(prior, current=current)
    except exact.Refused as error:
        raise Refused(str(error)) from None


def direct_uat(args) -> dict:
    import uat_exact_ci as exact
    try:
        return exact.issue_predecessor(args)
    except exact.Refused as error:
        raise Refused(str(error)) from None


def main_source(args) -> dict:
    """Qualify protected Main directly; UAT receipts remain a separate image source."""
    require(args.environment == "production", "Main qualification is production-only")
    require(re.fullmatch(r"[a-f0-9]{40}", args.sha or "") is not None,
            "Full application SHA is required")
    approval = getattr(args, "approval_sha", "") or args.sha
    require(re.fullmatch(r"[a-f0-9]{40}", approval) is not None,
            "Full Main approval SHA is required")
    scope = selected(args.scope)
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        token = subprocess.check_output(["gh", "auth", "token"], text=True, timeout=20).strip()
    require(bool(token), "GitHub qualification credential is unavailable")
    env = dict(os.environ, GITHUB_REPOSITORY=REPOSITORY, GITHUB_TOKEN=token,
               REQUIRED_BRANCH="main", REQUIRE_CI_SUCCESS="1")
    recovery = runpy.run_path(str(Path(__file__).with_name("production_recovery_ci.py")))

    # The sealed recovery source has dedicated two-SHA functional evidence.
    # Every source still requires separate Main smoke, including this recovery.
    proofs = {}
    with TemporaryDirectory(prefix="hussh-main-qualification-") as directory:
        for kind, sha, checks in (
            ("functional", args.sha, "CI Status Gate,Queue Validation,Branch Validation Gate"),
            ("smoke", approval, "Main Post-Merge Smoke Gate"),
        ):
            if kind == "functional" and sha == recovery["ACTIVE_ANCHOR_PRIMARY_SOURCE"]:
                require(approval == sha, "Recorded recovery requires smoke on its exact application")
                try:
                    proofs[kind] = recovery["qualification"](GitHub(), sha)
                except recovery["Refused"] as error:
                    raise Refused(str(error)) from None
                continue
            output = Path(directory) / f"{kind}.json"
            result = subprocess.run(
                ["bash", str(Path(__file__).with_name("require-deploy-sha-on-main.sh")), sha],
                env=dict(env, REQUIRED_CHECK_NAME=checks, DEPLOY_SHA_EVIDENCE_OUTPUT=str(output),
                         REQUIRE_LATEST_FUNCTIONAL_CI="1" if kind == "functional" else "0"),
                capture_output=True, text=True, timeout=180, check=False,
            )
            require(result.returncode == 0, f"Main {kind} qualification is missing or superseded")
            proof = json.loads(output.read_text())
            require(proof.get("repository") == REPOSITORY and proof.get("sha") == sha
                    and proof.get("source_branch") == "main" and bool(proof.get("checks")),
                    "Main qualification evidence is incomplete")
            proofs[kind] = proof
        mapping = None
        if approval != args.sha:
            import promotion_approval
            mapping = promotion_approval.verify(args.sha, approval)
    # Re-read the combined evidence after both independent gates complete.
    # Hashes retain only source/run metadata, never GitHub response bodies.
    client = GitHub()
    for proof in proofs.values():
        reads = proof.get("authority_reads")
        require(isinstance(reads, dict) and bool(reads), "Main authority recheck is unavailable")
        for path, expected in reads.items():
            require(isinstance(path, str) and path.startswith(("runs/", "workflows/")),
                    "Main authority read left its bounded Actions owner")
            current = client.read(path)
            digest = hashlib.sha256(json.dumps(current, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            require(digest == expected, "Main qualification changed during verification")
    record = {
        "schema_version": 1, "kind": "main-qualified-source", "status": "qualified",
        "repository": REPOSITORY, "environment": "production", "sha": args.sha,
        "main_approval_sha": approval, "resolved_services": sorted(scope),
        "qualification": proofs, "application_approval": mapping,
    }
    prior = getattr(args, "predecessor", None)
    if prior is not None:
        require(json.loads(prior.read_text()) == record,
                "Main qualification changed after release admission")
    return record


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
    parser.add_argument("command", choices=("create", "require", "backend-image", "direct-uat", "testflight-uat", "main-source"))
    parser.add_argument("--environment", choices=(*LANES, "production"), required=True)
    parser.add_argument("--sha")
    parser.add_argument("--scope")
    parser.add_argument("--status", type=Path)
    parser.add_argument("--predecessor", type=Path)
    parser.add_argument("--base-sha")
    parser.add_argument("--authority-sha")
    parser.add_argument("--approval-sha", default="")
    parser.add_argument("--source-branch", choices=("uat", "uat-isolated"))
    parser.add_argument("--backend-base-sha", default="")
    parser.add_argument("--frontend-base-sha", default="")
    parser.add_argument("--backend-base-revision", default="")
    parser.add_argument("--frontend-base-revision", default="")
    parser.add_argument("--ci-run-id", type=int)
    parser.add_argument("--ci-attempt", type=int)
    parser.add_argument("--deployment-run-id", type=int)
    parser.add_argument("--serving-revision")
    parser.add_argument("--serving-image")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--recorded-recovery-uat", action="store_true")
    args = parser.parse_args()
    try:
        require(args.command == "main-source" or args.environment in LANES,
                "Production uses Main qualification, not an environment acceptance receipt")
        require(not args.recorded_recovery_uat or
                (args.command == "require" and args.environment == "uat"),
                "Recorded recovery acceptance is only available for UAT")
        if args.command == "create":
            require(args.status is not None, "Status receipt is required")
            create(args)
        else:
            require(
                args.sha is not None and re.fullmatch(r"[a-f0-9]{40}", args.sha) is not None,
                "Full SHA is required",
            )
            if args.command == "main-source":
                receipt = main_source(args)
            elif args.command == "testflight-uat":
                require(args.environment == "uat" and (args.deployment_run_id or 0) > 0,
                        "TestFlight requires the live UAT deployment run")
                receipt = GitHub().accept_testflight_backend(
                    sha=args.sha, run_id=args.deployment_run_id,
                    revision=args.serving_revision, image_digest=args.serving_image,
                    source_branch=args.source_branch or "uat-isolated",
                )
            elif args.command == "direct-uat":
                args.source_branch = args.source_branch or "uat"
                receipt = direct_uat(args)
            elif args.command == "backend-image":
                receipt = pinned_backend_image(args)
            elif args.recorded_recovery_uat:
                receipt = GitHub().recorded_recovery_uat(args.sha, args.scope)
            else:
                receipt = GitHub().find(args.environment, args.sha, args.scope)
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

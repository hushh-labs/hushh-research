"""Bounded frozen capacity contracts shared by the existing maintenance owner.

No deployment entrypoint or authority is introduced here. The caller owns the
lock, healthy-release proof, native inventory, durable intent and provider write.
"""

from __future__ import annotations
import copy
from datetime import datetime
import hashlib
import importlib
import json
from pathlib import Path
import tempfile
import release_artifact_receipts

retention = importlib.import_module("cloudrun-retention")

LEGACY_PROFILE = "serving_backend_clone_v1"
PROFILE = "serving_backend_clone_v2"
RECOVERY_PROFILE = "serving_backend_clone_v3"
FROZEN_IMAGE = "gcr.io/hushh-pda/consent-protocol@sha256:ae6f7753329960b687a74aea4b357f214e81b65549f409607a2b2076248b1353"
RECOVERY_SOURCE = "consent-protocol-00280-toz"
RECOVERY_SOURCE_SPEC = (
    "c59693134296bcd9fa9cebe2cb7b572eb7f1fc4d82a584c7aadca4146bf21049"
)
RECOVERY_FAILED_REVISION = "consent-protocol-00283-ges"
RECOVERY_FAILED_SPEC = (
    "e63d610b70ddc8d289a856406df735061f27808c70cd62e765e63ec50ddaabdd"
)
RECOVERY_RECEIPT = {
    "run_id": 40050081063,
    "run_attempt": 2,
    "artifact_id": 12546383890,
    "artifact_digest": "sha256:01d172150b81bfcf9db5775ccd72bd97faa0a934f463e7b1ee2a752cbd317bbd",
    "revision": RECOVERY_FAILED_REVISION,
    "spec_fingerprint": RECOVERY_FAILED_SPEC,
    "reserved_workers": 2,
}
SERVICE = "consent-protocol"
PROJECT = "hushh-pda"
REGION = "us-central1"
POOLS = {
    "DB_POOL_MIN_SIZE": "2",
    "DB_POOL_MAX_SIZE": "2",
    "DB_SQLALCHEMY_POOL_SIZE": "2",
    "DB_SQLALCHEMY_MAX_OVERFLOW": "0",
}
BOOTSTRAP_POOLS = {**POOLS, "DB_POOL_MIN_SIZE": "1", "DB_POOL_MAX_SIZE": "4"}


def fingerprint(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def traffic(service):
    targets = service.get("status", {}).get("traffic")
    if (
        not isinstance(targets, list)
        or sum(row.get("percent", 0) for row in targets) != 100
    ):
        raise retention.UnsafeState("Bridge traffic is ambiguous")
    return sorted(
        (row["revisionName"], row.get("percent", 0), row.get("tag", ""))
        for row in targets
    )


def bridge_revision_names(receipt):
    names = {receipt["revision"]}
    if receipt.get("predecessor"):
        names.add(receipt["predecessor"]["revision"])
    return names


def validate_receipt_extension(value, validate_receipt):
    if (value.get("profile") == RECOVERY_PROFILE) != (
        value.get("recovery") == RECOVERY_RECEIPT
    ):
        raise retention.UnsafeState("Invalid failed-candidate recovery receipt")
    retired = value.get("retiredPredecessor")
    if retired is not None:
        if (
            value.get("profile") != RECOVERY_PROFILE
            or value.get("retiredPredecessorObservation") != "verified_and_absent"
            or not isinstance(retired, dict)
            or retired.get("status") != "verified"
            or "retiredPredecessor" in retired
            or value.get("retiredPredecessorFingerprint") != fingerprint(retired)
            or retired.get("revision")
            in {
                value.get("revision"),
                value.get("sourceRevision"),
                value.get("displacedLatestRevision"),
            }
        ):
            raise retention.UnsafeState("Invalid retired bridge evidence")
        validate_receipt(retired)


def retired_bridge_transition(
    previous, service, source, source_hash, existing_names, create
):
    referenced_names = (
        existing_names
        | {name for name, _, _ in traffic(service)}
        | {
            service["status"].get("latestCreatedRevisionName"),
            service["status"].get("latestReadyRevisionName"),
        }
    )
    retired_predecessor = (
        copy.deepcopy(previous.get("retiredPredecessor")) if previous else None
    )
    if previous and (
        previous["sourceFingerprint"] != source_hash
        or previous["sourceRevision"] != source["metadata"]["name"]
    ):
        if (
            not create
            or source["metadata"]["name"] != RECOVERY_SOURCE
            or previous["status"] != "verified"
            or bridge_revision_names(previous) & referenced_names
            or previous.get("retiredPredecessor") is not None
        ):
            raise retention.UnsafeState(
                "Bridge source changed without proven completed retirement"
            )
        retired_predecessor = copy.deepcopy(previous)
        previous = None
    if (
        retired_predecessor
        and bridge_revision_names(retired_predecessor) & referenced_names
    ):
        raise retention.UnsafeState("Previously retired bridge reappeared")
    return previous, retired_predecessor


def configure_clone_launcher(source, container, env, maintenance_profile):
    pools = POOLS
    if maintenance_profile == RECOVERY_PROFILE:
        if (
            source["metadata"]["name"] != RECOVERY_SOURCE
            or fingerprint([source["spec"], source["status"]["imageDigest"]])
            != RECOVERY_SOURCE_SPEC
        ):
            raise retention.UnsafeState(
                "Recovery bridge requires the reviewed healthy source"
            )
        env = [row for row in env if row["name"] != "WEB_CONCURRENCY"] + [
            {"name": "WEB_CONCURRENCY", "value": "1"}
        ]
        pools = BOOTSTRAP_POOLS
    elif maintenance_profile == PROFILE:
        if (
            source["status"]["imageDigest"] != FROZEN_IMAGE
            or container.get("command")
            or container.get("args")
        ):
            raise retention.UnsafeState(
                "Bootstrap bridge requires the reviewed frozen image launcher"
            )
        if any(
            row["name"] == "WEB_CONCURRENCY" and row.get("value") != "2" for row in env
        ):
            raise retention.UnsafeState(
                "Bootstrap source worker declaration differs from the frozen launcher"
            )
        # The frozen image CMD hardcodes -w 2. An environment override alone
        # would undercount workers. Keep its exact options with one worker.
        container["command"] = ["gunicorn"]
        container["args"] = [
            "server:app",
            "-w",
            "1",
            "-c",
            "gunicorn.conf.py",
            "-k",
            "uvicorn.workers.UvicornWorker",
            "--timeout",
            "120",
            "--graceful-timeout",
            "8",
            "-b",
            "0.0.0.0:8080",
        ]
        env = [row for row in env if row["name"] != "WEB_CONCURRENCY"] + [
            {"name": "WEB_CONCURRENCY", "value": "1"}
        ]
        pools = BOOTSTRAP_POOLS
    elif maintenance_profile != LEGACY_PROFILE:
        raise retention.UnsafeState("Unknown bridge profile")
    return env, pools


def _failed_artifact(repository, read, run, expected):
    run_id = RECOVERY_RECEIPT["run_id"]

    def governed(current, *_):
        return all(current.get(k) == v for k, v in expected.items()) and all(
            (current.get(k) or {}).get("full_name") == repository
            for k in ("repository", "head_repository")
        )

    artifact = release_artifact_receipts.resolve_replayed_artifact(
        repository,
        run_id,
        f"prod-release-{run_id}",
        {
            "prefix": "prod",
            "deploy_job": "Deploy Production Scope",
            "upload_step": "Upload production deploy artifacts",
        },
        "production",
        api=lambda _repo, endpoint: read(endpoint),
        governed_dispatch=governed,
        timestamp=lambda value: datetime.fromisoformat(
            str(value).replace("Z", "+00:00")
        ),
    )
    if (
        artifact.get("id") != RECOVERY_RECEIPT["artifact_id"]
        or artifact.get("name") != f"prod-release-{run_id}"
        or artifact.get("digest") != RECOVERY_RECEIPT["artifact_digest"]
        or artifact.get("expired") is not False
        or any(
            (artifact.get("workflow_run") or {}).get(k) != v
            for k, v in {
                "id": run["id"],
                "head_sha": run["head_sha"],
                "head_branch": "main",
                "repository_id": (run.get("repository") or {}).get("id"),
                "head_repository_id": (run.get("head_repository") or {}).get("id"),
            }.items()
        )
    ):
        raise retention.UnsafeState("Failed recovery artifact origin changed")
    return artifact


def verify_recovery_failure():
    """Bind the one frozen candidate to its immutable, rolled-back release."""
    repository = "hushh-labs/hushh-research"

    def read(endpoint):
        return json.loads(
            retention.run_command(
                ["gh", "api", f"repos/{repository}/actions/{endpoint}"],
                timeout=15,
            ).stdout
        )

    run_id, attempt = RECOVERY_RECEIPT["run_id"], RECOVERY_RECEIPT["run_attempt"]
    run = read(f"runs/{run_id}/attempts/{attempt}")
    expected = {
        "id": run_id,
        "run_attempt": attempt,
        "head_branch": "main",
        "head_sha": "dcc4f611e39c80a0001df0ada3f47e85b445421e",
        "path": ".github/workflows/deploy-production.yml",
        "event": "workflow_dispatch",
        "status": "completed",
        "conclusion": "failure",
    }
    if (
        any(run.get(k) != v for k, v in expected.items())
        or any(
            (run.get(k) or {}).get("full_name") != repository
            for k in ("repository", "head_repository")
        )
        or read(f"runs/{run_id}").get("run_attempt") != attempt
    ):
        raise retention.UnsafeState(
            "Failed recovery release is not the frozen terminal attempt"
        )

    artifact = _failed_artifact(repository, read, run, expected)
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        release_artifact_receipts.download_replayed_artifact(
            repository,
            artifact,
            directory,
            "prod-release-status.json",
            run_command=retention.run_command,
            timeout=20,
        )
        release = json.loads((directory / "prod-release-status.json").read_text())
    if (
        release.get("status") != "rolled_back"
        or release.get("sha") != "ca83c0bf5ac85589dc376f31769314bfb8e78d0d"
        or release.get("predeploy", {}).get("backend_revision") != RECOVERY_SOURCE
        or release.get("final", {}).get("backend_revision") != RECOVERY_SOURCE
        or release.get("candidate", {}).get("backend_revision")
        != RECOVERY_FAILED_REVISION
        or release.get("rollback", {}).get("backend") != "success"
    ):
        raise retention.UnsafeState(
            "Frozen release does not prove failed candidate rollback"
        )


def recovery_capacity_inventory(inventory, maintenance_profile):
    """Conservatively reserve the attested failed launcher; never relax the ordinary parser.

    Its explicit gunicorn CLI requests one worker; the environment declares two.
    The frozen spec binds launcher and pools; native scaling still counts. Reserve two in
    this maintenance-only calculation, retain every revision/job/reserve, and
    leave native state untouched. Any other conflict still fails closed.
    """
    if maintenance_profile != RECOVERY_PROFILE:
        return inventory
    rows = inventory["services"][SERVICE]["revisions"]
    failed = [
        row for row in rows if row["metadata"]["name"] == RECOVERY_FAILED_REVISION
    ]
    if not failed:
        return inventory
    service = inventory["services"][SERVICE]["service"]
    if (
        len(failed) != 1
        or fingerprint([failed[0]["spec"], failed[0]["status"]["imageDigest"]])
        != RECOVERY_FAILED_SPEC
        or any(
            name == RECOVERY_FAILED_REVISION and percent
            for name, percent, _ in traffic(service)
        )
    ):
        raise retention.UnsafeState(
            "Frozen failed candidate changed or is serving traffic"
        )
    verify_recovery_failure()
    reserved = copy.deepcopy(inventory)
    row = next(
        row
        for row in reserved["services"][SERVICE]["revisions"]
        if row["metadata"]["name"] == RECOVERY_FAILED_REVISION
    )
    container = row["spec"]["containers"][0]
    # Both native declarations are part of the immutable fingerprint above.
    container["args"][container["args"].index("-w") + 1] = "2"
    return reserved


def receipt_extensions(profile, retired):
    result = {"recovery": RECOVERY_RECEIPT} if profile == RECOVERY_PROFILE else {}
    if retired:
        result.update(
            retiredPredecessor=retired,
            retiredPredecessorFingerprint=fingerprint(retired),
            retiredPredecessorObservation="verified_and_absent",
        )
    return result

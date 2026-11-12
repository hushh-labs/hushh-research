#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Admission receipts for staging an existing private production Drive worker.

The production workflow must immutably publish each preparation receipt before
acknowledging its digest. This helper owns no release lock or healthy authority.
The ordinary worker script still owns promotion, Scheduler and rollback.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from runpy import run_path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
PROJECT, REGION, SERVICE = "hushh-pda", "us-central1", "consent-protocol-drive-worker"
SCHEMA = "drive.worker.stage.v1"
RECOVERY = run_path(str(ROOT / "scripts/ci/production_recovery_capacity.py"))
RECORDED_WORKER_UID = "9e1d2707-bf41-46d3-b1fa-ba166f3c28d3"
RECORDED_SERVING = SERVICE + "-00003-xiz"
RECORDED_SERVING_UID = "22469ebf-9ad5-4bc5-b28d-1a7923dfd0ff"
RECORDED_EXPIRED = SERVICE + "-s-40981147326-1"
RECORDED_EXPIRED_UID = "5f167ea5-0c42-4409-a9f1-b626f3297892"


def run(command: list[str], *, timeout: int = 120) -> bytes:
    # Reuse the existing bounded subprocess/group owner; no detached SDK child.
    return run_path(str(ROOT / "deploy/phone/qualify_image.py"))["run"](
        command, timeout=timeout
    )


def gcloud(*args: str) -> dict | list:
    return json.loads(run(["gcloud", *args, f"--project={PROJECT}", "--format=json"]))


def fingerprint(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def write(path: Path, value: dict) -> None:
    if path.exists():
        raise ValueError("worker_receipt_already_exists")
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write((json.dumps(value, sort_keys=True, indent=2) + "\n").encode())
    try:
        os.link(temporary, path)  # Exclusive publication; never overwrite intent.
    finally:
        temporary.unlink()


VERIFIER = run_path(str(HERE / "verify_worker_revision.py"))
RUNTIME = VERIFIER["RUNTIME"]
SCANNER_INDEX = VERIFIER["SCANNER_INDEX"]
SCANNER_AMD64 = VERIFIER["SCANNER_AMD64"]
controls = VERIFIER["service_controls"]
verify = VERIFIER["verify_staged_revision"]
candidate = VERIFIER["staged_template"]
scheduler_command = VERIFIER["scheduler_command"]


def prove_scanner(value: dict, fields: dict) -> None:
    VERIFIER["verify_scanner_startup"](value, fields, read=gcloud, pause=time.sleep)


def context() -> dict:
    fields = {
        "source": os.environ["DEPLOY_SHA"],
        "image": os.environ["IMAGE_REFERENCE"],
        "run_id": os.environ["RELEASE_RUN_ID"],
        "attempt": os.environ["RELEASE_RUN_ATTEMPT"],
        "config_secret": os.environ["DRIVE_RUNTIME_CONFIG_SECRET"],
        "protected": os.environ.get("PROTECTED_DOCUMENT_DELIVERY_ENABLED", "false"),
    }
    if (
        not re.fullmatch(r"[0-9a-f]{40}", fields["source"])
        or not re.fullmatch(
            r"gcr\.io/hushh-pda/consent-protocol@sha256:[0-9a-f]{64}", fields["image"]
        )
        or not re.fullmatch(r"[1-9][0-9]*", fields["run_id"])
        or not re.fullmatch(r"[1-9][0-9]*", fields["attempt"])
        or fields["config_secret"]
        != f"BACKEND_RUNTIME_CONFIG_JSON_DRIVE_{fields['run_id']}_{fields['attempt']}"
        or fields["protected"] not in {"true", "false"}
    ):
        raise ValueError("worker_stage_context_invalid")
    return fields


def read(path: Path, status: str) -> dict:
    value = json.loads(path.read_bytes())
    if (
        value.get("schema") != SCHEMA
        or value.get("status") != status
        or value.get("context") != context()
        or value.get("project") != PROJECT
        or value.get("service") != SERVICE
        or type(value.get("expires")) is not int
        or value["expires"] <= time.time()
    ):
        raise ValueError("worker_stage_receipt_invalid_or_expired")
    return value


def acknowledge(path: Path, variable: str) -> str:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if os.environ.get(variable) != digest:
        raise ValueError("worker_durable_intent_acknowledgment_missing")
    return digest


def service() -> dict:
    value = gcloud("run", "services", "describe", SERVICE, f"--region={REGION}")
    metadata = value.get("metadata", {}) if isinstance(value, dict) else {}
    if (
        not metadata.get("uid")
        or not metadata.get("resourceVersion")
        or metadata.get("generation") is None
        or value.get("status", {}).get("observedGeneration") != metadata["generation"]
    ):
        raise ValueError("worker_existing_service_uid_missing")
    return value


def traffic(value: dict) -> list:
    desired = value.get("spec", {}).get("traffic")
    actual = value.get("status", {}).get("traffic")
    if not isinstance(desired, list) or not isinstance(actual, list):
        raise ValueError("worker_traffic_unavailable")
    positive = [item for item in actual if item.get("percent", 0) > 0]
    desired_positive = [item for item in desired if item.get("percent", 0) > 0]
    if (
        len(positive) != 1
        or positive[0].get("percent") != 100
        or not positive[0].get("revisionName")
        or any(item.get("latestRevision") for item in desired)
        or any(not item.get("revisionName") for item in desired)
        or len(desired_positive) != 1
        or desired_positive[0].get("percent") != 100
        or desired_positive[0].get("revisionName") != positive[0].get("revisionName")
    ):
        raise ValueError("worker_requires_exact_existing_100_percent_revision")
    return desired


def snapshot(path: Path, value: dict) -> str:
    if path.exists():
        raise ValueError("worker_scheduler_snapshot_already_exists")
    run(scheduler_command("capture", path, value["status"]["url"]))
    os.chmod(path, 0o600)
    return fingerprint(json.loads(path.read_bytes()))


def baseline(value: dict, scheduler_hash: str) -> dict:
    policy = gcloud("run", "services", "get-iam-policy", SERVICE, f"--region={REGION}")
    if (
        not isinstance(policy, dict)
        or not policy.get("etag")
        or not isinstance(policy.get("bindings"), list)
    ):
        raise ValueError("worker_iam_evidence_unavailable")
    if any(
        member in {"allUsers", "allAuthenticatedUsers"}
        for binding in policy["bindings"]
        for member in binding.get("members", [])
    ):
        raise ValueError("worker_must_remain_private")
    return {
        "uid": value["metadata"]["uid"],
        "controls": controls(value),
        "traffic": traffic(value),
        "serving": next(
            item["revisionName"]
            for item in value["status"]["traffic"]
            if item.get("percent") == 100
        ),
        "iam": fingerprint(policy),
        "scheduler": scheduler_hash,
    }


def revision(name: str) -> dict:
    value = gcloud("run", "revisions", "describe", name, f"--region={REGION}")
    if not isinstance(value, dict) or value.get("metadata", {}).get("name") != name:
        raise ValueError("worker_revision_identity_unavailable")
    return value


def _bind_basis(value: dict, fields: dict, prior: dict) -> dict:
    sys.path.insert(0, str(ROOT / "scripts/ci"))
    from production_staged_worker import bind_release_basis

    return bind_release_basis(value, fields, prior)


def release_basis(path: Path | None, fields: dict, prior: dict) -> dict:
    if path is None:
        return {}
    return {"release_basis": _bind_basis(json.loads(path.read_bytes()), fields, prior)}


def recovery_stage(fields):
    return fields["source"] == RECOVERY["APPLICATION_SHA"]


def stage_template(value, prior, fields, version, name):
    old = revision(prior["serving"])
    template = value["spec"]["template"]
    template_name = template.get("metadata", {}).get("name")
    same_spec = VERIFIER["same_worker_spec"]
    if template_name != prior["serving"] or not same_spec(template["spec"], old["spec"]):
        if (
            not recovery_stage(fields)
            or prior["uid"] != RECORDED_WORKER_UID
            or prior["serving"] != RECORDED_SERVING
            or old["metadata"].get("uid") != RECORDED_SERVING_UID
            or template_name != RECORDED_EXPIRED
            or value["status"].get("latestCreatedRevisionName") != RECORDED_EXPIRED
            or value["status"].get("latestReadyRevisionName") != RECORDED_EXPIRED
            or any(target.get("revisionName") == RECORDED_EXPIRED
                   for target in [*prior["traffic"], *value["status"]["traffic"]])
        ):
            raise ValueError("worker_latest_template_is_not_serving_revision")
        expired = revision(RECORDED_EXPIRED)
        if (
            expired["metadata"].get("uid") != RECORDED_EXPIRED_UID
            or not same_spec(template["spec"], expired["spec"])
        ):
            raise ValueError("worker_recorded_expired_template_changed")
        ignored = {
            "run.googleapis.com/operation-id", "serving.knative.dev/creator",
            "serving.knative.dev/lastModifier",
        }
        annotations = {key: val for key, val in old["metadata"].get("annotations", {}).items()
                       if key not in ignored}
        if annotations != template["metadata"].get("annotations", {}):
            raise ValueError("worker_serving_template_controls_changed")
        labels = {key: val for key, val in old["metadata"]["labels"].items()
                  if not key.startswith(("serving.knative.dev/", "cloud.googleapis.com/",
                                         "run.googleapis.com/"))}
        spec = copy.deepcopy(old["spec"])
        scanner = next(item for item in spec["containers"] if item["name"] == "clamav")
        scanner["image"] = f"clamav/clamav@{SCANNER_INDEX}"
        template = {"metadata": {"annotations": annotations, "labels": labels}, "spec": spec}
    verify(old, {
        "source": old["metadata"]["labels"]["deploy-sha"],
        "image": next(item["image"] for item in old["spec"]["containers"]
                      if item["name"] == "drive-worker"),
    })
    result = candidate({"spec": {"template": template}}, fields, version, name)
    if recovery_stage(fields):
        result["metadata"]["annotations"]["run.googleapis.com/health-check-disabled"] = "false"
    return result


def startup_target(receipt):
    # Service name plus tag and separator must fit Cloud Run's 46 characters.
    name = receipt["candidate"]
    suffix = hashlib.sha256(name.encode()).hexdigest()[:9]
    return {"revisionName": name, "tag": f"stage-{suffix}"}


def startup_verified(value, actual, receipt):
    name = receipt["candidate"]
    return (
        value["status"].get("latestCreatedRevisionName") == name
        and value["status"].get("latestReadyRevisionName") == name
        and any(row.get("type") == "ContainerHealthy" and row.get("status") == "True"
                for row in actual.get("status", {}).get("conditions", []))
    )


def worker_startup_state(value, receipt, scheduler_hash):
    tag = startup_target(receipt)
    normalized = copy.deepcopy(value)
    found = []
    for lane in ("spec", "status"):
        rows = value[lane]["traffic"]
        owned = [row for row in rows if row.get("tag") == tag["tag"]
                 or row.get("revisionName") == receipt["candidate"]]
        if owned and (
            len(owned) != 1
            or owned[0].get("tag") != tag["tag"]
            or owned[0].get("revisionName") != receipt["candidate"]
            or owned[0].get("percent", 0) != 0
            or owned[0].get("latestRevision")
        ):
            raise ValueError("worker_startup_route_changed")
        found.append(bool(owned))
        normalized[lane]["traffic"] = [row for row in rows if row not in owned]
    if found[0] != found[1]:
        raise ValueError("worker_startup_route_unreconciled")
    continuity(normalized, receipt, scheduler_hash, allow_retirement=False)
    return found[0]


def finish_recovery_startup(receipt, template, scheduler_hash):
    after = service()
    actual = revision(receipt["candidate"])
    if (
        after["spec"]["template"].get("metadata", {}).get("name") != receipt["candidate"]
        or not VERIFIER["same_worker_spec"](template["spec"], after["spec"]["template"]["spec"])
        or not VERIFIER["same_worker_spec"](template["spec"], actual["spec"])
        or not actual["metadata"].get("uid")
    ):
        raise ValueError("worker_submitted_template_readback_mismatch")
    if worker_startup_state(after, receipt, scheduler_hash):
        try:
            for _ in range(6):
                if startup_verified(after, actual, receipt):
                    break
                time.sleep(3)
                after = service()
                if not worker_startup_state(after, receipt, scheduler_hash):
                    raise ValueError("worker_startup_route_unreconciled")
                refreshed = revision(receipt["candidate"])
                if refreshed["metadata"].get("uid") != actual["metadata"]["uid"]:
                    raise ValueError("worker_staged_revision_changed")
                actual = refreshed
        finally:
            # Remove only the exact private tag, even when startup failed.
            after = service()
            if worker_startup_state(after, receipt, scheduler_hash):
                try:
                    submit(after, after["spec"]["template"], targets=receipt["baseline"]["traffic"])
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                    pass  # Resolve the provider result before publishing proof.
        after = service()
        if worker_startup_state(after, receipt, scheduler_hash):
            raise ValueError("worker_startup_tag_removal_unresolved")
        refreshed = revision(receipt["candidate"])
        if refreshed["metadata"].get("uid") != actual["metadata"]["uid"]:
            raise ValueError("worker_staged_revision_changed")
        actual = refreshed
    if not startup_verified(after, actual, receipt):
        raise ValueError("worker_provider_startup_unqualified")
    return after, actual


def prepare(path: Path, release_basis_path: Path | None = None) -> None:
    fields, value = context(), service()
    prior = baseline(value, snapshot(Path(str(path) + ".scheduler.json"), value))
    annotations = value["metadata"].get("annotations", {})
    if (
        annotations.get("run.googleapis.com/ingress") != "internal"
        or (
            json.loads(annotations.get("run.googleapis.com/custom-audiences", "[]"))
            != ["https://api.hushh.ai"]
        )
        or annotations.get("run.googleapis.com/invoker-iam-disabled", "false")
        != "false"
    ):
        raise ValueError("worker_private_service_controls_mismatch")
    secret = gcloud(
        "secrets",
        "versions",
        "describe",
        "latest",
        f"--secret={fields['config_secret']}",
    )
    version = secret.get("name", "").rsplit("/", 1)[-1]
    if (
        not version.isascii()
        or not version.isdecimal()
        or secret.get("state") != "ENABLED"
    ):
        raise ValueError("worker_config_version_unavailable")
    name = f"{SERVICE}-s-{fields['run_id']}-{fields['attempt']}"
    if len(name) > 63:
        raise ValueError("worker_staged_revision_name_too_long")
    template = stage_template(value, prior, fields, version, name)
    if recovery_stage(fields) and any(
        row.get("tag") == startup_target({"candidate": name})["tag"]
        for row in [*prior["traffic"], *value["status"]["traffic"]]
    ):
        raise ValueError("worker_startup_tag_already_present")
    write(
        path,
        {
            "schema": SCHEMA,
            "status": "prepared",
            "project": PROJECT,
            "service": SERVICE,
            "context": fields,
            "expires": int(time.time()) + 21600,
            "baseline": prior,
            "baseline_template": fingerprint(value["spec"]["template"]),
            "candidate": name,
            "config_version": version,
            "template": fingerprint(template),
            **release_basis(release_basis_path, fields, prior),
        },
    )


def continuity(
    value: dict, receipt: dict, scheduler_hash: str, *, allow_retirement: bool
) -> None:
    expected = receipt["baseline"]
    observed = baseline(value, scheduler_hash)
    old_traffic, new_traffic = expected["traffic"], observed["traffic"]
    if allow_retirement:
        # Ordinary retention may remove only obsolete zero-traffic targets.
        observed["traffic"] = old_traffic
        if any(item not in old_traffic for item in new_traffic) or any(
            item.get("percent", 0) > 0 and item not in new_traffic
            for item in old_traffic
        ):
            raise ValueError("worker_traffic_changed_since_staging")
    if observed != expected:
        raise ValueError("worker_controls_iam_scheduler_or_traffic_changed")


def submit(value: dict, template: dict, *, targets=None) -> None:
    replacement = {
        "apiVersion": "serving.knative.dev/v1",
        "kind": "Service",
        "metadata": {
            key: copy.deepcopy(value["metadata"][key])
            for key in ("name", "namespace", "resourceVersion", "annotations", "labels")
            if key in value["metadata"]
        },
        "spec": copy.deepcopy(value["spec"]),
    }
    replacement["spec"]["template"] = template
    if targets is not None:
        replacement["spec"]["traffic"] = targets
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as resource:
        json.dump(replacement, resource)
        resource.flush()
        run(
            [
                "gcloud",
                "--quiet",
                "run",
                "services",
                "replace",
                resource.name,
                f"--project={PROJECT}",
                f"--region={REGION}",
                "--format=json",
            ],
            timeout=300,
        )


def stage(path: Path) -> None:
    digest = acknowledge(path, "DRIVE_WORKER_STAGE_INTENT_SHA256")
    receipt, value = read(path, "prepared"), service()
    if "release_basis" in receipt:
        _bind_basis(receipt["release_basis"], receipt["context"], receipt["baseline"])
    scheduler = Path(str(path) + ".scheduler.json")
    run(scheduler_command("verify", scheduler, value["status"]["url"]))
    continuity(
        value,
        receipt,
        fingerprint(json.loads(scheduler.read_bytes())),
        allow_retirement=False,
    )
    if fingerprint(value["spec"]["template"]) != receipt["baseline_template"]:
        raise ValueError("worker_baseline_template_changed")
    rows = gcloud(
        "run", "revisions", "list", f"--service={SERVICE}", f"--region={REGION}"
    )
    if not isinstance(rows, list) or any(
        row.get("metadata", {}).get("name") == receipt["candidate"] for row in rows
    ):
        raise ValueError("worker_stage_outcome_already_exists_or_unknown")
    template = stage_template(
        value, receipt["baseline"], receipt["context"], receipt["config_version"],
        receipt["candidate"],
    )
    if fingerprint(template) != receipt["template"]:
        raise ValueError("worker_stage_template_intent_mismatch")
    scheduler_hash = fingerprint(json.loads(scheduler.read_bytes()))
    if recovery_stage(receipt["context"]):
        try:
            submit(value, template, targets=[*receipt["baseline"]["traffic"], startup_target(receipt)])
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            pass  # Reconcile the one submitted candidate; never create a second.
        after, actual = finish_recovery_startup(receipt, template, scheduler_hash)
    else:
        submit(value, template)
        after = service()
        continuity(after, receipt, scheduler_hash, allow_retirement=False)
        if after["spec"]["template"]["spec"] != template["spec"] or (
            after["spec"]["template"].get("metadata", {}).get("name") != receipt["candidate"]
        ):
            raise ValueError("worker_submitted_template_readback_mismatch")
        actual = revision(receipt["candidate"])
    run(scheduler_command("verify", scheduler, after["status"]["url"]))
    verify(actual, receipt["context"], receipt["config_version"])
    if not actual["metadata"].get("uid"):
        raise ValueError("worker_candidate_uid_unavailable")
    prove_scanner(actual, receipt["context"])
    write(
        Path(str(path) + ".staged.json"),
        {
            **receipt,
            "status": "staged",
            "prepared_sha256": digest,
            "candidate_uid": actual["metadata"]["uid"],
            "candidate_spec": fingerprint(actual["spec"]),
        },
    )


def validate(receipt: dict, snapshot_path: Path, *, allow_retirement: bool) -> dict:
    if (
        receipt.get("status") not in {"staged", "activation_prepared"}
        or receipt.get("expires", 0) <= time.time()
    ):
        raise ValueError("worker_stage_receipt_invalid_or_expired")
    if "release_basis" in receipt:
        _bind_basis(receipt["release_basis"], receipt["context"], receipt["baseline"])
    value = service()
    run(scheduler_command("verify", snapshot_path, value["status"]["url"]))
    continuity(
        value,
        receipt,
        fingerprint(json.loads(snapshot_path.read_bytes())),
        allow_retirement=allow_retirement,
    )
    actual = revision(receipt["candidate"])
    verify(actual, receipt["context"], receipt["config_version"])
    if recovery_stage(receipt["context"]) and (
        not startup_verified(value, actual, receipt)
        or any(target.get("revisionName") == receipt["candidate"]
               for target in [*value["spec"]["traffic"], *value["status"]["traffic"]])
    ):
        raise ValueError("worker_staged_provider_startup_changed")
    config = gcloud(
        "secrets",
        "versions",
        "describe",
        receipt["config_version"],
        f"--secret={receipt['context']['config_secret']}",
    )
    if (
        config.get("state") != "ENABLED"
        or config.get("name", "").rsplit("/", 1)[-1] != receipt["config_version"]
    ):
        raise ValueError("worker_staged_config_version_unavailable")
    if (
        actual["metadata"].get("uid") != receipt["candidate_uid"]
        or fingerprint(actual["spec"]) != receipt["candidate_spec"]
    ):
        raise ValueError("worker_staged_revision_changed")
    prove_scanner(actual, receipt["context"])
    return value


def admission(path: Path, snapshot_path: Path, *, prepare_only: bool) -> str:
    staged = Path(str(path) + ".staged.json")
    activation = Path(str(path) + ".activation.json")
    receipt = read(
        staged if prepare_only else activation,
        "staged" if prepare_only else "activation_prepared",
    )
    if not prepare_only:
        acknowledge(activation, "DRIVE_WORKER_ACTIVATION_INTENT_SHA256")
    value = validate(receipt, snapshot_path, allow_retirement=prepare_only)
    if prepare_only:
        write(
            activation,
            {
                **receipt,
                "status": "activation_prepared",
                "baseline": baseline(
                    value, fingerprint(json.loads(snapshot_path.read_bytes()))
                ),
                "expires": min(receipt["expires"], int(time.time()) + 900),
                "staged_sha256": hashlib.sha256(staged.read_bytes()).hexdigest(),
            },
        )
    return receipt["candidate"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "phase", choices=("prepare", "stage", "prepare-activation", "activate")
    )
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--release-basis", type=Path)
    parser.add_argument("--scheduler-snapshot", type=Path)
    args = parser.parse_args()
    try:
        if args.release_basis is not None and args.phase != "prepare":
            raise ValueError("worker_release_basis_requires_preparation")
        if args.phase == "prepare":
            prepare(args.receipt, args.release_basis)
        elif args.phase == "stage":
            stage(args.receipt)
        else:
            if args.scheduler_snapshot is None:
                raise ValueError("worker_activation_scheduler_snapshot_missing")
            name = admission(
                args.receipt,
                args.scheduler_snapshot,
                prepare_only=args.phase == "prepare-activation",
            )
            print(name)
    except (
        KeyError,
        ValueError,
        TypeError,
        OSError,
        RuntimeError,
        subprocess.SubprocessError,
    ) as error:
        reason = (
            str(error)
            if re.fullmatch(r"worker_[a-z_]+", str(error))
            else type(error).__name__
        )
        print(f"Drive worker stage refused: {reason}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

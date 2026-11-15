"""Current healthy release basis for worker staging, without deployment authority.

The release, continuation and acceptance owners retain their existing decisions.
This join binds their receipts to a fresh runtime snapshot; it never copies an
image, changes traffic, or stands in for worker/Scheduler/scanner qualification.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib
import json
import re
import subprocess
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Literal, NotRequired, TypedDict, cast

import production_backend_successor_proof as proof
import production_phone_receipt as phone
import promotion_approval
import release_artifact_receipts as receipts

REPOSITORY = proof.REPOSITORY
PROJECT, REGION = "hushh-pda", "us-central1"
WORKER = "consent-protocol-drive-worker"
KIND = "production-current-healthy-worker-basis"


class RuntimeIdentity(TypedDict):
    revision: str
    uid: str
    service_uid: str
    source: str
    image: str
    runtime_run_id: str


class HealthyOrigin(TypedDict):
    run_id: str
    run_attempt: int
    artifact_id: int
    artifact_digest: str


class Candidate(TypedDict):
    source: str
    image: str
    uat_acceptance: NotRequired[dict]
    main_qualification: NotRequired[dict]


class HealthyWorkerBasis(TypedDict):
    schema_version: int
    kind: Literal["production-current-healthy-worker-basis"]
    tag: dict
    healthy: HealthyOrigin
    backend: RuntimeIdentity
    worker: RuntimeIdentity
    candidate: Candidate
    protected_documents: dict


def _require(condition, reason):
    if not condition:
        raise receipts.retention.UnsafeState("Healthy worker basis: " + reason)


def _owners():
    return (
        importlib.import_module("uat-retention-maintenance"),
        importlib.import_module("verify-predecessor-acceptance"),
    )


def _tag(release_run_id):
    tag = proof.read_original()
    healthy, operational = proof.reference.split(tag["message"], tag["commit"])
    fields = proof.reference.healthy_fields(healthy, tag["commit"])
    match = re.fullmatch(
        rf"https://github\.com/{re.escape(REPOSITORY)}/actions/runs/([1-9][0-9]*)",
        fields["run"],
    )
    _require(
        operational is None
        and match is not None
        and (release_run_id is None or match[1] == release_run_id),
        "current healthy tag or requested release changed",
    )
    return tag, fields, match[1]


def current_release_run_id() -> str:
    """Read only the canonical healthy tag; live consumers must still qualify it."""
    return _tag(None)[2]


def _fresh_authority_read(owner, path: str):
    _require(
        isinstance(path, str) and path.startswith(("runs/", "workflows/")),
        "Main authority read left its bounded Actions owner",
    )
    token = owner._API_CACHE.set(None)
    try:
        return owner.api(REPOSITORY, path)
    finally:
        owner._API_CACHE.reset(token)


def _verify_main_git(source: str, approval: str, expected_mapping: object) -> None:
    try:
        subprocess.run(
            [
                "git",
                "fetch",
                "--no-tags",
                "origin",
                "+refs/heads/main:refs/remotes/origin/main",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        for commit in (source, approval):
            ancestry = subprocess.run(
                ["git", "merge-base", "--is-ancestor", commit, "origin/main"],
                check=False,
                capture_output=True,
                text=True,
                timeout=15,
            )
            _require(ancestry.returncode == 0, "Main candidate is not on origin/main")
    except subprocess.SubprocessError as error:
        raise receipts.retention.UnsafeState(
            "Healthy worker basis: Main git ancestry check failed"
        ) from error
    if approval == source:
        _require(
            expected_mapping is None,
            "single-SHA Main candidate cannot carry an approval mapping",
        )
        return
    try:
        mapping = promotion_approval.verify(source, approval)
    except (ValueError, subprocess.SubprocessError) as error:
        raise receipts.retention.UnsafeState(
            "Healthy worker basis: Main application approval is invalid"
        ) from error
    _require(
        mapping == expected_mapping,
        "stored Main application approval mapping changed",
    )


def _verify_main_qualification(
    owner, pin: object, source: str, *, approval_sha: str = ""
) -> dict:
    expected_fields = {
        "schema_version",
        "kind",
        "status",
        "repository",
        "environment",
        "sha",
        "main_approval_sha",
        "resolved_services",
        "qualification",
        "application_approval",
    }
    _require(
        isinstance(pin, dict)
        and set(pin) == expected_fields
        and pin.get("schema_version") == 1
        and pin.get("kind") == "main-qualified-source"
        and pin.get("status") == "qualified"
        and pin.get("repository") == REPOSITORY
        and pin.get("environment") == "production"
        and pin.get("sha") == source
        and pin.get("resolved_services") == ["backend"],
        "Main candidate qualification receipt is invalid",
    )
    approval = pin.get("main_approval_sha")
    _require(
        isinstance(approval, str)
        and bool(re.fullmatch(r"[0-9a-f]{40}", approval))
        and (not approval_sha or approval == approval_sha),
        "Main candidate approval SHA is invalid",
    )
    _verify_main_git(source, approval, pin.get("application_approval"))
    proofs = pin.get("qualification")
    _require(
        isinstance(proofs, dict) and set(proofs) == {"functional", "smoke"},
        "Main candidate qualification proofs are incomplete",
    )
    for kind, expected_sha in (("functional", source), ("smoke", approval)):
        item = proofs.get(kind)
        checks = item.get("checks") if isinstance(item, dict) else None
        reads = item.get("authority_reads") if isinstance(item, dict) else None
        _require(
            isinstance(item, dict)
            and item.get("repository") == REPOSITORY
            and item.get("sha") == expected_sha
            and item.get("source_branch") == "main"
            and isinstance(checks, list)
            and bool(checks)
            and all(
                isinstance(check, dict) and check.get("conclusion") == "success"
                for check in checks
            )
            and isinstance(reads, dict)
            and bool(reads),
            f"Main {kind} qualification evidence is invalid",
        )
        for path, expected_digest in reads.items():
            _require(
                isinstance(expected_digest, str)
                and bool(re.fullmatch(r"[0-9a-f]{64}", expected_digest)),
                "Main authority read digest is invalid",
            )
            current = _fresh_authority_read(owner, path)
            digest = hashlib.sha256(
                json.dumps(current, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
            _require(
                digest == expected_digest,
                "Main qualification changed after worker admission",
            )
    return copy.deepcopy(pin)


def _accepted(
    owner,
    acceptance,
    source,
    image,
    pin=None,
    *,
    image_source: str = "promote-from-uat",
    approval_sha: str = "",
):
    _require(bool(re.fullmatch(r"[0-9a-f]{40}", source)), "candidate source is invalid")
    if image_source == "build-from-source":
        _require(
            isinstance(image, str)
            and bool(
                re.fullmatch(
                    r"gcr\.io/hushh-pda/consent-protocol@sha256:[0-9a-f]{64}", image
                )
            ),
            "Main-built backend candidate has no immutable production image proof",
        )
        selected_approval = approval_sha or source
        _require(
            bool(re.fullmatch(r"[0-9a-f]{40}", selected_approval)),
            "Main candidate approval SHA is invalid",
        )
        if pin is None:
            try:
                pin = acceptance.main_source(
                    SimpleNamespace(
                        environment="production",
                        sha=source,
                        approval_sha=selected_approval,
                        scope="backend",
                        predecessor=None,
                    )
                )
            except acceptance.Refused as error:
                raise receipts.retention.UnsafeState(
                    f"Healthy worker basis: {error}"
                ) from error
        qualified = _verify_main_qualification(
            owner, pin, source, approval_sha=selected_approval
        )
        return {"source": source, "image": image, "main_qualification": qualified}
    _require(
        image_source == "promote-from-uat" and not approval_sha,
        "candidate image source is invalid",
    )
    github = acceptance.GitHub()
    if pin is not None:
        accepted = github.accept(pin, "uat", source, "backend")
    elif source == acceptance.RECORDED_RECOVERY_SHA:
        # The same-SHA completion can need a new stage after the operational
        # tag clears. Its accepted image remains the exact recorded UAT image.
        accepted = github.recorded_recovery_uat(source, "backend")["services"][
            "backend"
        ]
    else:
        accepted = github.find("uat", source, "backend")["services"]["backend"]
    reference = accepted.get("image_reference", "")
    _require(
        isinstance(reference, str)
        and bool(
            re.fullmatch(
                r"gcr\.io/hushh-pda-uat/consent-protocol@sha256:[0-9a-f]{64}", reference
            )
        ),
        "exact-SHA UAT backend has no immutable image proof",
    )
    production = reference.replace("gcr.io/hushh-pda-uat/", "gcr.io/hushh-pda/", 1)
    _require(image is None or image == production, "candidate image differs from UAT")
    return {"source": source, "image": production, "uat_acceptance": accepted}


def _fresh_run(owner, run_id):
    # Maintenance may cache its broader read pass. The entry/exit attempt fence
    # must observe GitHub again, through its existing bounded transport owner.
    token = owner._API_CACHE.set(None)
    try:
        return owner.api(REPOSITORY, f"runs/{run_id}")
    finally:
        owner._API_CACHE.reset(token)


def _find_release(owner, run, directory):
    # The canonical classifier must see the same freshly observed attempt, not
    # an earlier successful envelope retained by a broader maintenance pass.
    token = owner._API_CACHE.set(
        {
            **(owner._API_CACHE.get() or {}),
            (REPOSITORY, f"runs/{run['id']}"): run,
        }
    )
    try:
        return owner.find_release(
            REPOSITORY,
            str(run["id"]),
            directory,
            require_live=False,
            environment="production",
        )
    finally:
        owner._API_CACHE.reset(token)


def _release(owner, tag, fields, run_id):
    run = _fresh_run(owner, run_id)
    _require(
        run.get("id") == int(run_id)
        and run.get("status") == "completed"
        and run.get("conclusion") in {"success", "failure"}
        and owner.governed_dispatch(run, REPOSITORY, "production"),
        "current healthy run is not completed and governed",
    )
    with tempfile.TemporaryDirectory(prefix="healthy-worker-basis-") as directory:
        found = _find_release(owner, run, Path(directory))
    _require(found is not None and found[0] == int(run_id), "healthy receipt is absent")
    release = found[1]
    lane = owner.LANES["production"]
    artifact, _job = receipts.current_attempt_artifact(
        REPOSITORY, run, lane, api=owner.api, timestamp=owner._github_timestamp
    )
    archive = receipts.immutable_archive(
        REPOSITORY, artifact, run_command=owner.retention.run_command, timeout=30
    )
    original = {
        key: value
        for key, value in release.items()
        if not key.startswith("_maintenance_")
    }
    _require(
        original == phone._document(archive, "prod-release-status.json")
        and release.get("status") == "healthy"
        and release.get("sha") == tag["commit"]
        and all(
            release.get("final", {}).get(f"{lane}_revision")
            == fields[f"{lane}_revision"]
            for lane in ("backend", "frontend")
        ),
        "healthy tag, attempt archive and release differ",
    )
    mode = phone._document(archive, "prod-protected-document-release.json")
    _require(
        all(type(mode.get(key)) is bool for key in ("configured", "enabled")),
        "protected document mode is invalid",
    )
    return run, release, artifact, mode


def _source(
    source,
    release_run_id,
    image,
    pin=None,
    *,
    image_source: str = "promote-from-uat",
    approval_sha: str = "",
):
    owner, acceptance = _owners()
    tag, fields, run_id = _tag(release_run_id)
    run, release, artifact, mode = _release(owner, tag, fields, run_id)
    candidate = _accepted(
        owner,
        acceptance,
        source,
        image,
        pin,
        image_source=image_source,
        approval_sha=approval_sha,
    )
    return (
        owner,
        run,
        release,
        {
            "schema_version": 1,
            "kind": KIND,
            "tag": tag,
            "healthy": {
                "run_id": run_id,
                "run_attempt": run["run_attempt"],
                "artifact_id": artifact["id"],
                "artifact_digest": artifact["digest"],
            },
            "candidate": candidate,
            "protected_documents": mode,
        },
    )


def _unchanged(owner, run, tag):
    refreshed = _fresh_run(owner, str(run["id"]))
    _require(
        all(
            refreshed.get(key) == run.get(key)
            for key in ("id", "run_attempt", "head_sha", "status", "conclusion")
        )
        and proof.read_original() == tag,
        "healthy attempt or tag changed during qualification",
    )


def _runtime(owner, service):
    state = owner.retention.service_state(service, PROJECT, REGION)
    _require(state.get("metadata", {}).get("name") == service, "service name changed")
    desired, actual = (
        state.get("spec", {}).get("traffic"),
        state.get("status", {}).get("traffic"),
    )
    _require(
        isinstance(desired, list) and isinstance(actual, list), "traffic is absent"
    )
    positive = [row for row in actual if row.get("percent", 0)]
    requested = [row for row in desired if row.get("percent", 0)]
    _require(
        len(positive) == len(requested) == 1
        and positive[0].get("percent") == 100
        and requested[0].get("percent") == 100
        and requested[0].get("revisionName") == positive[0].get("revisionName")
        and not any(row.get("latestRevision") for row in desired),
        "runtime traffic is not an exact revision",
    )
    matches = [
        row
        for row in owner.retention.revision_state(service, PROJECT, REGION)
        if row.get("metadata", {}).get("name") == positive[0].get("revisionName")
    ]
    _require(len(matches) == 1, "runtime revision is ambiguous")
    return _identity(service, state, matches[0])


def _identity(service, state, revision):
    metadata, labels = (
        revision.get("metadata", {}),
        revision.get("metadata", {}).get("labels", {}),
    )
    container_name = "drive-worker" if service == WORKER else None
    containers = revision.get("spec", {}).get("containers", [])
    selected = [
        row
        for row in containers
        if container_name is None or row.get("name") == container_name
    ]
    _require(len(selected) == 1, "runtime application container is ambiguous")
    image = selected[0].get("image", "")
    source, run_id = labels.get("deploy-sha", ""), labels.get("github-run-id", "")
    env = selected[0].get("env", [])
    expected = {"ENVIRONMENT": "production", "GOOGLE_CLOUD_PROJECT": PROJECT}
    if service != WORKER:
        expected.update(
            HUSHH_DEPLOY_SHA=source,
            HUSHH_DEPLOY_RUN_ID=run_id,
            HUSHH_DEPLOY_SOURCE="deploy-production",
            HUSHH_DEPLOY_ENV="production",
        )
    _require(
        all(
            isinstance(value, str) and 0 < len(value) <= 256
            for value in (metadata.get("uid"), state.get("metadata", {}).get("uid"))
        )
        and bool(re.fullmatch(r"[0-9a-f]{40}", source))
        and bool(re.fullmatch(r"[1-9][0-9]*", run_id))
        and labels.get("serving.knative.dev/service") == service
        and labels.get("deploy-env") == "production"
        and bool(
            re.fullmatch(
                r"gcr\.io/hushh-pda/consent-protocol@sha256:[0-9a-f]{64}", image
            )
        )
        and revision.get("spec", {}).get("serviceAccountName")
        == "consent-protocol-runtime@hushh-pda.iam.gserviceaccount.com"
        and all(
            [row.get("value") for row in env if row.get("name") == key] == [value]
            for key, value in expected.items()
        )
        and not any("valueFrom" in row for row in env if row.get("name") in expected)
        and state.get("metadata", {}).get("generation") is not None
        and str(state["metadata"]["generation"])
        == str(state.get("status", {}).get("observedGeneration"))
        and all(
            any(
                row.get("type") == "Ready" and row.get("status") == "True"
                for row in item.get("status", {}).get("conditions", [])
            )
            for item in (state, revision)
        ),
        "runtime UID, source, image or readiness is unqualified",
    )
    return {
        "revision": metadata["name"],
        "uid": metadata["uid"],
        "service_uid": state["metadata"]["uid"],
        "source": source,
        "image": image,
        "runtime_run_id": run_id,
    }


def _stored_candidate_pin(candidate: object) -> tuple[str, str, str, object, str]:
    _require(isinstance(candidate, dict), "candidate authority is missing")
    keys = set(candidate)
    if keys == {"source", "image", "main_qualification"}:
        pin = candidate["main_qualification"]
        approval = pin.get("main_approval_sha", "") if isinstance(pin, dict) else ""
        _require(isinstance(approval, str), "Main candidate approval SHA is invalid")
        return (
            candidate["source"],
            candidate["image"],
            "build-from-source",
            pin,
            approval,
        )
    _require(
        keys == {"source", "image", "uat_acceptance"},
        "candidate authority is invalid",
    )
    return (
        candidate["source"],
        candidate["image"],
        "promote-from-uat",
        candidate["uat_acceptance"],
        "",
    )


def _load(
    source,
    release_run_id,
    image,
    pin=None,
    *,
    image_source: str = "promote-from-uat",
    approval_sha: str = "",
):
    owner, run, release, result = _source(
        source,
        release_run_id,
        image,
        pin,
        image_source=image_source,
        approval_sha=approval_sha,
    )
    _require(
        owner.live_release_matches(release, environment="production"),
        "healthy release is no longer serving",
    )
    backend, worker = _runtime(owner, "consent-protocol"), _runtime(owner, WORKER)
    expected = release.get("_maintenance_backend_identity") or {
        "revision": release["final"]["backend_revision"],
        "source": release["sha"],
        "run_id": run["id"],
    }
    _require(
        backend["revision"] == expected["revision"]
        and backend["source"] == expected["source"]
        and backend["runtime_run_id"] == str(expected["run_id"])
        and all(
            backend[key] == expected[key]
            for key in ("uid", "service_uid")
            if key in expected
        ),
        "current backend differs from healthy runtime provenance",
    )
    result.update(backend=backend, worker=worker)
    _unchanged(owner, run, result["tag"])
    return cast(HealthyWorkerBasis, result)


def load(
    target_sha: str,
    *,
    release_run_id: str | None = None,
    candidate_image: str | None = None,
    image_source: str = "promote-from-uat",
    approval_sha: str = "",
    main_qualification: dict | None = None,
) -> HealthyWorkerBasis:
    """Qualify an exact current healthy release and live backend/worker snapshot."""
    _require(
        main_qualification is None or image_source == "build-from-source",
        "Main qualification pin requires build-from-source",
    )
    return _load(
        target_sha,
        release_run_id,
        candidate_image,
        main_qualification,
        image_source=image_source,
        approval_sha=approval_sha,
    )


def qualify_source(basis: HealthyWorkerBasis) -> HealthyWorkerBasis:
    """Recheck source receipts only; this grants no live worker authority."""
    _require(
        basis.get("kind") == KIND
        and type(basis.get("schema_version")) is int
        and basis["schema_version"] == 1,
        "basis type is invalid",
    )
    source_sha, image, image_source, pin, approval = _stored_candidate_pin(
        basis.get("candidate")
    )
    owner, run, _release, source = _source(
        source_sha,
        basis["healthy"]["run_id"],
        image,
        pin,
        image_source=image_source,
        approval_sha=approval,
    )
    _require(
        all(basis.get(key) == value for key, value in source.items()),
        "stored source basis changed",
    )
    _unchanged(owner, run, source["tag"])
    return copy.deepcopy(basis)


def revalidate(basis: HealthyWorkerBasis) -> HealthyWorkerBasis:
    """Re-read live authority and refuse drift instead of replacing its basis."""
    qualify_source(basis)
    source_sha, image, image_source, pin, approval = _stored_candidate_pin(
        basis.get("candidate")
    )
    current = _load(
        source_sha,
        basis["healthy"]["run_id"],
        image,
        pin,
        image_source=image_source,
        approval_sha=approval,
    )
    _require(current == basis, "current worker or backend identity changed")
    return current


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-sha", required=True)
    parser.add_argument("--release-run-id")
    parser.add_argument("--candidate-image")
    parser.add_argument(
        "--image-source",
        choices=("promote-from-uat", "build-from-source"),
        default="promote-from-uat",
    )
    parser.add_argument("--approval-sha", default="")
    parser.add_argument("--main-qualification", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    qualification = (
        json.loads(args.main_qualification.read_text())
        if args.main_qualification is not None
        else None
    )
    value = load(
        args.target_sha,
        release_run_id=args.release_run_id,
        candidate_image=args.candidate_image,
        image_source=args.image_source,
        approval_sha=args.approval_sha,
        main_qualification=qualification,
    )
    args.output.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n")


if __name__ == "__main__":
    main()

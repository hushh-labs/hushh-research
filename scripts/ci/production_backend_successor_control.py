"""Governed operational-backend reference admission and resolution.

Preparation is read-only. Apply requires the canonical production lock and the
exact intent uploaded by this maintenance attempt's completed selection job.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import importlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from runpy import run_path

import production_activation_continuation as continuation
import production_backend_successor as reference
import production_backend_successor_proof as proof
import production_phone_lease_receipts as leases
import production_phone_receipt as phone
import release_artifact_receipts as receipts

MAINTENANCE_WORKFLOW = ".github/workflows/capacity-maintenance.yml"
INTENT_UPLOAD = "Publish operational reference intent"
_RUN_FIELDS = ("id", "run_attempt", "head_sha", "status", "conclusion", "path", "event", "head_branch")


def authority():
    return importlib.import_module("uat-retention-maintenance")


def _same_run(fresh, expected):
    return all(fresh.get(key) == expected.get(key) for key in _RUN_FIELDS)


def load_anchor(run_id: str, attempt: int) -> dict:
    owner = authority()
    return proof.load(
        run_id,
        attempt,
        api=owner.api,
        governed=owner.governed_dispatch,
        timestamp=owner._github_timestamp,
        run_command=owner.retention.run_command,
        timeout=60,
    )


def live(anchor: dict, *, initial: bool = False) -> None:
    owner = proof.bootstrap_owner()
    ports = owner.Runtime()
    service, revision = ports.service(), ports.revision(anchor["revision"])
    qualified = owner.qualify_revision(
        revision,
        sha=anchor["source"],
        image=anchor["image"],
        run_id=anchor["origin"]["run_id"],
    )
    runtime = anchor["runtime"]
    reference.require(
        qualified["revision"] == anchor["revision"]
        and revision.get("metadata", {}).get("uid") == anchor["uid"]
        and service.get("metadata", {}).get("uid") == runtime["service_uid"]
        and str(service.get("status", {}).get("observedGeneration"))
        == str(service["metadata"].get("generation"))
        and any(
            row.get("type") == "Ready" and row.get("status") == "True"
            for row in service.get("status", {}).get("conditions", [])
        )
        and owner.controls(service) == runtime["controls"]
        and owner.iam_fingerprint(ports.iam()) == runtime["iam"],
        "operational_backend_live_identity_changed",
    )
    if initial:
        revalidate_initial(anchor)
        reference.require(
            owner._positive(service) == [[anchor["serving_reference"]["revision"], 100]]
            and proof.digest(
                [
                    service.get("spec", {}).get("traffic"),
                    service.get("status", {}).get("traffic"),
                ]
            )
            == runtime["initial_traffic"],
            "operational_backend_initial_traffic_changed",
        )


def revalidate_initial(anchor: dict) -> None:
    """Reuse existing read owners; this phase executes no DDL or producer."""
    bootstrap = proof.bootstrap_owner()
    schemas = importlib.import_module("schema_qualification")
    producers = importlib.import_module("schema_producers")
    bundle = anchor["sealed_boundary"]
    checkpoint, archived = bundle["checkpoint"], bundle["installed_schema"]
    ports = producers.Runtime(checkpoint["plan"], bundle["primary_image"])
    before = ports.snapshot()
    schemas._submissions(ports, before)
    database = ports.database(True)
    workos = ports.workos()
    raw = bootstrap.plan.qualify_image.run(
        [
            "python3",
            str(proof.ROOT / "deploy/drive/resolve_protected_document_release.py"),
            "--project=hushh-pda",
            "--environment=production",
        ],
        timeout=120,
    )
    mode = run_path(str(proof.ROOT / "deploy/drive/rebind_protected_document_backend.py"))[
        "unchanged_mode"
    ](json.loads(raw), bundle["document_mode"])
    after = ports.snapshot()
    reference.require(
        database == archived["database"]
        and schemas._stable(before)
        == schemas._stable(after)
        == schemas._stable(archived["snapshot"])
        and workos.get("qualification") == "passed"
        and mode == bundle["document_mode"],
        "operational_backend_initial_boundary_changed",
    )


def record_anchor(current: dict) -> dict | None:
    healthy, record = reference.split(current["message"], current["commit"])
    if record is None:
        return None
    anchor = load_anchor(record["origin"]["run_id"], record["origin"]["run_attempt"])
    original = anchor["original_healthy"]
    reference.require(
        current["commit"] == original["commit"]
        and healthy == original["message"]
        and record["previous_tag_oid"] == original["tag_oid"]
        and record["origin"] == anchor["origin"]
        and all(
            record[key] == anchor[key] for key in ("revision", "source", "image", "uid")
        ),
        "operational_backend_reference_not_bound",
    )
    return anchor


def _auth_frontend_continuation_source(current, fields, run, release, owner):
    exception = release.get("predecessor_exception")
    if not isinstance(exception, dict):
        return None
    authority = exception.get("authority")
    if not isinstance(authority, dict) or authority.get("frontend_auth_domain_refresh") is not True:
        reference.require(
            "backend_acceptance_origin" not in exception,
            "frontend acceptance is missing its exact auth authority",
        )
        return None
    refresh = importlib.import_module("production_auth_domain_refresh")
    pointer = release.get("backend_origin")
    reference.require(
        release.get("status") == "healthy"
        and release.get("scope") == "frontend"
        and release.get("sha") == current["commit"] == refresh.CANDIDATE
        and isinstance(pointer, dict)
        and exception.get("backend_acceptance_origin") is not None
        and authority.get("mode") == "manual-emergency"
        and authority.get("application_sha") == refresh.CANDIDATE
        and authority.get("run_id") == str(run["id"])
        and type(run.get("run_attempt")) is int
        and run["run_attempt"] > 0
        and authority.get("run_attempt") == str(run["run_attempt"])
        and authority.get("workflow_sha") == run.get("head_sha")
        and run.get("path") == ".github/workflows/deploy-production.yml"
        and run.get("head_branch") == "main"
        and run.get("event") == "workflow_dispatch"
        and pointer.get("source") == refresh.SOURCE
        and fields.get("backend_revision") == pointer.get("revision"),
        "auth frontend continuation is not bound to its backend acceptance",
    )
    token = owner._API_CACHE.set(None)
    try:
        anchors = []
        with tempfile.TemporaryDirectory(prefix="auth-frontend-source-") as directory:
            found = owner.find_release(
                proof.REPOSITORY,
                str(run["id"]),
                Path(directory),
                require_live=False,
                environment="production",
                on_phone_rollback=anchors.append,
            )
        fresh = owner.uncached_api(proof.REPOSITORY, f"runs/{run['id']}")
    finally:
        owner._API_CACHE.reset(token)
    canonical = found[1] if found is not None else {}
    identity = canonical.get("_maintenance_backend_identity", {})
    runtime = canonical.get("_maintenance_restoration_runtime", {})
    physical = {
        "run_id": str(identity.get("run_id", "")),
        "source": identity.get("source"),
        "revision": identity.get("revision"),
        "uid": identity.get("uid"),
        "service_uid": identity.get("service_uid"),
    }
    reference.require(
        found is not None
        and found[0] == run["id"]
        and not anchors
        and canonical.get("status") == "healthy"
        and canonical.get("scope") == "frontend"
        and canonical.get("sha") == refresh.CANDIDATE
        and canonical.get("predecessor_exception") == exception
        and canonical.get("backend_origin") == pointer
        and physical == pointer
        and identity.get("source") == identity.get("sha") == refresh.SOURCE
        and identity.get("image") == refresh.IMAGES["backend"]
        and canonical.get("final", {}).get("backend_revision") == pointer["revision"]
        and runtime == {"backend": identity}
        and _same_run(fresh, run)
        and proof.read_original() == current,
        "auth frontend continuation lost its qualified physical backend",
    )
    return identity["source"]


def resolve() -> str:
    current = proof.read_original()
    anchor = record_anchor(current)
    if anchor is not None:
        live(anchor)
        return anchor["revision"]
    healthy, _ = reference.split(current["message"], current["commit"])
    return reference.healthy_fields(healthy, current["commit"])["backend_revision"]


def _continuation_source(current: dict) -> str | None:
    """Keep the exact activation basis until a standard backend release owns it."""
    healthy, _ = reference.split(current["message"], current["commit"])
    fields = reference.healthy_fields(healthy, current["commit"])
    match = re.fullmatch(
        rf"https://github\.com/{re.escape(proof.REPOSITORY)}/actions/runs/([1-9][0-9]*)",
        fields["run"],
    )
    reference.require(match is not None, "activation_basis_healthy_origin_invalid")
    owner = authority()
    run = owner.api(proof.REPOSITORY, f"runs/{match[1]}?exclude_pull_requests=true")
    lane = owner.LANES["production"]
    arguments = {
        "api": owner.api,
        "governed": owner.governed_dispatch,
        "timestamp": owner._github_timestamp,
        "run_command": owner.retention.run_command,
        "timeout": 60,
    }
    artifact, _job = receipts.current_attempt_artifact(
        proof.REPOSITORY, run, lane, api=owner.api, timestamp=owner._github_timestamp
    )
    archive = receipts.immutable_archive(
        proof.REPOSITORY, artifact, run_command=arguments["run_command"], timeout=60
    )
    release = phone._document(archive, "prod-release-status.json")
    reference.require(
        run.get("id") == int(match[1])
        and run.get("status") == "completed"
        and owner.governed_dispatch(run, proof.REPOSITORY, "production")
        and release.get("status") == "healthy"
        and release.get("sha") == current["commit"]
        and all(
            release.get("final", {}).get(f"{name}_revision")
            == fields[f"{name}_revision"]
            for name in ("backend", "frontend")
        ),
        "activation_basis_healthy_reference_changed",
    )
    reference.require(proof.read_original() == current, "activation_basis_tag_changed")
    if run.get("conclusion") == "failure":
        owner.verify_post_release_failure(proof.REPOSITORY, run, release)
    else:
        reference.require(
            run.get("conclusion") == "success", "activation_basis_release_failed"
        )
    source = _auth_frontend_continuation_source(current, fields, run, release, owner)
    if source is not None:
        return source
    context = continuation.archive_context(
        proof.REPOSITORY, run, release, lane, **arguments
    )
    if context is None:
        return None
    plan = phone._document(archive, "phone-rollback/plan.json")
    reference.require(
        plan.get("recovery_enabled") is False
        and context["backend"]["source"] == current["commit"],
        "activation_basis_producer_state_invalid",
    )
    return context["backend"]["source"]


def _operational_reference(current: dict, anchor: dict | None) -> dict:
    healthy, record = reference.split(current["message"], current["commit"])
    reference.require(
        (anchor is None and record is None)
        or (
            anchor is not None
            and record is not None
            and record["origin"] == anchor["origin"]
            and record["revision"] == anchor["revision"]
            and record["source"] == anchor["source"]
            and record["image"] == anchor["image"]
            and record["uid"] == anchor["uid"]
            and record["previous_tag_oid"] == anchor["original_healthy"]["tag_oid"]
        ),
        "auth repair operational reference does not match its anchor",
    )
    return {
        "ref": reference.REF,
        "tag_oid": current["tag_oid"],
        "commit": current["commit"],
        "healthy_message": healthy,
        "anchor_record": record,
        "tag_object": current["tag_object"],
    }


def current_auth_domain_acceptance_profile(
    observed: dict | None = None, *, revalidate_live: bool = True
) -> dict:
    """Bind restored acceptance; mutation recheck owns the initialized live readers."""
    reference.require(
        type(revalidate_live) is bool and (revalidate_live or observed is not None),
        "auth repair deferred validation requires the captured serving baseline",
    )
    current = proof.read_original()
    anchor = record_anchor(current)
    refresh = importlib.import_module("production_auth_domain_refresh")
    if anchor is not None:
        reference.require(
            anchor["source"] == refresh.ACTIVE_ANCHOR_SOURCE
            and anchor["sealed_boundary"]["checkpoint"]["plan"]["primary_sha"]
            == refresh.ACTIVE_ANCHOR_PRIMARY_SOURCE
            and anchor["original_healthy"]["commit"] == refresh.SOURCE,
            "auth repair operational anchor source tuple is outside the reviewed proof",
        )
        # Admission precedes Python/proxy initialization. It may bind immutable
        # evidence plus the paired provider baseline only. The existing mutation
        # recheck must confirm live traffic/schema after those readers are ready.
        if revalidate_live:
            live(anchor, initial=True)
    healthy, _ = reference.split(current["message"], current["commit"])
    fields = reference.healthy_fields(healthy, current["commit"])
    match = re.fullmatch(
        rf"https://github\.com/{re.escape(proof.REPOSITORY)}/actions/runs/([1-9][0-9]*)",
        fields["run"],
    )
    reference.require(match is not None, "auth repair healthy origin is invalid")
    owner = authority()
    token = owner._API_CACHE.set(None)
    try:
        run = owner.api(proof.REPOSITORY, f"runs/{match[1]}?exclude_pull_requests=true")
        anchors = []
        with tempfile.TemporaryDirectory(prefix="auth-domain-acceptance-") as directory:
            found = owner.find_release(
                proof.REPOSITORY,
                match[1],
                Path(directory),
                require_live=False,
                environment="production",
                on_phone_rollback=anchors.append,
            )
        fresh = owner.uncached_api(proof.REPOSITORY, f"runs/{match[1]}")
    finally:
        owner._API_CACHE.reset(token)
    release = found[1] if found is not None else {}
    identity = release.get("_maintenance_backend_identity", {})
    runtime = release.get("_maintenance_restoration_runtime", {})
    reference.require(
        found is not None
        and found[0] == int(match[1])
        and not anchors
        and run.get("id") == int(match[1])
        and type(run.get("run_attempt")) is int
        and run["run_attempt"] > 0
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
        and run.get("path") == ".github/workflows/deploy-production.yml"
        and run.get("head_branch") == "main"
        and run.get("event") == "workflow_dispatch"
        and owner.governed_dispatch(run, proof.REPOSITORY, "production")
        and release.get("status") == "healthy"
        and release.get("scope") == "all"
        and release.get("sha") == current["commit"]
        and isinstance(release.get("production_restoration"), dict)
        and isinstance(release.get("restoration_activation"), dict)
        and "backend_origin" not in release
        and "predecessor_exception" not in release
        and isinstance(identity, dict)
        and isinstance(runtime, dict)
        and set(runtime) == {"backend", "frontend"}
        and runtime.get("backend") == identity
        and identity.get("source") == current["commit"]
        and identity.get("sha") == current["commit"]
        and fields["backend_revision"] == identity.get("revision")
        and fields["frontend_revision"] == release.get("final", {}).get("frontend_revision")
        and _same_run(fresh, run)
        and proof.read_original() == current,
        "auth repair current restoration acceptance changed",
    )
    if observed is not None:
        backend = observed.get("backend", {})
        reference.require(
            backend.get("revision") == identity.get("revision")
            and backend.get("revision_uid") == identity.get("uid")
            and backend.get("service_uid") == identity.get("service_uid")
            and backend.get("source") == identity.get("source") == refresh.SOURCE
            and backend.get("image") == identity.get("image"),
            "auth repair serving backend differs from the accepted restoration",
        )
    return {
        "run_id": run["id"],
        "run_attempt": run["run_attempt"],
        "workflow_sha": run["head_sha"],
        "source": release["sha"],
        "backend": dict(identity),
        "operational_reference": _operational_reference(current, anchor),
    }


def _revalidate_auth_serving_anchor(anchor: dict, observed: dict) -> None:
    """Recheck the accepted serving revision, not the staged cold candidate."""
    backend = observed.get("backend", {})
    revision_name = backend.get("revision") if isinstance(backend, dict) else None
    reference.require(
        isinstance(revision_name, str) and bool(revision_name),
        "auth repair serving backend identity is incomplete",
    )
    owner = proof.bootstrap_owner()
    ports = owner.Runtime()
    service = ports.service()
    revision = ports.revision(revision_name)
    actual = importlib.import_module("production_emergency").baseline(
        service, revision, "consent-protocol"
    )
    runtime = anchor.get("runtime", {})
    serving = anchor.get("serving_reference", {})
    traffic = [
        service.get("spec", {}).get("traffic"),
        service.get("status", {}).get("traffic"),
    ]
    reference.require(
        actual == backend,
        "auth repair serving backend differs from its captured baseline",
    )
    reference.require(
        isinstance(runtime, dict)
        and isinstance(serving, dict)
        and service.get("metadata", {}).get("uid") == runtime.get("service_uid")
        and owner.controls(service) == runtime.get("controls")
        and owner.iam_fingerprint(ports.iam()) == runtime.get("iam")
        and owner._positive(service) == [[serving.get("revision"), 100]]
        and proof.digest(traffic) == runtime.get("initial_traffic"),
        "auth repair operational serving controls or traffic changed",
    )


def revalidate_auth_domain_reference(expected: dict, observed: dict) -> None:
    profile = current_auth_domain_acceptance_profile(
        observed, revalidate_live=False
    )
    reference.require(
        isinstance(profile, dict)
        and profile.get("operational_reference") == expected,
        "auth repair operational reference changed",
    )
    refresh = importlib.import_module("production_auth_domain_refresh")
    backend = observed.get("backend", {})
    accepted = profile.get("backend", {})
    reference.require(
        isinstance(backend, dict)
        and isinstance(accepted, dict)
        and backend.get("revision") == accepted.get("revision")
        and backend.get("revision_uid") == accepted.get("uid")
        and backend.get("service_uid") == accepted.get("service_uid")
        and backend.get("source") == accepted.get("source") == refresh.SOURCE
        and backend.get("image") == accepted.get("image"),
        "auth repair serving backend differs from the accepted restoration",
    )
    record = expected.get("anchor_record")
    if record is None:
        return
    origin = record.get("origin") if isinstance(record, dict) else None
    reference.require(
        isinstance(origin, dict)
        and isinstance(origin.get("run_id"), str)
        and type(origin.get("run_attempt")) is int
        and origin["run_attempt"] > 0,
        "auth repair operational anchor origin is invalid",
    )
    anchor = load_anchor(origin["run_id"], origin["run_attempt"])
    reference.require(
        anchor.get("origin") == origin
        and all(
            record.get(key) == anchor.get(key)
            for key in ("revision", "source", "image", "uid")
        )
        and record.get("previous_tag_oid")
        == anchor.get("original_healthy", {}).get("tag_oid")
        and anchor.get("source") == refresh.ACTIVE_ANCHOR_SOURCE
        and anchor.get("sealed_boundary", {}).get("checkpoint", {}).get("plan", {}).get(
            "primary_sha"
        )
        == refresh.ACTIVE_ANCHOR_PRIMARY_SOURCE
        and anchor.get("original_healthy", {}).get("commit") == refresh.SOURCE,
        "auth repair operational anchor is outside the reviewed proof",
    )
    _revalidate_auth_serving_anchor(anchor, observed)


def _write_release_status(path: Path, payload: dict) -> None:
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as stream:
        temporary = Path(stream.name)
        json.dump(payload, stream, indent=2)
        stream.write("\n")
    os.replace(temporary, path)


def _git_config_value(run, key: str) -> str:
    try:
        return run(["config", key]).strip()
    except subprocess.CalledProcessError as error:
        if (
            error.returncode == 1
            and not (error.stdout or "").strip()
            and not (error.stderr or "").strip()
        ):
            return ""
        raise


def publish_auth_domain_tag(status_path: Path, sha: str, *, run=reference.git) -> dict:
    """Publish only the immutable repair tag and prove the operational ref stayed put."""
    payload = json.loads(status_path.read_text(encoding="utf-8"))
    release = payload.get("predecessor_exception")
    refresh = importlib.import_module("production_auth_domain_refresh")
    reference.require(
        payload.get("status") == "healthy"
        and payload.get("scope") == "frontend"
        and payload.get("sha") == sha == refresh.CANDIDATE
        and isinstance(release, dict)
        and release.get("scope") == "frontend"
        and release.get("ordinary_promotion_evidence") is False
        and release.get("authority", {}).get("frontend_auth_domain_refresh") is True
        and release.get("authority", {}).get("application_sha") == sha
        and release.get("authority", {}).get("run_id") == os.environ.get("GITHUB_RUN_ID")
        and release.get("authority", {}).get("run_attempt") == os.environ.get("GITHUB_RUN_ATTEMPT")
        and release.get("authority", {}).get("workflow_sha") == os.environ.get("GITHUB_SHA"),
        "auth repair immutable tag lacks its exact healthy admission receipt",
    )
    acceptance = release.get("backend_acceptance_origin")
    reference.require(
        isinstance(acceptance, dict)
        and isinstance(acceptance.get("operational_reference"), dict)
        and _auth_domain_frontend_exception(sha, "frontend", refresh.SOURCE),
        "auth repair immutable tag is not authorized by the current incident event",
    )
    expected = acceptance["operational_reference"]
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    latest_before = reference.remote_oid(run=run)
    if latest_before != expected["tag_oid"]:
        result = {
            "status": "refused",
            "immutable_ref": None,
            "immutable_tag_oid": None,
            "immutable_tag_readback_oid": None,
            "preserved_operational_ref": expected["ref"],
            "preserved_operational_tag_oid": expected["tag_oid"],
            "operational_ref_readback_oid": latest_before,
            "immutable_tag_readback_matches": False,
            "recorded_at": timestamp,
        }
        payload["auth_domain_tag_publication"] = result
        _write_release_status(status_path, payload)
        reference.require(False, "auth repair operational reference moved before publication")
    current = proof.read_original()
    anchor = record_anchor(current)
    actual = _operational_reference(current, anchor)
    if actual != expected or actual["ref"] != reference.REF:
        latest_before = reference.remote_oid(run=run)
        result = {
            "status": "refused",
            "immutable_ref": None,
            "immutable_tag_oid": None,
            "immutable_tag_readback_oid": None,
            "preserved_operational_ref": expected["ref"],
            "preserved_operational_tag_oid": expected["tag_oid"],
            "operational_ref_readback_oid": latest_before,
            "immutable_tag_readback_matches": False,
            "recorded_at": datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
        }
        payload["auth_domain_tag_publication"] = result
        _write_release_status(status_path, payload)
        reference.require(False, "auth repair operational reference changed before publication")
    tag_name = f"deployed/production/{sha[:8]}-{timestamp}"
    tag_ref = f"refs/tags/{tag_name}"
    local_published_oid = ""
    outcome = "refused"
    push_attempted = False
    try:
        reference.require(not run(["ls-remote", "--refs", "origin", tag_ref]).strip(),
                          "auth repair immutable tag already exists")
        if not _git_config_value(run, "user.email"):
            run(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"])
        if not _git_config_value(run, "user.name"):
            run(["config", "user.name", "github-actions[bot]"])
        message = "\n".join(
            (
                "Last known good — production auth-domain repair",
                f"sha: {sha}",
                f"backend_revision: {payload.get('final', {}).get('backend_revision', '')}",
                f"frontend_revision: {payload.get('final', {}).get('frontend_revision', '')}",
                f"run: {os.environ.get('RUN_URL', '')}",
                f"actor: {os.environ.get('ACTOR', 'unknown')}",
                f"tagged_at: {timestamp}",
                f"preserved_operational_reference: {expected['ref']}",
                f"preserved_operational_tag_oid: {expected['tag_oid']}",
                "",
            )
        )
        run(["tag", "-a", tag_name, sha, "-m", message])
        local_published_oid = run(["rev-parse", f"{tag_ref}^{{tag}}"]).strip()
        reference.require(bool(reference.HEX40.fullmatch(local_published_oid)),
                          "auth repair immutable tag object is invalid")
        push_attempted = True
        run(["push", "origin", tag_ref])
        outcome = "published"
    except (ValueError, OSError, subprocess.SubprocessError):
        # A push may have reached GitHub before its client observed an error.
        # Reconcile once; never retry a publication write.
        try:
            rows = run(["ls-remote", "--refs", "origin", tag_ref]).splitlines()
            if len(rows) == 1:
                oid, found_ref = rows[0].split("\t")
                if found_ref == tag_ref and bool(reference.HEX40.fullmatch(oid)):
                    outcome = (
                        "published"
                        if push_attempted and oid == local_published_oid
                        else "refused"
                    )
            elif push_attempted:
                outcome = "uncertain"
        except (OSError, subprocess.SubprocessError, ValueError):
            outcome = "uncertain"
    try:
        latest_after = reference.remote_oid(run=run)
        tag_rows = run(["ls-remote", "--refs", "origin", tag_ref]).splitlines()
        immutable_tag_readback_oid = None
        if len(tag_rows) == 1:
            row = tag_rows[0].split("\t")
            if len(row) == 2 and row[1] == tag_ref and reference.HEX40.fullmatch(row[0]):
                immutable_tag_readback_oid = row[0]
        exact_tag = (
            bool(local_published_oid)
            and immutable_tag_readback_oid == local_published_oid
        )
        preserved = latest_after == expected["tag_oid"]
        if outcome == "published" and not (exact_tag and preserved):
            outcome = "refused"
        result = {
            "status": outcome,
            "immutable_ref": tag_ref,
            "immutable_tag_oid": local_published_oid or None,
            "immutable_tag_readback_oid": immutable_tag_readback_oid,
            "preserved_operational_ref": expected["ref"],
            "preserved_operational_tag_oid": expected["tag_oid"],
            "operational_ref_readback_oid": latest_after,
            "immutable_tag_readback_matches": exact_tag,
            "recorded_at": timestamp,
        }
    except (OSError, subprocess.SubprocessError, ValueError):
        result = {
            "status": "uncertain",
            "immutable_ref": tag_ref,
            "immutable_tag_oid": local_published_oid or None,
            "immutable_tag_readback_oid": None,
            "preserved_operational_ref": expected["ref"],
            "preserved_operational_tag_oid": expected["tag_oid"],
            "operational_ref_readback_oid": None,
            "immutable_tag_readback_matches": False,
            "recorded_at": timestamp,
        }
    payload["auth_domain_tag_publication"] = result
    _write_release_status(status_path, payload)
    reference.require(
        result["status"] == "published"
        and result["immutable_tag_readback_matches"] is True
        and result["operational_ref_readback_oid"] == expected["tag_oid"],
        "auth repair immutable publication or preserved reference is unconfirmed",
    )
    return result


def verify_auth_domain_tag_publication(payload: dict, sha: str) -> dict:
    """Fail closed unless the repair tag and preserved ref readbacks match."""
    refresh = importlib.import_module("production_auth_domain_refresh")
    publication = payload.get("auth_domain_tag_publication")
    exception = payload.get("predecessor_exception")
    acceptance = exception.get("backend_acceptance_origin") if isinstance(exception, dict) else None
    operational = acceptance.get("operational_reference") if isinstance(acceptance, dict) else None
    immutable_ref = publication.get("immutable_ref") if isinstance(publication, dict) else None
    reference.require(
        payload.get("status") == "healthy"
        and sha == refresh.CANDIDATE
        and payload.get("sha") == sha
        and isinstance(publication, dict)
        and publication.get("status") == "published"
        and isinstance(operational, dict)
        and operational.get("ref") == reference.REF
        and operational.get("tag_oid") == publication.get("preserved_operational_tag_oid")
        and isinstance(immutable_ref, str)
        and bool(
            re.fullmatch(
                rf"refs/tags/deployed/production/{re.escape(sha[:8])}-[0-9]{{8}}T[0-9]{{6}}Z",
                immutable_ref,
            )
        )
        and isinstance(publication.get("immutable_tag_oid"), str)
        and bool(reference.HEX40.fullmatch(publication["immutable_tag_oid"]))
        and publication.get("immutable_tag_readback_oid")
        == publication.get("immutable_tag_oid")
        and publication.get("preserved_operational_ref") == reference.REF
        and isinstance(publication.get("preserved_operational_tag_oid"), str)
        and bool(reference.HEX40.fullmatch(publication["preserved_operational_tag_oid"]))
        and publication.get("operational_ref_readback_oid")
        == publication.get("preserved_operational_tag_oid")
        and publication.get("immutable_tag_readback_matches") is True,
        "auth repair publication is missing or its exact tag readbacks are unconfirmed",
    )
    return publication


def _auth_domain_frontend_exception(sha: str, scope: str, source: str) -> bool:
    refresh = importlib.import_module("production_auth_domain_refresh")
    if (sha, scope, source) != (refresh.CANDIDATE, "frontend", refresh.SOURCE):
        return False
    event_path = os.environ.get("GITHUB_EVENT_PATH", "")
    if not event_path:
        return False
    try:
        event = json.loads(Path(event_path).read_text())
        if not isinstance(event, dict):
            return False
        inputs = event.get("inputs")
        selected = inputs.get("frontend_auth_domain_refresh") if isinstance(inputs, dict) else None
        if (
            not isinstance(inputs, dict)
            or inputs.get("sha") != sha
            or inputs.get("scope") != scope
            or not (selected is True or selected == "true")
        ):
            return False
        root = Path(__file__).resolve().parents[2]
        policy = json.loads((root / "config/ci-governance.json").read_text())
        authority = importlib.import_module("production_emergency").dispatch(
            event, dict(os.environ), policy
        )
    except (OSError, ValueError, KeyError, TypeError):
        return False
    return isinstance(authority, dict) and (
        authority.get("mode") == "manual-emergency"
        and authority.get("frontend_auth_domain_refresh") is True
        and authority.get("application_sha") == sha
        and authority.get("run_id") == os.environ.get("GITHUB_RUN_ID")
        and authority.get("run_attempt") == os.environ.get("GITHUB_RUN_ATTEMPT")
        and authority.get("workflow_sha") == os.environ.get("GITHUB_SHA")
    )


def admit(sha: str, scope: str) -> None:
    current = proof.read_original()
    anchor = record_anchor(current)
    source = (
        anchor["sealed_boundary"]["checkpoint"]["plan"]["primary_sha"]
        if anchor is not None
        else _continuation_source(current)
    )
    if source is not None:
        if scope in {"backend", "all"} and sha == source:
            return
        refresh = importlib.import_module("production_auth_domain_refresh")
        auth_anchor_is_exact = anchor is None or (
            anchor["source"] == refresh.ACTIVE_ANCHOR_SOURCE
            and anchor["original_healthy"]["commit"] == refresh.SOURCE
            and anchor["sealed_boundary"]["checkpoint"]["plan"]["primary_sha"]
            == refresh.ACTIVE_ANCHOR_PRIMARY_SOURCE
        )
        auth_source = (
            anchor["original_healthy"]["commit"] if anchor is not None else source
        )
        reference.require(
            auth_anchor_is_exact and _auth_domain_frontend_exception(sha, scope, auth_source),
            "operational_backend_transition_requires_original_source",
        )


def _confirmed_activation(
    anchor: dict, sha: str, revision: str, activation: Path
) -> None:
    evidence = json.loads(activation.read_text())
    reference.require(
        sha == anchor["sealed_boundary"]["checkpoint"]["plan"]["primary_sha"]
        and evidence.get("candidate_revision") == revision,
        "operational_backend_healthy_activation_unconfirmed",
    )
    origin_path = activation.with_name(continuation.ORIGIN)
    if origin_path.exists():
        origin = json.loads(origin_path.read_text())
        owner = authority()
        original = continuation.load_original(
            origin["original"]["run_id"],
            sha,
            repository=proof.REPOSITORY,
            operational_anchor=anchor,
            api=owner.api,
            governed=owner.governed_dispatch,
            timestamp=owner._github_timestamp,
            run_command=owner.retention.run_command,
            timeout=60,
        )
        reference.require(
            origin == original, "operational_backend_activation_origin_changed"
        )
        continuation.validate_activated(origin, evidence, sha)
        return
    retirement = evidence.get("retirement") or {}
    key = continuation._floor_key()
    reference.require(
        evidence.get("status") == "activated"
        and evidence.get("project") == "hushh-pda"
        and evidence.get("sha") == sha
        and evidence.get("run_id") == os.environ["GITHUB_RUN_ID"]
        and retirement.get("status") == "retired"
        and retirement.get("phone_admission_floor_required") is True
        and type(retirement.get(key)) is int
        and retirement[key] == 0,
        "operational_backend_healthy_activation_unconfirmed",
    )


def healthy(sha: str, revision: str, activation: Path) -> str:
    current = proof.read_original()
    anchor = record_anchor(current)
    if anchor is not None:
        _confirmed_activation(anchor, sha, revision, activation)
    return current["tag_oid"]


def prepare(run_id: str, attempt: int, output: Path) -> dict:
    anchor, current = load_anchor(run_id, attempt), proof.read_original()
    if current == anchor["original_healthy"]:
        message = reference.annotate(
            current["message"], current["commit"], current["tag_oid"], anchor
        )
        new_oid = reference.tag_object(current["commit"], message)
    else:
        reference.require(
            record_anchor(current) == anchor,
            "operational_backend_original_reference_changed",
        )
        # Already published: preserve that exact object; no renewed lease or tag.
        new_oid = current["tag_oid"]
    intent = {
        "schema_version": 1,
        "kind": "phone-operational-reference-intent",
        "old_oid": anchor["original_healthy"]["tag_oid"],
        "new_oid": new_oid,
        "new_object": reference.git(["cat-file", "tag", new_oid]),
        "origin": anchor["origin"],
        "publisher": {
            "run_id": os.environ["GITHUB_RUN_ID"],
            "run_attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
            "workflow_sha": os.environ["GITHUB_SHA"],
        },
    }
    with output.open("x") as stream:
        stream.write(json.dumps(intent, sort_keys=True, indent=2) + "\n")
    return intent


def published_intent(owner: dict) -> dict:
    runtime = authority()
    reference.require(
        owner.get("path") == MAINTENANCE_WORKFLOW,
        "operational_backend_publication_workflow_invalid",
    )
    jobs = runtime.api(
        proof.REPOSITORY,
        f"runs/{owner['id']}/attempts/{owner['run_attempt']}/jobs?per_page=100",
    )
    selection = [
        job
        for job in jobs.get("jobs", [])
        if job.get("name") == "Verify due cleanup without cloud credentials"
    ]
    reference.require(
        len(selection) == 1 and selection[0].get("conclusion") == "success",
        "operational_backend_selection_not_successful",
    )
    selected = leases.artifact(
        proof.REPOSITORY,
        owner,
        jobs,
        runtime.api,
        runtime._github_timestamp,
        job="Verify due cleanup without cloud credentials",
        upload=INTENT_UPLOAD,
        name=f"prod-operational-reference-intent-{owner['id']}-{owner['run_attempt']}",
    )
    archive = receipts.immutable_archive(
        proof.REPOSITORY,
        selected,
        run_command=runtime.retention.run_command,
        timeout=60,
    )
    intent = phone._document(archive, "operational-reference-intent.json")
    reference.require(
        intent.get("schema_version") == 1
        and type(intent["schema_version"]) is int
        and intent.get("kind") == "phone-operational-reference-intent"
        and intent.get("publisher")
        == {
            "run_id": str(owner["id"]),
            "run_attempt": owner["run_attempt"],
            "workflow_sha": owner["head_sha"],
        },
        "operational_backend_publication_origin_invalid",
    )
    return intent


def apply() -> dict:
    ports = proof.bootstrap_owner().Runtime()
    owner = ports.lock_owner()
    intent = published_intent(owner)
    identity = reference.tag_identity(intent["new_object"])
    anchor = record_anchor(identity)
    reference.require(
        anchor is not None
        and identity["tag_oid"] == intent["new_oid"]
        and anchor["origin"] == intent["origin"]
        and anchor["original_healthy"]["tag_oid"] == intent["old_oid"],
        "operational_backend_intent_changed",
    )
    current = proof.read_original()
    if current == identity:
        live(anchor)
        return {
            "status": "confirmed",
            "revision": anchor["revision"],
            "replayed": False,
        }
    reference.require(
        current == anchor["original_healthy"], "operational_backend_reference_changed"
    )
    live(anchor, initial=True)
    actual = reference.git(["mktag"], content=intent["new_object"]).strip()
    reference.require(
        actual == intent["new_oid"] and ports.lock_owner() == owner,
        "operational_backend_admission_changed",
    )
    outcome = reference.compare_and_swap(intent["old_oid"], intent["new_oid"])
    return {"status": outcome, "revision": anchor["revision"], "replayed": False}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "phase",
        choices=(
            "prepare", "apply", "resolve", "admit", "healthy", "auth-publish",
            "auth-publish-verify",
        ),
    )
    parser.add_argument("--run-id")
    parser.add_argument("--attempt", type=int)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--sha")
    parser.add_argument("--scope")
    parser.add_argument("--revision")
    parser.add_argument("--activation", type=Path)
    parser.add_argument("--status", type=Path)
    args = parser.parse_args()
    if args.phase == "resolve":
        print(resolve())
    elif args.phase == "admit":
        admit(args.sha, args.scope)
    elif args.phase == "healthy":
        print(healthy(args.sha, args.revision, args.activation))
    elif args.phase == "auth-publish":
        reference.require(args.status is not None, "auth_repair_release_status_required")
        result = publish_auth_domain_tag(args.status, args.sha)
        print(
            "Auth repair immutable tag published; operational reference remained unchanged "
            f"({result['preserved_operational_tag_oid']})."
        )
    elif args.phase == "auth-publish-verify":
        reference.require(args.status is not None, "auth_repair_release_status_required")
        payload = json.loads(args.status.read_text(encoding="utf-8"))
        verify_auth_domain_tag_publication(payload, args.sha)
        print("Auth repair publication readbacks are confirmed.")
    elif args.phase == "prepare":
        reference.require(
            args.output is not None, "operational_backend_intent_output_required"
        )
        prepare(args.run_id, args.attempt, args.output)
    else:
        result = apply()
        if args.output is not None:
            args.output.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()

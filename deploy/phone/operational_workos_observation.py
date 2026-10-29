# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Preserve the last direct observation of the retired restoration backend.

Resolve the original sealed cold proof through existing operational or healthy
release owners. Later receipts carry only that original pointer, never a new
interpretation of a historical row.
"""

from __future__ import annotations

import importlib
import re
import tempfile
from pathlib import Path

from bootstrap_ports import REPOSITORY, _authorities
from restoration_workos_observation import instant, qualify_capture, require

REVISION = "consent-protocol-00309-nir"
CREATED = "2026-10-27T03:57:30.750209Z"


def _ports(owner):
    return {
        "api": owner.uncached_api,
        "governed": owner.governed_dispatch,
        "timestamp": owner._github_timestamp,
        "run_command": owner.retention.run_command,
        "timeout": 60,
    }


def _healthy_origin(tag, proof, owner):
    continuation = importlib.import_module("production_activation_continuation")
    healthy, _ = proof.reference.split(tag["message"], tag["commit"])
    fields = proof.reference.healthy_fields(healthy, tag["commit"])
    match = re.fullmatch(
        rf"https://github.com/{re.escape(REPOSITORY)}/actions/runs/([1-9][0-9]*)", fields["run"]
    )
    require(match is not None)
    anchors = []
    with tempfile.TemporaryDirectory(prefix="workos-healthy-observation-") as directory:
        found = owner.find_release(
            REPOSITORY,
            match[1],
            Path(directory),
            require_live=False,
            environment="production",
            on_phone_rollback=anchors.append,
        )
    require(found is not None and found[0] == int(match[1]))
    release = {k: v for k, v in found[1].items() if not k.startswith("_maintenance_")}
    require(
        release.get("status") == "healthy"
        and release.get("sha") == tag["commit"]
        and release.get("final", {}).get("backend_revision") == fields["backend_revision"]
        and release.get("final", {}).get("frontend_revision") == fields["frontend_revision"]
        and "phone_rollback" in release
    )
    run = owner.uncached_api(REPOSITORY, f"runs/{match[1]}")
    ports = _ports(owner)
    artifact, _job = continuation.receipts.current_attempt_artifact(
        REPOSITORY, run, owner.LANES["production"], api=ports["api"], timestamp=ports["timestamp"]
    )
    content = continuation.receipts.immutable_archive(
        REPOSITORY, artifact, run_command=ports["run_command"], timeout=ports["timeout"]
    )
    require(
        len(anchors) == 1
        and anchors[0].get("release_run_id") == run.get("id")
        and anchors[0].get("run_attempt") == run.get("run_attempt")
        and anchors[0].get("artifact_id") == artifact.get("id")
        and anchors[0].get("artifact_digest") == artifact.get("digest")
    )
    require(continuation.phone._document(content, "prod-release-status.json") == release)
    context = continuation.archive_context(
        REPOSITORY, run, release, owner.LANES["production"], **ports
    )
    if context is not None:
        origin = continuation.phone._document(content, continuation.ORIGIN)
        selected = origin["cold_rollback"]["origin"]
    else:
        # find_release already authenticated the ordinary healthy phone archive.
        # Follow the pointer to its original full cold proof; never trust it alone.
        observed = continuation.phone._document(content, "phone-rollback/workos-after.json")
        require(observed.get("qualification") == "passed")
        selected = observed["operational_observation"]["origin"]
    require(owner.uncached_api(REPOSITORY, f"runs/{match[1]}") == run)
    return selected


def from_anchor(anchor, source, job, artifact):
    """Validate only the direct live row in the final sealed schema receipt."""
    from workos_rollout import HISTORY_START, SOURCE_ANCHOR

    schema = anchor["sealed_boundary"]["installed_schema"]
    report = schema["workos"]
    receipt = report["receipt"]
    proof = importlib.import_module("production_backend_successor_proof")
    row = {
        "revision": REVISION,
        "source": source,
        "created_at": CREATED,
        "capable": True,
        "direct_sso_false": True,
    }
    matches = [r for r in receipt.get("revisions", []) if r.get("revision") == REVISION]
    require(
        report.get("qualification") == "passed" and report.get("digest") == proof.digest(receipt)
    )
    require(
        type(receipt.get("schema_version")) is int
        and receipt["schema_version"] == 1
        and receipt.get("qualification") == "passed"
        and receipt.get("project") == "hushh-pda"
        and receipt.get("region") == "us-central1"
        and receipt.get("service") == "consent-protocol"
        and receipt.get("scope") == "workos427_closed_initial_rollout"
        and receipt.get("restoration_source") == source
        and receipt.get("history_start") == HISTORY_START
        and receipt.get("source_anchor") == SOURCE_ANCHOR
        and receipt.get("audit_truncated") is False
        and receipt.get("sso_activation_qualified") is False
        and type(receipt.get("audit_event_count")) is int
        and 0 < receipt["audit_event_count"] < 500
        and matches == [row]
        and matches[0].get("capable") is True
        and matches[0].get("direct_sso_false") is True
        and all(
            receipt.get("database", {}).get(k) is True
            for k in ("memberships_empty", "sso_receipts_empty", "owned_proxy_exited")
        )
    )
    revision = schema["snapshot"]["revisions"][REVISION]
    service = schema["snapshot"]["services"]["consent-protocol"]
    require(
        revision.get("revision") == REVISION
        and revision.get("source") == source
        and isinstance(revision.get("uid"), str)
        and 0 < len(revision["uid"]) <= 256
        and isinstance(service.get("uid"), str)
        and 0 < len(service["uid"]) <= 256
    )
    steps = [
        s
        for s in job.get("steps", [])
        if s.get("name") == "Qualify final cold installed-schema proof"
    ]
    qualify_capture(receipt, steps, CREATED, artifact["created_at"])
    return {
        "row": row,
        "history_start": receipt["history_start"],
        "source_anchor": receipt["source_anchor"],
        "history_until": receipt["history_until"],
        "revision_uid": revision["uid"],
        "provenance": {
            "origin": anchor["origin"],
            "revision_uid": revision["uid"],
            "service_uid": service["uid"],
            "captured_at": receipt["captured_at"],
        },
    }


def load(source):
    owner = _authorities()
    proof = importlib.import_module("production_backend_successor_proof")
    control = importlib.import_module("production_backend_successor_control")
    tag = proof.read_original()
    anchor = control.record_anchor(tag)
    ports = _ports(owner)
    if anchor is None:
        origin = _healthy_origin(tag, proof, owner)
        anchor = proof.load(origin["run_id"], origin["run_attempt"], **ports)
        require(anchor["origin"] == origin)
    origin = anchor["origin"]
    run = owner.uncached_api(REPOSITORY, f"runs/{origin['run_id']}")
    require(
        str(run.get("id")) == origin["run_id"]
        and run.get("run_attempt") == origin["run_attempt"]
        and run.get("head_sha") == origin["workflow_sha"]
    )
    importlib.import_module("production_restoration_continuation").manual(run)
    jobs = owner.uncached_api(
        REPOSITORY, f"runs/{origin['run_id']}/attempts/{origin['run_attempt']}/jobs?per_page=100"
    )
    selected = [j for j in jobs.get("jobs", []) if j.get("name") == "Deploy Production Scope"]
    require(len(selected) == 1 and jobs.get("total_count") == len(jobs.get("jobs", [])))
    artifact = owner.uncached_api(REPOSITORY, f"artifacts/{origin['artifact_id']}")
    require(
        artifact.get("id") == origin["artifact_id"]
        and artifact.get("digest") == origin["artifact_digest"]
        and artifact.get("expired") is False
    )
    result = from_anchor(anchor, source, selected[0], artifact)
    require(
        owner.uncached_api(REPOSITORY, f"runs/{origin['run_id']}") == run
        and proof.read_original() == tag
    )
    return result


def validate_scope(observation, inventory, source, start, until, source_anchor):
    require(
        source is not None
        and observation["row"]
        == {
            "revision": REVISION,
            "source": source,
            "created_at": CREATED,
            "capable": True,
            "direct_sso_false": True,
        }
        and observation["row"]["capable"] is True
        and observation["row"]["direct_sso_false"] is True
        and observation["history_start"] == start
        and observation["source_anchor"] == source_anchor
        and instant(start)
        <= instant(CREATED)
        <= instant(observation["history_until"])
        <= instant(until)
        and REVISION not in inventory
    )

"""Inventory evidence for activation; retirement remains with its existing owner."""

from __future__ import annotations

import re
from collections.abc import Callable


def serving_candidate(service, revisions, *, expected_sha, expected_run, supports):
    traffic = [
        row
        for row in service.get("status", {}).get("traffic", [])
        if int(row.get("percent") or 0) > 0
    ]
    if len(traffic) != 1 or int(traffic[0].get("percent") or 0) != 100:
        raise ValueError("candidate_does_not_have_exact_serving_traffic")
    name = traffic[0].get("revisionName")
    matches = [row for row in revisions if row.get("metadata", {}).get("name") == name]
    if len(matches) != 1:
        raise ValueError("candidate_revision_unresolved")
    labels = matches[0]["metadata"].get("labels", {})
    if (
        labels.get("deploy-sha") != expected_sha
        or labels.get("github-run-id") != expected_run
        or labels.get("account-deletion-contract") != "v201"
    ):
        raise ValueError("candidate_provenance_unqualified")
    if not supports(expected_sha):
        raise ValueError("candidate_lacks_current_provider_contract")
    return name


def legacy_inventory(service, revisions, candidate, *, supports, phone_floor=False):
    legacy = set()
    for row in revisions:
        metadata = row.get("metadata", {})
        name, labels = metadata.get("name", ""), metadata.get("labels", {})
        if not re.fullmatch(r"[a-z0-9-]+", name):
            raise ValueError("invalid_revision_name")
        if labels.get("account-deletion-contract") != "v201" or not supports(
            labels.get("deploy-sha", ""), rollback=phone_floor
        ):
            legacy.add(name)
    if candidate in legacy:
        raise ValueError("candidate_is_legacy")
    tags = set()
    for row in service.get("status", {}).get("traffic", []):
        if row.get("revisionName") not in legacy:
            continue
        if int(row.get("percent") or 0) > 0:
            raise ValueError("legacy_revision_still_serves")
        if row.get("tag"):
            if not re.fullmatch(r"[a-z][a-z0-9-]{0,62}", row["tag"]):
                raise ValueError("invalid_legacy_tag")
            tags.add(row["tag"])
    return sorted(legacy), sorted(tags)


def _identity(metadata: dict) -> dict:
    uid, source = metadata.get("uid"), metadata.get("labels", {}).get("deploy-sha")
    if (
        not isinstance(uid, str)
        or not 0 < len(uid) <= 256
        or not isinstance(source, str)
        or not re.fullmatch(r"[0-9a-f]{40}", source)
    ):
        raise ValueError("activation_revision_identity_unknown")
    return {"revision": metadata["name"], "uid": uid, "source": source}


def activation_identity(args, service: dict, revisions: list[dict], candidate: str) -> dict:
    """Bind successful retirement evidence to the exact observed activation."""
    matches = [row for row in revisions if row.get("metadata", {}).get("name") == candidate]
    if len(matches) != 1:
        raise ValueError("activation_revision_inventory_ambiguous")
    identity = _identity(matches[0]["metadata"])
    service_uid = service.get("metadata", {}).get("uid")
    if (
        identity["source"] != args.expected_sha
        or not isinstance(service_uid, str)
        or not 0 < len(service_uid) <= 256
    ):
        raise ValueError("activation_service_identity_unknown")
    return {
        "schema_version": 1,
        "kind": "account-lifecycle-activation",
        "project": args.project,
        "region": args.region,
        "service": args.backend_service,
        "sha": args.expected_sha,
        "run_id": args.expected_run_id,
        "required_provider_contract": 2,
        "service_uid": service_uid,
        "candidate_revision": candidate,
        "candidate_uid": identity["uid"],
    }


def uat_tags_rollback(
    evidence, *, activation_succeeded, project, region, service, candidate, source, run_id, rollback
) -> str:
    """Omit only a rollback deleted by this run's successful canonical activation."""
    if activation_succeeded is not True or evidence is None:
        return rollback
    expected = {
        "schema_version": 1,
        "kind": "account-lifecycle-activation",
        "status": "activated",
        "project": project,
        "region": region,
        "service": service,
        "sha": source,
        "run_id": run_id,
        "required_provider_contract": 2,
        "candidate_revision": candidate,
        "database_preflight": "qualified",
        "fence_removal": "confirmed_absent",
    }
    if (
        project != "hushh-pda-uat"
        or region != "us-central1"
        or service != "consent-protocol"
        or not isinstance(source, str)
        or not re.fullmatch(r"[0-9a-f]{40}", source)
        or not isinstance(run_id, str)
        or not re.fullmatch(r"[1-9][0-9]*", run_id)
        or not isinstance(candidate, str)
        or not re.fullmatch(r"consent-protocol-[a-z0-9-]+", candidate)
        or not isinstance(evidence, dict)
        or type(evidence.get("schema_version")) is not int
        or any(evidence.get(key) != value for key, value in expected.items())
        or any(
            not isinstance(evidence.get(key), str) or not 0 < len(evidence[key]) <= 256
            for key in ("service_uid", "candidate_uid")
        )
    ):
        raise ValueError("uat_activation_retirement_origin_unqualified")
    retirement = evidence.get("retirement")
    retired = retirement.get("retired_revisions") if isinstance(retirement, dict) else None
    if (
        not isinstance(retired, list)
        or any(
            not isinstance(name, str) or not re.fullmatch(r"consent-protocol-[a-z0-9-]+", name)
            for name in retired
        )
        or len(set(retired)) != len(retired)
        or candidate in retired
        or retirement.get("status") != "retired"
        or type(retirement.get("retired_count")) is not int
        or retirement["retired_count"] != len(retired)
    ):
        raise ValueError("uat_activation_retired_inventory_unqualified")
    return "" if rollback in retired else rollback


def production_boundary(
    service: dict,
    revisions: list[dict],
    candidate: str,
    *,
    supports: Callable,
    fence_required: bool,
) -> dict:
    """Report observed zero-traffic revisions, without granting drain authority."""
    legacy, _tags = legacy_inventory(
        service, revisions, candidate, supports=supports, phone_floor=True
    )
    indexed = {row["metadata"]["name"]: _identity(row["metadata"]) for row in revisions}
    if len(indexed) != len(revisions):
        raise ValueError("activation_revision_inventory_ambiguous")
    if any(
        row.get("revisionName") not in indexed
        for row in service.get("status", {}).get("traffic", [])
    ):
        raise ValueError("activation_revision_inventory_incomplete")
    service_uid = service.get("metadata", {}).get("uid")
    if not isinstance(service_uid, str) or not 0 < len(service_uid) <= 256:
        raise ValueError("activation_service_identity_unknown")
    identity = indexed[candidate]
    result = {
        "service_uid": service_uid,
        "candidate_revision": candidate,
        "candidate_uid": identity["uid"],
    }
    if not legacy:
        return result
    if fence_required is not True:
        raise ValueError("pending_activation_requires_release_fence")
    pending = []
    for name in legacy:
        traffic = [
            row
            for row in service.get("status", {}).get("traffic", [])
            if row.get("revisionName") == name
        ]
        if any(int(row.get("percent") or 0) != 0 for row in traffic):
            raise ValueError("activation_pending_traffic_unknown")
        pending.append(
            {
                **indexed[name],
                "traffic_percent": 0,
                "tags": sorted({row["tag"] for row in traffic if row.get("tag")}),
            }
        )
    return {
        **result,
        "status": "pending_activation",
        "fence_required": True,
        "retirement": {
            "status": "pending",
            "pending_count": len(pending),
            "phone_admission_floor_required": True,
            "pending_revisions": pending,
        },
    }

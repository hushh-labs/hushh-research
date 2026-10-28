"""Bounded verification of the fixed private PLG frontend fixture.

This proves only that the observed fixture uses its verified runtime and does
not attach directly to Cloud SQL. It is not a deployment or traffic approval.
"""

from __future__ import annotations

import hashlib
import re


SERVICE = "hushh-webapp-plg-qual"
MAX_ATTEMPTS = 100


def _identity(revision, error):
    metadata = revision.get("metadata") or {}
    name = metadata.get("name")
    run_id = (metadata.get("labels") or {}).get("github-run-id")
    if not isinstance(run_id, str) or not re.fullmatch(r"[1-9][0-9]{0,19}", run_id):
        raise error("fixture revision run identity is unavailable")
    matches = [
        attempt
        for attempt in range(1, MAX_ATTEMPTS + 1)
        if name
        == SERVICE
        + "-q"
        + hashlib.sha256(f"{run_id}:{attempt}".encode()).hexdigest()[:12]
    ]
    if len(matches) != 1:
        raise error("fixture revision attempt identity is unavailable")
    return int(run_id), matches[0]


def _no_sql_mount(metadata, error):
    annotations = metadata.get("annotations") or {}
    if annotations.get("run.googleapis.com/cloudsql-instances"):
        raise error("fixture unexpectedly attaches Cloud SQL")


def _routes(traffic, observed, error):
    if not isinstance(traffic, list) or not 0 < len(traffic) <= 100:
        raise error("fixture service traffic inventory is unavailable")
    weights, tags = {}, {}
    for row in traffic:
        if not isinstance(row, dict) or row.get("latestRevision"):
            raise error("fixture service traffic is unresolved")
        name, percent, tag = (
            row.get("revisionName"),
            row.get("percent", 0),
            row.get("tag"),
        )
        if not isinstance(name, str) or name not in observed:
            raise error("fixture service references an unknown revision")
        if type(percent) is not int or not 0 <= percent <= 100:
            raise error("fixture traffic weight is invalid")
        if percent:
            weights[name] = weights.get(name, 0) + percent
        if tag is not None:
            if (
                not isinstance(tag, str)
                or tag in tags
                or tag != name.removeprefix(SERVICE + "-")
            ):
                raise error("fixture traffic tag is ambiguous or unowned")
            tags[tag] = name
    if sum(weights.values()) != 100:
        raise error("fixture traffic weights are incomplete")
    return weights, tags


def _traffic_references(service, observed, error):
    metadata, status = service.get("metadata") or {}, service.get("status") or {}
    generation = str(metadata.get("generation", ""))
    ready = [row for row in status.get("conditions", []) if row.get("type") == "Ready"]
    if (
        not re.fullmatch(r"[1-9][0-9]*", generation)
        or generation != str(status.get("observedGeneration"))
        or len(ready) != 1
        or ready[0].get("status") != "True"
    ):
        raise error("fixture service is not settled and ready")
    desired = _routes((service.get("spec") or {}).get("traffic"), observed, error)
    actual = _routes(status.get("traffic"), observed, error)
    if desired != actual:
        raise error("fixture desired and observed traffic differ")
    if any(
        status[key] not in observed
        for key in ("latestReadyRevisionName", "latestCreatedRevisionName")
        if status.get(key)
    ):
        raise error("fixture latest revision is unknown")


def verify(service, revisions, environment, history, error):
    """Verify every retained revision and the current service template.

    ``history`` is the Main-owned retained frontend reader, not user input.
    Every binding is provider-read and source-bound by that reader. No current
    backend tag health or production release authority is inferred here.
    """
    if environment not in {"dev", "uat"} or not isinstance(service, dict):
        raise error("fixture scope is invalid")
    metadata = service.get("metadata") or {}
    uid = metadata.get("uid")
    template = (service.get("spec") or {}).get("template") or {}
    template_metadata = template.get("metadata") or {}
    template_name = template_metadata.get("name")
    if metadata.get("name") != SERVICE or not isinstance(uid, str) or not uid:
        raise error("fixture service identity is unavailable")
    _no_sql_mount(metadata, error)
    _no_sql_mount(template_metadata, error)
    if not isinstance(revisions, list) or not revisions or len(revisions) > 100:
        raise error("fixture retained revision inventory is unavailable")
    observed = {}
    for revision in revisions:
        revision_metadata = revision.get("metadata") or {}
        name = revision_metadata.get("name")
        if not isinstance(name, str) or name in observed:
            raise error("fixture retained revision identity is ambiguous")
        _no_sql_mount(revision_metadata, error)
        run_id, attempt = _identity(revision, error)
        binding = history.read(environment, run_id, attempt)
        if (
            type(binding) is not history.RetainedFrontendBinding
            or binding.environment != environment
            or binding.run_id != run_id
            or binding.attempt != attempt
            or binding.service_uid != uid
            or binding.revision_uid != revision_metadata.get("uid")
        ):
            raise error("fixture native retained identity differs")
        desired = binding.service_document
        history.candidate.revision_matches(revision, desired)
        observed[name] = (revision, desired, binding.pin())
    if template_name not in observed:
        raise error("fixture service template is not an observed retained revision")
    _traffic_references(service, observed, error)
    revision, desired, _pin = observed[template_name]
    # Apply the same strict revision rules to the current service template.
    template_labels = dict(template_metadata.get("labels") or {})
    native_service = (revision["metadata"].get("labels") or {}).get(
        "serving.knative.dev/service"
    )
    if template_labels.get("serving.knative.dev/service", native_service) != SERVICE:
        raise error("fixture service template owner changed")
    template_labels["serving.knative.dev/service"] = native_service
    synthetic = {
        "metadata": dict(
            template_metadata, uid=revision["metadata"]["uid"], labels=template_labels
        ),
        "spec": template.get("spec"),
        "status": revision.get("status"),
    }
    history.candidate.revision_matches(synthetic, desired)
    return {
        "name": SERVICE,
        "connections": 0,
        "capacity_classification": "not-target-instance",
        "template_checked": True,
        "checked_revisions": sorted(observed),
        "fixture_bindings": [observed[name][2] for name in sorted(observed)],
    }

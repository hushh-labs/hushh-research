# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Close parsed issuer history against direct or authenticated original evidence."""

from __future__ import annotations

import re

SERVICE_COMPLETION_FORMAT = (
    "json(insertId,timestamp,logName,resource.labels,"
    "protoPayload.serviceName,protoPayload.methodName,protoPayload.resourceName,"
    "protoPayload.status,protoPayload.request,"
    "protoPayload.response.kind,protoPayload.response.metadata.name,"
    "protoPayload.response.metadata.uid,protoPayload.response.metadata.generation,"
    "protoPayload.response.status.latestCreatedRevisionName,"
    "protoPayload.response.spec.template.metadata,"
    "protoPayload.response.spec.template.spec.containers)"
)


def service_completion_filter(project, service, start, until, names):
    if not names or any(
        not isinstance(name, str)
        or not re.fullmatch(rf"{re.escape(service)}-[a-z0-9-]{{1,{62 - len(service)}}}", name)
        for name in names
    ):
        raise ValueError("workos_service_completion_unqualified")
    clause = " OR ".join(
        f'protoPayload.response.status.latestCreatedRevisionName="{name}"' for name in names
    )
    return (
        f'logName="projects/{project}/logs/cloudaudit.googleapis.com%2Fsystem_event" '
        'protoPayload.serviceName="run.googleapis.com" '
        f'resource.labels.service_name="{service}" '
        '(protoPayload.methodName="/Services.ReplaceService" '
        'OR protoPayload.methodName="/Services.CreateService") '
        f'protoPayload.response.kind="Service" ({clause}) '
        f'timestamp>="{start}" timestamp<="{until}"'
    )


def retired_capable_revisions(events, inventory, *, service, check, excluded=frozenset()):
    if not isinstance(events, list) or not isinstance(inventory, dict):
        return []
    pattern = rf"{re.escape(service)}-[a-z0-9-]{{1,{62 - len(service)}}}"
    found = set()
    for event in events:
        payload = (event.get("protoPayload") if isinstance(event, dict) else None) or {}
        svc = (payload.get("request") or {}).get("service") or {}
        template = (svc.get("spec") or {}).get("template") if isinstance(svc, dict) else None
        metadata = (template.get("metadata") if isinstance(template, dict) else None) or {}
        name = metadata.get("name")
        sha = (metadata.get("labels") or {}).get("deploy-sha")
        if (
            not isinstance(name, str)
            or not re.fullmatch(pattern, name)
            or name in inventory
            or name in excluded
        ):
            continue
        try:
            if check(sha):
                found.add(name)
        except Exception:
            continue
    return sorted(found)


def _valid_completion_envelope(event, project, region, service, start, until, instant):
    labels = (event.get("resource") or {}).get("labels") or {}
    payload = event.get("protoPayload") or {}
    response = payload.get("response") or {}
    meta = response.get("metadata") or {}
    try:
        stamp = instant(event.get("timestamp", ""))
    except Exception as error:
        raise ValueError("workos_service_completion_unqualified") from error
    if (
        event.get("logName") != f"projects/{project}/logs/cloudaudit.googleapis.com%2Fsystem_event"
        or labels.get("project_id") != project
        or labels.get("location") != region
        or labels.get("service_name") != service
        or payload.get("serviceName") != "run.googleapis.com"
        or payload.get("methodName") not in {"/Services.CreateService", "/Services.ReplaceService"}
        or payload.get("resourceName") != f"namespaces/{project}/services/{service}"
        or bool((payload.get("status") or {}).get("code"))
        or bool(payload.get("request"))
        or response.get("kind") != "Service"
        or meta.get("name") != service
        or not instant(start) <= stamp <= instant(until)
    ):
        raise ValueError("workos_service_completion_unqualified")
    return response, meta, stamp


def validate_service_completions(
    rows,
    *,
    project,
    region,
    service,
    start,
    until,
    instant,
    limit,
    service_uid=None,
    skip_names=frozenset(),
):
    if not isinstance(rows, list) or len(rows) >= limit:
        raise ValueError("workos_audit_history_incomplete")
    seen_ids, generations, stamps, accepted = set(), set(), {}, []
    observed_uid = service_uid
    for event in rows:
        if not isinstance(event, dict):
            raise ValueError("workos_service_completion_unqualified")
        response, meta, stamp = _valid_completion_envelope(
            event, project, region, service, start, until, instant
        )
        insert_id = event.get("insertId")
        uid, generation = meta.get("uid"), meta.get("generation")
        completed_name = (response.get("status") or {}).get("latestCreatedRevisionName")
        if (
            not isinstance(insert_id, str)
            or not insert_id
            or insert_id in seen_ids
            or not isinstance(uid, str)
            or not uid
            or (observed_uid is not None and uid != observed_uid)
            or type(generation) is not int
            or generation < 1
            or generation in generations
            or not isinstance(completed_name, str)
            or not completed_name
        ):
            raise ValueError("workos_service_completion_unqualified")
        template = (response.get("spec") or {}).get("template") or {}
        name = revision_name(template.get("metadata") or {}, completed_name, service)
        observed_uid = uid
        seen_ids.add(insert_id)
        generations.add(generation)
        if name in skip_names:
            continue
        stamps[name] = max(stamps.get(name, stamp), stamp)
        accepted.append(event)
    return accepted, stamps


def audit_scope(event, project, service, start, until, instant):
    labels = (event.get("resource") or {}).get("labels") or {}
    payload = event.get("protoPayload") or {}
    stamp = instant(event.get("timestamp", ""))
    if (
        labels.get("service_name") != service
        or payload.get("serviceName") != "run.googleapis.com"
        or event.get("logName") != f"projects/{project}/logs/cloudaudit.googleapis.com%2Factivity"
        or not instant(start) <= stamp <= instant(until)
    ):
        raise ValueError("workos_audit_scope_invalid")
    return stamp


def revision_name(metadata, completed_name, service):
    name = metadata.get("name") or completed_name
    if completed_name and name != completed_name:
        raise ValueError("workos_audit_revision_ambiguous")
    if not isinstance(name, str) or not re.fullmatch(
        rf"{re.escape(service)}-[a-z0-9-]{{1,{62 - len(service)}}}", name
    ):
        raise ValueError("workos_audit_revision_unknown")
    return name


def require_closed(
    templates, inventory, completions, *, check, closed_key, require_retained, start, instant
):
    seen = set()
    for name, sha, carried in templates:
        actual = inventory.get(name)
        if actual is not None and actual["source"] != sha:
            raise ValueError("workos_audit_revision_source_changed")
        completed = completions.get(name)
        if completed is not None and completed[0] != sha:
            raise ValueError("workos_audit_request_completion_mismatch")
        if check(sha) and (
            (require_retained and actual is None)
            or completed == (sha, False)
            or not (
                (actual is not None and actual[closed_key]) or completed == (sha, True) or carried
            )
        ):
            # Redacted requests supply no closure. Contrary completions always
            # win; authenticated original observations supply historical fact.
            raise ValueError("workos_historical_issuer_not_proven_closed")
        if actual is not None:
            seen.add(name)
    if any(
        instant(row["created_at"]) >= instant(start) and name not in seen
        for name, row in inventory.items()
    ):
        raise ValueError("workos_creation_history_not_yet_complete")

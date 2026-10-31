# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Close parsed issuer history against direct or authenticated original evidence."""

from __future__ import annotations

import re


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

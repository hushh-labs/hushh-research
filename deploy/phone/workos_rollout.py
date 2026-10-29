# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Prove that generation-bound WorkOS authority remains closed during rollout.

This is an initial-rollout qualifier, not an SSO activation or rollback waiver.
Cloud documents and database credentials stay in memory; receipts contain only
release metadata, aggregate booleans and counts. Unknown history refuses proof.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import subprocess
import time
from contextlib import closing
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from runpy import run_path

from consumer_compatibility import BASELINE
from qualify_image import run
from workos_database import _database_empty

ROOT = Path(__file__).resolve().parents[2]
REGION = "us-central1"
SERVICE = "consent-protocol"
SOURCE_ANCHOR = "134c748d842655bd21fd47fc8e65a6146c93198a"
# Before the first membership/profile-token source existed (05:04:46 UTC).
HISTORY_START = "2026-10-26T05:00:00Z"
LIMIT = 500
TARGETS = {
    "hushh-pda-dev": ("hushh-pda-dev:us-central1:hushh-dev-pg", "postgres"),
    "hushh-pda-uat": ("hushh-pda-uat:us-central1:hushh-uat-pg", "postgres"),
    "hushh-pda": ("hushh-pda:us-central1:hushh-vault-db", "hushh_vault"),
}
METHODS = frozenset(
    {
        "google.cloud.run.v1.Services.CreateService",
        "google.cloud.run.v1.Services.ReplaceService",
        "/Services.CreateService",
        "/Services.ReplaceService",
    }
)


def _instant(value: str) -> datetime:
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        raise ValueError("workos_history_timestamp_invalid")
    return stamp.astimezone(timezone.utc)


@lru_cache(maxsize=512)
def source_capable(sha: str) -> bool:
    """Only known main history at/before c2 is admitted as pre-427 source.

    Treat every other main source conservatively as capable, including sources
    whose author copied the new claims without the membership migration.
    """
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("workos_history_source_unknown")
    run(["git", "merge-base", "--is-ancestor", sha, "origin/main"])
    run(
        [
            "git",
            "cat-file",
            "-e",
            f"{SOURCE_ANCHOR}:consent-protocol/hushh_mcp/services/enterprise_sso/membership.py",
        ]
    )
    try:
        run(["git", "merge-base", "--is-ancestor", SOURCE_ANCHOR, sha])
    except subprocess.CalledProcessError as exc:
        if exc.returncode != 1:
            raise
    else:
        return True
    try:
        run(["git", "merge-base", "--is-ancestor", sha, BASELINE])
    except subprocess.CalledProcessError as exc:
        if exc.returncode != 1:
            raise
        return True
    return False


def _capable(sha: str, restoration_sha: str | None) -> bool:
    if restoration_sha is not None and sha == restoration_sha:
        run_path(str(ROOT / "deploy/account-deletion/compatibility_restoration.py"))[
            "qualify_source"
        ](sha)
        # Exact reviewed recovery still requires directly closed issuer history.
        return True
    return source_capable(sha)


def _source(labels: dict, check=None) -> str:
    if not isinstance(labels, dict):
        raise ValueError("workos_history_labels_invalid")
    sha = labels.get("deploy-sha")
    (check or source_capable)(sha)
    return sha


def revision_inventory(
    rows: list,
    restoration_sha: str | None = None,
    *,
    service=SERVICE,
    check=None,
    flag="WORKOS_SSO_ENABLED",
    closed_key="direct_sso_false",
    container_name=None,
) -> dict[str, dict]:
    check = check or (lambda sha: _capable(sha, restoration_sha))
    if not isinstance(rows, list) or not rows or len(rows) >= LIMIT:
        raise ValueError("workos_revision_inventory_incomplete")
    result = {}
    for row in rows:
        metadata, spec = row.get("metadata") or {}, row.get("spec") or {}
        name, created = metadata.get("name"), metadata.get("creationTimestamp")
        labels = metadata.get("labels") or {}
        if (
            not isinstance(name, str)
            or not re.fullmatch(rf"{re.escape(service)}-[a-z0-9-]{{1,{62 - len(service)}}}", name)
            or name in result
            or labels.get("serving.knative.dev/service") != service
        ):
            raise ValueError("workos_revision_identity_invalid")
        _instant(created)
        sha = _source(labels, check)
        containers = spec.get("containers") or []
        if container_name:
            containers = [row for row in containers if row.get("name") == container_name]
        if len(containers) != 1:
            raise ValueError("workos_revision_container_unknown")
        entries = containers[0].get("env") or []
        flags = [item for item in entries if item.get("name") == flag]
        closed = (
            len(flags) == 1 and flags[0].get("value") == "false" and "valueFrom" not in flags[0]
        )
        capable = check(sha)
        if capable and not closed:
            raise ValueError("workos_capable_revision_was_not_directly_closed")
        result[name] = {
            "revision": name,
            "source": sha,
            "created_at": created,
            "capable": capable,
            closed_key: closed,
        }
    return result


def _audit_templates(
    event: dict, *, kind="Service", project=None
) -> list[tuple[dict, str | None, bool]]:
    """Accept the observed v1 request/completion envelopes, never a guessed v2."""
    payload = event.get("protoPayload") or {}
    methods = (
        METHODS
        if kind == "Service"
        else {method.replace("Services", "Jobs").replace("Service", "Job") for method in METHODS}
    )
    if kind not in {"Service", "Job"} or payload.get("methodName") not in methods:
        raise ValueError("workos_audit_method_unknown")
    found = []
    request, response = payload.get("request") or {}, payload.get("response") or {}
    field = kind.lower()
    service = request.get(field)
    if "parent" in request and not (
        kind == "Service"
        and project in TARGETS
        and payload.get("methodName") == "google.cloud.run.v1.Services.CreateService"
        and request.get("@type") == "type.googleapis.com/google.cloud.run.v1.CreateServiceRequest"
        and request["parent"] == f"namespaces/{project}"
        and isinstance(service, dict)
        and service.get("metadata", {}).get("namespace") in (None, project)
    ):
        raise ValueError("workos_audit_request_parent_unknown")
    if request and (
        not set(request).issubset({"@type", "name", "parent", field})
        or not isinstance(service, dict)
        or not isinstance((service.get("spec") or {}).get("template"), dict)
    ):
        raise ValueError("workos_audit_request_shape_unknown")
    if isinstance(service, dict) and isinstance((service.get("spec") or {}).get("template"), dict):
        found.append((service["spec"]["template"], None, False))
    if isinstance(response.get("spec"), dict) and isinstance(
        response["spec"].get("template"), dict
    ):
        if response.get("kind") != kind:
            raise ValueError("workos_audit_response_unknown")
        name = (
            (response.get("status") or {}).get("latestCreatedRevisionName")
            if kind == "Service"
            else (response.get("metadata") or {}).get("name")
        )
        found.append((response["spec"]["template"], name, True))
    if not found:
        # Only explicit pre-creation RPC refusals may lack a template. A generic
        # provider/internal failure does not establish that no revision started.
        code = (payload.get("status") or {}).get("code")
        if not request and type(code) is int and code in {3, 5, 7, 16}:
            return []
        raise ValueError("workos_audit_template_unavailable")
    return found


def _completion_closed(template: dict, flag="WORKOS_SSO_ENABLED", container_name=None) -> bool:
    containers = (template.get("spec") or {}).get("containers") or []
    if container_name:
        containers = [row for row in containers if row.get("name") == container_name]
    if len(containers) != 1:
        raise ValueError("workos_audit_container_unknown")
    flags = [row for row in containers[0].get("env", []) if row.get("name") == flag]
    return len(flags) == 1 and flags[0].get("value") == "false" and "valueFrom" not in flags[0]


def review_history(
    events: list,
    inventory: dict[str, dict],
    *,
    project: str,
    until: str,
    restoration_sha: str | None = None,
    service=SERVICE,
    start=HISTORY_START,
    check=None,
    flag="WORKOS_SSO_ENABLED",
    closed_key="direct_sso_false",
    require_retained=False,
    container_name=None,
    historical_observation=None,
    operational_observation=None,
) -> int:
    check = check or (lambda sha: _capable(sha, restoration_sha))
    if not isinstance(events, list) or len(events) >= LIMIT:
        raise ValueError("workos_audit_history_incomplete")
    if historical_observation is not None or operational_observation is not None:
        from restoration_workos_observation import covers, validate_scope

        if (
            project != "hushh-pda"
            or service != SERVICE
            or flag != "WORKOS_SSO_ENABLED"
            or closed_key != "direct_sso_false"
            or require_retained
            or container_name is not None
        ):
            raise ValueError("workos_historical_observation_scope_invalid")
        context = (inventory, restoration_sha, start, until, SOURCE_ANCHOR)
        if historical_observation is not None:
            validate_scope(historical_observation, *context)
        if operational_observation is not None:
            from operational_workos_observation import (
                validate_scope as validate_operational,
            )

            validate_operational(operational_observation, *context)
    from workos_history import audit_scope, require_closed, revision_name

    templates, completions = [], {}
    for event in events:
        stamp = audit_scope(event, project, service, start, until, _instant)
        for template, completed_name, completion in _audit_templates(event, project=project):
            metadata = template.get("metadata") or {}
            sha = _source(metadata.get("labels") or {}, check)
            name = revision_name(metadata, completed_name, service)
            carried = historical_observation is not None and covers(
                historical_observation, name, sha, stamp, metadata
            )
            if operational_observation is not None:
                carried = covers(operational_observation, name, sha, stamp, metadata) or carried
            templates.append((name, sha, carried))
            if completion:
                observation = (sha, _completion_closed(template, flag, container_name))
                if name in completions and completions[name] != observation:
                    raise ValueError("workos_audit_completion_changed")
                completions[name] = observation
    require_closed(
        templates,
        inventory,
        completions,
        check=check,
        closed_key=closed_key,
        require_retained=require_retained,
        start=start,
        instant=_instant,
    )
    return len(events)


def _document(command: list[str]) -> object:
    return json.loads(run(command, timeout=120))


def _revisions(project: str, restoration_sha: str | None = None) -> dict[str, dict]:
    return revision_inventory(
        _document(
            [
                "gcloud",
                "run",
                "revisions",
                "list",
                f"--project={project}",
                f"--region={REGION}",
                f"--service={SERVICE}",
                f"--limit={LIMIT}",
                "--format=json",
            ]
        ),
        restoration_sha,
    )


def database_evidence(project: str, *, inspect=None) -> dict:
    """Read only aggregates through this invocation's bounded, owned proxy."""
    import psycopg2

    instance, database = TARGETS[project]
    credentials = [
        run(
            [
                "gcloud",
                "secrets",
                "versions",
                "access",
                "latest",
                f"--secret={name}",
                f"--project={project}",
            ]
        )
        .decode()
        .strip()
        for name in ("DB_USER", "DB_PASSWORD")
    ]
    if not all(credentials):
        raise ValueError("workos_database_credentials_unavailable")
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    command = ["cloud-sql-proxy", "--address=127.0.0.1", f"--port={port}", instance]
    if os.environ.get("GOOGLE_GHA_CREDS_PATH"):
        command.append("--credentials-file=" + os.environ["GOOGLE_GHA_CREDS_PATH"])
    group = run_path(str(ROOT / "scripts/ci/process_group.py"))["command_group"]
    with group(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as (
        proxy,
        stop,
    ):
        try:
            deadline = time.monotonic() + 20
            while True:
                if proxy.poll() is not None or time.monotonic() >= deadline:
                    raise ValueError("workos_owned_proxy_unavailable")
                with socket.socket() as probe:
                    probe.settimeout(0.2)
                    if probe.connect_ex(("127.0.0.1", port)) == 0:
                        break
                time.sleep(0.1)
            with closing(
                psycopg2.connect(
                    host="127.0.0.1",
                    port=port,
                    dbname=database,
                    user=credentials[0],
                    password=credentials[1],
                    connect_timeout=5,
                )
            ) as connection:
                try:
                    evidence = (inspect or _database_empty)(connection)
                finally:
                    connection.rollback()
        finally:
            stop()
            try:
                proxy.wait(timeout=5)
            except subprocess.TimeoutExpired:
                stop(force=True)
                proxy.wait(timeout=5)
    return {**evidence, "owned_proxy_exited": True}


def qualify(project: str, restoration_sha: str | None = None) -> dict:
    if project not in TARGETS:
        raise ValueError("workos_rollout_project_invalid")
    if project == "hushh-pda" and restoration_sha is None:
        authority = run_path(str(ROOT / "deploy/account-deletion/compatibility_restoration.py"))
        restoration_sha = authority["qualify_recorded_source"]()["sourceSha"]
    if restoration_sha is not None:
        if project != "hushh-pda":
            raise ValueError("workos_restoration_project_invalid")
        _capable(restoration_sha, restoration_sha)
    before = _revisions(project, restoration_sha)
    until = datetime.now(timezone.utc).isoformat()
    query = (
        f'logName="projects/{project}/logs/cloudaudit.googleapis.com%2Factivity" '
        'protoPayload.serviceName="run.googleapis.com" '
        f'resource.labels.service_name="{SERVICE}" '
        'protoPayload.methodName=~"(CreateService|ReplaceService|UpdateService)$" '
        f'timestamp>="{HISTORY_START}" timestamp<="{until}"'
    )
    events = _document(
        [
            "gcloud",
            "logging",
            "read",
            query,
            f"--project={project}",
            f"--limit={LIMIT}",
            "--order=asc",
            "--format=json",
        ]
    )
    from restoration_workos_observation import receipt_provenance, review

    count, historical = review(
        events,
        before,
        project=project,
        until=until,
        source=restoration_sha,
        reviewer=review_history,
    )
    database = database_evidence(project)
    after = _revisions(project, restoration_sha)
    if before != after:
        raise ValueError("workos_revision_inventory_changed_during_proof")
    return {
        "schema_version": 1,
        "qualification": "passed",
        "project": project,
        "region": REGION,
        "service": SERVICE,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "scope": "workos427_closed_initial_rollout",
        "history_start": HISTORY_START,
        "history_until": until,
        "source_anchor": SOURCE_ANCHOR,
        "restoration_source": restoration_sha,
        "audit_event_count": count,
        "audit_truncated": False,
        "revisions": sorted(before.values(), key=lambda row: row["revision"]),
        "database": database,
        "sso_activation_qualified": False,
        **receipt_provenance(historical),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", choices=tuple(TARGETS), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--restoration-sha", help="Exact reviewed production recovery source only")
    args = parser.parse_args()
    try:
        # A failed rerun must not leave an earlier passing receipt at this path.
        args.output.write_text(json.dumps({"qualification": "refused"}) + "\n")
        receipt = qualify(args.project, args.restoration_sha)
        args.output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    except Exception as exc:
        # Never print subprocess output, SQL errors, credentials or cloud bodies.
        code = (
            str(exc)
            if isinstance(exc, ValueError) and re.fullmatch(r"workos_[a-z0-9_]+", str(exc))
            else "unavailable"
        )
        print(f"WorkOS closed-rollout qualification refused: {type(exc).__name__}/{code}")
        return 1
    print("WorkOS closed-rollout qualification passed; activation remains unqualified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

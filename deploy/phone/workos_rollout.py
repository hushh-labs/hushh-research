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
        # Conservative classification: the exact recovery must still be
        # explicitly closed, including its immutable audit history.
        return True
    return source_capable(sha)


def _source(labels: dict, restoration_sha: str | None = None) -> str:
    if not isinstance(labels, dict):
        raise ValueError("workos_history_labels_invalid")
    sha = labels.get("deploy-sha")
    _capable(sha, restoration_sha)
    return sha


def revision_inventory(
    rows: list, restoration_sha: str | None = None
) -> dict[str, dict]:
    if not isinstance(rows, list) or not rows or len(rows) >= LIMIT:
        raise ValueError("workos_revision_inventory_incomplete")
    result = {}
    for row in rows:
        metadata, spec = row.get("metadata") or {}, row.get("spec") or {}
        name, created = metadata.get("name"), metadata.get("creationTimestamp")
        labels = metadata.get("labels") or {}
        if (
            not isinstance(name, str)
            or not re.fullmatch(r"consent-protocol-[a-z0-9-]{1,46}", name)
            or name in result
            or labels.get("serving.knative.dev/service") != SERVICE
        ):
            raise ValueError("workos_revision_identity_invalid")
        _instant(created)
        sha = _source(labels, restoration_sha)
        containers = spec.get("containers") or []
        if len(containers) != 1:
            raise ValueError("workos_revision_container_unknown")
        entries = containers[0].get("env") or []
        flags = [item for item in entries if item.get("name") == "WORKOS_SSO_ENABLED"]
        closed = (
            len(flags) == 1
            and flags[0].get("value") == "false"
            and "valueFrom" not in flags[0]
        )
        capable = _capable(sha, restoration_sha)
        if capable and not closed:
            raise ValueError("workos_capable_revision_was_not_directly_closed")
        result[name] = {
            "revision": name,
            "source": sha,
            "created_at": created,
            "capable": capable,
            "direct_sso_false": closed,
        }
    return result


def _audit_templates(event: dict) -> list[tuple[dict, str | None, bool]]:
    """Accept the observed v1 request/completion envelopes, never a guessed v2."""
    payload = event.get("protoPayload") or {}
    if payload.get("methodName") not in METHODS:
        raise ValueError("workos_audit_method_unknown")
    found = []
    request, response = payload.get("request") or {}, payload.get("response") or {}
    service = request.get("service")
    if request and (
        not set(request).issubset({"@type", "name", "service"})
        or not isinstance(service, dict)
        or not isinstance((service.get("spec") or {}).get("template"), dict)
    ):
        raise ValueError("workos_audit_request_shape_unknown")
    if isinstance(service, dict) and isinstance(
        (service.get("spec") or {}).get("template"), dict
    ):
        found.append((service["spec"]["template"], None, False))
    if isinstance(response.get("spec"), dict) and isinstance(
        response["spec"].get("template"), dict
    ):
        if response.get("kind") != "Service":
            raise ValueError("workos_audit_response_unknown")
        name = (response.get("status") or {}).get("latestCreatedRevisionName")
        found.append((response["spec"]["template"], name, True))
    if not found:
        # Only explicit pre-creation RPC refusals may lack a template. A generic
        # provider/internal failure does not establish that no revision started.
        code = (payload.get("status") or {}).get("code")
        if not request and type(code) is int and code in {3, 5, 7, 16}:
            return []
        raise ValueError("workos_audit_template_unavailable")
    return found


def _completion_closed(template: dict) -> bool:
    containers = (template.get("spec") or {}).get("containers") or []
    if len(containers) != 1:
        raise ValueError("workos_audit_container_unknown")
    flags = [
        row
        for row in containers[0].get("env", [])
        if row.get("name") == "WORKOS_SSO_ENABLED"
    ]
    return (
        len(flags) == 1
        and flags[0].get("value") == "false"
        and "valueFrom" not in flags[0]
    )


def review_history(
    events: list,
    inventory: dict[str, dict],
    *,
    project: str,
    until: str,
    restoration_sha: str | None = None,
) -> int:
    if not isinstance(events, list) or len(events) >= LIMIT:
        raise ValueError("workos_audit_history_incomplete")
    seen, templates, completions = set(), [], {}
    for event in events:
        labels = (event.get("resource") or {}).get("labels") or {}
        payload = event.get("protoPayload") or {}
        stamp = _instant(event.get("timestamp", ""))
        if (
            labels.get("service_name") != SERVICE
            or payload.get("serviceName") != "run.googleapis.com"
            or event.get("logName")
            != f"projects/{project}/logs/cloudaudit.googleapis.com%2Factivity"
            or not _instant(HISTORY_START) <= stamp <= _instant(until)
        ):
            raise ValueError("workos_audit_scope_invalid")
        for template, completed_name, completion in _audit_templates(event):
            metadata = template.get("metadata") or {}
            sha = _source(metadata.get("labels") or {}, restoration_sha)
            name = metadata.get("name") or completed_name
            if completed_name and name != completed_name:
                raise ValueError("workos_audit_revision_ambiguous")
            if not isinstance(name, str) or not re.fullmatch(
                r"consent-protocol-[a-z0-9-]{1,46}", name
            ):
                raise ValueError("workos_audit_revision_unknown")
            templates.append((name, sha))
            if completion:
                observation = (sha, _completion_closed(template))
                if name in completions and completions[name] != observation:
                    raise ValueError("workos_audit_completion_changed")
                completions[name] = observation
    for name, sha in templates:
        actual = inventory.get(name)
        if actual is not None and actual["source"] != sha:
            raise ValueError("workos_audit_revision_source_changed")
        completed = completions.get(name)
        if completed is not None and completed[0] != sha:
            raise ValueError("workos_audit_request_completion_mismatch")
        if _capable(sha, restoration_sha) and (
            completed == (sha, False)
            or not (
                (actual is not None and actual["direct_sso_false"])
                or completed == (sha, True)
            )
        ):
            # Requests redact env. Require the retained immutable revision
            # or its complete creation response; gone/unaccounted refuses.
            raise ValueError("workos_historical_issuer_not_proven_closed")
        if actual is not None:
            seen.add(name)
    if any(
        _instant(row["created_at"]) >= _instant(HISTORY_START) and name not in seen
        for name, row in inventory.items()
    ):
        raise ValueError("workos_creation_history_not_yet_complete")
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


def _database_empty(connection) -> dict:
    connection.set_session(
        isolation_level="REPEATABLE READ", readonly=True, autocommit=False
    )
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL statement_timeout='5000ms'")
        cursor.execute("SET LOCAL lock_timeout='3000ms'")
        cursor.execute(
            "SELECT to_regclass('public.account_workos_memberships') IS NOT NULL"
        )
        installed = cursor.fetchone()[0]
        if type(installed) is not bool:
            raise ValueError("workos_membership_inventory_unavailable")
        if installed:
            cursor.execute(
                "SELECT EXISTS(SELECT 1 FROM public.account_workos_memberships)"
            )
            if cursor.fetchone()[0] is not False:
                raise ValueError("workos_membership_authority_already_exists")
        cursor.execute(
            "SELECT to_regclass('public.account_firebase_mutations') IS NOT NULL"
        )
        receipts_installed = cursor.fetchone()[0]
        if type(receipts_installed) is not bool:
            raise ValueError("workos_receipt_inventory_unavailable")
        if receipts_installed:
            cursor.execute(
                "SELECT EXISTS(SELECT 1 FROM public.account_firebase_mutations WHERE purpose IN ('sso_claims','sso_create','sso_offboarding'))"
            )
            if cursor.fetchone()[0] is not False:
                raise ValueError("workos_mutation_authority_already_exists")
    return {
        "membership_table_exists": installed,
        "memberships_empty": True,
        "sso_receipts_empty": True,
        "receipt_table_exists": receipts_installed,
    }


def database_evidence(project: str) -> dict:
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
                    evidence = _database_empty(connection)
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
    count = review_history(
        events, before, project=project, until=until, restoration_sha=restoration_sha
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
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", choices=tuple(TARGETS), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--restoration-sha", help="Exact reviewed production recovery source only"
    )
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
            if isinstance(exc, ValueError)
            and re.fullmatch(r"workos_[a-z0-9_]+", str(exc))
            else "unavailable"
        )
        print(
            f"WorkOS closed-rollout qualification refused: {type(exc).__name__}/{code}"
        )
        return 1
    print("WorkOS closed-rollout qualification passed; activation remains unqualified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

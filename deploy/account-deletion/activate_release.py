#!/usr/bin/env python3
"""Activate the existing lifecycle only after exact release and drain evidence."""

from __future__ import annotations

import importlib.util
import json
import os
import re
import runpy
import socket
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
POLICY = "consent-protocol/config/account-deletion-authority.json"
MIGRATION = "423_account_shared_provider_authority.sql"
PHONE_MIGRATION = "425_account_phone_transfers.sql"
PHONE_ACTION_MIGRATION = "431_phone_recovery_actions.sql"
CONTRACT_SQL = """SELECT CASE WHEN EXISTS(SELECT 1 FROM pg_trigger
 WHERE tgrelid='public.account_deletion_tombstones'::regclass
 AND tgname='account_shared_provider_authority' AND tgenabled='O' AND NOT tgisinternal)
 THEN public.account_provider_cleanup_contract_version() ELSE 0 END"""


def run(argv, *, env=None, timeout=120):
    if not argv or argv[0] not in {"git", "gcloud", "psql", "bash"}:
        raise ValueError("unsupported_release_tool")
    # Fixed tool allowlist; arguments are separate, validated release values.
    result = subprocess.run(  # noqa: S603
        argv, env=env, capture_output=True, text=True, timeout=timeout
    )
    if result.returncode:
        # Provider diagnostics and secret-read stdout never enter artifacts.
        raise RuntimeError(f"{Path(argv[0]).name}_failed_{result.returncode}")
    return result.stdout.strip()


@lru_cache(maxsize=256)
def supports_current_contract(sha: str, *, rollback: bool = False) -> bool:
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        return False
    try:
        policy = json.loads(run(["git", "show", f"{sha}:{POLICY}"]))
        manifest = json.loads(
            run(
                [
                    "git",
                    "show",
                    f"{sha}:consent-protocol/db/release_migration_manifest.json",
                ]
            )
        )
        migrations = manifest.get("ordered_migrations", [])
        return (
            policy.get("version") == 1
            and MIGRATION in migrations
            and (
                not rollback
                or all(
                    name in migrations
                    for name in (PHONE_MIGRATION, PHONE_ACTION_MIGRATION)
                )
            )
        )
    except (RuntimeError, ValueError):
        return False


def restoration_authority():
    return runpy.run_path(str(Path(__file__).with_name("compatibility_restoration.py")))


def supports_restoration_source(sha: str) -> bool:
    try:
        restoration_authority()["qualify_source"](sha)
        return True
    except (ValueError, RuntimeError, OSError):
        return False


def serving_candidate(
    service, revisions, *, expected_sha, expected_run, restoration=False
):
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
    if not (
        restoration and supports_restoration_source(expected_sha)
    ) and not supports_current_contract(expected_sha):
        raise ValueError("candidate_lacks_current_provider_contract")
    return name


def legacy_inventory(
    service, revisions, candidate, *, phone_floor=False, restoration=False
):
    legacy = set()
    for row in revisions:
        metadata = row.get("metadata", {})
        name, labels = metadata.get("name", ""), metadata.get("labels", {})
        if not re.fullmatch(r"[a-z0-9-]+", name):
            raise ValueError("invalid_revision_name")
        supported = supports_current_contract(
            labels.get("deploy-sha", ""), rollback=phone_floor
        )
        if restoration and not phone_floor:
            supported = supported or supports_restoration_source(
                labels.get("deploy-sha", "")
            )
        if labels.get("account-deletion-contract") != "v201" or not supported:
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


@contextmanager
def database(args):
    with socket.socket() as sock:
        if sock.connect_ex(("127.0.0.1", args.db_port)) == 0:
            raise RuntimeError("owned_proxy_port_already_occupied")
    user = os.environ.get("DB_USER") or run(
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            "--secret=DB_USER",
            f"--project={args.project}",
        ]
    )
    password = os.environ.get("DB_PASSWORD") or run(
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            "--secret=DB_PASSWORD",
            f"--project={args.project}",
        ]
    )
    argv = ["cloud-sql-proxy", "--address", "127.0.0.1", "--port", str(args.db_port)]
    if os.environ.get("GOOGLE_GHA_CREDS_PATH"):
        argv.append("--credentials-file=" + os.environ["GOOGLE_GHA_CREDS_PATH"])
    argv.append(args.cloudsql_instance)
    # Fixed executable and environment-pinned instance; no shell expansion.
    proxy = subprocess.Popen(  # noqa: S603
        argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    try:
        deadline = time.monotonic() + 20
        while True:
            if proxy.poll() is not None:
                raise RuntimeError("owned_proxy_exited")
            with socket.socket() as sock:
                if sock.connect_ex(("127.0.0.1", args.db_port)) == 0:
                    break
            if time.monotonic() >= deadline:
                raise RuntimeError("owned_proxy_startup_deadline")
            time.sleep(0.25)
        yield {
            **os.environ,
            "PGHOST": "127.0.0.1",
            "PGPORT": str(args.db_port),
            "PGDATABASE": args.db_name,
            "PGUSER": user,
            "PGPASSWORD": password,
        }
    finally:
        if proxy.poll() is None:
            proxy.terminate()
            try:
                proxy.wait(timeout=8)
            except subprocess.TimeoutExpired:
                if proxy.poll() is None:
                    proxy.kill()
                proxy.wait(timeout=5)


def retain(args, suffix, value):
    prefix = Path(args.evidence_prefix)
    prefix.parent.mkdir(parents=True, exist_ok=True)
    prefix.with_name(prefix.name + "-" + suffix).write_text(value + "\n")


def observe(args):
    common = [f"--project={args.project}", f"--region={args.region}", "--format=json"]
    service = json.loads(
        run(["gcloud", "run", "services", "describe", args.backend_service, *common])
    )
    revisions = json.loads(
        run(
            [
                "gcloud",
                "run",
                "revisions",
                "list",
                f"--service={args.backend_service}",
                *common,
            ]
        )
    )
    candidate = serving_candidate(
        service,
        revisions,
        expected_sha=args.expected_sha,
        expected_run=args.expected_run_id,
        restoration=getattr(args, "production_restoration", False),
    )
    return service, revisions, candidate


def sql_value(pg, statement):
    return run(
        [
            "psql",
            "--no-psqlrc",
            "--set=ON_ERROR_STOP=1",
            "--tuples-only",
            "--no-align",
            "--command",
            statement,
        ],
        env=pg,
    )


def require_installed_contract(pg):
    if sql_value(pg, CONTRACT_SQL) != "2":
        raise RuntimeError("installed_provider_contract_unqualified")


def verify_boundary(pg, expected):
    return run(
        [
            "psql",
            "--no-psqlrc",
            "--set=ON_ERROR_STOP=1",
            "-v",
            f"expected_fence_count={expected}",
            "--file",
            str(ROOT / "deploy/account-deletion/verify_release_boundary.sql"),
        ],
        env=pg,
        timeout=330,
    )


def qualify_restoration_database(args, pg):
    if not getattr(args, "production_restoration", False):
        return
    if args.project != "hushh-pda" or args.db_name != "hushh_vault":
        raise ValueError("restoration_requires_production_target")
    import psycopg2

    authority = restoration_authority()
    record = authority["qualify_source"](args.expected_sha)
    connection = psycopg2.connect(
        host=pg["PGHOST"],
        port=pg["PGPORT"],
        dbname=pg["PGDATABASE"],
        user=pg["PGUSER"],
        password=pg["PGPASSWORD"],
        connect_timeout=10,
    )
    try:
        connection.set_session(readonly=True)
        proof = authority["qualify_schema"](
            connection, record, require_empty_documents=True
        )
        fence = runpy.run_path(
            str(Path(__file__).with_name("document_restoration_fence.py"))
        )
        fence["verify"](
            connection, source=args.expected_sha, run_id=args.expected_run_id
        )
        return {
            **proof,
            "sourceSha": args.expected_sha,
            "runId": args.expected_run_id,
            "documentFence": "verified",
        }
    finally:
        connection.close()


def qualify_database(args, retain):
    # Installed authority is qualified before Scheduler or revision mutations.
    with database(args) as pg:
        require_installed_contract(pg)
        restoration = qualify_restoration_database(args, pg)
        if restoration is not None:
            retain("restoration-qualification.json", json.dumps(restoration, indent=2))
        retain(
            "boundary-preactivation.log",
            verify_boundary(pg, 2 if args.fence_required else 0),
        )


def configure_scheduler(args, retain):
    env = {
        **os.environ,
        "PROJECT_ID": args.project,
        "SCHEDULER_LOCATION": args.region,
        "BACKEND_URL": args.backend_url,
        "OIDC_AUDIENCE": args.oidc_audience,
        "JOB_NAME": args.scheduler_job,
        "SCHEDULER_SERVICE_ACCOUNT_NAME": args.scheduler_service_account,
        "BATCH_LIMIT": "10",
    }
    setup = run(
        ["bash", str(ROOT / "deploy/account-deletion/setup_cleanup_scheduler.sh")],
        env=env,
    )
    retain("scheduler-setup.log", setup)
    triggered = datetime.now(timezone.utc).replace(microsecond=0)
    scheduler = [f"--project={args.project}", f"--location={args.region}"]
    config = run(
        [
            "gcloud",
            "scheduler",
            "jobs",
            "describe",
            args.scheduler_job,
            *scheduler,
            "--format=json(name,state,schedule,timeZone,httpTarget.uri,httpTarget.httpMethod,httpTarget.oidcToken.serviceAccountEmail,httpTarget.oidcToken.audience)",
        ]
    )
    retain("scheduler-config.json", config)
    run(["gcloud", "scheduler", "jobs", "run", args.scheduler_job, *scheduler])
    return triggered


def verify_scheduler_delivery(args, evidence, retain, triggered):
    job = f"projects/{args.project}/locations/{args.region}/jobs/{args.scheduler_job}"
    uri = args.backend_url.rstrip("/") + "/api/account/deletion-cleanup/drain?limit=10"
    spec = importlib.util.spec_from_file_location(
        "scheduler_attempt", ROOT / "scripts/ci/verify-cloud-scheduler-attempt.py"
    )
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    query = (
        f'resource.type="cloud_scheduler_job" AND resource.labels.project_id="{args.project}" '
        f'AND resource.labels.location="{args.region}" AND resource.labels.job_id="{args.scheduler_job}" '
        f'AND timestamp>="{triggered.isoformat()}" AND jsonPayload."@type"="{verifier.ATTEMPT_FINISHED_TYPE}"'
    )
    deadline = time.monotonic() + 360
    while True:
        logs = json.loads(
            run(
                [
                    "gcloud",
                    "logging",
                    "read",
                    query,
                    f"--project={args.project}",
                    "--freshness=10m",
                    "--order=desc",
                    "--limit=20",
                    "--format=json",
                ]
            )
        )
        finished = verifier.successful_completion(
            logs, triggered_at=triggered, expected_job=job, expected_uri=uri
        )
        evidence["scheduler"] = {
            "status": "healthy" if finished else "waiting",
            "triggered_at": triggered.isoformat(),
            "checks": {
                "fresh_attempt_finished": finished is not None,
                "http_2xx": finished is not None,
            },
            "completion": finished,
        }
        if finished:
            # Preserve the completion output without arbitrary log payloads.
            retain("scheduler-finished-logs.json", json.dumps([finished], indent=2))
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("scheduler_has_no_fresh_successful_http_completion")
        time.sleep(5)


def retire_incompatible_revisions(args, evidence, service, revisions, candidate):
    phone_floor = supports_current_contract(args.expected_sha, rollback=True)
    legacy, tags = legacy_inventory(
        service,
        revisions,
        candidate,
        phone_floor=phone_floor,
        restoration=getattr(args, "production_restoration", False),
    )
    if tags:
        run(
            [
                "gcloud",
                "run",
                "services",
                "update-traffic",
                args.backend_service,
                f"--project={args.project}",
                f"--region={args.region}",
                "--remove-tags=" + ",".join(tags),
            ]
        )
    for revision in legacy:
        run(
            [
                "gcloud",
                "run",
                "revisions",
                "delete",
                revision,
                f"--project={args.project}",
                f"--region={args.region}",
                "--quiet",
            ]
        )
    service, revisions, candidate = observe(args)
    remaining, _ = legacy_inventory(
        service,
        revisions,
        candidate,
        phone_floor=phone_floor,
        restoration=getattr(args, "production_restoration", False),
    )
    if remaining:
        raise RuntimeError("legacy_provider_revisions_remain")
    evidence["retirement"] = {
        "status": "retired",
        "retired_count": len(legacy),
        "remaining_pre_v201_count": 0,
        "remaining_pre_provider_v2_count": 0,
        "phone_admission_floor_required": phone_floor,
        "remaining_pre_phone425_count": 0 if phone_floor else None,
        "remaining_pre_phone431_count": 0 if phone_floor else None,
    }
    evidence["candidate_revision"] = candidate


def reopen_deletion(args, evidence, retain):
    with database(args) as pg:
        psql = ["psql", "--no-psqlrc", "--set=ON_ERROR_STOP=1"]
        require_installed_contract(pg)
        restoration = qualify_restoration_database(args, pg)
        if restoration is not None:
            evidence["production_restoration"] = restoration
        verify_boundary(pg, 2 if args.fence_required else 0)
        health = sql_value(
            pg,
            """SELECT json_build_object(
              'counts_by_status', COALESCE((SELECT json_object_agg(cleanup_status,n)
                FROM (SELECT cleanup_status,count(*) AS n
                  FROM public.account_deletion_tombstones GROUP BY cleanup_status) grouped),'{}'::json),
              'oldest_due_age_seconds', COALESCE((SELECT
                floor(extract(epoch FROM (now()-min(cleanup_next_attempt_at))))::bigint
                FROM public.account_deletion_tombstones WHERE firebase_uid IS NOT NULL
                AND cleanup_status<>'completed' AND cleanup_next_attempt_at<=now()),0))""",
        )
        evidence["cleanup_health"] = json.loads(health)
        # Traffic can change while Scheduler and retirement are being qualified.
        observe(args)
        if args.fence_required:
            evidence["fence_removal"] = "requested_outcome_unconfirmed"
            removal = run(
                [
                    *psql,
                    "--file",
                    str(ROOT / "deploy/account-deletion/remove_release_fence.sql"),
                ],
                env=pg,
            )
            evidence["fence_removal"] = "acknowledged"
            retain("fence-removal.log", removal)
        retain("boundary.log", verify_boundary(pg, 0))
        evidence["fence_removal"] = "confirmed_absent"
    evidence["status"] = "activated"


def activate(args, evidence):
    def save(suffix, value):
        retain(args, suffix, value)

    service, revisions, candidate = observe(args)
    qualify_database(args, save)
    evidence["database_preflight"] = "qualified"
    triggered = configure_scheduler(args, save)
    verify_scheduler_delivery(args, evidence, save, triggered)
    retire_incompatible_revisions(args, evidence, service, revisions, candidate)
    reopen_deletion(args, evidence, save)


def parse_arguments():
    spec = importlib.util.spec_from_file_location(
        "account_deletion_release_target", Path(__file__).with_name("release_target.py")
    )
    target = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(target)
    return target.parse_arguments()


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--qualify-restoration-source":
        if not supports_restoration_source(sys.argv[2]):
            raise SystemExit("Source is not the exact reviewed production restoration")
        return 0
    if len(sys.argv) == 3 and sys.argv[1] in (
        "--qualify-source",
        "--qualify-rollback-source",
    ):
        rollback = sys.argv[1] == "--qualify-rollback-source"
        if not supports_current_contract(sys.argv[2], rollback=rollback):
            raise SystemExit(
                "Target lacks the phone/device admission rollback contract (migrations 425 and 431)"
                if rollback
                else "Target lacks the current account lifecycle producer contract"
            )
        return 0
    args = parse_arguments()
    evidence = {
        "status": "blocked",
        "sha": args.expected_sha,
        "run_id": args.expected_run_id,
        "project": args.project,
        "required_provider_contract": 2,
    }
    code = 0
    try:
        activate(args, evidence)
    except Exception as exc:
        evidence["failure_type"] = type(exc).__name__
        if re.fullmatch(r"[a-z0-9_]+", str(exc)):
            evidence["failure_code"] = str(exc)
        print("Account lifecycle activation failed; release remains blocked.")
        code = 1
    finally:
        prefix = Path(args.evidence_prefix)
        prefix.parent.mkdir(parents=True, exist_ok=True)
        prefix.with_name(prefix.name + "-activation.json").write_text(
            json.dumps(evidence, indent=2) + "\n"
        )
        for suffix, key in [
            ("scheduler-evidence", "scheduler"),
            ("revision-retirement", "retirement"),
            ("cleanup-health", "cleanup_health"),
        ]:
            if key in evidence:
                prefix.with_name(prefix.name + "-" + suffix + ".json").write_text(
                    json.dumps(evidence[key], indent=2) + "\n"
                )
    return code


if __name__ == "__main__":
    raise SystemExit(main())

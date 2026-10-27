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
from functools import lru_cache, partial
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = runpy.run_path(str(Path(__file__).with_name("release_source.py")))
supports_restoration_source = SOURCE["supports_restoration_source"]
qualify_restoration_database = SOURCE["qualify_restoration_database"]
CONTRACT_SQL = """SELECT CASE WHEN EXISTS(SELECT 1 FROM pg_trigger
 WHERE tgrelid='public.account_deletion_tombstones'::regclass
 AND tgname='account_shared_provider_authority' AND tgenabled='O' AND NOT tgisinternal)
 THEN public.account_provider_cleanup_contract_version() ELSE 0 END"""


def run(argv, *, env=None, timeout=120):
    if not argv or argv[0] not in {"git", "gcloud", "psql", "bash"}:
        raise ValueError("unsupported_release_tool")
    result = subprocess.run(  # noqa: S603
        argv, env=env, capture_output=True, text=True, timeout=timeout
    )
    if result.returncode:
        # Provider diagnostics and secret-read stdout never enter artifacts.
        raise RuntimeError(f"{Path(argv[0]).name}_failed_{result.returncode}")
    return result.stdout.strip()


@lru_cache(maxsize=256)
def supports_current_contract(sha: str, *, rollback: bool = False) -> bool:
    return SOURCE["supports_current_contract"](sha, run=run, rollback=rollback)


def _supports_activation_source(sha, *, rollback=False, restoration=False):
    return supports_current_contract(sha, rollback=rollback) or (
        restoration and not rollback and supports_restoration_source(sha)
    )


def serving_candidate(service, revisions, *, expected_sha, expected_run, restoration=False):
    return retirement_owner().serving_candidate(
        service,
        revisions,
        expected_sha=expected_sha,
        expected_run=expected_run,
        supports=partial(_supports_activation_source, restoration=restoration),
    )


@lru_cache(maxsize=1)
def retirement_owner():
    spec = importlib.util.spec_from_file_location(
        "activation_retirement", Path(__file__).with_name("activation_retirement.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def legacy_inventory(service, revisions, candidate, *, phone_floor=False, restoration=False):
    return retirement_owner().legacy_inventory(
        service,
        revisions,
        candidate,
        supports=partial(_supports_activation_source, restoration=restoration),
        phone_floor=phone_floor,
    )


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
        "retired_revisions": legacy,
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
    evidence.update(retirement_owner().activation_identity(args, service, revisions, candidate))
    if args.project == "hushh-pda" and supports_current_contract(args.expected_sha, rollback=True):
        service, revisions, candidate = observe(args)
        evidence.update(
            schema_version=1,
            kind="account-lifecycle-activation",
            project=args.project,
            region=args.region,
            service=args.backend_service,
            sha=args.expected_sha,
            run_id=args.expected_run_id,
            required_provider_contract=2,
            **retirement_owner().production_boundary(
                service,
                revisions,
                candidate,
                supports=supports_current_contract,
                fence_required=args.fence_required,
            ),
        )
        if evidence.get("status") == "pending_activation":
            return
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
    if SOURCE["qualify_cli"](sys.argv, supports_current_contract, supports_restoration_source):
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

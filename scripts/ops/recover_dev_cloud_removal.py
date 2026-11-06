#!/usr/bin/env python3
"""Inspect or resume an existing legacy removal; never creates/deletes projects.

Inspection is the default. Prepare/execute require explicit Dev, --apply, and the
reviewed native plan digest. The existing authenticated UI supplies owner approval.
Credentials remain in memory; the supervisor uses private pipes, never argv/env.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import json
import os
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "consent-protocol"))


@contextlib.contextmanager
def dev_database(port: int, *, readonly: bool):
    import google.auth
    from google.auth.transport.requests import AuthorizedSession
    from sqlalchemy import URL, create_engine

    from hushh_mcp.services.legacy_cloud_removal import _require

    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"],
        quota_project_id="hushh-pda-dev",
    )
    with AuthorizedSession(credentials) as session:

        def get(url):
            response = session.get(url, timeout=25, allow_redirects=False)
            _require(response.status_code == 200, "CLOUD_REMOVAL_DEV_ACCESS_UNAVAILABLE")
            return response.json()

        base = "https://us-central1-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/hushh-pda-dev/"
        service = get(base + "services/consent-protocol")
        traffic = [entry for entry in service["status"]["traffic"] if entry.get("percent", 0)]
        _require(len(traffic) == 1 and traffic[0]["percent"] == 100)
        runtime = get(base + "revisions/" + traffic[0]["revisionName"])
        env = {entry["name"]: entry for entry in runtime["spec"]["containers"][0]["env"]}
        _require(env["ENVIRONMENT"].get("value") == env["HUSHH_DEPLOY_ENV"].get("value") == "dev")
        source = env["HUSHH_DEPLOY_SHA"]["value"]

        def secret(name):
            reference = env[name]["valueFrom"]["secretKeyRef"]
            _require(reference["name"] == name)
            body = get(
                f"https://secretmanager.googleapis.com/v1/projects/hushh-pda-dev/secrets/{name}/versions/{reference['key']}:access"
            )
            return base64.b64decode(body["payload"]["data"]).decode()

        config = json.loads(secret("BACKEND_RUNTIME_CONFIG_JSON"))
        _require(
            (
                config.get("cloudsql_instance_connection_name") or config.get("db_unix_socket", "")
            ).removeprefix("/cloudsql/")
            == "hushh-pda-dev:us-central1:hushh-dev-pg"
        )
        _require(config.get("db_name", "postgres") == "postgres")
        user = secret("DB_USER")
        _require(user == "hushh_uat_app")
        engine = create_engine(
            URL.create(
                "postgresql+psycopg2",
                username=user,
                password=secret("DB_PASSWORD"),
                host="127.0.0.1",
                port=port,
                database="postgres",
            ),
            connect_args={
                "options": "-c statement_timeout=10000 -c lock_timeout=1000 -c default_transaction_read_only="
                + ("on" if readonly else "off")
            },
            pool_size=2,
            max_overflow=0,
        )
        try:
            with engine.connect() as conn:
                from sqlalchemy import text

                observed = conn.execute(
                    text(
                        "SELECT current_database(),current_user,session_user,encode(sha256(convert_to(system_identifier::text,'UTF8')),'hex') FROM pg_control_system()"
                    )
                ).one()
                _require(
                    tuple(observed)
                    == (
                        "postgres",
                        user,
                        user,
                        "320fe60c039c7a44aa11e7b670de5e3576d9c4ab7e95de76657719b6c56810b0",
                    )
                )
            yield engine, source
        finally:
            engine.dispose()


def retained(engine, owner: str, attempt: str):
    from sqlalchemy import text

    from hushh_mcp.services.account_generation_service import AccountGenerationService
    from hushh_mcp.services.legacy_cloud_removal import _require

    with engine.connect() as conn:
        # Resolve the exact retained application owner through the canonical
        # generation service. An email or raw Firebase UID never selects a row.
        identity = AccountGenerationService.identity_in_transaction(conn, owner)
        row = (
            conn.execute(
                text("SELECT generation,retired_at FROM account_generations WHERE owner_id=:owner"),
                {"owner": owner},
            )
            .mappings()
            .first()
        )
        _require(
            row is None
            and identity == owner
            or row is not None
            and row["generation"] == 0
            and row["retired_at"] is None
        )
        found = (
            conn.execute(
                text(
                    "SELECT p.backend_metadata->'erasure' AS reservation,c.snapshot_sha256,"
                    "public.effective_erasure_substrate_inventory(p.backend_metadata->'erasure') AS inventory,"
                    "to_jsonb(c)->'recovery' AS recovery FROM personal_agent_registry p JOIN personal_agent_cloud_removals c ON c.user_id=p.user_id "
                    "WHERE p.user_id=:owner AND c.attempt_id=:attempt AND p.status='suspended' AND c.completed_at IS NULL AND c.cancelled_at IS NULL"
                ),
                {"owner": owner, "attempt": attempt},
            )
            .mappings()
            .first()
        )
        _require(found is not None and found["reservation"]["attemptId"] == attempt)
        return dict(found)


def owner_credentials(args):
    from google.oauth2.credentials import Credentials
    import requests

    from hushh_mcp.services.legacy_cloud_removal import _require

    _require(args.account is not None and "@" in args.account)
    response = subprocess.run(
        [
            args.gcloud,
            "auth",
            "print-access-token",
            "--account=" + args.account,
            "--project=" + args.project,
        ],
        capture_output=True,
        text=True,
        timeout=40,
    )
    _require(
        response.returncode == 0 and bool(response.stdout.strip()),
        "CLOUD_REMOVAL_OWNER_ACCESS_UNAVAILABLE",
    )
    with requests.Session() as session:
        identity = session.get(
            "https://openidconnect.googleapis.com/v1/userinfo",
            headers={"Authorization": "Bearer " + response.stdout.strip()},
            timeout=25,
            allow_redirects=False,
        )
        _require(
            identity.status_code == 200
            and identity.json().get("email") == args.account
            and identity.json().get("email_verified") is True,
            "CLOUD_REMOVAL_OPERATOR_IDENTITY_UNVERIFIED",
        )
    return Credentials(token=response.stdout.strip())


def execute(args, engine, source, reservation, credentials, started_pipe):
    from hushh_mcp.services.legacy_cloud_removal import (
        LegacyRemovalJournal,
        _require,
        resource_key,
        resource_state,
    )
    from hushh_mcp.services.legacy_cloud_removal_executor import LegacyGcpRemoval
    from hushh_mcp.services.legacy_cloud_removal_native import RecoverySession
    from hushh_mcp.services.legacy_cloud_removal_writer import (
        admit_disabled_writer_compute,
        cached_writer_probe,
        disable_writer,
        qualify_writer_after_compute,
        verify_disabled_writer,
    )
    from hushh_mcp.services.legacy_cloud_removal_teardown import delete_remaining

    raw = engine.raw_connection()
    conn = raw.driver_connection
    conn.autocommit = True
    journal = LegacyRemovalJournal(conn, args.owner, args.attempt)
    try:
        started = journal.start(args.execution_id, source)
        print(json.dumps(started), file=started_pipe, flush=True)
        with RecoverySession(
            token=credentials.token, project=args.project, journal=journal
        ) as session:
            worker = LegacyGcpRemoval(session=session, journal=journal)
            _require(journal.read()["planSha256"] == args.manifest_sha256)
            require_cleanup_authority(worker)
            runtime = worker._resource(
                "service_account", worker.plan["runtime"]["principal"]["email"]
            )
            state = resource_state(journal.read(), resource_key(runtime))
            compute_first = False
            if "writer_disabled" in state or "native_writer_disabled_after_compute" in state:
                verify_disabled_writer(worker)
            elif "writer_acknowledgement" in state:
                # A prior worker may have exited with its cached probe token.
                # Never re-enable the identity or manufacture credential denial.
                admit_disabled_writer_compute(worker)
                compute_first = True
            else:
                token = cached_writer_probe(worker, actor=args.account)
                disable_writer(worker, cached_token=token)
                del token
            worker.delete_compute(credentials=credentials)
            if compute_first:
                qualify_writer_after_compute(worker, token=credentials.token)
            worker.delete_memory()
            pending = delete_remaining(worker, token=credentials.token, reservation=reservation)
            if pending:
                journal.append(
                    "$executor",
                    "attention",
                    {
                        "code": "CLOUD_REMOVAL_PROVIDER_RETENTION_PENDING",
                        "uncertain": False,
                    },
                )
            return 0
    except Exception as exc:
        # Never print provider request bodies, SQL connection strings or credentials.
        code = (
            str(exc)
            if str(exc).isupper() and len(str(exc)) <= 64
            else "CLOUD_REMOVAL_RECOVERY_INTERRUPTED"
        )
        try:
            journal.append("$executor", "attention", {"code": code, "uncertain": True})
        except Exception:
            print("CLOUD_REMOVAL_JOURNAL_UNAVAILABLE", file=sys.stderr)
        print(code, file=sys.stderr)
        return 1
    finally:
        raw.close()


def require_cleanup_authority(worker):
    from hushh_mcp.services.legacy_cloud_removal import (
        _require,
        resource_key,
        resource_state,
    )
    from hushh_mcp.services.legacy_cloud_removal_native import resource_url
    from hushh_mcp.services.legacy_cloud_removal_teardown import (
        recover_bucket_acknowledgement,
    )

    permissions = {
        "aiplatform.reasoningEngines.delete",
        "run.services.delete",
        "iam.serviceAccounts.disable",
        "cloudkms.cryptoKeyVersions.destroy",
    }
    authority = worker.session.post(
        f"https://cloudresourcemanager.googleapis.com/v1/projects/{worker.project}:testIamPermissions",
        json={"permissions": sorted(permissions)},
    )
    _require(
        authority.status_code == 200
        and set(authority.json().get("permissions", [])) == permissions,
        "CLOUD_REMOVAL_INDEPENDENT_AUTHORITY_UNAVAILABLE",
    )
    # Storage grants are evaluated on the retained bucket, not its project.
    bucket = worker._resource("gcs_bucket", worker.plan["memory"]["bucket"])
    bucket_state = resource_state(worker.journal.read(), resource_key(bucket))
    if bucket_state.get("observation", {}).get("status") == "deleted":
        _require(
            bucket_state["observation"].get("identitySha256")
            == worker.journal.identity_sha256(bucket)
            and bucket_state.get("checkpoint", {}).get("stage") == "bucketDeletion"
        )
        for params in (
            {},
            {"softDeleted": True, "generation": bucket["identity"]["generation"]},
        ):
            current = worker.session.get(
                resource_url(worker.project, worker.region, bucket), params=params
            )
            _require(current.status_code == 404, "CLOUD_REMOVAL_RESOURCE_REPLACED")
        return
    if worker._checkpoints(bucket).get("bucketAdmission") is not None:
        recover_bucket_acknowledgement(worker, bucket)
        current = worker.session.get(resource_url(worker.project, worker.region, bucket))
        _require(current.status_code == 404, "CLOUD_REMOVAL_RESOURCE_REPLACED")
        historical = worker.session.get(
            resource_url(worker.project, worker.region, bucket),
            params={
                "softDeleted": True,
                "generation": bucket["identity"]["generation"],
            },
        )
        _require(
            historical.status_code in {200, 404},
            "CLOUD_REMOVAL_NATIVE_READ_UNAVAILABLE",
        )
        if historical.status_code == 200:
            from hushh_mcp.services.legacy_cloud_removal_native import native_identity

            _require(
                native_identity("gcs_bucket", historical.json()) == bucket["identity"],
                "CLOUD_REMOVAL_RESOURCE_REPLACED",
            )
        return
    permissions = {
        "storage.objects.delete",
        "storage.objects.list",
        "storage.objects.get",
    }
    authority = worker.session.get(
        resource_url(worker.project, worker.region, bucket) + "/iam/testPermissions",
        params={"permissions": sorted(permissions)},
    )
    _require(
        authority.status_code == 200
        and set(authority.json().get("permissions", [])) == permissions,
        "CLOUD_REMOVAL_INDEPENDENT_AUTHORITY_UNAVAILABLE",
    )


def require_operator_source(expected_source):
    from hushh_mcp.services.legacy_cloud_removal import _require

    head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    _require(head == expected_source, "CLOUD_REMOVAL_SOURCE_CHANGED")
    _require(
        not subprocess.run(
            [
                "git",
                "diff",
                "--quiet",
                "HEAD",
                "--",
                "consent-protocol",
                "scripts/ops/recover_dev_cloud_removal.py",
            ],
            cwd=ROOT,
        ).returncode,
        "CLOUD_REMOVAL_SOURCE_CHANGED",
    )
    return head


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action",
        choices=("inspect", "prepare", "adopt-operator", "execute", "status"),
        nargs="?",
        default="inspect",
    )
    parser.add_argument("--dev", action="store_true", required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--account")
    parser.add_argument("--gcloud", default="gcloud")
    parser.add_argument("--port", type=int, default=63391)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--manifest-sha256")
    parser.add_argument("--plan", type=Path)
    return parser.parse_args()


def supervise(journal, payload):
    from hushh_mcp.services.legacy_cloud_removal import record_supervised_exit

    read_fd, write_fd = os.pipe()
    payload["startedFd"] = write_fd
    process = subprocess.Popen(
        [sys.executable, __file__, "--internal-worker"],
        stdin=subprocess.PIPE,
        pass_fds=(write_fd,),
        cwd=ROOT,
        text=True,
    )
    os.close(write_fd)
    recorded = False
    try:
        with os.fdopen(read_fd) as pipe:
            process.stdin.write(json.dumps(payload))
            process.stdin.close()
            started = json.loads(pipe.readline(4096))
        status = record_supervised_exit(journal, process, started)
        recorded = True
        return status
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=40)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=40)
        if not recorded:
            # EOF or cancellation can lose the pipe receipt after SQL retained
            # it. Join the real child, then recover only this invocation's start.
            started = next(
                (
                    event["receipt"]
                    for event in journal.read()["events"]
                    if event["stage"] == "executor_started"
                    and event["receipt"]["executionId"] == payload["args"]["execution_id"]
                ),
                None,
            )
            if started is not None:
                record_supervised_exit(journal, process, started)


def main():
    args = arguments()

    from hushh_mcp.services.legacy_cloud_removal import (
        LegacyRemovalJournal,
        _require,
        operator_source,
        validate_plan,
    )
    from hushh_mcp.services.legacy_cloud_removal_native import (
        RecoverySession,
        observe_plan,
    )

    mutation = args.action in {"prepare", "adopt-operator", "execute"}
    _require(not mutation or args.apply and args.manifest_sha256 is not None)
    with dev_database(args.port, readonly=not mutation) as (engine, source):
        row = retained(engine, args.owner, args.attempt)
        _require(row["reservation"]["registrySnapshot"]["user_cloud_project"] == args.project)
        if args.action == "status":
            print(json.dumps({"source": source, "recovery": row["recovery"]}, default=str))
            return 0
        credentials = owner_credentials(args)
        if args.action == "inspect":
            with RecoverySession(token=credentials.token, project=args.project) as session:
                plan = observe_plan(
                    session,
                    reservation=row["reservation"],
                    inventory=row["inventory"],
                    snapshot_hash=row["snapshot_sha256"],
                    source_revision=source,
                    actor=args.account,
                )
            validate_plan(row["reservation"], plan)
            with engine.connect() as conn:
                from sqlalchemy import text

                digest = conn.execute(
                    text(
                        "SELECT encode(sha256(convert_to(CAST(:plan AS jsonb)::text,'UTF8')),'hex')"
                    ),
                    {"plan": json.dumps(plan)},
                ).scalar_one()
            print(json.dumps({"planSha256": digest, "plan": plan}, indent=2))
            return 0
        expected_source = (
            source
            if args.action in {"prepare", "adopt-operator"}
            else operator_source(row["recovery"])
        )
        current_source = require_operator_source(expected_source)
        with engine.begin() as conn:
            from sqlalchemy import text

            from db.legacy_cloud_removal_adoption import qualification_sql

            conn.execute(text(qualification_sql(resume_required=True)))
        raw = engine.raw_connection()
        raw.driver_connection.autocommit = True
        try:
            journal = LegacyRemovalJournal(raw.driver_connection, args.owner, args.attempt)
            if args.action == "prepare":
                _require(args.plan is not None)
                saved = json.loads(args.plan.read_text())
                plan = saved["plan"]
                validate_plan(row["reservation"], plan)
                _require(
                    saved["planSha256"] == args.manifest_sha256
                    and plan["sourceRevision"] == source
                    and plan["actor"] == args.account
                )
                with RecoverySession(token=credentials.token, project=args.project) as session:
                    current = observe_plan(
                        session,
                        reservation=row["reservation"],
                        inventory=row["inventory"],
                        snapshot_hash=row["snapshot_sha256"],
                        source_revision=source,
                        actor=args.account,
                    )
                _require(
                    {key: value for key, value in current.items() if key != "observedAt"}
                    == {key: value for key, value in plan.items() if key != "observedAt"},
                    "CLOUD_REMOVAL_PLACEMENT_CHANGED",
                )
                prepared = journal.prepare(plan)
                _require(prepared["planSha256"] == args.manifest_sha256)
                print(
                    json.dumps(
                        {
                            "prepared": True,
                            "planSha256": prepared["planSha256"],
                            "ownerApprovalRequired": True,
                        }
                    )
                )
                return 0
            _require(journal.read()["planSha256"] == args.manifest_sha256)
            _require(journal.read()["plan"]["actor"] == args.account)
            if args.action == "adopt-operator":
                # Freeze all original coordinates. Only the source and read time
                # differ; SQL additionally requires fresh approval and reconciled
                # pre-data workers/provider requests under the same CAS prefix.
                with RecoverySession(token=credentials.token, project=args.project) as session:
                    current = observe_plan(
                        session,
                        reservation=row["reservation"],
                        inventory=row["inventory"],
                        snapshot_hash=row["snapshot_sha256"],
                        source_revision=source,
                        actor=args.account,
                    )
                original = journal.read()["plan"]
                _require(
                    {k: v for k, v in current.items() if k not in {"sourceRevision", "observedAt"}}
                    == {
                        k: v
                        for k, v in original.items()
                        if k not in {"sourceRevision", "observedAt"}
                    },
                    "CLOUD_REMOVAL_PLACEMENT_CHANGED",
                )
                previous = operator_source(journal.read())
                if previous != current_source:
                    journal.append(
                        "$executor",
                        "operator_source",
                        {
                            "previousSourceRevision": previous,
                            "sourceRevision": current_source,
                            "planSha256": args.manifest_sha256,
                            "actor": args.account,
                        },
                    )
                print(json.dumps({"operatorSource": operator_source(journal.read())}))
                return 0
            # A fresh interpreter owns the execution SQL session. The parent joins
            # that real process before writing exit; dropping a SQL lease is insufficient.
            args.execution_id = uuid4().hex
            payload = {
                "args": vars(args),
                "token": credentials.token,
                "source": current_source,
                "reservation": row["reservation"],
            }
            payload["args"]["plan"] = str(args.plan) if args.plan else None
            status = supervise(journal, payload)
            print(json.dumps({"workerExit": status, "attempt": args.attempt}))
            return status
        finally:
            raw.close()


if __name__ == "__main__":
    if sys.argv[1:] == ["--internal-worker"]:
        from google.oauth2.credentials import Credentials

        payload = json.loads(sys.stdin.read(131072))
        args = argparse.Namespace(**payload["args"])
        with (
            os.fdopen(payload["startedFd"], "w") as pipe,
            dev_database(args.port, readonly=False) as (engine, source),
        ):
            require_operator_source(payload["source"])
            from sqlalchemy import text
            from db.legacy_cloud_removal_adoption import qualification_sql

            with engine.begin() as conn:
                conn.execute(text(qualification_sql(resume_required=True)))
            result = execute(
                args,
                engine,
                payload["source"],
                payload["reservation"],
                Credentials(token=payload["token"]),
                pipe,
            )
        raise SystemExit(result)
    raise SystemExit(main())

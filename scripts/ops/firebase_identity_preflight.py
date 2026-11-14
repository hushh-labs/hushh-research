# SPDX-License-Identifier: Apache-2.0
"""Read-only UAT readiness for the existing identity-migration operator.

This report is not an import manifest. It neither adopts target identities nor
installs lifecycle fences; mutations require the separate reviewed v2 manifest.
"""

from __future__ import annotations

import base64
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import re
import subprocess

from scripts.ops.firebase_identity_migration_fence import owner_inventory
from scripts.ops.firebase_identity_migration_policy import (
    FIELDS,
    SOURCE,
    Refused,
    identity_hash,
    record,
    require,
    sha,
)

PROJECT = "hushh-pda-uat"
INSTANCE = "hushh-pda-uat:us-central1:hushh-uat-pg"
CLUSTER = "d47ecbccf56371dd8676d3f2679ee4cb50c20feb7b0815f58b2434b8c4df3ca3"
ROOT = Path(__file__).resolve().parents[2]


def fingerprint(user):
    """Keep native fields in memory, including unsupported credential preimages."""
    require(not user.get("rawPassword"), "PLAINTEXT_CREDENTIAL_REFUSED")
    preserved = {
        key: value
        for key, value in user.items()
        if key in {*FIELDS, "disabled", "customAttributes", "tenantId"}
    }
    try:
        return {"sha256": sha(record(user)), "refusal": None}
    except (Refused, ValueError, TypeError) as error:
        return {
            "sha256": sha(preserved),
            "refusal": str(error)
            if isinstance(error, Refused)
            else "INVALID_NATIVE_RECORD",
        }


def collisions(selected, target):
    def subjects(user):
        return {
            (p["providerId"], p["rawId"])
            for p in user.get("providerUserInfo", [])
            if p.get("providerId") and p.get("rawId")
        }

    found = []
    for uid, source in selected.items():
        for existing in target:
            fields = []
            if uid == existing["localId"]:
                fields.append("uid")
            if (
                source.get("email")
                and existing.get("email")
                and (source["email"].casefold() == existing["email"].casefold())
            ):
                fields.append("email")
            if source.get("phoneNumber") and source.get("phoneNumber") == existing.get(
                "phoneNumber"
            ):
                fields.append("phone")
            if subjects(source) & subjects(existing):
                fields.append("provider_subject")
            if fields:
                found.append(
                    {
                        "sourceIdentityHash": identity_hash(uid),
                        "targetIdentityHash": identity_hash(existing["localId"]),
                        "fields": fields,
                        "adoptionAuthorized": False,
                    }
                )
    return found


def inventory(conn, source, target):
    """Use the canonical SQL session and selection; preserve every target record."""
    from sqlalchemy import text

    require(len({u["localId"] for u in target}) == len(target), "TARGET_DUPLICATE_UID")
    owners, selected = owner_inventory(conn, source)
    source_records = {
        identity_hash(uid): fingerprint(user) for uid, user in selected.items()
    }
    target_records = {
        identity_hash(user["localId"]): fingerprint(user) for user in target
    }
    occupied = collisions(selected, target)
    occupied_sources = {entry["sourceIdentityHash"] for entry in occupied}
    proposed = sorted(
        key
        for key, value in source_records.items()
        if key not in occupied_sources and value["refusal"] is None
    )
    tables = set(
        conn.execute(
            text(
                "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' AND tablename IN ('schema_migrations','account_firebase_mutations')"
            )
        ).scalars()
    )
    checkpoint = bool(
        conn.execute(
            text(
                "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='account_deletion_tombstones' AND column_name='firebase_erasure_checkpoint')"
            )
        ).scalar_one()
    )
    ledger = (
        [
            dict(row)
            for row in conn.execute(
                text(
                    "SELECT migration_id,filename,checksum_sha256,status FROM schema_migrations ORDER BY migration_id"
                )
            ).mappings()
        ]
        if "schema_migrations" in tables
        else None
    )
    unsettled = (
        conn.execute(
            text(
                "SELECT count(*) FROM account_firebase_mutations WHERE state NOT IN ('succeeded','rejected')"
            )
        ).scalar_one()
        if "account_firebase_mutations" in tables
        else None
    )
    running = conn.execute(
        text(
            "SELECT count(*) FROM account_deletion_tombstones WHERE cleanup_status='running'"
        )
    ).scalar_one()
    uncertain = (
        conn.execute(
            text(
                "SELECT count(*) FROM account_deletion_tombstones WHERE firebase_erasure_checkpoint->>'state' IN ('dispatched','uncertain')"
            )
        ).scalar_one()
        if checkpoint
        else None
    )
    blockers = ["UAT_ERASURE_RUNTIME_AND_SUCCESSOR_NOT_QUALIFIED"]
    if not ledger:
        blockers.append("MIGRATION_LEDGER_PRESERVATION_AND_ADOPTION_REQUIRED")
    if not checkpoint:
        blockers.append("FIREBASE_ERASURE_CHECKPOINT_UNAVAILABLE")
    if target:
        blockers.append("RETAINED_TARGET_PREIMAGES_REQUIRE_RECONCILIATION")
    if len(proposed) > 1000:
        blockers.append("DURABLE_MULTI_REQUEST_CHECKPOINTS_REQUIRED")
    if owners["unresolvedOwnerHashes"]:
        blockers.append("SOURCE_ABSENT_OWNERS_NOT_AUTHENTICATION_QUALIFIED")
    if any(v["refusal"] for v in (*source_records.values(), *target_records.values())):
        blockers.append("NATIVE_RECORD_POLICY_REVIEW_REQUIRED")
    if unsettled is None or unsettled or running or uncertain:
        blockers.append("LIFECYCLE_DRAIN_NOT_QUALIFIED")
    return {
        "ownerBindings": owners["owners"],
        "ownerRootCount": owners["ownerRootCount"],
        "retiredOwnerCount": owners["retiredOwnerCount"],
        "eligibleOwnerCount": len(owners["owners"])
        + len(owners["unresolvedOwnerHashes"]),
        "sourceAbsentOwnerHashes": owners["unresolvedOwnerHashes"],
        "sourceRecords": source_records,
        "targetPreimages": target_records,
        "sourceFingerprint": sha(source_records),
        "targetFingerprint": sha(target_records),
        "sourceCount": len(source),
        "selectedCount": len(selected),
        "targetCount": len(target),
        "collisions": occupied,
        "proposedAbsentBatches": [
            proposed[i : i + 1000] for i in range(0, len(proposed), 1000)
        ],
        "batchDispatchAuthorized": False,
        "targetAdoptionAuthorized": False,
        "databaseSchema": {
            "checkpointColumnPresent": checkpoint,
            "migrationLedger": ledger,
            "unsettledFirebaseMutations": unsettled,
            "runningErasures": running,
            "uncertainErasures": uncertain,
            "uatErasureQualified": False,
        },
        "blockers": blockers,
    }


@contextmanager
def uat_database(session, port, *, readonly=True):
    """Read the traffic-selected UAT revision and attest its original SQL session."""
    import json
    import os
    from sqlalchemy import URL, create_engine, text

    def get(url):
        response = session.get(url, timeout=25, allow_redirects=False)
        require(response.status_code == 200, "UAT_PREFLIGHT_NATIVE_READ_REFUSED")
        return response.json()

    require(
        str(
            get(f"https://firebase.googleapis.com/v1beta1/projects/{PROJECT}")[
                "projectNumber"
            ]
        )
        == "745506018753",
        "UAT_PROJECT_CHANGED",
    )
    base = f"https://us-central1-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/{PROJECT}/"
    service = get(base + "services/consent-protocol")
    traffic = [
        entry for entry in service["status"]["traffic"] if entry.get("percent", 0)
    ]
    require(
        len(traffic) == 1 and traffic[0]["percent"] == 100, "UAT_TRAFFIC_UNQUALIFIED"
    )
    revision = traffic[0]["revisionName"]
    installed = get(base + "revisions/" + revision)
    env = {entry["name"]: entry for entry in installed["spec"]["containers"][0]["env"]}
    require(env["ENVIRONMENT"].get("value") == "uat", "UAT_ENVIRONMENT_CHANGED")
    # Match the governed release reader; legacy HUSHH_DEPLOY_SHA can be stale.
    source = installed.get("metadata", {}).get("labels", {}).get("deploy-sha", "")
    require(bool(re.fullmatch("[a-f0-9]{40}", source)), "UAT_SOURCE_INVALID")

    def secret(name):
        ref = env[name]["valueFrom"]["secretKeyRef"]
        require(ref["name"] == name, "UAT_SECRET_BINDING_CHANGED")
        value = get(
            f"https://secretmanager.googleapis.com/v1/projects/{PROJECT}/secrets/{name}/versions/{ref['key']}:access"
        )
        return base64.b64decode(value["payload"]["data"]).decode()

    config = json.loads(secret("BACKEND_RUNTIME_CONFIG_JSON"))
    instance = (
        config.get("cloudsql_instance_connection_name")
        or config.get("db_unix_socket", "")
    ).removeprefix("/cloudsql/")
    require(
        instance == INSTANCE and config.get("db_name", "postgres") == "postgres",
        "UAT_DATABASE_CHANGED",
    )
    user = secret("DB_USER")
    require(user == "hushh_uat_app", "UAT_DATABASE_PRINCIPAL_CHANGED")
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
            "connect_timeout": 10,
            "options": f"-c default_transaction_read_only={'on' if readonly else 'off'} -c statement_timeout=12000 -c lock_timeout=500",
        },
        pool_size=1,
        max_overflow=0,
        isolation_level="REPEATABLE READ",
    )
    try:
        with engine.connect() as conn:
            actual = tuple(
                conn.execute(
                    text(
                        "SELECT current_database(),current_user,session_user,current_setting('transaction_read_only'),encode(sha256(convert_to(system_identifier::text,'UTF8')),'hex') FROM pg_control_system()"
                    )
                ).one()
            )
            require(
                actual
                == ("postgres", user, user, "on" if readonly else "off", CLUSTER),
                "UAT_DATABASE_ATTESTATION_FAILED",
            )
            # Ownership helpers import runtime settings eagerly. Supply only the
            # actual attested UAT values, in memory, before importing those helpers.
            scoped = {
                "ENVIRONMENT": "uat",
                "APP_RUNTIME_PROFILE": "uat",
                "GOOGLE_CLOUD_PROJECT": PROJECT,
                "GOOGLE_CLOUD_QUOTA_PROJECT": PROJECT,
                "APP_SIGNING_KEY": secret("APP_SIGNING_KEY"),
                "VAULT_DATA_KEY": secret("VAULT_DATA_KEY"),
            }
            previous = {key: os.environ.get(key) for key in scoped}
            os.environ.update(scoped)
            try:
                yield (
                    conn,
                    {
                        "revision": revision,
                        "source": source,
                        "instance": INSTANCE,
                        "database": "postgres",
                        "principal": user,
                        "clusterSha256": CLUSTER,
                    },
                )
            finally:
                for key, value in previous.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value
    finally:
        engine.dispose()


def run_uat_preflight(args):
    import google.auth
    from google.auth.transport.requests import AuthorizedSession
    from requests.adapters import HTTPAdapter
    from scripts.ops.firebase_identity_migration import export_users, save_receipt

    require(
        args.environment == "uat" and args.action == "preflight" and not args.apply,
        "UAT_MUTATION_NOT_QUALIFIED",
    )
    require(
        not args.manifest.exists() and not args.manifest.is_symlink(),
        "READINESS_REPORT_ALREADY_EXISTS",
    )
    require(0 < args.database_port < 65536, "DATABASE_PORT_INVALID")
    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"],
        quota_project_id=PROJECT,
    )
    with AuthorizedSession(credentials, max_refresh_attempts=0) as session:
        session.trust_env = False
        session.mount("https://", HTTPAdapter(max_retries=0))
        with uat_database(session, args.database_port) as (conn, installed):
            report = inventory(
                conn, export_users(session, SOURCE), export_users(session, PROJECT)
            )
            conn.rollback()
    paths = [
        "firebase_identity_migration.py",
        "firebase_identity_migration_policy.py",
        "firebase_identity_migration_fence.py",
        "firebase_identity_preflight.py",
    ]
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    ).stdout.strip()
    report = {
        "schema": "hussh.uat-auth-preflight.v1",
        "observedAt": datetime.now(timezone.utc).isoformat(),
        "readOnly": True,
        "crossServiceSnapshotAtomic": False,
        "mutationAuthorized": False,
        "sourceProject": SOURCE,
        "targetProject": PROJECT,
        "targetProjectNumber": "745506018753",
        "operatorHead": head,
        "operatorFiles": {
            name: sha((ROOT / "scripts/ops" / name).read_text()) for name in paths
        },
        "installed": installed,
        **report,
    }
    save_receipt(args.manifest, report)
    return {
        "readOnly": True,
        "mutationAuthorized": False,
        "sourceMatches": report["selectedCount"],
        "sourceAbsent": len(report["sourceAbsentOwnerHashes"]),
        "retainedTargets": report["targetCount"],
        "proposedBatchSizes": [len(batch) for batch in report["proposedAbsentBatches"]],
        "blockers": report["blockers"],
    }

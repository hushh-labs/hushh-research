# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Initial installed phone schema proof; never healthy-release or anchor authority."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from bootstrap_ports import WORKFLOW, _authorities
from revision_qualification import PROJECT, REGION
from schema_producers import (
    HISTORY_START,
    SOURCE_ANCHOR,
    Runtime,
    fingerprint,
    source_capable,
)

TABLES = (
    "account_phone_transfers",
    "account_phone_auth_fences",
    "account_phone_recovery_continuations",
    "account_device_actions",
)
ROOT = Path(__file__).resolve().parents[2]


class Ports(Protocol):
    def owner(self) -> dict: ...
    def submissions(self) -> dict: ...
    def snapshot(self) -> dict: ...
    def database(self, installed: bool | None) -> dict: ...
    def workos(self) -> dict: ...
    def reference(self) -> dict: ...


def inspect_database(connection, installed: bool | None) -> dict:
    """Only catalog metadata and EXISTS booleans enter this bounded read port."""
    connection.set_session(
        isolation_level="REPEATABLE READ", readonly=True, autocommit=False
    )
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL statement_timeout='5000ms'")
        cursor.execute("SET LOCAL lock_timeout='3000ms'")
        cursor.execute(
            "SELECT current_database(),oid FROM pg_database WHERE datname=current_database()"
        )
        identity = cursor.fetchone()
        if not identity or identity[0] != "hushh_vault":
            raise ValueError("phone_schema_database_target_unknown")
        for table in TABLES:
            cursor.execute("SELECT to_regclass(%s) IS NOT NULL", ("public." + table,))
            present = cursor.fetchone()[0]
            if type(present) is not bool or (
                installed is not None and present is not installed
            ):
                raise ValueError("phone_schema_relation_boundary_unqualified")
            if present:
                cursor.execute(f"SELECT EXISTS(SELECT 1 FROM public.{table})")
                if cursor.fetchone()[0] is not False:
                    raise ValueError("phone_schema_authority_not_empty")
        cursor.execute(
            "SELECT to_regclass('public.account_firebase_mutations') IS NOT NULL"
        )
        if cursor.fetchone()[0] is not True:
            raise ValueError("phone_schema_mutation_relation_missing")
        cursor.execute(
            "SELECT EXISTS(SELECT 1 FROM public.account_firebase_mutations WHERE purpose='phone_unlink')"
        )
        if cursor.fetchone()[0] is not False:
            raise ValueError("phone_schema_unlink_receipt_exists")
        cursor.execute(
            "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='actor_identity_cache' AND column_name='phone_binding_revision')"
        )
        binding_installed = cursor.fetchone()[0]
        if installed is not None and binding_installed is not installed:
            raise ValueError("phone_schema_partial_installation")
        cursor.execute(
            """SELECT json_build_object(
            'columns',(SELECT json_agg(row_to_json(c) ORDER BY table_name,column_name)
                FROM information_schema.columns c WHERE table_schema='public' AND table_name=ANY(%s)),
            'constraints',(SELECT json_agg(json_build_array(pg_get_constraintdef(oid),convalidated) ORDER BY conrelid,conname)
                FROM pg_constraint WHERE conrelid=ANY(ARRAY(SELECT to_regclass('public.'||unnest(%s::text[]))))),
            'triggers',(SELECT json_agg(json_build_array(pg_get_triggerdef(oid),tgenabled) ORDER BY tgrelid,tgname)
                FROM pg_trigger WHERE NOT tgisinternal AND tgrelid=ANY(ARRAY(SELECT to_regclass('public.'||unnest(%s::text[]))))),
            'functions',(SELECT json_agg(pg_get_functiondef(p.oid) ORDER BY p.proname)
                FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
                AND p.proname IN ('advance_phone_binding_revision','guard_pending_phone_transfer_erasure','reject_deleted_account_identity_write','block_account_deletion_during_release','record_account_deletion_tombstone','install_account_deletion_write_guards','refresh_account_deletion_guards_after_identity_ddl')))
            """,
            (
                list(TABLES),
                list(TABLES) + ["account_firebase_mutations"],
                list(TABLES) + ["actor_profiles", "vault_keys"],
            ),
        )
        catalog = cursor.fetchone()[0]
        if len(json.dumps(catalog)) > 1024 * 1024:
            raise ValueError("phone_schema_catalog_exceeds_bound")
    return {
        "installed": installed,
        "relations_empty": True,
        "phone_unlink_empty": True,
        "database_identity": fingerprint(identity),
        "catalog": fingerprint(catalog),
    }


def _owner(ports: Ports) -> dict:
    owner = ports.owner()
    if owner.get("workflow") != WORKFLOW:
        raise ValueError("phone_schema_initial_job_unqualified")
    return owner


def _submissions(ports: Ports, snapshot: dict) -> dict:
    proof = ports.submissions()
    if proof.get("qualification") != "passed":
        raise ValueError("phone_schema_producer_submission_closure_unqualified")
    for receipt in proof.get("acknowledged_attempts", []):
        if source_capable(receipt["source"]) and not any(
            row.get("run_id") == receipt["run_id"]
            and row.get("source") == receipt["source"]
            and row.get("image") == receipt["image"]
            for row in snapshot["revisions"].values()
        ):
            raise ValueError("phone_schema_acknowledged_issuer_missing")
    return proof


def plan_binding(prepared: dict) -> str:
    fields = (
        "mode",
        "primary_sha",
        "source",
        "image",
        "recovery_enabled",
        "consumer_compatibility",
    )
    return fingerprint({key: prepared[key] for key in fields})


def canonical_binding() -> str:
    manifest = json.loads(
        (ROOT / "consent-protocol/db/release_migration_manifest.json").read_text()
    )
    files = [
        "db/release_migration_manifest.json",
        *(
            str(path.relative_to(ROOT / "consent-protocol"))
            for path in sorted((ROOT / "consent-protocol/db").glob("*.py"))
        ),
        *("db/migrations/" + name for name in manifest["ordered_migrations"]),
    ]
    return fingerprint(
        {
            name: hashlib.sha256(
                (ROOT / "consent-protocol" / name).read_bytes()
            ).hexdigest()
            for name in files
        }
    )


def _validate_preflight(preflight: dict, prepared: dict) -> None:
    if (
        type(preflight.get("schema_version")) is not int
        or preflight["schema_version"] != 1
        or preflight.get("kind") != "phone-schema-preflight"
        or preflight.get("plan") != plan_binding(prepared)
        or preflight.get("canonical_sources") != canonical_binding()
        or preflight.get("source_anchor") != SOURCE_ANCHOR
        or preflight.get("history_start") != HISTORY_START
        or preflight.get("database", {}).get("installed") is not False
        or preflight.get("database", {}).get("relations_empty") is not True
        or preflight.get("database", {}).get("phone_unlink_empty") is not True
        or preflight.get("database", {}).get("owned_proxy_exited") is not True
        or preflight.get("producer_submissions", {}).get("qualification") != "passed"
    ):
        raise ValueError("phone_schema_initial_proof_missing")


def preflight(prepared: dict, *, ports: Ports) -> dict:
    if prepared.get("mode") != "cold" or prepared.get("recovery_enabled") is not False:
        raise ValueError("phone_schema_plan_not_closed")
    owner, before = _owner(ports), ports.snapshot()
    submissions = _submissions(ports, before)
    reference, database, workos = (
        ports.reference(),
        ports.database(False),
        ports.workos(),
    )
    after = ports.snapshot()
    if _stable(before) != _stable(after) or _owner(ports) != owner:
        raise ValueError("phone_schema_preflight_changed")
    result = {
        "schema_version": 1,
        "kind": "phone-schema-preflight",
        "origin": owner,
        "project": PROJECT,
        "region": REGION,
        "plan": plan_binding(prepared),
        "canonical_sources": canonical_binding(),
        "source_anchor": SOURCE_ANCHOR,
        "history_start": HISTORY_START,
        "snapshot": after,
        "producer_submissions": submissions,
        "reference": reference,
        "database": database,
        "workos": workos,
        "advance_anchor": False,
        "healthy_release": False,
    }
    _validate_preflight(result, prepared)
    return result


def continue_preflight(
    prepared: dict, original: dict, reference: dict, *, ports: Ports
) -> dict:
    _validate_preflight(original, prepared)
    owner, before = _owner(ports), ports.snapshot()
    submissions = _submissions(ports, before)
    if _stable(before) != _stable(original["snapshot"]):
        raise ValueError("phone_schema_continuation_issuer_changed")
    # Replaying IF NOT EXISTS does not repair an unknown partial catalog. Only
    # a retry whose original pre-DDL absence still holds is admitted here.
    database, workos = ports.database(False), ports.workos()
    if (
        database["database_identity"] != original["database"]["database_identity"]
        or database.get("relations_empty") is not True
        or database.get("phone_unlink_empty") is not True
        or _stable(ports.snapshot()) != _stable(before)
        or _owner(ports) != owner
    ):
        raise ValueError("phone_schema_continuation_unqualified")
    return {
        **original,
        "origin": owner,
        "continued_from": reference,
        "initial_origin": original.get("initial_origin", original["origin"]),
        "current_database": database,
        "producer_submissions": submissions,
        "workos": workos,
    }


def _stable(snapshot: dict) -> dict:
    return {key: snapshot[key] for key in ("services", "revisions", "jobs")}


def _checks(checks: dict, prepared: dict, origin: dict) -> dict:
    guard, backup, manifest = (checks[key] for key in ("guard", "backup", "manifest"))
    observe = checks["observe"]
    now = datetime.now(timezone.utc)
    checked = datetime.fromisoformat(backup["checked_at"].replace("Z", "+00:00"))
    if (
        observe
        != {
            "mode": "observe",
            "qualification": "passed",
            "run_id": origin["run_id"],
            "run_attempt": origin["run_attempt"],
        }
        or guard.get("status") != "ok"
        or guard.get("violations") != []
        or guard.get("policy", {}).get("skip_db_check") is not False
        or guard["policy"].get("release_environment") != "production"
        or guard.get("migrations", {}).get("selected_lane_head") != 428
        or guard["migrations"].get("expected_contract_version") != 428
        or backup.get("status") != "ok"
        or backup.get("project_id") != PROJECT
        or backup.get("instance") != "hushh-vault-db"
        or backup.get("failures") != []
        or not backup.get("latest_backup", {}).get("id")
        or checked.tzinfo is None
        or not 0 <= (now - checked).total_seconds() <= 3600
        or manifest.get("environment") != "production"
        or manifest.get("git_sha") != prepared["primary_sha"]
        or manifest.get("release", {}).get("run_id") != origin["run_id"]
        or manifest["release"].get("run_attempt") != str(origin["run_attempt"])
        or manifest.get("backup_gate", {}).get("backup_report_status") != "ok"
    ):
        raise ValueError("phone_schema_canonical_checks_unqualified")
    files = {row["filename"]: row["sha256"] for row in manifest["migrations"]["files"]}
    for name in ("425_account_phone_transfers.sql", "428_phone_recovery_actions.sql"):
        if (
            files.get(name)
            != hashlib.sha256(
                (ROOT / "consent-protocol/db/migrations" / name).read_bytes()
            ).hexdigest()
        ):
            raise ValueError("phone_schema_migration_source_changed")
    return {key: fingerprint(value) for key, value in checks.items()}


def _continuity(before: dict, after: dict, checkpoint: dict | None) -> None:
    if before["jobs"] != after["jobs"] or set(before["services"]) != set(
        after["services"]
    ):
        raise ValueError("phone_schema_issuer_inventory_changed")
    additions = set(after["revisions"]) - set(before["revisions"])
    for name, revision in before["revisions"].items():
        if after["revisions"].get(name) != revision:
            raise ValueError("phone_schema_prior_issuer_changed")
    allowed = {checkpoint["qualification"]["revision"]} if checkpoint else set()
    if additions != allowed:
        raise ValueError("phone_schema_unowned_new_issuer")
    if checkpoint:
        cold = after["revisions"][next(iter(allowed))]
        if (
            cold["uid"] != checkpoint["cold_uid"]
            or cold["source"] != checkpoint["plan"]["source"]
            or cold["image"] != checkpoint["plan"]["image"]
        ):
            raise ValueError("phone_schema_cold_identity_changed")
    for name, state in before["services"].items():
        current = dict(after["services"][name])
        if checkpoint and name == "consent-protocol":
            if (
                type(current["generation"]) is not int
                or current["generation"] <= state["generation"]
            ):
                raise ValueError("phone_schema_generation_unqualified")
            current["generation"] = state["generation"]
        if current != state:
            raise ValueError("phone_schema_service_controls_changed")


def installed(
    prepared: dict, baseline: dict, checks: dict, *, ports: Ports, checkpoint=None
) -> dict:
    _validate_preflight(baseline, prepared)
    owner = _owner(ports)
    if owner != baseline["origin"]:
        raise ValueError("phone_schema_production_lock_changed")
    accepted = _checks(checks, prepared, owner)
    snapshot = ports.snapshot()
    submissions = _submissions(ports, snapshot)
    database = ports.database(True)
    if (
        database.get("installed") is not True
        or database.get("relations_empty") is not True
        or database.get("phone_unlink_empty") is not True
    ):
        raise ValueError("phone_schema_installed_boundary_unqualified")
    _continuity(baseline["snapshot"], snapshot, checkpoint)
    if database["database_identity"] != baseline["database"]["database_identity"]:
        raise ValueError("phone_schema_database_identity_changed")
    workos = ports.workos()
    if _stable(snapshot) != _stable(ports.snapshot()) or _owner(ports) != owner:
        raise ValueError("phone_schema_postmigration_changed")
    if checkpoint:
        from bootstrap import _identity

        _identity(checkpoint)
    return {
        "schema_version": 1,
        "kind": "phone-installed-schema-proof",
        "qualification": "passed",
        "origin": owner,
        "project": PROJECT,
        "region": REGION,
        "source_anchor": SOURCE_ANCHOR,
        "history_start": HISTORY_START,
        "preflight": fingerprint(baseline),
        "checks": accepted,
        "runtime_checkpoint": fingerprint(checkpoint) if checkpoint else None,
        "snapshot": snapshot,
        "producer_submissions": submissions,
        "database": database,
        "reference": baseline["reference"],
        "workos": workos,
        "dimensions": {"installed_schema": "passed", "producer_closure": "passed"},
        "advance_anchor": False,
        "healthy_release": False,
        "pending": [
            "protected_documents_join",
            "maintenance_admissibility",
            "retirement",
            "worker",
            "production_release",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("preflight", "installed", "final"))
    for name in ("plan", "output"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--primary-image", default="")
    for name in (
        "baseline",
        "guard",
        "backup",
        "manifest",
        "checkpoint",
        "observe",
        "origin-run-id",
        "origin-attempt",
    ):
        parser.add_argument("--" + name)
    args = parser.parse_args()
    output = Path(args.output)
    try:
        output.write_text(json.dumps({"qualification": "refused"}) + "\n")
        prepared = json.loads(Path(args.plan).read_text())
        ports = Runtime(prepared, args.primary_image)
        if args.phase == "preflight":
            if bool(args.origin_run_id) != bool(args.origin_attempt):
                raise ValueError("phone_schema_origin_pair_required")
            if args.origin_run_id:
                from schema_origin import load

                original, reference = load(args.origin_run_id, int(args.origin_attempt))
                result = continue_preflight(prepared, original, reference, ports=ports)
            else:
                result = preflight(prepared, ports=ports)
        else:
            checks = {
                name: json.loads(Path(getattr(args, name)).read_text())
                for name in ("guard", "backup", "manifest", "observe")
            }
            checkpoint = (
                json.loads(Path(args.checkpoint).read_text())
                if args.phase == "final"
                else None
            )
            result = installed(
                prepared,
                json.loads(Path(args.baseline).read_text()),
                checks,
                ports=ports,
                checkpoint=checkpoint,
            )
        _authorities().retention.atomic_state(output, result)
    except Exception as error:
        print(f"Phone installed-schema qualification refused: {type(error).__name__}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

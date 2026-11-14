# SPDX-License-Identifier: Apache-2.0
"""Existing deletion-fence composition for one bounded Dev Auth import."""

from __future__ import annotations
from pathlib import Path
import re
from uuid import UUID
from scripts.ops.firebase_identity_migration_policy import (
    SOURCE,
    TARGET,
    UAT_TARGET,
    canonical,
    identity_hash,
    record,
    require,
    sha,
)

ROOT = Path(__file__).resolve().parents[2]

RELEASE_KEY = "hushh.account-deletion.release.v1"

FENCES = {
    "account_firebase_mutations": "trg_block_firebase_import_mutations",
    "account_generations": "trg_block_firebase_import_generations",
}


UAT_FENCES = {
    **FENCES,
    "account_deletion_tombstones": "trg_block_firebase_import_cleanup_admission",
}


def operation_fences(operation=None):
    if operation is not None and operation.get("version") == 2:
        require(operation.get("targetProject") == UAT_TARGET, "OPERATION_INVALID")
        return UAT_FENCES
    return FENCES


def owner_inventory(conn, users):
    """Resolve retained owners on this session without admitting an import."""
    from sqlalchemy import text
    from hushh_mcp.services.account_generation_service import AccountGenerationService

    owners = (
        conn.execute(
            text(
                "SELECT user_id FROM actor_profiles UNION SELECT user_id FROM vault_keys"
            )
        )
        .scalars()
        .all()
    )
    retired = set(
        conn.execute(
            text(
                "SELECT user_id_hash FROM account_deletion_tombstones UNION "
                "SELECT owner_hash FROM account_generations WHERE retired_at IS NOT NULL"
            )
        ).scalars()
    )
    by_uid = {u["localId"]: u for u in users}
    require(len(by_uid) == len(users), "SOURCE_DUPLICATE_UID")
    root_count = len(owners)
    owners = sorted(owner for owner in owners if identity_hash(owner) not in retired)
    identities = AccountGenerationService.firebase_identities_for_owners(
        owners, connection=conn
    )
    require(set(identities) == set(owners), "OWNER_MAPPING_REFUSED")
    generations = dict(
        conn.execute(
            text(
                "SELECT owner_hash,generation FROM account_generations WHERE owner_hash=ANY(:owners)"
            ),
            {"owners": [identity_hash(owner) for owner in owners]},
        ).all()
    )
    selected, bindings, unresolved, unresolved_bindings = {}, [], [], []
    for owner in owners:
        uid = identities[owner]
        require(bool(uid), "OWNER_MAPPING_REFUSED")
        if uid not in by_uid:
            unresolved.append(identity_hash(owner))
            unresolved_bindings.append(
                {
                    "ownerHash": identity_hash(owner),
                    "identityHash": identity_hash(uid),
                    "generation": generations.get(identity_hash(owner)) or 0,
                }
            )
            continue
        require(uid not in selected, "MULTIPLE_OWNERS_FOR_IDENTITY")
        generation = generations.get(identity_hash(owner))
        selected[uid] = by_uid[uid]
        bindings.append(
            {
                "ownerHash": identity_hash(owner),
                "identityHash": identity_hash(uid),
                "generation": generation or 0,
            }
        )
    return {
        "owners": bindings,
        "unresolvedOwnerHashes": sorted(unresolved),
        "unresolvedBindings": unresolved_bindings,
        "ownerRootCount": root_count,
        "retiredOwnerCount": root_count - len(owners),
    }, selected


def owner_snapshot(conn, users, *, target_project=TARGET, retained=None):
    inventory, selected = owner_inventory(conn, users)
    require(target_project in {TARGET, UAT_TARGET}, "MIGRATION_REALM_UNQUALIFIED")
    require(
        0 < len(selected) <= (1000 if target_project == TARGET else 10000),
        "COHORT_SIZE_INVALID",
    )
    selected = {uid: record(user) for uid, user in selected.items()}
    fingerprints = {identity_hash(uid): sha(user) for uid, user in selected.items()}
    manifest = {
        "schema": "hussh.dev-auth-import.v1"
        if target_project == TARGET
        else "hussh.uat-auth-import.v2",
        "sourceProject": SOURCE,
        "targetProject": target_project,
        "unresolvedOwnerHashes": inventory["unresolvedOwnerHashes"],
        "owners": [
            {**binding, "sourceRecordSha256": fingerprints[binding["identityHash"]]}
            for binding in inventory["owners"]
        ],
    }
    if target_project == UAT_TARGET:
        manifest["unresolvedBindings"] = inventory["unresolvedBindings"]
        manifest["retainedTargets"] = retained or {}
        pending = sorted(
            identity_hash(uid)
            for uid in selected
            if identity_hash(uid) not in manifest["retainedTargets"]
        )
        manifest["batches"] = [
            pending[i : i + 1000] for i in range(0, len(pending), 1000)
        ]
    return manifest, selected


def fence_sql(name):
    return "\n".join(
        line
        for line in (ROOT / "deploy/account-deletion" / name).read_text().splitlines()
        if not line.startswith("\\") and line.strip() not in {"BEGIN;", "COMMIT;"}
    )


def drain(conn, operation=None):
    from sqlalchemy import text

    require(
        not conn.execute(
            text(
                "SELECT EXISTS(SELECT 1 FROM account_firebase_mutations "
                "WHERE state NOT IN ('succeeded','rejected'))"
            )
        ).scalar_one(),
        "IDENTITY_MUTATIONS_UNSETTLED",
    )
    require(
        not conn.execute(
            text("""
        SELECT EXISTS(SELECT 1 FROM account_deletion_tombstones t
        WHERE cleanup_status='running'
           OR to_jsonb(t)->'firebase_erasure_checkpoint'->>'state' IN ('dispatched','uncertain'))
    """)
        ).scalar_one(),
        "IDENTITY_ERASURE_UNSETTLED",
    )

    if operation is not None and operation.get("version") == 2:
        require(
            not conn.execute(
                text("""SELECT EXISTS(SELECT 1 FROM account_deletion_tombstones
             WHERE cleanup_intent_kind='phone_orphan' AND firebase_uid IS NOT NULL
              AND cleanup_status<>'completed')""")
            ).scalar_one(),
            "LEGACY_PHONE_INTENTS_REQUIRE_RECONCILIATION",
        )


def trigger_comments(conn, operation=None):
    from sqlalchemy import text

    return dict(
        conn.execute(
            text("""
        SELECT t.tgname, obj_description(t.oid,'pg_trigger') FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND t.tgname=ANY(:names) AND NOT t.tgisinternal
    """),
            {"names": list(operation_fences(operation).values())},
        ).all()
    )


def fences_absent(conn, *, target_project=TARGET):
    from sqlalchemy import text

    return conn.execute(
        text("""SELECT count(*)=0 FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND t.tgname=ANY(:names) AND NOT t.tgisinternal
    """),
        {
            "names": [
                *UAT_FENCES.values(),
                "trg_block_account_deletion_during_release",
            ]
        },
    ).scalar_one()


def qualify_fences(conn, operation=None):
    """Operation comments identify custody; native structure establishes refusal."""
    from sqlalchemy import text

    body = re.search(
        r"AS \$\$(.*?)\$\$;", fence_sql("install_release_fence.sql"), re.DOTALL
    ).group(1)
    require(
        conn.execute(
            text("""
        SELECT p.prosrc=:body AND NOT p.prosecdef AND NOT p.proisstrict
          AND NOT p.proleakproof AND p.pronargs=0 AND p.provolatile='v'
          AND p.proparallel='u' AND p.prorettype='trigger'::regtype
          AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
          AND p.proconfig=ARRAY['search_path=pg_catalog, public']
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='block_account_deletion_during_release'
    """),
            {"body": body},
        ).scalar_one_or_none()
        is True,
        "FENCE_FUNCTION_CHANGED",
    )
    expected = {
        **{(table, name): 6 for table, name in operation_fences(operation).items()},
        ("actor_profiles", "trg_block_account_deletion_during_release"): 10,
        ("vault_keys", "trg_block_account_deletion_during_release"): 10,
    }
    rows = (
        conn.execute(
            text("""
        SELECT c.relname,t.tgname,t.tgtype,t.tgenabled,t.tgfoid=
          'public.block_account_deletion_during_release()'::regprocedure AS function_matches,
          t.tgnargs=0 AND t.tgqual IS NULL AND t.tgconstraint=0 AS plain_trigger
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgname=ANY(:names)
    """),
            {"names": sorted({name for _, name in expected})},
        )
        .mappings()
        .all()
    )
    require(
        len(rows) == len(expected)
        and all(
            expected.get((row["relname"], row["tgname"])) == row["tgtype"]
            and row["tgenabled"] in {"O", "A"}
            and row["function_matches"]
            and row["plain_trigger"]
            for row in rows
        ),
        "FENCE_STRUCTURE_CHANGED",
    )


def validate_operation(operation):
    context = {"version", "targetProject"} if operation.get("version") == 2 else set()
    require(
        set(operation)
        in (
            {"operation", "manifestSha256"} | context,
            {"operation", "manifestSha256", "requestSha256"} | context,
        ),
        "OPERATION_INVALID",
    )
    if context:
        require(type(operation["version"]) is int, "OPERATION_INVALID")
        require(operation["targetProject"] == UAT_TARGET, "OPERATION_INVALID")
    require(
        str(UUID(operation["operation"])) == operation["operation"], "OPERATION_INVALID"
    )
    require(
        all(
            isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value)
            for key, value in operation.items()
            if key not in {"operation", *context}
        ),
        "OPERATION_INVALID",
    )


def install_fences(conn, operation):
    from sqlalchemy import text

    expected = canonical(operation)
    validate_operation(operation)
    existing = trigger_comments(conn, operation)
    if existing:
        predecessor = {
            key: value for key, value in operation.items() if key != "requestSha256"
        }
        exact_predecessor = "requestSha256" in operation and existing == dict.fromkeys(
            operation_fences(operation).values(), canonical(predecessor)
        )
        require(
            existing == dict.fromkeys(operation_fences(operation).values(), expected)
            or exact_predecessor,
            "FOREIGN_IMPORT_FENCE",
        )
        require(
            conn.execute(
                text("""SELECT count(*) FROM pg_trigger WHERE
            tgname='trg_block_account_deletion_during_release' AND tgenabled IN ('O','A')
        """)
            ).scalar_one()
            == 2,
            "BASE_FENCE_INCOMPLETE",
        )
        qualify_fences(conn, operation)
        if exact_predecessor:
            # The fsynced request intent may precede this catalog checkpoint.
            # Publishing it on resume never permits another provider submission.
            for table, name in operation_fences(operation).items():
                conn.exec_driver_sql(
                    f"COMMENT ON TRIGGER {name} ON public.{table} IS '{expected}'"
                )
        return
    require("requestSha256" not in operation, "DISPATCH_FENCE_MISSING")
    require(fences_absent(conn), "FOREIGN_IMPORT_FENCE")
    require(
        conn.execute(
            text("""SELECT count(*) FROM pg_trigger WHERE
        tgname='trg_block_account_deletion_during_release'
    """)
        ).scalar_one()
        == 0,
        "UNOWNED_RELEASE_FENCE",
    )
    conn.exec_driver_sql(fence_sql("install_release_fence.sql"))
    conn.exec_driver_sql(
        "LOCK TABLE "
        + ", ".join("public." + table for table in operation_fences(operation))
        + " IN SHARE ROW EXCLUSIVE MODE"
    )
    drain(conn)
    for table, name in operation_fences(operation).items():
        conn.exec_driver_sql(
            f"CREATE TRIGGER {name} BEFORE INSERT ON public.{table} "
            "FOR EACH STATEMENT EXECUTE FUNCTION "
            "public.block_account_deletion_during_release()"
        )
        # operation contains only a UUID and reviewed hexadecimal manifest hash.
        conn.exec_driver_sql(
            f"COMMENT ON TRIGGER {name} ON public.{table} IS '{expected}'"
        )
    qualify_fences(conn, operation)


def verify_fences(conn, operation):
    from sqlalchemy import text

    validate_operation(operation)
    qualify_fences(conn, operation)
    require(
        trigger_comments(conn, operation)
        == dict.fromkeys(operation_fences(operation).values(), canonical(operation)),
        "IMPORT_FENCE_CHANGED",
    )
    require(
        conn.execute(
            text("""SELECT EXISTS(SELECT 1 FROM pg_locks
        WHERE pid=pg_backend_pid() AND locktype='advisory' AND mode='ExclusiveLock'
        AND granted AND objsubid=1
        AND classid=((hashtextextended(:key,0)>>32)&4294967295)::oid
        AND objid=(hashtextextended(:key,0)&4294967295)::oid)
    """),
            {"key": RELEASE_KEY},
        ).scalar_one(),
        "OPERATOR_SESSION_LOST",
    )
    require(
        conn.execute(
            text("""SELECT count(*) FROM pg_trigger WHERE
        tgname=ANY(:names) AND tgenabled IN ('O','A')
    """),
            {"names": list(operation_fences(operation).values())},
        ).scalar_one()
        == len(operation_fences(operation)),
        "IMPORT_FENCE_DISABLED",
    )
    drain(conn, operation)


def remove_fences(conn, operation):
    verify_fences(conn, operation)
    for table, name in operation_fences(operation).items():
        conn.exec_driver_sql(f"DROP TRIGGER {name} ON public.{table}")
    conn.exec_driver_sql(fence_sql("remove_release_fence.sql"))

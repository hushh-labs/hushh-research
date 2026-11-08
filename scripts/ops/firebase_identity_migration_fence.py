# SPDX-License-Identifier: Apache-2.0
"""Existing deletion-fence composition for one bounded Dev Auth import."""

from __future__ import annotations
from pathlib import Path
import re
from uuid import UUID
from scripts.ops.firebase_identity_migration_policy import (
    SOURCE,
    TARGET,
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


def owner_snapshot(conn, users):
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
    selected, bindings, unresolved = {}, [], []
    for owner in sorted(owners):
        if identity_hash(owner) in retired:
            continue
        uid = AccountGenerationService.identity_in_transaction(conn, owner)
        if uid not in by_uid:
            unresolved.append(identity_hash(owner))
            continue
        require(uid not in selected, "MULTIPLE_OWNERS_FOR_IDENTITY")
        generation = conn.execute(
            text("SELECT generation FROM account_generations WHERE owner_hash=:owner"),
            {"owner": identity_hash(owner)},
        ).scalar_one_or_none()
        selected[uid] = record(by_uid[uid])
        bindings.append(
            {
                "ownerHash": identity_hash(owner),
                "identityHash": identity_hash(uid),
                "generation": generation or 0,
                "sourceRecordSha256": sha(selected[uid]),
            }
        )
    require(0 < len(selected) <= 1000, "COHORT_SIZE_INVALID")
    return {
        "schema": "hussh.dev-auth-import.v1",
        "sourceProject": SOURCE,
        "targetProject": TARGET,
        "owners": bindings,
        "unresolvedOwnerHashes": sorted(unresolved),
    }, selected


def fence_sql(name):
    return "\n".join(
        line
        for line in (ROOT / "deploy/account-deletion" / name).read_text().splitlines()
        if not line.startswith("\\") and line.strip() not in {"BEGIN;", "COMMIT;"}
    )


def drain(conn):
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


def trigger_comments(conn):
    from sqlalchemy import text

    return dict(
        conn.execute(
            text("""
        SELECT t.tgname, obj_description(t.oid,'pg_trigger') FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND t.tgname=ANY(:names) AND NOT t.tgisinternal
    """),
            {"names": list(FENCES.values())},
        ).all()
    )


def fences_absent(conn):
    from sqlalchemy import text

    return conn.execute(
        text("""SELECT count(*)=0 FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND t.tgname=ANY(:names) AND NOT t.tgisinternal
    """),
        {"names": [*FENCES.values(), "trg_block_account_deletion_during_release"]},
    ).scalar_one()


def qualify_fences(conn):
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
        **{(table, name): 6 for table, name in FENCES.items()},
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
        len(rows) == 4
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
    require(
        set(operation)
        in (
            {"operation", "manifestSha256"},
            {"operation", "manifestSha256", "requestSha256"},
        ),
        "OPERATION_INVALID",
    )
    require(
        str(UUID(operation["operation"])) == operation["operation"], "OPERATION_INVALID"
    )
    require(
        all(
            isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value)
            for key, value in operation.items()
            if key != "operation"
        ),
        "OPERATION_INVALID",
    )


def install_fences(conn, operation):
    from sqlalchemy import text

    expected = canonical(operation)
    validate_operation(operation)
    existing = trigger_comments(conn)
    if existing:
        predecessor = {
            key: value for key, value in operation.items() if key != "requestSha256"
        }
        exact_predecessor = "requestSha256" in operation and existing == dict.fromkeys(
            FENCES.values(), canonical(predecessor)
        )
        require(
            existing == dict.fromkeys(FENCES.values(), expected) or exact_predecessor,
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
        qualify_fences(conn)
        if exact_predecessor:
            # The fsynced request intent may precede this catalog checkpoint.
            # Publishing it on resume never permits another provider submission.
            for table, name in FENCES.items():
                conn.exec_driver_sql(
                    f"COMMENT ON TRIGGER {name} ON public.{table} IS '{expected}'"
                )
        return
    require("requestSha256" not in operation, "DISPATCH_FENCE_MISSING")
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
        "LOCK TABLE public.account_firebase_mutations, public.account_generations "
        "IN SHARE ROW EXCLUSIVE MODE"
    )
    drain(conn)
    for table, name in FENCES.items():
        conn.exec_driver_sql(
            f"CREATE TRIGGER {name} BEFORE INSERT ON public.{table} "
            "FOR EACH STATEMENT EXECUTE FUNCTION "
            "public.block_account_deletion_during_release()"
        )
        # operation contains only a UUID and reviewed hexadecimal manifest hash.
        conn.exec_driver_sql(
            f"COMMENT ON TRIGGER {name} ON public.{table} IS '{expected}'"
        )
    qualify_fences(conn)


def verify_fences(conn, operation):
    from sqlalchemy import text

    validate_operation(operation)
    qualify_fences(conn)
    require(
        trigger_comments(conn) == dict.fromkeys(FENCES.values(), canonical(operation)),
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
            {"names": list(FENCES.values())},
        ).scalar_one()
        == 2,
        "IMPORT_FENCE_DISABLED",
    )
    drain(conn)


def remove_fences(conn, operation):
    verify_fences(conn, operation)
    for table, name in FENCES.items():
        conn.exec_driver_sql(f"DROP TRIGGER {name} ON public.{table}")
    conn.exec_driver_sql(fence_sql("remove_release_fence.sql"))

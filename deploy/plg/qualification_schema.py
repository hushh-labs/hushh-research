"""One-shot synthetic S/D8 schema initialization on fixed Dev/UAT namespaces.

The caller owns the proxy, canonical credentials and temporary DB-owner
membership. Importing this module never connects, runs SQL or starts a process.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from contextlib import closing, contextmanager
from functools import partial
from pathlib import Path
from urllib.parse import quote

import qualification_base as base
import qualification_foundation as foundation
import release_source
from qualification_bootstrap import connect, source_boundary
from qualification_database import _role, inspect_baseline
from qualification_target import (
    DATABASE,
    MARKER,
    MIGRATOR_ROLE,
    RUNTIME_ROLE,
    SOURCE,
    QualificationError,
    Target,
    require,
)

LOCK = (173734, 20261028)
INDEX = "public.idx_pkm_events_plg_memory_revision"
SOURCE_CHILD = """
import os, runpy, sys
from importlib.metadata import version
if version('python-dotenv') != '1.2.2' or os.environ.get('PYTHON_DOTENV_DISABLED') != '1':
    raise SystemExit('qualification_source_dotenv_version_required')
script, *arguments = sys.argv[1:]
sys.argv = [script, *arguments]
runpy.run_path(script, run_name='__main__')
"""


def reviewed_source(root: Path) -> tuple[dict, str]:
    """Admit only the committed record and an unchanged checkout of exact S."""
    source_boundary()
    record, digest = foundation.load_contract()
    root = root.resolve(strict=True)

    def read(*args):
        return release_source._git("-C", str(root), *args)

    require(
        read("rev-parse", "HEAD").strip().decode() == SOURCE,
        "qualification_initializer_checkout_mismatch",
    )
    require(
        Path(read("rev-parse", "--show-toplevel").strip().decode()).resolve() == root,
        "qualification_initializer_checkout_root_mismatch",
    )
    require(
        not read("status", "--porcelain", "--untracked-files=normal").strip(),
        "qualification_initializer_checkout_dirty",
    )
    read("diff", "--exit-code", SOURCE, "--")
    manifest = json.loads(
        read("show", SOURCE + ":consent-protocol/db/release_migration_manifest.json")
    )
    require(
        manifest["ordered_migrations"][-1].startswith("370_"),
        "qualification_initializer_lane_changed",
    )
    return record, digest


def identity(connection, target: Target, user: str) -> None:
    """Bind the socket and server-derived cluster identity to the reviewed target."""
    require(type(target) is Target, "qualification_target_required")
    parameters = connection.get_dsn_parameters()
    require(
        parameters.get("host") == "127.0.0.1"
        and parameters.get("port") == str(target.proxy_port)
        and parameters.get("dbname") == DATABASE
        and parameters.get("user") == user,
        "qualification_schema_connection_mismatch",
    )
    expected_cluster = foundation.CLUSTERS.get(target.environment)
    require(expected_cluster is not None, "qualification_cluster_attestation_missing")
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT current_database(),current_user,pg_get_userbyid(d.datdba),"
            "shobj_description(d.oid,'pg_database'),s.system_identifier::text,"
            "current_setting('server_version_num')::int/10000 "
            "FROM pg_database d CROSS JOIN pg_control_system() s "
            "WHERE d.datname=current_database()"
        )
        require(
            cursor.fetchone()
            == (
                DATABASE,
                user,
                MIGRATOR_ROLE,
                MARKER,
                expected_cluster["systemIdentifier"],
                expected_cluster["postgresMajor"],
            ),
            "qualification_schema_cluster_or_owner_mismatch",
        )
        require(
            _role(cursor, MIGRATOR_ROLE, 2) and _role(cursor, RUNTIME_ROLE, 8),
            "qualification_schema_roles_unowned",
        )


def empty_start(connection) -> None:
    """An interrupted/previous initializer cannot be silently replayed."""
    require(connection.autocommit, "qualification_schema_autocommit_required")
    with connection.cursor() as cursor:
        cursor.execute("SHOW transaction_read_only")
        require(cursor.fetchone() == ("off",), "qualification_schema_write_session_required")
        cursor.execute(
            "SELECT pg_has_role(current_user,'cloudsqlsuperuser','USAGE'),"
            "pg_has_role(current_user,%s,'USAGE')",
            (MIGRATOR_ROLE,),
        )
        require(
            cursor.fetchone() == (True, True),
            "qualification_existing_admin_and_owner_membership_required",
        )
        cursor.execute(
            "SELECT NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n "
            "ON n.oid=c.relnamespace WHERE n.nspname='public'),"
            "NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n "
            "ON n.oid=p.pronamespace WHERE n.nspname='public'),"
            "NOT EXISTS(SELECT 1 FROM pg_event_trigger),"
            "NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname<>'plpgsql'),"
            "NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT IN "
            "('public','information_schema') AND nspname !~ '^pg_')"
        )
        require(cursor.fetchone() == (True,) * 5, "qualification_schema_start_not_empty")


@contextmanager
def schema_lock(connection):
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_try_advisory_lock(%s,%s)", LOCK)
        require(cursor.fetchone() == (True,), "qualification_schema_busy")
        try:
            yield
        finally:
            cursor.execute("SELECT pg_advisory_unlock(%s,%s)", LOCK)


def child_environment(target: Target, user: str, password: str, *, initializer: bool) -> dict:
    require(
        bool(user and password) and user not in {MIGRATOR_ROLE, RUNTIME_ROLE},
        "qualification_canonical_admin_required",
    )
    environment = {
        name: os.environ[name]
        for name in ("SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP")
        if name in os.environ
    }
    environment.update(
        {
            "PYTHON_DOTENV_DISABLED": "1",
            "PYTHONNOUSERSITE": "1",
            "ENVIRONMENT": "uat",
            "BACKEND_RUNTIME_CONFIG_JSON": "{}",
            "DB_OFFLINE": "0",
            "DB_HOST": "127.0.0.1",
            "DB_PORT": str(target.proxy_port),
            "DB_NAME": DATABASE,
            "DB_USER": quote(user, safe="") if initializer else user,
            "DB_PASSWORD": quote(password, safe="") if initializer else password,
            "DB_UNIX_SOCKET": "",
            "DB_SSLMODE": "disable",
            "PGSSLMODE": "disable",
            "GCP_PROJECT_ID": target.project,
            "GOOGLE_CLOUD_PROJECT": target.project,
            "CLOUDSQL_INSTANCE_CONNECTION_NAME": target.instance,
            "CLOUDSQL_PROXY_PORT": str(target.proxy_port),
            "HUSHH_MIGRATION_MODE": "replay",
            "HUSHH_DEPLOY_SHA": SOURCE,
        }
    )
    return environment


def run_source(
    root: Path, target: Target, user: str, password: str, *, initializer: bool, vault: bool = False
) -> None:
    # The canonical initializer concatenates credentials into its URL; only that
    # child URI-encodes them. The source verifier already performs encoding.
    script = (
        "consent-protocol/db/migrate.py"
        if initializer
        else "scripts/ops/db_migration_release_guard.py"
    )
    arguments = base.arguments(initializer, vault)
    environment = child_environment(target, user, password, initializer=initializer)
    try:
        result = subprocess.run(  # noqa: S603 -- admitted exact source, fixed arguments, no shell.
            [
                sys.executable,
                "-I",
                "-X",
                "utf8",
                "-c",
                SOURCE_CHILD,
                str(root / script),
                *arguments,
                "--release-environment",
                "production",
            ],
            cwd=root / "consent-protocol",
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=1800 if initializer else 120,
            check=False,
        )
        require(
            result.returncode == 0,
            "qualification_canonical_source_operation_unverified",
        )
    finally:
        environment.clear()


def runtime_grants(connection) -> None:
    """Grant this DB's source-created objects, never role membership or DDL."""
    from psycopg2 import sql

    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(sql.Identifier(RUNTIME_ROLE))
        )
        cursor.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' "
            "AND tablename<>'schema_migrations' ORDER BY tablename"
        )
        for (table,) in cursor.fetchall():
            cursor.execute(
                sql.SQL("GRANT SELECT,INSERT,UPDATE,DELETE ON public.{} TO {}").format(
                    sql.Identifier(table), sql.Identifier(RUNTIME_ROLE)
                )
            )
        cursor.execute(
            "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname='public' AND c.relkind IN ('v','m')"
        )
        for (view,) in cursor.fetchall():
            cursor.execute(
                sql.SQL("GRANT SELECT ON public.{} TO {}").format(
                    sql.Identifier(view), sql.Identifier(RUNTIME_ROLE)
                )
            )
        cursor.execute(
            sql.SQL("GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO {}").format(
                sql.Identifier(RUNTIME_ROLE)
            )
        )
        # Preserve the source's explicit service_role routine admission without
        # inheriting the shared role or re-enabling routines revoked from PUBLIC.
        cursor.execute(
            "SELECT p.oid::regprocedure::text FROM pg_proc p "
            "JOIN pg_namespace n ON n.oid=p.pronamespace "
            "CROSS JOIN LATERAL aclexplode(p.proacl) a "
            "JOIN pg_roles r ON r.oid=a.grantee WHERE n.nspname='public' "
            "AND r.rolname='service_role' AND a.privilege_type='EXECUTE'"
        )
        for (signature,) in cursor.fetchall():
            cursor.execute(
                sql.SQL("GRANT EXECUTE ON FUNCTION {} TO {}").format(
                    sql.SQL(signature), sql.Identifier(RUNTIME_ROLE)
                )
            )
            cursor.execute(
                "SELECT has_function_privilege(%s,%s,'EXECUTE')",
                (RUNTIME_ROLE, signature),
            )
            require(
                cursor.fetchone() == (True,),
                "qualification_runtime_routine_grant_unverified",
            )
    verify_runtime_grants(connection)


def verify_runtime_grants(connection) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT bool_and(has_table_privilege(%s,c.oid,needed.privilege)) "
            "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) needed(privilege) "
            "WHERE n.nspname='public' AND c.relkind IN ('r','p') "
            "AND c.relname<>'schema_migrations'",
            (RUNTIME_ROLE,),
        )
        require(
            cursor.fetchone() == (True,),
            "qualification_runtime_table_grants_unverified",
        )
        cursor.execute(
            "SELECT has_schema_privilege(%s,'public','CREATE'),"
            "COALESCE(has_table_privilege(%s,to_regclass('public.schema_migrations'),"
            "'INSERT,UPDATE,DELETE'),false),"
            "NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "CROSS JOIN (VALUES ('USAGE'),('SELECT')) needed(privilege) "
            "WHERE n.nspname='public' AND c.relkind='S' "
            "AND NOT has_sequence_privilege(%s,c.oid,needed.privilege)),"
            "NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname='public' AND c.relkind IN ('v','m') "
            "AND NOT has_table_privilege(%s,c.oid,'SELECT'))",
            (RUNTIME_ROLE,) * 4,
        )
        require(
            cursor.fetchone() == (False, False, True, True),
            "qualification_runtime_ddl_ledger_or_read_grants_unverified",
        )


def _index_tokens(expression: str) -> tuple[str, ...]:
    # Preserve quoted values exactly. Only deparser casts/parentheses and
    # whitespace outside literals disappear in this fixed AND-only contract.
    tokens = re.findall(
        r"'(?:[^']|'')*'|::text\b|[A-Za-z_][A-Za-z_0-9]*|->>|->|[()]|\s+|.", expression
    )
    return tuple(
        lexeme if lexeme.startswith("'") else lexeme.lower()
        for lexeme in tokens
        if lexeme.startswith("'")
        or (lexeme != "::text" and lexeme not in {"(", ")"} and not lexeme.isspace())
    )


def memory_index(connection) -> str:
    """Read-only counterpart to 408, bound to complete admitted 407 tokens."""
    source = foundation.overlay_sql()[0][1].decode()
    expected_expression = source.split("ON public.pkm_events (user_id, domain, ", 1)[
        1
    ].splitlines()[0]
    expected_predicate = source.split("WHERE ", 1)[1].strip().removesuffix(";")
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT c.relkind='i' AND am.amname='btree' AND i.indisvalid "
            "AND i.indisready AND i.indislive AND NOT i.indisunique AND NOT i.indisexclusion "
            "AND i.indnkeyatts=3 AND i.indnatts=3 "
            "AND i.indkey[0]=u.attnum AND i.indkey[1]=d.attnum AND i.indkey[2]=0 "
            "AND i.indclass[0]=op.oid AND i.indclass[1]=op.oid AND i.indclass[2]=op.oid "
            "AND i.indcollation[0]=u.attcollation AND i.indcollation[1]=d.attcollation "
            "AND i.indcollation[2]=typ.typcollation "
            "AND i.indoption[0]=0 AND i.indoption[1]=0 AND i.indoption[2]=0,"
            "pg_get_indexdef(i.indexrelid,3,false),pg_get_expr(i.indpred,i.indrelid,false),"
            "pg_get_indexdef(i.indexrelid) FROM pg_index i "
            "JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam "
            "JOIN pg_attribute u ON u.attrelid=i.indrelid AND u.attname='user_id' "
            "JOIN pg_attribute d ON d.attrelid=i.indrelid AND d.attname='domain' "
            "JOIN pg_opclass op ON op.opcmethod=am.oid AND op.opcname='text_ops' "
            "AND op.opcnamespace='pg_catalog'::regnamespace "
            "CROSS JOIN pg_type typ WHERE typ.oid='text'::regtype "
            "AND i.indexrelid=to_regclass(%s) AND i.indrelid='public.pkm_events'::regclass",
            (INDEX,),
        )
        row = cursor.fetchone()
    require(
        row is not None and row[0] is True and all(isinstance(v, str) for v in row[1:]),
        "qualification_memory_index_shape_unverified",
    )
    require(
        _index_tokens(row[1]) == _index_tokens(expected_expression)
        and _index_tokens(row[2]) == _index_tokens(expected_predicate),
        "qualification_memory_index_definition_mismatch",
    )
    return row[3]


def preflight(connection, target: Target, root: Path, user: str, password: str) -> dict:
    reviewed_source(root)
    identity(connection, target, user)
    require(connection.autocommit, "qualification_schema_autocommit_required")
    connection.set_session(readonly=True)
    boundary = inspect_baseline(connection, target)
    definition = memory_index(connection)
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT EXISTS(SELECT 1 FROM public.account_generations WHERE generation<>0)"
        )
        require(
            cursor.fetchone() == (False,),
            "qualification_replacement_generation_present",
        )
    run_source(root, target, user, password, initializer=False)
    return boundary | {
        "sourceSchemaVerified": True,
        "replacementAccounts": 0,
        "memoryIndexDefinitionSha256": hashlib.sha256(definition.encode()).hexdigest(),
    }


def initialize(connection, target: Target, root: Path, user: str, password: str) -> dict:
    reviewed_source(root)
    identity(connection, target, user)
    with schema_lock(connection):
        empty_start(connection)
        source = partial(run_source, root, target, user, password, initializer=True)
        base.install(connection, source)
        for _name, content in foundation.overlay_sql():
            # autocommit is mandatory for 407; the other pinned files carry
            # their own genuine BEGIN/COMMIT. No ledger rows are fabricated.
            with connection.cursor() as cursor:
                cursor.execute(content.decode())
        runtime_grants(connection)
        return preflight(connection, target, root, user, password)


def execute(target: Target, root: Path, output: Path, *, action: str) -> dict:
    require(action in {"initialize", "preflight"}, "qualification_schema_action_invalid")
    _record, digest = reviewed_source(root)
    proof = target.plan() | {
        "phase": action,
        "status": "requested",
        "foundationSha256": digest,
    }
    # Exclusive durable intent prevents blindly reusing an interrupted attempt.
    with output.open("x", encoding="utf-8") as handle:
        json.dump(proof, handle, indent=2)
    user = os.environ.get("PLG_QUALIFICATION_ADMIN_USER", "")
    password = os.environ.get("PLG_QUALIFICATION_ADMIN_PASSWORD", "")
    try:
        require(bool(user and password), "qualification_canonical_admin_required")
        with closing(
            connect(target, database=DATABASE, user=user, password=password)
        ) as connection:
            connection.autocommit = True
            operation = initialize if action == "initialize" else preflight
            proof["schemaBoundary"] = operation(connection, target, root.resolve(), user, password)
        proof["status"] = "synthetic-schema-verified"
    except Exception:
        proof.update(
            status="needs-reconciliation",
            error="qualification_schema_operation_unverified",
        )
        raise QualificationError("qualification_schema_operation_unverified") from None
    finally:
        user = password = None
        output.write_text(json.dumps(proof, indent=2) + "\n", encoding="utf-8")
    return proof


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", choices=("dev", "uat"), required=True)
    parser.add_argument("--action", choices=("initialize", "preflight"), default="preflight")
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        execute(Target(args.environment), args.source_root, args.output, action=args.action)
    except Exception:
        parser.exit(
            1,
            "qualification_schema_operation_unverified; reconcile the recorded attempt\n",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Create only the fixed empty qualification namespace; never migrate shared DBs."""

from __future__ import annotations

from qualification_foundation import CATALOGS, inspect_catalog
from qualification_target import (
    ABSENT_TABLES,
    DATABASE,
    MARKER,
    MIGRATOR_ROLE,
    RUNTIME_ROLE,
    Target,
    require,
)


def _database(connection, expected: str) -> None:
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_database()")
        require(
            cursor.fetchone() == (expected,), "qualification_database_target_mismatch"
        )


def _role(cursor, name: str, limit: int) -> bool:
    cursor.execute(
        "SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,"
        "rolbypassrls,rolconnlimit,shobj_description(oid,'pg_authid'),"
        "EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) "
        "FROM pg_roles r WHERE rolname=%s",
        (name,),
    )
    row = cursor.fetchone()
    if row is None:
        return False
    require(
        row == (True, False, False, False, False, False, False, limit, MARKER, False),
        "qualification_existing_role_unowned_or_privileged",
    )
    cursor.execute(
        "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datdba="
        "(SELECT oid FROM pg_roles WHERE rolname=%s) AND datname<>%s)",
        (name, DATABASE),
    )
    require(cursor.fetchone() == (False,), "qualification_role_owns_other_database")
    return True


def _ensure_role(connection, name: str, password: str, limit: int) -> None:
    from psycopg2 import sql

    require(
        isinstance(password, str) and 40 <= len(password) <= 128,
        "qualification_database_password_missing",
    )
    with connection.cursor() as cursor:
        if _role(cursor, name, limit):
            return  # Never rotate an existing role or a secret on retry.
        try:
            cursor.execute("BEGIN")
            cursor.execute(
                sql.SQL(
                    "CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE "
                    "NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT {}"
                ).format(
                    sql.Identifier(name), sql.Literal(password), sql.Literal(limit)
                )
            )
            cursor.execute(
                sql.SQL("COMMENT ON ROLE {} IS {}").format(
                    sql.Identifier(name), sql.Literal(MARKER)
                )
            )
            cursor.execute("COMMIT")
        except Exception:
            cursor.execute("ROLLBACK")
            raise


def ensure_namespace(connection, target: Target, passwords: dict[str, str]) -> dict:
    """Caller supplies its owned canonical proxy and genuine admin connection.

    Creation of a DB is nontransactional. An uncertain create before its ownership
    comment is recorded refuses retry until the release owner reconciles it.
    """
    from psycopg2 import sql

    require(isinstance(target, Target), "qualification_target_required")
    _database(connection, "postgres")
    require(connection.autocommit, "qualification_admin_autocommit_required")
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_try_advisory_lock(173734,20261027)")
        require(cursor.fetchone() == (True,), "qualification_namespace_busy")
        try:
            _ensure_role(connection, RUNTIME_ROLE, passwords["DB_PASSWORD"], 8)
            _ensure_role(
                connection, MIGRATOR_ROLE, passwords["MIGRATOR_DB_PASSWORD"], 2
            )
            cursor.execute(
                "SELECT pg_get_userbyid(datdba),shobj_description(oid,'pg_database') "
                "FROM pg_database WHERE datname=%s",
                (DATABASE,),
            )
            row = cursor.fetchone()
            if row is None:
                cursor.execute(
                    sql.SQL("CREATE DATABASE {} OWNER {} TEMPLATE template0").format(
                        sql.Identifier(DATABASE), sql.Identifier(MIGRATOR_ROLE)
                    )
                )
                cursor.execute(
                    sql.SQL("COMMENT ON DATABASE {} IS {}").format(
                        sql.Identifier(DATABASE), sql.Literal(MARKER)
                    )
                )
            else:
                require(
                    row == (MIGRATOR_ROLE, MARKER),
                    "qualification_existing_database_unowned",
                )
            cursor.execute(
                sql.SQL("REVOKE ALL ON DATABASE {} FROM PUBLIC").format(
                    sql.Identifier(DATABASE)
                )
            )
            cursor.execute(
                sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(
                    sql.Identifier(DATABASE), sql.Identifier(RUNTIME_ROLE)
                )
            )
        finally:
            cursor.execute("SELECT pg_advisory_unlock(173734,20261027)")
    return {
        "database": DATABASE,
        "status": "namespace-created-or-verified",
        "foundationInstalled": False,
        "environmentAccepted": False,
    }


def configure_runtime_grants(connection) -> None:
    """Only the dedicated DB's owner may establish grants for future D8 DDL."""
    from psycopg2 import sql

    _database(connection, DATABASE)
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_user")
        require(
            cursor.fetchone() == (MIGRATOR_ROLE,), "qualification_migrator_required"
        )
        cursor.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")
        cursor.execute(
            sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(
                sql.Identifier(RUNTIME_ROLE)
            )
        )
        for objects, grants in (
            ("TABLES", "SELECT,INSERT,UPDATE,DELETE"),
            ("SEQUENCES", "USAGE,SELECT"),
        ):
            cursor.execute(
                sql.SQL(
                    "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
                    "GRANT " + grants + " ON " + objects + " TO {}"
                ).format(sql.Identifier(MIGRATOR_ROLE), sql.Identifier(RUNTIME_ROLE))
            )


def inspect_baseline(connection, target: Target) -> dict:
    """Read-only structural boundary, not a full schema or journey acceptance."""
    from psycopg2 import sql

    require(isinstance(target, Target), "qualification_target_required")
    _database(connection, DATABASE)
    with connection.cursor() as cursor:
        cursor.execute("SHOW transaction_read_only")
        require(
            cursor.fetchone() == ("on",), "qualification_readonly_preflight_required"
        )
        cursor.execute(
            "SELECT pg_get_userbyid(datdba),shobj_description(oid,'pg_database') "
            "FROM pg_database WHERE datname=current_database()"
        )
        require(
            cursor.fetchone() == (MIGRATOR_ROLE, MARKER),
            "qualification_database_unowned",
        )
        for relation in ABSENT_TABLES:
            cursor.execute("SELECT to_regclass(%s)", ("public." + relation,))
            require(cursor.fetchone() == (None,), "qualification_phone_schema_present")
        cursor.execute(
            "SELECT to_regprocedure('public.account_provider_cleanup_contract_version()')"
        )
        require(cursor.fetchone() != (None,), "qualification_provider2_schema_required")
        cursor.execute("SELECT public.account_provider_cleanup_contract_version()")
        require(cursor.fetchone() == (2,), "qualification_provider2_schema_required")
        cursor.execute(
            "SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE "
            "tgrelid=to_regclass('public.account_deletion_tombstones') "
            "AND tgname='account_shared_provider_authority' "
            "AND tgenabled='O' AND NOT tgisinternal)"
        )
        require(cursor.fetchone() == (True,), "qualification_provider_guard_required")
        cursor.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' "
            "AND tablename NOT IN ('schema_migrations') ORDER BY tablename"
        )
        relations = [row[0] for row in cursor.fetchall()]
        require(
            {"consent_audit", "pkm_events", "pkm_domain_commits", *CATALOGS}
            <= set(relations),
            "qualification_synthetic_baseline_required",
        )
        for relation in relations:
            if relation in CATALOGS:
                inspect_catalog(cursor, relation)
                continue
            cursor.execute(
                sql.SQL("SELECT EXISTS(SELECT 1 FROM public.{})").format(
                    sql.Identifier(relation)
                )
            )
            require(
                cursor.fetchone() == (False,), "qualification_baseline_contains_rows"
            )
    return {
        "status": "empty-structural-boundary-verified",
        "database": DATABASE,
        "providerContractVersion": 2,
        "ownerRowsCopied": 0,
        "fullSchemaVerified": False,
        "environmentAccepted": False,
    }

"""Source-aware bootstrap DDL rights in the fixed owned qualification DB only.

S uses its runtime DB identity for startup CREATE IF NOT EXISTS. This unmerged
fixture therefore admits schema-wide public CREATE and ownership of five base
tables, including PostgreSQL's actual internal relation/type dependencies.
Installation is one-shot, transactional and never grants role membership. A
partial/previous ownership transition requires separate reconciliation.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import NamedTuple

from qualification_database import _role
from qualification_target import DATABASE, MIGRATOR_ROLE, RUNTIME_ROLE, Target, require

TABLES = (
    "fabric_consent_requests",
    "fabric_receipts",
    "fabric_subscription_grants",
    "kai_market_cache_entries",
    "pwm_documents",
)
KIND = "plg-isolated-bootstrap-ddl-v1"

GRAPH_SQL = """
WITH bases AS (
 SELECT c.oid,c.reltype,c.reltoastrelid FROM pg_class c
 JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname=ANY(%s)
), relations AS (
 SELECT oid,'table' AS kind,oid AS table_oid,1::bigint AS links FROM bases
 UNION ALL SELECT i.indexrelid,'index',b.oid,1 FROM bases b
 JOIN pg_index i ON i.indrelid=b.oid
 UNION ALL SELECT reltoastrelid,'toast',oid,1 FROM bases WHERE reltoastrelid<>0
 UNION ALL SELECT i.indexrelid,'toast-index',b.oid,1 FROM bases b
 JOIN pg_index i ON i.indrelid=b.reltoastrelid
 UNION ALL SELECT s.oid,'sequence',b.oid,
  (SELECT count(*) FROM pg_depend x WHERE x.classid='pg_class'::regclass
   AND x.objid=s.oid AND x.refclassid='pg_class'::regclass AND x.deptype IN ('a','i'))
 FROM bases b JOIN pg_depend d ON d.refobjid=b.oid
 JOIN pg_class s ON s.oid=d.objid AND s.relkind='S'
 JOIN pg_attribute a ON a.attrelid=b.oid AND a.attnum=d.refobjsubid AND NOT a.attisdropped
 WHERE d.classid='pg_class'::regclass AND d.refclassid='pg_class'::regclass
 AND d.deptype IN ('a','i') AND d.refobjsubid>0
), types AS (
 SELECT t.oid,'row-type' AS kind,b.oid AS table_oid FROM bases b
 JOIN pg_type t ON t.oid=b.reltype AND t.typrelid=b.oid AND t.typtype='c'
 UNION ALL SELECT a.oid,'array-type',b.oid FROM bases b
 JOIN pg_type t ON t.oid=b.reltype
 JOIN pg_type a ON a.oid=t.typarray AND a.typelem=t.oid AND a.typcategory='A'
)
SELECT 'pg_class',c.oid,n.nspname,c.relname,r.kind,r.table_oid,
 pg_get_userbyid(c.relowner),c.relkind::text,r.links
FROM relations r JOIN pg_class c ON c.oid=r.oid JOIN pg_namespace n ON n.oid=c.relnamespace
UNION ALL
SELECT 'pg_type',t.oid,n.nspname,t.typname,x.kind,x.table_oid,
 pg_get_userbyid(t.typowner),t.typtype::text,1
FROM types x JOIN pg_type t ON t.oid=x.oid JOIN pg_namespace n ON n.oid=t.typnamespace
ORDER BY 1,2
"""
OWNED_SQL = """
SELECT 'pg_class',oid FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=%s)
UNION ALL SELECT 'pg_type',oid FROM pg_type WHERE typowner=(SELECT oid FROM pg_roles WHERE rolname=%s)
"""
RIGHTS_SQL = """
SELECT has_schema_privilege(%s,'public','USAGE'),has_schema_privilege(%s,'public','CREATE'),
 COALESCE(has_table_privilege(%s,to_regclass('public.schema_migrations'),'INSERT,UPDATE,DELETE'),false),
 NOT EXISTS(SELECT 1 FROM pg_shdepend d WHERE d.refclassid='pg_authid'::regclass
  AND d.refobjid=(SELECT oid FROM pg_roles WHERE rolname=%s) AND d.deptype='o'
  AND (d.dbid<>(SELECT oid FROM pg_database WHERE datname=current_database())
   OR d.classid NOT IN ('pg_class'::regclass,'pg_type'::regclass)))
"""


class Object(NamedTuple):
    catalog: str
    oid: int
    schema: str
    name: str
    kind: str
    table_oid: int
    owner: str
    relkind: str
    links: int


def _objects(rows) -> tuple[Object, ...]:
    require(
        isinstance(rows, list) and 0 < len(rows) <= 100, "qualification_runtime_graph_unbounded"
    )
    require(
        all(isinstance(row, (tuple, list)) and len(row) == len(Object._fields) for row in rows),
        "qualification_runtime_graph_malformed",
    )
    objects = tuple(Object(*row) for row in rows)
    kinds = {
        "table": ("pg_class", "r"),
        "index": ("pg_class", "i"),
        "toast": ("pg_class", "t"),
        "toast-index": ("pg_class", "i"),
        "sequence": ("pg_class", "S"),
        "row-type": ("pg_type", "c"),
        "array-type": ("pg_type", "b"),
    }
    require(
        len({(o.catalog, o.oid) for o in objects}) == len(objects),
        "qualification_runtime_graph_duplicate",
    )
    for item in objects:
        require(
            all(type(v) is int and v > 0 for v in (item.oid, item.table_oid))
            and item.links == 1
            and type(item.links) is int
            and all(
                isinstance(v, str) for v in (item.catalog, item.schema, item.kind, item.relkind)
            )
            and kinds.get(item.kind) == (item.catalog, item.relkind)
            and item.schema == ("pg_toast" if item.kind.startswith("toast") else "public")
            and isinstance(item.owner, str)
            and bool(item.owner)
            and isinstance(item.name, str)
            and re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", item.name),
            "qualification_runtime_graph_malformed",
        )
    bases = {o.oid: o for o in objects if o.kind == "table"}
    require(
        {o.name for o in bases.values()} == set(TABLES)
        and len(bases) == len(TABLES)
        and all(o.oid == o.table_oid for o in bases.values()),
        "qualification_runtime_tables_missing",
    )
    counts = Counter((o.table_oid, o.kind) for o in objects)
    require(
        all(o.table_oid in bases and o.owner == bases[o.table_oid].owner for o in objects)
        and all(
            counts[(oid, "row-type")] == counts[(oid, "array-type")] == 1
            and counts[(oid, "toast")] == counts[(oid, "toast-index")] <= 1
            for oid in bases
        ),
        "qualification_runtime_dependencies_unverified",
    )
    return objects


def _binding(connection, *, write: bool) -> str:
    # Reuse the canonical SID/role/owned-DB identity check; never infer authority
    # from a caller's JSON, role name or an arbitrary supplied connection URL.
    from qualification_schema import identity

    parameters = connection.get_dsn_parameters()
    targets = [
        Target(env)
        for env in ("dev", "uat")
        if str(Target(env).proxy_port) == parameters.get("port")
    ]
    require(len(targets) == 1, "qualification_runtime_owned_socket_required")
    user = parameters.get("user", "")
    require(
        user not in {MIGRATOR_ROLE, RUNTIME_ROLE, ""},
        "qualification_runtime_canonical_admin_required",
    )
    identity(connection, targets[0], user)
    with connection.cursor() as cursor:
        cursor.execute("SHOW transaction_read_only")
        require(
            cursor.fetchone() == (("off" if write else "on"),),
            "qualification_runtime_session_mode_invalid",
        )
        if write:
            cursor.execute(
                "SELECT pg_has_role(current_user,'cloudsqlsuperuser','USAGE'),"
                "pg_has_role(current_user,%s,'USAGE'),pg_has_role(current_user,%s,'USAGE')",
                (MIGRATOR_ROLE, RUNTIME_ROLE),
            )
            require(
                cursor.fetchone() == (True, True, True),
                "qualification_runtime_existing_owner_authority_required",
            )
    return user


def _state(cursor):
    require(_role(cursor, RUNTIME_ROLE, 8), "qualification_runtime_role_missing")
    cursor.execute(GRAPH_SQL, (list(TABLES),))
    objects = _objects(cursor.fetchall())
    cursor.execute(OWNED_SQL, (RUNTIME_ROLE, RUNTIME_ROLE))
    owned = set(cursor.fetchall())
    cursor.execute(RIGHTS_SQL, (RUNTIME_ROLE,) * 4)
    rights = cursor.fetchone()
    require(
        rights is not None
        and len(rights) == 4
        and all(type(v) is bool for v in rights)
        and rights[0]
        and not rights[2]
        and rights[3],
        "qualification_runtime_schema_ledger_or_other_ownership_unverified",
    )
    return objects, owned, rights[1]


def _verified(cursor) -> tuple[Object, ...]:
    objects, owned, create = _state(cursor)
    require(
        create is True
        and all(o.owner == RUNTIME_ROLE for o in objects)
        and owned == {(o.catalog, o.oid) for o in objects},
        "qualification_runtime_bootstrap_ownership_unverified",
    )
    return objects


def _dml_grants(connection) -> None:
    """Existing source-object DML/routine grants, inside the bootstrap transaction."""
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


def _schema_grant(cursor, user: str) -> None:
    """Use the actual owned schema role; Cloud SQL CREATE lacks grant option."""
    from psycopg2 import sql

    cursor.execute("SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public'")
    row = cursor.fetchone()
    require(
        row is not None and row[0] in {user, MIGRATOR_ROLE, "pg_database_owner"},
        "qualification_runtime_schema_owner_unverified",
    )
    # The enclosing transaction and canonical temporary owner membership bound
    # this role switch to the already-verified private qualification database.
    cursor.execute(sql.SQL("SET LOCAL ROLE {}").format(sql.Identifier(row[0])))
    cursor.execute(
        sql.SQL("GRANT USAGE,CREATE ON SCHEMA public TO {}").format(sql.Identifier(RUNTIME_ROLE))
    )
    cursor.execute(
        "SELECT has_schema_privilege(%s,'public','USAGE'),has_schema_privilege(%s,'public','CREATE')",
        (RUNTIME_ROLE, RUNTIME_ROLE),
    )
    require(cursor.fetchone() == (True, True), "qualification_runtime_schema_grant_unverified")
    cursor.execute(sql.SQL("SET LOCAL ROLE {}").format(sql.Identifier(user)))
    cursor.execute("SELECT current_user")
    require(cursor.fetchone() == (user,), "qualification_runtime_admin_role_not_restored")


def install(connection) -> None:
    """Only a fresh admitted initializer/explicit reconciliation may call this."""
    from psycopg2 import sql

    require(connection.autocommit, "qualification_runtime_autocommit_required")
    user = _binding(connection, write=True)
    # Preserve the canonical reader's existing access on this owned fixture.
    # After temporary owner memberships end, schema-post must still read it.
    read_sql = """
    SELECT count(*)=%s,bool_and(has_table_privilege(current_user,c.oid,'SELECT')),
     bool_and(EXISTS(SELECT 1 FROM aclexplode(c.relacl) a
      WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname=current_user)
      AND a.privilege_type='SELECT')) AS preserved_admin_select
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY(%s)
    """
    with connection.cursor() as cursor:
        try:
            cursor.execute("BEGIN")
            cursor.execute(
                sql.SQL("LOCK TABLE {} IN ACCESS EXCLUSIVE MODE").format(
                    sql.SQL(",").join(sql.Identifier("public", name) for name in TABLES)
                )
            )
            before, owned, create = _state(cursor)
            require(
                not create and not owned and all(o.owner in {user, MIGRATOR_ROLE} for o in before),
                "qualification_runtime_pristine_install_required",
            )
            cursor.execute(read_sql, (len(TABLES), list(TABLES)))
            require(
                cursor.fetchone()[:2] == (True, True), "qualification_existing_admin_read_required"
            )
            _schema_grant(cursor, user)
            _dml_grants(connection)
            for name in TABLES:
                cursor.execute(
                    sql.SQL("ALTER TABLE public.{} OWNER TO {}").format(
                        sql.Identifier(name), sql.Identifier(RUNTIME_ROLE)
                    )
                )
                cursor.execute(
                    sql.SQL("GRANT SELECT ON TABLE public.{} TO {}").format(
                        sql.Identifier(name), sql.Identifier(user)
                    )
                )
            cursor.execute(read_sql, (len(TABLES), list(TABLES)))
            require(
                cursor.fetchone() == (True, True, True), "qualification_admin_read_not_preserved"
            )
            after = _verified(cursor)
            require(
                [o._replace(owner="") for o in before] == [o._replace(owner="") for o in after],
                "qualification_runtime_dependency_graph_changed",
            )
            cursor.execute("COMMIT")
        except Exception:
            cursor.execute("ROLLBACK")
            raise


def _scope() -> dict:
    return {
        "kind": KIND,
        "database": DATABASE,
        "runtimeRole": RUNTIME_ROLE,
        "roleConnectionLimit": 8,
        "schema": "public",
        "schemaPrivileges": ["USAGE", "CREATE"],
        "schemaPrivilegeScope": "schema-wide",
        "ownedTables": list(TABLES),
        "roleAdminCapabilities": False,
        "roleMemberships": [],
        "otherObjectOwnership": False,
        "ledgerOwned": False,
        "ledgerDml": False,
    }


def verify(connection) -> dict:
    """Read-only metadata proof; no initialization, GRANT or role-membership path."""
    _binding(connection, write=False)
    with connection.cursor() as cursor:
        objects = _verified(cursor)
    return _scope() | {"ownedObjects": [o._asdict() for o in objects]}


def validate_proof(proof) -> None:
    """Validate the hosted producer's finite graph; this never installs from JSON."""
    expected = _scope()
    require(
        isinstance(proof, dict) and set(proof) == {*expected, "ownedObjects"},
        "qualification_runtime_proof_invalid",
    )
    require(
        all(type(proof[k]) is type(v) and proof[k] == v for k, v in expected.items()),
        "qualification_runtime_proof_scope_changed",
    )
    rows = proof["ownedObjects"]
    require(
        isinstance(rows, list)
        and all(isinstance(o, dict) and set(o) == set(Object._fields) for o in rows),
        "qualification_runtime_proof_graph_invalid",
    )
    objects = _objects([tuple(row[k] for k in Object._fields) for row in rows])
    require(
        all(o.owner == RUNTIME_ROLE for o in objects), "qualification_runtime_proof_owner_changed"
    )

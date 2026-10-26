"""Operational writer barrier for the exact, empty-document restoration.

This is release DDL, not a migration replay. Keep the barrier while a non-reader
serves; only a separately qualified reader activation may remove it.
"""

from __future__ import annotations

import re

from psycopg2 import extensions, sql

TABLES = (
    "document_delivery_contracts",
    "document_delivery_financial_bindings",
    "document_delivery_cleanup",
)
FUNCTION = "block_document_intake_during_restoration"
TRIGGER = "trg_block_document_intake_during_restoration"
BODY = """BEGIN
  RAISE EXCEPTION USING ERRCODE='55000',
    MESSAGE='document delivery is unavailable during production restoration';
END;"""


class Refused(ValueError):
    """A redacted refusal; no database contents enter the release report."""


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise Refused(reason)


def install(
    connection, *, source: str, run_id: str, database: str = "hushh_vault"
) -> dict:
    """Drain prior writers, refuse existing documents, then fence future inserts.

    The main-owned caller admits the exact source and installed schema first.
    Explicit database injection supports disposable PostgreSQL rehearsals; the
    production caller must use the canonical database from its release target.
    """
    _require(bool(re.fullmatch(r"[0-9a-f]{40}", source)), "invalid_restoration_source")
    _require(bool(re.fullmatch(r"[1-9][0-9]*", run_id)), "invalid_restoration_run")
    _require(
        connection.get_transaction_status() == extensions.TRANSACTION_STATUS_IDLE,
        "restoration_fence_requires_idle_connection",
    )
    owner = f"hussh.production-restoration.v1:{source}:{run_id}"
    connection.set_session(
        readonly=False, isolation_level="READ COMMITTED", autocommit=False
    )
    with connection:
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL lock_timeout='20s'")
            cursor.execute("SET LOCAL statement_timeout='90s'")
            cursor.execute("SELECT current_database()")
            _require(cursor.fetchone()[0] == database, "restoration_database_mismatch")
            cursor.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended("
                "'hussh.production.document-restoration.v1',0))"
            )
            cursor.execute(
                sql.SQL("LOCK TABLE {} IN SHARE ROW EXCLUSIVE MODE").format(
                    sql.SQL(",").join(
                        sql.Identifier("public", table) for table in TABLES
                    )
                )
            )
            # READ COMMITTED takes this snapshot after outstanding writers settle.
            for table in TABLES:
                cursor.execute(
                    sql.SQL("SELECT EXISTS(SELECT 1 FROM {})").format(
                        sql.Identifier("public", table)
                    )
                )
                _require(
                    cursor.fetchone()[0] is False, "retained_documents_require_reader"
                )
            cursor.execute(
                "SELECT p.oid, p.prosrc, obj_description(p.oid,'pg_proc') "
                "FROM pg_proc p WHERE p.oid=to_regprocedure(%s)",
                (f"public.{FUNCTION}()",),
            )
            existing = cursor.fetchone()
            if existing is not None:
                _require(
                    existing[1] == BODY and existing[2] == owner,
                    "restoration_fence_owned_by_another_operation_or_changed",
                )
                _verify(cursor, existing[0])
                return {"status": "confirmed", "source": source, "runId": run_id}
            cursor.execute(
                "SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=%s)", (TRIGGER,)
            )
            _require(cursor.fetchone()[0] is False, "partial_restoration_fence")
            cursor.execute(
                sql.SQL(
                    "CREATE FUNCTION public.{}() RETURNS trigger LANGUAGE plpgsql "
                    "SET search_path=pg_catalog AS %s"
                ).format(sql.Identifier(FUNCTION)),
                (BODY,),
            )
            cursor.execute(
                sql.SQL("COMMENT ON FUNCTION public.{}() IS %s").format(
                    sql.Identifier(FUNCTION)
                ),
                (owner,),
            )
            for table in TABLES:
                # INSERT is the only way to create state in these empty tables.
                # Empty cascade DELETE/UPDATE must remain usable by account cleanup.
                cursor.execute(
                    sql.SQL(
                        "CREATE TRIGGER {} BEFORE INSERT ON {} FOR EACH STATEMENT "
                        "EXECUTE FUNCTION public.{}()"
                    ).format(
                        sql.Identifier(TRIGGER),
                        sql.Identifier("public", table),
                        sql.Identifier(FUNCTION),
                    )
                )
                cursor.execute(
                    sql.SQL("ALTER TABLE {} ENABLE ALWAYS TRIGGER {}").format(
                        sql.Identifier("public", table), sql.Identifier(TRIGGER)
                    )
                )
            cursor.execute("SELECT to_regprocedure(%s)::oid", (f"public.{FUNCTION}()",))
            _verify(cursor, cursor.fetchone()[0])
    return {"status": "installed", "source": source, "runId": run_id}


def _verify(cursor, function_oid: int) -> None:
    cursor.execute(
        "SELECT n.nspname,c.relname,t.tgenabled,t.tgtype,t.tgisinternal, "
        "t.tgname,t.tgnargs,t.tgqual IS NULL "
        "FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid "
        "JOIN pg_namespace n ON n.oid=c.relnamespace "
        "WHERE t.tgfoid=%s ORDER BY c.relname",
        (function_oid,),
    )
    _require(
        cursor.fetchall()
        == [
            ("public", table, "A", 6, False, TRIGGER, 0, True)
            for table in sorted(TABLES)
        ],
        "restoration_fence_registration_changed",
    )

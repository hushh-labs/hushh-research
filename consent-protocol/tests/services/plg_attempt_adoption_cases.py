"""Actual installed attempt-email erasure must remain exact across replay."""

import asyncpg
import pytest

from db.attempt_email_adoption import attempt_email_qualification_sql


async def assert_attempt_erasure_qualification(conn):
    qualification = attempt_email_qualification_sql()
    await conn.execute(qualification)
    mutations = (
        "ALTER TABLE account_deletion_tombstones DISABLE TRIGGER one_attempt_email_erasure",
        "DROP TRIGGER one_attempt_email_erasure ON account_deletion_tombstones",
        "ALTER FUNCTION erase_one_attempt_email() SECURITY DEFINER",
        "ALTER FUNCTION erase_one_attempt_email() SET search_path=public",
        "CREATE OR REPLACE FUNCTION erase_one_attempt_email() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RETURN NEW; END $$",
        "CREATE FUNCTION erase_one_attempt_email(integer) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$",
        "ALTER TABLE one_attempt_email_outbox RENAME TO synthetic_missing_outbox",
    )
    for ddl in mutations:
        # A real failed transaction restores each original guard before the next case.
        with pytest.raises(asyncpg.RaiseError, match="Unqualified attempt email erasure"):
            async with conn.transaction():
                await conn.execute(ddl)
                await conn.execute(qualification)
        await conn.execute(qualification)

"""Real observation SQL, deletion guards, epoch fencing, RLS and migration replay.

CI supplies a disposable PostgreSQL administrator URL. This test creates and
drops its own database because migration201 deliberately governs public DDL.
"""

import asyncio
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError

from hushh_mcp.services import marketing_preferences as marketing
from hushh_mcp.services import plg_outcomes as outcomes
from hushh_mcp.services import product_activity as activity
from hushh_mcp.services import product_value_receipts as values
from hushh_mcp.services.plg_audience import ATTEMPTS_SQL, summarize_attempts

pytestmark = pytest.mark.db
ROOT = Path(__file__).resolve().parents[2]


def test_observation_lifecycle_on_disposable_postgres(monkeypatch):
    configured = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not configured:
        pytest.skip("Canonical disposable PostgreSQL administrator URL is required")
    url = make_url(configured).set(drivername="postgresql+psycopg2")
    database = "plg_observation_test_" + uuid4().hex
    browser_role = "plg_observation_role_" + uuid4().hex
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql(f'CREATE DATABASE "{database}"')
    engine = create_engine(url.set(database=database), pool_size=4)
    migration = (ROOT / "db/migrations/365_one_product_activity_observations.sql").read_text()
    correlation = (ROOT / "db/migrations/366_one_product_activity_correlation.sql").read_text()
    value_migration = (ROOT / "db/migrations/367_one_product_value_receipts.sql").read_text()
    value_rollback = (
        ROOT / "db/migrations/rollback/367_one_product_value_receipts.rollback.sql"
    ).read_text()
    correlation_rollback = (
        ROOT / "db/migrations/rollback/366_one_product_activity_correlation.rollback.sql"
    ).read_text()
    rollback = (
        ROOT / "db/migrations/rollback/365_one_product_activity_observations.rollback.sql"
    ).read_text()
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.exec_driver_sql(f'CREATE ROLE "{browser_role}" NOLOGIN NOBYPASSRLS')
            conn.exec_driver_sql(
                "CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY); CREATE TABLE vault_keys(user_id TEXT PRIMARY KEY)"
            )
            for filename in [
                "173_gmail_owner_approved_delivery.sql",
                "275_scheduled_mail_send.sql",
                "192_gmail_personal_information_request_monitor.sql",
                "067_connected_systems.sql",
            ]:
                conn.connection.cursor().execute((ROOT / "db/migrations" / filename).read_text())
            conn.exec_driver_sql(
                "CREATE TABLE consent_audit(request_id TEXT, user_id TEXT, action TEXT, metadata JSONB, issued_at BIGINT)"
            )
            conn.connection.cursor().execute(
                (ROOT / "db/migrations/201_account_deletion_tombstones.sql").read_text()
            )
            conn.connection.cursor().execute(migration)
            conn.connection.cursor().execute(migration)
            conn.connection.cursor().execute(correlation)
            conn.connection.cursor().execute(correlation)
            conn.connection.cursor().execute(value_migration)
            conn.connection.cursor().execute(value_migration)
            permission_migration = (
                ROOT / "db/migrations/370_one_marketing_preferences.sql"
            ).read_text()
            conn.connection.cursor().execute(permission_migration)
            conn.connection.cursor().execute(permission_migration)
            conn.exec_driver_sql("INSERT INTO actor_profiles VALUES ('owner'),('other')")
            conn.exec_driver_sql("INSERT INTO vault_keys VALUES ('owner'),('other')")

        @contextmanager
        def connection():
            with engine.begin() as conn:
                yield conn

        monkeypatch.setattr(activity, "get_db_connection", connection)
        monkeypatch.setattr(activity, "enabled_for", lambda uid: uid in {"owner", "other"})
        monkeypatch.setattr(values, "get_db_connection", connection)
        asyncio.run(
            _assert_email_permission_lifecycle(
                url.set(database=database), browser_role, monkeypatch
            )
        )
        generation = activity.admission("owner")["generation"]
        _assert_domain_value_receipts(engine, browser_role, generation)
        asyncio.run(_assert_canonical_reply_association(url.set(database=database), monkeypatch))
        _assert_crm_outcome_query(engine)
        _assert_remaining_source_queries(engine)
        asyncio.run(_assert_batched_outcomes(url.set(database=database)))
        action = "observation:one_memory_action:detail_edited"
        assert activity.observe(
            "owner", generation, action, "returned", "client_reported", "operation"
        )
        assert not activity.observe(
            "owner", generation, action, "returned", "client_reported", "operation"
        )
        assert not activity.observe(
            "other", generation, action, "returned", "client_reported", "operation"
        )
        monkeypatch.setattr(activity, "DAILY_LIMIT", 2)
        with ThreadPoolExecutor(max_workers=2) as workers:
            admitted = list(
                workers.map(
                    lambda i: activity.observe(
                        "owner", generation, action, "returned", "client_reported", str(i)
                    ),
                    range(2),
                )
            )
        assert admitted.count(True) == 1
        with engine.begin() as conn:
            assert (
                conn.execute(
                    text("SELECT COUNT(*) FROM one_product_activity_observations")
                ).scalar()
                == 2
            )
            # AccountService rotates this epoch under its existing reset barrier.
            conn.execute(
                text(
                    "UPDATE one_product_activity_epochs SET generation=gen_random_uuid(),started_at=NOW() WHERE user_id='owner'"
                )
            )
            conn.execute(
                text("DELETE FROM one_product_activity_observations WHERE user_id='owner'")
            )
        assert not activity.observe(
            "owner", generation, action, "returned", "client_reported", "late-old-run"
        )
        assert not values._calendar_receipt("owner", "proposal", "delayed-before-reset", generation)
        current = activity.admission("owner")["generation"]
        assert current != generation
        assert activity.observe("owner", current, action, "returned", "client_reported", "new-run")
        with engine.begin() as conn:
            assert not conn.execute(
                text(
                    "SELECT has_table_privilege(:role,'one_product_activity_observations','SELECT')"
                ),
                {"role": browser_role},
            ).scalar()
            conn.exec_driver_sql(
                f'GRANT SELECT ON one_product_activity_observations TO "{browser_role}"'
            )
            assert (
                conn.exec_driver_sql(
                    "SELECT COUNT(*) FROM one_product_activity_observations"
                ).scalar()
                == 1
            )
            conn.exec_driver_sql(f'SET LOCAL ROLE "{browser_role}"')
            # Even an accidental table grant cannot bypass service-only RLS.
            assert (
                conn.exec_driver_sql(
                    "SELECT COUNT(*) FROM one_product_activity_observations"
                ).scalar()
                == 0
            )
        with engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE one_product_activity_observations SET expires_at=NOW()-INTERVAL '1 second'"
                )
            )
            roles = (
                conn.execute(
                    text("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')")
                )
                .scalars()
                .all()
            )
            for role in roles:
                assert not conn.execute(
                    text(
                        "SELECT has_table_privilege(:role,'one_product_activity_observations','SELECT')"
                    ),
                    {"role": role},
                ).scalar()
            assert conn.execute(
                text(
                    "SELECT relrowsecurity FROM pg_class WHERE oid='one_product_activity_observations'::regclass"
                )
            ).scalar()
        assert activity.purge_expired() == 1
        # Different invocations cannot cancel each other's missing terminal.
        monkeypatch.setattr(activity, "DAILY_LIMIT", 500)
        other_generation = activity.admission("other")["generation"]
        for phase, operation in (("started", "call-a"), ("returned", "call-b")):
            assert activity.observe(
                "other", other_generation, "agent:agent_one", phase, "execution_observed", operation
            )
        with engine.begin() as conn:
            keys = (
                conn.execute(
                    text(
                        "SELECT operation_key FROM one_product_activity_observations WHERE user_id='other'"
                    )
                )
                .scalars()
                .all()
            )
            assert len(set(keys)) == 2

        def projected():
            at = datetime.now(timezone.utc)
            # Execute the actual production query with SQLAlchemy's binding
            # spelling; this suite owns a real disposable PostgreSQL database.
            sql = ATTEMPTS_SQL
            for position, name in ((1, "ids"), (2, "agent"), (3, "since"), (4, "at")):
                sql = sql.replace(f"${position}", f":{name}")
            sql = sql.replace(":ids::text[]", "CAST(:ids AS text[])")
            with engine.begin() as conn:
                rows = (
                    conn.execute(
                        text(sql),
                        {
                            "ids": ["other"],
                            "agent": "agent_one",
                            "since": at - timedelta(days=7),
                            "at": at,
                        },
                    )
                    .mappings()
                    .all()
                )
            return summarize_attempts(
                rows,
                agent_id="agent_one",
                now=at + timedelta(hours=2),
                grace=60,
                epoch={"started_at": at - timedelta(hours=3)},
                limited=False,
                enabled=True,
            )

        before = projected()
        assert before["counts"]["possibleIncomplete"] == 1
        assert before["counts"]["returned"] == 1
        assert activity.observe(
            "other", other_generation, "agent:agent_one", "returned", "execution_observed", "call-a"
        )
        with engine.begin() as conn:
            keys = conn.execute(
                text(
                    "SELECT operation_key,COUNT(*) FROM one_product_activity_observations WHERE user_id='other' GROUP BY operation_key"
                )
            ).all()
            assert sorted(row[1] for row in keys) == [1, 2]
        after = projected()
        assert after["counts"]["possibleIncomplete"] == 0
        assert after["counts"]["returned"] == 2
        # A start receipt arriving last must not replace a terminal's timestamp.
        late_start = datetime.now(timezone.utc) - timedelta(minutes=1)
        terminal_at = late_start - timedelta(minutes=2)
        with engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE one_product_activity_observations SET observed_at="
                    "CASE WHEN phase='started' THEN :late_start ELSE :terminal_at END "
                    "WHERE user_id='other'"
                ),
                {"late_start": late_start, "terminal_at": terminal_at},
            )
        reordered = projected()
        assert reordered["lastObservedAt"] == late_start.isoformat()
        assert reordered["lastReturnedAt"] == terminal_at.isoformat()
        assert reordered["counts"]["returned"] == 2
        assert reordered["counts"]["possibleIncomplete"] == 0
        # Rolling back/replaying correlation never fabricates pairs for retained events.
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.connection.cursor().execute(correlation_rollback)
            conn.connection.cursor().execute(correlation)
            assert (
                conn.exec_driver_sql(
                    "SELECT COUNT(*) FROM one_product_activity_observations WHERE operation_key IS NOT NULL"
                ).scalar()
                == 0
            )
        legacy = projected()
        assert legacy["counts"]["uncorrelated"] == 3
        assert legacy["counts"]["possibleIncomplete"] == 0
        # Anonymous auth spines cannot enter expanded registered collection.
        with engine.begin() as conn:
            conn.exec_driver_sql(
                "CREATE TABLE actor_identity_cache(user_id TEXT PRIMARY KEY,email TEXT,phone_number TEXT,phone_verified BOOLEAN)"
            )
            conn.exec_driver_sql(
                "INSERT INTO actor_identity_cache VALUES ('other',NULL,NULL,FALSE)"
            )
        monkeypatch.setenv("ONE_PLG_ACTIVITY_ALL_REGISTERED", "true")
        assert activity.admission("other") is None
        assert not activity.observe(
            "other",
            other_generation,
            "agent:agent_one",
            "started",
            "execution_observed",
            "anonymous",
        )
        with engine.begin() as conn:
            conn.exec_driver_sql(
                "UPDATE actor_identity_cache SET phone_number='+919876543210',phone_verified=TRUE WHERE user_id='other'"
            )
        assert activity.admission("other") is not None
        monkeypatch.delenv("ONE_PLG_ACTIVITY_ALL_REGISTERED")
        assert values._calendar_receipt("owner", "proposal", "before-account-deletion", current)
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM actor_profiles WHERE user_id='owner'"))
        with pytest.raises(DBAPIError) as rejected:
            activity.admission("owner")
        assert rejected.value.orig.pgcode == "23514"
        assert rejected.value.orig.diag.constraint_name == "account_deletion_tombstone_guard"
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            assert (
                conn.exec_driver_sql(
                    "SELECT COUNT(*) FROM one_product_activity_epochs WHERE user_id='owner'"
                ).scalar()
                == 0
            )
            assert (
                conn.exec_driver_sql(
                    "SELECT COUNT(*) FROM one_product_value_receipts WHERE user_id='owner'"
                ).scalar()
                == 0
            )
            conn.connection.cursor().execute(value_rollback)
            assert (
                conn.exec_driver_sql(
                    "SELECT to_regclass('public.gmail_personal_information_reply_send_action')"
                ).scalar()
                is None
            )
            conn.connection.cursor().execute(rollback)
            conn.connection.cursor().execute(migration)
            conn.connection.cursor().execute(correlation)
            conn.connection.cursor().execute(value_migration)
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(
                text("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=:db"),
                {"db": database},
            )
            conn.exec_driver_sql(f'DROP DATABASE "{database}"')
            conn.exec_driver_sql(f'DROP ROLE IF EXISTS "{browser_role}"')
        admin.dispose()


async def _assert_email_permission_lifecycle(url, browser_role, monkeypatch):
    import asyncpg

    from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash

    pool = await asyncpg.create_pool(
        url.set(drivername="postgresql").render_as_string(hide_password=False),
        min_size=1,
        max_size=4,
    )

    async def get_pool():
        return pool

    monkeypatch.setattr(marketing, "get_pool", get_pool)
    owner = "permission-owner"
    digest = account_deletion_user_hash(owner)
    identity = {
        "email": "permission@example.invalid",
        "email_hash": marketing._email_hash("permission@example.invalid"),
        "name": "Permission fixture",
        "created_at": datetime.now(timezone.utc),
    }

    async def recipient(uid):
        assert uid == owner
        return identity

    monkeypatch.setattr(marketing, "verified_recipient", recipient)

    async def choose(revision, *, enabled=True, frequency="weekly"):
        return await marketing.choose_preference(
            owner,
            enabled=enabled,
            frequency=frequency,
            expected_revision=revision,
            disclosure_version=marketing.DISCLOSURE_VERSION,
            surface="account",
        )

    try:
        async with pool.acquire() as conn:
            # The output LIMIT must also bound database work across lifetime
            # acknowledged/erased history. Exercise the production SQL plans.
            await conn.execute("""INSERT INTO one_marketing_changes(user_hash,revision,erased,pending,updated_at)
              SELECT 'sha256:'||encode(digest('permission-plan-'||g::text,'sha256'),'hex'),
                1,g<9991,g=10000,NOW()-INTERVAL '2 hours' FROM generate_series(1,10000) g""")
            await conn.execute("ANALYZE one_marketing_changes")
            pending_plan = await conn.fetchval("EXPLAIN (FORMAT JSON) " + marketing.PENDING_SQL)
            reconciliation_plan = await conn.fetchval(
                "EXPLAIN (FORMAT JSON) " + marketing.RECONCILE_SQL, 5
            )
            assert "one_marketing_pending" in pending_plan
            assert "one_marketing_reconcile" in reconciliation_plan
            await conn.execute("DELETE FROM one_marketing_changes")
            # A provisional phone orphan can become a protected established
            # account. Cancelling that intent must not leave erased history
            # that suppresses the owner's later explicit choice. The full
            # account erasure case below must still suppress and block writes.
            await conn.execute(
                """INSERT INTO account_deletion_tombstones(user_id_hash,cleanup_intent_kind)
                VALUES($1,'phone_orphan')""",
                digest,
            )
            await conn.execute(
                """DELETE FROM account_deletion_tombstones
                WHERE user_id_hash=$1 AND cleanup_intent_kind='phone_orphan'""",
                digest,
            )
            await conn.execute("INSERT INTO actor_profiles VALUES($1)", owner)
        # Merely loading a default never creates permission or an enrollment event.
        assert (await marketing.preference(owner))["revision"] == 0
        async with pool.acquire() as conn:
            assert await conn.fetchval("SELECT COUNT(*) FROM one_marketing_preferences") == 0
            assert await conn.fetchval("SELECT COUNT(*) FROM one_marketing_changes") == 0
        simultaneous = await asyncio.gather(
            choose(0), choose(0, frequency="daily"), return_exceptions=True
        )
        assert sum(isinstance(r, marketing.PreferenceConflict) for r in simultaneous) == 1
        selected = next(r for r in simultaneous if isinstance(r, dict))
        assert selected["revision"] == 1
        generation = UUID(selected["generation"])
        batch = (await marketing.pending_changes())["changes"]
        assert len(batch) == 1 and batch[0]["eligible"] and batch[0]["enabled"]
        assert batch[0]["accountId"] == owner and batch[0]["cohort"] == "new"
        assert await marketing.current_permission(owner, generation, identity["email_hash"], 1) == {
            "allowed": True,
            "erased": False,
        }
        await marketing.acknowledge([(digest, 1)])
        changed = await choose(1, frequency="updates")
        assert changed["generation"] == str(generation) and changed["revision"] == 2
        await marketing.acknowledge([(digest, 1)])
        async with pool.acquire() as conn:
            assert await conn.fetchval(
                "SELECT pending FROM one_marketing_changes WHERE user_hash=$1", digest
            )
        # A frequency edit cannot escape a pending unsubscribe or authorize a stale daily send.
        assert not (
            await marketing.current_permission(owner, generation, identity["email_hash"], 1)
        )["allowed"]
        assert (await marketing.revoke_generation(digest, generation))["revoked"]
        assert not (await marketing.preference(owner))["enabled"]
        opted_back_in = await choose(3)
        assert opted_back_in["generation"] != str(generation)
        assert not (await marketing.revoke_generation(digest, generation))["revoked"]
        assert (await marketing.preference(owner))["enabled"]

        # Recipient availability is independent of the canonical choice revision.
        async def unverified(_):
            raise marketing.VerifiedEmailRequired()

        monkeypatch.setattr(marketing, "verified_recipient", unverified)
        unavailable = (await marketing.pending_changes())["changes"][0]
        assert (
            unavailable["enabled"]
            and not unavailable["eligible"]
            and "accountId" not in unavailable
        )
        await marketing.acknowledge([(digest, unavailable["revision"])])
        monkeypatch.setattr(marketing, "verified_recipient", recipient)
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE one_marketing_changes SET updated_at=NOW()-INTERVAL '2 hours'"
            )
        recovered = (await marketing.pending_changes())["changes"][0]
        assert recovered["revision"] == unavailable["revision"] and recovered["eligible"]
        async with pool.acquire() as conn:
            rollback = (
                ROOT / "db/migrations/rollback/370_one_marketing_preferences.rollback.sql"
            ).read_text()
            with pytest.raises(
                asyncpg.PostgresError, match="rollback_refused_nonempty_marketing_state"
            ):
                await conn.execute(rollback)
            await conn.execute("ROLLBACK")
            assert not await conn.fetchval(
                "SELECT has_table_privilege($1,'one_marketing_preferences','SELECT')", browser_role
            )
            async with conn.transaction():
                await conn.execute(
                    f'GRANT SELECT ON one_marketing_preferences,one_marketing_changes TO "{browser_role}"'
                )
                await conn.execute(f'SET LOCAL ROLE "{browser_role}"')
                assert await conn.fetchval("SELECT COUNT(*) FROM one_marketing_preferences") == 0
                assert await conn.fetchval("SELECT COUNT(*) FROM one_marketing_changes") == 0
        # A lookup already in flight must not export identity after a committed opt-out or erasure.
        for erase in (False, True):
            started, resume = asyncio.Event(), asyncio.Event()

            async def paused(uid, started=started, resume=resume):
                started.set()
                await resume.wait()
                return await recipient(uid)

            monkeypatch.setattr(marketing, "verified_recipient", paused)
            pull = asyncio.create_task(marketing.pending_changes())
            await asyncio.wait_for(started.wait(), 5)
            if erase:
                async with pool.acquire() as conn:
                    await conn.execute("DELETE FROM actor_profiles WHERE user_id=$1", owner)
            else:
                await choose(4, enabled=False)
            resume.set()
            raced = (await pull)["changes"]
            assert all("accountId" not in r and "email" not in r and "name" not in r for r in raced)
            monkeypatch.setattr(marketing, "verified_recipient", recipient)
            if not erase:
                await choose(5)
        erased = (await marketing.pending_changes())["changes"][0]
        assert erased["erased"] and not erased["enabled"]
        async with pool.acquire() as conn:
            assert await conn.fetchval("SELECT COUNT(*) FROM one_marketing_preferences") == 0
        with pytest.raises(PermissionError):
            await choose(erased["revision"])
        # Replay an empty rollback only in this disposable database; real nonempty state remains protected.
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM one_marketing_changes")
            await conn.execute(rollback)
            await conn.execute(
                (ROOT / "db/migrations/370_one_marketing_preferences.sql").read_text()
            )
    finally:
        await pool.close()


def _assert_domain_value_receipts(engine, browser_role, generation):
    assert values._calendar_receipt("owner", "proposal", "provider-confirmed", generation)
    assert not values._calendar_receipt("owner", "proposal", "provider-confirmed", generation)
    assert not values._calendar_receipt("other", "proposal", "foreign-generation", generation)
    assert not values._decision_receipt("owner", "not-persisted", generation, "approve")
    with engine.begin() as conn:
        conn.execute(
            text("""INSERT INTO consent_audit VALUES ('request','alias@example.invalid','CONSENT_GRANTED',
          '{"decision_owner_uid":"other","owner_decision":"approve"}',floor(extract(epoch from clock_timestamp())*1000)::bigint)""")
        )
    assert not values._decision_receipt("owner", "request", generation, "approve")
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE consent_audit SET metadata=jsonb_set(metadata,'{decision_owner_uid}','\"owner\"')"
            )
        )
    assert values._decision_receipt("owner", "request", generation, "approve")
    assert not values._decision_receipt("owner", "request", generation, "deny")
    values.record_location_effect_sync(
        user_id="owner", kind="private_share", source_id="grant", generation=generation
    )
    with engine.begin() as conn:
        for query in [outcomes.CALENDAR_SQL, outcomes.NAV_SQL, outcomes.LOCATION_DIRECT_SQL]:
            rows = conn.execute(
                text(query.replace("$1", ":uid").replace("$2", ":since").replace("$3", ":until")),
                {
                    "uid": "owner",
                    "since": datetime.now(timezone.utc) - timedelta(days=7),
                    "until": datetime.now(timezone.utc),
                },
            ).all()
            assert len(rows) == 1
        assert not conn.execute(
            text("SELECT has_table_privilege(:role,'one_product_value_receipts','SELECT')"),
            {"role": browser_role},
        ).scalar()
        conn.exec_driver_sql(f'GRANT SELECT ON one_product_value_receipts TO "{browser_role}"')
        conn.exec_driver_sql(f'SET LOCAL ROLE "{browser_role}"')
        assert conn.exec_driver_sql("SELECT COUNT(*) FROM one_product_value_receipts").scalar() == 0
    with engine.begin() as conn:
        conn.execute(
            text("""INSERT INTO one_product_value_receipts(effect_id,user_id,generation,agent_id,proof)
          SELECT lpad(n::text,64,'0'),'owner',CAST(:generation AS UUID),'agent_calendar','calendar.provider_effect.v1'
          FROM generate_series(1,497) n"""),
            {"generation": generation},
        )
    assert not values._calendar_receipt("owner", "proposal", "over-cap", generation)
    with engine.begin() as conn:
        assert (
            conn.exec_driver_sql("SELECT COUNT(*) FROM one_product_value_receipts").scalar() == 500
        )
        at = datetime.now(timezone.utc)
        query = (
            outcomes.CAPACITY_SQL.replace("$1", ":uid")
            .replace("$2", ":since")
            .replace("$3", ":until")
        )
        assert conn.execute(
            text(query),
            {
                "uid": "owner",
                "since": at + timedelta(microseconds=1),
                "until": at + timedelta(microseconds=2),
            },
        ).scalar()
        conn.exec_driver_sql("DELETE FROM one_product_value_receipts")


async def _assert_canonical_reply_association(url, monkeypatch):
    import asyncpg

    from hushh_mcp.services import gmail_personal_information_request_service as monitor

    pool = await asyncpg.create_pool(
        url.set(drivername="postgresql").render_as_string(hide_password=False),
        min_size=1,
        max_size=1,
    )

    async def get_pool():
        return pool

    monkeypatch.setattr(monitor, "get_pool", get_pool)
    workflow = uuid4()
    try:
        async with pool.acquire() as conn:
            index = await conn.fetchval(
                "SELECT indexdef FROM pg_indexes WHERE schemaname='public' "
                "AND indexname='gmail_personal_information_reply_send_action'"
            )
            assert (
                "(reply_send_action_id)" in index
                and "WHERE (reply_send_action_id IS NOT NULL)" in index
            )
            await conn.execute(
                """INSERT INTO gmail_personal_information_requests
              (workflow_id,user_id,gmail_message_id,gmail_thread_id,source_hmac,classification_confidence)
              VALUES($1,'owner','inbox-message','thread',repeat('a',64),0.99)""",
                workflow,
            )
            for action, uid, state, thread, scheduled in [
                ("foreign", "other", "sent", "thread", False),
                ("wrong-thread", "owner", "sent", "other-thread", False),
                ("unknown", "owner", "outcome_unknown", "thread", False),
                ("scheduled", "owner", "sent", "thread", True),
                ("correct", "owner", "sent", "thread", False),
            ]:
                await conn.execute(
                    """INSERT INTO gmail_owner_send_actions
                  (action_id,user_id,envelope_hmac,idempotency_hmac,recipient_count,state,expires_at,sent_at,gmail_message_id,gmail_thread_id,send_at)
                  VALUES($1,$2,repeat('a',64),$1,1,$3,NOW()+INTERVAL '1 day',NOW(),'provider-message',$4,
                    CASE WHEN $5 THEN NOW() ELSE NULL END)""",
                    action,
                    uid,
                    state,
                    thread,
                    scheduled,
                )
        service = monitor.PersonalGmailInformationRequestService()
        for action in ["missing", "foreign", "wrong-thread", "unknown", "scheduled", "correct"]:
            result = {"state": "sent", "action_id": action}
            assert (
                await service.record_reply_delivery(
                    user_id="owner", workflow_id=str(workflow), result=result
                )
                == result
            )
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT status,reply_send_action_id FROM gmail_personal_information_requests WHERE workflow_id=$1",
                    workflow,
                )
                assert (row["status"] == "sent") == (action == "correct")
                assert row["reply_send_action_id"] == ("correct" if action == "correct" else None)
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                outcomes.KYC_SQL,
                "owner",
                datetime.now(timezone.utc) - timedelta(days=7),
                datetime.now(timezone.utc),
            )
            assert [r["action_id"] for r in rows] == ["correct"]
    finally:
        await pool.close()


def _assert_crm_outcome_query(engine):
    now = datetime.now(timezone.utc)
    with engine.begin() as conn:
        for name, before in [("old", True), ("new", False), ("unverified", False)]:
            conn.execute(
                text("""INSERT INTO connected_system_intents
              (intent_id,user_id,system_id,action,status,target,object_type,approval_id,result_class)
              VALUES(:id,'owner','crm','create','succeeded','target','record',:id,'succeeded')"""),
                {"id": name},
            )
            conn.execute(
                text("""INSERT INTO connected_system_audit_events
              (event_id,user_id,system_id,target,object_type,action,intent_id,approval_id,mcp_result_class,readback_result_class,status,created_at)
              VALUES(:id,'owner','crm','target','record','create',:id,:id,'succeeded',:readback,'succeeded',:at)"""),
                {
                    "id": name,
                    "readback": "failed" if name == "unverified" else "succeeded",
                    "at": now - timedelta(days=8) if before else now,
                },
            )
        conn.execute(
            text("""INSERT INTO connected_system_audit_events
          SELECT 'replay-'||n,user_id,system_id,target,object_type,action,record_id,intent_id,approval_id,
            field_names_json,mcp_result_class,readback_result_class,status,metadata_json,NOW()
          FROM connected_system_audit_events CROSS JOIN generate_series(1,1002) n WHERE event_id='old'""")
        )
        query = (
            outcomes.CRM_SQL.replace("$1", ":uid").replace("$2", ":since").replace("$3", ":until")
        )
        rows = conn.execute(
            text(query),
            {"uid": "owner", "since": now - timedelta(days=7), "until": now + timedelta(seconds=1)},
        ).all()
        assert [r.action_id for r in rows] == ["new"]


async def _assert_batched_outcomes(url):
    import asyncpg

    conn = await asyncpg.connect(
        url.set(drivername="postgresql").render_as_string(hide_password=False)
    )
    now = datetime.now(timezone.utc) + timedelta(seconds=1)
    since = now - timedelta(days=7)
    owners = ["owner", "other", *[f"empty-page-owner-{n}" for n in range(23)]]
    try:
        expected = {
            uid: await outcomes.value_summary(conn, uid, "agent_one", since, now)
            for uid in owners[:2]
        }
        queries = []

        class PageConnection:
            async def fetch(self, query, *args, **kwargs):
                assert args[0] == owners
                queries.append(query)
                return await conn.fetch(query, *args, **kwargs)

        actual = await outcomes.value_summaries(PageConnection(), owners, "agent_one", since, now)
        assert len(queries) == 11
        assert actual["owner"] == expected["owner"] and expected["owner"]["count"] > 0
        assert actual["other"] == expected["other"]
        assert all(actual[uid]["count"] == 0 for uid in owners[2:])
        # The SQL limit belongs to each owner, never to the flattened page.
        owners = ["dense-owner' OR 1=1 --", *[f"dense-page-owner-{n}" for n in range(24)]]
        await conn.executemany(
            "INSERT INTO actor_profiles(user_id) VALUES($1)", [(uid,) for uid in owners]
        )
        await conn.executemany(
            "INSERT INTO vault_keys(user_id) VALUES($1)", [(uid,) for uid in owners]
        )
        await conn.execute(
            """WITH effects AS (
              SELECT uid,uid||':'||n AS id,n FROM unnest($1::text[]) owners(uid)
              CROSS JOIN generate_series(1,1002) numbers(n)
            ) INSERT INTO gmail_owner_send_actions
              (action_id,user_id,envelope_hmac,idempotency_hmac,recipient_count,state,expires_at,sent_at,gmail_message_id)
              SELECT id,uid,repeat('a',64),md5(id)||md5(id),1,'sent',
                $2::timestamptz+INTERVAL '1 day',$2::timestamptz-n*INTERVAL '1 second','provider-'||id
              FROM effects""",
            owners,
            now,
        )
        queries.clear()
        dense = await outcomes.value_summaries(PageConnection(), owners, "agent_email", since, now)
        assert len(queries) == 1
        assert all(row["count"] == 1000 and row["limited"] for row in dense.values())
        assert all(
            row["lastAt"] == (now - timedelta(seconds=1)).isoformat() for row in dense.values()
        )
    finally:
        await conn.close()


def _assert_remaining_source_queries(engine):
    from hushh_mcp.services.pkm_mutation_contracts import derive_pkm_mutation_commit_id

    now = datetime.now(timezone.utc)
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        conn.exec_driver_sql("CREATE TABLE pkm_domain_revisions(revision_id UUID PRIMARY KEY)")
        # Reuse the actual source table definitions, including their field types.
        for name, table in [
            ("098_pkm_v7_recovery_foundation.sql", "pkm_domain_commits"),
            ("030_pkm_cutover.sql", "pkm_events"),
            ("302_wallet_temporary_card_access.sql", "wallet_card_registrations"),
        ]:
            migration = (ROOT / "db/migrations" / name).read_text()
            conn.exec_driver_sql(
                re.search(
                    rf"CREATE TABLE IF NOT EXISTS {table}\s*\(.*?\n\);", migration, re.S
                ).group()
            )
        conn.exec_driver_sql("CREATE TABLE agent_chat_conversations(id UUID PRIMARY KEY)")
        conn.exec_driver_sql(
            "CREATE TABLE one_adk_sessions(app_name TEXT,user_id TEXT,session_id TEXT,created_at TIMESTAMPTZ)"
        )
        for name in [
            "114_one_action_directive_ledger.sql",
            "212_location_command_runtime.sql",
            "216_location_command_membership_receipts.sql",
            "217_location_command_effect_receipts.sql",
            "231_document_review_authority.sql",
            "232_drive_document_sharing.sql",
        ]:
            conn.connection.cursor().execute((ROOT / "db/migrations" / name).read_text())
    with engine.begin() as conn:
        for domain, writer in [
            ("financial", "kai_analysis_completion"),
            ("professional", "career_resume_owner_review"),
            ("wallet", "wallet_card_owner_review"),
        ]:
            plan = "pkm_plan_abcdefghijkl"
            commit = derive_pkm_mutation_commit_id(user_id="owner", domain=domain, plan_id=plan)
            conn.execute(
                text("""INSERT INTO pkm_domain_commits
              (commit_id,user_id,domain,commit_kind,expected_content_revision,expected_manifest_revision,result_content_revision,result_manifest_revision)
              VALUES(CAST(:id AS UUID),'owner',:domain,'mutation',0,0,1,1)"""),
                {"id": commit, "domain": domain},
            )
            conn.execute(
                text("""INSERT INTO pkm_events(user_id,domain,operation_type,metadata)
              VALUES('owner',:domain,'content_write',CAST(:metadata AS JSONB))"""),
                {
                    "domain": domain,
                    "metadata": json.dumps(
                        {
                            "data_version": 1,
                            "provenance": {
                                "authorization_mode": "owner_confirmed",
                                "mutation_plan_id": plan,
                                "confirmation_receipt_id": "confirmed",
                                "writer_id": writer,
                            },
                        }
                    ),
                },
            )
            if domain == "wallet":
                conn.execute(
                    text("""INSERT INTO wallet_card_registrations
                  (owner_user_id,card_id,registration_request_id,state,activated_at,source_commit_id)
                  VALUES('owner',:card,:request,'active',NOW(),CAST(:id AS UUID))"""),
                    {"card": "card_" + str(uuid4()), "request": uuid4(), "id": commit},
                )
        for effect, changed in [("real", True), ("noop", False)]:
            conn.execute(
                text("""INSERT INTO one_action_directive_ledger
              (directive_id,user_id,channel,session_id,action_id,context_revision,action_contract_digest,slots_hmac,state,
               expires_at,command_step,operation_id,effect_request_hmac,effect_receipt,settlement_status,settled_at)
              VALUES(:id,'owner','command',:id,'location.checkout_nearby','revision','digest','hmac','settled',
                NOW()+INTERVAL '1 hour',0,:id,repeat('a',64),CAST(:receipt AS JSONB),'succeeded',NOW())"""),
                {"id": effect, "receipt": json.dumps({"checkout_transitioned": changed})},
            )
        for member_added in [True, False]:
            key = "members-" + str(member_added)
            conn.execute(
                text("""INSERT INTO one_action_directive_ledger
              (directive_id,user_id,channel,session_id,action_id,context_revision,action_contract_digest,slots_hmac,state,
               expires_at,command_step,operation_id,membership_receipts,settlement_status,settlement_reason_code,settled_at)
              VALUES(:id,'owner','command',:id,'location.add_to_circle','revision','digest','hmac','settled',
                NOW()+INTERVAL '1 hour',0,:id,CAST(:receipt AS JSONB),'succeeded','verified_membership_receipts',NOW())"""),
                {
                    "id": key,
                    "receipt": json.dumps(
                        {
                            "0": {
                                "result": {
                                    "addedUserIds": ["person"] if member_added else [],
                                    "skippedUserIds": [] if member_added else ["already-member"],
                                }
                            }
                        }
                    ),
                },
            )
        for kind in ["approved", "automatic", "preexisting"]:
            request, operation = uuid4(), uuid4()
            conn.execute(
                text("""INSERT INTO drive_share_requests
              (request_id,user_id,recipient_user_id,client_request_id,request_envelope,recipient_binding,request_digest)
              VALUES(:id,'owner','recipient',:id,'{}',repeat('a',64),repeat('b',64))"""),
                {"id": request},
            )
            conn.execute(
                text("""INSERT INTO drive_share_reviews
              (request_id,revision,user_id,connection_generation,review_envelope,review_digest,directive_id,decision,expires_at,decided_at)
              VALUES(:id,1,'owner',1,'{}',repeat('a',64),:directive,'approved',NOW()+INTERVAL '1 hour',NOW())"""),
                {"id": request, "directive": None if kind == "automatic" else kind},
            )
            if kind != "automatic":
                conn.execute(
                    text("""INSERT INTO one_action_directive_ledger
                  (directive_id,user_id,channel,action_id,context_revision,action_contract_digest,slots_hmac,resource_binding_hmac,
                   trusted_activation_required,state,expires_at,operation_id,document_request_id,document_request_revision,confirmed_at,consumed_at)
                  VALUES(:kind,'owner','document_review','documents.share_originals','revision',repeat('a',64),repeat('b',64),repeat('c',64),
                    TRUE,'consumed',NOW()+INTERVAL '1 hour',:kind,:request,1,NOW(),NOW())"""),
                    {"kind": kind, "request": request},
                )
            conn.execute(
                text("""INSERT INTO drive_share_permission_operations
              (operation_id,user_id,request_id,review_revision,batch_id,document_id,connection_generation,file_lock_hmac,
               kind,plan_envelope,receipt_envelope,state,settled_at)
              VALUES(:operation,'owner',:request,1,:kind,:document,1,repeat('d',64),'grant','{}','{}',:state,NOW())"""),
                {
                    "operation": operation,
                    "request": request,
                    "kind": kind,
                    "document": uuid4(),
                    "state": "preexisting" if kind == "preexisting" else "succeeded",
                },
            )
        for query, expected in [
            (outcomes.MEMORY_SQL, 3),
            (outcomes.WALLET_SQL, 1),
            (outcomes.LOCATION_SQL, 2),
            (outcomes.DOCUMENTS_SQL, 1),
        ]:
            rows = (
                conn.execute(
                    text(
                        query.replace("$1", ":uid").replace("$2", ":since").replace("$3", ":until")
                    ),
                    {
                        "uid": "owner",
                        "since": now - timedelta(days=7),
                        "until": datetime.now(timezone.utc) + timedelta(seconds=1),
                    },
                )
                .mappings()
                .all()
            )
            assert len(rows) == expected, query
            if query == outcomes.MEMORY_SQL:
                assert all(outcomes.confirmed_memory(row, "owner") for row in rows)

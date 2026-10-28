"""Owner financial summary policy, migration and rolling-version privacy fences."""

# ruff: noqa: F401,F811 -- reuse the existing disposable PostgreSQL fixture graph
import pytest
from psycopg2.errors import CheckViolation
from sqlalchemy import text

from db.migration_authority import _replay_sql, build_manifest_entries
from hushh_mcp.services.drive_packet_public_preferences import SUMMARY_POLICY
from hushh_mcp.services.drive_packet_public_summary import DISCLOSURE
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.pkm_conformance.postgres_harness import find_pg_bin
from tests.services.test_drive_packet_public_summary_postgres import (
    collection,
    collection_pages,
    completed_preview,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    ingestion,
    lifecycle,
    prepared,
    publish,
    reusable,
    sharing,
)
from tests.test_migrations_are_replay_safe import MIGRATIONS_DIR, replay_pg

pytestmark = [pytest.mark.feature_drive_packets, pytest.mark.trace_loop]


async def test_owner_toggle_hides_every_period_and_survives_new_periods_and_reconnect(
    reusable, monkeypatch
):
    from datetime import UTC, datetime

    runtime, head, person, service = await prepared(reusable, monkeypatch)
    assert await service.get_preference(user_id="owner") == {
        "enabled": True,
        "revision": 0,
        "disclosure": SUMMARY_POLICY,
    }
    before = await service.list_public_summaries(viewer_user_id="stranger", person_ref=person)
    assert len(before["packets"]) > 1
    off = await service.set_preference(
        user_id="owner", enabled=False, expected_revision=0, disclosure=SUMMARY_POLICY
    )
    assert off == {"enabled": False, "revision": 1, "disclosure": SUMMARY_POLICY}
    with pytest.raises(DriveReadError, match="listing_changed"):
        await service.set_preference(
            user_id="owner", enabled=True, expected_revision=0, disclosure=SUMMARY_POLICY
        )
    assert (await service.list_public_summaries(viewer_user_id="stranger", person_ref=person))[
        "packets"
    ] == []
    await runtime.store.ensure_owner(user_id="owner", now=datetime(2030, 3, 1, tzinfo=UTC))
    with runtime.store.db.engine.begin() as c:
        c.exec_driver_sql(
            "UPDATE user_external_connector_connections SET connection_generation=2 WHERE user_id='owner'"
        )
    await runtime.store.ensure_owner(user_id="owner", now=datetime(2030, 3, 1, tzinfo=UTC))
    assert (await service.get_preference(user_id="owner"))["enabled"] is False
    assert (await service.list_public_summaries(viewer_user_id="stranger", person_ref=person))[
        "packets"
    ] == []
    on = await service.set_preference(
        user_id="owner", enabled=True, expected_revision=1, disclosure=SUMMARY_POLICY
    )
    assert on["enabled"] and on["revision"] == 2
    visible = await service.list_public_summaries(viewer_user_id="stranger", person_ref=person)
    assert visible["packets"] and all(item["version"] == 0 for item in visible["packets"])
    with runtime.store.db.engine.connect() as c:
        assert (
            c.exec_driver_sql(
                "SELECT count(*) FROM drive_packet_heads WHERE public_summary_accepted_at IS NOT NULL"
            ).scalar_one()
            == 0
        )
        assert c.exec_driver_sql("SELECT count(*) FROM drive_share_requests").scalar_one() == 0
    runtime.planner.assert_not_awaited()
    runtime.search.transport.read_tool.assert_not_awaited()


@pytest.mark.parametrize(
    "enabled,revision,expected", [(False, 0, True), (False, 2, False), (True, 2, True)]
)
async def test_owner_policy_migration_preserves_only_explicit_hides_and_background_off(
    reusable, monkeypatch, enabled, revision, expected
):
    from tests.drive_postgres_test_support import MIGRATIONS, apply_drive_fixture_migration

    runtime, head, person, service = await prepared(reusable, monkeypatch)
    with runtime.store.db.engine.begin() as c:
        c.exec_driver_sql(
            "DROP TRIGGER IF EXISTS preserve_drive_financial_summary_hide ON drive_packet_heads"
        )
        c.execute(
            text("""UPDATE drive_packet_heads SET public_summary_enabled=:enabled,
            public_summary_revision=:revision,public_summary_version=current_version,
            public_summary_generation=connection_generation,
            public_summary_disclosure=:disclosure,
            public_summary_accepted_at=CASE WHEN :revision>0 THEN clock_timestamp() ELSE NULL END
            WHERE packet_id=:id"""),
            {
                "id": head["packet_id"],
                "enabled": enabled,
                "revision": revision,
                "disclosure": DISCLOSURE,
            },
        )
        c.exec_driver_sql(
            "INSERT INTO drive_live_preferences(user_id,connection_generation,background_enabled) VALUES('owner',1,FALSE)"
        )
        apply_drive_fixture_migration(c, "428_financial_summary_owner_preference.sql")
        apply_drive_fixture_migration(c, "428_financial_summary_owner_preference.sql")
        assert (
            c.exec_driver_sql(
                "SELECT background_enabled FROM drive_live_preferences WHERE user_id='owner'"
            ).scalar_one()
            is False
        )
    preference = await service.get_preference(user_id="owner")
    assert preference["enabled"] is expected
    assert (
        bool(
            (await service.list_public_summaries(viewer_user_id="stranger", person_ref=person))[
                "packets"
            ]
        )
        is expected
    )
    if not expected:
        # An explicit later ON supersedes the migrated OFF; replay cannot reset it.
        await service.set_preference(
            user_id="owner", enabled=True, expected_revision=1, disclosure=SUMMARY_POLICY
        )
        with runtime.store.db.engine.begin() as c:
            apply_drive_fixture_migration(c, "428_financial_summary_owner_preference.sql")
        assert (await service.get_preference(user_id="owner"))["enabled"] is True
    await service.set_preference(
        user_id="owner",
        enabled=False,
        expected_revision=(await service.get_preference(user_id="owner"))["revision"],
        disclosure=SUMMARY_POLICY,
    )
    with runtime.store.db.engine.begin() as c:
        c.exec_driver_sql(
            (
                MIGRATIONS / "rollback/428_financial_summary_owner_preference.rollback.sql"
            ).read_text()
        )
        assert (
            c.exec_driver_sql(
                "SELECT financial_summary_enabled FROM drive_live_preferences WHERE user_id='owner'"
            ).scalar_one()
            is False
        )


async def test_old_api_hide_during_rollout_is_preserved_and_old_period_on_cannot_widen_it(
    reusable, monkeypatch
):
    runtime, head, person, service = await prepared(reusable, monkeypatch)
    with runtime.store.db.engine.begin() as c:
        c.execute(
            text("""UPDATE drive_packet_heads SET public_summary_enabled=FALSE,
            public_summary_revision=public_summary_revision+1 WHERE packet_id=:id"""),
            {"id": head["packet_id"]},
        )
    assert (await service.get_preference(user_id="owner"))["enabled"] is False
    assert (await service.list_public_summaries(viewer_user_id="stranger", person_ref=person))[
        "packets"
    ] == []
    with pytest.raises(DriveReadError, match="review_changed"):
        await publish(service, head, revision=1)
    with runtime.store.db.engine.begin() as c:
        c.execute(
            text("""UPDATE drive_packet_heads SET public_summary_enabled=TRUE,
            public_summary_revision=public_summary_revision+1,
            public_summary_version=current_version,public_summary_generation=connection_generation,
            public_summary_disclosure=:disclosure,public_summary_accepted_at=clock_timestamp()
            WHERE packet_id=:id"""),
            {"id": head["packet_id"], "disclosure": DISCLOSURE},
        )
    assert (await service.get_preference(user_id="owner"))["enabled"] is False
    await service.set_preference(
        user_id="owner", enabled=True, expected_revision=1, disclosure=SUMMARY_POLICY
    )
    assert (await service.list_public_summaries(viewer_user_id="stranger", person_ref=person))[
        "packets"
    ]


async def test_public_read_waits_for_an_inflight_owner_off_commit(reusable, monkeypatch):
    import asyncio
    import threading

    from hushh_mcp.services import drive_packet_public_summary as summaries
    from hushh_mcp.services.drive_packet_public_preferences import set_preference

    runtime, _, person, service = await prepared(reusable, monkeypatch)
    attempted = threading.Event()
    graph_lock = summaries.lock_connection_graph_users

    def observe_lock(connection, *, user_ids):
        attempted.set()
        return graph_lock(connection, user_ids=user_ids)

    monkeypatch.setattr(summaries, "lock_connection_graph_users", observe_lock)
    pending = None
    try:
        with runtime.store.db.engine.begin() as connection:
            set_preference(runtime.store, connection, "owner", False, 0)
            pending = asyncio.create_task(
                service.list_public_summaries(viewer_user_id="stranger", person_ref=person)
            )
            assert await asyncio.to_thread(attempted.wait, 3)
            assert not pending.done()
        assert (await asyncio.wait_for(pending, 5))["packets"] == []
    finally:
        # Releasing the transaction above unblocks the DB worker on failure too.
        if pending is not None and not pending.done():
            await asyncio.wait_for(pending, 5)


async def test_new_owner_off_fences_legacy_readers_and_old_republish_through_rollback(
    reusable, monkeypatch
):
    from tests.drive_postgres_test_support import MIGRATIONS, apply_drive_fixture_migration

    runtime, head, _, service = await prepared(reusable, monkeypatch, historical=True)
    await completed_preview(runtime, str(head["packet_id"]))

    def old_reader_count(connection):
        return connection.exec_driver_sql("""SELECT count(*) FROM drive_packet_heads h
          JOIN user_external_connector_connections c ON c.user_id=h.user_id
            AND c.connector_id='google_drive' AND c.connection_generation=h.connection_generation
            AND c.status='connected' AND c.validation_state='verified'
          WHERE h.user_id='owner' AND h.packet_kind='provider_discovery' AND h.category='financial'
            AND h.public_summary_enabled AND h.public_summary_version=h.current_version
            AND h.public_summary_generation=h.connection_generation
            AND h.public_summary_disclosure='drive-packet-public-summary-v1'
            AND h.public_summary_accepted_at IS NOT NULL""").scalar_one()

    receipt_sql = """SELECT packet_id,public_summary_revision,public_summary_version,
      public_summary_generation,public_summary_disclosure,public_summary_accepted_at,
      revision,current_version,build_envelope FROM drive_packet_heads ORDER BY packet_id"""
    sale_sql = "SELECT packet_id,version,digest,manifest_envelope FROM drive_packet_versions ORDER BY packet_id,version"
    with runtime.store.db.engine.begin() as c:
        c.exec_driver_sql("""UPDATE drive_packet_heads SET public_summary_enabled=TRUE,
          public_summary_revision=1,public_summary_version=current_version,
          public_summary_generation=connection_generation,
          public_summary_disclosure='drive-packet-public-summary-v1',
          public_summary_accepted_at=clock_timestamp()""")
        assert old_reader_count(c) > 1
        receipts = c.exec_driver_sql(receipt_sql).all()
        sales = c.exec_driver_sql(sale_sql).all()
    await service.set_preference(
        user_id="owner", enabled=False, expected_revision=0, disclosure=SUMMARY_POLICY
    )
    with runtime.store.db.engine.begin() as c:
        assert old_reader_count(c) == 0
        assert c.exec_driver_sql(receipt_sql).all() == receipts
        assert c.exec_driver_sql(sale_sql).all() == sales

        def old_republish():
            row = c.execute(
                text("""UPDATE drive_packet_heads SET public_summary_enabled=TRUE,
                public_summary_revision=public_summary_revision+1
                WHERE packet_id=:id RETURNING public_summary_enabled"""),
                {"id": head["packet_id"]},
            ).scalar_one()
            assert row is False
            assert old_reader_count(c) == 0
            assert (
                c.exec_driver_sql("""SELECT financial_summary_enabled,
              financial_summary_revision FROM drive_live_preferences WHERE user_id='owner'""").one()
                == (False, 1)
            )

        old_republish()
        apply_drive_fixture_migration(c, "428_financial_summary_owner_preference.sql")
        old_republish()
        c.exec_driver_sql(
            (
                MIGRATIONS / "rollback/428_financial_summary_owner_preference.rollback.sql"
            ).read_text()
        )
        old_republish()
        assert c.exec_driver_sql(sale_sql).all() == sales


async def test_existing_owner_preference_can_be_disabled_after_source_row_removal(
    reusable, monkeypatch
):
    runtime, head, _, service = await prepared(reusable, monkeypatch)
    await publish(service, head)
    with runtime.store.db.engine.begin() as c:
        c.exec_driver_sql("DELETE FROM user_external_connector_connections WHERE user_id='owner'")
    result = await service.set_preference(
        user_id="owner", enabled=False, expected_revision=1, disclosure=SUMMARY_POLICY
    )
    assert not result["enabled"] and result["revision"] == 2


async def test_visibility_on_uses_connection_before_preference_like_background_writer(
    reusable, monkeypatch
):
    import asyncio
    import threading

    runtime, head, _, service = await prepared(reusable, monkeypatch)
    await publish(service, head)
    attempted = threading.Event()
    active = runtime.store.live_active

    def observe_connection(connection, **kwargs):
        attempted.set()
        return active(connection, **kwargs)

    monkeypatch.setattr(runtime.store, "live_active", observe_connection)
    pending = None
    try:
        with runtime.store.db.engine.begin() as background:
            background.exec_driver_sql("""SELECT user_id FROM user_external_connector_connections
              WHERE user_id='owner' AND connector_id='google_drive' FOR UPDATE""")
            pending = asyncio.create_task(
                service.set_preference(
                    user_id="owner", enabled=True, expected_revision=1, disclosure=SUMMARY_POLICY
                )
            )
            assert await asyncio.to_thread(attempted.wait, 3)
            # The background writer must be able to finish its existing
            # connection -> preference transaction before ON claims the row.
            background.exec_driver_sql("SET LOCAL lock_timeout='500ms'")
            background.exec_driver_sql("""UPDATE drive_live_preferences SET
              background_enabled=FALSE,revision=revision+1 WHERE user_id='owner'""")
        result = await asyncio.wait_for(pending, 5)
        assert result["enabled"] and result["revision"] == 2
        with runtime.store.db.engine.connect() as c:
            assert (
                c.exec_driver_sql("""SELECT background_enabled FROM drive_live_preferences
              WHERE user_id='owner'""").scalar_one()
                is False
            )
    finally:
        if pending is not None and not pending.done():
            await asyncio.wait_for(pending, 5)


@pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")
def test_owner_policy_replay_skips_a_deleted_owner_instead_of_failing_the_deploy(replay_pg):
    """Replaying 428 during an in-flight deletion must not hit the 201 guard."""
    pg = replay_pg
    pg.execute("""
        CREATE EXTENSION IF NOT EXISTS pgcrypto;
        CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS vault_keys(user_id TEXT PRIMARY KEY);
        CREATE TABLE drive_live_preferences(user_id TEXT PRIMARY KEY,
          connection_generation BIGINT NOT NULL,background_enabled BOOLEAN NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
        CREATE TABLE drive_packet_heads(packet_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT NOT NULL,connection_generation BIGINT NOT NULL,packet_kind TEXT NOT NULL,
          category TEXT NOT NULL,public_summary_enabled BOOLEAN NOT NULL,
          public_summary_revision BIGINT NOT NULL);
        INSERT INTO drive_packet_heads(user_id,connection_generation,packet_kind,category,
          public_summary_enabled,public_summary_revision) VALUES
          ('owner-live',1,'provider_discovery','financial',FALSE,1),
          ('owner-deleted',1,'provider_discovery','financial',FALSE,1);
    """)
    pg.apply_file(MIGRATIONS_DIR / "201_account_deletion_tombstones.sql")
    pg.execute(
        "INSERT INTO account_deletion_tombstones(user_id_hash) "
        "VALUES('sha256:'||encode(digest('owner-deleted','sha256'),'hex'))"
    )
    entry = build_manifest_entries(MIGRATIONS_DIR, ["428_financial_summary_owner_preference.sql"])[
        0
    ]
    with pytest.raises(CheckViolation, match="account identity is deleted"):
        pg.execute(entry.sql)
    pg.execute("ROLLBACK")
    for _ in range(2):
        pg.execute(_replay_sql(entry))
    assert pg.execute(
        "SELECT user_id,financial_summary_enabled,financial_summary_revision "
        "FROM drive_live_preferences ORDER BY user_id"
    ) == [("owner-live", False, 1)]

"""Opt-in proof in a freshly created disposable database, never shared app rows.

FEED_IDENTITY_POSTGRES_TEST_URL names a local test server's admin database.
Only the unique codex_feed_identity_* database created here is removed.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import asyncpg
import pytest
from sqlalchemy import create_engine, text

from hushh_mcp.services.feed_service import FeedService
from scripts.backfill_feed_counterpart_identity import BATCH_SQL

ROOT = Path(__file__).resolve().parents[1]
ADMIN_URL = os.getenv("FEED_IDENTITY_POSTGRES_TEST_URL", "")


@pytest.mark.skipif(not ADMIN_URL, reason="Requires explicit disposable PostgreSQL server")
async def test_durable_feed_identity_lifecycle():
    database = "codex_feed_identity_" + uuid4().hex
    admin = await asyncpg.connect(ADMIN_URL)
    engine = None
    conn = None
    try:
        await admin.execute(f'CREATE DATABASE "{database}"')
        parts = urlsplit(ADMIN_URL)
        url = urlunsplit((parts.scheme, parts.netloc, "/" + database, parts.query, ""))
        conn = await asyncpg.connect(url)
        await conn.execute("""
          CREATE TABLE vault_keys (user_id TEXT PRIMARY KEY);
          CREATE TABLE actor_profiles (user_id TEXT PRIMARY KEY REFERENCES vault_keys ON DELETE CASCADE);
          CREATE TABLE actor_identity_cache (user_id TEXT PRIMARY KEY REFERENCES actor_profiles ON DELETE CASCADE,
            display_name TEXT, custom_photo_url TEXT, photo_url TEXT);
          CREATE TABLE feed_events (id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL,
            source_domain TEXT NOT NULL, event_type TEXT NOT NULL, actor_label TEXT,
            metadata JSONB DEFAULT '{}', source_row_id TEXT, read_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(user_id, source_domain, event_type, source_row_id));
          CREATE TABLE connection_requests (id UUID PRIMARY KEY, requester_user_id TEXT, addressee_user_id TEXT);
          CREATE TABLE connections (id UUID PRIMARY KEY, user_a_id TEXT, user_b_id TEXT);
          CREATE TABLE one_location_circle_member_invites (id UUID PRIMARY KEY, inviter_user_id TEXT, invitee_user_id TEXT);
          CREATE TABLE one_location_events (id BIGSERIAL PRIMARY KEY, owner_user_id TEXT, recipient_user_id TEXT,
            actor_user_id TEXT, event_type TEXT, grant_id UUID, request_id UUID, referral_id UUID,
            metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT '2026-09-08T12:00:00Z');
          CREATE INDEX idx_one_location_events_owner_created
            ON one_location_events(owner_user_id, created_at DESC);
          CREATE INDEX idx_one_location_events_retention_links
            ON one_location_events(grant_id, request_id, referral_id);
          INSERT INTO vault_keys VALUES ('owner'), ('peer'), ('referrer'), ('stranger');
          INSERT INTO actor_profiles SELECT user_id FROM vault_keys;
          INSERT INTO actor_identity_cache(user_id, display_name, photo_url)
            SELECT user_id, initcap(user_id), 'https://example.test/' || user_id || '.png' FROM actor_profiles;
        """)
        # Exercise the real account-erasure guard, not a no-op replacement.
        await conn.execute(
            (ROOT / "db/migrations/201_account_deletion_tombstones.sql").read_text(encoding="utf-8")
        )
        migration = (ROOT / "db/migrations/202_feed_counterpart_identity.sql").read_text(
            encoding="utf-8"
        )
        await conn.execute(migration)
        await conn.execute(migration)  # safe replay
        for filename in (
            "203_feed_counterpart_recipient_index.sql",
            "204_feed_counterpart_indexed_lookup.sql",
        ):
            sql = (ROOT / "db/migrations" / filename).read_text(encoding="utf-8")
            await conn.execute(sql)
            await conn.execute(sql)
        await conn.execute(
            (ROOT / "db/migrations/186_feed_share_kind_projection.sql").read_text(encoding="utf-8")
        )
        await conn.execute(
            (ROOT / "db/migrations/187_one_location_sms_contact_events.sql").read_text(
                encoding="utf-8"
            )
        )
        await conn.execute(
            (ROOT / "db/migrations/188_feed_location_viewed_projection.sql").read_text(
                encoding="utf-8"
            )
        )
        await conn.execute("""
          CREATE TRIGGER test_owner_fanout AFTER INSERT ON one_location_events
            FOR EACH ROW EXECUTE FUNCTION feed_events_from_one_location_events();
          CREATE TRIGGER test_recipient_fanout AFTER INSERT ON one_location_events
            FOR EACH ROW EXECUTE FUNCTION feed_events_recipient_from_one_location_events();
        """)
        grant = uuid4()
        await conn.execute(
            """INSERT INTO one_location_events(owner_user_id, recipient_user_id, actor_user_id,
          event_type, grant_id) VALUES ('owner', 'peer', 'owner', 'location_share_created', $1)""",
            grant,
        )
        # AFTER Feed trigger sees the just-inserted audit row, in both audiences.
        links = await conn.fetch(
            "SELECT f.user_id,c.counterpart_user_id FROM feed_events f JOIN feed_event_counterparts c ON c.feed_event_id=f.id"
        )
        assert {(r["user_id"], r["counterpart_user_id"]) for r in links} == {
            ("owner", "peer"),
            ("peer", "owner"),
        }
        owner_feed_id = await conn.fetchval("SELECT id FROM feed_events WHERE user_id='owner'")

        engine = create_engine(url.replace("postgresql://", "postgresql+psycopg2://"))

        class Db:
            def execute_raw(self, sql, params):
                with engine.begin() as tx:
                    return SimpleNamespace(
                        data=[dict(r) for r in tx.execute(text(sql), params).mappings()]
                    )

        service = FeedService()
        service._db = Db()

        def photo():
            return service._durable_counterpart_photos("owner", [{"id": owner_feed_id}])[
                str(owner_feed_id)
            ]

        assert photo() == "https://example.test/peer.png"
        assert service._durable_counterpart_photos("stranger", [{"id": owner_feed_id}]) == {}
        await conn.execute("DELETE FROM one_location_events")
        assert photo() == "https://example.test/peer.png"  # source retention no longer breaks Feed
        await conn.execute(
            "UPDATE actor_identity_cache SET custom_photo_url='https://example.test/custom.png' WHERE user_id='peer'"
        )
        assert photo() == "https://example.test/custom.png"
        await conn.execute(
            "UPDATE actor_identity_cache SET custom_photo_url='  ' WHERE user_id='peer'"
        )
        assert photo() == "https://example.test/peer.png"
        await conn.execute(
            "UPDATE actor_identity_cache SET photo_url=NULL, custom_photo_url=NULL WHERE user_id='peer'"
        )
        assert photo() is None

        # Both completed-request audiences and revoked relationships keep the
        # same counterpart. Bad presentation keys never abort a Feed insert.
        connection_id, request_id, invite_id = uuid4(), uuid4(), uuid4()
        await conn.execute("INSERT INTO connection_requests VALUES ($1,'owner','peer')", request_id)
        await conn.execute("INSERT INTO connections VALUES ($1,'owner','peer')", connection_id)
        await conn.execute(
            "INSERT INTO one_location_circle_member_invites VALUES ($1,'owner','peer')", invite_id
        )
        for event_type, source in [
            ("connection_accepted", str(request_id)),
            ("connection_rejected", str(request_id)),
            ("connection_revoked", f"{connection_id}:2026-09-08T12:00:00Z"),
        ]:
            for viewer, counterpart in [("owner", "peer"), ("peer", "owner"), ("stranger", None)]:
                assert (
                    await conn.fetchval(
                        "SELECT resolve_feed_counterpart_user_id($1,'connections',$2,$3)",
                        viewer,
                        event_type,
                        source,
                    )
                    == counterpart
                )
        assert (
            await conn.fetchval(
                "SELECT resolve_feed_counterpart_user_id('peer','location','circle_member_invited',$1)",
                str(invite_id),
            )
            == "owner"
        )
        assert (
            await conn.fetchval(
                "SELECT resolve_feed_counterpart_user_id('stranger','location','circle_member_invited',$1)",
                str(invite_id),
            )
            is None
        )
        for domain, event_type, source in [
            ("connections", "connection_accepted", "not-a-uuid"),
            ("connections", "connection_accepted", f"{request_id}:unexpected-suffix"),
            ("connections", "connection_revoked", "bad:source"),
            ("location", "circle_member_invited", "invalid"),
            ("location", "location_share_expired", "9999999999999999999999999999999"),
        ]:
            bad_id = await conn.fetchval(
                "INSERT INTO feed_events(user_id,source_domain,event_type,source_row_id) VALUES ('owner',$1,$2,$3) RETURNING id",
                domain,
                event_type,
                source,
            )
            assert (
                await conn.fetchval(
                    "SELECT COUNT(*) FROM feed_event_counterparts WHERE feed_event_id=$1",
                    bad_id,
                )
                == 0
            )

        # Source identity is never inferred from a display label or arbitrary viewer.
        cases = [
            (
                "location_share_duration_changed",
                "peer",
                "owner",
                {"client_operation_id": "edit"},
                f"{grant}:operation:edit",
            ),
            ("location_share_shortened", "peer", "owner", {}, None),
            (
                "location_access_request",
                "peer",
                "owner",
                {"request_revision": 2},
                f"{grant}:revision:2",
            ),
            ("location_access_approved", "peer", "owner", {}, str(grant)),
            ("location_access_denied", "peer", "owner", {}, str(grant)),
            ("location_access_request_withdrawn", "peer", "owner", {}, str(grant)),
            ("location_referral_invite", "referrer", "peer", {}, str(grant)),
            (
                "location_public_invite_submitted",
                "peer",
                "owner",
                {"submission_id": "submission"},
                "submission",
            ),
            ("location_one_network_joined", "peer", "owner", {"invite_id": "invite"}, "invite"),
            (
                "location_circle_code_joined",
                "peer",
                "owner",
                {"invite_id": "code"},
                "code:member:peer",
            ),
            (
                "location_circle_member_invite_accepted",
                "peer",
                "owner",
                {"invite_id": "targeted"},
                "targeted:member:peer",
            ),
            ("circle_member_added", "peer", "owner", {}, None),
            ("location_share_viewed", "peer", "owner", {}, f"{grant}:viewer:peer:2026-09-08"),
            ("location_sms_contact_added", "peer", "owner", {}, None),
            ("location_sms_contact_removed", "peer", "owner", {}, None),
        ]
        for event_type, actor, viewer, metadata, source in cases:
            event_id = await conn.fetchval(
                """INSERT INTO one_location_events(owner_user_id,recipient_user_id,actor_user_id,
              event_type,grant_id,request_id,referral_id,metadata) VALUES ('owner','peer',$1,$2,$3,$3,$3,$4::jsonb) RETURNING id""",
                actor,
                event_type,
                grant,
                json.dumps(metadata),
            )
            source = source or str(event_id)
            resolved = await conn.fetchval(
                "SELECT resolve_feed_counterpart_user_id($1,'location',$2,$3)",
                viewer,
                event_type,
                source,
            )
            assert resolved == (
                "referrer" if event_type == "location_referral_invite" else "peer"
            ), event_type
            assert (
                await conn.fetchval(
                    "SELECT resolve_feed_counterpart_user_id('stranger','location',$1,$2)",
                    event_type,
                    source,
                )
                is None
            )
            if event_type in {
                "location_share_duration_changed",
                "location_share_shortened",
                "location_access_request",
                "location_access_denied",
                "location_access_request_withdrawn",
                "location_one_network_joined",
                "location_sms_contact_added",
                "location_sms_contact_removed",
            }:
                recipient_source = (
                    f"{event_id}:recipient" if event_type.startswith("location_sms_") else source
                )
                assert (
                    await conn.fetchval(
                        "SELECT resolve_feed_counterpart_user_id('peer','location',$1,$2)",
                        event_type,
                        recipient_source,
                    )
                    == "owner"
                ), event_type
                if event_type.startswith("location_sms_"):
                    assert (
                        await conn.fetchval(
                            "SELECT c.counterpart_user_id FROM feed_event_counterparts c JOIN feed_events f ON f.id=c.feed_event_id WHERE f.user_id='peer' AND f.event_type=$1 AND f.source_row_id=$2",
                            event_type,
                            recipient_source,
                        )
                        == "owner"
                    )
        anonymous_id = await conn.fetchval(
            "INSERT INTO one_location_events(owner_user_id,event_type,metadata) VALUES ('owner','location_public_invite_submitted','{\"submission_id\":\"anonymous\"}') RETURNING id"
        )
        assert anonymous_id
        assert (
            await conn.fetchval(
                "SELECT resolve_feed_counterpart_user_id('owner','location','location_public_invite_submitted','anonymous')"
            )
            is None
        )
        # Backfill is idempotent and leaves event content/read state unchanged.
        await conn.execute(
            "DELETE FROM feed_event_counterparts WHERE feed_event_id<>$1", owner_feed_id
        )
        with engine.begin() as tx:
            first = dict(
                tx.execute(text(BATCH_SQL), {"after_id": 0, "batch_size": 1000}).mappings().one()
            )
        assert first["inserted"] > 0
        with engine.begin() as tx:
            assert (
                tx.execute(text(BATCH_SQL), {"after_id": 0, "batch_size": 1000})
                .mappings()
                .one()["inserted"]
                == 0
            )
        with pytest.raises(asyncpg.CheckViolationError):
            await conn.execute(
                "UPDATE feed_event_counterparts SET counterpart_user_id='stranger' WHERE feed_event_id=$1",
                owner_feed_id,
            )
        # Erasing the counterpart clears only their derived links, not another user's history.
        await conn.execute("DELETE FROM actor_profiles WHERE user_id='peer'")
        assert (
            await conn.fetchval(
                "SELECT COUNT(*) FROM feed_event_counterparts WHERE counterpart_user_id='peer'"
            )
            == 0
        )
        assert (
            await conn.fetchval("SELECT COUNT(*) FROM feed_events WHERE id=$1", owner_feed_id) == 1
        )
        assert photo() is None
        with pytest.raises(asyncpg.CheckViolationError):
            await conn.execute(
                "INSERT INTO feed_event_counterparts VALUES ($1,'peer')", owner_feed_id
            )
        await conn.execute(
            (ROOT / "db/migrations/rollback/202_feed_counterpart_identity.rollback.sql").read_text(
                encoding="utf-8"
            )
        )
        assert service._durable_counterpart_photos("owner", [{"id": owner_feed_id}]) is None
        assert (
            await conn.fetchval("SELECT COUNT(*) FROM feed_events WHERE id=$1", owner_feed_id) == 1
        )
        await conn.execute(migration)
    finally:
        if engine is not None:
            engine.dispose()
        if conn is not None:
            await conn.close()
        # Only this test's validated, generated database can be dropped.
        assert database.startswith("codex_feed_identity_") and len(database) == 52
        await admin.execute(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
        await admin.close()

"""Real PostgreSQL source-compatibility and buffer-cost regression proof.

Uses the same explicit disposable-server opt-in as the full Feed lifecycle test.
The lifecycle test installs complete migrations; this focused test installs the
unchanged 202 resolver body as its before/rollback baseline.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import asyncpg
import pytest

from db.migration_authority import MigrationMode, apply_manifest_entries, build_manifest_entries

MIGRATIONS = Path(__file__).resolve().parents[1] / "db/migrations"
ADMIN_URL = os.getenv("FEED_IDENTITY_POSTGRES_TEST_URL", "")
pytestmark = pytest.mark.skipif(not ADMIN_URL, reason="Requires disposable PostgreSQL server")
FILENAMES = (
    "203_feed_counterpart_recipient_index.sql",
    "204_feed_counterpart_indexed_lookup.sql",
)


@pytest.fixture
async def lookup_db():
    database = "codex_feed_identity_" + uuid4().hex
    admin = await asyncpg.connect(ADMIN_URL)
    conn = None
    try:
        await admin.execute(f'CREATE DATABASE "{database}"')
        parts = urlsplit(ADMIN_URL)
        url = urlunsplit((parts.scheme, parts.netloc, "/" + database, parts.query, ""))
        conn = await asyncpg.connect(url)
        await conn.execute("""
          CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY);
          INSERT INTO actor_profiles VALUES ('owner'), ('peer'), ('referrer'), ('stranger');
          CREATE TABLE connection_requests(id UUID PRIMARY KEY, requester_user_id TEXT, addressee_user_id TEXT);
          CREATE TABLE connections(id UUID PRIMARY KEY, user_a_id TEXT, user_b_id TEXT);
          CREATE TABLE one_location_circle_member_invites(id UUID PRIMARY KEY, inviter_user_id TEXT, invitee_user_id TEXT);
          CREATE TABLE one_location_events(id BIGSERIAL PRIMARY KEY, owner_user_id TEXT NOT NULL,
            recipient_user_id TEXT, actor_user_id TEXT, event_type TEXT, grant_id UUID,
            request_id UUID, referral_id UUID, metadata JSONB DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT '2026-09-08T12:00:00Z');
          CREATE INDEX idx_one_location_events_owner_created
            ON one_location_events(owner_user_id, created_at DESC);
          CREATE INDEX idx_one_location_events_retention_links
            ON one_location_events(grant_id, request_id, referral_id);
        """)
        original = (MIGRATIONS / "202_feed_counterpart_identity.sql").read_text(encoding="utf-8")
        resolver = original.split(
            "CREATE OR REPLACE FUNCTION public.resolve_feed_counterpart_user_id(", 1
        )[1]
        resolver = resolver.split(
            "CREATE OR REPLACE FUNCTION public.populate_feed_counterpart_identity()", 1
        )[0]
        await conn.execute(
            "CREATE OR REPLACE FUNCTION public.resolve_feed_counterpart_user_id(" + resolver
        )
        yield conn
    finally:
        if conn is not None:
            await conn.close()
        assert database.startswith("codex_feed_identity_") and len(database) == 52
        await admin.execute(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
        await admin.close()


async def resolve(conn, user, event_type, source):
    return await conn.fetchval(
        "SELECT resolve_feed_counterpart_user_id($1, 'location', $2, $3)",
        user,
        event_type,
        source,
    )


async def add_event(conn, event_type, *, actor="peer", grant=None, metadata=None):
    return await conn.fetchval(
        """INSERT INTO one_location_events(owner_user_id,recipient_user_id,actor_user_id,
          event_type,grant_id,request_id,referral_id,metadata)
          VALUES ('owner','peer',$1,$2,$3,$3,$3,$4::jsonb) RETURNING id""",
        actor,
        event_type,
        grant,
        json.dumps(metadata or {}),
    )


async def apply_fix(conn):
    entries = build_manifest_entries(MIGRATIONS, FILENAMES)
    await apply_manifest_entries(conn, entries, mode=MigrationMode.REPLAY)


async def test_legacy_sources_match_202_and_survive_rollback(lookup_db):
    conn = lookup_db
    grant = uuid4()
    cases = []
    for kind in ("created", "revoked", "expired"):
        event_type = "location_share_" + kind
        event_id = await add_event(conn, event_type, grant=grant)
        for source in (str(grant), str(event_id)):
            cases.extend(
                [("owner", event_type, source, "peer"), ("peer", event_type, source, "owner")]
            )
        cases.append(("stranger", event_type, str(grant), None))
        cases.append(("owner", event_type, f"{grant}:bad", None))
    for kind in ("shortened", "duration_changed"):
        event_type = "location_share_" + kind
        for grant_id in (grant, None):
            event_id = await add_event(
                conn,
                event_type,
                grant=grant_id,
                metadata={"client_operation_id": " edit:operation:1 "},
            )
            source = f"{grant_id or 'unknown-grant'}:operation:edit:operation:1"
            cases.extend(
                [("owner", event_type, source, "peer"), ("peer", event_type, source, "owner")]
            )
            cases.append(("owner", event_type, str(event_id), "peer"))
            cases.append(("owner", event_type, source + ":bad", None))
    for event_type, metadata, source, audience, expected in (
        (
            "location_access_request",
            {"request_revision": " 2 "},
            f"{grant}:revision:2",
            "peer",
            "owner",
        ),
        ("location_access_approved", {}, str(grant), "owner", "peer"),
        ("location_access_denied", {}, str(grant), "peer", "owner"),
        ("location_access_request_withdrawn", {}, str(grant), "peer", "owner"),
        ("location_referral_invite", {}, str(grant), "peer", "peer"),
        ("location_one_network_joined", {"invite_id": str(grant)}, str(grant), "peer", "owner"),
        ("location_one_network_joined", {"invite_id": 81234}, "81234", "peer", "owner"),
        (
            "location_one_network_joined",
            {"connection_id": "legacy:connection"},
            "legacy:connection",
            "peer",
            "owner",
        ),
        (
            "location_circle_code_joined",
            {"invite_id": "code:member:with:colon"},
            "code:member:with:colon:member:peer",
            "owner",
            "peer",
        ),
        (
            "location_circle_member_invite_accepted",
            {"invite_id": " 123 "},
            "123:member:peer",
            "owner",
            "peer",
        ),
        ("location_share_viewed", {}, f"{grant}:viewer:peer:2026-09-08", "owner", "peer"),
    ):
        event_id = await add_event(conn, event_type, grant=grant, metadata=metadata)
        cases.extend(
            [(audience, event_type, source, expected), ("stranger", event_type, source, None)]
        )
        cases.append((audience, event_type, str(event_id), expected))
        cases.append((audience, event_type, source + ":bad", None))
    event_type = "location_public_invite_submitted"
    older_id = await add_event(conn, event_type, actor="referrer")
    await add_event(conn, event_type, metadata={"submission_id": str(older_id)})
    # A numeric metadata key can also be an older row's raw ID: newest wins.
    cases.append(("owner", event_type, str(older_id), "peer"))
    await add_event(conn, event_type, metadata={"submission_id": "missing-profile"})
    await add_event(
        conn, event_type, actor="no-profile", metadata={"submission_id": "missing-profile"}
    )
    cases.append(("owner", event_type, "missing-profile", None))
    cases.extend(
        [
            ("owner", "location_share_expired", "9" * 40, None),
            ("owner", "unsupported", str(grant), None),
            ("owner", "location_access_request", f"{grant}:revision:wrong", None),
            ("peer", "location_access_approved", str(grant), None),
        ]
    )
    for user, event_type, source, expected in cases:
        assert await resolve(conn, user, event_type, source) == expected, (event_type, source)
    await apply_fix(conn)
    await apply_fix(conn)  # replay is safe, including the concurrent index
    for user, event_type, source, expected in cases:
        assert await resolve(conn, user, event_type, source) == expected, (event_type, source)
    await conn.execute(
        (MIGRATIONS / "rollback/204_feed_counterpart_indexed_lookup.rollback.sql").read_text(
            encoding="utf-8"
        )
    )
    await conn.execute(
        (MIGRATIONS / "rollback/203_feed_counterpart_recipient_index.rollback.sql").read_text(
            encoding="utf-8"
        )
    )
    for user, event_type, source, expected in cases:
        assert await resolve(conn, user, event_type, source) == expected, (event_type, source)
    await apply_fix(conn)


async def test_invalid_concurrent_index_blocks_release_and_can_be_rebuilt(lookup_db):
    conn = lookup_db
    await add_event(conn, "location_share_created")
    await add_event(conn, "location_share_created")
    # PostgreSQL leaves an invalid index after this real failed concurrent build.
    with pytest.raises(asyncpg.UniqueViolationError):
        await conn.execute("""CREATE UNIQUE INDEX CONCURRENTLY idx_one_location_events_recipient_type
          ON one_location_events(recipient_user_id, event_type)""")
    with pytest.raises(asyncpg.RaiseError, match="missing or invalid"):
        await apply_fix(conn)
    await conn.execute(
        (MIGRATIONS / "rollback/203_feed_counterpart_recipient_index.rollback.sql").read_text(
            encoding="utf-8"
        )
    )
    await apply_fix(conn)
    assert await conn.fetchval("""SELECT indisvalid FROM pg_index
      WHERE indexrelid='idx_one_location_events_recipient_type'::regclass""")


async def test_lookup_buffers_do_not_grow_with_other_users_audit(lookup_db):
    conn = lookup_db
    grant = uuid4()
    await conn.execute("""
      INSERT INTO one_location_events(owner_user_id,recipient_user_id,actor_user_id,event_type,grant_id)
      SELECT 'other-owner-' || (n % 1000), 'other-peer-' || (n % 1000), 'other-owner-' || (n % 1000),
        'location_share_created', md5(n::text)::uuid FROM generate_series(1,250000) n
    """)
    numeric_id = await add_event(conn, "location_share_created", grant=grant)
    await add_event(conn, "location_one_network_joined", metadata={"invite_id": "legacy:invite"})
    await add_event(conn, "location_access_request", grant=grant, metadata={"request_revision": 2})
    await conn.execute("ANALYZE one_location_events; ANALYZE actor_profiles")

    async def measure(user, event_type, source):
        # Warm function compilation and caches; buffer count, not wall time, is
        # the regression invariant. EXPLAIN includes work inside the real function.
        await resolve(conn, user, event_type, source)
        result = await conn.fetchval(
            """EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT resolve_feed_counterpart_user_id($1,'location',$2,$3)
          FROM generate_series(1,20)""",
            user,
            event_type,
            source,
        )
        plan = json.loads(result)[0]
        blocks = sum(
            plan["Plan"].get(key, 0) for key in ("Shared Hit Blocks", "Shared Read Blocks")
        )
        return blocks, plan["Execution Time"]

    before = {}
    for mode in ("force_custom_plan", "force_generic_plan"):
        await conn.execute(f"SET plan_cache_mode={mode}")
        before[mode] = await measure("peer", "location_share_created", str(grant))
    await apply_fix(conn)
    for mode in before:
        await conn.execute(f"SET plan_cache_mode={mode}")
        for user, event_type, source in (
            ("owner", "location_share_created", str(grant)),
            ("peer", "location_share_created", str(grant)),
            ("owner", "location_share_created", str(numeric_id)),
            ("peer", "location_one_network_joined", "legacy:invite"),
            ("peer", "location_access_request", f"{grant}:revision:2"),
            ("stranger", "location_share_created", str(grant)),
        ):
            after = await measure(user, event_type, source)
            print(f"{mode} {user} {event_type}: before_share={before[mode]}, after={after}")
            assert after[0] < 1000, (mode, event_type, after)
            assert after[0] * 20 < before[mode][0], (before[mode], after)

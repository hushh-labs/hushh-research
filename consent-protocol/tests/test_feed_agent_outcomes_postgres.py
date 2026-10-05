"""Real source transitions exercise Feed audience, replay, privacy and rollback."""

import json
import os
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from hushh_mcp.services.feed_service import FeedService

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db/migrations/269_feed_agent_outcomes.sql"
ROLLBACK = ROOT / "db/migrations/rollback/269_feed_agent_outcomes.rollback.sql"


@pytest.fixture
def projection_db():
    source = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not source:
        pytest.skip("Isolated PostgreSQL server required")
    url = make_url(source).set(drivername="postgresql+psycopg2")
    assert url.host in {"127.0.0.1", "localhost"}
    assert url.username == url.database == "command_test"
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    name = "feed_outcomes_test_" + uuid.uuid4().hex
    with admin.connect() as connection:
        connection.execute(text(f'CREATE DATABASE "{name}"'))
    engine = create_engine(url.set(database=name))
    try:
        with engine.begin() as connection:
            connection.execute(
                text("""
                CREATE TABLE feed_events(id BIGSERIAL PRIMARY KEY,user_id TEXT,
                  source_domain TEXT,event_type TEXT,source_row_id TEXT,metadata JSONB,
                  actor_label TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
                CREATE TABLE actor_identity_cache(user_id TEXT PRIMARY KEY,display_name TEXT);
                CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY);
                CREATE TABLE feed_event_counterparts(feed_event_id BIGINT PRIMARY KEY
                  REFERENCES feed_events(id) ON DELETE CASCADE, counterpart_user_id TEXT
                  REFERENCES actor_profiles(user_id) ON DELETE CASCADE);
                CREATE TABLE connection_requests(id UUID PRIMARY KEY,requester_user_id TEXT,addressee_user_id TEXT);
                CREATE TABLE connections(id UUID PRIMARY KEY,user_a_id TEXT,user_b_id TEXT);
                CREATE TABLE one_location_events(id BIGSERIAL PRIMARY KEY,owner_user_id TEXT,
                  recipient_user_id TEXT,actor_user_id TEXT,event_type TEXT,grant_id UUID,
                  request_id UUID,referral_id UUID,metadata JSONB,created_at TIMESTAMPTZ);
                CREATE UNIQUE INDEX uq_feed_events_source_projection ON feed_events
                  (user_id,source_domain,event_type,source_row_id) WHERE source_row_id IS NOT NULL;
                CREATE TABLE google_calendar_action_proposals(proposal_id TEXT PRIMARY KEY,user_id TEXT,status TEXT);
                CREATE TABLE gmail_mailbox_action_proposals(proposal_id TEXT PRIMARY KEY,user_id TEXT,status TEXT,
                  action TEXT,message_ids JSONB,label_id TEXT);
                CREATE TABLE connected_system_audit_events(event_id TEXT PRIMARY KEY,user_id TEXT,status TEXT,
                  action TEXT,intent_id TEXT,metadata_json JSONB);
                CREATE TABLE external_mcp_connectors(connector_id TEXT PRIMARY KEY,user_id TEXT,display_name TEXT);
                CREATE TABLE user_external_connector_connections(user_id TEXT,connector_id TEXT,status TEXT,
                  connection_generation BIGINT,credential_ciphertext TEXT,connected_account_label TEXT,
                  PRIMARY KEY(user_id,connector_id));
                CREATE TABLE drive_share_requests(request_id UUID PRIMARY KEY,user_id TEXT);
                CREATE TABLE drive_owner_search_jobs(job_id UUID PRIMARY KEY,user_id TEXT,client_request_id UUID,
                  status TEXT,checkpoint_envelope JSONB);
                CREATE TABLE one_action_directive_ledger(directive_id TEXT PRIMARY KEY,user_id TEXT,state TEXT,
                  action_id TEXT,context_revision TEXT,settlement_reason_code TEXT,settlement_status TEXT,slots_hmac TEXT);
                CREATE TABLE drive_bulk_shares(share_id UUID PRIMARY KEY,user_id TEXT,origin_request_id UUID,
                  status TEXT,revision BIGINT,stopped_at TIMESTAMPTZ);
                CREATE TABLE drive_bulk_share_notifications(share_id UUID,user_id TEXT,recipient_user_id TEXT);
                CREATE TABLE drive_bulk_share_effects(share_id UUID,state TEXT);
                CREATE TABLE drive_live_query_requests(request_id UUID PRIMARY KEY,user_id TEXT,
                  requester_user_id TEXT,status TEXT,revision BIGINT,last_error_code TEXT,question_envelope JSONB);
                CREATE TABLE consent_audit(id BIGSERIAL PRIMARY KEY,user_id TEXT,request_id TEXT,action TEXT,metadata JSONB);
                CREATE TABLE one_location_circles(id UUID PRIMARY KEY,owner_user_id TEXT,name TEXT,status TEXT);
                CREATE TABLE one_location_circle_memberships(circle_id UUID,user_id TEXT,role TEXT,status TEXT,
                  joined_at TIMESTAMPTZ DEFAULT NOW());
                CREATE TABLE one_location_circle_member_invites(id UUID PRIMARY KEY,circle_id UUID,
                  inviter_user_id TEXT,invitee_user_id TEXT,status TEXT);
            """)
            )
            # Unchanged production resolver and identity trigger bodies, rather
            # than a fake resolver, protect the retained/current-avatar seam.
            marker = "CREATE OR REPLACE FUNCTION public.resolve_feed_counterpart_user_id("
            resolver = (ROOT / "db/migrations/204_feed_counterpart_indexed_lookup.sql").read_text(
                encoding="utf-8"
            )
            connection.exec_driver_sql(marker + resolver.split(marker, 1)[1].split("COMMIT;", 1)[0])
            marker = "CREATE OR REPLACE FUNCTION public.populate_feed_counterpart_identity()"
            identity = (ROOT / "db/migrations/202_feed_counterpart_identity.sql").read_text(
                encoding="utf-8"
            )
            connection.exec_driver_sql(
                marker + identity.split(marker, 1)[1].split("-- Backfill", 1)[0]
            )
        apply(engine, MIGRATION)
        apply(engine, MIGRATION)
        yield engine
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
        admin.dispose()


def apply(engine, path):
    raw = engine.raw_connection()
    try:
        raw.autocommit = True
        with raw.cursor() as cursor:
            cursor.execute(path.read_text(encoding="utf-8"))
    finally:
        raw.close()


def outcomes(connection):
    rows = (
        connection.execute(
            text("SELECT user_id,event_type,metadata,actor_label FROM feed_events ORDER BY id")
        )
        .mappings()
        .all()
    )
    assert "private" not in json.dumps([dict(r) for r in rows])
    return [(r["user_id"], r["event_type"]) for r in rows]


def test_calendar_mail_and_crm_terminal_receipts_only(projection_db):
    with projection_db.begin() as c:
        c.execute(
            text("INSERT INTO google_calendar_action_proposals VALUES('cal','owner','executing')")
        )
        c.execute(text("UPDATE google_calendar_action_proposals SET status='failed'"))
        c.execute(text("UPDATE google_calendar_action_proposals SET status='failed'"))
        for action in ("archive", "trash", "add_label", "remove_label", "mark_read", "mark_unread"):
            c.execute(
                text(
                    "INSERT INTO gmail_mailbox_action_proposals VALUES(:id,'owner','pending',:action,'[\"private-id\"]','private-label')"
                ),
                {"id": action, "action": action},
            )
            c.execute(
                text(
                    "UPDATE gmail_mailbox_action_proposals SET status='executing' WHERE proposal_id=:id"
                ),
                {"id": action},
            )
            assert ("owner", "mail_mailbox_" + action) not in outcomes(c)
            c.execute(
                text(
                    "UPDATE gmail_mailbox_action_proposals SET status='executed' WHERE proposal_id=:id"
                ),
                {"id": action},
            )
            c.execute(
                text("DELETE FROM gmail_mailbox_action_proposals WHERE proposal_id=:id"),
                {"id": action},
            )
        c.execute(
            text(
                "INSERT INTO gmail_mailbox_action_proposals VALUES('bad','owner','executing','trash','[\"private-id\"]',NULL)"
            )
        )
        c.execute(text("UPDATE gmail_mailbox_action_proposals SET status='failed'"))
        for n, action, status in [
            (1, "read", "succeeded"),
            (2, "create", "succeeded"),
            (3, "create", "succeeded"),
            (4, "update", "partial"),
            (5, "disconnect", "succeeded"),
        ]:
            c.execute(
                text(
                    "INSERT INTO connected_system_audit_events VALUES(:id,'owner',:status,:action,:intent,'{\"error\":\"private\"}')"
                ),
                {
                    "id": str(n),
                    "status": status,
                    "action": action,
                    "intent": "create" if n in (2, 3) else str(n),
                },
            )
        result = outcomes(c)
        assert result == [("owner", "calendar_action_failed")] + [
            ("owner", "mail_mailbox_" + a)
            for a in ("archive", "trash", "add_label", "remove_label", "mark_read", "mark_unread")
        ] + [
            ("owner", "mail_mailbox_failed"),
            ("owner", "connected_systems_mutation_succeeded"),
            ("owner", "connected_systems_mutation_partial"),
            ("owner", "connected_systems_disconnected"),
        ]


def test_connector_generation_not_refresh_or_placeholder(projection_db):
    with projection_db.begin() as c:
        c.execute(
            text(
                "INSERT INTO external_mcp_connectors VALUES('app',NULL,'Sample app'),('other','other-owner','private-name')"
            )
        )
        c.execute(
            text(
                "INSERT INTO user_external_connector_connections VALUES('owner','app','revoked',0,'private','private-account')"
            )
        )
        c.execute(
            text(
                "UPDATE user_external_connector_connections SET status='connected',connection_generation=1"
            )
        )
        c.execute(
            text(
                "UPDATE user_external_connector_connections SET credential_ciphertext='private-refresh'"
            )
        )
        c.execute(text("UPDATE user_external_connector_connections SET status='needs_reauth'"))
        c.execute(text("UPDATE user_external_connector_connections SET status='needs_reauth'"))
        c.execute(
            text(
                "UPDATE user_external_connector_connections SET status='connected',connection_generation=2"
            )
        )
        c.execute(text("UPDATE user_external_connector_connections SET connection_generation=3"))
        c.execute(
            text(
                "UPDATE user_external_connector_connections SET status='revoked',connection_generation=4"
            )
        )
        c.execute(text("UPDATE user_external_connector_connections SET status='revoked'"))
        c.execute(
            text(
                "INSERT INTO user_external_connector_connections VALUES('owner','other','connected',1,'private','private-account')"
            )
        )
        assert outcomes(c) == [
            ("owner", t)
            for t in (
                "connector_connected",
                "connector_reconnect_required",
                "connector_connected",
                "connector_connected",
                "connector_disconnected",
                "connector_connected",
            )
        ]
        assert (
            c.execute(
                text("SELECT actor_label FROM feed_events WHERE source_row_id LIKE 'other:%'")
            ).scalar_one()
            is None
        )


@pytest.mark.parametrize("action", ["share_file", "trash_file"])
@pytest.mark.parametrize(
    "status,reason,suffix",
    [
        ("succeeded", "ok", "succeeded"),
        ("failed", "error", "failed"),
        ("failed", "outcome_unknown", "unconfirmed"),
    ],
)
def test_drive_receipt_requires_real_settlement(projection_db, action, status, reason, suffix):
    with projection_db.begin() as c:
        c.execute(
            text(
                "INSERT INTO one_action_directive_ledger VALUES('receipt','owner','consumed',:action,'drive-review:v1',NULL,NULL,'private-hmac')"
            ),
            {"action": "connector.drive." + action},
        )
        assert outcomes(c) == []
        c.execute(
            text(
                "UPDATE one_action_directive_ledger SET state='settled',settlement_status=:status,settlement_reason_code=:reason"
            ),
            {"status": status, "reason": reason},
        )
        c.execute(text("UPDATE one_action_directive_ledger SET state='settled'"))
        assert outcomes(c) == [
            ("owner", f"drive_{'share' if action == 'share_file' else 'trash'}_{suffix}")
        ]


def test_bulk_stop_waits_for_effects_and_dedupes_parent_revision(projection_db):
    share, request_share = str(uuid.uuid4()), str(uuid.uuid4())
    with projection_db.begin() as c:
        c.execute(
            text("INSERT INTO drive_bulk_shares VALUES(:share,'owner',NULL,'running',1,NULL)"),
            {"share": share},
        )
        c.execute(
            text("INSERT INTO drive_bulk_share_effects VALUES(:share,'dispatching')"),
            {"share": share},
        )
        c.execute(text("UPDATE drive_bulk_shares SET status='stopped',revision=2,stopped_at=NOW()"))
        assert outcomes(c) == []
        c.execute(text("UPDATE drive_bulk_share_effects SET state='succeeded'"))
        c.execute(text("UPDATE drive_bulk_shares SET revision=3"))
        c.execute(
            text("INSERT INTO drive_bulk_share_notifications VALUES(:share,'owner','recipient')"),
            {"share": share},
        )
        c.execute(
            text(
                "INSERT INTO drive_bulk_shares VALUES(:share,'owner',:request,'completed',1,NULL)"
            ),
            {"share": request_share, "request": str(uuid.uuid4())},
        )
        c.execute(
            text("UPDATE drive_bulk_shares SET revision=2 WHERE share_id=:share"),
            {"share": request_share},
        )
        c.execute(
            text("INSERT INTO drive_bulk_share_notifications VALUES(:share,'owner','recipient')"),
            {"share": request_share},
        )
        assert outcomes(c) == [
            ("owner", "drive_bulk_stopped"),
            ("recipient", "drive_bulk_received"),
        ]


@pytest.mark.parametrize("status", ["completed", "limited", "failed", "stopped"])
@pytest.mark.parametrize("request_bound", [False, True])
def test_search_terminal_request_deduplication(projection_db, status, request_bound):
    request, job = str(uuid.uuid4()), str(uuid.uuid4())
    with projection_db.begin() as c:
        if request_bound:
            c.execute(
                text("INSERT INTO drive_share_requests VALUES(:request,'owner')"),
                {"request": request},
            )
        c.execute(
            text(
                "INSERT INTO drive_owner_search_jobs VALUES(:job,'owner',:request,'running','{\"query\":\"private\"}')"
            ),
            {"job": job, "request": request},
        )
        c.execute(text("UPDATE drive_owner_search_jobs SET status=:status"), {"status": status})
        c.execute(text("UPDATE drive_owner_search_jobs SET status=:status"), {"status": status})
        assert outcomes(c) == (
            [] if request_bound and status == "completed" else [("owner", "drive_search_" + status)]
        )


def test_questions_and_mixed_consent_bundle_terminal_audiences(projection_db):
    with projection_db.begin() as c:
        c.execute(
            text(
                "INSERT INTO drive_live_query_requests VALUES(:id,'owner','asker','running',1,NULL,'{\"question\":\"private\"}')"
            ),
            {"id": str(uuid.uuid4())},
        )
        c.execute(
            text(
                "UPDATE drive_live_query_requests SET status='pending',revision=2,last_error_code='needs_reauth'"
            )
        )
        c.execute(
            text(
                "UPDATE drive_live_query_requests SET status='cancelled',revision=3,last_error_code=NULL"
            )
        )
        for action in ("CONSENT_GRANTED", "CONSENT_DENIED", "TIMEOUT", "TIMEOUT", "CANCELLED"):
            c.execute(
                text(
                    'INSERT INTO consent_audit(user_id,request_id,action,metadata) VALUES(\'owner\',:request,:action,\'{"bundle_id":"bundle","scope":"private"}\')'
                ),
                {"request": str(uuid.uuid4()), "action": action},
            )
        assert outcomes(c) == [
            ("owner", "drive_question_retry_required"),
            ("owner", "drive_question_withdrawn"),
            ("owner", "consent_denied"),
            ("owner", "consent_timed_out"),
            ("owner", "consent_cancelled"),
        ]


def test_circle_outcomes_audience_generation_and_delete_cleanup(projection_db):
    circle, invite = str(uuid.uuid4()), str(uuid.uuid4())
    with projection_db.begin() as c:
        c.execute(
            text("INSERT INTO actor_identity_cache VALUES('invitee','Aarav'),('member','member')")
        )
        c.execute(
            text("INSERT INTO one_location_circles VALUES(:id,'owner','Family','active')"),
            {"id": circle},
        )
        c.execute(
            text(
                "INSERT INTO one_location_circle_memberships(circle_id,user_id,role,status) VALUES(:id,'owner','owner','active'),(:id,'member','member','active')"
            ),
            {"id": circle},
        )
        c.execute(
            text(
                "INSERT INTO one_location_circle_member_invites VALUES(:id,:circle,'owner','invitee','pending')"
            ),
            {"id": invite, "circle": circle},
        )
        c.execute(text("UPDATE one_location_circle_member_invites SET status='declined'"))
        c.execute(text("UPDATE one_location_circle_member_invites SET status='pending'"))
        c.execute(text("UPDATE one_location_circle_member_invites SET status='cancelled'"))
        c.execute(
            text("UPDATE one_location_circle_memberships SET status='left' WHERE user_id='member'")
        )
        c.execute(
            text(
                "UPDATE one_location_circle_memberships SET status='active',joined_at=NOW()+INTERVAL '1 second' WHERE user_id='member'"
            )
        )
        c.execute(
            text(
                "UPDATE one_location_circle_memberships SET status='removed' WHERE user_id='member'"
            )
        )
        c.execute(
            text(
                "UPDATE one_location_circle_memberships SET status='active',joined_at=NOW()+INTERVAL '2 seconds' WHERE user_id='member'"
            )
        )
        c.execute(
            text(
                "UPDATE one_location_circle_memberships SET status='removed' WHERE user_id='member'"
            )
        )
        c.execute(
            text(
                "UPDATE one_location_circle_memberships SET status='active' WHERE user_id='member'"
            )
        )
        c.execute(text("UPDATE one_location_circle_member_invites SET status='pending'"))
        c.execute(text("UPDATE one_location_circles SET status='deleted'"))
        c.execute(text("UPDATE one_location_circle_memberships SET status='removed'"))
        c.execute(text("UPDATE one_location_circle_member_invites SET status='cancelled'"))
        result = outcomes(c)
        assert result[:5] == [
            ("owner", "circle_invite_declined"),
            ("invitee", "circle_invite_cancelled"),
            ("owner", "circle_member_left"),
            ("member", "circle_membership_ended"),
            ("member", "circle_membership_ended"),
        ]
        assert set(result[5:]) == {("owner", "circle_deleted"), ("member", "circle_deleted")}
        metadata = (
            c.execute(
                text(
                    "SELECT event_type,metadata FROM feed_events WHERE event_type IN ('circle_invite_declined','circle_member_left')"
                )
            )
            .mappings()
            .all()
        )
        assert metadata[0]["metadata"]["counterpart_label"] == "Aarav"
        assert "counterpart_label" not in metadata[1]["metadata"]


@pytest.mark.parametrize(
    "unsafe_label",
    [
        "invitee",
        "person@example.com",
        "ria:person",
        "12345678-1234-4234-8234-123456789abc",
        "firebaseidentitywithoutspaces",
    ],
)
def test_circle_identity_seed_never_becomes_a_person_label(projection_db, unsafe_label):
    circle, invite = str(uuid.uuid4()), str(uuid.uuid4())
    with projection_db.begin() as c:
        c.execute(
            text("INSERT INTO actor_identity_cache VALUES('invitee',:label)"),
            {"label": unsafe_label},
        )
        c.execute(
            text("INSERT INTO one_location_circles VALUES(:id,'owner','Family','active')"),
            {"id": circle},
        )
        c.execute(
            text(
                "INSERT INTO one_location_circle_member_invites VALUES(:id,:circle,'owner','invitee','pending')"
            ),
            {"id": invite, "circle": circle},
        )
        c.execute(text("UPDATE one_location_circle_member_invites SET status='declined'"))
        assert c.execute(text("SELECT metadata FROM feed_events")).scalar_one() == {
            "circle_id": circle,
            "circle_name": "Family",
        }


def test_projection_failure_isolated_and_rollback_reapply(projection_db):
    with projection_db.begin() as c:
        c.execute(
            text(
                "ALTER TABLE feed_events ADD CONSTRAINT reject_calendar CHECK(event_type <> 'calendar_action_failed')"
            )
        )
        c.execute(
            text("INSERT INTO google_calendar_action_proposals VALUES('cal','owner','executing')")
        )
        c.execute(text("UPDATE google_calendar_action_proposals SET status='failed'"))
        assert (
            c.execute(text("SELECT status FROM google_calendar_action_proposals")).scalar_one()
            == "failed"
        )
        assert outcomes(c) == []
        c.execute(text("ALTER TABLE feed_events DROP CONSTRAINT reject_calendar"))
    apply(projection_db, ROLLBACK)
    apply(projection_db, ROLLBACK)
    with projection_db.begin() as c:
        c.execute(text("UPDATE google_calendar_action_proposals SET status='executing'"))
        c.execute(text("UPDATE google_calendar_action_proposals SET status='failed'"))
        assert outcomes(c) == []
    apply(projection_db, MIGRATION)
    with projection_db.begin() as c:
        c.execute(text("UPDATE google_calendar_action_proposals SET status='executing'"))
        c.execute(text("UPDATE google_calendar_action_proposals SET status='failed'"))
        assert outcomes(c) == [("owner", "calendar_action_failed")]


def test_identity_lookup_outage_does_not_undo_circle_transition(projection_db):
    circle, invite = str(uuid.uuid4()), str(uuid.uuid4())
    with projection_db.begin() as c:
        c.execute(
            text("INSERT INTO one_location_circles VALUES(:id,'owner','Family','active')"),
            {"id": circle},
        )
        c.execute(
            text(
                "INSERT INTO one_location_circle_member_invites VALUES(:id,:circle,'owner','invitee','pending')"
            ),
            {"id": invite, "circle": circle},
        )
        c.execute(text("DROP TABLE actor_identity_cache"))
        c.execute(text("UPDATE one_location_circle_member_invites SET status='declined'"))
        assert (
            c.execute(text("SELECT status FROM one_location_circle_member_invites")).scalar_one()
            == "declined"
        )
        assert outcomes(c) == []


def test_withdrawal_counterpart_current_photo_scope_and_rollback(projection_db):
    request = str(uuid.uuid4())
    with projection_db.begin() as c:
        c.execute(text("INSERT INTO actor_profiles VALUES('owner'),('peer'),('stranger')"))
        c.execute(
            text(
                "ALTER TABLE actor_identity_cache ADD COLUMN photo_url TEXT, ADD COLUMN custom_photo_url TEXT"
            )
        )
        c.execute(
            text(
                "INSERT INTO actor_identity_cache VALUES('owner','Owner','https://example.test/owner.png',NULL),('peer','Aarav','https://example.test/peer.png',NULL)"
            )
        )
        c.execute(
            text("INSERT INTO connection_requests VALUES(:id,'owner','peer')"), {"id": request}
        )
        for user in ("owner", "peer"):
            c.execute(
                text(
                    "INSERT INTO feed_events(user_id,source_domain,event_type,source_row_id,metadata) VALUES(:user,'connections','connection_withdrawn',:request,'{}')"
                ),
                {"user": user, "request": request},
            )
        rows = {r.user_id: dict(r._mapping) for r in c.execute(text("SELECT * FROM feed_events"))}
        assert {
            (r.user_id, r.counterpart_user_id)
            for r in c.execute(
                text(
                    "SELECT f.user_id,c.counterpart_user_id FROM feed_events f JOIN feed_event_counterparts c ON c.feed_event_id=f.id"
                )
            )
        } == {("owner", "peer"), ("peer", "owner")}
        for user, source in [
            ("stranger", request),
            ("owner", request + ":invalid"),
            ("owner", "invalid"),
        ]:
            assert (
                c.execute(
                    text(
                        "SELECT resolve_feed_counterpart_user_id(:user,'connections','connection_withdrawn',:source)"
                    ),
                    {"user": user, "source": source},
                ).scalar_one()
                is None
            )

    class Db:
        def execute_raw(self, sql, params):
            with projection_db.begin() as c:
                return SimpleNamespace(
                    data=[dict(row) for row in c.execute(text(sql), params).mappings()]
                )

    service = FeedService()
    service._db = Db()

    def photo(user):
        item = service._to_item(service._with_counterpart_photos(user, [rows[user]])[0])
        assert "counterpart_user_id" not in item
        assert "counterpart_user_id" not in item["metadata"]
        return item["metadata"].get("counterpart_photo_url")

    def resolve(user, event):
        with projection_db.connect() as c:
            return c.execute(
                text("SELECT resolve_feed_counterpart_user_id(:user,'connections',:event,:source)"),
                {"user": user, "event": event, "source": request},
            ).scalar_one()

    assert photo("owner") == "https://example.test/peer.png"
    assert photo("peer") == "https://example.test/owner.png"
    assert service._durable_counterpart_photos("stranger", [rows["owner"]]) == {}
    with projection_db.begin() as c:
        c.execute(
            text("DELETE FROM feed_event_counterparts WHERE feed_event_id=:id"),
            {"id": rows["owner"]["id"]},
        )
        c.execute(
            text(
                "UPDATE actor_identity_cache SET custom_photo_url='https://example.test/new.png' WHERE user_id='peer'"
            )
        )
    assert photo("owner") == "https://example.test/new.png"  # exact source fallback
    with projection_db.begin() as c:
        c.execute(
            text(
                "UPDATE actor_identity_cache SET custom_photo_url=NULL,photo_url=NULL WHERE user_id='peer'"
            )
        )
    assert photo("owner") is None  # never revive a snapshot
    apply(projection_db, ROLLBACK)
    apply(projection_db, ROLLBACK)
    assert resolve("owner", "connection_withdrawn") is None
    for event in ("connection_accepted", "connection_rejected"):
        assert resolve("owner", event) == "peer"
        assert resolve("peer", event) == "owner"
        assert resolve("stranger", event) is None
    assert photo("peer") == "https://example.test/owner.png"  # retained history mapping
    apply(projection_db, MIGRATION)
    assert resolve("owner", "connection_withdrawn") == "peer"
    assert resolve("stranger", "connection_withdrawn") is None
    assert photo("peer") == "https://example.test/owner.png"

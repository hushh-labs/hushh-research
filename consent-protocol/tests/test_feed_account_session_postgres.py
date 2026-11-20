"""Feed removal belongs to the account, on real PostgreSQL.

The founder's flow: remove a Feed item, sign out, sign back in (a new session,
or another device) and it is still gone; another account is never touched;
deleting the account leaves no Feed behind, and a new account with the same
email starts empty. Clearing an ended SOS card is stored the same way. Runs the
production FeedService and Location SQL, the Feed dismissal and recipient clear
migrations, and the account-deletion statement.
"""

import json
import os
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

import hushh_mcp.services.one_location_agent_service as location_service_module
from db.db_client import DatabaseClient, DatabaseExecutionError
from hushh_mcp.services.account_service import AccountService
from hushh_mcp.services.feed_location_policy import with_cleared_feed_receipts
from hushh_mcp.services.feed_service import FeedService
from hushh_mcp.services.one_location_agent_service import OneLocationAgentService
from tests.feed_fixture_support import add_followup_fence_relations

ROOT = Path(__file__).resolve().parents[1]
DISMISSAL_MIGRATION = ROOT / "db/migrations/331_feed_dismissal.sql"
RECIPIENT_CLEAR_MIGRATION = ROOT / "db/migrations/346_one_location_recipient_feed_clear.sql"
RECIPIENT_CLEAR_ROLLBACK = (
    ROOT / "db/migrations/rollback/346_one_location_recipient_feed_clear.rollback.sql"
)

OWNER = "feed-session-owner"
OTHER = "feed-session-other"
SOS_SENDER = "feed-session-sos-sender"
# A new sign-up with the same email gets a new Firebase user id.
OWNER_SIGNED_UP_AGAIN = "feed-session-owner-new-uid"
REQUEST = "6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7"
EXPIRED_CHECKOUT_REQUEST = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d"
PAID_REQUEST = "1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e"


@pytest.fixture
def feed_db():
    source = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not source:
        pytest.skip("Isolated PostgreSQL server required")
    url = make_url(source).set(drivername="postgresql+psycopg2")
    assert url.host in {"127.0.0.1", "localhost"}
    assert url.username == url.database == "command_test"
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    name = "feed_session_test_" + uuid.uuid4().hex
    with admin.connect() as connection:
        connection.execute(text(f'CREATE DATABASE "{name}"'))
    engine = create_engine(url.set(database=name))
    try:
        with engine.begin() as connection:
            # Columns of migration 117 plus the tables the Feed read joins.
            connection.execute(
                text("""
                CREATE TABLE feed_events(id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL,
                  source_domain TEXT NOT NULL, event_type TEXT NOT NULL, actor_label TEXT,
                  metadata JSONB NOT NULL DEFAULT '{}'::jsonb, source_row_id TEXT,
                  read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
                CREATE TABLE messages(id UUID PRIMARY KEY, conversation_id UUID,
                  sender_user_id TEXT, deleted_for_recipient_at TIMESTAMPTZ,
                  deleted_for_everyone_at TIMESTAMPTZ);
                CREATE TABLE conversations(id UUID PRIMARY KEY, participant_a_user_id TEXT,
                  participant_b_user_id TEXT);
                CREATE TABLE drive_share_requests(request_id UUID PRIMARY KEY, user_id TEXT,
                  recipient_user_id TEXT, status TEXT, expires_at TIMESTAMPTZ,
                  access_stop_requested_at TIMESTAMPTZ, payment_required BOOLEAN,
                  settlement_method TEXT, preparation_error_code TEXT,
                  quoted_amount_cents BIGINT, existing_access_waived_at TIMESTAMPTZ);
                CREATE TABLE drive_owner_search_jobs(user_id TEXT, client_request_id UUID,
                  status TEXT, incomplete_search BOOLEAN, matched INT, unshareable_count INT,
                  UNIQUE(user_id,client_request_id));
                CREATE TABLE drive_request_payment_orders(request_id UUID PRIMARY KEY,
                  stripe_mode TEXT, status TEXT, stripe_checkout_session_id TEXT,
                  stripe_checkout_expires_at TIMESTAMPTZ, amount_cents BIGINT,
                  reconciliation_reason TEXT);
                CREATE TABLE drive_request_owner_payouts(request_id UUID, erased_at TIMESTAMPTZ,
                  status TEXT, owner_earning_cents BIGINT);
                CREATE TABLE stripe_owner_payout_accounts(user_id TEXT, account_ready BOOLEAN,
                  stripe_mode TEXT);
                CREATE TABLE drive_request_payment_refunds(request_id UUID, status TEXT,
                  amount_cents BIGINT);
                CREATE TABLE drive_bulk_shares(share_id UUID PRIMARY KEY, user_id TEXT,
                  origin_request_id UUID, approved_at TIMESTAMPTZ, progressive_batch BOOLEAN,
                  expires_at TIMESTAMPTZ DEFAULT now() + interval '1 day');
                CREATE TABLE drive_request_bulk_removals(share_id UUID, position INT,
                  recipient_user_id TEXT);
                CREATE TABLE drive_bulk_share_effects(share_id UUID, user_id TEXT, position INT,
                  recipient_user_id TEXT, state TEXT);
                CREATE TABLE drive_bulk_share_files(share_id UUID, user_id TEXT, position INT,
                  origin_request_id UUID);
                -- Grant columns as of migrations 061 and 150.
                CREATE TABLE one_location_share_grants(
                  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                  owner_user_id TEXT NOT NULL, recipient_user_id TEXT NOT NULL,
                  recipient_key_id TEXT NOT NULL,
                  status TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'expired', 'revoked')),
                  duration_hours NUMERIC(6, 2), expires_at TIMESTAMPTZ,
                  duration_mode TEXT NOT NULL DEFAULT 'timed',
                  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                  revoked_at TIMESTAMPTZ,
                  metadata JSONB NOT NULL DEFAULT '{}'::jsonb);
            """)
            )
            add_followup_fence_relations(connection)
        for migration in (DISMISSAL_MIGRATION, RECIPIENT_CLEAR_MIGRATION):
            apply(engine, migration)
            apply(engine, migration)
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


def seed(engine, user_id: str, rows: list[tuple[str, str, str, dict]]) -> dict[str, int]:
    ids: dict[str, int] = {}
    with engine.begin() as connection:
        for name, source_domain, event_type, metadata in rows:
            ids[name] = connection.execute(
                text("""
                    INSERT INTO feed_events(user_id, source_domain, event_type, metadata)
                    VALUES (:user_id, :source_domain, :event_type, CAST(:metadata AS JSONB))
                    RETURNING id
                """),
                {
                    "user_id": user_id,
                    "source_domain": source_domain,
                    "event_type": event_type,
                    "metadata": json.dumps(metadata),
                },
            ).scalar_one()
    return ids


def session(engine) -> FeedService:
    """A fresh service and connection pool, as a new sign-in or device reads."""
    service = FeedService()
    service._db = DatabaseClient(engine)
    return service


def listed_ids(service: FeedService, user_id: str) -> list[int]:
    return [int(item["id"]) for item in service.list_feed(user_id, limit=100)["items"]]


def policy_event(
    engine, viewer, event_type, metadata, *, source=None, peer=None, domain="location"
):
    with engine.begin() as connection:
        event_id = connection.execute(
            text("""
          INSERT INTO feed_events(user_id,source_domain,event_type,metadata,source_row_id)
          VALUES (:viewer,:domain,:event,CAST(:metadata AS JSONB),:source) RETURNING id
        """),
            {
                "viewer": viewer,
                "domain": domain,
                "event": event_type,
                "metadata": json.dumps(metadata),
                "source": source,
            },
        ).scalar_one()
        if peer:
            connection.execute(
                text("INSERT INTO feed_event_counterparts VALUES (:id,:peer)"),
                {"id": event_id, "peer": peer},
            )
    return event_id


def test_important_feed_is_incoming_and_preserves_other_dri_rows(feed_db):
    grant = str(uuid.uuid4())
    incoming = policy_event(
        feed_db,
        OWNER,
        "location_share_created",
        {"feed_audience": "recipient", "reason": "recipient_revoke"},
        source=grant,
        peer=OTHER,
    )
    added = policy_event(
        feed_db,
        OWNER,
        "circle_member_added",
        {"circle_id": str(uuid.uuid4()), "circle_name": "Friends"},
        peer=OTHER,
    )
    accepted = policy_event(
        feed_db,
        OWNER,
        "connection_accepted",
        {"actor_is_self": False},
        domain="connections",
        peer=OTHER,
    )
    other_dri = policy_event(feed_db, OWNER, "kai_analysis_saved", {}, domain="kai")
    # A self-initiated Circle join is not an incoming addition from someone else.
    policy_event(
        feed_db, OWNER, "circle_member_added", {"circle_id": str(uuid.uuid4())}, peer=OWNER
    )
    for event, meta, domain in [
        ("location_share_created", {}, "location"),
        ("location_share_expired", {}, "location"),
        ("location_share_viewed", {}, "location"),
        ("location_access_request", {"feed_audience": "requester"}, "location"),
        ("location_access_request", {}, "location"),
        ("location_circle_message", {"circle_id": "circle-a"}, "location"),
        ("connection_accepted", {"actor_is_self": True}, "connections"),
        ("connection_withdrawn", {"actor_is_self": False}, "connections"),
    ]:
        policy_event(feed_db, OWNER, event, meta, domain=domain)
    policy_event(feed_db, OTHER, "circle_member_added", {})
    service = session(feed_db)
    assert set(listed_ids(service, OWNER)) == {incoming, added, accepted, other_dri}
    assert service.unread_count(OWNER) == 4
    assert listed_ids(service, OTHER) == []  # Unbound legacy copy has no exact Circle workflow.


def test_exact_sms_incidents_survive_independent_dismiss_undo_clear_and_source_cleanup(feed_db):
    old_grant, new_grant, other_grant = (str(uuid.uuid4()) for _ in range(3))
    meta = {
        "feed_audience": "recipient",
        "share_kind": "sos",
        "feed_sms_confirmed": True,
        "counterpart_label": "Same name",
    }
    old = policy_event(
        feed_db, OWNER, "location_share_created", meta, source=old_grant, peer=SOS_SENDER
    )
    latest = policy_event(
        feed_db, OWNER, "location_share_created", meta, source=new_grant, peer=SOS_SENDER
    )
    independent = policy_event(
        feed_db, OWNER, "location_share_created", meta, source=other_grant, peer=OTHER
    )
    service = session(feed_db)
    assert set(listed_ids(service, OWNER)) == {old, latest, independent}
    assert service.unread_count(OWNER) == 3
    prior_key = next(
        row["activity_group_id"]
        for row in service.list_feed(OWNER)["items"]
        if int(row["id"]) == latest
    )
    ended = policy_event(
        feed_db, OWNER, "location_share_revoked", meta, source=old_grant, peer=SOS_SENDER
    )
    assert set(listed_ids(session(feed_db), OWNER)) == {ended, latest, independent}
    assert service.unread_count(OWNER) == 2
    token = service.dismiss(OWNER, item_id=latest)["dismissal_token"]
    assert set(listed_ids(session(feed_db), OWNER)) == {ended, independent}
    assert service.restore(OWNER, item_id=latest, dismissal_token=token)["restored"] is True
    assert set(listed_ids(session(feed_db), OWNER)) == {ended, latest, independent}
    service.clear(OWNER, up_to_id=ended)
    assert listed_ids(session(feed_db), OWNER) == []
    assert service.unread_count(OWNER) == 0
    with feed_db.begin() as connection:
        connection.execute(text("DELETE FROM one_location_share_grants"))
    assert listed_ids(session(feed_db), OWNER) == []
    newest_grant = str(uuid.uuid4())
    newest = policy_event(
        feed_db, OWNER, "location_share_created", meta, source=newest_grant, peer=SOS_SENDER
    )
    assert listed_ids(session(feed_db), OWNER) == [newest]
    assert service.unread_count(OWNER) == 1
    assert (
        service.list_feed(OWNER)["items"][0]["activity_group_id"]
        == "location-grant:" + newest_grant
    )
    assert service.list_feed(OWNER)["items"][0]["activity_group_id"] != prior_key


def test_history_revision_recovers_missed_sms_and_clear_hints_without_cross_account_leaks(
    feed_db, monkeypatch
):
    meta = {"feed_audience": "recipient", "share_kind": "sos", "feed_sms_confirmed": True}
    own_grant, foreign_grant = str(uuid.uuid4()), str(uuid.uuid4())
    with feed_db.begin() as connection:
        for grant_id, recipient in [(own_grant, OWNER), (foreign_grant, OTHER)]:
            connection.execute(
                text("""
              INSERT INTO one_location_share_grants
                (id,owner_user_id,recipient_user_id,recipient_key_id,status,duration_mode)
              VALUES (CAST(:id AS uuid),:sender,:recipient,'key','revoked','until_stopped')
            """),
                {"id": grant_id, "sender": SOS_SENDER, "recipient": recipient},
            )
    service = session(feed_db)
    policy_event(
        feed_db, OWNER, "location_share_created", meta, source=str(uuid.uuid4()), peer=SOS_SENDER
    )
    first_revision = service.list_feed(OWNER)["history_revision"]
    latest = policy_event(
        feed_db, OWNER, "location_share_created", meta, source=own_grant, peer=SOS_SENDER
    )
    replaced_revision = service.list_feed(OWNER)["history_revision"]
    assert (
        replaced_revision == first_revision
    )  # Independent arrivals do not invalidate loaded history.
    policy_event(
        feed_db, OWNER, "location_share_created", meta, source=str(uuid.uuid4()), peer=OTHER
    )
    assert service.list_feed(OWNER)["history_revision"] == replaced_revision

    # Another device can miss a live dismissal/Undo hint. Its next snapshot
    # still drops obsolete loaded pages, even when the first page is nonempty.
    token = service.dismiss(OWNER, item_id=latest)["dismissal_token"]
    assert service.list_feed(OWNER)["history_revision"] != replaced_revision
    assert service.restore(OWNER, item_id=latest, dismissal_token=token)["restored"] is True
    assert service.list_feed(OWNER)["history_revision"] == replaced_revision

    monkeypatch.setattr(location_service_module, "get_db", lambda: DatabaseClient(feed_db))
    location = OneLocationAgentService()
    assert location.clear_received_grants(recipient_user_id=OTHER, grant_ids=[foreign_grant]) == [
        foreign_grant
    ]
    assert service.list_feed(OWNER)["history_revision"] == replaced_revision
    with feed_db.begin() as connection:
        connection.execute(
            text("""
          CREATE FUNCTION reject_feed_clear() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'TEST_FEED_RECEIPT_CLEAR_FAILURE'; END $$;
          CREATE TRIGGER reject_feed_clear BEFORE UPDATE ON feed_events
          FOR EACH ROW EXECUTE FUNCTION reject_feed_clear();
        """)
        )
    with pytest.raises(DatabaseExecutionError, match="TEST_FEED_RECEIPT_CLEAR_FAILURE"):
        location.clear_received_grants(recipient_user_id=OWNER, grant_ids=[own_grant])
    with feed_db.begin() as connection:
        assert (
            connection.execute(
                text(
                    "SELECT recipient_cleared_at FROM one_location_share_grants WHERE id=CAST(:id AS uuid)"
                ),
                {"id": own_grant},
            ).scalar_one()
            is None
        )
        connection.execute(text("DROP TRIGGER reject_feed_clear ON feed_events"))
    assert location.clear_received_grants(recipient_user_id=OWNER, grant_ids=[own_grant]) == [
        own_grant
    ]
    after_clear = session(feed_db).list_feed(OWNER)
    assert after_clear["history_revision"] != replaced_revision
    assert len(after_clear["history_revision"]) == 32
    assert str(latest) not in [row["id"] for row in after_clear["items"]]
    with feed_db.begin() as connection:
        connection.execute(
            text("DELETE FROM one_location_share_grants WHERE id=CAST(:id AS uuid)"),
            {"id": own_grant},
        )
    assert str(latest) not in [row["id"] for row in session(feed_db).list_feed(OWNER)["items"]]


def test_legacy_clear_retention_keeps_receipt_hidden_and_invalidates_stale_undo(feed_db):
    grant = str(uuid.uuid4())
    with feed_db.begin() as connection:
        connection.execute(
            text("""
          INSERT INTO one_location_share_grants
            (id,owner_user_id,recipient_user_id,recipient_key_id,status,recipient_cleared_at)
          VALUES (CAST(:id AS uuid),:sender,:recipient,'key','revoked',NOW())
        """),
            {"id": grant, "sender": SOS_SENDER, "recipient": OWNER},
        )
    meta = {"feed_audience": "recipient", "share_kind": "sos", "feed_sms_confirmed": True}
    receipt = policy_event(
        feed_db, OWNER, "location_share_created", meta, source=grant, peer=SOS_SENDER
    )
    foreign = policy_event(
        feed_db, OTHER, "location_share_created", meta, source=grant, peer=SOS_SENDER
    )
    service = session(feed_db)
    stale_undo = service.dismiss(OWNER, item_id=receipt)["dismissal_token"]
    # Exercise the production retention primitive with an old server-side Clear.
    # The domain's existing stale-grant selector supplies these authoritative rows.
    with feed_db.begin() as connection:
        connection.execute(
            text(
                with_cleared_feed_receipts("""
          WITH feed_clear_candidates AS (
            SELECT id AS grant_id, recipient_user_id, recipient_cleared_at AS cleared_at
              FROM one_location_share_grants
             WHERE id=CAST(:id AS uuid) AND recipient_cleared_at IS NOT NULL
          ), hidden AS (__CLEARED_FEED_RECEIPTS__)
          DELETE FROM one_location_share_grants WHERE id=CAST(:id AS uuid)
            AND (SELECT count(*) FROM hidden) >= 0
        """)
            ),
            {"id": grant},
        )
        assert (
            connection.execute(
                text("SELECT dismissed_at FROM feed_events WHERE id=:id"), {"id": foreign}
            ).scalar_one()
            is None
        )
    assert service.restore(OWNER, item_id=receipt, dismissal_token=stale_undo)["restored"] is False
    assert listed_ids(session(feed_db), OWNER) == []


def test_share_expiry_updates_one_group_without_a_new_unread_item(feed_db):
    grant = str(uuid.uuid4())
    meta = {"feed_audience": "recipient"}
    created = policy_event(feed_db, OWNER, "location_share_created", meta, source=grant)
    first = session(feed_db).list_feed(OWNER)["items"][0]
    session(feed_db).mark_read(OWNER, up_to_id=created)
    expired = policy_event(feed_db, OWNER, "location_share_expired", meta, source=grant)
    page = session(feed_db).list_feed(OWNER)
    assert [row["id"] for row in page["items"]] == [str(expired)]
    assert (
        page["items"][0]["activity_group_id"]
        == first["activity_group_id"]
        == "location-grant:" + grant
    )
    assert page["items"][0]["metadata"]["feed_silent"] is True
    assert page["items"][0]["read"] is True
    assert page["unread_count"] == 0
    session(feed_db).dismiss(OWNER, item_id=expired)
    assert listed_ids(session(feed_db), OWNER) == []


def test_circle_contexts_are_independent_and_deleted_source_never_revives_an_add(feed_db):
    circle_a, circle_b = str(uuid.uuid4()), str(uuid.uuid4())
    with feed_db.begin() as connection:
        connection.execute(
            text("INSERT INTO one_location_circles VALUES (CAST(:id AS uuid),:owner)"),
            {"id": circle_a, "owner": OTHER},
        )
    first = policy_event(feed_db, OWNER, "circle_member_added", {"circle_id": circle_a}, peer=OTHER)
    second = policy_event(
        feed_db, OWNER, "circle_member_added", {"circle_id": circle_b}, peer=OTHER
    )
    deleted = policy_event(feed_db, OWNER, "circle_deleted", {}, source=circle_a)
    policy_event(feed_db, OTHER, "circle_deleted", {}, source=circle_a)
    service = session(feed_db)
    assert set(listed_ids(service, OWNER)) == {deleted, second}
    assert listed_ids(service, OTHER) == []  # Own Circle deletion is not incoming.
    page = service.list_feed(OWNER, limit=1)
    assert [int(row["id"]) for row in page["items"]] == [deleted]
    assert page["next_cursor"] is not None
    assert [
        int(row["id"])
        for row in service.list_feed(OWNER, cursor=page["next_cursor"], limit=1)["items"]
    ] == [second]
    with feed_db.begin() as connection:
        connection.execute(
            text("DELETE FROM one_location_circles WHERE id=CAST(:id AS uuid)"), {"id": circle_a}
        )
    assert listed_ids(session(feed_db), OWNER) == [second]
    assert first not in listed_ids(session(feed_db), OWNER)


def test_partial_delivery_counts_only_active_claims_for_each_participant(feed_db):
    active, superseded = str(uuid.uuid4()), str(uuid.uuid4())
    with feed_db.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_share_requests
            (request_id,user_id,recipient_user_id,status,payment_required)
            VALUES (:request,:owner,:recipient,'partial',FALSE)"""),
            {"request": REQUEST, "owner": OWNER, "recipient": OTHER},
        )
        for share in (active, superseded):
            connection.execute(
                text("""INSERT INTO drive_bulk_shares
                (share_id,user_id,origin_request_id,approved_at,progressive_batch)
                VALUES (:share,:owner,:request,now(),TRUE)"""),
                {"share": share, "owner": OWNER, "request": REQUEST},
            )
        for position in range(1, 21):
            connection.execute(
                text("""INSERT INTO drive_bulk_share_files
                VALUES (:share,:owner,:position,:request);
                INSERT INTO drive_bulk_share_effects
                VALUES (:share,:owner,:position,:recipient,:state)"""),
                {
                    "share": active,
                    "owner": OWNER,
                    "position": position,
                    "request": REQUEST,
                    "recipient": OTHER,
                    "state": "succeeded" if position <= 13 else "preexisting",
                },
            )
        # Recovery retains the old effect for audit and detaches its source claim.
        connection.execute(
            text("""INSERT INTO drive_bulk_share_files
            VALUES (:share,:owner,1,NULL);
            INSERT INTO drive_bulk_share_effects
            VALUES (:share,:owner,1,:recipient,'skipped')"""),
            {"share": superseded, "owner": OWNER, "recipient": OTHER},
        )
    row = {
        "event_type": "document_share_outcome",
        "metadata": {"request_id": REQUEST, "user_facing_status": "partial"},
    }
    for viewer in (OWNER, OTHER, SOS_SENDER):
        service = session(feed_db)
        hydrated = service._with_drive_payment_status(viewer, [row])
        metadata = FeedService._to_item({"id": 1, **hydrated[0]})["metadata"]
        counts = {
            key: value for key, value in metadata.items() if key.startswith("current_delivery_")
        }
        assert counts == (
            {
                "current_delivery_total_count": 20,
                "current_delivery_confirmed_count": 20,
                "current_delivery_pending_count": 0,
            }
            if viewer in (OWNER, OTHER)
            else {}
        )


def account_rows(engine, user_id: str) -> int:
    with engine.connect() as connection:
        return connection.execute(
            text("SELECT count(*) FROM feed_events WHERE user_id = :user_id"),
            {"user_id": user_id},
        ).scalar_one()


DRIVE_AND_HISTORY = [
    (
        "pay",
        "connected_systems",
        "document_share_payment_ready",
        {"request_id": REQUEST, "user_facing_status": "pending"},
    ),
    (
        "files_available",
        "connected_systems",
        "document_share_decided",
        {"request_id": REQUEST, "user_facing_status": "pending"},
    ),
    (
        "no_files",
        "connected_systems",
        "document_share_outcome",
        {"request_id": REQUEST, "user_facing_status": "no_files_shared"},
    ),
    ("consent_first", "consent", "consent_granted", {"bundle_id": "bundle-1"}),
    ("consent_latest", "consent", "consent_granted", {"bundle_id": "bundle-1"}),
    ("analysis", "kai", "kai_analysis_saved", {}),
]


def test_removed_items_stay_gone_per_account_and_leave_with_the_account(feed_db):
    owner = seed(feed_db, OWNER, DRIVE_AND_HISTORY)
    other = seed(feed_db, OTHER, DRIVE_AND_HISTORY)
    phone = session(feed_db)
    laptop = session(feed_db)

    # Removing "No files were shared" takes the rows it was hiding with it.
    removal = phone.dismiss(OWNER, item_id=owner["no_files"])
    hidden_with_it = sorted([owner["pay"], owner["files_available"], owner["no_files"]])
    assert removal["dismissed_ids"] == [str(row_id) for row_id in hidden_with_it]
    # Undo from another device restores exactly that set.
    assert laptop.restore(
        OWNER, item_id=owner["no_files"], dismissal_token=removal["dismissal_token"]
    ) == {"status": "ok", "restored": True}
    assert listed_ids(session(feed_db), OWNER) == [
        owner["analysis"],
        owner["consent_latest"],
        owner["no_files"],
    ]

    removal = phone.dismiss(OWNER, item_id=owner["no_files"])
    phone.clear(OWNER, up_to_id=owner["consent_latest"])
    # Activity after the Clear stays visible.
    later = seed(feed_db, OWNER, [("later", "kai", "kai_analysis_saved", {})])["later"]

    # Sign out and back in: a new session reads only what the server kept.
    signed_in_again = session(feed_db)
    assert listed_ids(signed_in_again, OWNER) == [later, owner["analysis"]]
    assert signed_in_again.unread_count(OWNER) == 2
    # Clear superseded the removal, so its stale Undo cannot bring rows back.
    assert signed_in_again.restore(
        OWNER, item_id=owner["no_files"], dismissal_token=removal["dismissal_token"]
    ) == {"status": "ok", "restored": False}
    assert listed_ids(signed_in_again, OWNER) == [later, owner["analysis"]]

    # The other account's identical rows are untouched.
    assert listed_ids(signed_in_again, OTHER) == [
        other["analysis"],
        other["consent_latest"],
        other["no_files"],
    ]
    assert signed_in_again.unread_count(OTHER) == 3

    # Account deletion's Feed statement leaves nothing for that account.
    with feed_db.begin() as connection:
        AccountService()._delete_user_rows_if_table_exists(
            connection, table_name="feed_events", params={"user_id": OWNER}
        )
    assert account_rows(feed_db, OWNER) == 0
    assert account_rows(feed_db, OTHER) == len(other)

    # A new account with the same email starts with an empty Feed.
    fresh = session(feed_db)
    fresh_page = fresh.list_feed(OWNER_SIGNED_UP_AGAIN)
    revision = fresh_page.pop("history_revision")
    assert fresh_page.pop("clear_version") is None
    assert fresh_page.pop("read_snapshot")["up_to_id"] is None
    assert fresh_page == {
        "items": [],
        "next_cursor": None,
        "unread_count": 0,
    }
    assert isinstance(revision, str) and len(revision) == 32
    assert fresh.list_feed(OWNER)["items"] == []


def test_historical_pwm_attention_is_hidden_without_hiding_reviewable_drafts(feed_db):
    draft = str(uuid.uuid4())
    rows = seed(
        feed_db,
        OWNER,
        [
            ("failed", "pwm", "pwm_research", {"draft_id": draft, "pwm_outcome": "attention"}),
            ("missing", "pwm", "pwm_research", {"draft_id": str(uuid.uuid4())}),
            ("other", "kai", "kai_analysis_saved", {}),
            (
                "ready",
                "pwm",
                "pwm_research",
                {"draft_id": str(uuid.uuid4()), "pwm_outcome": "ready"},
            ),
            (
                "partial",
                "pwm",
                "pwm_research",
                {"draft_id": str(uuid.uuid4()), "pwm_outcome": "partial"},
            ),
        ],
    )
    owner = session(feed_db)
    assert listed_ids(owner, OWNER) == [rows["partial"], rows["ready"], rows["other"]]
    assert owner.unread_count(OWNER) == 3
    assert [item["id"] for item in owner.list_feed(OWNER, limit=2)["items"]] == [
        str(rows["partial"]),
        str(rows["ready"]),
    ]
    assert listed_ids(session(feed_db), OTHER) == []


def test_feed_omits_routine_notices_and_reconnect_without_current_source(feed_db):
    rows = seed(
        feed_db,
        OWNER,
        [
            ("sent", "connected_systems", "document_share_request_sent", {}),
            ("complete", "connected_systems", "drive_search_completed", {}),
            ("limited", "connected_systems", "drive_search_limited", {}),
            ("failed", "connected_systems", "drive_search_failed", {}),
            ("stopped", "connected_systems", "drive_search_stopped", {}),
            ("timeout", "consent", "consent_timed_out", {}),
            ("payment", "connected_systems", "document_share_payment_confirmed", {}),
            ("delivery", "connected_systems", "document_share_outcome", {}),
            ("reconnect", "connected_systems", "connector_reconnect_required", {}),
            ("legacy_connector", "connected_systems", "connector_connected", {}),
        ],
    )
    service = session(feed_db)
    service.record_event(
        user_id=OWNER,
        source_domain="connected_systems",
        event_type="connector_connected",
        source_row_id="google_drive:1",
    )
    service.record_event(
        user_id=OWNER,
        source_domain="connected_systems",
        event_type="connector_connected",
        source_row_id="another_connector:1",
    )

    first = service.list_feed(OWNER, limit=3)
    assert [item["event_type"] for item in first["items"]] == [
        "document_share_outcome",
        "document_share_payment_confirmed",
        "document_share_request_sent",
    ]
    assert first["next_cursor"] is None
    assert first["unread_count"] == service.unread_count(OWNER) == 3
    # Sources are retained; suppressing routine presentation never deletes history.
    assert account_rows(feed_db, OWNER) == len(rows) + 2


def test_document_activity_groups_before_pagination_and_ignores_late_payment(feed_db):
    rows = seed(
        feed_db,
        OWNER,
        [
            ("connection", "connections", "connection_accepted", {}),
            (
                "request",
                "connected_systems",
                "document_share_request_sent",
                {"request_id": REQUEST},
            ),
            (
                "partial",
                "connected_systems",
                "document_share_outcome",
                {"request_id": REQUEST, "user_facing_status": "partial"},
            ),
            (
                "delivered",
                "connected_systems",
                "document_share_outcome",
                {"request_id": REQUEST, "user_facing_status": "completed"},
            ),
            (
                "late_payment",
                "connected_systems",
                "document_share_payment_confirmed",
                {"request_id": REQUEST},
            ),
            (
                "separate",
                "connected_systems",
                "document_share_request_sent",
                {"request_id": PAID_REQUEST},
            ),
        ],
    )
    service = session(feed_db)
    first = service.list_feed(OWNER, limit=1)
    assert first["items"][0]["activity_group_id"] == f"document:{PAID_REQUEST}"
    second = service.list_feed(OWNER, cursor=int(first["next_cursor"]), limit=1)
    item = second["items"][0]
    assert item["id"] == str(rows["delivered"])
    assert item["activity_group_id"] == f"document:{REQUEST}"
    assert item["activity_revision"] == str(rows["late_payment"])
    assert second["unread_count"] == 2
    third = service.list_feed(OWNER, cursor=int(second["next_cursor"]), limit=1)
    assert [entry["id"] for entry in third["items"]] == [str(rows["connection"])]
    assert third["next_cursor"] is None

    # A receipt remains findable after delivery replaces the payment headline.
    receipt = service.search_activity(OWNER, query="receipt", scope="drive")["items"]
    assert len(receipt) == 1 and receipt[0]["id"] == str(rows["delivered"])
    assert receipt[0]["search_events"] == ["document_share_payment_confirmed"]
    current = service.search_activity(OWNER, scope="drive")["items"]
    assert all(item["search_events"] == [] for item in current)
    assert service.search_activity(OTHER, query="receipt", scope="drive")["items"] == []

    removal = service.dismiss(OWNER, item_id=int(item["activity_revision"]))
    assert removal["dismissed_ids"] == [
        str(rows[name]) for name in ("request", "partial", "delivered", "late_payment")
    ]
    seed(
        feed_db,
        OWNER,
        [
            (
                "retry",
                "connected_systems",
                "document_share_payment_confirmed",
                {"request_id": REQUEST},
            )
        ],
    )
    assert listed_ids(session(feed_db), OWNER) == [rows["separate"], rows["connection"]]
    assert service.restore(
        OWNER, item_id=int(item["activity_revision"]), dismissal_token=removal["dismissal_token"]
    )["restored"]
    assert listed_ids(session(feed_db), OWNER) == [
        rows["separate"],
        rows["delivered"],
        rows["connection"],
    ]


def test_drive_removal_reads_the_current_payment_status(feed_db):
    with feed_db.begin() as connection:
        for request_id, order_status in (
            (EXPIRED_CHECKOUT_REQUEST, "expired"),
            (PAID_REQUEST, "paid"),
        ):
            connection.execute(
                text("""
                    INSERT INTO drive_share_requests(request_id, user_id, recipient_user_id,
                      status, expires_at, payment_required, settlement_method)
                    VALUES (CAST(:request_id AS UUID), :owner, 'requester', 'completed',
                      now() + interval '1 day', TRUE, 'stripe')
                """),
                {"request_id": request_id, "owner": OWNER},
            )
            connection.execute(
                text("""
                    INSERT INTO drive_request_payment_orders(request_id, stripe_mode, status,
                      amount_cents)
                    VALUES (CAST(:request_id AS UUID), 'test', :order_status, 500)
                """),
                {"request_id": request_id, "order_status": order_status},
            )
    rows = seed(
        feed_db,
        OWNER,
        [
            (
                f"{name}_pay",
                "connected_systems",
                "document_share_payment_ready",
                {"request_id": request_id, "user_facing_status": "pending"},
            )
            for name, request_id in (("expired", EXPIRED_CHECKOUT_REQUEST), ("paid", PAID_REQUEST))
        ]
        + [
            (
                f"{name}_outcome",
                "connected_systems",
                "document_share_outcome",
                {"request_id": request_id, "user_facing_status": "completed"},
            )
            for name, request_id in (("expired", EXPIRED_CHECKOUT_REQUEST), ("paid", PAID_REQUEST))
        ],
    )
    service = session(feed_db)

    # An expired checkout and a paid one both belong to their own request.
    assert service.dismiss(OWNER, item_id=rows["expired_outcome"])["dismissed_ids"] == [
        str(rows["expired_pay"]),
        str(rows["expired_outcome"]),
    ]
    # A paid order's Pay row was hidden behind the outcome; it leaves with it.
    assert service.dismiss(OWNER, item_id=rows["paid_outcome"])["dismissed_ids"] == [
        str(rows["paid_pay"]),
        str(rows["paid_outcome"]),
    ]
    assert listed_ids(session(feed_db), OWNER) == []


def test_sos_clear_is_stored_for_the_recipient_and_never_hides_a_live_share(feed_db, monkeypatch):
    def grant(recipient: str, status: str, minutes: int | None, mode: str = "timed") -> str:
        with feed_db.begin() as connection:
            return connection.execute(
                text("""
                    INSERT INTO one_location_share_grants(owner_user_id, recipient_user_id,
                      recipient_key_id, status, duration_hours, expires_at, duration_mode,
                      metadata, updated_at)
                    VALUES (:owner, :recipient, 'key', :status,
                      CASE WHEN :mode = 'timed' THEN 1 END,
                      now() + make_interval(mins => CAST(:minutes AS INTEGER)), :mode,
                      CAST(:metadata AS JSONB), TIMESTAMPTZ '2026-10-01T00:00:00Z')
                    RETURNING id::TEXT
                """),
                {
                    "owner": SOS_SENDER,
                    "recipient": recipient,
                    "status": status,
                    "minutes": minutes,
                    "mode": mode,
                    "metadata": json.dumps({"share_kind": "sos"}),
                },
            ).scalar_one()

    stopped = grant(OWNER, "revoked", 60)
    ran_out = grant(OWNER, "active", -1)
    live = grant(OWNER, "active", 60)
    until_stopped = grant(OWNER, "active", None, mode="until_stopped")
    someone_elses = grant(OTHER, "revoked", 60)
    requested = [stopped, ran_out, live, until_stopped, someone_elses]
    monkeypatch.setattr(location_service_module, "get_db", lambda: DatabaseClient(feed_db))

    def cleared() -> dict[str, object]:
        with feed_db.connect() as connection:
            return dict(
                connection.execute(
                    text("SELECT id::TEXT, recipient_cleared_at FROM one_location_share_grants")
                ).all()
            )

    def updated() -> set[str]:
        with feed_db.connect() as connection:
            return {
                str(value)
                for value in connection.execute(
                    text("SELECT DISTINCT updated_at FROM one_location_share_grants")
                ).scalars()
            }

    phone = OneLocationAgentService()
    assert phone.clear_received_grants(recipient_user_id=OWNER, grant_ids=requested) == sorted(
        [stopped, ran_out]
    )
    first = cleared()
    # Only the recipient's own ended shares; a live SOS and other people's
    # grants stay as they were, and the sender sees no change to the grant.
    assert {grant_id for grant_id, at in first.items() if at is not None} == {stopped, ran_out}
    assert len(updated()) == 1

    # A second device, or a retry, reads the same server state.
    laptop = OneLocationAgentService()
    assert laptop.clear_received_grants(recipient_user_id=OWNER, grant_ids=requested) == sorted(
        [stopped, ran_out]
    )
    assert cleared() == first

    # A code rollback keeps the clears, and the forward migration replays.
    apply(feed_db, RECIPIENT_CLEAR_ROLLBACK)
    apply(feed_db, RECIPIENT_CLEAR_MIGRATION)
    assert cleared() == first


def test_finance_projection_precedes_pagination_and_keeps_operations_distinct(feed_db):
    def event(owner, kind, source, metadata, created):
        with feed_db.begin() as conn:
            return conn.execute(
                text("""INSERT INTO feed_events(
                user_id, source_domain, event_type, source_row_id, metadata, created_at)
                VALUES(:owner,'kai',:kind,:source,CAST(:metadata AS jsonb),CAST(:created AS timestamptz))
                RETURNING id"""),
                dict(
                    owner=owner,
                    kind=kind,
                    source=source,
                    metadata=json.dumps(metadata),
                    created=created,
                ),
            ).scalar_one()

    def funding(owner, transfer, status, day, direction=None):
        return event(
            owner,
            "funding_transfer_status",
            f"{transfer}:{status}",
            {"user_facing_status": status, "direction": direction, "amount": 10},
            f"2025-10-{day}T12:00:00Z",
        )

    completion = funding(OWNER, "first", "completed", "01", "INCOMING")
    second = funding(OWNER, "same-amount", "completed", "02", "INCOMING")
    returned = funding(OWNER, "first", "returned", "04")
    late = funding(OWNER, "first", "failed", "03", "INCOMING")
    funding(OTHER, "first", "returned", "04")
    old_parser = event(OWNER, "kai_import_completed", "parser", {}, "2025-10-04T13:00:00Z")
    first_run = event(
        OWNER,
        "kai_analysis_saved",
        "run-1",
        {"ticker": "AAPL", "run_id": "run-1"},
        "2025-10-05T12:00:00Z",
    )
    last_run = event(
        OWNER,
        "kai_analysis_saved",
        "run-2",
        {"ticker": "AAPL", "run_id": "run-2"},
        "2025-10-05T13:00:00Z",
    )

    viewer = session(feed_db)
    first_page = viewer.list_feed(OWNER, limit=2)
    assert [int(row["id"]) for row in first_page["items"]] == [last_run, first_run]
    assert first_page["unread_count"] == 3
    assert listed_ids(viewer, OWNER) == [last_run, first_run, returned, second]
    assert old_parser not in listed_ids(viewer, OWNER)
    [record] = viewer.historical_funding(OWNER, terms=["returned", "october"])
    assert record["itemId"] == str(returned)
    assert record["direction"] == "transfer"
    assert [step["status"] for step in record["milestones"]] == ["completed", "failed", "returned"]
    assert viewer.historical_funding(OTHER, item_id=returned) == []

    viewer.mark_read(OWNER, up_to_id=last_run)
    assert session(feed_db).unread_count(OWNER) == 0
    assert set(viewer.dismiss(OWNER, item_id=returned)["dismissed_ids"]) == {
        str(completion),
        str(returned),
        str(late),
    }
    assert session(feed_db).historical_funding(OWNER, item_id=returned) == []
    assert second in listed_ids(session(feed_db), OWNER)

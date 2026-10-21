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
from db.db_client import DatabaseClient
from hushh_mcp.services.account_service import AccountService
from hushh_mcp.services.feed_service import FeedService
from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

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
                  sender_user_id TEXT);
                CREATE TABLE conversations(id UUID PRIMARY KEY, participant_a_user_id TEXT,
                  participant_b_user_id TEXT);
                CREATE TABLE drive_share_requests(request_id UUID PRIMARY KEY, user_id TEXT,
                  recipient_user_id TEXT, status TEXT, expires_at TIMESTAMPTZ,
                  access_stop_requested_at TIMESTAMPTZ, payment_required BOOLEAN,
                  settlement_method TEXT, preparation_error_code TEXT,
                  quoted_amount_cents BIGINT, existing_access_waived_at TIMESTAMPTZ);
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
                  origin_request_id UUID, approved_at TIMESTAMPTZ, progressive_batch BOOLEAN);
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
    ("analysis", "kai", "kai_analysis_completed", {}),
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
    assert set(hidden_with_it) <= set(listed_ids(session(feed_db), OWNER))

    removal = phone.dismiss(OWNER, item_id=owner["no_files"])
    phone.clear(OWNER, up_to_id=owner["consent_latest"])
    # Activity after the Clear stays visible.
    later = seed(feed_db, OWNER, [("later", "kai", "kai_analysis_completed", {})])["later"]

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
    assert listed_ids(signed_in_again, OTHER) == sorted(other.values(), reverse=True)
    assert signed_in_again.unread_count(OTHER) == len(other)

    # Account deletion's Feed statement leaves nothing for that account.
    with feed_db.begin() as connection:
        AccountService()._delete_user_rows_if_table_exists(
            connection, table_name="feed_events", params={"user_id": OWNER}
        )
    assert account_rows(feed_db, OWNER) == 0
    assert account_rows(feed_db, OTHER) == len(other)

    # A new account with the same email starts with an empty Feed.
    fresh = session(feed_db)
    assert fresh.list_feed(OWNER_SIGNED_UP_AGAIN) == {
        "items": [],
        "next_cursor": None,
        "unread_count": 0,
    }
    assert fresh.list_feed(OWNER)["items"] == []


def test_historical_pwm_attention_is_hidden_without_hiding_reviewable_drafts(feed_db):
    draft = str(uuid.uuid4())
    rows = seed(
        feed_db,
        OWNER,
        [
            ("failed", "pwm", "pwm_research", {"draft_id": draft, "pwm_outcome": "attention"}),
            ("missing", "pwm", "pwm_research", {"draft_id": str(uuid.uuid4())}),
            ("other", "kai", "kai_analysis_completed", {}),
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

    # The expired checkout is history the Feed still shows; it stays.
    assert service.dismiss(OWNER, item_id=rows["expired_outcome"])["dismissed_ids"] == [
        str(rows["expired_outcome"])
    ]
    # A paid order's Pay row was hidden behind the outcome; it leaves with it.
    assert service.dismiss(OWNER, item_id=rows["paid_outcome"])["dismissed_ids"] == [
        str(rows["paid_pay"]),
        str(rows["paid_outcome"]),
    ]
    assert listed_ids(session(feed_db), OWNER) == [rows["expired_pay"]]


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

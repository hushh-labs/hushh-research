"""Real PostgreSQL row-version fences, owner isolation and strict read snapshots."""

from contextlib import contextmanager
from threading import Event, Thread

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import ProgrammingError

from hushh_mcp.services import consent_source_fence, one_location_agent_service
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url,  # noqa: F401
)


@pytest.fixture
def source_engine(connector_postgres_url):  # noqa: F811
    engine = create_engine(connector_postgres_url)
    with engine.begin() as c:
        c.execute(text("DROP TABLE IF EXISTS living_source_fixture"))
        c.execute(
            text(
                "CREATE TABLE living_source_fixture(id INT PRIMARY KEY, user_id TEXT, value TEXT, expires_at TIMESTAMPTZ)"
            )
        )
        c.execute(
            text(
                "INSERT INTO living_source_fixture SELECT n,CASE WHEN n<301 THEN 'owner' ELSE 'other' END,'unchanged',NULL FROM generate_series(1,310) n"
            )
        )
    yield engine
    with engine.begin() as c:
        c.execute(text("DROP TABLE living_source_fixture"))
    engine.dispose()


def token(engine, monkeypatch):
    monkeypatch.setattr(
        consent_source_fence,
        "_SOURCES",
        (("living_source_fixture", "r.user_id=:owner", "r.expires_at <= now()"),),
    )
    with engine.connect() as c:
        return consent_source_fence.capture_consent_source_fence(
            c, owner="owner", identifiers=["owner"], configuration={}
        )


def test_actual_postgres_fence_detects_aba_delete_and_isolates_other_owner(
    source_engine, monkeypatch
):
    start = token(source_engine, monkeypatch)
    with source_engine.begin() as c:
        c.execute(
            text("UPDATE living_source_fixture SET value='other change' WHERE user_id='other'")
        )
    assert token(source_engine, monkeypatch) == start
    with source_engine.begin() as c:
        c.execute(text("UPDATE living_source_fixture SET value='temporary' WHERE id=1"))
    with source_engine.begin() as c:
        c.execute(text("UPDATE living_source_fixture SET value='unchanged' WHERE id=1"))
    updated = token(source_engine, monkeypatch)
    assert updated != start
    with source_engine.begin() as c:
        c.execute(text("DELETE FROM living_source_fixture WHERE id=1"))
    with source_engine.begin() as c:
        c.execute(text("INSERT INTO living_source_fixture VALUES(1,'owner','unchanged',NULL)"))
    assert token(source_engine, monkeypatch) != updated


def test_effective_expiry_changes_fence_without_record_update(source_engine, monkeypatch):
    with source_engine.begin() as c:
        c.execute(
            text(
                "UPDATE living_source_fixture SET expires_at=clock_timestamp()+interval '0.4 second' WHERE id=1"
            )
        )
    before = token(source_engine, monkeypatch)
    with source_engine.connect() as c:
        c.execute(text("SELECT pg_sleep(0.5)"))
    assert token(source_engine, monkeypatch) != before


def test_location_source_batch_is_uncapped_consistent_and_fails_on_missing_section(
    source_engine, monkeypatch
):
    first_read = Event()
    written = Event()

    def mutate():
        assert first_read.wait(5)
        with source_engine.begin() as c:
            c.execute(text("DELETE FROM living_source_fixture WHERE id=150"))
        written.set()

    class Wrapped:
        def __init__(self, c):
            self.c = c

        def execute(self, statement, params=None):
            sql = str(statement)
            if "second" in sql:
                assert written.wait(5)
            result = self.c.execute(statement, params or {})
            if "first" in sql:
                first_read.set()
            return result

    @contextmanager
    def snapshot():
        with source_engine.begin() as c:
            yield Wrapped(c)

    monkeypatch.setattr(one_location_agent_service, "get_db_connection", snapshot)
    service = one_location_agent_service.OneLocationAgentService()
    writer = Thread(target=mutate)
    writer.start()
    query = (
        "SELECT id FROM living_source_fixture WHERE user_id=:owner ORDER BY id LIMIT :source_limit"
    )
    rows = service._run_read_queries_parallel(
        [
            ("first", query + " /* first */", {"owner": "owner", "source_limit": None}),
            ("second", query + " /* second */", {"owner": "owner", "source_limit": None}),
        ],
        require_complete=True,
    )
    writer.join(5)
    assert not writer.is_alive()
    assert len(rows["first"]) == 300 and rows["first"] == rows["second"]
    with pytest.raises(ProgrammingError):
        service._run_read_queries_parallel(
            [("broken", "SELECT * FROM missing_source_family", {})], require_complete=True
        )


# Production-shaped typed columns cover every authored UNION arm, including
# relationship-only sources. No runtime database or encrypted payload is used.
PRODUCTION_COLUMNS = {
    "consent_audit": "user_id TEXT,expires_at BIGINT,poll_timeout_at BIGINT",
    "one_information_request_bundles": "subject_user_id TEXT,requester_user_id TEXT,bundle_id UUID",
    "one_information_request_items": "bundle_id UUID",
    "drive_share_requests": "user_id TEXT,recipient_user_id TEXT,request_id UUID,expires_at TIMESTAMPTZ",
    "drive_share_management_contexts": "user_id TEXT,request_id UUID",
    "drive_share_permission_operations": "user_id TEXT,request_id UUID",
    "drive_live_query_requests": "user_id TEXT,requester_user_id TEXT,status TEXT,decided_at TIMESTAMPTZ,expires_at TIMESTAMPTZ",
    "one_location_share_grants": "owner_user_id TEXT,recipient_user_id TEXT,expires_at TIMESTAMPTZ",
    "one_location_access_requests": "id UUID,owner_user_id TEXT,requester_user_id TEXT,referred_by_user_id TEXT,requested_at TIMESTAMPTZ,expires_at TIMESTAMPTZ",
    "one_location_referrals": "owner_user_id TEXT,referring_user_id TEXT,referred_user_id TEXT,request_id UUID",
    "one_location_public_invite_submissions": "owner_user_id TEXT,matched_user_id TEXT,request_id UUID",
    "one_location_public_invites": "owner_user_id TEXT,expires_at TIMESTAMPTZ",
    "one_location_circle_invites": "owner_user_id TEXT,claimed_by_user_id TEXT,expires_at TIMESTAMPTZ",
    "one_location_circle_member_invites": "circle_id UUID,inviter_user_id TEXT,invitee_user_id TEXT,expires_at TIMESTAMPTZ",
    "one_location_circles": "id UUID,owner_user_id TEXT",
    "marketplace_access_requests": "owner_user_id TEXT,buyer_user_id TEXT",
    "pkm_answer_requests": "owner_user_id TEXT,requester_user_id TEXT,expires_at TIMESTAMPTZ,answer_deadline_at TIMESTAMPTZ",
    "pkm_answer_payment_orders": "owner_user_id TEXT,requester_user_id TEXT",
    "connections": "user_a_id TEXT,user_b_id TEXT",
    "connection_requests": "requester_user_id TEXT,addressee_user_id TEXT",
    "actor_verified_email_aliases": "user_id TEXT",
    "actor_identity_cache": "user_id TEXT",
}
LINK_ID = "00000000-0000-4000-8000-000000000001"


@pytest.fixture
def production_fence_engine(connector_postgres_url):  # noqa: F811
    import uuid

    schema = "fence_" + uuid.uuid4().hex
    admin = create_engine(connector_postgres_url)
    with admin.begin() as c:
        c.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(
        connector_postgres_url, connect_args={"options": f"-csearch_path={schema},public"}
    )
    with engine.begin() as c:
        assert set(PRODUCTION_COLUMNS) == {table for table, _, _ in consent_source_fence._SOURCES}
        for table, columns in PRODUCTION_COLUMNS.items():
            c.execute(text(f"CREATE TABLE {table}(fixture_id INT,{columns})"))
            names = [column.split()[0] for column in columns.split(",")]
            values = {}
            for name in names:
                values[name] = (
                    LINK_ID
                    if name in {"id", "bundle_id", "request_id", "circle_id"}
                    else "owner"
                    if name.endswith("user_id") or name in {"user_id", "user_a_id", "user_b_id"}
                    else None
                )
            fields = ",".join(values)
            bindings = ",".join(":" + name for name in values)
            c.execute(
                text(f"INSERT INTO {table}(fixture_id,{fields}) VALUES(1,{bindings})"), values
            )
    yield engine
    engine.dispose()
    with admin.begin() as c:
        c.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
    admin.dispose()


def production_token(engine, owner="owner"):
    with engine.connect() as c:
        return consent_source_fence.capture_consent_source_fence(
            c, owner=owner, identifiers=[owner], configuration={}
        )


@pytest.mark.parametrize("table", list(PRODUCTION_COLUMNS))
def test_every_production_fence_family_detects_own_change_and_isolates_other_owner(
    production_fence_engine, table
):
    own_before = production_token(production_fence_engine)
    other_before = production_token(production_fence_engine, "other")
    with production_fence_engine.begin() as c:
        c.execute(text(f"UPDATE {table} SET fixture_id=2 WHERE fixture_id=1"))
    assert production_token(production_fence_engine) != own_before
    assert production_token(production_fence_engine, "other") == other_before


@pytest.mark.parametrize("family", ["legacy_location", "stale_drive"])
def test_production_derived_deadline_fences_clock_transition(production_fence_engine, family):
    with production_fence_engine.begin() as c:
        if family == "legacy_location":
            c.execute(text("DELETE FROM one_location_referrals"))
            c.execute(text("DELETE FROM one_location_public_invite_submissions"))
            c.execute(
                text(
                    "UPDATE one_location_access_requests SET referred_by_user_id=NULL,requested_at=clock_timestamp()-interval '24 hour'+interval '0.6 second'"
                )
            )
        else:
            c.execute(
                text(
                    "UPDATE drive_live_query_requests SET status='running',expires_at=clock_timestamp()-interval '1 hour',decided_at=clock_timestamp()-interval '300 second'+interval '0.6 second'"
                )
            )
    before = production_token(production_fence_engine)
    with production_fence_engine.connect() as c:
        c.execute(text("SELECT pg_sleep(0.8)"))
    assert production_token(production_fence_engine) != before


PARTICIPANT_BRANCHES = [
    (table, column.split()[0])
    for table, columns in PRODUCTION_COLUMNS.items()
    for column in columns.split(",")
    if column.split()[0].endswith("user_id")
    or column.split()[0] in {"user_id", "user_a_id", "user_b_id"}
]
# referred_by_user_id is provenance, not a participant authority.
PARTICIPANT_BRANCHES = [pair for pair in PARTICIPANT_BRANCHES if pair[1] != "referred_by_user_id"]


def reset_participants(engine):
    with engine.begin() as c:
        for table, columns in PRODUCTION_COLUMNS.items():
            assignments = [
                column.split()[0] + "='unrelated'"
                for column in columns.split(",")
                if column.split()[0].endswith("user_id")
                or column.split()[0] in {"user_id", "user_a_id", "user_b_id"}
            ]
            if assignments:
                c.execute(text(f"UPDATE {table} SET " + ",".join(assignments)))


@pytest.mark.parametrize("table,field", PARTICIPANT_BRANCHES)
def test_production_fence_each_direct_participant_branch(
    production_fence_engine, monkeypatch, table, field
):
    reset_participants(production_fence_engine)
    arm = next(arm for arm in consent_source_fence._SOURCES if arm[0] == table)
    monkeypatch.setattr(consent_source_fence, "_SOURCES", (arm,))
    before = production_token(production_fence_engine)
    with production_fence_engine.begin() as c:
        c.execute(text(f"UPDATE {table} SET {field}='owner'"))
    assert production_token(production_fence_engine) != before


@pytest.mark.parametrize(
    "child,parent,field",
    [
        ("one_information_request_items", "one_information_request_bundles", "subject_user_id"),
        ("drive_share_permission_operations", "drive_share_requests", "recipient_user_id"),
        ("one_location_referrals", "one_location_access_requests", "requester_user_id"),
        (
            "one_location_public_invite_submissions",
            "one_location_access_requests",
            "requester_user_id",
        ),
        ("one_location_circle_member_invites", "one_location_circles", "owner_user_id"),
        ("one_location_circles", "one_location_circle_member_invites", "invitee_user_id"),
    ],
)
def test_production_fence_join_only_participant_branch(
    production_fence_engine, monkeypatch, child, parent, field
):
    reset_participants(production_fence_engine)
    arm = next(arm for arm in consent_source_fence._SOURCES if arm[0] == child)
    monkeypatch.setattr(consent_source_fence, "_SOURCES", (arm,))
    before = production_token(production_fence_engine)
    with production_fence_engine.begin() as c:
        c.execute(text(f"UPDATE {parent} SET {field}='owner'"))
    assert production_token(production_fence_engine) != before


def test_production_fence_verified_alias_and_configuration_are_fenced(production_fence_engine):
    reset_participants(production_fence_engine)
    before = production_token(production_fence_engine)
    with production_fence_engine.begin() as c:
        c.execute(text("UPDATE consent_audit SET user_id='verified-alias'"))
    assert production_token(production_fence_engine) == before
    with production_fence_engine.connect() as c:
        alias = consent_source_fence.capture_consent_source_fence(
            c, owner="owner", identifiers=["owner", "verified-alias"], configuration={}
        )
        changed = consent_source_fence.capture_consent_source_fence(
            c,
            owner="owner",
            identifiers=["owner", "verified-alias"],
            configuration={"projection": 2},
        )
    assert alias != before and changed != alias


def test_actual_circle_reader_retains_terminal_and_outgoing_invites_after_circle_closes(
    production_fence_engine,
):
    from types import SimpleNamespace

    from hushh_mcp.services.one_location_circle_service import OneLocationCircleService

    with production_fence_engine.begin() as c:
        c.execute(
            text("ALTER TABLE one_location_circles ADD name TEXT, ADD kind TEXT, ADD status TEXT")
        )
        c.execute(
            text(
                "ALTER TABLE one_location_circle_member_invites ADD id UUID, ADD status TEXT, ADD created_at TIMESTAMPTZ, ADD responded_at TIMESTAMPTZ"
            )
        )
        c.execute(
            text("UPDATE one_location_circles SET status='deleted',name='Fixture',kind='other'")
        )
        c.execute(
            text(
                "UPDATE one_location_circle_member_invites SET id=:id,status='declined',invitee_user_id='peer',inviter_user_id='owner',expires_at=now()-interval '1 day'"
            ),
            {"id": LINK_ID},
        )

    class Database:
        def execute_raw(self, sql, params):
            assert "UPDATE" not in sql
            with production_fence_engine.connect() as c:
                return SimpleNamespace(
                    data=[dict(row) for row in c.execute(text(sql), params).mappings().all()]
                )

    service = OneLocationCircleService.__new__(OneLocationCircleService)
    service._db = Database()
    rows = service.list_member_invites(user_id="owner", require_complete=True)
    assert (
        len(rows) == 1 and rows[0]["status"] == "declined" and rows[0]["inviterUserId"] == "owner"
    )
    assert service.list_member_invites(user_id="other", require_complete=True) == []
    with production_fence_engine.begin() as c:
        c.execute(text("UPDATE one_location_circle_member_invites SET status='pending'"))
    assert (
        service.list_member_invites(user_id="owner", require_complete=True)[0]["status"]
        == "expired"
    )
    with production_fence_engine.connect() as c:
        assert (
            c.execute(text("SELECT status FROM one_location_circle_member_invites")).scalar_one()
            == "pending"
        )

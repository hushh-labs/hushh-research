"""Real transactional connection activation, sealed-snapshot release and erasure."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from sqlalchemy import text
from test_finance_sharing_postgres import envelope, finance_db, projection_db  # noqa: F401

from hushh_mcp.services.advisor_review_contract import CreateAdvisorReview
from hushh_mcp.services.advisor_review_service import AdvisorReviewService
from hushh_mcp.services.advisor_review_store import AdvisorReviewError


@pytest.fixture
def advisor_db(finance_db, monkeypatch):  # noqa: F811
    db, _ = finance_db
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentService
    from hushh_mcp.services.ria_iam_service import _IAM_REQUIRED_TABLES

    monkeypatch.setattr(OneLocationAgentService, "is_directory_candidate", lambda *a, **k: True)
    with db.engine.begin() as conn:
        for table in _IAM_REQUIRED_TABLES:
            if table not in {"actor_profiles", "ria_profiles", "connection_scope_proposals"}:
                conn.execute(text(f'CREATE TABLE IF NOT EXISTS "{table}" (id text)'))
        conn.execute(
            text("""CREATE TABLE ria_profiles(user_id text PRIMARY KEY,verification_status text,advisory_status text);
            INSERT INTO ria_profiles VALUES('bob','verified',NULL);
            ALTER TABLE connections ADD COLUMN source text DEFAULT 'request',ADD COLUMN created_at timestamptz DEFAULT now(),
              ADD COLUMN updated_at timestamptz DEFAULT now(),ADD COLUMN revoked_at timestamptz;
            UPDATE connections SET status='revoked' WHERE user_a_id='alice' AND user_b_id='bob';
            CREATE TABLE one_location_circles(id uuid PRIMARY KEY,name text);
            CREATE TABLE connection_origins(id uuid DEFAULT gen_random_uuid(),connection_id uuid,origin_kind text,origin_key text,
              source_circle_id uuid,source_ref text,status text,created_at timestamptz,updated_at timestamptz,revoked_at timestamptz,
              metadata jsonb,UNIQUE(connection_id,origin_key));
            CREATE TABLE connection_requests(id uuid PRIMARY KEY,status text,requester_user_id text,addressee_user_id text,
              responded_at timestamptz,updated_at timestamptz,metadata jsonb);
            CREATE TABLE connection_scope_proposals(id uuid PRIMARY KEY,connection_request_id uuid,status text,expires_at timestamptz,resolved_at timestamptz);
            CREATE TABLE connection_scope_proposal_events(id uuid DEFAULT gen_random_uuid(),connection_scope_proposal_id uuid,event_type text,actor_user_id text,reason text);
            CREATE TABLE trusted_connections(id uuid DEFAULT gen_random_uuid(),owner_user_id text,trusted_user_id text,
              status text,source text,created_at timestamptz,updated_at timestamptz,revoked_at timestamptz,
              UNIQUE(owner_user_id,trusted_user_id));
        """)
        )
    db.apply_migrations(["447_finance_advisor_handshake.sql"])
    db.apply_migrations(["447_finance_advisor_handshake.sql"])
    with db.engine.connect() as conn:
        ref = conn.execute(
            text("SELECT public_person_ref FROM actor_profiles WHERE user_id='bob'")
        ).scalar_one()
    approved = CreateAdvisorReview.model_validate(
        {
            "requestId": str(uuid.uuid4()),
            "advisorPersonRef": str(ref),
            "envelope": envelope("bob-key"),
            "ownerEnvelope": envelope("alice-key"),
            "contentHash": "a" * 64,
            "approval": "connect_and_share_finance_snapshot_v1",
            "durationSeconds": 604800,
        }
    )
    return db, AdvisorReviewService(db), approved


def test_pending_snapshot_is_unreadable_to_advisor_and_every_third_party(advisor_db):
    db, service, approved = advisor_db
    created = service.create("alice", approved)
    assert service.create("alice", approved)["id"] == created["id"]
    assert "envelope" not in service.view("bob", created["id"])
    assert "envelope" in service.view("alice", created["id"])
    with pytest.raises(AdvisorReviewError, match="NOT_FOUND"):
        service.view("carol", created["id"])
    with pytest.raises(AdvisorReviewError, match="WRONG_PARTICIPANT"):
        service.decide("alice", created["id"], "accept")
    with db.engine.connect() as conn:
        assert (
            conn.execute(
                text(
                    "SELECT count(*) FROM connections WHERE status='active' AND user_a_id='alice' AND user_b_id='bob'"
                )
            ).scalar_one()
            == 0
        )


def test_connection_and_snapshot_acceptance_roll_back_together(advisor_db, monkeypatch):
    db, service, approved = advisor_db
    created = service.create("alice", approved)
    import hushh_mcp.services.advisor_review_service as module

    original = module._message
    monkeypatch.setattr(
        module, "_message", lambda *a: (_ for _ in ()).throw(RuntimeError("delivery failed"))
    )
    with pytest.raises(RuntimeError, match="delivery failed"):
        service.decide("bob", created["id"], "accept")
    assert service.view("bob", created["id"])["status"] == "pending"
    with db.engine.connect() as conn:
        assert (
            conn.execute(
                text("SELECT count(*) FROM connection_origins WHERE status='active'")
            ).scalar_one()
            == 0
        )
    monkeypatch.setattr(module, "_message", original)
    service.decide("bob", created["id"], "accept")
    service.decide("bob", created["id"], "accept")
    assert service.view("bob", created["id"])["envelope"]["recipientKeyId"] == "bob-key"
    with db.engine.connect() as conn:
        assert (
            conn.execute(
                text("SELECT count(*) FROM trusted_connections WHERE status='active'")
            ).scalar_one()
            == 2
        )
        assert conn.execute(text("SELECT count(*) FROM messages")).scalar_one() == 1
        assert (
            conn.execute(
                text(
                    "SELECT count(*) FROM connections WHERE status='active' AND user_a_id='alice' AND user_b_id='bob'"
                )
            ).scalar_one()
            == 1
        )


def test_accept_withdraw_race_has_one_terminal_outcome(advisor_db):
    db, service, approved = advisor_db
    created = service.create("alice", approved)
    barrier = Barrier(2)

    def decide(actor, action):
        barrier.wait(timeout=10)
        try:
            return service.decide(actor, created["id"], action)["status"]
        except AdvisorReviewError:
            return "conflict"

    with ThreadPoolExecutor(max_workers=2) as pool:
        accept = pool.submit(decide, "bob", "accept")
        withdraw = pool.submit(decide, "alice", "withdraw")
        results = [accept.result(timeout=20), withdraw.result(timeout=20)]
    assert sorted(results) in (["accepted", "conflict"], ["conflict", "withdrawn"])
    value = service.view("bob", created["id"])
    assert ("envelope" in value) == (value["status"] == "accepted")


def test_erasure_queues_provider_cleanup_without_retaining_identity(advisor_db):
    db, service, approved = advisor_db
    created = service.create("alice", approved)
    with db.engine.begin() as conn:
        conn.execute(
            text("""INSERT INTO advisor_review_subscriptions
            (request_id,stripe_mode,payee_account,plan_revision,plan_hash,checkout_session_id,subscription_id)
            VALUES(CAST(:id AS uuid),'test','acct_synthetic',1,:hash,'cs_test_synthetic','sub_synthetic')"""),
            {"id": created["id"], "hash": "a" * 64},
        )
        conn.execute(
            text("DELETE FROM advisor_review_requests WHERE id=CAST(:id AS uuid)"),
            {"id": created["id"]},
        )
    with db.engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT resource_id,resource_kind FROM advisor_billing_cleanup ORDER BY resource_id"
            )
        ).all()
        assert rows == [("cs_test_synthetic", "checkout"), ("sub_synthetic", "subscription")]


def test_disconnect_reconnect_cannot_restore_snapshot_and_owner_erasure_removes_request(advisor_db):
    db, service, approved = advisor_db
    created = service.create("alice", approved)
    service.decide("bob", created["id"], "accept")
    with db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE connections SET status='revoked' WHERE user_a_id='alice' AND user_b_id='bob'"
            )
        )
        conn.execute(
            text(
                "UPDATE connections SET status='active' WHERE user_a_id='alice' AND user_b_id='bob'"
            )
        )
    assert "envelope" not in service.view("bob", created["id"])
    assert service.view("bob", created["id"])["status"] == "stopped"
    with db.engine.begin() as conn:
        conn.execute(text("DELETE FROM advisor_review_requests WHERE owner_user_id='alice'"))
    with pytest.raises(AdvisorReviewError, match="NOT_FOUND"):
        service.view("bob", created["id"])

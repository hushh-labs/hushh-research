"""Real transactional connection activation, sealed-snapshot release and erasure."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy import text
from test_finance_sharing_postgres import envelope, finance_db, projection_db  # noqa: F401

from hushh_mcp.services.advisor_review_billing import AdvisorBillingService
from hushh_mcp.services.advisor_review_contract import (
    AdvisorPlan,
    CreateAdvisorReview,
    PlanCheckout,
)
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
    db.apply_migrations(["456_finance_advisor_one_time_payment.sql"])
    db.apply_migrations(["456_finance_advisor_one_time_payment.sql"])
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


def test_connected_acceptance_reuses_edge_and_requires_the_displayed_connection(advisor_db):
    db, service, approved = advisor_db
    created = service.create("alice", approved)
    key = created["id"]
    assert "alreadyConnected" not in service.view("bob", key)
    assert service.view("bob", key, current_ui=True)["alreadyConnected"] is False
    with pytest.raises(AdvisorReviewError, match="REQUEST_CHANGED"):
        service.decide("bob", key, "accept", require_existing_connection=True)
    assert "envelope" not in service.view("bob", key)
    with db.engine.begin() as conn:
        edge = conn.execute(
            text(
                "UPDATE connections SET status='active' WHERE user_a_id='alice' AND user_b_id='bob' RETURNING id"
            )
        ).scalar_one()
    pending = service.view("bob", key, current_ui=True)
    assert pending["alreadyConnected"] is True
    assert "envelope" not in pending
    service.decide("bob", key, "accept", require_existing_connection=True)
    assert service.view("bob", key)["envelope"]["recipientKeyId"] == "bob-key"
    with db.engine.connect() as conn:
        assert (
            conn.execute(text("SELECT connection_id FROM advisor_review_requests")).scalar_one()
            == edge
        )
        assert conn.execute(text("SELECT count(*) FROM connection_origins")).scalar_one() == 0


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
            text("""INSERT INTO advisor_review_payments
            (request_id,plan_revision,plan_hash,amount_cents,payee_account,checkout_session_id,status)
            VALUES(CAST(:id AS uuid),2,:hash,2500,'acct_synthetic','cs_test_one_time','checkout_pending')"""),
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
        assert rows == [
            ("cs_test_one_time", "checkout"),
            ("cs_test_synthetic", "checkout"),
            ("sub_synthetic", "subscription"),
        ]
        assert conn.execute(text("SELECT count(*) FROM advisor_review_payments")).scalar_one() == 0


def test_one_time_checkout_reuses_open_session_and_preserves_prior_payment(advisor_db, monkeypatch):
    db, service, approved = advisor_db
    request_id = service.create("alice", approved)["id"]
    service.decide("bob", request_id, "accept")
    monkeypatch.setenv("RIA_STRIPE_TEST_SECRET_KEY", "sk_test_" + "a" * 30)
    monkeypatch.setenv("RIA_STRIPE_TEST_WEBHOOK_SECRET", "whsec_" + "b" * 30)
    monkeypatch.setattr(
        "hushh_mcp.services.advisor_payment_checkout._app_origin",
        lambda: "https://uat.example.test",
    )
    with db.engine.begin() as conn:
        conn.execute(
            text("""CREATE TABLE stripe_owner_payout_accounts (
            user_id text, stripe_mode text, stripe_account_id text,
            details_submitted boolean, payouts_enabled boolean
        );
        INSERT INTO stripe_owner_payout_accounts VALUES ('bob','test','acct_advisor',true,true);
        """)
        )
    session = {
        "id": "cs_test_advisor",
        "livemode": False,
        "client_reference_id": request_id,
        "mode": "payment",
        "currency": "usd",
        "amount_total": 2500,
        "status": "open",
        "url": "https://checkout.stripe.com/test",
    }

    def create_session(**kwargs):
        session["metadata"] = kwargs["metadata"]
        return dict(session)

    create = Mock(side_effect=create_session)
    provider = SimpleNamespace(
        Account=SimpleNamespace(
            retrieve=Mock(
                return_value={
                    "id": "acct_advisor",
                    "details_submitted": True,
                    "payouts_enabled": True,
                    "capabilities": {"transfers": "active"},
                }
            )
        ),
        checkout=SimpleNamespace(
            Session=SimpleNamespace(
                create=create,
                retrieve=lambda *_args, **_kwargs: dict(session),
            )
        ),
    )
    billing = AdvisorBillingService(db, provider)
    plan = AdvisorPlan(
        amountCents=2500,
        interval="one_time",
        services="One portfolio review and a follow-up call.",
        cancellationTerms="Cancel before the advisor starts work.",
    )
    billing.offer("bob", request_id, plan)
    consent = PlanCheckout(planRevision=1, acceptPayment=True)
    first = billing.checkout("alice", request_id, consent)
    assert billing.checkout("alice", request_id, consent) == first
    create.assert_called_once()
    with pytest.raises(AdvisorReviewError, match="BILLING_IN_PROGRESS"):
        billing.offer("bob", request_id, plan)
    session.update(
        status="complete",
        payment_status="paid",
        payment_intent={
            "id": "pi_advisor",
            "livemode": False,
            "status": "succeeded",
            "currency": "usd",
            "amount_received": 2500,
            "transfer_data": {"destination": "acct_advisor"},
            "metadata": session["metadata"],
            "latest_charge": {
                "payment_intent": "pi_advisor",
                "livemode": False,
                "paid": True,
                "captured": True,
                "currency": "usd",
                "amount_captured": 2500,
                "amount_refunded": 0,
                "created": 1760000000,
            },
        },
    )
    assert billing.reconcile("alice", request_id)["status"] == "paid"
    with pytest.raises(AdvisorReviewError, match="ALREADY_PAID"):
        billing.checkout("alice", request_id, consent)
    billing.offer("bob", request_id, plan.model_copy(update={"amountCents": 3500}))
    assert billing.reconcile("alice", request_id) == {
        "mode": "test",
        "status": "not_started",
        "planRevision": 2,
        "lastPayment": {
            "amountCents": 2500,
            "paidAt": "2025-10-09T08:53:20+00:00",
            "status": "paid",
        },
    }
    with db.engine.connect() as conn:
        rows = conn.execute(
            text("SELECT plan_revision,amount_cents,status FROM advisor_review_payments")
        ).all()
        assert rows == [(1, 2500, "paid")]


def test_advisor_can_stop_an_accepted_review_but_not_withdraw_a_pending_one(advisor_db):
    _db, service, approved = advisor_db
    created = service.create("alice", approved)
    with pytest.raises(AdvisorReviewError, match="ADVISOR_WRONG_PARTICIPANT"):
        service.decide("bob", created["id"], "withdraw")
    service.decide("bob", created["id"], "accept")
    assert service.decide("bob", created["id"], "stop")["status"] == "stopped"
    assert "envelope" not in service.view("bob", created["id"])
    assert service.view("alice", created["id"])["status"] == "stopped"


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

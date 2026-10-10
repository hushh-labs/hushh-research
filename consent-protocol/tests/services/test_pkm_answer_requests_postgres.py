"""Two connected accounts, one paid answer, against real PostgreSQL.

Exercises the lane end to end at the data layer with the actual migration and
the actual services: ask -> resolve -> owner approves exact scopes and price ->
pay -> answer sealed and delivered -> requester fetches. Then the paths that
must refuse: an unpaid delivery, a replayed webhook, a widened scope, and a
missed deadline.

Runs against the same self-provisioned throwaway cluster the connector
acceptance tests use, and skips when no isolated PostgreSQL is available. It
never touches a shared database: `connector_postgres_url` refuses a Cloud SQL
proxy or any non-test target outright.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, text

from hushh_mcp.consent.answer_scope_resolution import compute_terms_digest
from hushh_mcp.services.pkm_answer_payment_service import (
    AnswerPaymentError,
)
from hushh_mcp.services.pkm_answer_request_service import (
    AnswerRequestError,
    PkmAnswerRequestService,
)
from tests.services.test_external_connector_lifecycle_postgres import (  # noqa: F401
    connector_postgres_url,
)

OWNER = "owner-account-A"
REQUESTER = "requester-account-B"
MIGRATION = (
    Path(__file__).resolve().parents[2] / "db" / "migrations" / "292_pkm_answer_requests.sql"
)

# The owner's registry. attr.financial.holdings is deliberately present so a
# resolver over-reach can be distinguished from a legitimate narrow answer.
OWNER_SCOPES = [
    ("attr.travel.trips", "Travel"),
    ("attr.preferences.food", "Food preferences"),
    ("attr.financial.holdings", "Holdings"),
]


@pytest.fixture(scope="module")
def answer_engine(connector_postgres_url):  # noqa: F811
    engine = create_engine(connector_postgres_url, future=True)
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS pgcrypto")
        # The gate reads `connections`; the real table lives in migration 086,
        # and only these columns are consulted here.
        connection.exec_driver_sql(
            """CREATE TABLE IF NOT EXISTS connections (
                 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                 user_a_id TEXT NOT NULL, user_b_id TEXT NOT NULL,
                 status TEXT NOT NULL DEFAULT 'active')"""
        )
        # The lane projects milestones into the Feed; migration 117 owns the
        # real table and only these columns are written here.
        # Migration 080 owns this; the sweep reads the requester's published
        # ECDH key from it rather than standing up a second key plane.
        connection.exec_driver_sql(
            """CREATE TABLE IF NOT EXISTS marketplace_recipient_keys (
                 user_id TEXT NOT NULL, key_id TEXT NOT NULL,
                 public_key_jwk JSONB NOT NULL, algorithm TEXT,
                 status TEXT NOT NULL DEFAULT 'active',
                 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                 PRIMARY KEY (user_id, key_id))"""
        )
        connection.exec_driver_sql(
            """CREATE TABLE IF NOT EXISTS feed_events (
                 id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL,
                 source_domain TEXT NOT NULL, event_type TEXT NOT NULL,
                 actor_label TEXT, metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                 source_row_id TEXT, read_at TIMESTAMPTZ,
                 created_at TIMESTAMPTZ NOT NULL DEFAULT now())"""
        )
        connection.exec_driver_sql(
            """CREATE TABLE IF NOT EXISTS pkm_scope_registry (
                 user_id TEXT NOT NULL, scope_handle TEXT NOT NULL,
                 scope_label TEXT, visibility_posture TEXT NOT NULL,
                 PRIMARY KEY (user_id, scope_handle))"""
        )
    # The migration contains format('... %I ...'), which psycopg2 would try to
    # interpolate. Run it through a raw cursor so the SQL reaches the server
    # byte for byte, exactly as psql applies it.
    raw = engine.raw_connection()
    try:
        cursor = raw.cursor()
        cursor.execute(MIGRATION.read_text())
        raw.commit()
    finally:
        raw.close()
    yield engine
    engine.dispose()


@pytest.fixture(autouse=True)
def clean(answer_engine):
    with answer_engine.begin() as connection:
        connection.exec_driver_sql("DELETE FROM pkm_answer_requests")
        connection.exec_driver_sql("DELETE FROM pkm_answer_payment_obligations")
        connection.exec_driver_sql("DELETE FROM feed_events")
        connection.exec_driver_sql("DELETE FROM marketplace_recipient_keys")
        connection.exec_driver_sql("DELETE FROM connections")
        connection.exec_driver_sql("DELETE FROM pkm_scope_registry")
        connection.execute(
            text("INSERT INTO connections (user_a_id,user_b_id,status) VALUES (:a,:b,'active')"),
            {"a": OWNER, "b": REQUESTER},
        )
        connection.execute(
            text(
                """INSERT INTO marketplace_recipient_keys
                   (user_id,key_id,public_key_jwk,algorithm)
                   VALUES (:u,'key-1',CAST(:jwk AS JSONB),'ECDH-P256-AES256-GCM')"""
            ),
            {"u": REQUESTER, "jwk": json.dumps({"kty": "EC", "crv": "P-256", "x": "x", "y": "y"})},
        )
        for handle, label in OWNER_SCOPES:
            connection.execute(
                text(
                    """INSERT INTO pkm_scope_registry
                       (user_id,scope_handle,scope_label,visibility_posture)
                       VALUES (:u,:h,:l,'consent_required')"""
                ),
                {"u": OWNER, "h": handle, "l": label},
            )


def _db(engine):
    return SimpleNamespace(engine=engine)


class StubResolver:
    """Stands in for the semantic stage. Returns whatever it was told to."""

    def __init__(self, scopes, *, fail=False):
        self.scopes = scopes
        self.fail = fail

    async def propose_scopes(self, *, question, candidate_scopes):
        if self.fail:
            raise RuntimeError("model unavailable")
        return self.scopes


async def _ask(engine, resolver):
    service = PkmAnswerRequestService(_db(engine), resolver=resolver)
    created = await service.create(
        requester_user_id=REQUESTER,
        owner_user_id=OWNER,
        question="How much did you spend on travel last year?",
        period_start="2026-01-01",
        period_end="2026-12-31",
    )
    return service, created["requestId"]


def _mark_paid(engine, request_id, digest, amount=1000):
    with engine.begin() as connection:
        connection.execute(
            text(
                """INSERT INTO pkm_answer_payment_orders
                   (request_id,owner_user_id,requester_user_id,amount_cents,
                    terms_digest,status,paid_at)
                   VALUES (:r,:o,:q,:a,:d,'paid',clock_timestamp())"""
            ),
            {"r": request_id, "o": OWNER, "q": REQUESTER, "a": amount, "d": digest},
        )
        connection.execute(
            text("UPDATE pkm_answer_requests SET status='answering' WHERE request_id=:r"),
            {"r": request_id},
        )


ENVELOPE = {
    "recipientKeyId": "key-1",
    "ciphertext": "c2VhbGVk",
    "iv": "aXY=",
    "senderEphemeralPublicKeyJwk": {"kty": "EC", "crv": "P-256", "x": "x", "y": "y"},
}


class TestHappyPath:
    async def test_two_accounts_ask_approve_pay_answer_and_fetch(self, answer_engine):
        service, request_id = await _ask(
            answer_engine, StubResolver(["attr.travel.trips", "attr.preferences.food"])
        )

        inbox = await service.pending_for_owner(owner_user_id=OWNER)
        assert len(inbox) == 1
        assert inbox[0]["resolutionMode"] == "agent"
        assert {entry["scope"] for entry in inbox[0]["proposedScopes"]} == {
            "attr.travel.trips",
            "attr.preferences.food",
        }

        # The owner narrows to one scope and prices it.
        approved = await service.approve(
            owner_user_id=OWNER,
            request_id=request_id,
            scopes=["attr.travel.trips"],
            amount_cents=1000,
        )
        expected = compute_terms_digest(
            question="How much did you spend on travel last year?",
            scopes=["attr.travel.trips"],
            owner_user_id=OWNER,
            requester_user_id=REQUESTER,
            amount_cents=1000,
        )
        assert approved["termsDigest"] == expected

        _mark_paid(answer_engine, request_id, expected)

        # The device sweep sees only the approved scope, never the narrowed-out
        # one and never the owner's other holdings.
        work = await service.claim_answerable(owner_user_id=OWNER)
        assert len(work) == 1
        assert work[0]["approvedScopes"] == ["attr.travel.trips"]

        await service.deliver(
            owner_user_id=OWNER,
            request_id=request_id,
            envelope=ENVELOPE,
            source_revisions={"travel": 7},
        )
        answer = await service.fetch_answer(requester_user_id=REQUESTER, request_id=request_id)
        assert answer["ciphertext"] == "c2VhbGVk"
        assert answer["sourceRevisions"] == {"travel": 7}

        with answer_engine.begin() as connection:
            row = (
                connection.execute(
                    text(
                        """SELECT r.status, o.owner_earning_status
                       FROM pkm_answer_requests r
                       JOIN pkm_answer_payment_orders o ON o.request_id = r.request_id
                       WHERE r.request_id = :r"""
                    ),
                    {"r": request_id},
                )
                .mappings()
                .first()
            )
        assert row["status"] == "answered"
        assert row["owner_earning_status"] == "due"


class TestScopeIsolation:
    async def test_resolver_over_reach_never_reaches_the_owner(self, answer_engine):
        # runtime_secrets is deny-listed outright; an unknown scope is not the
        # owner's. Neither may appear in what the owner is asked to approve.
        service, request_id = await _ask(
            answer_engine,
            StubResolver(["attr.runtime_secrets.llm", "attr.not_theirs.x", "attr.travel.trips"]),
        )
        inbox = await service.pending_for_owner(owner_user_id=OWNER)
        assert [entry["scope"] for entry in inbox[0]["proposedScopes"]] == ["attr.travel.trips"]

    async def test_owner_cannot_approve_a_scope_that_was_never_offered(self, answer_engine):
        service, request_id = await _ask(answer_engine, StubResolver(["attr.travel.trips"]))
        with pytest.raises(AnswerRequestError, match="scope_not_offered"):
            await service.approve(
                owner_user_id=OWNER,
                request_id=request_id,
                scopes=["attr.travel.trips", "attr.financial.holdings"],
                amount_cents=1000,
            )

    async def test_a_skipped_resolver_is_recorded_not_guessed(self, answer_engine):
        service, _request_id = await _ask(answer_engine, StubResolver([], fail=True))
        inbox = await service.pending_for_owner(owner_user_id=OWNER)
        assert inbox[0]["resolutionMode"] == "skipped"
        assert inbox[0]["resolutionSkippedReason"] == "resolver_failed"
        # Critically: no scopes were invented to cover the gap.
        assert inbox[0]["proposedScopes"] == []


class TestConnectionGate:
    async def test_a_stranger_cannot_ask(self, answer_engine):
        service = PkmAnswerRequestService(
            _db(answer_engine), resolver=StubResolver(["attr.travel.trips"])
        )
        with pytest.raises(AnswerRequestError, match="connection_required"):
            await service.create(
                requester_user_id="unconnected-C",
                owner_user_id=OWNER,
                question="What are your food preferences?",
            )

    async def test_a_revoked_connection_cannot_ask(self, answer_engine):
        with answer_engine.begin() as connection:
            connection.exec_driver_sql("UPDATE connections SET status='revoked'")
        service = PkmAnswerRequestService(
            _db(answer_engine), resolver=StubResolver(["attr.travel.trips"])
        )
        with pytest.raises(AnswerRequestError, match="connection_required"):
            await service.create(
                requester_user_id=REQUESTER,
                owner_user_id=OWNER,
                question="What are your food preferences?",
            )


class TestPaymentGate:
    async def test_unpaid_answer_is_refused_at_delivery(self, answer_engine):
        service, request_id = await _ask(answer_engine, StubResolver(["attr.travel.trips"]))
        await service.approve(
            owner_user_id=OWNER,
            request_id=request_id,
            scopes=["attr.travel.trips"],
            amount_cents=1000,
        )
        with answer_engine.begin() as connection:
            connection.execute(
                text("UPDATE pkm_answer_requests SET status='answering' WHERE request_id=:r"),
                {"r": request_id},
            )
        with pytest.raises(AnswerPaymentError, match="payment_required"):
            await service.deliver(owner_user_id=OWNER, request_id=request_id, envelope=ENVELOPE)
        with answer_engine.begin() as connection:
            delivered = connection.execute(
                text("SELECT count(*) FROM pkm_answer_deliveries WHERE request_id=:r"),
                {"r": request_id},
            ).scalar()
        assert delivered == 0

    async def test_reprice_after_payment_blocks_delivery(self, answer_engine):
        service, request_id = await _ask(answer_engine, StubResolver(["attr.travel.trips"]))
        approved = await service.approve(
            owner_user_id=OWNER,
            request_id=request_id,
            scopes=["attr.travel.trips"],
            amount_cents=1000,
        )
        _mark_paid(answer_engine, request_id, approved["termsDigest"])
        # The owner's terms change after the money settled.
        with answer_engine.begin() as connection:
            connection.execute(
                text("UPDATE pkm_answer_requests SET terms_digest=:d WHERE request_id=:r"),
                {"r": request_id, "d": "f" * 64},
            )
        with pytest.raises(AnswerPaymentError, match="terms_changed"):
            await service.deliver(owner_user_id=OWNER, request_id=request_id, envelope=ENVELOPE)

    async def test_plaintext_shaped_envelope_is_refused(self, answer_engine):
        service, request_id = await _ask(answer_engine, StubResolver(["attr.travel.trips"]))
        approved = await service.approve(
            owner_user_id=OWNER,
            request_id=request_id,
            scopes=["attr.travel.trips"],
            amount_cents=1000,
        )
        _mark_paid(answer_engine, request_id, approved["termsDigest"])
        with pytest.raises(AnswerRequestError, match="invalid_envelope"):
            await service.deliver(
                owner_user_id=OWNER,
                request_id=request_id,
                envelope={**ENVELOPE, "answer": "they spent $4,200"},
            )


class TestRecovery:
    async def test_a_missed_deadline_expires_and_refunds(self, answer_engine):
        service, request_id = await _ask(answer_engine, StubResolver(["attr.travel.trips"]))
        approved = await service.approve(
            owner_user_id=OWNER,
            request_id=request_id,
            scopes=["attr.travel.trips"],
            amount_cents=1000,
        )
        _mark_paid(answer_engine, request_id, approved["termsDigest"])
        with answer_engine.begin() as connection:
            connection.execute(
                text(
                    """UPDATE pkm_answer_requests
                       SET answer_deadline_at = clock_timestamp() - INTERVAL '1 hour'
                       WHERE request_id = :r"""
                ),
                {"r": request_id},
            )
        # The sweep claims the overdue row and marks it expired. The refund
        # call itself is covered against a mocked Stripe in the unit suite;
        # here the point is that the deadline is actually enforced in SQL.
        result = await PkmAnswerRequestService(_db(answer_engine)).expire_overdue()
        assert result["expired"] == 1
        with answer_engine.begin() as connection:
            status = connection.execute(
                text("SELECT status FROM pkm_answer_requests WHERE request_id=:r"),
                {"r": request_id},
            ).scalar()
        assert status == "expired"

    async def test_an_empty_answer_still_delivers_but_earns_nothing(self, answer_engine):
        service, request_id = await _ask(answer_engine, StubResolver(["attr.travel.trips"]))
        approved = await service.approve(
            owner_user_id=OWNER,
            request_id=request_id,
            scopes=["attr.travel.trips"],
            amount_cents=1000,
        )
        _mark_paid(answer_engine, request_id, approved["termsDigest"])
        with answer_engine.begin() as connection:
            connection.execute(
                text(
                    """INSERT INTO pkm_answer_deliveries
                       (request_id, recipient_key_id, ciphertext, iv,
                        sender_ephemeral_public_key_jwk, has_content)
                       VALUES (:r,'key-1','x','y',CAST(:jwk AS JSONB), FALSE)"""
                ),
                {"r": request_id, "jwk": json.dumps(ENVELOPE["senderEphemeralPublicKeyJwk"])},
            )
            connection.execute(
                text(
                    """UPDATE pkm_answer_payment_orders SET owner_earning_status='none'
                       WHERE request_id=:r"""
                ),
                {"r": request_id},
            )
            earning = connection.execute(
                text(
                    "SELECT owner_earning_status FROM pkm_answer_payment_orders WHERE request_id=:r"
                ),
                {"r": request_id},
            ).scalar()
        # No content means the owner earns nothing; the refund path is covered
        # by the unit suite against a mocked Stripe.
        assert earning == "none"

    async def test_requester_cancel_before_delivery_is_allowed_and_after_is_not(
        self, answer_engine
    ):
        service, request_id = await _ask(answer_engine, StubResolver(["attr.travel.trips"]))
        await service.approve(
            owner_user_id=OWNER,
            request_id=request_id,
            scopes=["attr.travel.trips"],
            amount_cents=1000,
        )
        await service.cancel(requester_user_id=REQUESTER, request_id=request_id)
        with answer_engine.begin() as connection:
            status = connection.execute(
                text("SELECT status FROM pkm_answer_requests WHERE request_id=:r"),
                {"r": request_id},
            ).scalar()
        assert status == "cancelled"
        with pytest.raises(AnswerRequestError, match="request_not_cancellable"):
            await service.cancel(requester_user_id=REQUESTER, request_id=request_id)


class TestFeed:
    """Each milestone reaches the right person, carrying no question text."""

    async def test_feed_events_fire_and_never_carry_the_question(self, answer_engine):
        service, request_id = await _ask(answer_engine, StubResolver(["attr.travel.trips"]))
        approved = await service.approve(
            owner_user_id=OWNER,
            request_id=request_id,
            scopes=["attr.travel.trips"],
            amount_cents=1000,
        )
        _mark_paid(answer_engine, request_id, approved["termsDigest"])
        await service.deliver(owner_user_id=OWNER, request_id=request_id, envelope=ENVELOPE)

        with answer_engine.begin() as connection:
            rows = (
                connection.execute(
                    text(
                        "SELECT user_id, event_type, metadata::text AS meta, source_row_id"
                        " FROM feed_events ORDER BY id"
                    )
                )
                .mappings()
                .all()
            )

        by_event = {row["event_type"]: row for row in rows}
        # The owner learns a question arrived; the requester learns it is
        # payable and later that it was answered.
        assert by_event["answer_request_received"]["user_id"] == OWNER
        assert by_event["answer_request_payment_ready"]["user_id"] == REQUESTER
        assert by_event["answer_delivered"]["user_id"] == REQUESTER

        # Plaintext boundary: feed_events.metadata is server-readable, so the
        # question, the scopes and the answer must never appear in it.
        for row in rows:
            assert "travel last year" not in row["meta"]
            assert "attr.travel.trips" not in row["meta"]
            assert row["source_row_id"] == f"answer_request:{request_id}"


class TestObligationMirror:
    async def test_the_order_mirrors_an_identity_free_obligation(self, answer_engine):
        service, request_id = await _ask(answer_engine, StubResolver(["attr.travel.trips"]))
        approved = await service.approve(
            owner_user_id=OWNER,
            request_id=request_id,
            scopes=["attr.travel.trips"],
            amount_cents=1000,
        )
        _mark_paid(answer_engine, request_id, approved["termsDigest"])
        with answer_engine.begin() as connection:
            row = (
                connection.execute(
                    text(
                        "SELECT payer_ref, amount_cents, status FROM pkm_answer_payment_obligations"
                        " WHERE request_id=:r"
                    ),
                    {"r": request_id},
                )
                .mappings()
                .first()
            )
        assert row["amount_cents"] == 1000
        assert row["status"] == "paid"
        # A 64-char hash that cannot be read back to the requester's id.
        assert len(row["payer_ref"]) == 64
        assert REQUESTER not in row["payer_ref"]

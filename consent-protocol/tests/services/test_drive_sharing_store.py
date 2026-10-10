"""Private request/exact-file approvals using real isolated PostgreSQL."""

# ruff: noqa: F811 -- shared pytest fixture imports

import asyncio
import base64
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_document_store import PROCESSING_DISCLOSURE_VERSION
from hushh_mcp.services.drive_owner_allowed import end_owner_allows_for_disconnected_pair
from hushh_mcp.services.drive_sharing_contract import (
    BROAD_TRUST_DISCLOSURE,
    BROAD_TRUST_SCOPE,
    DriveSharingError,
    ReviewedSource,
    ShareRequestPurpose,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.drive_sharing_store import DriveSharingStore
from hushh_mcp.services.google_drive_adapter import (
    DRIVE_BASE,
    DRIVE_POLICY,
    LIVE_POLICY_HASH,
    DriveReadError,
)
from tests.services.test_drive_document_selection import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    pick,
    source,
)

MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"


@pytest.fixture
async def sharing(documents, monkeypatch):
    monkeypatch.setenv("STRIPE_MODE", "test")
    monkeypatch.setenv("DRIVE_SHARING_KEY_V1", base64.b64encode(b"s" * 32).decode())
    monkeypatch.setenv("DRIVE_DOCUMENT_SHARING", "true")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner,recipient")
    with documents.db.engine.connect() as connection:
        connection.exec_driver_sql("CREATE TABLE agent_chat_conversations(id UUID PRIMARY KEY)")
        connection.exec_driver_sql(
            "CREATE TABLE one_adk_sessions(app_name TEXT,created_at TIMESTAMPTZ)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE connections(id UUID PRIMARY KEY,user_a_id TEXT,user_b_id TEXT,status TEXT)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE connection_origins(connection_id UUID,status TEXT,origin_kind TEXT)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE one_location_circles(id UUID,owner_user_id TEXT,system_kind TEXT,status TEXT)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE one_location_circle_memberships(circle_id UUID,user_id TEXT,status TEXT)"
        )
        connection.exec_driver_sql(
            """CREATE TABLE pkm_owner_payout_accounts(
                 user_id TEXT PRIMARY KEY,stripe_account_id TEXT UNIQUE NOT NULL,
                 details_submitted BOOLEAN NOT NULL DEFAULT FALSE,
                 payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
                 account_ready BOOLEAN NOT NULL DEFAULT FALSE)"""
        )
        # The mode migration also governs packet checkout bindings. This suite
        # needs only their provider session column; no packet processing runs.
        connection.exec_driver_sql(
            "CREATE TABLE pkm_packet_orders(stripe_checkout_session_id TEXT)"
        )
        pair_id = str(uuid4())
        connection.execute(
            text("INSERT INTO connections VALUES (:id,'owner','recipient','active')"),
            {"id": pair_id},
        )
        connection.execute(
            text("INSERT INTO connection_origins VALUES (:id,'active','direct_request')"),
            {"id": pair_id},
        )
        connection.commit()
        for name in (
            "114_one_action_directive_ledger.sql",
            "212_location_command_runtime.sql",
            "231_document_review_authority.sql",
            "232_drive_document_sharing.sql",
            "232_drive_document_sharing.sql",
            "233_drive_suggestion_preparation.sql",
            "233_drive_suggestion_preparation.sql",
            "234_drive_permission_management_retention.sql",
            "234_drive_permission_management_retention.sql",
            "241_drive_live_sharing.sql",
            "251_drive_owner_search_jobs.sql",
            "254_drive_bulk_shares.sql",
            "256_drive_request_bulk_search.sql",
            "259_drive_progressive_request_batches.sql",
            "262_drive_request_payments.sql",
            "263_drive_request_no_match.sql",
            "287_drive_request_access_stop.sql",
            "291_drive_request_owner_allowed.sql",
            "292_drive_request_owner_payouts.sql",
            "293_drive_request_owner_pricing.sql",
            "294_drive_request_bank_payout_events.sql",
            "297_document_commerce_readiness.sql",
            "298_stripe_mode_isolation.sql",
        ):
            # Raw SQL preserves JSON colons; double percent signs for psycopg2's
            # parameter parser while retaining PostgreSQL format() placeholders.
            connection.exec_driver_sql((MIGRATIONS / name).read_text().replace("%", "%%"))
        # This compact fixture has no Feed tables, so migration 288's
        # projection/notification portion runs in the Feed fixture instead.
        # Apply its real event vocabulary here: payment and request services
        # emit these events even when a test does not materialize Feed rows.
        stream_sql, marker, _ = (
            (MIGRATIONS / "288_drive_request_feed_stream.sql").read_text().partition("END $$;")
        )
        assert marker and "drive_share_events_event_type_check" in stream_sql, (
            "Drive Feed migration event constraint section is missing"
        )
        connection.exec_driver_sql((stream_sql + marker + "\nCOMMIT;").replace("%", "%%"))
        connection.commit()
    return DriveSharingStore(db=documents.db, authority_key="synthetic-ledger-key")


async def request(sharing, client_id=None):
    pricing = await sharing.owner_pricing(user_id="owner")
    return await sharing.create_request(
        recipient=VerifiedGoogleRecipient(
            "recipient", "1234567", "recipient@example.invalid", datetime.now(UTC)
        ),
        owner_user_id="owner",
        client_request_id=client_id or str(uuid4()),
        expected_quote_version=pricing["version"],
        purpose=ShareRequestPurpose(
            purpose="Private six-month statements", periodStart="2026-01-01", periodEnd="2026-06-30"
        ),
    )


@pytest.mark.asyncio
async def test_owner_price_is_locked_at_request_creation_and_retry(sharing, monkeypatch):
    monkeypatch.setenv("DRIVE_REQUEST_PAYMENTS_ENABLED", "true")
    monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", "true")
    monkeypatch.setattr(
        "hushh_mcp.services.drive_request_payment_service.require_payment_configuration",
        lambda: None,
    )
    initial = await sharing.owner_pricing(user_id="owner")
    assert initial == {"enabled": False, "amountCents": 1000, "version": 0}
    quote = await sharing.request_quote(user_id="recipient", owner_user_id="owner")
    assert quote == {
        "amountCents": None,
        "version": 0,
        "paymentRequired": True,
        "payoutReady": False,
        "priceReady": False,
        "paymentsReady": True,
    }
    first = await sharing.update_owner_pricing(
        user_id="owner", enabled=True, amount_cents=2500, expected_version=0
    )
    assert first == {"enabled": True, "amountCents": 2500, "version": 1}
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO stripe_owner_payout_accounts
              (stripe_mode,user_id,stripe_account_id,details_submitted,payouts_enabled,account_ready)
              VALUES ('test','owner','acct_test_owner',TRUE,TRUE,TRUE)""")
        )
    assert (await sharing.request_quote(user_id="recipient", owner_user_id="owner")) == {
        "amountCents": 2500,
        "version": 1,
        "paymentRequired": True,
        "payoutReady": True,
        "priceReady": True,
        "paymentsReady": True,
    }
    client_id = str(uuid4())
    recipient = VerifiedGoogleRecipient(
        "recipient", "1234567", "recipient@example.invalid", datetime.now(UTC)
    )
    purpose = ShareRequestPurpose(
        purpose="Statements", periodStart="2026-01-01", periodEnd="2026-06-30"
    )
    monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", "false")
    assert not (await sharing.request_quote(user_id="recipient", owner_user_id="owner"))[
        "paymentsReady"
    ]
    paused = await sharing.create_request(
        recipient=recipient,
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        purpose=purpose,
        expected_quote_version=1,
    )
    assert paused["paymentsReady"] is False
    assert (
        stored_request(sharing, paused["requestId"])[0]["preparation_error_code"]
        == "payout_unavailable"
    )
    monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", "true")
    with pytest.raises(DriveSharingError, match="price_changed"):
        await sharing.create_request(
            recipient=recipient,
            owner_user_id="owner",
            client_request_id=str(uuid4()),
            purpose=purpose,
        )
    created = await sharing.create_request(
        recipient=recipient,
        owner_user_id="owner",
        client_request_id=client_id,
        purpose=purpose,
        expected_quote_version=1,
    )
    assert (created["quotedAmountCents"], created["quoteVersion"]) == (2500, 1)
    await sharing.update_owner_pricing(
        user_id="owner", enabled=True, amount_cents=3000, expected_version=1
    )
    status = await sharing.request_status(user_id="recipient", request_id=created["requestId"])
    assert (status["quotedAmountCents"], status["quoteVersion"]) == (2500, 1)
    assert (
        await sharing.create_request(
            recipient=recipient,
            owner_user_id="owner",
            client_request_id=client_id,
            purpose=purpose,
            expected_quote_version=1,
        )
    )["requestId"] == created["requestId"]
    with pytest.raises(DriveSharingError, match="price_changed"):
        await sharing.create_request(
            recipient=recipient,
            owner_user_id="owner",
            client_request_id=str(uuid4()),
            purpose=purpose,
            expected_quote_version=1,
        )


@pytest.mark.asyncio
async def test_non_trusted_allow_fixes_owners_final_quote_before_payment(sharing, monkeypatch):
    live_drive(sharing, monkeypatch)
    monkeypatch.setenv("DRIVE_REQUEST_PAYMENTS_ENABLED", "true")
    monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", "true")
    monkeypatch.setattr(
        "hushh_mcp.services.drive_request_payment_service.require_payment_configuration",
        lambda: None,
    )
    await sharing.update_owner_pricing(
        user_id="owner", enabled=True, amount_cents=2500, expected_version=0
    )
    created = await sharing.create_request(
        recipient=VerifiedGoogleRecipient(
            "recipient", "1234567", "recipient@example.invalid", datetime.now(UTC)
        ),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        purpose=ShareRequestPurpose(
            purpose="Statements", periodStart="2026-01-01", periodEnd="2026-06-30"
        ),
        expected_quote_version=1,
    )
    allowed = await owner_allow(sharing, created, 3000)
    assert (allowed["ownerAllowed"], allowed["quotedAmountCents"]) == (True, 3000)
    assert allowed["ownerPayoutAccountReady"] is False
    assert (
        stored_request(sharing, created["requestId"])[0]["preparation_error_code"]
        == "owner_payout_required"
    )
    assert await owner_allow(sharing, created, 3000) == allowed
    with pytest.raises(DriveSharingError, match="request_already_decided"):
        await owner_allow(sharing, created, 2500)


@pytest.mark.asyncio
async def test_trusted_request_waits_for_payout_and_price_and_resumes_without_repricing(
    sharing, monkeypatch
):
    live_drive(sharing, monkeypatch)
    monkeypatch.setenv("DRIVE_REQUEST_PAYMENTS_ENABLED", "true")
    monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", "true")
    monkeypatch.setattr(
        "hushh_mcp.services.drive_request_payment_service.require_payment_configuration",
        lambda: None,
    )
    circle = str(uuid4())
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("INSERT INTO one_location_circles VALUES (:id,'owner','trusted','active')"),
            {"id": circle},
        )
        connection.execute(
            text("INSERT INTO one_location_circle_memberships VALUES (:id,'recipient','active')"),
            {"id": circle},
        )
    created = await request(sharing)
    identity = created["requestId"]
    assert created["ownerPriceRequired"] and not created["ownerPayoutAccountReady"]
    assert "quotedAmountCents" not in created
    assert stored_request(sharing, identity)[0]["preparation_error_code"] == "owner_payout_required"
    for prepare in (
        sharing.trusted_request_authority(user_id="owner", request_id=identity),
        sharing.request_bulk_context(user_id="owner", request_id=identity, start=True),
    ):
        with pytest.raises(DriveSharingError, match="owner_payout_required"):
            await prepare
    assert not rows(sharing, "drive_request_payment_orders")
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO stripe_owner_payout_accounts
          (stripe_mode,user_id,stripe_account_id,details_submitted,payouts_enabled,account_ready)
          VALUES ('test','owner','acct_test_owner',TRUE,TRUE,TRUE)""")
        )
    assert (await sharing.resume_owner_setup(user_id="owner"))["resumed"] == 0
    assert stored_request(sharing, identity)[0]["preparation_error_code"] == "owner_price_required"
    await sharing.update_owner_pricing(
        user_id="owner", enabled=True, amount_cents=200, expected_version=0
    )
    row, _ = stored_request(sharing, identity)
    assert (row["quoted_amount_cents"], row["preparation_error_code"]) == (
        200,
        "trusted_auto_queued",
    )
    await sharing.trusted_request_authority(user_id="owner", request_id=identity)
    await sharing.update_owner_pricing(
        user_id="owner", enabled=True, amount_cents=700, expected_version=1
    )
    assert stored_request(sharing, identity)[0]["quoted_amount_cents"] == 200


def test_setup_notification_has_stream_event_identity_for_both_participants():
    connection = Mock()
    request_id = uuid4()
    DriveSharingStore._notify_setup_changed(
        connection, {"user_id": "owner", "recipient_user_id": "recipient", "request_id": request_id}
    )
    payloads = [json.loads(call.args[1]["payload"]) for call in connection.execute.call_args_list]
    assert {payload["user_id"] for payload in payloads} == {"owner", "recipient"}
    assert len({payload["event_id"] for payload in payloads}) == 1
    for payload in payloads:
        assert UUID(payload["event_id"])
        assert UUID(payload["request_id"]) == request_id
        assert payload["type"] == "document_share_feed_changed"
        assert set(payload) == {"type", "event_id", "request_id", "user_id"}


async def trusted_unpriced_request(
    sharing, monkeypatch, *, payout_ready=True, trusted=True, default_amount_cents=None
):
    live_drive(sharing, monkeypatch)
    monkeypatch.setenv("DRIVE_REQUEST_PAYMENTS_ENABLED", "true")
    monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", "true")
    monkeypatch.setattr(
        "hushh_mcp.services.drive_request_payment_service.require_payment_configuration",
        lambda: None,
    )
    circle = str(uuid4())
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("INSERT INTO one_location_circles VALUES (:id,'owner','trusted','active')"),
            {"id": circle},
        )
        if trusted:
            connection.execute(
                text(
                    "INSERT INTO one_location_circle_memberships VALUES (:id,'recipient','active')"
                ),
                {"id": circle},
            )
        if payout_ready:
            connection.execute(
                text("""INSERT INTO stripe_owner_payout_accounts
              (stripe_mode,user_id,stripe_account_id,details_submitted,payouts_enabled,account_ready)
              VALUES ('test','owner','acct_test_owner',TRUE,TRUE,TRUE)""")
            )
    if default_amount_cents is not None:
        await sharing.update_owner_pricing(
            user_id="owner", enabled=True, amount_cents=default_amount_cents, expected_version=0
        )
    return await request(sharing)


@pytest.mark.asyncio
@pytest.mark.parametrize("trusted", [True, False])
async def test_live_requests_require_live_payout_setup_for_both_trust_paths(
    sharing, monkeypatch, trusted
):
    monkeypatch.setenv("STRIPE_MODE", "live")
    created = await trusted_unpriced_request(
        sharing, monkeypatch, trusted=trusted, default_amount_cents=200
    )
    assert created["ownerPayoutAccountReady"] is False
    if not trusted:
        created = await owner_allow(sharing, created, 300)
        assert created["ownerAllowed"] is True
    assert (
        stored_request(sharing, created["requestId"])[0]["preparation_error_code"]
        == "owner_payout_required"
    )
    assert not rows(sharing, "drive_request_payment_orders")
    # An old unclassified mapping cannot stand in for verified live setup.
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO pkm_owner_payout_accounts
          (user_id,stripe_account_id,details_submitted,payouts_enabled,account_ready)
          VALUES ('owner','acct_legacy_owner',TRUE,TRUE,TRUE)""")
        )
    assert (await sharing.resume_owner_setup(user_id="owner"))["resumed"] == 0
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO stripe_owner_payout_accounts
          (user_id,stripe_mode,stripe_account_id,details_submitted,payouts_enabled,account_ready)
          VALUES ('owner','live','acct_live_owner',TRUE,TRUE,TRUE)""")
        )
    assert (await sharing.resume_owner_setup(user_id="owner"))["resumed"] == 1
    row, _ = stored_request(sharing, created["requestId"])
    assert row["quoted_amount_cents"] == (200 if trusted else 300)
    assert row["preparation_error_code"] == "trusted_auto_queued"


@pytest.mark.asyncio
async def test_trusted_price_once_preserves_trust_authority_and_global_ask_each_time(
    sharing, monkeypatch
):
    created = await trusted_unpriced_request(sharing, monkeypatch)
    identity = created["requestId"]
    review = await sharing.owner_review(user_id="owner", request_id=identity)
    assert review["priceOnlyAvailable"] and not review["allowAvailable"]
    first = await sharing.set_request_price(
        user_id="owner", request_id=identity, revision=created["revision"], amount_cents=700
    )
    assert first["quotedAmountCents"] == 700 and not first["ownerPriceRequired"]
    assert (
        await sharing.set_request_price(
            user_id="owner", request_id=identity, revision=created["revision"], amount_cents=700
        )
        == first
    )
    with pytest.raises(DriveSharingError, match="request_already_decided"):
        await sharing.set_request_price(
            user_id="owner", request_id=identity, revision=created["revision"], amount_cents=800
        )
    row, private = stored_request(sharing, identity)
    assert row["owner_allowed_at"] is None and "owner_allowed" not in private
    assert row["preparation_error_code"] == "trusted_auto_queued"
    assert not (await sharing.owner_pricing(user_id="owner"))["enabled"]
    assert not (await sharing.owner_review(user_id="owner", request_id=identity))[
        "priceOnlyAvailable"
    ]
    await sharing.trusted_request_authority(user_id="owner", request_id=identity)
    with sharing.db.engine.begin() as connection:
        connection.execute(text("UPDATE one_location_circle_memberships SET status='removed'"))
    with pytest.raises(DriveSharingError, match="trusted_request_unavailable"):
        await sharing.trusted_request_authority(user_id="owner", request_id=identity)


@pytest.mark.asyncio
async def test_trusted_per_request_price_keeps_missing_bank_gate(sharing, monkeypatch):
    created = await trusted_unpriced_request(sharing, monkeypatch, payout_ready=False)
    identity = created["requestId"]
    updated = await sharing.set_request_price(
        user_id="owner", request_id=identity, revision=created["revision"], amount_cents=500
    )
    assert updated["quotedAmountCents"] == 500 and not updated["ownerPayoutAccountReady"]
    assert stored_request(sharing, identity)[0]["preparation_error_code"] == "owner_payout_required"
    with pytest.raises(DriveSharingError, match="owner_payout_required"):
        await sharing.trusted_request_authority(user_id="owner", request_id=identity)
    assert not rows(sharing, "drive_request_payment_orders")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "guard", ["owner", "revision", "expired", "stopped", "search", "lease", "order", "nontrusted"]
)
async def test_trusted_per_request_price_rechecks_immutable_and_authority_guards(
    sharing, monkeypatch, guard
):
    created = await trusted_unpriced_request(sharing, monkeypatch)
    identity = created["requestId"]
    with sharing.db.engine.begin() as connection:
        if guard in {"expired", "stopped", "search", "lease"}:
            change = {
                "expired": "created_at=clock_timestamp()-INTERVAL '2 hours',expires_at=clock_timestamp()-INTERVAL '1 hour'",
                "stopped": "access_stop_requested_at=clock_timestamp()",
                "search": "bulk_search_started_at=clock_timestamp()",
                "lease": "preparation_lease_id=CAST(:id AS uuid),preparation_lease_expires_at=clock_timestamp()+INTERVAL '1 minute'",
            }[guard]
            connection.execute(
                text(f"UPDATE drive_share_requests SET {change} WHERE request_id=:id"),
                {"id": identity},
            )
        elif guard == "order":
            connection.execute(
                text("""INSERT INTO drive_request_payment_orders
                     (stripe_mode,request_id,user_id,requester_user_id,status)
                     VALUES ('test',:id,'owner','recipient','expired')"""),
                {"id": identity},
            )
        elif guard == "nontrusted":
            connection.execute(text("UPDATE one_location_circle_memberships SET status='removed'"))
    with pytest.raises((DriveSharingError, DriveReadError)):
        await sharing.set_request_price(
            user_id="recipient" if guard == "owner" else "owner",
            request_id=identity,
            revision=created["revision"] + int(guard == "revision"),
            amount_cents=500,
        )
    assert stored_request(sharing, identity)[0]["quoted_amount_cents"] is None


@pytest.mark.asyncio
async def test_scheduler_recovers_setup_without_account_webhook_wake(sharing, monkeypatch):
    live_drive(sharing, monkeypatch)
    monkeypatch.setenv("DRIVE_REQUEST_PAYMENTS_ENABLED", "true")
    monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", "false")
    monkeypatch.setattr(
        "hushh_mcp.services.drive_request_payment_service.require_payment_configuration",
        lambda: None,
    )
    created = await request(sharing)
    await owner_allow(sharing, created, 500)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO stripe_owner_payout_accounts
          (stripe_mode,user_id,stripe_account_id,details_submitted,payouts_enabled,account_ready)
          VALUES ('test','owner','acct_test_owner',TRUE,TRUE,TRUE)""")
        )
    monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", "true")
    due = await sharing.due_trusted_searches(limit=20)
    assert due == [{"user_id": "owner", "request_id": created["requestId"]}]
    assert (
        stored_request(sharing, created["requestId"])[0]["preparation_error_code"]
        == "trusted_auto_queued"
    )
    assert (await sharing.request_status(user_id="recipient", request_id=created["requestId"]))[
        "ownerPayoutAccountReady"
    ]


@pytest.mark.asyncio
async def test_request_keeps_requester_calendar_context_encrypted(sharing):
    yesterday = (datetime.now(ZoneInfo("Asia/Kolkata")).date() - timedelta(days=1)).isoformat()
    created = await sharing.create_request(
        recipient=VerifiedGoogleRecipient(
            "recipient", "1234567", "recipient@example.invalid", datetime.now(UTC)
        ),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        purpose=ShareRequestPurpose(
            purpose="Notes from yesterday's onboarding call",
            periodStart=yesterday,
            periodEnd=yesterday,
        ),
        request_time_zone="Asia/Kolkata",
    )

    context = await sharing.request_bulk_context(user_id="owner", request_id=created["requestId"])
    assert context["requestTimeZone"] == "Asia/Kolkata"
    assert context["requestCreatedAt"].tzinfo is not None
    with sharing.db.engine.connect() as connection:
        serialized = connection.execute(
            text("SELECT request_envelope::text FROM drive_share_requests WHERE request_id=:id"),
            {"id": created["requestId"]},
        ).scalar_one()
    assert "Asia/Kolkata" not in serialized


async def review(sharing):
    _, selected = await pick(sharing, [source("one"), source("two")])
    ids = [item["documentId"] for item in selected]
    for identifier in ids:
        await sharing.set_processing(
            user_id="owner",
            generation=1,
            document_id=identifier,
            enabled=True,
            disclosure=PROCESSING_DISCLOSURE_VERSION,
        )
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE connected_documents SET status='ready',active_version=:version"),
            {"version": "a" * 64},
        )
    created = await request(sharing)
    with sharing.db.engine.connect() as connection:
        observed = [
            ReviewedSource.model_validate(sharing._source_terms(dict(row)))
            for row in connection.execute(text("SELECT * FROM connected_documents")).mappings()
        ]
    prepared = await sharing.prepare_review(
        user_id="owner",
        generation=1,
        request_id=created["requestId"],
        expected_revision=0,
        document_ids=ids,
        observed_sources=observed,
        coverage={"summary": "Synthetic fixture, not a coverage claim."},
    )
    return prepared, ids


async def approve(sharing, prepared, ids, **changes):
    return await sharing.approve_review(
        **{
            "user_id": "owner",
            "generation": 1,
            "request_id": prepared["requestId"],
            "revision": prepared["revision"],
            "review_digest": prepared["reviewDigest"],
            "document_ids": ids,
            "confirmed": True,
            **changes,
        }
    )


def rows(sharing, table):
    assert table in {
        "drive_share_management_contexts",
        "drive_share_file_claims",
        "connected_documents",
        "external_connector_oauth_attempts",
        "user_external_connector_connections",
        "drive_share_requests",
        "drive_share_reviews",
        "drive_share_events",
        "drive_share_permission_operations",
        "drive_request_payment_orders",
        "drive_request_payment_obligations",
        "drive_request_payment_refunds",
        "one_action_directive_ledger",
    }
    with sharing.db.engine.connect() as connection:
        return [
            dict(row) for row in connection.exec_driver_sql(f"SELECT * FROM {table}").mappings()
        ]


@pytest.mark.asyncio
async def test_request_is_private_idempotent_and_does_not_share(sharing):
    client = str(uuid4())
    first = await request(sharing, client)
    assert await request(sharing, client) == first
    assert len(rows(sharing, "drive_share_requests")) == 1
    assert sorted(
        (event["event_type"], event["user_id"]) for event in rows(sharing, "drive_share_events")
    ) == [
        ("document_share_request", "owner"),
        ("document_share_request_sent", "recipient"),
    ]
    assert rows(sharing, "drive_share_permission_operations") == []
    stored = rows(sharing, "drive_share_requests")[0]
    for private in ("Private six-month", "recipient@example.invalid", "1234567"):
        assert private not in json.dumps(stored, default=str)


@pytest.mark.asyncio
async def test_request_accepts_a_connected_recipient_without_their_drive_connector(
    sharing, monkeypatch
):
    """The owner supplies Drive authority; database pair order must not matter."""
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner,Mixed")
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("INSERT INTO connections VALUES (:id,'owner','Mixed','active')"),
            {"id": str(uuid4())},
        )
        recipient_drive_rows = connection.execute(
            text("""SELECT count(*) FROM user_external_connector_connections
                    WHERE user_id='Mixed' AND connector_id='google_drive'""")
        ).scalar_one()
    assert recipient_drive_rows == 0
    assert sorted(("owner", "Mixed")) != ["owner", "Mixed"]

    created = await sharing.create_request(
        recipient=VerifiedGoogleRecipient(
            "Mixed", "1234567", "mixed@example.invalid", datetime.now(UTC)
        ),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        purpose=ShareRequestPurpose(
            purpose="Share an exact Drive file",
            periodStart="2026-09-01",
            periodEnd="2026-09-30",
        ),
    )

    assert created["requestId"]
    assert len(rows(sharing, "drive_share_permission_operations")) == 0


@pytest.mark.asyncio
async def test_concurrent_identical_request_retries_return_one_request(sharing):
    client = str(uuid4())
    results = await asyncio.gather(*(request(sharing, client) for _ in range(4)))
    assert all(result == results[0] for result in results)
    assert len(rows(sharing, "drive_share_requests")) == 1
    assert sorted(
        (event["event_type"], event["user_id"]) for event in rows(sharing, "drive_share_events")
    ) == [
        ("document_share_request", "owner"),
        ("document_share_request_sent", "recipient"),
    ]


@pytest.mark.asyncio
async def test_suggestions_cannot_adopt_a_newer_index_after_interpretation(sharing):
    prepared, ids = await review(sharing)
    with sharing.db.engine.begin() as connection:
        observed = [
            ReviewedSource.model_validate(sharing._source_terms(dict(row)))
            for row in connection.execute(text("SELECT * FROM connected_documents")).mappings()
        ]
        connection.execute(text("UPDATE connected_documents SET active_version=repeat('b',64)"))
    with pytest.raises(DriveSharingError, match="source_changed"):
        await sharing.prepare_review(
            user_id="owner",
            generation=1,
            request_id=prepared["requestId"],
            expected_revision=1,
            document_ids=ids,
            observed_sources=observed,
            coverage={"summary": "Derived from old index"},
        )
    assert len(rows(sharing, "drive_share_reviews")) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("notify", [True, False])
async def test_a_silent_decline_is_not_news_to_the_recipient(sharing, notify):
    """An owner's own failed share was never announced, so closing it is not either."""
    created = await request(sharing)
    await sharing.decline_or_cancel(
        user_id="owner",
        request_id=created["requestId"],
        revision=created["revision"],
        decision="declined",
        notify_recipient=notify,
    )
    decided = [
        event
        for event in rows(sharing, "drive_share_events")
        if event["event_type"] == "document_share_decided"
    ]
    assert [event["user_id"] for event in decided] == (["recipient"] if notify else [])


@pytest.mark.asyncio
async def test_recipient_sees_status_not_private_suggestions(sharing):
    prepared, _ = await review(sharing)
    status = await sharing.request_status(user_id="recipient", request_id=prepared["requestId"])
    assert status["status"] == "pending"
    assert set(status) == {"requestId", "status", "revision", "direction"}
    assert status["direction"] == "outgoing"
    with pytest.raises(DriveSharingError, match="request_unavailable"):
        await sharing.owner_review(user_id="recipient", request_id=prepared["requestId"])
    private = await sharing.owner_review(user_id="owner", request_id=prepared["requestId"])
    assert len(private["files"]) == 2
    assert private["recipientEmail"] == "recipient@example.invalid"


@pytest.mark.asyncio
async def test_payment_context_is_only_the_requesters_own_text(sharing, monkeypatch):
    created = await request(sharing)
    request_id = created["requestId"]
    # Free/owner-initiated shares must not expose owner-authored context.
    with pytest.raises(DriveSharingError, match="request_unavailable"):
        await sharing.requester_context(user_id="recipient", request_id=request_id)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET payment_required=TRUE WHERE request_id=:id"),
            {"id": request_id},
        )
    context = await sharing.requester_context(user_id="recipient", request_id=request_id)
    assert context == {
        "requestId": request_id,
        "purpose": {
            "purpose": "Private six-month statements",
            "periodStart": "2026-01-01",
            "periodEnd": "2026-06-30",
        },
    }
    # Authorization fails before private-envelope decryption, identically for
    # the file owner, an unrelated viewer, and an unknown request.
    monkeypatch.setattr(sharing, "_open_request", lambda _: pytest.fail("unauthorized decrypt"))
    for viewer, target in (
        ("owner", request_id),
        ("other", request_id),
        ("recipient", str(uuid4())),
    ):
        with pytest.raises(DriveSharingError, match="request_unavailable"):
            await sharing.requester_context(user_id=viewer, request_id=target)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    [
        "UPDATE user_external_connector_connections SET status='revoked' WHERE user_id='owner'",
        "UPDATE connected_documents SET source_version='2'",
        "UPDATE connected_documents SET processing_enabled=FALSE",
        "UPDATE connections SET status='removed'",
    ],
)
async def test_review_does_not_offer_stale_approval(sharing, mutation):
    prepared, _ = await review(sharing)
    assert (await sharing.owner_review(user_id="owner", request_id=prepared["requestId"]))[
        "canApprove"
    ]
    with sharing.db.engine.begin() as connection:
        connection.execute(text(mutation))
    assert not (await sharing.owner_review(user_id="owner", request_id=prepared["requestId"]))[
        "canApprove"
    ]


@pytest.mark.asyncio
async def test_disabled_sharing_keeps_private_review_readable_without_approve(sharing, monkeypatch):
    prepared, _ = await review(sharing)
    monkeypatch.setenv("DRIVE_DOCUMENT_SHARING", "false")
    private = await sharing.owner_review(user_id="owner", request_id=prepared["requestId"])
    assert not private["canApprove"]
    assert len(private["files"]) == 2


@pytest.mark.asyncio
async def test_decline_invalidates_authority_and_does_not_need_execution_flag(sharing, monkeypatch):
    prepared, ids = await review(sharing)
    monkeypatch.setenv("DRIVE_DOCUMENT_SHARING", "false")
    assert (
        await sharing.decline_or_cancel(
            user_id="owner", request_id=prepared["requestId"], revision=1, decision="declined"
        )
    )["status"] == "declined"
    assert rows(sharing, "one_action_directive_ledger")[0]["state"] == "cancelled"
    assert rows(sharing, "drive_share_permission_operations") == []


@pytest.mark.asyncio
async def test_approval_enqueues_exact_files_without_claiming_provider_success(sharing):
    prepared, ids = await review(sharing)
    result = await approve(sharing, prepared, ids)
    assert result["status"] == "approved"
    assert result["sharingStatus"] == "pending"
    operations = rows(sharing, "drive_share_permission_operations")
    assert len(operations) == 2
    assert {str(item["document_id"]) for item in operations} == set(ids)
    assert {item["state"] for item in operations} == {"queued"}
    assert all(item["receipt_envelope"] is None for item in operations)
    assert {item["state"] for item in rows(sharing, "one_action_directive_ledger")} == {"consumed"}
    for operation in operations:
        assert "recipient@example.invalid" not in json.dumps(operation, default=str)
        plan = sharing.sharing_cipher.open(
            operation["plan_envelope"],
            user_id="owner",
            resource_id=str(operation["operation_id"]),
            purpose="permission-plan",
        )
        assert plan["recipient"]["email"] == "recipient@example.invalid"
        assert plan["approval"]["role"] == "reader"


@pytest.mark.asyncio
async def test_owner_can_share_some_of_the_reviewed_files(sharing):
    prepared, ids = await review(sharing)
    result = await approve(sharing, prepared, ids[:1])
    assert result["status"] == "approved"
    assert result["fileCount"] == 1
    operations = rows(sharing, "drive_share_permission_operations")
    # Only the selected file is queued; the other reviewed file is never granted.
    assert [str(item["document_id"]) for item in operations] == ids[:1]
    assert {item["state"] for item in rows(sharing, "one_action_directive_ledger")} == {"consumed"}
    # The sealed plan names only the shared file, so dispatch never rechecks
    # (or is withdrawn by) the file A chose not to share.
    plan = sharing.sharing_cipher.open(
        operations[0]["plan_envelope"],
        user_id="owner",
        resource_id=str(operations[0]["operation_id"]),
        purpose="permission-plan",
    )
    assert [source["document_id"] for source in plan["approval"]["sources"]] == ids[:1]


@pytest.mark.asyncio
async def test_queue_grants_refuses_a_plan_that_names_other_files(sharing):
    approval = SimpleNamespace(
        sources=[SimpleNamespace(document_id="one"), SimpleNamespace(document_id="two")]
    )
    with pytest.raises(DriveSharingError, match="invalid_selection"):
        sharing._queue_grants(
            None,
            request={"payment_required": False},
            approval=approval,
            sources=[{"document_id": "one"}],
            batch="b",
        )


@pytest.mark.asyncio
async def test_trust_for_future_requests_needs_the_whole_review(sharing):
    prepared, ids = await review(sharing)
    with pytest.raises(DriveReadError, match="rule_not_covered"):
        await approve(
            sharing,
            prepared,
            ids[:1],
            trust_future_requests=True,
            trust_scope=BROAD_TRUST_SCOPE,
            trust_disclosure_version=BROAD_TRUST_DISCLOSURE,
        )
    assert rows(sharing, "drive_share_permission_operations") == []
    assert rows(sharing, "one_action_directive_ledger")[0]["state"] == "issued"


@pytest.mark.asyncio
async def test_concurrent_decisions_never_enqueue_duplicates(sharing):
    prepared, ids = await review(sharing)
    result = await asyncio.gather(
        *(approve(sharing, prepared, ids) for _ in range(4)), return_exceptions=True
    )
    assert sum(isinstance(item, dict) for item in result) == 1
    assert len(rows(sharing, "drive_share_permission_operations")) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changed",
    [
        "wrong_owner",
        "outside_file",
        "duplicate_file",
        "wrong_file",
        "revision",
        "digest",
        "unconfirmed",
        "generation",
    ],
)
async def test_substituted_approval_has_no_effect(sharing, changed):
    prepared, ids = await review(sharing)
    changes = {
        "wrong_owner": {"user_id": "recipient"},
        "outside_file": {"document_ids": [ids[0], str(uuid4())]},
        "duplicate_file": {"document_ids": [ids[0], ids[0]]},
        "wrong_file": {"document_ids": [str(uuid4())]},
        "revision": {"revision": 2},
        "digest": {"review_digest": "0" * 64},
        "unconfirmed": {"confirmed": False},
        "generation": {"generation": 2},
    }
    with pytest.raises(DriveReadError):
        await approve(sharing, prepared, ids, **changes[changed])
    assert rows(sharing, "drive_share_permission_operations") == []
    assert rows(sharing, "one_action_directive_ledger")[0]["state"] == "issued"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    [
        "UPDATE connected_documents SET source_version='2'",
        "UPDATE connected_documents SET processing_enabled=FALSE,processing_revision=processing_revision+1",
        "UPDATE drive_share_requests SET recipient_binding=repeat('c',64)",
        "UPDATE drive_share_reviews SET expires_at=clock_timestamp()-INTERVAL '1 second'",
        "UPDATE connections SET status='revoked'",
    ],
)
async def test_current_source_recipient_consent_and_relationship_fences(sharing, mutation):
    prepared, ids = await review(sharing)
    with sharing.db.engine.begin() as connection:
        connection.exec_driver_sql(mutation)
    with pytest.raises(DriveReadError):
        await approve(sharing, prepared, ids)
    assert rows(sharing, "drive_share_permission_operations") == []


@pytest.mark.asyncio
async def test_disconnect_removes_index_but_not_approved_permission_work(sharing):
    prepared, ids = await review(sharing)
    await approve(sharing, prepared, ids)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE user_external_connector_connections SET status='revoked',connection_generation=connection_generation+1 WHERE user_id='owner' AND connector_id='google_drive'"
            )
        )
        assert connection.execute(text("SELECT count(*) FROM connected_documents")).scalar() == 0
    assert len(rows(sharing, "drive_share_permission_operations")) == 2
    assert len(rows(sharing, "drive_share_reviews")) == 1


@pytest.mark.asyncio
async def test_background_opt_out_prevents_suggestion_publication(sharing):
    _, selected = await pick(sharing)
    created = await request(sharing)
    with pytest.raises(DriveSharingError, match="source_changed"):
        await sharing.prepare_review(
            user_id="owner",
            generation=1,
            request_id=created["requestId"],
            expected_revision=0,
            document_ids=[selected[0]["documentId"]],
            observed_sources=[],
            coverage={},
        )
    assert rows(sharing, "drive_share_reviews") == []


@pytest.mark.asyncio
async def test_empty_suggestions_are_reviewable_but_not_approval_authority(sharing):
    created = await request(sharing)
    prepared = await sharing.prepare_review(
        user_id="owner",
        generation=1,
        request_id=created["requestId"],
        expected_revision=0,
        document_ids=[],
        observed_sources=[],
        coverage={"summary": "No eligible selected files."},
    )
    assert rows(sharing, "one_action_directive_ledger") == []
    with pytest.raises(DriveSharingError, match="review_changed"):
        await approve(sharing, prepared, [])


async def test_a_prepared_review_still_tells_the_owner(sharing):
    """The owner-selected share skips this alert; B's ordinary request must not."""
    prepared, _ = await review(sharing)
    events = [
        (item["user_id"], item["event_type"])
        for item in rows(sharing, "drive_share_events")
        if str(item["request_id"]) == prepared["requestId"]
    ]
    assert ("owner", "document_share_review_ready") in events


def live_drive(sharing, monkeypatch):
    """The owner's live Drive grant, which Allow and automatic sharing require."""
    monkeypatch.setenv("GOOGLE_DRIVE_LIVE", "true")
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE external_mcp_connectors SET transport_kind='google_drive_rest',
              mcp_endpoint=:endpoint,capability_policy=CAST(:policy AS jsonb)
              WHERE connector_id='google_drive'"""),
            {"endpoint": DRIVE_BASE, "policy": json.dumps(DRIVE_POLICY)},
        )
        connection.execute(
            text("""UPDATE user_external_connector_connections
              SET validation_state='verified',verified_policy_hash=:policy
              WHERE user_id='owner' AND connector_id='google_drive'"""),
            {"policy": LIVE_POLICY_HASH},
        )


def stored_request(sharing, request_id):
    with sharing.db.engine.connect() as connection:
        row = dict(
            connection.execute(
                text("SELECT * FROM drive_share_requests WHERE request_id=:id"),
                {"id": request_id},
            )
            .mappings()
            .one()
        )
    return row, sharing._open_request(row)


async def owner_allow(sharing, created, amount_cents=None, **changes):
    return await sharing.allow_request(
        **{
            "user_id": "owner",
            "request_id": created["requestId"],
            "revision": created["revision"],
            "amount_cents": amount_cents,
            **changes,
        }
    )


@pytest.mark.asyncio
async def test_owner_allow_hands_a_new_request_to_the_trusted_pipeline(sharing, monkeypatch):
    live_drive(sharing, monkeypatch)
    created = await request(sharing)
    request_id = created["requestId"]
    review = await sharing.owner_review(user_id="owner", request_id=request_id)
    assert (review["allowAvailable"], review["ownerAllowed"], review["trustedAuto"]) == (
        True,
        False,
        False,
    )
    assert (review["paymentRequired"], review["priceCents"]) == (False, None)
    events = rows(sharing, "drive_share_events")

    with pytest.raises(DriveSharingError, match="review_changed"):
        await owner_allow(sharing, created, revision=1)
    # A free request takes no price.
    with pytest.raises(DriveSharingError, match="invalid_payment_amount"):
        await owner_allow(sharing, created, 2000)
    assert stored_request(sharing, request_id)[0]["preparation_error_code"] is None

    assert await owner_allow(sharing, created) == {
        "requestId": request_id,
        "status": "pending",
        "revision": 0,
        "ownerAllowed": True,
        "amountCents": None,
    }
    row, private = stored_request(sharing, request_id)
    assert private["trusted_auto"] is True
    assert private["owner_allowed"]["amount_cents"] is None
    assert private["purpose"]["purpose"] == "Private six-month statements"
    assert row["preparation_error_code"] == "trusted_auto_queued"
    assert row["owner_allowed_at"] is not None
    assert row["revision"] == 0
    # Allow emits no event; the payment and delivery steps tell the requester.
    assert rows(sharing, "drive_share_events") == events
    review = await sharing.owner_review(user_id="owner", request_id=request_id)
    assert (review["allowAvailable"], review["ownerAllowed"], review["trustedAuto"]) == (
        False,
        True,
        True,
    )
    assert review["preparationError"] is None


@pytest.mark.asyncio
async def test_owner_price_is_required_for_a_paid_request_and_fixed_once_allowed(
    sharing, monkeypatch
):
    live_drive(sharing, monkeypatch)
    created = await request(sharing)
    request_id = created["requestId"]
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET payment_required=TRUE WHERE request_id=:id"),
            {"id": request_id},
        )
    for missing_or_invalid in (None, 2050, 50100):
        with pytest.raises(DriveSharingError, match="invalid_payment_amount"):
            await owner_allow(sharing, created, missing_or_invalid)

    first = await owner_allow(sharing, created, 2000)
    assert (first["ownerAllowed"], first["amountCents"]) == (True, 2000)
    row, private = stored_request(sharing, request_id)
    assert private["owner_allowed"]["amount_cents"] == 2000
    # A repeated tap with the same price is the same decision, not a new seal.
    assert await owner_allow(sharing, created, 2000) == first
    assert stored_request(sharing, request_id)[0]["request_envelope"] == row["request_envelope"]
    for changed in (3000, None):
        with pytest.raises(DriveSharingError, match="request_already_decided"):
            await owner_allow(sharing, created, changed)
    assert stored_request(sharing, request_id)[1]["owner_allowed"]["amount_cents"] == 2000
    review = await sharing.owner_review(user_id="owner", request_id=request_id)
    assert (review["paymentRequired"], review["priceCents"]) == (True, 2000)


@pytest.mark.asyncio
async def test_a_trusted_request_has_no_owner_allow(sharing, monkeypatch):
    live_drive(sharing, monkeypatch)
    circle = str(uuid4())
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("INSERT INTO one_location_circles VALUES (:id,'owner','trusted','active')"),
            {"id": circle},
        )
        connection.execute(
            text("INSERT INTO one_location_circle_memberships VALUES (:id,'recipient','active')"),
            {"id": circle},
        )
    created = await request(sharing)
    review = await sharing.owner_review(user_id="owner", request_id=created["requestId"])
    assert (review["trustedAuto"], review["allowAvailable"]) == (True, False)
    with pytest.raises(DriveSharingError, match="request_already_decided"):
        await owner_allow(sharing, created)
    assert "owner_allowed" not in stored_request(sharing, created["requestId"])[1]


@pytest.mark.asyncio
async def test_owner_allow_is_automatic_authority_only_while_connected(sharing, monkeypatch):
    live_drive(sharing, monkeypatch)
    allowed = await request(sharing)
    waiting = await request(sharing)
    await owner_allow(sharing, allowed)

    # This owner has no Trusted circle: the Allow is the authority.
    authority = await sharing.trusted_request_authority(
        user_id="owner", request_id=allowed["requestId"]
    )
    assert (authority["recipientUserId"], authority["searchStarted"]) == ("recipient", False)
    due = await sharing.due_trusted_searches(limit=20)
    assert [item["request_id"] for item in due] == [allowed["requestId"]]
    with pytest.raises(DriveSharingError, match="trusted_request_unavailable"):
        await sharing.trusted_request_authority(user_id="owner", request_id=waiting["requestId"])

    # The sealed Allow is never authority on its own.
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    with pytest.raises(DriveSharingError, match="trusted_request_unavailable"):
        await sharing.trusted_request_authority(user_id="owner", request_id=allowed["requestId"])
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner,recipient")
    with sharing.db.engine.begin() as connection:
        connection.execute(text("UPDATE connections SET status='removed'"))
    with pytest.raises(DriveSharingError, match="connection_required"):
        await sharing.trusted_request_authority(user_id="owner", request_id=allowed["requestId"])


@pytest.mark.asyncio
async def test_a_disconnect_ends_the_owner_allow_and_reconnecting_never_restores_it(
    sharing, monkeypatch
):
    live_drive(sharing, monkeypatch)
    allowed = await request(sharing)
    waiting = await request(sharing)
    await owner_allow(sharing, allowed)
    request_id = allowed["requestId"]
    # Control: while the pair stays connected, the Allow is automatic authority.
    await sharing.trusted_request_authority(user_id="owner", request_id=request_id)

    # ConnectionsService.remove_connection ends the Allow in its transaction.
    with sharing.db.engine.begin() as connection:
        connection.execute(text("UPDATE connections SET status='revoked'"))
        assert (
            end_owner_allows_for_disconnected_pair(
                connection, user_a_id="owner", user_b_id="recipient"
            )
            == 1
        )
    with sharing.db.engine.begin() as connection:
        connection.execute(text("UPDATE connections SET status='active'"))

    # Reconnected, the request stays out of every automatic path.
    with pytest.raises(DriveSharingError, match="trusted_request_unavailable"):
        await sharing.trusted_request_authority(user_id="owner", request_id=request_id)
    assert await sharing.due_trusted_searches(limit=20) == []
    row, private = stored_request(sharing, request_id)
    assert (row["owner_allowed_at"], row["preparation_error_code"]) == (
        None,
        "trusted_relationship_changed",
    )
    assert private["owner_allowed"]["amount_cents"] is None
    review = await sharing.owner_review(user_id="owner", request_id=request_id)
    assert (review["allowAvailable"], review["ownerAllowed"], review["preparationError"]) == (
        False,
        True,
        "trusted_relationship_changed",
    )
    # A repeated Allow cannot revive it, and a replayed disconnect has nothing left to end.
    with pytest.raises(DriveSharingError, match="request_already_decided"):
        await owner_allow(sharing, allowed)
    with sharing.db.engine.begin() as connection:
        assert (
            end_owner_allows_for_disconnected_pair(
                connection, user_a_id="recipient", user_b_id="owner"
            )
            == 0
        )
    # Negative control: a request the owner never allowed is left to decide.
    assert stored_request(sharing, waiting["requestId"])[0]["preparation_error_code"] is None
    assert (await sharing.owner_review(user_id="owner", request_id=waiting["requestId"]))[
        "allowAvailable"
    ]


@pytest.mark.asyncio
async def test_a_trusted_members_unmarked_request_keeps_the_trusted_path(sharing, monkeypatch):
    live_drive(sharing, monkeypatch)
    # Made outside the Trusted circle, so it carries no automatic marker, as a
    # request made before the owner's Drive was live does.
    created = await request(sharing)
    request_id = created["requestId"]
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET payment_required=TRUE WHERE request_id=:id"),
            {"id": request_id},
        )
    # Negative control: from outside the Trusted circle the owner may Allow.
    assert (await sharing.owner_review(user_id="owner", request_id=request_id))["allowAvailable"]

    circle = str(uuid4())
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("INSERT INTO one_location_circles VALUES (:id,'owner','trusted','active')"),
            {"id": circle},
        )
        connection.execute(
            text("INSERT INTO one_location_circle_memberships VALUES (:id,'recipient','active')"),
            {"id": circle},
        )
    # A current Trusted member is never priced by the owner: manual review at $10.
    review = await sharing.owner_review(user_id="owner", request_id=request_id)
    assert (review["allowAvailable"], review["trustedAuto"]) == (False, False)
    with pytest.raises(DriveSharingError, match="request_already_decided"):
        await owner_allow(sharing, created, 3000)
    row, private = stored_request(sharing, request_id)
    assert (row["owner_allowed_at"], row["preparation_error_code"]) == (None, None)
    assert "owner_allowed" not in private

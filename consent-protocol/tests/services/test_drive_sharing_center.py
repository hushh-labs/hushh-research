"""Real PostgreSQL projection and mixed-source Consent Center pagination."""

# ruff: noqa: F811 -- imported pytest fixtures

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text

from hushh_mcp.services.consent_center_service import ConsentCenterService
from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.drive_owner_allowed import end_owner_allows_for_disconnected_pair
from hushh_mcp.services.drive_sharing_center_contributor import DriveSharingCenterContributor, entry
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_permission_executor import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    permission_setup,
    rows,
    sharing,
)
from tests.services.test_drive_request_bulk_postgres import request_bulk  # noqa: F401
from tests.services.test_drive_sharing_store import (
    request,
    review,
    stored_request,
    trusted_unpriced_request,
)
from tests.services.test_drive_trusted_auto import _connection, _membership, _request


@pytest.mark.parametrize(
    ("search_state", "attention_required"),
    [
        ("queued", False),
        ("running", False),
        ("completed", False),
        ("failed", True),
        ("limited", True),
        ("stopped", True),
        ("expired", True),
        (None, True),
    ],
)
def test_trusted_auto_attention_follows_linked_search_state(search_state, attention_required):
    row = {
        "source": "share",
        "id": f"document_share_request:{uuid4()}",
        "request_id": uuid4(),
        "bucket": "incoming_requests",
        "status": "pending",
        "issued_at": 0,
        "direction": "incoming",
        "state": "pending",
        "revision": 1,
        "preparation_error_code": "trusted_auto_active",
        "owner_search_state": search_state,
        "trusted_authority_ready": True,
        "trusted_batch_seen": False,
        "trusted_work_active": True,
        "trusted_recovery_needed": False,
    }
    assert entry(row)["metadata"]["owner_attention_required"] is attention_required


def test_consent_projects_locked_quote_and_owner_setup_without_an_order():
    row = {
        "source": "share",
        "id": f"document_share_request:{uuid4()}",
        "request_id": uuid4(),
        "bucket": "outgoing_requests",
        "status": "pending",
        "issued_at": 0,
        "direction": "outgoing",
        "state": "pending",
        "revision": 0,
        "quoted_amount_cents": 2500,
        "quote_version": 2,
        "payment_status": None,
    }
    requester = entry(row)["metadata"]
    assert (requester["quotedAmountCents"], requester["quoteVersion"]) == (2500, 2)
    assert requester["paymentRequired"] is True
    assert "ownerPayoutAccountReady" not in requester

    row.update(
        bucket="incoming_requests",
        direction="incoming",
        owner_payout_account_ready=False,
    )
    owner = entry(row)["metadata"]
    assert owner["ownerPayoutAccountReady"] is False
    assert "quotedAmountCents" not in owner


@pytest.mark.parametrize("direction", ["incoming", "outgoing"])
def test_new_request_setup_projects_bank_before_price_and_clears_after_resume(direction):
    row = {
        "source": "share",
        "id": f"document_share_request:{uuid4()}",
        "request_id": uuid4(),
        "bucket": f"{direction}_requests",
        "status": "pending",
        "issued_at": 0,
        "direction": direction,
        "state": "pending",
        "revision": 0,
        "quoted_amount_cents": None,
        "preparation_error_code": "owner_payout_required",
        "owner_payout_account_ready": False,
    }
    projected = entry(row)
    assert projected["scope_description"] == (
        "Link payouts" if direction == "incoming" else "Waiting for owner setup"
    )
    assert projected["metadata"]["ownerPriceRequired"] is True
    assert projected["metadata"]["ownerPayoutAccountReady"] is False
    assert projected["metadata"]["automatic_progress_active"] is False
    row.update(owner_payout_account_ready=True, preparation_error_code="owner_price_required")
    projected = entry(row)
    assert projected["scope_description"] == (
        "Set price" if direction == "incoming" else "Waiting for price"
    )
    row.update(
        quoted_amount_cents=1200, quote_version=1, preparation_error_code="trusted_auto_queued"
    )
    assert "ownerPriceRequired" not in entry(row)["metadata"]
    row.update(
        payment_status="paid",
        preparation_error_code="owner_price_required",
        payment_amount_cents=1200,
        payment_currency="usd",
        payment_reconciliation_required=False,
        payment_link_expired=False,
    )
    assert "ownerPriceRequired" not in entry(row)["metadata"]


def test_trusted_price_only_projection_requires_current_ready_trust_and_payouts():
    row = {
        "source": "share",
        "id": f"document_share_request:{uuid4()}",
        "request_id": uuid4(),
        "bucket": "incoming_requests",
        "status": "pending",
        "issued_at": 0,
        "direction": "incoming",
        "state": "pending",
        "revision": 0,
        "quoted_amount_cents": None,
        "preparation_error_code": "owner_price_required",
        "owner_price_ready": True,
        "owner_payout_account_ready": True,
    }
    assert entry(row)["metadata"]["owner_price_available"] is True
    assert entry(row)["metadata"]["owner_decision_available"] is False
    for update in [
        {"owner_price_ready": False},
        {"owner_payout_account_ready": False},
        {"state": "expired"},
        {"direction": "outgoing"},
        {"access_stopped": True},
    ]:
        assert entry({**row, **update})["metadata"]["owner_price_available"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "initially_trusted,default_amount_cents", [(True, None), (False, None), (False, 1200)]
)
async def test_trusted_price_action_real_projection_and_later_trust_transition(
    sharing, monkeypatch, initially_trusted, default_amount_cents
):
    created = await trusted_unpriced_request(
        sharing, monkeypatch, trusted=initially_trusted, default_amount_cents=default_amount_cents
    )
    identity = created["requestId"]
    projection = DriveSharingCenterContributor(db=sharing.db)
    if not initially_trusted:
        before = (await projection.page("owner", bucket="incoming_requests", limit=20))["items"][0]
        assert before["metadata"]["owner_decision_available"] is True
        assert before["metadata"]["owner_price_available"] is False
        assert stored_request(sharing, identity)[1].get("trusted_auto") is not True
        with sharing.db.engine.begin() as connection:
            connection.execute(
                text("""INSERT INTO one_location_circle_memberships
              SELECT id,'recipient','active' FROM one_location_circles WHERE owner_user_id='owner'""")
            )
    current = (await projection.page("owner", bucket="incoming_requests", limit=20))["items"][0]
    assert current["metadata"]["owner_price_available"] is True
    assert current["metadata"]["owner_decision_available"] is False
    owner_review = await sharing.owner_review(user_id="owner", request_id=identity)
    assert owner_review["priceOnlyAvailable"] is True
    await sharing.set_request_price(
        user_id="owner", request_id=identity, revision=created["revision"], amount_cents=700
    )
    row, private = stored_request(sharing, identity)
    assert private["trusted_auto"] is True and "owner_allowed" not in private
    assert row["owner_allowed_at"] is None and row["quoted_amount_cents"] == 700
    await sharing.trusted_request_authority(user_id="owner", request_id=identity)
    after = (await projection.page("owner", bucket="incoming_requests", limit=20))["items"][0]
    assert after["metadata"]["owner_price_available"] is False
    assert after["metadata"]["automatic_progress_active"] is True


@pytest.mark.asyncio
async def test_trusted_request_price_never_bypasses_background_opt_out(sharing, monkeypatch):
    created = await trusted_unpriced_request(sharing, monkeypatch)
    identity = created["requestId"]
    await DriveLivePreferences(db=sharing.db).set_background(
        user_id="owner", enabled=False, confirmed=True
    )
    projection = DriveSharingCenterContributor(db=sharing.db)
    current = (await projection.page("owner", bucket="incoming_requests", limit=20))["items"][0]
    assert current["metadata"]["owner_price_available"] is False
    assert not (await sharing.owner_review(user_id="owner", request_id=identity))[
        "priceOnlyAvailable"
    ]
    with pytest.raises(DriveReadError, match="background_preparation_required"):
        await sharing.set_request_price(
            user_id="owner", request_id=identity, revision=created["revision"], amount_cents=700
        )
    assert stored_request(sharing, identity)[0]["quoted_amount_cents"] is None


def test_background_setup_label_is_owner_only_and_clears_on_resume():
    row = {
        "source": "share",
        "id": f"document_share_request:{uuid4()}",
        "request_id": uuid4(),
        "bucket": "incoming_requests",
        "status": "pending",
        "issued_at": 0,
        "direction": "incoming",
        "state": "pending",
        "revision": 1,
        "preparation_error_code": "background_preparation_required",
        "owner_search_state": None,
        "trusted_authority_ready": False,
        "trusted_batch_seen": False,
        "trusted_work_active": False,
        "trusted_recovery_needed": False,
    }
    assert entry(row)["scope_description"] == "Enable background Drive access"
    row["bucket"] = "outgoing_requests"
    row["direction"] = "outgoing"
    assert entry(row)["scope_description"] == "Google Drive files"
    row["bucket"] = "incoming_requests"
    row["direction"] = "incoming"
    row["preparation_error_code"] = "trusted_auto_queued"
    assert entry(row)["scope_description"] == "Google Drive files"


def test_trusted_progress_stays_visible_after_first_confirmed_grant():
    row = {
        "source": "share",
        "id": f"document_share_request:{uuid4()}",
        "request_id": uuid4(),
        "bucket": "active_grants",
        "status": "active",
        "issued_at": 0,
        "direction": "outgoing",
        "state": "pending",
        "revision": 1,
        "preparation_error_code": "trusted_auto_active",
        "owner_search_state": "running",
        "trusted_authority_ready": True,
        "trusted_batch_seen": True,
        "trusted_work_active": True,
        "trusted_recovery_needed": False,
    }
    item = entry(row)
    assert item["kind"] == "active_grant"
    assert item["metadata"]["automatic_progress_active"] is True
    assert item["metadata"]["automatic_progress_stage"] == "sharing"
    row["trusted_recovery_needed"] = True
    assert entry(row)["metadata"]["automatic_progress_active"] is False
    row["trusted_recovery_needed"] = False
    row["state"] = "completed"
    assert entry(row)["metadata"]["automatic_progress_active"] is False


@pytest.mark.parametrize("payment_status", ["awaiting_payment", "checkout_open"])
def test_owner_waits_for_requester_payment_without_approval_task(payment_status):
    row = {
        "source": "share",
        "id": f"document_share_request:{uuid4()}",
        "request_id": uuid4(),
        "bucket": "incoming_requests",
        "status": "pending",
        "issued_at": 0,
        "direction": "incoming",
        "state": "pending",
        "revision": 1,
        "preparation_error_code": "trusted_auto_active",
        "owner_search_state": "completed",
        "trusted_authority_ready": True,
        "trusted_batch_seen": True,
        "trusted_work_active": True,
        "trusted_recovery_needed": False,
        "payment_status": payment_status,
        "payment_reconciliation_required": False,
    }
    item = entry(row)
    assert item["scope_description"] == "Waiting for requester payment"
    assert item["metadata"]["payment_waiting_for_requester"] is True
    assert item["metadata"]["automatic_progress_active"] is False
    assert item["metadata"]["owner_attention_required"] is False
    assert "paymentStatus" not in item["metadata"]
    row["state"] = "expired"
    row["bucket"] = "history"
    assert entry(row)["scope_description"] == "Google Drive files"


def test_access_stop_is_not_an_owner_task_or_payment_prompt():
    row = {
        "source": "share",
        "id": f"document_share_request:{uuid4()}",
        "request_id": uuid4(),
        "bucket": "history",
        "status": "stopped",
        "issued_at": 0,
        "direction": "incoming",
        "state": "pending",
        "revision": 1,
        "preparation_error_code": None,
        "owner_search_state": "running",
        "trusted_authority_ready": True,
        "trusted_batch_seen": True,
        "trusted_work_active": True,
        "trusted_recovery_needed": False,
        "payment_status": "awaiting_payment",
        "payment_amount_cents": 1000,
        "payment_currency": "usd",
        "payment_reconciliation_required": False,
        "payment_link_expired": False,
        "checkout_expires_at": None,
        "access_stopped": True,
    }
    owner = entry(row)
    assert owner["metadata"]["accessStopped"] is True
    assert owner["metadata"]["owner_attention_required"] is False
    assert "payment_waiting_for_requester" not in owner["metadata"]
    row["direction"] = "outgoing"
    requester = entry(row)
    assert requester["metadata"]["accessStopped"] is True
    assert requester["metadata"]["paymentStatus"] == "awaiting_payment"


@pytest.mark.asyncio
async def test_legacy_sqlite_has_no_drive_projection_or_postgres_transaction():
    engine = create_engine("sqlite://")
    try:
        projection = DriveSharingCenterContributor(db=SimpleNamespace(engine=engine))
        with patch.object(projection, "_transaction", new_callable=AsyncMock) as transaction:
            counts = await projection.counts("owner")
            assert counts == {
                "incoming_requests": 0,
                "outgoing_requests": 0,
                "active_grants": 0,
                "history": 0,
                "schema_available": False,
            }
            assert await projection.page("owner", bucket="history", limit=10) == {
                "total": 0,
                "items": [],
                "schema_available": False,
            }
            preview = await projection.preview("owner")
            assert preview["schema_available"] is False
            assert all(value == [] for value in preview["buckets"].values())
            assert all(value == 0 for value in preview["counts"].values())
            with pytest.raises(ValueError, match="invalid_document_projection_page"):
                await projection.page("owner", bucket="arbitrary", limit=10)
            transaction.assert_not_called()
    finally:
        engine.dispose()


def center(store):
    service = ConsentCenterService.__new__(ConsentCenterService)
    service._drive_center = DriveSharingCenterContributor(db=store.db)
    empty = {
        key: []
        for key in ("incoming_requests", "outgoing_requests", "active_grants", "history", "invites")
    }
    service._location_buckets_async = AsyncMock(return_value=empty)
    service._marketplace_buckets_async = AsyncMock(return_value=empty)
    service._load_investor_pending_entries = AsyncMock(return_value=[])
    service._load_investor_active_entries = AsyncMock(return_value=[])
    service._load_investor_previous_entries = AsyncMock(return_value=[])
    service._incoming_connection_request_count = AsyncMock(return_value=0)
    service._incoming_connection_request_entries = AsyncMock(return_value=[])
    service._load_connection_entries_for_actor = AsyncMock(return_value=[])
    return service


@pytest.mark.asyncio
async def test_background_setup_appears_only_in_the_owner_request(sharing):
    created = await request(sharing)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests
              SET preparation_error_code='background_preparation_required'
              WHERE request_id=:request_id"""),
            {"request_id": created["requestId"]},
        )
    projection = DriveSharingCenterContributor(db=sharing.db)
    owner = await projection.page("owner", bucket="incoming_requests", limit=20)
    requester = await projection.page("recipient", bucket="outgoing_requests", limit=20)
    assert owner["items"][0]["scope_description"] == "Enable background Drive access"
    assert owner["items"][0]["metadata"]["owner_attention_required"] is True
    assert requester["items"][0]["scope_description"] == "Google Drive files"
    assert (
        await projection.page(
            "owner", bucket="incoming_requests", limit=20, query="background Drive access"
        )
    )["total"] == 1
    assert (
        await projection.page(
            "recipient", bucket="outgoing_requests", limit=20, query="background Drive access"
        )
    )["total"] == 0


@pytest.mark.asyncio
async def test_requester_can_reopen_payment_from_consent_center(sharing):
    created = await request(sharing)
    request_id = created["requestId"]
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET payment_required=TRUE WHERE request_id=:request"),
            {"request": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (request_id,user_id,requester_user_id,stripe_mode,status)
              VALUES (:request,'owner','recipient','test','awaiting_payment')"""),
            {"request": request_id},
        )
    projection = DriveSharingCenterContributor(db=sharing.db)
    requester = (await projection.page("recipient", bucket="outgoing_requests", limit=1))["items"][
        0
    ]
    assert requester["metadata"]["paymentStatus"] == "awaiting_payment"
    assert requester["metadata"]["paymentAmountCents"] == 1000
    assert requester["metadata"]["paymentCurrency"] == "usd"
    assert requester["metadata"]["automatic_progress_active"] is False
    assert (await sharing.request_status(user_id="recipient", request_id=request_id))[
        "paymentStatus"
    ] == "awaiting_payment"
    assert "paymentStatus" not in await sharing.request_status(
        user_id="owner", request_id=request_id
    )
    owner = (await projection.page("owner", bucket="incoming_requests", limit=1))["items"][0]
    assert "paymentStatus" not in owner["metadata"]
    assert owner["scope_description"] == "Waiting for requester payment"
    assert owner["metadata"]["owner_attention_required"] is False
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_request_payment_orders SET status='checkout_open'
              WHERE request_id=:request"""),
            {"request": request_id},
        )
    reopened = (await projection.page("recipient", bucket="outgoing_requests", limit=1))["items"][0]
    assert reopened["metadata"]["paymentStatus"] == "checkout_open"
    owner_reopened = (await projection.page("owner", bucket="incoming_requests", limit=1))["items"][
        0
    ]
    assert owner_reopened["scope_description"] == "Waiting for requester payment"
    assert owner_reopened["metadata"]["owner_attention_required"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("stored_mode", ["test", "legacy"])
async def test_live_projection_expires_foreign_mode_payment(sharing, monkeypatch, stored_mode):
    request_id = (await request(sharing))["requestId"]
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET payment_required=TRUE WHERE request_id=:id"),
            {"id": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (request_id,user_id,requester_user_id,stripe_mode,status)
              VALUES (:id,'owner','recipient',:mode,'checkout_open')"""),
            {"id": request_id, "mode": stored_mode},
        )
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("STRIPE_MODE", "live")
    projection = DriveSharingCenterContributor(db=sharing.db)
    result = await projection.page("recipient", bucket="outgoing_requests", limit=1)
    assert result["items"][0]["metadata"]["paymentStatus"] == "expired"
    with sharing.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT status FROM drive_request_payment_orders WHERE request_id=:id"),
                {"id": request_id},
            ).scalar_one()
            == "checkout_open"
        )


@pytest.mark.asyncio
async def test_zero_match_history_uses_neutral_recipient_state(sharing):
    created = await request(sharing)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET status='no_match' WHERE request_id=:request_id"),
            {"request_id": created["requestId"]},
        )
    projection = DriveSharingCenterContributor(db=sharing.db)
    owner = await projection.page("owner", bucket="history", limit=20)
    recipient = await projection.page("recipient", bucket="history", limit=20)
    assert owner["items"][0]["status"] == "no_match"
    assert recipient["items"][0]["status"] == "no_files_shared"
    assert recipient["items"][0]["metadata"]["state"] == "no_files_shared"


@pytest.mark.asyncio
async def test_metadata_only_previews_counts_and_filtered_pages(sharing, monkeypatch):
    # Production has this cache; its timestamps overlap the request projection.
    # Exercise the joined path, including both participants and a nonparticipant.
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""
            CREATE TABLE actor_identity_cache (
              user_id TEXT PRIMARY KEY, display_name TEXT,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
        )
        connection.execute(
            text("""
            INSERT INTO actor_identity_cache (user_id, display_name)
            VALUES ('owner', 'Document owner'), ('recipient', 'Requester'),
              ('stranger', 'Unrelated person')
        """)
        )
    for _ in range(61):
        await request(sharing)
    projection = DriveSharingCenterContributor(db=sharing.db)
    monkeypatch.delenv("DRIVE_SHARING_KEY_V1")
    monkeypatch.delenv("DRIVE_DOCUMENT_KEY_V1")
    monkeypatch.setenv("DRIVE_DOCUMENT_SHARING", "false")
    snapshot = await projection.preview("owner")
    assert snapshot["counts"]["incoming_requests"] == 61
    assert snapshot["buckets"]["incoming_requests"][0]["counterpart_label"] == "Requester"
    assert len(snapshot["buckets"]["incoming_requests"]) == 50
    assert (await projection.counts("recipient"))["incoming_requests"] == 0
    assert (await projection.counts("recipient"))["outgoing_requests"] == 61
    assert (await projection.counts("stranger"))["incoming_requests"] == 0
    assert (await projection.page("stranger", bucket="incoming_requests", limit=20))["total"] == 0
    page = await projection.page("owner", bucket="incoming_requests", limit=20, offset=60)
    assert page["total"] == 61 and len(page["items"]) == 1
    assert (await projection.page("owner", bucket="incoming_requests", limit=20, offset=9999))[
        "total"
    ] == 61
    assert (await projection.page("owner", bucket="incoming_requests", limit=20, query="%"))[
        "total"
    ] == 0
    assert (
        await projection.page(
            "owner", bucket="incoming_requests", limit=20, query="private six-month"
        )
    )["total"] == 0
    row = page["items"][0]
    assert row["scope"] is None and isinstance(row["issued_at"], int)
    assert set(row["metadata"]) == {
        "request_source",
        "request_id",
        "direction",
        "state",
        "revision",
        "recorded_outcome_only",
        "automatic_progress_active",
        "automatic_progress_stage",
        "accessStopped",
        "owner_attention_required",
        "owner_decision_available",
        "owner_price_available",
        "owner_allowed",
        "payment_required",
    }
    assert row["metadata"]["owner_attention_required"] is True
    assert "recipient@example" not in str(snapshot) and "purpose" not in str(snapshot)
    assert (
        await projection.page(
            "owner", bucket="incoming_requests", limit=20, query=row["request_id"]
        )
    )["total"] == 1
    service = center(sharing)
    service._owned_user_identifiers = AsyncMock(return_value=[])
    service._hydrate_entry_identities = AsyncMock(side_effect=lambda entries: entries)
    service._consent_db = MagicMock()
    service._consent_db.get_pending_requests = AsyncMock(return_value=[])
    service._consent_db.get_active_tokens = AsyncMock(return_value=[])
    service._consent_db.get_audit_log = AsyncMock(return_value={"items": []})
    service._consent_db.get_internal_activity_summary = AsyncMock(return_value={})
    legacy = await service.get_center("owner", actor="investor")
    assert len(legacy["incoming_requests"]) == 50
    assert legacy["summary"]["incoming_requests"] == 61
    # B can rediscover every pending request after reload, without a Drive
    # credential, document key, feature admission or A's private suggestions.
    seen = []
    for page_number in range(1, 5):
        sent = await service.list_center(
            "recipient",
            actor="investor",
            surface="pending",
            request_view="sent",
            page=page_number,
            limit=20,
        )
        assert sent["total"] == 61 and sent["request_view"] == "sent"
        seen.extend(sent["items"])
    assert len({item["id"] for item in seen}) == 61
    assert all(
        item["metadata"]["direction"] == "outgoing" and item["scope"] is None for item in seen
    )
    assert (
        await service.list_center(
            "stranger", actor="investor", surface="pending", request_view="sent"
        )
    )["total"] == 0
    assert (
        await service.list_center("owner", actor="investor", surface="pending", request_view="sent")
    )["total"] == 0
    assert (await service.list_center("recipient", actor="investor", surface="pending"))[
        "total"
    ] == 0


@pytest.mark.asyncio
async def test_trusted_auto_progress_never_claims_owner_attention(sharing, request_bulk):
    created = await request(sharing)
    request_id = created["requestId"]
    projection = DriveSharingCenterContributor(db=sharing.db)

    async def attention() -> bool:
        page = await projection.page("owner", bucket="incoming_requests", limit=1)
        assert page["total"] == 1
        return page["items"][0]["metadata"]["owner_attention_required"]

    assert await attention() is True  # Ordinary request: owner review.
    with sharing.db.engine.begin() as connection:
        circle_id = str(uuid4())
        connection.execute(
            text("INSERT INTO one_location_circles VALUES (:id,'owner','trusted','active')"),
            {"id": circle_id},
        )
        connection.execute(
            text("INSERT INTO one_location_circle_memberships VALUES (:id,'recipient','active')"),
            {"id": circle_id},
        )
    # An absent preference is the default-on state for a verified live Drive
    # connection; the projection must agree with the worker authority check.
    with sharing.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_live_preferences WHERE user_id='owner'")
            ).scalar_one()
            == 0
        )
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_share_requests SET preparation_error_code='trusted_auto_queued' WHERE request_id=:id"
            ),
            {"id": request_id},
        )
    assert await attention() is False  # Queued request awaiting its first search job.

    job_id = str(uuid4())
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""
                INSERT INTO drive_owner_search_jobs
                  (job_id,user_id,client_request_id,request_digest,connection_generation,
                   consent_version,status,checkpoint_envelope)
                VALUES (:job,'owner',:id,:digest,1,'drive-owner-search-v1',
                        'queued','{}'::jsonb)
            """),
            {"job": job_id, "id": request_id, "digest": "a" * 64},
        )
        connection.execute(
            text("""INSERT INTO drive_owner_search_results
              (job_id,user_id,position,file_digest,metadata_envelope)
              VALUES (:job,'owner',1,:digest,'{}'::jsonb)"""),
            {"job": job_id, "digest": "b" * 64},
        )
        connection.execute(
            text(
                "UPDATE drive_share_requests SET preparation_error_code='trusted_auto_active' WHERE request_id=:id"
            ),
            {"id": request_id},
        )
    for state in ("queued", "running", "completed"):
        with sharing.db.engine.begin() as connection:
            connection.execute(
                text("UPDATE drive_owner_search_jobs SET status=:state WHERE job_id=:job"),
                {"state": state, "job": job_id},
            )
        assert await attention() is False

    # release() can fail the job without updating the request's trusted_auto_active
    # marker. The Feed must surface the owner task using the linked job state.
    for state in ("failed", "limited", "stopped"):
        with sharing.db.engine.begin() as connection:
            connection.execute(
                text("UPDATE drive_owner_search_jobs SET status=:state WHERE job_id=:job"),
                {"state": state, "job": job_id},
            )
        assert await attention() is True

    with sharing.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_owner_search_jobs SET status='completed',expires_at=clock_timestamp() - INTERVAL '1 second' WHERE job_id=:job"
            ),
            {"job": job_id},
        )
    assert await attention() is True

    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("DELETE FROM drive_owner_search_jobs WHERE job_id=:job"), {"job": job_id}
        )
    assert await attention() is True

    # Background setup, a changed relationship, terminal preparation failure,
    # and explicit manual takeover all restore an owner task.
    for code in (
        "background_preparation_required",
        "trusted_relationship_changed",
        "preparation_unavailable",
        "manual_search_active",
    ):
        with sharing.db.engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE drive_share_requests SET preparation_error_code=:code WHERE request_id=:id"
                ),
                {"code": code, "id": request_id},
            )
        assert await attention() is True


@pytest.mark.asyncio
async def test_trusted_progress_is_participant_scoped_and_tracks_durable_work(
    sharing, request_bulk
):
    circle_id = str(uuid4())
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("INSERT INTO one_location_circles VALUES (:id,'owner','trusted','active')"),
            {"id": circle_id},
        )
        connection.execute(
            text("INSERT INTO one_location_circle_memberships VALUES (:id,'recipient','active')"),
            {"id": circle_id},
        )
    preference = DriveLivePreferences(db=sharing.db)
    await preference.set_background(user_id="owner", enabled=True, confirmed=True)
    created = await request(sharing)
    request_id = created["requestId"]
    projection = DriveSharingCenterContributor(db=sharing.db)

    async def participants(stage: str | None, active: bool) -> None:
        owner = (await projection.page("owner", bucket="incoming_requests", limit=1))["items"][0]
        recipient = (await projection.page("recipient", bucket="outgoing_requests", limit=1))[
            "items"
        ][0]
        assert owner["id"] == recipient["id"] == f"document_share_request:{request_id}"
        assert (owner["kind"], recipient["kind"]) == ("incoming_request", "outgoing_request")
        for item in (owner, recipient):
            assert item["metadata"]["automatic_progress_active"] is active
            assert item["metadata"]["automatic_progress_stage"] == stage
            assert "Private six-month statements" not in str(item)
            assert "recipient@example" not in str(item)
        assert owner["metadata"]["owner_attention_required"] is not active

    await participants("preparing", True)
    job_id = str(uuid4())
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_owner_search_jobs
              (job_id,user_id,client_request_id,request_digest,connection_generation,
               consent_version,status,checkpoint_envelope)
              VALUES (:job,'owner',:request,:digest,1,'drive-owner-search-v1',
                'queued','{}'::jsonb)"""),
            {"job": job_id, "request": request_id, "digest": "a" * 64},
        )
        connection.execute(
            text("""UPDATE drive_share_requests SET preparation_error_code='trusted_auto_active',
              bulk_search_started_at=clock_timestamp() WHERE request_id=:request"""),
            {"request": request_id},
        )
    await participants("finding", True)
    share_id = str(uuid4())
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_bulk_shares
              (share_id,user_id,search_job_id,client_request_id,request_digest,
               connection_generation,search_revision,review_digest,status,file_count,
               recipient_count,excluded_envelope,origin_request_id,origin_request_revision,
               progressive_batch,approval_source,approved_at)
              VALUES (:share,'owner',:job,:client,:digest,1,1,:review,'queued',1,
                1,'{}'::jsonb,:request,0,TRUE,'trusted_auto',clock_timestamp())"""),
            {
                "share": share_id,
                "job": job_id,
                "client": str(uuid4()),
                "digest": "a" * 64,
                "review": "b" * 64,
                "request": request_id,
            },
        )
    await participants("sharing", True)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_owner_search_jobs SET status='completed' WHERE job_id=:job"),
            {"job": job_id},
        )
    await participants("sharing", True)  # Search done; Drive grants still queued.

    await preference.set_background(user_id="owner", enabled=False, confirmed=True)
    await participants(None, False)
    await preference.set_background(user_id="owner", enabled=True, confirmed=True)
    await participants("sharing", True)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE one_location_circle_memberships SET status='removed'
              WHERE circle_id=:circle AND user_id='recipient'"""),
            {"circle": circle_id},
        )
    await participants(None, False)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE one_location_circle_memberships SET status='active'
              WHERE circle_id=:circle AND user_id='recipient'"""),
            {"circle": circle_id},
        )
        connection.execute(
            text("UPDATE drive_owner_search_jobs SET status='failed' WHERE job_id=:job"),
            {"job": job_id},
        )
    await participants(None, False)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_owner_search_jobs SET status='completed' WHERE job_id=:job"),
            {"job": job_id},
        )
        connection.execute(
            text("UPDATE drive_bulk_shares SET status='completed' WHERE share_id=:share"),
            {"share": share_id},
        )
    await participants(None, False)  # Nothing is in flight; owner can recover if needed.
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests SET
              created_at=clock_timestamp()-INTERVAL '31 days',
              expires_at=clock_timestamp()-INTERVAL '1 day'
              WHERE request_id=:request"""),
            {"request": request_id},
        )
    expired = (await projection.page("owner", bucket="history", limit=1))["items"][0]
    assert expired["metadata"]["automatic_progress_active"] is False
    assert expired["metadata"]["automatic_progress_stage"] is None


@pytest.mark.asyncio
async def test_owner_decision_is_offered_only_for_fresh_requests_outside_trust(
    sharing, request_bulk
):
    projection = DriveSharingCenterContributor(db=sharing.db)

    async def items(user_id: str) -> dict[str, dict]:
        preview = await projection.preview(user_id)
        return {
            item["request_id"]: item for bucket in preview["buckets"].values() for item in bucket
        }

    _membership(sharing, "active")
    trusted = (await _request(sharing))["requestId"]
    _membership(sharing, "removed")
    fresh, allowed, started, expired = [(await _request(sharing))["requestId"] for _ in range(4)]
    owner_initiated = (await _request(sharing, owner_initiated=True))["requestId"]
    await sharing.allow_request(user_id="owner", request_id=allowed, revision=0, amount_cents=2000)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests SET bulk_search_started_at=clock_timestamp()
              WHERE request_id=:request"""),
            {"request": started},
        )
        connection.execute(
            text("""UPDATE drive_share_requests SET
              created_at=clock_timestamp()-INTERVAL '31 days',
              expires_at=clock_timestamp()-INTERVAL '1 day'
              WHERE request_id=:request"""),
            {"request": expired},
        )
    owner = await items("owner")
    assert {key for key, item in owner.items() if item["metadata"]["owner_decision_available"]} == {
        fresh
    }
    assert owner[trusted]["metadata"]["owner_allowed"] is False
    assert owner[fresh]["metadata"]["owner_attention_required"] is True
    assert owner[fresh]["metadata"]["payment_required"] is True
    assert owner[owner_initiated]["metadata"]["payment_required"] is False
    # A current Trusted member keeps the Trusted path, even for a request with no
    # automatic marker (one made before the owner's Drive was live).
    _membership(sharing, "active")
    assert (await items("owner"))[fresh]["metadata"]["owner_decision_available"] is False
    _membership(sharing, "removed")
    assert (await items("owner"))[fresh]["metadata"]["owner_decision_available"] is True
    # After Allow the request leaves Needs you; both participants see the same
    # automatic progress a Trusted request shows.
    requester = await items("recipient")
    for item in (owner[allowed], requester[allowed]):
        assert item["metadata"]["owner_allowed"] is True
        assert item["metadata"]["automatic_progress_active"] is True
    assert owner[allowed]["metadata"]["owner_attention_required"] is False
    assert not any(item["metadata"]["owner_decision_available"] for item in requester.values())
    assert "payment_required" not in requester[fresh]["metadata"]

    # Allow carries automatic work only while the pair is connected.
    _connection(sharing, "removed")
    owner = await items("owner")
    assert owner[allowed]["metadata"]["automatic_progress_active"] is False
    assert owner[allowed]["metadata"]["owner_attention_required"] is True
    assert owner[fresh]["metadata"]["owner_decision_available"] is False
    # The disconnect ends the Allow, so reconnecting brings back no automatic work.
    with sharing.db.engine.begin() as connection:
        end_owner_allows_for_disconnected_pair(connection, user_a_id="owner", user_b_id="recipient")
    _connection(sharing, "active")
    owner = await items("owner")
    assert owner[allowed]["metadata"]["owner_allowed"] is False
    assert owner[allowed]["metadata"]["automatic_progress_active"] is False
    assert owner[allowed]["metadata"]["owner_attention_required"] is True
    assert owner[allowed]["metadata"]["owner_decision_available"] is False
    assert owner[fresh]["metadata"]["owner_decision_available"] is True
    # Allow/Deny needs the owner's live Drive as well.
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE user_external_connector_connections SET validation_state='unverified'
              WHERE user_id='owner' AND connector_id='google_drive'""")
        )
    assert (await items("owner"))[fresh]["metadata"]["owner_decision_available"] is False


@pytest.mark.asyncio
async def test_pending_expiry_and_private_preparation_masking(sharing):
    await review(sharing)
    projection = DriveSharingCenterContributor(db=sharing.db)
    assert (await projection.page("recipient", bucket="outgoing_requests", limit=1))["items"][0][
        "metadata"
    ]["state"] == "pending"
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_share_requests SET created_at=now()-INTERVAL '31 days',expires_at=now()-INTERVAL '1 day'"
            )
        )
    assert (await projection.counts("owner"))["incoming_requests"] == 0
    assert (await projection.page("owner", bucket="history", limit=1))["items"][0][
        "status"
    ] == "expired"


@pytest.mark.asyncio
async def test_approval_is_not_delivery_and_recorded_revocation_is_not_active(permission_setup):
    store, executor, _, ids = permission_setup
    projection = DriveSharingCenterContributor(db=store.db)
    assert (await projection.counts("owner"))["incoming_requests"] == 1
    assert (await projection.counts("owner"))["active_grants"] == 0
    await executor.grant(user_id="owner", operation_id=ids[0])
    assert (await projection.counts("owner"))["active_grants"] == 1
    assert (await projection.counts("recipient"))["active_grants"] == 1
    # A recorded removal excludes the original grant even if a later attempt
    # is pending. We never infer current Google ACL state from this projection.
    with store.db.engine.begin() as connection:
        connection.execute(
            text("""
          INSERT INTO drive_share_permission_operations(
            operation_id,user_id,request_id,review_revision,batch_id,document_id,
            connection_generation,file_lock_hmac,kind,parent_operation_id,plan_envelope,state)
          SELECT '99999999-9999-4999-8999-999999999999',user_id,request_id,review_revision,
            'synthetic-revocation',document_id,connection_generation,file_lock_hmac,'revoke',
            operation_id,plan_envelope,'absent' FROM drive_share_permission_operations
          WHERE operation_id=:id
        """),
            {"id": ids[0]},
        )
    assert (await projection.counts("owner"))["active_grants"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("v2", ["true", "false"])
async def test_summary_and_list_share_authoritative_counts(sharing, monkeypatch, v2):
    await request(sharing)
    monkeypatch.setenv("CONSENT_CENTER_SUMMARY_V2_ENABLED", v2)
    service = center(sharing)
    summary = await service.get_center_summary("owner", actor="investor")
    assert summary["counts"] == {"pending": 1, "active": 0, "previous": 0}
    listed = await service.list_center("owner", actor="investor", surface="pending")
    assert listed["total"] == 1 and len(listed["items"]) == 1
    assert (await service.get_center_summary("recipient", actor="investor"))["counts"][
        "pending"
    ] == 0
    assert (await service.get_center_summary("owner", actor="investor", mode="connections"))[
        "counts"
    ]["pending"] == 0


@pytest.mark.asyncio
async def test_mixed_source_pagination_matches_full_sort_with_ties_and_filters(sharing):
    for _ in range(61):
        await request(sharing)
    with sharing.db.engine.begin() as connection:
        connection.execute(text("UPDATE drive_share_requests SET created_at=now()"))
    service = center(sharing)
    drive = await service._drive_center.page("owner", bucket="incoming_requests", limit=100)
    stamp = drive["items"][0]["issued_at"]
    existing = [
        {
            "id": identifier,
            "issued_at": stamp + offset,
            "status": "pending",
            "counterpart_label": "Google Drive files",
        }
        for identifier, offset in (("z-new", 10000), ("a-old", -10000), ("z-tie", 0), ("a-tie", 0))
    ]
    all_items = service._sort_display_entries([*existing, *drive["items"]])
    observed = []
    for page in range(1, 9):
        result = await service._paginate_with_drive(
            existing, user_id="owner", surface="pending", page=page, limit=10, query="drive"
        )
        assert result["total"] == 65
        assert result["items"] == all_items[(page - 1) * 10 : page * 10]
        observed.extend(result["items"])
    assert len({item["id"] for item in observed}) == 65


@pytest.mark.asyncio
async def test_missing_schema_is_distinct_from_an_empty_installed_schema(sharing):
    projection = DriveSharingCenterContributor(db=sharing.db)
    assert (await projection.counts("owner"))["schema_available"] is True
    # Same search_path as the queries, not a coincidental public schema.
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text(
                "ALTER TABLE drive_share_management_contexts RENAME TO temporarily_uninstalled_management"
            )
        )
    try:
        assert (await projection.counts("owner"))["schema_available"] is False
        assert (await projection.preview("owner"))["schema_available"] is False
        assert (await projection.page("owner", bucket="history", limit=10))[
            "schema_available"
        ] is False
        service = center(sharing)
        assert (await service.get_center_summary("owner", actor="investor"))[
            "drive_projection_available"
        ] is False
    finally:
        with sharing.db.engine.begin() as connection:
            connection.execute(
                text(
                    "ALTER TABLE temporarily_uninstalled_management RENAME TO drive_share_management_contexts"
                )
            )


@pytest.mark.asyncio
async def test_sql_failures_are_not_reported_as_zero(sharing):
    projection = DriveSharingCenterContributor(db=sharing.db)
    with patch.object(projection, "_installed", side_effect=RuntimeError("synthetic unavailable")):
        for operation in (
            projection.counts("owner"),
            projection.preview("owner"),
            projection.page("owner", bucket="history", limit=10),
        ):
            with pytest.raises(RuntimeError, match="synthetic unavailable"):
                await operation


def test_display_sort_does_not_change_lifecycle_tie_reduction():
    events = [{"id": "a", "issued_at": 100}, {"id": "z", "issued_at": 100}]
    assert ConsentCenterService._sort_entries(events) == events
    assert ConsentCenterService._sort_display_entries(events) == list(reversed(events))

"""Autoshare: B pays once, then One shares every match in batches of up to 25.

Real PostgreSQL throughout. Only Google and Stripe are replaced: each search
page is committed the way the search worker commits it and handed off through
the real Trusted/Allow worker, Stripe Checkout returns a synthetic session, a
signed webhook settles it, and the buyer's Drive ACL read is a stub.
"""

# ruff: noqa: F401, F811 -- isolated PostgreSQL fixtures imported from their owners

import asyncio
import hashlib
import hmac
import json
import logging
import threading
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
import stripe
from sqlalchemy import create_engine, text

from hushh_mcp.services import drive_bulk_share_store
from hushh_mcp.services import drive_request_payment_service as payment_module
from hushh_mcp.services import drive_request_payment_store as payment_store_module
from hushh_mcp.services import drive_trusted_auto_service as trusted_module
from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.drive_owner_allowed import autoshare_request, owner_allowed_marker
from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_package_access_preflight import DrivePackageAccessPreflight
from hushh_mcp.services.drive_request_bulk_service import DriveRequestBulkService
from hushh_mcp.services.drive_request_payment_checkout_worker import (
    DriveRequestPaymentCheckoutWorker,
)
from hushh_mcp.services.drive_request_payment_service import DriveRequestPaymentService
from hushh_mcp.services.drive_request_payment_store import DriveRequestPaymentStore
from hushh_mcp.services.drive_sharing_center_contributor import DriveSharingCenterContributor
from hushh_mcp.services.drive_sharing_contract import (
    DriveSharingCipher,
    DriveSharingError,
    ShareRequestPurpose,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.drive_suggestion_store import DriveSuggestionStore
from hushh_mcp.services.drive_trusted_auto_service import DriveTrustedAutoService
from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError
from tests.services.test_drive_request_bulk_postgres import _recipient, request_bulk
from tests.services.test_drive_sharing_store import (
    MIGRATIONS,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    sharing,
)

AUTOSHARE_POLICY = "title_then_created_then_modified_v1"
REFUSAL_LOGGER = "hushh_mcp.services.drive_request_checkout_refusals"


class Flow:
    """One request from creation through payment, streaming and grants."""

    def __init__(self, sharing, bulk, monkeypatch):
        self.sharing = sharing
        self.bulk = bulk
        self.db = sharing.db
        self.wakes = []
        self.sessions = []
        self.access_status = "none"
        self.access_reads = []
        self.request_id = None
        self.job = None
        self.matched = 0
        self.pages = 0
        self.shareable = []

        async def wake(stage):
            self.wakes.append(stage)
            return True

        self.wake = wake
        # Payment and Checkout wake their lanes through the module helper.
        monkeypatch.setattr(payment_module, "wake_drive_work", wake)

        def create_session(**params):
            session_id = f"cs_test_autoshare_{len(self.sessions) + 1}"
            self.sessions.append(params)
            return {
                "id": session_id,
                "object": "checkout.session",
                "mode": params["mode"],
                "client_reference_id": params["client_reference_id"],
                "amount_total": params["line_items"][0]["price_data"]["unit_amount"],
                "currency": params["line_items"][0]["price_data"]["currency"],
                "livemode": False,
                "metadata": params["metadata"],
                "url": f"https://checkout.stripe.com/c/pay/{session_id}",
                "expires_at": params["expires_at"],
            }

        self.create_session = Mock(side_effect=create_session)
        self.payment = DriveRequestPaymentService(
            db=self.db,
            stripe_api=SimpleNamespace(
                checkout=SimpleNamespace(Session=SimpleNamespace(create=self.create_session)),
                Webhook=stripe.Webhook,
            ),
        )
        self.auto = DriveTrustedAutoService(
            sharing=sharing, bulk=bulk, payment=self.payment, wake=wake
        )

        async def inspect(preflight, *, user_id, request_id, require_current, files=None):
            # Only the live Google ACL read is replaced. Current authority and
            # the exact frozen files still come from PostgreSQL.
            await require_current()
            self.access_reads.append(len(files or []))
            context = await preflight.sharing.request_bulk_context(
                user_id=user_id, request_id=request_id
            )
            return SimpleNamespace(status=self.access_status, request_revision=context["revision"])

        monkeypatch.setattr(DrivePackageAccessPreflight, "inspect", inspect)
        real_service = DriveRequestBulkService

        def request_service(**kwargs):
            return real_service(
                **kwargs,
                search=DriveOwnerSearchService(
                    store=DriveOwnerSearchStore(db=self.db), transport=SimpleNamespace()
                ),
                recipient_identity=AsyncMock(
                    return_value=SimpleNamespace(
                        user_id="recipient",
                        subject="1234567",
                        email="b@example.invalid",
                        kind="google_provider",
                    )
                ),
            )

        monkeypatch.setattr(trusted_module, "DriveRequestBulkService", request_service)

    # -- request -------------------------------------------------------------

    async def request(self, *, trusted, allow=True, order_at_allow=True):
        await DriveLivePreferences(db=self.db).set_background(
            user_id="owner", enabled=True, confirmed=True
        )
        if trusted:
            with self.db.engine.begin() as connection:
                connection.execute(
                    text("""INSERT INTO one_location_circle_memberships
                    SELECT id,'recipient','active' FROM one_location_circles
                    WHERE owner_user_id='owner' AND system_kind='trusted'""")
                )
        today = datetime.now(UTC).date()
        created = await self.sharing.create_request(
            recipient=VerifiedGoogleRecipient(
                "recipient", "1234567", "b@example.invalid", datetime.now(UTC)
            ),
            owner_user_id="owner",
            client_request_id=str(uuid4()),
            expected_quote_version=1,
            purpose=ShareRequestPurpose(
                purpose="Standup notes from last 3 months",
                periodStart=(today - timedelta(days=90)).isoformat(),
                periodEnd=today.isoformat(),
            ),
        )
        self.request_id = created["requestId"]
        if not trusted and allow:
            await self.sharing.allow_request(
                user_id="owner",
                request_id=self.request_id,
                revision=created["revision"],
                amount_cents=1000,
            )
            if order_at_allow:
                self.order_at_allow()
        return created

    def private(self):
        with self.db.engine.connect() as connection:
            row = (
                connection.execute(
                    text("SELECT * FROM drive_share_requests WHERE request_id=:request"),
                    {"request": self.request_id},
                )
                .mappings()
                .one()
            )
        return self.sharing._open_request(dict(row))

    def order_at_allow(self):
        """The parallel pay-on-Allow change: the order exists from A's Allow.

        Its store helper inserts this exact order and payout row inside the
        Allow transaction; it is not in this branch, so the test writes it.
        """
        with self.db.engine.begin() as connection:
            row = (
                connection.execute(
                    text("""SELECT * FROM drive_share_requests
                      WHERE request_id=:request FOR UPDATE"""),
                    {"request": self.request_id},
                )
                .mappings()
                .one()
            )
            assert DriveRequestPaymentStore.ensure_order_for_approved_request(connection, dict(row))

    # -- search --------------------------------------------------------------

    async def start_search(self, *, owner_review=False, authority="trusted_auto"):
        context = await self.sharing.request_bulk_context(
            user_id="owner", request_id=self.request_id, start=True
        )
        self.job = str(uuid4())
        today = datetime.now(UTC).date()
        selection = (
            {
                "request_selection_version": 2,
                "request_time_intent": "document_coverage",
                "request_owner_review_required": True,
            }
            if owner_review
            else {
                "request_selection_version": 2,
                "request_time_intent": "document_coverage",
                "request_owner_review_required": False,
                "request_selection_policy": AUTOSHARE_POLICY,
                "agent_package_required": False,
                "requested_period": {
                    "start": (today - timedelta(days=90)).isoformat(),
                    "end": today.isoformat(),
                    "timezone": "UTC",
                },
            }
        )
        with self.db.engine.begin() as connection:
            connection.execute(
                text("""INSERT INTO drive_owner_search_jobs(
                  job_id,user_id,client_request_id,request_digest,connection_generation,
                  consent_version,status,revision,matched,pages_scanned,incomplete_search,
                  checkpoint_envelope)
                  VALUES(:job,'owner',:client,:digest,1,'drive-owner-search-v1',
                    'running',1,0,0,FALSE,CAST(:checkpoint AS jsonb))"""),
                {
                    "job": self.job,
                    "client": self.request_id,
                    "digest": self.bulk.cipher.digest("test-request", [self.job]),
                    "checkpoint": self.bulk._seal(
                        {
                            "request_origin_id": self.request_id,
                            "request_revision": context["revision"],
                            "request_shareability_version": 1,
                            "authority_mode": authority,
                            **selection,
                        },
                        user_id="owner",
                        resource_id=self.job,
                        purpose="owner-search-checkpoint",
                    ),
                },
            )

    async def page(self, shareable, *, unshareable=0):
        """Commit one provider page, then hand it off as the search worker does."""
        today = datetime.now(UTC).date().isoformat()
        rows = []
        for index in range(shareable + unshareable):
            self.matched += 1
            position = self.matched
            file_id = f"autoshare-file-{position}"
            if index < shareable:
                self.shareable.append(position)
            rows.append(
                {
                    "job": self.job,
                    "position": position,
                    "digest": self.bulk.cipher.digest("owner-search-file", [self.job, file_id]),
                    "envelope": self.bulk._seal(
                        {
                            "id": file_id,
                            "name": f"Standup notes {today} #{position}",
                            "mimeType": "application/vnd.google-apps.document",
                            "modifiedTime": f"{today}T00:00:00Z",
                            "openUrl": f"https://drive.google.com/open?id={file_id}",
                            "shareable": index < shareable,
                        },
                        user_id="owner",
                        resource_id=f"{self.job}:{position}",
                        purpose="owner-search-result",
                    ),
                }
            )
        with self.db.engine.begin() as connection:
            if rows:
                connection.execute(
                    text("""INSERT INTO drive_owner_search_results(
                      job_id,user_id,position,file_digest,metadata_envelope)
                      VALUES(:job,'owner',:position,:digest,CAST(:envelope AS jsonb))"""),
                    rows,
                )
            connection.execute(
                text("""UPDATE drive_owner_search_jobs SET matched=:matched,
                  pages_scanned=pages_scanned+1,revision=revision+1 WHERE job_id=:job"""),
                {"job": self.job, "matched": self.matched},
            )
        self.pages += 1
        await self.auto.after_search_page(user_id="owner", job_id=self.job)
        if self.pages % 4 == 0:
            # A slice holds at most four pages; the worker hands off again.
            await self.auto.after_search_slice(user_id="owner", job_id=self.job)

    async def finish(self):
        with self.db.engine.begin() as connection:
            connection.execute(
                text("""UPDATE drive_owner_search_jobs SET status='completed',
                  revision=revision+1 WHERE job_id=:job"""),
                {"job": self.job},
            )
        await self.auto.after_search_slice(user_id="owner", job_id=self.job)

    def search_status(self):
        with self.db.engine.connect() as connection:
            return connection.execute(
                text("SELECT status FROM drive_owner_search_jobs WHERE job_id=:job"),
                {"job": self.job},
            ).scalar_one()

    # -- payment -------------------------------------------------------------

    async def checkout(self):
        return await self.payment.checkout(
            requester_user_id="recipient", request_id=self.request_id
        )

    def order(self):
        with self.db.engine.connect() as connection:
            row = (
                connection.execute(
                    text("SELECT * FROM drive_request_payment_orders WHERE request_id=:request"),
                    {"request": self.request_id},
                )
                .mappings()
                .first()
            )
        return dict(row) if row is not None else None

    async def pay(self):
        """Stripe's signed checkout.session.completed for the bound session."""
        order = self.order()
        assert order["status"] == "checkout_open"
        payer_ref = hashlib.sha256(f"{self.request_id}:recipient".encode()).hexdigest()
        body = json.dumps(
            {
                "id": "evt_test_" + uuid4().hex,
                "object": "event",
                "type": "checkout.session.completed",
                "data": {
                    "object": {
                        "id": order["stripe_checkout_session_id"],
                        "object": "checkout.session",
                        "client_reference_id": self.request_id,
                        "metadata": {
                            "payment_kind": "drive_request",
                            "request_id": self.request_id,
                            "payer_ref": payer_ref,
                            "checkout_attempt_id": str(order["checkout_attempt_id"]),
                        },
                        "mode": "payment",
                        "payment_status": "paid",
                        "amount_total": order["amount_cents"],
                        "currency": "usd",
                        "livemode": False,
                        "payment_intent": "pi_test_" + uuid4().hex,
                    }
                },
            }
        ).encode()
        timestamp = int(time.time())
        signature = hmac.new(
            b"whsec_payment_test_secret", f"{timestamp}.".encode() + body, hashlib.sha256
        ).hexdigest()
        await self.payment.process_webhook(payload=body, signature=f"t={timestamp},v1={signature}")
        assert self.order()["status"] == "paid"

    # -- delivery ------------------------------------------------------------

    async def drain(self):
        """continue_batches after the search: freeze and queue what is left."""
        for _ in range(100):
            # A finished request is no longer due (due_trusted_batches).
            if self.request_status() != "pending":
                return
            if not await self.auto.share_available(user_id="owner", request_id=self.request_id):
                return
        raise AssertionError("continue_batches did not terminate")

    async def grant_all(self):
        """The bulk worker: every due grant claims under the paid recheck."""
        granted = 0
        for _ in range(50):
            due = [
                row
                for row in await self.bulk.due(limit=400)
                if row["share_id"] in set(self.batch_ids())
            ]
            if not due:
                return granted
            for row in due:
                job = await self.bulk.claim(
                    user_id=row["user_id"],
                    share_id=str(row["share_id"]),
                    position=row["position"],
                    recipient_user_id=row["recipient_user_id"],
                )
                assert job is not None
                assert await self.bulk.settle(job, state="succeeded")
                granted += 1
        raise AssertionError("grants did not terminate")

    def batch_ids(self):
        with self.db.engine.connect() as connection:
            return [
                share
                for (share,) in connection.execute(
                    text("SELECT share_id FROM drive_bulk_shares WHERE origin_request_id=:request"),
                    {"request": self.request_id},
                ).all()
            ]

    def batches(self):
        with self.db.engine.connect() as connection:
            return [
                dict(row)
                for row in connection.execute(
                    text("""SELECT share_id,file_count,status,approved_at,approval_source
                      FROM drive_bulk_shares WHERE origin_request_id=:request
                      ORDER BY created_at,share_id"""),
                    {"request": self.request_id},
                ).mappings()
            ]

    def effect_count(self):
        with self.db.engine.connect() as connection:
            return connection.execute(
                text("""SELECT count(*) FROM drive_bulk_share_effects e
                  JOIN drive_bulk_shares b ON b.share_id=e.share_id
                  WHERE b.origin_request_id=:request"""),
                {"request": self.request_id},
            ).scalar_one()

    def shared_positions(self):
        with self.db.engine.connect() as connection:
            return {
                position: count
                for position, count in connection.execute(
                    text("""SELECT f.source_position,count(*) FROM drive_bulk_share_files f
                      JOIN drive_bulk_share_effects e ON e.share_id=f.share_id
                        AND e.position=f.position
                      WHERE f.origin_request_id=:request AND e.state='succeeded'
                      GROUP BY f.source_position"""),
                    {"request": self.request_id},
                ).all()
            }

    def request_status(self):
        with self.db.engine.connect() as connection:
            return connection.execute(
                text("SELECT status FROM drive_share_requests WHERE request_id=:request"),
                {"request": self.request_id},
            ).scalar_one()


@pytest.fixture
def flow(request_bulk, sharing, monkeypatch):
    return Flow(sharing, request_bulk, monkeypatch)


def _emulate_pay_on_allow(monkeypatch):
    """The parallel pay-on-Allow change, for its own no-search-yet moment only.

    That change admits an owner-allowed autoshare request as approved payment
    authority before its search exists (payment_state's approved predicate and
    _current_checkout_authority's entry). Neither is in this branch; this
    stand-in applies the same rule so the checkout lane can be proven with it.
    """
    original = payment_store_module.request_requires_owner_review

    def review_required(connection, *, user_id, request_id, revision, **kwargs):
        row = (
            connection.execute(
                text("""SELECT request_envelope,owner_allowed_at FROM drive_share_requests
                  WHERE request_id=:request AND user_id=:owner"""),
                {"request": str(request_id), "owner": user_id},
            )
            .mappings()
            .first()
        )
        if row is not None and row["owner_allowed_at"] is not None:
            private = DriveSharingCipher().open(
                row["request_envelope"],
                user_id=user_id,
                resource_id=str(request_id),
                purpose="request",
            )
            if autoshare_request(private) and owner_allowed_marker(private) is not None:
                return False
        return original(
            connection, user_id=user_id, request_id=request_id, revision=revision, **kwargs
        )

    monkeypatch.setattr(payment_store_module, "request_requires_owner_review", review_required)
    monkeypatch.setattr(payment_module, "request_requires_owner_review", review_required)


# Shareable matches per committed page; one unshareable row rides on each page.
SCENARIOS = {
    "later_pages": [3] + [2] * 16,
    "zero": [0, 0, 0, 0, 0],
    "ten": [4, 0, 3, 3],
    "twenty_five": [10, 15],
    "twenty_six": [25, 1],
    "thirty_five": [1] * 35,
    "one_twenty": [30, 30, 30, 30],
    "three_hundred": [99, 99, 99, 3],
}


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["trusted_first_batch", "owner_allowed_order"])
@pytest.mark.parametrize("scenario", sorted(SCENARIOS))
async def test_one_payment_streams_every_match_once_in_batches_of_25(flow, path, scenario):
    pages = SCENARIOS[scenario]
    total = sum(pages)
    # An unshareable row rides on each page; an empty search has no rows.
    extra = 1 if total else 0
    trusted = path == "trusted_first_batch"
    await flow.request(trusted=trusted)
    private = flow.private()
    assert private["request_flow"] == "oct17_autoshare" and private["trusted_auto"] is True
    await flow.start_search()

    if trusted:
        # The order is created with the first frozen batch: run pages until
        # the first match, then the scheduled sharing drain opens Checkout.
        first = next((index for index, count in enumerate(pages) if count), len(pages))
        before = pages[: first + 1]
    else:
        # The order exists from A's Allow: B pays while nothing is frozen.
        assert flow.batches() == []
        assert (await flow.checkout())["checkoutUrl"].startswith("https://checkout.stripe.com/")
        before = pages[:1]
    for count in before:
        await flow.page(count, unshareable=extra)
    if trusted and total == 0:
        await flow.finish()
        # Nothing matched: no order, no checkout, no grant.
        assert flow.order() is None
        with pytest.raises(DriveSharingError, match="payment_not_ready"):
            await flow.checkout()
        assert flow.request_status() == "no_match"
        assert flow.batches() == [] and flow.effect_count() == 0
        assert flow.create_session.call_count == 0
        return
    if trusted:
        assert [batch["file_count"] for batch in flow.batches()] == [min(before[-1], 25)]
        worker = DriveRequestPaymentCheckoutWorker(flow.payment)
        assert (await worker.run(max_jobs=1, deadline_seconds=30))["outcomes"] == {"ready": 1}
    # Checkout opened while the search still runs.
    assert flow.search_status() == "running"
    order = flow.order()
    assert order["status"] == "checkout_open" and order["amount_cents"] == 1000
    view = await flow.payment.get_payment(requester_user_id="recipient", request_id=flow.request_id)
    assert view["paymentView"]["state"] == "payable"
    # Nothing is approved or granted before payment; at most one batch is held.
    assert len(flow.batches()) <= 1
    assert all(batch["approved_at"] is None for batch in flow.batches())
    assert flow.effect_count() == 0
    assert await flow.grant_all() == 0

    await flow.pay()
    for count in pages[len(before) :]:
        await flow.page(count, unshareable=extra)
    await flow.finish()
    await flow.drain()
    granted = await flow.grant_all()
    await flow.bulk.refresh_request(user_id="owner", request_id=flow.request_id)

    assert granted == total == len(flow.shareable)
    shared = flow.shared_positions()
    assert set(shared) == set(flow.shareable)
    assert set(shared.values()) <= {1}
    batches = flow.batches()
    assert all(1 <= batch["file_count"] <= 25 for batch in batches)
    assert sum(batch["file_count"] for batch in batches) == total
    assert {batch["approval_source"] for batch in batches} <= {"trusted_auto"}
    assert flow.request_status() == ("completed" if total else "no_match")
    # One payment covered the whole request.
    assert flow.create_session.call_count == 1 and flow.order()["status"] == "paid"


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["trusted_first_batch", "owner_allowed_order"])
async def test_thirty_five_page_unpaid_search_wakes_sharing_at_most_twice(flow, path):
    trusted = path == "trusted_first_batch"
    await flow.request(trusted=trusted)
    await flow.start_search()
    for _ in range(35):
        await flow.page(1, unshareable=1)
        # The worker also resumes committed batches around each slice.
        await flow.auto.continue_batches(max_jobs=2)
    await flow.finish()
    await flow.auto.continue_batches(max_jobs=2)

    # 35 page handoffs, 8 slice ends and the final slice of an unpaid order:
    # only the handoff that created the order (first-batch path) wakes the
    # Checkout lane. The order from A's Allow was woken by the Allow itself.
    assert flow.wakes.count("sharing") <= 2
    assert flow.wakes.count("sharing") == (1 if trusted else 0)
    assert flow.order()["status"] == "awaiting_payment"
    assert [batch["file_count"] for batch in flow.batches()] == [1]
    assert flow.effect_count() == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("parked", [False, True])
async def test_finished_owner_allowed_search_resumes_held_batch_after_payment(
    flow, monkeypatch, parked
):
    """The scheduled drain must recover a paid request after Search has ended."""
    _emulate_pay_on_allow(monkeypatch)
    await flow.request(trusted=False)
    await flow.start_search()
    await flow.page(35, unshareable=1)
    await flow.finish()
    assert flow.search_status() == "completed"
    assert flow.request_status() == "pending"
    assert [batch["file_count"] for batch in flow.batches()] == [25]
    assert all(batch["approved_at"] is None for batch in flow.batches())
    assert flow.effect_count() == 0
    if parked:
        # A prior worker can park an unpaid review for five minutes. Stripe's
        # paid webhook must make it due on the next pass without another Allow.
        with flow.db.engine.begin() as connection:
            connection.execute(
                text("""UPDATE drive_share_requests
                  SET preparation_error_code='payment_not_ready',
                      preparation_next_at=clock_timestamp()+INTERVAL '5 minutes'
                  WHERE request_id=:request"""),
                {"request": flow.request_id},
            )
    assert await flow.auto.continue_batches(max_jobs=2) == 0
    assert await flow.grant_all() == 0

    await flow.checkout()
    await flow.pay()
    assert await flow.auto.continue_batches(max_jobs=2) == 1
    await flow.drain()
    assert sum(batch["file_count"] for batch in flow.batches()) == 35
    assert all(batch["approval_source"] == "trusted_auto" for batch in flow.batches())
    assert flow.effect_count() == 35
    assert await flow.grant_all() == 35
    assert await flow.auto.continue_batches(max_jobs=2) == 0
    assert await flow.grant_all() == 0
    assert flow.create_session.call_count == 1


@pytest.mark.asyncio
async def test_paid_completed_search_without_batches_is_recovered_by_scheduled_drain(
    flow, monkeypatch
):
    """A completed search can have committed results but no batch handoff."""
    _emulate_pay_on_allow(monkeypatch)
    await flow.request(trusted=False)
    await flow.start_search()
    with monkeypatch.context() as handoff:
        handoff.setattr(flow.auto, "after_search_page", AsyncMock(return_value=0))
        handoff.setattr(flow.auto, "after_search_slice", AsyncMock(return_value=0))
        await flow.page(35)
        await flow.finish()
    assert flow.search_status() == "completed"
    assert flow.batches() == [] and flow.effect_count() == 0
    with flow.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests
              SET preparation_next_at=clock_timestamp()+INTERVAL '5 minutes'
              WHERE request_id=:request"""),
            {"request": flow.request_id},
        )
    assert await flow.auto.continue_batches(max_jobs=2) == 0
    assert await flow.grant_all() == 0

    await flow.checkout()
    await flow.pay()
    assert await flow.auto.continue_batches(max_jobs=2) == 1
    assert [batch["file_count"] for batch in flow.batches()] == [25, 10]
    assert flow.effect_count() == 35
    assert await flow.grant_all() == 35
    assert await flow.auto.continue_batches(max_jobs=2) == 0
    assert await flow.grant_all() == 0
    assert flow.create_session.call_count == 1


@pytest.mark.asyncio
async def test_pay_at_allow_opens_checkout_before_the_search_starts(flow, monkeypatch):
    _emulate_pay_on_allow(monkeypatch)
    await flow.request(trusted=False)
    # No search job yet: the order alone is the payment ask.
    assert (await flow.checkout())["checkoutUrl"].startswith("https://checkout.stripe.com/")
    assert flow.order()["status"] == "checkout_open"
    await flow.pay()
    await flow.start_search()
    for count in [3, 0, 30]:
        await flow.page(count, unshareable=1)
    await flow.finish()
    await flow.drain()
    assert await flow.grant_all() == 33
    assert set(flow.shared_positions()) == set(flow.shareable)
    assert all(batch["file_count"] <= 25 for batch in flow.batches())


@pytest.mark.asyncio
async def test_finished_search_without_a_shareable_match_never_opens_checkout(flow, caplog):
    await flow.request(trusted=False)
    await flow.start_search()
    await flow.page(0, unshareable=2)
    # The search finished; nothing B could receive was found.
    with flow.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_owner_search_jobs SET status='completed' WHERE job_id=:job"),
            {"job": flow.job},
        )
    caplog.set_level(logging.INFO, logger=REFUSAL_LOGGER)
    with pytest.raises(DriveSharingError, match="payment_not_ready"):
        await flow.checkout()
    assert flow.create_session.call_count == 0
    refusals = [r.getMessage() for r in caplog.records if r.name == REFUSAL_LOGGER]
    assert refusals == ["drive_request_checkout.refused reason=no_match code=payment_not_ready"]
    assert flow.request_id not in refusals[0] and "owner" not in refusals[0]


@pytest.mark.asyncio
async def test_failed_search_refuses_checkout_with_its_own_code(flow, caplog):
    await flow.request(trusted=False)
    await flow.start_search()
    await flow.page(2)
    with flow.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET status='limited',
              incomplete_search=TRUE WHERE job_id=:job"""),
            {"job": flow.job},
        )
    caplog.set_level(logging.INFO, logger=REFUSAL_LOGGER)
    with pytest.raises(DriveSharingError, match="payment_not_ready"):
        await flow.checkout()
    assert [r.getMessage() for r in caplog.records if r.name == REFUSAL_LOGGER] == [
        "drive_request_checkout.refused reason=search_failed code=payment_not_ready"
    ]
    assert flow.create_session.call_count == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("final_set", [False, True])
@pytest.mark.parametrize(
    "access,expected",
    [
        # B already has some files: they count as delivered at grant time.
        ("mixed", None),
        ("unknown", None),
        ("none", None),
        # The existing rule: B already has every file of a final set.
        ("all_existing", "request_already_accessible"),
    ],
)
async def test_existing_access_waives_only_a_final_set_b_fully_has(
    flow, final_set, access, expected
):
    await flow.request(trusted=True)
    await flow.start_search()
    await flow.page(3, unshareable=1)
    if final_set:
        # The search finished and all three matches are in the held batch.
        with flow.db.engine.begin() as connection:
            connection.execute(
                text("UPDATE drive_owner_search_jobs SET status='completed' WHERE job_id=:job"),
                {"job": flow.job},
            )
    flow.access_status = access
    if final_set and expected is not None:
        with pytest.raises(DriveSharingError, match=expected):
            await flow.checkout()
        assert flow.create_session.call_count == 0
    else:
        assert (await flow.checkout())["checkoutUrl"]
    # Only a final set is read, once; a running search needs no ACL read.
    assert flow.access_reads == ([3] if final_set else [])


@pytest.mark.asyncio
@pytest.mark.parametrize("search_status", ["running", "completed"])
async def test_owner_approved_25_of_40_reaches_checkout_and_is_granted(
    flow, sharing, search_status
):
    """Manual lane: A approves the first 25 of 40; B pays; those 25 are granted."""
    await flow.request(trusted=False, allow=False)
    private = flow.private()
    assert private["request_flow"] == "oct17_autoshare" and "trusted_auto" not in private
    await flow.start_search(owner_review=True, authority="owner")
    for _ in range(4):
        await flow.page(10)
    if search_status == "completed":
        await flow.finish()
    assert flow.batches() == []

    async def freeze(positions):
        return await flow.bulk.create_review(
            user_id="owner",
            search_job_id=flow.job,
            client_request_id=str(uuid4()),
            recipients=[_recipient("recipient", "b@example.invalid")],
            excluded=[],
            origin_request_id=flow.request_id,
            selected_positions=positions,
        )

    first = await freeze(list(range(1, 26)))
    await flow.bulk.approve(
        user_id="owner",
        share_id=first["shareId"],
        revision=first["revision"],
        review_digest=first["reviewDigest"],
    )
    # A's approval created the order; a second frozen, unapproved batch is
    # not consent and does not hold the approved files back.
    await freeze(list(range(26, 41)))
    assert flow.order()["status"] == "awaiting_payment"
    assert (await flow.checkout())["checkoutUrl"]
    # 25 of 40 is not the final set, so B's existing access cannot waive the
    # charge and Checkout reads no ACL (the existing-access waiver is tested
    # for a final set in test_manual_waiver_applies_only_to_a_final_approved_set).
    assert flow.access_reads == []
    assert flow.effect_count() == 25
    # An unpaid grant is not work (lane hygiene): due() leaves all 25 out, so
    # nothing is granted before payment, and a direct claim defers without any
    # durable change instead of raising payment_required.
    assert await flow.grant_all() == 0
    with flow.db.engine.connect() as connection:
        effect = (
            connection.execute(
                text("""SELECT e.user_id,e.share_id,e.position,e.recipient_user_id
                  FROM drive_bulk_share_effects e
                  JOIN drive_bulk_shares b ON b.share_id=e.share_id
                  WHERE b.origin_request_id=:request
                  ORDER BY e.position LIMIT 1"""),
                {"request": flow.request_id},
            )
            .mappings()
            .one()
        )
    assert (
        await flow.bulk.claim(
            user_id=effect["user_id"],
            share_id=str(effect["share_id"]),
            position=effect["position"],
            recipient_user_id=effect["recipient_user_id"],
        )
        is None
    )
    with flow.db.engine.connect() as connection:
        untouched = connection.execute(
            text("""SELECT count(*) FROM drive_bulk_share_effects e
              JOIN drive_bulk_shares b ON b.share_id=e.share_id
              WHERE b.origin_request_id=:request AND e.state='queued'
                AND e.attempts=0 AND e.lease_id IS NULL"""),
            {"request": flow.request_id},
        ).scalar_one()
    assert untouched == 25
    assert flow.shared_positions() == {}
    await flow.pay()
    assert await flow.grant_all() == 25
    assert set(flow.shared_positions()) == set(range(1, 26))


@pytest.mark.asyncio
@pytest.mark.parametrize("approved", [5, 10])
async def test_manual_waiver_applies_only_to_a_final_approved_set(flow, approved):
    """B already has every file A approved. That waives the charge only when
    A's approvals are the final set: the search finished and A approved every
    shareable match. Approvals so far (5 of 10) may still grow, so B pays."""
    await flow.request(trusted=False, allow=False)
    await flow.start_search(owner_review=True, authority="owner")
    await flow.page(10, unshareable=1)
    await flow.finish()
    flow.access_status = "all_existing"
    for first, last in ((1, 5), (6, 10))[: approved // 5]:
        review = await flow.bulk.create_review(
            user_id="owner",
            search_job_id=flow.job,
            client_request_id=str(uuid4()),
            recipients=[_recipient("recipient", "b@example.invalid")],
            excluded=[],
            origin_request_id=flow.request_id,
            selected_positions=list(range(first, last + 1)),
        )
        await flow.bulk.approve(
            user_id="owner",
            share_id=review["shareId"],
            revision=review["revision"],
            review_digest=review["reviewDigest"],
        )
    if approved == 10:
        with pytest.raises(DriveSharingError, match="request_already_accessible"):
            await flow.checkout()
        assert flow.create_session.call_count == 0
        assert flow.access_reads == [10]
    else:
        assert (await flow.checkout())["checkoutUrl"]
        assert flow.access_reads == []


@pytest.mark.asyncio
@pytest.mark.parametrize("link_opened", ["after_approval", "before_takeover"])
async def test_allowed_request_a_took_over_is_paid_for_a_approved_batch(flow, caplog, link_opened):
    """Automatic sharing stopped (the search failed) and A took the allowed
    request over with Search again: A now selects its files. A approves 25 of
    40; B can pay for them, on a new link or on the one opened before the
    takeover, and Stripe's paid event is kept, not refunded."""
    await flow.request(trusted=False)
    assert flow.order()["status"] == "awaiting_payment"
    await flow.start_search()
    if link_opened == "before_takeover":
        assert (await flow.checkout())["checkoutUrl"]
    with flow.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET status='failed',
              error_code='provider_unavailable' WHERE job_id=:job"""),
            {"job": flow.job},
        )
    resumed = await DriveOwnerSearchStore(db=flow.db).takeover_request(
        user_id="owner", request_id=flow.request_id
    )
    assert resumed is not None and resumed["status"] == "queued"
    for _ in range(4):
        # The owner's search commits pages; the automatic handoff never freezes them.
        await flow.page(10)
    await flow.finish()
    assert flow.batches() == []
    caplog.set_level(logging.INFO, logger=REFUSAL_LOGGER)
    if link_opened == "after_approval":
        with pytest.raises(DriveSharingError, match="payment_not_ready"):
            # Nothing A approved yet: nothing to pay for.
            await flow.checkout()
    review = await flow.bulk.create_review(
        user_id="owner",
        search_job_id=flow.job,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=flow.request_id,
        selected_positions=list(range(1, 26)),
    )
    await flow.bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    assert [(batch["approval_source"], batch["status"]) for batch in flow.batches()] == [
        ("owner", "queued")
    ]

    if link_opened == "after_approval":
        assert (await flow.checkout())["checkoutUrl"]
    assert flow.create_session.call_count == 1
    await flow.pay()
    order = flow.order()
    assert (order["reconciliation_required"], order["reconciliation_reason"]) == (False, None)
    assert await flow.grant_all() == 25
    assert set(flow.shared_positions()) == set(range(1, 26))
    assert "manual_takeover" not in " ".join(
        record.getMessage() for record in caplog.records if record.name == REFUSAL_LOGGER
    )


@pytest.mark.asyncio
async def test_owner_review_search_keeps_the_manual_lane(flow):
    """An autoshare request whose search needs A's review never auto-checks out."""
    await flow.request(trusted=True)
    await flow.start_search(owner_review=True)
    await flow.page(5)
    state = await flow.payment.payment_state(
        requester_user_id="recipient", request_id=flow.request_id
    )
    assert "_autoshare_owner_user_id" not in state
    assert flow.order() is None and flow.batches() == []


@pytest.mark.asyncio
async def test_production_requests_keep_the_complete_set_gates(flow, monkeypatch, caplog):
    """autoshare_enabled() is False only in production: the old gates stay."""
    monkeypatch.setattr("hushh_mcp.services.drive_sharing_store.autoshare_enabled", lambda: False)
    await flow.request(trusted=True)
    assert "request_flow" not in flow.private()
    await flow.start_search()
    with flow.db.engine.begin() as connection:
        # A production Trusted request selects by file activity.
        envelope = connection.execute(
            text("SELECT checkpoint_envelope FROM drive_owner_search_jobs WHERE job_id=:job"),
            {"job": flow.job},
        ).scalar_one()
        checkpoint = flow.bulk._open(
            envelope, user_id="owner", resource_id=flow.job, purpose="owner-search-checkpoint"
        )
        checkpoint.update(request_time_intent="file_activity", request_selection_policy=None)
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET checkpoint_envelope=CAST(:envelope AS jsonb)
              WHERE job_id=:job"""),
            {
                "job": flow.job,
                "envelope": flow.bulk._seal(
                    checkpoint,
                    user_id="owner",
                    resource_id=flow.job,
                    purpose="owner-search-checkpoint",
                ),
            },
        )
    await flow.page(30)
    assert [batch["file_count"] for batch in flow.batches()] == [25]
    state = await flow.payment.payment_state(
        requester_user_id="recipient", request_id=flow.request_id
    )
    assert state["_legacy_auto_owner_user_id"] == "owner"
    assert "_autoshare_owner_user_id" not in state
    caplog.set_level(logging.INFO, logger=REFUSAL_LOGGER)
    with pytest.raises(DriveSharingError, match="payment_not_ready"):
        await flow.checkout()
    await flow.finish()
    with pytest.raises(DriveSharingError, match="payment_not_ready"):
        await flow.checkout()
    assert [r.getMessage() for r in caplog.records if r.name == REFUSAL_LOGGER] == [
        "drive_request_checkout.refused reason=search_running code=payment_not_ready",
        "drive_request_checkout.refused reason=selection_incomplete code=payment_not_ready",
    ]
    assert flow.create_session.call_count == 0


@pytest.mark.asyncio
async def test_production_manual_lane_keeps_every_shareable_file_rule(flow, sharing, monkeypatch):
    monkeypatch.setattr("hushh_mcp.services.drive_sharing_store.autoshare_enabled", lambda: False)
    await flow.request(trusted=False, allow=False)
    assert "request_flow" not in flow.private()
    await flow.start_search(owner_review=True, authority="owner")
    for _ in range(4):
        await flow.page(10)
    await flow.finish()
    review = await flow.bulk.create_review(
        user_id="owner",
        search_job_id=flow.job,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=flow.request_id,
        selected_positions=list(range(1, 26)),
    )
    await flow.bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    with pytest.raises(DriveSharingError, match="payment_not_ready"):
        await flow.checkout()
    assert flow.create_session.call_count == 0


@pytest.mark.parametrize(
    "prior_status,prior_ids,expected_error",
    [
        # An earlier paid order already holds every selected file: kept rule.
        ("paid", ("source-1", "source-2"), "payment_already_paid"),
        # B already has some files: they count as delivered at grant time.
        ("paid", ("source-1", "source-3"), None),
        # Another unpaid checkout for an overlapping set never blocks this one.
        ("checkout_open", ("source-2", "source-1"), None),
        ("checkout_open", ("source-1",), None),
        ("paid", ("source-3", "source-4"), None),
    ],
)
def test_flat_request_prior_purchase_refuses_only_full_coverage(
    monkeypatch, prior_status, prior_ids, expected_error
):
    prior_request = str(uuid4())

    def execute(statement, params):
        sql = str(statement)
        if "FROM drive_request_payment_orders o" in sql:
            rows = [{"request_id": prior_request, "status": prior_status}]
        elif "FROM drive_bulk_share_files f" in sql:
            rows = [
                {
                    "source_job_id": "job-1",
                    "source_position": position,
                    "metadata_envelope": {"id": source_id},
                }
                for position, source_id in enumerate(prior_ids, 1)
            ]
        else:
            raise AssertionError(sql)
        return SimpleNamespace(mappings=lambda: rows)

    monkeypatch.setattr(DriveBulkShareStore, "_open", lambda _, envelope, **kw: envelope)
    payment = DriveRequestPaymentService(db=object())

    def guard():
        payment._guard_legacy_duplicate_purchase(
            SimpleNamespace(execute=execute),
            owner_user_id="owner",
            requester_user_id="buyer",
            request_id=str(uuid4()),
            selected_ids=frozenset({"source-1", "source-2"}),
            flat_request=True,
        )

    if expected_error:
        with pytest.raises(DriveSharingError, match=expected_error):
            guard()
    else:
        guard()


def test_flat_request_never_refuses_on_an_unreadable_purchase_history():
    def execute(statement, params):
        sql = str(statement)
        if "FROM drive_request_payment_orders o" in sql:
            return SimpleNamespace(
                mappings=lambda: [{"request_id": str(uuid4()), "status": "paid"}] * 65
            )
        raise AssertionError(sql)

    payment = DriveRequestPaymentService(db=object())
    selected = frozenset(f"source-{index}" for index in range(121))
    for ids in (selected, frozenset({"source-1"})):
        payment._guard_legacy_duplicate_purchase(
            SimpleNamespace(execute=execute),
            owner_user_id="owner",
            requester_user_id="buyer",
            request_id=str(uuid4()),
            selected_ids=ids,
            flat_request=True,
        )
    # Negative control: any other request still fails closed.
    with pytest.raises(DriveSharingError, match="payment_not_ready"):
        payment._guard_legacy_duplicate_purchase(
            SimpleNamespace(execute=execute),
            owner_user_id="owner",
            requester_user_id="buyer",
            request_id=str(uuid4()),
            selected_ids=frozenset({"source-1"}),
        )


@pytest.mark.asyncio
async def test_every_refusal_logs_one_fixed_line_without_identifiers(caplog):
    from hushh_mcp.services.drive_request_checkout_refusals import (
        CHECKOUT_REFUSAL_REASONS,
        checkout_refusal,
        logs_checkout_refusals,
    )
    from hushh_mcp.services.google_drive_adapter import DriveReadError

    request_id = str(uuid4())
    errors = iter(
        [
            checkout_refusal("search_failed"),
            checkout_refusal("all_files_accessible", "request_already_accessible"),
            DriveSharingError("request_unavailable"),
            DriveSharingError("something_new"),
            DriveReadError("reconnect_required"),
            DriveSharingError(f"leak {request_id} b@example.invalid"),
            checkout_refusal(f"made_up_{request_id}"),
        ]
    )

    @logs_checkout_refusals
    async def checkout(*, request_id):
        raise next(errors)

    caplog.set_level(logging.INFO, logger=REFUSAL_LOGGER)
    for _ in range(7):
        with pytest.raises(DriveReadError):
            await checkout(request_id=request_id)
    lines = [record.getMessage() for record in caplog.records if record.name == REFUSAL_LOGGER]
    assert lines == [
        "drive_request_checkout.refused reason=search_failed code=payment_not_ready",
        "drive_request_checkout.refused reason=all_files_accessible "
        "code=request_already_accessible",
        "drive_request_checkout.refused reason=request_missing code=request_unavailable",
        "drive_request_checkout.refused reason=untagged code=something_new",
        "drive_request_checkout.refused reason=drive_not_ready code=reconnect_required",
        "drive_request_checkout.refused reason=untagged code=unavailable",
        "drive_request_checkout.refused reason=unclassified code=payment_not_ready",
    ]
    assert not any(request_id in line or "@" in line for line in lines)
    assert all(
        reason == reason.strip() and " " not in reason for reason in CHECKOUT_REFUSAL_REASONS
    )


# -- The requester's payment view names the sealed flow ------------------------


async def _requester_payment_reads(flow, request_id):
    """B's payment view from each single-request read; all three must agree."""
    status = await flow.sharing.request_status(user_id="recipient", request_id=request_id)
    payment = await flow.payment.get_payment(requester_user_id="recipient", request_id=request_id)
    delivery = await DriveSuggestionStore(
        db=flow.db, authority_key="synthetic-ledger-key"
    ).delivery_snapshot(user_id="recipient", request_id=request_id, views=True)
    assert payment["paymentView"] == status["payment"]
    assert delivery["result"]["payment"] == status["payment"]
    return status


def _flow_marks(view):
    return view.get("autoshare"), view.get("checkoutPending")


@pytest.mark.asyncio
async def test_requester_payment_view_names_the_autoshare_flow_on_every_read(flow, monkeypatch):
    """2026-10-18: with payment asked at Allow, B still read "No payment due yet
    · You pay only if files are found": the copy existed, but no read passed
    the request's sealed flow. Production's requests keep their old view."""
    with monkeypatch.context() as production:
        production.setattr(
            "hushh_mcp.services.drive_sharing_store.autoshare_enabled", lambda: False
        )
        await flow.request(trusted=False)
    assert "request_flow" not in flow.private()
    legacy = flow.request_id
    await flow.request(trusted=False)
    assert autoshare_request(flow.private())
    sealed = flow.request_id

    # Allowed: the order exists and its payment link is being made.
    for request_id, marks in ((sealed, (True, True)), (legacy, (None, None))):
        status = await _requester_payment_reads(flow, request_id)
        assert status["payment"]["state"] == "preparing"
        assert _flow_marks(status["payment"]) == marks

    # The link is bound and B can pay. Neither side is told One is searching.
    assert (await flow.checkout())["checkoutUrl"]
    status = await _requester_payment_reads(flow, sealed)
    assert status["payment"]["state"] == "payable"
    assert _flow_marks(status["payment"]) == (True, None)
    # The status's own autoshare key is B's "Finding files" line.
    assert "autoshare" not in status
    center = DriveSharingCenterContributor(db=flow.db)
    for user_id, bucket in (("recipient", "outgoing_requests"), ("owner", "incoming_requests")):
        page = await center.page(user_id, bucket=bucket, limit=10)
        [entry] = [item for item in page["items"] if item["request_id"] == sealed]
        assert entry["metadata"]["automatic_progress_active"] is False
        assert entry["metadata"]["automatic_progress_state"] is None

    # Withdrawn: the reply and every read still name the flow. GET /payment
    # now reads a closed request, whose envelope it otherwise leaves sealed.
    for request_id, marks in ((sealed, (True, None)), (legacy, (None, None))):
        current = await flow.sharing.request_status(user_id="recipient", request_id=request_id)
        reply = await flow.sharing.decline_or_cancel(
            user_id="recipient",
            request_id=request_id,
            revision=current["revision"],
            decision="cancelled",
        )
        assert (reply["payment"]["state"], reply["payment"]["withdrawn"]) == ("closed", True)
        assert _flow_marks(reply["payment"]) == marks
        assert (await _requester_payment_reads(flow, request_id))["payment"] == reply["payment"]


# -- Two drains on one paid request --------------------------------------------

RACE_WAIT_SECONDS = 10


async def _wait_for_any(*events):
    """Wait, bounded, in this drain's own loop until the other drain gets there."""

    def wait():
        deadline = time.monotonic() + RACE_WAIT_SECONDS
        while not any(event.is_set() for event in events) and time.monotonic() < deadline:
            time.sleep(0.005)

    await asyncio.to_thread(wait)


class DrainRace:
    """Two suggestions drains on one request, interleaved where they collide.

    Each drain runs continue_batches in its own thread and event loop, as two
    warm worker instances do. due_trusted_batches skips a request only while a
    transaction holds its row, and a pass is many short transactions. So drain
    2 claims while drain 1 is inside its pass between two of them, lists the
    pending reviews before drain 1 freezes its next batch and reads unclaimed
    positions after that freeze, while drain 1 waits to approve it: the window
    in which a second freeze meets a batch still waiting for approval. Every
    wait is bounded, and a finished drain releases the other at once. Batches
    hold 3 files and a pass freezes one, so each round has a next batch to
    collide on (the real bounds are 25 files and 8 batches a pass).
    """

    def __init__(self, flow, monkeypatch, *, batch_size):
        self.flow = flow
        self.round = self._arm()
        sharing, bulk, auto = flow.sharing, flow.bulk, flow.auto
        claim = sharing.due_trusted_batches
        listed = bulk.pending_request_reviews
        unclaimed = bulk.unclaimed_positions
        freeze = bulk.create_review
        share = auto.share_available

        def drain():
            return threading.current_thread().name

        async def due_trusted_batches(**kwargs):
            if drain() == "drain-2":
                await _wait_for_any(self.round["inside"], self.round["done"]["drain-1"])
            rows = await claim(**kwargs)
            self.round["claims"][drain()] = len(rows)
            return rows

        async def pending_request_reviews(**kwargs):
            rows = await listed(**kwargs)
            if drain() == "drain-2":
                self.round["listed"].set()
            return rows

        async def unclaimed_positions(**kwargs):
            if drain() not in self.round["read"]:
                self.round["read"].add(drain())
                if drain() == "drain-1":
                    self.round["inside"].set()
                    await _wait_for_any(self.round["listed"], self.round["done"]["drain-2"])
                elif drain() == "drain-2":
                    await _wait_for_any(self.round["frozen"], self.round["done"]["drain-1"])
            return await unclaimed(**{**kwargs, "limit": min(kwargs["limit"], batch_size)})

        async def create_review(**kwargs):
            review = await freeze(**kwargs)
            if drain() == "drain-1" and not self.round["frozen"].is_set():
                self.round["frozen"].set()
                await _wait_for_any(self.round["done"]["drain-2"])
            return review

        async def share_available(**kwargs):
            try:
                queued = await share(**{**kwargs, "max_batches": 1})
            except DriveSharingError as error:
                self.round["passes"][drain()] = str(error)
                raise
            self.round["passes"][drain()] = queued
            return queued

        monkeypatch.setattr(sharing, "due_trusted_batches", due_trusted_batches)
        monkeypatch.setattr(bulk, "pending_request_reviews", pending_request_reviews)
        monkeypatch.setattr(bulk, "unclaimed_positions", unclaimed_positions)
        monkeypatch.setattr(bulk, "create_review", create_review)
        monkeypatch.setattr(auto, "share_available", share_available)

    @staticmethod
    def _arm():
        return {
            "inside": threading.Event(),
            "listed": threading.Event(),
            "frozen": threading.Event(),
            "done": {name: threading.Event() for name in ("drain-1", "drain-2")},
            "read": set(),
            "claims": {},
            "passes": {},
        }

    async def run(self):
        """One round: both drains at once. Returns what each claimed and queued."""
        self.round = self._arm()
        errors = []

        def drain():
            name = threading.current_thread().name
            try:
                asyncio.run(self.flow.auto.continue_batches(max_jobs=1))
            except BaseException as error:
                errors.append(error)
            finally:
                self.round["done"][name].set()

        threads = [threading.Thread(target=drain, name=name) for name in ("drain-1", "drain-2")]
        for thread in threads:
            thread.start()
        for thread in threads:
            await asyncio.to_thread(thread.join, 60)
        assert not errors and not any(thread.is_alive() for thread in threads)
        return self.round


@pytest.mark.asyncio
async def test_two_drains_on_one_paid_request_grant_every_file_exactly_once(flow, monkeypatch):
    """Two warm worker instances can drain one paid request at the same moment
    (the Scheduler tick and the payment webhook's wake). The second freeze then
    met the first batch still waiting for approval: bulk_conflict, counted as a
    failed preparation, so three overlaps parked a paid request for good
    (preparation_unavailable) and its unsent files were refunded instead."""
    await flow.request(trusted=False)
    await flow.start_search()
    assert (await flow.checkout())["checkoutUrl"]
    await flow.pay()
    with monkeypatch.context() as quiet:
        # Every match is committed before either drain hands one off.
        quiet.setattr(flow.auto, "after_search_page", AsyncMock(return_value=0))
        quiet.setattr(flow.auto, "after_search_slice", AsyncMock(return_value=0))
        await flow.page(15)
        await flow.finish()
    race = DrainRace(flow, monkeypatch, batch_size=3)

    def preparation():
        with flow.db.engine.connect() as connection:
            return tuple(
                connection.execute(
                    text("""SELECT preparation_error_code,preparation_attempts
                      FROM drive_share_requests WHERE request_id=:request"""),
                    {"request": flow.request_id},
                ).one()
            )

    seen, rounds = [], []
    for _ in range(3):
        with flow.db.engine.begin() as connection:
            # A later tick finds the request due, also after any deferral.
            connection.execute(
                text("""UPDATE drive_share_requests SET preparation_next_at=clock_timestamp()
                  WHERE request_id=:request"""),
                {"request": flow.request_id},
            )
        rounds.append(await race.run())
        seen.append(preparation())

    # Never a failed attempt, so never parked.
    assert seen == [("trusted_auto_active", 0)] * 3
    for outcome in rounds:
        # Both drains took the same request; one froze and approved a batch,
        # the other found the request held and stepped aside.
        assert outcome["claims"] == {"drain-1": 1, "drain-2": 1}
        assert sorted(outcome["passes"].values(), key=str) == [0, 1]

    for _ in range(10):
        if sum(batch["file_count"] for batch in flow.batches()) == 15:
            break
        await flow.auto.continue_batches(max_jobs=1)
    assert await flow.grant_all() == 15
    await flow.bulk.refresh_request(user_id="owner", request_id=flow.request_id)

    # Every match was frozen once and granted once.
    assert flow.shared_positions() == dict.fromkeys(range(1, 16), 1)
    assert flow.effect_count() == 15
    assert [batch["file_count"] for batch in flow.batches()] == [3] * 5
    assert {batch["approval_source"] for batch in flow.batches()} == {"trusted_auto"}
    assert flow.request_status() == "completed"
    code, attempts = preparation()
    assert code != "preparation_unavailable" and attempts == 0


# -- A Drive worker's one-connection pool ---------------------------------------


def _drive_worker_pool(engine):
    """A Drive worker's SQLAlchemy pool on this test server: one connection and
    no overflow (DB_SQLALCHEMY_POOL_SIZE=1, DB_SQLALCHEMY_MAX_OVERFLOW=0 in every
    deploy/drive worker script), with a short pool timeout."""
    with engine.connect() as connection:
        search_path = connection.execute(text("SHOW search_path")).scalar_one()
    return create_engine(
        engine.url,
        pool_size=1,
        max_overflow=0,
        pool_timeout=3,
        connect_args={"options": "-csearch_path=" + search_path.replace(" ", "")},
    )


class _PooledSession:
    """The hold's former session: a connection checked out of the worker's pool."""

    def __init__(self, connection):
        self.connection = connection

    async def fetchval(self, statement, key):
        def run():
            value = self.connection.execute(
                text(statement.replace("$1", ":key")), {"key": key}
            ).scalar_one()
            self.connection.commit()
            return value

        return await asyncio.to_thread(run)


@pytest.mark.asyncio
async def test_batch_hold_leaves_a_drive_worker_its_one_pool_connection(flow, monkeypatch):
    """2026-10-18 review: every Drive worker (UAT, V1, production) runs a
    one-connection SQLAlchemy pool. The batch hold kept that connection for the
    whole pass, so the pass's first transaction waited for it until the pool
    timed out: connector_storage_unavailable, and no batch was ever frozen or
    approved for a Trusted or allowed request."""
    await flow.request(trusted=False)
    await flow.start_search()
    assert (await flow.checkout())["checkoutUrl"]
    await flow.pay()
    with monkeypatch.context() as quiet:
        # The matches are committed before any pass hands one off.
        quiet.setattr(flow.auto, "after_search_page", AsyncMock(return_value=0))
        quiet.setattr(flow.auto, "after_search_slice", AsyncMock(return_value=0))
        await flow.page(3)
        await flow.finish()
    shared = flow.db.engine

    async def worker_pass(*, hold_in_pool):
        pool = _drive_worker_pool(shared)
        flow.db.engine = pool
        try:
            with monkeypatch.context() as patch:
                if hold_in_pool:

                    @asynccontextmanager
                    async def pooled_session():
                        connection = await asyncio.to_thread(pool.connect)
                        try:
                            yield _PooledSession(connection)
                        finally:
                            await asyncio.to_thread(connection.close)

                    patch.setattr(drive_bulk_share_store, "dedicated_connection", pooled_session)
                return await asyncio.wait_for(
                    flow.auto.share_available(user_id="owner", request_id=flow.request_id),
                    timeout=20,
                )
        finally:
            flow.db.engine = shared
            # Ends every session of this pool, with any lock still held on one.
            pool.dispose()

    # Negative control: the same pass with its hold on a connection of the pool.
    started = time.monotonic()
    with pytest.raises(ConnectorLifecycleError, match="connector_storage_unavailable"):
        await worker_pass(hold_in_pool=True)
    assert time.monotonic() - started >= 2.5
    assert flow.batches() == []

    # The hold on its own dedicated session: one pass freezes and approves.
    assert await worker_pass(hold_in_pool=False) == 1
    [batch] = flow.batches()
    assert (batch["file_count"], batch["approval_source"]) == (3, "trusted_auto")
    assert batch["approved_at"] is not None
    assert await flow.grant_all() == 3
    assert set(flow.shared_positions()) == set(flow.shareable)

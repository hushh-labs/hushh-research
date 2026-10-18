"""A, the owner, can stop a paid autoshare request before any file is shared.

Pay-at-Allow asks B to pay the moment A taps Allow, before the search has
found anything. In that window Decline refuses a paid request (request_paid)
and the removal review found nothing to remove, so A could not end it. The
request-wide Stop now covers that window: no further grant, the search ends
for good, B is refunded in full exactly once, and each side gets one outcome
event. Once files were shared the same Stop keeps its contract: their access
is removed and B is refunded for the rest. Only A can stop, and production
(no autoshare flow) keeps its old Stop rules.

The stages and fakes are those of test_drive_pay_stream_acceptance_postgres,
whose Flow drives B's request, A's Allow, the Drive worker, Stripe's webhook
and the sharing drain over disposable PostgreSQL. A stops through the owner
service (DriveSharingService), as the route does.
"""

# ruff: noqa: F401, F811 -- isolated PostgreSQL fixtures imported from their owners

from __future__ import annotations

import json
from collections import Counter
from unittest.mock import AsyncMock

import httpx
import pytest

from hushh_mcp.runtime_settings import clear_runtime_settings_caches
from hushh_mcp.services.drive_request_bulk_removal_store import DriveRequestBulkRemovalStore
from hushh_mcp.services.drive_request_bulk_removal_worker import DriveRequestBulkRemovalWorker
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.google_drive_permission_adapter import GoogleDrivePermissionAdapter
from tests.services.test_drive_pay_stream_acceptance_postgres import (
    ALLOW_CENTS,
    PAY_AT_ALLOW,
    PROFILE_CENTS,
    DriveWorld,
    _settle_again_is_a_no_op,
    _settled_once,
    flow_factory,
    in_period,
    noise,
    stale,
)
from tests.services.test_drive_request_bulk_postgres import request_bulk
from tests.services.test_drive_sharing_store import (
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    sharing,
)

pytestmark = pytest.mark.skipif(not PAY_AT_ALLOW, reason="the Stop window opens with pay-at-Allow")


class RemovableDriveWorld(DriveWorld):
    """Drive's permission removal as the real adapter reads it.

    The removal worker deletes only a direct, uninherited file Viewer grant,
    so permissions.list carries permissionDetails, and a DELETE answers with
    an unread (streamed) empty body.
    """

    def __call__(self, request):
        response = super().__call__(request)
        if request.method == "DELETE":
            return httpx.Response(204, stream=httpx.ByteStream(b""))
        if request.method != "GET" or not request.url.path.endswith("/permissions"):
            return response
        payload = json.loads(response.read())
        for item in payload["permissions"]:
            item["permissionDetails"] = [
                {"permissionType": "file", "role": item["role"], "inherited": False}
            ]
        return self._json(200, payload)


async def stop(flow, *, user_id="owner"):
    """A's request-wide Stop, as the routes run it: review, then confirm."""
    prepared = await flow.service.prepare_revocation(user_id=user_id, request_id=flow.request_id)
    await flow.service.revoke(
        user_id=user_id,
        request_id=flow.request_id,
        revision=prepared["revision"],
        directive_id=prepared["directiveId"],
        review_digest=prepared["reviewDigest"],
        grant_ids=[item["grantId"] for item in prepared["files"]],
        confirmed=True,
    )
    return prepared


async def owner_review(flow):
    return await flow.projections.owner_review(user_id="owner", request_id=flow.request_id)


def events(flow):
    return Counter(
        (row["user_id"], row["event_type"])
        for row in flow.sql(
            "SELECT user_id,event_type FROM drive_share_events WHERE request_id=:request",
            {"request": flow.request_id},
        )
    )


def stopped(flow) -> bool:
    [row] = flow.sql(
        """SELECT access_stop_requested_at IS NOT NULL AS stopped
           FROM drive_share_requests WHERE request_id=:request""",
        {"request": flow.request_id},
    )
    return bool(row["stopped"])


def search_status(flow):
    rows = flow.sql(
        """SELECT status FROM drive_owner_search_jobs
           WHERE user_id='owner' AND client_request_id=:request""",
        {"request": flow.request_id},
    )
    return rows[0]["status"] if rows else None


async def automatic_lanes(flow):
    """The requests the automatic search-start and batch lanes would pick up now."""
    searches = await flow.sharing.due_trusted_searches(limit=20)
    batches = await flow.sharing.due_trusted_batches(limit=20)
    return {item["request_id"] for item in [*searches, *batches]}


def preparation_code(flow):
    [row] = flow.sql(
        "SELECT preparation_error_code FROM drive_share_requests WHERE request_id=:request",
        {"request": flow.request_id},
    )
    return row["preparation_error_code"]


def outcome_events_once(flow):
    seen = events(flow)
    assert seen[("owner", "document_share_outcome")] == 1, seen
    assert seen[("recipient", "document_share_outcome")] == 1, seen


def refunded_in_full_once(flow):
    assert [(row["amount_cents"], row["status"]) for row in flow.refunds()] == [
        (ALLOW_CENTS, "succeeded")
    ]
    assert flow.stripe.refund_creates == [ALLOW_CENTS]
    assert flow.order()["status"] == "refunded"
    assert flow.payout()["status"] == "void"
    assert events(flow)[("recipient", "document_share_payment_refunded")] == 1


async def _paid_while_the_search_has_found_nothing(flow):
    """A allows; B pays while the first search slice has read only stale files."""
    await flow.ask()
    await flow.search_slice()
    assert search_status(flow) in {"queued", "running"}
    await flow.sharing_drain()
    await flow.pay()
    assert flow.batches() == [] and flow.world.created == Counter()


@pytest.mark.asyncio
async def test_paid_request_with_nothing_shared_stops_for_good_and_refunds_in_full_once(
    flow_factory,
):
    # Six title pages of stale files come first: no match in the first slice.
    world = DriveWorld([*stale(150), *in_period(4), *noise(10)])
    flow = flow_factory(world)
    await _paid_while_the_search_has_found_nothing(flow)
    assert (await owner_review(flow))["requestStop"] == "available"
    notices = events(flow)[("owner", "document_share_request")]

    prepared = await stop(flow)
    assert (prepared["files"], prepared["affectedCount"], prepared["pendingCount"]) == ([], 0, 0)
    assert stopped(flow)
    assert search_status(flow) == "stopped"
    outcome_events_once(flow)
    assert (await owner_review(flow))["requestStop"] == "before_sharing"
    pages = world.list_pages
    # A slice already in flight fails its authority check after the Stop and
    # reports it like this: no setup notice for A, and the request keeps its state.
    code = preparation_code(flow)
    await flow.sharing.defer_trusted_search(
        user_id="owner", request_id=flow.request_id, code="trusted_relationship_changed"
    )
    assert preparation_code(flow) == code
    assert events(flow)[("owner", "document_share_request")] == notices

    for _ in range(3):
        await flow.search_drain()
        await flow.sharing_drain()
        # Nothing is ever shared, frozen or searched again.
        assert world.created == Counter() and world.shared_with_b() == set()
        assert flow.batches() == [] and flow.effect_states() == Counter()
        assert search_status(flow) == "stopped" and world.list_pages == pages

    refunded_in_full_once(flow)
    outcome_events_once(flow)
    # A stopped request is no setup notice for A.
    assert events(flow)[("owner", "document_share_request")] == notices
    assert (await flow.payment_view())["state"] == "refunded"
    # "Search again" never resumes it either.
    assert await flow.store.takeover_request(user_id="owner", request_id=flow.request_id) is None
    assert search_status(flow) == "stopped"

    # A second Stop changes nothing: no review, no refund, no event.
    before = (events(flow), flow.payout()["updated_at"], list(flow.stripe.refund_creates))
    with pytest.raises(DriveSharingError) as again:
        await stop(flow)
    assert str(again.value) == "revocation_pending"
    await flow.settle()
    after = (events(flow), flow.payout()["updated_at"], list(flow.stripe.refund_creates))
    assert after == before


@pytest.mark.asyncio
async def test_paid_request_stopped_before_its_search_starts_never_searches(flow_factory):
    world = DriveWorld([*in_period(4), *noise(10)])
    flow = flow_factory(world)
    await flow.ask()
    await flow.sharing_drain()
    await flow.pay()
    # Paid at Allow: the search has not even started.
    assert search_status(flow) is None and world.list_pages == 0
    assert (await owner_review(flow))["requestStop"] == "available"
    notices = events(flow)[("owner", "document_share_request")]
    assert flow.request_id in await automatic_lanes(flow)

    await stop(flow)
    # The automatic start never picks a stopped request up again.
    assert flow.request_id not in await automatic_lanes(flow)
    for _ in range(3):
        await flow.search_drain()
        await flow.sharing_drain()
    assert search_status(flow) is None and world.list_pages == 0
    assert world.created == Counter() and flow.batches() == []
    refunded_in_full_once(flow)
    outcome_events_once(flow)
    assert events(flow)[("owner", "document_share_request")] == notices


@pytest.mark.asyncio
async def test_paid_request_with_a_held_batch_stops_it_before_any_grant(flow_factory):
    """The first slice froze matches before B paid; A stops before they are sent."""
    world = DriveWorld([*in_period(5), *noise(800)])
    flow = flow_factory(world)
    await flow.ask()
    assert await flow.until_checkout_opens() is not None, "B can never pay"
    assert [(b["status"], b["approved"]) for b in flow.batches()] == [("review_ready", False)]
    await flow.pay()
    assert (await owner_review(flow))["requestStop"] == "available"

    await stop(flow)
    assert [(b["status"], b["approved"]) for b in flow.batches()] == [("stopped", False)]
    for _ in range(3):
        await flow.search_drain()
        await flow.sharing_drain()
    assert world.created == Counter() and flow.effect_states() == Counter()
    assert search_status(flow) == "stopped"
    refunded_in_full_once(flow)
    outcome_events_once(flow)


@pytest.mark.asyncio
async def test_paid_request_with_three_files_shared_still_removes_them_and_refunds_the_rest(
    flow_factory,
):
    world = RemovableDriveWorld(in_period(6))
    flow = flow_factory(world)
    await flow.ask()
    assert await flow.until_checkout_opens() is not None, "B can never pay"
    await flow.pay()
    # All six are approved; Google has taken three grants when A stops.
    await flow.deliver_some(approved=6, delivered=3)
    # Something was shared: A stops through the existing removal review.
    assert "requestStop" not in await owner_review(flow)
    prepared = await stop(flow)
    assert (prepared["affectedCount"], prepared["pendingCount"]) == (3, 3)
    assert (await owner_review(flow))["requestStop"] == "after_sharing"
    # Its completed search no longer feeds the automatic batch lane.
    assert flow.request_id not in await automatic_lanes(flow)
    await flow.until_quiet()

    assert sum(world.created.values()) == 3
    removals = DriveRequestBulkRemovalWorker(
        store=DriveRequestBulkRemovalStore(db=flow.db),
        oauth=flow.oauth,
        adapter=GoogleDrivePermissionAdapter(),
    )
    outcome = await removals.run(max_jobs=20, deadline_seconds=60)
    assert outcome["outcomes"].get("removed") == 3, outcome
    assert world.shared_with_b() == set()
    # 6 approved, 3 delivered: half of the price comes back to B, once.
    payout = _settled_once(flow, expected=6, confirmed=3)
    await _settle_again_is_a_no_op(flow, payout)
    outcome_events_once(flow)


async def _three_shared_and_a_worker_holds_the_fourth(flow):
    """Six approved, three shared, and a worker has claimed the next grant.

    The worker's lease (120 seconds) is still live when A stops. A worker
    often never returns: DriveBulkShareWorker.run cancels its grants when the
    effect budget runs out, and a cancelled grant keeps its lease.
    """
    await flow.ask()
    assert await flow.until_checkout_opens() is not None, "B can never pay"
    await flow.pay()
    await flow.deliver_some(approved=6, delivered=3)
    [row] = await flow.bulk.due(limit=1)
    job = await flow.bulk.claim(
        user_id=row["user_id"],
        share_id=str(row["share_id"]),
        position=row["position"],
        recipient_user_id=row["recipient_user_id"],
    )
    assert job is not None and job["state"] == "queued"
    assert flow.effect_states() == Counter(succeeded=3, queued=3)
    return job


def _stop_codes(flow):
    """Each grant not shared: its state, its code and whether a lease remains."""
    return Counter(
        (row["state"], row["safe_error_code"], row["leased"])
        for row in flow.sql(
            """SELECT e.state,e.safe_error_code,e.lease_id IS NOT NULL AS leased
               FROM drive_bulk_share_effects e
               JOIN drive_bulk_shares b ON b.share_id=e.share_id
               WHERE b.origin_request_id=:request AND e.state<>'succeeded'""",
            {"request": flow.request_id},
        )
    )


async def _removed_and_settled_once(flow, world):
    removals = DriveRequestBulkRemovalWorker(
        store=DriveRequestBulkRemovalStore(db=flow.db),
        oauth=flow.oauth,
        adapter=GoogleDrivePermissionAdapter(),
    )
    outcome = await removals.run(max_jobs=20, deadline_seconds=60)
    assert outcome["outcomes"].get("removed") == 3, outcome
    assert world.shared_with_b() == set()
    # 6 approved, 3 delivered: half of the price comes back to B, once.
    payout = _settled_once(flow, expected=6, confirmed=3)
    await _settle_again_is_a_no_op(flow, payout)
    outcome_events_once(flow)


@pytest.mark.asyncio
async def test_a_grant_whose_worker_never_returns_cannot_hold_the_settlement(flow_factory):
    """The Stop releases a grant a worker still holds, so B's refund and A's pay settle."""
    world = RemovableDriveWorld(in_period(6))
    flow = flow_factory(world)
    job = await _three_shared_and_a_worker_holds_the_fourth(flow)

    prepared = await stop(flow)
    assert (prepared["affectedCount"], prepared["pendingCount"]) == (3, 3)
    # The worker never comes back and its lease runs out.
    flow.sql(
        """UPDATE drive_bulk_share_effects
           SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE lease_id=:lease""",
        {"lease": job["lease_id"]},
    )
    await flow.until_quiet()
    for _ in range(3):
        await flow.settle()

    assert sum(world.created.values()) == 3
    await _removed_and_settled_once(flow, world)
    # The Stop itself released every grant not yet sent, the held one too.
    assert _stop_codes(flow) == Counter({("skipped", "stopped", False): 3})


@pytest.mark.asyncio
async def test_a_worker_that_returns_after_the_stop_never_reaches_google(flow_factory):
    world = RemovableDriveWorld(in_period(6))
    flow = flow_factory(world)
    job = await _three_shared_and_a_worker_holds_the_fourth(flow)
    await stop(flow)

    # The worker comes back with its lease: no dispatch, no Google POST, and
    # the Stop's own record of the grant stays as it is.
    with pytest.raises(DriveSharingError) as changed:
        await flow.bulk.mark_dispatching(job)
    assert str(changed.value) == "bulk_changed"
    assert await flow.bulk_worker._grant(job) == "superseded"
    assert sum(world.created.values()) == 3
    assert _stop_codes(flow) == Counter({("skipped", "stopped", False): 3})

    await flow.until_quiet()
    assert sum(world.created.values()) == 3
    await _removed_and_settled_once(flow, world)


@pytest.mark.asyncio
async def test_a_finished_request_stopped_later_only_loses_access(flow_factory):
    """Its outcome stays as it was: no second outcome event, no batch change."""
    world = RemovableDriveWorld(in_period(4))
    flow = flow_factory(world)
    await flow.ask()
    assert await flow.until_checkout_opens() is not None, "B can never pay"
    await flow.pay()
    await flow.until_quiet()
    assert flow.request_status() == "completed" and sum(world.created.values()) == 4
    payout = _settled_once(flow, expected=4, confirmed=4)
    outcome_events_once(flow)
    batches = flow.batches()

    await stop(flow)
    assert stopped(flow) and flow.request_status() == "completed"
    assert (await owner_review(flow))["requestStop"] == "after_sharing"
    outcome_events_once(flow)
    assert flow.batches() == batches
    removals = DriveRequestBulkRemovalWorker(
        store=DriveRequestBulkRemovalStore(db=flow.db),
        oauth=flow.oauth,
        adapter=GoogleDrivePermissionAdapter(),
    )
    outcome = await removals.run(max_jobs=20, deadline_seconds=60)
    assert outcome["outcomes"].get("removed") == 4, outcome
    assert world.shared_with_b() == set()
    await _settle_again_is_a_no_op(flow, payout)


@pytest.mark.asyncio
async def test_unpaid_request_has_no_stop_and_decline_still_works(flow_factory):
    world = DriveWorld([*in_period(4), *noise(10)])
    flow = flow_factory(world)
    await flow.ask()
    await flow.sharing_drain()
    assert flow.order()["status"] == "checkout_open"
    assert "requestStop" not in await owner_review(flow)
    with pytest.raises(DriveSharingError) as refused:
        await stop(flow)
    assert str(refused.value) == "no_revocable_permissions"
    assert not stopped(flow)

    [row] = flow.sql(
        "SELECT revision FROM drive_share_requests WHERE request_id=:request",
        {"request": flow.request_id},
    )
    declined = await flow.service.decide(
        user_id="owner",
        request_id=flow.request_id,
        revision=row["revision"],
        decision="declined",
    )
    assert declined["status"] == "declined"
    assert not stopped(flow)
    assert world.created == Counter()


@pytest.mark.asyncio
async def test_only_the_owner_can_stop(flow_factory):
    world = DriveWorld([*in_period(4), *noise(10)])
    flow = flow_factory(world)
    await flow.ask()
    await flow.sharing_drain()
    await flow.pay()
    owner_connection = flow.oauth.lifecycle.read.return_value

    async def connection_for(*, user_id, **_):
        # B and anyone else have no Drive connection of their own.
        return owner_connection if user_id == "owner" else None

    flow.oauth.lifecycle.read = AsyncMock(side_effect=connection_for)
    for intruder in ("recipient", "someone-else"):
        with pytest.raises(DriveSharingError) as refused:
            await flow.service.prepare_revocation(user_id=intruder, request_id=flow.request_id)
        assert str(refused.value) == "request_unavailable"
        with pytest.raises(DriveSharingError) as refused:
            await flow.service.revoke(
                user_id=intruder,
                request_id=flow.request_id,
                revision=1,
                directive_id="dir_x",
                review_digest="0" * 64,
                grant_ids=[],
                confirmed=True,
            )
        assert str(refused.value) == "request_unavailable"
    # With a Drive connection of their own, B still finds nothing to stop.
    flow.oauth.lifecycle.read = AsyncMock(return_value=owner_connection)
    with pytest.raises(DriveSharingError) as refused:
        await flow.service.prepare_revocation(user_id="recipient", request_id=flow.request_id)
    assert str(refused.value) == "request_unavailable"
    assert not stopped(flow) and flow.refunds() == []
    assert events(flow)[("recipient", "document_share_outcome")] == 0

    # A still can.
    await stop(flow)
    assert stopped(flow)


@pytest.mark.asyncio
async def test_production_keeps_its_stop_rules(flow_factory, monkeypatch):
    """No autoshare flow in production: no Stop before sharing, no new side effects."""
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("STRIPE_MODE", "live")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_local_only_synthetic_key")
    monkeypatch.setenv("CONNECTOR_PRODUCTION_OWNER_COHORT", "owner,recipient")
    clear_runtime_settings_caches()
    world = DriveWorld([*in_period(6), *noise(10)])
    flow = flow_factory(world)
    flow.sql(
        """INSERT INTO stripe_owner_payout_accounts
           (stripe_mode,user_id,stripe_account_id,details_submitted,payouts_enabled,account_ready)
           VALUES ('live','owner','acct_live_owner',TRUE,TRUE,TRUE)"""
    )
    await flow.ask(allow_cents=PROFILE_CENTS)
    await flow.until_quiet()
    # The owner-review contract: no order before A approves files.
    assert flow.order() is None and flow.batches() == []
    assert "requestStop" not in await owner_review(flow)
    with pytest.raises(DriveSharingError) as refused:
        await stop(flow)
    assert str(refused.value) == "no_revocable_permissions"

    # A approves every match, so the existing Stop accepts the queued grants.
    # (This harness does not model live Stripe Connect checkout; S9 never
    # pays either. Payment is not what decides the production Stop rules.)
    flow.price = PROFILE_CENTS
    candidates = flow.committed()
    await flow.approve_positions(sorted(candidates))
    assert "requestStop" not in await owner_review(flow)
    batches = flow.batches()
    search = search_status(flow)
    await stop(flow)
    # The old Stop: the flag only. The batch, its queued grants and the
    # search are left to the workers, and no outcome event is written.
    assert stopped(flow)
    assert flow.batches() == batches and search_status(flow) == search
    assert flow.effect_states() == Counter(queued=len(candidates))
    assert events(flow)[("owner", "document_share_outcome")] == 0
    assert events(flow)[("recipient", "document_share_outcome")] == 0
    assert "requestStop" not in await owner_review(flow)
    for _ in range(2):
        await flow.sharing_drain()
    # The sharing worker releases them, as before.
    assert world.created == Counter()
    assert flow.effect_states() == Counter(skipped=len(candidates))

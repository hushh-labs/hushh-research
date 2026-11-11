"""Contract tests for fixed, bounded, aggregate-only Drive work stages."""

from __future__ import annotations

import asyncio
from itertools import chain, repeat
from types import SimpleNamespace
from unittest.mock import AsyncMock, call
from uuid import UUID

import pytest

from hushh_mcp.services.drive_permission_worker import DrivePermissionWorker
from hushh_mcp.services.drive_share_notification_worker import (
    PROMPT_NOTIFICATION_TYPES,
    DriveShareNotificationWorker,
)
from hushh_mcp.services.drive_work_drain import DriveWorkDrain, _safe_outcomes
from hushh_mcp.services.stripe_connect_balances import WORKER_OUTCOMES

CONNECT_LEDGER_OUTCOMES = {name: 1 for name in sorted(WORKER_OUTCOMES)}


def test_hashcoin_recovery_counts_remain_bounded_and_visible():
    assert _safe_outcomes(
        "owner_payouts",
        {
            "outcomes": {
                "refund_reversed": 1,
                "refund_unknown": 2,
                "completed_checked": 1,
                "bank_accounts_checked": 1,
                "bank_payouts_changed": 2,
                "bank_provider_deferred": 3,
                **CONNECT_LEDGER_OUTCOMES,
                "secret": "transfer_id",
                "succeeded": 501,
            }
        },
    ) == {
        "refund_reversed": 1,
        "refund_unknown": 2,
        "completed_checked": 1,
        "bank_accounts_checked": 1,
        "bank_payouts_changed": 2,
        "bank_provider_deferred": 3,
        # Connect balance and deposit-contents upkeep stays visible, never dropped.
        **CONNECT_LEDGER_OUTCOMES,
    }


def _worker(result):
    return type("Worker", (), {"run": AsyncMock(return_value=result)})()


def _drain(
    workers,
    search_worker=None,
    bulk_share_worker=None,
    bulk_removal_worker=None,
    checkout_worker=None,
    refund_worker=None,
    owner_payout_worker=None,
    packet_order_worker=None,
    group_worker=None,
    period_packet_worker=None,
):
    return DriveWorkDrain(
        document_worker=workers[0],
        group_worker=group_worker or _worker({"outcomes": {"indexed": 1}}),
        suggestion_worker=workers[1],
        search_worker=search_worker or _worker({"outcomes": {"completed": 1}}),
        permission_worker=workers[2],
        bulk_share_worker=bulk_share_worker or _worker({"outcomes": {"not_claimed": 1}}),
        bulk_removal_worker=bulk_removal_worker or _worker({"outcomes": {"materialized": 0}}),
        checkout_worker=checkout_worker or _worker({"outcomes": {"not_claimed": 1}}),
        notification_worker=workers[3],
        refund_worker=refund_worker or _worker({"outcomes": {"disabled": 1}}),
        owner_payout_worker=owner_payout_worker or _worker({"outcomes": {"disabled": 1}}),
        packet_order_worker=packet_order_worker or _worker({"outcomes": {"disabled": 1}}),
        period_packet_worker=period_packet_worker or _worker({"outcomes": {"disabled": 1}}),
        document_delivery_worker=_worker({"outcomes": {"held": 1}}),
    )


@pytest.mark.asyncio
async def test_group_stage_runs_only_its_bounded_worker_without_private_outcomes():
    workers = [_worker({"outcomes": {}}) for _ in range(4)]
    groups = _worker({"outcomes": {"indexed": 1, "private_filename": "never-return"}})
    result = await _drain(workers, group_worker=groups).run(stage="groups")
    assert result["workers"]["groups"] == {"indexed": 1}
    assert all(
        value == {"deferred": 1} for key, value in result["workers"].items() if key != "groups"
    )
    groups.run.assert_awaited_once_with(max_jobs=1, deadline_seconds=180)
    for worker in workers:
        worker.run.assert_not_awaited()
    assert "never-return" not in str(result)


@pytest.mark.asyncio
async def test_document_stage_is_exclusive_bounded_and_aggregate_only():
    workers = [
        _worker({"outcomes": {"ready": 1, "private": "document-id"}}),
        _worker({"outcomes": {"review_ready": 1}}),
        _worker({"outcomes": {"succeeded": 1}}),
        _worker({"outcomes": {"settled": 1}}),
    ]

    result = await _drain(workers).run(stage="documents")

    assert result == {
        "schema_version": "drive.work_drain.v1",
        "workers": {
            "groups": {"deferred": 1},
            "documents": {"ready": 1},
            "suggestions": {"deferred": 1},
            "searches": {"deferred": 1},
            "permissions": {"deferred": 1},
            "bulk_shares": {"deferred": 1},
            "bulk_removals": {"deferred": 1},
            "checkouts": {"deferred": 1},
            "notifications": {"deferred": 1},
            "refunds": {"deferred": 1},
            "owner_payouts": {"deferred": 1},
            "packet_orders": {"deferred": 1},
            "period_packets": {"deferred": 1},
            "document_deliveries": {"deferred": 1},
        },
    }
    workers[0].run.assert_awaited_once_with(max_jobs=20, deadline_seconds=180)
    for worker in workers[1:]:
        worker.run.assert_not_awaited()
    assert "document-id" not in str(result)


@pytest.mark.asyncio
async def test_v1_stage_claims_only_marked_searches_approved_delivery_and_finance():
    workers = [_worker({"outcomes": {"not_claimed": 1}}) for _ in range(4)]
    search = _worker({"outcomes": {"completed": 1}})
    bulk = _worker({"outcomes": {"succeeded": 1}})
    removal = _worker({"outcomes": {"materialized": 0}})
    checkout = _worker({"outcomes": {"ready": 1}})
    refund = _worker({"outcomes": {"disabled": 1}})
    payout = _worker({"outcomes": {"disabled": 1}})

    result = await _drain(
        workers,
        search_worker=search,
        bulk_share_worker=bulk,
        bulk_removal_worker=removal,
        checkout_worker=checkout,
        refund_worker=refund,
        owner_payout_worker=payout,
    ).run(stage="v1")

    search.run.assert_awaited_once_with(max_jobs=1, deadline_seconds=90, v1_only=True)
    bulk.run.assert_awaited_once_with(max_jobs=250, deadline_seconds=80, v1_only=True)
    removal.run.assert_awaited_once_with(max_jobs=20, deadline_seconds=45, v1_only=True)
    checkout.run.assert_awaited_once_with(max_jobs=4, deadline_seconds=35, v1_only=True)
    refund.run.assert_awaited_once_with(max_jobs=4, deadline_seconds=35, v1_only=True)
    payout.run.assert_awaited_once_with(max_jobs=4, deadline_seconds=40, v1_only=True)
    workers[1].run.assert_awaited_once_with(max_jobs=1, deadline_seconds=175, v1_only=True)
    for index in (0, 2, 3):
        workers[index].run.assert_not_awaited()
    assert result["workers"] == {
        "groups": {"deferred": 1},
        "documents": {"deferred": 1},
        "suggestions": {"not_claimed": 1},
        "searches": {"completed": 1},
        "permissions": {"deferred": 1},
        "bulk_shares": {"succeeded": 1},
        "bulk_removals": {"materialized": 0},
        "checkouts": {"ready": 1},
        "notifications": {"deferred": 1},
        "refunds": {"disabled": 1},
        "owner_payouts": {"disabled": 1},
        "packet_orders": {"deferred": 1},
        "period_packets": {"deferred": 1},
        "document_deliveries": {"deferred": 1},
    }


@pytest.mark.asyncio
async def test_sharing_stage_continues_notification_after_permission_failure():
    workers = [_worker({"outcomes": {"not_claimed": 1}}) for _ in range(4)]
    workers[2].run.side_effect = RuntimeError("private file and recipient")
    workers[3].run.return_value = {"outcomes": {"settled": 1, "recipient": 1}}

    bulk = _worker({"outcomes": {"not_claimed": 1}})
    result = await _drain(workers, bulk_share_worker=bulk).run(stage="sharing")

    workers[0].run.assert_not_awaited()
    workers[1].run.assert_not_awaited()
    workers[2].run.assert_awaited_once_with(max_jobs=20, deadline_seconds=75)
    bulk.run.assert_awaited_once_with(max_jobs=250, deadline_seconds=80)
    # Request and payment notices first, then every notice after grants.
    assert workers[3].run.await_args_list == [
        call(max_jobs=20, deadline_seconds=35, event_types=PROMPT_NOTIFICATION_TYPES),
        call(max_jobs=20, deadline_seconds=35),
    ]
    assert result["workers"] == {
        "groups": {"deferred": 1},
        "documents": {"deferred": 1},
        "suggestions": {"deferred": 1},
        "searches": {"deferred": 1},
        "permissions": {"unavailable": 1},
        "bulk_shares": {"not_claimed": 1},
        "bulk_removals": {"materialized": 0},
        "checkouts": {"not_claimed": 1},
        "notifications": {"settled": 1},
        "refunds": {"disabled": 1},
        "owner_payouts": {"disabled": 1},
        "packet_orders": {"disabled": 1},
        "period_packets": {"deferred": 1},
        "document_deliveries": {"held": 1},
    }
    assert "private" not in str(result)


@pytest.mark.asyncio
async def test_sharing_stage_binds_checkout_before_dispatching_payment_notice():
    workers = [_worker({"outcomes": {}}) for _ in range(4)]
    checkout = _worker({"outcomes": {"ready": 1}})
    checkouts_before_notices = []

    async def notification_after_checkout(**_):
        # The drain contains a raise here, so record what each pass saw instead.
        checkouts_before_notices.append(checkout.run.await_count)
        return {"outcomes": {"settled": 1}}

    workers[3].run.side_effect = notification_after_checkout
    result = await _drain(workers, checkout_worker=checkout).run(stage="sharing")

    assert result["workers"]["checkouts"] == {"ready": 1}
    # Both the payment-notice pass and the final pass follow the bound Checkout.
    assert checkouts_before_notices == [1, 1]


@pytest.mark.asyncio
async def test_sharing_snapshots_delivery_before_prorated_refunds():
    workers = [_worker({"outcomes": {}}) for _ in range(4)]
    payout = _worker({"outcomes": {"awaiting_refund": 1}})
    refund = _worker({"outcomes": {"succeeded": 1}})

    async def refund_after_snapshot(**_):
        payout.run.assert_awaited_once()
        return {"outcomes": {"succeeded": 1}}

    refund.run.side_effect = refund_after_snapshot
    result = await _drain(workers, owner_payout_worker=payout, refund_worker=refund).run(
        stage="sharing"
    )
    assert result["workers"]["owner_payouts"] == {"awaiting_refund": 1}
    assert result["workers"]["refunds"] == {"succeeded": 1}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("stage", "elapsed", "worker_index"),
    [("documents", 50, 0), ("suggestions", 60, 1), ("sharing", 131, 2)],
)
async def test_short_stage_budget_never_claims_work(monkeypatch, stage, elapsed, worker_index):
    workers = [_worker({"outcomes": {"not_claimed": 1}}) for _ in range(4)]
    drain = _drain(workers)
    clock = chain([0], repeat(elapsed))
    monkeypatch.setattr(drain, "_now", lambda: next(clock))

    result = await drain.run(stage=stage)

    workers[worker_index].run.assert_not_awaited()
    key = "permissions" if stage == "sharing" else stage
    assert result["workers"][key] == {"deadline": 1}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kwargs",
    [
        {"stage": "all"},
        {"stage": True},
        {"max_jobs_per_worker": 0},
        {"max_jobs_per_worker": 21},
        {"max_jobs_per_worker": True},
        {"deadline_seconds": 19},
        {"deadline_seconds": 206},
    ],
)
async def test_drain_rejects_amplifying_or_unbounded_limits(kwargs):
    workers = [_worker({"outcomes": {}}) for _ in range(4)]
    with pytest.raises(ValueError, match="invalid Drive work drain bounds"):
        await _drain(workers).run(**kwargs)
    for worker in workers:
        worker.run.assert_not_awaited()


@pytest.mark.asyncio
async def test_sharing_stage_reconciles_refunds_with_bounded_aggregate_output():
    workers = [_worker({"outcomes": {}}) for _ in range(4)]
    refund = _worker(
        {
            "outcomes": {
                "claimed": 2,
                "succeeded": 1,
                "manual_review": 1,
                "stripe_refund_id": "re_private",
            }
        }
    )

    result = await _drain(workers, refund_worker=refund).run(stage="sharing")

    refund.run.assert_awaited_once_with(max_jobs=4, deadline_seconds=35)
    assert result["workers"]["refunds"] == {"claimed": 2, "succeeded": 1, "manual_review": 1}
    assert "re_private" not in str(result)


@pytest.mark.asyncio
async def test_thousand_queued_effects_drain_in_twenty_job_slices_without_reposting_unknowns(
    monkeypatch,
):
    """Delivery queue scale only: these jobs already have exact-file approval."""
    monkeypatch.setattr(
        "hushh_mcp.services.drive_permission_worker.connector_feature_enabled", lambda *_: True
    )
    jobs = {
        str(UUID(int=index)): {
            "operation_id": str(UUID(int=index)),
            "user_id": "synthetic-owner",
            "kind": "grant",
            "state": "unknown" if index % 10 == 0 else "queued",
        }
        for index in range(1, 1001)
    }
    original_unknown = {key for key, row in jobs.items() if row["state"] == "unknown"}

    async def grant(*, user_id, operation_id):
        assert user_id == "synthetic-owner"
        assert jobs.pop(operation_id)["state"] == "queued"
        return "succeeded"

    async def reconcile(*, user_id, operation_id):
        assert user_id == "synthetic-owner"
        assert jobs.pop(operation_id)["state"] == "unknown"
        return "present_unattributed"

    executor = SimpleNamespace(
        grant=AsyncMock(side_effect=grant),
        reconcile=AsyncMock(side_effect=reconcile),
        revoke=AsyncMock(side_effect=AssertionError("unexpected revocation")),
    )
    permissions = DrivePermissionWorker(executor)

    async def due(limit):
        assert 1 <= limit <= 20
        return list(jobs.values())[:limit]

    permissions.due = AsyncMock(side_effect=due)
    workers = [
        _worker({"outcomes": {}}),
        _worker({"outcomes": {}}),
        permissions,
        _worker({"outcomes": {}}),
    ]
    drain = _drain(workers)
    for remaining in range(1000, 0, -20):
        assert len(jobs) == remaining
        result = await drain.run(stage="sharing")
        assert result["workers"]["permissions"] == {"succeeded": 18, "present_unattributed": 2}
        assert len(jobs) == remaining - 20
        assert "synthetic-owner" not in str(result)

    assert (await drain.run(stage="sharing"))["workers"]["permissions"] == {}
    assert executor.grant.await_count == 900
    assert executor.reconcile.await_count == 100
    assert {
        call.kwargs["operation_id"] for call in executor.reconcile.await_args_list
    } == original_unknown
    assert not original_unknown.intersection(
        call.kwargs["operation_id"] for call in executor.grant.await_args_list
    )
    workers[0].run.assert_not_awaited()
    workers[1].run.assert_not_awaited()
    executor.revoke.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("share_count", "question_count", "first_shares", "first_questions", "later_slices"),
    [
        (12, 30, 10, 10, [20, 2]),
        # A full first outbox must leave room for answers on every invocation.
        (30, 30, 10, 10, [20, 20]),
        # Unused capacity flows to the remaining outbox.
        (0, 42, 0, 20, [20, 2]),
    ],
)
async def test_sharing_notification_budget_is_shared_across_both_outboxes(
    monkeypatch, share_count, question_count, first_shares, first_questions, later_slices
):
    monkeypatch.setattr(
        "hushh_mcp.services.drive_share_notification_worker.connector_feature_enabled",
        lambda *_: True,
    )

    def outbox(start, count):
        pending = {
            str(UUID(int=index)): {"event_id": str(UUID(int=index)), "user_id": "recipient"}
            for index in range(start, start + count)
        }

        async def due(limit, types=()):
            return [] if types else list(pending.values())[:limit]

        async def claim(*, event_id):
            return pending.pop(event_id, None)

        return SimpleNamespace(due=AsyncMock(side_effect=due), claim=AsyncMock(side_effect=claim))

    shares, questions = outbox(1, share_count), outbox(101, question_count)
    notifications = DriveShareNotificationWorker(stores=(shares, questions))
    notifications._dispatch = AsyncMock(return_value="settled")
    workers = [_worker({"outcomes": {}}) for _ in range(3)] + [notifications]

    first = await _drain(workers).run(stage="sharing")
    assert first["workers"]["notifications"] == {"settled": 20}
    assert shares.claim.await_count == first_shares
    assert questions.claim.await_count == first_questions
    assert notifications._dispatch.await_count == 20

    for count in later_slices:
        before = questions.claim.await_count
        result = await _drain(workers).run(stage="sharing")
        assert result["workers"]["notifications"] == {"settled": count}
        assert questions.claim.await_count > before
    dispatched = [call.args[0]["event_id"] for call in notifications._dispatch.await_args_list]
    assert len(dispatched) == len(set(dispatched)) == share_count + question_count


@pytest.mark.asyncio
@pytest.mark.parametrize("blocked_name", ["suggestions", "searches"])
async def test_search_and_preparation_start_independently_without_starving_each_other(blocked_name):
    started = asyncio.Event()
    release = asyncio.Event()
    fast_finished = asyncio.Event()

    async def blocked(**kwargs):
        started.set()
        await release.wait()
        return {"outcomes": {"review_ready" if blocked_name == "suggestions" else "completed": 1}}

    async def fast(**kwargs):
        await started.wait()
        fast_finished.set()
        return {"outcomes": {"superseded" if blocked_name == "suggestions" else "review_ready": 1}}

    workers = [_worker({"outcomes": {}}) for _ in range(4)]
    search = _worker({"outcomes": {}})
    workers[1].run.side_effect = blocked if blocked_name == "suggestions" else fast
    search.run.side_effect = blocked if blocked_name == "searches" else fast
    run = asyncio.create_task(_drain(workers, search).run(stage="suggestions"))
    try:
        await asyncio.wait_for(fast_finished.wait(), timeout=1)
        assert not run.done()
        workers[1].run.assert_awaited_once_with(max_jobs=1, deadline_seconds=175)
        search.run.assert_awaited_once_with(max_jobs=1, deadline_seconds=90)
    finally:
        release.set()
        result = await asyncio.wait_for(run, timeout=1)
    assert result["workers"]["suggestions"] == {"review_ready": 1}
    assert result["workers"]["searches"] == {
        "superseded" if blocked_name == "suggestions" else "completed": 1
    }
    for index in (0, 2, 3):
        workers[index].run.assert_not_awaited()


@pytest.mark.asyncio
async def test_search_failure_does_not_erase_the_preparation_result():
    workers = [_worker({"outcomes": {"review_ready": 1}}) for _ in range(4)]
    search = _worker({"outcomes": {}})
    search.run.side_effect = RuntimeError("private query and owner")
    periods = _worker({"outcomes": {"queued": 1, "private_query": "not-returned"}})
    result = await _drain(workers, search, period_packet_worker=periods).run(stage="suggestions")
    periods.run.assert_awaited_once_with(max_jobs=2, deadline_seconds=90)
    assert result["workers"]["suggestions"] == {"review_ready": 1}
    assert result["workers"]["searches"] == {"unavailable": 1}
    assert "private" not in str(result)


@pytest.mark.asyncio
async def test_sharing_stage_reconciles_packet_orders_with_aggregate_output_only():
    workers = [_worker({"outcomes": {}}) for _ in range(4)]
    packet = _worker({"outcomes": {"marked": 1, "refunded": 1, "private_order_id": "o-1"}})

    result = await _drain(workers, packet_order_worker=packet).run(stage="sharing")

    packet.run.assert_awaited_once_with(max_jobs=20, deadline_seconds=35)
    assert result["workers"]["packet_orders"] == {"marked": 1, "refunded": 1}
    assert "o-1" not in str(result)

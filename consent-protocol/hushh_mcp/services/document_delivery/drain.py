"""The sharing stage preserves grant/settlement/refund causal ordering."""

import asyncio

from hushh_mcp.services.drive_share_notification_worker import PROMPT_NOTIFICATION_TYPES


class _PromptNotices:
    """The notification worker narrowed to notices that need no grant."""

    def __init__(self, worker):
        self._worker = worker

    async def run(self, **bounds):
        return await self._worker.run(**bounds, event_types=PROMPT_NOTIFICATION_TYPES)


async def run_sharing(workers, run_worker):
    # Bind checkout sessions before dispatching payment-ready notices.
    # Payment preparation can overlap grant work; its own authority
    # check and provider call need not consume the grant budget.
    async def grant_work():
        for name, worker in workers:
            if name in {"permissions", "bulk_shares"}:
                await run_worker(name, worker)

    async def payment_work():
        for name, worker in workers:
            if name == "checkouts":
                await run_worker(name, worker)
        # A new request and the requester's payment steps are true before any
        # grant, so they go now instead of after grants, copies and payouts.
        # Every other notice, such as files being available, keeps the final pass.
        for name, worker in workers:
            if name == "notifications":
                await run_worker(name, _PromptNotices(worker))

    await asyncio.gather(grant_work(), payment_work())
    # Snapshot confirmed delivery before claiming a prorated refund.
    # A confirmed refund becomes payable in the next bounded sweep.
    for name, worker in workers:
        if name == "document_deliveries":
            await run_worker(name, worker)
    for name, worker in workers:
        if name == "owner_payouts":
            await run_worker(name, worker)
    # Refund reconciliation and revocations remain independent.
    await asyncio.gather(
        *(
            run_worker(name, worker)
            for name, worker in workers
            if name in {"bulk_removals", "notifications", "refunds", "packet_orders"}
        )
    )

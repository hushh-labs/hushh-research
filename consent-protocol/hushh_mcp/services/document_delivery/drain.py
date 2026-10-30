"""The sharing stage preserves grant/settlement/refund causal ordering."""

import asyncio


async def run_sharing(workers, run_worker):
    # Bind checkout sessions before dispatching payment-ready notices.
    # Payment preparation can overlap grant work; its own authority
    # check and provider call need not consume the grant budget.
    async def grant_work():
        for name, worker in workers:
            if name in {"permissions", "bulk_shares"}:
                await run_worker(name, worker)

    await asyncio.gather(
        grant_work(),
        *(run_worker(name, worker) for name, worker in workers if name == "checkouts"),
    )
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

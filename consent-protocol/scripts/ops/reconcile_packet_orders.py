"""Refund paid packet orders the owner did not accept (operator / scheduled job).

Marks paid orders refund_pending when their marketplace request was denied,
expired, or deleted with an account, or when no request was filed within an
hour of payment; then refunds each in full through Stripe (idempotent per
order). Safe to run on a schedule; a denial also triggers it right away.

    uv run python scripts/ops/reconcile_packet_orders.py
"""

from __future__ import annotations

import asyncio

from hushh_mcp.services.pkm_packet_order_service import PkmPacketOrderService


def main() -> None:
    print(asyncio.run(PkmPacketOrderService().reconcile()))


if __name__ == "__main__":
    main()

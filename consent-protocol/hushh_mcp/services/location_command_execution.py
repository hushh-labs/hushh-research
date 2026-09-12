"""Verified backend bindings for generated commands; effects and receipts commit together."""

from __future__ import annotations

import asyncio
from typing import Any

from db.db_client import get_db
from hushh_mcp.services.action_directive_ledger import ActionDirectiveStore
from hushh_mcp.services.one_location_circle_service import OneLocationCircleService


def _create_circle(connection: Any, user_id: str, slots: dict[str, Any]) -> None:
    OneLocationCircleService().create_circle_in_transaction(
        connection, owner_user_id=user_id, name=str(slots["name"]), reuse_existing=True
    )


# Exact bindings are implementation ports, never sentence classifiers. The
# authored action contract is the only source deciding which action uses one.
BACKEND_BINDINGS = {"location.create_circle": _create_circle}


async def execute_atomic(*, binding: str, authority: dict[str, Any]) -> dict[str, Any]:
    effect = BACKEND_BINDINGS.get(binding)
    if effect is None:
        raise ValueError("The backend executor is unavailable.")

    def transaction() -> dict[str, Any]:
        with get_db().engine.begin() as connection:
            # A private event loop stays in this worker. The bound store executes
            # synchronously on the SAME connection; no nested transaction exists.
            store = ActionDirectiveStore(connection=connection)

            async def run() -> dict[str, Any]:
                claim = await store.claim_command(**authority)
                effect(connection, authority["user_id"], authority["slots"])
                await store.settle_command(
                    user_id=authority["user_id"],
                    command_id=authority["command_id"],
                    step=authority["step"],
                    operation_id=claim["operation_id"],
                    execution_receipt=claim["execution_receipt"],
                    status="succeeded",
                )
                return {"operation_id": claim["operation_id"], "status": "succeeded"}

            return asyncio.run(run())

    # If commit acknowledgement is lost, resume reads the ledger. It never
    # independently retries a domain mutation whose receipt may have committed.
    return await asyncio.to_thread(transaction)

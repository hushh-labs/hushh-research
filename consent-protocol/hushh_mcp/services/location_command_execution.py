"""Verified backend bindings for generated commands; effects and receipts commit together."""

from __future__ import annotations

import asyncio
from typing import Any

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.action_directive_ledger import ActionDirectiveStore
from hushh_mcp.services.one_location_circle_service import OneLocationCircleService


def _create_circle(connection: Any, user_id: str, slots: dict[str, Any]) -> dict[str, str]:
    identity = OneLocationCircleService().create_circle_in_transaction(
        connection,
        owner_user_id=user_id,
        name=str(slots["name"]),
        kind=slots.get("kind"),
        reuse_existing=True,
    )
    return {"kind": "circle", "id": identity}


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
                resource = effect(connection, authority["user_id"], authority["slots"])
                if resource:
                    expected = (authority["action"].get("command") or {}).get("result_resource")
                    if expected != resource["kind"]:
                        raise ValueError(
                            "The domain result does not match its authored resource contract."
                        )
                    recorded = connection.execute(
                        text("""UPDATE one_action_directive_ledger
                        SET result_resource_kind=:kind,result_resource_id=CAST(:identity AS UUID)
                        WHERE user_id=:user AND session_id=:command AND command_step=:step
                          AND operation_id=:operation AND channel='command' AND state='consumed' AND result_resource_id IS NULL"""),
                        {
                            "kind": resource["kind"],
                            "identity": resource["id"],
                            "user": authority["user_id"],
                            "command": authority["command_id"],
                            "step": authority["step"],
                            "operation": claim["operation_id"],
                        },
                    )
                    if recorded.rowcount != 1:
                        raise ValueError("The operation resource receipt could not be recorded.")
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

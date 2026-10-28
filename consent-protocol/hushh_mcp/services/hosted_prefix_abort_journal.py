"""Fresh SQL authority for native cleanup of one frozen managed bootstrap prefix."""

from __future__ import annotations

import asyncio
import json
import time
from copy import deepcopy
from typing import Any, cast

from hushh_mcp.services.hosted_model_grant_cleanup import _reservation
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


class PrefixAbortJournal:
    def __init__(self, registry: Any, owner: str, initial: dict) -> None:
        self.registry, self.owner, self.initial = registry, owner, deepcopy(initial)
        self.deadline = time.monotonic() + 240

    async def query(self, sql: str, reservation: dict, **params: Any) -> dict:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise ProvisionReconciliationRequired("Managed prefix cleanup deadline exhausted")
        try:
            response = await asyncio.wait_for(
                asyncio.to_thread(
                    self.registry._db().execute_raw,
                    sql,
                    {
                        "owner": self.owner,
                        "attempt": self.initial["attemptId"],
                        "r": json.dumps(reservation),
                        **params,
                    },
                ),
                timeout=min(10, remaining),
            )
        except TimeoutError as exc:
            raise ProvisionReconciliationRequired(
                "Managed prefix SQL acknowledgement is pending"
            ) from exc
        if not response.data or len(response.data) != 1:
            raise ProvisionReconciliationRequired("Managed prefix SQL evidence unavailable")
        return cast(dict, response.data[0])

    async def current(self) -> dict:
        saved: dict = await asyncio.wait_for(_reservation(self.registry, self.owner), timeout=10)
        if (
            saved["attemptId"] != self.initial["attemptId"]
            or saved["registrySnapshot"] != self.initial["registrySnapshot"]
        ):
            raise ProvisionReconciliationRequired("Managed prefix reservation changed")
        result = await self.query(
            "SELECT public.hosted_prefix_abort_admitted(:owner,:attempt,CAST(:r AS jsonb)) AS admitted",
            saved,
        )
        if result.get("admitted") is not True:
            raise ProvisionReconciliationRequired("Managed prefix cleanup authority changed")
        return saved

    async def check(self, kind: str, key: str, stage: str, receipt: dict) -> dict:
        saved = await self.current()
        result = await self.query(
            "SELECT public.valid_managed_prefix_abort_receipt(CAST(:r AS jsonb),"
            ":kind,:key,:stage,CAST(:receipt AS jsonb)) IS TRUE AS admitted",
            saved,
            kind=kind,
            key=key,
            stage=stage,
            receipt=json.dumps(receipt),
        )
        if result.get("admitted") is not True:
            raise ProvisionReconciliationRequired("Managed prefix cleanup prerequisites incomplete")
        return saved

    async def retain(self, kind: str, key: str, stage: str, receipt: dict) -> dict:
        saved = await self.check(kind, key, stage, receipt)
        result = await self.query(
            "SELECT public.retain_managed_prefix_abort(:owner,:attempt,CAST(:r AS jsonb),"
            ":kind,:key,:stage,CAST(:receipt AS jsonb)) IS TRUE AS admitted",
            saved,
            kind=kind,
            key=key,
            stage=stage,
            receipt=json.dumps(receipt),
        )
        if result.get("admitted") is not True:
            raise ProvisionReconciliationRequired("Managed prefix cleanup receipt refused")
        saved = await self.current()
        if retained_entry(saved, kind, key).get(stage) != receipt:
            raise ProvisionReconciliationRequired("Managed prefix cleanup readback differs")
        return saved

    async def base(self) -> dict:
        saved = await self.current()
        result = await self.query(
            "SELECT public.managed_prefix_base(CAST(:r AS jsonb)) AS value", saved
        )
        if not isinstance(result.get("value"), dict):
            raise ProvisionReconciliationRequired("Managed prefix inventory unavailable")
        return cast(dict, result["value"])

    async def binding_key(self, binding: dict) -> str:
        saved = await self.current()
        result = await self.query(
            "SELECT encode(digest(CAST(:binding AS jsonb)::text,'sha256'),'hex') AS value",
            saved,
            binding=json.dumps(binding),
        )
        key = result.get("value")
        if not isinstance(key, str) or len(key) != 64:
            raise ProvisionReconciliationRequired("Managed prefix binding identity unavailable")
        return key


def retained_entry(reservation: dict, kind: str, key: str) -> dict:
    state = reservation.get("managedPrefixAbort", {})
    if kind == "inventory":
        return {"admission": state.get("inventoryAdmission"), "inventory": state.get("inventory")}
    if kind in {"resources", "bindings"}:
        return cast(dict, state.get(kind, {}).get(key, {}))
    return cast(dict, state.get(kind, {}))

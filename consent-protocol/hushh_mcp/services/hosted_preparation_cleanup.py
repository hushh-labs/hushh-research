"""Operator cleanup before bootstrap authority exists; never invent that authority.

The caller first verifies its ADC identity with verify_operator. Native inspection
cannot mutate resources. Retirement uses fresh SQL authority and the existing
project lifecycle port, retaining uncertain outcomes for subsequent readback.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from functools import partial
from typing import Any

from hushh_mcp.services.hosted_gcp_admission import _worker_guard
from hushh_mcp.services.hosted_model_grant_cleanup import _reservation
from hushh_mcp.services.hosted_pod_journal import HostedPodJournal
from hushh_mcp.services.hosted_prefix_native_resources import BoundedPrefixSession
from hushh_mcp.services.hosted_preparation_inventory import (
    InventoryObserver,
    ReadOnlyPreparationSession,
    _inspect,
    native_preparation_inventory,
)
from hushh_mcp.services.hosted_project_gcp_operator import GuardedOperatorSession
from hushh_mcp.services.hosted_project_retirement import _retire
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


async def cleanup_managed_preparation(
    registry: Any,
    *,
    user_id: str,
    actor: str,
    token: str,
    session: Any,
    inventory: InventoryObserver = native_preparation_inventory,
) -> None:
    initial = await _reservation(registry, user_id)
    if inventory is native_preparation_inventory:
        inventory = partial(native_preparation_inventory, managed_context=initial)
    operation = PreparationCleanup(registry, user_id, initial, actor, token, session)
    await operation.run(inventory)


class PreparationCleanup:
    """One bounded coordinator over the existing frozen erasure journal."""

    def __init__(
        self, registry: Any, owner: str, initial: dict, actor: str, token: str, session: Any
    ) -> None:
        self.registry, self.owner, self.initial = registry, owner, initial
        self.actor, self.token = actor, token
        attempt = initial["registrySnapshot"]["backend_metadata"]["provisionAttempt"]
        self.assignment = attempt["hostedAdmission"]["assignment"]
        self.contract = self.assignment["preparationContract"]
        if actor != self.contract["operatorPrincipal"] or not token:
            raise ProvisionReconciliationRequired("Preparation cleanup operator changed")
        self.deadline = time.monotonic() + 240
        self.session = BoundedPrefixSession(session, self.deadline)
        self.journal = HostedPodJournal(registry._db())
        self.admitted: dict = {}

    def remaining(self) -> float:
        value = self.deadline - time.monotonic()
        if value <= 0:
            raise ProvisionReconciliationRequired("Preparation cleanup deadline exhausted")
        return value

    async def current(self) -> tuple[dict, dict]:
        saved = await asyncio.wait_for(
            _reservation(self.registry, self.owner), min(10, self.remaining())
        )
        if (
            saved["attemptId"] != self.initial["attemptId"]
            or saved["registrySnapshot"] != self.initial["registrySnapshot"]
        ):
            raise ProvisionReconciliationRequired("Preparation cleanup reservation changed")
        result = await asyncio.wait_for(
            asyncio.to_thread(
                self.registry._db().execute_raw,
                "SELECT public.hosted_preparation_cleanup_admitted(:owner,:attempt,CAST(:r AS jsonb)) AS admitted, "
                "public.managed_preparation_cleanup_coordinates(CAST(:r AS jsonb)) AS coordinates",
                {"owner": self.owner, "attempt": self.initial["attemptId"], "r": json.dumps(saved)},
            ),
            min(10, self.remaining()),
        )
        if (
            not result.data
            or len(result.data) != 1
            or result.data[0].get("admitted") is not True
            or not isinstance(result.data[0].get("coordinates"), dict)
        ):
            raise ProvisionReconciliationRequired("Preparation cleanup authority unavailable")
        return saved, result.data[0]["coordinates"]

    async def admitted_current(self) -> dict:
        observed, _ = await self.current()
        if not await asyncio.wait_for(
            self.journal.managed_cleanup_check(
                owner_id=self.owner,
                reservation=observed,
                kind="preparation",
                stage="admission",
                receipt=self.admitted,
            ),
            min(10, self.remaining()),
        ):
            raise ProvisionReconciliationRequired("Preparation cleanup prerequisites changed")
        return observed

    async def retain(self, stage: str, receipt: dict) -> None:
        observed = await self.admitted_current()
        if not await asyncio.wait_for(
            self.journal.retain_managed_cleanup(
                owner_id=self.owner,
                reservation=observed,
                kind="preparation",
                stage=stage,
                receipt=receipt,
            ),
            min(10, self.remaining()),
        ):
            raise ProvisionReconciliationRequired("Preparation cleanup receipt refused")
        observed = await self.admitted_current()
        if observed.get("managedPreparationCleanup", {}).get(stage) != receipt:
            raise ProvisionReconciliationRequired("Preparation cleanup receipt readback differs")

    async def inspect(self, coordinates: dict, inventory: InventoryObserver) -> dict:
        proof = await asyncio.to_thread(
            _inspect,
            ReadOnlyPreparationSession(self.session),
            self.token,
            coordinates,
            self.contract,
            self.assignment["region"],
            inventory,
        )
        await self.current()
        result = await asyncio.wait_for(
            asyncio.to_thread(
                self.registry._db().execute_raw,
                "SELECT public.valid_managed_prefix_memory_absence(CAST(:c AS jsonb),CAST(:m AS jsonb)) IS TRUE AS admitted",
                {
                    "c": json.dumps({**coordinates, "region": self.assignment["region"]}),
                    "m": json.dumps(proof["noMemory"]),
                },
            ),
            min(10, self.remaining()),
        )
        if not result.data or len(result.data) != 1 or result.data[0].get("admitted") is not True:
            raise ProvisionReconciliationRequired("Preparation Memory coverage is unverified")
        return proof

    async def run(self, inventory: InventoryObserver) -> None:
        saved, coordinates = await self.current()
        state = saved.get("managedPreparationCleanup", {})
        if "deletion" in state:
            if not await asyncio.wait_for(
                self.journal.managed_cleanup_check(
                    owner_id=self.owner,
                    reservation=saved,
                    kind="preparation",
                    stage="deletion",
                    receipt=state["deletion"],
                ),
                min(10, self.remaining()),
            ):
                raise ProvisionReconciliationRequired("Preparation completion evidence changed")
            return
        base = {
            "ownerId": self.owner,
            "attemptId": self.initial["attemptId"],
            "project": coordinates["project"],
            "projectNumber": coordinates["projectNumber"],
            "operatorPrincipal": self.actor,
        }
        if "admission" in state:
            self.admitted = state["admission"]
        else:
            proof = await self.inspect(coordinates, inventory)
            self.admitted = {**base, "status": "admitted"}
            if "failedPreparation" in coordinates:
                self.admitted["failureReconciliation"] = proof
        await self.retain("admission", self.admitted)
        guarded = GuardedOperatorSession(
            self.session,
            _worker_guard(self.admitted_current, asyncio.get_running_loop(), threading.get_ident()),
        )
        identity, billing, deleted = await asyncio.to_thread(
            _retire,
            guarded,
            self.token,
            coordinates["projectIdentity"],
            self.contract["billingAccount"],
        )
        if deleted:
            await self.retain("acknowledgement", {**base, "status": "acknowledged"})
        await self.retain("deletion", _retirement_receipt(base, coordinates, identity, billing))


def _retirement_receipt(base: dict, coordinates: dict, identity: dict, billing: dict) -> dict:
    return {
        **base,
        "status": "retirement_pending_provider_purge",
        "projectIdentity": identity,
        "billingObservation": billing,
        "bootstrapIdentity": {"email": coordinates["bootstrap"], "status": "observed_absent"},
        "resourceInventory": {
            key: []
            for key in (
                "cloud_run_services",
                "buckets",
                "kms_keys",
                "secrets",
                "memory_banks",
                "connector_credentials",
            )
        },
    }

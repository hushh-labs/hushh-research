"""Provider observation, single-write, and settlement operations."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Callable

from hushh_mcp.services.gcp_project_billing import (
    link_provider_account_transition_once,
    observe_provider_account_transition_billing,
)
from hushh_mcp.services.hosted_operator_identity import VerifiedOperator
from hushh_mcp.services.hosted_provider_account_transition_contracts import (
    OLD_BILLING_ACCOUNT,
    TARGET_BILLING_ACCOUNT,
)
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


class ProviderAccountTransitionBilling:
    """Perform native observations and the one intent-authorized billing PUT."""

    def __init__(self, session: Any, journal: Any, clock: Callable[[], datetime]) -> None:
        self._session = session
        self._journal = journal
        self._clock = clock

    async def observe_and_maybe_link(
        self,
        *,
        placement: dict[str, Any],
        creation: dict[str, Any],
        intent: dict[str, Any],
        operator: VerifiedOperator,
        expected_generation: int,
        expected_phase: str,
        allow_put: bool,
    ) -> dict[str, Any]:
        try:
            before = await self._observe(placement, creation, operator.token)
        except Exception as exc:  # noqa: BLE001 - uncertain read leaves a retained outcome
            return await self._retain_unknown(
                intent, expected_generation, expected_phase, allow_put, exc
            )

        target = intent["targetBillingAccount"]
        old = intent["oldBillingAccount"]
        if before["billingAccountName"] == target and before["billingEnabled"] is True:
            try:
                after = await self._observe(placement, creation, operator.token)
            except Exception as exc:  # noqa: BLE001 - preserve the unresolved state
                return await self._retain_unknown(
                    intent, expected_generation, expected_phase, allow_put, exc
                )
            if after["billingAccountName"] == target and after["billingEnabled"] is True:
                return await self._settle(
                    intent, operator, placement, after, expected_generation, expected_phase
                )

        if before == _old_billing_state(placement, old) and allow_put:
            try:
                await asyncio.to_thread(
                    link_provider_account_transition_once,
                    project_id=placement["projectId"],
                    target_account=target,
                    token=operator.token,
                    session=self._session,
                )
            except Exception as exc:  # noqa: BLE001 - the PUT may have reached Google
                return await self._retain_unknown(
                    intent, expected_generation, expected_phase, allow_put, exc
                )
            try:
                after = await self._observe(placement, creation, operator.token)
            except Exception as exc:  # noqa: BLE001 - don't replay an uncertain PUT
                return await self._retain_unknown(
                    intent, expected_generation, expected_phase, allow_put, exc
                )
            if after["billingAccountName"] == target and after["billingEnabled"] is True:
                return await self._settle(
                    intent, operator, placement, after, expected_generation, expected_phase
                )

        return await self._retain_unknown(
            intent,
            expected_generation,
            expected_phase,
            allow_put,
            ProvisionReconciliationRequired("Native billing state did not confirm the target"),
        )

    async def _observe(
        self, placement: dict[str, Any], creation: dict[str, Any], token: str
    ) -> dict[str, Any]:
        await asyncio.to_thread(
            _observe_project_identity, self._session, placement, creation, token
        )
        return await asyncio.to_thread(
            observe_provider_account_transition_billing,
            project_id=placement["projectId"],
            old_account=OLD_BILLING_ACCOUNT,
            target_account=TARGET_BILLING_ACCOUNT,
            token=token,
            session=self._session,
        )

    async def _settle(
        self,
        intent: dict[str, Any],
        operator: VerifiedOperator,
        placement: dict[str, Any],
        billing: dict[str, Any],
        generation: int,
        phase: str,
    ) -> dict[str, Any]:
        settlement = {
            "version": 1,
            "outcome": "settled",
            "observedAt": self._clock().astimezone(timezone.utc).isoformat(),
            "projectId": placement["projectId"],
            "projectNumber": placement["projectNumber"],
            "billingAccountName": TARGET_BILLING_ACCOUNT,
            "billingEnabled": True,
            "actorPrincipal": operator.principal,
            "operationId": intent["operationId"],
        }
        if billing != _target_billing_state(placement):
            return await self._retain_unknown(
                intent,
                generation,
                phase,
                False,
                ProvisionReconciliationRequired("Native billing readback is foreign"),
            )
        if not await self._journal.settle_provider_account_transition(
            owner_id=intent["ownerId"],
            attempt_id=placement["attemptId"],
            expected_generation=generation,
            expected_phase=phase,
            settlement=settlement,
        ):
            raise ProvisionReconciliationRequired("Provider account settlement was refused")
        return {"phase": "settled", "generation": generation + 1}

    async def _retain_unknown(
        self,
        intent: dict[str, Any],
        generation: int,
        phase: str,
        allow_put: bool,
        _cause: Exception,
    ) -> dict[str, Any]:
        if phase == "unknown":
            return {"phase": "unknown", "generation": generation}
        settlement = {
            "version": 1,
            "outcome": "unknown",
            "observedAt": self._clock().astimezone(timezone.utc).isoformat(),
        }
        if not await self._journal.settle_provider_account_transition(
            owner_id=intent["ownerId"],
            attempt_id=intent["attemptId"],
            expected_generation=generation,
            expected_phase=phase,
            settlement=settlement,
        ):
            label = "Provider unknown outcome" if allow_put else "Provider unknown outcome"
            raise ProvisionReconciliationRequired(f"{label} was refused")
        return {"phase": "unknown", "generation": generation + 1}


def _old_billing_state(placement: dict[str, Any], old_account: str) -> dict[str, Any]:
    return {
        "projectId": placement["projectId"],
        "billingAccountName": old_account,
        "billingEnabled": True,
    }


def _target_billing_state(placement: dict[str, Any]) -> dict[str, Any]:
    return {
        "projectId": placement["projectId"],
        "billingAccountName": TARGET_BILLING_ACCOUNT,
        "billingEnabled": True,
    }


def _observe_project_identity(
    session: Any, placement: dict[str, Any], creation: dict[str, Any], token: str
) -> None:
    response = session.get(
        "https://cloudresourcemanager.googleapis.com/v1/projects/" + placement["projectId"],
        headers={"Authorization": "Bearer " + token},
        timeout=20,
        allow_redirects=False,
    )
    if response.status_code != 200:
        raise ProvisionReconciliationRequired("Native project identity is unverified")
    value = response.json()
    if (
        not isinstance(value, dict)
        or value.get("projectId") != placement["projectId"]
        or value.get("projectNumber") != placement["projectNumber"]
        or value.get("lifecycleState") != "ACTIVE"
        or any(value.get(key) != expected for key, expected in creation.items())
    ):
        raise ProvisionReconciliationRequired("Native project identity differs from placement")

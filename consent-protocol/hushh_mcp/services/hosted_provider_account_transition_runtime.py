"""Intent admission and actor verification for the pilot transition."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Callable

from hushh_mcp.services.hosted_operator_identity import VerifiedOperator
from hushh_mcp.services.hosted_pod_journal import HostedPodJournal
from hushh_mcp.services.hosted_provider_account_transition_billing import (
    ProviderAccountTransitionBilling,
)
from hushh_mcp.services.hosted_provider_account_transition_contracts import (
    ACTOR_PRINCIPAL,
    TRANSITION_ACTOR_PRINCIPAL,
    installed_source_revision,
    new_intent,
    placement_for_row,
    valid_operator_identity,
    validate_retained_intent,
)
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


class HostedProviderAccountTransitionRuntime:
    """Admit an immutable intent and route recovery through GET-only billing logic."""

    def __init__(
        self,
        registry: Any,
        *,
        credentials: Any,
        session: Any,
        journal: HostedPodJournal | None,
        clock: Callable[[], datetime] | None,
        verify_operator: Callable[..., VerifiedOperator],
    ) -> None:
        self._registry = registry
        self._credentials = credentials
        self._session = session
        self._journal = journal or HostedPodJournal(registry._db())
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._verify_operator_fn = verify_operator
        self._billing = ProviderAccountTransitionBilling(self._session, self._journal, self._clock)

    async def start(self, *, owner_id: str) -> dict[str, Any]:
        """Persist one intent, then allow the only transition PUT in this service."""
        row = await self._row(owner_id)
        placement, attempt, creation = placement_for_row(row, owner_id)
        if "providerAccountTransition" in attempt:
            raise ProvisionReconciliationRequired("Provider account transition already exists")
        operator = await self._verify_actor(TRANSITION_ACTOR_PRINCIPAL)
        intent = new_intent(row, placement, attempt, creation, operator, self._clock())
        try:
            admitted = await self._journal.record_provider_account_transition_intent(
                owner_id=owner_id, attempt_id=placement["attemptId"], intent=intent
            )
        except Exception as exc:  # noqa: BLE001 - journal failure must stop provider work
            raise ProvisionReconciliationRequired(
                "Provider account transition intent could not be retained"
            ) from exc
        if admitted is not True:
            raise ProvisionReconciliationRequired("Provider account transition intent was refused")
        return await self._billing.observe_and_maybe_link(
            placement=placement,
            creation=creation,
            intent={**intent, "minimumSourceRevision": installed_source_revision()},
            operator=operator,
            expected_generation=1,
            expected_phase="intent",
            allow_put=True,
        )

    async def resume(self, *, owner_id: str) -> dict[str, Any]:
        """Observe a retained intent/outcome; this method never calls PUT."""
        row = await self._row(owner_id)
        placement, attempt, creation = placement_for_row(row, owner_id)
        transition = attempt.get("providerAccountTransition")
        if not isinstance(transition, dict):
            raise ProvisionReconciliationRequired("Provider account transition is unavailable")
        phase, generation = transition.get("phase"), transition.get("generation")
        intent = transition.get("intent")
        if phase not in {"intent", "unknown", "settled"} or type(generation) is not int:
            raise ProvisionReconciliationRequired("Provider account transition is malformed")
        expected_generation = {"intent": 1, "unknown": 2}.get(phase)
        if (
            (expected_generation is not None and generation != expected_generation)
            or (phase == "settled" and generation not in {2, 3})
            or not isinstance(intent, dict)
        ):
            raise ProvisionReconciliationRequired("Provider account transition is malformed")
        validate_retained_intent(intent, placement, row)
        expected_actor = intent.get("actorPrincipal")
        if not isinstance(expected_actor, str) or expected_actor not in {
            ACTOR_PRINCIPAL,
            TRANSITION_ACTOR_PRINCIPAL,
        }:
            raise ProvisionReconciliationRequired("Provider transition actor is malformed")
        operator = await self._verify_actor(expected_actor)
        if not _operator_matches_intent(operator, intent):
            raise ProvisionReconciliationRequired("Provider transition actor differs from intent")
        if phase == "settled":
            return {"phase": "settled", "generation": generation}
        return await self._billing.observe_and_maybe_link(
            placement=placement,
            creation=creation,
            intent=intent,
            operator=operator,
            expected_generation=generation,
            expected_phase=phase,
            allow_put=False,
        )

    async def _row(self, owner_id: str) -> dict[str, Any]:
        if not isinstance(owner_id, str) or not owner_id:
            raise ProvisionReconciliationRequired("Provider account transition owner is invalid")
        row = await self._registry.get(owner_id)
        if not isinstance(row, dict):
            raise ProvisionReconciliationRequired(
                "Provider account transition owner is unavailable"
            )
        return row

    async def _verify_actor(self, expected: str) -> VerifiedOperator:
        credentials = self._credentials
        if isinstance(credentials, dict):
            credentials = credentials.get(expected)
        if credentials is None:
            raise ProvisionReconciliationRequired(
                "Provider account transition actor credential is unavailable"
            )
        try:
            operator = await asyncio.to_thread(
                self._verify_operator_fn,
                credentials,
                self._session,
                expected=expected,
            )
        except Exception as exc:  # noqa: BLE001 - no provider work without named actor proof
            raise ProvisionReconciliationRequired(
                "Provider account transition actor could not be verified"
            ) from exc
        if not valid_operator_identity(operator, expected=expected):
            raise ProvisionReconciliationRequired("Provider account transition actor is invalid")
        return operator


def _operator_matches_intent(operator: VerifiedOperator, intent: dict[str, Any]) -> bool:
    verification = intent.get("actorVerification")
    return (
        isinstance(verification, dict)
        and operator.principal == intent.get("actorPrincipal")
        and operator.subject == verification.get("subject")
        and operator.email == verification.get("email")
    )

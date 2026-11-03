"""Provider-account SQL ports for the existing hosted provisionAttempt journal."""

from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any, Literal

from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


class HostedProviderAccountJournalMixin:
    """Methods delegated by HostedPodJournal without creating a second journal."""

    async def record_provider_account_transition_intent(
        self, *, owner_id: str, attempt_id: str, intent: dict[str, Any]
    ) -> bool:
        """Persist a verified-actor intent before any provider billing mutation."""
        source_revision = str(os.getenv("HUSHH_DEPLOY_SHA") or "").strip().lower()
        if not re.fullmatch(r"[a-f0-9]{40}", source_revision):
            raise ValueError("Provider account transition requires the control-plane source SHA")
        if "minimumSourceRevision" in intent:
            raise ValueError("Minimum source revision is owned by the running control plane")
        bound_intent = {**intent, "minimumSourceRevision": source_revision}
        result = await asyncio.to_thread(
            self._database.execute_raw,
            "SELECT public.record_hosted_provider_account_transition_intent(:owner,:attempt,"
            "CAST(:intent AS jsonb)) AS admitted",
            {
                "owner": owner_id,
                "attempt": attempt_id,
                "intent": json.dumps(bound_intent),
            },
        )
        return bool(result.data and result.data[0].get("admitted") is True)

    async def settle_provider_account_transition(
        self,
        *,
        owner_id: str,
        attempt_id: str,
        expected_generation: int,
        expected_phase: Literal["intent", "unknown"],
        settlement: dict[str, Any],
    ) -> bool:
        """CAS a provider observation into the existing owner operation journal."""
        if type(expected_generation) is not int or expected_generation < 1:
            raise ValueError("Invalid provider account transition generation")
        if expected_phase not in {"intent", "unknown"}:
            raise ValueError("Unsupported provider account transition phase")
        result = await asyncio.to_thread(
            self._database.execute_raw,
            "SELECT public.settle_hosted_provider_account_transition(:owner,:attempt,:generation,"
            ":phase,CAST(:settlement AS jsonb)) AS admitted",
            {
                "owner": owner_id,
                "attempt": attempt_id,
                "generation": expected_generation,
                "phase": expected_phase,
                "settlement": json.dumps(settlement),
            },
        )
        return bool(result.data and result.data[0].get("admitted") is True)

    async def effective_provider_billing_account(self, *, registry_row: dict[str, Any]) -> str:
        """Use SQL's single transition-aware account resolver; unresolved blocks work."""
        result = await asyncio.to_thread(
            self._database.execute_raw,
            "SELECT public.hosted_provider_effective_billing_account(CAST(:row AS jsonb)) "
            "AS billing_account",
            {"row": json.dumps(registry_row, default=str)},
        )
        account = result.data[0].get("billing_account") if result.data else None
        if not isinstance(account, str) or not account:
            raise ProvisionReconciliationRequired(
                "Hosted provider account transition requires reconciliation"
            )
        return account

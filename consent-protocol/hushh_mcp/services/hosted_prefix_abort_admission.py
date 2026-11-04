"""Retained admission checks for managed prefix-abort and retirement."""

from __future__ import annotations

from hushh_mcp.services.hosted_model_grant_cleanup import _reservation
from hushh_mcp.services.hosted_pod_journal import HostedPodJournal
from hushh_mcp.services.hosted_prefix_abort_journal import PrefixAbortJournal
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


class HostedPrefixAbortAdmission:
    async def _journal(self, owner: str, reservation: dict) -> tuple[PrefixAbortJournal, dict, str]:
        saved = await _reservation(self.registry, owner)
        if (
            saved["attemptId"] != reservation["attemptId"]
            or saved["registrySnapshot"] != reservation["registrySnapshot"]
        ):
            raise ProvisionReconciliationRequired("Managed prefix request changed")
        attempt = saved["registrySnapshot"]["backend_metadata"]["provisionAttempt"]
        assignment = attempt["hostedAdmission"]["assignment"]
        effective_billing_account = await HostedPodJournal(
            self.registry._db()
        ).effective_provider_billing_account(registry_row=saved["registrySnapshot"])
        if self.actor != assignment["preparationContract"]["operatorPrincipal"] or not self.token:
            raise ProvisionReconciliationRequired(
                "Managed prefix operator differs from retained authority"
            )
        journal = PrefixAbortJournal(self.registry, owner, saved)
        current = await journal.current()
        observed = await journal.query(
            "SELECT public.managed_prefix_abort_context(CAST(:r AS jsonb)) AS coordinates", current
        )
        coordinates = observed.get("coordinates")
        if not isinstance(coordinates, dict) or not isinstance(
            coordinates.get("projectNumber"), str
        ):
            raise ProvisionReconciliationRequired(
                "Managed prefix numeric project authority unavailable"
            )
        return (
            journal,
            {**assignment, "projectNumber": coordinates["projectNumber"]},
            effective_billing_account,
        )

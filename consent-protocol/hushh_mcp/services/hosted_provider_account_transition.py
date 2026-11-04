"""Public facade for one retained Dev billing transition."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Callable

from hushh_mcp.services.hosted_operator_identity import verify_operator
from hushh_mcp.services.hosted_pod_journal import HostedPodJournal
from hushh_mcp.services.hosted_provider_account_transition_contracts import (
    ACTOR_PRINCIPAL,
    IMAGE_DIGEST,
    OLD_BILLING_ACCOUNT,
    PLACEMENTS,
    TARGET_BILLING_ACCOUNT,
    TRANSITION_ACTOR_PRINCIPAL,
)
from hushh_mcp.services.hosted_provider_account_transition_runtime import (
    HostedProviderAccountTransitionRuntime,
)

__all__ = [
    "ACTOR_PRINCIPAL",
    "IMAGE_DIGEST",
    "OLD_BILLING_ACCOUNT",
    "PLACEMENTS",
    "TARGET_BILLING_ACCOUNT",
    "TRANSITION_ACTOR_PRINCIPAL",
    "HostedProviderAccountTransition",
    "verify_operator",
]


class HostedProviderAccountTransition:
    """Keep the stable service API while routing work through small domain modules."""

    def __init__(
        self,
        registry: Any,
        *,
        credentials: Any,
        session: Any,
        journal: HostedPodJournal | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._runtime = HostedProviderAccountTransitionRuntime(
            registry,
            credentials=credentials,
            session=session,
            journal=journal,
            clock=clock,
            verify_operator=verify_operator,
        )

    async def start(self, *, owner_id: str) -> dict[str, Any]:
        return await self._runtime.start(owner_id=owner_id)

    async def resume(self, *, owner_id: str) -> dict[str, Any]:
        return await self._runtime.resume(owner_id=owner_id)

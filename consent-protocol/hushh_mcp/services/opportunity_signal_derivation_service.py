"""Server-side producer of `intent`-kind opportunity signals.

Bridges the read model (what the owner *could* publish) to the durable signal
store (the proactive flashcards on Agent One). It reuses
`MarketplaceInformationService.list_publishable_slices` — the same offer-worthy,
unpublished-slice source the inline chat card uses — and persists each as an
`intent` signal via `OpportunitySignalService`.

Why intent-only, server-side: PKM attribute values are BYOK-encrypted, so the
server can see labels/metadata but not raw dates. It can therefore derive dateless
"you could publish this for offers" (`intent`) signals with no vault key. Dated
"this expires soon" (`expiry`) signals must be authored client-side where the vault
is unlocked (phase 4) — both kinds converge on the one signal store.

Idempotent: dedupe_key `derived:intent:{domain}:{scope_handle|label}` means running
this on every Agent One open refreshes display fields on still-active signals and
never resurrects ones the owner already dismissed, published, or snoozed.
"""

from __future__ import annotations

import logging
from typing import Any

from hushh_mcp.services.marketplace_information_service import (
    MarketplaceInformationService,
)
from hushh_mcp.services.opportunity_signal_service import OpportunitySignalService

logger = logging.getLogger(__name__)


def _dedupe_key(domain: str, scope_handle: str | None, label: str) -> str:
    """Stable per-slice identity so re-derivation upserts rather than duplicates."""
    return f"derived:intent:{domain}:{scope_handle or label}"


class OpportunitySignalDerivationService:
    """Derives durable `intent` signals from the owner's publishable slices."""

    def __init__(
        self,
        *,
        info_service: MarketplaceInformationService | None = None,
        signal_service: OpportunitySignalService | None = None,
    ) -> None:
        self._info = info_service or MarketplaceInformationService()
        self._signals = signal_service or OpportunitySignalService()

    async def derive_for_user(self, *, user_id: str) -> list[dict[str, Any]]:
        """Upsert one `intent` signal per offer-worthy unpublished slice.

        Returns the signals as persisted (shaped camelCase). Safe to call on every
        open: creation is idempotent on `(user_id, dedupe_key)` and never revives a
        signal the owner has already handled.
        """
        slices = await self._info.list_publishable_slices(user_id=user_id)
        out: list[dict[str, Any]] = []
        for sl in slices:
            domain = sl.get("domain") or ""
            label = sl.get("label") or "Data slice"
            scope_handle = sl.get("scopeHandle")
            domain_title = sl.get("domainTitle") or domain
            price_cents = int(sl.get("suggestedPriceCents") or 0)
            currency = sl.get("currency") or "USD"

            signal = await self._signals.create_signal(
                user_id=user_id,
                kind="intent",
                domain=domain,
                title=f"Publish your {label} for offers",
                dedupe_key=_dedupe_key(domain, scope_handle, label),
                source="derived",
                scope_handle=scope_handle,
                body=(
                    f"Your {label} ({domain_title}) isn't published yet. Publishing it "
                    "lets buyers reach you with offers — you stay in control and approve "
                    "each request."
                ),
                suggested_price_cents=price_cents,
                currency=currency,
                # Everything the publish CTA needs to target the section without a
                # second manifest lookup (see slice-publishing.ts applySlicePosture).
                metadata={
                    "topLevelScopePath": sl.get("topLevelScopePath"),
                    "scopeHandle": scope_handle,
                    "label": label,
                    "domainTitle": domain_title,
                },
            )
            out.append(signal)
        return out

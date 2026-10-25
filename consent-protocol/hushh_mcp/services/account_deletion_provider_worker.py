"""Bounded continuation on the existing account-deletion worker/scheduler."""

from __future__ import annotations

import asyncio
import logging

from hushh_mcp.services import account_deletion_provider_credentials as credentials
from hushh_mcp.services import account_deletion_provider_journal as journal
from hushh_mcp.services.account_deletion_lifecycle_service import (
    settle_cleanup_database_call as _store_call,
)

logger = logging.getLogger(__name__)
_SETTLED = frozenset({"revoked", "covered_by_group", "local_erasure_approved"})


async def run_claim(claim: journal.ProviderCleanupClaim) -> bool:
    """No implicit OAuth-failure exception, provider fallback or effect replay."""
    grants = await _store_call(journal.load_grants, claim)
    receipt = await _store_call(journal.current_receipt, claim)
    active = []
    for ref, grant in grants.items():
        if receipt["items"][ref]["revocation"] in _SETTLED:
            continue
        expected = {
            key: value
            for key, value in claim.inventory[ref].items()
            if key in {"groupDigest", "revocationSupport"}
        }
        if grant.descriptor() != expected:
            raise credentials.CleanupCredentialUnavailable("Provider cleanup configuration changed")
        if grant.kind == "unsupported" and receipt.get("localErasureAccepted") is not True:
            raise journal.ProviderCleanupNotReady("local erasure needs explicit owner confirmation")
        await credentials.verify_grant(grant, claim=claim)
        active.append(grant)

    # Verify all bindings, then stop every affected watch, then revoke groups.
    # A connection's combined legacy stop-and-revoke helper is never used.
    for grant in active:
        if not claim.inventory[grant.reference]["watchRequired"]:
            continue
        if await _store_call(
            journal.dispatch, claim, reference=grant.reference, phase="watchOutcome"
        ):
            try:
                await credentials.stop_watch(grant)
            except Exception:
                await _store_call(
                    journal.record,
                    claim,
                    reference=grant.reference,
                    phase="watchOutcome",
                    outcome="uncertain",
                )
                raise journal.ProviderCleanupNotReady(
                    "watch cleanup needs reconciliation"
                ) from None
            await _store_call(
                journal.record,
                claim,
                reference=grant.reference,
                phase="watchOutcome",
                outcome="stopped",
            )

    settled_groups: set[str] = set()
    for grant in active:
        if grant.kind == "unsupported":
            await _store_call(journal.settle_unsupported, claim, reference=grant.reference)
            continue
        group = claim.inventory[grant.reference].get("groupDigest")
        if group and group in settled_groups:
            continue
        if not await _store_call(
            journal.dispatch, claim, reference=grant.reference, phase="revocation"
        ):
            continue
        try:
            outcome = await credentials.revoke_grant(grant)
        except Exception:
            outcome = "uncertain"
        if outcome == "revoked" and group:
            await _store_call(journal.record_group_revoked, claim, reference=grant.reference)
            settled_groups.add(group)
        else:
            await _store_call(
                journal.record,
                claim,
                reference=grant.reference,
                phase="revocation",
                outcome=outcome,
            )
        if outcome != "revoked":
            raise journal.ProviderCleanupNotReady("grant cleanup needs reconciliation")

    from hushh_mcp.services.account_service import AccountService

    result = await AccountService().finalize_provider_cleanup(claim)
    return result.get("success") is True and result.get("account_deleted") is True


async def drain(*, limit: int = 5) -> int:
    if not await _store_call(journal.available):
        return 0  # Migration-first rolling compatibility; database failures raise.
    claims = await _store_call(journal.claim_due, limit=limit)
    settled = 0
    for claim in claims:
        action_required = False
        try:
            async with asyncio.timeout(90):
                if await run_claim(claim):
                    settled += 1
                    continue
        except credentials.CleanupProviderUnavailable:
            pass
        except (credentials.CleanupCredentialUnavailable, journal.ProviderCleanupNotReady):
            action_required = True
        except journal.ProviderCleanupClaimLost:
            continue
        except asyncio.CancelledError:
            try:
                await _store_call(journal.release, claim, action_required=False)
            except journal.ProviderCleanupClaimLost:
                pass
            raise
        except Exception as exc:
            # Claims/queries can include tokens. Never retain an exception body
            # or traceback in telemetry; the journal owns retry/uncertainty.
            logger.warning("account_deletion.provider_worker_failed error=%s", type(exc).__name__)
        try:
            await _store_call(journal.release, claim, action_required=action_required)
        except journal.ProviderCleanupClaimLost:
            pass
    return settled

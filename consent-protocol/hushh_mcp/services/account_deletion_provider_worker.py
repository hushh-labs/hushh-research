"""Bounded continuation on the existing account-deletion worker/scheduler."""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass

from hushh_mcp.services import account_deletion_provider_credentials as credentials
from hushh_mcp.services import account_deletion_provider_journal as journal
from hushh_mcp.services.account_deletion_lifecycle_service import (
    settle_cleanup_database_call as _store_call,
)
from hushh_mcp.services.account_deletion_release_admission import (
    AccountDeletionReleasePaused,
    PausedReason,
    ReleaseAdmission,
    release_admission,
)

logger = logging.getLogger(__name__)
_SETTLED = frozenset({"revoked", "covered_by_group", "local_erasure_approved"})


async def run_claim(claim: journal.ProviderCleanupClaim) -> bool:
    """No implicit OAuth-failure exception, provider fallback or effect replay."""
    erased = False
    try:
        async with release_admission() as admission:
            erased = await _run_admitted_claim(claim, admission)
    finally:
        if erased:
            await _notify_erased(claim)
    return erased


async def _notify_erased(claim: journal.ProviderCleanupClaim) -> None:
    """At most once, after the erasure commit and outside release admission.

    The erased transition commits once per claim and is never claimed again, so
    a retry cannot resend. The recipient is read from the retained sign-in and
    Hussh never stores it; an uncertain or failed send is logged, not replayed.
    """
    from hushh_mcp.services.support_email_service import (
        SupportEmailConfig,
        send_verified_account_notice,
    )

    reason = _notice_skip_reason(SupportEmailConfig.from_env())
    if reason:
        logger.info("account_deletion.notice_skipped reason=%s", reason)
        return
    try:
        async with asyncio.timeout(30):
            await send_verified_account_notice(
                claim.firebase_uid, "account_deleted", identity_lookup=lambda uid: uid
            )
    except Exception as exc:
        logger.warning("account_deletion.notice_failed error=%s", type(exc).__name__)


def _notice_skip_reason(config) -> str | None:
    # Non-production shares sign-ins with production, so its deletion notice must
    # be redirected to a test inbox; it never tells a real person their account is gone.
    # Reasons stay under 24 characters so the runtime log redactor never masks them.
    redirected = config.delivery_mode == "test" and bool(config.test_to_email)
    if not config.configured:
        return "sender_unconfigured"
    if os.getenv("ENVIRONMENT", "").strip().lower() != "production" and not redirected:
        return "live_outside_prod"
    return None


async def _verified_grants(claim, admission):
    grants = await _store_call(journal.load_grants, claim)
    receipt = await _store_call(journal.current_receipt, claim)
    if receipt.get("version") != 2:
        raise journal.ProviderCleanupNotReady("legacy cleanup requires reviewed recovery")
    active = []
    for ref, grant in grants.items():
        if receipt["items"][ref]["revocation"] in _SETTLED:
            continue
        expected = {
            key: value
            for key, value in claim.inventory[ref].items()
            if key in {"groupDigest", "revocationSupport", "authorityScope"}
        }
        if grant.descriptor() != expected:
            raise credentials.CleanupCredentialUnavailable("Provider cleanup configuration changed")
        if journal.needs_local_erasure(claim.inventory[ref]):
            await admission.check()
            await _store_call(journal.settle_unsupported, claim, reference=ref)
            continue
        await admission.check()
        await credentials.verify_grant(grant, claim=claim)
        active.append(grant)

    return active


async def _stop_watches(claim, admission, active):
    # Verify all bindings, then stop every affected watch, then revoke groups.
    # A connection's combined legacy stop-and-revoke helper is never used.
    for grant in active:
        if not claim.inventory[grant.reference]["watchRequired"]:
            continue
        await admission.check()
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


async def _revoke_groups(claim, admission, active):
    settled_groups: set[str] = set()
    for grant in active:
        await admission.check()
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


async def _run_admitted_claim(
    claim: journal.ProviderCleanupClaim, admission: ReleaseAdmission
) -> bool:
    active = await _verified_grants(claim, admission)
    await _stop_watches(claim, admission, active)
    await _revoke_groups(claim, admission, active)
    from hushh_mcp.services.account_service import AccountService

    await admission.check()
    result = await AccountService().finalize_provider_cleanup(claim)
    return result.get("success") is True and result.get("account_deleted") is True


@dataclass(frozen=True, slots=True)
class DrainOutcome:
    settled: int
    # Set only when release admission refused the stage; None when idle or ran.
    paused_reason: PausedReason | None = None


async def drain(*, limit: int = 5) -> int:
    return (await drain_with_outcome(limit=limit)).settled


async def drain_with_outcome(*, limit: int = 5) -> DrainOutcome:
    if not await _store_call(journal.available):
        return DrainOutcome(0)  # Migration-first rolling compatibility; database failures raise.
    settled = 0
    paused_reason: PausedReason | None = None
    for _ in range(limit):
        erased = None
        try:
            async with release_admission() as admission:
                # Claim only when ready to execute. Later serial work must not
                # spend its lease waiting behind earlier provider requests.
                claims = await _store_call(journal.claim_due, limit=1)
                if not claims:
                    break
                (claim,) = claims
                action_required = False
                try:
                    async with asyncio.timeout(90):
                        if await _run_admitted_claim(claim, admission):
                            settled += 1
                            erased = claim
                except (credentials.CleanupProviderUnavailable, AccountDeletionReleasePaused):
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
                    # Claims/queries can include tokens. Retain only the type;
                    # durable dispatch receipts own uncertainty and recovery.
                    logger.warning(
                        "account_deletion.provider_worker_failed error=%s", type(exc).__name__
                    )
                if erased is None:
                    try:
                        await _store_call(journal.release, claim, action_required=action_required)
                    except journal.ProviderCleanupClaimLost:
                        pass
        except AccountDeletionReleasePaused as exc:
            # Known release pauses do not consume claims/attempts or turn a
            # healthy pending operation into provider-action quarantine.
            paused_reason = exc.reason
        finally:
            # A committed erasure is owed its notice even if leaving the
            # admission scope raises; admission and timeout are closed here.
            if erased is not None:
                await _notify_erased(erased)
        if paused_reason is not None:
            break
    return DrainOutcome(settled, paused_reason)

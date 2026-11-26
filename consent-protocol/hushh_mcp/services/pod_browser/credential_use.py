"""One task's credential transaction, below its existing semantic/action owners."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from hushh_mcp.services.website_credentials import CredentialRefused

from .contracts import BrowserAction, BrowserExecutionScope, BrowserRefused
from .credential_contracts import (
    BrowserCredentialSource,
    CredentialDescriptor,
    CredentialUseRequest,
    require_credential_execution,
)


class BrowserCredentialUse:
    def __init__(
        self, control, source: BrowserCredentialSource, consent, *, allowed_origins, pending=None
    ) -> None:
        self.control, self.source, self.consent = control, source, consent
        self.pending = pending
        self.allowed_origins = frozenset(allowed_origins)
        self.selection: CredentialUseRequest | None = None
        self.owner_pending = False
        self._operations: set[str] = set()
        self._lock = asyncio.Lock()

    def require_available(self) -> None:
        require_credential_execution(self.control.readiness)
        if not callable(getattr(self.control._executor, "fill_credentials", None)):
            raise BrowserRefused("BROWSER_CREDENTIAL_EXECUTOR_UNAVAILABLE")

    async def catalog(self, origin: str):
        self.require_available()
        if origin not in self.allowed_origins:
            raise BrowserRefused("BROWSER_CREDENTIAL_ORIGIN_REFUSED")
        await self.consent.check_binding(self.control.binding)
        try:
            result = await self.source.catalog(self.control.binding, origin)
        except CredentialRefused as exc:
            raise BrowserRefused("BROWSER_" + exc.code) from None
        await self.consent.check_binding(self.control.binding)
        if len(result) > 20 or any(item.origin != origin for item in result):
            raise BrowserRefused("BROWSER_CREDENTIAL_CATALOG_REFUSED")
        return result

    async def use(
        self,
        request: CredentialUseRequest,
        *,
        owner_selected: bool = False,
        interrupt: Callable[[], Awaitable[None]] | None = None,
        transient: tuple[dict, dict] | None = None,
    ) -> dict:
        self.require_available()
        control = self.control
        if request.control_epoch != control.control_epoch:
            raise BrowserRefused("BROWSER_CONTROL_CHANGED")
        async with self._lock:
            control.require_action_budget(control.control_owner)
            self.selection = request
            if transient is not None:
                from .credential_transient import check_aad

                envelope, selection = transient
                aad = check_aad(control.binding, request, envelope)
                if request.origin not in self.allowed_origins:
                    raise BrowserRefused("BROWSER_CREDENTIAL_ORIGIN_REFUSED")
                await self.consent.check_binding(control.binding)
                try:
                    await self.source.validate_transient(control.binding, aad, selection)
                except CredentialRefused as exc:
                    raise BrowserRefused("BROWSER_" + exc.code) from None
                descriptor = CredentialDescriptor(
                    handle=request.handle,
                    origin=request.origin,
                    record_revision=aad["recordRevision"],
                    autonomy_policy="vault_only",
                    policy_generation=aad["policyGeneration"],
                    custody_generation=aad["custodyGeneration"],
                )
            else:
                rows = await self.catalog(request.origin)
                selected = [item for item in rows if item.handle == request.handle]
                if not owner_selected and (len(rows) != 1 or request.handle == "owner_selection"):
                    self.owner_pending = True
                    if self.pending:
                        self.pending(request)
                    raise BrowserRefused("BROWSER_CREDENTIAL_OWNER_REQUIRED")
                if len(selected) != 1:
                    raise BrowserRefused("BROWSER_CREDENTIAL_SELECTION_REFUSED")
                descriptor = selected[0]
            terms = {
                "credential": descriptor.model_dump(),
                "operation": request.model_dump(),
                "origins": [request.origin],
            }
            if request.operation_id in self._operations or len(self._operations) >= 128:
                raise BrowserRefused("BROWSER_ACTION_REPLAY")
            # Set the fence before waiting for any action/provider. Owner input,
            # queued model actions and stale returned frames cannot cross it.
            epoch = await control.begin_secret_entry(request.control_epoch, interrupt=interrupt)
            self.owner_pending = False
            submitted = dispatched = confirmed = False
            try:
                async with control._lock:
                    await control._check()
                    if control.control_epoch != epoch:
                        raise BrowserRefused("BROWSER_CONTROL_CHANGED")
                    scope = BrowserExecutionScope(
                        sequence=control.next_sequence,
                        control_epoch=epoch,
                        actor=control.control_owner,
                        deadline_at=min(control.binding.expires_at, control._wall_clock() + 300),
                    )
                    # The existing action journal owns this exact selected
                    # submit. It contains no typed credential text.
                    action = BrowserAction(
                        operation="click",
                        sequence=scope.sequence,
                        control_epoch=epoch,
                        x=request.targets.submit.x,
                        y=request.targets.submit.y,
                    )
                    target = await control._executor.verify_credential_targets(request)
                    if (
                        not isinstance(target, dict)
                        or target.get("encoding") != "application/x-www-form-urlencoded"
                    ):
                        raise BrowserRefused("BROWSER_CREDENTIAL_MANUAL_REQUIRED")
                    if descriptor.autonomy_policy == "confirm_before_fill":
                        await self.consent.require(control.binding, "credential_fill", terms)
                    try:

                        async def claim():
                            consume = getattr(control._authority, "consume_credential_nonce", None)
                            if consume is None:
                                raise BrowserRefused("BROWSER_CREDENTIAL_NONCE_UNAVAILABLE")
                            await consume(control.binding, aad["nonce"])

                        opened = (
                            self.source.open_transient(
                                control.binding, request, envelope, selection, claim=claim
                            )
                            if transient is not None
                            else self.source.open(control.binding, descriptor)
                        )
                        async with opened as lease:

                            async def current():
                                await control._check()
                                control.require_execution_scope(scope)
                                await lease.recheck()
                                control.require_execution_scope(scope)

                            try:
                                await current()
                                await control._authority.authorize_action(
                                    control.binding, action, scope=scope
                                )
                                await current()
                                from .credential_network import CredentialSubmission

                                lease.expected_target = target
                                lease.submission = CredentialSubmission(
                                    control.binding, descriptor, request, scope, target, current
                                )
                                control.require_action_budget(scope.actor)
                                await control._authority.journal_dispatch(control.binding, action)
                                dispatched = True
                                self._operations.add(request.operation_id)
                                control._sequence = scope.sequence
                                if scope.actor == "agent":
                                    control._actions += 1
                                async with asyncio.timeout(scope.remaining(control._wall_clock)):
                                    receipt = await control._executor.fill_credentials(
                                        request, lease, scope=scope, check=current
                                    )
                                await current()
                                if not lease.submission.completed:
                                    raise BrowserRefused(
                                        "BROWSER_CREDENTIAL_SUBMISSION_UNCONFIRMED"
                                    )
                                if receipt != {"submitted": True, "cleared": True}:
                                    raise BrowserRefused("BROWSER_SECRET_CLEANUP_UNCONFIRMED")
                                confirmed = True
                            finally:
                                lease.clear()
                        await control._authority.settle_dispatch(
                            control.binding, action, uncertain=False
                        )
                        submitted = True
                    except BaseException:
                        from .dispatch_journal import settle_interrupted_action

                        if dispatched and not await settle_interrupted_action(
                            control._authority, control.binding, action, confirmed=confirmed
                        ):
                            control._outcome_uncertain = True
                        raise
                    await control.finish_secret_entry(epoch)
                self.selection = None
                return {"state": "submitted", "origin": request.origin}
            except BaseException as exc:
                if isinstance(exc, CredentialRefused):
                    exc = BrowserRefused("BROWSER_" + exc.code)
                if not dispatched and isinstance(exc, BrowserRefused):
                    try:
                        async with control._lock:
                            await control.finish_secret_entry(epoch)
                    except BaseException as cleanup_error:
                        await asyncio.shield(control.abort_secret_entry(uncertain=False))
                        if isinstance(cleanup_error, asyncio.CancelledError):
                            raise
                        raise exc from None
                    self.owner_pending = True
                    if self.pending:
                        self.pending(request)
                    raise exc from None
                # Never release an observation fence over possibly populated
                # fields or retry an uncertain form transmission.
                await asyncio.shield(control.abort_secret_entry(uncertain=not submitted))
                # Teardown may be joining this worker; do not re-enter it as a refusal.
                if isinstance(exc, asyncio.CancelledError):
                    raise
                raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN") from None

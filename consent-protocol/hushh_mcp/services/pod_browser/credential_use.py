"""One task's credential transaction, below its existing semantic/action owners."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

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
        self.lease_key = None
        self.prepared = None
        self.retention = None
        self.sdk_confirmation = None
        self.completed_confirmation = None
        self._operations: set[str] = set()
        self._lock = asyncio.Lock()

    def request_confirmation(self, context):
        request = self.selection
        if request is None or not context.function_call_id:
            raise BrowserRefused("BROWSER_CREDENTIAL_CONFIRMATION_REFUSED")
        self.sdk_confirmation = {
            "function_call_id": context.function_call_id,
            "operation_id": request.operation_id,
        }
        context.request_confirmation(
            hint="Sign in to this site?",
            payload={"task_id": self.control.binding.task_id, "operation_id": request.operation_id},
        )
        context.actions.skip_summarization = True

    async def finish_confirmation(self, context):
        confirmation = context.tool_confirmation
        expected = self.completed_confirmation if confirmation.confirmed else self.sdk_confirmation
        if (
            expected is None
            or context.function_call_id != expected["function_call_id"]
            or confirmation.payload
            != {"task_id": self.control.binding.task_id, "operation_id": expected["operation_id"]}
        ):
            raise BrowserRefused("BROWSER_CREDENTIAL_CONFIRMATION_REFUSED")
        await self.consent.check_binding(self.control.binding)
        self.completed_confirmation = self.sdk_confirmation = None
        if not confirmation.confirmed:
            self.selection = self.lease_key = self.prepared = None
            self.owner_pending = False
            return {"state": "cancelled"}
        return {"state": "submitted"}

    def require_available(self) -> None:
        require_credential_execution(self.control.readiness)
        if not callable(getattr(self.control._executor, "fill_credentials", None)):
            raise BrowserRefused("BROWSER_CREDENTIAL_EXECUTOR_UNAVAILABLE")

    async def catalog(self, origin: str):
        self.require_available()
        return ()  # Only the unlocked client selects canonical Secrets items.

    async def request_owner(self, request):
        self.require_available()
        if (
            request.origin not in self.allowed_origins
            or request.control_epoch != self.control.control_epoch
        ):
            raise BrowserRefused("BROWSER_CREDENTIAL_ORIGIN_REFUSED")
        await self.consent.check_binding(self.control.binding)
        prepare = getattr(self.control._executor, "prepare_credential_lease", None)
        if not callable(prepare):
            raise BrowserRefused("BROWSER_CREDENTIAL_EXECUTOR_UNAVAILABLE")
        self.lease_key = await prepare(request, binding=self.control.binding)
        self.selection, self.owner_pending, self.prepared = request, True, None
        if self.pending:
            self.pending(request)
        raise BrowserRefused("BROWSER_CREDENTIAL_OWNER_REQUIRED")

    async def prepare_owner(self, **metadata):
        async with self._lock:
            return await self._prepare_owner(**metadata)

    async def _prepare_owner(
        self,
        *,
        handle,
        operation_id,
        control_epoch,
        record_revision,
        source_content_revision,
        source_manifest_revision,
        remember_session=False,
    ):
        import re

        request = self.selection
        if (
            request is None
            or self.lease_key is None
            or not re.fullmatch(r"sec_[a-f0-9]{16}", handle)
            or request.operation_id != operation_id
            or control_epoch != self.control.control_epoch
        ):
            raise BrowserRefused("BROWSER_CREDENTIAL_SELECTION_CHANGED")
        if (
            self.lease_key["expires_at"] <= self.control._wall_clock()
            or request.control_epoch != control_epoch
        ):
            request = request.model_copy(update={"control_epoch": control_epoch})
            self.lease_key = await self.control._executor.prepare_credential_lease(
                request, binding=self.control.binding
            )
        request = request.model_copy(update={"handle": handle, "control_epoch": control_epoch})
        aad = {
            "credentialId": handle,
            "recordRevision": record_revision,
            "sourceContentRevision": source_content_revision,
            "sourceManifestRevision": source_manifest_revision,
        }
        await self.source.validate_transient(self.control.binding, aad)
        terms = {
            "credential": {
                "handle": handle,
                "origin": request.origin,
                "record_revision": record_revision,
            },
            "operation": request.model_dump(mode="json"),
            "origins": [request.origin],
            "lease_key_id": self.lease_key["id"],
            "source": aad,
            "remember_session": remember_session,
        }
        self.selection = request
        self.prepared = {"aad": aad, "terms": terms}
        return terms

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
            if transient is None:
                await self.request_owner(request)
            from .credential_transient import check_aad

            envelope, _ = transient
            aad = check_aad(control.binding, request, envelope, clock=control._wall_clock)
            if (
                self.prepared is None
                or self.lease_key is None
                or aad["leaseKeyId"] != self.lease_key["id"]
                or any(aad.get(k) != v for k, v in self.prepared["aad"].items())
            ):
                raise BrowserRefused("BROWSER_CREDENTIAL_SELECTION_CHANGED")
            await self.source.validate_transient(control.binding, aad)
            descriptor = CredentialDescriptor(
                handle=request.handle, origin=request.origin, record_revision=aad["recordRevision"]
            )
            terms = self.prepared["terms"]
            if request.operation_id in self._operations or len(self._operations) >= 128:
                raise BrowserRefused("BROWSER_ACTION_REPLAY")
            # An unapproved client cannot even move the secret-entry epoch.
            # Consume exactly once; the returned proof revalidates that same
            # consumed receipt against current authority without another Allow.
            approval = await self.consent.require(control.binding, "credential_fill", terms)
            if not callable(approval):
                raise BrowserRefused("BROWSER_CREDENTIAL_APPROVAL_UNAVAILABLE")
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
                    await approval()
                    try:

                        async def claim():
                            consume = getattr(control._authority, "consume_credential_nonce", None)
                            if consume is None:
                                raise BrowserRefused("BROWSER_CREDENTIAL_NONCE_UNAVAILABLE")
                            await consume(control.binding, aad["nonce"])

                        opened = self.source.open_transient(
                            control.binding, request, envelope, None, claim=claim
                        )
                        async with opened as lease:

                            async def current():
                                await control._check()
                                control.require_execution_scope(scope)
                                check_aad(
                                    control.binding, request, envelope, clock=control._wall_clock
                                )
                                await approval()
                                await lease.recheck()
                                control.require_execution_scope(scope)
                                check_aad(
                                    control.binding, request, envelope, clock=control._wall_clock
                                )

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
                self.retention = (request, terms["remember_session"], aad)
                if self.sdk_confirmation is not None:
                    if self.sdk_confirmation["operation_id"] != request.operation_id:
                        raise BrowserRefused("BROWSER_CREDENTIAL_CONFIRMATION_REFUSED")
                    self.completed_confirmation = dict(self.sdk_confirmation)
                self.selection = None
                self.lease_key = None
                self.prepared = None
                return {"state": "submitted", "origin": request.origin}
            except BaseException as exc:
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

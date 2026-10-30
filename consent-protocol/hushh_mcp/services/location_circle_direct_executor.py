"""Narrow, run-bound executor for ``location.create_circle``.

The transcript-first command lane must not import the legacy ADK action
gateway.  That gateway is intentionally broad: it owns conversational tools,
client directives, screen policy, and many unrelated mutations.  Location
commands need exactly one audited mutation instead:

* revalidate the authenticated vault owner;
* re-read the compiled ``location.create_circle`` contract;
* reserve/recover one encrypted ``CapabilityRunV1``;
* invoke the run-bound Circle adapter;
* read its postcondition and record a durable settlement before reporting
  success.

This module deliberately exposes no tool, prompt, route, card, transcript, or
Circle-name presentation API.  Callers receive only opaque status, reason, and
run identifiers.  A Circle name is accepted as an input to the audited domain
adapter and encrypted run store, but is never logged or returned here.
"""

from __future__ import annotations

import asyncio
import hmac
import re
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Awaitable, Callable, Literal, Mapping, Protocol

from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.app_intelligence_runtime import load_capability_graph
from hushh_mcp.services.capability_run_service import (
    CapabilityRunAuthorityError,
    CapabilityRunConflictError,
    CapabilityRunStore,
    CapabilityRunV1,
    get_capability_run_store,
)
from hushh_mcp.services.one_location_circle_service import (
    OneLocationCircleError,
    OneLocationCircleService,
)

LOCATION_CREATE_CIRCLE_CAPABILITY_ID = "location.create_circle"
LOCATION_CREATE_CIRCLE_SETTLEMENT_REFERENCE = (
    "location.create_circle:verified_backend_service_result"
)

_RUN_ID_RE = re.compile(r"^run_[A-Za-z0-9_-]{1,92}$")
_EXECUTION_SCOPE_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_CONTEXT_REVISION_RE = re.compile(r"^[A-Za-z0-9_.:-]{0,191}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")


class _VaultOwnerToken(Protocol):
    user_id: str


TokenValidator = Callable[[str, ConsentScope], Awaitable[tuple[bool, str, _VaultOwnerToken | None]]]
GraphLoader = Callable[[], Mapping[str, Any]]
CircleServiceFactory = Callable[[], OneLocationCircleService]


@dataclass(frozen=True)
class LocationCircleDirectExecutionResultV1:
    """Opaque result for a command/runtime caller.

    ``completed`` is emitted only after the domain adapter's run-bound
    readback and the durable ``settlement_received -> verified_succeeded``
    transitions both succeed.  It is intentionally not a conversational
    message and never contains a Circle name or identifier.
    """

    status: Literal["completed", "settling", "blocked", "paused", "invalid_slots", "failed"]
    run_id: str | None = None
    reason_code: str | None = None

    def wire_projection(self) -> dict[str, str]:
        payload: dict[str, str] = {"status": self.status}
        if self.run_id:
            payload["run_id"] = self.run_id
        if self.reason_code:
            payload["reason_code"] = self.reason_code
        return payload


def normalize_location_circle_name(value: Any) -> str:
    """Validate the only declared input before it reaches durable state.

    This matches the fixed name-card contract: Unicode-normalize, collapse
    whitespace, reject control characters, and keep the strict 80-character
    Circle service limit.  It is intentionally not a semantic parser.
    """

    if not isinstance(value, str):
        raise ValueError("invalid_circle_name")
    name = unicodedata.normalize("NFC", " ".join(value.split()))
    if (
        not name
        or len(name) > 80
        or _CONTROL_RE.search(name) is not None
        or any(unicodedata.category(character).startswith("C") for character in name)
    ):
        raise ValueError("invalid_circle_name")
    return name


def _run_has_exact_name(run: CapabilityRunV1, name: str) -> bool:
    """Require the resumed encrypted slots to be exactly the current input."""

    slots = run.slots if isinstance(run.slots, Mapping) else {}
    if set(slots) != {"name"}:
        return False
    try:
        stored = normalize_location_circle_name(slots.get("name"))
    except ValueError:
        return False
    return hmac.compare_digest(stored, name)


def _circle_contract(graph: Mapping[str, Any]) -> tuple[str, int] | None:
    """Read exactly the one compiled contract this module is allowed to run."""

    graph_revision = str(graph.get("revision") or "").strip()
    actions = graph.get("actions")
    if not graph_revision or not isinstance(actions, list):
        return None
    matches = [
        item
        for item in actions
        if isinstance(item, Mapping)
        and str(item.get("capability_id") or "") == LOCATION_CREATE_CIRCLE_CAPABILITY_ID
    ]
    if len(matches) != 1:
        return None
    capability = matches[0]
    schema = capability.get("inputSchema")
    execution = capability.get("execution")
    if not isinstance(schema, Mapping) or not isinstance(execution, Mapping):
        return None
    properties = schema.get("properties")
    required = schema.get("required")
    name_schema = properties.get("name") if isinstance(properties, Mapping) else None
    executor = execution.get("executor")
    preconditions = capability.get("preconditions")
    idempotency = capability.get("idempotency")
    supported_entrypoints = capability.get("supported_entrypoints")
    if (
        schema.get("type") != "object"
        or schema.get("additionalProperties") is not False
        or not isinstance(properties, Mapping)
        or set(properties) != {"name"}
        or not isinstance(name_schema, Mapping)
        or name_schema.get("type") != "string"
        or not isinstance(required, list)
        or set(required) != {"name"}
        or execution.get("mode") != "server_direct"
        or execution.get("outcome") != "EXECUTE"
        or not isinstance(executor, Mapping)
        or executor.get("kind") != "backend_service"
        or executor.get("settlement") != "verified_backend_service_result"
        or capability.get("settlement_proof") != "verified_backend_service_result"
        or not isinstance(preconditions, Mapping)
        or preconditions.get("requires_signed_in") is not True
        or preconditions.get("requires_vault") is not True
        or not isinstance(idempotency, Mapping)
        or idempotency.get("strategy") != "capability_run_bound_backend_receipt"
        or not isinstance(supported_entrypoints, list)
        or "voice" not in supported_entrypoints
    ):
        return None
    try:
        version = max(1, int(capability.get("version") or 1))
    except (TypeError, ValueError):
        return None
    return graph_revision, version


class LocationCircleDirectExecutor:
    """The complete audited execution seam for one Circle creation action."""

    def __init__(
        self,
        *,
        run_store: CapabilityRunStore | None = None,
        graph_loader: GraphLoader = load_capability_graph,
        circle_service_factory: CircleServiceFactory = OneLocationCircleService,
        token_validator: TokenValidator = validate_token_with_db,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._run_store = run_store
        self._graph_loader = graph_loader
        self._circle_service_factory = circle_service_factory
        self._token_validator = token_validator
        self._now = now or (lambda: datetime.now(UTC))

    @property
    def run_store(self) -> CapabilityRunStore:
        return self._run_store or get_capability_run_store()

    async def _authorize(self, *, user_id: str, vault_owner_token: str) -> bool:
        token = str(vault_owner_token or "").strip()
        if not token:
            return False
        try:
            valid, _reason, token_owner = await self._token_validator(
                token, ConsentScope.VAULT_OWNER
            )
        except Exception:  # noqa: BLE001 - auth backend detail must not escape command UI
            return False
        return bool(valid and token_owner is not None and str(token_owner.user_id) == user_id)

    def _contract(self) -> tuple[str, int] | None:
        try:
            graph = self._graph_loader()
        except Exception:  # noqa: BLE001 - a stale or unavailable graph never executes
            return None
        return _circle_contract(graph) if isinstance(graph, Mapping) else None

    def _unexpired(self, run: CapabilityRunV1) -> bool:
        # Every authoritative run has an expiry.  A malformed/incomplete
        # projection must not become an indefinitely reusable mutation grant.
        return run.expires_at is not None and run.expires_at > self._now()

    async def _transition_to_executing(
        self,
        *,
        run: CapabilityRunV1,
        user_id: str,
        context_revision: str,
        supplied_name: str,
        allow_missing_name_resume: bool,
    ) -> CapabilityRunV1 | None:
        """CAS one eligible run into execution without widening its inputs."""

        if run.status == "authorized":
            if not _run_has_exact_name(run, supplied_name):
                return None
            try:
                return await self.run_store.transition(
                    user_id=user_id,
                    run_id=run.run_id,
                    expected_revision=run.revision,
                    to_status="executing",
                    step_cursor="execute",
                    pending_interaction=None,
                )
            except CapabilityRunConflictError:
                return await self.run_store.get(
                    user_id=user_id, run_id=run.run_id, include_slots=True
                )

        # A new final transcript can supply the sole missing slot for an
        # existing server-owned ASK.  Explicit form submission never uses this
        # path (it passes ``resume_run_id`` and must consume its own lease), so
        # a stale form cannot be silently authorized by a client retry.
        if allow_missing_name_resume and run.status == "needs_input":
            slots = run.slots if isinstance(run.slots, Mapping) else {}
            if slots:
                return None
            try:
                authorized = await self.run_store.transition(
                    user_id=user_id,
                    run_id=run.run_id,
                    expected_revision=run.revision,
                    to_status="authorized",
                    step_cursor="input_supplied",
                    context_revision=context_revision,
                    expected_context_revision=context_revision,
                    pending_interaction=None,
                    pending_directive_id=None,
                    slots={"name": supplied_name},
                )
                return await self.run_store.transition(
                    user_id=user_id,
                    run_id=authorized.run_id,
                    expected_revision=authorized.revision,
                    to_status="executing",
                    step_cursor="execute",
                    pending_interaction=None,
                )
            except CapabilityRunConflictError:
                return await self.run_store.get(
                    user_id=user_id, run_id=run.run_id, include_slots=True
                )
        return run

    async def _load_or_create_run(
        self,
        *,
        user_id: str,
        name: str,
        execution_scope: str,
        resume_run_id: str | None,
        graph_revision: str,
        capability_version: int,
        context_revision: str,
    ) -> CapabilityRunV1 | None:
        """Recover a matching task or atomically reserve a new direct run."""

        if resume_run_id:
            run = await self.run_store.get(
                user_id=user_id, run_id=resume_run_id, include_slots=True
            )
            if (
                run is None
                or run.capability_id != LOCATION_CREATE_CIRCLE_CAPABILITY_ID
                or run.graph_revision != graph_revision
                or not self._unexpired(run)
            ):
                return None
            # An explicit run id comes from the form's server-issued scope.
            # It must never use a new transcript to overwrite its encrypted
            # value or bypass an unconsumed one-time form lease.
            if not _run_has_exact_name(run, name):
                return None
            return await self._transition_to_executing(
                run=run,
                user_id=user_id,
                context_revision=context_revision,
                supplied_name=name,
                allow_missing_name_resume=False,
            )

        active = await self.run_store.find_active_matching_slots(
            user_id=user_id,
            capability_id=LOCATION_CREATE_CIRCLE_CAPABILITY_ID,
            graph_revision=graph_revision,
            slots={"name": name},
            include_slots=True,
        )
        if active is not None:
            return await self._transition_to_executing(
                run=active,
                user_id=user_id,
                context_revision=context_revision,
                supplied_name=name,
                allow_missing_name_resume=False,
            )

        # Preserve an earlier missing-name command if it is the only open
        # Circle task.  This is server-side slot completion, not a UI click or
        # client-supplied run authority.
        resumable = await self.run_store.find_unique_resumable(
            user_id=user_id,
            capability_id=LOCATION_CREATE_CIRCLE_CAPABILITY_ID,
            graph_revision=graph_revision,
            include_slots=True,
        )
        if resumable is not None:
            return await self._transition_to_executing(
                run=resumable,
                user_id=user_id,
                context_revision=context_revision,
                supplied_name=name,
                allow_missing_name_resume=True,
            )

        created = await self.run_store.create(
            user_id=user_id,
            capability_id=LOCATION_CREATE_CIRCLE_CAPABILITY_ID,
            capability_version=capability_version,
            graph_revision=graph_revision,
            slots={"name": name},
            context_revision=context_revision,
            expected_context_revision=context_revision,
            status="authorized",
            idempotency_scope=execution_scope,
        )
        return await self._transition_to_executing(
            run=created,
            user_id=user_id,
            context_revision=context_revision,
            supplied_name=name,
            allow_missing_name_resume=False,
        )

    async def _verify_settlement(
        self, *, run: CapabilityRunV1, user_id: str
    ) -> LocationCircleDirectExecutionResultV1:
        """Read only an existing domain receipt, then complete the run."""

        try:
            await asyncio.to_thread(
                self._circle_service_factory().get_circle_for_capability_run,
                owner_user_id=user_id,
                capability_run_id=run.run_id,
            )
        except OneLocationCircleError:
            # The mutation may be committed but temporarily unreadable.  A
            # retry must stay in settlement recovery, never invent success or
            # create another Circle.
            return LocationCircleDirectExecutionResultV1(
                status="settling", run_id=run.run_id, reason_code="settlement_pending"
            )
        except Exception:  # noqa: BLE001 - same fail-closed recovery boundary
            return LocationCircleDirectExecutionResultV1(
                status="settling", run_id=run.run_id, reason_code="settlement_pending"
            )
        try:
            settled = await self.run_store.transition(
                user_id=user_id,
                run_id=run.run_id,
                expected_revision=run.revision,
                to_status="verified_succeeded",
                step_cursor="verified",
                pending_interaction=None,
            )
        except CapabilityRunConflictError:
            current = await self.run_store.get(
                user_id=user_id, run_id=run.run_id, include_slots=False
            )
            if (
                current is not None
                and current.status == "verified_succeeded"
                and self._unexpired(current)
            ):
                return LocationCircleDirectExecutionResultV1(
                    status="completed", run_id=current.run_id
                )
            return LocationCircleDirectExecutionResultV1(
                status="settling", run_id=run.run_id, reason_code="settlement_pending"
            )
        except (CapabilityRunAuthorityError, ValueError):
            return LocationCircleDirectExecutionResultV1(
                status="settling", run_id=run.run_id, reason_code="settlement_pending"
            )
        return LocationCircleDirectExecutionResultV1(status="completed", run_id=settled.run_id)

    async def _mark_failed(self, *, run: CapabilityRunV1, user_id: str) -> None:
        if run.status != "executing":
            return
        try:
            await self.run_store.transition(
                user_id=user_id,
                run_id=run.run_id,
                expected_revision=run.revision,
                to_status="verified_failed",
                step_cursor="failed",
                pending_interaction=None,
            )
        except (CapabilityRunAuthorityError, CapabilityRunConflictError, ValueError):
            # A stale retry may already be settling.  Never overwrite it.
            return

    async def execute(
        self,
        *,
        user_id: str,
        vault_owner_token: str,
        name: Any,
        execution_scope: str,
        resume_run_id: str | None = None,
        context_revision: str = "",
    ) -> LocationCircleDirectExecutionResultV1:
        """Create/recover one Circle without importing the ADK action gateway."""

        owner = str(user_id or "").strip()[:256]
        scope = str(execution_scope or "").strip()
        resume_id = str(resume_run_id or "").strip() or None
        context = str(context_revision or "").strip()
        if not owner or not _EXECUTION_SCOPE_RE.fullmatch(scope):
            return LocationCircleDirectExecutionResultV1(
                status="failed", reason_code="invalid_scope"
            )
        if resume_id is not None and not _RUN_ID_RE.fullmatch(resume_id):
            return LocationCircleDirectExecutionResultV1(status="failed", reason_code="invalid_run")
        if not _CONTEXT_REVISION_RE.fullmatch(context):
            return LocationCircleDirectExecutionResultV1(
                status="failed", reason_code="invalid_context"
            )
        try:
            clean_name = normalize_location_circle_name(name)
        except ValueError:
            return LocationCircleDirectExecutionResultV1(
                status="invalid_slots", reason_code="invalid_circle_name"
            )
        if not await self._authorize(user_id=owner, vault_owner_token=vault_owner_token):
            return LocationCircleDirectExecutionResultV1(
                status="blocked", reason_code="authorization_required"
            )
        contract = self._contract()
        if contract is None:
            return LocationCircleDirectExecutionResultV1(
                status="blocked", reason_code="contract_unavailable"
            )
        graph_revision, capability_version = contract
        try:
            run = await self._load_or_create_run(
                user_id=owner,
                name=clean_name,
                execution_scope=scope,
                resume_run_id=resume_id,
                graph_revision=graph_revision,
                capability_version=capability_version,
                context_revision=context,
            )
        except (CapabilityRunAuthorityError, CapabilityRunConflictError, ValueError):
            return LocationCircleDirectExecutionResultV1(
                status="failed", reason_code="run_unavailable"
            )
        except Exception:  # noqa: BLE001 - store implementation detail is private
            return LocationCircleDirectExecutionResultV1(
                status="failed", reason_code="run_unavailable"
            )
        if run is None:
            return LocationCircleDirectExecutionResultV1(
                status="failed", reason_code="run_unavailable"
            )
        if not self._unexpired(run):
            return LocationCircleDirectExecutionResultV1(
                status="failed", run_id=run.run_id, reason_code="run_expired"
            )
        if run.status == "verified_succeeded":
            # A terminal database bit alone is not sufficient for a command
            # response.  Re-read the run-bound domain receipt before claiming
            # completion after a lost response or process restart.
            try:
                await asyncio.to_thread(
                    self._circle_service_factory().get_circle_for_capability_run,
                    owner_user_id=owner,
                    capability_run_id=run.run_id,
                )
            except Exception:  # noqa: BLE001 - never claim a missing receipt
                return LocationCircleDirectExecutionResultV1(
                    status="settling", run_id=run.run_id, reason_code="settlement_pending"
                )
            return LocationCircleDirectExecutionResultV1(status="completed", run_id=run.run_id)
        if run.status == "settlement_received":
            return await self._verify_settlement(run=run, user_id=owner)
        if run.status in {
            "needs_input",
            "entity_choice",
            "interaction_required",
            "confirmation_required",
            "paused",
        }:
            return LocationCircleDirectExecutionResultV1(
                status="paused", run_id=run.run_id, reason_code="interaction_required"
            )
        if run.status != "executing":
            return LocationCircleDirectExecutionResultV1(
                status="failed", run_id=run.run_id, reason_code="run_unavailable"
            )

        try:
            # The domain service locks the owner's Circle rows and keys a
            # replay on ``capability_run_id``.  Concurrent relay retries may
            # enter this call, but they cannot create two Circles.
            await asyncio.to_thread(
                self._circle_service_factory().create_or_get_circle,
                owner_user_id=owner,
                name=clean_name,
                kind="other",
                capability_run_id=run.run_id,
            )
        except OneLocationCircleError:
            await self._mark_failed(run=run, user_id=owner)
            return LocationCircleDirectExecutionResultV1(
                status="failed", run_id=run.run_id, reason_code="execution_failed"
            )
        except Exception:  # noqa: BLE001 - no service detail, no false success
            await self._mark_failed(run=run, user_id=owner)
            return LocationCircleDirectExecutionResultV1(
                status="failed", run_id=run.run_id, reason_code="execution_failed"
            )

        try:
            received = await self.run_store.transition(
                user_id=owner,
                run_id=run.run_id,
                expected_revision=run.revision,
                to_status="settlement_received",
                step_cursor="settlement_received",
                settlement_reference=LOCATION_CREATE_CIRCLE_SETTLEMENT_REFERENCE,
                pending_interaction=None,
            )
        except CapabilityRunConflictError:
            current = await self.run_store.get(
                user_id=owner, run_id=run.run_id, include_slots=False
            )
            if current is not None and current.status == "settlement_received":
                return await self._verify_settlement(run=current, user_id=owner)
            if (
                current is not None
                and current.status == "verified_succeeded"
                and self._unexpired(current)
            ):
                return LocationCircleDirectExecutionResultV1(
                    status="completed", run_id=current.run_id
                )
            return LocationCircleDirectExecutionResultV1(
                status="settling", run_id=run.run_id, reason_code="settlement_pending"
            )
        except (CapabilityRunAuthorityError, ValueError):
            # The Circle mutation may already be committed. Keep its run
            # recoverable and never render a terminal card until readback.
            return LocationCircleDirectExecutionResultV1(
                status="settling", run_id=run.run_id, reason_code="settlement_pending"
            )
        return await self._verify_settlement(run=received, user_id=owner)


_default_executor: LocationCircleDirectExecutor | None = None


def get_location_circle_direct_executor() -> LocationCircleDirectExecutor:
    """Return the process-local, dependency-light Circle executor."""

    global _default_executor
    if _default_executor is None:
        _default_executor = LocationCircleDirectExecutor()
    return _default_executor


async def execute_location_create_circle(
    *,
    user_id: str,
    vault_owner_token: str,
    name: Any,
    execution_scope: str,
    resume_run_id: str | None = None,
    context_revision: str = "",
) -> dict[str, str]:
    """Compatibility-shaped entrypoint used by command and typed-form code."""

    result = await get_location_circle_direct_executor().execute(
        user_id=user_id,
        vault_owner_token=vault_owner_token,
        name=name,
        execution_scope=execution_scope,
        resume_run_id=resume_run_id,
        context_revision=context_revision,
    )
    return result.wire_projection()


__all__ = [
    "LOCATION_CREATE_CIRCLE_CAPABILITY_ID",
    "LOCATION_CREATE_CIRCLE_SETTLEMENT_REFERENCE",
    "LocationCircleDirectExecutionResultV1",
    "LocationCircleDirectExecutor",
    "execute_location_create_circle",
    "get_location_circle_direct_executor",
    "normalize_location_circle_name",
]

"""Durable typed-name interaction for the audited Circle capability.

This module deliberately sits between the transcript-first Location command
runtime and the existing server-direct Circle adapter.  A missing name is not
a conversational ``ASK``: it becomes a server-owned ``CapabilityRunV1`` plus
one short-lived, revision-bound typed-form directive.  The browser/iOS client
can render the fixed form, but it cannot mint a directive, alter its run, or
claim the Circle mutation succeeded.

No raw name is logged, returned in a directive, sent to a model, or placed in
telemetry.  It is encrypted only in the already-audited capability-run slot
envelope immediately before the direct adapter consumes it.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Awaitable, Callable, Literal, Mapping
from uuid import uuid4

from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.app_intelligence_runtime import load_capability_graph
from hushh_mcp.services.capability_run_service import (
    CapabilityRunAuthorityError,
    CapabilityRunConflictError,
    CapabilityRunStore,
    CapabilityRunV1,
    get_capability_run_store,
)
from hushh_mcp.services.location_circle_direct_executor import execute_location_create_circle

LOCATION_CIRCLE_NAME_INTERACTION_SCHEMA_VERSION = "one.location_circle_name_interaction.v1"
LOCATION_CIRCLE_NAME_SUBMIT_SCHEMA_VERSION = "one.location_circle_name_submit_result.v1"
LOCATION_CIRCLE_NAME_ACTION_ID = "location.create_circle"
LOCATION_CIRCLE_NAME_SURFACE_ID = "render.form"
LOCATION_CIRCLE_NAME_FORM_ID = "one.location.create_circle_name.v1"
LOCATION_CIRCLE_NAME_STEP = "ask.name"
LOCATION_CIRCLE_NAME_PENDING_PREFIX = "one.location.circle_name_form.v1"
LOCATION_CIRCLE_NAME_LEASE_TTL_SECONDS = 15 * 60

_DIRECTIVE_RE = re.compile(r"^loccirclecmd_[a-f0-9]{32}$")
_LEASE_RE = re.compile(r"^loccirclelease_[0-9]{10,11}_[a-f0-9]{64}$")
_RUN_ID_RE = re.compile(r"^run_[a-z0-9]{16,96}$")
_CONTEXT_REVISION_RE = re.compile(r"^[A-Za-z0-9_.:-]{0,191}$")
_PENDING_RE = re.compile(r"^one\.location\.circle_name_form\.v1:([0-9]{10,11})$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_LEASE_DOMAIN = b"hushh.location.circle-name-form.lease.v1\x00"
_CREATION_SCOPE_DOMAIN = b"hushh.location.circle-name-form.create.v1\x00"
_EXECUTION_SCOPE_DOMAIN = b"hushh.location.circle-name-form.execute.v1\x00"

# This is an identifier-only display card. Its copy is fixed in the client
# catalog; a user-provided Circle name never becomes generated card content.
CIRCLE_VERIFIED_STATUS_CARD: Mapping[str, str] = {
    "schemaVersion": "one.location_command_status_card.v1",
    "surfaceId": "render.data_card",
    "cardId": "one.location.command.circle_verified.v1",
    "actionId": LOCATION_CIRCLE_NAME_ACTION_ID,
    "settlement": "verified",
}


class LocationCircleNameInteractionError(RuntimeError):
    """The Circle-name form cannot safely be issued or settled."""


class LocationCircleNameAuthorityError(LocationCircleNameInteractionError):
    """The authenticated owner or compiled execution contract is unavailable."""


class LocationCircleNameConflictError(LocationCircleNameInteractionError):
    """A lease, revision, or durable task no longer matches the submission."""


@dataclass(frozen=True)
class LocationCircleNameDirectiveV1:
    """Safe projection for the one approved Circle-name form."""

    directive_id: str
    run_id: str
    run_revision: int
    graph_revision: str
    context_revision: str
    lease_id: str
    expires_at: datetime

    def wire_projection(self) -> dict[str, Any]:
        return {
            "schemaVersion": LOCATION_CIRCLE_NAME_INTERACTION_SCHEMA_VERSION,
            "actionId": LOCATION_CIRCLE_NAME_ACTION_ID,
            "surfaceId": LOCATION_CIRCLE_NAME_SURFACE_ID,
            "formId": LOCATION_CIRCLE_NAME_FORM_ID,
            "directiveId": self.directive_id,
            "run": {
                "runId": self.run_id,
                "revision": self.run_revision,
                "graphRevision": self.graph_revision,
                "contextRevision": self.context_revision,
                "status": "needs_input",
            },
            "lease": {
                "leaseId": self.lease_id,
                "runRevision": self.run_revision,
            },
            "expiresAt": self.expires_at.isoformat(),
            "titleKey": "one.location.circle_name.title",
            "bodyKey": "one.location.circle_name.body",
            "fields": [
                {
                    "fieldId": "name",
                    "type": "string",
                    "required": True,
                    "maxLength": 80,
                }
            ],
            "submitKey": "one.location.circle_name.submit",
        }


@dataclass(frozen=True)
class LocationCircleNameSubmitResultV1:
    """Opaque terminal/recovery result for a form submission."""

    status: Literal["verified", "working", "failed"]
    run_id: str
    status_card: Mapping[str, str] | None = None
    reason_code: str | None = None

    def wire_projection(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "schemaVersion": LOCATION_CIRCLE_NAME_SUBMIT_SCHEMA_VERSION,
            "status": self.status,
            "actionId": LOCATION_CIRCLE_NAME_ACTION_ID,
            "runId": self.run_id,
        }
        if self.status_card is not None:
            payload["statusCard"] = dict(self.status_card)
        if self.reason_code:
            payload["reasonCode"] = self.reason_code
        return payload


async def _dispatch_circle_server_direct(
    *,
    user_id: str,
    vault_owner_token: str,
    name: str,
    execution_scope: str,
    resume_run_id: str,
) -> Mapping[str, Any]:
    """Use only the narrow, audited, run-bound Circle executor."""

    return await execute_location_create_circle(
        user_id=user_id,
        vault_owner_token=vault_owner_token,
        name=name,
        execution_scope=execution_scope,
        resume_run_id=resume_run_id,
    )


def normalize_circle_name(value: Any) -> str:
    """Validate the typed free-form value before it reaches durable storage."""

    if not isinstance(value, str):
        raise LocationCircleNameConflictError("Circle name is invalid.")
    name = unicodedata.normalize("NFC", " ".join(value.split()))
    if (
        not name
        or len(name) > 80
        or _CONTROL_RE.search(name) is not None
        or any(unicodedata.category(character).startswith("C") for character in name)
    ):
        raise LocationCircleNameConflictError("Circle name is invalid.")
    return name


def _canonical_json(value: Mapping[str, Any]) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode(
        "utf-8"
    )


def _pending_marker(expires_at: datetime) -> str:
    return f"{LOCATION_CIRCLE_NAME_PENDING_PREFIX}:{int(expires_at.timestamp())}"


def _parse_pending_expiry(value: str | None) -> datetime | None:
    match = _PENDING_RE.fullmatch(str(value or "").strip())
    if match is None:
        return None
    try:
        return datetime.fromtimestamp(int(match.group(1)), tz=UTC)
    except (OverflowError, OSError, ValueError):
        return None


def _same_stored_name(run: CapabilityRunV1, submitted_name: str) -> bool:
    slots = run.slots if isinstance(run.slots, Mapping) else {}
    try:
        stored = normalize_circle_name(slots.get("name"))
    except LocationCircleNameConflictError:
        return False
    return hmac.compare_digest(stored, submitted_name)


class LocationCircleNameInteractionService:
    """Issue and consume the fixed Circle-name form against a durable run."""

    def __init__(
        self,
        *,
        run_store: CapabilityRunStore | None = None,
        graph_loader: Callable[[], Mapping[str, Any]] = load_capability_graph,
        dispatcher: Callable[..., Awaitable[Mapping[str, Any]]] = _dispatch_circle_server_direct,
        hmac_key: str | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._run_store = run_store
        self._graph_loader = graph_loader
        self._dispatcher = dispatcher
        self._hmac_key = hmac_key
        self._now = now or (lambda: datetime.now(UTC))

    @property
    def run_store(self) -> CapabilityRunStore:
        return self._run_store or get_capability_run_store()

    def _key(self) -> bytes:
        value = self._hmac_key
        if value is None:
            try:
                value = str(get_core_security_settings().app_signing_key or "")
            except Exception as exc:  # noqa: BLE001 - fail closed on configuration
                raise LocationCircleNameAuthorityError(
                    "Circle form authority is unavailable."
                ) from exc
        key = str(value or "").strip()
        if len(key) < 32:
            raise LocationCircleNameAuthorityError("Circle form authority is unavailable.")
        return key.encode("utf-8")

    def _contract(self) -> tuple[str, int]:
        try:
            graph = self._graph_loader()
        except Exception as exc:  # noqa: BLE001 - generated graph is authoritative
            raise LocationCircleNameAuthorityError("Circle form contract is unavailable.") from exc
        if not isinstance(graph, Mapping):
            raise LocationCircleNameAuthorityError("Circle form contract is unavailable.")
        graph_revision = str(graph.get("revision") or "").strip()
        actions = graph.get("actions")
        surfaces = graph.get("render_surfaces")
        capability = next(
            (
                item
                for item in (actions if isinstance(actions, list) else [])
                if isinstance(item, Mapping)
                and str(item.get("capability_id") or "") == LOCATION_CIRCLE_NAME_ACTION_ID
            ),
            None,
        )
        schema = capability.get("inputSchema") if isinstance(capability, Mapping) else None
        schema = schema if isinstance(schema, Mapping) else {}
        properties = (
            schema.get("properties") if isinstance(schema.get("properties"), Mapping) else {}
        )
        name_schema = properties.get("name") if isinstance(properties, Mapping) else None
        required = schema.get("required") if isinstance(schema.get("required"), list) else []
        execution = capability.get("execution") if isinstance(capability, Mapping) else None
        execution = execution if isinstance(execution, Mapping) else {}
        executor = (
            execution.get("executor") if isinstance(execution.get("executor"), Mapping) else {}
        )
        has_form = any(
            isinstance(surface, Mapping)
            and str(surface.get("capability_id") or "") == LOCATION_CIRCLE_NAME_SURFACE_ID
            for surface in (surfaces if isinstance(surfaces, list) else [])
        )
        if (
            not graph_revision
            or not isinstance(capability, Mapping)
            or not isinstance(name_schema, Mapping)
            or name_schema.get("type") != "string"
            or "name" not in required
            or execution.get("mode") != "server_direct"
            or execution.get("outcome") != "EXECUTE"
            or executor.get("kind") != "backend_service"
            or executor.get("settlement") != "verified_backend_service_result"
            or not has_form
        ):
            raise LocationCircleNameAuthorityError("Circle form contract is unavailable.")
        try:
            version = max(1, int(capability.get("version") or 1))
        except (TypeError, ValueError) as exc:
            raise LocationCircleNameAuthorityError("Circle form contract is unavailable.") from exc
        return graph_revision, version

    def _lease_id(self, run: CapabilityRunV1, *, directive_id: str, expires_at: datetime) -> str:
        if not _DIRECTIVE_RE.fullmatch(directive_id):
            raise LocationCircleNameAuthorityError("Circle form directive is invalid.")
        expiry = int(expires_at.timestamp())
        payload = {
            "schema": LOCATION_CIRCLE_NAME_INTERACTION_SCHEMA_VERSION,
            "user": run.user_id,
            "run": run.run_id,
            "directive": directive_id,
            "revision": run.revision,
            "graph": run.graph_revision,
            "context": run.context_revision,
            "surface": LOCATION_CIRCLE_NAME_SURFACE_ID,
            "form": LOCATION_CIRCLE_NAME_FORM_ID,
            "expiry": expiry,
        }
        digest = hmac.new(
            self._key(), _LEASE_DOMAIN + _canonical_json(payload), hashlib.sha256
        ).hexdigest()
        return f"loccirclelease_{expiry}_{digest}"

    def _verify_lease(
        self,
        run: CapabilityRunV1,
        *,
        directive_id: str,
        lease_id: str,
        expires_at: datetime,
    ) -> bool:
        expected = self._lease_id(run, directive_id=directive_id, expires_at=expires_at)
        return bool(_LEASE_RE.fullmatch(lease_id) and hmac.compare_digest(expected, lease_id))

    def _creation_scope(
        self,
        *,
        user_id: str,
        graph_revision: str,
        latest: CapabilityRunV1 | None,
    ) -> str:
        # A terminal/latest run fingerprint changes after settlement.  Thus a
        # pair of concurrent initial form requests coalesce, while a later
        # intentional Circle request gets a new durable run.
        payload = {
            "user": user_id,
            "action": LOCATION_CIRCLE_NAME_ACTION_ID,
            "graph": graph_revision,
            "previous_run": latest.run_id if latest is not None else "",
            "previous_revision": latest.revision if latest is not None else 0,
            "previous_status": latest.status if latest is not None else "none",
        }
        digest = hmac.new(
            self._key(), _CREATION_SCOPE_DOMAIN + _canonical_json(payload), hashlib.sha256
        ).hexdigest()
        return f"loccircleform_{digest}"

    def _execution_scope(self, run: CapabilityRunV1, *, directive_id: str) -> str:
        payload = {
            "user": run.user_id,
            "action": LOCATION_CIRCLE_NAME_ACTION_ID,
            "run": run.run_id,
            "directive": directive_id,
            "graph": run.graph_revision,
        }
        digest = hmac.new(
            self._key(), _EXECUTION_SCOPE_DOMAIN + _canonical_json(payload), hashlib.sha256
        ).hexdigest()
        return f"loccircleformexec_{digest}"

    def _directive_from_run(self, run: CapabilityRunV1) -> LocationCircleNameDirectiveV1 | None:
        expiry = _parse_pending_expiry(run.pending_interaction)
        directive_id = str(run.pending_directive_id or "")
        if (
            run.status != "needs_input"
            or expiry is None
            or expiry <= self._now()
            or not _DIRECTIVE_RE.fullmatch(directive_id)
            or not _RUN_ID_RE.fullmatch(run.run_id)
            or not _CONTEXT_REVISION_RE.fullmatch(run.context_revision)
        ):
            return None
        return LocationCircleNameDirectiveV1(
            directive_id=directive_id,
            run_id=run.run_id,
            run_revision=run.revision,
            graph_revision=run.graph_revision,
            context_revision=run.context_revision,
            lease_id=self._lease_id(run, directive_id=directive_id, expires_at=expiry),
            expires_at=expiry,
        )

    async def _issue_for_waiting_run(self, run: CapabilityRunV1) -> LocationCircleNameDirectiveV1:
        existing = self._directive_from_run(run)
        if existing is not None:
            return existing
        expires_at = self._now() + timedelta(seconds=LOCATION_CIRCLE_NAME_LEASE_TTL_SECONDS)
        directive_id = f"loccirclecmd_{uuid4().hex}"
        try:
            replaced = await self.run_store.replace_pending_directive(
                user_id=run.user_id,
                run_id=run.run_id,
                expected_revision=run.revision,
                pending_interaction=_pending_marker(expires_at),
                pending_directive_id=directive_id,
            )
        except CapabilityRunConflictError:
            current = await self.run_store.get(
                user_id=run.user_id, run_id=run.run_id, include_slots=False
            )
            recovered = self._directive_from_run(current) if current is not None else None
            if recovered is not None:
                return recovered
            raise LocationCircleNameConflictError(
                "Circle name request changed. Try again."
            ) from None
        directive = self._directive_from_run(replaced)
        if directive is None:
            raise LocationCircleNameAuthorityError("Circle form directive is unavailable.")
        return directive

    async def issue(
        self,
        *,
        user_id: str,
        context_revision: str,
    ) -> LocationCircleNameDirectiveV1:
        """Start/resume exactly one missing-name task and issue its typed form."""

        owner = str(user_id or "").strip()[:256]
        context = str(context_revision or "").strip()
        if not owner or not _CONTEXT_REVISION_RE.fullmatch(context):
            raise LocationCircleNameAuthorityError("Circle form authority is unavailable.")
        graph_revision, capability_version = self._contract()
        try:
            open_run = await self.run_store.find_unique_open_for_capability(
                user_id=owner,
                capability_id=LOCATION_CIRCLE_NAME_ACTION_ID,
                include_slots=True,
            )
        except (CapabilityRunAuthorityError, CapabilityRunConflictError) as exc:
            raise LocationCircleNameConflictError("Circle request changed. Try again.") from exc
        if open_run is not None:
            if open_run.graph_revision != graph_revision:
                raise LocationCircleNameConflictError("Circle request needs a fresh start.")
            if open_run.status != "needs_input":
                raise LocationCircleNameConflictError("Circle request is already being completed.")
            return await self._issue_for_waiting_run(open_run)
        try:
            latest = await self.run_store.find_latest_for_capability(
                user_id=owner,
                capability_id=LOCATION_CIRCLE_NAME_ACTION_ID,
                include_slots=False,
            )
            expires_at = self._now() + timedelta(seconds=LOCATION_CIRCLE_NAME_LEASE_TTL_SECONDS)
            directive_id = f"loccirclecmd_{uuid4().hex}"
            run = await self.run_store.create(
                user_id=owner,
                capability_id=LOCATION_CIRCLE_NAME_ACTION_ID,
                capability_version=capability_version,
                graph_revision=graph_revision,
                context_revision=context,
                expected_context_revision=context,
                step_cursor=LOCATION_CIRCLE_NAME_STEP,
                status="needs_input",
                pending_interaction=_pending_marker(expires_at),
                pending_directive_id=directive_id,
                idempotency_scope=self._creation_scope(
                    user_id=owner,
                    graph_revision=graph_revision,
                    latest=latest,
                ),
            )
        except (CapabilityRunAuthorityError, CapabilityRunConflictError, ValueError) as exc:
            raise LocationCircleNameAuthorityError("Circle form authority is unavailable.") from exc
        if (
            run.capability_id != LOCATION_CIRCLE_NAME_ACTION_ID
            or run.graph_revision != graph_revision
            or run.status != "needs_input"
        ):
            raise LocationCircleNameConflictError("Circle request changed. Try again.")
        return await self._issue_for_waiting_run(run)

    async def find_active(self, *, user_id: str) -> LocationCircleNameDirectiveV1 | None:
        """Return only an existing valid form; never create one on a read."""

        owner = str(user_id or "").strip()[:256]
        if not owner:
            raise LocationCircleNameAuthorityError("Circle form authority is unavailable.")
        graph_revision, _version = self._contract()
        try:
            run = await self.run_store.find_unique_resumable(
                user_id=owner,
                capability_id=LOCATION_CIRCLE_NAME_ACTION_ID,
                graph_revision=graph_revision,
                include_slots=False,
            )
        except (CapabilityRunAuthorityError, CapabilityRunConflictError) as exc:
            raise LocationCircleNameConflictError("Circle request changed. Try again.") from exc
        return self._directive_from_run(run) if run is not None else None

    async def _dispatch_after_authorization(
        self,
        *,
        run: CapabilityRunV1,
        directive_id: str,
        vault_owner_token: str,
        name: str,
    ) -> LocationCircleNameSubmitResultV1:
        try:
            result = await self._dispatcher(
                user_id=run.user_id,
                vault_owner_token=vault_owner_token,
                name=name,
                execution_scope=self._execution_scope(run, directive_id=directive_id),
                resume_run_id=run.run_id,
            )
        except Exception:  # noqa: BLE001 - adapter detail and name remain server-only
            current = await self.run_store.get(
                user_id=run.user_id, run_id=run.run_id, include_slots=True
            )
            if current is not None and current.status in {
                "authorized",
                "executing",
                "settlement_received",
            }:
                return LocationCircleNameSubmitResultV1(status="working", run_id=run.run_id)
            return LocationCircleNameSubmitResultV1(
                status="failed", run_id=run.run_id, reason_code="execution_unavailable"
            )
        result_status = str(result.get("status") or "") if isinstance(result, Mapping) else ""
        if result_status == "completed":
            return LocationCircleNameSubmitResultV1(
                status="verified",
                run_id=run.run_id,
                status_card=CIRCLE_VERIFIED_STATUS_CARD,
            )
        if result_status == "settling":
            return LocationCircleNameSubmitResultV1(status="working", run_id=run.run_id)
        if result_status in {"blocked", "paused"}:
            return LocationCircleNameSubmitResultV1(
                status="failed", run_id=run.run_id, reason_code="execution_blocked"
            )
        return LocationCircleNameSubmitResultV1(
            status="failed", run_id=run.run_id, reason_code="execution_failed"
        )

    async def _recover_duplicate_submit(
        self,
        *,
        run: CapabilityRunV1,
        directive_id: str,
        vault_owner_token: str,
        name: str,
    ) -> LocationCircleNameSubmitResultV1:
        # Retain the opaque directive id through settlement solely to bind a
        # lost-response replay to the form that originally authorized this
        # run.  It is never exposed by general run projections and cannot
        # make a non-waiting run submit-ready again.
        if not hmac.compare_digest(str(run.pending_directive_id or ""), directive_id):
            raise LocationCircleNameConflictError("Circle name request changed. Try again.")
        if not _same_stored_name(run, name):
            raise LocationCircleNameConflictError("Circle name request changed. Try again.")
        if run.status == "verified_succeeded":
            return LocationCircleNameSubmitResultV1(
                status="verified", run_id=run.run_id, status_card=CIRCLE_VERIFIED_STATUS_CARD
            )
        if run.status in {"authorized", "executing", "settlement_received"}:
            return await self._dispatch_after_authorization(
                run=run,
                directive_id=directive_id,
                vault_owner_token=vault_owner_token,
                name=name,
            )
        raise LocationCircleNameConflictError("Circle name request changed. Try again.")

    async def submit(
        self,
        *,
        user_id: str,
        vault_owner_token: str,
        run_id: str,
        expected_revision: int,
        directive_id: str,
        lease_id: str,
        name: Any,
    ) -> LocationCircleNameSubmitResultV1:
        """Consume one form lease, store its encrypted value, and settle once."""

        owner = str(user_id or "").strip()[:256]
        token = str(vault_owner_token or "").strip()
        clean_run_id = str(run_id or "").strip()
        clean_directive_id = str(directive_id or "").strip()
        clean_lease_id = str(lease_id or "").strip()
        if (
            not owner
            or not token
            or not _RUN_ID_RE.fullmatch(clean_run_id)
            or not _DIRECTIVE_RE.fullmatch(clean_directive_id)
            or not _LEASE_RE.fullmatch(clean_lease_id)
            or not isinstance(expected_revision, int)
            or isinstance(expected_revision, bool)
            or expected_revision < 1
        ):
            raise LocationCircleNameConflictError("Circle name request is invalid.")
        normalized_name = normalize_circle_name(name)
        graph_revision, _version = self._contract()
        try:
            run = await self.run_store.get(user_id=owner, run_id=clean_run_id, include_slots=True)
        except CapabilityRunAuthorityError as exc:
            raise LocationCircleNameAuthorityError("Circle request is unavailable.") from exc
        if run is None:
            raise LocationCircleNameAuthorityError("Circle request is unavailable.")
        if (
            run.capability_id != LOCATION_CIRCLE_NAME_ACTION_ID
            or run.graph_revision != graph_revision
        ):
            raise LocationCircleNameConflictError("Circle name request changed. Try again.")
        # A lost HTTPS response is not a new mutation. If the exact encrypted
        # value already settled (or is in flight), recover the same durable run
        # before inspecting the old one-time lease.
        if run.status != "needs_input":
            return await self._recover_duplicate_submit(
                run=run,
                directive_id=clean_directive_id,
                vault_owner_token=token,
                name=normalized_name,
            )
        expires_at = _parse_pending_expiry(run.pending_interaction)
        if (
            expires_at is None
            or expires_at <= self._now()
            or run.revision != expected_revision
            or run.pending_directive_id != clean_directive_id
            or not self._verify_lease(
                run,
                directive_id=clean_directive_id,
                lease_id=clean_lease_id,
                expires_at=expires_at,
            )
        ):
            raise LocationCircleNameConflictError("Circle name request changed. Try again.")
        existing_slots = run.slots if isinstance(run.slots, Mapping) else {}
        if "name" in existing_slots:
            raise LocationCircleNameConflictError("Circle name request changed. Try again.")
        try:
            authorized = await self.run_store.transition(
                user_id=owner,
                run_id=run.run_id,
                expected_revision=run.revision,
                to_status="authorized",
                step_cursor="input_supplied",
                pending_interaction=None,
                pending_directive_id=clean_directive_id,
                slots={**existing_slots, "name": normalized_name},
            )
        except CapabilityRunConflictError:
            current = await self.run_store.get(user_id=owner, run_id=run.run_id, include_slots=True)
            if current is None:
                raise LocationCircleNameAuthorityError("Circle request is unavailable.") from None
            return await self._recover_duplicate_submit(
                run=current,
                directive_id=clean_directive_id,
                vault_owner_token=token,
                name=normalized_name,
            )
        return await self._dispatch_after_authorization(
            run=authorized,
            directive_id=clean_directive_id,
            vault_owner_token=token,
            name=normalized_name,
        )


_service: LocationCircleNameInteractionService | None = None


def get_location_circle_name_interaction_service() -> LocationCircleNameInteractionService:
    global _service
    if _service is None:
        _service = LocationCircleNameInteractionService()
    return _service


__all__ = [
    "CIRCLE_VERIFIED_STATUS_CARD",
    "LOCATION_CIRCLE_NAME_ACTION_ID",
    "LOCATION_CIRCLE_NAME_INTERACTION_SCHEMA_VERSION",
    "LOCATION_CIRCLE_NAME_SUBMIT_SCHEMA_VERSION",
    "LocationCircleNameAuthorityError",
    "LocationCircleNameConflictError",
    "LocationCircleNameDirectiveV1",
    "LocationCircleNameInteractionError",
    "LocationCircleNameInteractionService",
    "LocationCircleNameSubmitResultV1",
    "get_location_circle_name_interaction_service",
    "normalize_circle_name",
]

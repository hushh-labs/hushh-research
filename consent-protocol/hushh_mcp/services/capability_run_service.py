"""Durable, server-owned CapabilityRunV1 state for Agent One.

This is deliberately a small authority boundary. It persists only opaque
identifiers, encrypted bounded slots, and settlement hashes; raw speech,
transcripts, entity values, routes, provider payloads, and UI summaries never
enter the row or its logs. Every entrypoint (voice, typed, Siri, web, iOS) can
resume the same run by its opaque id, but only a backend executor can mark it
verified successful.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Mapping
from uuid import uuid4

from db.db_client import get_db
from hushh_mcp.runtime_settings import get_core_security_settings

CapabilityRunStatus = Literal[
    "proposed",
    "needs_input",
    "entity_choice",
    "interaction_required",
    "confirmation_required",
    "authorized",
    "executing",
    "settlement_received",
    "verified_succeeded",
    "verified_failed",
    "paused",
    "cancelled",
    "expired",
]

_STATUS_VALUES: frozenset[str] = frozenset(
    {
        "proposed",
        "needs_input",
        "entity_choice",
        "interaction_required",
        "confirmation_required",
        "authorized",
        "executing",
        "settlement_received",
        "verified_succeeded",
        "verified_failed",
        "paused",
        "cancelled",
        "expired",
    }
)
_TERMINAL_STATUSES: frozenset[str] = frozenset(
    {"verified_succeeded", "verified_failed", "cancelled", "expired"}
)
# These states have useful recovery semantics after a browser/iOS process or
# Live socket goes away.  ``proposed`` deliberately stays out: it has not
# reached a concrete next step yet, so surfacing it would encourage a client
# to invent one.  Terminal rows are excluded both for privacy and because a
# completed task must never be offered as resumable.
RESUMABLE_CAPABILITY_RUN_STATUSES: frozenset[str] = frozenset(
    {
        "needs_input",
        "entity_choice",
        "interaction_required",
        "confirmation_required",
        "authorized",
        "executing",
        "settlement_received",
        "paused",
    }
)
MAX_CAPABILITY_RUN_RESUME_SUMMARIES = 3
# Retention runs from an authenticated scheduler.  Keep each database mutation
# deliberately small so expiry cleanup cannot hold a broad lock over active
# workflow authority rows.
MAX_CAPABILITY_RUN_RETENTION_PURGE = 500
_CREATABLE_STATUSES: frozenset[str] = frozenset(
    {
        "proposed",
        "needs_input",
        "entity_choice",
        "interaction_required",
        "confirmation_required",
        "authorized",
        "paused",
    }
)
_ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    "proposed": frozenset(
        {
            "needs_input",
            "entity_choice",
            "interaction_required",
            "confirmation_required",
            "authorized",
            "cancelled",
            "expired",
        }
    ),
    "needs_input": frozenset(
        {
            "entity_choice",
            "interaction_required",
            "confirmation_required",
            "authorized",
            "paused",
            "cancelled",
            "expired",
        }
    ),
    "entity_choice": frozenset(
        {
            "needs_input",
            "interaction_required",
            "confirmation_required",
            "authorized",
            "paused",
            "cancelled",
            "expired",
        }
    ),
    "interaction_required": frozenset(
        {"needs_input", "entity_choice", "authorized", "paused", "cancelled", "expired"}
    ),
    "confirmation_required": frozenset({"authorized", "cancelled", "expired"}),
    "authorized": frozenset({"executing", "paused", "cancelled", "expired"}),
    "executing": frozenset({"settlement_received", "verified_failed", "paused", "expired"}),
    "settlement_received": frozenset(
        {"verified_succeeded", "verified_failed", "paused", "expired"}
    ),
    "paused": frozenset(
        {
            "needs_input",
            "entity_choice",
            "interaction_required",
            "confirmation_required",
            "authorized",
            "cancelled",
            "expired",
        }
    ),
    "verified_succeeded": frozenset(),
    "verified_failed": frozenset(),
    "cancelled": frozenset(),
    "expired": frozenset(),
}
_CAPABILITY_ID_RE = re.compile(r"^[a-z][a-z0-9_.:-]{0,191}$")
_STEP_CURSOR_RE = re.compile(r"^[a-zA-Z0-9_.:-]{1,191}$")
_UNSET = object()


class CapabilityRunAuthorityError(RuntimeError):
    """A run cannot be created, resumed, or advanced safely."""


class CapabilityRunConflictError(CapabilityRunAuthorityError):
    """A stale revision or invalid state transition was attempted."""


@dataclass(frozen=True)
class CapabilityRunV1:
    run_id: str
    user_id: str
    capability_id: str
    capability_version: int
    graph_revision: str
    status: CapabilityRunStatus
    step_cursor: str
    context_revision: str
    expected_context_revision: str
    pending_interaction: str | None
    pending_directive_id: str | None
    idempotency_key: str
    settlement_reference_hmac: str | None
    revision: int
    expires_at: datetime | None
    slots: dict[str, Any] | None = None

    @property
    def is_terminal(self) -> bool:
        return self.status in _TERMINAL_STATUSES


@dataclass(frozen=True)
class CapabilityRunResumeSummaryV1:
    """The only durable-run projection permitted in general Live context.

    In particular, this intentionally has no slots, identity, graph revision,
    interaction/directive ids, settlement reference, or timestamps.  A caller
    that needs to advance a task must re-read the owned run through the normal
    authority path rather than treating this display/recovery hint as a grant.
    """

    run_id: str
    capability_id: str
    status: CapabilityRunStatus
    step: str


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _clean_text(value: Any, *, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _clean_slots(raw: Mapping[str, Any] | None) -> dict[str, Any]:
    """Keep a small typed payload suitable for encrypted run persistence."""
    if raw is None:
        return {}
    if not isinstance(raw, Mapping) or len(raw) > 12:
        raise ValueError("Capability run slots must be a bounded object.")
    clean: dict[str, Any] = {}
    for raw_key, raw_value in raw.items():
        key = _clean_text(raw_key, limit=80)
        if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]{0,79}", key):
            raise ValueError("Capability run slot names are invalid.")
        if isinstance(raw_value, bool) or raw_value is None:
            clean[key] = raw_value
        elif isinstance(raw_value, (int, float)) and not isinstance(raw_value, bool):
            clean[key] = raw_value
        elif isinstance(raw_value, str):
            clean[key] = raw_value.strip()[:512]
        else:
            # Nested identifiers, contact records, and provider payloads must
            # be re-resolved by a domain service rather than stored in a run.
            raise ValueError("Capability run slot values must be scalar.")
    return clean


class CapabilityRunStore:
    """Postgres compare-and-set store for shared capability tasks."""

    def __init__(
        self,
        *,
        db: Any | None = None,
        cipher: Any | None = None,
        hmac_key: str | None = None,
    ) -> None:
        self._db = db
        # AgentChatService imports the text agent tree.  Loading it while the
        # Live action tools are importing would create a cycle, even though a
        # run only needs its existing encrypted-envelope helper at first use.
        # Keep the import lazy so the task authority remains usable from every
        # entrypoint.
        self._cipher = cipher
        self._hmac_key = hmac_key

    @property
    def db(self) -> Any:
        if self._db is None:
            self._db = get_db()
        return self._db

    @property
    def hmac_key(self) -> bytes:
        return (self._hmac_key or get_core_security_settings().app_signing_key).encode("utf-8")

    @property
    def cipher(self) -> Any:
        if self._cipher is None:
            from hushh_mcp.services.agent_chat_service import AgentChatService

            self._cipher = AgentChatService()
        return self._cipher

    async def _execute(self, sql: str, params: dict[str, Any]) -> Any:
        return await asyncio.to_thread(self.db.execute_raw, sql, params)

    def _hmac(self, value: Any) -> str:
        return hmac.new(
            self.hmac_key, _canonical_json(value).encode("utf-8"), hashlib.sha256
        ).hexdigest()

    def _encode_slots(self, slots: Mapping[str, Any]) -> dict[str, str | None]:
        if not slots:
            return {
                "slots_ciphertext": None,
                "slots_iv": None,
                "slots_tag": None,
                "slots_algorithm": None,
            }
        encrypted = self.cipher._encrypt_text(_canonical_json(dict(slots)))
        return {
            "slots_ciphertext": str(encrypted.ciphertext),
            "slots_iv": str(encrypted.iv),
            "slots_tag": str(encrypted.tag),
            "slots_algorithm": str(encrypted.algorithm),
        }

    def _decode_slots(self, row: Mapping[str, Any]) -> dict[str, Any]:
        if not row.get("slots_ciphertext"):
            return {}
        raw = self.cipher._decrypt_text(dict(row), "slots")
        decoded = json.loads(raw)
        return _clean_slots(decoded if isinstance(decoded, Mapping) else {})

    @staticmethod
    def _parse_expiry(value: Any) -> datetime | None:
        if isinstance(value, datetime):
            return value if value.tzinfo else value.replace(tzinfo=UTC)
        return None

    def _row_to_run(
        self, row: Mapping[str, Any], *, include_slots: bool = False
    ) -> CapabilityRunV1:
        status = _clean_text(row.get("status"), limit=48)
        if status not in _STATUS_VALUES:
            raise CapabilityRunAuthorityError("Capability run contains an invalid state.")
        slots = self._decode_slots(row) if include_slots else None
        return CapabilityRunV1(
            run_id=_clean_text(row.get("run_id"), limit=96),
            user_id=_clean_text(row.get("user_id"), limit=256),
            capability_id=_clean_text(row.get("capability_id"), limit=192),
            capability_version=max(1, int(row.get("capability_version") or 1)),
            graph_revision=_clean_text(row.get("graph_revision"), limit=128),
            status=status,  # type: ignore[arg-type]
            step_cursor=_clean_text(row.get("step_cursor"), limit=192) or "start",
            context_revision=_clean_text(row.get("context_revision"), limit=192),
            expected_context_revision=_clean_text(row.get("expected_context_revision"), limit=192),
            pending_interaction=_clean_text(row.get("pending_interaction"), limit=96) or None,
            pending_directive_id=_clean_text(row.get("pending_directive_id"), limit=128) or None,
            idempotency_key=_clean_text(row.get("idempotency_key"), limit=128),
            settlement_reference_hmac=(
                _clean_text(row.get("settlement_reference_hmac"), limit=128) or None
            ),
            revision=max(1, int(row.get("revision") or 1)),
            expires_at=self._parse_expiry(row.get("expires_at")),
            slots=slots,
        )

    def _validate_identity(
        self, *, user_id: str, capability_id: str, graph_revision: str, step_cursor: str
    ) -> tuple[str, str, str, str]:
        user = _clean_text(user_id, limit=256)
        capability = _clean_text(capability_id, limit=192)
        revision = _clean_text(graph_revision, limit=128)
        cursor = _clean_text(step_cursor, limit=192) or "start"
        if not user or not _CAPABILITY_ID_RE.fullmatch(capability) or not revision:
            raise ValueError("Capability run identity is invalid.")
        if not _STEP_CURSOR_RE.fullmatch(cursor):
            raise ValueError("Capability run step cursor is invalid.")
        return user, capability, revision, cursor

    async def create(
        self,
        *,
        user_id: str,
        capability_id: str,
        capability_version: int,
        graph_revision: str,
        slots: Mapping[str, Any] | None = None,
        context_revision: str = "",
        expected_context_revision: str = "",
        step_cursor: str = "start",
        status: CapabilityRunStatus = "proposed",
        pending_interaction: str | None = None,
        pending_directive_id: str | None = None,
        idempotency_scope: str = "",
        ttl_seconds: int = 24 * 60 * 60,
    ) -> CapabilityRunV1:
        user, capability, graph, cursor = self._validate_identity(
            user_id=user_id,
            capability_id=capability_id,
            graph_revision=graph_revision,
            step_cursor=step_cursor,
        )
        if status not in _CREATABLE_STATUSES:
            raise ValueError("Capability run initial status is invalid.")
        clean_slots = _clean_slots(slots)
        encrypted_slots = self._encode_slots(clean_slots)
        slot_hmac = self._hmac(clean_slots)
        idempotency_key = self._hmac(
            {
                "user": user,
                "capability": capability,
                "graph": graph,
                "slots": slot_hmac,
                "scope": _clean_text(idempotency_scope, limit=128),
            }
        )
        expires_at = datetime.now(UTC) + timedelta(
            seconds=max(60, min(int(ttl_seconds), 7 * 24 * 60 * 60))
        )
        run_id = f"run_{uuid4().hex}"
        params: dict[str, Any] = {
            "run_id": run_id,
            "user_id": user,
            "capability_id": capability,
            "capability_version": max(1, int(capability_version)),
            "graph_revision": graph,
            "status": status,
            "step_cursor": cursor,
            "context_revision": _clean_text(context_revision, limit=192),
            "expected_context_revision": _clean_text(expected_context_revision, limit=192),
            "pending_interaction": _clean_text(pending_interaction, limit=96) or None,
            "pending_directive_id": _clean_text(pending_directive_id, limit=128) or None,
            "idempotency_key": idempotency_key,
            "slots_hmac": slot_hmac,
            "expires_at": expires_at,
            **encrypted_slots,
        }
        result = await self._execute(
            """
            INSERT INTO one_capability_runs (
              run_id, user_id, capability_id, capability_version, graph_revision,
              status, step_cursor, context_revision, expected_context_revision,
              pending_interaction, pending_directive_id, idempotency_key, slots_hmac,
              slots_ciphertext, slots_iv, slots_tag, slots_algorithm, expires_at
            ) VALUES (
              :run_id, :user_id, :capability_id, :capability_version, :graph_revision,
              :status, :step_cursor, :context_revision, :expected_context_revision,
              :pending_interaction, :pending_directive_id, :idempotency_key, :slots_hmac,
              :slots_ciphertext, :slots_iv, :slots_tag, :slots_algorithm, :expires_at
            ) ON CONFLICT (user_id, idempotency_key) DO NOTHING
            RETURNING run_id, revision
            """,
            params,
        )
        if result.data:
            return self._row_to_run(
                {**params, "revision": result.data[0].get("revision", 1)},
                include_slots=True,
            )
        # `create` is an authority-bearing API: callers must receive the same
        # bounded encrypted slots whether this request inserted the row or lost
        # an idempotency race.  Returning the default redacted projection here
        # can make a retry advance the shared run without the proof locators
        # that were persisted by the winning request.
        existing = await self.get_by_idempotency(
            user_id=user,
            idempotency_key=idempotency_key,
            include_slots=True,
        )
        if existing is None:
            raise CapabilityRunAuthorityError("Capability run reservation failed.")
        return existing

    async def get(
        self, *, user_id: str, run_id: str, include_slots: bool = False
    ) -> CapabilityRunV1 | None:
        result = await self._execute(
            """
            SELECT run_id, user_id, capability_id, capability_version, graph_revision,
                   status, step_cursor, context_revision, expected_context_revision,
                   pending_interaction, pending_directive_id, idempotency_key,
                   slots_hmac, slots_ciphertext, slots_iv, slots_tag, slots_algorithm,
                   settlement_reference_hmac, revision, expires_at
            FROM one_capability_runs
            WHERE run_id = :run_id AND user_id = :user_id
            LIMIT 1
            """,
            {"run_id": _clean_text(run_id, limit=96), "user_id": _clean_text(user_id, limit=256)},
        )
        rows = result.data or []
        return self._row_to_run(dict(rows[0]), include_slots=include_slots) if rows else None

    async def get_by_idempotency(
        self,
        *,
        user_id: str,
        idempotency_key: str,
        include_slots: bool = False,
    ) -> CapabilityRunV1 | None:
        result = await self._execute(
            """
            SELECT run_id, user_id, capability_id, capability_version, graph_revision,
                   status, step_cursor, context_revision, expected_context_revision,
                   pending_interaction, pending_directive_id, idempotency_key,
                   slots_hmac, slots_ciphertext, slots_iv, slots_tag, slots_algorithm,
                   settlement_reference_hmac, revision, expires_at
            FROM one_capability_runs
            WHERE user_id = :user_id AND idempotency_key = :idempotency_key
            LIMIT 1
            """,
            {"user_id": _clean_text(user_id, limit=256), "idempotency_key": idempotency_key},
        )
        rows = result.data or []
        return self._row_to_run(dict(rows[0]), include_slots=include_slots) if rows else None

    async def find_active_matching_slots(
        self,
        *,
        user_id: str,
        capability_id: str,
        graph_revision: str,
        slots: Mapping[str, Any] | None,
        include_slots: bool = False,
    ) -> CapabilityRunV1 | None:
        """Find one unexpired execution run for the exact owner and inputs.

        Two matches are deliberately an authority conflict. Recovery must use
        an explicit run id in that case rather than selecting whichever row was
        updated most recently and potentially replaying the wrong task.
        """

        user, capability, graph, _cursor = self._validate_identity(
            user_id=user_id,
            capability_id=capability_id,
            graph_revision=graph_revision,
            step_cursor="start",
        )
        slots_hmac = self._hmac(_clean_slots(slots))
        result = await self._execute(
            """
            SELECT run_id, user_id, capability_id, capability_version, graph_revision,
                   status, step_cursor, context_revision, expected_context_revision,
                   pending_interaction, pending_directive_id, idempotency_key,
                   slots_hmac, slots_ciphertext, slots_iv, slots_tag, slots_algorithm,
                   settlement_reference_hmac, revision, expires_at
            FROM one_capability_runs
            WHERE user_id = :user_id
              AND capability_id = :capability_id
              AND graph_revision = :graph_revision
              AND slots_hmac = :slots_hmac
              AND status IN ('authorized', 'executing', 'settlement_received')
              AND expires_at > NOW()
            ORDER BY updated_at DESC, run_id
            LIMIT 2
            """,
            {
                "user_id": user,
                "capability_id": capability,
                "graph_revision": graph,
                "slots_hmac": slots_hmac,
            },
        )
        rows = result.data or []
        if len(rows) > 1:
            raise CapabilityRunConflictError(
                "Multiple active capability runs match; resume by explicit run id."
            )
        return self._row_to_run(dict(rows[0]), include_slots=include_slots) if rows else None

    async def find_recent_verified_matching_slots(
        self,
        *,
        user_id: str,
        capability_id: str,
        graph_revision: str,
        slots: Mapping[str, Any] | None,
        replay_window_seconds: int,
        include_slots: bool = False,
    ) -> CapabilityRunV1 | None:
        """Find one recent verified terminal run for a bounded replay window.

        This is intentionally narrower than generic history. It can only
        recover a just-settled result for the exact owner, compiled execution
        contract, and encrypted-slot HMAC. A later intentional invocation is
        allowed once the caller's short replay window has elapsed.
        """

        user, capability, graph, _cursor = self._validate_identity(
            user_id=user_id,
            capability_id=capability_id,
            graph_revision=graph_revision,
            step_cursor="start",
        )
        try:
            window_seconds = int(replay_window_seconds)
        except (TypeError, ValueError) as exc:
            raise ValueError("Capability replay window is invalid.") from exc
        # Keep this a retry recovery boundary, never a permanent name/action
        # dedupe mechanism. The lower bound avoids a zero-second race and the
        # upper bound keeps a malformed caller from turning it into history.
        if not 1 <= window_seconds <= 10 * 60:
            raise ValueError("Capability replay window is invalid.")
        slots_hmac = self._hmac(_clean_slots(slots))
        result = await self._execute(
            """
            SELECT run_id, user_id, capability_id, capability_version, graph_revision,
                   status, step_cursor, context_revision, expected_context_revision,
                   pending_interaction, pending_directive_id, idempotency_key,
                   slots_hmac, slots_ciphertext, slots_iv, slots_tag, slots_algorithm,
                   settlement_reference_hmac, revision, expires_at
            FROM one_capability_runs
            WHERE user_id = :user_id
              AND capability_id = :capability_id
              AND graph_revision = :graph_revision
              AND slots_hmac = :slots_hmac
              AND status = 'verified_succeeded'
              AND expires_at > NOW()
              AND updated_at >= NOW() - (:replay_window_seconds * INTERVAL '1 second')
            ORDER BY updated_at DESC, run_id DESC
            LIMIT 2
            """,
            {
                "user_id": user,
                "capability_id": capability,
                "graph_revision": graph,
                "slots_hmac": slots_hmac,
                "replay_window_seconds": window_seconds,
            },
        )
        rows = result.data or []
        if len(rows) > 1:
            # Choosing one of two historical mutations would make the replay
            # target ambiguous. The caller must fail closed instead.
            raise CapabilityRunConflictError(
                "Multiple recent verified capability runs match the replay request."
            )
        return self._row_to_run(dict(rows[0]), include_slots=include_slots) if rows else None

    async def find_unique_resumable(
        self,
        *,
        user_id: str,
        capability_id: str,
        graph_revision: str,
        include_slots: bool = False,
    ) -> CapabilityRunV1 | None:
        """Find the owner's sole unexpired resumable interaction run.

        Slots are intentionally not part of this lookup: the purpose is to
        recover an ASK or route/native interaction before the next verified
        state is available. More than one candidate is therefore ambiguous
        and must be resolved by an explicit run id rather than by recency.
        """

        user, capability, graph, _cursor = self._validate_identity(
            user_id=user_id,
            capability_id=capability_id,
            graph_revision=graph_revision,
            step_cursor="start",
        )
        result = await self._execute(
            """
            SELECT run_id, user_id, capability_id, capability_version, graph_revision,
                   status, step_cursor, context_revision, expected_context_revision,
                   pending_interaction, pending_directive_id, idempotency_key,
                   slots_hmac, slots_ciphertext, slots_iv, slots_tag, slots_algorithm,
                   settlement_reference_hmac, revision, expires_at
            FROM one_capability_runs
            WHERE user_id = :user_id
              AND capability_id = :capability_id
              AND graph_revision = :graph_revision
              AND status IN (
                'needs_input', 'entity_choice', 'interaction_required',
                'confirmation_required', 'paused'
              )
              AND expires_at > NOW()
            ORDER BY updated_at DESC, run_id
            LIMIT 2
            """,
            {
                "user_id": user,
                "capability_id": capability,
                "graph_revision": graph,
            },
        )
        rows = result.data or []
        if len(rows) > 1:
            raise CapabilityRunConflictError(
                "Multiple resumable capability runs match; resume by explicit run id."
            )
        return self._row_to_run(dict(rows[0]), include_slots=include_slots) if rows else None

    async def find_unique_open_for_capability(
        self,
        *,
        user_id: str,
        capability_id: str,
        include_slots: bool = False,
    ) -> CapabilityRunV1 | None:
        """Find one owner's open run across graph/workflow revisions.

        Normal semantic recovery is graph-revision scoped. A versioned workflow
        migration is the deliberate exception: it must be able to discover the
        previous revision before it can pin the row to a declared migration.
        Returning more than one row is an authority conflict, never a recency
        decision.
        """

        user, capability, _graph, _cursor = self._validate_identity(
            user_id=user_id,
            capability_id=capability_id,
            graph_revision="migration-lookup",
            step_cursor="start",
        )
        result = await self._execute(
            """
            SELECT run_id, user_id, capability_id, capability_version, graph_revision,
                   status, step_cursor, context_revision, expected_context_revision,
                   pending_interaction, pending_directive_id, idempotency_key,
                   slots_hmac, slots_ciphertext, slots_iv, slots_tag, slots_algorithm,
                   settlement_reference_hmac, revision, expires_at
            FROM one_capability_runs
            WHERE user_id = :user_id
              AND capability_id = :capability_id
              AND status IN (
                'proposed', 'needs_input', 'entity_choice', 'interaction_required',
                'confirmation_required', 'authorized', 'executing',
                'settlement_received', 'paused'
              )
              AND expires_at > NOW()
            ORDER BY updated_at DESC, run_id
            LIMIT 2
            """,
            {"user_id": user, "capability_id": capability},
        )
        rows = result.data or []
        if len(rows) > 1:
            raise CapabilityRunConflictError(
                "Multiple open capability runs match; resume by explicit run id."
            )
        return self._row_to_run(dict(rows[0]), include_slots=include_slots) if rows else None

    async def find_latest_for_capability(
        self,
        *,
        user_id: str,
        capability_id: str,
        include_slots: bool = False,
    ) -> CapabilityRunV1 | None:
        """Read the owner's latest run, including terminal and elapsed rows.

        This lookup is intentionally separate from resumable discovery.  A
        versioned workflow may use the exact latest terminal revision to mint
        one deterministic restart idempotency scope, while normal recovery
        continues to reject ambiguous open runs.
        """

        user, capability, _graph, _cursor = self._validate_identity(
            user_id=user_id,
            capability_id=capability_id,
            graph_revision="latest-lookup",
            step_cursor="start",
        )
        result = await self._execute(
            """
            SELECT run_id, user_id, capability_id, capability_version, graph_revision,
                   status, step_cursor, context_revision, expected_context_revision,
                   pending_interaction, pending_directive_id, idempotency_key,
                   slots_hmac, slots_ciphertext, slots_iv, slots_tag, slots_algorithm,
                   settlement_reference_hmac, revision, expires_at
            FROM one_capability_runs
            WHERE user_id = :user_id
              AND capability_id = :capability_id
            ORDER BY created_at DESC, run_id DESC
            LIMIT 1
            """,
            {"user_id": user, "capability_id": capability},
        )
        rows = result.data or []
        return self._row_to_run(dict(rows[0]), include_slots=include_slots) if rows else None

    async def migrate_workflow_version(
        self,
        *,
        user_id: str,
        run_id: str,
        capability_id: str,
        expected_revision: int,
        expected_capability_version: int,
        target_capability_version: int,
        target_graph_revision: str,
        step_cursor: str,
        status: CapabilityRunStatus,
        pending_interaction: str | None,
        slots: Mapping[str, Any] | None = None,
    ) -> CapabilityRunV1:
        """Apply one explicit, CAS-protected workflow migration.

        This is not a generic graph upgrade. The caller owns the migration map
        and supplies both versions. Clearing/replacing slots is intentional:
        an old workflow's opaque values do not acquire provenance merely
        because a newer runtime can parse their shape.
        """

        if expected_capability_version < 1 or target_capability_version < 1:
            raise ValueError("Capability workflow versions must be positive.")
        if target_capability_version <= expected_capability_version:
            raise ValueError("Capability workflow migrations must advance the version.")
        if status not in _CREATABLE_STATUSES:
            raise ValueError("Migrated capability run status is invalid.")
        user, capability, graph, cursor = self._validate_identity(
            user_id=user_id,
            capability_id=capability_id,
            graph_revision=target_graph_revision,
            step_cursor=step_cursor,
        )
        clean_slots = _clean_slots(slots)
        slot_fields = {
            "slots_hmac": self._hmac(clean_slots),
            **self._encode_slots(clean_slots),
        }
        params = {
            "run_id": _clean_text(run_id, limit=96),
            "user_id": user,
            "capability_id": capability,
            "expected_revision": max(1, int(expected_revision)),
            "expected_capability_version": int(expected_capability_version),
            "target_capability_version": int(target_capability_version),
            "target_graph_revision": graph,
            "status": status,
            "step_cursor": cursor,
            "pending_interaction": _clean_text(pending_interaction, limit=96) or None,
            **slot_fields,
        }
        result = await self._execute(
            """
            UPDATE one_capability_runs
            SET capability_version = :target_capability_version,
                graph_revision = :target_graph_revision,
                status = :status,
                step_cursor = :step_cursor,
                pending_interaction = :pending_interaction,
                pending_directive_id = NULL,
                slots_hmac = :slots_hmac,
                slots_ciphertext = :slots_ciphertext,
                slots_iv = :slots_iv,
                slots_tag = :slots_tag,
                slots_algorithm = :slots_algorithm,
                settlement_reference_hmac = NULL,
                revision = revision + 1,
                updated_at = NOW()
            WHERE run_id = :run_id
              AND user_id = :user_id
              AND capability_id = :capability_id
              AND capability_version = :expected_capability_version
              AND revision = :expected_revision
              AND status NOT IN (
                'verified_succeeded', 'verified_failed', 'cancelled', 'expired'
              )
              AND expires_at > NOW()
            RETURNING revision
            """,
            params,
        )
        if not result.data:
            raise CapabilityRunConflictError(
                "Capability workflow changed; reload it before migrating."
            )
        migrated = await self.get(user_id=user, run_id=params["run_id"], include_slots=True)
        if migrated is None:
            raise CapabilityRunAuthorityError("Migrated capability run could not be re-read.")
        return migrated

    async def list_resume_summaries(
        self,
        *,
        user_id: str,
        graph_revision: str,
        limit: int = MAX_CAPABILITY_RUN_RESUME_SUMMARIES,
    ) -> tuple[CapabilityRunResumeSummaryV1, ...]:
        """Return a small, non-authorizing recovery projection for one owner.

        This deliberately queries only the four fields that may reach a Live
        context.  It never fetches encrypted slots (or their envelope),
        interaction/directive ids, context revisions, settlement material, or
        timestamps.  Restricting to the current graph revision prevents a
        release with changed schemas/policy from silently advertising an old
        task as executable; such a task needs an explicit migration instead.
        """

        clean_user_id = _clean_text(user_id, limit=256)
        clean_graph_revision = _clean_text(graph_revision, limit=128)
        if not clean_user_id or not clean_graph_revision:
            return ()
        try:
            bounded_limit = min(
                max(int(limit), 1),
                MAX_CAPABILITY_RUN_RESUME_SUMMARIES,
            )
        except (TypeError, ValueError):
            bounded_limit = MAX_CAPABILITY_RUN_RESUME_SUMMARIES
        result = await self._execute(
            """
            SELECT run_id, capability_id, status, step_cursor
            FROM one_capability_runs
            WHERE user_id = :user_id
              AND graph_revision = :graph_revision
              AND status IN (
                'needs_input', 'entity_choice', 'interaction_required',
                'confirmation_required', 'authorized', 'executing',
                'settlement_received', 'paused'
              )
              AND expires_at > NOW()
            ORDER BY updated_at DESC, run_id
            LIMIT :limit
            """,
            {
                "user_id": clean_user_id,
                "graph_revision": clean_graph_revision,
                "limit": bounded_limit,
            },
        )
        summaries: list[CapabilityRunResumeSummaryV1] = []
        for raw in (result.data or [])[:bounded_limit]:
            row = dict(raw)
            status = _clean_text(row.get("status"), limit=48)
            run_id = _clean_text(row.get("run_id"), limit=96)
            capability_id = _clean_text(row.get("capability_id"), limit=192)
            step = _clean_text(row.get("step_cursor"), limit=192) or "start"
            if (
                status not in RESUMABLE_CAPABILITY_RUN_STATUSES
                or not run_id
                or not _CAPABILITY_ID_RE.fullmatch(capability_id)
                or not _STEP_CURSOR_RE.fullmatch(step)
            ):
                # A malformed row is not something a recovery UI/model can
                # repair.  Fail the entire read closed so it cannot surface a
                # partial or attacker-shaped task.
                raise CapabilityRunAuthorityError("Capability run resume summary is invalid.")
            summaries.append(
                CapabilityRunResumeSummaryV1(
                    run_id=run_id,
                    capability_id=capability_id,
                    status=status,  # type: ignore[arg-type]
                    step=step,
                )
            )
        return tuple(summaries)

    async def transition(
        self,
        *,
        user_id: str,
        run_id: str,
        expected_revision: int,
        to_status: CapabilityRunStatus,
        step_cursor: str | None = None,
        context_revision: str | None = None,
        expected_context_revision: str | None = None,
        pending_interaction: str | None | object = _UNSET,
        pending_directive_id: str | None | object = _UNSET,
        settlement_reference: str | None | object = _UNSET,
        slots: Mapping[str, Any] | object = _UNSET,
    ) -> CapabilityRunV1:
        if to_status not in _STATUS_VALUES:
            raise ValueError("Capability run status is invalid.")
        current = await self.get(user_id=user_id, run_id=run_id, include_slots=False)
        if current is None:
            raise CapabilityRunAuthorityError("Capability run was not found.")
        if current.revision != expected_revision:
            raise CapabilityRunConflictError("Capability run changed; reload it before continuing.")
        if to_status not in _ALLOWED_TRANSITIONS.get(current.status, frozenset()):
            raise CapabilityRunConflictError("Capability run cannot make that state transition.")
        if (
            current.expires_at is not None
            and current.expires_at <= datetime.now(UTC)
            and to_status != "expired"
        ):
            raise CapabilityRunConflictError("Capability run has expired.")
        if settlement_reference is not _UNSET and to_status != "settlement_received":
            raise ValueError("Settlement proof can only be recorded when settlement is received.")
        if to_status == "settlement_received" and (
            settlement_reference is _UNSET or not _clean_text(settlement_reference, limit=256)
        ):
            raise ValueError("Settlement receipt requires a non-empty reference.")
        if to_status == "verified_succeeded" and not current.settlement_reference_hmac:
            raise CapabilityRunConflictError(
                "Capability run cannot be verified without a prior settlement proof."
            )
        next_cursor = (
            current.step_cursor if step_cursor is None else _clean_text(step_cursor, limit=192)
        )
        if not _STEP_CURSOR_RE.fullmatch(next_cursor):
            raise ValueError("Capability run step cursor is invalid.")
        replace_slots = slots is not _UNSET
        slot_fields: dict[str, Any] = {}
        if replace_slots:
            clean_slots = _clean_slots(slots if isinstance(slots, Mapping) else {})
            slot_fields = {"slots_hmac": self._hmac(clean_slots), **self._encode_slots(clean_slots)}
        params: dict[str, Any] = {
            "run_id": current.run_id,
            "user_id": current.user_id,
            "expected_revision": current.revision,
            "from_status": current.status,
            "to_status": to_status,
            "step_cursor": next_cursor,
            "context_revision": current.context_revision
            if context_revision is None
            else _clean_text(context_revision, limit=192),
            "expected_context_revision": current.expected_context_revision
            if expected_context_revision is None
            else _clean_text(expected_context_revision, limit=192),
            "pending_interaction": current.pending_interaction
            if pending_interaction is _UNSET
            else (_clean_text(pending_interaction, limit=96) or None),
            "pending_directive_id": current.pending_directive_id
            if pending_directive_id is _UNSET
            else (_clean_text(pending_directive_id, limit=128) or None),
            "settlement_reference_hmac": current.settlement_reference_hmac
            if settlement_reference is _UNSET
            else (
                self._hmac(_clean_text(settlement_reference, limit=256))
                if settlement_reference
                else None
            ),
            "replace_slots": replace_slots,
            **slot_fields,
        }
        result = await self._execute(
            """
            UPDATE one_capability_runs
            SET status = :to_status,
                step_cursor = :step_cursor,
                context_revision = :context_revision,
                expected_context_revision = :expected_context_revision,
                pending_interaction = :pending_interaction,
                pending_directive_id = :pending_directive_id,
                settlement_reference_hmac = :settlement_reference_hmac,
                slots_hmac = CASE WHEN :replace_slots THEN :slots_hmac ELSE slots_hmac END,
                slots_ciphertext = CASE
                  WHEN :replace_slots THEN :slots_ciphertext ELSE slots_ciphertext
                END,
                slots_iv = CASE WHEN :replace_slots THEN :slots_iv ELSE slots_iv END,
                slots_tag = CASE WHEN :replace_slots THEN :slots_tag ELSE slots_tag END,
                slots_algorithm = CASE
                  WHEN :replace_slots THEN :slots_algorithm ELSE slots_algorithm
                END,
                revision = revision + 1,
                updated_at = NOW()
            WHERE run_id = :run_id AND user_id = :user_id
              AND revision = :expected_revision AND status = :from_status
              AND expires_at > NOW()
            RETURNING revision
            """,
            {
                **params,
                "slots_hmac": slot_fields.get("slots_hmac"),
                "slots_ciphertext": slot_fields.get("slots_ciphertext"),
                "slots_iv": slot_fields.get("slots_iv"),
                "slots_tag": slot_fields.get("slots_tag"),
                "slots_algorithm": slot_fields.get("slots_algorithm"),
            },
        )
        if not result.data:
            raise CapabilityRunConflictError("Capability run changed; reload it before continuing.")
        return CapabilityRunV1(
            **{
                **current.__dict__,
                "status": to_status,
                "step_cursor": next_cursor,
                "context_revision": params["context_revision"],
                "expected_context_revision": params["expected_context_revision"],
                "pending_interaction": params["pending_interaction"],
                "pending_directive_id": params["pending_directive_id"],
                "settlement_reference_hmac": params["settlement_reference_hmac"],
                "revision": int(result.data[0].get("revision") or current.revision + 1),
            }
        )

    async def replace_pending_directive(
        self,
        *,
        user_id: str,
        run_id: str,
        expected_revision: int,
        pending_interaction: str,
        pending_directive_id: str,
    ) -> CapabilityRunV1:
        """Atomically issue/reissue a typed input directive for a waiting run.

        This intentionally has a much narrower surface than ``transition``:
        only a ``needs_input`` run may receive a new directive, its status and
        encrypted slots cannot change, and the optimistic revision must match.
        It is the durable primitive for server-issued forms whose one-time
        lease is verified by a higher-level interaction service.
        """

        current = await self.get(user_id=user_id, run_id=run_id, include_slots=False)
        if current is None:
            raise CapabilityRunAuthorityError("Capability run was not found.")
        if current.revision != expected_revision:
            raise CapabilityRunConflictError("Capability run changed; reload it before continuing.")
        if current.status != "needs_input":
            raise CapabilityRunConflictError("Capability run is no longer waiting for input.")
        interaction = _clean_text(pending_interaction, limit=96)
        directive = _clean_text(pending_directive_id, limit=128)
        if not interaction or not directive:
            raise ValueError("Capability run directive is invalid.")
        result = await self._execute(
            """
            UPDATE one_capability_runs
            SET pending_interaction = :pending_interaction,
                pending_directive_id = :pending_directive_id,
                revision = revision + 1,
                updated_at = NOW()
            WHERE run_id = :run_id AND user_id = :user_id
              AND revision = :expected_revision AND status = 'needs_input'
              AND expires_at > NOW()
            RETURNING revision
            """,
            {
                "run_id": current.run_id,
                "user_id": current.user_id,
                "expected_revision": current.revision,
                "pending_interaction": interaction,
                "pending_directive_id": directive,
            },
        )
        if not result.data:
            raise CapabilityRunConflictError("Capability run changed; reload it before continuing.")
        return CapabilityRunV1(
            **{
                **current.__dict__,
                "pending_interaction": interaction,
                "pending_directive_id": directive,
                "revision": int(result.data[0].get("revision") or current.revision + 1),
            }
        )

    async def expire(self, *, user_id: str, run_id: str, expected_revision: int) -> CapabilityRunV1:
        current = await self.get(user_id=user_id, run_id=run_id)
        if current is None:
            raise CapabilityRunAuthorityError("Capability run was not found.")
        if current.status == "expired":
            return current
        if current.revision != expected_revision:
            raise CapabilityRunConflictError("Capability run changed; reload it before continuing.")
        result = await self._execute(
            """
            UPDATE one_capability_runs
            SET status = 'expired', pending_interaction = NULL,
                pending_directive_id = NULL, revision = revision + 1, updated_at = NOW()
            WHERE run_id = :run_id AND user_id = :user_id
              AND revision = :expected_revision
              AND status NOT IN ('verified_succeeded', 'verified_failed', 'cancelled', 'expired')
            RETURNING revision
            """,
            {
                "run_id": current.run_id,
                "user_id": current.user_id,
                "expected_revision": current.revision,
            },
        )
        if not result.data:
            raise CapabilityRunConflictError("Capability run changed; reload it before continuing.")
        return CapabilityRunV1(
            **{
                **current.__dict__,
                "status": "expired",
                "pending_interaction": None,
                "pending_directive_id": None,
                "revision": int(result.data[0].get("revision") or current.revision + 1),
            }
        )

    async def purge_expired(
        self,
        *,
        limit: int = MAX_CAPABILITY_RUN_RETENTION_PURGE,
    ) -> int:
        """Physically remove one bounded batch of expired durable runs.

        Location workflow records reference the parent run with database-owned
        ``ON DELETE CASCADE`` foreign keys.  This method intentionally deletes
        only parent rows: duplicating Location child cleanup here could race
        the database's referential action and make retention semantics depend
        on application ordering.
        """

        if isinstance(limit, bool):
            raise ValueError("Capability run retention purge limit is invalid.")
        try:
            bounded_limit = int(limit)
        except (TypeError, ValueError) as exc:
            raise ValueError("Capability run retention purge limit is invalid.") from exc
        if not 1 <= bounded_limit <= MAX_CAPABILITY_RUN_RETENTION_PURGE:
            raise ValueError("Capability run retention purge limit is invalid.")

        result = await self._execute(
            """
            WITH expired_runs AS (
              SELECT run_id
              FROM one_capability_runs
              WHERE expires_at <= NOW()
              ORDER BY expires_at ASC, run_id ASC
              LIMIT :limit
              FOR UPDATE SKIP LOCKED
            )
            DELETE FROM one_capability_runs AS run
            USING expired_runs
            WHERE run.run_id = expired_runs.run_id
            RETURNING run.run_id
            """,
            {"limit": bounded_limit},
        )
        return len(result.data or [])


_store: CapabilityRunStore | None = None


def get_capability_run_store() -> CapabilityRunStore:
    global _store
    if _store is None:
        _store = CapabilityRunStore()
    return _store


__all__ = [
    "CapabilityRunAuthorityError",
    "CapabilityRunConflictError",
    "CapabilityRunResumeSummaryV1",
    "CapabilityRunStore",
    "CapabilityRunV1",
    "CapabilityRunStatus",
    "MAX_CAPABILITY_RUN_RETENTION_PURGE",
    "MAX_CAPABILITY_RUN_RESUME_SUMMARIES",
    "RESUMABLE_CAPABILITY_RUN_STATUSES",
    "get_capability_run_store",
]

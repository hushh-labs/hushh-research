"""Durable Location onboarding workflow for Agent One.

``workflow.setup.location`` is deliberately server-owned and versioned.  The
browser/iPhone may report bounded interaction outcomes, but it cannot choose a
step, mint a receipt, supply an owner, or claim completion.  Exact coordinates,
place text, Circle identifiers/codes, PKM ciphertext, and provider payloads are
never written to this workflow's tables or returned by its API projection.

Postgres is the current shared coordination plane.  The small run/lease/receipt
ports below are intentionally replaceable so a future Redis lease plane can
preserve the same compare-and-set contract.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Iterable, Literal, Mapping, Protocol
from uuid import UUID, uuid4, uuid5

from db.db_client import get_db
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.capability_run_service import (
    CapabilityRunStore,
    CapabilityRunV1,
    get_capability_run_store,
)
from hushh_mcp.services.pkm_mutation_contracts import (
    derive_pkm_mutation_commit_id,
)

logger = logging.getLogger(__name__)

LOCATION_ONBOARDING_WORKFLOW_ID = "workflow.setup.location"
LOCATION_ONBOARDING_WORKFLOW_VERSION = 2
LOCATION_ONBOARDING_SCHEMA_VERSION = "one.location_onboarding_runtime.v2"
LOCATION_ONBOARDING_RECEIPT_SCHEMA_VERSION = "one.location_onboarding_completion_receipt.v1"

LOCATION_PREFLIGHT_STEP = "location.onboarding.preflight"
LOCATION_INTRODUCTION_STEP = "location.onboarding.introduction"
LOCATION_PERMISSION_STEP = "location.onboarding.permission"
LOCATION_POSITION_STEP = "location.onboarding.position"
LOCATION_PLACE_STEP = "location.onboarding.place"
LOCATION_CIRCLE_STEP = "location.onboarding.circle"
LOCATION_COMPLETE_STEP = "location.onboarding.complete"

LocationCursor = Literal[
    "location.onboarding.preflight",
    "location.onboarding.introduction",
    "location.onboarding.permission",
    "location.onboarding.position",
    "location.onboarding.place",
    "location.onboarding.circle",
    "location.onboarding.complete",
]
_CANONICAL_LOCATION_CURSORS = frozenset(
    {
        LOCATION_PREFLIGHT_STEP,
        LOCATION_INTRODUCTION_STEP,
        LOCATION_PERMISSION_STEP,
        LOCATION_POSITION_STEP,
        LOCATION_PLACE_STEP,
        LOCATION_CIRCLE_STEP,
        LOCATION_COMPLETE_STEP,
    }
)

# Checked-in v1 -> v2 cursor compatibility contract.  The capability compiler
# imports this mapping so durable-run migration and the KGS package cannot drift.
# ``location.verified`` deliberately restarts at preflight: a legacy terminal
# label is not a v2 settlement proof.
LOCATION_V1_CURSOR_MIGRATIONS: Mapping[str, LocationCursor] = {
    "location.navigate": LOCATION_PREFLIGHT_STEP,
    "location.interaction_required": LOCATION_PERMISSION_STEP,
    "location.verifying_persisted_state": LOCATION_COMPLETE_STEP,
    "location.settlement_received": LOCATION_COMPLETE_STEP,
    "location.verified": LOCATION_PREFLIGHT_STEP,
}
LOCATION_CURSOR_MIGRATIONS_BY_FROM_VERSION: Mapping[int, Mapping[str, LocationCursor]] = {
    1: LOCATION_V1_CURSOR_MIGRATIONS
}

LocationReceiptKind = Literal["permission", "place", "circle", "completion"]
LocationReceiptOutcome = Literal["observed", "saved", "skipped", "provisioned", "verified"]
LocationInteractionAction = Literal[
    "continue",
    "request_permission",
    "permission_granted",
    "permission_denied",
    "permission_restricted",
    "services_disabled",
    "open_settings",
    "settings_returned",
    "retry_permission",
    "position_captured",
    "position_unavailable",
    "retry_position",
    "save_place",
    "skip_place",
    "vault_unavailable",
    "draft_unavailable",
    "retry_circle",
    "retry_completion",
    "open_location",
    "resume",
    "pause",
]

_RUN_ID_RE = re.compile(r"^run_[a-z0-9]{16,96}$")
_LEASE_ID_RE = re.compile(r"^loclease_[a-z0-9]{16,96}$")
_DIRECTIVE_ID_RE = re.compile(r"^locdirective_[a-z0-9]{16,96}$")
_DRAFT_ID_RE = re.compile(r"^locdraft_[a-z0-9]{16,96}$")
_PKM_FINALIZE_AUTHORIZATION_ID_RE = re.compile(r"^locpkmauth_[a-z0-9]{16,96}$")
_PKM_FINALIZE_TOKEN_RE = re.compile(r"^locpkmtoken_[a-z0-9]{16,96}_[0-9a-f]{64}$")
_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
_DRAFT_DIGEST_RE = _DIGEST_RE
_CONTEXT_REVISION_RE = re.compile(r"^[A-Za-z0-9_.:-]{0,191}$")
_POSITION_OBSERVATION_SCHEMA = "one.location_position_observation.v1"
_POSITION_CAPTURE_MAX_AGE_SECONDS = 30
_POSITION_CAPTURE_MAX_FUTURE_SKEW_SECONDS = 5
_PKM_MUTATION_PLAN_IDEMPOTENCY_NAMESPACE = UUID("76f0e762-c176-5947-a680-7011af78b71f")
_TERMINAL_STATUSES = frozenset({"verified_succeeded", "verified_failed", "cancelled", "expired"})
_RESTARTABLE_TERMINAL_STATUSES = frozenset({"verified_failed", "cancelled", "expired"})
_PRECHECK_RESTARTABLE_STATUSES = frozenset(
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
_RECEIPT_PREFIX: Mapping[str, str] = {
    "permission": "locperm",
    "place": "locplace",
    "circle": "loccircle",
    "completion": "loccomplete",
}
_RECEIPT_SLOT: Mapping[str, str] = {
    "permission": "locationPermissionReceipt",
    "place": "locationPlaceReceipt",
    "circle": "locationCircleReceipt",
    "completion": "locationCompletionReceipt",
}


def derive_location_pre_vault_pkm_commit_id(*, user_id: str, run_id: str, draft_digest: str) -> str:
    """Bind a Location draft to the ordinary PKM mutation receipt it expects.

    The derivation mirrors the first-party client and contains only opaque run
    identity plus a digest of encrypted device bytes.  It intentionally omits
    coordinates, address, and label.
    """

    clean_run_id = str(run_id or "").strip()
    clean_digest = str(draft_digest or "").strip().lower()
    if not _RUN_ID_RE.fullmatch(clean_run_id) or not _DRAFT_DIGEST_RE.fullmatch(clean_digest):
        raise ValueError("location_pkm_commit_binding_invalid")
    scope = f"one.location.pre_vault_finalize.v1:{clean_run_id}:{clean_digest}"
    plan_uuid = uuid5(_PKM_MUTATION_PLAN_IDEMPOTENCY_NAMESPACE, scope)
    plan_id = f"pkm_plan_{str(plan_uuid).replace('-', '')}"
    return derive_pkm_mutation_commit_id(
        user_id=user_id,
        domain="location",
        plan_id=plan_id,
    )


class LocationOnboardingAuthorityError(RuntimeError):
    """The workflow cannot safely read or mutate the requested run."""


class LocationOnboardingConflictError(LocationOnboardingAuthorityError):
    """The caller supplied stale or already-consumed workflow authority."""


class LocationOnboardingMigrationRequiredError(LocationOnboardingConflictError):
    """A pinned run needs an explicitly implemented workflow migration."""


@dataclass(frozen=True)
class LocationStepContractV2:
    surface_id: str
    title_key: str
    body_key: str
    allowed_actions: tuple[LocationInteractionAction, ...]


_SURFACE_CONTRACTS: Mapping[str, LocationStepContractV2] = {
    "one.location.introduction.v2": LocationStepContractV2(
        "one.location.introduction.v2",
        "one.location.intro.title",
        "one.location.intro.body",
        ("continue", "pause"),
    ),
    "one.location.permission_offer.v2": LocationStepContractV2(
        "one.location.permission_offer.v2",
        "one.location.permission_offer.title",
        "one.location.permission_offer.body",
        ("request_permission", "pause"),
    ),
    "one.location.permission_result.v2": LocationStepContractV2(
        "one.location.permission_result.v2",
        "one.location.permission_result.title",
        "one.location.permission_result.body",
        (
            "permission_granted",
            "permission_denied",
            "permission_restricted",
            "services_disabled",
            "retry_permission",
            "pause",
        ),
    ),
    "one.location.settings_return.v2": LocationStepContractV2(
        "one.location.settings_return.v2",
        "one.location.settings_return.title",
        "one.location.settings_return.body",
        ("open_settings", "settings_returned", "retry_permission", "pause"),
    ),
    "one.location.position_pending.v2": LocationStepContractV2(
        "one.location.position_pending.v2",
        "one.location.position_pending.title",
        "one.location.position_pending.body",
        ("position_captured", "position_unavailable", "pause"),
    ),
    "one.location.position_retry.v2": LocationStepContractV2(
        "one.location.position_retry.v2",
        "one.location.position_retry.title",
        "one.location.position_retry.body",
        ("retry_position", "pause"),
    ),
    "one.location.place_choice.v2": LocationStepContractV2(
        "one.location.place_choice.v2",
        "one.location.place_choice.title",
        "one.location.place_choice.body",
        ("save_place", "skip_place", "pause"),
    ),
    "one.location.place_persisting.v2": LocationStepContractV2(
        "one.location.place_persisting.v2",
        "one.location.place_persisting.title",
        "one.location.place_persisting.body",
        ("vault_unavailable", "skip_place", "pause"),
    ),
    "one.location.awaiting_vault_finalize.v2": LocationStepContractV2(
        "one.location.awaiting_vault_finalize.v2",
        "one.location.awaiting_vault_finalize.title",
        "one.location.awaiting_vault_finalize.body",
        ("skip_place", "draft_unavailable", "pause"),
    ),
    "one.location.circle_retry.v2": LocationStepContractV2(
        "one.location.circle_retry.v2",
        "one.location.circle_retry.title",
        "one.location.circle_retry.body",
        ("retry_circle", "pause"),
    ),
    "one.location.completion_retry.v2": LocationStepContractV2(
        "one.location.completion_retry.v2",
        "one.location.completion_retry.title",
        "one.location.completion_retry.body",
        ("retry_completion", "pause"),
    ),
    "one.location.already_complete.v2": LocationStepContractV2(
        "one.location.already_complete.v2",
        "one.location.already_complete.title",
        "one.location.already_complete.body",
        ("open_location", "pause"),
    ),
    "one.location.paused.v2": LocationStepContractV2(
        "one.location.paused.v2",
        "one.location.paused.title",
        "one.location.paused.body",
        ("resume",),
    ),
}

# A run's durable cursor is always a declared KGS node.  UI/native substates
# live in ``pending_interaction`` and the one-time directive lease, so a retry
# cannot accidentally create a competing workflow graph.
_DEFAULT_SURFACE_BY_CURSOR: Mapping[str, str] = {
    LOCATION_INTRODUCTION_STEP: "one.location.introduction.v2",
    LOCATION_PERMISSION_STEP: "one.location.permission_offer.v2",
    LOCATION_POSITION_STEP: "one.location.position_pending.v2",
    LOCATION_PLACE_STEP: "one.location.place_choice.v2",
    LOCATION_CIRCLE_STEP: "one.location.circle_retry.v2",
    LOCATION_COMPLETE_STEP: "one.location.completion_retry.v2",
}

LOCATION_DIRECTIVE_KIND_BY_SURFACE: Mapping[str, str] = {
    "one.location.introduction.v2": "information",
    "one.location.permission_offer.v2": "technical_interaction",
    "one.location.permission_result.v2": "technical_interaction",
    "one.location.settings_return.v2": "recovery",
    "one.location.position_pending.v2": "progress",
    "one.location.position_retry.v2": "recovery",
    "one.location.place_choice.v2": "form",
    "one.location.place_persisting.v2": "form",
    "one.location.awaiting_vault_finalize.v2": "status",
    "one.location.circle_retry.v2": "status",
    "one.location.completion_retry.v2": "status",
    "one.location.already_complete.v2": "status",
    "one.location.paused.v2": "status",
}
LOCATION_APPROVED_SURFACE_CONTRACTS: Mapping[str, LocationStepContractV2] = _SURFACE_CONTRACTS


@dataclass(frozen=True)
class LocationInteractionLeaseV1:
    lease_id: str
    directive_id: str
    user_id: str
    run_id: str
    workflow_version: int
    step_cursor: str
    run_revision: int
    context_revision: str
    surface_id: str
    resume_surface_id: str | None
    allowed_actions_digest: str
    issued_at: datetime
    expires_at: datetime
    consumed_at: datetime | None = None
    outcome_code: str | None = None
    result_digest: str | None = None


@dataclass(frozen=True)
class LocationReceiptV1:
    receipt_id: str
    user_id: str
    run_id: str
    workflow_version: int
    step_cursor: str
    context_revision: str
    receipt_kind: LocationReceiptKind
    outcome_code: LocationReceiptOutcome
    issuer: str
    evidence_digest: str
    expires_at: datetime
    lease_id: str | None = None
    consumed_at: datetime | None = None


@dataclass(frozen=True)
class LocationSecureDraftMetadataV1:
    """Non-sensitive server ledger entry for an encrypted device draft."""

    draft_id: str
    user_id: str
    run_id: str
    workflow_version: int
    graph_revision: str
    run_revision: int
    digest: str
    status: Literal["staged"]
    expires_at: datetime
    created_at: datetime


@dataclass(frozen=True)
class LocationPkmFinalizeAuthorizationV1:
    """Opaque single-use authority for one atomic Location PKM finalization."""

    authorization_id: str
    token: str
    user_id: str
    run_id: str
    workflow_version: int
    run_revision: int
    context_revision: str
    lease_id: str
    directive_id: str
    draft_id: str
    draft_digest: str
    expected_commit_id: str
    issued_at: datetime
    expires_at: datetime
    consumed_at: datetime | None = None


@dataclass(frozen=True)
class LocationPreflightResult:
    status: Literal["already_complete", "needs_onboarding", "state_unavailable"]
    reason_code: str
    # Permission remains a current-device observation and is therefore never
    # inferred from server data.  The other two predicates can be proven from
    # owner-scoped persisted state and adopted into this run as opaque HMAC
    # receipts, avoiding duplicate place/Circle work after a restart.
    saved_place_evidence_digest: str | None = None
    circle_evidence_digest: str | None = None


@dataclass(frozen=True)
class LocationAdapterResult:
    status: Literal["verified", "waiting", "failed"]
    reason_code: str
    evidence_digest: str | None = None

    @classmethod
    def verified(cls, *, evidence_digest: str) -> LocationAdapterResult:
        if not _DIGEST_RE.fullmatch(evidence_digest):
            raise ValueError("Location adapter evidence digest is invalid.")
        return cls("verified", "verified", evidence_digest)

    @classmethod
    def waiting(cls, reason_code: str) -> LocationAdapterResult:
        return cls("waiting", _safe_reason(reason_code), None)

    @classmethod
    def failed(cls, reason_code: str) -> LocationAdapterResult:
        return cls("failed", _safe_reason(reason_code), None)


class LocationPlaceEvidencePort(Protocol):
    async def verify_saved_place(
        self,
        *,
        user_id: str,
        commit_reference: str,
        not_before: datetime,
    ) -> LocationAdapterResult: ...


class LocationPreflightPort(Protocol):
    async def resolve_state(self, *, user_id: str) -> LocationPreflightResult: ...


class LocationCircleProvisioningPort(Protocol):
    async def provision_personal_circle(
        self,
        *,
        user_id: str,
        run_id: str,
    ) -> LocationAdapterResult: ...


class LocationCompletionPort(Protocol):
    async def ensure_completion_marker(
        self,
        *,
        user_id: str,
        run_id: str,
    ) -> LocationAdapterResult: ...


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _safe_reason(value: Any) -> str:
    cleaned = str(value or "").strip().lower()[:64]
    return cleaned if re.fullmatch(r"[a-z][a-z0-9_]{0,63}", cleaned) else "unavailable"


def _load_compiled_location_transition_map() -> Mapping[str, Mapping[str, str]]:
    """Read Location v2 edges from the generated capability graph.

    This import is intentionally lazy.  The capability compiler imports this
    runtime to validate implementation references, so importing the compiler
    at module load time would create a cycle.  Once a request reaches the
    durable runtime, the graph must already be present and source-digest
    valid; otherwise the workflow fails closed before consuming a lease.
    """

    try:
        from hushh_mcp.services.app_intelligence_runtime import load_capability_graph

        graph = load_capability_graph()
    except Exception as exc:  # noqa: BLE001 - never advance from an unverified graph
        raise LocationOnboardingAuthorityError(
            "Location workflow transition authority is unavailable."
        ) from exc

    workflows = graph.get("workflows") if isinstance(graph, Mapping) else None
    matches = [
        item
        for item in (workflows or [])
        if isinstance(item, Mapping)
        and str(item.get("capability_id") or "") == LOCATION_ONBOARDING_WORKFLOW_ID
    ]
    if len(matches) != 1:
        raise LocationOnboardingAuthorityError("Location workflow transition authority is invalid.")
    workflow = matches[0]
    try:
        workflow_version = int(workflow.get("version") or 0)
    except (TypeError, ValueError) as exc:
        raise LocationOnboardingAuthorityError(
            "Location workflow transition authority is invalid."
        ) from exc
    if workflow_version != LOCATION_ONBOARDING_WORKFLOW_VERSION:
        raise LocationOnboardingAuthorityError(
            "Location workflow transition authority is incompatible."
        )
    knowledge_package = workflow.get("knowledge_package")
    try:
        package_version = int(
            knowledge_package.get("package_version")
            if isinstance(knowledge_package, Mapping)
            else 0
        )
    except (TypeError, ValueError) as exc:
        raise LocationOnboardingAuthorityError(
            "Location workflow transition authority is incompatible."
        ) from exc
    if not (
        isinstance(knowledge_package, Mapping)
        and str(knowledge_package.get("package_id") or "") == "location.brain"
        and package_version == 2
    ):
        raise LocationOnboardingAuthorityError(
            "Location workflow transition authority is incompatible."
        )

    raw_steps = workflow.get("steps")
    if not isinstance(raw_steps, list):
        raise LocationOnboardingAuthorityError("Location workflow transition authority is invalid.")
    transitions_by_cursor: dict[str, dict[str, str]] = {}
    valid_targets = _CANONICAL_LOCATION_CURSORS | {"$paused", "$verified_succeeded"}
    for raw_step in raw_steps:
        if not isinstance(raw_step, Mapping):
            raise LocationOnboardingAuthorityError(
                "Location workflow transition authority is invalid."
            )
        cursor = str(raw_step.get("step_id") or "")
        if cursor not in _CANONICAL_LOCATION_CURSORS or cursor in transitions_by_cursor:
            raise LocationOnboardingAuthorityError(
                "Location workflow transition authority is invalid."
            )
        raw_transitions = raw_step.get("transitions")
        if not isinstance(raw_transitions, list) or not raw_transitions:
            raise LocationOnboardingAuthorityError(
                "Location workflow transition authority is invalid."
            )
        edges: dict[str, str] = {}
        for raw_transition in raw_transitions:
            if not isinstance(raw_transition, Mapping):
                raise LocationOnboardingAuthorityError(
                    "Location workflow transition authority is invalid."
                )
            outcome = str(raw_transition.get("when") or "")
            target = str(raw_transition.get("target") or "")
            if not outcome or outcome in edges or target not in valid_targets:
                raise LocationOnboardingAuthorityError(
                    "Location workflow transition authority is invalid."
                )
            edges[outcome] = target
        transitions_by_cursor[cursor] = edges

    if set(transitions_by_cursor) != _CANONICAL_LOCATION_CURSORS:
        raise LocationOnboardingAuthorityError(
            "Location workflow transition authority is incomplete."
        )
    return transitions_by_cursor


def resolve_location_transition_target(cursor: str, outcome: str) -> str:
    """Resolve one Location workflow edge from the compiled package graph.

    The caller cannot supply a graph or a target.  This keeps the runtime
    bound to the same checked-in graph revision that governs capability
    authorization, rather than a client hint or a duplicate Python state map.
    """

    clean_cursor = str(cursor or "")
    clean_outcome = str(outcome or "")
    target = _load_compiled_location_transition_map().get(clean_cursor, {}).get(clean_outcome)
    if target is None:
        raise LocationOnboardingConflictError("Location workflow transition is not registered.")
    return target


def _parse_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return None


def _evidence_digest(kind: str, value: Mapping[str, Any], *, hmac_key: str | None = None) -> str:
    key = (hmac_key or get_core_security_settings().app_signing_key).encode("utf-8")
    return hmac.new(
        key,
        _canonical_json({"kind": kind, "value": dict(value)}).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


class VaultLocationOnboardingPreflightAdapter:
    """Resolve bounded owner state without exposing Location values.

    Encrypted-PKM presence and personal-Circle/invite state are server facts.
    The legacy setup marker is read only as an unverified migration hint; an
    already-complete result requires a separate, fully verified v2 run and
    receipt chain. Current OS permission is deliberately absent: only the
    foreground device can observe it, and a new workflow still requires a
    fresh permission-plus-position result before completion.
    """

    def __init__(self, *, db: Any | None = None, hmac_key: str | None = None) -> None:
        self._db = db
        self._hmac_key = hmac_key

    @property
    def db(self) -> Any:
        if self._db is None:
            self._db = get_db()
        return self._db

    def _resolve_persisted_domain_state(self, user_id: str) -> Mapping[str, Any]:
        result = self.db.execute_raw(
            """
            WITH saved_place AS (
              SELECT manifest.manifest_version,
                     MAX(blob.content_revision) AS content_revision,
                     idx.updated_at AS index_updated_at
              FROM pkm_index idx
              JOIN pkm_manifests manifest
                ON manifest.user_id = idx.user_id
               AND manifest.domain = 'location'
              JOIN pkm_blobs blob
                ON blob.user_id = manifest.user_id
               AND blob.domain = manifest.domain
               AND blob.segment_id = ANY(manifest.segment_ids)
               AND blob.manifest_revision = manifest.manifest_version
              WHERE idx.user_id = :user_id
                AND COALESCE(
                  (idx.domain_summaries -> 'location' ->> 'saved_places_configured')::BOOLEAN,
                  FALSE
                ) = TRUE
                AND COALESCE(
                  (idx.domain_summaries -> 'location' ->> 'saved_places_count')::INTEGER,
                  0
                ) > 0
              GROUP BY manifest.manifest_version, idx.updated_at
              LIMIT 1
            ), personal_circle AS (
              SELECT circle.id::TEXT AS circle_id,
                     invite.id::TEXT AS invite_id,
                     invite.expires_at AS invite_expires_at
              FROM one_location_circles circle
              JOIN one_location_circle_memberships membership
                ON membership.circle_id = circle.id
               AND membership.user_id = :user_id
               AND membership.role = 'owner'
               AND membership.status = 'active'
              JOIN one_location_circle_invite_codes invite
                ON invite.circle_id = circle.id
               AND invite.status = 'active'
               AND invite.expires_at > NOW()
               AND invite.use_count < invite.max_uses
              WHERE circle.owner_user_id = :user_id
                AND circle.status = 'active'
                AND circle.is_system = FALSE
                AND circle.system_kind IS NULL
              ORDER BY circle.created_at, invite.created_at
              LIMIT 1
            )
            SELECT saved_place.manifest_version,
                   saved_place.content_revision,
                   saved_place.index_updated_at,
                   personal_circle.circle_id,
                   personal_circle.invite_id,
                   personal_circle.invite_expires_at
            FROM (SELECT 1) anchor
            LEFT JOIN saved_place ON TRUE
            LEFT JOIN personal_circle ON TRUE
            """,
            {"user_id": user_id},
        )
        rows = result.data or []
        return dict(rows[0]) if rows else {}

    async def resolve_state(self, *, user_id: str) -> LocationPreflightResult:
        try:
            from hushh_mcp.services.vault_keys_service import VaultKeysService

            state = await VaultKeysService().get_pre_vault_state(user_id)
        except Exception:  # noqa: BLE001 - preflight cannot continue on an unverified snapshot
            logger.info("location_onboarding_preflight_unavailable")
            return LocationPreflightResult("state_unavailable", "preflight_unavailable")
        # The coarse setup marker predates CapabilityRunV1 and has no
        # permission, place, Circle, or completion-settlement provenance.  It
        # is therefore only a migration hint.  A verified v2 run is checked by
        # LocationOnboardingRuntimeService below before this adapter is used;
        # the marker alone must never produce an already-complete claim.
        legacy_setup_marker = "location" in {
            str(value).strip() for value in state.get("setupCapabilityIds") or []
        }
        if legacy_setup_marker:
            logger.info("location_onboarding_legacy_marker_unverified")
        try:
            persisted = await asyncio.to_thread(self._resolve_persisted_domain_state, user_id)
        except Exception:  # noqa: BLE001 - partial server state must fail closed
            logger.info("location_onboarding_domain_preflight_unavailable")
            return LocationPreflightResult("state_unavailable", "preflight_unavailable")
        place_digest = None
        if persisted.get("manifest_version") is not None:
            place_digest = _evidence_digest(
                "location_preflight_saved_place",
                {
                    "manifest_version": int(persisted.get("manifest_version") or 0),
                    "content_revision": int(persisted.get("content_revision") or 0),
                    "index_updated_at": str(persisted.get("index_updated_at") or ""),
                },
                hmac_key=self._hmac_key,
            )
        circle_digest = None
        if persisted.get("circle_id") and persisted.get("invite_id"):
            circle_digest = _evidence_digest(
                "location_preflight_personal_circle",
                {
                    "circle_id": str(persisted.get("circle_id")),
                    "invite_id": str(persisted.get("invite_id")),
                    "invite_expires_at": str(persisted.get("invite_expires_at") or ""),
                },
                hmac_key=self._hmac_key,
            )
        return LocationPreflightResult(
            "needs_onboarding",
            "needs_onboarding",
            saved_place_evidence_digest=place_digest,
            circle_evidence_digest=circle_digest,
        )


class PkmLocationPlaceEvidenceAdapter:
    """Verify an opaque Location PKM commit without reading its ciphertext.

    A UUID returned by the existing PKM mutation response is only a locator.
    Authority comes from the owner/domain/revision/time predicates re-read here.
    The readable index contributes only the non-sensitive configured/count
    summary; neither coordinates nor a label cross this adapter.
    """

    def __init__(self, *, db: Any | None = None, hmac_key: str | None = None) -> None:
        self._db = db
        self._hmac_key = hmac_key

    @property
    def db(self) -> Any:
        if self._db is None:
            self._db = get_db()
        return self._db

    async def verify_saved_place(
        self,
        *,
        user_id: str,
        commit_reference: str,
        not_before: datetime,
    ) -> LocationAdapterResult:
        try:
            commit_id = str(UUID(str(commit_reference).strip()))
        except (ValueError, AttributeError, TypeError):
            return LocationAdapterResult.failed("place_commit_invalid")
        try:
            result = await asyncio.to_thread(
                self.db.execute_raw,
                """
                SELECT commit.commit_id::TEXT AS commit_id,
                       commit.result_content_revision,
                       commit.result_manifest_revision
                FROM pkm_domain_commits commit
                JOIN pkm_manifests manifest
                  ON manifest.user_id = commit.user_id
                 AND manifest.domain = commit.domain
                 AND manifest.manifest_version = commit.result_manifest_revision
                JOIN pkm_index idx ON idx.user_id = commit.user_id
                WHERE commit.commit_id = CAST(:commit_id AS UUID)
                  AND commit.user_id = :user_id
                  AND commit.domain = 'location'
                  AND commit.commit_kind = 'mutation'
                  AND commit.created_at >= :not_before
                  AND COALESCE(
                    (idx.domain_summaries -> 'location' ->> 'saved_places_configured')::BOOLEAN,
                    FALSE
                  ) = TRUE
                  AND COALESCE(
                    (idx.domain_summaries -> 'location' ->> 'saved_places_count')::INTEGER,
                    0
                  ) > 0
                  AND EXISTS (
                    SELECT 1 FROM pkm_blobs blob
                    WHERE blob.user_id = commit.user_id
                      AND blob.domain = commit.domain
                      AND blob.content_revision = commit.result_content_revision
                  )
                LIMIT 1
                """,
                {"commit_id": commit_id, "user_id": user_id, "not_before": not_before},
            )
        except Exception:  # noqa: BLE001 - raw DB failures never cross the workflow boundary
            logger.info("location_onboarding_place_evidence_unavailable")
            return LocationAdapterResult.waiting("place_evidence_unavailable")
        rows = result.data or []
        if not rows:
            return LocationAdapterResult.waiting("place_commit_unverified")
        row = dict(rows[0])
        return LocationAdapterResult.verified(
            evidence_digest=_evidence_digest(
                "location_place_commit",
                {
                    "commit_id": commit_id,
                    "content_revision": int(row.get("result_content_revision") or 0),
                    "manifest_revision": int(row.get("result_manifest_revision") or 0),
                },
                hmac_key=self._hmac_key,
            )
        )


class OneLocationCircleProvisioningAdapter:
    """Idempotently reuse/create the owner's non-system personal Circle."""

    def __init__(self, *, hmac_key: str | None = None) -> None:
        self._hmac_key = hmac_key

    async def provision_personal_circle(
        self,
        *,
        user_id: str,
        run_id: str,
    ) -> LocationAdapterResult:
        try:
            from hushh_mcp.services.one_location_circle_service import OneLocationCircleService

            result = await asyncio.to_thread(
                OneLocationCircleService().bootstrap_first_circle,
                user_id=user_id,
                name="My Circle",
                capability_run_id=run_id,
            )
        except Exception:  # noqa: BLE001 - domain detail must not enter workflow output/logs
            logger.info("location_onboarding_circle_provisioning_unavailable")
            return LocationAdapterResult.waiting("circle_provisioning_unavailable")
        circle_id = str(result.get("circleId") or "").strip()
        invite_code = str(result.get("code") or "").strip()
        if not circle_id or not invite_code:
            return LocationAdapterResult.failed("circle_settlement_unverified")
        return LocationAdapterResult.verified(
            evidence_digest=_evidence_digest(
                "location_circle_provisioning",
                {"run_id": run_id, "circle_id": circle_id, "invite_code": invite_code},
                hmac_key=self._hmac_key,
            )
        )


class VaultLocationCompletionAdapter:
    """Idempotently write and re-read Location's existing setup marker."""

    def __init__(self, *, hmac_key: str | None = None) -> None:
        self._hmac_key = hmac_key

    async def ensure_completion_marker(
        self,
        *,
        user_id: str,
        run_id: str,
    ) -> LocationAdapterResult:
        try:
            from hushh_mcp.services.vault_keys_service import VaultKeysService

            service = VaultKeysService()
            before = await service.get_pre_vault_state(user_id)
            completed = sorted(
                {
                    *(str(value).strip() for value in before.get("setupCapabilityIds") or []),
                    "location",
                }
                - {""}
            )
            update: dict[str, Any] = {
                "user_id": user_id,
                "setup_capability_ids": completed,
            }
            if (
                before.get("onboardingPhase") == "capability_setup"
                and before.get("onboardingActiveCapability") == "location"
            ):
                update.update(
                    onboarding_journey_version=1,
                    onboarding_phase="setup_hub",
                    onboarding_active_capability=None,
                    onboarding_resume_route="/one/setup",
                    onboarding_callback_state="succeeded",
                    expected_onboarding_journey_updated_at=before.get("onboardingJourneyUpdatedAt"),
                )
            await service.update_pre_vault_state(**update)
            after = await service.get_pre_vault_state(user_id)
        except Exception:  # noqa: BLE001 - stale/outage remains a retryable waiting state
            logger.info("location_onboarding_completion_marker_unavailable")
            return LocationAdapterResult.waiting("completion_marker_unavailable")
        if "location" not in {
            str(value).strip() for value in after.get("setupCapabilityIds") or []
        }:
            return LocationAdapterResult.failed("completion_marker_unverified")
        return LocationAdapterResult.verified(
            evidence_digest=_evidence_digest(
                "location_completion_marker",
                {
                    "run_id": run_id,
                    "setup_capabilities_updated_at": after.get("setupCapabilitiesUpdatedAt"),
                    "journey_updated_at": after.get("onboardingJourneyUpdatedAt"),
                },
                hmac_key=self._hmac_key,
            )
        )


class LocationOnboardingLedgerStore:
    """Metadata-only one-time leases and opaque workflow receipts."""

    def __init__(self, *, db: Any | None = None, hmac_key: str | None = None) -> None:
        self._db = db
        self._hmac_key = hmac_key

    @property
    def db(self) -> Any:
        if self._db is None:
            self._db = get_db()
        return self._db

    @property
    def hmac_key(self) -> str:
        return self._hmac_key or get_core_security_settings().app_signing_key

    async def _execute(self, sql: str, params: dict[str, Any]) -> Any:
        return await asyncio.to_thread(self.db.execute_raw, sql, params)

    def digest(self, kind: str, value: Mapping[str, Any]) -> str:
        return _evidence_digest(kind, value, hmac_key=self.hmac_key)

    def _finalize_authorization_token(
        self,
        *,
        authorization_id: str,
        user_id: str,
        run_id: str,
        run_revision: int,
        lease_id: str,
        directive_id: str,
        draft_id: str,
        draft_digest: str,
        expected_commit_id: str,
    ) -> str:
        opaque_id = authorization_id.removeprefix("locpkmauth_")
        signature = self.digest(
            "location_pkm_finalize_token",
            {
                "authorization_id": authorization_id,
                "user_id": user_id,
                "run_id": run_id,
                "run_revision": run_revision,
                "lease_id": lease_id,
                "directive_id": directive_id,
                "draft_id": draft_id,
                "draft_digest": draft_digest,
                "expected_commit_id": expected_commit_id,
            },
        )
        return f"locpkmtoken_{opaque_id}_{signature}"

    @staticmethod
    def _row_to_lease(row: Mapping[str, Any]) -> LocationInteractionLeaseV1:
        issued_at = _parse_datetime(row.get("issued_at"))
        expires_at = _parse_datetime(row.get("expires_at"))
        if issued_at is None or expires_at is None:
            raise LocationOnboardingAuthorityError("Location interaction lease is invalid.")
        lease_id = str(row.get("lease_id") or "")
        directive_id = str(row.get("directive_id") or "")
        if not _LEASE_ID_RE.fullmatch(lease_id) or not _DIRECTIVE_ID_RE.fullmatch(directive_id):
            raise LocationOnboardingAuthorityError("Location interaction lease is invalid.")
        return LocationInteractionLeaseV1(
            lease_id=lease_id,
            directive_id=directive_id,
            user_id=str(row.get("user_id") or ""),
            run_id=str(row.get("run_id") or ""),
            workflow_version=int(row.get("workflow_version") or 0),
            step_cursor=str(row.get("step_cursor") or ""),
            run_revision=int(row.get("run_revision") or 0),
            context_revision=str(row.get("context_revision") or ""),
            surface_id=str(row.get("surface_id") or ""),
            resume_surface_id=str(row.get("resume_surface_id") or "") or None,
            allowed_actions_digest=str(row.get("allowed_actions_digest") or ""),
            issued_at=issued_at,
            expires_at=expires_at,
            consumed_at=_parse_datetime(row.get("consumed_at")),
            outcome_code=str(row.get("outcome_code") or "") or None,
            result_digest=str(row.get("result_digest") or "") or None,
        )

    @staticmethod
    def _row_to_receipt(row: Mapping[str, Any]) -> LocationReceiptV1:
        expires_at = _parse_datetime(row.get("expires_at"))
        if expires_at is None:
            raise LocationOnboardingAuthorityError("Location receipt is invalid.")
        return LocationReceiptV1(
            receipt_id=str(row.get("receipt_id") or ""),
            user_id=str(row.get("user_id") or ""),
            run_id=str(row.get("run_id") or ""),
            workflow_version=int(row.get("workflow_version") or 0),
            step_cursor=str(row.get("step_cursor") or ""),
            context_revision=str(row.get("context_revision") or ""),
            receipt_kind=str(row.get("receipt_kind") or ""),  # type: ignore[arg-type]
            outcome_code=str(row.get("outcome_code") or ""),  # type: ignore[arg-type]
            issuer=str(row.get("issuer") or ""),
            evidence_digest=str(row.get("evidence_digest") or ""),
            expires_at=expires_at,
            lease_id=str(row.get("lease_id") or "") or None,
            consumed_at=_parse_datetime(row.get("consumed_at")),
        )

    @staticmethod
    def _row_to_draft(row: Mapping[str, Any]) -> LocationSecureDraftMetadataV1:
        expires_at = _parse_datetime(row.get("expires_at"))
        created_at = _parse_datetime(row.get("created_at"))
        if expires_at is None or created_at is None:
            raise LocationOnboardingAuthorityError("Location draft metadata is invalid.")
        digest = str(row.get("content_digest") or "")
        if not _DRAFT_DIGEST_RE.fullmatch(digest):
            raise LocationOnboardingAuthorityError("Location draft metadata is invalid.")
        draft_id = str(row.get("draft_id") or "")
        if not _DRAFT_ID_RE.fullmatch(draft_id):
            raise LocationOnboardingAuthorityError("Location draft metadata is invalid.")
        return LocationSecureDraftMetadataV1(
            draft_id=draft_id,
            user_id=str(row.get("user_id") or ""),
            run_id=str(row.get("run_id") or ""),
            workflow_version=int(row.get("workflow_version") or 0),
            graph_revision=str(row.get("graph_revision") or ""),
            run_revision=int(row.get("run_revision") or 0),
            digest=digest,
            status="staged",
            expires_at=expires_at,
            created_at=created_at,
        )

    def _row_to_finalize_authorization(
        self, row: Mapping[str, Any]
    ) -> LocationPkmFinalizeAuthorizationV1:
        authorization_id = str(row.get("authorization_id") or "")
        run_id = str(row.get("run_id") or "")
        lease_id = str(row.get("lease_id") or "")
        directive_id = str(row.get("directive_id") or "")
        draft_id = str(row.get("draft_id") or "")
        draft_digest = str(row.get("draft_digest") or "")
        expected_commit_id = str(row.get("expected_commit_id") or "")
        issued_at = _parse_datetime(row.get("issued_at"))
        expires_at = _parse_datetime(row.get("expires_at"))
        if (
            not _PKM_FINALIZE_AUTHORIZATION_ID_RE.fullmatch(authorization_id)
            or not _RUN_ID_RE.fullmatch(run_id)
            or not _LEASE_ID_RE.fullmatch(lease_id)
            or not _DIRECTIVE_ID_RE.fullmatch(directive_id)
            or not _DRAFT_ID_RE.fullmatch(draft_id)
            or not _DRAFT_DIGEST_RE.fullmatch(draft_digest)
            or issued_at is None
            or expires_at is None
        ):
            raise LocationOnboardingAuthorityError("Location PKM finalize authority is invalid.")
        try:
            expected_commit_id = str(UUID(expected_commit_id))
        except (ValueError, TypeError, AttributeError) as exc:
            raise LocationOnboardingAuthorityError(
                "Location PKM finalize authority is invalid."
            ) from exc
        token = self._finalize_authorization_token(
            authorization_id=authorization_id,
            user_id=str(row.get("user_id") or ""),
            run_id=run_id,
            run_revision=int(row.get("run_revision") or 0),
            lease_id=lease_id,
            directive_id=directive_id,
            draft_id=draft_id,
            draft_digest=draft_digest,
            expected_commit_id=expected_commit_id,
        )
        token_sha256 = hashlib.sha256(token.encode("utf-8")).hexdigest()
        if not hmac.compare_digest(str(row.get("token_sha256") or ""), token_sha256):
            raise LocationOnboardingAuthorityError("Location PKM finalize authority is invalid.")
        return LocationPkmFinalizeAuthorizationV1(
            authorization_id=authorization_id,
            token=token,
            user_id=str(row.get("user_id") or ""),
            run_id=run_id,
            workflow_version=int(row.get("workflow_version") or 0),
            run_revision=int(row.get("run_revision") or 0),
            context_revision=str(row.get("context_revision") or ""),
            lease_id=lease_id,
            directive_id=directive_id,
            draft_id=draft_id,
            draft_digest=draft_digest,
            expected_commit_id=expected_commit_id,
            issued_at=issued_at,
            expires_at=expires_at,
            consumed_at=_parse_datetime(row.get("consumed_at")),
        )

    async def get_lease(
        self, *, user_id: str, run_id: str, lease_id: str
    ) -> LocationInteractionLeaseV1 | None:
        result = await self._execute(
            """
            SELECT lease_id, directive_id, user_id, run_id, workflow_version, step_cursor,
                   run_revision, context_revision, surface_id, resume_surface_id,
                   allowed_actions_digest, issued_at, expires_at, consumed_at,
                   outcome_code, result_digest
            FROM one_location_onboarding_interactions
            WHERE lease_id = :lease_id AND run_id = :run_id AND user_id = :user_id
            LIMIT 1
            """,
            {"lease_id": lease_id, "run_id": run_id, "user_id": user_id},
        )
        rows = result.data or []
        return self._row_to_lease(dict(rows[0])) if rows else None

    async def get_active_lease(
        self, *, user_id: str, run_id: str
    ) -> LocationInteractionLeaseV1 | None:
        result = await self._execute(
            """
            SELECT interaction.lease_id, interaction.directive_id,
                   interaction.user_id, interaction.run_id,
                   interaction.workflow_version, interaction.step_cursor,
                   interaction.run_revision, interaction.context_revision,
                   interaction.surface_id, interaction.resume_surface_id,
                   interaction.allowed_actions_digest,
                   interaction.issued_at, interaction.expires_at, interaction.consumed_at,
                   interaction.outcome_code, interaction.result_digest
            FROM one_location_onboarding_interactions interaction
            JOIN one_capability_runs run
              ON run.run_id = interaction.run_id AND run.user_id = interaction.user_id
            WHERE interaction.run_id = :run_id
              AND interaction.user_id = :user_id
              AND interaction.consumed_at IS NULL
              AND interaction.expires_at > NOW()
              AND run.pending_directive_id = interaction.directive_id
              AND run.revision = interaction.run_revision
              AND run.step_cursor = interaction.step_cursor
            LIMIT 1
            """,
            {"run_id": run_id, "user_id": user_id},
        )
        rows = result.data or []
        return self._row_to_lease(dict(rows[0])) if rows else None

    async def record_secure_draft(
        self,
        *,
        run: CapabilityRunV1,
        client_run_id: str,
        client_revision: int,
        digest: str,
        status: str,
        expires_at: datetime,
    ) -> LocationSecureDraftMetadataV1:
        """Bind opaque device-draft metadata to the exact leased run revision."""

        if client_run_id != run.run_id or int(client_revision) != run.revision:
            raise LocationOnboardingConflictError(
                "Location draft metadata is bound to a stale workflow revision."
            )
        if status != "staged" or not _DRAFT_DIGEST_RE.fullmatch(str(digest or "")):
            raise ValueError("Location draft metadata is invalid.")
        now = datetime.now(UTC)
        draft_id = f"locdraft_{uuid4().hex}"
        requested_expiry = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=UTC)
        if requested_expiry <= now:
            raise ValueError("Location draft metadata expiry is invalid.")
        latest = min(
            run.expires_at or (now + timedelta(hours=24)),
            now + timedelta(hours=24),
        )
        if latest <= now:
            raise ValueError("Location draft metadata expiry is invalid.")
        # The device proposes an upper bound, but the server owns both the run
        # lifetime and the maximum draft lifetime.  A client that computes
        # ``now + 24h`` after run creation will naturally be a little later
        # than ``run.expires_at``; clipping keeps that valid flow from failing.
        clean_expiry = min(requested_expiry, latest)
        result = await self._execute(
            """
            INSERT INTO one_location_onboarding_drafts (
              draft_id, run_id, user_id, workflow_version, graph_revision, run_revision,
              content_digest, status, expires_at
            )
            SELECT :draft_id, :run_id, :user_id, :workflow_version, :graph_revision,
                   :run_revision, :content_digest, 'staged', :expires_at
            FROM one_capability_runs run
            WHERE run.run_id = :run_id AND run.user_id = :user_id
              AND run.capability_id = 'workflow.setup.location'
              AND run.capability_version = :workflow_version
              AND run.graph_revision = :graph_revision
              AND run.revision = :run_revision
              AND run.status NOT IN (
                'verified_succeeded', 'verified_failed', 'cancelled', 'expired'
              )
              AND run.expires_at > NOW()
            ON CONFLICT (run_id) DO UPDATE
            SET content_digest = one_location_onboarding_drafts.content_digest
            WHERE one_location_onboarding_drafts.user_id = EXCLUDED.user_id
              AND one_location_onboarding_drafts.workflow_version = EXCLUDED.workflow_version
              AND one_location_onboarding_drafts.graph_revision = EXCLUDED.graph_revision
              AND one_location_onboarding_drafts.run_revision = EXCLUDED.run_revision
              AND one_location_onboarding_drafts.content_digest = EXCLUDED.content_digest
              AND one_location_onboarding_drafts.status = EXCLUDED.status
              AND one_location_onboarding_drafts.expires_at = EXCLUDED.expires_at
            RETURNING draft_id, user_id, run_id, workflow_version, graph_revision,
                      run_revision, content_digest, status, expires_at, created_at
            """,
            {
                "draft_id": draft_id,
                "run_id": run.run_id,
                "user_id": run.user_id,
                "workflow_version": LOCATION_ONBOARDING_WORKFLOW_VERSION,
                "graph_revision": run.graph_revision,
                "run_revision": run.revision,
                "content_digest": digest,
                "expires_at": clean_expiry,
            },
        )
        rows = result.data or []
        if not rows:
            raise LocationOnboardingConflictError(
                "Location draft metadata conflicts with the durable run."
            )
        return self._row_to_draft(dict(rows[0]))

    async def get_active_secure_draft(
        self, *, user_id: str, run_id: str
    ) -> LocationSecureDraftMetadataV1 | None:
        result = await self._execute(
            """
            SELECT draft.draft_id, draft.user_id, draft.run_id, draft.workflow_version,
                   draft.graph_revision, draft.run_revision,
                   draft.content_digest, draft.status,
                   draft.expires_at, draft.created_at
            FROM one_location_onboarding_drafts draft
            JOIN one_capability_runs run
              ON run.run_id = draft.run_id AND run.user_id = draft.user_id
            WHERE draft.run_id = :run_id AND draft.user_id = :user_id
              AND draft.workflow_version = :workflow_version
              AND draft.status = 'staged'
              AND draft.expires_at > NOW()
              AND run.status NOT IN ('verified_failed', 'cancelled', 'expired')
            LIMIT 1
            """,
            {
                "run_id": run_id,
                "user_id": user_id,
                "workflow_version": LOCATION_ONBOARDING_WORKFLOW_VERSION,
            },
        )
        rows = result.data or []
        return self._row_to_draft(dict(rows[0])) if rows else None

    async def issue_pkm_finalize_authorization(
        self,
        *,
        run: CapabilityRunV1,
        lease: LocationInteractionLeaseV1,
        draft: LocationSecureDraftMetadataV1,
        ttl_seconds: int = 300,
    ) -> LocationPkmFinalizeAuthorizationV1:
        """Issue/re-read the one opaque capability accepted by PKM RPC v5."""

        if (
            run.status != "interaction_required"
            or run.step_cursor != LOCATION_COMPLETE_STEP
            or run.pending_interaction != "one.location.awaiting_vault_finalize.v2"
            or run.pending_directive_id != lease.directive_id
            or lease.user_id != run.user_id
            or lease.run_id != run.run_id
            or lease.run_revision != run.revision
            or lease.step_cursor != run.step_cursor
            or lease.surface_id != "one.location.awaiting_vault_finalize.v2"
            or lease.consumed_at is not None
            or draft.user_id != run.user_id
            or draft.run_id != run.run_id
            or draft.workflow_version != LOCATION_ONBOARDING_WORKFLOW_VERSION
            or draft.graph_revision != run.graph_revision
            or draft.status != "staged"
        ):
            raise LocationOnboardingConflictError(
                "Location PKM finalize authority cannot be issued for this task."
            )
        now = datetime.now(UTC)
        expires_at = min(
            lease.expires_at,
            draft.expires_at,
            run.expires_at or (now + timedelta(minutes=5)),
            now + timedelta(seconds=max(30, min(ttl_seconds, 300))),
        )
        if expires_at <= now:
            raise LocationOnboardingConflictError("Location PKM finalize authority has expired.")
        authorization_id = f"locpkmauth_{uuid4().hex}"
        expected_commit_id = derive_location_pre_vault_pkm_commit_id(
            user_id=run.user_id,
            run_id=run.run_id,
            draft_digest=draft.digest,
        )
        token = self._finalize_authorization_token(
            authorization_id=authorization_id,
            user_id=run.user_id,
            run_id=run.run_id,
            run_revision=run.revision,
            lease_id=lease.lease_id,
            directive_id=lease.directive_id,
            draft_id=draft.draft_id,
            draft_digest=draft.digest,
            expected_commit_id=expected_commit_id,
        )
        if not _PKM_FINALIZE_TOKEN_RE.fullmatch(token):
            raise LocationOnboardingAuthorityError("Location PKM finalize authority is invalid.")
        place_receipt_evidence_digest = self.digest(
            "location_place_atomic_commit",
            {
                "run_id": run.run_id,
                "draft_id": draft.draft_id,
                "draft_digest": draft.digest,
                "commit_id": expected_commit_id,
            },
        )
        interaction_result_digest = self.digest(
            "location_interaction_result",
            {
                "run_id": run.run_id,
                "lease_id": lease.lease_id,
                "action": "place_saved",
                "next_cursor": LOCATION_COMPLETE_STEP,
            },
        )
        result = await self._execute(
            """
            WITH eligible AS (
              SELECT run.run_id
              FROM one_capability_runs run
              JOIN one_location_onboarding_interactions interaction
                ON interaction.run_id = run.run_id
               AND interaction.user_id = run.user_id
              JOIN one_location_onboarding_drafts draft
                ON draft.run_id = run.run_id
               AND draft.user_id = run.user_id
              WHERE run.run_id = :run_id
                AND run.user_id = :user_id
                AND run.capability_id = 'workflow.setup.location'
                AND run.capability_version = :workflow_version
                AND run.status = 'interaction_required'
                AND run.step_cursor = :step_cursor
                AND run.revision = :run_revision
                AND run.pending_interaction = :surface_id
                AND run.pending_directive_id = :directive_id
                AND run.expires_at > NOW()
                AND interaction.lease_id = :lease_id
                AND interaction.directive_id = :directive_id
                AND interaction.run_revision = run.revision
                AND interaction.step_cursor = run.step_cursor
                AND interaction.surface_id = :surface_id
                AND interaction.consumed_at IS NULL
                AND interaction.expires_at > NOW()
                AND draft.draft_id = :draft_id
                AND draft.workflow_version = :workflow_version
                AND draft.graph_revision = run.graph_revision
                AND draft.content_digest = :draft_digest
                AND draft.status = 'staged'
                AND draft.expires_at > NOW()
                AND NOT EXISTS (
                  SELECT 1 FROM one_location_onboarding_receipts prior
                  WHERE prior.run_id = run.run_id
                    AND prior.receipt_kind = 'place'
                )
              FOR UPDATE OF run, interaction, draft
            )
            INSERT INTO one_location_pkm_finalize_authorizations AS authority (
              authorization_id, token_sha256, user_id, run_id, workflow_version,
              run_revision, context_revision, lease_id, directive_id, draft_id,
              draft_digest, expected_commit_id, place_receipt_evidence_digest,
              interaction_result_digest, expires_at
            )
            SELECT :authorization_id, :token_sha256, :user_id, :run_id,
                   :workflow_version, :run_revision, :context_revision,
                   :lease_id, :directive_id, :draft_id, :draft_digest,
                   CAST(:expected_commit_id AS UUID),
                   :place_receipt_evidence_digest, :interaction_result_digest,
                   :expires_at
            FROM eligible
            ON CONFLICT (run_id, run_revision) DO UPDATE
            SET authorization_id = authority.authorization_id
            WHERE authority.user_id = EXCLUDED.user_id
              AND authority.workflow_version = EXCLUDED.workflow_version
              AND authority.context_revision = EXCLUDED.context_revision
              AND authority.lease_id = EXCLUDED.lease_id
              AND authority.directive_id = EXCLUDED.directive_id
              AND authority.draft_id = EXCLUDED.draft_id
              AND authority.draft_digest = EXCLUDED.draft_digest
              AND authority.expected_commit_id = EXCLUDED.expected_commit_id
              AND authority.consumed_at IS NULL
              AND authority.expires_at > NOW()
            RETURNING authorization_id, token_sha256, user_id, run_id,
                      workflow_version, run_revision, context_revision, lease_id,
                      directive_id, draft_id, draft_digest, expected_commit_id,
                      issued_at, expires_at, consumed_at
            """,
            {
                "authorization_id": authorization_id,
                "token_sha256": hashlib.sha256(token.encode("utf-8")).hexdigest(),
                "user_id": run.user_id,
                "run_id": run.run_id,
                "workflow_version": LOCATION_ONBOARDING_WORKFLOW_VERSION,
                "run_revision": run.revision,
                "context_revision": run.context_revision,
                "lease_id": lease.lease_id,
                "directive_id": lease.directive_id,
                "draft_id": draft.draft_id,
                "draft_digest": draft.digest,
                "expected_commit_id": expected_commit_id,
                "place_receipt_evidence_digest": place_receipt_evidence_digest,
                "interaction_result_digest": interaction_result_digest,
                "surface_id": "one.location.awaiting_vault_finalize.v2",
                "step_cursor": LOCATION_COMPLETE_STEP,
                "expires_at": expires_at,
            },
        )
        rows = result.data or []
        if not rows:
            raise LocationOnboardingConflictError(
                "Location PKM finalize authority conflicts with this task."
            )
        return self._row_to_finalize_authorization(dict(rows[0]))

    async def purge_secure_draft(self, *, user_id: str, run_id: str) -> None:
        await self._execute(
            """
            WITH authority_purge AS (
              DELETE FROM one_location_pkm_finalize_authorizations
              WHERE run_id = :run_id AND user_id = :user_id
                AND consumed_at IS NULL
            )
            DELETE FROM one_location_onboarding_drafts
            WHERE run_id = :run_id AND user_id = :user_id
            """,
            {"run_id": run_id, "user_id": user_id},
        )

    async def purge_owner_drafts(self, *, user_id: str) -> int:
        """Sign-out/account-lifecycle hook; safe to call repeatedly."""

        result = await self._execute(
            """
            WITH authority_purge AS (
              DELETE FROM one_location_pkm_finalize_authorizations
              WHERE user_id = :user_id AND consumed_at IS NULL
            )
            DELETE FROM one_location_onboarding_drafts
            WHERE user_id = :user_id
            RETURNING run_id
            """,
            {"user_id": user_id},
        )
        return len(result.data or [])

    async def purge_expired_drafts(self) -> int:
        """Bounded expiry-cleaner hook for a scheduler or startup maintenance."""

        result = await self._execute(
            """
            WITH authority_purge AS (
              DELETE FROM one_location_pkm_finalize_authorizations
              WHERE consumed_at IS NULL AND expires_at <= NOW()
            )
            DELETE FROM one_location_onboarding_drafts
            WHERE run_id IN (
              SELECT run_id FROM one_location_onboarding_drafts
              WHERE expires_at <= NOW()
              ORDER BY expires_at
              LIMIT 500
            )
            RETURNING run_id
            """,
            {},
        )
        return len(result.data or [])

    async def issue_lease(
        self,
        *,
        run: CapabilityRunV1,
        contract: LocationStepContractV2,
        resume_surface_id: str | None = None,
        ttl_seconds: int = 300,
    ) -> tuple[CapabilityRunV1, LocationInteractionLeaseV1]:
        if contract.surface_id == "one.location.paused.v2":
            if (
                resume_surface_id not in _SURFACE_CONTRACTS
                or resume_surface_id == "one.location.paused.v2"
            ):
                raise LocationOnboardingAuthorityError(
                    "Paused Location interaction has no registered resume target."
                )
        elif resume_surface_id is not None:
            raise ValueError("Resume targets are valid only for paused interactions.")
        active = await self.get_active_lease(user_id=run.user_id, run_id=run.run_id)
        if active is not None:
            expected_digest = self.digest(
                "location_allowed_actions", {"actions": list(contract.allowed_actions)}
            )
            if (
                active.run_revision == run.revision
                and active.step_cursor == run.step_cursor
                and active.surface_id == contract.surface_id
                and (resume_surface_id is None or active.resume_surface_id == resume_surface_id)
                and hmac.compare_digest(active.allowed_actions_digest, expected_digest)
            ):
                return run, active
            raise LocationOnboardingConflictError("Location interaction lease is inconsistent.")

        lease_id = f"loclease_{uuid4().hex}"
        directive_id = f"locdirective_{uuid4().hex}"
        expires_at = datetime.now(UTC) + timedelta(seconds=max(30, min(ttl_seconds, 600)))
        allowed_actions_digest = self.digest(
            "location_allowed_actions", {"actions": list(contract.allowed_actions)}
        )
        params = {
            "lease_id": lease_id,
            "directive_id": directive_id,
            "user_id": run.user_id,
            "run_id": run.run_id,
            "workflow_version": LOCATION_ONBOARDING_WORKFLOW_VERSION,
            "step_cursor": run.step_cursor,
            "expected_revision": run.revision,
            "context_revision": run.context_revision,
            "surface_id": contract.surface_id,
            "pending_interaction_id": resume_surface_id or contract.surface_id,
            "resume_surface_id": resume_surface_id,
            "allowed_actions_digest": allowed_actions_digest,
            "expires_at": expires_at,
        }
        result = await self._execute(
            """
            WITH advanced AS (
              UPDATE one_capability_runs
              SET pending_interaction = :pending_interaction_id,
                  pending_directive_id = :directive_id,
                  revision = revision + 1,
                  updated_at = NOW()
              WHERE run_id = :run_id AND user_id = :user_id
                AND capability_id = 'workflow.setup.location'
                AND capability_version = :workflow_version
                AND step_cursor = :step_cursor
                AND revision = :expected_revision
                AND status NOT IN (
                  'verified_succeeded', 'verified_failed', 'cancelled', 'expired'
                )
                AND expires_at > NOW()
              RETURNING revision
            )
            INSERT INTO one_location_onboarding_interactions (
              lease_id, directive_id, user_id, run_id, workflow_version, step_cursor,
              run_revision, context_revision, surface_id, resume_surface_id,
              allowed_actions_digest, expires_at
            )
            SELECT :lease_id, :directive_id, :user_id, :run_id,
                   :workflow_version, :step_cursor,
                   advanced.revision, :context_revision, :surface_id,
                   :resume_surface_id,
                   :allowed_actions_digest, :expires_at
            FROM advanced
            RETURNING lease_id, directive_id, user_id, run_id, workflow_version, step_cursor,
                      run_revision, context_revision, surface_id, resume_surface_id,
                      allowed_actions_digest, issued_at, expires_at, consumed_at,
                      outcome_code, result_digest
            """,
            params,
        )
        rows = result.data or []
        if not rows:
            active = await self.get_active_lease(user_id=run.user_id, run_id=run.run_id)
            if active is not None:
                if (
                    active.run_revision != run.revision
                    or active.step_cursor != run.step_cursor
                    or active.surface_id != contract.surface_id
                    or active.resume_surface_id != resume_surface_id
                    or not hmac.compare_digest(
                        active.allowed_actions_digest, allowed_actions_digest
                    )
                ):
                    raise LocationOnboardingConflictError(
                        "Location interaction lease is inconsistent."
                    )
                current_revision = active.run_revision
                return (
                    replace(
                        run,
                        revision=current_revision,
                        pending_interaction=resume_surface_id or active.surface_id,
                        pending_directive_id=active.directive_id,
                    ),
                    active,
                )
            raise LocationOnboardingConflictError(
                "Location run changed before the interaction could be issued."
            )
        lease = self._row_to_lease(dict(rows[0]))
        return (
            replace(
                run,
                revision=lease.run_revision,
                pending_interaction=resume_surface_id or contract.surface_id,
                pending_directive_id=lease.directive_id,
            ),
            lease,
        )

    async def consume_and_move(
        self,
        *,
        run: CapabilityRunV1,
        lease: LocationInteractionLeaseV1,
        action: LocationInteractionAction,
        next_cursor: LocationCursor,
        next_status: Literal["interaction_required", "needs_input", "paused"],
        next_surface_id: str | None = None,
        purge_draft: bool = False,
        receipt_kind: LocationReceiptKind | None = None,
        receipt_outcome: LocationReceiptOutcome | None = None,
        receipt_issuer: str | None = None,
        receipt_evidence_digest: str | None = None,
    ) -> CapabilityRunV1:
        if next_surface_id is not None and next_surface_id not in _SURFACE_CONTRACTS:
            raise ValueError("Location interaction surface is not registered.")
        result_digest = self.digest(
            "location_interaction_result",
            {
                "run_id": run.run_id,
                "lease_id": lease.lease_id,
                "action": action,
                "next_cursor": next_cursor,
            },
        )
        mint_receipt = receipt_kind is not None
        if mint_receipt and (
            receipt_outcome is None
            or not receipt_issuer
            or not receipt_evidence_digest
            or not _DIGEST_RE.fullmatch(receipt_evidence_digest)
        ):
            raise ValueError("Location receipt proof is incomplete.")
        receipt_id = f"{_RECEIPT_PREFIX[str(receipt_kind)]}_{uuid4().hex}" if mint_receipt else None
        params = {
            "lease_id": lease.lease_id,
            "directive_id": lease.directive_id,
            "run_id": run.run_id,
            "user_id": run.user_id,
            "workflow_version": LOCATION_ONBOARDING_WORKFLOW_VERSION,
            "expected_revision": run.revision,
            "step_cursor": run.step_cursor,
            "action": action,
            "result_digest": result_digest,
            "next_cursor": next_cursor,
            "next_status": next_status,
            "next_surface_id": next_surface_id,
            "purge_draft": purge_draft,
            "mint_receipt": mint_receipt,
            "receipt_id": receipt_id,
            "receipt_kind": receipt_kind,
            "receipt_outcome": receipt_outcome,
            "receipt_issuer": receipt_issuer,
            "receipt_evidence_digest": receipt_evidence_digest,
        }
        result = await self._execute(
            """
            WITH eligible AS (
              SELECT interaction.lease_id
              FROM one_location_onboarding_interactions interaction
              JOIN one_capability_runs run
                ON run.run_id = interaction.run_id AND run.user_id = interaction.user_id
              WHERE interaction.lease_id = :lease_id
                AND interaction.directive_id = :directive_id
                AND interaction.run_id = :run_id
                AND interaction.user_id = :user_id
                AND interaction.workflow_version = :workflow_version
                AND interaction.step_cursor = :step_cursor
                AND interaction.run_revision = :expected_revision
                AND interaction.consumed_at IS NULL
                AND interaction.expires_at > NOW()
                AND run.revision = :expected_revision
                AND run.step_cursor = :step_cursor
                AND run.pending_directive_id = :directive_id
                AND run.status NOT IN (
                  'verified_succeeded', 'verified_failed', 'cancelled', 'expired'
                )
                AND run.expires_at > NOW()
                AND (
                  :mint_receipt = FALSE
                  OR NOT EXISTS (
                    SELECT 1 FROM one_location_onboarding_receipts prior
                    WHERE prior.run_id = :run_id
                      AND prior.receipt_kind = :receipt_kind
                      AND (
                        prior.outcome_code <> :receipt_outcome
                        OR prior.issuer <> :receipt_issuer
                        OR prior.evidence_digest <> :receipt_evidence_digest
                      )
                  )
                )
              FOR UPDATE OF interaction, run
            ), advanced AS (
              UPDATE one_capability_runs run
              SET status = :next_status,
                  step_cursor = :next_cursor,
                  pending_interaction = :next_surface_id,
                  pending_directive_id = NULL,
                  revision = revision + 1,
                  updated_at = NOW()
              FROM eligible
              WHERE run.run_id = :run_id AND run.user_id = :user_id
                AND run.revision = :expected_revision
              RETURNING run.revision
            ), consumed AS (
              UPDATE one_location_onboarding_interactions interaction
              SET consumed_at = NOW(), outcome_code = :action,
                  result_digest = :result_digest
              FROM advanced
              WHERE interaction.lease_id = :lease_id
                AND interaction.consumed_at IS NULL
              RETURNING interaction.lease_id
            ), authorization_purge AS (
              DELETE FROM one_location_pkm_finalize_authorizations authority
              USING advanced
              WHERE :purge_draft = TRUE
                AND authority.run_id = :run_id
                AND authority.user_id = :user_id
                AND authority.consumed_at IS NULL
              RETURNING authority.authorization_id
            ), draft_purge AS (
              DELETE FROM one_location_onboarding_drafts draft
              USING advanced
              WHERE :purge_draft = TRUE
                AND draft.run_id = :run_id
                AND draft.user_id = :user_id
              RETURNING draft.run_id
            ), receipt AS (
              INSERT INTO one_location_onboarding_receipts (
                receipt_id, user_id, run_id, workflow_version, step_cursor,
                context_revision, receipt_kind, outcome_code, issuer,
                evidence_digest, lease_id, expires_at
              )
              SELECT :receipt_id, :user_id, :run_id, :workflow_version,
                     :step_cursor, :context_revision, :receipt_kind,
                     :receipt_outcome, :receipt_issuer,
                     :receipt_evidence_digest, :lease_id, :receipt_expires_at
              FROM consumed
              WHERE :mint_receipt = TRUE
              ON CONFLICT (run_id, receipt_kind) DO UPDATE
              SET receipt_id = one_location_onboarding_receipts.receipt_id
              WHERE one_location_onboarding_receipts.outcome_code = EXCLUDED.outcome_code
                AND one_location_onboarding_receipts.issuer = EXCLUDED.issuer
                AND one_location_onboarding_receipts.evidence_digest = EXCLUDED.evidence_digest
              RETURNING receipt_id
            )
            SELECT advanced.revision
            FROM advanced JOIN consumed ON TRUE
            WHERE :mint_receipt = FALSE OR EXISTS (SELECT 1 FROM receipt)
            """,
            {
                **params,
                "context_revision": run.context_revision,
                "receipt_expires_at": run.expires_at or (datetime.now(UTC) + timedelta(days=1)),
            },
        )
        rows = result.data or []
        if rows:
            return replace(
                run,
                status=next_status,
                step_cursor=next_cursor,
                pending_interaction=next_surface_id,
                pending_directive_id=None,
                revision=int(rows[0].get("revision") or run.revision + 1),
            )

        recorded = await self.get_lease(
            user_id=run.user_id, run_id=run.run_id, lease_id=lease.lease_id
        )
        if (
            recorded is not None
            and recorded.consumed_at is not None
            and recorded.outcome_code == action
            and recorded.result_digest
            and hmac.compare_digest(recorded.result_digest, result_digest)
        ):
            current = await get_capability_run_store().get(user_id=run.user_id, run_id=run.run_id)
            if current is not None:
                return current
        raise LocationOnboardingConflictError(
            "Location interaction is stale, mismatched, expired, or already used."
        )

    async def move_run(
        self,
        *,
        run: CapabilityRunV1,
        next_cursor: LocationCursor,
        next_status: Literal["interaction_required", "needs_input", "paused"] = (
            "interaction_required"
        ),
        next_surface_id: str | None = None,
    ) -> CapabilityRunV1:
        if next_surface_id is not None and next_surface_id not in _SURFACE_CONTRACTS:
            raise ValueError("Location interaction surface is not registered.")
        result = await self._execute(
            """
            UPDATE one_capability_runs
            SET status = :next_status, step_cursor = :next_cursor,
                pending_interaction = :next_surface_id, pending_directive_id = NULL,
                revision = revision + 1, updated_at = NOW()
            WHERE run_id = :run_id AND user_id = :user_id
              AND capability_id = 'workflow.setup.location'
              AND capability_version = :workflow_version
              AND revision = :expected_revision
              AND status NOT IN (
                'verified_succeeded', 'verified_failed', 'cancelled', 'expired'
              )
              AND expires_at > NOW()
            RETURNING revision
            """,
            {
                "run_id": run.run_id,
                "user_id": run.user_id,
                "workflow_version": LOCATION_ONBOARDING_WORKFLOW_VERSION,
                "expected_revision": run.revision,
                "next_cursor": next_cursor,
                "next_status": next_status,
                "next_surface_id": next_surface_id,
            },
        )
        if not result.data:
            raise LocationOnboardingConflictError("Location run changed; reload before retrying.")
        return replace(
            run,
            status=next_status,
            step_cursor=next_cursor,
            pending_interaction=next_surface_id,
            pending_directive_id=None,
            revision=int(result.data[0].get("revision") or run.revision + 1),
        )

    async def mint_server_receipt(
        self,
        *,
        run: CapabilityRunV1,
        receipt_kind: LocationReceiptKind,
        outcome_code: LocationReceiptOutcome,
        issuer: str,
        evidence_digest: str,
    ) -> LocationReceiptV1:
        if not _DIGEST_RE.fullmatch(evidence_digest):
            raise ValueError("Location receipt evidence digest is invalid.")
        receipt_id = f"{_RECEIPT_PREFIX[receipt_kind]}_{uuid4().hex}"
        params = {
            "receipt_id": receipt_id,
            "user_id": run.user_id,
            "run_id": run.run_id,
            "workflow_version": LOCATION_ONBOARDING_WORKFLOW_VERSION,
            "step_cursor": run.step_cursor,
            "context_revision": run.context_revision,
            "receipt_kind": receipt_kind,
            "outcome_code": outcome_code,
            "issuer": _safe_reason(issuer),
            "evidence_digest": evidence_digest,
            "expires_at": run.expires_at or (datetime.now(UTC) + timedelta(days=1)),
        }
        result = await self._execute(
            """
            INSERT INTO one_location_onboarding_receipts (
              receipt_id, user_id, run_id, workflow_version, step_cursor,
              context_revision, receipt_kind, outcome_code, issuer,
              evidence_digest, expires_at
            )
            SELECT :receipt_id, :user_id, :run_id, :workflow_version,
                   :step_cursor, :context_revision, :receipt_kind,
                   :outcome_code, :issuer, :evidence_digest, :expires_at
            FROM one_capability_runs run
            WHERE run.run_id = :run_id AND run.user_id = :user_id
              AND run.capability_id = 'workflow.setup.location'
              AND run.capability_version = :workflow_version
              AND run.status NOT IN ('verified_failed', 'cancelled', 'expired')
              AND run.expires_at > NOW()
            ON CONFLICT (run_id, receipt_kind) DO UPDATE
            SET receipt_id = one_location_onboarding_receipts.receipt_id
            WHERE one_location_onboarding_receipts.outcome_code = EXCLUDED.outcome_code
              AND one_location_onboarding_receipts.issuer = EXCLUDED.issuer
              AND one_location_onboarding_receipts.evidence_digest = EXCLUDED.evidence_digest
            RETURNING receipt_id, user_id, run_id, workflow_version, step_cursor,
                      context_revision, receipt_kind, outcome_code, issuer,
                      evidence_digest, expires_at, lease_id, consumed_at
            """,
            params,
        )
        rows = result.data or []
        if not rows:
            raise LocationOnboardingConflictError("Location receipt conflicts with prior evidence.")
        return self._row_to_receipt(dict(rows[0]))

    async def list_receipts(
        self, *, user_id: str, run_id: str
    ) -> dict[LocationReceiptKind, LocationReceiptV1]:
        result = await self._execute(
            """
            SELECT receipt.receipt_id, receipt.user_id, receipt.run_id,
                   receipt.workflow_version, receipt.step_cursor,
                   receipt.context_revision, receipt.receipt_kind,
                   receipt.outcome_code, receipt.issuer,
                   receipt.evidence_digest, receipt.expires_at,
                   receipt.lease_id, receipt.consumed_at
            FROM one_location_onboarding_receipts receipt
            JOIN one_capability_runs run
              ON run.run_id = receipt.run_id AND run.user_id = receipt.user_id
            WHERE receipt.run_id = :run_id AND receipt.user_id = :user_id
              AND receipt.workflow_version = :workflow_version
              AND receipt.expires_at > NOW()
            ORDER BY receipt.issued_at, receipt.receipt_id
            """,
            {
                "run_id": run_id,
                "user_id": user_id,
                "workflow_version": LOCATION_ONBOARDING_WORKFLOW_VERSION,
            },
        )
        receipts: dict[LocationReceiptKind, LocationReceiptV1] = {}
        for raw in result.data or []:
            receipt = self._row_to_receipt(dict(raw))
            if receipt.receipt_kind not in _RECEIPT_PREFIX:
                raise LocationOnboardingAuthorityError("Location receipt kind is invalid.")
            receipts[receipt.receipt_kind] = receipt
        return receipts

    async def consume_receipts(self, *, user_id: str, run_id: str) -> None:
        result = await self._execute(
            """
            UPDATE one_location_onboarding_receipts
            SET consumed_at = COALESCE(consumed_at, NOW())
            WHERE run_id = :run_id AND user_id = :user_id
              AND workflow_version = :workflow_version
              AND receipt_kind IN ('permission', 'place', 'circle', 'completion')
            RETURNING receipt_id
            """,
            {
                "run_id": run_id,
                "user_id": user_id,
                "workflow_version": LOCATION_ONBOARDING_WORKFLOW_VERSION,
            },
        )
        if len(result.data or []) != 4:
            raise LocationOnboardingAuthorityError("Location receipt chain is incomplete.")


class LocationOnboardingRuntimeService:
    """Deterministic Location v2 state machine and adapter orchestrator."""

    def __init__(
        self,
        *,
        run_store: CapabilityRunStore | Any | None = None,
        ledger_store: LocationOnboardingLedgerStore | Any | None = None,
        preflight_port: LocationPreflightPort | None = None,
        place_port: LocationPlaceEvidencePort | None = None,
        circle_port: LocationCircleProvisioningPort | None = None,
        completion_port: LocationCompletionPort | None = None,
    ) -> None:
        self.run_store = run_store or get_capability_run_store()
        self.ledger_store = ledger_store or LocationOnboardingLedgerStore()
        self.preflight_port = preflight_port or VaultLocationOnboardingPreflightAdapter()
        self.place_port = place_port or PkmLocationPlaceEvidenceAdapter()
        self.circle_port = circle_port or OneLocationCircleProvisioningAdapter()
        self.completion_port = completion_port or VaultLocationCompletionAdapter()

    @staticmethod
    def _validate_owner(user_id: str) -> str:
        owner = str(user_id or "").strip()[:256]
        if not owner:
            raise LocationOnboardingAuthorityError("A verified owner is required.")
        return owner

    @staticmethod
    def _validate_graph_revision(graph_revision: str) -> str:
        revision = str(graph_revision or "").strip()[:128]
        if not revision:
            raise LocationOnboardingAuthorityError("Capability graph revision is unavailable.")
        return revision

    @classmethod
    def _validate_graph_revision_set(cls, revisions: Iterable[str]) -> frozenset[str]:
        clean = frozenset(cls._validate_graph_revision(revision) for revision in revisions)
        if len(clean) > 256:
            raise LocationOnboardingAuthorityError(
                "Capability graph compatibility history is invalid."
            )
        return clean

    @classmethod
    def _assert_run_graph_compatible(
        cls,
        *,
        run: CapabilityRunV1,
        current_graph_revision: str,
        compatible_graph_revisions: Iterable[str],
        migration_required_graph_revisions: Iterable[str],
        rejected_graph_revisions: Iterable[str],
    ) -> None:
        """Admit only exact or artifact-proven pinned workflow revisions."""

        if run.graph_revision == current_graph_revision:
            return
        compatible = cls._validate_graph_revision_set(compatible_graph_revisions)
        migration_required = cls._validate_graph_revision_set(migration_required_graph_revisions)
        rejected = cls._validate_graph_revision_set(rejected_graph_revisions)
        if (
            compatible & migration_required
            or compatible & rejected
            or migration_required & rejected
            or current_graph_revision in compatible | migration_required | rejected
        ):
            raise LocationOnboardingAuthorityError(
                "Capability graph compatibility history is invalid."
            )
        if run.graph_revision in compatible:
            return
        if run.graph_revision in migration_required:
            raise LocationOnboardingMigrationRequiredError(
                "Location workflow revision requires its declared migration."
            )
        raise LocationOnboardingConflictError(
            "Location workflow revision is not compatible with this release."
        )

    @staticmethod
    def _validate_run(run: CapabilityRunV1, *, user_id: str) -> None:
        if run.user_id != user_id or run.capability_id != LOCATION_ONBOARDING_WORKFLOW_ID:
            raise LocationOnboardingAuthorityError("Location onboarding run was not found.")

    async def _normalize_loaded_run(self, *, run: CapabilityRunV1, user_id: str) -> CapabilityRunV1:
        """Apply elapsed-run cleanup without changing explicit terminal reads."""

        self._validate_run(run, user_id=user_id)
        if run.expires_at is not None and run.expires_at <= datetime.now(UTC):
            if run.status not in _TERMINAL_STATUSES:
                run = await self.run_store.expire(
                    user_id=run.user_id,
                    run_id=run.run_id,
                    expected_revision=run.revision,
                )
            await self.ledger_store.purge_secure_draft(user_id=run.user_id, run_id=run.run_id)
        return run

    async def _load_run(self, *, user_id: str, run_id: str | None) -> CapabilityRunV1 | None:
        if run_id:
            clean_run_id = str(run_id).strip()
            if not _RUN_ID_RE.fullmatch(clean_run_id):
                raise LocationOnboardingAuthorityError("Location onboarding run was not found.")
            run = await self.run_store.get(user_id=user_id, run_id=clean_run_id, include_slots=True)
        else:
            run = await self.run_store.find_unique_open_for_capability(
                user_id=user_id,
                capability_id=LOCATION_ONBOARDING_WORKFLOW_ID,
                include_slots=True,
            )
        if run is None:
            return None
        return await self._normalize_loaded_run(run=run, user_id=user_id)

    @staticmethod
    def _restart_scope(run: CapabilityRunV1) -> str:
        """Derive one bounded idempotency generation from an exact terminal row."""

        generation = hashlib.sha256(
            f"{run.run_id}:{run.revision}:{run.status}".encode("utf-8")
        ).hexdigest()
        return f"location-onboarding-v2-restart:{generation}"

    async def _create_v2_run(
        self,
        *,
        user_id: str,
        graph_revision: str,
        context_revision: str,
        idempotency_scope: str,
        slots: Mapping[str, Any] | None = None,
    ) -> CapabilityRunV1:
        return await self.run_store.create(
            user_id=user_id,
            capability_id=LOCATION_ONBOARDING_WORKFLOW_ID,
            capability_version=LOCATION_ONBOARDING_WORKFLOW_VERSION,
            graph_revision=graph_revision,
            slots=slots or {},
            context_revision=context_revision,
            expected_context_revision=context_revision,
            step_cursor=LOCATION_PREFLIGHT_STEP,
            status="interaction_required",
            idempotency_scope=idempotency_scope,
        )

    async def _has_verified_prior_completion(self, run: CapabilityRunV1) -> bool:
        """Re-read the exact immutable v2 settlement behind a status-only run.

        The encrypted slot is only a locator.  It grants no authority unless
        the owner-scoped source row is still the canonical Location workflow,
        is v2, ended at the completion cursor, retains its settlement proof,
        and matches the exact terminal revision captured when this view run
        was created.
        """

        slots = run.slots or {}
        source_run_id = str(slots.get("verified_prior_run_id") or "").strip()
        source_revision = slots.get("verified_prior_run_revision")
        if not _RUN_ID_RE.fullmatch(source_run_id) or not isinstance(source_revision, int):
            return False
        source = await self.run_store.get(
            user_id=run.user_id,
            run_id=source_run_id,
            include_slots=True,
        )
        if not (
            source is not None
            and source.run_id != run.run_id
            and source.user_id == run.user_id
            and source.revision == source_revision
        ):
            return False
        receipts = await self.ledger_store.list_receipts(
            user_id=source.user_id, run_id=source.run_id
        )
        return self._is_bound_verified_completion(source, receipts)

    @staticmethod
    def _is_bound_verified_completion(
        run: CapabilityRunV1,
        receipts: Mapping[str, LocationReceiptV1],
    ) -> bool:
        """Return true only for the complete v2 run/receipt settlement chain."""

        if not (
            run.capability_id == LOCATION_ONBOARDING_WORKFLOW_ID
            and run.capability_version == LOCATION_ONBOARDING_WORKFLOW_VERSION
            and run.status == "verified_succeeded"
            and run.step_cursor == LOCATION_COMPLETE_STEP
            and run.settlement_reference_hmac
        ):
            return False
        source_slots = run.slots or {}
        if source_slots.get("locationReceiptSchema") != LOCATION_ONBOARDING_RECEIPT_SCHEMA_VERSION:
            return False
        required = {"permission", "place", "circle", "completion"}
        if set(receipts) != required:
            return False
        expected_outcomes = {
            "permission": {"observed"},
            "place": {"saved", "skipped"},
            "circle": {"provisioned"},
            "completion": {"verified"},
        }
        return all(
            receipt.user_id == run.user_id
            and receipt.run_id == run.run_id
            and receipt.workflow_version == LOCATION_ONBOARDING_WORKFLOW_VERSION
            and receipt.outcome_code in expected_outcomes[kind]
            and source_slots.get(_RECEIPT_SLOT[kind]) == receipt.receipt_id
            for kind, receipt in receipts.items()
        )

    async def _restart_terminal_v2(
        self,
        *,
        run: CapabilityRunV1,
        graph_revision: str,
        context_revision: str,
    ) -> CapabilityRunV1:
        if run.status not in _RESTARTABLE_TERMINAL_STATUSES:
            return run
        # The prior generation cannot lend draft metadata or receipts to the
        # new task. Receipts are run-bound; draft metadata is also purged now
        # so recovery never mistakes it for current device authority.
        await self.ledger_store.purge_secure_draft(user_id=run.user_id, run_id=run.run_id)
        return await self._create_v2_run(
            user_id=run.user_id,
            graph_revision=graph_revision,
            context_revision=context_revision,
            idempotency_scope=self._restart_scope(run),
        )

    async def _restart_unmigratable_run(
        self,
        *,
        run: CapabilityRunV1,
        graph_revision: str,
        context_revision: str,
        reason: str,
    ) -> CapabilityRunV1:
        """Cancel stale pre-interaction state, then restart at verified preflight.

        A missing migration or an incompatible graph revision must never lend
        old slots, directives, drafts, or receipts to the new graph.  We only
        cancel statuses that cannot already be carrying a backend mutation;
        an executing/settling run remains a fail-closed conflict until its
        authoritative outcome is known.
        """

        if run.status not in _TERMINAL_STATUSES:
            if run.status not in _PRECHECK_RESTARTABLE_STATUSES:
                raise LocationOnboardingConflictError(
                    "Location workflow cannot restart while work is settling."
                )
            restart_material = f"{reason}:{run.run_id}:{run.revision}:{run.graph_revision}"
            await self.run_store.transition(
                user_id=run.user_id,
                run_id=run.run_id,
                expected_revision=run.revision,
                to_status="cancelled",
                step_cursor=LOCATION_PREFLIGHT_STEP,
                pending_interaction=None,
                pending_directive_id=None,
                slots={},
            )
            await self.ledger_store.purge_secure_draft(user_id=run.user_id, run_id=run.run_id)
        else:
            restart_material = f"{reason}:{run.run_id}:{run.revision}:{run.graph_revision}"
            await self.ledger_store.purge_secure_draft(user_id=run.user_id, run_id=run.run_id)
        return await self._create_v2_run(
            user_id=run.user_id,
            graph_revision=graph_revision,
            context_revision=context_revision,
            idempotency_scope=(
                "location-onboarding-v2-preflight-restart:"
                + hashlib.sha256(restart_material.encode("utf-8")).hexdigest()[:48]
            ),
        )

    async def _migrate_v1(
        self,
        *,
        run: CapabilityRunV1,
        graph_revision: str,
        context_revision: str,
    ) -> CapabilityRunV1:
        if run.capability_version != 1:
            return run
        if run.status in _TERMINAL_STATUSES:
            # Terminal v1 rows cannot be rewritten by the generic run store and
            # their old slots are not v2 provenance.  Start a clean preflight
            # run; the idempotency scope prevents duplicate restarts without
            # treating the legacy terminal claim as proof.
            return await self.run_store.create(
                user_id=run.user_id,
                capability_id=LOCATION_ONBOARDING_WORKFLOW_ID,
                capability_version=LOCATION_ONBOARDING_WORKFLOW_VERSION,
                graph_revision=graph_revision,
                slots={},
                context_revision=run.context_revision,
                expected_context_revision=run.expected_context_revision,
                step_cursor=LOCATION_PREFLIGHT_STEP,
                status="interaction_required",
                idempotency_scope=f"location-v2-restart:{run.run_id}",
            )
        legacy_cursor = str(run.step_cursor or "")
        cursor = LOCATION_V1_CURSOR_MIGRATIONS.get(legacy_cursor)
        if cursor is None:
            return await self._restart_unmigratable_run(
                run=run,
                graph_revision=graph_revision,
                context_revision=context_revision,
                reason="unknown_v1_cursor",
            )
        return await self.run_store.migrate_workflow_version(
            user_id=run.user_id,
            run_id=run.run_id,
            capability_id=LOCATION_ONBOARDING_WORKFLOW_ID,
            expected_revision=run.revision,
            expected_capability_version=1,
            target_capability_version=LOCATION_ONBOARDING_WORKFLOW_VERSION,
            target_graph_revision=graph_revision,
            step_cursor=cursor,
            status="interaction_required",
            pending_interaction=None,
            slots={},
        )

    async def start_or_resume(
        self,
        *,
        user_id: str,
        graph_revision: str,
        run_id: str | None = None,
        context_revision: str = "",
        full_guide_requested: bool = False,
        compatible_graph_revisions: Iterable[str] = (),
        migration_required_graph_revisions: Iterable[str] = (),
        rejected_graph_revisions: Iterable[str] = (),
    ) -> dict[str, Any]:
        owner = self._validate_owner(user_id)
        current_graph = self._validate_graph_revision(graph_revision)
        clean_context = str(context_revision or "").strip()[:192]
        if not _CONTEXT_REVISION_RE.fullmatch(clean_context):
            raise ValueError("Location context revision is invalid.")
        run = await self._load_run(user_id=owner, run_id=run_id)
        if run is None:
            latest = await self.run_store.find_latest_for_capability(
                user_id=owner,
                capability_id=LOCATION_ONBOARDING_WORKFLOW_ID,
                include_slots=True,
            )
            if (
                latest is not None
                and latest.capability_version == LOCATION_ONBOARDING_WORKFLOW_VERSION
                and latest.status == "verified_succeeded"
                and latest.step_cursor == LOCATION_COMPLETE_STEP
                and bool(latest.settlement_reference_hmac)
            ):
                # A later natural-language "set up Location" request still
                # needs a useful, server-issued answer. Keep the verified run
                # immutable and create one idempotent status-only generation;
                # the runtime can then offer the approved Open Location card
                # without replaying setup work. The encrypted source locator
                # is not itself authority: every advance re-reads the exact
                # immutable v2 row and its complete receipt chain.
                run = await self._create_v2_run(
                    user_id=owner,
                    graph_revision=current_graph,
                    context_revision=clean_context,
                    idempotency_scope=(
                        f"location-onboarding-v2-complete-view:{latest.run_id}:{latest.revision}"
                    ),
                    slots={
                        "verified_prior_run_id": latest.run_id,
                        "verified_prior_run_revision": latest.revision,
                    },
                )
            elif latest is not None:
                run = await self._normalize_loaded_run(run=latest, user_id=owner)
            else:
                run = await self._create_v2_run(
                    user_id=owner,
                    graph_revision=current_graph,
                    context_revision=clean_context,
                    idempotency_scope="location-onboarding-v2",
                )
        elif (
            run.capability_version == LOCATION_ONBOARDING_WORKFLOW_VERSION
            and run.status in _RESTARTABLE_TERMINAL_STATUSES
        ):
            # A device may retry an older terminal run id after a later restart
            # has already opened or settled. Converge on the newest generation
            # before deriving another restart scope so stale clients cannot
            # recreate a prior terminal row forever.
            latest = await self.run_store.find_latest_for_capability(
                user_id=owner,
                capability_id=LOCATION_ONBOARDING_WORKFLOW_ID,
                include_slots=True,
            )
            if latest is not None:
                run = await self._normalize_loaded_run(run=latest, user_id=owner)
        if run.capability_version == 1:
            run = await self._migrate_v1(
                run=run,
                graph_revision=current_graph,
                context_revision=clean_context,
            )
        elif run.capability_version != LOCATION_ONBOARDING_WORKFLOW_VERSION:
            raise LocationOnboardingAuthorityError("Location workflow version is unsupported.")
        elif run.status in _RESTARTABLE_TERMINAL_STATUSES:
            run = await self._restart_terminal_v2(
                run=run,
                graph_revision=current_graph,
                context_revision=clean_context,
            )
        elif not run.is_terminal:
            try:
                self._assert_run_graph_compatible(
                    run=run,
                    current_graph_revision=current_graph,
                    compatible_graph_revisions=compatible_graph_revisions,
                    migration_required_graph_revisions=(migration_required_graph_revisions),
                    rejected_graph_revisions=rejected_graph_revisions,
                )
            except LocationOnboardingMigrationRequiredError:
                run = await self._restart_unmigratable_run(
                    run=run,
                    graph_revision=current_graph,
                    context_revision=clean_context,
                    reason="graph_migration_required",
                )
            except LocationOnboardingConflictError as exc:
                # A declared rejected revision is not allowed to resume into
                # this graph. It may only start a clean preflight generation;
                # malformed compatibility policy itself remains fail-closed.
                if str(exc) != "Location workflow revision is not compatible with this release.":
                    raise
                run = await self._restart_unmigratable_run(
                    run=run,
                    graph_revision=current_graph,
                    context_revision=clean_context,
                    reason="graph_revision_rejected",
                )

        run, waiting_reason = await self._drive_automatic_steps(
            run, full_guide_requested=full_guide_requested
        )
        run, lease = await self._ensure_interaction(run)
        return await self._projection(run, lease=lease, waiting_reason=waiting_reason)

    async def get(
        self,
        *,
        user_id: str,
        run_id: str,
        graph_revision: str,
        compatible_graph_revisions: Iterable[str] = (),
        migration_required_graph_revisions: Iterable[str] = (),
        rejected_graph_revisions: Iterable[str] = (),
    ) -> dict[str, Any]:
        owner = self._validate_owner(user_id)
        current_graph = self._validate_graph_revision(graph_revision)
        run = await self._load_run(user_id=owner, run_id=run_id)
        if run is None:
            raise LocationOnboardingAuthorityError("Location onboarding run was not found.")
        if run.capability_version != LOCATION_ONBOARDING_WORKFLOW_VERSION:
            raise LocationOnboardingConflictError(
                "Location workflow must be resumed before reading this version."
            )
        if not run.is_terminal:
            self._assert_run_graph_compatible(
                run=run,
                current_graph_revision=current_graph,
                compatible_graph_revisions=compatible_graph_revisions,
                migration_required_graph_revisions=migration_required_graph_revisions,
                rejected_graph_revisions=rejected_graph_revisions,
            )
        if run.step_cursor not in _CANONICAL_LOCATION_CURSORS:
            raise LocationOnboardingAuthorityError("Location workflow cursor is invalid.")
        waiting_reason = "paused" if run.status == "paused" else None
        # RPC v5 advances the run and mints the place receipt in the same
        # transaction as the encrypted PKM mutation.  An exact GET then drives
        # only that proven automatic tail (completion marker + final settlement)
        # instead of requiring a second, now-stale `place_saved` interaction.
        if (
            run.status == "interaction_required"
            and run.step_cursor == LOCATION_COMPLETE_STEP
            and run.pending_directive_id is None
        ):
            receipts = await self.ledger_store.list_receipts(user_id=run.user_id, run_id=run.run_id)
            if {"permission", "place", "circle"}.issubset(receipts):
                run, waiting_reason = await self._drive_automatic_steps(run)
        run, lease = await self._ensure_interaction(run)
        return await self._projection(run, lease=lease, waiting_reason=waiting_reason)

    async def find_active(
        self,
        *,
        user_id: str,
        graph_revision: str,
        compatible_graph_revisions: Iterable[str] = (),
        migration_required_graph_revisions: Iterable[str] = (),
        rejected_graph_revisions: Iterable[str] = (),
    ) -> dict[str, Any] | None:
        """Recover the owner's unique open run without invoking adapters.

        This narrow recovery lookup is intentionally different from
        ``start_or_resume``: absence is a valid result and no automatic
        workflow adapter is invoked. An open v1 run is migrated through the
        checked-in cursor map here so app relaunch cannot strand it. A present
        v2 run still goes through ``get`` so graph admission and directive
        leasing use the same authority checks as an exact run read.
        """

        owner = self._validate_owner(user_id)
        current_graph = self._validate_graph_revision(graph_revision)
        run = await self._load_run(user_id=owner, run_id=None)
        if run is None or run.is_terminal:
            return None
        if run.capability_version == 1:
            run = await self._migrate_v1(
                run=run,
                graph_revision=current_graph,
                context_revision=run.context_revision,
            )
        elif run.capability_version != LOCATION_ONBOARDING_WORKFLOW_VERSION:
            raise LocationOnboardingConflictError("Location workflow version is unsupported.")
        return await self.get(
            user_id=owner,
            run_id=run.run_id,
            graph_revision=current_graph,
            compatible_graph_revisions=compatible_graph_revisions,
            migration_required_graph_revisions=migration_required_graph_revisions,
            rejected_graph_revisions=rejected_graph_revisions,
        )

    async def cancel(self, *, user_id: str, run_id: str, expected_revision: int) -> dict[str, Any]:
        """Cancel one owner-bound run and purge any pre-vault draft metadata."""

        owner = self._validate_owner(user_id)
        run = await self._load_run(user_id=owner, run_id=run_id)
        if run is None:
            raise LocationOnboardingAuthorityError("Location onboarding run was not found.")
        if run.status == "cancelled":
            await self.ledger_store.purge_secure_draft(user_id=owner, run_id=run.run_id)
            return await self._projection(run, lease=None, waiting_reason="run_cancelled")
        if run.status in _TERMINAL_STATUSES:
            raise LocationOnboardingConflictError("Location onboarding run is already terminal.")
        if run.revision != expected_revision:
            raise LocationOnboardingConflictError("Location run changed; reload before cancelling.")
        run = await self.run_store.transition(
            user_id=owner,
            run_id=run.run_id,
            expected_revision=run.revision,
            to_status="cancelled",
            pending_interaction=None,
            pending_directive_id=None,
        )
        await self.ledger_store.purge_secure_draft(user_id=owner, run_id=run.run_id)
        return await self._projection(run, lease=None, waiting_reason="run_cancelled")

    async def purge_for_sign_out(self, *, user_id: str) -> int:
        """Authenticated sign-out hook for device-draft metadata."""

        return await self.ledger_store.purge_owner_drafts(user_id=self._validate_owner(user_id))

    async def purge_expired_drafts(self) -> int:
        """Scheduler hook that removes bounded expired draft metadata."""

        return await self.ledger_store.purge_expired_drafts()

    async def settle_interaction(
        self,
        *,
        user_id: str,
        run_id: str,
        directive_id: str,
        lease_id: str,
        expected_revision: int,
        graph_revision: str,
        action: LocationInteractionAction,
        draft_metadata: Mapping[str, Any] | None = None,
        compatible_graph_revisions: Iterable[str] = (),
        migration_required_graph_revisions: Iterable[str] = (),
        rejected_graph_revisions: Iterable[str] = (),
        position_observation: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        owner = self._validate_owner(user_id)
        current_graph = self._validate_graph_revision(graph_revision)
        run = await self._load_run(user_id=owner, run_id=run_id)
        if run is None or run.capability_version != LOCATION_ONBOARDING_WORKFLOW_VERSION:
            raise LocationOnboardingAuthorityError("Location onboarding run was not found.")
        self._assert_run_graph_compatible(
            run=run,
            current_graph_revision=current_graph,
            compatible_graph_revisions=compatible_graph_revisions,
            migration_required_graph_revisions=migration_required_graph_revisions,
            rejected_graph_revisions=rejected_graph_revisions,
        )
        if run.revision != expected_revision:
            raise LocationOnboardingConflictError("Location run changed; reload before continuing.")
        if not _LEASE_ID_RE.fullmatch(str(lease_id or "").strip()):
            raise LocationOnboardingConflictError("Location interaction lease is invalid.")
        if not _DIRECTIVE_ID_RE.fullmatch(str(directive_id or "").strip()):
            raise LocationOnboardingConflictError("Location interaction directive is invalid.")
        lease = await self.ledger_store.get_lease(
            user_id=owner, run_id=run.run_id, lease_id=lease_id
        )
        if lease is None:
            raise LocationOnboardingConflictError("Location interaction lease is unavailable.")
        contract = _SURFACE_CONTRACTS.get(lease.surface_id)
        expected_actions_digest = (
            self.ledger_store.digest(
                "location_allowed_actions", {"actions": list(contract.allowed_actions)}
            )
            if contract is not None
            else ""
        )
        if (
            lease.consumed_at is not None
            or lease.expires_at <= datetime.now(UTC)
            or lease.run_revision != run.revision
            or lease.step_cursor != run.step_cursor
            or lease.context_revision != run.context_revision
            or lease.directive_id != directive_id
            or run.pending_directive_id != directive_id
            or contract is None
            or not hmac.compare_digest(lease.allowed_actions_digest, expected_actions_digest)
        ):
            raise LocationOnboardingConflictError("Location interaction lease is stale or invalid.")
        if contract is None or action not in contract.allowed_actions:
            raise LocationOnboardingConflictError("Action is not allowed at this Location step.")
        if draft_metadata is not None and action != "vault_unavailable":
            raise ValueError("Draft metadata is accepted only while waiting for a vault.")
        if action == "vault_unavailable" and draft_metadata is None:
            raise ValueError("Secure Location draft metadata is required.")
        if action != "position_captured" and position_observation is not None:
            raise ValueError("Position observations are accepted only for a captured position.")
        if action == "position_captured" and position_observation is None:
            raise ValueError("A fresh Location position observation is required.")

        clean_position_observation: dict[str, str] | None = None
        if position_observation is not None:
            expected_keys = {
                "schemaVersion",
                "permissionStatus",
                "capturedAt",
                "sourcePlatform",
            }
            if set(position_observation) != expected_keys:
                raise ValueError("Location position observation is invalid.")
            captured_at = _parse_datetime(position_observation.get("capturedAt"))
            now = datetime.now(UTC)
            if (
                position_observation.get("schemaVersion") != _POSITION_OBSERVATION_SCHEMA
                or position_observation.get("permissionStatus") != "granted"
                or position_observation.get("sourcePlatform")
                not in {"web", "ios", "android", "native"}
                or captured_at is None
                or captured_at < now - timedelta(seconds=_POSITION_CAPTURE_MAX_AGE_SECONDS)
                or captured_at > now + timedelta(seconds=_POSITION_CAPTURE_MAX_FUTURE_SKEW_SECONDS)
            ):
                raise ValueError("Location position observation is stale or invalid.")
            clean_position_observation = {
                "schema_version": _POSITION_OBSERVATION_SCHEMA,
                "permission_status": "granted",
                "captured_at": captured_at.isoformat(),
                "source_platform": str(position_observation.get("sourcePlatform")),
            }

        receipt_kind: LocationReceiptKind | None = None
        receipt_outcome: LocationReceiptOutcome | None = None
        receipt_issuer: str | None = None
        receipt_digest: str | None = None
        if action == "resume":
            if (
                lease.surface_id != "one.location.paused.v2"
                or lease.resume_surface_id not in _SURFACE_CONTRACTS
                or lease.resume_surface_id == "one.location.paused.v2"
            ):
                raise LocationOnboardingConflictError(
                    "Paused Location interaction has no valid resume target."
                )
            next_cursor: LocationCursor = run.step_cursor  # type: ignore[assignment]
            next_status: Literal["interaction_required", "needs_input", "paused"] = (
                "interaction_required"
            )
            next_surface_id = lease.resume_surface_id
        else:
            next_cursor, next_status, next_surface_id = self._transition_for(
                run.step_cursor, lease.surface_id, action
            )

        if action == "position_captured":
            if clean_position_observation is None:  # pragma: no cover - validated above
                raise LocationOnboardingAuthorityError(
                    "Location position observation is unavailable."
                )
            receipt_kind = "permission"
            receipt_outcome = "observed"
            receipt_issuer = "interaction_chain"
            receipt_digest = self.ledger_store.digest(
                "location_permission_position_observation",
                {
                    "run_id": run.run_id,
                    "permission_step": LOCATION_PERMISSION_STEP,
                    "position_step": run.step_cursor,
                    **clean_position_observation,
                },
            )
        elif action == "skip_place":
            receipt_kind = "place"
            receipt_outcome = "skipped"
            receipt_issuer = "owner_interaction"
            receipt_digest = self.ledger_store.digest(
                "location_place_skip", {"run_id": run.run_id, "lease_id": lease.lease_id}
            )
        elif action == "vault_unavailable":
            metadata = dict(draft_metadata or {})
            if set(metadata) != {
                "schemaVersion",
                "digest",
                "status",
                "expiresAt",
                "runId",
                "revision",
            }:
                raise ValueError("Secure Location draft metadata is malformed.")
            if metadata.get("schemaVersion") != "one.location.pre_vault.draft_metadata.v1":
                raise ValueError("Secure Location draft metadata version is unsupported.")
            expires_at = _parse_datetime(metadata.get("expiresAt"))
            if expires_at is None:
                raise ValueError("Secure Location draft metadata expiry is invalid.")
            await self.ledger_store.record_secure_draft(
                run=run,
                client_run_id=str(metadata.get("runId") or ""),
                client_revision=int(metadata.get("revision") or 0),
                digest=str(metadata.get("digest") or ""),
                status=str(metadata.get("status") or ""),
                expires_at=expires_at,
            )

        run = await self.ledger_store.consume_and_move(
            run=run,
            lease=lease,
            action=action,
            next_cursor=next_cursor,
            next_status=next_status,
            next_surface_id=next_surface_id,
            purge_draft=(
                action == "draft_unavailable"
                or (
                    action == "skip_place"
                    and lease.surface_id == "one.location.awaiting_vault_finalize.v2"
                )
            ),
            receipt_kind=receipt_kind,
            receipt_outcome=receipt_outcome,
            receipt_issuer=receipt_issuer,
            receipt_evidence_digest=receipt_digest,
        )
        run, waiting_reason = await self._drive_automatic_steps(run)
        run, next_lease = await self._ensure_interaction(run)
        return await self._projection(run, lease=next_lease, waiting_reason=waiting_reason)

    def _transition_for(
        self,
        cursor: str,
        surface_id: str,
        action: LocationInteractionAction,
    ) -> tuple[
        LocationCursor,
        Literal["interaction_required", "needs_input", "paused"],
        str | None,
    ]:
        if action == "pause":
            if resolve_location_transition_target(cursor, action) != "$paused":
                raise LocationOnboardingAuthorityError(
                    "Location pause transition does not match the compiled workflow."
                )
            return cursor, "paused", surface_id  # type: ignore[return-value]
        # These entries own only approved presentation behavior for a
        # cursor/surface/action triple.  They deliberately do not name a
        # destination cursor: the package-compiled graph is the sole source
        # of workflow transition semantics.
        presentations: Mapping[
            tuple[str, str, str],
            tuple[Literal["interaction_required", "needs_input", "paused"], str | None],
        ] = {
            (
                LOCATION_INTRODUCTION_STEP,
                "one.location.introduction.v2",
                "continue",
            ): (
                "interaction_required",
                "one.location.permission_offer.v2",
            ),
            (
                LOCATION_PERMISSION_STEP,
                "one.location.permission_offer.v2",
                "request_permission",
            ): (
                "interaction_required",
                "one.location.permission_result.v2",
            ),
            (
                LOCATION_PERMISSION_STEP,
                "one.location.permission_result.v2",
                "permission_granted",
            ): ("interaction_required", "one.location.position_pending.v2"),
            (
                LOCATION_PERMISSION_STEP,
                "one.location.permission_result.v2",
                "permission_denied",
            ): (
                "interaction_required",
                "one.location.settings_return.v2",
            ),
            (
                LOCATION_PERMISSION_STEP,
                "one.location.permission_result.v2",
                "permission_restricted",
            ): (
                "interaction_required",
                "one.location.settings_return.v2",
            ),
            (
                LOCATION_PERMISSION_STEP,
                "one.location.permission_result.v2",
                "services_disabled",
            ): (
                "interaction_required",
                "one.location.settings_return.v2",
            ),
            (
                LOCATION_PERMISSION_STEP,
                "one.location.permission_result.v2",
                "retry_permission",
            ): (
                "interaction_required",
                "one.location.permission_result.v2",
            ),
            (
                LOCATION_PERMISSION_STEP,
                "one.location.settings_return.v2",
                "open_settings",
            ): (
                "interaction_required",
                "one.location.settings_return.v2",
            ),
            (
                LOCATION_PERMISSION_STEP,
                "one.location.settings_return.v2",
                "settings_returned",
            ): (
                "interaction_required",
                "one.location.permission_result.v2",
            ),
            (
                LOCATION_PERMISSION_STEP,
                "one.location.settings_return.v2",
                "retry_permission",
            ): (
                "interaction_required",
                "one.location.permission_result.v2",
            ),
            (
                LOCATION_POSITION_STEP,
                "one.location.position_pending.v2",
                "position_captured",
            ): ("interaction_required", "one.location.place_choice.v2"),
            (
                LOCATION_POSITION_STEP,
                "one.location.position_pending.v2",
                "position_unavailable",
            ): ("paused", "one.location.position_retry.v2"),
            (
                LOCATION_POSITION_STEP,
                "one.location.position_retry.v2",
                "retry_position",
            ): ("interaction_required", "one.location.position_pending.v2"),
            (
                LOCATION_PLACE_STEP,
                "one.location.place_choice.v2",
                "save_place",
            ): ("interaction_required", "one.location.place_persisting.v2"),
            (
                LOCATION_PLACE_STEP,
                "one.location.place_choice.v2",
                "skip_place",
            ): ("interaction_required", None),
            (
                LOCATION_PLACE_STEP,
                "one.location.place_persisting.v2",
                "vault_unavailable",
            ): ("interaction_required", None),
            (
                LOCATION_PLACE_STEP,
                "one.location.place_persisting.v2",
                "skip_place",
            ): ("interaction_required", None),
            (
                LOCATION_COMPLETE_STEP,
                "one.location.awaiting_vault_finalize.v2",
                "skip_place",
            ): ("interaction_required", None),
            (
                LOCATION_COMPLETE_STEP,
                "one.location.awaiting_vault_finalize.v2",
                "draft_unavailable",
            ): ("interaction_required", "one.location.position_pending.v2"),
            (
                LOCATION_CIRCLE_STEP,
                "one.location.circle_retry.v2",
                "retry_circle",
            ): ("interaction_required", None),
            (
                LOCATION_COMPLETE_STEP,
                "one.location.completion_retry.v2",
                "retry_completion",
            ): ("interaction_required", None),
            (
                LOCATION_PREFLIGHT_STEP,
                "one.location.already_complete.v2",
                "open_location",
            ): ("paused", "one.location.already_complete.v2"),
        }
        presentation = presentations.get((cursor, surface_id, action))
        if presentation is None:
            raise LocationOnboardingConflictError("Location workflow transition is invalid.")
        next_status, next_surface_id = presentation
        target = resolve_location_transition_target(cursor, action)
        if target == "$paused":
            if next_status != "paused":
                raise LocationOnboardingAuthorityError(
                    "Location interaction presentation does not match the compiled workflow."
                )
            return cursor, next_status, next_surface_id  # type: ignore[return-value]
        if target == "$verified_succeeded" or target not in _CANONICAL_LOCATION_CURSORS:
            raise LocationOnboardingAuthorityError(
                "Location interaction cannot settle a terminal workflow transition."
            )
        if next_status == "paused":
            raise LocationOnboardingAuthorityError(
                "Location interaction presentation does not match the compiled workflow."
            )
        return target, next_status, next_surface_id  # type: ignore[return-value]

    async def _drive_automatic_steps(
        self,
        run: CapabilityRunV1,
        *,
        full_guide_requested: bool = False,
    ) -> tuple[CapabilityRunV1, str | None]:
        current = run
        for _ in range(8):
            if current.status == "verified_succeeded":
                return current, None
            if current.status in {"authorized", "executing", "settlement_received"}:
                current = await self._finalize(current)
                continue
            if current.status in _TERMINAL_STATUSES:
                return current, "run_terminal"
            if current.status == "paused":
                return current, "paused"
            if current.step_cursor == LOCATION_PREFLIGHT_STEP:
                receipts = await self.ledger_store.list_receipts(
                    user_id=current.user_id, run_id=current.run_id
                )
                draft = await self.ledger_store.get_active_secure_draft(
                    user_id=current.user_id, run_id=current.run_id
                )
                if {"permission", "place", "circle", "completion"}.issubset(receipts):
                    current = await self._finalize(current)
                    continue
                if "permission" in receipts and ("place" in receipts or draft is not None):
                    next_cursor = (
                        LOCATION_COMPLETE_STEP if "circle" in receipts else LOCATION_CIRCLE_STEP
                    )
                    current = await self.ledger_store.move_run(
                        run=current,
                        next_cursor=next_cursor,
                    )
                    continue
                if "permission" in receipts:
                    current = await self.ledger_store.move_run(
                        run=current,
                        next_cursor=LOCATION_PLACE_STEP,
                        next_surface_id="one.location.place_choice.v2",
                    )
                    continue
                if await self._has_verified_prior_completion(current):
                    if (
                        resolve_location_transition_target(
                            LOCATION_PREFLIGHT_STEP, "already_complete"
                        )
                        != LOCATION_PREFLIGHT_STEP
                    ):
                        raise LocationOnboardingAuthorityError(
                            "Location completed-state transition is invalid."
                        )
                    if current.pending_interaction != "one.location.already_complete.v2":
                        current = await self.ledger_store.move_run(
                            run=current,
                            next_cursor=LOCATION_PREFLIGHT_STEP,
                            next_surface_id="one.location.already_complete.v2",
                        )
                    return current, "already_complete"
                preflight = await self.preflight_port.resolve_state(user_id=current.user_id)
                if preflight.status == "state_unavailable":
                    if (
                        resolve_location_transition_target(
                            LOCATION_PREFLIGHT_STEP, "state_unavailable"
                        )
                        != "$paused"
                    ):
                        raise LocationOnboardingAuthorityError(
                            "Location preflight recovery transition is invalid."
                        )
                    current = await self.ledger_store.move_run(
                        run=current,
                        next_cursor=LOCATION_PREFLIGHT_STEP,
                        next_status="paused",
                        # This is a hidden resume trampoline, not a rendered
                        # permission directive. Resuming re-runs preflight
                        # before the permission cursor can be reached.
                        next_surface_id="one.location.permission_offer.v2",
                    )
                    return current, preflight.reason_code
                # A legacy adapter result is intentionally non-authorizing.
                # Only the exact verified v2 source-run check above can render
                # the already-complete directive.  Otherwise continue through
                # preflight and require fresh permission/position evidence.
                # Adopt only backend-verifiable state into this run.  These
                # receipts carry HMAC proofs, not the place/Circle values used
                # to derive them. Current device permission is never adopted;
                # it must still be observed with a fresh position below.
                if "place" not in receipts and preflight.saved_place_evidence_digest is not None:
                    await self.ledger_store.mint_server_receipt(
                        run=current,
                        receipt_kind="place",
                        outcome_code="saved",
                        issuer="preflight_state_resolver",
                        evidence_digest=preflight.saved_place_evidence_digest,
                    )
                if "circle" not in receipts and preflight.circle_evidence_digest is not None:
                    await self.ledger_store.mint_server_receipt(
                        run=current,
                        receipt_kind="circle",
                        outcome_code="provisioned",
                        issuer="preflight_state_resolver",
                        evidence_digest=preflight.circle_evidence_digest,
                    )
                preflight_outcome = (
                    "full_guide_requested" if full_guide_requested else "needs_onboarding"
                )
                target = resolve_location_transition_target(
                    LOCATION_PREFLIGHT_STEP, preflight_outcome
                )
                if target not in _CANONICAL_LOCATION_CURSORS:
                    raise LocationOnboardingAuthorityError(
                        "Location preflight target is not executable."
                    )
                next_cursor: LocationCursor = target  # type: ignore[assignment]
                current = await self.ledger_store.move_run(
                    run=current,
                    next_cursor=next_cursor,
                    next_surface_id=_DEFAULT_SURFACE_BY_CURSOR[next_cursor],
                )
                continue
            if current.step_cursor == LOCATION_PLACE_STEP:
                receipts = await self.ledger_store.list_receipts(
                    user_id=current.user_id, run_id=current.run_id
                )
                if "place" in receipts:
                    current = await self.ledger_store.move_run(
                        run=current,
                        next_cursor=(
                            LOCATION_COMPLETE_STEP if "circle" in receipts else LOCATION_CIRCLE_STEP
                        ),
                    )
                    continue
                return current, None
            if current.step_cursor == LOCATION_CIRCLE_STEP:
                if current.pending_interaction == "one.location.circle_retry.v2":
                    return current, "circle_retry_required"
                receipts = await self.ledger_store.list_receipts(
                    user_id=current.user_id, run_id=current.run_id
                )
                if "circle" not in receipts:
                    result = await self.circle_port.provision_personal_circle(
                        user_id=current.user_id, run_id=current.run_id
                    )
                    if result.status != "verified" or not result.evidence_digest:
                        if (
                            resolve_location_transition_target(LOCATION_CIRCLE_STEP, "failed")
                            != LOCATION_CIRCLE_STEP
                        ):
                            raise LocationOnboardingAuthorityError(
                                "Location Circle failure transition is invalid."
                            )
                        return current, result.reason_code
                    await self.ledger_store.mint_server_receipt(
                        run=current,
                        receipt_kind="circle",
                        outcome_code="provisioned",
                        issuer="circle_adapter",
                        evidence_digest=result.evidence_digest,
                    )
                target = resolve_location_transition_target(LOCATION_CIRCLE_STEP, "provisioned")
                if target not in _CANONICAL_LOCATION_CURSORS:
                    raise LocationOnboardingAuthorityError(
                        "Location Circle settlement target is not executable."
                    )
                current = await self.ledger_store.move_run(
                    run=current,
                    next_cursor=target,  # type: ignore[arg-type]
                )
                continue
            if current.step_cursor == LOCATION_COMPLETE_STEP:
                if current.pending_interaction == "one.location.completion_retry.v2":
                    return current, "completion_retry_required"
                receipts = await self.ledger_store.list_receipts(
                    user_id=current.user_id, run_id=current.run_id
                )
                if "place" not in receipts:
                    draft = await self.ledger_store.get_active_secure_draft(
                        user_id=current.user_id, run_id=current.run_id
                    )
                    if draft is not None:
                        return current, "awaiting_vault_finalize"
                    return current, "required_receipt_missing"
                if receipts["place"].outcome_code == "saved":
                    await self.ledger_store.purge_secure_draft(
                        user_id=current.user_id, run_id=current.run_id
                    )
                    if (
                        await self.ledger_store.get_active_secure_draft(
                            user_id=current.user_id, run_id=current.run_id
                        )
                        is not None
                    ):
                        return current, "draft_purge_pending"
                if not {"permission", "circle"}.issubset(receipts):
                    return current, "required_receipt_missing"
                if "completion" not in receipts:
                    result = await self.completion_port.ensure_completion_marker(
                        user_id=current.user_id, run_id=current.run_id
                    )
                    if result.status != "verified" or not result.evidence_digest:
                        if (
                            resolve_location_transition_target(LOCATION_COMPLETE_STEP, "failed")
                            != LOCATION_COMPLETE_STEP
                        ):
                            raise LocationOnboardingAuthorityError(
                                "Location completion failure transition is invalid."
                            )
                        return current, result.reason_code
                    await self.ledger_store.mint_server_receipt(
                        run=current,
                        receipt_kind="completion",
                        outcome_code="verified",
                        issuer="completion_adapter",
                        evidence_digest=result.evidence_digest,
                    )
                if (
                    resolve_location_transition_target(LOCATION_COMPLETE_STEP, "verified")
                    != "$verified_succeeded"
                ):
                    raise LocationOnboardingAuthorityError(
                        "Location completion settlement transition is invalid."
                    )
                current = await self._finalize(current)
                continue
            return current, None
        return current, "automatic_progress_budget_exhausted"

    async def _finalize(self, run: CapabilityRunV1) -> CapabilityRunV1:
        receipts = await self.ledger_store.list_receipts(user_id=run.user_id, run_id=run.run_id)
        required = {"permission", "place", "circle", "completion"}
        if set(receipts) != required:
            raise LocationOnboardingAuthorityError("Location receipt chain is incomplete.")
        slots = {"locationReceiptSchema": LOCATION_ONBOARDING_RECEIPT_SCHEMA_VERSION}
        for kind in sorted(required):
            receipt = receipts[kind]  # type: ignore[index]
            if (
                receipt.user_id != run.user_id
                or receipt.run_id != run.run_id
                or receipt.workflow_version != LOCATION_ONBOARDING_WORKFLOW_VERSION
            ):
                raise LocationOnboardingAuthorityError("Location receipt binding is invalid.")
            slots[_RECEIPT_SLOT[kind]] = receipt.receipt_id

        current = run
        if current.status in {"interaction_required", "needs_input", "paused"}:
            current = await self.run_store.transition(
                user_id=current.user_id,
                run_id=current.run_id,
                expected_revision=current.revision,
                to_status="authorized",
                step_cursor=LOCATION_COMPLETE_STEP,
                pending_interaction=None,
                pending_directive_id=None,
                slots=slots,
            )
        if current.status == "authorized":
            current = await self.run_store.transition(
                user_id=current.user_id,
                run_id=current.run_id,
                expected_revision=current.revision,
                to_status="executing",
                step_cursor=LOCATION_COMPLETE_STEP,
            )
        if current.status == "executing":
            current = await self.run_store.transition(
                user_id=current.user_id,
                run_id=current.run_id,
                expected_revision=current.revision,
                to_status="settlement_received",
                step_cursor=LOCATION_COMPLETE_STEP,
                settlement_reference="workflow.setup.location:v2:opaque-receipt-ledger",
            )
        if current.status == "settlement_received":
            current = await self.run_store.transition(
                user_id=current.user_id,
                run_id=current.run_id,
                expected_revision=current.revision,
                to_status="verified_succeeded",
                step_cursor=LOCATION_COMPLETE_STEP,
            )
        if current.status != "verified_succeeded":
            raise LocationOnboardingAuthorityError("Location completion could not be verified.")
        try:
            await self.ledger_store.purge_secure_draft(
                user_id=current.user_id, run_id=current.run_id
            )
            await self.ledger_store.consume_receipts(user_id=current.user_id, run_id=current.run_id)
        except Exception:  # noqa: BLE001 - receipts remain run-bound and cannot authorize another run
            logger.info("location_onboarding_receipt_consumption_pending")
        return current

    async def _ensure_interaction(
        self, run: CapabilityRunV1
    ) -> tuple[CapabilityRunV1, LocationInteractionLeaseV1 | None]:
        if run.status in _TERMINAL_STATUSES or run.status in {
            "authorized",
            "executing",
            "settlement_received",
        }:
            return run, None
        if run.status == "paused":
            resume_surface_id = run.pending_interaction
            if (
                resume_surface_id not in _SURFACE_CONTRACTS
                or resume_surface_id == "one.location.paused.v2"
            ):
                raise LocationOnboardingAuthorityError(
                    "Paused Location run has no registered resume target."
                )
            return await self.ledger_store.issue_lease(
                run=run,
                contract=_SURFACE_CONTRACTS["one.location.paused.v2"],
                resume_surface_id=resume_surface_id,
            )
        surface_id = run.pending_interaction or _DEFAULT_SURFACE_BY_CURSOR.get(run.step_cursor)
        if run.step_cursor == LOCATION_COMPLETE_STEP:
            receipts = await self.ledger_store.list_receipts(user_id=run.user_id, run_id=run.run_id)
            # Missing, expired, or locally unreadable encrypted draft state all
            # use the same approved server surface. `draft_unavailable` then
            # purges any remaining metadata and returns to a real GPS capture;
            # the client never invents a fallback card or plaintext payload.
            if "place" not in receipts:
                surface_id = "one.location.awaiting_vault_finalize.v2"
        contract = _SURFACE_CONTRACTS.get(surface_id or "")
        if contract is None:
            return run, None
        return await self.ledger_store.issue_lease(run=run, contract=contract)

    async def _projection(
        self,
        run: CapabilityRunV1,
        *,
        lease: LocationInteractionLeaseV1 | None,
        waiting_reason: str | None,
    ) -> dict[str, Any]:
        receipts = await self.ledger_store.list_receipts(user_id=run.user_id, run_id=run.run_id)
        draft = await self.ledger_store.get_active_secure_draft(
            user_id=run.user_id, run_id=run.run_id
        )
        interaction: dict[str, Any] | None = None
        finalize_authorization: dict[str, Any] | None = None
        contract = _SURFACE_CONTRACTS.get(lease.surface_id) if lease is not None else None
        if lease is not None and contract is not None:
            interaction = {
                "lease_id": lease.lease_id,
                "directive_id": lease.directive_id,
                "run_revision": lease.run_revision,
                "kind": LOCATION_DIRECTIVE_KIND_BY_SURFACE[contract.surface_id],
                "surface_id": contract.surface_id,
                "title_key": contract.title_key,
                "body_key": contract.body_key,
                "allowed_actions": list(contract.allowed_actions),
                "expires_at": lease.expires_at.isoformat(),
            }
            if (
                contract.surface_id == "one.location.awaiting_vault_finalize.v2"
                and draft is not None
            ):
                authority = await self.ledger_store.issue_pkm_finalize_authorization(
                    run=run,
                    lease=lease,
                    draft=draft,
                )
                finalize_authorization = {
                    "schema_version": "one.location_pkm_finalize_authorization.v1",
                    "authorization_id": authority.authorization_id,
                    "token": authority.token,
                    "run_id": authority.run_id,
                    "run_revision": authority.run_revision,
                    "lease_id": authority.lease_id,
                    "directive_id": authority.directive_id,
                    "draft_ref": authority.draft_id,
                    "draft_digest": authority.draft_digest,
                    "expected_commit_id": authority.expected_commit_id,
                    "expires_at": authority.expires_at.isoformat(),
                }
        completion_claim_allowed = self._is_bound_verified_completion(run, receipts)
        return {
            "schema_version": LOCATION_ONBOARDING_SCHEMA_VERSION,
            "workflow_id": LOCATION_ONBOARDING_WORKFLOW_ID,
            "workflow_version": run.capability_version,
            "graph_revision": run.graph_revision,
            "run_id": run.run_id,
            "status": run.status,
            "step": run.step_cursor,
            "revision": run.revision,
            "completion_claim_allowed": completion_claim_allowed,
            "evidence": {
                "permission": "permission" in receipts,
                "place": "place" in receipts,
                "circle": "circle" in receipts,
                "completion": "completion" in receipts,
            },
            "draft": (
                {
                    "draft_ref": draft.draft_id,
                    "status": draft.status,
                    "expires_at": draft.expires_at.isoformat(),
                }
                if draft is not None
                else None
            ),
            "pkm_finalize_authorization": finalize_authorization,
            "interaction": interaction,
            "waiting_reason": _safe_reason(waiting_reason) if waiting_reason else None,
        }


_service: LocationOnboardingRuntimeService | None = None


def get_location_onboarding_runtime_service() -> LocationOnboardingRuntimeService:
    global _service
    if _service is None:
        _service = LocationOnboardingRuntimeService()
    return _service


__all__ = [
    "LOCATION_APPROVED_SURFACE_CONTRACTS",
    "LOCATION_CURSOR_MIGRATIONS_BY_FROM_VERSION",
    "LOCATION_DIRECTIVE_KIND_BY_SURFACE",
    "LOCATION_ONBOARDING_RECEIPT_SCHEMA_VERSION",
    "LOCATION_ONBOARDING_SCHEMA_VERSION",
    "LOCATION_ONBOARDING_WORKFLOW_ID",
    "LOCATION_ONBOARDING_WORKFLOW_VERSION",
    "LOCATION_V1_CURSOR_MIGRATIONS",
    "LocationAdapterResult",
    "LocationCircleProvisioningPort",
    "LocationCompletionPort",
    "LocationInteractionAction",
    "LocationInteractionLeaseV1",
    "LocationPkmFinalizeAuthorizationV1",
    "LocationOnboardingAuthorityError",
    "LocationOnboardingConflictError",
    "LocationOnboardingMigrationRequiredError",
    "LocationOnboardingLedgerStore",
    "LocationOnboardingRuntimeService",
    "LocationPlaceEvidencePort",
    "LocationPreflightPort",
    "LocationPreflightResult",
    "LocationReceiptV1",
    "LocationStepContractV2",
    "OneLocationCircleProvisioningAdapter",
    "PkmLocationPlaceEvidenceAdapter",
    "VaultLocationCompletionAdapter",
    "VaultLocationOnboardingPreflightAdapter",
    "get_location_onboarding_runtime_service",
    "resolve_location_transition_target",
]

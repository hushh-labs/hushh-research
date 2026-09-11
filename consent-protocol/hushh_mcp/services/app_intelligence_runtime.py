"""Server-owned capability runtime for Agent One.

The generated action gateway remains the source of truth for product actions.
This module compiles it with the generated route index into a small, versioned
capability graph that every entry point can use (Live voice, typed chat, Siri,
and browser automation).  It deliberately contains product metadata and safe
execution policy only; private domain values and client-provided authority do
not enter the graph.

The graph is MCP-shaped (``inputSchema`` / JSON Schema) so it can be exported
later, but no MCP transport runs in the realtime path.
"""

from __future__ import annotations

import ast
import hashlib
import hmac
import importlib
import json
import logging
import math
import re
import threading
import time
from collections.abc import Iterable, Mapping
from contextvars import ContextVar, Token
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from hushh_mcp.hushh_adk.manifest import (
    ManifestLoader,
    ServiceKnowledgePackageV2,
)
from hushh_mcp.runtime_providers.factory import (
    VERTEX_ADC_AUTH_MODE,
    ManagedGeminiRuntimeBinding,
)
from hushh_mcp.services.action_gateway import (
    is_navigation_action,
    list_action_gateway_actions,
)
from hushh_mcp.services.capability_run_service import (
    MAX_CAPABILITY_RUN_RESUME_SUMMARIES,
    RESUMABLE_CAPABILITY_RUN_STATUSES,
    CapabilityRunAuthorityError,
    CapabilityRunV1,
    get_capability_run_store,
)
from hushh_mcp.services.generated_contracts import generated_contract_path
from hushh_mcp.services.route_orchestration_index import load_route_orchestration_index

logger = logging.getLogger(__name__)

CAPABILITY_GRAPH_SCHEMA_VERSION = "one.capability_graph.v1"
CAPABILITY_GRAPH_COMPILER_VERSION = "2026-09-10.10"
# The policy fingerprint is deliberately separate from the compiler version.
# Changing a policy input must invalidate a checked-in artifact even if a
# developer forgets to manually bump the compiler version.
CAPABILITY_GRAPH_POLICY_INPUTS_SCHEMA_VERSION = "one.capability_graph.policy_inputs.v1"
RUNTIME_CONTEXT_SCHEMA_VERSION = "one.runtime_context.v1"
PERSISTED_ONBOARDING_CONTEXT_SCHEMA_VERSION = "one.persisted_onboarding_context.v1"
SERVICE_ONBOARDING_WORKFLOW_SCHEMA_VERSION = "one.service_onboarding_workflow.v1"
DYNAMIC_SERVICE_KNOWLEDGE_SCHEMA_VERSION = "one.dynamic_service_knowledge.v1"
SERVICE_KNOWLEDGE_PACKAGE_SCHEMA_VERSION = "one.service_knowledge_package.v2"
LOCATION_KNOWLEDGE_PACKAGE_SCHEMA_VERSION = SERVICE_KNOWLEDGE_PACKAGE_SCHEMA_VERSION
LOCATION_KNOWLEDGE_PROJECTION_SCHEMA_VERSION = "one.service_knowledge_projection.v2"
LOCATION_BRAIN_CATALOG_SCHEMA_VERSION = "one.location_brain_catalog.v1"
LOCATION_BRAIN_SNAPSHOT_SCHEMA_VERSION = "one.location_brain_snapshot.v1"
LOCATION_TURN_PROJECTION_SCHEMA_VERSION = "one.location_turn_projection.v1"
LOCATION_BRAIN_DELTA_SCHEMA_VERSION = "one.location_brain_delta.v1"
# ``ServiceKnowledgePackageV2`` is intentionally broader than the first
# Location migration.  These registry contracts let a command runtime ask
# which *compiled* service brains are safe to retrieve from without treating
# a manifest, a route, or an alias list as runtime authority.
SERVICE_BRAIN_REGISTRY_SCHEMA_VERSION = "one.service_brain_registry.v1"
SERVICE_BRAIN_RETRIEVAL_SCHEMA_VERSION = "one.service_brain_retrieval.v1"
SERVICE_BRAIN_CATALOG_SCHEMA_VERSION = "one.service_brain_catalog.v1"
PLATFORM_CAPABILITY_PROJECTION_SCHEMA_VERSION = "one.capability_platform_projection.v1"
WORKFLOW_REVISION_COMPATIBILITY_SCHEMA_VERSION = "one.workflow_revision_compatibility.v1"
_LOCATION_KNOWLEDGE_POLICY_FIELDS = (
    "retry_policy",
    "pause_policy",
    "expiry_policy",
    "recovery_policy",
    "graph_compatibility",
    "active_run_policy",
    "telemetry_policy",
)
SERVICE_RUNTIME_STATE_SCHEMA_VERSION = "one.service_runtime_state.v1"
LOCATION_ONBOARDING_RUN_RESULT_SCHEMA_VERSION = "one.location_onboarding_run_result.v1"
LOCATION_ONBOARDING_COMPLETION_RECEIPT_SCHEMA_VERSION = (
    "one.location_onboarding_completion_receipt.v1"
)
CAPABILITY_RUN_RESUME_SUMMARY_LIMIT = MAX_CAPABILITY_RUN_RESUME_SUMMARIES
MIN_RETRIEVAL_RESULTS = 4
MAX_RETRIEVAL_RESULTS = 10
LOCATION_BRAIN_EMBEDDING_MODEL = "gemini-embedding-001"
LOCATION_BRAIN_EMBEDDING_DIMENSIONS = 768
_LOCATION_BRAIN_EMBEDDING_TIMEOUT_MS = 900
_LOCATION_BRAIN_EMBEDDING_STARTUP_TIMEOUT_MS = 8_000
_LOCATION_BRAIN_EMBEDDING_CIRCUIT_SECONDS = 30.0
_LOCATION_BRAIN_EMBEDDING_MAX_CONCURRENCY = 4
# These are deliberately conservative initial operating thresholds.  They are
# release configuration, not keyword rules: the held-out Location corpus and
# physical-device latency evidence must calibrate them before promotion.
_LOCATION_BRAIN_MIN_SEMANTIC_SCORE = 0.55
_LOCATION_BRAIN_AMBIGUITY_MARGIN = 0.025
_LOCATION_BRAIN_ROUTING_TOKEN_RE = re.compile(r"[a-z0-9]+", flags=re.IGNORECASE)
# The Location command sends a semantic *redaction* to managed retrieval, not
# a keyword projection.  A catalog-only token filter would be privacy-safe but
# would also turn a genuinely different phrasing (for example, "whereabouts
# service") into a row of ``[detail]`` markers.  That is precisely the alias
# dependence this runtime is meant to remove.  These narrow patterns remove
# values that can identify a person/place or become a slot while retaining the
# ordinary language Gemini needs to understand a paraphrase.
_LOCATION_BRAIN_ROUTING_URL_RE = re.compile(r"\bhttps?://[^\s<>{}\[\]]+", flags=re.IGNORECASE)
_LOCATION_BRAIN_ROUTING_EMAIL_RE = re.compile(
    r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", flags=re.IGNORECASE
)
_LOCATION_BRAIN_ROUTING_PHONE_RE = re.compile(r"(?<!\w)(?:\+?\d[\d(). -]{7,}\d)(?!\w)")
_LOCATION_BRAIN_ROUTING_COORDINATE_RE = re.compile(
    r"(?<![\w.-])-?\d{1,3}(?:\.\d{3,})?\s*,\s*-?\d{1,3}(?:\.\d{3,})?(?![\w.-])"
)
_LOCATION_BRAIN_ROUTING_ADDRESS_RE = re.compile(
    r"\b\d{1,6}\s+[A-Za-z][A-Za-z .'-]{1,72}\s"
    r"(?:street|st|road|rd|avenue|ave|lane|ln|boulevard|blvd|drive|dr|"
    r"place|pl|terrace|ter|court|ct|parkway|pkwy|way|highway|hwy|square|"
    r"trail|trl)\b",
    flags=re.IGNORECASE,
)
_LOCATION_BRAIN_ROUTING_QUOTED_VALUE_RE = re.compile(r"(?:\"[^\"\r\n]{1,160}\"|'[^'\r\n]{1,160}')")
_LOCATION_BRAIN_ROUTING_NAMED_VALUE_RE = re.compile(
    r"(?P<prefix>\b(?:called|named|name\s+(?:it|the\s+(?:circle|place))|"
    r"label\s+(?:it|the\s+place)|title(?:d)?\s+as)\s+)"
    r"(?P<value>[^,.!?]{1,120})(?=$|[,.!?])",
    flags=re.IGNORECASE,
)
_LOCATION_BRAIN_ROUTING_PLACE_VALUE_RE = re.compile(
    r"(?P<prefix>\b(?:save|set|mark)\s+(?:this|my|the)?\s*"
    r"(?:place|location)\s+(?:as|called|named)\s+)"
    r"(?P<value>[^,.!?]{1,120})(?=$|[,.!?])",
    flags=re.IGNORECASE,
)
_LOCATION_BRAIN_ROUTING_CIRCLE_TAIL_RE = re.compile(
    r"(?P<prefix>\b(?:create|make|start|form)\s+(?:a\s+)?circle)\s+"
    r"(?P<value>[A-Z][^,.!?]{1,96})(?=$|[,.!?])"
)
# A service command can carry an entity or place reference without using a
# quoted/name-labelled slot (for example, "share my location with Priya" or
# "make a Circle for the family").  The command plane does not resolve those
# references, so the model does not need their value to choose a capability.
# Redact the whole tail while retaining the product verb and object that make
# semantic routing work for phrasing with zero alias overlap.
_LOCATION_BRAIN_ROUTING_CIRCLE_PARTICIPANT_RE = re.compile(
    r"(?P<prefix>\b(?:create|make|start|form)\s+(?:a\s+)?circle\s+"
    r"(?:for|with)\s+)(?P<value>[^,.!?]{1,120})(?=$|[,.!?])",
    flags=re.IGNORECASE,
)
_LOCATION_BRAIN_ROUTING_RECIPIENT_RE = re.compile(
    r"(?P<prefix>\b(?:share(?:\s+(?:my|the))?\s+location|"
    r"send\s+(?:a\s+)?location\s+request|"
    r"ask\s+for\s+(?:a\s+)?location)\s+(?:with|to|for)\s+)"
    r"(?P<value>[^,.!?]{1,120})(?=$|[,.!?])",
    flags=re.IGNORECASE,
)
_LOCATION_BRAIN_ROUTING_LOCATION_TARGET_RE = re.compile(
    r"(?P<prefix>\b(?:set\s+up|setup|onboard|enable|turn\s+on|save)\s+"
    r"(?:my\s+|the\s+)?(?:location|place)\s+(?:at|in|near|as)\s+)"
    r"(?P<value>[^,.!?]{1,120})(?=$|[,.!?])",
    flags=re.IGNORECASE,
)
_LOCATION_BRAIN_ROUTING_PROPER_NAME_RE = re.compile(r"\b[A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,})+\b")
# These are grammatical connectors, never user values. Product vocabulary is
# compiled below from the checked-in safe Location Brain catalog so a package
# change updates the command representation without a parallel alias list.
_LOCATION_BRAIN_SAFE_ROUTING_GLUE = frozenset(
    {
        "a",
        "an",
        "and",
        "can",
        "could",
        "do",
        "for",
        "help",
        "i",
        "it",
        "let",
        "me",
        "my",
        "please",
        "the",
        "to",
        "want",
        "with",
        "you",
        # Common transliterated Hinglish command glue. These words name no
        # person, place, Circle, or other private product value.
        "bhai",
        "hai",
        "kar",
        "karo",
        "kr",
        "mera",
        "meri",
        "mujhe",
        "na",
        "se",
    }
)


@dataclass(frozen=True)
class CapabilityWorkflowRevisionPolicyV1:
    """Server-derived interpretation policy for a revision-pinned workflow."""

    workflow_id: str
    workflow_version: int
    current_revision: str
    compatible_revisions: tuple[str, ...]
    migration_required_revisions: tuple[str, ...]
    rejected_revisions: tuple[str, ...]


# A setup service is discovered from the generated action gateway, not a
# prompt-maintained product list. New ``setup.open_<service>`` actions become
# visible to the runtime when their authored route is generated and wired.
_SETUP_OPEN_ACTION_RE = re.compile(r"^setup\.open_([a-z0-9_]+)$")
_SETUP_TERMINAL_ACTION_RE = re.compile(r"^setup\.(?:finish|skip)_([a-z0-9_]+)$")
# A registered tool with this exact stable name is an existing semantic native
# action.  The convention is intentionally narrow: a description containing
# the word "permission" is not enough to let the compiler invent a device
# operation.  New services can opt in simply by registering the same typed
# tool-name shape; no model prompt or Location-specific phrase is needed.
_NATIVE_PERMISSION_TOOL_RE = re.compile(r"^request_device_([a-z0-9_]+)_permission$")
_LOCATION_ONBOARDING_WORKFLOW_ID = "workflow.setup.location"
_LOCATION_ONBOARDING_INTERACTION = "route_owned_location_setup"
_LOCATION_ONBOARDING_NAVIGATE_STEP = "location.navigate"
_LOCATION_ONBOARDING_INTERACTION_STEP = "location.interaction_required"
_LOCATION_ONBOARDING_VERIFY_STEP = "location.verifying_persisted_state"
_LOCATION_ONBOARDING_SETTLEMENT_STEP = "location.settlement_received"
_LOCATION_ONBOARDING_VERIFIED_STEP = "location.verified"
_LOCATION_ONBOARDING_RECEIPT_SCHEMA_SLOT = "locationReceiptSchema"
_LOCATION_ONBOARDING_PERMISSION_RECEIPT_SLOT = "locationPermissionReceipt"
_LOCATION_ONBOARDING_PLACE_RECEIPT_SLOT = "locationPlaceReceipt"
_LOCATION_ONBOARDING_CIRCLE_RECEIPT_SLOT = "locationCircleReceipt"
_LOCATION_ONBOARDING_COMPLETION_RECEIPT_SLOT = "locationCompletionReceipt"
_LOCATION_ONBOARDING_RECEIPT_SLOT_NAMES = frozenset(
    {
        _LOCATION_ONBOARDING_RECEIPT_SCHEMA_SLOT,
        _LOCATION_ONBOARDING_PERMISSION_RECEIPT_SLOT,
        _LOCATION_ONBOARDING_PLACE_RECEIPT_SLOT,
        _LOCATION_ONBOARDING_CIRCLE_RECEIPT_SLOT,
        _LOCATION_ONBOARDING_COMPLETION_RECEIPT_SLOT,
    }
)
_LOCATION_ONBOARDING_RECEIPT_ID_PATTERNS: Mapping[str, re.Pattern[str]] = {
    _LOCATION_ONBOARDING_PERMISSION_RECEIPT_SLOT: re.compile(r"^locperm_[a-z0-9]{16,96}$"),
    _LOCATION_ONBOARDING_PLACE_RECEIPT_SLOT: re.compile(r"^locplace_[a-z0-9]{16,96}$"),
    _LOCATION_ONBOARDING_CIRCLE_RECEIPT_SLOT: re.compile(r"^loccircle_[a-z0-9]{16,96}$"),
    _LOCATION_ONBOARDING_COMPLETION_RECEIPT_SLOT: re.compile(r"^loccomplete_[a-z0-9]{16,96}$"),
}
_ONBOARDING_PHASES = frozenset(
    {
        "anonymous_auth",
        "phone_required",
        "capability_setup",
        "external_connector",
        "setup_hub",
        "root_completion",
    }
)
_ONBOARDING_CALLBACK_STATES = frozenset(
    {
        "none",
        "pending",
        "succeeded",
        "failed",
        "cancelled",
    }
)

# These are deliberately narrow. A capability enters this audited binding
# registry only after its service path has the same authenticated
# identity/consent validation as its REST endpoint and returns a verified
# result. It is not inferred from a route, screen, or a model-supplied action
# id. Keeping the binding policy as data makes it both compiler-visible and
# independently fingerprintable in the generated artifact.
SERVER_DIRECT_CAPABILITY_BINDINGS: Mapping[str, Mapping[str, Any]] = {
    "location.create_circle": {
        "binding_ref": "backend_service:location.create_circle",
        "executor_kind": "backend_service",
        "settlement_proof": "verified_backend_service_result",
        "idempotency": {
            "strategy": "capability_run_bound_backend_receipt",
            "scope": "server_intent_epoch_and_capability_run",
        },
    },
}
# Retain this exported compatibility view for callers that need only ids. The
# compiler verifies it stays exactly in sync with the audited binding registry.
SERVER_DIRECT_ACTION_IDS: frozenset[str] = frozenset(SERVER_DIRECT_CAPABILITY_BINDINGS)

# This is product policy, deliberately independent of the legacy generated
# ``execution_policy`` field. That field historically represented both an
# execution boundary and a UI prompt, which made every old
# ``confirm_required`` entry behave as a hard confirmation even when the
# product decision was to execute after its required details are known.
#
# There is no registered outbound-SMS capability today. In this product,
# ``location.open_sms_contacts`` means *Save My Soul* contacts and explicitly
# does not send a text message, so treating that navigation as an SMS-send
# confirmation would be both misleading and a latency regression. A future
# real SMS-send capability must add its stable id here during capability
# registration; never infer that policy from a loose label match.
HARD_CARD_CONFIRMATION_ACTION_IDS: frozenset[str] = frozenset(
    {
        "profile.delete_account",
    }
)

# The model may select one of these typed surfaces, but it can never generate
# arbitrary UI.  The client owns how an approved surface is rendered.
APPROVED_RENDER_SURFACES: tuple[dict[str, Any], ...] = (
    {
        "capability_id": "render.confirmation_card",
        "kind": "render_surface",
        "label": "Confirmation card",
        "description": "A trusted explicit-confirmation card for a governed mutation.",
    },
    {
        "capability_id": "render.choice_card",
        "kind": "render_surface",
        "label": "Choice card",
        "description": "A bounded list used when an entity reference is ambiguous.",
    },
    {
        "capability_id": "render.data_card",
        "kind": "render_surface",
        "label": "Data card",
        "description": "A display-only result from an authenticated read tool.",
    },
    {
        "capability_id": "render.entity_picker",
        "kind": "render_surface",
        "label": "Entity picker",
        "description": "A bounded picker for a person, circle, or other resolved entity.",
    },
    {
        "capability_id": "render.form",
        "kind": "render_surface",
        "label": "Form",
        "description": "A typed form for required values that cannot be resolved conversationally.",
    },
    {
        "capability_id": "render.one_location_workflow_card",
        "kind": "render_surface",
        "renderer_key": "one_location_workflow_card",
        "contract_schema": "one.location_workflow_card.v2",
        "label": "Location workflow card",
        "description": (
            "The approved app-global Location workflow surface for guidance, "
            "OS interaction hand-off, and place choice."
        ),
    },
)

# Location is the first service with an authored knowledge package. These
# registries are capability-compiler policy, not inferred endpoints. Every
# entry names its checked-in implementation explicitly and must resolve during
# graph compilation. There is no permissive ``adapter_required`` state: an
# incomplete package cannot enter a release artifact.
_LOCATION_RUNTIME_MODULE = "hushh_mcp.services.location_onboarding_runtime"
_LOCATION_RUNTIME_SURFACE_REGISTRY_REF = (
    f"{_LOCATION_RUNTIME_MODULE}:LOCATION_APPROVED_SURFACE_CONTRACTS"
)
_LOCATION_RUNTIME_DIRECTIVE_KIND_REGISTRY_REF = (
    f"{_LOCATION_RUNTIME_MODULE}:LOCATION_DIRECTIVE_KIND_BY_SURFACE"
)
LOCATION_KNOWLEDGE_WORKFLOW_BINDING: Mapping[str, Any] = {
    "status": "wired",
    "binding_ref": "backend_workflow:workflow.setup.location:v2",
    "implementation_refs": [
        f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingRuntimeService.start_or_resume"
    ],
    "settlement_proof": "server_location_onboarding_completion_receipt",
}


def _location_result_descriptor(result: str) -> dict[str, Any]:
    native_results = {
        "permission_granted",
        "permission_denied",
        "permission_restricted",
        "services_disabled",
        "settings_returned",
        "position_captured",
        "position_unavailable",
    }
    app_results = {"vault_unavailable", "draft_unavailable"}
    presentation = (
        "native_result"
        if result in native_results
        else "app_result"
        if result in app_results
        else "button"
    )
    return {
        "result": result,
        "label_key": f"one.location.result.{result}.label",
        "presentation": presentation,
        "button_role": (
            "secondary"
            if presentation == "button" and result in {"pause", "skip_place"}
            else "primary"
            if presentation == "button"
            else None
        ),
    }


def _location_result_payload_schema(results: tuple[str, ...]) -> dict[str, Any]:
    """Return the exact strict payload variants accepted for one directive."""

    variants: list[dict[str, Any]] = []
    common_properties: dict[str, Any] = {
        "runRevision": {"type": "integer", "minimum": 1},
        "leaseId": {
            "type": "string",
            "pattern": r"^loclease_[a-z0-9]{16,96}$",
        },
    }
    for result in results:
        properties = {
            **common_properties,
            "result": {"const": result, "type": "string"},
        }
        required = ["runRevision", "leaseId", "result"]
        if result == "position_captured":
            properties["positionObservation"] = {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "schemaVersion",
                    "permissionStatus",
                    "capturedAt",
                    "sourcePlatform",
                ],
                "properties": {
                    "schemaVersion": {
                        "const": "one.location_position_observation.v1",
                        "type": "string",
                    },
                    "permissionStatus": {"const": "granted", "type": "string"},
                    "capturedAt": {"type": "string", "format": "date-time"},
                    "sourcePlatform": {
                        "type": "string",
                        "enum": ["web", "ios", "android", "native"],
                    },
                },
            }
            required.append("positionObservation")
        elif result == "vault_unavailable":
            properties["draftMetadata"] = {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "schemaVersion",
                    "digest",
                    "status",
                    "expiresAt",
                    "runId",
                    "revision",
                ],
                "properties": {
                    "schemaVersion": {
                        "const": "one.location.pre_vault.draft_metadata.v1",
                        "type": "string",
                    },
                    "digest": {"type": "string", "pattern": r"^[0-9a-f]{64}$"},
                    "status": {"const": "staged", "type": "string"},
                    "expiresAt": {"type": "string", "format": "date-time"},
                    "runId": {
                        "type": "string",
                        "pattern": r"^run_[a-z0-9]{16,96}$",
                    },
                    "revision": {"type": "integer", "minimum": 1},
                },
            }
            required.append("draftMetadata")
        variants.append(
            {
                "type": "object",
                "additionalProperties": False,
                "required": required,
                "properties": properties,
            }
        )
    return {"oneOf": variants}


def _location_surface_contract(
    *,
    directive_kind: str,
    title_key: str,
    body_key: str,
    results: tuple[str, ...],
) -> dict[str, Any]:
    return {
        "status": "wired",
        "render_capability_id": "render.one_location_workflow_card",
        "renderer_key": "one_location_workflow_card",
        "directive_kind": directive_kind,
        "title_key": title_key,
        "body_key": body_key,
        "allowed_results": [_location_result_descriptor(result) for result in results],
        "result_schema_ref": (
            "api.routes.one.capability_runtime:LocationOnboardingInteractionRequest"
        ),
        "result_schema": _location_result_payload_schema(results),
    }


# These are typed contract instances emitted by the server-owned Location
# state machine. They all render through one approved global card capability;
# they are not independently executable capabilities and contain no UI code.
LOCATION_KNOWLEDGE_INTERACTION_SURFACE_REGISTRY: Mapping[str, Mapping[str, Any]] = {
    "one.location.introduction.v2": _location_surface_contract(
        directive_kind="information",
        title_key="one.location.intro.title",
        body_key="one.location.intro.body",
        results=("continue", "pause"),
    ),
    "one.location.permission_offer.v2": _location_surface_contract(
        directive_kind="technical_interaction",
        title_key="one.location.permission_offer.title",
        body_key="one.location.permission_offer.body",
        results=("request_permission", "pause"),
    ),
    "one.location.permission_result.v2": _location_surface_contract(
        directive_kind="technical_interaction",
        title_key="one.location.permission_result.title",
        body_key="one.location.permission_result.body",
        results=(
            "permission_granted",
            "permission_denied",
            "permission_restricted",
            "services_disabled",
            "retry_permission",
            "pause",
        ),
    ),
    "one.location.settings_return.v2": _location_surface_contract(
        directive_kind="recovery",
        title_key="one.location.settings_return.title",
        body_key="one.location.settings_return.body",
        results=("open_settings", "settings_returned", "retry_permission", "pause"),
    ),
    "one.location.position_pending.v2": _location_surface_contract(
        directive_kind="progress",
        title_key="one.location.position_pending.title",
        body_key="one.location.position_pending.body",
        results=("position_captured", "position_unavailable", "pause"),
    ),
    "one.location.position_retry.v2": _location_surface_contract(
        directive_kind="recovery",
        title_key="one.location.position_retry.title",
        body_key="one.location.position_retry.body",
        results=("retry_position", "pause"),
    ),
    "one.location.place_choice.v2": _location_surface_contract(
        directive_kind="form",
        title_key="one.location.place_choice.title",
        body_key="one.location.place_choice.body",
        results=("save_place", "skip_place", "pause"),
    ),
    "one.location.place_persisting.v2": _location_surface_contract(
        directive_kind="form",
        title_key="one.location.place_persisting.title",
        body_key="one.location.place_persisting.body",
        results=("vault_unavailable", "skip_place", "pause"),
    ),
    "one.location.awaiting_vault_finalize.v2": _location_surface_contract(
        directive_kind="status",
        title_key="one.location.awaiting_vault_finalize.title",
        body_key="one.location.awaiting_vault_finalize.body",
        results=("skip_place", "draft_unavailable", "pause"),
    ),
    "one.location.circle_retry.v2": _location_surface_contract(
        directive_kind="status",
        title_key="one.location.circle_retry.title",
        body_key="one.location.circle_retry.body",
        results=("retry_circle", "pause"),
    ),
    "one.location.completion_retry.v2": _location_surface_contract(
        directive_kind="status",
        title_key="one.location.completion_retry.title",
        body_key="one.location.completion_retry.body",
        results=("retry_completion", "pause"),
    ),
    "one.location.already_complete.v2": _location_surface_contract(
        directive_kind="status",
        title_key="one.location.already_complete.title",
        body_key="one.location.already_complete.body",
        results=("open_location", "pause"),
    ),
    "one.location.paused.v2": _location_surface_contract(
        directive_kind="status",
        title_key="one.location.paused.title",
        body_key="one.location.paused.body",
        results=("resume",),
    ),
}

LOCATION_KNOWLEDGE_BINDING_REGISTRY: Mapping[str, Mapping[str, Any]] = {
    "location.onboarding_state.v1": {
        "kind": "state_resolver",
        "status": "wired",
        "implementation_refs": [
            f"{_LOCATION_RUNTIME_MODULE}:VaultLocationOnboardingPreflightAdapter.resolve_state"
        ],
        "interaction_surface_ids": ["one.location.already_complete.v2"],
    },
    "location.onboarding.introduction.v1": {
        "kind": "approved_interaction",
        "status": "wired",
        "implementation_refs": [
            f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingRuntimeService.settle_interaction"
        ],
        "render_surfaces": ["render.one_location_workflow_card"],
        "interaction_surface_ids": ["one.location.introduction.v2"],
    },
    "native.request_device_location_permission": {
        "kind": "native_semantic_action",
        "status": "wired",
        "implementation_refs": [
            f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingRuntimeService.settle_interaction",
            f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingLedgerStore.consume_and_move",
        ],
        "render_surfaces": ["render.one_location_workflow_card"],
        "interaction_surface_ids": [
            "one.location.permission_offer.v2",
            "one.location.permission_result.v2",
            "one.location.settings_return.v2",
        ],
    },
    "location.capture_current_position.v1": {
        "kind": "native_interaction",
        "status": "wired",
        "implementation_refs": [
            f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingRuntimeService.settle_interaction",
            f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingLedgerStore.consume_and_move",
        ],
        "interaction_surface_ids": [
            "one.location.position_pending.v2",
            "one.location.position_retry.v2",
        ],
    },
    "location.onboarding.place_form.v1": {
        "kind": "approved_interaction",
        "status": "wired",
        "implementation_refs": [
            f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingRuntimeService.settle_interaction",
            f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingLedgerStore.issue_pkm_finalize_authorization",
        ],
        "render_surfaces": ["render.one_location_workflow_card"],
        "interaction_surface_ids": [
            "one.location.place_choice.v2",
            "one.location.place_persisting.v2",
            "one.location.awaiting_vault_finalize.v2",
        ],
    },
    "location.provision_personal_circle.v1": {
        "kind": "backend_adapter",
        "status": "wired",
        "implementation_refs": [
            f"{_LOCATION_RUNTIME_MODULE}:OneLocationCircleProvisioningAdapter.provision_personal_circle",
            f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingLedgerStore.mint_server_receipt",
        ],
        "interaction_surface_ids": ["one.location.circle_retry.v2"],
    },
    "location.complete_onboarding.v1": {
        "kind": "backend_adapter",
        "status": "wired",
        "implementation_refs": [
            f"{_LOCATION_RUNTIME_MODULE}:VaultLocationCompletionAdapter.ensure_completion_marker",
            f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingRuntimeService._finalize",
        ],
        "interaction_surface_ids": ["one.location.completion_retry.v2"],
    },
}

LOCATION_KNOWLEDGE_VERIFIER_REGISTRY: Mapping[str, Mapping[str, Any]] = {
    "location.onboarding.preflight.v1": {
        "status": "wired",
        "proof": "bounded_server_runtime_state",
        "implementation_refs": [
            f"{_LOCATION_RUNTIME_MODULE}:VaultLocationOnboardingPreflightAdapter.resolve_state"
        ],
        "outcomes": [
            "already_complete",
            "full_guide_requested",
            "needs_onboarding",
            "open_location",
            "pause",
            "state_unavailable",
        ],
    },
    "location.onboarding.introduction_ack.v1": {
        "status": "wired",
        "proof": "run_bound_interaction_lease",
        "implementation_refs": [
            f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingRuntimeService.settle_interaction",
            f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingLedgerStore.consume_and_move",
        ],
        "outcomes": ["continue", "pause"],
    },
    "location.onboarding.permission_receipt.v1": {
        "status": "wired",
        "proof": "run_bound_permission_receipt",
        "implementation_refs": [
            f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingRuntimeService.settle_interaction",
            f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingLedgerStore.consume_and_move",
        ],
        "outcomes": [
            "request_permission",
            "permission_granted",
            "permission_denied",
            "permission_restricted",
            "services_disabled",
            "open_settings",
            "settings_returned",
            "retry_permission",
            "pause",
        ],
    },
    "location.onboarding.position_receipt.v1": {
        "status": "wired",
        "proof": "run_bound_position_receipt",
        "implementation_refs": [
            f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingRuntimeService.settle_interaction",
            f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingLedgerStore.consume_and_move",
        ],
        "outcomes": [
            "position_captured",
            "position_unavailable",
            "retry_position",
            "pause",
        ],
    },
    "location.onboarding.place_receipt.v1": {
        "status": "wired",
        "proof": "run_bound_place_or_skip_receipt",
        "implementation_refs": [
            f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingLedgerStore.issue_pkm_finalize_authorization",
            f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingLedgerStore.consume_and_move",
        ],
        "outcomes": [
            "save_place",
            "skip_place",
            "vault_unavailable",
            "pause",
        ],
    },
    "location.onboarding.circle_receipt.v1": {
        "status": "wired",
        "proof": "verified_backend_circle_receipt",
        "implementation_refs": [
            f"{_LOCATION_RUNTIME_MODULE}:OneLocationCircleProvisioningAdapter.provision_personal_circle",
            f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingLedgerStore.mint_server_receipt",
        ],
        "outcomes": ["provisioned", "failed", "retry_circle", "pause"],
    },
    "location.onboarding.completion_receipt.v1": {
        "status": "wired",
        "proof": "server_location_onboarding_completion_receipt",
        "implementation_refs": [
            f"{_LOCATION_RUNTIME_MODULE}:VaultLocationCompletionAdapter.ensure_completion_marker",
            f"{_LOCATION_RUNTIME_MODULE}:LocationOnboardingRuntimeService._finalize",
        ],
        "outcomes": [
            "verified",
            "failed",
            "skip_place",
            "draft_unavailable",
            "retry_completion",
            "pause",
        ],
    },
}

_LOCATION_AGENT_MANIFEST_PATH = (
    Path(__file__).resolve().parents[1] / "agents" / "location" / "agent.yaml"
)
_CAPABILITY_GRAPH_EVOLUTION_PATH = (
    Path(__file__).resolve().parents[1] / "agents" / "capability_graph_evolution.v1.json"
)
_LOCATION_ONBOARDING_RUNTIME_PATH = Path(__file__).with_name("location_onboarding_runtime.py")
_LOCATION_WORKFLOW_API_CONTRACT_PATH = (
    Path(__file__).resolve().parents[2] / "api" / "routes" / "one" / "capability_runtime.py"
)
_LOCATION_KNOWLEDGE_TERMINALS = frozenset(
    {"$verified_succeeded", "$paused", "$cancelled", "$failed"}
)

# Keep defaults that affect generated action contracts alongside the rest of
# the compiler policy inputs. Gateway-authored entrypoints override these, but
# a policy-only default change must still invalidate old graph artifacts.
DEFAULT_ACTION_ENTRYPOINTS: tuple[str, ...] = (
    "voice",
    "typed_input",
    "web",
    "ios",
    "siri_app_intent",
)

# Build-time source compilation and runtime artifact loading intentionally use
# separate caches.  Sharing one meant an import that loaded the deployed graph
# could make the compiler return that stale graph during a build in the same
# process.  That defeats both semantic diffs and stale-artifact detection.
_SOURCE_COMPILER_CACHE: dict[str, Any] = {"source_digest": None, "graph": None}
_ARTIFACT_CACHE: dict[str, Any] = {"revision": None, "graph": None}
_RUNTIME_SUMMARY_CACHE: dict[str, Any] = {"revision": None, "summary": None}
_RUNTIME_MILESTONES = frozenset(
    {
        "input_turn_started",
        "input_turn_ended",
        "transcript_finalized",
        "provider_ready",
        "context_resolved",
        "candidate_retrieval",
        "action_proposed",
        "interaction_rendered",
        "action_settled",
        "input_failed",
    }
)

# ``one.voice_telemetry.v2`` is intentionally a much smaller surface than the
# runtime context itself.  The latter can contain redacted product state for a
# model turn; telemetry must never inherit it by accident.  These identifiers
# are opaque correlation handles only, validated before they reach a span.
ONE_VOICE_TELEMETRY_SCHEMA_VERSION = "one.voice_telemetry.v2"
_VOICE_TELEMETRY_METRICS: Mapping[str, str] = {
    "input_turn_started": "input_turn_started",
    "input_turn_ended": "input_turn_ended",
    "transcript_finalized": "transcript_finalized",
    "provider_ready": "provider_ready",
    "context_resolved": "context_resolved",
    "candidate_retrieval": "candidate_retrieval",
    "action_proposed": "action_proposed",
    "interaction_rendered": "interaction_rendered",
    "action_settled": "action_settled",
    "input_failed": "input_failed",
}
_VOICE_TELEMETRY_CORRELATION_PATTERNS: Mapping[str, re.Pattern[str]] = {
    "trace_id": re.compile(r"^(?:[0-9a-f]{16,64}|trace_[A-Za-z0-9_-]{8,96})$"),
    "activation_id": re.compile(r"^vact_[A-Za-z0-9_-]{8,96}$"),
    "voice_session_id": re.compile(r"^(?:voice_|gemini_live_)[A-Za-z0-9_-]{8,128}$"),
    "turn_id": re.compile(r"^vturn_[A-Za-z0-9_-]{8,96}$"),
    "context_revision": re.compile(
        r"^(?:r[A-Za-z0-9_-]{1,64}:r[A-Za-z0-9_-]{1,64}|ctx_r[A-Za-z0-9_-]{1,96})$"
    ),
    "graph_revision": re.compile(r"^[0-9a-f]{8,128}$"),
}
_VOICE_TELEMETRY_OUTCOMES = frozenset({"EXECUTE", "NAVIGATE", "RENDER"})
_VOICE_TELEMETRY_STATUSES = frozenset(
    {
        "accepted",
        "ask",
        "blocked",
        "cancelled",
        "completed",
        "discarded",
        "failed",
        "input_needed",
        "issued",
        "ok",
        "ready",
        "settling",
        "started",
        "succeeded",
    }
)
# A mutable per-session value is deliberate.  asyncio copies ContextVar
# bindings when the relay creates its two pumps; mutating this already-bound
# safe map lets a later context revision be visible to both pumps without
# copying any client payload into their task contexts.
_VOICE_TELEMETRY_CORRELATION: ContextVar[dict[str, str] | None] = ContextVar(
    "one_voice_telemetry_v2_correlation", default=None
)


class CapabilityGraphArtifactError(RuntimeError):
    """The deployed CapabilityGraphV1 artifact is absent, corrupt, or stale."""


def _normalized_voice_telemetry_correlation(
    values: Mapping[str, Any] | None,
) -> dict[str, str]:
    """Return only strict opaque v2 correlation fields.

    Do not coerce unknown objects or accept arbitrary strings here.  A caller
    that accidentally passes a route, transcript, error, entity, credential,
    or slot value must get an empty field rather than a truncated copy.
    """

    source = values if isinstance(values, Mapping) else {}
    result: dict[str, str] = {}
    for key, pattern in _VOICE_TELEMETRY_CORRELATION_PATTERNS.items():
        value = source.get(key)
        if isinstance(value, str) and pattern.fullmatch(value):
            result[key] = value
    return result


def bind_voice_telemetry_correlation(
    **values: Any,
) -> Token[dict[str, str] | None]:
    """Bind a fresh, privacy-safe telemetry scope for one request/session.

    This is intentionally not a generic logging context.  Only the six
    declared opaque identifiers can cross this boundary.
    """

    return _VOICE_TELEMETRY_CORRELATION.set(_normalized_voice_telemetry_correlation(values))


def update_voice_telemetry_correlation(**values: Any) -> None:
    """Merge newly known validated correlation fields into the current scope."""

    clean = _normalized_voice_telemetry_correlation(values)
    if not clean:
        return
    current = _VOICE_TELEMETRY_CORRELATION.get()
    if current is None:
        _VOICE_TELEMETRY_CORRELATION.set(dict(clean))
        return
    # See the ContextVar comment above: retain the per-session object so tasks
    # created before the first app_context observe only these validated fields.
    current.update(clean)


def reset_voice_telemetry_correlation(token: Token[dict[str, str] | None]) -> None:
    """End a scope created by :func:`bind_voice_telemetry_correlation`."""

    _VOICE_TELEMETRY_CORRELATION.reset(token)


def _safe_runtime_action_id(action_id: str | None) -> str | None:
    """Permit only an actually registered capability id in telemetry."""

    clean = action_id.strip() if isinstance(action_id, str) else ""
    if not re.fullmatch(r"[a-z0-9_]{1,64}(?:\.[a-z0-9_]{1,64}){1,3}", clean):
        return None
    try:
        return clean if isinstance(get_capability(clean), Mapping) else None
    except Exception:  # noqa: BLE001 - telemetry must never affect an action result
        return None


def record_runtime_milestone(
    milestone: str,
    *,
    action_id: str | None = None,
    outcome: str | None = None,
    status: str | None = None,
) -> None:
    """Emit one strict ``one.voice_telemetry.v2`` runtime milestone.

    Raw audio, text, slot values, identities, routes, entities, credentials,
    and error strings are deliberately excluded.  OpenTelemetry's active span
    carries trace correlation; this function adds only validated opaque v2
    fields plus fixed enums.
    """
    clean_milestone = str(milestone or "").strip()
    metric = _VOICE_TELEMETRY_METRICS.get(clean_milestone)
    if metric is None:
        return
    clean_action_id = _safe_runtime_action_id(action_id)
    clean_outcome = (
        outcome if isinstance(outcome, str) and outcome in _VOICE_TELEMETRY_OUTCOMES else None
    )
    clean_status = (
        status if isinstance(status, str) and status in _VOICE_TELEMETRY_STATUSES else None
    )
    correlation = _VOICE_TELEMETRY_CORRELATION.get() or {}
    attributes: dict[str, str | bool] = {
        "one.voice_telemetry.schema_version": ONE_VOICE_TELEMETRY_SCHEMA_VERSION,
        "one.voice_telemetry.metric": metric,
    }
    if clean_action_id is not None:
        attributes["one.voice_telemetry.action_id"] = clean_action_id
    if clean_outcome is not None:
        attributes["one.voice_telemetry.outcome"] = clean_outcome
    if clean_status is not None:
        attributes["one.voice_telemetry.status"] = clean_status
    for key, value in correlation.items():
        attributes[f"one.voice_telemetry.{key}"] = value
    try:
        from opentelemetry import trace

        span = trace.get_current_span()
        if span.is_recording():
            span.add_event(f"one.voice_telemetry.v2.{metric}", attributes=attributes)
    except Exception:  # noqa: BLE001 - telemetry must never change an action result
        pass
    logger.info(
        "one_voice_telemetry_v2 metric=%s outcome=%s status=%s has_session=%s "
        "has_context_revision=%s has_graph_revision=%s",
        metric,
        clean_outcome or "none",
        clean_status or "none",
        "voice_session_id" in correlation,
        "context_revision" in correlation,
        "graph_revision" in correlation,
    )


def _clean_strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    seen: set[str] = set()
    result: list[str] = []
    for item in value:
        clean = str(item or "").strip()
        if clean and clean not in seen:
            seen.add(clean)
            result.append(clean)
    return result


def _sha256_path(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return ""


def _location_knowledge_package_path() -> Path:
    """Resolve Location's authored package without permitting path escape."""

    manifest = ManifestLoader.load(str(_LOCATION_AGENT_MANIFEST_PATH))
    exposure = manifest.one_exposure
    reference = exposure.knowledge_package_ref if exposure is not None else None
    if exposure is None or exposure.service_id != "location" or reference is None:
        raise ValueError("Location manifest lacks its typed knowledge_package_ref.")
    owner_directory = _LOCATION_AGENT_MANIFEST_PATH.parent.resolve()
    package_path = (owner_directory / reference.path).resolve()
    if package_path.parent != owner_directory:
        raise ValueError("Location knowledge package must remain beside its owning manifest.")
    return package_path


def discover_service_knowledge_packages() -> dict[str, dict[str, Any]]:
    """Discover typed service packages from manifest-owned declarations.

    This runs only while compiling/checking the graph.  It gives a future
    service one declarative adoption path—its manifest plus a checked-in
    package—without making a directory name, prompt, or route scan into
    runtime authority.  Existing services without a package stay on their
    current contracts until they deliberately migrate.
    """

    agents_root = _LOCATION_AGENT_MANIFEST_PATH.parent.parent
    packages: dict[str, dict[str, Any]] = {}
    for manifest_path in sorted(agents_root.glob("*/agent.yaml")):
        manifest = ManifestLoader.load(str(manifest_path))
        exposure = manifest.one_exposure
        reference = exposure.knowledge_package_ref if exposure is not None else None
        if exposure is None or reference is None:
            continue
        owner_directory = manifest_path.parent.resolve()
        package_path = (owner_directory / reference.path).resolve()
        if owner_directory not in package_path.parents:
            raise ValueError("Service knowledge package must remain under its owning manifest.")
        package = ManifestLoader.load_service_knowledge_package(str(package_path))
        service_id = str(exposure.service_id or "").strip()
        if not service_id or service_id in packages:
            raise ValueError("Service knowledge package owners must have unique service ids.")
        if package.schema_version != SERVICE_KNOWLEDGE_PACKAGE_SCHEMA_VERSION:
            raise ValueError("Service knowledge package has an unsupported schema.")
        if package.package_id != reference.package_id:
            raise ValueError("Service knowledge package_id does not match its manifest reference.")
        if package.package_version != reference.package_version:
            raise ValueError(
                "Service knowledge package version does not match its manifest reference."
            )
        if package.service_id != service_id:
            raise ValueError("Service knowledge package service does not match one_exposure.")
        if set(package.supported_entrypoints) != set(exposure.supported_entrypoints):
            raise ValueError(
                "Service knowledge package entrypoints must match one_exposure entrypoints."
            )
        packages[service_id] = package.model_dump(mode="json")
    return packages


def load_location_knowledge_package() -> dict[str, Any]:
    """Load and cross-check Location's generic ServiceKnowledgePackageV2.

    This is a build-time authoring seam.  The realtime runtime consumes only
    the generated CapabilityGraphV1 artifact and never parses YAML.
    """

    package = discover_service_knowledge_packages().get("location")
    if not isinstance(package, Mapping):
        raise ValueError("Location manifest lacks its typed service knowledge package.")
    return dict(package)


def location_agent_manifest_source_digest() -> str:
    """Digest the authored owner of Location's knowledge-package reference."""

    return _sha256_path(_LOCATION_AGENT_MANIFEST_PATH)


def location_knowledge_package_source_digest() -> str:
    """Digest the exact authored Location knowledge package."""

    try:
        return _sha256_path(_location_knowledge_package_path())
    except (FileNotFoundError, ValueError):
        return ""


def service_knowledge_packages_source_digest() -> str:
    """Digest every opted-in service package and its owner declaration.

    Runtime validates this compact source digest rather than parsing packages
    into a live turn. A future service package therefore cannot change beneath
    a checked-in graph artifact without forcing the same fail-closed rebuild
    boundary that protects Location today.
    """

    try:
        agents_root = _LOCATION_AGENT_MANIFEST_PATH.parent.parent
        records: list[dict[str, str]] = []
        for manifest_path in sorted(agents_root.glob("*/agent.yaml")):
            manifest = ManifestLoader.load(str(manifest_path))
            exposure = manifest.one_exposure
            reference = exposure.knowledge_package_ref if exposure is not None else None
            if exposure is None or reference is None:
                continue
            owner_directory = manifest_path.parent.resolve()
            package_path = (owner_directory / reference.path).resolve()
            if owner_directory not in package_path.parents:
                return ""
            records.append(
                {
                    "service_id": str(exposure.service_id or ""),
                    "package_id": str(reference.package_id or ""),
                    "package_version": str(reference.package_version),
                    "manifest_digest": _sha256_path(manifest_path),
                    "package_digest": _sha256_path(package_path),
                }
            )
        return hashlib.sha256(
            json.dumps(records, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
    except (FileNotFoundError, ValueError, OSError):
        return ""


def location_onboarding_runtime_source_digest() -> str:
    """Digest the exact server state machine that resolves package bindings."""

    return _sha256_path(_LOCATION_ONBOARDING_RUNTIME_PATH)


def location_workflow_api_contract_source_digest() -> str:
    """Digest the typed public request/response contract used by both clients."""

    return _sha256_path(_LOCATION_WORKFLOW_API_CONTRACT_PATH)


def capability_graph_evolution_source_digest() -> str:
    """Digest the exact-revision breaking-change acknowledgement ledger."""

    return _sha256_path(_CAPABILITY_GRAPH_EVOLUTION_PATH)


def _service_key(value: Any) -> str:
    """Normalize a generated service suffix without manufacturing an id."""
    clean = str(value or "").strip().lower().replace("-", "_")
    return clean if re.fullmatch(r"[a-z0-9_]{1,64}", clean) else ""


@lru_cache(maxsize=1)
def _load_product_agent_registry() -> dict[str, Any]:
    """Read the generated product-agent registry without importing agents.

    The registry is the stable boundary for native semantic tools. Importing an
    agent just to learn its tool list can initialise a model/runtime during a
    live connection, which is precisely what the graph must avoid.
    """
    registry_path = generated_contract_path("agents", "product-agent-registry.v2.json")
    try:
        payload = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        logger.info("app_intelligence_agent_registry_unavailable")
        return {"agents": []}
    return payload if isinstance(payload, dict) else {"agents": []}


def _discover_native_semantic_actions(
    registry: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Discover explicitly named native semantic actions from the registry.

    There is deliberately no language-model or description matching here.
    A tool is admitted only by an explicit future ``execution_kind`` metadata
    field or the existing ``request_device_<service>_permission`` convention.
    The latter names the client directive and is already used by the Location
    agent; it makes the same registration path available to future services.
    """
    source = registry if isinstance(registry, Mapping) else _load_product_agent_registry()
    agents = source.get("agents") if isinstance(source.get("agents"), list) else []
    discovered: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for raw_agent in agents:
        if not isinstance(raw_agent, Mapping):
            continue
        agent_id = str(raw_agent.get("id") or "").strip()
        tools = raw_agent.get("tools") if isinstance(raw_agent.get("tools"), list) else []
        for raw_tool in tools:
            if not isinstance(raw_tool, Mapping):
                continue
            tool_name = str(raw_tool.get("name") or "").strip()
            if not tool_name:
                continue
            explicit_kind = str(
                raw_tool.get("execution_kind") or raw_tool.get("x_agent_execution_kind") or ""
            ).strip()
            explicit_service = _service_key(
                raw_tool.get("service_id") or raw_tool.get("x_agent_service_id")
            )
            match = _NATIVE_PERMISSION_TOOL_RE.fullmatch(tool_name)
            if explicit_kind == "native_semantic" and explicit_service:
                service_id = explicit_service
                directive_type = str(raw_tool.get("client_directive") or tool_name).strip()
            elif match is not None:
                service_id = _service_key(match.group(1))
                directive_type = tool_name
            else:
                continue
            if not service_id or not directive_type:
                continue
            dedupe_key = (service_id, tool_name)
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            discovered.append(
                {
                    "capability_id": f"native.{tool_name}",
                    "kind": "native_semantic_action",
                    "service_id": service_id,
                    "tool_name": tool_name,
                    "client_directive_type": directive_type,
                    "source_agent_id": agent_id,
                    "required_scope": str(raw_tool.get("required_scope") or "").strip() or None,
                    # Registry discovery proves the semantic action exists;
                    # it does not claim a generic relay can dispatch it. The
                    # route that owns the device interaction remains the
                    # integration boundary until a typed native adapter is
                    # registered for the shared runtime.
                    "dispatch_status": "route_owned",
                    "settlement": "client_native_interaction",
                }
            )
    return sorted(discovered, key=lambda item: (item["service_id"], item["tool_name"]))


def _endpoint_auth_boundary(route: Any) -> str:
    """Classify only the route's auth boundary, never its request values."""
    dependant = getattr(route, "dependant", None)
    dependencies = getattr(dependant, "dependencies", None) or []
    names = {
        str(getattr(getattr(dependency, "call", None), "__name__", ""))
        for dependency in dependencies
    }
    if "require_vault_owner_token" in names:
        return "vault_owner"
    if "require_firebase_auth" in names:
        return "firebase_auth"
    return "not_declared"


def _discover_service_api_endpoints_from_router(
    service_id: str,
    router: Any,
) -> list[dict[str, Any]]:
    """Return a redacted, read-only catalog of actual FastAPI endpoints."""
    clean_service_id = _service_key(service_id)
    if not clean_service_id:
        return []
    result: list[dict[str, Any]] = []
    for route in getattr(router, "routes", ()) or ():
        path = str(getattr(route, "path", "") or "").strip()
        methods = getattr(route, "methods", None)
        if not path or not isinstance(methods, (set, frozenset, list, tuple)):
            continue
        operation_name = str(getattr(route, "name", "") or "").strip()
        auth_boundary = _endpoint_auth_boundary(route)
        for method in sorted(str(value).upper() for value in methods):
            if method not in {"DELETE", "GET", "PATCH", "POST", "PUT"}:
                continue
            result.append(
                {
                    "capability_id": f"api.{clean_service_id}.{method.lower()}.{operation_name or len(result)}",
                    "kind": "backend_api_endpoint",
                    "service_id": clean_service_id,
                    "method": method,
                    "path": path,
                    "operation_name": operation_name or None,
                    "authorization": auth_boundary,
                    # A route is not an action binding. It stays unavailable
                    # to a planner until an audited action/service adapter
                    # says which contract owns its inputs and settlement.
                    "binding_status": "discovered_unbound",
                }
            )
    return sorted(
        result, key=lambda item: (item["path"], item["method"], item["operation_name"] or "")
    )


def _source_auth_boundary(node: ast.AST) -> str:
    """Read a declared auth dependency from a route source fallback."""
    names = {child.id for child in ast.walk(node) if isinstance(child, ast.Name)}
    if "require_vault_owner_token" in names:
        return "vault_owner"
    if "require_firebase_auth" in names:
        return "firebase_auth"
    return "not_declared"


def _discover_service_api_endpoints_from_source(service_id: str) -> list[dict[str, Any]]:
    """Fallback discovery when importing an optional router is unavailable.

    Router imports can legitimately be blocked during a minimal contract test
    because they initialise the production security settings. Parsing the
    checked-in FastAPI decorator syntax keeps the graph inspectable without
    weakening the runtime or requiring a fake environment credential. It is
    read-only metadata and retains the same `discovered_unbound` boundary.
    """
    clean_service_id = _service_key(service_id)
    if not clean_service_id:
        return []
    source_path = (
        Path(__file__).resolve().parents[2] / "api" / "routes" / "one" / f"{clean_service_id}.py"
    )
    try:
        tree = ast.parse(source_path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError, UnicodeDecodeError):
        return []
    prefix = ""
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(
            isinstance(target, ast.Name) and target.id == "router" for target in node.targets
        ):
            continue
        if not isinstance(node.value, ast.Call):
            continue
        for keyword in node.value.keywords:
            if keyword.arg == "prefix" and isinstance(keyword.value, ast.Constant):
                prefix = str(keyword.value.value or "").strip()
                break
    result: list[dict[str, Any]] = []
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
                continue
            if (
                not isinstance(decorator.func.value, ast.Name)
                or decorator.func.value.id != "router"
            ):
                continue
            method = str(decorator.func.attr or "").upper()
            if method not in {"DELETE", "GET", "PATCH", "POST", "PUT"}:
                continue
            if not decorator.args or not isinstance(decorator.args[0], ast.Constant):
                continue
            route_path = str(decorator.args[0].value or "").strip()
            if not route_path.startswith("/"):
                continue
            path = f"{prefix.rstrip('/')}{route_path}" if prefix else route_path
            result.append(
                {
                    "capability_id": f"api.{clean_service_id}.{method.lower()}.{node.name}",
                    "kind": "backend_api_endpoint",
                    "service_id": clean_service_id,
                    "method": method,
                    "path": path,
                    "operation_name": node.name,
                    "authorization": _source_auth_boundary(node),
                    "binding_status": "discovered_unbound",
                }
            )
    return sorted(
        result, key=lambda item: (item["path"], item["method"], item["operation_name"] or "")
    )


@lru_cache(maxsize=32)
def _discover_service_api_endpoints_cached(service_id: str) -> tuple[dict[str, Any], ...]:
    """Discover a conventional One service router lazily and safely.

    A service only opts in when it has an actual ``api.routes.one.<service>``
    router. No guessed URL is ever constructed as an executable target.
    """
    clean_service_id = _service_key(service_id)
    if not clean_service_id:
        return ()
    try:
        module = importlib.import_module(f"api.routes.one.{clean_service_id}")
        router = getattr(module, "router", None)
        discovered = _discover_service_api_endpoints_from_router(clean_service_id, router)
        if discovered:
            return tuple(discovered)
    except Exception:  # noqa: BLE001 - optional service modules must not block graph compile
        pass
    return tuple(_discover_service_api_endpoints_from_source(clean_service_id))


def list_service_api_endpoints(service_id: str | None) -> list[dict[str, Any]]:
    """List real service endpoints as metadata, never as inferred executors."""
    clean_service_id = _service_key(service_id)
    return [dict(item) for item in _discover_service_api_endpoints_cached(clean_service_id)]


def _service_requires_native_permission(
    service_id: str,
    terminal_action_ids: Iterable[str],
    actions_by_id: Mapping[str, Mapping[str, Any]],
    native_actions: Iterable[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Join explicit native tools to generated permission prerequisites."""
    candidate_actions = [
        dict(action)
        for action in native_actions
        if _service_key(action.get("service_id")) == _service_key(service_id)
    ]
    if not candidate_actions:
        return []
    prerequisites: list[str] = []
    for action_id in terminal_action_ids:
        action = actions_by_id.get(action_id)
        if not isinstance(action, Mapping):
            continue
        reachability = action.get("reachability")
        reachability = reachability if isinstance(reachability, Mapping) else {}
        prerequisites.extend(_clean_strings(reachability.get("navigation_prerequisites")))
        prerequisites.extend(_clean_strings(action.get("state_exposure")))
    if not any("permission" in item.lower() for item in prerequisites):
        return []
    return candidate_actions


def _slot_json_schema(entry: Mapping[str, Any]) -> dict[str, Any]:
    """Build a conservative MCP-compatible JSON Schema from goal slots."""
    goal = entry.get("goal") if isinstance(entry.get("goal"), Mapping) else {}
    properties: dict[str, Any] = {}
    required: list[str] = []
    for raw_spec in goal.get("required_inputs", []) if isinstance(goal, Mapping) else []:
        if not isinstance(raw_spec, Mapping):
            continue
        slot = str(raw_spec.get("slot") or raw_spec.get("name") or "").strip()
        if not slot:
            continue
        resolver = str(raw_spec.get("resolver") or "").strip()
        description = str(raw_spec.get("prompt") or "").strip()
        properties[slot] = {
            "type": "string",
            **({"description": description} if description else {}),
            **({"x-hushh-resolver": resolver} if resolver else {}),
        }
        if raw_spec.get("required") and raw_spec.get("default_value") in (None, ""):
            required.append(slot)
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        # A selected capability is an authority boundary: an undeclared model
        # field cannot sneak through as a new input. Contract authors must add
        # every accepted slot to the generated action contract explicitly.
        "additionalProperties": False,
    }


def _output_json_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "status": {"type": "string"},
            "message": {"type": "string"},
            "action_id": {"type": "string"},
        },
        "required": ["status"],
        "additionalProperties": False,
    }


def _entity_requirements(entry: Mapping[str, Any]) -> list[str]:
    goal = entry.get("goal") if isinstance(entry.get("goal"), Mapping) else {}
    entities: list[str] = []
    for raw_spec in goal.get("required_inputs", []) if isinstance(goal, Mapping) else []:
        if not isinstance(raw_spec, Mapping):
            continue
        text = " ".join(
            str(raw_spec.get(key) or "") for key in ("slot", "name", "resolver")
        ).lower()
        entity: str | None = None
        if "person" in text or "recipient" in text:
            entity = "entity.person"
        elif "circle" in text:
            entity = "entity.circle"
        elif "request" in text:
            entity = "entity.request"
        elif "symbol" in text or "ticker" in text:
            entity = "entity.security"
        if entity and entity not in entities:
            entities.append(entity)
    return entities


def _render_surface(entry: Mapping[str, Any], *, server_direct: bool) -> str | None:
    if server_direct:
        return "render.data_card"
    action_id = str(entry.get("action_id") or "")
    target = (
        entry.get("execution_target") if isinstance(entry.get("execution_target"), Mapping) else {}
    )
    if requires_card_confirmation(action_id):
        return "render.confirmation_card"
    if (
        str(entry.get("execution_policy") or "allow_direct") == "manual_only"
        or str(target.get("status") or "unwired") != "wired"
    ):
        # This is metadata for an existing safe card/catalog surface, not a
        # new directive. It lets every RENDER result name a render contract
        # even when the generated action is currently unavailable.
        return "render.data_card"
    if _entity_requirements(entry):
        return "render.entity_picker"
    goal = entry.get("goal") if isinstance(entry.get("goal"), Mapping) else {}
    if goal and goal.get("required_inputs"):
        return "render.form"
    return None


def _outcome(entry: Mapping[str, Any], *, server_direct: bool) -> str:
    target = (
        entry.get("execution_target") if isinstance(entry.get("execution_target"), Mapping) else {}
    )
    if server_direct:
        return "EXECUTE"
    if is_navigation_action(dict(entry)) or target.get("path") == "route":
        return "NAVIGATE"
    if str(
        entry.get("execution_policy") or "allow_direct"
    ) == "manual_only" or requires_card_confirmation(str(entry.get("action_id") or "")):
        return "RENDER"
    return "EXECUTE"


def requires_card_confirmation(action_id: str | None) -> bool:
    """Whether the product requires an existing trusted confirmation card.

    The answer is intentionally an allowlist rather than a model hint or a
    route-derived property. Existing local handlers still receive a typed,
    ledger-backed action directive; they simply run once their required slots
    are present unless this narrow policy or a platform activation boundary
    says otherwise.
    """
    return str(action_id or "").strip() in HARD_CARD_CONFIRMATION_ACTION_IDS


def confirmation_method_allowed(action_id: str | None, method: str | None) -> bool:
    """Validate the browser-declared confirmation path for a hard card.

    `tap`, `voice`, and `journey_grant` remain valid transport labels for
    ordinary actions. The narrow hard-card policy accepts only a physical card
    tap; the relay is the enforcement point because it receives the
    confirmation frame before it mints or consumes a ledger receipt.
    """
    return not requires_card_confirmation(action_id) or str(method or "").strip() == "tap"


def _action_capability(entry: Mapping[str, Any]) -> dict[str, Any]:
    action_id = str(entry.get("action_id") or "").strip()
    server_direct = action_id in SERVER_DIRECT_ACTION_IDS
    server_direct_binding = SERVER_DIRECT_CAPABILITY_BINDINGS.get(action_id)
    direct_binding = server_direct_binding if isinstance(server_direct_binding, Mapping) else {}
    if server_direct and not direct_binding:
        # Compilation also validates the registry globally, but keep this
        # local guard so an EXECUTE contract can never be emitted from an id
        # allowlist without its audited binding metadata.
        raise ValueError(f"Server-direct capability {action_id} lacks an audited binding.")
    target = (
        entry.get("execution_target") if isinstance(entry.get("execution_target"), Mapping) else {}
    )
    goal = entry.get("goal") if isinstance(entry.get("goal"), Mapping) else {}
    reachability = (
        entry.get("reachability") if isinstance(entry.get("reachability"), Mapping) else {}
    )
    navigation_routes = _clean_strings(reachability.get("routes"))
    navigation_fallback = str(target.get("target") or "").strip() or (
        navigation_routes[0] if is_navigation_action(dict(entry)) and navigation_routes else None
    )
    guards = _clean_strings(entry.get("guard_ids"))
    aliases = _clean_strings(entry.get("aliases"))
    label = str(entry.get("label") or action_id).strip()
    if label and label not in aliases:
        aliases.insert(0, label)
    confirmation_required = not server_direct and requires_card_confirmation(action_id)
    entrypoints = _clean_strings(goal.get("entrypoint_support")) or list(DEFAULT_ACTION_ENTRYPOINTS)
    target_path = str(target.get("path") or "")
    target_ref = str(target.get("target") or "")
    if server_direct:
        # The generated gateway keeps a legacy local-handler reference for
        # the visual Location form.  That reference is presentation-only: a
        # server-direct capability must never advertise it as its executable
        # target, or Siri/typed clients will incorrectly call the page handler
        # instead of the audited backend binding.
        navigation_fallback = navigation_routes[0] if navigation_routes else None
        side_effect = "backend_mutation"
        settlement_proof = str(direct_binding["settlement_proof"])
        binding_ref = str(direct_binding["binding_ref"])
    elif is_navigation_action(dict(entry)) or target_path == "route":
        side_effect = "navigation"
        settlement_proof = "validated_route_settlement"
        binding_ref = f"route:{target_ref or action_id}"
    elif target_path in {"control", "local_handler"}:
        side_effect = "client_semantic_action"
        settlement_proof = "directive_ledger_settlement"
        binding_ref = f"semantic_action:{target_ref or action_id}"
    else:
        side_effect = "render_or_guidance"
        settlement_proof = "approved_render_acknowledgement"
        binding_ref = f"render:{action_id}"
    authorization_predicates = [
        {
            "id": guard_id,
            "authority": "server",
            "effect": "required",
        }
        for guard_id in guards
    ]
    return {
        "capability_id": action_id,
        "kind": "action",
        "version": 1,
        "label": label,
        "description": str(entry.get("meaning") or "").strip(),
        "aliases": aliases,
        "search_keywords": _clean_strings(entry.get("search_keywords")),
        # MCP-compatible field spelling is intentional.  Keep the snake_case
        # aliases while clients migrate to the shared contract.
        "inputSchema": _slot_json_schema(entry),
        "input_schema": _slot_json_schema(entry),
        "outputSchema": _output_json_schema(),
        "output_schema": _output_json_schema(),
        "execution": {
            "outcome": _outcome(entry, server_direct=server_direct),
            "mode": "server_direct" if server_direct else "client_directive",
            "executor": {
                "kind": (
                    str(direct_binding["executor_kind"])
                    if server_direct
                    else "existing_ui_semantic_action"
                    if str(target.get("path") or "") in {"control", "local_handler"}
                    else "existing_route"
                    if str(target.get("path") or "") == "route"
                    else "typed_render"
                ),
                "settlement": (
                    str(direct_binding["settlement_proof"])
                    if server_direct
                    else "directive_ledger_settlement"
                ),
            },
            "target": {
                "status": "wired" if server_direct else str(target.get("status") or "unwired"),
                "path": "backend_service" if server_direct else target_path,
                "target": (str(direct_binding["binding_ref"]) if server_direct else target_ref),
            },
            "binding_ref": binding_ref,
        },
        "required_entities": _entity_requirements(entry),
        "preconditions": {
            "guard_ids": guards,
            "requires_signed_in": "auth_signed_in" in guards,
            "requires_vault": entry.get("siri_requires_vault") is True,
            "mounted_surface_required": not server_direct and not is_navigation_action(dict(entry)),
        },
        "availability": {
            # `list_action_gateway_actions()` has already applied the product
            # availability filter. Keep that fact explicit in the compiled
            # contract without pretending a client route can grant access.
            "product_available": True,
            "feature_flags": [],
        },
        "authorization": {
            "guard_ids": guards,
            "server_revalidation": "identity_consent_and_domain_service",
            "predicates": authorization_predicates,
            "ownership": "server_resolved_for_target_entity",
        },
        "side_effect": {"classification": side_effect},
        "idempotency": {
            "strategy": (
                str(direct_binding.get("idempotency", {}).get("strategy"))
                if server_direct
                else "action_directive_ledger"
            ),
            "scope": (
                str(direct_binding.get("idempotency", {}).get("scope"))
                if server_direct
                else "action_and_normalized_slots"
            ),
        },
        "confirmation": {
            "required": confirmation_required,
            "mode": "trusted_tap" if confirmation_required else "none",
            "surface": "render.confirmation_card" if confirmation_required else None,
            "requires_trusted_tap": confirmation_required
            or str(entry.get("activation_policy") or "") == "trusted_activation_required",
        },
        "technical_interaction": {
            "policy": "platform_required_only",
            "requires_user_interaction": False,
            "allowed_types": ["oauth", "native_permission"],
        },
        "navigation": {
            "routes": navigation_routes,
            "screens": _clean_strings(reachability.get("screens")),
            "fallback": navigation_fallback,
        },
        "render_surface": _render_surface(entry, server_direct=server_direct),
        "settlement_proof": settlement_proof,
        "telemetry_event": "app_intelligence.action",
        "supported_entrypoints": entrypoints,
        "goal_id": str(goal.get("goal_id") or "") if isinstance(goal, Mapping) else "",
    }


_REQUIRED_ACTION_CONTRACT_FIELDS: frozenset[str] = frozenset(
    {
        "capability_id",
        "version",
        "kind",
        "aliases",
        "inputSchema",
        "outputSchema",
        "execution",
        "required_entities",
        "preconditions",
        "availability",
        "authorization",
        "side_effect",
        "confirmation",
        "technical_interaction",
        "idempotency",
        "navigation",
        "render_surface",
        "settlement_proof",
        "telemetry_event",
        "supported_entrypoints",
    }
)


def _validate_action_capability_contracts(capabilities: Iterable[Mapping[str, Any]]) -> None:
    """Fail graph compilation if an action lacks its audited runtime contract."""

    for capability in capabilities:
        action_id = str(capability.get("capability_id") or "").strip()
        missing = sorted(_REQUIRED_ACTION_CONTRACT_FIELDS - set(capability))
        if not action_id or missing:
            raise ValueError(
                f"Capability action contract is incomplete for {action_id or 'unknown'}: {', '.join(missing)}"
            )
        for schema_key in ("inputSchema", "outputSchema"):
            schema = capability.get(schema_key)
            if not isinstance(schema, Mapping) or schema.get("additionalProperties") is not False:
                raise ValueError(f"Capability {action_id} has a non-strict {schema_key}.")
        execution = capability.get("execution")
        if not isinstance(execution, Mapping) or not str(execution.get("binding_ref") or ""):
            raise ValueError(f"Capability {action_id} lacks an execution binding reference.")
        if not str(capability.get("settlement_proof") or ""):
            raise ValueError(f"Capability {action_id} lacks a settlement proof contract.")
        if not isinstance(capability.get("supported_entrypoints"), list):
            raise ValueError(f"Capability {action_id} lacks entrypoint support metadata.")


def _service_id_from_setup_open_action(action_id: str) -> str | None:
    """Return the generated service id for a canonical setup entry action."""
    match = _SETUP_OPEN_ACTION_RE.fullmatch(str(action_id or "").strip())
    return match.group(1) if match is not None else None


def _service_label(service_id: str) -> str:
    """Present a generated service id without treating it as model authority."""
    return str(service_id or "").replace("_", " ").replace("-", " ").title()


def _persisted_service_id(service_id: str) -> str:
    """Resolve an action suffix to the existing durable setup-state id.

    Generated action ids use underscores, while an existing service registry
    may use a hyphenated canonical id (for example, a future/generated
    ``open_connected_systems`` action). Ask that registry rather than adding a
    service-specific mapping here; unknown future services retain their
    generated id until the durable registry admits them.
    """
    clean = str(service_id or "").strip()
    if not clean:
        return clean
    try:
        from hushh_mcp.onboarding_contract import normalize_setup_capability_ids

        candidates = [clean]
        hyphenated = clean.replace("_", "-")
        if hyphenated != clean:
            candidates.append(hyphenated)
        normalized = normalize_setup_capability_ids(candidates)
        if normalized:
            return str(normalized[0])
    except Exception:  # noqa: BLE001 - compiler remains available during partial startup
        pass
    return clean


def _service_onboarding_aliases(service_id: str, entry: Mapping[str, Any]) -> list[str]:
    """Add bounded workflow phrasing to generated action aliases.

    This makes natural requests such as ``onboard me for Location`` resolve
    to the same generated setup entry action. The aliases are compiler output,
    not a product-specific prompt list, so future generated setup services
    gain the same language automatically.
    """
    display = _service_label(service_id)
    aliases = _clean_strings(entry.get("aliases"))
    for alias in (
        f"onboard me for {display}",
        f"onboard me for {service_id.replace('_', ' ')}",
        f"onboard {display}",
        f"start {display} onboarding",
        f"resume {display} onboarding",
        f"{display} onboarding",
    ):
        if alias not in aliases:
            aliases.append(alias)
    return aliases


def _validate_location_python_refs(owner: str, record: Mapping[str, Any]) -> list[str]:
    """Resolve every audited Python binding used by Location knowledge.

    This runs only while compiling the checked-in graph. Runtime candidate
    retrieval never imports or scans implementation modules. Requiring an
    exact callable here prevents a misspelled registry entry from being
    published as a wired capability.
    """

    status = str(record.get("status") or "").strip()
    if status != "wired":
        raise ValueError(f"Location knowledge {owner} is not wired.")
    raw_refs = record.get("implementation_refs")
    refs = _clean_strings(raw_refs if isinstance(raw_refs, list) else [])
    if not refs:
        raise ValueError(f"Location knowledge {owner} has no implementation reference.")
    for reference in refs:
        module_name, separator, qualified_name = reference.partition(":")
        if (
            not separator
            or not module_name
            or not qualified_name
            or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", qualified_name)
        ):
            raise ValueError(
                f"Location knowledge {owner} has invalid implementation reference {reference}."
            )
        try:
            target: Any = importlib.import_module(module_name)
            for component in qualified_name.split("."):
                target = getattr(target, component)
        except (ImportError, AttributeError) as exc:
            raise ValueError(
                f"Location knowledge {owner} cannot resolve implementation {reference}."
            ) from exc
        if not callable(target):
            raise ValueError(
                f"Location knowledge {owner} implementation {reference} is not callable."
            )
    return refs


def _validate_location_interaction_surfaces(
    owner: str,
    record: Mapping[str, Any],
    *,
    expected_render_surface: str | None,
) -> list[str]:
    """Validate exact server directives against the one approved renderer."""

    module_name, _separator, qualified_name = _LOCATION_RUNTIME_SURFACE_REGISTRY_REF.partition(":")
    try:
        runtime_module = importlib.import_module(module_name)
        runtime_surface_registry: Any = runtime_module
        for component in qualified_name.split("."):
            runtime_surface_registry = getattr(runtime_surface_registry, component)
        kind_module_name, _kind_separator, kind_qualified_name = (
            _LOCATION_RUNTIME_DIRECTIVE_KIND_REGISTRY_REF.partition(":")
        )
        runtime_kind_registry: Any = importlib.import_module(kind_module_name)
        for component in kind_qualified_name.split("."):
            runtime_kind_registry = getattr(runtime_kind_registry, component)
    except (ImportError, AttributeError) as exc:
        raise ValueError(
            "Location runtime interaction surface registry cannot be resolved."
        ) from exc
    if not isinstance(runtime_surface_registry, Mapping) or not isinstance(
        runtime_kind_registry, Mapping
    ):
        raise ValueError("Location runtime interaction surface registry is invalid.")

    raw_surface_ids = record.get("interaction_surface_ids")
    surface_ids = _clean_strings(raw_surface_ids if isinstance(raw_surface_ids, list) else [])
    if expected_render_surface is not None and not surface_ids:
        raise ValueError(f"Location knowledge {owner} has no typed interaction surface contract.")
    for surface_id in surface_ids:
        surface = LOCATION_KNOWLEDGE_INTERACTION_SURFACE_REGISTRY.get(surface_id)
        if not isinstance(surface, Mapping) or surface.get("status") != "wired":
            raise ValueError(
                f"Location knowledge {owner} references unavailable surface {surface_id}."
            )
        if (
            surface.get("render_capability_id") != "render.one_location_workflow_card"
            or surface.get("renderer_key") != "one_location_workflow_card"
        ):
            raise ValueError(
                f"Location knowledge surface {surface_id} is not bound to the approved renderer."
            )
        runtime_contract = runtime_surface_registry.get(surface_id)
        result_descriptors = surface.get("allowed_results")
        if not isinstance(result_descriptors, list):
            raise ValueError(
                f"Location knowledge surface {surface_id} has invalid result descriptors."
            )
        result_codes = [
            str(descriptor.get("result") or "")
            for descriptor in result_descriptors
            if isinstance(descriptor, Mapping)
        ]
        if (
            runtime_contract is None
            or str(getattr(runtime_contract, "surface_id", "") or "") != surface_id
            or str(getattr(runtime_contract, "title_key", "") or "")
            != str(surface.get("title_key") or "")
            or str(getattr(runtime_contract, "body_key", "") or "")
            != str(surface.get("body_key") or "")
            or list(getattr(runtime_contract, "allowed_actions", ()) or ()) != result_codes
            or str(runtime_kind_registry.get(surface_id) or "")
            != str(surface.get("directive_kind") or "")
        ):
            raise ValueError(
                f"Location knowledge surface {surface_id} has no runtime directive contract."
            )
        if not result_codes or len(result_codes) != len(result_descriptors):
            raise ValueError(
                f"Location knowledge surface {surface_id} has invalid result descriptors."
            )
        if any(
            not str(descriptor.get("label_key") or "").startswith("one.location.result.")
            or descriptor.get("presentation") not in {"button", "native_result", "app_result"}
            or (
                descriptor.get("button_role") not in {"primary", "secondary"}
                if descriptor.get("presentation") == "button"
                else descriptor.get("button_role") is not None
            )
            for descriptor in result_descriptors
            if isinstance(descriptor, Mapping)
        ):
            raise ValueError(
                f"Location knowledge surface {surface_id} has incomplete button metadata."
            )
        result_schema_ref = str(surface.get("result_schema_ref") or "")
        if result_schema_ref != (
            "api.routes.one.capability_runtime:LocationOnboardingInteractionRequest"
        ):
            raise ValueError(
                f"Location knowledge surface {surface_id} has an unknown result schema ref."
            )
        try:
            api_tree = ast.parse(_LOCATION_WORKFLOW_API_CONTRACT_PATH.read_text(encoding="utf-8"))
        except (OSError, SyntaxError, UnicodeDecodeError) as exc:
            raise ValueError("Location workflow API result schema is unavailable.") from exc
        request_contract = next(
            (
                node
                for node in api_tree.body
                if isinstance(node, ast.ClassDef)
                and node.name == "LocationOnboardingInteractionRequest"
            ),
            None,
        )
        request_fields = (
            {
                str(node.target.id)
                for node in request_contract.body
                if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)
            }
            if isinstance(request_contract, ast.ClassDef)
            else set()
        )
        api_result_codes: set[str] = set()
        for node in api_tree.body:
            if not isinstance(node, ast.Assign) or not any(
                isinstance(target, ast.Name) and target.id == "LocationInteractionResult"
                for target in node.targets
            ):
                continue
            api_result_codes.update(
                str(value.value)
                for value in ast.walk(node.value)
                if isinstance(value, ast.Constant) and isinstance(value.value, str)
            )
        if (
            request_contract is None
            or not {
                "run_revision",
                "lease_id",
                "result",
                "draft_metadata",
                "position_observation",
            }.issubset(request_fields)
            or not set(result_codes).issubset(api_result_codes)
        ):
            raise ValueError(f"Location knowledge surface {surface_id} result schema ref is stale.")
        result_schema = surface.get("result_schema")
        schema_variants = result_schema.get("oneOf") if isinstance(result_schema, Mapping) else None
        schema_results = [
            str((variant.get("properties") or {}).get("result", {}).get("const") or "")
            for variant in schema_variants or []
            if isinstance(variant, Mapping) and isinstance(variant.get("properties"), Mapping)
        ]
        if (
            schema_results != result_codes
            or len(schema_results) != len(schema_variants or [])
            or any(
                variant.get("additionalProperties") is not False
                for variant in schema_variants or []
                if isinstance(variant, Mapping)
            )
        ):
            raise ValueError(
                f"Location knowledge surface {surface_id} has an invalid result payload schema."
            )
        if (
            expected_render_surface is not None
            and surface.get("render_capability_id") != expected_render_surface
        ):
            raise ValueError(
                f"Location knowledge {owner} surface {surface_id} does not match "
                f"{expected_render_surface}."
            )
    return surface_ids


def _validate_location_workflow_migrations(package: Mapping[str, Any]) -> None:
    """Require authored migrations to match the durable runtime exactly."""

    try:
        runtime_module = importlib.import_module(_LOCATION_RUNTIME_MODULE)
        runtime_version = int(runtime_module.LOCATION_ONBOARDING_WORKFLOW_VERSION)
        runtime_migrations = getattr(
            runtime_module,
            "LOCATION_CURSOR_MIGRATIONS_BY_FROM_VERSION",
            {1: runtime_module.LOCATION_V1_CURSOR_MIGRATIONS},
        )
    except (ImportError, AttributeError) as exc:
        raise ValueError("Location runtime migration registry cannot be resolved.") from exc
    package_version = int(package.get("workflow_version") or 0)
    if package_version != runtime_version:
        raise ValueError("Location knowledge workflow version has no audited durable runtime.")
    if not isinstance(runtime_migrations, Mapping):
        raise ValueError("Location runtime migration registry is invalid.")

    package_migrations = {
        int(migration.get("from_workflow_version") or 0): {
            str(source): str(target)
            for source, target in dict(migration.get("cursor_map") or {}).items()
        }
        for migration in package.get("migrations") or []
        if isinstance(migration, Mapping)
    }
    expected_migrations = {
        int(version): {str(source): str(target) for source, target in dict(cursor_map).items()}
        for version, cursor_map in runtime_migrations.items()
        if isinstance(cursor_map, Mapping)
    }
    if package_migrations != expected_migrations:
        raise ValueError(
            "Location knowledge cursor migration contract does not match the durable runtime."
        )


def _validate_location_workflow_liveness(package: Mapping[str, Any]) -> None:
    """Reject authored graphs that can strand a required Location run.

    Schema validation proves that every edge names a real node; it does not
    prove that a newly added/reordered node is reachable or that a retry loop
    can still reach verified settlement.  This build-time graph walk keeps
    those operational properties in the KGS contract instead of discovering a
    dead end on a person's phone.
    """
    steps = {
        str(step.get("step_id") or ""): step
        for step in package.get("steps") or []
        if isinstance(step, Mapping) and str(step.get("step_id") or "")
    }
    initial = str(package.get("initial_step_id") or "")
    reachable: set[str] = set()
    pending = [initial]
    while pending:
        cursor = pending.pop()
        if cursor in reachable or cursor not in steps:
            continue
        reachable.add(cursor)
        for transition in steps[cursor].get("transitions") or []:
            if not isinstance(transition, Mapping):
                continue
            target = str(transition.get("target") or "")
            if target in steps and target not in reachable:
                pending.append(target)
    unreachable = sorted(set(steps) - reachable)
    if unreachable:
        raise ValueError(
            "Location knowledge workflow has unreachable steps: " + ", ".join(unreachable)
        )

    can_verify = {
        step_id
        for step_id, step in steps.items()
        if any(
            isinstance(transition, Mapping) and transition.get("target") == "$verified_succeeded"
            for transition in step.get("transitions") or []
        )
    }
    changed = True
    while changed:
        changed = False
        for step_id, step in steps.items():
            if step_id in can_verify:
                continue
            if any(
                isinstance(transition, Mapping)
                and str(transition.get("target") or "") in can_verify
                for transition in step.get("transitions") or []
            ):
                can_verify.add(step_id)
                changed = True
    stranded = sorted(set(steps) - can_verify)
    if stranded:
        raise ValueError(
            "Location knowledge workflow cannot reach verified settlement from: "
            + ", ".join(stranded)
        )


def _validate_location_interaction_surface_catalog() -> None:
    """Keep the complete generated client catalog equal to server authority."""

    try:
        runtime_module = importlib.import_module(_LOCATION_RUNTIME_MODULE)
        runtime_surfaces = runtime_module.LOCATION_APPROVED_SURFACE_CONTRACTS
        runtime_kinds = runtime_module.LOCATION_DIRECTIVE_KIND_BY_SURFACE
    except (ImportError, AttributeError) as exc:
        raise ValueError(
            "Location runtime interaction surface catalog cannot be resolved."
        ) from exc
    if not isinstance(runtime_surfaces, Mapping) or not isinstance(runtime_kinds, Mapping):
        raise ValueError("Location runtime interaction surface catalog is invalid.")
    compiler_ids = set(LOCATION_KNOWLEDGE_INTERACTION_SURFACE_REGISTRY)
    if compiler_ids != set(runtime_surfaces) or compiler_ids != set(runtime_kinds):
        raise ValueError(
            "Location generated interaction surface catalog does not match the durable runtime."
        )
    _validate_location_interaction_surfaces(
        "workflow interaction catalog",
        {"interaction_surface_ids": sorted(compiler_ids)},
        expected_render_surface="render.one_location_workflow_card",
    )


def _resolve_location_knowledge_binding(
    step: Mapping[str, Any],
    *,
    actions_by_id: Mapping[str, Mapping[str, Any]],
    native_actions_by_id: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    """Resolve one authored Location binding against audited registries."""

    step_id = str(step.get("step_id") or "").strip()
    binding = step.get("binding") if isinstance(step.get("binding"), Mapping) else {}
    kind = str(binding.get("kind") or "").strip()
    ref = str(binding.get("ref") or "").strip()
    if kind == "generated_action":
        action = actions_by_id.get(ref)
        target = action.get("execution_target") if isinstance(action, Mapping) else None
        if not isinstance(target, Mapping) or target.get("status") != "wired":
            raise ValueError(
                f"Location knowledge step {step_id} references unwired generated action {ref}."
            )
        resolved: dict[str, Any] = {
            "kind": kind,
            "ref": ref,
            "status": "wired",
            "execution_path": str(target.get("path") or ""),
        }
    elif kind == "native_semantic_action":
        native = native_actions_by_id.get(ref)
        if not isinstance(native, Mapping):
            raise ValueError(
                f"Location knowledge step {step_id} references unknown native action {ref}."
            )
        registered = LOCATION_KNOWLEDGE_BINDING_REGISTRY.get(ref)
        if not isinstance(registered, Mapping) or str(registered.get("kind") or "") != kind:
            raise ValueError(
                f"Location knowledge step {step_id} has no audited native binding {ref}."
            )
        _validate_location_python_refs(f"binding {ref}", registered)
        resolved = {
            "kind": kind,
            "ref": ref,
            **json.loads(json.dumps(registered, sort_keys=True, default=str)),
            "tool_name": str(native.get("tool_name") or ""),
            "source_dispatch_status": str(native.get("dispatch_status") or "route_owned"),
        }
    else:
        registered = LOCATION_KNOWLEDGE_BINDING_REGISTRY.get(ref)
        if not isinstance(registered, Mapping) or str(registered.get("kind") or "") != kind:
            raise ValueError(
                f"Location knowledge step {step_id} references unknown {kind} binding {ref}."
            )
        _validate_location_python_refs(f"binding {ref}", registered)
        resolved = {
            "kind": kind,
            "ref": ref,
            **json.loads(json.dumps(registered, sort_keys=True, default=str)),
        }

    render_surface = str(step.get("render_surface") or "").strip() or None
    approved_surface_ids = {
        str(surface.get("capability_id") or "") for surface in APPROVED_RENDER_SURFACES
    }
    if render_surface is not None and render_surface not in approved_surface_ids:
        raise ValueError(
            f"Location knowledge step {step_id} uses unapproved render surface {render_surface}."
        )
    allowed_surfaces = resolved.get("render_surfaces")
    if (
        render_surface is not None
        and isinstance(allowed_surfaces, list)
        and render_surface not in allowed_surfaces
    ):
        raise ValueError(
            f"Location knowledge binding {ref} does not allow render surface {render_surface}."
        )
    _validate_location_interaction_surfaces(
        f"binding {ref}",
        resolved,
        expected_render_surface=render_surface,
    )
    return resolved


def _compile_location_knowledge_workflow(
    base_workflow: Mapping[str, Any],
    package: Mapping[str, Any],
    *,
    actions_by_id: Mapping[str, Mapping[str, Any]],
    native_actions: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    """Compile Location's ServiceKnowledgePackageV2 into its durable workflow.

    The package is now the authored transition and semantic truth.  The
    registries below only prove that a declared binding, verifier, and card
    implementation exist; they must not become a second product workflow.
    """

    package = ServiceKnowledgePackageV2.model_validate(dict(package)).model_dump(mode="json")

    workflow_implementation_refs = _validate_location_python_refs(
        "workflow workflow.setup.location",
        LOCATION_KNOWLEDGE_WORKFLOW_BINDING,
    )
    _validate_location_workflow_migrations(package)
    _validate_location_workflow_liveness(package)

    expected = {
        "workflow_id": str(base_workflow.get("capability_id") or ""),
        "service_id": str(base_workflow.get("service_id") or ""),
        "entry_action_id": str(base_workflow.get("entry_action_id") or ""),
        "route_pattern": str(base_workflow.get("route_pattern") or ""),
        "screen": str(base_workflow.get("screen") or ""),
    }
    for field, expected_value in expected.items():
        if str(package.get(field) or "") != expected_value:
            raise ValueError(
                f"Location knowledge package {field} does not match the generated route workflow."
            )
    completion_action_id = str(package.get("completion_action_id") or "")
    if completion_action_id not in set(base_workflow.get("completion_action_ids") or []):
        raise ValueError(
            "Location knowledge completion_action_id is not a wired workflow completion action."
        )

    native_actions_by_id = {
        str(action.get("capability_id") or ""): action
        for action in native_actions
        if isinstance(action, Mapping) and str(action.get("capability_id") or "")
    }
    step_ids = {
        str(step.get("step_id") or "")
        for step in package.get("steps") or []
        if isinstance(step, Mapping)
    }
    compiled_steps: list[dict[str, Any]] = []
    for ordinal, raw_step in enumerate(package.get("steps") or [], start=1):
        if not isinstance(raw_step, Mapping):
            raise ValueError("Location knowledge package contains an invalid step.")
        step = dict(raw_step)
        step_id = str(step.get("step_id") or "")
        binding = _resolve_location_knowledge_binding(
            step,
            actions_by_id=actions_by_id,
            native_actions_by_id=native_actions_by_id,
        )
        verifier_ref = str(step.get("verifier_ref") or "")
        verifier = LOCATION_KNOWLEDGE_VERIFIER_REGISTRY.get(verifier_ref)
        if not isinstance(verifier, Mapping):
            raise ValueError(
                f"Location knowledge step {step_id} references unknown verifier {verifier_ref}."
            )
        _validate_location_python_refs(f"verifier {verifier_ref}", verifier)
        transitions = [
            dict(transition)
            for transition in step.get("transitions") or []
            if isinstance(transition, Mapping)
        ]
        declared_predicates = {str(transition.get("when") or "") for transition in transitions}
        verifier_predicates = {
            str(predicate) for predicate in verifier.get("outcomes") or [] if str(predicate)
        }
        if declared_predicates != verifier_predicates:
            missing = sorted(verifier_predicates - declared_predicates)
            unknown = sorted(declared_predicates - verifier_predicates)
            detail = ", ".join(
                [
                    *(f"missing:{predicate}" for predicate in missing),
                    *(f"unknown:{predicate}" for predicate in unknown),
                ]
            )
            raise ValueError(
                f"Location knowledge step {step_id} has incomplete verifier predicates: {detail}."
            )
        for transition in transitions:
            target = str(transition.get("target") or "")
            if target not in step_ids and target not in _LOCATION_KNOWLEDGE_TERMINALS:
                raise ValueError(
                    f"Location knowledge step {step_id} targets unknown state {target}."
                )
        if binding.get("status") != "wired":
            raise ValueError(f"Location knowledge step {step_id} binding is not wired.")
        if verifier.get("status") != "wired":
            raise ValueError(f"Location knowledge step {step_id} verifier is not wired.")
        compiled_steps.append(
            {
                "step_id": step_id,
                "ordinal": ordinal,
                "label": str(step.get("label") or ""),
                "description": str(step.get("description") or ""),
                "intent": str(step.get("intent") or ""),
                "semantic_boundary": str(step.get("semantic_boundary") or ""),
                "outcome": str(step.get("outcome") or ""),
                "completion_policy": str(step.get("completion_policy") or ""),
                "presentation_states": _clean_strings(step.get("presentation_states")),
                "binding": binding,
                "render_surface": str(step.get("render_surface") or "") or None,
                "verifier": {
                    "ref": verifier_ref,
                    **json.loads(json.dumps(verifier, sort_keys=True, default=str)),
                },
                "transitions": transitions,
                "telemetry_event": str(step.get("telemetry_event") or ""),
            }
        )

    _validate_location_interaction_surface_catalog()

    context_projection = (
        dict(package.get("context_projection"))
        if isinstance(package.get("context_projection"), Mapping)
        else {}
    )
    max_retrieved_steps = max(
        1,
        min(3, int(context_projection.get("max_retrieved_steps") or 3)),
    )
    semantic_steps = [
        {
            "step_id": step["step_id"],
            "label": step["label"],
            "description": step["description"],
            "intent": step["intent"],
            "semantic_boundary": step["semantic_boundary"],
            "outcome": step["outcome"],
            "render_surface": step["render_surface"],
            "presentation_states": list(step["presentation_states"]),
        }
        for step in compiled_steps
    ]
    workflow = dict(base_workflow)
    plan = dict(workflow.get("plan") or {})
    plan.update(
        {
            "durability": "capability_run_v1",
            "knowledge_package_id": str(package.get("package_id") or ""),
            "knowledge_package_version": int(package.get("package_version") or 1),
            "knowledge_package_digest": location_knowledge_package_source_digest(),
            "initial_step_id": str(package.get("initial_step_id") or ""),
            "migrations": [
                dict(migration)
                for migration in package.get("migrations") or []
                if isinstance(migration, Mapping)
            ],
            "runtime_automation_ready": True,
            "runtime_automation_blockers": [],
        }
    )
    workflow.update(
        {
            "version": int(package.get("workflow_version") or 2),
            "label": str(package.get("label") or ""),
            "description": str(package.get("description") or ""),
            # Historical workflow aliases stay available to old UI/evaluation
            # callers while the new Location brain deliberately never emits
            # or ranks on them.  Keep them visibly marked as compatibility
            # data so a future model-facing consumer cannot mistake them for
            # admission authority.
            "aliases": _clean_strings(base_workflow.get("aliases")),
            "search_keywords": _clean_strings(base_workflow.get("search_keywords")),
            "legacy_aliases": _clean_strings(base_workflow.get("aliases")),
            "legacy_search_keywords": _clean_strings(base_workflow.get("search_keywords")),
            "supported_entrypoints": _clean_strings(package.get("supported_entrypoints")),
            "execution": {
                "outcome": "EXECUTE",
                "mode": "durable_capability_run",
                "binding_ref": str(LOCATION_KNOWLEDGE_WORKFLOW_BINDING.get("binding_ref") or ""),
                "executor": {
                    "kind": "backend_workflow",
                    "implementation_refs": workflow_implementation_refs,
                    "settlement": str(
                        LOCATION_KNOWLEDGE_WORKFLOW_BINDING.get("settlement_proof") or ""
                    ),
                },
                "target": {
                    "status": "wired",
                    "path": "backend_service",
                    "target": workflow_implementation_refs[0],
                },
            },
            "navigation": {
                "fallback": str(package.get("route_pattern") or ""),
                "routes": [str(package.get("route_pattern") or "")],
                "screens": [str(package.get("screen") or "")],
            },
            "settlement_proof": str(
                LOCATION_KNOWLEDGE_WORKFLOW_BINDING.get("settlement_proof") or ""
            ),
            "resume": {
                **dict(workflow.get("resume") or {}),
                "state_source": "capability_run_v1_and_server_runtime_state",
                "initial_step_id": str(package.get("initial_step_id") or ""),
                "migrations": list(plan["migrations"]),
            },
            "knowledge_package": {
                "schema_version": str(package.get("schema_version") or ""),
                "package_id": str(package.get("package_id") or ""),
                "package_version": int(package.get("package_version") or 1),
                "source_digest": location_knowledge_package_source_digest(),
                "catalog_capability_ids": sorted(
                    str(item.get("capability_id") or "")
                    for item in package.get("capabilities") or []
                    if isinstance(item, Mapping) and str(item.get("capability_id") or "")
                ),
            },
            "knowledge_projection": {
                "schema_version": LOCATION_KNOWLEDGE_PROJECTION_SCHEMA_VERSION,
                "package_id": str(package.get("package_id") or ""),
                "workflow_id": str(package.get("workflow_id") or ""),
                "workflow_version": int(package.get("workflow_version") or 2),
                "semantic_profile": {
                    "purpose": str((package.get("semantic_profile") or {}).get("purpose") or ""),
                    "user_goals": _clean_strings(
                        (package.get("semantic_profile") or {}).get("user_goals")
                    ),
                    "boundaries": _clean_strings(
                        (package.get("semantic_profile") or {}).get("boundaries")
                    ),
                },
                "allowed_fact_keys": _clean_strings(context_projection.get("allowed_fact_keys")),
                "max_retrieved_steps": max_retrieved_steps,
                "semantic_steps": semantic_steps,
            },
            **{
                policy_field: dict(package[policy_field])
                for policy_field in _LOCATION_KNOWLEDGE_POLICY_FIELDS
            },
            "interaction_surfaces": [
                {
                    "surface_id": surface_id,
                    "variant_id": surface_id,
                    "render_surface": str(surface.get("render_capability_id") or ""),
                    **json.loads(json.dumps(surface, sort_keys=True, default=str)),
                }
                for surface_id, surface in sorted(
                    LOCATION_KNOWLEDGE_INTERACTION_SURFACE_REGISTRY.items()
                )
            ],
            "steps": compiled_steps,
            "plan": plan,
        }
    )
    return workflow


def _compile_service_onboarding_workflows(
    actions: list[dict[str, Any]],
    routes: Mapping[str, Any],
    *,
    native_actions: Iterable[Mapping[str, Any]] = (),
    api_endpoints_by_service: Mapping[str, Iterable[Mapping[str, Any]]] | None = None,
    location_knowledge_package: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Compile resumable setup workflows from generated actions and routes.

    The setup gateway already identifies every service entry as
    ``setup.open_<service>``. Its route contract supplies the active surface
    and terminal local actions. This compiler deliberately does not import a
    client setup registry or hard-code a service name: a new wired generated
    setup route becomes a workflow on the next graph compilation.

    ``RENDER`` here describes the existing generated setup surface only. It
    never asks a client to render model-generated UI, and its terminal actions
    still run through the normal directive/settlement ledger.
    """
    by_id: dict[str, dict[str, Any]] = {
        str(entry.get("action_id") or "").strip(): entry
        for entry in actions
        if str(entry.get("action_id") or "").strip()
    }
    native_action_list = [dict(action) for action in native_actions if isinstance(action, Mapping)]
    endpoint_catalog = (
        api_endpoints_by_service if isinstance(api_endpoints_by_service, Mapping) else {}
    )
    workflows: list[dict[str, Any]] = []
    for action_id, entry in sorted(by_id.items()):
        service_id = _service_id_from_setup_open_action(action_id)
        if service_id is None:
            continue
        target = entry.get("execution_target")
        target = target if isinstance(target, Mapping) else {}
        route_pattern = str(target.get("target") or "").strip()
        if (
            str(target.get("status") or "") != "wired"
            or str(target.get("path") or "") != "route"
            or not route_pattern.startswith("/one/setup/")
        ):
            continue
        route = routes.get(route_pattern)
        if not isinstance(route, Mapping):
            # A route action without a generated route playbook cannot safely
            # be treated as a multi-step workflow; retain the normal action.
            continue
        playbook = route.get("voice_playbook")
        playbook = playbook if isinstance(playbook, Mapping) else {}
        route_action_ids = [
            candidate_id
            for candidate_id in _clean_strings(route.get("action_ids"))
            if candidate_id in by_id
            and str((by_id[candidate_id].get("execution_target") or {}).get("status") or "")
            == "wired"
        ]
        # Some services finish on a generated descendant route (Finance's
        # import route is the current example). Match terminal ids by the same
        # generated service suffix rather than assuming the entry route owns
        # every terminal control. These remain route-local directives; this
        # metadata never lets the runtime skip the intermediate route flow.
        terminal_action_ids = sorted(
            candidate_id
            for candidate_id, candidate_entry in by_id.items()
            if (
                (terminal_match := _SETUP_TERMINAL_ACTION_RE.fullmatch(candidate_id)) is not None
                and terminal_match.group(1) == service_id
                and str(((candidate_entry.get("execution_target") or {}).get("status") or ""))
                == "wired"
            )
        )
        finish_action_ids = [
            candidate_id
            for candidate_id in terminal_action_ids
            if candidate_id.startswith("setup.finish_")
        ]
        skip_action_ids = [
            candidate_id
            for candidate_id in terminal_action_ids
            if candidate_id.startswith("setup.skip_")
        ]
        terminal_routes = sorted(
            {
                route
                for terminal_action_id in terminal_action_ids
                for route in _clean_strings(
                    (by_id[terminal_action_id].get("reachability") or {}).get("routes")
                )
            }
        )
        screen = str(playbook.get("screen") or route.get("canonical_screen") or "").strip()
        service_label = _service_label(service_id)
        state_capability_id = _persisted_service_id(service_id)
        entry_label = str(entry.get("label") or f"Set up {service_label}").strip()
        description = str(entry.get("meaning") or "").strip()
        completion = str(playbook.get("completion_boundary") or "").strip()
        workflow_id = f"workflow.setup.{service_id}"
        native_permission_actions = _service_requires_native_permission(
            service_id,
            terminal_action_ids,
            by_id,
            native_action_list,
        )
        # The compiler may discover actual REST routes, but it must not infer
        # that one of them completes this workflow. A path is only executable
        # after a registered action/service adapter binds its input and verified
        # settlement contract. This is why Location onboarding is correctly
        # route/native-owned today rather than a fabricated POST endpoint.
        api_endpoints = [
            dict(endpoint)
            for endpoint in endpoint_catalog.get(service_id, ())
            if isinstance(endpoint, Mapping)
        ]
        backend_action_ids = [
            candidate_id
            for candidate_id in [action_id, *terminal_action_ids]
            if candidate_id in SERVER_DIRECT_ACTION_IDS
        ]
        executor_hierarchy: list[dict[str, Any]] = [
            {
                "kind": "backend_api",
                "status": "registered" if backend_action_ids else "adapter_required",
                "action_ids": backend_action_ids,
                "discovered_endpoint_count": len(api_endpoints),
                "reason": (
                    "A registered backend action has a verified service settlement."
                    if backend_action_ids
                    else "Discovered endpoints are intentionally unbound until an audited action adapter registers one."
                ),
            },
            {
                "kind": "native_semantic_action",
                "status": "route_owned"
                if native_permission_actions
                else "not_required_or_unregistered",
                "actions": native_permission_actions,
                "reason": (
                    "Use the existing route-owned native semantic action; do not synthesize a click."
                    if native_permission_actions
                    else "No generated native semantic prerequisite is registered for this setup flow."
                ),
            },
            {
                "kind": "existing_ui_semantic_action",
                "status": "registered",
                "action_ids": [action_id, *terminal_action_ids],
                "route_pattern": route_pattern,
            },
            {
                "kind": "typed_render",
                "status": "approved_existing_surface",
                "render_surface": "existing_route_surface",
                "route_pattern": route_pattern,
            },
        ]
        steps: list[dict[str, Any]] = [
            {
                "step_id": f"{workflow_id}.navigate",
                "outcome": "NAVIGATE",
                "action_id": action_id,
                "executor": "existing_ui_semantic_action",
                "route_pattern": route_pattern,
            }
        ]
        if native_permission_actions:
            steps.append(
                {
                    "step_id": f"{workflow_id}.native_permission",
                    "outcome": "EXECUTE",
                    "executor": "native_semantic_action",
                    "actions": native_permission_actions,
                    "directive": None,
                    "settlement": "client_native_interaction",
                    "description": (
                        "Request the registered device permission through its existing "
                        "semantic route integration. No generated UI or visual automation is allowed."
                    ),
                }
            )
        settlement_contract: dict[str, Any] = {
            "settlement": "persisted_onboarding_state",
            "success_requires": {
                "source": "vault_keys",
                "state_capability_id": state_capability_id,
                "condition": "setup_capability_ids_contains_service",
            },
        }
        if workflow_id == _LOCATION_ONBOARDING_WORKFLOW_ID:
            # Location's historical generic setup marker remains a prerequisite
            # for the existing setup journey, but it is not a terminal proof.
            # Only a backend adapter may attach the four opaque receipts to the
            # durable run; no browser/native callback may substitute for them.
            settlement_contract = {
                "settlement": "server_location_onboarding_completion_receipt",
                "success_requires": {
                    "source": "capability_run_and_vault_keys",
                    "capability_id": workflow_id,
                    "receipt_schema": LOCATION_ONBOARDING_COMPLETION_RECEIPT_SCHEMA_VERSION,
                    "condition": (
                        "server_location_onboarding_completion_receipt_and_"
                        "setup_capability_ids_contains_service"
                    ),
                },
            }
        steps.extend(
            [
                {
                    "step_id": f"{workflow_id}.surface",
                    "outcome": "RENDER",
                    "render_surface": "existing_route_surface",
                    "route_pattern": route_pattern,
                    "screen": screen,
                    "directive": None,
                    "description": completion
                    or f"Use the existing {entry_label} screen; do not generate a new form.",
                },
                {
                    "step_id": f"{workflow_id}.settle",
                    "outcome": "EXECUTE",
                    "executor": "existing_ui_semantic_action",
                    "action_ids": terminal_action_ids,
                    "completion_action_ids": finish_action_ids,
                    "non_completion_action_ids": skip_action_ids,
                    **settlement_contract,
                },
            ]
        )
        workflows.append(
            {
                "capability_id": workflow_id,
                "kind": "service_onboarding",
                "schema_version": SERVICE_ONBOARDING_WORKFLOW_SCHEMA_VERSION,
                "version": 1,
                "service_id": service_id,
                "state_capability_id": state_capability_id,
                "label": f"Onboard me for {service_label}",
                "description": description
                or f"Open the approved {service_label} setup flow and resume it safely.",
                "aliases": _service_onboarding_aliases(service_id, entry),
                "search_keywords": _clean_strings(entry.get("search_keywords")),
                "entry_action_id": action_id,
                "route_pattern": route_pattern,
                "terminal_route_patterns": terminal_routes,
                "screen": screen,
                "available_action_ids": route_action_ids,
                "terminal_action_ids": terminal_action_ids,
                "completion_action_ids": finish_action_ids,
                "non_completion_action_ids": skip_action_ids,
                "api_endpoints": api_endpoints,
                "native_semantic_actions": native_permission_actions,
                "execution": {
                    "outcome": "NAVIGATE",
                    "mode": "generated_setup_workflow",
                    "target": {
                        "status": "wired",
                        "path": "route",
                        "target": route_pattern,
                    },
                },
                "resume": {
                    "state_source": "vault_keys",
                    "active_capability": state_capability_id,
                    "expected_phase": "capability_setup",
                    "expected_route": route_pattern,
                    "expected_screen": screen,
                    "settlement": "persisted_onboarding_state",
                },
                "plan": {
                    "schema_version": SERVICE_ONBOARDING_WORKFLOW_SCHEMA_VERSION,
                    # There is no new workflow table. The plan is safely
                    # reconstructed after reconnect from the versioned graph
                    # and the durable VaultKeys onboarding snapshot.
                    "durability": "derived_from_persisted_onboarding_state",
                    "resumable": True,
                    "executor_hierarchy": executor_hierarchy,
                    "completion": {
                        "claim_policy": "verified_persisted_state_only",
                        "success_state_capability_id": state_capability_id,
                        "skip_is_success": False,
                        "visual_computer_use": "excluded_from_primary_path",
                    },
                },
                "steps": steps,
                "authorization": {
                    "server_revalidation": "identity_and_persisted_onboarding_state",
                },
                "telemetry_event": "app_intelligence.service_onboarding",
            }
        )
    if location_knowledge_package is not None:
        location_index = next(
            (
                index
                for index, workflow in enumerate(workflows)
                if str(workflow.get("capability_id") or "") == _LOCATION_ONBOARDING_WORKFLOW_ID
            ),
            None,
        )
        if location_index is None:
            raise ValueError(
                "Location knowledge package has no generated setup workflow to extend."
            )
        workflows[location_index] = _compile_location_knowledge_workflow(
            workflows[location_index],
            location_knowledge_package,
            actions_by_id=by_id,
            native_actions=native_action_list,
        )
    return workflows


def list_service_onboarding_workflows() -> list[dict[str, Any]]:
    """Return generated, route-backed setup workflows in stable graph order."""
    return list(load_capability_graph().get("workflows") or [])


_LOCATION_BRAIN_DISPOSITIONS = frozenset(
    {
        "EXECUTE_SERVER_VERIFIED",
        "RENDER_INTERACTION",
        "NAVIGATE",
        "BLOCKED_UNBOUND",
    }
)
_LOCATION_LEGACY_TERMINAL_ACTION_IDS = frozenset({"setup.finish_location", "setup.skip_location"})


def _stable_projection_digest(value: Mapping[str, Any]) -> str:
    """Return a content digest without allowing callers to supply a revision."""

    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    ).hexdigest()[:24]


def _location_public_slot_types(capability: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Project schemas into names/types only; values and descriptions stay private."""

    schema = capability.get("inputSchema")
    if not isinstance(schema, Mapping):
        return []
    properties = schema.get("properties")
    if not isinstance(properties, Mapping):
        return []
    required = {str(name) for name in schema.get("required") or [] if str(name)}
    slots: list[dict[str, Any]] = []
    for name, raw in sorted(properties.items(), key=lambda item: str(item[0])):
        if not isinstance(raw, Mapping):
            continue
        clean_name = str(name or "").strip()
        slot_type = str(raw.get("type") or "object").strip()
        if not clean_name or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,95}", clean_name):
            continue
        if slot_type not in {"string", "number", "integer", "boolean", "array", "object"}:
            slot_type = "object"
        slots.append(
            {
                "name": clean_name,
                "type": slot_type,
                "required": clean_name in required,
            }
        )
    return slots


def _location_action_disposition(
    capability_id: str,
    capability: Mapping[str, Any],
) -> tuple[str, str, str, str, str]:
    """Classify generated action truth without trusting a wired UI target.

    A client local-handler being ``wired`` proves only that a screen has a
    presentation implementation.  It never proves a server mutation or a
    verified product outcome.  This narrow classifier is intentionally the
    only place the new Location brain maps action truth into model-safe
    dispositions.
    """

    if capability_id in _LOCATION_LEGACY_TERMINAL_ACTION_IDS:
        return (
            "BLOCKED_UNBOUND",
            "ASK",
            "unavailable",
            "unavailable",
            "none",
        )
    if capability_id == "location.onboarding.choose_place":
        # This is the checked-in continuation of the active durable place
        # step. It never navigates a person through fake clicks or settles
        # onboarding; the only legal next operation is the approved picker or
        # form bound to the active run/directive/lease.
        return (
            "RENDER_INTERACTION",
            "RENDER",
            "approved_card",
            "approved_card",
            "run_bound_interaction_receipt_not_product_success",
        )
    execution = capability.get("execution")
    execution = execution if isinstance(execution, Mapping) else {}
    target = execution.get("target")
    target = target if isinstance(target, Mapping) else {}
    binding = SERVER_DIRECT_CAPABILITY_BINDINGS.get(capability_id)
    if (
        capability_id in SERVER_DIRECT_ACTION_IDS
        and isinstance(binding, Mapping)
        and execution.get("mode") == "server_direct"
        and target.get("status") == "wired"
        and target.get("path") == "backend_service"
        and str(capability.get("settlement_proof") or "").strip()
        and str(binding.get("settlement_proof") or "").strip()
    ):
        confirmation = capability.get("confirmation")
        requires_tap = bool(
            confirmation.get("required") if isinstance(confirmation, Mapping) else False
        )
        return (
            "EXECUTE_SERVER_VERIFIED",
            "EXECUTE",
            "none",
            "trusted_tap" if requires_tap else "none",
            "backend_settlement",
        )
    navigation = capability.get("navigation")
    navigation = navigation if isinstance(navigation, Mapping) else {}
    routes = _clean_strings(navigation.get("routes"))
    fallback = str(navigation.get("fallback") or "").strip()
    if target.get("path") == "route" or routes or fallback.startswith("/"):
        return (
            "NAVIGATE",
            "NAVIGATE",
            "navigation",
            "none",
            "navigation_settlement_not_product_success",
        )
    render_surface = str(capability.get("render_surface") or "").strip()
    if render_surface:
        confirmation = capability.get("confirmation")
        requires_tap = bool(
            confirmation.get("required") if isinstance(confirmation, Mapping) else False
        )
        return (
            "RENDER_INTERACTION",
            "RENDER",
            "approved_card",
            "trusted_tap" if requires_tap else "approved_card",
            "interaction_receipt_not_product_success",
        )
    return ("BLOCKED_UNBOUND", "ASK", "unavailable", "unavailable", "none")


def _location_native_disposition(capability_id: str) -> tuple[str, str, str, str, str]:
    if capability_id == "native.request_device_location_permission":
        return (
            "RENDER_INTERACTION",
            "RENDER",
            "operating_system",
            "technical_interaction_required",
            "native_observation_and_position_receipt",
        )
    return ("BLOCKED_UNBOUND", "ASK", "unavailable", "unavailable", "none")


def _location_package_catalog_declarations(
    package: Mapping[str, Any],
) -> dict[str, dict[str, Any]]:
    declarations: dict[str, dict[str, Any]] = {}
    for raw in package.get("capabilities") or []:
        if not isinstance(raw, Mapping):
            continue
        capability_id = str(raw.get("capability_id") or "").strip()
        if not capability_id or capability_id in declarations:
            raise ValueError("Location service knowledge catalog has duplicate or invalid ids.")
        declarations[capability_id] = dict(raw)
    return declarations


def _service_setup_action_ids_for_workflow(
    action_capabilities: Iterable[Mapping[str, Any]],
    *,
    workflow: Mapping[str, Any],
) -> set[str]:
    """Find setup-scoped actions wired to one service's real workflow UI.

    Setup action ids are not consistently namespaced by service.  Route and
    screen ownership are generated contract facts, so use those rather than
    matching prose or aliases.  The workflow entry action is handled by the
    caller because it may intentionally begin from the shared setup hub.
    """

    workflow_routes = {str(workflow.get("route_pattern") or "").strip()}
    workflow_screens = {str(workflow.get("screen") or "").strip()}
    workflow_routes.discard("")
    workflow_screens.discard("")
    result: set[str] = set()
    for action in action_capabilities:
        if not isinstance(action, Mapping):
            continue
        capability_id = str(action.get("capability_id") or "").strip()
        if not capability_id.startswith("setup."):
            continue
        navigation = action.get("navigation")
        navigation = navigation if isinstance(navigation, Mapping) else {}
        action_routes = set(_clean_strings(navigation.get("routes")))
        action_screens = set(_clean_strings(navigation.get("screens")))
        if workflow_routes.intersection(action_routes) or workflow_screens.intersection(
            action_screens
        ):
            result.add(capability_id)
    return result


def _service_discovered_catalog_ids(
    service_id: str,
    *,
    workflow: Mapping[str, Any],
    action_capabilities: Iterable[Mapping[str, Any]],
    native_actions: Iterable[Mapping[str, Any]],
) -> set[str]:
    """Return every generated action/native/workflow entry a package owns."""

    namespace = f"{service_id}."
    expected = {
        str(action.get("capability_id") or "").strip()
        for action in action_capabilities
        if isinstance(action, Mapping)
        and str(action.get("capability_id") or "").strip().startswith(namespace)
    }
    expected.update(_service_setup_action_ids_for_workflow(action_capabilities, workflow=workflow))
    expected.update(
        {
            str(workflow.get("entry_action_id") or "").strip(),
            *{
                str(action_id).strip()
                for action_id in workflow.get("terminal_action_ids") or []
                if str(action_id).strip()
            },
            str(workflow.get("capability_id") or "").strip(),
        }
    )
    expected.update(
        str(action.get("capability_id") or "").strip()
        for action in native_actions
        if isinstance(action, Mapping) and str(action.get("service_id") or "").strip() == service_id
    )
    expected.discard("")
    return expected


def _validate_service_package_catalog_coverage(
    package: Mapping[str, Any],
    *,
    action_capabilities: Iterable[Mapping[str, Any]],
    native_actions: Iterable[Mapping[str, Any]],
    workflows: Iterable[Mapping[str, Any]],
) -> None:
    """Require an opted-in service package to classify all discovered truth.

    This is intentionally package-generic. A service without a package keeps
    its existing behavior; a service that opts in cannot publish a partial
    catalog and silently leave a newly generated action unclassified.
    """

    typed = ServiceKnowledgePackageV2.model_validate(dict(package)).model_dump(mode="json")
    service_id = str(typed.get("service_id") or "").strip()
    workflow_id = str(typed.get("workflow_id") or "").strip()
    workflow = next(
        (
            item
            for item in workflows
            if isinstance(item, Mapping) and str(item.get("capability_id") or "") == workflow_id
        ),
        None,
    )
    if not isinstance(workflow, Mapping) or str(workflow.get("service_id") or "") != service_id:
        raise ValueError("Service knowledge package has no matching generated workflow.")
    expected = _service_discovered_catalog_ids(
        service_id,
        workflow=workflow,
        action_capabilities=action_capabilities,
        native_actions=native_actions,
    )
    declared = _location_package_catalog_declarations(typed)
    missing = sorted(expected - set(declared))
    unknown = sorted(set(declared) - expected)
    if missing or unknown:
        detail = ", ".join(
            [
                *(f"missing:{item}" for item in missing),
                *(f"unknown:{item}" for item in unknown),
            ]
        )
        raise ValueError("Service knowledge package catalog coverage is incomplete: " + detail)


def _attach_service_package_summaries(
    services: Iterable[Mapping[str, Any]],
    packages: Mapping[str, Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Expose package ownership on server service nodes without model internals."""

    result: list[dict[str, Any]] = []
    for raw in services:
        service = dict(raw)
        package = packages.get(str(service.get("service_id") or ""))
        if isinstance(package, Mapping):
            service["knowledge_package"] = {
                "schema_version": str(package.get("schema_version") or ""),
                "package_id": str(package.get("package_id") or ""),
                "package_version": int(package.get("package_version") or 1),
                "package_digest": _stable_projection_digest(dict(package)),
                "catalog_status": "complete_and_compiled",
            }
        result.append(service)
    return result


def _location_endpoint_inventory(
    endpoints: Iterable[Mapping[str, Any]],
    *,
    feature_group_id: str,
) -> list[dict[str, Any]]:
    """Make discovered endpoints visible as blocked inventory, never model tools."""

    inventory: list[dict[str, Any]] = []
    seen: set[str] = set()
    for endpoint in endpoints:
        if not isinstance(endpoint, Mapping):
            continue
        method = str(endpoint.get("method") or "").upper().strip()
        path = str(endpoint.get("path") or endpoint.get("route") or "").strip()
        if not method or not path:
            continue
        opaque_id = hashlib.sha256(f"location:{method}:{path}".encode("utf-8")).hexdigest()[:16]
        capability_id = f"location.endpoint.{opaque_id}"
        if capability_id in seen:
            continue
        seen.add(capability_id)
        inventory.append(
            {
                "capability_id": capability_id,
                "candidate_id": capability_id,
                "kind": "endpoint_inventory",
                "feature_group_id": feature_group_id,
                "intent": "Known Location backend implementation inventory.",
                "semantic_boundary": (
                    "This is implementation inventory only and cannot be selected or executed."
                ),
                "disposition": "BLOCKED_UNBOUND",
                "outcome": "ASK",
                "public_slot_types": [],
                "entity_types": [],
                "interaction_class": "unavailable",
                "confirmation_class": "unavailable",
                "verified_success_boundary": "none",
            }
        )
    return sorted(inventory, key=lambda item: item["candidate_id"])


def _compile_location_brain_catalog(
    *,
    package: Mapping[str, Any],
    workflow: Mapping[str, Any],
    action_capabilities: Iterable[Mapping[str, Any]],
    native_actions: Iterable[Mapping[str, Any]],
    api_endpoints: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    """Compile the Location-only, safe static catalog for a future model turn.

    This deliberately starts from the package ownership map, then proves every
    declared identifier against generated action/native/workflow discovery.
    No alias, endpoint, route, executor reference, permission scope, receipt,
    or private entity value is copied into the resulting catalog.
    """

    package = ServiceKnowledgePackageV2.model_validate(dict(package)).model_dump(mode="json")
    declarations = _location_package_catalog_declarations(package)
    actions_by_id = {
        str(action.get("capability_id") or "").strip(): dict(action)
        for action in action_capabilities
        if isinstance(action, Mapping) and str(action.get("capability_id") or "").strip()
    }
    native_action_entries = [
        dict(action) for action in native_actions if isinstance(action, Mapping)
    ]
    native_by_id = {
        str(action.get("capability_id") or "").strip(): dict(action)
        for action in native_action_entries
        if str(action.get("capability_id") or "").strip()
    }
    workflow_id = str(workflow.get("capability_id") or "").strip()
    discovered_ids = _service_discovered_catalog_ids(
        "location",
        workflow=workflow,
        action_capabilities=actions_by_id.values(),
        native_actions=native_action_entries,
    )
    missing = sorted(discovered_ids - set(declarations))
    unknown = sorted(set(declarations) - discovered_ids)
    if missing or unknown:
        detail = ", ".join(
            [
                *(f"missing:{capability_id}" for capability_id in missing),
                *(f"unknown:{capability_id}" for capability_id in unknown),
            ]
        )
        raise ValueError("Location service knowledge catalog coverage is incomplete: " + detail)

    workflow_descriptors = {
        str(item.get("workflow_id") or ""): dict(item)
        for item in package.get("workflows") or []
        if isinstance(item, Mapping) and str(item.get("workflow_id") or "")
    }
    feature_groups = [
        {
            "feature_group_id": str(group.get("feature_group_id") or ""),
            "label": str(group.get("label") or ""),
            "description": str(group.get("description") or ""),
        }
        for group in package.get("feature_groups") or []
        if isinstance(group, Mapping)
    ]
    cards: list[dict[str, Any]] = []
    for capability_id in sorted(declarations):
        declaration = declarations[capability_id]
        kind = str(declaration.get("kind") or "")
        feature_group_id = str(declaration.get("feature_group_id") or "")
        intent = str(declaration.get("intent") or "").strip()
        semantic_boundary = str(declaration.get("semantic_boundary") or "").strip()
        if capability_id == workflow_id:
            descriptor = workflow_descriptors.get(capability_id) or {}
            intent = intent or str(descriptor.get("intent") or "")
            semantic_boundary = semantic_boundary or str(descriptor.get("semantic_boundary") or "")
            disposition = "EXECUTE_SERVER_VERIFIED"
            outcome = "EXECUTE"
            interaction_class = "workflow"
            confirmation_class = "none"
            success_boundary = "server_workflow_settlement"
            slots: list[dict[str, Any]] = []
            entities: list[str] = []
        elif capability_id in actions_by_id:
            action = actions_by_id[capability_id]
            intent = intent or str(action.get("label") or capability_id)
            semantic_boundary = semantic_boundary or str(action.get("description") or "")
            (
                disposition,
                outcome,
                interaction_class,
                confirmation_class,
                success_boundary,
            ) = _location_action_disposition(capability_id, action)
            slots = _location_public_slot_types(action)
            entities = _clean_strings(action.get("required_entities"))
        elif capability_id in native_by_id:
            intent = intent or "Request device Location permission."
            semantic_boundary = semantic_boundary or (
                "Requires a real operating system result and cannot be simulated."
            )
            (
                disposition,
                outcome,
                interaction_class,
                confirmation_class,
                success_boundary,
            ) = _location_native_disposition(capability_id)
            slots = []
            entities = []
        else:
            raise ValueError(
                f"Location catalog capability is not bound to discovery: {capability_id}"
            )
        cards.append(
            {
                "capability_id": capability_id,
                "candidate_id": capability_id,
                "kind": kind,
                "feature_group_id": feature_group_id,
                "intent": intent,
                "semantic_boundary": semantic_boundary,
                "disposition": disposition,
                "outcome": outcome,
                "public_slot_types": slots,
                "entity_types": entities,
                "interaction_class": interaction_class,
                "confirmation_class": confirmation_class,
                "verified_success_boundary": success_boundary,
            }
        )

    # Endpoint discovery is compiler-only implementation inventory. It is
    # counted on the server service node below, but deliberately excluded from
    # the model catalog: even opaque endpoint identifiers add no product value
    # and make it too easy for a future consumer to mistake inventory for a
    # tool.
    endpoint_inventory = _location_endpoint_inventory(
        api_endpoints,
        feature_group_id=str(package.get("endpoint_feature_group_id") or "backend_api"),
    )
    body: dict[str, Any] = {
        "schema_version": LOCATION_BRAIN_CATALOG_SCHEMA_VERSION,
        "service_id": "location",
        "package_id": str(package.get("package_id") or ""),
        "package_version": int(package.get("package_version") or 1),
        "package_digest": location_knowledge_package_source_digest(),
        "semantic_profile": {
            "purpose": str((package.get("semantic_profile") or {}).get("purpose") or ""),
            "user_goals": _clean_strings((package.get("semantic_profile") or {}).get("user_goals")),
            "boundaries": _clean_strings((package.get("semantic_profile") or {}).get("boundaries")),
        },
        "feature_groups": feature_groups,
        "capability_cards": cards,
        "capabilities": cards,
        "known_unbound_implementation_count": len(endpoint_inventory),
    }
    body["brain_revision"] = _stable_projection_digest(body)
    _validate_location_brain_catalog(body)
    return body


def _attach_location_brain_to_service_nodes(
    services: Iterable[Mapping[str, Any]],
    catalog: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """Decorate only Location's server graph node with auditable catalog truth."""

    result: list[dict[str, Any]] = []
    dispositions = {
        str(card.get("candidate_id") or ""): str(card.get("disposition") or "")
        for card in catalog.get("capabilities") or []
        if isinstance(card, Mapping)
    }
    for raw in services:
        service = dict(raw)
        if service.get("service_id") == "location":
            service.update(
                {
                    "knowledge_package": {
                        **dict(service.get("knowledge_package") or {}),
                        "package_digest": str(catalog.get("package_digest") or ""),
                        "brain_revision": str(catalog.get("brain_revision") or ""),
                    },
                    "feature_groups": [
                        dict(group)
                        for group in catalog.get("feature_groups") or []
                        if isinstance(group, Mapping)
                    ],
                    "capability_dispositions": [
                        {
                            "capability_id": capability_id,
                            "disposition": disposition,
                        }
                        for capability_id, disposition in sorted(dispositions.items())
                    ],
                    "catalog_coverage": {
                        "declared_capability_count": len(catalog.get("capabilities") or []),
                        "blocked_endpoint_count": int(
                            catalog.get("known_unbound_implementation_count") or 0
                        ),
                        "all_discovered_capabilities_classified": True,
                    },
                }
            )
        result.append(service)
    return result


def _compile_dynamic_service_knowledge(
    workflows: Iterable[Mapping[str, Any]],
    actions: Iterable[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Compile a service-level graph from generated workflows and actions.

    The service node is intentionally descriptive. It exposes discovered APIs,
    native semantic actions, existing UI actions, and their ordering, but only
    an action with an audited executor binding may become an executable call.
    This prevents an LLM from treating a coincidentally named HTTP path as a
    product contract.
    """
    normalized_actions = [dict(action) for action in actions if isinstance(action, Mapping)]
    registry = _load_product_agent_registry()
    agents = {
        str(agent.get("id") or "").strip(): agent
        for agent in registry.get("agents") or []
        if isinstance(agent, Mapping) and str(agent.get("id") or "").strip()
    }
    one = agents.get("agent_one") or {}
    roster = (
        (one.get("capabilities") or {}).get("specialist_roster")
        if isinstance(one.get("capabilities"), Mapping)
        else []
    )
    exposure_by_service: dict[str, tuple[str, dict[str, Any], Mapping[str, Any]]] = {}
    if not isinstance(roster, list):
        raise ValueError("The generated One specialist roster is invalid.")
    for raw_agent_id in roster:
        agent_id = str(raw_agent_id or "").strip()
        agent = agents.get(agent_id)
        exposure = agent.get("one_exposure") if isinstance(agent, Mapping) else None
        service_id = _service_key(
            exposure.get("service_id") if isinstance(exposure, Mapping) else ""
        )
        if not agent_id or not service_id or not isinstance(exposure, Mapping):
            raise ValueError(
                "A generated One specialist lacks a complete one_exposure declaration."
            )
        if service_id in exposure_by_service:
            raise ValueError("Generated One specialist service ids must be unique.")
        exposure_by_service[service_id] = (agent_id, dict(exposure), agent)
    services: list[dict[str, Any]] = []
    for workflow in workflows:
        if not isinstance(workflow, Mapping):
            continue
        service_id = _service_key(workflow.get("service_id"))
        if not service_id:
            continue
        namespace = f"{service_id}."
        service_action_ids = sorted(
            {
                str(action.get("action_id") or "")
                for action in normalized_actions
                if str(action.get("action_id") or "").startswith(namespace)
            }
            | {
                str(workflow.get("entry_action_id") or ""),
                *{
                    str(action_id)
                    for action_id in workflow.get("terminal_action_ids") or []
                    if str(action_id)
                },
            }
            - {""}
        )
        plan = workflow.get("plan") if isinstance(workflow.get("plan"), Mapping) else {}
        specialist = exposure_by_service.pop(service_id, None)
        services.append(
            {
                "capability_id": f"service.{service_id}",
                "kind": "service",
                "schema_version": DYNAMIC_SERVICE_KNOWLEDGE_SCHEMA_VERSION,
                "version": 1,
                "service_id": service_id,
                "label": _service_label(service_id),
                "onboarding_workflow_id": str(workflow.get("capability_id") or ""),
                "action_ids": service_action_ids,
                "route_patterns": sorted(
                    {
                        str(workflow.get("route_pattern") or ""),
                        *{
                            str(route)
                            for route in workflow.get("terminal_route_patterns") or []
                            if str(route)
                        },
                    }
                    - {""}
                ),
                "api_endpoints": [
                    dict(endpoint)
                    for endpoint in workflow.get("api_endpoints") or []
                    if isinstance(endpoint, Mapping)
                ],
                "native_semantic_actions": [
                    dict(action)
                    for action in workflow.get("native_semantic_actions") or []
                    if isinstance(action, Mapping)
                ],
                "executor_hierarchy": [
                    dict(item)
                    for item in plan.get("executor_hierarchy") or []
                    if isinstance(item, Mapping)
                ],
                "completion": (
                    dict(plan.get("completion"))
                    if isinstance(plan.get("completion"), Mapping)
                    else {}
                ),
                "knowledge_package": (
                    dict(workflow.get("knowledge_package"))
                    if isinstance(workflow.get("knowledge_package"), Mapping)
                    else None
                ),
                "knowledge_projection": (
                    dict(workflow.get("knowledge_projection"))
                    if isinstance(workflow.get("knowledge_projection"), Mapping)
                    else None
                ),
                "one_exposure": dict(specialist[1]) if specialist is not None else None,
                "specialist_agent_id": specialist[0] if specialist is not None else None,
                "telemetry_event": "app_intelligence.service_discovery",
            }
        )
    # A specialist does not need a setup screen to become product-discoverable.
    # The manifest is the single owned declaration: an incomplete/disabled
    # exposure never becomes an executable target, while a newly deployed
    # active service appears in the graph without a hand-maintained map.
    for service_id, (agent_id, exposure, agent) in sorted(exposure_by_service.items()):
        if exposure.get("discovery_status") != "discoverable":
            continue
        namespace = f"{service_id}."
        services.append(
            {
                "capability_id": f"service.{service_id}",
                "kind": "service",
                "schema_version": DYNAMIC_SERVICE_KNOWLEDGE_SCHEMA_VERSION,
                "version": 1,
                "service_id": service_id,
                "label": str(agent.get("name") or _service_label(service_id)),
                "onboarding_workflow_id": None,
                "action_ids": sorted(
                    {
                        str(action.get("action_id") or "")
                        for action in normalized_actions
                        if str(action.get("action_id") or "").startswith(namespace)
                    }
                    - {""}
                ),
                "route_patterns": [],
                "api_endpoints": [],
                "native_semantic_actions": [],
                "executor_hierarchy": [
                    {
                        "kind": "specialist",
                        "status": "registered_discoverable_only",
                        "reason": "A manifest exposure is discovery metadata, not an execution binding.",
                    }
                ],
                "completion": {},
                "one_exposure": exposure,
                "specialist_agent_id": agent_id,
                "telemetry_event": "app_intelligence.service_discovery",
            }
        )
    return sorted(services, key=lambda item: item["service_id"])


def list_dynamic_service_knowledge() -> list[dict[str, Any]]:
    """Return graph-derived services without a hand-maintained roster."""
    return list(load_capability_graph().get("services") or [])


def get_dynamic_service_knowledge(service_id: str | None) -> dict[str, Any] | None:
    """Read one generated service node by canonical generated service id."""
    clean_service_id = _service_key(service_id)
    if not clean_service_id:
        return None
    return next(
        (
            node
            for node in list_dynamic_service_knowledge()
            if str(node.get("service_id") or "") == clean_service_id
        ),
        None,
    )


def get_service_onboarding_workflow(workflow_id: str | None) -> dict[str, Any] | None:
    clean_id = str(workflow_id or "").strip()
    if not clean_id:
        return None
    return next(
        (
            workflow
            for workflow in list_service_onboarding_workflows()
            if str(workflow.get("capability_id") or "") == clean_id
        ),
        None,
    )


def capability_graph_policy_inputs() -> dict[str, Any]:
    """Return every checked-in policy input that shapes CapabilityGraphV1.

    These values are intentionally explicit instead of being implicit module
    behavior or a compiler-version convention.  The build generator records a
    digest of this object and the runtime recomputes it before accepting an
    artifact.  That makes a policy-only change (for example a new trusted card
    surface or a changed hard-confirmation action) fail closed until the graph
    is regenerated and reviewed.
    """

    direct_bindings = [
        {
            "action_id": action_id,
            **json.loads(json.dumps(binding, sort_keys=True, default=str)),
        }
        for action_id, binding in sorted(SERVER_DIRECT_CAPABILITY_BINDINGS.items())
    ]
    return {
        "schema_version": CAPABILITY_GRAPH_POLICY_INPUTS_SCHEMA_VERSION,
        "compiler_version": CAPABILITY_GRAPH_COMPILER_VERSION,
        "server_direct_bindings": direct_bindings,
        "server_direct_action_ids": sorted(SERVER_DIRECT_ACTION_IDS),
        "hard_card_confirmation_action_ids": sorted(HARD_CARD_CONFIRMATION_ACTION_IDS),
        "approved_render_surfaces": [
            json.loads(json.dumps(surface, sort_keys=True, default=str))
            for surface in APPROVED_RENDER_SURFACES
        ],
        "location_knowledge_workflow_binding": json.loads(
            json.dumps(LOCATION_KNOWLEDGE_WORKFLOW_BINDING, sort_keys=True, default=str)
        ),
        "location_knowledge_interaction_surface_registry": {
            surface_id: json.loads(json.dumps(surface, sort_keys=True, default=str))
            for surface_id, surface in sorted(
                LOCATION_KNOWLEDGE_INTERACTION_SURFACE_REGISTRY.items()
            )
        },
        "location_knowledge_binding_registry": {
            ref: json.loads(json.dumps(binding, sort_keys=True, default=str))
            for ref, binding in sorted(LOCATION_KNOWLEDGE_BINDING_REGISTRY.items())
        },
        "location_knowledge_verifier_registry": {
            ref: json.loads(json.dumps(verifier, sort_keys=True, default=str))
            for ref, verifier in sorted(LOCATION_KNOWLEDGE_VERIFIER_REGISTRY.items())
        },
        "default_action_entrypoints": list(DEFAULT_ACTION_ENTRYPOINTS),
        "strict_output_schema": _output_json_schema(),
        "outcome_policy": {
            "server_direct": "EXECUTE",
            "navigation": "NAVIGATE",
            "manual_or_hard_confirmation": "RENDER",
            "otherwise": "EXECUTE",
        },
        "render_surface_policy": {
            "server_direct": "render.data_card",
            "hard_confirmation": "render.confirmation_card",
            "unwired_or_manual": "render.data_card",
            "entity_requirement": "render.entity_picker",
            "missing_required_input": "render.form",
        },
        "setup_workflow_discovery": {
            "open_action_pattern": _SETUP_OPEN_ACTION_RE.pattern,
            "terminal_action_pattern": _SETUP_TERMINAL_ACTION_RE.pattern,
            "native_permission_tool_pattern": _NATIVE_PERMISSION_TOOL_RE.pattern,
        },
    }


def capability_graph_policy_digest() -> str:
    """Hash compiler-owned policy values separately from generated sources."""

    canonical = json.dumps(
        capability_graph_policy_inputs(),
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def capability_graph_compiler_source_digest() -> str:
    """Fingerprint compiler code so behavior changes cannot reuse an artifact.

    The narrower policy digest above makes reviewable policy drift obvious;
    this source fingerprint additionally catches changes to the compiler's
    routing/schema logic without asking a developer to remember a version
    bump. Source is part of the deployed Python package, so absence is a
    fail-closed condition at runtime.
    """

    try:
        return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    except OSError:
        return ""


def _validate_capability_graph_policy_inputs(actions: Iterable[Mapping[str, Any]]) -> None:
    """Reject a policy registry that could silently broaden execution."""

    binding_ids = frozenset(SERVER_DIRECT_CAPABILITY_BINDINGS)
    if SERVER_DIRECT_ACTION_IDS != binding_ids:
        raise ValueError(
            "SERVER_DIRECT_ACTION_IDS must exactly match SERVER_DIRECT_CAPABILITY_BINDINGS."
        )
    action_ids = {
        str(action.get("action_id") or "").strip()
        for action in actions
        if str(action.get("action_id") or "").strip()
    }
    unregistered = sorted(binding_ids - action_ids)
    if unregistered:
        raise ValueError(
            "Server-direct binding has no registered action contract: " + ", ".join(unregistered)
        )
    required_binding_fields = {
        "binding_ref",
        "executor_kind",
        "settlement_proof",
        "idempotency",
    }
    for action_id, binding in SERVER_DIRECT_CAPABILITY_BINDINGS.items():
        if not isinstance(binding, Mapping):
            raise ValueError(f"Server-direct binding for {action_id} must be a mapping.")
        missing = sorted(required_binding_fields - set(binding))
        if missing:
            raise ValueError(
                f"Server-direct binding for {action_id} is incomplete: {', '.join(missing)}"
            )
        for key in ("binding_ref", "executor_kind", "settlement_proof"):
            if not str(binding.get(key) or "").strip():
                raise ValueError(f"Server-direct binding for {action_id} lacks {key}.")
        idempotency = binding.get("idempotency")
        if not isinstance(idempotency, Mapping) or not all(
            str(idempotency.get(key) or "").strip() for key in ("strategy", "scope")
        ):
            raise ValueError(
                f"Server-direct binding for {action_id} lacks an idempotency contract."
            )


def _source_digest(
    actions: list[dict[str, Any]],
    routes: Mapping[str, Any],
    *,
    native_actions: Iterable[Mapping[str, Any]] = (),
    api_endpoints_by_service: Mapping[str, Iterable[Mapping[str, Any]]] | None = None,
    location_knowledge_package: Mapping[str, Any] | None = None,
    service_knowledge_packages: Mapping[str, Mapping[str, Any]] | None = None,
) -> str:
    # The dynamic service nodes are compiled from this generated registry.
    # Include its bytes in the compiler cache key so a new/changed specialist
    # cannot inherit a graph built before its one_exposure contract existed.
    try:
        registry_digest = hashlib.sha256(
            generated_contract_path("agents", "product-agent-registry.v2.json").read_bytes()
        ).hexdigest()
    except OSError:
        registry_digest = "unavailable"
    canonical = json.dumps(
        {
            "compiler_policy_digest": capability_graph_policy_digest(),
            "compiler_source_digest": capability_graph_compiler_source_digest(),
            "capability_graph_evolution_digest": (capability_graph_evolution_source_digest()),
            "actions": actions,
            "routes": routes,
            "native_actions": list(native_actions),
            "api_endpoints_by_service": dict(api_endpoints_by_service or {}),
            "location_agent_manifest_digest": location_agent_manifest_source_digest(),
            "location_knowledge_package": dict(location_knowledge_package or {}),
            "location_knowledge_package_digest": location_knowledge_package_source_digest(),
            "service_knowledge_packages_digest": service_knowledge_packages_source_digest(),
            "service_knowledge_packages": {
                str(service_id): dict(package)
                for service_id, package in sorted((service_knowledge_packages or {}).items())
                if isinstance(package, Mapping)
            },
            "location_onboarding_runtime_digest": location_onboarding_runtime_source_digest(),
            "location_workflow_api_contract_digest": (
                location_workflow_api_contract_source_digest()
            ),
            "product_agent_registry_digest": registry_digest,
        },
        default=str,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _platform_projection_digest(projection: Mapping[str, Any]) -> str:
    """Fingerprint one client-safe projection without self-reference."""

    canonical = {key: value for key, value in projection.items() if key != "projection_digest"}
    return hashlib.sha256(
        json.dumps(
            canonical,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        ).encode("utf-8")
    ).hexdigest()


def _compile_platform_capability_projections(
    *,
    source_revision: str,
    actions: Iterable[Mapping[str, Any]],
    workflows: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    """Build bounded web/iOS views without executor implementation details."""

    direct_actions: list[dict[str, Any]] = []
    for action in actions:
        execution = action.get("execution")
        if not isinstance(execution, Mapping) or execution.get("mode") != "server_direct":
            continue
        direct_actions.append(
            {
                "capability_id": str(action.get("capability_id") or ""),
                "version": int(action.get("version") or 1),
                "inputSchema": dict(action.get("inputSchema") or {}),
                "execution": {
                    "outcome": execution.get("outcome"),
                    "mode": execution.get("mode"),
                    "binding_ref": execution.get("binding_ref"),
                    "target": dict(execution.get("target") or {}),
                    "executor": dict(execution.get("executor") or {}),
                },
                "confirmation": dict(action.get("confirmation") or {}),
            }
        )

    workflow_projections: list[dict[str, Any]] = []
    for workflow in workflows:
        projection = workflow.get("knowledge_projection")
        if not isinstance(projection, Mapping):
            continue
        execution = (
            workflow.get("execution") if isinstance(workflow.get("execution"), Mapping) else {}
        )
        navigation = (
            workflow.get("navigation") if isinstance(workflow.get("navigation"), Mapping) else {}
        )
        workflow_projections.append(
            {
                "capability_id": str(workflow.get("capability_id") or ""),
                "version": int(workflow.get("version") or 1),
                "service_id": str(workflow.get("service_id") or ""),
                "execution": {
                    "outcome": str(execution.get("outcome") or ""),
                    "mode": str(execution.get("mode") or ""),
                    "binding_ref": str(execution.get("binding_ref") or ""),
                },
                "navigation_fallback": str(navigation.get("fallback") or "") or None,
                "render_surface": "render.one_location_workflow_card",
                "knowledge": {
                    "schema_version": str(projection.get("schema_version") or ""),
                    "package_id": str(projection.get("package_id") or ""),
                    "workflow_version": int(projection.get("workflow_version") or 1),
                    "allowed_fact_keys": _clean_strings(projection.get("allowed_fact_keys"))[:8],
                    "max_retrieved_steps": max(
                        1,
                        min(3, int(projection.get("max_retrieved_steps") or 3)),
                    ),
                },
                **{
                    policy_field: dict(workflow.get(policy_field) or {})
                    for policy_field in _LOCATION_KNOWLEDGE_POLICY_FIELDS
                },
                "interaction_surface_ids": [
                    str(surface.get("surface_id") or "")
                    for surface in workflow.get("interaction_surfaces") or []
                    if isinstance(surface, Mapping) and str(surface.get("surface_id") or "")
                ],
                "interaction_surfaces": [
                    {
                        "variant_id": str(surface.get("surface_id") or ""),
                        "render_surface": str(surface.get("render_capability_id") or ""),
                        "renderer_key": str(surface.get("renderer_key") or ""),
                        "directive_kind": str(surface.get("directive_kind") or ""),
                        "title_key": str(surface.get("title_key") or ""),
                        "body_key": str(surface.get("body_key") or ""),
                        "allowed_results": [
                            dict(result)
                            for result in surface.get("allowed_results") or []
                            if isinstance(result, Mapping)
                        ],
                        "result_schema_ref": str(surface.get("result_schema_ref") or ""),
                        "result_schema": dict(surface.get("result_schema") or {}),
                    }
                    for surface in workflow.get("interaction_surfaces") or []
                    if isinstance(surface, Mapping) and str(surface.get("surface_id") or "")
                ],
            }
        )

    render_surfaces = [
        {
            "capability_id": str(surface.get("capability_id") or ""),
            "renderer_key": str(surface.get("renderer_key") or ""),
            "contract_schema": str(surface.get("contract_schema") or ""),
        }
        for surface in APPROVED_RENDER_SURFACES
        if surface.get("capability_id") == "render.one_location_workflow_card"
    ]
    source_digests = {
        "capability_runtime_policy": capability_graph_policy_digest(),
        "capability_runtime_compiler": capability_graph_compiler_source_digest(),
        "capability_graph_evolution": capability_graph_evolution_source_digest(),
        "location_agent_manifest": location_agent_manifest_source_digest(),
        "location_knowledge_package": location_knowledge_package_source_digest(),
        "service_knowledge_packages": service_knowledge_packages_source_digest(),
        "location_onboarding_runtime": location_onboarding_runtime_source_digest(),
        "location_workflow_api_contract": location_workflow_api_contract_source_digest(),
    }
    result: dict[str, Any] = {
        "schema_version": PLATFORM_CAPABILITY_PROJECTION_SCHEMA_VERSION,
        "source_revision": source_revision,
    }
    entrypoints_by_platform = {
        "web": ["typed", "voice"],
        "ios": ["typed", "voice", "siri_app_shortcut"],
    }
    for platform, entrypoints in entrypoints_by_platform.items():
        bounded: dict[str, Any] = {
            "schema_version": PLATFORM_CAPABILITY_PROJECTION_SCHEMA_VERSION,
            "platform": platform,
            "source_revision": source_revision,
            "source_digests": source_digests,
            "supported_entrypoints": entrypoints,
            "actions": direct_actions,
            "workflows": workflow_projections,
            "render_surfaces": render_surfaces,
        }
        bounded["projection_digest"] = _platform_projection_digest(bounded)
        result[platform] = bounded
    return result


def compile_capability_graph_from_sources() -> dict[str, Any]:
    """Compile source contracts at build time into one immutable graph.

    The cache is content-addressed, so product availability changes and a
    regenerated gateway cannot leave an old capability catalog in memory.
    """
    # This is a build-time compiler.  Do not permit a process-local parsed
    # registry from a previous build input to leak into the generated graph.
    _load_product_agent_registry.cache_clear()
    actions = list_action_gateway_actions()
    _validate_capability_graph_policy_inputs(actions)
    routes = load_route_orchestration_index()
    native_actions = _discover_native_semantic_actions()
    service_knowledge_packages = discover_service_knowledge_packages()
    location_knowledge_package = service_knowledge_packages.get("location")
    if not isinstance(location_knowledge_package, Mapping):
        raise ValueError("Location service knowledge package is unavailable.")
    setup_service_ids = sorted(
        {
            service_id
            for action in actions
            if (
                service_id := _service_id_from_setup_open_action(str(action.get("action_id") or ""))
            )
            is not None
        }
    )
    api_endpoints_by_service = {
        service_id: list_service_api_endpoints(service_id) for service_id in setup_service_ids
    }
    service_onboarding_workflows = _compile_service_onboarding_workflows(
        actions,
        routes,
        native_actions=native_actions,
        api_endpoints_by_service=api_endpoints_by_service,
        location_knowledge_package=location_knowledge_package,
    )
    action_capabilities = [_action_capability(entry) for entry in actions]
    _validate_action_capability_contracts(action_capabilities)
    for package in service_knowledge_packages.values():
        _validate_service_package_catalog_coverage(
            package,
            action_capabilities=action_capabilities,
            native_actions=native_actions,
            workflows=service_onboarding_workflows,
        )
    digest = _source_digest(
        actions,
        routes,
        native_actions=native_actions,
        api_endpoints_by_service=api_endpoints_by_service,
        location_knowledge_package=location_knowledge_package,
        service_knowledge_packages=service_knowledge_packages,
    )
    if _SOURCE_COMPILER_CACHE.get("source_digest") == digest and isinstance(
        _SOURCE_COMPILER_CACHE.get("graph"), dict
    ):
        return _SOURCE_COMPILER_CACHE["graph"]

    location_workflow = next(
        (
            workflow
            for workflow in service_onboarding_workflows
            if str(workflow.get("capability_id") or "") == _LOCATION_ONBOARDING_WORKFLOW_ID
        ),
        None,
    )
    if not isinstance(location_workflow, Mapping):
        raise ValueError("Location service knowledge package has no compiled workflow.")
    location_brain_catalog = _compile_location_brain_catalog(
        package=location_knowledge_package,
        workflow=location_workflow,
        action_capabilities=action_capabilities,
        native_actions=native_actions,
        api_endpoints=api_endpoints_by_service.get("location") or [],
    )
    service_nodes = _compile_dynamic_service_knowledge(service_onboarding_workflows, actions)
    service_nodes = _attach_service_package_summaries(
        service_nodes,
        service_knowledge_packages,
    )
    service_nodes = _attach_location_brain_to_service_nodes(
        service_nodes,
        location_brain_catalog,
    )
    screen_capabilities: list[dict[str, Any]] = []
    for route_pattern, route in sorted(routes.items()):
        if not isinstance(route, Mapping):
            continue
        screen_capabilities.append(
            {
                "capability_id": f"screen:{route_pattern}",
                "kind": "screen",
                "version": 1,
                "label": str(route.get("canonical_screen") or route_pattern),
                "route_pattern": route_pattern,
                "action_ids": _clean_strings(route.get("action_ids")),
                "telemetry_event": "app_intelligence.navigation",
            }
        )
    entity_ids = sorted(
        {
            entity
            for capability in action_capabilities
            for entity in capability.get("required_entities", [])
        }
    )
    entity_capabilities = [
        {
            "capability_id": entity_id,
            "kind": "entity",
            "version": 1,
            "label": entity_id.removeprefix("entity.").replace("_", " ").title(),
            "resolution": "server_authoritative",
            "ambiguity_surface": "render.choice_card",
            "telemetry_event": "app_intelligence.entity_resolution",
        }
        for entity_id in entity_ids
    ]
    platform_projections = _compile_platform_capability_projections(
        source_revision=digest,
        actions=action_capabilities,
        workflows=service_onboarding_workflows,
    )
    graph = {
        "schema_version": CAPABILITY_GRAPH_SCHEMA_VERSION,
        "compiler_version": CAPABILITY_GRAPH_COMPILER_VERSION,
        "source_revision": digest,
        "revision": digest,
        "mcp_compatible": True,
        "actions": action_capabilities,
        "workflows": service_onboarding_workflows,
        "services": service_nodes,
        "screens": screen_capabilities,
        "entities": entity_capabilities,
        "render_surfaces": [dict(surface) for surface in APPROVED_RENDER_SURFACES],
        # This projection is intentionally safe to hand to a future model
        # session. Platform projections remain separate because they include
        # client implementation contracts that a model must never see.
        "model_projections": {"location": location_brain_catalog},
        "platform_projections": platform_projections,
    }
    _SOURCE_COMPILER_CACHE["source_digest"] = digest
    _SOURCE_COMPILER_CACHE["graph"] = graph
    logger.info(
        "app_intelligence_graph_compiled revision=%s actions=%d workflows=%d services=%d screens=%d entities=%d",
        digest,
        len(action_capabilities),
        len(service_onboarding_workflows),
        len(service_nodes),
        len(screen_capabilities),
        len(entity_capabilities),
    )
    return graph


def _artifact_source_digest(name: str) -> str:
    if name == "capability_runtime_policy":
        return capability_graph_policy_digest()
    if name == "capability_runtime_compiler":
        return capability_graph_compiler_source_digest()
    if name == "capability_graph_evolution":
        return capability_graph_evolution_source_digest()
    if name == "location_agent_manifest":
        return location_agent_manifest_source_digest()
    if name == "location_knowledge_package":
        return location_knowledge_package_source_digest()
    if name == "service_knowledge_packages":
        return service_knowledge_packages_source_digest()
    if name == "location_onboarding_runtime":
        return location_onboarding_runtime_source_digest()
    if name == "location_workflow_api_contract":
        return location_workflow_api_contract_source_digest()
    path_by_name = {
        "kai_action_gateway": generated_contract_path("kai", "kai-action-gateway.vnext.json"),
        "route_orchestration_index": generated_contract_path(
            "kai", "one-route-orchestration-index.v1.json"
        ),
        "product_agent_registry": generated_contract_path(
            "agents", "product-agent-registry.v2.json"
        ),
    }
    path = path_by_name.get(name)
    if path is None:
        return ""
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return ""


def _validate_platform_capability_projections(
    payload: Mapping[str, Any],
    *,
    revision: str,
    source_digests: Mapping[str, Any],
) -> None:
    """Fail closed on stale, widened, or internally inconsistent client views."""

    if str(payload.get("source_revision") or "") != revision:
        raise CapabilityGraphArtifactError("Capability graph source revision is invalid.")
    projections = payload.get("platform_projections")
    if (
        not isinstance(projections, Mapping)
        or projections.get("schema_version") != PLATFORM_CAPABILITY_PROJECTION_SCHEMA_VERSION
        or projections.get("source_revision") != revision
    ):
        raise CapabilityGraphArtifactError("Capability graph platform projections are invalid.")
    expected_digest_keys = {
        "capability_runtime_policy",
        "capability_runtime_compiler",
        "capability_graph_evolution",
        "location_agent_manifest",
        "location_knowledge_package",
        "service_knowledge_packages",
        "location_onboarding_runtime",
        "location_workflow_api_contract",
    }
    for platform in ("web", "ios"):
        projection = projections.get(platform)
        if (
            not isinstance(projection, Mapping)
            or projection.get("schema_version") != PLATFORM_CAPABILITY_PROJECTION_SCHEMA_VERSION
            or projection.get("platform") != platform
            or projection.get("source_revision") != revision
        ):
            raise CapabilityGraphArtifactError(
                f"Capability graph {platform} projection is invalid."
            )
        recorded_digest = str(projection.get("projection_digest") or "")
        actual_digest = _platform_projection_digest(projection)
        if not recorded_digest or not hmac.compare_digest(recorded_digest, actual_digest):
            raise CapabilityGraphArtifactError(
                f"Capability graph {platform} projection digest is invalid."
            )
        projection_source_digests = projection.get("source_digests")
        if not isinstance(projection_source_digests, Mapping):
            raise CapabilityGraphArtifactError(
                f"Capability graph {platform} projection source digests are missing."
            )
        for name in expected_digest_keys:
            expected = str(source_digests.get(name) or "")
            projected = str(projection_source_digests.get(name) or "")
            if not expected or not hmac.compare_digest(expected, projected):
                raise CapabilityGraphArtifactError(
                    f"Capability graph {platform} projection is stale."
                )
        workflows = projection.get("workflows")
        if not isinstance(workflows, list) or not workflows:
            raise CapabilityGraphArtifactError(
                f"Capability graph {platform} workflow projection is missing."
            )
        for workflow in workflows:
            if not isinstance(workflow, Mapping):
                raise CapabilityGraphArtifactError(
                    f"Capability graph {platform} workflow projection is invalid."
                )
            surfaces = workflow.get("interaction_surfaces")
            if not isinstance(surfaces, list) or not surfaces:
                raise CapabilityGraphArtifactError(
                    f"Capability graph {platform} interaction catalog is missing."
                )


def _validate_workflow_revision_compatibility(payload: Mapping[str, Any], *, revision: str) -> None:
    """Validate the artifact-owned allowlist used by durable workflow runs.

    A stored run remains pinned to its creation revision. The current runtime
    may interpret it only when this generated chain proves that the workflow
    node stayed byte-for-byte semantically identical across every intervening
    graph revision. Migration-required and rejected revisions are deliberately
    disjoint from that allowlist.
    """

    compatibility = payload.get("workflow_revision_compatibility")
    if (
        not isinstance(compatibility, Mapping)
        or compatibility.get("schema_version") != WORKFLOW_REVISION_COMPATIBILITY_SCHEMA_VERSION
        or compatibility.get("current_graph_revision") != revision
        or not isinstance(compatibility.get("workflows"), list)
    ):
        raise CapabilityGraphArtifactError(
            "Capability graph workflow revision compatibility is invalid."
        )
    workflows = {
        str(workflow.get("capability_id") or ""): workflow
        for workflow in payload.get("workflows") or []
        if isinstance(workflow, Mapping) and str(workflow.get("capability_id") or "")
    }
    entries: dict[str, Mapping[str, Any]] = {}
    revision_pattern = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
    for raw in compatibility["workflows"]:
        if not isinstance(raw, Mapping):
            raise CapabilityGraphArtifactError(
                "Capability graph workflow revision compatibility is invalid."
            )
        workflow_id = str(raw.get("workflow_id") or "")
        workflow = workflows.get(workflow_id)
        if workflow is None or workflow_id in entries:
            raise CapabilityGraphArtifactError(
                "Capability graph workflow revision compatibility is invalid."
            )
        digest = hashlib.sha256(
            json.dumps(
                workflow,
                sort_keys=True,
                separators=(",", ":"),
                default=str,
            ).encode("utf-8")
        ).hexdigest()
        if raw.get("workflow_version") != int(
            workflow.get("version") or 1
        ) or not hmac.compare_digest(str(raw.get("workflow_digest") or ""), digest):
            raise CapabilityGraphArtifactError(
                "Capability graph workflow revision compatibility is stale."
            )
        revision_sets: list[set[str]] = []
        for field in (
            "compatible_graph_revisions",
            "migration_required_graph_revisions",
            "rejected_graph_revisions",
        ):
            values = raw.get(field)
            if (
                not isinstance(values, list)
                or len(values) != len(set(values))
                or any(
                    not isinstance(value, str)
                    or not revision_pattern.fullmatch(value)
                    or value == revision
                    for value in values
                )
            ):
                raise CapabilityGraphArtifactError(
                    "Capability graph workflow revision compatibility is invalid."
                )
            revision_sets.append(set(values))
        if any(
            left & right
            for index, left in enumerate(revision_sets)
            for right in revision_sets[index + 1 :]
        ):
            raise CapabilityGraphArtifactError(
                "Capability graph workflow revision policies overlap."
            )
        entries[workflow_id] = raw
    if set(entries) != set(workflows):
        raise CapabilityGraphArtifactError(
            "Capability graph workflow revision compatibility is incomplete."
        )


_LOCATION_BRAIN_CARD_FIELDS = frozenset(
    {
        "capability_id",
        "candidate_id",
        "kind",
        "feature_group_id",
        "intent",
        "semantic_boundary",
        "disposition",
        "outcome",
        "public_slot_types",
        "entity_types",
        "interaction_class",
        "confirmation_class",
        "verified_success_boundary",
    }
)
_LOCATION_BRAIN_FORBIDDEN_KEYS = frozenset(
    {
        "alias",
        "search_keyword",
        "endpoint",
        "route",
        "binding",
        "executor",
        "implementation",
        "credential",
        "scope",
        "run_id",
        "lease",
        "receipt",
        "coordinate",
        "address",
        "place_label",
        "contact",
        "transcript",
    }
)
_LOCATION_BRAIN_UNSAFE_TEXT = re.compile(
    r"(?:https?://|(?:^|[\s(])/[A-Za-z0-9][A-Za-z0-9_./-]*|"
    r"\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password|"
    r"authorization\s*:|bearer\s+[A-Za-z0-9._-]+|"
    r"(?:run|lease|receipt|directive|binding|resolver|implementation)[_-](?:id|ref))\b)",
    re.IGNORECASE,
)


def _is_safe_location_brain_text(value: Any, *, maximum: int = 480) -> bool:
    """Reject paths, credentials, opaque ids, and non-English catalog prose."""

    if not isinstance(value, str):
        return False
    clean = value.strip()
    return bool(
        clean
        and len(clean) <= maximum
        and clean.isascii()
        and _LOCATION_BRAIN_UNSAFE_TEXT.search(clean) is None
    )


def _is_safe_location_brain_identifier(value: Any) -> bool:
    return bool(
        isinstance(value, str)
        and re.fullmatch(r"[a-z][a-z0-9_.:-]{1,159}", value)
        and not _LOCATION_BRAIN_UNSAFE_TEXT.search(value)
    )


def _validate_location_brain_catalog(catalog: Mapping[str, Any]) -> None:
    """Fail closed if the checked-in model catalog widens beyond safe cards."""

    required = {
        "schema_version",
        "service_id",
        "package_id",
        "package_version",
        "package_digest",
        "brain_revision",
        "semantic_profile",
        "feature_groups",
        "capability_cards",
        "capabilities",
        "known_unbound_implementation_count",
    }
    if set(catalog) != required:
        raise CapabilityGraphArtifactError("Location brain catalog is invalid.")
    if (
        catalog.get("schema_version") != LOCATION_BRAIN_CATALOG_SCHEMA_VERSION
        or catalog.get("service_id") != "location"
        or not _is_safe_location_brain_identifier(str(catalog.get("package_id") or ""))
        or not isinstance(catalog.get("package_version"), int)
        or isinstance(catalog.get("package_version"), bool)
        or int(catalog.get("package_version") or 0) < 1
        or not re.fullmatch(r"[0-9a-f]{64}", str(catalog.get("package_digest") or ""))
        or not isinstance(catalog.get("known_unbound_implementation_count"), int)
        or isinstance(catalog.get("known_unbound_implementation_count"), bool)
        or int(catalog.get("known_unbound_implementation_count") or 0) < 0
    ):
        raise CapabilityGraphArtifactError("Location brain catalog is invalid.")
    canonical = dict(catalog)
    recorded_revision = str(canonical.pop("brain_revision") or "")
    expected_revision = _stable_projection_digest(canonical)
    if not recorded_revision or not hmac.compare_digest(recorded_revision, expected_revision):
        raise CapabilityGraphArtifactError("Location brain catalog revision is invalid.")
    profile = catalog.get("semantic_profile")
    groups = catalog.get("feature_groups")
    cards = catalog.get("capability_cards")
    if (
        not isinstance(profile, Mapping)
        or set(profile) != {"purpose", "user_goals", "boundaries"}
        or not isinstance(groups, list)
        or not isinstance(cards, list)
        or catalog.get("capabilities") != cards
        or not cards
    ):
        raise CapabilityGraphArtifactError("Location brain catalog is invalid.")
    if not all(
        isinstance(group, Mapping)
        and set(group) == {"feature_group_id", "label", "description"}
        and re.fullmatch(r"[a-z][a-z0-9_]{2,63}", str(group.get("feature_group_id") or ""))
        and _is_safe_location_brain_text(group.get("label"), maximum=96)
        and _is_safe_location_brain_text(group.get("description"), maximum=360)
        for group in groups
    ):
        raise CapabilityGraphArtifactError("Location brain feature groups are invalid.")
    group_ids = {str(group["feature_group_id"]) for group in groups}
    if not group_ids or len(group_ids) != len(groups):
        raise CapabilityGraphArtifactError("Location brain feature groups are invalid.")
    if (
        not _is_safe_location_brain_text(profile.get("purpose"))
        or not isinstance(profile.get("user_goals"), list)
        or not profile["user_goals"]
        or not all(_is_safe_location_brain_text(item) for item in profile["user_goals"])
        or not isinstance(profile.get("boundaries"), list)
        or not profile["boundaries"]
        or not all(_is_safe_location_brain_text(item) for item in profile["boundaries"])
    ):
        raise CapabilityGraphArtifactError("Location brain semantic profile is invalid.")
    card_ids: set[str] = set()
    for card in cards:
        if not isinstance(card, Mapping) or set(card) != _LOCATION_BRAIN_CARD_FIELDS:
            raise CapabilityGraphArtifactError("Location brain capability card is invalid.")
        capability_id = str(card.get("capability_id") or "")
        candidate_id = str(card.get("candidate_id") or "")
        if (
            not capability_id
            or capability_id != candidate_id
            or capability_id in card_ids
            or str(card.get("feature_group_id") or "") not in group_ids
            or not _is_safe_location_brain_identifier(str(card.get("kind") or ""))
            or str(card.get("disposition") or "") not in _LOCATION_BRAIN_DISPOSITIONS
            or str(card.get("outcome") or "") not in {"ASK", "EXECUTE", "NAVIGATE", "RENDER"}
            or not _is_safe_location_brain_identifier(capability_id)
            or not _is_safe_location_brain_text(card.get("intent"), maximum=240)
            or not _is_safe_location_brain_text(card.get("semantic_boundary"), maximum=1024)
            or not isinstance(card.get("public_slot_types"), list)
            or not isinstance(card.get("entity_types"), list)
            or not all(
                _is_safe_location_brain_identifier(entity) for entity in card["entity_types"]
            )
            or not _is_safe_location_brain_identifier(str(card.get("interaction_class") or ""))
            or not _is_safe_location_brain_identifier(str(card.get("confirmation_class") or ""))
            or not _is_safe_location_brain_identifier(
                str(card.get("verified_success_boundary") or "")
            )
        ):
            raise CapabilityGraphArtifactError("Location brain capability card is invalid.")
        card_ids.add(capability_id)
        for key in card:
            lowered = key.casefold()
            if any(forbidden in lowered for forbidden in _LOCATION_BRAIN_FORBIDDEN_KEYS):
                raise CapabilityGraphArtifactError(
                    "Location brain catalog contains private internals."
                )
        for slot in card["public_slot_types"]:
            if (
                not isinstance(slot, Mapping)
                or set(slot) != {"name", "type", "required"}
                or not isinstance(slot.get("required"), bool)
                or not _is_safe_location_brain_identifier(str(slot.get("name") or ""))
                or not _is_safe_location_brain_identifier(str(slot.get("type") or ""))
            ):
                raise CapabilityGraphArtifactError("Location brain slot projection is invalid.")


def _location_brain_catalog_from_graph(graph: Mapping[str, Any] | None = None) -> dict[str, Any]:
    payload = graph if isinstance(graph, Mapping) else load_capability_graph()
    projections = payload.get("model_projections") if isinstance(payload, Mapping) else None
    catalog = projections.get("location") if isinstance(projections, Mapping) else None
    if not isinstance(catalog, Mapping):
        raise CapabilityGraphArtifactError("Location brain catalog is unavailable.")
    _validate_location_brain_catalog(catalog)
    return dict(catalog)


def _validate_location_brain_model_projections(
    payload: Mapping[str, Any],
    *,
    revision: str,
) -> None:
    """Verify the static model view before a runtime can use the artifact."""

    catalog = _location_brain_catalog_from_graph(payload)
    if not str(revision or "").strip() or not str(catalog.get("brain_revision") or "").strip():
        raise CapabilityGraphArtifactError("Location brain catalog is invalid.")


_SERVICE_BRAIN_CATALOG_FIELDS = frozenset(
    {
        "schema_version",
        "service_id",
        "package_id",
        "package_version",
        "package_digest",
        "brain_revision",
        "semantic_profile",
        "feature_groups",
        "capability_cards",
        "capabilities",
        "known_unbound_implementation_count",
    }
)
_SERVICE_BRAIN_PACKAGE_SUMMARY_FIELDS = frozenset(
    {
        "schema_version",
        "package_id",
        "package_version",
        "package_digest",
        "brain_revision",
        "catalog_status",
    }
)
_SERVICE_BRAIN_SERVICE_ID_RE = re.compile(r"[a-z][a-z0-9_]{1,63}")
_SERVICE_BRAIN_PACKAGE_ID_RE = re.compile(r"[a-z][a-z0-9_.-]{2,127}")
_SERVICE_BRAIN_DIGEST_RE = re.compile(r"[0-9a-f]{64}")
_SERVICE_BRAIN_REVISION_RE = re.compile(r"[0-9a-f]{16,64}")


def _is_complete_generic_service_brain_catalog(
    catalog: Mapping[str, Any],
    *,
    service_id: str,
) -> bool:
    """Validate the common safe-card shape for a future service brain.

    Location has a deliberately stricter validator because it is the first
    migrated service.  A later package may enter this registry only after its
    compiler emits this same bounded, endpoint-free card contract; a loose
    mapping must never become a source of model candidates just because a
    service node calls itself complete.
    """

    if (
        set(catalog) != _SERVICE_BRAIN_CATALOG_FIELDS
        or catalog.get("schema_version") != SERVICE_BRAIN_CATALOG_SCHEMA_VERSION
        or catalog.get("service_id") != service_id
        or not _SERVICE_BRAIN_SERVICE_ID_RE.fullmatch(service_id)
        or not _SERVICE_BRAIN_PACKAGE_ID_RE.fullmatch(str(catalog.get("package_id") or ""))
        or not isinstance(catalog.get("package_version"), int)
        or isinstance(catalog.get("package_version"), bool)
        or int(catalog.get("package_version") or 0) < 1
        or not _SERVICE_BRAIN_DIGEST_RE.fullmatch(str(catalog.get("package_digest") or ""))
        or not _SERVICE_BRAIN_REVISION_RE.fullmatch(str(catalog.get("brain_revision") or ""))
        or not isinstance(catalog.get("known_unbound_implementation_count"), int)
        or isinstance(catalog.get("known_unbound_implementation_count"), bool)
        or int(catalog.get("known_unbound_implementation_count") or 0) < 0
    ):
        return False
    canonical = dict(catalog)
    recorded_revision = str(canonical.pop("brain_revision") or "")
    if not hmac.compare_digest(recorded_revision, _stable_projection_digest(canonical)):
        return False
    profile = catalog.get("semantic_profile")
    groups = catalog.get("feature_groups")
    cards = catalog.get("capability_cards")
    if (
        not isinstance(profile, Mapping)
        or set(profile) != {"purpose", "user_goals", "boundaries"}
        or not _is_safe_location_brain_text(profile.get("purpose"))
        or not isinstance(profile.get("user_goals"), list)
        or not profile["user_goals"]
        or not all(_is_safe_location_brain_text(item) for item in profile["user_goals"])
        or not isinstance(profile.get("boundaries"), list)
        or not profile["boundaries"]
        or not all(_is_safe_location_brain_text(item) for item in profile["boundaries"])
        or not isinstance(groups, list)
        or not groups
        or not isinstance(cards, list)
        or not cards
        or catalog.get("capabilities") != cards
    ):
        return False
    group_ids: set[str] = set()
    for group in groups:
        if (
            not isinstance(group, Mapping)
            or set(group) != {"feature_group_id", "label", "description"}
            or not re.fullmatch(r"[a-z][a-z0-9_]{2,63}", str(group.get("feature_group_id") or ""))
            or not _is_safe_location_brain_text(group.get("label"), maximum=96)
            or not _is_safe_location_brain_text(group.get("description"), maximum=360)
        ):
            return False
        group_id = str(group["feature_group_id"])
        if group_id in group_ids:
            return False
        group_ids.add(group_id)
    card_ids: set[str] = set()
    for card in cards:
        if not isinstance(card, Mapping) or set(card) != _LOCATION_BRAIN_CARD_FIELDS:
            return False
        capability_id = str(card.get("capability_id") or "")
        candidate_id = str(card.get("candidate_id") or "")
        if (
            not capability_id
            or capability_id != candidate_id
            or capability_id in card_ids
            or str(card.get("feature_group_id") or "") not in group_ids
            or not _is_safe_location_brain_identifier(capability_id)
            or not _is_safe_location_brain_identifier(str(card.get("kind") or ""))
            or str(card.get("disposition") or "") not in _LOCATION_BRAIN_DISPOSITIONS
            or str(card.get("outcome") or "") not in {"ASK", "EXECUTE", "NAVIGATE", "RENDER"}
            or not _is_safe_location_brain_text(card.get("intent"), maximum=240)
            or not _is_safe_location_brain_text(card.get("semantic_boundary"), maximum=1024)
            or not isinstance(card.get("public_slot_types"), list)
            or not isinstance(card.get("entity_types"), list)
            or not all(
                _is_safe_location_brain_identifier(entity) for entity in card["entity_types"]
            )
            or not _is_safe_location_brain_identifier(str(card.get("interaction_class") or ""))
            or not _is_safe_location_brain_identifier(str(card.get("confirmation_class") or ""))
            or not _is_safe_location_brain_identifier(
                str(card.get("verified_success_boundary") or "")
            )
        ):
            return False
        if any(
            forbidden in key.casefold()
            for key in card
            for forbidden in _LOCATION_BRAIN_FORBIDDEN_KEYS
        ):
            return False
        for slot in card["public_slot_types"]:
            if (
                not isinstance(slot, Mapping)
                or set(slot) != {"name", "type", "required"}
                or not isinstance(slot.get("required"), bool)
                or not _is_safe_location_brain_identifier(str(slot.get("name") or ""))
                or not _is_safe_location_brain_identifier(str(slot.get("type") or ""))
            ):
                return False
        card_ids.add(capability_id)
    return True


def _is_complete_service_brain_model_projection(
    *,
    service_id: str,
    package_summary: Mapping[str, Any],
    catalog: Mapping[str, Any],
) -> bool:
    """Prove a service node and model catalog describe one checked-in package."""

    if (
        not _SERVICE_BRAIN_SERVICE_ID_RE.fullmatch(service_id)
        or not _SERVICE_BRAIN_PACKAGE_SUMMARY_FIELDS.issubset(package_summary)
        or package_summary.get("schema_version") != SERVICE_KNOWLEDGE_PACKAGE_SCHEMA_VERSION
        or package_summary.get("catalog_status") != "complete_and_compiled"
        or not _SERVICE_BRAIN_PACKAGE_ID_RE.fullmatch(str(package_summary.get("package_id") or ""))
        or not isinstance(package_summary.get("package_version"), int)
        or isinstance(package_summary.get("package_version"), bool)
        or int(package_summary.get("package_version") or 0) < 1
        or not _SERVICE_BRAIN_DIGEST_RE.fullmatch(str(package_summary.get("package_digest") or ""))
        or not _SERVICE_BRAIN_REVISION_RE.fullmatch(
            str(package_summary.get("brain_revision") or "")
        )
        or catalog.get("service_id") != service_id
        or catalog.get("package_id") != package_summary.get("package_id")
        or catalog.get("package_version") != package_summary.get("package_version")
        or not hmac.compare_digest(
            str(catalog.get("package_digest") or ""),
            str(package_summary.get("package_digest") or ""),
        )
        or not hmac.compare_digest(
            str(catalog.get("brain_revision") or ""),
            str(package_summary.get("brain_revision") or ""),
        )
    ):
        return False
    try:
        if service_id == "location":
            _validate_location_brain_catalog(catalog)
            return True
        return _is_complete_generic_service_brain_catalog(catalog, service_id=service_id)
    except (CapabilityGraphArtifactError, TypeError, ValueError):
        return False


def list_complete_service_brain_model_projections(
    *,
    graph: Mapping[str, Any] | None = None,
) -> dict[str, dict[str, Any]]:
    """Enumerate only graph-compiled, complete service-brain model catalogs.

    This is a runtime read of the generated graph—not a manifest scan.  A
    service is excluded unless its graph service node declares a complete
    ``ServiceKnowledgePackageV2`` and that declaration exactly matches a
    safe model projection.  That makes incomplete future packages invisible
    to semantic routing instead of silently falling back to aliases or route
    discovery.
    """

    payload = graph if isinstance(graph, Mapping) else load_capability_graph()
    projections = payload.get("model_projections") if isinstance(payload, Mapping) else None
    services = payload.get("services") if isinstance(payload, Mapping) else None
    if not isinstance(projections, Mapping) or not isinstance(services, list):
        return {}
    service_summaries: dict[str, Mapping[str, Any]] = {}
    duplicate_service_ids: set[str] = set()
    for service in services:
        if not isinstance(service, Mapping):
            continue
        service_id = str(service.get("service_id") or "").strip()
        summary = service.get("knowledge_package")
        if not _SERVICE_BRAIN_SERVICE_ID_RE.fullmatch(service_id) or not isinstance(
            summary, Mapping
        ):
            continue
        if service_id in service_summaries:
            duplicate_service_ids.add(service_id)
            continue
        service_summaries[service_id] = summary
    for service_id in duplicate_service_ids:
        service_summaries.pop(service_id, None)

    registered: dict[str, dict[str, Any]] = {}
    for service_id, summary in service_summaries.items():
        catalog = projections.get(service_id)
        if not isinstance(catalog, Mapping):
            continue
        if not _is_complete_service_brain_model_projection(
            service_id=service_id,
            package_summary=summary,
            catalog=catalog,
        ):
            continue
        # Never hand a caller a mutable view into the cached graph artifact.
        # Catalog validation above guarantees JSON-safe values and excludes
        # private implementation fields before this copy is created.
        registered[service_id] = json.loads(json.dumps(catalog, sort_keys=True))
    return {service_id: registered[service_id] for service_id in sorted(registered)}


def load_capability_graph() -> dict[str, Any]:
    """Load the build-time graph and fail closed when it is stale.

    Runtime source/AST discovery used to make a warm Live session depend on
    process imports and stale in-memory caches. The deployable now consumes a
    checked-in artifact only; its generated-source, policy, and compiler
    digests prevent a gateway, manifest, or policy rollout from silently using
    yesterday's capability semantics.
    """
    artifact_path = generated_contract_path("kai", "one-capability-graph.v1.json")
    try:
        payload = json.loads(artifact_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise CapabilityGraphArtifactError("Capability graph artifact is unavailable.") from exc
    if (
        not isinstance(payload, dict)
        or payload.get("schema_version") != CAPABILITY_GRAPH_SCHEMA_VERSION
    ):
        raise CapabilityGraphArtifactError("Capability graph artifact has an unsupported schema.")
    revision = str(payload.get("revision") or "").strip()
    source_digests = payload.get("source_digests")
    if not revision or not isinstance(source_digests, Mapping):
        raise CapabilityGraphArtifactError("Capability graph artifact is incomplete.")
    for name in (
        "kai_action_gateway",
        "route_orchestration_index",
        "product_agent_registry",
        "capability_runtime_policy",
        "capability_runtime_compiler",
        "capability_graph_evolution",
        "location_agent_manifest",
        "location_knowledge_package",
        "service_knowledge_packages",
        "location_onboarding_runtime",
        "location_workflow_api_contract",
    ):
        expected = str(source_digests.get(name) or "")
        actual = _artifact_source_digest(name)
        if not expected or not actual or not hmac.compare_digest(expected, actual):
            raise CapabilityGraphArtifactError("Capability graph artifact is stale.")
    _validate_platform_capability_projections(
        payload,
        revision=revision,
        source_digests=source_digests,
    )
    _validate_workflow_revision_compatibility(payload, revision=revision)
    _validate_location_brain_model_projections(payload, revision=revision)
    cached = _ARTIFACT_CACHE.get("graph")
    if _ARTIFACT_CACHE.get("revision") == revision and isinstance(cached, dict):
        return cached
    _ARTIFACT_CACHE["revision"] = revision
    _ARTIFACT_CACHE["graph"] = payload
    return payload


_LOCATION_BRAIN_FACT_VALUES: Mapping[str, frozenset[str]] = {
    "permission_status": frozenset(
        {"unknown", "needed", "granted", "denied", "restricted", "services_disabled"}
    ),
    "position_receipt_status": frozenset({"unknown", "needed", "captured", "unavailable"}),
    "place_status": frozenset({"unknown", "needed", "saved", "skipped", "staged"}),
    "circle_status": frozenset({"unknown", "needed", "provisioned", "failed"}),
    "completion_status": frozenset({"unknown", "incomplete", "completed"}),
}
_LOCATION_BRAIN_POLICY_RULES: Mapping[str, bool] = {
    "candidate_selection_only": True,
    "verified_settlement_required": True,
    "client_completion_claim_allowed": False,
    "real_os_interaction_required": True,
}
_LOCATION_BRAIN_ACTIVE_WORKFLOW_FIELDS = frozenset(
    {"workflow_id", "workflow_version", "step_id", "status"}
)
_LOCATION_BRAIN_ACTIVE_RUN_STATUSES = frozenset(
    {
        "proposed",
        "needs_input",
        "entity_choice",
        "interaction_required",
        "confirmation_required",
        "authorized",
        "executing",
        "settlement_received",
        "paused",
        "verified_succeeded",
        "verified_failed",
        "cancelled",
        "expired",
        "migration_required",
    }
)
_LOCATION_BRAIN_SEMANTIC_CACHE: dict[str, Any] = {
    "graph_revision": None,
    "brain_revision": None,
    "candidate_ids": (),
    "vectors": (),
    "embedding_model": None,
    "dimensions": 0,
}
_LOCATION_BRAIN_EMBEDDING_CLIENT: Any | None = None
_LOCATION_BRAIN_EMBEDDING_LOCK = threading.RLock()
_LOCATION_BRAIN_SEMANTIC_CACHE_LOCK = threading.RLock()
_LOCATION_BRAIN_EMBEDDING_REQUESTS = threading.BoundedSemaphore(
    _LOCATION_BRAIN_EMBEDDING_MAX_CONCURRENCY
)
_LOCATION_BRAIN_EMBEDDING_CIRCUIT: dict[str, float | int] = {
    "open_until": 0.0,
    "failures": 0,
}


class LocationBrainEmbeddingUnavailable(RuntimeError):
    """A bounded managed-embedding failure that must resolve to ``ASK``."""


def _location_brain_embedding_client() -> Any:
    """Return the one ADC-backed, global embedding client for this process."""

    global _LOCATION_BRAIN_EMBEDDING_CLIENT
    with _LOCATION_BRAIN_EMBEDDING_LOCK:
        if _LOCATION_BRAIN_EMBEDDING_CLIENT is None:
            # A Location command is a managed-GCP-only product lane. Local
            # developer-key compatibility is useful for unrelated text work,
            # but it must never become a hidden routing provider for a held
            # command whose PCM was admitted under managed capacity policy.
            binding = ManagedGeminiRuntimeBinding.from_environment()
            if binding.auth_mode != VERTEX_ADC_AUTH_MODE:
                raise LocationBrainEmbeddingUnavailable(
                    "Location semantic routing requires managed Vertex ADC"
                )
            _LOCATION_BRAIN_EMBEDDING_CLIENT = binding.build_direct_client(
                model=LOCATION_BRAIN_EMBEDDING_MODEL
            )
        return _LOCATION_BRAIN_EMBEDDING_CLIENT


def _location_brain_embedding_circuit_allows_request() -> bool:
    with _LOCATION_BRAIN_EMBEDDING_LOCK:
        return float(_LOCATION_BRAIN_EMBEDDING_CIRCUIT["open_until"]) <= time.monotonic()


def _record_location_brain_embedding_success() -> None:
    with _LOCATION_BRAIN_EMBEDDING_LOCK:
        _LOCATION_BRAIN_EMBEDDING_CIRCUIT.update({"open_until": 0.0, "failures": 0})


def _record_location_brain_embedding_failure() -> None:
    with _LOCATION_BRAIN_EMBEDDING_LOCK:
        failures = int(_LOCATION_BRAIN_EMBEDDING_CIRCUIT["failures"]) + 1
        update: dict[str, float | int] = {"failures": failures}
        if failures >= 2:
            update["open_until"] = time.monotonic() + _LOCATION_BRAIN_EMBEDDING_CIRCUIT_SECONDS
        _LOCATION_BRAIN_EMBEDDING_CIRCUIT.update(update)


def _location_brain_embedding_values(response: Any, *, expected_count: int) -> list[list[float]]:
    """Validate/normalize Vertex embeddings without preserving provider payloads."""

    embeddings = getattr(response, "embeddings", None)
    if embeddings is None and isinstance(response, Mapping):
        embeddings = response.get("embeddings")
    if not isinstance(embeddings, list) or len(embeddings) != expected_count:
        raise LocationBrainEmbeddingUnavailable("managed embedding response is incomplete")
    vectors: list[list[float]] = []
    for embedding in embeddings:
        values = getattr(embedding, "values", None)
        if values is None and isinstance(embedding, Mapping):
            values = embedding.get("values")
        if not isinstance(values, list) or len(values) != LOCATION_BRAIN_EMBEDDING_DIMENSIONS:
            raise LocationBrainEmbeddingUnavailable("managed embedding dimensions are invalid")
        try:
            vector = [float(value) for value in values]
        except (TypeError, ValueError) as exc:
            raise LocationBrainEmbeddingUnavailable("managed embedding values are invalid") from exc
        if not all(math.isfinite(value) for value in vector):
            raise LocationBrainEmbeddingUnavailable("managed embedding values are invalid")
        magnitude = math.sqrt(sum(value * value for value in vector))
        if magnitude <= 0:
            raise LocationBrainEmbeddingUnavailable("managed embedding values are invalid")
        vectors.append([value / magnitude for value in vector])
    return vectors


def _embed_location_brain_texts(
    texts: list[str],
    *,
    task_type: str,
    timeout_ms: int,
) -> list[list[float]]:
    """Embed bounded, non-sensitive routing text through managed Vertex."""

    if not texts or not _location_brain_embedding_circuit_allows_request():
        raise LocationBrainEmbeddingUnavailable("managed embedding is unavailable")
    # Do not queue an arbitrary number of speech turns behind an embedding
    # provider.  Backpressure is an ASK, never a lexical/alias fallback.
    if not _LOCATION_BRAIN_EMBEDDING_REQUESTS.acquire(timeout=0.05):
        raise LocationBrainEmbeddingUnavailable("managed embedding is busy")
    try:
        from google.genai import types as genai_types

        response = _location_brain_embedding_client().models.embed_content(
            model=LOCATION_BRAIN_EMBEDDING_MODEL,
            contents=texts,
            config=genai_types.EmbedContentConfig(
                task_type=task_type,
                output_dimensionality=LOCATION_BRAIN_EMBEDDING_DIMENSIONS,
                auto_truncate=True,
                http_options=genai_types.HttpOptions(timeout=timeout_ms),
            ),
        )
        vectors = _location_brain_embedding_values(response, expected_count=len(texts))
    except Exception as exc:  # noqa: BLE001 - provider details never reach a turn or telemetry
        _record_location_brain_embedding_failure()
        raise LocationBrainEmbeddingUnavailable("managed embedding is unavailable") from exc
    finally:
        _LOCATION_BRAIN_EMBEDDING_REQUESTS.release()
    _record_location_brain_embedding_success()
    return vectors


def _location_brain_workflow(graph: Mapping[str, Any]) -> Mapping[str, Any]:
    workflow = next(
        (
            item
            for item in graph.get("workflows") or []
            if isinstance(item, Mapping)
            and str(item.get("capability_id") or "") == _LOCATION_ONBOARDING_WORKFLOW_ID
        ),
        None,
    )
    if not isinstance(workflow, Mapping):
        raise CapabilityGraphArtifactError("Location brain workflow is unavailable.")
    return workflow


def _bounded_location_brain_facts(
    runtime_facts: Mapping[str, Any] | None,
) -> dict[str, str]:
    facts = runtime_facts if isinstance(runtime_facts, Mapping) else {}
    bounded: dict[str, str] = {}
    for key, allowed in _LOCATION_BRAIN_FACT_VALUES.items():
        value = str(facts.get(key) or "unknown").strip().casefold()
        bounded[key] = value if value in allowed else "unknown"
    return bounded


def _bounded_location_brain_active_workflow(
    active_run: Mapping[str, Any] | None,
    *,
    workflow: Mapping[str, Any],
) -> dict[str, Any] | None:
    raw = active_run if isinstance(active_run, Mapping) else {}
    if not raw:
        return None
    workflow_id = str(raw.get("workflow_id") or raw.get("capability_id") or "").strip()
    if workflow_id != _LOCATION_ONBOARDING_WORKFLOW_ID:
        return None
    expected_version = max(1, int(workflow.get("version") or 1))
    try:
        workflow_version = int(raw.get("workflow_version") or expected_version)
    except (TypeError, ValueError):
        return None
    step_id = str(raw.get("step_id") or raw.get("step_cursor") or "").strip()
    status = str(raw.get("status") or "").strip()
    known_steps = {
        str(step.get("step_id") or "")
        for step in workflow.get("steps") or []
        if isinstance(step, Mapping)
    }
    if (
        workflow_version != expected_version
        or step_id not in known_steps
        or status not in _LOCATION_BRAIN_ACTIVE_RUN_STATUSES
    ):
        return None
    return {
        "workflow_id": workflow_id,
        "workflow_version": workflow_version,
        "step_id": step_id,
        "status": status,
    }


def _location_brain_context_revision(
    *,
    graph_revision: str,
    brain_revision: str,
    facts: Mapping[str, str],
    active_workflow: Mapping[str, Any] | None,
) -> str:
    """Derive the opaque revision from precisely the safe snapshot fields."""

    return "ctx_" + _stable_projection_digest(
        {
            "graph_revision": graph_revision,
            "brain_revision": brain_revision,
            "facts": dict(facts),
            "active_workflow": dict(active_workflow) if active_workflow else None,
        }
    )


def _safe_location_brain_active_workflow(
    value: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    """Validate and reconstruct the only active-workflow shape a model sees."""

    if value is None:
        return None
    if not isinstance(value, Mapping) or set(value) != _LOCATION_BRAIN_ACTIVE_WORKFLOW_FIELDS:
        raise ValueError("Location brain active workflow is invalid.")
    workflow_id = str(value.get("workflow_id") or "").strip()
    step_id = str(value.get("step_id") or "").strip()
    status = str(value.get("status") or "").strip()
    workflow_version = value.get("workflow_version")
    if (
        workflow_id != _LOCATION_ONBOARDING_WORKFLOW_ID
        or not isinstance(workflow_version, int)
        or isinstance(workflow_version, bool)
        or workflow_version < 1
        or not re.fullmatch(r"location\.onboarding\.[a-z][a-z0-9_]*", step_id)
        or status not in _LOCATION_BRAIN_ACTIVE_RUN_STATUSES
    ):
        raise ValueError("Location brain active workflow is invalid.")
    return {
        "workflow_id": workflow_id,
        "workflow_version": workflow_version,
        "step_id": step_id,
        "status": status,
    }


def _safe_location_brain_snapshot(snapshot: Mapping[str, Any]) -> dict[str, Any]:
    """Validate then rebuild a snapshot before it can become a model delta."""

    _validate_location_brain_snapshot(snapshot)
    active_workflow = _safe_location_brain_active_workflow(snapshot.get("active_workflow"))
    return {
        "schema_version": LOCATION_BRAIN_SNAPSHOT_SCHEMA_VERSION,
        "graph_revision": str(snapshot["graph_revision"]),
        "brain_revision": str(snapshot["brain_revision"]),
        "context_revision": str(snapshot["context_revision"]),
        "service_id": "location",
        "facts": {key: str(snapshot["facts"][key]) for key in _LOCATION_BRAIN_FACT_VALUES},
        "active_workflow": active_workflow,
        "policy_rules": dict(_LOCATION_BRAIN_POLICY_RULES),
    }


def build_location_brain_snapshot(
    *,
    runtime_facts: Mapping[str, Any] | None = None,
    active_run: Mapping[str, Any] | None = None,
    graph: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a server-owned, bounded Location runtime snapshot.

    The public signature accepts mappings for test and adapter ergonomics, but
    drops all values except declared status enums and a validated workflow
    cursor.  In particular it never echoes a user, run, lease, receipt,
    route, coordinate, address, label, or model transcript.
    """

    payload = graph if isinstance(graph, Mapping) else load_capability_graph()
    catalog = _location_brain_catalog_from_graph(payload)
    workflow = _location_brain_workflow(payload)
    facts = _bounded_location_brain_facts(runtime_facts)
    active_workflow = _bounded_location_brain_active_workflow(active_run, workflow=workflow)
    graph_revision = str(payload.get("revision") or "")
    brain_revision = str(catalog.get("brain_revision") or "")
    return {
        "schema_version": LOCATION_BRAIN_SNAPSHOT_SCHEMA_VERSION,
        "graph_revision": graph_revision,
        "brain_revision": brain_revision,
        "context_revision": _location_brain_context_revision(
            graph_revision=graph_revision,
            brain_revision=brain_revision,
            facts=facts,
            active_workflow=active_workflow,
        ),
        "service_id": "location",
        "facts": facts,
        "active_workflow": active_workflow,
        "policy_rules": dict(_LOCATION_BRAIN_POLICY_RULES),
    }


def _validate_location_brain_snapshot(snapshot: Mapping[str, Any]) -> None:
    required = {
        "schema_version",
        "graph_revision",
        "brain_revision",
        "context_revision",
        "service_id",
        "facts",
        "active_workflow",
        "policy_rules",
    }
    if (
        set(snapshot) != required
        or snapshot.get("schema_version") != LOCATION_BRAIN_SNAPSHOT_SCHEMA_VERSION
        or snapshot.get("service_id") != "location"
        or not str(snapshot.get("graph_revision") or "")
        or not str(snapshot.get("brain_revision") or "")
        or not re.fullmatch(r"ctx_[0-9a-f]{24}", str(snapshot.get("context_revision") or ""))
        or not isinstance(snapshot.get("facts"), Mapping)
        or not isinstance(snapshot.get("policy_rules"), Mapping)
    ):
        raise ValueError("Location brain snapshot is invalid.")
    facts = snapshot["facts"]
    if set(facts) != set(_LOCATION_BRAIN_FACT_VALUES):
        raise ValueError("Location brain snapshot facts are invalid.")
    for key, allowed in _LOCATION_BRAIN_FACT_VALUES.items():
        if facts.get(key) not in allowed:
            raise ValueError("Location brain snapshot facts are invalid.")
    active_workflow = _safe_location_brain_active_workflow(snapshot.get("active_workflow"))
    policy_rules = snapshot.get("policy_rules")
    if dict(policy_rules) != dict(_LOCATION_BRAIN_POLICY_RULES):
        raise ValueError("Location brain snapshot policy rules are invalid.")
    expected_revision = _location_brain_context_revision(
        graph_revision=str(snapshot["graph_revision"]),
        brain_revision=str(snapshot["brain_revision"]),
        facts={key: str(facts[key]) for key in _LOCATION_BRAIN_FACT_VALUES},
        active_workflow=active_workflow,
    )
    if not hmac.compare_digest(str(snapshot["context_revision"]), expected_revision):
        raise ValueError("Location brain snapshot context revision is invalid.")


def _location_brain_cards_for_candidates(
    catalog: Mapping[str, Any],
    candidates: Iterable[str | Mapping[str, Any]] | None,
    *,
    active_workflow: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    cards_by_id = {
        str(card.get("candidate_id") or ""): dict(card)
        for card in catalog.get("capability_cards") or []
        if isinstance(card, Mapping) and str(card.get("candidate_id") or "")
    }
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in candidates or []:
        candidate_id = (
            str(raw.get("candidate_id") or raw.get("capability_id") or "").strip()
            if isinstance(raw, Mapping)
            else str(raw or "").strip()
        )
        card = cards_by_id.get(candidate_id)
        if card is None or candidate_id in seen:
            continue
        if str(card.get("disposition") or "") == "BLOCKED_UNBOUND":
            # Inventory and stale legacy actions may remain auditable in the
            # static catalog, but they must never become selectable model
            # candidates. The safe response for them is ASK.
            continue
        if candidate_id == "location.onboarding.choose_place" and (
            not isinstance(active_workflow, Mapping)
            or active_workflow.get("step_id") != "location.onboarding.place"
        ):
            # A named place continuation is meaningful only inside the
            # server-owned place step. Do not offer it on another screen/run
            # and leave a model to discover that mismatch at execution time.
            continue
        selected.append(card)
        seen.add(candidate_id)
        if len(selected) >= MAX_RETRIEVAL_RESULTS:
            break
    return selected


def build_location_turn_projection(
    *,
    query: str | None = None,
    snapshot: Mapping[str, Any],
    candidates: Iterable[str | Mapping[str, Any]] | None = None,
    graph: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the only model-facing per-turn Location selection contract.

    ``query`` is intentionally accepted but never placed in the projection;
    the caller may use it for semantic retrieval, while the model receives
    only safe catalog cards and must answer with a candidate id or ``ASK``.
    """

    del query
    safe_snapshot = _safe_location_brain_snapshot(snapshot)
    payload = graph if isinstance(graph, Mapping) else load_capability_graph()
    catalog = _location_brain_catalog_from_graph(payload)
    if safe_snapshot.get("graph_revision") != payload.get("revision") or safe_snapshot.get(
        "brain_revision"
    ) != catalog.get("brain_revision"):
        raise ValueError("Location brain snapshot is stale.")
    cards = _location_brain_cards_for_candidates(
        catalog,
        candidates,
        active_workflow=(
            safe_snapshot.get("active_workflow")
            if isinstance(safe_snapshot.get("active_workflow"), Mapping)
            else None
        ),
    )
    allowed_values = [str(card["candidate_id"]) for card in cards] + ["ASK"]
    return {
        "schema_version": LOCATION_TURN_PROJECTION_SCHEMA_VERSION,
        "graph_revision": str(safe_snapshot["graph_revision"]),
        "brain_revision": str(safe_snapshot["brain_revision"]),
        "context_revision": str(safe_snapshot["context_revision"]),
        "candidates": cards,
        "selection_contract": {
            "field": "candidate_id_or_ASK",
            "allowed_values": allowed_values,
        },
    }


def validate_location_brain_selection(
    projection: Mapping[str, Any],
    candidate_id_or_ask: str | None,
) -> str:
    """Fail closed when a model selects anything outside its exact candidates."""

    contract = projection.get("selection_contract") if isinstance(projection, Mapping) else None
    values = contract.get("allowed_values") if isinstance(contract, Mapping) else None
    selected = str(candidate_id_or_ask or "ASK").strip() or "ASK"
    if not isinstance(values, list) or selected not in values:
        return "ASK"
    if selected == "ASK":
        return selected
    candidates = projection.get("candidates") if isinstance(projection, Mapping) else None
    selected_card = next(
        (
            item
            for item in candidates or []
            if isinstance(item, Mapping) and item.get("candidate_id") == selected
        ),
        None,
    )
    if (
        not isinstance(selected_card, Mapping)
        or str(selected_card.get("disposition") or "") == "BLOCKED_UNBOUND"
    ):
        return "ASK"
    return selected


def build_location_brain_delta(
    *,
    previous_snapshot: Mapping[str, Any] | None,
    current_snapshot: Mapping[str, Any],
) -> dict[str, Any] | None:
    """Send only changed safe facts unless a fresh snapshot is mandatory."""

    current = _safe_location_brain_snapshot(current_snapshot)
    if not isinstance(previous_snapshot, Mapping):
        return {
            "schema_version": LOCATION_BRAIN_DELTA_SCHEMA_VERSION,
            "kind": "replace_snapshot",
            "reason_code": "missing_base_snapshot",
            "snapshot": current,
        }
    try:
        previous = _safe_location_brain_snapshot(previous_snapshot)
    except ValueError:
        return {
            "schema_version": LOCATION_BRAIN_DELTA_SCHEMA_VERSION,
            "kind": "replace_snapshot",
            "reason_code": "invalid_base_snapshot",
            "snapshot": current,
        }
    previous_active = previous.get("active_workflow")
    current_active = current.get("active_workflow")
    requires_migration = bool(
        isinstance(current_active, Mapping) and current_active.get("status") == "migration_required"
    )
    if (
        previous.get("graph_revision") != current.get("graph_revision")
        or previous.get("brain_revision") != current.get("brain_revision")
        or requires_migration
        or (
            isinstance(previous_active, Mapping)
            and isinstance(current_active, Mapping)
            and previous_active.get("workflow_version") != current_active.get("workflow_version")
        )
    ):
        return {
            "schema_version": LOCATION_BRAIN_DELTA_SCHEMA_VERSION,
            "kind": "replace_snapshot",
            "reason_code": "graph_or_workflow_changed",
            "snapshot": current,
        }
    changed_facts = {
        key: value for key, value in current["facts"].items() if previous["facts"].get(key) != value
    }
    active_changed = previous_active != current_active
    if not changed_facts and not active_changed:
        return None
    return {
        "schema_version": LOCATION_BRAIN_DELTA_SCHEMA_VERSION,
        "kind": "facts_changed",
        "base_graph_revision": str(previous["graph_revision"]),
        "base_brain_revision": str(previous["brain_revision"]),
        "base_context_revision": str(previous["context_revision"]),
        "graph_revision": str(current["graph_revision"]),
        "brain_revision": str(current["brain_revision"]),
        "context_revision": str(current["context_revision"]),
        "changed_facts": changed_facts,
        "changed_active_workflow": dict(current_active)
        if active_changed and isinstance(current_active, Mapping)
        else None,
    }


def build_location_brain_model_routing_intent(
    value: str,
    *,
    graph: Mapping[str, Any] | None = None,
) -> str:
    """Return a semantic-but-redacted command representation for routing.

    The selector and semantic index need natural language, not a brittle
    aliases-only vocabulary.  At the same time, the final transcription may
    contain an address, coordinates, a person, or a value for a Circle/place
    slot.  This function therefore removes *values* rather than every word
    outside the checked-in catalog.  It keeps the ordinary phrasing that lets
    embeddings recognize a held-out paraphrase, while replacing values with
    the fixed ``[detail]`` marker before either a managed embedding endpoint
    or the constrained Gemini selector sees it.

    The catalog is used only to avoid mistaking authored product names for a
    title-cased person/place.  It is not an admission list: a phrase with no
    alias overlap remains useful semantic routing input.  Dedicated,
    server-owned slot extraction receives the original transient transcript
    later; callers must not log or persist ``value``.
    """

    payload = graph if isinstance(graph, Mapping) else load_capability_graph()
    catalog = _location_brain_catalog_from_graph(payload)
    safe_terms = set(_LOCATION_BRAIN_SAFE_ROUTING_GLUE)
    for card in _location_brain_index_cards(catalog):
        for field in (
            "candidate_id",
            "feature_group_id",
            "intent",
            "semantic_boundary",
            "outcome",
            "interaction_class",
            "confirmation_class",
        ):
            safe_terms.update(
                token.casefold()
                for token in _LOCATION_BRAIN_ROUTING_TOKEN_RE.findall(str(card.get(field) or ""))
            )

    # Bound work and output before applying expression patterns. The source
    # transcript is otherwise held only for this synchronous projection and
    # the audited slot adapter in the command process.
    redacted = str(value or "")[:1024]

    def replace_value(match: re.Match[str]) -> str:
        return f"{match.group('prefix')}[detail]"

    # Structured values first, then labelled/free-form values. Preserving the
    # verb/prefix keeps the routing semantics (for example, "create a circle
    # called [detail]") without releasing the actual label.
    for expression in (
        _LOCATION_BRAIN_ROUTING_URL_RE,
        _LOCATION_BRAIN_ROUTING_EMAIL_RE,
        _LOCATION_BRAIN_ROUTING_PHONE_RE,
        _LOCATION_BRAIN_ROUTING_COORDINATE_RE,
        _LOCATION_BRAIN_ROUTING_ADDRESS_RE,
        _LOCATION_BRAIN_ROUTING_QUOTED_VALUE_RE,
    ):
        redacted = expression.sub("[detail]", redacted)
    redacted = _LOCATION_BRAIN_ROUTING_NAMED_VALUE_RE.sub(replace_value, redacted)
    redacted = _LOCATION_BRAIN_ROUTING_PLACE_VALUE_RE.sub(replace_value, redacted)
    redacted = _LOCATION_BRAIN_ROUTING_CIRCLE_TAIL_RE.sub(replace_value, redacted)
    redacted = _LOCATION_BRAIN_ROUTING_CIRCLE_PARTICIPANT_RE.sub(replace_value, redacted)
    redacted = _LOCATION_BRAIN_ROUTING_RECIPIENT_RE.sub(replace_value, redacted)
    redacted = _LOCATION_BRAIN_ROUTING_LOCATION_TARGET_RE.sub(replace_value, redacted)

    # A title-cased multiword phrase is normally a person/place/Circle value.
    # Retain it only if every token was authored in the current safe catalog.
    # This means a future package can introduce a real product term without a
    # parallel hard-coded exception, while names such as "Zircon Willow" do
    # not enter the model-facing representation.
    def replace_proper_name(match: re.Match[str]) -> str:
        words = _LOCATION_BRAIN_ROUTING_TOKEN_RE.findall(match.group(0))
        if words and all(word.casefold() in safe_terms for word in words):
            return match.group(0)
        return "[detail]"

    redacted = _LOCATION_BRAIN_ROUTING_PROPER_NAME_RE.sub(replace_proper_name, redacted)
    redacted = re.sub(r"(?:\[detail\]\s*){2,}", "[detail] ", redacted)
    redacted = re.sub(r"\s+", " ", redacted).strip()
    return redacted[:768] or "[detail]"


def _location_brain_passage(card: Mapping[str, Any]) -> str:
    """Build semantic index text solely from safe catalog fields."""

    return ". ".join(
        value
        for value in (
            str(card.get("intent") or "").strip(),
            str(card.get("semantic_boundary") or "").strip(),
            str(card.get("feature_group_id") or "").replace("_", " ").strip(),
        )
        if value
    )


def _location_brain_index_cards(catalog: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Return the stable, selectable Location cards in artifact order.

    The ordering is part of the precomputed index key.  It is derived only
    from the checked-in safe model projection, never from aliases, endpoint
    metadata, a route, or an action-retrieval fallback.
    """

    return [
        dict(card)
        for card in catalog.get("capability_cards") or []
        if isinstance(card, Mapping)
        and str(card.get("candidate_id") or "").strip()
        and str(card.get("disposition") or "") != "BLOCKED_UNBOUND"
    ]


def _location_brain_cache_matches(
    *,
    graph_revision: str,
    brain_revision: str,
    candidate_ids: tuple[str, ...],
) -> bool:
    """Whether the local worker holds this exact static semantic index."""

    vectors = _LOCATION_BRAIN_SEMANTIC_CACHE.get("vectors")
    return bool(
        _LOCATION_BRAIN_SEMANTIC_CACHE.get("graph_revision") == graph_revision
        and _LOCATION_BRAIN_SEMANTIC_CACHE.get("brain_revision") == brain_revision
        and _LOCATION_BRAIN_SEMANTIC_CACHE.get("candidate_ids") == candidate_ids
        and _LOCATION_BRAIN_SEMANTIC_CACHE.get("embedding_model") == LOCATION_BRAIN_EMBEDDING_MODEL
        and _LOCATION_BRAIN_SEMANTIC_CACHE.get("dimensions") == LOCATION_BRAIN_EMBEDDING_DIMENSIONS
        and isinstance(vectors, tuple)
        and len(vectors) == len(candidate_ids)
    )


def prewarm_location_brain_semantic_index(
    *,
    graph: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the immutable Location-card index before this worker is ready.

    This is intentionally a startup-only operation.  A live user turn may
    query an already-warm index but must never download, compile, or repair an
    index.  A provider or quota failure is therefore visible as a failed
    readiness check instead of silently restoring old alias/lexical routing.
    """

    payload = graph if isinstance(graph, Mapping) else load_capability_graph()
    catalog = _location_brain_catalog_from_graph(payload)
    cards = _location_brain_index_cards(catalog)
    graph_revision = str(payload.get("revision") or "").strip()
    brain_revision = str(catalog.get("brain_revision") or "").strip()
    candidate_ids = tuple(str(card.get("candidate_id") or "") for card in cards)
    if not graph_revision or not brain_revision or not cards or not all(candidate_ids):
        raise LocationBrainEmbeddingUnavailable("Location semantic index is incomplete")
    with _LOCATION_BRAIN_SEMANTIC_CACHE_LOCK:
        if _location_brain_cache_matches(
            graph_revision=graph_revision,
            brain_revision=brain_revision,
            candidate_ids=candidate_ids,
        ):
            return {
                "status": "ready",
                "graph_revision": graph_revision,
                "brain_revision": brain_revision,
                "card_count": len(cards),
            }

    vectors = _embed_location_brain_texts(
        [_location_brain_passage(card) for card in cards],
        task_type="RETRIEVAL_DOCUMENT",
        timeout_ms=_LOCATION_BRAIN_EMBEDDING_STARTUP_TIMEOUT_MS,
    )
    if len(vectors) != len(cards):
        raise LocationBrainEmbeddingUnavailable("Location semantic index is incomplete")
    with _LOCATION_BRAIN_SEMANTIC_CACHE_LOCK:
        _LOCATION_BRAIN_SEMANTIC_CACHE.update(
            {
                "graph_revision": graph_revision,
                "brain_revision": brain_revision,
                "candidate_ids": candidate_ids,
                # An immutable copy prevents a future caller from mutating
                # static card vectors after startup.
                "vectors": tuple(tuple(vector) for vector in vectors),
                "embedding_model": LOCATION_BRAIN_EMBEDDING_MODEL,
                "dimensions": LOCATION_BRAIN_EMBEDDING_DIMENSIONS,
            }
        )
    return {
        "status": "ready",
        "graph_revision": graph_revision,
        "brain_revision": brain_revision,
        "card_count": len(cards),
    }


_LOCATION_BRAIN_COORDINATE_RE = re.compile(
    r"(?<![\w.])-?\d{1,3}\.\d{3,}\s*[,;/]\s*-?\d{1,3}\.\d{3,}(?![\w.])"
)
_LOCATION_BRAIN_EMAIL_RE = re.compile(r"\b[^\s@]+@[^\s@]+\.[^\s@]+\b")
_LOCATION_BRAIN_ADDRESS_RE = re.compile(
    r"\b\d{1,6}\s+[A-Za-z][A-Za-z .'-]{1,72}\s"
    r"(?:street|st|road|rd|avenue|ave|lane|ln|boulevard|blvd|drive|dr|place|pl)\b",
    flags=re.IGNORECASE,
)
_LOCATION_BRAIN_QUOTED_VALUE_RE = re.compile(r"(['\"]).{1,96}?\1")


def _bounded_location_brain_query(query: str) -> str:
    """Remove obvious private values before managed semantic retrieval.

    This is not a transcript store or slot extractor.  It keeps only a short
    capability-routing representation; exact place labels, addresses,
    coordinates, and contacts must be supplied through the later typed
    interaction and never become index input or telemetry.
    """

    clean = " ".join(str(query or "").split())[:512]
    clean = _LOCATION_BRAIN_COORDINATE_RE.sub("[coordinates]", clean)
    clean = _LOCATION_BRAIN_EMAIL_RE.sub("[private contact]", clean)
    clean = _LOCATION_BRAIN_ADDRESS_RE.sub("[address]", clean)
    clean = _LOCATION_BRAIN_QUOTED_VALUE_RE.sub("[private value]", clean)
    return clean.strip()


def retrieve_location_brain_candidates(
    *,
    query: str,
    limit: int = 6,
    snapshot: Mapping[str, Any] | None = None,
    graph: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Semantically retrieve safe Location cards without any lexical fallback.

    The existing generic action retrieval stays untouched until the later
    voice migration.  This new path requires the startup-prewarmed managed
    index and returns ``ASK`` on cold, unavailable, low-confidence, or
    ambiguous input rather than guessing a Location action from tokens or
    aliases.
    """

    payload = graph if isinstance(graph, Mapping) else load_capability_graph()
    catalog = _location_brain_catalog_from_graph(payload)
    current_snapshot = (
        dict(snapshot)
        if isinstance(snapshot, Mapping)
        else build_location_brain_snapshot(graph=payload)
    )
    _validate_location_brain_snapshot(current_snapshot)
    empty_projection = build_location_turn_projection(
        snapshot=current_snapshot,
        candidates=[],
        graph=payload,
    )
    clean_query = _bounded_location_brain_query(str(query or ""))
    if not clean_query:
        return {**empty_projection, "retrieval_status": "ASK", "reason_code": "empty_query"}
    try:
        requested_limit = int(limit)
    except (TypeError, ValueError):
        requested_limit = 6
    # The product contract normally supplies four to six candidates.  Keep
    # this dedicated path narrower than the global ten-candidate hard ceiling
    # so a malformed caller cannot turn a safe selection prompt into a catalog
    # dump.
    bounded_limit = max(
        MIN_RETRIEVAL_RESULTS,
        min(6, min(MAX_RETRIEVAL_RESULTS, requested_limit)),
    )
    cards = _location_brain_index_cards(catalog)
    cache_revision = str(catalog.get("brain_revision") or "")
    graph_revision = str(payload.get("revision") or "")
    cache_ids = tuple(str(card.get("candidate_id") or "") for card in cards)
    with _LOCATION_BRAIN_SEMANTIC_CACHE_LOCK:
        if not _location_brain_cache_matches(
            graph_revision=graph_revision,
            brain_revision=cache_revision,
            candidate_ids=cache_ids,
        ):
            return {
                **empty_projection,
                "retrieval_status": "ASK",
                "reason_code": "semantic_index_unavailable",
            }
        cached_vectors = tuple(_LOCATION_BRAIN_SEMANTIC_CACHE["vectors"])
    try:
        query_vector = _embed_location_brain_texts(
            [clean_query],
            task_type="RETRIEVAL_QUERY",
            timeout_ms=_LOCATION_BRAIN_EMBEDDING_TIMEOUT_MS,
        )[0]
        ranked = sorted(
            (
                (sum(left * right for left, right in zip(query_vector, vector, strict=True)), card)
                for vector, card in zip(cached_vectors, cards, strict=True)
            ),
            key=lambda item: (-item[0], str(item[1].get("candidate_id") or "")),
        )
    except Exception:  # noqa: BLE001 - never disclose provider/model internals to a turn
        logger.info("location_brain_semantic_retrieval_unavailable")
        return {
            **empty_projection,
            "retrieval_status": "ASK",
            "reason_code": "semantic_index_unavailable",
        }
    if not ranked or ranked[0][0] < _LOCATION_BRAIN_MIN_SEMANTIC_SCORE:
        return {**empty_projection, "retrieval_status": "ASK", "reason_code": "low_confidence"}
    if len(ranked) > 1 and ranked[0][0] - ranked[1][0] < _LOCATION_BRAIN_AMBIGUITY_MARGIN:
        return {**empty_projection, "retrieval_status": "ASK", "reason_code": "ambiguous"}
    # Retrieval, rather than a chat model, makes the command choice.  The
    # score threshold and ambiguity margin above are the only admission
    # criteria; a result inside either fail-closed boundary is ASK.  Preserve
    # the best 4--6 candidates for diagnostics/evaluation, but keep the
    # highest-ranked registered id as a server-only deterministic selection.
    # It is still only a choice boundary, never an action grant: the command
    # runtime validates the id against this projection before advancing an
    # audited adapter, card, or navigation directive.
    selected = [card for _, card in ranked[:bounded_limit]]
    projection = build_location_turn_projection(
        snapshot=current_snapshot,
        candidates=selected,
        graph=payload,
    )
    selected_candidate_id = str(ranked[0][1].get("candidate_id") or "").strip()
    if not selected_candidate_id:
        return {
            **empty_projection,
            "retrieval_status": "ASK",
            "reason_code": "selection_unavailable",
        }
    return {
        **projection,
        "retrieval_status": "READY",
        "reason_code": "semantic",
        # This field is server-internal command state.  It is never included
        # in a model prompt or command wire payload.
        "selected_candidate_id": selected_candidate_id,
    }


def _service_brain_registry_descriptor(
    brains: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    """Return the small, safe registry fact a command runtime may expose."""

    return {
        "schema_version": SERVICE_BRAIN_REGISTRY_SCHEMA_VERSION,
        "service_ids": sorted(brains),
        "brain_revisions": {
            service_id: str(catalog.get("brain_revision") or "")
            for service_id, catalog in sorted(brains.items())
        },
    }


def retrieve_service_brain_candidates(
    *,
    query: str,
    limit: int = 6,
    snapshot: Mapping[str, Any] | None = None,
    graph: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Retrieve from registered service brains without alias/route fallback.

    The first command-runtime rollout has exactly one complete package:
    Location.  Delegating to its already-prewarmed semantic retriever keeps
    the current safety, privacy, and score thresholds intact.  As more
    packages gain an audited semantic index, this facade will fan out only to
    those registered brains.  Until then, more than one package is an
    explicit ``ASK`` rather than a guessed cross-service choice.
    """

    payload = graph if isinstance(graph, Mapping) else load_capability_graph()
    brains = list_complete_service_brain_model_projections(graph=payload)
    registry = _service_brain_registry_descriptor(brains)
    if tuple(brains) == ("location",):
        location_result = retrieve_location_brain_candidates(
            query=query,
            limit=limit,
            snapshot=snapshot,
            graph=payload,
        )
        # Keep Location's established turn-projection shape so the existing
        # constrained selector and executor need no special generic branch.
        return {**location_result, "service_brain_registry": registry}

    revision = str(payload.get("revision") or "") if isinstance(payload, Mapping) else ""
    if not brains:
        reason_code = "no_registered_service_brain"
    elif len(brains) > 1:
        reason_code = "cross_service_semantic_index_unavailable"
    else:
        reason_code = "service_semantic_index_unavailable"
    return {
        "schema_version": SERVICE_BRAIN_RETRIEVAL_SCHEMA_VERSION,
        "graph_revision": revision,
        "candidates": [],
        "selection_contract": {"field": "candidate_id_or_ASK", "allowed_values": ["ASK"]},
        "retrieval_status": "ASK",
        "reason_code": reason_code,
        "service_brain_registry": registry,
    }


def get_capability_workflow_revision_policy(
    workflow_id: str,
) -> CapabilityWorkflowRevisionPolicyV1:
    """Return one validated workflow's exact pinned-revision policy."""

    clean_workflow_id = str(workflow_id or "").strip()
    graph = load_capability_graph()
    revision = str(graph.get("revision") or "").strip()
    workflow = next(
        (
            item
            for item in graph.get("workflows") or []
            if isinstance(item, Mapping) and item.get("capability_id") == clean_workflow_id
        ),
        None,
    )
    compatibility = graph.get("workflow_revision_compatibility")
    entries = compatibility.get("workflows") if isinstance(compatibility, Mapping) else None
    policy = next(
        (
            item
            for item in entries or []
            if isinstance(item, Mapping) and item.get("workflow_id") == clean_workflow_id
        ),
        None,
    )
    if not revision or not isinstance(workflow, Mapping) or not isinstance(policy, Mapping):
        raise CapabilityGraphArtifactError("Capability workflow revision policy is unavailable.")
    return CapabilityWorkflowRevisionPolicyV1(
        workflow_id=clean_workflow_id,
        workflow_version=max(1, int(policy.get("workflow_version") or 1)),
        current_revision=revision,
        compatible_revisions=tuple(policy.get("compatible_graph_revisions") or ()),
        migration_required_revisions=tuple(policy.get("migration_required_graph_revisions") or ()),
        rejected_revisions=tuple(policy.get("rejected_graph_revisions") or ()),
    )


def build_capability_runtime_summary(*, max_workflows: int = 8) -> str:
    """Build bounded graph-derived grounding for One's runtime instruction.

    This is deliberately a discovery hint, not an action-selection authority.
    The generated graph may change between deploys, while ``list_app_actions``
    resolves the exact current request and trusted context at turn time.
    """
    graph = load_capability_graph()
    revision = str(graph.get("revision") or "")
    bounded_limit = max(1, min(12, int(max_workflows)))
    cached = _RUNTIME_SUMMARY_CACHE.get("summary")
    if _RUNTIME_SUMMARY_CACHE.get("revision") == revision and isinstance(cached, str) and cached:
        return cached
    labels = [
        str(workflow.get("label") or workflow.get("service_id") or "").strip()
        for workflow in graph.get("workflows") or []
        if isinstance(workflow, Mapping)
        and str(workflow.get("label") or workflow.get("service_id") or "").strip()
    ]
    specialist_labels = [
        str(service.get("label") or service.get("service_id") or "").strip()
        for service in graph.get("services") or []
        if isinstance(service, Mapping)
        and isinstance(service.get("one_exposure"), Mapping)
        and service["one_exposure"].get("discovery_status") == "discoverable"
        and str(service.get("label") or service.get("service_id") or "").strip()
    ]
    visible = labels[:bounded_limit]
    suffix = f" (+{len(labels) - len(visible)} more)" if len(labels) > len(visible) else ""
    discovered = ", ".join(visible) if visible else "none"
    specialist_visible = specialist_labels[:bounded_limit]
    specialist_suffix = (
        f" (+{len(specialist_labels) - len(specialist_visible)} more)"
        if len(specialist_labels) > len(specialist_visible)
        else ""
    )
    summary = (
        "RUNTIME CAPABILITY GRAPH (generated, not a static service roster): "
        f"registered setup workflows are {discovered}{suffix}; "
        f"discoverable specialist services are {', '.join(specialist_visible) or 'none'}{specialist_suffix}. "
        "This is orientation only. For every concrete request, call list_app_actions "
        "with the person's words and select only a returned candidate."
    )
    _RUNTIME_SUMMARY_CACHE["revision"] = revision
    _RUNTIME_SUMMARY_CACHE["summary"] = summary
    return summary


def get_capability(action_id: str | None) -> dict[str, Any] | None:
    clean_id = str(action_id or "").strip()
    if not clean_id:
        return None
    return next(
        (
            capability
            for capability in (
                list(load_capability_graph()["actions"])
                + list(load_capability_graph().get("workflows") or [])
                + list(load_capability_graph().get("services") or [])
            )
            if capability["capability_id"] == clean_id
        ),
        None,
    )


def is_server_direct_capability(action_id: str | None) -> bool:
    """Whether an action has an audited server execution path.

    This intentionally does not consult route or browser inventory.  The
    caller must still authenticate the session and revalidate domain facts at
    execution time.
    """
    clean_id = str(action_id or "").strip()
    capability = get_capability(clean_id)
    return bool(
        clean_id in SERVER_DIRECT_ACTION_IDS
        and isinstance(capability, dict)
        and capability.get("execution", {}).get("mode") == "server_direct"
        and capability.get("execution", {}).get("target", {}).get("status") == "wired"
    )


def server_direct_execution_allowed(
    action_id: str | None, context: Mapping[str, Any] | None
) -> bool:
    """Check the UI safety boundary without letting UI choose authorization."""
    if not is_server_direct_capability(action_id):
        return False
    if not isinstance(context, Mapping):
        return True
    if context.get("pending_settlement") is True:
        return False
    layer = context.get("interaction_layer")
    if not isinstance(layer, Mapping):
        return True
    if layer.get("modality") in {"modal", "blocking"} and not layer.get(
        "underlying_actions_available"
    ):
        return False
    return True


_CAPABILITY_RUN_RESUME_ID_RE = re.compile(r"^run_[A-Za-z0-9_-]{1,92}$")
_CAPABILITY_RUN_RESUME_CAPABILITY_RE = re.compile(r"^[a-z][a-z0-9_.:-]{0,191}$")
_CAPABILITY_RUN_RESUME_STEP_RE = re.compile(r"^[a-zA-Z0-9_.:-]{1,191}$")


def _bounded_capability_run_resume_summaries(value: Any) -> list[dict[str, str]]:
    """Keep only the non-private, non-authorizing durable task projection.

    The loader below is server-owned, but this second validation boundary keeps
    ``build_runtime_context`` safe for every future caller and test seam.  A
    summary is deliberately enough to offer recovery, not enough to execute:
    slots, entity values, interaction ids, graph/context revisions, receipts,
    timestamps, and owner identity never cross into live context.
    """

    if isinstance(value, (str, bytes, Mapping)) or not isinstance(value, Iterable):
        return []
    summaries: list[dict[str, str]] = []
    for raw in value:
        if not isinstance(raw, Mapping):
            continue
        run_id = str(raw.get("run_id") or "").strip()[:96]
        capability_id = str(raw.get("capability_id") or "").strip()[:192]
        status = str(raw.get("status") or "").strip()[:48]
        step = str(raw.get("step") or "").strip()[:192]
        if (
            not _CAPABILITY_RUN_RESUME_ID_RE.fullmatch(run_id)
            or not _CAPABILITY_RUN_RESUME_CAPABILITY_RE.fullmatch(capability_id)
            or status not in RESUMABLE_CAPABILITY_RUN_STATUSES
            or not _CAPABILITY_RUN_RESUME_STEP_RE.fullmatch(step)
        ):
            continue
        summary = {
            "run_id": run_id,
            "capability_id": capability_id,
            "status": status,
            "step": step,
        }
        if summary not in summaries:
            summaries.append(summary)
        if len(summaries) >= CAPABILITY_RUN_RESUME_SUMMARY_LIMIT:
            break
    return summaries


async def load_capability_run_resume_summaries(user_id: str | None) -> list[dict[str, str]]:
    """Read a bounded, current-release task recovery hint for Live context.

    This is intentionally a read-only server path.  A graph mismatch or data
    outage yields no summary instead of silently reviving a stale run or
    trusting a client-provided task.  The capability-run store itself selects
    only the four fields allowed to leave that boundary.
    """

    clean_user_id = str(user_id or "").strip()[:256]
    if not clean_user_id:
        return []
    try:
        graph = load_capability_graph()
        graph_revision = str(graph.get("revision") or "").strip()[:128]
        if not graph_revision:
            return []
        registered_capability_ids = {
            str(node.get("capability_id") or "").strip()
            for collection in ("actions", "workflows", "services")
            for node in graph.get(collection, [])
            if isinstance(node, Mapping) and str(node.get("capability_id") or "").strip()
        }
        summaries = await get_capability_run_store().list_resume_summaries(
            user_id=clean_user_id,
            graph_revision=graph_revision,
            limit=CAPABILITY_RUN_RESUME_SUMMARY_LIMIT,
        )
    except Exception:  # noqa: BLE001 - outage must not expose a stale/client task
        logger.info("app_intelligence_capability_run_resume_unavailable")
        return []

    projected = _bounded_capability_run_resume_summaries(
        {
            "run_id": getattr(summary, "run_id", None),
            "capability_id": getattr(summary, "capability_id", None),
            "status": getattr(summary, "status", None),
            "step": getattr(summary, "step", None),
        }
        for summary in summaries
        if str(getattr(summary, "capability_id", "") or "").strip() in registered_capability_ids
    )
    return projected


def build_runtime_context(
    *,
    user_id: str | None,
    sanitized_client_context: Mapping[str, Any] | None,
    consent_claim_present: bool,
    persisted_onboarding: Mapping[str, Any] | None = None,
    service_runtime_state: Mapping[str, Any] | None = None,
    capability_run_summaries: Iterable[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build live context from server-known identity plus bounded UI hints.

    ``sanitized_client_context`` is already through the websocket trust
    boundary.  It contributes route/presentation hints only.  Identity and the
    list of server-direct capabilities derive here, and each execution still
    repeats token, consent, and domain checks through its service seam.
    """
    graph = load_capability_graph()
    context = sanitized_client_context if isinstance(sanitized_client_context, Mapping) else {}
    authenticated = bool(str(user_id or "").strip())
    direct_ids = [
        action_id
        for action_id in sorted(SERVER_DIRECT_ACTION_IDS)
        if authenticated and server_direct_execution_allowed(action_id, context)
    ]
    result = {
        "schema_version": RUNTIME_CONTEXT_SCHEMA_VERSION,
        "graph_revision": graph["revision"],
        "source": "server",
        "identity": {"authenticated": authenticated},
        # This is a posture signal for a conversational clarification only;
        # it never grants authority.  _verify_backend_direct_authorization()
        # validates the actual token and its DB-backed revocation status.
        "consent": {"claim_present": bool(consent_claim_present)},
        "route_hint": str(context.get("route_pattern") or context.get("route_family") or "")[:128]
        or None,
        "server_direct_action_ids": direct_ids,
        # A durable task may be offered on relaunch, but never executed from
        # this context. The array elements have exactly run/capability/status/
        # step and are independently validated above.
        "capability_runs": _bounded_capability_run_resume_summaries(capability_run_summaries or ()),
        "domain_state": "resolved_at_execution",
    }
    if isinstance(persisted_onboarding, Mapping):
        # This is a redacted server snapshot. In particular it intentionally
        # excludes browser phase, raw route state, OAuth artifacts, identity
        # values, and private service data.
        result["onboarding"] = dict(persisted_onboarding)
    if (
        isinstance(service_runtime_state, Mapping)
        and service_runtime_state.get("source") == "service_list_state"
        and service_runtime_state.get("status") == "ready"
    ):
        # This argument is accepted only from an authenticated server-side
        # loader such as ``load_service_runtime_state``. Retain its bounded
        # projection rather than any raw domain payload.
        result["service_runtime_state"] = dict(service_runtime_state)
    # The graph revision is server-produced. Context revision is admitted only
    # when it matches the opaque v2 grammar; routes, queries, entities, slots,
    # and all other live-context fields remain outside telemetry.
    update_voice_telemetry_correlation(
        context_revision=context.get("context_revision"),
        graph_revision=graph.get("revision"),
    )
    record_runtime_milestone("context_resolved", status="ready")
    return result


def attach_runtime_context(
    sanitized_client_context: Mapping[str, Any],
    *,
    user_id: str | None,
    consent_claim_present: bool,
    persisted_onboarding: Mapping[str, Any] | None = None,
    service_runtime_state: Mapping[str, Any] | None = None,
    capability_run_summaries: Iterable[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Attach server-owned runtime facts to an already-sanitized context."""
    result = dict(sanitized_client_context)
    runtime_context = build_runtime_context(
        user_id=user_id,
        sanitized_client_context=result,
        consent_claim_present=consent_claim_present,
        persisted_onboarding=persisted_onboarding,
        service_runtime_state=service_runtime_state,
        capability_run_summaries=capability_run_summaries,
    )
    result["app_intelligence"] = runtime_context
    if (
        isinstance(persisted_onboarding, Mapping)
        and persisted_onboarding.get("source") == "vault_keys"
        and isinstance(persisted_onboarding.get("onboarding"), Mapping)
    ):
        # Agent tools historically read ``voice_context.onboarding``. Keep
        # that public shape, but replace browser-provided phase/active-service
        # hints only after an authenticated server snapshot succeeds.
        result["onboarding"] = dict(persisted_onboarding["onboarding"])
    return result


def _bounded_service_ids(value: Any) -> list[str]:
    available = {
        str(workflow.get("state_capability_id") or workflow.get("service_id") or "")
        for workflow in list_service_onboarding_workflows()
    }
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for raw in value:
        clean = str(raw or "").strip().lower()[:64]
        if clean and clean in available and clean not in result:
            result.append(clean)
    return sorted(result)


def build_persisted_onboarding_context(
    persisted_state: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Translate the vault-backed onboarding record into a bounded runtime view.

    The source record is deliberately authoritative only after it has crossed
    the server's vault service boundary. This adapter does not write state and
    does not use client route or phase values to infer progress, so it is safe
    on cold reconnects and across web/iOS sessions.
    """
    state = persisted_state if isinstance(persisted_state, Mapping) else {}
    phase = str(state.get("onboardingPhase") or "").strip()
    if phase not in _ONBOARDING_PHASES:
        phase = ""
    active_capability = _persisted_service_id(
        str(state.get("onboardingActiveCapability") or "").strip().lower()[:64]
    )
    callback_state = str(state.get("onboardingCallbackState") or "none").strip()
    if callback_state not in _ONBOARDING_CALLBACK_STATES:
        callback_state = "none"
    root_resolved = state.get("setupCompleted") is True
    if not phase:
        phase = (
            "root_completion"
            if root_resolved
            else "capability_setup"
            if active_capability
            else "setup_hub"
        )
    if root_resolved:
        # A stale active capability cannot resurrect setup after the durable
        # root completion flag has settled.
        active_capability = ""
        phase = "root_completion"
    setup_capability_ids = _bounded_service_ids(state.get("setupCapabilityIds"))
    revision = state.get("onboardingJourneyUpdatedAt")
    revision = str(revision)[:64] if revision not in (None, "") else None
    active_workflow_id = (
        next(
            (
                str(workflow.get("capability_id") or "")
                for workflow in list_service_onboarding_workflows()
                if str(workflow.get("state_capability_id") or workflow.get("service_id") or "")
                == active_capability
            ),
            None,
        )
        if active_capability
        else None
    )
    return {
        "schema_version": PERSISTED_ONBOARDING_CONTEXT_SCHEMA_VERSION,
        "source": "vault_keys",
        "status": "ready",
        "revision": revision,
        "onboarding": {
            "phase": phase,
            "active_capability": active_capability or None,
            "root_resolved": root_resolved,
            "return_route": "/one/setup",
            "callback_state": callback_state,
            # The pre-vault state does not carry a verified phone fact. Keep
            # it unknown rather than borrowing a browser assertion.
            "phone_verified": None,
            "setup_capability_ids": setup_capability_ids,
        },
        "active_workflow_id": active_workflow_id,
    }


async def load_persisted_onboarding_context(user_id: str | None) -> dict[str, Any]:
    """Load one trusted onboarding snapshot without exposing storage failures.

    Callers cache this per live socket and refresh only after a setup
    settlement or route transition. A database outage becomes a bounded
    ``state_unavailable`` result, never permission to trust client phase.
    """
    clean_user_id = str(user_id or "").strip()
    if not clean_user_id:
        return {
            "schema_version": PERSISTED_ONBOARDING_CONTEXT_SCHEMA_VERSION,
            "source": "anonymous",
            "status": "not_applicable",
        }
    try:
        from hushh_mcp.services.vault_keys_service import VaultKeysService

        state = await VaultKeysService().get_pre_vault_state(clean_user_id)
    except Exception:  # noqa: BLE001 - no storage error reaches the voice/model path
        logger.info("app_intelligence_onboarding_state_unavailable")
        return {
            "schema_version": PERSISTED_ONBOARDING_CONTEXT_SCHEMA_VERSION,
            "source": "vault_keys_unavailable",
            "status": "unavailable",
        }
    return build_persisted_onboarding_context(state)


def build_service_runtime_state(
    service_id: str | None,
    raw_state: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Project a service read into a bounded, server-owned state summary.

    The model gets collection counts and section names only. It never receives
    raw people, circle ids, locations, encrypted envelopes, preferences, or
    route/browser assertions through this context. A concrete action still
    resolves its own domain entities through the normal authenticated service.
    """
    clean_service_id = _service_key(service_id)
    state = raw_state if isinstance(raw_state, Mapping) else {}
    if not clean_service_id:
        return {
            "schema_version": SERVICE_RUNTIME_STATE_SCHEMA_VERSION,
            "source": "service_state",
            "status": "unsupported",
        }
    collection_counts: dict[str, int] = {}
    sections: list[str] = []
    for raw_key, value in state.items():
        key = str(raw_key or "").strip()
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", key):
            continue
        sections.append(key)
        if isinstance(value, (list, tuple)):
            # A bounded count is enough for routing (for example, whether a
            # person has circles or pending requests) and does not leak the
            # identities or private values inside those records.
            collection_counts[key] = min(len(value), 50)
    return {
        "schema_version": SERVICE_RUNTIME_STATE_SCHEMA_VERSION,
        "source": "service_list_state",
        "status": "ready",
        "service_id": clean_service_id,
        "summary": {
            "available_sections": sorted(sections)[:64],
            "collection_counts": dict(sorted(collection_counts.items())),
        },
    }


async def load_service_runtime_state(
    service_id: str | None,
    user_id: str | None,
) -> dict[str, Any]:
    """Load a trusted service state through its existing server read seam.

    This follows a conventional service module/class name so a future service
    can participate without a prompt edit. It is deliberately on-demand,
    never on websocket bootstrap: Location's state read is useful for an
    explicit plan but too expensive and too private for every foreground tap.
    """
    clean_service_id = _service_key(service_id)
    clean_user_id = str(user_id or "").strip()
    if not clean_service_id:
        return {
            "schema_version": SERVICE_RUNTIME_STATE_SCHEMA_VERSION,
            "source": "service_state",
            "status": "unsupported",
        }
    if not clean_user_id:
        return {
            "schema_version": SERVICE_RUNTIME_STATE_SCHEMA_VERSION,
            "source": "anonymous",
            "status": "not_applicable",
            "service_id": clean_service_id,
        }
    class_stem = "".join(part.title() for part in clean_service_id.split("_") if part)
    try:
        module = importlib.import_module(f"hushh_mcp.services.one_{clean_service_id}_agent_service")
        service_class = getattr(module, f"One{class_stem}AgentService")
        service = service_class()
        list_state = service.list_state
        if not callable(list_state):
            raise TypeError("service has no list_state seam")
        from starlette.concurrency import run_in_threadpool

        raw_state = await run_in_threadpool(list_state, user_id=clean_user_id)
    except Exception:  # noqa: BLE001 - never turn a service read outage into client authority
        logger.info("app_intelligence_service_state_unavailable service=%s", clean_service_id)
        return {
            "schema_version": SERVICE_RUNTIME_STATE_SCHEMA_VERSION,
            "source": "service_state_unavailable",
            "status": "unavailable",
            "service_id": clean_service_id,
        }
    return build_service_runtime_state(
        clean_service_id,
        raw_state if isinstance(raw_state, Mapping) else None,
    )


async def load_location_runtime_state(user_id: str | None) -> dict[str, Any]:
    """Reference helper for Location; discovery still uses the generic seam."""
    return await load_service_runtime_state("location", user_id)


@dataclass(frozen=True)
class LocationOnboardingCompletionReceiptV1:
    """Opaque, server-issued evidence required to settle Location onboarding.

    The four values are identifiers only.  A future adapter must mint each one
    after it observes its own trusted boundary: the actual native-permission
    interaction, a durable encrypted-place write, the server Circle bootstrap,
    and the final server-side predicate re-read.  Coordinates, labels, route
    state, audio, transcript, and client completion assertions are explicitly
    outside this contract.

    This is deliberately a value object, not an HTTP payload.  No current
    route accepts these fields from a browser or device.  The first real
    adapter will construct it within the backend after its source operations
    settle, then persist its redacted slots through ``CapabilityRunStore``.
    """

    permission_receipt_id: str
    place_receipt_id: str
    circle_receipt_id: str
    completion_receipt_id: str
    schema_version: str = LOCATION_ONBOARDING_COMPLETION_RECEIPT_SCHEMA_VERSION

    def to_slots(self) -> dict[str, str]:
        """Serialize only bounded opaque receipts for encrypted run storage."""

        raw = {
            _LOCATION_ONBOARDING_RECEIPT_SCHEMA_SLOT: self.schema_version,
            _LOCATION_ONBOARDING_PERMISSION_RECEIPT_SLOT: self.permission_receipt_id,
            _LOCATION_ONBOARDING_PLACE_RECEIPT_SLOT: self.place_receipt_id,
            _LOCATION_ONBOARDING_CIRCLE_RECEIPT_SLOT: self.circle_receipt_id,
            _LOCATION_ONBOARDING_COMPLETION_RECEIPT_SLOT: self.completion_receipt_id,
        }
        validated = _validated_location_onboarding_receipt_slots(raw)
        if validated is None:
            raise ValueError("Location onboarding receipt identifiers are invalid.")
        return validated


def _validated_location_onboarding_receipt_slots(
    raw_slots: Mapping[str, Any] | None,
) -> dict[str, str] | None:
    """Accept only the redacted server-receipt shape, never client facts.

    The task store encrypts slots, but encryption is not a provenance check.
    This validation makes the exact receipt contract explicit and intentionally
    rejects booleans such as ``permissionGranted`` or arbitrary place values.
    """

    if not isinstance(raw_slots, Mapping):
        return None
    schema = str(raw_slots.get(_LOCATION_ONBOARDING_RECEIPT_SCHEMA_SLOT) or "").strip()
    if schema != LOCATION_ONBOARDING_COMPLETION_RECEIPT_SCHEMA_VERSION:
        return None
    validated: dict[str, str] = {
        _LOCATION_ONBOARDING_RECEIPT_SCHEMA_SLOT: schema,
    }
    for key, pattern in _LOCATION_ONBOARDING_RECEIPT_ID_PATTERNS.items():
        value = raw_slots.get(key)
        if not isinstance(value, str):
            return None
        cleaned = value.strip()
        if not pattern.fullmatch(cleaned):
            return None
        validated[key] = cleaned
    return validated


def location_onboarding_completion_receipt_satisfied(
    run: CapabilityRunV1 | Any | None,
) -> bool:
    """Whether an owned run carries all server-issued Location evidence.

    This is intentionally the only predicate that authorizes the terminal
    Location transition.  Generic onboarding markers remain useful for setup
    routing, but cannot substitute for these real-operation receipts.
    """

    slots = getattr(run, "slots", None) if run is not None else None
    return _validated_location_onboarding_receipt_slots(slots) is not None


def _location_onboarding_vault_marker_present(
    snapshot: Mapping[str, Any] | None,
) -> bool:
    """Read the old setup marker as one prerequisite, never terminal proof."""

    state = snapshot if isinstance(snapshot, Mapping) else {}
    if state.get("source") != "vault_keys" or state.get("status") != "ready":
        return False
    onboarding = state.get("onboarding")
    onboarding = onboarding if isinstance(onboarding, Mapping) else {}
    return "location" in set(_bounded_service_ids(onboarding.get("setup_capability_ids")))


def _workflow_settlement(
    workflow: Mapping[str, Any],
    snapshot: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Evaluate durable setup state without promoting route facts to success."""
    state = snapshot if isinstance(snapshot, Mapping) else {}
    source_ready = state.get("source") == "vault_keys" and state.get("status") == "ready"
    onboarding = state.get("onboarding") if isinstance(state.get("onboarding"), Mapping) else {}
    service_id = str(workflow.get("state_capability_id") or workflow.get("service_id") or "")
    completed = set(_bounded_service_ids(onboarding.get("setup_capability_ids")))
    marker_present = source_ready and service_id in completed

    # Location is the first workflow that requires evidence from multiple
    # independently-owned operations.  Its generic setup marker is retained as
    # a routing prerequisite only; it cannot settle a CapabilityRun by itself.
    # The run-scoped receipt is checked by ``settle_location_onboarding_run``
    # after it loads encrypted slots through the server store.  This generic
    # function intentionally has no run id and must therefore fail closed.
    if str(workflow.get("capability_id") or "") == _LOCATION_ONBOARDING_WORKFLOW_ID:
        return {
            "source": "vault_keys",
            "state_capability_id": service_id,
            "setup_marker_present": marker_present,
            "receipt_schema": LOCATION_ONBOARDING_COMPLETION_RECEIPT_SCHEMA_VERSION,
            "verified": False,
            "success": False,
            "completion_claim_allowed": False,
            "reason": (
                "location_server_completion_receipt_required"
                if marker_present
                else "location_setup_marker_missing"
                if source_ready
                else "persisted_onboarding_state_unavailable"
            ),
        }

    verified = marker_present
    return {
        "source": "vault_keys",
        "state_capability_id": service_id,
        "verified": verified,
        "success": verified,
        "completion_claim_allowed": verified,
        "reason": (
            "persisted_service_completion_marker_present"
            if verified
            else "persisted_service_completion_marker_missing"
            if source_ready
            else "persisted_onboarding_state_unavailable"
        ),
    }


async def verify_service_onboarding_settlement(
    workflow_id: str | None,
    user_id: str | None,
) -> dict[str, Any]:
    """Refresh and verify workflow completion from the durable state seam.

    A local terminal action, native permission callback, or route transition is
    never sufficient. The result is intentionally small so it can be used by
    voice, typed input, Siri, and tests without exposing onboarding internals.
    """
    workflow = get_service_onboarding_workflow(workflow_id)
    if workflow is None:
        return {
            "status": "unsupported",
            "workflow_id": str(workflow_id or "").strip() or None,
            "verified": False,
            "completion_claim_allowed": False,
        }
    snapshot = await load_persisted_onboarding_context(user_id)
    settlement = _workflow_settlement(workflow, snapshot)
    return {
        "status": "completed_verified" if settlement["success"] else "pending_verification",
        "workflow_id": workflow["capability_id"],
        "verified": settlement["verified"],
        "completion_claim_allowed": settlement["completion_claim_allowed"],
        "settlement": settlement,
    }


def resolve_service_onboarding_workflow(
    workflow_id: str | None,
    persisted_onboarding: Mapping[str, Any] | None,
    *,
    route_hint: str | None = None,
) -> dict[str, Any]:
    """Choose a server-owned EXECUTE/NAVIGATE/RENDER workflow step.

    This returns metadata only. Navigation still goes through the generated
    action directive; local permission/OAuth interaction remains on its
    existing route, and terminal local actions remain ledger-settled. No new
    render directive or browser-authored onboarding state is introduced.
    """
    workflow = get_service_onboarding_workflow(workflow_id)
    if workflow is None:
        return {
            "status": "unsupported",
            "outcome": "RENDER",
            "render_surface": "existing_route_surface",
            "directive": None,
            "completion_claim_allowed": False,
        }
    snapshot = persisted_onboarding if isinstance(persisted_onboarding, Mapping) else {}
    plan = workflow.get("plan") if isinstance(workflow.get("plan"), Mapping) else {}
    settlement = _workflow_settlement(workflow, snapshot)
    if snapshot.get("source") != "vault_keys" or snapshot.get("status") != "ready":
        return {
            "status": "state_unavailable",
            "workflow_id": workflow["capability_id"],
            "outcome": "RENDER",
            "render_surface": "existing_route_surface",
            "directive": None,
            "message": "I need to verify setup progress before continuing.",
            "plan": dict(plan),
            "settlement": settlement,
            "completion_claim_allowed": False,
        }
    onboarding = snapshot.get("onboarding")
    onboarding = onboarding if isinstance(onboarding, Mapping) else {}
    service_id = str(workflow.get("state_capability_id") or workflow.get("service_id") or "")
    active_capability = str(onboarding.get("active_capability") or "")
    route_pattern = str(workflow.get("route_pattern") or "")
    # Root setup completion can legitimately coexist with a skipped optional
    # capability. It is not proof that this service finished, so never use it
    # to tell a person that Location (or any future service) is ready.
    if settlement["success"] and active_capability != service_id:
        result = {
            "status": "completed",
            "workflow_id": workflow["capability_id"],
            "outcome": "RENDER",
            "render_surface": "existing_route_surface",
            "directive": None,
            "terminal_action_ids": [],
            "plan": dict(plan),
            "settlement": settlement,
            "completion_claim_allowed": True,
        }
        # A completed setup is not a reason to replay it. Location is the
        # first workflow with an approved operational destination, so expose
        # a typed offer instead of a fabricated completion action or prose
        # that makes the model guess where to send the person next.
        if service_id == "location":
            result["offer_action_id"] = "location.open_now"
            result["message"] = (
                "The server has recorded the existing Location setup as complete. "
                "I can open Location when you want."
            )
        return result
    if active_capability and active_capability != service_id:
        return {
            "status": "another_service_active",
            "workflow_id": workflow["capability_id"],
            "outcome": "RENDER",
            "render_surface": "existing_route_surface",
            "directive": None,
            "message": "Finish or leave the currently active setup before starting another one.",
            "plan": dict(plan),
            "settlement": settlement,
            "completion_claim_allowed": False,
        }
    clean_route_hint = str(route_hint or "").partition("?")[0]
    clean_route_pattern = route_pattern.partition("?")[0]
    if active_capability == service_id and clean_route_hint == clean_route_pattern:
        native_actions = [
            dict(action)
            for action in workflow.get("native_semantic_actions") or []
            if isinstance(action, Mapping)
        ]
        if native_actions:
            return {
                "status": "awaiting_native_semantic_interaction",
                "workflow_id": workflow["capability_id"],
                "outcome": "EXECUTE",
                "executor": "native_semantic_action",
                "native_semantic_actions": native_actions,
                # The current frontend already owns the corresponding native
                # bridge from its Location setup surface. Do not emit a novel
                # directive that a different surface might accidentally run.
                "directive": None,
                "render_surface": "existing_route_surface",
                "requires_existing_route_surface": True,
                "message": (
                    "The existing setup surface needs its registered device permission "
                    "interaction before completion can be verified."
                ),
                "plan": dict(plan),
                "settlement": settlement,
                "completion_claim_allowed": False,
            }
        return {
            "status": "awaiting_service_interaction",
            "workflow_id": workflow["capability_id"],
            "outcome": "RENDER",
            "render_surface": "existing_route_surface",
            "directive": None,
            "terminal_action_ids": list(workflow.get("terminal_action_ids") or []),
            "plan": dict(plan),
            "settlement": settlement,
            "completion_claim_allowed": False,
        }
    return {
        "status": (
            "resume_navigation"
            if active_capability == service_id
            else "post_root_navigation"
            if onboarding.get("root_resolved") is True
            else "cold_navigation"
        ),
        "workflow_id": workflow["capability_id"],
        "outcome": "NAVIGATE",
        "entry_action_id": workflow["entry_action_id"],
        "route_pattern": route_pattern,
        "plan": dict(plan),
        "settlement": settlement,
        "completion_claim_allowed": False,
    }


def _location_onboarding_workflow(workflow_id: str | None) -> dict[str, Any] | None:
    """Return the first audited Location workflow, never a look-alike id.

    This narrow seam is deliberately Location-first.  Other generated setup
    workflows keep their existing route behaviour until each has its own
    executor/settlement evidence; accepting them here would make a generic
    durable row look like an audited automation adapter.
    """

    workflow = get_service_onboarding_workflow(workflow_id)
    if (
        not isinstance(workflow, Mapping)
        or str(workflow.get("capability_id") or "") != _LOCATION_ONBOARDING_WORKFLOW_ID
        or str(workflow.get("service_id") or "") != "location"
    ):
        return None
    return dict(workflow)


def _location_onboarding_run_projection(run: CapabilityRunV1 | Any | None) -> dict[str, str] | None:
    """Return the only task fields safe for an orchestration/tool response."""

    if run is None:
        return None
    run_id = str(getattr(run, "run_id", "") or "").strip()[:96]
    status = str(getattr(run, "status", "") or "").strip()[:48]
    step = str(getattr(run, "step_cursor", "") or "").strip()[:192]
    if not run_id or not status or not step:
        return None
    return {"run_id": run_id, "status": status, "step": step}


def _location_onboarding_result(
    *,
    decision: Mapping[str, Any],
    status: str,
    run: CapabilityRunV1 | Any | None = None,
    completion_claim_allowed: bool | None = None,
) -> dict[str, Any]:
    """Build a typed result without leaking slots, identity, or route state."""

    safe_decision = dict(decision)
    result: dict[str, Any] = {
        "schema_version": LOCATION_ONBOARDING_RUN_RESULT_SCHEMA_VERSION,
        "workflow_id": _LOCATION_ONBOARDING_WORKFLOW_ID,
        "status": status,
        "outcome": str(safe_decision.get("outcome") or "RENDER"),
        "decision": safe_decision,
        "completion_claim_allowed": bool(
            safe_decision.get("completion_claim_allowed")
            if completion_claim_allowed is None
            else completion_claim_allowed
        ),
    }
    projection = _location_onboarding_run_projection(run)
    if projection is not None:
        result["run"] = projection
    return result


def resolve_location_onboarding_turn(
    *,
    workflow_id: str | None,
    persisted_onboarding: Mapping[str, Any] | None,
    route_hint: str | None = None,
) -> dict[str, Any]:
    """Resolve Location's next safe result layer from trusted state only.

    This is intentionally a selector, not an executor.  It can say that the
    next result is navigation, a route-owned permission interaction, or an
    approved existing surface; it cannot convert a route hint, browser result,
    or model assertion into Location completion.
    """

    if _location_onboarding_workflow(workflow_id) is None:
        return {
            "status": "unsupported",
            "workflow_id": str(workflow_id or "").strip() or None,
            "outcome": "RENDER",
            "render_surface": "existing_route_surface",
            "directive": None,
            "completion_claim_allowed": False,
        }
    return resolve_service_onboarding_workflow(
        _LOCATION_ONBOARDING_WORKFLOW_ID,
        persisted_onboarding,
        route_hint=route_hint,
    )


def _location_onboarding_graph_identity() -> tuple[int, str]:
    workflow = _location_onboarding_workflow(_LOCATION_ONBOARDING_WORKFLOW_ID)
    graph = load_capability_graph()
    revision = str(graph.get("revision") or "").strip()
    if workflow is None or not revision:
        raise CapabilityRunAuthorityError("Location onboarding graph is unavailable.")
    return max(1, int(workflow.get("version") or 1)), revision


def _location_onboarding_step_for(decision: Mapping[str, Any]) -> str:
    return (
        _LOCATION_ONBOARDING_NAVIGATE_STEP
        if str(decision.get("outcome") or "") == "NAVIGATE"
        else _LOCATION_ONBOARDING_INTERACTION_STEP
    )


async def _read_location_onboarding_run(
    *,
    user_id: str,
    graph_revision: str,
    run_id: str | None,
    include_slots: bool = False,
) -> CapabilityRunV1 | None:
    """Load one owned current-graph run, failing closed on ambiguity."""

    store = get_capability_run_store()
    clean_run_id = str(run_id or "").strip()[:96]
    if clean_run_id:
        run = await store.get(
            user_id=user_id,
            run_id=clean_run_id,
            include_slots=include_slots,
        )
        if (
            run is None
            or str(getattr(run, "capability_id", "") or "") != _LOCATION_ONBOARDING_WORKFLOW_ID
            or str(getattr(run, "graph_revision", "") or "") != graph_revision
        ):
            raise CapabilityRunAuthorityError("Location onboarding run is unavailable.")
        return run
    finder = getattr(store, "find_unique_resumable", None)
    if not callable(finder):
        raise CapabilityRunAuthorityError("Location onboarding resume registry is unavailable.")
    return await finder(
        user_id=user_id,
        capability_id=_LOCATION_ONBOARDING_WORKFLOW_ID,
        graph_revision=graph_revision,
        include_slots=include_slots,
    )


async def _transition_location_onboarding_to_verified(
    *,
    run: CapabilityRunV1,
    user_id: str,
) -> tuple[CapabilityRunV1, bool]:
    """Terminally settle a run only after server receipt validation.

    The generic Vault marker and run-scoped opaque receipts are re-read by the
    caller before it reaches this transition.  The stored settlement value is a
    constant receipt label, which the task store one-way hashes; no route,
    coordinates, place label, or private domain value is persisted here.
    """

    store = get_capability_run_store()
    current = run
    if current.status == "verified_succeeded":
        return current, True
    if current.status in {"verified_failed", "cancelled", "expired"}:
        return current, False

    def needs_authorization(status: str) -> bool:
        return status in {
            "proposed",
            "needs_input",
            "entity_choice",
            "interaction_required",
            "confirmation_required",
            "paused",
        }

    try:
        if needs_authorization(str(current.status)):
            current = await store.transition(
                user_id=user_id,
                run_id=current.run_id,
                expected_revision=current.revision,
                to_status="authorized",
                step_cursor=_LOCATION_ONBOARDING_VERIFY_STEP,
                pending_interaction=None,
            )
        if current.status == "authorized":
            current = await store.transition(
                user_id=user_id,
                run_id=current.run_id,
                expected_revision=current.revision,
                to_status="executing",
                step_cursor=_LOCATION_ONBOARDING_VERIFY_STEP,
                pending_interaction=None,
            )
        if current.status == "executing":
            current = await store.transition(
                user_id=user_id,
                run_id=current.run_id,
                expected_revision=current.revision,
                to_status="settlement_received",
                step_cursor=_LOCATION_ONBOARDING_SETTLEMENT_STEP,
                pending_interaction=None,
                settlement_reference=("workflow.setup.location:server_completion_receipt_v1"),
            )
        if current.status == "settlement_received":
            current = await store.transition(
                user_id=user_id,
                run_id=current.run_id,
                expected_revision=current.revision,
                to_status="verified_succeeded",
                step_cursor=_LOCATION_ONBOARDING_VERIFIED_STEP,
                pending_interaction=None,
            )
    except Exception:  # noqa: BLE001 - a durable-store outage must fail closed
        # A retry reads the durable row again.  Do not infer a success from a
        # partially applied CAS sequence or a lost database response.
        logger.info("app_intelligence_location_onboarding_settlement_transition_unavailable")
        return current, False
    return current, current.status == "verified_succeeded"


async def settle_location_onboarding_run(
    *,
    user_id: str | None,
    run_id: str | None,
    persisted_onboarding: Mapping[str, Any] | None,
    route_hint: str | None = None,
    fresh_persisted_state: bool,
) -> dict[str, Any]:
    """Settle Location only from fresh marker plus server-issued receipts.

    This is the sole success path for the route-owned Location setup run.  A
    generic setup marker is only one prerequisite.  A permission callback,
    native/browser action result, visible screen, client action settlement, or
    client-provided slot is intentionally insufficient.
    """

    decision = resolve_location_onboarding_turn(
        workflow_id=_LOCATION_ONBOARDING_WORKFLOW_ID,
        persisted_onboarding=persisted_onboarding,
        route_hint=route_hint,
    )
    clean_user_id = str(user_id or "").strip()[:256]
    clean_run_id = str(run_id or "").strip()[:96]
    if not clean_user_id or not clean_run_id:
        return _location_onboarding_result(
            decision=decision,
            status="run_unavailable",
            completion_claim_allowed=False,
        )
    if not fresh_persisted_state:
        return _location_onboarding_result(
            decision=decision,
            status="verification_refresh_required",
            completion_claim_allowed=False,
        )
    if not _location_onboarding_vault_marker_present(persisted_onboarding):
        return _location_onboarding_result(
            decision=decision,
            status="awaiting_persisted_settlement",
            completion_claim_allowed=False,
        )
    try:
        _version, graph_revision = _location_onboarding_graph_identity()
        run = await _read_location_onboarding_run(
            user_id=clean_user_id,
            graph_revision=graph_revision,
            run_id=clean_run_id,
            include_slots=True,
        )
        if run is None:
            raise CapabilityRunAuthorityError("Location onboarding run is unavailable.")
        if not location_onboarding_completion_receipt_satisfied(run):
            return _location_onboarding_result(
                decision=decision,
                status="awaiting_verified_location_receipt",
                run=run,
                completion_claim_allowed=False,
            )
        settled, verified = await _transition_location_onboarding_to_verified(
            run=run,
            user_id=clean_user_id,
        )
    except Exception:  # noqa: BLE001 - a durable-store outage must fail closed
        logger.info("app_intelligence_location_onboarding_settlement_unavailable")
        return _location_onboarding_result(
            decision=decision,
            status="settlement_pending",
            completion_claim_allowed=False,
        )
    return _location_onboarding_result(
        decision=decision,
        status="verified_succeeded" if verified else "settlement_pending",
        run=settled,
        completion_claim_allowed=verified,
    )


async def advance_location_onboarding_run(
    *,
    user_id: str | None,
    workflow_id: str | None,
    persisted_onboarding: Mapping[str, Any] | None,
    route_hint: str | None = None,
    context_revision: str | None = None,
    run_id: str | None = None,
    fresh_persisted_state: bool = False,
) -> dict[str, Any]:
    """Create or resume Location's durable route-owned interaction state.

    It does not dispatch a client directive, request permission, capture a
    position, or call a completion endpoint.  The caller uses its returned
    NAVIGATE/EXECUTE/RENDER decision to invoke the already registered surface.
    This separation keeps a model or browser from turning a route into a
    backend mutation.
    """

    decision = resolve_location_onboarding_turn(
        workflow_id=workflow_id,
        persisted_onboarding=persisted_onboarding,
        route_hint=route_hint,
    )
    if decision.get("status") == "unsupported":
        return _location_onboarding_result(
            decision=decision,
            status="unsupported",
            completion_claim_allowed=False,
        )
    if _location_onboarding_vault_marker_present(persisted_onboarding):
        # A legacy generic marker never creates a fake historical success.  It
        # can settle only an existing run carrying the typed, server-issued
        # completion receipt.  Historical rows without that receipt remain
        # recoverable but deliberately pending until a real adapter records
        # evidence from permission/place/Circle operations.
        if not fresh_persisted_state:
            return _location_onboarding_result(
                decision=decision,
                status="verification_refresh_required",
                completion_claim_allowed=False,
            )
        clean_user_id = str(user_id or "").strip()[:256]
        if not clean_user_id:
            return _location_onboarding_result(
                decision=decision,
                status="unauthenticated",
                completion_claim_allowed=False,
            )
        try:
            _version, graph_revision = _location_onboarding_graph_identity()
            current = await _read_location_onboarding_run(
                user_id=clean_user_id,
                graph_revision=graph_revision,
                run_id=str(run_id or "").strip()[:96] or None,
                include_slots=True,
            )
        except Exception:  # noqa: BLE001 - a durable-store outage must fail closed
            logger.info("app_intelligence_location_onboarding_resume_lookup_unavailable")
            return _location_onboarding_result(
                decision=decision,
                status="settlement_pending",
                completion_claim_allowed=False,
            )
        if current is None:
            return _location_onboarding_result(
                decision=decision,
                status="completion_receipt_required",
                completion_claim_allowed=False,
            )
        return await settle_location_onboarding_run(
            user_id=clean_user_id,
            run_id=current.run_id,
            persisted_onboarding=persisted_onboarding,
            route_hint=route_hint,
            fresh_persisted_state=True,
        )
    if decision.get("status") in {"state_unavailable", "another_service_active"}:
        # We cannot persist a durable task from a state we did not verify, and
        # we do not steal a different service's active setup workflow.
        return _location_onboarding_result(
            decision=decision,
            status=str(decision.get("status") or "blocked"),
            completion_claim_allowed=False,
        )

    clean_user_id = str(user_id or "").strip()[:256]
    if not clean_user_id:
        return _location_onboarding_result(
            decision=decision,
            status="unauthenticated",
            completion_claim_allowed=False,
        )
    try:
        version, graph_revision = _location_onboarding_graph_identity()
        current = await _read_location_onboarding_run(
            user_id=clean_user_id,
            graph_revision=graph_revision,
            run_id=run_id,
        )
        if current is None:
            snapshot = persisted_onboarding if isinstance(persisted_onboarding, Mapping) else {}
            scope_revision = str(snapshot.get("revision") or "").strip()[:64] or "unversioned"
            current = await get_capability_run_store().create(
                user_id=clean_user_id,
                capability_id=_LOCATION_ONBOARDING_WORKFLOW_ID,
                capability_version=version,
                graph_revision=graph_revision,
                slots={},
                context_revision=str(context_revision or "")[:192],
                expected_context_revision=str(context_revision or "")[:192],
                status="interaction_required",
                step_cursor=_location_onboarding_step_for(decision),
                pending_interaction=_LOCATION_ONBOARDING_INTERACTION,
                # The store hashes this scope.  It carries no route, label,
                # coordinate, person, transcript, or client assertion.
                idempotency_scope=f"location-onboarding:{scope_revision}",
            )
        elif current.status == "paused":
            current = await get_capability_run_store().transition(
                user_id=clean_user_id,
                run_id=current.run_id,
                expected_revision=current.revision,
                to_status="interaction_required",
                step_cursor=_location_onboarding_step_for(decision),
                context_revision=str(context_revision or "")[:192],
                expected_context_revision=str(context_revision or "")[:192],
                pending_interaction=_LOCATION_ONBOARDING_INTERACTION,
            )
    except Exception:  # noqa: BLE001 - a durable-store outage must fail closed
        # Do not send the person into a flow we could not make resumable.
        logger.info("app_intelligence_location_onboarding_durability_unavailable")
        return _location_onboarding_result(
            decision=decision,
            status="durability_unavailable",
            completion_claim_allowed=False,
        )

    run_status = str(getattr(current, "status", "") or "")
    if run_status in {"verified_failed", "cancelled", "expired"}:
        return _location_onboarding_result(
            decision=decision,
            status="run_terminal",
            run=current,
            completion_claim_allowed=False,
        )
    if run_status in {"authorized", "executing", "settlement_received"}:
        return _location_onboarding_result(
            decision=decision,
            status="settling",
            run=current,
            completion_claim_allowed=False,
        )
    return _location_onboarding_result(
        decision=decision,
        status="interaction_required",
        run=current,
        completion_claim_allowed=False,
    )


async def resume_location_onboarding_run(
    *,
    user_id: str | None,
    run_id: str | None,
    route_hint: str | None = None,
    context_revision: str | None = None,
) -> dict[str, Any]:
    """Resume one owned Location run after re-reading server state.

    This is deliberately the restart path, not a generic client-provided task
    executor.  It refreshes the Vault snapshot first and returns the bounded
    task projection plus its next safe outcome.
    """

    snapshot = await load_persisted_onboarding_context(user_id)
    return await advance_location_onboarding_run(
        user_id=user_id,
        workflow_id=_LOCATION_ONBOARDING_WORKFLOW_ID,
        persisted_onboarding=snapshot,
        route_hint=route_hint,
        context_revision=context_revision,
        run_id=run_id,
        fresh_persisted_state=True,
    )


def retrieve_capability_candidates(
    query: str,
    *,
    limit: int = 6,
    context: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Return 4--10 semantically ranked, registered capability candidates.

    The client route does not remove a server-direct candidate.  Other actions
    retain their explicit EXECUTE/NAVIGATE/RENDER outcome, so the model can ask
    for a card or navigate instead of hallucinating an unavailable operation.
    """
    bounded_limit = max(MIN_RETRIEVAL_RESULTS, min(MAX_RETRIEVAL_RESULTS, int(limit)))
    # Keep the capability compiler import-light.  ``one_adk`` eagerly builds
    # its agent package on import, so importing semantic retrieval while a
    # websocket context is warming would put model/runtime work on the tap
    # path.  Retrieval is needed only after the person asks a question.
    from hushh_mcp.one_adk import action_retrieval
    from hushh_mcp.one_adk.action_retrieval import (
        lexical_score,
        search_actions,
        search_knowledge_steps,
    )

    graph = load_capability_graph()
    action_entries = list_action_gateway_actions()
    by_id = {str(capability["capability_id"]): capability for capability in graph["actions"]}
    workflows = [
        workflow for workflow in graph.get("workflows") or [] if isinstance(workflow, Mapping)
    ]
    clean_query = str(query or "").strip()[:4_000]
    ordered_ids: list[tuple[str, float, str]] = []
    # Never trigger an embedding-model download or first load in a live turn.
    # The model can be prewarmed by the host; until then the generated aliases
    # and Gemini's own semantic judgement provide the fast bounded candidate
    # set.  This avoids turning a tap into a multi-second model bootstrap.
    embedding_client = getattr(action_retrieval, "_embedding_client", None)
    semantic_model_is_warm = bool(getattr(embedding_client, "_model", None))
    if clean_query and semantic_model_is_warm:
        try:
            hits = search_actions(
                clean_query,
                {"actions": action_entries},
                limit=bounded_limit * 3,
            )
            ordered_ids = [
                (hit.action_id, float(hit.score), str(hit.retrieval_branch)) for hit in hits
            ]
        except Exception:  # noqa: BLE001 - lexical fallback preserves an available runtime
            logger.info("app_intelligence_candidate_retrieval_degraded")
    if not ordered_ids:
        ranked = sorted(
            (
                (str(entry.get("action_id") or ""), float(lexical_score(entry, clean_query)))
                for entry in action_entries
                if str(entry.get("action_id") or "")
            ),
            key=lambda item: (-item[1], item[0]),
        )
        ordered_ids = [(action_id, score, "lexical") for action_id, score in ranked]

    # Workflow packages publish a bounded semantic step projection.  It shares
    # the already-warm embedding client but never loads that model on a live
    # turn; cold sessions retain exact multilingual lexical retrieval.
    workflow_ranked_by_id: dict[str, tuple[float, str]] = {}
    knowledge_matches_by_workflow: dict[str, list[Any]] = {}
    exact_workflow_alias_ids: set[str] = set()
    if clean_query:
        normalized_query = " ".join(clean_query.casefold().split())
        for workflow in workflows:
            workflow_id = str(workflow.get("capability_id") or "")
            if normalized_query and any(
                normalized_query == " ".join(str(alias).casefold().split())
                for alias in workflow.get("aliases") or []
            ):
                # Checked-in workflow aliases are authored product intent, not
                # model-generated prose.  When a legacy UI action shares that
                # exact phrase, the durable workflow owns the turn so a
                # terminal screen action cannot bypass start/resume.
                exact_workflow_alias_ids.add(workflow_id)
            searchable_workflow = {
                "action_id": workflow_id,
                "label": workflow.get("label"),
                "meaning": workflow.get("description"),
                "aliases": workflow.get("aliases"),
                "search_keywords": workflow.get("search_keywords"),
            }
            score = float(lexical_score(searchable_workflow, clean_query))
            if score > 0:
                workflow_ranked_by_id[workflow_id] = (
                    score,
                    "workflow_lexical",
                )
        knowledge_hits = search_knowledge_steps(
            clean_query,
            workflows,
            limit=bounded_limit * 3,
            semantic_enabled=semantic_model_is_warm,
        )
        for hit in knowledge_hits:
            matches = knowledge_matches_by_workflow.setdefault(hit.workflow_id, [])
            matches.append(hit)
            current_score = workflow_ranked_by_id.get(hit.workflow_id, (0.0, ""))[0]
            if hit.retrieval_branch == "knowledge_lexical":
                knowledge_score = float(hit.score) + 5.0
            elif hit.retrieval_branch == "knowledge_fused":
                knowledge_score = max(1.0, 38.0 - float(hit.rank))
            else:
                knowledge_score = max(1.0, 32.0 - float(hit.rank))
            if knowledge_score > current_score:
                workflow_ranked_by_id[hit.workflow_id] = (
                    knowledge_score,
                    hit.retrieval_branch,
                )

    workflow_ranked = [
        (workflow_id, score, branch)
        for workflow_id, (score, branch) in workflow_ranked_by_id.items()
    ]

    ranked_items = [
        ("action", action_id, score, branch) for action_id, score, branch in ordered_ids
    ] + [("workflow", workflow_id, score, branch) for workflow_id, score, branch in workflow_ranked]
    ranked_items.sort(
        key=lambda item: (
            -item[2],
            0 if item[0] == "workflow" and item[1] in exact_workflow_alias_ids else 1,
            item[0],
            item[1],
        )
    )

    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    workflow_by_id = {str(workflow.get("capability_id") or ""): workflow for workflow in workflows}
    matched_workflow_entry_actions = {
        str(workflow.get("entry_action_id") or "").strip()
        for workflow_id in workflow_ranked_by_id
        if isinstance((workflow := workflow_by_id.get(workflow_id)), Mapping)
        and str(workflow.get("entry_action_id") or "").strip()
    }
    exact_workflow_legacy_action_ids: set[str] = set()
    for workflow_id in exact_workflow_alias_ids:
        workflow = workflow_by_id.get(workflow_id)
        if not isinstance(workflow, Mapping):
            continue
        plan = workflow.get("plan")
        if not isinstance(plan, Mapping):
            continue
        for executor in plan.get("executor_hierarchy") or []:
            if not isinstance(executor, Mapping):
                continue
            if executor.get("kind") != "existing_ui_semantic_action":
                continue
            exact_workflow_legacy_action_ids.update(
                str(action_id).strip()
                for action_id in executor.get("action_ids") or []
                if str(action_id).strip()
            )
    for capability_type, capability_id, score, branch in ranked_items:
        if capability_id in seen:
            continue
        if capability_type == "workflow":
            workflow = workflow_by_id.get(capability_id)
            if not isinstance(workflow, Mapping):
                continue
            projection = (
                workflow.get("knowledge_projection")
                if isinstance(workflow.get("knowledge_projection"), Mapping)
                else {}
            )
            max_step_matches = max(
                1,
                min(3, int(projection.get("max_retrieved_steps") or 3)),
            )
            step_matches = knowledge_matches_by_workflow.get(capability_id, [])[:max_step_matches]
            execution = (
                workflow.get("execution") if isinstance(workflow.get("execution"), Mapping) else {}
            )
            plan = dict(workflow.get("plan")) if isinstance(workflow.get("plan"), Mapping) else {}
            candidates.append(
                {
                    "capability_id": capability_id,
                    "capability_type": "service_onboarding",
                    "workflow_id": capability_id,
                    "service_id": workflow.get("service_id"),
                    "entry_action_id": workflow.get("entry_action_id"),
                    "label": workflow.get("label"),
                    "description": workflow.get("description"),
                    "aliases": workflow.get("aliases", []),
                    "supported_entrypoints": list(workflow.get("supported_entrypoints") or [])[:3],
                    "outcome": str(execution.get("outcome") or "NAVIGATE"),
                    "render_surface": (
                        "render.one_location_workflow_card"
                        if projection.get("package_id") == "location.onboarding"
                        else "existing_route_surface"
                    ),
                    "plan": plan,
                    "knowledge_projection": (
                        {
                            "schema_version": projection.get("schema_version"),
                            "package_id": projection.get("package_id"),
                            "workflow_version": projection.get("workflow_version"),
                            "allowed_fact_keys": list(projection.get("allowed_fact_keys") or [])[
                                :8
                            ],
                        }
                        if projection
                        else None
                    ),
                    "matched_steps": [hit.to_projection() for hit in step_matches],
                    "runtime_automation_ready": bool(plan.get("runtime_automation_ready", True)),
                    "runtime_automation_blockers": list(
                        plan.get("runtime_automation_blockers") or []
                    )[:12],
                    "native_semantic_actions": [
                        dict(action)
                        for action in workflow.get("native_semantic_actions") or []
                        if isinstance(action, Mapping)
                    ],
                    "api_endpoint_count": len(workflow.get("api_endpoints") or []),
                    "confirmation": {"required": False, "mode": "none"},
                    "score": score,
                    "retrieval_branch": branch,
                }
            )
            seen.add(capability_id)
            if len(candidates) >= bounded_limit:
                break
            continue
        action_id = capability_id
        if (
            action_id in matched_workflow_entry_actions
            or action_id in exact_workflow_legacy_action_ids
        ):
            # The route action is this workflow's presentation fallback.  A
            # separate candidate would let One navigate without first
            # reserving the durable task, so the generated workflow owns the
            # semantic match whenever both are present.
            continue
        capability = by_id.get(action_id)
        if not isinstance(capability, dict):
            continue
        target = capability.get("execution", {}).get("target", {})
        if target.get("status") != "wired":
            continue
        if capability.get("execution", {}).get(
            "mode"
        ) == "server_direct" and not server_direct_execution_allowed(action_id, context):
            continue
        candidates.append(
            {
                "capability_id": action_id,
                "capability_type": "action",
                "label": capability.get("label"),
                "description": capability.get("description"),
                "aliases": capability.get("aliases", []),
                "inputSchema": capability.get("inputSchema"),
                "required_entities": capability.get("required_entities", []),
                "outcome": capability.get("execution", {}).get("outcome"),
                "render_surface": capability.get("render_surface"),
                "confirmation": capability.get("confirmation"),
                "score": score,
                "retrieval_branch": branch,
            }
        )
        seen.add(action_id)
        if len(candidates) >= bounded_limit:
            break
    record_runtime_milestone("candidate_retrieval", status="ok")
    return candidates


def runtime_action_outcome(action_id: str | None) -> str | None:
    capability = get_capability(action_id)
    if not isinstance(capability, dict):
        return None
    execution = capability.get("execution")
    return str(execution.get("outcome")) if isinstance(execution, Mapping) else None


def runtime_render_surface(action_id: str | None) -> str | None:
    capability = get_capability(action_id)
    return (
        str(capability.get("render_surface"))
        if isinstance(capability, dict) and capability.get("render_surface")
        else None
    )


def runtime_confirmation_required(action_id: str | None) -> bool:
    capability = get_capability(action_id)
    confirmation = capability.get("confirmation") if isinstance(capability, dict) else None
    return bool(confirmation.get("required")) if isinstance(confirmation, Mapping) else False


def action_catalog_ids() -> Iterable[str]:
    """Stable action ids for protocol consumers and contract tests."""
    return (str(capability["capability_id"]) for capability in load_capability_graph()["actions"])

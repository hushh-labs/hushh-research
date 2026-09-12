"""Strict authored contract for Hussh product agents."""

from __future__ import annotations

import os
import re
from pathlib import PurePosixPath
from typing import Any, Literal

import yaml
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from hushh_mcp.constants import GEMINI_MODEL


class StrictManifestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AgentToolConfig(StrictManifestModel):
    name: str
    description: str
    py_func: str
    required_scope: str


class AgentInputConfig(StrictManifestModel):
    name: str
    type: str
    description: str | None = None


class AgentOutputConfig(StrictManifestModel):
    name: str
    type: str
    description: str | None = None


class AgentModelConfig(StrictManifestModel):
    provider: str = "gemini"
    name: str = Field(default_factory=lambda: GEMINI_MODEL)
    mode: str = "hushh_managed_vertex"
    credential_ref: str | None = None


class CredentialPolicy(StrictManifestModel):
    default: str = "hushh_managed_vertex"
    allowed: list[str] = Field(default_factory=lambda: ["hushh_managed_vertex"])


class RuntimeContract(StrictManifestModel):
    kind: Literal["adk", "deterministic", "hybrid"] = "adk"
    factory: str | None = None
    adk_mode: Literal["chat", "task", "single_turn"] = "single_turn"
    transport: list[Literal["in_process", "chat", "voice", "a2a", "mcp"]] = Field(
        default_factory=lambda: ["in_process"]
    )


class AuthorityContract(StrictManifestModel):
    invocation: list[str] = Field(default_factory=list)
    data: list[str] = Field(default_factory=list)
    actions: list[str] = Field(default_factory=list)


class SideEffectContract(StrictManifestModel):
    name: str
    confirmation: Literal["none", "explicit_user_confirmation", "owner_only"]
    idempotent: bool
    timeout_seconds: int = Field(gt=0)
    max_retries: int = Field(ge=0, le=5)


class PkmContract(StrictManifestModel):
    behavior: Literal["none", "read", "propose_mutation", "confirmed_mutation"] = "none"
    mutation_contract: str | None = None


class SurfaceContract(StrictManifestModel):
    chat: bool = False
    voice: bool = False
    a2a: bool = False
    mcp: bool = False
    web: bool = False
    ios: bool = False
    android: bool = False
    not_applicable_reason: str | None = None


class PrivacyContract(StrictManifestModel):
    context_allowlist: list[str] = Field(default_factory=list)
    plaintext_telemetry: bool = False


class EvaluationContract(StrictManifestModel):
    dataset: str | None = None
    threshold: float = Field(default=1.0, ge=0, le=1)


class PerformanceContract(StrictManifestModel):
    latency_p95_ms: int = Field(default=30000, gt=0)
    max_output_tokens: int = Field(default=4096, gt=0)


class RolloutContract(StrictManifestModel):
    """How an agent is turned off.

    ``kill_switch`` is optional because a declared switch that nothing reads is worse
    than none: it advertises a control an operator would reach for in an incident and
    find inert. Declare one only when the runtime actually honours it; the guard in
    tests/test_agent_manifests.py refuses any name that no code reads.
    """

    kill_switch: str | None = None
    strategy: Literal["off", "internal", "canary", "general"] = "off"
    rollback: str


class EnvironmentAvailabilityContract(StrictManifestModel):
    """Authored deployment boundary for a product agent or internal child."""

    environments: list[Literal["development", "uat", "production"]] = Field(
        default_factory=lambda: ["development", "uat", "production"]
    )
    loopback_only: bool = False
    enable_flag: str | None = None


class KnowledgePackageReference(StrictManifestModel):
    """Reference from one authored product-agent manifest to owned knowledge.

    The reference is metadata, not execution authority.  Capability-graph
    compilation resolves the file relative to the owning manifest, validates
    its typed package, and separately resolves every declared binding.
    """

    schema_version: Literal["one.knowledge_package_ref.v1"] = "one.knowledge_package_ref.v1"
    package_id: str = Field(
        min_length=3,
        max_length=128,
        pattern=r"^[a-z][a-z0-9_.-]*$",
    )
    package_version: int = Field(ge=1)
    path: str = Field(min_length=5, max_length=128)

    @field_validator("path")
    @classmethod
    def require_local_yaml_path(cls, value: str) -> str:
        clean = str(value or "").strip()
        path = PurePosixPath(clean)
        if (
            not clean
            or path.is_absolute()
            or ".." in path.parts
            or path.suffix not in {".yaml", ".yml"}
        ):
            raise ValueError(
                "knowledge package path must be a relative YAML path without traversal"
            )
        return clean


class OneExposureContract(StrictManifestModel):
    """Manifest-owned admission declaration for a specialist beneath One.

    ``agent_one.capabilities.specialist_roster`` remains the authoritative list
    of One's direct specialists.  A roster member declares this compact
    projection so generated capability consumers can identify its stable
    product service without maintaining another agent-id map in runtime code.
    It deliberately says nothing about authorization or execution authority;
    those continue to live in the existing action, route, and consent
    contracts.
    """

    service_id: str = Field(
        min_length=2,
        max_length=64,
        pattern=r"^[a-z][a-z0-9_]*$",
    )
    discovery_status: Literal["discoverable", "withheld"]
    exposure_status: Literal["active", "limited", "disabled"]
    supported_entrypoints: list[Literal["typed", "voice", "siri_app_shortcut"]] = Field(
        min_length=1,
        max_length=3,
    )
    knowledge_package_ref: KnowledgePackageReference | None = None

    @field_validator("supported_entrypoints")
    @classmethod
    def reject_duplicate_entrypoints(
        cls, values: list[Literal["typed", "voice", "siri_app_shortcut"]]
    ) -> list[Literal["typed", "voice", "siri_app_shortcut"]]:
        if len(values) != len(set(values)):
            raise ValueError("duplicate One exposure entrypoints are not allowed")
        return values

    @model_validator(mode="after")
    def validate_discovery_and_exposure_status(self) -> "OneExposureContract":
        if self.discovery_status == "withheld" and self.exposure_status != "disabled":
            raise ValueError("withheld One discovery must use disabled exposure")
        if self.discovery_status == "discoverable" and self.exposure_status == "disabled":
            raise ValueError("discoverable One service cannot use disabled exposure")
        return self


class LocationKnowledgeBindingV1(StrictManifestModel):
    """One Location workflow step's non-authorizing binding reference."""

    kind: Literal[
        "state_resolver",
        "generated_action",
        "native_semantic_action",
        "native_interaction",
        "approved_interaction",
        "backend_adapter",
    ]
    ref: str = Field(
        min_length=3,
        max_length=160,
        pattern=r"^[a-z][a-z0-9_.:-]*$",
    )


class LocationKnowledgeTransitionV1(StrictManifestModel):
    """A deterministic transition selected from verified workflow facts."""

    when: str = Field(
        min_length=2,
        max_length=64,
        pattern=r"^[a-z][a-z0-9_]*$",
    )
    target: str = Field(min_length=3, max_length=160)

    @field_validator("target")
    @classmethod
    def require_step_or_terminal_target(cls, value: str) -> str:
        clean = str(value or "").strip()
        if clean in {"$verified_succeeded", "$paused", "$cancelled", "$failed"}:
            return clean
        if not re.fullmatch(r"location\.onboarding\.[a-z][a-z0-9_]*", clean):
            raise ValueError("transition target must be a Location step id or terminal state")
        return clean


class LocationKnowledgeStepV1(StrictManifestModel):
    """Typed, static product knowledge for one Location onboarding step."""

    step_id: str = Field(
        min_length=3,
        max_length=160,
        pattern=r"^location\.onboarding\.[a-z][a-z0-9_]*$",
    )
    label: str = Field(min_length=2, max_length=96)
    description: str = Field(min_length=8, max_length=360)
    outcome: Literal["ASK", "EXECUTE", "NAVIGATE", "RENDER"]
    completion_policy: Literal["required", "informational", "explicit_skip_allowed"]
    aliases: list[str] = Field(min_length=1, max_length=20)
    search_keywords: list[str] = Field(default_factory=list, max_length=20)
    presentation_states: list[Literal["welcome", "features", "place", "ready"]] = Field(
        default_factory=list,
        max_length=4,
    )
    binding: LocationKnowledgeBindingV1
    render_surface: str | None = Field(default=None, max_length=128)
    verifier_ref: str = Field(
        min_length=3,
        max_length=160,
        pattern=r"^[a-z][a-z0-9_.:-]*$",
    )
    transitions: list[LocationKnowledgeTransitionV1] = Field(min_length=1, max_length=12)
    telemetry_event: Literal["app_intelligence.location_onboarding_step"] = (
        "app_intelligence.location_onboarding_step"
    )

    @field_validator("aliases", "search_keywords")
    @classmethod
    def reject_duplicate_or_blank_search_terms(cls, values: list[str]) -> list[str]:
        cleaned = [str(value or "").strip() for value in values]
        if any(not value for value in cleaned):
            raise ValueError("knowledge search terms cannot be blank")
        if len(cleaned) != len(set(cleaned)):
            raise ValueError("duplicate knowledge search terms are not allowed")
        return cleaned

    @field_validator("presentation_states")
    @classmethod
    def reject_duplicate_presentation_states(
        cls, values: list[Literal["welcome", "features", "place", "ready"]]
    ) -> list[Literal["welcome", "features", "place", "ready"]]:
        if len(values) != len(set(values)):
            raise ValueError("duplicate presentation states are not allowed")
        return values

    @model_validator(mode="after")
    def require_render_surface_for_render_outcome(self) -> "LocationKnowledgeStepV1":
        if self.outcome in {"ASK", "RENDER"} and not self.render_surface:
            raise ValueError("ASK and RENDER steps require an approved render surface")
        if self.outcome not in {"ASK", "RENDER"} and self.render_surface is not None:
            raise ValueError("only ASK and RENDER steps may declare a render surface")
        transition_conditions = [transition.when for transition in self.transitions]
        if len(transition_conditions) != len(set(transition_conditions)):
            raise ValueError("step transition conditions must be unique")
        return self


class LocationKnowledgeMigrationV1(StrictManifestModel):
    """Fail-closed cursor mapping from an earlier workflow contract."""

    from_workflow_version: int = Field(ge=1)
    policy: Literal["map_known_cursor_fail_closed"] = "map_known_cursor_fail_closed"
    cursor_map: dict[str, str] = Field(min_length=1, max_length=32)

    @field_validator("cursor_map")
    @classmethod
    def require_bounded_cursor_map(cls, value: dict[str, str]) -> dict[str, str]:
        cleaned: dict[str, str] = {}
        for source, target in value.items():
            source_id = str(source or "").strip()
            target_id = str(target or "").strip()
            if not re.fullmatch(r"[a-z][a-z0-9_.:-]{2,159}", source_id):
                raise ValueError("migration source cursor is invalid")
            if not re.fullmatch(r"location\.onboarding\.[a-z][a-z0-9_]*", target_id):
                raise ValueError("migration target must be a Location knowledge step")
            cleaned[source_id] = target_id
        return cleaned


class LocationKnowledgeContextProjectionV1(StrictManifestModel):
    """Only these bounded fact names may be projected into a live turn."""

    schema_version: Literal["one.location_context_projection.v1"] = (
        "one.location_context_projection.v1"
    )
    allowed_fact_keys: list[
        Literal[
            "permission_status",
            "position_receipt_status",
            "place_status",
            "circle_status",
            "completion_status",
            "current_step_id",
            "workflow_version",
            "run_revision",
        ]
    ] = Field(min_length=1, max_length=8)
    max_retrieved_steps: int = Field(default=3, ge=1, le=3)

    @field_validator("allowed_fact_keys")
    @classmethod
    def reject_duplicate_fact_keys(
        cls,
        values: list[
            Literal[
                "permission_status",
                "position_receipt_status",
                "place_status",
                "circle_status",
                "completion_status",
                "current_step_id",
                "workflow_version",
                "run_revision",
            ]
        ],
    ) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("duplicate Location context fact keys are not allowed")
        return list(values)


class LocationKnowledgeRetryPolicyV1(StrictManifestModel):
    """Bounded retry contract; a model never chooses retry behavior."""

    schema_version: Literal["one.location_retry_policy.v1"] = "one.location_retry_policy.v1"
    automatic_retry_limit: Literal[0]
    adapter_attempt_limit_per_directive: Literal[1]
    retry_count_limit: Literal["bounded_by_run_ttl"]
    retry_window_seconds: Literal[86_400]
    backoff_strategy: Literal["none_new_lease_required"]
    retryable_failure_classes: list[
        Literal[
            "transient_backend",
            "provider_timeout",
            "provider_rate_limit",
            "provider_5xx",
        ]
    ] = Field(min_length=1, max_length=4)
    on_attempt_failure: Literal["pause_with_approved_recovery_surface"]
    fresh_interaction_lease_required: Literal[True]

    @field_validator("retryable_failure_classes")
    @classmethod
    def validate_retry_classes(
        cls,
        values: list[
            Literal[
                "transient_backend",
                "provider_timeout",
                "provider_rate_limit",
                "provider_5xx",
            ]
        ],
    ) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("Location retryable failure classes must be unique")
        return list(values)


class LocationKnowledgePausePolicyV1(StrictManifestModel):
    """Exact durable pause/resume interaction contract."""

    schema_version: Literal["one.location_pause_policy.v1"] = "one.location_pause_policy.v1"
    pause_action: Literal["pause"]
    resume_action: Literal["resume"]
    resume_surface_id: Literal["one.location.paused.v2"]
    preserve_run: Literal[True]
    preserve_verified_receipts: Literal[True]
    resume_cursor_policy: Literal["same_canonical_step"]
    fresh_interaction_lease_required: Literal[True]


class LocationKnowledgeExpiryPolicyV1(StrictManifestModel):
    """Run, directive, and encrypted-draft expiry boundaries."""

    schema_version: Literal["one.location_expiry_policy.v1"] = "one.location_expiry_policy.v1"
    run_ttl_seconds: Literal[86_400]
    interaction_lease_ttl_seconds: int = Field(ge=30, le=600)
    secure_draft_ttl_seconds: Literal[86_400]
    on_run_expiry: Literal["expire_fail_closed_then_server_preflight"]
    on_lease_expiry: Literal["issue_fresh_directive_without_replaying_action"]


class LocationKnowledgeRecoveryPolicyV1(StrictManifestModel):
    """Fail-closed recovery outcomes for state that cannot be trusted."""

    schema_version: Literal["one.location_recovery_policy.v1"] = "one.location_recovery_policy.v1"
    fail_closed: Literal[True]
    stale_context_action: Literal["reload_server_run_before_dispatch"]
    stale_graph_action: Literal["require_declared_migration"]
    provider_failure_action: Literal["pause_with_approved_recovery_surface"]
    lost_local_secret_action: Literal["recapture_position_and_place"]
    invalid_or_replayed_lease_action: Literal["reject_and_reload"]
    unknown_state_action: Literal["pause_without_success_claim"]
    success_claim_policy: Literal["verified_backend_settlement_only"]


class LocationKnowledgeGraphCompatibilityV1(StrictManifestModel):
    """How an active run remains pinned or moves between graph revisions."""

    schema_version: Literal["one.location_graph_compatibility.v1"] = (
        "one.location_graph_compatibility.v1"
    )
    run_revision_mode: Literal["pin_at_creation"]
    resume_mode: Literal["pinned_or_declared_migration"]
    version_migration_policy: Literal["declared_cursor_map_only"]
    stale_revision_action: Literal["fail_closed"]
    unknown_cursor_action: Literal["fail_closed"]
    source_digest_required: Literal[True]


class LocationKnowledgeActiveRunPolicyV1(StrictManifestModel):
    """Cross-route and cross-session behavior for one active workflow."""

    schema_version: Literal["one.location_active_run_policy.v1"] = (
        "one.location_active_run_policy.v1"
    )
    uniqueness_scope: Literal["one_open_run_per_user_and_capability"]
    duplicate_start_action: Literal["resume_existing_run"]
    route_change_action: Literal["preserve_run_and_interaction"]
    app_background_action: Literal["stop_audio_and_preserve_run"]
    app_termination_action: Literal["resume_from_server_state"]
    accepted_backend_work_action: Literal["settle_once_then_reconcile"]
    duplicate_dispatch_action: Literal["reject"]


class LocationKnowledgeTelemetryPolicyV1(StrictManifestModel):
    """Bounded event and data classification for Location workflow traces."""

    schema_version: Literal["one.location_telemetry_policy.v1"] = "one.location_telemetry_policy.v1"
    event_schema: Literal["one.voice_telemetry.v2"]
    event_ids: list[str] = Field(min_length=1, max_length=12)
    correlation_ids: list[
        Literal[
            "trace_id",
            "activation_id",
            "voice_session_id",
            "turn_id",
            "context_revision",
            "graph_revision",
            "action_id",
            "directive_id",
        ]
    ] = Field(min_length=8, max_length=8)
    allowed_value_classes: list[
        Literal["enum", "boolean", "count", "bucket", "duration", "opaque_id"]
    ] = Field(min_length=6, max_length=6)
    prohibited_sensitive_classes: list[
        Literal[
            "raw_audio",
            "transcript",
            "coordinates",
            "precise_location",
            "contact_identifier",
            "financial_secret",
            "credential",
            "private_provider_payload",
            "slot_value",
            "entity_value",
            "route_query",
            "raw_error",
            "arbitrary_summary",
        ]
    ] = Field(min_length=13, max_length=13)
    error_value_policy: Literal["bounded_reason_code_only"]

    @field_validator("event_ids")
    @classmethod
    def validate_location_event_ids(cls, values: list[str]) -> list[str]:
        cleaned = [str(value or "").strip() for value in values]
        if len(cleaned) != len(set(cleaned)) or any(
            not re.fullmatch(r"one\.location\.[a-z][a-z0-9_.]*", value) for value in cleaned
        ):
            raise ValueError("Location telemetry event ids must be unique stable ids")
        return cleaned

    @model_validator(mode="after")
    def require_complete_privacy_taxonomy(self) -> "LocationKnowledgeTelemetryPolicyV1":
        expected_correlations = {
            "trace_id",
            "activation_id",
            "voice_session_id",
            "turn_id",
            "context_revision",
            "graph_revision",
            "action_id",
            "directive_id",
        }
        expected_allowed = {"enum", "boolean", "count", "bucket", "duration", "opaque_id"}
        expected_prohibited = {
            "raw_audio",
            "transcript",
            "coordinates",
            "precise_location",
            "contact_identifier",
            "financial_secret",
            "credential",
            "private_provider_payload",
            "slot_value",
            "entity_value",
            "route_query",
            "raw_error",
            "arbitrary_summary",
        }
        if set(self.correlation_ids) != expected_correlations:
            raise ValueError("Location telemetry correlation ids are incomplete")
        if set(self.allowed_value_classes) != expected_allowed:
            raise ValueError("Location telemetry value classes are incomplete")
        if set(self.prohibited_sensitive_classes) != expected_prohibited:
            raise ValueError("Location telemetry privacy exclusions are incomplete")
        return self


class LocationKnowledgePackageV1(StrictManifestModel):
    """Authored Location workflow knowledge compiled into CapabilityGraphV1.

    The package describes product state and registered hand-offs.  It carries
    no user values and grants no authority.  The capability compiler separately
    validates every action, native interaction, render surface, verifier, and
    migration before the package can enter a generated artifact.
    """

    schema_version: Literal["one.location_knowledge_package.v1"] = (
        "one.location_knowledge_package.v1"
    )
    package_id: Literal["location.onboarding"] = "location.onboarding"
    package_version: int = Field(ge=1)
    service_id: Literal["location"] = "location"
    workflow_id: Literal["workflow.setup.location"] = "workflow.setup.location"
    workflow_version: int = Field(ge=2)
    label: str = Field(min_length=3, max_length=96)
    description: str = Field(min_length=12, max_length=480)
    aliases: list[str] = Field(min_length=1, max_length=24)
    search_keywords: list[str] = Field(default_factory=list, max_length=24)
    supported_entrypoints: list[Literal["typed", "voice", "siri_app_shortcut"]] = Field(
        min_length=1,
        max_length=3,
    )
    route_pattern: Literal["/one/setup/location"] = "/one/setup/location"
    screen: Literal["one_setup_location"] = "one_setup_location"
    entry_action_id: Literal["setup.open_location"] = "setup.open_location"
    completion_action_id: Literal["setup.finish_location"] = "setup.finish_location"
    initial_step_id: str = Field(pattern=r"^location\.onboarding\.[a-z][a-z0-9_]*$")
    completion_receipt_schema: Literal["one.location_onboarding_completion_receipt.v1"] = (
        "one.location_onboarding_completion_receipt.v1"
    )
    retry_policy: LocationKnowledgeRetryPolicyV1
    pause_policy: LocationKnowledgePausePolicyV1
    expiry_policy: LocationKnowledgeExpiryPolicyV1
    recovery_policy: LocationKnowledgeRecoveryPolicyV1
    graph_compatibility: LocationKnowledgeGraphCompatibilityV1
    active_run_policy: LocationKnowledgeActiveRunPolicyV1
    telemetry_policy: LocationKnowledgeTelemetryPolicyV1
    context_projection: LocationKnowledgeContextProjectionV1
    steps: list[LocationKnowledgeStepV1] = Field(min_length=1, max_length=12)
    migrations: list[LocationKnowledgeMigrationV1] = Field(min_length=1, max_length=8)

    @field_validator("aliases", "search_keywords")
    @classmethod
    def reject_duplicate_or_blank_package_search_terms(cls, values: list[str]) -> list[str]:
        cleaned = [str(value or "").strip() for value in values]
        if any(not value for value in cleaned):
            raise ValueError("knowledge package search terms cannot be blank")
        if len(cleaned) != len(set(cleaned)):
            raise ValueError("duplicate knowledge package search terms are not allowed")
        return cleaned

    @field_validator("supported_entrypoints")
    @classmethod
    def reject_duplicate_knowledge_entrypoints(
        cls, values: list[Literal["typed", "voice", "siri_app_shortcut"]]
    ) -> list[Literal["typed", "voice", "siri_app_shortcut"]]:
        if len(values) != len(set(values)):
            raise ValueError("duplicate knowledge package entrypoints are not allowed")
        return values

    @model_validator(mode="after")
    def validate_graph_and_migrations(self) -> "LocationKnowledgePackageV1":
        step_ids = [step.step_id for step in self.steps]
        if len(step_ids) != len(set(step_ids)):
            raise ValueError("Location knowledge step ids must be unique")
        declared_presentation_states = {
            state for step in self.steps for state in step.presentation_states
        }
        required_presentation_states = {"welcome", "features", "place", "ready"}
        if declared_presentation_states != required_presentation_states:
            missing = sorted(required_presentation_states - declared_presentation_states)
            unexpected = sorted(declared_presentation_states - required_presentation_states)
            detail = ", ".join(
                [
                    *(f"missing:{state}" for state in missing),
                    *(f"unexpected:{state}" for state in unexpected),
                ]
            )
            raise ValueError(
                "Location knowledge package must cover every approved visual state: " + detail
            )
        if self.initial_step_id not in set(step_ids):
            raise ValueError("Location initial_step_id must resolve to a declared step")
        declared = set(step_ids)
        for step in self.steps:
            for transition in step.transitions:
                if transition.target.startswith("$"):
                    continue
                if transition.target not in declared:
                    raise ValueError(
                        f"Location step {step.step_id} targets unknown step {transition.target}"
                    )
        versions = [migration.from_workflow_version for migration in self.migrations]
        if len(versions) != len(set(versions)):
            raise ValueError("Location workflow migration versions must be unique")
        expected_versions = set(range(1, self.workflow_version))
        if set(versions) != expected_versions:
            raise ValueError("Location workflow migrations must cover every prior workflow version")
        for migration in self.migrations:
            if migration.from_workflow_version >= self.workflow_version:
                raise ValueError("Location migration must originate before workflow_version")
            unknown_targets = sorted(set(migration.cursor_map.values()) - declared)
            if unknown_targets:
                raise ValueError(
                    "Location migration targets unknown steps: " + ", ".join(unknown_targets)
                )
        return self


class ServiceKnowledgeSemanticProfileV1(StrictManifestModel):
    """English product meaning for a service knowledge package.

    This is deliberately separate from historical action aliases.  It is the
    stable semantic material used to build a model-facing catalog and an
    evaluation corpus; it never grants execution authority.
    """

    language: Literal["en"] = "en"
    purpose: str = Field(min_length=12, max_length=480)
    user_goals: list[str] = Field(min_length=1, max_length=32)
    boundaries: list[str] = Field(min_length=1, max_length=32)

    @field_validator("purpose", "user_goals", "boundaries")
    @classmethod
    def require_english_safe_text(cls, value: str | list[str]) -> str | list[str]:
        values = [value] if isinstance(value, str) else value
        cleaned = [str(item or "").strip() for item in values]
        if any(not item for item in cleaned):
            raise ValueError("semantic profile text cannot be blank")
        # Model-facing product meaning is authored in English for this first
        # package. ASCII is intentionally used as a conservative guard against
        # accidentally retaining legacy multilingual alias corpora here.
        if any(not item.isascii() for item in cleaned):
            raise ValueError("semantic profile must use English-only text")
        return cleaned[0] if isinstance(value, str) else cleaned

    @field_validator("user_goals", "boundaries")
    @classmethod
    def reject_duplicate_semantic_lines(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("semantic profile entries must be unique")
        return values


class ServiceKnowledgeFeatureGroupV1(StrictManifestModel):
    """A stable product-area grouping for complete service catalog coverage."""

    feature_group_id: str = Field(
        min_length=3,
        max_length=64,
        pattern=r"^[a-z][a-z0-9_]*$",
    )
    label: str = Field(min_length=3, max_length=96)
    description: str = Field(min_length=12, max_length=360)

    @field_validator("label", "description")
    @classmethod
    def require_english_feature_text(cls, value: str) -> str:
        clean = str(value or "").strip()
        if not clean.isascii():
            raise ValueError("feature group text must use English-only text")
        return clean


class ServiceKnowledgeCapabilityV1(StrictManifestModel):
    """One catalog item owned by a versioned service package.

    Action meaning remains in the generated action contract.  This declaration
    supplies package ownership and feature grouping, so the compiler can
    require complete coverage without copying action schemas or endpoints.
    """

    capability_id: str = Field(
        min_length=3,
        max_length=160,
        pattern=r"^[a-z][a-z0-9_.:-]*$",
    )
    kind: Literal["action", "native_action", "workflow"]
    feature_group_id: str = Field(
        min_length=3,
        max_length=64,
        pattern=r"^[a-z][a-z0-9_]*$",
    )
    semantic_source: Literal["generated_contract", "package"] = "generated_contract"
    intent: str | None = Field(default=None, min_length=3, max_length=240)
    semantic_boundary: str | None = Field(default=None, min_length=8, max_length=480)

    @model_validator(mode="after")
    def require_package_semantics_when_not_generated(self) -> "ServiceKnowledgeCapabilityV1":
        if self.semantic_source == "package" and (
            not str(self.intent or "").strip() or not str(self.semantic_boundary or "").strip()
        ):
            raise ValueError("package semantic capabilities require intent and semantic_boundary")
        if any(
            value is not None and not str(value).isascii()
            for value in (self.intent, self.semantic_boundary)
        ):
            raise ValueError("package capability semantics must use English-only text")
        return self


class ServiceKnowledgeWorkflowDescriptorV1(StrictManifestModel):
    """The model-facing identity of one detailed workflow in a package."""

    workflow_id: str = Field(
        min_length=3,
        max_length=160,
        pattern=r"^[a-z][a-z0-9_.:-]*$",
    )
    workflow_version: int = Field(ge=1)
    intent: str = Field(min_length=3, max_length=240)
    semantic_boundary: str = Field(min_length=8, max_length=480)

    @field_validator("intent", "semantic_boundary")
    @classmethod
    def require_english_workflow_text(cls, value: str) -> str:
        clean = str(value or "").strip()
        if not clean.isascii():
            raise ValueError("workflow semantics must use English-only text")
        return clean


class ServiceKnowledgeBindingV2(StrictManifestModel):
    """A non-authorizing reference to an audited service implementation."""

    kind: Literal[
        "state_resolver",
        "generated_action",
        "native_semantic_action",
        "native_interaction",
        "approved_interaction",
        "backend_adapter",
    ]
    ref: str = Field(
        min_length=3,
        max_length=160,
        pattern=r"^[a-z][a-z0-9_.:-]*$",
    )


class ServiceKnowledgeTransitionV2(StrictManifestModel):
    """An authored workflow edge resolved only from verified facts."""

    when: str = Field(
        min_length=2,
        max_length=64,
        pattern=r"^[a-z][a-z0-9_]*$",
    )
    target: str = Field(min_length=3, max_length=160)

    @field_validator("target")
    @classmethod
    def require_step_or_terminal_target(cls, value: str) -> str:
        clean = str(value or "").strip()
        if clean in {"$verified_succeeded", "$paused", "$cancelled", "$failed"}:
            return clean
        if not re.fullmatch(r"[a-z][a-z0-9_.:-]{2,159}", clean):
            raise ValueError("transition target must be a service step id or terminal state")
        return clean


class ServiceKnowledgeStepV2(StrictManifestModel):
    """Typed static semantics for a workflow step, without routing aliases."""

    step_id: str = Field(
        min_length=3,
        max_length=160,
        pattern=r"^[a-z][a-z0-9_.:-]*$",
    )
    label: str = Field(min_length=2, max_length=96)
    description: str = Field(min_length=8, max_length=360)
    intent: str = Field(min_length=3, max_length=240)
    semantic_boundary: str = Field(min_length=8, max_length=480)
    outcome: Literal["ASK", "EXECUTE", "NAVIGATE", "RENDER"]
    completion_policy: Literal["required", "informational", "explicit_skip_allowed"]
    presentation_states: list[str] = Field(default_factory=list, max_length=16)
    binding: ServiceKnowledgeBindingV2
    render_surface: str | None = Field(default=None, max_length=128)
    verifier_ref: str = Field(
        min_length=3,
        max_length=160,
        pattern=r"^[a-z][a-z0-9_.:-]*$",
    )
    transitions: list[ServiceKnowledgeTransitionV2] = Field(min_length=1, max_length=24)
    telemetry_event: str = Field(min_length=3, max_length=160)

    @field_validator("label", "description", "intent", "semantic_boundary")
    @classmethod
    def require_english_step_text(cls, value: str) -> str:
        clean = str(value or "").strip()
        if not clean.isascii():
            raise ValueError("step semantics must use English-only text")
        return clean

    @field_validator("presentation_states")
    @classmethod
    def reject_duplicate_presentation_states(cls, values: list[str]) -> list[str]:
        cleaned = [str(value or "").strip() for value in values]
        if any(not value for value in cleaned) or len(cleaned) != len(set(cleaned)):
            raise ValueError("presentation states must be non-empty and unique")
        return cleaned

    @model_validator(mode="after")
    def require_render_surface_for_render_outcome(self) -> "ServiceKnowledgeStepV2":
        if self.outcome in {"ASK", "RENDER"} and not self.render_surface:
            raise ValueError("ASK and RENDER steps require an approved render surface")
        if self.outcome not in {"ASK", "RENDER"} and self.render_surface is not None:
            raise ValueError("only ASK and RENDER steps may declare a render surface")
        transition_conditions = [transition.when for transition in self.transitions]
        if len(transition_conditions) != len(set(transition_conditions)):
            raise ValueError("step transition conditions must be unique")
        return self


class ServiceKnowledgeMigrationV2(StrictManifestModel):
    """Fail-closed cursor mapping from one earlier workflow version."""

    from_workflow_version: int = Field(ge=1)
    policy: Literal["map_known_cursor_fail_closed"] = "map_known_cursor_fail_closed"
    cursor_map: dict[str, str] = Field(min_length=1, max_length=64)

    @field_validator("cursor_map")
    @classmethod
    def require_bounded_cursor_map(cls, value: dict[str, str]) -> dict[str, str]:
        cleaned: dict[str, str] = {}
        for source, target in value.items():
            source_id = str(source or "").strip()
            target_id = str(target or "").strip()
            if not re.fullmatch(r"[a-z][a-z0-9_.:-]{2,159}", source_id):
                raise ValueError("migration source cursor is invalid")
            if not re.fullmatch(r"[a-z][a-z0-9_.:-]{2,159}", target_id):
                raise ValueError("migration target must be a service knowledge step")
            cleaned[source_id] = target_id
        return cleaned


class ServiceKnowledgeContextProjectionV2(StrictManifestModel):
    """Only bounded fact names may enter a model-facing runtime snapshot."""

    schema_version: Literal["one.service_context_projection.v2"] = (
        "one.service_context_projection.v2"
    )
    allowed_fact_keys: list[str] = Field(min_length=1, max_length=16)
    max_retrieved_steps: int = Field(default=3, ge=1, le=10)

    @field_validator("allowed_fact_keys")
    @classmethod
    def require_safe_unique_fact_keys(cls, values: list[str]) -> list[str]:
        cleaned = [str(value or "").strip() for value in values]
        if any(not re.fullmatch(r"[a-z][a-z0-9_]{1,63}", value) for value in cleaned) or len(
            cleaned
        ) != len(set(cleaned)):
            raise ValueError("context projection fact keys must be unique safe identifiers")
        return cleaned


class ServiceKnowledgePackageV2(StrictManifestModel):
    """Generic, build-time service brain compiled into CapabilityGraphV1.

    The package is product knowledge only. It may describe every known feature,
    but execution authority is derived independently from audited bindings,
    authorization, idempotency, and settlement contracts.
    """

    schema_version: Literal["one.service_knowledge_package.v2"] = "one.service_knowledge_package.v2"
    package_id: str = Field(
        min_length=3,
        max_length=128,
        pattern=r"^[a-z][a-z0-9_.-]*$",
    )
    package_version: int = Field(ge=1)
    service_id: str = Field(
        min_length=2,
        max_length=64,
        pattern=r"^[a-z][a-z0-9_]*$",
    )
    label: str = Field(min_length=3, max_length=96)
    description: str = Field(min_length=12, max_length=480)
    semantic_profile: ServiceKnowledgeSemanticProfileV1
    feature_groups: list[ServiceKnowledgeFeatureGroupV1] = Field(min_length=1, max_length=32)
    capabilities: list[ServiceKnowledgeCapabilityV1] = Field(min_length=1, max_length=256)
    endpoint_inventory_policy: Literal["discover_and_block"] = "discover_and_block"
    endpoint_feature_group_id: str = Field(
        min_length=3,
        max_length=64,
        pattern=r"^[a-z][a-z0-9_]*$",
    )
    supported_entrypoints: list[Literal["typed", "voice", "siri_app_shortcut"]] = Field(
        min_length=1,
        max_length=3,
    )
    workflows: list[ServiceKnowledgeWorkflowDescriptorV1] = Field(min_length=1, max_length=16)
    # The first migrated package has one detailed durable workflow. Future
    # packages may declare more catalog workflows while adding their own
    # executor adapters; this field keeps the existing Location runtime stable.
    workflow_id: str = Field(
        min_length=3,
        max_length=160,
        pattern=r"^[a-z][a-z0-9_.:-]*$",
    )
    workflow_version: int = Field(ge=1)
    route_pattern: str = Field(min_length=2, max_length=256)
    screen: str = Field(min_length=2, max_length=128)
    entry_action_id: str = Field(
        min_length=3,
        max_length=160,
        pattern=r"^[a-z][a-z0-9_.:-]*$",
    )
    completion_action_id: str = Field(
        min_length=3,
        max_length=160,
        pattern=r"^[a-z][a-z0-9_.:-]*$",
    )
    initial_step_id: str = Field(
        min_length=3,
        max_length=160,
        pattern=r"^[a-z][a-z0-9_.:-]*$",
    )
    completion_receipt_schema: str = Field(min_length=3, max_length=160)
    required_presentation_states: list[str] = Field(default_factory=list, max_length=16)
    # These are schema-versioned policy mappings rather than Location model
    # types. A future service owns its policy vocabulary, while Location still
    # receives its established v1 validation below during this first build.
    retry_policy: dict[str, Any]
    pause_policy: dict[str, Any]
    expiry_policy: dict[str, Any]
    recovery_policy: dict[str, Any]
    graph_compatibility: dict[str, Any]
    active_run_policy: dict[str, Any]
    telemetry_policy: dict[str, Any]
    context_projection: ServiceKnowledgeContextProjectionV2
    steps: list[ServiceKnowledgeStepV2] = Field(min_length=1, max_length=64)
    # Version-one packages have no predecessor to migrate. Later versions are
    # still required by the validator below to cover every earlier workflow
    # version explicitly.
    migrations: list[ServiceKnowledgeMigrationV2] = Field(default_factory=list, max_length=32)
    evaluation: EvaluationContract

    @field_validator("label", "description")
    @classmethod
    def require_english_package_text(cls, value: str) -> str:
        clean = str(value or "").strip()
        if not clean.isascii():
            raise ValueError("package text must use English-only text")
        return clean

    @field_validator("supported_entrypoints", "required_presentation_states")
    @classmethod
    def reject_duplicate_package_values(cls, values: list[str]) -> list[str]:
        cleaned = [str(value or "").strip() for value in values]
        if any(not value for value in cleaned) or len(cleaned) != len(set(cleaned)):
            raise ValueError("package values must be non-empty and unique")
        return cleaned

    @model_validator(mode="after")
    def validate_catalog_workflow_and_migrations(self) -> "ServiceKnowledgePackageV2":
        feature_group_ids = [group.feature_group_id for group in self.feature_groups]
        if len(feature_group_ids) != len(set(feature_group_ids)):
            raise ValueError("service feature group ids must be unique")
        if self.endpoint_feature_group_id not in set(feature_group_ids):
            raise ValueError("endpoint inventory feature group must be declared")
        capability_ids = [capability.capability_id for capability in self.capabilities]
        if len(capability_ids) != len(set(capability_ids)):
            raise ValueError("service capability ids must be unique")
        if any(
            capability.feature_group_id not in set(feature_group_ids)
            for capability in self.capabilities
        ):
            raise ValueError("every capability must reference a declared feature group")
        workflows = {workflow.workflow_id: workflow for workflow in self.workflows}
        if len(workflows) != len(self.workflows):
            raise ValueError("service workflow ids must be unique")
        primary = workflows.get(self.workflow_id)
        if primary is None or primary.workflow_version != self.workflow_version:
            raise ValueError("primary workflow must be declared with the matching version")
        step_ids = [step.step_id for step in self.steps]
        if len(step_ids) != len(set(step_ids)):
            raise ValueError("service knowledge step ids must be unique")
        declared = set(step_ids)
        if self.initial_step_id not in declared:
            raise ValueError("initial_step_id must resolve to a declared step")
        declared_states = {state for step in self.steps for state in step.presentation_states}
        if set(self.required_presentation_states) != declared_states:
            missing = sorted(set(self.required_presentation_states) - declared_states)
            unexpected = sorted(declared_states - set(self.required_presentation_states))
            detail = ", ".join(
                [
                    *(f"missing:{state}" for state in missing),
                    *(f"unexpected:{state}" for state in unexpected),
                ]
            )
            raise ValueError("service knowledge package presentation states diverge: " + detail)
        for step in self.steps:
            for transition in step.transitions:
                if not transition.target.startswith("$") and transition.target not in declared:
                    raise ValueError(
                        f"service step {step.step_id} targets unknown step {transition.target}"
                    )
        versions = [migration.from_workflow_version for migration in self.migrations]
        if len(versions) != len(set(versions)):
            raise ValueError("service workflow migration versions must be unique")
        expected_versions = set(range(1, self.workflow_version))
        if set(versions) != expected_versions:
            raise ValueError("service workflow migrations must cover every prior workflow version")
        for migration in self.migrations:
            if migration.from_workflow_version >= self.workflow_version:
                raise ValueError("service migration must originate before workflow_version")
            unknown_targets = sorted(set(migration.cursor_map.values()) - declared)
            if unknown_targets:
                raise ValueError(
                    "service migration targets unknown steps: " + ", ".join(unknown_targets)
                )
        policy_fields = (
            "retry_policy",
            "pause_policy",
            "expiry_policy",
            "recovery_policy",
            "graph_compatibility",
            "active_run_policy",
            "telemetry_policy",
        )
        for field_name in policy_fields:
            raw_policy = getattr(self, field_name)
            policy = (
                raw_policy.model_dump(mode="json")
                if isinstance(raw_policy, BaseModel)
                else raw_policy
            )
            schema_version = str(policy.get("schema_version") or "").strip()
            if not policy or not re.fullmatch(
                r"one\.[a-z][a-z0-9_.-]{2,159}\.v[1-9][0-9]*", schema_version
            ):
                raise ValueError(f"{field_name} requires a versioned service policy schema")
        if self.service_id == "location":
            # Preserve Location's exact tested safety contract while allowing
            # the package engine itself to remain reusable for later services.
            LocationKnowledgeRetryPolicyV1.model_validate(self.retry_policy)
            LocationKnowledgePausePolicyV1.model_validate(self.pause_policy)
            LocationKnowledgeExpiryPolicyV1.model_validate(self.expiry_policy)
            LocationKnowledgeRecoveryPolicyV1.model_validate(self.recovery_policy)
            LocationKnowledgeGraphCompatibilityV1.model_validate(self.graph_compatibility)
            LocationKnowledgeActiveRunPolicyV1.model_validate(self.active_run_policy)
            LocationKnowledgeTelemetryPolicyV1.model_validate(self.telemetry_policy)
        return self


class AgentSubagentConfig(StrictManifestModel):
    """Manifest-owned internal ADK specialist.

    A child is a bounded implementation detail of its parent, not another
    top-level routing authority. Keeping its instruction and I/O contract in
    the parent manifest makes the generated registry auditable and prevents a
    parallel Python prompt from drifting away from the authored contract.
    """

    id: str
    name: str
    description: str
    model: AgentModelConfig = Field(default_factory=AgentModelConfig)
    runtime: RuntimeContract = Field(default_factory=RuntimeContract)
    system_instruction: str
    inputs: list[AgentInputConfig] = Field(default_factory=list)
    outputs: list[AgentOutputConfig] = Field(default_factory=list)
    privacy: PrivacyContract = Field(default_factory=PrivacyContract)
    telemetry_namespace: str
    performance: PerformanceContract = Field(default_factory=PerformanceContract)
    rollout: RolloutContract
    availability: EnvironmentAvailabilityContract = Field(
        default_factory=EnvironmentAvailabilityContract
    )


class AgentManifestV2(StrictManifestModel):
    manifest_version: Literal[2] = 2
    id: str
    legacy_ids: list[str] = Field(default_factory=list)
    name: str
    version: str = "1.0.0"
    status: Literal["experimental", "active", "deprecated"] = "experimental"
    owner: str = "backend"
    parent: str | None = "agent_one"
    description: str
    model: str | AgentModelConfig = GEMINI_MODEL
    credential_policy: CredentialPolicy = Field(default_factory=CredentialPolicy)
    system_instruction: str
    prompt_reference: str | None = None
    runtime: RuntimeContract = Field(default_factory=RuntimeContract)
    authorities: AuthorityContract = Field(default_factory=AuthorityContract)
    required_scopes: list[str] = Field(default_factory=list)
    optional_scopes: list[str] = Field(default_factory=list)
    tools: list[AgentToolConfig] = Field(default_factory=list)
    inputs: list[AgentInputConfig] = Field(default_factory=list)
    outputs: list[AgentOutputConfig] = Field(default_factory=list)
    failure_states: list[str] = Field(default_factory=list)
    side_effects: list[SideEffectContract] = Field(default_factory=list)
    pkm: PkmContract = Field(default_factory=PkmContract)
    surfaces: SurfaceContract = Field(default_factory=SurfaceContract)
    action_ids: list[str] = Field(default_factory=list)
    native_requirements: list[str] = Field(default_factory=list)
    privacy: PrivacyContract = Field(default_factory=PrivacyContract)
    telemetry_namespace: str = "agent.unclassified"
    evaluations: list[EvaluationContract] = Field(default_factory=list)
    performance: PerformanceContract = Field(default_factory=PerformanceContract)
    rollout: RolloutContract = Field(
        default_factory=lambda: RolloutContract(
            rollback="Disable the agent and restore the prior manifest.",
        )
    )
    availability: EnvironmentAvailabilityContract = Field(
        default_factory=EnvironmentAvailabilityContract
    )
    one_exposure: OneExposureContract | None = None
    subagents: list[AgentSubagentConfig] = Field(default_factory=list)
    capabilities: dict[str, Any] = Field(default_factory=dict)
    ui_type: str | None = "chat"
    icon: str | None = None

    @field_validator("legacy_ids", "required_scopes", "optional_scopes", "failure_states")
    @classmethod
    def reject_duplicates(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("duplicate values are not allowed")
        return values

    @field_validator("subagents")
    @classmethod
    def reject_duplicate_subagent_ids(
        cls, values: list[AgentSubagentConfig]
    ) -> list[AgentSubagentConfig]:
        identifiers = [value.id for value in values]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("duplicate subagent ids are not allowed")
        return values

    def tool_py_funcs(self) -> list[str]:
        return [tool.py_func for tool in self.tools]

    def required_scope_strings(self) -> list[str]:
        return list(
            dict.fromkeys([*self.required_scopes, *(tool.required_scope for tool in self.tools)])
        )

    def model_config_for_runtime(self) -> AgentModelConfig:
        if isinstance(self.model, AgentModelConfig):
            name = str(self.model.name or "").strip()
            if not name or name in {
                "default",
                "gemini-default",
                "active",
                "gemini-active",
                "gemini_default",
            }:
                name = GEMINI_MODEL
            return AgentModelConfig(
                provider=self.model.provider,
                name=name,
                mode=self.model.mode,
                credential_ref=self.model.credential_ref,
            )
        name = str(self.model or "").strip()
        if not name or name in {
            "default",
            "gemini-default",
            "active",
            "gemini-active",
            "gemini_default",
        }:
            name = GEMINI_MODEL
        return AgentModelConfig(name=name)


# Compatibility import name while callers migrate to the explicit V2 name.
AgentManifest = AgentManifestV2


class ManifestLoader:
    @staticmethod
    def load(path: str) -> AgentManifestV2:
        if not os.path.exists(path):
            raise FileNotFoundError(f"Manifest not found at {path}")
        try:
            with open(path, encoding="utf-8") as manifest_file:
                data = yaml.safe_load(manifest_file)
        except yaml.YAMLError as exc:
            raise ValueError(f"Malformed YAML in manifest '{path}': {exc}") from exc
        if not isinstance(data, dict):
            raise ValueError(
                f"Manifest '{path}' must be a YAML mapping at the top level, got {type(data).__name__}"
            )
        return ManifestLoader.load_from_dict(data, source=path)

    @staticmethod
    def load_from_dict(data: dict[str, Any], *, source: str = "<dict>") -> AgentManifestV2:
        try:
            return AgentManifestV2.model_validate(data)
        except (ValidationError, TypeError) as exc:
            raise ValueError(f"Invalid manifest data from '{source}': {exc}") from exc

    @staticmethod
    def load_location_knowledge_package(path: str) -> LocationKnowledgePackageV1:
        if not os.path.exists(path):
            raise FileNotFoundError(f"Location knowledge package not found at {path}")
        try:
            with open(path, encoding="utf-8") as package_file:
                data = yaml.safe_load(package_file)
        except yaml.YAMLError as exc:
            raise ValueError(
                f"Malformed YAML in Location knowledge package '{path}': {exc}"
            ) from exc
        if not isinstance(data, dict):
            raise ValueError(
                "Location knowledge package "
                f"'{path}' must be a YAML mapping, got {type(data).__name__}"
            )
        try:
            return LocationKnowledgePackageV1.model_validate(data)
        except (ValidationError, TypeError) as exc:
            raise ValueError(f"Invalid Location knowledge package from '{path}': {exc}") from exc

    @staticmethod
    def load_service_knowledge_package(path: str) -> ServiceKnowledgePackageV2:
        """Load one generic, manifest-owned service knowledge package.

        The generic loader deliberately does not infer a service from its path.
        The capability compiler cross-checks this typed payload against the
        owning ``AgentManifestV2.one_exposure`` declaration before it can enter
        a generated artifact.
        """

        if not os.path.exists(path):
            raise FileNotFoundError(f"Service knowledge package not found at {path}")
        try:
            with open(path, encoding="utf-8") as package_file:
                data = yaml.safe_load(package_file)
        except yaml.YAMLError as exc:
            raise ValueError(
                f"Malformed YAML in service knowledge package '{path}': {exc}"
            ) from exc
        if not isinstance(data, dict):
            raise ValueError(
                "Service knowledge package "
                f"'{path}' must be a YAML mapping, got {type(data).__name__}"
            )
        try:
            return ServiceKnowledgePackageV2.model_validate(data)
        except (ValidationError, TypeError) as exc:
            raise ValueError(f"Invalid service knowledge package from '{path}': {exc}") from exc

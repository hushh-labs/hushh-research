"""Strict PKM v5 scope descriptors and user-confirmed mutation plans."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from hushh_mcp.services.domain_contracts import (
    CURRENT_PKM_CONTRACT_VERSION,
    validate_dynamic_top_level_domain,
)

PKM_MUTATION_PLAN_VERSION = 2

_HANDLE_PATTERN = r"^(?:s|scope|pending)_[A-Za-z0-9_-]{6,128}$"
_OPAQUE_ID_PATTERN = r"^pkm_[A-Za-z0-9_-]{12,128}$"
_MACHINE_SCOPE_PATTERN = r"^attr\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*\.\*$"


class PkmConfirmationReceiptV2(BaseModel):
    """Client receipt proving that the authenticated owner saw and confirmed a plan."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    version: Literal[2] = 2
    receipt_id: str = Field(..., pattern=_OPAQUE_ID_PATTERN)
    plan_id: str = Field(..., pattern=_OPAQUE_ID_PATTERN)
    confirmed_by_user_id: str = Field(..., min_length=1, max_length=256)
    confirmed_at: datetime
    surface: Literal["chat", "voice", "web", "ios", "android", "import", "system_upgrade"]
    displayed_domain: str = Field(..., min_length=1, max_length=64)
    displayed_scope: str = Field(..., min_length=1, max_length=128)
    sharing_impact_acknowledged: bool = False

    @model_validator(mode="after")
    def validate_timestamp(self) -> PkmConfirmationReceiptV2:
        confirmed_at = self.confirmed_at
        if confirmed_at.tzinfo is None:
            raise ValueError("confirmation_timestamp_requires_timezone")
        now = datetime.now(UTC)
        normalized = confirmed_at.astimezone(UTC)
        if normalized > now + timedelta(minutes=5):
            raise ValueError("confirmation_timestamp_in_future")
        if normalized < now - timedelta(days=7):
            raise ValueError("confirmation_receipt_expired")
        return self


class SharingImpactV2(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    active_recipient_count: int = Field(default=0, ge=0, le=10_000)
    recipient_labels: list[str] = Field(default_factory=list, max_length=100)
    enters_next_export_revision: bool = False
    summary: str = Field(default="No active recipients are affected.", min_length=1, max_length=512)


class ScopeDescriptorV2(BaseModel):
    """Redacted, stable scope metadata safe for semantic target resolution."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    scope_handle: str = Field(..., pattern=_HANDLE_PATTERN)
    machine_scope: str = Field(..., pattern=_MACHINE_SCOPE_PATTERN)
    domain_slug: str = Field(..., min_length=1, max_length=64)
    scope_slug: str = Field(..., min_length=1, max_length=128)
    friendly_domain_name: str = Field(..., min_length=1, max_length=128)
    friendly_scope_name: str = Field(..., min_length=1, max_length=128)
    summary: str = Field(..., min_length=1, max_length=512)
    sensitivity: Literal["public", "internal", "confidential", "restricted"] = "confidential"
    sharing_posture: Literal["private", "consent_required"] = "consent_required"
    active_recipient_count: int = Field(default=0, ge=0, le=10_000)
    semantic_contract_version: str = CURRENT_PKM_CONTRACT_VERSION
    current_source_revision: int = Field(default=0, ge=0, le=10_000_000)

    @model_validator(mode="after")
    def validate_scope_identity(self) -> ScopeDescriptorV2:
        domain = validate_dynamic_top_level_domain(self.domain_slug)
        if domain != self.domain_slug:
            raise ValueError("domain_slug_must_be_normalized")
        if not self.machine_scope.startswith(f"attr.{domain}."):
            raise ValueError("machine_scope_domain_mismatch")
        return self


class PkmMutationPlanV2(BaseModel):
    """One reviewable contract for every semantic PKM CRUD operation."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    version: Literal[2] = 2
    plan_id: str = Field(..., pattern=_OPAQUE_ID_PATTERN)
    operation: Literal["create", "update", "move", "merge", "delete"]
    source_scope_handle: str | None = Field(default=None, pattern=_HANDLE_PATTERN)
    target_scope_handle: str | None = Field(default=None, pattern=_HANDLE_PATTERN)
    proposed_domain: str = Field(..., min_length=1, max_length=64)
    proposed_scope: str = Field(..., min_length=1, max_length=128)
    friendly_domain_name: str = Field(..., min_length=1, max_length=128)
    friendly_scope_name: str = Field(..., min_length=1, max_length=128)
    confidence: float = Field(..., ge=0.0, le=1.0)
    explanation: str = Field(..., min_length=1, max_length=1_000)
    affected_grant_ids: list[str] = Field(default_factory=list, max_length=1_000)
    affected_export_ids: list[str] = Field(default_factory=list, max_length=1_000)
    sharing_impact: SharingImpactV2 = Field(default_factory=SharingImpactV2)
    semantic_contract_version: str = CURRENT_PKM_CONTRACT_VERSION
    source_revision: int = Field(default=0, ge=0, le=10_000_000)
    confirmation_receipt: PkmConfirmationReceiptV2

    @model_validator(mode="after")
    def validate_plan(self) -> PkmMutationPlanV2:
        domain = validate_dynamic_top_level_domain(self.proposed_domain, allow_internal=True)
        if domain != self.proposed_domain:
            raise ValueError("proposed_domain_must_be_normalized")
        if self.confirmation_receipt.plan_id != self.plan_id:
            raise ValueError("confirmation_plan_mismatch")
        if self.confirmation_receipt.displayed_domain != domain:
            raise ValueError("confirmation_domain_mismatch")
        if self.confirmation_receipt.displayed_scope != self.proposed_scope:
            raise ValueError("confirmation_scope_mismatch")
        if self.operation == "create" and not self.target_scope_handle:
            raise ValueError("create_requires_target_scope_handle")
        if self.operation in {"update", "delete", "move", "merge"} and not self.source_scope_handle:
            raise ValueError(f"{self.operation}_requires_source_scope_handle")
        if self.operation in {"update", "move", "merge"} and not self.target_scope_handle:
            raise ValueError(f"{self.operation}_requires_target_scope_handle")
        if (
            self.sharing_impact.active_recipient_count > 0
            and not self.confirmation_receipt.sharing_impact_acknowledged
        ):
            raise ValueError("sharing_impact_acknowledgement_required")
        return self


def validate_mutation_plan_for_write(
    *,
    plan: PkmMutationPlanV2,
    authenticated_user_id: str,
    domain: str,
) -> None:
    """Bind a validated plan to the authenticated owner and write target."""

    canonical_domain = validate_dynamic_top_level_domain(domain, allow_internal=True)
    if plan.confirmation_receipt.confirmed_by_user_id != authenticated_user_id:
        raise ValueError("confirmation_subject_mismatch")
    if plan.proposed_domain != canonical_domain:
        raise ValueError("mutation_plan_domain_mismatch")

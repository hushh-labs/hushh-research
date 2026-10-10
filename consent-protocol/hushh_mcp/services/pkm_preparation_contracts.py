"""Import-safe request and response contracts for owner-reviewed Memory preparation."""

from typing import Literal

from pydantic import BaseModel, Field


class PKMAgentLabStructureRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=128)
    # Imported personal profiles routinely exceed a short chat-message limit.
    # Keep a hard bound for abuse protection while accepting a complete export.
    message: str = Field(min_length=1, max_length=50000)
    current_domains: list[str] = Field(default_factory=list, max_length=256)
    current_manifests: list[dict] = Field(default_factory=list, max_length=256)
    simulated_state: dict | None = None
    memory_profile: Literal["general", "kyc_identity_v1"] = "general"


class PKMAgentLabStructureResponse(BaseModel):
    agent_id: str
    agent_name: str
    model: str
    used_fallback: bool
    intent_used_fallback: bool = False
    structure_used_fallback: bool = False
    error: str | None = None
    intent_frame: dict = Field(default_factory=dict)
    merge_decision: dict = Field(default_factory=dict)
    candidate_payload: dict
    structure_decision: dict
    write_mode: str = "confirm_first"
    primary_json_path: str | None = None
    target_entity_scope: str | None = None
    validation_hints: list[str] = Field(default_factory=list)
    manifest_draft: dict | None = None
    preview_cards: list[dict] = Field(default_factory=list)
    preview_summary: dict = Field(default_factory=dict)
    performance: dict = Field(default_factory=dict)
    context_plan: dict = Field(default_factory=dict)

"""Strict authored contract for Hussh product agents."""

from __future__ import annotations

import os
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

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
    name: str = GEMINI_MODEL
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
    kill_switch: str
    strategy: Literal["off", "internal", "canary", "general"] = "off"
    rollback: str


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
            kill_switch="HUSHH_AGENT_DISABLED",
            rollback="Disable the agent and restore the prior manifest.",
        )
    )
    capabilities: dict[str, Any] = Field(default_factory=dict)
    ui_type: str | None = "chat"
    icon: str | None = None

    @field_validator("legacy_ids", "required_scopes", "optional_scopes", "failure_states")
    @classmethod
    def reject_duplicates(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("duplicate values are not allowed")
        return values

    def tool_py_funcs(self) -> list[str]:
        return [tool.py_func for tool in self.tools]

    def required_scope_strings(self) -> list[str]:
        return list(
            dict.fromkeys([*self.required_scopes, *(tool.required_scope for tool in self.tools)])
        )

    def model_config_for_runtime(self) -> AgentModelConfig:
        if isinstance(self.model, AgentModelConfig):
            return self.model
        return AgentModelConfig(name=self.model)


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

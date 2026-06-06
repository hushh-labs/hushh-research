from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

RuntimeKind = Literal[
    "mock",
    "local_platform",
    "google_adk",
    "mlx_local",
    "cloud_model",
    "byoc_http",
]

ModelMode = Literal["byok", "runtime_managed", "none"]


@dataclass(frozen=True)
class ModelConfig:
    provider: str = "gemini"
    model: str = "gemini-3.5-flash"
    mode: ModelMode = "byok"
    credential_ref: str | None = "user_secret:gemini_api_key"

    def describe(self) -> dict:
        return {
            "provider": self.provider,
            "model": self.model,
            "mode": self.mode,
            "credential_ref": self.credential_ref,
        }


@dataclass(frozen=True)
class RuntimeConfig:
    kind: RuntimeKind = "local_platform"
    framework: str = "hussh_sdk"
    deployment_target: str = "personal_sandbox"
    model: ModelConfig = field(default_factory=ModelConfig)

    def describe(self) -> dict:
        return {
            "kind": self.kind,
            "framework": self.framework,
            "deployment_target": self.deployment_target,
            "model": self.model.describe(),
        }


def runtime_config(
    runtime: RuntimeKind | RuntimeConfig = "local_platform",
    *,
    model: str | ModelConfig | None = None,
    provider: str | None = None,
    mode: ModelMode | None = None,
    credential_ref: str | None = None,
    framework: str | None = None,
    deployment_target: str | None = None,
) -> RuntimeConfig:
    if isinstance(runtime, RuntimeConfig):
        return runtime

    if isinstance(model, ModelConfig):
        model_config = model
    else:
        model_config = ModelConfig(
            provider=provider or _default_provider(runtime),
            model=model or _default_model(runtime),
            mode=mode or _default_model_mode(runtime),
            credential_ref=credential_ref
            if credential_ref is not None
            else _default_credential_ref(runtime),
        )

    return RuntimeConfig(
        kind=runtime,
        framework=framework or _default_framework(runtime),
        deployment_target=deployment_target or _default_deployment_target(runtime),
        model=model_config,
    )


def _default_provider(runtime: RuntimeKind) -> str:
    if runtime == "mlx_local":
        return "local"
    if runtime == "cloud_model":
        return "openai"
    if runtime == "mock":
        return "mock"
    return "gemini"


def _default_model(runtime: RuntimeKind) -> str:
    if runtime == "mlx_local":
        return "mlx-community/Qwen2.5-7B-Instruct-4bit"
    if runtime == "cloud_model":
        return "gpt-4.1-mini"
    if runtime == "mock":
        return "mock-model"
    return "gemini-3.5-flash"


def _default_model_mode(runtime: RuntimeKind) -> ModelMode:
    if runtime in {"mlx_local", "mock"}:
        return "none"
    return "byok"


def _default_credential_ref(runtime: RuntimeKind) -> str | None:
    if runtime in {"mlx_local", "mock"}:
        return None
    return f"user_secret:{_default_provider(runtime)}_api_key"


def _default_framework(runtime: RuntimeKind) -> str:
    return {
        "google_adk": "google_adk",
        "mlx_local": "mlx_local",
        "cloud_model": "cloud_model",
        "byoc_http": "http_service",
        "mock": "hussh_mock",
        "local_platform": "hussh_sdk",
    }[runtime]


def _default_deployment_target(runtime: RuntimeKind) -> str:
    return {
        "google_adk": "personal_sandbox",
        "mlx_local": "apple_local",
        "cloud_model": "platform_sandbox",
        "byoc_http": "developer_byoc",
        "mock": "local_mock",
        "local_platform": "personal_sandbox",
    }[runtime]

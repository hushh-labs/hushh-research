from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from hussh_sdk.models import RuntimeConfig


@dataclass(frozen=True)
class RuntimeRequest:
    prompt: str
    context: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class RuntimeResult:
    output: Any
    metadata: dict[str, Any] = field(default_factory=dict)


class RuntimeAdapter(Protocol):
    config: RuntimeConfig

    async def run(self, request: RuntimeRequest) -> RuntimeResult:
        """Execute using approved context only."""

    def describe(self) -> dict[str, Any]:
        """Return runtime metadata suitable for evidence."""


class BaseRuntimeAdapter:
    def __init__(self, config: RuntimeConfig):
        self.config = config

    def describe(self) -> dict[str, Any]:
        return self.config.describe()


class MockRuntimeAdapter(BaseRuntimeAdapter):
    async def run(self, request: RuntimeRequest) -> RuntimeResult:
        context_keys = sorted(request.context.keys())
        output = {
            "status": "succeeded",
            "runtime": "mock",
            "prompt": request.prompt,
            "context_keys": context_keys,
        }
        return RuntimeResult(output=output, metadata={"runtime": self.describe()})


class LocalPlatformRuntimeAdapter(BaseRuntimeAdapter):
    async def run(self, request: RuntimeRequest) -> RuntimeResult:
        return RuntimeResult(
            output={
                "status": "runtime_not_configured",
                "message": "Consent succeeded, but no live specialist runtime produced output.",
                "prompt": request.prompt,
            },
            metadata={"runtime": self.describe()},
        )


def runtime_adapter_for(config: RuntimeConfig) -> RuntimeAdapter:
    if config.kind == "mock":
        return MockRuntimeAdapter(config)
    return LocalPlatformRuntimeAdapter(config)

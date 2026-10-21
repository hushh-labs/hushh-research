"""Keyless Azure capability ports for the administrator-selected UAT runtime.

Processor selection grants no owner, tool or persistence authority. Callers keep
their existing admission checks and deadlines; no operation retries or falls
back after producing output. Credentials and request bodies are never logged.
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

from hushh_mcp.managed_ai_config import load_managed_runtime_policy, load_pwm_policy

# The dated Audio API serves the deployed transcription version. Azure's v1
# Responses endpoint does not expose this deployment's transcription operation.
TRANSCRIPTION_API_VERSION = "2025-04-01-preview"


@lru_cache(maxsize=8)
def _credential_supplier(tenant_id: str, client_id: str):
    from hushh_mcp.one_adk.azure_workload_identity import azure_openai_token_provider

    return azure_openai_token_provider(tenant_id=tenant_id, client_id=client_id)


@dataclass(frozen=True)
class ManagedAzureBinding:
    """Public configuration only; the credential supplier stays outside its repr."""

    endpoint: str
    tenant_id: str
    client_id: str
    policy_fingerprint: str
    generation: str
    capabilities: dict[str, Any]
    token_supplier: Callable[[], str] = field(repr=False, compare=False)

    @classmethod
    def from_environment(cls) -> ManagedAzureBinding | None:
        policy = load_managed_runtime_policy()
        if policy is None or policy["provider"] != "azure_openai":
            return None
        config = load_pwm_policy(environment="uat", provider="azure_openai")["azure"]
        return cls(
            endpoint=config["primary_endpoint"],
            tenant_id=config["tenant_id"],
            client_id=config["client_id"],
            policy_fingerprint=policy["config_fingerprint"],
            generation=policy["generation"],
            capabilities=policy["azure"],
            token_supplier=_credential_supplier(config["tenant_id"], config["client_id"]),
        )

    def require_current(self) -> None:
        policy = load_managed_runtime_policy()
        if (
            policy is None
            or policy["provider"] != "azure_openai"
            or policy["config_fingerprint"] != self.policy_fingerprint
            or policy["generation"] != self.generation
        ):
            raise RuntimeError("Managed Azure processor selection changed")

    def deployment(self, capability: str) -> str:
        if capability not in {"realtime", "transcription", "speech", "embedding"}:
            raise ValueError("Unknown managed Azure capability")
        return str(self.capabilities[capability]["deployment"])

    @asynccontextmanager
    async def client(self, *, timeout: float, transcription: bool = False, factory=None):
        self.require_current()
        async with asyncio.timeout(5):
            token = await asyncio.to_thread(self.token_supplier)
        if not isinstance(token, str) or not token:
            raise RuntimeError("Managed Azure credential is unavailable")
        # A policy change during workload-token acquisition must stop dispatch.
        self.require_current()
        if transcription:
            from openai import AsyncAzureOpenAI

            make: Callable[..., Any] = factory or AsyncAzureOpenAI
            kwargs: dict[str, Any] = {
                "azure_endpoint": self.endpoint.split("/openai/", 1)[0],
                "api_version": TRANSCRIPTION_API_VERSION,
                "azure_ad_token": token,
            }
        else:
            from openai import AsyncOpenAI

            make = factory or AsyncOpenAI
            kwargs = {"base_url": self.endpoint, "api_key": token}
        async with make(**kwargs, timeout=timeout, max_retries=0) as client:
            yield client


async def transcribe_wav(
    binding: ManagedAzureBinding,
    audio: bytes,
    *,
    instruction: str,
    timeout: float = 30,
    client_factory=None,
) -> str:
    """Only transcribe caller-admitted WAV bytes; do not interpret a command."""
    if not audio or len(audio) > 1_930_000 or not audio.startswith(b"RIFF"):
        raise ValueError("Managed transcription requires a bounded WAV recording")
    async with asyncio.timeout(timeout):
        async with binding.client(
            timeout=timeout, transcription=True, factory=client_factory
        ) as client:
            response = await client.audio.transcriptions.create(
                model=binding.deployment("transcription"),
                file=("recording.wav", audio, "audio/wav"),
                prompt=instruction,
            )
            binding.require_current()
    text = response.text
    if not isinstance(text, str) or len(text) > 4096:
        raise ValueError("Managed transcription returned an invalid transcript")
    return text.strip()


async def speech_pcm(
    binding: ManagedAzureBinding,
    text: str,
    *,
    timeout: float = 30,
    client_factory=None,
) -> AsyncIterator[bytes]:
    """Stream a short isolated digest as mono PCM16 at 24 kHz."""
    if not text or len(text) > 700:
        raise ValueError("Managed speech requires a short digest")
    emitted = 0
    pending = b""
    async with asyncio.timeout(timeout):
        async with binding.client(timeout=timeout, factory=client_factory) as client:
            async with client.audio.speech.with_streaming_response.create(
                model=binding.deployment("speech"),
                voice=binding.capabilities["voice"],
                input=text,
                response_format="pcm",
            ) as response:
                async for raw in response.iter_bytes(chunk_size=8192):
                    binding.require_current()
                    emitted += len(raw)
                    if emitted > 1_500_000:
                        raise ValueError("Managed speech exceeded its audio bound")
                    pending += raw
                    complete = len(pending) - len(pending) % 2
                    if complete:
                        yield pending[:complete]
                        pending = pending[complete:]
    binding.require_current()
    if not emitted or pending:
        raise ValueError("Managed speech returned incomplete PCM16")


async def embed_texts(
    binding: ManagedAzureBinding,
    texts: list[str],
    *,
    timeout: float,
    client_factory=None,
) -> list[list[float]]:
    """Return validated vectors; the owning index controls normalization/cache."""
    if not texts or len(texts) > 2048 or any(not isinstance(t, str) or not t for t in texts):
        raise ValueError("Managed embeddings require bounded nonempty text inputs")
    dimensions = binding.capabilities["embedding_dimensions"]
    async with asyncio.timeout(timeout):
        async with binding.client(timeout=timeout, factory=client_factory) as client:
            response = await client.embeddings.create(
                model=binding.deployment("embedding"), input=texts, dimensions=dimensions
            )
            binding.require_current()
    if len(response.data) != len(texts):
        raise ValueError("Managed embedding count mismatch")
    vectors: dict[int, list[float]] = {}
    for item in response.data:
        if type(item.index) is not int or not 0 <= item.index < len(texts) or item.index in vectors:
            raise ValueError("Managed embedding index mismatch")
        values = item.embedding
        if (
            len(values) != dimensions
            or any(type(v) not in {int, float} or not math.isfinite(v) for v in values)
            or not any(values)
        ):
            raise ValueError("Managed embedding vector is invalid")
        vectors[item.index] = [float(v) for v in values]
    return [vectors[i] for i in range(len(texts))]

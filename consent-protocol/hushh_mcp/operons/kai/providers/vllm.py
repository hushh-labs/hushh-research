# hushh_mcp/operons/kai/providers/vllm.py
"""
vLLM provider for self-hosted Kai inference.

vLLM exposes an OpenAI-compatible API at /v1/chat/completions, so this
provider reuses the OpenAI SDK pattern but points at a configurable
base URL. The same approach works for any OpenAI-compatible self-hosted
endpoint: Ollama, TGI (with `--openai-api`), LocalAI, llama.cpp's
`server` binary in OAI mode.

This is the primary mechanism for the "private-only" deployment story:
a token issued with `agent.kai.inference.private.self_hosted` can call
this provider but cannot reach Gemini/OpenAI/Anthropic.
"""

from __future__ import annotations

import asyncio
import os
from typing import AsyncIterator, Optional

from .base import CompletionRequest, CompletionResponse, LLMProvider, Role, StreamEvent
from .errors import ProviderError, ProviderResponseInvalid, ProviderTimeout, ProviderUnavailable

try:
    from openai import AsyncOpenAI  # type: ignore
    from openai import APIError, APITimeoutError  # type: ignore

    _OPENAI_AVAILABLE = True
except ImportError:  # pragma: no cover
    _OPENAI_AVAILABLE = False
    AsyncOpenAI = None  # type: ignore
    APIError = Exception  # type: ignore
    APITimeoutError = TimeoutError  # type: ignore


class VLLMProvider(LLMProvider):
    """OpenAI-compatible client pointed at a self-hosted endpoint."""

    name = "vllm"
    kind = "private"

    def __init__(
        self,
        model: str = "meta-llama/Llama-3.1-8B-Instruct",
        model_env: Optional[str] = None,
        base_url_env: str = "KAI_VLLM_BASE_URL",
        base_url_default: str = "http://localhost:8000/v1",
        api_key_env: str = "KAI_VLLM_API_KEY",
        api_key_default: str = "EMPTY",
    ) -> None:
        # Allow ops to override the served model via env var without
        # editing the YAML config -- useful when the same registry
        # config is deployed to multiple GPU tiers.
        self.default_model = (
            os.environ[model_env]
            if model_env and os.environ.get(model_env)
            else model
        )
        self._base_url_env = base_url_env
        self._base_url_default = base_url_default
        self._api_key_env = api_key_env
        self._api_key_default = api_key_default
        self._client: Optional[AsyncOpenAI] = None  # type: ignore[assignment]

    def is_ready(self) -> tuple[bool, Optional[str]]:
        if not _OPENAI_AVAILABLE:
            return False, "openai SDK not installed (used as transport for vLLM)"
        # vLLM does NOT require a real API key; "EMPTY" is the documented
        # default. Readiness here just confirms the base URL is set.
        if not (os.getenv(self._base_url_env) or self._base_url_default):
            return False, f"missing env var {self._base_url_env} and no default"
        return True, None

    def _get_client(self) -> "AsyncOpenAI":
        if self._client is None:
            self._client = AsyncOpenAI(  # type: ignore[call-arg]
                api_key=os.getenv(self._api_key_env) or self._api_key_default,
                base_url=os.getenv(self._base_url_env) or self._base_url_default,
            )
        return self._client

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        ready, why = self.is_ready()
        if not ready:
            raise ProviderUnavailable(why or "vLLM not ready", provider=self.name)

        messages = [
            {"role": _role_str(m.role), "content": m.content}
            for m in request.synthesized_messages()
        ]
        kwargs: dict = {
            "model": self.default_model,
            "messages": messages,
            "temperature": request.temperature,
            "max_tokens": request.max_output_tokens,
        }
        # vLLM supports response_format on recent versions.
        if request.response_mime_type == "application/json":
            kwargs["response_format"] = {"type": "json_object"}

        client = self._get_client()
        try:
            resp = await asyncio.wait_for(
                client.chat.completions.create(**kwargs),
                timeout=request.timeout_seconds,
            )
        except APITimeoutError as exc:  # type: ignore[misc]
            raise ProviderTimeout(str(exc), provider=self.name) from exc
        except asyncio.TimeoutError as exc:
            raise ProviderTimeout(
                f"vLLM call exceeded {request.timeout_seconds}s", provider=self.name
            ) from exc
        except APIError as exc:  # type: ignore[misc]
            raise ProviderError(f"vLLM API error: {exc}", provider=self.name) from exc
        except Exception as exc:  # noqa: BLE001
            raise ProviderError(
                f"vLLM call failed: {exc.__class__.__name__}: {exc}",
                provider=self.name,
            ) from exc

        if not resp.choices:
            raise ProviderResponseInvalid("vLLM returned empty choices", provider=self.name)
        choice = resp.choices[0]
        text = (choice.message.content or "").strip()
        usage_obj = getattr(resp, "usage", None)
        usage: dict[str, int] = {}
        if usage_obj is not None:
            for field in ("prompt_tokens", "completion_tokens", "total_tokens"):
                val = getattr(usage_obj, field, None)
                if isinstance(val, int):
                    usage[field] = val

        return CompletionResponse(
            text=text,
            provider=self.name,
            model=self.default_model,
            finish_reason=getattr(choice, "finish_reason", None),
            usage=usage,
        )

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        ready, why = self.is_ready()
        if not ready:
            yield StreamEvent(type="error", text=why or "vLLM not ready")
            return

        messages = [
            {"role": _role_str(m.role), "content": m.content}
            for m in request.synthesized_messages()
        ]
        client = self._get_client()
        full: list[str] = []
        try:
            stream = await client.chat.completions.create(
                model=self.default_model,
                messages=messages,
                temperature=request.temperature,
                max_tokens=request.max_output_tokens,
                stream=True,
            )
            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content or ""
                if delta:
                    full.append(delta)
                    yield StreamEvent(type="token", text=delta)
        except Exception as exc:  # noqa: BLE001
            yield StreamEvent(type="error", text=f"{exc.__class__.__name__}: {exc}")
            return

        yield StreamEvent(type="complete", text="".join(full))


def _role_str(role: Role) -> str:
    return role.value

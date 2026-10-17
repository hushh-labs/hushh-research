# hushh_mcp/operons/kai/providers/openai.py
"""
OpenAI provider for Kai.

Uses the official `openai` SDK (already in requirements.txt as
openai==2.32.0). Falls back gracefully if the SDK is missing.
"""

from __future__ import annotations

import asyncio
import os
from typing import AsyncIterator, Optional

from .base import CompletionRequest, CompletionResponse, LLMProvider, Role, StreamEvent
from .errors import ProviderError, ProviderResponseInvalid, ProviderTimeout, ProviderUnavailable

try:
    from openai import (  # type: ignore
        APIError,
        APITimeoutError,
        AsyncOpenAI,  # type: ignore
    )

    _OPENAI_AVAILABLE = True
except ImportError:  # pragma: no cover - SDK absent
    _OPENAI_AVAILABLE = False
    AsyncOpenAI = None  # type: ignore
    APIError = Exception  # type: ignore
    APITimeoutError = TimeoutError  # type: ignore


class OpenAIProvider(LLMProvider):
    """Standard OpenAI Chat Completions provider."""

    name = "openai"
    kind = "cloud"

    def __init__(
        self,
        model: str = "gpt-4o-mini",
        base_url: Optional[str] = None,
        api_key_env: str = "OPENAI_API_KEY",
        organization_env: str = "OPENAI_ORG_ID",
    ) -> None:
        self.default_model = model
        self._base_url = base_url
        self._api_key_env = api_key_env
        self._organization_env = organization_env
        self._client: Optional[AsyncOpenAI] = None  # type: ignore[assignment]

    def is_ready(self) -> tuple[bool, Optional[str]]:
        if not _OPENAI_AVAILABLE:
            return False, "openai SDK not installed"
        if not os.getenv(self._api_key_env):
            return False, f"missing env var {self._api_key_env}"
        return True, None

    def _get_client(self) -> "AsyncOpenAI":
        if self._client is None:
            self._client = AsyncOpenAI(  # type: ignore[call-arg]
                api_key=os.getenv(self._api_key_env),
                organization=os.getenv(self._organization_env) or None,
                base_url=self._base_url,
            )
        return self._client

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        ready, why = self.is_ready()
        if not ready:
            raise ProviderUnavailable(why or "OpenAI not ready", provider=self.name)

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
                f"OpenAI call exceeded {request.timeout_seconds}s", provider=self.name
            ) from exc
        except APIError as exc:  # type: ignore[misc]
            raise ProviderError(f"OpenAI API error: {exc}", provider=self.name) from exc
        except Exception as exc:  # noqa: BLE001
            raise ProviderError(
                f"OpenAI call failed: {exc.__class__.__name__}: {exc}",
                provider=self.name,
            ) from exc

        if not resp.choices:
            raise ProviderResponseInvalid("OpenAI returned empty choices", provider=self.name)
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
            yield StreamEvent(type="error", text=why or "OpenAI not ready")
            return

        messages = [
            {"role": _role_str(m.role), "content": m.content}
            for m in request.synthesized_messages()
        ]
        client = self._get_client()
        full = []
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

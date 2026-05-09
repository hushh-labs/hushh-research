# hushh_mcp/operons/kai/providers/llamacpp.py
"""
llama.cpp provider for fully local inference.

llama.cpp's `server` binary exposes either a native API (/completion)
or, with `--api-key` and OpenAI-compat mode, the same /v1/chat/completions
endpoint as vLLM. We use httpx directly against the native /completion
endpoint so this provider is independent of the OpenAI SDK and works
with vanilla llama.cpp builds out of the box.

Scope: `agent.kai.inference.private.local`. Distinct from vLLM's
`private.self_hosted` so the user can authorize on-device inference
separately from a self-hosted server endpoint.
"""

from __future__ import annotations

import asyncio
import os
from typing import AsyncIterator, Optional

import httpx

from .base import CompletionRequest, CompletionResponse, LLMProvider, StreamEvent
from .errors import ProviderError, ProviderResponseInvalid, ProviderTimeout, ProviderUnavailable


class LlamaCppProvider(LLMProvider):
    """Local llama.cpp provider via the native HTTP API."""

    name = "llamacpp"
    kind = "private"

    def __init__(
        self,
        model: str = "local-llamacpp",
        base_url_env: str = "KAI_LLAMACPP_BASE_URL",
        base_url_default: str = "http://localhost:8080",
    ) -> None:
        self.default_model = model
        self._base_url_env = base_url_env
        self._base_url_default = base_url_default
        self._client: Optional[httpx.AsyncClient] = None

    def is_ready(self) -> tuple[bool, Optional[str]]:
        url = os.getenv(self._base_url_env) or self._base_url_default
        if not url:
            return False, f"missing env var {self._base_url_env}"
        return True, None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            base_url = os.getenv(self._base_url_env) or self._base_url_default
            self._client = httpx.AsyncClient(base_url=base_url, timeout=httpx.Timeout(60.0))
        return self._client

    def _build_prompt(self, request: CompletionRequest) -> str:
        """
        Render messages into a single prompt string.

        We use the `ChatML`-ish format that most modern instruct models
        recognize. For server builds running with a chat template, the
        server will prefer messages-based endpoints; this provider
        targets the lowest common denominator (/completion) so it works
        with any GGUF model.
        """
        if request.prompt and not request.system_instruction and not request.messages:
            return request.prompt
        parts: list[str] = []
        for m in request.synthesized_messages():
            role = m.role.value
            parts.append(f"<|im_start|>{role}\n{m.content}<|im_end|>")
        parts.append("<|im_start|>assistant\n")
        return "\n".join(parts)

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        ready, why = self.is_ready()
        if not ready:
            raise ProviderUnavailable(why or "llama.cpp not ready", provider=self.name)

        body = {
            "prompt": self._build_prompt(request),
            "temperature": request.temperature,
            "n_predict": request.max_output_tokens,
            "stream": False,
        }
        client = self._get_client()
        try:
            resp = await asyncio.wait_for(
                client.post("/completion", json=body),
                timeout=request.timeout_seconds,
            )
        except asyncio.TimeoutError as exc:
            raise ProviderTimeout(
                f"llama.cpp call exceeded {request.timeout_seconds}s", provider=self.name
            ) from exc
        except httpx.RequestError as exc:
            raise ProviderUnavailable(
                f"llama.cpp transport error: {exc}", provider=self.name
            ) from exc
        except Exception as exc:  # noqa: BLE001
            raise ProviderError(
                f"llama.cpp call failed: {exc.__class__.__name__}: {exc}",
                provider=self.name,
            ) from exc

        if resp.status_code != 200:
            raise ProviderError(
                f"llama.cpp returned HTTP {resp.status_code}: {resp.text[:200]}",
                provider=self.name,
            )

        try:
            payload = resp.json()
        except Exception as exc:  # noqa: BLE001
            raise ProviderResponseInvalid(
                f"llama.cpp returned non-JSON: {exc}", provider=self.name
            ) from exc

        text = (payload.get("content") or "").strip()
        if not text:
            raise ProviderResponseInvalid(
                "llama.cpp returned empty content", provider=self.name
            )

        return CompletionResponse(
            text=text,
            provider=self.name,
            model=self.default_model,
            finish_reason=payload.get("stopping_word") or "stop",
            usage={
                "prompt_tokens": int(payload.get("tokens_evaluated") or 0),
                "completion_tokens": int(payload.get("tokens_predicted") or 0),
            },
        )

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        ready, why = self.is_ready()
        if not ready:
            yield StreamEvent(type="error", text=why or "llama.cpp not ready")
            return

        body = {
            "prompt": self._build_prompt(request),
            "temperature": request.temperature,
            "n_predict": request.max_output_tokens,
            "stream": True,
        }
        client = self._get_client()
        full: list[str] = []
        try:
            async with client.stream("POST", "/completion", json=body) as resp:
                async for line in resp.aiter_lines():
                    if not line or not line.startswith("data: "):
                        continue
                    payload_str = line.removeprefix("data: ").strip()
                    if not payload_str:
                        continue
                    import json as _json

                    try:
                        evt = _json.loads(payload_str)
                    except Exception:  # noqa: BLE001
                        continue
                    delta = str(evt.get("content") or "")
                    if delta:
                        full.append(delta)
                        yield StreamEvent(type="token", text=delta)
                    if evt.get("stop"):
                        break
        except Exception as exc:  # noqa: BLE001
            yield StreamEvent(type="error", text=f"{exc.__class__.__name__}: {exc}")
            return

        yield StreamEvent(type="complete", text="".join(full))

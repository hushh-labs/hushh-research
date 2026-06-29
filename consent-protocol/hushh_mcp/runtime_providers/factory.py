"""Provider-keyed runtime client factory.

Replaces the Gemini-only branches with a registry-keyed factory. Gemini still
returns the real ``genai.Client``; every other provider returns a native
transport adapter that honors the same genai-client contract. Provider choice
is orthogonal to credential mode -- BYOK vs managed only changes how the key is
sourced and (for Gemini) whether Vertex is used.
"""

from __future__ import annotations

from typing import Any

from .registry import ProviderId, normalize_provider


def _gemini_client(api_key: str, *, managed: bool) -> Any:
    from google import genai

    # BYOK Gemini uses the public API; managed uses Vertex with the managed key.
    return genai.Client(vertexai=managed, api_key=api_key)


def _build(provider: ProviderId, api_key: str, *, managed: bool) -> Any:
    if provider == "gemini":
        return _gemini_client(api_key, managed=managed)
    if provider == "anthropic":
        from .anthropic_transport import AnthropicTransport

        return AnthropicTransport(api_key=api_key)
    if provider == "openai":
        from .openai_transport import OpenAITransport

        return OpenAITransport(api_key=api_key, provider="openai")
    if provider == "grok":
        from .openai_transport import GROK_BASE_URL, OpenAITransport

        return OpenAITransport(api_key=api_key, base_url=GROK_BASE_URL, provider="grok")
    # normalize_provider already rejects unknown providers, so this is defensive.
    raise ValueError(f"Unsupported runtime provider: {provider!r}")


def build_runtime_client(runtime_provider: str, user_key: str) -> Any:
    """BYOK client: the user supplies the key for the chosen provider."""

    provider = normalize_provider(runtime_provider)
    key = (user_key or "").strip()
    if not key:
        raise ValueError("User BYOK runtime key is required")
    return _build(provider, key, managed=False)


def build_managed_runtime_client(runtime_provider: str, user_key: str) -> Any:
    """Hushh-managed client: the platform supplies the key for the provider."""

    provider = normalize_provider(runtime_provider)
    key = (user_key or "").strip()
    if not key:
        raise RuntimeError("Managed runtime API key is not configured")
    return _build(provider, key, managed=True)

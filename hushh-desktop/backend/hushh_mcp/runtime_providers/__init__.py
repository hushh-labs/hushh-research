"""Native multi-provider runtime transports for the Agent brain.

The Agent brain stays behind one stable text-generation contract: the
``google-genai`` client surface (``client.aio.models.generate_content`` and
``client.aio.models.generate_content_stream``) consumed by
``AgentChatService``. Gemini uses the real ``genai.Client``; every other
provider (Anthropic, OpenAI, Grok) is exposed through a native transport
adapter that translates genai-shaped requests/responses to and from that
provider's native SDK.

This keeps provider choice orthogonal to the rest of the runtime: the chat
service, voice lanes, and subagents never branch on provider; they call the
same contract regardless of which brain answers.
"""

from __future__ import annotations

from .factory import build_managed_runtime_client, build_runtime_client
from .registry import (
    ModelEntry,
    ProviderId,
    default_model_for_provider,
    is_known_provider,
    normalize_provider,
    resolve_model_entry,
    supported_providers,
)

__all__ = [
    "ModelEntry",
    "ProviderId",
    "build_managed_runtime_client",
    "build_runtime_client",
    "default_model_for_provider",
    "is_known_provider",
    "normalize_provider",
    "resolve_model_entry",
    "supported_providers",
]

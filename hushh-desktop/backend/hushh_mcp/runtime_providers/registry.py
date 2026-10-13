"""Central model registry for runtime providers.

Single source of truth for which providers and models the Agent brain can run
on, the canonical default model per provider, and the capability flags the
voice/transport layers depend on (native realtime, streaming, function calling,
prompt caching). This removes hardcoded model strings scattered across the
runtime and lets credential mode stay orthogonal to provider choice.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from hushh_mcp.constants import GEMINI_MODEL

ProviderId = Literal["gemini", "anthropic", "openai", "grok"]

_PROVIDER_ALIASES: dict[str, ProviderId] = {
    "gemini": "gemini",
    "google": "gemini",
    "google_genai": "gemini",
    "vertex": "gemini",
    "anthropic": "anthropic",
    "claude": "anthropic",
    "openai": "openai",
    "oai": "openai",
    "grok": "grok",
    "xai": "grok",
    "x.ai": "grok",
}


@dataclass(frozen=True)
class ModelEntry:
    """Canonical description of one runnable model on a provider."""

    provider: ProviderId
    model: str
    supports_streaming: bool = True
    supports_function_calling: bool = True
    supports_native_realtime: bool = False
    supports_prompt_caching: bool = False
    aliases: tuple[str, ...] = field(default_factory=tuple)


# OpenAI's realtime API base. Grok speaks the OpenAI wire format on its own host.
OPENAI_REALTIME_PROVIDERS: tuple[ProviderId, ...] = ("gemini", "openai")

_MODELS: tuple[ModelEntry, ...] = (
    # Gemini -- runs on the real google-genai client; native realtime via Live API.
    ModelEntry(
        provider="gemini",
        model=GEMINI_MODEL,
        supports_native_realtime=True,
        supports_prompt_caching=True,
        aliases=("gemini-default", "default"),
    ),
    ModelEntry(provider="gemini", model="gemini-3.5-flash", supports_native_realtime=True),
    ModelEntry(provider="gemini", model="gemini-3.1-pro-preview", supports_native_realtime=True),
    ModelEntry(provider="gemini", model="gemini-3.1-flash-lite", supports_native_realtime=True),
    # Anthropic -- native SDK adapter; chained-only voice (no native realtime API).
    ModelEntry(
        provider="anthropic",
        model="claude-sonnet-4-5",
        supports_prompt_caching=True,
        aliases=("claude-default", "claude", "claude-sonnet"),
    ),
    ModelEntry(provider="anthropic", model="claude-opus-4-1", supports_prompt_caching=True),
    ModelEntry(provider="anthropic", model="claude-haiku-4-5", supports_prompt_caching=True),
    # OpenAI -- native SDK adapter; native realtime API.
    ModelEntry(
        provider="openai",
        model="gpt-5.1",
        supports_native_realtime=True,
        aliases=("openai-default", "gpt"),
    ),
    ModelEntry(provider="openai", model="gpt-5", supports_native_realtime=True),
    ModelEntry(provider="openai", model="gpt-5-mini", supports_native_realtime=True),
    # Grok -- OpenAI-compatible wire format on the x.ai host; chained-only voice.
    ModelEntry(
        provider="grok",
        model="grok-4",
        aliases=("grok-default", "grok"),
    ),
    ModelEntry(provider="grok", model="grok-4-fast"),
)

_DEFAULT_MODEL_BY_PROVIDER: dict[ProviderId, ModelEntry] = {}
_MODEL_BY_KEY: dict[tuple[ProviderId, str], ModelEntry] = {}
for _entry in _MODELS:
    _DEFAULT_MODEL_BY_PROVIDER.setdefault(_entry.provider, _entry)
    _MODEL_BY_KEY[(_entry.provider, _entry.model.lower())] = _entry
    for _alias in _entry.aliases:
        _MODEL_BY_KEY.setdefault((_entry.provider, _alias.lower()), _entry)


def normalize_provider(provider: str | None) -> ProviderId:
    """Map any known provider name/alias to its canonical id.

    Raises ``ValueError`` for unknown providers so callers fail closed rather
    than silently defaulting to a different brain.
    """

    key = (provider or "").strip().lower()
    if key in _PROVIDER_ALIASES:
        return _PROVIDER_ALIASES[key]
    raise ValueError(f"Unsupported runtime provider: {provider!r}")


def is_known_provider(provider: str | None) -> bool:
    return (provider or "").strip().lower() in _PROVIDER_ALIASES


def supported_providers() -> tuple[ProviderId, ...]:
    return tuple(_DEFAULT_MODEL_BY_PROVIDER.keys())


def default_model_for_provider(provider: str | None) -> str:
    canonical = normalize_provider(provider)
    return _DEFAULT_MODEL_BY_PROVIDER[canonical].model


def resolve_model_entry(provider: str | None, model: str | None) -> ModelEntry:
    """Resolve a (provider, model) pair to a registry entry.

    Unknown but well-formed model strings on a known provider are accepted as a
    pass-through entry with conservative capability defaults, so the registry
    does not block a newly released model id. Unknown providers still fail.
    """

    canonical = normalize_provider(provider)
    requested = (model or "").strip()
    if not requested:
        return _DEFAULT_MODEL_BY_PROVIDER[canonical]

    entry = _MODEL_BY_KEY.get((canonical, requested.lower()))
    if entry is not None:
        return entry

    # Pass-through for unrecognized model ids on a known provider. Capabilities
    # default to streaming + function calling on; realtime/caching off until a
    # registry entry declares them.
    return ModelEntry(provider=canonical, model=requested)

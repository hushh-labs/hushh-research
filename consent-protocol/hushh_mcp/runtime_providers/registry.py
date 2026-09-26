"""Central model registry for runtime providers.

Single source of truth for which providers and models the Agent brain can run
on, the canonical default model per provider, and the capability flags used by
runtime adapters (streaming, function calling, prompt caching). This removes
hardcoded model strings scattered across the runtime and lets credential mode
stay orthogonal to provider choice.
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
    supported_vertex_locations: tuple[str, ...] = field(default_factory=tuple)
    aliases: tuple[str, ...] = field(default_factory=tuple)


# OpenAI's realtime API base. Grok speaks the OpenAI wire format on its own host.
OPENAI_REALTIME_PROVIDERS: tuple[ProviderId, ...] = ("gemini", "openai")

# Vertex endpoints measured to serve a text model; unmeasured models stay
# global-only. 2026-09-24: the since-retired 3.8 Flash answered generateContent on
# the `us` and `eu` multi-region endpoints while `global` returned 429, so
# HUSHH_VERTEX_LOCATIONS failover is real. 2026-09-25: gemini-3.7-flash and
# gemini-3.6-flash each answered generateContent 2 of 2 on `global`, `us` and `eu`
# (managed bridge project). Add a row here only from a live probe.
_MEASURED_VERTEX_LOCATIONS: dict[str, tuple[str, ...]] = {
    "gemini-3.7-flash": ("global", "us", "eu"),
    "gemini-3.6-flash": ("global", "us", "eu"),
}

_MODELS: tuple[ModelEntry, ...] = (
    # Gemini text models use generateContent and are not valid Live transports.
    # Native realtime is model-specific; never infer it from the provider.
    # Founder rule 2026-09-14: exactly the last two Gemini releases are registered
    # for generation. A roll-forward replaces the oldest row, it never adds a third.
    ModelEntry(
        provider="gemini",
        model=GEMINI_MODEL,
        supports_prompt_caching=True,
        supported_vertex_locations=_MEASURED_VERTEX_LOCATIONS.get(GEMINI_MODEL, ("global",)),
        aliases=("gemini-default", "default"),
    ),
    ModelEntry(
        provider="gemini",
        model="gemini-3.7-flash",
        supports_prompt_caching=True,
        supported_vertex_locations=_MEASURED_VERTEX_LOCATIONS["gemini-3.7-flash"],
    ),
    ModelEntry(
        provider="gemini",
        model="gemini-3.6-flash",
        supports_prompt_caching=True,
        supported_vertex_locations=_MEASURED_VERTEX_LOCATIONS["gemini-3.6-flash"],
    ),
    # Retrieval-only model used by the server-owned Location Brain semantic
    # index. Global-only availability makes ManagedGeminiRuntimeBinding return
    # the native GenAI client, which exposes ``embed_content``, rather than the
    # generation-only regional failover facade.
    ModelEntry(
        provider="gemini",
        model="gemini-embedding-001",
        supports_streaming=False,
        supports_function_calling=False,
        supported_vertex_locations=("global",),
    ),
    # Gemini Live (bidirectional audio) on Vertex. Live models are served from
    # regional endpoints only, so the entry pins its region and never inherits
    # the global/us/eu multi-region aliases the text fleet uses. Only entries
    # with ``supports_native_realtime=True`` may be selected by
    # ``resolve_live_model_entry``; a pass-through id never gains realtime
    # authority by name. ``aliases`` stays empty on purpose (no aliases rule).
    ModelEntry(
        provider="gemini",
        model="gemini-live-2.5-flash-native-audio",
        supports_native_realtime=True,
        supported_vertex_locations=("us-central1",),
    ),
    # Anthropic -- native SDK adapter.
    ModelEntry(
        provider="anthropic",
        model="claude-sonnet-4-5",
        supports_prompt_caching=True,
        aliases=("claude-default", "claude", "claude-sonnet"),
    ),
    ModelEntry(provider="anthropic", model="claude-opus-4-1", supports_prompt_caching=True),
    ModelEntry(provider="anthropic", model="claude-haiku-4-5", supports_prompt_caching=True),
    # OpenAI -- native SDK adapter.
    ModelEntry(
        provider="openai",
        model="gpt-5.1",
        supports_native_realtime=True,
        aliases=("openai-default", "gpt"),
    ),
    ModelEntry(provider="openai", model="gpt-5", supports_native_realtime=True),
    ModelEntry(provider="openai", model="gpt-5-mini", supports_native_realtime=True),
    # Grok -- OpenAI-compatible wire format on the x.ai host.
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


class LiveModelNotRegisteredError(ValueError):
    """The requested Live model id is not a registered native-realtime model."""


def resolve_live_model_entry(model_id: str | None) -> ModelEntry:
    """Resolve an explicit Gemini Live model id, failing closed.

    Unlike :func:`resolve_model_entry`, there is no pass-through and no alias
    lookup: the id must match a registered Gemini entry that declares
    ``supports_native_realtime=True`` and at least one regional Vertex
    location. This is what makes ``VERTEX_LIVE_MODEL_ID`` an exact pin rather
    than a hint.
    """

    requested = (model_id or "").strip()
    if not requested:
        raise LiveModelNotRegisteredError("A Live model id is required")
    entry = _MODEL_BY_KEY.get(("gemini", requested.lower()))
    if entry is None or entry.model.lower() != requested.lower():
        # An alias hit (entry.model != requested) is rejected as well.
        raise LiveModelNotRegisteredError(f"{requested!r} is not a registered Vertex Live model id")
    if not entry.supports_native_realtime:
        raise LiveModelNotRegisteredError(
            f"{requested!r} is not a native-realtime model and cannot run Gemini Live"
        )
    if not entry.supported_vertex_locations or any(
        location in {"global", "us", "eu"} for location in entry.supported_vertex_locations
    ):
        raise LiveModelNotRegisteredError(
            f"{requested!r} must declare regional Vertex locations only"
        )
    return entry

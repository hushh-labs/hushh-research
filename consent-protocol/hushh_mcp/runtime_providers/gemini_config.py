"""Generation-aware Gemini generation configuration.

Exactly two Gemini text releases are supported at any time (founder rule 2026-09-14:
the catalog lists only the last two releases; a roll-forward replaces the oldest and
never adds a third). Both own their sampling policy, so callers must not send the
legacy sampling knobs to them, and both accept ``thinking_level`` LOW, MEDIUM and
HIGH while rejecting MINIMAL with 400 INVALID_ARGUMENT ("Thinking level is
unsupported: THINKING_LEVEL_MINIMAL"). Measured live 2026-09-14 against
gemini-3.8-flash and gemini-3.7-flash, cell by cell; the contract test pins that
matrix. Keeping this rule in one adapter prevents every product agent from
independently guessing the provider contract. Any other model id passes through
untouched: there are no model-specific branches beyond "supported or not".
"""

from __future__ import annotations

from typing import Any

GEMINI_38_FLASH = "gemini-3.8-flash"
GEMINI_37_FLASH = "gemini-3.7-flash"

# Newest first. Exactly two ids, consecutive minor releases; the policy test enforces it.
SUPPORTED_GEMINI_TEXT_MODELS: tuple[str, ...] = (GEMINI_38_FLASH, GEMINI_37_FLASH)

_SUPPORTED_MODEL_NAMES = frozenset(
    name for model in SUPPORTED_GEMINI_TEXT_MODELS for name in (model, f"models/{model}")
)

# Both supported releases replaced these with thinking_level; the provider accepts them
# silently (measured: temperature 0.2 returned 200) but they no longer mean anything, so
# the adapter drops them rather than let a caller believe they took effect.
_GEMINI_FLASH_UNSUPPORTED_FIELDS = frozenset({"candidate_count", "temperature", "top_k", "top_p"})

# Thinking levels the supported releases accept, as the provider spells them.
SUPPORTED_THINKING_LEVELS: tuple[str, ...] = ("LOW", "MEDIUM", "HIGH")
_REJECTED_THINKING_LEVEL = "MINIMAL"
_COERCED_THINKING_LEVEL = "LOW"


def _normalize_model(model: str | None) -> str:
    return str(model or "").strip().lower()


def is_gemini_38_flash(model: str | None) -> bool:
    return _normalize_model(model) in {GEMINI_38_FLASH, f"models/{GEMINI_38_FLASH}"}


def is_gemini_37_flash(model: str | None) -> bool:
    return _normalize_model(model) in {GEMINI_37_FLASH, f"models/{GEMINI_37_FLASH}"}


def is_supported_gemini_text_model(model: str | None) -> bool:
    """True only for the two supported releases (bare or ``models/``-prefixed)."""
    return _normalize_model(model) in _SUPPORTED_MODEL_NAMES


# Deprecated alias, kept for tests/test_fleet_text_model_switch.py (outside this change's
# write set). New code names the policy, not a generation range.
is_gemini_flash_v3 = is_supported_gemini_text_model


def _level_name(level: Any) -> str:
    """The provider spelling of a level: enum member or string, any case, any prefix."""
    raw = str(getattr(level, "value", level) or "").strip().upper()
    if raw.startswith("THINKING_LEVEL_"):
        raw = raw[len("THINKING_LEVEL_") :]
    return raw


def _coerce_thinking_level(level: Any) -> Any:
    """MINIMAL becomes LOW in the same shape it arrived (enum member or string)."""
    if _level_name(level) != _REJECTED_THINKING_LEVEL:
        return level
    enum_type = type(level)
    if hasattr(enum_type, _COERCED_THINKING_LEVEL):
        return getattr(enum_type, _COERCED_THINKING_LEVEL)
    return _COERCED_THINKING_LEVEL


def _sanitize_thinking_config(thinking_cfg: Any) -> Any:
    """Apply the supported-release thinking contract to a dict or ThinkingConfig-like value.

    ``include_thoughts`` and ``thinking_budget`` pass through as they always have.
    ``thinking_level`` passes through, except MINIMAL which the provider rejects and
    the adapter maps to LOW. A ``None`` level is left to the provider default (MEDIUM).
    """
    if thinking_cfg is None:
        return None
    if isinstance(thinking_cfg, dict):
        cleaned = {key: value for key, value in thinking_cfg.items() if value is not None}
        if "thinking_level" in cleaned:
            cleaned["thinking_level"] = _coerce_thinking_level(cleaned["thinking_level"])
        return cleaned or None
    if not hasattr(thinking_cfg, "thinking_level"):
        return thinking_cfg
    level = getattr(thinking_cfg, "thinking_level", None)
    if level is None or _level_name(level) != _REJECTED_THINKING_LEVEL:
        return thinking_cfg
    kwargs_tc: dict[str, Any] = {"thinking_level": _coerce_thinking_level(level)}
    for field in ("include_thoughts", "thinking_budget"):
        value = getattr(thinking_cfg, field, None)
        if value is not None:
            kwargs_tc[field] = value
    try:
        return type(thinking_cfg)(**kwargs_tc)
    except Exception:
        # A config the adapter cannot rebuild must not reach the provider carrying the
        # rejected level; dropping it falls back to the provider default.
        return None


def generation_config_kwargs(model: str | None, **kwargs: Any) -> dict[str, Any]:
    """Return provider-compatible kwargs; unsupported ids pass through unchanged."""
    result = {key: value for key, value in kwargs.items() if value is not None}
    if not is_supported_gemini_text_model(model):
        return result
    for field in _GEMINI_FLASH_UNSUPPORTED_FIELDS:
        result.pop(field, None)
    if "thinking_config" not in result:
        return result
    sanitized = _sanitize_thinking_config(result["thinking_config"])
    if sanitized is None:
        result.pop("thinking_config", None)
        return result
    result["thinking_config"] = sanitized
    return result


def thinking_config_for(model: str | None, level: str | None, types_module: Any) -> Any:
    """Build a ``ThinkingConfig`` for ``model`` from an authored level, or ``None``.

    ``level`` is one of minimal, low, medium, high (any case; manifests author the
    lowercase words). ``None`` means no preference and yields ``None`` so the provider
    default applies. For a supported release MINIMAL is coerced to LOW because the
    provider rejects it; any other id receives the level as authored. An unknown level
    is a caller defect and raises rather than reaching the provider.
    """
    if level is None or not str(level).strip():
        return None
    name = _level_name(level)
    if name not in (*SUPPORTED_THINKING_LEVELS, _REJECTED_THINKING_LEVEL):
        raise ValueError(
            f"unknown thinking_level {level!r}; expected one of minimal, low, medium, high"
        )
    if is_supported_gemini_text_model(model) and name == _REJECTED_THINKING_LEVEL:
        name = _COERCED_THINKING_LEVEL
    level_enum = getattr(types_module, "ThinkingLevel", None)
    resolved = getattr(level_enum, name, name) if level_enum is not None else name
    return types_module.ThinkingConfig(thinking_level=resolved)


def build_generate_content_config(types_module: Any, model: str | None, **kwargs: Any) -> Any:
    """Build the SDK config after applying the model compatibility contract."""
    return types_module.GenerateContentConfig(**generation_config_kwargs(model, **kwargs))


_FLEET_MODEL_ALIASES = {"default", "gemini-default", "active", "gemini-active", "gemini_default"}


def resolve_fleet_model_name(model: str | None) -> str:
    """Map the fleet alias (`gemini-default` and friends) to the switched text model.

    Manifests name the alias so one setting (HUSSH_GEMINI_TEXT_MODEL, read by
    constants.GEMINI_MODEL) moves every text agent; any other id passes through.
    """
    from hushh_mcp.constants import GEMINI_MODEL

    normalized = str(model or "").strip()
    if not normalized or normalized.lower() in _FLEET_MODEL_ALIASES:
        return str(GEMINI_MODEL)
    return normalized

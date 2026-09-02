"""Model-aware Gemini generation configuration.

Gemini 3.7 Flash and 3.6 Flash intentionally own their sampling policy. Callers
must not send legacy sampling knobs or token-budget thinking controls to those
models. Keeping this rule in one adapter prevents every product agent from
independently guessing the provider contract.
"""

from __future__ import annotations

import re
from typing import Any

GEMINI_38_FLASH = "gemini-3.8-flash"
GEMINI_37_FLASH = "gemini-3.7-flash"
GEMINI_36_FLASH = "gemini-3.6-flash"
GEMINI_31_PRO_PREVIEW = "gemini-3.1-pro-preview"

_GEMINI_FLASH_UNSUPPORTED_FIELDS = {
    "candidate_count",
    "temperature",
    "top_k",
    "top_p",
}

_GEMINI_31_PRO_UNSUPPORTED_FIELDS = {
    "candidate_count",
    "temperature",
    "top_k",
    "top_p",
}


def is_gemini_37_flash(model: str | None) -> bool:
    normalized = str(model or "").strip().lower()
    return normalized in {GEMINI_37_FLASH, f"models/{GEMINI_37_FLASH}"}


def is_gemini_36_flash(model: str | None) -> bool:
    normalized = str(model or "").strip().lower()
    return normalized in {GEMINI_36_FLASH, f"models/{GEMINI_36_FLASH}"}


# 3.6 Flash and newer own their sampling policy; 3.5 and older keep the legacy knobs.
_GEMINI_FLASH_V3_RE = re.compile(r"^(?:models/)?gemini-3\.(?:[6-9]|[1-9]\d)-flash$")


def is_gemini_38_flash(model: str | None) -> bool:
    normalized = str(model or "").strip().lower()
    return normalized in {GEMINI_38_FLASH, f"models/{GEMINI_38_FLASH}"}


def is_gemini_flash_v3(model: str | None) -> bool:
    """Every Flash generation from 3.6 on (3.6, 3.7, 3.8, ...) shares the sampling contract."""
    normalized = str(model or "").strip().lower()
    return bool(_GEMINI_FLASH_V3_RE.fullmatch(normalized))


def is_gemini_31_pro_preview(model: str | None) -> bool:
    normalized = str(model or "").strip().lower()
    return normalized in {GEMINI_31_PRO_PREVIEW, f"models/{GEMINI_31_PRO_PREVIEW}"}


def _sanitize_thinking_config_for_flash_v3(thinking_cfg: Any) -> Any:
    if thinking_cfg is None:
        return None
    if isinstance(thinking_cfg, dict):
        cleaned = {k: v for k, v in thinking_cfg.items() if k != "thinking_level" and v is not None}
        return cleaned or None
    if hasattr(thinking_cfg, "thinking_level"):
        include_thoughts = getattr(thinking_cfg, "include_thoughts", None)
        thinking_budget = getattr(thinking_cfg, "thinking_budget", None)
        thinking_type = type(thinking_cfg)
        kwargs_tc: dict[str, Any] = {}
        if include_thoughts is not None:
            kwargs_tc["include_thoughts"] = include_thoughts
        if thinking_budget is not None:
            kwargs_tc["thinking_budget"] = thinking_budget
        if kwargs_tc:
            try:
                return thinking_type(**kwargs_tc)
            except Exception:
                return None
        return None
    return thinking_cfg


def generation_config_kwargs(model: str | None, **kwargs: Any) -> dict[str, Any]:
    """Return provider-compatible kwargs without changing non-3.x flash callers."""
    result = {key: value for key, value in kwargs.items() if value is not None}
    if is_gemini_flash_v3(model):
        for field in _GEMINI_FLASH_UNSUPPORTED_FIELDS:
            result.pop(field, None)
        if "thinking_config" in result:
            sanitized = _sanitize_thinking_config_for_flash_v3(result["thinking_config"])
            if sanitized is not None:
                result["thinking_config"] = sanitized
            else:
                result.pop("thinking_config", None)
    elif is_gemini_31_pro_preview(model):
        for field in _GEMINI_31_PRO_UNSUPPORTED_FIELDS:
            result.pop(field, None)
    return result


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

"""Model-aware Gemini generation configuration.

Gemini 3.6 Flash intentionally owns its sampling policy. Callers must not send
legacy sampling knobs or token-budget thinking controls to that model. Keeping
this rule in one adapter prevents every product agent from independently
guessing the provider contract.
"""

from __future__ import annotations

from typing import Any

GEMINI_36_FLASH = "gemini-3.6-flash"

_GEMINI_36_UNSUPPORTED_FIELDS = {
    "candidate_count",
    "temperature",
    "top_k",
    "top_p",
}


def is_gemini_36_flash(model: str | None) -> bool:
    normalized = str(model or "").strip().lower()
    return normalized in {GEMINI_36_FLASH, f"models/{GEMINI_36_FLASH}"}


def generation_config_kwargs(model: str | None, **kwargs: Any) -> dict[str, Any]:
    """Return provider-compatible kwargs without changing non-3.6 callers."""
    result = {key: value for key, value in kwargs.items() if value is not None}
    if is_gemini_36_flash(model):
        for field in _GEMINI_36_UNSUPPORTED_FIELDS:
            result.pop(field, None)
    return result


def build_generate_content_config(types_module: Any, model: str | None, **kwargs: Any) -> Any:
    """Build the SDK config after applying the model compatibility contract."""
    return types_module.GenerateContentConfig(**generation_config_kwargs(model, **kwargs))

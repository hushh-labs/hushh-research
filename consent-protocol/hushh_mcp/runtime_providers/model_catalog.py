"""What text model a person may choose, derived from the registry rather than the environment.

The deployment environment names a *default*, never the only possibility. Anything that
needs to know which models exist asks here, so adding a generation is one registry row
plus one line in ``FLEET_TEXT_MODEL_CHOICES`` -- not a redeploy of every lane.

Founder directive 2026-09-02: the text fleet runs Flash. Newest first, so the head of
this tuple is what a fresh chooser sees at the top.
"""

from __future__ import annotations

from dataclasses import dataclass

from hushh_mcp.runtime_providers.registry import resolve_model_entry

# Newest first. A model belongs here only once the registry knows it AND at least one
# lane's Vertex allowed-models policy admits it; the catalog reports availability per
# entry rather than hiding a model the lane cannot serve.
FLEET_TEXT_MODEL_CHOICES: tuple[str, ...] = (
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
)

_LABELS: dict[str, str] = {
    "gemini-3.8-flash": "Gemini 3.8 Flash",
    "gemini-3.7-flash": "Gemini 3.7 Flash",
    "gemini-3.6-flash": "Gemini 3.6 Flash",
    "gemini-3.5-flash": "Gemini 3.5 Flash",
}


@dataclass(frozen=True)
class TextModelChoice:
    """One selectable text model, as a person sees it."""

    model_id: str
    label: str
    is_default: bool


def _label_for(model_id: str) -> str:
    return _LABELS.get(model_id, model_id)


def deployment_default_text_model() -> str:
    """The lane's default, read by module attribute at call time.

    ``constants.GEMINI_MODEL`` is the environment-supplied default and is still read
    from the process environment once, at import. What this function refuses to do is
    freeze a second copy: it reads the attribute on every call (never
    ``from ... import``), so a runtime override of that attribute takes effect without a
    restart, and the person tier above it never depends on this value at all.
    """
    from hushh_mcp import constants

    return str(constants.GEMINI_MODEL)


def is_selectable_text_model(model_id: str | None) -> bool:
    """True when a person may choose this model. The catalog is the only authority."""
    normalized = str(model_id or "").strip()
    if normalized not in FLEET_TEXT_MODEL_CHOICES:
        return False
    try:
        resolve_model_entry("gemini", normalized)
    except Exception:
        return False
    return True


def selectable_text_models() -> tuple[TextModelChoice, ...]:
    """Every model a person may choose, newest first, with the lane default marked.

    The lane default always appears, even if a future environment pins something outside
    the Flash choices: a chooser that cannot show what is running would be lying.
    """
    default = deployment_default_text_model()
    choices = [
        TextModelChoice(
            model_id=model_id, label=_label_for(model_id), is_default=model_id == default
        )
        for model_id in FLEET_TEXT_MODEL_CHOICES
        if is_selectable_text_model(model_id)
    ]
    if default and not any(choice.model_id == default for choice in choices):
        choices.append(
            TextModelChoice(model_id=default, label=_label_for(default), is_default=True)
        )
    return tuple(choices)

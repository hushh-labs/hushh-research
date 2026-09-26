"""The 3.1 Pro preview rejects `thinking_level: MINIMAL`; the config maps it to LOW.

Verified live 2026-09-02 from two directions at once. The dev readiness probe exercised
the pro preview as a candidate and Vertex answered
`400 INVALID_ARGUMENT: thinking_level MINIMAL is not supported by this model`, so the
probe reported `candidate_misconfigured` and the model looked broken when only one
enum value was.

This branch first fixed it by STRIPPING `thinking_level` the way the 3.x flash
sanitizer does. `main` fixed the same failure the same day by MAPPING the one
unsupported level to LOW, which is the better answer and is what survived the
2026-09-02 sync: stripping silently discards the caller's intent to think cheaply,
while mapping keeps it at the nearest level the model accepts. These tests pin the
mapping, and pin that nothing else about the config moves.
"""

from __future__ import annotations

from google.genai import types

from hushh_mcp.runtime_providers.gemini_config import generation_config_kwargs

PRO_PREVIEW = "gemini-3.1-pro-preview"


def _apply(model: str, **kwargs):
    return generation_config_kwargs(model, **kwargs)


def test_minimal_becomes_low_and_the_rest_of_the_config_survives() -> None:
    out = _apply(
        PRO_PREVIEW,
        max_output_tokens=4,
        thinking_config=types.ThinkingConfig(
            thinking_level=types.ThinkingLevel.MINIMAL, include_thoughts=False
        ),
    )
    assert out["max_output_tokens"] == 4
    cfg = out["thinking_config"]
    level = getattr(cfg, "thinking_level", None)
    assert level is not None, "the level must be mapped, not dropped"
    assert str(getattr(level, "value", level)).upper().endswith("LOW")
    assert getattr(cfg, "include_thoughts", None) is False


def test_a_level_the_model_accepts_is_left_exactly_as_it_came() -> None:
    out = _apply(
        PRO_PREVIEW,
        thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.HIGH),
    )
    level = out["thinking_config"].thinking_level
    assert str(getattr(level, "value", level)).upper().endswith("HIGH")


def test_a_dict_shaped_thinking_config_is_mapped_too() -> None:
    """Callers hand this in as a dict as well as an SDK object; both reach Vertex."""
    out = _apply(PRO_PREVIEW, thinking_config={"thinking_level": "MINIMAL", "x": 1})
    cfg = out["thinking_config"]
    assert str(cfg["thinking_level"]).upper().endswith("LOW")
    assert cfg["x"] == 1, "unrelated keys must be carried through untouched"


def test_no_thinking_config_stays_absent() -> None:
    assert "thinking_config" not in _apply(PRO_PREVIEW, max_output_tokens=2)


def test_a_model_outside_both_rules_is_untouched() -> None:
    """Neither a 3.x flash (whose sanitizer strips the level) nor the pro preview.
    3.7-flash would be the wrong control here: it takes the flash branch, which drops
    `thinking_config` entirely, so it cannot show that the pro rule is scoped."""
    out = _apply(
        "gemini-2.5-flash",
        thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.MINIMAL),
    )
    level = out["thinking_config"].thinking_level
    assert str(getattr(level, "value", level)).upper().endswith("MINIMAL"), (
        "the mapping is a 3.1-pro compatibility rule, not a fleet-wide one"
    )

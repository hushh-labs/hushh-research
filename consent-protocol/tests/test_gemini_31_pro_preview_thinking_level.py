"""gemini-3.1-pro-preview rejects thinking_level; the shared config must never send it.

Seen live 2026-09-02: the dev readiness probe exercised the pro preview as a
candidate with thinking_level=MINIMAL and Vertex answered 400, which the lane
classified as candidate_misconfigured and refused the release.
"""

from __future__ import annotations

from google.genai import types

from hushh_mcp.runtime_providers.gemini_config import generation_config_kwargs


def test_pro_preview_drops_thinking_level_but_keeps_the_rest() -> None:
    out = generation_config_kwargs(
        "gemini-3.1-pro-preview",
        temperature=0,
        max_output_tokens=4,
        thinking_config=types.ThinkingConfig(
            include_thoughts=False, thinking_level=types.ThinkingLevel.MINIMAL
        ),
    )
    assert "temperature" not in out
    assert out["max_output_tokens"] == 4
    cfg = out["thinking_config"]
    assert getattr(cfg, "thinking_level", None) is None
    assert cfg.include_thoughts is False


def test_pro_preview_with_only_a_level_sends_no_thinking_config() -> None:
    out = generation_config_kwargs(
        "gemini-3.1-pro-preview",
        thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.MINIMAL),
    )
    assert "thinking_config" not in out


def test_other_models_are_untouched() -> None:
    out = generation_config_kwargs(
        "gemini-3.1-flash-lite",
        thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.MINIMAL),
    )
    assert out["thinking_config"].thinking_level == types.ThinkingLevel.MINIMAL

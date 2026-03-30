"""
Live OpenAI API key smoke test.

This test is intentionally opt-in because it makes a real network call.
Enable it only when you want to validate `OPENAI_API_KEY` from `.env`.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from dotenv import load_dotenv


def _load_local_env() -> None:
    # Resolve consent-protocol/.env regardless of where pytest is launched from.
    env_path = Path(__file__).resolve().parents[1] / ".env"
    load_dotenv(env_path, override=False)


@pytest.mark.skipif(
    os.getenv("RUN_OPENAI_LIVE_TESTS") != "1",
    reason="Set RUN_OPENAI_LIVE_TESTS=1 to run live OpenAI key checks.",
)
def test_openai_api_key_live_prompt() -> None:
    _load_local_env()

    api_key = os.getenv("OPENAI_API_KEY")
    assert api_key, "OPENAI_API_KEY is missing in consent-protocol/.env"

    openai = pytest.importorskip("openai")
    client = openai.OpenAI(api_key=api_key)

    response = client.responses.create(
        model=os.getenv("OPENAI_VOICE_INTENT_MODEL", "gpt-4.1-mini"),
        input="What is a neural network? Explain in 2 short sentences.",
        max_output_tokens=120,
    )

    text = (response.output_text or "").strip()
    assert text, "OpenAI returned an empty response. Check API key/model access."

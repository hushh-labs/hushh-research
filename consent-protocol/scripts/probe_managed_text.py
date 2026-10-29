"""Provider-bound readiness evidence from the actual UAT managed text adapters."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Literal

from hushh_mcp.managed_ai_config import PROFILE_PATH, profile_hash
from hushh_mcp.runtime_providers.managed_text import (
    TEXT_SCOPES,
    managed_text_policy,
    probe_managed_text_model,
)


async def probe_managed_text(provider: Literal["azure_openai", "vertex"]) -> dict:
    scopes = {}
    next_start = 0.0
    for scope in sorted(TEXT_SCOPES):
        if provider == "vertex" and next_start > time.monotonic():
            await asyncio.sleep(next_start - time.monotonic())
        next_start = time.monotonic() + 30
        scopes[scope] = await probe_managed_text_model(
            scope=scope,
            provider=provider,
            allow_fallback=False,
        )
    policy = managed_text_policy()
    if policy is None:
        raise ValueError("Managed text readiness requires UAT policy")
    return {
        "schema": "managed_text_probe.v1",
        "provider": provider,
        "ready": True,
        "scopes": scopes,
        "policy_generation": policy["generation"],
        "config_fingerprint": profile_hash(json.loads(PROFILE_PATH.read_text())),
    }

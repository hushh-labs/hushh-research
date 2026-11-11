"""Provider-bound readiness evidence from the actual UAT managed text adapters."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Literal

from hushh_mcp.managed_ai_config import PROFILE_PATH, load_scoped_text_policy, profile_hash
from hushh_mcp.runtime_providers.managed_text import (
    TEXT_SCOPES,
    managed_text_binding,
    managed_text_policy,
    probe_managed_text_model,
)


async def probe_managed_text(provider: Literal["azure_openai", "vertex"]) -> dict:
    document = json.loads(PROFILE_PATH.read_text())
    scoped = {
        scope: load_scoped_text_policy(scope, environment="uat", document=document)
        for scope in TEXT_SCOPES
    }
    uses_scoped_policy = any(scoped.values())
    providers = {
        scope: policy["provider"] if policy else provider for scope, policy in scoped.items()
    }
    scopes = {}
    next_start = 0.0
    for scope in sorted(TEXT_SCOPES):
        effective = providers[scope]
        if effective == "vertex" and next_start > time.monotonic():
            await asyncio.sleep(next_start - time.monotonic())
        next_start = time.monotonic() + 30
        scopes[scope] = await probe_managed_text_model(
            scope=scope,
            provider=effective,
            allow_fallback=False,
        )
        if uses_scoped_policy:
            binding = managed_text_binding(scope=scope)
            scopes[scope] = {
                **scopes[scope],
                "policy_generation": binding["approval_generation"],
                "binding_fingerprint": binding["config_fingerprint"],
            }
    policy = managed_text_policy()
    if policy is None:
        raise ValueError("Managed text readiness requires UAT policy")
    from scripts.probe_drive_activity_planner import probe_drive_activity_planner

    activity_planner = await probe_drive_activity_planner(providers["drive_document_requests"])
    return {
        "schema": "managed_text_probe.v2" if uses_scoped_policy else "managed_text_probe.v1",
        "provider": provider,
        "ready": True,
        "scopes": scopes,
        "activity_planner": activity_planner,
        **({} if uses_scoped_policy else {"policy_generation": policy["generation"]}),
        "config_fingerprint": profile_hash(document),
    }

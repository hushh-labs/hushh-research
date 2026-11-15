# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Active-model core Vertex qualification for shared Dev and Production lanes."""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from typing import Any

from hushh_mcp.runtime_providers.dependency_health import DEPENDENCY_OK
from hushh_mcp.runtime_settings import managed_ai_settings

CORE_READINESS_CONTRACT_VERSION = 2


async def maybe_probe_core_runtime(
    *,
    one_chat_target: Callable[[], tuple[str, str, Any]],
    probe_adk_response: Callable[[Any, str], Awaitable[None]],
) -> dict[str, object] | None:
    qualification_mode = os.getenv("MANAGED_READINESS_MODE", "full")
    if qualification_mode not in {"core", "full"}:
        raise RuntimeError("Managed readiness qualification mode is invalid")
    environment = os.getenv("ENVIRONMENT", "")
    if qualification_mode != "core" or environment == "uat":
        return None
    if environment not in {"dev", "production"}:
        raise RuntimeError("Managed core environment is invalid")
    project, model, chat_binding = one_chat_target()
    # This is the active chat binding, not a manifest-wide model sweep.
    # A provider error, empty response or deadline cannot qualify the image.
    await probe_adk_response(chat_binding.build_regional_adk_model(model), model)
    return {
        "check": "managed_vertex_runtime",
        "core_contract_version": CORE_READINESS_CONTRACT_VERSION,
        "qualification_mode": "core",
        "environment": environment,
        "provider": "vertex",
        "config_hash": managed_ai_settings().config_hash,
        "ok": True,
        "classification": DEPENDENCY_OK,
        "advisory": False,
        "models": [model],
        "locations": list(chat_binding.locations_for_model(model)),
        "one_chat_project": project,
        "one_chat_probe_ok": True,
        "core_models_exercised": True,
        "candidate_models_exercised": False,
        "secondary_diagnostics": "not_run",
        "one_voice_probe_ok": None,
        "probes": [{"probe": f"one_chat:{model}", "ok": True, "classification": DEPENDENCY_OK}],
    }

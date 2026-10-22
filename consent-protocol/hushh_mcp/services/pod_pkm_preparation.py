"""Request-local Memory genes on the admitted owner's model; no hub persistence."""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from typing import Any

from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
from hushh_mcp.services.pkm_agent_lab_service import PKMAgentLabService


class OwnerPkmPreparation(PKMAgentLabService):
    """Reuse structure/reconciliation policy with an explicit, fenced ADK model."""

    def __init__(
        self, *, model: Any, user_id: str, require_access: Callable[[], Awaitable[None]]
    ) -> None:
        super().__init__()
        self._owner_model = model
        self._owner_id = user_id
        self._require_access = require_access

    async def _run_agent_contract(
        self,
        *,
        manifest: Any,
        prompt: str,
        response_schema: dict[str, Any],
        model_override: str | None = None,
        timeout_seconds: float | None = None,
        execution_trace: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any] | None:
        # Authority failures propagate, including a changed owner AI selection.
        # No property on this path may build the base service's managed client.
        await self._require_access()
        started = time.perf_counter()
        result = None
        failure = ""
        try:
            agent = build_single_turn_agent(
                manifest, output_schema=response_schema, model=self._owner_model
            )
            result = await run_single_turn(
                agent,
                prompt_parts=prompt,
                user_id=self._owner_id,
                consent_token="pod-memory-preparation",  # noqa: S106 - turn-local sentinel
                timeout_seconds=timeout_seconds,
            )
            if hasattr(result, "model_dump"):
                result = result.model_dump(mode="json")
            if not isinstance(result, dict):
                result = None
                failure = "invalid_response"
        except Exception:
            # Provider text and rejected information never enter diagnostics.
            failure = "provider_unavailable"
        await self._require_access()
        if execution_trace is not None:
            execution_trace.append(
                {
                    "agent_id": str(getattr(manifest, "id", "unknown")),
                    "status": "success" if result is not None else failure,
                    "attempts": 1,
                    "latency_ms": round((time.perf_counter() - started) * 1000, 2),
                    "error_type": failure,
                }
            )
        return result

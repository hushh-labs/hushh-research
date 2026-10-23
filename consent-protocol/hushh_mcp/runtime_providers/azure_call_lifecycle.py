"""Content-free Azure call observation and bounded workload authentication."""

from __future__ import annotations

import asyncio
import logging
import time
from contextlib import aclosing
from typing import Any

logger = logging.getLogger("hushh_mcp.runtime_providers.azure_adk")


class AzureAuthenticationError(RuntimeError):
    """Workload authentication failed before model I/O; not a model outage."""


async def acquire_token(token_supplier, counters: dict[str, Any]) -> str:
    auth_started = time.perf_counter()
    try:
        async with asyncio.timeout(5):
            token = await asyncio.to_thread(token_supplier)
    except Exception:
        raise AzureAuthenticationError("Azure workload authentication failed") from None
    finally:
        counters["auth_ms"] = round((time.perf_counter() - auth_started) * 1000)
    if not isinstance(token, str) or not token:
        raise AzureAuthenticationError("Azure managed model token is unavailable")
    return token


async def observe_call(source, model: str, counters: dict[str, Any]):
    started = time.perf_counter()
    outcome, error_kind, status = "cancelled", "none", 0
    try:
        async with aclosing(source) as results:
            async for result in results:
                if counters["first_output_ms"] is None:
                    counters["first_output_ms"] = round((time.perf_counter() - started) * 1000)
                if not result.partial and result.usage_metadata is not None:
                    usage = result.usage_metadata
                    for name in (
                        "prompt_token_count",
                        "candidates_token_count",
                        "total_token_count",
                        "cached_content_token_count",
                        "thoughts_token_count",
                    ):
                        counters[name] = getattr(usage, name, None)
                yield result
        outcome = "completed"
    except Exception as error:
        from openai import APIConnectionError, APITimeoutError

        outcome = "failed"
        candidate = getattr(error, "status_code", None)
        status = candidate if type(candidate) is int and 100 <= candidate <= 599 else 0
        error_kind = (
            "auth"
            if isinstance(error, AzureAuthenticationError) or status in {401, 403}
            else "timeout"
            if isinstance(error, (TimeoutError, APITimeoutError))
            else "connection"
            if isinstance(error, APIConnectionError)
            else "quota"
            if status == 429
            else "server"
            if status >= 500
            else "protocol"
            if isinstance(error, ValueError)
            else "authority"
            if isinstance(error, PermissionError)
            else "other"
        )
        raise
    finally:
        logger.info(
            "azure_model_call_complete provider=azure_openai model=%s outcome=%s "
            "error_kind=%s status=%s auth_ms=%s first_output_ms=%s elapsed_ms=%s "
            "reasoning_effort=%s input_tokens=%s output_tokens=%s cached_tokens=%s "
            "reasoning_tokens=%s total_tokens=%s",
            model,
            outcome,
            error_kind,
            status,
            counters["auth_ms"],
            counters["first_output_ms"],
            round((time.perf_counter() - started) * 1000),
            counters.get("reasoning_effort", "provider_default"),
            counters.get("prompt_token_count"),
            counters.get("candidates_token_count"),
            counters.get("cached_content_token_count"),
            counters.get("thoughts_token_count"),
            counters.get("total_token_count"),
        )

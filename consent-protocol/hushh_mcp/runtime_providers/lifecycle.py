"""Close invocation-owned model resources; never close a shared cached client."""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from typing import Any


async def finish_owned_cleanup(cleanup: Coroutine[Any, Any, None]) -> None:
    """Join owned teardown before returning cancellation; keep no finished task."""
    task = asyncio.create_task(cleanup, name="owned-provider-cleanup")
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
        except Exception:
            break
    if cancelled:
        if not task.cancelled():
            task.exception()
        raise asyncio.CancelledError
    task.result()


async def close_owned_model_client(client: Any) -> None:
    await finish_owned_cleanup(_close_client(client))


async def _close_client(client: Any) -> None:
    from google.genai import Client

    from hushh_mcp.runtime_providers.openai_responses_transport import OpenAIResponsesTransport
    from hushh_mcp.runtime_providers.vertex_failover import VertexRegionalClient

    if isinstance(client, Client):
        try:
            await client.aio.aclose()
        finally:
            client.close()
    elif isinstance(client, (OpenAIResponsesTransport, VertexRegionalClient)):
        await client.aclose()


async def close_owned_adk_model(model: Any) -> None:
    from google.adk.models import Gemini

    # api_client is the pinned SDK's cached_property. Do not instantiate an
    # unused client during teardown, or reach into a shared model's cache.
    if isinstance(model, Gemini) and "api_client" in model.__dict__:
        await close_owned_model_client(model.__dict__.pop("api_client"))

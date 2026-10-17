"""What a fresh client per model call costs inside Azure.

``ProviderAdkModel.generate_content_async`` calls ``self._client()`` on every model
call; for ``user_azure_mi`` that builds a new ``OpenAIResponsesTransport`` and so a new
``AsyncOpenAI`` with its own connection pool. This probe alternates the two shapes so
drift cancels: a fresh transport per request (what the pod does) and one transport
reused across requests. Two request kinds: an unbilled ``GET /openai/v1/models`` and a
minimal billed Responses call (``ping``, 16 output tokens, effort ``none``).

usage: run_conn_probe.py <deployment> <label> <pairs>
"""

from __future__ import annotations

import asyncio
import json
import statistics
import sys
import time

import azure_eval_common as c

DEPLOYMENT, LABEL, PAIRS = sys.argv[1], sys.argv[2], int(sys.argv[3])
OUT = c.out_dir(LABEL)
c.set_topology(DEPLOYMENT)
c.install()

from hushh_mcp.runtime_providers.azure_openai import (  # noqa: E402
    build_owner_azure_transport,
)


def transport():
    started = time.perf_counter()
    built = build_owner_azure_transport(
        runtime_provider="azure_openai", runtime_mode="user_azure_mi"
    )
    return built, (time.perf_counter() - started) * 1000


async def get_models(client) -> float:
    started = time.perf_counter()
    await client.models.list()
    return (time.perf_counter() - started) * 1000


async def ping(client) -> float:
    started = time.perf_counter()
    await client.responses.create(
        model=DEPLOYMENT,
        input="ping",
        max_output_tokens=16,
        reasoning={"effort": "none"},
        store=False,
    )
    return (time.perf_counter() - started) * 1000


async def main() -> dict:
    reused, _ = transport()
    rows = {"fresh_get": [], "reused_get": [], "fresh_ping": [], "reused_ping": [], "build_ms": []}
    await get_models(reused._client)  # warm the reused pool once (not recorded)
    for _ in range(PAIRS):
        fresh, built_ms = transport()
        rows["build_ms"].append(built_ms)
        rows["fresh_get"].append(await get_models(fresh._client))
        rows["reused_get"].append(await get_models(reused._client))
        fresh, _ = transport()
        rows["fresh_ping"].append(await ping(fresh._client))
        rows["reused_ping"].append(await ping(reused._client))
    summary = {
        key: {
            "median": round(statistics.median(v), 1),
            "min": round(min(v), 1),
            "max": round(max(v), 1),
        }
        for key, v in rows.items()
    }
    return {
        **c.run_meta(DEPLOYMENT),
        "pairs": PAIRS,
        "summary": summary,
        "rows": rows,
        "wire": [vars(x) for x in c.USAGE.calls],
    }


result = asyncio.run(main())
(OUT / "conn_probe.json").write_text(json.dumps(result, indent=1, default=str))
print(json.dumps(result["summary"]))

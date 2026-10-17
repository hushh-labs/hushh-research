"""Structured-output validity through the repo's schema-constrained gene runtime.

Uses the real ``one_conversation_title`` gene (``build_single_turn_agent`` +
``run_single_turn``, which json-decodes and pydantic-validates ``ConversationTitles``).
The only change from production is the injected model object: the pod's Azure ADK
model on the Responses transport (``text.format`` json_schema, non-strict).

usage: run_structured.py <deployment> <label> <reps>
"""

from __future__ import annotations

import asyncio
import json
import sys
import time

import azure_eval_common as c

MODEL, LABEL, REPS = sys.argv[1], sys.argv[2], int(sys.argv[3])
OUT = c.out_dir(LABEL)
c.set_topology(MODEL)
c.install()

from hushh_mcp.hushh_adk.manifest import ManifestLoader  # noqa: E402
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn  # noqa: E402
from hushh_mcp.one_adk.conversation_titles import ConversationTitles  # noqa: E402
from hushh_mcp.runtime_providers.azure_openai import build_owner_azure_adk_model  # noqa: E402

model = build_owner_azure_adk_model(
    MODEL, mode="user_azure_mi", provider="azure_openai", api_key=None
)
manifest = ManifestLoader.load(str(c.REPO / "hushh_mcp" / "agents" / "one" / "agent.yaml"))
gene = next(child for child in manifest.subagents if child.id == "one_conversation_title")
OPENINGS = [
    {"ref": "c0", "opening": "can you help me plan a weekend trip to Lisbon with my partner"},
    {"ref": "c1", "opening": "who can see my finance information right now"},
    {"ref": "c2", "opening": "draft an email to my landlord about the broken heater"},
]


async def one() -> dict:
    agent = build_single_turn_agent(gene, output_schema=ConversationTitles, model=model)
    mark = c.USAGE.mark()
    started = time.perf_counter()
    row: dict = {}
    try:
        result = await run_single_turn(
            agent,
            prompt_parts=json.dumps({"conversations": OPENINGS}),
            user_id="structured_eval_fixture",
            consent_token="fixture-only-not-a-token",
            timeout_seconds=60,
        )
        refs = sorted(t.ref for t in result.items) if hasattr(result, "items") else None
        row.update(
            valid=True, refs=refs, refs_match=refs == ["c0", "c1", "c2"], sample=result.model_dump()
        )
    except Exception as exc:
        row.update(valid=False, error=type(exc).__name__, message=str(exc)[:200])
    row["elapsed_ms"] = (time.perf_counter() - started) * 1000
    calls = c.USAGE.since(mark)
    row["wire"] = [vars(x) for x in calls]
    row["cost_usd"] = c.cost_usd(MODEL, calls)
    return row


rows = [asyncio.run(one()) for _ in range(REPS)]
(OUT / "structured.json").write_text(
    json.dumps({**c.run_meta(MODEL), "rows": rows}, indent=1, default=str)
)
print(
    MODEL,
    "valid",
    sum(r["valid"] for r in rows),
    "/",
    len(rows),
    [r.get("error") for r in rows if not r["valid"]][:3],
)

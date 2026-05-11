"""
tests/agents/kai/evals/run_compare.py

Cloud-vs-self-hosted eval comparison for the Kai LLM provider adapter.

Runs the same 3 eval scenarios against a chosen provider (vllm/gemini)
via the consent-scoped dispatch path, captures synthesis outputs and
metrics, and writes a JSON snapshot to:

    tests/agents/kai/evals/snapshots/{provider}_quick.json

Usage:
    KAI_VLLM_BASE_URL=http://localhost:8000/v1 \
    KAI_VLLM_API_KEY=EMPTY \
        python tests/agents/kai/evals/run_compare.py --provider vllm

    GEMINI_API_KEY=AIza... \
        python tests/agents/kai/evals/run_compare.py --provider gemini
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any

import yaml

from hushh_mcp.consent.token import issue_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.operons.kai.providers import (
    CompletionRequest,
    Message,
    Role,
    dispatch,
    load_registry,
)

THIS_DIR = Path(__file__).parent
SCENARIOS_DIR = THIS_DIR / "scenarios"
SNAPSHOTS_DIR = THIS_DIR / "snapshots"
SNAPSHOTS_DIR.mkdir(exist_ok=True)

# 3 quick scenarios: 1 bull, 1 bear, 1 ambiguous.
QUICK_SCENARIOS = [
    "01_bull_megacap_aapl.yaml",
    "07_bear_secular_int.yaml",
    "11_ambiguous_dis.yaml",
]


def load_scenario(name: str) -> dict:
    with (SCENARIOS_DIR / name).open() as f:
        return yaml.safe_load(f)


def scenario_to_prompt(scenario: dict) -> str:
    """Convert a scenario dict to a single user-message prompt."""
    return (
        f"Ticker: {scenario['ticker']}\n"
        f"Bull/bear setup: {scenario.get('description', scenario.get('thesis', ''))}\n\n"
        f"Reply ONLY with JSON of shape:\n"
        '{"decision": "buy"|"sell"|"hold",\n'
        ' "confidence": 0.0-1.0,\n'
        ' "thesis": "one sentence summary",\n'
        ' "key_risk": "one sentence on the main risk"}\n'
    )


def required_scope_for(provider_name: str) -> ConsentScope:
    """Map provider name to its consent scope."""
    return {
        "gemini": ConsentScope.AGENT_KAI_INFERENCE_CLOUD_GEMINI,
        "openai": ConsentScope.AGENT_KAI_INFERENCE_CLOUD_OPENAI,
        "anthropic": ConsentScope.AGENT_KAI_INFERENCE_CLOUD_ANTHROPIC,
        "vllm": ConsentScope.AGENT_KAI_INFERENCE_PRIVATE_SELF_HOSTED,
        "llamacpp": ConsentScope.AGENT_KAI_INFERENCE_PRIVATE_LOCAL,
    }[provider_name]


async def run_one(
    provider_name: str, scenario_name: str, consent_token: str, user_id: str
) -> dict[str, Any]:
    scenario = load_scenario(scenario_name)
    prompt = scenario_to_prompt(scenario)
    req = CompletionRequest(
        prompt=prompt,
        system_instruction=(
            "You are Kai, a privacy-first financial AI. "
            "Reply with concise structured JSON only."
        ),
        max_output_tokens=2000,
        temperature=0.5,
    )
    t0 = time.perf_counter()
    try:
        resp = await dispatch(
            req,
            consent_token=consent_token,
            provider_name=provider_name,
            user_id=user_id,
            agent_id="agent_kai",
        )
        latency_ms = int((time.perf_counter() - t0) * 1000)
        return {
            "scenario": scenario_name,
            "ok": True,
            "latency_ms": latency_ms,
            "provider_used": resp.provider,
            "model_used": resp.model,
            "text": resp.text,
            "usage": dict(resp.usage),
        }
    except Exception as e:
        latency_ms = int((time.perf_counter() - t0) * 1000)
        return {
            "scenario": scenario_name,
            "ok": False,
            "latency_ms": latency_ms,
            "error_class": type(e).__name__,
            "error_msg": str(e)[:300],
        }


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", required=True, choices=["vllm", "gemini"])
    parser.add_argument("--user-id", default="raktim_phase6_compare")
    args = parser.parse_args()

    # Load registry from the YAML config so providers are wired up.
    load_registry()

    # Issue a real consent token scoped to the provider being tested.
    scope = required_scope_for(args.provider)
    token = issue_token(
        user_id=args.user_id,
        agent_id="agent_kai",
        scope=scope,
    )

    print(f"Running 3 quick scenarios against provider={args.provider} ...")
    results = []
    for sname in QUICK_SCENARIOS:
        print(f"  [{sname}] ", end="", flush=True)
        r = await run_one(args.provider, sname, token.token, args.user_id)
        status = "ok" if r["ok"] else f"FAIL ({r.get('error_class')})"
        print(f"{status} in {r['latency_ms']}ms")
        results.append(r)

    snapshot = {
        "provider": args.provider,
        "scenarios_run": len(results),
        "succeeded": sum(1 for r in results if r["ok"]),
        "failed": sum(1 for r in results if not r["ok"]),
        "results": results,
    }
    out_path = SNAPSHOTS_DIR / f"{args.provider}_quick.json"
    with out_path.open("w") as f:
        json.dump(snapshot, f, indent=2)
    print(f"\nWrote snapshot: {out_path.relative_to(Path.cwd())}")
    print(f"Succeeded: {snapshot['succeeded']}/{snapshot['scenarios_run']}")


if __name__ == "__main__":
    asyncio.run(main())

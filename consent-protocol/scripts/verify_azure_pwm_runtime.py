#!/usr/bin/env python3
"""Synthetic Azure PWM readiness probe from the UAT Cloud Run service identity.

Run this in a Cloud Run job with the same service account as the API. It checks
Google metadata -> Entra federation -> both resource-scoped model deployments,
without an owner identity, Bing search, a vault key, or any database write.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

from openai import APITimeoutError, AsyncOpenAI

PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
if str(PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(PROTOCOL_ROOT))

from hushh_mcp.managed_ai_config import load_pwm_policy  # noqa: E402


def _token_provider(*, tenant_id: str, client_id: str):
    # Import the narrow credential leaf without importing One's full app tree.
    path = PROTOCOL_ROOT / "hushh_mcp/one_adk/azure_workload_identity.py"
    spec = importlib.util.spec_from_file_location("pwm_azure_workload_identity", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Azure PWM credential leaf is missing")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.azure_openai_token_provider(tenant_id=tenant_id, client_id=client_id)


def _stage(name: str, result: str, *, started_at: float, attempt: int | None = None) -> None:
    event: dict[str, str | int] = {
        "azure_pwm_runtime_probe_stage": name,
        "result": result,
        "elapsed_ms": int((time.monotonic() - started_at) * 1000),
    }
    if attempt is not None:
        event["attempt"] = attempt
    print(json.dumps(event), flush=True)


async def _probe_phi(config: dict[str, str], token: str) -> None:
    # A cold Global Standard deployment can time out once. Require a real
    # response on a bounded second attempt; a repeated timeout blocks rollout.
    for attempt in (1, 2):
        started_at = time.monotonic()
        _stage("phi", "start", started_at=started_at, attempt=attempt)
        try:
            async with AsyncOpenAI(
                api_key=token, base_url=config["phi_endpoint"], timeout=45.0, max_retries=0
            ) as client:
                result = await client.chat.completions.create(
                    model=config["phi_deployment"],
                    messages=[{"role": "user", "content": "Reply with the word OK."}],
                    max_tokens=64,
                )
        except APITimeoutError:
            _stage("phi", "timeout", started_at=started_at, attempt=attempt)
            if attempt == 2:
                raise
            continue
        if not result.choices or not (result.choices[0].message.content or "").strip():
            raise RuntimeError("Azure Phi model returned no text")
        _stage("phi", "ok", started_at=started_at, attempt=attempt)
        return


async def probe() -> None:
    if os.environ.get("ENVIRONMENT") != "uat":
        raise RuntimeError("Azure PWM runtime probe is UAT-only")
    policy = load_pwm_policy(environment="uat")
    if policy["provider"] != "azure_openai_web_search":
        raise RuntimeError("UAT Azure PWM provider is not selected")
    config = policy["azure"]
    started_at = time.monotonic()
    _stage("federation", "start", started_at=started_at)
    supplier = _token_provider(tenant_id=config["tenant_id"], client_id=config["client_id"])
    token = await asyncio.to_thread(supplier)
    if not token:
        raise RuntimeError("Azure federated bearer token is empty")
    _stage("federation", "ok", started_at=started_at)

    started_at = time.monotonic()
    _stage("primary", "start", started_at=started_at)
    async with AsyncOpenAI(
        api_key=token, base_url=config["primary_endpoint"], timeout=60.0, max_retries=0
    ) as client:
        result = await client.responses.create(
            model=config["primary_deployment"],
            input="Reply with the word OK.",
            max_output_tokens=512,
        )
        if result.status != "completed" or not result.output_text.strip():
            raise RuntimeError("Azure primary model returned no completed text")
    _stage("primary", "ok", started_at=started_at)

    await _probe_phi(config, token)


def main() -> int:
    try:
        # Federation + a 60s primary call + two 45s Phi attempts fit within
        # this bound, with 40s left before the Cloud Run task timeout.
        asyncio.run(asyncio.wait_for(probe(), timeout=200))
    except Exception as error:  # noqa: BLE001 - print only the error class, never a token
        print(
            json.dumps({"azure_pwm_runtime_probe_result": "failed", "error": type(error).__name__})
        )
        return 1
    print(json.dumps({"azure_pwm_runtime_probe_result": "ok"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

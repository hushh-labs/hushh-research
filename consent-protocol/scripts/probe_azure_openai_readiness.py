#!/usr/bin/env python3
"""Opt-in synthetic readiness check using the trusted PWM Azure binding.

ENVIRONMENT=uat PYTHONPATH=. python scripts/probe_azure_openai_readiness.py --live

One request checks authentication, HTTP 200 and a completed exact-nonce JSON
response. It does not prove agent semantics, tool compatibility or permission
to process private information. No token, prompt or response text is reported.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import io
import json
import logging
import math
import re
import secrets
import sys
import time
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from openai import AsyncOpenAI  # noqa: E402

from hushh_mcp.managed_ai_config import load_pwm_policy  # noqa: E402

DEFAULT_TIMEOUT_SECONDS = 30.0
MAX_OUTPUT_TOKENS = 256


class ReadinessConfigurationError(ValueError):
    """The active trusted profile does not select Azure."""


class ReadinessResponseError(ValueError):
    """The provider response did not satisfy the synthetic readiness contract."""


def azure_openai_token_provider(*, tenant_id: str, client_id: str):
    """Load the existing credential leaf without constructing One's app tree."""
    path = ROOT / "hushh_mcp/one_adk/azure_workload_identity.py"
    spec = importlib.util.spec_from_file_location("readiness_azure_workload_identity", path)
    if spec is None or spec.loader is None:
        raise ReadinessConfigurationError("Azure credential leaf is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.azure_openai_token_provider(tenant_id=tenant_id, client_id=client_id)


def _status_code(value) -> int | None:
    return value if type(value) is int and 100 <= value <= 599 else None


async def run_probe(*, timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS) -> dict:
    """Make at most one model request; all results contain closed metadata only."""
    started = time.perf_counter()
    report = {
        "status": "unavailable",
        "http_status": None,
        "latency_ms": 0,
        "deployment": None,
        "error_class": None,
    }
    try:
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or not math.isfinite(timeout_seconds)
            or not 0 < timeout_seconds <= DEFAULT_TIMEOUT_SECONDS
        ):
            raise ValueError("invalid readiness timeout")
        # Endpoint, deployment and federated identity are operator-owned. This
        # script deliberately offers no override for any of these values.
        policy = load_pwm_policy()
        if policy["provider"] != "azure_openai_web_search":
            raise ReadinessConfigurationError("Azure is not selected")
        config = policy["azure"]
        report["deployment"] = config["primary_deployment"]
        nonce = secrets.token_hex(16)
        async with asyncio.timeout(timeout_seconds):
            supplier = azure_openai_token_provider(
                tenant_id=config["tenant_id"], client_id=config["client_id"]
            )
            token = await asyncio.to_thread(supplier)
            if not isinstance(token, str) or not token:
                raise ReadinessConfigurationError("Azure token is unavailable")
            async with AsyncOpenAI(
                api_key=token,
                base_url=config["primary_endpoint"],
                timeout=timeout_seconds,
                max_retries=0,
            ) as client:
                raw = await client.responses.with_raw_response.create(
                    model=config["primary_deployment"],
                    instructions="Return only the supplied nonce in the required JSON object.",
                    input=json.dumps({"nonce": nonce}),
                    max_output_tokens=MAX_OUTPUT_TOKENS,
                    store=False,
                    reasoning={"effort": "low"},
                    text={
                        "format": {
                            "type": "json_schema",
                            "name": "synthetic_readiness",
                            "strict": True,
                            "schema": {
                                "type": "object",
                                "properties": {"nonce": {"type": "string", "enum": [nonce]}},
                                "required": ["nonce"],
                                "additionalProperties": False,
                            },
                        }
                    },
                )
                report["http_status"] = _status_code(raw.status_code)
                if raw.status_code != 200:
                    raise ReadinessResponseError("HTTP 200 is required")
                response = raw.parse()
                if (
                    response.status != "completed"
                    or response.incomplete_details is not None
                    or response.error is not None
                    or any(
                        part.type == "refusal"
                        for item in response.output
                        if item.type == "message"
                        for part in item.content
                    )
                ):
                    raise ReadinessResponseError("completed output is required")
                text = response.output_text
                if (
                    not isinstance(text, str)
                    or len(text) > 4096
                    or json.loads(text) != {"nonce": nonce}
                ):
                    raise ReadinessResponseError("exact nonce output is required")
                report["status"] = "ready"
    except Exception as error:
        name = type(error).__name__
        report["error_class"] = (
            name if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,95}", name) else "UnknownException"
        )
        if report["http_status"] is None:
            report["http_status"] = _status_code(getattr(error, "status_code", None))
    report["latency_ms"] = round((time.perf_counter() - started) * 1000)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Authorize the one synthetic request")
    parser.add_argument("--timeout-seconds", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    args = parser.parse_args(argv)
    if not args.live:
        print(
            json.dumps(
                {
                    "status": "not_run",
                    "http_status": None,
                    "latency_ms": 0,
                    "deployment": None,
                    "error_class": None,
                }
            )
        )
        return 2
    # SDK diagnostics are not probe artifacts. Retain only the closed report,
    # even if an ambient debug setting enables provider logging or warnings.
    previous_logging = logging.root.manager.disable
    try:
        logging.disable(logging.CRITICAL)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            report = asyncio.run(run_probe(timeout_seconds=args.timeout_seconds))
    finally:
        logging.disable(previous_logging)
    print(json.dumps(report, sort_keys=True))
    return 0 if report["status"] == "ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())

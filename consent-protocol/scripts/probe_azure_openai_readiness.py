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

from hushh_mcp.managed_ai_config import load_managed_runtime_policy, load_pwm_policy  # noqa: E402
from hushh_mcp.runtime_providers.dependency_health import (  # noqa: E402
    APPLICATION_BROKEN,
    CANDIDATE_MISCONFIGURED,
    DEPENDENCY_OK,
    PROVIDER_UNAVAILABLE,
    classify_provider_error,
    summarize,
)
from scripts.capability_probe_failure import FAILURE_REASONS  # noqa: E402

DEFAULT_TIMEOUT_SECONDS = 30.0
MAX_OUTPUT_TOKENS = 256
STAGES = {"configuration", "federation", "primary_http", "response_validation"}
TIMING_PHASES = ("credential_setup", "token_acquisition", "primary_http", "response_validation")


def valid_failure_reason(capability: str, reason: object) -> bool:
    return (
        isinstance(reason, str)
        and reason in FAILURE_REASONS
        and (
            reason == "unlisted"
            or capability == "live_audio"
            and reason.startswith("live.")
            or capability == "one_text_root"
            and reason.startswith("root.")
            or capability in {"public_search", "compact_public_search"}
            and reason.startswith("search.")
        )
    )


class ReadinessConfigurationError(ValueError):
    """The active trusted profile does not select Azure."""


class ReadinessResponseError(ValueError):
    """The provider response did not satisfy the synthetic readiness contract."""


class ReadinessProbeError(RuntimeError):
    """Carry only the leaf's sanitized failure through the application probe."""

    def __init__(self, event: dict):
        super().__init__("Azure primary readiness check failed")
        self.diagnostic = {
            key: event[key]
            for key in ("classification", "error_type", "failure_stage", "elapsed_ms", "attempt")
        }
        if "capability_failures" in event:
            self.diagnostic["capability_failures"] = event["capability_failures"]
        for key in ("phase_ms", "deadline_expired"):
            if key in event:
                self.diagnostic[key] = event[key]


def failure_fields(error: Exception) -> dict:
    if isinstance(error, ReadinessProbeError):
        return error.diagnostic
    return {"classification": classify_provider_error(error), "error_type": type(error).__name__}


def capability_failure_event(report: dict) -> dict:
    """Retain closed child failures without changing the strict readiness result."""
    policy = load_managed_runtime_policy()
    rows = report.get("capabilities")
    if (
        policy is None
        or policy["provider"] != "azure_openai"
        or report.get("provider") != policy["provider"]
        or report.get("policy_generation") != policy["generation"]
        or report.get("ready") is not False
        or not isinstance(rows, dict)
        or set(rows) != set(policy["required_capabilities"])
    ):
        raise ReadinessResponseError("Invalid managed capability failure inventory")
    failures = []
    for name, row in rows.items():
        if (
            not isinstance(row, dict)
            or type(row.get("ready")) is not bool
            or type(row.get("elapsed_ms")) is not int
            or not 0 <= row["elapsed_ms"] <= 420_000
        ):
            raise ReadinessResponseError("Invalid managed capability result")
        if row["ready"]:
            continue
        classification, error_type = row.get("classification"), row.get("error_type")
        if (
            classification
            not in {PROVIDER_UNAVAILABLE, CANDIDATE_MISCONFIGURED, APPLICATION_BROKEN}
            or not isinstance(error_type, str)
            or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,95}", error_type)
            or ("failure_reason" in row and not valid_failure_reason(name, row["failure_reason"]))
        ):
            raise ReadinessResponseError("Invalid managed capability failure metadata")
        failure = {
            "capability": name,
            "classification": classification,
            "error_type": error_type,
            "elapsed_ms": row["elapsed_ms"],
        }
        if "failure_reason" in row:
            failure["failure_reason"] = row["failure_reason"]
        failures.append(failure)
    if not failures:
        raise ReadinessResponseError("Managed capability failure has no failed child")
    classification = summarize([row["classification"] for row in failures])
    decisive = [row for row in failures if row["classification"] == classification]
    representative = next(
        (
            row
            for row in decisive
            if classification == PROVIDER_UNAVAILABLE
            and row["error_type"] in {"TimeoutError", "APITimeoutError"}
        ),
        decisive[0],
    )
    return {
        "classification": classification,
        "error_type": representative["error_type"],
        "failure_stage": representative["capability"],
        "elapsed_ms": representative["elapsed_ms"],
        "attempt": 1,
        "capability_failures": failures,
    }


def readiness_event(report: dict, deployment: str) -> dict:
    """Keep the existing strict success predicate and bounded failure provenance."""
    ready = (
        report["status"] == "ready"
        and report["http_status"] == 200
        and report["deployment"] == deployment
    )
    event = {
        "azure_pwm_runtime_probe_stage": "primary_http",
        "result": "ok" if ready else "failed",
        "http_status": report["http_status"],
        "deployment": deployment,
        "elapsed_ms": report["latency_ms"],
        "attempt": 1,
    }
    for key in ("phase_ms", "deadline_expired"):
        if key in report:
            event[key] = report[key]
    if not ready:
        event.update(
            classification=report["classification"]
            if report["status"] != "ready"
            else CANDIDATE_MISCONFIGURED,
            error_type=report["error_class"] or "ReadinessConfigurationError",
            failure_stage=report["stage"]
            if report["status"] != "ready" and report["stage"] in STAGES
            else "configuration",
        )
    return event


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


def _require_completed_nonce(raw, nonce: str) -> None:
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
    if not isinstance(text, str) or len(text) > 4096 or json.loads(text) != {"nonce": nonce}:
        raise ReadinessResponseError("exact nonce output is required")


async def _request_nonce(client: AsyncOpenAI, deployment: str, nonce: str):
    return await client.responses.with_raw_response.create(
        model=deployment,
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


async def run_probe(*, timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS) -> dict:
    """Make at most one model request; all results contain closed metadata only."""
    started = time.perf_counter()
    report = {
        "status": "unavailable",
        "http_status": None,
        "latency_ms": 0,
        "deployment": None,
        "error_class": None,
        "stage": "configuration",
        "classification": CANDIDATE_MISCONFIGURED,
        "phase_ms": dict.fromkeys(TIMING_PHASES, 0),
        "deadline_expired": False,
    }
    phase, phase_started = None, started
    deadline = None

    def begin_phase(name: str | None) -> None:
        nonlocal phase, phase_started
        now = time.perf_counter()
        if phase is not None:
            report["phase_ms"][phase] = round((now - phase_started) * 1000)
        phase, phase_started = name, now

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
        if policy["provider"] not in {"azure_openai_web_search", "azure_openai_tavily"}:
            raise ReadinessConfigurationError("Azure is not selected")
        config = policy["azure"]
        report["deployment"] = config["primary_deployment"]
        nonce = secrets.token_hex(16)
        async with asyncio.timeout(timeout_seconds) as deadline:
            report["stage"] = "federation"
            begin_phase("credential_setup")
            # Import and credential construction can also block; keep the loop
            # responsive so the shared deadline can prevent a late model call.
            supplier = await asyncio.to_thread(
                azure_openai_token_provider,
                tenant_id=config["tenant_id"],
                client_id=config["client_id"],
            )
            begin_phase("token_acquisition")
            token = await asyncio.to_thread(supplier)
            if not isinstance(token, str) or not token:
                raise ReadinessConfigurationError("Azure token is unavailable")
            report["stage"] = "primary_http"
            begin_phase("primary_http")
            async with AsyncOpenAI(
                api_key=token,
                base_url=config["primary_endpoint"],
                timeout=timeout_seconds,
                max_retries=0,
            ) as client:
                raw = await _request_nonce(client, config["primary_deployment"], nonce)
                report["http_status"] = _status_code(raw.status_code)
                report["stage"] = "response_validation"
                begin_phase("response_validation")
                _require_completed_nonce(raw, nonce)
        report["status"] = "ready"
        report["classification"] = DEPENDENCY_OK
    except Exception as error:
        name = type(error).__name__
        report["error_class"] = (
            name if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,95}", name) else "UnknownException"
        )
        report["classification"] = classify_provider_error(error)
        if report["http_status"] is None:
            report["http_status"] = _status_code(getattr(error, "status_code", None))
    finally:
        begin_phase(None)
        report["deadline_expired"] = deadline is not None and deadline.expired()
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

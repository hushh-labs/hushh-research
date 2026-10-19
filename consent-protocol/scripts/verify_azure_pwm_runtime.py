#!/usr/bin/env python3
"""Synthetic Azure PWM readiness probe from the UAT Cloud Run service identity.

Run this in a Cloud Run job with the same service account as the API. It checks
Google metadata -> Entra federation -> the primary GPT-5 mini deployment,
without an owner identity, Bing search, a vault key, or any database write.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import secrets
import sys
import time
from collections.abc import Callable
from pathlib import Path

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


_ATTRIBUTION_CASES = (
    (
        "repository",
        "Portfolio: Selected work: Example repository.",
        "The person created and solely owns Example repository.",
        False,
    ),
    (
        "degree",
        "Portfolio: Education: B.E. Information Technology.",
        "The person completed that degree.",
        False,
    ),
    (
        "merge",
        "PR 7 metadata: author alex; status merged; merger not supplied.",
        "Alex personally merged PR 7.",
        False,
    ),
    (
        "namesake",
        "A school record names Alex. The supplied owner is Alex Example; no linking record exists.",
        "That school record belongs to the supplied owner.",
        False,
    ),
    (
        "metric",
        "The portfolio author reports 100 users, without independent measurement.",
        "The portfolio reports 100 users.",
        True,
    ),
    (
        "authorship",
        "PR 7 metadata: author alex; status merged; merger not supplied.",
        "The alex account authored PR 7, which has merged status.",
        True,
    ),
)


def _initialize_synthetic_runtime() -> None:
    """Satisfy eager runtime imports without any application's authority or keys.

    The candidate job clears all secrets. These fresh values exist only in this
    standalone process; they cannot validate app tokens or decrypt owner records.
    The probe calls only the model gateway and never mounts routes or opens stores.
    """
    os.environ["APP_SIGNING_KEY"] = secrets.token_hex(32)
    os.environ["VAULT_DATA_KEY"] = secrets.token_hex(32)


def _production_contract_examples() -> tuple[dict, dict]:
    """Use real contracts with fictional no-search values in the readiness call."""
    from hushh_mcp.one_adk.world_model_azure import _FINDING_SCHEMA
    from hushh_mcp.one_adk.world_model_contracts import (
        TOPICS,
        IdentityAssessment,
        QueryPlan,
        WorldModelReport,
    )

    identity = {
        "state": "no_match",
        "reason": "Synthetic schema check; no public search was performed.",
        "probability": None,
        "selected_candidate_id": None,
        "supporting_anchor_ids": [],
        "next_step": "finish",
    }
    values = {
        "assessment": {"candidates": [], "anchors": [], "identity": identity},
        "finding": {"skip": True},
        "report": {
            "match_status": "no_match",
            "name": "Synthetic Example",
            "summary": "Synthetic schema check; no public search was performed.",
            "sections": [],
            "identity": identity,
            "coverage": [
                {
                    "topic": topic,
                    "status": "not_attempted",
                    "attempt_ids": [],
                    "explanation": "No public search was performed.",
                }
                for topic in TOPICS
            ],
            "gaps": [],
        },
        "planner": {"action": "finish", "plan": None},
    }
    schemas = {
        "assessment": IdentityAssessment.model_json_schema(),
        "finding": _FINDING_SCHEMA,
        "report": WorldModelReport.model_json_schema(),
        "planner": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["search", "finish"]},
                "plan": {"anyOf": [QueryPlan.model_json_schema(), {"type": "null"}]},
            },
            "required": ["action", "plan"],
            "additionalProperties": False,
        },
    }
    return values, schemas


async def _probe_primary(config: dict[str, str], supplier: Callable[[], str]) -> None:
    """Exercise the real gateway/schema and authored attribution behavior, not a ping."""
    from hushh_mcp.one_adk.world_model import policy_fingerprint
    from hushh_mcp.one_adk.world_model_azure import AzurePwmGateway

    examples, schemas = _production_contract_examples()
    gateway = AzurePwmGateway(
        primary_endpoint=config["primary_endpoint"],
        primary_deployment=config["primary_deployment"],
        primary_token_supplier=supplier,
    )
    result = await gateway.structured(
        purpose="source_attribution_evaluation",
        instruction=(
            "Evaluate the supplied fictional public-record examples without retrieval. "
            "For each proposed statement, decide whether that exact statement is "
            "supported by its excerpt under the shared source and identity rules. "
            "Use false for unsupported attribution, completion, ownership or identity; "
            "use true for accurately attributed self-reports and explicit metadata. "
            "Return each case exactly once. Copy the supplied production_contract_examples "
            "into the corresponding assessment, finding, report and planner fields exactly. "
            "They are fictional schema smoke values, not research findings. "
            "This is a synthetic regression evaluation."
        ),
        payload={
            "cases": [
                {"case_id": key, "excerpt": excerpt, "statement": statement}
                for key, excerpt, statement, _expected in _ATTRIBUTION_CASES
            ],
            "production_contract_examples": examples,
        },
        schema={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "decisions": {
                    "type": "array",
                    "minItems": len(_ATTRIBUTION_CASES),
                    "maxItems": len(_ATTRIBUTION_CASES),
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "case_id": {
                                "type": "string",
                                "enum": [r[0] for r in _ATTRIBUTION_CASES],
                            },
                            "supported": {"type": "boolean"},
                        },
                        "required": ["case_id", "supported"],
                    },
                },
                **schemas,
            },
            "required": ["decisions", *schemas],
        },
        max_output_tokens=6000,
    )
    rows = result.get("decisions")
    expected = {key: supported for key, _, _, supported in _ATTRIBUTION_CASES}
    if (
        not isinstance(rows, list)
        or len(rows) != len(expected)
        or any(not isinstance(row, dict) or type(row.get("supported")) is not bool for row in rows)
        or {row.get("case_id"): row["supported"] for row in rows} != expected
    ):
        raise RuntimeError("Azure source attribution evaluation failed")
    from hushh_mcp.one_adk.world_model_contracts import IdentityAssessment, WorldModelReport

    assessment = IdentityAssessment.model_validate(result.get("assessment")).validate_evidence(
        identity={}, source_refs=set()
    )
    WorldModelReport.model_validate(result.get("report")).validate_receipts(assessment, {}, set())
    if any(result.get(key) != value for key, value in examples.items()):
        raise RuntimeError("Azure production contract evaluation failed")
    print(
        json.dumps(
            {
                "azure_pwm_production_contracts": len(schemas),
                "azure_pwm_attribution_cases": len(expected),
                "policy_sha256": policy_fingerprint(),
                "deployment": config["primary_deployment"],
            }
        ),
        flush=True,
    )


async def probe() -> None:
    if os.environ.get("ENVIRONMENT") != "uat":
        raise RuntimeError("Azure PWM runtime probe is UAT-only")
    _initialize_synthetic_runtime()
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
    await _probe_primary(config, lambda: token)
    _stage("primary", "ok", started_at=started_at)


def main() -> int:
    try:
        # The gateway makes one bounded primary call; no search is retried.
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

#!/usr/bin/env python3
"""Synthetic Azure PWM readiness probe from the UAT Cloud Run service identity.

Run this in a Cloud Run job with the same service account as the API. It checks
Google metadata -> Entra federation -> the primary GPT-5 mini deployment,
without an owner identity, Bing search, a vault key, or any database write.
"""

from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
import logging
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
from mcp_modules.log_redaction import install_sensitive_log_filter  # noqa: E402
from scripts.probe_azure_openai_readiness import (  # noqa: E402
    ReadinessProbeError,
    capability_failure_event,
    failure_fields,
    readiness_event,
    run_probe,
)

# Content-free call lines only: timings, token counts and retry codes. Every
# other logger stays at WARNING, so library request lines never reach the logs.
CALL_TELEMETRY_LOGGERS = (
    "hushh_mcp.runtime_providers.azure_adk",
    "hushh_mcp.services.drive_suggestion_service",
)


def enable_call_telemetry() -> None:
    """Emit exam call telemetry on stdout through the runtime log redactor."""
    logging.basicConfig(stream=sys.stdout, level=logging.WARNING, format="%(name)s %(message)s")
    install_sensitive_log_filter()
    for name in CALL_TELEMETRY_LOGGERS:
        logging.getLogger(name).setLevel(logging.INFO)


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
        "owner_declaration_source",
        "Owner-confirmed lead: Alex authored LumenForge Transit Atlas. No public sources were received.",
        "Independent public sources corroborate Alex's authorship.",
        False,
    ),
    (
        "owner_declaration_identity",
        "Owner-confirmed lead: Alex works on LumenForge. A same-name public profile mentions LumenForge, without any exact contact or explicit account link.",
        "The public profile is verified to belong to the owner.",
        False,
    ),
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
    # Strict UAT imports now verify an enabled audit signer. Qualify against a
    # fresh process-only signer rather than borrowing application custody or
    # disabling that startup check. No receipts or stores are opened by this probe.
    os.environ["CONSENT_AUDIT_SIGNING_ALG"] = "ed25519"
    os.environ["CONSENT_AUDIT_ED25519_PRIVATE_KEY"] = base64.b64encode(
        secrets.token_bytes(32)
    ).decode("ascii")
    os.environ["CONSENT_AUDIT_ED25519_KID"] = "synthetic-readiness"
    os.environ["CONSENT_AUDIT_ED25519_PUBLIC_KEYS"] = ""


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


class AzurePwmTrustError(RuntimeError):
    """A received model answer violated an authored attribution/trust case."""


def _failure(
    check: str, fields: list[str], *, planner_conditions: dict[str, bool] | None = None
) -> None:
    """Emit authored names and booleans only; suppress model and provider text."""
    event: dict[str, object] = {"azure_pwm_probe_failure": check, "failed_fields": fields}
    if planner_conditions is not None:
        event["planner_conditions"] = planner_conditions
    print(json.dumps(event), flush=True)
    raise AzurePwmTrustError(f"Azure {check} evaluation failed")


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
            "Evaluate each case independently using only its own excerpt. Support for "
            "a statement about a source or account does not establish linkage to the owner. "
            "Use false for unsupported attribution, completion, ownership or identity; "
            "use true for accurately attributed self-reports and explicit metadata. "
            "Return each case exactly once. The production_contract_examples are a separate "
            "zero-search schema exercise; their identity and evidence state must not "
            "determine any case's supported decision. Copy those examples "
            "into the corresponding assessment, finding, report and planner fields. "
            "Preserve their no-search decisions and empty evidence; prose may be paraphrased. "
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
    expected_count = _validate_attribution_decisions(result)
    from hushh_mcp.one_adk.world_model_contracts import IdentityAssessment, WorldModelReport

    assessment = IdentityAssessment.model_validate(result.get("assessment")).validate_evidence(
        identity={}, source_refs=set()
    )
    report = WorldModelReport.model_validate(result.get("report"))
    # Inspect before receipt validation normalizes attempt_ids from the empty ledger.
    checks = {
        "assessment": (
            not assessment.candidates
            and not assessment.anchors
            and assessment.identity.state == "no_match"
            and assessment.identity.selected_candidate_id is None
            and not assessment.identity.supporting_anchor_ids
            and assessment.identity.next_step == "finish"
        ),
        "finding": result.get("finding") == {"skip": True},
        "planner": result.get("planner") == {"action": "finish", "plan": None},
        "report": (
            report.match_status == "no_match"
            and not report.sections
            and all(
                row.status == "not_attempted" and not row.attempt_ids for row in report.coverage
            )
        ),
    }
    if not all(checks.values()):
        _failure("production contract", [key for key, passed in checks.items() if not passed])
    report.validate_receipts(assessment, {}, set())
    await _probe_confirmed_guidance(gateway)
    print(
        json.dumps(
            {
                "azure_pwm_confirmed_guidance": 2,
                "azure_pwm_production_contracts": len(schemas),
                "azure_pwm_attribution_cases": expected_count,
                "policy_sha256": policy_fingerprint(),
                "deployment": config["primary_deployment"],
            }
        ),
        flush=True,
    )


def _validate_attribution_decisions(result):
    rows = result.get("decisions")
    expected = {key: supported for key, _, _, supported in _ATTRIBUTION_CASES}
    valid_rows = isinstance(rows, list) and all(
        isinstance(row, dict)
        and isinstance(row.get("case_id"), str)
        and type(row.get("supported")) is bool
        for row in rows
    )
    observed = {row["case_id"]: row["supported"] for row in rows} if valid_rows else {}
    if not valid_rows or len(rows) != len(expected) or observed != expected:
        # Only authored identifiers leave this process, never model text or unknown IDs.
        _failure(
            "source attribution", [key for key in expected if observed.get(key) != expected[key]]
        )
    return len(expected)


async def _probe_confirmed_guidance(gateway) -> None:
    """Actual planner/query inference with fictional leads; no search or owner state."""
    from hushh_mcp.one_adk.tavily_search import plan_public_search_query
    from hushh_mcp.one_adk.world_model_azure import (
        _planner_choice,
        _planner_history,
        _planner_schema,
    )
    from hushh_mcp.one_adk.world_model_contracts import TOPICS

    identity = {"full_name": "Alex Example", "email": "alex@example.test", "phone_number": None}
    leads = ["I authored the fictional LumenForge Transit Atlas paper."]
    work = {
        "sources": {},
        "attempts": {},
        "assessment": {
            "candidates": [],
            "anchors": [],
            "identity": {
                "state": "no_match",
                "reason": "Fictional seed search received no public sources.",
                "probability": None,
                "selected_candidate_id": None,
                "supporting_anchor_ids": [],
                "next_step": "search",
            },
        },
    }
    choice = await gateway.plan(
        {
            "available_seed_fields": ["full_name", "email"],
            "research_history": _planner_history(work),
            "query_plan_schema": _planner_schema(identity, None),
            "topics": TOPICS,
            "identity_phase": True,
            "coverage_allowed": False,
            "owner_linkage_unverified": True,
            "searches_remaining": 7,
            "owner_confirmed_research_leads": leads,
        }
    )
    plan = _planner_choice(choice, identity=identity, assessment=None)
    planner_conditions = {
        "search_plan": plan is not None,
        "identity_purpose": plan is not None and plan.purpose == "identity",
        "no_anchors": plan is not None and not plan.anchor_ids,
        "no_candidate": plan is not None and not plan.candidate_id,
        "publications": plan is not None and "publications" in plan.topics,
    }
    if not all(planner_conditions.values()):
        _failure(
            "confirmed research guidance", ["planner_lead"], planner_conditions=planner_conditions
        )
    query = await plan_public_search_query(
        {
            "exact_owner_fields": {"full_name": identity["full_name"]},
            "evidenced_anchors": [],
            "received_sources": [],
            "research_question": "Find original public records of authored work.",
            "owner_confirmed_research_leads": leads,
        },
        gateway.structured,
    )
    if (
        "lumenforge" not in query.lower()
        or "alex" not in query.lower()
        or "example" not in query.lower()
    ):
        _failure("confirmed research guidance", ["query_lead"])


async def _probe_managed_text() -> None:
    from scripts.probe_drive_activity_planner import ActivityPlannerContractError
    from scripts.probe_managed_text import probe_managed_text

    try:
        receipt = await probe_managed_text("azure_openai")
    except ActivityPlannerContractError as error:
        # The terminal verdict must retain semantic failure even when its
        # earlier fixed-reason log has not reached Cloud Logging yet.
        raise AzurePwmTrustError("Drive activity planner contract failed") from error
    print(json.dumps({"drive_activity_planner_probe": receipt["activity_planner"]}), flush=True)
    print(json.dumps({"managed_text_provider_probe": receipt}), flush=True)
    print(
        json.dumps({"azure_managed_text_contract": "ok", "scopes": len(receipt["scopes"])}),
        flush=True,
    )


async def probe() -> None:
    if os.environ.get("ENVIRONMENT") != "uat":
        raise RuntimeError("Azure PWM runtime probe is UAT-only")
    _initialize_synthetic_runtime()
    policy = load_pwm_policy(environment="uat")
    if policy["provider"] not in {"azure_openai_web_search", "azure_openai_tavily"}:
        raise RuntimeError("UAT Azure PWM provider is not selected")
    config = policy["azure"]
    readiness = await run_probe()
    event = readiness_event(readiness, config["primary_deployment"])
    print(json.dumps(event), flush=True)
    if event["result"] != "ok":
        raise ReadinessProbeError(event)
    if policy["provider"] == "azure_openai_tavily":
        from hushh_mcp.one_adk.tavily_search import extract_tavily_receipts, search_tavily

        search_started = time.monotonic()
        receipt = extract_tavily_receipts(await search_tavily("Tavily Search documentation"))
        if not receipt.observed or not receipt.sources:
            raise RuntimeError("Tavily search readiness requires received sources")
        _stage("tavily_search", "ok", started_at=search_started)
    await _probe_managed_text()
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
    from scripts.probe_managed_capabilities import probe_managed_capabilities

    capabilities = await probe_managed_capabilities("azure_openai")
    if not capabilities["ready"]:
        raise ReadinessProbeError(capability_failure_event(capabilities))


def main() -> int:
    try:
        # One strict HTTP-200 readiness call precedes the bounded attribution
        # call. Neither performs search or sends owner information.
        asyncio.run(asyncio.wait_for(probe(), timeout=360))
    except Exception as error:  # noqa: BLE001 - print only the error class, never a token
        print(
            json.dumps(
                {
                    "azure_pwm_runtime_probe_result": "failed",
                    **failure_fields(error),
                    "pwm_trust_failure": isinstance(error, AzurePwmTrustError),
                }
            ),
            flush=True,
        )
        return 1
    print(json.dumps({"azure_pwm_runtime_probe_result": "ok"}))
    return 0


if __name__ == "__main__":
    enable_call_telemetry()
    sys.exit(main())

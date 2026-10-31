#!/usr/bin/env python3
"""Run one live readiness-exam case with Main's grader under the probe-only identity.

The trusted orchestrator (readiness_exam.py) spliced the PR's anchored text into
Main's checkout before starting this process. Nothing here reads PR input,
GitHub credentials or owner information; only fixed diagnostics are printed.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import io
import json
import sys
import time
from pathlib import Path

PROTOCOL = Path(__file__).resolve().parents[2] / "consent-protocol"
if str(PROTOCOL) not in sys.path:
    sys.path.insert(0, str(PROTOCOL))

PLANNER_STAGE = "managed_text.activity_planner"
CASE_DEADLINE_SECONDS = 200


class UnsupportedLiveStage(ValueError):
    """The manifest marks a case live but no pre-merge driver exists for its stage."""


class ProbeIdentityError(RuntimeError):
    """The probe-only identity could not be federated; never the PR's fault."""


async def _token(supplier) -> str:
    try:
        token = await asyncio.to_thread(supplier)
    except Exception as error:  # noqa: BLE001 - classified, never printed
        raise ProbeIdentityError("Probe-only Azure federation failed") from error
    if not token:
        raise ProbeIdentityError("Probe-only Azure federation returned no token")
    return token


async def _run(case: dict) -> None:
    """Dispatch the manifest case to Main's existing probe; never a second grader.

    A timeout, 429 or 5xx gets the one repeat the UAT exam gives its stage, through
    the same helper; a semantic, trust or configuration failure never repeats.
    """
    from hushh_mcp.managed_ai_config import load_managed_azure_account, load_pwm_policy
    from hushh_mcp.one_adk.azure_workload_identity import github_actions_token_provider
    from scripts.capability_check import repeat_stage_once

    account = load_managed_azure_account()
    token = await _token(
        github_actions_token_provider(
            tenant_id=account["tenant_id"], client_id=account["readiness_exam_client_id"]
        )
    )
    if case["stage"] == PLANNER_STAGE:
        from scripts.probe_drive_activity_planner import probe_drive_activity_planner

        await repeat_stage_once(
            case["id"],
            lambda: probe_drive_activity_planner(
                "azure_openai", case_ids=[case["id"]], token_supplier=lambda: token
            ),
        )
        return
    if case["id"] == "pwm.confirmed_guidance":
        from hushh_mcp.one_adk.world_model_azure import AzurePwmGateway
        from scripts.verify_azure_pwm_runtime import _probe_confirmed_guidance

        config = load_pwm_policy(environment="uat", provider="azure_openai")["azure"]
        await repeat_stage_once(
            case["id"],
            lambda: _probe_confirmed_guidance(
                AzurePwmGateway(
                    primary_endpoint=config["primary_endpoint"],
                    primary_deployment=config["primary_deployment"],
                    primary_token_supplier=lambda: token,
                )
            ),
        )
        return
    raise UnsupportedLiveStage(case["stage"])


def _http_status(error: BaseException) -> int | None:
    """The first provider HTTP status in the cause chain, if any."""
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        status = getattr(current, "status_code", None)
        if type(status) is int:
            return status
        current = current.__cause__ or current.__context__
    return None


def _pwm_reason(output: str) -> str:
    for event in map(_event, output.splitlines()):
        if "azure_pwm_probe_failure" in event:
            return "+".join(event.get("failed_fields") or []) or "pwm_trust"
    return "pwm_trust"


def _final_attempt(output: str) -> tuple[str, int]:
    """The last attempt's output and the repeats before it; a repeat is classified alone."""
    lines = output.splitlines()
    marks = [i for i, line in enumerate(lines) if _event(line).get("result") == "transport_retry"]
    return ("\n".join(lines[marks[-1] + 1 :]), len(marks)) if marks else (output, 0)


def _event(line: str) -> dict:
    with contextlib.suppress(ValueError):
        event = json.loads(line)
        if isinstance(event, dict):
            return event
    return {}


def _failure(error: BaseException, output: str) -> dict:
    """Fixed reason codes only; classification follows the shared dependency contract."""
    from hushh_mcp.runtime_providers.dependency_health import classify_provider_error
    from scripts.probe_drive_activity_planner import ActivityPlannerContractError
    from scripts.pwm_trust_failure import planner_trust_error, trust_fields
    from scripts.verify_azure_pwm_runtime import AzurePwmTrustError

    # Semantic rows carry the UAT verdict's authored stage, reason and leg as well.
    if isinstance(error, ActivityPlannerContractError):
        typed = trust_fields(planner_trust_error(error))
        return {"result": "failed", "class": "semantic", "reason": str(error.args[0]), **typed}
    if isinstance(error, AzurePwmTrustError):
        typed = trust_fields(error)
        return {"result": "failed", "class": "semantic", "reason": _pwm_reason(output), **typed}
    if isinstance(error, ProbeIdentityError):
        return {"result": "inconclusive", "class": "identity", "reason": "federation_failed"}
    status = _http_status(error)
    if status in {401, 403}:
        # Role propagation or a network rule refused the probe identity, not the PR's text.
        return {"result": "inconclusive", "class": "identity", "reason": "probe_unauthorized"}
    if status == 404:
        return {"result": "inconclusive", "class": "identity", "reason": "deployment_missing"}
    if isinstance(error, UnsupportedLiveStage):
        return {"result": "failed", "class": "contract", "reason": "stage_unsupported"}
    timed_out = _timed_out(error)
    if timed_out and _planner_reason(output) is not None:
        # A planner call ran out of time; the PR's text may cause that, so never call it transport.
        return {"result": "inconclusive", "class": "deadline", "reason": "planner_deadline"}
    if timed_out or classify_provider_error(error) == "provider_unavailable":
        reason = "provider_timeout" if timed_out else "provider_unavailable"
        return {"result": "inconclusive", "class": "transport", "reason": reason}
    if _planner_reason(output) is not None:
        if _model_output_failure(error):
            # The planner's last attempt returned output the plan contract rejects.
            return {"result": "failed", "class": "semantic", "reason": "planner_output_invalid"}
        # The planner raised without a model judgment; never blame the PR's text for it.
        return {"result": "failed", "class": "error", "reason": "planner_execution_failed"}
    return {"result": "failed", "class": "error", "reason": f"unclassified:{type(error).__name__}"}


def _model_output_failure(error: BaseException) -> bool:
    """The errors plan_semantic_live_search raises only after rejecting model output."""
    from pydantic import ValidationError

    from hushh_mcp.services.drive_suggestion_service import _SemanticPlannerOutputError

    return isinstance(error, (ValidationError, _SemanticPlannerOutputError))


def _timed_out(error: BaseException) -> bool:
    """A timeout anywhere in the cause chain; turn wrappers hide it from isinstance."""
    import httpx

    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, (TimeoutError, httpx.TimeoutException)):
            return True
        current = current.__cause__ or current.__context__
    return False


def _planner_reason(output: str) -> str | None:
    for event in map(_event, output.splitlines()):
        if (
            event.get("schema") == "drive.activity_planner.probe.v1"
            and event.get("result") == "failed"
        ):
            return str(event.get("reason") or "planner_failed")
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--case", required=True)
    args = parser.parse_args(argv)
    started, captured = time.monotonic(), io.StringIO()
    try:
        with contextlib.redirect_stdout(captured):
            from scripts.readiness_exam_manifest import load_manifest
            from scripts.verify_azure_pwm_runtime import _initialize_synthetic_runtime

            _initialize_synthetic_runtime()
            case = next(
                c
                for c in load_manifest()["cases"]
                if c["id"] == args.case and c["pre_merge"] == "live"
            )
            asyncio.run(asyncio.wait_for(_run(case), timeout=CASE_DEADLINE_SECONDS))
        row = {"result": "passed", "class": "ok", "reason": "graded_passed"}
    except Exception as error:  # noqa: BLE001 - every failure becomes a fixed row
        row = _failure(error, _final_attempt(captured.getvalue())[0])
    sys.stdout.write(captured.getvalue())
    retries = _final_attempt(captured.getvalue())[1]
    row.update({"transport_retries": retries} if retries else {})
    row.update(case=args.case, elapsed_ms=round((time.monotonic() - started) * 1000))
    print(json.dumps({"readiness_exam_case": row}, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

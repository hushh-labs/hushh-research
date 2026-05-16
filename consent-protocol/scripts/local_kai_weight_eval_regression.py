#!/usr/bin/env python3
"""Run Kai weight evaluation from PKM decision receipts.

Usage:
  python scripts/local_kai_weight_eval_regression.py \
    --user-id user_123 \
    --outcomes-file /tmp/outcomes.json \
    --run-id weight_eval_local_001
"""

from __future__ import annotations

import argparse
import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from hushh_mcp.services.kai_weight_eval_service import KaiWeightEvalService


def _utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _load_outcomes(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError("Outcomes file must be a JSON array of outcome objects.")
    return [row for row in payload if isinstance(row, dict)]


async def _run(args: argparse.Namespace) -> dict[str, Any]:
    service = KaiWeightEvalService()
    resolved_run_id = args.run_id or f"weight_eval_{_utc_stamp()}"
    if args.outcomes_file:
        outcomes = _load_outcomes(Path(args.outcomes_file))
        run = await service.run_weight_eval_from_pkm(
            user_id=args.user_id,
            run_id=resolved_run_id,
            model_version=args.model_version,
            prompt_set_version=args.prompt_set_version,
            outcomes=outcomes,
        )
    else:
        # This mode is intentionally explicit: a real provider must be injected
        # by runtime wiring before auto-derivation can run outside tests.
        run = await service.run_weight_eval_with_outcome_provider(
            user_id=args.user_id,
            run_id=resolved_run_id,
            model_version=args.model_version,
            prompt_set_version=args.prompt_set_version,
            horizon_days=args.horizon_days,
            limit=args.limit,
        )
    decision = service.evaluate_promotion(
        run=run,
        approved_by=args.approved_by,
        min_accuracy=args.min_accuracy,
        max_safety_regression=args.max_safety_regression,
        max_latency_ms=args.max_latency_ms,
    )
    persisted = await service.persist_promotion_decision(
        user_id=args.user_id,
        decision=decision,
        gate_results=run.gate_results,
    )
    snapshot = await service.fetch_recent_weight_eval_artifacts(
        user_id=args.user_id,
        limit=10,
    )
    return {
        "run_id": run.run_id,
        "cases": len(run.cases),
        "kpis": run.kpis.__dict__,
        "promotion": decision.to_dict(),
        "promotion_persisted": persisted,
        "recent_artifacts": {
            "artifact_count": snapshot["artifact_count"],
            "runs": len(snapshot["runs"]),
            "promotions": len(snapshot["promotions"]),
        },
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run Kai weight eval from PKM receipts.")
    parser.add_argument("--user-id", required=True, help="User ID for PKM decision receipts.")
    parser.add_argument(
        "--outcomes-file",
        default="",
        help="Path to JSON array with realized outcomes.",
    )
    parser.add_argument("--run-id", default="", help="Optional shadow eval run identifier.")
    parser.add_argument("--model-version", default="shadow-v1")
    parser.add_argument("--prompt-set-version", default="local-smoke-v1")
    parser.add_argument("--horizon-days", type=int, default=7)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--approved-by", default="local-governor")
    parser.add_argument("--min-accuracy", type=float, default=0.65)
    parser.add_argument("--max-safety-regression", type=float, default=0.0)
    parser.add_argument("--max-latency-ms", type=float, default=1500.0)
    return parser


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()
    result = asyncio.run(_run(args))
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from hushh_mcp.agents.kai.config import AGENT_WEIGHTS
from hushh_mcp.services.eval_contracts import (
    EvalCase,
    EvalGateResult,
    EvalKPIBundle,
    EvalRun,
    PromotionDecision,
)

logger = logging.getLogger(__name__)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class KaiWeightEvalService:
    """
    Offline-only Kai learning evaluator.

    This service never mutates live agent weights. It only creates candidate
    evaluation artifacts and promotion recommendations.
    """

    def __init__(
        self,
        pkm_service: Any | None = None,
        outcome_provider: Any | None = None,
    ) -> None:
        self._active_weight_version = "static:v1"
        self._pkm_service = pkm_service
        self._outcome_provider = outcome_provider

    @property
    def pkm_service(self):
        if self._pkm_service is None:
            from hushh_mcp.services.personal_knowledge_model_service import get_pkm_service

            self._pkm_service = get_pkm_service()
        return self._pkm_service

    async def load_decision_receipts(
        self, *, user_id: str, limit: int = 100
    ) -> list[dict[str, Any]]:
        """Load canonical decision receipts from PKM decision projections."""
        logger.info(
            "kai_weight_eval.load_decision_receipts.start user_id=%s limit=%s", user_id, limit
        )
        records = await self.pkm_service.get_recent_decision_records(user_id=user_id, limit=limit)
        receipts: list[dict[str, Any]] = []
        for idx, row in enumerate(records):
            if not isinstance(row, dict):
                logger.warning("kai_weight_eval.load_decision_receipts.skip_non_dict index=%s", idx)
                continue
            metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
            debate_rounds = (
                row.get("debate_rounds") if isinstance(row.get("debate_rounds"), list) else []
            )
            receipts.append(
                {
                    "decision_id": str(
                        row.get("decision_id") or row.get("id") or f"receipt_{idx + 1}"
                    ),
                    "ticker": str(row.get("ticker") or "").upper(),
                    "decision": str(
                        row.get("decision")
                        or row.get("decision_type")
                        or row.get("recommendation")
                        or "hold"
                    ).lower(),
                    "confidence": float(row.get("confidence") or 0.0),
                    "risk_profile": str(
                        row.get("risk_profile") or metadata.get("risk_profile") or "balanced"
                    ).lower(),
                    "data_provenance": metadata.get("all_sources")
                    or metadata.get("provenance")
                    or row.get("all_sources")
                    or [],
                    "dissenting_opinions": row.get("dissenting_opinions")
                    if isinstance(row.get("dissenting_opinions"), list)
                    else [],
                    "market_context": metadata.get("market_context", {}),
                    "debate_rounds_count": len(debate_rounds),
                    "recorded_at": row.get("created_at") or metadata.get("created_at"),
                }
            )
        logger.info(
            "kai_weight_eval.load_decision_receipts.done user_id=%s raw_records=%s normalized_receipts=%s",
            user_id,
            len(records),
            len(receipts),
        )
        return receipts

    async def run_weight_eval_from_pkm(
        self,
        *,
        user_id: str,
        run_id: str,
        model_version: str,
        prompt_set_version: str,
        outcomes: list[dict[str, Any]],
    ) -> EvalRun:
        """
        Compare PKM decision receipts against later outcomes in offline mode.
        """
        receipts = await self.load_decision_receipts(
            user_id=user_id, limit=max(len(outcomes), 1) * 3
        )
        receipts_by_id = {r["decision_id"]: r for r in receipts if r.get("decision_id")}
        receipts_by_ticker: dict[str, list[dict[str, Any]]] = {}
        for receipt in receipts:
            ticker = str(receipt.get("ticker") or "").upper()
            if ticker:
                receipts_by_ticker.setdefault(ticker, []).append(receipt)

        expected_vs_observed: list[dict[str, Any]] = []
        contamination_count = 0
        for idx, outcome in enumerate(outcomes):
            decision_id = str(outcome.get("decision_id") or "").strip()
            ticker = str(outcome.get("ticker") or "").upper()
            receipt = receipts_by_id.get(decision_id)
            if receipt is None and ticker:
                candidates = receipts_by_ticker.get(ticker, [])
                receipt = candidates[0] if candidates else None
            if receipt is None:
                logger.warning(
                    "kai_weight_eval.run.from_pkm.unmatched_outcome index=%s decision_id=%s ticker=%s",
                    idx,
                    decision_id,
                    ticker,
                )
                continue

            actual_return = float(outcome.get("realized_return", 0.0))
            observed = self._decision_from_return(actual_return)
            if "financial" not in json.dumps(receipt.get("data_provenance", [])).lower():
                contamination_count += 1

            expected_vs_observed.append(
                {
                    "case_id": str(
                        outcome.get("case_id") or receipt["decision_id"] or f"case_{idx + 1}"
                    ),
                    "expected_decision": receipt["decision"],
                    "observed_decision": observed,
                    "observed_confidence": float(
                        outcome.get("observed_confidence", receipt["confidence"])
                    ),
                    "latency_ms": float(outcome.get("eval_latency_ms", 0.0)),
                    "metadata": {
                        "decision_id": receipt["decision_id"],
                        "ticker": receipt["ticker"],
                        "risk_profile": receipt["risk_profile"],
                        "realized_return": actual_return,
                        "data_provenance": receipt["data_provenance"],
                        "dissenting_opinions": receipt["dissenting_opinions"],
                        "market_context": outcome.get("market_context")
                        or receipt.get("market_context")
                        or {},
                    },
                }
            )

        run = await self.build_candidate_run(
            run_id=run_id,
            model_version=model_version,
            prompt_set_version=prompt_set_version,
            expected_vs_observed=expected_vs_observed,
            metadata={"finance_contamination_delta": float(contamination_count)},
        )
        await self.persist_candidate_run(user_id=user_id, run=run)
        logger.info(
            "kai_weight_eval.run.from_pkm.done user_id=%s run_id=%s matched_cases=%s contamination_count=%s",
            user_id,
            run_id,
            len(run.cases),
            contamination_count,
        )
        return run

    async def run_weight_eval_with_outcome_provider(
        self,
        *,
        user_id: str,
        run_id: str,
        model_version: str,
        prompt_set_version: str,
        horizon_days: int = 7,
        limit: int = 100,
    ) -> EvalRun:
        """
        End-to-end mode: load receipts, derive outcomes via provider, then evaluate.
        """
        if self._outcome_provider is None:
            raise ValueError("Outcome provider is required for automatic outcome derivation mode.")
        receipts = await self.load_decision_receipts(user_id=user_id, limit=limit)
        outcomes = await self._outcome_provider.get_realized_outcomes(
            receipts=receipts,
            horizon_days=horizon_days,
        )
        logger.info(
            "kai_weight_eval.run.with_provider user_id=%s run_id=%s receipts=%s derived_outcomes=%s horizon_days=%s",
            user_id,
            run_id,
            len(receipts),
            len(outcomes) if isinstance(outcomes, list) else 0,
            horizon_days,
        )
        return await self.run_weight_eval_from_pkm(
            user_id=user_id,
            run_id=run_id,
            model_version=model_version,
            prompt_set_version=prompt_set_version,
            outcomes=outcomes if isinstance(outcomes, list) else [],
        )

    async def build_candidate_run(
        self,
        *,
        run_id: str,
        model_version: str,
        prompt_set_version: str,
        expected_vs_observed: list[dict[str, Any]],
        metadata: dict[str, Any] | None = None,
    ) -> EvalRun:
        cases: list[EvalCase] = []
        if not expected_vs_observed:
            logger.info("kai_weight_eval.build_candidate_run.empty run_id=%s", run_id)
            kpis = EvalKPIBundle(accuracy_delta=0.0, safety_regression=0.0, latency_delta_ms=0.0)
            return EvalRun(
                run_id=run_id,
                surface="kai",
                status="candidate",
                model_version=model_version,
                prompt_set_version=prompt_set_version,
                created_at=_utc_now(),
                kpis=kpis,
                cases=[],
                notes=["empty_eval_set"],
            )

        hit_count = 0
        latency_total = 0.0
        for idx, item in enumerate(expected_vs_observed):
            expected = str(item.get("expected_decision", "hold")).lower()
            observed = str(item.get("observed_decision", "hold")).lower()
            observed_conf = float(item.get("observed_confidence", 0.0))
            latency_ms = float(item.get("latency_ms", 0.0))
            latency_total += latency_ms

            is_hit = expected == observed
            if is_hit:
                hit_count += 1

            cases.append(
                EvalCase(
                    case_id=str(item.get("case_id", f"case_{idx + 1}")),
                    expected_decision=expected,
                    observed_decision=observed,
                    expected_confidence_min=float(item.get("expected_confidence_min", 0.0)),
                    observed_confidence=observed_conf,
                    score=1.0 if is_hit else 0.0,
                    metadata={"latency_ms": latency_ms, **(item.get("metadata") or {})},
                )
            )

        accuracy = hit_count / len(expected_vs_observed)
        average_latency = latency_total / len(expected_vs_observed)
        kpis = EvalKPIBundle(
            accuracy_delta=accuracy,
            safety_regression=float((metadata or {}).get("safety_regression", 0.0)),
            latency_delta_ms=average_latency,
            finance_contamination_delta=float(
                (metadata or {}).get("finance_contamination_delta", 0.0)
            ),
        )

        return EvalRun(
            run_id=run_id,
            surface="kai",
            status="candidate",
            model_version=model_version,
            prompt_set_version=prompt_set_version,
            created_at=_utc_now(),
            kpis=kpis,
            cases=cases,
            notes=["offline_only", "no_live_weight_mutation"],
        )

    def evaluate_promotion(
        self,
        *,
        run: EvalRun,
        approved_by: str,
        min_accuracy: float = 0.65,
        max_safety_regression: float = 0.0,
        max_latency_ms: float = 1500.0,
    ) -> PromotionDecision:
        gate_results = [
            EvalGateResult(
                gate_name="accuracy",
                passed=run.kpis.accuracy_delta >= min_accuracy,
                threshold=min_accuracy,
                actual=run.kpis.accuracy_delta,
                note="Candidate must beat baseline threshold.",
            ),
            EvalGateResult(
                gate_name="safety_regression",
                passed=run.kpis.safety_regression <= max_safety_regression,
                threshold=max_safety_regression,
                actual=run.kpis.safety_regression,
                note="Safety must not regress.",
            ),
            EvalGateResult(
                gate_name="latency",
                passed=run.kpis.latency_delta_ms <= max_latency_ms,
                threshold=max_latency_ms,
                actual=run.kpis.latency_delta_ms,
                note="Latency budget must stay inside limits.",
            ),
        ]
        run.gate_results = gate_results
        approved = all(g.passed for g in gate_results)
        reason = "all_gates_passed" if approved else "gates_failed"
        logger.info(
            "kai_weight_eval.evaluate_promotion run_id=%s approved=%s reason=%s accuracy=%.4f safety=%.4f latency_ms=%.2f",
            run.run_id,
            approved,
            reason,
            run.kpis.accuracy_delta,
            run.kpis.safety_regression,
            run.kpis.latency_delta_ms,
        )
        return PromotionDecision(
            run_id=run.run_id,
            approved=approved,
            approved_by=approved_by,
            reason=reason,
        )

    async def persist_candidate_run(self, *, user_id: str, run: EvalRun) -> bool:
        """
        Persist candidate run as a PKM mutation event on canonical rails.
        """
        logger.info(
            "kai_weight_eval.persist_candidate_run user_id=%s run_id=%s cases=%s",
            user_id,
            run.run_id,
            len(run.cases),
        )
        return await self.pkm_service.record_mutation_event(
            user_id=user_id,
            domain="financial",
            operation_type="decision_projection",
            path_set=["analysis.shadow_eval_runs"],
            source_agent="kai_weight_eval_service",
            confidence=run.kpis.accuracy_delta,
            metadata={
                "projection_type": "kai_weight_eval_v1",
                "projection_mode": "append",
                "decisions": [],
                "shadow_eval_run": run.to_dict(),
            },
        )

    async def persist_promotion_decision(
        self,
        *,
        user_id: str,
        decision: PromotionDecision,
        gate_results: list[EvalGateResult],
    ) -> bool:
        logger.info(
            "kai_weight_eval.persist_promotion_decision user_id=%s run_id=%s approved=%s",
            user_id,
            decision.run_id,
            decision.approved,
        )
        return await self.pkm_service.record_mutation_event(
            user_id=user_id,
            domain="financial",
            operation_type="decision_projection",
            path_set=["analysis.shadow_eval_promotions"],
            source_agent="kai_weight_eval_service",
            confidence=1.0 if decision.approved else 0.0,
            metadata={
                "projection_type": "kai_weight_eval_promotion_v1",
                "projection_mode": "append",
                "decisions": [],
                "promotion_decision": decision.to_dict(),
                "gate_results": [asdict_gate(g) for g in gate_results],
            },
        )

    async def fetch_recent_weight_eval_artifacts(
        self,
        *,
        user_id: str,
        limit: int = 20,
    ) -> dict[str, Any]:
        """Fetch persisted shadow-eval runs and promotion decisions for review."""
        artifacts = await self.pkm_service.get_recent_kai_weight_eval_artifacts(
            user_id=user_id,
            limit=limit,
        )
        runs: list[dict[str, Any]] = []
        promotions: list[dict[str, Any]] = []
        for artifact in artifacts:
            projection_type = str(artifact.get("projection_type") or "").strip().lower()
            payload = artifact.get("payload") if isinstance(artifact.get("payload"), dict) else {}
            created_at = artifact.get("created_at")
            if projection_type == "kai_weight_eval_v1":
                run_payload = payload.get("shadow_eval_run")
                if isinstance(run_payload, dict):
                    runs.append({"created_at": created_at, "run": run_payload})
            elif projection_type == "kai_weight_eval_promotion_v1":
                promotions.append(
                    {
                        "created_at": created_at,
                        "decision": payload.get("promotion_decision"),
                        "gate_results": payload.get("gate_results"),
                    }
                )
        return {
            "user_id": user_id,
            "runs": runs,
            "promotions": promotions,
            "artifact_count": len(artifacts),
        }

    def build_debate_attribution(
        self,
        *,
        risk_profile: str,
        agent_confidences: dict[str, float],
        renaissance_shift: float = 0.0,
    ) -> dict[str, Any]:
        weights = AGENT_WEIGHTS.get(risk_profile, AGENT_WEIGHTS["balanced"])
        weighted_scores: dict[str, float] = {}
        total = 0.0
        for agent_id in ("fundamental", "sentiment", "valuation"):
            base_conf = float(agent_confidences.get(agent_id, 0.0))
            score = base_conf * float(weights.get(agent_id, 0.0))
            weighted_scores[agent_id] = score
            total += score
        contribution_percent = {
            k: (v / total if total > 0 else 0.0) for k, v in weighted_scores.items()
        }
        return {
            "risk_profile": risk_profile,
            "weight_version": self._active_weight_version,
            "weights": weights,
            "agent_confidences": agent_confidences,
            "weighted_scores": weighted_scores,
            "contribution_percent": contribution_percent,
            "renaissance_shift": float(renaissance_shift),
            "attribution_contract_version": 1,
        }

    def debug_snapshot(self, run: EvalRun) -> dict[str, Any]:
        return {
            "run": run.to_dict(),
            "active_weight_version": self._active_weight_version,
        }

    @staticmethod
    def _decision_from_return(realized_return: float) -> str:
        if realized_return >= 0.03:
            return "buy"
        if realized_return <= -0.03:
            return "reduce"
        return "hold"


def asdict_gate(gate: EvalGateResult) -> dict[str, Any]:
    return {
        "gate_name": gate.gate_name,
        "passed": gate.passed,
        "threshold": gate.threshold,
        "actual": gate.actual,
        "note": gate.note,
    }


_kai_weight_eval_service: KaiWeightEvalService | None = None


def get_kai_weight_eval_service() -> KaiWeightEvalService:
    global _kai_weight_eval_service
    if _kai_weight_eval_service is None:
        _kai_weight_eval_service = KaiWeightEvalService()
    return _kai_weight_eval_service

#!/usr/bin/env python3
"""
tests/agents/kai/evals/compare.py
=================================

Run the Kai eval harness against real providers and produce the
side-by-side comparison report referenced in the PR description.

Usage:
    uv run python tests/agents/kai/evals/compare.py \\
        --baseline gemini --candidate vllm \\
        --out reports/eval_compare.json \\
        --markdown reports/eval_compare.md

What this script does (and does NOT do):

* It calls `synthesize_debate_recommendation_card_v2` directly with
  scenario-derived prompts, NOT the full Kai debate engine. This keeps
  the script reproducible without PKM / Renaissance / SEC services.
* It DOES exercise the real provider adapter, so the comparison
  measures: model behavior + adapter overhead + scope-gating cost.
* Output is JSON + markdown. The markdown table is the artifact for
  the PR body.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from dataclasses import asdict
from pathlib import Path

# Allow running as a script from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from hushh_mcp.consent.token import issue_token
from hushh_mcp.operons.kai.llm_adapter import (
    synthesize_debate_recommendation_card_v2,
)
from hushh_mcp.operons.kai.providers import (
    ConsentScopeViolation,
    ProviderError,
    ProviderUnavailable,
)
from hushh_mcp.operons.kai.providers.scopes import scope_for_provider

from .fixtures import load_scenarios, parse_debate_from_synthesis_text
from .metrics import compute_all
from .schema import DebateOutput, EvalReport, Scenario


# ---------------------------------------------------------------------------
# Per-scenario invocation
# ---------------------------------------------------------------------------


def _build_inputs(scenario: Scenario) -> dict:
    """
    Build the synthesize_v2 kwargs from a scenario.

    The fields mirror what the live debate engine would assemble in
    api/routes/kai/stream.py (see line ~2046).
    """
    fund = {
        "summary": f"{scenario.ticker} fundamentals review",
        "recommendation": scenario.expected_recommendation,
        "confidence": (scenario.expected_confidence_band[0] + scenario.expected_confidence_band[1]) / 2,
        "business_moat": "synthetic",
        "financial_resilience": scenario.sec_data.get("latest_10k", {}),
        "growth_efficiency": "synthetic",
        "bull_case": "synthetic",
        "bear_case": "synthetic",
        "key_metrics": scenario.market_data,
        "quant_metrics": scenario.market_data,
    }
    sent = {
        "summary": "Aggregated headlines",
        "recommendation": scenario.expected_recommendation,
        "confidence": 0.6,
        "sentiment_score": 0.0,
        "key_catalysts": [s.get("headline") for s in scenario.sentiment_data],
    }
    val = {
        "summary": f"Valuation review for {scenario.ticker}",
        "recommendation": scenario.expected_recommendation,
        "confidence": 0.6,
        "key_metrics": scenario.market_data,
    }
    debate = {
        "rounds": [],
        "convergence": True,
        "final_recommendation": scenario.expected_recommendation,
    }
    highlights = [
        {"title": s.get("headline", ""), "source": s.get("source", "")}
        for s in scenario.sentiment_data
    ]
    return dict(
        ticker=scenario.ticker,
        risk_profile=scenario.user_context.get("risk_tolerance", "Balanced"),
        user_context=scenario.user_context,
        renaissance_context={"tier": "synthetic", "score": 0.0},
        fundamental_payload=fund,
        sentiment_payload=sent,
        valuation_payload=val,
        debate_payload=debate,
        highlights=highlights,
    )


async def _run_one(
    scenario: Scenario,
    provider_name: str,
    consent_token: str,
    user_id: str,
) -> DebateOutput | None:
    inputs = _build_inputs(scenario)
    t0 = time.perf_counter()
    try:
        payload = await synthesize_debate_recommendation_card_v2(
            **inputs,
            consent_token=consent_token,
            user_id=user_id,
            provider_name=provider_name,
        )
    except ConsentScopeViolation as exc:
        print(f"[{provider_name}] {scenario.id}: SCOPE VIOLATION -- {exc}", file=sys.stderr)
        return None
    except (ProviderUnavailable, ProviderError) as exc:
        print(f"[{provider_name}] {scenario.id}: PROVIDER ERROR -- {exc}", file=sys.stderr)
        return None

    latency_ms = int((time.perf_counter() - t0) * 1000)
    text = json.dumps(payload)
    output = parse_debate_from_synthesis_text(
        text,
        scenario_id=scenario.id,
        provider=payload.get("_meta", {}).get("provider", provider_name),
        model=payload.get("_meta", {}).get("model", ""),
    )
    # Attach measured latency at synthesis layer.
    return DebateOutput(
        scenario_id=output.scenario_id,
        provider=output.provider,
        model=output.model,
        fundamental=output.fundamental,
        sentiment=output.sentiment,
        valuation=output.valuation,
        renaissance=output.renaissance,
        recommendation=output.recommendation,
        confidence=output.confidence,
        rationale=output.rationale,
        latency_ms_per_agent={**output.latency_ms_per_agent, "synthesis": latency_ms},
    )


async def _run_all(
    scenarios: dict[str, Scenario], provider_name: str, n_limit: int | None
) -> EvalReport:
    # Issue a token with the umbrella scope so all providers are reachable.
    user_id = os.getenv("KAI_EVAL_USER_ID", "eval_user")
    scope = scope_for_provider(provider_name)
    token = issue_token(
        user_id=user_id,
        agent_id="agent_kai",
        scope=scope,
    )
    consent_token = token.token if hasattr(token, "token") else str(token)

    selected = list(scenarios.values())
    if n_limit:
        selected = selected[:n_limit]

    outputs: list[DebateOutput] = []
    for s in selected:
        out = await _run_one(s, provider_name, consent_token, user_id)
        if out is not None:
            outputs.append(out)

    metrics = compute_all(outputs, scenarios)
    return EvalReport(
        provider=provider_name,
        model=outputs[0].model if outputs else "",
        n_scenarios=len(outputs),
        metrics=metrics,
    )


# ---------------------------------------------------------------------------
# Markdown rendering
# ---------------------------------------------------------------------------


def render_comparison_markdown(baseline: EvalReport, candidate: EvalReport) -> str:
    base_by = {m.name: m for m in baseline.metrics}
    cand_by = {m.name: m for m in candidate.metrics}
    rows = []
    rows.append(
        f"| Metric | {baseline.provider} (baseline) | {candidate.provider} (candidate) | Delta |"
    )
    rows.append("| --- | --- | --- | --- |")
    metric_order = [
        "recommendation_calibration_brier",
        "evidence_grounding",
        "internal_consistency",
        "debate_convergence",
        "latency_total_p50_ms",
        "latency_total_p95_ms",
    ]
    for name in metric_order:
        b = base_by.get(name)
        c = cand_by.get(name)
        bv = f"{b.value:.4f}" if b else "—"
        cv = f"{c.value:.4f}" if c else "—"
        if b and c and b.value:
            delta = (c.value - b.value) / abs(b.value) * 100
            dv = f"{delta:+.1f}%"
        else:
            dv = "—"
        rows.append(f"| {name} | {bv} | {cv} | {dv} |")
    return "\n".join(rows)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare two Kai inference providers.")
    parser.add_argument("--baseline", default="gemini")
    parser.add_argument("--candidate", default="vllm")
    parser.add_argument("--limit", type=int, default=None, help="run only first N scenarios")
    parser.add_argument("--out", type=Path, default=Path("reports/eval_compare.json"))
    parser.add_argument("--markdown", type=Path, default=Path("reports/eval_compare.md"))
    args = parser.parse_args()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.markdown.parent.mkdir(parents=True, exist_ok=True)

    scenarios = load_scenarios()
    if not scenarios:
        print("No scenarios loaded; check tests/agents/kai/evals/scenarios/*.yaml", file=sys.stderr)
        return 2

    print(f"[eval-compare] running baseline={args.baseline} candidate={args.candidate} "
          f"on {len(scenarios)} scenarios")

    baseline_report = asyncio.run(_run_all(scenarios, args.baseline, args.limit))
    candidate_report = asyncio.run(_run_all(scenarios, args.candidate, args.limit))

    args.out.write_text(
        json.dumps(
            {
                "baseline": baseline_report.as_dict(),
                "candidate": candidate_report.as_dict(),
            },
            indent=2,
        )
    )
    print(f"[eval-compare] wrote {args.out}")

    args.markdown.write_text(render_comparison_markdown(baseline_report, candidate_report))
    print(f"[eval-compare] wrote {args.markdown}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

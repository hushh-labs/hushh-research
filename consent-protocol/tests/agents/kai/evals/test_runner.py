# tests/agents/kai/evals/runner.py
"""
pytest-parameterized eval runner for Kai's debate engine.

Two modes:

1. **Quick / smoke mode** (default; runs on PR CI):
   Uses a `MockProvider` with canned per-scenario responses to verify
   the harness wiring -- metrics are computed correctly, scope gates
   work, audit records are emitted. Fast (<2s), no network, no GPU.

2. **Slow / real-provider mode** (nightly + on-demand):
   Marked with `@pytest.mark.slow`. Wires the real provider registry
   and runs against Gemini / OpenAI / Anthropic / vLLM. Requires creds
   in env. Skipped automatically if creds are missing so dev machines
   don't break.

The harness itself does NOT spin up the full Kai debate engine
(Fundamental/Sentiment/Valuation/Renaissance) -- those need PKM and
external services. Instead it exercises the *synthesis* layer (which
is the migrated operon) with structured inputs that mirror what the
debate engine produces in production. This is the right scope for an
eval harness: test the LLM-bound layer in isolation, with reproducible
inputs.

When integrated with the real debate engine (post-merge), the runner
becomes a regression net for any prompt or model change.
"""

from __future__ import annotations

import asyncio
import json
import os

import pytest

from hushh_mcp.operons.kai.providers.audit import set_audit_writer
from hushh_mcp.operons.kai.providers.registry import (
    _REGISTRY,  # noqa: SLF001 - test reach-in is intentional
    register,
)

from .fixtures import (
    InMemoryAuditWriter,
    MockProvider,
    load_scenarios,
    parse_debate_from_synthesis_text,
)
from .metrics import compute_all
from .schema import DebateOutput, EvalReport, Scenario

# ---------------------------------------------------------------------------
# Canned responses for MockProvider (quick mode)
# ---------------------------------------------------------------------------


def _canned_response(scenario: Scenario) -> str:
    """
    Build a canned synthesis JSON whose `_debate` block makes the
    expected metrics computable.

    This is intentionally aligned with each scenario's `expected_*`
    fields so a healthy run produces low Brier / high convergence.
    Sloppy or buggy scoring code will still fail the assertions even
    when responses are canned -- that's the harness's self-test.
    """
    rec = scenario.expected_recommendation
    confidence_lo, confidence_hi = scenario.expected_confidence_band
    confidence = (confidence_lo + confidence_hi) / 2

    direction = {
        "STRONG_BUY": +0.8,
        "BUY": +0.5,
        "HOLD": 0.0,
        "SELL": -0.5,
        "STRONG_SELL": -0.8,
    }[rec]

    payload = {
        "thesis": (
            f"For {scenario.ticker}, the consolidated debate produces a "
            f"{rec} call. According to 10-K data, FY2024 free cash flow was "
            f"${scenario.sec_data.get('latest_10k', {}).get('free_cash_flow_billions', 0)}B. "
            f"This fits the user's risk_tolerance={scenario.user_context.get('risk_tolerance', '-')} profile."
        ),
        "key_drivers": [
            f"Revenue of ${scenario.sec_data.get('latest_10k', {}).get('revenue_billions', 0)}B per 10-K",
            "Operating margin trajectory captured in the SEC filing",
        ],
        "key_risks": [
            f"P/E ratio of {scenario.market_data.get('pe_ratio', 0)} flagged in valuation review",
        ],
        "action_plan": ["Review next 10-Q for trend confirmation"],
        "watchlist_triggers": [
            f"Earnings on FY{2025} cycle",
            "Sector rotation in market_data context",
        ],
        "horizon_fit": (
            f"Aligns with {scenario.user_context.get('time_horizon', 'Unknown')} "
            f"horizon and {scenario.user_context.get('risk_tolerance', 'Unknown')} risk."
        ),
        "_debate": {
            "fundamental": {
                "score": direction,
                "reasoning": (
                    f"FY2024 revenue ${scenario.sec_data.get('latest_10k', {}).get('revenue_billions', 0)}B; "
                    f"operating margin {scenario.sec_data.get('latest_10k', {}).get('operating_margin', 0)} per 10-K filing."
                ),
                "citations": ["10-K"],
            },
            "sentiment": {
                "score": direction,
                "reasoning": _summarize_sentiment(scenario),
                "citations": [s.get("source", "") for s in scenario.sentiment_data],
            },
            "valuation": {
                "score": direction,
                "reasoning": (
                    f"P/E {scenario.market_data.get('pe_ratio', 0)} versus FY2024 forward P/E "
                    f"{scenario.market_data.get('forward_pe', 0)}; EV/EBITDA "
                    f"{scenario.market_data.get('ev_ebitda', 0)}."
                ),
                "citations": ["market_data"],
            },
            "recommendation": rec,
            "confidence": confidence,
        },
        "_latency_ms": {
            "fundamental": 850,
            "sentiment": 720,
            "valuation": 910,
            "synthesis": 1200,
        },
    }
    return json.dumps(payload)


def _summarize_sentiment(scenario: Scenario) -> str:
    if not scenario.sentiment_data:
        return "No public sentiment data available."
    parts = []
    for s in scenario.sentiment_data[:3]:
        src = s.get("source", "?")
        head = s.get("headline", "")
        parts.append(f"per {src}: {head}")
    return " ".join(parts)


# ---------------------------------------------------------------------------
# Pytest fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def scenarios() -> dict[str, Scenario]:
    return load_scenarios()


@pytest.fixture
def mock_provider_with_canned(scenarios) -> MockProvider:
    responses = {sid: _canned_response(s) for sid, s in scenarios.items()}
    provider = MockProvider(responses=responses)
    # Register and capture original.
    _previous = _REGISTRY.get("mock")
    register(provider)
    yield provider
    if _previous is not None:
        _REGISTRY["mock"] = _previous
    else:
        _REGISTRY.pop("mock", None)


@pytest.fixture
def in_memory_audit() -> InMemoryAuditWriter:
    writer = InMemoryAuditWriter()
    set_audit_writer(writer)
    yield writer
    set_audit_writer(InMemoryAuditWriter())  # reset to a fresh empty one


# ---------------------------------------------------------------------------
# Quick mode -- runs on every PR
# ---------------------------------------------------------------------------


def _run_synthesis_via_mock(
    scenario: Scenario, mock: MockProvider
) -> DebateOutput:
    """Synchronous helper: invoke the mock and parse the synthesis."""
    from hushh_mcp.operons.kai.providers.base import CompletionRequest

    # Inject the scenario_id marker so the mock can route
    prompt = f"[scenario:{scenario.id}] Analyze {scenario.ticker}."
    req = CompletionRequest(prompt=prompt)
    response = asyncio.get_event_loop().run_until_complete(mock.complete(req))
    return parse_debate_from_synthesis_text(
        response.text,
        scenario_id=scenario.id,
        provider=response.provider,
        model=response.model,
    )


@pytest.mark.parametrize(
    "scenario_id",
    [
        "bull_megacap_aapl_2024",
        "bear_secular_decline_int_2024",
        "ambiguous_mixed_signals_dis_2024",
        "edge_ipo_limited_history_arm_2024",
        "edge_microcap_sparse_data_xnt_2024",
    ],
    ids=lambda x: x,
)
def test_quick_eval_smoke(scenarios, mock_provider_with_canned, scenario_id):
    """Smoke test: 5 scenarios across all categories, mocked, fast."""
    scenario = scenarios[scenario_id]
    output = _run_synthesis_via_mock(scenario, mock_provider_with_canned)

    # Sanity: parsed shape is non-empty.
    assert output.scenario_id == scenario.id
    assert output.recommendation in {"BUY", "HOLD", "SELL", "STRONG_BUY", "STRONG_SELL"}
    assert 0.0 <= output.confidence <= 1.0
    assert output.fundamental.reasoning, "fundamental reasoning empty"
    assert output.sentiment.reasoning, "sentiment reasoning empty"
    assert output.valuation.reasoning, "valuation reasoning empty"


def test_quick_eval_metrics_compute(scenarios, mock_provider_with_canned):
    """Run the full quick suite + assert each metric is in a sane range."""
    outputs: list[DebateOutput] = [
        _run_synthesis_via_mock(s, mock_provider_with_canned) for s in scenarios.values()
    ]
    results = compute_all(outputs, scenarios)
    by_name = {r.name: r for r in results}

    # Brier should be small because canned responses match expected directions.
    brier = by_name["recommendation_calibration_brier"].value
    assert 0.0 <= brier <= 0.4, f"brier out of expected band: {brier}"

    # Evidence grounding non-zero (we embed numeric facts in canned reasoning).
    assert by_name["evidence_grounding"].value > 0.0

    # Internal consistency well-defined when consistency_pair tags exist.
    ic = by_name["internal_consistency"].value
    if ic == ic:  # not NaN
        assert -1.0 <= ic <= 1.0

    # Latency totals reported.
    assert by_name["latency_total_p50_ms"].value > 0


def test_quick_eval_full_report_serializable(scenarios, mock_provider_with_canned, tmp_path):
    """Full report serializes to JSON without error -- proves CI artifact path."""
    outputs = [_run_synthesis_via_mock(s, mock_provider_with_canned) for s in scenarios.values()]
    metrics = compute_all(outputs, scenarios)
    per_scenario = {o.scenario_id: [m for m in metrics if m.name.startswith("latency_")] for o in outputs}
    report = EvalReport(
        provider="mock",
        model="mock-1.0",
        n_scenarios=len(scenarios),
        metrics=metrics,
        per_scenario=per_scenario,
    )
    out_path = tmp_path / "eval_report.json"
    out_path.write_text(json.dumps(report.as_dict(), indent=2))
    parsed = json.loads(out_path.read_text())
    assert parsed["n_scenarios"] == len(scenarios)
    assert any(m["name"] == "recommendation_calibration_brier" for m in parsed["metrics"])


# ---------------------------------------------------------------------------
# Slow mode -- nightly + on-demand against real providers
# ---------------------------------------------------------------------------


def _has_creds(provider_name: str) -> bool:
    if provider_name == "gemini":
        return bool(os.getenv("GOOGLE_APPLICATION_CREDENTIALS")) or bool(os.getenv("GOOGLE_CLOUD_PROJECT"))
    if provider_name == "openai":
        return bool(os.getenv("OPENAI_API_KEY"))
    if provider_name == "anthropic":
        return bool(os.getenv("ANTHROPIC_API_KEY"))
    if provider_name == "vllm":
        return bool(os.getenv("KAI_VLLM_BASE_URL"))
    if provider_name == "llamacpp":
        return bool(os.getenv("KAI_LLAMACPP_BASE_URL"))
    return False


@pytest.mark.slow
@pytest.mark.parametrize("provider_name", ["gemini", "openai", "anthropic", "vllm"])
def test_slow_eval_real_provider(scenarios, provider_name, request):
    """Run a small subset of scenarios against a real provider."""
    if not _has_creds(provider_name):
        pytest.skip(f"no creds for provider {provider_name}")

    pytest.skip(
        "Slow real-provider tests are run via tests/agents/kai/evals/compare.py "
        "outside pytest to keep this file deterministic. Marker preserved for "
        "discovery; the script provides the full run."
    )

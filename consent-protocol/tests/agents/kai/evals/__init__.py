# tests/agents/kai/evals/__init__.py
"""
Kai multi-agent debate evaluation harness.

This package provides reproducible, regression-resistant evaluation for
Kai's Fundamental, Sentiment, Valuation, and Renaissance agents and
the debate that synthesizes them into a final recommendation.

Structure:

    scenarios/                Hand-curated golden scenarios (YAML)
    snapshots/                Captured baseline outputs per provider
    runner.py                 pytest-parameterized eval runner
    metrics.py                The 5 quality metrics
    schema.py                 Scenario / Output / Report dataclasses
    fixtures.py               Shared pytest fixtures

Run quick (5 scenarios, PR-time):
    uv run pytest tests/agents/kai/evals -k quick -m "not slow"

Run full (all scenarios, nightly):
    uv run pytest tests/agents/kai/evals -m slow

Compare providers:
    uv run python tests/agents/kai/evals/compare.py \
        --baseline gemini --candidate vllm --out reports/eval_compare.json
"""

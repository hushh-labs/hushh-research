# tests/agents/kai/evals/metrics.py
"""
The five quality metrics for Kai's debate engine.

1. Recommendation Calibration  (Brier score)
   How well does Kai's stated confidence track its actual accuracy?
   A perfectly calibrated model with 80% confidence is right 80% of the
   time. Brier score = mean squared error of (confidence, outcome).
   Lower is better. 0.0 = perfect; 0.25 = a coin-flip baseline.

2. Evidence Grounding
   Fraction of debate-output claims that cite the user's PKM data,
   fetched SEC/market/sentiment data, or numeric facts present in the
   scenario inputs -- as opposed to claims sourced from the model's
   parametric memory. Higher is better. We measure with a heuristic
   citation-pattern check; the heuristic is conservative (false-negative
   biased), so improvements are real signal.

3. Internal Consistency
   For pairs of scenarios with structurally similar inputs but different
   tickers (we tag these "consistency_pair" in metadata), how similar
   are Kai's reasoning embeddings? Computed as cosine similarity. The
   metric is the *mean* over all consistency pairs. Higher is better up
   to a point -- 1.0 would mean Kai gives identical reasoning for two
   different stocks, which is bad. We report mean and std.

4. Debate Convergence
   Fraction of scenarios where Fundamental, Sentiment, and Valuation
   agree on the directional recommendation. Higher is better when
   compared on equivalent inputs across providers.

5. Latency p50/p95
   Wall-clock per agent and full debate, in milliseconds. Reported
   separately; not a quality metric per se but tracked for regressions.

Implementation notes
--------------------
The embedding step uses numpy + a deterministic hashing fallback when
sentence-transformers isn't available. This keeps the harness runnable
in CI without GPU and without network. The fallback is documented as
"approximate" -- it still discriminates similar vs. dissimilar text
well enough to detect *regressions*, which is the metric's actual job.
"""

from __future__ import annotations

import hashlib
import re
import statistics
from typing import Iterable, Optional

import numpy as np

from .schema import DebateOutput, MetricResult, Scenario


# ---------------------------------------------------------------------------
# 1. Recommendation Calibration -- Brier
# ---------------------------------------------------------------------------

_DIRECTION = {
    "STRONG_BUY": +2,
    "BUY": +1,
    "HOLD": 0,
    "SELL": -1,
    "STRONG_SELL": -2,
}


def _direction_match(predicted: str, expected: str) -> bool:
    """Coarse directional agreement (BUY-family vs SELL-family vs HOLD)."""
    p = _DIRECTION.get(predicted, 0)
    e = _DIRECTION.get(expected, 0)
    if e == 0:
        return p == 0
    return (p > 0 and e > 0) or (p < 0 and e < 0)


def recommendation_calibration(
    outputs: list[DebateOutput], scenarios: dict[str, Scenario]
) -> MetricResult:
    """Brier score for (confidence, correctness) pairs."""
    if not outputs:
        return MetricResult(name="recommendation_calibration_brier", value=0.0)
    squared_errors: list[float] = []
    correct = 0
    for o in outputs:
        s = scenarios[o.scenario_id]
        is_correct = _direction_match(o.recommendation, s.expected_recommendation)
        correct += int(is_correct)
        # confidence is the model's stated p(correct). Brier = (p - y)^2.
        squared_errors.append((o.confidence - (1.0 if is_correct else 0.0)) ** 2)
    brier = statistics.fmean(squared_errors)
    return MetricResult(
        name="recommendation_calibration_brier",
        value=brier,
        detail={
            "accuracy": correct / len(outputs),
            "n": len(outputs),
            "interpretation": "lower is better; 0.0 perfect, 0.25 random",
        },
    )


# ---------------------------------------------------------------------------
# 2. Evidence Grounding
# ---------------------------------------------------------------------------

# Heuristic patterns that suggest a claim is grounded in the supplied data.
_GROUNDING_PATTERNS = [
    r"\b(10-?K|10-?Q|8-?K|S-1|13F|Form\s*4)\b",  # SEC filings
    r"\b(revenue|EBITDA|FCF|free\s*cash\s*flow|gross\s*margin|operating\s*margin)\s*(?:of|=|:)?\s*\$?[\d.,]+",
    r"\bP/?E\s*(?:ratio)?\s*(?:of|=|:)?\s*[\d.]+",
    r"\bDCF\s*(?:value|valuation|target)?\s*(?:of|=|:)?\s*\$?[\d.,]+",
    r"per\s*the\s*(?:user'?s?|portfolio|holdings|profile)",
    r"\baccording to\b.*?\b(SEC|10-?K|filing|news|analyst)",
    r"\$\d[\d,.]*\s*(?:million|billion|M|B|bn|mn)",  # explicit dollar figures
    r"\b\d{1,3}(?:\.\d+)?%",  # explicit percentages
    r"FY\s*20\d{2}",  # fiscal year refs
]
_GROUNDING_RE = re.compile("|".join(_GROUNDING_PATTERNS), re.IGNORECASE)


def _split_claims(text: str) -> list[str]:
    """Naive sentence-ish split. Good enough for the heuristic."""
    # Drop bullet/list markers, then split on . ! ? followed by whitespace+caps.
    cleaned = re.sub(r"^[\s\-\*\u2022\d\.\)]+", "", text, flags=re.MULTILINE)
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z(])", cleaned)
    return [p.strip() for p in parts if len(p.strip()) > 12]


def evidence_grounding(outputs: list[DebateOutput]) -> MetricResult:
    if not outputs:
        return MetricResult(name="evidence_grounding", value=0.0)
    grounded_total = 0
    claims_total = 0
    per_scenario: dict[str, float] = {}
    for o in outputs:
        # Combine reasoning across agents + the debate rationale.
        bodies = [
            o.fundamental.reasoning,
            o.sentiment.reasoning,
            o.valuation.reasoning,
            (o.renaissance.reasoning if o.renaissance else ""),
            o.rationale,
        ]
        scenario_grounded = 0
        scenario_claims = 0
        for body in bodies:
            for claim in _split_claims(body):
                scenario_claims += 1
                if _GROUNDING_RE.search(claim):
                    scenario_grounded += 1
        if scenario_claims == 0:
            per_scenario[o.scenario_id] = 0.0
        else:
            per_scenario[o.scenario_id] = scenario_grounded / scenario_claims
        grounded_total += scenario_grounded
        claims_total += scenario_claims
    overall = (grounded_total / claims_total) if claims_total else 0.0
    return MetricResult(
        name="evidence_grounding",
        value=overall,
        detail={
            "claims_total": claims_total,
            "claims_grounded": grounded_total,
            "per_scenario": per_scenario,
            "interpretation": "higher is better; fraction of claims with explicit numeric/source citation",
        },
    )


# ---------------------------------------------------------------------------
# 3. Internal Consistency (cosine sim across consistency_pair scenarios)
# ---------------------------------------------------------------------------


def _embed(text: str, dim: int = 256) -> np.ndarray:
    """
    Deterministic, dependency-light embedding.

    We use a feature-hash bag-of-words: each token is hashed into one of
    `dim` buckets and incremented. This is approximate but stable across
    runs, requires no model download, and discriminates similar vs.
    dissimilar text well enough to detect regressions, which is the
    metric's actual job.

    If sentence-transformers is available, callers can swap this out
    via the `embedder=` kwarg on `internal_consistency`.
    """
    vec = np.zeros(dim, dtype=np.float32)
    if not text:
        return vec
    for tok in re.findall(r"[A-Za-z][A-Za-z0-9_'-]+", text.lower()):
        h = int(hashlib.md5(tok.encode("utf-8"), usedforsecurity=False).hexdigest(), 16)
        vec[h % dim] += 1.0
    norm = np.linalg.norm(vec)
    if norm == 0:
        return vec
    return vec / norm


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    if a.shape != b.shape:
        return 0.0
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def internal_consistency(
    outputs: list[DebateOutput],
    scenarios: dict[str, Scenario],
    embedder=_embed,
) -> MetricResult:
    """
    Mean cosine similarity over scenario pairs that share a
    `consistency_pair` tag in their `notes`. This catches the failure
    mode where Kai gives wildly different reasoning for two structurally
    similar inputs.
    """
    by_id = {o.scenario_id: o for o in outputs}
    pairs: list[tuple[str, str]] = []
    pair_tag_to_ids: dict[str, list[str]] = {}
    for s in scenarios.values():
        m = re.search(r"consistency_pair=(\S+)", s.notes or "")
        if not m:
            continue
        pair_tag_to_ids.setdefault(m.group(1), []).append(s.id)
    for ids in pair_tag_to_ids.values():
        if len(ids) >= 2:
            for i in range(len(ids)):
                for j in range(i + 1, len(ids)):
                    pairs.append((ids[i], ids[j]))

    if not pairs:
        return MetricResult(
            name="internal_consistency",
            value=float("nan"),
            detail={"interpretation": "no consistency_pair tags found"},
        )

    sims: list[float] = []
    for a_id, b_id in pairs:
        a, b = by_id.get(a_id), by_id.get(b_id)
        if a is None or b is None:
            continue
        text_a = "\n".join(
            [a.fundamental.reasoning, a.sentiment.reasoning, a.valuation.reasoning, a.rationale]
        )
        text_b = "\n".join(
            [b.fundamental.reasoning, b.sentiment.reasoning, b.valuation.reasoning, b.rationale]
        )
        sims.append(_cosine(embedder(text_a), embedder(text_b)))

    if not sims:
        return MetricResult(name="internal_consistency", value=float("nan"))

    return MetricResult(
        name="internal_consistency",
        value=statistics.fmean(sims),
        detail={
            "n_pairs": len(sims),
            "stdev": statistics.pstdev(sims) if len(sims) > 1 else 0.0,
            "min": min(sims),
            "max": max(sims),
            "interpretation": "higher is better up to ~0.85; 1.0 means identical reasoning for different stocks (bad)",
        },
    )


# ---------------------------------------------------------------------------
# 4. Debate Convergence
# ---------------------------------------------------------------------------


def _agent_direction(agent: Optional["AgentOutput"]) -> int:
    """Coerce one agent's signal to a direction in {-1, 0, +1}."""
    if agent is None:
        return 0
    if agent.score is not None:
        if agent.score > 0.15:
            return +1
        if agent.score < -0.15:
            return -1
        return 0
    cls = (agent.classification or "").lower()
    if "bull" in cls or "buy" in cls or "positive" in cls:
        return +1
    if "bear" in cls or "sell" in cls or "negative" in cls:
        return -1
    return 0


def debate_convergence(outputs: list[DebateOutput]) -> MetricResult:
    if not outputs:
        return MetricResult(name="debate_convergence", value=0.0)
    converged = 0
    for o in outputs:
        dirs = [
            _agent_direction(o.fundamental),
            _agent_direction(o.sentiment),
            _agent_direction(o.valuation),
        ]
        if dirs[0] == dirs[1] == dirs[2] and dirs[0] != 0:
            converged += 1
    return MetricResult(
        name="debate_convergence",
        value=converged / len(outputs),
        detail={
            "n_converged": converged,
            "n_total": len(outputs),
            "interpretation": "fraction of scenarios where all 3 specialists agreed on direction",
        },
    )


# ---------------------------------------------------------------------------
# 5. Latency
# ---------------------------------------------------------------------------


def _percentile(values: Iterable[float], p: float) -> float:
    arr = sorted(values)
    if not arr:
        return 0.0
    k = (len(arr) - 1) * p
    f = int(k)
    c = min(f + 1, len(arr) - 1)
    if f == c:
        return arr[f]
    return arr[f] + (arr[c] - arr[f]) * (k - f)


def latency(outputs: list[DebateOutput]) -> list[MetricResult]:
    if not outputs:
        return []
    per_agent: dict[str, list[float]] = {}
    totals: list[float] = []
    for o in outputs:
        total = 0
        for agent_name, ms in (o.latency_ms_per_agent or {}).items():
            per_agent.setdefault(agent_name, []).append(float(ms))
            total += int(ms)
        totals.append(float(total))
    out: list[MetricResult] = []
    out.append(
        MetricResult(
            name="latency_total_p50_ms",
            value=_percentile(totals, 0.5),
            detail={"unit": "ms"},
        )
    )
    out.append(
        MetricResult(
            name="latency_total_p95_ms",
            value=_percentile(totals, 0.95),
            detail={"unit": "ms"},
        )
    )
    for agent_name, vals in per_agent.items():
        out.append(
            MetricResult(
                name=f"latency_{agent_name}_p50_ms",
                value=_percentile(vals, 0.5),
                detail={"unit": "ms", "n": len(vals)},
            )
        )
    return out


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def compute_all(
    outputs: list[DebateOutput], scenarios: dict[str, Scenario]
) -> list[MetricResult]:
    """Run every metric and return the flat result list."""
    results: list[MetricResult] = []
    results.append(recommendation_calibration(outputs, scenarios))
    results.append(evidence_grounding(outputs))
    results.append(internal_consistency(outputs, scenarios))
    results.append(debate_convergence(outputs))
    results.extend(latency(outputs))
    return results

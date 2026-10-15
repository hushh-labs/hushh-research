"""Bounds, calibration and agreement statistics (pure Python, no new dependencies).

Gates use the exact one-sided Clopper-Pearson bound already shipped in
``drive_pipeline_evaluation``. Wilson is for display only. The independent unit
for packet gates is the family: at most one Ready packet per family counts.
"""

from __future__ import annotations

import hashlib
import math
import random
from collections import defaultdict
from collections.abc import Callable, Sequence

from hushh_mcp.services.drive_pipeline_evaluation import (
    exact_lower_bound,
    zero_failure_sample_size,
)

Z_ONE_SIDED_95 = 1.6448536269514722
TARGETS = (0.90, 0.95, 0.99, 0.995, 0.999)

__all__ = [
    "auroc",
    "brier",
    "cluster_bootstrap",
    "cohen_kappa",
    "expected_calibration_error",
    "exact_lower_bound",
    "hajek_mean",
    "horvitz_thompson_total",
    "mcnemar",
    "one_per_family",
    "risk_coverage",
    "summary",
    "wilson_lower",
    "wilson_zero_failure_sample_size",
    "zero_failure_sample_size",
    "zero_failure_table",
]


def wilson_lower(successes: int, trials: int, z: float = Z_ONE_SIDED_95) -> float | None:
    if not 0 <= successes <= trials:
        raise ValueError("invalid_binomial_counts")
    if trials == 0:
        return None
    p = successes / trials
    denominator = 1 + z * z / trials
    centre = p + z * z / (2 * trials)
    margin = z * math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials))
    return max(0.0, (centre - margin) / denominator)


def wilson_zero_failure_sample_size(target: float, z: float = Z_ONE_SIDED_95) -> int:
    """Smallest n whose zero-failure Wilson lower bound n/(n+z^2) reaches target."""
    return math.ceil(z * z * target / (1 - target) - 1e-9)


def failures_sample_size(target: float, failures: int, alpha: float = 0.05) -> int:
    """Smallest n with ``failures`` failures whose exact lower bound reaches target."""
    n = max(failures + 1, zero_failure_sample_size(target, alpha))
    while True:
        bound = exact_lower_bound(n - failures, n, alpha)
        if bound is not None and bound >= target:
            return n
        n += 1


def zero_failure_table() -> dict[str, int]:
    return {f"{target:.3f}": zero_failure_sample_size(target) for target in TARGETS}


def summary(successes: int, trials: int) -> dict:
    return {
        "successes": successes,
        "trials": trials,
        "rate": successes / trials if trials else None,
        "cp_lower_95": exact_lower_bound(successes, trials),
        "wilson_lower_95": wilson_lower(successes, trials),
    }


def _order_key(seed: int, value: str) -> str:
    return hashlib.sha256(f"{seed}\0{value}".encode()).hexdigest()


def one_per_family(
    rows: Sequence[dict],
    *,
    family: str = "family_key",
    seed: int = 0,
    rank: Callable[[dict], int] | None = None,
):
    """Keep exactly one row per family (deterministic, seed-ordered); rest are descriptive.

    Rows with a lower ``rank`` represent their family first, so a gate can make a
    family count as failed whenever any of its rows failed.
    """
    chosen: dict[str, dict] = {}

    def order(item: dict) -> tuple[int, str]:
        return (rank(item) if rank else 0, _order_key(seed, str(item.get("packet_key", ""))))

    for row in sorted(rows, key=order):
        key = row.get(family) or f"singleton:{row.get('packet_key')}"
        chosen.setdefault(key, row)
    return list(chosen.values())


def horvitz_thompson_total(values: Sequence[float], weights: Sequence[float]) -> float:
    if len(values) != len(weights):
        raise ValueError("length_mismatch")
    return math.fsum(v * w for v, w in zip(values, weights, strict=True))


def hajek_mean(values: Sequence[float], weights: Sequence[float]) -> float | None:
    total = math.fsum(weights)
    return horvitz_thompson_total(values, weights) / total if total else None


def cluster_bootstrap(
    rows: Sequence[dict],
    *,
    cluster: str,
    statistic: Callable[[list[dict]], float | None],
    replicates: int = 2000,
    seed: int = 20261015,
    alpha: float = 0.05,
) -> dict:
    """Percentile interval resampling whole clusters (families), never single rows."""
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        groups[str(row.get(cluster))].append(row)
    keys = sorted(groups)
    point = statistic(list(rows))
    if len(keys) < 2 or point is None:
        return {"estimate": point, "low": None, "high": None, "clusters": len(keys)}
    generator = random.Random(seed)  # noqa: S311 - reproducible resampling, not security
    draws = []
    for _ in range(replicates):
        sample = [row for _ in keys for row in groups[keys[generator.randrange(len(keys))]]]
        value = statistic(sample)
        if value is not None:
            draws.append(value)
    draws.sort()
    if not draws:
        return {"estimate": point, "low": None, "high": None, "clusters": len(keys)}
    low = draws[max(0, math.floor(alpha / 2 * len(draws)))]
    high = draws[min(len(draws) - 1, math.ceil((1 - alpha / 2) * len(draws)) - 1)]
    return {"estimate": point, "low": low, "high": high, "clusters": len(keys)}


def expected_calibration_error(
    probabilities: Sequence[float],
    outcomes: Sequence[int],
    *,
    bins: int = 10,
    min_per_bin: int = 10,
) -> float | None:
    """Equal-mass bins. Returns None when any bin would hold fewer than min_per_bin."""
    if len(probabilities) != len(outcomes):
        raise ValueError("length_mismatch")
    n = len(probabilities)
    if n < bins * min_per_bin:
        return None
    ordered = sorted(zip(probabilities, outcomes, strict=True), key=lambda item: item[0])
    error = 0.0
    for index in range(bins):
        start, end = index * n // bins, (index + 1) * n // bins
        chunk = ordered[start:end]
        confidence = math.fsum(p for p, _ in chunk) / len(chunk)
        accuracy = sum(o for _, o in chunk) / len(chunk)
        error += len(chunk) / n * abs(confidence - accuracy)
    return error


def brier(probabilities: Sequence[float], outcomes: Sequence[int]) -> float | None:
    if not probabilities:
        return None
    return math.fsum((p - o) ** 2 for p, o in zip(probabilities, outcomes, strict=True)) / len(
        probabilities
    )


def auroc(scores: Sequence[float], outcomes: Sequence[int]) -> float | None:
    """Mann-Whitney probability that a positive outranks a negative (ties count half)."""
    positives = [s for s, o in zip(scores, outcomes, strict=True) if o]
    negatives = [s for s, o in zip(scores, outcomes, strict=True) if not o]
    if not positives or not negatives:
        return None
    wins = 0.0
    for p in positives:
        for q in negatives:
            wins += 1.0 if p > q else 0.5 if p == q else 0.0
    return wins / (len(positives) * len(negatives))


def risk_coverage(scores: Sequence[float], outcomes: Sequence[int]) -> list[dict]:
    """Error rate among the most confident k rows, for every k (selective prediction)."""
    ordered = sorted(zip(scores, outcomes, strict=True), key=lambda item: -item[0])
    curve, errors = [], 0
    for k, (_, outcome) in enumerate(ordered, start=1):
        errors += 0 if outcome else 1
        curve.append({"coverage": k / len(ordered), "risk": errors / k})
    return curve


def cohen_kappa(first: Sequence[str], second: Sequence[str]) -> float | None:
    if len(first) != len(second):
        raise ValueError("length_mismatch")
    n = len(first)
    if n == 0:
        return None
    observed = sum(a == b for a, b in zip(first, second, strict=True)) / n
    categories = set(first) | set(second)
    expected = sum((first.count(c) / n) * (second.count(c) / n) for c in categories)
    if expected == 1:
        return 1.0 if observed == 1 else None
    return (observed - expected) / (1 - expected)


def mcnemar(b: int, c: int) -> dict:
    """Paired anchor comparison. b: pass->fail, c: fail->pass discordant pairs."""
    if b < 0 or c < 0:
        raise ValueError("invalid_counts")
    n = b + c
    if n == 0:
        return {"b": b, "c": c, "exact_p": 1.0, "chi2_cc": 0.0}
    k = min(b, c)
    tail = math.fsum(math.comb(n, i) for i in range(k + 1)) / 2**n
    return {
        "b": b,
        "c": c,
        "exact_p": min(1.0, 2 * tail),
        "chi2_cc": (abs(b - c) - 1) ** 2 / n,
    }

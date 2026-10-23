"""Gene: a sparse softmax-linear scorer whose weights are data, not code.

Used for both the text-start signal and the Drive-metadata signal. The weights
are learned offline from labelled examples (``scripts/train_drive_groups.py``)
and read from a JSON file; nothing here knows what any feature means.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TypeGuard

from hushh_mcp.services.drive_groups.contract import CLASSES

MAX_FEATURES = 60_000


def tfidf_vector(counts: Mapping[str, float], idf: Mapping[str, float]) -> dict[str, float]:
    """L2-normalised sublinear tf-idf over the features the model knows."""
    weighted = {
        feature: (1.0 + math.log(count)) * idf[feature]
        for feature, count in counts.items()
        if count > 0 and feature in idf
    }
    norm = math.sqrt(sum(value * value for value in weighted.values()))
    return {feature: value / norm for feature, value in weighted.items()} if norm else {}


def softmax(scores: list[float]) -> tuple[float, ...]:
    top = max(scores)
    exps = [math.exp(score - top) for score in scores]
    total = sum(exps)
    return tuple(value / total for value in exps)


@dataclass(frozen=True, slots=True)
class LinearModel:
    idf: Mapping[str, float]
    weights: Mapping[str, tuple[float, ...]]
    intercept: tuple[float, ...]

    def probabilities(self, counts: Mapping[str, float]) -> tuple[float, ...] | None:
        """Probabilities over CLASSES, or None when no feature is known to the model."""
        vector = tfidf_vector(counts, self.idf)
        if not vector:
            return None
        scores = list(self.intercept)
        for feature, value in vector.items():
            for index, weight in enumerate(self.weights[feature]):
                scores[index] += weight * value
        return softmax(scores)

    @classmethod
    def from_payload(cls, payload: object) -> LinearModel:
        """Validate and build a model; any malformed number or shape raises ValueError."""
        if not isinstance(payload, dict) or payload.get("kind") != "linear_v1":
            raise ValueError("not a linear model")
        features, intercept = payload.get("features"), payload.get("intercept")
        width = len(CLASSES)
        if (
            payload.get("classes") != list(CLASSES)
            or not isinstance(features, dict)
            or not 1 <= len(features) <= MAX_FEATURES
            or not numbers(intercept, width)
        ):
            raise ValueError("invalid linear model")
        idf, weights = {}, {}
        for feature, row in features.items():
            if not isinstance(feature, str) or not numbers(row, 1 + width) or row[0] <= 0:
                raise ValueError("invalid linear model feature")
            idf[feature], weights[feature] = float(row[0]), tuple(float(v) for v in row[1:])
        return cls(idf, weights, tuple(float(v) for v in intercept))


def numbers(value: object, length: int) -> TypeGuard[list[float]]:
    """A list of exactly ``length`` finite numbers (never a bool)."""
    return (
        isinstance(value, list)
        and len(value) == length
        and all(type(item) in (int, float) and math.isfinite(item) for item in value)
    )

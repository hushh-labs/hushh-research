"""Gene: similarity of a text-start embedding to group centroids and definitions.

Pure. The vectors come from the pinned E5 model and are unit length. Each class
has a centroid of labelled examples; each group also has the embedding of its
written definition, which needs no labels. A small learned layer turns the nine
similarities into probabilities; its weights, centroids and definitions are data.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from hushh_mcp.services.drive_groups.contract import CLASSES, EMBEDDING_DIMENSIONS, GROUP_IDS
from hushh_mcp.services.drive_groups.linear_model import numbers, softmax

FEATURES = len(CLASSES) + len(GROUP_IDS)


def _unit(vector: object) -> tuple[float, ...]:
    if (
        not isinstance(vector, list | tuple)
        or len(vector) != EMBEDDING_DIMENSIONS
        or any(type(item) not in (int, float) or not math.isfinite(item) for item in vector)
    ):
        raise ValueError("invalid embedding vector")
    if not 0.98 <= math.fsum(item * item for item in vector) <= 1.02:
        raise ValueError("embedding is not unit length")
    return tuple(float(item) for item in vector)


def _dot(left: tuple[float, ...], right: tuple[float, ...]) -> float:
    return math.fsum(a * b for a, b in zip(left, right, strict=True))


@dataclass(frozen=True, slots=True)
class EmbeddingModel:
    centroids: tuple[tuple[float, ...], ...]
    definitions: tuple[tuple[float, ...], ...]
    mean: tuple[float, ...]
    scale: tuple[float, ...]
    weights: tuple[tuple[float, ...], ...]
    intercept: tuple[float, ...]

    def similarities(self, vector: tuple[float, ...]) -> tuple[float, ...]:
        """Cosine to each class centroid, then to each group definition."""
        unit = _unit(vector)
        return tuple(_dot(unit, other) for other in (*self.centroids, *self.definitions))

    def probabilities(self, vector: tuple[float, ...]) -> tuple[float, ...]:
        similarities = self.similarities(vector)
        standard = [
            (value - mean) / scale
            for value, mean, scale in zip(similarities, self.mean, self.scale, strict=True)
        ]
        return softmax(
            [
                bias + math.fsum(w * x for w, x in zip(row, standard, strict=True))
                for row, bias in zip(self.weights, self.intercept, strict=True)
            ]
        )

    @classmethod
    def from_payload(cls, payload: object) -> EmbeddingModel:
        if not isinstance(payload, dict) or payload.get("kind") != "embedding_v1":
            raise ValueError("not an embedding model")
        centroids, definitions = payload.get("centroids"), payload.get("definitions")
        mean, scale = payload.get("mean"), payload.get("scale")
        weights, intercept = payload.get("weights"), payload.get("intercept")
        if (
            payload.get("classes") != list(CLASSES)
            or not isinstance(centroids, list)
            or len(centroids) != len(CLASSES)
            or not isinstance(definitions, list)
            or len(definitions) != len(GROUP_IDS)
            or not numbers(mean, FEATURES)
            or not numbers(scale, FEATURES)
            or any(item <= 0 for item in scale)
            or not isinstance(weights, list)
            or len(weights) != len(CLASSES)
            or any(not numbers(item, FEATURES) for item in weights)
            or not numbers(intercept, len(CLASSES))
        ):
            raise ValueError("invalid embedding model")
        return cls(
            tuple(_unit(item) for item in centroids),
            tuple(_unit(item) for item in definitions),
            tuple(float(v) for v in mean),
            tuple(float(v) for v in scale),
            tuple(tuple(float(v) for v in item) for item in weights),
            tuple(float(v) for v in intercept),
        )

"""Gene: calibrated fusion of the three signals into one precision-first decision.

Pure. Each signal gives probabilities over the classes. They are pooled in the
log domain with one learned weight per signal; the weights are what calibrate
the result into a confidence. A file is placed only when that confidence, its
lead over the runner-up and the agreement of the signals all clear the policy;
every other file is kept. A signal with no evidence is left out, which lowers the
total weight and so the confidence: less evidence never raises it. The policy
numbers are data fitted offline, never edited by hand
(``scripts/train_drive_groups.py``).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from hushh_mcp.services.drive_groups.contract import (
    CLASSES,
    GROUP_IDS,
    NONE_CLASS,
    SIGNALS,
    GroupId,
    Placement,
    SignalReading,
)
from hushh_mcp.services.drive_groups.linear_model import softmax

_FLOOR = 1e-6


@dataclass(frozen=True, slots=True)
class FusionPolicy:
    weights: tuple[float, float, float]
    slope: float
    intercept: float
    min_confidence: float
    min_margin: float
    min_agreement: int

    @classmethod
    def from_payload(cls, payload: object) -> FusionPolicy:
        if not isinstance(payload, dict):
            raise ValueError("invalid fusion policy")
        named, platt = payload.get("weights"), payload.get("calibration")
        agreement = payload.get("min_agreement")
        if (
            not isinstance(named, dict)
            or set(named) != set(SIGNALS)
            or not isinstance(platt, dict)
            or type(agreement) is not int
            or not 1 <= agreement <= len(SIGNALS)
        ):
            raise ValueError("invalid fusion policy")
        text, embedding, metadata = (_finite(named[name]) for name in SIGNALS)
        slope, intercept = _finite(platt.get("slope")), _finite(platt.get("intercept"))
        confidence, margin = (
            _finite(payload.get("min_confidence")),
            _finite(payload.get("min_margin")),
        )
        if (
            min(text, embedding, metadata) < 0
            or slope <= 0
            or not 0 < confidence <= 1
            or not 0 <= margin <= 1
        ):
            raise ValueError("invalid fusion policy")
        return cls((text, embedding, metadata), slope, intercept, confidence, margin, agreement)


def _finite(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        raise ValueError("invalid fusion policy")
    return float(value)


def pooled(readings: Sequence[SignalReading], policy: FusionPolicy) -> tuple[float, ...] | None:
    """Calibrated probabilities over CLASSES, or None when no signal has evidence."""
    scores = [0.0] * len(CLASSES)
    seen = False
    for reading in readings:
        weight = policy.weights[SIGNALS.index(reading.name)]
        if reading.probabilities is None or weight == 0:
            continue
        seen = True
        for index, probability in enumerate(reading.probabilities):
            scores[index] += weight * math.log(max(probability, _FLOOR))
    return softmax(scores) if seen else None


def calibrated(probability: float, policy: FusionPolicy) -> float:
    """Platt map of the pooled probability of the best class into a confidence."""
    clipped = min(max(probability, _FLOOR), 1 - _FLOOR)
    logit = math.log(clipped / (1 - clipped))
    return 1 / (1 + math.exp(-(policy.slope * logit + policy.intercept)))


def fuse(readings: Sequence[SignalReading], policy: FusionPolicy, version: str) -> Placement:
    posterior = pooled(readings, policy)
    if posterior is None:
        return Placement(
            group=None,
            candidate=None,
            best_class=NONE_CLASS,
            confidence=0.0,
            margin=0.0,
            reason="no_evidence",
            readings=tuple(readings),
            version=version,
        )
    order = sorted(range(len(CLASSES)), key=posterior.__getitem__, reverse=True)
    best = CLASSES[order[0]]
    candidate: GroupId = max(GROUP_IDS, key=lambda group: posterior[CLASSES.index(group)])
    margin = posterior[order[0]] - posterior[order[1]]
    confidence = calibrated(posterior[order[0]], policy)
    voting = [
        reading
        for reading in readings
        if reading.available and policy.weights[SIGNALS.index(reading.name)] > 0
    ]
    agreeing = sum(reading.top == best for reading in voting)
    if best == NONE_CLASS:
        reason = "fits_none"
    elif confidence < policy.min_confidence:
        reason = "low_confidence"
    elif margin < policy.min_margin:
        reason = "low_margin"
    elif agreeing < min(policy.min_agreement, len(voting)):
        reason = "disagreement"
    else:
        reason = "placed"
    return Placement(
        group=candidate if reason == "placed" else None,
        candidate=candidate,
        best_class=best,
        confidence=confidence,
        margin=margin,
        reason=reason,
        readings=tuple(readings),
        version=version,
    )

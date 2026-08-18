"""ADK-native wrapper for the parity oracle + the golden-journey corpus loader.

The oracle (`parity_oracle`) is pure and ADK-free so the pod side can hold it.
This module binds it to ``google.adk.evaluation`` so a parity journey is an
ordinary ADK eval and a parity result flows through ADK's status/score types --
the "leverage the framework, don't reinvent it" line the ADK docs draw for
continuous evaluation.

A journey is a JSON fixture: a scripted hub frame stream, the pod turn dict it
must be compared against, the equivalence mode, and a POSITIVE assertion (the
hub MUST contain directive/specialist X). The positive assertion is what makes a
green run meaningful: without it, a journey where neither side does anything
would "pass" vacuously. The corpus grows one fixture per newly-found break --
loop-until-dry over real journeys -- so the ruler only ever gets stricter.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from hushh_mcp.observability.parity_oracle import (
    EquivalenceMode,
    ParityDiff,
    classify,
    observe_hub,
    observe_pod,
)

CORPUS_DIR = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "parity_journeys"


@dataclass(frozen=True)
class ParityJourney:
    """One golden journey: a hub reference, a pod turn, and what must be present."""

    name: str
    mode: EquivalenceMode
    hub_frames: list[dict[str, Any]]
    hub_grounded: bool
    pod_turn: dict[str, Any]
    pod_specialist_statuses: list[dict[str, str]]
    #: The non-vacuity guard. The hub reference MUST contain at least these
    #: directive kinds / specialist ids, or the journey is malformed (asserting
    #: parity of two empty turns proves nothing).
    expect_hub_directive_kinds: list[str]
    expect_hub_specialists: list[str]

    @staticmethod
    def from_json(path: Path) -> "ParityJourney":
        raw = json.loads(path.read_text())
        return ParityJourney(
            name=raw.get("name") or path.stem,
            mode=EquivalenceMode(raw.get("mode") or "exact"),
            hub_frames=list(raw.get("hub_frames") or []),
            hub_grounded=bool(raw.get("hub_grounded", False)),
            pod_turn=dict(raw.get("pod_turn") or {}),
            pod_specialist_statuses=list(raw.get("pod_specialist_statuses") or []),
            expect_hub_directive_kinds=list(raw.get("expect_hub_directive_kinds") or []),
            expect_hub_specialists=list(raw.get("expect_hub_specialists") or []),
        )

    def assert_reference_is_not_vacuous(self) -> None:
        """A journey whose hub side asserts nothing cannot certify parity."""
        obs = observe_hub(self.hub_frames, grounded=self.hub_grounded)
        got_kinds = {d.kind for d in obs.directives}
        for kind in self.expect_hub_directive_kinds:
            if kind not in got_kinds:
                raise AssertionError(
                    f"journey '{self.name}' is vacuous: hub reference lacks required "
                    f"directive kind '{kind}' (has {sorted(got_kinds)})"
                )
        got_specialists = {s.agent_id for s in obs.specialists if s.served}
        for agent_id in self.expect_hub_specialists:
            if agent_id not in got_specialists:
                raise AssertionError(
                    f"journey '{self.name}' is vacuous: hub reference lacks served "
                    f"specialist '{agent_id}' (has {sorted(got_specialists)})"
                )

    def run(self) -> ParityDiff:
        """Observe both paths from delivered bytes and classify the divergence."""
        self.assert_reference_is_not_vacuous()
        hub = observe_hub(self.hub_frames, grounded=self.hub_grounded)
        pod = observe_pod(self.pod_turn, specialist_statuses=self.pod_specialist_statuses)
        return classify(pod, hub, self.mode)


def load_corpus(corpus_dir: Path = CORPUS_DIR) -> list[ParityJourney]:
    """Every golden journey on disk, sorted for deterministic parametrization."""
    if not corpus_dir.exists():
        return []
    return [ParityJourney.from_json(p) for p in sorted(corpus_dir.glob("*.json"))]


# ---- ADK Evaluator binding ---------------------------------------------------


def build_adk_parity_evaluator() -> Any:
    """A ``google.adk.evaluation.evaluator.Evaluator`` scoring parity as [0,1].

    Deferred import so the pure oracle stays ADK-free for the pod. Returns an
    evaluator whose ``evaluate_invocations`` maps a parity diff to ADK's
    ``EvalStatus`` -- PASSED at parity, FAILED otherwise -- so parity plugs into
    ADK result managers and thresholds unchanged.
    """
    from google.adk.evaluation.evaluator import EvalStatus, Evaluator

    class PodParityEvaluator(Evaluator):
        """Hub-referenced parity as an ADK metric.

        Score is 1.0 at parity, else 1 - (failures / max_classes), so a partial
        recovery (one class fixed) moves the number, which is what makes this a
        LEARNING signal rather than a boolean gate.
        """

        _MAX_CLASSES = 5

        def criterion_type(self):  # pragma: no cover - ADK plumbing
            return None

        def evaluate_invocations(
            self, actual_invocations, expected_invocations=None, conversation_scenario=None
        ):
            # actual/expected are ADK Invocations carrying our observations in
            # their custom fields; the harness passes ParityJourney results
            # directly in tests, so this path is for ADK-run eval sets.
            diffs: list[ParityDiff] = []
            for inv in actual_invocations or []:
                diff = getattr(inv, "parity_diff", None)
                if isinstance(diff, ParityDiff):
                    diffs.append(diff)
            if not diffs:
                return _adk_result(EvalStatus.NOT_EVALUATED, 0.0)
            total = 0.0
            worst = EvalStatus.PASSED
            for d in diffs:
                score = 1.0 if d.at_parity else max(0.0, 1.0 - len(d.failures) / self._MAX_CLASSES)
                total += score
                if not d.at_parity:
                    worst = EvalStatus.FAILED
            return _adk_result(worst, total / len(diffs))

    return PodParityEvaluator()


def _adk_result(status: Any, score: float) -> Any:
    try:
        from google.adk.evaluation.evaluator import EvaluationResult

        return EvaluationResult(overall_eval_status=status, overall_score=score)
    except Exception:  # noqa: BLE001 - shape varies across ADK minors; degrade to a tuple
        return (status, score)


__all__ = [
    "CORPUS_DIR",
    "ParityJourney",
    "build_adk_parity_evaluator",
    "load_corpus",
]

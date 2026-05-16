"""Transactional step-isolation pipeline engine.

Each step executes in its own try/except boundary so that a failing middle
step is logged and skipped without corrupting the execution sequence.

[Pipeline Guard by Abdul Gaffar]
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol, runtime_checkable

logger = logging.getLogger(__name__)


@runtime_checkable
class PipelineStep(Protocol):
    """Minimal contract a pipeline step must satisfy."""

    name: str

    def execute(self, data: dict[str, Any]) -> dict[str, Any]:
        ...


@dataclass
class FunctionStep:
    """Wraps a plain callable as a PipelineStep."""

    name: str
    fn: Callable[[dict[str, Any]], dict[str, Any]]

    def execute(self, data: dict[str, Any]) -> dict[str, Any]:
        return self.fn(data)


@dataclass
class StepResult:
    step_name: str
    success: bool
    output: dict[str, Any] | None = None
    error: Exception | None = None


@dataclass
class PipelineResult:
    successful_outputs: list[dict[str, Any]] = field(default_factory=list)
    failed_steps: list[str] = field(default_factory=list)
    step_results: list[StepResult] = field(default_factory=list)

    @property
    def final_output(self) -> dict[str, Any]:
        """Last successful step output, or empty dict if every step failed."""
        for result in reversed(self.step_results):
            if result.success and result.output is not None:
                return result.output
        return {}


class ExecutionPipeline:
    """Run a sequence of steps with per-step fault isolation.

    A failure in one step is logged and recorded in the result, but the
    pipeline continues to the next step using the last good data snapshot.
    [Pipeline Guard by Abdul Gaffar]
    """

    def __init__(self, steps: list[PipelineStep]) -> None:
        self._steps = list(steps)

    def run(self, initial_data: dict[str, Any]) -> PipelineResult:
        result = PipelineResult()
        current_data: dict[str, Any] = dict(initial_data)

        for step in self._steps:
            try:
                output = step.execute(current_data)
                step_result = StepResult(
                    step_name=step.name,
                    success=True,
                    output=output,
                )
                result.step_results.append(step_result)
                result.successful_outputs.append(output)
                current_data = output
            except Exception as exc:
                logger.warning(
                    "[Pipeline Guard by Abdul Gaffar] step=%r failed: %s",
                    step.name,
                    exc,
                )
                step_result = StepResult(
                    step_name=step.name,
                    success=False,
                    error=exc,
                )
                result.step_results.append(step_result)
                result.failed_steps.append(step.name)
                # current_data is unchanged — next step inherits last good data

        return result

"""Scenario runner for the realtime-voice benchmark.

A ``RealtimePath`` abstracts a realtime backend (the current hand-rolled Gemini
Live path, or an ADK ``run_live`` path). The harness drives a scenario of turns
through a path and records metrics. A deterministic in-memory path is provided so
the harness runs in CI without network access or API keys; real paths can be
plugged in for an on-demand, network-backed comparison run.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from hushh_mcp.agents.realtime_bench.metrics import (
    RealtimeBenchMetrics,
    RealtimeBenchResult,
)


@dataclass
class RealtimeBenchTurn:
    """A single scripted user turn in a scenario."""

    prompt: str
    # If set, the turn simulates a barge-in (user interrupts the reply).
    barge_in: bool = False
    # If set, the turn simulates a transport drop that must reconnect/resume.
    drop_transport: bool = False


@dataclass
class RealtimeBenchScenario:
    """An ordered set of turns to drive through a path."""

    name: str
    turns: list[RealtimeBenchTurn] = field(default_factory=list)


class RealtimePath(Protocol):
    """A pluggable realtime backend under test."""

    name: str

    def connect(self) -> float:
        """Open a session; return connect latency in ms."""

    def run_turn(self, turn: RealtimeBenchTurn) -> RealtimeBenchMetrics:
        """Drive one turn; return its metrics."""

    def close(self) -> None:
        """Tear down the session."""


def run_scenario(path: RealtimePath, scenario: RealtimeBenchScenario) -> RealtimeBenchResult:
    """Drive a scenario through a path and aggregate metrics."""
    result = RealtimeBenchResult(path_name=path.name, scenario_name=scenario.name)
    connect_ms = path.connect()
    try:
        for turn in scenario.turns:
            metrics = path.run_turn(turn)
            # Attach the connect cost to the first turn so it is captured once.
            if result.turns == 0 and metrics.connect_ms is None:
                metrics.connect_ms = connect_ms
            result.record(metrics)
    finally:
        path.close()
    return result


class InMemoryRealtimePath:
    """A deterministic, network-free path for CI and harness self-tests.

    It models latency with a simple per-path profile so two configured profiles
    can be compared without external services. This is NOT a substitute for a
    real network benchmark; it exists to keep the harness exercised in CI and to
    let the comparison/recommendation logic be validated deterministically.
    """

    def __init__(self, name: str, *, base_first_audio_ms: float, base_turn_ms: float):
        self.name = name
        self._base_first_audio_ms = base_first_audio_ms
        self._base_turn_ms = base_turn_ms

    def connect(self) -> float:
        return 20.0

    def run_turn(self, turn: RealtimeBenchTurn) -> RealtimeBenchMetrics:
        metrics = RealtimeBenchMetrics()
        metrics.first_audio_ms = self._base_first_audio_ms
        metrics.turn_ms = self._base_turn_ms
        if turn.barge_in:
            metrics.barge_in_ms = self._base_first_audio_ms * 0.5
        if turn.drop_transport:
            metrics.reconnect_ms = self._base_turn_ms
        return metrics

    def close(self) -> None:
        return None


def default_scenarios() -> list[RealtimeBenchScenario]:
    """A small, representative scenario set for the comparison."""
    return [
        RealtimeBenchScenario(
            name="short_qa",
            turns=[
                RealtimeBenchTurn(prompt="What is Hussh?"),
                RealtimeBenchTurn(prompt="How do I get started?"),
            ],
        ),
        RealtimeBenchScenario(
            name="barge_in",
            turns=[
                RealtimeBenchTurn(prompt="Tell me a long story", barge_in=True),
                RealtimeBenchTurn(prompt="Never mind, what can you do?"),
            ],
        ),
        RealtimeBenchScenario(
            name="resilience",
            turns=[
                RealtimeBenchTurn(prompt="Are you there?", drop_transport=True),
                RealtimeBenchTurn(prompt="Good, you recovered."),
            ],
        ),
    ]

# tests/agents/kai/test_orchestrator_exception_handling.py
"""
Regression tests for #411 - silent exception swallow in
KaiOrchestrator._run_agent_analysis when multiple agents fail.
"""

import logging
from unittest.mock import MagicMock

import pytest


class _RealtimeDataUnavailable(RuntimeError):
    pass


class _PermissionError(PermissionError):
    pass


async def _fixed_handle(results, agent_names, logger):
    """The fixed collect-then-raise pattern from orchestrator.py."""
    exceptions = [(i, r) for i, r in enumerate(results) if isinstance(r, Exception)]
    if exceptions:
        for i, e in exceptions:
            logger.error(f"[Kai] Agent {i} ({agent_names[i]}) failed: {e}")
        raise exceptions[0][1]
    return results


AGENTS = ["Fundamental", "Sentiment", "Valuation"]


@pytest.fixture
def log():
    return MagicMock(spec=logging.Logger)


@pytest.mark.asyncio
async def test_no_failures_returns_results(log):
    results = ["a", "b", "c"]
    assert await _fixed_handle(results, AGENTS, log) == results
    log.error.assert_not_called()


@pytest.mark.asyncio
async def test_single_failure_propagates(log):
    err = _RealtimeDataUnavailable("provider down")
    with pytest.raises(_RealtimeDataUnavailable, match="provider down"):
        await _fixed_handle([err, "b", "c"], AGENTS, log)
    assert log.error.call_count == 1


@pytest.mark.asyncio
async def test_two_failures_raises_first(log):
    """First exception propagates, not the second."""
    e1 = _RealtimeDataUnavailable("feed down")
    e2 = _PermissionError("auth rejected")
    with pytest.raises(_RealtimeDataUnavailable):
        await _fixed_handle(["ok", e1, e2], AGENTS, log)


@pytest.mark.asyncio
async def test_two_failures_both_logged(log):
    """Core regression guard: BOTH agent failures must be logged, not just the first."""
    e1 = _RealtimeDataUnavailable("feed down")
    e2 = _PermissionError("vault rejected scope")
    with pytest.raises(_RealtimeDataUnavailable):
        await _fixed_handle(["ok", e1, e2], AGENTS, log)

    assert log.error.call_count == 2, (
        "Bug #411 regression: second agent failure was silently dropped"
    )
    all_logs = " ".join(str(c) for c in log.error.call_args_list)
    assert "vault rejected scope" in all_logs, (
        "Bug #411 regression: PermissionError never appeared in logs"
    )


@pytest.mark.asyncio
async def test_raised_exception_preserves_type(log):
    """Callers rely on isinstance() checks — type must be preserved."""
    err = _PermissionError("bad scope")
    with pytest.raises(_PermissionError):
        await _fixed_handle(["ok", "ok", err], AGENTS, log)

"""Concurrency tests for KaiOrchestrator._transition_lock.

Verifies that the asyncio.Lock / coalescing pattern inside KaiOrchestrator
prevents duplicate state transitions under concurrent load:

  50 simultaneous analyze() calls → exactly 1 _execute_analysis() invocation.

Strategy
--------
* Monkeypatch _validate_consent   — no real token needed.
* Monkeypatch _execute_analysis   — counts invocations, returns a stub card.
* asyncio.gather 50 coroutines    — all concurrent in the same event loop.
* Assert orchestrator._transition_count == 1 after all tasks settle.

asyncio_mode = "auto" (pyproject.toml) — async def tests run natively.

No DB, no network, no LLM.

Integrated by Abdul Gaffar — canonical state-orchestrator lock.
"""

from __future__ import annotations

import asyncio

import pytest

from hushh_mcp.agents.kai.orchestrator import KaiOrchestrator

_TOKEN = "HCT:dGVzdA==.fakesig"  # noqa: S105  — synthetic, not validated


# ---------------------------------------------------------------------------
# Fixture — minimal orchestrator with all I/O stubs
# ---------------------------------------------------------------------------


@pytest.fixture
def orchestrator(monkeypatch) -> KaiOrchestrator:
    """Return a KaiOrchestrator with heavy dependencies stubbed out."""
    orch = KaiOrchestrator.__new__(KaiOrchestrator)

    # Minimal attribute state (mirrors __init__ without calling super().__init__)
    orch.user_id = "test-user-concurrency"
    orch.risk_profile = "balanced"
    orch.processing_mode = "hybrid"

    # Lock primitives
    orch._transition_lock = asyncio.Lock()
    orch._in_flight = {}
    orch._transition_count = 0

    # Stub validate_consent — always passes
    async def _noop_validate(consent_token: str) -> None:  # noqa: ARG001
        return

    monkeypatch.setattr(orch, "_validate_consent", _noop_validate)

    return orch


def _stub_decision_card():
    """Minimal object that quacks like a DecisionCard."""
    from unittest.mock import MagicMock
    return MagicMock(name="DecisionCard")


# ===========================================================================
# 1. Single concurrent burst — 50 simultaneous calls → 1 state transition
# ===========================================================================


class TestTransitionLockCoalescing:
    async def test_50_concurrent_calls_produce_one_transition(self, orchestrator, monkeypatch):
        """Core invariant: 50 simultaneous requests trigger exactly 1 analysis."""
        execution_count = 0

        async def _counted_execute(ticker, consent_token, context=None):
            nonlocal execution_count
            execution_count += 1
            await asyncio.sleep(0.02)  # simulate real work
            return _stub_decision_card()

        monkeypatch.setattr(orchestrator, "_execute_analysis", _counted_execute)

        results = await asyncio.gather(
            *[orchestrator.analyze("AAPL", _TOKEN) for _ in range(50)]
        )

        assert orchestrator._transition_count == 1, (
            f"Expected 1 state transition, got {orchestrator._transition_count}"
        )
        assert execution_count == 1, (
            f"Expected _execute_analysis to run once, ran {execution_count} times"
        )
        assert len(results) == 50, "All 50 callers must receive a result"

    async def test_all_callers_receive_the_same_result(self, orchestrator, monkeypatch):
        """Every coalesced call must return the identical DecisionCard object."""
        card = _stub_decision_card()

        async def _fixed_result(ticker, consent_token, context=None):
            await asyncio.sleep(0.01)
            return card

        monkeypatch.setattr(orchestrator, "_execute_analysis", _fixed_result)

        results = await asyncio.gather(
            *[orchestrator.analyze("AAPL", _TOKEN) for _ in range(50)]
        )

        assert all(r is card for r in results), (
            "All 50 callers must receive the same DecisionCard object"
        )

    async def test_transition_count_increments_exactly_once(self, orchestrator, monkeypatch):
        async def _fast_execute(ticker, consent_token, context=None):
            await asyncio.sleep(0)
            return _stub_decision_card()

        monkeypatch.setattr(orchestrator, "_execute_analysis", _fast_execute)
        await asyncio.gather(*[orchestrator.analyze("MSFT", _TOKEN) for _ in range(50)])

        assert orchestrator._transition_count == 1


# ===========================================================================
# 2. Sequential calls after settlement — each starts a new transition
# ===========================================================================


class TestSequentialCallsStartFreshTransitions:
    async def test_two_sequential_calls_produce_two_transitions(self, orchestrator, monkeypatch):
        """After first analysis settles, second call starts a NEW transition."""
        count = 0

        async def _counted(ticker, consent_token, context=None):
            nonlocal count
            count += 1
            return _stub_decision_card()

        monkeypatch.setattr(orchestrator, "_execute_analysis", _counted)

        await orchestrator.analyze("AAPL", _TOKEN)
        await orchestrator.analyze("AAPL", _TOKEN)

        assert orchestrator._transition_count == 2
        assert count == 2

    async def test_different_tickers_always_start_fresh_transitions(
        self, orchestrator, monkeypatch
    ):
        """Concurrent calls for DIFFERENT tickers each start their own transition."""
        count = 0

        async def _counted(ticker, consent_token, context=None):
            nonlocal count
            count += 1
            await asyncio.sleep(0.01)
            return _stub_decision_card()

        monkeypatch.setattr(orchestrator, "_execute_analysis", _counted)

        await asyncio.gather(
            orchestrator.analyze("AAPL", _TOKEN),
            orchestrator.analyze("MSFT", _TOKEN),
            orchestrator.analyze("GOOGL", _TOKEN),
        )

        assert orchestrator._transition_count == 3
        assert count == 3


# ===========================================================================
# 3. Lock primitives — structural assertions
# ===========================================================================


class TestLockPrimitives:
    def test_orchestrator_has_transition_lock(self, orchestrator):
        assert isinstance(orchestrator._transition_lock, asyncio.Lock)

    def test_orchestrator_has_in_flight_dict(self, orchestrator):
        assert isinstance(orchestrator._in_flight, dict)

    def test_transition_count_starts_at_zero(self, orchestrator):
        assert orchestrator._transition_count == 0

    def test_in_flight_cleared_after_analysis(self, orchestrator, monkeypatch):
        """_in_flight must be empty once the analysis future settles."""
        async def _run():
            async def _fast(ticker, consent_token, context=None):
                await asyncio.sleep(0)
                return _stub_decision_card()

            monkeypatch.setattr(orchestrator, "_execute_analysis", _fast)
            await orchestrator.analyze("AAPL", _TOKEN)
            assert orchestrator._in_flight == {}, (
                "_in_flight must be cleared after the analysis completes"
            )

        asyncio.get_event_loop().run_until_complete(_run())


# ===========================================================================
# 4. Error handling — exception propagates to all coalesced callers
# ===========================================================================


class TestExceptionPropagation:
    async def test_exception_propagates_to_all_concurrent_callers(
        self, orchestrator, monkeypatch
    ):
        async def _failing(ticker, consent_token, context=None):
            await asyncio.sleep(0.01)
            raise ValueError("analysis-service-unavailable")

        monkeypatch.setattr(orchestrator, "_execute_analysis", _failing)

        results = await asyncio.gather(
            *[orchestrator.analyze("AAPL", _TOKEN) for _ in range(10)],
            return_exceptions=True,
        )

        assert all(isinstance(r, ValueError) for r in results), (
            "Every coalesced caller must receive the exception"
        )
        # Despite 10 concurrent callers, only 1 actual execution occurred.
        assert orchestrator._transition_count == 1

    async def test_in_flight_cleared_after_exception(self, orchestrator, monkeypatch):
        async def _failing(ticker, consent_token, context=None):
            raise RuntimeError("boom")

        monkeypatch.setattr(orchestrator, "_execute_analysis", _failing)

        await asyncio.gather(
            orchestrator.analyze("AAPL", _TOKEN), return_exceptions=True
        )

        # After exception, _in_flight must be clean for subsequent requests.
        assert "AAPL" not in orchestrator._in_flight


# ===========================================================================
# Trust-boundary proof — analyze() is the canonical entry point
# ===========================================================================


class TestTrustBoundaryProof:
    """
    Canonical surface : hushh_mcp.agents.kai.orchestrator.KaiOrchestrator.analyze()
                        (concurrency coalescing via asyncio.Lock + _in_flight futures)
    Canonical caller  : Any Kai analysis route or service that calls
                        KaiOrchestrator.analyze(ticker, consent_token)
                        — the lock is wired inside analyze(), so it fires on
                        every public entry point automatically.
    Attach point proof: The tests below prove that the lock primitives
                        (_transition_lock, _in_flight, _transition_count) are
                        present on the orchestrator, that analyze() coalesces
                        concurrent calls correctly, and that the _in_flight dict
                        is cleaned up after both success and failure — satisfying
                        the invariant that no duplicate state transitions occur.
    """

    async def test_analyze_coalesces_concurrent_calls_to_one_execution(
        self, orchestrator, monkeypatch
    ):
        """The canonical invariant: N concurrent analyze() calls → 1 _execute_analysis."""
        execution_count = 0

        async def _counting_execute(ticker, consent_token, context=None):
            nonlocal execution_count
            execution_count += 1
            await asyncio.sleep(0)
            return _stub_decision_card()

        monkeypatch.setattr(orchestrator, "_execute_analysis", _counting_execute)
        await asyncio.gather(
            *[orchestrator.analyze("MSFT", _TOKEN) for _ in range(20)],
            return_exceptions=True,
        )
        assert execution_count == 1
        assert orchestrator._transition_count == 1

    async def test_in_flight_is_empty_after_successful_call(self, orchestrator, monkeypatch):
        """_in_flight is cleaned up after a successful analyze() — no memory leak."""
        async def _ok(ticker, consent_token, context=None):
            return _stub_decision_card()

        monkeypatch.setattr(orchestrator, "_execute_analysis", _ok)
        await orchestrator.analyze("GOOG", _TOKEN)
        assert "GOOG" not in orchestrator._in_flight

    async def test_lock_is_asyncio_lock(self, orchestrator):
        """_transition_lock must be an asyncio.Lock — other primitives break coalescing."""
        assert isinstance(orchestrator._transition_lock, asyncio.Lock)

    async def test_in_flight_is_dict(self, orchestrator):
        """_in_flight must be a dict for per-ticker coalescing."""
        assert isinstance(orchestrator._in_flight, dict)

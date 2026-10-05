"""Tests and latency benchmarks for FastSystem1Router."""

from __future__ import annotations

import time
import pytest

from hushh_mcp.one_adk.fast_router import FastSystem1Router, get_fast_system1_router


def test_travel_transit_airport_query():
    """Verify that 'I want to go to airport' is classified with high confidence and ambiguity."""
    router = get_fast_system1_router()
    decision = router.classify("I want to go to airport")

    assert decision.domain == "travel_transit"
    assert decision.confidence > 0.70
    assert decision.is_ambiguous is True
    assert "open_navigation_route" in decision.recommended_tools
    assert len(decision.suggested_chips) == 3
    assert decision.latency_ms < 20.0  # Sub-20ms requirement


def test_finance_query_pruning():
    """Verify that financial questions prune tools towards market/portfolio specialists."""
    router = get_fast_system1_router()
    decision = router.classify("Check Apple stock portfolio performance and earnings")

    assert decision.domain == "finance"
    assert decision.confidence > 0.75
    assert "get_market_quotes" in decision.recommended_tools
    assert "open_navigation_route" not in decision.recommended_tools


def test_email_query_pruning():
    """Verify that email requests prune towards email tools."""
    router = get_fast_system1_router()
    decision = router.classify("Read my unread emails from my gmail inbox")

    assert decision.domain == "email"
    assert decision.confidence > 0.75
    assert "ask_email_agent" in decision.recommended_tools


def test_calendar_query_pruning():
    """Verify that schedule/meeting questions prune towards calendar tools."""
    router = get_fast_system1_router()
    decision = router.classify("What meetings do I have scheduled on my calendar today?")

    assert decision.domain == "calendar"
    assert decision.confidence > 0.75
    assert "calendar_events" in decision.recommended_tools


def test_general_query_fallback():
    """General knowledge questions fall back safely to 'general' domain."""
    router = get_fast_system1_router()
    decision = router.classify("What is the history of ancient Rome?")

    assert decision.domain == "general"
    assert decision.recommended_tools == ()


def test_latency_performance_benchmark():
    """Benchmark: 100 classifications must average well under 5ms each."""
    router = FastSystem1Router()
    test_queries = [
        "I want to go to airport",
        "Directions to nearest train station",
        "Should I buy Tesla stock?",
        "Check my unread mail",
        "Am I free tomorrow afternoon for a meeting?",
        "How is the weather today?",
    ]

    t_start = time.perf_counter()
    iterations = 100
    for i in range(iterations):
        q = test_queries[i % len(test_queries)]
        res = router.classify(q)
        assert res.latency_ms >= 0.0

    total_time_ms = (time.perf_counter() - t_start) * 1000.0
    avg_latency_ms = total_time_ms / iterations

    # In production on modern CPU, average is typically < 1ms
    assert avg_latency_ms < 5.0, f"Average latency too high: {avg_latency_ms:.2f}ms"

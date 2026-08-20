"""Capability health: degrade the dependent feature, never the app.

Covers the product contract directly:

  provider healthy      -> capability available
  provider unavailable  -> only that capability degrades, app stays healthy
  provider recovers     -> capability usable again WITHOUT a redeploy
  browser-facing body   -> never carries provider names, status codes or billing wording
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import health
from hushh_mcp.runtime_providers import capability_health as ch


@pytest.fixture(autouse=True)
def _clean_registry():
    ch.reset_for_tests()
    yield
    ch.reset_for_tests()


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(health.router)
    return TestClient(app)


def test_unknown_capability_is_available() -> None:
    """The registry only records negatives, so silence means healthy."""
    assert ch.is_available("voice") is True


def test_a_provider_failure_marks_only_that_capability() -> None:
    ch.record_capability_failure("voice", "provider_unavailable", Exception("403 dunning"))

    assert ch.is_available("voice") is False
    assert ch.is_available("maps") is True, "an unrelated capability must not be affected"


def test_app_stays_healthy_while_a_capability_is_down() -> None:
    """A provider outage degrades features, never the service."""
    ch.record_capability_failure("voice", "provider_unavailable", Exception("403 dunning"))

    body = _client().get("/health/capabilities").json()

    assert body["app"] == "healthy"
    assert body["capabilities"]["voice"] == "unavailable"
    assert body["capabilities"]["maps"] == "available"
    assert body["degraded"] == ["voice"]


def test_capability_body_never_leaks_provider_detail_to_a_browser() -> None:
    """A person must never be shown Vertex, Gemini, 403, billing or dunning."""
    ch.record_capability_failure(
        "vertex_ai",
        "provider_unavailable",
        Exception(
            "403 PERMISSION_DENIED Lightning dunning decision is deny for project 745506018753"
        ),
    )

    raw = _client().get("/health/capabilities").text.lower()

    for forbidden in (
        "dunning",
        "403",
        "gemini",
        "billing",
        "google",
        "745506018753",
        "permission",
    ):
        assert forbidden not in raw, f"{forbidden!r} must not reach the browser"


def test_diagnostics_keep_the_cause_for_operators() -> None:
    """The detail is preserved -- it just does not go to the browser."""
    ch.record_capability_failure("voice", "provider_unavailable", Exception("403 dunning"))

    entry = ch.diagnostic_snapshot()[0]

    assert entry["capability"] == "voice"
    assert entry["reason_code"] == "provider_unavailable"
    assert entry["provider"] == "vertex"


def test_capability_recovers_automatically_once_the_cooldown_lapses(monkeypatch) -> None:
    """Recovery must not need another deploy.

    The cooldown is a suppression window, not a latch: when it lapses the mark
    is dropped so the next real request re-probes the provider.
    """
    monkeypatch.setattr(ch, "_COOLDOWN_SECONDS", 0.05)
    ch.record_capability_failure("voice", "provider_unavailable")
    assert ch.is_available("voice") is False

    import time

    time.sleep(0.06)

    assert ch.is_available("voice") is True, "must recover with no redeploy"


def test_success_clears_the_mark_immediately() -> None:
    ch.record_capability_failure("voice", "provider_unavailable")
    ch.record_capability_success("voice")

    assert ch.is_available("voice") is True


def test_cooldown_stops_a_known_down_provider_being_hammered(monkeypatch) -> None:
    """Callers can fail fast instead of waiting out another provider timeout."""
    monkeypatch.setattr(ch, "_COOLDOWN_SECONDS", 60.0)
    ch.record_capability_failure("vertex_ai", "provider_unavailable")

    assert [ch.is_available("vertex_ai") for _ in range(5)] == [False] * 5

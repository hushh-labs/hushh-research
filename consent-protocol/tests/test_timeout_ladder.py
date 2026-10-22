"""The timeout ladder: every outer bound sits above the one it wraps, with a margin.

K15. The measured defect was a browser that aborted at 60 s under an ADK budget of
90 s, so a slow but healthy answer arrived at a client that had already given up.
The ladder is pinned here as numbers, innermost first, so a constant edited in one
file fails this test rather than reproducing that shape somewhere else.

The Hermes rungs live in the fork (not this repository); their values are the ones
the device specification pins, and they are asserted here as the floor the pod
broker must sit above.
"""

from __future__ import annotations

from api.routes.one import pod_relay, pod_turn
from hushh_mcp.one_adk import text_runtime
from hushh_mcp.services import pod_specialist_runtime, puppy_broker
from hushh_mcp.services.gcp_backend import DIRECT_INGRESS_REQUEST_TIMEOUT_SECONDS

# From docs/future/personal-agent/PUPPY-DEVICE-BINDING-SPEC-2026-09-10.md.
HERMES_LOCAL_MODEL_READ_SECONDS = 60.0
HERMES_REQUEST_TOTAL_SECONDS = 110.0


def _ladder() -> list[tuple[str, float]]:
    return [
        ("hermes local model read", HERMES_LOCAL_MODEL_READ_SECONDS),
        ("pod broker inter-frame", puppy_broker.INTER_FRAME_TIMEOUT_SECONDS),
        ("hermes request total", HERMES_REQUEST_TOTAL_SECONDS),
        ("pod broker request deadline", puppy_broker.REQUEST_DEADLINE_SECONDS),
        ("adk puppy total", text_runtime._PUPPY_TOTAL_TURN_TIMEOUT_SECONDS),
        ("pod route", pod_turn.POD_TURN_ROUTE_TIMEOUT_SECONDS),
        ("hub proxy", pod_relay._TURN_TIMEOUT_SECONDS),
        ("cloud run request (direct)", float(DIRECT_INGRESS_REQUEST_TIMEOUT_SECONDS)),
    ]


def test_timeout_ladder_is_monotonic() -> None:
    ladder = _ladder()
    for (inner_name, inner), (outer_name, outer) in zip(ladder, ladder[1:], strict=False):
        assert outer > inner, f"{outer_name} ({outer}) must exceed {inner_name} ({inner})"


def test_the_puppy_budgets_are_the_ladders_values() -> None:
    assert text_runtime._PUPPY_FIRST_EVENT_TIMEOUT_SECONDS == 70.0
    assert text_runtime._PUPPY_BETWEEN_EVENT_TIMEOUT_SECONDS == 70.0
    assert text_runtime._PUPPY_TOTAL_TURN_TIMEOUT_SECONDS == 150.0
    assert pod_turn.POD_TURN_ROUTE_TIMEOUT_SECONDS == 155.0
    assert pod_relay._TURN_TIMEOUT_SECONDS == 160.0


def test_gemini_budgets_are_unchanged() -> None:
    assert text_runtime._FIRST_EVENT_TIMEOUT_SECONDS == 20.0
    assert text_runtime._BETWEEN_EVENT_TIMEOUT_SECONDS == 30.0
    assert text_runtime._TOTAL_TURN_TIMEOUT_SECONDS == 90.0


def test_a_specialist_call_fits_between_two_events_one_sees() -> None:
    """A specialist runs inside One's turn; its budget must fit the between-event gap."""
    specialist = pod_specialist_runtime.specialist_model_timeout_seconds("puppy_relay")
    assert specialist < text_runtime._PUPPY_BETWEEN_EVENT_TIMEOUT_SECONDS
    assert specialist < puppy_broker.REQUEST_DEADLINE_SECONDS
    assert pod_specialist_runtime.specialist_model_timeout_seconds("byok") < (
        text_runtime._TOTAL_TURN_TIMEOUT_SECONDS
    )


def test_the_first_event_budget_covers_the_measured_cold_first_token() -> None:
    measured_cold_first_token_seconds = 32.9
    assert text_runtime._PUPPY_FIRST_EVENT_TIMEOUT_SECONDS > measured_cold_first_token_seconds
    assert text_runtime._PUPPY_FIRST_EVENT_TIMEOUT_SECONDS < puppy_broker.REQUEST_DEADLINE_SECONDS


def test_the_route_maps_a_timeout_to_a_typed_504() -> None:
    from pathlib import Path

    source = Path(pod_turn.__file__).read_text(encoding="utf-8")
    assert "asyncio.timeout(POD_TURN_ROUTE_TIMEOUT_SECONDS)" in source
    assert '"code": "POD_TURN_TIMEOUT"' in source
    assert "status_code=504" in source

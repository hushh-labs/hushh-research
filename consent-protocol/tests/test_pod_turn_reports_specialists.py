"""The pod says which specialists served, and the parity ruler can see them.

WHY THIS EXISTS
`observe_pod` has read `turn["specialists"]` since it was written. `run_pod_turn`
has never emitted the key. So the parity oracle observed an EMPTY specialist tuple
on every real pod turn, and no live probe could certify that a specialist had been
re-homed into the pod -- not because the answer was no, but because the instrument
had no markings for that dimension.

That is the defect class this programme keeps hitting, in its most expensive form:
not code that is missing, but a measurement that is structurally incapable of
registering the thing it was built to measure, while reporting a number the whole
time. These tests pin both halves of the seam -- the runtime reads outcomes off
the event stream, and the route puts them where the oracle already looks -- so it
cannot silently come apart again.
"""

from __future__ import annotations

from types import SimpleNamespace

from hushh_mcp.observability.parity_oracle import observe_pod
from hushh_mcp.one_adk.text_runtime import (
    OneTextSpecialistOutcome,
    _event_specialists,
)


class _Reply:
    """The shape ADK hands back for a tool response part."""

    def __init__(self, name, response):
        self.name = name
        self.response = response


def _event(*replies, author="one"):
    return SimpleNamespace(author=author, get_function_responses=lambda: list(replies))


# --------------------------------------------------------------------------- #
# Reading outcomes off the stream
# --------------------------------------------------------------------------- #


def test_a_specialist_outcome_is_read_from_the_availability_payload():
    """`_specialist_turn` stamps `availability.specialist_id` on every branch it
    returns, which makes it the authoritative id rather than an inference."""
    outcomes = _event_specialists(
        _event(
            _Reply(
                "ask_email_agent",
                {"status": "ok", "availability": {"specialist_id": "agent_email"}},
            )
        )
    )
    assert outcomes == [OneTextSpecialistOutcome(agent_id="agent_email", status="ok")]


def test_a_refusal_is_an_outcome_too():
    """A refused specialist is the MOST informative case for parity: pod and hub
    refusing identically is what distinguishes honest agreement from re-homing,
    and neither can be told apart if refusals are not observed at all."""
    outcomes = _event_specialists(
        _event(
            _Reply(
                "ask_connected_systems_agent",
                {
                    "status": "authority_required",
                    "availability": {"specialist_id": "agent_connected_systems"},
                },
            )
        )
    )
    assert outcomes == [
        OneTextSpecialistOutcome(agent_id="agent_connected_systems", status="authority_required")
    ]


def test_an_older_response_without_an_availability_payload_still_resolves():
    """Falls back to the tool-name map rather than dropping the outcome. Silently
    dropping would look exactly like a specialist that never ran."""
    outcomes = _event_specialists(_event(_Reply("ask_location_agent", {"status": "ok"})))
    assert outcomes == [OneTextSpecialistOutcome(agent_id="agent_location", status="ok")]


def test_an_app_action_tool_is_not_counted_as_a_specialist():
    """App-action tools return `status` too. Counting them would INFLATE the
    ruler's reading, which is worse than under-reporting: it would look like the
    re-homing already happened."""
    assert _event_specialists(_event(_Reply("settle_action", {"status": "completed"}))) == []


def test_a_response_with_no_status_is_not_an_outcome():
    assert _event_specialists(_event(_Reply("ask_email_agent", {"text": "hello"}))) == []


def test_only_ones_own_tool_responses_are_read():
    """A sub-agent's internal tool traffic is not One's specialist roster."""
    event = _event(
        _Reply("ask_email_agent", {"status": "ok", "availability": {"specialist_id": "x"}}),
        author="agent_email",
    )
    assert _event_specialists(event) == []


def test_an_event_that_carries_no_responses_is_handled():
    assert _event_specialists(SimpleNamespace(author="one")) == []


# --------------------------------------------------------------------------- #
# The seam: what the route emits is what the oracle reads
# --------------------------------------------------------------------------- #


def test_the_oracle_sees_the_envelope_the_route_emits():
    """The actual bug, stated as a test. The route's key name, the spelling of the
    id field, and the oracle's reader have to agree, and nothing else in the tree
    would have caught them disagreeing."""
    turn = {
        "text": "here you go",
        "grounded": True,
        "runtimeMode": "user_adc",
        "directiveCount": 0,
        "directives": [],
        "specialists": [
            {"agentId": "agent_email", "status": "ok"},
            {"agentId": "agent_nav", "status": "authority_required"},
        ],
    }
    obs = observe_pod(turn)
    assert [(s.agent_id, s.status) for s in obs.specialists] == [
        ("agent_email", "ok"),
        ("agent_nav", "authority_required"),
    ]


def test_a_turn_with_no_specialists_observes_none_rather_than_failing():
    obs = observe_pod({"text": "hi", "grounded": True, "specialists": []})
    assert obs.specialists == ()


def test_the_route_still_emits_the_key_it_promises():
    """Reads the route source rather than the response, because the failure being
    guarded is the key going missing again -- and a mocked turn would pass whether
    or not the route emits it."""
    import pathlib

    src = (
        pathlib.Path(__file__).resolve().parents[1] / "api" / "routes" / "one" / "pod_turn.py"
    ).read_text()
    assert '"specialists": [' in src, "run_pod_turn stopped emitting the specialists key"
    assert '"agentId": getattr(s, "agent_id", "")' in src

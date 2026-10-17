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


# --------------------------------------------------------------------------- #
# Lane B3: honest dependencies. A specialist says where it ran and where its
# facts came from, and a hub-backed tool that could not be read says so while
# owner-local chat continues. The ledger's `hub_specialist_information_reads`
# finally has a producer.
# --------------------------------------------------------------------------- #


def test_the_dependency_report_is_read_into_the_outcome():
    """Case 1: a pod specialist that read one hub door reports it, per field."""
    outcomes = _event_specialists(
        _event(
            _Reply(
                "ask_location_agent",
                {
                    "status": "ok",
                    "availability": {"specialist_id": "agent_location"},
                    "dependency": {
                        "execution": "pod",
                        "information_source": "hub_door",
                        "hub_reads": 1,
                        "doors": ["location"],
                        "reason": "",
                    },
                },
            )
        )
    )
    assert outcomes == [
        OneTextSpecialistOutcome(
            agent_id="agent_location",
            status="ok",
            execution="pod",
            information_source="hub_door",
            hub_reads=1,
            reason="",
        )
    ]


def test_an_unreachable_hub_door_is_named_while_the_specialist_still_answered():
    """Case 2: the door failed, the specialist's own loop finished (owner-local
    chat continued), and the outcome says the information was unavailable rather
    than hiding the gap behind `ok`."""
    outcomes = _event_specialists(
        _event(
            _Reply(
                "ask_location_agent",
                {
                    "status": "ok",
                    "availability": {"specialist_id": "agent_location"},
                    "dependency": {
                        "execution": "pod",
                        "information_source": "unavailable",
                        "hub_reads": 1,
                        "unavailable_doors": ["location"],
                        "reason": "hub_information_unavailable",
                    },
                },
            )
        )
    )
    assert outcomes[0].status == "ok"
    assert outcomes[0].information_source == "unavailable"
    assert outcomes[0].reason == "hub_information_unavailable"


def test_an_outcome_without_a_dependency_report_still_resolves_negative_control():
    """Case 3: an older payload (or the hub, which traces nothing) carries no
    dependency block. The outcome is observed with empty dependency fields, and
    empty must never be read as 'zero hub reads, executed in the pod'."""
    outcomes = _event_specialists(
        _event(
            _Reply(
                "ask_email_agent",
                {"status": "ok", "availability": {"specialist_id": "agent_email"}},
            )
        )
    )
    assert outcomes == [OneTextSpecialistOutcome(agent_id="agent_email", status="ok")]
    assert outcomes[0].execution == "" and outcomes[0].information_source == ""
    assert outcomes[0].hub_reads == 0


def test_a_malformed_dependency_block_cannot_inflate_or_negate_the_count():
    outcomes = _event_specialists(
        _event(
            _Reply(
                "ask_location_agent",
                {
                    "status": "ok",
                    "availability": {"specialist_id": "agent_location"},
                    "dependency": {"hub_reads": -3, "execution": None},
                },
            )
        )
    )
    assert outcomes[0].hub_reads == 0
    assert outcomes[0].execution == ""
    assert (
        _event_specialists(
            _event(
                _Reply(
                    "ask_location_agent",
                    {
                        "status": "ok",
                        "availability": {"specialist_id": "agent_location"},
                        "dependency": "yes",
                    },
                )
            )
        )[0].hub_reads
        == 0
    )


async def test_the_route_emits_per_specialist_dependencies_and_a_turn_level_rollup(monkeypatch):
    """Case 4: the envelope carries every dependency field per specialist plus
    `dependencies: {hub, unavailable}`, derived from the outcomes, never asserted."""
    from api.routes.one import pod_turn

    monkeypatch.setattr(pod_turn, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    monkeypatch.setattr(pod_turn, "_resolve_model", lambda: ("gemini", "gemini-test"))

    async def _validate(_token, *, verifier=None):
        return {"user_id": "u1", "scope": "pkm.read"}

    monkeypatch.setattr(pod_turn, "_validate_consent", _validate)

    outcomes = [
        OneTextSpecialistOutcome(
            agent_id="agent_location",
            status="ok",
            execution="pod",
            information_source="none",
            hub_reads=0,
        ),
        OneTextSpecialistOutcome(
            agent_id="agent_email",
            status="ok",
            execution="pod",
            information_source="hub_door",
            hub_reads=2,
        ),
        OneTextSpecialistOutcome(
            agent_id="agent_nav",
            status="ok",
            execution="pod",
            information_source="unavailable",
            hub_reads=1,
            reason="hub_information_unavailable",
        ),
        OneTextSpecialistOutcome(agent_id="agent_connected_systems", status="authority_required"),
    ]

    async def _run(**_kwargs):
        yield SimpleNamespace(kind="token", text="here you go", model_version="")
        for outcome in outcomes:
            yield SimpleNamespace(kind="specialist", specialist=outcome)

    result = await pod_turn.run_pod_turn(
        payload=pod_turn.PodTurnRequest(message="hi", runtime_credential="owner-key"),
        consent_token="t",  # noqa: S106 - stubbed above
        stream_fn=_run,
    )
    assert result["specialists"][0] == {
        "agentId": "agent_location",
        "status": "ok",
        "execution": "pod",
        "informationSource": "none",
        "hubReads": 0,
        "reason": "",
    }
    assert result["specialists"][1]["hubReads"] == 2
    assert result["specialists"][3] == {
        "agentId": "agent_connected_systems",
        "status": "authority_required",
        "execution": "",
        "informationSource": "",
        "hubReads": 0,
        "reason": "",
    }
    assert result["dependencies"] == {
        "hub": ["agent_email", "agent_nav"],
        "unavailable": ["agent_nav"],
    }
    # The oracle keeps reading the same envelope it always did.
    obs = observe_pod(result)
    assert [(s.agent_id, s.status) for s in obs.specialists][:2] == [
        ("agent_location", "ok"),
        ("agent_email", "ok"),
    ]


def test_a_turn_with_no_specialists_has_empty_dependencies():
    from api.routes.one.pod_turn import _turn_dependencies

    assert _turn_dependencies([]) == {"hub": [], "unavailable": []}


def test_the_specialist_turn_merges_the_trace_into_every_branch():
    """The tool layer attaches `dependency` on success and on each refusal, and a
    device capability refusal recorded on the trace turns `ok` into `unsupported`."""
    from hushh_mcp.one_adk.agent_tree import _with_dependency
    from hushh_mcp.services.pod_specialist_runtime import SpecialistDependencyTrace

    clean = SpecialistDependencyTrace()
    assert _with_dependency({"status": "ok"}, clean)["dependency"]["information_source"] == "none"

    door_down = SpecialistDependencyTrace()
    door_down.record_hub_read("location")
    door_down.record_unavailable("location")
    payload = _with_dependency({"status": "ok"}, door_down)
    assert payload["status"] == "ok", "owner-local chat continued; the door is what failed"
    assert payload["dependency"]["reason"] == "hub_information_unavailable"
    assert payload["dependency"]["unavailable_doors"] == ["location"]

    refused = SpecialistDependencyTrace()
    refused.record_unsupported("json_schema")
    payload = _with_dependency({"status": "ok"}, refused)
    assert payload["status"] == "unsupported"
    assert payload["reason"] == "provider_capability_unsupported"
    assert payload["capability"] == "json_schema"

    assert _with_dependency({"status": "ok"}, None) == {"status": "ok"}, "the hub traces nothing"

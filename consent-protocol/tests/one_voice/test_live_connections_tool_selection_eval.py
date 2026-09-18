"""Held-out evaluation of which tool the Live head selects for Connections:
sending a request, reading connections and pending requests, discovering
people, accepting / declining / cancelling / removing, relatives and
identifiers that are not names, corrections and pronouns, batches, and
requests that must change nothing.

``fixtures/connections_tool_selection.v1.json`` is authored by hand and held
out of every production string. ``test_connections_fixture_is_well_formed_and_
held_out`` always runs. ``test_live_model_selects_connection_tools`` drives the
real model (``live_model`` marker, ``ONE_VOICE_LIVE_TOOL_EVAL=1``); function
calls are answered by the REAL executor over the people-plane doubles, so a
follow-up turn sees the ids an earlier read returned, mutations stop at
``confirmation_required``, and a hallucinated id is refused by production's own
guards -- and counted.
"""

from __future__ import annotations

import asyncio
import os
import time
from datetime import UTC, datetime
from typing import Any

import pytest

from hushh_mcp.one_voice.tools import registry
from hushh_mcp.one_voice.tools.base import EntityContext, ScreenContext, ToolContext
from hushh_mcp.one_voice.tools.executor import ToolExecutor
from tests.one_voice import tool_selection_eval_support as support
from tests.one_voice.fakes import MemoryPendingStore
from tests.one_voice.test_tools_circles import FakeCircleService
from tests.one_voice.test_tools_people import OWNER, ConnectionsDouble, LocationDouble
from tests.one_voice.tool_selection_eval_support import Case, FamilyMetrics, Observation

FIXTURE_PATH = support.TESTS_DIR / "fixtures" / "connections_tool_selection.v1.json"
REPORT_NAME = "one-voice-connections-eval-report.json"
SCHEMA_VERSION = "one.voice.connections_tool_selection.v1"

FAMILIES = frozenset(
    {
        "send",
        "read",
        "discover",
        "accept",
        "decline",
        "cancel",
        "remove",
        "unknown_recipient",
        "follow_up",
        "batch",
        "no_mutation",
    }
)
CLEAR_INTENT_FAMILIES = FAMILIES - {"no_mutation", "unknown_recipient"}
NO_MUTATION_FAMILIES = frozenset({"no_mutation", "unknown_recipient"})
SCREENS = frozenset({"one_home", "one_connect", "one_person_profile", "one_location"})
MIN_CASES = 180
MIN_SEND_CASES = 100
MIN_EXPECTED_HIT_RATE = 0.95

# The tool whose effect is the confusable *wrong* outcome for each intent.
WRONG_EFFECT = {
    "send": {
        "add_circle_member",
        "share_with",
        "request_location",
        "remove_connection",
        "create_circle_invite_link",
    },
    "read": {"invite_person", "remove_connection", "accept_connection_request"},
    "discover": {"invite_person", "add_circle_member", "share_with", "remove_connection"},
    "accept": {
        "decline_connection_request",
        "invite_person",
        "respond_request",
        "respond_circle_invite",
        "remove_connection",
    },
    "decline": {
        "accept_connection_request",
        "invite_person",
        "respond_request",
        "respond_circle_invite",
        "remove_connection",
    },
    "cancel": {
        "decline_connection_request",
        "accept_connection_request",
        "remove_connection",
        "withdraw_request",
        "cancel_circle_invite",
    },
    "remove": {
        "remove_circle_member",
        "remove_emergency_contact",
        "stop_share",
        "turn_sharing_off",
        "cancel_connection_request",
        "decline_connection_request",
    },
    "unknown_recipient": set(),
    "follow_up": set(),
    "batch": {"add_circle_member", "share_with", "create_circle_invite_link"},
    "no_mutation": set(),
}
UNCONFIRMED_ID_CODES = frozenset(
    {"circle_not_offered", "person_not_offered", "invalid_arguments", "identifier_not_a_name"}
)
SKIPPED_CONFIRM_CODES = frozenset({"person_not_confirmed", "circle_not_confirmed"})
FAMILY_ID = "11111111-1111-4111-8111-111111111111"


def _circle_people_names() -> set[str]:
    from hushh_mcp.one_voice.tools import circles, people

    return {tool.name for tool in (*circles.TOOLS, *people.TOOLS)}


class _EvalConnections(ConnectionsDouble):
    """The people-plane double with a directory rich enough for the fixture:
    Priya Nair and Ayesha Sharma are connected, Rahul Verma has asked to
    connect, Dev Patel has a request from us pending, Meera Iyer and Kushal Rao
    are findable but not connected, and two Priyas exist."""

    def __init__(self) -> None:
        super().__init__()
        self.directory.extend(
            [
                {
                    "userId": "u-meera",
                    "publicPersonRef": "ppr-meera",
                    "displayName": "Meera Iyer",
                    "photoUrl": None,
                    "relationship": "none",
                    "isRia": False,
                },
                {
                    "userId": "u-kushal",
                    "publicPersonRef": "ppr-kushal",
                    "displayName": "Kushal Rao",
                    "photoUrl": None,
                    "relationship": "none",
                    "isRia": False,
                },
                {
                    "userId": "u-priya-s",
                    "publicPersonRef": "ppr-priya-s",
                    "displayName": "Priya Sharma",
                    "photoUrl": None,
                    "relationship": "none",
                    "isRia": False,
                },
                {
                    "userId": "u-rohan",
                    "publicPersonRef": "ppr-rohan",
                    "displayName": "Rohan Mehta",
                    "photoUrl": None,
                    "relationship": "none",
                    "isRia": False,
                },
                {
                    "userId": "u-rahul",
                    "publicPersonRef": "ppr-rahul",
                    "displayName": "Rahul Verma",
                    "photoUrl": None,
                    "relationship": "pending_incoming",
                    "isRia": False,
                },
                {
                    "userId": "u-dev",
                    "publicPersonRef": "ppr-dev",
                    "displayName": "Dev Patel",
                    "photoUrl": None,
                    "relationship": "pending_outgoing",
                    "isRia": False,
                },
            ]
        )


def _eval_location(connections: _EvalConnections) -> LocationDouble:
    """confirm_person re-reads a directory candidate by id through the
    location plane; every findable person must be there too."""
    location = LocationDouble()
    for row in connections.directory:
        location.directory_by_id.setdefault(
            row["userId"],
            {
                "userId": row["userId"],
                "displayName": row["displayName"],
                "photoUrl": row.get("photoUrl"),
                "phoneVerified": True,
                "keyId": None,
                "canReceiveLocation": False,
                "publicPersonRef": row.get("publicPersonRef"),
            },
        )
    return location


def make_responder(case: Case) -> support.Responder:
    from hushh_mcp.one_voice.tools import circles

    connections = _EvalConnections()
    pending = MemoryPendingStore()

    async def prove(token, expected_user_id):
        return "ok"

    executor = ToolExecutor(pending_store=pending, actor_proof=prove)
    ctx = ToolContext(
        user_id=OWNER,
        conversation_id="conv-eval",
        entities=EntityContext(),
        screen=ScreenContext(screen_id=case.screen),
        vault_owner_token="vault-token",  # noqa: S106 - test double
        firebase_id_token="firebase-token",  # noqa: S106 - test double
        services={
            "connections": connections,
            "location": _eval_location(connections),
            circles.CIRCLE_SERVICE: FakeCircleService(),
        },
    )
    handled = _circle_people_names() | set(registry.SESSION_TOOL_NAMES)

    async def respond(name: str, args: dict[str, Any]) -> dict[str, Any]:
        if name == "open_screen":
            return {"status": "navigation_dispatched", "screen": str(args.get("screen") or "")}
        if name not in handled:
            return {"status": "ok", "spoken_facts": []}
        outcome = await executor.call(ctx, name, args)
        if outcome.pending is not None:
            await pending.mark_shown(user_id=OWNER, pending_action_id=outcome.pending.id)
        return outcome.result.public()

    return respond


# --- offline: the fixture -------------------------------------------------


def load_fixture() -> list[Case]:
    return support.load_cases(
        FIXTURE_PATH, schema_version=SCHEMA_VERSION, families=FAMILIES, screens=SCREENS
    )


def test_connections_fixture_is_well_formed_and_held_out():
    cases = load_fixture()
    assert len(cases) >= MIN_CASES, len(cases)
    assert sum(case.family == "send" for case in cases) >= MIN_SEND_CASES
    ids = [case.id for case in cases]
    assert len(ids) == len(set(ids)), "duplicate case ids"
    utterances = [case.utterance.strip().lower() for case in cases]
    assert len(utterances) == len(set(utterances)), "duplicate utterances"
    assert {case.family for case in cases} == FAMILIES

    declared = {item["name"] for item in registry.declarations()}
    mutations = support.mutation_tools()
    for case in cases:
        for name in (*case.expected_tools, *case.forbidden_tools):
            assert name in declared, (case.id, name)
        assert not set(case.expected_tools) & set(case.forbidden_tools), case.id
        assert WRONG_EFFECT[case.family] <= set(case.forbidden_tools), (case.id, case.family)
        if case.family in NO_MUTATION_FAMILIES:
            assert not set(case.expected_tools) & mutations, case.id
            assert mutations <= set(case.forbidden_tools), case.id
        else:
            assert case.expected_tools, case.id
        # No case ever asks for device contact sync as a way to find a name.
        assert "sync_contacts" not in case.expected_tools

    # Some Hindi/Hinglish coverage in every clear-intent family with >= 10 cases.
    by_family: dict[str, list[Case]] = {}
    for case in cases:
        by_family.setdefault(case.family, []).append(case)
    for family, items in by_family.items():
        if len(items) >= 10:
            assert any("-hi-" in case.id for case in items), f"{family} has no Hindi/Hinglish case"

    corpus = support.production_corpus()
    for case in cases:
        held_out = [case.utterance, *(h for h in case.history if len(h.split()) > 3)]
        for sentence in held_out:
            assert sentence.strip().lower() not in corpus, (case.id, sentence)


def test_connections_fake_world_reads_real_ids_and_stops_writes_at_a_card():
    case = Case("smoke", "send", "one_home", (), "x", (), (), "")
    respond = make_responder(case)
    found = asyncio.run(respond("resolve_person", {"spoken_name": "Meera", "pool": "directory"}))
    assert found["status"] == "single_likely" and found["candidates"][0]["user_id"] == "u-meera"
    confirmed = asyncio.run(respond("confirm_person", {"user_id": "u-meera"}))
    assert confirmed["status"] == "confirmed"
    card = asyncio.run(respond("invite_person", {"person": {"user_id": "u-meera"}}))
    assert card["status"] == "confirmation_required" and card["tier"] == "voice"
    sent = asyncio.run(
        respond("confirm_pending_action", {"pending_action_id": card["pending_action_id"]})
    )
    assert sent["status"] == "sent" and sent["request_id"] == "req-new"
    listed = asyncio.run(respond("list_people", {}))
    assert listed["pending_incoming"][0]["display_name"] == "Rahul Verma"
    invented = asyncio.run(respond("remove_connection", {"person": {"user_id": "u-ayesha"}}))
    assert invented["status"] == "rejected" and invented["reason_code"] == "person_not_confirmed"
    number = asyncio.run(
        respond("resolve_person", {"spoken_name": "9876543210", "pool": "directory"})
    )
    assert number["reason_code"] == "identifier_not_a_name"


# --- live: the real model -------------------------------------------------


def _expected_hit(obs: Observation, reads: frozenset[str]) -> bool:
    if obs.error:
        return False
    if not obs.case.expected_tools:
        return obs.first_tool is None or obs.first_tool in reads
    return obs.first_tool in obs.case.expected_tools


def _summarise(observations: list[Observation]) -> dict[str, FamilyMetrics]:
    mutations = support.mutation_tools()
    reads = support.read_tools()
    families: dict[str, FamilyMetrics] = {}
    for obs in observations:
        block = families.setdefault(obs.case.family, FamilyMetrics())
        block.n += 1
        hit = _expected_hit(obs, reads)
        block.expected_hits += int(hit)
        block.forbidden_hits += int(obs.forbidden_hit)
        unintended = obs.case.family in NO_MUTATION_FAMILIES and any(
            name in mutations for name in obs.all_tools
        )
        block.unintended_mutation += int(unintended)
        block.unconfirmed_id_mutation += int(
            any(
                name in mutations
                and result.get("status") == "rejected"
                and result.get("reason_code") in UNCONFIRMED_ID_CODES
                for name, _, result in obs.calls
            )
        )
        block.skipped_confirm += int(
            any(
                name in mutations
                and result.get("status") == "rejected"
                and result.get("reason_code") in SKIPPED_CONFIRM_CODES
                for name, _, result in obs.calls
            )
        )
        block.errors += int(obs.error is not None)
        if not hit or obs.forbidden_hit or obs.error or unintended:
            block.misses.append(
                {
                    "id": obs.case.id,
                    "utterance": obs.case.utterance,
                    "history": list(obs.case.history),
                    "expected": list(obs.case.expected_tools),
                    "got": [
                        {"tool": name, "args": args, "status": result.get("status")}
                        for name, args, result in obs.calls
                    ],
                    "error": obs.error,
                }
            )
    return families


@pytest.mark.live_model
@pytest.mark.skipif(
    os.environ.get(support.LIVE_EVAL_ENV) != "1",
    reason=f"set {support.LIVE_EVAL_ENV}=1 with Vertex ADC to run the real-model evaluation",
)
def test_live_model_selects_connection_tools():
    os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "true")
    os.environ.setdefault("HUSHH_GENAI_AUTH_MODE", "vertex_adc")

    cases = load_fixture()
    only = {
        item.strip()
        for item in (os.environ.get("ONE_VOICE_EVAL_FAMILIES") or "").split(",")
        if item.strip()
    }
    if only:
        cases = [case for case in cases if case.family in only]
    mode, model_id, location, mode_label = support.resolve_mode()
    probe = (
        support.make_text_probe(model_id, make_responder)
        if mode == "text"
        else support.make_live_probe(model_id, location, make_responder)
    )
    observations: list[Observation] = []
    for index, case in enumerate(cases):
        if index:
            time.sleep(support.CALL_GAP_S)
        observations.append(support.observe(probe, case))

    families = _summarise(observations)
    forbidden_total = sum(b.forbidden_hits for b in families.values())
    unintended_total = sum(b.unintended_mutation for b in families.values())
    unconfirmed_total = sum(b.unconfirmed_id_mutation for b in families.values())
    errors_total = sum(b.errors for b in families.values())
    clear_rates = {
        family: (b.expected_hits / b.n if b.n else None)
        for family, b in families.items()
        if family in CLEAR_INTENT_FAMILIES
    }
    report = {
        "schema_version": "one.voice.connections_tool_selection_report.v1",
        "generated_at": datetime.now(UTC).isoformat(),
        "git_sha": support.git_sha(),
        "mode": mode_label,
        "model": model_id,
        "location": location,
        "fixture": str(FIXTURE_PATH.relative_to(support.CONSENT_PROTOCOL_ROOT)),
        "n": len(observations),
        "gates": {
            "forbidden_hits": forbidden_total,
            "unintended_mutations": unintended_total,
            "unconfirmed_id_mutations": unconfirmed_total,
            "errors": errors_total,
            "clear_intent_expected_hit_rates": clear_rates,
            "clear_intent_min": MIN_EXPECTED_HIT_RATE,
        },
        "families": {name: b.as_dict() for name, b in sorted(families.items())},
    }
    path = support.report_path(REPORT_NAME)
    support.write_report(path, report)
    print(f"\nconnections tool-selection report: {path}")

    assert errors_total == 0, f"{errors_total} provider errors; see {path}"
    assert forbidden_total == 0, f"forbidden tool selected {forbidden_total}x; see {path}"
    assert unintended_total == 0, (
        f"mutation proposed for a no-mutation case {unintended_total}x; see {path}"
    )
    assert unconfirmed_total == 0, (
        f"mutation with an unconfirmed id {unconfirmed_total}x; see {path}"
    )
    low = {f: r for f, r in clear_rates.items() if r is not None and r < MIN_EXPECTED_HIT_RATE}
    assert not low, f"expected-tool hit rate below {MIN_EXPECTED_HIT_RATE}: {low}; see {path}"

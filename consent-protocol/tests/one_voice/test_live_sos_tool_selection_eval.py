"""Held-out evaluation of which tool the Live head selects for Save My Soul:
alerting the emergency contacts (with and without a note), reading who will
get the alert and whether one is live, verifying delivery, opening the screen
without sending, stopping, editing the emergency roster, and the questions,
negations, quotations, bare words and near-misses that must change nothing.

``fixtures/sos_tool_selection.v1.json`` is authored by hand and held out of
every production string. ``test_sos_fixture_is_well_formed_and_held_out``
always runs. ``test_live_model_selects_sos_tools`` drives the real model
(``live_model`` marker, ``ONE_VOICE_LIVE_TOOL_EVAL=1``); function calls are
answered by the REAL executor over the SOS location double and the
people-plane doubles, so the trigger and stop cards are prepared from a live
roster, a spoken yes on a tap card is refused by production's own store, and a
person mutation with an unconfirmed id is refused by production's own guard
-- and counted.
"""

from __future__ import annotations

import asyncio
import os
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from hushh_mcp.one_voice.tools import registry
from hushh_mcp.one_voice.tools.base import EntityContext, ScreenContext, ToolContext, now_iso
from hushh_mcp.one_voice.tools.executor import ToolExecutor
from tests.one_voice import tool_selection_eval_support as support
from tests.one_voice.fakes import MemoryPendingStore
from tests.one_voice.test_tools_people import ConnectionsDouble
from tests.one_voice.test_tools_sos import (
    AYESHA,
    MEERA,
    OWNER,
    RAVI,
    FakeLocationService,
    _grant,
    _recipient,
)
from tests.one_voice.tool_selection_eval_support import Case, FamilyMetrics, Observation

FIXTURE_PATH = support.TESTS_DIR / "fixtures" / "sos_tool_selection.v1.json"
REPORT_NAME = "one-voice-sos-eval-report.json"
REPORT_PATH_ENV = "ONE_VOICE_EVAL_REPORT"
SCHEMA_VERSION = "one.voice.sos_tool_selection.v1"

FAMILIES = frozenset(
    {
        "trigger",
        "status",
        "delivery",
        "open_only",
        "stop",
        "add_contact",
        "remove_contact",
        "no_mutation",
        "follow_up",
    }
)
# A follow_up turn is a correction or a cancellation: it may re-resolve, read,
# or cancel the card, and it may never propose a change.
NO_MUTATION_FAMILIES = frozenset({"no_mutation", "follow_up"})
CLEAR_INTENT_FAMILIES = FAMILIES - NO_MUTATION_FAMILIES
SCREENS = frozenset({"one_home", "one_location", "one_location_sos"})
MIN_CASES = 180
MIN_TRIGGER_CASES = 45
MIN_FAMILY_CASES = {
    "trigger": MIN_TRIGGER_CASES,
    "status": 25,
    "delivery": 15,
    "open_only": 15,
    "stop": 20,
    "add_contact": 15,
    "remove_contact": 12,
    "no_mutation": 25,
    "follow_up": 10,
}
MIN_EXPECTED_HIT_RATE = {
    "trigger": 0.95,
    "status": 0.95,
    "stop": 0.95,
    "open_only": 0.95,
    "delivery": 0.90,
    "add_contact": 0.90,
    "remove_contact": 0.90,
    "no_mutation": 0.90,
    "follow_up": 0.90,
}

SOS_MUTATIONS = frozenset(
    {
        "trigger_save_my_soul",
        "stop_save_my_soul",
        "add_emergency_contact",
        "remove_emergency_contact",
    }
)
# Every SOS mutation plus the session confirm, which is the only way one of
# them executes inside a single evaluated turn.
SOS_MUTATIONS_AND_CONFIRM = SOS_MUTATIONS | {"confirm_pending_action"}
# Location-sharing mutations a confused model might pick for an SOS phrase.
SHARING_CONFUSABLES = frozenset(
    {"turn_sharing_on", "turn_sharing_off", "share_with", "stop_share", "remove_connection"}
)

# The tool whose effect is the confusable *wrong* outcome for each intent.
WRONG_EFFECT: dict[str, set[str]] = {
    "trigger": (SOS_MUTATIONS - {"trigger_save_my_soul"})
    | SHARING_CONFUSABLES
    | {"request_location", "create_check_in", "invite_person", "confirm_pending_action"},
    "status": set(SOS_MUTATIONS_AND_CONFIRM) | SHARING_CONFUSABLES,
    "delivery": set(SOS_MUTATIONS_AND_CONFIRM) | SHARING_CONFUSABLES,
    "open_only": set(SOS_MUTATIONS_AND_CONFIRM) | SHARING_CONFUSABLES,
    "stop": (SOS_MUTATIONS - {"stop_save_my_soul"})
    | SHARING_CONFUSABLES
    | {"pause_device_location_updates", "confirm_pending_action"},
    "add_contact": (SOS_MUTATIONS - {"add_emergency_contact"})
    | {"add_circle_member", "share_with", "invite_person", "confirm_pending_action"},
    "remove_contact": (SOS_MUTATIONS - {"remove_emergency_contact"})
    | {"remove_circle_member", "remove_connection", "stop_share", "confirm_pending_action"},
    "no_mutation": set(),  # every mutation, checked against mutation_tools() below
    "follow_up": set(),
}
# A person mutation called with an id that was never offered and confirmed
# (or with a phone number/email in place of a name) is the wrong-target
# failure this family exists to catch.
UNCONFIRMED_ID_CODES = frozenset(
    {"person_not_confirmed", "person_not_offered", "identifier_not_a_name"}
)
MISSING_ARGUMENT_CODES = frozenset({"invalid_arguments"})
# A read the model may make before acting; a hit only if the expected tool
# follows in the same turn.
LEADING_READ = "get_save_my_soul_status"
# Cancelling a card changes nothing, so it is never the wrong move for a turn
# that must not mutate. Opening the Save My Soul screen is the safe answer
# the product asks for on a bare "help"/"emergency"/"SMS" (navigation only).
HARMLESS = frozenset({"cancel_pending_action", "open_screen"})
# Result statuses that mean an SOS mutation actually ran (past the card).
EXECUTED_SOS_STATUSES = frozenset(
    {"sos_grants_created", "sos_stopped", "sos_partially_stopped", "added", "removed"}
)
# Families whose world starts with a live, delivered alert; plus any
# follow_up case whose id carries "-active-" (its history prepares a stop card).
ACTIVE_ALERT_FAMILIES = frozenset({"stop", "delivery"})
ACTIVE_ID_MARKER = "-active-"

PRIYA = "user-priya"
ROHAN = "user-rohan"
ROSTER = ((AYESHA, "Ayesha Sharma"), (RAVI, "Ravi Kumar"), (MEERA, "Meera Nair"))
CONNECTED = (*ROSTER, (PRIYA, "Priya Nair"), (ROHAN, "Rohan Mehta"))
ACTIVE_GRANTS = (("g-ayesha", AYESHA, "Ayesha Sharma"), ("g-ravi", RAVI, "Ravi Kumar"))


def _sos_people_names() -> set[str]:
    from hushh_mcp.one_voice.tools import people, sos

    return {tool.name for tool in (*sos.TOOLS, *people.TOOLS)}


class _EvalLocation(FakeLocationService):
    """The SOS location double with the roster the fixture talks about: Ayesha
    and Ravi ready, Meera on the roster but without a location key, and Priya
    and Rohan connected but not emergency contacts. ``confirm_person`` may
    re-read a candidate by id through the directory, so that is answered too."""

    def __init__(self, *, active_alert: bool) -> None:
        super().__init__()
        self.sms_contact_ids = [user_id for user_id, _ in ROSTER]
        self.recipients = [
            _recipient(user_id, name, key=user_id != MEERA) for user_id, name in CONNECTED
        ]
        if active_alert:
            self.owner_grants = [
                _grant(grant_id, user_id, name, envelope=True)
                for grant_id, user_id, name in ACTIVE_GRANTS
            ]

    def search_directory_candidates(
        self, *, owner_user_id: str, candidate_user_id: str | None = None, **kwargs: Any
    ) -> dict[str, Any]:
        assert owner_user_id == OWNER
        rows = [dict(row) for row in self.recipients if row["userId"] == candidate_user_id]
        return {"items": rows, "page": 1, "hasMore": False}


class _EvalConnections(ConnectionsDouble):
    """The people-plane double for the same world: everyone the fixture names
    is a connection, nothing is pending, and the directory finds one Priya."""

    def __init__(self) -> None:
        super().__init__()
        self.connections = [
            {
                "connectionId": f"conn-{user_id}",
                "userId": user_id,
                "publicPersonRef": f"ppr-{user_id}",
                "displayName": name,
                "photoUrl": None,
                "email": None,
                "createdAt": "2026-01-01T00:00:00+00:00",
                "isRia": False,
                "connectedFromContacts": False,
            }
            for user_id, name in CONNECTED
        ]
        self.incoming = []
        self.outgoing = []
        self.directory = [
            {
                "userId": user_id,
                "publicPersonRef": f"ppr-{user_id}",
                "displayName": name,
                "photoUrl": None,
                "relationship": "connected",
                "isRia": False,
            }
            for user_id, name in CONNECTED
        ] + [
            {
                "userId": "user-preeti",
                "publicPersonRef": "ppr-user-preeti",
                "displayName": "Preeti Rao",
                "photoUrl": None,
                "relationship": "none",
                "isRia": False,
            }
        ]


def _starts_with_active_alert(case: Case) -> bool:
    return case.family in ACTIVE_ALERT_FAMILIES or ACTIVE_ID_MARKER in case.id


def make_world(case: Case) -> tuple[ToolContext, _EvalLocation, MemoryPendingStore, ToolExecutor]:
    active = _starts_with_active_alert(case)
    location = _EvalLocation(active_alert=active)
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
        services={"location": location, "connections": _EvalConnections()},
    )
    if active:
        # The session armed this alert and the app published the position:
        # the delivery report is bound to exactly these grants.
        ctx.sos_incident = {
            "grant_ids": [grant_id for grant_id, _, _ in ACTIVE_GRANTS],
            "armed_at": now_iso(),
            "source": "trigger",
        }
    return ctx, location, pending, executor


def make_responder(case: Case) -> support.Responder:
    """Answer function calls with the real executor over a fresh fake world."""
    ctx, _, pending, executor = make_world(case)
    handled = _sos_people_names() | set(registry.SESSION_TOOL_NAMES)

    async def respond(name: str, args: dict[str, Any]) -> dict[str, Any]:
        if name == "open_screen":
            return {"status": "navigation_dispatched", "screen": str(args.get("screen") or "")}
        if name not in handled:
            return {"status": "ok", "spoken_facts": []}
        outcome = await executor.call(ctx, name, args)
        if outcome.pending is not None:
            # The card is shown at once in this world and left pending: a tap
            # never happens here, and a spoken yes on a tap card is refused.
            await pending.mark_shown(user_id=OWNER, pending_action_id=outcome.pending.id)
        return outcome.result.public()

    return respond


# --- offline: the fixture -------------------------------------------------


def load_fixture() -> list[Case]:
    return support.load_cases(
        FIXTURE_PATH, schema_version=SCHEMA_VERSION, families=FAMILIES, screens=SCREENS
    )


def test_sos_fixture_is_well_formed_and_held_out():
    cases = load_fixture()
    assert len(cases) >= MIN_CASES, len(cases)
    assert sum(case.family == "trigger" for case in cases) >= MIN_TRIGGER_CASES
    ids = [case.id for case in cases]
    assert len(ids) == len(set(ids)), "duplicate case ids"
    utterances = [case.utterance.strip().lower() for case in cases]
    assert len(utterances) == len(set(utterances)), "duplicate utterances"
    assert {case.family for case in cases} == FAMILIES
    by_family: dict[str, list[Case]] = {}
    for case in cases:
        by_family.setdefault(case.family, []).append(case)
    for family, minimum in MIN_FAMILY_CASES.items():
        assert len(by_family.get(family, [])) >= minimum, (family, len(by_family.get(family, [])))

    declared = {item["name"] for item in registry.declarations()}
    mutations = support.mutation_tools()
    assert SOS_MUTATIONS_AND_CONFIRM <= mutations
    for case in cases:
        assert case.screen in SCREENS, (case.id, case.screen)
        for name in (*case.expected_tools, *case.forbidden_tools):
            assert name in declared, (case.id, name)
        assert not set(case.expected_tools) & set(case.forbidden_tools), case.id
        assert WRONG_EFFECT[case.family] <= set(case.forbidden_tools), (case.id, case.family)
        if case.family in NO_MUTATION_FAMILIES:
            assert not set(case.expected_tools) & mutations, case.id
            # Every SOS mutation (and every other mutation) is forbidden for a
            # turn that must not change anything; reads stay allowed. The one
            # exception is a spoken yes on a tap-tier card: the model may try
            # confirm_pending_action, which the executor answers with
            # tap_required and runs nothing (test_relay_sos_lifecycle pins it).
            allowed: set[str] = set()
            if "spoken yes" in case.note:
                allowed.add("confirm_pending_action")
            if "correction" in case.note:
                # The corrected target's own card is the documented outcome;
                # never the send/stop tools.
                allowed |= {"add_emergency_contact", "remove_emergency_contact"} & set(mutations)
            if "bare word" in case.note:
                # "help" / "emergency" alone: opening the screen, asking, or
                # proposing the tap card are all safe; a send is impossible
                # without the tap (test_relay_sos_lifecycle pins it).
                allowed.add("trigger_save_my_soul")
            assert SOS_MUTATIONS_AND_CONFIRM - allowed <= set(case.forbidden_tools), case.id
            assert mutations - allowed <= set(case.forbidden_tools), case.id
        else:
            assert case.expected_tools, case.id
        if case.family == "trigger":
            assert case.expected_tools == ("trigger_save_my_soul",), case.id
        if case.family == "stop":
            assert case.expected_tools == ("stop_save_my_soul",), case.id
        if case.family == "open_only":
            assert case.expected_tools == ("open_screen",), case.id
            assert "trigger_save_my_soul" in case.forbidden_tools, case.id
        if case.family == "add_contact":
            # The name is grounded first; the add itself is never the first move.
            assert case.expected_tools == ("resolve_person",), case.id
        if case.family == "remove_contact":
            assert set(case.expected_tools) <= {"get_save_my_soul_status", "resolve_person"}, (
                case.id
            )
        if case.family == "delivery":
            assert set(case.expected_tools) <= {
                "report_save_my_soul_delivery",
                "get_save_my_soul_status",
            }, case.id
            assert case.history, (case.id, "a delivery check follows an armed alert")
        if case.family == "follow_up":
            assert case.history, (case.id, "a follow-up needs the turn it follows")
            assert set(case.expected_tools) <= {"cancel_pending_action", "resolve_person"}, case.id
        assert "sync_contacts" not in case.expected_tools

    # Some Hindi/Hinglish coverage in every family with >= 10 cases.
    for family, items in by_family.items():
        if len(items) >= 10:
            assert any("-hi-" in case.id for case in items), f"{family} has no Hindi/Hinglish case"

    corpus = support.production_corpus()
    for case in cases:
        # Every evaluated sentence is held out. History turns are too, except
        # conversational glue that no corpus can avoid; a bare one-word
        # utterance ("help", "SMS") is the case itself and is exempt for the
        # same reason -- the corpus has to name the feature.
        held_out = [case.utterance, *(h for h in case.history if len(h.split()) > 3)]
        for sentence in held_out:
            if len(sentence.split()) == 1:
                continue
            assert sentence.strip().lower() not in corpus, (case.id, sentence)


def test_sos_fake_world_prepares_real_cards_and_refuses_a_spoken_yes_and_unconfirmed_ids():
    case = Case("smoke", "trigger", "one_home", (), "x", ("trigger_save_my_soul",), (), "")
    respond = make_responder(case)
    status = asyncio.run(respond("get_save_my_soul_status", {}))
    assert status["status"] == "ready" and status["active_sos"] is False
    assert [c["display_name"] for c in status["emergency_contacts"]] == [
        "Ayesha Sharma",
        "Ravi Kumar",
        "Meera Nair",
    ]
    assert [c["sos_ready"] for c in status["emergency_contacts"]] == [True, True, False]
    card = asyncio.run(respond("trigger_save_my_soul", {"note": "car broke down"}))
    assert card["status"] == "confirmation_required" and card["tier"] == "tap"
    assert "Ayesha Sharma and Ravi Kumar" in card["summary"]
    assert "leaving out Meera Nair" in card["summary"] and "car broke down" in card["summary"]
    spoken_yes = asyncio.run(
        respond("confirm_pending_action", {"pending_action_id": card["pending_action_id"]})
    )
    assert spoken_yes["status"] == "tap_required"
    # Nothing was armed: the card is still pending and no grant exists.
    assert asyncio.run(respond("report_save_my_soul_delivery", {}))["status"] == "sos_not_sent"
    found = asyncio.run(respond("resolve_person", {"spoken_name": "Priya", "pool": "connections"}))
    assert found["status"] == "single_likely" and found["candidates"][0]["user_id"] == PRIYA
    invented = asyncio.run(respond("add_emergency_contact", {"person": {"user_id": ROHAN}}))
    assert invented["status"] == "rejected" and invented["reason_code"] == "person_not_confirmed"
    confirmed = asyncio.run(respond("confirm_person", {"user_id": PRIYA}))
    assert confirmed["status"] == "confirmed"
    add_card = asyncio.run(respond("add_emergency_contact", {"person": {"user_id": PRIYA}}))
    assert add_card["status"] == "confirmation_required" and add_card["tier"] == "voice"
    number = asyncio.run(
        respond("resolve_person", {"spoken_name": "9876543210", "pool": "connections"})
    )
    assert number["reason_code"] == "identifier_not_a_name"
    assert asyncio.run(respond("open_screen", {"screen": "location_sos"})) == {
        "status": "navigation_dispatched",
        "screen": "location_sos",
    }
    assert asyncio.run(respond("get_location_status", {})) == {"status": "ok", "spoken_facts": []}


def test_sos_fake_world_with_a_live_alert_reports_delivery_and_prepares_a_stop_card():
    case = Case("smoke", "delivery", "one_location_sos", ("x",), "y", (), (), "")
    respond = make_responder(case)
    report = asyncio.run(respond("report_save_my_soul_delivery", {}))
    assert report["status"] == "sos_sent"
    assert report["delivered"] == ["Ayesha Sharma", "Ravi Kumar"] and report["alert_active"]
    status = asyncio.run(respond("get_save_my_soul_status", {}))
    assert status["status"] == "active" and status["active_grant_count"] == 2
    again = asyncio.run(respond("trigger_save_my_soul", {}))
    assert again["status"] == "already_active"
    stop = asyncio.run(respond("stop_save_my_soul", {}))
    assert stop["status"] == "confirmation_required" and stop["tier"] == "tap"
    assert "2 live location shares" in stop["summary"]
    # A follow_up marked active starts the same way; an unmarked one does not.
    marked = Case("follow_up-active-9", "follow_up", "one_home", ("x",), "y", (), (), "")
    assert _starts_with_active_alert(marked)
    plain = Case("follow_up-9", "follow_up", "one_home", ("x",), "y", (), (), "")
    assert not _starts_with_active_alert(plain)
    quiet = make_responder(plain)
    assert asyncio.run(quiet("stop_save_my_soul", {}))["status"] == "not_active"


# --- live: the real model -------------------------------------------------


def _real_tools(obs: Observation) -> list[str]:
    return [name for name in obs.all_tools if name not in support.SESSION_READS]


def _expected_hit(obs: Observation, reads: frozenset[str]) -> bool:
    if obs.error:
        return False
    real = _real_tools(obs)
    first = real[0] if real else None
    expected = set(obs.case.expected_tools)
    if not expected:
        # A turn that must change nothing may say nothing, read, or cancel a card.
        return first is None or first in reads or first in HARMLESS
    if first in expected:
        return True
    if first in HARMLESS:
        # A correction cancels the stale card first, then re-resolves (rule 11);
        # cancelling changes nothing, so judge the tool that follows it.
        real = [name for name in real if name not in HARMLESS]
        first = real[0] if real else None
        if first in expected:
            return True
    # A status read before acting is acceptable only when the expected tool
    # follows in the same turn (a trigger after "who will get it" is still a
    # trigger; a status read that ends the turn is not).
    return first == LEADING_READ and any(name in expected for name in real[1:])


def _executed_sos_mutation(obs: Observation) -> bool:
    return any(result.get("status") in EXECUTED_SOS_STATUSES for _, _, result in obs.calls)


def _rejected_with(obs: Observation, mutations: frozenset[str], codes: frozenset[str]) -> bool:
    return any(
        name in mutations
        and result.get("status") == "rejected"
        and result.get("reason_code") in codes
        for name, _, result in obs.calls
    )


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
        # A mutation proposed where nothing may change, or an SOS mutation
        # that actually ran (only a spoken yes on a voice-tier card can do
        # that here, and nobody said yes).
        # A correction ("no, I meant Meera") may end in a fresh card for the
        # corrected target once the stale one is cancelled (rule 11); the
        # fixture names that allowance by leaving the tool out of forbidden.
        allowed = set(mutations) - set(obs.case.forbidden_tools)
        unintended = (
            obs.case.family in NO_MUTATION_FAMILIES
            and any(name in mutations and name not in allowed for name in obs.all_tools)
        ) or _executed_sos_mutation(obs)
        block.unintended_mutation += int(unintended)
        block.unconfirmed_id_mutation += int(_rejected_with(obs, mutations, UNCONFIRMED_ID_CODES))
        block.missing_argument_mutation += int(
            _rejected_with(obs, mutations, MISSING_ARGUMENT_CODES)
        )
        # resolve and confirm in the same turn: the model never asked
        # "is that who you mean?" (reported, not gated).
        real = _real_tools(obs)
        block.skipped_confirm += int("resolve_person" in real and "confirm_person" in real)
        block.errors += int(obs.error is not None)
        if not hit or obs.forbidden_hit or obs.error or unintended:
            block.misses.append(
                {
                    "id": obs.case.id,
                    "family": obs.case.family,
                    "screen": obs.case.screen,
                    "utterance": obs.case.utterance,
                    "history": list(obs.case.history),
                    "note": obs.case.note,
                    "expected": list(obs.case.expected_tools),
                    "first_tool": obs.first_real_tool,
                    "first_args": obs.first_args,
                    "forbidden_hit": obs.forbidden_hit,
                    "unintended_mutation": unintended,
                    "got": [
                        {"tool": name, "args": args, "status": result.get("status")}
                        for name, args, result in obs.calls
                    ],
                    "error": obs.error,
                }
            )
    return families


def _per_case(observations: list[Observation], reads: frozenset[str]) -> list[dict[str, Any]]:
    return [
        {
            "id": obs.case.id,
            "family": obs.case.family,
            "screen": obs.case.screen,
            "utterance": obs.case.utterance,
            "expected": list(obs.case.expected_tools),
            "hit": _expected_hit(obs, reads),
            "forbidden_hit": obs.forbidden_hit,
            "first_tool": obs.first_real_tool,
            "first_args": obs.first_args,
            "tools": obs.all_tools,
            "latency_ms": round(obs.latency_ms, 1),
            "error": obs.error,
        }
        for obs in observations
    ]


def _report_path() -> Path:
    override = (os.environ.get(REPORT_PATH_ENV) or "").strip()
    if override:
        path = Path(override)
        path.parent.mkdir(parents=True, exist_ok=True)
        return path
    return support.report_path(REPORT_NAME)


@pytest.mark.live_model
@pytest.mark.skipif(
    os.environ.get(support.LIVE_EVAL_ENV) != "1",
    reason=f"set {support.LIVE_EVAL_ENV}=1 with Vertex ADC to run the real-model evaluation",
)
def test_live_model_selects_sos_tools():
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
    rates = {family: (b.expected_hits / b.n if b.n else None) for family, b in families.items()}
    report = {
        "schema_version": "one.voice.sos_tool_selection_report.v1",
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
            "expected_hit_rates": rates,
            "expected_hit_rate_min": MIN_EXPECTED_HIT_RATE,
        },
        "families": {name: b.as_dict() for name, b in sorted(families.items())},
        "cases": _per_case(observations, support.read_tools()),
    }
    path = _report_path()
    support.write_report(path, report)
    print(f"\nsos tool-selection report: {path}")

    assert errors_total == 0, f"{errors_total} provider errors; see {path}"
    assert forbidden_total == 0, f"forbidden tool selected {forbidden_total}x; see {path}"
    assert unintended_total == 0, (
        f"mutation proposed or executed where none was asked {unintended_total}x; see {path}"
    )
    assert unconfirmed_total == 0, (
        f"person mutation with an unconfirmed id {unconfirmed_total}x; see {path}"
    )
    low = {
        family: rate
        for family, rate in rates.items()
        if rate is not None and rate < MIN_EXPECTED_HIT_RATE[family]
    }
    assert not low, f"expected-tool hit rate below the family minimum: {low}; see {path}"

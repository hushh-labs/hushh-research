"""Held-out evaluation of which tool the Live head selects for circle
management and its connection prerequisites, against confusable requests.

Two tests share ``fixtures/circle_tool_selection.v1.json``:

* ``test_circle_fixture_is_well_formed_and_held_out`` always runs: fixture
  shape, every named tool really declared, every family's forbidden set
  carries the tools that would be the *wrong* effect (leave vs delete, remove
  from circle vs disconnect, add vs send a connection request), and no fixture
  sentence appears verbatim anywhere the model could have read it.

* ``test_live_model_selects_circle_tools`` drives the real model (marked
  ``live_model``, skipped unless ``ONE_VOICE_LIVE_TOOL_EVAL=1``). Function
  calls are answered by the REAL tool executor over in-memory doubles: reads
  return real ids and rosters, mutations stop at ``confirmation_required``
  with an in-memory pending store, and nothing outside the circle/people
  families executes at all. So a follow-up turn ("rename it", "take her out")
  sees exactly the ids an earlier read returned, and a hallucinated id is
  refused by the same guards production uses -- and counted.
"""

from __future__ import annotations

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
from tests.one_voice.test_tools_circles import (
    FakeCircleService,
    FakeConnectionsService,
    FakeLocationAgentService,
    _request,
    _row,
)
from tests.one_voice.tool_selection_eval_support import Case, FamilyMetrics, Observation

FIXTURE_PATH = support.TESTS_DIR / "fixtures" / "circle_tool_selection.v1.json"
REPORT_NAME = "one-voice-circle-eval-report.json"
SCHEMA_VERSION = "one.voice.circle_tool_selection.v1"

FAMILIES = frozenset(
    {
        "create",
        "read_members",
        "read_details",
        "rename",
        "set_kind",
        "add_member",
        "remove_member",
        "leave",
        "delete",
        "connection_prereq",
        "follow_up",
        "no_mutation",
        "clarify",
    }
)
CLEAR_INTENT_FAMILIES = FAMILIES - {"no_mutation", "clarify"}
NO_MUTATION_FAMILIES = frozenset({"no_mutation", "clarify"})
SCREENS = frozenset({"one_home", "one_location", "one_location_circle"})
MIN_CASES = 180
MIN_EXPECTED_HIT_RATE = 0.95

# What each family's forbidden set must at least contain: the tool whose
# effect is the confusable *wrong* outcome for that intent.
WRONG_EFFECT = {
    "create": {"delete_circle", "add_circle_member", "invite_person"},
    "read_members": {"remove_circle_member", "add_circle_member", "delete_circle", "leave_circle"},
    "read_details": {"rename_circle", "delete_circle", "leave_circle"},
    "rename": {"delete_circle", "create_circle", "leave_circle"},
    "set_kind": {"rename_circle", "delete_circle", "create_circle", "leave_circle"},
    "add_member": {"remove_circle_member", "invite_person", "create_circle_invite_link"},
    "remove_member": {"remove_connection", "delete_circle", "leave_circle"},
    "leave": {"delete_circle", "remove_circle_member", "remove_connection"},
    "delete": {"leave_circle", "remove_circle_member", "remove_connection"},
    "connection_prereq": {"add_circle_member", "create_circle_invite_link"},
    "follow_up": set(),
    "no_mutation": set(),
    "clarify": set(),
}
# An id the model never received (or a malformed argument). A real, offered
# id used before confirm_* is a different, softer miss: the executor refuses
# it with *_not_confirmed and the model recovers by confirming; that count is
# reported as ``skipped_confirm`` but not gated.
UNCONFIRMED_ID_CODES = frozenset({"circle_not_offered", "person_not_offered"})
MISSING_ARGUMENT_CODES = frozenset({"invalid_arguments"})
SKIPPED_CONFIRM_CODES = frozenset({"person_not_confirmed", "circle_not_confirmed"})

# --- the fake world -------------------------------------------------------

ME = "user-me"
PRIYA = "user-priya"
ROHAN = "user-rohan"
AYESHA = "user-ayesha"
DEV = "user-dev"
KUSHAL = "user-kushal"
MEERA = "user-meera"
FAMILY = "11111111-1111-4111-8111-111111111111"
WEEKEND = "22222222-2222-4222-8222-222222222222"
WORK = "33333333-3333-4333-8333-333333333333"


def _circle_people_names() -> set[str]:
    from hushh_mcp.one_voice.tools import circles, people

    return {tool.name for tool in (*circles.TOOLS, *people.TOOLS)}


class _EvalConnections(FakeConnectionsService):
    def __init__(self) -> None:
        super().__init__()
        self.connections = [
            {"userId": PRIYA, "displayName": "Priya Nair", "connectionId": "c-1"},
            {"userId": ROHAN, "displayName": "Rohan Mehta", "connectionId": "c-2"},
            {"userId": AYESHA, "displayName": "Ayesha Sharma", "connectionId": "c-3"},
        ]
        self.outgoing = [_request("req-out-1", KUSHAL, "Kushal Rao")]
        self.incoming = [_request("req-in-1", MEERA, "Meera Iyer")]
        self.directory = [
            {"userId": DEV, "displayName": "Dev Patel", "relationship": "none"},
            {"userId": KUSHAL, "displayName": "Kushal Rao", "relationship": "pending_outgoing"},
            {"userId": MEERA, "displayName": "Meera Iyer", "relationship": "pending_incoming"},
            {"userId": PRIYA, "displayName": "Priya Nair", "relationship": "connected"},
        ]

    def search_directory(self, user_id: str, *, query: str = "", page: int = 1, limit: int = 20):
        needle = (query or "").lower()
        items = [
            row
            for row in self.directory
            if any(tok.startswith(needle) for tok in row["displayName"].lower().split())
        ]
        return {"items": items, "page": page, "hasMore": False, "audience": "all"}

    def create_request(self, *args: Any, **kwargs: Any):
        return {"id": "req-new", "status": "pending"}

    def accept_request(self, user_id: str, request_id: str):
        return {"status": "accepted", "connectionId": "conn-new"}

    def reject_request(self, user_id: str, request_id: str):
        return {"status": "rejected"}

    def cancel_request(self, user_id: str, request_id: str):
        return {"status": "cancelled"}


class _EvalLocation(FakeLocationAgentService):
    def __init__(self, connections: _EvalConnections) -> None:
        self._connections = connections

    def search_directory_candidates(
        self, *, owner_user_id: str, candidate_user_id: str | None = None, **kwargs: Any
    ):
        rows = [r for r in self._connections.directory if r["userId"] == candidate_user_id]
        return {"items": [dict(r, phoneVerified=True) for r in rows], "page": 1, "hasMore": False}


def _world() -> FakeCircleService:
    service = FakeCircleService()
    service.circles = [
        _row(
            FAMILY,
            "Family",
            kind="family",
            members=[(ME, "Me"), (PRIYA, "Priya Nair"), (ROHAN, "Rohan Mehta")],
        ),
        _row(
            WEEKEND, "Weekend Crew", kind="friends", members=[(ME, "Me"), (AYESHA, "Ayesha Sharma")]
        ),
        _row(
            WORK,
            "Work Friends",
            kind="other",
            role="member",
            members=[(ROHAN, "Rohan Mehta"), (ME, "Me"), (DEV, "Dev Patel")],
        ),
    ]
    for row in service.circles:
        for member in row["members"]:
            if member["userId"] == ME:
                member["relationship"] = "self"
            elif member["userId"] == DEV:
                member["relationship"] = "none"
    service.eligible = {
        FAMILY: [{"userId": AYESHA, "displayName": "Ayesha Sharma"}],
        WEEKEND: [
            {"userId": PRIYA, "displayName": "Priya Nair"},
            {"userId": ROHAN, "displayName": "Rohan Mehta"},
        ],
    }
    service.outgoing = []
    service.incoming = []
    return service


def make_responder(case: Case) -> support.Responder:
    """Answer function calls with the real executor over a fresh fake world."""
    from hushh_mcp.one_voice.tools import circles

    service = _world()
    connections = _EvalConnections()
    pending = MemoryPendingStore()
    executor = ToolExecutor(pending_store=pending)
    screen = ScreenContext(
        screen_id=case.screen,
        active_circle_id=FAMILY if case.screen == "one_location_circle" else None,
    )
    ctx = ToolContext(
        user_id=ME,
        conversation_id="conv-eval",
        entities=EntityContext(),
        screen=screen,
        vault_owner_token="vault-token",  # noqa: S106 - test double
        firebase_id_token="firebase-token",  # noqa: S106 - test double
        services={
            circles.CIRCLE_SERVICE: service,
            "connections": connections,
            "location": _EvalLocation(connections),
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
            # The card is shown at once in this world, so a spoken yes on a
            # voice-tier card can proceed; tap-tier still refuses the voice path.
            await pending.mark_shown(user_id=ME, pending_action_id=outcome.pending.id)
        return outcome.result.public()

    return respond


# --- offline: the fixture -------------------------------------------------


def load_fixture() -> list[Case]:
    return support.load_cases(
        FIXTURE_PATH, schema_version=SCHEMA_VERSION, families=FAMILIES, screens=SCREENS
    )


def test_circle_fixture_is_well_formed_and_held_out():
    cases = load_fixture()
    assert len(cases) >= MIN_CASES, len(cases)
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
            # Every mutation is forbidden for a case that must not change anything.
            assert mutations <= set(case.forbidden_tools), case.id
        else:
            assert case.expected_tools, case.id

    corpus = support.production_corpus()
    for case in cases:
        # Every evaluated utterance is held out. History turns are too, except
        # conversational glue ("yes", "that one") that no corpus can avoid.
        held_out = [case.utterance, *(h for h in case.history if len(h.split()) > 3)]
        for sentence in held_out:
            assert sentence.strip().lower() not in corpus, (case.id, sentence)


def test_fake_world_answers_reads_with_real_ids_and_stops_mutations_at_a_card():
    """The responder is the real executor: a read returns canonical ids, a
    mutation returns confirmation_required, and nothing leaks a join code."""
    import asyncio

    case = Case("smoke", "read_members", "one_home", (), "x", (), (), "")
    respond = make_responder(case)
    listed = asyncio.run(respond("list_circles", {}))
    assert listed["status"] == "ok" and [c["circle_id"] for c in listed["circles"]] == [
        FAMILY,
        WEEKEND,
        WORK,
    ]
    confirmed = asyncio.run(respond("confirm_circle", {"circle_id": FAMILY}))
    assert confirmed["status"] == "confirmed"
    roster = asyncio.run(respond("list_circle_members", {"circle": {"circle_id": FAMILY}}))
    assert roster["status"] == "ok" and roster["total_count"] == 3
    person = asyncio.run(respond("confirm_person", {"user_id": PRIYA}))
    assert person["status"] == "confirmed"
    card = asyncio.run(
        respond(
            "remove_circle_member", {"circle": {"circle_id": FAMILY}, "person": {"user_id": PRIYA}}
        )
    )
    assert card["status"] == "confirmation_required" and card["tier"] == "tap"
    invented = asyncio.run(respond("delete_circle", {"circle": {"circle_id": WEEKEND}}))
    assert invented["status"] == "rejected" and invented["reason_code"] == "circle_not_confirmed"
    other = asyncio.run(respond("get_location_status", {}))
    assert other == {"status": "ok", "spoken_facts": []}
    details = asyncio.run(respond("get_circle_details", {"circle": {"circle_id": FAMILY}}))
    assert "SECRET-CODE" not in str(details)


# --- live: the real model -------------------------------------------------


def _expected_hit(obs: Observation, reads: frozenset[str]) -> bool:
    if obs.error:
        return False
    if not obs.case.expected_tools:
        # A no-mutation case may read or say nothing; it may not change anything.
        return obs.first_tool is None or obs.first_tool in reads
    return obs.first_tool in obs.case.expected_tools


def _unconfirmed_id_mutation(obs: Observation, mutations: frozenset[str]) -> bool:
    return any(
        name in mutations
        and result.get("status") == "rejected"
        and result.get("reason_code") in UNCONFIRMED_ID_CODES
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
        unintended = obs.case.family in NO_MUTATION_FAMILIES and any(
            name in mutations for name in obs.all_tools
        )
        block.unintended_mutation += int(unintended)
        block.unconfirmed_id_mutation += int(_unconfirmed_id_mutation(obs, mutations))
        block.missing_argument_mutation += int(
            any(
                name in mutations
                and result.get("status") == "rejected"
                and result.get("reason_code") in MISSING_ARGUMENT_CODES
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
def test_live_model_selects_circle_tools():
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
    forbidden_total = sum(block.forbidden_hits for block in families.values())
    unintended_total = sum(block.unintended_mutation for block in families.values())
    unconfirmed_total = sum(block.unconfirmed_id_mutation for block in families.values())
    errors_total = sum(block.errors for block in families.values())
    clear_rates = {
        family: (block.expected_hits / block.n if block.n else None)
        for family, block in families.items()
        if family in CLEAR_INTENT_FAMILIES
    }
    report = {
        "schema_version": "one.voice.circle_tool_selection_report.v1",
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
        "families": {name: block.as_dict() for name, block in sorted(families.items())},
    }
    path = support.report_path(REPORT_NAME)
    support.write_report(path, report)
    print(f"\ncircle tool-selection report: {path}")

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

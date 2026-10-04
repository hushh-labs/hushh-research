"""System instruction for the Live head: authored policy + runtime narration contract.

``build_instruction`` is exercised with the real registry declarations so the
tool list the model reads is the one the executor serves.
"""

from __future__ import annotations

import pytest

from hushh_mcp.one_voice import instruction
from hushh_mcp.one_voice.tools import location_state, registry
from hushh_mcp.one_voice.tools.session import OPENABLE_SCREENS

RESUME = "resume_device_location_updates"
PAUSE = "pause_device_location_updates"


def _build(**overrides):
    kwargs = {
        "tool_declarations": registry.declarations(),
        "screen_ids": list(OPENABLE_SCREENS),
        "screen_id": "one_home",
        "display_name": "Ayesha",
    }
    kwargs.update(overrides)
    return instruction.build_instruction(**kwargs)


def _tool_line(name: str) -> str:
    spec = next(tool for tool in location_state.TOOLS if tool.name == name)
    return f"- {name}: {spec.description.strip().splitlines()[0]}"


def _rule(text: str, number: int) -> str:
    """One numbered narration rule, hard wraps collapsed to single spaces."""
    start = text.index(f"\n{number}. ")
    end = text.find(f"\n{number + 1}. ", start)
    return " ".join(text[start : end if end != -1 else len(text)].split())


def test_instruction_lists_both_device_tools_by_their_first_line():
    text = _build()
    assert "Tools you can call:" in text
    assert _tool_line(RESUME) in text
    assert _tool_line(PAUSE) in text
    # The first line carries the effect-and-boundary sentence the model selects on.
    assert "same operation as the Location screen's switch" in _tool_line(RESUME)
    assert "same operation as the Location screen's switch" in _tool_line(PAUSE)


def test_rule_two_names_the_pending_status_as_not_success():
    text = _build()
    rule = _rule(text, 2)
    assert "Success words are earned, not assumed." in rule
    assert "location_updates_pending" in rule
    assert "switching that on this device now" in rule
    assert "[ONE_EVENT] tool_result" in rule
    # A dispatched open, a reused card and an unseen card are not outcomes.
    assert '"opened"' in rule
    not_success = rule.split("These statuses are NOT success:", 1)[1]
    for status in (
        "navigation_dispatched",
        "mail_open_dispatched",
        "confirmation_waiting",
        "pending_action_exists",
        "card_not_shown",
    ):
        assert status in not_success


def test_rule_four_answers_a_waiting_card_with_its_id_not_a_new_proposal():
    rule = _rule(_build(), 4)
    assert "confirmation_waiting means that exact action is already waiting" in rule
    assert "do not ask again and do not call the tool again" in rule
    assert "call confirm_pending_action with its pending_action_id" in rule
    assert "card_not_shown means the card has not appeared yet" in rule
    assert "[ONE_EVENT] pending_shown" in rule
    # UAT 2026-10-02: a restated detail was read as a correction and re-asked.
    assert "it is not a correction, so never cancel it and propose the same thing again" in rule
    assert "repeats_cancelled means you cancelled this exact proposal" in rule


def test_rule_four_confirms_first_when_a_yes_also_asks_for_more():
    """UAT: "Create Family" -> "Yes, and add all my connections to it" was read as
    a change, so the create card was cancelled and the same question asked
    again. A yes plus a second request confirms first and continues from the
    real result; only a change to the waiting action itself is a correction."""
    rule = _rule(_build(), 4)
    assert "approves the waiting action and makes a second request" in rule
    assert "call confirm_pending_action first" in rule
    assert "prepare the second request only after that result says it succeeded" in rule
    assert (
        "Never cancel or re-propose the waiting action because the same answer asked for more"
        in rule
    )
    assert "A change to the waiting action itself" in rule and "is a correction" in rule
    assert "pending_action_exists means a different action is still waiting" in rule


def test_opening_screens_rule_says_opened_only_after_the_app_reports_it():
    rule = _rule(_build(), 14)
    assert "navigation_dispatched means the app was asked, not that anything is showing" in rule
    assert "[ONE_EVENT] ui_settled for that screen with status opened" in rule
    assert "Status failed means it did not open" in rule
    assert "never say it opened" in rule
    assert "screen person_profile and their user_id" in rule
    assert "screen profile is only the person's own profile" in rule


def test_rule_seven_routes_a_bare_location_request_to_the_device_switch():
    text = _build()
    rule = _rule(text, 7)
    assert "this device's Location updates switch" in rule
    assert (
        "A request to turn their location on or off with no person named is about this "
        f"device's Location updates switch: use {RESUME} or {PAUSE}, never turn_sharing_on or "
        "turn_sharing_off"
    ) in rule
    assert (
        'Say "Location is on" or "Location is off" only when a '
        f"{RESUME} or {PAUSE} result says on, off, already_on, or already_off."
    ) in rule


def test_authored_policy_from_agent_yaml_is_present():
    text = _build()
    authored = str(instruction.voice_head_config()["instruction"]).strip()
    assert text.startswith(authored)
    # The YAML block keeps its hard wraps; compare on collapsed whitespace.
    flat = " ".join(text.split())
    assert "Treat clear polite requests as requests to act" in flat
    assert "not merely questions about your ability" in flat
    assert "do not ask for a prescribed phrase or exact wording" in flat
    assert "Do not claim completion before the tool's final execution result supports it" in flat
    assert "Select a declared tool whose documented effect matches that outcome" in flat


def test_context_lines_name_the_person_and_screen():
    text = _build()
    assert "The person's name is Ayesha. They are currently on the one_home screen." in text
    assert "Screens open_screen can open: " + ", ".join(OPENABLE_SCREENS) in text
    bare = _build(display_name=None, screen_id=None)
    assert "The person's name is" not in bare and "currently on the" not in bare


@pytest.mark.parametrize("resumed", [True, False])
def test_resumed_caveat_is_added_only_when_the_conversation_was_resumed(resumed):
    text = _build(resumed=resumed)
    assert (instruction.RESUMED_CAVEAT in text) is resumed
    assert ("This conversation was resumed." in text) is resumed
    if resumed:
        assert text.endswith(instruction.RESUMED_CAVEAT)
    else:
        assert text.endswith(instruction.NARRATION_CONTRACT)


def test_resumed_default_is_false():
    assert instruction.RESUMED_CAVEAT not in _build()


def test_rule_ten_separates_circle_membership_from_connection_and_leave_from_delete():
    text = _build()
    rule = _rule(text, 10)
    assert "a circle is a group; being in one is not being connected" in rule
    assert '"Who is in it" is list_circle_members' in rule
    assert "remove_circle_member, never remove_connection" in rule
    assert "leave_circle, never delete_circle" in rule
    assert "Confirming which circle or person they meant approves nothing" in rule
    assert "send a connection request only if they ask, with invite_person" in rule
    # Several people joining one circle is one call and one card. This replaced
    # "one at a time", which is what made three names cost three confirmations.
    assert "Two or more people joining one circle is add_circle_members" in rule
    assert "never describe a skipped person as added" in rule
    assert "One person is add_circle_member" in rule
    assert "one at a time" not in rule, "the batch path makes this instruction wrong"
    # "All my connections" is a set the server resolves, never a resolve loop.
    assert "Everyone they are connected with joining one circle is add_all_connections" in rule
    assert "Never resolve_person or list people to add their connections one by one" in rule
    assert "It adds all or none" in rule
    assert "It refuses Trusted and the SMS circle" in rule
    assert "add_all_connections" in {item["name"] for item in registry.declarations()}
    # Both circle reads are declared with their first line, so the model can pick them.
    declared = {item["name"] for item in registry.declarations()}
    assert {"get_circle_details", "list_circle_members"} <= declared
    assert "- get_circle_details: " in text and "- list_circle_members: " in text


def test_rules_three_six_and_eleven_ground_connections_in_real_records_and_results():
    text = _build()
    three = _rule(text, 3)
    assert 'A relative ("my uncle", "my mom") is not a name and there is no family list' in three
    assert "A phone number or email is not a name either" in three
    assert (
        "Low confidence, none, or truncated: ask them to repeat, spell, or give the full name"
        in three
    )
    six = _rule(text, 6)
    assert "A pending request is not a connection" in six
    eleven = _rule(text, 11)
    assert "invite_person sends a plain request and nothing else" in eleven
    assert '"Sent" means the result says sent with a request id' in eleven
    assert "accept_connection_request or decline_connection_request" in eleven
    assert "remove_connection, which ends it everywhere" in eleven
    assert (
        "scope_review_required means the review screen is open and nothing was accepted yet"
        in eleven
    )
    assert "firebase_proof_required, ask them to tap Confirm on the card" in eleven
    assert 'A correction ("no, Priya Sharma") starts over' in eleven
    # One-at-a-time is about connection requests, never circle membership.
    assert "Several connection requests: one at a time" in eleven
    assert "Several people: one at a time" not in eleven
    declared = {item["name"] for item in registry.declarations()}
    assert {"accept_connection_request", "decline_connection_request", "invite_person"} <= declared
    assert "respond_connection_request" not in declared

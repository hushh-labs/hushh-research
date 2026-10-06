"""System instruction for the Live head: authored policy + runtime narration contract.

``build_instruction`` is exercised with the real registry declarations so the
tool list the model reads is the one the executor serves.
"""

from __future__ import annotations

import runpy
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

from hushh_mcp.one_voice import instruction
from hushh_mcp.one_voice.tools import location_state, registry
from hushh_mcp.one_voice.tools.session import OPENABLE_SCREENS
from hushh_mcp.services import owner_time

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
        "draft_open_requested",
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
    # UAT 2026-10-06: the head re-proposed and re-asked with no answer between.
    assert (
        "say so and wait. After you ask, wait for their answer: never propose again or "
        'repeat the question on your own. "No", "stop"'
    ) in rule


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
    # UAT 2026-10-06: a spelled correction to a waiting circle name cancelled
    # the card and asked "What is the name again?" instead of re-proposing.
    assert (
        '"no, it\'s spelled K A Y R A") is a correction: cancel it and propose the '
        "corrected one in the same turn, changing only what they corrected; do not ask again "
        "for anything they already gave clearly."
    ) in rule
    # Re-proposing at once never skips rule 3: a different person is resolved
    # and confirmed before anything is proposed for them.
    assert (
        'A different person still follows rule 3: resolve the new name and ask "Is that who '
        'you mean?" before proposing.'
    ) in rule
    assert "never ask again for what they already gave" not in rule


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
    # Spelled letters are the name; the brand spelling applies only to the company.
    # The examples are words no evaluation case spells, so the eval stays held out.
    assert (
        "Names are exact. When the person spells a word letter by letter "
        '("k a y r a", "double l", "B zero seven"), use exactly those letters and digits '
        "for that word and keep the rest of the name as they gave it."
    ) in flat
    assert (
        "The company is Hussh, spelled with two s's; use that spelling only when they mean "
        "the company."
    ) in flat
    # UAT 2026-10-06: an unclear word was guessed again instead of spelled.
    assert (
        "If a word of a name is unclear, or they say a name is wrong without giving the fix, "
        "ask them to spell just that word instead of guessing again."
    ) in flat


def test_context_lines_name_the_person_and_screen():
    text = _build()
    assert "The person's name is Ayesha. They are currently on the one_home screen." in text
    assert "Screens open_screen can open: " + ", ".join(OPENABLE_SCREENS) in text
    bare = _build(display_name=None, screen_id=None)
    assert "The person's name is" not in bare and "currently on the" not in bare


def test_owner_clock_sits_between_the_context_line_and_the_tool_list():
    """A relative send time is resolved against the owner's clock, so the model
    is given it; without a zone the honest fallback is UTC, named as such."""
    now = datetime(2026, 10, 5, 14, 6, 55, tzinfo=timezone.utc)
    text = _build(timezone="Asia/Calcutta", now=now)
    context = text.index("They are currently on the one_home screen.")
    clock = text.index("Current time: 2026-10-05T14:06:55+00:00 (UTC).")
    assert context < clock < text.index("Tools you can call:")
    assert "The owner's local time is 2026-10-05 19:36:55 Asia/Calcutta — Monday" in text
    # The owner's wall clock with no offset: the server applies the zone.
    assert "e.g. 2026-10-06T09:00:00;" in text

    fallback = _build(now=now)
    assert "The owner's local time is 2026-10-05 14:06:55 UTC — Monday" in fallback
    assert "Asia/Calcutta" not in fallback


def test_instruction_budget_is_calendar_stable_but_rejects_payload_growth(monkeypatch, capsys):
    """The same tree failed core after UTC midnight changed Monday to Tuesday.

    Only the benchmark clock is fixed: live instructions must retain the real
    weekday, and growth of the authored payload must still fail the cap.
    """
    script = Path(__file__).resolve().parents[3] / "scripts" / "one_voice_instruction_budget.py"
    monkeypatch.setattr(sys, "path", sys.path.copy())
    benchmark = runpy.run_path(str(script))
    current = datetime(2026, 10, 5, 14, 6, 55, tzinfo=timezone.utc)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return current.astimezone(tz) if tz else current.replace(tzinfo=None)

    monkeypatch.setattr(owner_time, "datetime", Clock)
    samples = []
    for day, weekday in ((5, "Monday"), (6, "Tuesday"), (7, "Wednesday")):
        current = datetime(2026, 10, day, 14, 6, 55, tzinfo=timezone.utc)
        samples.append(benchmark["measure"]())
        assert f"UTC — {weekday}" in _build()
    assert all(sample == samples[0] for sample in samples), (
        "benchmark metrics changed with the wall clock"
    )

    monkeypatch.setattr(sys, "argv", [str(script), "--check"])
    assert benchmark["main"]() == 0
    capsys.readouterr()
    config = instruction.voice_head_config()
    monkeypatch.setattr(
        instruction,
        "voice_head_config",
        lambda: {
            **config,
            "instruction": str(config["instruction"]) + "\nExtra authored instruction.",
        },
    )
    assert benchmark["main"]() == 1
    assert "One Voice performance budget exceeded" in capsys.readouterr().err


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


def test_rule_thirteen_keeps_voice_away_from_sending_and_from_duplicate_drafts():
    rule = _rule(_build(), 13)
    assert "The action card's button is Confirm, not Send" in rule
    assert "Only the later draft_opened client-step result proves it appeared" in rule
    assert (
        "Only the person's Send tap delivers a send_mail or reply_mail draft: you never send it"
    ) in rule
    # A later time is a scheduled send; the server sends it, so the model may say
    # "scheduled" after the yes but never "sent".
    assert "Sending later is schedule_mail, never send_mail" in rule
    assert "say it is scheduled for that time, never that it was sent" in rule
    assert "say it was sent only from a draft_sent result" in rule
    # "Sent" is the delivery's own settled report, never a draft result or memory.
    assert "Say mail was sent only from a [ONE_EVENT] mail_delivery whose status is sent" in rule
    assert "failed, outcome_unknown, thread_unconfirmed and unverified are not sent" in rule
    # An unverified draft may already be on screen: never offer it again unasked.
    assert "open_mail_draft client-step result with reason_code storage_unavailable" in rule
    assert "storage_unavailable or draft_not_settled" in rule
    assert "never prepare the same draft again unless the person asks for it" in rule


def test_rule_thirteen_addresses_a_reply_by_the_email_it_answers():
    """A reply's recipient comes from the email. A person lookup or a new
    send_mail for it would address whoever the model picked from a name."""
    text = _build()
    rule = _rule(text, 13)
    assert "When send_mail or reply_mail returns confirmation_required" in rule
    assert (
        "is reply_mail with that position, or with no position when they mean the "
        "email open on screen"
    ) in rule
    assert "never resolve_person or send_mail for a reply" in rule
    assert '"Email Priya" or "write to Priya" is send_mail' in rule
    assert "never pick one from a name" in rule
    assert "Forwarding, reply-all, a new subject and attachments are not possible here" in rule
    # Live eval: "reply all ... say thanks everyone" became a sender-only
    # reply_mail in 2 of 5 samples while the rule only said "say so". A
    # blanket "call no tool" here also stopped "don't open three; summarize
    # it" from reading, so the rule withholds only the reply.
    assert (
        "say so and ask whether a reply to the sender alone would do; prepare "
        "nothing until they answer"
    ) in rule
    assert "call no tool, and ask" not in rule
    # The rule names a tool the model is actually given.
    assert "- reply_mail: " in text


def test_rule_four_lets_an_independent_follow_up_proceed_while_a_draft_opens():
    rule = _rule(_build(), 4)
    assert "A second request that does not need the first one's result" in rule
    assert "draft_open_requested, for example" in rule

"""A model quote maps onto the owner's exact characters, or onto nothing."""

import pytest

from hushh_mcp.services.pkm_source_quote import locate_source_quote

# Invisible or look-alike characters are spelled by code point so a reader can see them.
NBSP = chr(0x00A0)
ELLIPSIS = chr(0x2026)
CURLY_APOSTROPHE = chr(0x2019)
FULLWIDTH_TEA = "".join(chr(ord(char) + 0xFEE0) for char in "tea")


@pytest.mark.parametrize(
    "message,quote,expected",
    [
        ("i like filter coffee", "I like filter coffee", "i like filter coffee"),
        ("i prefer tea", "I prefer tea.", "i prefer tea"),
        ("wait... i like tea", f"wait{ELLIPSIS} i like tea", "wait... i like tea"),
        (f"i like {FULLWIDTH_TEA} a lot", "I like tea a lot", f"i like {FULLWIDTH_TEA} a lot"),
        ("dont book me early flights", "don't book me early flights", "dont book me early flights"),
        (
            "don't book me early flights",
            "dont book me early flights",
            "don't book me early flights",
        ),
        (f"don{CURLY_APOSTROPHE}t book me", "don't book me", f"don{CURLY_APOSTROPHE}t book me"),
        (f"i  like{NBSP}tea \n daily", "i like tea daily", f"i  like{NBSP}tea \n daily"),
        ("ok\nमुझे चाय पसंद नहीं है\nbye", "मुझे चाय पसंद नहीं है", "मुझे चाय पसंद नहीं है"),
        (
            "ok\nmujhe Chai pasand nahi hai\nbye",
            "Mujhe chai pasand nahi hai.",
            "mujhe Chai pasand nahi hai",
        ),
        ("so this is it", "This is it!", "this is it"),
        # The owner's own end punctuation stays when the drifted quote carries it too.
        (
            "i'm allergic to penicillin?",
            "I'm allergic to penicillin?",
            "i'm allergic to penicillin?",
        ),
        ("i like coffee\nbye", "I like coffee.", "i like coffee"),
    ],
)
def test_copy_drift_maps_to_the_owners_original_characters(message, quote, expected):
    span = locate_source_quote(message, quote)
    assert span is not None
    assert message[span[0] : span[1]] == expected


@pytest.mark.parametrize(
    "message,quote",
    [
        ("i like tea", "I own a yacht."),
        ("mujhe chai pasand nahi hai", "I don't like tea"),
        ("i like coffee", "The owner likes coffee"),
        ("i like tea", "?!"),
        ("i like tea", "I"),
        # A folded match may not start inside a word: "His is" is not in "this is it".
        ("this is it", "His is"),
        # A quote may not end a clause the owner kept writing, which would drop its qualifier.
        ("i'm vegetarian, except on weekends", "I'm vegetarian."),
        # Different original lines folding to one form are ambiguous: another person's line
        # must never stand in for the owner's own.
        ("Priya: I like tea\nme: i like tea", "I like tea."),
    ],
)
def test_rewritten_or_degenerate_quotes_match_nothing(message, quote):
    assert locate_source_quote(message, quote) is None

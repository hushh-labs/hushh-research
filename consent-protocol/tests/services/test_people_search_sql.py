"""One rule for people search, and every paged list held to it.

People read a name from the start of its words: `n` means Neelesh, `kum` means
Kumar. A bare substring match does not know that -- with connections named
"Ankit Kumar Singh" and "Neelesh Meena", typing `n` matches BOTH, and an A-Z
ordering then puts Ankit first, above the person the query actually begins.

That was reported three times, on three separate screens. The client settled it
once in `hushh-webapp/lib/one-location/people-search.ts` (protected behaviour
`location-people-search-finds-a-person-from-one-letter`), but every server-paged
list carried its own copy of the old substring rule -- and the paged loader is
the one that ships.

`people_search_sql` is now the single server-side statement of the rule. These
tests hold the rule itself, and hold every paged people search to using it.
"""

from __future__ import annotations

import re
from pathlib import Path

import hushh_mcp.services.connections_service as connections_service_module
import hushh_mcp.services.one_location_agent_service as agent_service_module
import hushh_mcp.services.one_location_circle_service as circle_service_module
from hushh_mcp.services.people_search_sql import (
    PEOPLE_MATCH_RANK_SQL,
    PEOPLE_SINGLE_CHAR_NARROW_SQL,
    people_query_match_params,
)


def _rank_patterns(query: str) -> tuple[re.Pattern[str], re.Pattern[str]]:
    params = people_query_match_params(query)
    prefix = re.compile(str(params["query_prefix_re"]))
    # Python has no POSIX class shorthand; the SQL engine does.
    word = re.compile(str(params["query_word_re"]).replace("[:alnum:]", "a-z0-9"))
    return prefix, word


def test_one_character_is_flagged_so_the_query_can_be_narrowed() -> None:
    assert people_query_match_params("n")["query_is_single_char"] is True
    assert people_query_match_params("ne")["query_is_single_char"] is False
    assert people_query_match_params("")["query_is_single_char"] is False


def test_a_beginning_outranks_a_mid_word_hit() -> None:
    prefix, word = _rank_patterns("n")

    # The reported pair, exactly.
    assert prefix.search("neelesh meena")
    assert not prefix.search("ankit kumar singh")
    assert word.search("neelesh meena")
    assert not word.search("ankit kumar singh")


def test_a_word_that_is_not_the_first_still_counts_as_a_beginning() -> None:
    _, word = _rank_patterns("k")
    assert word.search("ankit kumar singh")  # "kumar"
    _, word = _rank_patterns("m")
    assert word.search("neelesh meena")  # "meena"


def test_punctuation_separates_words_the_way_a_reader_reads_them() -> None:
    for name, needle in (
        ("jean-luc picard", "l"),
        ("o'brien", "b"),
        ("r. meena", "m"),
    ):
        _, word = _rank_patterns(needle)
        assert word.search(name), f"{needle!r} should begin a word in {name!r}"


def test_a_query_cannot_smuggle_a_pattern_into_the_search() -> None:
    prefix, _ = _rank_patterns("r.")
    assert prefix.search("r. meena")
    assert not prefix.search("rx meena")


def test_an_empty_query_matches_nothing_through_the_rank_patterns() -> None:
    # The SQL gates on `:query = ''` first, but the patterns must not match by
    # accident if that guard is ever reordered.
    prefix, word = _rank_patterns("")
    assert prefix.search("anyone") is None
    assert word.search("anyone") is None


def test_two_characters_drop_nothing() -> None:
    # "ingh" must still find Singh: from two characters on, loose matches are
    # ranked last, never removed.
    assert people_query_match_params("ingh")["query_is_single_char"] is False
    prefix, word = _rank_patterns("ingh")
    assert not prefix.search("ankit kumar singh")
    assert not word.search("ankit kumar singh")
    assert "singh".find("ingh") > 0  # the loose tier is what keeps it


PAGED_PEOPLE_SEARCHES = (
    # module, how many paged people searches it owns
    (circle_service_module, 2),  # Circle members, and Add people
    (agent_service_module, 1),  # the People tab's Connections list
    (connections_service_module, 1),  # Connect's connections list
)


def test_every_paged_people_search_uses_the_shared_rule() -> None:
    # The divergence is the defect. A new paged list that writes its own
    # substring match is the same bug again on a fourth screen.
    for module, expected in PAGED_PEOPLE_SEARCHES:
        source = Path(module.__file__).read_text(encoding="utf-8")
        name = Path(module.__file__).name
        assert "people_query_match_params" in source, f"{name} builds its own binds"
        assert source.count("AS match_rank") == expected, name
        assert source.count("ORDER BY match_rank, normalized_name") == expected, name
        assert source.count("ORDER BY page_rows.match_rank") == expected, name
        assert source.count("WHERE NOT :query_is_single_char") == expected, name


def test_no_paged_people_search_still_orders_by_name_alone() -> None:
    # The exact shape of the bug: a substring filter ordered A-Z.
    for module, _ in PAGED_PEOPLE_SEARCHES:
        source = Path(module.__file__).read_text(encoding="utf-8")
        name = Path(module.__file__).name
        assert "ORDER BY normalized_name, user_id" not in source, name
        assert "ORDER BY page_rows.normalized_name" not in source, name


def test_the_sql_fragments_are_shaped_for_the_ctes_that_use_them() -> None:
    assert "AS match_rank" in PEOPLE_MATCH_RANK_SQL
    assert ":query_prefix_re" in PEOPLE_MATCH_RANK_SQL
    assert ":query_word_re" in PEOPLE_MATCH_RANK_SQL
    assert "FROM matched narrow" in PEOPLE_SINGLE_CHAR_NARROW_SQL

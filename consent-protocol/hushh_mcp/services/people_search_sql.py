"""One rule for how a typed query narrows a list of people, server-side.

People read a name from the start of its words: `n` means Neelesh, `kum` means
Kumar. A bare substring match does not know that. With connections named "Ankit
Kumar Singh" and "Neelesh Meena", typing `n` matches BOTH -- "Ankit" and
"Singh" each carry an "n" -- and an A-Z ordering then puts Ankit first, above
the person the query actually begins. Reported three separate times, on three
separate screens, as "one char search is not working".

`filterPeopleByQuery` in ``hushh-webapp/lib/one-location/people-search.ts``
settled this for the client and is covered by the protected behaviour
``location-people-search-finds-a-person-from-one-letter``. Every server-paged
list had its own copy of the old substring rule, so the same picker behaved
differently depending on which loader it was handed -- and the paged loader is
the one that ships.

This module is the single server-side statement of that rule, so there is one
place to read it and one place to change it.

THE RULE
--------

Three tiers, ordered best first, A-Z inside each:

  0  the name itself begins with the query
  1  a word inside the name begins with it
  2  it only appears mid-word

A single character is only meaningful as a beginning -- mid-word it matches
most names in any list -- so a one-character query keeps just tiers 0 and 1,
and falls back to tier 2 only when nothing begins with it, so it can never
empty a list that has a match. From two characters on nothing is dropped:
beginnings lead, loose matches follow, so `ingh` still finds Singh.
"""

from __future__ import annotations

import re

__all__ = [
    "people_query_match_params",
    "PEOPLE_MATCH_RANK_SQL",
    "PEOPLE_SINGLE_CHAR_NARROW_SQL",
]


def people_query_match_params(normalized_query: str) -> dict[str, object]:
    """Bind values for :data:`PEOPLE_MATCH_RANK_SQL` and its narrowing clause.

    ``normalized_query`` must already be lowercased and trimmed, matching the
    ``normalized_name`` expression the caller ranks against.

    A word boundary is anything that is not a letter or a digit, which keeps
    "Jean-Luc", "O'Brien" and "R. Meena" splitting the way a reader splits
    them. The query is regex-escaped, so a name containing ``.`` or ``*``
    cannot turn a search into a pattern. An empty query yields ``$^`` -- a
    pattern that matches nothing -- so the rank expression cannot match by
    accident if a caller ever reorders its ``:query = ''`` guard.
    """
    escaped = re.escape(normalized_query)
    return {
        "query_prefix_re": f"^{escaped}" if normalized_query else "$^",
        "query_word_re": (f"(^|[^[:alnum:]]){escaped}" if normalized_query else "$^"),
        "query_is_single_char": len(normalized_query) == 1,
    }


#: Rank expression. Select it as ``match_rank`` beside a ``normalized_name``
#: column, then ``ORDER BY match_rank, normalized_name, ...``.
PEOPLE_MATCH_RANK_SQL = """
                    CASE
                      WHEN :query = '' THEN 0
                      WHEN normalized_name ~ :query_prefix_re THEN 0
                      WHEN normalized_name ~ :query_word_re THEN 1
                      ELSE 2
                    END AS match_rank
""".strip("\n")

#: Narrowing clause for a CTE named ``matched`` that carries ``match_rank``.
#: Keeps only word-beginning matches for a one-character query, unless nothing
#: begins with it -- a list with a match is never emptied.
PEOPLE_SINGLE_CHAR_NARROW_SQL = """
                  WHERE NOT :query_is_single_char
                     OR match_rank < 2
                     OR NOT EXISTS (
                          SELECT 1 FROM matched narrow WHERE narrow.match_rank < 2
                        )
""".strip("\n")

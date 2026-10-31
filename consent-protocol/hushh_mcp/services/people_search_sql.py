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
import unicodedata

import phonenumbers


def normalize_directory_name(value: str) -> str:
    """Fold the directory's supported separators and repeated whitespace."""
    return " ".join(str(value or "").lower().translate(str.maketrans("-'._/,", "      ")).split())


def directory_name_rank(name: str, query: str) -> int | None:
    """All query tokens must prefix a name token; never match only the surname."""
    name, query = normalize_directory_name(name), normalize_directory_name(query)
    if not query or name == query:
        return 0
    if name.startswith(query):
        return 1
    if all(any(word.startswith(token) for word in name.split()) for token in query.split()):
        return 2
    return None


def mask_directory_phone(value: object) -> str | None:
    """Mask national digits only; never expose the country calling code."""
    phone = str(value or "").strip()
    if "*" in phone:
        # A legacy last-four label cannot recover its leading digits. Omit it
        # instead of forwarding a label that violates the directory contract.
        return phone if re.fullmatch(r"[0-9]{2}\*+[0-9]{2}", phone) else None
    # Canonical verified identities use international numbers. A bare legacy
    # number is ambiguous without its region, so do not guess its calling code.
    if phone.startswith("00"):
        phone = "+" + phone[2:]
    if not re.fullmatch(r"\+[0-9\s().-]+", phone):
        return None
    try:
        parsed = phonenumbers.parse(phone, None)
    except phonenumbers.NumberParseException:
        return None
    if not phonenumbers.is_possible_number(parsed):
        return None
    # national_number alone drops significant zeros, e.g. Italian landlines.
    digits = phonenumbers.national_significant_number(parsed)
    if len(digits) <= 4:
        return None
    return f"{digits[:2]}{'*' * (len(digits) - 4)}{digits[-2:]}"


def _directory_phone_queries(query: str) -> tuple[str, ...]:
    # Phone keyboards and copied contact cards can use fullwidth/Indic digits,
    # non-ASCII dashes, and invisible direction markers. Normalize only the
    # phone branch: names and email addresses keep their literal matching rules.
    query = unicodedata.normalize("NFKC", query).translate(
        str.maketrans(
            "‐‑‒–—―−",
            "-------",
            "\u200b\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\ufeff",
        )
    )
    query = "".join(
        str(unicodedata.decimal(char)) if char.isdecimal() else char for char in query
    ).strip()
    if not re.fullmatch(r"\+?[0-9\s().-]+", query):
        return ()
    digits = re.sub(r"[^0-9]", "", query)
    if not digits:
        return ()
    variants = [digits]
    # 00 is an international dialing prefix, not part of the stored E.164
    # number. Explicit international numbers also let libphonenumber remove
    # an optional national trunk, e.g. +91 (0) 98765 43210, without a country guess.
    international = query.startswith("+") or (digits.startswith("00") and len(digits) > 2)
    if international:
        candidate = f"+{digits[2:]}" if digits.startswith("00") else f"+{digits}"
        if digits.startswith("00"):
            variants.append(digits[2:])
        # Preserve this alternative while the subscriber digits are still
        # being typed, before a full-number parser can accept the number.
        formatted = re.sub(r"[\s.-]", "", query)
        if formatted.startswith("00"):
            formatted = "+" + formatted[2:]
        optional_trunk = re.fullmatch(r"\+([0-9]{1,3})\(0\)([0-9]*)", formatted)
        if optional_trunk:
            prefix, subscriber = optional_trunk.groups()
            region = phonenumbers.region_code_for_country_code(int(prefix))
            metadata = phonenumbers.PhoneMetadata.metadata_for_region(region)
            if metadata and metadata.national_prefix == "0":
                variants.append(prefix + subscriber)
        try:
            parsed = phonenumbers.parse(candidate, None)
            if phonenumbers.is_possible_number(parsed):
                variants.append(
                    phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)[1:]
                )
        except phonenumbers.NumberParseException:
            pass
    # A national trunk zero can be absent from E.164. Keep both variants,
    # including during typeahead; significant stored zeros remain searchable.
    if (
        not international
        and digits.startswith("0")
        and not digits.startswith("00")
        and len(digits) > 1
    ):
        variants.append(digits[1:])
    return tuple(dict.fromkeys(value for value in variants if value))


def directory_contact_match_params(query: str, *, name_only: bool = False) -> dict[str, object]:
    """Literal contact fragments for SQL; name matching keeps its existing tiers."""
    query = query.strip().lower()
    escaped = query.replace("!", "!!").replace("%", "!%").replace("_", "!_")
    variants = () if name_only else _directory_phone_queries(query)
    return {
        "name_search": not query or bool(normalize_directory_name(query)),
        "email_contains": (
            f"%{escaped}%"
            if not name_only and query and not any(char.isspace() for char in query)
            else None
        ),
        # Match the entered digits anywhere so national numbers and partial
        # numbers work without guessing a country or assuming a fixed length.
        "phone_contains": f"%{variants[0]}%" if variants else None,
        "phone_alternates": [f"%{digits}%" for digits in variants[1:]],
    }


def directory_search_rank(
    name: str,
    query: str,
    *,
    email: str | None = None,
    phone_number: str | None = None,
    phone_verified: bool = False,
    name_only: bool = False,
) -> int | None:
    """Rank names first, then email/verified-phone fragments, before pagination."""
    query = query.strip().lower()
    if not query or normalize_directory_name(query):
        rank = directory_name_rank(name, query)
        if rank is not None:
            return rank
    if name_only:
        return None
    if query and not any(char.isspace() for char in query) and query in (email or "").lower():
        return 4
    variants = _directory_phone_queries(query)
    if phone_verified and any(
        digits in re.sub(r"[^0-9]", "", phone_number or "") for digits in variants
    ):
        return 4
    return None


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

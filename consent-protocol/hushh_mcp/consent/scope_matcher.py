"""Find the requestable information a question is about, from labels alone.

Contract C4 (2026-09-28): "One picks, the person confirms." When someone asks
"What is Kushal's favorite restaurant?", the server preselects the closest item
in Kushal's requestable catalog and the person confirms it or taps Change.
Measured on UAT before this: search covered only the loaded page, "restaurant"
matched nothing, and the person was shown 100 of 251 raw rows.

What this is, and what it is not
--------------------------------
This is catalog SEARCH, the same job ``rank_scope_matches`` does for the
developer API, with a small synonym table so everyday words reach the labels
people actually store ("restaurant" reaches Food). It ranks the owner's catalog
METADATA (labels, domains, paths); it never sees a value.

It is not an intent classifier. One (the model) decides that the person wants
to ask someone for something and passes the things in the person's words; the
words the model chose are matched first and verbatim by the caller. This ranker
only resolves the leftovers to catalog rows, every result carries a readable
``why``, and a result that matched nothing is marked ``fallback`` so the caller
presents it as a suggestion to change, never as a confident pick. The person's
tap is the decision. See ``docs/reference/backend-semantic-boundary.md``.

Deterministic and explainable: same catalog and words in, same order out.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from hushh_mcp.consent.scope_labels import human_domain_label, is_record_field_path

_WORD = re.compile(r"[a-z0-9]+")

# Keys the app writes about its own processing, never about the person (the
# Kai portfolio import stores ``parse_fallback`` beside the holdings; measured
# 2026-09-28 as a requestable "Canonical V2 parse fallback"). The requester's
# own export renderer already drops these keys from shared values
# (``INTERNAL_APPROVED_VALUE_KEYS`` in the webapp's one-kyc-client-zk-service),
# so offering them as a scope promised information that could never be shown.
_MACHINE_SEGMENTS = frozenset(
    {
        "__export_metadata",
        "analyze_eligible",
        "analyze_eligible_reason",
        "coverage_metrics",
        "deterministic_projection_hash",
        "diagnostics",
        "enrichment_hash",
        "holdings_dropped_reasons",
        "latest_receipt_updated_at",
        "metadata",
        "optimize_eligible",
        "parse_context",
        "parse_diagnostics",
        "parse_fallback",
        "pending_delete",
        "provenance",
        "quality_gate",
        "quality_report_v2",
        "raw_extract_v2",
        "receipt_count_used",
        "source_metadata",
        "thought_count",
        "timings_ms",
        "token_counts",
        # Record-keeping and sync plumbing the requester read as information
        # in localhost acceptance run 4 (A3): "Schema", "Last updated",
        # "Holdings is editable", "Holdings symbol kind", "Connection count",
        # "Account count", and their siblings in the same live catalog.
        "account_count",
        "connection_count",
        "debate_eligible",
        "identifier_type",
        "imported_at",
        "institution_count",
        "institution_price_as_of",
        "is_editable",
        "is_sec_common_equity_ticker",
        "last_synced_at",
        "last_updated",
        "lots_count",
        "metadata_confidence",
        "needs_relink_count",
        "saved_at",
        "savedat",
        "schema",
        "security_listing_status",
        "source_type",
        "symbol_kind",
        "symbol_quality",
        "symbol_source",
        "symbol_trust_reason",
        "symbol_trust_tier",
    }
)
_MACHINE_SUFFIXES = ("_fallback", "_diagnostics", "_hash", "_synced_at", "_imported_at")

# Words that carry no subject. Person names are removed by the caller.
_STOPWORDS = frozenset(
    {
        "a",
        "about",
        "an",
        "and",
        "any",
        "are",
        "ask",
        "at",
        "can",
        "could",
        "did",
        "do",
        "doe",
        "does",
        "for",
        "from",
        "get",
        "he",
        "her",
        "him",
        "his",
        "how",
        "i",
        "in",
        "is",
        "it",
        "know",
        "like",
        "me",
        "my",
        "of",
        "on",
        "or",
        "please",
        "request",
        "she",
        "tell",
        "that",
        "the",
        "their",
        "them",
        "they",
        "thi",
        "this",
        "to",
        "want",
        "wa",
        "was",
        "what",
        "when",
        "which",
        "who",
        "why",
        "will",
        "with",
        "would",
        "you",
        "your",
    }
)
# Words that match almost anything. A direct hit on one is weak evidence.
_WEAK_WORDS = frozenset(
    {
        "detail",
        "favorite",
        "favourite",
        "goal",
        "history",
        "info",
        "information",
        "preference",
        "profile",
        "summary",
    }
)

# A weak query word also counts when the row says the same thing in its own
# vocabulary: "favorite restaurant" is a food PREFERENCE, so the preferences
# branch outranks a sibling ("Dietary constraints") that only shares the domain.
_WEAK_EQUIVALENTS: dict[str, frozenset[str]] = {
    "favorite": frozenset({"preference"}),
    "favourite": frozenset({"preference"}),
}

_DIRECT_WEIGHT = 3
_WEAK_DIRECT_WEIGHT = 1
_SYNONYM_DOMAIN_WEIGHT = 2
_SYNONYM_TERM_WEIGHT = 1
_SYNONYM_TERM_CAP = 2


def stem(word: str) -> str:
    """A deliberately small English stemmer: plurals, -ing and -ed only."""
    text = str(word or "").lower()
    if len(text) > 4 and text.endswith("ies"):
        return text[:-3] + "y"
    for suffix in ("ing", "ed"):
        if len(text) > len(suffix) + 3 and text.endswith(suffix):
            text = text[: -len(suffix)]
            # running -> runn -> run; but keep "fitness"-style double s.
            if len(text) > 2 and text[-1] == text[-2] and text[-1] not in "sl":
                text = text[:-1]
            return text
    if len(text) > 3 and text.endswith("s") and not text.endswith("ss"):
        return text[:-1]
    return text


def tokens(text: str | None) -> list[str]:
    """Stemmed content words, stopwords removed, order kept, duplicates dropped."""
    seen: list[str] = []
    for raw in _WORD.findall(str(text or "").lower()):
        word = stem(raw)
        if len(word) > 1 and word not in _STOPWORDS and word not in seen:
            seen.append(word)
    return seen


@dataclass(frozen=True)
class SynonymGroup:
    """Everyday words (``triggers``) that point at a catalog subject.

    ``domains`` are the domain keys the subject lives under. ``related`` are
    catalog words that make a row a better fit once a trigger fired (for
    "training": goals), but that never trigger the group themselves.
    """

    domains: frozenset[str]
    triggers: frozenset[str]
    related: frozenset[str] = frozenset()
    # Domains this subject is more specific than. When a question triggers
    # this group, a row in one of them that matched only by synonym is not
    # evidence: a tax question that also says "income" is still about taxes.
    outranks: frozenset[str] = frozenset()


def _group(
    domains: Iterable[str], triggers: str, related: str = "", outranks: Iterable[str] = ()
) -> SynonymGroup:
    return SynonymGroup(
        domains=frozenset(domains),
        triggers=frozenset(stem(word) for word in triggers.split()),
        related=frozenset(stem(word) for word in related.split()),
        outranks=frozenset(outranks),
    )


# Kept small and in code on purpose: every entry is reviewable in a diff, and a
# table nobody can read is a classifier by another name.
SYNONYM_GROUPS: tuple[SynonymGroup, ...] = (
    _group(
        {"food"},
        "food dining dine restaurant restaurants dinner lunch breakfast brunch cuisine "
        "cuisines eat eating meal meals dish dishes diet dietary vegetarian vegan cook "
        "cooking recipe recipes snack dessert coffee cafe drink drinks wine takeout "
        "allergy allergies taste",
        "preference favorite",
    ),
    _group(
        {"health", "fitness"},
        "health healthy fitness fit run running runner marathon train training workout "
        "workouts exercise gym sport sports athletic race racing triathlon cycling bike "
        "swim swimming yoga sleep weight medical doctor medication wellness",
        "goal goals activity activities",
    ),
    _group(
        {"travel"},
        "travel trip trips flight flights fly flying hotel hotels vacation vacations "
        "holiday holidays airline airlines destination destinations abroad airport",
        "preference favorite loyalty",
    ),
    _group(
        {"entertainment"},
        "entertainment movie movies film films cinema music song songs band bands artist "
        "show shows series tv television book books novel reading game games gaming "
        "podcast podcasts concert concerts genre watch listen",
        "favorite preference",
    ),
    _group(
        {"shopping"},
        "shopping shop buy buying brand brands store stores clothes clothing fashion size "
        "sizes purchase purchases gift gifts wishlist",
        "favorite preference",
    ),
    _group(
        {"professional"},
        "professional job jobs work working career company employer employment title "
        "role skill skills resume office colleague occupation profession industry",
        "experience",
    ),
    # Before "financial": the loop takes the first group a word triggers, and
    # a tax question must reach the tax record, never Portfolio (run 4, R3:
    # "adjusted gross income" proposed Portfolio; "tax", "tax return" and
    # "refund" found nothing).
    _group(
        {"tax_record", "tax_records", "tax", "taxes", "tax_return", "tax_returns"},
        "tax taxes irs refund refunds filing filings file return returns agi adjusted gross "
        "deduction deductions withholding w2 w9 1040 1099 cpa",
        "record federal state",
        outranks={"financial"},
    ),
    _group(
        {"financial"},
        "financial finance finances money invest investing investment investments stock "
        "stocks portfolio income budget bank saving savings spend spending retirement",
        "risk goal",
    ),
    _group(
        {"location"},
        "location live lives living home address city neighborhood hometown located",
        "place",
    ),
    _group(
        {"social"},
        "social friend friends family partner spouse wife husband kid kids child "
        "children birthday anniversary relationship pet pets dog cat",
        "",
    ),
    _group(
        {"identity"},
        "identity name age born birthday email phone contact nationality gender pronoun",
        "",
    ),
    _group(
        {"subscriptions"},
        "subscription subscriptions subscribe membership memberships streaming",
        "plan",
    ),
)


@dataclass(frozen=True)
class ScopeMatch:
    """One ranked catalog row and the words that put it there."""

    entry: Mapping[str, Any]
    score: int
    matched_terms: tuple[str, ...]
    via: str  # "label" | "synonym" | "fallback"

    @property
    def why(self) -> str:
        if self.via == "fallback":
            return "Closest available match"
        term = self.matched_terms[0] if self.matched_terms else ""
        if self.via == "label":
            return f'Matches "{term}"'
        subject = human_domain_label(str(self.entry.get("domain") or "")).lower()
        return f'"{term}" relates to {subject}'


def _entry_path_text(entry: Mapping[str, Any]) -> str:
    segments = entry.get("pathSegments")
    if isinstance(segments, Sequence) and not isinstance(segments, str):
        return " ".join(str(part) for part in segments)
    path = str(entry.get("path") or "")
    if not path:
        scope = str(entry.get("scope") or "")
        path = ".".join(scope.split(".")[2:]) if scope.startswith("attr.") else ""
    return path.replace(".", " ").replace("_", " ")


def _entry_tokens(entry: Mapping[str, Any]) -> tuple[set[str], set[str]]:
    """(strong, weak) token sets: label words are strong, path/description weak."""
    domain = str(entry.get("domain") or "")
    strong = set(tokens(str(entry.get("label") or "")))
    strong.update(tokens(domain.replace("_", " ")))
    weak = set(tokens(_entry_path_text(entry)))
    weak.update(tokens(str(entry.get("description") or "")))
    return strong, weak


def _is_narrow(entry: Mapping[str, Any]) -> bool:
    """False only for a whole-domain row: no path below the domain, and a wildcard."""
    if tokens(_entry_path_text(entry)):
        return True
    return entry.get("wildcard") is not True


def _score_entry(
    entry: Mapping[str, Any], query_tokens: Sequence[str], *, use_synonyms: bool
) -> ScopeMatch | None:
    strong, weak = _entry_tokens(entry)
    domain = str(entry.get("domain") or "").strip().lower()
    domain_words = set(tokens(domain.replace("_", " ")))
    score = 0
    direct_terms: list[str] = []
    synonym_terms: list[str] = []
    for word in query_tokens:
        said = {word, *_WEAK_EQUIVALENTS.get(word, ())}
        if said & (strong | weak):
            weight = _WEAK_DIRECT_WEIGHT if word in _WEAK_WORDS else _DIRECT_WEIGHT
            if not said & strong:
                weight = max(1, weight - 1)
            score += weight
            direct_terms.append(word)
            continue
        if not use_synonyms:
            continue
        for group in SYNONYM_GROUPS:
            if word not in group.triggers:
                continue
            gained = 0
            in_domain = domain in group.domains
            if in_domain:
                gained += _SYNONYM_DOMAIN_WEIGHT
            # The domain word is already credited above; count only what the
            # row itself is called. Related words count only inside the
            # group's own domain, so "favorite" cannot pull food toward movies.
            row_words = (strong | weak) - domain_words
            overlap = row_words & group.triggers
            if in_domain:
                overlap |= row_words & group.related
            gained += min(len(overlap), _SYNONYM_TERM_CAP) * _SYNONYM_TERM_WEIGHT
            if gained:
                score += gained
                synonym_terms.append(word)
                break
    strong_direct = [term for term in direct_terms if term not in _WEAK_WORDS]
    if strong_direct:
        return ScopeMatch(entry, score, tuple(strong_direct), "label")
    if synonym_terms:
        return ScopeMatch(entry, score, tuple(synonym_terms), "synonym")
    # Only weak words ("favorite", "information") matched: that ranks, but it
    # is not evidence the row is what was asked about.
    return None


def _sort_key(match: ScopeMatch) -> tuple[int, int, int, str, str]:
    entry = match.entry
    label = str(entry.get("label") or "")
    return (
        -match.score,
        # Least privilege on a tie: a named branch before a whole domain.
        0 if _is_narrow(entry) else 1,
        len(label),
        label.lower(),
        str(entry.get("scopeRef") or entry.get("scope") or ""),
    )


def match_scopes(
    entries: Iterable[Mapping[str, Any]],
    query: str,
    *,
    limit: int | None = 5,
    use_synonyms: bool = True,
    ignore_words: Iterable[str] = (),
    context: str = "",
) -> list[ScopeMatch]:
    """Rank catalog rows for ``query``. Empty when nothing genuinely matches.

    ``ignore_words`` drops words that name the person being asked about, so
    "Kushal Trivedi's favorite restaurant" is not matched on "kushal".
    ``context`` (the person's whole question) only decides which subject is
    more specific: "income" asked inside a tax question never reaches a
    financial row by synonym. It never adds a match of its own.
    """
    ignored = {stem(word) for raw in ignore_words for word in _WORD.findall(str(raw).lower())}
    query_tokens = [word for word in tokens(query) if word not in ignored]
    if not query_tokens:
        return []
    # Explain in the person's own words ("training"), not the stem ("train").
    surface: dict[str, str] = {}
    for raw in _WORD.findall(str(query or "").lower()):
        surface.setdefault(stem(raw), raw)
    said = {*query_tokens, *(word for word in tokens(context) if word not in ignored)}
    outranked = (
        {
            domain
            for group in SYNONYM_GROUPS
            if group.triggers.intersection(said)
            for domain in group.outranks
        }
        if use_synonyms
        else set()
    )
    matches = []
    for entry in entries:
        match = _score_entry(entry, query_tokens, use_synonyms=use_synonyms)
        if match is None:
            continue
        if match.via == "synonym" and str(entry.get("domain") or "").lower() in outranked:
            continue
        spoken = tuple(surface.get(term, term) for term in match.matched_terms)
        matches.append(ScopeMatch(match.entry, match.score, spoken, match.via))
    matches.sort(key=_sort_key)
    return matches if limit is None else matches[: max(0, limit)]


def fallback_scopes(entries: Iterable[Mapping[str, Any]], *, limit: int = 3) -> list[ScopeMatch]:
    """One representative row per domain, largest domains first.

    Used when a question matched nothing: the owner's richest subjects are the
    most likely useful suggestion. The representative is the whole-domain row
    when the owner offers one, otherwise the shortest label in that domain.
    """
    by_domain: dict[str, list[Mapping[str, Any]]] = {}
    for entry in entries:
        by_domain.setdefault(str(entry.get("domain") or "").strip().lower(), []).append(entry)
    counts = Counter({domain: len(rows) for domain, rows in by_domain.items()})
    ranked_domains = sorted(counts, key=lambda domain: (-counts[domain], domain))
    picks: list[ScopeMatch] = []
    for domain in ranked_domains[: max(0, limit)]:
        rows = by_domain[domain]
        broad = [row for row in rows if not _is_narrow(row)]
        pool = broad or rows
        representative = min(
            pool,
            key=lambda row: (
                len(str(row.get("label") or "")),
                str(row.get("label") or "").lower(),
                str(row.get("scopeRef") or row.get("scope") or ""),
            ),
        )
        picks.append(ScopeMatch(representative, 0, (), "fallback"))
    return picks


def search_scope_entries(
    entries: Sequence[Mapping[str, Any]],
    query: str,
    *,
    use_synonyms: bool = True,
) -> list[dict[str, Any]]:
    """Catalog search for a picker: matching rows ranked, each with a ``why``.

    An empty query lists everything, grouped by domain and then by label, so
    paging an unfiltered catalog is stable.
    """
    if not tokens(query):
        return sorted(
            (dict(entry) for entry in entries),
            key=lambda row: (
                str(row.get("domain") or "").lower(),
                0 if _is_narrow(row) else 1,
                str(row.get("label") or "").lower(),
                str(row.get("scopeRef") or row.get("scope") or ""),
            ),
        )
    return [
        {**dict(match.entry), "why": match.why}
        for match in match_scopes(entries, query, limit=None, use_synonyms=use_synonyms)
    ]


def _entry_segments(entry: Mapping[str, Any]) -> list[str]:
    """Path segments below the domain, from any catalog row shape (raw or projected)."""
    segments = entry.get("pathSegments")
    if isinstance(segments, Sequence) and not isinstance(segments, str):
        raw = [str(part) for part in segments]
    else:
        path = str(entry.get("path") or "")
        if not path:
            scope = str(entry.get("scope") or "")
            path = ".".join(scope.split(".")[2:]) if scope.startswith("attr.") else ""
        raw = path.split(".")
    return [part.strip() for part in raw if part.strip() and part.strip() != "*"]


def is_record_field_entry(entry: Mapping[str, Any]) -> bool:
    """A row that selects one schema field (kind, status...) of every record in a set."""
    return is_record_field_path(".".join(_entry_segments(entry)))


def is_machine_entry(entry: Mapping[str, Any]) -> bool:
    """A row about the app's own processing (``parse_fallback``), never about the person."""
    for segment in _entry_segments(entry):
        key = segment.lower()
        if key in _MACHINE_SEGMENTS or key.endswith(_MACHINE_SUFFIXES):
            return True
    return False


def is_proposable_entry(entry: Mapping[str, Any]) -> bool:
    """Whether One may preselect this row. Schema fields and app state never are."""
    return not is_record_field_entry(entry) and not is_machine_entry(entry)


def _branch_key(entry: Mapping[str, Any]) -> tuple[str, tuple[str, ...]]:
    return (
        str(entry.get("domain") or "").strip().lower(),
        tuple(part.lower() for part in _entry_segments(entry)),
    )


def _is_covered(
    entry: Mapping[str, Any], wildcard_branches: set[tuple[str, tuple[str, ...]]]
) -> bool:
    """A branch wildcard above ``entry`` (``food.preferences.*``) is offered."""
    domain, segments = _branch_key(entry)
    # Depth 1 and below only: a whole-domain row ("Food & dining information")
    # is broader than the branch a person means, so it never hides one.
    return any((domain, segments[:depth]) in wildcard_branches for depth in range(1, len(segments)))


def _keep_rank(entry: Mapping[str, Any]) -> tuple[int, int, int, int, str]:
    """Which of several rows with one human label stays: the category row.

    Then a real attribute, then a record's summary (its readable content)
    before its observations.
    """
    segments = [part.lower() for part in _entry_segments(entry)]
    return (
        0 if entry.get("wildcard") is True else 1,
        1 if is_record_field_entry(entry) else 0,
        0 if segments[-1:] == ["summary"] else 1,
        len(segments),
        str(entry.get("scope") or entry.get("scopeRef") or ""),
    )


def presentable_scope_entries(entries: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """The catalog a person reads: no app state, no covered schema fields, one row per label.

    Presentation only. Request validation keeps the full requestable catalog
    (``PersonProfileService.resolve_scope_refs``), so a row hidden here is never
    made unrequestable, and nothing here grants or widens access.

    * App-state rows (``parse_fallback``) are dropped.
    * A record's schema field ("Food preferences kind", its status, its
      observations) is dropped when the branch row above it
      (``food.preferences.*``) is offered, which is how the manifest emits every
      top-level branch. An uncovered one stays, so nothing becomes unreachable.
      A whole-domain row never hides a branch: it is broader than asked.
    * Rows that read the same ("Food preferences" twice) collapse to one per
      domain, keeping the category row a person means by that name.
    """
    rows = [dict(entry) for entry in entries]
    wildcard_branches = {_branch_key(row) for row in rows if row.get("wildcard") is True}
    visible = [
        row
        for row in rows
        if not is_machine_entry(row)
        and not (is_record_field_entry(row) and _is_covered(row, wildcard_branches))
    ]
    best: dict[tuple[str, str], dict[str, Any]] = {}
    for row in visible:
        key = (
            str(row.get("domain") or "").strip().lower(),
            " ".join(str(row.get("label") or "").lower().split()),
        )
        if key not in best or _keep_rank(row) < _keep_rank(best[key]):
            best[key] = row
    kept = {id(row) for row in best.values()}
    return [row for row in visible if id(row) in kept]


__all__ = [
    "SYNONYM_GROUPS",
    "ScopeMatch",
    "SynonymGroup",
    "fallback_scopes",
    "is_machine_entry",
    "is_proposable_entry",
    "is_record_field_entry",
    "match_scopes",
    "presentable_scope_entries",
    "search_scope_entries",
    "stem",
    "tokens",
]

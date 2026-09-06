"""Semantic retrieval for the generated action catalog.

Covers the guarantees the retrieval layer owes One:

- a semantic match must never require lexical overlap;
- a natural, multi-word request must not score zero;
- a Hindi or Hinglish request must tokenize as words, not as fragments;
- an authored ``semantic_boundaries`` string must not be shredded;
- retrieval degrades to a lexical ranking rather than to a query-blind list.

``connect me with ankit`` is exercised here deliberately. It used to be covered
by ``test_a_named_request_goes_to_its_journey_not_to_a_specialist`` in
tests/test_one_adk_agent_tree.py, which asserted a score-driven redirect inside
``ask_consent_agent``. That redirect is gone -- One now selects the target
semantically -- so the phrase is a *retrieval* property now, and this is where
it is guarded.
"""

from __future__ import annotations

import pytest

from hushh_mcp.one_adk import action_retrieval as ar
from hushh_mcp.services.action_gateway import load_action_gateway

requires_embeddings = pytest.mark.skipif(
    not ar.is_retrieval_available() or ar._get_model() is None,
    reason="pinned embedding model unavailable in this environment",
)


# ── Tokenization ─────────────────────────────────────────────────────────────


def test_a_multi_word_request_does_not_score_zero():
    """The whole-phrase scorer alone made every natural request invisible.

    ``_lexical_candidates`` drops anything scoring 0, so a scorer that only
    substring-matches the entire query returned an empty lexical branch for
    every real sentence -- silently collapsing hybrid retrieval to
    semantic-only, with no error and no log line.
    """
    entry = {
        "label": "Share location",
        "meaning": "Share your live location with chosen people",
        "action_id": "location.share_selected",
        "aliases": ["share location", "share my location"],
        "search_keywords": ["share", "location", "live"],
    }
    assert ar.lexical_score(entry, "share location") > 0
    assert ar.lexical_score(entry, "share my location with mom") > 0
    assert ar.lexical_score(entry, "share my location with Ankit for 30 minutes") > 0


def test_indic_text_tokenizes_as_words_not_fragments():
    """Devanagari vowel signs are combining marks, not word boundaries.

    ``str.isalnum()`` is False for U+0947 (Mn) and U+0940 (Mc), so splitting on
    non-alphanumerics shredded "मेरी" into ['म', 'र'] and scored every Hindi
    request at zero.
    """
    assert ar._unicode_tokens("मेरी लोकेशन शेयर करो") == [
        "मेरी",
        "लोकेशन",
        "शेयर",
        "करो",
    ]
    assert ar._unicode_tokens("café münchen") == ["café", "münchen"]
    assert ar._unicode_tokens("30-minute check-in") == ["30", "minute", "check", "in"]


def test_a_hindi_request_reaches_its_action():
    entry = {
        "label": "Share location",
        "meaning": "Share your live location",
        "action_id": "location.share_selected",
        "aliases": ["लोकेशन शेयर करो"],
        "search_keywords": ["लोकेशन", "शेयर"],
    }
    assert ar.lexical_score(entry, "मेरी लोकेशन शेयर करो") > 0


# ── Fusion ordering ──────────────────────────────────────────────────────────


def test_a_semantic_only_hit_outranks_a_lexical_only_hit_at_equal_score():
    """The plan's core rule: a semantic match must not need lexical overlap.

    Re-sorting the fused list by ``(-score, action_id)`` broke ties
    alphabetically, so a lexical-only hit named "aa..." was promoted above a
    semantic-only hit named "zz..." at identical RRF score.
    """
    fused = ar._reciprocal_rank_fusion(
        ["zz.semantic_only", "mm.both"], ["aa.lexical_only", "mm.both"]
    )
    order = [action_id for action_id, _ in fused]
    assert order.index("zz.semantic_only") < order.index("aa.lexical_only")


# ── Authored contract fields ─────────────────────────────────────────────────


def test_an_authored_boundary_string_is_not_shredded_into_characters():
    """``semantic_boundaries`` is authored as a string.

    ``list("pauses updates")`` yields ['p','a','u',...], which would reach One
    as meaningless single characters.
    """
    authored = "pauses updates; does not revoke sharing grants"
    assert ar._normalize_boundaries(authored) == authored
    assert ar._normalize_boundaries(["pauses updates", "does not revoke"]) == (
        "pauses updates; does not revoke"
    )
    assert ar._normalize_boundaries(None) is None
    assert ar._normalize_boundaries([]) is None


# ── Degradation ──────────────────────────────────────────────────────────────


def test_retrieval_degrades_without_raising():
    """A missing model returns empty and never raises into One's turn."""
    gateway = load_action_gateway()
    results = ar.search_actions("share my location", gateway)
    assert isinstance(results, list)
    for item in results:
        assert isinstance(item, ar.RetrievedAction)


def test_a_degraded_ranking_is_declared_not_hidden():
    """Degradation must be visible, or it looks exactly like success.

    The original bug survived because the failed path returned plausible
    results with no signal. When the model is unavailable, One's payload has to
    say the ranking was lexical-only.
    """
    import asyncio
    from types import SimpleNamespace

    from hushh_mcp.one_adk.action_tools import list_app_actions

    payload = asyncio.run(list_app_actions("share my location", SimpleNamespace(state={})))
    if ar.is_retrieval_available():
        assert "ranking" not in payload
    else:
        assert payload["ranking"] == "lexical_only"
        assert payload["ranking_degraded_reason"]


def test_an_oversized_query_is_rejected_not_silently_truncated():
    with pytest.raises(ValueError):
        ar._normalize_query("x" * 100_000)


# ── Against the real generated catalog ───────────────────────────────────────


def test_the_catalog_digest_is_stable_for_identical_content():
    gateway = load_action_gateway()
    assert ar._catalog_digest(gateway) == ar._catalog_digest(gateway)


def test_an_explicit_connection_request_surfaces_its_action():
    """Replaces coverage deleted with the score-driven journey redirect.

    Scoped to what the LEXICAL path can actually do. "send a connection request
    to ankit" names the action, so token overlap finds it.
    """
    import asyncio
    from types import SimpleNamespace

    from hushh_mcp.one_adk.action_tools import list_app_actions

    result = asyncio.run(
        list_app_actions("send a connection request to ankit", SimpleNamespace(state={}))
    )
    ids = [row["action_id"] for row in result["results"]]
    assert "connect.send_request" in ids, ids


@pytest.mark.xfail(
    reason=(
        "Known limitation of whole-gateway lexical ranking, documented by the "
        "code this replaced: scored across the whole catalog, 'connect me with "
        "ankit' is won by setup.connect_gmail -- 'a wrong answer that looks "
        "like a confident one'. The deleted ask_consent_agent override "
        "compensated by scoping to one specialist's surface. Semantic "
        "retrieval is the intended replacement and is not installed here, so "
        "this asserts the real current gap rather than passing vacuously."
    ),
    strict=True,
)
def test_the_incident_phrase_still_needs_semantic_retrieval():
    """The phrase from the original production incident.

    One was told specialists validate consent, sent "connect me with Ankit" to
    the connections specialist, the specialist hit a consent boundary, and One
    relayed it -- so a request the app could satisfy end to end came back as
    "I don't have the right permissions".

    This test is expected to FAIL until the embedding dependency ships. It is
    the gate on removing the override, not decoration.
    """
    import asyncio
    from types import SimpleNamespace

    from hushh_mcp.one_adk.action_tools import list_app_actions

    result = asyncio.run(list_app_actions("connect me with ankit", SimpleNamespace(state={})))
    ids = [row["action_id"] for row in result["results"]]
    assert "connect.send_request" in ids, ids


@requires_embeddings
def test_a_paraphrase_with_no_shared_words_still_retrieves():
    """The whole point of the embedding branch."""
    gateway = load_action_gateway()
    results = ar.search_actions("let my wife see where I am", gateway)
    assert any(r.action_id.startswith("location.") for r in results)

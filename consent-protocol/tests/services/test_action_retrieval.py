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


@pytest.fixture(autouse=True)
def unavailable_embedding(monkeypatch):
    """Routine retrieval contracts are independent of network/model installation."""
    from unittest.mock import Mock

    client = Mock()
    client.embed_query.side_effect = RuntimeError("embedding unavailable")
    monkeypatch.setattr(ar, "get_embedding_client", lambda: client)
    monkeypatch.setattr(ar, "_retrieval_available", True)
    monkeypatch.setattr(ar, "_retrieval_error", None)


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


def test_retrieval_degrades_without_raising(monkeypatch, caplog):
    """An unavailable embedding preserves lexical results without private diagnostics."""
    from unittest.mock import Mock

    client = Mock()
    client.embed_query.side_effect = RuntimeError("private-query-diagnostic-sentinel")
    monkeypatch.setattr(ar, "get_embedding_client", lambda: client)
    monkeypatch.setattr(ar, "_retrieval_available", True)
    monkeypatch.setattr(ar, "_retrieval_error", None)
    gateway = load_action_gateway()
    results = ar.search_actions("share my location", gateway)
    assert results
    for item in results:
        assert isinstance(item, ar.RetrievedAction)
    assert ar.is_retrieval_available() is False
    assert ar.retrieval_error() == "embedding_unavailable"
    assert "private-query-diagnostic-sentinel" not in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


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
    assert ar.is_retrieval_available() is False
    assert payload["ranking"] == "lexical_only"
    assert payload["ranking_degraded_reason"] == "embedding_unavailable"


def test_an_oversized_query_is_rejected_not_silently_truncated():
    with pytest.raises(ValueError):
        ar._normalize_query("x" * 100_000)


# ── Against the real generated catalog ───────────────────────────────────────


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


# ── Result-window integrity ──────────────────────────────────────────────────


def test_the_reachability_filter_does_not_shrink_the_result_window():
    """Filtering after truncation silently starved One of capabilities.

    ``search_actions`` truncates to its limit, and reachability is only known
    afterwards, in ``list_app_actions``. Requesting exactly the window size
    meant a screen where most hits are off-screen returned two or three
    actions instead of ten -- with no error and no log line.
    """
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import patch

    from hushh_mcp.one_adk import action_tools as at
    from hushh_mcp.services.action_gateway import list_action_gateway_actions

    declared = ["location.share_selected", "location.open_ask"]
    wired = [
        entry
        for entry in list_action_gateway_actions()
        if (entry.get("execution_target") or {}).get("status") == "wired"
    ]
    reachable, unreachable = [], []
    for entry in wired:
        action_id = str(entry.get("action_id"))
        availability, _ = at._reachability(entry, action_id, set(declared))
        target = unreachable if availability == "unreachable_from_here" else reachable
        target.append(action_id)

    if len(unreachable) < 8 or len(reachable) < 12:
        pytest.skip("catalog does not have enough of both kinds to exercise this")

    # Unreachable hits first, so a truncate-then-filter order starves the window.
    order = unreachable[:8] + [a for a in reachable if a not in declared][:22]
    hits = [
        ar.RetrievedAction(
            action_id=action_id,
            score=1.0,
            source="semantic",
            meaning="m",
            semantic_boundaries=None,
            required_inputs={},
            policy="allow_direct",
            availability="on_screen",
            navigation=None,
            goal=None,
        )
        for action_id in order
    ]

    context = SimpleNamespace(
        state={
            at._STATE_VOICE_CONTEXT: {
                "screen": "one_location",
                "available_action_ids": declared,
            }
        }
    )
    with patch.object(at, "search_actions", return_value=hits) as retrieval:
        result = asyncio.run(at.list_app_actions("share my location", context))

    assert retrieval.call_args.kwargs["limit"] > at._MAX_LIST_RESULTS
    assert len(result["results"]) == at._MAX_LIST_RESULTS

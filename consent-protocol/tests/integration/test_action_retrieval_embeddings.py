"""Pinned-model semantic integration; run against an explicitly prepared cache.

Re-run after model, embedding dependency, retrieval, or generated catalog changes.
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 uv run pytest <this file> -q
No model is loaded during collection, and missing model artifacts fail this gate.
"""

import pytest

from hushh_mcp.one_adk import action_retrieval as ar
from hushh_mcp.services.action_gateway import load_action_gateway


@pytest.fixture(scope="module")
def embedding_model():
    return ar.get_embedding_client()._load()


def test_the_incident_phrase_resolves_through_semantic_retrieval(embedding_model):
    """The phrase from the original production incident.

    One was told specialists validate consent, sent "connect me with Ankit" to
    the connections specialist, the specialist hit a consent boundary, and One
    relayed it -- so a request the app could satisfy end to end came back as
    "I don't have the right permissions".

    Lexical ranking alone cannot resolve this: scored across the whole catalog
    the phrase is won by setup.connect_gmail, "a wrong answer that looks like a
    confident one". Embedding retrieval does resolve it, which is why this is
    an integration check: the degraded path is not expected to pass.

    This integration gate requires the pinned model in the prepared cache.
    Model absence fails; lexical fallback does not establish semantic quality.
    """
    import asyncio
    from types import SimpleNamespace

    from hushh_mcp.one_adk.action_tools import list_app_actions

    result = asyncio.run(list_app_actions("connect me with ankit", SimpleNamespace(state={})))
    ids = [row["action_id"] for row in result["results"]]
    assert "connect.send_request" in ids, ids


def test_a_paraphrase_with_no_shared_words_still_retrieves(embedding_model):
    """The whole point of the embedding branch."""
    gateway = load_action_gateway()
    results = ar.search_actions("let my wife see where I am", gateway)
    assert any(r.action_id.startswith("location.") for r in results)

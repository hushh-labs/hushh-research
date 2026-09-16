"""Regression coverage for Location Brain semantic retrieval.

These tests deliberately avoid a live embedding call.  They prove the command
runtime's retrieval contract: safe brain cards are the only index documents,
legacy aliases cannot influence a result, and a held-out natural-language
phrase reaches the semantic index unchanged.
"""

from __future__ import annotations

import re
from copy import deepcopy

import pytest

from hushh_mcp.services import app_intelligence_runtime as runtime


def _unit_vector(index: int) -> list[float]:
    values = [0.0] * runtime.LOCATION_BRAIN_EMBEDDING_DIMENSIONS
    values[index] = 1.0
    return values


def _legacy_alias_tokens(graph: dict[str, object]) -> set[str]:
    tokens: set[str] = set()
    for group in ("actions", "workflows"):
        values = graph.get(group)
        if not isinstance(values, list):
            continue
        for item in values:
            if not isinstance(item, dict):
                continue
            for alias in item.get("aliases") or []:
                tokens.update(re.findall(r"[a-z0-9]+", str(alias).casefold()))
    return tokens


def test_location_semantic_retrieval_ignores_legacy_aliases_and_routes_held_out_phrase(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A zero-alias-overlap phrase still routes through brain-card embeddings."""

    graph = deepcopy(runtime.load_capability_graph())
    assert isinstance(graph, dict)
    workflow = next(
        item
        for item in graph["workflows"]
        if isinstance(item, dict) and item.get("capability_id") == "workflow.setup.location"
    )
    # If legacy aliases were accidentally admitted into the semantic index,
    # this sentinel would appear in the document text captured below.
    workflow["aliases"] = ["obsolete-alias-sentinel"]
    workflow["search_keywords"] = ["obsolete-alias-sentinel"]

    catalog = runtime._location_brain_catalog_from_graph(graph)
    cards = runtime._location_brain_index_cards(catalog)
    target_index = next(
        index
        for index, card in enumerate(cards)
        if card.get("candidate_id") == "workflow.setup.location"
    )
    documents: list[str] = []
    held_out_phrase = "enable geographic awareness"
    assert not (set(re.findall(r"[a-z0-9]+", held_out_phrase)) & _legacy_alias_tokens(graph))

    def fake_embed(
        texts: list[str],
        *,
        task_type: str,
        timeout_ms: int,
    ) -> list[list[float]]:
        del timeout_ms
        if task_type == "RETRIEVAL_DOCUMENT":
            documents.extend(texts)
            return [_unit_vector(index) for index, _text in enumerate(texts)]
        assert task_type == "RETRIEVAL_QUERY"
        assert texts == [held_out_phrase]
        return [_unit_vector(target_index)]

    monkeypatch.setattr(runtime, "_embed_location_brain_texts", fake_embed)
    with runtime._LOCATION_BRAIN_SEMANTIC_CACHE_LOCK:
        previous_cache = dict(runtime._LOCATION_BRAIN_SEMANTIC_CACHE)
        runtime._LOCATION_BRAIN_SEMANTIC_CACHE.clear()
        runtime._LOCATION_BRAIN_SEMANTIC_CACHE.update(
            {
                "graph_revision": None,
                "brain_revision": None,
                "candidate_ids": (),
                "vectors": (),
                "embedding_model": None,
                "dimensions": 0,
            }
        )
    try:
        warmed = runtime.prewarm_location_brain_semantic_index(graph=graph)
        snapshot = runtime.build_location_brain_snapshot(graph=graph)
        result = runtime.retrieve_location_brain_candidates(
            query=held_out_phrase,
            snapshot=snapshot,
            graph=graph,
        )
    finally:
        with runtime._LOCATION_BRAIN_SEMANTIC_CACHE_LOCK:
            runtime._LOCATION_BRAIN_SEMANTIC_CACHE.clear()
            runtime._LOCATION_BRAIN_SEMANTIC_CACHE.update(previous_cache)

    assert warmed["status"] == "ready"
    assert all("obsolete-alias-sentinel" not in document for document in documents)
    assert result["retrieval_status"] == "READY"
    assert "workflow.setup.location" in result["selection_contract"]["allowed_values"]


def test_location_model_catalog_rejects_an_alias_field() -> None:
    """Aliases are compatibility data, never model-facing brain-card data."""

    graph = runtime.load_capability_graph()
    catalog = deepcopy(runtime._location_brain_catalog_from_graph(graph))
    catalog["capability_cards"][0]["aliases"] = ["must-not-reach-model"]

    with pytest.raises(runtime.CapabilityGraphArtifactError):
        runtime._validate_location_brain_catalog(catalog)


def test_service_brain_facade_never_uses_legacy_lexical_retrieval(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The generic facade remains future-ready without borrowing old routing."""

    graph = runtime.load_capability_graph()
    snapshot = runtime.build_location_brain_snapshot(graph=graph)
    expected = {
        "schema_version": runtime.LOCATION_TURN_PROJECTION_SCHEMA_VERSION,
        "graph_revision": graph["revision"],
        "brain_revision": snapshot["brain_revision"],
        "context_revision": snapshot["context_revision"],
        "candidates": [],
        "selection_contract": {"field": "candidate_id_or_ASK", "allowed_values": ["ASK"]},
        "retrieval_status": "ASK",
        "reason_code": "semantic_index_unavailable",
    }

    def unexpected_legacy_retrieval(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("legacy lexical retrieval must not service a command turn")

    monkeypatch.setattr(runtime, "retrieve_capability_candidates", unexpected_legacy_retrieval)
    monkeypatch.setattr(
        runtime,
        "retrieve_location_brain_candidates",
        lambda **_kwargs: expected,
    )

    result = runtime.retrieve_service_brain_candidates(
        query="enable geographic awareness",
        snapshot=snapshot,
        graph=graph,
    )

    assert result["retrieval_status"] == "ASK"
    assert result["service_brain_registry"]["service_ids"] == ["location"]

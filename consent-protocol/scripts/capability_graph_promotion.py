# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Replay committed graph provenance when promotion changes no target semantics."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any

Graph = dict[str, Any]


def retained_comparison(
    graph: Graph,
    candidate: Graph,
    predecessors: Iterable[Graph],
    *,
    compare: Callable[[Graph, Graph], Graph],
    semantic_index: Callable[[Graph], dict[str, str]],
    require_acknowledged: Callable[[Graph], None],
) -> Graph | None:
    """Return only a complete, freshly replayed historical transition.

    The caller must first admit the actual target comparison and prove its
    semantic index is unchanged. Candidate and predecessor inputs are committed
    ancestor objects read through the existing bounded history reader.
    """

    recorded = candidate.get("semantic_diff")
    if (
        candidate.get("revision") != graph.get("revision")
        or semantic_index(candidate) != semantic_index(graph)
        or not isinstance(recorded, dict)
        or recorded == graph.get("semantic_diff")
        or not any(recorded.get(field) for field in ("added", "removed", "changed"))
    ):
        return None
    revision = recorded.get("from_revision")
    if not isinstance(revision, str) or not revision or revision == graph.get("revision"):
        raise RuntimeError("Graph promotion has invalid recorded predecessor provenance.")
    matching = [item for item in predecessors if item.get("revision") == revision]
    if not matching:
        raise RuntimeError("Graph promotion has no qualified recorded predecessor.")
    indexes = [semantic_index(item) for item in matching]
    if any(index != indexes[0] for index in indexes[1:]):
        raise RuntimeError("Graph promotion has ambiguous recorded predecessor semantics.")
    replayed = compare(matching[0], graph)
    require_acknowledged(replayed)
    if replayed != recorded:
        raise RuntimeError("Graph promotion recorded transition does not match fresh replay.")
    return dict(replayed)

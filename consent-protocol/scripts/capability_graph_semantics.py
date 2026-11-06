# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Pure semantic fingerprints shared by graph admission and provenance replay."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def semantic_index(graph: dict[str, Any]) -> dict[str, str]:
    """Hash semantic nodes, excluding generated revision/diff metadata."""
    nodes: dict[str, Any] = {}
    for collection in (
        "actions",
        "workflows",
        "services",
        "screens",
        "entities",
        "render_surfaces",
    ):
        for node in graph.get(collection) or []:
            if not isinstance(node, dict):
                continue
            node_id = str(node.get("capability_id") or node.get("service_id") or "").strip()
            if node_id:
                nodes[f"{collection}:{node_id}"] = node
    # Model-facing service brains are semantic artifacts in their own right.
    # They have no executable authority, so a change is non-breaking here,
    # but excluding them would hide a package wording/policy revision from the
    # generated semantic diff and make review of future model context harder.
    projections = graph.get("model_projections")
    if isinstance(projections, dict):
        for service_id, projection in sorted(projections.items()):
            if isinstance(projection, dict) and str(service_id or "").strip():
                nodes[f"brains:{service_id}"] = projection
    return {
        node_id: hashlib.sha256(
            json.dumps(node, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
        ).hexdigest()
        for node_id, node in sorted(nodes.items())
    }

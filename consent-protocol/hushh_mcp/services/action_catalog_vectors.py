"""Import-safe action-catalog passage helpers and the image-baked vector file.

The generated action catalog is static per image, so its passage vectors are
computed once at image build (``scripts/ops/bake_action_catalog_vectors.py``)
and read back at runtime by ``hushh_mcp.one_adk.action_retrieval``. Embedding
the catalog at startup cost about 70s per Cloud Run instance, per gunicorn
worker, and a first chat turn waited 13-50s behind it (2026-09-27).

This module must stay importable with no secrets or runtime configuration: the
image build has none. ``action_retrieval`` lives in a package whose import
builds the agent tree and requires ``APP_SIGNING_KEY``, so the passage, digest
and wired-filter functions live here and ``action_retrieval`` re-exports them.
Both the bake and the runtime therefore run the same function objects.

Every read is fail-safe: a missing, unreadable, or mismatched file returns
``None`` and the caller embeds live, exactly as before.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
from typing import Any

from hushh_mcp.services.embedding_client_leaf import BAKED_MODEL_DIR, MODEL_ID, MODEL_REVISION

logger = logging.getLogger(__name__)

FORMAT_VERSION = 1
BAKED_VECTORS_PATH = Path(BAKED_MODEL_DIR).parent / "action-catalog-vectors.npz"

# Loaded files keyed by (path, catalog digest). Negative results are kept too,
# so a missing or mismatched file is examined once per process, not per turn.
_LOADED: dict[tuple[str, str], dict[str, list[float]] | None] = {}


def is_wired(entry: dict[str, Any]) -> bool:
    """The catalog gate ``search_actions`` applies before any runtime-state filter."""
    return (entry.get("execution_target") or {}).get("status") == "wired"


def build_passage(entry: dict[str, Any]) -> str:
    """Build a searchable description from an action contract entry."""
    parts: list[str] = []
    label = str(entry.get("label") or "").strip()
    meaning = str(entry.get("meaning") or "").strip()
    action_id = str(entry.get("action_id") or "").strip()
    parts.append(label or action_id)
    if meaning:
        parts.append(meaning)
    aliases = entry.get("aliases") or []
    if aliases:
        parts.append("Aliases: " + ", ".join(str(a) for a in aliases))
    # AgentManifestV2 generates `search_keywords`; retain the legacy fallback
    # only for older fixtures. Missing this field silently removes the
    # authored vocabulary from semantic passage construction.
    keywords = entry.get("search_keywords") or entry.get("keywords") or []
    if keywords:
        parts.append("Keywords: " + ", ".join(str(k) for k in keywords))
    goal = entry.get("goal") or {}
    goal_desc = str(goal.get("goal_description") or "").strip()
    if goal_desc:
        parts.append(goal_desc)
    boundaries = entry.get("semantic_boundaries") or ""
    boundaries = str(boundaries).strip()
    if boundaries:
        parts.append("Boundaries: " + boundaries)
    return ". ".join(parts)


def catalog_digest(gateway: dict[str, Any]) -> str:
    """Compute a deterministic digest of the canonical gateway content."""
    raw = json.dumps(
        gateway,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def passage_key(passage: str) -> str:
    """A vector is a pure function of passage text and model, so key by text."""
    return hashlib.sha256(passage.encode("utf-8")).hexdigest()


def write_baked_vectors(
    path: Path,
    *,
    digest: str,
    passages: list[str],
    vectors: list[list[float]],
) -> None:
    """Write the vector file atomically. Raises on any inconsistency."""
    import numpy as np

    if not passages or len(passages) != len(vectors):
        raise ValueError("passage and vector counts differ or are empty")
    matrix = np.asarray(vectors, dtype=np.float32)
    if matrix.ndim != 2 or not np.isfinite(matrix).all():
        raise ValueError("vectors are not a finite two-dimensional matrix")
    keys = [passage_key(p) for p in passages]
    meta = {
        "format_version": FORMAT_VERSION,
        "catalog_digest": digest,
        "model_id": MODEL_ID,
        "model_revision": MODEL_REVISION,
        "count": int(matrix.shape[0]),
        "dim": int(matrix.shape[1]),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp.npz")
    with open(tmp, "wb") as handle:
        np.savez(
            handle,
            vectors=matrix,
            passage_sha256=np.asarray(keys, dtype="<U64"),
            meta=np.asarray(json.dumps(meta, sort_keys=True)),
        )
    os.replace(tmp, path)


def _read(path: Path, digest: str) -> dict[str, list[float]] | None:
    import numpy as np

    if not path.is_file():
        return None
    with np.load(path, allow_pickle=False) as data:
        meta = json.loads(str(data["meta"]))
        vectors = data["vectors"]
        keys = [str(k) for k in data["passage_sha256"]]
    expected = {
        "format_version": FORMAT_VERSION,
        "catalog_digest": digest,
        "model_id": MODEL_ID,
        "model_revision": MODEL_REVISION,
    }
    mismatched = sorted(k for k, v in expected.items() if meta.get(k) != v)
    if mismatched:
        logger.info("action_catalog_vectors.baked_mismatch fields=%s", ",".join(mismatched))
        return None
    if (
        vectors.ndim != 2
        or vectors.shape[0] != len(keys)
        or vectors.shape[0] != meta.get("count")
        or vectors.shape[1] != meta.get("dim")
        or not np.isfinite(vectors).all()
    ):
        logger.warning("action_catalog_vectors.baked_malformed")
        return None
    return dict(zip(keys, vectors.tolist(), strict=True))


def baked_vectors_for(
    passages: list[str], digest: str, *, path: Path | None = None
) -> list[list[float]] | None:
    """Return baked vectors aligned to ``passages``, or ``None`` to embed live.

    ``None`` whenever the file is absent, unreadable, for another catalog or
    model, or lacks any requested passage. Never raises.
    """
    target = path or BAKED_VECTORS_PATH
    cache_key = (str(target), digest)
    try:
        if cache_key not in _LOADED:
            _LOADED[cache_key] = _read(target, digest)
        by_key = _LOADED[cache_key]
        if by_key is None:
            return None
        found = [by_key.get(passage_key(p)) for p in passages]
        if any(vector is None for vector in found):
            return None
        return [vector for vector in found if vector is not None]
    except Exception as exc:  # noqa: BLE001 - a cache read must never break a turn
        _LOADED[cache_key] = None
        logger.warning("action_catalog_vectors.baked_unreadable reason=%s", type(exc).__name__)
        return None


def clear_loaded_cache() -> None:
    """Forget loaded files (tests only)."""
    _LOADED.clear()

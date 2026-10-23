"""Shared helpers for the Drive four-group training and evaluation scripts.

Developer tooling, not runtime. It embeds with the same pinned E5 model the
isolated child uses (``EmbeddingClient`` with local files only), so the numbers
the scripts report come from the model that runs in production. Embeddings are
cached on disk under the system temp directory, keyed by model revision and text,
and nothing in this module writes document text anywhere inside the repository.
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hushh_mcp.services.drive_groups.contract import (  # noqa: E402
    EMBEDDING_DIMENSIONS,
    FileEvidence,
)
from hushh_mcp.services.embedding_client_leaf import MODEL_REVISION, EmbeddingClient  # noqa: E402

DEFAULT_FIXTURES = (
    Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "drive_groups" / "synthetic.jsonl"
)
DEFAULT_CACHE = Path(tempfile.gettempdir()) / "hushh-drive-groups-cache"
BATCH = 32


def load_rows(path: Path, split: str | None = None) -> list[dict]:
    """Labelled rows: id, label, name, mime, head, shared_with_me, owned_by_me (+ split, family)."""
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
    return [row for row in rows if split in (None, "all", row.get("split"))]


def evidence_of(row: dict, vector: tuple[float, ...] | None = None) -> FileEvidence:
    return FileEvidence(
        name=row["name"],
        mime_type=row["mime"],
        owned_by_me=row.get("owned_by_me"),
        shared_with_me=row.get("shared_with_me"),
        head=row.get("head"),
        vector=vector,
    )


class CachedEmbedder:
    """The pinned E5 model, with a disk cache so a repeat run costs no model time."""

    def __init__(self, cache_dir: Path = DEFAULT_CACHE) -> None:
        self._cache = cache_dir
        self._cache.mkdir(parents=True, exist_ok=True)
        self._client = EmbeddingClient(local_files_only=True)

    def _path(self, kind: str, text: str) -> Path:
        digest = hashlib.sha256(f"{MODEL_REVISION}\0{kind}\0{text}".encode()).hexdigest()
        return self._cache / f"{kind}-{digest}.npy"

    def _embed(self, kind: str, texts: list[str]) -> np.ndarray:
        found: dict[int, np.ndarray] = {}
        missing: list[int] = []
        for index, text in enumerate(texts):
            path = self._path(kind, text)
            if path.exists():
                found[index] = np.load(path, allow_pickle=False)
            else:
                missing.append(index)
        for start in range(0, len(missing), BATCH):
            chunk = missing[start : start + BATCH]
            batch = [texts[index] for index in chunk]
            vectors = (
                self._client.embed_passages(batch)
                if kind == "passage"
                else [self._client.embed_query(text) for text in batch]
            )
            for index, vector in zip(chunk, vectors, strict=True):
                found[index] = np.asarray(vector, dtype=np.float64)
                np.save(self._path(kind, texts[index]), found[index], allow_pickle=False)
        if not texts:
            return np.zeros((0, EMBEDDING_DIMENSIONS))
        return np.stack([found[index] for index in range(len(texts))])

    def passages(self, texts: list[str]) -> np.ndarray:
        return self._embed("passage", texts)

    def queries(self, texts: list[str]) -> np.ndarray:
        return self._embed("query", texts)

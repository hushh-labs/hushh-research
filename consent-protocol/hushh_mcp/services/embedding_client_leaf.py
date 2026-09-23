"""Import-safe pinned embedding primitive; no application bootstrap or secrets."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, cast

MODEL_ID = "intfloat/multilingual-e5-small"
MODEL_REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3"
BAKED_MODEL_DIR = "/opt/hushh/models/multilingual-e5-small"
BAKED_MODEL_DIR_ENV = "HUSHH_DRIVE_EMBEDDING_MODEL_DIR"


class EmbeddingClient:
    def __init__(
        self, *, model_revision: str = MODEL_REVISION, local_files_only: bool = False
    ) -> None:
        self.model_revision = model_revision
        self.local_files_only = local_files_only
        self._model: Any = None

    def _load(self) -> Any:
        if self._model is None:
            from sentence_transformers import SentenceTransformer

            model_source = MODEL_ID
            if self.local_files_only and (baked_dir := os.getenv(BAKED_MODEL_DIR_ENV)):
                # The isolated production child has no network or credential
                # environment. A missing/broken image asset is an error, not
                # permission to fall back to a mutable remote model.
                if baked_dir != BAKED_MODEL_DIR or not Path(baked_dir).is_dir():
                    raise FileNotFoundError("pinned Drive embedding model is unavailable")
                model_source = baked_dir
            self._model = SentenceTransformer(
                model_source,
                revision=self.model_revision,
                local_files_only=self.local_files_only,
                trust_remote_code=False,
            )
        return self._model

    def embed_query(self, text: str) -> list[float]:
        result = self._load().encode(f"query: {text}", normalize_embeddings=True)
        return cast(list[float], result.tolist())

    def embed_passages(self, passages: list[str]) -> list[list[float]]:
        if not passages:
            return []
        result = self._load().encode([f"passage: {p}" for p in passages], normalize_embeddings=True)
        return cast(list[list[float]], result.tolist())

    def similarity(self, query_vec: list[float], passage_vecs: list[list[float]]) -> list[float]:
        if not passage_vecs:
            return []
        from numpy import array, dot

        return cast(list[float], dot(array(passage_vecs), array(query_vec)).tolist())

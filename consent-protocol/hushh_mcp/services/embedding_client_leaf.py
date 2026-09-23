"""Import-safe pinned embedding primitive; no application bootstrap or secrets."""

from __future__ import annotations

from typing import Any, cast

MODEL_REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3"


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

            self._model = SentenceTransformer(
                "intfloat/multilingual-e5-small",
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

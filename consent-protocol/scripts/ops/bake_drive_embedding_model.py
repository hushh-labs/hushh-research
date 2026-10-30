"""Bake and exercise the fixed offline Drive embedding model in the image.

This is an image-build step, not a startup download. The exact commit comes
from the runtime leaf and is the same profile used for encrypted index rows.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from huggingface_hub import snapshot_download

from hushh_mcp.services.embedding_client_leaf import BAKED_MODEL_DIR, MODEL_ID, MODEL_REVISION

REQUIRED_FILES = (
    "1_Pooling/config.json",
    "config.json",
    "model.safetensors",
    "modules.json",
    "sentence_bert_config.json",
    "sentencepiece.bpe.model",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
)


def verify_model(directory: Path) -> None:
    for relative in REQUIRED_FILES:
        item = directory / relative
        if not item.is_file() or item.stat().st_size == 0:
            raise RuntimeError("pinned Drive model asset is incomplete")

    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(str(directory), local_files_only=True, trust_remote_code=False)
    vector = model.encode("query: synthetic statement", normalize_embeddings=True)
    if len(vector) != 384:
        raise RuntimeError("pinned Drive model has the wrong embedding shape")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-only", type=Path)
    args = parser.parse_args()
    directory = args.verify_only or Path(BAKED_MODEL_DIR)
    if args.verify_only is None:
        snapshot_download(
            repo_id=MODEL_ID,
            revision=MODEL_REVISION,
            local_dir=directory,
            allow_patterns=list(REQUIRED_FILES),
            token=False,
        )
    verify_model(directory)
    print(f"Verified offline Drive model at revision {MODEL_REVISION}")


if __name__ == "__main__":
    main()

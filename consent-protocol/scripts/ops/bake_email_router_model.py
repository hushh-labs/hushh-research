"""Bake and qualify Email's exact FastEmbed model; never run downloads in chat.

The existing IndexedRouter and upstream FastEmbedEncoder remain unchanged. This
image-build step downloads an immutable HF revision, freezes its cache alias and
checks every required artifact before running a synthetic offline embedding.
"""

from __future__ import annotations

import argparse
import math
import os
from pathlib import Path

from hushh_mcp.services.email_oss.routing import (
    BAKED_MODEL_CACHE,
    MODEL_CACHE_REPOSITORY,
    MODEL_FILES,
    MODEL_NAME,
    MODEL_REPOSITORY,
    MODEL_REVISION,
    verify_email_router_model_cache,
)


def bake_model(cache: Path) -> None:
    from huggingface_hub import snapshot_download

    snapshot = Path(
        snapshot_download(
            repo_id=MODEL_REPOSITORY,
            revision=MODEL_REVISION,
            cache_dir=str(cache),
            allow_patterns=list(MODEL_FILES),
            token=False,
        )
    )
    repository = cache / MODEL_CACHE_REPOSITORY
    if snapshot.resolve() != (repository / "snapshots" / MODEL_REVISION).resolve():
        raise RuntimeError("Email router download did not resolve the pinned snapshot")
    # FastEmbedEncoder does not forward revision to its client. Freeze the
    # standard HF cache alias at build time instead of resolving remote `main`
    # on a serving turn. Runtime verifies this alias and all bytes before use.
    reference = repository / "refs" / "main"
    reference.parent.mkdir(parents=True, exist_ok=True)
    reference.write_text(MODEL_REVISION)
    verify_email_router_model_cache(cache)
    # Builder runs as root; both images serve as an unprivileged identity. Do
    # not depend on the download tool's umask for model/tokenizer readability.
    for item in cache.rglob("*"):
        if item.is_dir():
            item.chmod(0o755)
        elif item.is_file():
            item.chmod(0o644)
    cache.chmod(0o755)


def verify_model(cache: Path) -> None:
    verify_email_router_model_cache(cache)
    # FastEmbed itself checks this environment variable before every download
    # path; its HF client also receives local_files_only=True. No mutable model
    # lookup or custom encoder implementation is used by this qualification.
    os.environ["HF_HUB_OFFLINE"] = "1"
    from semantic_router.encoders import FastEmbedEncoder

    encoder = FastEmbedEncoder(name=MODEL_NAME, cache_dir=str(cache), max_length=512, threads=1)
    vectors = encoder(["Synthetic Email router image qualification."])
    if len(vectors) != 1 or len(vectors[0]) != 384 or not all(math.isfinite(v) for v in vectors[0]):
        raise RuntimeError("Baked Email router model has an invalid embedding shape")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-only", type=Path)
    args = parser.parse_args()
    cache = args.verify_only or Path(BAKED_MODEL_CACHE)
    if args.verify_only is None:
        bake_model(cache)
    verify_model(cache)
    print(f"Verified offline Email router model at revision {MODEL_REVISION}")


if __name__ == "__main__":
    main()

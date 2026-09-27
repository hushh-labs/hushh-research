"""Bake the generated action catalog's passage vectors into the image.

An image-build step, not a startup job. The catalog is static per image, yet
every Cloud Run instance embedded it at startup, once per gunicorn worker:
about 70s per instance with always-on CPU (9-15s per batch) and 37-78s per
batch while CPU was throttled. A first chat turn waited 13-50s behind it
(production and UAT, 2026-09-27).

It runs the runtime's own code: the gateway loader every caller uses, the
wired filter and passage builder ``search_actions`` uses, the catalog digest
``_ensure_passage_vectors`` keys by, and the same ``EmbeddingClient``, which
reads the baked model offline because the Dockerfile sets its directory. At
runtime a missing or mismatched file only means the catalog is embedded live.

Must run with no secrets: it imports ``hushh_mcp.services`` modules only.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

from hushh_mcp.services.action_catalog_vectors import (
    BAKED_VECTORS_PATH,
    baked_vectors_for,
    build_passage,
    catalog_digest,
    is_wired,
    write_baked_vectors,
)
from hushh_mcp.services.action_gateway import list_action_gateway_actions
from hushh_mcp.services.embedding_client_leaf import EmbeddingClient


def bake(output: Path) -> tuple[str, int]:
    """Embed the wired catalog and write it to ``output``; return (digest, count)."""
    gateway = {"actions": list_action_gateway_actions()}
    supported = [entry for entry in gateway["actions"] if is_wired(entry)]
    if not supported:
        # An empty gateway is a packaging defect, not a catalog to bake.
        raise RuntimeError("the generated action gateway has no wired actions")
    passages = [build_passage(entry) for entry in supported]
    digest = catalog_digest(gateway)
    vectors = EmbeddingClient().embed_passages(passages)
    write_baked_vectors(output, digest=digest, passages=passages, vectors=vectors)
    # Read it back through the runtime reader: a file the runtime would reject
    # must fail the build, not ship and silently fall back.
    if baked_vectors_for(passages, digest, path=output) is None:
        raise RuntimeError("baked action catalog vectors did not verify")
    return digest, len(passages)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=BAKED_VECTORS_PATH)
    args = parser.parse_args()
    started_at = time.perf_counter()
    digest, count = bake(args.output)
    print(
        f"Baked {count} action catalog vectors digest={digest} "
        f"duration_ms={(time.perf_counter() - started_at) * 1000:.0f} path={args.output}"
    )


if __name__ == "__main__":
    main()

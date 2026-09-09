#!/usr/bin/env python3
"""Promote the previous valid One Voice pack set without redeploying Cloud Run."""

from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path
from typing import Any


PROTOCOL_VERSION = "one.voice.model-pack-registry.v1"


def write_json_atomically(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as handle:
        json.dump(payload, handle, separators=(",", ":"), sort_keys=True)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    try:
        payload = json.loads(args.input.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SystemExit("current registry is unreadable") from exc
    if not isinstance(payload, dict) or payload.get("protocol_version") != PROTOCOL_VERSION:
        raise SystemExit("current registry has an unsupported protocol")
    active = payload.get("active_packs")
    rollback = payload.get("rollback_packs")
    if not isinstance(active, list) or not isinstance(rollback, list) or not rollback:
        raise SystemExit("current registry has no valid rollback pack set")
    if not all(isinstance(entry, dict) for entry in active + rollback):
        raise SystemExit("current registry has invalid pack entries")

    promoted = rollback
    source_shas = {str(entry.get("source_sha") or "").strip() for entry in promoted}
    catalog_versions = {str(entry.get("catalog_version") or "").strip() for entry in promoted}
    if (
        len(source_shas) != 1
        or len(catalog_versions) != 1
        or "" in (source_shas | catalog_versions)
    ):
        raise SystemExit("rollback packs must share source and catalog provenance")

    payload["active_packs"] = promoted
    payload["rollback_packs"] = active
    payload["source_sha"] = source_shas.pop()
    payload["catalog_version"] = catalog_versions.pop()
    write_json_atomically(args.output, payload)
    print(
        json.dumps(
            {
                "active_pack_count": len(promoted),
                "catalog_version": payload["catalog_version"],
                "source_sha": payload["source_sha"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()

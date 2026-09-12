#!/usr/bin/env python3
"""Verify a One Voice model-pack ZIP before publication.

This check is intentionally dependency-free so the publish workflow can fail
closed before uploading a large artifact. It validates the pack envelope and
its internal checksums; ONNX Runtime validation is performed by the training
command immediately before this check.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from pathlib import Path


REQUIRED_FILES = {"encoder.onnx", "ranker.onnx", "tokenizer.json", "action-index.json", "manifest.json"}
FORBIDDEN_TERMS = ("transcript", "audio", "credential", "vault", "contact", "coordinate")


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pack", type=Path)
    args = parser.parse_args()

    with zipfile.ZipFile(args.pack) as archive:
        if archive.testzip() is not None:
            raise SystemExit("model pack contains a corrupt member")
        names = set(archive.namelist())
        if names != REQUIRED_FILES:
            raise SystemExit(f"model pack members mismatch: {sorted(names)}")
        if any(".." in Path(name).parts or name.startswith("/") for name in names):
            raise SystemExit("model pack contains an unsafe path")
        manifest = json.loads(archive.read("manifest.json"))
        action_ids = json.loads(archive.read("action-index.json"))
        if not isinstance(manifest, dict) or not isinstance(action_ids, list) or not action_ids:
            raise SystemExit("model pack metadata is invalid")
        if manifest.get("schema_version") != "one-voice-model-pack.v1":
            raise SystemExit("unsupported model pack schema")
        if manifest.get("runtime") != "onnxruntime_web":
            raise SystemExit("model pack runtime is not browser ONNX")
        if manifest.get("entrypoint") != "one_voice_intent_ranker_v2":
            raise SystemExit("model pack entrypoint is invalid")
        if manifest.get("preprocessing_version") != "minilm-action-head-v1":
            raise SystemExit("model pack preprocessing version is invalid")
        if manifest.get("catalog_action_count") != len(action_ids):
            raise SystemExit("model pack action-index count mismatch")
        if len(set(action_ids)) != len(action_ids) or not all(isinstance(item, str) and item for item in action_ids):
            raise SystemExit("model pack action-index is not unique")
        for member, key in (("encoder.onnx", "encoder_sha256"), ("ranker.onnx", "ranker_sha256"), ("tokenizer.json", "tokenizer_sha256")):
            if manifest.get(key) != digest(archive.read(member)):
                raise SystemExit(f"model pack checksum mismatch: {member}")
        metadata = json.dumps(manifest, sort_keys=True).lower()
        if any(term in metadata for term in FORBIDDEN_TERMS):
            raise SystemExit("model pack metadata contains a protected-data term")

    print(json.dumps({"pack": str(args.pack), "bytes": args.pack.stat().st_size, "sha256": digest(args.pack.read_bytes())}, sort_keys=True))


if __name__ == "__main__":
    main()

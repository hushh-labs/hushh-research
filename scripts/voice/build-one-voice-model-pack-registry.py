#!/usr/bin/env python3
"""Create an immutable One Voice pack registry without bearer URLs.

The registry is a Secret Manager payload. It intentionally records object
identity, checksums, source/catalog provenance, and a prior active set for
rollback. Cloud Run creates fresh, short-lived download URLs only after it
loads this registry.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import tempfile
import zipfile
from pathlib import Path
from typing import Any


PROTOCOL_VERSION = "one.voice.model-pack-registry.v1"
SOURCE_SHA = re.compile(r"^[0-9a-fA-F]{7,64}$")
BUCKET = re.compile(r"^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$")
SAFE_VERSION = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
FLUID_AUDIO_PACK_ID = "fluid-audio-parakeet-eou-120m-coreml-v1"
FLUID_AUDIO_ENTRYPOINT = "one_voice_fluid_audio_parakeet_eou_120m_v1"
FLUID_AUDIO_NOTICE_ID = "fluid-audio-parakeet-eou-120m-coreml-v1"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ranker_metadata(path: Path) -> tuple[str, str]:
    with zipfile.ZipFile(path) as archive:
        manifest = json.loads(archive.read("manifest.json"))
    if not isinstance(manifest, dict):
        raise ValueError("ranker manifest must be an object")
    version = str(manifest.get("version") or "").strip()
    catalog_version = str(manifest.get("catalog_version") or "").strip()
    if not version or not catalog_version:
        raise ValueError("ranker manifest must contain version and catalog_version")
    return version, catalog_version


def prior_active_packs(path: Path | None) -> list[dict[str, Any]]:
    if not path or not path.is_file() or path.stat().st_size == 0:
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        # A legacy static-URL secret is not a rollback candidate. The backend
        # remains fail-closed until the first valid registry version is active.
        return []
    if not isinstance(payload, dict) or payload.get("protocol_version") != PROTOCOL_VERSION:
        return []
    active = payload.get("active_packs")
    if not isinstance(active, list) or len(active) > 16:
        return []
    return [entry for entry in active if isinstance(entry, dict)]


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
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--object-prefix", required=True)
    parser.add_argument("--asr-file", required=True, type=Path)
    parser.add_argument("--asr-version", required=True)
    parser.add_argument("--asr-object", required=True)
    parser.add_argument("--ranker-file", required=True, type=Path)
    parser.add_argument("--ranker-object", required=True)
    parser.add_argument("--fluid-audio-file", type=Path)
    parser.add_argument("--fluid-audio-version")
    parser.add_argument("--fluid-audio-object")
    parser.add_argument("--previous-registry", type=Path)
    args = parser.parse_args()

    source_sha = args.source_sha.strip().lower()
    if not SOURCE_SHA.fullmatch(source_sha):
        raise SystemExit("source SHA must be a commit SHA")
    bucket = args.bucket.strip()
    if not BUCKET.fullmatch(bucket):
        raise SystemExit("bucket must be an explicit Cloud Storage bucket")
    if not args.object_prefix.strip() or args.object_prefix.startswith("/"):
        raise SystemExit("object prefix must be a normalized object prefix")
    for artifact in (args.asr_file, args.ranker_file):
        if not artifact.is_file() or artifact.stat().st_size <= 0:
            raise SystemExit(f"missing verified artifact: {artifact}")

    fluid_values = (
        args.fluid_audio_file,
        args.fluid_audio_version,
        args.fluid_audio_object,
    )
    if any(value is not None for value in fluid_values) and not all(
        value is not None for value in fluid_values
    ):
        raise SystemExit("FluidAudio registry metadata must be provided as one complete set")
    if args.fluid_audio_file is not None:
        if not args.fluid_audio_file.is_file() or args.fluid_audio_file.stat().st_size <= 0:
            raise SystemExit(f"missing verified FluidAudio artifact: {args.fluid_audio_file}")
        if not SAFE_VERSION.fullmatch(str(args.fluid_audio_version).strip()):
            raise SystemExit("FluidAudio pack version is invalid")
        if not str(args.fluid_audio_object).strip().lstrip("/"):
            raise SystemExit("FluidAudio pack object identity is required")

    ranker_version, catalog_version = ranker_metadata(args.ranker_file)
    active_packs = [
        {
            "pack_id": "one-voice-en-asr-sherpa-onnx-v1",
            "version": args.asr_version.strip(),
            "size_bytes": args.asr_file.stat().st_size,
            "checksum": sha256(args.asr_file),
            "min_ram_gb": 2,
            "min_storage_mb": 256,
            "languages": ["en"],
            "tasks": ["stt"],
            "runtime": "sherpa_onnx_web",
            "preprocessing_version": "pcm16k-v1",
            "entrypoint": "sherpa_onnx_browser_streaming_v1",
            "bucket": bucket,
            "object_name": args.asr_object.strip().lstrip("/"),
            "source_sha": source_sha,
            "catalog_version": catalog_version,
            "license_notice_id": "sherpa-onnx-v1.13.7",
            "license_approved": False,
        },
        {
            "pack_id": "one-voice-en-intent-minilm-v1",
            "version": ranker_version,
            "size_bytes": args.ranker_file.stat().st_size,
            "checksum": sha256(args.ranker_file),
            "min_ram_gb": 2,
            "min_storage_mb": 64,
            "languages": ["en"],
            "tasks": ["intent"],
            "runtime": "onnxruntime_web",
            "preprocessing_version": "minilm-action-head-v1",
            "entrypoint": "one_voice_intent_ranker_v2",
            "bucket": bucket,
            "object_name": args.ranker_object.strip().lstrip("/"),
            "source_sha": source_sha,
            "catalog_version": catalog_version,
            "license_notice_id": "hushh-one-voice-intent-ranker-v1",
            "license_approved": False,
        },
    ]
    if args.fluid_audio_file is not None:
        active_packs.append(
            {
                "pack_id": FLUID_AUDIO_PACK_ID,
                "version": str(args.fluid_audio_version).strip(),
                "size_bytes": args.fluid_audio_file.stat().st_size,
                "checksum": sha256(args.fluid_audio_file),
                # The upstream Core ML archive is approximately 1.34 GB.
                # Require enough free device resources before advertising it;
                # the iOS adapter independently checks its local policy.
                "min_ram_gb": 4,
                "min_storage_mb": 1536,
                "languages": ["en"],
                "tasks": ["stt"],
                "runtime": "fluid_audio",
                "preprocessing_version": "pcm16k-v1",
                "entrypoint": FLUID_AUDIO_ENTRYPOINT,
                "bucket": bucket,
                "object_name": str(args.fluid_audio_object).strip().lstrip("/"),
                "source_sha": source_sha,
                "catalog_version": catalog_version,
                "license_notice_id": FLUID_AUDIO_NOTICE_ID,
                # This script is invoked only after the package verifier has
                # validated the committed legal/release notice.
                "license_approved": True,
            }
        )
    if not all(pack["version"] and pack["object_name"] for pack in active_packs):
        raise SystemExit("model pack version and object identity are required")

    write_json_atomically(
        args.output,
        {
            "protocol_version": PROTOCOL_VERSION,
            "source_sha": source_sha,
            "catalog_version": catalog_version,
            "active_packs": active_packs,
            "rollback_packs": prior_active_packs(args.previous_registry),
        },
    )

    print(
        json.dumps(
            {
                "active_pack_count": len(active_packs),
                "catalog_version": catalog_version,
                "source_sha": source_sha,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()

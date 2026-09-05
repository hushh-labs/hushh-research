#!/usr/bin/env python3
"""Pin Cloud Run's executable manifest without dropping build attestations.

Buildx may publish an image index containing both linux/amd64 and an attestation.
Cloud Run records the selected executable digest, not that parent index digest.
Resolve this once, before the deletion fence, so later checks remain exact.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

INDEX_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}
IMAGE_TYPES = {
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
}
CONFIG_TYPES = {
    "application/vnd.oci.image.config.v1+json",
    "application/vnd.docker.container.image.v1+json",
}


def _digest(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
        raise ValueError("Image digest must be an immutable sha256 digest")
    return value


def _validate_descriptor(value: Any) -> None:
    if not isinstance(value, dict):
        raise ValueError("Image descriptor must be an object")
    _digest(value.get("digest"))
    size = value.get("size")
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise ValueError("Image descriptor size must be a nonnegative integer")
    if not isinstance(value.get("mediaType"), str) or not value["mediaType"]:
        raise ValueError("Image descriptor media type is missing")


def _validate_direct_image(manifest: dict[str, Any]) -> None:
    config = manifest.get("config")
    _validate_descriptor(config)
    if config["mediaType"] not in CONFIG_TYPES:
        raise ValueError("Direct image requires an executable image config")
    layers = manifest.get("layers")
    if not isinstance(layers, list):
        raise ValueError("Direct image layers must be a list")
    for layer in layers:
        _validate_descriptor(layer)


def resolve_manifest(raw: bytes, expected_digest: str) -> dict[str, str]:
    expected_digest = _digest(expected_digest)
    # Some CLI versions append a presentation newline to --raw. Accept only
    # bytes whose cryptographic digest matches, never reserialized JSON.
    if not any(
        "sha256:" + hashlib.sha256(candidate).hexdigest() == expected_digest
        for candidate in (raw, raw.removesuffix(b"\n"))
    ):
        raise ValueError("Manifest bytes do not match the pinned image digest")
    manifest = json.loads(raw)
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 2:
        raise ValueError("Expected a schemaVersion 2 image manifest or index")
    annotations = manifest.get("annotations", {})
    if not isinstance(annotations, dict):
        raise ValueError("Image annotations must be an object")
    if (
        "artifactType" in manifest
        or annotations.get("vnd.docker.reference.type") == "attestation-manifest"
    ):
        raise ValueError("An artifact cannot be pinned as an executable image")
    media_type = manifest.get("mediaType")
    if not isinstance(media_type, str):
        raise ValueError("Image media type must be a string")
    if media_type in IMAGE_TYPES:
        _validate_direct_image(manifest)
        return {"digest": expected_digest, "selection": "direct_manifest"}
    if media_type not in INDEX_TYPES:
        raise ValueError("Unsupported image media type")
    entries = manifest.get("manifests")
    if not isinstance(entries, list) or not all(
        isinstance(item, dict) for item in entries
    ):
        raise ValueError("Image index must contain manifest descriptors")
    eligible = []
    for entry in entries:
        platform = entry.get("platform", {})
        annotations = entry.get("annotations", {})
        if not isinstance(platform, dict) or not isinstance(annotations, dict):
            raise ValueError("Malformed manifest platform or annotations")
        if (
            platform.get("os") == "linux"
            and platform.get("architecture") == "amd64"
            and annotations.get("vnd.docker.reference.type") != "attestation-manifest"
            and "artifactType" not in entry
        ):
            eligible.append(entry)
    if len(eligible) != 1:
        raise ValueError("Expected exactly one executable linux/amd64 manifest")
    selected = eligible[0]
    _validate_descriptor(selected)
    if (
        not isinstance(selected.get("mediaType"), str)
        or selected["mediaType"] not in IMAGE_TYPES
    ):
        raise ValueError("Executable descriptor must be an image, not a nested index")
    return {"digest": _digest(selected.get("digest")), "selection": "linux/amd64"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image-reference", required=True)
    parser.add_argument("--manifest-json", required=True)
    parser.add_argument("--json-output", type=Path, required=True)
    parser.add_argument("--sha", required=True)
    args = parser.parse_args()
    try:
        repository, separator, index_digest = args.image_reference.partition("@")
        if not separator or not repository or any(c.isspace() for c in repository):
            raise ValueError("Expected an immutable repository@sha256 image reference")
        raw = (
            sys.stdin.buffer.read()
            if args.manifest_json == "-"
            else Path(args.manifest_json).read_bytes()
        )
        resolved = resolve_manifest(raw, index_digest)
        image_reference = f"{repository}@{resolved['digest']}"
        report = {
            "status": "pinned",
            "repository": repository,
            "index_reference": args.image_reference,
            "image_reference": image_reference,
            "digest_algorithm": "sha256",
            "selection": resolved["selection"],
            "sha": args.sha,
        }
        args.json_output.write_text(
            json.dumps(report, indent=2, sort_keys=True), encoding="utf-8"
        )
    except (OSError, ValueError, TypeError) as exc:
        print(f"Cannot pin Cloud Run image: {exc}", file=sys.stderr)
        return 1
    print(image_reference)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

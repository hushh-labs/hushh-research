#!/usr/bin/env python3
"""Verify a normalized, legally approved FluidAudio streaming model pack."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
import zipfile
from pathlib import Path
from typing import Any


MODULE_PATH = Path(__file__).with_name("package-fluid-audio-model-pack.py")
SPEC = importlib.util.spec_from_file_location("fluid_audio_pack", MODULE_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - impossible on supported CPython
    raise RuntimeError("cannot load FluidAudio model pack helpers")
HELPERS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPERS)


class VerificationError(RuntimeError):
    """The candidate archive cannot be registered for native release."""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify(pack: Path, notices: Path, expected_version: str | None = None) -> dict[str, Any]:
    if not pack.is_file() or pack.stat().st_size <= 0:
        raise VerificationError("FluidAudio model pack is missing")
    try:
        source_url, source_revision = HELPERS.approved_notice(notices)
    except HELPERS.PackError as exc:
        raise VerificationError(str(exc)) from exc
    try:
        with zipfile.ZipFile(pack) as archive:
            files = HELPERS.safe_files(archive)
            root = HELPERS.required_root(files)
            if root:
                raise VerificationError("normalized FluidAudio model pack must load from its root")
            paths = {name for name, _ in files}
            if HELPERS.MANIFEST_NAME not in paths:
                raise VerificationError("FluidAudio model pack has no provenance manifest")
            unexpected = {
                name
                for name in paths
                if name != HELPERS.MANIFEST_NAME
                and name != HELPERS.VOCABULARY
                and not any(name.startswith(f"{bundle}/") for bundle in HELPERS.REQUIRED_BUNDLES)
            }
            if unexpected:
                raise VerificationError("FluidAudio model pack contains unreviewed files")
            manifest = json.loads(archive.read(HELPERS.MANIFEST_NAME))
    except (zipfile.BadZipFile, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise VerificationError("FluidAudio model pack is unreadable") from exc
    if not isinstance(manifest, dict):
        raise VerificationError("FluidAudio model pack manifest is invalid")
    if (
        manifest.get("protocol_version") != HELPERS.PROTOCOL_VERSION
        or manifest.get("pack_id") != HELPERS.PACK_ID
        or manifest.get("runtime") != "fluid_audio"
        or manifest.get("entrypoint") != HELPERS.ENTRYPOINT
        or manifest.get("license_notice_id") != HELPERS.NOTICE_ID
        or manifest.get("source") != source_url
        or manifest.get("source_revision") != source_revision
        or not isinstance(manifest.get("version"), str)
        or not HELPERS.SAFE_VERSION.fullmatch(manifest["version"])
        or not isinstance(manifest.get("source_archive_sha256"), str)
        or not HELPERS.SHA256.fullmatch(manifest["source_archive_sha256"])
    ):
        raise VerificationError("FluidAudio model pack provenance does not match the approved notice")
    if expected_version is not None and manifest["version"] != expected_version:
        raise VerificationError("FluidAudio model pack version does not match the requested release")
    return {
        "pack_id": HELPERS.PACK_ID,
        "version": manifest["version"],
        "source_revision": source_revision,
        "size_bytes": pack.stat().st_size,
        "checksum": sha256(pack),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pack", type=Path)
    parser.add_argument("--notices", required=True, type=Path)
    parser.add_argument("--version")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        result = verify(args.pack, args.notices, args.version)
    except VerificationError as exc:
        print(f"verify-fluid-audio-model-pack: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

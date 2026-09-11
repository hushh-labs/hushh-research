#!/usr/bin/env python3
"""Create a deterministic, reviewed FluidAudio streaming pack.

The upstream Hugging Face snapshot contains a ``160ms`` directory.  The iOS
adapter deliberately loads a normalized pack root, so this command copies only
the four files required by FluidAudio v0.15.6 into a new archive.  It neither
downloads a model nor writes model bytes into the repository.

The NVIDIA model is opt-in: packaging fails until the committed model notice
records both legal approval and release enablement.  This keeps an operator
from accidentally treating the Apache-licensed SDK notice as approval for the
separately licensed model.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


PACK_ID = "fluid-audio-parakeet-eou-120m-coreml-v1"
NOTICE_ID = PACK_ID
ENTRYPOINT = "one_voice_fluid_audio_parakeet_eou_120m_v1"
PROTOCOL_VERSION = "one.voice.fluid-audio-pack.v1"
NOTICE_SOURCE = re.compile(
    r"^https://huggingface\.co/FluidInference/"
    r"parakeet-realtime-eou-120m-coreml/tree/([0-9a-f]{40})$",
    re.IGNORECASE,
)
SAFE_VERSION = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
REQUIRED_BUNDLES = (
    "streaming_encoder.mlmodelc",
    "decoder.mlmodelc",
    "joint_decision.mlmodelc",
)
VOCABULARY = "vocab.json"
MANIFEST_NAME = "one-voice-fluid-audio-manifest.json"
MAX_ARCHIVE_MEMBERS = 100_000
MAX_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024


class PackError(RuntimeError):
    """An archive cannot become a reviewed native model pack."""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_member_name(name: str) -> str:
    value = name.replace("\\", "/").rstrip("/")
    path = PurePosixPath(value)
    if not value or path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise PackError("model archive has an unsafe member path")
    return path.as_posix()


def is_symlink(member: zipfile.ZipInfo) -> bool:
    return stat.S_IFMT(member.external_attr >> 16) == stat.S_IFLNK


def safe_files(archive: zipfile.ZipFile) -> list[tuple[str, zipfile.ZipInfo]]:
    infos = archive.infolist()
    if not infos or len(infos) > MAX_ARCHIVE_MEMBERS:
        raise PackError("model archive has an invalid member count")
    if sum(info.file_size for info in infos) > MAX_UNCOMPRESSED_BYTES:
        raise PackError("model archive exceeds the reviewed unpacked size limit")

    files: list[tuple[str, zipfile.ZipInfo]] = []
    seen: set[str] = set()
    for member in infos:
        normalized = normalized_member_name(member.filename)
        if is_symlink(member):
            raise PackError("model archive must not contain symbolic links")
        if member.is_dir():
            continue
        if normalized in seen:
            raise PackError("model archive has duplicate members")
        seen.add(normalized)
        files.append((normalized, member))
    return files


def required_root(files: list[tuple[str, zipfile.ZipInfo]]) -> str:
    paths = {name for name, _ in files}
    candidates: set[str] = set()
    for name in paths:
        suffix = f"/{VOCABULARY}"
        if name == VOCABULARY:
            candidates.add("")
        elif name.endswith(suffix):
            candidates.add(name[: -len(suffix)])

    valid: list[str] = []
    for root in candidates:
        prefix = f"{root}/" if root else ""
        if f"{prefix}{VOCABULARY}" not in paths:
            continue
        if all(
            any(path.startswith(f"{prefix}{bundle}/") for path in paths)
            for bundle in REQUIRED_BUNDLES
        ):
            valid.append(root)
    if len(valid) != 1:
        raise PackError("model archive must contain exactly one complete 160ms model root")
    return valid[0]


def approved_notice(path: Path) -> tuple[str, str]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PackError("cannot read the FluidAudio model notice") from exc
    artifacts = payload.get("artifacts") if isinstance(payload, dict) else None
    if not isinstance(artifacts, list):
        raise PackError("FluidAudio model notice has no artifacts")
    notices = [item for item in artifacts if isinstance(item, dict) and item.get("notice_id") == NOTICE_ID]
    if len(notices) != 1:
        raise PackError("FluidAudio model notice is missing or ambiguous")
    notice = notices[0]
    if (
        notice.get("license") != "NVIDIA Open Model License"
        or notice.get("approval_state") != "approved"
        or notice.get("release_enabled") is not True
    ):
        raise PackError("FluidAudio model is not legally approved and release-enabled")
    source = notice.get("source")
    match = NOTICE_SOURCE.fullmatch(source) if isinstance(source, str) else None
    if not match:
        raise PackError("FluidAudio model notice must pin the exact upstream revision")
    return source, match.group(1).lower()


def selected_members(
    files: list[tuple[str, zipfile.ZipInfo]], root: str
) -> list[tuple[str, zipfile.ZipInfo]]:
    prefix = f"{root}/" if root else ""
    selected: list[tuple[str, zipfile.ZipInfo]] = []
    for source_name, member in files:
        relative = source_name[len(prefix) :] if prefix else source_name
        if relative == VOCABULARY or any(
            relative.startswith(f"{bundle}/") for bundle in REQUIRED_BUNDLES
        ):
            selected.append((relative, member))
    if not selected:
        raise PackError("model archive has no reviewed model files")
    return sorted(selected, key=lambda item: item[0])


def write_member(archive: zipfile.ZipFile, name: str, payload: bytes) -> None:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    archive.writestr(info, payload)


def package(source: Path, notices: Path, version: str, output: Path) -> dict[str, Any]:
    if not source.is_file() or source.stat().st_size <= 0:
        raise PackError("source model archive is missing")
    if not SAFE_VERSION.fullmatch(version):
        raise PackError("pack version is malformed")
    source_url, source_revision = approved_notice(notices)
    try:
        with zipfile.ZipFile(source) as input_archive:
            files = safe_files(input_archive)
            root = required_root(files)
            selected = selected_members(files, root)
            output.parent.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(
                output,
                "w",
                compression=zipfile.ZIP_DEFLATED,
                compresslevel=6,
            ) as output_archive:
                for destination_name, member in selected:
                    with input_archive.open(member) as handle:
                        write_member(output_archive, destination_name, handle.read())
                manifest = {
                    "protocol_version": PROTOCOL_VERSION,
                    "pack_id": PACK_ID,
                    "version": version,
                    "runtime": "fluid_audio",
                    "entrypoint": ENTRYPOINT,
                    "license_notice_id": NOTICE_ID,
                    "source": source_url,
                    "source_revision": source_revision,
                    "source_archive_sha256": sha256(source),
                }
                write_member(
                    output_archive,
                    MANIFEST_NAME,
                    (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode(),
                )
    except zipfile.BadZipFile as exc:
        raise PackError("source model archive is not a valid ZIP") from exc

    digest = sha256(output)
    if not SHA256.fullmatch(digest):  # defensive: a future checksum helper must stay SHA-256
        raise PackError("generated model pack checksum is invalid")
    return {
        "pack_id": PACK_ID,
        "version": version,
        "source_revision": source_revision,
        "size_bytes": output.stat().st_size,
        "checksum": digest,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-archive", required=True, type=Path)
    parser.add_argument("--notices", required=True, type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        result = package(args.source_archive, args.notices, args.version.strip(), args.output)
    except PackError as exc:
        print(f"package-fluid-audio-model-pack: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

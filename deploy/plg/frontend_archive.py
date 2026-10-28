"""Finite frontend archive capability; no release authority."""

from __future__ import annotations
import hashlib
import io
import json
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from pathspec import GitIgnoreSpec
import frontend_release as release


def _member_allowed(member: tarfile.TarInfo) -> bool:
    path = PurePosixPath(member.name)
    if (
        path.is_absolute()
        or ".." in path.parts
        or (not (member.isfile() or member.isdir()))
    ):
        return False
    name = path.as_posix().rstrip("/")
    return (
        name == "hushh-webapp"
        or name.startswith("hushh-webapp/")
        or name
        in {"scripts", "scripts/deploy", "scripts/ops", *release.ARCHIVE_PATHS[1:]}
    )


def archive_source(destination: Path, overlays: dict[str, bytes]) -> dict:
    """Archive recorded source bytes plus explicitly reviewed build helpers."""
    release.require(
        not destination.exists(), "Frontend archive destination already exists"
    )
    release.require(
        set(overlays) == set(release.OVERLAYS)
        and all(
            (
                isinstance(value, bytes) and 0 < len(value) <= release.MAX_HELPER
                for value in overlays.values()
            )
        ),
        "Frontend build helper invalid",
    )
    git = release.source.backend._git
    release.require(
        git("rev-parse", f"{release.SOURCE}^{{tree}}").strip().decode()
        == release.SOURCE_TREE,
        "Frontend source tree changed",
    )
    tree_listing, ignore_bytes, ignore = _source_inventory()
    with tempfile.TemporaryDirectory(prefix="plg-w2-archive-") as folder:
        original = Path(folder) / "source.tar"
        result = release.source.backend._run_git(
            "-c",
            "core.autocrlf=false",
            "archive",
            "--format=tar",
            "--output=" + str(original),
            release.SOURCE,
            *release.ARCHIVE_PATHS,
        )
        release.require(
            result.returncode == 0 and original.is_file(),
            "Frontend source archive unavailable",
        )
        seen: set[str] = set()
        inventory = hashlib.sha256()
        with (
            tarfile.open(original, "r:") as incoming,
            tarfile.open(destination, "x:gz") as outgoing,
        ):
            _copy_members(incoming, outgoing, ignore, seen, inventory)
            release.require(
                all((path in seen for path in release.ARCHIVE_PATHS)),
                "Frontend archive input missing",
            )
            _append_overlays(outgoing, overlays, seen, inventory)
    release.require(
        destination.is_file() and destination.stat().st_size <= release.MAX_ARCHIVE,
        "Frontend archive oversized",
    )
    digest = hashlib.sha256()
    with destination.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return {
        "sourceSha": release.SOURCE,
        "sourceTree": release.SOURCE_TREE,
        "sourceInventorySha256": hashlib.sha256(tree_listing).hexdigest(),
        "sourcePaths": list(release.ARCHIVE_PATHS),
        "overlays": {
            name: hashlib.sha256(overlays[name]).hexdigest()
            for name in release.OVERLAYS
        },
        "uploadFilterSha256": hashlib.sha256(ignore_bytes).hexdigest(),
        "inventorySha256": inventory.hexdigest(),
        "archiveSha256": digest.hexdigest(),
        "environmentAccepted": False,
        "productionTrafficAuthorized": False,
    }


def _source_inventory():
    git = release.source.backend._git
    tree_listing = git(
        "ls-tree", "-r", "-l", "-z", release.SOURCE, "--", *release.ARCHIVE_PATHS
    )
    release.require(
        len(tree_listing) <= 8 * 1024 * 1024, "Frontend source inventory oversized"
    )
    entries = tree_listing.split(b"\x00")
    release.require(
        entries[-1] == b"" and 0 < len(entries) - 1 <= release.MAX_ENTRIES,
        "Frontend source inventory invalid",
    )
    total = 0
    for row in entries[:-1]:
        fields, name = row.split(b"\t", 1)
        mode, kind, _blob, size = fields.split()
        release.require(
            mode in {b"100644", b"100755"} and kind == b"blob" and size.isdigit(),
            "Frontend source object invalid",
        )
        release.require(bool(name), "Frontend source path invalid")
        total += int(size) + 4096
        release.require(
            total <= release.MAX_ARCHIVE, "Frontend source contents oversized"
        )
    ignore_bytes = git("show", f"{release.SOURCE}:.gcloudignore")
    release.require(len(ignore_bytes) <= 256 * 1024, "Frontend upload filter oversized")
    ignore = GitIgnoreSpec.from_lines(ignore_bytes.decode("utf-8-sig").splitlines())
    return tree_listing, ignore_bytes, ignore


def _copy_members(incoming, outgoing, ignore, seen, inventory):
    total_size = 0
    for member in incoming:
        release.require(
            len(seen) < release.MAX_ENTRIES and _member_allowed(member),
            "Frontend archive entry refused",
        )
        name = PurePosixPath(member.name).as_posix().rstrip("/")
        release.require(
            name not in seen and name not in release.OVERLAYS,
            "Frontend archive entry duplicated",
        )
        seen.add(name)
        parts = PurePosixPath(name).parts
        if ignore.match_file(name + ("/" if member.isdir() else "")) or (
            name.startswith("hushh-webapp/")
            and (
                any((part.startswith(".env") or part == "__tests__" for part in parts))
                or name.endswith((".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"))
            )
        ):
            continue
        total_size += member.size
        release.require(
            total_size <= release.MAX_ARCHIVE, "Frontend archive contents oversized"
        )
        item_hash = hashlib.sha256()
        if member.isfile():
            file = incoming.extractfile(member)
            release.require(file is not None, "Frontend archive entry unavailable")
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                item_hash.update(chunk)
        inventory.update(
            json.dumps(
                [name, member.mode, member.size, item_hash.hexdigest()],
                separators=(",", ":"),
            ).encode()
            + b"\n"
        )
        outgoing.addfile(
            member, incoming.extractfile(member) if member.isfile() else None
        )


def _append_overlays(outgoing, overlays, seen, inventory):
    if "scripts/deploy" not in seen:
        directory = tarfile.TarInfo("scripts/deploy")
        directory.type, directory.mode, directory.mtime = (tarfile.DIRTYPE, 493, 0)
        outgoing.addfile(directory)
        inventory.update(
            json.dumps(
                ["scripts/deploy", directory.mode, 0, hashlib.sha256().hexdigest()],
                separators=(",", ":"),
            ).encode()
            + b"\n"
        )
    for name in release.OVERLAYS:
        content = overlays[name]
        info = tarfile.TarInfo(name)
        info.mode, info.size, info.mtime = (420, len(content), 0)
        outgoing.addfile(info, io.BytesIO(content))
        inventory.update(
            json.dumps(
                [name, info.mode, info.size, hashlib.sha256(content).hexdigest()],
                separators=(",", ":"),
            ).encode()
            + b"\n"
        )

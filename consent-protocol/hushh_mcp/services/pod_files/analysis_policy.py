"""Owner analysis consent and ancestor exclusions over the encrypted catalog."""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

from .contracts import FilesRefused, identifier

if TYPE_CHECKING:
    from .library import FilesLibrary


async def settings(library: FilesLibrary) -> dict[str, Any]:
    try:
        value, _ = await library._read("settings.bin")
        return value
    except FilesRefused as exc:
        if exc.status != 404:
            raise
        return {"revision": 0, "analysis": False, "automatic": False, "excluded": []}


async def configure(
    library: FilesLibrary, *, revision: int, analysis: bool, automatic: bool, excluded: list[str]
) -> dict[str, Any]:
    try:
        current, generation = await library._read("settings.bin")
    except FilesRefused as exc:
        if exc.status != 404:
            raise
        current, generation = {"revision": 0}, 0
    if current["revision"] != revision:
        raise FilesRefused("FILES_REVISION_CONFLICT")
    if len(excluded) > 1000:
        raise FilesRefused("FILES_EXCLUSIONS_TOO_LARGE", 400)
    for file_id in excluded:
        identifier(file_id)
    updated = {
        "revision": revision + 1,
        "analysis": analysis,
        "automatic": automatic and analysis,
        "excluded": sorted(set(excluded)),
        "updatedAt": int(time.time() * 1000),
    }
    await library._write("settings.bin", updated, generation)
    return updated


async def analysis_allowed(library: FilesLibrary, file_id: str) -> dict[str, Any]:
    settings = await library.settings()
    if not settings["analysis"]:
        raise FilesRefused("FILES_ANALYSIS_CONSENT_REQUIRED", 403)
    entry, _ = await library._read(library._path(file_id))
    current = file_id
    for _ in range(256):
        if current in settings["excluded"]:
            raise FilesRefused("FILES_EXCLUDED", 403)
        if current == "root":
            return settings
        ancestor, _ = await library._read(library._path(current))
        if ancestor["state"] != "ready":
            raise FilesRefused("FILES_SOURCE_UNAVAILABLE", 409)
        current = ancestor["parent"]
    raise FilesRefused("FILES_FOLDER_DEPTH_LIMIT", 400)

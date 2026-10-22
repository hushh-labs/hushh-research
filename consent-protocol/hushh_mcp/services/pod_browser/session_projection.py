"""Metadata-only browser recovery projection; no session values."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from hushh_mcp.services.pod_commit_log import PodCommitLog, PodLogCursor

from .contracts import BrowserRefused
from .session_state import MAX_SESSION_BYTES

KIND = "browser_session_v1"
_OBJECT = re.compile(r"^browser/sessions/[a-f0-9]{32}\.bin$")
_SITE = re.compile(r"^[a-f0-9]{64}$")


@dataclass(frozen=True)
class SiteRevision:
    generation: int = 0
    object_key: str | None = None
    digest: str | None = None
    size: int = 0


@dataclass(frozen=True)
class ForgetReceipt:
    fenced: bool
    persisted: bool
    deletion_requested: bool
    physical_deletion: str = "subject_to_cloud_retention"
    remote_logout: bool = False


@dataclass
class SessionProjection:
    sites: dict[str, SiteRevision] = field(default_factory=dict)
    objects: dict[str, set[str]] = field(default_factory=dict)

    def apply(self, record: dict) -> None:
        if record["kind"] != KIND:
            return
        entry = record["payload"]
        if not isinstance(entry, dict):
            raise BrowserRefused("BROWSER_SESSION_LOG_INVALID")
        site, generation = entry.get("site"), entry.get("generation")
        if (
            not isinstance(site, str)
            or not _SITE.fullmatch(site)
            or type(generation) is not int
            or generation < 0
        ):
            raise BrowserRefused("BROWSER_SESSION_LOG_INVALID")
        prior = self.sites.get(site, SiteRevision())
        operation = entry.get("operation")
        if operation in {"intent", "publish"}:
            key = entry.get("object")
            if (
                not isinstance(key, str)
                or not _OBJECT.fullmatch(key)
                or generation != prior.generation
            ):
                raise BrowserRefused("BROWSER_SESSION_LOG_INVALID")
            if operation == "intent":
                self.objects.setdefault(site, set()).add(key)
            else:
                digest, size = entry.get("digest"), entry.get("size")
                if (
                    key not in self.objects.get(site, set())
                    or not isinstance(digest, str)
                    or not _SITE.fullmatch(digest)
                    or type(size) is not int
                    or not 28 <= size <= MAX_SESSION_BYTES + 28
                ):
                    raise BrowserRefused("BROWSER_SESSION_LOG_INVALID")
                self.sites[site] = SiteRevision(generation, key, digest, size)
        elif operation == "forget" and generation == prior.generation + 1:
            self.sites[site] = SiteRevision(generation)
        else:
            raise BrowserRefused("BROWSER_SESSION_LOG_INVALID")


async def refresh_projection(
    log: PodCommitLog, cursor: PodLogCursor | None, current: SessionProjection
) -> tuple[SessionProjection, PodLogCursor | None]:
    records: list[dict[str, Any]] = []

    def collect(record: dict[str, Any]) -> None:
        if record["kind"] == KIND:
            records.append(record)
            if len(records) > 30000:
                raise BrowserRefused("BROWSER_SESSION_HISTORY_LIMIT")

    cursor = await log.fold_since(cursor, collect)
    # Do not publish a partial projection if a known record is malformed.
    projection = SessionProjection(
        dict(current.sites),
        {site: set(keys) for site, keys in current.objects.items()},
    )
    for record in reversed(records):
        projection.apply(record)
    return projection, cursor

"""Sealed store for the four-group Drive organizing aid: opt-in, leases and placed entries.

Connection -> preference -> state -> entries is the lock order, as in the collection
store. Provider I/O stays outside transactions; the connection generation, the
owner's background preference, the opt-in revision and the lease are rechecked at
every commit, so a late result from a stale run is refused. Shelf, confidence, dates
and counts are server-readable organizing metadata. The Drive file ID, name, link
and any kept text start or embedding are sealed (AES-256-GCM under the Drive
processing key, with the owner, reference and generation as associated data), so a
row copied to another owner, file or connection cannot be opened. A placement grants
no sharing, consent or search authority and never changes the person's Drive.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import struct
from collections.abc import Collection, Sequence
from dataclasses import dataclass, field, replace
from datetime import date, datetime
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import text

from hushh_mcp.services.connector_feature_admission import (
    connector_feature_enabled,
    connector_feature_owner_cohort,
)
from hushh_mcp.services.drive_document_store import DriveDocumentCipher
from hushh_mcp.services.drive_groups.contract import (
    EMBEDDING_DIMENSIONS,
    GROUP_IDS,
    KEPT,
    GroupIndexDisabled,
    Placement,
    four_group_index_enabled,
)
from hushh_mcp.services.drive_groups.folders import load_folders, parse_period, summarize_folders
from hushh_mcp.services.drive_groups.period import deciding_day, fiscal_quarter
from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.owner_placement_guard import admit_hub_content

logger = logging.getLogger(__name__)

DISCLOSURE = "drive-four-group-v1"
LEASE_SECONDS = 300
MAX_BATCH = 200
MAX_PAGE = 100
MAX_INDEXED_FILES = 10_000
_VECTOR = struct.Struct(f"<{EMBEDDING_DIMENSIONS}f")


class DriveGroupCipher(DriveDocumentCipher):
    """Entry sealing under the Drive processing key, domain-separated from its other uses."""

    def ref(self, user_id: str, file_id: str) -> str:
        """An opaque, stable reference to one file for one owner; the file ID is not recoverable."""
        message = json.dumps(["drive-group-source-v1", user_id, file_id]).encode()
        return hmac.new(self._key(), message, hashlib.sha256).hexdigest()

    @staticmethod
    def _entry_aad(user_id: str, ref: str, generation: int) -> bytes:
        return json.dumps(["drive-group-entry-v1", user_id, ref, generation]).encode()

    def seal_entry(self, entry: dict, *, user_id: str, ref: str, generation: int) -> dict:
        nonce = secrets.token_bytes(12)
        ciphertext = AESGCM(self._key()).encrypt(
            nonce,
            json.dumps(entry, separators=(",", ":")).encode(),
            self._entry_aad(user_id, ref, generation),
        )
        return {
            "version": 1,
            "iv": base64.b64encode(nonce).decode(),
            "ciphertext": base64.b64encode(ciphertext).decode(),
        }

    def open_entry(self, row: dict) -> dict:
        try:
            envelope = row["entry_envelope"]
            if envelope["version"] != 1:
                raise ValueError("unknown envelope")
            plaintext = AESGCM(self._key()).decrypt(
                base64.b64decode(envelope["iv"], validate=True),
                base64.b64decode(envelope["ciphertext"], validate=True),
                self._entry_aad(row["user_id"], row["source_ref"], row["connection_generation"]),
            )
            value = json.loads(plaintext)
            if not isinstance(value, dict):
                raise ValueError("shape")
            return value
        except Exception:
            raise DriveReadError("document_storage_unavailable") from None


@dataclass(frozen=True, slots=True)
class GroupEntry:
    """One placed file as the worker hands it to the store."""

    file_id: str
    title: str
    mime_type: str
    view_url: str | None
    created_time: datetime | None
    modified_time: datetime
    title_day: date | None
    placement: Placement
    head: str | None = field(default=None, repr=False)
    vector: tuple[float, ...] | None = field(default=None, repr=False)
    source_version: str | None = None


def _zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        raise DriveReadError("invalid_argument") from None


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


class DriveGroupIndexStore(DriveLivePreferences):
    async def _content_transaction(self, user_id, operation):
        await admit_hub_content(user_id, "drive_group_index")
        result = await self._transaction(operation)
        await admit_hub_content(user_id, "drive_group_index")
        return result

    def __init__(self, db=None, *, cipher=None, sealer: DriveGroupCipher | None = None):
        super().__init__(db, cipher=cipher)
        self.sealer = sealer or DriveGroupCipher()

    @staticmethod
    def _require_flag(user_id: str) -> None:
        if not four_group_index_enabled() or not connector_feature_enabled(
            "drive_four_group_index", user_id
        ):
            raise GroupIndexDisabled("the Drive four-group index is off")

    def _processing(self, connection, user_id: str, generation: int, revision: int | None = None):
        preference = self.background_current(connection, user_id=user_id, generation=generation)
        row = self._row(
            connection,
            "SELECT * FROM drive_group_index_state WHERE user_id=:user FOR UPDATE",
            {"user": user_id},
        )
        if (
            not row
            or not row["processing_enabled"]
            or row["disclosure_version"] != DISCLOSURE
            or row["connection_generation"] != generation
            or revision is not None
            and row["revision"] != revision
        ):
            raise DriveReadError("group_index_processing_required")
        return row, preference

    async def set_processing(
        self, *, user_id: str, enabled: bool, disclosure: str | None, time_zone: str = "UTC"
    ) -> dict:
        """The owner's opt-in. Turning it on needs the exact disclosure; off pauses, never deletes."""
        self._require_flag(user_id)
        if type(enabled) is not bool or enabled and disclosure != DISCLOSURE:
            raise DriveReadError("confirmation_required")
        _zone(time_zone)

        def operation(connection):
            current = self.live_active(connection, user_id=user_id)
            row = self._row(
                connection,
                """
                INSERT INTO drive_group_index_state
                  (user_id,connection_generation,processing_enabled,disclosure_version,time_zone)
                VALUES (:user,:generation,:enabled,:disclosure,:zone)
                ON CONFLICT (user_id) DO UPDATE SET
                  connection_generation=EXCLUDED.connection_generation,
                  processing_enabled=EXCLUDED.processing_enabled,
                  disclosure_version=EXCLUDED.disclosure_version,
                  time_zone=EXCLUDED.time_zone,
                  revision=drive_group_index_state.revision+1,
                  work_remaining=TRUE,
                  lease_id=NULL, lease_expires_at=NULL, attempt_count=0, last_error_code=NULL,
                  next_at=clock_timestamp(), updated_at=clock_timestamp()
                RETURNING revision, processing_enabled
                """,
                {
                    "user": user_id,
                    "generation": current["connection_generation"],
                    "enabled": enabled,
                    "disclosure": DISCLOSURE if enabled else None,
                    "zone": time_zone,
                },
            )
            return {"enabled": row["processing_enabled"], "revision": row["revision"]}

        return await self._transaction(operation)

    async def due_owners(self, limit: int = 4) -> list[str]:
        if not four_group_index_enabled():
            return []

        def operation(connection):
            cohort = connector_feature_owner_cohort("google_drive_live", "drive_four_group_index")
            if cohort == ():
                return []
            return list(
                connection.execute(
                    text("""
                    SELECT s.user_id FROM drive_group_index_state s
                    JOIN user_external_connector_connections c
                      ON c.user_id=s.user_id AND c.connector_id='google_drive'
                     AND c.connection_generation=s.connection_generation
                    LEFT JOIN drive_live_preferences p ON p.user_id=s.user_id
                    WHERE s.processing_enabled AND s.next_at<=clock_timestamp()
                      AND (s.lease_expires_at IS NULL OR s.lease_expires_at<=clock_timestamp())
                      AND c.status='connected' AND c.validation_state='verified'
                      AND (p.user_id IS NULL OR p.background_enabled)
                      AND (:all_owners OR c.user_id=ANY(CAST(:owners AS text[])))
                    ORDER BY s.next_at,s.user_id LIMIT :limit
                    """),
                    {
                        "limit": max(1, min(20, limit)),
                        "all_owners": cohort is None,
                        "owners": list(cohort or ()),
                    },
                ).scalars()
            )

        return await self._transaction(operation)

    async def claim(self, *, user_id: str) -> dict | None:
        self._require_flag(user_id)

        def operation(connection):
            current = self.live_active(connection, user_id=user_id)
            _, preference = self._processing(connection, user_id, current["connection_generation"])
            claimed = self._row(
                connection,
                """
                UPDATE drive_group_index_state SET lease_id=:lease,
                  lease_expires_at=clock_timestamp()+make_interval(secs=>:seconds),
                  attempt_count=attempt_count+1, updated_at=clock_timestamp()
                WHERE user_id=:user AND next_at<=clock_timestamp()
                  AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())
                RETURNING *
                """,
                {"user": user_id, "lease": str(uuid4()), "seconds": LEASE_SECONDS},
            )
            return {**claimed, "background_revision": preference["revision"]} if claimed else None

        return await self._content_transaction(user_id, operation)

    def _job(self, connection, job: dict) -> dict:
        self._require_flag(job["user_id"])
        row, preference = self._processing(
            connection, job["user_id"], job["connection_generation"], job["revision"]
        )
        if preference["revision"] != job["background_revision"]:
            raise DriveReadError("group_index_superseded")
        current = self._row(
            connection,
            """SELECT * FROM drive_group_index_state WHERE user_id=:user
               AND lease_id=:lease AND lease_expires_at>clock_timestamp() FOR UPDATE""",
            {"user": job["user_id"], "lease": str(job["lease_id"])},
        )
        if not current:
            raise DriveReadError("group_index_superseded")
        return current

    async def require_current(self, job: dict) -> None:
        self._require_flag(job["user_id"])
        await self._content_transaction(
            job["user_id"], lambda connection: self._job(connection, job)
        )

    async def renew(self, job: dict) -> None:
        """Extend only a live lease, rechecking every authority revision first."""
        self._require_flag(job["user_id"])

        def operation(connection):
            self._job(connection, job)
            connection.execute(
                text("""UPDATE drive_group_index_state
                  SET lease_expires_at=clock_timestamp()+make_interval(secs=>:seconds)
                  WHERE user_id=:user AND lease_id=:lease"""),
                {"user": job["user_id"], "lease": str(job["lease_id"]), "seconds": LEASE_SECONDS},
            )

        await self._transaction(operation)

    async def known(self, job: dict) -> dict[str, tuple[datetime, str, str, str | None]]:
        """Each indexed file's reference with the Drive modified time it was placed at and its source."""

        def operation(connection):
            self._job(connection, job)
            rows = connection.execute(
                text(
                    "SELECT source_ref,source_modified,group_source,model_version,source_version"
                    " FROM drive_group_index"
                    " WHERE user_id=:user"
                ),
                {"user": job["user_id"]},
            ).all()
            return {
                ref: (modified, source, model, version)
                for ref, modified, source, model, version in rows
            }

        return await self._content_transaction(job["user_id"], operation)

    def _params(self, job: dict, entry: GroupEntry) -> dict[str, Any]:
        user, generation = job["user_id"], job["connection_generation"]
        ref = self.sealer.ref(user, entry.file_id)
        placement = entry.placement
        if placement.shelf != KEPT:
            entry = replace(entry, head=None, vector=None)
        sealed = self.sealer.seal_entry(
            {
                "v": 1,
                "id": entry.file_id,
                "title": entry.title,
                "mime": entry.mime_type,
                "view": entry.view_url,
                "head": entry.head,
                "vec": base64.b64encode(_VECTOR.pack(*entry.vector)).decode()
                if entry.vector is not None
                else None,
            },
            user_id=user,
            ref=ref,
            generation=generation,
        )
        return {
            "user": user,
            "generation": generation,
            "ref": ref,
            "shelf": placement.shelf,
            "candidate": placement.candidate,
            "confidence": placement.confidence,
            "reason": placement.reason,
            "source": placement.group_source,
            "version": placement.version,
            "title_day": entry.title_day,
            "created": entry.created_time,
            "modified": entry.modified_time,
            "source_version": entry.source_version,
            "envelope": json.dumps(sealed),
        }

    async def commit(
        self,
        job: dict,
        entries: Sequence[GroupEntry],
        *,
        listed: int,
        complete: bool,
        limited: bool,
        keep: Collection[str] | None,
        more: bool,
    ) -> dict:
        """Upsert one batch and update the counters, only while the lease is still current.

        ``keep`` is the set of references present in a complete listing; every other
        row of this owner is a file that no longer exists and is removed.
        """
        self._require_flag(job["user_id"])
        if (
            len(entries) > MAX_BATCH
            or not 0 <= listed <= 10_000_000
            or keep is not None
            and (not complete or limited)
        ):
            raise DriveReadError("invalid_argument")
        unique = {self.sealer.ref(job["user_id"], entry.file_id): entry for entry in entries}

        def operation(connection):
            self._job(connection, job)
            # An owner's move wins over the aid, including its retention rule:
            # a file on an owner-placed shelf must not regain a kept text start.
            owner_shelves = dict(
                connection.execute(
                    text("""SELECT source_ref,shelf FROM drive_group_index
                  WHERE user_id=:user AND group_source='owner'
                  AND source_ref=ANY(CAST(:refs AS text[]))"""),
                    {"user": job["user_id"], "refs": list(unique)},
                ).all()
            )
            params = [
                self._params(
                    job,
                    replace(entry, head=None, vector=None)
                    if ref in owner_shelves and owner_shelves[ref] != KEPT
                    else entry,
                )
                for ref, entry in unique.items()
            ]
            version = params[0]["version"] if params else None
            if params:
                connection.execute(
                    text("""
                    INSERT INTO drive_group_index
                      (user_id,connection_generation,source_ref,shelf,candidate,confidence,reason,
                       group_source,model_version,title_day,created_time,modified_time,
                       source_modified,source_version,entry_envelope)
                    VALUES (:user,:generation,:ref,:shelf,:candidate,:confidence,:reason,:source,
                            :version,:title_day,:created,:modified,:modified,:source_version,
                            CAST(:envelope AS jsonb))
                    ON CONFLICT (user_id,source_ref) DO UPDATE SET
                      connection_generation=EXCLUDED.connection_generation,
                      shelf=CASE WHEN drive_group_index.group_source='owner'
                                 THEN drive_group_index.shelf ELSE EXCLUDED.shelf END,
                      candidate=CASE WHEN drive_group_index.group_source='owner'
                                     THEN drive_group_index.candidate ELSE EXCLUDED.candidate END,
                      confidence=CASE WHEN drive_group_index.group_source='owner'
                                      THEN drive_group_index.confidence ELSE EXCLUDED.confidence END,
                      reason=CASE WHEN drive_group_index.group_source='owner'
                                  THEN drive_group_index.reason ELSE EXCLUDED.reason END,
                      group_source=drive_group_index.group_source,
                      model_version=EXCLUDED.model_version,
                      title_day=EXCLUDED.title_day, created_time=EXCLUDED.created_time,
                      modified_time=EXCLUDED.modified_time,
                      source_modified=EXCLUDED.source_modified,
                      source_version=EXCLUDED.source_version,
                      entry_envelope=EXCLUDED.entry_envelope, updated_at=clock_timestamp()
                    """),
                    params,
                )
            pruned = 0
            if keep is not None:
                pruned = connection.execute(
                    text("""DELETE FROM drive_group_index WHERE user_id=:user
                            AND NOT (source_ref=ANY(CAST(:keep AS text[])))"""),
                    {"user": job["user_id"], "keep": list(keep)},
                ).rowcount
            connection.execute(
                text("""
                UPDATE drive_group_index_state SET listed_files=:listed, listing_complete=:complete,
                  limited=:limited, work_remaining=:more,
                  model_version=COALESCE(:version,model_version),
                  last_run_at=clock_timestamp(), last_error_code=NULL, attempt_count=0,
                  initial_completed_at=COALESCE(initial_completed_at,
                    CASE WHEN :complete AND NOT :more THEN clock_timestamp() END),
                  lease_id=NULL, lease_expires_at=NULL,
                  next_at=clock_timestamp()+make_interval(secs=>:delay),
                  updated_at=clock_timestamp()
                WHERE user_id=:user
                """),
                {
                    "user": job["user_id"],
                    "listed": listed,
                    "complete": complete,
                    "limited": limited,
                    "version": version,
                    "more": more,
                    "delay": 0 if more else 1800,
                },
            )
            counts = dict(
                connection.execute(
                    text(
                        "SELECT shelf,count(*) FROM drive_group_index WHERE user_id=:user GROUP BY shelf"
                    ),
                    {"user": job["user_id"]},
                ).all()
            )
            return {"written": len(params), "pruned": pruned, "counts": counts}

        result = await self._content_transaction(job["user_id"], operation)
        logger.info(
            "drive_group_index.commit written=%d pruned=%d indexed=%d kept=%d more=%d",
            result["written"],
            result["pruned"],
            sum(result["counts"].values()),
            result["counts"].get(KEPT, 0),
            int(more),
        )
        return result

    async def release(self, job: dict, *, code: str, delay_seconds: int = 300) -> None:
        """Give up a lease after a failure; a lease already lost is left alone."""

        def operation(connection):
            connection.execute(
                text("""
                UPDATE drive_group_index_state SET lease_id=NULL, lease_expires_at=NULL,
                  last_error_code=:code, next_at=clock_timestamp()+make_interval(secs=>:delay),
                  updated_at=clock_timestamp()
                WHERE user_id=:user AND lease_id=:lease
                """),
                {
                    "user": job["user_id"],
                    "lease": str(job["lease_id"]),
                    "code": code
                    if code.replace("_", "").isalpha() and len(code) <= 80
                    else "error",
                    "delay": max(0, min(86400, delay_seconds)),
                },
            )

        await self._transaction(operation)

    async def status(self, *, user_id: str) -> dict:
        self._require_flag(user_id)

        def operation(connection):
            self.live_active(connection, user_id=user_id, read_only=True)
            state = self._row(
                connection,
                "SELECT * FROM drive_group_index_state WHERE user_id=:user",
                {"user": user_id},
            )
            counts = dict(
                connection.execute(
                    text(
                        "SELECT shelf,count(*) FROM drive_group_index WHERE user_id=:user GROUP BY shelf"
                    ),
                    {"user": user_id},
                ).all()
            )
            preference = self._row(
                connection,
                "SELECT background_enabled FROM drive_live_preferences WHERE user_id=:user",
                {"user": user_id},
            )
            return state, counts, preference

        state, counts, preference = await self._content_transaction(user_id, operation)
        enabled = bool(state and state["processing_enabled"])
        if not enabled:
            phase = "off"
        elif preference is not None and preference["background_enabled"] is not True:
            phase = "paused"
        elif state["last_run_at"] and (
            state["limited"] or not state["listing_complete"] or state["last_error_code"]
        ):
            phase = "incomplete"
        elif state["work_remaining"] or state["initial_completed_at"] is None:
            phase = "indexing"
        else:
            phase = "incomplete" if state["last_error_code"] else "ready"
        return {
            "enabled": enabled,
            "state": phase,
            "revision": state["revision"] if state else 0,
            "timeZone": state["time_zone"] if state else "UTC",
            "listedFiles": state["listed_files"] if state else 0,
            "indexedFiles": sum(counts.values()),
            "counts": {shelf: counts.get(shelf, 0) for shelf in (*GROUP_IDS, KEPT)},
            "listingComplete": bool(state and state["listing_complete"]),
            "limited": bool(state and state["limited"]),
            "lastRunAt": _iso(state["last_run_at"]) if state else None,
            "modelVersion": state["model_version"] if state else None,
        }

    async def folders(self, *, user_id: str) -> list[dict]:
        self._require_flag(user_id)

        def operation(connection):
            self.live_active(connection, user_id=user_id, read_only=True)
            zone = self._row(
                connection,
                "SELECT time_zone FROM drive_group_index_state WHERE user_id=:user",
                {"user": user_id},
            )
            rows = connection.execute(
                text(
                    "SELECT shelf,title_day,created_time,modified_time FROM drive_group_index"
                    " WHERE user_id=:user"
                ),
                {"user": user_id},
            ).all()
            return zone["time_zone"] if zone else "UTC", rows

        zone, rows = await self._content_transaction(user_id, operation)
        summary = summarize_folders(
            [tuple(row) for row in rows], zone=_zone(zone), names=load_folders()
        )
        return [
            {
                "shelf": item.shelf,
                "name": item.name,
                "period": item.period,
                "fiscalYear": item.year,
                "fiscalQuarter": item.quarter,
                "count": item.count,
            }
            for item in summary
        ]

    async def files(
        self,
        *,
        user_id: str,
        shelf: str,
        period: str | None = None,
        cursor: int = 0,
        limit: int = 50,
    ) -> dict:
        """One page of a folder's files, newest first. Only the page is opened.

        ``period`` is None for every file on the shelf, "undated" for those with no
        usable date, or a quarter key such as "FY26-Q1".
        """
        self._require_flag(user_id)
        wanted = parse_period(period) if period not in (None, "undated") else None
        if (
            shelf not in (*GROUP_IDS, KEPT)
            or period is not None
            and period != "undated"
            and wanted is None
            or period is not None
            and shelf == KEPT
            or type(cursor) is not int
            or cursor < 0
            or type(limit) is not int
            or not 1 <= limit <= MAX_PAGE
        ):
            raise DriveReadError("invalid_argument")

        def operation(connection):
            self.live_active(connection, user_id=user_id, read_only=True)
            zone = self._row(
                connection,
                "SELECT time_zone FROM drive_group_index_state WHERE user_id=:user",
                {"user": user_id},
            )
            rows = (
                connection.execute(
                    text("SELECT * FROM drive_group_index WHERE user_id=:user AND shelf=:shelf"),
                    {"user": user_id, "shelf": shelf},
                )
                .mappings()
                .all()
            )
            return zone["time_zone"] if zone else "UTC", [dict(row) for row in rows]

        zone_name, rows = await self._content_transaction(user_id, operation)
        zone, start = _zone(zone_name), load_folders().fiscal_year_start_month
        dated = []
        for row in rows:
            day, basis = deciding_day(
                title=row["title_day"],
                created=row["created_time"],
                modified=row["modified_time"],
                zone=zone,
            )
            quarter = fiscal_quarter(day, start) if day is not None else None
            if period == "undated" and quarter is not None:
                continue
            if wanted is not None and (
                quarter is None or (quarter.year, quarter.quarter) != wanted
            ):
                continue
            dated.append((day, basis, row))
        dated.sort(
            key=lambda item: (
                item[0] is None,
                -(item[0].toordinal() if item[0] else 0),
                item[2]["source_ref"],
            )
        )
        items = []
        for day, basis, row in dated[cursor : cursor + limit]:
            entry = self.sealer.open_entry(row)
            items.append(
                {
                    "ref": row["source_ref"],
                    "title": entry.get("title"),
                    "mimeType": entry.get("mime"),
                    "viewUrl": entry.get("view"),
                    "day": day.isoformat() if day else None,
                    "dayBasis": basis,
                    "modifiedTime": _iso(row["modified_time"]),
                    "shelf": row["shelf"],
                    "candidate": row["candidate"],
                    "confidence": round(float(row["confidence"]), 4),
                    "reason": row["reason"],
                    "groupSource": row["group_source"],
                }
            )
        return {
            "items": items,
            "nextCursor": cursor + limit if cursor + limit < len(dated) else None,
            "total": len(dated),
        }

    async def erase(self, *, user_id: str) -> dict:
        """The owner's delete: every placed entry goes and the opt-in is withdrawn."""
        self._require_flag(user_id)

        def operation(connection):
            self.live_active(connection, user_id=user_id, management=True)
            removed = connection.execute(
                text("DELETE FROM drive_group_index WHERE user_id=:user"), {"user": user_id}
            ).rowcount
            connection.execute(
                text("""
                UPDATE drive_group_index_state SET processing_enabled=FALSE, disclosure_version=NULL,
                  revision=revision+1, lease_id=NULL, lease_expires_at=NULL, attempt_count=0,
                  last_error_code=NULL, listed_files=0, listing_complete=FALSE, limited=FALSE,
                  initial_completed_at=NULL, updated_at=clock_timestamp()
                WHERE user_id=:user
                """),
                {"user": user_id},
            )
            return {"removed": removed}

        return await self._transaction(operation)

"""The pod-local PKM write engine: SQLite, single-user, oracle-conformant.

WHAT THIS IS. The second implementation of :class:`PkmWriteEngine` -- the one a
pod runs, where the user's PKM lives inside their own runtime instead of the
hub's Postgres. It speaks the same operation surface, accepts the same
stored-procedure parameter dicts, and returns the same result shapes, because
the conformance oracle (``tests/pkm_conformance``) -- proven first against the
real plpgsql -- is the definition of correct.

WHY SQLITE IS THE RIGHT SUBSTRATE HERE, not a downgrade:

* The Postgres engine's advisory locks key on ``user_id || domain`` -- they
  never serialize across users. In a single-user pod, SQLite's WAL single-writer
  (acquired with ``BEGIN IMMEDIATE``) is STRICTLY stronger than that lock, and
  it holds file-wide across processes, so every writer path in the pod is
  serialized by construction.
* The hub's GIN indexes exist for N-user queries; the pod's ``pkm_index`` is
  one row. Full scans win.
* What must survive intact is the OPTIMISTIC-CONCURRENCY contract:
  ``p_expected_content_revision`` is the device-sync protocol, and losing it
  silently converts conflicts into last-write-wins data loss. It is preserved
  verbatim, and the oracle proves it.

The schema is loaded from ``db/offline_schema.sql`` -- the generated SQLite DDL
for the real tables -- so the store cannot drift from the shape the rest of the
codebase knows. JSON columns are TEXT holding JSON, exactly as that schema
declares.

DURABILITY BOUNDARY. This file is a local index and a correct single-node store.
Restart-surviving durability on an ephemeral-disk platform (Cloud Run,
CloudHub 2.0) is the commit log's job (``pod_storage``): the log is the system
of record, this database is rebuildable from it.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from hushh_mcp.services.pkm_write_engine import ENGINE_SQLITE

PKM_SQLITE_PATH_ENV = "PKM_SQLITE_PATH"

_SCHEMA = Path(__file__).resolve().parents[2] / "db" / "offline_schema.sql"

# plpgsql raises these as bare messages; the engine mirrors them so callers and
# the oracle see one vocabulary.
ERR_COMMIT_BINDING = "pkm_commit_id_binding_mismatch"
ERR_MIXED_REVISIONS = "mixed_pkm_domain_revisions"

_SCOPE_DEFAULTS = {
    "scope_label": "",
    "segment_ids": [],
    "sensitivity_tier": "standard",
    "scope_kind": "structured",
    "exposure_enabled": 0,
    "summary_projection": {},
    "visibility_posture": "private",
    "default_projection_ready": 0,
    "owner_consent_override": 0,
    "scope_origin": "structured",
    "scope_origin_code": "structured",
    "source_kind": "structured",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _plain(value: Any) -> Any:
    """Unwrap the service's JsonParam-style wrappers; pass everything else through."""
    return getattr(value, "value", value)


def _dumps(value: Any) -> str:
    return json.dumps(_plain(value) if _plain(value) is not None else None)


def _loads(value: Any, default: Any) -> Any:
    if value in (None, ""):
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


class SqlitePkmWriteEngine:
    """Single-user PKM data plane on SQLite. Every op is one IMMEDIATE transaction."""

    engine_id = ENGINE_SQLITE

    def __init__(self, path: str) -> None:
        if not str(path or "").strip():
            raise ValueError("a sqlite path is required; the engine never guesses one")
        self._path = str(path)
        self._ensure_schema()

    @classmethod
    def from_environment(cls) -> "SqlitePkmWriteEngine":
        path = (os.getenv(PKM_SQLITE_PATH_ENV) or "").strip()
        if not path:
            raise RuntimeError(
                f"{PKM_SQLITE_PATH_ENV} is not set -- which file holds the user's PKM "
                f"is never a question to answer by default"
            )
        return cls(path)

    # -- plumbing ---------------------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._path, timeout=30.0, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _ensure_schema(self) -> None:
        conn = self._connect()
        try:
            conn.executescript(_SCHEMA.read_text(encoding="utf-8"))
        finally:
            conn.close()

    async def _in_tx(self, work) -> Any:
        def _run() -> Any:
            conn = self._connect()
            try:
                # IMMEDIATE takes the write lock up front: the whole operation is
                # serialized against every other writer in the pod, which is the
                # property the advisory lock provided on Postgres -- and more.
                conn.execute("BEGIN IMMEDIATE")
                try:
                    result = work(conn)
                    conn.execute("COMMIT")
                    return result
                except BaseException:
                    conn.execute("ROLLBACK")
                    raise
            finally:
                conn.close()

        return await asyncio.to_thread(_run)

    # -- shared readers ---------------------------------------------------------------

    @staticmethod
    def _current_revisions(conn: sqlite3.Connection, user_id: str, domain: str) -> tuple[int, int]:
        """(content_revision, manifest_revision) of the live state; (0, 0) when empty."""
        row = conn.execute(
            "SELECT MAX(content_revision) AS c FROM pkm_blobs WHERE user_id=? AND domain=?",
            (user_id, domain),
        ).fetchone()
        content = int(row["c"]) if row and row["c"] is not None else 0
        manifest_row = conn.execute(
            "SELECT manifest_version FROM pkm_manifests WHERE user_id=? AND domain=?",
            (user_id, domain),
        ).fetchone()
        manifest = int(manifest_row["manifest_version"]) if manifest_row else 0
        return content, manifest

    @staticmethod
    def _ensure_index_row(conn: sqlite3.Connection, user_id: str, now: str) -> None:
        conn.execute(
            "INSERT INTO pkm_index (user_id, available_domains, domain_summaries, "
            "computed_tags, total_attributes, created_at, updated_at, model_version) "
            "VALUES (?, '[]', '{}', '[]', 0, ?, ?, 7) "
            "ON CONFLICT (user_id) DO NOTHING",
            (user_id, now, now),
        )

    def _archive_domain(
        self,
        conn: sqlite3.Connection,
        user_id: str,
        domain: str,
        *,
        reason: str,
        source_commit_id: Optional[str],
        now: str,
    ) -> Optional[str]:
        """Snapshot the live domain into pkm_domain_revisions. None when empty."""
        blobs = conn.execute(
            "SELECT * FROM pkm_blobs WHERE user_id=? AND domain=?", (user_id, domain)
        ).fetchall()
        if not blobs:
            return None
        content, manifest_version = self._current_revisions(conn, user_id, domain)
        manifest = conn.execute(
            "SELECT * FROM pkm_manifests WHERE user_id=? AND domain=?", (user_id, domain)
        ).fetchone()
        paths = conn.execute(
            "SELECT * FROM pkm_manifest_paths WHERE user_id=? AND domain=?", (user_id, domain)
        ).fetchall()
        scopes = conn.execute(
            "SELECT * FROM pkm_scope_registry WHERE user_id=? AND domain=?", (user_id, domain)
        ).fetchall()
        index_row = conn.execute(
            "SELECT domain_summaries FROM pkm_index WHERE user_id=?", (user_id,)
        ).fetchone()
        summaries = _loads(index_row["domain_summaries"] if index_row else None, {})

        revision_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO pkm_domain_revisions (revision_id, user_id, domain, "
            "source_content_revision, source_manifest_revision, is_origin, archive_reason, "
            "source_commit_id, manifest_snapshot, path_rows_snapshot, scope_rows_snapshot, "
            "index_domain_summary_snapshot, index_domain_present, restored_count, created_at) "
            "VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
            (
                revision_id,
                user_id,
                domain,
                content,
                manifest_version,
                reason,
                source_commit_id,
                json.dumps(dict(manifest) if manifest else None),
                json.dumps([dict(p) for p in paths]),
                json.dumps([dict(s) for s in scopes]),
                json.dumps(summaries.get(domain)),
                1 if domain in summaries else 0,
                now,
            ),
        )
        for blob in blobs:
            conn.execute(
                "INSERT INTO pkm_domain_revision_segments (revision_id, segment_id, "
                "ciphertext, iv, tag, algorithm, original_content_revision, "
                "original_manifest_revision, size_bytes, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    revision_id,
                    blob["segment_id"],
                    blob["ciphertext"],
                    blob["iv"],
                    blob["tag"],
                    blob["algorithm"],
                    blob["content_revision"],
                    blob["manifest_revision"],
                    blob["size_bytes"],
                    now,
                ),
            )
        return revision_id

    @staticmethod
    def _wipe_domain(conn: sqlite3.Connection, user_id: str, domain: str) -> None:
        # Literal statements rather than an interpolated table loop: nothing here
        # is ever built from input, and the scanner should be able to SEE that.
        conn.execute("DELETE FROM pkm_blobs WHERE user_id=? AND domain=?", (user_id, domain))
        conn.execute("DELETE FROM pkm_manifests WHERE user_id=? AND domain=?", (user_id, domain))
        conn.execute(
            "DELETE FROM pkm_manifest_paths WHERE user_id=? AND domain=?", (user_id, domain)
        )
        conn.execute(
            "DELETE FROM pkm_scope_registry WHERE user_id=? AND domain=?", (user_id, domain)
        )

    def _merge_summary(
        self,
        conn: sqlite3.Connection,
        user_id: str,
        domain: str,
        patch: dict,
        domains: list[str],
        now: str,
    ) -> None:
        self._ensure_index_row(conn, user_id, now)
        row = conn.execute(
            "SELECT available_domains, domain_summaries FROM pkm_index WHERE user_id=?",
            (user_id,),
        ).fetchone()
        available = _loads(row["available_domains"], [])
        summaries = _loads(row["domain_summaries"], {})
        if patch:
            # jsonb || semantics: a shallow, last-writer-wins merge at the top level.
            summaries[domain] = {**(summaries.get(domain) or {}), **patch}
        for entry in domains or []:
            if entry and entry not in available:
                available.append(entry)
        conn.execute(
            "UPDATE pkm_index SET available_domains=?, domain_summaries=?, updated_at=? "
            "WHERE user_id=?",
            (json.dumps(available), json.dumps(summaries), now, user_id),
        )

    @staticmethod
    def _append_event(
        conn: sqlite3.Connection,
        user_id: str,
        domain: str,
        operation: str,
        segment_ids: list[str],
        metadata: dict,
        now: str,
    ) -> None:
        conn.execute(
            "INSERT INTO pkm_events (user_id, domain, operation_type, segment_ids, "
            "path_set, metadata, created_at) VALUES (?, ?, ?, ?, '[]', ?, ?)",
            (
                user_id,
                domain,
                operation,
                json.dumps(sorted(segment_ids)),
                json.dumps(metadata),
                now,
            ),
        )

    # -- the five operations ----------------------------------------------------------

    async def commit_domain_mutation(self, params: dict[str, Any]) -> Any:
        user_id = str(_plain(params["p_user_id"]))
        domain = str(_plain(params["p_domain"]))
        expected = int(_plain(params["p_expected_content_revision"]))
        next_revision = int(_plain(params["p_next_content_revision"]))
        segment_rows = _plain(params.get("p_segment_rows")) or []
        manifest_row = _plain(params.get("p_manifest_row")) or {}
        path_rows = _plain(params.get("p_path_rows")) or []
        scope_rows = _plain(params.get("p_scope_rows")) or []
        summary_patch = _plain(params.get("p_summary_patch")) or {}
        event_rows = _plain(params.get("p_event_rows")) or []
        commit_id = str(_plain(params["p_commit_id"]))
        commit_kind = str(_plain(params.get("p_commit_kind")) or "mutation")
        fingerprint = _plain(params.get("p_request_fingerprint"))
        preservation = _plain(params.get("p_preservation_receipt")) or None

        def work(conn: sqlite3.Connection) -> dict:
            now = _now()
            prior = conn.execute(
                "SELECT * FROM pkm_domain_commits WHERE commit_id=?", (commit_id,)
            ).fetchone()
            if prior is not None:
                # An idempotency key binds ONE payload, from ONE owner, in ONE domain,
                # at ONE expected revision. Comparing the fingerprint alone was strictly
                # weaker than the Postgres oracle this engine has to match, which raises
                # `pkm_*_commit_binding_mismatch` when any of user_id, domain,
                # commit_kind or the expected revisions differ
                # (`db/migrations/098_pkm_v7_recovery_foundation.sql:1274-1284`).
                #
                # The lookup is by commit_id alone and always was, so a replay carrying a
                # DIFFERENT user_id fell straight through to the success return below:
                # it reported `success=True, idempotent_replay=True` for a write that
                # never happened, and skipped the `expected != current` check on the way
                # past — a fabricated success and an OCC bypass in one call. The
                # conformance suite never caught it because it only ever varies the
                # fingerprint for a single user, so the engine passed the oracle on the
                # one axis the oracle was asked about.
                if (
                    str(prior["user_id"]) != user_id
                    or str(prior["domain"]) != domain
                    or str(prior["commit_kind"]) != commit_kind
                    or int(prior["expected_content_revision"]) != expected
                    or (prior["request_fingerprint"] or None) != (fingerprint or None)
                ):
                    raise RuntimeError(ERR_COMMIT_BINDING)
                return {
                    "success": True,
                    "conflict": False,
                    "commit_id": commit_id,
                    "data_version": int(prior["result_content_revision"]),
                    "idempotent_replay": True,
                    "manifest_revision": int(prior["result_manifest_revision"]),
                    "archived_revision_id": prior["archived_revision_id"],
                }

            current, current_manifest = self._current_revisions(conn, user_id, domain)
            if expected != current:
                return {
                    "success": False,
                    "conflict": True,
                    "data_version": current,
                    "manifest_revision": current_manifest,
                }

            archived = self._archive_domain(
                conn, user_id, domain, reason=commit_kind, source_commit_id=commit_id, now=now
            )
            self._wipe_domain(conn, user_id, domain)

            manifest_version = int(manifest_row.get("manifest_version") or next_revision)
            for row in segment_rows:
                conn.execute(
                    "INSERT INTO pkm_blobs (user_id, domain, segment_id, ciphertext, iv, "
                    "tag, algorithm, content_revision, manifest_revision, size_bytes, "
                    "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        user_id,
                        domain,
                        row["segment_id"],
                        row["ciphertext"],
                        row["iv"],
                        row["tag"],
                        row.get("algorithm") or "aes-256-gcm",
                        next_revision,
                        int(row.get("manifest_revision") or manifest_version),
                        int(row.get("size_bytes") or 0),
                        now,
                        now,
                    ),
                )
            conn.execute(
                "INSERT INTO pkm_manifests (user_id, domain, manifest_version, "
                "structure_decision, summary_projection, top_level_scope_paths, "
                "externalizable_paths, segment_ids, path_count, externalizable_path_count, "
                "last_structured_at, last_content_at, created_at, updated_at, "
                "domain_contract_version, readable_summary_version, pkm_contract_version, "
                "readable_projection_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                "?, ?, ?, ?, ?)",
                (
                    user_id,
                    domain,
                    manifest_version,
                    _dumps(manifest_row.get("structure_decision") or {}),
                    _dumps(manifest_row.get("summary_projection") or {}),
                    _dumps(manifest_row.get("top_level_scope_paths") or []),
                    _dumps(manifest_row.get("externalizable_paths") or []),
                    _dumps(manifest_row.get("segment_ids") or []),
                    int(manifest_row.get("path_count") or 0),
                    int(manifest_row.get("externalizable_path_count") or 0),
                    str(manifest_row.get("last_structured_at") or now),
                    str(manifest_row.get("last_content_at") or now),
                    now,
                    now,
                    int(manifest_row.get("domain_contract_version") or 0),
                    int(manifest_row.get("readable_summary_version") or 0),
                    str(manifest_row.get("pkm_contract_version") or "0.0.0"),
                    str(manifest_row.get("readable_projection_version") or "0.0.0"),
                ),
            )
            for row in path_rows:
                conn.execute(
                    "INSERT INTO pkm_manifest_paths (user_id, domain, json_path, parent_path, "
                    "path_type, segment_id, scope_handle, exposure_eligibility, consent_label, "
                    "sensitivity_label, source_agent, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        user_id,
                        domain,
                        row.get("json_path"),
                        row.get("parent_path"),
                        row.get("path_type") or "attribute",
                        row.get("segment_id") or "root",
                        row.get("scope_handle"),
                        1 if row.get("exposure_eligibility") else 0,
                        row.get("consent_label"),
                        row.get("sensitivity_label"),
                        row.get("source_agent"),
                        now,
                        now,
                    ),
                )
            for row in scope_rows:
                merged = {**_SCOPE_DEFAULTS, **{k: v for k, v in row.items() if v is not None}}
                conn.execute(
                    "INSERT INTO pkm_scope_registry (user_id, domain, scope_handle, "
                    "scope_label, segment_ids, sensitivity_tier, scope_kind, exposure_enabled, "
                    "manifest_version, summary_projection, created_at, updated_at, "
                    "visibility_posture, default_projection_ready, owner_consent_override, "
                    "scope_origin, scope_origin_code, source_kind) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        user_id,
                        domain,
                        merged.get("scope_handle"),
                        merged["scope_label"],
                        _dumps(merged["segment_ids"]),
                        merged["sensitivity_tier"],
                        merged["scope_kind"],
                        1 if merged["exposure_enabled"] else 0,
                        manifest_version,
                        _dumps(merged["summary_projection"]),
                        now,
                        now,
                        merged["visibility_posture"],
                        1 if merged["default_projection_ready"] else 0,
                        1 if merged["owner_consent_override"] else 0,
                        merged["scope_origin"],
                        merged["scope_origin_code"],
                        merged["source_kind"],
                    ),
                )
            for row in event_rows:
                self._append_event(
                    conn,
                    user_id,
                    domain,
                    str(row.get("operation_type") or "upsert"),
                    [str(s) for s in row.get("segment_ids") or []],
                    row.get("metadata") or {},
                    now,
                )
            self._merge_summary(conn, user_id, domain, dict(summary_patch), [domain], now)
            conn.execute(
                "INSERT INTO pkm_domain_commits (commit_id, user_id, domain, commit_kind, "
                "request_fingerprint, expected_content_revision, expected_manifest_revision, "
                "result_content_revision, result_manifest_revision, archived_revision_id, "
                "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    commit_id,
                    user_id,
                    domain,
                    commit_kind,
                    fingerprint,
                    expected,
                    current_manifest,
                    next_revision,
                    manifest_version,
                    archived,
                    now,
                ),
            )
            return {
                "success": True,
                "conflict": False,
                "commit_id": commit_id,
                "updated_at": now,
                "data_version": next_revision,
                "idempotent_replay": False,
                "manifest_revision": manifest_version,
                "archived_revision_id": archived,
                "preservation_receipt": preservation if preservation else None,
            }

        return await self._in_tx(work)

    async def merge_domain_summary(self, params: dict[str, Any]) -> Any:
        user_id = str(_plain(params["p_user_id"]))
        domain = str(_plain(params["p_domain"]))
        patch = _plain(params.get("p_patch")) or {}
        domains = [str(d) for d in _plain(params.get("p_domains_list")) or []]

        def work(conn: sqlite3.Connection) -> Any:
            self._merge_summary(conn, user_id, domain, dict(patch), domains, _now())
            return True

        return await self._in_tx(work)

    async def get_domain_snapshot(self, params: dict[str, Any]) -> Any:
        user_id = str(_plain(params["p_user_id"]))
        domain = str(_plain(params["p_domain"]))
        wanted = [str(s) for s in _plain(params.get("p_segment_ids")) or []]

        def work(conn: sqlite3.Connection) -> dict:
            query = "SELECT * FROM pkm_blobs WHERE user_id=? AND domain=?"
            args: list[Any] = [user_id, domain]
            if wanted:
                query += f" AND segment_id IN ({','.join('?' for _ in wanted)})"
                args.extend(wanted)
            blobs = conn.execute(query, args).fetchall()

            base = {
                "user_id": user_id,
                "domain": domain,
                "storage_mode": "segmented",
                "schema_version": "pkm.v7",
            }
            if not blobs:
                return {
                    **base,
                    "segments": None,
                    "segment_ids": [],
                    "manifest": None,
                    "paths": [],
                    "scopes": [],
                    "content_revision": None,
                    "manifest_revision": None,
                    "updated_at": None,
                    "etag": None,
                }

            revisions = {int(b["content_revision"]) for b in blobs}
            if len(revisions) > 1:
                # Two segments from different revisions is a torn read; refusing it
                # is the whole point of revisioned segments.
                raise RuntimeError(ERR_MIXED_REVISIONS)
            content_revision = revisions.pop()

            manifest_row = conn.execute(
                "SELECT * FROM pkm_manifests WHERE user_id=? AND domain=?", (user_id, domain)
            ).fetchone()
            manifest = None
            if manifest_row is not None:
                manifest = dict(manifest_row)
                for key in (
                    "structure_decision",
                    "summary_projection",
                    "top_level_scope_paths",
                    "externalizable_paths",
                    "segment_ids",
                ):
                    manifest[key] = _loads(manifest.get(key), None)
            if manifest is not None and int(manifest.get("manifest_version") or 0) != max(
                int(b["manifest_revision"]) for b in blobs
            ):
                raise RuntimeError(ERR_MIXED_REVISIONS)

            paths = [
                dict(p)
                for p in conn.execute(
                    "SELECT * FROM pkm_manifest_paths WHERE user_id=? AND domain=?",
                    (user_id, domain),
                ).fetchall()
            ]
            scopes = [
                dict(s)
                for s in conn.execute(
                    "SELECT * FROM pkm_scope_registry WHERE user_id=? AND domain=?",
                    (user_id, domain),
                ).fetchall()
            ]
            updated_at = max(str(b["updated_at"]) for b in blobs)
            etag = hashlib.sha256(
                f"{user_id}|{domain}|{content_revision}|{updated_at}".encode()
            ).hexdigest()
            return {
                **base,
                "segments": {
                    b["segment_id"]: {
                        "ciphertext": b["ciphertext"],
                        "iv": b["iv"],
                        "tag": b["tag"],
                        "algorithm": b["algorithm"],
                    }
                    for b in blobs
                },
                "segment_ids": sorted(b["segment_id"] for b in blobs),
                "manifest": manifest,
                "paths": paths,
                "scopes": scopes,
                "content_revision": content_revision,
                "manifest_revision": max(int(b["manifest_revision"]) for b in blobs),
                "updated_at": updated_at,
                "etag": etag,
            }

        return await self._in_tx(work)

    async def delete_domain(self, params: dict[str, Any]) -> Any:
        user_id = str(_plain(params["p_user_id"]))
        domain = str(_plain(params["p_domain"]))
        expected = int(_plain(params["p_expected_content_revision"]))

        def work(conn: sqlite3.Connection) -> dict:
            now = _now()
            current, _ = self._current_revisions(conn, user_id, domain)
            if expected != current:
                return {
                    "deleted": False,
                    "success": False,
                    "conflict": True,
                    "data_version": current,
                }
            self._archive_domain(
                conn, user_id, domain, reason="domain_delete", source_commit_id=None, now=now
            )
            self._wipe_domain(conn, user_id, domain)
            self._drop_from_index(conn, user_id, domain, now)
            self._append_event(conn, user_id, domain, "domain_delete", [], {}, now)
            return {
                "deleted": True,
                "success": True,
                "conflict": False,
                "updated_at": now,
                "data_version": current + 1,
                "idempotent_replay": False,
            }

        return await self._in_tx(work)

    async def delete_domain_legacy(self, params: dict[str, Any]) -> Any:
        user_id = str(_plain(params["p_user_id"]))
        domain = str(_plain(params["p_domain"]))

        def work(conn: sqlite3.Connection) -> bool:
            now = _now()
            self._wipe_domain(conn, user_id, domain)
            self._drop_from_index(conn, user_id, domain, now)
            return True

        return await self._in_tx(work)

    def _drop_from_index(
        self, conn: sqlite3.Connection, user_id: str, domain: str, now: str
    ) -> None:
        row = conn.execute(
            "SELECT available_domains, domain_summaries FROM pkm_index WHERE user_id=?",
            (user_id,),
        ).fetchone()
        if row is None:
            return
        available = [d for d in _loads(row["available_domains"], []) if d != domain]
        summaries = _loads(row["domain_summaries"], {})
        summaries.pop(domain, None)
        conn.execute(
            "UPDATE pkm_index SET available_domains=?, domain_summaries=?, updated_at=? "
            "WHERE user_id=?",
            (json.dumps(available), json.dumps(summaries), now, user_id),
        )

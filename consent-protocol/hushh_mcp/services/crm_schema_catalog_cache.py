"""Postgres-backed cache for normalized, non-record CRM schema metadata."""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from db.db_client import DatabaseExecutionError, get_db

logger = logging.getLogger(__name__)

FRESH_TTL = timedelta(hours=24)
STALE_TTL = timedelta(days=7)


def schema_fingerprint(schema: dict[str, Any]) -> str:
    material = {
        "objectType": schema.get("objectType"),
        "objectMetadata": schema.get("objectMetadata") or {},
        "fields": schema.get("fields") or [],
    }
    encoded = json.dumps(material, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _as_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


class CrmSchemaCatalogCache:
    """Best-effort cache seam; cache failure never invents connector authority."""

    def __init__(self, db: Any | None = None):
        self._db = db

    @property
    def db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    def get(
        self, *, crm_id: str, object_type: str, configuration_revision: int
    ) -> dict[str, Any] | None:
        try:
            rows = self.db.execute_raw(
                """
                SELECT schema_fingerprint, schema_json, refreshed_at, fresh_until, stale_until
                FROM crm_schema_catalog_cache
                WHERE crm_id = :crm_id
                  AND object_type = :object_type
                  AND configuration_revision = :configuration_revision
                ORDER BY refreshed_at DESC
                LIMIT 1
                """,
                {
                    "crm_id": crm_id,
                    "object_type": object_type,
                    "configuration_revision": configuration_revision,
                },
            ).data
        except DatabaseExecutionError:
            logger.info("crm_schema_catalog_cache.read_unavailable crm_id=%s", crm_id)
            return None
        if not rows:
            return None
        row = rows[0]
        now = datetime.now(timezone.utc)
        stale_until = _as_datetime(row.get("stale_until"))
        if stale_until is None or now > stale_until:
            return None
        schema = row.get("schema_json")
        if isinstance(schema, str):
            try:
                schema = json.loads(schema)
            except json.JSONDecodeError:
                return None
        if not isinstance(schema, dict):
            return None
        fresh_until = _as_datetime(row.get("fresh_until"))
        refreshed_at = _as_datetime(row.get("refreshed_at"))
        return {
            "schema": dict(schema),
            "schemaFingerprint": str(row.get("schema_fingerprint") or ""),
            "freshness": "fresh" if fresh_until and now <= fresh_until else "stale",
            "refreshedAt": refreshed_at.isoformat() if refreshed_at else None,
        }

    def put(
        self,
        *,
        crm_id: str,
        object_type: str,
        configuration_revision: int,
        schema: dict[str, Any],
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        fingerprint = schema_fingerprint(schema)
        try:
            self.db.execute_raw(
                """
                INSERT INTO crm_schema_catalog_cache (
                  crm_id, object_type, configuration_revision, schema_fingerprint,
                  schema_json, refreshed_at, fresh_until, stale_until
                ) VALUES (
                  :crm_id, :object_type, :configuration_revision, :schema_fingerprint,
                  :schema_json, :refreshed_at, :fresh_until, :stale_until
                )
                ON CONFLICT (crm_id, object_type, configuration_revision, schema_fingerprint)
                DO UPDATE SET
                  schema_json = EXCLUDED.schema_json,
                  refreshed_at = EXCLUDED.refreshed_at,
                  fresh_until = EXCLUDED.fresh_until,
                  stale_until = EXCLUDED.stale_until
                """,
                {
                    "crm_id": crm_id,
                    "object_type": object_type,
                    "configuration_revision": configuration_revision,
                    "schema_fingerprint": fingerprint,
                    "schema_json": schema,
                    "refreshed_at": now,
                    "fresh_until": now + FRESH_TTL,
                    "stale_until": now + STALE_TTL,
                },
            )
        except DatabaseExecutionError:
            logger.info("crm_schema_catalog_cache.write_unavailable crm_id=%s", crm_id)
        return {
            "schemaFingerprint": fingerprint,
            "freshness": "fresh",
            "refreshedAt": now.isoformat(),
        }

    def invalidate(self, *, crm_id: str) -> None:
        try:
            self.db.execute_raw(
                "DELETE FROM crm_schema_catalog_cache WHERE crm_id = :crm_id",
                {"crm_id": crm_id},
            )
        except DatabaseExecutionError:
            logger.info("crm_schema_catalog_cache.invalidate_unavailable crm_id=%s", crm_id)


class InMemoryCrmSchemaCatalogCache:
    """Deterministic test seam with the same safe metadata shape."""

    def __init__(self):
        self.entries: dict[tuple[str, str, int], dict[str, Any]] = {}

    def get(
        self, *, crm_id: str, object_type: str, configuration_revision: int
    ) -> dict[str, Any] | None:
        entry = self.entries.get((crm_id, object_type, configuration_revision))
        return dict(entry) if entry else None

    def put(
        self,
        *,
        crm_id: str,
        object_type: str,
        configuration_revision: int,
        schema: dict[str, Any],
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        fingerprint = schema_fingerprint(schema)
        self.entries[(crm_id, object_type, configuration_revision)] = {
            "schema": dict(schema),
            "schemaFingerprint": fingerprint,
            "freshness": "fresh",
            "refreshedAt": now,
        }
        return {
            "schemaFingerprint": fingerprint,
            "freshness": "fresh",
            "refreshedAt": now,
        }

    def invalidate(self, *, crm_id: str) -> None:
        self.entries = {key: value for key, value in self.entries.items() if key[0] != crm_id}


_cache: CrmSchemaCatalogCache | None = None


def get_crm_schema_catalog_cache() -> CrmSchemaCatalogCache:
    global _cache
    if _cache is None:
        _cache = CrmSchemaCatalogCache()
    return _cache

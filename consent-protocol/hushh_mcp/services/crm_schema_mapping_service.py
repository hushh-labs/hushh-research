"""Cached, manifest-owned CRM schema mapping for Connected Systems.

The model sees public CRM schema metadata only. It has no CRM transport,
record, identity, consent, vault, or persistence authority. Persistence stays
behind this repository so the current Postgres implementation can later move
to Redis without changing the mapping contract.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Protocol

from db.db_client import DatabaseExecutionError, get_db
from hushh_mcp.hushh_adk.manifest import AgentSubagentConfig, ManifestLoader
from hushh_mcp.runtime_providers import build_managed_runtime_client

logger = logging.getLogger(__name__)

CRM_SCHEMA_MAPPER_ID = "crm_schema_mapper"
CRM_SCHEMA_MAPPER_ENABLED_ENV = "CONNECTED_SYSTEMS_SCHEMA_MAPPER_ENABLED"
CRM_SCHEMA_MAPPING_TTL = timedelta(hours=24)
_SEMANTICS = ("email", "phone", "firstName", "lastName", "fullName", "address")
_REQUIRED_SEMANTICS = ("email", "phone")


class CrmSchemaMappingError(RuntimeError):
    """Safe failure state for public-schema mapping only."""

    code = "CONNECTED_SYSTEM_SCHEMA_MAPPING_UNAVAILABLE"


@dataclass(frozen=True)
class CrmSchemaMapping:
    mapping: dict[str, str]
    schema_fingerprint: str
    model_name: str
    source: str


class CrmSchemaMappingStore(Protocol):
    def get(
        self, *, crm_id: str, object_type: str, schema_fingerprint: str, model_name: str
    ) -> CrmSchemaMapping | None: ...

    def put(
        self,
        *,
        crm_id: str,
        object_type: str,
        schema_fingerprint: str,
        model_name: str,
        mapping: dict[str, str],
    ) -> None: ...

    def invalidate(self, *, crm_id: str, object_type: str) -> None: ...


class InMemoryCrmSchemaMappingStore:
    """Test-only cache. Production uses Postgres through the same seam."""

    def __init__(self) -> None:
        self.entries: dict[tuple[str, str, str, str], CrmSchemaMapping] = {}

    def get(
        self, *, crm_id: str, object_type: str, schema_fingerprint: str, model_name: str
    ) -> CrmSchemaMapping | None:
        cached = self.entries.get((crm_id, object_type, schema_fingerprint, model_name))
        if cached is None:
            return None
        return CrmSchemaMapping(
            mapping=dict(cached.mapping),
            schema_fingerprint=cached.schema_fingerprint,
            model_name=cached.model_name,
            source="cache",
        )

    def put(
        self,
        *,
        crm_id: str,
        object_type: str,
        schema_fingerprint: str,
        model_name: str,
        mapping: dict[str, str],
    ) -> None:
        self.entries[(crm_id, object_type, schema_fingerprint, model_name)] = CrmSchemaMapping(
            mapping=dict(mapping),
            schema_fingerprint=schema_fingerprint,
            model_name=model_name,
            source="fresh",
        )

    def invalidate(self, *, crm_id: str, object_type: str) -> None:
        self.entries = {
            key: value for key, value in self.entries.items() if key[:2] != (crm_id, object_type)
        }


class DatabaseCrmSchemaMappingStore:
    """Postgres cache repository; no record values or model prompts are stored.

    Redis/Memorystore can replace this implementation later without changing
    ``CrmSchemaMappingStore`` or the API contract.
    """

    def __init__(self, db: Any | None = None) -> None:
        self._db = db

    @property
    def db(self) -> Any:
        if self._db is None:
            self._db = get_db()
        return self._db

    def get(
        self, *, crm_id: str, object_type: str, schema_fingerprint: str, model_name: str
    ) -> CrmSchemaMapping | None:
        try:
            rows = self.db.execute_raw(
                """
                SELECT mapping_json
                FROM crm_schema_mapping_cache
                WHERE crm_id = :crm_id
                  AND object_type = :object_type
                  AND schema_fingerprint = :schema_fingerprint
                  AND model_name = :model_name
                  AND status = 'ready'
                  AND expires_at > NOW()
                LIMIT 1
                """,
                {
                    "crm_id": crm_id,
                    "object_type": object_type,
                    "schema_fingerprint": schema_fingerprint,
                    "model_name": model_name,
                },
            ).data
        except DatabaseExecutionError as error:
            raise CrmSchemaMappingError("CRM schema mapping storage is unavailable.") from error
        if not rows:
            return None
        raw_mapping = rows[0].get("mapping_json") if isinstance(rows[0], dict) else {}
        mapping = raw_mapping if isinstance(raw_mapping, dict) else {}
        normalized = {
            semantic: str(value)
            for semantic, value in mapping.items()
            if semantic in _SEMANTICS and isinstance(value, str) and value.strip()
        }
        return CrmSchemaMapping(
            mapping=normalized,
            schema_fingerprint=schema_fingerprint,
            model_name=model_name,
            source="cache",
        )

    def put(
        self,
        *,
        crm_id: str,
        object_type: str,
        schema_fingerprint: str,
        model_name: str,
        mapping: dict[str, str],
    ) -> None:
        expires_at = datetime.now(timezone.utc) + CRM_SCHEMA_MAPPING_TTL
        try:
            self.db.execute_raw(
                """
                INSERT INTO crm_schema_mapping_cache (
                  crm_id, object_type, schema_fingerprint, model_name,
                  status, mapping_json, expires_at, refreshed_at
                ) VALUES (
                  :crm_id, :object_type, :schema_fingerprint, :model_name,
                  'ready', CAST(:mapping_json AS jsonb), :expires_at, NOW()
                )
                ON CONFLICT (crm_id, object_type, schema_fingerprint, model_name)
                DO UPDATE SET
                  status = 'ready',
                  mapping_json = EXCLUDED.mapping_json,
                  expires_at = EXCLUDED.expires_at,
                  refreshed_at = NOW(),
                  failure_code = NULL
                """,
                {
                    "crm_id": crm_id,
                    "object_type": object_type,
                    "schema_fingerprint": schema_fingerprint,
                    "model_name": model_name,
                    "mapping_json": json.dumps(mapping, sort_keys=True),
                    "expires_at": expires_at,
                },
            )
        except DatabaseExecutionError as error:
            raise CrmSchemaMappingError("CRM schema mapping storage is unavailable.") from error

    def invalidate(self, *, crm_id: str, object_type: str) -> None:
        try:
            self.db.execute_raw(
                """
                UPDATE crm_schema_mapping_cache
                SET status = 'invalidated', expires_at = NOW(), refreshed_at = NOW()
                WHERE crm_id = :crm_id AND object_type = :object_type AND status = 'ready'
                """,
                {"crm_id": crm_id, "object_type": object_type},
            )
        except DatabaseExecutionError as error:
            raise CrmSchemaMappingError("CRM schema mapping storage is unavailable.") from error


class CrmSchemaMapper(Protocol):
    @property
    def model_name(self) -> str: ...

    async def map_schema(self, schema_projection: dict[str, Any]) -> dict[str, Any] | None: ...


def _manifest_child() -> AgentSubagentConfig:
    manifest_path = (
        Path(__file__).resolve().parents[1] / "agents" / "connected_systems" / "agent.yaml"
    )
    manifest = ManifestLoader.load(str(manifest_path))
    child = next((item for item in manifest.subagents if item.id == CRM_SCHEMA_MAPPER_ID), None)
    if child is None:
        raise CrmSchemaMappingError("CRM schema mapper is not declared in the agent manifest.")
    if child.runtime.adk_mode != "single_turn" or child.runtime.transport != ["in_process"]:
        raise CrmSchemaMappingError("CRM schema mapper manifest has an invalid runtime boundary.")
    if child.privacy.plaintext_telemetry:
        raise CrmSchemaMappingError(
            "CRM schema mapper manifest does not permit plaintext telemetry."
        )
    return child


class GeminiCrmSchemaMapper:
    """One manifest-owned, tool-less Gemini call over schema metadata only."""

    def __init__(self, *, client_factory=build_managed_runtime_client) -> None:
        self._child = _manifest_child()
        self._client_factory = client_factory
        self._client: Any | None = None

    @property
    def model_name(self) -> str:
        return self._child.model.name

    def _client_for_call(self) -> Any:
        if self._client is None:
            self._client = self._client_factory(self._child.model.provider)
        return self._client

    async def map_schema(self, schema_projection: dict[str, Any]) -> dict[str, Any] | None:
        try:
            from google.genai import types
        except ImportError as error:  # pragma: no cover - environment guard
            raise CrmSchemaMappingError(
                "CRM schema mapper is unavailable in this environment."
            ) from error

        allowed_keys = [field["key"] for field in schema_projection["fields"]]
        slot_schema = {
            "type": "OBJECT",
            "nullable": True,
            "properties": {
                "fieldKey": {"type": "STRING", "enum": allowed_keys, "nullable": True},
                "confidence": {"type": "NUMBER"},
                "reason": {"type": "STRING"},
            },
            "required": ["fieldKey", "confidence", "reason"],
        }
        response_schema = {
            "type": "OBJECT",
            "properties": {
                "mappings": {
                    "type": "OBJECT",
                    "properties": {semantic: slot_schema for semantic in _SEMANTICS},
                    "required": list(_SEMANTICS),
                }
            },
            "required": ["mappings"],
        }
        prompt = (
            f"{self._child.system_instruction}\n\n"
            "Public CRM schema metadata follows. Return JSON only.\n"
            f"{json.dumps(schema_projection, sort_keys=True, separators=(',', ':'))}"
        )
        config = types.GenerateContentConfig(
            temperature=0,
            max_output_tokens=self._child.performance.max_output_tokens,
            response_mime_type="application/json",
            response_schema=response_schema,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )
        try:
            response = await asyncio.wait_for(
                self._client_for_call().aio.models.generate_content(
                    model=self.model_name,
                    contents=prompt,
                    config=config,
                ),
                timeout=self._child.performance.latency_p95_ms / 1000,
            )
        except Exception as error:  # never surface provider internals or prompt content
            logger.warning(
                "agent.connected_systems.crm_schema_mapper.failed error=%s", type(error).__name__
            )
            return None
        parsed = getattr(response, "parsed", None)
        if isinstance(parsed, dict):
            return parsed
        try:
            candidate = json.loads(str(getattr(response, "text", "") or ""))
        except json.JSONDecodeError:
            return None
        return candidate if isinstance(candidate, dict) else None


def _schema_projection(schema: dict[str, Any]) -> dict[str, Any]:
    fields: list[dict[str, Any]] = []
    for raw in schema.get("fields") or []:
        if not isinstance(raw, dict):
            continue
        key = str(raw.get("key") or "").strip()
        if not key:
            continue
        fields.append(
            {
                "key": key,
                "label": str(raw.get("label") or key),
                "type": str(raw.get("dataType") or "string"),
                "required": raw.get("required") is True,
                "constraints": raw.get("constraints")
                if isinstance(raw.get("constraints"), dict)
                else {},
                # Explicit denies are relevant to validating a safe create
                # map. Omitted access metadata remains unknown, never assumed.
                "createable": raw.get("createable"),
                "immutable": raw.get("immutable"),
            }
        )
    return {
        "object": {
            "name": str(schema.get("objectType") or ""),
            "label": str((schema.get("objectMetadata") or {}).get("label") or ""),
        },
        "fields": fields,
    }


def _fingerprint(projection: dict[str, Any]) -> str:
    serialized = json.dumps(projection, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _validate_mapping(raw: dict[str, Any] | None, fields: list[dict[str, Any]]) -> dict[str, str]:
    if not isinstance(raw, dict) or not isinstance(raw.get("mappings"), dict):
        raise CrmSchemaMappingError("CRM schema mapper returned no usable mapping.")
    allowed = {str(field["key"]): field for field in fields}
    mapping: dict[str, str] = {}
    for semantic in _SEMANTICS:
        candidate = raw["mappings"].get(semantic)
        if candidate is None:
            continue
        if not isinstance(candidate, dict):
            raise CrmSchemaMappingError("CRM schema mapper returned an invalid mapping.")
        key = str(candidate.get("fieldKey") or "").strip()
        confidence = candidate.get("confidence")
        reason = str(candidate.get("reason") or "").strip()
        if not key:
            continue
        if (
            key not in allowed
            or not isinstance(confidence, (int, float))
            or not 0 <= confidence <= 1
        ):
            raise CrmSchemaMappingError("CRM schema mapper proposed an invalid field.")
        if not reason or len(reason) > 240:
            raise CrmSchemaMappingError("CRM schema mapper returned an invalid mapping reason.")
        field = allowed[key]
        if field.get("immutable") is True or field.get("createable") is False:
            raise CrmSchemaMappingError(
                "CRM schema mapper selected a field unavailable for onboarding."
            )
        mapping[semantic] = key
    if any(semantic not in mapping for semantic in _REQUIRED_SEMANTICS):
        raise CrmSchemaMappingError(
            "This CRM schema could not map verified email and phone fields."
        )
    if not ((mapping.get("firstName") and mapping.get("lastName")) or mapping.get("fullName")):
        raise CrmSchemaMappingError("This CRM schema could not map a usable name field.")
    return mapping


class CrmSchemaMappingService:
    def __init__(
        self,
        *,
        store: CrmSchemaMappingStore | None = None,
        mapper: CrmSchemaMapper | None = None,
    ) -> None:
        self.store = store or DatabaseCrmSchemaMappingStore()
        self.mapper = mapper or GeminiCrmSchemaMapper()

    async def resolve(
        self, *, crm_id: str, schema: dict[str, Any], force_refresh: bool = False
    ) -> CrmSchemaMapping:
        if os.getenv(CRM_SCHEMA_MAPPER_ENABLED_ENV, "true").strip().lower() in {
            "0",
            "false",
            "no",
            "off",
        }:
            raise CrmSchemaMappingError("CRM schema mapping is temporarily unavailable.")
        object_type = str(schema.get("objectType") or "").strip()
        projection = _schema_projection(schema)
        if not object_type or not projection["fields"]:
            raise CrmSchemaMappingError(
                "The connected system did not return a usable primary-object schema."
            )
        schema_fingerprint = _fingerprint(projection)
        if not force_refresh:
            cached = self.store.get(
                crm_id=crm_id,
                object_type=object_type,
                schema_fingerprint=schema_fingerprint,
                model_name=self.mapper.model_name,
            )
            if cached is not None:
                return cached
        raw = await self.mapper.map_schema(projection)
        mapping = _validate_mapping(raw, projection["fields"])
        self.store.put(
            crm_id=crm_id,
            object_type=object_type,
            schema_fingerprint=schema_fingerprint,
            model_name=self.mapper.model_name,
            mapping=mapping,
        )
        logger.info(
            "agent.connected_systems.crm_schema_mapper.completed crm_id=%s object_type=%s cache=%s",
            crm_id,
            object_type,
            False,
        )
        return CrmSchemaMapping(
            mapping=mapping,
            schema_fingerprint=schema_fingerprint,
            model_name=self.mapper.model_name,
            source="fresh",
        )

    def invalidate(self, *, crm_id: str, object_type: str) -> None:
        self.store.invalidate(crm_id=crm_id, object_type=object_type)


_service: CrmSchemaMappingService | None = None


def get_crm_schema_mapping_service() -> CrmSchemaMappingService:
    global _service
    if _service is None:
        _service = CrmSchemaMappingService()
    return _service

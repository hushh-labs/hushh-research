# consent-protocol/hushh_mcp/services/personal_knowledge_model_service.py
"""
Personal Knowledge Model service with BYOK encryption.

Canonical storage:
1. pkm_index
2. pkm_blobs
3. pkm_manifests + pkm_manifest_paths + pkm_scope_registry
4. pkm_events + pkm_migration_state
"""

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any, Optional

from db.db_client import get_db
from hushh_mcp.consent.scope_helpers import scope_matches
from hushh_mcp.services.domain_contracts import (
    CANONICAL_DOMAIN_REGISTRY,
    CURRENT_PKM_MODEL_VERSION,
    CURRENT_READABLE_SUMMARY_VERSION,
    RETIRED_DOMAIN_REGISTRY_KEYS,
    canonical_top_level_domain,
    current_domain_contract_version,
    is_allowed_top_level_domain,
)

logger = logging.getLogger(__name__)


class AttributeSource(str, Enum):
    """Source of attribute data."""

    EXPLICIT = "explicit"  # User provided directly
    INFERRED = "inferred"  # Inferred by Kai
    IMPORTED = "imported"  # From portfolio import
    COMPUTED = "computed"  # Calculated from other data


class EmbeddingType(str, Enum):
    """Types of user profile embeddings."""

    FINANCIAL_PROFILE = "financial_profile"
    LIFESTYLE_PROFILE = "lifestyle_profile"
    INTEREST_PROFILE = "interest_profile"
    COMPOSITE = "composite"


@dataclass
class DomainSummary:
    """Summary of a domain for a user."""

    domain_key: str
    display_name: str
    icon: str
    color: str
    attribute_count: int
    summary: dict = field(default_factory=dict)
    available_scopes: list[str] = field(default_factory=list)
    last_updated: Optional[datetime] = None
    readable_summary: Optional[str] = None
    readable_highlights: list[str] = field(default_factory=list)
    readable_updated_at: Optional[str] = None
    readable_source_label: Optional[str] = None
    domain_contract_version: int = 1
    readable_summary_version: int = 0
    upgraded_at: Optional[str] = None


@dataclass
class PersonalKnowledgeModelIndex:
    """Discovery-only PKM index for fast metadata reads."""

    user_id: str
    domain_summaries: dict = field(default_factory=dict)
    available_domains: list[str] = field(default_factory=list)
    computed_tags: list[str] = field(default_factory=list)
    activity_score: Optional[float] = None
    last_active_at: Optional[datetime] = None
    total_attributes: int = 0
    model_version: int = CURRENT_PKM_MODEL_VERSION
    last_upgraded_at: Optional[datetime] = None


@dataclass
class UserPersonalKnowledgeModelMetadata:
    """Complete metadata about a user's PKM for UI."""

    user_id: str
    domains: list[DomainSummary] = field(default_factory=list)
    total_attributes: int = 0
    model_completeness: float = 0.0
    suggested_domains: list[str] = field(default_factory=list)
    last_updated: Optional[datetime] = None


@dataclass
class EncryptedAttribute:
    """Encrypted attribute with BYOK encryption."""

    user_id: str
    domain: str  # Now accepts any string (dynamic domains)
    attribute_key: str
    ciphertext: str
    iv: str
    tag: str
    algorithm: str = "aes-256-gcm"
    source: AttributeSource = AttributeSource.EXPLICIT
    confidence: Optional[float] = None
    inferred_at: Optional[datetime] = None
    display_name: Optional[str] = None
    data_type: str = "string"


@dataclass
class PathDescriptor:
    """Private PKM manifest descriptor for a consentable JSON path."""

    json_path: str
    parent_path: Optional[str] = None
    path_type: str = "leaf"
    exposure_eligibility: bool = True
    consent_label: Optional[str] = None
    sensitivity_label: Optional[str] = None
    segment_id: str = "root"
    scope_handle: Optional[str] = None
    source_agent: Optional[str] = None


@dataclass
class ScopeRegistryEntry:
    """Public PKM scope registry entry with opaque handle routing."""

    scope_handle: str
    scope_label: str
    segment_ids: list[str] = field(default_factory=list)
    sensitivity_tier: str = "confidential"
    scope_kind: str = "subtree"
    exposure_enabled: bool = True
    summary_projection: dict = field(default_factory=dict)


@dataclass
class DomainManifest:
    """Private per-user manifest for first-party PKM structure and scope expansion."""

    user_id: str
    domain: str
    manifest_version: int = 1
    structure_decision: dict = field(default_factory=dict)
    summary_projection: dict = field(default_factory=dict)
    top_level_scope_paths: list[str] = field(default_factory=list)
    externalizable_paths: list[str] = field(default_factory=list)
    segment_ids: list[str] = field(default_factory=list)
    paths: list[PathDescriptor] = field(default_factory=list)
    scope_registry: list[ScopeRegistryEntry] = field(default_factory=list)
    last_structured_at: Optional[datetime] = None
    last_content_at: Optional[datetime] = None
    domain_contract_version: int = 1
    readable_summary_version: int = 0
    upgraded_at: Optional[datetime] = None


class PersonalKnowledgeModelService:
    """
    Service for managing the Personal Knowledge Model with dynamic domains.

    Follows BYOK principles - all sensitive attributes are encrypted
        with the user's vault key before storage.
    """

    def __init__(self):
        self._supabase = None
        self._domain_registry = None
        self._scope_generator = None
        self._blob_upsert_rpc_supported: Optional[bool] = None

    _SUMMARY_BLOCKLIST = {"holdings", "total_value", "vault_key", "password"}
    _RETIRED_DOMAIN_KEYS = {str(key).strip().lower() for key in RETIRED_DOMAIN_REGISTRY_KEYS}
    _ALLOWED_DISCOVERY_LITERAL_KEYS = {
        "domain_contract_version",
        "storage_mode",
    }

    @property
    def supabase(self):
        if self._supabase is None:
            self._supabase = get_db()
        return self._supabase

    @staticmethod
    def _clean_text(
        value: Optional[str],
        *,
        default: str = "",
        allow_none: bool = False,
    ) -> Optional[str]:
        if not isinstance(value, str):
            return None if allow_none else default
        cleaned = value.strip()
        if cleaned.lower() in {"", "null", "undefined", "none"}:
            return None if allow_none else default
        return cleaned

    @staticmethod
    def _clean_base64ish(value: Optional[str], *, default: str = "") -> str:
        cleaned = PersonalKnowledgeModelService._clean_text(value, default=default) or default
        if not cleaned:
            return default
        return "".join(cleaned.split())

    @classmethod
    def _normalize_string_list(cls, value: object, *, limit: int = 5) -> list[str]:
        if not isinstance(value, list):
            return []
        normalized: list[str] = []
        seen: set[str] = set()
        for item in value:
            cleaned = cls._clean_text(str(item or ""), allow_none=True)
            if not cleaned or cleaned in seen:
                continue
            seen.add(cleaned)
            normalized.append(cleaned)
            if len(normalized) >= limit:
                break
        return normalized

    def _canonicalize_domain_key(self, domain: str) -> str:
        raw_domain = self._clean_text(domain).lower()
        if not raw_domain:
            return ""
        canonical_domain = canonical_top_level_domain(raw_domain)
        if canonical_domain != raw_domain:
            logger.info(
                "Canonicalized legacy domain key '%s' -> '%s'",
                raw_domain,
                canonical_domain,
            )
        return canonical_domain

    async def _run_rpc(self, function_name: str, params: Optional[dict] = None):
        call = self.supabase.rpc(function_name, params or {})
        if not hasattr(call, "execute"):
            return call
        return await asyncio.to_thread(call.execute)

    async def _execute_query(self, query):
        """Run blocking Supabase query execution without blocking the event loop."""
        return await asyncio.to_thread(query.execute)

    def _supports_blob_upsert_rpc(self) -> bool:
        if self._blob_upsert_rpc_supported is not None:
            return self._blob_upsert_rpc_supported

        client = self.supabase
        if not hasattr(client, "execute_raw"):
            # Non-SQLAlchemy clients may still support rpc(); keep optimistic.
            self._blob_upsert_rpc_supported = True
            return True

        try:
            result = client.execute_raw(
                """
                SELECT EXISTS (
                    SELECT 1
                    FROM pg_proc
                    WHERE proname = :function_name
                ) AS exists
                """,
                {"function_name": "upsert_pkm_data_blob"},
            )
            exists = bool(result.data and bool(result.data[0].get("exists")))
            self._blob_upsert_rpc_supported = exists
            if not exists:
                logger.info("upsert_pkm_data_blob RPC is not installed; using fallback write path.")
            return exists
        except Exception as probe_error:
            logger.debug("RPC probe failed, attempting RPC path directly: %s", probe_error)
            self._blob_upsert_rpc_supported = True
            return True

    @staticmethod
    def _is_missing_rpc_function_error(error: Exception, function_name: str) -> bool:
        text = str(error).lower()
        return (
            "undefinedfunction" in text or "does not exist" in text
        ) and function_name.lower() in text

    @staticmethod
    def _to_non_negative_int(value: object) -> Optional[int]:
        if isinstance(value, bool) or value is None:
            return None
        if isinstance(value, int):
            return max(0, value)
        if isinstance(value, float):
            if value != value:  # NaN guard
                return None
            return max(0, int(value))
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return None
            try:
                parsed = int(float(text))
                return max(0, parsed)
            except Exception:
                return None
        return None

    @staticmethod
    def _parse_datetime(value: object, *, field_name: str) -> Optional[datetime]:
        if value is None:
            return None
        if isinstance(value, datetime):
            return value if value.tzinfo else value.replace(tzinfo=UTC)
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return None
            try:
                return datetime.fromisoformat(text.replace("Z", "+00:00"))
            except Exception:
                logger.warning("Failed to parse datetime field %s=%r", field_name, value)
                return None
        logger.warning("Unexpected datetime field %s type: %s", field_name, type(value).__name__)
        return None

    @staticmethod
    def _safe_json_value(value: object, fallback: object) -> object:
        try:
            json.dumps(value)
            return value
        except Exception:
            return fallback

    @classmethod
    def _normalize_manifest_path(cls, path: str | None) -> str:
        if not isinstance(path, str):
            return ""
        raw = path.strip().lower()
        if not raw:
            return ""

        segments: list[str] = []
        for part in raw.split("."):
            normalized_part = "".join(
                ch if (ch.isalnum() or ch == "_") else "_" for ch in part.strip()
            ).strip("_")
            if normalized_part:
                segments.append(normalized_part)
        return ".".join(segments)

    @classmethod
    def _normalize_path_list(cls, values: object) -> list[str]:
        if not isinstance(values, list):
            return []
        seen: set[str] = set()
        normalized_values: list[str] = []
        for value in values:
            normalized = cls._normalize_manifest_path(str(value))
            if normalized and normalized not in seen:
                seen.add(normalized)
                normalized_values.append(normalized)
        return normalized_values

    @classmethod
    def _normalize_path_descriptor(
        cls,
        payload: dict | None,
        *,
        source_agent: str,
    ) -> Optional[PathDescriptor]:
        raw_payload = payload if isinstance(payload, dict) else {}
        json_path = cls._normalize_manifest_path(
            raw_payload.get("json_path") or raw_payload.get("path")
        )
        if not json_path:
            return None

        parent_path = cls._normalize_manifest_path(raw_payload.get("parent_path"))
        path_type = cls._clean_text(str(raw_payload.get("path_type") or "leaf"), default="leaf")
        if path_type not in {"object", "array", "leaf"}:
            path_type = "leaf"
        consent_label = cls._clean_text(raw_payload.get("consent_label"))
        sensitivity_label = cls._clean_text(raw_payload.get("sensitivity_label"))
        segment_id = cls._clean_text(raw_payload.get("segment_id"), default="root") or "root"
        scope_handle = cls._clean_text(raw_payload.get("scope_handle"), allow_none=True)
        descriptor_source_agent = cls._clean_text(
            raw_payload.get("source_agent"),
            default=source_agent,
        )

        return PathDescriptor(
            json_path=json_path,
            parent_path=parent_path or None,
            path_type=path_type,
            exposure_eligibility=bool(raw_payload.get("exposure_eligibility", True)),
            consent_label=consent_label or None,
            sensitivity_label=sensitivity_label or None,
            segment_id=segment_id,
            scope_handle=scope_handle or None,
            source_agent=descriptor_source_agent or None,
        )

    @classmethod
    def _normalize_structure_decision(cls, domain: str, payload: dict | None) -> dict:
        source = payload if isinstance(payload, dict) else {}
        action = cls._clean_text(source.get("action"), default="match_existing_domain")
        if action not in {"match_existing_domain", "create_domain", "extend_domain"}:
            action = "match_existing_domain"

        target_domain = cls._canonicalize_static_domain(
            source.get("target_domain"),
            fallback=domain,
        )
        json_paths = cls._normalize_path_list(source.get("json_paths"))
        top_level_scope_paths = cls._normalize_path_list(source.get("top_level_scope_paths"))
        externalizable_paths = cls._normalize_path_list(source.get("externalizable_paths"))
        summary_projection = (
            source.get("summary_projection")
            if isinstance(source.get("summary_projection"), dict)
            else {}
        )
        sensitivity_labels = (
            source.get("sensitivity_labels")
            if isinstance(source.get("sensitivity_labels"), dict)
            else {}
        )
        confidence = source.get("confidence")
        try:
            confidence_value = float(confidence) if confidence is not None else 1.0
        except Exception:
            confidence_value = 1.0
        confidence_value = max(0.0, min(1.0, confidence_value))

        source_agent = cls._clean_text(
            source.get("source_agent"),
            default="pkm_structure_agent",
        )
        contract_version = cls._to_non_negative_int(source.get("contract_version")) or 1

        if not top_level_scope_paths:
            top_level_scope_paths = sorted(
                {
                    path.split(".", 1)[0]
                    for path in json_paths
                    if isinstance(path, str) and path.strip()
                }
            )
        if not externalizable_paths:
            externalizable_paths = list(json_paths)

        normalized_sensitivity_labels: dict[str, str] = {}
        for raw_path, raw_label in sensitivity_labels.items():
            normalized_path = cls._normalize_manifest_path(str(raw_path))
            normalized_label = cls._clean_text(str(raw_label))
            if normalized_path and normalized_label:
                normalized_sensitivity_labels[normalized_path] = normalized_label

        return {
            "action": action,
            "target_domain": target_domain,
            "json_paths": json_paths,
            "top_level_scope_paths": top_level_scope_paths,
            "externalizable_paths": externalizable_paths,
            "summary_projection": cls._safe_json_value(summary_projection, {}),
            "sensitivity_labels": normalized_sensitivity_labels,
            "confidence": confidence_value,
            "source_agent": source_agent,
            "contract_version": contract_version,
        }

    @classmethod
    def _canonicalize_static_domain(cls, domain: object, *, fallback: str = "") -> str:
        raw_domain = cls._clean_text(str(domain or ""), default=fallback).lower()
        if not raw_domain:
            return fallback
        return canonical_top_level_domain(raw_domain)

    def _normalize_manifest_payload(
        self,
        user_id: str,
        domain: str,
        payload: dict | None,
        structure_decision: dict | None,
    ) -> DomainManifest:
        source = payload if isinstance(payload, dict) else {}
        decision = self._normalize_structure_decision(domain, structure_decision)
        source_agent = self._clean_text(
            source.get("source_agent"),
            default=decision.get("source_agent", "pkm_structure_agent"),
        )

        normalized_paths: dict[str, PathDescriptor] = {}
        for raw_descriptor in source.get("paths") or []:
            descriptor = self._normalize_path_descriptor(raw_descriptor, source_agent=source_agent)
            if descriptor is not None:
                normalized_paths[descriptor.json_path] = descriptor

        if not normalized_paths:
            for path in decision.get("json_paths", []):
                segment_id = path.split(".", 1)[0] if "." in path else "root"
                descriptor = PathDescriptor(
                    json_path=path,
                    parent_path=path.rsplit(".", 1)[0] if "." in path else None,
                    path_type="leaf",
                    exposure_eligibility=path in set(decision.get("externalizable_paths", [])),
                    consent_label=path.replace(".", " ").replace("_", " ").title(),
                    sensitivity_label=decision.get("sensitivity_labels", {}).get(path),
                    segment_id=segment_id,
                    source_agent=source_agent,
                )
                normalized_paths[descriptor.json_path] = descriptor

        top_level_scope_paths = self._normalize_path_list(
            source.get("top_level_scope_paths") or decision.get("top_level_scope_paths")
        )
        if not top_level_scope_paths:
            top_level_scope_paths = sorted(
                {
                    descriptor.json_path.split(".", 1)[0]
                    for descriptor in normalized_paths.values()
                    if descriptor.json_path
                }
            )

        externalizable_paths = self._normalize_path_list(
            source.get("externalizable_paths") or decision.get("externalizable_paths")
        )
        if not externalizable_paths:
            externalizable_paths = sorted(
                descriptor.json_path
                for descriptor in normalized_paths.values()
                if descriptor.exposure_eligibility
            )

        segment_ids = sorted(
            {
                descriptor.segment_id or "root"
                for descriptor in normalized_paths.values()
                if descriptor.segment_id or normalized_paths
            }
        ) or ["root"]

        manifest_version = self._to_non_negative_int(source.get("manifest_version")) or 1
        summary_projection = (
            source.get("summary_projection")
            if isinstance(source.get("summary_projection"), dict)
            else {}
        )
        if not summary_projection:
            summary_projection = (
                decision.get("summary_projection")
                if isinstance(decision.get("summary_projection"), dict)
                else {}
            )
        domain_contract_version = (
            self._to_non_negative_int(source.get("domain_contract_version"))
            or self._to_non_negative_int(summary_projection.get("domain_contract_version"))
            or current_domain_contract_version(domain)
        )
        readable_summary_version = self._to_non_negative_int(source.get("readable_summary_version"))
        if readable_summary_version is None:
            readable_summary_version = self._to_non_negative_int(
                summary_projection.get("readable_summary_version")
            )
        if readable_summary_version is None:
            readable_summary_version = (
                CURRENT_READABLE_SUMMARY_VERSION
                if any(
                    summary_projection.get(key)
                    for key in (
                        "readable_summary",
                        "readable_highlights",
                        "readable_updated_at",
                        "readable_source_label",
                    )
                )
                else 0
            )
        upgraded_at_value = self._clean_text(
            str(source.get("upgraded_at") or summary_projection.get("upgraded_at") or ""),
            allow_none=True,
        )
        if domain_contract_version:
            summary_projection["domain_contract_version"] = domain_contract_version
        if readable_summary_version is not None:
            summary_projection["readable_summary_version"] = readable_summary_version
        if upgraded_at_value:
            summary_projection["upgraded_at"] = upgraded_at_value

        last_structured_at = datetime.now(UTC)
        last_content_at = datetime.now(UTC)

        scope_registry = self._build_scope_registry_entries(
            user_id=user_id,
            domain=domain,
            manifest_version=manifest_version,
            top_level_scope_paths=top_level_scope_paths,
            paths=list(normalized_paths.values()),
        )

        return DomainManifest(
            user_id=user_id,
            domain=domain,
            manifest_version=manifest_version,
            structure_decision=decision,
            summary_projection=summary_projection,
            top_level_scope_paths=top_level_scope_paths,
            externalizable_paths=externalizable_paths,
            segment_ids=segment_ids,
            paths=list(
                sorted(normalized_paths.values(), key=lambda descriptor: descriptor.json_path)
            ),
            scope_registry=scope_registry,
            last_structured_at=last_structured_at,
            last_content_at=last_content_at,
            domain_contract_version=domain_contract_version,
            readable_summary_version=readable_summary_version,
            upgraded_at=(
                datetime.fromisoformat(upgraded_at_value.replace("Z", "+00:00"))
                if upgraded_at_value
                else None
            ),
        )

    @classmethod
    def _scope_handle_for_path(cls, user_id: str, domain: str, path: str) -> str:
        import hashlib

        digest = hashlib.sha256(f"{user_id}:{domain}:{path}".encode("utf-8")).hexdigest()
        return f"s_{digest[:12]}"

    def _build_scope_registry_entries(
        self,
        *,
        user_id: str,
        domain: str,
        manifest_version: int,
        top_level_scope_paths: list[str],
        paths: list[PathDescriptor],
    ) -> list[ScopeRegistryEntry]:
        entries: list[ScopeRegistryEntry] = []
        path_map = {
            descriptor.json_path: descriptor
            for descriptor in paths
            if descriptor.exposure_eligibility and descriptor.json_path
        }

        for scope_path in top_level_scope_paths:
            normalized_path = self._normalize_manifest_path(scope_path)
            if not normalized_path:
                continue
            matching = [
                descriptor
                for descriptor in path_map.values()
                if descriptor.json_path == normalized_path
                or descriptor.json_path.startswith(f"{normalized_path}.")
            ]
            if not matching:
                continue
            segment_ids = sorted({descriptor.segment_id or "root" for descriptor in matching}) or [
                "root"
            ]
            sensitivity_tier = "confidential"
            if any(
                (descriptor.sensitivity_label or "").lower() == "restricted"
                for descriptor in matching
            ):
                sensitivity_tier = "restricted"
            handle = self._scope_handle_for_path(user_id, domain, normalized_path)
            for descriptor in matching:
                descriptor.scope_handle = handle
            entries.append(
                ScopeRegistryEntry(
                    scope_handle=handle,
                    scope_label=normalized_path.replace(".", " ").replace("_", " ").title(),
                    segment_ids=segment_ids,
                    sensitivity_tier=sensitivity_tier,
                    scope_kind="subtree",
                    exposure_enabled=True,
                    summary_projection={
                        "top_level_scope_path": normalized_path,
                        "manifest_version": manifest_version,
                    },
                )
            )

        return entries

    @staticmethod
    def _serialize_manifest(manifest: DomainManifest) -> dict[str, object]:
        return {
            "user_id": manifest.user_id,
            "domain": manifest.domain,
            "manifest_version": manifest.manifest_version,
            "structure_decision": json.dumps(manifest.structure_decision or {}),
            "summary_projection": json.dumps(manifest.summary_projection or {}),
            "top_level_scope_paths": manifest.top_level_scope_paths,
            "externalizable_paths": manifest.externalizable_paths,
            "segment_ids": manifest.segment_ids,
            "path_count": len(manifest.paths),
            "externalizable_path_count": len(
                [path for path in manifest.paths if path.exposure_eligibility]
            ),
            "domain_contract_version": manifest.domain_contract_version,
            "readable_summary_version": manifest.readable_summary_version,
            "upgraded_at": manifest.upgraded_at.isoformat() if manifest.upgraded_at else None,
            "last_structured_at": manifest.last_structured_at.isoformat()
            if manifest.last_structured_at
            else None,
            "last_content_at": manifest.last_content_at.isoformat()
            if manifest.last_content_at
            else None,
        }

    @staticmethod
    def _serialize_manifest_path(
        manifest: DomainManifest,
        path: PathDescriptor,
    ) -> dict[str, object]:
        return {
            "user_id": manifest.user_id,
            "domain": manifest.domain,
            "json_path": path.json_path,
            "parent_path": path.parent_path,
            "path_type": path.path_type,
            "segment_id": path.segment_id or "root",
            "scope_handle": path.scope_handle,
            "exposure_eligibility": path.exposure_eligibility,
            "consent_label": path.consent_label,
            "sensitivity_label": path.sensitivity_label,
            "source_agent": path.source_agent,
        }

    @staticmethod
    def _serialize_scope_registry_entry(
        manifest: DomainManifest,
        entry: ScopeRegistryEntry,
    ) -> dict[str, object]:
        return {
            "user_id": manifest.user_id,
            "domain": manifest.domain,
            "scope_handle": entry.scope_handle,
            "scope_label": entry.scope_label,
            "segment_ids": entry.segment_ids,
            "sensitivity_tier": entry.sensitivity_tier,
            "scope_kind": entry.scope_kind,
            "exposure_enabled": entry.exposure_enabled,
            "summary_projection": json.dumps(entry.summary_projection or {}),
            "manifest_version": manifest.manifest_version,
        }

    def _normalized_summary_count(self, summary: dict | None) -> int:
        if not isinstance(summary, dict):
            return 0
        candidates = (
            summary.get("attribute_count"),
            summary.get("holdings_count"),
            summary.get("item_count"),
        )
        for candidate in candidates:
            parsed = self._to_non_negative_int(candidate)
            if parsed is not None:
                return parsed
        return 0

    def _normalize_domain_summary(self, domain: str, summary: dict | None) -> dict:
        """Normalize summary payload into a minimal discovery-only contract."""
        source = summary if isinstance(summary, dict) else {}
        sanitized: dict[str, object] = {}

        canonical_count = self._normalized_summary_count(source)
        sanitized["attribute_count"] = canonical_count
        sanitized["item_count"] = canonical_count
        if domain == "financial" or "holdings_count" in source:
            sanitized["holdings_count"] = canonical_count
        sanitized["domain_contract_version"] = self._to_non_negative_int(
            source.get("domain_contract_version")
        ) or current_domain_contract_version(domain)
        readable_summary_version = self._to_non_negative_int(source.get("readable_summary_version"))
        if readable_summary_version is None:
            readable_summary_version = (
                CURRENT_READABLE_SUMMARY_VERSION
                if any(
                    source.get(key)
                    for key in (
                        "readable_summary",
                        "readable_highlights",
                        "readable_updated_at",
                        "readable_source_label",
                    )
                )
                else 0
            )
        sanitized["readable_summary_version"] = readable_summary_version

        for key, value in source.items():
            normalized_key = str(key).strip().lower()
            if normalized_key in self._SUMMARY_BLOCKLIST:
                continue
            if normalized_key in {"attribute_count", "item_count", "holdings_count"}:
                continue
            if normalized_key in {"risk_profile", "risk_bucket", "risk_score"}:
                continue
            if normalized_key.startswith("analysis_") or normalized_key.endswith("_decision"):
                continue
            if normalized_key in {
                "recent_decisions",
                "analysis_recent_decisions",
                "analysis_decisions",
                "decisions",
                "intent_map",
                "sub_intents",
                "subintents",
                "available_subintents",
                "available_sub_intents",
                "tickers_analyzed",
                "last_analysis_ticker",
                "last_brokerage",
                "profile_risk_profile",
                "portfolio_total_value",
                "total_value",
            }:
                continue

            if normalized_key in {
                "path_count",
                "externalizable_path_count",
                "manifest_version",
                "top_level_scope_count",
            }:
                parsed = self._to_non_negative_int(value)
                if parsed is not None:
                    sanitized[normalized_key] = parsed
                continue

            if normalized_key in {"last_structured_at", "last_content_at", "updated_at"}:
                cleaned = self._clean_text(str(value))
                if cleaned:
                    sanitized[normalized_key] = cleaned
                continue

            if normalized_key in {
                "readable_summary",
                "readable_updated_at",
                "readable_source_label",
                "readable_event_summary",
                "upgraded_at",
            }:
                cleaned = self._clean_text(str(value), allow_none=True)
                if cleaned:
                    sanitized[normalized_key] = cleaned
                continue

            if normalized_key in {"domain_contract_version", "readable_summary_version"}:
                parsed = self._to_non_negative_int(value)
                if parsed is not None:
                    sanitized[normalized_key] = parsed
                continue

            if normalized_key == "readable_highlights":
                highlights = self._normalize_string_list(value)
                if highlights:
                    sanitized[normalized_key] = highlights
                continue

            if normalized_key in self._ALLOWED_DISCOVERY_LITERAL_KEYS:
                cleaned = self._clean_text(str(value))
                if cleaned:
                    sanitized[normalized_key] = cleaned
                continue

            if isinstance(value, bool) and (
                normalized_key.startswith("has_")
                or normalized_key.endswith("_enabled")
                or normalized_key.endswith("_available")
            ):
                sanitized[normalized_key] = value

        return sanitized

    @staticmethod
    def _merge_financial_summary_from_retired_contracts(
        financial_summary: dict,
        retired_summaries: dict[str, dict],
    ) -> dict:
        merged = dict(financial_summary or {})

        profile_summary = retired_summaries.get("kai_profile") or {}
        if isinstance(profile_summary, dict):
            if merged.get("risk_profile") in (None, ""):
                merged["risk_profile"] = profile_summary.get("risk_profile")
            if merged.get("risk_score") in (None, ""):
                merged["risk_score"] = profile_summary.get("risk_score")
            if merged.get("profile_completed") in (None, ""):
                merged["profile_completed"] = profile_summary.get("onboarding_completed")
            for key in (
                "has_investment_horizon",
                "has_drawdown_response",
                "has_volatility_preference",
                "nav_tour_completed",
            ):
                if merged.get(key) in (None, ""):
                    merged[key] = profile_summary.get(key)

        documents_summary = retired_summaries.get("financial_documents") or {}
        if isinstance(documents_summary, dict):
            for key in (
                "documents_count",
                "last_statement_end",
                "last_quality_score",
                "last_brokerage",
            ):
                if merged.get(key) in (None, ""):
                    merged[key] = documents_summary.get(key)

        history_summary = retired_summaries.get("kai_analysis_history") or {}
        if isinstance(history_summary, dict):
            if merged.get("analysis_total_analyses") in (None, ""):
                merged["analysis_total_analyses"] = history_summary.get(
                    "analysis_total_analyses",
                    history_summary.get("total_analyses"),
                )
            if merged.get("analysis_tickers_analyzed") in (None, ""):
                merged["analysis_tickers_analyzed"] = history_summary.get(
                    "analysis_tickers_analyzed",
                    history_summary.get("tickers_analyzed"),
                )
            if merged.get("analysis_last_updated") in (None, ""):
                merged["analysis_last_updated"] = history_summary.get(
                    "analysis_last_updated",
                    history_summary.get("last_updated"),
                )
            for key in (
                "total_analyses",
                "tickers_analyzed",
                "last_analysis_date",
                "last_analysis_ticker",
            ):
                if merged.get(key) in (None, ""):
                    merged[key] = history_summary.get(key)

        return merged

    def _recalculate_total_attributes(self, summaries: dict | None) -> int:
        if not isinstance(summaries, dict):
            return 0
        total = 0
        for summary in summaries.values():
            total += self._normalized_summary_count(summary if isinstance(summary, dict) else {})
        return total

    @property
    def domain_registry(self):
        if self._domain_registry is None:
            from hushh_mcp.services.domain_registry_service import get_domain_registry_service

            self._domain_registry = get_domain_registry_service()
        return self._domain_registry

    @property
    def scope_generator(self):
        if self._scope_generator is None:
            from hushh_mcp.consent.scope_generator import get_scope_generator

            self._scope_generator = get_scope_generator()
        return self._scope_generator

    # ==================== PKM INDEX OPERATIONS ====================

    async def get_index_v2(self, user_id: str) -> Optional[PersonalKnowledgeModelIndex]:
        """Get the user's PKM discovery index."""
        try:
            query = self.supabase.table("pkm_index").select("*").eq("user_id", user_id)
            result = await self._execute_query(query)

            if not result.data:
                return None

            row = result.data[0]
            last_active_at = self._parse_datetime(
                row.get("last_active_at"),
                field_name="pkm_index.last_active_at",
            )
            last_upgraded_at = self._parse_datetime(
                row.get("last_upgraded_at"),
                field_name="pkm_index.last_upgraded_at",
            )
            return PersonalKnowledgeModelIndex(
                user_id=row["user_id"],
                domain_summaries=row.get("domain_summaries") or {},
                available_domains=row.get("available_domains") or [],
                computed_tags=row.get("computed_tags") or [],
                activity_score=row.get("activity_score"),
                last_active_at=last_active_at,
                total_attributes=row.get("total_attributes", 0),
                model_version=self._to_non_negative_int(row.get("model_version"))
                or CURRENT_PKM_MODEL_VERSION,
                last_upgraded_at=last_upgraded_at,
            )
        except Exception as e:
            logger.error(f"Error getting PKM index: {e}")
            return None

    async def upsert_index_v2(self, index: PersonalKnowledgeModelIndex) -> bool:
        """Create or update the user's PKM discovery index."""
        try:
            # Defense-in-depth: sanitize every domain summary before persisting.
            # The primary sanitization lives in update_domain_summary(), but this
            # guards against callers who build an index object directly.
            sanitized_summaries = {}
            for domain, summary in (index.domain_summaries or {}).items():
                if isinstance(summary, dict):
                    sanitized_summaries[domain] = self._normalize_domain_summary(domain, summary)
                else:
                    sanitized_summaries[domain] = summary

            available_domains = sorted(
                {
                    *(
                        str(domain).strip()
                        for domain in (index.available_domains or [])
                        if str(domain).strip()
                    ),
                    *(
                        str(domain).strip()
                        for domain in sanitized_summaries.keys()
                        if str(domain).strip()
                    ),
                }
            )
            total_attributes = self._recalculate_total_attributes(sanitized_summaries)

            # Serialize dict fields to JSON strings for psycopg2 compatibility
            data = {
                "user_id": index.user_id,
                "domain_summaries": json.dumps(sanitized_summaries)
                if sanitized_summaries
                else "{}",
                "available_domains": available_domains,
                "computed_tags": index.computed_tags,
                "activity_score": index.activity_score,
                "last_active_at": index.last_active_at.isoformat()
                if index.last_active_at
                else None,
                "total_attributes": total_attributes,
                "model_version": self._to_non_negative_int(index.model_version)
                or CURRENT_PKM_MODEL_VERSION,
                "last_upgraded_at": index.last_upgraded_at.isoformat()
                if index.last_upgraded_at
                else None,
                "created_at": datetime.now(UTC).isoformat(),
                "updated_at": datetime.now(UTC).isoformat(),
            }

            await self._execute_query(
                self.supabase.table("pkm_index").upsert(data, on_conflict="user_id")
            )
            return True
        except Exception as e:
            logger.error(f"Error upserting PKM index: {e}")
            return False

    async def update_domain_summary(
        self,
        user_id: str,
        domain: str,
        summary: dict,
    ) -> bool:
        """Merge a sanitized PKM discovery summary for one domain."""
        domain = self._canonicalize_domain_key(domain)
        if not domain:
            logger.error("update_domain_summary called with empty domain for user %s", user_id)
            return False

        sanitized = self._normalize_domain_summary(
            domain, summary if isinstance(summary, dict) else {}
        )
        try:
            if not is_allowed_top_level_domain(domain):
                logger.warning(
                    "Non-canonical top-level domain summary write for %s/%s",
                    user_id,
                    domain,
                )

            index = await self.get_index_v2(user_id)
            if index is None:
                index = PersonalKnowledgeModelIndex(user_id=user_id)

            existing_summary = (
                index.domain_summaries.get(domain)
                if isinstance(index.domain_summaries.get(domain), dict)
                else {}
            )
            index.domain_summaries[domain] = self._normalize_domain_summary(
                domain,
                {
                    **existing_summary,
                    **sanitized,
                },
            )

            if domain not in index.available_domains:
                index.available_domains.append(domain)

            index.total_attributes = self._recalculate_total_attributes(index.domain_summaries)

            return await self.upsert_index_v2(index)
        except Exception as fallback_err:
            logger.error(f"PKM update_domain_summary failed: {fallback_err}")
            return False

    async def upsert_domain_manifest(
        self,
        manifest: DomainManifest,
    ) -> bool:
        """Persist manifest header + path descriptors for a user/domain pair."""
        try:
            manifest_row = self._serialize_manifest(manifest)
            await self._execute_query(
                self.supabase.table("pkm_manifests").upsert(
                    manifest_row,
                    on_conflict="user_id,domain",
                )
            )

            await self._execute_query(
                self.supabase.table("pkm_manifest_paths")
                .delete()
                .eq("user_id", manifest.user_id)
                .eq("domain", manifest.domain)
            )
            await self._execute_query(
                self.supabase.table("pkm_scope_registry")
                .delete()
                .eq("user_id", manifest.user_id)
                .eq("domain", manifest.domain)
            )

            if manifest.paths:
                path_rows = [
                    self._serialize_manifest_path(manifest, path) for path in manifest.paths
                ]
                await self._execute_query(
                    self.supabase.table("pkm_manifest_paths").upsert(
                        path_rows,
                        on_conflict="user_id,domain,json_path",
                    )
                )
            if manifest.scope_registry:
                scope_rows = [
                    self._serialize_scope_registry_entry(manifest, entry)
                    for entry in manifest.scope_registry
                ]
                await self._execute_query(
                    self.supabase.table("pkm_scope_registry").upsert(
                        scope_rows,
                        on_conflict="user_id,domain,scope_handle",
                    )
                )
            return True
        except Exception as e:
            logger.error(
                "Error upserting domain manifest for user=%s domain=%s: %s",
                manifest.user_id,
                manifest.domain,
                e,
            )
            return False

    async def get_domain_manifest(self, user_id: str, domain: str) -> Optional[dict]:
        """Return manifest + path descriptors for a user/domain if available."""
        try:
            canonical_domain = self._canonicalize_domain_key(domain)
            if not canonical_domain:
                return None
            manifest_query = (
                self.supabase.table("pkm_manifests")
                .select("*")
                .eq("user_id", user_id)
                .eq("domain", canonical_domain)
                .limit(1)
            )
            manifest_result = await self._execute_query(manifest_query)
            if not manifest_result.data:
                return None

            manifest_row = manifest_result.data[0]
            path_query = (
                self.supabase.table("pkm_manifest_paths")
                .select("*")
                .eq("user_id", user_id)
                .eq("domain", canonical_domain)
                .order("json_path")
            )
            path_rows = await self._execute_query(path_query)
            scope_query = (
                self.supabase.table("pkm_scope_registry")
                .select("*")
                .eq("user_id", user_id)
                .eq("domain", canonical_domain)
                .order("scope_handle")
            )
            scope_rows = await self._execute_query(scope_query)
            manifest_row["paths"] = path_rows.data or []
            manifest_row["scope_registry"] = scope_rows.data or []
            return manifest_row
        except Exception as e:
            logger.error(
                "Error getting domain manifest for user=%s domain=%s: %s",
                user_id,
                domain,
                e,
            )
            return None

    async def record_mutation_event(
        self,
        *,
        user_id: str,
        domain: str,
        operation_type: str,
        path_set: list[str] | None = None,
        source_agent: str | None = None,
        confidence: float | None = None,
        prior_manifest_version: int | None = None,
        new_manifest_version: int | None = None,
        metadata: dict | None = None,
    ) -> bool:
        """Append a PKM mutation event for replay/debugging/audit."""
        try:
            canonical_domain = self._canonicalize_domain_key(domain)
            await self._execute_query(
                self.supabase.table("pkm_events").insert(
                    {
                        "user_id": user_id,
                        "domain": canonical_domain or domain,
                        "operation_type": operation_type,
                        "path_set": json.dumps(path_set or []),
                        "source_agent": source_agent,
                        "confidence": confidence,
                        "prior_manifest_version": prior_manifest_version,
                        "new_manifest_version": new_manifest_version,
                        "metadata": json.dumps(metadata or {}),
                    }
                )
            )
            return True
        except Exception as e:
            logger.error(
                "Error recording PKM mutation event user=%s domain=%s op=%s: %s",
                user_id,
                domain,
                operation_type,
                e,
            )
            return False

    @staticmethod
    def _extract_decision_records(summary: dict | None) -> list[dict]:
        """Extract decision payloads from legacy summary maps before sanitization."""
        if not isinstance(summary, dict):
            return []

        items: list[dict] = []
        for key in (
            "recent_decisions",
            "analysis_recent_decisions",
            "analysis_decisions",
            "decisions",
        ):
            payload = summary.get(key)
            if isinstance(payload, list):
                items.extend([row for row in payload if isinstance(row, dict)])
            elif isinstance(payload, dict):
                nested = payload.get("decisions")
                if isinstance(nested, list):
                    items.extend([row for row in nested if isinstance(row, dict)])

        for summary_key, summary_value in summary.items():
            if not isinstance(summary_key, str) or not summary_key.endswith("_decision"):
                continue
            ticker = summary_key[: -len("_decision")].upper()
            if not ticker:
                continue
            try:
                confidence_value = float(summary.get(f"{ticker}_confidence") or 0.0)
            except Exception:
                confidence_value = 0.0
            items.append(
                {
                    "id": 0,
                    "ticker": ticker,
                    "decision_type": str(summary_value or "HOLD"),
                    "confidence": confidence_value,
                    "created_at": str(summary.get(f"{ticker}_analyzed_at") or ""),
                    "metadata": {"source": "summary_map"},
                }
            )
        return items

    @staticmethod
    def _extract_projection_decision_records(write_projections: list[dict] | None) -> list[dict]:
        """Extract explicit decision projections from the canonical write envelope."""
        if not isinstance(write_projections, list):
            return []

        for projection in write_projections:
            if not isinstance(projection, dict):
                continue
            projection_type = str(projection.get("projection_type") or "").strip().lower()
            projection_version = int(projection.get("projection_version") or 1)
            if projection_type not in {"decision_history", "decision_history_v1"}:
                continue
            if projection_version != 1:
                continue
            payload = projection.get("payload")
            if not isinstance(payload, dict):
                continue
            raw_decisions = payload.get("decisions")
            if not isinstance(raw_decisions, list):
                return []
            decisions = [row for row in raw_decisions if isinstance(row, dict)]
            return decisions
        return []

    @staticmethod
    def _top_level_scope_path_for_registry_entry(entry: dict | ScopeRegistryEntry | None) -> str:
        if isinstance(entry, ScopeRegistryEntry):
            summary_projection = entry.summary_projection or {}
        elif isinstance(entry, dict):
            summary_projection_raw = entry.get("summary_projection")
            if isinstance(summary_projection_raw, str):
                try:
                    parsed = json.loads(summary_projection_raw)
                    summary_projection = parsed if isinstance(parsed, dict) else {}
                except Exception:
                    summary_projection = {}
            elif isinstance(summary_projection_raw, dict):
                summary_projection = summary_projection_raw
            else:
                summary_projection = {}
        else:
            summary_projection = {}
        return PersonalKnowledgeModelService._normalize_manifest_path(
            summary_projection.get("top_level_scope_path")
        )

    async def get_recent_decision_records(
        self,
        user_id: str,
        *,
        domain: str = "financial",
        limit: int = 50,
    ) -> list[dict]:
        """Read latest decision projections from mutation events."""
        try:
            rows = self.supabase.execute_raw(
                """
                SELECT metadata, created_at
                FROM pkm_events
                WHERE user_id = :user_id
                  AND domain = :domain
                  AND operation_type = 'decision_projection'
                ORDER BY created_at DESC
                LIMIT :limit
                """,
                {"user_id": user_id, "domain": domain, "limit": max(1, limit)},
            ).data
            decisions: list[dict] = []
            seen: set[str] = set()
            for row in rows:
                metadata = row.get("metadata") if isinstance(row, dict) else {}
                payload = metadata if isinstance(metadata, dict) else {}
                raw_decisions = payload.get("decisions")
                if not isinstance(raw_decisions, list):
                    continue
                if str(payload.get("projection_mode") or "").strip().lower() == "replace_all":
                    return [decision for decision in raw_decisions if isinstance(decision, dict)][
                        :limit
                    ]
                for decision in raw_decisions:
                    if not isinstance(decision, dict):
                        continue
                    identity = json.dumps(decision, sort_keys=True, default=str)
                    if identity in seen:
                        continue
                    seen.add(identity)
                    decisions.append(decision)
                    if len(decisions) >= limit:
                        return decisions
            return decisions
        except Exception as e:
            logger.error("Error loading recent decision records for %s: %s", user_id, e)
            return []

    async def _queue_consent_export_refreshes_for_domain_write(
        self,
        *,
        user_id: str,
        domain: str,
        manifest: DomainManifest,
    ) -> None:
        try:
            from hushh_mcp.services.consent_db import ConsentDBService

            consent_service = ConsentDBService()
            active_tokens = await consent_service.get_active_tokens(user_id)
            if not active_tokens:
                return

            candidate_scopes = {f"attr.{domain}.*", "pkm.read"}
            candidate_scopes.update(
                {
                    f"attr.{domain}.{path}.*"
                    for path in manifest.top_level_scope_paths
                    if isinstance(path, str) and path.strip()
                }
            )
            candidate_scopes.update(
                {
                    f"attr.{domain}.{path}"
                    for path in manifest.externalizable_paths
                    if isinstance(path, str) and path.strip()
                }
            )
            trigger_paths = sorted(
                {
                    str(path).strip()
                    for path in (
                        list(manifest.externalizable_paths) + list(manifest.top_level_scope_paths)
                    )
                    if str(path).strip()
                }
            )

            for token in active_tokens:
                granted_scope = str(token.get("scope") or "").strip()
                consent_token = str(token.get("token_id") or "").strip()
                if not granted_scope or not consent_token:
                    continue

                export_metadata = await consent_service.get_consent_export_metadata(consent_token)
                if not export_metadata or not export_metadata.get("is_strict_zero_knowledge"):
                    continue

                if not any(
                    scope_matches(granted_scope, candidate) for candidate in candidate_scopes
                ):
                    continue

                await consent_service.queue_consent_export_refresh_job(
                    user_id=user_id,
                    consent_token=consent_token,
                    granted_scope=granted_scope,
                    trigger_domain=domain,
                    trigger_paths=trigger_paths,
                )
        except Exception as exc:
            logger.warning(
                "Failed to queue consent export refresh jobs for user=%s domain=%s: %s",
                user_id,
                domain,
                exc,
            )

    async def _revoke_scope_access_tokens(
        self,
        *,
        user_id: str,
        disabled_scopes: list[str],
    ) -> list[str]:
        if not disabled_scopes:
            return []

        try:
            import time

            from hushh_mcp.consent.token import revoke_token
            from hushh_mcp.services.consent_db import ConsentDBService
            from hushh_mcp.services.ria_iam_service import RIAIAMService

            consent_service = ConsentDBService()
            external_tokens = await consent_service.get_active_tokens(user_id)
            internal_tokens = await consent_service.get_active_internal_tokens(user_id)
            revoked_ids: list[str] = []
            seen_token_ids: set[str] = set()

            for token in [*external_tokens, *internal_tokens]:
                granted_scope = str(token.get("scope") or "").strip()
                token_id = str(token.get("token_id") or "").strip()
                if not granted_scope or not token_id or token_id in seen_token_ids:
                    continue
                overlaps = any(
                    scope_matches(granted_scope, disabled_scope)
                    or scope_matches(disabled_scope, granted_scope)
                    for disabled_scope in disabled_scopes
                )
                if not overlaps:
                    continue

                seen_token_ids.add(token_id)
                if not token_id.startswith("REVOKED_"):
                    revoke_token(token_id)
                await consent_service.delete_consent_export(token_id)

                event_token_id = f"REVOKED_SCOPE_{int(time.time() * 1000)}_{len(revoked_ids)}"
                agent_id = token.get("agent_id") or token.get("developer") or "Unknown"
                request_id = token.get("request_id")
                await consent_service.insert_event(
                    user_id=user_id,
                    agent_id=agent_id,
                    scope=granted_scope,
                    action="REVOKED",
                    token_id=event_token_id,
                    request_id=request_id,
                    metadata={
                        "revoked_by": "pkm_scope_exposure",
                        "disabled_scopes": disabled_scopes,
                    },
                )
                try:
                    await RIAIAMService().sync_relationship_from_consent_action(
                        user_id=user_id,
                        request_id=request_id,
                        action="REVOKED",
                        agent_id=agent_id,
                        scope=granted_scope,
                    )
                except Exception:
                    logger.exception("ria.relationship_sync_failed action=REVOKED")
                revoked_ids.append(token_id)

            return revoked_ids
        except Exception as exc:
            logger.warning(
                "Failed to revoke overlapping scope grants for user=%s scopes=%s: %s",
                user_id,
                disabled_scopes,
                exc,
            )
            return []

    async def update_scope_exposure(
        self,
        *,
        user_id: str,
        domain: str,
        changes: list[dict],
        expected_manifest_version: int | None = None,
        revoke_matching_active_grants: bool = True,
    ) -> dict[str, Any]:
        canonical_domain = self._canonicalize_domain_key(domain)
        result: dict[str, Any] = {
            "success": False,
            "code": None,
            "message": None,
            "manifest_version": None,
            "revoked_grant_count": 0,
            "revoked_grant_ids": [],
            "manifest": {},
        }
        if not canonical_domain:
            result["message"] = "Domain is required."
            return result

        current_manifest = await self.get_domain_manifest(user_id, canonical_domain)
        if not current_manifest:
            result["code"] = "manifest_not_found"
            result["message"] = f"No manifest found for {canonical_domain}."
            return result

        current_manifest_version = (
            self._to_non_negative_int(current_manifest.get("manifest_version")) or 1
        )
        result["manifest_version"] = current_manifest_version
        if (
            expected_manifest_version is not None
            and current_manifest_version != expected_manifest_version
        ):
            result["code"] = "manifest_conflict"
            result["message"] = "PKM manifest changed. Refresh and retry."
            return result

        normalized_manifest = self._normalize_manifest_payload(
            user_id,
            canonical_domain,
            current_manifest,
            self._normalize_structure_decision(
                canonical_domain,
                current_manifest.get("structure_decision"),
            ),
        )
        current_registry_rows = (
            current_manifest.get("scope_registry")
            if isinstance(current_manifest.get("scope_registry"), list)
            else []
        )
        exposure_by_handle: dict[str, bool] = {}
        exposure_by_top_level: dict[str, bool] = {}
        for row in current_registry_rows:
            if not isinstance(row, dict):
                continue
            handle = self._clean_text(str(row.get("scope_handle") or ""), allow_none=True)
            if handle:
                exposure_by_handle[handle] = row.get("exposure_enabled") is not False
            top_level_path = self._top_level_scope_path_for_registry_entry(row)
            if top_level_path:
                exposure_by_top_level[top_level_path] = row.get("exposure_enabled") is not False

        for entry in normalized_manifest.scope_registry:
            if entry.scope_handle in exposure_by_handle:
                entry.exposure_enabled = exposure_by_handle[entry.scope_handle]
                continue
            top_level_path = self._top_level_scope_path_for_registry_entry(entry)
            if top_level_path in exposure_by_top_level:
                entry.exposure_enabled = exposure_by_top_level[top_level_path]

        changed_scope_paths: set[str] = set()
        for raw_change in changes:
            if not isinstance(raw_change, dict):
                continue
            target_handle = self._clean_text(
                str(raw_change.get("scope_handle") or ""),
                allow_none=True,
            )
            target_top_level = self._normalize_manifest_path(raw_change.get("top_level_scope_path"))
            exposure_enabled = raw_change.get("exposure_enabled") is not False
            matched = False
            for entry in normalized_manifest.scope_registry:
                entry_top_level = self._top_level_scope_path_for_registry_entry(entry)
                if target_handle and entry.scope_handle == target_handle:
                    entry.exposure_enabled = exposure_enabled
                    matched = True
                    if entry_top_level:
                        changed_scope_paths.add(entry_top_level)
                    continue
                if target_top_level and entry_top_level == target_top_level:
                    entry.exposure_enabled = exposure_enabled
                    matched = True
                    changed_scope_paths.add(entry_top_level)
            if not matched:
                logger.warning(
                    "Ignoring unknown PKM scope exposure change user=%s domain=%s handle=%s top_level=%s",
                    user_id,
                    canonical_domain,
                    target_handle,
                    target_top_level,
                )

        next_manifest_version = current_manifest_version + 1
        now = datetime.now(UTC)
        normalized_manifest.manifest_version = next_manifest_version
        normalized_manifest.last_structured_at = now
        normalized_manifest.last_content_at = now
        normalized_manifest.summary_projection["manifest_version"] = next_manifest_version

        manifest_ok = await self.upsert_domain_manifest(normalized_manifest)
        if not manifest_ok:
            result["message"] = "Failed to persist PKM scope exposure."
            return result

        await self.update_domain_summary(
            user_id,
            canonical_domain,
            {
                **(
                    normalized_manifest.summary_projection
                    if isinstance(normalized_manifest.summary_projection, dict)
                    else {}
                ),
                "storage_mode": "per_domain_blob",
                "manifest_version": next_manifest_version,
                "path_count": len(normalized_manifest.paths),
                "externalizable_path_count": len(
                    [path for path in normalized_manifest.paths if path.exposure_eligibility]
                ),
                "top_level_scope_count": len(normalized_manifest.top_level_scope_paths),
                "last_structured_at": now.isoformat(),
                "last_content_at": now.isoformat(),
                "domain_contract_version": normalized_manifest.domain_contract_version,
                "readable_summary_version": normalized_manifest.readable_summary_version,
                "upgraded_at": normalized_manifest.upgraded_at.isoformat()
                if normalized_manifest.upgraded_at
                else None,
            },
        )

        disabled_scopes = sorted(
            {
                f"attr.{canonical_domain}.{top_level_path}.*"
                for entry in normalized_manifest.scope_registry
                for top_level_path in [self._top_level_scope_path_for_registry_entry(entry)]
                if top_level_path and entry.exposure_enabled is False
            }
        )
        revoked_grant_ids = (
            await self._revoke_scope_access_tokens(
                user_id=user_id,
                disabled_scopes=disabled_scopes,
            )
            if revoke_matching_active_grants
            else []
        )

        await self.record_mutation_event(
            user_id=user_id,
            domain=canonical_domain,
            operation_type="scope_exposure_update",
            path_set=sorted(changed_scope_paths),
            source_agent="pkm_scope_manager",
            prior_manifest_version=current_manifest_version,
            new_manifest_version=next_manifest_version,
            metadata={
                "changes": [change for change in changes if isinstance(change, dict)],
                "disabled_scopes": disabled_scopes,
                "revoked_grant_ids": revoked_grant_ids,
            },
        )

        refreshed_manifest = await self.get_domain_manifest(user_id, canonical_domain)
        result.update(
            {
                "success": True,
                "message": "Updated PKM scope exposure.",
                "manifest_version": next_manifest_version,
                "revoked_grant_count": len(revoked_grant_ids),
                "revoked_grant_ids": revoked_grant_ids,
                "manifest": refreshed_manifest or {},
            }
        )
        return result

    # ==================== ATTRIBUTE OPERATIONS (DEPRECATED) ====================
    # These methods wrote to the now-removed legacy attribute tables.
    # Signatures are kept temporarily to catch hidden callers at runtime.
    # New code MUST use store_domain_data / get_domain_data / update_domain_summary.

    _DEPRECATION_MSG = (
        "Deprecated: legacy attribute tables removed. "
        "Use store_domain_data()/get_domain_data() or update_domain_summary()."
    )

    async def store_attribute(
        self,
        user_id: str,
        domain: Optional[str],
        attribute_key: str,
        ciphertext: str,
        iv: str,
        tag: str,
        algorithm: str = "aes-256-gcm",
        source: str = "explicit",
        confidence: Optional[float] = None,
        display_name: Optional[str] = None,
        data_type: str = "string",
    ) -> tuple[bool, str]:
        """DEPRECATED – raises NotImplementedError. Use store_domain_data()."""
        raise NotImplementedError(self._DEPRECATION_MSG)

    async def store_attribute_obj(self, attr: EncryptedAttribute) -> tuple[bool, str]:
        """DEPRECATED – raises NotImplementedError. Use store_domain_data()."""
        raise NotImplementedError(self._DEPRECATION_MSG)

    async def get_attribute(
        self,
        user_id: str,
        domain: str,
        attribute_key: str,
    ) -> Optional[EncryptedAttribute]:
        """DEPRECATED – raises NotImplementedError. Use get_domain_data()."""
        raise NotImplementedError(self._DEPRECATION_MSG)

    async def get_domain_attributes(
        self,
        user_id: str,
        domain: str,
    ) -> list[EncryptedAttribute]:
        """DEPRECATED – raises NotImplementedError. Use get_domain_data()."""
        raise NotImplementedError(self._DEPRECATION_MSG)

    async def get_all_attributes(self, user_id: str) -> list[EncryptedAttribute]:
        """DEPRECATED – raises NotImplementedError. Use get_encrypted_data()."""
        raise NotImplementedError(self._DEPRECATION_MSG)

    async def delete_attribute(
        self,
        user_id: str,
        domain: str,
        attribute_key: str,
    ) -> bool:
        """DEPRECATED – raises NotImplementedError."""
        raise NotImplementedError(self._DEPRECATION_MSG)

    # ==================== METADATA OPERATIONS ====================

    async def get_user_metadata(self, user_id: str) -> UserPersonalKnowledgeModelMetadata:
        """
        Get complete metadata about user's PKM for UI.

        This is the primary method for frontend to fetch user profile data.
        """
        try:
            # Try RPC function first (more efficient)
            try:
                result = await self._run_rpc("get_user_pkm_metadata", {"p_user_id": user_id})

                if result.data:
                    data = result.data[0] if isinstance(result.data, list) else result.data
                    domains = []
                    for d in data.get("domains") or []:
                        domains.append(
                            DomainSummary(
                                domain_key=d["key"],
                                display_name=d["display_name"],
                                icon=d["icon"],
                                color=d["color"],
                                attribute_count=d["attribute_count"],
                                summary=(d.get("summary") or {})
                                if isinstance(d.get("summary"), dict)
                                else {},
                                available_scopes=d.get("available_scopes") or [],
                                last_updated=d.get("last_updated"),
                                readable_summary=d.get("readable_summary"),
                                readable_highlights=self._normalize_string_list(
                                    d.get("readable_highlights")
                                ),
                                readable_updated_at=d.get("readable_updated_at"),
                                readable_source_label=d.get("readable_source_label"),
                                domain_contract_version=self._to_non_negative_int(
                                    d.get("domain_contract_version")
                                )
                                or current_domain_contract_version(d["key"]),
                                readable_summary_version=self._to_non_negative_int(
                                    d.get("readable_summary_version")
                                )
                                or 0,
                                upgraded_at=self._clean_text(
                                    str(d.get("upgraded_at") or ""),
                                    allow_none=True,
                                ),
                            )
                        )

                    return UserPersonalKnowledgeModelMetadata(
                        user_id=user_id,
                        domains=domains,
                        total_attributes=data.get("total_attributes", 0),
                        last_updated=data.get("last_updated"),
                    )
            except Exception as rpc_error:
                logger.warning(f"RPC get_user_pkm_metadata failed, using fallback: {rpc_error}")

            # Fallback: derive from PKM index and manifests rather than domain_registry.
            index = await self.get_index_v2(user_id)
            scopes = await self.scope_generator.get_available_scopes(user_id)
            contract_map = {entry.domain_key: entry for entry in CANONICAL_DOMAIN_REGISTRY}

            domains = []
            for domain_key in sorted(index.available_domains if index else []):
                summary = (
                    index.domain_summaries.get(domain_key)
                    if index and isinstance(index.domain_summaries.get(domain_key), dict)
                    else {}
                )
                contract = contract_map.get(domain_key)
                domain_scopes = [s for s in scopes if s.startswith(f"attr.{domain_key}.")]
                domains.append(
                    DomainSummary(
                        domain_key=domain_key,
                        display_name=(
                            str(summary.get("display_name") or "").strip()
                            or (
                                contract.display_name
                                if contract
                                else domain_key.replace("_", " ").title()
                            )
                        ),
                        icon=(
                            str(summary.get("icon") or "").strip()
                            or (contract.icon_name if contract else "folder")
                        ),
                        color=(
                            str(summary.get("color") or "").strip()
                            or (contract.color_hex if contract else "#6B7280")
                        ),
                        attribute_count=self._normalized_summary_count(summary),
                        summary=summary,
                        available_scopes=domain_scopes,
                        readable_summary=self._clean_text(
                            str(summary.get("readable_summary") or ""),
                            allow_none=True,
                        ),
                        readable_highlights=self._normalize_string_list(
                            summary.get("readable_highlights")
                        ),
                        readable_updated_at=self._clean_text(
                            str(summary.get("readable_updated_at") or ""),
                            allow_none=True,
                        ),
                        readable_source_label=self._clean_text(
                            str(summary.get("readable_source_label") or ""),
                            allow_none=True,
                        ),
                        domain_contract_version=self._to_non_negative_int(
                            summary.get("domain_contract_version")
                        )
                        or current_domain_contract_version(domain_key),
                        readable_summary_version=self._to_non_negative_int(
                            summary.get("readable_summary_version")
                        )
                        or 0,
                        upgraded_at=self._clean_text(
                            str(summary.get("upgraded_at") or ""),
                            allow_none=True,
                        ),
                    )
                )

            # Compute total count from domain summaries (no legacy table query)
            total = 0
            for domain in domains:
                total += domain.attribute_count

            # Calculate completeness against broad soft-ontology anchors only.
            common_domains = {"financial", "health", "travel", "food", "professional"}

            user_domain_keys = {d.domain_key for d in domains}
            completeness = (
                len(user_domain_keys & common_domains) / len(common_domains)
                if common_domains
                else 0.0
            )

            # Suggest missing common domains
            suggested = list(common_domains - user_domain_keys)[:3]

            return UserPersonalKnowledgeModelMetadata(
                user_id=user_id,
                domains=domains,
                total_attributes=total,
                model_completeness=completeness,
                suggested_domains=suggested,
                last_updated=datetime.now(UTC),
            )
        except Exception as e:
            logger.error(f"Error getting user metadata: {e}")
            return UserPersonalKnowledgeModelMetadata(user_id=user_id)

    # ==================== EMBEDDING OPERATIONS ====================

    async def store_embedding(
        self,
        user_id: str,
        embedding_type: EmbeddingType,
        embedding_vector: list[float],
        model_name: str = "all-MiniLM-L6-v2",
    ) -> bool:
        """Store a user profile embedding."""
        try:
            data = {
                "user_id": user_id,
                "embedding_type": embedding_type.value,
                "embedding_vector": embedding_vector,
                "model_name": model_name,
                "updated_at": datetime.now(UTC).isoformat(),
            }

            self.supabase.table("pkm_embeddings").upsert(
                data, on_conflict="user_id,embedding_type"
            ).execute()
            return True
        except Exception as e:
            logger.error(f"Error storing embedding: {e}")
            return False

    async def find_similar_users(
        self,
        query_embedding: list[float],
        embedding_type: EmbeddingType,
        threshold: float = 0.7,
        limit: int = 10,
    ) -> list[dict]:
        """Find users with similar profiles using vector similarity."""
        try:
            result = await self._run_rpc(
                "match_user_profiles",
                {
                    "query_embedding": query_embedding,
                    "embedding_type_filter": embedding_type.value,
                    "match_threshold": threshold,
                    "match_count": limit,
                },
            )

            return result.data or []
        except Exception as e:
            logger.error(f"Error finding similar users: {e}")
            return []

    # ==================== PKM DATA OPERATIONS (BLOB-BASED) ====================

    async def store_domain_data(
        self,
        user_id: str,
        domain: str,
        encrypted_blob: dict,
        summary: dict,
        structure_decision: Optional[dict] = None,
        manifest: Optional[dict] = None,
        source_agent: Optional[str] = None,
        expected_data_version: Optional[int] = None,
        upgrade_context: Optional[dict] = None,
        write_projections: Optional[list[dict]] = None,
        return_result: bool = False,
    ) -> bool | dict[str, Any]:
        """
        Store encrypted domain data and update index.

        This is the NEW method for storing user data following BYOK principles.
        Client encrypts entire domain object and sends only ciphertext to backend.

        Args:
            user_id: User's ID
            domain: Domain key (e.g., "financial", "food")
            encrypted_blob: Pre-encrypted data from client
                {
                    "ciphertext": "base64...",
                    "iv": "base64...",
                    "tag": "base64..."
                }
            summary: Non-sensitive metadata for PKM index
                {
                    "has_portfolio": true,
                    "holdings_count": 4,
                    "risk_bucket": "aggressive"
                }

        Returns:
            bool: Success status by default.
            dict: Detailed result when return_result=True.
        """
        result: dict[str, Any] = {
            "success": False,
            "conflict": False,
            "data_version": None,
            "updated_at": None,
        }
        domain = self._canonicalize_domain_key(domain)
        if not domain:
            logger.error("store_domain_data called with empty domain for user %s", user_id)
            return result if return_result else False

        try:
            if not is_allowed_top_level_domain(domain):
                logger.warning(
                    "Non-canonical top-level domain write for %s/%s",
                    user_id,
                    domain,
                )

            raw_segments = encrypted_blob.get("segments")
            normalized_segments: dict[str, dict[str, str]] = {}
            if isinstance(raw_segments, dict) and raw_segments:
                for raw_segment_id, raw_segment_blob in raw_segments.items():
                    if not isinstance(raw_segment_blob, dict):
                        continue
                    segment_id = self._clean_text(str(raw_segment_id), default="root") or "root"
                    ciphertext = self._clean_base64ish(raw_segment_blob.get("ciphertext"))
                    iv = self._clean_base64ish(raw_segment_blob.get("iv"))
                    tag = self._clean_base64ish(raw_segment_blob.get("tag"))
                    algorithm = self._clean_text(
                        raw_segment_blob.get("algorithm", "aes-256-gcm"),
                        default="aes-256-gcm",
                    ).lower()
                    if ciphertext and iv and tag:
                        normalized_segments[segment_id] = {
                            "ciphertext": ciphertext,
                            "iv": iv,
                            "tag": tag,
                            "algorithm": algorithm,
                        }

            if not normalized_segments:
                ciphertext = self._clean_base64ish(encrypted_blob["ciphertext"])
                iv = self._clean_base64ish(encrypted_blob["iv"])
                tag = self._clean_base64ish(encrypted_blob["tag"])
                algorithm = self._clean_text(
                    encrypted_blob.get("algorithm", "aes-256-gcm"),
                    default="aes-256-gcm",
                ).lower()
                normalized_segments["root"] = {
                    "ciphertext": ciphertext,
                    "iv": iv,
                    "tag": tag,
                    "algorithm": algorithm,
                }

            existing_domain_blob = await self._execute_query(
                self.supabase.table("pkm_blobs")
                .select("segment_id,content_revision,updated_at")
                .eq("user_id", user_id)
                .eq("domain", domain)
            )
            existing_blob_rows = existing_domain_blob.data or []
            existing_domain_row = existing_blob_rows[0] if existing_blob_rows else None
            legacy_blob = await self.get_encrypted_data(user_id)
            current_version = 0
            current_updated_at: Optional[str] = None
            if existing_domain_row:
                current_version = int(existing_domain_row.get("content_revision", 0) or 0)
                current_updated_at = existing_domain_row.get("updated_at")
            elif legacy_blob is not None:
                current_version = int(legacy_blob.get("data_version", 0) or 0)
                current_updated_at = legacy_blob.get("updated_at")

            if expected_data_version is not None and current_version != expected_data_version:
                result["conflict"] = True
                result["data_version"] = current_version
                result["updated_at"] = current_updated_at
                return result if return_result else False

            prior_manifest = await self.get_domain_manifest(user_id, domain)
            normalized_decision = self._normalize_structure_decision(
                domain,
                {
                    **(structure_decision or {}),
                    "source_agent": source_agent
                    or (structure_decision or {}).get("source_agent")
                    or "pkm_structure_agent",
                },
            )
            normalized_manifest = self._normalize_manifest_payload(
                user_id,
                domain,
                manifest,
                normalized_decision,
            )

            prior_paths = {
                self._normalize_manifest_path(path_row.get("json_path"))
                for path_row in (prior_manifest or {}).get("paths", [])
                if isinstance(path_row, dict)
            }
            next_paths = {path.json_path for path in normalized_manifest.paths}
            if not isinstance(structure_decision, dict) or not structure_decision.get("action"):
                if prior_manifest is None:
                    normalized_manifest.structure_decision["action"] = "create_domain"
                elif next_paths - prior_paths:
                    normalized_manifest.structure_decision["action"] = "extend_domain"
                else:
                    normalized_manifest.structure_decision["action"] = "match_existing_domain"

            resolved_data_version = int(current_version) + 1
            resolved_updated_at = datetime.now(UTC).isoformat()
            existing_segment_ids = {
                self._clean_text(row.get("segment_id"), default="root") or "root"
                for row in existing_blob_rows
            }
            next_segment_ids = set(normalized_segments.keys())

            for segment_id in sorted(existing_segment_ids - next_segment_ids):
                await self._execute_query(
                    self.supabase.table("pkm_blobs")
                    .delete()
                    .eq("user_id", user_id)
                    .eq("domain", domain)
                    .eq("segment_id", segment_id)
                )

            segment_rows = []
            for segment_id, segment_blob in normalized_segments.items():
                ciphertext = segment_blob["ciphertext"]
                iv = segment_blob["iv"]
                tag = segment_blob["tag"]
                algorithm = segment_blob["algorithm"]
                segment_rows.append(
                    {
                        "user_id": user_id,
                        "domain": domain,
                        "segment_id": segment_id,
                        "ciphertext": ciphertext,
                        "iv": iv,
                        "tag": tag,
                        "algorithm": algorithm,
                        "content_revision": resolved_data_version,
                        "manifest_revision": normalized_manifest.manifest_version,
                        "size_bytes": len(ciphertext),
                        "created_at": resolved_updated_at,
                        "updated_at": resolved_updated_at,
                    }
                )
            await self._execute_query(
                self.supabase.table("pkm_blobs").upsert(
                    segment_rows,
                    on_conflict="user_id,domain,segment_id",
                )
            )

            manifest_ok = await self.upsert_domain_manifest(normalized_manifest)
            if not manifest_ok:
                return result if return_result else False

            discovery_summary_input = {
                **(summary if isinstance(summary, dict) else {}),
                **(
                    normalized_manifest.summary_projection
                    if isinstance(normalized_manifest.summary_projection, dict)
                    else {}
                ),
                "storage_mode": "per_domain_blob",
                "manifest_version": normalized_manifest.manifest_version,
                "path_count": len(normalized_manifest.paths),
                "externalizable_path_count": len(
                    [path for path in normalized_manifest.paths if path.exposure_eligibility]
                ),
                "top_level_scope_count": len(normalized_manifest.top_level_scope_paths),
                "last_structured_at": normalized_manifest.last_structured_at.isoformat()
                if normalized_manifest.last_structured_at
                else None,
                "last_content_at": normalized_manifest.last_content_at.isoformat()
                if normalized_manifest.last_content_at
                else None,
                "domain_contract_version": normalized_manifest.domain_contract_version,
                "readable_summary_version": normalized_manifest.readable_summary_version,
                "upgraded_at": normalized_manifest.upgraded_at.isoformat()
                if normalized_manifest.upgraded_at
                else None,
            }
            readable_event_payload = {
                key: value
                for key, value in {
                    "readable_summary": discovery_summary_input.get("readable_summary"),
                    "readable_highlights": self._normalize_string_list(
                        discovery_summary_input.get("readable_highlights")
                    ),
                    "readable_updated_at": discovery_summary_input.get("readable_updated_at"),
                    "readable_source_label": discovery_summary_input.get("readable_source_label"),
                    "readable_event_summary": discovery_summary_input.get("readable_event_summary"),
                }.items()
                if value not in (None, "", [])
            }
            normalized_upgrade_context = (
                {
                    key: value
                    for key, value in (upgrade_context or {}).items()
                    if value not in (None, "", [])
                }
                if isinstance(upgrade_context, dict)
                else {}
            )

            # 3. Update PKM discovery index
            summary_ok = await self.update_domain_summary(user_id, domain, discovery_summary_input)
            if not summary_ok:
                return result if return_result else False

            prior_manifest_version = (
                self._to_non_negative_int((prior_manifest or {}).get("manifest_version"))
                if isinstance(prior_manifest, dict)
                else None
            )
            path_set = sorted(next_paths)
            action = normalized_manifest.structure_decision.get("action", "match_existing_domain")
            action_map = {
                "create_domain": "structure_create",
                "extend_domain": "structure_extend",
                "match_existing_domain": "structure_match",
            }
            await self.record_mutation_event(
                user_id=user_id,
                domain=domain,
                operation_type=action_map.get(action, "structure_match"),
                path_set=path_set,
                source_agent=normalized_manifest.structure_decision.get("source_agent"),
                confidence=normalized_manifest.structure_decision.get("confidence"),
                prior_manifest_version=prior_manifest_version,
                new_manifest_version=normalized_manifest.manifest_version,
                metadata={
                    "structure_decision": normalized_manifest.structure_decision,
                    "top_level_scope_paths": normalized_manifest.top_level_scope_paths,
                    "externalizable_paths": normalized_manifest.externalizable_paths,
                    **(
                        {"upgrade": normalized_upgrade_context}
                        if normalized_upgrade_context
                        else {}
                    ),
                    **({"readable": readable_event_payload} if readable_event_payload else {}),
                },
            )
            await self.record_mutation_event(
                user_id=user_id,
                domain=domain,
                operation_type="content_write",
                path_set=path_set,
                source_agent=normalized_manifest.structure_decision.get("source_agent"),
                confidence=normalized_manifest.structure_decision.get("confidence"),
                prior_manifest_version=prior_manifest_version,
                new_manifest_version=normalized_manifest.manifest_version,
                metadata={
                    "storage_mode": "per_domain_blob",
                    "data_version": resolved_data_version,
                    "segment_ids": sorted(next_segment_ids),
                    **(
                        {"upgrade": normalized_upgrade_context}
                        if normalized_upgrade_context
                        else {}
                    ),
                    **({"readable": readable_event_payload} if readable_event_payload else {}),
                },
            )

            explicit_projection_records = self._extract_projection_decision_records(
                write_projections
            )
            projection_supplied = isinstance(write_projections, list) and any(
                isinstance(projection, dict)
                and str(projection.get("projection_type") or "").strip().lower()
                in {"decision_history", "decision_history_v1"}
                for projection in write_projections
            )
            decision_records = (
                explicit_projection_records
                if projection_supplied
                else self._extract_decision_records(summary)
            )
            if projection_supplied or decision_records:
                await self.record_mutation_event(
                    user_id=user_id,
                    domain=domain,
                    operation_type="decision_projection",
                    path_set=["analysis.decisions"],
                    source_agent=normalized_manifest.structure_decision.get("source_agent"),
                    confidence=normalized_manifest.structure_decision.get("confidence"),
                    prior_manifest_version=prior_manifest_version,
                    new_manifest_version=normalized_manifest.manifest_version,
                    metadata={
                        "decisions": decision_records,
                        "projection_mode": "replace_all" if projection_supplied else "append",
                        "projection_type": (
                            "decision_history_v1" if projection_supplied else "summary_inference_v1"
                        ),
                    },
                )

            await self._execute_query(
                self.supabase.table("pkm_migration_state").upsert(
                    {
                        "user_id": user_id,
                        "status": "completed",
                        "source_model": "pkm",
                        "legacy_blob_present": legacy_blob is not None,
                        "migrated_at": resolved_updated_at,
                        "last_error": None,
                        "updated_at": resolved_updated_at,
                    },
                    on_conflict="user_id",
                )
            )

            await self._queue_consent_export_refreshes_for_domain_write(
                user_id=user_id,
                domain=domain,
                manifest=normalized_manifest,
            )

            result["success"] = True
            result["data_version"] = resolved_data_version
            result["updated_at"] = resolved_updated_at
            return result if return_result else True
        except Exception as e:
            logger.error(f"Error storing domain data: {e}")
            return result if return_result else False

    async def get_encrypted_data(self, user_id: str) -> Optional[dict]:
        """
        Get user's encrypted data blob.

        Returns encrypted blob that can only be decrypted client-side.
        Backend cannot read this data.

        Returns:
            dict with keys: ciphertext, iv, tag, algorithm
            or None if no data exists
        """
        try:
            result = await self._execute_query(
                self.supabase.table("pkm_data").select("*").eq("user_id", user_id)
            )

            if not result.data:
                return None

            row = result.data[0]
            return {
                "ciphertext": row["encrypted_data_ciphertext"],
                "iv": row["encrypted_data_iv"],
                "tag": row["encrypted_data_tag"],
                "algorithm": row.get("algorithm", "aes-256-gcm"),
                "data_version": row.get("data_version", 1),
                "updated_at": row.get("updated_at"),
            }
        except Exception as e:
            logger.error(f"Error getting encrypted data: {e}")
            return None

    async def get_domain_data(
        self,
        user_id: str,
        domain: str,
        segment_ids: list[str] | None = None,
    ) -> Optional[dict]:
        """
        Get encrypted data for a specific domain.

        Args:
            user_id: User's ID
            domain: Domain key (e.g., "financial")

        Returns:
            dict with keys: ciphertext, iv, tag, algorithm, storage_mode
            or None if no data exists for this domain
        """
        try:
            domain = self._canonicalize_domain_key(domain)
            if not domain:
                return None

            domain_blob_result = await self._execute_query(
                self.supabase.table("pkm_blobs")
                .select("*")
                .eq("user_id", user_id)
                .eq("domain", domain)
                .order("segment_id")
            )
            if domain_blob_result.data:
                rows = domain_blob_result.data
                normalized_segment_ids = sorted(
                    {
                        str(segment_id or "").strip().lower()
                        for segment_id in (segment_ids or [])
                        if str(segment_id or "").strip()
                    }
                )
                if normalized_segment_ids:
                    rows = [
                        row
                        for row in rows
                        if str(row.get("segment_id") or "root").strip().lower()
                        in normalized_segment_ids
                    ]
                    if not rows:
                        return None
                root_row = next((row for row in rows if row.get("segment_id") == "root"), rows[0])
                segments = {
                    str(row.get("segment_id") or "root"): {
                        "ciphertext": row["ciphertext"],
                        "iv": row["iv"],
                        "tag": row["tag"],
                        "algorithm": row.get("algorithm", "aes-256-gcm"),
                    }
                    for row in rows
                }
                return {
                    "ciphertext": root_row["ciphertext"],
                    "iv": root_row["iv"],
                    "tag": root_row["tag"],
                    "algorithm": root_row.get("algorithm", "aes-256-gcm"),
                    "data_version": root_row.get("content_revision", 1),
                    "manifest_revision": root_row.get("manifest_revision", 1),
                    "updated_at": root_row.get("updated_at"),
                    "storage_mode": "domain",
                    "segments": segments,
                    "segment_ids": sorted(segments.keys()),
                }

            # Legacy fallback: domain exists only in the monolithic blob.
            index = await self.get_index_v2(user_id)
            if index is None or domain not in index.available_domains:
                logger.info(f"Domain {domain} not found in user's available domains")
                return None

            legacy_blob = await self.get_encrypted_data(user_id)
            if legacy_blob is None:
                return None
            return {
                **legacy_blob,
                "storage_mode": "legacy_full_blob",
            }
        except Exception as e:
            logger.error(f"Error getting domain data: {e}")
            return None

    async def delete_user_data(self, user_id: str) -> bool:
        """
        Delete all user data (encrypted blob and index).

        Used for account deletion / data purge.
        """
        try:
            # Delete encrypted data
            self.supabase.table("pkm_data").delete().eq("user_id", user_id).execute()
            self.supabase.table("pkm_blobs").delete().eq("user_id", user_id).execute()
            self.supabase.table("pkm_manifest_paths").delete().eq("user_id", user_id).execute()
            self.supabase.table("pkm_scope_registry").delete().eq("user_id", user_id).execute()
            self.supabase.table("pkm_manifests").delete().eq("user_id", user_id).execute()
            self.supabase.table("pkm_events").delete().eq("user_id", user_id).execute()
            self.supabase.table("pkm_migration_state").delete().eq("user_id", user_id).execute()

            # Delete index
            self.supabase.table("pkm_index").delete().eq("user_id", user_id).execute()

            return True
        except Exception as e:
            logger.error(f"Error deleting user data: {e}")
            return False

    async def delete_domain_data(self, user_id: str, domain: str) -> bool:
        """
        Delete a specific domain from user's PKM.

        This removes the domain from the index (available_domains and domain_summaries).
        Note: The encrypted blob still contains the domain data, but since the client
        manages the blob, it will be overwritten on next save without this domain.

        For complete deletion, the client should:
        1. Call this endpoint to remove from index
        2. Decrypt their blob, remove the domain, re-encrypt and save

        Args:
            user_id: User's ID
            domain: Domain key to delete (e.g., "financial")

        Returns:
            bool: Success status
        """
        try:
            domain = self._canonicalize_domain_key(domain)
            if not domain:
                logger.warning("Empty domain requested for delete_domain_data user=%s", user_id)
                return True
            self.supabase.table("pkm_blobs").delete().eq("user_id", user_id).eq(
                "domain", domain
            ).execute()
            self.supabase.table("pkm_manifest_paths").delete().eq("user_id", user_id).eq(
                "domain", domain
            ).execute()
            self.supabase.table("pkm_scope_registry").delete().eq("user_id", user_id).eq(
                "domain", domain
            ).execute()
            self.supabase.table("pkm_manifests").delete().eq("user_id", user_id).eq(
                "domain", domain
            ).execute()
            self.supabase.table("pkm_events").delete().eq("user_id", user_id).eq(
                "domain", domain
            ).execute()
            # Get current index
            index = await self.get_index_v2(user_id)
            if index is None:
                logger.warning(f"No index found for user {user_id} when deleting domain {domain}")
                return True  # Nothing to delete

            # Check if domain exists
            if domain not in index.available_domains:
                logger.info(f"Domain {domain} not in user {user_id}'s available domains")
                return True  # Domain doesn't exist, consider it deleted

            # Remove domain from available_domains
            index.available_domains = [d for d in index.available_domains if d != domain]

            # Remove domain from domain_summaries
            if domain in index.domain_summaries:
                del index.domain_summaries[domain]

            # Update total_attributes (recalculate from remaining domains)
            total_attrs = 0
            for _d, summary in index.domain_summaries.items():
                total_attrs += (
                    summary.get("holdings_count")
                    or summary.get("attribute_count")
                    or summary.get("item_count")
                    or 0
                )
            index.total_attributes = total_attrs

            # If no domains left, delete the entire index and data
            if not index.available_domains:
                logger.info(f"No domains left for user {user_id}, deleting all data")
                return await self.delete_user_data(user_id)

            # Update the index
            success = await self.upsert_index_v2(index)
            if success:
                logger.info(f"Successfully deleted domain {domain} for user {user_id}")
            return success

        except Exception as e:
            logger.error(f"Error deleting domain {domain} for user {user_id}: {e}")
            return False

    async def reconcile_user_index_domains(
        self,
        user_id: str,
        *,
        register_missing_registry: bool = False,
    ) -> bool:
        """
        Runtime-repair helper for index/domain registry coherence.

        - Normalizes domain summaries to canonical counter contract
        - Ensures available_domains includes every summary key
        - Recomputes total_attributes from canonical counters
        - Optionally auto-registers missing domains in domain_registry
        """
        try:
            index = await self.get_index_v2(user_id)
            if index is None:
                return True

            normalized_summaries: dict[str, dict] = {}
            available_domains: set[str] = set()
            for existing_domain in index.available_domains or []:
                normalized_domain = self._canonicalize_domain_key(existing_domain)
                if normalized_domain and normalized_domain not in self._RETIRED_DOMAIN_KEYS:
                    available_domains.add(normalized_domain)

            retired_summaries: dict[str, dict] = {}
            for raw_domain, raw_summary in (index.domain_summaries or {}).items():
                domain = self._canonicalize_domain_key(str(raw_domain))
                if not domain:
                    continue
                if domain in self._RETIRED_DOMAIN_KEYS:
                    if isinstance(raw_summary, dict):
                        retired_summaries[domain] = dict(raw_summary)
                    continue
                normalized_summary = self._normalize_domain_summary(
                    domain,
                    raw_summary if isinstance(raw_summary, dict) else {},
                )
                existing_summary = normalized_summaries.get(domain)
                if isinstance(existing_summary, dict):
                    normalized_summaries[domain] = self._normalize_domain_summary(
                        domain,
                        {**existing_summary, **normalized_summary},
                    )
                else:
                    normalized_summaries[domain] = normalized_summary
                available_domains.add(domain)

            financial_summary = (
                normalized_summaries.get("financial")
                if isinstance(normalized_summaries.get("financial"), dict)
                else {}
            )
            normalized_summaries["financial"] = self._normalize_domain_summary(
                "financial",
                self._merge_financial_summary_from_retired_contracts(
                    financial_summary or {},
                    retired_summaries,
                ),
            )
            available_domains.add("financial")

            try:
                manifest_rows = (
                    self.supabase.table("pkm_manifests")
                    .select("*")
                    .eq("user_id", user_id)
                    .execute()
                    .data
                    or []
                )
                for manifest_row in manifest_rows:
                    manifest_domain = self._canonicalize_domain_key(manifest_row.get("domain"))
                    if not manifest_domain:
                        continue
                    available_domains.add(manifest_domain)
                    existing_summary = (
                        normalized_summaries.get(manifest_domain)
                        if isinstance(normalized_summaries.get(manifest_domain), dict)
                        else {}
                    )
                    normalized_summaries[manifest_domain] = self._normalize_domain_summary(
                        manifest_domain,
                        {
                            **existing_summary,
                            "storage_mode": "per_domain_blob",
                            "manifest_version": manifest_row.get("manifest_version"),
                            "path_count": manifest_row.get("path_count"),
                            "externalizable_path_count": manifest_row.get(
                                "externalizable_path_count"
                            ),
                            "last_structured_at": manifest_row.get("last_structured_at"),
                            "last_content_at": manifest_row.get("last_content_at"),
                        },
                    )
            except Exception as manifest_error:
                logger.warning(
                    "Manifest reconciliation lookup failed for %s: %s", user_id, manifest_error
                )

            if register_missing_registry:
                logger.info(
                    "reconcile_user_index_domains register_missing_registry requested for %s; runtime registry sync is disabled",
                    user_id,
                )

            index.domain_summaries = normalized_summaries
            index.available_domains = sorted(available_domains)
            index.total_attributes = self._recalculate_total_attributes(normalized_summaries)
            return await self.upsert_index_v2(index)
        except Exception as e:
            logger.error("Error reconciling PKM index for %s: %s", user_id, e)
            return False

    async def get_index(self, user_id: str):
        """Get the discovery-only PKM index."""
        return await self.get_index_v2(user_id)

    async def upsert_index(self, index):
        """Upsert the discovery-only PKM index."""
        if isinstance(index, PersonalKnowledgeModelIndex):
            return await self.upsert_index_v2(index)
        new_index = PersonalKnowledgeModelIndex(
            user_id=index.user_id,
            activity_score=getattr(index, "activity_score", None),
            last_active_at=getattr(index, "last_active_at", None),
        )
        return await self.upsert_index_v2(new_index)

    async def update_activity(self, user_id: str) -> bool:
        """Update user's last active timestamp."""
        try:
            self.supabase.table("pkm_index").upsert(
                {
                    "user_id": user_id,
                    "last_active_at": datetime.now(UTC).isoformat(),
                    "updated_at": datetime.now(UTC).isoformat(),
                },
                on_conflict="user_id",
            ).execute()
            return True
        except Exception as e:
            logger.error(f"Error updating activity: {e}")
            return False


# Singleton instance
_pkm_service: Optional[PersonalKnowledgeModelService] = None


def get_pkm_service() -> PersonalKnowledgeModelService:
    """Canonical accessor for the PKM service singleton."""
    global _pkm_service
    if _pkm_service is None:
        _pkm_service = PersonalKnowledgeModelService()
    return _pkm_service

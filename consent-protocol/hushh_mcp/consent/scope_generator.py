# consent-protocol/hushh_mcp/consent/scope_generator.py
"""
Dynamic Scope Generator - Generates and validates consent scopes dynamically.

Scopes support nested paths:
- attr.{domain}.{attribute_key}
- attr.{domain}.*
- attr.{domain}.{subintent}.*
"""

import json
import logging
from typing import Optional

from db.db_client import get_db

logger = logging.getLogger(__name__)


class DynamicScopeGenerator:
    """
    Generates and validates consent scopes dynamically based on stored attributes.

    Scope Format:
    - Specific: attr.{domain}.{attribute_key}
    - Wildcard: attr.{domain}.*
    - Domain-level: attr.{domain}

    Examples:
    - attr.financial.holdings
    - attr.subscriptions.netflix_plan
    - attr.health.*
    """

    SCOPE_PREFIX = "attr."
    WILDCARD_SUFFIX = ".*"

    def __init__(self):
        self._supabase = None
        self._scope_cache: dict[str, set[str]] = {}  # user_id -> set of scopes
        self._cache_ttl = 300  # 5 minutes

    @property
    def supabase(self):
        if self._supabase is None:
            self._supabase = get_db()
        return self._supabase

    def generate_scope(self, domain: str, attribute_key: str) -> str:
        """
        Generate a scope string for a specific attribute.

        Args:
            domain: The domain key (e.g., 'financial')
            attribute_key: The attribute key (e.g., 'holdings')

        Returns:
            Scope string (e.g., 'attr.financial.holdings')
        """
        domain = domain.lower().strip()
        attribute_key = attribute_key.lower().strip()
        return f"{self.SCOPE_PREFIX}{domain}.{attribute_key}"

    def generate_domain_wildcard(self, domain: str) -> str:
        """
        Generate a wildcard scope for an entire domain.

        Args:
            domain: The domain key (e.g., 'financial')

        Returns:
            Wildcard scope string (e.g., 'attr.financial.*')
        """
        domain = domain.lower().strip()
        return f"{self.SCOPE_PREFIX}{domain}{self.WILDCARD_SUFFIX}"

    def parse_scope(self, scope: str) -> tuple[Optional[str], Optional[str], bool]:
        """
        Parse a scope string into its components.

        Args:
            scope: The scope string to parse

        Returns:
            Tuple of (domain, attribute_key, is_wildcard)
            Returns (None, None, False) if invalid format
        """
        if not scope.startswith(self.SCOPE_PREFIX):
            return (None, None, False)

        remainder = scope[len(self.SCOPE_PREFIX) :].strip()
        if not remainder:
            return (None, None, False)

        parts = [part for part in remainder.split(".") if part]
        if not parts:
            return (None, None, False)

        domain = self._normalize_domain_key(parts[0])
        if not domain:
            return (None, None, False)

        if len(parts) == 1:
            # Domain-level scope (e.g., attr.financial)
            return (domain, None, False)

        if parts[-1] == "*":
            if len(parts) == 2:
                # Domain wildcard (e.g., attr.financial.*)
                return (domain, None, True)
            # Subintent/attribute wildcard (e.g., attr.financial.profile.*)
            path = self._normalize_scope_path(".".join(parts[1:-1]))
            return (domain, path or None, True)

        # Specific path (e.g., attr.financial.profile.risk_score)
        path = self._normalize_scope_path(".".join(parts[1:]))
        return (domain, path or None, False)

    def is_dynamic_scope(self, scope: str) -> bool:
        """Check if a scope is a dynamic attr.* scope."""
        return scope.startswith(self.SCOPE_PREFIX)

    @staticmethod
    def _normalize_domain_key(domain: str | None) -> str:
        return str(domain or "").strip().lower()

    @staticmethod
    def _normalize_scope_path(path: str | None) -> str:
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

    @staticmethod
    def _coerce_json_dict(value: object) -> dict:
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return {}
            try:
                parsed = json.loads(text)
            except Exception:
                return {}
            return parsed if isinstance(parsed, dict) else {}
        return {}

    @classmethod
    def _normalize_domains(cls, domains: list[str] | None) -> list[str]:
        if not domains:
            return []
        return sorted(
            {
                cls._normalize_domain_key(domain)
                for domain in domains
                if cls._normalize_domain_key(domain)
            }
        )

    async def _get_legacy_scope_catalog(self, user_id: str) -> dict[str, dict[str, set[str]]]:
        result = (
            self.supabase.table("pkm_index")
            .select("available_domains", "domain_summaries")
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        if not result.data:
            return {}

        row = result.data[0]
        available_domains = self._normalize_domains(row.get("available_domains") or [])
        domain_summaries = row.get("domain_summaries")
        if not isinstance(domain_summaries, dict):
            domain_summaries = {}

        catalog: dict[str, dict[str, set[str]]] = {
            domain: {"paths": set(), "wildcards": set()} for domain in available_domains
        }

        for domain in available_domains:
            summary = domain_summaries.get(domain)
            if not isinstance(summary, dict):
                continue
            for key in (
                "intent_map",
                "sub_intents",
                "subintents",
                "available_subintents",
                "available_sub_intents",
            ):
                raw_value = summary.get(key)
                if isinstance(raw_value, list):
                    for item in raw_value:
                        normalized = self._normalize_scope_path(str(item))
                        if normalized:
                            catalog[domain]["paths"].add(normalized)
                            catalog[domain]["wildcards"].add(normalized)

        return catalog

    async def _get_user_scope_catalog(self, user_id: str) -> dict[str, dict[str, set[str]]]:
        manifest_rows = (
            self.supabase.table("pkm_manifests")
            .select("domain,top_level_scope_paths,externalizable_paths")
            .eq("user_id", user_id)
            .execute()
        )
        path_rows = (
            self.supabase.table("pkm_manifest_paths")
            .select("domain,json_path,path_type,exposure_eligibility")
            .eq("user_id", user_id)
            .execute()
        )

        catalog: dict[str, dict[str, set[str]]] = {}
        for row in manifest_rows.data or []:
            if not isinstance(row, dict):
                continue
            domain = self._normalize_domain_key(row.get("domain"))
            if not domain:
                continue
            entry = catalog.setdefault(domain, {"paths": set(), "wildcards": set()})
            for top_level_path in row.get("top_level_scope_paths") or []:
                normalized = self._normalize_scope_path(str(top_level_path))
                if normalized:
                    entry["paths"].add(normalized)
                    entry["wildcards"].add(normalized)
            for externalizable_path in row.get("externalizable_paths") or []:
                normalized = self._normalize_scope_path(str(externalizable_path))
                if normalized:
                    entry["paths"].add(normalized)

        for row in path_rows.data or []:
            if not isinstance(row, dict):
                continue
            if row.get("exposure_eligibility") is False:
                continue
            domain = self._normalize_domain_key(row.get("domain"))
            json_path = self._normalize_scope_path(row.get("json_path"))
            if not domain or not json_path:
                continue
            entry = catalog.setdefault(domain, {"paths": set(), "wildcards": set()})
            entry["paths"].add(json_path)
            if row.get("path_type") in {"object", "array"}:
                entry["wildcards"].add(json_path)

        if catalog:
            return catalog

        return await self._get_legacy_scope_catalog(user_id)

    async def get_available_scope_entries(self, user_id: str) -> list[dict]:
        """
        Get manifest-backed scope discovery entries with provenance metadata.

        Each entry describes one requestable scope string and why it exists.
        """
        try:
            index_result = (
                self.supabase.table("pkm_index")
                .select("available_domains")
                .eq("user_id", user_id)
                .limit(1)
                .execute()
            )
            manifest_result = (
                self.supabase.table("pkm_manifests")
                .select("domain,top_level_scope_paths,externalizable_paths,manifest_version")
                .eq("user_id", user_id)
                .execute()
            )
            path_result = (
                self.supabase.table("pkm_manifest_paths")
                .select(
                    "domain,json_path,path_type,exposure_eligibility,consent_label,scope_handle"
                )
                .eq("user_id", user_id)
                .execute()
            )
            registry_result = (
                self.supabase.table("pkm_scope_registry")
                .select(
                    "domain,scope_handle,scope_label,exposure_enabled,summary_projection,manifest_version"
                )
                .eq("user_id", user_id)
                .execute()
            )
        except Exception as e:
            logger.error("Error getting scope entries for %s: %s", user_id, e)
            return []

        def _source_rank(kind: str) -> int:
            return {
                "pkm_index": 1,
                "pkm_manifests.top_level_scope_paths": 2,
                "pkm_scope_registry": 3,
                "pkm_manifests.externalizable_paths": 4,
                "pkm_manifest_paths": 5,
                "legacy_metadata_fallback": 0,
            }.get(kind, 0)

        entries: dict[str, dict[str, object]] = {}

        def _upsert_scope_entry(entry: dict[str, object]) -> None:
            scope = str(entry.get("scope") or "").strip()
            if not scope:
                return
            current = entries.get(scope)
            if current is None:
                entries[scope] = entry
                return
            if _source_rank(str(entry.get("source_kind") or "")) >= _source_rank(
                str(current.get("source_kind") or "")
            ):
                merged = {**current, **entry}
            else:
                merged = {**entry, **current}
            for key in (
                "registry_handle",
                "label",
                "meta_reference",
                "path",
                "domain",
                "manifest_revision",
            ):
                if not merged.get(key):
                    merged[key] = current.get(key) or entry.get(key)
            merged["wildcard"] = bool(current.get("wildcard") or entry.get("wildcard"))
            merged["exposure_eligibility"] = bool(
                current.get("exposure_eligibility") or entry.get("exposure_eligibility")
            )
            entries[scope] = merged

        index_domains = self._normalize_domains(
            (index_result.data or [{}])[0].get("available_domains") if index_result.data else []
        )
        manifest_rows = manifest_result.data or []
        path_rows = path_result.data or []
        registry_rows = registry_result.data or []

        registry_by_top_level: dict[tuple[str, str], dict[str, object]] = {}
        known_domains = set(index_domains)
        for row in manifest_rows:
            if not isinstance(row, dict):
                continue
            domain = self._normalize_domain_key(row.get("domain"))
            if domain:
                known_domains.add(domain)
        for row in path_rows:
            if not isinstance(row, dict):
                continue
            domain = self._normalize_domain_key(row.get("domain"))
            if domain:
                known_domains.add(domain)
        for row in registry_rows:
            if not isinstance(row, dict):
                continue
            domain = self._normalize_domain_key(row.get("domain"))
            if domain:
                known_domains.add(domain)
            summary_projection = self._coerce_json_dict(row.get("summary_projection"))
            top_level_path = self._normalize_scope_path(
                summary_projection.get("top_level_scope_path")
            )
            if domain and top_level_path:
                registry_by_top_level[(domain, top_level_path)] = {
                    "registry_handle": str(row.get("scope_handle") or "").strip() or None,
                    "label": str(row.get("scope_label") or "").strip() or None,
                    "manifest_revision": row.get("manifest_version"),
                    "source_kind": "pkm_scope_registry",
                }

        for domain in sorted(known_domains):
            _upsert_scope_entry(
                {
                    "scope": self.generate_domain_wildcard(domain),
                    "domain": domain,
                    "path": None,
                    "wildcard": True,
                    "source_kind": "pkm_index",
                    "registry_handle": None,
                    "label": f"{domain.replace('_', ' ').title()} Domain",
                    "exposure_eligibility": True,
                    "manifest_revision": None,
                    "meta_reference": "domain wildcard derived from discovered PKM domains",
                }
            )

        manifest_externalizable_paths: set[tuple[str, str]] = set()
        for row in manifest_rows:
            if not isinstance(row, dict):
                continue
            domain = self._normalize_domain_key(row.get("domain"))
            if not domain:
                continue
            manifest_version = row.get("manifest_version")
            top_level_paths = [
                self._normalize_scope_path(path)
                for path in (row.get("top_level_scope_paths") or [])
            ]
            for path in [path for path in top_level_paths if path]:
                registry_meta = registry_by_top_level.get((domain, path), {})
                _upsert_scope_entry(
                    {
                        "scope": f"{self.SCOPE_PREFIX}{domain}.{path}{self.WILDCARD_SUFFIX}",
                        "domain": domain,
                        "path": path,
                        "wildcard": True,
                        "source_kind": "pkm_manifests.top_level_scope_paths",
                        "registry_handle": registry_meta.get("registry_handle"),
                        "label": registry_meta.get("label") or path.replace("_", " ").title(),
                        "exposure_eligibility": True,
                        "manifest_revision": registry_meta.get("manifest_revision")
                        or manifest_version,
                        "meta_reference": "manifest top-level scope path",
                    }
                )
            for raw_path in row.get("externalizable_paths") or []:
                path = self._normalize_scope_path(raw_path)
                if not path:
                    continue
                manifest_externalizable_paths.add((domain, path))
                top_level = path.split(".", 1)[0]
                registry_meta = registry_by_top_level.get((domain, top_level), {})
                _upsert_scope_entry(
                    {
                        "scope": self.generate_scope(domain, path),
                        "domain": domain,
                        "path": path,
                        "wildcard": False,
                        "source_kind": "pkm_manifests.externalizable_paths",
                        "registry_handle": registry_meta.get("registry_handle"),
                        "label": path.replace("_", " ").replace(".", " ").title(),
                        "exposure_eligibility": True,
                        "manifest_revision": registry_meta.get("manifest_revision")
                        or manifest_version,
                        "meta_reference": "externalizable manifest path",
                    }
                )

        for row in path_rows:
            if not isinstance(row, dict):
                continue
            if row.get("exposure_eligibility") is False:
                continue
            domain = self._normalize_domain_key(row.get("domain"))
            path = self._normalize_scope_path(row.get("json_path"))
            if not domain or not path:
                continue
            top_level = path.split(".", 1)[0]
            registry_meta = registry_by_top_level.get((domain, top_level), {})
            _upsert_scope_entry(
                {
                    "scope": self.generate_scope(domain, path),
                    "domain": domain,
                    "path": path,
                    "wildcard": False,
                    "source_kind": "pkm_manifest_paths",
                    "registry_handle": str(row.get("scope_handle") or "").strip()
                    or registry_meta.get("registry_handle"),
                    "label": str(row.get("consent_label") or "").strip()
                    or registry_meta.get("label")
                    or path.replace("_", " ").replace(".", " ").title(),
                    "exposure_eligibility": True,
                    "manifest_revision": registry_meta.get("manifest_revision"),
                    "meta_reference": "manifest path row marked exposure eligible",
                }
            )

        if entries:
            return [entries[scope] for scope in sorted(entries)]

        legacy_catalog = await self._get_legacy_scope_catalog(user_id)
        for domain, entry in legacy_catalog.items():
            _upsert_scope_entry(
                {
                    "scope": self.generate_domain_wildcard(domain),
                    "domain": domain,
                    "path": None,
                    "wildcard": True,
                    "source_kind": "legacy_metadata_fallback",
                    "registry_handle": None,
                    "label": f"{domain.replace('_', ' ').title()} Domain",
                    "exposure_eligibility": True,
                    "manifest_revision": None,
                    "meta_reference": "legacy metadata fallback domain wildcard",
                }
            )
            for path in sorted(entry.get("wildcards", set())):
                _upsert_scope_entry(
                    {
                        "scope": f"{self.SCOPE_PREFIX}{domain}.{path}{self.WILDCARD_SUFFIX}",
                        "domain": domain,
                        "path": path,
                        "wildcard": True,
                        "source_kind": "legacy_metadata_fallback",
                        "registry_handle": None,
                        "label": path.replace("_", " ").replace(".", " ").title(),
                        "exposure_eligibility": True,
                        "manifest_revision": None,
                        "meta_reference": "legacy metadata fallback wildcard path",
                    }
                )
            for path in sorted(entry.get("paths", set())):
                _upsert_scope_entry(
                    {
                        "scope": self.generate_scope(domain, path),
                        "domain": domain,
                        "path": path,
                        "wildcard": False,
                        "source_kind": "legacy_metadata_fallback",
                        "registry_handle": None,
                        "label": path.replace("_", " ").replace(".", " ").title(),
                        "exposure_eligibility": True,
                        "manifest_revision": None,
                        "meta_reference": "legacy metadata fallback exact path",
                    }
                )
        return [entries[scope] for scope in sorted(entries)]

    def matches_wildcard(self, scope: str, wildcard: str) -> bool:
        """
        Check if a specific scope matches a wildcard pattern.

        Args:
            scope: The specific scope (e.g., 'attr.financial.holdings')
            wildcard: The wildcard pattern (e.g., 'attr.financial.*')

        Returns:
            True if the scope matches the wildcard
        """
        granted_domain, granted_path, granted_wildcard = self.parse_scope(wildcard)
        requested_domain, requested_path, _requested_wildcard = self.parse_scope(scope)

        if granted_domain is None or requested_domain is None:
            return scope == wildcard
        if granted_domain != requested_domain:
            return False

        if not granted_wildcard:
            return scope == wildcard

        # attr.{domain}.* grants everything under that domain.
        if granted_path is None:
            return True

        # attr.{domain}.{subintent}.* grants everything under that subintent path.
        if requested_path is None:
            return False
        return requested_path == granted_path or requested_path.startswith(f"{granted_path}.")

    async def validate_scope(self, scope: str, user_id: Optional[str] = None) -> bool:
        """
        Validate that a scope is valid.

        Validates against PKM manifests, manifest paths, and index-backed discovery.

        Args:
            scope: The scope to validate
            user_id: Optional user ID to check against stored data

        Returns:
            True if the scope is valid
        """
        domain, _attribute_key, _is_wildcard = self.parse_scope(scope)

        if domain is None:
            return False
        domain = self._normalize_domain_key(domain)
        if not domain:
            return False

        # If no user_id, just validate format
        if user_id is None:
            return True

        try:
            scope_catalog = await self._get_user_scope_catalog(user_id)
            if not scope_catalog:
                logger.debug(f"No PKM index for user {user_id}")
                return False

            domain_catalog = scope_catalog.get(domain)
            if domain_catalog is None:
                return False
            domain_paths = domain_catalog.get("paths", set())
            domain_wildcards = domain_catalog.get("wildcards", set())

            # Domain-level scope is valid when domain exists.
            if _attribute_key is None:
                return True

            candidate_path = self._normalize_scope_path(_attribute_key)
            if not candidate_path:
                return False

            if _is_wildcard:
                if candidate_path in domain_wildcards:
                    return True
                return any(
                    path == candidate_path or path.startswith(f"{candidate_path}.")
                    for path in domain_paths
                )

            return candidate_path in domain_paths or candidate_path in domain_wildcards
        except Exception as e:
            logger.error(f"Error validating scope {scope}: {e}")
            return False

    async def get_available_scopes(self, user_id: str) -> list[str]:
        """
        Get all valid consent scopes for a user from manifest-backed discovery.

        Args:
            user_id: The user ID

        Returns:
            List of exact and wildcard scope strings
        """
        try:
            scopes: set[str] = {"pkm.read"}
            for entry in await self.get_available_scope_entries(user_id):
                scope = str(entry.get("scope") or "").strip()
                if scope:
                    scopes.add(scope)
            return sorted(scopes)
        except Exception as e:
            logger.error(f"Error getting available scopes for {user_id}: {e}")
            return []

    async def get_available_wildcards(self, user_id: str) -> list[str]:
        """
        Get all valid wildcard scopes for a user from PKM index metadata.

        Args:
            user_id: The user ID

        Returns:
            List of wildcard scope strings
        """
        scopes = await self.get_available_scopes(user_id)
        return sorted(
            scope for scope in scopes if scope == "pkm.read" or scope.endswith(self.WILDCARD_SUFFIX)
        )

    async def check_scope_access(
        self,
        requested_scope: str,
        granted_scopes: list[str],
        user_id: Optional[str] = None,
    ) -> bool:
        """
        Check if a requested scope is covered by granted scopes.

        Args:
            requested_scope: The scope being requested
            granted_scopes: List of scopes that have been granted
            user_id: Optional user ID for validation

        Returns:
            True if access should be granted
        """
        # Direct match
        if requested_scope in granted_scopes:
            return True

        # Check wildcard matches
        for granted in granted_scopes:
            if self.matches_wildcard(requested_scope, granted):
                return True

        # Check if vault.owner is granted (full access)
        if "vault.owner" in granted_scopes:
            return True

        return False

    async def expand_wildcard(self, wildcard: str, user_id: str) -> list[str]:
        """
        Expand a wildcard scope into specific scopes for a user.

        Args:
            wildcard: The wildcard scope (e.g., 'attr.financial.*')
            user_id: The user ID (unused; kept for API stability)

        Returns:
            List of matching exact scopes
        """
        domain, _, is_wildcard = self.parse_scope(wildcard)
        if not is_wildcard or domain is None:
            return [wildcard]
        scope_catalog = await self._get_user_scope_catalog(user_id)
        domain_catalog = scope_catalog.get(domain)
        if not domain_catalog:
            return [wildcard]
        _, wildcard_path, _ = self.parse_scope(wildcard)
        matched = []
        for path in sorted(domain_catalog.get("paths", set())):
            if (
                wildcard_path is None
                or path == wildcard_path
                or path.startswith(f"{wildcard_path}.")
            ):
                matched.append(self.generate_scope(domain, path))
        return matched or [wildcard]

    def get_scope_display_info(self, scope: str) -> dict:
        """
        Get display information for a scope.

        Args:
            scope: The scope string

        Returns:
            Dict with display_name, domain, attribute, is_wildcard
        """
        domain, attribute_key, is_wildcard = self.parse_scope(scope)

        if domain is None:
            return {
                "display_name": scope,
                "domain": None,
                "attribute": None,
                "is_wildcard": False,
            }

        if is_wildcard:
            display_name = f"All {domain.title()} Data"
        elif attribute_key:
            display_name = f"{domain.title()} - {attribute_key.replace('_', ' ').title()}"
        else:
            display_name = f"{domain.title()} Domain"

        return {
            "display_name": display_name,
            "domain": domain,
            "attribute": attribute_key,
            "is_wildcard": is_wildcard,
        }


# Singleton instance
_scope_generator: Optional[DynamicScopeGenerator] = None


def get_scope_generator() -> DynamicScopeGenerator:
    """Get singleton DynamicScopeGenerator instance."""
    global _scope_generator
    if _scope_generator is None:
        _scope_generator = DynamicScopeGenerator()
    return _scope_generator

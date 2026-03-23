# consent-protocol/hushh_mcp/services/domain_registry_service.py
"""
Domain Registry Service - Dynamic domain discovery and management.

This service manages the domain_registry table which tracks all domains
dynamically without hardcoded enums. Domains are auto-registered on first use.
"""

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from db.db_client import get_db
from hushh_mcp.services.domain_contracts import (
    CANONICAL_DOMAIN_REGISTRY,
    FINANCIAL_SUBINTENT_REGISTRY,
    RETIRED_DOMAIN_REGISTRY_KEYS,
    canonical_domain_metadata_map,
)

logger = logging.getLogger(__name__)


@dataclass
class DomainInfo:
    """Information about a registered domain."""

    domain_key: str
    display_name: str
    description: Optional[str] = None
    icon_name: str = "folder"
    color_hex: str = "#6B7280"
    parent_domain: Optional[str] = None
    attribute_count: int = 0
    user_count: int = 0
    first_seen_at: Optional[datetime] = None
    last_updated_at: Optional[datetime] = None


# Default domain metadata for canonical top-level domains.
DEFAULT_DOMAIN_METADATA = canonical_domain_metadata_map()


class DomainRegistryService:
    """
    Service for managing dynamic domain discovery and registration.

    Domains are auto-registered on first use, with metadata inferred
    from the domain key or provided explicitly.
    """

    def __init__(self):
        self._supabase = None
        self._cache: dict[str, DomainInfo] = {}
        self._cache_ttl = 300  # 5 minutes
        self._cache_time: Optional[datetime] = None
        self._canonical_seeded = False

    @property
    def supabase(self):
        if self._supabase is None:
            self._supabase = get_db()
        return self._supabase

    def _is_cache_valid(self) -> bool:
        """Check if cache is still valid."""
        if self._cache_time is None:
            return False
        elapsed = (datetime.utcnow() - self._cache_time).total_seconds()
        return elapsed < self._cache_ttl

    def _invalidate_cache(self):
        """Invalidate the domain cache."""
        self._cache.clear()
        self._cache_time = None

    @staticmethod
    def _normalize_domain_key(value: str | None) -> str:
        return str(value or "").strip().lower()

    @classmethod
    def _infer_parent_domain(cls, domain_key: str) -> Optional[str]:
        normalized = cls._normalize_domain_key(domain_key)
        if "." not in normalized:
            return None
        parent_domain = normalized.split(".", 1)[0].strip()
        return parent_domain or None

    async def _repair_parent_domain_links(self) -> None:
        """Ensure dotted domains consistently link to their top-level parent."""
        try:
            rows = (
                self.supabase.table("domain_registry")
                .select("domain_key,parent_domain")
                .execute()
                .data
                or []
            )
        except Exception as read_error:
            logger.warning("Failed to read domain_registry for parent repair: %s", read_error)
            return

        for row in rows:
            domain_key = self._normalize_domain_key(row.get("domain_key"))
            if not domain_key:
                continue
            expected_parent = self._infer_parent_domain(domain_key)
            current_parent = self._normalize_domain_key(row.get("parent_domain")) or None
            if not expected_parent:
                continue
            if current_parent == expected_parent:
                continue
            try:
                self.supabase.table("domain_registry").update(
                    {"parent_domain": expected_parent}
                ).eq("domain_key", domain_key).execute()
            except Exception as update_error:
                logger.warning(
                    "Failed to update parent_domain for %s -> %s: %s",
                    domain_key,
                    expected_parent,
                    update_error,
                )

    async def _collect_index_referenced_domains(self) -> set[str]:
        """Collect domain keys currently referenced by any user index."""
        referenced: set[str] = set()
        try:
            rows = (
                self.supabase.table("pkm_index")
                .select("available_domains,domain_summaries")
                .execute()
                .data
                or []
            )
        except Exception as read_error:
            logger.warning("Failed to scan pkm_index for domain references: %s", read_error)
            return referenced

        for row in rows:
            for domain_key in row.get("available_domains") or []:
                normalized = self._normalize_domain_key(domain_key)
                if normalized:
                    referenced.add(normalized)
            summaries = row.get("domain_summaries")
            if not isinstance(summaries, dict):
                continue
            for key in summaries.keys():
                normalized = self._normalize_domain_key(str(key))
                if normalized:
                    referenced.add(normalized)
        return referenced

    async def _prune_retired_registry_keys(self) -> None:
        """Delete retired registry rows when they are no longer referenced."""
        referenced = await self._collect_index_referenced_domains()
        for retired_key in RETIRED_DOMAIN_REGISTRY_KEYS:
            normalized_retired = self._normalize_domain_key(retired_key)
            if normalized_retired in referenced:
                logger.warning(
                    "Skipping retired registry key cleanup for %s (still referenced in index).",
                    normalized_retired,
                )
                continue
            try:
                self.supabase.table("domain_registry").delete().eq(
                    "domain_key", normalized_retired
                ).execute()
            except Exception as delete_error:
                logger.warning(
                    "Failed to prune retired registry key %s: %s",
                    normalized_retired,
                    delete_error,
                )

    async def ensure_canonical_domains(self) -> None:
        """Best-effort seed of canonical top-level domains into domain_registry."""
        if self._canonical_seeded:
            return
        for entry in CANONICAL_DOMAIN_REGISTRY:
            try:
                await self.register_domain(
                    domain_key=entry.domain_key,
                    display_name=entry.display_name,
                    description=entry.description,
                    icon_name=entry.icon_name,
                    color_hex=entry.color_hex,
                )
            except Exception as seed_error:
                logger.warning(
                    "Failed to seed canonical domain '%s': %s",
                    entry.domain_key,
                    seed_error,
                )
        for subintent in FINANCIAL_SUBINTENT_REGISTRY:
            try:
                await self.register_domain(
                    domain_key=subintent.domain_key,
                    display_name=subintent.display_name,
                    description=subintent.description,
                    icon_name=subintent.icon_name,
                    color_hex=subintent.color_hex,
                    parent_domain=subintent.parent_domain,
                )
            except Exception as seed_error:
                logger.warning(
                    "Failed to seed domain subintent '%s': %s",
                    subintent.domain_key,
                    seed_error,
                )
        await self._repair_parent_domain_links()
        await self._prune_retired_registry_keys()
        self._canonical_seeded = True
        self._invalidate_cache()

    @staticmethod
    def _summary_count(summary: dict | None) -> int:
        if not isinstance(summary, dict):
            return 0
        candidates = (
            summary.get("attribute_count"),
            summary.get("holdings_count"),
            summary.get("item_count"),
        )
        for value in candidates:
            if isinstance(value, bool) or value is None:
                continue
            if isinstance(value, int):
                return max(0, value)
            if isinstance(value, float):
                if value != value:
                    continue
                return max(0, int(value))
            if isinstance(value, str):
                text = value.strip()
                if not text:
                    continue
                try:
                    return max(0, int(float(text)))
                except Exception:
                    continue
        return 0

    async def register_domain(
        self,
        domain_key: str,
        display_name: Optional[str] = None,
        description: Optional[str] = None,
        icon_name: Optional[str] = None,
        color_hex: Optional[str] = None,
        parent_domain: Optional[str] = None,
    ) -> DomainInfo:
        """
        Register a new domain or return existing one.

        If the domain already exists, returns the existing info.
        If not, creates it with provided or inferred metadata.
        """
        # Normalize domain key
        domain_key = domain_key.lower().strip().replace(" ", "_")
        final_parent_domain = self._normalize_domain_key(
            parent_domain
        ) or self._infer_parent_domain(domain_key)

        if final_parent_domain and final_parent_domain != domain_key:
            # Ensure parent exists before inserting the subintent row.
            await self.register_domain(domain_key=final_parent_domain)

        # Check cache first
        if domain_key in self._cache and self._is_cache_valid():
            return self._cache[domain_key]

        # Get default metadata if available
        defaults = DEFAULT_DOMAIN_METADATA.get(domain_key, {})

        # Build metadata with fallbacks
        final_display_name = (
            display_name or defaults.get("display_name") or self._generate_display_name(domain_key)
        )
        final_icon = icon_name or defaults.get("icon_name", "folder")
        final_color = color_hex or defaults.get("color_hex", "#6B7280")
        final_description = description or defaults.get("description")

        try:
            # Use RPC function for atomic upsert when supported by the client.
            rpc_call = self.supabase.rpc(
                "auto_register_domain",
                {
                    "p_domain_key": domain_key,
                    "p_display_name": final_display_name,
                    "p_icon_name": final_icon,
                    "p_color_hex": final_color,
                },
            )
            rpc_payload: dict | None = None
            if hasattr(rpc_call, "execute"):
                result = rpc_call.execute()
                raw_payload = result.data
                if isinstance(raw_payload, dict):
                    rpc_payload = raw_payload
                elif isinstance(raw_payload, list) and raw_payload:
                    first_row = raw_payload[0]
                    if isinstance(first_row, dict):
                        nested = first_row.get("auto_register_domain")
                        if isinstance(nested, dict):
                            rpc_payload = nested
                        else:
                            rpc_payload = first_row

            if rpc_payload:
                if final_parent_domain is not None or final_description is not None:
                    try:
                        patch_data: dict[str, object] = {}
                        if final_parent_domain is not None:
                            patch_data["parent_domain"] = final_parent_domain
                        if final_description is not None:
                            patch_data["description"] = final_description
                        if patch_data:
                            self.supabase.table("domain_registry").update(patch_data).eq(
                                "domain_key", domain_key
                            ).execute()
                    except Exception as patch_error:
                        logger.warning(
                            "Failed to patch domain metadata for %s after RPC upsert: %s",
                            domain_key,
                            patch_error,
                        )
                domain_info = DomainInfo(
                    domain_key=rpc_payload.get("domain_key", domain_key),
                    display_name=rpc_payload.get("display_name", final_display_name),
                    icon_name=rpc_payload.get("icon_name", final_icon),
                    color_hex=rpc_payload.get("color_hex", final_color),
                    description=final_description
                    if final_description is not None
                    else rpc_payload.get("description"),
                    parent_domain=final_parent_domain,
                    attribute_count=rpc_payload.get("attribute_count", 0),
                    user_count=rpc_payload.get("user_count", 0),
                )
                self._cache[domain_key] = domain_info
                self._cache_time = datetime.utcnow()
                return domain_info
        except Exception as e:
            logger.warning(f"RPC auto_register_domain failed, falling back to direct insert: {e}")

        # Fallback: Direct upsert
        try:
            data = {
                "domain_key": domain_key,
                "display_name": final_display_name,
                "icon_name": final_icon,
                "color_hex": final_color,
                "description": final_description,
                "parent_domain": final_parent_domain,
            }

            self.supabase.table("domain_registry").upsert(data, on_conflict="domain_key").execute()

            # Fetch the result
            result = (
                self.supabase.table("domain_registry")
                .select("*")
                .eq("domain_key", domain_key)
                .execute()
            )

            if result.data:
                row = result.data[0]
                domain_info = self._row_to_domain_info(row)
                self._cache[domain_key] = domain_info
                self._cache_time = datetime.utcnow()
                return domain_info
        except Exception as e:
            logger.error(f"Error registering domain {domain_key}: {e}")

        # Return minimal info if all else fails
        return DomainInfo(
            domain_key=domain_key,
            display_name=final_display_name,
            icon_name=final_icon,
            color_hex=final_color,
        )

    async def get_domain(self, domain_key: str) -> Optional[DomainInfo]:
        """Get domain metadata by key."""
        domain_key = domain_key.lower().strip()

        # Check cache
        if domain_key in self._cache and self._is_cache_valid():
            return self._cache[domain_key]

        try:
            result = (
                self.supabase.table("domain_registry")
                .select("*")
                .eq("domain_key", domain_key)
                .execute()
            )

            if not result.data:
                return None

            domain_info = self._row_to_domain_info(result.data[0])
            self._cache[domain_key] = domain_info
            return domain_info
        except Exception as e:
            logger.error(f"Error getting domain {domain_key}: {e}")
            return None

    async def list_domains(self, include_empty: bool = False) -> list[DomainInfo]:
        """
        List all registered domains.

        Args:
            include_empty: If True, include domains with no attributes
        """
        try:
            query = self.supabase.table("domain_registry").select("*").order("display_name")

            if not include_empty:
                query = query.gt("attribute_count", 0)

            result = query.execute()

            domains = [self._row_to_domain_info(row) for row in (result.data or [])]

            # Update cache
            for domain in domains:
                self._cache[domain.domain_key] = domain
            self._cache_time = datetime.utcnow()

            return domains
        except Exception as e:
            logger.error(f"Error listing domains: {e}")
            return []

    async def get_user_domains(self, user_id: str) -> list[DomainInfo]:
        """Get domains that have data for a specific user from pkm_index."""
        try:
            result = (
                self.supabase.table("pkm_index")
                .select("available_domains", "domain_summaries")
                .eq("user_id", user_id)
                .limit(1)
                .execute()
            )
            if not result.data:
                return []
            row = result.data[0]
            available_domains = row.get("available_domains") or []
            domain_summaries = row.get("domain_summaries") or {}
            summary_domains = (
                list(domain_summaries.keys()) if isinstance(domain_summaries, dict) else []
            )
            normalized_domains = sorted(
                {
                    str(key).strip().lower()
                    for key in [*available_domains, *summary_domains]
                    if str(key).strip()
                }
            )
            domains = []
            for key in normalized_domains:
                domain_info = await self.get_domain(key)
                if domain_info:
                    summary = domain_summaries.get(key) or {}
                    domain_info.attribute_count = self._summary_count(summary)
                    domains.append(domain_info)
            return sorted(domains, key=lambda d: d.display_name)
        except Exception as e:
            logger.error(f"Error getting user domains for {user_id}: {e}")
            return []

    async def update_domain(
        self,
        domain_key: str,
        display_name: Optional[str] = None,
        description: Optional[str] = None,
        icon_name: Optional[str] = None,
        color_hex: Optional[str] = None,
    ) -> bool:
        """Update domain metadata."""
        try:
            data = {}
            if display_name is not None:
                data["display_name"] = display_name
            if description is not None:
                data["description"] = description
            if icon_name is not None:
                data["icon_name"] = icon_name
            if color_hex is not None:
                data["color_hex"] = color_hex

            if not data:
                return True

            self.supabase.table("domain_registry").update(data).eq(
                "domain_key", domain_key
            ).execute()

            # Invalidate cache
            self._invalidate_cache()
            return True
        except Exception as e:
            logger.error(f"Error updating domain {domain_key}: {e}")
            return False

    async def delete_domain(self, domain_key: str) -> bool:
        """
        Delete a domain from the registry.

        Note: This does NOT delete associated attributes.
        """
        try:
            self.supabase.table("domain_registry").delete().eq("domain_key", domain_key).execute()

            # Invalidate cache
            self._invalidate_cache()
            return True
        except Exception as e:
            logger.error(f"Error deleting domain {domain_key}: {e}")
            return False

    def _row_to_domain_info(self, row: dict) -> DomainInfo:
        """Convert database row to DomainInfo."""
        return DomainInfo(
            domain_key=row["domain_key"],
            display_name=row.get("display_name", row["domain_key"]),
            description=row.get("description"),
            icon_name=row.get("icon_name", "folder"),
            color_hex=row.get("color_hex", "#6B7280"),
            parent_domain=row.get("parent_domain"),
            attribute_count=row.get("attribute_count", 0),
            user_count=row.get("user_count", 0),
            first_seen_at=row.get("first_seen_at"),
            last_updated_at=row.get("last_updated_at"),
        )

    def _generate_display_name(self, domain_key: str) -> str:
        """Generate a display name from domain key."""
        # Replace underscores with spaces and title case
        return domain_key.replace("_", " ").title()


# Singleton instance
_domain_registry_service: Optional[DomainRegistryService] = None


def get_domain_registry_service() -> DomainRegistryService:
    """Get singleton DomainRegistryService instance."""
    global _domain_registry_service
    if _domain_registry_service is None:
        _domain_registry_service = DomainRegistryService()
    return _domain_registry_service
